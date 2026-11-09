/* eslint-disable @typescript-eslint/no-explicit-any -- Relay's responses are untyped JSON, read field by field below */
/**
 * Bridges and swaps made through Gloam's Relay panel, for /admin. Server only.
 *
 * Two sources, merged by Relay's request id so nothing counts twice:
 *
 *  1. Relay's history of quotes tagged RELAY_REFERRER. Relay takes a referrer
 *     only with a key, so every tagged request is a keyed one, and GET
 *     /requests/v3 hides keyed requests from a referrer filter unless it is
 *     paired with the key's id: without RELAY_API_KEY_ID it answers 200 with
 *     nothing. The older GET /requests/v2 has no such rule, and serves until
 *     Relay retires it on 24 November 2026.
 *  2. Gloam's own record (lib/relayLedger): each bridge's request id, kept at
 *     quote time and looked up by id or deposit address. It needs no tag and no
 *     key id, and it picks up a deposit that Relay filled under a new request,
 *     which the id in the quote never reports. Swaps are left out of it, because
 *     the panel re-prices them as an amount is typed: they come from (1).
 *
 * Bridges from before the tag went live have neither, so they can't be counted.
 *
 * Relay's dashboard gives this API key 2 calls a minute on /requests/*, so a
 * refresh goes in order, one call at a time: the newest page of history, always,
 * so new requests never wait; then, if there is more history to read, the next
 * older page from where the last refresh stopped (lib/relayLedger keeps the
 * place); then open quotes, with whatever is left of READS_PER_REFRESH.
 *
 * Relay's answers name each request's wallets; they are dropped here and never
 * reach the page or the store. What is kept: chains, tokens, amounts, dollar
 * values, Relay's fees, the delivery transaction and the time.
 */

import { RELAY_REFERRER } from "./bridge";
import {
  OPEN_MS,
  dueRelayQuotes,
  readRelayRows,
  readRelayWalk,
  saveRelayRows,
  saveRelayWalk,
  settleRelayQuotes,
  type RelayWalk,
} from "./relayLedger";
import { cacheGetJson, cacheSetJson, lastDays, utcDay } from "./tractionStore";

const RELAY_API = "https://api.relay.link";
/** Relay pages at most 50 requests. */
const PAGE = 50;
/**
 * Calls to Relay's /requests/* one refresh may make, history and open quotes
 * together. Relay's dashboard shows a limit of 2 a minute for this API key, and
 * FRESH_MS keeps refreshes about a minute apart. With history taking one page, that
 * leaves one open quote a refresh; the rest get their turn later.
 */
export const READS_PER_REFRESH = 2;
const DAILY_WINDOW = 30;
const RECENT_KEEP = 25;
const FRESH_MS = 60_000;
const SNAPSHOT_KEY = "gloam:relay:volume:v2";

export type RelayKind = "bridge" | "swap";
export type RelayStage = "done" | "refunded" | "failed" | "pending";

export type RelayRow = {
  kind: RelayKind;
  stage: RelayStage;
  fromChainId: number | null;
  toChainId: number | null;
  inSymbol: string;
  inAmount: string;
  inUsd: number | null;
  outSymbol: string;
  outAmount: string;
  outUsd: number | null;
  /** What Relay charged (gas, its fee and price), in dollars. */
  feeUsd: number;
  /** The delivery transaction, or the deposit when nothing was delivered. */
  tx: string | null;
  /** Unix seconds. */
  ts: number;
};

/** A row with Relay's request id, which merges the sources. The page gets the row without it. */
type KeyedRow = RelayRow & { id: string };

export type RelayTotals = { count: number; inUsd: number; outUsd: number; feeUsd: number };

/** Which of Relay's history reads ran: v3 with the key id, or v2 until it is retired. */
export type RelayHistorySource = "v3" | "v2";

