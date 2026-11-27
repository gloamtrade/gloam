import "server-only";

/**
 * Gloam's Starknet relay and proxies, server side (the routes under
 * /api/starknet). The relay's key, the upstream node and the prover's key stay
 * here; the browser only ever talks to Gloam's routes.
 *
 * Environment (names only; values are set in the deployment, never in a file):
 *  - GLOAM_STARKNET_RELAYER_SECRET: the relay account's Stark private key (hex).
 *  - GLOAM_STARKNET_RELAYER_ADDRESS: the relay account's address. Both or neither.
 *  - STARKNET_RPC_URL: the node the routes read and send through (defaults to
 *    the network's public node, lib/starknetPrivacy/config).
 *  - STARKNET_PROVER_URL: a proving service that speaks the SDK's protocol
 *    (StarkWare's transaction prover run for Sepolia, say).
 *  - STARKSCAN_API_KEY: Starkscan's prover relay, mainnet (prove scope on it).
 *  - STARKSCAN_DAILY_PROOFS: that key's proofs a UTC day (default 10).
 *  - STARKNET_MAX_APPROVE: the most one approve may allow, in whole tokens (default 10,000).
 *  - STARKNET_RELAY_FEE: what each proven transaction pays the relay, in whole
 *    tokens, withdrawn inside the proof (default 0: no fee). On mainnet a move
 *    (an add, a payment, a cash out) must pay it: with no fee set, the relay
 *    refuses every move and its approve (fee_unset) unless
 *    STARKNET_SPONSORED_MOVES_PER_DAY says how many it pays for.
 *  - STARKNET_SPONSORED_MOVES_PER_DAY: mainnet only, the moves a day the relay
 *    sends without a fee, for everyone (default 0: none). Counted in Redis;
 *    without it, none are sent.
 *  - STARKNET_APPLIES_PER_DAY: the moves a day the relay sends, for everyone,
 *    fee or not (default 200 on mainnet, 5,000 elsewhere).
 *  - STARKNET_OPENS_PER_DAY, STARKNET_OPENS_PER_IP_PER_DAY: account opens a
 *    day, for everyone and per IP (defaults 20 and 5 on mainnet, 300 and 5
 *    elsewhere). An open pays no fee, so these are what it can cost.
 *  - STARKNET_MAX_POOL_FEE: the most STRK the relay lets the pool take per
 *    apply_actions, in whole STRK (default 10). Mainnet's pool asked 4.5 on
 *    2026-11-26; above the cap the relay pauses instead of paying.
 */
import { createHash, randomBytes } from "crypto";
import { Account, RpcProvider, num, type Call } from "starknet";
import { SharedCountUnavailable, addRateCount, clientIp, hitBatchedCount, hitRateLimit, type RateResult } from "@/lib/mcpRemote/rateLimit";
import { kv1 } from "@/lib/partnersKv";
import { STARKNET_NETWORK, STARKNET_STRK, sameStarknetAddress, starknetConfig, type StarknetNetwork, type StarknetNetworkConfig } from "./config";
import { accountAddress } from "./account";
import { checkRelayCall, type RelayContext, type RelayDecision, type RelayProof } from "./relayPolicy";
import type { StarkscanAdmit, StarkscanRounds } from "./starkscanProver";

type Env = Record<string, string | undefined>;

const HEX = /^0x[0-9a-fA-F]{1,64}$/;

/** The node the routes use: STARKNET_RPC_URL, else the network's public node. */
export function starknetUpstream(cfg: StarknetNetworkConfig, env: Env = process.env): string {
  const u = (env.STARKNET_RPC_URL ?? "").trim();
  return /^https?:\/\/\S+$/.test(u) ? u.replace(/\/+$/, "") : cfg.rpcUrl;
}

/** The relay's address and key, or null when either is missing or malformed. */
export function relayKeys(env: Env = process.env): { address: string; secret: string } | null {
  const address = (env.GLOAM_STARKNET_RELAYER_ADDRESS ?? "").trim();
  const secret = (env.GLOAM_STARKNET_RELAYER_SECRET ?? "").trim();
  if (!HEX.test(address) || !HEX.test(secret)) return null;
  if (BigInt(secret) === 0n) return null;
  return { address: num.toHex(BigInt(address)), secret };
}

