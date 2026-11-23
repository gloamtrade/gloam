"use client";

import { useState } from "react";
import {
  cadenceLabel,
  dayLabel,
  scheduleState,
  scheduleTotal,
  sortSchedules,
  type PayrollSchedule,
} from "@/lib/payrollSchedule";
import { formatAssetAmount } from "@/lib/shield";
import { ScheduleIcon, ScheduleStatusChip, SELF_CUSTODY_NOTE, type AssetOption } from "./scheduleUi";

function people(n: number) {
  return `${n} ${n === 1 ? "person" : "people"}`;
}

/** Saved payroll schedules: what is due, what is next, and the actions on each. */
export function ScheduleList({
  schedules,
  today,
  assetOptions,
  loadedId,
  onRun,
  onTogglePause,
  onEdit,
  onDelete,
  onNew,
}: {
  schedules: PayrollSchedule[];
  today: string;
  assetOptions: AssetOption[];
  /** The schedule whose list is in the draft right now. */
  loadedId: string | null;
  onRun: (s: PayrollSchedule) => void;
  onTogglePause: (s: PayrollSchedule) => void;
  onEdit: (s: PayrollSchedule) => void;
  onDelete: (s: PayrollSchedule) => void;
  onNew: () => void;
}) {
  const [confirming, setConfirming] = useState<string | null>(null);
  const sorted = sortSchedules(schedules, today);

  return (
    <section className="gl-card max-sm:p-5 sm:p-6" aria-labelledby="payroll-schedules">
      <div className="flex items-center justify-between gap-3">
        <h2 id="payroll-schedules" className="text-[17px] text-foreground">
          Schedules
        </h2>
        <button type="button" onClick={onNew} className="btn btn-quiet btn-sm -mr-3 h-9 text-mute hover:text-foreground">
          <ScheduleIcon name="calendar" className="h-3.5 w-3.5" />
          New schedule
        </button>
      </div>

      {sorted.length === 0 ? (
        <p className="mt-3 text-[13px] leading-relaxed text-mute">
          Pay the same people on a calendar? Save a list as a schedule, with a cap per run, and this page tells you when
          it is due.
        </p>
      ) : (
        <ul className="-mx-2 mt-3 space-y-1">
          {sorted.map((s) => {
            const st = scheduleState(s, today);
            const opt = assetOptions.find((o) => o.address.toLowerCase() === s.asset.toLowerCase());
            const sym = opt?.symbol ?? "";
            const loaded = loadedId === s.id;
            const canRun = st.status !== "ended" && st.status !== "paused";
            const urgent = st.status === "due" || st.status === "overdue";
            const when = st.payday
              ? st.status === "upcoming" || st.status === "paused"
                ? `Next payday ${dayLabel(st.payday, today)}`
                : `Payday ${dayLabel(st.payday, today)}`
              : s.endsOn && today > s.endsOn
                ? `Ended ${dayLabel(s.endsOn, today)}`
                : "No paydays left";
            return (
              <li key={s.id} className={`rounded-[14px] px-2 py-3 transition-colors ${loaded ? "bg-surface" : ""}`}>
                <div className="flex items-start gap-3">
                  <span
                    aria-hidden
                    className={`grid h-9 w-9 shrink-0 place-items-center rounded-full ${
                      loaded
                        ? "bg-panel text-foreground"
                        : urgent
                          ? "bg-foreground text-background"
                          : "bg-surface text-foreground"
                    }`}
                  >
                    <ScheduleIcon name={st.status === "ended" ? "clock" : "calendar"} className="h-4 w-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-2">
                      <p className="min-w-0 truncate pt-0.5 text-[14px] text-foreground">{s.name}</p>
                      <ScheduleStatusChip status={st.status} />
                    </div>
                    <p className="mt-0.5 text-[12.5px] text-mute">{cadenceLabel(s.cadence, today)}</p>
                    <p className="tnum mt-0.5 text-[12.5px] text-mute">
                      {when}
                      {s.endsOn && st.status !== "ended" ? `, ends ${dayLabel(s.endsOn, today)}` : ""}
                    </p>
                    <p className="tnum mt-0.5 text-[12.5px] text-mute">
                      {people(s.people.length)}, {formatAssetAmount(scheduleTotal(s), s.asset)} {sym}
                      <span className="text-faint"> · cap {formatAssetAmount(s.cap, s.asset)}</span>
                    </p>
                    {st.owed > 1 && st.status !== "paused" && (
                      <p className="mt-1.5 text-[12.5px] leading-relaxed text-warn">
                        {st.owed} paydays owed. Each run covers one, oldest first.
                      </p>
                    )}
                  </div>
                </div>
                {confirming === s.id ? (
                  <div className="mt-3 flex flex-wrap items-center gap-1.5">
                    <span className="mr-1 text-[12.5px] text-foreground">Delete this schedule?</span>
                    <button
                      type="button"
                      onClick={() => {
                        setConfirming(null);
                        onDelete(s);
                      }}
                      className="btn btn-sm h-9 bg-danger-soft text-danger hover:opacity-90"
                    >
                      Delete
                    </button>
                    <button type="button" onClick={() => setConfirming(null)} className="btn btn-quiet btn-sm h-9">
                      Keep
                    </button>
                  </div>
                ) : (
                  <div className="mt-3 flex flex-wrap items-center gap-0.5">
                    {canRun &&
                      (loaded ? (
                        <span className="mr-1 inline-flex h-9 items-center rounded-full bg-panel px-3 text-[12.5px] text-mute">
                          In your list
                        </span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => onRun(s)}
                          className={`btn btn-sm mr-1 h-9 ${urgent ? "btn-ink" : "btn-ghost"}`}
                        >
                          Run now
                        </button>
                      ))}
                    {st.status !== "ended" && (
                      <button
                        type="button"
                        onClick={() => onTogglePause(s)}
                        className="btn btn-quiet btn-sm h-9 px-2.5 text-mute hover:text-foreground"
                      >
                        <ScheduleIcon name={s.paused ? "play" : "pause"} className="h-3.5 w-3.5" />
                        {s.paused ? "Resume" : "Pause"}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => onEdit(s)}
                      className="btn btn-quiet btn-sm h-9 px-2.5 text-mute hover:text-foreground"
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirming(s.id)}
                      className="btn btn-quiet btn-sm h-9 px-2.5 text-mute hover:text-foreground"
                      aria-label={`Delete ${s.name}`}
                    >
                      Delete
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <p className="mt-4 border-t border-line pt-4 text-[12.5px] leading-relaxed text-mute">{SELF_CUSTODY_NOTE}</p>
    </section>
  );
}
