/**
 * Blocktronics token analytics (blocktronics.xyz), read on the server for the
 * swap card's token check (/api/token-insight) and Glim. Server only: the key
 * lives in BLOCKTRONICS_API_KEY, is sent only to api.blocktronics.xyz (as
 * `Authorization: Bearer`) and is never logged or returned. Without it
 * everything here is off.
 *
 * The calls, each POST /v1/tools/<tool> with { token: "<chain>:<address>" }:
 *  - token_overview: the A to E grade and its 0 to 100 composite (data.grade),
 *    and the holder count when its figures carry one
 *  - token_series, metrics ["holders"]: the holder count (wallets with $5 or
 *    more) at the last settled day, only when the overview had none
 *  - get_sections, section "launch_bundles": the launch bundles and the share
 *    of supply they still hold
 * What is sent is the chain and the token's contract address, nothing else:
 * never a wallet, a balance, an IP or anything about who asked.
 *
 * The grade and holders are kept 12 hours, the bundles 24 (they change slowly
 * and cost the most), in Upstash Redis and this instance's memory, keyed by
 * chain and token: a token costs a few calls a day however many people look
 * at it. Answers that say nothing are kept less: a token Blocktronics hasn't
 * indexed 30 minutes (it can be ingested), one it doesn't support a day, a
 * failed call 5 minutes. A refused key, an empty balance or a rate limit
 * pauses every call for a while, and BLOCKTRONICS_DAILY_CALLS caps the calls a
 * UTC day (400 unless set).
 *
 * Docs: blocktronics.xyz/docs (authentication, errors, /docs/api/structure-grade,
 * /docs/api/launch-forensics, /docs/reference for token_series).
 */
import { hitRateLimit } from "./mcpRemote/rateLimit";
import { cacheGetJson, cacheSetJson } from "./tractionStore";
import {
  blocktronicsTokenUrl,
  hasInsight,
  isInsightChain,
  isTokenAddress,
  parseInsight,
  type GradeLetter,
  type InsightChain,
  type TokenInsight,
} from "./tokenInsight";

export const BLOCKTRONICS_API = "https://api.blocktronics.xyz/v1";
/** The API key (server env only, never NEXT_PUBLIC_). Unset: token checks are off. */
export const KEY_ENV = "BLOCKTRONICS_API_KEY";
/** Optional off switch with the key still set: 0, false, off or no. */
export const SWITCH_ENV = "BLOCKTRONICS_ENABLED";
/** Optional cap on calls a UTC day, across every instance. */
export const DAILY_ENV = "BLOCKTRONICS_DAILY_CALLS";

const TIMEOUT_MS = 8_000;
/** The grade and holders are kept this long. */
export const FRESH_SEC = 12 * 3_600;
/** The launch bundles are kept this long. */
export const BUNDLES_SEC = 24 * 3_600;
/** Not indexed: Blocktronics can ingest a token, so not for long. */
export const MISS_SEC = 30 * 60;
/** A token Blocktronics leaves out (stablecoins, wrapped coins, stock tokens). */
export const UNSUPPORTED_SEC = 24 * 3_600;
/** The call failed (timeout, 5xx): the next one for this token waits this long. */
export const ERROR_SEC = 5 * 60;
/** The key was refused or the balance is empty: every call waits this long. */
export const PAUSE_SEC = 30 * 60;
const MAX_PAUSE_SEC = 24 * 3_600;
const DEFAULT_DAILY_CALLS = 400;
const MAX_BODY_CHARS = 1_000_000;
const MEM_MAX = 1_000;
const PREFIX = "gloam:blocktronics:v1:";
const PAUSE_KEY = `${PREFIX}pause`;

export type NoneReason = "not_indexed" | "unsupported" | "no_data";

export type InsightResult =
  | { state: "ok"; insight: TokenInsight }
  | { state: "none"; reason: NoneReason }
  /** The call failed, or calls are paused or over the day's cap. Nothing to show. */
  | { state: "unavailable" }
  /** No key: the switch is off. */
  | { state: "off" };

type Core = Pick<TokenInsight, "grade" | "holders">;
/** The grade and holders of one token, or why there are none. */
type CoreEntry = { at: number; core: Core } | { at: number; none: Exclude<NoneReason, "no_data"> } | { at: number; error: true };
/** Its launch bundles (null: the section isn't served for it). */
type BundlesEntry = { at: number; bundles: TokenInsight["bundles"] } | { at: number; error: true };
type Stored<E> = { exp: number; e: E };

