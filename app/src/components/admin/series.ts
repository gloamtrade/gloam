import type { Point } from "./charts";
import { dayOfMonth, fmtDay, lastDays, n, utcDay } from "./format";

/** A daily series from rows that carry a UTC day, oldest first. */
export function dayPoints<T extends { day: string }>(rows: T[], value: (r: T) => number, display: (v: number) => string): Point[] {
  return rows.map((r) => {
    const v = value(r);
    return { label: fmtDay(r.day), axis: dayOfMonth(r.day), value: v, display: display(v) };
  });
}

/**
 * How many things happened each UTC day over the last `days` days, from their
 * times in milliseconds. `word` names one ("entry", "entries").
 */
export function countPoints(times: number[], days: number, now: number, word: [string, string]): Point[] {
  const counts = new Map<string, number>();
  for (const t of times) {
    const d = utcDay(t);
    counts.set(d, (counts.get(d) ?? 0) + 1);
  }
  return lastDays(days, now).map((day) => {
    const v = counts.get(day) ?? 0;
    return { label: fmtDay(day), axis: dayOfMonth(day), value: v, display: `${n(v)} ${v === 1 ? word[0] : word[1]}` };
  });
}

/** The indexes of the days in `points` (from countPoints/dayPoints) on which any of `times` fell. */
export function markDays(points: Point[], days: string[], times: number[]): number[] {
  const hit = new Set(times.map(utcDay));
  return days.map((d, i) => (hit.has(d) && points[i] ? i : -1)).filter((i) => i >= 0);
}
