/**
 * Keeps an opened swap link (lib/swapLink) ready in this tab while the person
 * goes to Add first. Without it, Vault > Add and back opens a blank Swap tab.
 * sessionStorage: this tab only, gone when it closes, and only the fragment as
 * the link carried it (tokens, an amount, a sender's name), never anything
 * about the person. It is read back for SWAP_LINK_KEEP_MS, and dropped once
 * the swap lands or the person closes the link.
 */
import type { NetworkKey } from "./networks";
import { isNetworkKey } from "./networks";

const KEY = "gloam.swapLink";
export const SWAP_LINK_KEEP_MS = 30 * 60_000;

type Kept = { frag: string; on: NetworkKey; at: number };

export function keepSwapLink(frag: string, on: NetworkKey, now = Date.now()): void {
  try {
    window.sessionStorage.setItem(KEY, JSON.stringify({ frag, on, at: now } satisfies Kept));
  } catch {
    /* private mode / blocked storage: the link in the address bar still works */
  }
}

/** The kept fragment and the network it was read on, or null when none, too old or unreadable. */
export function keptSwapLink(now = Date.now()): { frag: string; on: NetworkKey } | null {
  try {
    const raw = window.sessionStorage.getItem(KEY);
    if (!raw) return null;
    const k = JSON.parse(raw) as Partial<Kept>;
    const fresh = typeof k.at === "number" && now - k.at >= 0 && now - k.at < SWAP_LINK_KEEP_MS;
    if (!fresh || typeof k.frag !== "string" || !isNetworkKey(k.on)) {
      window.sessionStorage.removeItem(KEY);
      return null;
    }
    return { frag: k.frag, on: k.on };
  } catch {
    return null;
  }
}

export function dropSwapLink(): void {
  try {
    window.sessionStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
