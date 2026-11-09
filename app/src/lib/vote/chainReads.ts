/**
 * The Robinhood Chain reads a close-weighted vote needs: $GLOAM balances now
 * (cached for a minute, so the live results stay fast), and for the final
 * count the closing block and the Transfer logs up to it. Server only.
 *
 * Everything goes through one VoteChain, so the self-test swaps in a fake
 * chain and the final-count script can point it at another RPC.
 */
import "server-only";
import { createPublicClient, erc20Abi, http, type Address, type PublicClient } from "viem";
import { robinhood } from "../chain";
import { serverTransport } from "../serverRpc";
import { GLOAM_FIRST_BLOCK, GLOAM_TOKEN_ADDRESS, type TransferLog } from "./core";
import type { Excluded } from "./excluded";
import { allTransferLogs } from "./transferLogs";

export type ChainBlock = { number: number; hash: string; time: number };

export type VoteChain = {
  /** balanceOf for each address at the head, or at `block`. Throws when the read fails (or the block's state is gone). */
  balances(addresses: string[], block?: number): Promise<Map<string, bigint>>;
  totalSupply(): Promise<bigint>;
  head(): Promise<ChainBlock>;
  block(n: number): Promise<ChainBlock>;
  /** GLOAM Transfer logs in [from, to]. */
  transferLogs(from: number, to: number): Promise<TransferLog[]>;
};

const READ_TIMEOUT_MS = 8_000;
const BATCH = 400;

/** A VoteChain over a viem client: the server's RPCs by default, or `rpcUrl`. */
export function rpcVoteChain(rpcUrl?: string): VoteChain {
  const client = createPublicClient({
    chain: robinhood,
    ccipRead: false,
    transport: rpcUrl
      ? http(rpcUrl, { timeout: 30_000, retryCount: 3 })
      : serverTransport({ chainId: robinhood.id, chain: robinhood, historyRpc: null }, { timeout: READ_TIMEOUT_MS, retryCount: 1 }),
  }) as PublicClient;
  const asBlock = (b: { number: bigint | null; hash: `0x${string}` | null; timestamp: bigint }): ChainBlock => ({
    number: Number(b.number ?? 0n),
    hash: b.hash ?? "0x",
    time: Number(b.timestamp),
  });
  return {
    async balances(addresses, block) {
      const out = new Map<string, bigint>();
      for (let i = 0; i < addresses.length; i += BATCH) {
        const slice = addresses.slice(i, i + BATCH);
        const res = await client.multicall({
          contracts: slice.map((a) => ({ address: GLOAM_TOKEN_ADDRESS, abi: erc20Abi, functionName: "balanceOf" as const, args: [a as Address] as const })),
          allowFailure: false,
          ...(block !== undefined ? { blockNumber: BigInt(block) } : {}),
        });
        res.forEach((b, j) => out.set(slice[j]!.toLowerCase(), b));
      }
      return out;
    },
    totalSupply: () => client.readContract({ address: GLOAM_TOKEN_ADDRESS, abi: erc20Abi, functionName: "totalSupply" }),
    head: async () => asBlock(await client.getBlock()),
    block: async (n) => asBlock(await client.getBlock({ blockNumber: BigInt(n) })),
    transferLogs: (from, to) => allTransferLogs((args) => client.request(args as never), from, to),
  };
}

let override: VoteChain | null = null;
let defaultChain: VoteChain | null = null;

/** Self-tests and scripts only: use this chain instead of the server's RPCs (null puts the default back). */
export function setVoteChain(chain: VoteChain | null) {
  override = chain;
  liveCache.clear();
  eligibleCache.clear();
}

/** The chain to read, or null when chain reads are off (GLOAM_VOTE_NO_CHAIN=1). */
export function voteChain(): VoteChain | null {
  if (override) return override;
  if (process.env.GLOAM_VOTE_NO_CHAIN === "1") return null;
  return (defaultChain ??= rpcVoteChain());
}

/* ------------------------------------------------------------------ balances now */

