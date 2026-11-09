/**
 * Private swaps for apps and agents: quote, build, send, and always get the money
 * back. The planning is the Gloam app's own (swap.ts); this file adds the checks
 * the app's swap tab and the Gloam relay make before a swap goes, the proofs, and
 * what a swap leaves behind to finish it any way it ends.
 *
 * What is private: who swapped. The swap's note leaves the vault through a one-time
 * escrow, the trade runs on a public DEX, and the new note goes back in, all in one
 * transaction the relay sends. The tokens and the amounts are public, like any trade.
 *
 *   quoteSwap        price a swap of one whole note, with every stop that would refuse it
 *   buildSwapIntent  prove it: the swap call, the relay body, and a SwapRecovery
 *   sendSwap         save the SwapRecovery, then send, then read how it ended
 *   readSwapOutcome  swapped, refunded, waiting for its refund or exit, or still open
 *   buildSwapRefund  put money waiting at the escrow back as the refund note
 *   buildSwapExit    take money waiting at the escrow out to an address (routers with an exit)
 *
 * A swap spends one whole note. To swap part of one, split it first with a private
 * send to yourself (buildPrivateSendIntent) and swap the note of the right size.
 *
 * The one rule that keeps money safe: store the SwapRecovery (it holds the secrets of
 * the new note and the refund note) before the swap is sent, and keep it until
 * readSwapOutcome says "swapped", "refunded" or "closed". The note's unshield proof
 * stays valid until the note is spent, so anyone could send it alone; the money then
 * waits at the escrow, and only the refund note (or its exit key) brings it back.
 */
import { encodeFunctionData, keccak256, type Address, type Hex, type PublicClient } from "viem";
import { NATIVE_ASSET, cashOutTargetProblem, networkForChainId, networkName } from "./constants.js";
import { readCashOutFeeBps } from "./fee.js";
import { readDepositLimit, type LiveDepositLimit } from "./limits.js";
import type { PoseidonMerklePath } from "./merkle.js";
import { makeBoundNotePoseidon, noteCommitmentPoseidon, noteNullifierPoseidon } from "./note.js";
import { fieldToHex, hexToField, toField } from "./poseidon.js";
import { fieldToBytes32 } from "./proof.js";
import type { Prover } from "./prove.js";
import type { RelayNetworkStatus } from "./relay.js";
import {
  ETH_USD_FEED,
  FEED_MAX_AGE_SEC,
  IMPACT_STOP_BPS,
  IMPACT_WARN_BPS,
  PEG_STOP_BPS,
  PEG_WARN_BPS,
  QUOTE_TTL_MS,
  SWAP_OFF_PEG,
  SWAP_SEND_MARGIN_SECONDS,
  SWAP_TOO_THIN,
  SwapQuoteRefused,
  UNSHIELDED_EVENT,
  VALUE_STOP_BPS,
  VALUE_WARN_BPS,
  depositRoom,
  encodeRoute,
  escrowAddress,
  ethUsdFeedAbi,
  exitAccount,
  exitDigest,
  hasSwapFloor,
  isKnownRoute,
  isSwapAsset,
  largestFairNote,
  livePools,
  maxSwapInForRefund,
  pegGapBps,
  planVaultSwap,
  quoteFresh,
  receiptPaysEscrow,
  refundAmountFor,
  refundEscrowKey,
  refundFits,
  smallestSwapUsd,
  swapChecked,
  swapDeadlineSeconds,
  swapExpired,
  swapFloorGas,
  swapFloorShown,
  swapGasUnits,
  swapRouterFor,
  valueGapBps,
  vaultSwapAbi,
  vaultSwapV3Abi,
  type EscrowKey,
  type PoolKey,
  type SwapPlan,
  type SwapRouter,
  type VaultRoom,
  type VaultSwapRefundInfo,
} from "./swap.js";
import { buildPoseidonUnshieldWitness, type NoteExport } from "./witness.js";

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

// ---------------------------------------------------------------- refusals

/** Why a swap can't go, the first thing that stops it. */
export type SwapStopCode =
  | "no_swap"
  | "wrong_chain"
  | "wrong_vault"
  | "unknown_router"
  | "router_mismatch"
  | "swap_asset"
  | "same_asset"
  | "bad_amount"
  | "no_route"
  | "too_small"
  | "too_thin"
  | "impact_unknown"
  | "off_peg"
  | "no_fill"
  | "price_moving"
  | "quote_failed"
  | "far_from_market"
  | "limits_unread"
  | "refund_wont_fit"
  | "vault_closed"
  | "over_room"
  | "floor_unread"
  | "swap_small"
  | "relay_off"
  | "gas_high"
  | "bad_note"
  | "note_spent"
  | "unknown_root"
  | "expired"
  | "not_waiting"
  | "no_exit"
  | "bad_recipient"
  | "unshield_tx";

export interface SwapStop {
  code: SwapStopCode;
  message: string;
  /** About the most of the note that would pass, in its base units. */
  fitsIn?: bigint;
  /** The most one swap can spend so its refund note fits the vault's limit. */
  maxIn?: bigint;
  /** The smallest swap the relay sends right now, in dollars (as the app asks it). */
  floorUsd?: number;
}

/** A swap refused before anything was proved or sent. Nothing moved. */
export class SwapRefusedError extends Error {
  readonly code: SwapStopCode;
  readonly fitsIn?: bigint;
  readonly maxIn?: bigint;
  readonly floorUsd?: number;
  constructor(stop: SwapStop) {
    super(stop.message);
    this.name = "SwapRefusedError";
    this.code = stop.code;
    if (stop.fitsIn !== undefined) this.fitsIn = stop.fitsIn;
    if (stop.maxIn !== undefined) this.maxIn = stop.maxIn;
    if (stop.floorUsd !== undefined) this.floorUsd = stop.floorUsd;
  }
}

function refuse(code: SwapStopCode, message: string, extra: Partial<SwapStop> = {}): never {
  throw new SwapRefusedError({ code, message, ...extra });
}

/** Planning errors from swap.ts, by their exact words. */
const PLAN_ERRORS: Record<string, SwapStopCode> = {
  "Private swaps are not live on this network yet.": "no_swap",
  "There is no swap between these two yet.": "no_route",
  "That amount is too small to swap.": "too_small",
  "No pool can fill this swap right now. Try a smaller amount.": "no_fill",
  "The price is moving too fast. Try again in a moment.": "price_moving",
};

