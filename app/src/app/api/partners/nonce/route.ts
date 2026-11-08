import { clientIp } from "@/lib/mcpRemote/rateLimit";
import { ApiError, apiFail, apiOk, limitSignIn, newRequestId } from "@/lib/partnersApi";
import { issueNonce, MESSAGE_MAX_LIFETIME_SEC, nonceAllowed, requestHost, sessionsConfigured, SIWE_STATEMENT } from "@/lib/partnersAuth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * A one-time nonce for the partner sign-in message, plus the exact statement
 * and limits the server will check. Valid for ten minutes.
 */
export async function GET(req: Request) {
  const requestId = newRequestId();
  try {
    if (!sessionsConfigured(requestHost(req))) {
      throw new ApiError(503, "keys_unconfigured", "Partner sign-in is not configured on this server yet.");
    }
    const client = clientIp(req);
    if (!nonceAllowed(client)) {
      throw new ApiError(429, "rate_limited", "Too many sign-in attempts from here. Wait a few minutes.");
    }
    await limitSignIn(req);
    const { nonce, expiresAt } = await issueNonce();
    return apiOk(
      { nonce, expiresAt, statement: SIWE_STATEMENT, maxLifetimeSec: MESSAGE_MAX_LIFETIME_SEC },
      { requestId }
    );
  } catch (e) {
    return apiFail(e, { requestId });
  }
}