/** How long a balance read now is reused, per server instance. */
export const LIVE_TTL_MS = 60_000;
/** A failed read is tried again sooner. */
const FAILED_TTL_MS = 10_000;
const liveCache = new Map<string, { at: number; ttl: number; value: Promise<bigint | null> }>();

/**
 * Each address's $GLOAM now: null for one that couldn't be read. Reads at
 * most once a minute per address per server instance (`fresh` skips the
 * cache, for the read a vote is taken on), and reads the misses in one batch.
 */
export async function balancesNow(addresses: string[], opts: { fresh?: boolean; now?: number } = {}): Promise<Map<string, bigint | null>> {
  const now = opts.now ?? Date.now();
  const keys = [...new Set(addresses.map((a) => a.toLowerCase()))];
  const missing = keys.filter((k) => {
    const hit = liveCache.get(k);
    return opts.fresh || !hit || now - hit.at >= hit.ttl;
  });
  if (missing.length) {
    const chain = voteChain();
    const batch: Promise<Map<string, bigint> | null> = chain ? chain.balances(missing).catch(() => null) : Promise.resolve(null);
    for (const k of missing) {
      const value = batch.then((m) => m?.get(k) ?? null);
      liveCache.set(k, { at: now, ttl: LIVE_TTL_MS, value });
      void value.then((v) => {
        const cur = liveCache.get(k);
        if (v === null && cur?.value === value) cur.ttl = FAILED_TTL_MS;
      });
    }
  }
  const out = new Map<string, bigint | null>();
  await Promise.all(keys.map(async (k) => out.set(k, await liveCache.get(k)!.value)));
  return out;
}

/** One wallet's $GLOAM now, or null when it couldn't be read. */
export async function balanceNow(address: string, opts: { fresh?: boolean; now?: number } = {}): Promise<bigint | null> {
  return (await balancesNow([address], opts)).get(address.toLowerCase()) ?? null;
}

const eligibleCache = new Map<string, { at: number; value: Promise<bigint | null> }>();

/** All the GLOAM that can vote now: the supply less what the excluded addresses hold. null when it can't be read. */
export async function eligibleNow(excluded: Map<string, Excluded>, now: number = Date.now()): Promise<bigint | null> {
  const key = [...excluded.keys()].sort().join(",");
  const hit = eligibleCache.get(key);
  if (hit && now - hit.at < LIVE_TTL_MS) return hit.value;
  const chain = voteChain();
  const value: Promise<bigint | null> = chain
    ? Promise.all([chain.totalSupply(), balancesNow([...excluded.keys()], { now })])
        .then(([supply, held]) => {
          let out = supply;
          for (const b of held.values()) {
            if (b === null) return null;
            out -= b;
          }
          return out < 0n ? 0n : out;
        })
        .catch(() => null)
    : Promise.resolve(null);
  eligibleCache.set(key, { at: now, value });
  void value.then((v) => v === null && eligibleCache.get(key)?.value === value && eligibleCache.delete(key));
  return value;
}

/** Self-tests only. */
export function clearChainCache() {
  liveCache.clear();
  eligibleCache.clear();
}

/**
 * The first block whose timestamp is at or after `timeSec`, by binary search
 * between `lo` (a block before that time) and the head. Throws when the chain
 * hasn't reached that time yet.
 */
export async function firstBlockAtOrAfter(chain: VoteChain, timeSec: number, lo: number): Promise<ChainBlock> {
  const head = await chain.head();
  if (head.time < timeSec) throw new Error(`the chain is at ${new Date(head.time * 1000).toISOString()}, before the close`);
  let low = await chain.block(lo);
  if (low.time >= timeSec) {
    // the hint is already past the time: search from the token's first block instead
    if (lo <= GLOAM_FIRST_BLOCK) return low;
    return firstBlockAtOrAfter(chain, timeSec, GLOAM_FIRST_BLOCK);
  }
  let high = head;
  // invariant: low.time < timeSec <= high.time
  while (high.number - low.number > 1) {
    const mid = await chain.block(Math.floor((low.number + high.number) / 2));
    if (mid.time >= timeSec) high = mid;
    else low = mid;
  }
  return high;
}