function planRefusal(e: unknown): SwapRefusedError {
  if (e instanceof SwapRefusedError) return e;
  if (e instanceof SwapQuoteRefused) {
    if (e.message === SWAP_TOO_THIN) return new SwapRefusedError({ code: "too_thin", message: e.message, ...(e.fitsIn != null ? { fitsIn: e.fitsIn } : {}) });
    if (e.message === SWAP_OFF_PEG) return new SwapRefusedError({ code: "off_peg", message: e.message });
  }
  const msg = e instanceof Error ? e.message : "";
  const code = PLAN_ERRORS[msg];
  // an RPC's own words are no use to a caller; what the planner said is
  return new SwapRefusedError(code ? { code, message: msg } : { code: "quote_failed", message: "Could not get a price right now. Try again." });
}

// ---------------------------------------------------------------- reads

const POOL_SWAP_ABI = [
  { type: "function", name: "isSpent", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "commitmentSeen", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "isKnownRoot", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "bool" }] },
] as const;

const balanceOfAbi = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

/** The network's vault, or a refusal: an unknown chain, or a `pool` that isn't Gloam's vault there. */
function vaultFor(chainId: number, pool?: Address): Address {
  const net = networkForChainId(chainId);
  if (!net) return refuse("no_swap", `Gloam has no vault on chain ${chainId}.`);
  if (pool && !same(pool, net.pool)) return refuse("wrong_vault", `${pool} is not Gloam's vault on ${networkName(chainId)}. Nothing was quoted.`);
  return net.pool;
}

/** Refuses a client that reads another chain: the vault has one address on every chain, so its reads would look right. */
async function assertChain(client: Pick<PublicClient, "getChainId">, chainId: number): Promise<void> {
  if (typeof client.getChainId !== "function") return;
  let actual: number;
  try {
    actual = Number(await client.getChainId());
  } catch {
    return refuse("quote_failed", "Could not read which chain this client is on. Try again.");
  }
  if (actual !== chainId) refuse("wrong_chain", `This client reads chain ${actual}, and the swap is on chain ${chainId}. Point it at chain ${chainId}.`);
}

function decimalsOf(chainId: number, asset: Address, extra?: Record<string, number>): number | null {
  if (same(asset, NATIVE_ASSET)) return 18;
  const given = extra?.[asset.toLowerCase()];
  if (given !== undefined) return given;
  return networkForChainId(chainId)?.assets.find((a) => same(a.address, asset))?.decimals ?? null;
}

const roomOf = (l: LiveDepositLimit): VaultRoom | null => (l.on ? { perDeposit: l.perDeposit, total: l.total, deposited: l.deposited } : null);

// ---------------------------------------------------------------- quote

export interface SwapQuoteParams {
  /** A viem PublicClient on `chainId`. */
  client: PublicClient;
  chainId: number;
  /** Gloam's vault on the chain; anything else is refused. Defaults to it. */
  pool?: Address;
  assetIn: Address;
  assetOut: Address;
  /** The whole note the swap spends, in the input asset's base units. */
  amountIn: bigint;
  /** "relay" (default): also the relay's own stops (its floor, whether it is on). "wallet": you send the swap yourself. */
  via?: "relay" | "wallet";
  /**
   * Market prices in dollars per whole token, by lowercase address (0x000… for ETH).
   * With both sides priced, a swap on Base or Ethereum that gives far less than it is
   * worth is stopped, as the app does (VALUE_STOP_BPS). Without them that is not checked.
   */
  marks?: Record<string, number>;
  /** Decimals for a token the SDK doesn't list, by lowercase address (for marks and the floor). */
  decimals?: Record<string, number>;
  /** The relay's status for this chain (relayStatus()), to stop a swap while it is off or gas is over its ceiling. */
  relayStatus?: RelayNetworkStatus | null;
  /**
   * Where a quote stops, on every chain. The Gloam app holds Base and Ethereum to these and
   * only warns on Robinhood Chain and Tempo, where a person sees the warning before they
   * swap. Code that swaps on its own gets the stop everywhere unless it says otherwise.
   */
  stops?: SwapStops;
  /** Clock in ms, for tests. */
  now?: () => number;
}

/** The most a quote may lose before it is stopped, in basis points (0 to 10,000). */
export interface SwapStops {
  /** Price impact: the full size against a hundredth of it on the same route. Default IMPACT_STOP_BPS (2%). */
  maxImpactBps?: number;
  /** Between two dollar stablecoins: how far below a dollar for a dollar. Default PEG_STOP_BPS (2%). */
  maxPegGapBps?: number;
  /** With `marks`: how much less the swap gives than it is worth at market prices. Default VALUE_STOP_BPS (4%). */
  maxValueGapBps?: number;
}

const stopBps = (v: number | undefined, fallback: number): number => {
  if (v === undefined) return fallback;
  if (!Number.isInteger(v) || v < 0 || v > 10_000) throw new SwapRefusedError({ code: "bad_amount", message: "A stop must be a whole number of basis points from 0 to 10,000." });
  return v;
};

export interface SwapQuote {
  chainId: number;
  pool: Address;
  router: Address;
  routerVersion: 1 | 2 | 3;
  venue: "v4" | "tempo";
  assetIn: Address;
  assetOut: Address;
  amountIn: bigint;
  /** The vault's cash-out fee, read live: it is taken from the note on its way to the router. */
  feeBps: number;
  plan: SwapPlan;
  /** How much less the swap gives than it is worth at `marks`, in basis points. null without marks. */
  valueGapBps: number | null;
  /** The stops this quote was held to. */
  stops: Required<SwapStops>;
  warnings: string[];
  /** The first thing that stops this swap, or null when nothing does. buildSwapIntent refuses a stopped quote. */
  stop: SwapStop | null;
  limits: { maxIn: bigint | null; outRoom: bigint | null };
  /** Where gas is dear: the smallest swap the relay sends now, in dollars, as the app asks it. */
  floorUsd: number | null;
  via: "relay" | "wallet";
  quotedAt: number;
  /** What the chain shows of this swap. */
  public: string;
}

export const SWAP_PUBLIC =
  "A private swap hides who swapped. The tokens and the amounts are public, like any trade on the DEX it goes through.";

