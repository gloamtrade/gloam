/**
 * Scheduled payroll on Starknet: a saved pay list that comes due on a
 * calendar, as on the other chains (lib/payrollSchedule, whose calendar this
 * uses as it is).
 *
 * Gloam never holds a private account's keys, on Starknet as anywhere: they
 * live in the page's session, and every proof is made and signed in this
 * browser. So no server can pay on a timer, and nothing here pretends one
 * does. A schedule is a saved list and a calendar: when a payday comes, the
 * payroll page says so and loads the list, every account is checked again,
 * and the run goes out in one click through the same engine as any other run
 * (lib/starknetPrivacy/payroll). Each run covers one payday, the oldest not
 * yet paid, so a missed one stays in view.
 *
 * Schedules name people and accounts, so they are sealed like runs
 * (lib/starknetPrivacy/payrollStore), per private account and network, in
 * this browser only.
 */
import { addDays, isIsoDay, isoDay, nextPayday, scheduleState, type ScheduleCadence, type ScheduleState } from "@/lib/payrollSchedule";
import type { StarknetNetwork, StarknetToken } from "./config";
import { formatUnits, starknetAddressText, type DraftRow } from "./payroll";
import { sealedList, type RunCipher, type RunStorage } from "./payrollStore";

/** Most schedules one account keeps. */
export const MAX_SCHEDULES = 50;

export type StarknetSchedulePerson = { name: string; address: string; amount: string };

export type StarknetSchedule = {
  v: 1;
  id: string;
  name: string;
  network: StarknetNetwork;
  owner: string;
  token: string;
  cadence: ScheduleCadence;
  /** Paydays before this day are never owed. */
  startsOn: string;
  endsOn?: string;
  paused: boolean;
  /** The latest payday a finished run covered. */
  paidThrough?: string;
  lastRunAt?: number;
  lastRunId?: string;
  people: StarknetSchedulePerson[];
  createdAt: number;
  updatedAt: number;
};

/** The people of a checked list (rows that can be paid). */
export function peopleFromRows(rows: readonly DraftRow[]): StarknetSchedulePerson[] {
  return rows.filter((r) => !r.error && r.amount !== null).map((r) => ({ name: r.name, address: r.address, amount: r.amount!.toString() }));
}

/** A new schedule: its first payday is the first on or after `startsOn`. */
export function newSchedule(args: {
  id: string;
  name: string;
  network: StarknetNetwork;
  owner: string;
  token: string;
  cadence: ScheduleCadence;
  startsOn: string;
  people: StarknetSchedulePerson[];
  now: number;
}): StarknetSchedule {
  if (!args.people.length) throw new Error("Add your team first.");
  if (!isIsoDay(args.startsOn)) throw new Error("Pick a first payday.");
  const name = args.name.trim().slice(0, 60) || "Payroll";
  return {
    v: 1,
    id: args.id,
    name,
    network: args.network,
    owner: args.owner,
    token: args.token,
    cadence: args.cadence,
    startsOn: args.startsOn,
    paused: false,
    people: args.people,
    createdAt: args.now,
    updatedAt: args.now,
  };
}

/** Where a schedule stands today (the other chains' rules). */
export function starknetScheduleState(s: StarknetSchedule, today: string = isoDay()): ScheduleState {
  return scheduleState(s, today);
}

/** Due and overdue first (oldest payday first), then upcoming, paused, ended. */
export function sortStarknetSchedules(list: readonly StarknetSchedule[], today: string = isoDay()): StarknetSchedule[] {
  const rank = { overdue: 0, due: 1, upcoming: 2, paused: 3, ended: 4 } as const;
  return list
    .map((s) => ({ s, st: scheduleState(s, today) }))
    .sort((a, b) => rank[a.st.status] - rank[b.st.status] || (a.st.payday ?? "9999").localeCompare(b.st.payday ?? "9999") || b.s.createdAt - a.s.createdAt)
    .map((x) => x.s);
}

export function scheduleTotal(s: Pick<StarknetSchedule, "people">): bigint {
  return s.people.reduce((sum, p) => sum + BigInt(p.amount), 0n);
}

/** The list a schedule loads into the payroll page (name, address, amount), checked again like any list. */
export function scheduleListText(s: Pick<StarknetSchedule, "people">, token: Pick<StarknetToken, "decimals">): string {
  const cell = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return ["name,address,amount", ...s.people.map((p) => [cell(p.name), p.address, formatUnits(BigInt(p.amount), token.decimals)].join(","))].join("\n");
}

