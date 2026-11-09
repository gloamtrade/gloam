/**
 * The smallest private swap on a chain where gas is dear. The relay pays a swap's
 * gas, about 1.7M on Ethereum, and the vault's cash-out fee is all that surely comes
 * back. The price buffer doesn't count: a trader who sees a swap first can trade in
 * front of it and take that. So a swap has to bring in, as vault fee, at least the gas it
 * costs, and the floor moves with the gas price. Nothing is charged for this: below the
 * floor the swap simply isn't sent. A refund and an exit under it aren't refused for
 * that, but they spend from an hourly budget (lib/relay/server holdWaiting).
 *
 * The relay sees only the swap. Swapping part of a note sets that part aside first, a
 * private send that costs about SPLIT_GAS_UNITS more, which the relay can't tell from
 * any other. So the app counts it (swapFloorGas), and the relay's floor doesn't.
 *
 * Shared by the relay and the app: no server-only imports here.
 */
import type { Address } from "viem";

/** Chainlink's ETH / USD feed, on the chains that have a floor. Checked on chain 2026-11-02: description() "ETH / USD", 8 decimals. */
export const ETH_USD_FEED: Readonly<Record<number, Address>> = {
  1: "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419",
};

export const ethUsdFeedAbi = [
  {
    type: "function",
    name: "latestRoundData",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "roundId", type: "uint80" },
      { name: "answer", type: "int256" },
      { name: "startedAt", type: "uint256" },
      { name: "updatedAt", type: "uint256" },
      { name: "answeredInRound", type: "uint80" },
    ],
  },
] as const;

/** The feed updates at least hourly. Older than this, the relay won't price a swap with it. */
export const FEED_MAX_AGE_SEC = 2 * 3600;

/** Whether a swap on this chain has to pay for its own gas. */
export function hasSwapFloor(chainId: number): boolean {
  return ETH_USD_FEED[chainId] !== undefined;
}

/**
 * Gas one swap costs the relay, a little over the most seen on a fork of Ethereum with real
 * proofs against the live vault (scripts/fork-router-v3.mts): 1.58M to 1.68M in one hop, 1.70M in three.
 */
const SWAP_GAS_FIRST_HOP = 1_700_000n;
const SWAP_GAS_NEXT_HOP = 60_000n;

export function swapGasUnits(hops: number): bigint {
  return SWAP_GAS_FIRST_HOP + SWAP_GAS_NEXT_HOP * BigInt(Math.max(0, hops - 1));
}

/** The private send that sets part of a note aside before a swap. */
export const SPLIT_GAS_UNITS = 1_800_000n;

/** What the swap tab weighs against the vault fee: the swap, and the split when there is one. */
export function swapFloorGas(hops: number, split: boolean): bigint {
  return swapGasUnits(hops) + (split ? SPLIT_GAS_UNITS : 0n);
}

/** The smallest swap, in dollars, whose vault fee covers its gas. Infinity while the vault takes no fee. */
export function smallestSwapUsd(p: { gasPriceWei: bigint; ethUsd: number; feeBps: number; hops: number }): number {
  if (p.feeBps <= 0) return Number.POSITIVE_INFINITY;
  const gasUsd = (Number(swapGasUnits(p.hops) * p.gasPriceWei) / 1e18) * p.ethUsd;
  return (gasUsd * 10_000) / p.feeBps;
}

/** The app asks a little above the relay's floor, so gas that moves a few percent while a swap is proved doesn't turn it away. */
export function swapFloorShown(usd: number): number {
  return usd * 1.1;
}

/** One line in the app's words. */
export function swapFloorMessage(label: string, usd: number): string {
  return `A swap on ${label} has to be worth about $${Math.ceil(usd).toLocaleString("en-US")} right now, to cover its gas. Swap a larger amount, or wait for gas to fall.`;
}
