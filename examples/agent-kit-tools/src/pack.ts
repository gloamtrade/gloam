/**
 * The tool pack: GLOAM_TOOL_DEFINITIONS with handlers, on the GloamAgent engine
 * (@gloamtrade/game-plugin-gloam/engine, built on @gloamtrade/sdk).
 *
 * Every action that moves money or shows something about it is two calls. A
 * gloam_preview_* tool checks the request against the chain and the owner's
 * limits and returns exactly what will happen: amount, asset, network,
 * recipient or tag, fee, and the calls the wallet signs. gloam_execute takes
 * the previewId and does that, with the facts bound in the preview, never
 * fresh input. The kit's wallet sits behind a guard that signs only what the
 * running preview named (./guard.ts).
 *
 * What the engine already gives: note secrets in an encrypted store (a local
 * file by default, or the kit's own backend), owner spending limits checked
 * and reserved before anything is signed, sends whose answer was lost kept
 * and never paid twice, and a redactor every result passes through.
 */
import { createPublicClient, createWalletClient, formatUnits, getAddress, http, isAddress, isAddressEqual, parseUnits, type Address, type Chain, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  GloamAgent,
  outcomeHoldsSecret,
  redact,
  registerSecret,
  resolveNetwork,
  safeErrorMessage,
  walletCallSender,
  type CallSender,
  type ClaimLinkOut,
  type GloamAgentOptions,
  type Outcome,
} from "@gloamtrade/game-plugin-gloam/engine";
import {
  GLOAM_CASHOUT_ASSET,
  GLOAM_CASHOUT_CHAIN_ID,
  GLOAM_CASHOUT_SCHEME,
  GLOAM_CASHOUT_VAULT,
  NATIVE_ASSET,
  assertDepositWithinLiveLimit,
  cashOutFee,
  cashOutTargetProblem,
  cleanPaymentNote,
  encodeRequirements,
  gloamCashoutProblem,
  getGloamNetwork,
  gloamReadTransport,
  isReceiveTag,
  normalizeRequestAmount,
  parsePaymentRequestLink,
  payMemoBoardFor,
  readCashOutFeeBps,
  type GloamAsset,
  type GloamCashoutRequirement,
  type GloamPaymentRequirements,
  type GloamX402SchemeName,
} from "@gloamtrade/sdk";
import { GLOAM_TOOL_DEFINITIONS, type GloamToolDefinition, type GloamToolName } from "./definitions.js";
import { guardedSender, type Expectation, type GuardedSender, type SignHook } from "./guard.js";
import { PreviewBook, type PreviewRecord, type PreviewView, type SignStep } from "./previews.js";
import { ToolInputError, validateInput } from "./validate.js";
import { findGloamOffer, readBody, urlProblem } from "./x402.js";

export type ToolResult = Record<string, unknown> & { status: string };

/** What the pack needs from an engine. GloamAgent is one (engineFor); a test passes a fake. */
export interface GloamEngine {
  readonly network: { key: string; label: string; testnet: boolean; chainId: number; pool: Address; assets: readonly GloamAsset[]; nativeShield: boolean };
  readonly submitMode: "relay" | "wallet";
  readonly walletAddress: Address | null;
  balance(args: { refresh?: boolean }): Promise<Outcome>;
  checkIncoming(): Promise<Outcome>;
  add(args: { amount: string; asset?: string }): Promise<Outcome>;
  pay(args: { to: string; amount?: string; asset?: string; note?: string; label?: string }): Promise<Outcome>;
  payX402(args: { requirements: GloamPaymentRequirements; label?: string }): Promise<Outcome>;
  /** Pay an x402 gloam-cashout quote: a cash out of exactly its amount to its payTo. maxAmount in USDG units. */
  payX402Cashout(args: { requirement: GloamCashoutRequirement; maxAmount: string }): Promise<Outcome>;
  payByClaimLink(args: { amount: string; asset?: string; note?: string; sealTo?: string; label?: string }): Promise<Outcome>;
  cashOut(args: { amount: string; asset?: string; to: string }): Promise<Outcome>;
  proveFunds(args: { atLeast: string; asset?: string; for: string; expiresInHours?: number }): Promise<Outcome>;
  verifyProof(text: string): Promise<Outcome>;
  /** The most one payment can be now, in base units (a payment spends one note). */
  largestPayment(asset: string): bigint;
  /** The vault's cash-out fee now, in basis points. */
  cashOutFeeBps(): Promise<number>;
  /** What the wallet holds of `asset`, or null without a wallet or when it can't be read. */
  walletHolds(asset: GloamAsset): Promise<bigint | null>;
  /** Why the vault would refuse this deposit now (its live deposit limit), or null. */
  depositProblem(asset: GloamAsset, amountWei: bigint): Promise<string | null>;
  /** A claim link this agent made, for owner code only. */
  claimLink?(handle: string): ClaimLinkOut;
}

