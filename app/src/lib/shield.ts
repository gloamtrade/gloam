/**
 * ShieldPool, RH testnet.
 * keccak Phase-1 live pool OR Poseidon Phase-2 (env NEXT_PUBLIC_POSEIDON_SHIELD_POOL).
 */

import { formatUnits, parseUnits, zeroAddress, type Address, type Hex, type PublicClient } from "viem";
import { knownTokens } from "./tokens";
import { getActiveNetwork, type GloamNetwork } from "./networks";
import { makeBoundNote } from "./note";
import { readAmountText } from "./amountText";
import { dataKeyLocked, getAllNotes, setAllNotes, syncFromDisk, unlockNoteVault } from "./noteVault";
import { readDemo } from "./demoFlag";
import type { VaultSwapRefundInfo } from "./vaultSwap";
import type { DelayWindow } from "./relay/scheduled";
import { scanDeposits } from "./depositScan";
import {
  activeHashScheme,
  activePoolAddress,
  activeShieldDeployBlock,
  type HashScheme,
} from "./config";

/** Live keccak RH testnet deploy */
export const TESTNET_SHIELD_POOL =
  "0x2BD98196D90AB45D58843B4c8B8809aa34343d35" as const satisfies Address;

/** getLogs from pool deploy block (sealed Poseidon default; rejects stale A488 env) */
export const SHIELD_DEPLOY_BLOCK = activeShieldDeployBlock();

export const HASH_SCHEME: HashScheme = activeHashScheme();

export const SHIELD_POOL_ADDRESS: Address | null = activePoolAddress();

/** Native ETH in the pool (asset address zero) */
export const NATIVE_ASSET = zeroAddress;

