/**
 * One relay request per spend at a time.
 *
 * A private send or cash out is keyed by its nullifier. While one request for
 * it is being checked and sent, a second copy of the same proof is refused, so
 * copies sent at the same moment cannot each pass the dry run and then revert
 * on chain at the relay's expense (audit R-1).
 *
 * The lock is shared across serverless instances through Upstash Redis
 * (SET NX EX, same env and REST call as lib/mcpRemote/rateLimit). It never
 * falls back to process memory when Redis is set but does not answer, nor in a
 * production build with no Redis: then it throws LockStoreDown and the relay
 * sends nothing (each instance's memory would let copies of one proof through
 * side by side). Memory is only for a build with no Redis that is not
 * production: local dev and the self-tests.
 *
 * Whoever holds it releases it when the request fails before anything was
 * sent, so the user can retry right away. Once a transaction is out, the lock
 * stays until it expires: by then the spend has landed and the relay's spent
 * check refuses any copy. The one exception is a receipt showing that very
 * transaction reverted (releaseIfReverted): the note is unspent, nothing of
 * this request is still out, and the holder drops the lock so the note can
 * move. A copy sent after that takes the lock and faces the dry run like any
 * new request, so there is still at most one send of a spend out at a time. A
 * timeout, a dropped request or a send whose outcome is unknown never drops it.
 *
 * A lock still expires, and on Ethereum a send can sit unmined past it (it offers at
 * most 1.5 times the gas ceiling). So each spend's last send (its relay account, nonce
 * and hash) is kept for a day (recordSent), and the relay checks it before sending that
 * spend again: not while it may still land (lib/relay/server assertEarlierSendSettled).
 */
import { randomUUID } from "crypto";
import { redisConfigured } from "@/lib/tractionStore";

/**
 * How long a lock lives, in seconds. Once sent, a transaction lands within a
 * second or two on both relay chains (Robinhood Chain testnet is an Arbitrum
 * Orbit chain with blocks about every 0.25 s, Tempo about every 0.5 to 1 s).
 * The rest covers one request's slowest path before the send: the spent check,
 * the dry run and the send, each behind a 20 to 30 s RPC timeout.
 */
export const INFLIGHT_TTL_SEC = 180;

/**
 * Per chain, where a send can sit unmined longer: on Ethereum a send offers at most 1.5
 * times the gas ceiling (lib/relay/gasCeiling), so a rising base fee can leave it waiting
 * for many blocks. The lock is only the first guard: a spend's last send is kept on record
 * (recordSent) and checked before any new one (lib/relay/server), however old the lock.
 */
export const DEFAULT_INFLIGHT_TTL_SEC: Readonly<Record<number, number>> = { 1: 900 };
const INFLIGHT_TTL_MIN = 60;
const INFLIGHT_TTL_MAX = 86_400;

/**
 * How long a spend's lock lives on `chainId`, in seconds. GLOAM_RELAY_INFLIGHT_TTL_<chainId>
 * sets it (60 to 86,400); anything else keeps the default.
 */
export function inflightTtlSec(chainId: number, env: Record<string, string | undefined> = process.env): number {
  const raw = env[`GLOAM_RELAY_INFLIGHT_TTL_${chainId}`]?.trim();
  if (raw) {
    const n = Number(raw);
    if (Number.isSafeInteger(n) && n >= INFLIGHT_TTL_MIN && n <= INFLIGHT_TTL_MAX) return n;
  }
  return DEFAULT_INFLIGHT_TTL_SEC[chainId] ?? INFLIGHT_TTL_SEC;
}

const PREFIX = "gloam:relay:inflight:";
const MEM_MAX_KEYS = 10_000;
const REDIS_TIMEOUT_MS = 2_000;

export type InflightLock = {
  key: string;
  /** Where the lock lives: shared Redis, or this instance's memory. */
  store: "redis" | "memory";
  /** Drops the lock if it is still ours. Never throws. */
  release: () => Promise<void>;
};

/** Lock key for one spend: chain id and nullifier (public on chain once spent). */
export function inflightKey(chainId: number, nullifier: string): string {
  return `${PREFIX}${chainId}:${nullifier.toLowerCase()}`;
}

// ---------------------------------------------------------------- memory

type Held = { token: string; exp: number };

