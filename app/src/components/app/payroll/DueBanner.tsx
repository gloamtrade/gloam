"use client";

import { motion, useReducedMotion } from "framer-motion";
import {
  dayLabel,
  scheduleTotal,
  type PayrollSchedule,
  type ScheduleState,
} from "@/lib/payrollSchedule";
import { formatAssetAmount } from "@/lib/shield";
import { TokenLogo } from "../TokenLogo";
import { ScheduleIcon, type AssetOption } from "./scheduleUi";

function people(n: number) {
  return `${n} ${n === 1 ? "person" : "people"}`;
}

function headline(s: PayrollSchedule, st: ScheduleState, today: string): string {
  if (st.late <= 0) return `${s.name} is due today`;
  if (st.status === "overdue") return `${s.name} is ${st.late} days overdue`;
  if (st.late === 1) return `${s.name} was due yesterday`;
  return `${s.name} was due ${dayLabel(st.payday!, today)}`;
}

/** "Payroll due": shown when the page opens and a schedule's payday has come. */
export function DueBanner({
  items,
  today,
  assetOptions,
  onRun,
  onDismiss,
}: {
  /** Due and overdue schedules, most urgent first. */
  items: { s: PayrollSchedule; st: ScheduleState }[];
  today: string;
  assetOptions: AssetOption[];
  onRun: (s: PayrollSchedule) => void;
  onDismiss: () => void;
}) {
  const reduce = useReducedMotion();
  const { s, st } = items[0];
  const opt = assetOptions.find((o) => o.address.toLowerCase() === s.asset.toLowerCase());
  const more = items.length - 1;

  return (
    <motion.section
      role="status"
      aria-live="polite"
      initial={reduce ? false : { y: -6 }}
      animate={{ y: 0 }}
      transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
      className="gl-card flex gap-4 max-sm:flex-col max-sm:p-5 sm:items-center sm:p-6"
    >
      <div className="flex min-w-0 flex-1 items-start gap-4">
        <ScheduleIcon name="calendar" className="mt-0.5 h-5 w-5 shrink-0 text-foreground" />
        <div className="min-w-0">
          <p className={`text-[13px] ${st.status === "overdue" ? "text-warn" : "text-mute"}`}>Payroll due</p>
          <p className="mt-1 text-balance text-[19px] leading-snug tracking-[-0.01em] text-foreground">{headline(s, st, today)}</p>
          <p className="tnum mt-1 flex flex-wrap items-center gap-x-1.5 text-[13.5px] text-mute">
            <span>{people(s.people.length)},</span>
            <span className="inline-flex items-center gap-1.5 text-foreground">
              {formatAssetAmount(scheduleTotal(s), s.asset)}
              {opt && <TokenLogo id={opt.logoId} symbol={opt.symbol} size={16} />}
            </span>
            <span>from your private balance.</span>
          </p>
          <p className="mt-1.5 text-[12.5px] leading-relaxed text-mute">
            {st.owed > 1 ? `${st.owed} paydays owed; each run covers one, oldest first. ` : ""}
            {more > 0 ? `${more} more ${more === 1 ? "schedule is" : "schedules are"} due. ` : ""}
            It runs from this browser, because only you hold the keys.
          </p>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2 max-sm:pl-[60px]">
        <button type="button" onClick={() => onRun(s)} className="btn btn-ink">
          Run now
        </button>
        <button type="button" onClick={onDismiss} className="btn btn-quiet text-mute hover:text-foreground">
          Not now
        </button>
      </div>
    </motion.section>
  );
}
