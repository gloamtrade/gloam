/**
 * Reads one Solana transaction (getTransaction, "json" encoding, version 1
 * allowed) into what /admin counts for Gloam on Solana (lib/solanaRings/metrics
 * SolEvent). Pure: the server fetches (lib/solanaRings/metricsServer, only
 * while Solana is on), this decides.
 *
 * Amounts come from balances, never from instruction data: the pool's own
 * accounts rise on a deposit and fall on a cash-out. The pool keeps SOL in its
 * SOL interface account and each SPL token in a vault owned by its CPI
 * authority (both from the SDK, checked by scripts/selftest-solana-metrics).
 * A transact also funds new nullifier accounts out of the pool's tree, so a
 * lamport gain alone never makes a cash-out: only the pool paying out does.
 */
import { getBase58Encoder } from "@solana/kit";
import { ringsAssets, RINGS_SOL_MINT } from "./config";
import { SHIELDED_POOL_PROGRAM, USER_REGISTRY_PROGRAM } from "./relayPolicy";
import type { SolEvent } from "./metrics";

/** The pool's CPI authority, which owns every SPL vault (SDK getShieldedPoolCpiAuthorityAddress). */
export const POOL_AUTHORITY = "CaM8DbtJ2mSecgaHYo9xeT7VSKq7AnaqEUm5p7e5LW4a";
/** Where the pool keeps SOL (SDK getSolInterfaceAddress). */
export const POOL_SOL_VAULT = "CiNmas621VuyofiDSrEPfTXHKrdZuB6jMKECyNiMpLXE";

const REGISTER = 0;
const DEPOSIT = 15;
const TRANSACT = 16;
const MERGE = 17;

type TokenBalance = { accountIndex: number; mint: string; owner?: string; uiTokenAmount: { amount: string; decimals: number } };

/** The parts of a getTransaction answer read here. */
export type RpcTx = {
  slot: number;
  blockTime?: number | null;
  meta: {
    err: unknown;
    preBalances: number[];
    postBalances: number[];
    preTokenBalances?: TokenBalance[] | null;
    postTokenBalances?: TokenBalance[] | null;
    loadedAddresses?: { writable: string[]; readonly: string[] } | null;
  } | null;
  transaction: {
    message: {
      accountKeys: (string | { pubkey: string })[];
      header: { numRequiredSignatures: number };
      instructions: { programIdIndex: number; accounts?: number[]; data: string }[];
    };
  };
};

/** Every account the transaction names, in index order (lookup tables last, writable first). */
function keysOf(tx: RpcTx): string[] {
  const own = tx.transaction.message.accountKeys.map((k) => (typeof k === "string" ? k : k.pubkey));
  const loaded = tx.meta?.loadedAddresses;
  return [...own, ...(loaded?.writable ?? []), ...(loaded?.readonly ?? [])];
}

function tag(data: string): number | undefined {
  try {
    return new Uint8Array(getBase58Encoder().encode(data))[0];
  } catch {
    return undefined;
  }
}

function instructions(tx: RpcTx, keys: string[]): { program: string; tag: number | undefined }[] {
  return tx.transaction.message.instructions.map((ix) => ({ program: keys[ix.programIdIndex] ?? "", tag: tag(ix.data) }));
}

type TokenMove = { account: string; owner: string; mint: string; decimals: number; delta: bigint };

/** Each token account's change, with its owner and mint. */
function tokenMoves(tx: RpcTx, keys: string[]): TokenMove[] {
  const pre = new Map((tx.meta?.preTokenBalances ?? []).map((b) => [b.accountIndex, b]));
  const post = new Map((tx.meta?.postTokenBalances ?? []).map((b) => [b.accountIndex, b]));
  const out: TokenMove[] = [];
  for (const i of new Set([...pre.keys(), ...post.keys()])) {
    const a = pre.get(i);
    const b = post.get(i);
    const ref = (b ?? a)!;
    const delta = BigInt(b?.uiTokenAmount.amount ?? "0") - BigInt(a?.uiTokenAmount.amount ?? "0");
    if (delta !== 0n) out.push({ account: keys[i] ?? "", owner: ref.owner ?? "", mint: ref.mint, decimals: ref.uiTokenAmount.decimals, delta });
  }
  return out;
}

