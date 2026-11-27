/**
 * Scheduled payroll: a saved pay list that comes due on a calendar.
 *
 * Gloam is self-custodial. Keys and proving live in this browser, so there is
 * no server that could pay on a timer for you, and nothing here pretends there
 * is. A schedule is a saved list, a cap and a calendar: when a payday comes,
 * the payroll page says so and runs the list in one click, through the same
 * engine as any other run (lib/payroll).
 *
 * Each run covers exactly one payday, the oldest one not yet paid, so a missed
 * month stays visible instead of being folded into the next run. A run whose
 * total is above the schedule's cap is blocked before anything is sent.
 *
 * Schedules hold names and Gloam addresses, so they are stored encrypted under
 * the same device key as notes and runs, per network and vault. Days are local
 * calendar days written as YYYY-MM-DD.
 */
import { formatUnits, type Address } from "viem";
import { scopedKey, writableKey } from "@/lib/accountSlot";
import { openJson, sealJson } from "@/lib/noteVault";
import { assetDecimals } from "@/lib/shield";
import type { DraftRow, PayeeKind, PayrollBatch } from "@/lib/payroll";

// ------------------------------------------------------------------ types

export type ScheduleCadence =
  /** Every month on this day (29 to 31 fall on the last day of shorter months). */
  | { kind: "monthly"; day: number }
  /** Every 14 days, counting from this payday. */
  | { kind: "biweekly"; from: string }
  /** Every week on this weekday (0 is Sunday). */
  | { kind: "weekly"; weekday: number }
  /** A single payday. */
  | { kind: "once"; on: string };

export type SchedulePerson = {
  name: string;
  /** Gloam address (gloamr1…), a Gloam name ("@ada", looked up each payday) or "" for a claim link */
  recipient: string;
  kind: PayeeKind;
  /** raw units of the schedule's asset */
  amount: string;
  /** Private note sealed into each of their payments, e.g. "Monthly retainer". */
  note?: string;
};

export type PayrollSchedule = {
  id: string;
  name: string;
  chainId: number;
  pool: Address;
  asset: Address;
  cadence: ScheduleCadence;
  /** raw units: a run whose total is above this is blocked */
  cap: string;
  /** last day the schedule can run (inclusive); after it the schedule has ended */
  endsOn?: string;
  people: SchedulePerson[];
  /** paydays before this day are never owed */
  startsOn: string;
  paused: boolean;
  /** the latest payday a finished run covered */
  paidThrough?: string;
  lastRunAt?: number;
  lastBatchId?: string;
  createdAt: number;
  updatedAt: number;
};

export type ScheduleStatus = "upcoming" | "due" | "overdue" | "ended" | "paused";

export type ScheduleState = {
  status: ScheduleStatus;
  /** The payday the next run covers, or null once the schedule has ended. */
  payday: string | null;
  /** Paydays owed up to today, this one included (0 while upcoming). */
  owed: number;
  /** Days since the payday: 0 on the day, negative while upcoming. */
  late: number;
};

/** A payday reads "Due now" on the day and for this many days after, then "Overdue". */
export const DUE_GRACE_DAYS = 3;

export const SCHEDULE_STATUS_LABEL: Record<ScheduleStatus, string> = {
  upcoming: "Upcoming",
  due: "Due now",
  overdue: "Overdue",
  ended: "Ended",
  paused: "Paused",
};

// ------------------------------------------------------------------ calendar

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isoDay(d: Date = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function parts(day: string): [number, number, number] {
  const [y, m, d] = day.split("-").map(Number);
  return [y, m, d];
}

function toDate(day: string): Date {
  const [y, m, d] = parts(day);
  return new Date(y, m - 1, d);
}

export function isIsoDay(s: string): boolean {
  return DAY_RE.test(s) && isoDay(toDate(s)) === s;
}

export function addDays(day: string, n: number): string {
  const d = toDate(day);
  d.setDate(d.getDate() + n);
  return isoDay(d);
}

/** b minus a, in whole days (counted in UTC so a clock change cannot skew it). */
export function daysBetween(a: string, b: string): number {
  const [ay, am, ad] = parts(a);
  const [by, bm, bd] = parts(b);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000);
}

