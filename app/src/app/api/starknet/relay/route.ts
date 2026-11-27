import { NextResponse } from "next/server";
import { num, type Call } from "starknet";
import { readCappedBody } from "@/lib/cspReport";
import { STARKNET_ENABLED } from "@/lib/starknetPrivacy/config";
import {
  STARKNET_RELAY_LOW_STRK,
  relayAmounts,
  relayKeys,
  relayMoves,
  relaySend,
  relayStrkCached,
  serverConfig,
  starknetRelayAttempt,
  starknetRelayChains,
  starknetRelayInfoRate,
  starknetRelayRate,
  starknetUpstream,
} from "@/lib/starknetPrivacy/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 45;

const NO_STORE = { "Cache-Control": "no-store" };
/** A proven call carries its proof: room for one, nothing much more. */
const MAX_BODY = 2 * 1024 * 1024;
const MAX_CALLDATA = 4_096;
const MAX_FACTS = 64;

const refuse = (status: number, code: string, message: string) => NextResponse.json({ ok: false, error: { code, message } }, { status, headers: NO_STORE });

/**
 * Gloam's Starknet relay: a private account on Starknet never holds STRK, so
 * Gloam's relay account sends every one of its transactions and pays the fee.
 * GET says whether it is on and funded, whether it sends moves (an add, a
 * payment, a cash out: "off" on mainnet with no fee and no sponsored budget),
 * names its address (proven transactions pay it its fee inside the proof) and
 * the fee; its STRK is read at most every 20 seconds per instance, and each IP
 * may ask 60 times a minute. POST takes one call, checks it
 * against lib/starknetPrivacy/relayPolicy and the chain (lib/starknetPrivacy/server
 * relaySend), counts it, and sends it; it answers with the transaction hash,
 * which the page then follows through /api/starknet/rpc.
 */
export async function GET(req: Request) {
  const rate = await starknetRelayInfoRate(req);
  if (!rate.allowed) {
    return NextResponse.json(
      { ok: false, error: { code: "rate_limited", message: "Too many requests. Try again in a little while." } },
      { status: 429, headers: { ...NO_STORE, "Retry-After": String(rate.retryAfterSec) } }
    );
  }
  const cfg = serverConfig();
  const keys = relayKeys();
  const upstream = starknetUpstream(cfg);
  const strk = keys && STARKNET_ENABLED ? await relayStrkCached(upstream, keys.address) : null;
  const { fee, maxApprove } = relayAmounts(cfg);
  return NextResponse.json(
    {
      ok: true,
      on: Boolean(STARKNET_ENABLED && keys && cfg.pool),
      funded: strk !== null && strk >= STARKNET_RELAY_LOW_STRK[cfg.network],
      moves: relayMoves(cfg),
      relayer: keys?.address ?? null,
      network: cfg.network,
      pool: cfg.pool,
      fee: Object.fromEntries(Object.entries(fee).map(([k, v]) => [k, v.toString()])),
      maxApprove: Object.fromEntries(Object.entries(maxApprove).map(([k, v]) => [k, v.toString()])),
    },
    { headers: NO_STORE }
  );
}

type Body = { calls?: unknown; proof?: unknown };

function readCalls(x: unknown): Call[] | null {
  if (!Array.isArray(x) || x.length !== 1) return null;
  const out: Call[] = [];
  for (const c of x) {
    const o = c as { contractAddress?: unknown; entrypoint?: unknown; calldata?: unknown };
    if (!o || typeof o.contractAddress !== "string" || !/^0x[0-9a-fA-F]{1,64}$/.test(o.contractAddress)) return null;
    if (typeof o.entrypoint !== "string" || !/^[a-z_][a-z0-9_]{0,63}$/.test(o.entrypoint)) return null;
    if (!Array.isArray(o.calldata) || o.calldata.length > MAX_CALLDATA) return null;
    if (!o.calldata.every((v) => typeof v === "string" && /^(0x[0-9a-fA-F]{1,64}|\d{1,78})$/.test(v))) return null;
    out.push({ contractAddress: o.contractAddress, entrypoint: o.entrypoint, calldata: (o.calldata as string[]).map((v) => num.toHex(BigInt(v))) });
  }
  return out;
}

function readProof(x: unknown): { proofFacts: string[]; proof: string } | undefined | null {
  if (x === undefined || x === null) return undefined;
  const p = x as { proofFacts?: unknown; proof?: unknown };
  if (!Array.isArray(p.proofFacts) || p.proofFacts.length === 0 || p.proofFacts.length > MAX_FACTS) return null;
  if (!p.proofFacts.every((v) => typeof v === "string" && /^0x[0-9a-fA-F]{1,64}$/.test(v))) return null;
  if (typeof p.proof !== "string" || !/^[A-Za-z0-9+/=]*$/.test(p.proof)) return null;
  return { proofFacts: p.proofFacts as string[], proof: p.proof };
}

export async function POST(req: Request) {
  if (!STARKNET_ENABLED) return refuse(404, "off", "Starknet is not on here.");
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin") return refuse(403, "forbidden", "Forbidden.");
  const cfg = serverConfig();
  const keys = relayKeys();
  if (!keys || !cfg.pool) return refuse(503, "relay_off", "Gloam's Starknet relay isn't set up yet.");

  let body: Body;
  try {
    const text = await readCappedBody(req, MAX_BODY);
    if (text === null) return refuse(413, "too_large", "That request is too large.");
    body = JSON.parse(text) as Body;
  } catch {
    return refuse(400, "bad_request", "Send { calls, proof }.");
  }
  const calls = readCalls(body.calls);
  const proof = readProof(body.proof);
  if (!calls || proof === null) return refuse(400, "bad_request", "Send { calls: [one call], proof? }.");

  const attempt = await starknetRelayAttempt(req);
  if (attempt === "unavailable") return refuse(503, "relay_unavailable", "Gloam's Starknet relay is paused for a moment. Try again shortly.");
  if (attempt === "limited") return refuse(429, "rate_limited", "Too many requests. Try again in a little while.");

  const out = await relaySend({
    calls,
    proof,
    cfg,
    relay: keys.address,
    chain: starknetRelayChains.make(starknetUpstream(cfg), keys),
    rate: (kind) => starknetRelayRate(req, kind),
  });
  if (!out.ok) return refuse(out.status, out.code, out.message);
  return NextResponse.json({ ok: true, txHash: out.txHash, kind: out.decision.kind }, { headers: NO_STORE });
}