export interface GloamToolPackOptions extends Omit<GloamAgentOptions, "sender" | "network"> {
  /** Network key: robinhood-mainnet, tempo-mainnet, base-mainnet, ethereum-mainnet, elysium-mainnet (once the SDK has its values), or a testnet. Default GLOAM_NETWORK. */
  network?: string;
  /** The kit's wallet. Default: GLOAM_AGENT_PRIVATE_KEY from env. It is wrapped so it signs only approved previews. */
  sender?: CallSender;
  /** Sees every batch the wallet is about to sign, decoded; return false to refuse it. */
  onSign?: SignHook;
  /** How long a preview can wait for execute. Default 10 minutes. */
  previewTtlMs?: number;
  /** Fetch for x402 requests. Default the global fetch. */
  fetch?: typeof fetch;
  /** Let x402 requests use plain http (local development). Default false: https only. */
  allowHttp?: boolean;
  /** A ready engine instead of a GloamAgent (tests, or a kit with its own). */
  engine?: GloamEngine;
}

export interface GloamTool extends GloamToolDefinition {
  handler(input: unknown): Promise<ToolResult>;
}

export interface GloamToolPack {
  readonly definitions: readonly GloamToolDefinition[];
  readonly tools: readonly GloamTool[];
  /** Validate the input and run the tool. Never throws: errors come back as { status: "error" }. */
  call(name: string, input?: unknown): Promise<ToolResult>;
  /** A preview, as it was shown. */
  preview(previewId: string): PreviewView | null;
  /** A claim link this agent made (a bearer secret: owner code only, never a model). */
  claimLink(handle: string): ClaimLinkOut;
  readonly engine: GloamEngine;
  /** The GloamAgent behind the engine, when the pack made one. */
  readonly agent: GloamAgent | null;
}

/** Wrap a GloamAgent as the engine the pack runs on. */
export function engineFor(agent: GloamAgent): GloamEngine {
  const client = agent.publicClient;
  const net = agent.network;
  return {
    network: net,
    submitMode: agent.submitMode,
    get walletAddress() {
      return agent.walletAddress;
    },
    balance: (a) => agent.balance(a),
    checkIncoming: () => agent.checkIncoming(),
    add: (a) => agent.add(a),
    pay: (a) => agent.pay(a),
    payX402: (a) => agent.payX402(a),
    payX402Cashout: (a) => agent.payX402Cashout(a),
    payByClaimLink: (a) => agent.payByClaimLink(a),
    cashOut: (a) => agent.cashOut(a),
    proveFunds: (a) => agent.proveFunds(a),
    verifyProof: (t) => agent.verifyProof(t),
    largestPayment: (a) => agent.largestPayment(a),
    claimLink: (h) => agent.claimLink(h),
    cashOutFeeBps: () => readCashOutFeeBps(client, net.pool),
    async walletHolds(asset) {
      const who = agent.walletAddress;
      if (!who) return null;
      try {
        if (isAddressEqual(asset.address, NATIVE_ASSET)) return await client.getBalance({ address: who });
        return (await client.readContract({
          address: asset.address,
          abi: [{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "o", type: "address" }], outputs: [{ type: "uint256" }] }],
          functionName: "balanceOf",
          args: [who],
        })) as bigint;
      } catch {
        return null;
      }
    },
    async depositProblem(asset, amountWei) {
      try {
        await assertDepositWithinLiveLimit(client, net.chainId, asset.address, amountWei, net.pool);
        return null;
      } catch (e) {
        return safeErrorMessage(e);
      }
    },
  };
}

