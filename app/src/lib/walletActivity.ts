/**
 * A wallet's public activity on a mainnet, read straight from the chain. The
 * mainnet explorers have no account API Gloam can use (Robinhood Chain's
 * refuses the connection, Tempo has none), so Holdings reads it here instead:
 * every Transfer of the network's listed tokens from or to the wallet.
 * Deposits and cash-outs show up as transfers to and from the vault, which is
 * all the explorer shows of them too.
 *
 * Runs in the browser against the chain's public RPC, the same one the app
 * already reads balances from. Where that is the chain's only public RPC
 * (Robinhood Chain, Tempo, Elysium), or keeps little history (BNB Chain), and it fails for this browser (a blocked
 * host, a refused IP), the reads go through gloam.trade's own RPC proxy instead
 * (lib/rpcProxy), which passes them on and logs neither the requests nor the
 * address. The address goes nowhere else, and never in a URL.
 *
 * The first read covers a recent window only (ACTIVITY_WINDOW_DAYS back from
 * the head), newest blocks first, and hands rows over as each span comes back
 * (`onProgress`), so the card fills from the top instead of waiting for the
 * whole history. Reading every block since the deploy took minutes on a phone
 * on BNB Chain (850,000 blocks, its old logs through the proxy) and the card sat
 * on its skeleton. Older history is read only when asked (widenWalletActivity,
 * the card's "Show older"). A call answers after ACTIVITY_PASS_MS at the latest
 * with what is read so far, while the read goes on behind it; what was read is
 * cached for the tab (memory and sessionStorage), so the next read takes only
 * the blocks not read yet: new ones at the head, then the rest of the window.
 *
 * Where the vault lists the native coin (ETH on Base), deposits and cash-outs
 * of it leave no Transfer log, so they are read from the vault's own Shielded
 * and Unshielded events for this wallet, a cash-out net of the vault's fee
 * (what the wallet received, like a token's Transfer).
 *
 * Not here: plain native-coin transfers between wallets (they leave no log)
 * and private transfers, which carry no address by design.
 */

import { parseAbiItem, zeroAddress, type Address, type PublicClient } from "viem";
import { clientFor, gated, getLogsSafe, headLag, logSpan } from "@/components/transparency/ledger";
import type { ActivityTx } from "@/hooks/useActivity";
import { FEE_MANAGER } from "./feeSponsor";
import { getNetwork, type NetworkKey } from "./networks";
import { shieldTokensFor, supportsNativeShield } from "./tokens";

const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const SHIELDED = parseAbiItem(
  "event Shielded(bytes32 indexed commitment, address indexed asset, uint256 amount, uint256 leafIndex, address indexed from)"
);
const UNSHIELDED = parseAbiItem("event Unshielded(bytes32 indexed nullifier, address indexed asset, address indexed to, uint256 amount)");
const WITHDRAW_FEE = parseAbiItem("event WithdrawFee(bytes32 indexed nullifier, address indexed asset, uint256 fee)");
const VAULT_EVENTS = [SHIELDED, UNSHIELDED, WITHDRAW_FEE] as const;

/** The first read's window, in days back from the head. "Show older" adds as many again. */
export const ACTIVITY_WINDOW_DAYS = 7;
/**
 * A shorter window where a log read costs its whole range: BNB Chain's public
 * log RPC reads every block it is asked about (about 0.2 ms a block, so 3 s for
 * 10,000 blocks however few logs match), and a week is 1.3 million blocks,
 * minutes of reading. A day is about 190,000.
 */
const WINDOW_DAYS: Record<number, number> = { 56: 1 };

/** Days the first read covers on a chain, and each Show older adds. */
export function activityWindowDays(chainId: number): number {
  return WINDOW_DAYS[chainId] ?? ACTIVITY_WINDOW_DAYS;
}
/**
 * How long a call waits for the read before it answers with what there is.
 * The read itself goes on, so the next call picks up from there; a call that
 * finds nothing read by then fails, and the card offers Retry.
 */
