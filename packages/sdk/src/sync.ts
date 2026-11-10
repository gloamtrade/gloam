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
 * The pool's logs are read with one eth_getLogs per block range, filtered by
 * the pool's address only, and split by event here. One request covers all
 * three events, and an address-only query is the one public RPCs allow the
 * widest range for (Robinhood Chain: 10,000,000 blocks, against 100,000 when
 * the query lists topics). A payments pool has no SealedSwapped events; it
 * costs nothing there, since no request is made for it.
 *
 * An RPC error is never read as "no logs": a request that fails is tried again
 * a few times with backoff, a range the RPC calls too wide is split, and
 * anything else throws a TreeSyncError naming the chain and the blocks.
 *
 * viem's PublicClient is injected (no RPC baked in), so the same helper serves
 * a browser app and a node signer.
 */

import { decodeEventLog, parseAbi, toEventSelector, type Address, type Hex, type Log, type PublicClient } from "viem";
import { ELYSIUM_LOG_RANGE_DEFAULT, ELYSIUM_MAINNET_CHAIN_ID, ELYSIUM_TESTNET_CHAIN_ID } from "./elysium.js";
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
  /** The rebuilt tree: call `.path(i)` yourself, or use the helpers below. It never changes after it is handed out. */
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
  /**
   * Blocks per eth_getLogs. Default: what the chain's public RPC takes for one
   * address (treeLogRange). A range the RPC refuses is split to the size it
   * names, or halved, and the smaller size is kept for the rest of the read.
   */
  chunkSize?: bigint;
  /**
   * eth_getLogs ranges in flight at once while walking history. Default: a few
   * on chains whose public RPC takes them (Robinhood Chain, Tempo, Base,
   * Ethereum, Elysium), else 1. A public RPC that answers bursts with 429 wants
   * it low; a 429 is waited out and tried again either way.
   */
  concurrency?: number;
  /**
   * Further tries for a read that failed in a way that may pass (a rate limit,
   * a timeout, a node a block behind), with backoff. Default 3.
   */
  retries?: number;
  /** The first wait before a further try, in ms, doubled each time. Default 400. */
  retryDelayMs?: number;
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

/**
 * A tree sync that could not finish: a read the RPC kept failing, or logs that
 * do not build the pool's root. Nothing partial is returned in its place.
 */
export class TreeSyncError extends Error {
  /** The chain the reads went to, when known. */
  readonly chainId: number | null;
  /** The blocks being read, when the error is about a read. */
  readonly fromBlock: bigint | null;
  readonly toBlock: bigint | null;
  constructor(message: string, opts: { chainId?: number | null; fromBlock?: bigint; toBlock?: bigint; cause?: unknown } = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = "TreeSyncError";
    this.chainId = opts.chainId ?? null;
    this.fromBlock = opts.fromBlock ?? null;
    this.toBlock = opts.toBlock ?? null;
  }
}

/**
 * Blocks per eth_getLogs, for one address, that a chain's default public RPC
 * takes (checked on 10 November 2026): Robinhood Chain 10,000,000 (100,000 if
 * the query lists topics, 30,000 with no address), Tempo 100,000, publicnode
 * (Base, Base Sepolia, Ethereum Sepolia) 50,000, MEV Blocker (Ethereum)
 * 10,000, Elysium 1,000,000 (it caps the logs returned, not the range). Any
 * other chain: 40,000. An RPC that takes less says so, and the range is split.
 */
export function treeLogRange(chainId?: number | null): bigint {
  switch (chainId) {
    case 4663: // Robinhood Chain
    case 46630: // Robinhood Chain testnet
      return 10_000_000n;
    case 4217: // Tempo
    case 42431: // Tempo Moderato
      return 100_000n;
    case 8453: // Base
    case 84532: // Base Sepolia
    case 11155111: // Ethereum Sepolia (publicnode, history through Tenderly's gateway)
      return 50_000n;
    case 1: // Ethereum (MEV Blocker)
      return 10_000n;
    case ELYSIUM_MAINNET_CHAIN_ID:
    case ELYSIUM_TESTNET_CHAIN_ID:
      return BigInt(ELYSIUM_LOG_RANGE_DEFAULT);
    default:
      return 40_000n;
  }
}

