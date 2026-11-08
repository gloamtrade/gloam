/**
 * Per-IP rate limits, shared by the hosted MCP server and the API routes.
 * Fixed windows: one minute unless the caller asks for longer (an hour, a day).
 *
 * Counts that guard money, accounts or paid APIs live in Upstash Redis
 * (UPSTASH_REDIS_REST_URL + _TOKEN, the same REST pipeline as lib/tractionStore)
 * so every serverless instance shares them, and fall back to process memory
 * when Redis is not set or does not answer. Counts for cheap reads (LOCAL_BUCKETS)
 * stay in memory: every request there used to cost Redis commands, and the
 * Vercel firewall already limits each IP across instances.
 *
 * What a count is about (an IP, a wallet, a spend marker) is never in the
 * clear: a key names it by an HMAC under the server secret GLOAM_RATE_LIMIT_KEY
 * (32 random bytes or more, hex or base64) and the bucket, so the name can't
 * be worked back from a guess without that secret, and one subject's names in
 * two buckets don't match. Each key expires a random while after its
 * window ends, so keys written by one request don't expire together.
 * Without the secret (or with one too short) names fall back to a plain hash,
 * logged once, and every limit still holds: set it to give keys their
 * protection. Setting or rotating it starts every window afresh, once.
 */
import { createHash, createHmac, randomInt } from "crypto";
import { redisConfigured } from "@/lib/tractionStore";

/** The server secret that names the keys of shared counts (see above). Never logged. */
export const RATE_KEY_ENV = "GLOAM_RATE_LIMIT_KEY";

const WINDOW_SEC = 60;

/**
 * Buckets counted per instance, never in Redis: public reads, page analytics,
 * MCP requests and the helper bot's per-minute limits. What stays shared: the
 * relay, sign-in recovery, the testers form, the updates list, admin and
 * partner sign-in, partner writes, proof checks (they read the chain), address
 * screening (a paid API) and the bot's daily model caps.
 */
const LOCAL_BUCKETS = new Set([
  "req",
  "collect",
  "funnel",
  "markets",
  "activity",
  "vault-leaves",
  "xray-card",
  "api-ip",
  "screen-policy",
  "tg-user",
  "tg-global",
  "tg-bug",
  "tg-warn",
  "tg-classify",
  "hunt-visit",
]);
const PREFIX = "gloam:mcp:rl:";
const MEM_MAX_KEYS = 10_000;

export type RateResult = { allowed: boolean; limit: number; remaining: number; retryAfterSec: number };

/**
 * A count asked to fail closed (`failClosed`) could not be kept in Redis: it
 * is set but did not answer, or a production build has none. Nothing was counted.
 */
export class SharedCountUnavailable extends Error {
  constructor(readonly reason: string) {
    super(`shared count unavailable: ${reason}`);
    this.name = "SharedCountUnavailable";
  }
}

/**
 * The client's IP as the platform reports it. On Vercel (VERCEL=1) the edge sets
 * x-vercel-forwarded-for and x-real-ip itself and overwrites x-forwarded-for, so
 * those are read first, in that order. Elsewhere (a local run, a self-host behind a
 * proxy) it is the leftmost x-forwarded-for, then x-real-ip, as before.
 */
export function clientIp(req: Request): string {
  const first = (name: string) => req.headers.get(name)?.split(",")[0]?.trim() || "";
  if (process.env.VERCEL === "1") {
    const ip = first("x-vercel-forwarded-for") || first("x-real-ip") || first("x-forwarded-for");
    if (ip) return ip;
  }
  return first("x-forwarded-for") || req.headers.get("x-real-ip")?.trim() || "local";
}

/**
 * How much of an IPv6 address a limit counts. /64 is one household or server.
 * /48 is one site or rented block, which holds 65,536 of those /64s.
 */
export type V6Bits = 48 | 64;

/**
 * The unit a limit counts. An IPv4 address counts on its own. An IPv6 address
 * counts by its network, /64 unless the limit asks for /48, because one
 * household or server can rotate through billions of addresses inside its /64
 * and dodge a per-address limit.
 */
export function ipBucket(ip: string, v6Bits: V6Bits = 64): string {
  const raw = ip.trim().toLowerCase().split("%")[0] ?? "";
  if (!raw.includes(":")) return raw;
  const mapped = raw.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped?.[1]) return mapped[1];
  let groups: string[];
  if (raw.includes("::")) {
    const [head = "", tail = ""] = raw.split("::");
    const h = head ? head.split(":") : [];
    const t = tail ? tail.split(":") : [];
    groups = [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t];
  } else {
    groups = raw.split(":");
  }
  return `${groups.slice(0, v6Bits / 16).map((g) => g.replace(/^0+(?=.)/, "")).join(":")}::/${v6Bits}`;
}

