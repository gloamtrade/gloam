import "server-only";

/**
 * Bringing USDC in with CCTP, server side (the routes under
 * /api/starknet/cctp): reading Circle's attestation service, and the relay's
 * receive, the one transaction lib/starknetPrivacy/cctp checkCctpReceive allows.
 *
 * What stops the relay paying for someone else's mint, in order:
 *  - the shape (checkCctpReceive): a signed USDC burn from a listed source to a
 *    Gloam account, bundled with that account's own signed outside execution
 *    that pays the relay its fee from the minted USDC in the same transaction;
 *  - the chain: the account is deployed with Gloam's account class (only Gloam
 *    opens those, and only through the relay), the message's nonce is unused,
 *    it hasn't expired, Circle's two contracts are still the classes Gloam
 *    checked;
 *  - the cost: the relay estimates the whole transaction first. A message that
 *    won't mint, an outside execution that isn't the account's own, or a fee it
 *    can't pay fails there, and nothing is sent. An estimate above
 *    STARKNET_CCTP_MAX_STRK pauses rather than pays;
 *  - the counts: per IP and for everyone a day (fail closed on mainnet), and
 *    one send per message nonce.
 *
 * Environment (names only):
 *  - STARKNET_CCTP_FEE: what one receive pays the relay, in whole USDC (default
 *    STARKNET_RELAY_FEE). On mainnet, with neither set, bringing money in is off.
 *  - STARKNET_CCTP_PER_DAY, STARKNET_CCTP_PER_IP_PER_DAY: receives a day, for
 *    everyone and per IP (defaults 200 and 10 on mainnet, 5,000 and 50 elsewhere).
 *  - STARKNET_CCTP_MAX_STRK: the most STRK one receive may cost the relay
 *    (default 10; one cost about 3 STRK on mainnet on 2026-11-27).
 */
import { Account, RpcProvider, num, type Call } from "starknet";
import { SharedCountUnavailable, addRateCount, clientIp } from "@/lib/mcpRemote/rateLimit";
import { kv1 } from "@/lib/partnersKv";
import { sameStarknetAddress, type StarknetNetwork, type StarknetNetworkConfig } from "./config";
import {
  CCTP_SOURCES,
  CCTP_STARKNET_DOMAIN,
  checkCctpReceive,
  feeBpsFrom,
  irisMessageFrom,
  nonceCalldata,
  receiveMessageCall,
  type CctpReceiveDecision,
  type IrisMessage,
  type StarknetCctp,
} from "./cctp";
import { relayAmounts, relayChain, relayMoves, wholeToBase, withRelayLock, type RelayChain } from "./server";

type Env = Record<string, string | undefined>;

export type CctpSettings = {
  /** Base units of the network's first token (USDC). */
  fee: bigint;
  /** Mainnet with no fee set: the relay doesn't bring money in. */
  feeUnset: boolean;
  perDay: number;
  perIpPerDay: number;
  maxStrk: bigint;
};

const countFrom = (v: string | undefined): number | null => (/^\d{1,9}$/.test((v ?? "").trim()) ? Number(v!.trim()) : null);

export function cctpSettings(network: StarknetNetwork, decimals = 6, env: Env = process.env): CctpSettings {
  const main = network === "mainnet";
  const set = wholeToBase(env.STARKNET_CCTP_FEE, decimals) ?? wholeToBase(env.STARKNET_RELAY_FEE, decimals);
  return {
    fee: set ?? 0n,
    feeUnset: main && (set === null || set === 0n),
    perDay: countFrom(env.STARKNET_CCTP_PER_DAY) ?? (main ? 200 : 5_000),
    perIpPerDay: countFrom(env.STARKNET_CCTP_PER_IP_PER_DAY) ?? (main ? 10 : 50),
    maxStrk: wholeToBase(env.STARKNET_CCTP_MAX_STRK, 18) ?? 10n * 10n ** 18n,
  };
}

// ------------------------------------------------------------------ Circle's attestation service