async function readFloor(client: PublicClient, chainId: number, feeBps: number, hops: number, nowMs: number) {
  try {
    const [gasPriceWei, round] = await Promise.all([
      client.getGasPrice(),
      client.readContract({ address: ETH_USD_FEED[chainId]!, abi: ethUsdFeedAbi, functionName: "latestRoundData" }),
    ]);
    const age = Math.floor(nowMs / 1000) - Number(round[3]);
    if (round[1] <= 0n || age > FEED_MAX_AGE_SEC) return null;
    const ethUsd = Number(round[1]) / 1e8;
    const oneHop = smallestSwapUsd({ gasPriceWei, ethUsd, feeBps, hops: 1 });
    // the app's margin over the relay's floor, per hop
    return { usd: (swapFloorShown(oneHop) * Number(swapFloorGas(hops, false))) / Number(swapGasUnits(1)), ethUsd };
  } catch {
    return null;
  }
}

/**
 * Prices a private swap of one whole note and applies every stop the Gloam app and
 * relay apply before a swap goes: the quote's own (price impact and peg on Base and
 * Ethereum), value below market when `marks` are given, the refund note fitting the
 * vault's limit, the vault taking the output and having room for it, and with
 * `via: "relay"` the relay's floor and status. Throws SwapRefusedError when there is
 * no price at all; anything else that stops the swap comes back as `stop`.
 */
export async function quoteSwap(p: SwapQuoteParams): Promise<SwapQuote> {
  const { client, chainId } = p;
  const via = p.via ?? "relay";
  const pool = vaultFor(chainId, p.pool);
  const router = swapRouterFor(chainId);
  if (!router) refuse("no_swap", "Private swaps are not live on this network yet.");
  const r = router;
  if (p.amountIn <= 0n) refuse("bad_amount", "The amount must be above zero.");
  if (same(p.assetIn, p.assetOut)) refuse("same_asset", "Pick two different assets.");
  if (!isSwapAsset(chainId, p.assetIn, r.address) || !isSwapAsset(chainId, p.assetOut, r.address)) {
    refuse("swap_asset", "This asset cannot be swapped here.");
  }
  await assertChain(client, chainId);
  const nowMs = (p.now ?? Date.now)();
  const stops: Required<SwapStops> = {
    maxImpactBps: stopBps(p.stops?.maxImpactBps, IMPACT_STOP_BPS),
    maxPegGapBps: stopBps(p.stops?.maxPegGapBps, PEG_STOP_BPS),
    maxValueGapBps: stopBps(p.stops?.maxValueGapBps, VALUE_STOP_BPS),
  };

  let feeBps: number;
  try {
    feeBps = await readCashOutFeeBps(client, pool);
  } catch {
    return refuse("quote_failed", "Could not read the vault's fee. Try again shortly.");
  }
  const [planned, limIn, limOut] = await Promise.all([
    planVaultSwap(client, chainId, { assetIn: p.assetIn, assetOut: p.assetOut, amountIn: p.amountIn, feeBps, router: r.address }).then(
      (plan) => ({ plan }),
      (e: unknown) => ({ error: planRefusal(e) })
    ),
    readDepositLimit(client, pool, p.assetIn).catch(() => null),
    readDepositLimit(client, pool, p.assetOut).catch(() => null),
  ]);
  if ("error" in planned) throw planned.error;
  // Tempo's exchange swaps dollar stablecoins only and its planner names no peg: read it from the plan itself (the 0.1% buffer included)
  const plan = r.venue === "tempo" ? { ...planned.plan, pegBps: pegGapBps(planned.plan.available, planned.plan.amountOut) } : planned.plan;

  const warnings: string[] = [];
  let stop: SwapStop | null = null;
  const halt = (s: SwapStop) => {
    if (!stop) stop = s;
  };
  if (plan.impactBps != null && plan.impactBps >= IMPACT_WARN_BPS) {
    warnings.push(`This size moves the price by about ${(plan.impactBps / 100).toFixed(2)}%. A smaller amount gets a better rate.`);
  }
  if (plan.pegBps != null && plan.pegBps >= PEG_WARN_BPS) {
    warnings.push(`These two trade about ${(plan.pegBps / 100).toFixed(2)}% below a dollar for a dollar right now.`);
  }

  // The impact and peg stops on every chain (the planner already holds Base and Ethereum to theirs).
  if (r.venue === "v4") {
    if (plan.impactBps == null) {
      // a hundredth of the size measured nothing: only a size too small to matter is let through
      if (stops.maxImpactBps < 10_000 && plan.available >= 100n) halt({ code: "impact_unknown", message: "The price impact of this swap could not be measured. Nothing was swapped." });
    } else if (plan.impactBps > stops.maxImpactBps) {
      const fits = await largestFairNote(client, r, plan.route, { assetIn: p.assetIn, assetOut: p.assetOut, amountIn: p.amountIn, feeBps, router: r.address }, plan.available).catch(() => 0n);
      halt({ code: "too_thin", message: SWAP_TOO_THIN, ...(fits > 0n ? { fitsIn: fits } : {}) });
    }
  }
  if (plan.pegBps != null && plan.pegBps > stops.maxPegGapBps) halt({ code: "off_peg", message: SWAP_OFF_PEG });

  // value against market prices, when the caller gave them (the app's own check)
  let valueGap: number | null = null;
  const markIn = p.marks?.[p.assetIn.toLowerCase()];
  const markOut = p.marks?.[p.assetOut.toLowerCase()];
  const decIn = decimalsOf(chainId, p.assetIn, p.decimals);
  const decOut = decimalsOf(chainId, p.assetOut, p.decimals);
  if (markIn && markOut && decIn != null && decOut != null) {
    const payUsd = (Number(p.amountIn) / 10 ** decIn) * markIn;
    const getUsd = (Number(plan.amountOut) / 10 ** decOut) * markOut;
    valueGap = valueGapBps(payUsd, getUsd);
    if (valueGap != null && valueGap >= VALUE_WARN_BPS && !(plan.pegBps != null && plan.pegBps >= PEG_WARN_BPS)) {
      warnings.push(`You get about ${(valueGap / 100).toFixed(2)}% less than this is worth at market prices, fees included.`);
    }
    // the app's line on Base and Ethereum (a gap at the stop is stopped), and the caller's elsewhere
    const valueStop = swapChecked(chainId) ? Math.min(VALUE_STOP_BPS, stops.maxValueGapBps) : stops.maxValueGapBps;
    if (valueGap != null && valueGap >= valueStop && valueStop < 10_000) {
      halt({ code: "far_from_market", message: "Too far from the market price. Nothing was swapped." });
    }
  }

  // The refund note lands in the input asset, so a swap spends at most what it could bring back;
  // a router with an exit sizes it from the fee now, an older one from the most the fee can be.
  const refundFee = r.version === 3 ? feeBps : undefined;
  const roomIn = limIn ? roomOf(limIn) : null;
  const roomOut = limOut ? roomOf(limOut) : null;
  const maxIn = roomIn ? maxSwapInForRefund(roomIn, refundFee) : null;
  const outRoom = roomOut ? depositRoom(roomOut) : null;
  if (!limIn || !limOut) {
    halt({ code: "limits_unread", message: "Could not read the vault's limits. Try again shortly." });
  } else if (roomIn && !refundFits(roomIn, p.amountIn, refundFee)) {
    halt({
      code: "refund_wont_fit",
      message:
        maxIn && maxIn > 0n
          ? "The vault could not take this swap's refund note back. Swap a smaller note, or split this one first."
          : "The vault isn't taking this asset back right now, so a swap from it can't be made safely.",
      maxIn: maxIn ?? 0n,
    });
  } else if (roomOut && roomOut.perDeposit === 0n && roomOut.total === 0n) {
    halt({ code: "vault_closed", message: "The vault doesn't take the asset you would receive yet." });
  } else if (outRoom !== null && plan.amountOut > outRoom) {
    const fitsIn = plan.amountOut > 0n ? (p.amountIn * outRoom * 99n) / (plan.amountOut * 100n) : 0n;
    halt({ code: "over_room", message: "Too large for the vault right now: it takes less of the asset you would receive.", fitsIn });
  }

  let floorUsd: number | null = null;
  if (via === "relay") {
    const status = p.relayStatus;
    if (status && !status.enabled) halt({ code: "relay_off", message: "The Gloam relay is off on this network right now." });
    else if (status?.gasHigh) halt({ code: "gas_high", message: `${networkName(chainId)} gas is over the relay's ceiling right now. Try again shortly.` });
    if (hasSwapFloor(chainId)) {
      const floor = await readFloor(client, chainId, feeBps, plan.route.length || 1, nowMs);
      if (!floor) halt({ code: "floor_unread", message: "Could not read the network fee. Try again shortly." });
      else {
        floorUsd = Number.isFinite(floor.usd) ? floor.usd : null;
        const usd = same(p.assetIn, NATIVE_ASSET) ? (Number(p.amountIn) / 1e18) * floor.ethUsd : Number(p.amountIn) / 10 ** (decIn ?? 18);
        if (usd < floor.usd) {
          halt(
            Number.isFinite(floor.usd)
              ? {
                  code: "swap_small",
                  message: `A swap on ${networkName(chainId)} has to be worth about $${Math.ceil(floor.usd).toLocaleString("en-US")} right now, to cover its gas. Swap a larger note, or wait for gas to fall.`,
                  floorUsd: floor.usd,
                }
              : { code: "swap_small", message: "Swaps are paused here for a short while. Try again in an hour." }
          );
        }
      }
    }
  }

  return {
    chainId,
    pool,
    router: r.address,
    routerVersion: r.version,
    venue: r.venue,
    assetIn: p.assetIn,
    assetOut: p.assetOut,
    amountIn: p.amountIn,
    feeBps,
    plan,
    valueGapBps: valueGap,
    stops,
    warnings,
    stop,
    limits: { maxIn, outRoom },
    floorUsd,
    via,
    quotedAt: nowMs,
    public: SWAP_PUBLIC,
  };
}

