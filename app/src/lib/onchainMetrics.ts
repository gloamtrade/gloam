/**
 * On-chain traction for /admin, read from both networks' current vaults. This
 * is the source of truth for deposits, private transfers, cash-outs, payment
 * messages, depositor wallets and value held. Server only.
 *
 * What it reads, per network (lib/networks):
 * - Every log of the vault since its deploy block. Queries are address-only and
 *   decoded here: Robinhood's RPC caps queries with several event topics at 100k
 *   blocks but takes an address-only query over millions; Tempo caps every
 *   query at 100k (`logRange`).
 * - PaymentMemo logs on the payment-message board since the vault's deploy.
 * - balanceOf(vault) for every token the vault can hold (the listed ones plus
 *   those a private swap lands in, `holdableTokens`), plus the native balance
 *   where the chain shields its native coin.
 * - The cash-out fee: WithdrawFee and FeesCollected logs (from the same scan),
 *   plus withdrawFeeBps(), feeRecipient() and feesOwed(asset) on the vault.
 * - $GLOAM creator fees from the Orynth fee vault on Robinhood Chain (lib/creatorFees).
 *
 * Every RPC call goes through a per-chain gate (a few in flight, spaced out on
 * Tempo, whose RPC answers 429 to bursts) and is retried. Reads are incremental:
 * each network keeps what it has read (memory, then Redis) and a refresh only
 * reads the blocks since. The finished snapshot is cached for a minute in memory
 * and Redis so loading /admin never hammers the RPCs.
 */

import {
  createPublicClient,
  formatUnits,
  parseAbi,
  parseEventLogs,
  toEventSelector,
  type Address,
  type Log,
  type PublicClient,
} from "viem";
import { getNetwork, NETWORK_KEYS, networkName, type GloamNetwork, type NetworkKey } from "./networks";
import { erc20BalanceOfAbi, isDollarStable, shieldTokensFor, supportsNativeShield } from "./tokens";
import { loadEthUsd, loadHypeUsd, loadLiveMarkets } from "./live-quotes";
import { cacheGetJson, cacheSetJson, lastDays, utcDay } from "./tractionStore";
import { serverTransport } from "@/lib/serverRpc";
import { readCreatorFees, type CreatorFees } from "./creatorFees";
import { MAINNET_LAUNCH_MS } from "./mainnet";
import { errText, getLogsSafe } from "./logRange";
import { EVERY_SWAP_ROUTER } from "./vaultSwap";
import { addChainPeople } from "./peopleStore";
import { hasUiMultiplier, holdableTokens, SWAP_LANDABLE, swapTokenPrice } from "./vaultAssets";
import { dailyMeans, priceAt, usdSeries } from "./priceHistory";

// Moved to lib/vaultAssets so the browser's read on /transparency uses them too.
export { holdableTokens, swapTokenPrice };

export type ActivityKind = "deposit" | "transfer" | "cashout" | "trade";

export type AssetRow = {
  /** Token address, or "native" for the chain's own coin. */
  asset: string;
  symbol: string;
  stable: boolean;
  /** Held by the vault now, in whole units; null when the read failed. */
  held: string | null;
  heldUsd: number | null;
  deposited: string;
  depositCount: number;
  cashedOut: string;
  cashoutCount: number;
};

export type DayRow = {
  /** UTC, YYYY-MM-DD */
  day: string;
  deposits: number;
  transfers: number;
  cashouts: number;
  trades: number;
  /** Wallets that deposited or received a cash-out that day. */
  activeWallets: number;
};

export type RecentRow = {
  network: NetworkKey;
  kind: ActivityKind;
  tx: string;
  block: string;
  /** Unix seconds; 0 while unknown. */
  ts: number;
  /** Depositor or cash-out recipient; transfers and trades have none. */
  wallet: string | null;
  detail: string;
};

/**
 * Dollar figures over rolling windows (the last 24 hours, 7 days, 30 days, all
 * time). On a mainnet each deposit, cash-out and fee is priced at the time it
 * happened (lib/priceHistory); on a testnet at today's prices.
 */
export type Windowed = { d1: number; d7: number; d30: number; all: number };

export type FeeRow = {
  asset: string;
  symbol: string;
  /** Kept by cash-outs since the vault went live (WithdrawFee logs). */
  earned: string;
  /** Each fee priced when it was kept (a testnet: today's price); null for an asset with no dollar price. */
  earnedUsd: number | null;
  count: number;
  /** Still in the vault waiting for collectFees(); null when it could not be read. */
  owed: string | null;
  owedUsd: number | null;
  /** Already sent to the fee recipient (FeesCollected logs). */
  collected: string;
};

/** One UTC day of money moving through a vault, priced as Windowed says. */
export type RevenueDay = {
  day: string;
  feesUsd: number;
  depositUsd: number;
  cashoutUsd: number;
  /** Deposits, private transfers, cash-outs and trades. */
  txs: number;
  /** Wallets that deposited or received a cash-out that day. */
  wallets: number;
};

export type NetworkRevenue = {
  /** The cash-out fee now, in basis points; null when it could not be read. */
  feeBps: number | null;
  feeRecipient: string | null;
  fees: Windowed;
  feeRows: FeeRow[];
  /** Fees in the vault not yet collected, priced. */
  owedUsd: number;
  depositVolume: Windowed;
  cashoutVolume: Windowed;
  /** Transaction counts, not dollars. */
  txs: Windowed;
  daily: RevenueDay[];
  /**
   * Assets that moved but have no dollar price (EURC is a euro, never $1): left
   * out of the dollar figures above, never counted as $0 without saying so.
   * Absent on snapshots cached before it was added.
   */
  unpriced?: string[];
  /**
   * Mainnet assets priced at today's price because no price for the time of
   * the flow could be read yet (CoinGecko down, or a token it has no history
   * for). Named next to the figures; empty once every flow has its price.
   */
  atToday?: string[];
};

export type NetworkMetrics = {
  key: NetworkKey;
  /** "Robinhood Chain", or "Robinhood Chain testnet" for the test network. */
  label: string;
  testnet: boolean;
  chainId: number;
  pool: string;
  memo: string | null;
  deployBlock: string;
  scannedTo: string;
  /** Chain head at the last read; null when that read failed. */
  latestBlock: string | null;
  /** True while a long backlog is still being read over several passes. */
  catchingUp: boolean;
  deposits: number;
  transfers: number;
  cashouts: number;
  trades: number;
  memos: number;
  /** Unique wallets that deposited. */
  depositors: number;
  /** Unique wallets that received a cash-out. */
  cashoutWallets: number;
  /** Depositors and cash-out recipients together. */
  activeWallets: number;
  /** Sum of the priced holdings. */
  heldUsd: number;
  /** Symbols held with no price (counted out of heldUsd). */
  unpriced: string[];
  assets: AssetRow[];
  /** Unix seconds of the first and last pool activity; null with none yet. */
  firstActivity: number | null;
  lastActivity: number | null;
  /** Unix seconds of the vault's deploy block. */
  vaultSince: number | null;
  daily: DayRow[];
  topDepositors: { address: string; deposits: number; lastTs: number }[];
  recent: RecentRow[];
  /** Blocks read by the last pass, and how long it took. */
  blocksRead: string;
  readMs: number;
  /** Set when the last read failed; the figures are then the last ones read. */
  error: string | null;
  /** Fees and volume; absent on snapshots cached before they were added. */
  revenue?: NetworkRevenue;
};

export type CombinedRevenue = Omit<NetworkRevenue, "feeBps" | "feeRecipient" | "feeRows"> & {
  /** Wallets that deposited or received a cash-out in the window (counts, not dollars). */
  users: Windowed;
};

export type CombinedMetrics = {
  deposits: number;
  transfers: number;
  cashouts: number;
  trades: number;
  memos: number;
  depositors: number;
  activeWallets: number;
  heldUsd: number;
  unpriced: string[];
  firstActivity: number | null;
  lastActivity: number | null;
  daily: DayRow[];
  /** Absent on snapshots cached before revenue tracking. */
  revenue?: CombinedRevenue;
  /**
   * Mainnets only: one row per UTC day from the public launch to today, so a
   * public page can chart every day since launch (`daily` keeps 14). Absent on
   * snapshots cached before it was added.
   */
  sinceLaunch?: DayRow[];
};

