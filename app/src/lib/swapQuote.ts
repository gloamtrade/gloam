/**
 * A private swap quote on the server, for the partner API (POST /api/v1/swaps/quote)
 * and the hosted MCP (gloam_swap_quote). Read only: nothing is proved, built or sent.
 *
 * The price is the app's own (lib/vaultSwap planVaultSwap, with the vault's fee read
 * live), and on top of it the stops the swap tab applies before it lets a swap go
 * (components/app/VaultSwapView): the refund note must fit the vault's limit on the
 * input asset, the vault must take the output and have room for it, the relay must be
 * on and under its gas ceiling, and where gas is dear the swap must clear the relay's
 * floor (lib/relay/swapFloor). A quote that passes them all is one the relay takes,
 * as far as anything can be known before the proofs are made.
 *
 * Not checked here: how the swap compares with market prices (VALUE_STOP_BPS). Those
 * marks are off chain and the swap tab alone reads them; the answer says so.
 *
 * Server only.
 */
import { getAddress, isAddress, type Address, type PublicClient } from "viem";
import { NETWORK_KEYS, getNetwork, type GloamNetwork, type NetworkKey } from "./networks";
import { knownTokens } from "./tokens";
import {
  IMPACT_STOP_BPS,
  IMPACT_WARN_BPS,
  PEG_STOP_BPS,
  PEG_WARN_BPS,
  QUOTE_TTL_MS,
  SWAP_OFF_PEG,
  SWAP_TOO_THIN,
  SwapQuoteRefused,
  depositRoom,
  isSwapAsset,
  maxSwapInForRefund,
  pegGapBps,
  planVaultSwap,
  refundFits,
  swapDeadlineSeconds,
  swapRouterFor,
  swapRoutersOn,
  type PoolKey,
  type SwapPlan,
  type VaultRoom,
} from "./vaultSwap";
import {
  ETH_USD_FEED,
  FEED_MAX_AGE_SEC,
  ethUsdFeedAbi,
  hasSwapFloor,
  smallestSwapUsd,
  swapFloorGas,
  swapFloorMessage,
  swapFloorShown,
  swapGasUnits,
} from "./relay/swapFloor";
import { SWAPS_PAUSED_MESSAGE, relayPublicClient, relayStatus } from "./relay/server";

/** A refused request: bad input, or no swaps on the network. Nothing was quoted. */
export class SwapQuoteError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string
  ) {
    super(message);
  }
}

/** Why a priced swap can't go, the first thing that stops it, in the swap tab's order. */
export type SwapStop = {
  code:
    | "no_route"
    | "too_small"
    | "too_thin"
    | "impact_unknown"
    | "off_peg"
    | "no_fill"
    | "price_moving"
    | "quote_failed"
    | "limits_unread"
    | "refund_wont_fit"
    | "vault_closed"
    | "over_room"
    | "relay_off"
    | "gas_high"
    | "floor_unread"
    | "swap_small";
  message: string;
  /** About the most of the note that would pass, in its base units. */
  fitsIn?: string;
  /** The most one swap can spend so its refund note fits the vault's limit. */
  maxIn?: string;
  /** The smallest swap the relay sends right now, in dollars. */
  floorUsd?: number;
};

export type SwapQuoteAsk = {
  assetIn: unknown;
  assetOut: unknown;
  /** The note's value to spend, in the input asset's base units, as a decimal string. */
  amountIn: unknown;
  /** "relay" (default): the relay's own stops apply too. "wallet": a swap the caller sends itself. */
  via?: unknown;
  /** The most price impact to accept, in basis points, on every chain. Default IMPACT_STOP_BPS, as the SDK's quoteSwap. */
  maxImpactBps?: unknown;
};

/** Swap quotes per minute, per IP and per partner account: each one is a few dozen chain reads. */
export const SWAP_QUOTE_PER_MINUTE = 20;