/** The schedule after a finished run covered `payday`. */
export function withPaid(s: StarknetSchedule, payday: string, runId: string, now: number): StarknetSchedule {
  return { ...s, paidThrough: s.paidThrough && s.paidThrough > payday ? s.paidThrough : payday, lastRunAt: now, lastRunId: runId, updatedAt: now };
}

/** The payday a run of this schedule covers now, or null when none is owed yet. */
export function paydayToRun(s: StarknetSchedule, today: string = isoDay()): string | null {
  const st = scheduleState(s, today);
  return st.status === "due" || st.status === "overdue" ? st.payday : null;
}

/** The first payday a new schedule could have, from today, for the editor's default. */
export function firstPaydayFrom(c: ScheduleCadence, today: string = isoDay()): string | null {
  return nextPayday({ cadence: c, startsOn: today });
}

/** A day `n` days from `day` (re-exported for the editor). */
export const dayPlus = addDays;

/** The schedules' own sealing domain: their key is never the runs' (lib/starknetPrivacy/payrollStore runCipher). */
export const SCHEDULE_DOMAIN = "gloam/starknet-payroll-schedules/v1\n";
const DOMAIN = SCHEDULE_DOMAIN;

function isCadence(c: unknown): c is ScheduleCadence {
  const x = c as Partial<Record<string, unknown>> | null;
  if (!x || typeof x !== "object") return false;
  if (x.kind === "monthly") return Number.isInteger(x.day) && (x.day as number) >= 1 && (x.day as number) <= 31;
  if (x.kind === "weekly") return Number.isInteger(x.weekday) && (x.weekday as number) >= 0 && (x.weekday as number) <= 6;
  if (x.kind === "biweekly") return typeof x.from === "string" && isIsoDay(x.from);
  if (x.kind === "once") return typeof x.on === "string" && isIsoDay(x.on);
  return false;
}

/** Whether `v` is a schedule this version reads (storage is checked before use). */
export function isSchedule(v: unknown): v is StarknetSchedule {
  const s = v as Partial<StarknetSchedule> | null;
  return (
    Boolean(s) &&
    s!.v === 1 &&
    typeof s!.id === "string" &&
    typeof s!.name === "string" &&
    typeof s!.owner === "string" &&
    typeof s!.token === "string" &&
    (s!.network === "mainnet" || s!.network === "sepolia" || s!.network === "devnet") &&
    isCadence(s!.cadence) &&
    typeof s!.startsOn === "string" &&
    isIsoDay(s!.startsOn) &&
    (s!.endsOn === undefined || (typeof s!.endsOn === "string" && isIsoDay(s!.endsOn))) &&
    (s!.paidThrough === undefined || (typeof s!.paidThrough === "string" && isIsoDay(s!.paidThrough))) &&
    typeof s!.paused === "boolean" &&
    typeof s!.createdAt === "number" &&
    Array.isArray(s!.people) &&
    s!.people.length > 0 &&
    s!.people.every((p) => p && typeof p.name === "string" && typeof p.address === "string" && starknetAddressText(p.address) === p.address && typeof p.amount === "string" && /^[1-9]\d*$/.test(p.amount))
  );
}

export function scheduleStoreKey(network: StarknetNetwork, owner: string): string {
  return `gloam:starknet-payroll-schedules:v1:${network}:${BigInt(owner).toString(16)}`;
}

/** This account's schedules, sealed in this browser. None is ever dropped to make room: a new one past MAX_SCHEDULES is refused. */
export function scheduleStore(opts: { key: string; cipher: RunCipher; storage?: RunStorage }) {
  const list = sealedList<StarknetSchedule>({ ...opts, domain: DOMAIN, isItem: isSchedule, keep: () => true });
  return {
    load: list.load,
    async save(s: StarknetSchedule): Promise<void> {
      const all = await list.load();
      if (!all.some((x) => x.id === s.id) && all.length >= MAX_SCHEDULES) throw new Error(`Up to ${MAX_SCHEDULES} schedules. Delete one first.`);
      await list.save(s);
    },
    async remove(id: string): Promise<void> {
      await list.remove(id);
    },
  };
}

export type ScheduleStore = ReturnType<typeof scheduleStore>;