export const shieldPoolAbi = [
  {
    type: "function",
    name: "shield",
    stateMutability: "payable",
    inputs: [
      { name: "asset", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "commitment", type: "bytes32" },
    ],
    outputs: [],
  },
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
  {
    type: "function",
    name: "shieldVerifier",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "commitmentSeen",
    stateMutability: "view",
    inputs: [{ name: "commitment", type: "bytes32" }],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "currentRoot",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "bytes32" }],
  },
  {
    type: "function",
    name: "nextIndex",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "deposited",
    stateMutability: "view",
    inputs: [{ name: "asset", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  // Deposit limits (ShieldPoolCore). Pools deployed before them lack these
  // reads, so a failed read means no limits.
  {
    type: "function",
    name: "depositLimitsOn",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "depositLimit",
    stateMutability: "view",
    inputs: [{ name: "asset", type: "address" }],
    outputs: [
      { name: "perDeposit", type: "uint128" },
      { name: "total", type: "uint128" },
    ],
  },
  { type: "error", name: "OverDepositLimit", inputs: [] },
  // Cash-out fee (ShieldPoolCore, mainnet). Pools deployed before it lack these
  // reads, so a failed read means no fee.
  {
    type: "function",
    name: "withdrawFeeBps",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint16" }],
  },
  {
    type: "function",
    name: "feeRecipient",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "feesOwed",
    stateMutability: "view",
    inputs: [{ name: "asset", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "MAX_WITHDRAW_FEE_BPS",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint16" }],
  },
  {
    type: "function",
    name: "owner",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "verifier",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "isSpent",
    stateMutability: "view",
    inputs: [{ name: "nullifier", type: "bytes32" }],
    outputs: [{ type: "bool" }],
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
    name: "sealedSwap",
    stateMutability: "nonpayable",
    inputs: [
      { name: "proof", type: "bytes" },
      { name: "root", type: "bytes32" },
      { name: "nullifier", type: "bytes32" },
      { name: "newCommitmentOut", type: "bytes32" },
      { name: "newCommitmentChange", type: "bytes32" },
      { name: "assetIn", type: "address" },
      { name: "assetOut", type: "address" },
      { name: "amountOutMin", type: "uint256" },
      { name: "rateIn", type: "uint256" },
      { name: "rateOut", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "sealedSwapVerifier",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "setSealedSwapVerifier",
    stateMutability: "nonpayable",
    inputs: [{ name: "verifier_", type: "address" }],
    outputs: [],
  },
  {
    type: "function",
    name: "PROOF_LAYOUT_VERSION",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "HASH_SCHEME",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "string" }],
  },
  {
    type: "function",
    name: "verifier",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "isKnownRoot",
    stateMutability: "view",
    inputs: [{ name: "root", type: "bytes32" }],
    outputs: [{ type: "bool" }],
  },
  {
    type: "event",
    name: "Shielded",
    inputs: [
      { name: "commitment", type: "bytes32", indexed: true },
      { name: "asset", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
      { name: "leafIndex", type: "uint256", indexed: false },
      { name: "from", type: "address", indexed: true },
    ],
  },
  {
    type: "event",
    name: "Unshielded",
    inputs: [
      { name: "nullifier", type: "bytes32", indexed: true },
      { name: "asset", type: "address", indexed: true },
      { name: "to", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Transferred",
    inputs: [
      { name: "nullifier", type: "bytes32", indexed: true },
      { name: "newCommitments", type: "bytes32[2]", indexed: false },
    ],
  },
] as const;

/** RH L2 gas headroom */
/** Poseidon verify + tree insert, 500k was tight; unshield/transfer need headroom */
export const SHIELD_GAS_LIMIT = 1_500_000n;
/** A private transfer verifies a proof and inserts two notes: about 1.75M on Robinhood Chain. */
export const TRANSFER_GAS_LIMIT = 2_400_000n;
// shieldBound also verifies a Groth16 proof on-chain (~250k extra).
export const SHIELD_BOUND_GAS_LIMIT = 1_900_000n;
/** Sealed swap proof verify is heavier */
export const SEALED_SWAP_GAS_LIMIT = 2_500_000n;
export const APPROVE_GAS_LIMIT = 120_000n;

/**
 * The fixed limits above are sized for Robinhood Chain. Tempo meters gas very
 * differently (a fresh account's approve takes about 534k), and some wallets use
 * the app's number as-is, so on Tempo the wallet estimates instead. Base meters
 * plain EVM gas and estimates well, so it estimates too.
 */
export function gasFor(chainId: number, limit: bigint): bigint | undefined {
  return chainId === 46630 || chainId === 4663 ? limit : undefined;
}

export function isShieldDeployed(): boolean {
  return Boolean(SHIELD_POOL_ADDRESS);
}

/**
 * The chain + pool the app is pointed at right now. Notes are scoped to both:
 * a Tempo note must never show (or be spent) on Robinhood, and a note from a
 * superseded pool deploy is not spendable in the current one.
 */
function activeScope(): { chainId: number; pool: string | null } {
  const n = getActiveNetwork();
  return { chainId: n.chainId, pool: n.pool ? n.pool.toLowerCase() : null };
}

function inActiveScope(
  n: Pick<LocalNote, "chainId" | "pool">,
  scope = activeScope()
): boolean {
  if (n.chainId !== scope.chainId) return false;
  if (scope.pool && n.pool && n.pool.toLowerCase() !== scope.pool) return false;
  return true;
}

/** A chain and its vault: a network, or anything that names one (a payroll run, a tree). */
type NetScope = { chainId: number; pool: string | null };

const scopeOf = (net: NetScope) => ({ chainId: net.chainId, pool: net.pool ? net.pool.toLowerCase() : null });

/**
 * A note is on a network only when both its chain and its vault match. The
 * vault alone never tells: Robinhood Chain, Tempo and Base Sepolia (and Base
 * mainnet after it) run the mainnet pool at one address, so a note matched on
 * the vault would show, and offer itself, on every one of them.
 */
export function noteOnNetwork(n: Pick<LocalNote, "chainId" | "pool">, net: NetScope): boolean {
  return inActiveScope(n, scopeOf(net));
}

/** The notes of `notes` that are on `net` (chain and vault). */
export function notesOnNetwork<T extends Pick<LocalNote, "chainId" | "pool">>(notes: readonly T[], net: NetScope): T[] {
  const scope = scopeOf(net);
  return notes.filter((n) => inActiveScope(n, scope));
}

/**
 * What a view of notes shows (hooks/useLocalShieldNotes): only notes on
 * `network` (chain and vault), and none before the page knows its network.
 * The view's state can still hold another chain's notes for a moment (read
 * before a switch, or by a sync that started on the old network and finished
 * after it), and the mainnet vaults and Base Sepolia share one address, so
 * Robinhood Chain mainnet notes showed, and could be picked, on Base Sepolia.
 */
export function visibleNotes(
  local: readonly LocalNote[],
  chain: readonly LocalNote[],
  network: NetScope,
  settled: boolean
): { local: LocalNote[]; chain: LocalNote[] } {
  if (!settled) return { local: [], chain: [] };
  return { local: notesOnNetwork(local, network), chain: notesOnNetwork(chain, network) };
}

/**
 * The notes an empty ETH inventory retires (the "ghost ETH" cleanup after a
 * sync): open ETH notes on `net` with no nullifier, which isSpent can't settle.
 * A note with a nullifier is settled by isSpent alone, so a node that answers
 * 0 for a brand new pool, or a read made on another chain, can never take it
 * out of the balance.
 */
export function ghostEthNotes(notes: readonly LocalNote[], net: NetScope): LocalNote[] {
  return notesOnNetwork(notes, net).filter(
    (n) => n.status !== "recovered" && (!n.nullifier || n.nullifier === "0x") && isNativeAsset(n.asset)
  );
}

export const NOTE_OTHER_NETWORK_MESSAGE = "This balance is on another network. Switch to that network to use it.";
export const NETWORK_SWITCHING_MESSAGE = "The network is still switching. Wait a moment, then try again.";

/**
 * Why `note` can't be spent or proved on `net` right now, or null. Besides the
 * note's own chain and vault, the network lib code reads (the tree, the
 * proving keys, the relay's chain) must be `net` too: a proof is only ever
 * built and sent for the chain the page shows.
 */
export function noteNetworkProblem(note: { chainId: number; pool?: string | null }, net: NetScope): string | null {
  if (!net.pool || note.chainId !== net.chainId || !note.pool || note.pool.toLowerCase() !== net.pool.toLowerCase()) {
    return NOTE_OTHER_NETWORK_MESSAGE;
  }
  const active = activeScope();
  if (active.chainId !== net.chainId || active.pool !== net.pool.toLowerCase()) return NETWORK_SWITCHING_MESSAGE;
  return null;
}

/** Throws noteNetworkProblem's reason: call it before proving or sending anything that spends `note`. */
export function assertNoteOnNetwork(note: { chainId: number; pool?: string | null }, net: NetScope): void {
  const problem = noteNetworkProblem(note, net);
  if (problem) throw new Error(problem);
}

/** Listed tokens, the active network's first (an address can sit on two chains). */
const knownForActive = () => knownTokens(getActiveNetwork().chainId);

export function isNativeAsset(asset: string) {
  return !asset || asset.toLowerCase() === NATIVE_ASSET.toLowerCase();
}

export function assetLabel(asset: string): string {
  if (isNativeAsset(asset)) return getActiveNetwork().primaryAsset.symbol;
  const t = knownForActive().find(
    (x) => x.address.toLowerCase() === asset.toLowerCase()
  );
  return t?.symbol ?? shortAsset(asset);
}

export function assetDecimals(asset: string): number {
  if (isNativeAsset(asset)) return 18;
  const t = knownForActive().find(
    (x) => x.address.toLowerCase() === asset.toLowerCase()
  );
  return t?.decimals ?? 18;
}

/** Human amount for a raw note value, using the asset's real decimals (PathUSD 6, ETH 18). */
export function formatAssetAmount(raw: bigint | string, asset: string, maxFrac = 6): string {
  let v: bigint;
  try {
    v = typeof raw === "bigint" ? raw : BigInt(raw || "0");
  } catch {
    return String(raw);
  }
  if (v === 0n) return "0";
  const n = Number(formatUnits(v, assetDecimals(asset)));
  if (!Number.isFinite(n)) return formatUnits(v, assetDecimals(asset));
  const floor = 1 / 10 ** Math.min(maxFrac, 4);
  if (n > 0 && n < floor) return `<${floor}`;
  return n.toLocaleString("en-US", { maximumFractionDigits: maxFrac });
}

/**
 * Decimal places for a total or a balance in a summary (payroll runs, caps,
 * schedules): cents for the 6-decimal stablecoins, 6 places for an 18-decimal
 * coin such as ETH, where 0.01 is already a real amount (0.004 ETH read
 * "<0.01").
 */
export function summaryDecimals(asset: string): number {
  return assetDecimals(asset) > 6 ? 6 : 2;
}

/**
 * A raw amount with every unit kept ("1,250.5", "0.004"), never rounded, for
 * amounts someone acts on or files: a deposit to make, an invoice line, a run
 * total. `minFrac` pads the decimals, so an invoice reads "1,250.50".
 */
export function formatAssetAmountExact(raw: bigint | string, asset: string, minFrac = 0): string {
  let v: bigint;
  try {
    v = typeof raw === "bigint" ? raw : BigInt(raw || "0");
  } catch {
    return String(raw);
  }
  const decimals = assetDecimals(asset);
  const [whole, frac = ""] = formatUnits(v, decimals).split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const digits = frac.padEnd(Math.min(minFrac, decimals), "0");
  return digits ? `${grouped}.${digits}` : grouped;
}

/** "12.5 PathUSD" style label for a raw amount. */
export function formatAssetLabel(raw: bigint | string, asset: string): string {
  return `${formatAssetAmount(raw, asset)} ${assetLabel(asset)}`;
}

/**
 * The cash-out fee the pool keeps from `amount` at `bps` basis points. Same
 * math as ShieldPoolCore.unshield: floor(amount * bps / 10_000).
 */
export function withdrawFeeOf(amount: bigint, bps: number): bigint {
  if (!Number.isInteger(bps) || bps <= 0) return 0n;
  return (amount * BigInt(bps)) / 10_000n;
}

/** "0.5%" for 50 bps, "0.25%" for 25, "1%" for 100. */
export function formatFeePercent(bps: number): string {
  return `${(bps / 100).toFixed(2).replace(/\.?0+$/, "")}%`;
}

/**
 * Parse a typed amount into raw units for this asset (null when invalid). Reads
 * through lib/amountText, so "1,25" and "-1" are refused, never turned into 125 or 1.
 */
export function parseAssetAmount(input: string, asset: string): bigint | null {
  const decimals = assetDecimals(asset);
  const read = readAmountText(input, decimals);
  if (!read.ok || !read.text) return null;
  const [a, b = ""] = read.text.split(".");
  try {
    return parseUnits(b ? `${a || "0"}.${b}` : a, decimals);
  } catch {
    return null;
  }
}

function shortAsset(addr: string) {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

/**
 * Bound note for shield(), keccak scheme (legacy live pool).
 * Poseidon notes: use makeBoundNotePoseidon from notePoseidon.ts
 */
export function makeNoteMaterial(
  amount: bigint,
  asset: Address = NATIVE_ASSET
): { secret: Hex; commitment: Hex; nullifier: Hex } {
  return makeBoundNote(amount, asset);
}

export type LocalNote = {
  id: string;
  chainId: number;
  pool: Address;
  asset: Address;
  amountWei: string;
  commitment: Hex;
  /** Empty when reconstructed from chain only */
  secret: Hex;
  /** Precomputed for unshield when secret is known */
  nullifier?: Hex;
  /** true when commitment binds secret+amount+asset */
  bound?: boolean;
  /** poseidon = circuit-compatible; keccak = live Phase-1 */
  scheme?: HashScheme;
  leafIndex?: number;
  txHash?: Hex;
  from?: Address;
  createdAt: number;
  status?: "open" | "recovered";
  /** local = browser secret; chain = public Shielded event */
  source?: "local" | "chain";
  /**
   * The payer's private note on a received payment ("Invoice 042"), from the
   * payment itself (lib/paymentNote). Kept with the note's secret, so it is
   * encrypted at rest; never part of a proof.
   */
  note?: string;
  /**
   * A claimed payment (`imp-` id) that has been secured: moved into a fresh
   * note only this browser knows, so the payer can no longer spend it
   * (lib/claimSweep). The claimed note itself is spent by that move.
   */
  secured?: boolean;
  /**
   * A claimed payment the vault has not shown yet (its commitment is not in the
   * pool): someone may have made the code without paying it, or the payment is
   * still on its way. Kept, out of the balance until the vault shows it;
   * lib/claimSweep reconcileUnfunded checks again on every sync. False once
   * the vault has shown it.
   */
  unfunded?: boolean;
  /**
   * When this note last backed a proof of funds (ms). The proof carries the
   * note's spend nullifier, which a cash out or swap of the whole note would
   * emit next to where the money went and how much (GHSA-x8fx-frxx-7f66), so
   * such a note is moved to a fresh note first (lib/cashOutSplit spendPlanFor).
   */
  fundsProofAt?: number;
  /**
   * When a private swap of this note went out (ms), set once that swap is known
   * to have landed and reverted, or has shown nothing for an hour with no hash
   * to read (lib/claimSweep SWAP_UNSEEN_MS). Its unshield proof stays valid until
   * this note is spent, so the note moves whole to a fresh note as soon as the
   * relay takes it (lib/claimSweep moveRevertedNotes), and anything else that
   * spends it moves it first (lib/cashOutSplit spendPlanFor).
   */
  swapProofAt?: number;
  /**
   * When a proof of a cash out of this note left this browser for the relay to
   * send later (ms), on disk before it goes. That proof stays valid until the note
   * is spent, whatever the relay does with its copy, so once no cash out waits on
   * it the note can't be spent until it has moved to a fresh note (proofLoose,
   * lib/claimSweep moveRevertedNotes).
   */
  proofOutAt?: number;
  /** Until when (ms) that proof is on its way to the relay: see HANDOVER_MS. */
  handoverUntil?: number;
  /** On the fresh note from securing a claim, or a cash-out split: the note it came from (settled together). */
  sweptFrom?: { id: string; nullifier: Hex };
  /**
   * The move into this note was sent (or may have been) but has not been seen
   * on chain yet. Not counted in the balance until it lands; kept, never
   * dropped, because it may still land (lib/claimSweep reconciles it).
   */
  sweepPending?: boolean;
  /**
   * A cash out of this note scheduled with the relay ("cash out later",
   * lib/cashOutLater). While it waits or is on its way it is out of the balance;
   * when it comes back unsent (expired, failed, cancelled, with the chain showing
   * the note unspent) the note is spendable again.
   */
  cashOut?: CashOutMark;
  /**
   * A piece of a private cash out (lib/cashOutPrivately): which plan, which
   * piece, and where and when it was meant to go. Set when the piece is split
   * off, before anything is sent, so a piece that never got scheduled (a relay
   * that was down, a closed tab) still shows as one and can be scheduled again.
   */
  cashOutPlan?: CashOutPlanTag;
  /**
   * On a private swap's refund note (lib/vaultSwap): what finishing the refund
   * needs, if someone sends the swapped note's unshield on its own. While the
   * money waits at the swap's escrow the note stays pending, never dead.
   */
  vaultSwap?: VaultSwapRefundInfo;
  /**
   * On a private swap's refund note, once a sync has found its money at the
   * swap's escrow: "returning" while the refund is on its way, "blocked" while
   * the vault won't take it (its limit for the asset is closed or full). The
   * note stays pending and every sync tries again (heldSwapRefunds lists it).
   */
  refundHeld?: "returning" | "blocked";
  /**
   * Went in as history because the vault showed it spent when a backup was
   * restored here. Never trimmed, and never counted against the history cap.
   */
  restoredSpent?: boolean;
};

export type CashOutMark = {
  /** The relay's job id (no secret: the job holds only the proof and its public inputs). */
  job: string;
  /** When it goes out, about (ms). */
  at: number;
  /** Where it goes, for the note's own row. */
  to: Address;
  state: "scheduled" | "sent" | "expired" | "failed" | "cancelled";
  /**
   * The vault root the relay's proof was last made against, and when (ms), as
   * far as this browser knows. A waiting proof is renewed against a later root
   * while the app is open (lib/cashOutReprove); unset when not known here.
   */
  root?: Hex;
  provenAt?: number;
  /**
   * The cash-out fee the screen showed when this was set up, in basis points.
   * The vault takes the fee when it goes out, at the rate that day, so the two
   * can differ (lib/cashOutLater feeRise). Unset on one set up before the app
   * kept it: those all showed 25.
   */
  feeBps?: number;
};

/** One piece of a private cash out ("cash out privately", lib/cashOutPrivately). */
export type CashOutPlanTag = {
  /** The plan's id, shared by its pieces (no secret). */
  plan: string;
  /** This piece, from 1. */
  piece: number;
  /** How many pieces the plan has. */
  of: number;
  /** Where this piece was meant to go. */
  to: Address;
  /** The window it was meant to go out in. */
  window: DelayWindow;
  /** On a prepaid agent top-up (lib/agentTopUp): the day it goes out instead. */
  topUp?: TopUpTag;
};

/** What a top-up remembers, so it can be scheduled again and still shows once it is over. */
export type TopUpTag = {
  /** The UTC day it goes out (ms at the start of that day). */
  day: number;
  /** Days between top-ups: the rest of the series' days follow from this one. */
  everyDays: number;
  /** It went back to being plain money in the balance, and how. */
  ended?: "cancelled" | "returned" | "kept";
  /** Where the relay says this series failed or is held, when the owner asked it to (lib/relay/webhook). */
  webhook?: string;
};

/** A piece's tag once it stops being one: gone, or on a top-up, kept for the record of how it ended. */
export function endedPlan(tag: CashOutPlanTag | undefined, how: NonNullable<TopUpTag["ended"]>): CashOutPlanTag | undefined {
  return tag?.topUp ? { ...tag, topUp: { ...tag.topUp, ended: how } } : undefined;
}

/** A cash out is waiting or on its way: the note will be spent, so it is not counted. */
export function cashOutPending(n: Pick<LocalNote, "cashOut">): boolean {
  return n.cashOut?.state === "scheduled" || n.cashOut?.state === "sent";
}

/**
 * The longest the relay holds a spend's nullifier once it has sent it: until
 * then it can refuse any other spend of that note (lib/relay/inflight
 * INFLIGHT_TTL_SEC, which this follows). It lets go sooner when it reads a
 * reverted receipt for that send, which is the usual end of a reverted swap.
 */
export const RELAY_SPEND_LOCK_MS = 180_000;

/** Ms until the relay is sure to take a spend of a note whose swap reverted, 0 when it is (or none did). */
export function swapProofWait(n: Pick<LocalNote, "swapProofAt">, now = Date.now()): number {
  return n.swapProofAt ? Math.max(0, n.swapProofAt + RELAY_SPEND_LOCK_MS - now) : 0;
}

/**
 * How long a proof gets to reach the relay and come back as a job: twice the
 * route's 60-second limit. Until the reply says how it went the note is not
 * moved, by this tab or another, or a sync would end a healthy top-up. It can't
 * be spent meanwhile either, and a tab closed mid-way simply lets this run out.
 */
export const HANDOVER_MS = 120_000;

/**
 * A proof of this note left the browser and no cash out waits on it any more:
 * cancelled, refused, given up on or lost. Whoever holds a copy could still send
 * it, so the note stays out of the balance until the move ends that proof.
 */
export function proofLoose(n: Pick<LocalNote, "proofOutAt" | "cashOut" | "status">): boolean {
  if (n.status === "recovered" || cashOutPending(n)) return false;
  // a mark that came back says the same, for a cash out scheduled before proofOutAt was kept
  return Boolean(n.proofOutAt) || Boolean(n.cashOut);
}

/** What clears a note's cash-out mark. The fact that its proof left is kept, or the note would skip its move. */
export function markCleared(n: Pick<LocalNote, "proofOutAt" | "cashOut">): Pick<LocalNote, "cashOut" | "proofOutAt"> {
  return { cashOut: undefined, proofOutAt: n.proofOutAt ?? (n.cashOut ? Date.now() : undefined) };
}

export function confirmedNotes(notes: LocalNote[]): LocalNote[] {
  return notes.filter((n) => Boolean(n.txHash) && n.status !== "recovered");
}

/**
 * Notes you can still spend (have a local secret).
 * Includes imports (no txHash yet) and confirmed shields/transfers.
 * Excludes recovered and chain-history-only rows without a secret.
 * Excludes historic sender payment rows (id pay-*), a secured claim's fresh
 * note until its move lands (the claimed note still counts until then), a
 * claimed payment the vault has not shown yet, a note whose cash out is
 * scheduled or on its way, and a note whose proof is still out (proofLoose).
 * Every spend picks its notes here, so that is what blocks them.
 */
export function activeSpendableNotes(notes: LocalNote[]): LocalNote[] {
  return notes.filter((n) => holdsSecret(n) && !n.sweepPending && !n.unfunded && !cashOutPending(n) && !proofLoose(n));
}

/** Notes the sync moves now to end a proof still out: a top-up's, and a reverted swap's. */
export function notesToMove(notes: LocalNote[], now = Date.now()): LocalNote[] {
  return notes.filter(
    (n) =>
      holdsSecret(n) &&
      !n.sweepPending &&
      !n.unfunded &&
      !cashOutPending(n) &&
      (proofLoose(n) ? (n.handoverUntil ?? 0) <= now : Boolean(n.swapProofAt))
  );
}

/** Claimed payments waiting for the vault to show them: listed, never counted. */
export function unfundedClaims(notes: LocalNote[]): LocalNote[] {
  return notes.filter((n) => n.unfunded && holdsSecret(n));
}

/** Swap refunds whose money waits at the swap's escrow: listed, never counted, until they land. */
export function heldSwapRefunds(notes: LocalNote[]): LocalNote[] {
  return notes.filter((n) => n.refundHeld && n.sweepPending && holdsSecret(n));
}

/** Not spent, and this browser has its secret (a pending secured claim too). */
function holdsSecret(n: LocalNote): boolean {
  return (
    n.status !== "recovered" &&
    !n.id.startsWith("pay-") &&
    Boolean(n.secret) &&
    n.secret !== "0x" &&
    n.secret.length > 10
  );
}

/**
 * Retire payment notes wrongly saved on the sender (pre-audit bug).
 * Safe to call on every load.
 */
export function purgeSenderPaymentNotes(): boolean {
  if (typeof window === "undefined") return false;
  const all = getAllNotes();
  let changed = false;
  const next = all.map((n) => {
    if (n?.id?.startsWith("pay-") && n.status !== "recovered") {
      changed = true;
      return { ...n, status: "recovered" as const };
    }
    return n;
  });
  if (changed) setAllNotes(next);
  return changed;
}

export type NotesBackup = {
  v: 1;
  type: "gloam-notes-backup";
  exportedAt: number;
  chainId: number;
  notes: LocalNote[];
};

/**
 * Bring this tab's copy of the notes up to the store on disk. A page without
 * the notes hook (Settings) never re-reads it: its copy can be from before a
 * claim was secured in another tab, or empty until the vault is unlocked. A
 * vault still behind its passkey is left alone (this never asks for it).
 */
async function readStoreNow(): Promise<void> {
  if (typeof window === "undefined" || readDemo() || dataKeyLocked()) return;
  await unlockNoteVault();
  await syncFromDisk();
}

/**
 * Export spendable notes (secrets!) for device backup, from the store as it is
 * now: a backup copied in a tab opened before a claim was secured elsewhere
 * held the claim, not the note it was secured into.
 */
export async function exportNotesBackup(address?: string | null): Promise<NotesBackup> {
  await readStoreNow();
  purgeSenderPaymentNotes();
  // A secured claim's pending note goes too: its move may still land.
  const notes = loadLocalNotes(address).filter(holdsSecret);
  return {
    v: 1,
    type: "gloam-notes-backup",
    exportedAt: Date.now(),
    chainId: activeScope().chainId,
    notes,
  };
}

/**
 * What the vault says about a backup's note: true when it is spent, false when
 * not, null when it can't tell (lib/claimSweep backupSpentCheck).
 */
export type BackupSpentCheck = (n: LocalNote) => Promise<boolean | null>;

/**
 * What the vault says about a backup's note: true when it holds the note's
 * commitment, false when not, null when it can't tell (lib/claimSweep backupSeenCheck).
 */
export type BackupSeenCheck = (n: LocalNote) => Promise<boolean | null>;

const HEX_FIELD = /^0x[0-9a-fA-F]{1,64}$/;
const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * Whether a backup's note is one this app could have made: an id, field
 * elements, an amount above 0 and below 2^128, real addresses, and for a
 * Poseidon note a commitment equal to Poseidon(secret, amount, asset). The
 * claim path checks the same (notePackage, MoveView claimCode); a made-up
 * backup file otherwise shows any balance, and an amount like "1e5" breaks
 * every balance sum.
 */
async function backupNoteValid(n: LocalNote): Promise<boolean> {
  if (typeof n.id !== "string" || !n.id || typeof n.pool !== "string" || !HEX_ADDRESS.test(n.pool)) return false;
  if (typeof n.amountWei !== "string" || !/^\d{1,39}$/.test(n.amountWei)) return false;
  const amount = BigInt(n.amountWei);
  if (amount <= BigInt(0) || amount >= BigInt(1) << BigInt(128)) return false;
  if (typeof n.asset !== "string" || !HEX_ADDRESS.test(n.asset)) return false;
  if (typeof n.secret !== "string" || !HEX_FIELD.test(n.secret) || typeof n.commitment !== "string" || !HEX_FIELD.test(n.commitment)) {
    return false;
  }
  // the old keccak notes (testnet only) carry 256-bit secrets and are not Poseidon
  if (n.scheme === "keccak") return true;
  const { FIELD_PRIME, noteCommitmentPoseidon, fieldToHex } = await import("@gloamtrade/sdk");
  if (BigInt(n.secret) >= FIELD_PRIME || BigInt(n.commitment) >= FIELD_PRIME) return false;
  const want = fieldToHex(await noteCommitmentPoseidon(BigInt(n.secret), amount, n.asset));
  return BigInt(want) === BigInt(n.commitment);
}

const HEX_32 = /^0x[0-9a-fA-F]{64}$/;
const DIGITS = /^\d{1,78}$/;

/** A time (ms) a backup may carry, or undefined. */
function timeOrNone(v: unknown): number | undefined {
  return typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : undefined;
}

/**
 * A fresh id for a restored note, of the same kind as the backup's: a claim
 * stays a claim (`imp-`, so it is still secured), a deposit a deposit. Never
 * the backup's own id, so a restore can't land on a note already here.
 */
function restoredId(oldId: string, taken: Set<string>): string {
  for (;;) {
    const rand = Array.from(globalThis.crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, "0")).join("");
    const kind = /^([a-z]{1,8})-/.exec(oldId)?.[1];
    const id = /^\d{12,}-0x[0-9a-f]+$/i.test(oldId)
      ? `${Date.now()}-0x${rand}`
      : `${kind && kind !== "pay" && kind !== "chain" ? kind : "bk"}-${Date.now()}-${rand}`;
    if (!taken.has(id)) {
      taken.add(id);
      return id;
    }
  }
}

/** A private swap's refund details as a backup holds them, checked field by field, or undefined. */
function swapInfoOf(v: unknown): VaultSwapRefundInfo | undefined {
  const o = v as Partial<VaultSwapRefundInfo> | null;
  if (!o || typeof o !== "object") return undefined;
  const addr = (a: unknown): a is Address => typeof a === "string" && HEX_ADDRESS.test(a);
  const out = o.out;
  if (!addr(o.router) || !addr(o.assetIn) || typeof o.amountIn !== "string" || !DIGITS.test(o.amountIn)) return undefined;
  if (!out || typeof out.commitment !== "string" || !HEX_FIELD.test(out.commitment) || !addr(out.asset) || typeof out.amount !== "string" || !DIGITS.test(out.amount)) {
    return undefined;
  }
  if (!Array.isArray(o.route) || o.route.length > 8) return undefined;
  const route = o.route.map((k) =>
    k && addr(k.currency0) && addr(k.currency1) && addr(k.hooks) && Number.isSafeInteger(k.fee) && Number.isSafeInteger(k.tickSpacing)
      ? { currency0: k.currency0, currency1: k.currency1, fee: k.fee, tickSpacing: k.tickSpacing, hooks: k.hooks }
      : null
  );
  if (route.some((k) => k === null)) return undefined;
  const sent = o.sent && typeof o.sent.hash === "string" && HEX_32.test(o.sent.hash) && timeOrNone(o.sent.at) ? { hash: o.sent.hash, at: o.sent.at } : undefined;
  return {
    router: o.router,
    assetIn: o.assetIn,
    amountIn: o.amountIn,
    out: { commitment: out.commitment, asset: out.asset, amount: out.amount },
    route: route as VaultSwapRefundInfo["route"],
    ...(sent ? { sent } : {}),
  };
}

/**
 * A restored note, rebuilt from what a backup proves (the money fields, checked
 * by backupNoteValid) and nothing it merely says: the spend marker is worked
 * out from the secret, the state comes from the vault (`gone`, `waiting`), and
 * the id is new. What a backup may still carry, checked: the note's memo, its
 * own privacy marks (a proof of it may be out, so it moves to a fresh note
 * before it is spent), and a move between two notes of this same backup, by
 * their new ids. Never anything that names a note already here (`taken` holds
 * every id here, and every id this restore has given out).
 */
async function restoredNote(
  n: LocalNote,
  id: string,
  ids: Map<string, string>,
  state: { gone: boolean; waiting: boolean; owner?: Address; taken: Set<string> }
): Promise<LocalNote> {
  const poseidon = n.scheme !== "keccak";
  let nullifier: Hex | undefined;
  if (poseidon) {
    const { fieldToHex, hexToField, noteNullifierPoseidon } = await import("@gloamtrade/sdk");
    nullifier = fieldToHex(await noteNullifierPoseidon(hexToField(n.secret), hexToField(n.commitment))) as Hex;
  } else if (typeof n.nullifier === "string" && HEX_FIELD.test(n.nullifier)) {
    nullifier = n.nullifier;
  }
  // A move into this note keeps its spend marker, so a pending one still settles. It names the
  // note it came from by that note's new id when this backup holds it too, by an id naming no
  // note when it holds neither, and is dropped when it would name a note already here.
  const from = n.sweptFrom;
  let linked: LocalNote["sweptFrom"];
  if (from && typeof from.id === "string" && typeof from.nullifier === "string" && HEX_FIELD.test(from.nullifier)) {
    if (ids.has(from.id)) linked = { id: ids.get(from.id)!, nullifier: from.nullifier };
    else if (!state.taken.has(from.id)) linked = { id: restoredId(from.id, state.taken), nullifier: from.nullifier };
  }
  const swap = linked ? swapInfoOf(n.vaultSwap) : undefined;
  const memo = typeof n.note === "string" && n.note.trim() ? n.note.slice(0, 500) : undefined;
  const marks = {
    ...(timeOrNone(n.fundsProofAt) ? { fundsProofAt: n.fundsProofAt } : {}),
    ...(timeOrNone(n.swapProofAt) ? { swapProofAt: n.swapProofAt } : {}),
    ...(timeOrNone(n.proofOutAt) ? { proofOutAt: n.proofOutAt } : {}),
  };
  return {
    id,
    chainId: n.chainId,
    pool: n.pool,
    asset: n.asset,
    amountWei: n.amountWei,
    commitment: n.commitment,
    secret: n.secret,
    ...(nullifier ? { nullifier } : {}),
    bound: true,
    scheme: poseidon ? "poseidon" : "keccak",
    createdAt: timeOrNone(n.createdAt) ?? Date.now(),
    ...(state.owner ? { from: state.owner } : typeof n.from === "string" && HEX_ADDRESS.test(n.from) ? { from: n.from } : {}),
    // spent since the backup: history (a received payment can still be proved), not balance
    status: state.gone ? "recovered" : "open",
    source: "local",
    ...(state.gone ? { restoredSpent: true } : {}),
    ...(state.waiting ? { unfunded: true } : {}),
    ...(memo ? { note: memo } : {}),
    ...marks,
    ...(linked ? { sweptFrom: linked, ...(n.sweepPending === true ? { sweepPending: true } : {}), ...(swap ? { vaultSwap: swap } : {}) } : {}),
  };
}

export type BackupImport =
  | {
      ok: true;
      /** Balances added. */
      count: number;
      /** Notes this browser already had, kept as they are here. */
      kept: number;
      /** Notes new here that the vault shows spent since the backup: kept as history, never counted. */
      moved: number;
      /** Of those, claimed payments: secured (or taken back) after the backup was made. */
      movedClaims: number;
      /** Notes new here the vault has not seen: kept out of the balance until it does. */
      unseen: number;
      /** Notes that are not ones this app could have made: left out. */
      skipped: number;
    }
  | { ok: false; error: string };

/**
 * Merge a backup into this browser. A backup only adds what this browser
 * doesn't have. A note it already holds (same id, or the same commitment)
 * keeps its own state, which is never older than the backup's copy: spent,
 * secured, landed, a cash out on its way. Only the wallet it shows under
 * becomes the one restoring it. Writing the backup's copy over it put a claim
 * the sweep had spent back in the balance until the next sync retired it,
 * counted next to the note it was secured into, and wiped its secured mark.
 *
 * A note new here is asked about first (`isSpent`, all at once): one the vault
 * shows spent goes in as history, so a backup made before a claim was secured
 * never shows that claim as money, not even for the few seconds before a sync.
 * One it can't read goes in as before, for the sync to settle. Settles once
 * the notes are on disk (rejects with NoteSaveError when the browser refuses).
 *
 * A note new here must be one this app could have made (backupNoteValid), or
 * it is left out and counted in `skipped`. One the vault has not seen
 * (`isSeen` false) goes in `unfunded`: out of the balance until the vault
 * shows it (lib/claimSweep reconcileUnfunded). A backup is a file anyone can
 * hand someone, so it never shows money the vault doesn't hold.
 *
 * A note new here is rebuilt (restoredNote) under a new id: what the file says
 * about state is not taken, and nothing in it can name a note already here. A
 * note already here is matched by its commitment, and is only shown under the
 * restoring wallet when the file holds its secret too; its state never changes.
 */
export async function importNotesBackup(
  raw: string,
  address?: string | null,
  isSpent?: BackupSpentCheck,
  isSeen?: BackupSeenCheck
): Promise<BackupImport> {
  let data: NotesBackup;
  try {
    data = JSON.parse(raw) as NotesBackup;
  } catch {
    return { ok: false, error: "Could not parse backup JSON." };
  }
  if (data?.type !== "gloam-notes-backup" || data.v !== 1) {
    return { ok: false, error: "Not a Gloam notes backup." };
  }
  const scope = activeScope();
  if (data.chainId !== scope.chainId) {
    return { ok: false, error: "Backup is for a different network. Switch networks and try again." };
  }
  if (!Array.isArray(data.notes)) {
    return { ok: false, error: "Backup has no notes." };
  }
  // what is already here is read from the store itself, not this tab's copy of it
  await readStoreNow();
  const owner = (address as Address | undefined) ?? undefined;
  const here = new Set<string>();
  const candidates: LocalNote[] = [];
  for (const n of data.notes) {
    if (!n?.secret || !n?.commitment || !n?.amountWei) continue;
    if (typeof n.secret !== "string" || typeof n.commitment !== "string" || typeof n.id !== "string") continue;
    if (n.chainId !== scope.chainId) continue;
    if (n.id.startsWith("pay-") || n.status === "recovered") continue;
    const commitment = n.commitment.toLowerCase();
    const local = getAllNotes().find(
      (m) => m.chainId === n.chainId && m.commitment.toLowerCase() === commitment && Boolean(m.secret) && m.secret !== "0x"
    );
    if (local) {
      // the file holds this note's secret too: the same note, shown under the wallet restoring it
      if (local.secret.toLowerCase() === n.secret.toLowerCase()) here.add(local.id);
    } else {
      candidates.push(n);
    }
  }
  const valid = await Promise.all(candidates.map((n) => backupNoteValid(n).catch(() => false)));
  const skipped = valid.filter((v) => !v).length;
  // one note per commitment
  const added: LocalNote[] = [];
  candidates.forEach((n, i) => {
    if (!valid[i]) return;
    const c = n.commitment.toLowerCase();
    if (!added.some((a) => a.commitment.toLowerCase() === c)) added.push(n);
  });
  const [spent, seen] = await Promise.all([
    // asked by the spend marker the secret gives (a legacy keccak note can only say its own)
    Promise.all(added.map((n) => (isSpent ? isSpent({ ...n, nullifier: n.scheme === "keccak" ? n.nullifier : undefined }).catch(() => null) : null))),
    Promise.all(added.map((n) => (isSeen ? isSeen(n).catch(() => null) : null))),
  ]);

  // every restored note gets a new id; a move between two notes of this backup keeps pointing at the right one
  const taken = new Set(getAllNotes().map((m) => m.id));
  const newIds = added.map((n) => restoredId(n.id, taken));
  // what a move in this backup names, by the file's id: the first note with that id
  const ids = new Map<string, string>();
  added.forEach((n, i) => {
    if (!ids.has(n.id)) ids.set(n.id, newIds[i]!);
  });
  const writes: Promise<void>[] = [];
  let moved = 0;
  let movedClaims = 0;
  let unseen = 0;
  const rebuilt = await Promise.all(
    added.map((n, i) => {
      const gone = spent[i] === true;
      // not in the vault (yet): kept, out of the balance until it is
      const waiting = !gone && seen[i] === false;
      if (gone) {
        moved++;
        if (n.id.startsWith("imp-")) movedClaims++;
      }
      if (waiting) unseen++;
      return restoredNote(n, newIds[i]!, ids, { gone, waiting, owner, taken });
    })
  );
  for (const note of rebuilt) writes.push(saveLocalNote(note));
  // a restore adds what it holds to the wallet restoring it, notes already here too
  const lower = owner?.toLowerCase();
  if (lower && getAllNotes().some((m) => here.has(m.id) && m.from && m.from.toLowerCase() !== lower)) {
    writes.push(
      setAllNotes(getAllNotes().map((m) => (here.has(m.id) && m.from && m.from.toLowerCase() !== lower ? { ...m, from: owner } : m)))
    );
  }
  await Promise.all(writes);
  return { ok: true, count: added.length - moved - unseen, kept: here.size, moved, movedClaims, unseen, skipped };
}

/** ETH only (native asset), spendable notes only */
export function sumEthWei(notes: LocalNote[]): bigint {
  return activeSpendableNotes(notes)
    .filter((n) => isNativeAsset(n.asset))
    .reduce((s, n) => s + BigInt(n.amountWei || "0"), BigInt(0));
}

/** @deprecated use sumEthWei */
export function sumNoteWei(notes: LocalNote[]): bigint {
  return sumEthWei(notes);
}

export function sumByAsset(notes: LocalNote[]): Map<string, bigint> {
  const m = new Map<string, bigint>();
  for (const n of activeSpendableNotes(notes)) {
    const k = n.asset.toLowerCase();
    m.set(k, (m.get(k) ?? BigInt(0)) + BigInt(n.amountWei || "0"));
  }
  return m;
}

export function markAllNotesRecovered(
  address?: string | null,
  asset?: Address | null
) {
  if (typeof window === "undefined") return;
  const lower = address?.toLowerCase();
  const assetLower = asset?.toLowerCase();
  const scope = activeScope();
  const next = getAllNotes().map((n) => {
    if (!inActiveScope(n, scope)) return n;
    if (lower && n.from && n.from.toLowerCase() !== lower) return n;
    if (!n.txHash) return n;
    if (assetLower && n.asset.toLowerCase() !== assetLower) return n;
    return { ...n, status: "recovered" as const };
  });
  setAllNotes(next);
}

/**
 * This browser's notes on the active network (chain and vault), or on `net`
 * when given: a view passes the network it shows, so what it lists always
 * matches its own label.
 */
export function loadLocalNotes(address?: string | null, net?: NetScope): LocalNote[] {
  if (typeof window === "undefined") return [];
  const scope = net ? scopeOf(net) : activeScope();
  const filtered = getAllNotes().filter((n) => inActiveScope(n, scope));
  if (!address) return filtered;
  const lower = address.toLowerCase();
  return filtered.filter((n) => !n.from || n.from.toLowerCase() === lower);
}

/** Spent/history rows kept for the activity view. Spendable notes are never trimmed. */
const MAX_HISTORY_NOTES = 200;

/**
 * Keep a note in this browser. Settles once it is on disk: await it before
 * sending anything that depends on the note's secret (it rejects with
 * NoteSaveError when the browser refuses the write).
 */
export function saveLocalNote(note: LocalNote): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  const next = [note, ...getAllNotes().filter((n) => n.id !== note.id)];
  // Never drop a note that can still be spent (that would lose the money);
  // only trim spent or chain-only history rows once there are too many.
  let history = 0;
  const kept = next.filter((n) => {
    const spendable =
      n.status !== "recovered" && Boolean(n.secret) && n.secret !== "0x";
    if (spendable) return true;
    // history a restore brought in is kept, and never pushes other history out
    if (n.restoredSpent) return true;
    history++;
    return history <= MAX_HISTORY_NOTES;
  });
  return setAllNotes(kept);
}

/** Settles once the change is on disk; await it where a later read of the store must see it. */
export function updateLocalNote(
  id: string,
  patch: Partial<
    Pick<
      LocalNote,
      | "leafIndex"
      | "txHash"
      | "status"
      | "secured"
      | "sweepPending"
      | "unfunded"
      | "cashOut"
      | "cashOutPlan"
      | "fundsProofAt"
      | "swapProofAt"
      | "proofOutAt"
      | "handoverUntil"
      | "vaultSwap"
      | "refundHeld"
    >
  >
): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  const next = getAllNotes().map((n) => (n.id === id ? { ...n, ...patch } : n));
  return setAllNotes(next);
}

/**
 * Drop a note saved ahead of a send that never went out (the wallet refused it).
 * Only a note still waiting to land and with no transaction is dropped.
 */
export function dropUnsentNote(id: string) {
  if (typeof window === "undefined") return;
  const next = getAllNotes().filter((n) => !(n.id === id && n.sweepPending && !n.txHash));
  setAllNotes(next);
}

/** Clear ghost balances after cash-out / private send when nullifier was spent. */
export function markNoteRecovered(id: string) {
  updateLocalNote(id, { status: "recovered" });
}

/** Merge browser notes with on-chain Shielded events (prefer local secrets). */
export function mergeNotes(
  local: LocalNote[],
  chain: LocalNote[]
): LocalNote[] {
  const byCommit = new Map<string, LocalNote>();

  for (const n of chain) {
    byCommit.set(n.commitment.toLowerCase(), n);
  }
  for (const n of local) {
    const k = n.commitment.toLowerCase();
    const existing = byCommit.get(k);
    if (!existing) {
      byCommit.set(k, { ...n, source: n.source ?? "local" });
      continue;
    }
    byCommit.set(k, {
      ...existing,
      ...n,
      secret: n.secret && n.secret !== "0x" ? n.secret : existing.secret,
      source: "local",
      status: n.status === "recovered" ? "recovered" : existing.status,
      leafIndex: n.leafIndex ?? existing.leafIndex,
      txHash: n.txHash ?? existing.txHash,
    });
  }

  return [...byCommit.values()].sort(
    (a, b) => (b.createdAt || 0) - (a.createdAt || 0)
  );
}

/**
 * Shielded events for a wallet (amounts public on deposit edge). Read through
 * lib/depositScan, which keeps what it read for the tab, so after the first
 * load only the blocks since are read.
 */
export async function fetchChainShieldNotes(
  client: PublicClient,
  from: Address,
  /** The network `client` reads; the active one when left out. */
  net: GloamNetwork = getActiveNetwork()
): Promise<LocalNote[]> {
  const pool = net.pool;
  if (!pool) return [];
  const deployBlock = net.deployBlock ?? SHIELD_DEPLOY_BLOCK;
  try {
    const rows = await scanDeposits(client, { ...net, deployBlock }, from);
    return rows.map((r, i) => ({
      id: `chain-${r.txHash ?? i}-${r.leafIndex ?? i}`,
      chainId: net.chainId,
      pool,
      asset: r.asset,
      amountWei: r.amount,
      commitment: r.commitment,
      // chain-only row, no spend secret (placeholder, not a key)
      secret: "0x" as Hex,
      leafIndex: r.leafIndex ?? undefined,
      txHash: r.txHash ?? undefined,
      from,
      createdAt: Date.now() - i,
      status: "open" as const,
      source: "chain" as const,
    }));
  } catch {
    return [];
  }
}
