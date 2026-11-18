"use client";

import { useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import type { DayTone } from "@/lib/status/model";
import css from "./status.module.css";

export interface BarDay {
  day: string;
  /** "19 Nov 2026" */
  label: string;
  tone: DayTone;
  /** "99.95%", or null for a day with no checks. */
  uptime: string | null;
  down: number;
  degraded: number;
}

function detail(d: BarDay): string | null {
  const bits: string[] = [];
  if (d.down) bits.push(`${d.down} ${d.down === 1 ? "check" : "checks"} down`);
  if (d.degraded) bits.push(`${d.degraded} degraded`);
  return bits.length ? bits.join(" · ") : null;
}

function visible(el: Element | null | undefined): el is HTMLElement {
  return !!el && (el as HTMLElement).getClientRects().length > 0;
}

/**
 * One part's days, oldest first. Hover or focus a day for its date and
 * uptime. One Tab stop per row: the arrow keys, Home and End move between the
 * days that fit the screen.
 */
export function UptimeBars({ name, days }: { name: string; days: BarDay[] }) {
  const track = useRef<HTMLDivElement>(null);
  const bars = useRef<(HTMLSpanElement | null)[]>([]);
  const tip = useRef<HTMLDivElement>(null);
  const [focusIdx, setFocusIdx] = useState(days.length - 1);
  const [shown, setShown] = useState<number | null>(null);

  useLayoutEffect(() => {
    const t = tip.current;
    const bar = shown === null ? null : bars.current[shown];
    const box = track.current;
    if (!t || !bar || !box) return;
    const center = bar.offsetLeft + bar.offsetWidth / 2;
    const half = t.offsetWidth / 2;
    const left = Math.min(Math.max(center, half), box.clientWidth - half);
    t.style.left = `${left - half}px`;
  }, [shown]);

  const move = (to: number) => {
    const el = bars.current[to];
    if (!visible(el)) return;
    setFocusIdx(to);
    setShown(to);
    el.focus();
  };

  const onKey = (e: KeyboardEvent<HTMLSpanElement>, i: number) => {
    if (e.key === "ArrowLeft") move(i - 1);
    else if (e.key === "ArrowRight") move(i + 1);
    else if (e.key === "Home") move(bars.current.findIndex((b) => visible(b)));
    else if (e.key === "End") move(days.length - 1);
    else if (e.key === "Escape") setShown(null);
    else return;
    e.preventDefault();
  };

  const d = shown === null ? null : days[shown];
  const extra = d ? detail(d) : null;

  return (
    <div ref={track} className={css.track}>
      <div
        className={css.bars}
        role="group"
        aria-label={`${name}, day by day`}
        onMouseLeave={() => setShown(null)}
      >
        {days.map((day, i) => (
          <span
            key={day.day}
            ref={(el) => {
              bars.current[i] = el;
            }}
            role="img"
            tabIndex={i === focusIdx ? 0 : -1}
            aria-label={`${day.label}: ${day.uptime ? `${day.uptime} up` : "no data"}${detail(day) ? `, ${detail(day)}` : ""}`}
            data-tone={day.tone}
            data-active={shown === i ? "true" : undefined}
            className={css.bar}
            onMouseEnter={() => setShown(i)}
            onFocus={() => {
              setFocusIdx(i);
              setShown(i);
            }}
            onBlur={() => setShown(null)}
            onKeyDown={(e) => onKey(e, i)}
          />
        ))}
      </div>
      {d ? (
        <div ref={tip} className={css.tip} aria-hidden>
          <div className="font-medium">{d.label}</div>
          <div className="tnum text-soft">{d.uptime ? `${d.uptime} up` : "No data"}</div>
          {extra ? <div className="tnum text-mute">{extra}</div> : null}
        </div>
      ) : null}
    </div>
  );
}