export const ACTIVITY_PASS_MS = 20_000;
/** Spans read at once, newest first. Each is a few getLogs; the chain's gate caps the calls in flight. */
const SPANS_AT_ONCE = 3;
/** Blocks compared to measure a chain's pace on the first read. */
const PACE_SAMPLE = 10_000n;
/**
 * Blocks a day, used only when the head's block times cannot be read
 * (measured 23 Nov 2026; Base makes a block every 0.2 s now, not 2 s).
 */
const BLOCKS_PER_DAY: Record<number, number> = {
  4663: 820_000,
  46630: 820_000,
  4217: 160_000,
  42431: 160_000,
  8453: 432_000,
  84532: 432_000,
  1: 7_200,
  11155111: 7_200,
  56: 192_000,
  99901: 864_000,
  99801: 864_000,
};

/**
 * Blocks left for the next read at the head, where the transparency ledger's
 * HEAD_LAG is too few: BNB Chain's publicnode balances across nodes that trail
 * by more than 20 blocks at times and refuse a range "beyond current head"
 * (seen 23 Nov 2026). 100 blocks is about 45 s.
 */
const ACTIVITY_HEAD_LAG: Record<number, bigint> = { 56: 100n };

/** Blocks a read leaves at the head of a chain for the next one. */
export function activityHeadLag(chainId: number): bigint {
  return ACTIVITY_HEAD_LAG[chainId] ?? headLag(chainId);
}

/** Rows kept per wallet, newest first; the feed pages through them five at a time. */
const KEEP = 200;
// v5: a copy records the blocks it has read (from, to) and the window asked for;
// a v4 copy (read from the deploy block, to the head) is not read
const CACHE_PREFIX = "gloam_wallet_activity_v5";
/**
 * Robinhood's RPC takes millions of blocks for one token and one address, but
 * only 100k when several token addresses share a query; Tempo caps every query
 * at 100k either way, so there one query covers all its tokens.
 */
const ONE_TOKEN_PER_QUERY = new Set([4663, 46630]);

type Row = ActivityTx & { block: string; logIndex: number };
type Cached = {
  /** Every block from `from` to `to` is read; from > to while none is. */
  from: string;
  to: string;
  /** The lowest block asked for: the window's start, lowered by Show older, never below the deploy block. */
  target: string;
  /** Days the window spans: 7, then 14 after Show older, and so on (BNB Chain: 1, 2, ...). */
  days: number;
  /** The chain's blocks a day, measured on the first read. */
  perDay: string;
  rows: Row[];
};

/** How far back the list goes, for the card's copy and its Show older. */
export type ActivityScope = {
  /** Days back from the head the read covers once done. */
  days: number;
  /** Every block since the vault went live is read: nothing older to show. */
  complete: boolean;
  /** Blocks of the window are still unread; the next pass goes on. */
  reading: boolean;
  /** Share of the window read, 0 to 1. */
  progress: number;
  /** The last pass hit a read that failed, or ran out of time without reading a span. */
  stalled: boolean;
};

export type ActivityRead = { txs: ActivityTx[]; scope?: ActivityScope };

/** Not activity: burns, and Tempo's network fees, which go to its fee manager. */
const NOT_ACTIVITY = new Set([zeroAddress, FEE_MANAGER.toLowerCase()]);

const memory = new Map<string, Cached>();

function cacheKey(key: NetworkKey, pool: string, address: string) {
  return `${CACHE_PREFIX}:${key}:${pool.toLowerCase()}:${address.toLowerCase()}`;
}

function loadCached(k: string): Cached | null {
  const m = memory.get(k);
  if (m) return m;
  try {
    const raw = window.sessionStorage.getItem(k);
    if (!raw) return null;
    const c = JSON.parse(raw) as Cached;
    if (!c || typeof c.from !== "string" || typeof c.to !== "string" || typeof c.target !== "string" || !Array.isArray(c.rows)) return null;
    BigInt(c.from);
    BigInt(c.to);
    BigInt(c.target);
    BigInt(c.perDay);
    memory.set(k, c);
    return c;
  } catch {
    return null;
  }
}

