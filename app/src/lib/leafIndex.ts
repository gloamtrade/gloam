/**
 * The vault's leaf list: every commitment the shielded pool has put into its
 * Merkle tree, in insertion order. Public chain data only: commitments, and for
 * deposits the token, amount and depositor the Shielded event already shows.
 *
 * Shared by the browser (lib/treeSync) and the server (lib/leafIndexServer,
 * /api/vault-leaves) so both read the chain the same way:
 *   - Shielded → one leaf (commitment)
 *   - Transferred → two leaves (payment, change) in that order
 *   - SealedSwapped → two leaves (out, change) in that order
 *
 * Logs are read with address-only eth_getLogs and decoded here. Robinhood's
 * RPC takes an address-only query over millions of blocks (the vault's whole
 * history in one call) but caps queries that list several event topics at
 * 100k; Tempo caps every query at 100k blocks and answers 429 to bursts, so
 * its spans go out a few at a time, spaced. A span the node calls too wide is
 * split to the size it names (or halved) and retried.
 */

import { parseAbi, parseEventLogs, type AbiEvent, type Address, type Hex, type Log, type PublicClient } from "viem";
import { isElysiumChainId } from "./elysium";

export const POOL_INSERT_ABI = parseAbi([
  "event Shielded(bytes32 indexed commitment, address indexed asset, uint256 amount, uint256 leafIndex, address indexed from)",
  "event Transferred(bytes32 indexed nullifier, bytes32[2] newCommitments)",
  // Older pools have no SealedSwapped; it simply never matches there.
  "event SealedSwapped(bytes32 indexed nullifier, address indexed assetIn, address indexed assetOut, bytes32 newCommitmentOut, bytes32 newCommitmentChange)",
]);

/**
 * One pool insertion event in a compact, JSON-safe form. Also the browser's
 * persisted cache format (lib/treeSync), so keep additions optional.
 */
export type RawInsert = {
  /** s = shield, t = private send, w = sealed swap */
  k: "s" | "t" | "w";
  /** commitments in the order the contract inserts them */
  c: Hex[];
  a?: Address;
  v?: string;
  f?: Address;
  tx?: Hex;
  bn: string;
  li: number;
  /**
   * Leaf index of c[0]. On a freshly decoded deposit it is the pool's own
   * value from the event; numberInserts() sets it on every item.
   */
  i?: number;
};

/** What /api/vault-leaves returns. */
export type LeafSnapshot = {
  v: 1;
  chainId: number;
  pool: Address;
  deployBlock: string;
  /** Last block read: every insert up to and including it is listed. */
  toBlock: string;
  leafCount: number;
  /** In insertion order, each with its first leaf index `i`. */
  items: RawInsert[];
  /** When the server last read the chain (ms since epoch). */
  at: number;
};

// ------------------------------------------------------------------ decode

export function decodeInserts(logs: Log[]): RawInsert[] {
  const out: RawInsert[] = [];
  const parsed = parseEventLogs({ abi: POOL_INSERT_ABI, logs, strict: true });
  for (const log of parsed) {
    if (log.removed) continue;
    const base = {
      tx: (log.transactionHash ?? undefined) as Hex | undefined,
      bn: (log.blockNumber ?? 0n).toString(),
      li: log.logIndex ?? 0,
    };
    if (log.eventName === "Shielded") {
      const a = log.args;
      out.push({
        ...base,
        k: "s",
        c: [a.commitment],
        a: a.asset,
        v: a.amount.toString(),
        f: a.from,
        i: a.leafIndex <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(a.leafIndex) : -1,
      });
    } else if (log.eventName === "Transferred") {
      const pair = log.args.newCommitments;
      out.push({ ...base, k: "t", c: [pair[0], pair[1]] });
    } else if (log.eventName === "SealedSwapped") {
      const a = log.args;
      out.push({ ...base, k: "w", c: [a.newCommitmentOut, a.newCommitmentChange], a: a.assetOut });
    }
  }
  return out;
}

/** Chain order: block, then log index. */
export function sortInserts(items: RawInsert[]): RawInsert[] {
  return items.slice().sort((x, y) => {
    const bx = BigInt(x.bn);
    const by = BigInt(y.bn);
    if (bx !== by) return bx < by ? -1 : 1;
    return x.li - y.li;
  });
}

/**
 * Keep what was read before `from`, take `fresh` for `from` onward. Re-reading
 * an overlap this way also drops logs a reorg removed.
 */
export function replaceFrom(prev: RawInsert[], from: bigint, fresh: RawInsert[]): RawInsert[] {
  return sortInserts(prev.filter((r) => BigInt(r.bn) < from).concat(fresh.filter((r) => BigInt(r.bn) >= from)));
}

