"use client";

/**
 * The admin's building blocks: panels, a strip of figures, tables, funnel
 * bars, notices and loading states. Tokens only, so light and dark both hold.
 */
import { isValidElement, type ReactNode } from "react";

export function Panel({
  title,
  sub,
  children,
  action,
  id,
}: {
  title: string;
  /** One quiet line under the title. */
  sub?: ReactNode;
  children: ReactNode;
  action?: ReactNode;
  id?: string;
}) {
  return (
    <section id={id} className="gl-card min-w-0 scroll-mt-24 p-5 sm:p-6">
      <div className="mb-5 flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
        <div className="min-w-0">
          <h2 className="text-[16px] leading-snug tracking-[-0.01em] text-foreground">{title}</h2>
          {sub && <p className="mt-1 text-[13px] leading-snug text-mute">{sub}</p>}
        </div>
        {action && <div className="flex shrink-0 flex-wrap items-center gap-1.5">{action}</div>}
      </div>
      {children}
    </section>
  );
}

/** A section heading between groups of cards. */
export function SectionHead({ title, sub }: { title: string; sub?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 pt-4">
      <h2 className="text-[15px] font-medium tracking-[-0.005em] text-foreground">{title}</h2>
      {sub && <p className="text-[13px] text-mute">{sub}</p>}
    </div>
  );
}

export type StatItem = {
  label: string;
  value: string | null;
  sub?: ReactNode;
  /** The exact figure, when the value is rounded for size. */
  title?: string;
  tone?: "default" | "sealed" | "danger" | "warn";
};

/**
 * A row of figures in one card, split by hairlines: two across on a phone,
 * up to five on a wide screen. A null value is still loading.
 */
export function StatStrip({ items, cols = 4 }: { items: StatItem[]; cols?: 2 | 3 | 4 | 5 }) {
  const lg = { 2: "lg:grid-cols-2", 3: "lg:grid-cols-3", 4: "lg:grid-cols-4", 5: "lg:grid-cols-5" }[cols];
  return (
    <section
      className={`grid grid-cols-2 gap-px overflow-hidden rounded-[18px] border border-line bg-line shadow-card ${lg} [&>*:last-child:nth-child(odd)]:col-span-2 lg:[&>*:last-child:nth-child(odd)]:col-span-1`}
    >
      {items.map((s) => (
        <div key={s.label} className="min-w-0 bg-panel px-4 py-4 sm:px-5 sm:py-5">
          <p className="text-[13px] leading-snug text-mute">{s.label}</p>
          {s.value == null ? (
            <span role="status" aria-label="Loading" className="gl-skeleton mt-3 block h-[26px] w-24" />
          ) : (
            <p
              title={s.title}
              className={`tnum mt-2.5 truncate text-[24px] font-light leading-none tracking-[-0.025em] sm:text-[28px] ${
                s.tone === "sealed" ? "text-sealed" : s.tone === "danger" ? "text-danger" : s.tone === "warn" ? "text-warn" : "text-foreground"
              }`}
            >
              {s.value}
            </p>
          )}
          {s.sub && <p className="mt-2 text-[12px] leading-snug text-faint">{s.sub}</p>}
        </div>
      ))}
    </section>
  );
}

type Tone = "info" | "warn" | "danger";

/** A one-line state across the page: a warning, an error, or plain information. */
export function Notice({ tone = "info", children, role }: { tone?: Tone; children: ReactNode; role?: "alert" | "status" }) {
  const cls =
    tone === "danger" ? "bg-danger-soft text-danger" : tone === "warn" ? "bg-warn-soft text-warn" : "bg-surface text-soft";
  return (
    <div role={role ?? (tone === "danger" ? "alert" : undefined)} className={`flex gap-3 rounded-[14px] px-4 py-3 text-[14px] leading-relaxed ${cls}`}>
      <span aria-hidden className="mt-[0.55em] h-1.5 w-1.5 shrink-0 rounded-full bg-current opacity-80" />
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/** A line that says what is loading. */
export function Loading({ label }: { label: string }) {
  return (
    <p className="flex items-center gap-2.5 rounded-[14px] bg-surface px-4 py-3 text-[14px] text-mute" role="status">
      <span className="livedot h-2 w-2 rounded-full bg-foreground/60" />
      {label}
    </p>
  );
}

/** A strip of figures and a panel, held in place while a tab's data loads. */
export function PanelSkeleton({ label }: { label: string }) {
  return (
    <div role="status" aria-busy="true" className="space-y-4">
      <span className="sr-only">{label}</span>
      <div className="gl-skeleton h-[104px] rounded-[18px] sm:h-[116px]" aria-hidden />
      <div className="gl-skeleton h-[260px] rounded-[18px]" aria-hidden />
    </div>
  );
}

/** Nothing to show yet, said plainly, in the space the content would take. */
export function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="grid min-h-[96px] place-items-center rounded-[14px] border border-dashed border-line-strong px-4 py-6 text-center text-[14px] text-mute">
      {children}
    </div>
  );
}

