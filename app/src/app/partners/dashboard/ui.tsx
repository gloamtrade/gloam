"use client";

import { useState, type ReactNode } from "react";
import { displayAmount, displayAmountText } from "@/lib/amountShort";

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
const int = new Intl.NumberFormat("en-US");

export function fmtUsd(n: number | null | undefined): string {
  if (n == null) return "Not priced";
  if (n > 0 && n < 0.01) return "<$0.01";
  return usd.format(n);
}

export function fmtInt(n: number | null | undefined): string {
  return int.format(n ?? 0);
}

/** Smallest units as a token amount, two places, cut down (lib/amountShort): "250.00", "0.62", "<0.01". */
export function fmtUnits(raw: string | null, decimals: number | null): string {
  if (raw == null || decimals == null) return "";
  try {
    return displayAmount(BigInt(raw), decimals);
  } catch {
    return "";
  }
}

/** A token amount as decimal text, two places, cut down: "1,250.62". */
export function fmtTokenText(v: string): string {
  return displayAmountText(v);
}

const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

export function ago(ms: number | null | undefined): string {
  if (!ms) return "Never";
  const s = Math.round((ms - Date.now()) / 1000);
  const abs = Math.abs(s);
  if (abs < 45) return "just now";
  if (abs < 3600) return rtf.format(Math.round(s / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(s / 3600), "hour");
  if (abs < 86400 * 30) return rtf.format(Math.round(s / 86400), "day");
  return new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export function fullDate(ms: number): string {
  return new Date(ms).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}

export function shortAddr(a: string): string {
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

export function LockIcon({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="4.5" y="10.5" width="15" height="10" rx="2.5" stroke="currentColor" strokeWidth="1.9" />
      <path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
    </svg>
  );
}

export function ArrowIcon({ dir }: { dir: "in" | "out" }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d={dir === "out" ? "M12 15V4m0 0L7.5 8.5M12 4l4.5 4.5M5 19.5h14" : "M12 4v11m0 0l-4.5-4.5M12 15l4.5-4.5M5 19.5h14"}
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function CopyButton({ text, label = "Copy", className = "" }: { text: string; label?: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1600);
        } catch {
          /* clipboard unavailable */
        }
      }}
      className={`inline-flex h-10 shrink-0 items-center gap-1.5 rounded-full px-3.5 text-[13px] font-medium text-mute transition-colors hover:bg-surface-2 hover:text-foreground ${className}`}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
        {copied ? (
          <path d="M5 12.5l4.2 4.2L19 7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        ) : (
          <>
            <rect x="8.5" y="8.5" width="11" height="11" rx="2.5" stroke="currentColor" strokeWidth="1.5" />
            <path d="M15.5 8.5V6.5a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2" stroke="currentColor" strokeWidth="1.5" />
          </>
        )}
      </svg>
      <span aria-live="polite">{copied ? "Copied" : label}</span>
    </button>
  );
}

export function Card({
  title,
  action,
  children,
  className = "",
  flush = false,
  foot,
}: {
  title?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  flush?: boolean;
  foot?: ReactNode;
}) {
  return (
    <section className={`gl-card min-w-0 overflow-hidden ${className}`}>
      {title && (
        <div className="flex min-h-[60px] items-center justify-between gap-3 border-b border-line px-5 py-3 sm:px-6">
          <h2 className="text-[15px] font-medium text-foreground">{title}</h2>
          {action}
        </div>
      )}
      <div className={flush ? "" : "p-5 sm:p-6"}>{children}</div>
      {foot && <div className="border-t border-line px-5 py-3 text-[12.5px] leading-relaxed text-mute sm:px-6">{foot}</div>}
    </section>
  );
}

export function Kpi({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="gl-card min-w-0 px-4 py-4 sm:px-5 sm:py-5">
      <p className="truncate text-[13px] text-mute">{label}</p>
      <p className="tnum mt-3 truncate text-[24px] font-light leading-none tracking-[-0.02em] text-foreground sm:text-[30px]">{value}</p>
      {sub && <p className="mt-2 line-clamp-2 text-[12px] leading-snug text-mute sm:truncate">{sub}</p>}
    </div>
  );
}

export function Notice({ tone = "plain", children }: { tone?: "plain" | "danger" | "warn"; children: ReactNode }) {
  const cls =
    tone === "danger" ? "bg-danger-soft text-danger" : tone === "warn" ? "bg-warn-soft text-warn" : "bg-surface text-mute";
  return (
    <p role={tone === "danger" ? "alert" : undefined} className={`rounded-xl px-4 py-3 text-[13.5px] leading-relaxed ${cls}`}>
      {children}
    </p>
  );
}

export function Field({
  label,
  hint,
  children,
  htmlFor,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
  htmlFor?: string;
}) {
  return (
    <div className="min-w-0">
      <label htmlFor={htmlFor} className="block text-[13px] text-mute">
        {label}
      </label>
      <div className="mt-2">{children}</div>
      {hint && <p className="mt-1.5 text-[12.5px] leading-relaxed text-mute">{hint}</p>}
    </div>
  );
}
