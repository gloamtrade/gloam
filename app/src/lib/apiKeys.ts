/**
 * Gloam API keys. Server only.
 *
 *   gloam_test_<43 chars>   testnet (Robinhood Chain testnet, Tempo Moderato)
 *   gloam_live_<43 chars>   mainnet, once a mainnet network exists
 *
 * The 43 characters are 32 random bytes in base64url. The secret is shown to
 * the partner once and never stored: only HMAC-SHA256(pepper, secret) is kept,
 * where the pepper is GLOAM_API_KEY_PEPPER (at least 32 characters). Without a
 * pepper no key can be made or checked; a fixed development pepper is used
 * only when the server is not a production build AND the request came to
 * localhost, so a misconfigured deployment fails closed instead of hashing
 * keys with a public value.
 *
 * Storage (lib/partnersKv):
 *   key:<hash>         -> { id, partnerId, env }   the lookup on every API call
 *   keyrec:<id>        -> the full record (name, display, dates, hash)
 *   partnerkeys:<pid>  -> set of key ids
 *   keyused:<id>       -> last use, ms
 *   keylock:<id>       -> short lock while a key is rotated, revoked or renamed
 *
 * A lookup trusts key:<hash> only when keyrec:<id> still holds that hash and
 * is not revoked, so an index entry left behind by an interrupted or
 * concurrent change can never let a secret through.
 */
import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import type { GloamNetwork } from "./networks";
import { jsonOf, k, kv, kv1, type KvCommand } from "./partnersKv";

export type KeyEnv = "test" | "live";

export const KEY_PREFIX: Record<KeyEnv, string> = {
  test: "gloam_test_",
  live: "gloam_live_",
};

const KEY_RE = /^gloam_(test|live)_([A-Za-z0-9_-]{43})$/;

/** Active keys a partner may hold at once. */
export const MAX_ACTIVE_KEYS = 10;
/** Revoked keys kept on record per partner. Past this the oldest go, so making and revoking keys can't grow the store for good. */
export const MAX_REVOKED_KEPT = 50;
export const KEY_NAME_MAX = 40;

/** Requests per key per minute, every v1 endpoint together. */
export const KEY_RATE_LIMIT = 300;
export const KEY_RATE_WINDOW_SEC = 60;

const MIN_PEPPER = 32;
const DEV_PEPPER = "gloam-dev-pepper-for-localhost-only-never-in-production";

// ---------------------------------------------------------------- pepper

export type PepperResult =
  | { ok: true; pepper: string; source: "env" | "dev" }
  | { ok: false; reason: "missing" | "short" };

/** True for localhost, 127.0.0.1, [::1] and *.localhost, with or without a port. */
export function isLocalHost(host: string | null | undefined): boolean {
  if (!host) return false;
  const h = host.trim().toLowerCase().replace(/:\d+$/, "");
  return h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h.endsWith(".localhost");
}

/**
 * The pepper for hashing keys, or why there is none. `host` is the request's
 * Host header: the development pepper is only ever used for a localhost
 * request on a non-production build.
 */
export function apiKeyPepper(host: string | null | undefined): PepperResult {
  const env = process.env.GLOAM_API_KEY_PEPPER?.trim();
  if (env) {
    return env.length >= MIN_PEPPER ? { ok: true, pepper: env, source: "env" } : { ok: false, reason: "short" };
  }
  if (process.env.NODE_ENV !== "production" && isLocalHost(host)) {
    return { ok: true, pepper: DEV_PEPPER, source: "dev" };
  }
  return { ok: false, reason: "missing" };
}

// ---------------------------------------------------------------- format

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A short random id, letters and digits only. */
export function randomId(prefix: string, bytes = 9): string {
  return `${prefix}_${base64url(randomBytes(bytes)).replace(/[-_]/g, "x")}`;
}

/** What the dashboard shows for a key: its kind and a few characters each end. */
export function displayKey(secret: string): string {
  const p = parseApiKey(secret);
  if (!p) return "gloam_…";
  return `${KEY_PREFIX[p.env]}${p.body.slice(0, 4)}…${p.body.slice(-4)}`;
}

export function generateApiKey(env: KeyEnv): string {
  return KEY_PREFIX[env] + base64url(randomBytes(32));
}

