"use client";

/**
 * Starknet payment disclosures in the browser: the reads go to Gloam's
 * read-only Starknet proxy (/api/starknet/rpc), for the network this site runs.
 */
import type { StarknetSession } from "@/lib/starknetPrivacy/session";
import { starknetConfig, STARKNET_NETWORK, STARKNET_PROXY_PATHS } from "@/lib/starknetPrivacy/config";
import { starknetProvider } from "@/lib/starknetPrivacy/client";
import { verifyStarknetChannel, type StarknetChannelProof, type StarknetChannelResult } from "./starknetChannel";
import { channelDeps, type ChannelMaker } from "./starknetChannelRead";

/**
 * The first block a payment event can be in: the pool's deploy block on
 * mainnet (read 2026-11-27, the first block whose state has the pool's class).
 * Devnet starts from 0.
 */
export const STARKNET_POOL_FROM_BLOCK: Record<string, number> = { mainnet: 8_978_970, sepolia: 0, devnet: 0 };

export async function verifyStarknetChannelHere(p: StarknetChannelProof): Promise<StarknetChannelResult> {
  const cfg = starknetConfig();
  const provider = starknetProvider(`${location.origin}${STARKNET_PROXY_PATHS.rpc}`);
  return verifyStarknetChannel(
    p,
    channelDeps({ network: STARKNET_NETWORK, provider, pool: cfg.pool, chainId: cfg.chainId, fromBlock: STARKNET_POOL_FROM_BLOCK[STARKNET_NETWORK] ?? 0 })
  );
}

/** What the maker side needs, from the open session (its keys stay in this tab). */
export function channelMakerFor(s: StarknetSession): ChannelMaker {
  if (!s.cfg.pool) throw new Error("No Starknet privacy pool is set.");
  return {
    address: s.address,
    viewingKey: s.keys.viewingKey,
    accountKey: s.keys.accountKey,
    network: s.cfg.network,
    provider: s.provider,
    pool: s.cfg.pool,
    chainId: s.cfg.chainId,
    fromBlock: STARKNET_POOL_FROM_BLOCK[s.cfg.network] ?? 0,
  };
}