export type RelayVolume =
  | { enabled: false; reason: string }
  | {
      enabled: true;
      asOf: string;
      source: "fresh" | "memory" | "redis";
      ageSec: number;
      referrer: string;
      history: RelayHistorySource;
      /** Why Relay's history couldn't be read this time: the figures are Gloam's own record alone. */
      historyError: string | null;
      /** Unix seconds of the first counted request; null with none yet. */
      since: number | null;
      /** True while part of the history is still unread. Later refreshes carry on from where this one stopped. */
      truncated: boolean;
      /** Finished requests only. */
      all: Record<RelayKind, RelayTotals>;
      last30: Record<RelayKind, RelayTotals>;
      /** Requests refunded or failed, and still in flight. */
      refunded: number;
      failed: number;
      pending: number;
      bySource: { chainId: number | null; kind: RelayKind; count: number; inUsd: number; feeUsd: number }[];
      /** Per UTC day, oldest first. */
      daily: { day: string; bridges: number; bridgeUsd: number; swaps: number; swapUsd: number; feeUsd: number }[];
      recent: RelayRow[];
    };

type LiveVolume = Extract<RelayVolume, { enabled: true }>;

function num(v: unknown): number | null {
  const x = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(x) ? x : null;
}

function stageOf(status: unknown): RelayStage {
  if (status === "success") return "done";
  if (status === "refund" || status === "refunded") return "refunded";
  if (status === "failure" || status === "failed") return "failed";
  return "pending";
}

/**
 * What Relay charged: the swap, gas and its own fee, as costs (negative) in the
 * price-impact breakdown, which is `expandedPriceImpact` on v2 and `fees` on v3.
 * Gloam's own app fee isn't Relay's, so it stays out. A swap that beat its quote
 * can make this positive, which reads as no charge.
 */
function relayFeeUsd(data: any): number {
  const impact = data.fees?.actual ?? data.fees?.quoted ?? data.expandedPriceImpact?.actual ?? data.expandedPriceImpact?.quoted;
  if (!impact) return 0;
  const cost = -[impact.swap, impact.execution, impact.platform ?? impact.relay].reduce<number>((s, c) => s + (num(c?.usd) ?? 0), 0);
  return Math.max(0, cost);
}

/** One Relay request, v2 or v3, without its wallets. Null for a quote nobody has paid, which isn't a request yet. */
function toRow(r: any): KeyedRow | null {
  if (typeof r?.id !== "string" || !r.id || r?.status === "waiting") return null;
  const data = r?.data ?? {};
  // v3 keeps the route, as it ran where it can, as quoted where not. Same-chain has no destination side.
  const actual = data.route?.actual;
  const quoted = data.route?.quoted;
  const meta = data.metadata ?? {};
  const cin = actual?.origin?.inputCurrency ?? quoted?.origin?.inputCurrency ?? meta.currencyIn ?? {};
  const cout =
    actual?.destination?.outputCurrency ??
    quoted?.destination?.outputCurrency ??
    actual?.origin?.outputCurrency ??
    quoted?.origin?.outputCurrency ??
    meta.currencyOut ??
    {};
  const inTx = Array.isArray(data.inTxs) ? data.inTxs[0] : undefined;
  const outTx = Array.isArray(data.outTxs) ? data.outTxs[0] : undefined;
  const fromChainId = num(cin.currency?.chainId) ?? num(inTx?.chainId);
  const toChainId = num(cout.currency?.chainId) ?? num(outTx?.chainId);
  const created = Date.parse(String(r?.createdAt ?? ""));
  if (!Number.isFinite(created)) return null;
  const hash = (t: any): string | null => (typeof t?.txHash === "string" ? t.txHash : typeof t?.hash === "string" ? t.hash : null);
  return {
    id: r.id,
    kind: fromChainId != null && fromChainId === toChainId ? "swap" : "bridge",
    stage: stageOf(r?.status),
    fromChainId,
    toChainId,
    inSymbol: String(cin.currency?.symbol ?? ""),
    inAmount: String(cin.amountFormatted ?? ""),
    inUsd: num(cin.amountUsd),
    outSymbol: String(cout.currency?.symbol ?? ""),
    outAmount: String(cout.amountFormatted ?? ""),
    outUsd: num(cout.amountUsd),
    feeUsd: relayFeeUsd(data),
    tx: hash(outTx) ?? hash(inTx),
    ts: Math.floor(created / 1000),
  };
}

