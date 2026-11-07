/**
 * Gloam relay, server side.
 *
 * Submits already-proven private sends, cash outs and payment memos from a
 * Gloam relay account, so the user's own wallet never appears next to them on
 * a block explorer. The pool never checks msg.sender on transfer/unshield (the
 * Groth16 proof is the authorization, and unshield binds the recipient inside
 * the proof), so relaying cannot redirect funds. A relay can refuse or delay a
 * send. Holding a swap's proofs, it can also send the swap's first step alone,
 * which brings the money back as the refund note, at that note's cost.
 *
 * Guard rails:
 *   - only the active pool's transfer/unshield and the memo board's postMemo,
 *     plus, with GLOAM_RELAY_GAS_STATION=on, Borro's gas station factory's make
 *     and a wallet's own station's pump (lib/relay/gasStation): a request never
 *     names a target
 *   - one request per spend at a time: a send or cash out takes a lock on its
 *     nullifier, shared across instances (lib/relay/inflight, Redis only: when
 *     Redis is set but not answering, or a production build has none, the
 *     relay is off and sends nothing), before anything is read from the chain, so copies of one proof sent together cannot each
 *     pass the dry run and then revert at the relay's expense; the lock is
 *     dropped if nothing went out or the receipt shows the transaction
 *     reverted, and otherwise kept until it expires once a transaction did
 *   - spent and root check on every send and cash out, before the dry run, so
 *     a spent note never reaches the gas estimate
 *   - dry run (gas estimate against the pool) before anything is sent, so a bad
 *     proof, a spent note or a stale root costs the relay nothing
 *   - no cash out to the vault itself, the memo board, a token contract, a
 *     swap router or the zero address (lib/cashOutTarget), which would strand
 *     the money, nor to a swap's escrow the relay was asked to send a swap to
 *     (assertNotSwapEscrow): a swap's unshield is only ever sent as its swap
 *   - memos only for commitments the pool has actually inserted, and no larger
 *     than a real sealed ticket needs (RELAY_MEMO_MAX_BYTES)
 *   - sanctions screening of every public recipient (a cash out's `to`) before
 *     anything is checked or sent (lib/screeningServer.ts), plus on Tempo the
 *     asset's TIP-403 issuer policy for the vault and `to`; private sends and
 *     memos carry no public address, so there is nothing to screen
 *   - a gas ceiling per chain (lib/relay/gasCeiling: 3 gwei on Ethereum by
 *     default, none on the L2s): above it nothing is sent and the request is
 *     refused as gas_high, and a send under it never offers more than 1.5
 *     times the ceiling per unit of gas
 *   - a floor under a private swap where gas is dear (lib/relay/swapFloor): its
 *     vault fee must cover the swap's own gas, or it is refused as swap_small
 *     before anything is sent, with hourly gas budgets for what reverts there
 *   - a refund or an exit goes only for an escrow the vault paid: the unshield's
 *     receipt must show it, for that note and that amount
 *   - an hourly spend cap per chain across every kind of send, with a part kept for
 *     cash outs, refunds and exits, the last of it for refunds and exits alone, and
 *     a share of it for each sender (lib/relay/spendCap)
 *   - per-sender and per-network rate limits, shared across instances (the
 *     network cap counts only transactions actually sent: a send refused after
 *     its slot was taken gives the slot back), and a few relayed payment
 *     messages per payment: the payer's own (with the memo ticket the transfer
 *     handed back), each partner account's, and one small allowance that
 *     everyone else shares, none of them kept by IP
 *
 * Submission is free for the user on every network, mainnet included: the relay
 * pays the gas. A relay fee would need its own public output inside the circuit,
 * which the mainnet pools do not have, so at launch the Gloam team pays mainnet
 * gas from the relay account. The only fee on mainnet is the pool's on a cash out, 0.5%.
 *
 * Key: GLOAM_RELAYER_PRIVATE_KEY (server env only, never NEXT_PUBLIC_). With no
 * key set the relay reports itself disabled and the app falls back to wallet
 * submission. GLOAM_RELAY_MEMO_SECRET (server only, 32 characters or more)
 * signs the memo tickets; unset, no tickets go out and every payment message
 * but a partner key's shares the small allowance.
 */
