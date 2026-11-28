"use client";

import type { Address } from "viem";
import { SCHEDULE_STATUS_LABEL, type ScheduleStatus } from "@/lib/payrollSchedule";

/** A payroll currency, as PayrollView lists them. */
export type AssetOption = { address: Address; symbol: string; logoId: string };

type ScheduleIconName = "calendar" | "repeat" | "pause" | "play" | "pencil" | "trash" | "clock" | "alert" | "x";

export function ScheduleIcon({ name, className = "h-4 w-4" }: { name: ScheduleIconName; className?: string }) {
  const common = {
    className,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.6,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
  switch (name) {
    case "calendar":
      return (
        <svg {...common}>
          <rect x="4" y="5.5" width="16" height="14.5" rx="3" />
          <path d="M8.5 3.5v4M15.5 3.5v4M4 10.5h16" />
        </svg>
      );
    case "repeat":
      return (
        <svg {...common}>
          <path d="M17 3.5l3 3-3 3" />
          <path d="M4 11.5v-1a4 4 0 014-4h12M7 20.5l-3-3 3-3" />
          <path d="M20 12.5v1a4 4 0 01-4 4H4" />
        </svg>
      );
    case "pause":
      return (
        <svg {...common}>
          <path d="M9.5 6.5v11M14.5 6.5v11" />
        </svg>
      );
    case "play":
      return (
        <svg {...common}>
          <path d="M8.5 6.2v11.6a.6.6 0 00.9.5l9.1-5.8a.6.6 0 000-1L9.4 5.7a.6.6 0 00-.9.5z" />
        </svg>
      );
    case "pencil":
      return (
        <svg {...common}>
          <path d="M14.5 5.5l4 4M4.5 19.5l1-4.5L15.8 4.7a1.4 1.4 0 012 0l1.5 1.5a1.4 1.4 0 010 2L9 18.5z" />
        </svg>
      );
    case "trash":
      return (
        <svg {...common}>
          <path d="M5 7h14M10 4h4M7 7l.8 11.2a2 2 0 002 1.8h4.4a2 2 0 002-1.8L17 7" />
        </svg>
      );
    case "clock":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="8.5" />
          <path d="M12 7.5V12l3 2" />
        </svg>
      );
    case "alert":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="8.5" />
          <path d="M12 7.75v5M12 16.25v.01" />
        </svg>
      );
    case "x":
      return (
        <svg {...common}>
          <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />
        </svg>
      );
  }
}

const CHIP_TONE: Record<ScheduleStatus, string> = {
  upcoming: "bg-surface text-mute",
  due: "bg-foreground text-background",
  overdue: "bg-warn-soft text-warn",
  paused: "bg-surface text-mute",
  ended: "bg-surface text-faint",
};

export function ScheduleStatusChip({ status }: { status: ScheduleStatus }) {
  return (
    <span
      className={`inline-flex h-6 shrink-0 items-center gap-1 rounded-full px-2.5 text-[12px] font-medium ${CHIP_TONE[status]}`}
    >
      {status === "paused" && <ScheduleIcon name="pause" className="h-3 w-3" />}
      {status === "overdue" && <ScheduleIcon name="alert" className="h-3 w-3" />}
      {SCHEDULE_STATUS_LABEL[status]}
    </span>
  );
}

/** The honest line: why a schedule reminds you instead of paying by itself. */
export const SELF_CUSTODY_NOTE =
  "Gloam never holds your keys, so a schedule reminds you on payday and you run it in one click.";
