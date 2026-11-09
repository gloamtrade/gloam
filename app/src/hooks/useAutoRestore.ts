"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { useSignMessage } from "wagmi";
import { useAppAccount } from "@/lib/demo";
import {
  autoRestoreFallback,
  autoRestoreStatus,
  autoRestoreSyncing,
  autoRestoreTried,
  clearAutoRestoreChecking,
  markAutoRestoreChecking,
  planAutoRestore,
  runAutoRestore,
  subscribeAutoRestore,
  type AutoRestoreStatus,
  type WalletKind,
} from "@/lib/autoRestore";
import { otherWalletNotes } from "@/lib/embeddedRecovery";
import { EMBEDDED_CONNECTOR_ID } from "@/lib/embeddedWallet";
import { dataKeyLocked, getAllNotes, syncFromDisk, unlockNoteVault } from "@/lib/noteVault";
import {
  recoveryServerState,
  recoveryState,
  recoveryTurnedOffHere,
  startRecoverySync,
  subscribeRecovery,
  type RecoveryWallet,
} from "@/lib/recovery";
import { isTempoWallet } from "@/lib/tempoWallet";
import { getActiveTurnkeyAccount } from "@/lib/turnkeyBridge";

const IDLE_SERVER: AutoRestoreStatus = { kind: "idle" };

/**
 * Brings the connected wallet's private balance back on this device by itself
 * (lib/autoRestore), and says how that is going.
 *
 * `missing`: this wallet has deposits this browser holds no note for (null where
 * the page doesn't know). Only a page that knows can ask a browser wallet for its
 * one signature; a Gloam wallet signs silently, so it runs wherever this is used.
 */
export function useAutoRestore(missing: boolean | null) {
  const { address, isConnected, connector, demo } = useAppAccount();
  const { signMessageAsync } = useSignMessage();
  const recovery = useSyncExternalStore(subscribeRecovery, recoveryState, recoveryServerState);
  const status = useSyncExternalStore(
    subscribeAutoRestore,
    () => autoRestoreStatus(address),
    () => IDLE_SERVER,
  );
  const active = Boolean(isConnected && !demo && address);
  const kind: WalletKind = connector?.id === EMBEDDED_CONNECTOR_ID ? "embedded" : isTempoWallet(connector) ? "tempo" : "browser";
  /** Notes here from other wallets, read once the notes are open. */
  const [held, setHeld] = useState<{ for: string; other: number } | null>(null);

  useEffect(() => {
    startRecoverySync();
  }, []);

  useEffect(() => {
    if (!active || !address) return;
    let live = true;
    void (async () => {
      await unlockNoteVault();
      await syncFromDisk();
      if (live) setHeld({ for: address, other: otherWalletNotes(getAllNotes(), address) });
    })();
    return () => {
      live = false;
    };
  }, [active, address]);

  const wallet = useCallback(
    (): RecoveryWallet => ({
      address: address as string,
      sign: (message) => {
        // A Gloam wallet signs inside Turnkey with no prompt.
        const account = kind === "embedded" ? getActiveTurnkeyAccount() : null;
        if (account && account.address.toLowerCase() === (address as string).toLowerCase()) return account.signMessage({ message });
        return signMessageAsync({ message });
      },
    }),
    [address, kind, signMessageAsync],
  );

  const plan =
    active && address
      ? planAutoRestore({
          kind,
          ready: recovery.ready && held?.for === address,
          on: recovery.on,
          turnedOff: recoveryTurnedOffHere(),
          otherNotes: held?.other ?? 0,
          missing,
          tried: autoRestoreTried(address, kind),
        })
      : null;
  const planKey = plan ? (plan.run === "no" ? `no:${plan.why}` : plan.run) : "none";

  useEffect(() => {
    if (!active || !address || !plan) return;
    if (plan.run === "no") {
      // A Gloam wallet's restore needs no one, so until it can start the balance reads as syncing, not 0.
      const expectSilent =
        plan.why === "wait" && kind === "embedded" && !recovery.on && !dataKeyLocked() && !autoRestoreTried(address, kind);
      if (expectSilent) markAutoRestoreChecking(address);
      else clearAutoRestoreChecking(address);
      return;
    }
    // Once per page: a run that ended (restored, no backup, failed) is not started again by itself.
    // A failure is offered again from the card, and on the next load.
    if (status.kind !== "idle" && status.kind !== "checking") return;
    void runAutoRestore(address, wallet(), plan.run, kind);
    // planKey stands for the plan
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, address, planKey, kind, recovery.on, wallet, status.kind]);

  /** Asks the wallet again, from the fallback card. */
  const retry = useCallback(() => {
    if (!address) return;
    void runAutoRestore(address, wallet(), kind === "embedded" ? "silent" : "prompt", kind);
  }, [address, kind, wallet]);

  return {
    status,
    plan,
    kind,
    /** The balance may still change because a restore is under way. */
    syncing: active && autoRestoreSyncing(status),
    fallback: (passkey: boolean) => (plan ? autoRestoreFallback({ kind, status, plan, passkey }) : null),
    retry,
  };
}
