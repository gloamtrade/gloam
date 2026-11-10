import type { NextRequest } from "next/server";
import { ApiError, jsonBody, portal } from "@/lib/partnersApi";
import { gloamOriginJson } from "@/lib/partnersAuth";
import { readRegisterInput, registerLink } from "@/lib/partnerAttribution";
import { networkForChain } from "@/lib/relay/server";
import { clientIp, hitRateLimit } from "@/lib/mcpRemote/rateLimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Registrations per IP (or IPv6 /64) per minute and per hour: one per wallet-sent payment or cash out. */
const PER_IP_PER_MIN = 10;
const PER_IP_PER_HOUR = 60;
/** Per link code and IP: one person's browser, not a flood against one partner. */
const PER_CODE_IP_PER_MIN = 10;

/**
 * POST { chainId, nullifierHash, bindHash, code, flow: "pay" }: before a wallet
 * sends a payment or a cash out opened from a partner's link, the app registers
 * the spend under the link's code (lib/partnerAttribution). nullifierHash names
 * the spend without revealing it; bindHash names a value only the spender has when
 * it sends (the payment's new note commitment, or the cash out's proof), so knowing
 * a nullifier ahead of time is not enough. The transaction counts only when it
 * carries that value and the registration came before its block's second began.
 * Kept for an hour; counted only if a real transaction matches it. Not taken on
 * Ethereum or Base, where a pending transaction can be read before its block:
 * there only relay-sent link payments count. Nothing
 * about the caller is kept. The app sends this and never waits on it.
 */
export async function POST(req: NextRequest) {
  return portal(async () => {
    if (!gloamOriginJson(req)) throw new ApiError(403, "bad_origin", "Register from the Gloam app.");
    const ip = clientIp(req);
    if (
      !(await hitRateLimit(ip, "partner-reg", PER_IP_PER_MIN)).allowed ||
      !(await hitRateLimit(ip, "partner-reg-hour", PER_IP_PER_HOUR, Date.now(), 3600)).allowed
    ) {
      throw new ApiError(429, "rate_limited", "Too many registrations from here. Wait a while.");
    }
    const input = readRegisterInput(await jsonBody(req, 512));
    try {
      networkForChain(input.chainId);
    } catch {
      throw new ApiError(400, "bad_chain", "Gloam does not run a vault on that chain.");
    }
    // the code is its own dimension, added after the IP is grouped: written into the IP
    // ("code:2001:db8::1") it was read as part of an IPv6 address, grouping /48 or wider
    if (!(await hitRateLimit(ip, "partner-reg-code", PER_CODE_IP_PER_MIN, Date.now(), 60, { scope: input.code })).allowed) {
      throw new ApiError(429, "rate_limited", "Too many registrations for this link from here.");
    }
    const r = await registerLink(input);
    if (r.reason === "code_not_live") throw new ApiError(404, "code_not_live", "That link code is not live.");
    if (r.reason === "public_mempool") throw new ApiError(422, "relay_only", "On this chain only payments sent through the Gloam relay count to a link.");
    if (r.reason === "relay_only") throw new ApiError(422, "relay_only", "A swap goes through the Gloam relay, which ties it to the link itself.");
    return { data: { registered: r.registered }, status: r.registered ? 201 : 200 };
  });
}
