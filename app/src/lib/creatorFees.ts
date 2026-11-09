/**
 * $GLOAM creator fees, read from the Orynth fee vault on Robinhood Chain. Server only.
 *
 * Every $GLOAM trade on Orynth pays the creator 1% of its ETH side. The vault
 * logs each share (topic 0xa9ecb067…) and each claim (0xc1d27057…) with the
 * token's id as topic 1 and the creator's wallet as topic 2; the first data
 * word is the ETH amount. The vault serves many tokens, so logs are read by
 * address (Robinhood takes millions of blocks per address-only query) and
 * filtered here.
 *
 * Robinhood leaves block timestamps off logs, so amounts are kept in buckets of
 * BUCKET blocks and placed in time through the block at each UTC midnight,
 * found by interpolating on the chain's steady block rate and checked against
 * real block times. Reads are incremental: what was read is kept in memory,
 * then Redis, and a refresh reads only the blocks since.
 */

import { createPublicClient, formatEther, type Log, type PublicClient } from "viem";
import { getNetwork } from "./networks";
import type { Windowed } from "./onchainMetrics";
import { cacheGetJson, cacheSetJson, utcDay } from "./tractionStore";
import { serverTransport } from "./serverRpc";
import { MAINNET_LAUNCH_MS } from "./mainnet";
import { getLogsSafe } from "./logRange";

const VAULT = "0x953391a2ddf7e8437feb878fdf2c6f325fbf00cc";
/** $GLOAM's id in the vault. */
const TOKEN_ID = "0xc5f373710186d788eee3048f9ff92608d344e3360b2a35bea98068146e18dd1a";
/** The creator wallet, which is also the vaults' fee recipient. */
const CREATOR = "0x76b7e410a227c888abd2bdc24ee32e094b0fd4d8";
const CREATOR_TOPIC = `0x${"0".repeat(24)}${CREATOR.slice(2)}`;
const EARNED = "0xa9ecb067d5cd2de9bad7cacafdcf5bf98173060a21ef104fdc27e901cd476998";
const CLAIMED = "0xc1d27057937a5216efd7c1ee2b680a2a34893e3f35e3a33f70c4bf0935312664";
/** The block $GLOAM launched in. */
const START = 39_918_259;

const SPAN = 5_000_000n;
const MAX_SPANS_PER_PASS = 12;
const BUCKET = 1_000;
/** Buckets older than this many days are folded away; all-time totals stay. */
const KEEP_DAYS = 33;
const STATE_KEY = "gloam:creatorfees:v1";
const MIDNIGHTS_KEY = "gloam:rh:midnights:v1";
const TTL_SEC = 30 * 86_400;

export type CreatorFees = {
  token: string;
  vault: string;
  creator: string;
  /** ETH the creator earned over the last 24 hours, 7 days, 30 days and all time. */
  earnedEth: Windowed;
  /** The same at today's ETH price; null when ETH is not priced. */
  earnedUsd: Windowed | null;
  /** ETH earned since Gloam mainnet opened (21 Oct 2026, 13:00 UTC), and its dollars now. */
  sinceLaunchEth: number;
  sinceLaunchUsd: number | null;
  claimedEth: number;
  /** Earned and not yet claimed. */
  unclaimedEth: number;
  /** Trades that paid the creator a share. */
  trades: number;
  /** ETH earned per UTC day, oldest first; `usd` at that day's ETH price (its mean so far today), else today's. */
  daily: { day: string; eth: number; usd: number | null }[];
  scannedTo: string;
  latestBlock: string | null;
  catchingUp: boolean;
  error: string | null;
};

type State = {
  v: 1;
  scannedTo: number;
  earned: string;
  claimed: string;
  trades: number;
  /** [first block of the bucket, wei earned in it], oldest first. */
  buckets: [number, string][];
};

let memory: State | null = null;
let midnights: Record<string, number> | null = null;
let client: PublicClient | null = null;

function rh(): PublicClient {
  if (client) return client;
  const n = getNetwork("robinhood-mainnet");
  client = createPublicClient({ chain: n.chain, ccipRead: false, transport: serverTransport(n, { timeout: 20_000, retryCount: 4, retryDelay: 500 }) });
  return client;
}

async function loadState(): Promise<State> {
  if (memory) return memory;
  const r = await cacheGetJson<State>(STATE_KEY);
  if (r && r.v === 1 && Array.isArray(r.buckets)) return (memory = r);
  return { v: 1, scannedTo: START - 1, earned: "0", claimed: "0", trades: 0, buckets: [] };
}

