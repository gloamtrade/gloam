import "server-only";

/**
 * Gloam on Solana for /admin, read from Solana itself. Server only; on only
 * while SOLANA_RINGS_ENABLED is on, on mainnet (metrics SOLANA_ADMIN_ON).
 * lib/onchainMetrics reads it beside the EVM vaults and keeps it in the same
 * one-minute snapshot.
 *
 * Two sources:
 *  - Gloam's relay, the fee payer on every private account's transaction: its
 *    signatures (getSignaturesForAddress, newest first, paged) and each new
 *    transaction once (getTransaction, version 1). A transaction never changes,
 *    so what it was read as is kept in Redis by signature, and a read only asks
 *    for signatures newer than the last one it finished at. The first read, or a
 *    long gap, is caught up over several reads.
 *  - Wallet adds the app reported (/api/solana/added), checked on chain and kept
 *    by signature. An add the wallet paid for itself names no Gloam account on
 *    chain, so this is the only way to count one: from the day it shipped, with
 *    nothing before it. One the relay paid for is in the relay's history too,
 *    and counts once (metrics solanaFigures).
 *
 * Helius is on its free plan: a read makes one signature call per relay plus a
 * call per transaction it has never seen, a few at a time.
 */
import { jsonOf, kv } from "@/lib/partnersKv";
import { loadSolUsd, loadZecUsd } from "@/lib/live-quotes";
import { priceAt, usdSeries, type Point } from "@/lib/priceHistory";
import { RINGS_SOL_MINT, SOLANA_RINGS_ENABLED, ZEC_SOLANA_MINT } from "./config";
import { SHIELDED_POOL_PROGRAM } from "./relayPolicy";
import { heliusRpcUrl, relayerSigner } from "./server";
import { isSignature, parseAddTx, parseRelayTx, type RpcTx } from "./metricsParse";
import { SOLANA_ADMIN_ON, solanaFigures, type SolanaMetrics, type SolEvent, type SolUnitPrice } from "./metrics";

/**
 * Gloam's Solana relay on mainnet since Solana opened (its address is public:
 * it pays the fee on every transaction it sponsors). The relay the server signs
 * with now is read too, so a new relay key adds to the history instead of
 * replacing it.
 */
export const MAINNET_RELAYS: readonly string[] = ["8kvtHN7Ygt53MQPSvhcKMWBVtkrV57qsxMV68oSdRWkd"];

export async function solanaRelays(): Promise<string[]> {
  const signer = await relayerSigner().catch(() => null);
  return [...new Set([...(signer ? [signer.address] : []), ...MAINNET_RELAYS])];
}

/**
 * Where the admin reads Solana: Helius, with the key (lib/solanaRings/server),
 * or GLOAM_SOLANA_METRICS_RPC (an https URL) to read the same public history
 * from another RPC, for a local run without the key. Never logged.
 */
export function metricsRpcUrl(): string | null {
  const o = process.env.GLOAM_SOLANA_METRICS_RPC?.trim();
  if (o && /^https:\/\/\S+$/.test(o)) return o;
  return heliusRpcUrl();
}

export type SolRpc = <T>(method: string, params: unknown[]) => Promise<T>;

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

