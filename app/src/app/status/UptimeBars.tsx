"use client";

import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
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

/** How long a day picked by touch stays shown. */
const TOUCH_SHOW_MS = 2_500;

/**
 * One part's days or hours since its first check, oldest first. The bars are thin in a card, so the day is
 * picked from where the pointer is along the strip, by mouse or by touch.
 * Keyboard: one Tab stop per strip; the arrow keys, Home and End move a day.
 */
export function UptimeBars({ name, days }: { name: string; days: BarDay[] }) {
  const track = useRef<HTMLDivElement>(null);
  const bars = useRef<(HTMLSpanElement | null)[]>([]);
  const tip = useRef<HTMLDivElement>(null);
  const touchTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [focusIdx, setFocusIdx] = useState(days.length - 1);
  const [shown, setShown] = useState<number | null>(null);

  useEffect(() => () => clearTimeout(touchTimer.current), []);

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

  const pick = (e: PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    if (r.width <= 0) return;
    const i = Math.min(days.length - 1, Math.max(0, Math.floor(((e.clientX - r.left) / r.width) * days.length)));
    setShown(i);
    clearTimeout(touchTimer.current);
    if (e.pointerType !== "mouse") touchTimer.current = setTimeout(() => setShown(null), TOUCH_SHOW_MS);
  };

  const move = (to: number) => {
    const el = bars.current[to];
    if (!el) return;
    setFocusIdx(to);
    setShown(to);
    el.focus();
  };

  const onKey = (e: KeyboardEvent<HTMLSpanElement>, i: number) => {
    if (e.key === "ArrowLeft") move(Math.max(0, i - 1));
    else if (e.key === "ArrowRight") move(Math.min(days.length - 1, i + 1));
    else if (e.key === "Home") move(0);
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
        data-active={shown === null ? undefined : ""}
        onPointerMove={pick}
        onPointerDown={pick}
        onPointerLeave={(e) => {
          if (e.pointerType === "mouse") setShown(null);
        }}
      >
        {days.map((day, i) => (
          <span
            key={day.day}
            ref={(el) => {
              bars.current[i] = el;
            }}
            role="img"
            tabIndex={i === Math.min(focusIdx, days.length - 1) ? 0 : -1}
            aria-label={`${day.label}: ${day.uptime ? `${day.uptime} up` : "no data"}${detail(day) ? `, ${detail(day)}` : ""}`}
            data-tone={day.tone}
            data-active={shown === i ? "true" : undefined}
            className={css.bar}
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