// ---------------------------------------------------------------- build

/** What a swap leaves behind to finish it any way it ends. It holds note secrets: store it like a note. */
export interface SwapRecovery {
  kind: "gloam-swap";
  v: 1;
  chainId: number;
  pool: Address;
  router: Address;
  routerVersion: 1 | 2 | 3;
  /** When it was built, in ms, and the chain's block then (where findSwapUnshieldTx starts looking). */
  createdAt: number;
  createdBlock: string;
  /** The note the swap spends: its nullifier, asset and amount (its secret stays yours). */
  spent: { nullifier: Hex; asset: Address; amount: string };
  /** The new note, if the swap lands. */
  out: NoteExport;
  /** The refund note, if the swap's money comes back instead. Its secret also makes the exit key. */
  refund: NoteExport;
  /** The swap's one-time escrow, where its money waits if the note's unshield is sent alone. */
  escrow: Address;
  /** The same as the app keeps on its refund notes (lib/vaultSwap VaultSwapRefundInfo). */
  info: VaultSwapRefundInfo;
}

/** A call for the relay: POST { action, ...body } to /api/relay, or to /api/v1/relay with a partner key. */
export interface SwapRelayCall {
  action: "swap" | "swapExit";
  body: Record<string, unknown> & { chainId: number };
}

/** The same call sent from a wallet of your own. It puts that wallet next to the swap on the explorer. */
export interface SwapWalletCall {
  to: Address;
  data: Hex;
  value: 0n;
}

export interface SwapIntent {
  intent: "private_swap";
  chainId: number;
  agentAddress: Address | null;
  plan: {
    router: Address;
    routerVersion: 1 | 2 | 3;
    assetIn: Address;
    assetOut: Address;
    amountIn: bigint;
    amountOut: bigint;
    route: PoolKey[];
    feeBps: number;
    impactBps: number | null;
    pegBps: number | null;
    valueGapBps: number | null;
    /** Seconds; the swap can't land after it (routers with an exit). */
    deadline: bigint | null;
  };
  privacy: string;
  execution: string;
  relay: SwapRelayCall;
  wallet: SwapWalletCall;
  /** Store this before sending, and keep it until readSwapOutcome says swapped, refunded or closed. */
  recovery: SwapRecovery;
  warnings: string[];
}

export interface SwapIntentParams {
  /** A viem PublicClient on `chainId`. */
  client: PublicClient;
  chainId: number;
  pool?: Address;
  /** The whole note to spend: its secret, value and asset. */
  note: { secretHex: Hex; amountWei: bigint; asset: Address };
  /** The note's membership path (syncTree(...).pathForCommitment(commitment)), read fresh. */
  path: PoseidonMerklePath;
  assetOut: Address;
  /** The quote the user saw. Priced again here, and the better of the two is used, as the app does. */
  quote?: SwapQuote;
  /** Provers for the shield and unshield circuits, with this chain's keys (circuitArtifactUrls(circuit, chainId)). */
  shieldProver: Prover;
  unshieldProver: Prover;
  via?: "relay" | "wallet";
  marks?: Record<string, number>;
  decimals?: Record<string, number>;
  relayStatus?: RelayNetworkStatus | null;
  /** Where the quote stops, on every chain (quoteSwap's `stops`). */
  stops?: SwapStops;
  agentAddress?: Address | null;
  now?: () => number;
}