function saveCached(k: string, c: Cached) {
  memory.set(k, c);
  try {
    window.sessionStorage.setItem(k, JSON.stringify(c));
  } catch {
    /* storage full or blocked: memory still has it */
  }
}

/** The reads this needs from a chain (a test passes its own). */
type ActivityClient = Pick<PublicClient, "getBlockNumber" | "getLogs" | "getBlock">;

export type ReadOptions = {
  /** Called with the list so far each time a span adds to it, newest first. */
  onProgress?: (r: ActivityRead) => void;
  /** How long this call waits before it answers with what there is, ms (ACTIVITY_PASS_MS). */
  passMs?: number;
};

/** One read of a wallet's window: it runs to the end on its own, however many calls wait on it. */
type Job = {
  /** Settles when every span is read, or a read failed. */
  done: Promise<ActivityRead>;
  /** The list as read so far; null while nothing is. */
  current: () => ActivityRead | null;
  listeners: Set<(r: ActivityRead) => void>;
};

const jobs = new Map<string, Job>();

/**
 * The wallet's token transfers on a mainnet, newest first. Concurrent callers
 * share one read; each answers when it is done or after `passMs` with the list
 * so far (scope.reading), and the read goes on behind it.
 */
export function readWalletActivity(
  key: NetworkKey,
  address: Address,
  client?: ActivityClient,
  opts: ReadOptions = {}
): Promise<ActivityRead> {
  const n = getNetwork(key);
  if (!n.pool || n.deployBlock == null) return Promise.resolve({ txs: [] });
  const k = cacheKey(key, n.pool, address);
  let job = jobs.get(k);
  if (!job) {
    const started = startJob(key, address, k, client ?? clientFor(n, { proxyFallback: true }));
    started.done.then(
      () => jobs.delete(k),
      () => jobs.delete(k)
    );
    jobs.set(k, started);
    job = started;
  }
  const listener = opts.onProgress;
  if (listener) {
    job.listeners.add(listener);
    const now = job.current();
    if (now) listener(now);
  }
  const running = job;
  let t: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<ActivityRead>((resolve, reject) => {
    t = setTimeout(() => {
      const now = running.current();
      // nothing read in time: an error the card can retry (the read goes on)
      if (!now) reject(new Error("activity_timeout"));
      else resolve(now.scope ? { ...now, scope: { ...now.scope, reading: true } } : now);
    }, Math.max(0, opts.passMs ?? ACTIVITY_PASS_MS));
  });
  return Promise.race([running.done, late]).finally(() => {
    clearTimeout(t);
    if (listener) running.listeners.delete(listener);
  });
}

/**
 * Show older: the window reaches another activityWindowDays back (to the
 * deploy block at most). The caller reads again; false when there is nothing older.
 */
export function widenWalletActivity(key: NetworkKey, address: Address): boolean {
  const n = getNetwork(key);
  if (!n.pool || n.deployBlock == null) return false;
  const k = cacheKey(key, n.pool, address);
  const c = loadCached(k);
  if (!c || BigInt(c.target) <= n.deployBlock) return false;
  const days = activityWindowDays(n.chainId);
  const next = BigInt(c.target) - BigInt(c.perDay) * BigInt(days);
  saveCached(k, { ...c, target: String(next < n.deployBlock ? n.deployBlock : next), days: c.days + days });
  return true;
}

/** What the card shows for a read: rows, still reading, an error, or one of two empty states. */
export type ActivityView = "list" | "reading" | "error" | "empty-window" | "empty";

export function activityView(q: { isLoading: boolean; isError: boolean; data?: ActivityRead }): ActivityView {
  if (q.data && q.data.txs.length > 0) return "list";
  const scope = q.data?.scope;
  if (q.isLoading || (!q.isError && scope?.reading && !scope.stalled)) return "reading";
  if (q.isError || !q.data || scope?.stalled) return "error";
  return scope && !scope.complete ? "empty-window" : "empty";
}

