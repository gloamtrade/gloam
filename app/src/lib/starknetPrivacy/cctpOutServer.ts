import "server-only";

/**
 * A cash out from Starknet to another chain, server side
 * (lib/starknetPrivacy/cctpOut says the whole transaction): checked against the
 * pool's own rules (relayPolicy checkRelayCall on the proven apply) and the
 * burn's (cctpOut checkCctpBurn), then against the chain, then sent as one
 * transaction: [STRK.approve(pool, its fee), apply_actions, STRK.approve(pool,
 * 0), the one-time account's deploy, its outside execution].
 *
 * Why it can't drain the relay: the apply is a proven cash out that pays the
 * relay its usual fee inside the proof, and the burn pays it its burn fee from
 * the money the same transaction withdraws; the relay estimates the whole
 * transaction (proof included) first and sends nothing that wouldn't run, and
 * nothing that would cost it more than the pool's fee cap plus
 * STARKNET_CCTP_MAX_STRK. It counts as a move (the day's caps for moves) and as
 * a cash out to another chain (STARKNET_CCTP_OUT_PER_IP_PER_DAY, default 10 on
 * mainnet). One transaction at a time, never the same one twice.
 */
import { createHash } from "crypto";
import { num, type Call } from "starknet";
import { SharedCountUnavailable, addRateCount, clientIp } from "@/lib/mcpRemote/rateLimit";
import { kv1 } from "@/lib/partnersKv";
import { deployAccountCall } from "./account";
import { CCTP_STARKNET_DOMAIN, type StarknetCctp } from "./cctp";
import { CCTP_DESTINATIONS, checkCctpBurn, forwardFeeFrom, type CctpBurnDecision, type ForwardFee } from "./cctpOut";
import { cctpSettings, irisGet, type CctpChain, type CctpRate } from "./cctpServer";
import { sameStarknetAddress, type StarknetNetwork, type StarknetNetworkConfig } from "./config";
import { checkRelayCall, type RelayProof } from "./relayPolicy";
import { maxPoolFee, relayContext, relayMoves, withPoolFee, withRelayLock, type StarknetRate } from "./server";

type Env = Record<string, string | undefined>;

/** Circle's fast fee and forwarding fee from Starknet to each destination; null where Circle didn't answer. Held 5 minutes. */
let outCache: { at: number; iris: string; fees: Record<number, { fastBps: number | null; forward: ForwardFee | null }> } | null = null;
export async function cctpOutFees(cctp: Pick<StarknetCctp, "iris">, fetcher: typeof fetch = fetch, now = Date.now()): Promise<Record<number, { fastBps: number | null; forward: ForwardFee | null }>> {
  if (outCache && outCache.iris === cctp.iris && now - outCache.at < 5 * 60_000) return outCache.fees;
  const entries = await Promise.all(
    CCTP_DESTINATIONS.map(async (d) => {
      try {
        const r = await irisGet(cctp, `/v2/burn/USDC/fees/${CCTP_STARKNET_DOMAIN}/${d.domain}?forward=true`, fetcher);
        const rows = r.status === 200 && Array.isArray(r.json) ? (r.json as { finalityThreshold?: unknown; minimumFee?: unknown }[]) : [];
        const fast = Number(rows.find((x) => x.finalityThreshold === 1000)?.minimumFee);
        return [d.domain, { fastBps: Number.isFinite(fast) && fast >= 0 && fast <= 100 ? fast : null, forward: forwardFeeFrom(r.json) }] as const;
      } catch {
        return [d.domain, { fastBps: null, forward: null }] as const;
      }
    })
  );
  const fees = Object.fromEntries(entries) as Record<number, { fastBps: number | null; forward: ForwardFee | null }>;
  outCache = { at: now, iris: cctp.iris, fees };
  return fees;
}

const DAY = 86_400;

export function cctpOutPerIpPerDay(network: StarknetNetwork, env: Env = process.env): number {
  const t = (env.STARKNET_CCTP_OUT_PER_IP_PER_DAY ?? "").trim();
  return /^\d{1,9}$/.test(t) ? Number(t) : network === "mainnet" ? 10 : 50;
}

/** One more cash out to another chain from this IP today (fail closed on mainnet). */
export async function cctpOutRate(req: Request, network: StarknetNetwork, env: Env = process.env, now = Date.now()): Promise<CctpRate> {
  try {
    return (await addRateCount(clientIp(req), "sn-cctp-out", 1, now, DAY, { failClosed: network === "mainnet" })) > cctpOutPerIpPerDay(network, env) ? "limited" : "ok";
  } catch (e) {
    return e instanceof SharedCountUnavailable ? "unavailable" : "limited";
  }
}

export type CctpBurnResult =
  | { ok: true; txHash: string; decision: Extract<CctpBurnDecision, { ok: true }> }
  | { ok: false; status: number; code: string; message: string };

const short = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").slice(0, 200);

function digestOf(apply: Call, proof: RelayProof): string {
  const h = createHash("sha256");
  h.update(((apply.calldata ?? []) as string[]).map((x) => num.toHex(BigInt(x))).join(","));
  h.update(`|${proof.proofFacts.map((x) => num.toHex(BigInt(x))).join(",")}`);
  return h.digest("hex").slice(0, 40);
}