/** Horizontal bars for a funnel or a breakdown: label and count, then the bar. */
export function BarChart({ rows }: { rows: { k: string; v: number; pct: number; sub?: string }[] }) {
  if (rows.length === 0) return <Empty>No data</Empty>;
  return (
    <ul className="space-y-4">
      {rows.map((r) => (
        <li key={r.k}>
          <div className="mb-1.5 flex items-baseline justify-between gap-3 text-[13px]">
            <span className="min-w-0 truncate text-soft">
              {r.k}
              {r.sub && <span className="ml-2 text-[12px] text-faint">{r.sub}</span>}
            </span>
            <span className="tnum shrink-0 text-foreground">{r.v.toLocaleString("en-US")}</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-surface-2">
            <div
              className="h-full rounded-full bg-foreground transition-[width] duration-500 motion-reduce:transition-none"
              style={{ width: `${Math.max(r.pct, r.v > 0 ? 3 : 0)}%` }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}

/** Looks like a figure: a count, dollars, a share, or a "less than" one of those. */
const NUMERIC = /^(?:[<>~]?\s?[-+]?\$?[\d,]+(?:\.\d+)?(?:[KMB%]|\s?(?:ETH|GLOAM))?(?:\s\(\d[\d,]*\))?|Not priced|Unknown|#\d+)$/;

function isNumericCell(cell: ReactNode): boolean | null {
  if (cell === "" || cell == null) return null;
  if (typeof cell === "number") return true;
  if (typeof cell === "string") return NUMERIC.test(cell.trim());
  if (isValidElement(cell)) return false;
  return false;
}

/**
 * A table that scrolls sideways inside its card on a narrow screen. Columns
 * that hold only figures line up on the right.
 */
export function DataTable({
  headers,
  rows,
  empty,
  minWidth = 480,
  dense = false,
  wrap = [],
}: {
  headers: string[];
  rows: ReactNode[][];
  empty?: string;
  minWidth?: number;
  dense?: boolean;
  /** Columns of prose that wrap instead of running on. */
  wrap?: number[];
}) {
  if (rows.length === 0) return <Empty>{empty ?? "No rows"}</Empty>;
  const numeric = headers.map((_, j) => {
    let any = false;
    for (const r of rows) {
      const v = isNumericCell(r[j]);
      if (v === false) return false;
      if (v) any = true;
    }
    return any && j > 0;
  });
  return (
    <div className="overflow-x-auto rounded-[14px] border border-line">
      <table className="tnum w-full text-left text-[13.5px]" style={{ minWidth }}>
        <thead className="border-b border-line bg-surface">
          <tr>
            {headers.map((h, i) => (
              <th key={`${h}-${i}`} scope="col" className={`t-label whitespace-nowrap px-4 py-2.5 font-medium ${numeric[i] ? "text-right" : ""}`}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="border-b border-line transition-colors last:border-0 hover:bg-surface">
              {row.map((cell, j) => (
                <td
                  key={j}
                  className={`px-4 text-soft ${wrap.includes(j) ? "min-w-[240px] whitespace-normal leading-snug" : "whitespace-nowrap"} ${
                    dense ? "h-10 py-1.5" : "h-12 py-2"
                  } ${numeric[j] ? "text-right" : ""} ${j === 0 ? "text-foreground" : ""}`}
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** A quiet note under a panel's content. */
export function Note({ children }: { children: ReactNode }) {
  return <p className="mt-4 max-w-[90ch] text-[13px] leading-relaxed text-mute">{children}</p>;
}

/** A download or export link in a panel's header. */
export function CsvLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} className="btn btn-ghost btn-sm" download>
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
        <path d="M8 2.5v8M4.5 7.5 8 11l3.5-3.5M3 13.5h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      {children}
    </a>
  );
}
