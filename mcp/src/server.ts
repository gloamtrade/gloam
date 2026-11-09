/**
 * The Gloam MCP tools.
 *
 * Gives an AI agent private payment tools across Gloam's networks: Robinhood
 * Chain and Tempo, each on mainnet (the ceremony's final keys, deposit
 * limits, payments only) and testnet (dev keys). Tools take
 * a `network` (default: GLOAM_NETWORK, else Robinhood Chain testnet), and the
 * 402 payment tools settle on whatever network the price names. Private swaps
 * (src/swaps.ts) run where the network has a swap router: who swapped stays
 * private, the tokens and amounts are public. The old sealed trade is retired.
 *
 * This exposes read + planning tools that work today, and returns honest
 * "intent" objects for write actions (shield / pay / send) when there is no
 * signer. It never fakes a private fill or settlement.
 *
 * Every tool that moves money (shield, public send, private pay, private swap) first passes
 * the owner's spending limits (src/policy.ts, src/spendGuard.ts): allowed
 * tools, assets, recipients, a cap per payment and per rolling day, and an
 * expiry. No limits configured means no spending. The limits are enforced here,
 * off-chain, not by the vault contract.
 *
 * The payment tools speak two 402 dialects with the same private settlement:
 * x402 (scheme gloam-private, X-PAYMENT header) and MPP, the Machine Payments
 * Protocol (WWW-Authenticate: Payment, method "gloam", intent "charge"; see
 * src/mpp.ts and docs/mpp/draft-gloam-charge-00.md).
 *
 * Note secrets never reach the agent. Notes live in an encrypted store inside
 * this server (src/noteStore.ts); tools hand out and take back short handles.
 * Payments are sealed to the payee's receive tag, and a payee settles a
 * received payment by sweeping it into a fresh note before granting access.
 * GLOAM_EXPOSE_NOTE_SECRETS=1 brings back the old secret-passing behavior; it is
 * unsafe and off by default.
 */

import { createHash, randomBytes } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { TransactionNotFoundError, formatUnits, isAddress, parseEther, parseUnits, type Address, type Hex, type PublicClient } from "viem";
import {
  approveNeedsReset,
  buildShieldBoundIntent,
  artifactProver,
  proveGroth16,
  NATIVE_ASSET,
  buildGloamPaymentRequirements,
  buildGloamPayment,
  verifyGloamPayment,
  verifyPaymentNoteBinding,
  checkGloamPaymentBinding,
  noteFieldProblem,
  encodeRequirements,
  decodeRequirements,
  encodePaymentHeader,
  decodePaymentHeader,
  openGloamPaymentNote,
  sweepReceivedNote,
  generateReceiveKey,
  isReceiveTag,
  isSealedTicket,
  syncTree,
  noteCommitmentPoseidon,
  noteNullifierPoseidon,
  fieldToHex,
  hexToField,
  transferCallArgs,
  POOL_TRANSFER_ABI,
  POOL_STATE_ABI,
  GLOAM_NOT_FINAL,
  GLOAM_VS_ZONE,
  GLOAM_RELAY_URL,
  GLOAM_X402_SCHEME,
  GLOAM_CASHOUT_SCHEME,
  chooseGloamX402Scheme,
  findGloamCashoutRequirement,
  relayIntent,
  relaySwapCall,
  relayStatus as readRelayStatus,
  GloamRelayError,
  assertDepositAllowed,
  assertDepositWithinLiveLimit,
  type GloamIntent,
  type GloamPaymentPayload,
  type GloamPaymentRequirements,
  type NoteExport,
  type Prover,
  type ReceiptProver,
  type RelayNetworkStatus,
  type RelayOptions,
  type SwapRelayCall,
  type SweepChain,
} from "@gloamtrade/sdk";
import { CHAIN, PRIVACY_STATUS } from "./data.js";
import { getPublicClient, getSigner, signerSetup, type Signer } from "./signer.js";
import { checkAccessKey } from "./accessKey.js";
import { packageVersion } from "./version.js";
import { receiptArtifacts, shieldArtifacts, transferArtifacts, unshieldArtifacts } from "./artifacts.js";
import { SWAP_PRIVACY, refreshSwapNotes, registerSwapTools, type SwapToolContext } from "./swaps.js";
import { payGloamCashoutQuote } from "./x402Cashout.js";
import {
  allNetworks,
  defaultNetworkKey,
  describeNetwork,
  networkByKey,
  networkByChainId,
  tempoAccessNetwork,
  MCP_MAINNETS,
  MCP_NETWORKS,
  NETWORK_KEYS,
  type McpNetwork,
} from "./networks.js";
import { KNOWN_ASSETS, assetLabel, type Spend } from "./policy.js";
import { assetDecimals, authorizeSpend, limitsReport, previewSpend, settleSpend, spendingReport } from "./spendGuard.js";
import {
  balances,
  deadCheckDue,
  heldMessage,
  isHeld,
  noteView,
  openNoteStore,
  servedPayment,
  type NoteStore,
  type PaymentClaim,
  type PaymentSendState,
  type StoredNote,
} from "./noteStore.js";
import { guardedFetch } from "./safeFetch.js";
import { WalletSendUnclear, walletSend } from "./walletSend.js";
import { checkBeforePay } from "./wormholeGuard.js";
import { checkVeyaBudget } from "./veyaGuard.js";
import { plannedReceipt, settleReceiptInTime, settleReceiptLater, type ReceiptContext, type ReceiptOutcome } from "./veyaReceipt.js";
import {
  allowedModes,
  credentialField,
  credentialFromPayment,
  fromPaymentRequirements,
  isExpired,
  parseGloamChargePayload,
  parseGloamChargeRequest,
  parseReceipt,
  payerTransferIntent,
  serializeReceipt,
  termsMismatch,
  validateGloamCharge,
  verifyChallengeId,
  GloamChargeError,
  type GloamChargePayload,
  type GloamChargeReceipt,
  type GloamChargeRequest,
  type PaymentChallenge,
  type ValidatedGloamCharge,
} from "@gloamtrade/mppx-gloam/core";
import {
  cannotPay,
  gloamChallenges,
  looksLikeMpp,
  mppChain,
  mppChallengeFor,
  mppSecret,
  parseMppChallenge,
  parseMppCredential,
  requirementsFromChallenge,
  MPP_DEFAULT_EXPIRES_SECONDS,
} from "./mpp.js";

type Env = Record<string, string | undefined>;
type ChainClient = Signer["publicClient"];

/** Everything the tools touch outside this file, injectable for tests. */
export interface ServerDeps {
  /** Read at call time (limits, relay, keys), except GLOAM_EXPOSE_NOTE_SECRETS, read once at startup. */
  env: Env;
  signer(net: McpNetwork): Signer | null;
  publicClient(net: McpNetwork): ChainClient;
  /** The prover for `net`'s key set: dev keys on testnet, the ceremony's final keys on mainnet. */
  shieldProver(net?: McpNetwork): Promise<Prover>;
  transferProver(net?: McpNetwork): Promise<Prover>;
  receiptProver(net?: McpNetwork): Promise<ReceiptProver>;
  /** The unshield prover for `net`'s key set: a private swap's note leaves the vault by an unshield to its escrow. */
  unshieldProver(net?: McpNetwork): Promise<Prover>;
  syncTree: typeof syncTree;
  relay(intent: GloamIntent, opts: RelayOptions): Promise<Hex>;
  /** A private swap, its refund or its exit, through the relay. */
  relaySwap(call: SwapRelayCall, opts: RelayOptions): Promise<Hex>;
  /** The relay's state per network (whether it is on, gas over its ceiling). */
  relayStatus(opts: RelayOptions): Promise<RelayNetworkStatus[]>;
  fetch: typeof fetch;
  /** Hears about each VEYA receipt left to finish after a payment's answer, by the payment's note (tests, embedders). */
  receiptWork?(note: string, work: Promise<ReceiptOutcome>): void;
}

function defaultDeps(env: Env): ServerDeps {
  return {
    env,
    signer: (net) => getSigner(net, env),
    publicClient: (net) => getPublicClient(net),
    shieldProver: async (net) => artifactProver(await shieldArtifacts(net?.ceremony ?? "dev")),
    transferProver: async (net) => artifactProver(await transferArtifacts(net?.ceremony ?? "dev")),
    receiptProver: async (net) => {
      const { wasm, zkey } = await receiptArtifacts(net?.ceremony ?? "dev");
      return (input) => proveGroth16(input, wasm, zkey);
    },
    unshieldProver: async (net) => artifactProver(await unshieldArtifacts(net?.ceremony ?? "dev")),
    syncTree,
    relay: relayIntent,
    relaySwap: relaySwapCall,
    relayStatus: readRelayStatus,
    fetch: guardedFetch(env),
  };
}

const erc20Abi = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ type: "uint256" }],
  },
] as const;

const shieldPoolAbi = [
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

function text(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text:
          typeof value === "string"
            ? value
            : JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2),
      },
    ],
  };
}

/**
 * What the chain shows of a private payment. Without the relay this server's
 * wallet is the transaction's sender, so it is public that it paid someone.
 */
const settlementNote = (viaRelay: boolean) =>
  viaRelay
    ? "The public feed shows a shielded transfer sent by the Gloam relay, never the amount or the parties. Only the payee can open the payment note."
    : "This server's wallet signs and sends it, so the public feed shows a shielded transfer from that wallet, never the amount or the payee. Only the payee can open the payment note. Set GLOAM_USE_RELAY=1 to keep the wallet out of it.";

/** A viem error's short message: its full one holds the RPC URL, API key included, and the calldata. */
const errMsg = (e: unknown) => {
  const short = (e as { shortMessage?: unknown } | null)?.shortMessage;
  return typeof short === "string" ? short : e instanceof Error ? e.message : String(e);
};

function parseRequirements(input: string): GloamPaymentRequirements | null {
  try {
    return decodeRequirements(input);
  } catch {
    try {
      return JSON.parse(input) as GloamPaymentRequirements;
    } catch {
      return null;
    }
  }
}

function parsePayment(input: string): GloamPaymentPayload | null {
  try {
    return decodePaymentHeader(input);
  } catch {
    try {
      return JSON.parse(input) as GloamPaymentPayload;
    } catch {
      return null;
    }
  }
}

/**
 * A price from either 402 dialect: x402 requirements (encoded or JSON) or an
 * MPP gloam challenge (a WWW-Authenticate `Payment …` value). An MPP challenge
 * comes back with its x402-equivalent requirements, so the spend gate and the
 * payment builder treat both the same.
 */
function parsePriced(input: string): { req: GloamPaymentRequirements; mpp: PaymentChallenge | null } | { error: string } {
  if (looksLikeMpp(input)) {
    const ch = parseMppChallenge(input);
    if (!ch) return { error: "That is a Payment challenge, but not a gloam/charge one this server can pay." };
    try {
      return { req: requirementsFromChallenge(ch).req, mpp: ch };
    } catch (e) {
      return { error: errMsg(e) };
    }
  }
  const req = parseRequirements(input);
  return req ? { req, mpp: null } : { error: "Could not parse requirements." };
}

function assetInfo(chainId: number, asset: Address, fallbackDecimals = 18) {
  const known = KNOWN_ASSETS.find((a) => a.chainId === chainId && a.address.toLowerCase() === asset.toLowerCase());
  return { symbol: known?.symbol ?? assetLabel(chainId, asset), decimals: known?.decimals ?? fallbackDecimals };
}

/** A spend reservation with no transaction after this long was never sent (a crash between reserve and broadcast). */
const STUCK_MS = 10 * 60 * 1000;

/** A payment whose sweeps never land is swept again this many times ten minutes apart; after that, only after RESWEEP_WAIT_MS, doubling each time. */
const MAX_RESWEEPS = 3;
const RESWEEP_WAIT_MS = 60 * 60 * 1000;

/** Relay answers that do not prove the transaction stayed unsent: the node may have taken it before the error. */
const RELAY_MAYBE_SENT = ["maybe_sent", "rpc", "network", "error", "internal", "in_flight"];

/**
 * Whether a send that threw may still have put the transaction on chain.
 * Through the relay only a refusal it names (limits, screening, a failed dry
 * run) is sure; a lost connection or an unclear answer is not. From the wallet,
 * a send that reached the RPC without a clear refusal may land too
 * (WalletSendUnclear).
 */
function mayHaveSent(err: unknown, viaRelay: boolean): boolean {
  if (!viaRelay) return err instanceof WalletSendUnclear;
  return !(err instanceof GloamRelayError) || RELAY_MAYBE_SENT.includes(err.code);
}

const shortTag = (t: string) => (t.length > 30 ? `${t.slice(0, 18)}…${t.slice(-6)}` : t);

const AGENT_WALLET_NOTE =
  "This build does not sign or broadcast. Connect an agent wallet with signing (e.g. Turnkey embedded wallet + policy) to execute this intent. Returned as a plan an agent or human can approve.";

const NO_SIGNER =
  "No signer configured. Set GLOAM_AGENT_PRIVATE_KEY to execute. For limits the protocol enforces on Tempo, make the agent a Tempo access key: npx -y @gloamtrade/mcp authorize-access-key --owner <account> --generate";

const LEGACY_WARNING =
  "GLOAM_EXPOSE_NOTE_SECRETS=1 is set: note secrets are passed to and from the agent. Anyone who reads a secret can spend that money, and spending limits cannot stop that. Turn it off unless you are migrating old notes.";