export type SwapQuote = {
  network: string;
  chainId: number;
  router: Address;
  routerVersion: 1 | 2 | 3;
  venue: "v4" | "tempo";
  assetIn: Address;
  assetOut: Address;
  amountIn: string;
  /** The vault's cash-out fee, read live, in basis points. */
  feeBps: number;
  /** What reaches the router: the note less the vault's fee. Null when no price. */
  available: string | null;
  /** What the new note will hold. Null when no price. */
  amountOut: string | null;
  cost: string | null;
  leftover: string | null;
  route: PoolKey[];
  hops: number;
  impactBps: number | null;
  pegBps: number | null;
  warnings: string[];
  stop: SwapStop | null;
  limits: { maxIn: string | null; outRoom: string | null };
  relay: { enabled: boolean; gasHigh: boolean } | null;
  floorUsd: number | null;
  /** The stops this quote was held to, in basis points, on every chain. */
  stops: { maxImpactBps: number; maxPegGapBps: number };
  valueChecked: false;
  valueNote: string;
  deadlineSeconds: number;
  quotedAt: number;
  ttlMs: number;
  public: string;
};

/** What a quote reads, injectable for tests. */
export type SwapQuoteDeps = {
  client?: PublicClient;
  /** The relay's state on this network, or null when it can't be read. */
  relay?: (net: GloamNetwork) => Promise<{ enabled: boolean; gasHigh: boolean } | null>;
  now?: () => number;
};

export const SWAP_PUBLIC_LINE =
  "A private swap hides who swapped. The tokens and the amounts are public, like any trade on the DEX it goes through.";

const VALUE_NOTE =
  "Not compared with market prices here: those marks are off chain. The Gloam app's swap tab also stops a swap that gives far less than the market price.";

const MAX_UINT128 = (1n << 128n) - 1n;

