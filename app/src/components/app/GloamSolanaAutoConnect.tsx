"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";
import {
  GLOAM_SOLANA_OFF,
  declinedAfter,
  gloamAccountDeclined,
  gloamSolana,
  isGloamAccount,
  onGloamSolana,
  onGloamSolanaSignedOut,
  setGloamAccountDeclined,
  shouldAutoConnect,
} from "@/lib/turnkeySolana";
import { useSolana } from "./SolanaAccount";

function localStore(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * Someone signed in with a Gloam wallet who picks Solana is connected to their
 * Gloam account (lib/turnkeySolana) at once: no "Connect a Solana wallet" step.
 * Another wallet stays theirs to pick: once they connect one, or Disconnect the
 * Gloam account, it is not connected for them again until they pick it
 * themselves (kept in this browser, per account). Signing out of the Gloam
 * wallet leaves its Solana account too. Lives inside SolanaAccountProvider;
 * renders nothing.
 */
export function GloamSolanaAutoConnect() {
  const sol = useSolana();
  const gloam = useSyncExternalStore(onGloamSolana, gloamSolana, () => GLOAM_SOLANA_OFF);
  const wallet = sol?.wallets.find(isGloamAccount) ?? null;
  const main = sol?.main ?? null;
  const usingGloam = main ? isGloamAccount(main.wallet) : false;
  const busy = Boolean(sol?.task);
  // Reconnecting a wallet this device stayed signed in with (when the account layer does that).
  const restoring = Boolean(sol && "restoring" in sol && sol.restoring === true);

  // The latest values, for the sign-out listener.
  const latest = useRef({ sol, usingGloam });
  useEffect(() => {
    latest.current = { sol, usingGloam };
  });

  // Signed out of the Gloam wallet: its Solana account goes too (not a choice against it).
  const leaving = useRef(false);
  const tried = useRef<string | null>(null);
  useEffect(
    () =>
      onGloamSolanaSignedOut(() => {
        tried.current = null;
        if (latest.current.usingGloam) leaving.current = true;
      }),
    [],
  );

  // What a change of wallet says: left the Gloam account, or picked it. Before the
  // sign-out below lets go of `leaving`, so leaving on a sign-out is never a choice.
  const prev = useRef<{ gloam: boolean } | null>(null);
  const mainKey = main ? `${usingGloam ? "gloam" : "other"}:${main.account.address}` : null;
  useEffect(() => {
    const next = main ? { gloam: usingGloam } : null;
    const was = prev.current;
    prev.current = next;
    const address = gloam.address;
    if (!address) return;
    const declined = declinedAfter(was, next, leaving.current);
    if (declined !== null) setGloamAccountDeclined(localStore(), address, declined);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs on a change of wallet, read through mainKey
  }, [mainKey]);

  useEffect(() => {
    if (!leaving.current || !sol) return;
    if (!usingGloam) {
      leaving.current = false;
      return;
    }
    if (!busy) sol.disconnect();
  }, [sol, usingGloam, busy, gloam.status]);

  // Connect it once Solana is picked and nothing else is connected.
  useEffect(() => {
    if (!sol || !wallet || !gloam.address) return;
    const go = shouldAutoConnect({
      on: sol.on,
      demo: sol.demo,
      connected: Boolean(main),
      busy,
      restoring,
      ready: gloam.status === "ready",
      declined: gloamAccountDeclined(localStore(), gloam.address),
      triedAlready: tried.current === gloam.address,
    });
    if (!go) return;
    tried.current = gloam.address;
    void sol.connect(wallet);
  }, [sol, wallet, main, busy, restoring, gloam.status, gloam.address]);

  return null;
}
