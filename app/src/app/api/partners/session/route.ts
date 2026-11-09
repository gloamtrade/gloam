import type { NextRequest } from "next/server";
import { ApiError, apiFail, apiOk, jsonBody, limitSignIn, newRequestId, sessionWallet } from "@/lib/partnersApi";
import {
  createSession,
  originAllowed,
  requestHost,
  sameSiteJson,
  SESSION_COOKIE,
  sessionCookieOptions,
  verifySignIn,
} from "@/lib/partnersAuth";
import { getPartnerByOwner, partnerView, removedNoticeFor } from "@/lib/partners";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Who is signed in, their partner account if they made one, and, when they have none, whether an admin removed one. */
export async function GET(req: NextRequest) {
  const requestId = newRequestId();
  try {
    const wallet = sessionWallet(req);
    const partner = await getPartnerByOwner(wallet);
    const removed = partner ? null : await removedNoticeFor(wallet);
    return apiOk({ wallet, partner: partner ? partnerView(partner) : null, removed }, { requestId });
  } catch (e) {
    return apiFail(e, { requestId });
  }
}

/** Sign in: { message, signature } from the wallet. Sets the session cookie. */
export async function POST(req: NextRequest) {
  const requestId = newRequestId();
  try {
    if (!sameSiteJson(req)) throw new ApiError(403, "bad_origin", "Sign in from the Gloam site.");
    await limitSignIn(req);
    const body = await jsonBody(req);
    const host = requestHost(req);
    const wallet = await verifySignIn({ message: body.message, signature: body.signature, host });
    const token = createSession(wallet, host);
    if (!token) throw new ApiError(503, "keys_unconfigured", "Partner sign-in is not configured on this server yet.");
    const partner = await getPartnerByOwner(wallet);
    const removed = partner ? null : await removedNoticeFor(wallet);
    const res = apiOk({ wallet, partner: partner ? partnerView(partner) : null, removed }, { requestId });
    res.cookies.set(SESSION_COOKIE, token, sessionCookieOptions());
    return res;
  } catch (e) {
    return apiFail(e, { requestId });
  }
}

/** Sign out. */
export async function DELETE(req: NextRequest) {
  const requestId = newRequestId();
  if (!originAllowed(req)) {
    return apiFail(new ApiError(403, "bad_origin", "Sign out from the Gloam site."), { requestId });
  }
  const res = apiOk({ signedOut: true }, { requestId });
  res.cookies.set(SESSION_COOKIE, "", sessionCookieOptions(0));
  return res;
}