/** Build a Gloam MCP server. Pass deps to test it without a chain. */
/** "Robinhood Chain, Tempo, Base and Ethereum", plus Elysium once the SDK has its values. */
function mainnetChainNames(): string {
  const names = ["Robinhood Chain", "Tempo", "Base", "Ethereum", ...(MCP_MAINNETS.some((n) => n.family === "elysium") ? ["Elysium"] : [])];
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** ", 20 and 1,000 for ETH on Base and Ethereum" for the chains in this build that list ETH. */
function ethNativeLimitText(): string {
  const chains = [...new Set(allNetworks().filter((n) => n.family === "base" || n.family === "ethereum").map((n) => (n.family === "base" ? "Base" : "Ethereum")))];
  return chains.length ? `, 20 and 1,000 for ETH on ${chains.join(" and ")}` : "";
}

export function createGloamServer(overrides: Partial<ServerDeps> = {}): McpServer {
  const deps: ServerDeps = { ...defaultDeps(overrides.env ?? process.env), ...overrides };
  const env = deps.env;
  /** The network a tool uses when the agent names none. Throws at startup on a GLOAM_NETWORK this build lacks. */
  const defaultNet = defaultNetworkKey(env);
  // "robinhood" and "tempo", plus "base" and "ethereum" once Base Sepolia and Ethereum Sepolia have their pools.
  const testnets = allNetworks().filter((n) => n.testnet).map((n) => `"${n.key}"`);
  const testnetKeys = `${testnets.slice(0, -1).join(", ")} and ${testnets[testnets.length - 1]}`;
  const networkArg = (what: string) =>
    z
      .enum(NETWORK_KEYS)
      .default(defaultNet)
      .describe(
        `${what} ${NETWORK_KEYS.map((k) => `"${k}"`).join(", ")}. The -mainnet ones are the mainnets (deposit limits); ${testnetKeys} are the testnets. Default here: "${defaultNet}".`
      );
  /** Old behavior: secrets in tool results and arguments. Read once; restart to change. */
  const legacy = env.GLOAM_EXPOSE_NOTE_SECRETS?.trim() === "1";
  const server = new McpServer({ name: "gloam", version: packageVersion() });

  const relayUrl = () =>
    env.GLOAM_RELAY_URL?.trim() || (env.GLOAM_USE_RELAY?.trim() === "1" ? GLOAM_RELAY_URL : "");

  /** Never throws: a broken store must not hide that money already moved. */
  const tryStore = (fn: () => void): string | undefined => {
    try {
      fn();
      return undefined;
    } catch (e) {
      return `Could not update the note store: ${errMsg(e)}`;
    }
  };

  function openStore(): { ok: true; store: NoteStore } | { ok: false; error: string } {
    try {
      const store = openNoteStore(env);
      store.read(); // fail now, before anything is reserved or signed
      return { ok: true, store };
    } catch (e) {
      return { ok: false, error: errMsg(e) };
    }
  }

  /** What the chain says about a transaction this server sent. */
  function txReads(client: ChainClient) {
    return {
      /** Its receipt says it reverted. */
      reverted: async (hash: Hex | null | undefined) =>
        !!hash && (await client.getTransactionReceipt({ hash }).then((r) => r.status === "reverted", () => false)),
      /** The node has never heard of it (a send whose reply was lost, that never got there). A read error is not that. */
      unknown: async (hash: Hex) =>
        typeof client.getTransaction === "function" &&
        (await client.getTransaction({ hash }).then(
          () => false,
          (e: unknown) => e instanceof TransactionNotFoundError
        )),
    };
  }

  function sweepChain(client: ChainClient, net: McpNetwork): SweepChain {
    // the RPC's own chain id, asked once: a sweep or payment check for another chain is refused
    // (the vault and ETH have one address on every chain, so its reads would look right)
    let id: Promise<number> | null = null;
    const chainId =
      typeof client.getChainId === "function"
        ? () =>
            (id ??= client.getChainId().catch((e: unknown) => {
              id = null;
              throw e;
            }))
        : undefined;
    return {
      ...(chainId ? { chainId } : {}),
      isSpent: (nullifier) =>
        client.readContract({ address: net.pool, abi: POOL_STATE_ABI, functionName: "isSpent", args: [nullifier] }),
      isCommitmentSeen: (commitment) =>
        client.readContract({ address: net.pool, abi: POOL_STATE_ABI, functionName: "commitmentSeen", args: [commitment] }),
      pathForCommitment: async (commitment) =>
        (await deps.syncTree(client, { pool: net.pool, fromBlock: net.deployBlock })).pathForCommitment(commitment),
      waitForReceipt: async (hash) => ({ status: (await client.waitForTransactionReceipt({ hash })).status }),
    };
  }

  server.registerTool(
    "gloam_info",
    {
      title: "About Gloam",
      description:
        "What Gloam is, which networks it runs on, and what an agent can do with it. Call this first.",
    },
    async () =>
      text({
        what: `Gloam is private stablecoin payments for people and AI agents on ${mainnetChainNames()}. Hold a private balance, pay and get paid without putting amounts or counterparties on the public chain, and prove one fact to one reader when needed.`,
        whyAgentsCareMost:
          "Agents pay for tools and data all day. On a public chain every payment shows who it pays, how much and how often, which leaks the agent's whole strategy. Gloam keeps those payments private.",
        networks: allNetworks().map((n) => ({
          key: n.key,
          network: describeNetwork(n),
          chainId: n.chainId,
          pool: n.pool,
          keys: n.ceremony === "production" ? "the trusted setup's final keys" : "dev keys",
        })),
        defaultNetwork: defaultNet,
        mainnet:
          `Mainnet is live. Private payments on every mainnet, and private swaps where the network has a swap router (gloam_swap_quote says), with deposit limits of 50,000 per deposit and 2,500,000 in total for each stablecoin (2,500,000 and 25,000,000 for GLOAM${
            ethNativeLimitText()
          }). Direct deposits and private payments are free; cashing out costs 0.5%. Reviewed internally before launch; Kann Audits reviewed the vault contracts (report, 1 November 2026: gloam.trade/security) and found no Critical, High or Medium issues. The swap routers, circuits, app, relay, this server and the SDK were not part of that review.`,
        tools: [
          "gloam_privacy_status: honest privacy posture, what is public vs private (read)",
          "gloam_swap_quote: price a private swap of one note's value, with everything that would stop it (read)",
          "gloam_execute_private_swap: REAL private swap. Proves locally and sends through the Gloam relay; who swapped stays private, the tokens and amounts are public (execution; \"swap\" must be in the agent's limits)",
          "gloam_finish_swap: settle a swap whose money waits at its escrow: the refund, or an exit to an address you name (execution)",
          "gloam_plan_shield: describe a shield before executing (planning)",
          "gloam_execute_shield: REAL private deposit. Mints a note, proves, and broadcasts shieldBound; returns a note handle (execution; needs a signer)",
          "gloam_execute_transfer: sign and broadcast a public transfer of test ETH on Robinhood Chain testnet, for funding (execution; needs a signer)",
          "gloam_list_notes: this server's private notes as handles, and the private balance per asset (read; with refresh it also moves a note a reverted swap left held)",
          "gloam_receive_tag: this server's receive tag, for others to pay it privately (read)",
          "gloam_payment_requirements: price an agent resource in a private payment, as x402 requirements and an MPP challenge (server side)",
          "gloam_pay_x402: plan the private payment for a 402 challenge, x402 or MPP (agent side)",
          "gloam_execute_private_pay: REAL private settlement from a note handle: sync, prove, broadcast transfer; returns the X-PAYMENT header, or the Authorization credential for an MPP challenge (execution; needs a signer)",
          "gloam_fetch_paid: fetch a URL and, if it answers 402 with a Gloam price (x402, or MPP method gloam), pay privately and retry, all inside this server (execution; needs a signer). x402 gloam-cashout (a public payee on Robinhood Chain) is paid with a cash out through the relay, the payer kept private",
          "gloam_verify_payment: open a presented payment (x402 X-PAYMENT or MPP Authorization: Payment), verify it, and sweep it into a fresh note; grant access only when it says so (server side)",
          "gloam_get_limits: this agent's spending limits (read)",
          "gloam_get_spending_report: spent and remaining in the last 24 hours, recent payments and refusals (read)",
        ],
        notes: legacy
          ? LEGACY_WARNING
          : "Note secrets stay inside this server, encrypted. Tools give the agent handles (like n-k3x9p2qw7m) and amounts, never a secret.",
        spendingLimits:
          "Every execute tool that moves money checks the owner's limits first (tools, assets, recipients, per payment, per day, expiry) and logs the spend. The MCP server enforces them, off-chain; the vault contract does not.",
        privateSwaps: `${SWAP_PRIVACY} A swap spends one whole note; both notes it makes are kept here before it is sent.`,
        privatePayments:
          "Agent payments over HTTP 402 (x402, or MPP with the gloam method) settle privately through the Gloam pool, sealed to the payee's receive tag. The payee sweeps each payment into a fresh note before serving, so a payer cannot take it back. Unlike a Tempo Zone, there is no operator that sees the transaction.",
      })
  );

  server.registerTool(
    "gloam_privacy_status",
    {
      title: "Privacy status",
      description:
        "Honest, current privacy posture: what is live, what is not, and how strong the anonymity set is. Agents should check this before assuming what a payment or a swap keeps private.",
    },
    async () => text(PRIVACY_STATUS)
  );

  // Private swaps: quote, execute and finish (src/swaps.ts). They replace the retired sealed-trade tools.
  const swapCtx: SwapToolContext = {
    env,
    text,
    networkArg,
    openStore,
    tryStore,
    errMsg,
    client: (net) => (deps.signer(net)?.publicClient ?? deps.publicClient(net)) as unknown as PublicClient,
    shieldProver: (net) => deps.shieldProver(net),
    unshieldProver: (net) => deps.unshieldProver(net),
    transferProver: (net) => deps.transferProver(net),
    syncTree: deps.syncTree,
    relay: (intent, opts) => deps.relay(intent, opts),
    relaySwap: (call, opts) => deps.relaySwap(call, opts),
    relayStatus: (opts) => deps.relayStatus(opts),
  };
  registerSwapTools(server, swapCtx);

  server.registerTool(
    "gloam_plan_shield",
    {
      title: "Plan a shield (deposit to private)",
      description:
        "Describe moving funds into a private balance (shield), the first step before paying privately. To actually shield, use gloam_execute_shield.",
      inputSchema: {
        asset: z.string().default("ETH").describe("Asset to shield, e.g. USDG, USDC.e, or ETH on testnet."),
        usd: z.number().positive().describe("Amount to shield, in USD."),
        agentAddress: z.string().optional(),
      },
    },
    async ({ asset, usd, agentAddress }) =>
      text({
        intent: "shield",
        chainId: CHAIN.chainId,
        asset: asset.toUpperCase(),
        usd,
        agentAddress: agentAddress ?? null,
        result: "Funds enter a private balance. The public chain loses the trail.",
        execution: AGENT_WALLET_NOTE,
      })
  );

  server.registerTool(
    "gloam_execute_shield",
    {
      title: "Execute a private shield",
      description:
        "Deposit into a PRIVATE balance on the chosen Gloam network. Mints a note, generates the Groth16 shield proof server-side with that network's keys, and broadcasts shieldBound() (approving the ERC-20 first when the asset is a token). A mainnet vault takes only the assets it lists (this tool names them if given another), within the deposit limits it reads from the vault; direct deposits are free. The note's secret stays inside this server; the agent gets a note handle to pay from later (gloam_execute_private_pay, gloam_list_notes). Requires GLOAM_AGENT_PRIVATE_KEY; without it, returns a plan.",
      inputSchema: {
        amount: z
          .number()
          .positive()
          .describe("Amount to shield into a private balance, in the asset's units (e.g. 25 for 25 USDC.e)."),
        network: networkArg("Which network to shield on:"),
        asset: z
          .string()
          .optional()
          .describe(
            "ERC-20 token address to shield; omit to use the network default (USDG on Robinhood Chain mainnet, USDC.e on Tempo mainnet, USDC on Base and Ethereum, PathUSD on Tempo testnet, native ETH on Robinhood Chain testnet). On Base and Ethereum, the zero address shields ETH."
          ),
        decimals: z
          .number()
          .int()
          .optional()
          .describe("Decimals of the asset; omit to use the asset's own (6 for the stablecoins, 18 for GLOAM and ETH)."),
      },
    },
    async ({ amount, network, asset, decimals }) => {
      if (asset !== undefined && !isAddress(asset)) {
        return text({ status: "error", error: `"${asset}" is not a valid token address.` });
      }
      const net = networkByKey(network);
      const assetAddr = (asset as Address | undefined) ?? net.defaultAsset;
      const dec = decimals ?? (asset ? assetInfo(net.chainId, assetAddr).decimals : net.defaultAssetDecimals);
      const amountWei = parseUnits(String(amount), dec);
      const isNative = assetAddr.toLowerCase() === NATIVE_ASSET.toLowerCase();
      // Mainnet pools list their assets and cap each deposit: say so before anything is reserved or signed.
      // The caps are read live from the vault (they change through its timelock); a vault that can't be read refuses nothing here.
      try {
        assertDepositAllowed(net.chainId, assetAddr, amountWei);
        await assertDepositWithinLiveLimit(deps.publicClient(net), net.chainId, assetAddr, amountWei, net.pool);
      } catch (e) {
        return text({ status: "error", network: net.key, error: errMsg(e) });
      }
      const spend: Spend = {
        tool: "shield",
        network: net.key,
        chainId: net.chainId,
        asset: assetAddr,
        amountWei,
        recipient: null,
      };
      const signer = deps.signer(net);
      if (!signer) {
        return text({
          status: "no_signer",
          plan: { action: "shield", amount, asset: assetAddr, network: net.key, realMoney: !net.testnet, chainId: net.chainId, pool: net.pool },
          limits: previewSpend(spend, env),
          message: NO_SIGNER,
        });
      }
      // The note must have somewhere safe to live before any money moves.
      const opened = openStore();
      if (!opened.ok) return text({ status: "error", error: opened.error });
      const notes = opened.store;
      const gate = authorizeSpend(spend, env);
      if (!gate.ok) return text(gate.refusal);
      let hash: Hex | undefined;
      let held: StoredNote | undefined;
      try {
        const intent = await buildShieldBoundIntent({
          amountWei,
          asset: assetAddr,
          chainId: net.chainId,
          poolAddress: net.pool,
          prover: await deps.shieldProver(net),
        });
        // Keep the note before anything is broadcast, so a crash mid-flight cannot lose it.
        held = notes.add({
          network: net.key,
          chainId: net.chainId,
          pool: net.pool,
          asset: assetAddr,
          symbol: assetInfo(net.chainId, assetAddr, dec).symbol,
          decimals: dec,
          amountWei: amountWei.toString(),
          secret: intent.note.secret,
          commitment: intent.note.commitment,
          nullifier: intent.note.nullifier,
          status: "pending",
          pending: "create",
          origin: "shield",
          createdTx: null,
        });
        // ERC-20 shields (every mainnet asset, PathUSD on Tempo testnet) approve
        // the pool to pull the tokens before shieldBound; native shields carry value instead.
        let approveHash: Hex | undefined;
        if (!isNative) {
          // USDT on Ethereum refuses to change one non-zero allowance into another:
          // a stale one (a shield that never went through) goes to 0 first.
          if (approveNeedsReset(net.chainId, assetAddr)) {
            const allowance = await signer.publicClient.readContract({
              address: assetAddr,
              abi: erc20Abi,
              functionName: "allowance",
              args: [signer.account.address, net.pool],
            });
            if (allowance > 0n) {
              const resetHash = await signer.walletClient.writeContract({
                address: assetAddr,
                abi: erc20Abi,
                functionName: "approve",
                args: [net.pool, 0n],
              });
              const reset = await signer.publicClient.waitForTransactionReceipt({ hash: resetHash });
              if (reset.status !== "success") throw new Error(`Clearing the old approval reverted (${resetHash}). Nothing moved.`);
            }
          }
          approveHash = await signer.walletClient.writeContract({
            address: assetAddr,
            abi: erc20Abi,
            functionName: "approve",
            args: [net.pool, amountWei],
          });
          await signer.publicClient.waitForTransactionReceipt({ hash: approveHash });
        }
        hash = await walletSend(signer, (wallet) =>
          wallet.writeContract({
            address: intent.exec.poolAddress,
            abi: shieldPoolAbi,
            functionName: "shieldBound",
            args: intent.exec.args as readonly [Address, bigint, Hex, Hex],
            value: intent.exec.valueWei,
          })
        );
        const sentHash = hash;
        const storeWarning = tryStore(() => notes.update(held!.handle, { createdTx: sentHash }));
        const receipt = await signer.publicClient.waitForTransactionReceipt({ hash });
        if (receipt.status !== "success") {
          settleSpend(gate, "reverted", { hash });
          tryStore(() => notes.remove(held!.handle));
          return text({ status: "error", error: `Shield reverted (${hash}). Nothing moved.`, hash });
        }
        const logWarning = settleSpend(gate, "sent", { hash });
        let stored: StoredNote = { ...held, status: "unspent", createdTx: hash };
        const confirmWarning = tryStore(() => {
          stored = notes.update(held!.handle, { status: "unspent", createdTx: sentHash }) ?? stored;
        });
        const noteWarning = storeWarning ?? confirmWarning;
        return text({
          status: "confirmed",
          ...(logWarning ? { logWarning } : {}),
          ...(noteWarning ? { noteWarning } : {}),
          network: net.key,
          approveHash,
          hash,
          from: signer.account.address,
          explorer: `${net.explorer}/tx/${hash}`,
          note: legacy
            ? { ...noteView(stored), secret: intent.note.secret, commitment: intent.note.commitment, decimals: dec }
            : noteView(stored),
          ...(legacy
            ? { warning: LEGACY_WARNING }
            : { keep: "Pay from this balance with gloam_execute_private_pay (by note handle, or let the server pick). The secret stays in this server." }),
          privacy:
            "The deposit amount is public. The note hides who can spend it, so future private sends are unlinkable to this deposit.",
        });
      } catch (err) {
        const error = errMsg(err);
        // shieldBound went to the RPC and its reply was lost: the deposit may land, so the note is its only key.
        if (!hash && err instanceof WalletSendUnclear) {
          hash = err.hash;
          const sentHash = hash;
          tryStore(() => notes.update(held!.handle, { createdTx: sentHash }));
        }
        settleSpend(gate, hash ? "unconfirmed" : "failed", { hash, reason: error });
        // Nothing broadcast: forget the note. Broadcast: keep it pending, it may still land.
        if (held && !hash) tryStore(() => notes.remove(held!.handle));
        return text({
          status: "error",
          error,
          ...(hash ? { hash, note: held ? { handle: held.handle, status: "pending" } : undefined, check: "Call gloam_list_notes with refresh to see whether it landed." } : {}),
        });
      }
    }
  );

  server.registerTool(
    "gloam_execute_transfer",
    {
      title: "Execute a transfer (public)",
      description:
        "Send test ETH publicly on Robinhood Chain TESTNET from the agent wallet, for funding while practicing. This is the PUBLIC rail (amount and recipient are visible) and testnet only. For private movement, use gloam_execute_shield and gloam_execute_private_pay. Requires GLOAM_AGENT_PRIVATE_KEY; without it, returns a plan only.",
      inputSchema: {
        to: z.string().describe("Recipient 0x address."),
        eth: z.number().positive().describe("Amount of testnet ETH to send."),
      },
    },
    async ({ to, eth }) => {
      if (!isAddress(to)) {
        return text({ status: "error", error: `"${to}" is not a valid address.` });
      }
      const spend: Spend = {
        tool: "send",
        network: "robinhood",
        chainId: CHAIN.chainId,
        asset: NATIVE_ASSET,
        amountWei: parseEther(String(eth)),
        recipient: to,
      };
      const signer = deps.signer(MCP_NETWORKS.robinhood);
      if (!signer) {
        return text({
          status: "no_signer",
          plan: { action: "transfer", to, eth, chainId: CHAIN.chainId },
          limits: previewSpend(spend, env),
          message: NO_SIGNER,
        });
      }
      const gate = authorizeSpend(spend, env);
      if (!gate.ok) return text(gate.refusal);
      try {
        const hash = await walletSend(signer, (wallet) => wallet.sendTransaction({ to: to as Address, value: spend.amountWei }));
        const logWarning = settleSpend(gate, "sent", { hash });
        return text({
          status: "submitted",
          ...(logWarning ? { logWarning } : {}),
          hash,
          from: signer.account.address,
          explorer: `${CHAIN.explorer}/tx/${hash}`,
        });
      } catch (err) {
        const error = errMsg(err);
        if (err instanceof WalletSendUnclear) {
          // It may have gone out: it counts against the limit, and the agent looks before sending again.
          settleSpend(gate, "unconfirmed", { hash: err.hash, reason: error });
          return text({
            status: "error",
            error,
            hash: err.hash,
            explorer: `${CHAIN.explorer}/tx/${err.hash}`,
            check: "It may have been sent and may still land. Look the hash up before sending again.",
          });
        }
        settleSpend(gate, "failed", { reason: error });
        return text({ status: "error", error });
      }
    }
  );

  // ── notes ───────────────────────────────────────────────────────────────────

  server.registerTool(
    "gloam_list_notes",
    {
      title: "Private notes and balance",
      description:
        "This server's private notes as handles, with network, asset, amount, status (unspent, pending, spent, dead when its transaction can never land, or held when its last swap reverted and it must move to a fresh note before anything spends it) and the transaction that created each one, plus the spendable private balance per asset. Never shows a secret. Pass refresh to check pending notes against the chain.",
      inputSchema: {
        network: z.enum(NETWORK_KEYS).optional().describe("Only this network."),
        includeSpent: z.boolean().default(false).describe("Also list spent and dead notes."),
        refresh: z
          .boolean()
          .default(false)
          .describe("Check pending notes on chain first (read-only calls), and move each held note to a fresh note of this server's (a private send through the relay)."),
      },
    },
    async ({ network, includeSpent, refresh }) => {
      const opened = openStore();
      if (!opened.ok) return text({ status: "error", error: opened.error });
      const notes = opened.store;
      const refreshed: string[] = [];
      if (refresh) {
        // A swap's two notes settle together, from how the swap ended, and a note a reverted swap
        // left held moves to a fresh note (src/swaps.ts).
        refreshed.push(...(await refreshSwapNotes(swapCtx, notes)));
        // Pending notes and notes made spendable again whose old spend may have landed since; then dead ones (in
        // case a read was wrong) when a look is due, or all of them once this pass sees a late send land.
        const swapOpen = (x: StoredNote) =>
          (x.origin === "swap" || x.origin === "swap_refund") && (x.status === "dead" || (x.status === "pending" && x.pending === "create"));
        const listed = notes.list().filter((x) => !swapOpen(x));
        let woke = false;
        for (const n of [
          ...listed.filter((x) => x.status === "pending" || (x.status === "unspent" && x.recheck)),
          ...listed.filter((x) => x.status === "dead"),
        ]) {
          if (n.status === "dead" && !woke && !deadCheckDue(n)) continue;
          const net = networkByChainId(n.chainId);
          if (!net) continue;
          try {
            const client = deps.signer(net)?.publicClient ?? deps.publicClient(net);
            const chain = sweepChain(client, net);
            const tx = txReads(client);
            const stuck = Date.now() - Date.parse(n.updatedAt) > STUCK_MS;
            if (n.status === "unspent") {
              if (await chain.isSpent(n.nullifier)) {
                notes.update(n.handle, { status: "spent", recheck: false });
                refreshed.push(`${n.handle}: spent, an earlier send of it landed`);
                // The change and payment that send made may be dead notes now: look at them all.
                notes.wakeDead();
                woke = true;
              }
            } else if (n.pending === "spend") {
              if (await chain.isSpent(n.nullifier)) {
                notes.update(n.handle, { status: "spent", recheck: false });
                refreshed.push(`${n.handle}: spent`);
                // A copy of its send may have landed after a read of another copy said reverted: look at the dead notes.
                notes.wakeDead();
                woke = true;
              } else if (n.spentTx ? (await tx.reverted(n.spentTx)) || (stuck && (await tx.unknown(n.spentTx))) : stuck) {
                // Never spent on chain, and its spend reverted or never showed up: spendable again.
                // (If a copy is still in flight it will revert: the nullifier spends once. The
                // change and payment it would make stay pending, so nothing is lost if it lands,
                // and the note is checked again on every refresh in case it did.)
                notes.update(n.handle, { status: "unspent", spentTx: null, recheck: true });
                refreshed.push(`${n.handle}: spendable again`);
              }
            } else if (await chain.isCommitmentSeen(n.commitment)) {
              // A payment this server sent is the payee's once it lands, never this server's balance.
              // (A dead note that shows up after all comes back here too.)
              const sent = n.origin === "payment";
              notes.update(n.handle, { status: sent ? "spent" : "unspent" });
              refreshed.push(`${n.handle}: ${sent ? "payment landed" : "confirmed"}`);
            } else if (n.status === "dead") {
              // Still not on chain: it stays dead, secret kept, and is looked at again later.
              const now = new Date(Date.now()).toISOString(); // the clock deadCheckDue reads
              notes.update(n.handle, { checkedAt: now, ...(n.deadAt ? {} : { deadAt: now }) });
            } else if (await tx.reverted(n.createdTx)) {
              // Its creating transaction reverted. Through the relay that may be a resend whose first copy
              // landed, read here by a node behind, so the note is marked dead, never deleted.
              notes.markDead(n.handle);
              refreshed.push(`${n.handle}: dead, its transaction reverted`);
            } else if (
              n.origin === "received" &&
              n.sweptFrom &&
              stuck &&
              (!n.createdTx || (await tx.unknown(n.createdTx))) &&
              (await chain.isSpent(n.sweptFrom)) &&
              !(await chain.isCommitmentSeen(n.commitment))
            ) {
              // Its sweep never showed up, and the payment it was to take is spent by another
              // transaction (a later sweep of it, or the payer): this note can never exist. Those
              // reads may come from nodes at different heights, so it is marked dead, never deleted.
              notes.markDead(n.handle);
              refreshed.push(`${n.handle}: dead, its payment was taken by another transaction`);
            } else if (
              (n.origin === "change" || n.origin === "payment") &&
              n.createdTx &&
              stuck &&
              !notes.list().some((x) => x.status === "pending" && x.pending === "spend" && x.spentTx?.toLowerCase() === n.createdTx!.toLowerCase()) &&
              (await tx.unknown(n.createdTx))
            ) {
              // The send that makes this change or payment never showed up, and its input no longer waits on it
              // (made spendable again, or spent by another transaction): it can never land.
              notes.markDead(n.handle);
              refreshed.push(`${n.handle}: dead, its transaction never landed`);
            }
          } catch (e) {
            refreshed.push(`${n.handle}: could not check (${errMsg(e)})`);
          }
        }
      }
      const all = notes.list().filter((n) => !network || n.network === network);
      return text({
        balances: balances(all),
        notes: all.filter((n) => includeSpent || (n.status !== "spent" && n.status !== "dead")).map(noteView),
        ...(refresh ? { refreshed } : {}),
        ...(legacy ? { warning: LEGACY_WARNING } : {}),
        secrets: "Kept encrypted inside this server. Pay with a handle; nobody needs the secret.",
      });
    }
  );

  async function ownReceiveKey(notes: NoteStore) {
    return notes.receiveKey() ?? notes.keepReceiveKey(await generateReceiveKey());
  }

  server.registerTool(
    "gloam_receive_tag",
    {
      title: "This server's receive tag",
      description:
        "The receive tag (gloamr1.…) others pay this server to. Payments sealed to it open only with the key this server keeps. Created on first use. Share it freely: it is a public key, not a secret.",
    },
    async () => {
      const opened = openStore();
      if (!opened.ok) return text({ status: "error", error: opened.error });
      try {
        const key = await ownReceiveKey(opened.store);
        return text({ tag: key.tag, use: "Put this in payTo (gloam_payment_requirements does it for you when payTo is left out)." });
      } catch (e) {
        return text({ status: "error", error: errMsg(e) });
      }
    }
  );

  // ── x402 private agent payments ─────────────────────────────────────────────

  server.registerTool(
    "gloam_payment_requirements",
    {
      title: "Price a resource in private payments (x402 and MPP)",
      description:
        "SERVER side. Build the HTTP 402 price an agent-paid resource returns, settled privately through Gloam: the amount and the payee never go public, and through the relay neither does the payer's wallet. Returns it in both dialects: x402 requirements (and their encoded form), and an MPP challenge (mpp.wwwAuthenticate, the WWW-Authenticate: Payment value for method gloam, intent charge). payTo defaults to this server's own receive tag. Check what the payer presents with gloam_verify_payment.",
      inputSchema: {
        amount: z.number().positive().describe("Price in the asset's display units, e.g. 0.25."),
        decimals: z
          .number()
          .int()
          .min(0)
          .max(36)
          .optional()
          .describe("Decimals of the settlement asset; omit for the asset's own (6 for the stablecoins)."),
        assetSymbol: z.string().optional().describe("Asset label, e.g. USDC.e; omit for the asset's own symbol."),
        asset: z
          .string()
          .optional()
          .describe(
            "Settlement token address; omit for the network default (USDG on Robinhood Chain mainnet, USDC.e on Tempo mainnet, USDC on Base and Ethereum, PathUSD on Tempo testnet, ETH on Robinhood Chain testnet)."
          ),
        payTo: z
          .string()
          .optional()
          .describe("Payee receive tag (gloamr1.…). Omit to be paid to this server's own tag, which gloam_verify_payment can open."),
        resource: z.string().describe("What is being paid for: a URL or an MCP tool id."),
        network: networkArg("Which Gloam network the payer settles on:"),
        realm: z
          .string()
          .optional()
          .describe("MPP protection space for the challenge. Default: the resource URL's host."),
        expiresInSeconds: z
          .number()
          .int()
          .min(60)
          .max(86_400)
          .default(MPP_DEFAULT_EXPIRES_SECONDS)
          .describe("How long the MPP challenge stays valid. Leave room to prove and confirm a payment."),
      },
    },
    async ({ amount, decimals, assetSymbol, asset, payTo, resource, network, realm, expiresInSeconds }) => {
      if (asset !== undefined && !isAddress(asset)) {
        return text({ status: "error", error: `"${asset}" is not a valid token address.` });
      }
      let tag = payTo?.trim();
      if (!tag) {
        const opened = openStore();
        if (!opened.ok) return text({ status: "error", error: `payTo was left out and this server's receive tag is unavailable: ${opened.error}` });
        try {
          tag = (await ownReceiveKey(opened.store)).tag;
        } catch (e) {
          return text({ status: "error", error: errMsg(e) });
        }
      }
      const net = networkByKey(network);
      const settleAsset = (asset as Address | undefined) ?? net.defaultAsset;
      const known = assetInfo(net.chainId, settleAsset, net.defaultAssetDecimals);
      try {
        const req = buildGloamPaymentRequirements({
          amountWei: parseUnits(String(amount), decimals ?? known.decimals),
          asset: settleAsset,
          assetSymbol: assetSymbol ?? known.symbol,
          payTo: tag,
          resource,
          network: net.chainId,
          poolAddress: net.pool,
        });
        // The same price as an MPP challenge. It needs this server's challenge key (MPP_SECRET_KEY, or the note store key).
        let mpp: Record<string, unknown>;
        try {
          const issued = await mppChallengeFor(req, { env, realm, decimals: decimals ?? known.decimals, expiresInSeconds });
          mpp = {
            wwwAuthenticate: issued.wwwAuthenticate,
            challengeId: issued.challenge.id,
            realm: issued.challenge.realm,
            expires: issued.challenge.expires,
            request: issued.challenge.request,
            httpHint:
              "Return HTTP 402 with the header WWW-Authenticate set to wwwAuthenticate and Cache-Control: no-store. The agent retries with Authorization: Payment <credential>; pass that value to gloam_verify_payment as payment, with this resource's price (wwwAuthenticate, or the encoded requirements) as requirements, and serve only when it says grantAccess, with its paymentReceipt as the Payment-Receipt header.",
          };
        } catch (e) {
          mpp = { error: `No MPP challenge: ${errMsg(e)}` };
        }
        return text({
          network: describeNetwork(net),
          requirements: req,
          encoded: encodeRequirements(req),
          httpHint:
            "Return HTTP 402 with this requirements object; the agent retries with an X-PAYMENT header. Check it with gloam_verify_payment and serve only when it says grantAccess.",
          mpp,
          notVsZone: GLOAM_VS_ZONE.oneLine,
        });
      } catch (e) {
        return text({ status: "error", error: errMsg(e) });
      }
    }
  );

  server.registerTool(
    "gloam_pay_x402",
    {
      title: "Plan a private payment for a 402 challenge",
      description:
        "AGENT side. Given a Gloam 402 price (x402 requirements, or an MPP WWW-Authenticate: Payment challenge with method gloam), describe the private payment the agent would make: a self-custodial private send of the required amount to the payee, sealed to the payee's receive tag, broadcast by this server (no operator or facilitator holds its key). Plans only; to pay, call gloam_execute_private_pay, or gloam_fetch_paid to do the whole request.",
      inputSchema: {
        requirements: z
          .string()
          .describe("Encoded requirements from gloam_payment_requirements (or the raw JSON), or an MPP challenge (the WWW-Authenticate value)."),
        note: z.string().optional().describe("Handle of the note to pay from (gloam_list_notes), if you want a specific one."),
      },
    },
    async ({ requirements, note }) => {
      const priced = parsePriced(requirements);
      if ("error" in priced) return text({ status: "error", error: priced.error });
      const { req, mpp } = priced;
      const netForReq = networkByChainId(Number(req.network));
      const tagOk = isReceiveTag(String(req.payTo ?? ""));
      const guardsBeforePay = [
        ...(env.GLOAM_WORMHOLE_KEY?.trim() ? ["Agent Wormhole checks this payment request first (GLOAM_WORMHOLE_KEY). Only an allow pays."] : []),
        ...(env.GLOAM_VEYA_KEY?.trim()
          ? ["VEYA checks this payment against the agent's budget (GLOAM_VEYA_KEY) and sees the agent id, chain, asset, amount and payee, and nothing about the resource. Only an allow pays."]
          : []),
        ...(env.GLOAM_VEYA_KEY?.trim() && env.GLOAM_VEYA_ANCHOR_URL?.trim()
          ? ["Once it lands, this server proves the payment and sends VEYA only the receipt's leaf and the agent id (GLOAM_VEYA_ANCHOR_URL), after the payment's answer, which never waits on it."]
          : []),
      ];
      return text({
        status: "plan",
        intent: "private_pay_x402",
        protocol: mpp ? "mpp" : "x402",
        ...(mpp ? { mpp: { method: mpp.method, intent: mpp.intent, realm: mpp.realm, expires: mpp.expires ?? null, payable: cannotPay(mpp, parseGloamChargeRequest(mpp.request)) ?? "yes" } } : {}),
        network: req.network,
        pay: {
          amountWei: req.maxAmountRequired,
          asset: req.asset,
          assetSymbol: req.assetSymbol,
          payTo: req.payTo,
          pool: req.poolAddress,
        },
        payTo: tagOk
          ? "A receive tag: the payment note will be sealed so only the payee can open it."
          : legacy
            ? "Not a receive tag. With GLOAM_EXPOSE_NOTE_SECRETS=1 the note would go in the header unsealed, readable by anyone who sees it."
            : "Not a receive tag, so this payment would be refused. Ask the payee for its gloamr1. tag.",
        poolStatus: netForReq
          ? `Live: pool ${netForReq.pool} on ${describeNetwork(netForReq)}, chain ${netForReq.chainId}.${
              String(req.poolAddress).toLowerCase() === netForReq.pool.toLowerCase() ? "" : ` These requirements name ${req.poolAddress} instead, so this server will refuse to pay.`
            }`
          : `Chain ${req.network} is not a network this server can pay on.`,
        execute: mpp
          ? "gloam_execute_private_pay({ requirements, note? }) pays and returns the Authorization: Payment credential; gloam_fetch_paid({ url }) also makes the request and the retry."
          : "gloam_execute_private_pay({ requirements, note? }) pays and returns the X-PAYMENT header; gloam_fetch_paid({ url }) also makes the request and the retry.",
        settlement: settlementNote(Boolean(relayUrl())),
        notVsZone: GLOAM_VS_ZONE,
        sourceNote: note ?? "the smallest note that covers the amount",
        ...(guardsBeforePay.length ? { checkBeforePay: guardsBeforePay.join(" ") } : {}),
      });
    }
  );

  type PayResult =
    | { ok: false; result: Record<string, unknown> }
    | {
        ok: true;
        result: Record<string, unknown>;
        /** The x402 X-PAYMENT header. */
        header: string;
        /** For an MPP challenge: the `Payment …` credential, to send in credentialField(challenge). */
        authorization?: string;
      };

  /**
   * What a note label says about a paid resource. The resource is the payee's own text and labels go
   * back to the model in later sessions, so only a host is kept, never free text.
   */
  const paidLabel = (resource: string): string => {
    if (/^[a-z0-9.-]{1,80}(:\d{1,5})?$/i.test(resource)) return resource;
    try {
      const { protocol, host } = new URL(resource);
      if ((protocol === "http:" || protocol === "https:") && host.length <= 80) return host;
    } catch {
      // Not a URL.
    }
    return "a paid resource";
  };

  const receiptContext = (net: McpNetwork, notes: NoteStore): ReceiptContext => ({
    net,
    client: (deps.signer(net)?.publicClient ?? deps.publicClient(net)) as ReceiptContext["client"],
    syncTree: deps.syncTree,
    prover: () => deps.receiptProver(net),
    notes,
    env,
  });

  /** The payment request as Agent Wormhole reads it: the price itself, decoded (an MPP challenge's request, else the x402 requirements). */
  const quoteText = (req: GloamPaymentRequirements, mpp?: PaymentChallenge | null): string =>
    JSON.stringify(
      mpp ? { method: mpp.method, intent: mpp.intent, realm: mpp.realm, description: mpp.description, expires: mpp.expires, request: mpp.request } : req
    );

  /**
   * Pay a 402 privately: pick or take a note by handle, pass the spend gate,
   * prove, broadcast, and keep the change. Secrets stay in this function and the
   * note store; the result carries handles and the sealed X-PAYMENT header, plus
   * the MPP credential when `mpp` is the challenge being paid (push mode: this
   * server broadcasts, so limits and the note store work exactly as for x402).
   * With GLOAM_WORMHOLE_KEY set, `quote` (the payment request as the payee sent
   * it) goes to Agent Wormhole after the spend gate, and only an allow pays. With
   * GLOAM_VEYA_KEY set the payment then goes to VEYA (the agent id, chain, asset,
   * amount and payee only), and only an allow pays. With GLOAM_VEYA_ANCHOR_URL
   * set too, the payment's receipt is built after its answer, which never waits on
   * it and never changes because of it.
   */
  async function payPrivately(
    req: GloamPaymentRequirements,
    opts: {
      handle?: string;
      issuerTag?: string;
      legacyNote?: { secret: string; amount: number; decimals?: number };
      mpp?: PaymentChallenge;
      quote?: string;
      /** The URL the agent asked for: note labels name its host, not the payee's text. */
      requested?: string;
      /** Hears about the payment just before it goes out. If it throws, nothing goes out. */
      sending?: (sent: { note: string; input: string | null; header: string }) => void;
    }
  ): Promise<PayResult> {
    const fail = (result: Record<string, unknown>): PayResult => ({ ok: false, result });
    if ((req.scheme as string) === GLOAM_CASHOUT_SCHEME) {
      return fail({ status: "error", error: `This is a ${GLOAM_CASHOUT_SCHEME} price (a cash out to a public payee). Pay it with gloam_fetch_paid and a maxAmount.` });
    }
    if (req.scheme !== GLOAM_X402_SCHEME) return fail({ status: "error", error: `Not a Gloam private payment (scheme "${req.scheme}").` });
    // The requirements name the network to settle on; use it for the signer,
    // tree scan, keys and explorer. A chain this build has no pool for is refused.
    const net = networkByChainId(Number(req.network));
    if (!net) {
      return fail({
        status: "refused",
        code: "unknown_network",
        message: `This price settles on chain ${req.network}, which this server has no Gloam pool for. It pays on: ${NETWORK_KEYS.join(", ")}.`,
      });
    }
    let spend: Spend & { pool?: Address };
    try {
      spend = {
        tool: "pay",
        network: net.key,
        chainId: net.chainId,
        asset: ((req.asset as Address | undefined) ?? NATIVE_ASSET) as Address,
        amountWei: BigInt(String(req.maxAmountRequired)),
        recipient: String(req.payTo ?? ""),
        pool: req.poolAddress as Address,
      };
    } catch {
      return fail({ status: "error", error: "The requirements carry an amount that is not a whole number of base units." });
    }
    // Zero or less is never a payment, whatever the limits mode: with GLOAM_LIMITS=off nothing else stops it before the checks.
    if (spend.amountWei <= 0n) return fail({ status: "refused", code: "bad_amount", message: "The amount must be above zero. Not paying." });
    const sealed = isReceiveTag(String(req.payTo ?? ""));
    if (!sealed && !legacy) {
      return fail({
        status: "refused",
        code: "payto_not_receive_tag",
        message: `payTo "${shortTag(String(req.payTo ?? ""))}" is not a Gloam receive tag (gloamr1.…). The payment note must be sealed to the payee so only the payee can open it. Ask the payee for its receive tag.`,
      });
    }
    const signer = deps.signer(net);
    if (!signer) {
      return fail({
        status: "no_signer",
        plan: { action: "private_pay_x402", network: net.key, pay: req.maxAmountRequired, asset: req.asset, payTo: req.payTo, pool: req.poolAddress },
        limits: previewSpend(spend, env),
        message: NO_SIGNER,
        notVsZone: GLOAM_VS_ZONE.oneLine,
      });
    }
    const opened = openStore();
    if (!opened.ok) return fail({ status: "error", error: opened.error });
    const notes = opened.store;
    const { symbol, decimals } = assetInfo(net.chainId, spend.asset);
    const fits = (n: StoredNote): string | null => {
      if (n.chainId !== net.chainId || n.pool.toLowerCase() !== String(req.poolAddress).toLowerCase()) {
        return `Note ${n.handle} is on ${n.network}, in a different pool than this payment.`;
      }
      if (n.asset.toLowerCase() !== spend.asset.toLowerCase()) return `Note ${n.handle} holds ${n.symbol}, not ${symbol}.`;
      if (BigInt(n.amountWei) < spend.amountWei) {
        return `Note ${n.handle} holds ${formatUnits(BigInt(n.amountWei), n.decimals)} ${n.symbol}, less than the ${formatUnits(spend.amountWei, decimals)} asked.`;
      }
      return null;
    };

    // Which note pays: a legacy secret, a handle, or the smallest that covers it.
    let input: { secret: Hex; amountWei: bigint; handle: string | null };
    if (opts.legacyNote) {
      const dec = opts.legacyNote.decimals ?? net.defaultAssetDecimals;
      input = { secret: opts.legacyNote.secret as Hex, amountWei: parseUnits(String(opts.legacyNote.amount), dec), handle: null };
    } else {
      let chosen: StoredNote | undefined;
      // A note whose nullifier the chain already reads as spent (an earlier send of it landed after
      // all) is never picked: it is marked spent. An unreadable answer leaves the note to the send.
      const spentOnChain = async (n: StoredNote) => {
        const spent = await (async () => sweepChain(signer.publicClient, net).isSpent(n.nullifier))().catch(() => false);
        if (spent) {
          tryStore(() => {
            notes.update(n.handle, { status: "spent", recheck: false });
            // A note made spendable again whose old send landed: the change and payment it made may be dead notes now.
            if (n.recheck) notes.wakeDead();
          });
        }
        return spent;
      };
      if (opts.handle) {
        chosen = notes.get(opts.handle);
        if (!chosen) return fail({ status: "error", error: `There is no note "${opts.handle}". Call gloam_list_notes.` });
        if (chosen.status !== "unspent") return fail({ status: "error", error: `Note ${chosen.handle} is ${chosen.status}, not spendable.` });
        if (isHeld(chosen)) return fail({ status: "error", error: heldMessage(chosen.handle) });
        const why = fits(chosen);
        if (why) return fail({ status: "error", error: why });
        if (await spentOnChain(chosen)) {
          return fail({ status: "error", error: `Note ${chosen.handle} is already spent on chain: an earlier send of it landed. It is marked spent; call gloam_list_notes with refresh.` });
        }
      } else {
        const candidates = notes
          .list()
          .filter((n) => n.status === "unspent" && !isHeld(n) && fits(n) === null)
          .sort((a, b) => (BigInt(a.amountWei) < BigInt(b.amountWei) ? -1 : 1));
        for (const c of candidates) {
          if (!(await spentOnChain(c))) {
            chosen = c;
            break;
          }
        }
        if (!chosen) {
          return fail({
            status: "error",
            error: `No single private note on ${net.name} holds ${formatUnits(spend.amountWei, decimals)} ${symbol}. Shield more first (gloam_execute_shield). A payment spends one note; notes are not combined.`,
            balances: balances(notes.list().filter((n) => n.chainId === net.chainId)),
          });
        }
      }
      input = { secret: chosen.secret, amountWei: BigInt(chosen.amountWei), handle: chosen.handle };
    }

    const gate = authorizeSpend(spend, env);
    if (!gate.ok) return fail(gate.refusal);
    // Agent Wormhole, when the operator turned it on: it sees the payment request only, and anything but allow stops here.
    const wormhole = await checkBeforePay(opts.quote ?? quoteText(req, opts.mpp), env);
    if (wormhole && !wormhole.pay) {
      settleSpend(gate, "failed", { reason: `Agent Wormhole: ${wormhole.decision}${wormhole.findings.length ? ` (${wormhole.findings.map((f) => f.code).join(", ")})` : ""}` });
      return fail({
        status: "refused",
        code: "wormhole_refused",
        message: wormhole.message,
        wormhole: { decision: wormhole.decision, findings: wormhole.findings, attestation: wormhole.attestation, signature: wormhole.signature },
      });
    }
    // VEYA, when the operator turned it on: last, so a request Agent Wormhole stopped never counts against the budget.
    // It gets the payment's chain, asset, amount and payee, never the resource or the payment request text.
    const veya = await checkVeyaBudget({ chainId: net.chainId, asset: spend.asset, amountWei: spend.amountWei, payee: String(req.payTo ?? "") }, env);
    if (veya && !veya.pay) {
      settleSpend(gate, "failed", { reason: `VEYA: ${veya.decision}${veya.reason ? ` (${veya.reason})` : ""}` });
      return fail({
        status: "refused",
        code: "veya_refused",
        message: veya.message,
        veya: { decision: veya.decision, reason: veya.reason },
      });
    }
    if (input.handle) {
      try {
        notes.reserveForSpend(input.handle, fits);
      } catch (e) {
        settleSpend(gate, "failed", { reason: errMsg(e) });
        return fail({ status: "error", error: errMsg(e) });
      }
    }
    const release = () => input.handle && tryStore(() => notes.update(input.handle!, { status: "unspent" }));

    let hash: Hex | undefined;
    let change: StoredNote | undefined;
    let sent: StoredNote | undefined;
    /** The transaction that spends the input and makes the change and the payment, on each note, for a refresh to look up. */
    const noteSent = (txHash: Hex) =>
      [
        input.handle ? tryStore(() => notes.update(input.handle!, { spentTx: txHash })) : undefined,
        change ? tryStore(() => notes.update(change!.handle, { createdTx: txHash })) : undefined,
        sent ? tryStore(() => notes.update(sent!.handle, { createdTx: txHash })) : undefined,
      ].filter(Boolean);
    let sending = false;
    let viaRelay = false;
    let header: string | undefined;
    try {
      const asset = spend.asset;
      const commitment = fieldToHex(await noteCommitmentPoseidon(hexToField(input.secret), input.amountWei, asset));
      const synced = await deps.syncTree(signer.publicClient, { pool: req.poolAddress as Address, fromBlock: net.deployBlock });
      const path = await synced.pathForCommitment(commitment);
      if (!path) {
        settleSpend(gate, "failed", { reason: "note not in the pool tree" });
        release();
        return fail({ status: "error", error: "That note is not in the pool tree yet. Shield it first, or wait for the deposit to confirm." });
      }
      const payment = await buildGloamPayment({
        requirements: req,
        senderSecretHex: input.secret,
        senderNoteAmountWei: input.amountWei,
        path,
        prove: await deps.transferProver(net),
        issuerTag: opts.issuerTag,
        legacyUnsealed: legacy && !sealed,
      });
      if (BigInt(payment.changeNote.amountWei) > 0n) {
        change = notes.add({
          network: net.key,
          chainId: net.chainId,
          pool: req.poolAddress as Address,
          asset,
          symbol,
          decimals,
          amountWei: payment.changeNote.amountWei,
          secret: payment.changeNote.secret,
          commitment: payment.changeNote.commitment,
          nullifier: payment.changeNote.nullifier,
          status: "pending",
          pending: "create",
          origin: "change",
          createdTx: null,
          label: `change from paying ${paidLabel(opts.requested ?? req.resource)}`,
        });
      }
      // The payment note is the payee's money once it lands, and only this server
      // can hand it over: keep it from before the send, so a payment that lands
      // with no answer is never lost.
      sent = notes.add({
        network: net.key,
        chainId: net.chainId,
        pool: req.poolAddress as Address,
        asset,
        symbol,
        decimals,
        amountWei: payment.paymentNote.amountWei,
        secret: payment.paymentNote.secret,
        commitment: payment.paymentNote.commitment,
        nullifier: payment.paymentNote.nullifier,
        status: "pending",
        pending: "create",
        origin: "payment",
        createdTx: null,
        label: `payment for ${paidLabel(opts.requested ?? req.resource)}`,
        ...(veya?.receipt ? { receipt: plannedReceipt(veya.receipt) } : {}),
      });
      // The sealed payment, to present if the send has an unclear outcome (no tx hash yet).
      header = encodePaymentHeader(payment.payload);
      opts.sending?.({ note: sent.handle, input: input.handle, header });
      // With the Gloam relay the agent's wallet never appears next to the
      // payment (GLOAM_USE_RELAY=1, or GLOAM_RELAY_URL for a self-hosted relay).
      const relay = relayUrl();
      viaRelay = Boolean(relay);
      sending = true;
      hash = relay
        ? await deps.relay(payment.intent, { url: relay })
        : await walletSend(signer, (wallet) =>
            wallet.writeContract({
              address: payment.intent.exec.poolAddress,
              abi: POOL_TRANSFER_ABI,
              functionName: "transfer",
              args: transferCallArgs(payment.intent),
            })
          );
      const sentHash = hash;
      const storeWarnings = noteSent(sentHash);
      const receipt = await signer.publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") {
        // A revert usually means nothing moved, unless the note was already spent elsewhere.
        const nullifier = fieldToHex(await noteNullifierPoseidon(hexToField(input.secret), hexToField(commitment)));
        const spentElsewhere = await sweepChain(signer.publicClient, net).isSpent(nullifier).catch(() => null);
        // Spent elsewhere may be an earlier copy of this same payment that went through: it still counts.
        settleSpend(gate, spentElsewhere === false ? "reverted" : "unconfirmed", { hash });
        if (spentElsewhere === true) {
          // Possibly by an earlier copy of this same transfer (a resend), whose change and
          // payment notes landed: keep them pending, gloam_list_notes refresh settles them.
          if (input.handle) tryStore(() => notes.update(input.handle!, { status: "spent", spentTx: null }));
        } else if (spentElsewhere === false) {
          // Nothing moved by these reads. Through the relay the reverted copy may be a resend whose first copy
          // landed, read by a node behind: the change and payment are kept dead, the note checked on every refresh.
          if (change) tryStore(() => notes.markDead(change!.handle));
          tryStore(() => notes.markDead(sent!.handle));
          if (input.handle) tryStore(() => notes.update(input.handle!, { status: "unspent", recheck: true }));
        }
        // Unread (null): everything stays pending, and gloam_list_notes refresh settles it from the chain.
        return fail({
          status: "error",
          error:
            spentElsewhere === false
              ? `Transfer reverted (${hash}). Nothing moved; the note is spendable again.`
              : spentElsewhere
                ? `Transfer reverted (${hash}): that note was already spent by another transaction, which may be an earlier copy of this payment.`
                : `Transfer reverted (${hash}), and whether that note was spent by another transaction could not be read.`,
          ...(spentElsewhere !== false
            ? {
                hash,
                check: "Call gloam_list_notes with refresh. If the change or the payment confirms, this payment went through: retry the request with paymentHeader and do not pay again.",
                paymentHeader: header,
              }
            : {}),
        });
      }
      const logWarning = settleSpend(gate, "sent", { hash });
      if (input.handle) storeWarnings.push(tryStore(() => notes.update(input.handle!, { status: "spent", spentTx: sentHash })));
      let changeView = change ? noteView({ ...change, status: "unspent", createdTx: hash }) : null;
      if (change) {
        storeWarnings.push(
          tryStore(() => {
            const c = notes.update(change!.handle, { status: "unspent", createdTx: sentHash });
            if (c) changeView = noteView(c);
          })
        );
      }
      if (sent) storeWarnings.push(tryStore(() => notes.update(sent!.handle, { status: "spent", createdTx: sentHash })));
      payment.payload.payload.txHash = hash;
      header = encodePaymentHeader(payment.payload);
      // The MPP credential: the same sealed note plus a binding to this one challenge. Never throws past here:
      // the money already moved, so a failure must not be reported as a failed payment.
      let authorization: string | undefined;
      let mppWarning: string | undefined;
      if (opts.mpp) {
        try {
          authorization = (await credentialFromPayment({ challenge: opts.mpp, payment, mode: "push", hash })).authorization;
        } catch (e) {
          mppWarning = `Paid, but the MPP credential could not be built (${errMsg(e)}). The x402 header still carries the payment.`;
        }
      }
      // The receipt VEYA anchors, finished after this answer: the payment and its credential never wait on it, since a
      // challenge can expire meanwhile and the agent would pay again. It never throws, and gloam_retry_veya_receipts joins it.
      let veyaReceipt: ReceiptOutcome | undefined;
      if (sent?.receipt) {
        const later = settleReceiptLater({ ...sent, receipt: sent.receipt, createdTx: sentHash }, receiptContext(net, notes));
        veyaReceipt = later.now;
        deps.receiptWork?.(sent.handle, later.work);
      }
      const noteWarning = storeWarnings.filter(Boolean).join(" ") || undefined;
      return {
        ok: true,
        header,
        ...(authorization ? { authorization } : {}),
        result: {
          status: "paid",
          ...(opts.mpp ? { protocol: "mpp" } : {}),
          ...(wormhole ? { wormhole: { decision: wormhole.decision, attestation: wormhole.attestation, signature: wormhole.signature } } : {}),
          ...(veya ? { veya: { decision: veya.decision, ...(veya.checkId ? { checkId: veya.checkId } : {}), ...(veyaReceipt ? { receipt: veyaReceipt } : {}) } } : {}),
          ...(mppWarning ? { mppWarning } : {}),
          ...(logWarning ? { logWarning } : {}),
          ...(noteWarning ? { noteWarning } : {}),
          network: net.key,
          ...(net.testnet ? {} : { realMoney: true }),
          submittedBy: relay ? "gloam-relay (agent wallet hidden)" : "agent wallet",
          hash,
          explorer: `${net.explorer}/tx/${hash}`,
          paid: { amount: formatUnits(spend.amountWei, decimals), symbol, payTo: shortTag(String(req.payTo)), resource: req.resource },
          sealedToPayee: payment.sealed,
          spentNote: input.handle,
          change: changeView,
          ...(legacy
            ? {
                warning: LEGACY_WARNING,
                paymentNote: { secret: payment.paymentNote.secret, commitment: payment.paymentNote.commitment, amountWei: payment.paymentNote.amountWei },
                persistChangeNote: { secret: payment.changeNote.secret, amountWei: payment.changeNote.amountWei },
              }
            : {}),
          privacy: settlementNote(viaRelay),
          notVsZone: GLOAM_VS_ZONE.oneLine,
        },
      };
    } catch (err) {
      const error = errMsg(err);
      // A wallet send whose reply was lost: its hash was noted before the RPC answered.
      if (!hash && err instanceof WalletSendUnclear) {
        hash = err.hash;
        noteSent(hash);
      }
      // A send that threw may still have landed (a relay timeout after the node took it, a
      // lost reply to the wallet's broadcast): only a send surely never made frees the note
      // and forgets its outputs.
      const maybeSent = Boolean(hash) || (sending && mayHaveSent(err, viaRelay));
      // Broadcast but unconfirmed still counts against the limit, to be safe.
      settleSpend(gate, maybeSent ? "unconfirmed" : "failed", { hash, reason: error });
      if (!maybeSent && sending) {
        // Refused, but the relay (or the wallet's RPC) has seen the proof, which stays valid until
        // the note is spent: the change and the payment stay kept (dead), and the note is spendable
        // again and checked on every refresh, so whichever send lands first, nothing is lost.
        if (change) tryStore(() => void notes.markDead(change!.handle));
        if (sent) tryStore(() => void notes.markDead(sent!.handle));
        if (input.handle) tryStore(() => void notes.update(input.handle!, { status: "unspent", recheck: true }));
      } else if (!maybeSent) {
        // nothing left this server: the notes it would have made are forgotten
        release();
        if (change) tryStore(() => notes.remove(change!.handle));
        if (sent) tryStore(() => notes.remove(sent!.handle));
      }
      return fail({
        status: "error",
        error,
        ...(maybeSent
          ? {
              ...(hash ? { hash } : {}),
              check: "It may have been sent and may still land. Call gloam_list_notes with refresh before paying again: if the payment lands, retry the request with paymentHeader instead of paying again.",
              ...(header ? { paymentHeader: header } : {}),
            }
          : {}),
      });
    }
  }

  if (env.GLOAM_VEYA_KEY?.trim() && env.GLOAM_VEYA_ANCHOR_URL?.trim()) {
    server.registerTool(
      "gloam_retry_veya_receipts",
      {
        title: "Retry VEYA receipts",
        description:
          "See where the receipts of payments that already went through stand, and retry any that failed. A payment's answer says its receipt is pending, since the receipt is built after it; this waits up to 30 seconds on one still being built. Spends nothing and pays nothing: it builds a missing receipt and sends VEYA its leaf. A leaf VEYA already took is not sent again. Returns each payment's note handle, leaf and status, never the record.",
        inputSchema: {
          note: z.string().optional().describe("Handle of one payment's note. Omit for every receipt VEYA has not taken."),
        },
      },
      async ({ note }) => {
        const opened = openStore();
        if (!opened.ok) return text({ status: "error", error: opened.error });
        const notes = opened.store;
        const listed = notes.list().filter((n) => n.receipt && (note ? n.handle === note : n.receipt.status !== "anchored"));
        if (note && !listed.length) return text({ status: "error", error: `There is no payment with a receipt under "${note}".` });
        const receipts: (ReceiptOutcome | { status: "not_landed"; note: string; checkId: string; leaf: null; message: string })[] = [];
        for (const n of listed) {
          const net = networkByChainId(n.chainId);
          if (!net || n.status !== "spent" || !n.createdTx) {
            receipts.push({
              status: "not_landed",
              note: n.handle,
              checkId: n.receipt!.checkId,
              leaf: null,
              message: "This payment has not shown as landed. Call gloam_list_notes with refresh first.",
            });
            continue;
          }
          receipts.push(await settleReceiptInTime({ ...n, receipt: n.receipt! }, receiptContext(net, notes)));
        }
        return text({ status: "ok", receipts, ...(receipts.length ? {} : { message: "Nothing to retry." }) });
      }
    );
  }

  const PAY_SHAPE = {
    requirements: z
      .string()
      .describe("Encoded requirements from gloam_payment_requirements (or raw JSON), or an MPP challenge (the WWW-Authenticate: Payment value)."),
    note: z
      .string()
      .optional()
      .describe("Handle of the note to pay from (gloam_list_notes). Omit to use the smallest note that covers the amount."),
    issuerTag: z.string().optional().describe("Optional issuer tag to attach a compliance disclosure."),
    noteSecret: z.string().optional().describe("LEGACY, UNSAFE: the 0x secret of a note held outside this server."),
    noteAmount: z.number().positive().optional().describe("LEGACY: the full amount of that note in the asset's units."),
    decimals: z.number().int().optional().describe("LEGACY: decimals of that note's asset; omit for the network default."),
  };
  const SAFE_PAY_SHAPE = { requirements: PAY_SHAPE.requirements, note: PAY_SHAPE.note, issuerTag: PAY_SHAPE.issuerTag };

  /**
   * One payment for one purchase. A client that gives up on a slow call does not stop it: the send still goes
   * out, and the retry that follows must not pay again. So a purchase is claimed in the note store before anything
   * is spent, and each send is recorded before it goes out. A call that finds it running is told so and pays
   * nothing. One that finds an earlier send asks the chain what became of it: landed, it gets the first answer or
   * presents that payment. Not landed, it pays from the same note, so that whichever send gets there first, the
   * note's nullifier stops the other. A retry repeats its arguments, so calls that differ are different purchases.
   * A purchase stays recorded only until its answer reached the caller (a cancelled call, a closed connection or a
   * retry says it may not have), since a fixed price can be bought again on purpose. A challenge is different: it is
   * paid once, so its record stays.
   */
  type Purchase = { key: string; by: string; notes: NoteStore; served: boolean };
  type PurchaseSlot = { purchase?: Purchase };
  type ToolAnswer = ReturnType<typeof text>;
  type Sending = (sent: { note: string; input: string | null; header: string }) => void;

  /** Answers to paid calls that may not have reached the caller, for the retry. Only in memory: they can hold a resource's body. */
  const unheard = new Map<string, { note: string; answer: ToolAnswer }>();
  const UNHEARD_MAX = 32;
  let purchaseCalls = 0;

  const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

  /**
   * What became of a purchase's earlier sends, from the chain: the one that landed, or the note to pay from
   * instead (null for any), or undefined when that can't be said yet.
   */
  async function sendsOutcome(sends: PaymentSendState[]): Promise<{ landed: PaymentSendState } | { payFrom: string | null } | undefined> {
    const known = sends.find((s) => s.payment.status === "spent");
    if (known) return { landed: known };
    const net = networkByChainId(sends[0]!.payment.chainId);
    if (!net || sends.some((s) => !s.funding)) return undefined;
    try {
      const chain = sweepChain(deps.signer(net)?.publicClient ?? deps.publicClient(net), net);
      // The spend first: a send does both in one block, so a spend read with no payment read after it was another transaction's.
      const stillOpen: PaymentSendState[] = [];
      for (const s of sends) if (!(await chain.isSpent(s.funding!.nullifier))) stillOpen.push(s);
      for (const s of sends) if (await chain.isCommitmentSeen(s.payment.commitment)) return { landed: s };
      const notes = new Set(stillOpen.map((s) => s.input));
      if (notes.size > 1) return undefined;
      // Every note that funded a send is spent and no payment shows, so something else spent them and none can land.
      // Unless the send is recent: right after one lands, one node can show the spend while another lacks the payment.
      if (!stillOpen.length) return Date.now() - Date.parse(sends.at(-1)!.payment.createdAt) > STUCK_MS ? { payFrom: null } : undefined;
      // A send from this note may still land, so only this note can pay. It may still be waiting on that send.
      return stillOpen[0]!.funding!.status === "unspent" ? { payFrom: stillOpen[0]!.input } : undefined;
    } catch {
      return undefined;
    }
  }

  /** The credential for a payment already made, for `challenge`, which may be newer than the one it was paid against. */
  async function credentialForPaid(challenge: PaymentChallenge, send: PaymentSendState): Promise<string | undefined> {
    try {
      const net = networkByChainId(send.payment.chainId);
      if (!net) return undefined;
      // A relay's resend can leave a reverted copy's hash on the note, though another copy landed.
      const reverted = await txReads(deps.signer(net)?.publicClient ?? deps.publicClient(net)).reverted(send.payment.createdTx);
      const hash = reverted ? null : send.payment.createdTx;
      // Without its hash the transfer itself says which payment this is. It is in the pool, so nothing is submitted.
      if (!hash && !allowedModes(parseGloamChargeRequest(challenge.request)).includes("pull")) return undefined;
      const payload = decodePaymentHeader(send.header);
      const payment = { intent: { exec: payload.payload.exec }, paymentNote: send.payment, payload, sealed: true };
      const built = await credentialFromPayment({
        challenge,
        payment: payment as unknown as Parameters<typeof credentialFromPayment>[0]["payment"],
        mode: hash ? "push" : "pull",
        hash,
      });
      return built.authorization;
    } catch {
      return undefined;
    }
  }

  async function payOnce(
    slot: PurchaseSlot,
    purchase: { key: string; once?: boolean; challenge?: PaymentChallenge },
    pay: (sending: Sending, payFrom: string | null) => Promise<PayResult>
  ): Promise<{ paid: PayResult } | { answer: ToolAnswer }> {
    const { key, once = false, challenge } = purchase;
    const opened = openStore();
    // Nothing can be recorded, so nothing goes out. A call with no signer still gets its plan from here.
    if (!opened.ok) {
      return {
        paid: await pay(() => {
          throw new Error(opened.error);
        }, null),
      };
    }
    const notes = opened.store;
    const by = `${settlerId}:${++purchaseCalls}`;
    const payNow = async (payFrom: string | null) => {
      unheard.delete(key);
      let sent: string | undefined;
      const paid = await pay(({ note, input, header }) => {
        if (!notes.markSend(key, by, { note, input, header })) {
          throw new Error("A later call took this payment over, so this one sent nothing.");
        }
        sent = note;
      }, payFrom);
      if (paid.ok && sent) {
        const note = sent;
        tryStore(() => notes.markPresented(key, by, note, { header: paid.header, ...(paid.authorization ? { authorization: paid.authorization } : {}) }));
      }
      return { paid };
    };
    let claim: PaymentClaim;
    try {
      claim = notes.claimPayment(key, STUCK_MS, by, once);
    } catch (e) {
      return { paid: { ok: false, result: { status: "error", error: errMsg(e) } } };
    }
    if (claim.claimed) {
      slot.purchase = { key, by, notes, served: false };
      return payNow(null);
    }
    if (!claim.running) slot.purchase = { key, by, notes, served: false };
    const outcome = claim.running ? undefined : await sendsOutcome(claim.sends);
    if (outcome && "payFrom" in outcome) return payNow(outcome.payFrom);
    if (!outcome) {
      const last = claim.sends.at(-1);
      const hash = last?.payment.createdTx ?? null;
      return {
        paid: {
          ok: false,
          result: {
            status: "payment_in_progress",
            message:
              "The same payment is still being made, or whether it landed is not known yet. Nothing was paid by this call. Wait, then call again with the same arguments: it will use that payment. If this keeps coming back, call gloam_list_notes with refresh first.",
            ...(hash ? { hash } : {}),
            ...(last ? { paymentHeader: claim.attempt.authorization ?? last.header } : {}),
          },
        },
      };
    }
    const { landed } = outcome;
    const purchased = slot.purchase!;
    if (landed.payment.status !== "spent") tryStore(() => void notes.update(landed.note, { status: "spent" }));
    const first = unheard.get(key);
    if (first?.note === landed.note) {
      purchased.served = true;
      return { answer: text({ ...JSON.parse(first.answer.content[0].text), reused: true }) };
    }
    const authorization = (challenge && (await credentialForPaid(challenge, landed))) || claim.attempt.authorization;
    if (authorization) tryStore(() => notes.markPresented(key, by, landed.note, { authorization }));
    const hash = landed.payment.createdTx;
    return {
      paid: {
        ok: true,
        header: landed.header,
        ...(authorization ? { authorization } : {}),
        result: {
          status: "paid",
          reused: true,
          ...(hash ? { hash } : {}),
          message: "This was already paid, so that payment is used and nothing new was paid.",
        },
      },
    };
  }

  /** Run a paying tool, and close its purchase with what became of the answer. */
  function oncePerPurchase<A>(handler: (args: A, slot: PurchaseSlot) => Promise<ToolAnswer>) {
    return async (args: A, extra: { signal: AbortSignal }): Promise<ToolAnswer> => {
      const slot: PurchaseSlot = {};
      let answer: ToolAnswer | undefined;
      try {
        answer = await handler(args, slot);
        return answer;
      } finally {
        const p = slot.purchase;
        if (p) {
          tryStore(() => {
            const stays = p.notes.closePayment(p.key, p.by, p.served && !extra.signal.aborted);
            unheard.delete(p.key);
            if (stays?.landed && p.served && answer) {
              unheard.set(p.key, { note: stays.landed, answer });
              if (unheard.size > UNHEARD_MAX) unheard.delete(unheard.keys().next().value!);
            }
          });
        }
      }
    };
  }

  server.registerTool(
    "gloam_execute_private_pay",
    {
      title: "Execute a private payment (x402 or MPP)",
      description:
        "AGENT side, REAL execution. Settle a 402 price privately from a note this server holds: syncs the pool tree, builds the private send to the payee, seals the payment note to the payee's receive tag, generates the Groth16 transfer proof, and broadcasts transfer(). Self-custodial (this server's key signs; no operator holds funds). Returns the X-PAYMENT header for x402 requirements, or for an MPP challenge (method gloam) the Authorization: Payment credential, and the change as a note handle. A challenge is paid once, and a call whose answer never arrived is not paid twice: the retry reuses the first payment, or answers payment_in_progress while that one is running. payTo must be a receive tag. Requires GLOAM_AGENT_PRIVATE_KEY; without it, returns a plan.",
      // The legacy secret fields are only offered when GLOAM_EXPOSE_NOTE_SECRETS=1.
      inputSchema: (legacy ? PAY_SHAPE : SAFE_PAY_SHAPE) as typeof PAY_SHAPE,
    },
    oncePerPurchase(async ({ requirements, note, issuerTag, noteSecret, noteAmount, decimals }, slot) => {
      const priced = parsePriced(requirements);
      if ("error" in priced) return text({ status: "error", error: priced.error });
      const { req, mpp } = priced;
      if (mpp) {
        const why = cannotPay(mpp, parseGloamChargeRequest(mpp.request));
        if (why) return text({ status: "refused", code: "mpp_unpayable", message: why });
      }
      if (legacy && noteSecret && noteAmount === undefined) {
        return text({ status: "error", error: "noteSecret needs noteAmount (the note's full value)." });
      }
      const purchase = mpp ? { key: `mpp:${mpp.id}`, once: true, challenge: mpp } : { key: `x402:${digest([req, note ?? null, issuerTag ?? null])}` };
      const once = await payOnce(slot, purchase, (sending, payFrom) =>
        payPrivately(req, {
          handle: payFrom ?? note,
          issuerTag,
          legacyNote: legacy && noteSecret && noteAmount !== undefined ? { secret: noteSecret, amount: noteAmount, decimals } : undefined,
          mpp: mpp ?? undefined,
          sending,
        })
      );
      if ("answer" in once) return once.answer;
      const { paid } = once;
      if (!paid.ok) return text(paid.result);
      if (slot.purchase) slot.purchase.served = true;
      if (mpp && paid.authorization) {
        const field = credentialField(mpp);
        return text({
          ...paid.result,
          authorization: paid.authorization,
          authorizationField: field,
          next: `Retry the request with the header ${field} set to authorization. The payee sweeps the payment before serving and answers with a Payment-Receipt.`,
        });
      }
      return text({
        ...paid.result,
        paymentHeader: paid.header,
        next: "Retry the request with the header X-PAYMENT set to paymentHeader. The payee sweeps the payment before serving.",
      });
    })
  );

  /** The encoded requirements in a 402's headers, or null. They win over anything in the body. */
  function requirementsHeader(headers: Headers): string | null {
    for (const name of ["x-payment-required", "payment-required"]) {
      const h = headers.get(name)?.trim();
      if (h?.startsWith("gloamx402req1:")) return h;
    }
    return null;
  }

  /** Pull Gloam requirements out of a 402 response: a header, the body, or an x402 `accepts` list. */
  function requirementsFrom402(headers: Headers, body: string): GloamPaymentRequirements | string {
    const header = requirementsHeader(headers);
    if (header) return decodeRequirements(header);
    const t = body.trim();
    if (t.startsWith("gloamx402req1:")) return decodeRequirements(t);
    let json: unknown;
    try {
      json = JSON.parse(t);
    } catch {
      return "The 402 response carries no Gloam payment requirements.";
    }
    const o = json as Record<string, unknown>;
    const candidates: unknown[] = [o, o.requirements, ...(Array.isArray(o.accepts) ? o.accepts : [])];
    if (typeof o.encoded === "string" && o.encoded.startsWith("gloamx402req1:")) return decodeRequirements(o.encoded);
    for (const c of candidates) {
      if (c && typeof c === "object" && (c as GloamPaymentRequirements).scheme === GLOAM_X402_SCHEME) return c as GloamPaymentRequirements;
    }
    const offered = Array.isArray(o.accepts) ? o.accepts.map((a) => (a as { scheme?: string })?.scheme).filter(Boolean) : [];
    return `The 402 response does not offer a Gloam private payment${offered.length ? ` (it offers: ${offered.join(", ")})` : ""}.`;
  }

  const BODY_LIMIT = 20_000;
  async function readBody(res: Response) {
    const raw = await res.text();
    return {
      httpStatus: res.status,
      contentType: res.headers.get("content-type"),
      body: raw.length > BODY_LIMIT ? `${raw.slice(0, BODY_LIMIT)}… (${raw.length - BODY_LIMIT} more characters)` : raw,
    };
  }

  /** A Payment-Receipt header, decoded, or null. */
  function receiptFrom(res: Response): Record<string, unknown> | null {
    const h = res.headers.get("payment-receipt");
    if (!h) return null;
    try {
      return parseReceipt(h);
    } catch {
      return { raw: h.slice(0, 500), error: "The Payment-Receipt header does not decode." };
    }
  }

  /** The headers that present a payment: an MPP credential in the field its challenge selected, x402 in X-PAYMENT. */
  function presentHeaders(payment: string): Record<string, string> {
    if (looksLikeMpp(payment)) {
      let field = "Authorization";
      try {
        field = credentialField(parseMppCredential(payment).challenge);
      } catch {
        // Not parseable here; the server will say so.
      }
      return { [field.toLowerCase()]: payment.trim() };
    }
    return { "x-payment": payment };
  }

  /** gloam_fetch_paid for an x402 gloam-cashout price: cash out to the payee, then retry with X-PAYMENT. */
  async function fetchPaidCashout(a: {
    cashout: Parameters<typeof payGloamCashoutQuote>[1];
    url: string;
    note: string | undefined;
    maxAmount: number | undefined;
    request: (payHeaders?: Record<string, string>) => Promise<Response>;
  }) {
    const paid = await payGloamCashoutQuote(swapCtx, a.cashout, { maxAmount: a.maxAmount, note: a.note, requested: a.url });
    if (!paid.ok) return text({ ...paid.result, httpStatus: 402, scheme: GLOAM_CASHOUT_SCHEME });
    let second: Response;
    try {
      second = await a.request({ "x-payment": paid.header });
    } catch (e) {
      return text({
        ...paid.result,
        status: "paid_not_served",
        message: `Paid, but the retry failed (${errMsg(e)}). Call gloam_fetch_paid again with paymentHeader to present this payment without paying twice.`,
        paymentHeader: paid.header,
      });
    }
    const served = await readBody(second);
    if (!second.ok) {
      return text({
        ...paid.result,
        status: "paid_not_served",
        message: "Paid, but the server did not serve the resource yet (it may still be checking the cash out). Retry with paymentHeader; do not pay again.",
        paymentHeader: paid.header,
        ...served,
      });
    }
    return text({ ...paid.result, status: "ok", ...served, paymentResponse: second.headers.get("x-payment-response") ?? second.headers.get("payment-response") });
  }

  server.registerTool(
    "gloam_fetch_paid",
    {
      title: "Fetch a paid resource (x402 or MPP, paid privately)",
      description:
        "AGENT side, REAL execution. Request a URL; if it answers 402 with a Gloam private price, pay it privately from this server's notes (same limits as gloam_execute_private_pay), retry, and return the response. Understands both dialects: an MPP challenge (WWW-Authenticate: Payment with method gloam, answered with Authorization: Payment) is preferred when offered, else x402 (X-PAYMENT). Also pays x402 scheme gloam-cashout (a gateway on Robinhood Chain that pays out to a public address): a cash out of exactly the quoted USDG from this server's notes to that address, sent through the Gloam relay. The payee and the amount are public there; this server's wallet and balance are not. gloam-cashout needs maxAmount. With gloam-private and gloam-cashout both offered, gloam-private is paid unless prefer says gloam-cashout. The agent never handles a note secret or the payment header unless a retry is needed. A call whose answer never arrived is not paid twice: the same call again gets that answer, presents the first payment, or answers payment_in_progress while it is running. Requires GLOAM_AGENT_PRIVATE_KEY to pay.",
      inputSchema: {
        url: z.string().url().describe("http(s) URL of the resource."),
        method: z.enum(["GET", "POST"]).default("GET"),
        body: z.string().optional().describe("Request body for POST."),
        contentType: z.string().optional().describe("Content-Type for the body (default application/json)."),
        note: z.string().optional().describe("Handle of the note to pay from; omit to use the smallest that covers the price."),
        maxAmount: z
          .number()
          .positive()
          .optional()
          .describe("Refuse if the 402 asks for more than this, in the asset's units. Needs the asset's decimals from Gloam's list or the limits file; for any other asset the fetch is refused."),
        paymentHeader: z
          .string()
          .optional()
          .describe("Present a payment already made (paymentHeader from an earlier result: an X-PAYMENT value or an MPP Payment credential) instead of paying again."),
        prefer: z
          .enum([GLOAM_X402_SCHEME, GLOAM_CASHOUT_SCHEME])
          .optional()
          .describe("Which x402 scheme to pay when the resource offers both gloam-private and gloam-cashout. Default gloam-private, which keeps the payee private too."),
      },
    },
    oncePerPurchase(async ({ url, method, body, contentType, note, maxAmount, paymentHeader, prefer }, slot) => {
      if (!/^https?:\/\//i.test(url)) return text({ status: "error", error: "Only http and https URLs." });
      const request = (payHeaders: Record<string, string> = {}) =>
        deps.fetch(url, {
          method,
          headers: {
            ...(body !== undefined ? { "content-type": contentType ?? "application/json" } : {}),
            ...payHeaders,
          },
          body: method === "POST" ? body : undefined,
          signal: AbortSignal.timeout(30_000),
        });
      let first: Response;
      try {
        first = await request(paymentHeader ? presentHeaders(paymentHeader) : {});
      } catch (e) {
        return text({ status: "error", error: `Request failed: ${errMsg(e)}` });
      }
      if (first.status !== 402) {
        const receipt = paymentHeader ? receiptFrom(first) : null;
        if (paymentHeader && first.ok) {
          const opened = openStore();
          if (opened.ok) tryStore(() => opened.store.dropPresented(paymentHeader));
        }
        return text({ status: first.ok ? "ok" : "http_error", paid: false, ...(await readBody(first)), ...(receipt ? { paymentReceipt: receipt } : {}) });
      }
      const firstBody = await first.text();
      if (paymentHeader) {
        return text({
          status: "payment_not_accepted",
          message: "The server still asks for payment. It may not have seen the transfer yet; wait a little and retry with the same paymentHeader. Do not pay again until you know it failed.",
          httpStatus: 402,
          body: firstBody.slice(0, BODY_LIMIT),
        });
      }

      // A 402 from another origin, reached through a redirect. The paid retry goes to `url` and the
      // redirect drops the payment on the way there, so paying would strand the money.
      if (first.url && new URL(first.url).origin !== new URL(url).origin) {
        return text({
          status: "refused",
          code: "cross_origin_402",
          httpStatus: 402,
          message: `${new URL(url).origin} redirected to ${new URL(first.url).origin}, which asked for payment. Nothing was paid: a payment cannot follow a redirect to another origin. Call that origin directly if you trust it.`,
        });
      }

      // MPP first: a gloam/charge challenge in WWW-Authenticate. Otherwise x402: gloam-private, or
      // gloam-cashout when that is the only Gloam scheme offered or the caller prefers it.
      let req: GloamPaymentRequirements | string;
      const cashout = findGloamCashoutRequirement(first.headers, firstBody);
      const mpp = prefer === GLOAM_CASHOUT_SCHEME && cashout ? null : (gloamChallenges(first.headers.get("www-authenticate"))[0] ?? null);
      if (!mpp && cashout) {
        let priv: GloamPaymentRequirements | string;
        try {
          priv = requirementsFrom402(first.headers, firstBody);
        } catch {
          priv = "does not decode";
        }
        if (chooseGloamX402Scheme({ gloamPrivate: typeof priv !== "string", gloamCashout: true }, prefer) === GLOAM_CASHOUT_SCHEME) {
          return fetchPaidCashout({ cashout, url, note, maxAmount, request });
        }
      }
      if (mpp) {
        let request: GloamChargeRequest;
        try {
          ({ req, request } = requirementsFromChallenge(mpp));
        } catch (e) {
          return text({ status: "error", httpStatus: 402, error: `The server's gloam challenge is not valid: ${errMsg(e)}` });
        }
        const why = cannotPay(mpp, request);
        if (why) return text({ status: "refused", code: "mpp_unpayable", httpStatus: 402, message: why });
      } else {
        try {
          req = requirementsFrom402(first.headers, firstBody);
        } catch {
          req = "The 402 response carries Gloam requirements that do not decode.";
        }
        if (typeof req === "string") return text({ status: "error", httpStatus: 402, error: req, body: firstBody.slice(0, 2000) });
      }
      if (maxAmount !== undefined) {
        // maxAmount is in whole units, so it is only as good as the decimals: the owner's limits or Gloam's list, never the 402's word or a guess.
        const decimals = assetDecimals(Number(req.network), req.asset, env);
        if (decimals === null) {
          return text({
            status: "refused",
            code: "unknown_decimals",
            httpStatus: 402,
            message: `maxAmount cannot be checked: the decimals of ${req.asset} are not known here (list the asset in the limits file, or leave maxAmount out). Not paying.`,
          });
        }
        const { symbol } = assetInfo(Number(req.network), req.asset, decimals);
        let asked: bigint;
        try {
          asked = BigInt(String(req.maxAmountRequired));
        } catch {
          return text({ status: "error", error: "The 402 asks for an amount that is not a whole number of base units." });
        }
        if (asked > parseUnits(String(maxAmount), decimals)) {
          return text({
            status: "refused",
            code: "over_max_amount",
            message: `The resource asks ${formatUnits(asked, decimals)} ${symbol}, more than your maxAmount of ${maxAmount}. Not paying.`,
          });
        }
      }
      // For Agent Wormhole: the price as it would be paid, decoded, since that is the text the agent gets back and
      // a body can carry it encoded. Then the 402 body as the payee sent it, when the price came in it. A price
      // in a header is what gets paid whatever the body says, so the check reads that price alone.
      const quote = !mpp && !requirementsHeader(first.headers) && firstBody.trim() && firstBody.length <= 65_536 ? `${quoteText(req)}\n${firstBody}` : undefined;
      // A purchase is this call at this price: a server can answer each retry with a fresh challenge.
      const purchase = digest([url, method, body ?? null, contentType ?? null, note ?? null, req.network, req.poolAddress, req.asset, req.maxAmountRequired, req.payTo]);
      const once = await payOnce(slot, { key: `fetch:${purchase}`, ...(mpp ? { challenge: mpp } : {}) }, (sending, payFrom) =>
        payPrivately(req, { handle: payFrom ?? note, requested: url, ...(mpp ? { mpp } : {}), ...(quote ? { quote } : {}), sending })
      );
      if ("answer" in once) return once.answer;
      const { paid } = once;
      if (!paid.ok) return text({ ...paid.result, httpStatus: 402, resource: req.resource });
      // What to present: the MPP credential when paying an MPP challenge, else the x402 header.
      const presented = mpp ? paid.authorization : paid.header;
      const retryHeaders: Record<string, string> = mpp
        ? paid.authorization
          ? { [credentialField(mpp).toLowerCase()]: paid.authorization }
          : {}
        : { "x-payment": paid.header };
      if (!presented) {
        return text({
          ...paid.result,
          status: "paid_not_served",
          message: "Paid, but the MPP credential could not be built, so the request was not retried. The payment is not lost: the payee can still open it.",
          paymentHeader: paid.header,
        });
      }
      let second: Response;
      try {
        second = await request(retryHeaders);
      } catch (e) {
        return text({
          ...paid.result,
          status: "paid_not_served",
          message: `Paid, but the retry failed (${errMsg(e)}). Call gloam_fetch_paid again with paymentHeader to present this payment without paying twice.`,
          paymentHeader: presented,
        });
      }
      const served = await readBody(second);
      if (!second.ok) {
        return text({
          ...paid.result,
          status: "paid_not_served",
          message: "Paid, but the server did not serve the resource yet (it may still be confirming the payment). Retry with paymentHeader; do not pay again.",
          paymentHeader: presented,
          ...served,
        });
      }
      if (slot.purchase) slot.purchase.served = true;
      const receipt = mpp ? receiptFrom(second) : null;
      return text({
        ...paid.result,
        status: "ok",
        ...served,
        ...(mpp ? { paymentReceipt: receipt } : { paymentResponse: second.headers.get("x-payment-response") }),
      });
    })
  );

  type Reject = (message: string, extra?: Record<string, unknown>) => ReturnType<typeof text>;

  /** Payments this server is settling right now, by note store and payment nullifier. */
  const settling = new Set<string>();
  /** Who this server is in the note store's settle claims: a claim it left behind is its own to take back. */
  const settlerId = `${process.pid}:${randomBytes(6).toString("hex")}`;

  /**
   * One settle of a payment at a time: in this process, and across processes sharing the note store (a claim
   * taken under its lock before anything is proved or sent). A verify of the same payment meanwhile answers
   * unconfirmed at once, so a payment presented many times sends one sweep, not one per verify.
   */
  async function settleReceived(args: Parameters<typeof settlePayment>[0]) {
    const key = `${args.notes.path}\n${args.paymentNullifier.toLowerCase()}`;
    const busy = () =>
      text({
        status: "unconfirmed",
        grantAccess: false,
        final: false,
        message: "Another verify of this payment is settling it right now. Verify again shortly; do not serve until it says settled.",
      });
    if (settling.has(key)) return busy();
    settling.add(key);
    try {
      let claimed: boolean;
      try {
        claimed = args.notes.claimSettle(args.paymentNullifier, STUCK_MS, settlerId);
      } catch (e) {
        return text({ status: "error", grantAccess: false, final: false, error: `Could not take this payment for settling (${errMsg(e)}). Nothing was sent; verify again.` });
      }
      if (!claimed) return busy();
      try {
        return await settlePayment(args);
      } finally {
        tryStore(() => args.notes.releaseSettle(args.paymentNullifier));
      }
    } finally {
      settling.delete(key);
    }
  }

  /**
   * The settle tail both dialects share, once a received note has passed its
   * checks: refuse a payment this server already swept, then (pull) submit the
   * payer's transfer, then sweep the note into a fresh one, storing it before the
   * sweep is sent, and grant access only when the sweep confirms.
   */
  async function settlePayment(args: {
    net: McpNetwork;
    notes: NoteStore;
    note: NoteExport;
    paymentNullifier: Hex;
    label: string;
    sealed: boolean;
    verifyView: Record<string, unknown>;
    /** MPP pull mode: the payer's transfer, not yet in the pool, that this server submits first. */
    pull?: ValidatedGloamCharge["transfer"];
    /** MPP: what the receipt names. */
    mpp?: { challengeId: string; externalId?: string };
  }) {
    const { net, notes, note, paymentNullifier, sealed, verifyView } = args;
    // Only canonical fields count: the hash reads them mod p, so amount + p opens the same note.
    const notCanonical = noteFieldProblem(note);
    if (notCanonical || BigInt(note.amountWei) <= 0n) {
      return text({ status: "rejected", grantAccess: false, final: false, message: `The payment note is not a real payment: ${notCanonical ?? "it carries no value."}` });
    }
    const signer = deps.signer(net);
    const relay = relayUrl();
    const { symbol, decimals } = assetInfo(net.chainId, note.asset);
    const client = signer?.publicClient ?? deps.publicClient(net);

    /** The answer that grants access, for a payment now in a note only this server knows. */
    const settled = (received: ReturnType<typeof noteView> | null, hash: Hex | null, extra: Record<string, unknown> = {}) => {
      let mppReceipt: Record<string, unknown> = {};
      if (args.mpp && hash) {
        const receipt: GloamChargeReceipt = {
          status: "success",
          method: "gloam",
          timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
          reference: hash,
          challengeId: args.mpp.challengeId,
          chainId: net.chainId,
          ...(args.mpp.externalId !== undefined ? { externalId: args.mpp.externalId } : {}),
        };
        mppReceipt = {
          receipt,
          paymentReceipt: serializeReceipt(receipt),
          httpHint: "Serve the resource with the header Payment-Receipt set to paymentReceipt and Cache-Control: private.",
        };
      }
      return text({
        status: "settled",
        grantAccess: true,
        final: true,
        ...extra,
        message: "Paid and final: the payment now sits in a note only this server knows. Serve the resource.",
        received,
        amount: formatUnits(BigInt(note.amountWei), decimals),
        symbol,
        sealed,
        hash,
        explorer: hash ? `${net.explorer}/tx/${hash}` : null,
        ...mppReceipt,
      });
    };

    const alreadySettled = (handle: string | null) =>
      text({
        status: "already_settled",
        grantAccess: false,
        final: false,
        message: `This payment was already settled by this server${handle ? ` (${handle})` : ""}. Do not serve it twice.`,
      });
    /**
     * Grant access from received note `n`, whose sweep is on chain, only if this verify is the one
     * that marks the payment served (checked and set under the store lock): a payment presented
     * many times at once is served once, and the others are told it was already settled.
     */
    const serveOnce = (n: StoredNote, patch: Partial<Pick<StoredNote, "status" | "createdTx">>, extra: Record<string, unknown>) => {
      let claim: ReturnType<NoteStore["claimServed"]>;
      try {
        claim = notes.claimServed(n.handle, patch);
      } catch (e) {
        return text({
          status: "error",
          grantAccess: false,
          final: false,
          error: `The sweep confirmed, but this server could not record that it served this payment (${errMsg(e)}). Verify again; do not serve until it says settled.`,
        });
      }
      if (!claim.claimed) return alreadySettled(claim.servedBy);
      if (args.mpp) tryStore(() => notes.dropPull(paymentNullifier));
      return settled(noteView(claim.note), claim.note.createdTx, extra);
    };

    // An earlier sweep of this same payment. Access is granted once: when a sweep confirms, or,
    // when it confirmed later than the verify that sent it, on the next verify.
    const earlier = notes.list().filter((n) => n.sweptFrom?.toLowerCase() === paymentNullifier.toLowerCase());
    /** One of the earlier sweeps is on chain now: serve it, once. */
    const serveEarlier = async (): Promise<ReturnType<typeof text> | null> => {
      const chain = sweepChain(client, net);
      let landed = earlier.find((n) => n.status === "unspent" || n.status === "spent");
      if (!landed) {
        for (const n of earlier) {
          if (await chain.isCommitmentSeen(n.commitment).catch(() => false)) {
            landed = n;
            break;
          }
        }
      }
      if (!landed) return null;
      return serveOnce(landed, { status: landed.status === "spent" ? "spent" : "unspent" }, { sweptBy: "an earlier sweep of this payment" });
    };
    if (earlier.length) {
      const served = earlier.find(servedPayment);
      if (served) return alreadySettled(served.handle);
      // The payment's spend is read before the fresh notes: a sweep spends the one and makes the other in one block.
      const spent = await sweepChain(client, net)
        .isSpent(paymentNullifier)
        .catch(() => null);
      const serve = await serveEarlier();
      if (serve) return serve;
      // None is on chain. One that may still land keeps the payment waiting; one that reverted, or whose
      // transaction the node never saw after the release window, cannot land.
      const tx = txReads(client);
      let waiting = false;
      for (const n of earlier) {
        // Ten minutes at least, even after a revert: a sweep that reverts for a reason that persists is not sent
        // again on every verify (and a relay's first copy may still show up).
        const stuck = Date.now() - Date.parse(n.updatedAt) > STUCK_MS;
        const dead = stuck && (n.status === "dead" || (await tx.reverted(n.createdTx)) || !n.createdTx || (await tx.unknown(n.createdTx)));
        if (!dead) waiting = true;
      }
      if (waiting || spent === null) {
        return text({
          status: "unconfirmed",
          grantAccess: false,
          final: false,
          message: "A sweep of this payment was sent and has not landed yet. Verify again shortly; do not serve until it says settled.",
          ...(earlier.at(-1)?.createdTx ? { hash: earlier.at(-1)!.createdTx } : {}),
        });
      }
      if (spent) {
        return text({
          status: "already_spent",
          grantAccess: false,
          final: false,
          message: "The payment note was spent by another transaction before this server's sweep landed, most likely by the payer who created it. Do not grant access.",
        });
      }
      // Still unspent, and no earlier sweep can land: sweep it again, a few times at most. Their fresh notes stay
      // until a refresh marks them dead.
      if (earlier.length > MAX_RESWEEPS) {
        // After that, once more only after a wait that doubles (an hour, two, four...), so a cause fixed later
        // (the RPC, the wallet's gas) still gets the payment swept and served.
        const last = Math.max(...earlier.map((n) => Date.parse(n.createdAt)));
        const next = last + RESWEEP_WAIT_MS * 2 ** (earlier.length - MAX_RESWEEPS - 1);
        if (Date.now() < next) {
          return text({
            status: "unconfirmed",
            grantAccess: false,
            final: false,
            message: `This payment was swept ${earlier.length} times and none landed. It is swept again after ${new Date(next).toISOString()}; check this server's RPC and wallet meanwhile. Do not serve until it says settled.`,
          });
        }
      }
    }

    if (!signer && !relay) {
      return text({
        status: "verified_not_final",
        grantAccess: false,
        final: false,
        finality: GLOAM_NOT_FINAL,
        message: "The payment checks out but this server cannot sweep it: set GLOAM_AGENT_PRIVATE_KEY, or GLOAM_USE_RELAY=1 to sweep through the Gloam relay. Until it is swept, do not grant access.",
        verify: verifyView,
      });
    }
    const submit = (intent: GloamIntent) =>
      relay
        ? deps.relay(intent, { url: relay })
        : walletSend(signer!, (wallet) =>
            wallet.writeContract({
              address: net.pool,
              abi: POOL_TRANSFER_ABI,
              functionName: "transfer",
              args: transferCallArgs(intent as Parameters<typeof transferCallArgs>[0]),
            })
          );

    // MPP pull: the payer handed over its proven transfer; it has to land before the note can be swept.
    let paymentHash: Hex | null = null;
    if (args.pull) {
      // Recorded before it goes out: if it lands while every read lags, a later verify (even past the
      // challenge's expiry) still finds this payment and serves it, once.
      try {
        if (args.mpp) notes.markPull(paymentNullifier, args.mpp.challengeId);
      } catch (e) {
        return text({ status: "error", grantAccess: false, final: false, error: `Could not record the payer's transfer before sending it (${errMsg(e)}). Nothing was sent; verify again.` });
      }
      let landed = false;
      // Sent, or maybe sent, without a confirmation yet: it may still land.
      let inFlight = false;
      try {
        paymentHash = await submit(payerTransferIntent(net.chainId, net.pool, args.pull));
        inFlight = true;
        const status = (await client.waitForTransactionReceipt({ hash: paymentHash })).status;
        landed = status === "success";
        if (!landed) inFlight = false;
      } catch (e) {
        landed = false;
        if (e instanceof WalletSendUnclear) paymentHash = e.hash;
        inFlight ||= mayHaveSent(e, Boolean(relay));
      }
      if (!landed) landed = await sweepChain(client, net).isCommitmentSeen(note.commitment).catch(() => false);
      if (!landed && inFlight) {
        return text({
          status: "unconfirmed",
          grantAccess: false,
          final: false,
          message: "The payer's transfer was sent but has not confirmed. Verify the same credential again once it lands; do not serve until then.",
          ...(paymentHash ? { hash: paymentHash } : {}),
        });
      }
      if (!landed) {
        return text({
          status: "rejected",
          grantAccess: false,
          final: false,
          message: "The payer's transfer did not go through (its note may have been spent elsewhere). Nothing was paid.",
          ...(paymentHash ? { hash: paymentHash } : {}),
        });
      }
    }

    let held: StoredNote | undefined;
    // Set when the sweep's send threw in a way that does not prove it stayed unsent.
    let sweepMaybeSent = false;
    // The sweep's hash when its send threw after the wallet broadcast it.
    let unclearHash: Hex | null = null;
    try {
      const sweep = await sweepReceivedNote({
        note,
        poolAddress: net.pool,
        chainId: net.chainId,
        prove: await deps.transferProver(net),
        chain: sweepChain(client, net),
        submit: (intent) =>
          submit(intent).then(
            (h) => {
              // Noted before the receipt wait, so a verify of the same payment meanwhile serves it with this hash.
              if (held) tryStore(() => notes.update(held!.handle, { createdTx: h }));
              return h;
            },
            (e: unknown) => {
              sweepMaybeSent = mayHaveSent(e, Boolean(relay));
              if (e instanceof WalletSendUnclear) {
                unclearHash = e.hash;
                const h = e.hash;
                if (held) tryStore(() => notes.update(held!.handle, { createdTx: h }));
              }
              // Tell the sweep, so it keeps the fresh note and never reads this as nothing moved.
              throw sweepMaybeSent && e instanceof Error ? Object.assign(e, { maybeSent: true }) : e;
            }
          ),
        // The fresh note's secret is the money: store it before the sweep is sent.
        beforeSubmit: (fresh) => {
          held = notes.add({
            network: net.key,
            chainId: net.chainId,
            pool: net.pool,
            asset: fresh.asset,
            symbol,
            decimals,
            amountWei: fresh.amountWei,
            secret: fresh.secret,
            commitment: fresh.commitment,
            nullifier: fresh.nullifier,
            status: "pending",
            pending: "create",
            origin: "received",
            createdTx: null,
            sweptFrom: paymentNullifier,
            served: false,
            label: args.label,
          });
        },
      });
      const sweepHash = sweep.hash ?? unclearHash;
      if (sweep.status === "swept") {
        // Another verify of this payment may have seen this sweep land and served it while this one waited for the receipt.
        return serveOnce(held!, { status: "unspent", createdTx: sweepHash }, {
          sweptBy: relay ? "gloam-relay" : "server wallet",
          ...(paymentHash ? { paymentSubmittedBy: relay ? "gloam-relay" : "server wallet", paymentHash } : {}),
        });
      }
      if (sweep.status === "already_spent" && earlier.length) {
        // Spent by an earlier sweep of this payment that landed after all, while this one was sent: serve that one.
        // (This one's fresh note, if it was sent, is kept dead: a relay's first copy of it may be the one that landed.)
        if (held) tryStore(() => (sweep.hash ? notes.markDead(held!.handle) : notes.remove(held!.handle)));
        const serve = await serveEarlier();
        if (serve) return serve;
      }
      if (sweep.status === "unconfirmed") {
        if (held && sweepHash) tryStore(() => notes.update(held!.handle, { createdTx: sweepHash }));
        return text({
          status: "unconfirmed",
          grantAccess: false,
          final: false,
          message: `${sweep.reason} Check with gloam_list_notes (refresh), then verify again.`,
          hash: sweepHash,
        });
      }
      if (sweep.status === "failed" && sweepMaybeSent) {
        // The relay or the RPC may have taken the sweep before its error, and the fresh note is the money if it lands: keep it pending.
        return text({
          status: "unconfirmed",
          grantAccess: false,
          final: false,
          message: "The sweep may have been sent and may still land. Check with gloam_list_notes (refresh), then verify again.",
          ...(sweepHash ? { hash: sweepHash } : {}),
        });
      }
      // Sent and reverted: kept dead (a relay's first copy may have landed, read by a node behind). Never sent: forgotten.
      if (held) tryStore(() => (sweep.hash ? notes.markDead(held!.handle) : notes.remove(held!.handle)));
      return text({
        status: sweep.status,
        grantAccess: false,
        final: false,
        message: sweep.reason,
        ...(sweep.hash ? { hash: sweep.hash } : {}),
      });
    } catch (e) {
      if (held) tryStore(() => notes.remove(held!.handle));
      return text({ status: "error", grantAccess: false, final: false, error: errMsg(e) });
    }
  }

  /**
   * gloam_verify_payment for an MPP credential (`Payment …`, method gloam, intent charge),
   * checked against `requirements`: the price of the resource being served. The challenge
   * alone shows only that this server issued it, not for which resource.
   */
  async function verifyMpp(payment: string, requirements: string | undefined, reject: Reject) {
    if (!requirements?.trim()) {
      return text({
        status: "error",
        grantAccess: false,
        error: "requirements is required for an MPP payment too: pass the price of the resource you are serving (the challenge's WWW-Authenticate value, or the encoded requirements), so the payment is checked against it.",
      });
    }
    let cred;
    try {
      cred = parseMppCredential(payment);
    } catch (e) {
      return reject(`The credential does not parse: ${errMsg(e)}`, { problem: "malformed-credential" });
    }
    const ch = cred.challenge;
    if (ch.method !== "gloam" || ch.intent !== "charge") {
      return reject(`This server settles gloam/charge, not ${ch.method}/${ch.intent}.`, { problem: "invalid-challenge" });
    }
    let secret: Uint8Array;
    try {
      secret = mppSecret(env);
    } catch (e) {
      return text({ status: "error", grantAccess: false, final: false, error: errMsg(e) });
    }
    if (!(await verifyChallengeId(ch, secret))) {
      return reject("The challenge in this credential was not issued by this server, or was changed.", { problem: "invalid-challenge" });
    }
    let request: GloamChargeRequest;
    try {
      request = parseGloamChargeRequest(ch.request);
    } catch (e) {
      return reject(errMsg(e), { problem: "invalid-challenge" });
    }
    // Bound to the price of the resource being served (the challenge alone proves only that this server issued it).
    {
      const priced = parsePriced(requirements);
      if ("error" in priced) return text({ status: "error", grantAccess: false, error: priced.error });
      const expected = priced.mpp ? parseGloamChargeRequest(priced.mpp.request) : fromPaymentRequirements(priced.req);
      const mismatch = termsMismatch(expected, request);
      if (mismatch) return reject(`The credential was issued for a different ${mismatch} than these requirements.`, { problem: "invalid-challenge" });
    }
    const md = request.methodDetails;
    const net = networkByChainId(md.chainId);
    if (!net || md.pool.toLowerCase() !== net.pool.toLowerCase()) {
      return reject(`This challenge names pool ${md.pool} on chain ${md.chainId}, which is not a Gloam pool. Not settling there.`);
    }
    const opened = openStore();
    if (!opened.ok) return text({ status: "error", grantAccess: false, error: opened.error });
    const notes = opened.store;
    const receiveKey = notes.receiveKey();
    if (!receiveKey) return reject("This server has no receive tag yet, so a sealed payment cannot be for it.");
    if (request.recipient.trim() !== receiveKey.tag) {
      return reject("The charge pays a receive tag that is not this server's, so this server cannot open the payment.");
    }
    // A challenge settles one payment: another payment for a challenge already used is refused before it is swept.
    const challengeTag = `(mpp ${ch.id})`;
    // From the signed terms only: the challenge's own description is not covered by its id, so a payer could put
    // any text there, and the label is shown to this server's agent.
    const label = `${request.description ?? ch.realm} ${challengeTag}`;
    const mppRef = { challengeId: ch.id, ...(request.externalId !== undefined ? { externalId: request.externalId } : {}) };
    // Swept by this server already? Ask before the chain checks, which would only see a spent note.
    let early: { note: NoteExport; nullifier: Hex; payload: GloamChargePayload } | null = null;
    try {
      const payload = parseGloamChargePayload(cred.payload);
      const note = await openGloamPaymentNote(payload.ticket, receiveKey);
      const nullifier = fieldToHex(await noteNullifierPoseidon(hexToField(note.secret), hexToField(note.commitment)));
      early = { note, nullifier, payload };
    } catch {
      // The full check below explains what is wrong with it.
    }
    const client = deps.signer(net)?.publicClient ?? deps.publicClient(net);
    const pulls = notes.pulls();
    const recorded = early ? notes.list().filter((n) => n.sweptFrom?.toLowerCase() === early!.nullifier.toLowerCase()) : [];
    const pulledFor = early ? pulls[early.nullifier.toLowerCase()]?.challenge : undefined;
    if (early && (recorded.length || pulledFor)) {
      // A payment this server took for this challenge (swept, or its pull transfer submitted): settled from its
      // record whatever the challenge's age, so a transfer or sweep that confirms late, or a sweep sent again
      // after ten minutes, still serves the payer, once.
      if (!recorded.some((n) => n.label?.endsWith(challengeTag)) && pulledFor !== ch.id) {
        return reject("This payment was made for another challenge from this server, and settles only under that one.", { problem: "invalid-challenge" });
      }
      if (!(await verifyPaymentNoteBinding(early.note))) return reject("The payment note's amount does not bind to its commitment.");
      const { note, nullifier, payload } = early;
      // A pull transfer that is not in the pool yet goes to the settle again (it lands once at most), unless its
      // note reads spent: then it landed and the commitment read lags (or its note went elsewhere), so wait.
      let pull: ValidatedGloamCharge["transfer"] | undefined;
      if (!recorded.length && payload.type === "transfer" && payload.transfer.newCommitments[0].toLowerCase() === note.commitment.toLowerCase()) {
        const chain = sweepChain(client, net);
        if (!(await chain.isCommitmentSeen(note.commitment).catch(() => false))) {
          if ((await chain.isSpent(payload.transfer.nullifier).catch(() => null)) !== false) {
            return text({
              status: "unconfirmed",
              grantAccess: false,
              final: false,
              message: "The payer's transfer may already be on chain (its note reads spent, or could not be read), but its payment does not show yet. Verify the same credential again shortly; do not serve until it says settled.",
            });
          }
          pull = payload.transfer;
        }
      }
      const verifyView = { ok: true, reason: null, sealed: true, amountWei: note.amountWei, asset: note.asset, mode: payload.type === "hash" ? "push" : "pull" };
      return settleReceived({ net, notes, note, paymentNullifier: nullifier, label, sealed: true, verifyView, ...(pull ? { pull } : {}), mpp: mppRef });
    }
    // No payment recorded for it: an expired challenge is refused.
    if (isExpired(ch)) return reject("The challenge has expired.", { problem: "payment-expired" });
    const usedBy =
      notes.list().find((n) => n.origin === "received" && n.label?.endsWith(challengeTag))?.handle ??
      (Object.values(pulls).some((p) => p.challenge === ch.id) ? "a payer's transfer this server submitted" : undefined);
    if (usedBy) {
      return reject(`This challenge was already paid and used (${usedBy}). The payer should request the resource again for a fresh challenge.`, {
        problem: "invalid-challenge",
      });
    }
    const notUsed = async (): Promise<never> => {
      throw new Error("not used while validating");
    };
    let v: ValidatedGloamCharge;
    try {
      v = await validateGloamCharge({
        challenge: ch,
        payload: cred.payload,
        config: {
          receiveKey,
          chain: mppChain(
            sweepChain(client, net),
            (a) => client.getTransactionReceipt(a),
            typeof client.call === "function" ? (a) => client.call(a) : undefined
          ),
          prove: notUsed,
          submit: notUsed,
          pools: { [net.chainId]: net.pool },
        },
      });
    } catch (e) {
      if (e instanceof GloamChargeError) {
        return reject(e.message, { problem: e.code, ...(e.retryable ? { retryable: true } : {}) });
      }
      return text({ status: "error", grantAccess: false, final: false, error: errMsg(e) });
    }
    // Do not echo the commitment back: it names the leaf this server now owns.
    const verifyView = { ok: true, reason: null, sealed: true, amountWei: v.note.amountWei, asset: v.note.asset, mode: v.mode };
    return settleReceived({
      net,
      notes,
      note: v.note,
      paymentNullifier: v.paymentNullifier,
      label,
      sealed: true,
      verifyView,
      ...(v.mode === "pull" && !v.landed ? { pull: v.transfer } : {}),
      mpp: mppRef,
    });
  }

  server.registerTool(
    "gloam_verify_payment",
    {
      title: "Verify and settle a private payment (x402 or MPP)",
      description:
        "SERVER side. Check a presented payment and make it final: an x402 X-PAYMENT value against its requirements, or an MPP credential (the Authorization: Payment value, method gloam) against the challenge it echoes, which must be one this server issued for this price (pass the price as requirements in both cases). Opens the payment note with this server's receive key, checks it binds the required amount and asset in the right pool (and, for MPP, that it is the payment output of a Transferred event and bound to that challenge), then sweeps it into a fresh note only this server knows and waits for that to confirm. Grant access only when the result says grantAccess: true; for MPP, serve with its paymentReceipt as the Payment-Receipt header. A payer creates the payment note, so without the sweep it could spend the money back after being served. Needs GLOAM_AGENT_PRIVATE_KEY or the relay (GLOAM_USE_RELAY=1) to sweep.",
      inputSchema: {
        requirements: z
          .string()
          .optional()
          .describe("The price of the resource you are serving: x402 requirements (encoded or raw JSON), or the MPP challenge (WWW-Authenticate value). Required for both x402 and MPP: the payment must match this price."),
        payment: z.string().describe("The X-PAYMENT header value (or raw JSON payload), or the MPP Authorization: Payment value presented by the payer."),
      },
    },
    async ({ requirements, payment }) => {
      const reject: Reject = (message, extra = {}) => text({ status: "rejected", grantAccess: false, final: false, message, ...extra });
      if (looksLikeMpp(payment)) return verifyMpp(payment, requirements, reject);
      if (!requirements) return text({ status: "error", error: "requirements is required for an x402 payment: pass the requirements you issued." });
      const req = parseRequirements(requirements);
      if (!req) return text({ status: "error", error: "Could not parse requirements." });
      const pay = parsePayment(payment);
      if (!pay?.payload?.paymentNote) return text({ status: "error", error: "Could not parse payment." });

      const net = networkByChainId(Number(req.network));
      if (!net || String(req.poolAddress).toLowerCase() !== net.pool.toLowerCase()) {
        return reject(`These requirements name pool ${req.poolAddress} on chain ${req.network}, which is not a Gloam pool. Not settling there.`);
      }
      const opened = openStore();
      if (!opened.ok) return text({ status: "error", grantAccess: false, error: opened.error });
      const notes = opened.store;
      const receiveKey = notes.receiveKey();
      const sealed = isSealedTicket(pay.payload.paymentNote);
      if (sealed && !receiveKey) return reject("This server has no receive tag yet, so a sealed payment cannot be for it.");
      if (sealed && receiveKey && String(req.payTo).trim() !== receiveKey.tag) {
        return reject("payTo in these requirements is not this server's receive tag, so this server cannot open the payment.");
      }
      let note: NoteExport;
      try {
        note = await openGloamPaymentNote(pay.payload.paymentNote, receiveKey ?? undefined);
      } catch (e) {
        return reject(`Could not open the payment note: ${errMsg(e)}`);
      }
      // A note claiming amount + p (or secret + p) opens the same commitment as the real one.
      const notCanonical = noteFieldProblem(note);
      if (notCanonical) return reject(`The payment note is not canonical: ${notCanonical}`);
      if (BigInt(note.amountWei) <= 0n) return reject("The payment note carries no value.");
      const verify = verifyGloamPayment({ requirements: req, payload: pay, note });
      // Do not echo the commitment back: it names the leaf this server now owns.
      const verifyView = { ok: verify.ok, reason: verify.reason, sealed: verify.sealed, amountWei: verify.amountWei, asset: verify.asset };
      if (!verify.ok) return reject(verify.reason ?? "The payment did not verify.", { verify: verifyView });
      // A structural pass alone would trust a lying payer; the amount must bind to the commitment.
      if (!(await verifyPaymentNoteBinding(note))) return reject("The payment note's amount does not bind to its commitment.");
      // Made as this payment by its payer, not a sealed ticket copied from the payment board: a payment
      // made with the app or a payment request posts its ticket there, where anyone can read it.
      // GLOAM_X402_ALLOW_UNBOUND=1 takes payments from payers older than the binding (and copies with them).
      const unbound = await checkGloamPaymentBinding({ requirements: req, payload: pay, note, allowUnbound: env.GLOAM_X402_ALLOW_UNBOUND?.trim() === "1" });
      if (unbound) return reject(unbound, { problem: "unbound-payment" });
      const paymentNullifier = fieldToHex(await noteNullifierPoseidon(hexToField(note.secret), hexToField(note.commitment)));
      return settleReceived({ net, notes, note, paymentNullifier, label: req.resource, sealed, verifyView });
    }
  );

  // ── spending limits ─────────────────────────────────────────────────────────

  server.registerTool(
    "gloam_get_limits",
    {
      title: "Spending limits",
      description:
        "This agent's spending limits as the owner set them: which money tools it may use, which assets, the cap per payment and per rolling 24 hours, allowed recipients, and when its permission expires. Check this before planning a payment. This MCP server enforces them before it signs (off-chain). When the agent's key is a Tempo access key, the result also has `onchain`: the owner's AccountKeychain authorization (expiry, the remaining periodic limit and call scopes), which the Tempo protocol enforces on every transaction whatever this server does. The vault contract itself does not know about limits.",
    },
    async () => {
      const report = limitsReport(env);
      let setup: ReturnType<typeof signerSetup>;
      try {
        setup = signerSetup(env);
      } catch (e) {
        return text({ ...report, onchain: { error: errMsg(e) } });
      }
      if (setup.mode !== "access-key") return text(report);
      try {
        const tempoNet = tempoAccessNetwork(env);
        const onchain = await checkAccessKey({ owner: setup.owner, keyId: setup.keyAddress, network: tempoNet }, deps.publicClient(tempoNet));
        return text({ ...report, onchain });
      } catch (e) {
        return text({ ...report, onchain: { error: `Could not read the access key's onchain state: ${errMsg(e)}` } });
      }
    }
  );

  server.registerTool(
    "gloam_get_spending_report",
    {
      title: "Spending report",
      description:
        "What this agent has spent in the last 24 hours and how much is left under its daily limit, per asset, plus its most recent payments and any refused attempts. Read from the local spending log this server keeps.",
      inputSchema: {
        recent: z.number().int().min(1).max(50).default(10).describe("How many recent payments to list."),
      },
    },
    async ({ recent }) => text(spendingReport(recent, env))
  );

  return server;
}
