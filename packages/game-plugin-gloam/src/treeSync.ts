/**
 * The vault's Merkle tree, for the membership paths a spend needs. Kept by the
 * SDK's createTreeSync, the same sync the MCP server and the SDK's sweeps use:
 *
 * - Each sync reads only the blocks since the last one: one eth_getLogs for
 *   all three leaf events, over the widest range the chain's RPC takes. A
 *   range the RPC refuses is split to the size it names (sepolia.base.org
 *   takes 200 blocks, publicnode 50,000, Robinhood Chain 10,000,000).
 * - A restart starts from the leaf cache on disk (public data: commitments and
 *   the blocks they landed in), and a cold start with no cache from Gloam's
 *   public leaf list for the network (one request naming only the network)
 *   instead of walking the chain from the deploy block.
 * - After every sync that read new blocks, the rebuilt root is checked against
 *   the vault's currentRoot() at the last block read. A cache or leaf list that
 *   does not match is dropped for a walk of the chain; a walk that does not
 *   match, or an RPC that keeps failing, is an error, never a guess.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Address, Hex, PublicClient } from "viem";
import {
  createTreeSync,
  gloamLeafSeed,
  type PoseidonMerklePath,
  type SyncedTree,
  type TreeSeed,
  type TreeStore,
  type TreeSync as KeptTree,
} from "@gloamtrade/sdk";

/** "d" deposit, "p" payment output, "x" change output, "t" trade output */
export type LeafKind = "d" | "p" | "x" | "t";

export interface SyncedVault {
  root: Hex;
  leafCount: number;
  /** The block the tree was read at. */
  atBlock: bigint;
  /** Every path from one SyncedVault is at its root, however many syncs come after. */
  pathForCommitment(commitment: Hex): Promise<PoseidonMerklePath | null>;
  /** The transaction that inserted a commitment, and how, when the tree knows. */
  leafInfo(commitment: Hex): { index: number; kind: LeafKind; tx: Hex | null } | null;
}

export interface TreeSyncOptions {
  /** Folder for the leaf cache. Without one, nothing is cached. */
  cacheDir?: string;
  /** First getLogs range to try. Default: what the chain's public RPC takes; shrinks to what this RPC allows. */
  chunk?: bigint;
  /** Ranges read at once when walking the chain. Default: the SDK's for the chain. */
  concurrency?: number;
  /**
   * Where a cold start with no cache gets its leaves. Default: Gloam's public
   * leaf list for the vault's network (checked against the vault's root before
   * use). false: walk the chain from the deploy block.
   */
  seed?: TreeSeed | false;
}

/** A TreeStore in a JSON file, written to a temp file and renamed. */
function fileStore(path: string): TreeStore {
  return {
    load: async () => JSON.parse(await readFile(path, "utf8")),
    save: async (snapshot) => {
      await mkdir(dirname(path), { recursive: true });
      const tmp = `${path}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(snapshot));
      await rename(tmp, path);
    },
  };
}

/** Commitment -> where and how it went in, built once per tree. */
function leafIndex(t: SyncedTree): Map<string, { index: number; kind: LeafKind; tx: Hex | null }> {
  const out = new Map<string, { index: number; kind: LeafKind; tx: Hex | null }>();
  t.leaves.forEach((leaf, i) => {
    let kind: LeafKind = "d";
    if (leaf.kind === "transfer") {
      const prev = t.leaves[i - 1];
      const second = !!prev && prev.kind === "transfer" && prev.blockNumber === leaf.blockNumber && prev.logIndex === leaf.logIndex;
      // A trade's outputs carry the asset out; a private send's carry none.
      kind = leaf.asset ? "t" : second ? "x" : "p";
    }
    out.set(leaf.commitment.toLowerCase(), { index: leaf.leafIndex, kind, tx: leaf.txHash ?? null });
  });
  return out;
}

export class TreeSync {
  private readonly kept: KeptTree;
  private readonly infos = new WeakMap<object, ReturnType<typeof leafIndex>>();

  constructor(
    client: PublicClient,
    vault: { chainId: number; pool: Address; deployBlock: bigint; key?: string },
    opts: TreeSyncOptions = {}
  ) {
    const seed = opts.seed === false ? undefined : (opts.seed ?? (vault.key ? gloamLeafSeed(vault.key) : undefined));
    const cache = opts.cacheDir ? join(opts.cacheDir, `tree.${vault.chainId}.${vault.pool.toLowerCase()}.json`) : null;
    this.kept = createTreeSync(client as never, {
      pool: vault.pool,
      fromBlock: vault.deployBlock,
      ...(opts.chunk ? { chunkSize: opts.chunk } : {}),
      ...(opts.concurrency ? { concurrency: opts.concurrency } : {}),
      ...(seed ? { seed } : {}),
      ...(cache ? { store: fileStore(cache) } : {}),
    });
  }

  /** The getLogs range this RPC has taken so far. */
  get logChunk(): bigint {
    return this.kept.logRange;
  }

  /** Read the tree up to the latest block, from the cache where it can. */
  async sync(): Promise<SyncedVault> {
    const t = await this.kept.sync();
    const atBlock = this.kept.toBlock ?? 0n;
    let infos = this.infos.get(t.leaves);
    if (!infos) {
      infos = leafIndex(t);
      this.infos.set(t.leaves, infos);
    }
    const index = infos;
    return {
      root: t.root,
      leafCount: t.leafCount,
      atBlock,
      pathForCommitment: (c) => t.pathForCommitment(c),
      leafInfo: (c) => index.get(c.toLowerCase()) ?? null,
    };
  }
}
