import { NextResponse } from "next/server";
import { getAddress, isAddress } from "viem";
import { clientIp, hitRateLimit } from "@/lib/mcpRemote/rateLimit";
import { holderFacts, readGloamNow, recordHolder } from "@/lib/vote/holders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PER_MINUTE = 20;
const MAX_BODY = 500;

function fail(status: number, code: string, message: string, headers?: HeadersInit) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status, headers: { "Cache-Control": "no-store", ...headers } });
}

/**
 * A wallet connected to a vote page: { address }. Notes it for the team's
 * count of holders who took part, and answers with its $GLOAM on Robinhood
 * Chain right now. No signature: a wallet address is public, and every
 * balance is worked out here (the snapshot file and a chain read), never
 * taken from the browser. Saving the note is best effort; the answer comes
 * back either way. A wallet first seen with no $GLOAM (at a snapshot or now),
 * no signed vote and no team listing is answered and not stored
 * (lib/vote/holders worthRecording).
 */
export async function POST(req: Request) {
  const rate = await hitRateLimit(clientIp(req), "vote-seen", PER_MINUTE);
  if (!rate.allowed) return fail(429, "rate_limited", "Too many requests. Wait a minute.", { "Retry-After": String(rate.retryAfterSec) });
  const raw = await req.text();
  if (raw.length > MAX_BODY) return fail(413, "too_large", "Request too large.");
  let address: `0x${string}`;
  try {
    const body = JSON.parse(raw) as { address?: unknown };
    if (typeof body.address !== "string" || !isAddress(body.address.trim(), { strict: false })) throw new Error("bad");
    address = getAddress(body.address.trim());
  } catch {
    return fail(400, "bad_address", "That wallet address doesn't look right.");
  }
  const current = await readGloamNow(address);
  const facts = await holderFacts(address, undefined, current).catch(() => null);
  let recorded = false;
  if (facts) {
    try {
      recorded = (await recordHolder(facts, current)) !== null;
    } catch {
      recorded = false;
    }
  }
  return NextResponse.json({ ok: true, data: { address, current: current === null ? null : current.toString(), recorded } }, { headers: { "Cache-Control": "no-store" } });
}
