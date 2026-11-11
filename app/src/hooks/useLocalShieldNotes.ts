"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Address } from "viem";
import { publicClientFor } from "@/lib/rhClient";
import { DEMO_ADDRESS, useDemoLive } from "@/lib/demo";
import { readDemo } from "@/lib/demoFlag";
import { unlockNoteVault, syncFromDisk, onNotesSaved, NOTES_KEY } from "@/lib/noteVault";
import {
  isUnsecuredClaim,
  reconcileClaims,
  reconcileUnfunded,
  reopenGhostEthNotes,
  secureClaimsInBackground,
} from "@/lib/claimSweep";
import { reconcileCashOuts } from "@/lib/cashOutLater";
import { markSpentNotes } from "@/lib/spentCheck";
import {
  activeSpendableNotes,
  confirmedNotes,
  unfundedClaims,
  fetchChainShieldNotes,
  ghostEthNotes,
  heldSwapRefunds,
  loadLocalNotes,
  loadWalletNotes,
  markNoteRecovered,
  mergeNotes,
  proofLoose,
  purgeSenderPaymentNotes,
  visibleNotes,
  shieldPoolAbi,
  sumByAsset,
  sumEthWei,
  type LocalNote,
} from "@/lib/shield";
import { useNetwork } from "@/components/app/NetworkProvider";
import type { GloamNetwork } from "@/lib/networks";

/**
 * How often the page syncs while a note a reverted swap left behind waits to
 * move, or a claimed payment waits to be secured (each try is paced in
 * lib/claimSweep, so most of these only read).
 */
const MOVE_SYNC_MS = 60_000;

/**
 * Local notes + chain history. Balance only counts notes with a local secret
 * that are not spent on-chain.
 *
 * `address` is the wallet connected now. With none, it shows nothing: no
 * notes, no totals (lib/shield notesForWallet). Everything it returns is for
 * that wallet, from the render the wallet signs out or changes in.
 *
 * Reads over the shown network's own RPC, not the wallet's.
 */
