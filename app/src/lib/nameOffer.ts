/**
 * The "Get your @name" offer on the portfolio: shown to a signed-in account
 * that has no name yet, until it gets one or closes the offer. A name is easier
 * to share than a gloamr1 address, so new accounts are offered one once.
 *
 * Closing it is remembered per account in this browser (lib/accountSlot), so a
 * second account here still gets its own offer. Signed out, nothing is offered
 * and nothing is written.
 */
import { scopedKey } from "./accountSlot";

export const NAME_OFFER_KEY = "gloam.names.offer.v1";
/** Where the offer leads: Receive, with the name form opened (GloamNameCard reads the hash). */
export const GET_NAME_HREF = "/app/vault?tab=move&mode=receive#get-name";
export const GET_NAME_HASH = "#get-name";

/** True once this account closed the offer in this browser. Signed out reads as closed. */
export function nameOfferClosed(): boolean {
  if (typeof window === "undefined") return true;
  const key = scopedKey(NAME_OFFER_KEY);
  if (!key) return true;
  try {
    return window.localStorage.getItem(key) === "closed";
  } catch {
    return false;
  }
}

/** Closes the offer for the signed-in account only. Does nothing signed out. */
export function closeNameOffer(): void {
  if (typeof window === "undefined") return;
  const key = scopedKey(NAME_OFFER_KEY);
  if (!key) return;
  try {
    window.localStorage.setItem(key, "closed");
  } catch {
    /* storage off: the offer comes back next visit, which is harmless */
  }
}

/**
 * Whether to show the offer. `owned` is null while the account's names are
 * still being read, so the card never flashes in and out.
 */
export function shouldOfferName(s: {
  registryLive: boolean;
  demo: boolean;
  signedIn: boolean;
  closed: boolean;
  owned: boolean | null;
}): boolean {
  return s.registryLive && !s.demo && s.signedIn && !s.closed && s.owned === false;
}

export const NAME_OWNED_KEY = "gloam.names.owned.v1";
/** How long a sure answer about owning a name is trusted, ms. */
export const NAME_OWNED_TTL_MS = 6 * 60 * 60 * 1000;

/** This account's last sure answer (owns a name or not), if fresh. Unknown reads as null. */
export function cachedNameOwned(now = Date.now()): boolean | null {
  if (typeof window === "undefined") return null;
  const key = scopedKey(NAME_OWNED_KEY);
  if (!key) return null;
  try {
    const v = JSON.parse(window.localStorage.getItem(key) ?? "null") as { owned?: unknown; at?: unknown } | null;
    if (!v || typeof v.owned !== "boolean" || typeof v.at !== "number" || now - v.at > NAME_OWNED_TTL_MS) return null;
    return v.owned;
  } catch {
    return null;
  }
}

/** Keeps a sure answer for this account only; an unknown one is never kept. */
export function rememberNameOwned(owned: boolean | null, now = Date.now()): void {
  if (typeof window === "undefined" || owned === null) return;
  const key = scopedKey(NAME_OWNED_KEY);
  if (!key) return;
  try {
    window.localStorage.setItem(key, JSON.stringify({ owned, at: now }));
  } catch {
    /* storage off: it is read again next visit */
  }
}
