/**
 * Storage for the partner program (accounts, API keys, sessions, accounting).
 * Server only.
 *
 * One tiny command interface, two backends:
 *  - Upstash Redis REST (UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN),
 *    the only backend production uses.
 *  - An in-process store that speaks the same commands, for local development
 *    and the self-tests. It lives on globalThis so a dev reload keeps it.
 *
 * GLOAM_PARTNERS_STORE=memory forces the in-process store (tests, a local
 * production build). Production without Redis and without that override has
 * no store at all: partner writes then fail with `storage_unavailable` rather
 * than keeping accounts in memory that vanish on the next cold start.
 *
 * Nothing private is ever written here: no note secrets, no recipients of
 * private sends, no amounts of private sends. See lib/partners.ts.
 */
import { redisConfigured } from "./tractionStore";
import { addToHll, countHll, decodeHll, encodeHll, isHll, mergeHll } from "./hll";

export const KV_PREFIX = "gloam:partners:v1:";

export type KvBackend = "redis" | "memory" | "none";

export type KvCommand = (string | number)[];

export class KvUnavailableError extends Error {
  constructor(message = "Partner storage is not configured on this server.") {
    super(message);
    this.name = "KvUnavailableError";
  }
}

export function kvBackend(): KvBackend {
  if (process.env.GLOAM_PARTNERS_STORE?.trim() === "memory") return "memory";
  if (redisConfigured()) return "redis";
  if (process.env.NODE_ENV !== "production") return "memory";
  return "none";
}

/** Namespaced key. Every key the partner program writes goes through here. */
export function k(...parts: (string | number)[]): string {
  return KV_PREFIX + parts.join(":");
}

// ---------------------------------------------------------------- redis

/** A slow store fails the request instead of holding the function open. */
const KV_TIMEOUT_MS = 3_000;

async function redisPipeline(cmds: KvCommand[]): Promise<unknown[]> {
  const url = process.env.UPSTASH_REDIS_REST_URL!.trim().replace(/\/$/, "");
  const token = process.env.UPSTASH_REDIS_REST_TOKEN!.trim();
  let res: Response;
  try {
    res = await fetch(`${url}/pipeline`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(cmds),
      cache: "no-store",
      signal: AbortSignal.timeout(KV_TIMEOUT_MS),
    });
  } catch {
    throw new KvUnavailableError("Partner storage did not answer.");
  }
  if (!res.ok) throw new KvUnavailableError(`Partner storage answered ${res.status}.`);
  const json = (await res.json()) as { result?: unknown; error?: string }[];
  if (!Array.isArray(json) || json.length !== cmds.length) throw new KvUnavailableError("Partner storage gave a bad answer.");
  return json.map((r, i) => {
    if (r && r.error) throw new Error(`kv ${String(cmds[i]?.[0])}: ${r.error}`);
    return r?.result ?? null;
  });
}

// ---------------------------------------------------------------- memory

class MemZset {
  scores = new Map<string, number>();
}

type MemValue = string | Map<string, string> | Set<string> | string[] | MemZset;
type MemEntry = { v: MemValue; exp: number | null };

function memStore(): Map<string, MemEntry> {
  const g = globalThis as { __gloamPartnersMem?: Map<string, MemEntry> };
  if (!g.__gloamPartnersMem) g.__gloamPartnersMem = new Map();
  return g.__gloamPartnersMem;
}

/** Wipe the in-process store (self-tests only). */
export function resetMemoryKv() {
  memStore().clear();
}

function live(key: string): MemEntry | null {
  const m = memStore();
  const e = m.get(key);
  if (!e) return null;
  if (e.exp !== null && e.exp <= Date.now()) {
    m.delete(key);
    return null;
  }
  return e;
}

function typed<T extends MemValue>(key: string, make: () => T, is: (v: MemValue) => v is T): T {
  const e = live(key);
  if (!e) {
    const v = make();
    memStore().set(key, { v, exp: null });
    return v;
  }
  if (!is(e.v)) throw new Error("WRONGTYPE");
  return e.v;
}

const isHash = (v: MemValue): v is Map<string, string> => v instanceof Map;
const isSet = (v: MemValue): v is Set<string> => v instanceof Set;
const isList = (v: MemValue): v is string[] => Array.isArray(v);
const isZset = (v: MemValue): v is MemZset => v instanceof MemZset;

