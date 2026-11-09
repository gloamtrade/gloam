import type { NextRequest } from "next/server";
import { ApiError, jsonBody, portal } from "@/lib/partnersApi";
import { gloamOriginJson } from "@/lib/partnersAuth";
import { readSettleInput, settleLinkTx } from "@/lib/partnerAttribution";
import { clientIp, hitRateLimit } from "@/lib/mcpRemote/rateLimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** Counts asked for per IP per minute: one per payment or swap a person makes. */
const PER_IP_PER_MIN = 30;

/**
 * POST { chainId, txHash }: a payment, cash out or swap has landed; count it if
 * its spend was registered from a partner's link before it was sent
 * (lib/partnerAttribution). The partner comes from that registration, never from
 * the request, so who asks changes nothing. The server reads the transaction on
 * its chain itself. Only public facts about the transaction are kept; never the
 * caller's IP or wallet. The app sends this and never waits on it.
 */
export async function POST(req: NextRequest) {
  return portal(async () => {
    if (!gloamOriginJson(req)) throw new ApiError(403, "bad_origin", "Report from the Gloam app.");
    const ip = await hitRateLimit(clientIp(req), "partner-attr", PER_IP_PER_MIN);
    if (!ip.allowed) throw new ApiError(429, "rate_limited", "Too many reports from here. Wait a minute.");
    const input = readSettleInput(await jsonBody(req, 256));
    const r = await settleLinkTx(input);
    return { data: { recorded: true, kind: r.kind }, status: 201 };
  });
}