let keyWarned = false;
function warnKey(why: "missing" | "short") {
  if (keyWarned) return;
  keyWarned = true;
  console.warn("gloam_rate_limit_key_unset", JSON.stringify({ env: RATE_KEY_ENV, why, want: "32 random bytes or more, hex or base64" }));
}

/** The secret behind key names, or null when it is not set (or too short to use). */
function rateKeySecret(): Buffer | null {
  const raw = process.env[RATE_KEY_ENV]?.trim();
  if (!raw) {
    warnKey("missing");
    return null;
  }
  const bytes = /^[0-9a-fA-F]+$/.test(raw) && raw.length % 2 === 0 ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (bytes.length < 32) {
    warnKey("short");
    return null;
  }
  return bytes;
}

/** Whether key names are keyed (GLOAM_RATE_LIMIT_KEY is set and long enough). */
export function rateKeysKeyed(): boolean {
  return rateKeySecret() !== null;
}

/**
 * What a key says about who is counted: an HMAC under the server secret, over
 * the bucket too, so one subject has a different name in every bucket. Without
 * the secret, a plain hash.
 */
function ipKey(bucket: string, ip: string, v6Bits?: V6Bits): string {
  const subject = ipBucket(ip, v6Bits);
  const secret = rateKeySecret();
  if (secret) return createHmac("sha256", secret).update(`gloam-rl|${bucket}|${subject}`).digest("hex").slice(0, 32);
  return createHash("sha256").update(`gloam-mcp|${subject}`).digest("hex").slice(0, 32);
}

/**
 * A key's lifetime: two windows, so it outlives the window it counts, plus a
 * random part of up to one more, so keys written together expire apart.
 */
export function keyTtl(windowSec: number): number {
  return windowSec * 2 + randomInt(0, windowSec + 1);
}

function memCounts(): Map<string, { n: number; exp: number }> {
  const g = globalThis as { __gloamMcpRate?: Map<string, { n: number; exp: number }> };
  if (!g.__gloamMcpRate) g.__gloamMcpRate = new Map();
  return g.__gloamMcpRate;
}

function memIncr(key: string, now: number, windowSec: number): number {
  const m = memCounts();
  if (m.size > MEM_MAX_KEYS) {
    for (const [k, v] of m) if (v.exp <= now) m.delete(k);
    if (m.size > MEM_MAX_KEYS) m.clear();
  }
  const cur = m.get(key);
  if (!cur || cur.exp <= now) {
    m.set(key, { n: 1, exp: now + windowSec * 1000 });
    return 1;
  }
  cur.n++;
  return cur.n;
}

let lastMissLog = 0;
/** A failed shared count falls back to this instance's memory; say so at most once a minute. */
function logRedisMiss(e: unknown) {
  const now = Date.now();
  if (now - lastMissLog < 60_000) return;
  lastMissLog = now;
  console.warn("gloam_ratelimit_redis_miss", e instanceof Error ? e.message : "unknown");
}

/** Upstash's REST pipeline: results in order, with the reason when a command fails. */
async function redisCall(cmds: (string | number)[][]): Promise<{ result?: unknown; error?: string }[]> {
  const url = process.env.UPSTASH_REDIS_REST_URL!.trim().replace(/\/$/, "");
  const token = process.env.UPSTASH_REDIS_REST_TOKEN!.trim();
  const res = await fetch(`${url}/pipeline`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(cmds),
    cache: "no-store",
    signal: AbortSignal.timeout(2_000),
  });
  if (!res.ok) throw new Error(`redis ${res.status}`);
  return (await res.json()) as { result?: unknown; error?: string }[];
}

/** One round trip per hit: the count, and the expiry when the key has none yet. */
async function redisIncr(key: string, windowSec: number): Promise<number> {
  const ttl = keyTtl(windowSec);
  const json = await redisCall([
    ["INCR", key],
    ["EXPIRE", key, ttl, "NX"],
  ]);
  const n = Number(json?.[0]?.result);
  if (!Number.isFinite(n) || n < 1) {
    // Upstash puts the reason (a spent quota, say) in the command's error
    const why = typeof json?.[0]?.error === "string" ? `: ${json[0].error.slice(0, 160)}` : "";
    throw new Error(`redis: bad INCR result${why}`);
  }
  // a Redis without EXPIRE NX (before 7.0) refuses it: set the expiry the old way on the first hit.
  // If that fails too the key only lingers in storage; the next window counts under a new key.
  if (n === 1 && json?.[1]?.error) await redisCall([["EXPIRE", key, ttl]]).catch(() => {});
  return n;
}

/**
 * Counts one hit for `bucket` from this IP and says whether it is allowed.
 * `windowSec` is the window length (default one minute; 3600 for an hour,
 * 86400 for a UTC day). When Redis fails, the in-memory count decides, and
 * this never throws; with `failClosed` (the relay's sends) it throws
 * SharedCountUnavailable instead, and also in a production build with no Redis.
 * `v6Bits` widens what one IPv6 client counts as, for this limit only.
 */
