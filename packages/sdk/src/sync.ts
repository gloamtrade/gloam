/**
 * Rebuild the ShieldPool Merkle tree from chain, so an app or agent can produce
 * the membership path a spend proof needs (unshield, private send). Every event
 * that inserts a leaf must be replayed in on-chain order, or the root will not
 * match after any transfer or swap has happened:
 *
 *   Shielded      -> one leaf  (commitment)
 *   Transferred   -> two leaves (payment, change) in that order
 *   SealedSwapped -> two leaves (out, change) in that order
 *
 * viem's PublicClient is injected (no RPC baked in), so the same helper serves
 * a browser app and a node signer.
 */

import type { Address, Hex, PublicClient } from "viem";
import {
  IncrementalMerkleTreePoseidon,
  type PoseidonMerklePath,
} from "./merkle.js";
import { fieldToHex, hexToField } from "./poseidon.js";

export type ChainLeaf = {
  leafIndex: number;
  commitment: Hex;
  /** How the leaf entered the tree. */
  kind: "shield" | "transfer";
  asset?: Address;
  amount?: bigint;
  from?: Address;
  txHash?: Hex;
  blockNumber?: bigint;
  logIndex?: number;
};

export interface SyncedTree {
  /** The rebuilt tree — call `.path(i)` yourself, or use the helpers below. */
  tree: IncrementalMerkleTreePoseidon;
  leaves: ChainLeaf[];
  root: Hex;
  leafCount: number;
  /** commitment (lowercased hex) -> leaf index */
  indexByCommitment: Map<string, number>;
  pathForLeaf(leafIndex: number): Promise<PoseidonMerklePath | null>;
  /** The ergonomic path: give a note's commitment, get its membership path. */
  pathForCommitment(commitment: Hex): Promise<PoseidonMerklePath | null>;
}

export interface SyncTreeParams {
  /** The pool address (no default: pass the network's pool, e.g. mainnetNetwork("tempo")!.pool or SEALED_VAULT on testnet). */
  pool: Address;
  /** Earliest block to scan. Default 0n; pass the deploy block to go faster. */
  fromBlock?: bigint;
  /** getLogs range per request. Many public RPCs cap this. Default 40_000. */
  chunkSize?: bigint;
  /**
   * getLogs ranges in flight per event while walking history (the three events
   * are read side by side, so the RPC sees up to 3x this). Default 1. A public
   * RPC that caps the range (Tempo: 100,000 blocks) walks a long history much
   * faster at 3 or 4; one that answers bursts with 429 wants it low.
   */
  concurrency?: number;
}

/** One pool event that inserts leaves, as JSON (also the format of a tree snapshot and of gloam.trade's leaf list). */
export interface TreeInsert {
  /** s = deposit (Shielded), t = private send (Transferred), w = sealed swap (SealedSwapped) */
  k: "s" | "t" | "w";
  /** The commitments in the order the pool inserts them. */
  c: Hex[];
  /** Deposit asset (s) or swap output asset (w). */
  a?: Address;
  /** Deposit amount in base units (s). */
  v?: string;
  /** Depositor (s). */
  f?: Address;
  tx?: Hex;
  bn: string;
  li: number;
}

type DecodedLog = {
  args?: Record<string, unknown>;
  blockNumber?: bigint | null;
  logIndex?: number | null;
  transactionHash?: Hex | null;
};

type MinimalEvent = {
  type: "event";
  name: string;
  inputs: readonly { name: string; type: string; indexed: boolean }[];
};

/** Run `jobs` with at most `limit` in flight, results in order. */
async function pooled<T>(jobs: (() => Promise<T>)[], limit: number): Promise<T[]> {
  const out = new Array<T>(jobs.length);
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const i = next++;
      out[i] = await jobs[i]!();
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, jobs.length)) }, worker));
  return out;
}

async function getLogsChunked(
  client: PublicClient,
  address: Address,
  event: MinimalEvent,
  fromBlock: bigint,
  toBlock: bigint,
  chunkSize: bigint,
  concurrency: number
): Promise<DecodedLog[]> {
  if (toBlock < fromBlock) return [];
  const jobs: (() => Promise<DecodedLog[]>)[] = [];
  for (let start = fromBlock; start <= toBlock; start += chunkSize) {
    let end = start + chunkSize - 1n;
    if (end > toBlock) end = toBlock;
    jobs.push(() => client.getLogs({ address, event: event as never, fromBlock: start, toBlock: end }) as Promise<DecodedLog[]>);
  }
  return (await pooled(jobs, concurrency)).flat();
}

