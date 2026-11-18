/**
 * The status page's shapes and arithmetic (status.gloam.trade, /status,
 * /api/status). No imports, so the page's client parts can use it too.
 *
 * A check answers operational, degraded (it answered, but slow, stale or in
 * part) or down. The history keeps, per part and per UTC day, how many checks
 * landed in each (lib/status/history). A day with no checks is "No data",
 * never green: nothing is shown that was not measured.
 */

export type Health = "operational" | "degraded" | "down";

export type GroupId = "networks" | "payments" | "bridge" | "platform";

export const GROUPS: { id: GroupId; name: string }[] = [
  { id: "networks", name: "Networks" },
  { id: "payments", name: "Payments and relay" },
  { id: "bridge", name: "Bridge" },
  { id: "platform", name: "Platform" },
];

/** One part of Gloam, as the page lists it. */
export interface StatusPart {
  /** Stable: the history is kept under it. */
  id: string;
  name: string;
  group: GroupId;
  /** For a network, its chain id (the page shows its logo). */
  chainId?: number;
}

/** One check's answer. `reason` is a short fixed sentence, never an error's own text. */
export interface PartCheck extends StatusPart {
  status: Health;
  /** How long it took to answer, or null when it never did. */
  latencyMs: number | null;
  reason: string | null;
}

export interface StatusSnapshot {
  /** Unix ms. */
  checkedAt: number;
  overall: Health;
  parts: PartCheck[];
}

/** How many checks of one part landed in each state on one UTC day. */
export interface DayTally {
  day: string;
  ok: number;
  degraded: number;
  down: number;
}

/** The field names the history counts under, per state. */
export const TALLY_FIELD: Record<Health, "ok" | "degraded" | "down"> = {
  operational: "ok",
  degraded: "degraded",
  down: "down",
};

const RANK: Record<Health, number> = { operational: 0, degraded: 1, down: 2 };

export function worst(states: Iterable<Health>): Health {
  let w: Health = "operational";
  for (const s of states) if (RANK[s] > RANK[w]) w = s;
  return w;
}

export const HEALTH_LABEL: Record<Health, string> = {
  operational: "Operational",
  degraded: "Degraded",
  down: "Down",
};

export function overallTitle(h: Health): string {
  if (h === "operational") return "All systems operational";
  if (h === "degraded") return "Some systems are degraded";
  return "Some systems are down";
}

/** UTC day, YYYY-MM-DD. */
export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** The last `n` UTC days, oldest first, today last. */
export function lastDays(nowMs: number, n: number): string[] {
  const today = Date.UTC(new Date(nowMs).getUTCFullYear(), new Date(nowMs).getUTCMonth(), new Date(nowMs).getUTCDate());
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) out.push(utcDay(today - i * 86_400_000));
  return out;
}

export function dayTotal(t: Pick<DayTally, "ok" | "degraded" | "down">): number {
  return t.ok + t.degraded + t.down;
}

/**
 * Share of a day's checks that got an answer (operational or degraded), or
 * null with no checks. Degraded still answered, so it counts as up; the bar's
 * colour shows it.
 */
export function dayUptime(t: Pick<DayTally, "ok" | "degraded" | "down">): number | null {
  const total = dayTotal(t);
  return total === 0 ? null : (t.ok + t.degraded) / total;
}

/** The same over many days: only days with checks count. Null when none had any. */
export function rangeUptime(days: Pick<DayTally, "ok" | "degraded" | "down">[]): number | null {
  let up = 0;
  let total = 0;
  for (const d of days) {
    up += d.ok + d.degraded;
    total += dayTotal(d);
  }
  return total === 0 ? null : up / total;
}

export type DayTone = "none" | "ok" | "degraded" | "down";

/**
 * A day's bar. Down for 5% of the day's checks or more (about 70 minutes):
 * down. Any down at all, or degraded for 5% or more: degraded. Else ok. A day
 * with no checks: none ("No data").
 */
export function dayTone(t: Pick<DayTally, "ok" | "degraded" | "down">): DayTone {
  const total = dayTotal(t);
  if (total === 0) return "none";
  if (t.down / total >= 0.05) return "down";
  if (t.down > 0 || t.degraded / total >= 0.05) return "degraded";
  return "ok";
}

/**
 * "99.95%": rounded down to two places, so a day with any check down never
 * reads 100%. Trailing zeros dropped ("100%", "99.5%").
 */
export function formatPercent(share: number): string {
  if (share >= 1) return "100%";
  const floored = Math.floor(share * 10_000) / 100;
  return `${Number(floored.toFixed(2))}%`;
}

/** "182 ms", "3.4 s". */
export function formatLatency(ms: number): string {
  if (ms < 1000) return `${Math.max(1, Math.round(ms))} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "19 Nov 2026" from "2026-11-19". */
export function formatDay(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  return `${d} ${MONTHS[(m ?? 1) - 1]} ${y}`;
}

/** "19 Nov 2026, 00:51 UTC". */
export function formatUtc(ms: number): string {
  const d = new Date(ms);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${formatDay(utcDay(ms))}, ${hh}:${mm} UTC`;
}

/** "Robinhood Chain", "Robinhood Chain and Base", "Robinhood Chain, Tempo and Base". */
export function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}
