/**
 * GloamAgent: the private money an agent holds and moves, on one Gloam network.
 *
 * Everything the GAME functions do lives here, so code that is not a GAME
 * agent (an ACP provider, a cron job) can use the same engine. Each method
 * returns plain JSON-safe facts and never a secret: notes are named by handle,
 * claim links go to the owner's own code, and every text that leaves goes
 * through redact().
 *
 * Money moves only after the owner's spending limits pass (./limits.ts), and
 * each spend is reserved in the spending log before anything is signed.
 *
 * What stays public and what does not, per action:
 *   add       a public deposit: the wallet, the asset and the amount show.
 *             The note it makes hides who can spend it later.
 *   pay       a shielded transfer: no amount, no sender, no recipient on chain.
 *             Submitted by the Gloam relay by default, so the agent's wallet
 *             does not appear either.
 *   receive   the payment is moved into a fresh note only this agent knows
 *             (a sweep) before it counts, since the payer knew the old one.
 *   cash out  the public exit: the asset, the amount and the recipient show,
 *             not which private payment funded it. The pool keeps 0.5% on
 *             mainnet and 0.25% on Base Sepolia. A note behind a proof of
 *             funds is moved to a fresh note first, so the proof does not
 *             lead to it.
 *   x402      a pay to the 402 price's receive tag, handed back as the
 *             X-PAYMENT value instead of posted to the payment board.
 *             Scheme gloam-cashout instead cashes out the quoted amount to
 *             the price's public payTo: the payee and the amount show, the
 *             agent's wallet and balance do not.
 *
 * With a partner API key, private payments, cash outs and payment messages go
 * through the partner relay and deposits are attributed, so the partner's
 * dashboard counts them.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  formatUnits,
  getAddress,
  http,
  isAddress,
  isAddressEqual,
  parseAbi,
  parseEventLogs,
  parseUnits,
  type Address,
  type Chain,
  type Hex,
  type Log,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  GLOAM_CASHOUT_ASSET,
  GLOAM_CASHOUT_CHAIN_ID,
  GLOAM_CASHOUT_SCHEME,
  GLOAM_CASHOUT_VAULT,
  GLOAM_X402_SCHEME,
  GLOAM_X402_VERSION,
  GloamApiClient,
  GloamApiError,
  GloamRelayError,
  NATIVE_ASSET,
  POOL_STATE_ABI,
  POOL_TRANSFER_ABI,
  artifactProver,
  assertDepositAllowed,
  buildPaymentRequestLink,
  buildPrivateSendIntent,
  buildShieldBoundIntent,
  buildUnshieldIntent,
  cashOutTargetProblem,
  cleanPaymentNote,
  decodePaymentHeader,
  encodeGloamCashoutHeader,
  encodeNotePackage,
  encodePaymentHeader,
  generateReceiveKey,
  gloamCashoutProblem,
  gloamPaymentBinding,
  isReceiveTag,
  networkName,
  normalizeRequestAmount,
  notePackageToExport,
  openSealedTicket,
  parsePaymentRequestLink,
  payMemoBoardFor,
  relayIntent,
  relayMemo,
  scanIncomingPayments,
  sealToReceiveTag,
  sweepReceivedNote,
  type GloamAsset,
  type GloamCashoutRequirement,
  type GloamIntent,
  type GloamPaymentPayload,
  type GloamPaymentRequirements,
  type NoteExport,
  type PrivateSendIntent,
  type Prover,
  type ReceiveKey,
  type SweepChain,
  approvalSteps,
  gloamReadTransport,
} from "@gloamtrade/sdk";
import { Artifacts, type ArtifactSource } from "./artifacts.js";
import { claimLinkFor, readClaimLink } from "./claimLinks.js";
import {
  CLAIM_LINK_RECIPIENT,
  checkSpend,
  limitsView,
  loadLimits,
  refusalFor,
  type LimitsConfig,
  type LoadedPolicy,
  type Refusal,
  type Spend,
} from "./limits.js";
import { describeNetwork, findAsset, defaultAsset, resolveNetwork, type PluginNetwork } from "./networks.js";
import {
  agentId as envAgentId,
  balances,
  noteStorePath,
  noteStoreKey,
  NoteStore,
  noteView,
  type NewNote,
  type NoteOrigin,
  type NoteStoreBackend,
  type StoredNote,
} from "./noteStore.js";
import { holdsSecret, redact, registerSecret, registerUrlSecret, safeErrorMessage } from "./redact.js";
import { isNotSent, walletCallSender, type Call, type CallSender } from "./sender.js";
import { SpendLog, counted, type SpendEntry } from "./spendLog.js";
import { decodeProof, encodeProof, proveFunds, provePayment, verifyHolderProof, type ProofReport } from "./proofs.js";
import { TreeSync, type SyncedVault } from "./treeSync.js";

type Env = Record<string, string | undefined>;

/** A claim link this agent made, handed to the owner's own code (never to the planner). */
export interface ClaimLinkOut {
  handle: string;
  link: string;
  network: string;
  asset: string;
  amount: string;
  note: string | null;
  label: string | null;
}

export interface GloamAgentOptions {
  /** Network key. Default GLOAM_NETWORK, else "base" (Base Sepolia, a testnet). */
  network?: string;
  /** RPC to read and send through. Default GLOAM_RPC_URL, GLOAM_RPC_URL_<chainId>, or the SDK's. */
  rpc?: string;
  /** Where configuration is read from. Default process.env. */
  env?: Env;
  /** The wallet that holds public funds and signs deposits. Default: GLOAM_AGENT_PRIVATE_KEY from env. */
  sender?: CallSender;
  /** Who submits private payments and cash outs: the Gloam relay (default) or the agent's own wallet. */
  submit?: "relay" | "wallet";
  /** A self-hosted relay. Default: the Gloam relay. */
  relayUrl?: string;
  /** The owner's spending limits. Default: GLOAM_LIMITS_FILE. None means nothing moves. */
  limits?: LimitsConfig;
  /** Names this agent's store, log and limits. Default GLOAM_AGENT_ID or "default". */
  agentId?: string;
  /** Folder for the spending log and the vault leaf cache. Default GLOAM_DATA_DIR or ~/.gloam. */
  dataDir?: string;
  /** Circuit files. Default: GLOAM_ARTIFACTS_DIR, then download from gloam.trade (hash-checked). */
  artifacts?: ArtifactSource;
  /** Where claim links go when the agent pays by claim link. Without it they stay in the encrypted store. */
  onClaimLink?: (out: ClaimLinkOut) => void | Promise<void>;
  /**
   * Where the encrypted note store is kept. Default: a local file (GLOAM_NOTE_STORE,
   * or ~/.gloam/game-notes.<agent>.json). The backend only ever holds ciphertext.
   */
  noteBackend?: NoteStoreBackend;
  /**
   * A Gloam partner API key (gloam_live_... or gloam_test_...). Default GLOAM_API_KEY.
   * Private payments, cash outs and payment messages then go through the partner
   * relay, and deposits are attributed, so gloam.trade/partners/dashboard counts them.
   */
  apiKey?: string;
  /** A client to read the chain with (tests). Default: one over `rpc`. */
  publicClient?: PublicClient;
  /** First getLogs range to try when reading the vault. */
  logChunk?: bigint;
}

export type Outcome = Record<string, unknown> & { status: string };

const RELAY_MAYBE_SENT = ["maybe_sent", "rpc", "network", "error", "internal", "in_flight"];

const SHIELD_ABI = [
  {
    type: "function",
    name: "shieldBound",
    stateMutability: "payable",
    inputs: [
      { name: "asset", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "commitment", type: "bytes32" },
      { name: "proof", type: "bytes" },
    ],
    outputs: [],
  },
] as const;