const vaultReadAbi = [
  { type: "function", name: "withdrawFeeBps", stateMutability: "view", inputs: [], outputs: [{ type: "uint16" }] },
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
  { type: "function", name: "deposited", stateMutability: "view", inputs: [{ name: "asset", type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

/** Planning errors from lib/vaultSwap, by their exact words. Anything else (an RPC's own) is quote_failed. */
const PLAN_ERRORS: Record<string, SwapStop["code"]> = {
  "There is no swap between these two yet.": "no_route",
  "That amount is too small to swap.": "too_small",
  "No pool can fill this swap right now. Try a smaller amount.": "no_fill",
  "The price is moving too fast. Try again in a moment.": "price_moving",
};

function asAsset(v: unknown, field: string): Address {
  if (typeof v !== "string" || !isAddress(v.trim(), { strict: false })) {
    throw new SwapQuoteError(400, "bad_request", `${field} must be a token address (0x0000000000000000000000000000000000000000 for ETH).`);
  }
  return getAddress(v.trim());
}

/** A whole number of base units, above 0 and within what the quoter takes (uint128). */
export function parseBaseUnits(v: unknown): bigint {
  const s = typeof v === "number" && Number.isSafeInteger(v) ? String(v) : typeof v === "string" ? v.trim() : "";
  if (!/^\d{1,39}$/.test(s)) throw new SwapQuoteError(400, "bad_request", "amountIn must be a whole number of base units, as a string.");
  const n = BigInt(s);
  if (n <= 0n) throw new SwapQuoteError(400, "bad_request", "amountIn must be above 0.");
  if (n > MAX_UINT128) throw new SwapQuoteError(400, "bad_request", "amountIn is larger than any swap can be.");
  return n;
}

async function defaultRelay(net: GloamNetwork): Promise<{ enabled: boolean; gasHigh: boolean } | null> {
  const status = await Promise.race([
    relayStatus(),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 6_000)),
  ]).catch(() => null);
  const mine = status?.find((s) => s.chainId === net.chainId);
  return mine ? { enabled: mine.enabled, gasHigh: mine.gasHigh } : null;
}

/** A note's worth in dollars the way the relay counts it: ETH by the feed, any token at face value. */
function noteUsd(chainId: number, asset: Address, amount: bigint, ethUsd: number): number {
  if (BigInt(asset) === 0n) return (Number(amount) / 1e18) * ethUsd;
  const t = knownTokens(chainId).find((k) => k.address.toLowerCase() === asset.toLowerCase());
  return Number(amount) / 10 ** (t?.decimals ?? 18);
}

/** The relay's floor for this swap, as the swap tab shows it (a little above the relay's, per hop). Null when unread. */
async function floorFor(client: PublicClient, chainId: number, feeBps: number, hops: number, nowMs: number): Promise<{ usd: number; ethUsd: number } | null> {
  try {
    const [gasPriceWei, round] = await Promise.all([
      client.getGasPrice(),
      client.readContract({ address: ETH_USD_FEED[chainId]!, abi: ethUsdFeedAbi, functionName: "latestRoundData" }),
    ]);
    const age = Math.floor(nowMs / 1000) - Number(round[3]);
    if (round[1] <= 0n || age > FEED_MAX_AGE_SEC) return null;
    const ethUsd = Number(round[1]) / 1e8;
    const oneHop = smallestSwapUsd({ gasPriceWei, ethUsd, feeBps, hops: 1 });
    const usd = (swapFloorShown(oneHop) * Number(swapFloorGas(hops, false))) / Number(swapGasUnits(1));
    return { usd, ethUsd };
  } catch {
    return null;
  }
}

const str = (v: bigint | null | undefined) => (v == null ? null : v.toString());

/**
 * Quotes a private swap of a note worth `amountIn` of `assetIn` into `assetOut` on `net`.
 * Throws SwapQuoteError for bad input or a network with no swaps; everything about the
 * market or the vault that stops a swap comes back as `stop`.
 */
export async function quoteSwapServer(net: GloamNetwork, ask: SwapQuoteAsk, deps: SwapQuoteDeps = {}): Promise<SwapQuote> {
  const router = swapRouterFor(net.chainId);
  if (!router || !net.pool) throw new SwapQuoteError(400, "no_swap", "Private swaps are not live on this network yet.");
  const assetIn = asAsset(ask.assetIn, "assetIn");
  const assetOut = asAsset(ask.assetOut, "assetOut");
  const amountIn = parseBaseUnits(ask.amountIn);
  const via = ask.via == null ? "relay" : ask.via;
  if (via !== "relay" && via !== "wallet") throw new SwapQuoteError(400, "bad_request", 'via must be "relay" or "wallet".');
  if (assetIn === assetOut) throw new SwapQuoteError(400, "same_asset", "Pick two different assets.");
  const maxImpactBps = ask.maxImpactBps == null ? IMPACT_STOP_BPS : Number(ask.maxImpactBps);
  if (!Number.isInteger(maxImpactBps) || maxImpactBps < 0 || maxImpactBps > 10_000) {
    throw new SwapQuoteError(400, "bad_request", "maxImpactBps must be a whole number of basis points from 0 to 10000.");
  }
  if (!isSwapAsset(net.chainId, assetIn, router.address) || !isSwapAsset(net.chainId, assetOut, router.address)) {
    throw new SwapQuoteError(400, "swap_asset", "This asset cannot be swapped here.");
  }

  const client = deps.client ?? relayPublicClient(net);
  const pool = net.pool;
  const nowMs = (deps.now ?? Date.now)();
  let feeBps: number;
  try {
    feeBps = Number(await client.readContract({ address: pool, abi: vaultReadAbi, functionName: "withdrawFeeBps" }));
  } catch {
    throw new SwapQuoteError(503, "check_failed", "Could not read the vault's fee. Try again shortly.");
  }

  // the price, and the vault's limits on both sides, read together
  const room = async (asset: Address): Promise<VaultRoom | null> => {
    try {
      const [limit, deposited] = await Promise.all([
        client.readContract({ address: pool, abi: vaultReadAbi, functionName: "depositLimit", args: [asset] }),
        client.readContract({ address: pool, abi: vaultReadAbi, functionName: "deposited", args: [asset] }),
      ]);
      return { perDeposit: limit[0], total: limit[1], deposited };
    } catch {
      return null;
    }
  };
  let plan: SwapPlan | null = null;
  let stop: SwapStop | null = null;
  const [planned, roomIn, roomOut] = await Promise.all([
    planVaultSwap(client, net.chainId, { assetIn, assetOut, amountIn, feeBps, router: router.address }).then(
      (p) => ({ ok: true as const, p }),
      (e: unknown) => ({ ok: false as const, e })
    ),
    room(assetIn),
    room(assetOut),
  ]);
  if (planned.ok) {
    // Tempo's exchange swaps dollar stablecoins only and names no peg: read it from the plan (the 0.1% buffer included)
    plan = router.venue === "tempo" ? { ...planned.p, pegBps: pegGapBps(planned.p.available, planned.p.amountOut) } : planned.p;
    // The impact and peg stops on every chain, as the SDK applies them by default (the app's planner holds Base and Ethereum to them).
    if (router.venue === "v4" && plan.impactBps != null && plan.impactBps > maxImpactBps) {
      stop = { code: "too_thin", message: SWAP_TOO_THIN };
    } else if (router.venue === "v4" && plan.impactBps == null && maxImpactBps < 10_000 && plan.available >= 100n) {
      stop = { code: "impact_unknown", message: "The price impact of this swap could not be measured." };
    } else if (plan.pegBps != null && plan.pegBps > PEG_STOP_BPS) {
      stop = { code: "off_peg", message: SWAP_OFF_PEG };
    }
  } else {
    const e = planned.e;
    if (e instanceof SwapQuoteRefused) {
      stop =
        e.message === SWAP_TOO_THIN
          ? { code: "too_thin", message: e.message, ...(e.fitsIn != null ? { fitsIn: e.fitsIn.toString() } : {}) }
          : e.message === SWAP_OFF_PEG
            ? { code: "off_peg", message: e.message }
            : { code: "quote_failed", message: "Could not get a price right now. Try again." };
    } else {
      const msg = e instanceof Error ? e.message : "";
      const code = PLAN_ERRORS[msg];
      stop = code ? { code, message: msg } : { code: "quote_failed", message: "Could not get a price right now. Try again." };
    }
  }

  // A router with an exit sizes its refund note from the vault's fee; an older one from the most the fee can be.
  const refundFee = router.version === 3 ? feeBps : undefined;
  const maxIn = roomIn ? maxSwapInForRefund(roomIn, refundFee) : null;
  const outRoom = roomOut ? depositRoom(roomOut) : null;
  const warnings: string[] = [];
  if (plan?.impactBps != null && plan.impactBps >= IMPACT_WARN_BPS) {
    warnings.push(`This size moves the price by about ${(plan.impactBps / 100).toFixed(2)}%. A smaller amount gets a better rate.`);
  }
  if (plan?.pegBps != null && plan.pegBps >= PEG_WARN_BPS) {
    warnings.push(`These two trade about ${(plan.pegBps / 100).toFixed(2)}% below a dollar for a dollar right now.`);
  }

  let relay: SwapQuote["relay"] = null;
  let floorUsd: number | null = null;
  if (!stop && plan) {
    if (!roomIn || !roomOut) {
      stop = { code: "limits_unread", message: "Could not read the vault's limits. Try again shortly." };
    } else if (!refundFits(roomIn, amountIn, refundFee)) {
      stop = {
        code: "refund_wont_fit",
        message:
          maxIn && maxIn > 0n
            ? "The vault could not take this swap's refund note back. Swap a smaller amount, or split the note first."
            : "The vault isn't taking this asset back right now, so a swap from it can't be made safely.",
        maxIn: (maxIn ?? 0n).toString(),
      };
    } else if (roomOut.perDeposit === 0n && roomOut.total === 0n) {
      stop = { code: "vault_closed", message: "The vault doesn't take the asset you would receive yet." };
    } else if (outRoom !== null && plan.amountOut > outRoom) {
      const fitsIn = plan.amountOut > 0n ? (amountIn * outRoom * 99n) / (plan.amountOut * 100n) : 0n;
      stop = { code: "over_room", message: "Too large for the vault right now: it takes less of the asset you would receive.", fitsIn: fitsIn.toString() };
    }
  }
  if (via === "relay") {
    relay = await (deps.relay ?? defaultRelay)(net).catch(() => null);
    if (!stop && plan) {
      if (relay && !relay.enabled) stop = { code: "relay_off", message: "The Gloam relay is off on this network right now." };
      else if (relay?.gasHigh) stop = { code: "gas_high", message: `${net.label} gas is high right now; try again shortly.` };
    }
    if (hasSwapFloor(net.chainId) && plan) {
      const floor = await floorFor(client, net.chainId, feeBps, plan.route.length || 1, nowMs);
      if (!floor) {
        if (!stop) stop = { code: "floor_unread", message: "Could not read the network fee. Try again shortly." };
      } else {
        floorUsd = Number.isFinite(floor.usd) ? floor.usd : null;
        if (!stop && noteUsd(net.chainId, assetIn, amountIn, floor.ethUsd) < floor.usd) {
          stop = Number.isFinite(floor.usd)
            ? { code: "swap_small", message: swapFloorMessage(net.label, floor.usd), floorUsd: floor.usd }
            : { code: "swap_small", message: SWAPS_PAUSED_MESSAGE };
        }
      }
    }
  }

  return {
    network: net.key,
    chainId: net.chainId,
    router: router.address,
    routerVersion: router.version,
    venue: router.venue,
    assetIn,
    assetOut,
    amountIn: amountIn.toString(),
    feeBps,
    available: str(plan?.available),
    amountOut: str(plan?.amountOut),
    cost: str(plan?.cost),
    leftover: str(plan?.leftover),
    route: plan?.route ?? [],
    hops: plan?.route.length ?? 0,
    impactBps: plan?.impactBps ?? null,
    pegBps: plan?.pegBps ?? null,
    warnings,
    stop,
    limits: { maxIn: str(maxIn), outRoom: str(outRoom) },
    relay,
    floorUsd,
    valueChecked: false,
    stops: { maxImpactBps, maxPegGapBps: PEG_STOP_BPS },
    valueNote: VALUE_NOTE,
    deadlineSeconds: swapDeadlineSeconds(net.chainId),
    quotedAt: nowMs,
    ttlMs: QUOTE_TTL_MS,
    public: SWAP_PUBLIC_LINE,
  };
}

/** One asset a router swaps, named. */
export type SwapAssetView = { address: Address; symbol: string | null; decimals: number | null; native: boolean; opensLater: boolean };

/** What swaps look like on one network: off, or the router new swaps use, its assets, and the older routers kept for refunds. */
export type SwapNetworkView = {
  network: NetworkKey;
  chainId: number;
  label: string;
  testnet: boolean;
  live: boolean;
  router: Address | null;
  version: 1 | 2 | 3 | null;
  venue: "v4" | "tempo" | null;
  maxHops: number | null;
  deadlineSeconds: number | null;
  assets: SwapAssetView[];
  /** Earlier routers the relay still sends refunds through, for swaps made with them. */
  earlierRouters: { address: Address; version: 1 | 2 | 3 }[];
};

function assetView(chainId: number, a: Address, gated: readonly Address[] | undefined): SwapAssetView {
  const native = BigInt(a) === 0n;
  const t = native ? null : knownTokens(chainId).find((k) => k.address.toLowerCase() === a.toLowerCase());
  return {
    address: a,
    symbol: native ? "ETH" : (t?.symbol ?? null),
    decimals: native ? 18 : (t?.decimals ?? null),
    native,
    // offered once its pool is live on the router and the vault takes it (lib/vaultSwap offeredSwapAssets)
    opensLater: Boolean(gated?.some((g) => g.toLowerCase() === a.toLowerCase())),
  };
}

/** Every network Gloam runs on, with its swaps: for GET /api/v1/swaps. */
export function swapNetworksView(): SwapNetworkView[] {
  return NETWORK_KEYS.map((key) => {
    const net = getNetwork(key);
    const r = net.pool ? swapRouterFor(net.chainId) : null;
    return {
      network: key,
      chainId: net.chainId,
      label: net.label,
      testnet: net.testnet,
      live: Boolean(r),
      router: r?.address ?? null,
      version: r?.version ?? null,
      venue: r?.venue ?? null,
      maxHops: r ? r.maxHops : null,
      deadlineSeconds: r ? swapDeadlineSeconds(net.chainId) : null,
      assets: r ? r.assets.map((a) => assetView(net.chainId, a, r.gated)) : [],
      earlierRouters: r ? swapRoutersOn(net.chainId).slice(1).map((o) => ({ address: o.address, version: o.version })) : [],
    };
  });
}