/** Whole tokens (a decimal string) to base units; null when not a plain positive number. */
export function wholeToBase(text: string | undefined, decimals: number): bigint | null {
  const t = (text ?? "").trim();
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  const [w, f = ""] = t.split(".");
  if (f.length > decimals) return null;
  return BigInt(w!) * 10n ** BigInt(decimals) + BigInt((f + "0".repeat(decimals)).slice(0, decimals) || "0");
}

/** Per token: the most an approve may allow, and the relay's fee (0 = none). */
export function relayAmounts(cfg: StarknetNetworkConfig, env: Env = process.env): { maxApprove: Record<string, bigint>; fee: Record<string, bigint> } {
  const maxApprove: Record<string, bigint> = {};
  const fee: Record<string, bigint> = {};
  for (const t of cfg.tokens) {
    const k = num.toHex(BigInt(t.address));
    maxApprove[k] = wholeToBase(env.STARKNET_MAX_APPROVE, t.decimals) ?? 10_000n * 10n ** BigInt(t.decimals);
    fee[k] = wholeToBase(env.STARKNET_RELAY_FEE, t.decimals) ?? 0n;
  }
  return { maxApprove, fee };
}

/** The relay context relayPolicy checks every call against. */
export function relayContext(cfg: StarknetNetworkConfig, relay: string, env: Env = process.env, now = Date.now()): RelayContext {
  const { maxApprove, fee } = relayAmounts(cfg, env);
  return { cfg, relay, now: Math.floor(now / 1000), maxApprove, minFee: fee };
}

/**
 * The relay is "low" below this much STRK: it says it is paused rather than fail
 * sends. On mainnet one proven move cost the relay about 7 STRK on 2026-11-26
 * (the pool's 4.5 STRK fee and about 2.5 STRK of gas), so this is a few moves.
 */
export const STARKNET_RELAY_LOW_STRK: Record<StarknetNetwork, bigint> = {
  mainnet: 30n * 10n ** 18n,
  sepolia: 1n * 10n ** 18n,
  devnet: 1n,
};

// ------------------------------------------------------------------ limits

/** Per-minute limits for the RPC proxy, per IP and for everyone. */
export const STARKNET_PROXY_PER_IP_PER_MIN = 600;
export const STARKNET_PROXY_ALL_PER_MIN = 20_000;

/**
 * How the proxy's counts reach Redis (hitBatchedCount): every read used to cost
 * four Upstash commands (INCRBY and EXPIRE, per IP and for everyone). Now each
 * instance sends an IP's count once it holds 15 unsent calls, and everyone's
 * once it holds 100 or ten seconds have passed; an IP or a minute already used
 * is refused in memory. Each instance may let through at most `slack` calls
 * (and one batch) past a limit before it learns of it: 2.5% of an IP's 600, 0.5%
 * of everyone's 20,000. Nothing reads these counts, so the time only keeps
 * everyone's count in Redis close to the truth.
 */
export const STARKNET_PROXY_SYNC = {
  perIp: { slack: 15, syncMs: 60_000 },
  all: { slack: 100, syncMs: 10_000 },
} as const;

export async function starknetProxyRate(req: Request, calls: number, now = Date.now()): Promise<{ allowed: boolean; retryAfterSec: number }> {
  const mine = await hitBatchedCount(clientIp(req), "sn-proxy", calls, STARKNET_PROXY_PER_IP_PER_MIN, STARKNET_PROXY_SYNC.perIp, now);
  if (!mine.allowed) return { allowed: false, retryAfterSec: mine.retryAfterSec };
  const all = await hitBatchedCount("all", "sn-proxy-all", calls, STARKNET_PROXY_ALL_PER_MIN, STARKNET_PROXY_SYNC.all, now);
  return { allowed: all.allowed, retryAfterSec: all.retryAfterSec };
}

/**
 * The relay's limits. A deploy is the dearest call (the relay pays an account's
 * deploy), so it is held tightest. A proof is held per minute and per day per
 * IP. On mainnet the daily counts fail closed: without the shared count the
 * relay pays nothing and says it is unavailable. What a day of opens and moves
 * may cost on mainnet is set by relayCaps.
 */
