"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useTransition } from "react";

/**
 * A status page left open stays current: fetched again every minute while it is
 * in view, and at once when its tab comes back into view after 30 seconds or
 * more away (a background tab skips the minute ticks, so it could show a
 * check from half an hour ago).
 */
export function AutoRefresh({ everyMs = 60_000 }: { everyMs?: number }) {
  const router = useRouter();
  const last = useRef(0);
  useEffect(() => {
    last.current = Date.now();
    const refresh = () => {
      last.current = Date.now();
      router.refresh();
    };
    const id = setInterval(() => {
      if (document.visibilityState === "visible") refresh();
    }, everyMs);
    const onVisible = () => {
      if (document.visibilityState === "visible" && Date.now() - last.current > 30_000) refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [router, everyMs]);
  return null;
}

/** Fetches the latest checks now. The cron runs them every 5 minutes; this reads its newest run. */
export function RefreshButton({ className = "" }: { className?: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <button
      type="button"
      onClick={() => start(() => router.refresh())}
      disabled={pending}
      aria-label="Refresh status"
      title="Refresh status"
      className={`grid place-items-center rounded-full text-mute transition-colors hover:bg-surface hover:text-foreground disabled:opacity-60 ${className}`}
    >
      <svg
        aria-hidden
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        className={pending ? "animate-spin motion-reduce:animate-none" : undefined}
      >
        <path
          d="M20 12a8 8 0 1 1-2.34-5.66M20 4v4.5h-4.5"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
}
