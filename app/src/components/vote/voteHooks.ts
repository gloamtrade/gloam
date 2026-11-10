"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAccount, useConnect, useDisconnect } from "wagmi";
import { WALLETCONNECT_ENABLED, WALLETCONNECT_ID, prefersWalletConnect } from "@/lib/walletConnect";
import type { Ballot } from "@/lib/vote/core";
import type { VoteSummary, VoterStanding } from "@/lib/vote/results";

export type Standing = VoterStanding & { eligibleWeight: string; eligibleWallets: number };
export type Me = { address: string; name: string | null; votes: Record<string, Standing | null> };

const POLL_MS = 10_000;

/** The clock, ticking every `every` ms. null until mounted, so the server and the first paint agree. */
export function useNow(every = 30_000): number | null {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const first = window.setTimeout(tick, 0);
    const t = window.setInterval(tick, every);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(t);
    };
  }, [every]);
  return now;
}

/** The wallet: who is connected, and how to connect here (a browser wallet, or a wallet app over WalletConnect). */
export function useVoteWallet() {
  const { address, isConnected, status, chainId } = useAccount();
  const { connect, connectors, isPending, error } = useConnect();
  const { disconnect } = useDisconnect();
  const [env, setEnv] = useState<{ mounted: boolean; wc: boolean; wallet: boolean }>({ mounted: false, wc: false, wallet: false });
  const [sheetOpen, setSheetOpen] = useState(false);

  useEffect(() => {
    const t = window.setTimeout(
      () =>
        setEnv({
          mounted: true,
          wc: prefersWalletConnect(),
          wallet: Boolean((window as { ethereum?: unknown }).ethereum),
        }),
      0,
    );
    return () => window.clearTimeout(t);
  }, []);

  const injectedConnector = connectors.find((c) => c.id !== WALLETCONNECT_ID);
  const canConnect = env.wc || (env.wallet && Boolean(injectedConnector));

  const open = useCallback(() => {
    if (env.wc) setSheetOpen(true);
    else if (injectedConnector && env.wallet) connect({ connector: injectedConnector });
  }, [env.wc, env.wallet, injectedConnector, connect]);

  return {
    address: isConnected ? address : undefined,
    chainId,
    mounted: env.mounted,
    reconnecting: status === "reconnecting" || status === "connecting",
    connecting: isPending,
    connectFailed: Boolean(error),
    canConnect,
    walletConnectOn: WALLETCONNECT_ENABLED,
    open,
    disconnect: () => disconnect(),
    sheetOpen,
    closeSheet: () => setSheetOpen(false),
  };
}

/** One wallet's name, weight and votes across every vote, from POST /api/vote/me. */
export function useMe(address: string | undefined) {
  const [me, setMe] = useState<Me | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!address) return;
    let stop = false;
    // the wallet in the body, never the URL, where access logs would keep it next to the IP
    fetch("/api/vote/me", { method: "POST", cache: "no-store", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ address }) })
      .then((r) => r.json())
      .then((j) => {
        if (stop) return;
        if (j?.ok) {
          setMe(j.data as Me);
          setFailed(false);
        } else setFailed(true);
      })
      .catch(() => !stop && setFailed(true));
    return () => {
      stop = true;
    };
  }, [address, attempt]);

  const current = me && address && me.address.toLowerCase() === address.toLowerCase() ? me : null;

  const recordBallot = useCallback((voteId: string, ballot: Ballot) => {
    setMe((m) => {
      const s = m?.votes[voteId];
      return m && s ? { ...m, votes: { ...m.votes, [voteId]: { ...s, ballot } } } : m;
    });
  }, []);

  return { me: current, failed: Boolean(address) && failed && !current, retry: () => setAttempt((a) => a + 1), recordBallot };
}

/**
 * Notes this wallet as a connected holder (POST /api/vote/seen, once per
 * wallet per page) and gives back its $GLOAM on Robinhood Chain right now:
 * undefined while it loads, null when it couldn't be read. The server works
 * out every balance itself; nothing here is trusted.
 */
export function useSeen(address: string | undefined): bigint | null | undefined {
  const [seen, setSeen] = useState<{ address: string; current: bigint | null } | null>(null);
  useEffect(() => {
    if (!address) return;
    let stop = false;
    fetch("/api/vote/seen", { method: "POST", cache: "no-store", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ address }) })
      .then((r) => r.json())
      .then((j) => {
        if (stop) return;
        const raw = j?.ok ? (j.data?.current as string | null) : null;
        setSeen({ address, current: typeof raw === "string" && /^\d+$/.test(raw) ? BigInt(raw) : null });
      })
      .catch(() => !stop && setSeen({ address, current: null }));
    return () => {
      stop = true;
    };
  }, [address]);
  return seen && address && seen.address.toLowerCase() === address.toLowerCase() ? seen.current : undefined;
}

/** Live totals for a set of votes, polled while the tab is visible. */
export function useLiveVotes(initial: VoteSummary[], source: "all" | string) {
  const [votes, setVotes] = useState(initial);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const live = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const url = source === "all" ? "/api/vote" : `/api/vote/${source}`;
      const j = await fetch(url, { cache: "no-store" }).then((r) => r.json());
      if (!live.current || !j?.ok) return;
      setVotes(source === "all" ? (j.data.votes as VoteSummary[]) : [j.data as VoteSummary]);
      setUpdatedAt(Date.now());
    } catch {
      /* the last totals stay up; the next poll tries again */
    }
  }, [source]);

  const anyLive = votes.some((v) => v.status === "open" || v.status === "upcoming" || v.draft);
  useEffect(() => {
    live.current = true;
    const first = window.setTimeout(() => void refresh(), 0);
    const t = anyLive
      ? window.setInterval(() => {
          if (document.visibilityState === "visible") void refresh();
        }, POLL_MS)
      : undefined;
    return () => {
      live.current = false;
      window.clearTimeout(first);
      if (t) window.clearInterval(t);
    };
  }, [refresh, anyLive]);

  return { votes, updatedAt, refresh };
}