export function parseApiKey(raw: string | null | undefined): { env: KeyEnv; body: string } | null {
  if (typeof raw !== "string") return null;
  const m = KEY_RE.exec(raw.trim());
  if (!m) return null;
  return { env: m[1] as KeyEnv, body: m[2]! };
}

export function hashApiKey(secret: string, pepper: string): string {
  return createHmac("sha256", pepper).update(secret.trim()).digest("hex");
}

/** Constant-time check of a secret against a stored hash (tests, rotation checks). */
export function keyMatchesHash(secret: string, hash: string, pepper: string): boolean {
  const a = Buffer.from(hashApiKey(secret, pepper), "hex");
  const b = Buffer.from(hash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The key kind a network takes: testnets take test keys. */
export function keyEnvForNetwork(net: GloamNetwork): KeyEnv {
  return net.chain.testnet ? "test" : "live";
}

/** "Authorization: Bearer gloam_..." -> the key, or null. */
export function bearerKey(header: string | null | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header.trim());
  return m ? m[1]! : null;
}

export function cleanKeyName(raw: unknown): string {
  const s = typeof raw === "string" ? raw : "";
  // Letters, numbers, spaces and a little punctuation; no control characters.
  return s
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, KEY_NAME_MAX);
}

// ---------------------------------------------------------------- storage

export type ApiKeyRecord = {
  id: string;
  partnerId: string;
  name: string;
  env: KeyEnv;
  /** gloam_test_AbCd…wxyz */
  display: string;
  hash: string;
  createdAt: number;
  rotatedAt: number | null;
  revokedAt: number | null;
};

/** What the dashboard and the API return about a key. Never the hash. */
export type ApiKeyView = Omit<ApiKeyRecord, "hash" | "partnerId"> & { lastUsedAt: number | null };

type KeyIndex = { id: string; partnerId: string; env: KeyEnv };

export class ApiKeyError extends Error {
  constructor(
    message: string,
    public status = 400,
    public code = "bad_request"
  ) {
    super(message);
  }
}

function viewOf(r: ApiKeyRecord, lastUsedAt: number | null): ApiKeyView {
  return {
    id: r.id,
    name: r.name,
    env: r.env,
    display: r.display,
    createdAt: r.createdAt,
    rotatedAt: r.rotatedAt,
    revokedAt: r.revokedAt,
    lastUsedAt,
  };
}

async function readRecords(partnerId: string): Promise<ApiKeyRecord[]> {
  const ids = (await kv1(["SMEMBERS", k("partnerkeys", partnerId)])) as string[];
  if (!Array.isArray(ids) || ids.length === 0) return [];
  const raw = await kv(ids.map((id) => ["GET", k("keyrec", id)]));
  return raw
    .map((r) => jsonOf<ApiKeyRecord>(r))
    .filter((r): r is ApiKeyRecord => Boolean(r && r.partnerId === partnerId));
}

export async function listApiKeys(partnerId: string): Promise<ApiKeyView[]> {
  const records = await readRecords(partnerId);
  if (records.length === 0) return [];
  const used = await kv(records.map((r) => ["GET", k("keyused", r.id)]));
  return records
    .map((r, i) => viewOf(r, used[i] == null ? null : Number(used[i])))
    .sort((a, b) => Number(a.revokedAt !== null) - Number(b.revokedAt !== null) || b.createdAt - a.createdAt);
}

async function ownRecord(partnerId: string, keyId: string): Promise<ApiKeyRecord> {
  const rec = jsonOf<ApiKeyRecord>(await kv1(["GET", k("keyrec", keyId)]));
  if (!rec || rec.partnerId !== partnerId) throw new ApiKeyError("No such key.", 404, "not_found");
  return rec;
}

