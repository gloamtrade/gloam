"use client";

/**
 * The two card shapes the admin is built from.
 *
 * MetricCard: a title and a quieter second line with the week's change, an
 * open button, a chart in the middle and two figures at the foot. A rising
 * week gives the card a faint green top, a falling one a faint red top.
 *
 * StreamCard: a run of events. Who and what on the left, how long ago and
 * "N done · N failed" on the right, a dotted area of events over time with a
 * red marker where something failed, then one row of marks per source.
 */
import { useCallback, useState, type ReactNode } from "react";
import { StreamSpark, type Point } from "./charts";

export type Foot = { label: string; value: string | null; title?: string };

function Arrow({ dir = "up" }: { dir?: "up" | "down" }) {
  return (
    <svg width="9" height="9" viewBox="0 0 10 10" fill="none" aria-hidden className={dir === "down" ? "rotate-180" : ""}>
      <path d="M5 8.5v-7M2 4.5l3-3 3 3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** The week's change as a small pill: up green, down red, flat grey. */
export function DeltaPill({ pct, title }: { pct: number; title: string }) {
  const flat = Math.abs(pct) < 0.05;
  const up = pct > 0;
  const cls = flat ? "bg-surface-2 text-mute" : up ? "bg-sealed-soft text-sealed" : "bg-danger-soft text-danger";
  const text = Math.abs(pct) >= 1000 ? `${Math.round(Math.abs(pct) / 100) / 10}k%` : `${Math.abs(pct) >= 100 ? Math.round(Math.abs(pct)) : Math.abs(pct).toFixed(1)}%`;
  return (
    <span title={title} className={`tnum inline-flex h-[18px] items-center gap-[3px] rounded-full px-1.5 text-[10.5px] font-medium leading-none ${cls}`}>
      {!flat && <Arrow dir={up ? "up" : "down"} />}
      <span className="sr-only">{flat ? "Flat" : up ? "Up" : "Down"} </span>
      {flat ? "0%" : text}
    </span>
  );
}

const WEEK_TITLE = "The last 7 full UTC days against the 7 before them";

export function MetricCard({
  title,
  sub,
  delta,
  onOpen,
  openLabel,
  chart,
  foot,
  loading = false,
  className = "",
}: {
  title: string;
  sub: string;
  /** The week's change in percent; null leaves the pill out. */
  delta?: number | null;
  onOpen?: () => void;
  /** What the open button opens ("Revenue"). */
  openLabel?: string;
  chart: ReactNode;
  /** Two figures at the foot (or a legend in their place). */
  foot?: Foot[] | ReactNode;
  loading?: boolean;
  className?: string;
}) {
  const tint = delta == null || Math.abs(delta) < 0.05 ? null : delta > 0 ? "var(--sealed)" : "var(--danger)";
  return (
    <article className={`gl-card relative flex min-w-0 flex-col overflow-hidden p-5 ${className}`}>
      {tint && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 h-28"
          style={{ background: `linear-gradient(to bottom, color-mix(in srgb, ${tint} 9%, transparent), transparent)` }}
        />
      )}
      <header className="relative flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="truncate text-[15px] leading-tight tracking-[-0.01em] text-foreground">{title}</h2>
          <p className="mt-1 flex min-w-0 items-center gap-2 text-[14px] leading-tight text-mute">
            <span className="truncate">{sub}</span>
            {delta != null && <DeltaPill pct={delta} title={WEEK_TITLE} />}
          </p>
        </div>
        {onOpen && (
          <button
            type="button"
            onClick={onOpen}
            aria-label={`Open ${openLabel ?? title}`}
            title={`Open ${openLabel ?? title}`}
            className="gl-tap grid h-7 w-7 shrink-0 place-items-center rounded-full bg-surface-2 text-soft transition-colors hover:bg-line-strong hover:text-foreground"
          >
            <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden>
              <path d="M4.75 11.25l6.5-6.5M5.75 4.75h5.5v5.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        )}
      </header>
      <div className="relative mt-5 flex flex-1 flex-col justify-end">
        {loading ? <div className="gl-skeleton h-[148px]" role="status" aria-label="Loading" /> : <div className={foot ? "" : "flex flex-1 flex-col"}>{chart}</div>}
      </div>
      {Array.isArray(foot) ? (
        <dl className="relative mt-5 grid grid-cols-2 gap-4">
          {foot.map((f) => (
            <div key={f.label} className="min-w-0">
              <dt className="truncate text-[10px] font-medium uppercase tracking-[0.09em] text-faint">{f.label}</dt>
              {f.value == null || loading ? (
                <dd className="gl-skeleton mt-2 h-[26px] w-20" />
              ) : (
                <dd title={f.title} className="tnum mt-1.5 truncate text-[26px] font-light leading-none tracking-[-0.03em] text-foreground">
                  {f.value}
                </dd>
              )}
            </div>
          ))}
        </dl>
      ) : foot ? (
        <div className="relative mt-5">{foot}</div>
      ) : null}
    </article>
  );
}

export type StreamRow = { key: string; node: ReactNode };

export function StreamCard({
  icon,
  title,
  sub,
  elapsed,
  tally,
  chartLabel,
  chartUnit,
  points,
  marks,
  chartFoot,
  children,
  footer,
}: {
  icon: ReactNode;
  title: string;
  /** Where the events come from, small. */
  sub: ReactNode;
  /** Top right: how long ago, or since when. */
  elapsed: string;
  /** Top right, under the time: "138 done · 3 failed". A failure part turns red once it is above zero. */
  tally: { value: number; word: string; fail?: boolean }[];
  /** Over the chart, left ("Requests a day"). */
  chartLabel: string;
  /** "a day", "/day": after the hovered value on the right. */
  chartUnit: (v: number) => string;
  points: Point[];
  marks?: number[];
  /** Under the chart, left ("30 days · 141 requests"). */
  chartFoot: ReactNode;
  /** The rows of marks. */
  children: ReactNode;
  footer?: ReactNode;
}) {
  const [at, setAt] = useState<number | null>(null);
  const onPick = useCallback((i: number | null) => setAt(i), []);
  const peak = Math.max(0, ...points.map((p) => p.value));
  const shown = at != null ? points[at] : null;
  return (
    <article className="gl-card min-w-0 p-5 sm:p-6">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <span aria-hidden className="grid h-9 w-9 shrink-0 place-items-center rounded-[10px] bg-surface-2 text-soft">
            {icon}
          </span>
          <div className="min-w-0">
            <h2 className="truncate text-[16px] leading-tight tracking-[-0.01em] text-foreground">{title}</h2>
            <p className="mt-1 truncate text-[12.5px] leading-tight text-mute">{sub}</p>
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-baseline gap-x-2 pl-12 sm:block sm:pl-0 sm:text-right">
          <p className="tnum text-[15px] leading-tight text-foreground">{elapsed}</p>
          <p className="tnum text-[12.5px] leading-tight text-mute sm:mt-1">
            {tally.map((t, k) => (
              <span key={t.word}>
                {k > 0 && <span aria-hidden> · </span>}
                <span className={t.fail && t.value > 0 ? "text-danger" : ""}>
                  {t.value.toLocaleString("en-US")} {t.word}
                </span>
              </span>
            ))}
          </p>
        </div>
      </header>
      <div className="mt-5 flex items-baseline justify-between gap-3 text-[12px] text-mute">
        <span>{chartLabel}</span>
        <span className="tnum">{shown ? `${shown.label} · ${shown.display}` : `peak ${chartUnit(peak)}`}</span>
      </div>
      <div className="mt-2">
        <StreamSpark points={points} marks={marks} label={chartLabel} onPick={onPick} />
      </div>
      <p className="tnum mt-2 text-[12px] text-faint">{chartFoot}</p>
      <ul className="mt-5 space-y-3">{children}</ul>
      {footer && <div className="mt-5 border-t border-line pt-4">{footer}</div>}
    </article>
  );
}

/** Bare stroke icons for the run cards, in currentColor. */
export function StreamIcon({ kind }: { kind: "vault" | "bridge" | "events" | "bug" | "entry" | "person" }) {
  const p = { stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      {kind === "vault" && (
        <>
          <rect x="2.5" y="3" width="11" height="10" rx="2" {...p} />
          <circle cx="8" cy="8" r="2" {...p} />
          <path d="M8 6V3M8 13v-3" {...p} />
        </>
      )}
      {kind === "bridge" && <path d="M2 11.5h12M3.5 11.5V8.5a4.5 4.5 0 0 1 9 0v3M6 11.5V9M10 11.5V9" {...p} />}
      {kind === "events" && <path d="M2 8h2.5l1.5-4 3 8 1.5-4H14" {...p} />}
      {kind === "bug" && (
        <>
          <rect x="5" y="5" width="6" height="8" rx="3" {...p} />
          <path d="M8 5V3.5M5 8H2.5M11 8h2.5M5.5 11.5 3.5 13M10.5 11.5l2 1.5M6 4l-1-1.5M10 4l1-1.5" {...p} />
        </>
      )}
      {kind === "entry" && <path d="M3 3.5h10v9H3zM3 6.5h10M6 9.5h4" {...p} />}
      {kind === "person" && (
        <>
          <circle cx="8" cy="5.5" r="2.5" {...p} />
          <path d="M3 13.5c.6-2.4 2.6-4 5-4s4.4 1.6 5 4" {...p} />
        </>
      )}
    </svg>
  );
}