function memLocks(): Map<string, Held> {
  const g = globalThis as { __gloamRelayInflight?: Map<string, Held> };
  if (!g.__gloamRelayInflight) g.__gloamRelayInflight = new Map();
  return g.__gloamRelayInflight;
}

function memTake(key: string, token: string, ttlSec: number, now: number): boolean {
  const m = memLocks();
  if (m.size > MEM_MAX_KEYS) {
    for (const [k, v] of m) if (v.exp <= now) m.delete(k);
    if (m.size > MEM_MAX_KEYS) m.clear();
  }
  const cur = m.get(key);
  if (cur && cur.exp > now) return false;
  m.set(key, { token, exp: now + ttlSec * 1000 });
  return true;
}

function memRelease(key: string, token: string): void {
  const m = memLocks();
  if (m.get(key)?.token === token) m.delete(key);
}

// ---------------------------------------------------------------- redis

async function redis(args: (string | number)[]): Promise<unknown> {
  if (!redisConfigured()) throw new Error("redis: not configured");
  const url = process.env.UPSTASH_REDIS_REST_URL!.trim().replace(/\/$/, "");
  const token = process.env.UPSTASH_REDIS_REST_TOKEN!.trim();
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(args),
    cache: "no-store",
    signal: AbortSignal.timeout(REDIS_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`redis ${res.status}`);
  const json = (await res.json()) as { result?: unknown; error?: string };
  if (json.error) throw new Error("redis: command failed");
  return json.result ?? null;
}

// Delete only when the value is still our token, so a slow request whose lock
// already expired cannot drop the lock a newer request now holds.
const RELEASE_SCRIPT = 'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end';

// ---------------------------------------------------------------- store health

/** Redis is set but did not answer, or a production build has none: no lock was taken. */
export class LockStoreDown extends Error {
  constructor(readonly reason: string) {
    super(`relay lock store unavailable: ${reason}`);
    this.name = "LockStoreDown";
  }
}

/** Where relay locks live: Redis when set; memory only with none outside production; else nowhere. */
export function lockStore(): "redis" | "memory" | "none" {
  if (redisConfigured()) return "redis";
  return process.env.NODE_ENV === "production" ? "none" : "memory";
}

let downSince: number | null = null;

/** The relay's shared store is down: logged once per outage (per instance), without any key or URL. */
export function relayStoreDown(reason: string): void {
  if (downSince !== null) return;
  downSince = Date.now();
  console.error("gloam_relay_store_down", JSON.stringify({ reason: reason.slice(0, 120) }));
}

/** The relay's shared store answered again after an outage. */
export function relayStoreUp(): void {
  if (downSince === null) return;
  console.info("gloam_relay_store_back", JSON.stringify({ downSec: Math.round((Date.now() - downSince) / 1000) }));
  downSince = null;
}

// ---------------------------------------------------------------- lock

/**
 * Takes the lock for `key` for `ttlSec` seconds, or returns null while another
 * request holds it. Throws LockStoreDown when it can't be kept in Redis (set
 * but not answering, or a production build without it): never in memory then.
 */
export async function takeInflight(
  key: string,
  ttlSec = INFLIGHT_TTL_SEC,
  now = Date.now(),
): Promise<InflightLock | null> {
  const ttl = Number.isSafeInteger(ttlSec) && ttlSec > 0 ? ttlSec : INFLIGHT_TTL_SEC;
  const token = randomUUID();
  const store = lockStore();
  if (store === "none") {
    relayStoreDown("no redis in a production build");
    throw new LockStoreDown("no redis");
  }
  if (store === "redis") {
    let got: boolean;
    try {
      got = (await redis(["SET", key, token, "NX", "EX", ttl])) === "OK";
    } catch (e) {
      const reason = e instanceof Error ? e.message : "redis failed";
      relayStoreDown(reason);
      throw new LockStoreDown(reason);
    }
    relayStoreUp();
    if (!got) return null;
    return {
      key,
      store: "redis",
      release: async () => {
        try {
          await redis(["EVAL", RELEASE_SCRIPT, 1, key, token]);
        } catch {
          /* it expires on its own */
        }
      },
    };
  }
  if (!memTake(key, token, ttl, now)) return null;
  return {
    key,
    store: "memory",
    release: async () => memRelease(key, token),
  };
}

// ---------------------------------------------------------------- kept records