/** A sorted set's members by rank: lowest score first, ties by member, as Redis orders them. */
function zsetRanked(z: MemZset): string[] {
  return [...z.scores.entries()].sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1)).map(([m]) => m);
}

/** A Redis rank range: negative positions count from the end, and stop is included. */
function rankSlice<T>(items: T[], start: number, stop: number): T[] {
  const from = start < 0 ? Math.max(items.length + start, 0) : start;
  const to = stop < 0 ? items.length + stop : stop;
  return to < from ? [] : items.slice(from, to + 1);
}

function memCommand(cmd: KvCommand): unknown {
  const [rawName, ...rest] = cmd;
  const name = String(rawName).toUpperCase();
  const a = rest.map(String);
  const m = memStore();
  switch (name) {
    case "GET": {
      const e = live(a[0]!);
      return e && typeof e.v === "string" ? e.v : null;
    }
    case "SET": {
      const [key, value, ...opts] = a;
      let ex: number | null = null;
      let nx = false;
      for (let i = 0; i < opts.length; i++) {
        const o = opts[i]!.toUpperCase();
        if (o === "EX") ex = Number(opts[++i]);
        else if (o === "NX") nx = true;
      }
      if (nx && live(key!)) return null;
      m.set(key!, { v: value!, exp: ex ? Date.now() + ex * 1000 : null });
      return "OK";
    }
    case "GETDEL": {
      const e = live(a[0]!);
      if (!e || typeof e.v !== "string") return null;
      m.delete(a[0]!);
      return e.v;
    }
    case "DEL": {
      let n = 0;
      for (const key of a) if (live(key) && m.delete(key)) n++;
      return n;
    }
    case "EXISTS":
      return a.filter((key) => live(key)).length;
    case "EXPIRE": {
      const e = live(a[0]!);
      if (!e) return 0;
      e.exp = Date.now() + Number(a[1]) * 1000;
      return 1;
    }
    case "INCR":
    case "INCRBY": {
      const e = live(a[0]!);
      const by = name === "INCR" ? 1 : Number(a[1]);
      const next = (e ? Number(e.v) : 0) + by;
      m.set(a[0]!, { v: String(next), exp: e?.exp ?? null });
      return next;
    }
    case "HSET": {
      const h = typed(a[0]!, () => new Map<string, string>(), isHash);
      let added = 0;
      for (let i = 1; i + 1 < a.length; i += 2) {
        if (!h.has(a[i]!)) added++;
        h.set(a[i]!, a[i + 1]!);
      }
      return added;
    }
    case "HSETNX": {
      const h = typed(a[0]!, () => new Map<string, string>(), isHash);
      if (h.has(a[1]!)) return 0;
      h.set(a[1]!, a[2]!);
      return 1;
    }
    case "HGET": {
      const e = live(a[0]!);
      return e && isHash(e.v) ? (e.v.get(a[1]!) ?? null) : null;
    }
    case "HINCRBY": {
      const h = typed(a[0]!, () => new Map<string, string>(), isHash);
      const next = Number(h.get(a[1]!) ?? 0) + Number(a[2]);
      h.set(a[1]!, String(next));
      return next;
    }
    case "HGETALL": {
      const e = live(a[0]!);
      if (!e || !isHash(e.v)) return [];
      return [...e.v.entries()].flat();
    }
    case "SADD": {
      const s = typed(a[0]!, () => new Set<string>(), isSet);
      let n = 0;
      for (const v of a.slice(1)) if (!s.has(v) && s.add(v)) n++;
      return n;
    }
    case "SREM": {
      const e = live(a[0]!);
      if (!e || !isSet(e.v)) return 0;
      let n = 0;
      for (const v of a.slice(1)) if (e.v.delete(v)) n++;
      return n;
    }
    case "SMEMBERS": {
      const e = live(a[0]!);
      return e && isSet(e.v) ? [...e.v] : [];
    }
    case "SCARD": {
      const e = live(a[0]!);
      return e && isSet(e.v) ? e.v.size : 0;
    }
    case "SISMEMBER": {
      const e = live(a[0]!);
      return e && isSet(e.v) && e.v.has(a[1]!) ? 1 : 0;
    }
    case "PFADD": {
      // a HyperLogLog kept as a string of registers (lib/hll); the items are never kept
      const e = live(a[0]!);
      if (e && (typeof e.v !== "string" || !isHll(e.v))) throw new Error("WRONGTYPE");
      const regs = decodeHll(e ? (e.v as string) : null);
      const changed = addToHll(regs, a.slice(1));
      if (!e || changed) m.set(a[0]!, { v: encodeHll(regs), exp: e?.exp ?? null });
      return changed || !e ? 1 : 0;
    }
    case "PFCOUNT": {
      const sketches = a.map((key) => {
        const e = live(key);
        if (e && (typeof e.v !== "string" || !isHll(e.v))) throw new Error("WRONGTYPE");
        return decodeHll(e ? (e.v as string) : null);
      });
      return countHll(mergeHll(sketches));
    }
    case "LPUSH": {
      const l = typed(a[0]!, () => [] as string[], isList);
      for (const v of a.slice(1)) l.unshift(v);
      return l.length;
    }
    case "LTRIM": {
      const e = live(a[0]!);
      if (!e || !isList(e.v)) return "OK";
      const start = Number(a[1]);
      const stop = Number(a[2]);
      e.v = e.v.slice(start, stop < 0 ? e.v.length + stop + 1 : stop + 1);
      return "OK";
    }
    case "LREM": {
      // LREM key count value: count 0 takes every copy out, as Redis does
      const e = live(a[0]!);
      if (!e || !isList(e.v)) return 0;
      const want = Number(a[1]);
      let n = 0;
      const kept: string[] = [];
      for (const v of e.v) {
        if (v === a[2] && (want === 0 || n < Math.abs(want))) n++;
        else kept.push(v);
      }
      e.v = kept;
      return n;
    }
    case "LRANGE": {
      const e = live(a[0]!);
      if (!e || !isList(e.v)) return [];
      const start = Number(a[1]);
      const stop = Number(a[2]);
      return e.v.slice(start, stop < 0 ? e.v.length + stop + 1 : stop + 1);
    }
    case "ZADD": {
      const z = typed(a[0]!, () => new MemZset(), isZset);
      let added = 0;
      for (let i = 1; i + 1 < a.length; i += 2) {
        if (!z.scores.has(a[i + 1]!)) added++;
        z.scores.set(a[i + 1]!, Number(a[i]));
      }
      return added;
    }
    case "ZRANGE": {
      const e = live(a[0]!);
      return e && isZset(e.v) ? rankSlice(zsetRanked(e.v), Number(a[1]), Number(a[2])) : [];
    }
    case "ZREM": {
      const e = live(a[0]!);
      if (!e || !isZset(e.v)) return 0;
      let n = 0;
      for (const v of a.slice(1)) if (e.v.scores.delete(v)) n++;
      return n;
    }
    case "ZREMRANGEBYRANK": {
      const e = live(a[0]!);
      if (!e || !isZset(e.v)) return 0;
      const doomed = rankSlice(zsetRanked(e.v), Number(a[1]), Number(a[2]));
      for (const v of doomed) e.v.scores.delete(v);
      return doomed.length;
    }
    default:
      throw new Error(`memory kv: unsupported command ${name}`);
  }
}

// ---------------------------------------------------------------- public

/**
 * Run commands in order, in one round trip on Redis. Results come back in
 * order, in Redis REST shapes (HGETALL is a flat [field, value, ...] array).
 * Any failed command throws: partner data is small and must be consistent.
 */
export async function kv(cmds: KvCommand[]): Promise<unknown[]> {
  if (cmds.length === 0) return [];
  const backend = kvBackend();
  if (backend === "none") throw new KvUnavailableError();
  if (backend === "redis") return redisPipeline(cmds);
  return cmds.map(memCommand);
}

/** One command. */
export async function kv1(cmd: KvCommand): Promise<unknown> {
  const [r] = await kv([cmd]);
  return r;
}

/** HGETALL result as a record of numbers (non-numbers read as 0). */
export function hashNumbers(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!Array.isArray(raw)) return out;
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const v = Number(raw[i + 1]);
    out[String(raw[i])] = Number.isFinite(v) ? v : 0;
  }
  return out;
}

/** JSON value from a GET result, or null. */
export function jsonOf<T>(raw: unknown): T | null {
  if (typeof raw !== "string") return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}