export type Tool = "token_overview" | "token_series" | "get_sections";

// ---------------------------------------------------------------- the switch

/** The key, when one is set and looks like a key (one line of printable characters), else null. */
function apiKey(): string | null {
  const flag = process.env[SWITCH_ENV]?.trim().toLowerCase();
  if (flag && ["0", "false", "off", "no"].includes(flag)) return null;
  const key = process.env[KEY_ENV]?.trim();
  return key && /^[\x21-\x7e]{8,256}$/.test(key) ? key : null;
}

/** Whether token checks are on: a key is set, and BLOCKTRONICS_ENABLED doesn't turn them off. */
export function blocktronicsEnabled(): boolean {
  return apiKey() !== null;
}

function dailyCap(): number {
  const n = Number(process.env[DAILY_ENV]?.trim());
  return Number.isSafeInteger(n) && n > 0 ? n : DEFAULT_DAILY_CALLS;
}

// ---------------------------------------------------------------- the requests

/** Each tool's input: the chain and the contract address, and what to read. Nothing else is ever sent. */
export function toolInput(tool: Tool, chain: InsightChain, token: string): Record<string, unknown> {
  const t = `${chain}:${token.toLowerCase()}`;
  if (tool === "token_series") return { token: t, metrics: ["holders"], days: 7 };
  if (tool === "get_sections") return { token: t, section: "launch_bundles" };
  return { token: t };
}

// ---------------------------------------------------------------- reading answers

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const count = (v: unknown): number | null => {
  const n = num(v);
  return n != null && n >= 0 ? Math.round(n) : null;
};

/** A tool's data, whether it comes in the { tool, ok, charged, data } envelope or bare. */
function dataOf(v: unknown): Obj | null {
  const o = obj(v);
  if (!o) return null;
  return "tool" in o && "data" in o ? obj(o.data) : o;
}

/** The answer is about this token: Blocktronics names the token it resolved, and it must be this one (or a family it is part of). */
function sameToken(d: Obj, token: string): boolean {
  const resolved = obj(d.token);
  const address = typeof resolved?.address === "string" ? resolved.address.toLowerCase() : null;
  if (!address || address === token) return true;
  return [d.token, d.family].some((f) => f != null && JSON.stringify(f).toLowerCase().includes(token));
}

/** token_overview's grade: withheld (INSUFFICIENT) or missing is null, never a guess. */
export function gradeOf(overview: unknown): TokenInsight["grade"] {
  const g = obj(dataOf(overview)?.grade);
  if (!g) return null;
  const coverage = typeof g.coverage_state === "string" ? g.coverage_state.toUpperCase() : null;
  if (coverage === "INSUFFICIENT") return null;
  const letter = typeof g.letter === "string" ? g.letter.trim().toUpperCase() : "";
  if (!/^[A-E]$/.test(letter)) return null;
  const c = num(g.composite);
  return { letter: letter as GradeLetter, score: c != null && c >= 0 && c <= 100 ? Math.round(c) : null, provisional: coverage === "PROVISIONAL" };
}

/** A figure that may come bare or as { last | value | now | current }. */
function figure(v: unknown): number | null {
  const o = obj(v);
  return o ? count(o.last ?? o.value ?? o.now ?? o.current) : count(v);
}

/** The holder count in token_overview's own figures, when it carries one under that name. */
export function overviewHolders(overview: unknown): number | null {
  const d = dataOf(overview);
  for (const box of [d, obj(d?.kpis), obj(d?.figures), obj(d?.key_figures)]) {
    const n = figure(box?.holders);
    if (n != null) return n;
  }
  return null;
}

/** token_series' holders at the last day that has a figure (a missing day stays missing), else its summary's last. */
export function seriesHolders(series: unknown): number | null {
  const s = dataOf(series);
  const data = s?.data;
  const column = obj(data)?.holders;
  if (Array.isArray(column)) {
    for (let i = column.length - 1; i >= 0; i--) {
      const n = count(column[i]);
      if (n != null) return n;
    }
  }
  if (Array.isArray(data)) {
    for (let i = data.length - 1; i >= 0; i--) {
      const n = count(obj(data[i])?.holders);
      if (n != null) return n;
    }
  }
  return count(obj(obj(s?.summary)?.holders)?.last);
}

