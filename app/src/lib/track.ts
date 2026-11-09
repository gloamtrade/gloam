/**
 * Product analytics → POST /api/collect → traction store + /admin.
 *
 * Nothing is sent unless the visitor chose "Accept all" in the cookie banner:
 * no product events, no pageviews. "Essential only", or no choice yet, counts
 * nothing.
 */

import { analyticsUrl } from "@/lib/analyticsClean";
import { analyticsAllowed } from "@/lib/consent";
import { readDemo } from "@/lib/demoFlag";
import { getActiveNetwork } from "@/lib/networks";
import type { TrackEvent } from "@/lib/trackEvents";

/** Which network the visitor is on, so mainnet and testnet activity can be told apart. */
function networkMeta(): TrackPayload["meta"] {
  try {
    const n = getActiveNetwork();
    return { network: n.key, mainnet: !n.testnet };
  } catch {
    return {};
  }
}

export type TrackPayload = {
  t: TrackEvent;
  path?: string;
  ref?: string | null;
  meta?: Record<string, string | number | boolean | null>;
  ts?: number;
};

function send(body: TrackPayload) {
  if (typeof window === "undefined") return;
  try {
    const json = JSON.stringify(body);
    if (navigator.sendBeacon) {
      navigator.sendBeacon(
        "/api/collect",
        new Blob([json], { type: "application/json" }),
      );
      return;
    }
    void fetch("/api/collect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: json,
      keepalive: true,
    });
  } catch {
    /* ignore */
  }
}

/** Product / funnel events, only after "Accept all" (anonymous, no cookies). */
export function track(
  event: TrackEvent,
  meta?: TrackPayload["meta"],
  _opts?: { requireConsent?: boolean },
) {
  void _opts; // kept so older callers compile; every event needs consent now
  if (typeof window === "undefined") return;
  if (!analyticsAllowed()) return;
  // Recording demo: pretend activity never counts toward real traction.
  if (readDemo()) return;

  send({
    t: event,
    path: analyticsUrl(window.location.pathname),
    ref: document.referrer ? analyticsUrl(document.referrer) : null,
    meta: { ...networkMeta(), ...(meta ?? {}) },
    ts: Date.now(),
  });
}

/** Marketing pageviews, only after "Accept all". */
export function trackPageview() {
  track("pageview", undefined, { requireConsent: true });
}
