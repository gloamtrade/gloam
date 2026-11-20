"use client";

import { useMemo } from "react";
import { useReadContract, useReadContracts } from "wagmi";
import { isShieldDeployed, shieldPoolAbi } from "@/lib/shield";
import { limitGatedAssetsFor, openGatedFromReads } from "@/lib/tokens";
import { useNetwork } from "@/components/app/NetworkProvider";

const NONE: ReadonlySet<string> = new Set();

/**
 * The gated assets (BDX on BNB Chain; GRIFT, AI, ORBIO and native ETH on
 * Robinhood Chain) whose deposit limit is open on the active network's vault, as
 * lowercase addresses, read live from the pool every minute. Pass it to
 * addableTokensFor / isAddableToken / isNativeAddable. Empty while unread, on a
 * read error, and on a chain with no such asset, so Add never offers an asset the
 * vault would refuse.
 */
export function useOpenGatedTokens(): ReadonlySet<string> {
  const { network } = useNetwork();
  const gated = useMemo(() => limitGatedAssetsFor(network.chainId), [network.chainId]);
  const pool = network.pool;
  const enabled = gated.length > 0 && Boolean(pool) && isShieldDeployed();
  const query = { enabled, refetchInterval: 60_000 };
  const { data: limitsOn } = useReadContract({
    address: pool ?? undefined,
    abi: shieldPoolAbi,
    functionName: "depositLimitsOn",
    chainId: network.chainId,
    query,
  });
  const { data: limits } = useReadContracts({
    contracts: pool
      ? gated.map((t) => ({
          address: pool,
          abi: shieldPoolAbi,
          functionName: "depositLimit" as const,
          args: [t.address] as const,
          chainId: network.chainId,
        }))
      : [],
    query,
  });
  return useMemo(() => {
    if (!enabled || limitsOn === undefined || !limits) return NONE;
    const read = gated.map((_, i) => {
      const r = limits[i];
      return r?.status === "success" ? (r.result as readonly [bigint, bigint]) : undefined;
    });
    return openGatedFromReads(gated, Boolean(limitsOn), read);
  }, [enabled, limitsOn, limits, gated]);
}
