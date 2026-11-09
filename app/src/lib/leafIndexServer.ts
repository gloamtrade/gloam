/**
 * Server side of /api/vault-leaves: keeps each live network's leaf list
 * (lib/leafIndex) current so a browser can load it in one request instead of
 * walking the chain itself. Server only.
 *
 * - The first read walks the pool's history once; after that each refresh only
 *   reads the blocks since, re-reading a short overlap in case of a reorg.
 * - Kept in memory, and in Upstash Redis (lib/tractionStore) so a cold
 *   serverless instance starts from the last copy instead of the deploy block.
 * - Answers from the kept copy straight away and refreshes it in the
 *   background (single-flight, at most once per FRESH_MS per network). Only a
 *   copy older than STALE_OK_MS, or none at all, makes a request wait for the
 *   chain. The browser reads anything after the copy's toBlock itself, so a
 *   slightly old copy costs it nothing but a slightly wider read.
 * - Self-checks before serving: every deposit's own leafIndex must match its
 *   position, and the count must match the pool's nextIndex() at the block
 *   read. On a mismatch the whole history is read again once.
 *
 * Browsers never trust this list on its own: they rebuild the tree and check
 * the root against the pool on chain, and walk the chain themselves if it does
 * not match (lib/treeSync). Nothing a browser sends here identifies a user or a
 * note; the list is the same public data for everyone.
 */

import { createPublicClient, parseAbi, type PublicClient } from "viem";
import { getNetwork, isNetworkWritable, type GloamNetwork, type NetworkKey } from "./networks";
import { cacheGetJson, cacheSetJson } from "./tractionStore";
import {
  leafCountOf,
  numberInserts,
  parseLeafSnapshot,
  replaceFrom,
  walkInserts,
  walkTuning,
  type LeafSnapshot,
  type RawInsert,
} from "./leafIndex";
import { serverTransport } from "@/lib/serverRpc";

const FRESH_MS = 2_000;
/**
 * Serve a kept copy at most this old without waiting for a refresh. Browsers
 * check a copy against the pool's root at its toBlock, and Robinhood's public
 * RPC keeps only about ten minutes of past state, so keep this well under that.
 */
const STALE_OK_MS = 5 * 60_000;
const REORG_OVERLAP = 64n;
const REDIS_PREFIX = "gloam:leaves:v1";
const REDIS_TTL_SEC = 30 * 86_400;
/** Redis write at most this often when nothing new was inserted. */
const SAVE_EVERY_MS = 60_000;
/** The shortest gap between two writes of the shared copy; another instance reads at most this far behind and walks the rest. */
const MIN_SAVE_GAP_MS = 15_000;

const POOL_COUNT_ABI = parseAbi(["function nextIndex() view returns (uint256)"]);

type State = {
  toBlock: bigint;
  items: RawInsert[];
  readAt: number;
  savedAt: number;
  savedTip: string;
};

const states = new Map<string, State>();
const inflight = new Map<string, Promise<State>>();
const clients = new Map<number, PublicClient>();

function clientFor(n: GloamNetwork): PublicClient {
  const hit = clients.get(n.chainId);
  if (hit) return hit;
  const c = createPublicClient({
    chain: n.chain,
    ccipRead: false,
    // viem retries 429s, 5xx and timeouts with backoff.
    transport: serverTransport(n, { timeout: 15_000, retryCount: 3, retryDelay: 400 }),
  });
  clients.set(n.chainId, c);
  return c;
}

function stateId(n: GloamNetwork): string {
  return `${n.chainId}:${n.pool!.toLowerCase()}`;
}

/** A fingerprint of the list, to skip Redis writes when nothing changed. */
function tipOf(items: RawInsert[]): string {
  const last = items[items.length - 1];
  return `${items.length}:${last?.bn ?? ""}:${last?.li ?? ""}`;
}

function toSnapshot(n: GloamNetwork, st: State): LeafSnapshot {
  return {
    v: 1,
    chainId: n.chainId,
    pool: n.pool!,
    deployBlock: (n.deployBlock ?? 0n).toString(),
    toBlock: st.toBlock.toString(),
    leafCount: leafCountOf(st.items),
    items: st.items,
    at: st.readAt,
  };
}