/** Make a key. The secret is returned here and nowhere else, ever. */
export async function createApiKey(args: {
  partnerId: string;
  name: string;
  env: KeyEnv;
  pepper: string;
}): Promise<{ key: ApiKeyView; secret: string }> {
  const name = cleanKeyName(args.name) || "Untitled key";
  const records = await readRecords(args.partnerId);
  const active = records.filter((r) => r.revokedAt === null);
  if (active.length >= MAX_ACTIVE_KEYS) {
    throw new ApiKeyError(`You can have ${MAX_ACTIVE_KEYS} active keys. Revoke one first.`, 409, "key_limit");
  }
  const secret = generateApiKey(args.env);
  const hash = hashApiKey(secret, args.pepper);
  const rec: ApiKeyRecord = {
    id: randomId("key"),
    partnerId: args.partnerId,
    name,
    env: args.env,
    display: displayKey(secret),
    hash,
    createdAt: Date.now(),
    rotatedAt: null,
    revokedAt: null,
  };
  const index: KeyIndex = { id: rec.id, partnerId: rec.partnerId, env: rec.env };
  const [setIndex] = await kv([
    ["SET", k("key", hash), JSON.stringify(index), "NX"],
    ["SET", k("keyrec", rec.id), JSON.stringify(rec)],
    ["SADD", k("partnerkeys", rec.partnerId), rec.id],
  ]);
  if (setIndex !== "OK") throw new ApiKeyError("Could not make a key. Try again.", 500, "internal");
  await forgetOldRevoked(args.partnerId, records).catch(() => undefined);
  return { key: viewOf(rec, null), secret };
}

async function forgetOldRevoked(partnerId: string, records: ApiKeyRecord[]): Promise<void> {
  const old = records
    .filter((r) => r.revokedAt !== null)
    .sort((a, b) => b.revokedAt! - a.revokedAt!)
    .slice(MAX_REVOKED_KEPT);
  if (!old.length) return;
  await kv(old.flatMap((r): KvCommand[] => [["SREM", k("partnerkeys", partnerId), r.id], ["DEL", k("keyrec", r.id)], ["DEL", k("keyused", r.id)]]));
}

/** How long a rotate, revoke or rename may hold a key's lock before it lapses on its own. */
const KEY_LOCK_SEC = 15;

/**
 * Runs `fn` while holding the key's lock, so two changes to one key never
 * read the same record and write over each other. Waits up to `waitMs`
 * for a lock someone else holds, then refuses.
 */
async function withKeyLock<T>(keyId: string, waitMs: number, fn: () => Promise<T>): Promise<T> {
  const lock = k("keylock", keyId);
  const token = randomId("lk");
  const deadline = Date.now() + waitMs;
  while ((await kv1(["SET", lock, token, "NX", "EX", KEY_LOCK_SEC])) !== "OK") {
    if (Date.now() >= deadline) throw new ApiKeyError("This key is being changed. Try again in a moment.", 409, "busy");
    await new Promise((r) => setTimeout(r, 120));
  }
  try {
    return await fn();
  } finally {
    // release only our own lock; if it lapsed and someone else holds it now, leave theirs
    if ((await kv1(["GET", lock]).catch(() => null)) === token) await kv1(["DEL", lock]).catch(() => {});
  }
}

/** New secret for the same key; the old secret stops working at once. One rotation at a time per key. */
export async function rotateApiKey(args: {
  partnerId: string;
  keyId: string;
  pepper: string;
}): Promise<{ key: ApiKeyView; secret: string }> {
  return withKeyLock(args.keyId, 0, async () => {
    const rec = await ownRecord(args.partnerId, args.keyId);
    if (rec.revokedAt !== null) throw new ApiKeyError("This key was revoked. Make a new one.", 409, "revoked");
    const secret = generateApiKey(rec.env);
    const hash = hashApiKey(secret, args.pepper);
    const next: ApiKeyRecord = { ...rec, hash, display: displayKey(secret), rotatedAt: Date.now() };
    const index: KeyIndex = { id: rec.id, partnerId: rec.partnerId, env: rec.env };
    // the record moves to the new hash first: from then on the old secret fails its lookup check
    const [setRec, setIndex] = await kv([
      ["SET", k("keyrec", rec.id), JSON.stringify(next)],
      ["SET", k("key", hash), JSON.stringify(index), "NX"],
      ["DEL", k("key", rec.hash)],
      ["DEL", k("keyused", rec.id)],
    ]);
    if (setRec !== "OK" || setIndex !== "OK") throw new ApiKeyError("Could not rotate the key. Try again.", 500, "internal");
    return { key: viewOf(next, null), secret };
  });
}