import {
  BaseError,
  ContractFunctionRevertedError,
  HttpRequestError,
  TimeoutError,
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  keccak256,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { after } from "next/server";
import { createHmac, timingSafeEqual } from "crypto";
import {
  NETWORK_KEYS,
  getNetwork,
  isNetworkWritable,
  type GloamNetwork,
} from "@/lib/networks";
import { SharedCountUnavailable, addRateCount, hitRateLimit, readRateLimit } from "@/lib/mcpRemote/rateLimit";
import { SCREEN_BLOCKED_MESSAGE } from "@/lib/screening";
import { screenAddresses } from "@/lib/screeningServer";
import { TIP403_RECEIVE_UNCHECKED_MESSAGE } from "@/lib/tip403";
import { cashOutTargetProblem } from "@/lib/cashOutTarget";
import { LockStoreDown, RECEIPT_WATCH_MS, forgetNonce, inSendLanes, inflightKey, isSwapEscrow, markSwapEscrow, relayStoreDown, releaseIfReverted, takeInflight, type InflightLock } from "@/lib/relay/inflight";
import { jobKeyReady } from "@/lib/relay/jobSeal";
import { datedOff } from "@/lib/relay/scheduled";
import { WrongChainRpcError, serverTransport } from "@/lib/serverRpc";
import { SWAP_SEND_MARGIN_SECONDS, encodeRoute, escrowAddress, isKnownRoute, isSwapAsset, receiptPaysEscrow, swapExpired, swapRouterFor, vaultSwapAbi, vaultSwapRouter, vaultSwapV3Abi, type EscrowKey, type PoolKey } from "@/lib/vaultSwap";
import { knownTokens } from "@/lib/tokens";
import { GAS_HIGH_CODE, formatGwei, gasHighMessage, maxFeeCapWei, maxGasPriceWei as maxGasPriceWeiFor, readGas } from "@/lib/relay/gasCeiling";
import { ETH_USD_FEED, FEED_MAX_AGE_SEC, ethUsdFeedAbi, hasSwapFloor, smallestSwapUsd, swapFloorMessage } from "@/lib/relay/swapFloor";
import {
  BACK_SENDS,
  BACK_SHARE_PCT,
  CASH_OUT_SHARE_PCT,
  L1_FEE_MARGIN_PCT,
  MAX_SENDER_SHARE_PCT,
  MEMO_SPEND_SHARE_PCT,
  NEW_SEND_SHARE_PCT,
  PAYROLL_SENDS,
  hourlySpendWei,
  ipSendsLimit,
  senderSharePct,
} from "@/lib/relay/spendCap";
import { GAS_STATION_CHAIN_ID, GAS_STATION_FACTORY, gasStationAbi, gasStationFactoryAbi, readStationState } from "@/lib/gasStation";
import {
  STATION_BAD_STEP_MESSAGE,
  STATION_BUSY_MESSAGE,
  STATION_ESTIMATE_MESSAGE,
  STATION_GAS_HIGH_MESSAGE,
  STATION_IN_FLIGHT_MESSAGE,
  STATION_IP_HOURLY,
  STATION_IP_LIMIT_MESSAGE,
  STATION_MAX_ESTIMATE,
  STATION_MAX_GAS_PRICE_WEI,
  STATION_NETWORK_MESSAGE,
  STATION_NO_FILL_MESSAGE,
  STATION_OFF_MESSAGE,
  STATION_WALLET_DAILY,
  STATION_WALLET_LIMIT_MESSAGE,
  gasStationDailySends,
  gasStationOn,
  pumpMaxIn,
  pumpMinOut,
  stationRefusal,
} from "@/lib/relay/gasStation";

const POOL_ERRORS = [
  "ZeroCommitment",
  "AlreadySpent",
  "UnknownRoot",
  "VerifierNotSet",
  "InvalidProof",
  "ZeroAddress",
  "TransferFailed",
  "InvalidAmount",
  "InsufficientPoolBalance",
  "DuplicateCommitment",
  "Reentrancy",
].map((name) => ({ type: "error" as const, name, inputs: [] }));

export const relayPoolAbi = [
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "proof", type: "bytes" },
      { name: "root", type: "bytes32" },
      { name: "nullifier", type: "bytes32" },
      { name: "newCommitments", type: "bytes32[2]" },
    ],
    outputs: [],
  },
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
  {
    type: "function",
    name: "spent",
    stateMutability: "view",
    inputs: [{ name: "", type: "bytes32" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "commitmentSeen",
    stateMutability: "view",
    inputs: [{ name: "", type: "bytes32" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "isKnownRoot",
    stateMutability: "view",
    inputs: [{ name: "root", type: "bytes32" }],
    outputs: [{ name: "", type: "bool" }],
  },
  ...POOL_ERRORS,
] as const;

const memoAbi = [
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
  { type: "error", name: "ZeroCommitment", inputs: [] },
  { type: "error", name: "BadMemo", inputs: [] },
] as const;

/** Plain-language reasons for pool reverts (shown to the user). */
const REVERT_MESSAGES: Record<string, string> = {
  AlreadySpent: "This money was already spent. Refresh your balance.",
  UnknownRoot: "Your view of the vault is out of date. Refresh and try again.",
  InvalidProof: "The payment proof did not check out. Refresh and try again.",
  InsufficientPoolBalance: "The vault does not hold enough of this asset to cash out right now.",
  DuplicateCommitment: "This payment was already submitted.",
  VerifierNotSet: "This vault is not fully set up yet.",
  InvalidAmount: "That amount is not valid.",
  ZeroAddress: "Missing a destination address.",
  BadMemo: "The payment message is too large.",
  OverInput: "The price moved since the quote. Get a new one and try again.",
  ShortOutput: "The price moved since the quote. Get a new one and try again.",
  OverDepositLimit: "The vault is not taking that much of this asset right now. Swap a smaller amount.",
  BadExit: "This exit can't go to that address, its signature doesn't match the swap, or its money has already left.",
  ReceiveBlocked: "The receiving wallet won't take this payment from Gloam, so the exit didn't go. Pick another address.",
  EscrowUsed: "This swap's money has already left its escrow.",
  EscrowFailed: "This swap's escrow couldn't pay out, so nothing moved. Try again.",
  TokenCallFailed: "The token refused this payment, so nothing moved.",
  SwapExpired: "This swap's time ran out. Get a new quote and try again.",
  PoolNotAllowed: "This swap route is not allowed.",
  BadRoute: "This swap route is not allowed.",
  NativeRefused: "This swap route is not allowed.",
  FeeOnTransferNotSupported: "This token cannot be swapped into the vault.",
};

/** The router's call, with the vault's errors it can bubble up, for plain-language reverts. */
const swapCallAbi = [
  ...vaultSwapAbi,
  ...POOL_ERRORS,
  { type: "error" as const, name: "OverDepositLimit", inputs: [] },
  { type: "error" as const, name: "FeeOnTransferNotSupported", inputs: [] },
] as const;

/** v3's calls, with the same vault errors. */
const swapV3CallAbi = [
  ...vaultSwapV3Abi,
  ...POOL_ERRORS,
  { type: "error" as const, name: "OverDepositLimit", inputs: [] },
  { type: "error" as const, name: "FeeOnTransferNotSupported", inputs: [] },
] as const;

export class RelayError extends Error {
  constructor(
    message: string,
    public status = 400,
    public code = "bad_request"
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------- config

let cachedAccounts: PrivateKeyAccount[] | undefined;

/**
 * Every relay account: GLOAM_RELAYER_PRIVATE_KEY, then any extra keys in
 * GLOAM_RELAYER_PRIVATE_KEYS (comma separated). Each sends on its own lane, so
 * more funded keys means more payments sent at the same moment.
 */
export function relayerAccounts(): PrivateKeyAccount[] {
  if (cachedAccounts) return cachedAccounts;
  const raws = [process.env.GLOAM_RELAYER_PRIVATE_KEY, ...(process.env.GLOAM_RELAYER_PRIVATE_KEYS ?? "").split(",")]
    .map((r) => r?.trim())
    .filter((r): r is string => Boolean(r));
  const seen = new Set<string>();
  const out: PrivateKeyAccount[] = [];
  for (const raw of raws) {
    const key = (raw.startsWith("0x") ? raw : `0x${raw}`) as Hex;
    if (!/^0x[0-9a-fA-F]{64}$/.test(key)) continue;
    const account = privateKeyToAccount(key);
    if (seen.has(account.address)) continue;
    seen.add(account.address);
    out.push(account);
  }
  return (cachedAccounts = out);
}

/** The first relay account (the one the status names). */
export function relayerAccount(): PrivateKeyAccount | null {
  return relayerAccounts()[0] ?? null;
}

export function relayNetworks(): GloamNetwork[] {
  return NETWORK_KEYS.map(getNetwork).filter(isNetworkWritable);
}

export function networkForChain(chainId: unknown): GloamNetwork {
  const id = typeof chainId === "number" ? chainId : Number(chainId);
  const net = relayNetworks().find((n) => n.chainId === id);
  if (!net || !net.pool) {
    throw new RelayError("This network is not supported by the relay.", 400, "network");
  }
  return net;
}

const publicClients = new Map<number, PublicClient>();

export function relayPublicClient(net: GloamNetwork): PublicClient {
  const hit = publicClients.get(net.chainId);
  if (hit) return hit;
  const c = createPublicClient({
    chain: net.chain,
    ccipRead: false,
    transport: serverTransport(net, { timeout: 20_000, retryCount: 1 }),
  });
  publicClients.set(net.chainId, c);
  return c;
}

/**
 * A send goes out once, to one RPC: no retry, and never replayed on the public
 * backup (lib/serverRpc sendOnce). A copy of a send the node already took can
 * only revert, or come back as a nonce clash that hides the first one.
 */
function walletFor(net: GloamNetwork, account: PrivateKeyAccount) {
  return createWalletClient({
    account,
    chain: net.chain,
    transport: serverTransport(net, { timeout: 30_000, retryCount: 0 }, { sendOnce: true }),
  });
}

// ---------------------------------------------------------------- limits

// Shared across server instances (lib/mcpRemote/rateLimit: Upstash Redis, or
// process memory when it is not set or does not answer).
const WINDOW_SEC = 10 * 60;
// A payroll run is up to 200 payments plus 200 notifications.
const PER_IP = 400;
/** Sends, cash outs and swaps the relay actually sends per network per hour. Refused requests and payment messages never count. */
const PER_NETWORK_HOURLY = 5_000;
/**
 * Relayed payment messages per payment per day: for the payer, who holds the
 * payment's memo ticket, and for each partner key (one is needed, the rest
 * covers retries), and for everyone else together, so nobody can spend the
 * relay's gas posting junk for payments that are already in the vault.
 */
const MEMOS_PER_PAYMENT = 3;
const MEMOS_PER_PAYMENT_ALL = 10;
/**
 * Payment messages have network budgets of their own, apart from sends
 * (GHSA-5gwv-jpjr-x34r): a message needs no note or proof, only a commitment
 * that is public on chain, so messages must never use up the slots that sends,
 * cash outs and swaps need. Messages with the payer's ticket or an approved
 * partner's key share one budget (a ticket only comes with a transfer the relay sent);
 * everyone else's share a smaller one, smaller still where gas is dear (a
 * chain with a gas ceiling), which caps the gas strangers can make the relay
 * spend in an hour. When it is used up, a heads-up can still go from the wallet.
 */
const PER_NETWORK_MEMO_HOURLY = 5_000;
const PER_NETWORK_OPEN_MEMO_HOURLY = 600;
const PER_NETWORK_OPEN_MEMO_HOURLY_DEAR_GAS = 60;
/**
 * Messages sent with a partner key share the paid budget only when a Gloam admin
 * approved the account (Partner.relayApproved). Anyone can make an account and keys,
 * so every other account's keys share one budget, together, the same size as the
 * one for messages sent with no key. Messages outside the paid budget also hold
 * against their own share of the hourly spend cap (lib/relay/spendCap).
 */
const PER_NETWORK_KEY_MEMO_HOURLY = PER_NETWORK_OPEN_MEMO_HOURLY;
const PER_NETWORK_KEY_MEMO_HOURLY_DEAR_GAS = PER_NETWORK_OPEN_MEMO_HOURLY_DEAR_GAS;
/**
 * Hourly gas budgets where gas is dear (lib/relay/swapFloor). A swap or a refund that
 * reverts after it was sent pays nothing back, so each kind has its own budget. A send
 * holds its gas limit against its budget when it goes, and gives back what the receipt
 * shows it didn't burn, so a landing nobody saw stays counted. A refund or exit under
 * the swap floor is paid for by nobody, so its gas stays counted too. Past the budget,
 * new swaps wait for the next hour, and so does a refund or exit under the floor. One at
 * or over the floor goes regardless. One note or escrow can revert NOTE_REVERTS_HOURLY
 * times an hour before it waits, alone, so it can't use the budget up for everyone.
 */
const SWAP_REVERT_GAS_HOURLY = 20_000_000;
const WAITING_GAS_HOURLY = 30_000_000;
const NOTE_REVERTS_HOURLY = 2;
export const SWAPS_PAUSED_MESSAGE = "Swaps are paused here for a short while. Your money is safe. Try again in an hour.";
export const NOTE_WAIT_MESSAGE = "This balance can't try that again yet. Your money is safe. Try again in an hour.";
export const SPEND_CAP_MESSAGE = "The relay has reached its limit for this hour on this network. Try again later or send from your wallet.";
export const SENDER_SHARE_MESSAGE = "You've reached your share of the relay for this hour on this network. Try again later or send from your wallet.";
export const BACK_SHARE_MESSAGE = "You've reached your share of the relay's refunds and exits for this hour on this network. Try again later.";

export const MEMO_BUSY_MESSAGE =
  "The relay can't post more payment messages on this network right now. Try again later, or send the heads-up from your wallet.";

export const RELAY_OFF_MESSAGE = "The relay is off on this network right now. Send from your wallet.";

/** Nothing was sent: the relay's shared store (Redis) can't keep its locks and counts right now. */
function relayOff(): RelayError {
  return new RelayError(RELAY_OFF_MESSAGE, 503, "relay_off");
}

/**
 * One of the relay's shared counts. It fails closed: when Redis is set but
 * does not answer (or a production build has none), the relay sends nothing,
 * since counts kept per instance could not hold anyone to a limit.
 */
async function relayCount(key: string, bucket: string, limit: number, now: number, windowSec: number) {
  try {
    return await hitRateLimit(key, bucket, limit, now, windowSec, { failClosed: true });
  } catch (e) {
    if (!(e instanceof SharedCountUnavailable)) throw e;
    relayStoreDown(e.reason);
    throw relayOff();
  }
}

/** Per-sender limit (an IP, or an API key), checked before anything else. */
export async function checkRateLimit(requester: string): Promise<void> {
  if (!(await relayCount(requester, "relay-ip", PER_IP, Date.now(), WINDOW_SEC)).allowed) {
    throw new RelayError("Too many requests from this device. Wait a few minutes.", 429, "rate_limit");
  }
}

/** The same on a chain with a lower limit of its own (lib/relay/spendCap): a send asked for by one sender there. */
export async function checkChainRateLimit(net: GloamNetwork, requester: string): Promise<void> {
  const limit = ipSendsLimit(net.chainId);
  if (limit === null) return;
  if (!(await relayCount(requester, `relay-ip-${net.chainId}`, limit, Date.now(), WINDOW_SEC)).allowed) {
    throw new RelayError("Too many requests from this device. Wait a few minutes.", 429, "rate_limit");
  }
}

// ---------------------------------------------------------------- holds

/** How a send ended, from its receipt. */
type SendEnd = { status: "success" | "reverted"; gasUsed: bigint; priceWei: bigint; extraWei: bigint };

/** An amount held against an hourly count while a send is out. `keeps` says what stays counted once it ended. */
type Hold = { owner: string; bucket: string; at: number; amount: number; keeps: (end: SendEnd) => number };

async function addToCount(owner: string, bucket: string, delta: number, at: number): Promise<number> {
  try {
    return await addRateCount(owner, bucket, delta, at, 3600, { failClosed: true });
  } catch (e) {
    if (!(e instanceof SharedCountUnavailable)) throw e;
    relayStoreDown(e.reason);
    throw relayOff();
  }
}

/** Holds `amount` of `bucket`, or null when that would pass `limit`. With no limit it always holds. */
async function takeHold(owner: string, bucket: string, amount: number, limit: number | null, keeps: Hold["keeps"]): Promise<Hold | null> {
  const at = Date.now();
  const total = await addToCount(owner, bucket, amount, at);
  if (limit !== null && total > limit) {
    await addToCount(owner, bucket, -amount, at);
    return null;
  }
  return { owner, bucket, at, amount, keeps };
}

/** Gives every hold back: nothing went out. Never throws, as what failed is the send. */
async function dropHolds(holds: Hold[]): Promise<void> {
  await Promise.all(holds.map((h) => addToCount(h.owner, h.bucket, -h.amount, h.at).catch(() => 0)));
}

/** Leaves what `end` says stays counted, and gives back the rest. */
async function settleHolds(holds: Hold[], end: SendEnd): Promise<void> {
  await Promise.all(holds.map((h) => addToCount(h.owner, h.bucket, h.keeps(end) - h.amount, h.at).catch(() => 0)));
}

// ---------------------------------------------------------------- memo tickets

/** Shortest GLOAM_RELAY_MEMO_SECRET taken; anything shorter counts as unset (a ticket in hand lets anyone guess at it offline). */
const MEMO_SECRET_MIN = 32;
let warnedShortSecret = false;

function memoSecret(): string | null {
  const s = process.env.GLOAM_RELAY_MEMO_SECRET?.trim();
  if (!s) return null;
  if (s.length < MEMO_SECRET_MIN) {
    if (!warnedShortSecret) console.warn("gloam_relay_memo_secret_short", JSON.stringify({ min: MEMO_SECRET_MIN }));
    warnedShortSecret = true;
    return null;
  }
  return s;
}

/**
 * The payer's ticket for a payment's message: HMAC-SHA256 under
 * GLOAM_RELAY_MEMO_SECRET of the chain and the payment commitment, base64url.
 * The relay hands it back with the transfer it relayed, so only whoever sent
 * that transfer through it holds one, and their heads-up gets its own few
 * messages that strangers can't use up (commitments are public on chain).
 * Null when the secret is unset or too short: then nobody holds a ticket and
 * every message but a partner key's shares the strangers' allowance.
 */
export function memoTicket(chainId: number, commitment: string): string | null {
  const secret = memoSecret();
  if (!secret) return null;
  return createHmac("sha256", secret).update(`${chainId}:${commitment.toLowerCase()}`).digest("base64url");
}

function memoTicketOk(chainId: number, commitment: Hex, ticket: unknown): boolean {
  if (typeof ticket !== "string" || ticket.length > 64) return false;
  const want = memoTicket(chainId, commitment);
  if (!want) return false;
  const a = Buffer.from(ticket);
  const b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * One relay transaction on this network, held once it passed every check, the dry run
 * and the spend cap, and given back if it doesn't go out. Kept whatever its receipt says.
 */
async function holdNetworkSlot(net: GloamNetwork): Promise<Hold> {
  const held = await takeHold(`chain:${net.chainId}`, "relay-net", 1, PER_NETWORK_HOURLY, () => 1);
  if (!held) throw new RelayError("The relay is busy. Try again shortly or send from your wallet.", 429, "rate_limit");
  return held;
}

/** One relayed payment message on this network, from its own budget, never a send's. Held as a send's slot is. */
async function holdMemoSlot(net: GloamNetwork, budget: MemoBudget): Promise<Hold> {
  const dear = maxGasPriceWeiFor(net.chainId) !== null;
  const [bucket, limit] =
    budget === "open"
      ? ["relay-memo-open-net", dear ? PER_NETWORK_OPEN_MEMO_HOURLY_DEAR_GAS : PER_NETWORK_OPEN_MEMO_HOURLY]
      : budget === "key"
        ? ["relay-memo-key-net", dear ? PER_NETWORK_KEY_MEMO_HOURLY_DEAR_GAS : PER_NETWORK_KEY_MEMO_HOURLY]
        : ["relay-memo-net", PER_NETWORK_MEMO_HOURLY];
  const held = await takeHold(`chain:${net.chainId}`, bucket, 1, limit, () => 1);
  if (!held) throw new RelayError(MEMO_BUSY_MESSAGE, 429, "memo_busy");
  return held;
}

// ---------------------------------------------------------------- validation

const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export function asBytes32(v: unknown, field: string): Hex {
  if (typeof v !== "string" || !BYTES32.test(v)) throw new RelayError(`Invalid ${field}.`);
  return v as Hex;
}

export function asAddress(v: unknown, field: string): Address {
  if (typeof v !== "string" || !ADDRESS.test(v)) throw new RelayError(`Invalid ${field}.`);
  return v as Address;
}

export function asProof(v: unknown): Hex {
  // Groth16 proof bytes: a handful of field elements, never more than 2 KB.
  if (typeof v !== "string" || !/^0x([0-9a-fA-F]{2}){64,2048}$/.test(v)) {
    throw new RelayError("Invalid proof.");
  }
  return v as Hex;
}

export function asAmount(v: unknown): bigint {
  if (typeof v !== "string" || !/^\d{1,78}$/.test(v)) throw new RelayError("Invalid amount.");
  const n = BigInt(v);
  if (n <= 0n) throw new RelayError("Invalid amount.");
  return n;
}

/**
 * Largest payment message the relay posts, in bytes. The memo board itself
 * takes up to 8192 (GloamPayMemo.MAX_MEMO), but a real message is always a
 * sealed ticket, and the largest one is 1739 bytes:
 *
 *   note JSON   376 bytes with no note (pool and asset addresses, a 78-digit
 *               amount, the secret and the commitment), plus the chain
 *               `,"ch":11155111` (14, an 8-digit chain id), `,"n":""` (7)
 *               and the note: 80 characters at 6 bytes each at worst once
 *               JSON escapes them (a lone surrogate becomes \uXXXX; emoji are
 *               4), so 480. Total 877.
 *   gloam1.     7 + base64url(877) = 7 + 1170 = 1177
 *   sealed      2 + 91 (P-256 key) + 12 (IV) + 1177 + 16 (GCM tag) = 1298
 *   gloam2t.    8 + base64url(1298) = 8 + 1731 = 1739
 *
 * The app pads every ticket before sealing it (lib/receiveTag padSealed) to
 * 512, 1024 or at most 1177 bytes, so padding never takes one past 1739.
 *
 * 2048 leaves 309 bytes over that worst case (over 550 for a note of real
 * characters), and a junk message costs the relay a quarter of what the board
 * would take.
 */
export const RELAY_MEMO_MAX_BYTES = 2048;

export function asMemo(v: unknown): Hex {
  if (typeof v !== "string") throw new RelayError("Invalid payment message.");
  if (v.length > 2 + 2 * RELAY_MEMO_MAX_BYTES) throw new RelayError(REVERT_MESSAGES.BadMemo);
  if (!/^0x(?:[0-9a-fA-F]{2})+$/.test(v)) throw new RelayError("Invalid payment message.");
  return v as Hex;
}

/** Refuses a cash out that would strand the money: the vault, the memo board, a token contract, a swap router, the zero address. */
export function assertCashOutTarget(net: Pick<GloamNetwork, "chainId" | "pool" | "payMemo">, to: Address): void {
  const problem = cashOutTargetProblem(to, net);
  if (problem) throw new RelayError(problem, 400, "vault_recipient");
}

export const CASH_OUT_TO_ESCROW_MESSAGE = "This address is a private swap's escrow. The relay sends money there only as part of its swap. Pick another address.";

/**
 * Refuses a cash out (or an exit) to a swap's escrow (R1, 7 November 2026 router review).
 * A swap's unshield proof names its escrow as `to`, so anyone holding the swap's proofs (a
 * reverted swap leaves them on chain) could hand that proof to the relay as a plain cash
 * out: the relay would pay to move the money to the escrow, and then again for the refund.
 * Escrows are CREATE2 addresses with no code before or after their swap, so nothing on
 * chain tells one from a fresh wallet: the relay keeps every escrow it is asked to send a
 * swap to (relayVaultSwap) and checks against that. A cash out to a wallet or an allowed
 * contract is untouched. Nothing is sent when the store can't say (relay_off).
 */
export async function assertNotSwapEscrow(net: Pick<GloamNetwork, "chainId">, to: Address): Promise<void> {
  let escrow: boolean;
  try {
    escrow = await isSwapEscrow(net.chainId, to);
  } catch (e) {
    if (e instanceof LockStoreDown) throw relayOff();
    throw e;
  }
  if (escrow) throw new RelayError(CASH_OUT_TO_ESCROW_MESSAGE, 400, "vault_recipient");
}

/** Keeps a swap's escrow before anything about the swap is sent (assertNotSwapEscrow). */
async function keepSwapEscrow(net: GloamNetwork, escrow: Address): Promise<void> {
  try {
    await markSwapEscrow(net.chainId, escrow);
  } catch (e) {
    if (e instanceof LockStoreDown) throw relayOff();
    throw e;
  }
}

// ---------------------------------------------------------------- submit

function revertName(err: unknown): string | null {
  if (err instanceof BaseError) {
    const r = err.walk((e) => e instanceof ContractFunctionRevertedError);
    if (r instanceof ContractFunctionRevertedError) return r.data?.errorName ?? null;
  }
  return null;
}

/**
 * What the node said about a failed call, and nothing else. viem's full
 * message also lists the request (its nonce, gas and data), so a test on it
 * matches words the node never said: every failed send names a "nonce".
 */
function nodeSaid(err: unknown): string {
  if (err instanceof BaseError) return `${err.shortMessage} ${err.details ?? ""}`;
  return err instanceof Error ? err.message : String(err);
}

/** A refusal over the nonce itself: nothing was taken, and the next nonce from the chain fixes it. */
const NONCE_CLASH = /nonce too (?:low|high)|nonce provided for the transaction|replacement|underpriced/i;

/**
 * A failed call, in plain words. `code` is for anything else: "check_failed"
 * when the dry run failed (nothing was sent), "rpc" when the node refused the
 * send itself (it may still have been taken, so callers treat it as maybe sent).
 */
function explain(err: unknown, fallback: string, code: "rpc" | "check_failed" = "rpc"): RelayError {
  const name = revertName(err);
  if (name && REVERT_MESSAGES[name]) return new RelayError(REVERT_MESSAGES[name], 422, name);
  const msg = nodeSaid(err);
  if (/insufficient funds|gas required exceeds/i.test(msg)) {
    return new RelayError("The relay is out of gas. Send from your wallet for now.", 503, "relay_empty");
  }
  return new RelayError(fallback, 502, code);
}

// Tempo caps a tx at 30M gas; keep headroom and pad estimates for Tempo's
// storage-heavy pricing (tree inserts).
const GAS_CAP = 25_000_000n;
/**
 * The most gas the relay pays for one send of a kind, checked against its dry run.
 * Real cash outs use about 350k. Robinhood Chain's estimates carry a parent-chain
 * cost that moves, so it gets more. Tempo prices storage its own way.
 */
const SEND_GAS_MOST: Partial<Record<Call["kind"], bigint>> = {
  unshield: 1_200_000n,
  swap: 2_600_000n,
  swapV3: 2_600_000n,
  swapExit: 400_000n,
};
const GAS_MOST_FACTOR: Readonly<Record<number, bigint>> = { 4663: 4n, 46630: 4n };
export const GAS_TOO_MUCH_MESSAGE = "This costs more gas than the relay pays. Send from your wallet.";

export function sendGasMost(chainId: number, kind: Call["kind"]): bigint | null {
  const most = SEND_GAS_MOST[kind];
  if (!most || isTempoChain(chainId)) return null;
  return most * (GAS_MOST_FACTOR[chainId] ?? 1n);
}

function padGas(est: bigint) {
  const padded = (est * 13n) / 10n;
  return padded > GAS_CAP ? GAS_CAP : padded;
}

type SwapSpend = { proof: Hex; root: Hex; nullifier: Hex; asset: Address; amount: bigint };
type SwapDeposit = { proof: Hex; commitment: Hex; asset: Address; amount: bigint };

/** Whose payment message it is: the payer's (ticket) or a partner key's, or anyone else's. */
/** paid: the payer's ticket or an approved partner's key. key: any other partner key. open: no key. */
type MemoBudget = "paid" | "key" | "open";

export type Call =
  | { kind: "transfer"; args: readonly [Hex, Hex, Hex, readonly [Hex, Hex]] }
  | { kind: "unshield"; args: readonly [Hex, Hex, Hex, Address, Address, bigint] }
  | { kind: "make"; args: readonly [Address] }
  | { kind: "pump"; station: Address; args: readonly [bigint, bigint] }
  | { kind: "memo"; args: readonly [Hex, Hex]; budget: MemoBudget }
  | { kind: "swap"; router: Address; args: readonly [SwapSpend, SwapDeposit, SwapDeposit, Hex] }
  | { kind: "swapV3"; router: Address; args: readonly [SwapSpend, SwapDeposit, SwapDeposit, Hex, Address, bigint] }
  | { kind: "swapExit"; router: Address; args: readonly [Address, Required<EscrowKey>, Address, Hex] };

/** Public addresses a call pays out to: a cash out's and a swap exit's. */
function publicRecipients(call: Call): Address[] {
  if (call.kind === "swapExit") return [call.args[2]];
  return call.kind === "unshield" ? [call.args[4]] : [];
}

/** The asset a public payout moves. */
function payoutAsset(call: Call): Address | null {
  if (call.kind === "unshield") return call.args[3];
  return call.kind === "swapExit" ? call.args[0] : null;
}

/**
 * Refuse a call that pays a sanctioned address. Says nothing more than that.
 * With `net` on Tempo, a cash out is also checked against the asset's TIP-403
 * issuer policy: the vault must be allowed to send it and `to` to receive it.
 * And `to`'s own receive policy must accept whoever pays it: the vault, or for
 * a swap's exit the swap's escrow. When that policy can't be read nothing is sent
 * (check_failed), as a payment it refuses is held by Tempo rather than reverted.
 */
export async function screenCall(call: Call, net?: GloamNetwork): Promise<void> {
  const recipients = publicRecipients(call);
  if (recipients.length === 0) return;
  const asset = payoutAsset(call);
  // an exit is paid by the swap's escrow itself (SwapEscrow2), a cash out by the vault
  const sender = call.kind === "swapExit" ? escrowAddress(call.router, call.args[0], call.args[1]) : net?.pool ?? undefined;
  const context = net && asset !== null ? { chainId: net.chainId, asset, flow: "cashout" as const, sender } : undefined;
  const { allowed, message } = await screenAddresses(recipients, context);
  if (!allowed) {
    // A wallet block (sanctions or issuer) is neutral. A vault-level issuer
    // block or pause is not about the wallet, so it is said plainly.
    if (!message || message === SCREEN_BLOCKED_MESSAGE) {
      throw new RelayError(SCREEN_BLOCKED_MESSAGE, 403, "screened");
    }
    if (message === TIP403_RECEIVE_UNCHECKED_MESSAGE) throw new RelayError(message, 503, "check_failed");
    throw new RelayError(message, 403, "asset_policy");
  }
}

export const MAYBE_SENT_MESSAGE = "This may have gone out already. Wait a minute and refresh before trying again.";

function wrongChainRpc(err: unknown): boolean {
  if (err instanceof WrongChainRpcError) return true;
  return err instanceof BaseError && err.walk((e) => e instanceof WrongChainRpcError) !== null;
}

/** A timeout or a dropped connection on the send can come after the node took the transaction. */
function mayHaveSent(err: unknown): boolean {
  if (err instanceof BaseError && err.walk((e) => e instanceof TimeoutError || e instanceof HttpRequestError)) {
    return true;
  }
  return /already known|timed? ?out/i.test(err instanceof Error ? err.message : String(err));
}

/**
 * What a failed send means: "maybe_sent" when the node may have taken it (a
 * timeout, a dropped connection), so the caller must not call it unsent;
 * otherwise the node's refusal, explained.
 */
export function sendFailure(err: unknown): RelayError {
  // The private RPC set for this chain is another chain's node: refused before any node got it.
  if (wrongChainRpc(err)) return relayOff();
  // a lane's lock could not be kept in Redis: refused before anything was sent
  if (err instanceof LockStoreDown) return relayOff();
  if (mayHaveSent(err)) return new RelayError(MAYBE_SENT_MESSAGE, 502, "maybe_sent");
  return explain(err, "The relay could not submit this payment. Try again or send from your wallet.");
}

/** The relay accounts that can still pay for a send on `net`, first one first. */
export async function fundedRelayAccounts(
  net: GloamNetwork,
  offMessage = "The relay is off. Send from your wallet.",
  isEmpty: (net: GloamNetwork, a: PrivateKeyAccount) => Promise<boolean> = relayEmpty
): Promise<PrivateKeyAccount[]> {
  const all = relayerAccounts();
  if (!all.length) throw new RelayError(offMessage, 503, "relay_off");
  const accounts = (await Promise.all(all.map(async (a) => ((await isEmpty(net, a)) ? null : a)))).filter(
    (a): a is PrivateKeyAccount => a !== null
  );
  if (!accounts.length) {
    throw new RelayError("The relay is out of gas. Send from your wallet for now.", 503, "relay_empty");
  }
  return accounts;
}

type SubmitOpts = {
  /** The send failed in a way that may still have put the transaction out. */
  onMaybeSent?: () => void;
  /** Once the dry run passed, with the gas limit the send will carry: what only a send that will go holds. */
  afterDryRun?: (gasLimit: bigint) => Promise<Hold | null>;
  /** Money on its way back from a swap (a refund, an exit), as read by now: it may use all of the hourly cap. */
  returning?: () => boolean;
  /**
   * Who asked for it (an IP, or partner:<id>, or both for an account no admin approved),
   * as read by now: it holds against each one's share of the cap too, or for a refund or
   * an exit against each one's budget for those (lib/relay/spendCap).
   */
  sender?: () => Sender | undefined;
  /** The call's recipient was screened just before (relayUnshield): screenCall isn't run twice. */
  screened?: boolean;
  /** When watching for the receipt must stop, so it ends inside the request's time. */
  watchUntil?: number;
  /** Dropped when the receipt shows a revert. */
  lock?: InflightLock;
  /** How the send ended, once a receipt shows it. */
  onEnd?: (status: SendEnd["status"]) => Promise<void>;
  /**
   * Called once, when the checks, the dry run and the holds have passed and the
   * transaction is about to go out, with the call it carries (its target and
   * calldata). Never waited on, and nothing it does or throws can stop or slow the
   * send (a partner link's binding: lib/partnerAttribution). What it returns is
   * called if the send then surely did not go out (the relay was busy, its lock
   * store was down, the node refused it).
   */
  beforeBroadcast?: (tx: { to: Address; data: Hex }) => (() => void) | void;
};

/** Hooks a caller may hang on a send. */
export type SendHooks = Pick<SubmitOpts, "beforeBroadcast">;

/** The call a spend sends, as calldata, for the before-broadcast hook. */
function callTx(net: GloamNetwork, call: Call): { to: Address; data: Hex } | null {
  switch (call.kind) {
    case "transfer":
      return { to: net.pool!, data: encodeFunctionData({ abi: relayPoolAbi, functionName: "transfer", args: call.args }) };
    case "unshield":
      return { to: net.pool!, data: encodeFunctionData({ abi: relayPoolAbi, functionName: "unshield", args: call.args }) };
    case "swap":
      return { to: call.router, data: encodeFunctionData({ abi: swapCallAbi, functionName: "swap", args: call.args }) };
    case "swapV3":
      return { to: call.router, data: encodeFunctionData({ abi: swapV3CallAbi, functionName: "swap", args: call.args }) };
    default:
      return null;
  }
}

/** Runs the hook, if any, never letting it touch the send; returns what to call if the send surely did not go out. */
function startBeforeBroadcast(net: GloamNetwork, call: Call, hook: SubmitOpts["beforeBroadcast"]): () => void {
  try {
    const tx = hook ? callTx(net, call) : null;
    const undo = tx ? hook!(tx) : undefined;
    return () => {
      try {
        undo?.();
      } catch {
        /* never the send's business */
      }
    };
  } catch {
    return () => {};
  }
}

const NO_LOCK: InflightLock = { key: "", store: "memory", release: async () => {} };

/** Who asked for a send: one sender, or several that each hold a share (lib/relay/spendCap). */
export type Sender = string | readonly string[];

function sendersOf(sender: Sender | undefined): string[] {
  return [...new Set(sender === undefined ? [] : typeof sender === "string" ? [sender] : sender)].filter(Boolean);
}

/** Ethereum's blocks are slow, so its receipts are watched longer. */
const RECEIPT_WATCH_DEAR_GAS_MS = 50_000;
/**
 * A relay request has 60 s (maxDuration), the receipt watch after the reply included. The
 * watch ends this long after the request reached submit(), so a slow request still leaves
 * time for the holds to settle. A watch that ends first leaves its holds counted.
 */
export const RECEIPT_WATCH_WITHIN_MS = 45_000;

/** How long to watch a receipt that went out at `now`: the chain's watch, cut short by `until`. */
export function receiptWatchMs(chainId: number, until: number, now = Date.now()): number {
  const watch = hasSwapFloor(chainId) ? RECEIPT_WATCH_DEAR_GAS_MS : RECEIPT_WATCH_MS;
  return Math.max(0, Math.min(watch, until - now));
}

/** What a receipt shows a send cost on top of its gas: Base's fee for posting it to Ethereum. */
function l1FeeOf(receipt: unknown): bigint {
  const raw = (receipt as { l1Fee?: unknown }).l1Fee;
  if (typeof raw === "bigint") return raw > 0n ? raw : 0n;
  return typeof raw === "string" && /^0x[0-9a-fA-F]{1,64}$/.test(raw) ? BigInt(raw) : 0n;
}

/**
 * Follows a sent transaction after the reply: settles its holds and drops its lock by what the
 * receipt shows. If no receipt shows in time the holds stay, so a late landing is still counted.
 */
function followSend(net: GloamNetwork, hash: Hex, holds: Hold[], opts: Pick<SubmitOpts, "lock" | "onEnd"> & { until: number }): void {
  if (!opts.lock && !holds.length) return;
  const outcome = async () => {
    const r = await relayPublicClient(net).getTransactionReceipt({ hash });
    await settleHolds(holds, { status: r.status, gasUsed: r.gasUsed, priceWei: r.effectiveGasPrice ?? 0n, extraWei: l1FeeOf(r) });
    await opts.onEnd?.(r.status)?.catch(() => {});
    return r.status;
  };
  afterReply(() => releaseIfReverted(opts.lock ?? NO_LOCK, outcome, receiptWatchMs(net.chainId, opts.until)));
}

/** Which part of the hourly cap a send may use: new sends, cash outs, or all of it for refunds and exits. */
type SpendTier = "new" | "cashout" | "back";

/**
 * Holds what this send could cost against the chain's hourly cap, or refuses it. Every
 * kind of send counts: sends, cash outs, swaps, refunds, exits and payment messages.
 * New sends stop at NEW_SEND_SHARE_PCT of the cap, cash outs at CASH_OUT_SHARE_PCT,
 * and refunds and exits (`back`) may use all of it. Each of a send's `senders` holds
 * against its own share of the cap too, and a payment message outside the paid budget
 * against MEMO_SPEND_SHARE_PCT of it, with the other such messages. Where posting to
 * Ethereum costs extra (Base), the hold has a margin for it, and settles at what the
 * receipt shows. Refused or failed part way, it gives back what it took.
 */
async function holdSpend(
  net: GloamNetwork,
  pub: Pick<PublicClient, "getGasPrice">,
  dryRunGas: bigint,
  fees: FeeCap | undefined,
  opts: { tier: SpendTier; memo?: MemoBudget; senders: readonly string[] }
): Promise<Hold[]> {
  const cap = hourlySpendWei(net.chainId);
  if (cap === null) return [];
  const gasLimit = padGas(dryRunGas);
  let price: bigint;
  // the network's gas price now, unpadded: what a send like this one will cost once it lands
  let now: bigint;
  try {
    now = await pub.getGasPrice();
    price = fees?.maxFeePerGas ?? now;
  } catch (e) {
    throw explain(e, "Could not read the network fee. Try again shortly.", "check_failed");
  }
  const gwei = (wei: bigint) => Number(wei / 1_000_000_000n) + 1;
  const margin = L1_FEE_MARGIN_PCT[net.chainId] ?? 0n;
  const amount = gwei((gasLimit * price * (100n + margin)) / 100n);
  const keeps = (end: SendEnd) => gwei(end.gasUsed * (end.priceWei || price) + end.extraWei);
  const holds: Hold[] = [];
  // limits in the units holds are counted in (gwei, rounded up per send)
  const hold = async (owner: string, bucket: string, limit: number, refused: () => RelayError) => {
    let held: Hold | null;
    try {
      held = await takeHold(owner, bucket, amount, limit, keeps);
    } catch (e) {
      // the shared store failed part way: what was already held goes back (if the store answers)
      await dropHolds(holds);
      throw e;
    }
    if (!held) {
      await dropHolds(holds);
      throw refused();
    }
    holds.push(held);
  };
  const chain = `chain:${net.chainId}`;
  if (opts.memo !== undefined && opts.memo !== "paid") {
    await hold(chain, "relay-spend-memo", gwei((cap * MEMO_SPEND_SHARE_PCT) / 100n), () => new RelayError(MEMO_BUSY_MESSAGE, 429, "memo_busy"));
  }
  if (opts.tier === "back") {
    // refunds and exits: an IP's own budget for them, apart from its sends, where no floor sets one
    if (!hasSwapFloor(net.chainId)) {
      const part = gwei((cap * (100n - CASH_OUT_SHARE_PCT)) / 100n);
      const limit = Math.min(Math.max(gwei((cap * BACK_SHARE_PCT) / 100n), gwei(BACK_SENDS * dryRunGas * now)), part);
      for (const sender of opts.senders) {
        await hold(sender, `relay-spend-back-${net.chainId}`, limit, () => new RelayError(BACK_SHARE_MESSAGE, 429, "spend_cap"));
      }
    }
  } else {
    const share = opts.senders.length ? senderSharePct(net.chainId) : null;
    if (share !== null) {
      // the larger of the share and a payroll's worth of sends like this one at today's gas, never past the most
      const payroll = gwei(PAYROLL_SENDS * dryRunGas * now);
      const most = gwei((cap * MAX_SENDER_SHARE_PCT) / 100n);
      const limit = Math.min(Math.max(gwei((cap * BigInt(share)) / 100n), payroll), Math.max(most, gwei((cap * BigInt(share)) / 100n)));
      for (const sender of opts.senders) {
        await hold(sender, `relay-spend-sender-${net.chainId}`, limit, () => new RelayError(SENDER_SHARE_MESSAGE, 429, "spend_cap"));
      }
    }
  }
  const part = opts.tier === "back" ? 100n : opts.tier === "cashout" ? CASH_OUT_SHARE_PCT : NEW_SEND_SHARE_PCT;
  await hold(chain, "relay-spend", gwei((cap * part) / 100n), () => new RelayError(SPEND_CAP_MESSAGE, 429, "spend_cap"));
  return holds;
}

async function submit(net: GloamNetwork, call: Call, opts: SubmitOpts = {}): Promise<Hex> {
  const started = Date.now();
  // Screen before anything else: a blocked call never reaches the chain.
  if (!opts.screened) await screenCall(call, net);
  const pub = relayPublicClient(net);
  // Over the chain's gas ceiling nothing goes out (Ethereum: 3 gwei by default).
  const ceiling = await assertGasUnderCeiling(net, pub);
  // only accounts that can still pay for a send take part
  const accounts = await fundedRelayAccounts(net);
  const account = accounts[0]!;
  const pool = net.pool!;

  const estimate = (): Promise<bigint> => {
    switch (call.kind) {
      case "transfer":
        return pub.estimateContractGas({ address: pool, abi: relayPoolAbi, functionName: "transfer", args: call.args, account });
      case "unshield":
        return pub.estimateContractGas({ address: pool, abi: relayPoolAbi, functionName: "unshield", args: call.args, account });
      case "make":
        return pub.estimateContractGas({ address: GAS_STATION_FACTORY, abi: gasStationFactoryAbi, functionName: "make", args: call.args, account });
      case "pump":
        return pub.estimateContractGas({ address: call.station, abi: gasStationAbi, functionName: "pump", args: call.args, account });
      case "memo":
        return pub.estimateContractGas({ address: net.payMemo!.address, abi: memoAbi, functionName: "postMemo", args: call.args, account });
      case "swap":
        return pub.estimateContractGas({ address: call.router, abi: swapCallAbi, functionName: "swap", args: call.args, account });
      case "swapV3":
        return pub.estimateContractGas({ address: call.router, abi: swapV3CallAbi, functionName: "swap", args: call.args, account });
      case "swapExit":
        return pub.estimateContractGas({ address: call.router, abi: swapV3CallAbi, functionName: "exit", args: call.args, account });
    }
  };
  let fees: FeeCap | undefined;
  const send = (gas: bigint, nonce: number, from: PrivateKeyAccount): Promise<Hex> => {
    const wallet = walletFor(net, from);
    switch (call.kind) {
      case "transfer":
        return wallet.writeContract({ address: pool, abi: relayPoolAbi, functionName: "transfer", args: call.args, gas, nonce, chain: net.chain, account: from, ...fees });
      case "unshield":
        return wallet.writeContract({ address: pool, abi: relayPoolAbi, functionName: "unshield", args: call.args, gas, nonce, chain: net.chain, account: from, ...fees });
      case "make":
        return wallet.writeContract({ address: GAS_STATION_FACTORY, abi: gasStationFactoryAbi, functionName: "make", args: call.args, gas, nonce, chain: net.chain, account: from, ...fees });
      case "pump":
        return wallet.writeContract({ address: call.station, abi: gasStationAbi, functionName: "pump", args: call.args, gas, nonce, chain: net.chain, account: from, ...fees });
      case "memo":
        return wallet.writeContract({ address: net.payMemo!.address, abi: memoAbi, functionName: "postMemo", args: call.args, gas, nonce, chain: net.chain, account: from, ...fees });
      case "swap":
        return wallet.writeContract({ address: call.router, abi: swapCallAbi, functionName: "swap", args: call.args, gas, nonce, chain: net.chain, account: from, ...fees });
      case "swapV3":
        return wallet.writeContract({ address: call.router, abi: swapV3CallAbi, functionName: "swap", args: call.args, gas, nonce, chain: net.chain, account: from, ...fees });
      case "swapExit":
        return wallet.writeContract({ address: call.router, abi: swapV3CallAbi, functionName: "exit", args: call.args, gas, nonce, chain: net.chain, account: from, ...fees });
    }
  };

  let gas: bigint;
  try {
    // Dry run: reverts here (bad proof, spent note, stale root) cost nothing.
    gas = await estimate();
  } catch (e) {
    throw explain(e, "Could not check this payment. Try again.", "check_failed");
  }
  // pump hands the wallet all its gas, so a wallet that gained code after the checks shows up here.
  if ((call.kind === "make" || call.kind === "pump") && gas > STATION_MAX_ESTIMATE) {
    throw new RelayError(STATION_ESTIMATE_MESSAGE, 422, "station_gas");
  }
  const most = sendGasMost(net.chainId, call.kind);
  if (most !== null && gas > most) throw new RelayError(GAS_TOO_MUCH_MESSAGE, 422, "gas_most");

  const holds: Hold[] = [];
  let mayBeOut = false;
  let notSent = () => {};
  try {
    const budget = await opts.afterDryRun?.(padGas(gas));
    if (budget) holds.push(budget);
    if (ceiling !== null) fees = await feeCap(net, pub, ceiling);
    // The gas first, then the network's slot: a send the cap turns away takes no slot,
    // and one turned away after it (no slot, no lane) gives every hold back below.
    holds.push(
      ...(await holdSpend(net, pub, gas, fees, {
        tier: opts.returning?.() === true ? "back" : call.kind === "unshield" ? "cashout" : "new",
        memo: call.kind === "memo" ? call.budget : undefined,
        senders: sendersOf(opts.sender?.()),
      }))
    );
    holds.push(await (call.kind === "memo" ? holdMemoSlot(net, call.budget) : holdNetworkSlot(net)));
    notSent = startBeforeBroadcast(net, call, opts.beforeBroadcast);

    // one send at a time per relay account and chain, each with the next nonce; with
    // several accounts, the first free one sends (lib/relay/inflight)
    const lanes = accounts.map((a) => ({
      id: `${net.chainId}:${a.address.toLowerCase()}`,
      chainNonce: () => pub.getTransactionCount({ address: a.address, blockTag: "pending" }),
    }));
    let usedLane: string | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const out = await inSendLanes(lanes, (i, nonce) => {
          usedLane = lanes[i]!.id;
          return send(padGas(gas), nonce, accounts[i]!);
        });
        if (!out) throw new RelayError(RELAY_BUSY_MESSAGE, 503, "busy");
        followSend(net, out.value, holds, { ...opts, until: opts.watchUntil ?? started + RECEIPT_WATCH_WITHIN_MS });
        return out.value;
      } catch (e) {
        if (e instanceof RelayError) throw e;
        // The lane's lock could not be kept in Redis: nothing was sent.
        if (e instanceof LockStoreDown) throw relayOff();
        // A send the node may have taken (a timeout, a dropped connection, "already
        // known") is never sent again: a second one would only revert and hide the first.
        const failure = sendFailure(e);
        if (failure.code === "maybe_sent") {
          mayBeOut = true;
          opts.onMaybeSent?.();
          throw failure;
        }
        // The node refused it over the nonce: the kept nonce and the chain disagree.
        // Start again from the chain, once.
        if (attempt === 0 && usedLane && NONCE_CLASH.test(nodeSaid(e))) {
          await forgetNonce(usedLane);
          continue;
        }
        mayBeOut = failure.code === "rpc";
        throw failure;
      }
    }
    mayBeOut = true;
    throw new RelayError("The relay could not submit this payment.", 502, "rpc");
  } catch (e) {
    if (!mayBeOut) {
      notSent();
      await dropHolds(holds);
    }
    throw e;
  }
}

/** What a send under a gas ceiling may offer per unit of gas. */
type FeeCap = { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };

/**
 * Refuses a send while gas on `net` is over the relay's ceiling, with code
 * gas_high (nothing is sent). Returns the ceiling, or null on a chain with none.
 */
export async function assertGasUnderCeiling(net: GloamNetwork, pub: Pick<PublicClient, "getGasPrice"> = relayPublicClient(net)): Promise<bigint | null> {
  const gas = await readGas(net.chainId, pub, { fresh: true });
  if (gas.high) {
    console.warn(
      "gloam_relay_gas_high",
      JSON.stringify({ chainId: net.chainId, gwei: gas.gasPriceWei === null ? null : formatGwei(gas.gasPriceWei), max: formatGwei(gas.ceilingWei!) })
    );
    throw new RelayError(gasHighMessage(net.label), 503, GAS_HIGH_CODE);
  }
  return gas.ceilingWei;
}

/** Whether gas on `net` is over the relay's ceiling right now (a scheduled cash out waits then). */
export async function relayGasHigh(net: GloamNetwork): Promise<boolean> {
  return (await readGas(net.chainId, relayPublicClient(net), { fresh: true })).high;
}

/**
 * The node's fee suggestion, capped at 1.5 times the ceiling: room for the
 * base fee to rise for a few blocks before the send lands, and never more.
 */
async function feeCap(net: GloamNetwork, pub: PublicClient, ceiling: bigint): Promise<FeeCap> {
  let est: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };
  try {
    est = await pub.estimateFeesPerGas({ chain: net.chain, type: "eip1559" });
  } catch (e) {
    throw explain(e, "Could not read the network fee. Try again shortly.", "check_failed");
  }
  const cap = maxFeeCapWei(ceiling);
  const maxFeePerGas = est.maxFeePerGas < cap ? est.maxFeePerGas : cap;
  const maxPriorityFeePerGas = est.maxPriorityFeePerGas < maxFeePerGas ? est.maxPriorityFeePerGas : maxFeePerGas;
  return { maxFeePerGas, maxPriorityFeePerGas };
}

export const IN_FLIGHT_MESSAGE = "This payment is already being sent. Wait a moment and refresh.";
export const RELAY_BUSY_MESSAGE = "The relay is busy right now. Try again in a moment or send from your wallet.";

/** Runs `task` once the reply is out, while the function still runs. Outside a request (a self-test) it just runs. */
function afterReply(task: () => Promise<void>): void {
  try {
    after(task);
  } catch {
    void task();
  }
}

/**
 * A send or cash out, one at a time per nullifier: take the lock, check the
 * note is unspent and the root known, then dry run and send. The lock is
 * dropped when nothing went out (a failed check, dry run or send), so the user
 * can retry at once; once a transaction is out it stays until it expires,
 * unless its receipt shows it reverted. That is read after the reply, so the
 * caller gets the hash at once however long the transaction takes to land.
 */
async function submitSpend(
  net: GloamNetwork,
  call: Extract<Call, { kind: "transfer" | "unshield" | "swap" | "swapV3" | "swapExit" }>,
  opts: Pick<SubmitOpts, "afterDryRun" | "returning" | "onEnd" | "sender" | "screened" | "watchUntil" | "beforeBroadcast"> & {
    precheck?: () => Promise<void>;
    /** What the lock is on, the nullifier unless said. */
    lockOn?: Hex;
  } = {}
): Promise<Hex> {
  const { precheck, lockOn, afterDryRun, returning, onEnd, sender, screened, watchUntil, beforeBroadcast } = opts;
  const isSwap = call.kind === "swap" || call.kind === "swapV3";
  const nullifier = call.kind === "swapExit" ? call.args[1].nullifier : isSwap ? call.args[0].nullifier : call.args[2];
  let lock: Awaited<ReturnType<typeof takeInflight>>;
  try {
    lock = await takeInflight(inflightKey(net.chainId, lockOn ?? nullifier));
  } catch (e) {
    // never on memory in production: without Redis this spend is not sent at all
    if (e instanceof LockStoreDown) throw relayOff();
    throw e;
  }
  if (!lock) throw new RelayError(IN_FLIGHT_MESSAGE, 409, "in_flight");
  let keep = false;
  try {
    if (precheck) await precheck();
    else if (call.kind === "transfer" || call.kind === "unshield") await precheckSpend(net, call.args[1], nullifier);
    const hash = await submit(net, call, {
      onMaybeSent: () => {
        keep = true;
      },
      afterDryRun,
      returning,
      onEnd,
      sender,
      screened,
      watchUntil,
      lock,
      beforeBroadcast,
    });
    keep = true;
    return hash;
  } finally {
    if (!keep) await lock.release();
  }
}

/**
 * `sender` is who asked (an IP, or partner:<id>, or both): the send holds against each
 * one's share of the cap.
 */
export async function relayTransfer(net: GloamNetwork, body: Record<string, unknown>, sender?: Sender, hooks: SendHooks = {}) {
  const proof = asProof(body.proof);
  const root = asBytes32(body.root, "root");
  const nullifier = asBytes32(body.nullifier, "nullifier");
  const commitments = body.commitments;
  if (!Array.isArray(commitments) || commitments.length !== 2) throw new RelayError("Invalid commitments.");
  const c0 = asBytes32(commitments[0], "commitment");
  const c1 = asBytes32(commitments[1], "commitment");
  return submitSpend(net, { kind: "transfer", args: [proof, root, nullifier, [c0, c1]] }, { sender: () => sender, beforeBroadcast: hooks.beforeBroadcast });
}

type UnshieldCall = Extract<Call, { kind: "unshield" }>;

/** A cash out from a request body, with its recipient checked and screened. */
async function unshieldCall(net: GloamNetwork, body: Record<string, unknown>): Promise<UnshieldCall> {
  const proof = asProof(body.proof);
  const root = asBytes32(body.root, "root");
  const nullifier = asBytes32(body.nullifier, "nullifier");
  const asset = asAddress(body.asset, "asset");
  const to = asAddress(body.to, "recipient");
  const amount = asAmount(body.amount);
  assertCashOutTarget(net, to);
  // a swap's own unshield, sent alone, is the swap's business, never a cash out's
  await assertNotSwapEscrow(net, to);
  // The recipient and amount are public inputs of the unshield proof, so the
  // relay cannot change where the money goes.
  const call = { kind: "unshield", args: [proof, root, nullifier, asset, to, amount] } as const;
  await screenCall(call, net);
  return call;
}

/** As relayTransfer. The recipient is screened once, before anything else. */
export async function relayUnshield(net: GloamNetwork, body: Record<string, unknown>, sender?: Sender, hooks: SendHooks = {}) {
  return submitSpend(net, await unshieldCall(net, body), { sender: () => sender, screened: true, beforeBroadcast: hooks.beforeBroadcast });
}

/**
 * A cash out to send later (lib/relay/scheduled): everything relayUnshield
 * checks, plus the dry run, but nothing is sent. Refuses what would fail if it
 * went now: a spent note, a stale root, a bad proof, a blocked recipient, a gas
 * use over the limit. What it reads can change before the job's time comes.
 */
export async function checkUnshieldForLater(net: GloamNetwork, body: Record<string, unknown>): Promise<UnshieldCall> {
  const call = await unshieldCall(net, body);
  await precheckSpend(net, call.args[1], call.args[2]);
  // The dry run from an account that can send it, as the send itself will be (one empty key is skipped).
  const [account] = await fundedRelayAccounts(net, "Cashing out later needs the Gloam relay, which is off right now.");
  let gas: bigint;
  try {
    gas = await relayPublicClient(net).estimateContractGas({ address: net.pool!, abi: relayPoolAbi, functionName: "unshield", args: call.args, account });
  } catch (e) {
    throw explain(e, "Could not check this cash out. Try again.", "check_failed");
  }
  const most = sendGasMost(net.chainId, "unshield");
  if (most !== null && gas > most) throw new RelayError(GAS_TOO_MUCH_MESSAGE, 422, "gas_most");
  return call;
}

/**
 * Sends a scheduled cash out now, through the same checks and lock as any relayed one.
 * `watchUntil` ends the receipt watch inside the run's own time.
 */
export async function sendUnshieldNow(net: GloamNetwork, body: Record<string, unknown>, opts: { watchUntil?: number } = {}): Promise<Hex> {
  return submitSpend(net, await unshieldCall(net, body), { screened: true, watchUntil: opts.watchUntil });
}

/**
 * Reads what a scheduled cash out needs at send time: is the note spent, does
 * the vault know the root. Both at one block, so answers from two nodes a
 * block apart can't call a cash out that landed unsent. Throws when either
 * can't be read (a node without that block yet too): the job counts as unread.
 */
export async function readSpendState(net: GloamNetwork, root: Hex, nullifier: Hex): Promise<{ spent: boolean; knownRoot: boolean }> {
  const pub = relayPublicClient(net);
  const blockNumber = await pub.getBlockNumber({ cacheTime: 0 });
  const [spent, knownRoot] = await Promise.all([
    pub.readContract({ address: net.pool!, abi: relayPoolAbi, functionName: "spent", args: [nullifier], blockNumber }),
    pub.readContract({ address: net.pool!, abi: relayPoolAbi, functionName: "isKnownRoot", args: [root], blockNumber }),
  ]);
  return { spent: Boolean(spent), knownRoot: Boolean(knownRoot) };
}

/** The most hops any router takes (GloamVaultSwapV4b.MAX_HOPS); each router's own limit is checked after. */
const MAX_ROUTE_HOPS = 3;

function asRoute(v: unknown): PoolKey[] {
  if (v == null) return [];
  if (!Array.isArray(v) || v.length > MAX_ROUTE_HOPS) throw new RelayError("Invalid swap route.");
  return v.map((k) => {
    const r = (k ?? {}) as Record<string, unknown>;
    const fee = Number(r.fee);
    const tickSpacing = Number(r.tickSpacing);
    if (!Number.isInteger(fee) || fee < 0 || fee > 16_777_215) throw new RelayError("Invalid swap route.");
    if (!Number.isInteger(tickSpacing) || Math.abs(tickSpacing) > 8_388_607) throw new RelayError("Invalid swap route.");
    return {
      currency0: asAddress(r.currency0, "swap route"),
      currency1: asAddress(r.currency1, "swap route"),
      fee,
      tickSpacing,
      hooks: asAddress(r.hooks, "swap route"),
    };
  });
}

function asSwapDeposit(v: unknown): SwapDeposit {
  const d = (v ?? {}) as Record<string, unknown>;
  return {
    proof: asProof(d.proof),
    commitment: asBytes32(d.commitment, "commitment"),
    asset: asAddress(d.asset, "asset"),
    amount: asAmount(d.amount),
  };
}

const erc20BalanceAbi = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

/**
 * A private swap through the vault (lib/vaultSwap). The note's unshield proof
 * names the swap's escrow as `to`, an address the router derives from the new
 * note, the refund note and the route, so the relay (or anyone who copies the
 * call) cannot change where the money goes or what lands. Only a router the
 * app knows on the chain (`body.router`: the one new swaps use when left out;
 * an earlier router only for the swaps made through it, as their refunds are),
 * only that router's assets, only a route made of that router's pools (for v2,
 * the dry run also checks each one against its allowlist on chain), and the
 * same lock, root check and dry run as any spend. A note already spent is
 * refused, unless its money is waiting at this swap's escrow: then the call
 * puts it back as the refund note. That call (lib/vaultSwapRun
 * finishVaultSwapRefund) carries only the refund note's proof; the spend's
 * proof and root and the new note's proof are placeholders the router never
 * reads on that path, so the root is not checked for it. That call locks on its
 * escrow, and a swap on its nullifier.
 */
/**
 * `sender` as for relayTransfer. A refund holds against no sender's share: on a chain
 * without a swap floor it holds against the sender's own budget for refunds and exits.
 */
export async function relayVaultSwap(net: GloamNetwork, body: Record<string, unknown>, sender?: Sender, hooks: SendHooks = {}) {
  if (!swapRouterFor(net.chainId)) throw new RelayError("Private swaps are not live on this network yet.", 400, "no_swap");
  const asked = body.router == null ? null : asAddress(body.router, "router");
  const config = swapRouterFor(net.chainId, asked);
  if (!config) throw new RelayError("That is not a Gloam swap router on this network.", 400, "swap_router");
  const router = config.address;
  const s = (body.spend ?? {}) as Record<string, unknown>;
  const spend: SwapSpend = {
    proof: asProof(s.proof),
    root: asBytes32(s.root, "root"),
    nullifier: asBytes32(s.nullifier, "nullifier"),
    asset: asAddress(s.asset, "asset"),
    amount: asAmount(s.amount),
  };
  const deposit = asSwapDeposit(body.deposit);
  const refund = asSwapDeposit(body.refund);
  if (spend.asset.toLowerCase() === deposit.asset.toLowerCase()) throw new RelayError("Pick two different assets.");
  if (!isSwapAsset(net.chainId, spend.asset, router) || !isSwapAsset(net.chainId, deposit.asset, router)) {
    throw new RelayError("This asset cannot be swapped here.", 400, "swap_asset");
  }
  if (refund.asset.toLowerCase() !== spend.asset.toLowerCase() || refund.amount > spend.amount) {
    throw new RelayError("Invalid refund note.");
  }
  const route = asRoute(body.route);
  if (!isKnownRoute(net.chainId, spend.asset, deposit.asset, route, router)) {
    throw new RelayError(REVERT_MESSAGES.BadRoute, 400, "BadRoute");
  }
  const routeBytes = encodeRoute(route);
  const v3 = config.version === 3;
  const exitKey = v3 ? asAddress(body.exitKey, "exit key") : undefined;
  const deadline = v3 ? asAmount(body.deadline) : undefined;
  const pub = relayPublicClient(net);
  // A new note that is already in the vault would revert after the proof checks.
  const seen = await pub.readContract({ address: net.pool!, abi: relayPoolAbi, functionName: "commitmentSeen", args: [deposit.commitment] });
  if (seen) throw new RelayError(REVERT_MESSAGES.DuplicateCommitment, 409, "DuplicateCommitment");

  const escrow = escrowAddress(router, spend.asset, {
    nullifier: spend.nullifier,
    amountIn: spend.amount,
    outCommitment: deposit.commitment,
    assetOut: deposit.asset,
    amountOut: deposit.amount,
    refundCommitment: refund.commitment,
    refundAmount: refund.amount,
    routeHash: keccak256(routeBytes),
    ...(exitKey ? { exitKey, deadline } : {}),
  });
  // a refund locks on its escrow, a swap on its nullifier
  const left = await pub.readContract({ address: net.pool!, abi: relayPoolAbi, functionName: "spent", args: [spend.nullifier] });
  const unshieldTx = body.unshieldTx == null ? null : asBytes32(body.unshieldTx, "unshield transaction");
  let refunding = false;
  const precheck = async () => {
    const [spent, known] = await Promise.all([
      pub.readContract({ address: net.pool!, abi: relayPoolAbi, functionName: "spent", args: [spend.nullifier] }),
      pub.readContract({ address: net.pool!, abi: relayPoolAbi, functionName: "isKnownRoot", args: [spend.root] }),
    ]);
    if (!spent) {
      // an earlier router stays for refunds, and a refund's note is always spent
      if (config.address.toLowerCase() !== vaultSwapRouter(net.chainId)?.toLowerCase()) {
        throw new RelayError("This quote was for an earlier swap router. Get a new quote and try again.", 409, "swap_router_old");
      }
      if (!known) throw new RelayError(REVERT_MESSAGES.UnknownRoot, 409, "UnknownRoot");
      // only a swap has a deadline: below this line is a refund, which never does. One
      // about to pass would pass the dry run and revert on the way in, at the relay's expense.
      if (deadline !== undefined && swapExpired(deadline, BigInt(Math.floor(Date.now() / 1000) + SWAP_SEND_MARGIN_SECONDS))) {
        throw new RelayError(REVERT_MESSAGES.SwapExpired!, 409, "SwapExpired");
      }
      await assertNoteMayRetry(net, spend.nullifier);
      await assertSwapWorthSending(net, spend, route.length);
      return;
    }
    // spent: only worth a send if this swap's money is waiting at its escrow (the refund)
    if ((await heldAt(pub, spend.asset, escrow)) < refund.amount) throw new RelayError(REVERT_MESSAGES.AlreadySpent, 409, "AlreadySpent");
    await assertEscrowPaid(net, unshieldTx, { nullifier: spend.nullifier, asset: spend.asset, escrow, amount: spend.amount });
    await assertNoteMayRetry(net, `refund|${escrow}`);
    refunding = true;
  };
  return submitSpend(
    net,
    exitKey
      ? { kind: "swapV3", router, args: [spend, deposit, refund, routeBytes, exitKey, deadline!] }
      : { kind: "swap", router, args: [spend, deposit, refund, routeBytes] },
    {
      precheck,
      lockOn: left ? escrow : undefined,
      returning: () => refunding,
      // a refund holds against its sender's refund budget, never its send share
      sender: () => sender,
      // once its proofs passed the dry run, and before they go out where anyone can read them:
      // from then on a plain cash out to this escrow is refused
      afterDryRun: async (gasLimit) => {
        await keepSwapEscrow(net, escrow);
        return refunding ? holdWaiting(net, spend.asset, refund.amount, gasLimit) : holdSwap(net, gasLimit);
      },
      onEnd: (status) => noteEnded(net, refunding ? `refund|${escrow}` : spend.nullifier, status),
      // a refund is never a link's swap: no binding for it
      beforeBroadcast: (tx) => (refunding ? undefined : hooks.beforeBroadcast?.(tx)),
    }
  );
}

/** The floor's inputs, read together and kept a minute, so a status poll and a swap share one read. */
type FloorRead = { at: number; gasPriceWei: bigint; ethUsd: number; feeBps: number };
const FLOOR_TTL_MS = 60_000;
const floorReads = new Map<number, FloorRead>();

/** Test hook: forget the kept reads. */
export function resetSwapFloorReads(): void {
  floorReads.clear();
}

const withdrawFeeAbi = [{ type: "function", name: "withdrawFeeBps", stateMutability: "view", inputs: [], outputs: [{ type: "uint16" }] }] as const;

/** ETH's price and the vault's fee, and the gas price fresh each time. Throws when any can't be read, or the feed is stale. */
async function readFloor(net: GloamNetwork, pub: Pick<PublicClient, "readContract" | "getGasPrice"> = relayPublicClient(net)): Promise<FloorRead> {
  const now = Date.now();
  const gasPriceWei = await pub.getGasPrice();
  const hit = floorReads.get(net.chainId);
  if (hit && now - hit.at < FLOOR_TTL_MS) return { ...hit, gasPriceWei };
  const [round, feeBps] = await Promise.all([
    pub.readContract({ address: ETH_USD_FEED[net.chainId]!, abi: ethUsdFeedAbi, functionName: "latestRoundData" }),
    pub.readContract({ address: net.pool!, abi: withdrawFeeAbi, functionName: "withdrawFeeBps" }),
  ]);
  const age = Math.floor(now / 1000) - Number(round[3]);
  if (round[1] <= 0n || age > FEED_MAX_AGE_SEC) throw new Error("eth usd feed stale");
  const read = { at: now, gasPriceWei, ethUsd: Number(round[1]) / 1e8, feeBps };
  floorReads.set(net.chainId, read);
  return read;
}

/** What a note is worth in dollars, for the floor. EURC counts as a dollar, the side that asks more of it. */
function noteUsd(chainId: number, asset: Address, amount: bigint, ethUsd: number): number {
  if (BigInt(asset) === 0n) return (Number(amount) / 1e18) * ethUsd;
  const t = knownTokens(chainId).find((k) => k.address.toLowerCase() === asset.toLowerCase());
  return Number(amount) / 10 ** (t?.decimals ?? 18);
}

/**
 * A refund or an exit goes only for an escrow the vault paid: the receipt of `unshieldTx`
 * must show this note's Unshielded, to this escrow, for this amount. The app finds that
 * transaction by its nullifier (lib/vaultSwapRun). A tab from before this asks with none:
 * it is refused, nothing moves, and its next load finishes the job.
 */
async function assertEscrowPaid(net: GloamNetwork, unshieldTx: Hex | null, paid: { nullifier: Hex; asset: Address; escrow: Address; amount: bigint }): Promise<void> {
  if (!unshieldTx) throw new RelayError("Refresh Gloam to finish this. Your money is safe.", 409, "unshield_tx");
  const receipt = await relayPublicClient(net).getTransactionReceipt({ hash: unshieldTx }).catch(() => null);
  if (!receipt || receipt.status !== "success" || !receiptPaysEscrow(receipt.logs, net.pool!, paid)) {
    throw new RelayError("The vault's payment to this swap's escrow could not be found. Try again shortly.", 409, "unshield_tx");
  }
}

/** Where gas is dear, one note or escrow that keeps reverting waits, on its own. `key` names it. */
async function assertNoteMayRetry(net: GloamNetwork, key: string): Promise<void> {
  if (!hasSwapFloor(net.chainId)) return;
  if ((await sharedCount(key, "relay-note-reverts")) >= NOTE_REVERTS_HOURLY) throw new RelayError(NOTE_WAIT_MESSAGE, 429, "note_wait");
}

async function noteEnded(net: GloamNetwork, key: string, status: SendEnd["status"]): Promise<void> {
  if (status === "reverted" && hasSwapFloor(net.chainId)) await relayCount(key, "relay-note-reverts", NOTE_REVERTS_HOURLY, Date.now(), 3600);
}

async function sharedCount(owner: string, bucket: string): Promise<number> {
  try {
    return await readRateLimit(owner, bucket, Date.now(), 3600, { failClosed: true });
  } catch (e) {
    if (!(e instanceof SharedCountUnavailable)) throw e;
    relayStoreDown(e.reason);
    throw relayOff();
  }
}

/**
 * Refuses a new swap the relay would pay to lose: one whose vault fee can't cover the swap's
 * own gas (lib/relay/swapFloor), or any while reverted swaps have used up this hour's budget.
 * Nothing on a chain with no floor. A floor that can't be read refuses the swap: it costs a
 * retry, where paying blind costs the relay's gas.
 */
export async function assertSwapWorthSending(
  net: GloamNetwork,
  spend: Pick<SwapSpend, "asset" | "amount">,
  hops: number,
  pub?: Pick<PublicClient, "readContract" | "getGasPrice">
): Promise<void> {
  if (!hasSwapFloor(net.chainId)) return;
  if ((await sharedCount(`chain:${net.chainId}`, "relay-swap-gas")) >= SWAP_REVERT_GAS_HOURLY) {
    throw new RelayError(SWAPS_PAUSED_MESSAGE, 429, "swaps_paused");
  }
  let floor: FloorRead;
  try {
    floor = await readFloor(net, pub);
  } catch {
    throw new RelayError("Could not read the network fee. Try again shortly.", 503, "check_failed");
  }
  const smallest = smallestSwapUsd({ ...floor, hops });
  if (noteUsd(net.chainId, spend.asset, spend.amount, floor.ethUsd) < smallest) {
    throw new RelayError(Number.isFinite(smallest) ? swapFloorMessage(net.label, smallest) : SWAPS_PAUSED_MESSAGE, 422, "swap_small");
  }
}

/** Holds a swap's gas limit against the hour's budget where gas is dear. Only what a reverted one burned stays counted. */
async function holdSwap(net: GloamNetwork, gasLimit: bigint): Promise<Hold | null> {
  if (!hasSwapFloor(net.chainId)) return null;
  const held = await takeHold(`chain:${net.chainId}`, "relay-swap-gas", Number(gasLimit), SWAP_REVERT_GAS_HOURLY, (end) =>
    end.status === "reverted" ? Number(end.gasUsed) : 0
  );
  if (!held) throw new RelayError(SWAPS_PAUSED_MESSAGE, 429, "swaps_paused");
  return held;
}

/**
 * Holds a refund's or an exit's gas limit where gas is dear, apart from swaps. Under the swap
 * floor it counts whatever happens, and waits once the budget is gone. At or over the floor
 * it goes regardless, and only a revert stays counted.
 */
async function holdWaiting(net: GloamNetwork, asset: Address, amount: bigint, gasLimit: bigint): Promise<Hold | null> {
  if (!hasSwapFloor(net.chainId)) return null;
  const floor = await readFloor(net).catch(() => null);
  const worthIt = floor !== null && noteUsd(net.chainId, asset, amount, floor.ethUsd) >= smallestSwapUsd({ ...floor, hops: 1 });
  const held = await takeHold(`chain:${net.chainId}`, "relay-waiting-gas", Number(gasLimit), worthIt ? null : WAITING_GAS_HOURLY, (end) =>
    worthIt && end.status === "success" ? 0 : Number(end.gasUsed)
  );
  if (!held) throw new RelayError(SWAPS_PAUSED_MESSAGE, 429, "swaps_paused");
  return held;
}

/** The smallest one-hop swap right now, for the app, or null on a chain with no floor or when it can't be read. */
async function swapFloorNow(net: GloamNetwork): Promise<number | null> {
  if (!hasSwapFloor(net.chainId)) return null;
  try {
    const usd = smallestSwapUsd({ ...(await readFloor(net)), hops: 1 });
    return Number.isFinite(usd) ? usd : null;
  } catch {
    return null;
  }
}

/** What an address holds of an asset; address(0) is native ETH. */
function heldAt(pub: ReturnType<typeof relayPublicClient>, asset: Address, who: Address): Promise<bigint> {
  if (BigInt(asset) === 0n) return pub.getBalance({ address: who });
  return pub.readContract({ address: asset, abi: erc20BalanceAbi, functionName: "balanceOf", args: [who] });
}

/**
 * Sends a swap's waiting money to the address its exit key signed for, when its
 * refund can't land (GloamVaultSwap2.exit). It pays a public address, so it takes the
 * checks and screening of any cash out. The relay can't change the address: the
 * signature names it, and the swap's escrow key fixes the exit key. Refused unless
 * money is waiting at this swap's escrow, so a call that can only fail costs no gas.
 */
/** `sender` as for relayVaultSwap's refunds. */
export async function relayVaultSwapExit(net: GloamNetwork, body: Record<string, unknown>, sender?: Sender) {
  if (!swapRouterFor(net.chainId)) throw new RelayError("Private swaps are not live on this network yet.", 400, "no_swap");
  const config = swapRouterFor(net.chainId, asAddress(body.router, "router"));
  if (!config) throw new RelayError("That is not a Gloam swap router on this network.", 400, "swap_router");
  if (config.version !== 3) throw new RelayError("A swap through this router has no exit. Its refund lands once the vault has room.", 400, "no_exit");
  const asset = asAddress(body.asset, "asset");
  if (!isSwapAsset(net.chainId, asset, config.address)) throw new RelayError("This asset cannot be swapped here.", 400, "swap_asset");
  const to = asAddress(body.to, "recipient");
  assertCashOutTarget(net, to);
  await assertNotSwapEscrow(net, to);
  if (typeof body.signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(body.signature)) throw new RelayError("Invalid exit signature.");
  const k = (body.key ?? {}) as Record<string, unknown>;
  const key: Required<EscrowKey> = {
    nullifier: asBytes32(k.nullifier, "nullifier"),
    amountIn: asAmount(k.amountIn),
    outCommitment: asBytes32(k.outCommitment, "commitment"),
    assetOut: asAddress(k.assetOut, "asset"),
    amountOut: asAmount(k.amountOut),
    refundCommitment: asBytes32(k.refundCommitment, "commitment"),
    refundAmount: asAmount(k.refundAmount),
    routeHash: asBytes32(k.routeHash, "route"),
    exitKey: asAddress(k.exitKey, "exit key"),
    deadline: asAmount(k.deadline),
  };
  const pub = relayPublicClient(net);
  const escrow = escrowAddress(config.address, asset, key);
  const unshieldTx = body.unshieldTx == null ? null : asBytes32(body.unshieldTx, "unshield transaction");
  let waiting = 0n;
  const precheck = async () => {
    const spent = await pub.readContract({ address: net.pool!, abi: relayPoolAbi, functionName: "spent", args: [key.nullifier] });
    waiting = spent ? await heldAt(pub, asset, escrow) : 0n;
    if (waiting === 0n) throw new RelayError("Nothing is waiting at this swap's escrow.", 409, "nothing_waiting");
    await assertEscrowPaid(net, unshieldTx, { nullifier: key.nullifier, asset, escrow, amount: key.amountIn });
    await assertNoteMayRetry(net, `exit|${escrow}`);
  };
  return submitSpend(net, { kind: "swapExit", router: config.address, args: [asset, key, to, body.signature as Hex] }, {
    precheck,
    lockOn: escrow,
    returning: () => true,
    sender: () => sender,
    afterDryRun: (gasLimit) => holdWaiting(net, asset, waiting, gasLimit),
    onEnd: (status) => noteEnded(net, `exit|${escrow}`, status),
  });
}

/** The partner account behind a payment message sent with a key, and whether a Gloam admin approved it. */
export type MemoPartner = { partner: string; approved: boolean };

/**
 * `body.ticket` is the payment's memo ticket (memoTicket) from the transfer's
 * response. `from` is the partner account for the partner API: each account
 * gets its own few messages per payment, all its keys together. The app's
 * route passes none, so no IP is ever kept next to a payment.
 */
export async function relayMemo(net: GloamNetwork, body: Record<string, unknown>, from?: MemoPartner) {
  if (!net.payMemo) throw new RelayError("Payment messages are not live on this network yet.", 400, "no_memo");
  const commitment = asBytes32(body.paymentCommitment, "payment");
  const memo = asMemo(body.memo);
  // Only relay memos for payments that really landed in the pool.
  const seen = (await relayPublicClient(net).readContract({
    address: net.pool!,
    abi: relayPoolAbi,
    functionName: "commitmentSeen",
    args: [commitment],
  })) as boolean;
  if (!seen) throw new RelayError("That payment is not in the vault yet. Wait for it to confirm.", 409, "not_seen");
  // The memo board takes any number of messages per payment, and each relayed
  // one is gas the relay pays. The payer (with the ticket) and each partner
  // account get a few of their own; everyone else shares one small allowance,
  // which a stranger can use up but never the payer's. Keys name the payment and
  // who holds it, never an IP, and use no ":" (lib/mcpRemote/rateLimit reads a
  // key with colons as an IPv6 address and keeps only its first four groups).
  const payment = `memo|${net.chainId}|${commitment.toLowerCase()}`;
  const now = Date.now();
  const payer = memoTicketOk(net.chainId, commitment, body.ticket);
  const partner = payer ? undefined : from;
  const hit = payer
    ? await relayCount(`${payment}|payer`, "relay-memo", MEMOS_PER_PAYMENT, now, 86_400)
    : partner
      ? await relayCount(`${payment}|partner|${partner.partner.replace(/:/g, "|")}`, "relay-memo", MEMOS_PER_PAYMENT, now, 86_400)
      : await relayCount(payment, "relay-memo-all", MEMOS_PER_PAYMENT_ALL, now, 86_400);
  if (!hit.allowed) {
    throw new RelayError("A message for this payment was already sent.", 409, "memo_sent");
  }
  const budget: MemoBudget = payer || partner?.approved === true ? "paid" : partner ? "key" : "open";
  return submit(net, { kind: "memo", args: [commitment, memo], budget });
}

/**
 * Two cheap reads before the dry run, on every send and cash out, so a spent
 * note or a stale root is refused without running the proof check (the pool
 * verifies the proof before it reads `spent`).
 */
async function precheckSpend(net: GloamNetwork, root: Hex, nullifier: Hex) {
  const pub = relayPublicClient(net);
  const [spent, known] = await Promise.all([
    pub.readContract({ address: net.pool!, abi: relayPoolAbi, functionName: "spent", args: [nullifier] }),
    pub.readContract({ address: net.pool!, abi: relayPoolAbi, functionName: "isKnownRoot", args: [root] }),
  ]);
  if (spent) throw new RelayError(REVERT_MESSAGES.AlreadySpent, 409, "AlreadySpent");
  if (!known) throw new RelayError(REVERT_MESSAGES.UnknownRoot, 409, "UnknownRoot");
}

// ---------------------------------------------------------------- gas station

/**
 * Pays for one gas station step for a fresh wallet (lib/relay/gasStation has
 * the rules). Only `wallet` and `step` are read from the request: `make` goes
 * to Borro's factory and `pump` to that wallet's own station, worked out here,
 * so a request has no way to name another target. Off unless the flag is on,
 * and refused before anything is read from the chain.
 */
export async function relayGasStation(net: GloamNetwork, body: Record<string, unknown>, requester: string): Promise<Hex> {
  if (!gasStationOn()) throw new RelayError(STATION_OFF_MESSAGE, 503, "station_off");
  if (net.chainId !== GAS_STATION_CHAIN_ID) throw new RelayError(STATION_NETWORK_MESSAGE, 400, "network");
  const wallet = asAddress(body.wallet, "wallet");
  const step = body.step;
  if (step !== "make" && step !== "pump") throw new RelayError(STATION_BAD_STEP_MESSAGE, 400, "bad_step");
  assertCashOutTarget(net, wallet);
  // The wallet is who these two calls pay. Neither call names it as a payee, so it is screened here.
  if (!(await screenAddresses([wallet])).allowed) throw new RelayError(SCREEN_BLOCKED_MESSAGE, 403, "screened");
  if (!(await relayCount(requester, "relay-station-ip", STATION_IP_HOURLY, Date.now(), 3600)).allowed) {
    throw new RelayError(STATION_IP_LIMIT_MESSAGE, 429, "rate_limit");
  }

  // One at a time per wallet and step, before anything is read: copies sent together
  // would each pass the checks, and all but one pump would burn gas on an empty station.
  let lock: Awaited<ReturnType<typeof takeInflight>>;
  try {
    lock = await takeInflight(inflightKey(net.chainId, `gas-station:${step}:${wallet.toLowerCase()}`));
  } catch (e) {
    if (e instanceof LockStoreDown) throw relayOff();
    throw e;
  }
  if (!lock) throw new RelayError(STATION_IN_FLIGHT_MESSAGE, 409, "in_flight");
  const held = lock;
  let keep = false;
  try {
    const call = await stationCall(net, wallet, step);
    const hash = await submit(net, call, {
      onMaybeSent: () => {
        keep = true;
      },
      sender: () => requester,
      lock: held,
    });
    keep = true;
    return hash;
  } finally {
    if (!keep) await held.release();
  }
}

/** Reads the wallet and its station, applies every rule, takes the day's counts, and builds the one call the relay may send. */
async function stationCall(net: GloamNetwork, wallet: Address, step: "make" | "pump"): Promise<Extract<Call, { kind: "make" | "pump" }>> {
  const pub = relayPublicClient(net);
  let state: Awaited<ReturnType<typeof readStationState>>;
  let gasPrice: bigint;
  try {
    [state, gasPrice] = await Promise.all([readStationState(pub, wallet), pub.getGasPrice()]);
  } catch (e) {
    throw explain(e, "Could not read this wallet's station. Try again shortly.", "check_failed");
  }
  const refused = stationRefusal(step, state);
  if (refused) throw new RelayError(refused.message, refused.status, refused.code);
  if (gasPrice > STATION_MAX_GAS_PRICE_WEI) throw new RelayError(STATION_GAS_HIGH_MESSAGE, 503, GAS_HIGH_CODE);

  let call: Extract<Call, { kind: "make" | "pump" }>;
  if (step === "make") {
    call = { kind: "make", args: [wallet] };
  } else {
    const [account] = await fundedRelayAccounts(net);
    const maxIn = pumpMaxIn(state.stationUsdg);
    let fill: bigint;
    try {
      const sim = await pub.simulateContract({ address: state.station, abi: gasStationAbi, functionName: "pump", args: [0n, maxIn], account });
      fill = sim.result;
    } catch (e) {
      throw explain(e, "Could not turn this into ETH right now. Your USDG stays at the station. Try again shortly.", "check_failed");
    }
    if (fill <= 0n) throw new RelayError(STATION_NO_FILL_MESSAGE, 409, "no_fill");
    call = { kind: "pump", station: state.station, args: [pumpMinOut(fill), maxIn] };
  }

  const now = Date.now();
  if (!(await relayCount(wallet.toLowerCase(), "relay-station-wallet", STATION_WALLET_DAILY, now, 86_400)).allowed) {
    throw new RelayError(STATION_WALLET_LIMIT_MESSAGE, 429, "station_wallet_limit");
  }
  if (!(await relayCount(`chain:${net.chainId}`, "relay-station-net", gasStationDailySends(), now, 86_400)).allowed) {
    throw new RelayError(STATION_BUSY_MESSAGE, 429, "station_busy");
  }
  return call;
}

// ---------------------------------------------------------------- status

export type RelayNetworkStatus = {
  chainId: number;
  key: string;
  enabled: boolean;
  relayer: Address | null;
  memo: boolean;
  lowBalance: boolean;
  /** Gas is over the relay's ceiling on this chain: sends wait, scheduled cash outs wait too. */
  gasHigh: boolean;
  /** The ceiling in gwei, or null on a chain with none. */
  maxGasGwei: string | null;
  /** The gas price in gwei when the chain has a ceiling, else null. */
  gasGwei: string | null;
  /** Dated jobs can be taken here: the chain has them, and the relay can seal them at rest. */
  topUps: boolean;
  /** The relay pays for a fresh wallet's gas station here (lib/relay/gasStation). */
  gasStation: boolean;
  /** The smallest one-hop private swap right now, in dollars, where gas is dear (lib/relay/swapFloor). Else null. */
  swapFloorUsd: number | null;
};

/** Relay balance reads kept briefly, so a public status poll is not an RPC call each time. */
const BALANCE_TTL_MS = 30_000;
const RELAY_RESERVE_GAS = 2n * 2_400_000n;
const balances = new Map<string, { at: number; empty: boolean }>();

/** Tempo has no native coin: fees are paid in the account's chosen stablecoin, else PathUSD. */
const TEMPO_FEE_MANAGER = "0xfeec000000000000000000000000000000000000" as Address;
const TEMPO_PATH_USD = "0x20c0000000000000000000000000000000000000" as Address;
/** 0.50 in a 6-decimal USD fee token: enough for a couple more private transfers. */
const TEMPO_FEE_RESERVE = 500_000n;
const tempoFeeAbi = [
  { name: "userTokens", type: "function", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "address" }] },
  { name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
] as const;
function isTempoChain(chainId: number): boolean {
  return chainId === 42431 || chainId === 4217;
}

/** Whether this relay account can no longer pay for a send on `net`. */
async function relayEmpty(net: GloamNetwork, account: PrivateKeyAccount): Promise<boolean> {
  const id = `${net.chainId}:${account.address}`;
  const hit = balances.get(id);
  if (hit && Date.now() - hit.at < BALANCE_TTL_MS) return hit.empty;
  try {
    const client = relayPublicClient(net);
    const read = async (): Promise<boolean> => {
      if (isTempoChain(net.chainId)) {
        const chosen = await client.readContract({ address: TEMPO_FEE_MANAGER, abi: tempoFeeAbi, functionName: "userTokens", args: [account.address] });
        const token = chosen && chosen !== "0x0000000000000000000000000000000000000000" ? chosen : TEMPO_PATH_USD;
        const balance = await client.readContract({ address: token, abi: tempoFeeAbi, functionName: "balanceOf", args: [account.address] });
        return balance < TEMPO_FEE_RESERVE;
      }
      const [balance, gasPrice] = await Promise.all([client.getBalance({ address: account.address }), client.getGasPrice()]);
      // Under a gas ceiling the relay never pays more than it, so a spike above
      // it is "gas is high", not "the relay is empty".
      const ceiling = maxGasPriceWeiFor(net.chainId);
      const price = ceiling !== null && gasPrice > ceiling ? ceiling : gasPrice;
      // can't pay for a couple more private transfers (about 1.9M gas each)
      return balance < price * RELAY_RESERVE_GAS;
    };
    // a slow RPC must not hold up the status the app checks before every relayed send
    const empty = await Promise.race([
      read(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("relay status: slow rpc")), 3_000)),
    ]);
    balances.set(id, { at: Date.now(), empty });
    if (empty) console.warn("gloam_relay_low_balance", JSON.stringify({ chainId: net.chainId, relayer: account.address }));
    return empty;
  } catch {
    /* status is best effort */
    return false;
  }
}

