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
 *    tokens, withdrawn inside the proof (default 0: no fee).
 *  - STARKNET_MAX_POOL_FEE: the most STRK the relay lets the pool take per
 *    apply_actions, in whole STRK (default 10). Mainnet's pool asked 4.5 on
 *    2026-11-26; above the cap the relay pauses instead of paying.
 */
import { Account, RpcProvider, num, type Call } from "starknet";
import { SharedCountUnavailable, addRateCount, clientIp } from "@/lib/mcpRemote/rateLimit";
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

export async function starknetProxyRate(req: Request, calls: number, now = Date.now()): Promise<{ allowed: boolean; retryAfterSec: number }> {
  const retryAfterSec = Math.max(1, 60 - (Math.floor(now / 1000) % 60));
  const mine = await addRateCount(clientIp(req), "sn-proxy", calls, now);
  if (mine > STARKNET_PROXY_PER_IP_PER_MIN) return { allowed: false, retryAfterSec };
  const all = await addRateCount("all", "sn-proxy-all", calls, now);
  return { allowed: all <= STARKNET_PROXY_ALL_PER_MIN, retryAfterSec };
}

/**
 * The relay's limits. A deploy is the dearest call (the relay pays an account's
 * deploy), so it is held tightest. A proof is held per minute and per day per
 * IP. On mainnet the daily counts fail closed: without the shared count the
 * relay pays nothing and says it is unavailable.
 */
export const STARKNET_RELAY_LIMITS = {
  attempt: { perIpPerMin: 30 },
  deploy: { perIpPerDay: 5, allPerDay: 300 },
  /** An account's open pays the relay no fee (it has nothing to pay from): held like a deploy. */
  open: { perIpPerDay: 5, allPerDay: 300 },
  transact: { perIpPerMin: 10, perIpPerDay: 200, allPerMin: 120, allPerDay: 5_000 },
  prove: { perIpPerMin: 10, perIpPerDay: 300 },
} as const;

export type RelayRateKind = "deploy" | "open" | "transact";

const DAY = 86_400;

/** The clock the limits count by (self-tests hold it still across a burst). */
export const starknetRelayClock = { now: (): number => Date.now() };

export type StarknetRate = "ok" | "limited" | "unavailable";

async function counted(f: () => Promise<boolean>): Promise<StarknetRate> {
  try {
    return (await f()) ? "ok" : "limited";
  } catch (e) {
    return e instanceof SharedCountUnavailable ? "unavailable" : "limited";
  }
}

/** One more try at the relay from this IP, before any node read. */
export function starknetRelayAttempt(req: Request, now = starknetRelayClock.now()): Promise<StarknetRate> {
  return counted(async () => (await addRateCount(clientIp(req), "sn-relay-try", 1, now)) <= STARKNET_RELAY_LIMITS.attempt.perIpPerMin);
}