export function leafCountOf(items: RawInsert[]): number {
  let n = 0;
  for (const r of items) n += r.c.length;
  return n;
}

/**
 * Set each item's first leaf index from its position. Null when a deposit's
 * own leafIndex disagrees, i.e. a log is missing or out of order.
 */
export function numberInserts(items: RawInsert[]): RawInsert[] | null {
  let next = 0;
  const out: RawInsert[] = [];
  for (const r of items) {
    if (r.k === "s" && r.i != null && r.i !== next) return null;
    out.push({ ...r, i: next });
    next += r.c.length;
  }
  return out;
}

// ------------------------------------------------------------------ walk

export type WalkTuning = {
  /** First span per eth_getLogs. */
  span: bigint;
  /** Requests in flight. */
  parallel: number;
  /** Minimum gap between request starts, ms. */
  spacingMs: number;
};

/** How hard a chain's public RPC can be asked. `logRange` is the network's documented cap. */
export function walkTuning(chainId: number, logRange: bigint): WalkTuning {
  // Robinhood Chain (testnet 46630, mainnet 4663) answers wide ranges; a range
  // error splits the request anyway. Tempo (testnet 42431, mainnet 4217) caps it,
  // and so does publicnode, the RPC the app reads Base (84532, 8453) from.
  if (chainId === 46630 || chainId === 4663) return { span: 5_000_000n, parallel: 4, spacingMs: 0 };
  if (chainId === 42431 || chainId === 4217) return { span: logRange, parallel: 3, spacingMs: 120 };
  if (chainId === 84532 || chainId === 8453) return { span: logRange, parallel: 3, spacingMs: 120 };
  // Ethereum reads through MEV Blocker, 10,000 blocks a read (any range under 10,000 logs).
  if (chainId === 1) return { span: logRange, parallel: 3, spacingMs: 120 };
  // Elysium (Arbitrum Orbit, behind its flag): its RPC's own range (lib/elysium), spaced like Base.
  if (isElysiumChainId(chainId)) return { span: logRange, parallel: 3, spacingMs: 120 };
  // Ethereum Sepolia: publicnode at the head, Tenderly's gateway for blocks older than
  // 9,000 (lib/readTransport); both take 50,000 blocks a read.
  if (chainId === 11155111) return { span: logRange, parallel: 3, spacingMs: 120 };
  return { span: logRange, parallel: 2, spacingMs: 0 };
}

const RANGE_ERROR =
  /block range|range (is )?too|exceeds? (the )?max|max(imum)? block|only \d+ are allowed|more than \d+ (results|logs)|too many (results|logs)|response size|query timeout|limit exceeded/i;

function errText(e: unknown): string {
  if (e && typeof e === "object") {
    const o = e as { details?: unknown; shortMessage?: unknown; message?: unknown };
    return String(o.details ?? o.shortMessage ?? o.message ?? e);
  }
  return String(e);
}

function isRateLimit(e: unknown): boolean {
  const status = (e as { status?: number })?.status;
  return status === 429 || /429|too many requests|rate ?limit/i.test(errText(e));
}

/** The span the node says it allows ("only 100000 are allowed", "max block range 100000"), if it says. */
function allowedSpan(e: unknown): bigint | null {
  const m = /only (\d+) are allowed|max(?:imum)? block range (?:is )?(\d+)|range (?:of|is) (\d+)/i.exec(errText(e));
  const v = m?.[1] ?? m?.[2] ?? m?.[3];
  return v ? BigInt(v) : null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function ranges(from: bigint, to: bigint, step: bigint): [bigint, bigint][] {
  const out: [bigint, bigint][] = [];
  for (let s = from; s <= to; s += step) out.push([s, s + step - 1n > to ? to : s + step - 1n]);
  return out;
}

/** Run `fn` over `items`, at most `limit` at once, starts at least `spacingMs` apart. Order kept. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  spacingMs: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  let lastStart = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      if (spacingMs > 0) {
        const wait = lastStart + spacingMs - Date.now();
        lastStart = Math.max(Date.now(), lastStart + spacingMs);
        if (wait > 0) await sleep(wait);
      }
      out[i] = await fn(items[i]!);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

/** Narrow a walk to one event, optionally by its indexed arguments. */
export type LogFilter = { event: AbiEvent; args?: Record<string, unknown> };

async function logsSafe(
  client: PublicClient,
  pool: Address,
  from: bigint,
  to: bigint,
  tuning: WalkTuning,
  depth = 0,
  filter?: LogFilter
): Promise<Log[]> {
  let last: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return filter
        ? ((await client.getLogs({ address: pool, event: filter.event, args: filter.args, fromBlock: from, toBlock: to } as never)) as Log[])
        : await client.getLogs({ address: pool, fromBlock: from, toBlock: to });
    } catch (e) {
      last = e;
      if (!isRateLimit(e) && RANGE_ERROR.test(errText(e)) && to > from && depth < 8) {
        const named = allowedSpan(e);
        const span = named && named > 0n && named <= to - from ? named : (to - from + 2n) / 2n;
        const parts = await mapLimit(ranges(from, to, span), tuning.parallel, tuning.spacingMs, ([a, b]) =>
          logsSafe(client, pool, a, b, tuning, depth + 1, filter)
        );
        return parts.flat();
      }
      await sleep(600 * (attempt + 1));
    }
  }
  throw last;
}

