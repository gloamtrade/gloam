"use client";

/**
 * Scheduled payroll on Starknet (lib/starknetPrivacy/payrollSchedule): save
 * the list on the payroll page as a schedule, see what is due, and load a
 * payday's list back into the page, where every account is checked again and
 * the run goes out in one click. Nothing pays by itself: Gloam never holds
 * the keys (SELF_CUSTODY_NOTE says so where schedules are).
 */
import { useCallback, useEffect, useState } from "react";
import { cadenceLabel, dayLabel, isIsoDay, ordinal, relativeDay, weekdayName, type ScheduleCadence } from "@/lib/payrollSchedule";
import {
  firstPaydayFrom,
  scheduleTotal,
  sortStarknetSchedules,
  starknetScheduleState,
  type ScheduleStore,
  type StarknetSchedule,
} from "@/lib/starknetPrivacy/payrollSchedule";
import type { StarknetToken } from "@/lib/starknetPrivacy/config";
import { Select, type SelectOption } from "@/components/ui/Select";
import { Spinner } from "@/components/ui/Spinner";
import { ScheduleIcon, ScheduleStatusChip, SELF_CUSTODY_NOTE } from "./payroll/scheduleUi";
import { starkAmount } from "./StarknetParts";

type Kind = ScheduleCadence["kind"];

const KINDS: { kind: Kind; label: string }[] = [
  { kind: "monthly", label: "Monthly" },
  { kind: "biweekly", label: "Every two weeks" },
  { kind: "weekly", label: "Weekly" },
  { kind: "once", label: "One time" },
];
/** Monday first, the way a work week reads. */
const WEEK = [1, 2, 3, 4, 5, 6, 0];
const MONTH_DAYS: SelectOption<number>[] = Array.from({ length: 31 }, (_, i) => ({ value: i + 1, label: ordinal(i + 1) }));

const people = (n: number) => `${n} ${n === 1 ? "person" : "people"}`;

/** This account's schedules: loaded once, saved and removed through the sealed store. */
export function useStarknetSchedules(open: () => Promise<ScheduleStore>) {
  const [store, setStore] = useState<ScheduleStore | null>(null);
  const [list, setList] = useState<StarknetSchedule[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void open()
      .then(async (s) => {
        const all = await s.load();
        if (!live) return;
        setStore(s);
        setList(all);
      })
      .catch(() => live && setError("This browser can't keep payroll schedules."));
    return () => {
      live = false;
    };
  }, [open]);
  const save = useCallback(
    async (s: StarknetSchedule) => {
      if (!store) throw new Error("Schedules aren't loaded yet.");
      await store.save(s);
      setList(await store.load());
    },
    [store]
  );
  const remove = useCallback(
    async (id: string) => {
      if (!store) return;
      await store.remove(id);
      setList(await store.load());
    },
    [store]
  );
  return { list, error, save, remove };
}

/** A schedule's payday has come: shown above the team, with one button to load its list. */
export function StarknetDueLine({ schedules, today, token, onLoad }: { schedules: StarknetSchedule[]; today: string; token: StarknetToken; onLoad: (s: StarknetSchedule) => void }) {
  const due = sortStarknetSchedules(schedules, today)
    .map((s) => ({ s, st: starknetScheduleState(s, today) }))
    .filter((x) => x.st.status === "due" || x.st.status === "overdue");
  if (!due.length) return null;
  const { s, st } = due[0]!;
  const when = st.late <= 0 ? "is due today" : st.status === "overdue" ? `is ${st.late} days overdue` : `was due ${relativeDay(st.payday!, today)}`;
  return (
    <section className="gl-card flex flex-col gap-3 max-sm:p-5 sm:flex-row sm:items-center sm:justify-between sm:p-6" aria-live="polite">
      <div className="flex min-w-0 items-start gap-3">
        <span className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-full bg-surface text-foreground">
          <ScheduleIcon name="calendar" />
        </span>
        <div className="min-w-0">
          <p className="text-[15px] text-foreground">
            {s.name} {when}
          </p>
          <p className="tnum mt-0.5 text-[13px] text-mute">
            {people(s.people.length)}, {starkAmount(scheduleTotal(s), token)} {token.symbol}
            {due.length > 1 ? `. ${due.length - 1} more due` : ""}
          </p>
        </div>
      </div>
      <button type="button" className="btn btn-ink shrink-0 max-sm:w-full" onClick={() => onLoad(s)}>
        Load the list
      </button>
    </section>
  );
}