async function loadSaved(n: GloamNetwork): Promise<State | null> {
  const raw = await cacheGetJson<unknown>(`${REDIS_PREFIX}:${stateId(n)}`);
  const snap = raw ? parseLeafSnapshot(raw, n.chainId, n.pool!) : null;
  if (!snap) return null;
  return { toBlock: BigInt(snap.toBlock), items: snap.items, readAt: snap.at, savedAt: Date.now(), savedTip: tipOf(snap.items) };
}

/** The pool's leaf count at `block`, or null when the node cannot say. */
async function countAt(c: PublicClient, n: GloamNetwork, block: bigint): Promise<number | null> {
  try {
    const v = await c.readContract({ address: n.pool!, abi: POOL_COUNT_ABI, functionName: "nextIndex", blockNumber: block });
    return Number(v);
  } catch {
    return null;
  }
}

/** Numbered list if it adds up: deposits at their own leafIndex, and the pool's count at the block read. */
function checked(items: RawInsert[], count: number | null): RawInsert[] | null {
  const numbered = numberInserts(items);
  if (!numbered) return null;
  return count == null || count === leafCountOf(numbered) ? numbered : null;
}

async function refresh(n: GloamNetwork): Promise<State> {
  const id = stateId(n);
  const deploy = n.deployBlock ?? 0n;
  const prev = states.get(id) ?? (await loadSaved(n));
  const c = clientFor(n);
  const tuning = walkTuning(n.chainId, n.logRange);
  const latest = await c.getBlockNumber({ cacheTime: 0 });

  if (prev && prev.toBlock >= latest) {
    // This RPC node is behind the one that served the last read; nothing new.
    const st = { ...prev, readAt: Date.now() };
    states.set(id, st);
    return st;
  }

  const countP = countAt(c, n, latest);
  let items: RawInsert[] | null = null;
  if (prev) {
    const from = prev.toBlock - REORG_OVERLAP + 1n > deploy ? prev.toBlock - REORG_OVERLAP + 1n : deploy;
    const [fresh, count] = await Promise.all([walkInserts(c, n.pool!, from, latest, tuning), countP]);
    items = checked(replaceFrom(prev.items, from, fresh), count);
  }
  if (!items) {
    // First read, or the kept copy no longer adds up: read the whole history.
    const [all, count] = await Promise.all([walkInserts(c, n.pool!, deploy, latest, tuning), countP]);
    items = checked(all, count);
    if (!items) throw new Error("vault leaf list does not match the pool");
  }

  const st: State = {
    toBlock: latest,
    items,
    readAt: Date.now(),
    savedAt: prev?.savedAt ?? 0,
    savedTip: prev?.savedTip ?? "",
  };
  const tip = tipOf(items);
  // a busy pool changes its tip every block: write the shared copy at most every MIN_SAVE_GAP_MS
  const sinceSave = Date.now() - st.savedAt;
  if ((tip !== st.savedTip && sinceSave > MIN_SAVE_GAP_MS) || sinceSave > SAVE_EVERY_MS) {
    await cacheSetJson(`${REDIS_PREFIX}:${id}`, toSnapshot(n, st), REDIS_TTL_SEC);
    st.savedAt = Date.now();
    st.savedTip = tip;
  }
  states.set(id, st);
  return st;
}

function refreshOnce(n: GloamNetwork): Promise<State> {
  const id = stateId(n);
  let p = inflight.get(id);
  if (!p) {
    p = refresh(n).finally(() => inflight.delete(id));
    inflight.set(id, p);
  }
  return p;
}

/**
 * The live pool's leaf list for a network, or null when it has no live pool.
 * A kept copy under STALE_OK_MS old is returned at once; if it is over
 * FRESH_MS old a refresh is handed to `background` (e.g. next/server `after`)
 * so the next caller gets a newer one.
 */
export async function getLeafSnapshot(
  key: NetworkKey,
  background: (task: () => Promise<void>) => void = (task) => void task()
): Promise<LeafSnapshot | null> {
  const n = getNetwork(key);
  if (!isNetworkWritable(n) || !n.pool) return null;
  const id = stateId(n);
  let st = states.get(id) ?? null;
  if (!st) {
    st = await loadSaved(n);
    if (st && !states.has(id)) states.set(id, st);
  }
  const age = st ? Date.now() - st.readAt : Infinity;
  if (st && age < STALE_OK_MS) {
    if (age >= FRESH_MS && !inflight.has(id)) {
      background(() => refreshOnce(n).then(() => undefined, () => undefined));
    }
    return toSnapshot(n, st);
  }
  return toSnapshot(n, await refreshOnce(n));
}