/** Each account's lamport change. */
function lamportMoves(tx: RpcTx, keys: string[]): Map<string, bigint> {
  const out = new Map<string, bigint>();
  const pre = tx.meta?.preBalances ?? [];
  const post = tx.meta?.postBalances ?? [];
  for (let i = 0; i < Math.min(pre.length, post.length, keys.length); i++) {
    const d = BigInt(post[i]!) - BigInt(pre[i]!);
    if (d !== 0n) out.set(keys[i]!, d);
  }
  return out;
}

type PoolMove = { mint: string; decimals: number; delta: bigint };

/** What the pool's own accounts gained (+) or paid out (-), per asset (SOL as RINGS_SOL_MINT). */
function poolMoves(tokens: TokenMove[], lamports: Map<string, bigint>): PoolMove[] {
  const by = new Map<string, PoolMove>();
  const sol = lamports.get(POOL_SOL_VAULT);
  if (sol) by.set(RINGS_SOL_MINT, { mint: RINGS_SOL_MINT, decimals: 9, delta: sol });
  for (const t of tokens) {
    if (t.owner !== POOL_AUTHORITY) continue;
    const m = by.get(t.mint) ?? { mint: t.mint, decimals: t.decimals, delta: 0n };
    m.delta += t.delta;
    by.set(t.mint, m);
  }
  return [...by.values()].filter((m) => m.delta !== 0n);
}

/**
 * Who a cash-out paid, and how much they got: for a token, the owner of the
 * account outside the pool that gained the most of it; for SOL, the account
 * (not the relay, not the pool) whose gain is nearest what the pool paid out,
 * so a new nullifier account's rent is never taken for it.
 */
function payee(out: PoolMove, tokens: TokenMove[], lamports: Map<string, bigint>, relay: string): { w?: string; v: bigint } {
  const paid = -out.delta;
  if (out.mint !== RINGS_SOL_MINT) {
    const best = tokens
      .filter((t) => t.mint === out.mint && t.owner !== POOL_AUTHORITY && t.delta > 0n)
      .sort((a, b) => (b.delta > a.delta ? 1 : b.delta < a.delta ? -1 : 0))[0];
    return best ? { w: best.owner || undefined, v: best.delta } : { v: paid };
  }
  let best: [string, bigint] | null = null;
  for (const [k, d] of lamports) {
    if (d <= 0n || k === relay || k === POOL_SOL_VAULT) continue;
    const gap = (x: bigint) => (x > paid ? x - paid : paid - x);
    if (!best || gap(d) < gap(best[1])) best = [k, d];
  }
  return best ? { w: best[0], v: best[1] } : { v: paid };
}

/** One transaction the relay `relay` signed, as /admin counts it. */
export function parseRelayTx(sig: string, tx: RpcTx, relay: string): SolEvent {
  const base = { sig, ts: tx.blockTime ?? 0, slot: tx.slot };
  if (!tx.meta) return { ...base, k: "other" };
  if (tx.meta.err != null) return { ...base, k: "failed" };
  const keys = keysOf(tx);
  // Only what the relay paid for is Gloam's: it is the fee payer on every one.
  if (keys[0] !== relay) return { ...base, k: "other" };
  const signers = keys.slice(0, tx.transaction.message.header.numRequiredSignatures);
  const acct = signers.find((k) => k !== relay);
  const ixs = instructions(tx, keys);
  const has = (program: string, t: number) => ixs.some((x) => x.program === program && x.tag === t);

  if (has(USER_REGISTRY_PROGRAM, REGISTER)) return { ...base, k: "open", ...(acct ? { acct } : {}) };
  const tokens = tokenMoves(tx, keys);
  const lamports = lamportMoves(tx, keys);
  const pool = poolMoves(tokens, lamports);
  if (has(SHIELDED_POOL_PROGRAM, DEPOSIT)) {
    const inn = pool.find((m) => m.delta > 0n);
    if (!inn) return { ...base, k: "other" };
    return { ...base, k: "bring", ...(acct ? { acct } : {}), m: inn.mint, v: String(inn.delta), d: inn.decimals };
  }
  if (has(SHIELDED_POOL_PROGRAM, TRANSACT)) {
    const out = pool.find((m) => m.delta < 0n);
    if (!out) return { ...base, k: "pay", ...(acct ? { acct } : {}) };
    const p = payee(out, tokens, lamports, relay);
    return { ...base, k: "cashout", ...(acct ? { acct } : {}), ...(p.w ? { w: p.w } : {}), m: out.mint, v: String(p.v), d: out.decimals };
  }
  if (has(SHIELDED_POOL_PROGRAM, MERGE)) return { ...base, k: "merge", ...(acct ? { acct } : {}) };
  return { ...base, k: "other" };
}