const toExport = (n: { secret: Hex; commitment: Hex; nullifier: Hex }, amount: bigint, asset: Address): NoteExport => ({
  secret: n.secret,
  commitment: n.commitment,
  nullifier: n.nullifier,
  amountWei: amount.toString(),
  asset,
});

async function proveShield(prover: Prover, note: { secretField: bigint; commitmentField: bigint }, amount: bigint, asset: Address): Promise<Hex> {
  const { proofBytes } = await prover({
    commitment: note.commitmentField.toString(),
    amount: amount.toString(),
    asset: toField(BigInt(asset)).toString(),
    secret: note.secretField.toString(),
  });
  return proofBytes;
}

/**
 * Builds a private swap of one whole note: checks it the way the relay will (a known
 * router, the note unspent and its root known, a route of the router's live pools,
 * every stop quoteSwap applies), makes the refund note and the new note, works out
 * the swap's escrow and checks it against the router's own escrowFor, and proves the
 * note's unshield to that escrow and both shields. Nothing is sent. Throws
 * SwapRefusedError for anything that stops it, before any proof is made.
 */
export async function buildSwapIntent(p: SwapIntentParams): Promise<SwapIntent> {
  const { client, chainId, note } = p;
  const now = p.now ?? Date.now;
  if (note.amountWei <= 0n) refuse("bad_amount", "The note must hold something.");
  // the note itself first: its secret must open the leaf the path is for
  const commitment = await noteCommitmentPoseidon(hexToField(note.secretHex), note.amountWei, note.asset);
  if (commitment !== p.path.leaf) refuse("bad_note", "This secret, amount and asset don't open the leaf this path is for.");
  const nullifier = fieldToHex(await noteNullifierPoseidon(hexToField(note.secretHex), commitment)) as Hex;

  const fresh = await quoteSwap({
    client,
    chainId,
    pool: p.pool,
    assetIn: note.asset,
    assetOut: p.assetOut,
    amountIn: note.amountWei,
    via: p.via,
    marks: p.marks,
    decimals: p.decimals,
    relayStatus: p.relayStatus,
    stops: p.stops,
    now,
  }).catch((e: unknown) => e as Error);

  // The quote the user saw counts only for this exact swap and while it is fresh. The better plan goes.
  const given =
    p.quote &&
    p.quote.chainId === chainId &&
    same(p.quote.assetIn, note.asset) &&
    same(p.quote.assetOut, p.assetOut) &&
    p.quote.amountIn === note.amountWei &&
    quoteFresh(p.quote.quotedAt, now())
      ? p.quote
      : null;
  if (given && !(fresh instanceof Error) && !same(given.router, fresh.router)) {
    refuse("router_mismatch", "This quote was for another swap router. Get a new quote and try again.");
  }
  if (fresh instanceof Error && !(given && fresh instanceof SwapRefusedError && ["quote_failed", "price_moving", "no_fill"].includes(fresh.code))) throw fresh;
  // a fresh quote that failed for a moment keeps the one the user saw; its stops were checked when it was made
  const q: SwapQuote = fresh instanceof Error ? given! : fresh;
  if (q.stop) throw new SwapRefusedError(q.stop);
  const plan = given && given.plan.amountOut > q.plan.amountOut && same(given.router, q.router) ? given.plan : q.plan;

  // the router, the route and the pools, as the relay checks them
  const r: SwapRouter | null = swapRouterFor(chainId, q.router);
  if (!r || !same(r.address, q.router)) return refuse("unknown_router", "That is not a Gloam swap router on this network.");
  if (!isKnownRoute(chainId, note.asset, p.assetOut, plan.route, r.address)) return refuse("no_route", "This swap route is not allowed.");
  if (r.venue === "v4") {
    const live = await livePools(client, r);
    if (!plan.route.every(live)) refuse("no_route", "A pool on this route isn't allowed by the router right now. Get a new quote.");
  }

  // the note unspent, its root known: what the relay reads before its dry run
  const root = fieldToBytes32(p.path.root);
  const [spent, knownRoot] = await Promise.all([
    client.readContract({ address: q.pool, abi: POOL_SWAP_ABI, functionName: "isSpent", args: [nullifier] }),
    client.readContract({ address: q.pool, abi: POOL_SWAP_ABI, functionName: "isKnownRoot", args: [root] }),
  ]).catch(() => refuse("quote_failed", "Could not read the vault. Try again shortly."));
  if (spent) refuse("note_spent", "This note is already spent.");
  if (!knownRoot) refuse("unknown_root", "This path's root isn't one the vault knows. Sync the tree again and rebuild the path.");

  // the refund note, sized for the router; then the new note for exactly the planned amount
  const withExit = r.version === 3;
  const refundAmount = refundAmountFor(note.amountWei, withExit ? q.feeBps : undefined);
  const [back, out] = await Promise.all([makeBoundNotePoseidon(refundAmount, note.asset), makeBoundNotePoseidon(plan.amountOut, p.assetOut)]);

  // the exit key, from the refund note's own secret, and a deadline from the chain's clock
  const block = await client.getBlock();
  const exitKey = withExit ? exitAccount(back.secret).address : undefined;
  const deadline = withExit ? block.timestamp + BigInt(swapDeadlineSeconds(chainId)) : undefined;
  const routeBytes = encodeRoute(plan.route);
  const key: EscrowKey = {
    nullifier,
    amountIn: note.amountWei,
    outCommitment: out.commitment,
    assetOut: p.assetOut,
    amountOut: plan.amountOut,
    refundCommitment: back.commitment,
    refundAmount,
    routeHash: keccak256(routeBytes),
    ...(exitKey ? { exitKey, deadline } : {}),
  };
  const escrow = escrowAddress(r.address, note.asset, key);
  // the router's own answer, so a wrong RPC can't send the note anywhere else
  const routerSays = exitKey
    ? await client.readContract({ address: r.address, abi: vaultSwapV3Abi, functionName: "escrowFor", args: [note.asset, { ...key, exitKey, deadline: deadline! }] })
    : await client.readContract({ address: r.address, abi: vaultSwapAbi, functionName: "escrowFor", args: [note.asset, key] });
  if (!same(routerSays, escrow)) refuse("router_mismatch", "This swap's escrow didn't check out against the router. Nothing was proved.");

  const w = await buildPoseidonUnshieldWitness({ secretHex: note.secretHex, amount: note.amountWei, asset: note.asset, to: escrow, path: p.path });
  if (!w.checks.commitmentMatches) refuse("bad_note", w.blocker ?? "This note does not match the vault.");
  const [{ proofBytes: unshieldProof }, outProof, backProof] = await Promise.all([
    p.unshieldProver(w.circomInput),
    proveShield(p.shieldProver, out, plan.amountOut, p.assetOut),
    proveShield(p.shieldProver, back, refundAmount, note.asset),
  ]);

  const spend = { proof: unshieldProof, root, nullifier, asset: note.asset, amount: note.amountWei };
  const deposit = { proof: outProof, commitment: out.commitment, asset: p.assetOut, amount: plan.amountOut };
  const refundDep = { proof: backProof, commitment: back.commitment, asset: note.asset, amount: refundAmount };
  const data = withExit
    ? encodeFunctionData({ abi: vaultSwapV3Abi, functionName: "swap", args: [spend, deposit, refundDep, routeBytes, exitKey!, deadline!] })
    : encodeFunctionData({ abi: vaultSwapAbi, functionName: "swap", args: [spend, deposit, refundDep, routeBytes] });

  const info: VaultSwapRefundInfo = {
    router: r.address,
    assetIn: note.asset,
    amountIn: note.amountWei.toString(),
    out: { commitment: out.commitment, asset: p.assetOut, amount: plan.amountOut.toString() },
    route: plan.route,
    ...(exitKey ? { exitKey, deadline: deadline!.toString() } : {}),
  };
  const recovery: SwapRecovery = {
    kind: "gloam-swap",
    v: 1,
    chainId,
    pool: q.pool,
    router: r.address,
    routerVersion: r.version,
    createdAt: now(),
    createdBlock: block.number!.toString(),
    spent: { nullifier, asset: note.asset, amount: note.amountWei.toString() },
    out: toExport(out, plan.amountOut, p.assetOut),
    refund: toExport(back, refundAmount, note.asset),
    escrow,
    info,
  };
  const net = networkName(chainId);
  return {
    intent: "private_swap",
    chainId,
    agentAddress: p.agentAddress ?? null,
    plan: {
      router: r.address,
      routerVersion: r.version,
      assetIn: note.asset,
      assetOut: p.assetOut,
      amountIn: note.amountWei,
      amountOut: plan.amountOut,
      route: plan.route,
      feeBps: q.feeBps,
      impactBps: plan.impactBps ?? null,
      pegBps: plan.pegBps ?? null,
      valueGapBps: q.valueGapBps,
      deadline: deadline ?? null,
    },
    privacy: SWAP_PUBLIC,
    execution: `Unsigned. Store recovery first, then send relay (POST { action, ...body } to the Gloam relay) on ${net}${
      deadline ? ` before ${new Date(Number(deadline) * 1000).toISOString()}` : ""
    }. Sending wallet instead puts that wallet next to the swap on the explorer.`,
    relay: {
      action: "swap",
      body: { chainId, router: r.address, spend, deposit, refund: refundDep, route: plan.route, ...(exitKey ? { exitKey, deadline } : {}) },
    },
    wallet: { to: r.address, data, value: 0n },
    recovery,
    warnings: q.warnings,
  };
}