export type OnchainMetrics = {
  asOf: string;
  /** Where this snapshot came from: read just now, or a cached one. */
  source: "fresh" | "memory" | "redis";
  ageSec: number;
  /**
   * Today's prices, used for what is held now and fees waiting to collect.
   * `flowsAtTime`: mainnet deposits, cash-outs and fees are priced at the time
   * of each one (absent on snapshots from before, which priced them today).
   */
  prices: { ethUsd: number | null; stocks: "live" | "unpriced"; flowsAtTime?: true };
  networks: NetworkMetrics[];
  /** Every network together, testnets included. */
  combined: CombinedMetrics;
  /** Mainnets only. Absent on snapshots cached before it was added. */
  mainnet?: CombinedMetrics;
  /** Testnets only. */
  testnet?: CombinedMetrics;
  /** $GLOAM creator fees on Robinhood Chain; absent before it was added or while that chain is not live. */
  creator?: CreatorFees | { error: string };
  /** Both networks, newest first. */
  recent: RecentRow[];
};

/* ------------------------------------------------------------------ config */

/** Requests in flight per chain. */
const PARALLEL: Record<number, number> = { 46630: 4, 42431: 3, 84532: 3, 11155111: 3, 4663: 2, 4217: 3, 8453: 3, 1: 3 };
/** Minimum gap between request starts per chain, ms. */
const SPACING_MS: Record<number, number> = { 46630: 0, 42431: 120, 84532: 120, 11155111: 120, 4663: 0, 4217: 120, 8453: 120, 1: 120 };
/** First span per address-only getLogs; a range error halves it. Else `logRange`. */
const SPAN: Record<number, bigint> = { 46630: 5_000_000n, 4663: 5_000_000n };
/** getLogs spans per address per pass; the rest of a backlog waits for the next pass. */
const MAX_SPANS_PER_PASS = 40n;
/** Timestamps fetched per pass where the RPC does not put them on the log. */
const MAX_BLOCK_FETCH = 250;
const DAILY_WINDOW = 14;
/** Days of revenue rows kept in a snapshot. */
export const REVENUE_DAYS = 30;
const RECENT_KEEP = 25;

const SNAPSHOT_FRESH_MS = 60_000;
const FORCE_MIN_GAP_MS = 15_000;
const SNAPSHOT_KEY = "gloam:onchain:snapshot:v1";
const STATE_PREFIX = "gloam:onchain:state:v1";
const STATE_TTL_SEC = 14 * 86_400;
const PRICE_TTL_MS = 5 * 60_000;

const POOL_ABI = parseAbi([
  "event Shielded(bytes32 indexed commitment, address indexed asset, uint256 amount, uint256 leafIndex, address indexed from)",
  "event Transferred(bytes32 indexed nullifier, bytes32[2] newCommitments)",
  "event Unshielded(bytes32 indexed nullifier, address indexed asset, address indexed to, uint256 amount)",
  "event SealedSwapped(bytes32 indexed nullifier, address indexed assetIn, address indexed assetOut, bytes32 newCommitmentOut, bytes32 newCommitmentChange)",
  "event WithdrawFee(bytes32 indexed nullifier, address indexed asset, uint256 fee)",
  "event FeesCollected(address indexed asset, address indexed recipient, uint256 amount)",
]);

const FEE_ABI = parseAbi([
  "function withdrawFeeBps() view returns (uint16)",
  "function feeRecipient() view returns (address)",
  "function feesOwed(address) view returns (uint256)",
]);

/** Both board versions: the first also indexed the poster. */
const MEMO_TOPICS = new Set([
  toEventSelector("PaymentMemo(bytes32,address,bytes)"),
  toEventSelector("PaymentMemo(bytes32,bytes)"),
]);

const NATIVE = "native";
const ZERO = "0x0000000000000000000000000000000000000000";

/* ------------------------------------------------------------------ state */

/** Compact pool event as kept between reads. */
export type ChainEvent = {
  k: ActivityKind;
  b: number;
  i: number;
  ts: number;
  tx: string;
  /** Depositor (from) or cash-out recipient (to), lowercase. */
  w?: string;
  /** Asset, lowercase; "native" for the chain's coin. */
  a?: string;
  /** Raw amount. */
  v?: string;
  /** Cash-out fee kept by the vault, raw, in the same asset. */
  f?: string;
  /**
   * A private swap's leg: the note a swap spends goes out to its escrow, and the
   * router puts the new note in, in one transaction. Inside the vault, so not a
   * deposit or a cash-out (`counted` turns the pair into one trade).
   */
  r?: 1;
  /** USD per whole token at the time of the flow (mainnet, not a dollar stablecoin; lib/priceHistory). */
  p?: number;
  /** `p` is provisional: the flow is too new for the hour to be settled; priced again on a later read. */
  pq?: 1;
};

export type ScanState = {
  v: 1;
  pool: string;
  scannedTo: number;
  memoScannedTo: number;
  memos: number;
  startTs: number;
  /** Oldest first. */
  events: ChainEvent[];
  /** Set once the scan decodes cash-out fees; a mainnet state without it is read again from the start. */
  fee?: 1;
  /** Fees sent to the recipient per asset, raw (FeesCollected). */
  collected?: Record<string, string>;
  /** Set once the scan marks private swap legs (`r`); a mainnet state without it is read again from the start. */
  sw?: 1;
};

const states = new Map<NetworkKey, ScanState>();
/**
 * Block times from a state that is read again from the start (a mainnet state
 * from before `sw`), so the new read does not have to fetch them again.
 */
const carriedTs = new Map<NetworkKey, Map<number, number>>();

/** A state this version can build on: a mainnet one must have every cash-out fee and swap leg marked. */
function usable(n: GloamNetwork, s: ScanState): boolean {
  return n.testnet || Boolean(s.fee && s.sw);
}

function stateKey(n: GloamNetwork) {
  return `${STATE_PREFIX}:${n.key}:${(n.pool ?? "").toLowerCase()}`;
}

async function loadState(n: GloamNetwork): Promise<ScanState | null> {
  const pool = (n.pool ?? "").toLowerCase();
  const m = states.get(n.key);
  if (m && m.pool === pool && usable(n, m)) return m;
  const r = await cacheGetJson<ScanState>(stateKey(n));
  // Testnet states keep their history (their fees are not revenue); a mainnet one is
  // read again so every cash-out fee and private swap is counted right.
  if (r && r.v === 1 && r.pool === pool && Array.isArray(r.events)) {
    if (usable(n, r)) {
      states.set(n.key, r);
      return r;
    }
    carriedTs.set(n.key, new Map(r.events.filter((e) => e.ts).map((e) => [e.b, e.ts])));
  }
  return null;
}

async function saveState(n: GloamNetwork, s: ScanState) {
  states.set(n.key, s);
  await cacheSetJson(stateKey(n), s, STATE_TTL_SEC);
}

/* ------------------------------------------------------------------ rpc */

const clients = new Map<number, PublicClient>();