function emptyTotals(): Record<RelayKind, RelayTotals> {
  return {
    bridge: { count: 0, inUsd: 0, outUsd: 0, feeUsd: 0 },
    swap: { count: 0, inUsd: 0, outUsd: 0, feeUsd: 0 },
  };
}

class RelayReadError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/** Relay's limit is spent, so another call this refresh would only be refused too. */
const rateLimited = (e: unknown) => e instanceof RelayReadError && e.status === 429;

const errorText = (e: unknown) => (e instanceof Error ? e.message : "unknown");

async function relayGet(url: string, apiKey: string, timeoutMs: number): Promise<any> {
  const res = await fetch(url, {
    headers: { "x-api-key": apiKey },
    signal: AbortSignal.timeout(timeoutMs),
    cache: "no-store",
  });
  const json = (await res.json().catch(() => null)) as any;
  if (!res.ok || !Array.isArray(json?.requests)) {
    throw new RelayReadError(typeof json?.message === "string" ? json.message.slice(0, 160) : `Relay answered ${res.status}`, res.status);
  }
  return json;
}

const relayKeyId = () => process.env.RELAY_API_KEY_ID?.trim() || null;

type HistoryRead = {
  rows: KeyedRow[];
  /** Where the walk stands after this read, to keep once the rows are safe. Null: leave it as it was. */
  walk: RelayWalk | null;
  truncated: boolean;
  /** Why the newest page couldn't be read. A later page failing is `truncated`, not this: the newest rows did arrive. */
  error: string | null;
  /** Calls spent, so the open quotes get only what's left. */
  reads: number;
  /** Relay answered 429, so nothing is left. */
  limited: boolean;
};

/**
 * Every request tagged to Gloam. With RELAY_API_KEY_ID this is v3, the lasting
 * read; the id is not a secret, and the key itself stays out of the URL, which
 * is why it isn't passed as v3's `apiKey` filter instead. Pending requests are
 * asked for because v3 leaves them out otherwise; quotes nobody paid are not.
 *
 * The newest page comes first on every refresh. Older pages are a walk that
 * survives between refreshes: it starts when a full page of history doesn't reach
 * back to `floor`, so requests may be sitting unread behind it, and it ends at
 * `floor` or the end of the history. Rows merge by Relay's id, so pages that
 * overlap as new requests push old ones down count once.
 */
async function readHistory(apiKey: string): Promise<HistoryRead> {
  const keyId = relayKeyId();
  const rows: KeyedRow[] = [];
  const readPage = async (continuation: string | null) => {
    const q = new URLSearchParams({ referrer: RELAY_REFERRER, limit: String(PAGE), sortBy: "createdAt", sortDirection: "desc" });
    if (keyId) {
      q.set("apiKeyId", keyId);
      q.set("includePendingRequests", "true");
    }
    if (continuation) q.set("continuation", continuation);
    const json = await relayGet(`${RELAY_API}/requests/${keyId ? "v3" : "v2"}?${q}`, apiKey, 15_000);
    const found = (json.requests as unknown[]).map(toRow).filter((r): r is KeyedRow => r !== null);
    rows.push(...found);
    const more = typeof json.continuation === "string" && json.continuation && json.requests.length >= PAGE;
    const times = found.map((r) => r.ts);
    return { next: more ? (json.continuation as string) : null, newest: Math.max(...times), oldest: Math.min(...times) };
  };

  let walk: RelayWalk = (await readRelayWalk(keyId ? "v3" : "v2")) ?? { floor: 0, top: 0, cursor: null };
  let reads = 1;
  try {
    const first = await readPage(null);
    if (!walk.cursor) {
      const top = Math.max(walk.floor, first.newest);
      walk = first.next && first.oldest > walk.floor ? { ...walk, top, cursor: first.next } : { floor: top, top, cursor: null };
    }
  } catch (e) {
    return { rows, walk: null, truncated: Boolean(walk.cursor), error: errorText(e), reads, limited: rateLimited(e) };
  }

  let cut = false;
  let limited = false;
  while (walk.cursor && reads < READS_PER_REFRESH) {
    reads++;
    try {
      const older = await readPage(walk.cursor);
      walk = older.next && older.oldest >= walk.floor ? { ...walk, cursor: older.next } : { floor: walk.top, top: walk.top, cursor: null };
    } catch (e) {
      console.error("gloam_admin_relay_history", errorText(e));
      cut = true;
      limited = rateLimited(e);
      // After a 429 the page is still there for next time. Anything else might be
      // a cursor Relay won't take: dropping it costs some rereading, never a row,
      // and a bad one kept would block the walk and the open quotes for good.
      if (!limited) walk = { ...walk, cursor: null };
      break;
    }
  }
  return { rows, walk, truncated: cut || Boolean(walk.cursor), error: null, reads, limited };
}

