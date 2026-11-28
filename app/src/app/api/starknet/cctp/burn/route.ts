import { NextResponse } from "next/server";
import { num, type Call } from "starknet";
import { readCappedBody } from "@/lib/cspReport";
import { STARKNET_ENABLED } from "@/lib/starknetPrivacy/config";
import { starknetCctp } from "@/lib/starknetPrivacy/cctp";
import { starknetCctpChains } from "@/lib/starknetPrivacy/cctpServer";
import { cctpBurnSend, cctpOutRate } from "@/lib/starknetPrivacy/cctpOutServer";
import { relayKeys, serverConfig, starknetRelayAttempt, starknetRelayRate, starknetUpstream } from "@/lib/starknetPrivacy/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 45;

const NO_STORE = { "Cache-Control": "no-store" };
/** A proven call carries its proof: room for one, nothing much more. */
const MAX_BODY = 2 * 1024 * 1024;
const MAX_CALLDATA = 4_096;
const MAX_OUTSIDE = 64;
const MAX_FACTS = 64;
const HEX = /^0x[0-9a-fA-F]{1,64}$/;
const FELT = /^(0x[0-9a-fA-F]{1,64}|\d{1,78})$/;

const refuse = (status: number, code: string, message: string) => NextResponse.json({ ok: false, error: { code, message } }, { status, headers: NO_STORE });

function readCall(x: unknown, entrypoint: string, max: number): Call | null {
  const o = x as { contractAddress?: unknown; entrypoint?: unknown; calldata?: unknown } | null;
  if (!o || typeof o.contractAddress !== "string" || !HEX.test(o.contractAddress) || o.entrypoint !== entrypoint) return null;
  if (!Array.isArray(o.calldata) || o.calldata.length > max || !o.calldata.every((v) => typeof v === "string" && FELT.test(v))) return null;
  return { contractAddress: o.contractAddress, entrypoint, calldata: (o.calldata as string[]).map((v) => num.toHex(BigInt(v))) };
}

/**
 * A cash out from Starknet to another chain (lib/starknetPrivacy/cctpOut):
 * POST { apply, proof, deploy, outside }. `apply` is the proven cash out to a
 * one-time account, `deploy` that account's public key (or null when it is
 * deployed already), `outside` its signed burn with Circle's forwarding. The
 * relay checks all of it (cctpOutServer cctpBurnSend) and sends it as one
 * transaction; it answers the transaction hash.
 */
export async function POST(req: Request) {
  if (!STARKNET_ENABLED) return refuse(404, "off", "Starknet is not on here.");
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin") return refuse(403, "forbidden", "Forbidden.");
  const cfg = serverConfig();
  const cctp = starknetCctp(cfg.network);
  const keys = relayKeys();
  if (!keys || !cfg.pool || !cctp) return refuse(503, "cctp_off", "Cashing out to other networks isn't on here.");

  let body: { apply?: unknown; proof?: unknown; deploy?: unknown; outside?: unknown };
  try {
    const text = await readCappedBody(req, MAX_BODY);
    if (text === null) return refuse(413, "too_large", "That request is too large.");
    body = JSON.parse(text) as typeof body;
  } catch {
    return refuse(400, "bad_request", "Send { apply, proof, deploy, outside }.");
  }
  const apply = readCall(body?.apply, "apply_actions", MAX_CALLDATA);
  const outside = readCall(body?.outside, "execute_from_outside_v2", MAX_OUTSIDE);
  const p = body?.proof as { proofFacts?: unknown; proof?: unknown } | undefined;
  const proof =
    p && Array.isArray(p.proofFacts) && p.proofFacts.length > 0 && p.proofFacts.length <= MAX_FACTS && p.proofFacts.every((v) => typeof v === "string" && HEX.test(v)) && typeof p.proof === "string" && /^[A-Za-z0-9+/=]*$/.test(p.proof)
      ? { proofFacts: p.proofFacts as string[], proof: p.proof }
      : null;
  const deploy = body?.deploy === null ? null : typeof body?.deploy === "string" && HEX.test(body.deploy) ? body.deploy : undefined;
  if (!apply || !outside || !proof || deploy === undefined) return refuse(400, "bad_request", "Send { apply, proof, deploy, outside }.");

  const attempt = await starknetRelayAttempt(req);
  if (attempt === "unavailable") return refuse(503, "relay_unavailable", "Gloam's Starknet relay is paused for a moment. Try again shortly.");
  if (attempt === "limited") return refuse(429, "rate_limited", "Too many requests. Try again in a little while.");

  const out = await cctpBurnSend({
    apply,
    proof,
    deploy,
    outside,
    cfg,
    cctp,
    relay: keys.address,
    chain: starknetCctpChains.make(starknetUpstream(cfg), keys),
    rate: () => starknetRelayRate(req, "move"),
    outRate: () => cctpOutRate(req, cfg.network),
  });
  if (!out.ok) return refuse(out.status, out.code, out.message);
  return NextResponse.json({ ok: true, txHash: out.txHash, domain: out.decision.domain, recipient: out.decision.recipient }, { headers: NO_STORE });
}