/** get_sections' launch_bundles, only when ready and not sample data. */
export function bundlesOf(sections: unknown): TokenInsight["bundles"] {
  const s = dataOf(sections);
  const lb = obj(obj(s?.sections)?.launch_bundles) ?? obj(s?.launch_bundles);
  if (!lb || lb.state !== "ready" || lb.sample === true) return null;
  const d = obj(lb.data);
  if (!d) return null;
  const n = count(d.bundle_count);
  const held = num(d.bundled_held_pct);
  const heldPct = n === 0 ? 0 : held != null && held >= 0 && held <= 100 ? held : null;
  return n == null && heldPct == null ? null : { count: n, heldPct };
}

function reasonOf(error: unknown): NoneReason {
  const e = JSON.stringify(error ?? "").toLowerCase();
  if (e.includes("unsupported")) return "unsupported";
  if (/not in the blocktronics cache|hasn'?t indexed|not indexed|search_tokens|ingest/.test(e)) return "not_indexed";
  return "no_data";
}

// ---------------------------------------------------------------- cache

function mem(): Map<string, Stored<unknown>> {
  const g = globalThis as { __gloamBlocktronics?: Map<string, Stored<unknown>> };
  if (!g.__gloamBlocktronics) g.__gloamBlocktronics = new Map();
  return g.__gloamBlocktronics;
}

/** Wipe this instance's copies (self-tests only). */
export function resetBlocktronicsMemory() {
  mem().clear();
  pausedUntil = 0;
  loggedAt = 0;
  inflight.clear();
}

const coreKey = (chain: InsightChain, token: string) => `${PREFIX}t:${chain}:${token}`;
const bundlesKey = (chain: InsightChain, token: string) => `${PREFIX}b:${chain}:${token}`;

function coreOf(raw: unknown): CoreEntry | null {
  const e = obj(raw);
  const at = num(e?.at);
  if (!e || at == null) return null;
  if (e.error === true) return { at, error: true };
  if (e.none === "not_indexed" || e.none === "unsupported") return { at, none: e.none };
  const c = obj(e.core);
  if (!c) return null;
  // read back field by field, through the same check the browser uses
  const probe = parseInsight({ chain: "base", token: "0x0000000000000000000000000000000000000001", grade: c.grade, holders: c.holders, bundles: null });
  return { at, core: { grade: probe?.grade ?? null, holders: probe?.holders ?? null } };
}

function bundlesEntryOf(raw: unknown): BundlesEntry | null {
  const e = obj(raw);
  const at = num(e?.at);
  if (!e || at == null) return null;
  if (e.error === true) return { at, error: true };
  if (!("bundles" in e)) return null;
  if (e.bundles === null) return { at, bundles: null };
  const probe = parseInsight({ chain: "base", token: "0x0000000000000000000000000000000000000001", grade: null, holders: null, bundles: e.bundles });
  return { at, bundles: probe?.bundles ?? null };
}

async function readCache<E>(key: string, now: number, parse: (raw: unknown) => E | null): Promise<E | null> {
  const m = mem();
  const local = m.get(key);
  if (local && local.exp > now) return local.e as E;
  if (local) m.delete(key);
  const stored = obj(await cacheGetJson<Stored<unknown>>(key));
  const exp = num(stored?.exp);
  if (!stored || exp == null || exp <= now) return null;
  const e = parse(stored.e);
  if (e) remember(key, { exp, e }, now);
  return e;
}

function remember(key: string, s: Stored<unknown>, now: number) {
  const m = mem();
  if (m.size >= MEM_MAX) {
    for (const [k, v] of m) if (v.exp <= now) m.delete(k);
    if (m.size >= MEM_MAX) m.delete(m.keys().next().value!);
  }
  m.set(key, s);
}

/** Kept here, and in Redis unless it is a failed call: another instance may reach Blocktronics fine. */
async function writeCache(key: string, e: CoreEntry | BundlesEntry, ttlSec: number, now: number): Promise<void> {
  const s: Stored<unknown> = { exp: now + ttlSec * 1000, e };
  remember(key, s, now);
  if (!("error" in e)) await cacheSetJson(key, s, ttlSec);
}

// ---------------------------------------------------------------- pause and logs

let pausedUntil = 0;
let loggedAt = 0;

/** At most one warning a minute: a bad key would otherwise log on every request. */
function warn(event: string, fields: Record<string, unknown>, now: number) {
  if (now - loggedAt < 60_000) return;
  loggedAt = now;
  console.warn(event, JSON.stringify(fields));
}

async function paused(now: number): Promise<boolean> {
  if (pausedUntil > now) return true;
  const stored = num(obj(await cacheGetJson<{ until: number }>(PAUSE_KEY))?.until);
  if (stored != null && stored > now) {
    pausedUntil = stored;
    return true;
  }
  return false;
}

async function pause(seconds: number, now: number, status: number, code: string | null): Promise<void> {
  const sec = Math.min(Math.max(Math.round(seconds), 30), MAX_PAUSE_SEC);
  pausedUntil = now + sec * 1000;
  await cacheSetJson(PAUSE_KEY, { until: pausedUntil }, sec);
  warn("gloam_blocktronics_paused", { status, code, seconds: sec }, now);
}

/** Blocktronics' error code, when it is one (a short snake_case word); never the rest of the body. */
function codeOf(body: unknown): string | null {
  const c = obj(body)?.code;
  return typeof c === "string" && /^[a-z_]{1,40}$/.test(c) ? c : null;
}

function retryAfterSec(res: Response, body: unknown, now: number): number {
  const resets = obj(body)?.resets_at;
  if (typeof resets === "string" || typeof resets === "number") {
    const at = new Date(resets).getTime();
    if (Number.isFinite(at) && at > now) return (at - now) / 1000;
  }
  const header = Number(res.headers.get("retry-after"));
  return Number.isFinite(header) && header > 0 ? header : 60;
}

// ---------------------------------------------------------------- one call

/** Refusals about the key or the balance (docs/errors): every call waits, as for a 401, 402 or 403. */
const PAUSE_CODES = new Set(["bad_key", "signed_out", "key_scope", "insufficient", "refused", "not_entitled", "ask_first"]);

/** What one tool call came to. `stop`: calls are paused or over the cap, so nothing more is asked now. */
type Answer = { ok: true; data: Obj } | { ok: false; none: NoneReason } | { ok: false; error: true } | { ok: false; stop: true };

async function callTool(tool: Tool, chain: InsightChain, token: string, key: string, now: number): Promise<Answer> {
  const budget = await hitRateLimit("blocktronics", "blocktronics-calls", dailyCap(), now, 86_400);
  if (!budget.allowed) {
    warn("gloam_blocktronics_daily_cap", { cap: budget.limit }, now);
    return { ok: false, stop: true };
  }
  let res: Response;
  let body: unknown = null;
  try {
    res = await fetch(`${BLOCKTRONICS_API}/tools/${tool}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(toolInput(tool, chain, token)),
      cache: "no-store",
      // never carry the key anywhere else
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await res.text();
    if (text.length > MAX_BODY_CHARS) throw new RangeError("answer too large");
    body = text ? JSON.parse(text) : null;
  } catch (e) {
    warn("gloam_blocktronics_failed", { tool, chain, why: e instanceof Error ? e.name : "unknown" }, now);
    return { ok: false, error: true };
  }
  const code = codeOf(body);
  // a refusal is a non-2xx with { code, error }; a 200 that says ok: false is read the same way
  const refused = res.ok && obj(body)?.ok === false;
  if (res.ok && !refused) {
    const data = obj(obj(body)?.data);
    if (!data || !sameToken(data, token)) return { ok: false, none: "no_data" };
    return { ok: true, data };
  }
  if (res.status === 422 || code === "unsupported_token") return { ok: false, none: "unsupported" };
  if (code === "tool_error") return { ok: false, none: reasonOf(obj(body)?.error) };
  if (res.status === 401 || res.status === 402 || res.status === 403 || (refused && code !== null && PAUSE_CODES.has(code))) {
    await pause(PAUSE_SEC, now, res.status, code);
    return { ok: false, stop: true };
  }
  if (res.status === 429 || code === "rate_limited" || code === "credential_cap_reached") {
    await pause(retryAfterSec(res, body, now), now, res.status, code);
    return { ok: false, stop: true };
  }
  if (refused) return { ok: false, none: "no_data" };
  warn("gloam_blocktronics_refused", { tool, status: res.status, code, chain }, now);
  return { ok: false, error: true };
}

// ---------------------------------------------------------------- the check

/**
 * The grade and holders: the overview, then the holder series only when the
 * overview had no count. With how long to keep what was read.
 */
async function readCore(chain: InsightChain, token: string, key: string, now: number): Promise<{ e: CoreEntry; ttl: number } | "stop"> {
  const ov = await callTool("token_overview", chain, token, key, now);
  if ("stop" in ov) return "stop";
  if ("error" in ov) return { e: { at: now, error: true }, ttl: ERROR_SEC };
  if (!ov.ok) {
    if (ov.none === "not_indexed") return { e: { at: now, none: ov.none }, ttl: MISS_SEC };
    if (ov.none === "unsupported") return { e: { at: now, none: ov.none }, ttl: UNSUPPORTED_SEC };
    return { e: { at: now, core: { grade: null, holders: null } }, ttl: MISS_SEC };
  }
  const grade = gradeOf(ov.data);
  let holders = overviewHolders(ov.data);
  let ttl = FRESH_SEC;
  if (holders == null) {
    const s = await callTool("token_series", chain, token, key, now);
    if (s.ok) holders = seriesHolders(s.data);
    else if (!("none" in s)) {
      // the series failed: keep the grade, and ask again soon for the holders
      if (!grade) return "stop" in s ? "stop" : { e: { at: now, error: true }, ttl: ERROR_SEC };
      ttl = ERROR_SEC;
    }
  }
  if (!grade && holders == null) ttl = Math.min(ttl, MISS_SEC);
  return { e: { at: now, core: { grade, holders } }, ttl };
}

async function check(chain: InsightChain, token: string, key: string, now: number): Promise<InsightResult> {
  const ck = coreKey(chain, token);
  let core = await readCache(ck, now, coreOf);
  if (!core) {
    if (await paused(now)) return { state: "unavailable" };
    const read = await readCore(chain, token, key, now);
    if (read === "stop") return { state: "unavailable" };
    core = read.e;
    await writeCache(ck, read.e, read.ttl, now);
  }
  if ("error" in core) return { state: "unavailable" };
  if ("none" in core) return { state: "none", reason: core.none };

  const bk = bundlesKey(chain, token);
  let bundles = await readCache(bk, now, bundlesEntryOf);
  if (!bundles && !(await paused(now))) {
    const b = await callTool("get_sections", chain, token, key, now);
    if (b.ok) bundles = { at: now, bundles: bundlesOf(b.data) };
    else if ("none" in b) bundles = { at: now, bundles: null };
    else if ("error" in b) bundles = { at: now, error: true };
    if (bundles) await writeCache(bk, bundles, "error" in bundles ? ERROR_SEC : bundles.bundles ? BUNDLES_SEC : FRESH_SEC, now);
  }
  const insight: TokenInsight = {
    chain,
    token: token as `0x${string}`,
    grade: core.core.grade,
    holders: core.core.holders,
    bundles: bundles && "bundles" in bundles ? bundles.bundles : null,
    url: blocktronicsTokenUrl(chain, token),
  };
  return hasInsight(insight) ? { state: "ok", insight } : { state: "none", reason: "no_data" };
}

const inflight = new Map<string, Promise<InsightResult>>();

/**
 * The token check for one public token contract: from the cache when it has
 * it, else a few calls to Blocktronics (one check at a time per token in this
 * instance). Never throws.
 */
export async function tokenInsight(chain: InsightChain, token: string, now = Date.now()): Promise<InsightResult> {
  const key = apiKey();
  if (!key) return { state: "off" };
  if (!isInsightChain(chain) || !isTokenAddress(token)) return { state: "none", reason: "no_data" };
  const t = token.toLowerCase();
  const id = `${chain}:${t}`;
  const running = inflight.get(id);
  if (running) return running;
  const p = check(chain, t, key, now)
    .catch((e: unknown) => {
      warn("gloam_blocktronics_failed", { chain, why: e instanceof Error ? e.name : "unknown" }, now);
      return { state: "unavailable" } as const;
    })
    .finally(() => inflight.delete(id));
  inflight.set(id, p);
  return p;
}