const IRIS_TIMEOUT_MS = 10_000;

/** One GET to Iris (Circle allows 40 a second; Gloam's own limits sit far below). */
export async function irisGet(cctp: Pick<StarknetCctp, "iris">, path: string, fetcher: typeof fetch = fetch): Promise<{ status: number; json: unknown }> {
  const res = await fetcher(`${cctp.iris}${path}`, { headers: { accept: "application/json" }, cache: "no-store", signal: AbortSignal.timeout(IRIS_TIMEOUT_MS) });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

/** The burn to Starknet in source transaction `tx` on `domain`: pending, signed, or null (Iris doesn't know it, or it doesn't go to Starknet). */
export async function irisBurn(cctp: Pick<StarknetCctp, "iris">, domain: number, tx: string, fetcher: typeof fetch = fetch): Promise<IrisMessage | null> {
  const r = await irisGet(cctp, `/v2/messages/${domain}?transactionHash=${encodeURIComponent(tx)}`, fetcher);
  // Iris answers 404 until it has seen the burn.
  if (r.status === 404) return { status: "pending" };
  if (r.status !== 200) throw new Error(`Circle answered ${r.status}.`);
  return irisMessageFrom(r.json, CCTP_STARKNET_DOMAIN);
}

/** Ask Circle to sign a fast transfer's message again (a new expiration), by its nonce. */
export async function irisReattest(cctp: Pick<StarknetCctp, "iris">, nonce: string, fetcher: typeof fetch = fetch): Promise<boolean> {
  const res = await fetcher(`${cctp.iris}/v2/reattest/${encodeURIComponent(nonce)}`, { method: "POST", cache: "no-store", signal: AbortSignal.timeout(IRIS_TIMEOUT_MS) });
  return res.ok;
}

/** Circle's fast transfer fee from each listed source to Starknet, in basis points; null where it didn't answer. Held 5 minutes. */
let feeCache: { at: number; iris: string; fees: Record<number, number | null> } | null = null;
export async function cctpFastFees(cctp: Pick<StarknetCctp, "iris">, fetcher: typeof fetch = fetch, now = Date.now()): Promise<Record<number, number | null>> {
  if (feeCache && feeCache.iris === cctp.iris && now - feeCache.at < 5 * 60_000) return feeCache.fees;
  const entries = await Promise.all(
    CCTP_SOURCES.map(async (s) => {
      try {
        const r = await irisGet(cctp, `/v2/burn/USDC/fees/${s.domain}/${CCTP_STARKNET_DOMAIN}`, fetcher);
        return [s.domain, r.status === 200 ? feeBpsFrom(r.json, 1000) : null] as const;
      } catch {
        return [s.domain, null] as const;
      }
    })
  );
  const fees = Object.fromEntries(entries) as Record<number, number | null>;
  feeCache = { at: now, iris: cctp.iris, fees };
  return fees;
}

// ------------------------------------------------------------------ limits

export type CctpRate = "ok" | "limited" | "day_used" | "unavailable";

const DAY = 86_400;

/** One more look at Iris from this IP (the page polls every few seconds while it waits). */
export const CCTP_LOOKS_PER_IP_PER_MIN = 40;

export async function cctpLookRate(req: Request, now = Date.now()): Promise<boolean> {
  try {
    return (await addRateCount(clientIp(req), "sn-cctp-look", 1, now)) <= CCTP_LOOKS_PER_IP_PER_MIN;
  } catch {
    return false;
  }
}

/** One more receive, charged once it passed every check. */
export async function cctpReceiveRate(req: Request, settings: CctpSettings, network: StarknetNetwork, now = Date.now()): Promise<CctpRate> {
  const strict = { failClosed: network === "mainnet" };
  try {
    if ((await addRateCount(clientIp(req), "sn-cctp-receive", 1, now, DAY, strict)) > settings.perIpPerDay) return "limited";
    if ((await addRateCount("all", "sn-cctp-receive-all", 1, now, DAY, strict)) > settings.perDay) return "day_used";
    return "ok";
  } catch (e) {
    return e instanceof SharedCountUnavailable ? "unavailable" : "limited";
  }
}

// ------------------------------------------------------------------ the receive

/** What the receive reads on chain before sending, and sends: injectable for tests. */
export type CctpChain = Pick<RelayChain, "classHashAt" | "send"> & {
  nonceUsed(messageTransmitter: string, nonce: string): Promise<boolean>;
  blockNumber(): Promise<number>;
  /** The whole transaction's cost in STRK (FRI); throws when it wouldn't run. */
  estimate(calls: Call[]): Promise<bigint>;
};

export const starknetCctpChains = {
  make: (upstream: string, keys: { address: string; secret: string }): CctpChain => cctpChain(upstream, keys),
};

export function cctpChain(upstream: string, keys: { address: string; secret: string }): CctpChain {
  const base = relayChain(upstream, keys);
  const provider = new RpcProvider({ nodeUrl: upstream, batch: 0 });
  const account = new Account({ provider, address: keys.address, signer: keys.secret, cairoVersion: "1" });
  return {
    classHashAt: base.classHashAt,
    send: (calls) => base.send(calls),
    async nonceUsed(mt, nonce) {
      const r = await provider.callContract({ contractAddress: mt, entrypoint: "is_nonce_used", calldata: nonceCalldata(nonce) });
      return BigInt(r[0] ?? "0x0") !== 0n;
    },
    blockNumber: () => provider.getBlockNumber(),
    async estimate(calls) {
      const fee = await account.estimateInvokeFee(calls, { blockIdentifier: "pre_confirmed" });
      return BigInt(fee.overall_fee);
    },
  };
}

/** Blocks of margin before a message's expiration: the relay won't send one that may expire before it lands. */
export const CCTP_EXPIRY_MARGIN_BLOCKS = 30n;
/** One send per message nonce for this long (a second copy would revert and still cost the relay STRK). */
export const CCTP_SENT_TTL_S = 900;

export type CctpReceiveResult =
  | { ok: true; txHash: string; decision: Extract<CctpReceiveDecision, { ok: true }> }
  | { ok: false; status: number; code: string; message: string };

const short = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").slice(0, 200);

async function markSent(nonce: string): Promise<boolean> {
  try {
    return (await kv1(["SET", `gloam:starknet:v1:cctp-sent:${num.toHex(BigInt(nonce))}`, "1", "NX", "EX", CCTP_SENT_TTL_S])) === "OK";
  } catch {
    return true;
  }
}
async function unmarkSent(nonce: string): Promise<void> {
  await kv1(["DEL", `gloam:starknet:v1:cctp-sent:${num.toHex(BigInt(nonce))}`]).catch(() => {});
}

/**
 * Check a receive against the rules and the chain, then send it as one
 * transaction: [receive_message, the account's outside execution].
 */
export async function cctpReceiveSend(input: {
  message: string;
  attestation: string;
  outside: Call;
  cfg: StarknetNetworkConfig;
  cctp: StarknetCctp;
  relay: string;
  chain: CctpChain;
  env?: Env;
  now?: number;
  rate: () => Promise<CctpRate>;
  lockWaitMs?: number;
}): Promise<CctpReceiveResult> {
  const { cfg, cctp, chain } = input;
  const token = cfg.tokens.find((t) => sameStarknetAddress(t.address, cctp.usdc));
  if (!cfg.pool || !token) return { ok: false, status: 503, code: "cctp_off", message: "Bringing money in to Starknet isn't on here." };
  const settings = cctpSettings(cfg.network, token.decimals, input.env);
  if (settings.feeUnset || relayMoves(cfg, input.env) === "off") return { ok: false, status: 503, code: "fee_unset", message: "Gloam's relay isn't set to bring money in to Starknet yet." };
  const maxApprove = relayAmounts(cfg, input.env).maxApprove[num.toHex(BigInt(token.address))] ?? 0n;
  const now = input.now ?? Date.now();
  const decision = checkCctpReceive(
    { message: input.message, attestation: input.attestation, outside: input.outside },
    { cctp, relay: input.relay, pool: cfg.pool, now: Math.floor(now / 1000), minFee: settings.fee, maxApprove }
  );
  if (!decision.ok) return { ok: false, status: 422, code: "not_relayable", message: `Gloam's relay doesn't send this: ${decision.reason}.` };

  const unavailable: CctpReceiveResult = { ok: false, status: 502, code: "upstream_unavailable", message: "Starknet is slow to answer. Try again." };
  // Circle's contracts can be upgraded by Circle: until Gloam checks a new class, nothing is sent to them.
  if (cctp.classHashes) {
    const [mt, tmm] = await Promise.all([chain.classHashAt(cctp.messageTransmitter), chain.classHashAt(cctp.tokenMessengerMinter)]);
    if (!mt || !tmm) return unavailable;
    if (!sameStarknetAddress(mt, cctp.classHashes.messageTransmitter) || !sameStarknetAddress(tmm, cctp.classHashes.tokenMessengerMinter)) {
      return { ok: false, status: 503, code: "cctp_changed", message: "Bringing money in to Starknet is paused for a moment." };
    }
  }
  const cls = await chain.classHashAt(decision.account);
  if (!cls || !sameStarknetAddress(cls, cfg.accountClassHash)) {
    return { ok: false, status: 422, code: "not_relayable", message: "Gloam's relay only brings money in to an open Gloam account." };
  }
  let used: boolean;
  let head: number;
  try {
    [used, head] = await Promise.all([chain.nonceUsed(cctp.messageTransmitter, decision.nonce), chain.blockNumber()]);
  } catch {
    return unavailable;
  }
  if (used) return { ok: false, status: 409, code: "already_received", message: "That transfer already arrived on Starknet." };
  if (decision.expirationBlock > 0n && decision.expirationBlock <= BigInt(head) + CCTP_EXPIRY_MARGIN_BLOCKS) {
    return { ok: false, status: 409, code: "cctp_expired", message: "Circle's signature for this transfer ran out. Ask Circle to sign it again, then try again." };
  }

  const calls: Call[] = [receiveMessageCall(cctp, input.message, input.attestation), input.outside];
  let cost: bigint;
  try {
    cost = await chain.estimate(calls);
  } catch (e) {
    // It wouldn't run: nothing is sent and the relay pays nothing.
    return { ok: false, status: 422, code: "would_fail", message: `Starknet wouldn't run it: ${short(e)}` };
  }
  if (cost > settings.maxStrk) return { ok: false, status: 503, code: "cost_high", message: "Bringing money in to Starknet is paused for a moment." };

  const rate = await input.rate();
  if (rate === "unavailable") return { ok: false, status: 503, code: "relay_unavailable", message: "Gloam's Starknet relay is paused for a moment. Try again shortly." };
  if (rate === "limited") return { ok: false, status: 429, code: "rate_limited", message: "Too many requests. Try again in a little while." };
  if (rate === "day_used") return { ok: false, status: 503, code: "relay_day_used", message: "Gloam's Starknet relay has brought in all it does today. Try again tomorrow." };

  const out = await withRelayLock(
    input.relay,
    async (): Promise<CctpReceiveResult> => {
      if (!(await markSent(decision.nonce))) return { ok: false, status: 409, code: "already_sent", message: "That was already sent." };
      try {
        const txHash = await chain.send(calls);
        return { ok: true, txHash: num.toHex(BigInt(txHash)), decision };
      } catch (e) {
        await unmarkSent(decision.nonce);
        return { ok: false, status: 502, code: "send_failed", message: `Starknet refused it: ${short(e)}` };
      }
    },
    input.lockWaitMs
  );
  if (out === "busy") return { ok: false, status: 503, code: "relay_busy", message: "Gloam's Starknet relay is busy. Try again in a moment." };
  return out;
}