/** Plain JSON, redacted, and never a result that would carry a secret. */
function safe(o: Record<string, unknown>): ToolResult {
  const text = redact(JSON.stringify(o, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
  const out = JSON.parse(text) as ToolResult;
  if (outcomeHoldsSecret(out)) return { status: "error", code: "withheld", message: "The result was withheld: it would have carried a secret." };
  return out;
}

const refused = (code: string, message: string, extra: Record<string, unknown> = {}): ToolResult => ({ status: "refused", code, message, ...extra });

export function createGloamToolPack(opts: GloamToolPackOptions = {}): GloamToolPack {
  const env = opts.env ?? process.env;
  let agent: GloamAgent | null = null;
  let guard: GuardedSender | null = null;
  let engine: GloamEngine;
  if (opts.engine) {
    engine = opts.engine;
  } else {
    const key = opts.network?.trim() || env.GLOAM_NETWORK?.trim();
    if (!key) {
      const mainnets = ["robinhood-mainnet", "tempo-mainnet", "base-mainnet", "ethereum-mainnet", ...(getGloamNetwork("elysium-mainnet") ? ["elysium-mainnet"] : [])];
      throw new Error(`Name the network: ${mainnets.slice(0, -1).join(", ")} or ${mainnets[mainnets.length - 1]} (or a testnet), as \`network\` or GLOAM_NETWORK.`);
    }
    const network = resolveNetwork(key, { rpc: opts.rpc || env.GLOAM_RPC_URL, env });
    const chain: Chain = { ...network.chain, rpcUrls: { default: { http: [network.rpc] } } };
    const historyRpc = network.rpc === network.rpcUrl ? network.historyRpc : null;
    const publicClient = opts.publicClient ?? (createPublicClient({ chain, transport: gloamReadTransport({ rpcUrl: network.rpc, historyRpc }) }) as PublicClient);
    let inner = opts.sender ?? null;
    const raw = env.GLOAM_AGENT_PRIVATE_KEY?.trim();
    if (!inner && raw) {
      registerSecret(raw);
      const pk = (raw.startsWith("0x") ? raw : `0x${raw}`) as `0x${string}`;
      if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) throw new Error("GLOAM_AGENT_PRIVATE_KEY is not a 32-byte hex private key.");
      inner = walletCallSender(createWalletClient({ account: privateKeyToAccount(pk), chain, transport: http(network.rpc) }), publicClient);
    }
    guard = inner ? guardedSender(inner, opts.onSign) : null;
    const { onSign: _s, previewTtlMs: _t, fetch: _f, allowHttp: _h, engine: _e, sender: _x, ...agentOpts } = opts;
    agent = new GloamAgent({ ...agentOpts, network: network.key, rpc: network.rpc, publicClient, ...(guard ? { sender: guard } : {}) });
    engine = engineFor(agent);
  }

  const net = engine.network;
  const where = `${net.label} ${net.testnet ? "testnet" : "mainnet"}`;
  const networkView = { key: net.key, name: where, chainId: net.chainId, testnet: net.testnet };
  const board = payMemoBoardFor(net.chainId)?.address ?? null;
  const book = new PreviewBook(opts.previewTtlMs);
  const doFetch = opts.fetch ?? fetch;
  const relay = engine.submitMode === "relay";
  const relayText = "the Gloam relay, which pays the gas (your wallet does not appear next to it)";

  // One action at a time: the guard knows which preview is running, and the note store sees one spender.
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T,>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => undefined);
    return run;
  };
  const within = <T,>(expect: Expectation, ctx: { previewId: string | null; action: string }, fn: () => Promise<T>) =>
    serial(() => (guard ? guard.within(expect, ctx, fn) : fn()));
  const privateSpend: Expectation = { kind: "private", pool: net.pool, board };

  // ---------------------------------------------------------------- input helpers

  const assetOf = (raw?: unknown): GloamAsset => {
    const v = String(raw ?? "").trim().toLowerCase();
    const a = v ? net.assets.find((x) => x.symbol.toLowerCase() === v || x.address.toLowerCase() === v) : net.assets[0];
    if (!a) throw new ToolInputError(`The ${where} vault does not take "${raw}". It takes: ${net.assets.map((x) => x.symbol).join(", ")}.`);
    return a;
  };
  const amountOf = (raw: unknown, a: GloamAsset, what = "amount"): { wei: bigint; text: string } => {
    const s = String(raw ?? "").trim();
    // "2,5" is 2.5 in much of the world and 25 to a parser that drops commas: refused, as the engine does.
    if (s.includes(",")) throw new ToolInputError(`Write the ${what} without commas, with a dot for decimals: 2.5 or 1250.`);
    let norm: string;
    try {
      norm = normalizeRequestAmount(s, a);
    } catch (e) {
      throw new ToolInputError(safeErrorMessage(e));
    }
    if (!norm) throw new ToolInputError(`Say the ${what}, as a number like 25 or 12.5.`);
    return { wei: parseUnits(norm, a.decimals), text: norm };
  };
  const fmt = (wei: bigint, a: Pick<GloamAsset, "decimals" | "symbol">) => `${formatUnits(wei, a.decimals)} ${a.symbol}`;
  const assetView = (a: GloamAsset) => ({ symbol: a.symbol, address: a.address, decimals: a.decimals });
  const coverProblem = (a: GloamAsset, amountWei: bigint): string | null => {
    const largest = engine.largestPayment(a.address);
    return largest >= amountWei
      ? null
      : `No single private note holds ${fmt(amountWei, a)} (the largest holds ${fmt(largest, a)}). A payment spends one note: add privately first, or ask for less.`;
  };
  const spendSigns = (calls: SignStep[]): SignStep[] => (relay ? [] : calls);
  const submittedBy = relay ? relayText : "your wallet (submit is set to wallet)";

  // ---------------------------------------------------------------- previews

  async function previewShield(i: Record<string, unknown>): Promise<ToolResult> {
    const a = assetOf(i.asset);
    const amt = amountOf(i.amount, a);
    const wallet = engine.walletAddress;
    if (!wallet) return refused("no_wallet", "A deposit is signed by the agent's wallet, and there is none. Pass a sender, or set GLOAM_AGENT_PRIVATE_KEY.");
    const native = isAddressEqual(a.address, NATIVE_ASSET);
    if (native && !net.nativeShield) return refused("no_native", `The ${where} vault takes no native deposits.`);
    const holds = await engine.walletHolds(a);
    if (holds !== null && holds < amt.wei) return refused("wallet_short", `The wallet holds ${fmt(holds, a)}, less than the ${fmt(amt.wei, a)} asked.`);
    const limit = await engine.depositProblem(a, amt.wei);
    if (limit) return refused("deposit_limit", limit);
    const view = book.add({
      action: "shield",
      binding: { chainId: net.chainId, pool: net.pool, asset: a.address, amountWei: amt.wei, wallet },
      view: {
        summary: `Add ${fmt(amt.wei, a)} from ${wallet} to the private balance on ${where}.`,
        network: networkView,
        details: { amount: fmt(amt.wei, a), amountBaseUnits: amt.wei.toString(), asset: assetView(a), from: wallet, to: `the Gloam vault ${net.pool}`, fee: "None: deposits are free. The wallet pays the gas." },
        walletSigns: [
          ...(native
            ? []
            : [{ contract: a.address, call: `approve(${net.pool}, ${amt.wei})`, when: "only if the vault's allowance is below the amount (a reset to 0 first where the token needs it)" }]),
          { contract: net.pool, call: `shieldBound(${a.address}, ${amt.wei}, <new note commitment>, <its proof>)${native ? ` with value ${amt.wei}` : ""}` },
        ],
        submittedBy: "your wallet: a deposit starts where the money is",
        public: "The deposit shows the wallet, the asset and the amount. Who can spend the note it makes does not.",
      },
      run: (rec) =>
        within({ kind: "shield", pool: net.pool, asset: a.address, amountWei: amt.wei, native }, { previewId: rec.view.previewId, action: "shield" }, () =>
          engine.add({ amount: amt.text, asset: a.address })
        ),
    });
    return { ...view };
  }

  async function previewPay(i: Record<string, unknown>): Promise<ToolResult> {
    const to = String(i.to);
    let payTo: string;
    let a: GloamAsset;
    let amt: { wei: bigint; text: string };
    let memo = cleanPaymentNote(i.note) || null;
    if (/^https?:\/\//i.test(to)) {
      let req;
      try {
        req = parsePaymentRequestLink(to);
      } catch {
        throw new ToolInputError("That is not a payment request link.");
      }
      if (!req.payTo || !isReceiveTag(req.payTo)) throw new ToolInputError("That payment request has no Gloam address to pay.");
      if (req.networkKey && req.networkKey !== net.key) throw new ToolInputError(`That request is for ${req.networkKey}, and this agent pays on ${net.key}.`);
      payTo = req.payTo;
      a = req.asset ? assetOf(req.asset) : assetOf(i.asset);
      if (i.asset && !isAddressEqual(assetOf(i.asset).address, a.address)) throw new ToolInputError(`The request asks for ${a.symbol}, not ${String(i.asset)}.`);
      if (req.amount) {
        amt = amountOf(req.amount, a);
        if (i.amount && amountOf(i.amount, a).wei !== amt.wei) throw new ToolInputError(`The request asks for ${fmt(amt.wei, a)}. Pay that amount or leave the amount out.`);
      } else {
        amt = amountOf(i.amount, a);
      }
      if (req.note && memo && req.note !== memo) throw new ToolInputError("The request already carries a note. Leave the note out.");
      memo = req.note ?? memo;
    } else if (isReceiveTag(to)) {
      payTo = to;
      a = assetOf(i.asset);
      amt = amountOf(i.amount, a);
    } else {
      throw new ToolInputError("Pay to a Gloam address (gloamr1.…) or a payment request link. For someone without one, use gloam_preview_claim_link.");
    }
    const short = coverProblem(a, amt.wei);
    if (short) return refused("no_note_covers", short);
    const label = (i.label as string | undefined) ?? undefined;
    const view = book.add({
      action: "pay",
      binding: { chainId: net.chainId, pool: net.pool, payTo, asset: a.address, amountWei: amt.wei, memo, label: label ?? null },
      view: {
        summary: `Pay ${fmt(amt.wei, a)} privately to ${payTo.slice(0, 18)}… on ${where}.`,
        network: networkView,
        details: {
          amount: fmt(amt.wei, a),
          amountBaseUnits: amt.wei.toString(),
          asset: assetView(a),
          to: payTo,
          note: memo,
          ...(label ? { label } : {}),
          from: "one private note that covers the amount; the rest comes back as a new note",
          fee: "None: private payments are free.",
          delivery: board ? "Sealed to the payee's Gloam address and posted on the network's payment board, where only their key opens it." : "Sealed to the payee's Gloam address; the result carries the sealed code to hand over.",
        },
        walletSigns: spendSigns([
          { contract: net.pool, call: "transfer(<proof>, <root>, <nullifier>, [<payment note>, <change note>])" },
          ...(board ? [{ contract: board, call: "postMemo(<payment note>, <sealed message>)" }] : []),
        ]),
        submittedBy,
        public: "The chain shows a shielded transfer. Not the amount, the sender or the payee.",
      },
      run: (rec) =>
        within(privateSpend, { previewId: rec.view.previewId, action: "pay" }, () =>
          engine.pay({ to: payTo, amount: amt.text, asset: a.address, ...(memo ? { note: memo } : {}), ...(label ? { label } : {}) })
        ),
    });
    return { ...view };
  }

  async function previewClaimLink(i: Record<string, unknown>): Promise<ToolResult> {
    const a = assetOf(i.asset);
    const amt = amountOf(i.amount, a);
    const memo = cleanPaymentNote(i.note) || null;
    const sealTo = (i.sealTo as string | undefined) ?? null;
    if (sealTo && !isReceiveTag(sealTo)) throw new ToolInputError("sealTo must be a Gloam address (gloamr1.…).");
    const short = coverProblem(a, amt.wei);
    if (short) return refused("no_note_covers", short);
    const label = (i.label as string | undefined) ?? undefined;
    const delivery = sealTo
      ? `Sealed to ${sealTo}: only that key opens it.`
      : opts.onClaimLink
        ? "Handed to your onClaimLink handler (owner code), never to the model."
        : "Kept in the encrypted note store. Your code reads it with pack.claimLink(claimHandle); it never comes back to the model.";
    const view = book.add({
      action: "claim_link",
      binding: { chainId: net.chainId, pool: net.pool, asset: a.address, amountWei: amt.wei, memo, sealTo, label: label ?? null },
      view: {
        summary: `Put ${fmt(amt.wei, a)} in a claim link on ${where}.`,
        network: networkView,
        details: {
          amount: fmt(amt.wei, a),
          amountBaseUnits: amt.wei.toString(),
          asset: assetView(a),
          to: sealTo ? `a claim link sealed to ${sealTo}` : "a claim link: whoever holds it can claim",
          note: memo,
          ...(label ? { label } : {}),
          fee: "None: private payments are free.",
          delivery,
          takeBack: "A link nobody claimed can be taken back.",
        },
        walletSigns: spendSigns([{ contract: net.pool, call: "transfer(<proof>, <root>, <nullifier>, [<claim note>, <change note>])" }]),
        submittedBy,
        public: "The chain shows a shielded transfer. The link is a bearer secret: whoever holds it can claim.",
      },
      run: (rec) =>
        within(privateSpend, { previewId: rec.view.previewId, action: "claim_link" }, () =>
          engine.payByClaimLink({ amount: amt.text, asset: a.address, ...(memo ? { note: memo } : {}), ...(sealTo ? { sealTo } : {}), ...(label ? { label } : {}) })
        ),
    });
    return { ...view };
  }

  async function previewCashOut(i: Record<string, unknown>): Promise<ToolResult> {
    const a = assetOf(i.asset);
    const amt = amountOf(i.amount, a);
    const to = String(i.to);
    if (!isAddress(to)) throw new ToolInputError("Cash out to a 0x address.");
    const lost = cashOutTargetProblem(to as Address, { chainId: net.chainId, pool: net.pool });
    if (lost) return refused("lost_recipient", lost);
    const short = coverProblem(a, amt.wei);
    if (short) return refused("no_note_covers", short);
    const bps = await engine.cashOutFeeBps();
    const fee = cashOutFee(amt.wei, bps);
    const view = book.add({
      action: "cash_out",
      binding: { chainId: net.chainId, pool: net.pool, asset: a.address, amountWei: amt.wei, to: to.toLowerCase(), feeBps: bps },
      view: {
        summary: `Cash out ${fmt(amt.wei, a)} to ${to} on ${where}: ${fmt(amt.wei - fee, a)} arrives after the ${bps / 100}% fee.`,
        network: networkView,
        details: {
          amount: fmt(amt.wei, a),
          amountBaseUnits: amt.wei.toString(),
          asset: assetView(a),
          to,
          fee: { bps, percent: `${bps / 100}%`, amount: fmt(fee, a), note: "Kept by the vault when the cash out lands." },
          receives: fmt(amt.wei - fee, a),
          steps: "If no single note holds exactly this amount, a private split to this agent goes first (free), then the cash out.",
        },
        walletSigns: spendSigns([
          { contract: net.pool, call: "transfer(<proof>, <root>, <nullifier>, [<exact note>, <change note>])", when: "only when a split is needed" },
          { contract: net.pool, call: `unshield(<proof>, <root>, <nullifier>, ${a.address}, ${to}, ${amt.wei})` },
        ]),
        submittedBy,
        public: "A cash out is the public exit: the asset, the amount and the recipient show. Which private payment funded it does not.",
      },
      recheck: async () => {
        const now = await engine.cashOutFeeBps();
        return now === bps ? null : `The vault's cash-out fee changed from ${bps / 100}% to ${now / 100}% since the preview. Make a new preview.`;
      },
      run: (rec) =>
        within(
          { kind: "private", pool: net.pool, board, cashOut: { asset: a.address, to: to as Address, amountWei: amt.wei } },
          { previewId: rec.view.previewId, action: "cash_out" },
          () => engine.cashOut({ amount: amt.text, asset: a.address, to })
        ),
    });
    return { ...view };
  }

  async function previewProveFunds(i: Record<string, unknown>): Promise<ToolResult> {
    const a = assetOf(i.asset);
    const amt = amountOf(i.atLeast, a, "atLeast");
    const reader = String(i.for);
    const hours = typeof i.expiresInHours === "number" ? i.expiresInHours : 168;
    const view = book.add({
      action: "prove_funds",
      binding: { chainId: net.chainId, pool: net.pool, asset: a.address, thresholdWei: amt.wei, for: reader, expiresInHours: hours },
      view: {
        summary: `Prove this agent holds at least ${fmt(amt.wei, a)} privately on ${where}, for "${reader}", valid ${hours} hours.`,
        network: networkView,
        details: {
          proves: `holds at least ${fmt(amt.wei, a)} privately`,
          asset: assetView(a),
          for: reader,
          validForHours: hours,
          shows: "Not the balance and not which notes back it.",
          carries: "The nullifiers of the notes behind it (up to four), so the reader can check they are unspent. A reader who keeps them can tell when those notes are spent later; a cash out moves those notes to a fresh note first, so the proof does not lead to where the money went.",
          fee: "None.",
        },
        walletSigns: [],
        submittedBy: "nothing is sent: the proof is made on this machine",
        public: "Nothing goes on chain.",
      },
      run: (rec) =>
        within({ kind: "none" }, { previewId: rec.view.previewId, action: "prove_funds" }, () =>
          engine.proveFunds({ atLeast: amt.text, asset: a.address, for: reader, expiresInHours: hours })
        ),
    });
    return { ...view };
  }

  /** The x402 request a preview made, and how it presents a payment on the retry. */
  type X402Request = {
    url: string;
    method: "GET" | "POST";
    body: string | undefined;
    contentType: string | undefined;
    send: (extra?: Record<string, string>) => Promise<Response>;
  };

  /**
   * Present a payment header on the retry and read what comes back. Paid but not served is kept as
   * paid_not_served, so gloam_execute presents the same payment again and never pays twice.
   */
  async function presentPayment(req: X402Request, header: string, paid: Outcome | null, show: { header: boolean }): Promise<ToolResult> {
    const shown = show.header ? { paymentHeader: header } : {};
    let second: Response;
    try {
      second = await req.send({ "x-payment": header });
    } catch (e) {
      return {
        ...(paid ?? {}),
        status: "paid_not_served",
        message: `Paid, but the retry failed (${safeErrorMessage(e)}). Call gloam_execute again with the same previewId: it presents this payment again and never pays twice.`,
        ...shown,
      };
    }
    const served = await readBody(second);
    if (!second.ok) {
      return {
        ...(paid ?? {}),
        status: "paid_not_served",
        message: "Paid, but the seller did not serve the resource yet (it may still be securing the payment). Call gloam_execute again with the same previewId to present it again; it is never paid twice.",
        ...shown,
        ...served,
      };
    }
    return { ...(paid ?? {}), status: "ok", paid: true, ...served, paymentResponse: second.headers.get("x-payment-response") ?? second.headers.get("payment-response") };
  }

  async function previewPayX402(i: Record<string, unknown>): Promise<ToolResult> {
    const url = String(i.url);
    const bad = urlProblem(url, Boolean(opts.allowHttp));
    if (bad) throw new ToolInputError(bad);
    const method = (i.method as "GET" | "POST" | undefined) ?? "GET";
    const body = method === "POST" ? ((i.body as string | undefined) ?? undefined) : undefined;
    const contentType = (i.contentType as string | undefined) ?? (body !== undefined ? "application/json" : undefined);
    const request = (extra: Record<string, string> = {}) =>
      doFetch(url, {
        method,
        headers: { ...(contentType ? { "content-type": contentType } : {}), ...extra },
        body,
        // A payment never follows a redirect: the paid retry would go somewhere the price did not come from.
        redirect: "manual",
        signal: AbortSignal.timeout(30_000),
      });
    let first: Response;
    try {
      first = await request();
    } catch (e) {
      return { status: "error", message: `The request failed: ${safeErrorMessage(e)}` };
    }
    if (first.status >= 300 && first.status < 400) {
      return refused("redirect", `The resource redirects (${first.status}). Nothing was paid: call the URL it redirects to directly, if you trust it.`, { location: first.headers.get("location") });
    }
    if (first.status !== 402) return { status: first.ok ? "not_payment_required" : "http_error", paid: false, ...(await readBody(first)) };
    const found = findGloamOffer(first.headers, await first.text(), i.prefer as GloamX402SchemeName | undefined);
    if (!found.ok) return refused("no_gloam_price", found.reason, { offered: found.offered });
    const x402: X402Request = { url, method, body, contentType, send: request };
    if (found.scheme === GLOAM_CASHOUT_SCHEME) return previewPayX402Cashout(i, found.cashout, found.offered, x402);
    const req = found.requirements;
    if (Number(req.network) !== net.chainId) return refused("wrong_network", `The Gloam price is on chain ${req.network}, and this agent pays on ${where}.`);
    if (!req.poolAddress || !isAddressEqual(req.poolAddress, net.pool)) return refused("wrong_vault", "The Gloam price settles through a different vault.");
    if (!isReceiveTag(String(req.payTo))) return refused("bad_payee", "The Gloam price's payTo is not a Gloam address.");
    const a = net.assets.find((x) => isAddressEqual(x.address, req.asset));
    if (!a) return refused("unlisted_asset", `The ${where} vault does not take ${req.asset}.`);
    if (!/^[0-9]+$/.test(String(req.maxAmountRequired)) || BigInt(req.maxAmountRequired) <= 0n) return refused("bad_price", "The price is not a whole, positive number of base units.");
    const price = BigInt(req.maxAmountRequired);
    if (i.maxAmount !== undefined && price > amountOf(i.maxAmount, a, "maxAmount").wei) {
      return refused("over_max_amount", `The resource asks ${fmt(price, a)}, more than your maxAmount of ${String(i.maxAmount)} ${a.symbol}. Not paying.`);
    }
    const short = coverProblem(a, price);
    if (short) return refused("no_note_covers", short);
    const label = (i.label as string | undefined) ?? undefined;
    const encoded = encodeRequirements(req);
    const view = book.add({
      action: "pay_x402",
      binding: { chainId: net.chainId, pool: net.pool, requirements: encoded, url, method, body: body ?? null, contentType: contentType ?? null, label: label ?? null },
      view: {
        summary: `Pay ${fmt(price, a)} privately for ${req.resource} on ${where}, then fetch it.`,
        network: networkView,
        details: {
          amount: fmt(price, a),
          amountBaseUnits: price.toString(),
          asset: assetView(a),
          to: req.payTo,
          resource: req.resource,
          url,
          method,
          scheme: req.scheme,
          fee: "None: private payments are free.",
          delivery: "The payment is sealed to the seller's Gloam address and sent as the X-PAYMENT header on the retry. Only the seller's key opens it.",
          ...(found.offered.length ? { alsoOffered: found.offered } : {}),
        },
        walletSigns: spendSigns([{ contract: net.pool, call: "transfer(<proof>, <root>, <nullifier>, [<payment note>, <change note>])" }]),
        submittedBy,
        public: "The chain shows a shielded transfer. Not the amount, the buyer or the seller.",
      },
      scratch: {},
      rerun: (last) => last.status === "paid_not_served" || last.status === "unconfirmed",
      run: async (rec) => {
        let header = rec.scratch.header as string | undefined;
        let paid: Outcome | null = null;
        if (!header) {
          paid = await within(privateSpend, { previewId: rec.view.previewId, action: "pay_x402" }, () =>
            engine.payX402({ requirements: req, ...(label ? { label } : {}) })
          );
          if (typeof paid.paymentHeader === "string") rec.scratch.header = header = paid.paymentHeader;
          if (paid.status !== "done" || !header) return paid;
        }
        return presentPayment(x402, header, paid, { header: true });
      },
    });
    return { ...view };
  }

  /**
   * x402 scheme gloam-cashout: the price is a cash out of exactly its amount (G, the price plus the
   * vault's fee and a per-quote tag) from the private balance to the resource's public payout address.
   * The payee and the amount are public, as for any payer. The agent's wallet (through the relay) and
   * its private balance are not. The quote's id is kept out of every result: it travels only in the
   * X-PAYMENT header, to the resource.
   */
  async function previewPayX402Cashout(i: Record<string, unknown>, quote: GloamCashoutRequirement, offered: string[], x402: X402Request): Promise<ToolResult> {
    if (net.chainId !== GLOAM_CASHOUT_CHAIN_ID || !isAddressEqual(net.pool, GLOAM_CASHOUT_VAULT)) {
      return refused("wrong_network", `This price is a ${GLOAM_CASHOUT_SCHEME} cash out on Robinhood Chain mainnet, and this agent pays on ${where}.`);
    }
    const a = net.assets.find((x) => isAddressEqual(x.address, GLOAM_CASHOUT_ASSET));
    if (!a) return refused("unlisted_asset", `The ${where} vault does not take USDG.`);
    if (i.maxAmount === undefined) {
      return refused("no_max_amount", `This resource asks for a ${GLOAM_CASHOUT_SCHEME} payment of ${/^[0-9]{1,40}$/.test(quote.amount) ? fmt(BigInt(quote.amount), a) : "an unreadable amount"}. Say maxAmount, the most to cash out for it. Nothing was paid.`);
    }
    const max = amountOf(i.maxAmount, a, "maxAmount");
    const problem = gloamCashoutProblem(quote, { maxAmount: max.wei });
    if (problem) return refused(problem.code, problem.code === "over_max_amount" ? `The resource asks ${fmt(BigInt(quote.amount), a)}, more than your maxAmount of ${max.text} ${a.symbol}. Not paying.` : problem.message);
    const gross = BigInt(quote.amount);
    const payTo = getAddress(quote.payTo);
    const short = coverProblem(a, gross);
    if (short) return refused("no_note_covers", short);
    const bps = await engine.cashOutFeeBps();
    const fee = cashOutFee(gross, bps);
    const resource = quote.resource ?? x402.url;
    const expired = () => quote.expiresAt !== undefined && Math.floor(Date.now() / 1000) >= quote.expiresAt;
    const view = book.add({
      action: "pay_x402_cashout",
      binding: {
        chainId: net.chainId,
        pool: net.pool,
        scheme: GLOAM_CASHOUT_SCHEME,
        asset: a.address,
        amountWei: gross,
        payTo: payTo.toLowerCase(),
        quoteId: quote.quoteId,
        maxAmountWei: max.wei,
        feeBps: bps,
        url: x402.url,
        method: x402.method,
        body: x402.body ?? null,
        contentType: x402.contentType ?? null,
      },
      view: {
        summary: `Pay ${fmt(gross, a)} for ${resource} by a cash out to its public payout address ${payTo} on ${where}: ${fmt(gross - fee, a)} arrives after the vault's ${bps / 100}% fee. Then fetch it.`,
        network: networkView,
        details: {
          scheme: GLOAM_CASHOUT_SCHEME,
          to: payTo,
          toIs: "the resource's public payout address (its splitter). It is public, as it is for every payer.",
          amount: fmt(gross, a),
          amountBaseUnits: gross.toString(),
          asset: assetView(a),
          fee: { bps, percent: `${bps / 100}%`, amount: fmt(fee, a), note: "Kept by the vault when the cash out lands." },
          payeeReceives: fmt(gross - fee, a),
          maxAmount: fmt(max.wei, a),
          resource,
          url: x402.url,
          method: x402.method,
          ...(quote.expiresAt !== undefined ? { quoteExpires: new Date(quote.expiresAt * 1000).toISOString() } : {}),
          steps: "If no single note holds exactly this amount, a private split to this agent goes first (free), then the cash out.",
          delivery: "The retry carries X-PAYMENT: the cash out's tx hash and the resource's own quote id. Nothing private.",
          staysPrivate: relay
            ? "This agent's wallet and its private balance. The Gloam relay sends the cash out, and nothing on chain links it to the agent's deposits or other payments."
            : "This agent's private balance. Submit is set to wallet, so the agent's wallet signs the cash out and shows as its sender.",
          ...(offered.length ? { alsoOffered: offered } : {}),
        },
        walletSigns: spendSigns([
          { contract: net.pool, call: "transfer(<proof>, <root>, <nullifier>, [<exact note>, <change note>])", when: "only when a split is needed" },
          { contract: net.pool, call: `unshield(<proof>, <root>, <nullifier>, ${a.address}, ${payTo}, ${gross})` },
        ]),
        submittedBy,
        public: `The cash out itself is public: the chain shows ${fmt(gross, a)} of USDG leaving the Gloam vault to ${payTo}, and its transaction.`,
      },
      recheck: async () => {
        if (expired()) return "The quote expired since the preview. Make a new preview.";
        const now = await engine.cashOutFeeBps();
        return now === bps ? null : `The vault's cash-out fee changed from ${bps / 100}% to ${now / 100}% since the preview. Make a new preview.`;
      },
      scratch: {},
      rerun: (last) => last.status === "paid_not_served" || last.status === "unconfirmed",
      run: async (rec) => {
        let header = rec.scratch.header as string | undefined;
        let paid: Outcome | null = null;
        if (!header) {
          const out = await within(
            { kind: "private", pool: net.pool, board, cashOut: { asset: a.address, to: payTo, amountWei: gross } },
            { previewId: rec.view.previewId, action: "pay_x402_cashout" },
            () => engine.payX402Cashout({ requirement: quote, maxAmount: max.text })
          );
          // The header carries the resource's quote id: it goes to the resource, never back to the model.
          const { paymentHeader, ...rest } = out;
          paid = rest as Outcome;
          if (typeof paymentHeader === "string") rec.scratch.header = header = paymentHeader;
          if (paid.status !== "done" || !header) return paid;
        }
        return presentPayment(x402, header, paid, { header: false });
      },
    });
    return { ...view };
  }

  // ---------------------------------------------------------------- execute

  async function execute(i: Record<string, unknown>): Promise<ToolResult> {
    const id = String(i.previewId);
    const rec: PreviewRecord | undefined = book.get(id);
    if (!rec) return refused("unknown_preview", `There is no preview "${id}" here: it expired, or this process restarted since. Nothing was signed for it. Make a new preview.`);
    if (i.digest !== undefined && i.digest !== rec.view.digest) return refused("digest_mismatch", "That digest is not this preview's. Nothing was run: approve the preview you mean to run.");
    if (rec.state === "running") return refused("in_progress", "This preview is running now. Wait for its result.");
    if (rec.state === "done" && !(rec.rerun && rec.result && rec.rerun(rec.result))) {
      return { ...rec.result!, previewId: id, repeated: true, message: "This preview already ran. This is its result; nothing was done again." };
    }
    if (rec.state === "ready" && Date.now() > rec.expiresAtMs) return refused("preview_expired", "This preview expired before it was executed. Nothing was signed for it. Make a new preview.");
    if (rec.recheck && rec.state === "ready") {
      const why = await rec.recheck().catch((e: unknown) => `It could not be checked again (${safeErrorMessage(e)}).`);
      if (why) return refused("changed", why);
    }
    rec.state = "running";
    let result: ToolResult;
    try {
      result = safe(await rec.run(rec));
    } catch (e) {
      result = { status: "error", message: safeErrorMessage(e) };
    }
    // An error or refusal sent nothing (the engine says unconfirmed when a send may have gone out): the approved preview can run again.
    rec.state = result.status === "error" || result.status === "refused" ? "ready" : "done";
    rec.result = result;
    return { ...result, previewId: id };
  }

  // ---------------------------------------------------------------- tools

  const handlers: Record<GloamToolName, (i: Record<string, unknown>) => Promise<ToolResult>> = {
    gloam_balance: (i) => within(privateSpend, { previewId: null, action: "refresh" }, () => engine.balance({ refresh: i.refresh === true })),
    gloam_receive: () => within(privateSpend, { previewId: null, action: "receive" }, () => engine.checkIncoming()),
    gloam_preview_shield: previewShield,
    gloam_preview_pay: previewPay,
    gloam_preview_claim_link: previewClaimLink,
    gloam_preview_cash_out: previewCashOut,
    gloam_preview_prove_funds: previewProveFunds,
    gloam_preview_pay_x402: previewPayX402,
    gloam_execute: execute,
    gloam_verify_proof: (i) => engine.verifyProof(String(i.proof)),
  };

  async function call(name: string, input?: unknown): Promise<ToolResult> {
    const def = GLOAM_TOOL_DEFINITIONS.find((d) => d.name === name);
    if (!def) return { status: "error", code: "unknown_tool", message: `There is no Gloam tool "${name}".` };
    try {
      return safe(await handlers[def.name as GloamToolName](validateInput(def, input)));
    } catch (e) {
      if (e instanceof ToolInputError) return { status: "error", code: e.code, message: e.message };
      return { status: "error", message: safeErrorMessage(e) };
    }
  }

  return {
    definitions: GLOAM_TOOL_DEFINITIONS,
    tools: GLOAM_TOOL_DEFINITIONS.map((d) => ({ ...d, handler: (input: unknown) => call(d.name, input) })),
    call,
    preview: (id) => book.get(id)?.view ?? null,
    claimLink(handle) {
      if (!engine.claimLink) throw new Error("This engine keeps no claim links.");
      return engine.claimLink(handle);
    },
    engine,
    agent,
  };
}
