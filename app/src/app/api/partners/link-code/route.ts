import { ApiError, jsonBody, portal } from "@/lib/partnersApi";
import { gloamOriginJson } from "@/lib/partnersAuth";
import { isLinkCodeShape, resolveLinkCode } from "@/lib/partnerLinks";
import { clientIp, hitRateLimit } from "@/lib/mcpRemote/rateLimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Code lookups per IP per minute: a link opens once, so a person never comes near it. */
const LOOKUPS_PER_MIN = 60;

/**
 * POST { code }: the name a live code's partner shows in links ("From Motion"),
 * or null when Gloam has not approved one. The name comes from the partner's
 * account as an admin approved it, never from the link. A POST, so the code stays
 * out of request logs. An unknown, revoked or expired code is a 404 and names
 * nobody. Nothing about the caller is kept.
 */
export async function POST(req: Request) {
  return portal(async () => {
    if (!gloamOriginJson(req)) throw new ApiError(403, "bad_origin", "Ask from the Gloam app.");
    const rate = await hitRateLimit(clientIp(req), "partner-link", LOOKUPS_PER_MIN);
    if (!rate.allowed) throw new ApiError(429, "rate_limited", "Too many lookups from here. Wait a minute.");
    const body = await jsonBody(req, 256);
    if (Object.keys(body).some((key) => key !== "code") || !isLinkCodeShape(body.code)) {
      throw new ApiError(400, "bad_code", "That is not a partner link code.");
    }
    const r = await resolveLinkCode(body.code);
    if (!r) throw new ApiError(404, "code_not_live", "That link code is not live.");
    return { data: { name: r.partner.approvedName ?? null } };
  });
}
