/**
 * The status page's history: per part, per UTC day, how many checks were
 * operational, degraded and down. The cron (/api/status/cron, every 5 minutes
 * in vercel.json) adds one run; the page reads the last 90 days. Server only.
 *
 * One Redis hash per day, `gloam:status:v1:day:YYYY-MM-DD`, field
 * `<part id>|ok`, `|degraded` or `|down`, each a count. Each day's hash expires
 * 92 days after its last write, so the store keeps a rolling 90 days and never
 * grows. About 288 runs a day, a few dozen fields per hash.
 *
 * Through lib/partnersKv: Upstash in production, an in-process store in local
 * development, and no store at all in production without Redis (a write
 * throws, a read gives null and the page shows "No data").
 */
import "server-only";
import { kv } from "@/lib/partnersKv";
import { TALLY_FIELD, lastDays, utcDay, type DayTally, type StatusSnapshot } from "./model";

export const HISTORY_DAYS = 90;
const KEEP_SEC = (HISTORY_DAYS + 2) * 86_400;
const PREFIX = "gloam:status:v1:";
const LAST_RUN_KEY = `${PREFIX}last-run`;

export function dayKey(day: string): string {
  return `${PREFIX}day:${day}`;
}

/** Count one run of the checks into its day. Throws when the store is off or fails. */
export async function recordRun(s: StatusSnapshot): Promise<void> {
  const key = dayKey(utcDay(s.checkedAt));
  await kv([
    ...s.parts.map((p) => ["HINCRBY", key, `${p.id}|${TALLY_FIELD[p.status]}`, 1]),
    ["EXPIRE", key, KEEP_SEC],
    ["SET", LAST_RUN_KEY, String(s.checkedAt), "EX", KEEP_SEC],
  ]);
}

export interface History {
  /** The days shown, oldest first, today last. */
  days: string[];
  /** Part id to one tally per day in `days`; a part with no checks on a day has zeros. */
  byPart: Map<string, DayTally[]>;
  /** When the cron last recorded a run (unix ms), or null. */
  lastRun: number | null;
}

/** Flat HGETALL answer into field to count. */
function counts(raw: unknown): Map<string, number> {
  const out = new Map<string, number>();
  if (!Array.isArray(raw)) return out;
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const n = Number(raw[i + 1]);
    if (Number.isFinite(n) && n > 0) out.set(String(raw[i]), n);
  }
  return out;
}

/** The last 90 days for `partIds`, in one round trip. Null when the store is off or fails. */
export async function readHistory(partIds: string[], nowMs = Date.now()): Promise<History | null> {
  const days = lastDays(nowMs, HISTORY_DAYS);
  let raw: unknown[];
  try {
    raw = await kv([...days.map((d) => ["HGETALL", dayKey(d)]), ["GET", LAST_RUN_KEY]]);
  } catch {
    return null;
  }
  const perDay = days.map((_, i) => counts(raw[i]));
  const byPart = new Map<string, DayTally[]>();
  for (const id of partIds) {
    byPart.set(
      id,
      days.map((day, i) => ({
        day,
        ok: perDay[i]!.get(`${id}|ok`) ?? 0,
        degraded: perDay[i]!.get(`${id}|degraded`) ?? 0,
        down: perDay[i]!.get(`${id}|down`) ?? 0,
      }))
    );
  }
  const last = Number(raw[days.length]);
  return { days, byPart, lastRun: Number.isFinite(last) && last > 0 ? last : null };
}
