"use client";

/**
 * Hand-drawn SVG charts for /admin: stems (a lollipop series), day bars, a
 * tick donut, a dotted area sparkline and rows of event marks. One quiet
 * resting state, the series lighting up under the pointer or the arrow keys,
 * CSS transitions only (still under prefers-reduced-motion, see globals.css
 * `.adm-t`). Colour comes from tokens: ink for the data, the sealed green
 * for what is private, red only for failures.
 */
import { useEffect, useId, useMemo, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";

/** The element's width, kept current. */
export function useWidth(initial = 280) {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [w, setW] = useState(initial);
  useEffect(() => {
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(120, Math.round(e!.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return [setEl, w] as const;
}

export type Point = {
  /** The day or bucket, for the pill and screen readers ("Nov 3"). */
  label: string;
  /** Under the axis ("3"). */
  axis: string;
  value: number;
  /** The value as words in the pill ("$1,204"). */
  display: string;
};

/** The hovered or keyboard-picked point, and its handlers. */
function usePick(count: number) {
  const [pick, setPick] = useState<number | null>(null);
  const onKey = (e: KeyboardEvent) => {
    if (!count) return;
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      const d = e.key === "ArrowRight" ? 1 : -1;
      setPick((p) => Math.max(0, Math.min(count - 1, (p ?? count - 1) + d)));
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      setPick(e.key === "Home" ? 0 : count - 1);
    } else if (e.key === "Escape") {
      setPick(null);
    }
  };
  return { pick, setPick, onKey };
}

/** The value pill over a point. */
function Pill({ x, y, width, children, tone = "ink" }: { x: number; y: number; width: number; children: ReactNode; tone?: "ink" | "danger" }) {
  // keep it inside the chart: a pill is about 64px wide at most
  const left = Math.min(Math.max(x, 28), width - 28);
  return (
    <span
      className={`adm-t pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-full px-2 py-[3px] text-[11px] font-medium leading-none shadow-card ${
        tone === "danger" ? "bg-danger text-white" : "bg-foreground text-background"
      }`}
      style={{ left, top: y - 6 }}
    >
      {children}
    </span>
  );
}

/** An axis label's x and anchor, kept inside the chart at both ends. */
function axisAt(x: number, width: number): { x: number; anchor: "start" | "middle" | "end" } {
  if (x < 10) return { x: 0, anchor: "start" };
  if (x > width - 10) return { x: width, anchor: "end" };
  return { x, anchor: "middle" };
}

/** Which axis labels to print so they never collide: about one per 34px. */
function axisEvery(count: number, width: number): number {
  return Math.max(1, Math.ceil(count / Math.max(1, Math.floor(width / 34))));
}

/** Whether point i gets an axis label: every `every`th, and always the newest, with room before it. */
function showAxis(i: number, count: number, every: number): boolean {
  const last = count - 1;
  if (i === last) return true;
  return i % every === 0 && last - i >= Math.max(1, Math.ceil(every * 0.75));
}

function ChartEmpty({ height, children }: { height: number; children: ReactNode }) {
  return (
    <div className="grid place-items-center rounded-[12px] border border-dashed border-line-strong text-center text-[13px] text-mute" style={{ height }}>
      <span className="px-4">{children}</span>
    </div>
  );
}

/**
 * Stems: one thin line a day with a dot on top. At rest the newest point is
 * lit with its pill; under the pointer every point up to the hovered one
 * lights up, so the run to that day reads at a glance.
 */
export function StemChart({
  points,
  label,
  height = 148,
  tone = "ink",
  empty = "Nothing yet",
}: {
  points: Point[];
  /** What the series is, for screen readers. */
  label: string;
  height?: number;
  tone?: "ink" | "sealed";
  empty?: string;
}) {
  const [ref, width] = useWidth();
  const { pick, setPick, onKey } = usePick(points.length);
  const max = Math.max(0, ...points.map((p) => p.value));
  if (!points.length || max <= 0) return <ChartEmpty height={height}>{empty}</ChartEmpty>;

  const padT = 26;
  const padB = 20;
  const plot = height - padT - padB;
  const base = padT + plot;
  const band = width / points.length;
  const active = pick ?? points.length - 1;
  const every = axisEvery(points.length, width);
  const lit = tone === "sealed" ? "var(--sealed)" : "var(--foreground)";
  const xs = points.map((_, i) => band * i + band / 2);
  const hs = points.map((p) => (p.value / max) * (plot - 4));
  const cur = points[active]!;

  return (
    <div
      ref={ref}
      tabIndex={0}
      role="group"
      aria-label={`${label}. Arrow keys move between days.`}
      onKeyDown={onKey}
      onBlur={() => setPick(null)}
      onPointerMove={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        setPick(Math.max(0, Math.min(points.length - 1, Math.floor((e.clientX - r.left) / band))));
      }}
      onPointerLeave={() => setPick(null)}
      className="relative rounded-[10px] outline-none focus-visible:ring-2 focus-visible:ring-line-strong"
      style={{ height }}
    >
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden className="block">
        <line x1={0} x2={width} y1={base + 0.5} y2={base + 0.5} stroke="var(--line)" />
        {points.map((p, i) => {
          const on = pick == null ? i === active : i <= active;
          const here = i === active;
          const top = base - hs[i]!;
          const delay = pick == null ? 0 : Math.min(240, Math.max(0, active - i) * 6);
          return (
            <g key={p.label} className="adm-t" style={{ transitionDelay: `${delay}ms` }}>
              {hs[i]! > 0 && (
                <line
                  x1={xs[i]}
                  x2={xs[i]}
                  y1={base}
                  y2={top}
                  stroke={on ? lit : "var(--line-strong)"}
                  strokeWidth={here ? 1.75 : 1.1}
                  strokeOpacity={on && !here ? 0.85 : 1}
                  className="adm-t"
                />
              )}
              <circle
                cx={xs[i]}
                cy={hs[i]! > 0 ? top : base}
                r={here ? 3.4 : hs[i]! > 0 ? 2 : 1.2}
                fill={on ? lit : "var(--faint)"}
                fillOpacity={on ? 1 : 0.7}
                className="adm-t"
              />
              {showAxis(i, points.length, every) ? (
                <text
                  x={axisAt(xs[i]!, width).x}
                  y={height - 4}
                  textAnchor={axisAt(xs[i]!, width).anchor}
                  fontSize={10}
                  className="tnum adm-t"
                  fill={here ? "var(--foreground)" : "var(--faint)"}
                >
                  {p.axis}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
      <Pill x={xs[active]!} y={base - hs[active]!} width={width}>
        {cur.display}
      </Pill>
      <span className="sr-only" aria-live="polite">
        {pick == null ? "" : `${cur.label}: ${cur.display}`}
      </span>
    </div>
  );
}

/**
 * Bars, one a day. The newest bar (or the hovered one) is lit white on dark,
 * ink on light, with its value above; the bars before a hovered one go a
 * shade up, so the run reads.
 */
export function DayBars({
  points,
  label,
  height = 148,
  empty = "Nothing yet",
}: {
  points: Point[];
  label: string;
  height?: number;
  empty?: string;
}) {
  const [ref, width] = useWidth();
  const { pick, setPick, onKey } = usePick(points.length);
  const max = Math.max(0, ...points.map((p) => p.value));
  if (!points.length || max <= 0) return <ChartEmpty height={height}>{empty}</ChartEmpty>;

  const padT = 26;
  const padB = 20;
  const plot = height - padT - padB;
  const base = padT + plot;
  const band = width / points.length;
  const bw = Math.max(3, Math.min(16, band * 0.62));
  const active = pick ?? points.length - 1;
  const every = axisEvery(points.length, width);
  const cur = points[active]!;

  return (
    <div
      ref={ref}
      tabIndex={0}
      role="group"
      aria-label={`${label}. Arrow keys move between days.`}
      onKeyDown={onKey}
      onBlur={() => setPick(null)}
      onPointerMove={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        setPick(Math.max(0, Math.min(points.length - 1, Math.floor((e.clientX - r.left) / band))));
      }}
      onPointerLeave={() => setPick(null)}
      className="relative rounded-[10px] outline-none focus-visible:ring-2 focus-visible:ring-line-strong"
      style={{ height }}
    >
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden className="block">
        {points.map((p, i) => {
          const h = p.value > 0 ? Math.max(3, (p.value / max) * (plot - 4)) : 2;
          const x = band * i + (band - bw) / 2;
          const here = i === active;
          const before = pick != null && i < active;
          const fill = here
            ? "var(--foreground)"
            : before
              ? "var(--mute)"
              : p.value > 0
                ? "color-mix(in srgb, var(--foreground) 14%, transparent)"
                : "var(--line)";
          const r = Math.min(bw / 2, 6);
          return (
            <g key={p.label}>
              <rect x={x} y={base - h} width={bw} height={h} rx={Math.min(r, h / 2)} fill={fill} fillOpacity={before ? 0.55 : 1} className="adm-t" />
              {showAxis(i, points.length, every) ? (
                <text
                  x={axisAt(x + bw / 2, width).x}
                  y={height - 4}
                  textAnchor={axisAt(x + bw / 2, width).anchor}
                  fontSize={10}
                  className="tnum adm-t"
                  fill={here ? "var(--foreground)" : "var(--faint)"}
                >
                  {p.axis}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
      <Pill x={band * active + band / 2} y={base - (cur.value > 0 ? Math.max(3, (cur.value / max) * (plot - 4)) : 2)} width={width}>
        {cur.display}
      </Pill>
      <span className="sr-only" aria-live="polite">
        {pick == null ? "" : `${cur.label}: ${cur.display}`}
      </span>
    </div>
  );
}

export type Segment = {
  key: string;
  label: string;
  value: number;
  /** The value as words, for the legend's title and screen readers. */
  display: string;
  /** Sealed green for a private kind; ink otherwise. */
  tone?: "ink" | "sealed";
  /** A shorter name for the legend ("Robinhood"). */
  short?: string;
};

/** Ink shades for the donut's segments, strongest first. */
const SHADES = [
  "var(--foreground)",
  "color-mix(in srgb, var(--foreground) 58%, transparent)",
  "color-mix(in srgb, var(--foreground) 34%, transparent)",
  "color-mix(in srgb, var(--foreground) 18%, transparent)",
];

/** Up to four segments: the biggest three and the rest as "Other". */
export function topSegments(segs: Segment[], otherDisplay: (v: number) => string): Segment[] {
  const s = segs.filter((x) => x.value > 0).sort((a, b) => b.value - a.value);
  if (s.length <= 4) return s;
  const rest = s.slice(3).reduce((a, b) => a + b.value, 0);
  return [...s.slice(0, 3), { key: "other", label: "Other", value: rest, display: otherDisplay(rest) }];
}

/**
 * A ring of thin radial ticks, each segment a run of them, the total in the
 * middle and a two-by-two legend with shares under it. Pointing at a segment,
 * on the ring or in the legend, lights its ticks and puts its share in the
 * middle.
 */
export function TickDonut({
  segments,
  total,
  centerLabel,
  label,
  size = 148,
  ticks = 84,
}: {
  segments: Segment[];
  /** The total as words for the middle ("$12,400"). */
  total: string;
  /** Over the total, small ("In the vault"). */
  centerLabel: string;
  label: string;
  size?: number;
  ticks?: number;
}) {
  const [hot, setHot] = useState<string | null>(null);
  const sum = segments.reduce((a, s) => a + s.value, 0);
  const shade = (s: Segment, i: number) => (s.tone === "sealed" ? "var(--sealed)" : SHADES[Math.min(i, SHADES.length - 1)]!);

  // tick i belongs to the segment its middle falls in; a sliver that is not zero keeps one tick
  const owner = useMemo(() => {
    if (!(sum > 0)) return Array.from({ length: ticks }, () => -1);
    const counts = segments.map((s) => (s.value > 0 ? Math.max(1, Math.round((s.value / sum) * ticks)) : 0));
    let over = counts.reduce((a, b) => a + b, 0) - ticks;
    for (let i = 0; over !== 0 && i < counts.length * 4; i++) {
      const j = counts.indexOf(Math.max(...counts));
      counts[j]! += over > 0 ? -1 : 1;
      over += over > 0 ? -1 : 1;
    }
    return counts.flatMap((c, i) => Array.from({ length: c }, () => i));
  }, [segments, sum, ticks]);

  const r2 = size / 2 - 4;
  const r1 = r2 - 15;
  const c = size / 2;
  const hotIdx = segments.findIndex((s) => s.key === hot);
  const hotSeg = hotIdx >= 0 ? segments[hotIdx]! : null;

  const fromAngle = (e: PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - r.left - r.width / 2;
    const y = e.clientY - r.top - r.height / 2;
    const d = Math.hypot(x, y);
    if (d < (r1 - 8) * (r.width / size)) return setHot(null);
    const a = (Math.atan2(y, x) * 180) / Math.PI + 90;
    const i = Math.floor((((a % 360) + 360) % 360) / (360 / ticks));
    const o = owner[i];
    setHot(o != null && o >= 0 ? segments[o]!.key : null);
  };

  return (
    <div className="flex flex-1 flex-col justify-between gap-5">
      <div className="relative mx-auto" style={{ width: size, height: size }}>
        <svg
          width={size}
          height={size}
          viewBox={`0 0 ${size} ${size}`}
          role="img"
          aria-label={`${label}: ${segments.map((s) => `${s.label} ${s.display}`).join(", ") || "none yet"}`}
          onPointerMove={fromAngle}
          onPointerLeave={() => setHot(null)}
          className="block"
        >
          {Array.from({ length: ticks }, (_, i) => {
            const o = owner[i] ?? -1;
            const seg = o >= 0 ? segments[o]! : null;
            const on = hotSeg ? o === hotIdx : true;
            const color = !seg ? "var(--line-strong)" : hotSeg && on ? (seg.tone === "sealed" ? "var(--sealed)" : "var(--foreground)") : shade(seg, o);
            const a = (i / ticks) * 360;
            return (
              <line
                key={i}
                x1={c}
                x2={c}
                y1={c - r1 + (hotSeg && on ? -2 : 0)}
                y2={c - r2 - (hotSeg && on ? 2 : 0)}
                transform={`rotate(${a} ${c} ${c})`}
                stroke={color}
                strokeWidth={hotSeg && on ? 2.1 : 1.5}
                strokeLinecap="round"
                opacity={hotSeg && !on ? 0.22 : 1}
                className="adm-t"
              />
            );
          })}
        </svg>
        <div className="pointer-events-none absolute inset-0 grid place-items-center text-center">
          <div style={{ maxWidth: (r1 - 6) * 2 }} className="min-w-0">
            <p className="truncate text-[9.5px] font-medium uppercase leading-none tracking-[0.09em] text-faint">{hotSeg ? (hotSeg.short ?? hotSeg.label) : centerLabel}</p>
            <p className="tnum mt-1.5 whitespace-nowrap text-[21px] font-light leading-none tracking-[-0.03em] text-foreground">
              {hotSeg ? `${sum > 0 ? Math.round((hotSeg.value / sum) * 100) : 0}%` : total}
            </p>
          </div>
        </div>
      </div>
      <ul className="grid grid-cols-2 gap-x-3 gap-y-1">
        {segments.length === 0 ? (
          <li className="col-span-2 text-center text-[12.5px] text-mute">None yet</li>
        ) : (
          segments.map((s, i) => (
            <li key={s.key} className="min-w-0">
              <button
                type="button"
                onPointerEnter={() => setHot(s.key)}
                onPointerLeave={() => setHot(null)}
                onFocus={() => setHot(s.key)}
                onBlur={() => setHot(null)}
                title={`${s.label}: ${s.display}`}
                className={`adm-t flex min-h-7 w-full items-center gap-1.5 rounded-md text-left text-[12px] outline-none focus-visible:ring-2 focus-visible:ring-line-strong ${
                  hotSeg && hot !== s.key ? "opacity-45" : ""
                }`}
              >
                <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: shade(s, i) }} />
                <span className="min-w-0 flex-1 truncate text-soft">{s.short ?? s.label}</span>
                <span className="tnum shrink-0 text-foreground">{sum > 0 ? `${Math.round((s.value / sum) * 100)}%` : "0%"}</span>
              </button>
            </li>
          ))
        )}
      </ul>
    </div>
  );
}

/** A smooth path through the points that never overshoots (monotone cubic). */
function monotonePath(xs: number[], ys: number[]): string {
  const n = xs.length;
  if (n === 0) return "";
  if (n === 1) return `M${xs[0]},${ys[0]}`;
  const dx = xs.slice(1).map((x, i) => x - xs[i]!);
  const s = ys.slice(1).map((y, i) => (y - ys[i]!) / dx[i]!);
  const m = ys.map((_, i) => (i === 0 ? s[0]! : i === n - 1 ? s[n - 2]! : s[i - 1]! * s[i]! <= 0 ? 0 : (s[i - 1]! + s[i]!) / 2));
  for (let i = 0; i < n - 1; i++) {
    if (s[i] === 0) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = m[i]! / s[i]!;
    const b = m[i + 1]! / s[i]!;
    const h = a * a + b * b;
    if (h > 9) {
      const t = 3 / Math.sqrt(h);
      m[i] = t * a * s[i]!;
      m[i + 1] = t * b * s[i]!;
    }
  }
  let d = `M${xs[0]},${ys[0]}`;
  for (let i = 0; i < n - 1; i++) {
    const h = dx[i]! / 3;
    d += `C${xs[i]! + h},${ys[i]! + m[i]! * h} ${xs[i + 1]! - h},${ys[i + 1]! - m[i + 1]! * h} ${xs[i + 1]},${ys[i + 1]}`;
  }
  return d;
}

/**
 * The run card's chart: a line over a dotted area, a dot on the newest
 * point, and a red marker on each bucket where something failed.
 */
export function StreamSpark({
  points,
  marks = [],
  label,
  height = 92,
  onPick,
}: {
  points: Point[];
  /** Indexes of the buckets with a failure. */
  marks?: number[];
  label: string;
  height?: number;
  /** Told which point is hovered, for the caption. */
  onPick?: (i: number | null) => void;
}) {
  const [ref, width] = useWidth();
  const { pick, setPick, onKey } = usePick(points.length);
  const pattern = useId().replace(/:/g, "");
  useEffect(() => onPick?.(pick), [pick, onPick]);
  const max = Math.max(0, ...points.map((p) => p.value));
  if (!points.length) return <ChartEmpty height={height}>Nothing yet</ChartEmpty>;

  const padT = 12;
  const padB = 6;
  const padX = 8;
  const plot = height - padT - padB;
  const base = padT + plot;
  const step = points.length > 1 ? (width - padX * 2) / (points.length - 1) : 0;
  const xs = points.map((_, i) => padX + step * i);
  const ys = points.map((p) => (max > 0 ? base - (p.value / max) * (plot - 6) : base));
  const line = monotonePath(xs, ys);
  const area = `${line}L${xs[xs.length - 1]},${base}L${xs[0]},${base}Z`;
  const last = points.length - 1;
  const at = pick ?? last;

  return (
    <div
      ref={ref}
      tabIndex={0}
      role="group"
      aria-label={`${label}. Arrow keys move between points.`}
      onKeyDown={onKey}
      onBlur={() => setPick(null)}
      onPointerMove={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        const i = step > 0 ? Math.round((e.clientX - r.left - padX) / step) : 0;
        setPick(Math.max(0, Math.min(last, i)));
      }}
      onPointerLeave={() => setPick(null)}
      className="relative overflow-hidden rounded-[10px] bg-surface outline-none focus-visible:ring-2 focus-visible:ring-line-strong"
      style={{ height }}
    >
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden className="block">
        <defs>
          <pattern id={pattern} width="4" height="4" patternUnits="userSpaceOnUse">
            <circle cx="1" cy="1" r="0.7" fill="var(--foreground)" fillOpacity="0.42" />
          </pattern>
        </defs>
        <line x1={0} x2={width} y1={base + 0.5} y2={base + 0.5} stroke="var(--line-strong)" />
        {max > 0 && <path d={area} fill={`url(#${pattern})`} />}
        {marks.map((i) =>
          xs[i] == null ? null : (
            <g key={`m${i}`}>
              <line x1={xs[i]} x2={xs[i]} y1={padT - 4} y2={base} stroke="var(--danger)" strokeWidth={1} />
              <rect x={xs[i]! - 1.75} y={padT - 6} width={3.5} height={3.5} rx={0.6} fill="var(--danger)" />
            </g>
          )
        )}
        <path d={line} fill="none" stroke="var(--foreground)" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
        {pick != null && <line x1={xs[at]} x2={xs[at]} y1={padT - 4} y2={base} stroke="var(--line-strong)" strokeDasharray="2 3" />}
        <circle cx={xs[at]} cy={ys[at]} r={3.2} fill="var(--foreground)" className="adm-t" />
        <circle cx={xs[at]} cy={ys[at]} r={6.5} fill="var(--foreground)" fillOpacity={0.14} className="adm-t" />
      </svg>
      <span className="sr-only" aria-live="polite">
        {pick == null ? "" : `${points[at]!.label}: ${points[at]!.display}`}
      </span>
    </div>
  );
}

export type Mark = {
  /** ok: landed or done. private: a private one that landed. public: a public one that landed. failed. pending: started, not finished. */
  tone: "ok" | "private" | "public" | "failed" | "pending";
  /** Said on hover. */
  title: string;
};

const MARK_CLASS: Record<Mark["tone"], string> = {
  ok: "bg-sealed",
  private: "bg-sealed",
  public: "bg-soft",
  failed: "bg-danger",
  pending: "bg-line-strong",
};

/**
 * One row of a run card: a label, one mark per event (oldest left, newest
 * right) and a figure on the right. A phone stacks the label over the marks.
 */
export function TickRow({
  label,
  marks,
  right,
  rightTone = "mute",
  max = 44,
  dim = false,
}: {
  label: string;
  marks: Mark[];
  right: ReactNode;
  rightTone?: "mute" | "danger" | "foreground";
  /** Marks shown at most; the newest are kept. */
  max?: number;
  dim?: boolean;
}) {
  const shown = marks.slice(-max);
  const hidden = marks.length - shown.length;
  const failed = marks.filter((m) => m.tone === "failed").length;
  return (
    <li
      className={`adm-tickrow adm-t ${dim ? "opacity-55" : ""}`}
      aria-label={`${label}: ${marks.length} ${marks.length === 1 ? "event" : "events"}${failed ? `, ${failed} failed` : ""}`}
    >
      <span className="adm-tickrow-label truncate text-[13px] text-soft" title={label}>
        {label}
      </span>
      <span className="adm-tickrow-marks flex min-w-0 items-center gap-[2.5px] overflow-hidden" aria-hidden>
        {hidden > 0 && <span className="mr-1 shrink-0 text-[10.5px] text-faint tnum">+{hidden}</span>}
        {shown.map((m, i) => (
          <span key={i} title={m.title} className={`h-3.5 w-[4px] shrink-0 rounded-[1.5px] ${MARK_CLASS[m.tone]}`} />
        ))}
        {shown.length === 0 && <span className="text-[12px] text-faint">None</span>}
      </span>
      <span
        className={`adm-tickrow-right tnum text-right text-[12.5px] ${
          rightTone === "danger" ? "text-danger" : rightTone === "foreground" ? "text-foreground" : "text-mute"
        }`}
      >
        {right}
      </span>
    </li>
  );
}

/** The key under a run card: what each mark colour means. */
export function MarkKey({ items }: { items: [Mark["tone"], string][] }) {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-mute">
      {items.map(([tone, text]) => (
        <li key={text} className="inline-flex items-center gap-1.5">
          <span aria-hidden className={`h-2.5 w-[3px] rounded-[1px] ${MARK_CLASS[tone]}`} />
          {text}
        </li>
      ))}
    </ul>
  );
}
