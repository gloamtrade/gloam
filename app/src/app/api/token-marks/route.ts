import { NextResponse } from "next/server";
import { logSafe } from "@/lib/logSafe";
import { clientIp, hitRateLimit } from "@/lib/mcpRemote/rateLimit";
import { loadTokenMarks } from "@/lib/tokenMarksServer";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/** Requests per IP per minute. An open tab asks every two minutes, and the CDN answers most. */
const PER_IP_PER_MIN = 60;

/** Prices for the fixed list in lib/markedTokens. It takes no input: the same answer for every visitor. */
export async function GET(req: Request) {
  const rate = await hitRateLimit(clientIp(req), "token-marks", PER_IP_PER_MIN);
  if (!rate.allowed) {
    return NextResponse.json(
      { marks: {}, error: "rate_limited" },
      { status: 429, headers: { "Retry-After": String(rate.retryAfterSec), "Cache-Control": "no-store" } }
    );
  }
  try {
    const marks = await loadTokenMarks();
    return NextResponse.json(
      { marks },
      {
        headers: {
          // an empty answer is an outage: never let the CDN hold on to it
          "Cache-Control": Object.keys(marks).length ? "public, s-maxage=60, stale-while-revalidate=300" : "no-store",
        },
      }
    );
  } catch (e) {
    console.error("gloam_token_marks", logSafe(e));
    return NextResponse.json({ marks: {}, error: "unavailable" }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }
}