const SHIELDED_EVENT: MinimalEvent = {
  type: "event",
  name: "Shielded",
  inputs: [
    { name: "commitment", type: "bytes32", indexed: true },
    { name: "asset", type: "address", indexed: true },
    { name: "amount", type: "uint256", indexed: false },
    { name: "leafIndex", type: "uint256", indexed: false },
    { name: "from", type: "address", indexed: true },
  ],
};

const TRANSFERRED_EVENT: MinimalEvent = {
  type: "event",
  name: "Transferred",
  inputs: [
    { name: "nullifier", type: "bytes32", indexed: true },
    { name: "newCommitments", type: "bytes32[2]", indexed: false },
  ],
};

const SEALED_SWAPPED_EVENT: MinimalEvent = {
  type: "event",
  name: "SealedSwapped",
  inputs: [
    { name: "nullifier", type: "bytes32", indexed: true },
    { name: "assetIn", type: "address", indexed: true },
    { name: "assetOut", type: "address", indexed: true },
    { name: "newCommitmentOut", type: "bytes32", indexed: false },
    { name: "newCommitmentChange", type: "bytes32", indexed: false },
  ],
};

/** Every leaf-inserting event of `pool` in [fromBlock, toBlock], sorted in on-chain order. */
async function readInserts(
  client: PublicClient,
  pool: Address,
  fromBlock: bigint,
  toBlock: bigint,
  chunkSize: bigint,
  concurrency: number
): Promise<TreeInsert[]> {
  const [shieldLogs, transferLogs, sealedLogs] = await Promise.all([
    getLogsChunked(client, pool, SHIELDED_EVENT, fromBlock, toBlock, chunkSize, concurrency),
    getLogsChunked(client, pool, TRANSFERRED_EVENT, fromBlock, toBlock, chunkSize, concurrency),
    // Older pools have no SealedSwapped; treat a failure as empty.
    getLogsChunked(client, pool, SEALED_SWAPPED_EVENT, fromBlock, toBlock, chunkSize, concurrency).catch(
      () => [] as DecodedLog[]
    ),
  ]);

  const inserts: TreeInsert[] = [];
  const meta = (log: DecodedLog) => ({
    bn: (log.blockNumber ?? 0n).toString(),
    li: log.logIndex ?? 0,
    ...(log.transactionHash ? { tx: log.transactionHash } : {}),
  });
  for (const log of shieldLogs) {
    const a = log.args as { commitment?: Hex; asset?: Address; amount?: bigint; from?: Address };
    if (!a?.commitment) continue;
    inserts.push({
      k: "s",
      c: [a.commitment],
      ...(a.asset ? { a: a.asset } : {}),
      ...(a.amount !== undefined ? { v: a.amount.toString() } : {}),
      ...(a.from ? { f: a.from } : {}),
      ...meta(log),
    });
  }
  for (const log of transferLogs) {
    const pair = (log.args as { newCommitments?: readonly [Hex, Hex] })?.newCommitments;
    if (!pair) continue;
    inserts.push({ k: "t", c: [pair[0], pair[1]], ...meta(log) });
  }
  for (const log of sealedLogs) {
    const a = log.args as { newCommitmentOut?: Hex; newCommitmentChange?: Hex; assetOut?: Address };
    if (!a?.newCommitmentOut || !a?.newCommitmentChange) continue;
    inserts.push({ k: "w", c: [a.newCommitmentOut, a.newCommitmentChange], ...(a.assetOut ? { a: a.assetOut } : {}), ...meta(log) });
  }
  return inserts.sort(byChainOrder);
}

function byChainOrder(x: TreeInsert, y: TreeInsert): number {
  const bx = BigInt(x.bn);
  const by = BigInt(y.bn);
  if (bx !== by) return bx < by ? -1 : 1;
  return x.li - y.li;
}

const insertKey = (r: TreeInsert) => `${r.bn}:${r.li}`;

/** A tree being built: the leaves so far and the events they came from. */
class TreeState {
  tree = new IncrementalMerkleTreePoseidon();
  leaves: ChainLeaf[] = [];
  indexByCommitment = new Map<string, number>();
  inserts: TreeInsert[] = [];
  keys = new Set<string>();

