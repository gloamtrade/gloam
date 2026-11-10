"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import {
  MAINNET_CONFIGURED,
  MAINNET_LAUNCH_MS,
  calendarUrl,
  liveMainnetNames,
  remainingUntil,
  type Remaining,
} from "@/lib/mainnet";
import { AppLink } from "@/components/AppLink";

/** A countdown that has reached zero: the same on every clock past the launch time. */
const LAUNCHED: Remaining = remainingUntil(MAINNET_LAUNCH_MS);

/**
 * The time left to mainnet, ticking once a second. Before the launch it is
 * null until mounted, so the server and the first render agree. Once the
 * launch time has passed the answer no longer depends on the clock, so it is
 * there from the first render, server included: the HTML a crawler, a link
 * preview or a slow phone gets says mainnet is live instead of counting down
 * to a date that has gone by.
 */
export function useMainnetRemaining(): Remaining | null {
  const [r, setR] = useState<Remaining | null>(() => (Date.now() >= MAINNET_LAUNCH_MS ? LAUNCHED : null));
  useEffect(() => {
    if (Date.now() >= MAINNET_LAUNCH_MS) return; // launched: nothing to count
    let id = 0;
    const tick = () => {
      const next = remainingUntil(Date.now());
      setR(next);
      if (next.done) window.clearInterval(id); // nothing left to count
    };
    id = window.setInterval(tick, 1000);
    tick();
    return () => window.clearInterval(id);
  }, []);
  return r;
}

/**
 * Whether mainnet is live: the launch time has passed and a mainnet pool is
 * filled in (lib/mainnet.ts). After the launch time that holds from the first
 * render; it stays false for as long as no pool is in, so the countdown copy
 * stays as it was.
 */
export function useMainnetLive(): boolean {
  const r = useMainnetRemaining();
  return Boolean(r?.done) && MAINNET_CONFIGURED;
}

/**
 * Copy that depends on whether mainnet is live, for server pages: `before`
 * until mainnet is live, `live` from then on, in the server HTML too. Before a
 * mainnet pool is filled in it is always `before`.
 */
export function MainnetCopy({ live, before }: { live: React.ReactNode; before: React.ReactNode }) {
  return <>{useMainnetLive() ? live : before}</>;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** The big countdown: days, hours, minutes, seconds. */
export function CountdownDigits({ onDone, onLive }: { onDone?: React.ReactNode; onLive?: React.ReactNode }) {
  const r = useMainnetRemaining();
  if (r?.done && MAINNET_CONFIGURED && onLive) return <>{onLive}</>;
  if (r?.done && onDone) return <>{onDone}</>;
  const units: [string, string][] = [
    ["Days", r ? pad(r.days) : "--"],
    ["Hours", r ? pad(r.hours) : "--"],
    ["Minutes", r ? pad(r.minutes) : "--"],
    ["Seconds", r ? pad(r.seconds) : "--"],
  ];
  const label = r ? `${r.days} days, ${r.hours} hours and ${r.minutes} minutes to mainnet` : "Countdown to mainnet";
  return (
    <div role="timer" aria-live="off" aria-label={label} className="grid grid-cols-4 gap-2 sm:gap-4">
      {units.map(([name, value]) => (
        <div key={name} className="gl-glass min-w-0 rounded-2xl px-2 pb-3 pt-4 text-center sm:px-4 sm:pb-5 sm:pt-6">
          <p aria-hidden className="tnum text-[clamp(40px,9vw,128px)] font-light leading-none tracking-[-0.04em]">
            {value}
          </p>
          <p aria-hidden className="t-label mt-3 sm:mt-4">
            {name}
          </p>
        </div>
      ))}
    </div>
  );
}

const noopSubscribe = () => () => {};

/** The launch time in the browser's time zone; null in UTC, on the server, or without Intl. */
function localLaunchText(): string | null {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (!zone || zone === "UTC" || zone === "Etc/UTC") return null;
    return new Intl.DateTimeFormat(undefined, {
      weekday: "long",
      day: "numeric",
      month: "long",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    }).format(new Date(MAINNET_LAUNCH_MS));
  } catch {
    /* Intl unavailable: UTC alone is fine */
    return null;
  }
}

/** The launch time in the viewer's own time zone, when it isn't UTC. Once live it is history, so it steps aside. */
export function LocalLaunchTime() {
  const text = useSyncExternalStore(noopSubscribe, localLaunchText, () => null);
  const live = useMainnetLive();
  if (!text || live) return null;
  return <>Your time: {text}</>;
}

/* ---------- the parts of the page that flip to live ---------- */

/** The countdown page headline. */
export function MainnetHeadline() {
  const live = useMainnetLive();
  return (
    <h1 className="t-display-xl mt-5 max-w-[16ch]">
      {live ? "Gloam is live on mainnet" : "Gloam goes live on mainnet"}
    </h1>
  );
}

/** What replaces the digits once mainnet is live. */
export function MainnetLiveNote() {
  return (
    <div className="flex flex-col gap-3">
      <p className="t-display-l max-w-[22ch]">Private payments, on mainnet.</p>
      <p className="max-w-[46ch] text-[16px] leading-relaxed text-soft">Live on {liveMainnetNames()}.</p>
    </div>
  );
}

/** Calendar and X before launch; the app and X once live. */
export function MainnetHeroActions() {
  const live = useMainnetLive();
  return (
    <div className="mt-6 flex flex-wrap gap-2">
      {live ? (
        <AppLink href="/app" className="btn btn-ink btn-lg">
          Open the app
        </AppLink>
      ) : (
        <a href={calendarUrl()} target="_blank" rel="noopener noreferrer" className="btn btn-ink btn-lg">
          Add to calendar
        </a>
      )}
      <a href="https://x.com/gloamtrade" target="_blank" rel="noopener noreferrer" className="btn btn-quiet btn-lg">
        Follow on X <span aria-hidden>→</span>
      </a>
    </div>
  );
}

/** The line about the testnet at the foot of the countdown page. */
export function MainnetTestnetLine() {
  const live = useMainnetLive();
  return (
    <p className="max-w-[46ch] text-[15px] leading-relaxed text-soft">
      {live
        ? "The testnet stays open for trying things first."
        : "Until then, everything works on testnet."}
    </p>
  );
}
