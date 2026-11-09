import type { NextRequest } from "next/server";
import { ApiError, jsonBody, limitPortalWrite, portal, sessionWallet } from "@/lib/partnersApi";
import { hitRateLimit } from "@/lib/mcpRemote/rateLimit";
import { sameSiteJson } from "@/lib/partnersAuth";
import { getPartnerByOwner } from "@/lib/partners";
import { issueLinkCode, linkCodeView, listLinkCodes, MAX_CODES, MAX_LIVE_CODES } from "@/lib/partnerLinks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function ownPartner(req: NextRequest, write = false) {
  const wallet = sessionWallet(req);
  if (write) await limitPortalWrite(wallet);
  const partner = await getPartnerByOwner(wallet);
  if (!partner) throw new ApiError(404, "no_account", "Create your partner account first.");
  return partner;
}

/** Code lists per wallet per minute: the portal reads it on load and after each change. */
const LISTS_PER_MIN = 30;

/** The signed-in partner's link codes, revoked and expired ones still on record included. */
export async function GET(req: NextRequest) {
  return portal(async () => {
    const wallet = sessionWallet(req);
    if (!(await hitRateLimit(`wallet:${wallet.toLowerCase()}`, "partner-codes", LISTS_PER_MIN)).allowed) {
      throw new ApiError(429, "rate_limited", "Too many reads in a minute. Wait a moment.");
    }
    const partner = await ownPartner(req);
    const now = Date.now();
    return { data: { codes: (await listLinkCodes(partner.id)).map((c) => linkCodeView(c, now)), maxLive: MAX_LIVE_CODES, maxCodes: MAX_CODES } };
  });
}

/** { label?, expiresInDays? }: a new link code for pay and swap links (`p=<code>`). */
export async function POST(req: NextRequest) {
  return portal(async () => {
    if (!sameSiteJson(req)) throw new ApiError(403, "bad_origin", "Make link codes from the Gloam site.");
    const partner = await ownPartner(req, true);
    const body = await jsonBody(req, 1024);
    const code = await issueLinkCode({ partnerId: partner.id, label: body.label, expiresInDays: body.expiresInDays, by: "partner" });
    return { data: { code: linkCodeView(code) }, status: 201 };
  });
}
