import { NextResponse } from "next/server";
import { blocktronicsEnabled, tokenInsight } from "@/lib/blocktronics";
import { clientIp, hitRateLimit } from "@/lib/mcpRemote/rateLimit";
import { INSIGHT_CHAIN_IDS, checkableToken, isInsightChain, isTokenAddress } from "@/lib/tokenInsight";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/** Requests per IP per minute. The swap card asks once per token it shows, and the CDN answers most. */
const PER_IP_PER_MIN = 30;

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * GET /api/token-insight?chain=robinhood|base|ethereum&token=0x...
 *
 * The token check the swap card shows (lib/blocktronics): the Blocktronics
 * grade, holders and launch bundles for one of Gloam's own tokens, and
 * nothing else. The answer is the same for everyone who asks, so the CDN may
 * keep it. 404 { error: "disabled" } while BLOCKTRONICS_API_KEY is unset.
 */
export async function GET(req: Request) {
  if (!blocktronicsEnabled()) return NextResponse.json({ error: "disabled" }, { status: 404, headers: NO_STORE });
  const rate = await hitRateLimit(clientIp(req), "token-insight", PER_IP_PER_MIN);
  if (!rate.allowed) {
    return NextResponse.json(
      { error: "rate_limited" },
      { status: 429, headers: { ...NO_STORE, "Retry-After": String(rate.retryAfterSec) } },
    );
  }
  const url = new URL(req.url);
  const chain = url.searchParams.get("chain");
  const token = url.searchParams.get("token");
  if (!isInsightChain(chain) || !isTokenAddress(token)) {
    return NextResponse.json({ error: "bad_request" }, { status: 400, headers: NO_STORE });
  }
  // Only Gloam's own tokens: a bounded list, so nobody can spend the key on any address they like.
  if (!checkableToken(INSIGHT_CHAIN_IDS[chain], token)) {
    return NextResponse.json({ error: "not_offered" }, { status: 404, headers: { "Cache-Control": "public, s-maxage=3600" } });
  }
  const r = await tokenInsight(chain, token);
  if (r.state === "off") return NextResponse.json({ error: "disabled" }, { status: 404, headers: NO_STORE });
  if (r.state === "unavailable") return NextResponse.json({ insight: null, error: "unavailable" }, { status: 503, headers: NO_STORE });
  if (r.state === "none") {
    return NextResponse.json({ insight: null, reason: r.reason }, { headers: { "Cache-Control": "public, s-maxage=600" } });
  }
  const { grade, holders, bundles, url: page } = r.insight;
  return NextResponse.json(
    { insight: { chain: r.insight.chain, token: r.insight.token, grade, holders, bundles, url: page } },
    { headers: { "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=21600" } },
  );
}