/** Refuses to send a swap that can't land in time: the relay wants SWAP_SEND_MARGIN_SECONDS left. */
export function assertSwapSendable(call: SwapRelayCall, nowMs: number = Date.now()): void {
  if (call.action !== "swap") return;
  const d = call.body.deadline;
  if (d === undefined || d === null) return;
  // a refund carries its swap's deadline too, and never expires: only a swap whose note is unspent does
  if (call.body.unshieldTx) return;
  if (swapExpired(BigInt(d as bigint | string), BigInt(Math.floor(nowMs / 1000) + SWAP_SEND_MARGIN_SECONDS))) {
    refuse("expired", "This swap's time ran out. Get a new quote and build it again.");
  }
}

// ---------------------------------------------------------------- send

export interface SendSwapParams {
  intent: SwapIntent;
  /** Persists the recovery record. Must resolve before anything is sent; called again with the send's hash. */
  save: (recovery: SwapRecovery) => Promise<void> | void;
  /** Sends the call: relaySwapCall (the hosted relay), GloamApiClient.relaySwap, or your own. Returns the hash. */
  submit: (call: SwapRelayCall) => Promise<Hex>;
  /** Reads the receipt and the outcome. */
  client: PublicClient;
  /** Wait for the receipt (default true). */
  wait?: boolean;
}

export interface SendSwapResult {
  hash: Hex;
  status: "success" | "reverted" | "unknown";
  outcome: SwapOutcome | null;
  recovery: SwapRecovery;
}

/**
 * Saves the recovery record, then sends the swap, then follows it to the chain.
 * Nothing is sent unless `save` resolved. Whatever happens after the send, the
 * recovery record stays the way back: read the outcome again later with readSwapOutcome.
 */
export async function sendSwap(p: SendSwapParams): Promise<SendSwapResult> {
  assertSwapSendable(p.intent.relay);
  const recovery = p.intent.recovery;
  await p.save(recovery);
  const hash = await p.submit(p.intent.relay);
  recovery.info.sent = { hash, at: Date.now() };
  // the swap is out; a failed save of its hash stops nothing (the recovery saved above is complete)
  await Promise.resolve(p.save(recovery)).catch(() => {});
  if (p.wait === false) return { hash, status: "unknown", outcome: null, recovery };
  let status: SendSwapResult["status"] = "unknown";
  try {
    status = (await p.client.waitForTransactionReceipt({ hash })).status;
  } catch {
    // a slow network: it may still land, and readSwapOutcome says later
  }
  const outcome = await readSwapOutcome(p.client, recovery).catch(() => null);
  return { hash, status, outcome, recovery };
}

// ---------------------------------------------------------------- outcome

export type SwapOutcome =
  /** The new note landed: recovery.out is yours to spend. */
  | { state: "swapped"; note: NoteExport }
  /** The money came back as the refund note: recovery.refund is yours to spend. */
  | { state: "refunded"; note: NoteExport }
  /** The note's unshield went alone and the money waits at the escrow: buildSwapRefund. */
  | { state: "refund_ready"; held: bigint }
  /** The money waits at the escrow, but the refund note can't take it (the vault's fee rose): buildSwapExit. */
  | { state: "exit_ready"; held: bigint }
  /** The note is unspent and the swap may still land (and its unshield may still go alone). */
  | { state: "pending"; deadline: bigint | null }
  /** The swap reverted, or its deadline passed: it can't land, but its unshield proof stays valid. Move the note. */
  | { state: "reverted" | "expired" }
  /** The note was spent, nothing landed, and nothing waits: it left by its exit, or was spent another way. */
  | { state: "closed" };

