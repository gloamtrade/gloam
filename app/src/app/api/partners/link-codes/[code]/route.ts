import type { NextRequest } from "next/server";
import { ApiError, limitPortalWrite, portal, sessionWallet } from "@/lib/partnersApi";
import { sameSiteJson } from "@/lib/partnersAuth";
import { getPartnerByOwner } from "@/lib/partners";
import { linkCodeView, revokeLinkCode } from "@/lib/partnerLinks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Revoke one of your codes. Links with it count for nobody from now on; what they counted stays. */
export async function DELETE(req: NextRequest, ctx: { params: Promise<{ code: string }> }) {
  return portal(async () => {
    if (!sameSiteJson(req)) throw new ApiError(403, "bad_origin", "Revoke link codes from the Gloam site.");
    const wallet = sessionWallet(req);
    await limitPortalWrite(wallet);
    const partner = await getPartnerByOwner(wallet);
    if (!partner) throw new ApiError(404, "no_account", "Create your partner account first.");
    const { code } = await ctx.params;
    const revoked = await revokeLinkCode({ code, partnerId: partner.id });
    if (!revoked) throw new ApiError(404, "not_found", "You have no link code like that.");
    return { data: { code: linkCodeView(revoked) } };
  });
}