/**
 * What became of the open quotes that are due, one call at a time, `budget` at
 * most. A deposit address is looked up by address, Relay's own advice: the fill
 * can run under a new request id (another amount, a native deposit, a requote)
 * while the quoted id stays `waiting` forever. Everything else fills under the
 * quoted id. A quote that finds nothing stays open until its window ends; one
 * Relay couldn't answer for stays open and is asked about again. Either way it
 * goes to the back of the queue, so it can't keep the others waiting.
 */
async function readOpenQuotes(apiKey: string, now: number, budget: number): Promise<KeyedRow[]> {
  const rows: KeyedRow[] = [];
  const closed: string[] = [];
  const waiting: string[] = [];
  for (const q of await dueRelayQuotes(budget)) {
    const key = q.depositAddress ? `depositAddress=${encodeURIComponent(q.depositAddress)}` : `id=${q.requestId}`;
    try {
      const json = await relayGet(`${RELAY_API}/requests/v3?${key}&limit=20`, apiKey, 8_000);
      const found = (json.requests as unknown[]).map(toRow).filter((r): r is KeyedRow => r !== null && r.stage !== "pending");
      rows.push(...found);
      if (found.length || now - q.at > OPEN_MS) closed.push(q.raw);
      else waiting.push(q.raw);
    } catch (e) {
      waiting.push(q.raw);
      // The quotes not reached keep their place: nobody asked about them.
      if (rateLimited(e)) break;
    }
  }
  await settleRelayQuotes(closed, waiting, now);
  return rows;
}

/** The panel's figures, from the merged rows. */
export function summarizeRelayRows(rows: readonly RelayRow[], now = Date.now()) {
  const days = lastDays(DAILY_WINDOW, now);
  const cutoff = Date.parse(`${days[0]}T00:00:00Z`) / 1000;
  const all = emptyTotals();
  const last30 = emptyTotals();
  const daily = new Map(days.map((d) => [d, { day: d, bridges: 0, bridgeUsd: 0, swaps: 0, swapUsd: 0, feeUsd: 0 }]));
  const bySource = new Map<string, { chainId: number | null; kind: RelayKind; count: number; inUsd: number; feeUsd: number }>();
  let refunded = 0;
  let failed = 0;
  let pending = 0;

  for (const r of rows) {
    if (r.stage === "refunded") refunded++;
    if (r.stage === "failed") failed++;
    if (r.stage === "pending") pending++;
    if (r.stage !== "done") continue;
    const usdIn = r.inUsd ?? 0;
    const usdOut = r.outUsd ?? 0;
    for (const t of r.ts >= cutoff ? [all[r.kind], last30[r.kind]] : [all[r.kind]]) {
      t.count++;
      t.inUsd += usdIn;
      t.outUsd += usdOut;
      t.feeUsd += r.feeUsd;
    }
    const key = `${r.kind}:${r.fromChainId}`;
    const s = bySource.get(key) ?? { chainId: r.fromChainId, kind: r.kind, count: 0, inUsd: 0, feeUsd: 0 };
    s.count++;
    s.inUsd += usdIn;
    s.feeUsd += r.feeUsd;
    bySource.set(key, s);
    const d = daily.get(utcDay(r.ts * 1000));
    if (d) {
      if (r.kind === "bridge") {
        d.bridges++;
        d.bridgeUsd += usdIn;
      } else {
        d.swaps++;
        d.swapUsd += usdIn;
      }
      d.feeUsd += r.feeUsd;
    }
  }

  return {
    since: rows.length ? Math.min(...rows.map((r) => r.ts)) : null,
    all,
    last30,
    refunded,
    failed,
    pending,
    bySource: [...bySource.values()].sort((a, b) => b.inUsd - a.inUsd || b.count - a.count),
    daily: [...daily.values()],
    recent: [...rows].sort((a, b) => b.ts - a.ts).slice(0, RECENT_KEEP),
  };
}

