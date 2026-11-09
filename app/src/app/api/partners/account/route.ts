import type { NextRequest } from "next/server";
import { ApiError, jsonBody, limitPortalWrite, portal, sessionWallet, takeNewAccount } from "@/lib/partnersApi";
import { sameSiteJson } from "@/lib/partnersAuth";
import { FEE_LIMITS, checkNewPartner, getPartnerByOwner, partnerView, removedNoticeFor, upsertPartner } from "@/lib/partners";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The signed-in wallet's partner account (null before it is made, or once an admin removed it), and the fee limits. */
export async function GET(req: NextRequest) {
  return portal(async () => {
    const wallet = sessionWallet(req);
    const partner = await getPartnerByOwner(wallet);
    const removed = partner ? null : await removedNoticeFor(wallet);
    return { data: { wallet, partner: partner ? partnerView(partner) : null, removed, feeLimits: FEE_LIMITS } };
  });
}

/**
 * Make or update the account: { name, website, payout: { robinhood, tempo }, fees:
 * { privatePaymentCents, cashoutBps, depositBps } }. Fields left out keep their value.
 */
export async function PUT(req: NextRequest) {
  return portal(async () => {
    if (!sameSiteJson(req)) throw new ApiError(403, "bad_origin", "Save from the Gloam site.");
    const wallet = sessionWallet(req);
    await limitPortalWrite(wallet);
    const body = await jsonBody(req);
    const input = { name: body.name, website: body.website, payout: body.payout, fees: body.fees };
    // a few new accounts per IP a day, counted before one is made; changes to an account are not counted
    if (!(await getPartnerByOwner(wallet))) {
      checkNewPartner(input);
      await takeNewAccount(req);
    }
    const partner = await upsertPartner(wallet, input);
    return { data: { wallet, partner: partnerView(partner), feeLimits: FEE_LIMITS } };
  });
}
