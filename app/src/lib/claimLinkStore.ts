/**
 * Keeps a claim link opened in the app ready in this tab until it is claimed.
 *
 * Pay > Receive reads the payment out of the address bar and clears it there at
 * once (a claim link is bearer), so it then lived only in the page. Signing in
 * with an email sends the person to their mail app for the code, and a phone
 * that drops the tab meanwhile reloaded an empty claim box: the payment was gone
 * from the page and the person had to find the link again. Kept here, the claim
 * box fills itself in again after a reload.
 *
 * sessionStorage: this tab only, gone when the tab closes, never sent anywhere
 * and never logged. Only the code and its network, as the link carried them.
 * It is read back for CLAIM_LINK_KEEP_MS, and dropped the moment the payment is
 * claimed into this browser, or the person clears the box or picks another
 * payment.
 *
 * Also held here, in memory only: whether a payment waits in the claim box on
 * this page right now, so the new-wallet sheet (EmbeddedWalletFlow) points back
 * to it instead of Add funds, and that sheet's way back to the claim button.
 */
import { isNetworkKey, type NetworkKey } from "./networks";

const KEY = "gloam.claimLink";
export const CLAIM_LINK_KEEP_MS = 30 * 60_000;

type Kept = { code: string; on: NetworkKey | null; at: number };

/** A payment code as a claim link carries it: gloam1, gloam1e, gloam2t or gloam3, then its body. */
function looksLikeCode(code: unknown): code is string {
  return typeof code === "string" && code.length <= 8192 && /^gloam(?:1e?|2t|3)\.[A-Za-z0-9_\-.]{16,}$/.test(code);
}

/** Keeps the code a claim link opened, and the network it named, for this tab. */
export function keepClaimLink(code: string, on: NetworkKey | null, now = Date.now()): void {
  if (!looksLikeCode(code)) return;
  try {
    window.sessionStorage.setItem(KEY, JSON.stringify({ code, on: isNetworkKey(on) ? on : null, at: now } satisfies Kept));
  } catch {
    /* private mode / blocked storage: the payment stays in the page until a reload */
  }
}

/** The kept code and its network, or null when none, too old or unreadable (which is dropped). */
export function keptClaimLink(now = Date.now()): { code: string; on: NetworkKey | null } | null {
  try {
    const raw = window.sessionStorage.getItem(KEY);
    if (!raw) return null;
    let k: Partial<Kept> | null = null;
    try {
      k = JSON.parse(raw) as Partial<Kept>;
    } catch {
      k = null;
    }
    const fresh = typeof k?.at === "number" && now - k.at >= 0 && now - k.at < CLAIM_LINK_KEEP_MS;
    if (!k || !fresh || !looksLikeCode(k.code) || (k.on !== null && !isNetworkKey(k.on))) {
      window.sessionStorage.removeItem(KEY);
      return null;
    }
    return { code: k.code, on: k.on ?? null };
  } catch {
    return null;
  }
}

/** Forgets the kept claim link: claimed, cleared or replaced. */
export function dropClaimLink(): void {
  try {
    window.sessionStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

/* ---------------------------------------------------------------- waiting */

let waiting = false;
const waitingListeners = new Set<() => void>();

/** Pay > Receive says whether its claim box holds a payment that isn't claimed yet. */
export function setClaimWaiting(v: boolean): void {
  if (v === waiting) return;
  waiting = v;
  waitingListeners.forEach((fn) => fn());
}

export function claimWaiting(): boolean {
  return waiting;
}

export function onClaimWaiting(fn: () => void): () => void {
  waitingListeners.add(fn);
  return () => waitingListeners.delete(fn);
}

/* ---------------------------------------------------------------- back to it */

const focusListeners = new Set<() => void>();

/** Takes the person back to the claim box and its button (from the new-wallet sheet). */
export function goToClaim(): void {
  focusListeners.forEach((fn) => fn());
}

export function onGoToClaim(fn: () => void): () => void {
  focusListeners.add(fn);
  return () => focusListeners.delete(fn);
}