export async function cctpBurnSend(input: {
  apply: Call;
  proof: RelayProof;
  /** The one-time account's public key, when this transaction should deploy it. */
  deploy: string | null;
  outside: Call;
  cfg: StarknetNetworkConfig;
  cctp: StarknetCctp;
  relay: string;
  chain: CctpChain;
  env?: Env;
  now?: number;
  /** The day's counts for moves (server starknetRelayRate "move"). */
  rate: () => Promise<StarknetRate>;
  /** This IP's cash outs to other chains today (cctpOutRate). */
  outRate: () => Promise<CctpRate>;
  lockWaitMs?: number;
}): Promise<CctpBurnResult> {
  const { cfg, cctp, chain } = input;
  const token = cfg.tokens.find((t) => sameStarknetAddress(t.address, cctp.usdc));
  if (!cfg.pool || !token) return { ok: false, status: 503, code: "cctp_off", message: "Cashing out to other networks isn't on here." };
  const settings = cctpSettings(cfg.network, token.decimals, input.env);
  if (settings.feeUnset || relayMoves(cfg, input.env) === "off") return { ok: false, status: 503, code: "fee_unset", message: "Gloam's relay isn't set to cash out to other networks yet." };
  const now = input.now ?? Date.now();
  const ctx = relayContext(cfg, input.relay, input.env, now);
  const pool = checkRelayCall([input.apply], ctx, input.proof);
  if (!pool.ok) return { ok: false, status: 422, code: "not_relayable", message: `Gloam's relay doesn't send this: ${pool.reason}.` };
  if (pool.kind !== "apply" || pool.setup || pool.deposits > 0 || pool.attestedAt !== null) return { ok: false, status: 422, code: "not_relayable", message: "Gloam's relay doesn't send this: not_a_cash_out." };
  const burn = checkCctpBurn({ apply: input.apply, deploy: input.deploy, outside: input.outside }, { cctp, relay: input.relay, now: Math.floor(now / 1000), minFee: settings.fee, accountClassHash: cfg.accountClassHash });
  if (!burn.ok) return { ok: false, status: 422, code: "not_relayable", message: `Gloam's relay doesn't send this: ${burn.reason}.` };

  const unavailable: CctpBurnResult = { ok: false, status: 502, code: "upstream_unavailable", message: "Starknet is slow to answer. Try again." };
  const paused = (code: string): CctpBurnResult => ({ ok: false, status: 503, code, message: "Cashing out to other networks is paused for a moment." });
  // The pool and Circle's minter as Gloam checked them; the one-time account fresh (deployed here) or already Gloam's.
  const [poolCls, tmmCls, oneCls] = await Promise.all([
    cfg.poolClassHash ? chain.classHashAt(cfg.pool) : Promise.resolve("skip"),
    cctp.classHashes ? chain.classHashAt(cctp.tokenMessengerMinter) : Promise.resolve("skip"),
    chain.classHashAt(burn.oneTime),
  ]);
  if (!poolCls || !tmmCls) return unavailable;
  if (cfg.poolClassHash && !sameStarknetAddress(poolCls, cfg.poolClassHash)) return paused("pool_changed");
  if (cctp.classHashes && !sameStarknetAddress(tmmCls, cctp.classHashes.tokenMessengerMinter)) return paused("cctp_changed");
  if (input.deploy ? oneCls !== null : !oneCls || !sameStarknetAddress(oneCls, cfg.accountClassHash)) {
    return { ok: false, status: 422, code: "not_relayable", message: "Gloam's relay doesn't send this: one_time_account." };
  }
  let poolFee: bigint;
  try {
    poolFee = await chain.poolFeeAmount(cfg.pool);
  } catch {
    return unavailable;
  }
  if (poolFee > maxPoolFee(input.env)) return paused("pool_fee_high");
  const calls: Call[] = [...withPoolFee(input.apply, cfg.pool, poolFee), ...(input.deploy ? [deployAccountCall(num.toHex(BigInt(input.deploy)), cfg.accountClassHash)] : []), input.outside];
  let cost: bigint;
  try {
    cost = await chain.estimate(calls, input.proof);
  } catch (e) {
    return { ok: false, status: 422, code: "would_fail", message: `Starknet wouldn't run it: ${short(e)}` };
  }
  if (cost > maxPoolFee(input.env) + settings.maxStrk) return paused("cost_high");

  const out = await input.outRate();
  if (out === "unavailable") return { ok: false, status: 503, code: "relay_unavailable", message: "Gloam's Starknet relay is paused for a moment. Try again shortly." };
  if (out !== "ok") return { ok: false, status: 429, code: "rate_limited", message: "That's all the cash outs to other networks for today from here. Try again tomorrow." };
  const rate = await input.rate();
  if (rate === "unavailable") return { ok: false, status: 503, code: "relay_unavailable", message: "Gloam's Starknet relay is paused for a moment. Try again shortly." };
  if (rate === "limited") return { ok: false, status: 429, code: "rate_limited", message: "Too many requests. Try again in a little while." };
  if (rate === "day_used") return { ok: false, status: 503, code: "relay_day_used", message: "Gloam's Starknet relay has sent all it sends today. Try again tomorrow." };

  const key = `gloam:starknet:v1:cctp-out-sent:${digestOf(input.apply, input.proof)}`;
  const sent = await withRelayLock(
    input.relay,
    async (): Promise<CctpBurnResult> => {
      const fresh = await kv1(["SET", key, "1", "NX", "EX", 900]).catch(() => "OK");
      if (fresh !== "OK") return { ok: false, status: 409, code: "already_sent", message: "That was already sent." };
      try {
        const txHash = await chain.send(calls, input.proof);
        return { ok: true, txHash: num.toHex(BigInt(txHash)), decision: burn };
      } catch (e) {
        await kv1(["DEL", key]).catch(() => {});
        return { ok: false, status: 502, code: "send_failed", message: `Starknet refused it: ${short(e)}` };
      }
    },
    input.lockWaitMs
  );
  if (sent === "busy") return { ok: false, status: 503, code: "relay_busy", message: "Gloam's Starknet relay is busy. Try again in a moment." };
  return sent;
}