export function useLocalShieldNotes(address?: string | null) {
  const { network, settled } = useNetwork();
  // Recording demo: the pretend wallet's notes are read on every render, so a
  // network switch or a change made in another view shows straight away.
  const demo = useDemoLive();
  // Whose notes a view shows. In the recording demo every note is the pretend
  // wallet's (lib/demo/store, never this browser's own) and that wallet is always
  // connected, so a view that reads wagmi's own account (VaultTradePanel) still
  // lists them, as before.
  const wallet = demo ? address || DEMO_ADDRESS : address;
  const [local, setLocal] = useState<LocalNote[]>([]);
  const [chain, setChain] = useState<LocalNote[]>([]);
  const [ready, setReady] = useState(false);
  const [syncing, setSyncing] = useState(false);
  // the note store has been decrypted: `local` is every note this browser holds here
  const [unlocked, setUnlocked] = useState(false);
  const lastFocusSync = useRef(0);
  // The network shown now, for async work to check it is still on the network it started on.
  // Updated before the effects below run (effects run in order), so a sync started for the
  // new network never sees the old key.
  const shownKey = useRef(network.key);
  useEffect(() => {
    shownKey.current = network.key;
  }, [network.key]);

  // Read again on every network switch: the vault address can be the same on
  // the new network, so the address alone never triggers it.
  const refreshLocal = useCallback(() => {
    purgeSenderPaymentNotes();
    setLocal(loadWalletNotes(wallet, network));
    setReady(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wallet, network.key]);

  // every note asked at once (lib/spentCheck), not one read after another
  const reconcileSpent = useCallback(
    async (notes: LocalNote[], net: GloamNetwork) => {
      if (!net.pool) return;
      const any = await markSpentNotes(publicClientFor(net), notes, net).catch(() => false);
      if (any && shownKey.current === net.key) {
        setLocal(loadWalletNotes(address, net));
      }
    },
    [address]
  );

  const syncChain = useCallback(async () => {
    // Recording demo: the pretend wallet has no chain history to merge in.
    if (!address || !network.pool || readDemo()) {
      setChain([]);
      setSyncing(false);
      return;
    }
    // the first render's network is a placeholder until this browser's choice is read
    if (!settled) return;
    // Everything below reads and writes this one network, even if the page
    // switches while it runs; its results are only shown if it is still on it.
    const net = network;
    const pool = net.pool!;
    const still = () => shownKey.current === net.key;
    setSyncing(true);
    try {
      const publicClient = publicClientFor(net);
      // The wallet's deposits are only read here, so their walk starts now and
      // runs alongside the passes below instead of after them.
      const rowsP = fetchChainShieldNotes(publicClient, address as Address, net);
      // Claimed payments that reached the vault since, then secured claims and
      // cash-out splits whose move landed (or never can) since last time.
      if ((await reconcileUnfunded().catch(() => false)) && still()) setLocal(loadWalletNotes(address, net));
      if ((await reconcileClaims().catch(() => false)) && still()) setLocal(loadWalletNotes(address, net));
      // Claimed payments the payer can still take back: secured through the relay with no one
      // asking, once any move already sent has been settled above (never sent twice). Not waited on.
      void secureClaimsInBackground().catch(() => undefined);
      // once per vault: ETH notes an older sync wrongly marked spent, reopened while the vault still holds them
      if ((await reopenGhostEthNotes().catch(() => false)) && still()) setLocal(loadWalletNotes(address, net));
      // Spent checks only ask about notes with a secret, which chain rows never
      // have, so they run on this browser's notes without waiting for the walk.
      const spentP = reconcileSpent(loadLocalNotes(address, net), net);
      const rows = await rowsP;
      await spentP;
      if (!still()) return;
      setChain(rows);
      // Scheduled cash outs, after spent notes are retired: one that came back
      // unsent (and is unspent on its chain) makes its note spendable again.
      if ((await reconcileCashOuts().catch(() => false)) && still()) setLocal(loadWalletNotes(address, net));
      // Cash outs sent later from a partner's link: report the ones that have gone out (never waited on).
      void import("@/lib/partnerLinkClient").then((m) => m.processPartnerQueue()).catch(() => undefined);
      // Ghost-note cleanup for old notes with no nullifier (isSpent can't
      // settle them): an empty ETH inventory means none of them is left. Read
      // and applied on this sync's own network only, so a switch halfway
      // through can't apply another chain's empty inventory to this one's notes.
      try {
        const ethInPool = (await publicClient.readContract({
          address: pool,
          abi: shieldPoolAbi,
          functionName: "deposited",
          args: ["0x0000000000000000000000000000000000000000"],
        })) as bigint;
        if (ethInPool === BigInt(0)) {
          const ghosts = ghostEthNotes(loadLocalNotes(address, net), net);
          for (const n of ghosts) markNoteRecovered(n.id);
          if (ghosts.length && still()) setLocal(loadWalletNotes(address, net));
        }
      } catch {
        /* ignore */
      }
    } finally {
      // a sync of a network no longer shown leaves the current one's flag alone
      if (still()) setSyncing(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, reconcileSpent, network.key, settled]);

  const refresh = useCallback(() => {
    refreshLocal();
    void syncChain();
  }, [refreshLocal, syncChain]);

  useEffect(() => {
    let cancelled = false;
    // Show any legacy plaintext at once (on the next microtask, so the effect
    // body itself sets no state), then decrypt the vault and re-read.
    void Promise.resolve().then(() => {
      if (!cancelled) refreshLocal();
    });
    void unlockNoteVault().then(() => {
      if (cancelled) return;
      refreshLocal();
      setUnlocked(true);
    });
    return () => {
      cancelled = true;
    };
  }, [refreshLocal]);

  useEffect(() => {
    // Start on the next microtask so the effect body itself sets no state.
    void Promise.resolve().then(() => syncChain());
  }, [syncChain]);

  // Notes saved in this tab by something other than this hook (a restore from the
  // backup, a pull of what another device saved): show them at once. Another tab's
  // save arrives as a storage event below.
  useEffect(() => onNotesSaved(refreshLocal), [refreshLocal]);

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === NOTES_KEY) void syncFromDisk().then(refreshLocal);
    };
    const onFocus = () => {
      const now = Date.now();
      if (now - lastFocusSync.current < 15_000) {
        refreshLocal();
        return;
      }
      lastFocusSync.current = now;
      refresh();
    };
    // A phone browser coming back to the tab often fires no focus event, only this one.
    const onVisible = () => {
      if (document.visibilityState === "visible") onFocus();
    };
    // The connection is back: a claim waiting to be secured is tried at once, not at its next turn.
    const onOnline = () => {
      void secureClaimsInBackground(undefined, { now: true }).catch(() => undefined);
      lastFocusSync.current = Date.now();
      refresh();
    };
    window.addEventListener("storage", onStorage);
    window.addEventListener("focus", onFocus);
    window.addEventListener("online", onOnline);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("online", onOnline);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh, refreshLocal]);

  const demoLocal = demo ? loadWalletNotes(wallet, network) : null;
  // Only this network's notes and this wallet's, whatever the state still holds
  // from before a switch, a sign out or another account: none while signed out.
  const shown = useMemo(
    () => visibleNotes(demoLocal ?? local, chain, network, settled, wallet),
    [demoLocal, local, chain, network, settled, wallet]
  );
  const merged = useMemo(() => mergeNotes(shown.local, shown.chain), [shown]);
  const open = useMemo(
    () => activeSpendableNotes(merged),
    [merged]
  );
  /** Claimed payments the vault hasn't shown yet: listed, never in `open` or the totals. */
  const waiting = useMemo(() => unfundedClaims(merged), [merged]);
  /** Swap refunds whose money waits at the swap's escrow: listed, never in `open` or the totals. */
  const heldRefunds = useMemo(() => heldSwapRefunds(merged), [merged]);
  const confirmed = useMemo(() => confirmedNotes(merged), [merged]);
  // A note a reverted swap left behind moves right away, and the sync tries again if that
  // try fails (lib/claimSweep moveRevertedNotes): keep syncing while one waits, as nothing else
  // would if this page is just left open. A top-up's note with its proof still out waits the same
  // way, and so does a claimed payment not secured yet (lib/claimSweep secureClaimsInBackground).
  const moveWaiting = useMemo(
    () => open.some((n) => n.swapProofAt || isUnsecuredClaim(n)) || merged.some(proofLoose),
    [open, merged]
  );
  useEffect(() => {
    if (!moveWaiting) return;
    const t = setInterval(refresh, MOVE_SYNC_MS);
    return () => clearInterval(t);
  }, [moveWaiting, refresh]);
  const byAsset = useMemo(() => sumByAsset(open), [open]);
  const shieldedWei = useMemo(() => sumEthWei(open), [open]);
  // Only a note with a secret here counts, and chain rows never carry one, so
  // with no notes on this network the balance is zero whatever the sync finds:
  // nothing to wait for. With notes, the sync can still retire a spent one.
  const balanceSyncing = syncing && !(unlocked && shown.local.length === 0);

  return {
    local: shown.local,
    chain: shown.chain,
    merged,
    open,
    waiting,
    heldRefunds,
    confirmed,
    byAsset,
    shieldedWei,
    ready,
    syncing,
    /** Syncing, and the sync can still change the private balance. */
    balanceSyncing,
    refresh,
    refreshLocal,
  };
}