function daysInMonth(y: number, m0: number): number {
  return new Date(y, m0 + 1, 0).getDate();
}

/** The first payday on or after `day`, or null when the cadence has none left. */
export function paydayOnOrAfter(c: ScheduleCadence, day: string): string | null {
  switch (c.kind) {
    case "monthly": {
      const d = toDate(day);
      let y = d.getFullYear();
      let m = d.getMonth();
      const pick = () => isoDay(new Date(y, m, Math.min(Math.max(1, c.day), daysInMonth(y, m))));
      let p = pick();
      if (p < day) {
        m += 1;
        if (m > 11) {
          m = 0;
          y += 1;
        }
        p = pick();
      }
      return p;
    }
    case "weekly":
      return addDays(day, (((c.weekday - toDate(day).getDay()) % 7) + 7) % 7);
    case "biweekly":
      if (day <= c.from) return c.from;
      return addDays(c.from, Math.ceil(daysBetween(c.from, day) / 14) * 14);
    case "once":
      return c.on >= day ? c.on : null;
  }
}

/** The next `count` paydays on or after `from`, stopping at the end date. */
export function paydaysFrom(c: ScheduleCadence, from: string, count: number, endsOn?: string): string[] {
  const out: string[] = [];
  let cursor = from;
  while (out.length < count) {
    const p = paydayOnOrAfter(c, cursor);
    if (!p || (endsOn && p > endsOn)) break;
    out.push(p);
    cursor = addDays(p, 1);
  }
  return out;
}

/** Where the next run starts looking: after the last paid payday, never before the start. */
function cursorFor(s: Pick<PayrollSchedule, "startsOn" | "paidThrough">): string {
  if (!s.paidThrough) return s.startsOn;
  const after = addDays(s.paidThrough, 1);
  return after > s.startsOn ? after : s.startsOn;
}

/** The payday the next run covers: the oldest one not yet paid (null when none is left). */
export function nextPayday(s: Pick<PayrollSchedule, "cadence" | "startsOn" | "paidThrough" | "endsOn">): string | null {
  return paydaysFrom(s.cadence, cursorFor(s), 1, s.endsOn)[0] ?? null;
}

/** The next few paydays still to be run, oldest first (for previews). */
export function paydaysAhead(
  s: Pick<PayrollSchedule, "cadence" | "startsOn" | "paidThrough" | "endsOn">,
  count: number
): string[] {
  return paydaysFrom(s.cadence, cursorFor(s), count, s.endsOn);
}

export function scheduleState(s: Pick<PayrollSchedule, "cadence" | "startsOn" | "paidThrough" | "endsOn" | "paused">, today: string = isoDay()): ScheduleState {
  const payday = nextPayday(s);
  if (!payday || (s.endsOn && today > s.endsOn)) return { status: "ended", payday: null, owed: 0, late: 0 };
  const late = daysBetween(payday, today);
  const owed = late >= 0 ? paydaysFrom(s.cadence, payday, 60, today).length : 0;
  if (s.paused) return { status: "paused", payday, owed, late };
  if (late < 0) return { status: "upcoming", payday, owed: 0, late };
  return { status: late <= DUE_GRACE_DAYS ? "due" : "overdue", payday, owed, late };
}

/** Due and overdue schedules first (oldest payday first), then upcoming, paused, ended. */
export function sortSchedules(list: PayrollSchedule[], today: string = isoDay()): PayrollSchedule[] {
  const rank: Record<ScheduleStatus, number> = { overdue: 0, due: 1, upcoming: 2, paused: 3, ended: 4 };
  return list
    .map((s) => ({ s, st: scheduleState(s, today) }))
    .sort((a, b) => {
      const r = rank[a.st.status] - rank[b.st.status];
      if (r) return r;
      const pa = a.st.payday ?? "9999";
      const pb = b.st.payday ?? "9999";
      return pa < pb ? -1 : pa > pb ? 1 : b.s.createdAt - a.s.createdAt;
    })
    .map((x) => x.s);
}