/** Saved schedules: what is due, what is next, and load, pause or delete. */
export function StarknetScheduleList({
  schedules,
  today,
  token,
  loadedId,
  onLoad,
  onSave,
  onRemove,
}: {
  schedules: StarknetSchedule[];
  today: string;
  token: StarknetToken;
  loadedId: string | null;
  onLoad: (s: StarknetSchedule) => void;
  onSave: (s: StarknetSchedule) => Promise<void>;
  onRemove: (id: string) => Promise<void>;
}) {
  const [deleting, setDeleting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!schedules.length) return null;
  const act = (f: () => Promise<void>) => {
    setError(null);
    void f().catch((e: unknown) => setError(e instanceof Error ? e.message : "That didn't save."));
  };
  return (
    <section className="gl-card max-sm:p-5 sm:p-6" aria-labelledby="sn-schedules-title">
      <h2 id="sn-schedules-title" className="text-[17px] text-foreground">
        Schedules
      </h2>
      <ul className="mt-4 divide-y divide-line border-y border-line">
        {sortStarknetSchedules(schedules, today).map((s) => {
          const st = starknetScheduleState(s, today);
          const owed = st.status === "due" || st.status === "overdue";
          return (
            <li key={s.id} className="py-3.5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-[14px] text-foreground">{s.name}</p>
                  <p className="tnum mt-0.5 text-[12.5px] text-mute">
                    {cadenceLabel(s.cadence, today)}
                    {st.payday && st.status !== "ended" ? `. Next ${dayLabel(st.payday, today)}` : ""}
                  </p>
                  <p className="tnum mt-0.5 text-[12.5px] text-mute">
                    {people(s.people.length)}, {starkAmount(scheduleTotal(s), token)} {token.symbol}
                  </p>
                </div>
                <ScheduleStatusChip status={st.status} />
              </div>
              <div className="mt-2.5 flex flex-wrap gap-1.5">
                <button type="button" className={`btn btn-sm h-10 ${owed ? "btn-ink" : "btn-ghost"}`} disabled={loadedId === s.id} onClick={() => onLoad(s)}>
                  {loadedId === s.id ? "Loaded" : "Load the list"}
                </button>
                {st.status !== "ended" && (
                  <button type="button" className="btn btn-quiet btn-sm h-10" onClick={() => act(() => onSave({ ...s, paused: !s.paused, updatedAt: Date.now() }))}>
                    <ScheduleIcon name={s.paused ? "play" : "pause"} className="h-3.5 w-3.5" />
                    {s.paused ? "Resume" : "Pause"}
                  </button>
                )}
                <button
                  type="button"
                  className={`btn btn-quiet btn-sm h-10 ${deleting === s.id ? "text-warn" : ""}`}
                  onClick={() => (deleting === s.id ? act(() => onRemove(s.id)) : setDeleting(s.id))}
                >
                  <ScheduleIcon name="trash" className="h-3.5 w-3.5" />
                  {deleting === s.id ? "Delete it" : "Delete"}
                </button>
              </div>
            </li>
          );
        })}
      </ul>
      {error && (
        <p role="alert" className="mt-3 text-[13px] text-warn">
          {error}
        </p>
      )}
      <p className="mt-4 text-[12.5px] leading-relaxed text-mute">{SELF_CUSTODY_NOTE}</p>
    </section>
  );
}

/**
 * Save the list on the page as a schedule: a name and how often. Its first
 * payday is the next one from today.
 */
