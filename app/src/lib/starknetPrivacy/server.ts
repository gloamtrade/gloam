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
 *  - STARKNET_MAX_APPROVE: the most one approve may allow, in whole tokens (default 10,000).
 *  - STARKNET_RELAY_FEE: what each proven transaction pays the relay, in whole
 *    tokens, withdrawn inside the proof (default 0: no fee).
 */
import { Account, RpcProvider, num, type Call } from "starknet";
import { SharedCountUnavailable, addRateCount, clientIp } from "@/lib/mcpRemote/rateLimit";
import { STARKNET_NETWORK, STARKNET_STRK, sameStarknetAddress, starknetConfig, type StarknetNetwork, type StarknetNetworkConfig } from "./config";
import { accountAddress } from "./account";
import { checkRelayCall, type RelayContext, type RelayDecision, type RelayProof } from "./relayPolicy";

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

/** The relay is "low" below this much STRK: it says it is paused rather than fail sends. */
export const STARKNET_RELAY_LOW_STRK: Record<StarknetNetwork, bigint> = {
  mainnet: 5n * 10n ** 18n,
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
  transact: { perIpPerMin: 10, perIpPerDay: 200, allPerMin: 120, allPerDay: 5_000 },
  prove: { perIpPerMin: 10, perIpPerDay: 300 },
} as const;

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
export function starknetRelayRate(req: Request, kind: "deploy" | "transact", now = starknetRelayClock.now(), network: StarknetNetwork = STARKNET_NETWORK): Promise<StarknetRate> {
  const ip = clientIp(req);
  const strict = { failClosed: network === "mainnet" };
  return counted(async () => {
    if (kind === "deploy") {
      if ((await addRateCount(ip, "sn-relay-deploy", 1, now, DAY, strict)) > STARKNET_RELAY_LIMITS.deploy.perIpPerDay) return false;
      return (await addRateCount("all", "sn-relay-deploy-all", 1, now, DAY, strict)) <= STARKNET_RELAY_LIMITS.deploy.allPerDay;
    }
    const t = STARKNET_RELAY_LIMITS.transact;
    if ((await addRateCount(ip, "sn-relay-tx", 1, now)) > t.perIpPerMin) return false;
    if ((await addRateCount(ip, "sn-relay-tx-day", 1, now, DAY, strict)) > t.perIpPerDay) return false;
    if ((await addRateCount("all", "sn-relay-tx-all", 1, now)) > t.allPerMin) return false;
    return (await addRateCount("all", "sn-relay-tx-all-day", 1, now, DAY, strict)) <= t.allPerDay;
  });
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

/**
 * Check a proposed call against the relay's rules, then the chain (an approve
 * only from a Gloam account; a pool whose own STRK fee is off), then send it.
 * `rate` charges the day's buckets only once everything else passed.
 */
export async function relaySend(input: {
  calls: Call[];
  proof?: RelayProof;
  cfg: StarknetNetworkConfig;
  relay: string;
  chain: RelayChain;
  env?: Env;
  now?: number;
  rate: (kind: "deploy" | "transact") => Promise<StarknetRate>;
}): Promise<RelaySendResult> {
  const { cfg, chain } = input;
  const decision = checkRelayCall(input.calls, relayContext(cfg, input.relay, input.env, input.now), input.proof);
  if (!decision.ok) return { ok: false, status: 422, code: "not_relayable", message: `Gloam's relay doesn't send this: ${decision.reason}.` };
  if (decision.kind === "approve") {
    const cls = await chain.classHashAt(decision.account);
    if (!cls || !sameStarknetAddress(cls, cfg.accountClassHash)) return { ok: false, status: 422, code: "not_relayable", message: "Gloam's relay only sends for a Gloam account." };
  }
  if (decision.kind === "apply") {
    let fee: bigint;
    try {
      fee = await chain.poolFeeAmount(cfg.pool!);
    } catch {
      return { ok: false, status: 502, code: "upstream_unavailable", message: "Starknet is slow to answer. Try again." };
    }
    if (fee !== 0n) return { ok: false, status: 503, code: "pool_fee_on", message: "Private payments on Starknet are paused for a moment." };
  }
  if (decision.kind === "deploy") {
    // Already deployed: nothing to pay for.
    const cls = await chain.classHashAt(accountAddress(decision.publicKey, cfg.accountClassHash));
    if (cls) return { ok: false, status: 409, code: "already_deployed", message: "That account is already set up." };
  }
  const rate = await input.rate(decision.kind === "deploy" ? "deploy" : "transact");
  if (rate === "unavailable") return { ok: false, status: 503, code: "relay_unavailable", message: "Gloam's Starknet relay is paused for a moment. Try again shortly." };
  if (rate === "limited") return { ok: false, status: 429, code: "rate_limited", message: "Too many requests. Try again in a little while." };
  try {
    const txHash = await chain.send(input.calls, input.proof);
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