/** When to read again: at once while a window is still being read, else every 30 s. */
export function activityRefetchMs(state: { status: string; data?: ActivityRead }): number {
  const s = state.data?.scope;
  return state.status !== "error" && s?.reading && !s.stalled ? 1_000 : 30_000;
}

/** Spans of at most `step` blocks from `to` down to `from`, newest first. */
function rangesDown(from: bigint, to: bigint, step: bigint): [bigint, bigint][] {
  const out: [bigint, bigint][] = [];
  for (let end = to; end >= from; end -= step) out.push([end - step + 1n > from ? end - step + 1n : from, end]);
  return out;
}

/** Rejects with `activity_timeout` once `ms` have passed. */
function within<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      t = setTimeout(() => reject(new Error("activity_timeout")), Math.max(0, ms));
    }),
  ]).finally(() => clearTimeout(t));
}

function sortRows(rows: Row[]): Row[] {
  // A transfer to the wallet itself matches both sides; keep one of each log.
  const seen = new Set<string>();
  return rows
    .filter((r) => {
      const id = r.id ?? r.hash;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    })
    .sort((a, b) => Number(BigInt(b.block) - BigInt(a.block)) || b.logIndex - a.logIndex)
    .slice(0, KEEP);
}

function startJob(key: NetworkKey, address: Address, k: string, c: ActivityClient): Job {
  const listeners = new Set<(r: ActivityRead) => void>();
  let current: ActivityRead | null = null;
  const cached = loadCached(k);
  if (cached && (cached.rows.length > 0 || BigInt(cached.from) <= BigInt(cached.to))) {
    // what an earlier read left, until this one adds to it (a refresh of the head does not count as reading)
    const [from, to, target] = [BigInt(cached.from), BigInt(cached.to), BigInt(cached.target)];
    const any = from <= to;
    const total = to - target + 1n;
    current = {
      txs: cached.rows,
      scope: {
        days: cached.days,
        complete: any && from <= getNetwork(key).deployBlock!,
        reading: !any || from > target,
        progress: any && total > 0n ? Math.min(1, Number(((to - from + 1n) * 1000n) / total) / 1000) : 0,
        stalled: false,
      },
    };
  }
  const emit = (r: ActivityRead) => {
    current = r;
    for (const l of listeners) l(r);
  };
  const done = runJob(key, address, k, c, emit);
  return { done, current: () => current, listeners };
}