// ------------------------------------------------------------------ words

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function weekdayName(i: number, short = false): string {
  const w = WEEKDAYS[((i % 7) + 7) % 7];
  return short ? w.slice(0, 3) : w;
}

export function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
}

/** "Oct 1", with the year when it is not this year. */
export function dayLabel(day: string, today: string = isoDay()): string {
  const d = toDate(day);
  const sameYear = day.slice(0, 4) === today.slice(0, 4);
  // A no-break space, so "Oct 1" never splits across lines.
  return d
    .toLocaleDateString("en-US", { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) })
    .replace(/ /g, "\u00a0");
}

/** "today", "tomorrow", "in 5 days", "yesterday", "3 days ago". */
export function relativeDay(day: string, today: string = isoDay()): string {
  const n = daysBetween(today, day);
  if (n === 0) return "today";
  if (n === 1) return "tomorrow";
  if (n === -1) return "yesterday";
  return n > 0 ? `in ${n} days` : `${-n} days ago`;
}

export function cadenceLabel(c: ScheduleCadence, today: string = isoDay()): string {
  switch (c.kind) {
    case "monthly":
      return `Monthly on the ${ordinal(c.day)}`;
    case "biweekly":
      return `Every two weeks on ${weekdayName(toDate(c.from).getDay())}s`;
    case "weekly":
      return `Weekly on ${weekdayName(c.weekday)}s`;
    case "once":
      return `One time, ${dayLabel(c.on, today)}`;
  }
}

// ------------------------------------------------------------------ money

export function scheduleTotal(s: Pick<PayrollSchedule, "people">): bigint {
  return s.people.reduce((sum, p) => sum + BigInt(p.amount), 0n);
}

/** How far a run total is over the cap (0 when it fits). */
export function overCap(total: bigint, s: Pick<PayrollSchedule, "cap">): bigint {
  const cap = BigInt(s.cap);
  return total > cap ? total - cap : 0n;
}

// ------------------------------------------------------------------ lists