/** Ranges in flight at once when walking a chain's history (see SyncTreeParams.concurrency). */
function treeLogConcurrency(chainId?: number | null): number {
  switch (chainId) {
    case 4663:
    case 46630:
    case ELYSIUM_MAINNET_CHAIN_ID:
    case ELYSIUM_TESTNET_CHAIN_ID:
      return 2;
    case 4217:
    case 42431:
    case 8453:
    case 84532:
    case 1:
    case 11155111:
      return 3;
    default:
      return 1;
  }
}

// ── reading the pool's logs ──────────────────────────────────────────────────

const POOL_INSERT_ABI = parseAbi([
  "event Shielded(bytes32 indexed commitment, address indexed asset, uint256 amount, uint256 leafIndex, address indexed from)",
  "event Transferred(bytes32 indexed nullifier, bytes32[2] newCommitments)",
  "event SealedSwapped(bytes32 indexed nullifier, address indexed assetIn, address indexed assetOut, bytes32 newCommitmentOut, bytes32 newCommitmentChange)",
]);
const INSERT_TOPICS = new Set(POOL_INSERT_ABI.map((e) => toEventSelector(e).toLowerCase()));

/** How one sync reads: the range (shrunk when an RPC names a smaller one) and how hard to retry. */
interface LogReader {
  span: bigint;
  readonly concurrency: number;
  readonly retries: number;
  readonly retryDelayMs: number;
  /** From the client's chain; asked of the RPC only for an error message, then kept. */
  chainId: number | null;
}