export const STARKNET_RELAY_LIMITS = {
  attempt: { perIpPerMin: 30 },
  deploy: { perIpPerDay: 5, allPerDay: 300 },
  /** An account's open pays the relay no fee (it has nothing to pay from): held like a deploy (relayCaps). */
  open: { perIpPerDay: 5, allPerDay: 300 },
  transact: { perIpPerMin: 10, perIpPerDay: 200, allPerMin: 120, allPerDay: 5_000 },
  prove: { perIpPerMin: 10, perIpPerDay: 300 },
} as const;

/**
 * What a relayed transaction is counted as: a deploy, an account's open, an
 * approve, a move that pays the relay's fee, or a move the relay pays for
 * (mainnet, STARKNET_SPONSORED_MOVES_PER_DAY).
 */
export type RelayRateKind = "deploy" | "open" | "approve" | "move" | "sponsored";

/**
 * The relay's daily caps that bound what it spends. Each mainnet open or move
 * costs it about 7 STRK (the pool's 4.5 STRK fee and gas, 2026-11-26), and
 * StarkWare's transaction prover is a public image, so anyone can prove an open
 * or a move and hand it to the relay. On mainnet: 20 opens a day (5 per IP),
 * 200 moves a day, and no move without the relay's fee unless sponsored.
 */
export type RelayCaps = { opensPerIpPerDay: number; opensPerDay: number; appliesPerDay: number; sponsoredPerDay: number };

const MAINNET_CAPS = { opensPerDay: 20, appliesPerDay: 200 } as const;

/** A whole number from the environment (0 allowed), or null when unset or not one. */
function countFrom(v: string | undefined): number | null {
  const t = (v ?? "").trim();
  if (!/^\d{1,9}$/.test(t)) return null;
  return Number(t);
}

export function relayCaps(network: StarknetNetwork, env: Env = process.env): RelayCaps {
  const main = network === "mainnet";
  return {
    opensPerIpPerDay: countFrom(env.STARKNET_OPENS_PER_IP_PER_DAY) ?? STARKNET_RELAY_LIMITS.open.perIpPerDay,
    opensPerDay: countFrom(env.STARKNET_OPENS_PER_DAY) ?? (main ? MAINNET_CAPS.opensPerDay : STARKNET_RELAY_LIMITS.open.allPerDay),
    appliesPerDay: countFrom(env.STARKNET_APPLIES_PER_DAY) ?? (main ? MAINNET_CAPS.appliesPerDay : STARKNET_RELAY_LIMITS.transact.allPerDay),
    // Sponsored moves are a mainnet budget: elsewhere a move with no fee goes as before.
    sponsoredPerDay: main ? (countFrom(env.STARKNET_SPONSORED_MOVES_PER_DAY) ?? 0) : 0,
  };
}

const DAY = 86_400;

/** The clock the limits count by (self-tests hold it still across a burst). */
export const starknetRelayClock = { now: (): number => Date.now() };

/** "limited": this IP's count is used; "day_used": everyone's count for the day is. */
export type StarknetRate = "ok" | "limited" | "day_used" | "unavailable";

async function counted(f: () => Promise<boolean | StarknetRate>): Promise<StarknetRate> {
  try {
    const r = await f();
    return r === true ? "ok" : r === false ? "limited" : r;
  } catch (e) {
    return e instanceof SharedCountUnavailable ? "unavailable" : "limited";
  }
}

/** One more try at the relay from this IP, before any node read. */
export function starknetRelayAttempt(req: Request, now = starknetRelayClock.now()): Promise<StarknetRate> {
  return counted(async () => (await addRateCount(clientIp(req), "sn-relay-try", 1, now)) <= STARKNET_RELAY_LIMITS.attempt.perIpPerMin);
}

