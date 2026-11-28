"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Address } from "viem";
import { useDemoActivity } from "@/lib/demo";
import { NETWORK_KEYS, getNetwork } from "@/lib/networks";
import { activityRefetchMs, readWalletActivity, widenWalletActivity, type ActivityRead } from "@/lib/walletActivity";

export type ActivityTx = {
  hash: string;
  from: string;
  to: string;
  /** The native coin in wei, or the token's own units when `token` is set. */
  valueWei: string;
  timestamp: number;
  ok: boolean;
  /** Rows read from the chain (mainnets): one token transfer each. */
  id?: string;
  token?: { symbol: string; decimals: number };
};

async function fetchActivity(address: string, mainnetChainId?: number) {
  // A testnet asks exactly as before; a mainnet names its chain. The wallet goes
  // in the body, never the URL, where access logs would keep it next to the IP.
  const res = await fetch("/api/activity", {
    method: "POST",
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(mainnetChainId ? { address, chainId: mainnetChainId } : { address }),
  });
  if (!res.ok) throw new Error("activity_failed");
  return res.json() as Promise<ActivityRead>;
}

/** What the card reads: the list so far, and on a mainnet how far back it goes. */
export type ActivityState = {
  data?: ActivityRead;
  isLoading: boolean;
  isError: boolean;
  isFetching: boolean;
  /** Reads again now (Retry); null in a recording demo. */
  refetch: (() => void) | null;
  /** Reads another week back (a mainnet read from the chain only), else null. */
  showOlder: (() => void) | null;
};

/**
 * The wallet's public history. A testnet asks its explorer; a mainnet (pass its
 * chain id) is read straight from the chain, since its explorer has no account
 * API Gloam can use, and so is Base Sepolia, which lists its tokens like one.
 * A chain read covers the last week first and fills the list as each span of
 * blocks comes back (lib/walletActivity), so rows show before the read is done.
 */
export function useActivity(address: string | undefined, mainnetChainId?: number): ActivityState {
  // Recording demo: the pretend wallet's history, nothing fetched.
  const demo = useDemoActivity();
  const queryClient = useQueryClient();
  const mainnetKey = mainnetChainId
    ? NETWORK_KEYS.find((k) => getNetwork(k).chainId === mainnetChainId && getNetwork(k).paymentsPool)
    : undefined;
  const queryKey = mainnetChainId ? ["activity", address, mainnetChainId] : ["activity", address];
  const query = useQuery({
    queryKey,
    queryFn: () =>
      mainnetKey
        ? readWalletActivity(mainnetKey, address as Address, undefined, {
            // each span's rows as they come: the card fills from the top
            onProgress: (r) => queryClient.setQueryData(queryKey, r),
          })
        : fetchActivity(address!, mainnetChainId),
    enabled: Boolean(address) && !demo,
    staleTime: 12_000,
    // a week still being read goes on at once; else every 30 s
    refetchInterval: (q) => activityRefetchMs(q.state),
    // a chain read has its own time limit and goes on from where it stopped; the card offers Retry
    retry: mainnetKey ? false : 1,
  });
  if (demo) return { ...demo, isFetching: false, refetch: null, showOlder: null };
  const refetch = () => void query.refetch();
  return {
    data: query.data,
    isLoading: query.isLoading,
    isError: query.isError,
    isFetching: query.isFetching,
    refetch,
    showOlder:
      mainnetKey && address
        ? () => {
            if (widenWalletActivity(mainnetKey, address as Address)) refetch();
          }
        : null,
  };
}