/**
 * A small value kept in the relay's store with an expiry: Redis when set, memory only
 * with none outside production (as the lock). Throws LockStoreDown otherwise, so a
 * caller never reads "no record" when the store simply did not answer.
 */
const memRecords = new Map<string, { value: string; exp: number }>();

async function keepRecord(key: string, value: string, ttlSec: number): Promise<void> {
  const store = lockStore();
  if (store === "none") {
    relayStoreDown("no redis in a production build");
    throw new LockStoreDown("no redis");
  }
  if (store === "memory") {
    if (memRecords.size > MEM_MAX_KEYS) {
      const now = Date.now();
      for (const [k, v] of memRecords) if (v.exp <= now) memRecords.delete(k);
    }
    memRecords.set(key, { value, exp: Date.now() + ttlSec * 1000 });
    return;
  }
  try {
    await redis(["SET", key, value, "EX", ttlSec]);
  } catch (e) {
    const reason = e instanceof Error ? e.message : "redis failed";
    relayStoreDown(reason);
    throw new LockStoreDown(reason);
  }
}

async function readRecord(key: string): Promise<string | null> {
  const store = lockStore();
  if (store === "none") {
    relayStoreDown("no redis in a production build");
    throw new LockStoreDown("no redis");
  }
  if (store === "memory") {
    const hit = memRecords.get(key);
    return hit && hit.exp > Date.now() ? hit.value : null;
  }
  try {
    const raw = await redis(["GET", key]);
    return typeof raw === "string" ? raw : null;
  } catch (e) {
    const reason = e instanceof Error ? e.message : "redis failed";
    relayStoreDown(reason);
    throw new LockStoreDown(reason);
  }
}

/**
 * A swap's escrow, kept once the relay is asked to send the swap (lib/relay/server). The
 * swap's unshield proof names the escrow as `to`, and anyone who saw the swap (a reverted
 * one stays on chain, proofs and all) can hand that proof to the relay as a plain cash out:
 * the money then waits at the escrow and the relay pays for a refund too. The vault keeps
 * every root, so that proof stays good as long as the note is unspent, hence a long life.
 */
const ESCROW_PREFIX = "gloam:relay:escrow:";
export const SWAP_ESCROW_TTL_SEC = 400 * 86_400;

export async function markSwapEscrow(chainId: number, escrow: string, ttlSec = SWAP_ESCROW_TTL_SEC): Promise<void> {
  await keepRecord(`${ESCROW_PREFIX}${chainId}:${escrow.toLowerCase()}`, "1", ttlSec);
}

/** Whether `address` is a swap escrow the relay was asked to send. Throws LockStoreDown when the store can't say. */
export async function isSwapEscrow(chainId: number, address: string): Promise<boolean> {
  return (await readRecord(`${ESCROW_PREFIX}${chainId}:${address.toLowerCase()}`)) !== null;
}

/**
 * A spend's last send: the relay account, its nonce and (when the node answered) the hash.
 * Kept under the spend's lock key long after the lock itself, so a copy that comes once
 * the lock expired is checked against it: never sent again while that one may still land.
 */
export type SentRecord = { from: string; nonce: number; hash?: string };
const SENT_PREFIX = "gloam:relay:sent:";
export const SENT_TTL_SEC = 24 * 3600;

export async function recordSent(lockKey: string, sent: SentRecord, ttlSec = SENT_TTL_SEC): Promise<void> {
  await keepRecord(SENT_PREFIX + lockKey, JSON.stringify(sent), ttlSec);
}

