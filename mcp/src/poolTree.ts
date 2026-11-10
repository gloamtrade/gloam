/**
 * The vault's Merkle tree, kept for the life of the server: one createTreeSync
 * per chain and pool. A payment, sweep or swap then reads only the blocks since
 * the last one (one head read, one eth_getLogs, one root check), instead of
 * walking the pool's whole history from its deploy block every time.
 *
 * A cold start loads Gloam's public leaf list (gloamLeafSeed: one request to
 * www.gloam.trade naming only the network, the same for everyone, like the
 * circuit files). It is not trusted: the SDK checks the rebuilt root against
 * the pool and walks the chain itself when it does not match. Every later sync
 * checks the root again, so a path is only ever given from a tree whose root
 * is the pool's.
 */
import { createTreeSync, gloamLeafSeed, type PoseidonMerklePath, type syncTree, type TreeSeed, type TreeSync } from "@gloamtrade/sdk";
import type { Address, Hex } from "viem";

type TreeClient = Parameters<typeof syncTree>[0];

export interface PoolTreeParams {
  pool: Address;
  /** The pool's deploy block: where a walk of the chain starts. */
  fromBlock: bigint;
  /** The network key, for the leaf list a cold start loads. Without it a cold start walks the chain. */
  network?: string;
  /** The chain the pool is on (else the client's). Several chains have a pool at one address. */
  chainId?: number;
}

/** The tree params for a network's own pool. */
export function poolTreeParams(net: { key: string; chainId: number; pool: Address; deployBlock: bigint }): PoolTreeParams {
  return { pool: net.pool, fromBlock: net.deployBlock, network: net.key, chainId: net.chainId };
}

/** The membership paths of a pool's leaves. */
export interface PoolPaths {
  pathForCommitment(commitment: Hex): Promise<PoseidonMerklePath | null>;
}

/**
 * The pool's tree for one read. The server's default keeps one tree per chain
 * and pool (keptPoolTrees); tests pass a fixed one. The SDK's one-shot
 * syncTree fits this shape too.
 */
export type PoolTree = (client: TreeClient, params: PoolTreeParams) => Promise<PoolPaths>;

/**
 * One kept tree per chain and pool, made on first use with the client it is
 * first asked through (every client for a network reads the same RPC).
 * `seed`: where a cold start gets its leaves; default Gloam's public leaf list.
 */
export function keptPoolTrees(opts: { seed?: (network: string) => TreeSeed | undefined } = {}): PoolTree {
  const trees = new Map<string, TreeSync>();
  const seedFor = opts.seed ?? ((network: string) => gloamLeafSeed(network));
  return async (client, params) => {
    const chainId = params.chainId ?? client.chain?.id ?? (await client.getChainId());
    const key = `${chainId}:${params.pool.toLowerCase()}`;
    let tree = trees.get(key);
    if (!tree) {
      const seed = params.network ? seedFor(params.network) : undefined;
      tree = createTreeSync(client, { pool: params.pool, fromBlock: params.fromBlock, ...(seed ? { seed } : {}) });
      trees.set(key, tree);
    }
    const kept = tree;
    // Through the kept tree, not a copy: each call reads the blocks since the last, checks the root, and is serialized.
    return { pathForCommitment: (commitment) => kept.pathForCommitment(commitment) };
  };
}