/** Every log `address` emitted in [from, to], in range order, split and retried as the node allows. */
export async function walkLogs(
  client: PublicClient,
  address: Address,
  from: bigint,
  to: bigint,
  tuning: WalkTuning,
  filter?: LogFilter
): Promise<Log[]> {
  if (from > to) return [];
  const parts = await mapLimit(ranges(from, to, tuning.span), tuning.parallel, tuning.spacingMs, ([a, b]) =>
    logsSafe(client, address, a, b, tuning, 0, filter)
  );
  return parts.flat();
}

/** Every insert the pool logged in [from, to], in chain order. */
export async function walkInserts(
  client: PublicClient,
  pool: Address,
  from: bigint,
  to: bigint,
  tuning: WalkTuning
): Promise<RawInsert[]> {
  return sortInserts(decodeInserts(await walkLogs(client, pool, from, to, tuning)));
}

// ------------------------------------------------------------------ wire

const HEX32 = /^0x[0-9a-fA-F]{64}$/;
const ADDR = /^0x[0-9a-fA-F]{40}$/;
const UINT = /^\d{1,78}$/;

function validInsert(r: unknown): r is RawInsert {
  if (!r || typeof r !== "object") return false;
  const o = r as Record<string, unknown>;
  if (o.k !== "s" && o.k !== "t" && o.k !== "w") return false;
  if (!Array.isArray(o.c) || o.c.length !== (o.k === "s" ? 1 : 2)) return false;
  if (!o.c.every((x) => typeof x === "string" && HEX32.test(x) && !/^0x0+$/.test(x))) return false;
  if (typeof o.bn !== "string" || !UINT.test(o.bn)) return false;
  if (typeof o.li !== "number" || !Number.isSafeInteger(o.li) || o.li < 0) return false;
  if (o.i != null && (typeof o.i !== "number" || !Number.isSafeInteger(o.i))) return false;
  if (o.tx != null && (typeof o.tx !== "string" || !HEX32.test(o.tx))) return false;
  if (o.a != null && (typeof o.a !== "string" || !ADDR.test(o.a))) return false;
  if (o.f != null && (typeof o.f !== "string" || !ADDR.test(o.f))) return false;
  if (o.v != null && (typeof o.v !== "string" || !UINT.test(o.v))) return false;
  return true;
}

/**
 * Accept a snapshot only if it is well formed, for this chain and pool, in
 * strict chain order and numbered without gaps. This is a shape check; the
 * caller still has to check the rebuilt root against the pool.
 */
export function parseLeafSnapshot(json: unknown, chainId: number, pool: Address): LeafSnapshot | null {
  if (!json || typeof json !== "object") return null;
  const s = json as Record<string, unknown>;
  if (s.v !== 1 || s.chainId !== chainId) return null;
  if (typeof s.pool !== "string" || s.pool.toLowerCase() !== pool.toLowerCase()) return null;
  if (typeof s.toBlock !== "string" || !UINT.test(s.toBlock)) return null;
  if (typeof s.deployBlock !== "string" || !UINT.test(s.deployBlock)) return null;
  if (!Array.isArray(s.items) || !s.items.every(validInsert)) return null;
  const items = s.items as RawInsert[];
  const toBlock = BigInt(s.toBlock);
  let next = 0;
  let prevBn = -1n;
  let prevLi = -1;
  for (const r of items) {
    const bn = BigInt(r.bn);
    if (bn > toBlock || bn < prevBn || (bn === prevBn && r.li <= prevLi)) return null;
    if (r.i !== next) return null;
    next += r.c.length;
    prevBn = bn;
    prevLi = r.li;
  }
  if (s.leafCount !== next) return null;
  return {
    v: 1,
    chainId,
    pool,
    deployBlock: s.deployBlock,
    toBlock: s.toBlock,
    leafCount: next,
    items,
    at: typeof s.at === "number" ? s.at : 0,
  };
}