/** One more relayed transaction of `kind`, charged once it passed every check. */
export function starknetRelayRate(
  req: Request,
  kind: RelayRateKind,
  now = starknetRelayClock.now(),
  network: StarknetNetwork = STARKNET_NETWORK,
  env: Env = process.env
): Promise<StarknetRate> {
  const ip = clientIp(req);
  const strict = { failClosed: network === "mainnet" };
  const caps = relayCaps(network, env);
  return counted(async () => {
    if (kind === "deploy" || kind === "open") {
      const l = kind === "open" ? { perIpPerDay: caps.opensPerIpPerDay, allPerDay: caps.opensPerDay } : STARKNET_RELAY_LIMITS.deploy;
      // A local devnet's STRK is free: its deploys and opens are held only by the overall count.
      const perIp = network === "devnet" ? l.allPerDay : l.perIpPerDay;
      if ((await addRateCount(ip, `sn-relay-${kind}`, 1, now, DAY, strict)) > perIp) return false;
      return (await addRateCount("all", `sn-relay-${kind}-all`, 1, now, DAY, strict)) <= l.allPerDay || "day_used";
    }
    const t = STARKNET_RELAY_LIMITS.transact;
    if ((await addRateCount(ip, "sn-relay-tx", 1, now)) > t.perIpPerMin) return false;
    if ((await addRateCount(ip, "sn-relay-tx-day", 1, now, DAY, strict)) > t.perIpPerDay) return false;
    if ((await addRateCount("all", "sn-relay-tx-all", 1, now)) > t.allPerMin) return false;
    if ((await addRateCount("all", "sn-relay-tx-all-day", 1, now, DAY, strict)) > t.allPerDay) return "day_used";
    if (kind === "approve") return true;
    // Every move, fee or not, under the day's cap for everyone; one the relay pays for under its own.
    if ((await addRateCount("all", "sn-relay-move-all-day", 1, now, DAY, strict)) > caps.appliesPerDay) return "day_used";
    if (kind === "sponsored" && (await addRateCount("all", "sn-relay-sponsored-all-day", 1, now, DAY, { failClosed: true })) > caps.sponsoredPerDay) return "day_used";
    return true;
  });
}

/**
 * Where /api/starknet/prove keeps each request body's Starkscan round
 * (lib/starknetPrivacy/starkscanProver): Redis when set, so a retry that lands
 * on another instance finds the same job; this process otherwise.
 */
export function starkscanRounds(now = () => starknetRelayClock.now()): StarkscanRounds {
  return {
    get: (digest) => addRateCount(digest, "sn-prove-round", 0, now(), DAY),
    next: (digest) => addRateCount(digest, "sn-prove-round", 1, now(), DAY),
  };
}

/**
 * New Starkscan jobs, each one proof out of Gloam's key's daily budget
 * (STARKSCAN_DAILY_PROOFS, default 10, what Starkscan provisioned on
 * 2026-11-26). The request limits above count every call, retries and polls of
 * one job included, and sit far above that budget, so one caller could spend
 * the whole day's proofs in a minute. These count only keys Starkscan hasn't
 * seen yet: per IP a day, and for everyone a day, so the route says "busy"
 * itself once the day is used instead of asking Starkscan again.
 */
export const STARKNET_PROVE_JOBS = { perIpPerDay: 5 } as const;

export function starkscanDailyProofs(env: Env = process.env): number {
  const n = Number((env.STARKSCAN_DAILY_PROOFS ?? "").trim());
  return Number.isSafeInteger(n) && n > 0 ? n : 10;
}

/** What /api/starknet/prove asks before each Starkscan submit (lib/starknetPrivacy/starkscanProver). */
export function starkscanAdmit(req: Request, now = () => starknetRelayClock.now(), network: StarknetNetwork = STARKNET_NETWORK, env: Env = process.env): StarkscanAdmit {
  const ip = clientIp(req);
  const strict = { failClosed: network === "mainnet" };
  return async (key) => {
    try {
      const t = now();
      // A key already sent is the same job (Starkscan answers it again for free).
      if ((await addRateCount(key, "sn-prove-key", 0, t, DAY, strict)) > 0) return "ok";
      if ((await addRateCount(ip, "sn-prove-job", 1, t, DAY, strict)) > STARKNET_PROVE_JOBS.perIpPerDay) return "limited";
      if ((await addRateCount("all", "sn-prove-job-all", 1, t, DAY, strict)) > starkscanDailyProofs(env)) return "quota";
      await addRateCount(key, "sn-prove-key", 1, t, DAY, strict);
      return "ok";
    } catch (e) {
      return e instanceof SharedCountUnavailable ? "unavailable" : "limited";
    }
  };
}

/** One more proof from this IP. */
export function starknetProveRate(req: Request, now = starknetRelayClock.now(), network: StarknetNetwork = STARKNET_NETWORK): Promise<StarknetRate> {
  const ip = clientIp(req);
  const p = STARKNET_RELAY_LIMITS.prove;
  return counted(async () => {
    if ((await addRateCount(ip, "sn-prove", 1, now)) > p.perIpPerMin) return false;
    return (await addRateCount(ip, "sn-prove-day", 1, now, DAY, { failClosed: network === "mainnet" })) <= p.perIpPerDay;
  });
}

