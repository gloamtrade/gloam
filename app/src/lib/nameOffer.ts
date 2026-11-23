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