/** One more relayed transaction of `kind`, charged once it passed every check. */
export function starknetRelayRate(req: Request, kind: RelayRateKind, now = starknetRelayClock.now(), network: StarknetNetwork = STARKNET_NETWORK): Promise<StarknetRate> {
  const ip = clientIp(req);
  const strict = { failClosed: network === "mainnet" };
  return counted(async () => {
    if (kind === "deploy" || kind === "open") {
      const l = STARKNET_RELAY_LIMITS[kind];
      // A local devnet's STRK is free: its deploys and opens are held only by the overall count.
      const perIp = network === "devnet" ? l.allPerDay : l.perIpPerDay;
      if ((await addRateCount(ip, `sn-relay-${kind}`, 1, now, DAY, strict)) > perIp) return false;
      return (await addRateCount("all", `sn-relay-${kind}-all`, 1, now, DAY, strict)) <= l.allPerDay;
    }
    const t = STARKNET_RELAY_LIMITS.transact;
    if ((await addRateCount(ip, "sn-relay-tx", 1, now)) > t.perIpPerMin) return false;
    if ((await addRateCount(ip, "sn-relay-tx-day", 1, now, DAY, strict)) > t.perIpPerDay) return false;
    if ((await addRateCount("all", "sn-relay-tx-all", 1, now)) > t.allPerMin) return false;
    return (await addRateCount("all", "sn-relay-tx-all-day", 1, now, DAY, strict)) <= t.allPerDay;
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

/** The relay's node reads and its account, over `upstream`. */
export function relayChain(upstream: string, keys: { address: string; secret: string }): RelayChain {
  const provider = new RpcProvider({ nodeUrl: upstream, batch: 0 });
  const account = new Account({ provider, address: keys.address, signer: keys.secret, cairoVersion: "1" });
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
      const r = await account.execute(calls, proof ? { proofFacts: proof.proofFacts as string[], proof: proof.proof } : {});
      return r.transaction_hash;
    },
  };
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
 * only from a Gloam account; the pool still the class it was pinned to, its
 * STRK fee under the cap, a deposit's screening attestation fresh), then send
 * it. `rate` charges the day's buckets only once everything else passed.
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
}): Promise<RelaySendResult> {
  const { cfg, chain } = input;
  const decision = checkRelayCall(input.calls, relayContext(cfg, input.relay, input.env, input.now), input.proof);
  if (!decision.ok) return { ok: false, status: 422, code: "not_relayable", message: `Gloam's relay doesn't send this: ${decision.reason}.` };
  if (decision.kind === "approve") {
    const cls = await chain.classHashAt(decision.account);
    if (!cls || !sameStarknetAddress(cls, cfg.accountClassHash)) return { ok: false, status: 422, code: "not_relayable", message: "Gloam's relay only sends for a Gloam account." };
  }
  let send = input.calls;
  if (decision.kind === "apply") {
    if (cfg.poolClassHash) {
      const cls = await chain.classHashAt(cfg.pool!);
      if (!cls) return { ok: false, status: 502, code: "upstream_unavailable", message: "Starknet is slow to answer. Try again." };
      // The pool's owner can change its code at once: a new class waits for Gloam to check it.
      if (!sameStarknetAddress(cls, cfg.poolClassHash)) return { ok: false, status: 503, code: "pool_changed", message: "Private payments on Starknet are paused for a moment." };
      // The canonical pool takes a screening attestation with a deposit and refuses one without.
      const nowS = Math.floor((input.now ?? Date.now()) / 1000);
      if (decision.deposits > 0 && decision.attestedAt === null) return { ok: false, status: 422, code: "screening_missing", message: "Starknet's deposit check didn't come back. Try again." };
      if (decision.deposits === 0 && decision.attestedAt !== null) return { ok: false, status: 422, code: "not_relayable", message: "Gloam's relay doesn't send this: unexpected_screening." };
      if (decision.attestedAt !== null && nowS - decision.attestedAt > SCREENING_SEND_WINDOW_S) {
        return { ok: false, status: 409, code: "screening_expired", message: "That took too long to send. Try again." };
      }
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
  const kind: RelayRateKind = decision.kind === "deploy" ? "deploy" : decision.kind === "apply" && decision.setup ? "open" : "transact";
  const rate = await input.rate(kind);
  if (rate === "unavailable") return { ok: false, status: 503, code: "relay_unavailable", message: "Gloam's Starknet relay is paused for a moment. Try again shortly." };
  if (rate === "limited") return { ok: false, status: 429, code: "rate_limited", message: "Too many requests. Try again in a little while." };
  try {
    const txHash = await chain.send(send, input.proof);
    return { ok: true, txHash: num.toHex(BigInt(txHash)), decision };
  } catch (e) {
    // The node's reason, cut short; never the relay's key or the request.
    const why = e instanceof Error ? e.message.replace(/\s+/g, " ").slice(0, 240) : "send failed";
    return { ok: false, status: 502, code: "send_failed", message: `Starknet refused it: ${why}` };
  }
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

/** The network this deployment serves. */
export function serverConfig(env: Env = process.env): StarknetNetworkConfig {
  return starknetConfig(STARKNET_NETWORK, env);
}