// ------------------------------------------------------------------ the relay

export type RelaySendResult = { ok: true; txHash: string; decision: Exclude<RelayDecision, { ok: false }> } | { ok: false; status: number; code: string; message: string };

/** What the relay reads on chain before sending: injectable for tests. */
export type RelayChain = {
  classHashAt(address: string): Promise<string | null>;
  poolFeeAmount(pool: string): Promise<bigint>;
  send(calls: Call[], proof?: RelayProof): Promise<string>;
};

/**
 * How the relay route reaches the chain: relayChain, unless a self-test swaps
 * in a fake one (scripts/selftest-starknet-routes.mts). Nothing else sets it.
 */
export const starknetRelayChains = { make: (upstream: string, keys: { address: string; secret: string }): RelayChain => relayChain(upstream, keys) };

/** How long a send waits for the node to count it before the next send may read the nonce. */
export const RELAY_NONCE_WAIT_MS = 12_000;

/**
 * The relay's node reads and its account, over `upstream`. A send reads the
 * relay's nonce at the pre-confirmed block (what the sequencer has already run,
 * not only the last sealed block: starknet.js reads "latest" by default, so a
 * second send within a block of the first took the same nonce and was
 * refused), estimates there, and then waits until the node counts it, so the
 * next send, under relaySend's lock, reads the next nonce.
 */
export function relayChain(upstream: string, keys: { address: string; secret: string }, waitMs = RELAY_NONCE_WAIT_MS): RelayChain {
  const provider = new RpcProvider({ nodeUrl: upstream, batch: 0 });
  const account = new Account({ provider, address: keys.address, signer: keys.secret, cairoVersion: "1" });
  const nonceAt = async (tag: "pre_confirmed" | "latest") => BigInt(await provider.getNonceForAddress(keys.address, tag));
  return {
    async classHashAt(address) {
      try {
        return num.toHex(BigInt(await provider.getClassHashAt(address)));
      } catch {
        return null;
      }
    },
    async poolFeeAmount(pool) {
      const r = await provider.callContract({ contractAddress: pool, entrypoint: "get_fee_amount", calldata: [] });
      return BigInt(r[0] ?? "0x0");
    },
    async send(calls, proof) {
      let tag: "pre_confirmed" | "latest" = "pre_confirmed";
      let nonce: bigint;
      try {
        nonce = await nonceAt(tag);
      } catch {
        tag = "latest";
        nonce = await nonceAt(tag);
      }
      const r = await account.execute(calls, { ...(proof ? { proofFacts: proof.proofFacts as string[], proof: proof.proof } : {}), nonce, blockIdentifier: tag });
      const until = Date.now() + waitMs;
      while (Date.now() < until) {
        if ((await nonceAt(tag).catch(() => nonce)) > nonce) break;
        await new Promise((res) => setTimeout(res, 250));
      }
      return r.transaction_hash;
    },
  };
}

/**
 * The node's own reason for refusing a send (starknet.js puts the whole
 * request first, which pushed the reason past any cut), short.
 */
export function sendFailure(e: unknown): string {
  const base = (e as { baseError?: { code?: unknown; message?: unknown; data?: unknown } } | null)?.baseError;
  let why: string;
  if (base && typeof base.message === "string") {
    const data = base.data === undefined ? "" : typeof base.data === "string" ? base.data : JSON.stringify(base.data);
    why = `${typeof base.code === "number" ? `${base.code}: ` : ""}${base.message}${data ? `: ${data}` : ""}`;
  } else why = e instanceof Error ? e.message : "send failed";
  return why.replace(/\s+/g, " ").slice(0, 240);
}

// ------------------------------------------------------------------ one send at a time

/** How long a send may hold the relay's lock before it lapses on its own, and how long the next one waits for it. */
export const RELAY_LOCK_TTL_S = 30;
export const RELAY_LOCK_WAIT_MS = 20_000;
/** A call already sent is refused for this long (a second copy would revert and still cost the relay STRK). */
export const RELAY_SENT_TTL_S = 900;

const relayKey = (...parts: string[]) => `gloam:starknet:v1:${parts.join(":")}`;
const localQueues = new Map<string, Promise<unknown>>();

