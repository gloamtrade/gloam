"use client";

import { useQuery } from "@tanstack/react-query";
import { MARKETS, type Market } from "@/lib/markets";

type ApiResponse = {
  markets: Market[];
  ethUsd?: number | null;
  /** HYPE in USD, Elysium's gas coin. */
  hypeUsd?: number | null;
  meta?: {
    liveCount: number;
    total: number;
    fetchedAt: number;
  };
};

async function fetchMarkets(): Promise<ApiResponse> {
  // no cache-buster: the CDN keeps it for 20 s (api/markets), which is fresher than the 30 s poll
  const res = await fetch("/api/markets", { cache: "no-store" });
  if (!res.ok) throw new Error("markets_failed");
  return res.json() as Promise<ApiResponse>;
}

export function useLiveMarkets() {
  return useQuery({
    queryKey: ["markets", "live"],
    queryFn: fetchMarkets,
    staleTime: 15_000,
    refetchInterval: 30_000,
    retry: 3,
    placeholderData: {
      markets: MARKETS,
      ethUsd: null,
      meta: {
        liveCount: 0,
        total: MARKETS.length,
        fetchedAt: 0,
      },
    },
  });
}

export function useEthPrice() {
  const q = useLiveMarkets();
  return {
    ethUsd: q.data?.ethUsd ?? null,
    hypeUsd: q.data?.hypeUsd ?? null,
    isLoading: q.isLoading,
  };
}
