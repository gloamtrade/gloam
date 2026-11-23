/**
 * Where each signed-in account's automatic receive (lib/autoReceive) stopped
 * reading each network's payment-memo board: a block number in localStorage,
 * one per account and vault.
 *
 * Kept apart from autoReceive so the receive keys (lib/receiveTag) can reset
 * it without an import loop: when keys are restored from a backup or a new
 * address is made, payments sent while this browser couldn't open them are
 * on blocks it already read past, so the next pass has to start over.
 */
import { scopedKey } from "./accountSlot";

export const RECEIVE_CURSOR_BASE = "gloam.receive.cursor.v1";

/** Bumped by every reset: a pass that began before it doesn't write its cursor after it. */
let epoch = 0;

export function receiveCursorEpoch(): number {
  return epoch;
}

/** This account's key for one vault's cursor, or null while no account is bound. */
export function receiveCursorKey(chainId: number, pool: string): string | null {
  return scopedKey(`${RECEIVE_CURSOR_BASE}:${chainId}:${pool.toLowerCase()}`);
}

/**
 * Forgets where this account's reads stopped, on every network, so the next
 * pass reads each board from its start. Other accounts' cursors are left alone.
 */
export function resetReceiveCursors(): void {
  epoch++;
  if (typeof window === "undefined") return;
  const probe = scopedKey("x");
  if (probe === null) return;
  // "" for the browser's first account (keys with no suffix), else "@<slot>"
  const suffix = probe.slice(1);
  try {
    const keys: string[] = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i);
      if (k && k.startsWith(`${RECEIVE_CURSOR_BASE}:`)) keys.push(k);
    }
    for (const k of keys) {
      const at = k.indexOf("@");
      if ((at >= 0 ? k.slice(at) : "") === suffix) window.localStorage.removeItem(k);
    }
  } catch {
    /* storage off: nothing was kept to reset */
  }
}