/**
 * Run `fn` as the relay's only send: one at a time in this process, and across
 * instances under a lock in the shared store (Redis in production). The relay
 * is one account, so two sends at once read the same nonce and one is refused.
 * Without the shared store (a local run) the process queue alone holds it.
 * "busy" when the lock stays taken past `waitMs`.
 */
export async function withRelayLock<T>(relay: string, fn: () => Promise<T>, waitMs = RELAY_LOCK_WAIT_MS): Promise<T | "busy"> {
  const id = num.toHex(BigInt(relay));
  const prev = localQueues.get(id) ?? Promise.resolve();
  let done!: () => void;
  const mine = new Promise<void>((r) => (done = r));
  const queued = prev.then(() => mine);
  localQueues.set(id, queued);
  try {
    await prev;
    const lock = relayKey("relay-lock", id);
    const token = randomBytes(12).toString("hex");
    const deadline = Date.now() + waitMs;
    let shared = true;
    for (;;) {
      let got: unknown;
      try {
        got = await kv1(["SET", lock, token, "NX", "EX", RELAY_LOCK_TTL_S]);
      } catch {
        // No shared store here: the process queue holds the sends of this instance.
        shared = false;
        break;
      }
      if (got === "OK") break;
      if (Date.now() >= deadline) return "busy";
      await new Promise((r) => setTimeout(r, 150));
    }
    try {
      return await fn();
    } finally {
      if (shared && (await kv1(["GET", lock]).catch(() => null)) === token) await kv1(["DEL", lock]).catch(() => {});
    }
  } finally {
    done();
    if (localQueues.get(id) === queued) localQueues.delete(id);
  }
}

/** Mark `calls` (with their proof) as sent; false when they already were, within RELAY_SENT_TTL_S. */
async function markSent(digest: string): Promise<boolean> {
  try {
    return (await kv1(["SET", relayKey("sent", digest), "1", "NX", "EX", RELAY_SENT_TTL_S])) === "OK";
  } catch {
    return true;
  }
}

async function unmarkSent(digest: string): Promise<void> {
  await kv1(["DEL", relayKey("sent", digest)]).catch(() => {});
}

function sendDigest(calls: Call[], proof?: RelayProof): string {
  const h = createHash("sha256");
  for (const c of calls) h.update(`${num.toHex(BigInt(c.contractAddress))}|${c.entrypoint}|${((c.calldata ?? []) as string[]).map((x) => num.toHex(BigInt(x))).join(",")};`);
  if (proof) h.update(`|${proof.proofFacts.map((x) => num.toHex(BigInt(x))).join(",")}`);
  return h.digest("hex").slice(0, 40);
}

/** Most STRK the relay lets the pool take per apply_actions, base units. */
export function maxPoolFee(env: Env = process.env): bigint {
  return wholeToBase(env.STARKNET_MAX_POOL_FEE, 18) ?? 10n * 10n ** 18n;
}

/**
 * A deposit's screening attestation must be at most this old when the relay
 * sends it: the pool takes one under 300 seconds old at the block it lands in
 * (DEPOSITOR_VALIDATION_MAX_AGE), and the rest is for inclusion.
 */
export const SCREENING_SEND_WINDOW_S = 240;

const U128 = 1n << 128n;

/**
 * The apply call as the relay sends it: when the pool asks a STRK fee, between
 * STRK.approve(pool, exactly that fee) and STRK.approve(pool, 0), in one
 * transaction, so the pool can take that fee from the relay and nothing more.
 */
export function withPoolFee(apply: Call, pool: string, fee: bigint): Call[] {
  if (fee <= 0n) return [apply];
  const approve = (amount: bigint): Call => ({
    contractAddress: STARKNET_STRK,
    entrypoint: "approve",
    calldata: [num.toHex(BigInt(pool)), num.toHex(amount % U128), num.toHex(amount / U128)],
  });
  return [approve(fee), apply, approve(0n)];
}

/**
 * Check a proposed call against the relay's rules, then the chain (an approve
 * only from a Gloam account; for an apply or an approve the pool still the
 * class it was pinned to; its STRK fee under the cap, a deposit's screening
 * attestation fresh), then send it, one send at a time (withRelayLock) and
 * never the same call twice. `rate` charges the day's buckets only once
 * everything else passed.
 */
