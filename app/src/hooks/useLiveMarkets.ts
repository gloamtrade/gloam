"use client";

import { useQuery } from "@tanstack/react-query";
import { MARKETS, type Market } from "@/lib/markets";

type ApiResponse = {
  markets: Market[];
  ethUsd?: number | null;
  /** HYPE in USD, Elysium's gas coin. */
  hypeUsd?: number | null;
  /** BNB in USD, BNB Chain's gas coin (only while BNB Chain is on). */
  bnbUsd?: number | null;
  /** SOL in USD (only while Solana is on). */
  solUsd?: number | null;
  meta?: {
    liveCount: number;
    total: number;
    fetchedAt: number;
  };
};

/**
 * The last gas-coin prices this page saw, so one empty read (the price source
 * was busy) does not flip a dollar figure back to "no dollar price" for 30
 * seconds. Kept 15 minutes; after that an empty read shows as unknown again.
 */
const KEEP_PRICE_MS = 15 * 60_000;
const lastPrice: Partial<Record<"ethUsd" | "hypeUsd" | "bnbUsd" | "solUsd", { usd: number; at: number }>> = {};

function steady(key: "ethUsd" | "hypeUsd" | "bnbUsd" | "solUsd", v: number | null | undefined): number | null {
  const now = Date.now();
  if (typeof v === "number" && Number.isFinite(v) && v > 0) {
    lastPrice[key] = { usd: v, at: now };
    return v;
  }
  const last = lastPrice[key];
  return last && now - last.at < KEEP_PRICE_MS ? last.usd : null;
}

async function fetchMarkets(): Promise<ApiResponse> {
  // no cache-buster: the CDN keeps it for 20 s (api/markets), which is fresher than the 30 s poll
  const res = await fetch("/api/markets", { cache: "no-store" });
  if (!res.ok) throw new Error("markets_failed");
  const body = (await res.json()) as ApiResponse;
  return {
    ...body,
    ethUsd: steady("ethUsd", body.ethUsd),
    hypeUsd: steady("hypeUsd", body.hypeUsd),
    bnbUsd: steady("bnbUsd", body.bnbUsd),
    solUsd: steady("solUsd", body.solUsd),
  };
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
    bnbUsd: q.data?.bnbUsd ?? null,
    solUsd: q.data?.solUsd ?? null,
    isLoading: q.isLoading,
  };
}