  async append(rows: TreeInsert[]) {
    await this.tree.init();
    for (const r of rows) {
      this.inserts.push(r);
      this.keys.add(insertKey(r));
      for (const commitment of r.c) {
        const leafIndex = this.tree.nextIndex;
        await this.tree.insert(hexToField(commitment));
        this.leaves.push({
          leafIndex,
          commitment,
          kind: r.k === "s" ? "shield" : "transfer",
          asset: r.a,
          amount: r.v !== undefined ? BigInt(r.v) : undefined,
          from: r.f,
          txHash: r.tx,
          blockNumber: BigInt(r.bn),
          logIndex: r.li,
        });
        this.indexByCommitment.set(commitment.toLowerCase(), leafIndex);
      }
    }
  }

  view(): SyncedTree {
    const tree = this.tree;
    const index = this.indexByCommitment;
    const pathForLeaf = async (i: number) => {
      try {
        return await tree.path(i);
      } catch {
        return null;
      }
    };
    return {
      tree,
      leaves: this.leaves,
      root: fieldToHex(tree.currentRoot),
      leafCount: tree.nextIndex,
      indexByCommitment: index,
      pathForLeaf,
      pathForCommitment: async (commitment: Hex) => {
        const i = index.get(commitment.toLowerCase());
        return i === undefined ? null : pathForLeaf(i);
      },
    };
  }
}

/**
 * Rebuild the pool's tree from chain. After this, `pathForCommitment(note.commitment)`
 * gives you the `path` that `buildUnshieldIntent` / `buildPrivateSendIntent` want.
 * A server or agent that spends more than once should keep a createTreeSync
 * instead: it reads only the blocks since its last sync.
 */
export async function syncTree(
  client: PublicClient,
  params: SyncTreeParams
): Promise<SyncedTree> {
  const fromBlock = params.fromBlock ?? 0n;
  // Fresh every time: a cached head can miss a note made seconds before it is spent.
  const latest = await client.getBlockNumber({ cacheTime: 0 });
  const rows = await readInserts(client, params.pool, fromBlock, latest, params.chunkSize ?? 40_000n, params.concurrency ?? 1);
  const state = new TreeState();
  await state.append(rows);
  return state.view();
}

// ── incremental sync ─────────────────────────────────────────────────────────

/** A pool's leaf list up to `toBlock`, as JSON: what a TreeStore keeps and a TreeSeed returns. */
export interface TreeSnapshot {
  v: 1;
  pool: Address;
  /** The first block read (gloam.trade's leaf list calls it deployBlock). */
  fromBlock: string;
  /** Every insert up to and including this block is listed. */
  toBlock: string;
  leafCount: number;
  /** In on-chain order. */
  items: TreeInsert[];
  /**
   * The root these items build, once the pool confirmed it. Gloam pools keep
   * every root, so a stored copy whose items still build this root needs no
   * check on load. Only honoured from the store, never from a seed.
   */
  root?: Hex;
}

/** Somewhere to keep a snapshot between runs (a file, a key-value store). Both calls may fail; the sync then goes on without them. */
export interface TreeStore {
  load(): Promise<unknown>;
  save(snapshot: TreeSnapshot): Promise<void>;
}

/** Where a cold start gets its leaves instead of walking the chain: any snapshot-shaped JSON, checked like a stored one. */
export type TreeSeed = () => Promise<unknown>;

export interface TreeSyncParams extends SyncTreeParams {
  /**
   * Keeps the leaf list between runs, so a restart reads only the blocks since.
   * Never trusted: the root rebuilt from it must be one the pool knows.
   */
  store?: TreeStore;
  /**
   * Leaves for a cold start with nothing in the store, e.g. gloamLeafSeed("tempo-mainnet").
   * Checked the same way; on a mismatch the sync walks the chain itself.
   */
  seed?: TreeSeed;
  /** Blocks re-read before the last synced one, in case a node answered behind. Default 16. */
  overlap?: bigint;
  /**
   * Check after each change that the pool knows the rebuilt root (pool.isKnownRoot, one call).
   * Default true. A pool without isKnownRoot is taken as it is.
   */
  verifyRoot?: boolean;
  /**
   * A path for a leaf already in the tree is served without reading the chain
   * when the last sync started at most this many ms ago. Default 0 (every path
   * call syncs first). A path is good for as long as the pool remembers its
   * root, so a server that keeps the tree current (follow) can set a few seconds.
   */
  reuseMs?: number;
}