async function runJob(key: NetworkKey, address: Address, k: string, c: ActivityClient, emit: (r: ActivityRead) => void): Promise<ActivityRead> {
  const n = getNetwork(key);
  const id = n.chainId;
  const deploy = n.deployBlock!;
  const call = <T,>(fn: () => Promise<T>) => gated(id, fn);
  const windowDays = activityWindowDays(id);

  const latest = await call(() => c.getBlockNumber());
  // A balanced RPC can answer from a node a few blocks behind the head, and
  // refuses ("beyond current head") or answers empty for blocks it lacks:
  // the last few blocks are left for the next read.
  const lag = activityHeadLag(id);
  const top = latest > lag ? latest - lag : latest;

  let prev = loadCached(k);
  // away longer than the window (one tab, days later): start again at the head
  if (prev && top - BigInt(prev.to) > BigInt(prev.perDay) * BigInt(windowDays)) prev = null;
  if (!prev) {
    const perDay = await blocksPerDay(id, c, latest, call);
    const start = top - perDay * BigInt(windowDays) + 1n;
    prev = {
      from: String(top + 1n),
      to: String(top),
      target: String(start > deploy ? start : deploy),
      days: windowDays,
      perDay: String(perDay),
      rows: [],
    };
  }
  const base = prev;
  const lo0 = BigInt(base.from);
  const hi0 = BigInt(base.to);
  const span = logSpan(n);
  // new blocks at the head first, then the window's unread rest, newest first
  const head = top > hi0 ? rangesDown(hi0 + 1n, top, span) : [];
  const older = lo0 - 1n >= BigInt(base.target) ? rangesDown(BigInt(base.target), lo0 - 1n, span) : [];
  const spans = [...head, ...older];
  const done: (Row[] | undefined)[] = new Array(spans.length);

  let state: Cached = base;
  const result = (stalled: boolean): ActivityRead => {
    const lo = BigInt(state.from);
    const hi = BigInt(state.to);
    const target = BigInt(state.target);
    const any = lo <= hi;
    const total = top - target + 1n;
    const readBlocks = any ? hi - lo + 1n : 0n;
    return {
      txs: state.rows,
      scope: {
        days: state.days,
        complete: any && lo <= deploy,
        reading: lo > target || hi < top,
        progress: total > 0n ? Math.min(1, Number((readBlocks * 1000n) / total) / 1000) : 1,
        stalled,
      },
    };
  };
  let taken = `${lo0}:${hi0}`;
  /** Takes in every span read so far that joins what was read before, saves it and shows it. */
  const commit = () => {
    let hi = hi0;
    let lo = lo0;
    const add: Row[] = [];
    if (head.length > 0 && head.every((_, i) => done[i])) {
      for (let i = 0; i < head.length; i++) add.push(...done[i]!);
      hi = top;
    }
    for (let j = 0; j < older.length && done[head.length + j]; j++) {
      add.push(...done[head.length + j]!);
      lo = older[j][0];
    }
    // the first read: everything from the newest span down
    if (lo0 > hi0 && lo < lo0) hi = top;
    const now = `${lo}:${hi}`;
    if (now === taken) return;
    taken = now;
    // Show older may have moved the window while this read ran: keep its ask
    const ask = loadCached(k) ?? base;
    state = { ...base, target: ask.target, days: ask.days, from: String(lo), to: String(hi), rows: sortRows([...add, ...base.rows]) };
    saveCached(k, state);
    emit(result(false));
  };

  let failed = false;
  let stopped = false;
  let next = 0;
  const worker = async () => {
    while (!stopped && next < spans.length) {
      const i = next++;
      try {
        done[i] = await readSpan(key, address, spans[i], c, call);
      } catch {
        // one span failing stops the read: what is above it is kept, the rest waits for the next
        failed = true;
        stopped = true;
        return;
      }
      commit();
    }
  };
  await Promise.all(Array.from({ length: Math.min(SPANS_AT_ONCE, spans.length) }, worker));

  if (BigInt(state.from) > BigInt(state.to) && state.rows.length === 0 && failed) {
    // nothing read at all: the card says so and offers Retry
    throw new Error("activity_failed");
  }
  const out = result(failed);
  emit(out);
  return out;
}

/** The chain's blocks a day, from the head's block time and one PACE_SAMPLE back; the table if those fail. */
async function blocksPerDay(
  id: number,
  c: ActivityClient,
  latest: bigint,
  call: <T>(fn: () => Promise<T>) => Promise<T>
): Promise<bigint> {
  try {
    if (latest > PACE_SAMPLE) {
      const [a, b] = await within(
        Promise.all([call(() => c.getBlock({ blockNumber: latest })), call(() => c.getBlock({ blockNumber: latest - PACE_SAMPLE }))]),
        5_000
      );
      const secs = Number(a.timestamp - b.timestamp);
      if (secs > 0) return BigInt(Math.ceil((86_400 * Number(PACE_SAMPLE)) / secs));
    }
  } catch {
    /* a slow or failed read: the table's pace */
  }
  return BigInt(BLOCKS_PER_DAY[id] ?? 43_200);
}