const UNSHIELD_ABI = [
  {
    type: "function",
    name: "unshield",
    stateMutability: "nonpayable",
    inputs: [
      { name: "proof", type: "bytes" },
      { name: "root", type: "bytes32" },
      { name: "nullifier", type: "bytes32" },
      { name: "asset", type: "address" },
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

const MEMO_ABI = [
  {
    type: "function",
    name: "postMemo",
    stateMutability: "nonpayable",
    inputs: [
      { name: "paymentCommitment", type: "bytes32" },
      { name: "memo", type: "bytes" },
    ],
    outputs: [],
  },
] as const;

const ERC20_ABI = [
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "owner", type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

/** One short, redacted line: never the RPC URL, request body or stack an RPC error carries. */
const errMsg = (e: unknown) => safeErrorMessage(e);
const HOUR_MS = 60 * 60_000;
const shortTag = (t: string) => (t.length > 30 ? `${t.slice(0, 18)}…${t.slice(-6)}` : t);

const WITHDRAW_FEE_EVENT = parseAbi(["event WithdrawFee(bytes32 indexed nullifier, address indexed asset, uint256 fee)"]);

/**
 * What the pool kept from one cash out, from its own event: it takes the fee
 * when the cash out lands, at the rate that day, so no constant can say. It
 * logs nothing when it kept nothing.
 */
export function feeKept(logs: Log[], pool: Address, nullifier: Hex): bigint {
  const hit = parseEventLogs({ abi: WITHDRAW_FEE_EVENT, logs }).find(
    (l) => isAddressEqual(l.address, pool) && l.args.nullifier.toLowerCase() === nullifier.toLowerCase()
  );
  return hit?.args.fee ?? 0n;
}

/** A resource as a label: no query or fragment, which can carry a token. */
function resourceLabel(resource: string): string {
  try {
    const u = new URL(resource);
    return `${u.origin}${u.pathname}`.slice(0, 120);
  } catch {
    return String(resource).split(/[?#]/)[0]!.slice(0, 120);
  }
}

function toHexBytes(text: string): Hex {
  return `0x${Buffer.from(text, "utf8").toString("hex")}`;
}

export class GloamAgent {
  readonly network: PluginNetwork;
  readonly publicClient: PublicClient;
  readonly agentId: string;
  readonly submitMode: "relay" | "wallet";
  readonly store: NoteStore;
  private readonly env: Env;
  private readonly sender: CallSender | null;
  private readonly relayUrl?: string;
  private readonly spendLog: SpendLog;
  private readonly tree: TreeSync;
  private readonly artifacts: Artifacts;
  private readonly limits?: LimitsConfig;
  private readonly onClaimLink?: GloamAgentOptions["onClaimLink"];
  private readonly api: GloamApiClient | null;
  private readonly provers = new Map<string, Promise<Prover>>();

  constructor(opts: GloamAgentOptions = {}) {
    const env = opts.env ?? process.env;
    this.env = env;
    this.network = resolveNetwork(opts.network || env.GLOAM_NETWORK?.trim() || "base", { rpc: opts.rpc || env.GLOAM_RPC_URL, env });
    // RPC URLs often carry an API key, and RPC errors quote the URL.
    registerUrlSecret(this.network.rpc);
    const chain: Chain = { ...this.network.chain, rpcUrls: { default: { http: [this.network.rpc] } } };
    // A network whose public RPC keeps only recent history reads old logs from its history RPC, unless a private RPC was set.
    const historyRpc = this.network.rpc === this.network.rpcUrl ? this.network.historyRpc : null;
    this.publicClient =
      opts.publicClient ?? (createPublicClient({ chain, transport: gloamReadTransport({ rpcUrl: this.network.rpc, historyRpc }) }) as PublicClient);
    this.agentId = opts.agentId ?? envAgentId(env);

    // The key comes from the agent's own environment and never leaves this process.
    const rawKey = env.GLOAM_AGENT_PRIVATE_KEY?.trim();
    registerSecret(rawKey);
    registerSecret(env.GLOAM_NOTE_KEY);
    if (opts.sender) {
      this.sender = opts.sender;
    } else if (rawKey) {
      const key = (rawKey.startsWith("0x") ? rawKey : `0x${rawKey}`) as Hex;
      if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("GLOAM_AGENT_PRIVATE_KEY is not a 32-byte hex private key.");
      const wallet = createWalletClient({ account: privateKeyToAccount(key), chain, transport: http(this.network.rpc) });
      this.sender = walletCallSender(wallet, this.publicClient);
    } else {
      this.sender = null;
    }

    const submit = opts.submit || (env.GLOAM_SUBMIT?.trim() as "relay" | "wallet" | undefined) || "relay";
    if (submit !== "relay" && submit !== "wallet") throw new Error(`GLOAM_SUBMIT must be "relay" or "wallet", got "${submit}".`);
    this.submitMode = submit;
    this.relayUrl = opts.relayUrl || env.GLOAM_RELAY_URL?.trim() || undefined;
    const apiKey = opts.apiKey?.trim() || env.GLOAM_API_KEY?.trim() || "";
    registerSecret(apiKey || undefined);
    this.api = apiKey ? new GloamApiClient({ apiKey }) : null;

    const { key, source } = noteStoreKey(env);
    this.store = new NoteStore(opts.noteBackend ?? noteStorePath(this.agentId, env), this.agentId, key, source);
    for (const n of this.store.list()) registerSecret(n.secret);
    const rk = this.store.receiveKey();
    if (rk) registerSecret(rk.privateJwk.d);

    const dataDir = opts.dataDir || env.GLOAM_DATA_DIR?.trim() || join(homedir(), ".gloam");
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.spendLog = new SpendLog(env.GLOAM_SPEND_LOG?.trim() || join(dataDir, `game-spend-log.${this.agentId.replace(/[^\w.-]+/g, "_")}.json`));
    this.tree = new TreeSync(this.publicClient, this.network, { cacheDir: join(dataDir, "vault-cache"), chunk: opts.logChunk });
    this.artifacts = new Artifacts(opts.artifacts ?? { dir: env.GLOAM_ARTIFACTS_DIR?.trim() || undefined, cacheDir: join(dataDir, "circuits") });
    this.limits = opts.limits;
    this.onClaimLink = opts.onClaimLink;
  }

  // ------------------------------------------------------------------ basics

  get walletAddress(): Address | null {
    return this.sender?.address ?? null;
  }

  private requireSender(what: string): CallSender {
    if (!this.sender) {
      throw new Error(`${what} needs a wallet. Set GLOAM_AGENT_PRIVATE_KEY in the agent's environment, or pass a sender (for example an ACP smart wallet).`);
    }
    return this.sender;
  }

  private where(): string {
    return describeNetwork(this.network);
  }

  private asset(raw: string | undefined | null): GloamAsset {
    if (!raw || !raw.trim()) return defaultAsset(this.network);
    const a = findAsset(this.network, raw);
    if (!a) throw new Error(`The ${this.where()} vault does not take "${raw}". It takes: ${this.network.assets.map((x) => x.symbol).join(", ")}.`);
    return a;
  }

  private amount(raw: string | undefined | null, asset: GloamAsset): bigint {
    // "2,5" is 2.5 in much of the world and 25 to a parser that drops commas: refuse it rather than guess.
    if (String(raw ?? "").includes(",")) throw new Error("Write the amount without commas, with a dot for decimals: 2.5 or 1250.");
    const norm = normalizeRequestAmount(String(raw ?? ""), asset);
    if (!norm) throw new Error("Say how much, as a number like 25 or 12.5.");
    return parseUnits(norm, asset.decimals);
  }

  private fmt(raw: bigint | string, asset: Pick<GloamAsset, "decimals" | "symbol">): string {
    return `${formatUnits(BigInt(raw), asset.decimals)} ${asset.symbol}`;
  }

  private explorer(hash: Hex): string {
    return `${this.network.explorerUrl.replace(/\/+$/, "")}/tx/${hash}`;
  }

  private loadPolicy(): LoadedPolicy {
    return loadLimits({
      agent: this.agentId,
      network: this.network.key,
      limits: this.limits,
      // Both set is refused by loadLimits (never one silently over the other).
      file: this.env.GLOAM_LIMITS_FILE?.trim() || undefined,
      readFile: (p) => readFileSync(p, "utf8"),
    });
  }

  /**
   * Check a spend against the owner's limits and reserve it in the log before anything is signed.
   * A retry passes the attempt it repeats (`retryOf`): it is checked like any spend, with the money
   * that attempt reserved counted once, and that attempt's entry is marked replaced.
   */
  private gate(spend: Spend, retryOf?: StoredNote): { ok: true; id: string } | { ok: false; refusal: Refusal } {
    const now = Date.now();
    const loaded = this.loadPolicy();
    const symbol = this.network.assets.find((a) => a.address.toLowerCase() === spend.asset.toLowerCase())?.symbol ?? spend.asset;
    const decimals = this.network.assets.find((a) => a.address.toLowerCase() === spend.asset.toLowerCase())?.decimals ?? 18;
    const entry = {
      id: `sp-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      agent: this.agentId,
      action: spend.action,
      network: this.network.key,
      chainId: spend.chainId,
      asset: spend.asset,
      symbol,
      amountWei: spend.amountWei.toString(),
      amount: formatUnits(spend.amountWei, decimals),
      recipient: spend.recipient && spend.recipient.length > 40 ? shortTag(spend.recipient) : spend.recipient,
      at: new Date(now).toISOString(),
    };
    try {
      if (loaded.mode !== "enforced") {
        const r = refusalFor(loaded);
        this.spendLog.note({ ...entry, status: "refused", reason: r.message }, now);
        return { ok: false, refusal: r };
      }
      let refusal: Refusal | null = null;
      const replaces = retryOf
        ? {
            id: retryOf.spendId,
            // a note kept before the id was recorded: the latest counted entry for the same spend
            like: (e: SpendEntry) =>
              e.action === entry.action && e.chainId === entry.chainId && e.asset.toLowerCase() === entry.asset.toLowerCase() && e.amountWei === entry.amountWei && e.recipient === entry.recipient,
          }
        : undefined;
      const res = this.spendLog.reserve(
        entry,
        (c) => {
          refusal = checkSpend(loaded.policy, spend, c, now);
          return refusal?.message ?? null;
        },
        now,
        replaces
      );
      if (!res.ok) return { ok: false, refusal: refusal ?? { code: "refused", message: res.reason } };
      return { ok: true, id: entry.id };
    } catch (e) {
      return { ok: false, refusal: { code: "log_unavailable", message: errMsg(e) } };
    }
  }

  private settle(id: string, status: "sent" | "unconfirmed" | "reverted" | "failed", extra: { hash?: string; reason?: string } = {}) {
    try {
      this.spendLog.settle(id, status, extra.reason ? { ...extra, reason: redact(extra.reason) } : extra);
    } catch {
      /* the money question is settled on chain; a log write failing must not hide that */
    }
  }

  private refused(r: Refusal): Outcome {
    return { status: "refused", code: r.code, message: r.message };
  }

  private prover(circuit: "shield" | "transfer" | "unshield"): Promise<Prover> {
    const key = `${circuit}:${this.network.ceremony}`;
    let p = this.provers.get(key);
    if (!p) {
      p = this.artifacts.paths(circuit, this.network.ceremony).then((a) => artifactProver(a));
      this.provers.set(key, p);
      p.catch(() => this.provers.delete(key));
    }
    return p;
  }

  /** Read the vault tree (cached, checked against the chain's root). */
  syncVault(): Promise<SyncedVault> {
    return this.tree.sync();
  }

  private sweepChain(): SweepChain {
    const pool = this.network.pool;
    const client = this.publicClient;
    return {
      // Names the chain the RPC is on, so the SDK refuses a sweep through a reader on another chain.
      chainId: () => client.getChainId(),
      isSpent: (n) => client.readContract({ address: pool, abi: POOL_STATE_ABI, functionName: "isSpent", args: [n] }),
      isCommitmentSeen: (c) => client.readContract({ address: pool, abi: POOL_STATE_ABI, functionName: "commitmentSeen", args: [c] }),
      pathForCommitment: async (c) => (await this.tree.sync()).pathForCommitment(c),
      waitForReceipt: async (hash) => ({ status: (await client.waitForTransactionReceipt({ hash })).status }),
    };
  }

  /** Send a proven private send or cash out: through the relay, or the agent's wallet. */
  private async submitIntent(intent: GloamIntent): Promise<Hex> {
    if (this.submitMode === "relay") return this.api ? (await this.api.relay(intent)).hash : relayIntent(intent, { url: this.relayUrl });
    const exec = intent.exec!;
    let data: Hex;
    if (exec.fn === "transfer") {
      data = encodeFunctionData({ abi: POOL_TRANSFER_ABI, functionName: "transfer", args: exec.args as never });
    } else if (exec.fn === "unshield") {
      data = encodeFunctionData({ abi: UNSHIELD_ABI, functionName: "unshield", args: exec.args as never });
    } else {
      throw new Error(`Cannot submit ${exec.fn}.`);
    }
    return this.requireSender("Sending from the agent's own wallet").sendCalls([{ to: exec.poolAddress, data }]);
  }

  /** Whether a send that threw may still have gone out (then every note of it is kept). */
  private mayHaveSent(err: unknown): boolean {
    if (isNotSent(err)) return false;
    if (this.submitMode !== "relay") return true;
    // A clear refusal from the relay (or the partner relay) says nothing went out; anything else may have.
    if (err instanceof GloamRelayError || err instanceof GloamApiError) return RELAY_MAYBE_SENT.includes(err.code);
    return true;
  }

  /**
   * Whether a transaction that succeeded did what it was sent to do, read at its
   * own block. A smart account's bundle transaction (ERC-4337) succeeds even when
   * the operation inside it reverts, so a successful receipt alone proves nothing:
   * the commitments it should have added must be in the vault and the nullifiers
   * it should have spent must read spent.
   */
  private async didLand(blockNumber: bigint, expect: { seen?: Hex[]; spent?: Hex[] }): Promise<boolean> {
    const pool = this.network.pool;
    const reads = [
      ...(expect.seen ?? []).map((c) => this.publicClient.readContract({ address: pool, abi: POOL_STATE_ABI, functionName: "commitmentSeen", args: [c], blockNumber })),
      ...(expect.spent ?? []).map((n) => this.publicClient.readContract({ address: pool, abi: POOL_STATE_ABI, functionName: "isSpent", args: [n], blockNumber })),
    ];
    return (await Promise.all(reads)).every(Boolean);
  }

  private keep(note: NewNote): StoredNote {
    registerSecret(note.secret);
    return this.store.add(note);
  }

  private newNote(n: NoteExport, asset: GloamAsset, origin: NoteOrigin, extra: Partial<NewNote> = {}): NewNote {
    return {
      network: this.network.key,
      chainId: this.network.chainId,
      pool: this.network.pool,
      asset: n.asset,
      symbol: asset.symbol,
      decimals: asset.decimals,
      amountWei: n.amountWei,
      secret: n.secret,
      commitment: n.commitment,
      nullifier: n.nullifier,
      status: "pending",
      pending: "create",
      origin,
      createdTx: null,
      ...extra,
    };
  }

  private spendable(asset: GloamAsset): StoredNote[] {
    return this.store
      .list()
      .filter(
        (n) =>
          n.status === "unspent" &&
          n.chainId === this.network.chainId &&
          n.pool.toLowerCase() === this.network.pool.toLowerCase() &&
          n.asset.toLowerCase() === asset.address.toLowerCase() &&
          (n.origin === "shield" || n.origin === "change" || n.origin === "received")
      )
      .sort((a, b) => (BigInt(a.amountWei) < BigInt(b.amountWei) ? -1 : BigInt(a.amountWei) > BigInt(b.amountWei) ? 1 : 0));
  }

  /** The smallest note that covers `amount`, reserved for a spend. A payment spends one note; notes are not combined. */
  private reserveNote(asset: GloamAsset, amount: bigint): StoredNote {
    const pick = this.spendable(asset).find((n) => BigInt(n.amountWei) >= amount);
    if (!pick) {
      const all = this.spendable(asset);
      const largest = all.length ? BigInt(all[all.length - 1]!.amountWei) : 0n;
      throw new Error(
        `No single private note holds ${this.fmt(amount, asset)} (the largest holds ${this.fmt(largest, asset)}). A payment spends one note; add more privately first.`
      );
    }
    // A note picked for something else is no longer kept for a cash out it was split for.
    const reserved = this.store.reserveForSpend(pick.handle);
    return reserved.requestKey ? this.store.update(reserved.handle, { requestKey: undefined }) ?? reserved : reserved;
  }

  /** Free a note whose spend certainly did not go out (and drop a cash out's tag: that cash out did not happen). */
  private release(handle: string) {
    try {
      this.store.update(handle, { status: "unspent", requestKey: undefined });
    } catch {
      /* keep going: the note is still in the store */
    }
  }

  /**
   * One private send from a reserved note: pay `amountPay` into a new note
   * (the payee's, a claim link's, or the agent's own for a split) and keep the
   * change. Notes are written before anything is sent, so a crash cannot lose them.
   *
   * `prepare` runs after the notes are kept and before anything is sent (seal
   * the payment to its payee there): if it throws, nothing is sent.
   *
   * Once the send has started, nothing is forgotten unless the chain says it
   * failed: an answer that is lost (a receipt wait that gives up, a wallet or
   * relay that throws after submitting) leaves the input pending and the new
   * notes pending, and refresh() settles them from the chain.
   */
  private async privateSend(args: {
    input: StoredNote;
    asset: GloamAsset;
    amountPay: bigint;
    payOrigin: NoteOrigin;
    label?: string;
    memo?: string;
    requestKey?: string;
    /** The spending-log entry this send is counted under, kept on the new payment note. */
    spendId?: string;
    prepare?: (payment: StoredNote, paymentNote: NoteExport, exec: PrivateSendIntent["exec"]) => Promise<Partial<StoredNote> | void>;
  }): Promise<
    | { ok: true; hash: Hex; payment: StoredNote; change: StoredNote | null; paymentNote: NoteExport; exec: PrivateSendIntent["exec"] }
    | { ok: false; maybeSent: boolean; hash: Hex | null; error: string; payment: StoredNote | null; change: StoredNote | null }
  > {
    const { input, asset } = args;
    let hash: Hex | null = null;
    let payment: StoredNote | undefined;
    let change: StoredNote | undefined;
    let sending = false;
    try {
      const vault = await this.tree.sync();
      const path = await vault.pathForCommitment(input.commitment);
      if (!path) throw new Error("That note is not in the vault yet. Wait for it to confirm.");
      const intent = await buildPrivateSendIntent({
        secretHex: input.secret,
        amountInWei: BigInt(input.amountWei),
        amountPayWei: args.amountPay,
        asset: asset.address,
        path,
        prove: await this.prover("transfer"),
        poolAddress: this.network.pool,
        chainId: this.network.chainId,
      });
      const from = { spends: input.nullifier, spendsHandle: input.handle };
      if (BigInt(intent.changeNote.amountWei) > 0n) {
        change = this.keep(this.newNote(intent.changeNote, asset, "change", { label: args.label ? `change from ${args.label}` : undefined, ...from }));
      }
      payment = this.keep(
        this.newNote(intent.paymentNote, asset, args.payOrigin, {
          label: args.label,
          memo: args.memo,
          requestKey: args.requestKey,
          ...(args.spendId ? { spendId: args.spendId } : {}),
          ...from,
        })
      );
      if (args.prepare) {
        const patch = await args.prepare(payment, intent.paymentNote, intent.exec);
        if (patch) payment = this.store.update(payment.handle, patch) ?? payment;
      }
      sending = true;
      this.store.update(input.handle, { spendStarted: new Date().toISOString() });
      hash = await this.submitIntent(intent);
      const sent = hash;
      this.store.update(input.handle, { spentTx: sent });
      if (change) this.store.update(change.handle, { createdTx: sent });
      this.store.update(payment.handle, { createdTx: sent });
      const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw Object.assign(new Error(`The transfer reverted (${hash}).`), { reverted: true });
      const outputs = [intent.paymentNote.commitment, ...(change ? [change.commitment] : [])];
      if (!(await this.didLand(receipt.blockNumber, { seen: outputs, spent: [input.nullifier] }))) {
        throw Object.assign(new Error(`The transaction ${hash} succeeded, but the transfer inside it did not happen (an operation that reverted inside a smart account).`), { reverted: true });
      }
      this.store.update(input.handle, { status: "spent", spentTx: sent });
      const changeDone = change ? this.store.update(change.handle, { status: "unspent", createdTx: sent }) ?? null : null;
      // A payment note is the payee's money once it lands; a claim note stays open until someone claims it.
      const payStatus = args.payOrigin === "payment" ? "spent" : "unspent";
      const paymentDone = this.store.update(payment.handle, { status: payStatus, createdTx: sent }) ?? payment;
      return { ok: true, hash: sent, payment: paymentDone, change: changeDone, paymentNote: intent.paymentNote, exec: intent.exec };
    } catch (e) {
      const reverted = Boolean((e as { reverted?: boolean }).reverted);
      const maybeSent = !reverted && (Boolean(hash) || (sending && this.mayHaveSent(e)));
      if (reverted) {
        const spentElsewhere = await this.publicClient
          .readContract({ address: this.network.pool, abi: POOL_STATE_ABI, functionName: "isSpent", args: [input.nullifier] })
          .catch(() => false);
        if (spentElsewhere) {
          this.store.update(input.handle, { status: "spent", spentTx: null });
        } else {
          if (change) this.store.remove(change.handle);
          if (payment) this.store.remove(payment.handle);
          this.release(input.handle);
        }
      } else if (!maybeSent) {
        if (change) this.store.remove(change.handle);
        if (payment) this.store.remove(payment.handle);
        this.release(input.handle);
      }
      // maybeSent: the input stays pending (it may be spent), the new notes stay pending (they may exist).
      const keptPayment = maybeSent && payment ? this.store.get(payment.handle) ?? payment : null;
      const keptChange = maybeSent && change ? this.store.get(change.handle) ?? change : null;
      return { ok: false, maybeSent, hash, error: errMsg(e), payment: keptPayment, change: keptChange };
    }
  }

  /** What an unconfirmed send tells the caller: it may have landed, and how to find out. */
  private unconfirmed(what: string, sent: { hash: Hex | null; error: string; payment?: StoredNote | null; change?: StoredNote | null }, extra: Record<string, unknown> = {}): Outcome {
    return {
      status: "unconfirmed",
      message: `${what} was sent, but its answer was lost (${sent.error}). It may still land.`,
      ...(sent.hash ? { hash: sent.hash, explorer: this.explorer(sent.hash) } : {}),
      ...(sent.payment ? { payment: sent.payment.handle } : {}),
      ...(sent.change ? { change: noteView(sent.change) } : {}),
      check: "Refresh the balance before trying again: refresh() reads the chain and settles every note of this send. It counts against today's limit until then.",
      next: "Do not send it again. Call gloam_private_balance with refresh \"true\" (refresh() in code): a send that landed is settled there, and the same one asked again is refused or made from the same note, so it can never be paid twice.",
      ...extra,
    };
  }

  /** Post the sealed payment where the payee's scan finds it (relay or wallet). */
  private async postMemo(commitment: Hex, sealed: string): Promise<{ posted: boolean; hash?: Hex; reason?: string }> {
    const board = payMemoBoardFor(this.network.chainId);
    if (!board) return { posted: false, reason: `${this.where()} has no payment-message board yet.` };
    const memo = toHexBytes(sealed);
    try {
      const hash =
        this.submitMode === "relay"
          ? this.api
            ? (await this.api.relayMemo({ chainId: this.network.chainId, paymentCommitment: commitment, memo })).hash
            : await relayMemo({ chainId: this.network.chainId, paymentCommitment: commitment, memo }, { url: this.relayUrl })
          : await this.requireSender("Posting the payment message").sendCalls([
              { to: board.address, data: encodeFunctionData({ abi: MEMO_ABI, functionName: "postMemo", args: [commitment, memo] }) },
            ]);
      return { posted: true, hash };
    } catch (e) {
      return { posted: false, reason: errMsg(e) };
    }
  }

  // ------------------------------------------------------------------ read

  /** The agent's Gloam address (a receive tag). Made once and kept in the encrypted store. */
  async address(): Promise<string> {
    const have = this.store.receiveKey();
    if (have) return have.tag;
    const key: ReceiveKey = await generateReceiveKey();
    registerSecret(key.privateJwk.d);
    // Nothing sealed to a brand-new address can exist before now: scans start here.
    const head = await this.publicClient.getBlockNumber({ cacheTime: 0 }).catch(() => this.network.deployBlock);
    const from = head > 32n ? head - 32n : 0n;
    return this.store.keepReceiveKey(key, this.network.chainId, from).tag;
  }

  /**
   * Check pending notes against the chain, and settle what an unconfirmed send
   * left behind: a note the chain has is made spendable (or, for a payment, the
   * payee's, with its sealed message posted now), a note whose transaction
   * reverted is forgotten, and a spend input is freed only when its send
   * certainly did not land.
   */
  async refresh(): Promise<{ updated: number }> {
    let updated = 0;
    const pool = this.network.pool;
    // A transaction's final word on a note: "reverted" also when it succeeded without doing its part
    // (an operation that reverted inside a smart account), read at its own block.
    const outcome = async (hash: Hex | null | undefined, expect: { seen?: Hex[]; spent?: Hex[] }) => {
      if (!hash) return null;
      const r = await this.publicClient.getTransactionReceipt({ hash }).catch(() => null);
      if (!r) return null;
      if (r.status !== "success") return "reverted" as const;
      const done = await this.didLand(r.blockNumber, expect).catch(() => null);
      return done === null ? null : done ? ("success" as const) : ("reverted" as const);
    };
    // Whether a spend that would create a note can still land is read at one block, so two RPC
    // nodes at different heights can never make a note that landed look dead.
    const head = await this.publicClient.getBlockNumber({ cacheTime: 0 }).catch(() => null);
    const deadAt = async (n: StoredNote): Promise<boolean> => {
      if (!n.spends || head === null) return false;
      try {
        const [inputSpent, seen] = await Promise.all([
          this.publicClient.readContract({ address: pool, abi: POOL_STATE_ABI, functionName: "isSpent", args: [n.spends], blockNumber: head }),
          this.publicClient.readContract({ address: n.pool, abi: POOL_STATE_ABI, functionName: "commitmentSeen", args: [n.commitment], blockNumber: head }),
        ]);
        return inputSpent && !seen;
      } catch {
        return false;
      }
    };
    for (const n of this.store.list()) {
      if (n.chainId !== this.network.chainId || n.status === "spent") continue;
      const [seen, spent] = await Promise.all([
        this.publicClient.readContract({ address: n.pool, abi: POOL_STATE_ABI, functionName: "commitmentSeen", args: [n.commitment] }),
        this.publicClient.readContract({ address: n.pool, abi: POOL_STATE_ABI, functionName: "isSpent", args: [n.nullifier] }),
      ]);
      if (spent) {
        this.store.update(n.handle, { status: "spent" });
        updated++;
      } else if (n.status === "pending" && n.pending === "create" && seen) {
        this.store.update(n.handle, { status: n.origin === "payment" ? "spent" : "unspent", stale: undefined });
        updated++;
      } else if (n.status === "pending" && n.pending === "create") {
        if ((await outcome(n.createdTx, { seen: [n.commitment] })) === "reverted" || (await deadAt(n))) {
          // The transaction that would make it reverted, or the note it spends went another way: it can never land.
          this.store.remove(n.handle);
          updated++;
        } else if (!n.stale && Date.now() - Date.parse(n.createdAt) > HOUR_MS) {
          // Kept (it settles if it lands after all). A retry of the same payment must spend the same note.
          this.store.update(n.handle, { stale: true });
          updated++;
        }
      } else if (n.status === "pending" && n.pending === "spend") {
        const tx = await outcome(n.spentTx, { spent: [n.nullifier] });
        const age = Date.now() - Date.parse(n.spendStarted ?? n.updatedAt);
        // Free it when its transaction reverted, when nothing was ever sent (ten minutes on), or when a send
        // has not landed in an hour. Freed, it can be spent again; a payment still waiting on it is then
        // either retried from this same note or dropped once the note goes another way, never paid twice.
        const free = tx === "reverted" || (!n.spendStarted && !n.spentTx && age > 10 * 60_000) || (Boolean(n.spendStarted || n.spentTx) && tx === null && age > HOUR_MS);
        if (free && n.requestKey && tx !== "reverted") {
          // A note held by a cash out stays held for that cash out: only the same cash out, sent again from
          // this note, may spend it, so the two can never both land.
          if (!n.stale) {
            this.store.update(n.handle, { stale: true });
            updated++;
          }
        } else if (free) {
          this.store.update(n.handle, { status: "unspent", spentTx: null, spendStarted: undefined, stale: undefined });
          updated++;
        }
      }
    }
    // Payment messages held back while their payment was unconfirmed go out once it has landed.
    for (const n of this.store.list()) {
      if (n.chainId !== this.network.chainId || n.origin !== "payment" || !n.deliver || n.status === "pending") continue;
      const posted = await this.postMemo(n.commitment, n.deliver);
      if (posted.posted) this.store.update(n.handle, { deliver: undefined });
    }
    return { updated };
  }

  /**
   * Make sure a payment (or claim link) whose answer was lost an hour ago never
   * lands: spend the note it spends back to this agent. If the payment lands
   * first, this send reverts and the payment counts as landed. Either way the
   * chain settles it, and refresh() drops whichever cannot land.
   */
  async cancelPayment(handle: string): Promise<Outcome> {
    await this.refresh().catch(() => undefined);
    const n = this.store.get(handle);
    if (!n) return { status: "done", action: "cancel", result: "dropped", message: "It can never land: the note it spends went another way." };
    if (n.origin !== "payment" && n.origin !== "claim") throw new Error(`There is no payment "${handle}".`);
    if (n.status !== "pending") return { status: "done", action: "cancel", result: "landed", payment: handle, ...(n.createdTx ? { hash: n.createdTx } : {}) };
    if (!n.stale) return { status: "refused", code: "not_stale", message: "It may still land. An hour after it was sent, it can be cancelled." };
    const input = n.spendsHandle ? this.store.get(n.spendsHandle) : undefined;
    const asset = this.network.assets.find((a) => a.address.toLowerCase() === n.asset.toLowerCase());
    if (!input || input.status !== "unspent" || !asset) {
      return { status: "refused", code: "input_held", message: "The note it spends is not free yet. Refresh later." };
    }
    const reserved = this.store.reserveForSpend(input.handle);
    const sent = await this.privateSend({ input: reserved, asset, amountPay: BigInt(reserved.amountWei), payOrigin: "change", label: `cancel ${handle}` });
    await this.refresh().catch(() => undefined);
    const after = this.store.get(handle);
    if (!after) return { status: "done", action: "cancel", result: "cancelled", ...(sent.ok ? { hash: sent.hash } : {}), message: "The note it spent went back to this agent, so it can never land." };
    if (after.status !== "pending") return { status: "done", action: "cancel", result: "landed", payment: handle, ...(after.createdTx ? { hash: after.createdTx } : {}) };
    if (!sent.ok && sent.maybeSent) return this.unconfirmed("The cancel", sent);
    return { status: "error", message: sent.ok ? "The cancel landed but the payment is still pending. Refresh again." : sent.error };
  }

  /** The newest payment or claim note with this label (what an ACP provider checks after a send it is unsure of). */
  findPayment(label: string) {
    const all = this.store.list().filter((n) => n.chainId === this.network.chainId && (n.origin === "payment" || n.origin === "claim") && n.label === label);
    const n = all.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
    return n ? noteView(n) : null;
  }

  /** Private balance per asset, what the wallet holds publicly, and the limits left today. */
  async balance(opts: { refresh?: boolean } = {}): Promise<Outcome> {
    if (opts.refresh) await this.refresh();
    const priv = balances(this.store.list(), this.network.chainId);
    const wallet: Record<string, string> = {};
    if (this.sender) {
      for (const a of this.network.assets) {
        try {
          const raw =
            a.address.toLowerCase() === NATIVE_ASSET.toLowerCase()
              ? await this.publicClient.getBalance({ address: this.sender.address })
              : await this.publicClient.readContract({ address: a.address, abi: ERC20_ABI, functionName: "balanceOf", args: [this.sender.address] });
          wallet[a.symbol] = formatUnits(raw, a.decimals);
        } catch {
          wallet[a.symbol] = "unknown";
        }
      }
    }
    return {
      status: "ok",
      network: this.network.key,
      networkName: this.where(),
      gloamAddress: await this.address(),
      privateBalance: priv,
      ...(this.sender ? { wallet: { address: this.sender.address, holds: wallet, note: "Public: anyone can see the wallet's balance." } } : {}),
      limits: this.limitsReport(),
      pendingClaimLinks: this.store
        .list()
        .filter((n) => n.origin === "claim" && n.status === "unspent" && n.chainId === this.network.chainId)
        .map((n) => noteView(n)),
    };
  }

  limitsReport() {
    let entries: ReturnType<SpendLog["read"]> = [];
    try {
      entries = this.spendLog.read();
    } catch {
      entries = [];
    }
    return limitsView(this.loadPolicy(), counted(entries, this.agentId), Date.now());
  }

  /** The agent's notes as handles and public facts. */
  notes() {
    return this.store.list().filter((n) => n.chainId === this.network.chainId).map(noteView);
  }

  /** The most one payment can be right now, in base units: a payment spends one note. */
  largestPayment(asset?: string): bigint {
    const all = this.spendable(this.asset(asset));
    return all.length ? BigInt(all[all.length - 1]!.amountWei) : 0n;
  }

  /** Open a code sealed to this agent's Gloam address (owner code: a sealed request or deliverable). */
  async openSealed(sealed: string): Promise<string> {
    const key = this.store.receiveKey();
    if (!key) throw new Error("This agent has no Gloam address yet, so nothing can be sealed to it.");
    return openSealedTicket(sealed, key);
  }

  // ------------------------------------------------------------------ add privately

  /** Deposit public funds from the wallet into the agent's private balance. */
  async add(args: { amount: string; asset?: string; label?: string }): Promise<Outcome> {
    const asset = this.asset(args.asset);
    const amountWei = this.amount(args.amount, asset);
    const sender = this.requireSender("Adding money privately");
    assertDepositAllowed(this.network.chainId, asset.address, amountWei);
    const isNative = asset.address.toLowerCase() === NATIVE_ASSET.toLowerCase();
    if (isNative && !this.network.nativeShield) throw new Error(`The ${this.where()} vault takes no native deposits.`);
    const have = isNative
      ? await this.publicClient.getBalance({ address: sender.address })
      : await this.publicClient.readContract({ address: asset.address, abi: ERC20_ABI, functionName: "balanceOf", args: [sender.address] });
    if (have < amountWei) {
      return { status: "error", message: `The wallet holds ${this.fmt(have, asset)}, less than the ${this.fmt(amountWei, asset)} asked.` };
    }
    const gate = this.gate({ action: "add", chainId: this.network.chainId, asset: asset.address, amountWei, recipient: null });
    if (!gate.ok) return this.refused(gate.refusal);
    let held: StoredNote | undefined;
    let hash: Hex | undefined;
    let sending = false;
    try {
      const intent = await buildShieldBoundIntent({
        amountWei,
        asset: asset.address,
        chainId: this.network.chainId,
        poolAddress: this.network.pool,
        prover: await this.prover("shield"),
        // the vault's live deposit limits, checked before proving (they change through its timelock)
        client: this.publicClient,
      });
      held = this.keep(
        this.newNote(
          { secret: intent.note.secret, commitment: intent.note.commitment, nullifier: intent.note.nullifier, amountWei: amountWei.toString(), asset: asset.address },
          asset,
          "shield",
          { label: args.label }
        )
      );
      const calls: Call[] = [];
      if (!isNative) {
        const allowance = await this.publicClient.readContract({ address: asset.address, abi: ERC20_ABI, functionName: "allowance", args: [sender.address, this.network.pool] });
        // USDT on Ethereum refuses a new approval over a stale one, so that takes a reset first.
        for (const step of approvalSteps(this.network.chainId, asset.address, allowance, amountWei)) {
          calls.push({ to: asset.address, data: encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [this.network.pool, step] }) });
        }
      }
      calls.push({
        to: this.network.pool,
        data: encodeFunctionData({ abi: SHIELD_ABI, functionName: "shieldBound", args: intent.exec.args as never }),
        value: intent.exec.valueWei,
      });
      // From here the deposit may go out: its note is never dropped unless the chain says it failed.
      sending = true;
      hash = await sender.sendCalls(calls);
      const sentHash = hash;
      this.store.update(held.handle, { createdTx: sentHash });
      const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success" || !(await this.didLand(receipt.blockNumber, { seen: [held.commitment] }))) {
        this.settle(gate.id, "reverted", { hash });
        this.store.remove(held.handle);
        return {
          status: "error",
          message:
            receipt.status !== "success"
              ? `The deposit reverted (${hash}). Nothing moved.`
              : `The transaction ${hash} succeeded, but the deposit inside it did not happen (an operation that reverted inside a smart account). Nothing moved into the vault.`,
        };
      }
      this.settle(gate.id, "sent", { hash });
      const stored = this.store.update(held.handle, { status: "unspent", createdTx: hash }) ?? held;
      const counted = await this.attributeDeposit(hash);
      return {
        status: "done",
        action: "add",
        network: this.network.key,
        added: this.fmt(amountWei, asset),
        note: noteView(stored),
        hash,
        explorer: this.explorer(hash),
        ...(counted ? { partner: counted } : {}),
        public: "The deposit shows the wallet, the asset and the amount. Who can spend the note does not.",
      };
    } catch (e) {
      const error = errMsg(e);
      const maybe = Boolean(hash) || (sending && !isNotSent(e));
      this.settle(gate.id, maybe ? "unconfirmed" : "failed", { hash, reason: error });
      if (held && !maybe) this.store.remove(held.handle);
      if (!maybe) return { status: "error", message: error };
      const kept = held ? this.store.get(held.handle) ?? held : null;
      return {
        status: "unconfirmed",
        message: `The deposit was sent, but its answer was lost (${error}). It may still land.`,
        ...(hash ? { hash, explorer: this.explorer(hash) } : {}),
        ...(kept ? { note: noteView(kept) } : {}),
        check: "Refresh the balance before adding again: the note is kept, and refresh() makes it spendable once the deposit is on chain.",
      };
    }
  }

  /** With a partner key, count a deposit that landed to the partner. Best effort: the deposit stands either way. */
  private async attributeDeposit(txHash: Hex): Promise<string | null> {
    if (!this.api) return null;
    try {
      await this.api.attributeDeposit({ chainId: this.network.chainId, txHash });
      return "Counted to your partner key.";
    } catch (e) {
      return `Not counted to your partner key (${errMsg(e)}). The deposit itself landed.`;
    }
  }

  // ------------------------------------------------------------------ pay privately

  /**
   * Pay privately to a Gloam address (gloamr1.…) or a payment request link.
   * The payment is sealed to the payee's address and, where the network has a
   * payment-message board, posted there so the payee finds it.
   */
  async pay(args: { to: string; amount?: string; asset?: string; note?: string; label?: string }): Promise<Outcome> {
    const target = String(args.to ?? "").trim();
    let payTo: string;
    let asset: GloamAsset;
    let amountWei: bigint;
    let memo = cleanPaymentNote(args.note);
    if (/^https?:\/\//i.test(target)) {
      let req;
      try {
        req = parsePaymentRequestLink(target);
      } catch {
        throw new Error("That is not a payment request link.");
      }
      if (!req.payTo || !isReceiveTag(req.payTo)) throw new Error("That payment request has no Gloam address to pay.");
      if (req.networkKey && req.networkKey !== this.network.key) {
        throw new Error(`That request is for ${req.networkKey}, and this agent pays on ${this.network.key}.`);
      }
      payTo = req.payTo;
      asset = req.asset ? this.asset(req.asset) : this.asset(args.asset);
      if (args.asset && this.asset(args.asset).address.toLowerCase() !== asset.address.toLowerCase()) {
        throw new Error(`The request asks for ${asset.symbol}, not ${args.asset}.`);
      }
      if (req.amount) {
        amountWei = this.amount(req.amount, asset);
        if (args.amount && this.amount(args.amount, asset) !== amountWei) {
          throw new Error(`The request asks for ${this.fmt(amountWei, asset)}. Pay that amount or leave the amount out.`);
        }
      } else {
        amountWei = this.amount(args.amount, asset);
      }
      if (req.note && memo && req.note !== memo) throw new Error("The request already carries a note. Leave the note out.");
      memo = req.note ?? memo;
    } else if (isReceiveTag(target)) {
      payTo = target;
      asset = this.asset(args.asset);
      amountWei = this.amount(args.amount, asset);
    } else {
      throw new Error("Pay to a Gloam address (gloamr1.…) or a payment request link. For someone without one, pay by claim link.");
    }
    return this.payTag({ payTo, asset, amountWei, memo: memo || undefined, label: args.label });
  }

  /**
   * Pay a 402 price privately (x402, scheme gloam-private): a private send of
   * exactly the price to its payTo, sealed to that receive tag. The X-PAYMENT
   * value comes back as `paymentHeader` and is kept with the payment, so a call
   * whose answer was lost gets the same header again, never a second payment.
   * Nothing is posted to the payment board: the header carries the payment.
   */
  async payX402(args: { requirements: GloamPaymentRequirements; label?: string }): Promise<Outcome> {
    const req = args.requirements;
    if (!req || req.scheme !== GLOAM_X402_SCHEME) throw new Error(`Only Gloam's x402 scheme (${GLOAM_X402_SCHEME}) is paid here.`);
    if (Number(req.network) !== this.network.chainId) {
      throw new Error(`That price is on ${networkName(Number(req.network))}, and this agent pays on ${this.where()}.`);
    }
    if (!req.poolAddress || req.poolAddress.toLowerCase() !== this.network.pool.toLowerCase()) throw new Error("That price settles through a different vault.");
    if (!isReceiveTag(String(req.payTo ?? ""))) throw new Error("That price's payTo is not a Gloam address (gloamr1.…), so it cannot be paid privately.");
    const asset = this.network.assets.find((a) => a.address.toLowerCase() === String(req.asset).toLowerCase());
    if (!asset) throw new Error(`The ${this.where()} vault does not take ${req.asset}.`);
    if (!/^[0-9]+$/.test(String(req.maxAmountRequired)) || BigInt(req.maxAmountRequired) <= 0n) throw new Error("That price is not a whole, positive number of base units.");
    return this.payTag({ payTo: req.payTo, asset, amountWei: BigInt(req.maxAmountRequired), label: args.label ?? `x402: ${resourceLabel(req.resource)}`, x402: true });
  }

  /** The private send behind pay() and payX402(): limits, one note, sealed to `payTo`, never paid twice. */
  private async payTag(p: { payTo: string; asset: GloamAsset; amountWei: bigint; memo?: string; label?: string; x402?: boolean }): Promise<Outcome> {
    const { payTo, asset, amountWei, memo } = p;
    const args = { label: p.label };
    const action = p.x402 ? "pay_x402" : "pay";
    // A payment like this one whose answer was lost may still land: never pay it twice.
    const requestKey = this.requestKeyOf(payTo, asset, amountWei, args.label);
    const plan = await this.retryPlan(requestKey, amountWei, memo || undefined, (n) => ({
      status: "done",
      action,
      alreadyPaid: true,
      network: this.network.key,
      paid: this.fmt(amountWei, asset),
      to: shortTag(payTo),
      payment: n.handle,
      ...(n.createdTx ? { hash: n.createdTx, explorer: this.explorer(n.createdTx) } : {}),
      ...(p.x402 && n.x402 ? { paymentHeader: this.withTxHash(n.x402, n.createdTx ?? null) } : {}),
      message: "This payment already landed after its answer was lost. It was not sent again.",
    }));
    if (plan.kind === "answer") return plan.outcome;
    // A retry spends the same note as the attempt it repeats, so only one of them can land. It is checked against
    // the limits like a new payment, with that attempt's money counted once.
    const gate = this.gate({ action: "pay", chainId: this.network.chainId, asset: asset.address, amountWei, recipient: payTo }, plan.kind === "same" ? plan.prior : undefined);
    if (!gate.ok) {
      if (plan.kind === "same") this.release(plan.input.handle);
      return this.refused(gate.refusal);
    }
    const settle = (status: "sent" | "unconfirmed" | "reverted" | "failed", extra: { hash?: string; reason?: string } = {}) => {
      this.settle(gate.id, status, extra);
    };
    let input: StoredNote;
    if (plan.kind === "same") {
      input = plan.input;
    } else {
      try {
        input = this.reserveNote(asset, amountWei);
      } catch (e) {
        settle("failed", { reason: errMsg(e) });
        return { status: "error", message: errMsg(e), privateBalance: balances(this.store.list(), this.network.chainId) };
      }
    }
    let sealed = "";
    let header = "";
    const sent = await this.privateSend({
      input,
      asset,
      amountPay: amountWei,
      payOrigin: "payment",
      label: args.label ?? `payment to ${shortTag(payTo)}`,
      memo: memo || undefined,
      requestKey,
      spendId: gate.id,
      // Sealed before anything is sent: a payee key that cannot be sealed to stops the payment here.
      prepare: async (_payment, note, exec) => {
        const pack = encodeNotePackage({
          pool: this.network.pool,
          chainId: this.network.chainId,
          asset: note.asset,
          amountWei: note.amountWei,
          secret: note.secret,
          commitment: note.commitment,
          note: memo || undefined,
        });
        sealed = await sealToReceiveTag(pack, payTo);
        if (!p.x402) return { deliver: sealed };
        // x402: the header is the delivery. Kept with the payment (it holds the note sealed, never in the clear).
        // The binding ties the payment to this payee, as buildGloamPayment does: sellers refuse a payment without
        // one, since a sealed ticket copied from the payment board would otherwise pass as a payment.
        const payload: GloamPaymentPayload = {
          x402Version: GLOAM_X402_VERSION,
          scheme: GLOAM_X402_SCHEME,
          network: this.network.chainId,
          payload: {
            paymentNote: sealed,
            txHash: null,
            exec,
            binding: await gloamPaymentBinding({
              secret: note.secret,
              network: this.network.chainId,
              poolAddress: this.network.pool,
              payTo,
              commitment: note.commitment,
            }),
          },
        };
        header = encodePaymentHeader(payload);
        return { x402: header };
      },
    });
    if (!sent.ok) {
      settle(sent.maybeSent ? "unconfirmed" : "failed", { hash: sent.hash ?? undefined, reason: sent.error });
      if (sent.maybeSent) {
        if (p.x402) {
          return this.unconfirmed("The payment", sent, {
            ...(header ? { paymentHeader: this.withTxHash(header, sent.hash) } : {}),
            delivered: "Not presented yet. Once refresh() shows the payment landed, present paymentHeader to the resource; asking for the same payment again returns it.",
          });
        }
        return this.unconfirmed("The payment", sent, {
          sealedCode: sealed || undefined,
          delivered: "Not posted yet: refresh() posts the sealed payment message once the payment is on chain. The sealed code opens only with the payee's key.",
        });
      }
      return { status: "error", message: sent.error };
    }
    settle("sent", { hash: sent.hash });
    if (p.x402) {
      const paymentHeader = this.withTxHash(header, sent.hash);
      this.store.update(sent.payment.handle, { x402: paymentHeader });
      return {
        status: "done",
        action,
        network: this.network.key,
        paid: this.fmt(amountWei, asset),
        to: shortTag(payTo),
        payment: sent.payment.handle,
        hash: sent.hash,
        explorer: this.explorer(sent.hash),
        submittedBy: this.submitMode === "relay" ? "the Gloam relay (this agent's wallet does not appear)" : "this agent's wallet",
        paymentHeader,
        delivered: "Present paymentHeader as the X-PAYMENT header. It carries the payment sealed to the payee: only their key opens it.",
        change: sent.change ? noteView(sent.change) : null,
        public: "The chain shows a shielded transfer. Not the amount, the sender or the payee.",
      };
    }
    const memoPost = await this.postMemo(sent.paymentNote.commitment, sealed);
    if (memoPost.posted) this.store.update(sent.payment.handle, { deliver: undefined });
    return {
      status: "done",
      action: "pay",
      network: this.network.key,
      paid: this.fmt(amountWei, asset),
      to: shortTag(payTo),
      payment: sent.payment.handle,
      hash: sent.hash,
      explorer: this.explorer(sent.hash),
      submittedBy: this.submitMode === "relay" ? "the Gloam relay (this agent's wallet does not appear)" : "this agent's wallet",
      delivered: memoPost.posted
        ? "Posted sealed on the network's payment-message board. Only the payee's key opens it."
        : `Not posted (${memoPost.reason}). Give the payee this sealed code; only their key opens it. refresh() tries the board again.`,
      ...(memoPost.posted ? {} : { sealedCode: sealed }),
      change: sent.change ? noteView(sent.change) : null,
      public: "The chain shows a shielded transfer. Not the amount, the sender or the payee.",
    };
  }

  /** An X-PAYMENT value with the settlement transaction filled in (it is made before the send goes out). */
  private withTxHash(header: string, hash: Hex | null): string {
    if (!hash) return header;
    const payload = decodePaymentHeader(header);
    payload.payload.txHash = hash;
    return encodePaymentHeader(payload);
  }

  /**
   * What makes two payments the same one: payee, asset and amount, and the
   * caller's label when it gives one (two ACP jobs paying the same payee the
   * same amount carry different labels, so they are two payments). The note is
   * left out on purpose: a planner that rewords the note on a retry is still
   * asking for the same payment. So a second payment of the same amount to the
   * same payee, with no label, waits until the first one settles. Hashed; none
   * of it secret.
   */
  private requestKeyOf(payTo: string, asset: GloamAsset, amountWei: bigint, label?: string): string {
    const parts = [this.network.chainId, payTo.trim(), asset.address.toLowerCase(), amountWei, ...(label ? [`label:${label}`] : [])];
    return createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 32);
  }

  /**
   * How to go on with a payment (or claim link) that may repeat an earlier one
   * whose answer was lost:
   *   new     no earlier attempt can still land: pay from any note
   *   same    the earlier attempt is over an hour old and its note is free again:
   *           pay from that same note (reserved), so at most one of the two lands
   *   answer  it already landed, or it may still land and its note is held: say so
   * The earlier attempt is dropped (by refresh) only once the note it spends reads
   * spent and its payment is not in the vault.
   */
  private async retryPlan(
    requestKey: string,
    amountWei: bigint,
    memo: string | null | undefined,
    landed: (n: StoredNote) => Outcome | Promise<Outcome>
  ): Promise<{ kind: "new" } | { kind: "same"; input: StoredNote; prior: StoredNote } | { kind: "answer"; outcome: Outcome }> {
    const prior = () =>
      this.store
        .list()
        .filter((x) => x.requestKey === requestKey && x.chainId === this.network.chainId && x.status === "pending" && (x.origin === "payment" || x.origin === "claim"))
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
    const first = prior();
    if (!first) return { kind: "new" };
    await this.refresh().catch(() => undefined);
    const now = this.store.get(first.handle);
    if (now && now.status !== "pending") {
      // The earlier one landed. It is this payment only if it carries this note; another payment of the same
      // amount to the same payee (another invoice) is never answered with it. Nothing is sent this time: a planner
      // that reworded the note of the same payment must not pay it again, so it is told to ask again only for a
      // different payment (the earlier one is settled now, so that next call goes out).
      if ((now.memo ?? "") === (memo ?? "")) return { kind: "answer", outcome: await landed(now) };
      return {
        kind: "answer",
        outcome: {
          status: "refused",
          code: "earlier_payment_landed",
          message: `An earlier payment of the same amount to the same payee (${now.handle}${now.memo ? `, note "${now.memo}"` : ""}) has just landed, so this one${memo ? ` (note "${memo}")` : ""} was not sent. If this is the same payment, it is already paid; ask again only for a different payment.`,
          payment: now.handle,
        },
      };
    }
    const p = now ?? prior();
    if (!p) return { kind: "new" };
    const input = p.spendsHandle ? this.store.get(p.spendsHandle) : undefined;
    if (p.stale && input && input.status === "unspent" && BigInt(input.amountWei) >= amountWei) {
      try {
        return { kind: "same", input: this.store.reserveForSpend(input.handle), prior: p };
      } catch {
        /* taken meanwhile: refused below */
      }
    }
    return {
      kind: "answer",
      outcome: {
        status: "refused",
        code: "unconfirmed_payment",
        message: `The same payment (${p.handle}) has not confirmed and may still land, so it is not sent again. Refresh the balance: once it lands it is done; after an hour it can be sent again from the same note, so only one of the two can land.`,
        payment: p.handle,
      },
    };
  }

  /**
   * Pay by claim link: for someone with no Gloam address. The link is a bearer
   * secret, so it goes to onClaimLink, or sealed to `sealTo` (a Gloam address),
   * never back to the planner. Unclaimed links can be taken back.
   */
  async payByClaimLink(args: { amount: string; asset?: string; note?: string; sealTo?: string; label?: string }): Promise<Outcome> {
    const asset = this.asset(args.asset);
    const amountWei = this.amount(args.amount, asset);
    const memo = cleanPaymentNote(args.note);
    if (args.sealTo && !isReceiveTag(args.sealTo)) throw new Error("sealTo must be a Gloam address (gloamr1.…) whose key is a real P-256 point.");
    // A link sealed to an address is a payment to that address: the same one is never sent twice while it may land.
    const requestKey = args.sealTo ? this.requestKeyOf(`claim:${args.sealTo}`, asset, amountWei, args.label) : undefined;
    const plan = requestKey
      ? await this.retryPlan(requestKey, amountWei, memo || undefined, async (n) => ({
          status: "done",
          action: "pay_by_claim_link",
          alreadyPaid: true,
          network: this.network.key,
          paid: this.fmt(amountWei, asset),
          claimHandle: n.handle,
          ...(n.createdTx ? { hash: n.createdTx, explorer: this.explorer(n.createdTx) } : {}),
          sealedLink: await sealToReceiveTag(this.claimLinkOf(n).link, args.sealTo!),
          message: "This claim link already landed after its answer was lost. It was not sent again.",
        }))
      : ({ kind: "new" } as const);
    if (plan.kind === "answer") return plan.outcome;
    // a retry is checked like a new link, with the attempt it repeats counted once (see pay)
    const gate = this.gate(
      { action: "pay", chainId: this.network.chainId, asset: asset.address, amountWei, recipient: args.sealTo ?? CLAIM_LINK_RECIPIENT },
      plan.kind === "same" ? plan.prior : undefined
    );
    if (!gate.ok) {
      if (plan.kind === "same") this.release(plan.input.handle);
      return this.refused(gate.refusal);
    }
    const settle = (status: "sent" | "unconfirmed" | "reverted" | "failed", extra: { hash?: string; reason?: string } = {}) => {
      this.settle(gate.id, status, extra);
    };
    let input: StoredNote;
    if (plan.kind === "same") {
      input = plan.input;
    } else {
      try {
        input = this.reserveNote(asset, amountWei);
      } catch (e) {
        settle("failed", { reason: errMsg(e) });
        return { status: "error", message: errMsg(e) };
      }
    }
    let sealedLink: string | undefined;
    const sent = await this.privateSend({
      input,
      asset,
      amountPay: amountWei,
      payOrigin: "claim",
      label: args.label ?? "claim link",
      memo: memo || undefined,
      requestKey,
      spendId: gate.id,
      // Sealed before anything is sent: an address that cannot be sealed to stops the payment here.
      prepare: args.sealTo
        ? async (payment) => {
            sealedLink = await sealToReceiveTag(this.claimLinkOf(payment).link, args.sealTo!);
          }
        : undefined,
    });
    if (!sent.ok) {
      settle(sent.maybeSent ? "unconfirmed" : "failed", { hash: sent.hash ?? undefined, reason: sent.error });
      if (sent.maybeSent) {
        return this.unconfirmed("The claim-link payment", sent, {
          ...(sent.payment ? { claimHandle: sent.payment.handle } : {}),
          ...(sealedLink ? { sealedLink } : {}),
          delivered: "Not delivered yet. The link is kept in the encrypted note store; once refresh() shows it landed, the owner reads it with agent.claimLink(handle).",
        });
      }
      return { status: "error", message: sent.error };
    }
    settle("sent", { hash: sent.hash });
    const out = this.claimLinkOf(sent.payment);
    let delivered: string;
    if (sealedLink) {
      delivered = `Sealed to ${shortTag(args.sealTo!)}: only that address opens it.`;
    } else if (this.onClaimLink) {
      try {
        await this.onClaimLink(out);
        delivered = "Handed to the owner's onClaimLink handler.";
      } catch (e) {
        delivered = `The onClaimLink handler failed (${errMsg(e)}). The link is kept in the encrypted note store as ${sent.payment.handle}.`;
      }
    } else {
      delivered = `Kept in the encrypted note store as ${sent.payment.handle}. The owner reads it with agent.claimLink("${sent.payment.handle}").`;
    }
    return {
      status: "done",
      action: "pay_by_claim_link",
      network: this.network.key,
      paid: this.fmt(amountWei, asset),
      claimHandle: sent.payment.handle,
      hash: sent.hash,
      explorer: this.explorer(sent.hash),
      delivered,
      ...(sealedLink ? { sealedLink } : {}),
      change: sent.change ? noteView(sent.change) : null,
      public: "The chain shows a shielded transfer. The link is a bearer secret: whoever holds it can claim.",
    };
  }

  /** The claim link for a claim note this agent made. Owner code only: it is a bearer secret. */
  claimLink(handle: string): ClaimLinkOut {
    const n = this.store.get(handle);
    if (!n || n.origin !== "claim") throw new Error(`There is no claim link "${handle}".`);
    return this.claimLinkOf(n);
  }

  private claimLinkOf(n: StoredNote): ClaimLinkOut {
    const code = encodeNotePackage({ pool: n.pool, chainId: n.chainId, asset: n.asset, amountWei: n.amountWei, secret: n.secret, commitment: n.commitment, note: n.memo });
    return {
      handle: n.handle,
      link: claimLinkFor(code, n.network),
      network: n.network,
      asset: n.symbol,
      amount: formatUnits(BigInt(n.amountWei), n.decimals),
      note: n.memo ?? null,
      label: n.label ?? null,
    };
  }

  // ------------------------------------------------------------------ receive

  /** A payment request link for this agent's Gloam address. Not a secret: share it with the payer. */
  async requestPayment(args: { amount?: string; asset?: string; note?: string; name?: string }): Promise<Outcome> {
    const asset = this.asset(args.asset);
    // Checked here as a payment is, so "2,5" is refused rather than asked for as 25.
    const amount = args.amount?.trim() ? formatUnits(this.amount(args.amount, asset), asset.decimals) : undefined;
    const link = buildPaymentRequestLink({
      payTo: await this.address(),
      network: this.network.key,
      asset: asset.address,
      amount,
      note: args.note,
      name: args.name,
    });
    return {
      status: "done",
      action: "request",
      network: this.network.key,
      link,
      gloamAddress: await this.address(),
      asset: asset.symbol,
      amount: amount ?? "payer chooses",
      private: "The details ride after the # in the link, which browsers never send to a server.",
    };
  }

  /**
   * Move one received note into a fresh note only this agent knows. Credits
   * only when the sweep confirms. The fresh note is kept from before the sweep is
   * sent, and stays (pending) whenever the sweep may have gone out.
   */
  private async secure(note: NoteExport, asset: GloamAsset, label: string): Promise<{ status: string; hash: Hex | null; handle?: string; reason?: string | null }> {
    const sweptFrom = note.nullifier;
    const earlier = this.store.list().filter((n) => n.sweptFrom?.toLowerCase() === sweptFrom.toLowerCase() && n.status !== "spent");
    if (earlier.some((n) => n.status === "unspent")) return { status: "already_secured", hash: null };
    // A sweep that may still land is not secured yet: the scan stays on this payment. After an hour with
    // nothing on chain it is swept again (both spend the same payment note, so only one can land).
    const waiting = earlier.find((n) => n.status === "pending" && !n.stale);
    if (waiting) return { status: "unconfirmed", hash: waiting.createdTx, handle: waiting.handle, reason: "A sweep of this payment may still land. refresh() settles it." };
    registerSecret(note.secret);
    let fresh: StoredNote | undefined;
    let started = false;
    let sendError: unknown = null;
    const res = await sweepReceivedNote({
      note,
      poolAddress: this.network.pool,
      chainId: this.network.chainId,
      prove: await this.prover("transfer"),
      chain: this.sweepChain(),
      submit: async (intent) => {
        started = true;
        try {
          return await this.submitIntent(intent);
        } catch (e) {
          sendError = e;
          throw e;
        }
      },
      beforeSubmit: (freshNote) => {
        fresh = this.keep(this.newNote(freshNote, asset, "received", { sweptFrom, spends: sweptFrom, label }));
      },
    });
    // The SDK reads "failed" when the chain shows nothing yet; a sweep still in the mempool reads the same.
    let status: string = res.status;
    let reason = res.reason;
    // A successful receipt can hide an operation that reverted inside a smart account: the fresh note must be in the vault.
    if (status === "swept" && res.hash && res.freshNote) {
      const r = await this.publicClient.getTransactionReceipt({ hash: res.hash }).catch(() => null);
      const done = r ? await this.didLand(r.blockNumber, { seen: [res.freshNote.commitment] }).catch(() => null) : null;
      if (done === false) {
        status = "failed";
        reason = `The transaction ${res.hash} succeeded, but the sweep inside it did not happen. It can be retried.`;
      } else if (done === null) {
        status = "unconfirmed";
        reason = "The sweep's transaction could not be read back yet. refresh() settles it.";
      }
    }
    if (status === "failed" && started && sendError && this.mayHaveSent(sendError)) {
      status = "unconfirmed";
      reason = `The sweep was sent, but its answer was lost (${errMsg(sendError)}). The fresh note is kept; refresh() settles it.`;
    }
    if (fresh) {
      if (status === "swept") this.store.update(fresh.handle, { status: "unspent", createdTx: res.hash });
      else if (status !== "unconfirmed") this.store.remove(fresh.handle);
      else if (res.hash) this.store.update(fresh.handle, { createdTx: res.hash });
    }
    return { status, hash: res.hash, handle: status === "swept" || status === "unconfirmed" ? fresh?.handle : undefined, reason: reason ? redact(reason) : reason };
  }

  /** Find payments sent to this agent's Gloam address and secure each one. */
  async checkIncoming(): Promise<Outcome> {
    const key = this.store.receiveKey();
    if (!key) {
      return { status: "done", action: "check", received: [], message: `No Gloam address yet. Share ${await this.address()} to be paid.` };
    }
    const board = payMemoBoardFor(this.network.chainId);
    if (!board) {
      return { status: "done", action: "check", received: [], message: `${this.where()} has no payment-message board yet. Ask the payer for the sealed code and pass it as claim_link.` };
    }
    const from = this.store.scanFrom(this.network.chainId) ?? board.deployBlock;
    // Reading the vault first also learns how wide a log range this RPC takes.
    await this.tree.sync();
    let chunk = this.tree.logChunk;
    let scan: Awaited<ReturnType<typeof scanIncomingPayments>> | null = null;
    for (let attempt = 0; !scan; attempt++) {
      try {
        scan = await scanIncomingPayments({ client: this.publicClient, network: this.network, receiveKey: key, fromBlock: from, chunkSize: chunk });
      } catch (e) {
        if (attempt >= 6 || chunk <= 1n) throw e;
        chunk = chunk / 4n > 0n ? chunk / 4n : 1n;
      }
    }
    const received: Record<string, unknown>[] = [];
    let stopAt: bigint | null = null;
    // Settled one way or the other: the scan can move past these. Anything else is read again next time.
    const FINAL = new Set(["swept", "already_secured", "already_spent", "bad_note"]);
    for (const p of scan.payments) {
      const asset = this.network.assets.find((a) => a.address.toLowerCase() === p.asset.toLowerCase());
      if (!asset) {
        // The scan moves past it, so it is said now, not passed over in silence.
        received.push({ asset: p.asset, note: p.note, status: "unlisted_asset", skipped: "Recorded and skipped: this version can't secure this asset. It stays on chain, so don't count it as received." });
        continue;
      }
      let res: Awaited<ReturnType<GloamAgent["secure"]>>;
      try {
        res = await this.secure(await notePackageToExport(p.notePackage), asset, p.note ? `received: ${p.note}` : "received");
      } catch (e) {
        res = { status: "error", hash: null, reason: errMsg(e) };
      }
      received.push({
        amount: this.fmt(p.amountWei, asset),
        note: p.note,
        status: res.status,
        ...(res.handle ? { handle: res.handle } : {}),
        ...(res.hash ? { hash: res.hash } : {}),
        ...(res.reason ? { reason: res.reason } : {}),
        // A message anyone could post that can never be swept (no value): recorded once, not read again.
        ...(res.status === "bad_note" ? { skipped: "Recorded and skipped: this payment message can never be secured." } : {}),
      });
      if (!FINAL.has(res.status) && stopAt === null && p.blockNumber != null) stopAt = p.blockNumber;
    }
    this.store.setScanFrom(this.network.chainId, stopAt ?? scan.scannedTo + 1n);
    return {
      status: "done",
      action: "check",
      network: this.network.key,
      received,
      scannedTo: scan.scannedTo.toString(),
      rule: "A payment counts only once it is moved into a note only this agent knows (swept).",
    };
  }

  /** Claim a claim link (or code) into this agent's private balance. */
  async claim(link: string): Promise<Outcome> {
    // A code sealed to this agent's Gloam address (gloam2t.…) is opened here, so only ciphertext passes the planner.
    const text = String(link ?? "").trim();
    const opened = text.startsWith("gloam2t.") ? await this.openSealed(text) : text;
    const { pack, networkKey } = readClaimLink(opened);
    registerSecret(pack.secret);
    // The vault address is the same on several chains, so a code that names its chain must name this one.
    if (pack.chainId !== undefined && pack.chainId !== this.network.chainId) {
      throw new Error(`That claim code is for ${networkName(pack.chainId)}, and this agent is on ${this.where()}.`);
    }
    if (networkKey && networkKey !== this.network.key && pack.chainId === undefined) {
      throw new Error(`That claim link is for ${networkKey}, and this agent is on ${this.network.key}.`);
    }
    if (pack.pool.toLowerCase() !== this.network.pool.toLowerCase()) throw new Error("That claim link is for a different vault.");
    const asset = this.network.assets.find((a) => a.address.toLowerCase() === pack.asset.toLowerCase());
    if (!asset) throw new Error("That claim link holds an asset this vault does not list.");
    const res = await this.secure(await notePackageToExport(pack), asset, pack.note ? `claimed: ${pack.note}` : "claimed link");
    return {
      status: res.status === "swept" || res.status === "already_secured" ? "done" : res.status === "unconfirmed" ? "pending" : "error",
      action: "claim",
      network: this.network.key,
      amount: this.fmt(pack.amountWei, asset),
      result: res.status,
      ...(res.handle ? { handle: res.handle } : {}),
      ...(res.hash ? { hash: res.hash, explorer: this.explorer(res.hash) } : {}),
      ...(res.reason ? { message: res.reason } : {}),
    };
  }

  /** Take back a claim link nobody claimed yet (owner code). */
  async takeBack(handle: string): Promise<Outcome> {
    const n = this.store.get(handle);
    if (!n || n.origin !== "claim") throw new Error(`There is no claim link "${handle}".`);
    const asset = this.network.assets.find((a) => a.address.toLowerCase() === n.asset.toLowerCase())!;
    const res = await this.secure({ secret: n.secret, commitment: n.commitment, nullifier: n.nullifier, amountWei: n.amountWei, asset: n.asset }, asset, `took back ${handle}`);
    if (res.status === "swept" || res.status === "already_spent") this.store.update(handle, { status: "spent" });
    return { status: res.status === "swept" ? "done" : "error", action: "take_back", result: res.status, ...(res.reason ? { message: res.reason } : {}) };
  }

  // ------------------------------------------------------------------ cash out

  /**
   * Cash out to a public address. A cash out spends a whole note, so for a
   * smaller amount the note is first split privately (a send to itself). A
   * whole note behind a proof of funds is first moved the same way to a fresh
   * note, as the app does: the proof carries its nullifier, and a cash out of
   * it would show next to that nullifier where the money went and how much.
   * The fresh note's nullifier is in no proof. The move and the cash out still
   * land close together, so their timing can hint at a link.
   */
  async cashOut(args: { amount: string; asset?: string; to: string; label?: string }): Promise<Outcome> {
    const asset = this.asset(args.asset);
    const amountWei = this.amount(args.amount, asset);
    return this.cashOutWei(asset, amountWei, String(args.to ?? "").trim());
  }

  /**
   * Pay a 402 price with scheme gloam-cashout: a cash out of exactly the quoted
   * gross amount G of USDG to the quote's public payTo (a gateway's splitter),
   * on Robinhood Chain mainnet. The quote is checked first (network, asset,
   * vault, payTo, amount, quoteId, expiry) and refused above `maxAmount`, which
   * is required. Like any cash out it splits a note privately first when none
   * holds exactly G, passes the owner's limits as a cash out to payTo, and is
   * never sent twice for an answer that was lost.
   *
   * The X-PAYMENT value comes back as `paymentHeader`: base64 JSON
   * { scheme, txHash, quoteId }. It carries a public tx hash and the gateway's
   * own quoteId, never a note or a key.
   */
  async payX402Cashout(args: { requirement: GloamCashoutRequirement; maxAmount: string }): Promise<Outcome> {
    const req = args.requirement;
    if (this.network.chainId !== GLOAM_CASHOUT_CHAIN_ID || !isAddressEqual(this.network.pool, GLOAM_CASHOUT_VAULT)) {
      throw new Error(`A ${GLOAM_CASHOUT_SCHEME} price is paid on Robinhood Chain mainnet, and this agent pays on ${this.where()}.`);
    }
    const asset = this.network.assets.find((a) => isAddressEqual(a.address, GLOAM_CASHOUT_ASSET));
    if (!asset) throw new Error(`The ${this.where()} vault does not take USDG.`);
    if (args.maxAmount === undefined || args.maxAmount === null || String(args.maxAmount).trim() === "") {
      return { status: "refused", code: "no_max_amount", message: `A ${GLOAM_CASHOUT_SCHEME} payment needs a maxAmount, the most you will cash out for it. Not paying.` };
    }
    const problem = gloamCashoutProblem(req, { maxAmount: this.amount(args.maxAmount, asset) });
    if (problem) return { status: "refused", code: problem.code, message: problem.message };
    const gross = BigInt(req.amount);
    const payTo = getAddress(req.payTo);
    // One purchase per quote: its cash out note carries a key made from the quote, so the same quote asked again
    // (a retry whose X-PAYMENT never reached the gateway) presents that cash out and is never paid twice.
    const quoteLabel = `x402-cashout:${createHash("sha256").update(req.quoteId).digest("hex").slice(0, 32)}`;
    const quoteKey = this.requestKeyOf(`cash_out:${payTo.toLowerCase()}`, asset, gross, quoteLabel);
    const paid = this.store.list().find((x) => x.requestKey === quoteKey && x.chainId === this.network.chainId && x.status === "spent");
    const out: Outcome = paid
      ? {
          status: "done",
          action: "cash_out",
          alreadyCashedOut: true,
          network: this.network.key,
          cashedOut: this.fmt(gross, asset),
          to: payTo,
          ...(paid.spentTx ? { hash: paid.spentTx, explorer: this.explorer(paid.spentTx) } : {}),
          message: "This quote was already paid, so that cash out is presented and nothing new was paid.",
        }
      : await this.cashOutWei(asset, gross, payTo, quoteLabel);
    const tagged: Outcome = { ...out, action: "pay_x402_cashout", scheme: GLOAM_CASHOUT_SCHEME };
    if (out.status !== "done") return tagged;
    if (typeof out.hash !== "string") {
      return {
        ...tagged,
        status: "unconfirmed",
        message: "The cash out landed, but its transaction hash is not known here, so there is no payment header for it. Find the cash out to payTo in the vault's Unshielded logs and present its hash. Asking again with this quote does not pay it twice.",
      };
    }
    return {
      ...tagged,
      paymentHeader: encodeGloamCashoutHeader({ txHash: out.hash as Hex, quoteId: req.quoteId }),
      delivered: "Present paymentHeader as the X-PAYMENT header on the retry. It carries the cash out's tx hash and the quote's id, nothing private.",
      public: `The chain shows ${this.fmt(gross, asset)} leaving the Gloam vault to ${payTo}, the payee's public address. Not ${this.submitMode === "relay" ? "this agent's wallet, or " : ""}which private payment funded it.`,
    };
  }

  /** A cash out of exactly `amountWei` to `to`: behind cashOut() and payX402Cashout(). */
  private async cashOutWei(asset: GloamAsset, amountWei: bigint, to: string, keyLabel?: string): Promise<Outcome> {
    if (!isAddress(to)) throw new Error("Cash out to a 0x address.");
    // Here and not only in the builder: the split below would already have spent a note by then.
    const problem = cashOutTargetProblem(to, this.network);
    if (problem) throw new Error(problem);
    // The same cash out (address, asset, amount) whose answer was lost may still land: it is never paid twice.
    // Its notes carry this key: the split that makes the exact note, and the note being cashed out.
    const requestKey = this.requestKeyOf(`cash_out:${to.toLowerCase()}`, asset, amountWei, keyLabel);
    const carrying = () => this.store.list().filter((x) => x.requestKey === requestKey && x.chainId === this.network.chainId && x.status !== "spent");
    const unconfirmedCashOut = (n: StoredNote): Outcome => ({
      status: "refused",
      code: "unconfirmed_cash_out",
      message: `The same cash out (${n.handle}) has not confirmed and may still land, so it is not sent again. Refresh the balance: once it lands it is done; after an hour it can be sent again from the same note, so only one of the two can land.`,
    });
    let exact: StoredNote | null = null;
    let input: StoredNote | null = null;
    /** The earlier attempt this one repeats (a retry), and how to undo what was reserved for it here. */
    let retryOf: StoredNote | undefined;
    let undoReserve: (() => void) | undefined;
    if (carrying().length) {
      const held = carrying().filter((x) => x.status === "pending" && x.pending === "spend").map((x) => x.handle);
      await this.refresh().catch(() => undefined);
      // A note held for this cash out alone is spent: the cash out landed.
      const landed = held.map((h) => this.store.get(h)).find((x) => x?.status === "spent");
      if (landed) {
        return {
          status: "done",
          action: "cash_out",
          alreadyCashedOut: true,
          network: this.network.key,
          cashedOut: this.fmt(amountWei, asset),
          to,
          ...(landed.spentTx ? { hash: landed.spentTx, explorer: this.explorer(landed.spentTx) } : {}),
          message: "This cash out already landed after its answer was lost. It was not sent again.",
        };
      }
      const now = carrying();
      const spending = now.find((x) => x.status === "pending" && x.pending === "spend");
      const splitting = now.find((x) => x.status === "pending" && x.pending === "create");
      const ready = now.find((x) => x.status === "unspent" && BigInt(x.amountWei) === amountWei);
      if (spending) {
        if (!spending.stale) return unconfirmedCashOut(spending);
        exact = spending; // sent again from the same note
        retryOf = spending;
      } else if (splitting) {
        const from = splitting.spendsHandle ? this.store.get(splitting.spendsHandle) : undefined;
        if (!splitting.stale || !from || from.status !== "unspent") return unconfirmedCashOut(splitting);
        try {
          input = this.store.reserveForSpend(from.handle); // split again from the same note
          retryOf = splitting;
          undoReserve = () => this.release(from.handle);
        } catch {
          return unconfirmedCashOut(splitting);
        }
      } else if (ready) {
        try {
          const kept = this.store.reserveForSpend(ready.handle);
          // put behind a proof of funds since it was kept: moved to a fresh note first, as below
          if (kept.fundsProofAt) input = kept;
          else exact = kept;
          retryOf = ready;
          // kept for this cash out: back to waiting for it, its tag kept
          undoReserve = () => this.store.update(ready.handle, { status: "unspent" });
        } catch {
          /* taken meanwhile: a new cash out below */
        }
      }
    }
    // A retry spends the note its first attempt did, so only one of the two can land. It is checked against the
    // limits like a new cash out, with that attempt's money counted once.
    const gate = this.gate({ action: "cash_out", chainId: this.network.chainId, asset: asset.address, amountWei, recipient: to }, retryOf);
    if (!gate.ok) {
      try {
        undoReserve?.();
      } catch {
        /* the note stays in the store; refresh() settles it */
      }
      return this.refused(gate.refusal);
    }
    const settle = (status: "sent" | "unconfirmed" | "reverted" | "failed", extra: { hash?: string; reason?: string } = {}) => {
      this.settle(gate.id, status, extra);
    };
    let splitHash: Hex | null = null;
    // The whole note went to a fresh note first because it is behind a proof of funds (not a split).
    let moved = false;
    if (!exact) {
      if (!input) {
        try {
          input = this.reserveNote(asset, amountWei);
        } catch (e) {
          settle("failed", { reason: errMsg(e) });
          return { status: "error", message: errMsg(e) };
        }
      }
      // A split already spends a proven note through a private send; a whole one is moved the same way.
      moved = BigInt(input.amountWei) === amountWei && Boolean(input.fundsProofAt);
      if (BigInt(input.amountWei) > amountWei || moved) {
        const split = await this.privateSend({ input, asset, amountPay: amountWei, payOrigin: "change", label: `${moved ? "move" : "split"} for a cash out to ${to}`, requestKey, spendId: gate.id });
        if (!split.ok) {
          settle(split.maybeSent ? "unconfirmed" : "failed", { hash: split.hash ?? undefined, reason: split.error });
          // Both halves of the split are kept: refresh() makes them spendable once the split is on chain. Nothing was cashed out.
          // A failed move is never followed by a cash out of the proven note itself.
          if (split.maybeSent) {
            return this.unconfirmed(moved ? "The private move to a fresh note before the cash out" : "The private split before the cash out", split, { cashedOut: "nothing yet" });
          }
          return {
            status: "error",
            message: moved
              ? `This note is behind a proof of funds, so it moves to a fresh note before a cash out, and that move failed (${split.error}). Nothing was cashed out.`
              : split.error,
          };
        }
        splitHash = split.hash;
        exact = this.store.reserveForSpend(split.payment.handle);
      } else {
        exact = input;
      }
    }
    exact = this.store.update(exact.handle, { requestKey, spendId: gate.id }) ?? exact;
    const firstStep = (): Record<string, unknown> => (!splitHash ? {} : moved ? { moveHash: splitHash } : { splitHash });
    let hash: Hex | null = null;
    let sending = false;
    try {
      // Read under the lock just above, and a held note can't be marked after: a proven note is never cashed out directly.
      if (exact.fundsProofAt) {
        throw new Error("This note is behind a proof of funds and was not moved to a fresh note first, so it was not cashed out. Ask again: the cash out moves it first.");
      }
      const vault = await this.tree.sync();
      const path = await vault.pathForCommitment(exact.commitment);
      if (!path) throw new Error("That note is not in the vault yet. Wait for it to confirm.");
      const intent = await buildUnshieldIntent({
        secretHex: exact.secret,
        amountWei,
        asset: asset.address,
        to: to as Address,
        path,
        prove: await this.prover("unshield"),
        poolAddress: this.network.pool,
        chainId: this.network.chainId,
      });
      sending = true;
      this.store.update(exact.handle, { spendStarted: new Date().toISOString(), stale: undefined });
      hash = await this.submitIntent(intent);
      this.store.update(exact.handle, { spentTx: hash });
      const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw Object.assign(new Error(`The cash out reverted (${hash}).`), { reverted: true });
      if (!(await this.didLand(receipt.blockNumber, { spent: [exact.nullifier] }))) {
        throw Object.assign(new Error(`The transaction ${hash} succeeded, but the cash out inside it did not happen (an operation that reverted inside a smart account).`), { reverted: true });
      }
      this.store.update(exact.handle, { status: "spent", spentTx: hash });
      settle("sent", { hash });
      const fee = feeKept(receipt.logs, this.network.pool, exact.nullifier);
      return {
        status: "done",
        action: "cash_out",
        network: this.network.key,
        cashedOut: this.fmt(amountWei, asset),
        fee: this.fmt(fee, asset),
        received: this.fmt(amountWei - fee, asset),
        to,
        hash,
        explorer: this.explorer(hash),
        ...firstStep(),
        ...(moved
          ? { moved: "This note was behind a proof of funds, so it was moved to a fresh note first. The proof does not lead to this cash out, though the two landing close together can hint at a link." }
          : {}),
        public: "A cash out is the public exit: the asset, the amount and the recipient show. Which private payment funded it does not.",
      };
    } catch (e) {
      const reverted = Boolean((e as { reverted?: boolean }).reverted);
      const maybe = !reverted && (Boolean(hash) || (sending && this.mayHaveSent(e)));
      if (!maybe) this.release(exact!.handle);
      settle(maybe ? "unconfirmed" : reverted ? "reverted" : "failed", { hash: hash ?? undefined, reason: errMsg(e) });
      if (maybe) return this.unconfirmed("The cash out", { hash, error: errMsg(e) }, firstStep());
      return { status: "error", message: errMsg(e) };
    }
  }

  // ------------------------------------------------------------------ proofs

  /** A proof that this agent holds at least `atLeast` of an asset privately, made for one reader. */
  async proveFunds(args: { atLeast: string; asset?: string; for: string; expiresInHours?: number }): Promise<Outcome> {
    const asset = this.asset(args.asset);
    const threshold = this.amount(args.atLeast, asset);
    // Largest notes first, at most four (the circuit's width).
    const notes = this.spendable(asset).reverse().slice(0, 4);
    const total = notes.reduce((s, n) => s + BigInt(n.amountWei), 0n);
    if (total < threshold) {
      return { status: "error", message: `The four largest private notes hold ${this.fmt(total, asset)}, less than ${this.fmt(threshold, asset)}.` };
    }
    // Only as many notes as the threshold needs.
    const use: StoredNote[] = [];
    let sum = 0n;
    for (const n of notes) {
      if (sum >= threshold) break;
      use.push(n);
      sum += BigInt(n.amountWei);
    }
    // Marked before the proof is made, so a cash out that takes one of these notes meanwhile moves it to a
    // fresh note first. Kept if proving fails: that costs one private move at most.
    this.store.markFundsProof(use.map((n) => n.handle), new Date().toISOString());
    const vault = await this.tree.sync();
    const withPaths = await Promise.all(
      use.map(async (n) => {
        const path = await vault.pathForCommitment(n.commitment);
        if (!path) throw new Error("A note is not in the vault yet. Wait for it to confirm.");
        return { secret: n.secret, amount: BigInt(n.amountWei), path };
      })
    );
    const hours = Number.isFinite(args.expiresInHours) && args.expiresInHours! > 0 ? Math.min(args.expiresInHours!, 24 * 90) : 7 * 24;
    const proof = await proveFunds({
      artifacts: this.artifacts,
      chainId: this.network.chainId,
      pool: this.network.pool,
      asset: asset.address,
      threshold,
      notes: withPaths,
      verifier: args.for,
      expiresAt: Math.floor(Date.now() / 1000) + Math.floor(hours * 3600),
    });
    const text = encodeProof(proof);
    return {
      status: "done",
      action: "prove_funds",
      network: this.network.key,
      proves: `holds at least ${this.fmt(threshold, asset)} privately`,
      for: proof.verifier,
      expiresAt: new Date(proof.expiresAt * 1000).toISOString(),
      proof: text,
      check: "Anyone can check it at gloam.trade/verify, or with gloam_verify_proof. It does not show the balance. It does carry the nullifiers of the notes behind it (so the reader can check they are unspent), and a reader who keeps them can tell when those notes are spent later. A cash out moves those notes to a fresh note first, so the proof does not lead to where the money went.",
    };
  }

  /** A proof of a payment this agent sent (by its payment or claim handle), made for one reader. */
  async provePayment(args: { handle: string; for: string; reveal?: boolean; expiresInHours?: number }): Promise<Outcome> {
    const n = this.store.get(args.handle);
    if (!n || (n.origin !== "payment" && n.origin !== "claim")) throw new Error(`There is no payment "${args.handle}".`);
    const asset = this.network.assets.find((a) => a.address.toLowerCase() === n.asset.toLowerCase())!;
    const vault = await this.tree.sync();
    const path = await vault.pathForCommitment(n.commitment);
    if (!path) throw new Error("That payment is not in the vault yet. Wait for it to confirm.");
    const hours = Number.isFinite(args.expiresInHours) && args.expiresInHours! > 0 ? Math.min(args.expiresInHours!, 24 * 90) : 30 * 24;
    const proof = await provePayment({
      artifacts: this.artifacts,
      chainId: this.network.chainId,
      pool: this.network.pool,
      note: { secret: n.secret, amount: BigInt(n.amountWei), asset: n.asset, path },
      txHash: n.createdTx ?? vault.leafInfo(n.commitment)?.tx ?? null,
      reveal: args.reveal ?? true,
      verifier: args.for,
      expiresAt: Math.floor(Date.now() / 1000) + Math.floor(hours * 3600),
    });
    return {
      status: "done",
      action: "prove_payment",
      network: this.network.key,
      proves: `a private payment of ${args.reveal === false ? `at least ${this.fmt(proof.minAmount, asset)}` : this.fmt(n.amountWei, asset)}`,
      for: proof.verifier,
      expiresAt: new Date(proof.expiresAt * 1000).toISOString(),
      proof: encodeProof(proof),
    };
  }

  /** Check a gloamfunds1 or gloampay1 proof against the chain it names (this agent's network). */
  async verifyProof(text: string): Promise<Outcome & { report?: ProofReport }> {
    const p = decodeProof(text);
    if (Number(p.chainId) !== this.network.chainId) {
      return {
        status: "error",
        message: `That proof is for ${networkName(Number(p.chainId))}, and this agent reads ${this.where()}. Check it at gloam.trade/verify.`,
      };
    }
    const report = await verifyHolderProof(p, this.publicClient);
    return {
      status: "done",
      action: "verify",
      ok: report.ok,
      kind: report.kind,
      network: report.network,
      testnet: report.testnet,
      claims: report.claims,
      checks: report.checks,
      expired: report.expired,
    };
  }
}

/** True when an outcome would leak a secret (used by the tests and the GAME wrapper). */
export function outcomeHoldsSecret(o: unknown): boolean {
  return holdsSecret(JSON.stringify(o, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
}
