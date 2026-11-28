import { NextResponse } from "next/server";
import { num, type Call } from "starknet";
import { readCappedBody } from "@/lib/cspReport";
import { STARKNET_ENABLED, sameStarknetAddress } from "@/lib/starknetPrivacy/config";
import { CCTP_SOURCES, starknetCctp, validAttestation } from "@/lib/starknetPrivacy/cctp";
import { cctpFastFees, cctpReceiveRate, cctpReceiveSend, cctpSettings, starknetCctpChains } from "@/lib/starknetPrivacy/cctpServer";
import { CCTP_DESTINATIONS } from "@/lib/starknetPrivacy/cctpOut";
import { cctpOutFees } from "@/lib/starknetPrivacy/cctpOutServer";
import { relayKeys, relayMoves, serverConfig, starknetRelayAttempt, starknetUpstream } from "@/lib/starknetPrivacy/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 45;

const NO_STORE = { "Cache-Control": "no-store" };
/** A message to Starknet with no hook is 376 bytes and an attestation 130: room for both, little more. */
const MAX_BODY = 16 * 1024;
const MAX_CALLDATA = 64;

const refuse = (status: number, code: string, message: string) => NextResponse.json({ ok: false, error: { code, message } }, { status, headers: NO_STORE });

/**
 * Bringing USDC in to a Gloam private account on Starknet with Circle's CCTP
 * (lib/starknetPrivacy/cctp says how and who pays what).
 *
 * GET: whether it is on, the relay's fee on a receive (and on a cash out's
 * burn), Circle's fast transfer fee from each source (basis points; null where
 * Circle didn't answer), and for each destination of a cash out Circle's fast
 * fee from Starknet and its forwarding fee (base units). POST { message, attestation, outside }: Circle's signed message and
 * the account's outside execution; the relay checks them (lib/starknetPrivacy
 * cctpServer cctpReceiveSend) and sends both as one transaction.
 */
export async function GET() {
  const cfg = serverConfig();
  const cctp = starknetCctp(cfg.network);
  const keys = relayKeys();
  const token = cctp ? cfg.tokens.find((t) => sameStarknetAddress(t.address, cctp.usdc)) : undefined;
  const on = Boolean(STARKNET_ENABLED && cctp && keys && cfg.pool && token);
  const settings = cctpSettings(cfg.network, token?.decimals ?? 6);
  const [fees, out] =
    on && cctp
      ? await Promise.all([cctpFastFees(cctp).catch(() => ({}) as Record<number, number | null>), cctpOutFees(cctp).catch(() => ({}) as Awaited<ReturnType<typeof cctpOutFees>>)])
      : [{}, {} as Awaited<ReturnType<typeof cctpOutFees>>];
  return NextResponse.json(
    {
      ok: true,
      // Off when the relay sends no add (relayMoves): money brought in could only wait on the account.
      on: on && !settings.feeUnset && relayMoves(cfg) === "on",
      network: cfg.network,
      relayer: keys?.address ?? null,
      fee: settings.fee.toString(),
      sources: CCTP_SOURCES.map((s) => ({ domain: s.domain, chainId: s.chainId, fastBps: s.fast ? ((fees as Record<number, number | null>)[s.domain] ?? null) : 0 })),
      destinations: CCTP_DESTINATIONS.map((d) => {
        const f = out[d.domain];
        return { domain: d.domain, chainId: d.chainId, fastBps: f?.fastBps ?? null, forward: f?.forward ? { low: f.forward.low.toString(), med: f.forward.med.toString(), high: f.forward.high.toString() } : null };
      }),
    },
    { headers: NO_STORE }
  );
}

function readOutside(x: unknown): Call | null {
  const o = x as { contractAddress?: unknown; entrypoint?: unknown; calldata?: unknown } | null;
  if (!o || typeof o.contractAddress !== "string" || !/^0x[0-9a-fA-F]{1,64}$/.test(o.contractAddress)) return null;
  if (o.entrypoint !== "execute_from_outside_v2") return null;
  if (!Array.isArray(o.calldata) || o.calldata.length > MAX_CALLDATA) return null;
  if (!o.calldata.every((v) => typeof v === "string" && /^(0x[0-9a-fA-F]{1,64}|\d{1,78})$/.test(v))) return null;
  return { contractAddress: o.contractAddress, entrypoint: o.entrypoint, calldata: (o.calldata as string[]).map((v) => num.toHex(BigInt(v))) };
}

export async function POST(req: Request) {
  if (!STARKNET_ENABLED) return refuse(404, "off", "Starknet is not on here.");
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin") return refuse(403, "forbidden", "Forbidden.");
  const cfg = serverConfig();
  const cctp = starknetCctp(cfg.network);
  const keys = relayKeys();
  if (!keys || !cfg.pool || !cctp) return refuse(503, "cctp_off", "Bringing money in to Starknet isn't on here.");

  let body: { message?: unknown; attestation?: unknown; outside?: unknown };
  try {
    const text = await readCappedBody(req, MAX_BODY);
    if (text === null) return refuse(413, "too_large", "That request is too large.");
    body = JSON.parse(text) as typeof body;
  } catch {
    return refuse(400, "bad_request", "Send { message, attestation, outside }.");
  }
  const message = typeof body?.message === "string" && /^0x[0-9a-fA-F]{2,4096}$/.test(body.message) ? body.message.toLowerCase() : null;
  const attestation = typeof body?.attestation === "string" && validAttestation(body.attestation) ? body.attestation.toLowerCase() : null;
  const outside = readOutside(body?.outside);
  if (!message || !attestation || !outside) return refuse(400, "bad_request", "Send { message, attestation, outside }.");

  const attempt = await starknetRelayAttempt(req);
  if (attempt === "unavailable") return refuse(503, "relay_unavailable", "Gloam's Starknet relay is paused for a moment. Try again shortly.");
  if (attempt === "limited") return refuse(429, "rate_limited", "Too many requests. Try again in a little while.");

  const token = cfg.tokens.find((t) => sameStarknetAddress(t.address, cctp.usdc));
  const out = await cctpReceiveSend({
    message,
    attestation,
    outside,
    cfg,
    cctp,
    relay: keys.address,
    chain: starknetCctpChains.make(starknetUpstream(cfg), keys),
    rate: () => cctpReceiveRate(req, cctpSettings(cfg.network, token?.decimals ?? 6), cfg.network),
  });
  if (!out.ok) return refuse(out.status, out.code, out.message);
  return NextResponse.json(
    { ok: true, txHash: out.txHash, minted: out.decision.minted.toString(), fee: out.decision.fee.toString(), approved: out.decision.approve.toString() },
    { headers: NO_STORE }
  );
}