/** How long after it landed a wallet add may still be recorded: the page reports it right away. */
export const ADD_MAX_AGE_SEC = 3_600;

export type AddVerdict = { ok: true; event: SolEvent } | { ok: false; reason: string };

/**
 * A wallet add (lib/solanaRings/client addToPrivate) checked on chain: it
 * landed in the last hour, it is one shielded-pool deposit of a listed asset,
 * and the depositing wallet is where the money came from. The depositor is the
 * fee payer, or, when Gloam's relay paid the fee (a wallet with no SOL), the
 * one other signer. Whether that depositor is a person's wallet or a Gloam
 * private account bringing money in is decided with the relay's registrations
 * (metrics solanaFigures). The chain can't say a wallet-paid add was made in
 * Gloam (the pool is shared with every Privacy Rings app); this is what it can say.
 */
export function parseAddTx(sig: string, tx: RpcTx | null, opts: { relays: readonly string[]; nowSec: number; maxAgeSec?: number }): AddVerdict {
  if (!tx || !tx.meta) return { ok: false, reason: "not found" };
  if (tx.meta.err != null) return { ok: false, reason: "failed" };
  const ts = tx.blockTime ?? 0;
  if (!ts || ts > opts.nowSec + 120 || opts.nowSec - ts > (opts.maxAgeSec ?? ADD_MAX_AGE_SEC)) return { ok: false, reason: "not recent" };
  const keys = keysOf(tx);
  const payer = keys[0];
  if (!payer) return { ok: false, reason: "no payer" };
  let depositor = payer;
  if (opts.relays.includes(payer)) {
    const others = keys.slice(0, tx.transaction.message.header.numRequiredSignatures).filter((k) => !opts.relays.includes(k));
    if (others.length !== 1) return { ok: false, reason: "no depositor" };
    depositor = others[0]!;
  }
  const pool = instructions(tx, keys).filter((x) => x.program === SHIELDED_POOL_PROGRAM);
  if (pool.length !== 1 || pool[0]!.tag !== DEPOSIT) return { ok: false, reason: "not one deposit" };
  const tokens = tokenMoves(tx, keys);
  const lamports = lamportMoves(tx, keys);
  const rises = poolMoves(tokens, lamports).filter((m) => m.delta > 0n);
  if (rises.length !== 1) return { ok: false, reason: "not one asset" };
  const inn = rises[0]!;
  const listed = ringsAssets("mainnet").find((a) => (a.mint ?? RINGS_SOL_MINT) === inn.mint);
  if (!listed) return { ok: false, reason: "not listed" };
  const from =
    inn.mint === RINGS_SOL_MINT
      ? -(lamports.get(depositor) ?? 0n)
      : -tokens.filter((t) => t.mint === inn.mint && t.owner === depositor).reduce((a, t) => a + t.delta, 0n);
  if (from < inn.delta) return { ok: false, reason: "not from the depositor" };
  return { ok: true, event: { sig, k: "add", ts, slot: tx.slot, w: depositor, m: inn.mint, v: String(inn.delta), d: listed.decimals } };
}

/** A transaction signature: base58, 64 bytes. */
export function isSignature(v: unknown): v is string {
  if (typeof v !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(v)) return false;
  try {
    return getBase58Encoder().encode(v).length === 64;
  } catch {
    return false;
  }
}