/** Stops a key for good. Waits briefly for a rotation in flight, so a revoke is never lost to one. */
export async function revokeApiKey(args: { partnerId: string; keyId: string }): Promise<ApiKeyView> {
  return withKeyLock(args.keyId, 5_000, async () => {
    const rec = await ownRecord(args.partnerId, args.keyId);
    if (rec.revokedAt !== null) return viewOf(rec, null);
    const next: ApiKeyRecord = { ...rec, revokedAt: Date.now() };
    await kv([
      ["SET", k("keyrec", rec.id), JSON.stringify(next)],
      ["DEL", k("key", rec.hash)],
    ]);
    return viewOf(next, null);
  });
}

/**
 * Renames a key. Under the key's lock like a rotate or revoke: the record is
 * written whole, so a rename that read it before one of them would write the
 * old hash or the live state back over it. A revoked key keeps its name.
 */
export async function renameApiKey(args: { partnerId: string; keyId: string; name: string }): Promise<ApiKeyView> {
  const name = cleanKeyName(args.name);
  if (!name) throw new ApiKeyError("Give the key a name.", 400, "bad_name");
  return withKeyLock(args.keyId, 5_000, async () => {
    const rec = await ownRecord(args.partnerId, args.keyId);
    if (rec.revokedAt !== null) throw new ApiKeyError("This key was revoked. Make a new one.", 409, "revoked");
    const next: ApiKeyRecord = { ...rec, name };
    await kv1(["SET", k("keyrec", rec.id), JSON.stringify(next)]);
    return viewOf(next, null);
  });
}

export type AuthedKey = { id: string; partnerId: string; env: KeyEnv };

/**
 * The key behind a secret, or null when it is unknown, malformed or revoked.
 * The index entry only counts if the key's record still holds this exact hash
 * and is not revoked; a stale entry is removed on sight.
 */
export async function lookupApiKey(secret: string, pepper: string): Promise<AuthedKey | null> {
  if (!parseApiKey(secret)) return null;
  const hash = hashApiKey(secret, pepper);
  const index = jsonOf<KeyIndex>(await kv1(["GET", k("key", hash)]));
  if (!index || typeof index.id !== "string" || typeof index.partnerId !== "string") return null;
  const rec = jsonOf<ApiKeyRecord>(await kv1(["GET", k("keyrec", index.id)]));
  if (!rec || rec.partnerId !== index.partnerId || rec.revokedAt !== null || rec.hash !== hash) {
    await kv1(["DEL", k("key", hash)]).catch(() => {});
    return null;
  }
  return { id: index.id, partnerId: index.partnerId, env: index.env === "live" ? "live" : "test" };
}

export type RateState = { limit: number; remaining: number; reset: number; allowed: boolean };

/**
 * Counts one request for a key in the current minute and notes its last use.
 * Fixed one-minute windows, shared by every server instance through the store.
 */
export async function meterApiKey(keyId: string, now = Date.now()): Promise<RateState> {
  const window = Math.floor(now / 1000 / KEY_RATE_WINDOW_SEC);
  const rlKey = k("rl", keyId, window);
  const [count] = await kv([
    ["INCR", rlKey],
    ["EXPIRE", rlKey, KEY_RATE_WINDOW_SEC * 2],
    ["SET", k("keyused", keyId), now],
  ]);
  const n = Number(count);
  return {
    limit: KEY_RATE_LIMIT,
    remaining: Math.max(0, KEY_RATE_LIMIT - n),
    reset: (window + 1) * KEY_RATE_WINDOW_SEC,
    allowed: n <= KEY_RATE_LIMIT,
  };
}

/**
 * Active key count per partner, for the admin list. Two round trips whatever
 * the number of partners: every partner's key set, then every key's record.
 */
export async function activeKeyCounts(partnerIds: string[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  if (partnerIds.length === 0) return out;
  const sets = await kv(partnerIds.map((pid) => ["SMEMBERS", k("partnerkeys", pid)] as KvCommand));
  const owned = partnerIds.flatMap((pid, i) => (Array.isArray(sets[i]) ? (sets[i] as string[]) : []).map((id) => ({ pid, id })));
  const raw = await kv(owned.map(({ id }) => ["GET", k("keyrec", id)] as KvCommand));
  for (const pid of partnerIds) out[pid] = 0;
  owned.forEach(({ pid }, i) => {
    const r = jsonOf<ApiKeyRecord>(raw[i]);
    // the same check as readRecords: a record that names another partner is not theirs
    if (r && r.partnerId === pid && r.revokedAt === null) out[pid]!++;
  });
  return out;
}

