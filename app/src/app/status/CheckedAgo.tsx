"use client";

import { useSyncExternalStore } from "react";
import { formatUtc } from "@/lib/status/model";

const TICK_MS = 30_000;

function subscribe(onChange: () => void): () => void {
  const id = setInterval(onChange, TICK_MS);
  return () => clearInterval(id);
}

/** The time, in 30-second steps, so the snapshot holds still between ticks. */
const tick = () => Math.floor(Date.now() / TICK_MS);
const noTick = () => null;

function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return "less than a minute ago";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return `${h} ${h === 1 ? "hour" : "hours"} ago`;
}

/**
 * "Last checked 2 min ago". The page is cached for up to a minute, so the
 * server writes the time itself (UTC) and the browser turns it into how long
 * ago, kept fresh while the page is open.
 */
export function CheckedAgo({ at }: { at: number }) {
  const step = useSyncExternalStore(subscribe, tick, noTick);
  return (
    <time dateTime={new Date(at).toISOString()} title={formatUtc(at)}>
      Last checked {step === null ? formatUtc(at) : ago(step * TICK_MS - at)}
    </time>
  );
}