function csvCell(v: string): string {
  return /[",;\t\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** A schedule's people as the payroll CSV, so a run goes through the normal list. */
export function scheduleCsv(people: SchedulePerson[], asset: Address): string {
  const decimals = assetDecimals(asset);
  // The note column only when someone has one, so a list without notes reads as before.
  const notes = people.some((p) => p.note);
  return [
    notes ? "name,gloam_address,amount,note" : "name,gloam_address,amount",
    ...people.map((p) =>
      [
        p.name,
        p.kind === "gloam" ? p.recipient : "",
        formatUnits(BigInt(p.amount), decimals),
        ...(notes ? [p.note ?? ""] : []),
      ]
        .map(csvCell)
        .join(",")
    ),
  ].join("\n");
}

export function peopleFromDraft(rows: DraftRow[]): SchedulePerson[] {
  return rows
    .filter((r) => !r.error && r.amount != null)
    .map((r) => ({
      name: r.name,
      // a Gloam name stays a name, so each payday pays the address it holds then
      recipient: r.payName ? `@${r.payName}` : r.recipient,
      kind: r.kind,
      amount: r.amount!.toString(),
      ...(r.note ? { note: r.note } : {}),
    }));
}

export function peopleFromBatch(b: PayrollBatch): SchedulePerson[] {
  return b.rows.map((r) => ({
    name: r.name,
    // A direct payee with no address on record (an old run) becomes a claim link.
    recipient: r.kind === "gloam" ? r.recipient : "",
    kind: r.kind === "gloam" && r.recipient ? "gloam" : "link",
    amount: r.amount,
    ...(r.note ? { note: r.note } : {}),
  }));
}

export function newSchedule(args: {
  name: string;
  chainId: number;
  pool: Address;
  asset: Address;
  cadence: ScheduleCadence;
  cap: bigint;
  people: SchedulePerson[];
  startsOn?: string;
  paidThrough?: string;
  endsOn?: string;
}): PayrollSchedule {
  const stamp = Date.now();
  return {
    id: `ps-${stamp}-${Math.random().toString(36).slice(2, 6)}`,
    name: args.name,
    chainId: args.chainId,
    pool: args.pool,
    asset: args.asset,
    cadence: args.cadence,
    cap: args.cap.toString(),
    endsOn: args.endsOn,
    people: args.people,
    startsOn: args.startsOn ?? isoDay(),
    paidThrough: args.paidThrough,
    paused: false,
    createdAt: stamp,
    updatedAt: stamp,
  };
}

/** The schedule after a finished run covered `payday`. */
export function withPaid(s: PayrollSchedule, payday: string, batchId: string): PayrollSchedule {
  return {
    ...s,
    paidThrough: s.paidThrough && s.paidThrough > payday ? s.paidThrough : payday,
    lastRunAt: Date.now(),
    lastBatchId: batchId,
    updatedAt: Date.now(),
  };
}

/** A run's title: the schedule's name and the payday it covers. */
export function runTitle(s: PayrollSchedule, payday: string, today: string = isoDay()): string {
  return s.cadence.kind === "once" ? s.name : `${s.name}, ${dayLabel(payday, today)}`;
}

// ------------------------------------------------------------------ storage

/** The schedules of the browser's first account; every other sign-in's carry a suffix (lib/accountSlot). */
export const STORE_KEY = "gloam.payroll.schedules.v1";
const STORE_LOCK = "gloam-payroll-schedules";

/** How many schedules this browser keeps, across every network. */
export const MAX_SCHEDULES = 50;

/** The bound account's schedules as stored (none with no account bound). */
function storedRaw(): string | null {
  if (typeof window === "undefined") return null;
  const key = scopedKey(STORE_KEY);
  return key ? window.localStorage.getItem(key) : null;
}

/**
 * Every saved schedule. `forWrite` refuses when schedules are stored but cannot
 * be opened (another device key, damaged data): writing would replace them all.
 */
async function readAll(
  forWrite = false,
  raw = storedRaw()
): Promise<PayrollSchedule[]> {
  if (typeof window === "undefined") return [];
  const all = await openJson<PayrollSchedule[]>(raw);
  if (Array.isArray(all)) return all;
  if (forWrite && raw) {
    throw new Error("Your saved schedules could not be opened in this browser, so nothing was changed.");
  }
  return [];
}

export async function loadSchedules(chainId: number, pool: Address): Promise<PayrollSchedule[]> {
  return (await readAll()).filter((s) => s.chainId === chainId && s.pool.toLowerCase() === pool.toLowerCase());
}

/**
 * Calls `onChange` when another tab changes the saved schedules, so a payroll
 * page open in two tabs shows the same list.
 */
export function onSchedulesChangedElsewhere(onChange: () => void): () => void {
  const onStorage = (e: StorageEvent) => {
    if (e.key === null || e.key === scopedKey(STORE_KEY)) onChange();
  };
  window.addEventListener("storage", onStorage);
  return () => window.removeEventListener("storage", onStorage);
}

/** Runs `fn` while no other tab is writing schedules. Without Web Locks, `fn` re-checks the store itself. */
function withStoreLock<T>(fn: () => Promise<T>): Promise<T> {
  const locks = (globalThis.navigator as { locks?: { request: (n: string, f: () => Promise<T>) => Promise<T> } } | undefined)
    ?.locks;
  return locks?.request ? locks.request(STORE_LOCK, fn) : fn();
}

/**
 * Change the saved schedules: `change` gets what is stored now and returns the
 * new list (or throws to leave it). Runs under a cross-tab lock, so two tabs
 * saving at once both keep their change; without Web Locks, a write that lands
 * meanwhile is read again and the change made over it. The list is written
 * whole: nothing is ever cut to make room.
 */
async function mutate(change: (all: PayrollSchedule[]) => PayrollSchedule[]): Promise<void> {
  // the bound account's schedules: with none bound this throws and nothing is written
  const key = writableKey(STORE_KEY);
  await withStoreLock(async () => {
    for (let attempt = 0; ; attempt++) {
      const raw = window.localStorage.getItem(key);
      const next = change(await readAll(true, raw));
      // Names and Gloam addresses: sealed under the same device key as notes and runs.
      const sealed = await sealJson(next);
      if (window.localStorage.getItem(key) !== raw && attempt < 5) continue;
      window.localStorage.setItem(key, sealed);
      return;
    }
  });
}

// One failed write (a full localStorage, say) must not stop every later one,
// so the queue itself never stays rejected; each caller still gets its error.
let writeQueue: Promise<void> = Promise.resolve();
function queue(task: () => Promise<void>): Promise<void> {
  const run = writeQueue.then(task);
  writeQueue = run.catch(() => undefined);
  return run;
}

/**
 * Save a schedule, new or edited. A new one past MAX_SCHEDULES is refused with
 * a reason; the oldest schedule is never dropped to make room for it.
 */
export function saveSchedule(s: PayrollSchedule): Promise<void> {
  return queue(() =>
    mutate((all) => {
      if (!all.some((x) => x.id === s.id) && all.length >= MAX_SCHEDULES) {
        throw new Error(
          `This browser keeps up to ${MAX_SCHEDULES} schedules, across every network. Delete one you no longer use, then save this one.`
        );
      }
      return [s, ...all.filter((x) => x.id !== s.id)];
    })
  );
}

export function deleteSchedule(id: string): Promise<void> {
  return queue(() => mutate((all) => all.filter((s) => s.id !== id)));
}

/** Record a finished run against its schedule (read fresh, so a stale copy cannot undo an edit). */
export function markSchedulePaid(id: string, payday: string, batchId: string): Promise<void> {
  return queue(() => mutate((all) => all.map((s) => (s.id === id ? withPaid(s, payday, batchId) : s))));
}

// ------------------------------------------------------------------ demo

/** The recording demo's team (same people and addresses as public/demo/gloam-team.csv). */
const DEMO_TEAM: [string, string, number][] = [
  ["Duke", "gloamr1.s44hhYt8AUtc3U5FqmOzdqnIl17nCjkOpD-qr7xF3wua8sjXKIP1HnvFUnSIOm5AEiyTYtkvsZyItkHyPp4iotfDtSTPKRap1g_FW1VrNkBjRXvFbcLcyCtXXw", 6000],
  ["Yomi", "gloamr1.hLjmSivxL-EEn_c6sI0GkRlbbQlV8u8pl6E95KqG4vXXeTy2M16Vw39GX7yqFE1DfYq7M7Ewlx8QgEewt0VZgHbn39p4dnMfwm4CrGxrk8jfIiIpbVpxtE05FA", 4800],
  ["Robin", "", 4200],
  ["Romeo", "gloamr1.7w1GsQePdUJ8AiFru4OG0am1fOBu2MaXIlogAicG8qKMVTXByE2BebldYVd_yWfKUznB-uUue4j9i_RuJyIY9pPkx4bYm5CfV4P81x4sSZ09IZzSnbwhbMXKqw", 3600],
  ["Kris", "", 2900],
];

/**
 * One saved schedule for the recording demo: this month's payroll, monthly on
 * the 1st, capped at 25,000, so the payroll page opens with it due.
 */
export function demoSchedule(args: {
  chainId: number;
  pool: Address;
  asset: Address;
  decimals: number;
  today?: string;
}): PayrollSchedule {
  const today = args.today ?? isoDay();
  const unit = 10n ** BigInt(args.decimals);
  const month = toDate(today).toLocaleDateString("en-US", { month: "long" });
  const first = `${today.slice(0, 8)}01`;
  const stamp = toDate(first).getTime() - 20 * 86_400_000;
  return {
    id: "ps-demo-monthly",
    name: `${month} payroll`,
    chainId: args.chainId,
    pool: args.pool,
    asset: args.asset,
    cadence: { kind: "monthly", day: 1 },
    cap: (25_000n * unit).toString(),
    people: DEMO_TEAM.map(([name, tag, amt]) => ({
      name,
      recipient: tag,
      kind: tag ? "gloam" : "link",
      amount: (BigInt(amt) * unit).toString(),
    })),
    startsOn: first,
    paused: false,
    createdAt: stamp,
    updatedAt: stamp,
  };
}
