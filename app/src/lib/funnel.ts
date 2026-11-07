/**
 * Claim-link counts: four daily totals that show whether the invite loop works.
 *
 *   link_created   someone made a claim link and the payment landed
 *   link_opened    a claim link was opened in Gloam
 *   link_claimed   a claim link was claimed into a balance
 *   claimer_sent   someone who claimed a link made their own first payment
 *
 * Each event is only "add 1 to today's total", plus whether it happened on
 * mainnet or a testnet: no cookie, no id, no amount, no address, no code. They run without the cookie banner because nothing in them
 * can say who did what (the privacy and cookie pages say so). Whether this
 * browser already counted something is kept in local storage only, so the
 * server never learns it.
 */
import { readDemo } from "./demoFlag";
import { getActiveNetwork, getNetwork, isNetworkKey } from "./networks";

export type FunnelEvent = "link_created" | "link_opened" | "link_claimed" | "claimer_sent";

export const FUNNEL_EVENTS: readonly FunnelEvent[] = ["link_created", "link_opened", "link_claimed", "claimer_sent"];

export type FunnelEnv = "mainnet" | "testnet";

/** Mainnet or a testnet: the network a link names, else the one the app is on. */
function envOf(networkKey?: string | null): FunnelEnv | undefined {
  try {
    const n = networkKey && isNetworkKey(networkKey) ? getNetwork(networkKey) : getActiveNetwork();
    return n.testnet ? "testnet" : "mainnet";
  } catch {
    return undefined;
  }
}

/** This browser's own memory: links it already counted as opened, and whether it claimed one and has sent since. */
const KEY = "gloam.funnel.v1";
const MAX_OPENED = 50;

type Local = { opened: string[]; claimed?: 1; sent?: 1 };

function load(): Local {
  try {
    const v = JSON.parse(window.localStorage.getItem(KEY) ?? "null") as Local | null;
    return v && Array.isArray(v.opened) ? v : { opened: [] };
  } catch {
    return { opened: [] };
  }
}

function save(v: Local) {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(v));
  } catch {
    /* private window: the count still goes out, it just may repeat */
  }
}

/** A plain claim link or code, the kind anyone can claim (a payment sealed to an address is not one). */
export function isClaimLink(code: string): boolean {
  return /gloam(?:1e?|3)[.=-][A-Za-z0-9_-]/.test(code);
}

/** A short local fingerprint of a code, so opening the same link twice counts once. Never sent anywhere. */
function fingerprint(code: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < code.length; i++) {
    h ^= code.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

function send(e: FunnelEvent, networkKey?: string | null) {
  if (typeof window === "undefined" || readDemo()) return;
  try {
    const env = envOf(networkKey);
    const body = JSON.stringify(env ? { e, env } : { e });
    if (navigator.sendBeacon?.("/api/funnel", new Blob([body], { type: "application/json" }))) return;
    void fetch("/api/funnel", { method: "POST", headers: { "Content-Type": "application/json" }, body, keepalive: true }).catch(() => {});
  } catch {
    /* counting never gets in the way */
  }
}

/** A claim-link payment landed. */
export function countLinkCreated() {
  send("link_created");
}

/** A claim link was opened in Gloam (once per link per browser). `networkKey` is the link's own ?net=. */
export function countLinkOpened(code: string, networkKey?: string | null) {
  if (typeof window === "undefined" || !isClaimLink(code)) return;
  const v = load();
  const f = fingerprint(code.trim());
  if (v.opened.includes(f)) return;
  v.opened = [f, ...v.opened].slice(0, MAX_OPENED);
  save(v);
  send("link_opened", networkKey);
}

/** A claim link was claimed into this browser's balance. */
export function countLinkClaimed(code: string) {
  if (typeof window === "undefined" || !isClaimLink(code)) return;
  const v = load();
  v.claimed = 1;
  save(v);
  send("link_claimed");
}

/** A private payment landed: the first one after this browser claimed a link counts once. */
export function countSendAfterClaim() {
  if (typeof window === "undefined") return;
  const v = load();
  if (!v.claimed || v.sent) return;
  v.sent = 1;
  save(v);
  send("claimer_sent");
}