const word0 = (l: Log) => BigInt(`0x${(l.data ?? "0x").slice(2, 66) || "0"}`);
const ours = (l: Log) => l.topics[1]?.toLowerCase() === TOKEN_ID && l.topics[2]?.toLowerCase() === CREATOR_TOPIC;

/** Reads the blocks since the last pass, up to MAX_SPANS_PER_PASS spans. */
async function scan(prev: State, head: number): Promise<State> {
  const c = rh();
  const from = BigInt(prev.scannedTo + 1);
  const last = BigInt(Math.min(head, prev.scannedTo + Number(SPAN) * MAX_SPANS_PER_PASS));
  if (from > last) return prev;
  const spans: [bigint, bigint][] = [];
  for (let a = from; a <= last; a += SPAN) spans.push([a, a + SPAN - 1n > last ? last : a + SPAN - 1n]);
  // Two at a time keeps Robinhood's public RPC from answering 429.
  const logs: Log[] = [];
  for (let i = 0; i < spans.length; i += 2) {
    const part = await Promise.all(
      // A span holding more than 10,000 vault logs is refused by the RPC: it is halved until it fits.
      spans.slice(i, i + 2).map(([a, b]) => getLogsSafe((x, y) => c.getLogs({ address: VAULT, fromBlock: x, toBlock: y }), a, b))
    );
    logs.push(...part.flat());
  }
  const buckets = new Map(prev.buckets);
  let earned = BigInt(prev.earned);
  let claimed = BigInt(prev.claimed);
  let trades = prev.trades;
  for (const l of logs) {
    if (!ours(l)) continue;
    const t0 = l.topics[0]?.toLowerCase();
    if (t0 === EARNED) {
      const wei = word0(l);
      earned += wei;
      trades++;
      const b = Math.floor(Number(l.blockNumber ?? 0n) / BUCKET) * BUCKET;
      buckets.set(b, String(BigInt(buckets.get(b) ?? "0") + wei));
    } else if (t0 === CLAIMED) {
      claimed += word0(l);
    }
  }
  return {
    v: 1,
    scannedTo: Number(last),
    earned: String(earned),
    claimed: String(claimed),
    trades,
    buckets: [...buckets.entries()].sort((x, y) => x[0] - y[0]),
  };
}

/* ------------------------------------------------------------ block times */

/** The first block at or after `ts` (Unix seconds), to within about a minute. */
async function blockAt(ts: number, head: { b: number; t: number }): Promise<number> {
  const c = rh();
  if (ts >= head.t) return head.b;
  let lo = { b: START, t: 0 };
  let hi = head;
  // A guess from the chain's average rate, then refined against real block times.
  let guess = head.b - Math.round((head.t - ts) * 10);
  for (let i = 0; i < 12; i++) {
    guess = Math.min(Math.max(guess, lo.b + 1), hi.b - 1);
    if (hi.b - lo.b <= 2) break;
    const t = Number((await c.getBlock({ blockNumber: BigInt(guess) })).timestamp);
    if (Math.abs(t - ts) <= 60) return guess;
    if (t < ts) lo = { b: guess, t };
    else hi = { b: guess, t };
    if (lo.t === 0) {
      guess = guess - Math.round((t - ts) * 10);
      continue;
    }
    guess = lo.b + Math.round(((ts - lo.t) * (hi.b - lo.b)) / Math.max(1, hi.t - lo.t));
  }
  return hi.b;
}

/** The block at each day's UTC midnight; past days are kept, since they never change. */
async function midnightBlocks(days: string[], head: { b: number; t: number }): Promise<Record<string, number>> {
  if (!midnights) midnights = (await cacheGetJson<Record<string, number>>(MIDNIGHTS_KEY)) ?? {};
  const known = midnights;
  const out: Record<string, number> = {};
  const missing = days.filter((d) => {
    if (known[d] == null) return true;
    out[d] = known[d]!;
    return false;
  });
  // Four searches at a time; every day asked for has already reached its midnight.
  for (let i = 0; i < missing.length; i += 4) {
    await Promise.all(
      missing.slice(i, i + 4).map(async (d) => {
        const b = await blockAt(Date.parse(`${d}T00:00:00Z`) / 1000, head);
        out[d] = b;
        known[d] = b;
      })
    );
  }
  if (missing.length) await cacheSetJson(MIDNIGHTS_KEY, known, TTL_SEC);
  return out;
}

/* ------------------------------------------------------------ figures */

const eth = (wei: bigint) => Number(formatEther(wei));