export function StarknetScheduleSave({
  today,
  count,
  onSave,
}: {
  today: string;
  /** People in the list that can be paid. */
  count: number;
  onSave: (name: string, cadence: ScheduleCadence, startsOn: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<Kind>("monthly");
  const [monthDay, setMonthDay] = useState(() => Math.min(28, Number(today.slice(8, 10)) || 1));
  const [weekday, setWeekday] = useState(5);
  const [from, setFrom] = useState(today);
  const [on, setOn] = useState(today);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  if (!open) {
    return (
      <button type="button" className="btn btn-quiet btn-sm mt-3 h-10 w-full text-mute" disabled={count === 0} onClick={() => setOpen(true)}>
        <ScheduleIcon name="repeat" className="h-3.5 w-3.5" />
        {saved ? "Saved. Save another schedule" : "Save as a schedule"}
      </button>
    );
  }
  const cadence: ScheduleCadence = kind === "monthly" ? { kind, day: monthDay } : kind === "weekly" ? { kind, weekday } : kind === "biweekly" ? { kind, from } : { kind, on };
  const datesOk = (kind !== "biweekly" || (isIsoDay(from) && from >= today)) && (kind !== "once" || (isIsoDay(on) && on >= today));
  const first = datesOk ? firstPaydayFrom(cadence, today) : null;
  const problem = !name.trim() ? "Give it a name." : !first ? "Pick a payday from today on." : null;

  return (
    <div className="mt-4 rounded-[16px] border border-line p-4">
      <p className="text-[14px] text-foreground">Save as a schedule</p>
      <label className="mt-3 block">
        <span className="mb-1.5 block text-[13px] text-mute">Name</span>
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} placeholder="Team payroll" className="gl-input h-11 text-[14px]" />
      </label>
      <p className="mb-1.5 mt-3 text-[13px] text-mute">Repeats</p>
      <div className="grid grid-cols-2 gap-1.5 rounded-[14px] bg-surface p-1" role="radiogroup" aria-label="Repeats">
        {KINDS.map((k) => (
          <button
            key={k.kind}
            type="button"
            role="radio"
            aria-checked={kind === k.kind}
            onClick={() => setKind(k.kind)}
            className={`h-10 rounded-[10px] px-2 text-[13px] transition-colors duration-200 ${kind === k.kind ? "bg-panel text-foreground shadow-card" : "text-mute hover:text-foreground"}`}
          >
            {k.label}
          </button>
        ))}
      </div>
      <div className="mt-3">
        {kind === "monthly" && (
          <div className="flex items-center gap-3">
            <span className="text-[14px] text-foreground">On the</span>
            <div className="w-[112px]">
              <Select label="Day of the month" value={monthDay} onChange={setMonthDay} options={MONTH_DAYS} className="h-11 text-[14px]" />
            </div>
          </div>
        )}
        {kind === "weekly" && (
          <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Weekday">
            {WEEK.map((d) => (
              <button
                key={d}
                type="button"
                role="radio"
                aria-checked={weekday === d}
                aria-label={weekdayName(d)}
                onClick={() => setWeekday(d)}
                className={`h-10 min-w-[44px] rounded-full border px-2.5 text-[13px] transition-colors duration-200 ${
                  weekday === d ? "border-foreground bg-panel text-foreground" : "border-line text-mute hover:border-line-strong hover:text-foreground"
                }`}
              >
                {weekdayName(d, true)}
              </button>
            ))}
          </div>
        )}
        {kind === "biweekly" && (
          <label className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <span className="text-[14px] text-foreground">Starting</span>
            <input type="date" value={from} min={today} onChange={(e) => setFrom(e.target.value)} className="gl-input h-11 w-auto min-w-[160px] text-[14px]" />
          </label>
        )}
        {kind === "once" && (
          <label className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <span className="text-[14px] text-foreground">On</span>
            <input type="date" value={on} min={today} onChange={(e) => setOn(e.target.value)} className="gl-input h-11 w-auto min-w-[160px] text-[14px]" />
          </label>
        )}
      </div>
      <p className="tnum mt-3 text-[12.5px] text-mute">{first ? `First payday ${dayLabel(first, today)}, ${people(count)}.` : " "}</p>
      {error && (
        <p role="alert" className="mt-2 text-[13px] text-warn">
          {error}
        </p>
      )}
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          className="btn btn-ink btn-sm h-10 flex-1"
          disabled={Boolean(problem) || saving}
          aria-busy={saving || undefined}
          onClick={() => {
            if (problem || !first) return;
            setSaving(true);
            setError(null);
            void onSave(name, cadence, first)
              .then(() => {
                setOpen(false);
                setSaved(true);
                setName("");
              })
              .catch((e: unknown) => setError(e instanceof Error ? e.message : "That didn't save."))
              .finally(() => setSaving(false));
          }}
        >
          {saving ? <Spinner /> : null}
          {problem ?? "Save schedule"}
        </button>
        <button type="button" className="btn btn-quiet btn-sm h-10" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </div>
  );
}
