/**
 * Keeps a Solana claim link opened in the app ready in this tab until it is
 * claimed, as lib/claimLinkStore does on the other chains.
 *
 * Receive reads the link out of the address bar and clears it there at once
 * (it is bearer), so it then lives only in the page. Connecting a wallet can
 * leave the tab (a wallet app on a phone), and a reload would lose the claim:
 * kept here, the claim box fills itself in again.
 *
 * sessionStorage: this tab only, gone when the tab closes, never sent anywhere
 * and never logged. Read back for SOLANA_CLAIM_KEEP_MS, and dropped once the
 * link is claimed, turns out used, or the person clears the box or signs out.
 */
import { decodeClaim } from "./claimLink";
import { SOLANA_CLAIM_KEY } from "./config";

export { SOLANA_CLAIM_KEY };
export const SOLANA_CLAIM_KEEP_MS = 15 * 60_000;

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function session(): Store | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

/** Keep a link's body for this tab. Anything that isn't a whole claim link is not kept. */
export function keepSolanaClaim(body: string, storage: Store | null = session(), now = Date.now()): void {
  if (!storage || !decodeClaim(body).ok) return;
  try {
    storage.setItem(SOLANA_CLAIM_KEY, JSON.stringify({ body, at: now }));
  } catch {
    /* private mode: the link stays in the page until a reload */
  }
}

/** The kept body, or null when none, too old or unreadable (which is dropped). */
export function keptSolanaClaim(storage: Store | null = session(), now = Date.now()): string | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(SOLANA_CLAIM_KEY);
    if (!raw) return null;
    let k: { body?: unknown; at?: unknown } | null = null;
    try {
      k = JSON.parse(raw) as { body?: unknown; at?: unknown };
    } catch {
      k = null;
    }
    const fresh = typeof k?.at === "number" && now - k.at >= 0 && now - k.at < SOLANA_CLAIM_KEEP_MS;
    if (!fresh || typeof k?.body !== "string" || !decodeClaim(k.body).ok) {
      storage.removeItem(SOLANA_CLAIM_KEY);
      return null;
    }
    return k.body;
  } catch {
    return null;
  }
}

export function dropSolanaClaim(storage: Store | null = session()): void {
  try {
    storage?.removeItem(SOLANA_CLAIM_KEY);
  } catch {
    /* ignore */
  }
}