/**
 * How a swap ended, read from the chain at one block: whether the note is spent,
 * whether either new note is in the vault, and what waits at the escrow. "reverted"
 * and "expired" mean the swap itself can't land, while its unshield proof (public
 * once sent) can still go alone: move the note to a fresh one (a private send to
 * yourself) so that proof is void, and keep the recovery record until then.
 */
export async function readSwapOutcome(client: PublicClient, rec: SwapRecovery): Promise<SwapOutcome> {
  const blockNumber = await client.getBlockNumber({ cacheTime: 0 });
  const at = { blockNumber };
  const seen = (c: Hex) => client.readContract({ address: rec.pool, abi: POOL_SWAP_ABI, functionName: "commitmentSeen", args: [c], ...at });
  const [spent, outSeen, refundSeen] = await Promise.all([
    client.readContract({ address: rec.pool, abi: POOL_SWAP_ABI, functionName: "isSpent", args: [rec.spent.nullifier], ...at }),
    seen(rec.out.commitment),
    seen(rec.refund.commitment),
  ]);
  if (outSeen) return { state: "swapped", note: rec.out };
  if (refundSeen) return { state: "refunded", note: rec.refund };
  if (spent) {
    const held = same(rec.info.assetIn, NATIVE_ASSET)
      ? await client.getBalance({ address: rec.escrow, ...at })
      : await client.readContract({ address: rec.info.assetIn, abi: balanceOfAbi, functionName: "balanceOf", args: [rec.escrow], ...at });
    if (held >= BigInt(rec.refund.amountWei)) return { state: "refund_ready", held };
    // at least what the vault's highest fee leaves: a stray transfer to an escrow is never read as a swap's money
    if (held > 0n && held >= refundAmountFor(BigInt(rec.info.amountIn))) return { state: "exit_ready", held };
    return { state: "closed" };
  }
  if (rec.info.sent?.hash) {
    const receipt = await client.getTransactionReceipt({ hash: rec.info.sent.hash }).catch(() => null);
    if (receipt?.status === "reverted") return { state: "reverted" };
  }
  const deadline = rec.info.deadline ? BigInt(rec.info.deadline) : null;
  if (deadline !== null) {
    const block = await client.getBlock({ blockNumber });
    if (swapExpired(deadline, block.timestamp)) return { state: "expired" };
  }
  return { state: "pending", deadline };
}

/**
 * The transaction that paid the swap's escrow (the note's unshield sent alone), or
 * null when none shows. A refund or an exit names it to the relay. Looks from the
 * block the swap was built at, in `chunk`-block steps.
 */
export async function findSwapUnshieldTx(
  client: PublicClient,
  rec: SwapRecovery,
  opts: { fromBlock?: bigint; toBlock?: bigint; chunk?: bigint } = {}
): Promise<Hex | null> {
  if (rec.info.unshieldTx) return rec.info.unshieldTx;
  const head = opts.toBlock ?? (await client.getBlockNumber({ cacheTime: 0 }));
  const chunk = opts.chunk ?? 10_000n;
  let from = opts.fromBlock ?? BigInt(rec.createdBlock);
  while (from <= head) {
    const to = from + chunk - 1n > head ? head : from + chunk - 1n;
    const logs = await client.getLogs({
      address: rec.pool,
      event: UNSHIELDED_EVENT,
      args: { nullifier: rec.spent.nullifier, asset: rec.info.assetIn, to: rec.escrow },
      fromBlock: from,
      toBlock: to,
    });
    const hit = logs.find((l) => l.transactionHash);
    if (hit?.transactionHash) {
      rec.info.unshieldTx = hit.transactionHash;
      return hit.transactionHash;
    }
    from = to + 1n;
  }
  return null;
}

async function paidEscrowTx(client: PublicClient, rec: SwapRecovery, unshieldTx?: Hex): Promise<Hex> {
  const hash = unshieldTx ?? (await findSwapUnshieldTx(client, rec).catch(() => null));
  if (!hash) return refuse("unshield_tx", "The vault's payment to this swap's escrow can't be found yet. Try again in a minute.");
  const receipt = await client.getTransactionReceipt({ hash }).catch(() => null);
  const paid = { nullifier: rec.spent.nullifier, asset: rec.info.assetIn, escrow: rec.escrow, amount: BigInt(rec.info.amountIn) };
  if (!receipt || receipt.status !== "success" || !receiptPaysEscrow(receipt.logs, rec.pool, paid)) {
    refuse("unshield_tx", "That transaction is not the vault paying this swap's escrow.");
  }
  rec.info.unshieldTx = hash;
  return hash;
}

function knownRouter(rec: SwapRecovery): SwapRouter {
  const r = swapRouterFor(rec.chainId, rec.router);
  if (!r || !same(r.address, rec.router)) return refuse("unknown_router", "That is not a Gloam swap router on this network.");
  vaultFor(rec.chainId, rec.pool);
  // the recovery must still name its own escrow: nothing in it was changed
  const key = refundEscrowKey(rec.info, rec.spent.nullifier, rec.refund.commitment, BigInt(rec.refund.amountWei));
  if (!same(escrowAddress(rec.router, rec.info.assetIn, key), rec.escrow)) refuse("bad_note", "This recovery record doesn't add up to its escrow.");
  return r;
}

/** Proof bytes and a root the router never reads on the refund path (64 zero bytes, a zero root), as the app sends them. */
const UNUSED_PROOF = `0x${"00".repeat(64)}` as Hex;
const UNUSED_ROOT = `0x${"00".repeat(32)}` as Hex;

export interface SwapRefundCall {
  relay: SwapRelayCall;
  wallet: SwapWalletCall;
}

/**
 * Puts money waiting at a swap's escrow back into the vault as its refund note:
 * the same swap call, which the router turns into the refund once the note is
 * spent. Proves the refund note's shield again from its secret. Refused unless the
 * money is waiting (readSwapOutcome "refund_ready") and the vault has room for it.
 */