export interface TreeSync {
  /** Read the blocks since the last sync and return the tree (the same object each time, updated in place). */
  sync(): Promise<SyncedTree>;
  /**
   * Sync, then the membership path of `commitment`, or null when it is not a leaf.
   * `atBlock`: the block the commitment landed in, when known (from its receipt):
   * the sync reads up to it without asking for the head first.
   */
  pathForCommitment(commitment: Hex, opts?: { atBlock?: bigint }): Promise<PoseidonMerklePath | null>;
  /**
   * The path from the tree as it already is (on a cold start, the store's copy,
   * else the seed's), with no log reads. Gloam pools keep every root they have
   * had, so a path from an older tree stays good: a stored copy the pool already
   * confirmed needs no call at all, anything else one call (isKnownRoot). Null
   * when the leaf is not in it or the pool does not confirm the root; then use
   * pathForCommitment.
   */
  knownPath(commitment: Hex): Promise<PoseidonMerklePath | null>;
  /** The last block read, or null before the first sync. */
  readonly toBlock: bigint | null;
  /**
   * Keep syncing in the background, every `intervalMs` after the last sync
   * ends, so a path is ready as soon as a note lands. Errors are retried on the
   * next tick. Returns a stop function; the timer does not keep a process alive.
   */
  follow(intervalMs: number): () => void;
}

const HEX32 = /^0x[0-9a-fA-F]{64}$/;
const UINT = /^\d{1,30}$/;

/** A snapshot from a store or a seed, or null when it is malformed or for another pool. Nothing in it is trusted yet. */
export function parseTreeSnapshot(json: unknown, pool: Address): TreeSnapshot | null {
  if (!json || typeof json !== "object") return null;
  const s = json as Record<string, unknown>;
  if (s.v !== 1 || typeof s.pool !== "string" || s.pool.toLowerCase() !== pool.toLowerCase()) return null;
  const fromBlock = typeof s.fromBlock === "string" ? s.fromBlock : s.deployBlock;
  if (typeof fromBlock !== "string" || !UINT.test(fromBlock)) return null;
  if (typeof s.toBlock !== "string" || !UINT.test(s.toBlock) || !Array.isArray(s.items)) return null;
  const toBlock = BigInt(s.toBlock);
  const items: TreeInsert[] = [];
  let prev: TreeInsert | null = null;
  let count = 0;
  for (const x of s.items as Record<string, unknown>[]) {
    if (!x || typeof x !== "object") return null;
    const k = x.k;
    if (k !== "s" && k !== "t" && k !== "w") return null;
    const c = x.c;
    if (!Array.isArray(c) || c.length !== (k === "s" ? 1 : 2) || !c.every((h) => typeof h === "string" && HEX32.test(h))) return null;
    if (typeof x.bn !== "string" || !UINT.test(x.bn) || BigInt(x.bn) > toBlock) return null;
    if (typeof x.li !== "number" || !Number.isInteger(x.li) || x.li < 0) return null;
    const row: TreeInsert = { k, c: c as Hex[], bn: x.bn, li: x.li };
    if (typeof x.a === "string") row.a = x.a as Address;
    if (typeof x.v === "string" && UINT.test(x.v)) row.v = x.v;
    if (typeof x.f === "string") row.f = x.f as Address;
    if (typeof x.tx === "string") row.tx = x.tx as Hex;
    if (prev && byChainOrder(prev, row) >= 0) return null;
    items.push(row);
    prev = row;
    count += row.c.length;
  }
  if (s.leafCount !== undefined && s.leafCount !== count) return null;
  const root = typeof s.root === "string" && HEX32.test(s.root) ? (s.root.toLowerCase() as Hex) : undefined;
  return { v: 1, pool, fromBlock, toBlock: s.toBlock, leafCount: count, items, ...(root ? { root } : {}) };
}

/** The public leaf list gloam.trade keeps for each live pool (the same for everyone; the request names only the network). */
export const GLOAM_LEAVES_URL = "https://www.gloam.trade/api/vault-leaves";

/**
 * A TreeSeed from gloam.trade's public leaf list, so a cold start is one
 * request instead of a walk over the pool's history. The list is not trusted:
 * createTreeSync checks the root it gives against the pool and walks the chain
 * when it does not match. Null (walk the chain) when the list is unavailable or slower than `timeoutMs` (default 20 s).
 */