/**
 * Creator fees for `days` (UTC days, oldest first). The totals are priced with
 * `ethUsd` (today's price, labelled "now" on /admin); each day's row with that
 * day's ETH price from `dayEthUsd` when it has one, else today's.
 * On a failed read the last figures read come back with the error.
 */
export async function readCreatorFees(
  days: string[],
  ethUsd: () => Promise<number | null>,
  dayEthUsd?: () => Promise<Map<string, number> | null>
): Promise<CreatorFees> {
  const prev = await loadState();
  let state = prev;
  let latest: number | null = null;
  let error: string | null = null;
  let windows = { d1: 0, d7: 0, d30: 0 };
  let sinceLaunch = 0;
  let byDay = new Map<string, bigint>();
  try {
    const c = rh();
    const headBlock = await c.getBlock();
    const head = { b: Number(headBlock.number), t: Number(headBlock.timestamp) };
    latest = head.b;
    state = await scan(prev, head.b);

    // Day edges for the rows, plus a few days back for the 30-day window and the fold.
    const first = Date.parse(`${days[0]}T00:00:00Z`);
    const edges = [...Array(KEEP_DAYS - days.length + 1).keys()]
      .reverse()
      .map((i) => utcDay(first - (i + 1) * 86_400_000))
      .concat(days);
    const mid = await midnightBlocks(edges, head);
    const now = Math.floor(Date.now() / 1000);
    const [b1, b7, b30, bLaunch] = await Promise.all([
      blockAt(now - 86_400, head),
      blockAt(now - 7 * 86_400, head),
      blockAt(now - 30 * 86_400, head),
      blockAt(Math.floor(MAINNET_LAUNCH_MS / 1000), head),
    ]);

    // Fold buckets older than the oldest edge; the totals already hold them.
    const keepFrom = mid[edges[0]!] ?? 0;
    state = { ...state, buckets: state.buckets.filter(([b]) => b + BUCKET > keepFrom) };
    memory = state;
    await cacheSetJson(STATE_KEY, state, TTL_SEC);

    const w = { d1: 0n, d7: 0n, d30: 0n };
    let launched = 0n;
    byDay = new Map(days.map((d) => [d, 0n]));
    for (const [b, v] of state.buckets) {
      const wei = BigInt(v);
      if (b + BUCKET > b1) w.d1 += wei;
      if (b + BUCKET > b7) w.d7 += wei;
      if (b + BUCKET > b30) w.d30 += wei;
      if (b + BUCKET / 2 >= bLaunch) launched += wei;
      for (let i = 0; i < days.length; i++) {
        const start = mid[days[i]!]!;
        const end = i + 1 < days.length ? mid[days[i + 1]!]! : Number.MAX_SAFE_INTEGER;
        if (b >= start - BUCKET / 2 && b < end - BUCKET / 2) {
          byDay.set(days[i]!, byDay.get(days[i]!)! + wei);
          break;
        }
      }
    }
    windows = { d1: eth(w.d1), d7: eth(w.d7), d30: eth(w.d30) };
    sinceLaunch = eth(launched);
  } catch (e) {
    error = (e instanceof Error ? e.message : String(e)).split("\n")[0]!.slice(0, 160);
    console.warn("gloam_creator_fees", error);
  }

  const [price, dayPrices] = await Promise.all([
    ethUsd().catch(() => null),
    dayEthUsd ? dayEthUsd().catch(() => null) : Promise.resolve(null),
  ]);
  const earnedAll = eth(BigInt(state.earned));
  const claimedAll = eth(BigInt(state.claimed));
  const earnedEth = { ...windows, all: earnedAll };
  return {
    token: "$GLOAM",
    vault: VAULT,
    creator: CREATOR,
    earnedEth,
    earnedUsd:
      price == null
        ? null
        : { d1: earnedEth.d1 * price, d7: earnedEth.d7 * price, d30: earnedEth.d30 * price, all: earnedEth.all * price },
    sinceLaunchEth: sinceLaunch,
    sinceLaunchUsd: price == null ? null : sinceLaunch * price,
    claimedEth: claimedAll,
    unclaimedEth: Math.max(0, earnedAll - claimedAll),
    trades: state.trades,
    daily: days.map((d) => {
      const v = eth(byDay.get(d) ?? 0n);
      const p = dayPrices?.get(d) ?? price;
      return { day: d, eth: v, usd: p == null ? null : v * p };
    }),
    scannedTo: String(state.scannedTo),
    latestBlock: latest == null ? null : String(latest),
    catchingUp: latest != null && state.scannedTo < latest,
    error,
  };
}
