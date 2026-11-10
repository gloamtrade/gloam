"use client";

import { useQuery } from "@tanstack/react-query";
import type { Address } from "viem";
import { useDemoActivity } from "@/lib/demo";
import { NETWORK_KEYS, getNetwork } from "@/lib/networks";
import { readWalletActivity } from "@/lib/walletActivity";

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
  return res.json() as Promise<{ txs: ActivityTx[] }>;
}

/**
 * The wallet's public history. A testnet asks its explorer; a mainnet (pass its
 * chain id) is read straight from the chain, since its explorer has no account
 * API Gloam can use, and so is Base Sepolia, which lists its tokens like one.
 */
export function useActivity(address: string | undefined, mainnetChainId?: number) {
  // Recording demo: the pretend wallet's history, nothing fetched.
  const demo = useDemoActivity();
  const mainnetKey = mainnetChainId
    ? NETWORK_KEYS.find((k) => getNetwork(k).chainId === mainnetChainId && getNetwork(k).paymentsPool)
    : undefined;
  const query = useQuery({
    queryKey: mainnetChainId ? ["activity", address, mainnetChainId] : ["activity", address],
    queryFn: () =>
      mainnetKey ? readWalletActivity(mainnetKey, address as Address) : fetchActivity(address!, mainnetChainId),
    enabled: Boolean(address) && !demo,
    staleTime: 12_000,
    refetchInterval: 30_000,
  });
  return demo ?? query;
}
