/**
 * Whether the treasure hunt's prize (lib/hunt) has been claimed, for the admin
 * panel. Server only.
 *
 * Only with HUNT_PRIZE_NULLIFIER set: the prize note's nullifier, which says
 * nothing that would let anyone claim. The vault's public isSpent read answers
 * it. The note itself (the claim link) is never needed here.
 * scripts/hunt-nullifier.mts works the nullifier out from the claim link on
 * the founder's own machine.
 */
import { createPublicClient } from "viem";
import { getNetwork, isNetworkKey } from "@/lib/networks";
import { serverTransport } from "@/lib/serverRpc";
import { huntPrizeNet, prizeNullifier } from "@/lib/hunt";

const IS_SPENT_ABI = [
  {
    type: "function",
    name: "isSpent",
    stateMutability: "view",
    inputs: [{ name: "nullifier", type: "bytes32" }],
    outputs: [{ type: "bool" }],
  },
] as const;

/** How long an answer of "not yet" is kept before the chain is asked again. */
const RECHECK_MS = 60_000;

export type PrizeState = "claimed" | "unclaimed" | "unknown" | "unchecked";

let cache: { nullifier: string; state: PrizeState; at: number } | null = null;

/**
 * "claimed" or "unclaimed" from the chain; "unknown" when the read failed;
 * "unchecked" with no nullifier set (or no vault on that network). A claim
 * can't be undone, so "claimed" is kept for good.
 */
export async function prizeState(now = Date.now(), read?: (nullifier: `0x${string}`) => Promise<boolean>): Promise<PrizeState> {
  const nullifier = prizeNullifier();
  if (!nullifier) return "unchecked";
  if (cache && cache.nullifier === nullifier && (cache.state === "claimed" || now - cache.at < RECHECK_MS)) return cache.state;
  let ask = read;
  if (!ask) {
    const key = huntPrizeNet();
    if (!isNetworkKey(key)) return "unchecked";
    const net = getNetwork(key);
    const pool = net.pool;
    if (!pool) return "unchecked";
    const client = createPublicClient({ chain: net.chain, ccipRead: false, transport: serverTransport(net, { timeout: 8_000, retryCount: 1 }) });
    ask = (n) => client.readContract({ address: pool, abi: IS_SPENT_ABI, functionName: "isSpent", args: [n] });
  }
  try {
    const state: PrizeState = (await ask(nullifier)) ? "claimed" : "unclaimed";
    cache = { nullifier, state, at: now };
    return state;
  } catch {
    return "unknown";
  }
}