/** Relay's history and Gloam's own record, merged. Either can fail alone: the other still counts. */
export async function readRelayVolume(apiKey: string): Promise<LiveVolume> {
  const now = Date.now();
  const own = await readRelayRows<RelayRow>();
  const history = await readHistory(apiKey);
  if (history.error) console.error("gloam_admin_relay_history", history.error);
  const open = await readOpenQuotes(apiKey, now, history.limited ? 0 : READS_PER_REFRESH - history.reads);

  const merged = new Map<string, RelayRow>(own);
  const add = (r: KeyedRow) => {
    const { id, ...row } = r;
    merged.set(id, row);
  };
  open.forEach(add);
  history.rows.forEach(add);

  // Kept for good: a finished row outlives v2, and costs nothing to hold.
  const finished = [...open, ...history.rows].filter((r) => r.stage !== "pending" && !own.has(r.id));
  const saved = await saveRelayRows(finished.map(({ id, ...row }) => [id, row] as const));
  // The walk won't read these pages again, so it moves on only once their rows are safe.
  if (saved && history.walk) await saveRelayWalk(relayKeyId() ? "v3" : "v2", history.walk);

  return {
    enabled: true,
    asOf: new Date(now).toISOString(),
    source: "fresh",
    ageSec: 0,
    referrer: RELAY_REFERRER,
    history: relayKeyId() ? "v3" : "v2",
    historyError: history.error,
    truncated: history.truncated,
    ...summarizeRelayRows([...merged.values()], now),
  };
}

type Snapshot = { at: number; data: LiveVolume };
let snapshot: Snapshot | null = null;
let inflight: Promise<RelayVolume> | null = null;

function aged(s: Snapshot, source: "memory" | "redis"): RelayVolume {
  return { ...s.data, source, ageSec: Math.max(0, Math.round((Date.now() - s.at) / 1000)) };
}

/** Gloam's bridges and swaps at Relay, cached about a minute in memory and Redis. */
export async function fetchRelayVolume(): Promise<RelayVolume> {
  const apiKey = process.env.RELAY_API_KEY?.trim();
  if (!apiKey) {
    return {
      enabled: false,
      reason: "RELAY_API_KEY is not set, so Relay neither tags Gloam's quotes nor shares their history.",
    };
  }
  const now = Date.now();
  if (snapshot && now - snapshot.at < FRESH_MS) return aged(snapshot, "memory");
  const cached = await cacheGetJson<Snapshot>(SNAPSHOT_KEY);
  if (cached?.data && now - cached.at < FRESH_MS) {
    snapshot = cached;
    return aged(cached, "redis");
  }
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const data = await readRelayVolume(apiKey);
      snapshot = { at: Date.now(), data };
      await cacheSetJson(SNAPSHOT_KEY, snapshot, 3_600);
      return data;
    } catch (e) {
      // the last good read beats an empty panel
      if (snapshot) return aged(snapshot, "memory");
      throw e;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}