export async function relaySend(input: {
  calls: Call[];
  proof?: RelayProof;
  cfg: StarknetNetworkConfig;
  relay: string;
  chain: RelayChain;
  env?: Env;
  now?: number;
  rate: (kind: RelayRateKind) => Promise<StarknetRate>;
  /** How long to wait for another send to finish (withRelayLock). */
  lockWaitMs?: number;
}): Promise<RelaySendResult> {
  const { cfg, chain } = input;
  const ctx = relayContext(cfg, input.relay, input.env, input.now);
  const decision = checkRelayCall(input.calls, ctx, input.proof);
  if (!decision.ok) return { ok: false, status: 422, code: "not_relayable", message: `Gloam's relay doesn't send this: ${decision.reason}.` };
  // On mainnet a move pays the relay's fee: with none set, the relay would pay about 7 STRK for any
  // proven move, anyone's. It sends one only within a sponsored budget, and no approve (step one of an
  // add) it couldn't follow. An account's open owes no fee and has its own cap.
  const move = decision.kind === "approve" || (decision.kind === "apply" && !decision.setup);
  const feeAsked = Object.values(ctx.minFee ?? {}).some((v) => v > 0n);
  const sponsored = cfg.network === "mainnet" && move && !feeAsked;
  if (sponsored && relayMoves(cfg, input.env) === "off") {
    return { ok: false, status: 503, code: "fee_unset", message: "Gloam's relay isn't set to send private moves on Starknet yet." };
  }
  // The pool's owner can change its code at once: until Gloam checks a new class nothing reaches the
  // pool, and no approve lets the changed pool take an account's tokens either.
  if ((decision.kind === "apply" || decision.kind === "approve") && cfg.poolClassHash) {
    const cls = await chain.classHashAt(cfg.pool!);
    if (!cls) return { ok: false, status: 502, code: "upstream_unavailable", message: "Starknet is slow to answer. Try again." };
    if (!sameStarknetAddress(cls, cfg.poolClassHash)) return { ok: false, status: 503, code: "pool_changed", message: "Private payments on Starknet are paused for a moment." };
  }
  if (decision.kind === "approve") {
    const cls = await chain.classHashAt(decision.account);
    if (!cls || !sameStarknetAddress(cls, cfg.accountClassHash)) return { ok: false, status: 422, code: "not_relayable", message: "Gloam's relay only sends for a Gloam account." };
  }
  const stale = () => decision.kind === "apply" && decision.attestedAt !== null && Math.floor((input.now ?? Date.now()) / 1000) - decision.attestedAt > SCREENING_SEND_WINDOW_S;
  const expired: RelaySendResult = { ok: false, status: 409, code: "screening_expired", message: "That took too long to send. Try again." };
  let send = input.calls;
  if (decision.kind === "apply") {
    if (cfg.poolClassHash) {
      // The canonical pool takes a screening attestation with a deposit and refuses one without.
      if (decision.deposits > 0 && decision.attestedAt === null) return { ok: false, status: 422, code: "screening_missing", message: "Starknet's deposit check didn't come back. Try again." };
      if (decision.deposits === 0 && decision.attestedAt !== null) return { ok: false, status: 422, code: "not_relayable", message: "Gloam's relay doesn't send this: unexpected_screening." };
      if (stale()) return expired;
    }
    let fee: bigint;
    try {
      fee = await chain.poolFeeAmount(cfg.pool!);
    } catch {
      return { ok: false, status: 502, code: "upstream_unavailable", message: "Starknet is slow to answer. Try again." };
    }
    if (fee > maxPoolFee(input.env)) return { ok: false, status: 503, code: "pool_fee_high", message: "Private payments on Starknet are paused for a moment." };
    send = withPoolFee(input.calls[0]!, cfg.pool!, fee);
  }
  if (decision.kind === "deploy") {
    // Already deployed: nothing to pay for.
    const cls = await chain.classHashAt(accountAddress(decision.publicKey, cfg.accountClassHash));
    if (cls) return { ok: false, status: 409, code: "already_deployed", message: "That account is already set up." };
  }
  const kind: RelayRateKind =
    decision.kind === "deploy" ? "deploy" : decision.kind === "approve" ? "approve" : decision.setup ? "open" : sponsored ? "sponsored" : "move";
  const rate = await input.rate(kind);
  if (rate === "unavailable") return { ok: false, status: 503, code: "relay_unavailable", message: "Gloam's Starknet relay is paused for a moment. Try again shortly." };
  if (rate === "limited") return { ok: false, status: 429, code: "rate_limited", message: "Too many requests. Try again in a little while." };
  if (rate === "day_used") return { ok: false, status: 503, code: "relay_day_used", message: "Gloam's Starknet relay has sent all it sends today. Try again tomorrow." };

  const digest = sendDigest(input.calls, input.proof);
  const out = await withRelayLock(
    input.relay,
    async (): Promise<RelaySendResult> => {
      // The wait for the lock counts against a deposit's attestation too.
      if (cfg.poolClassHash && stale()) return expired;
      // A second copy of a call already sent would revert, and the relay would still pay for it.
      if (!(await markSent(digest))) return { ok: false, status: 409, code: "already_sent", message: "That was already sent." };
      try {
        const txHash = await chain.send(send, input.proof);
        return { ok: true, txHash: num.toHex(BigInt(txHash)), decision };
      } catch (e) {
        await unmarkSent(digest);
        // The node's reason, cut short; never the relay's key.
        return { ok: false, status: 502, code: "send_failed", message: `Starknet refused it: ${sendFailure(e)}` };
      }
    },
    input.lockWaitMs
  );
  if (out === "busy") return { ok: false, status: 503, code: "relay_busy", message: "Gloam's Starknet relay is busy. Try again in a moment." };
  return out;
}

