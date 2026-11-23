"use client";

/**
 * Tells Gloam an add to a private balance landed (lib/solanaRings/client
 * addToPrivate, paid by the wallet or by Gloam's relay), so /admin can count
 * it: when the wallet pays, the chain names no Gloam account, so it can't tell
 * that add from any other app's. The server checks the signature on chain
 * before keeping it, once per signature (app/api/solana/added). Never waited
 * on, never retried, and a failure changes nothing: the add is already done.
 * Nothing is added to the transaction itself.
 */
import { RINGS_ADDED_PATH } from "./config";

export function noteWalletAdd(signature: string): void {
  try {
    void fetch(new URL(RINGS_ADDED_PATH, location.origin), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ signature }),
      cache: "no-store",
      keepalive: true,
    }).catch(() => {});
  } catch {
    /* no page to report from */
  }
}
