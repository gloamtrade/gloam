/**
 * USD prices in the past, for the admin's money figures. Server only.
 *
 * A deposit or cash-out of ETH, $GLOAM or any other token that is not a dollar
 * stablecoin is priced at the time it happened, not at today's price, so the
 * figures do not move when the token's price does. The source is CoinGecko's
 * market chart for the token's CoinGecko id (the id lib/tokens already lists):
 * hourly points for a window up to 90 days, daily ones beyond. A flow takes the
 * point nearest its block time.
 *
 * Callers keep the price they get on the flow itself (lib/onchainMetrics keeps
 * it in the vault's read state), so a flow is looked up once. A series is kept
 * in memory a few minutes; reads are spaced and fail soft, and a flow with no
 * price yet is tried again on the next read.
 */

const API = "https://api.coingecko.com/api/v3/coins";
const SERIES_FRESH_MS = 10 * 60_000;
const HOUR = 3_600_000;
/** A flow newer than this keeps a provisional price: the hour it falls in may not be in the series yet. */
export const SETTLE_SEC = 2 * 3_600;

/** [unix ms, usd], oldest first. */
export type Point = [number, number];

type Series = { at: number; fromMs: number; points: Point[] };

const series = new Map<string, Series>();
const inflight = new Map<string, { fromMs: number; job: Promise<Point[] | null> }>();

async function fetchRange(id: string, fromSec: number, toSec: number): Promise<Point[] | null> {
  const url = `${API}/${encodeURIComponent(id)}/market_chart/range?vs_currency=usd&from=${fromSec}&to=${toSec}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000), cache: "no-store" });
  if (!res.ok) return null;
  const j = (await res.json()) as { prices?: unknown };
  if (!Array.isArray(j.prices)) return null;
  const pts = j.prices.filter(
    (p): p is Point =>
      Array.isArray(p) && typeof p[0] === "number" && typeof p[1] === "number" && Number.isFinite(p[1]) && p[1] > 0
  );
  pts.sort((a, b) => a[0] - b[0]);
  return pts.length ? pts : null;
}

/**
 * The USD series for a CoinGecko id covering [fromSec, now]. Reused while it is
 * fresh and covers the window; one read per id at a time. Null when CoinGecko
 * does not answer.
 */
export async function usdSeries(id: string, fromSec: number, now = Date.now()): Promise<Point[] | null> {
  const fromMs = fromSec * 1000;
  const hit = series.get(id);
  if (hit && now - hit.at < SERIES_FRESH_MS && hit.fromMs <= fromMs) return hit.points;
  const running = inflight.get(id);
  if (running && running.fromMs <= fromMs) return running.job;
  const entry: { fromMs: number; job: Promise<Point[] | null> } = { fromMs, job: Promise.resolve(null) };
  entry.job = (async () => {
    try {
      const pts = await fetchRange(id, fromSec, Math.floor(now / 1000));
      // keep the widest fresh series, so a narrower read never pushes it out
      const kept = series.get(id);
      if (pts && !(kept && now - kept.at < SERIES_FRESH_MS && kept.fromMs < fromMs)) series.set(id, { at: now, fromMs, points: pts });
      return pts;
    } catch {
      return null;
    } finally {
      if (inflight.get(id) === entry) inflight.delete(id);
    }
  })();
  inflight.set(id, entry);
  return entry.job;
}

/**
 * The price nearest `tsSec` in `points`, or null when none is close enough: two
 * hours for an hourly series, a day and a half for a daily one. `settled` is
 * false while the series has nothing after the flow yet, or the flow is under
 * SETTLE_SEC old, so the caller tries it again later.
 */
export function priceAt(points: Point[], tsSec: number, nowSec = Math.floor(Date.now() / 1000)): { usd: number; settled: boolean } | null {
  if (!points.length || !tsSec) return null;
  const t = tsSec * 1000;
  // binary search for the first point at or after t
  let lo = 0;
  let hi = points.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid]![0] < t) lo = mid + 1;
    else hi = mid;
  }
  const after = points[lo];
  const before = lo > 0 ? points[lo - 1] : undefined;
  const best = !before ? after! : !after ? before : t - before[0] <= after[0] - t ? before : after;
  const gaps = points.slice(1).map((p, i) => p[0] - points[i]![0]).sort((a, b) => a - b);
  const spacing = gaps.length ? gaps[gaps.length >> 1]! : HOUR;
  const tolerance = Math.max(2 * HOUR, 1.5 * spacing);
  if (Math.abs(best[0] - t) > tolerance) return null;
  return { usd: best[1], settled: Boolean(after) && nowSec - tsSec >= SETTLE_SEC };
}

/**
 * The day's price for each UTC day (YYYY-MM-DD): the mean of the series' points
 * that day. A day with no point is left out.
 */
export function dailyMeans(points: Point[]): Map<string, number> {
  const sum = new Map<string, { s: number; n: number }>();
  for (const [ms, usd] of points) {
    const d = new Date(ms).toISOString().slice(0, 10);
    const x = sum.get(d) ?? { s: 0, n: 0 };
    x.s += usd;
    x.n++;
    sum.set(d, x);
  }
  return new Map([...sum].map(([d, x]) => [d, x.s / x.n]));
}

/** For tests: forget the series kept in memory. */
export function resetPriceHistory() {
  series.clear();
  inflight.clear();
}