export function gloamLeafSeed(
  network: string,
  opts: { url?: string; fetch?: typeof fetch; timeoutMs?: number } = {}
): TreeSeed {
  return async () => {
    const f = opts.fetch ?? fetch;
    const ctrl = new AbortController();
    // Generous: walking the chain instead takes far longer on an RPC that caps log ranges.
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 20_000);
    try {
      const res = await f(`${opts.url ?? GLOAM_LEAVES_URL}?network=${encodeURIComponent(network)}`, {
        signal: ctrl.signal,
        headers: { Accept: "application/json" },
      });
      return res.ok ? await res.json() : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };
}

const IS_KNOWN_ROOT_ABI = [
  {
    type: "function",
    name: "isKnownRoot",
    stateMutability: "view",
    inputs: [{ name: "root", type: "bytes32" }],
    outputs: [{ type: "bool" }],
  },
] as const;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The pool's tree, kept up to date: the first sync starts from the store, else
 * the seed, else the deploy block; every later one reads only the blocks since
 * the last. Calls are serialized, so one TreeSync can serve a whole process
 * (share it between requests). After each change the rebuilt root is checked
 * against the pool's known roots, and a list from the store or the seed that
 * does not match is dropped for a walk of the chain.
 */
export function createTreeSync(client: PublicClient, params: TreeSyncParams): TreeSync {
  const fromBlock = params.fromBlock ?? 0n;
  const chunkSize = params.chunkSize ?? 40_000n;
  const concurrency = params.concurrency ?? 1;
  const overlap = params.overlap ?? 16n;
  let state: TreeState | null = null;
  // The last block read (meaningful once `state` is set). A bigint from the start, never null: Next's file tracer
  // evaluates declarations it can and throws on null + 1n, which would break any app that bundles the SDK.
  let toBlock = -1n;
  /** The leaves came from the store or the seed and the pool has not confirmed them yet. */
  let borrowed = false;
  let verified = false;
  /** When the last sync that went through started (ms), for reuseMs. */
  let syncedAt = 0;
  /** Nothing saved by this TreeSync yet (a seeded or walked list is worth keeping even with no new leaves). */
  let unsaved = true;
  let queue: Promise<unknown> = Promise.resolve();

  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = queue.then(() => fn(), () => fn());
    queue = run.catch(() => undefined);
    return run;
  };

  /** true / false from the pool, null when it could not say (no isKnownRoot, node down). */
  const isKnownRoot = async (root: Hex): Promise<boolean | null> => {
    try {
      return (await client.readContract({ address: params.pool, abi: IS_KNOWN_ROOT_ABI, functionName: "isKnownRoot", args: [root] })) as boolean;
    } catch {
      return null;
    }
  };

  const start = async (loaded: { snap: TreeSnapshot; stored: boolean } | null) => {
    state = new TreeState();
    verified = false;
    if (loaded) {
      await state.append(loaded.snap.items);
      toBlock = BigInt(loaded.snap.toBlock);
      borrowed = true;
      // Our own copy, saved after the pool confirmed this very root: still a root the pool knows.
      if (loaded.stored && loaded.snap.root && loaded.snap.root === fieldToHex(state.tree.currentRoot).toLowerCase()) {
        verified = true;
        borrowed = false;
      }
    } else {
      toBlock = fromBlock - 1n;
      borrowed = false;
    }
  };

  const load = async (): Promise<{ snap: TreeSnapshot; stored: boolean } | null> => {
    if (params.store) {
      const snap = parseTreeSnapshot(await params.store.load().catch(() => null), params.pool);
      if (snap) return { snap, stored: true };
    }
    if (params.seed) {
      const snap = parseTreeSnapshot(await params.seed().catch(() => null), params.pool);
      if (snap) return { snap, stored: false };
    }
    return null;
  };

  /** Read from the last block (less the overlap) to the head. `again`: re-read the overlap even if the head has not moved. */
  const readTail = async (again = false, atBlock?: bigint): Promise<boolean> => {
    const s = state!;
    const head = atBlock !== undefined && atBlock > toBlock ? atBlock : await client.getBlockNumber({ cacheTime: 0 });
    if (head <= toBlock && !again) return false;
    let from = toBlock + 1n - overlap;
    if (from < fromBlock) from = fromBlock;
    if (head < from) return false;
    const rows = (await readInserts(client, params.pool, from, head, chunkSize, concurrency)).filter((r) => !s.keys.has(insertKey(r)));
    if (head > toBlock) toBlock = head;
    if (rows.length === 0) return false;
    const last = s.inserts[s.inserts.length - 1];
    if (!last || byChainOrder(last, rows[0]!) < 0) {
      await s.append(rows);
    } else {
      // A late answer filled in an earlier block: rebuild in order.
      const all = [...s.inserts, ...rows].sort(byChainOrder);
      const b = borrowed;
      await start(null);
      toBlock = head;
      borrowed = b;
      await state!.append(all);
    }
    return true;
  };

  const run = async (again = false, atBlock?: bigint): Promise<SyncedTree> => {
    const began = Date.now();
    if (!state) await start(await load());
    // A node that has not got the hinted block yet may refuse it: then ask for the head as usual.
    let changed = await readTail(again, atBlock).catch((e: unknown) => {
      if (atBlock === undefined) throw e;
      return readTail(again);
    });
    if (params.verifyRoot !== false && (changed || !verified)) {
      const root = fieldToHex(state!.tree.currentRoot);
      let known = await isKnownRoot(root);
      // A node behind the one that served the logs may not know the newest root yet.
      if (known === false) {
        await sleep(750);
        known = await isKnownRoot(root);
      }
      if (known === false && borrowed) {
        // The stored or seeded list does not match the pool: walk the chain instead.
        await start(null);
        changed = await readTail();
        known = await isKnownRoot(fieldToHex(state!.tree.currentRoot));
      }
      if (known === false) {
        state = null;
        toBlock = -1n;
        throw new Error("The rebuilt tree's root is not one the pool knows (an RPC answered with missing logs). Sync again.");
      }
      if (known === true) {
        verified = true;
        borrowed = false;
      }
    }
    if ((changed || unsaved) && params.store) {
      const s = state!;
      unsaved = false;
      await params.store
        .save({
          v: 1,
          pool: params.pool,
          fromBlock: fromBlock.toString(),
          toBlock: toBlock.toString(),
          leafCount: s.tree.nextIndex,
          items: s.inserts,
          ...(verified ? { root: fieldToHex(s.tree.currentRoot).toLowerCase() as Hex } : {}),
        })
        .catch(() => undefined);
    }
    syncedAt = began;
    return state!.view();
  };

  return {
    sync: () => serial(() => run()),
    pathForCommitment: (commitment, opts) =>
      serial(async () => {
        const reuse = params.reuseMs ?? 0;
        if (state && (verified || params.verifyRoot === false) && reuse > 0 && Date.now() - syncedAt <= reuse) {
          const kept = await state.view().pathForCommitment(commitment);
          if (kept) return kept;
        }
        const path = await (await run(false, opts?.atBlock)).pathForCommitment(commitment);
        // Not there: re-read the last few blocks once, in case the node that served them was behind.
        return path ?? (await run(true)).pathForCommitment(commitment);
      }),
    knownPath: (commitment) =>
      serial(async () => {
        if (!state) await start(await load());
        const s = state!;
        const path = await s.view().pathForCommitment(commitment);
        if (!path || verified || params.verifyRoot === false) return path;
        if ((await isKnownRoot(fieldToHex(s.tree.currentRoot))) !== true || state !== s) return null;
        verified = true;
        borrowed = false;
        return path;
      }),
    get toBlock() {
      return state ? toBlock : null;
    },
    follow(intervalMs) {
      let stopped = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const tick = async () => {
        await serial(() => run()).catch(() => undefined);
        if (stopped) return;
        timer = setTimeout(tick, intervalMs);
        (timer as { unref?: () => void }).unref?.();
      };
      void tick();
      return () => {
        stopped = true;
        if (timer) clearTimeout(timer);
      };
    },
  };
}

/**
 * True if the rebuilt tree's root equals the pool's on-chain `currentRoot()`.
 * A cheap integrity check before you trust a path.
 */
export async function assertTreeMatchesChain(
  client: PublicClient,
  pool: Address,
  synced: SyncedTree
): Promise<boolean> {
  try {
    const onchain = (await client.readContract({
      address: pool,
      abi: [
        {
          type: "function",
          name: "currentRoot",
          stateMutability: "view",
          inputs: [],
          outputs: [{ type: "bytes32" }],
        },
      ],
      functionName: "currentRoot",
    })) as Hex;
    return onchain.toLowerCase() === synced.root.toLowerCase();
  } catch {
    return false;
  }
}