export async function hitRateLimit(
  ip: string,
  bucket: string,
  limit: number,
  now = Date.now(),
  windowSec = WINDOW_SEC,
  opts: { failClosed?: boolean; v6Bits?: V6Bits } = {},
): Promise<RateResult> {
  const span = Number.isSafeInteger(windowSec) && windowSec > 0 ? windowSec : WINDOW_SEC;
  const window = Math.floor(now / 1000 / span);
  // one-minute keys keep their old shape; longer windows name their length
  const slot = span === WINDOW_SEC ? `${window}` : `${span}s:${window}`;
  const key = `${PREFIX}${bucket}:${ipKey(bucket, ip, opts.v6Bits)}:${slot}`;
  let n: number;
  if (redisConfigured() && !LOCAL_BUCKETS.has(bucket)) {
    try {
      n = await redisIncr(key, span);
    } catch (e) {
      if (opts.failClosed) throw new SharedCountUnavailable(e instanceof Error ? e.message : "redis failed");
      logRedisMiss(e);
      n = memIncr(key, now, span);
    }
  } else if (opts.failClosed && process.env.NODE_ENV === "production") {
    throw new SharedCountUnavailable("no redis");
  } else {
    n = memIncr(key, now, span);
  }
  const retryAfterSec = Math.max(1, (window + 1) * span - Math.floor(now / 1000));
  return { allowed: n <= limit, limit, remaining: Math.max(0, limit - n), retryAfterSec };
}

/**
 * Adds `delta` to the count for `bucket` in the window `now` falls in, and returns the
 * total. For an amount rather than a hit, such as gas held for a send and given back
 * after its receipt, so `delta` may be negative. Follows hitRateLimit's store.
 */
export async function addRateCount(
  ip: string,
  bucket: string,
  delta: number,
  now = Date.now(),
  windowSec = WINDOW_SEC,
  opts: { failClosed?: boolean } = {},
): Promise<number> {
  const span = Number.isSafeInteger(windowSec) && windowSec > 0 ? windowSec : WINDOW_SEC;
  const window = Math.floor(now / 1000 / span);
  const slot = span === WINDOW_SEC ? `${window}` : `${span}s:${window}`;
  const key = `${PREFIX}${bucket}:${ipKey(bucket, ip)}:${slot}`;
  const inMemory = () => {
    const m = memCounts();
    const cur = m.get(key);
    const n = (cur && cur.exp > now ? cur.n : 0) + delta;
    m.set(key, { n, exp: cur && cur.exp > now ? cur.exp : now + span * 1000 });
    return n;
  };
  if (redisConfigured() && !LOCAL_BUCKETS.has(bucket)) {
    try {
      const json = await redisCall([
        ["INCRBY", key, delta],
        ["EXPIRE", key, keyTtl(span)],
      ]);
      const n = Number(json?.[0]?.result);
      if (!Number.isFinite(n)) throw new Error("redis: bad INCRBY result");
      return n;
    } catch (e) {
      if (opts.failClosed) throw new SharedCountUnavailable(e instanceof Error ? e.message : "redis failed");
      logRedisMiss(e);
      return inMemory();
    }
  }
  if (opts.failClosed && process.env.NODE_ENV === "production") throw new SharedCountUnavailable("no redis");
  return inMemory();
}

/**
 * What hitRateLimit has counted for `bucket` in this window, counting nothing itself.
 * Follows hitRateLimit's store: Redis when set, with `failClosed` throwing when it
 * doesn't answer or a production build has none; process memory otherwise.
 */
export async function readRateLimit(
  ip: string,
  bucket: string,
  now = Date.now(),
  windowSec = WINDOW_SEC,
  opts: { failClosed?: boolean; v6Bits?: V6Bits } = {},
): Promise<number> {
  const span = Number.isSafeInteger(windowSec) && windowSec > 0 ? windowSec : WINDOW_SEC;
  const window = Math.floor(now / 1000 / span);
  const slot = span === WINDOW_SEC ? `${window}` : `${span}s:${window}`;
  const key = `${PREFIX}${bucket}:${ipKey(bucket, ip, opts.v6Bits)}:${slot}`;
  const inMemory = () => {
    const hit = memCounts().get(key);
    return hit && hit.exp > now ? hit.n : 0;
  };
  if (redisConfigured() && !LOCAL_BUCKETS.has(bucket)) {
    try {
      const json = await redisCall([["GET", key]]);
      if (json?.[0]?.error) throw new Error(`redis: ${String(json[0].error).slice(0, 160)}`);
      return Number(json?.[0]?.result ?? 0) || 0;
    } catch (e) {
      if (opts.failClosed) throw new SharedCountUnavailable(e instanceof Error ? e.message : "redis failed");
      logRedisMiss(e);
      return inMemory();
    }
  }
  if (opts.failClosed && process.env.NODE_ENV === "production") throw new SharedCountUnavailable("no redis");
  return inMemory();
}