export async function relayStatus(): Promise<RelayNetworkStatus[]> {
  const accounts = relayerAccounts();
  const account = accounts[0] ?? null;
  return Promise.all(
    relayNetworks().map(async (net) => {
      // low = no account left that can pay for a send here
      const [empties, gas, swapFloorUsd] = await Promise.all([
        Promise.all(accounts.map((a) => relayEmpty(net, a))),
        readGas(net.chainId, relayPublicClient(net)),
        swapRouterFor(net.chainId) ? swapFloorNow(net) : null,
      ]);
      const lowBalance = accounts.length > 0 && empties.every(Boolean);
      return {
        chainId: net.chainId,
        key: net.key,
        // high gas leaves the relay on: a cash out for later can still be scheduled, and waits
        enabled: accounts.length > 0 && !lowBalance,
        relayer: account?.address ?? null,
        memo: Boolean(net.payMemo),
        lowBalance,
        gasHigh: gas.high,
        maxGasGwei: gas.ceilingWei === null ? null : formatGwei(gas.ceilingWei),
        gasGwei: gas.gasPriceWei === null ? null : formatGwei(gas.gasPriceWei),
        topUps: jobKeyReady() && !datedOff(net.chainId),
        gasStation: gasStationOn() && net.chainId === GAS_STATION_CHAIN_ID,
        swapFloorUsd,
      };
    })
  );
}