/** JSON-RPC to `url`: 15s a call, one retry after a 429 or a 5xx. Errors never carry the URL. */
export function makeRpc(url: string, fetchImpl: typeof fetch = fetch): SolRpc {
  return async <T>(method: string, params: unknown[]): Promise<T> => {
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await fetchImpl(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
          signal: AbortSignal.timeout(15_000),
          cache: "no-store",
        });
      } catch {
        if (attempt < 1) {
          await sleep(800);
          continue;
        }
        throw new Error(`${method}: no answer`);
      }
      if ((res.status === 429 || res.status >= 500) && attempt < 1) {
        await sleep(1_200);
        continue;
      }
      if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`);
      const j = (await res.json()) as { result?: T; error?: { code?: number } };
      if (j.error) throw new Error(`${method}: error ${j.error.code ?? ""}`.trim());
      return j.result as T;
    }
  };
}

/* ------------------------------------------------------------------ relay */

const PAGE = 1_000;
/** Signature pages per read; a longer history is caught up on the next reads. */
const MAX_PAGES = 5;
/** New transactions fetched per read, a few at a time; the rest wait for the next read. */
const MAX_FETCH = 40;
const FETCH_AT_ONCE = 3;

type SigRow = { signature: string; slot: number; err: unknown; blockTime?: number | null };

/**
 * What one relay has been read to. `newest`: every signature up to it has been
 * listed. `gap`: a listing that stopped early, still to be finished: from
 * `before` back to `newest`, and once that is done `top` becomes `newest`.
 * `pending`: listed signatures whose transaction is still to be fetched.
 */
type RelayState = { txs: Map<string, SolEvent>; newest: string | null; gap: { top: string; before: string } | null; pending: string[] };
type Cursor = { newest?: string | null; gap?: { top?: string; before?: string } | null; pending?: string[] };

const relayStates = new Map<string, RelayState>();
const txKey = (relay: string) => `gloam:solana:relay:v1:${relay}:tx`;
const cursorKey = (relay: string) => `gloam:solana:relay:v1:${relay}:cursor`;

/** What a relay has been read to: this instance's memory, else Redis, else nothing (read from the start). */
async function loadRelay(relay: string): Promise<RelayState> {
  const hit = relayStates.get(relay);
  if (hit) return hit;
  const s: RelayState = { txs: new Map(), newest: null, gap: null, pending: [] };
  try {
    const [h, c] = await kv([
      ["HGETALL", txKey(relay)],
      ["GET", cursorKey(relay)],
    ]);
    const flat = Array.isArray(h) ? h : [];
    for (let i = 0; i + 1 < flat.length; i += 2) {
      const e = jsonOf<SolEvent>(flat[i + 1]);
      if (e && e.sig === String(flat[i]) && typeof e.k === "string") s.txs.set(e.sig, e);
    }
    const cur = jsonOf<Cursor>(c);
    if (cur) {
      s.newest = isSignature(cur.newest) ? cur.newest : null;
      s.gap = cur.gap && isSignature(cur.gap.top) && isSignature(cur.gap.before) ? { top: cur.gap.top, before: cur.gap.before } : null;
      s.pending = (cur.pending ?? []).filter(isSignature);
    }
  } catch {
    /* no store: this instance reads from the start and keeps what it read */
  }
  relayStates.set(relay, s);
  return s;
}

/** Reads what the relay signed since the last read into its state, and keeps it. */
export async function scanRelay(rpc: SolRpc, relay: string): Promise<RelayState> {
  const s = await loadRelay(relay);
  const listed: SigRow[] = [];
  const fromGap = s.gap;
  let before = fromGap?.before;
  let complete = false;
  for (let page = 0; page < MAX_PAGES; page++) {
    const opts: Record<string, unknown> = { limit: PAGE, commitment: "confirmed" };
    if (before) opts.before = before;
    if (s.newest) opts.until = s.newest;
    const got = await rpc<SigRow[]>("getSignaturesForAddress", [relay, opts]);
    if (!Array.isArray(got)) throw new Error("getSignaturesForAddress: bad answer");
    listed.push(...got.filter((x) => x && isSignature(x.signature)));
    if (got.length < PAGE) {
      complete = true;
      break;
    }
    before = got[got.length - 1]!.signature;
  }

  const fresh: SolEvent[] = [];
  const want: string[] = [];
  for (const x of listed) {
    if (s.txs.has(x.signature)) continue;
    // A transaction that failed moved nothing: no need to fetch it.
    if (x.err != null) fresh.push({ sig: x.signature, k: "failed", ts: x.blockTime ?? 0, slot: x.slot });
    else want.push(x.signature);
  }
  for (const p of s.pending) if (!s.txs.has(p) && !want.includes(p)) want.push(p);
  const now = want.slice(0, MAX_FETCH);
  const missed: string[] = [];
  for (let i = 0; i < now.length; i += FETCH_AT_ONCE) {
    const batch = now.slice(i, i + FETCH_AT_ONCE);
    const got = await Promise.all(
      batch.map((sig) =>
        rpc<RpcTx | null>("getTransaction", [sig, { encoding: "json", maxSupportedTransactionVersion: 1, commitment: "confirmed" }]).catch(() => null)
      )
    );
    batch.forEach((sig, j) => {
      const tx = got[j];
      if (tx && tx.meta && tx.transaction) fresh.push(parseRelayTx(sig, tx, relay));
      else missed.push(sig);
    });
  }

  for (const e of fresh) s.txs.set(e.sig, e);
  s.pending = [...missed, ...want.slice(MAX_FETCH)];
  if (fromGap) {
    if (complete) {
      s.newest = fromGap.top;
      s.gap = null;
    } else if (before) s.gap = { top: fromGap.top, before };
  } else if (complete) {
    if (listed[0]) s.newest = listed[0].signature;
  } else if (listed[0] && before) {
    s.gap = { top: listed[0].signature, before };
  }

  const cmds: (string | number)[][] = [];
  if (fresh.length) cmds.push(["HSET", txKey(relay), ...fresh.flatMap((e) => [e.sig, JSON.stringify(e)])]);
  cmds.push(["SET", cursorKey(relay), JSON.stringify({ newest: s.newest, gap: s.gap, pending: s.pending } satisfies Cursor)]);
  await kv(cmds).catch(() => {
    /* kept in memory; the next read writes it again */
  });
  return s;
}

/* ------------------------------------------------------------------ wallet adds */

const ADDS_KEY = "gloam:solana:adds:v1";
const ADDS_SINCE_KEY = "gloam:solana:adds:v1:since";

/** Every wallet add on record, and since when adds have been recorded (unix seconds). */
export async function readSolanaAdds(nowSec = Math.floor(Date.now() / 1000)): Promise<{ adds: SolEvent[]; since: number | null }> {
  const [h, , since] = await kv([
    ["HGETALL", ADDS_KEY],
    ["SET", ADDS_SINCE_KEY, String(nowSec), "NX"],
    ["GET", ADDS_SINCE_KEY],
  ]);
  const adds: SolEvent[] = [];
  const flat = Array.isArray(h) ? h : [];
  for (let i = 0; i + 1 < flat.length; i += 2) {
    const e = jsonOf<SolEvent>(flat[i + 1]);
    if (e && e.k === "add" && e.sig === String(flat[i])) adds.push(e);
  }
  const s = Number(since);
  const first = adds.reduce<number | null>((a, e) => (e.ts && (a == null || e.ts < a) ? e.ts : a), null);
  const from = Number.isFinite(s) && s > 0 ? s : null;
  return { adds, since: from == null ? first : first == null ? from : Math.min(from, first) };
}

export type AddResult = { recorded: boolean; reason?: string };

/**
 * Records one wallet add the app reported, once it is checked on chain
 * (metricsParse parseAddTx). Kept once per signature, however often it is
 * reported. The transaction may not be readable the moment it lands, so it is
 * asked for a few times.
 */
export async function recordSolanaAdd(
  signature: string,
  deps: { rpc: SolRpc; relays: readonly string[]; nowSec?: () => number; wait?: (ms: number) => Promise<void>; tries?: number }
): Promise<AddResult> {
  if (!isSignature(signature)) return { recorded: false, reason: "not a signature" };
  const [have] = await kv([["HGET", ADDS_KEY, signature]]);
  if (have) return { recorded: false, reason: "already recorded" };
  let tx: RpcTx | null = null;
  const tries = deps.tries ?? 3;
  for (let i = 0; i < tries; i++) {
    tx = await deps
      .rpc<RpcTx | null>("getTransaction", [signature, { encoding: "json", maxSupportedTransactionVersion: 1, commitment: "confirmed" }])
      .catch(() => null);
    if (tx) break;
    if (i < tries - 1) await (deps.wait ?? sleep)(1_500);
  }
  const nowSec = (deps.nowSec ?? (() => Math.floor(Date.now() / 1000)))();
  const v = parseAddTx(signature, tx, { relays: deps.relays, nowSec });
  if (!v.ok) return { recorded: false, reason: v.reason };
  const [added] = await kv([
    ["HSETNX", ADDS_KEY, signature, JSON.stringify(v.event)],
    ["SET", ADDS_SINCE_KEY, String(nowSec), "NX"],
  ]);
  return Number(added) === 1 ? { recorded: true } : { recorded: false, reason: "already recorded" };
}

/* ------------------------------------------------------------------ prices */

const GECKO: Record<string, string> = { [RINGS_SOL_MINT]: "solana", [ZEC_SOLANA_MINT]: "zcash" };

/**
 * SOL and ZEC at the time of each flow (CoinGecko's hourly price, as the EVM
 * side), else today's price, named as such; stablecoins never ask.
 */
async function pricesFor(events: SolEvent[]): Promise<SolUnitPrice> {
  const priced = events.filter((e) => e.m && GECKO[e.m] && e.ts && (e.k === "add" || e.k === "bring" || e.k === "cashout"));
  const series = new Map<string, Point[] | null>();
  const today = new Map<string, number | null>();
  for (const id of new Set(priced.map((e) => GECKO[e.m!]!))) {
    const from = Math.min(...priced.filter((e) => GECKO[e.m!] === id).map((e) => e.ts)) - 3 * 3_600;
    series.set(id, await Promise.race([usdSeries(id, from).catch(() => null), sleep(10_000).then(() => null)]));
    const pts = series.get(id);
    if (!pts || priced.some((e) => GECKO[e.m!] === id && !priceAt(pts, e.ts))) {
      today.set(id, await Promise.race([(id === "solana" ? loadSolUsd() : loadZecUsd()).catch(() => null), sleep(10_000).then(() => null)]));
    }
  }
  return (mint, ts) => {
    const id = GECKO[mint];
    if (!id) return { usd: null, atToday: false };
    const pts = series.get(id);
    const q = pts ? priceAt(pts, ts) : null;
    if (q) return { usd: q.usd, atToday: false };
    const t = today.get(id) ?? null;
    return { usd: t, atToday: t != null };
  };
}

/* ------------------------------------------------------------------ read */

/** The most a read waits on Solana before showing what it already has. */
const READ_BUDGET_MS = 25_000;

/**
 * Solana's figures for /admin, lined up with the EVM side's days; null while
 * Solana is off or on devnet. Never throws: a failed or slow read shows the
 * last figures read, with the error.
 */
export async function readSolanaMetrics(days: string[], revenueDays: string[], launchDays: string[]): Promise<SolanaMetrics | null> {
  if (!SOLANA_ADMIN_ON || !SOLANA_RINGS_ENABLED) return null;
  const started = Date.now();
  const relays = await solanaRelays();
  const url = metricsRpcUrl();
  let error: string | null = url ? null : "No Solana RPC on this server (HELIUS_API_KEY is not set).";

  if (url) {
    const rpc = makeRpc(url);
    const scans = Promise.all(
      relays.map((r) =>
        scanRelay(rpc, r).catch((e: unknown) => {
          console.warn("gloam_solana_metrics", r.slice(0, 6), e instanceof Error ? e.message.slice(0, 80) : "failed");
          error = "Could not read Solana. The details are in the server logs.";
        })
      )
    );
    const done = await Promise.race([scans.then(() => true), sleep(READ_BUDGET_MS).then(() => false)]);
    if (!done) error = "Solana is slow to answer: these are the figures read so far.";
  }

  const events: SolEvent[] = [];
  for (const r of relays) {
    const s = relayStates.get(r) ?? (await loadRelay(r));
    events.push(...s.txs.values());
  }
  let adds: SolEvent[] = [];
  let addsSince: number | null = null;
  try {
    const a = await readSolanaAdds();
    adds = a.adds;
    addsSince = a.since;
  } catch {
    error ??= "Could not read the wallet adds on record.";
  }
  const price = await pricesFor([...events, ...adds]);
  const slots = events.filter((e) => e.k !== "failed").map((e) => e.slot);
  return solanaFigures({
    relays,
    pool: SHIELDED_POOL_PROGRAM,
    events,
    adds,
    price,
    days,
    revenueDays,
    launchDays,
    addsSince,
    lastSlot: slots.length ? Math.max(...slots) : null,
    readMs: Date.now() - started,
    error,
  });
}

/** For self-tests: forget what this instance has read. */
export function resetSolanaMetrics(): void {
  relayStates.clear();
}