/** The relay's STRK, to say whether it can pay. */
export async function relayStrk(upstream: string, relay: string): Promise<bigint | null> {
  try {
    const provider = new RpcProvider({ nodeUrl: upstream, batch: 0 });
    const r = await provider.callContract({ contractAddress: STARKNET_STRK, entrypoint: "balance_of", calldata: [relay] });
    return BigInt(r[0] ?? "0x0");
  } catch {
    return null;
  }
}

/**
 * How long one instance keeps the relay's STRK for GET /api/starknet/relay
 * (each page load and each move reads it), and a failed read, so a slow node
 * isn't asked again by every caller. Callers at the same moment share one read.
 */
export const RELAY_STRK_CACHE_MS = 20_000;
export const RELAY_STRK_MISS_MS = 5_000;
let strkCache: { key: string; at: number; ms: number; value: Promise<bigint | null> } | null = null;

/** relayStrk, read at most once per RELAY_STRK_CACHE_MS on this instance. */
export function relayStrkCached(upstream: string, relay: string, now = starknetRelayClock.now()): Promise<bigint | null> {
  const key = `${upstream}|${relay}`;
  if (strkCache && strkCache.key === key && now - strkCache.at < strkCache.ms) return strkCache.value;
  const entry = { key, at: now, ms: RELAY_STRK_CACHE_MS, value: relayStrk(upstream, relay) };
  void entry.value.then((v) => {
    if (v === null) entry.ms = RELAY_STRK_MISS_MS;
  });
  strkCache = entry;
  return entry.value;
}

/** GET /api/starknet/relay per IP a minute, counted on each instance (no Redis call). */
export const STARKNET_RELAY_INFO_PER_IP_PER_MIN = 60;

export function starknetRelayInfoRate(req: Request, now = starknetRelayClock.now()): Promise<RateResult> {
  return hitRateLimit(clientIp(req), "sn-relay-info", STARKNET_RELAY_INFO_PER_IP_PER_MIN, now);
}

/**
 * Whether the relay sends moves (an add, a payment, a cash out) at all. On
 * mainnet a move needs the relay's fee (STARKNET_RELAY_FEE) or a sponsored
 * budget (STARKNET_SPONSORED_MOVES_PER_DAY): with neither, relaySend refuses
 * every one (fee_unset), so GET says "off" and the page stops before it proves.
 * An account's open owes no fee and is not a move.
 */
export function relayMoves(cfg: StarknetNetworkConfig, env: Env = process.env): "on" | "off" {
  if (cfg.network !== "mainnet") return "on";
  const feeAsked = Object.values(relayAmounts(cfg, env).fee).some((v) => v > 0n);
  return feeAsked || relayCaps(cfg.network, env).sponsoredPerDay > 0 ? "on" : "off";
}

/** The network this deployment serves. */
export function serverConfig(env: Env = process.env): StarknetNetworkConfig {
  return starknetConfig(STARKNET_NETWORK, env);
}