export async function buildSwapRefund(
  rec: SwapRecovery,
  p: { client: PublicClient; shieldProver: Prover; unshieldTx?: Hex }
): Promise<SwapRefundCall> {
  const r = knownRouter(rec);
  await assertChain(p.client, rec.chainId);
  const outcome = await readSwapOutcome(p.client, rec);
  if (outcome.state !== "refund_ready") {
    refuse(outcome.state === "exit_ready" ? "refund_wont_fit" : "not_waiting", outcome.state === "exit_ready" ? "The refund note can't take this money back: the vault's fee rose. Use buildSwapExit." : `Nothing waits for a refund: the swap is ${outcome.state}.`);
  }
  const amount = BigInt(rec.refund.amountWei);
  const limit = await readDepositLimit(p.client, rec.pool, rec.info.assetIn).catch(() => null);
  if (limit?.on && (amount > limit.perDeposit || limit.deposited + amount > limit.total)) {
    refuse("refund_wont_fit", r.version === 3 ? "The vault has no room for this refund right now. It can wait, or leave by its exit (buildSwapExit)." : "The vault has no room for this refund right now. It lands once the vault has room.");
  }
  const unshieldTx = await paidEscrowTx(p.client, rec, p.unshieldTx);
  const secret = hexToField(rec.refund.secret);
  const { proofBytes } = await p.shieldProver({
    commitment: BigInt(rec.refund.commitment).toString(),
    amount: rec.refund.amountWei,
    asset: toField(BigInt(rec.refund.asset)).toString(),
    secret: secret.toString(),
  });
  const spend = { proof: UNUSED_PROOF, root: UNUSED_ROOT, nullifier: rec.spent.nullifier, asset: rec.info.assetIn, amount: BigInt(rec.info.amountIn) };
  const deposit = { proof: UNUSED_PROOF, commitment: rec.info.out.commitment, asset: rec.info.out.asset, amount: BigInt(rec.info.out.amount) };
  const refund = { proof: proofBytes, commitment: rec.refund.commitment, asset: rec.refund.asset, amount };
  const routeBytes = encodeRoute(rec.info.route);
  const exitKey = rec.info.exitKey;
  const deadline = exitKey ? BigInt(rec.info.deadline ?? "0") : undefined;
  const data = exitKey
    ? encodeFunctionData({ abi: vaultSwapV3Abi, functionName: "swap", args: [spend, deposit, refund, routeBytes, exitKey, deadline!] })
    : encodeFunctionData({ abi: vaultSwapAbi, functionName: "swap", args: [spend, deposit, refund, routeBytes] });
  return {
    relay: {
      action: "swap",
      body: { chainId: rec.chainId, router: rec.router, spend, deposit, refund, route: rec.info.route, unshieldTx, ...(exitKey ? { exitKey, deadline } : {}) },
    },
    wallet: { to: rec.router, data, value: 0n },
  };
}

/**
 * Takes money waiting at a swap's escrow out to `to`, in the clear, when its refund
 * can't land (routers with an exit only). The swap's exit key (from the refund
 * note's secret) signs for `to`, so whoever sends it can only pay `to`. `to` is
 * public, and it gets the whole escrow.
 */
export async function buildSwapExit(rec: SwapRecovery, p: { client: PublicClient; to: Address; unshieldTx?: Hex }): Promise<SwapRefundCall> {
  const r = knownRouter(rec);
  if (r.version !== 3 || !rec.info.exitKey) refuse("no_exit", "A swap through this router has no exit. Its refund lands once the vault has room.");
  const problem = cashOutTargetProblem(p.to, { chainId: rec.chainId, pool: rec.pool, routers: [rec.router] });
  if (problem) refuse("bad_recipient", problem);
  // the router refuses these too (BadExit): the money would stop there for good
  if (same(p.to, rec.escrow) || same(p.to, rec.info.assetIn)) refuse("bad_recipient", "An exit can't go to the swap's escrow or the token's own contract. Pick a wallet address.");
  await assertChain(p.client, rec.chainId);
  const outcome = await readSwapOutcome(p.client, rec);
  if (outcome.state !== "exit_ready" && outcome.state !== "refund_ready") refuse("not_waiting", `Nothing waits at this swap's escrow: the swap is ${outcome.state}.`);
  const account = exitAccount(rec.refund.secret);
  if (!same(account.address, rec.info.exitKey!)) refuse("bad_note", "This refund note doesn't hold this swap's exit key.");
  const unshieldTx = await paidEscrowTx(p.client, rec, p.unshieldTx);
  const signature = await account.sign({ hash: exitDigest(rec.chainId, rec.router, rec.escrow, p.to) });
  const key = {
    ...refundEscrowKey(rec.info, rec.spent.nullifier, rec.refund.commitment, BigInt(rec.refund.amountWei)),
    exitKey: rec.info.exitKey!,
    deadline: BigInt(rec.info.deadline ?? "0"),
  } as Required<EscrowKey>;
  const data = encodeFunctionData({ abi: vaultSwapV3Abi, functionName: "exit", args: [rec.info.assetIn, key, p.to, signature] });
  return {
    relay: { action: "swapExit", body: { chainId: rec.chainId, router: rec.router, asset: rec.info.assetIn, key, to: p.to, signature, unshieldTx } },
    wallet: { to: rec.router, data, value: 0n },
  };
}

/** The quote and the recovery as plain JSON (bigints as decimal strings), for storage or an API answer. */
export function swapJson<T>(value: T): unknown {
  return JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
}

/** A recovery record read back from storage, checked for shape. Throws on anything that isn't one. */
export function parseSwapRecovery(raw: unknown): SwapRecovery {
  const r = (typeof raw === "string" ? JSON.parse(raw) : raw) as SwapRecovery;
  const hex = (v: unknown, len?: number) => typeof v === "string" && /^0x[0-9a-fA-F]+$/.test(v) && (len === undefined || v.length === 2 + len * 2);
  const note = (n: NoteExport | undefined) => n && hex(n.secret) && hex(n.commitment, 32) && hex(n.nullifier) && /^\d+$/.test(n.amountWei) && hex(n.asset, 20);
  if (
    !r ||
    r.kind !== "gloam-swap" ||
    r.v !== 1 ||
    !Number.isInteger(r.chainId) ||
    !hex(r.pool, 20) ||
    !hex(r.router, 20) ||
    !hex(r.escrow, 20) ||
    !hex(r.spent?.nullifier, 32) ||
    !note(r.out) ||
    !note(r.refund) ||
    !r.info ||
    !Array.isArray(r.info.route)
  ) {
    throw new Error("That is not a Gloam swap recovery record.");
  }
  return r;
}