export async function readSent(lockKey: string): Promise<SentRecord | null> {
  const raw = await readRecord(SENT_PREFIX + lockKey);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<SentRecord>;
    if (typeof v.from !== "string" || !Number.isSafeInteger(v.nonce)) return null;
    return { from: v.from, nonce: v.nonce!, ...(typeof v.hash === "string" ? { hash: v.hash } : {}) };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- after the send

const RECEIPT_POLL_MS = 1_000;
/**
 * How long the relay looks for a sent transaction's receipt. It runs after the
 * reply, inside the route's 60 s limit: one still landing after this, or a
 * function stopped first, leaves the lock to expire.
 */
export const RECEIPT_WATCH_MS = 30_000;

/**
 * Follows a sent transaction to its receipt and has the lock's holder drop the
 * lock if it reverted. `outcome` reads that receipt: null, or a throw, while
 * there is none to read. Only a reverted receipt drops the lock. Never throws.
 */
export async function releaseIfReverted(
  lock: InflightLock,
  outcome: () => Promise<"success" | "reverted" | null>,
  watchMs = RECEIPT_WATCH_MS,
  pollMs = RECEIPT_POLL_MS,
): Promise<void> {
  const deadline = Date.now() + watchMs;
  for (;;) {
    const ended = await outcome().catch(() => null);
    if (ended === "reverted") await lock.release();
    if (ended === "reverted" || ended === "success" || Date.now() + pollMs > deadline) return;
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

// ---------------------------------------------------------------- send lane

const LANE_PREFIX = "gloam:relay:lane:";
const NONCE_PREFIX = "gloam:relay:nonce:";
/** A send holds its lane for at most this long: signing plus one RPC call, behind a 30 s timeout. */
const LANE_TTL_SEC = 35;
/** An idle lane forgets its nonce after this long and starts again from the chain. */
const NONCE_TTL_SEC = 300;
/** How long a request waits for its turn before the relay says it is busy. */
export const LANE_WAIT_MS = 25_000;

const memNonces = new Map<string, { next: number; exp: number }>();

async function storedNonce(lane: string): Promise<number | null> {
  try {
    const raw = await redis(["GET", NONCE_PREFIX + lane]);
    const n = Number(raw);
    return raw !== null && Number.isSafeInteger(n) ? n : null;
  } catch {
    const m = memNonces.get(lane);
    return m && m.exp > Date.now() ? m.next : null;
  }
}

async function saveNonce(lane: string, next: number): Promise<void> {
  memNonces.set(lane, { next, exp: Date.now() + NONCE_TTL_SEC * 1000 });
  try {
    await redis(["SET", NONCE_PREFIX + lane, next, "EX", NONCE_TTL_SEC]);
  } catch {
    /* memory keeps it for this instance */
  }
}

/** Drops the kept nonce, so the next send reads it from the chain again. Never throws. */
export async function forgetNonce(lane: string): Promise<void> {
  memNonces.delete(lane);
  try {
    await redis(["DEL", NONCE_PREFIX + lane]);
  } catch {
    /* it expires on its own */
  }
}

/**
 * Sends from one relay account go out one at a time, each with the next nonce.
 * Without this, sends arriving together on different instances all read the
 * same pending nonce and knock each other out. The lane is a short shared lock;
 * the nonce is kept beside it and is never behind the chain's pending count, so
 * a node that is a moment behind cannot hand out a used one. A send takes a few
 * hundred milliseconds, so a queue clears quickly. Returns null when the lane
 * stayed busy for `waitMs`.
 */
export async function inSendLane<T>(
  lane: string,
  chainNonce: () => Promise<number>,
  send: (nonce: number) => Promise<T>,
  waitMs = LANE_WAIT_MS,
): Promise<{ value: T } | null> {
  const out = await inSendLanes([{ id: lane, chainNonce }], (_, nonce) => send(nonce), waitMs);
  return out && { value: out.value };
}

/**
 * The same over several relay accounts (one lane each): the send takes the
 * first free lane, starting at a random one, so N accounts send N at a time.
 * Returns null when every lane stayed busy for `waitMs`. Throws LockStoreDown,
 * before anything is sent, when a lane's lock can't be kept in Redis.
 */
export async function inSendLanes<T>(
  lanes: { id: string; chainNonce: () => Promise<number> }[],
  send: (lane: number, nonce: number) => Promise<T>,
  waitMs = LANE_WAIT_MS,
): Promise<{ value: T; lane: number } | null> {
  if (!lanes.length) return null;
  const deadline = Date.now() + waitMs;
  const start = Math.floor(Math.random() * lanes.length);
  for (;;) {
    for (let k = 0; k < lanes.length; k++) {
      const i = (start + k) % lanes.length;
      const lane = lanes[i]!;
      const lock = await takeInflight(LANE_PREFIX + lane.id, LANE_TTL_SEC);
      if (!lock) continue;
      try {
        const [kept, onChain] = await Promise.all([storedNonce(lane.id), lane.chainNonce()]);
        const nonce = Math.max(onChain, kept ?? 0);
        const value = await send(i, nonce);
        await saveNonce(lane.id, nonce + 1);
        return { value, lane: i };
      } finally {
        await lock.release();
      }
    }
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, 80 + Math.random() * 170));
  }
}
