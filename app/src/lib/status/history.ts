/**
 * The status page's history and its latest run. Server only.
 *
 * The cron (/api/status/cron, every 5 minutes in vercel.json) runs the checks
 * and records them here; the page and /api/status read what it wrote, so the
 * page is never older than the last run.
 *
 *  - Per UTC day: `gloam:status:v1:day:YYYY-MM-DD`, field `<part id>|ok`,
 *    `|degraded` or `|down`, each a count. Kept 92 days after its last write.
 *  - Per UTC hour, the same, `gloam:status:v1:hour:YYYY-MM-DDTHH`, kept 4 days:
 *    while monitoring is young the bars are hours, not mostly-empty days.
 *  - The latest run, whole, as JSON (`gloam:status:v1:latest`).
 *
 * The bars start where counting started: no segment before a part's first
 * check is shown. Under HOURLY_SPAN_DAYS of history they are hours since the
 * first hour on record; from then on, days, up to 90.
 *
 * Through lib/partnersKv: Upstash in production, an in-process store in local
 * development, and no store at all in production without Redis (a write
 * throws, a read gives null and the page says history is not available).
 */
import "server-only";
import { kv } from "@/lib/partnersKv";
import { TALLY_FIELD, lastDays, utcDay, type DayTally, type StatusSnapshot } from "./model";

export const HISTORY_DAYS = 90;
/** Hours are shown until monitoring spans this many UTC days (today counted as 0). */
export const HOURLY_SPAN_DAYS = 3;
/** Hours read back, at most: four days, enough for the hourly span. */
const HOURS_READ = 96;
const KEEP_SEC = (HISTORY_DAYS + 2) * 86_400;
const HOUR_KEEP_SEC = 4 * 86_400;
const LATEST_KEEP_SEC = 86_400;
const PREFIX = "gloam:status:v1:";
const LAST_RUN_KEY = `${PREFIX}last-run`;
const LATEST_KEY = `${PREFIX}latest`;

export function dayKey(day: string): string {
  return `${PREFIX}day:${day}`;
}

/** UTC hour, YYYY-MM-DDTHH. */
export function utcHour(ms: number): string {
  return new Date(ms).toISOString().slice(0, 13);
}

export function hourKey(hour: string): string {
  return `${PREFIX}hour:${hour}`;
}

/** Count one run of the checks into its day and hour, and keep it as the latest. Throws when the store is off or fails. */
export async function recordRun(s: StatusSnapshot): Promise<void> {
  const day = dayKey(utcDay(s.checkedAt));
  const hour = hourKey(utcHour(s.checkedAt));
  await kv([
    ...s.parts.map((p) => ["HINCRBY", day, `${p.id}|${TALLY_FIELD[p.status]}`, 1]),
    ["EXPIRE", day, KEEP_SEC],
    ...s.parts.map((p) => ["HINCRBY", hour, `${p.id}|${TALLY_FIELD[p.status]}`, 1]),
    ["EXPIRE", hour, HOUR_KEEP_SEC],
    ["SET", LAST_RUN_KEY, String(s.checkedAt), "EX", KEEP_SEC],
    ["SET", LATEST_KEY, JSON.stringify(s), "EX", LATEST_KEEP_SEC],
  ]);
}

/** Keep a run as the latest without counting it (a check made because the cron's was too old). Never throws. */
export async function saveLatest(s: StatusSnapshot): Promise<void> {
  await kv([["SET", LATEST_KEY, JSON.stringify(s), "EX", LATEST_KEEP_SEC]]).catch(() => null);
}

/** The latest run on record, or null. */
export async function readLatest(): Promise<StatusSnapshot | null> {
  try {
    const [raw] = await kv([["GET", LATEST_KEY]]);
    const s = typeof raw === "string" ? (JSON.parse(raw) as StatusSnapshot) : null;
    return s && typeof s.checkedAt === "number" && Array.isArray(s.parts) ? s : null;
  } catch {
    return null;
  }
}

export interface History {
  /** "day" segments are YYYY-MM-DD, "hour" segments YYYY-MM-DDTHH. */
  unit: "day" | "hour";
  /** Part id to its segments, oldest first, from its first check to now. Empty: never checked. */
  byPart: Map<string, DayTally[]>;
  /** The first segment on record for any part, or null with none. */
  since: string | null;
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

const total = (t: DayTally) => t.ok + t.degraded + t.down;

/** Each part's segments over `keys`, from its first segment with a check. */
function segments(partIds: string[], keys: string[], perKey: Map<string, number>[]): Map<string, DayTally[]> {
  const out = new Map<string, DayTally[]>();
  for (const id of partIds) {
    const all = keys.map((key, i) => ({
      day: key,
      ok: perKey[i]!.get(`${id}|ok`) ?? 0,
      degraded: perKey[i]!.get(`${id}|degraded`) ?? 0,
      down: perKey[i]!.get(`${id}|down`) ?? 0,
    }));
    const first = all.findIndex((t) => total(t) > 0);
    out.set(id, first < 0 ? [] : all.slice(first));
  }
  return out;
}

function firstOf(byPart: Map<string, DayTally[]>): string | null {
  let first: string | null = null;
  for (const segs of byPart.values()) if (segs[0] && (first === null || segs[0].day < first)) first = segs[0].day;
  return first;
}

/** The last hours, oldest first, the current hour last. */
function lastHours(nowMs: number, n: number): string[] {
  const top = Math.floor(nowMs / 3_600_000) * 3_600_000;
  return Array.from({ length: n }, (_, i) => utcHour(top - (n - 1 - i) * 3_600_000));
}

/**
 * The history for `partIds`: days while monitoring spans HOURLY_SPAN_DAYS or
 * more, else hours since the first hour on record (days again if no hour is).
 * Null when the store is off or fails.
 */
export async function readHistory(partIds: string[], nowMs = Date.now()): Promise<History | null> {
  const days = lastDays(nowMs, HISTORY_DAYS);
  let raw: unknown[];
  try {
    raw = await kv([...days.map((d) => ["HGETALL", dayKey(d)]), ["GET", LAST_RUN_KEY]]);
  } catch {
    return null;
  }
  const last = Number(raw[days.length]);
  const lastRun = Number.isFinite(last) && last > 0 ? last : null;
  const daily = segments(partIds, days, days.map((_, i) => counts(raw[i])));
  const firstDay = firstOf(daily);
  const daySpan = firstDay === null ? 0 : days.length - 1 - days.indexOf(firstDay);
  if (firstDay === null || daySpan >= HOURLY_SPAN_DAYS) return { unit: "day", byPart: daily, since: firstDay, lastRun };

  const hours = lastHours(nowMs, HOURS_READ);
  let hourly: Map<string, DayTally[]>;
  try {
    const rows = await kv(hours.map((h) => ["HGETALL", hourKey(h)]));
    hourly = segments(partIds, hours, rows.map(counts));
  } catch {
    return { unit: "day", byPart: daily, since: firstDay, lastRun };
  }
  const firstHour = firstOf(hourly);
  // runs from before hours were kept: days until the first hour is on record
  if (firstHour === null) return { unit: "day", byPart: daily, since: firstDay, lastRun };
  return { unit: "hour", byPart: hourly, since: firstHour, lastRun };
}