/** One span's rows: the wallet's token transfers both ways, and the vault's native-coin deposits and cash-outs. */
async function readSpan(
  key: NetworkKey,
  address: Address,
  [from, to]: [bigint, bigint],
  c: ActivityClient,
  call: <T>(fn: () => Promise<T>) => Promise<T>
): Promise<Row[]> {
  const n = getNetwork(key);
  const id = n.chainId;
  const tokens = shieldTokensFor(id);
  const byAddress = new Map(tokens.map((t) => [t.address.toLowerCase(), t]));
  const groups: Address[][] = ONE_TOKEN_PER_QUERY.has(id) ? tokens.map((t) => [t.address]) : [tokens.map((t) => t.address)];
  const rows: Row[] = [];

  const transfers = groups.flatMap((addresses) =>
    (["from", "to"] as const).map(async (side) => {
      const logs = await getLogsSafe(
        (a, b) =>
          call(() =>
            c.getLogs({
              address: addresses.length === 1 ? addresses[0] : addresses,
              event: TRANSFER,
              args: side === "from" ? { from: address } : { to: address },
              fromBlock: a,
              toBlock: b,
            })
          ),
        from,
        to
      );
      for (const l of logs) {
        const token = byAddress.get(l.address.toLowerCase());
        const { from: src, to: dst, value } = l.args;
        if (!token || !src || !dst || value == null || NOT_ACTIVITY.has(dst.toLowerCase())) continue;
        rows.push({
          id: `${l.transactionHash}:${l.logIndex}`,
          hash: l.transactionHash ?? "",
          from: src,
          to: dst,
          valueWei: value.toString(),
          timestamp: 0,
          ok: true,
          token: { symbol: token.symbol, decimals: token.decimals },
          block: String(l.blockNumber ?? 0n),
          logIndex: l.logIndex ?? 0,
        });
      }
    })
  );

  // The native coin, where the vault lists it: its deposits and cash-outs for this wallet.
  const native = async () => {
    if (!supportsNativeShield(id) || !n.paymentsPool || !n.pool) return;
    const pool = n.pool;
    const coin = { symbol: n.primaryAsset.symbol, decimals: n.primaryAsset.decimals };
    // One query for the vault's deposits, cash-outs and fees, matched to this wallet
    // here: the vault logs a few of each a day, and one read in place of three
    // matters where a log read costs its whole range (BNB Chain).
    const logs = await getLogsSafe(
      (a, b) => call(() => c.getLogs({ address: pool, events: VAULT_EVENTS, fromBlock: a, toBlock: b })),
      from,
      to
    );
    const me = address.toLowerCase();
    const fees = new Map<string, bigint>();
    for (const l of logs) {
      if (l.eventName === "WithdrawFee" && l.args.fee != null) fees.set(`${l.transactionHash}:${l.args.nullifier}`, l.args.fee);
    }
    for (const l of logs) {
      if (l.eventName === "Shielded") {
        const { asset, from: src, amount } = l.args;
        if (amount == null || asset?.toLowerCase() !== zeroAddress || src?.toLowerCase() !== me) continue;
        rows.push({
          id: `${l.transactionHash}:${l.logIndex}`,
          hash: l.transactionHash ?? "",
          from: address,
          to: pool,
          valueWei: amount.toString(),
          timestamp: 0,
          ok: true,
          token: coin,
          block: String(l.blockNumber ?? 0n),
          logIndex: l.logIndex ?? 0,
        });
      } else if (l.eventName === "Unshielded") {
        const { asset, to: dst, amount, nullifier } = l.args;
        if (amount == null || !nullifier || asset?.toLowerCase() !== zeroAddress || dst?.toLowerCase() !== me) continue;
        // what reached the wallet: the amount less the vault's cash-out fee, from the same transaction
        const fee = fees.get(`${l.transactionHash}:${nullifier}`) ?? 0n;
        rows.push({
          id: `${l.transactionHash}:${l.logIndex}`,
          hash: l.transactionHash ?? "",
          from: pool,
          to: address,
          valueWei: (amount - fee).toString(),
          timestamp: 0,
          ok: true,
          token: coin,
          block: String(l.blockNumber ?? 0n),
          logIndex: l.logIndex ?? 0,
        });
      }
    }
  };

  await Promise.all([...transfers, native()]);
  // No block-time lookups: the feed orders rows by block and shows no times,
  // and up to 40 getBlock calls made its first load slow.
  return rows;
}