function logReader(client: PublicClient, params: SyncTreeParams): LogReader {
  const chainId = typeof client.chain?.id === "number" ? client.chain.id : null;
  return {
    span: params.chunkSize !== undefined && params.chunkSize > 0n ? params.chunkSize : treeLogRange(chainId),
    concurrency: Math.max(1, Math.floor(params.concurrency ?? treeLogConcurrency(chainId))),
    retries: Math.max(0, Math.floor(params.retries ?? 3)),
    retryDelayMs: Math.max(0, params.retryDelayMs ?? 400),
    chainId,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The error's own words and its causes', for matching. */
function errText(e: unknown): string {
  const parts: string[] = [];
  let cur: unknown = e;
  for (let i = 0; cur && typeof cur === "object" && i < 6; i++) {
    const o = cur as { details?: unknown; shortMessage?: unknown; message?: unknown; cause?: unknown };
    for (const v of [o.details, o.shortMessage, o.message]) if (typeof v === "string" && v && !parts.includes(v)) parts.push(v);
    cur = o.cause;
  }
  return parts.length ? parts.join(" | ") : String(e);
}

/** The HTTP status and JSON-RPC code anywhere in the error's chain of causes. */
function errCodes(e: unknown): { status?: number; code?: number } {
  const out: { status?: number; code?: number } = {};
  let cur: unknown = e;
  for (let i = 0; cur && typeof cur === "object" && i < 6; i++) {
    const o = cur as { status?: unknown; code?: unknown; cause?: unknown };
    if (out.status === undefined && typeof o.status === "number") out.status = o.status;
    if (out.code === undefined && typeof o.code === "number") out.code = o.code;
    cur = o.cause;
  }
  return out;
}

const RATE_LIMITED = /\b429\b|too many requests|rate.?limit|throttl/i;
/** A node behind the one that gave the head: it has not got the block yet. */
const NODE_BEHIND = /beyond (the )?(current )?head|header not found|unknown block|block not found|block (is )?not (yet )?available|invalid block range|not (yet )?synced/i;
const RANGE_REFUSED =
  /block range|range (is )?too|exceeds? (the )?max|max(imum)? (block )?range|only [\d,]+ are allowed|limited to a [\d,]+ range|ranges over [\d,]+ blocks|more than [\d,]+ (results|logs)|too many (results|logs)|logs? matched|response size|response (is )?too (big|large)|query timeout|limit exceeded/i;
/** State the node no longer keeps: asking again gets the same answer. */
const PRUNED = /missing trie node|state (is )?not available|historical state|pruned/i;
/** Asking again gets the same answer: a bad request, a call that reverts. */
const NOT_RETRYABLE = /invalid argument|invalid address|invalid params(?!.*range)|method not found|not supported|unauthori[sz]ed|api key|revert|returned no data/i;

type ErrorKind = "range" | "retry" | "fatal";

function classify(e: unknown): ErrorKind {
  const text = errText(e);
  const { status, code } = errCodes(e);
  if (status === 429 || code === 429 || RATE_LIMITED.test(text)) return "retry";
  if (code === -32601 || status === 401 || status === 404 || PRUNED.test(text)) return "fatal";
  if (NODE_BEHIND.test(text)) return "retry";
  if (status === 413 || RANGE_REFUSED.test(text)) return "range";
  if (status === 400 || NOT_RETRYABLE.test(text)) return "fatal";
  return "retry";
}

/** The range the node says it takes ("only 100000 are allowed", "max block range 100000"), if it says. */
function allowedSpan(e: unknown): bigint | null {
  const m = /only ([\d,]+) are allowed|max(?:imum)? block range:? (?:is )?([\d,]+)|limited to a ([\d,]+) range|ranges over ([\d,]+) blocks|range (?:of|is) ([\d,]+)/i.exec(errText(e));
  const v = m?.[1] ?? m?.[2] ?? m?.[3] ?? m?.[4] ?? m?.[5];
  if (!v) return null;
  const n = BigInt(v.replace(/,/g, ""));
  return n > 0n ? n : null;
}

/** The chain the client reads, for an error message (asked of the RPC at most once). Never throws. */
async function chainOf(client: PublicClient, reader: LogReader): Promise<string> {
  if (reader.chainId === null && typeof client.getChainId === "function") {
    try {
      reader.chainId = Number(await client.getChainId());
    } catch {
      // keep the message without it
    }
  }
  return reader.chainId === null ? "(unknown)" : String(reader.chainId);
}

/** What went wrong, in one short line: the node's own words where viem kept them. */
function reason(e: unknown): string {
  let cur: unknown = e;
  for (let i = 0; cur && typeof cur === "object" && i < 6; i++) {
    const o = cur as { details?: unknown; cause?: unknown };
    if (typeof o.details === "string" && o.details.trim()) return o.details.trim().split("\n")[0]!.slice(0, 300);
    cur = o.cause;
  }
  const o = e as { shortMessage?: unknown; message?: unknown } | null;
  const text = typeof o?.shortMessage === "string" ? o.shortMessage : typeof o?.message === "string" ? o.message : String(e);
  return text.trim().split("\n")[0]!.slice(0, 300);
}

/** `fn`, tried again on an error that may pass, with backoff. Throws the last error (or a fatal one at once). */
async function withRetries<T>(reader: LogReader, fn: () => Promise<T>): Promise<{ value: T } | { error: unknown; tries: number }> {
  for (let attempt = 0; ; attempt++) {
    try {
      return { value: await fn() };
    } catch (e) {
      if (classify(e) !== "retry" || attempt >= reader.retries) return { error: e, tries: attempt + 1 };
      await sleep(reader.retryDelayMs * 2 ** attempt);
    }
  }
}

/** The chain head, asked fresh (a cached head can miss a note made seconds before it is spent). */
async function headOf(client: PublicClient, reader: LogReader): Promise<bigint> {
  const r = await withRetries(reader, () => client.getBlockNumber({ cacheTime: 0 }));
  if ("value" in r) return r.value;
  const chain = await chainOf(client, reader);
  throw new TreeSyncError(`Tree sync on chain ${chain}: could not read the chain head after ${r.tries} tries: ${reason(r.error)}`, {
    chainId: reader.chainId,
    cause: r.error,
  });
}

class RangeRefused extends Error {
  constructor(readonly cause: unknown) {
    super("range refused");
  }
}

/** One eth_getLogs for the pool over [from, to]. A refused range throws RangeRefused, anything else a TreeSyncError once retries run out. */
async function getLogsOnce(client: PublicClient, pool: Address, from: bigint, to: bigint, reader: LogReader): Promise<Log[]> {
  const r = await withRetries(reader, async () => (await client.getLogs({ address: pool, fromBlock: from, toBlock: to })) as Log[]);
  if ("value" in r) return r.value;
  // Not tried again as it is: the caller splits it.
  if (classify(r.error) === "range") throw new RangeRefused(r.error);
  const chain = await chainOf(client, reader);
  throw new TreeSyncError(
    `Tree sync on chain ${chain}: eth_getLogs for ${pool} over blocks ${from}-${to} failed after ${r.tries} ${r.tries === 1 ? "try" : "tries"}: ${reason(r.error)}`,
    { chainId: reader.chainId, fromBlock: from, toBlock: to, cause: r.error }
  );
}

function ranges(from: bigint, to: bigint, span: bigint): [bigint, bigint][] {
  const out: [bigint, bigint][] = [];
  for (let s = from; s <= to; s += span) out.push([s, s + span - 1n > to ? to : s + span - 1n]);
  return out;
}

/**
 * Every log the pool emitted in [from, to]. Ranges go out `concurrency` at a
 * time; one the RPC refuses is split (to the size it names, else in half) and
 * the rest of the read uses the smaller size. The first failure stops the read
 * and throws: never a partial list.
 */
async function readPoolLogs(client: PublicClient, pool: Address, from: bigint, to: bigint, reader: LogReader): Promise<Log[]> {
  if (to < from) return [];
  const queue: { from: bigint; to: bigint; depth: number }[] = ranges(from, to, reader.span).map(([a, b]) => ({ from: a, to: b, depth: 0 }));
  const out: Log[][] = [];
  let failed: { error: unknown } | null = null;
  const worker = async () => {
    while (queue.length && !failed) {
      const job = queue.shift()!;
      // Planned before the RPC named a smaller range: split it now, so the parts go out side by side.
      if (job.to - job.from + 1n > reader.span) {
        const parts = ranges(job.from, job.to, reader.span).map(([a, b]) => ({ from: a, to: b, depth: job.depth }));
        queue.unshift(...parts.slice(1));
        job.to = parts[0]!.to;
      }
      try {
        out.push(await getLogsOnce(client, pool, job.from, job.to, reader));
      } catch (e) {
        if (e instanceof RangeRefused && job.to > job.from && job.depth < 32) {
          const width = job.to - job.from + 1n;
          const named = allowedSpan(e.cause);
          const span = named !== null && named < width ? named : (width + 1n) / 2n;
          if (span < reader.span) reader.span = span;
          queue.unshift(...ranges(job.from, job.to, span).map(([a, b]) => ({ from: a, to: b, depth: job.depth + 1 })));
          continue;
        }
        if (e instanceof RangeRefused) {
          const chain = await chainOf(client, reader);
          failed = {
            error: new TreeSyncError(
              `Tree sync on chain ${chain}: the RPC refused eth_getLogs for ${pool} over blocks ${job.from}-${job.to}, even split: ${reason(e.cause)}`,
              { chainId: reader.chainId, fromBlock: job.from, toBlock: job.to, cause: e.cause }
            ),
          };
        } else {
          failed = { error: e };
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(reader.concurrency, queue.length)) }, worker));
  if (failed) throw (failed as { error: unknown }).error;
  return out.flat();
}

function decodeInsertLog(log: Log, chain: string) {
  try {
    return decodeEventLog({ abi: POOL_INSERT_ABI, data: log.data, topics: log.topics as [Hex, ...Hex[]], strict: true });
  } catch (e) {
    throw new TreeSyncError(`Tree sync on chain ${chain}: the pool's log at block ${log.blockNumber}, index ${log.logIndex} does not decode: ${reason(e)}`, {
      cause: e,
    });
  }
}

/** The pool's leaf-inserting events among `logs`, in chain order. Other events of the pool are passed over. */
function decodeInserts(logs: Log[], pool: Address, chain: string): TreeInsert[] {
  const out: TreeInsert[] = [];
  const seen = new Map<string, string>();
  const want = pool.toLowerCase();
  for (const log of logs) {
    if (log.removed) continue;
    if (typeof log.address === "string" && log.address.toLowerCase() !== want) continue;
    const topic0 = log.topics?.[0]?.toLowerCase();
    if (!topic0 || !INSERT_TOPICS.has(topic0)) continue;
    if (log.blockNumber === null || log.blockNumber === undefined || log.logIndex === null || log.logIndex === undefined) {
      throw new TreeSyncError(`Tree sync on chain ${chain}: the RPC returned one of the pool's logs without its block or log index.`);
    }
    const ev = decodeInsertLog(log, chain);
    const meta = { bn: log.blockNumber.toString(), li: log.logIndex, ...(log.transactionHash ? { tx: log.transactionHash } : {}) };
    let row: TreeInsert;
    if (ev.eventName === "Shielded") {
      row = { k: "s", c: [ev.args.commitment], a: ev.args.asset, v: ev.args.amount.toString(), f: ev.args.from, ...meta };
    } else if (ev.eventName === "Transferred") {
      row = { k: "t", c: [ev.args.newCommitments[0], ev.args.newCommitments[1]], ...meta };
    } else {
      row = { k: "w", c: [ev.args.newCommitmentOut, ev.args.newCommitmentChange], a: ev.args.assetOut, ...meta };
    }
    // The same log twice (ranges never overlap, so only a faulty answer does this): once is enough, two different ones is an error.
    const key = insertKey(row);
    const sig = `${row.k}:${row.c.join(",").toLowerCase()}`;
    const prev = seen.get(key);
    if (prev !== undefined) {
      if (prev !== sig) throw new TreeSyncError(`Tree sync on chain ${chain}: the RPC returned two different logs at block ${row.bn}, index ${row.li}.`);
      continue;
    }
    seen.set(key, sig);
    out.push(row);
  }
  return out.sort(byChainOrder);
}

/** Every leaf-inserting event of `pool` in [fromBlock, toBlock], sorted in on-chain order. Throws rather than return a partial list. */
async function readInserts(client: PublicClient, pool: Address, fromBlock: bigint, toBlock: bigint, reader: LogReader): Promise<TreeInsert[]> {
  const logs = await readPoolLogs(client, pool, fromBlock, toBlock, reader);
  return decodeInserts(logs, pool, reader.chainId === null ? "(unknown)" : String(reader.chainId));
}

function byChainOrder(x: TreeInsert, y: TreeInsert): number {
  const bx = BigInt(x.bn);
  const by = BigInt(y.bn);
  if (bx !== by) return bx < by ? -1 : 1;
  return x.li - y.li;
}

const insertKey = (r: TreeInsert) => `${r.bn}:${r.li}`;

const sameInsert = (x: TreeInsert | undefined, y: TreeInsert) =>
  !!x && x.k === y.k && x.c.length === y.c.length && x.c.every((c, i) => c.toLowerCase() === y.c[i]!.toLowerCase());

/** A tree being built: the leaves so far and the events they came from. */
class TreeState {
  tree = new IncrementalMerkleTreePoseidon();
  leaves: ChainLeaf[] = [];
  indexByCommitment = new Map<string, number>();
  inserts: TreeInsert[] = [];
  keys = new Set<string>();
  /** A view has been handed out: the next append copies the tree first, so no view ever changes under its holder. */
  private shared = false;

  async append(rows: TreeInsert[]) {
    await this.tree.init();
    if (rows.length === 0) return;
    if (this.shared) {
      this.tree = this.tree.clone();
      this.leaves = this.leaves.slice();
      this.indexByCommitment = new Map(this.indexByCommitment);
      this.shared = false;
    }
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

  /** The tree as it is now. Later appends do not change it (they work on a copy). */
  view(): SyncedTree {
    this.shared = true;
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
 * instead: it reads only the blocks since its last sync, and checks its root
 * against the pool. Throws a TreeSyncError when a read fails (after retries).
 */
export async function syncTree(
  client: PublicClient,
  params: SyncTreeParams
): Promise<SyncedTree> {
  const fromBlock = params.fromBlock ?? 0n;
  const reader = logReader(client, params);
  const latest = await headOf(client, reader);
  const rows = await readInserts(client, params.pool, fromBlock, latest, reader);
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
  /**
   * Blocks re-read before the last synced one on every sync, in case a node
   * answered behind or the chain reorganized: a leaf held for those blocks
   * that the new read no longer shows is dropped. Default 16.
   */
  overlap?: bigint;
  /**
   * Check after each sync that read new blocks that the rebuilt root is the
   * pool's root at the last block read (pool.currentRoot() at that block; one
   * call). Where the node can't answer for that block, pool.isKnownRoot()
   * instead. Default true. A pool with neither is taken as it is.
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
  /** Read the blocks since the last sync and return the tree as it is then (it does not change after; the next sync returns a new one). */
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
  /** Blocks per eth_getLogs it reads with now: the chain's default, or less once the RPC named a smaller range. */
  readonly logRange: bigint;
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

const CURRENT_ROOT_ABI = [
  {
    type: "function",
    name: "currentRoot",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "bytes32" }],
  },
] as const;

/** The pool has no such function (an older pool, or not a pool): the call reverts or returns nothing. */
const isMissingFunction = (e: unknown) => /revert|returned no data|function selector|does not have the function/i.test(errText(e));

/**
 * The pool's tree, kept up to date: the first sync starts from the store, else
 * the seed, else the deploy block; every later one reads only the blocks since
 * the last. Calls are serialized, so one TreeSync can serve a whole process
 * (share it between requests). After each sync that read new blocks, the
 * rebuilt root is checked against the pool's root at the last block read; a
 * list from the store or the seed that does not match is dropped for a walk of
 * the chain, and a walk that does not match throws (the next sync starts over).
 */
export function createTreeSync(client: PublicClient, params: TreeSyncParams): TreeSync {
  const fromBlock = params.fromBlock ?? 0n;
  const reader = logReader(client, params);
  const overlap = params.overlap ?? 16n;
  const verify = params.verifyRoot !== false;
  let state: TreeState | null = null;
  // The last block read (meaningful once `state` is set). A bigint from the start, never null: Next's file tracer
  // evaluates declarations it can and throws on null + 1n, which would break any app that bundles the SDK.
  let toBlock = -1n;
  /**
   * The leaves came from the store or the seed (confirmed by the pool or not). A tree from one that stops
   * matching the pool (a reorg since it was saved) is dropped for a walk of the chain, not refused.
   */
  let fromLoad = false;
  /** The loaded copy has not been read past yet: its blocks past this node's head do not count as read. */
  let loadUnread = false;
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

  /** true / false from the pool, null when it could not say (no isKnownRoot, node down). For knownPath. */
  const isKnownRoot = async (root: Hex): Promise<boolean | null> => {
    try {
      return (await client.readContract({ address: params.pool, abi: IS_KNOWN_ROOT_ABI, functionName: "isKnownRoot", args: [root] })) as boolean;
    } catch {
      return null;
    }
  };

  /**
   * How the tree stands against the pool at `toBlock`: "exact" (the pool's
   * root there), "known" (a root the pool knows; its root at that block could
   * not be read), "wrong" (neither), "unchecked" (the pool has neither
   * function). Throws when the RPC can't answer at all.
   */
  const check = async (): Promise<"exact" | "known" | "wrong" | "unchecked"> => {
    const root = fieldToHex(state!.tree.currentRoot).toLowerCase();
    const at = await withRetries(reader, () =>
      client.readContract({ address: params.pool, abi: CURRENT_ROOT_ABI, functionName: "currentRoot", blockNumber: toBlock })
    );
    if ("value" in at) return (at.value as string).toLowerCase() === root ? "exact" : "wrong";
    // That block's state is not there (pruned, or a node behind): ask whether the pool knows the root at all.
    const known = await withRetries(reader, () =>
      client.readContract({ address: params.pool, abi: IS_KNOWN_ROOT_ABI, functionName: "isKnownRoot", args: [root as Hex] })
    );
    if ("value" in known) return known.value ? "known" : "wrong";
    if (isMissingFunction(at.error) && isMissingFunction(known.error)) return "unchecked";
    const chain = await chainOf(client, reader);
    throw new TreeSyncError(`Tree sync on chain ${chain}: could not read the pool's root to check the tree (block ${toBlock}): ${reason(at.error)}`, {
      chainId: reader.chainId,
      toBlock,
      cause: at.error,
    });
  };

  const start = async (loaded: { snap: TreeSnapshot; stored: boolean } | null) => {
    state = new TreeState();
    verified = false;
    fromLoad = loaded !== null;
    loadUnread = loaded !== null;
    if (loaded) {
      await state.append(loaded.snap.items);
      toBlock = BigInt(loaded.snap.toBlock);
      // Our own copy, saved after the pool confirmed this very root: still a root the pool knows.
      if (loaded.stored && loaded.snap.root && loaded.snap.root === fieldToHex(state.tree.currentRoot).toLowerCase()) verified = true;
    } else {
      await state.append([]);
      toBlock = fromBlock - 1n;
    }
  };

  /** The same leaves in a new tree (the old one may be in a view someone holds), to be checked again. */
  const rebuild = async (rows: TreeInsert[]) => {
    const s = new TreeState();
    await s.append(rows);
    state = s;
    verified = false;
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

  /**
   * Read from the last block (less the overlap) to the head. `again`: re-read
   * the overlap even if the head has not moved. `read`: blocks were read;
   * `changed`: the tree changed.
   */
  const readTail = async (again = false, atBlock?: bigint): Promise<{ read: boolean; changed: boolean }> => {
    const head = atBlock !== undefined && atBlock > toBlock ? atBlock : await headOf(client, reader);
    if (loadUnread && head < toBlock) {
      // A stored copy or leaf list read further than this node has got (a node behind, or a fork of the chain):
      // keep only what this node can confirm, and read its last blocks.
      const kept = state!.inserts.filter((r) => BigInt(r.bn) <= head);
      await rebuild(kept);
      toBlock = head;
      again = true;
    }
    const s = state!;
    if (head <= toBlock && !again) return { read: false, changed: false };
    let from = toBlock + 1n - overlap;
    if (from < fromBlock) from = fromBlock;
    if (head < from) return { read: false, changed: false };
    const fresh = await readInserts(client, params.pool, from, head, reader);
    const reached = head > toBlock ? head : toBlock;
    // New blocks, or the last ones again: the root has to be checked again before the tree counts as confirmed.
    verified = false;
    loadUnread = false;

    // Every leaf held for the blocks just read again must still be there. One that is gone (or changed) means the
    // chain reorganized or a node answered with logs missing: rebuild from the new read, and let the root check decide.
    const freshByKey = new Map(fresh.map((r) => [insertKey(r), r]));
    let lost = false;
    for (let i = s.inserts.length - 1; i >= 0 && BigInt(s.inserts[i]!.bn) >= from; i--) {
      // Held for a block past this node's head (it is behind the one that served them): not read again, kept.
      if (BigInt(s.inserts[i]!.bn) > head) continue;
      if (!sameInsert(freshByKey.get(insertKey(s.inserts[i]!)), s.inserts[i]!)) {
        lost = true;
        break;
      }
    }
    if (lost) {
      toBlock = reached;
      const before = s.inserts.filter((r) => BigInt(r.bn) < from);
      const after = s.inserts.filter((r) => BigInt(r.bn) > head);
      await rebuild([...before, ...fresh, ...after]);
      return { read: true, changed: true };
    }

    toBlock = reached;
    const rows = fresh.filter((r) => !s.keys.has(insertKey(r)));
    if (rows.length === 0) return { read: true, changed: false };
    const last = s.inserts[s.inserts.length - 1];
    if (!last || byChainOrder(last, rows[0]!) < 0) {
      await s.append(rows);
    } else {
      // A late answer filled in an earlier block: rebuild in order.
      await rebuild([...s.inserts, ...rows].sort(byChainOrder));
    }
    return { read: true, changed: true };
  };

  const run = async (again = false, atBlock?: bigint): Promise<SyncedTree> => {
    const began = Date.now();
    if (!state) await start(await load());
    // A node that has not got the hinted block yet may refuse it: then ask for the head as usual.
    const tail = await readTail(again, atBlock).catch((e: unknown) => {
      if (atBlock === undefined) throw e;
      return readTail(again);
    });
    let changed = tail.changed;
    if (verify && (tail.read || !verified)) {
      let result = await check();
      if (result === "wrong") {
        // The node that served the logs, or the one that served the root, may be a block behind: read the last blocks again, once.
        await sleep(750);
        changed = (await readTail(true)).changed || changed;
        result = await check();
      }
      if (result === "wrong" && fromLoad) {
        // The stored or seeded list does not match the pool: walk the chain instead.
        await start(null);
        await readTail();
        changed = true;
        result = await check();
      }
      if (result === "wrong") {
        const at = toBlock;
        const leaves = state!.tree.nextIndex;
        state = null;
        toBlock = -1n;
        const chain = await chainOf(client, reader);
        throw new TreeSyncError(
          `Tree sync on chain ${chain}: the tree rebuilt from the RPC's logs (${leaves} leaves, to block ${at}) does not match the pool's root (an RPC answered with logs missing, or the chain reorganized). Nothing was used; sync again.`,
          { chainId: reader.chainId, toBlock: at }
        );
      }
      if (result === "exact" || result === "known") verified = true;
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
        if (state && (verified || !verify) && reuse > 0 && Date.now() - syncedAt <= reuse) {
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
        if (!path || verified || !verify) return path;
        if ((await isKnownRoot(fieldToHex(s.tree.currentRoot))) !== true || state !== s) return null;
        verified = true;
        return path;
      }),
    get toBlock() {
      return state ? toBlock : null;
    },
    get logRange() {
      return reader.span;
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
      abi: CURRENT_ROOT_ABI,
      functionName: "currentRoot",
    })) as Hex;
    return onchain.toLowerCase() === synced.root.toLowerCase();
  } catch {
    return false;
  }
}