function clientFor(n: GloamNetwork): PublicClient {
  const hit = clients.get(n.chainId);
  if (hit) return hit;
  const c = createPublicClient({
    chain: n.chain,
    ccipRead: false,
    // viem retries 429s, 5xx and timeouts with backoff (0.5s, 1s, 2s, 4s).
    transport: serverTransport(n, { timeout: 20_000, retryCount: 4, retryDelay: 500 }),
  });
  clients.set(n.chainId, c);
  return c;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const gates = new Map<number, { active: number; waiting: (() => void)[]; lastStart: number }>();

/** Every RPC call for a chain goes through here: at most PARALLEL at once, SPACING_MS apart. */
async function gated<T>(chainId: number, call: () => Promise<T>): Promise<T> {
  let g = gates.get(chainId);
  if (!g) {
    g = { active: 0, waiting: [], lastStart: 0 };
    gates.set(chainId, g);
  }
  const max = PARALLEL[chainId] ?? 2;
  while (g.active >= max) await new Promise<void>((r) => g.waiting.push(r));
  g.active++;
  try {
    const gap = SPACING_MS[chainId] ?? 0;
    const wait = g.lastStart + gap - Date.now();
    g.lastStart = Math.max(Date.now(), g.lastStart + gap);
    if (wait > 0) await sleep(wait);
    return await call();
  } finally {
    g.active--;
    g.waiting.shift()?.();
  }
}

/**
 * Relay's router makes every private-bridge deposit (lib/bridge
 * privateBridgeable), so its address is not a person's wallet: such a deposit
 * counts as money in, but not as a wallet or a depositor. The same goes for a
 * private swap (lib/vaultSwap): its router puts the new note in, and the note
 * it spends goes out to a one-time escrow in the same transaction. Every router
 * counts, not only the one in use: its past deposits are still a router's.
 */
const RELAY_ROUTER = "0xb92fe925dc43a0ecde6c8b1a2709c170ec4fff4f";
const SWAP_ROUTERS = new Set(EVERY_SWAP_ROUTER.map((a) => a.toLowerCase()));
function depositor(from: string | undefined): string | undefined {
  const w = from?.toLowerCase();
  return w === RELAY_ROUTER || (w && SWAP_ROUTERS.has(w)) ? undefined : w;
}

function ranges(from: bigint, to: bigint, step: bigint): [bigint, bigint][] {
  const out: [bigint, bigint][] = [];
  for (let s = from; s <= to; s += step) out.push([s, s + step - 1n > to ? to : s + step - 1n]);
  return out;
}

/** Every log an address emitted in [from, to], in spans the chain accepts. */
async function addressLogs(n: GloamNetwork, address: Address, from: bigint, to: bigint): Promise<Log[]> {
  if (from > to) return [];
  const c = clientFor(n);
  const span = SPAN[n.chainId] ?? n.logRange;
  const parts = await Promise.all(
    ranges(from, to, span).map(([a, b]) =>
      getLogsSafe((x, y) => gated(n.chainId, () => c.getLogs({ address, fromBlock: x, toBlock: y })), a, b)
    )
  );
  return parts.flat();
}

function hexTs(v: unknown): number {
  try {
    if (typeof v === "string" || typeof v === "bigint" || typeof v === "number") return Number(BigInt(v));
  } catch {
    /* ignore */
  }
  return 0;
}

/* ------------------------------------------------------------------ assets */

type AssetInfo = {
  symbol: string;
  decimals: number;
  stable: boolean;
  /** Wrapped ETH: one token is one ETH. */
  weth?: boolean;
};

export function assetInfo(n: GloamNetwork, asset: string): AssetInfo {
  if (asset === NATIVE) return { symbol: n.primaryAsset.symbol, decimals: n.primaryAsset.decimals, stable: false };
  const t = holdableTokens(n.chainId).find((x) => x.address.toLowerCase() === asset);
  if (t) return { symbol: t.symbol, decimals: t.decimals, stable: isDollarStable(t), ...(t.id === "weth" ? { weth: true } : {}) };
  return { symbol: `${asset.slice(0, 6)}…${asset.slice(-4)}`, decimals: 18, stable: false };
}

function fmtUnits(raw: bigint, info: AssetInfo): string {
  const s = formatUnits(raw, info.decimals);
  const [i, f = ""] = s.split(".");
  const keep = info.stable ? 2 : 6;
  const frac = f.slice(0, keep).replace(/0+$/, "");
  return frac ? `${i}.${frac}` : i;
}

export type Prices = {
  at: number;
  ethUsd: number | null;
  /** HYPE, Elysium's native coin (CoinGecko "hyperliquid"); missing or null leaves it unpriced, never at ETH's price. */
  hypeUsd?: number | null;
  marks: Map<string, number>;
  stocks: "live" | "unpriced";
};
let priceCache: Prices | null = null;
const PRICE_KEY = "gloam:onchain:prices:v1";

function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([p.catch(() => fallback), sleep(ms).then(() => fallback)]);
}

/** $GLOAM on Robinhood Chain, priced from its deepest pool on DEX Screener. */
const GLOAM = shieldTokensFor(4663).find((t) => t.symbol === "GLOAM")?.address.toLowerCase() ?? null;

async function loadGloamUsd(): Promise<number | null> {
  if (!GLOAM) return null;
  const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${GLOAM}`, { signal: AbortSignal.timeout(8_000), cache: "no-store" });
  const j = (await res.json()) as { pairs?: { chainId?: string; priceUsd?: string; liquidity?: { usd?: number } }[] };
  const best = (j.pairs ?? [])
    .filter((p) => p.chainId === "robinhood")
    .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
  const price = Number(best?.priceUsd);
  return Number.isFinite(price) && price > 0 ? price : null;
}

const UI_MULTIPLIER_ABI = parseAbi(["function uiMultiplier() view returns (uint256)"]);

type LiveMarkets = Awaited<ReturnType<typeof loadLiveMarkets>>;

/**
 * USD per token for the Robinhood mainnet tokens a private swap lands in, by
 * address (lowercase), priced the way the app prices them (VaultSwapView):
 * - a stock token: the live market with the token's id (the /api/markets mark,
 *   a share price) times the token's uiMultiplier / 1e18, else CoinGecko's price
 *   for the token itself. Never the share price alone: with the multiplier unread
 *   it falls back to CoinGecko, and with neither it is left out (unpriced).
 * - any other token with a CoinGecko id (cbBTC, PONS, CASHCAT, VIRTUAL): its CoinGecko price.
 * Dollar stablecoins ($1) and WETH (ETH's price) need no mark; $GLOAM is priced
 * from DEX Screener. Anything not returned here has no price.
 */
async function loadSwapTokenMarks(marketsRead: Promise<LiveMarkets>): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const n = getNetwork("robinhood-mainnet");
  if (n.status !== "live") return out;
  const tokens = (SWAP_LANDABLE[n.chainId] ?? []).filter((t) => !isDollarStable(t) && t.id !== "weth");
  const stocks = tokens.filter((t) => hasUiMultiplier(n.chainId, t));
  const c = clientFor(n);

  const ids = [...new Set(tokens.map((t) => t.coingecko).filter((x): x is string => Boolean(x)))];
  const gecko = ids.length
    ? fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${ids.join(",")}&vs_currencies=usd`, {
        signal: AbortSignal.timeout(8_000),
        cache: "no-store",
      })
        .then((r) => (r.ok ? (r.json() as Promise<Record<string, { usd?: number }>>) : null))
        .catch(() => null)
    : Promise.resolve(null);
  const mults = Promise.all(
    stocks.map((t) =>
      gated(n.chainId, () => c.readContract({ address: t.address, abi: UI_MULTIPLIER_ABI, functionName: "uiMultiplier" })).catch(
        () => null
      )
    )
  );
  const [markets, g, multRaw] = await Promise.all([marketsRead, gecko, mults]);

  const multOf = new Map(stocks.map((t, i) => [t.address.toLowerCase(), multRaw[i] ?? null]));
  for (const t of tokens) {
    const a = t.address.toLowerCase();
    const price = swapTokenPrice(n.chainId, t, markets, multOf.get(a) ?? null, t.coingecko ? g?.[t.coingecko]?.usd : undefined);
    if (price != null) out.set(a, price);
  }
  return out;
}

/**
 * Listed tokens only CoinGecko prices that loadSwapTokenMarks does not reach: BDX
 * on Base and Ethereum (one address on both, so listed once), and GRIFT, AI and
 * ORBIO on Robinhood Chain. $GLOAM is priced from DEX Screener, dollar stablecoins
 * are $1 and EURC is left unpriced, as before.
 */
const SWAP_MARKED = new Set((SWAP_LANDABLE[4663] ?? []).map((t) => t.address.toLowerCase()));
const GECKO_LISTED = [4663, 8453, 1]
  .flatMap((c) => shieldTokensFor(c))
  .filter(
    (t, i, all) =>
      t.kind === "token" &&
      t.coingecko &&
      t.id !== "gloam" &&
      !SWAP_MARKED.has(t.address.toLowerCase()) &&
      all.findIndex((x) => x.address.toLowerCase() === t.address.toLowerCase()) === i
  );

/** USD per token for GECKO_LISTED, by address (lowercase); a token CoinGecko does not answer for is left out. */
async function loadListedTokenMarks(): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const ids = [...new Set(GECKO_LISTED.map((t) => t.coingecko!))];
  if (!ids.length) return out;
  const g = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${ids.join(",")}&vs_currencies=usd`, {
    signal: AbortSignal.timeout(8_000),
    cache: "no-store",
  })
    .then((r) => (r.ok ? (r.json() as Promise<Record<string, { usd?: number }>>) : null))
    .catch(() => null);
  for (const t of GECKO_LISTED) {
    const usd = g?.[t.coingecko!]?.usd;
    if (typeof usd === "number" && Number.isFinite(usd) && usd > 0) out.set(t.address.toLowerCase(), usd);
  }
  return out;
}

/**
 * ETH and HYPE from CoinGecko, the stock tokens from live equity marks (the same source
 * as /api/markets, static fallbacks left out), $GLOAM from DEX Screener, and
 * the swap tokens as loadSwapTokenMarks says. Stablecoins count as $1, WETH as ETH. Cached five minutes in memory and Redis; the
 * upstreams are slow, so this starts alongside the chain reads.
 */
export async function loadPrices(): Promise<Prices> {
  if (priceCache && Date.now() - priceCache.at < PRICE_TTL_MS) return priceCache;
  const stored = await cacheGetJson<{ at: number; ethUsd: number | null; hypeUsd?: number | null; marks: [string, number][]; stocks?: Prices["stocks"] }>(PRICE_KEY);
  if (stored && Date.now() - stored.at < PRICE_TTL_MS) {
    priceCache = {
      at: stored.at,
      ethUsd: stored.ethUsd,
      hypeUsd: stored.hypeUsd ?? null,
      marks: new Map(stored.marks),
      stocks: stored.stocks ?? (stored.marks.length ? "live" : "unpriced"),
    };
    return priceCache;
  }
  const marketsRead = withTimeout(loadLiveMarkets(), 25_000, [] as LiveMarkets);
  const [ethUsd, hypeUsd, markets, gloamUsd, swapMarks, listedMarks] = await Promise.all([
    withTimeout(loadEthUsd(), 15_000, null),
    withTimeout(loadHypeUsd(), 15_000, null),
    marketsRead,
    withTimeout(loadGloamUsd(), 10_000, null),
    withTimeout(loadSwapTokenMarks(marketsRead), 25_000, new Map<string, number>()),
    withTimeout(loadListedTokenMarks(), 10_000, new Map<string, number>()),
  ]);
  const marks = new Map<string, number>();
  for (const m of markets) {
    if (m.address && m.source === "live" && m.mark > 0) marks.set(m.address.toLowerCase(), m.mark);
  }
  const prev = priceCache;
  const stocksLive = marks.size > 0 || prev?.stocks === "live";
  const kept = marks.size ? marks : new Map(prev?.marks ?? []);
  // A swap token whose price could not be read this time keeps the last one read.
  for (const t of SWAP_LANDABLE[4663] ?? []) {
    const a = t.address.toLowerCase();
    const last = prev?.marks.get(a);
    if (last != null && !swapMarks.has(a)) kept.set(a, last);
  }
  for (const [a, price] of swapMarks) kept.set(a, price);
  // BDX, AI and the like: the last price read is kept when CoinGecko misses a turn.
  for (const t of GECKO_LISTED) {
    const a = t.address.toLowerCase();
    const price = listedMarks.get(a) ?? prev?.marks.get(a);
    if (price != null) kept.set(a, price);
  }
  const gloam = gloamUsd ?? (GLOAM ? prev?.marks.get(GLOAM) : undefined);
  if (GLOAM && gloam) kept.set(GLOAM, gloam);
  priceCache = {
    at: Date.now(),
    ethUsd: ethUsd ?? prev?.ethUsd ?? null,
    hypeUsd: hypeUsd ?? prev?.hypeUsd ?? null,
    marks: kept,
    stocks: stocksLive ? "live" : "unpriced",
  };
  if (ethUsd != null || hypeUsd != null || marks.size || gloamUsd != null || swapMarks.size || listedMarks.size) {
    await cacheSetJson(
      PRICE_KEY,
      { at: priceCache.at, ethUsd: priceCache.ethUsd, hypeUsd: priceCache.hypeUsd, marks: [...priceCache.marks], stocks: priceCache.stocks },
      PRICE_TTL_MS / 1000
    );
  }
  return priceCache;
}

export function usdOf(n: GloamNetwork, asset: string, units: number, info: AssetInfo, prices: Prices): number | null {
  if (info.stable) return units;
  if (asset === NATIVE) {
    // the chain's own coin at its own price: ETH, or HYPE on Elysium
    const p = n.primaryAsset.symbol === "ETH" ? prices.ethUsd : n.primaryAsset.symbol === "HYPE" ? prices.hypeUsd : null;
    return p != null ? units * p : null;
  }
  // WETH is an ERC-20, but one token is one ETH.
  if (info.weth) return prices.ethUsd != null ? units * prices.ethUsd : null;
  const mark = prices.marks.get(asset);
  return mark != null ? units * mark : null;
}

/* ------------------------------------------------------------------ read */

export type Holding = { asset: string; raw: bigint | null };

async function readHoldings(n: GloamNetwork, vault: Address): Promise<Holding[]> {
  const c = clientFor(n);
  const rows: Promise<Holding>[] = holdableTokens(n.chainId).map(async (t) => ({
    asset: t.address.toLowerCase(),
    raw: await gated(n.chainId, () =>
      c.readContract({ address: t.address, abi: erc20BalanceOfAbi, functionName: "balanceOf", args: [vault] })
    ).catch(() => null),
  }));
  if (supportsNativeShield(n.chainId)) {
    rows.push(
      gated(n.chainId, () => c.getBalance({ address: vault }))
        .then((raw) => ({ asset: NATIVE, raw }))
        .catch(() => ({ asset: NATIVE, raw: null }))
    );
  }
  return Promise.all(rows);
}

type FeeSettings = { bps: number | null; recipient: string | null; owed: Map<string, bigint | null> };

/**
 * The vault's cash-out fee and what it holds for collectFees(). Mainnet only; each
 * read fails soft. A cash-out charges its fee in the asset cashed out, so this reads
 * feesOwed for every holdable asset (a swap can leave the vault holding a stock or
 * WETH that is later cashed out), not only the listed ones.
 */
async function readFeeSettings(n: GloamNetwork, vault: Address): Promise<FeeSettings | null> {
  if (n.testnet) return null;
  const c = clientFor(n);
  const soft = <T>(call: () => Promise<T>) => gated(n.chainId, call).catch(() => null);
  const assets = [
    ...(supportsNativeShield(n.chainId) ? [NATIVE] : []),
    ...holdableTokens(n.chainId).map((t) => t.address.toLowerCase()),
  ];
  const [bps, recipient, owed] = await Promise.all([
    soft(() => c.readContract({ address: vault, abi: FEE_ABI, functionName: "withdrawFeeBps" })),
    soft(() => c.readContract({ address: vault, abi: FEE_ABI, functionName: "feeRecipient" })),
    Promise.all(
      assets.map((a) =>
        soft(() =>
          c.readContract({ address: vault, abi: FEE_ABI, functionName: "feesOwed", args: [(a === NATIVE ? ZERO : a) as Address] })
        )
      )
    ),
  ]);
  return {
    bps: bps == null ? null : Number(bps),
    recipient: recipient ? recipient.toLowerCase() : null,
    owed: new Map(assets.map((a, i) => [a, owed[i] ?? null])),
  };
}

/** Reads the blocks since the last pass into the network's state. */
async function scan(
  n: GloamNetwork,
  prev: ScanState | null
): Promise<{ state: ScanState; blocksRead: bigint; latest: bigint }> {
  if (!n.pool || n.deployBlock == null) throw new Error(`${n.label} has no vault yet`);
  const c = clientFor(n);
  const vault = n.pool;
  const latest = await gated(n.chainId, () => c.getBlockNumber());
  const deploy = n.deployBlock;

  const from = prev ? BigInt(prev.scannedTo) + 1n : deploy;
  const memo = n.payMemo;
  const memoStart = memo ? (memo.deployBlock > deploy ? memo.deployBlock : deploy) : 0n;
  const memoFrom = prev && prev.memoScannedTo > 0 ? BigInt(prev.memoScannedTo) + 1n : memoStart;
  // A long backlog is read over several passes so one request stays well inside its time limit.
  const span = SPAN[n.chainId] ?? n.logRange;
  const capTo = (start: bigint) => {
    const end = start + span * MAX_SPANS_PER_PASS - 1n;
    return end < latest ? end : latest;
  };
  const poolTo = capTo(from);
  const memoTo = capTo(memoFrom);

  const [poolLogs, memoLogs, startTs] = await Promise.all([
    addressLogs(n, vault, from, poolTo),
    memo ? addressLogs(n, memo.address, memoFrom, memoTo) : Promise.resolve([] as Log[]),
    prev?.startTs
      ? Promise.resolve(prev.startTs)
      : gated(n.chainId, () => c.getBlock({ blockNumber: deploy }))
          .then((b) => Number(b.timestamp))
          .catch(() => 0),
  ]);

  const parsed = parseEventLogs({ abi: POOL_ABI, logs: poolLogs });
  // unshield() logs WithdrawFee beside Unshielded, keyed by the same nullifier.
  const feeOf = new Map<string, bigint>();
  const collected: Record<string, string> = { ...(prev?.collected ?? {}) };
  const assetKey = (a: Address | undefined) => (!a || a.toLowerCase() === ZERO ? NATIVE : a.toLowerCase());
  for (const log of parsed) {
    if (log.eventName === "WithdrawFee") {
      feeOf.set(`${log.transactionHash}:${log.args.nullifier}`, log.args.fee ?? 0n);
    } else if (log.eventName === "FeesCollected") {
      const a = assetKey(log.args.asset);
      collected[a] = String(BigInt(collected[a] ?? "0") + (log.args.amount ?? 0n));
    }
  }

  // A private swap's transaction: its note goes out to a one-time escrow, not to anyone's wallet.
  const swapTxs = new Set(
    parsed
      .filter((l) => l.eventName === "Shielded" && SWAP_ROUTERS.has(String(l.args.from).toLowerCase()))
      .map((l) => l.transactionHash)
  );
  const fresh: ChainEvent[] = [];
  for (const log of parsed) {
    const base = {
      b: Number(log.blockNumber ?? 0n),
      i: log.logIndex ?? 0,
      tx: log.transactionHash ?? "",
      ts: hexTs((log as { blockTimestamp?: unknown }).blockTimestamp),
    };
    const asset = assetKey;
    switch (log.eventName) {
      case "Shielded": {
        const swapIn = SWAP_ROUTERS.has(String(log.args.from).toLowerCase());
        fresh.push({
          ...base,
          k: "deposit",
          w: depositor(log.args.from),
          a: asset(log.args.asset),
          v: String(log.args.amount ?? 0n),
          ...(swapIn ? { r: 1 as const } : {}),
        });
        break;
      }
      case "Unshielded": {
        const fee = feeOf.get(`${log.transactionHash}:${log.args.nullifier}`);
        const swapOut = swapTxs.has(log.transactionHash);
        fresh.push({
          ...base,
          k: "cashout",
          w: swapOut ? undefined : log.args.to?.toLowerCase(),
          a: asset(log.args.asset),
          v: String(log.args.amount ?? 0n),
          ...(fee ? { f: String(fee) } : {}),
          ...(swapOut ? { r: 1 as const } : {}),
        });
        break;
      }
      case "Transferred":
        fresh.push({ ...base, k: "transfer" });
        break;
      case "SealedSwapped":
        fresh.push({ ...base, k: "trade" });
        break;
    }
  }
  const memos = memoLogs.filter((l) => l.topics[0] && MEMO_TOPICS.has(l.topics[0])).length;

  const events = [...(prev?.events ?? []), ...fresh].sort((x, y) => x.b - y.b || x.i - y.i);
  // Read again from the start: the old state's block times still hold.
  const carry = prev ? undefined : carriedTs.get(n.key);
  if (carry) {
    for (const e of events) if (!e.ts) e.ts = carry.get(e.b) ?? 0;
    carriedTs.delete(n.key);
  }

  // Robinhood leaves blockTimestamp at 0 on logs; read those blocks (newest first, capped per pass).
  const missing = [...new Set(events.filter((e) => !e.ts).map((e) => e.b))].sort((x, y) => y - x).slice(0, MAX_BLOCK_FETCH);
  if (missing.length) {
    const times = new Map<number, number>();
    await Promise.all(
      missing.map((b) =>
        gated(n.chainId, () => c.getBlock({ blockNumber: BigInt(b) }))
          .then((blk) => times.set(b, Number(blk.timestamp)))
          .catch(() => undefined)
      )
    );
    for (const e of events) if (!e.ts) e.ts = times.get(e.b) ?? 0;
  }

  return {
    state: {
      v: 1,
      pool: vault.toLowerCase(),
      scannedTo: Number(poolTo < from ? from - 1n : poolTo),
      memoScannedTo: memo ? Number(memoTo < memoFrom ? memoFrom - 1n : memoTo) : 0,
      memos: (prev?.memos ?? 0) + memos,
      startTs,
      events,
      fee: 1,
      collected,
      sw: 1,
    },
    blocksRead: poolTo >= from ? poolTo - from + 1n : 0n,
    latest,
  };
}

/* ------------------------------------------------------------------ figures */

function dailyRows(sources: ChainEvent[][], days: string[]): DayRow[] {
  const rows = new Map(days.map((d) => [d, { day: d, deposits: 0, transfers: 0, cashouts: 0, trades: 0, wallets: new Set<string>() }]));
  for (const events of sources) {
    for (const e of events) {
      if (!e.ts) continue;
      const r = rows.get(utcDay(e.ts * 1000));
      if (!r) continue;
      if (e.k === "deposit") r.deposits++;
      else if (e.k === "transfer") r.transfers++;
      else if (e.k === "cashout") r.cashouts++;
      else r.trades++;
      if (e.w) r.wallets.add(e.w);
    }
  }
  return days.map((d) => {
    const { wallets, ...rest } = rows.get(d)!;
    return { ...rest, activeWallets: wallets.size };
  });
}

/** Every UTC day from `startMs` to `now`, oldest first. */
export function daysSince(startMs: number, now = Date.now()): string[] {
  const out: string[] = [];
  const end = utcDay(now);
  for (let t = Date.parse(`${utcDay(startMs)}T00:00:00Z`); ; t += 86_400_000) {
    const d = utcDay(t);
    out.push(d);
    if (d >= end || out.length > 3660) break;
  }
  return out;
}

function recentRows(n: GloamNetwork, events: ChainEvent[]): RecentRow[] {
  return events
    .slice(-RECENT_KEEP)
    .reverse()
    .map((e) => {
      let detail = e.k === "transfer" ? "Private transfer" : "Private trade";
      if ((e.k === "deposit" || e.k === "cashout") && e.a) {
        const info = assetInfo(n, e.a);
        detail = `${fmtUnits(BigInt(e.v ?? "0"), info)} ${info.symbol}`;
      }
      return { network: n.key, kind: e.k, tx: e.tx, block: String(e.b), ts: e.ts, wallet: e.w ?? null, detail };
    });
}

/**
 * Cash-out fees, volume and transactions for one vault. On a mainnet each flow
 * is priced at the time it happened (`p`, lib/priceHistory); one with no such
 * price yet falls back to today's and is named in `atToday`. A testnet prices
 * at today's prices. Dollar stablecoins are $1 either way.
 */
function revenueOf(n: GloamNetwork, s: ScanState, prices: Prices, settings: FeeSettings | null, days: string[]): NetworkRevenue {
  const now = Math.floor(Date.now() / 1000);
  const cut = { d1: now - 86_400, d7: now - 7 * 86_400, d30: now - 30 * 86_400 };
  const zero = (): Windowed => ({ d1: 0, d7: 0, d30: 0, all: 0 });
  const add = (w: Windowed, ts: number, v: number) => {
    w.all += v;
    if (!ts) return;
    if (ts >= cut.d30) w.d30 += v;
    if (ts >= cut.d7) w.d7 += v;
    if (ts >= cut.d1) w.d1 += v;
  };
  const unit = new Map<string, number | null>();
  const unitUsd = (a: string) => {
    if (!unit.has(a)) unit.set(a, usdOf(n, a, 1, assetInfo(n, a), prices));
    return unit.get(a)!;
  };
  const unpriced = new Set<string>();
  const atToday = new Set<string>();
  /** Dollars of `raw` of the event's asset: at the time when known, else today. Null with no price at all. */
  const usdAt = (e: ChainEvent, raw: bigint): number | null => {
    const info = assetInfo(n, e.a!);
    const units = Number(formatUnits(raw, info.decimals));
    if (info.stable) return units;
    if (e.p != null) return units * e.p;
    const p = unitUsd(e.a!);
    if (p == null) {
      if (raw > 0n) unpriced.add(info.symbol);
      return null;
    }
    if (!n.testnet && raw > 0n) atToday.add(info.symbol);
    return units * p;
  };

  const fees = zero();
  const deposits = zero();
  const cashouts = zero();
  const txs = zero();
  const byDay = new Map(
    days.map((d) => [d, { day: d, feesUsd: 0, depositUsd: 0, cashoutUsd: 0, txs: 0, wallets: new Set<string>() }])
  );
  const feeRaw = new Map<string, { raw: bigint; count: number; usd: number | null }>();
  for (const e of s.events) {
    add(txs, e.ts, 1);
    const day = e.ts ? byDay.get(utcDay(e.ts * 1000)) : undefined;
    if (day) {
      day.txs++;
      if (e.w) day.wallets.add(e.w);
    }
    if (!e.a) continue;
    if (e.k === "deposit") {
      const u = usdAt(e, BigInt(e.v ?? "0")) ?? 0;
      add(deposits, e.ts, u);
      if (day) day.depositUsd += u;
    } else if (e.k === "cashout") {
      const u = usdAt(e, BigInt(e.v ?? "0")) ?? 0;
      add(cashouts, e.ts, u);
      if (day) day.cashoutUsd += u;
    }
    // A cash-out keeps its fee, and so does a private swap's leg out (`counted` makes it a trade).
    if (e.f && (e.k === "cashout" || e.k === "trade")) {
      const fu = usdAt(e, BigInt(e.f));
      add(fees, e.ts, fu ?? 0);
      if (day) day.feesUsd += fu ?? 0;
      const r = feeRaw.get(e.a) ?? { raw: 0n, count: 0, usd: 0 };
      r.raw += BigInt(e.f);
      r.count++;
      r.usd = r.usd == null || fu == null ? null : r.usd + fu;
      feeRaw.set(e.a, r);
    }
  }

  // Fees are small: shown to six decimals, stablecoins included.
  const fine = (raw: bigint, info: AssetInfo) => fmtUnits(raw, { ...info, stable: false });
  const owedMap = settings?.owed ?? new Map<string, bigint | null>();
  const keys = new Set<string>([
    ...feeRaw.keys(),
    ...[...owedMap.entries()].filter(([, v]) => v != null && v > 0n).map(([k]) => k),
    ...Object.keys(s.collected ?? {}),
  ]);
  let owedUsd = 0;
  const feeRows: FeeRow[] = [...keys].map((a) => {
    const info = assetInfo(n, a);
    const r = feeRaw.get(a);
    const owed = owedMap.get(a) ?? null;
    const p = unitUsd(a);
    const owedValue = owed == null || p == null ? null : Number(formatUnits(owed, info.decimals)) * p;
    if (owedValue) owedUsd += owedValue;
    if (p == null && owed != null && owed > 0n) unpriced.add(info.symbol);
    return {
      asset: a,
      symbol: info.symbol,
      earned: fine(r?.raw ?? 0n, info),
      earnedUsd: r ? r.usd : p == null ? null : 0,
      count: r?.count ?? 0,
      owed: owed == null ? null : fine(owed, info),
      owedUsd: owedValue,
      collected: fine(BigInt(s.collected?.[a] ?? "0"), info),
    };
  });

  return {
    feeBps: settings?.bps ?? null,
    feeRecipient: settings?.recipient ?? null,
    fees,
    feeRows,
    owedUsd,
    depositVolume: deposits,
    cashoutVolume: cashouts,
    txs,
    daily: days.map((d) => {
      const { wallets, ...rest } = byDay.get(d)!;
      return { ...rest, wallets: wallets.size };
    }),
    unpriced: [...unpriced],
    atToday: [...atToday],
  };
}

/** Exported for scripts/selftest-vault-holdings. */
export function figures(
  n: GloamNetwork,
  s: ScanState,
  holdings: Holding[] | null,
  prices: Prices,
  days: string[],
  extra: { blocksRead: bigint; latest: bigint | null; readMs: number; error: string | null },
  money: { settings: FeeSettings | null; days: string[] }
): NetworkMetrics {
  const counts = { deposit: 0, transfer: 0, cashout: 0, trade: 0 };
  const depositors = new Map<string, { deposits: number; lastTs: number }>();
  const cashoutWallets = new Set<string>();
  const flows = new Map<string, { inRaw: bigint; inCount: number; outRaw: bigint; outCount: number }>();
  let first: number | null = null;
  let last: number | null = null;

  for (const e of s.events) {
    counts[e.k]++;
    if (e.ts) {
      first = first == null ? e.ts : Math.min(first, e.ts);
      last = last == null ? e.ts : Math.max(last, e.ts);
    }
    if (e.k === "deposit" && e.w) {
      const d = depositors.get(e.w) ?? { deposits: 0, lastTs: 0 };
      d.deposits++;
      d.lastTs = Math.max(d.lastTs, e.ts);
      depositors.set(e.w, d);
    }
    if (e.k === "cashout" && e.w) cashoutWallets.add(e.w);
    if ((e.k === "deposit" || e.k === "cashout") && e.a) {
      const f = flows.get(e.a) ?? { inRaw: 0n, inCount: 0, outRaw: 0n, outCount: 0 };
      if (e.k === "deposit") {
        f.inRaw += BigInt(e.v ?? "0");
        f.inCount++;
      } else {
        f.outRaw += BigInt(e.v ?? "0");
        f.outCount++;
      }
      flows.set(e.a, f);
    }
  }

  // One row per listed asset that is held or has moved; listed order (stables first).
  const order = [
    ...(supportsNativeShield(n.chainId) ? [NATIVE] : []),
    ...holdableTokens(n.chainId).map((t) => t.address.toLowerCase()),
  ];
  for (const a of flows.keys()) if (!order.includes(a)) order.push(a);
  const heldBy = new Map((holdings ?? []).map((h) => [h.asset, h.raw]));

  let heldUsd = 0;
  const unpriced: string[] = [];
  const assets: AssetRow[] = [];
  for (const a of order) {
    const info = assetInfo(n, a);
    const raw = heldBy.has(a) ? heldBy.get(a)! : null;
    const f = flows.get(a);
    if (!f && (raw == null || raw === 0n)) continue;
    let usd: number | null = null;
    if (raw != null && raw > 0n) {
      usd = usdOf(n, a, Number(formatUnits(raw, info.decimals)), info, prices);
      if (usd == null) unpriced.push(info.symbol);
      else heldUsd += usd;
    } else if (raw === 0n) {
      usd = 0;
    }
    assets.push({
      asset: a,
      symbol: info.symbol,
      stable: info.stable,
      held: raw == null ? null : fmtUnits(raw, info),
      heldUsd: usd,
      deposited: fmtUnits(f?.inRaw ?? 0n, info),
      depositCount: f?.inCount ?? 0,
      cashedOut: fmtUnits(f?.outRaw ?? 0n, info),
      cashoutCount: f?.outCount ?? 0,
    });
  }

  const active = new Set([...depositors.keys(), ...cashoutWallets]);

  return {
    key: n.key,
    label: networkName(n),
    testnet: n.testnet,
    chainId: n.chainId,
    pool: n.pool ?? "",
    memo: n.payMemo?.address ?? null,
    deployBlock: String(n.deployBlock ?? 0n),
    scannedTo: String(s.scannedTo),
    latestBlock: extra.latest == null ? null : String(extra.latest),
    catchingUp: extra.latest != null && BigInt(s.scannedTo) < extra.latest,
    deposits: counts.deposit,
    transfers: counts.transfer,
    cashouts: counts.cashout,
    trades: counts.trade,
    memos: s.memos,
    depositors: depositors.size,
    cashoutWallets: cashoutWallets.size,
    activeWallets: active.size,
    heldUsd,
    unpriced,
    assets,
    firstActivity: first,
    lastActivity: last,
    vaultSince: s.startTs || null,
    daily: dailyRows([s.events], days),
    topDepositors: [...depositors.entries()]
      .map(([address, d]) => ({ address, ...d }))
      .sort((x, y) => y.deposits - x.deposits || y.lastTs - x.lastTs)
      .slice(0, 25),
    recent: recentRows(n, s.events),
    blocksRead: String(extra.blocksRead),
    readMs: extra.readMs,
    error: extra.error,
    revenue: revenueOf(n, s, prices, money.settings, money.days),
  };
}

function emptyState(n: GloamNetwork): ScanState {
  return { v: 1, pool: (n.pool ?? "").toLowerCase(), scannedTo: Number(n.deployBlock ?? 0n), memoScannedTo: 0, memos: 0, startTs: 0, events: [], fee: 1, sw: 1 };
}

/**
 * A private swap is one trade, not a deposit plus a cash-out: its note goes out
 * to a one-time escrow and the router puts the new note back in, in one
 * transaction, so no money enters or leaves Gloam. The leg out becomes the
 * trade (it keeps its asset, amount and the fee the vault kept on it); the leg
 * in is dropped. A router deposit with no leg out in its transaction is a trade
 * of its own.
 */
export function swapsAsTrades(events: ChainEvent[]): ChainEvent[] {
  if (!events.some((e) => e.r)) return events;
  const outTx = new Set(events.filter((e) => e.r && e.k === "cashout").map((e) => e.tx));
  const out: ChainEvent[] = [];
  for (const e of events) {
    if (!e.r) out.push(e);
    else if (e.k === "cashout") out.push({ ...e, k: "trade", w: undefined });
    else if (e.k === "deposit" && !outTx.has(e.tx)) out.push({ ...e, k: "trade", w: undefined });
  }
  return out;
}

/** Scans one network and reads its holdings. On failure keeps the last state read, with the error. */
/**
 * What a network's figures count. A mainnet counts from the public launch
 * (21 Oct 2026, 13:00 UTC), not from its deploy, so the team's own checks
 * before the doors opened stay out. Balances held are read live either way.
 */
export function counted(n: Pick<GloamNetwork, "testnet">, s: ScanState): ScanState {
  if (n.testnet) return { ...s, events: swapsAsTrades(s.events) };
  const from = Math.floor(MAINNET_LAUNCH_MS / 1000);
  // An event not dated yet (Robinhood's logs carry no time; a pass dates the
  // newest 250) counts only once it is surely after launch: at or after a block
  // already dated after it. Until then it waits, so a fresh read never counts
  // the team's checks from before launch.
  let firstAfter = Infinity;
  for (const e of s.events) if (e.ts >= from && e.b < firstAfter) firstAfter = e.b;
  return { ...s, events: swapsAsTrades(s.events.filter((e) => (e.ts ? e.ts >= from : e.b >= firstAfter))) };
}

/** The CoinGecko id that prices `asset` in the past; null for a dollar stablecoin, a euro coin, or a token with none. */
function geckoId(n: GloamNetwork, asset: string): string | null {
  if (asset === NATIVE) return n.primaryAsset.symbol === "ETH" ? "ethereum" : n.primaryAsset.symbol === "HYPE" ? "hyperliquid" : null;
  const t = holdableTokens(n.chainId).find((x) => x.address.toLowerCase() === asset);
  if (!t || t.kind === "stablecoin") return null;
  return t.coingecko ?? null;
}

/**
 * Gives each mainnet deposit and cash-out of a token that is not a dollar
 * stablecoin its USD price at the time (`p`), from CoinGecko's past prices
 * (lib/priceHistory), in place. Only flows with no settled price are looked up,
 * one series per token; one CoinGecko cannot answer for waits for the next read.
 */
export async function priceFlows(n: GloamNetwork, events: ChainEvent[], series = usdSeries): Promise<void> {
  if (n.testnet) return;
  const launch = Math.floor(MAINNET_LAUNCH_MS / 1000);
  const want = new Map<string, ChainEvent[]>();
  for (const e of events) {
    if ((e.k !== "deposit" && e.k !== "cashout") || !e.a || !e.ts || e.ts < launch) continue;
    if (e.p != null && !e.pq) continue;
    const id = geckoId(n, e.a);
    if (!id) continue;
    const list = want.get(id) ?? [];
    list.push(e);
    want.set(id, list);
  }
  await Promise.all(
    [...want].map(async ([id, list]) => {
      const from = Math.min(...list.map((e) => e.ts)) - 3 * 3_600;
      const points = await series(id, from).catch(() => null);
      if (!points) return;
      for (const e of list) {
        const q = priceAt(points, e.ts);
        if (!q) continue;
        e.p = q.usd;
        if (q.settled) delete e.pq;
        else e.pq = 1;
      }
    })
  );
}

async function readNetwork(n: GloamNetwork, days: string[], revenueDays: string[]) {
  const started = Date.now();
  const prev = await loadState(n);
  try {
    const [{ state, blocksRead, latest }, holdings, settings] = await Promise.all([
      scan(n, prev),
      readHoldings(n, n.pool as Address),
      readFeeSettings(n, n.pool as Address),
    ]);
    // Mainnet flows priced at their time; what is not priced yet is tried on the next read.
    await withTimeout(priceFlows(n, state.events), 12_000, undefined);
    await saveState(n, state);
    const readMs = Date.now() - started;
    const extra = { blocksRead, latest, readMs, error: null };
    const money = { settings, days: revenueDays };
    const view = counted(n, state);
    return { state: view, holdings, metrics: (p: Prices) => figures(n, view, holdings, p, days, extra, money) };
  } catch (e) {
    const state = counted(n, prev ?? emptyState(n));
    const msg = errText(e).split("\n")[0].slice(0, 160);
    console.warn("gloam_onchain_read", n.key, msg);
    const readMs = Date.now() - started;
    const extra = { blocksRead: 0n, latest: null, readMs, error: msg };
    const money = { settings: null, days: revenueDays };
    return { state, holdings: null, metrics: (p: Prices) => figures(n, state, null, p, days, extra, money) };
  }
}

/** Fees and volume over some networks; a wallet used on several of them counts once. */
function combineRevenue(revs: NetworkRevenue[], allEvents: ChainEvent[][], days: string[]): CombinedRevenue {
  const sumW = (f: (r: NetworkRevenue) => Windowed): Windowed => ({
    d1: revs.reduce((a, r) => a + f(r).d1, 0),
    d7: revs.reduce((a, r) => a + f(r).d7, 0),
    d30: revs.reduce((a, r) => a + f(r).d30, 0),
    all: revs.reduce((a, r) => a + f(r).all, 0),
  });
  const now = Math.floor(Date.now() / 1000);
  const seen = { d1: new Set<string>(), d7: new Set<string>(), d30: new Set<string>(), all: new Set<string>() };
  const perDay = new Map(days.map((d) => [d, new Set<string>()]));
  for (const events of allEvents) {
    for (const e of events) {
      if (!e.w) continue;
      seen.all.add(e.w);
      if (!e.ts) continue;
      if (e.ts >= now - 30 * 86_400) seen.d30.add(e.w);
      if (e.ts >= now - 7 * 86_400) seen.d7.add(e.w);
      if (e.ts >= now - 86_400) seen.d1.add(e.w);
      perDay.get(utcDay(e.ts * 1000))?.add(e.w);
    }
  }
  return {
    fees: sumW((r) => r.fees),
    unpriced: [...new Set(revs.flatMap((r) => r.unpriced ?? []))],
    atToday: [...new Set(revs.flatMap((r) => r.atToday ?? []))],
    owedUsd: revs.reduce((a, r) => a + r.owedUsd, 0),
    depositVolume: sumW((r) => r.depositVolume),
    cashoutVolume: sumW((r) => r.cashoutVolume),
    txs: sumW((r) => r.txs),
    users: { d1: seen.d1.size, d7: seen.d7.size, d30: seen.d30.size, all: seen.all.size },
    daily: days.map((day) => {
      const rows = revs.map((r) => r.daily.find((x) => x.day === day));
      const sum = (f: (x: RevenueDay) => number) => rows.reduce((a, x) => a + (x ? f(x) : 0), 0);
      return {
        day,
        feesUsd: sum((x) => x.feesUsd),
        depositUsd: sum((x) => x.depositUsd),
        cashoutUsd: sum((x) => x.cashoutUsd),
        txs: sum((x) => x.txs),
        wallets: perDay.get(day)?.size ?? 0,
      };
    }),
  };
}

/** Totals over some networks; a wallet used on several of them counts once. */
function combine(networks: NetworkMetrics[], allEvents: ChainEvent[][], days: string[], revenueDays: string[]): CombinedMetrics {
  const depositors = new Set<string>();
  const active = new Set<string>();
  for (const events of allEvents) {
    for (const e of events) {
      if (!e.w) continue;
      active.add(e.w);
      if (e.k === "deposit") depositors.add(e.w);
    }
  }
  const sum = (f: (m: NetworkMetrics) => number) => networks.reduce((a, m) => a + f(m), 0);
  const firsts = networks.map((m) => m.firstActivity).filter((x): x is number => x != null);
  const lasts = networks.map((m) => m.lastActivity).filter((x): x is number => x != null);
  return {
    deposits: sum((m) => m.deposits),
    transfers: sum((m) => m.transfers),
    cashouts: sum((m) => m.cashouts),
    trades: sum((m) => m.trades),
    memos: sum((m) => m.memos),
    depositors: depositors.size,
    activeWallets: active.size,
    heldUsd: sum((m) => m.heldUsd),
    unpriced: networks.flatMap((m) => m.unpriced.map((s) => `${s} (${m.label})`)),
    firstActivity: firsts.length ? Math.min(...firsts) : null,
    lastActivity: lasts.length ? Math.max(...lasts) : null,
    daily: dailyRows(allEvents, days),
    revenue: networks.every((m) => m.revenue)
      ? combineRevenue(networks.map((m) => m.revenue!), allEvents, revenueDays)
      : undefined,
  };
}

async function readAll(): Promise<OnchainMetrics> {
  const days = lastDays(DAILY_WINDOW);
  const revenueDays = lastDays(REVENUE_DAYS);
  const nets = NETWORK_KEYS.map(getNetwork).filter((n) => n.status === "live" && n.pool && n.deployBlock != null);
  const pricing = loadPrices();
  // $GLOAM creator fees live on Robinhood Chain mainnet; read beside the vaults once it is live.
  const creatorRead = nets.some((n) => n.key === "robinhood-mainnet")
    ? readCreatorFees(
        revenueDays,
        () => pricing.then((p) => p.ethUsd),
        // each day's creator fees at that day's ETH price, not today's
        async () => {
          const pts = await usdSeries("ethereum", Math.floor(Date.parse(`${revenueDays[0]}T00:00:00Z`) / 1000));
          return pts ? dailyMeans(pts) : null;
        }
      ).catch((e: unknown) => {
        console.warn("gloam_creator_fees", errText(e).split("\n")[0].slice(0, 160));
        return { error: "Could not read creator fees. The details are in the server logs." };
      })
    : Promise.resolve(undefined);
  const reads = await Promise.all(nets.map((n) => readNetwork(n, days, revenueDays)));
  // People counts (lib/peopleStore): the public depositor and cash-out wallets, one-way. Never holds up the figures.
  await withTimeout(
    addChainPeople(
      nets.map((n, i) => ({
        network: n.key,
        pool: n.pool ?? "",
        testnet: n.testnet,
        wallets: reads[i]!.state.events.flatMap((e) =>
          e.w && (e.k === "deposit" || e.k === "cashout") ? [{ kind: e.k, wallet: e.w, ts: e.ts, block: e.b }] : []
        ),
      }))
    ).catch((e: unknown) => console.warn("gloam_people_chain", errText(e).split("\n")[0].slice(0, 120))),
    5_000,
    undefined
  );
  const prices = await pricing;
  const networks = reads.map((r) => r.metrics(prices));
  const creator = await creatorRead;

  const all = combine(networks, reads.map((r) => r.state.events), days, revenueDays);
  const part = (testnet: boolean) => {
    const keep = networks.map((m) => m.testnet === testnet);
    return combine(
      networks.filter((_, i) => keep[i]),
      reads.filter((_, i) => keep[i]).map((r) => r.state.events),
      days,
      revenueDays
    );
  };

  return {
    asOf: new Date().toISOString(),
    source: "fresh",
    ageSec: 0,
    prices: { ethUsd: prices.ethUsd, stocks: prices.stocks, flowsAtTime: true },
    networks,
    combined: all,
    mainnet: {
      ...part(false),
      sinceLaunch: dailyRows(
        reads.filter((_, i) => !networks[i]!.testnet).map((r) => r.state.events),
        daysSince(MAINNET_LAUNCH_MS)
      ),
    },
    testnet: part(true),
    ...(creator ? { creator } : {}),
    recent: networks
      .flatMap((m) => m.recent)
      .sort((a, b) => b.ts - a.ts || Number(b.block) - Number(a.block))
      .slice(0, RECENT_KEEP),
  };
}

/* ------------------------------------------------------------------ cache */

let snapshot: { at: number; data: OnchainMetrics } | null = null;
let inflight: Promise<OnchainMetrics> | null = null;

function aged(data: OnchainMetrics, source: OnchainMetrics["source"], at: number): OnchainMetrics {
  return { ...data, source, ageSec: Math.max(0, Math.round((Date.now() - at) / 1000)) };
}

/**
 * The last snapshot read, however old (memory, then Redis, which keeps one for
 * an hour), or null. Never reads a chain: for a page that must render fast, or
 * at build time, and says how old the figures are.
 */
export async function lastOnchainSnapshot(): Promise<OnchainMetrics | null> {
  if (snapshot) return aged(snapshot.data, "memory", snapshot.at);
  const r = await cacheGetJson<{ at: number; data: OnchainMetrics }>(SNAPSHOT_KEY);
  if (!r?.data) return null;
  return aged(r.data, "redis", r.at);
}

/**
 * Both networks' on-chain figures. Served from a snapshot under a minute old
 * (memory, then Redis) unless `force`; a forced read still waits 15s since the
 * last one. Concurrent callers share one read.
 */
export async function fetchOnchainMetrics(opts: { force?: boolean } = {}): Promise<OnchainMetrics> {
  const now = Date.now();
  if (snapshot) {
    const age = now - snapshot.at;
    if (age < (opts.force ? FORCE_MIN_GAP_MS : SNAPSHOT_FRESH_MS)) return aged(snapshot.data, "memory", snapshot.at);
  }
  if (!opts.force) {
    const r = await cacheGetJson<{ at: number; data: OnchainMetrics }>(SNAPSHOT_KEY);
    if (r?.data && now - r.at < SNAPSHOT_FRESH_MS) {
      snapshot = r;
      return aged(r.data, "redis", r.at);
    }
  }
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const data = await readAll();
      const at = Date.now();
      snapshot = { at, data };
      await cacheSetJson(SNAPSHOT_KEY, snapshot, 3_600);
      return data;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}
