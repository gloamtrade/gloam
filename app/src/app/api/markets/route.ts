import { NextResponse } from "next/server";
import { loadEthUsd, loadHypeUsd, loadLiveMarkets } from "@/lib/live-quotes";
import { logSafe } from "@/lib/logSafe";
import { clientIp, hitRateLimit } from "@/lib/mcpRemote/rateLimit";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/** Requests per IP per minute. The app polls every 30 seconds per open tab. */
const PER_IP_PER_MIN = 60;
/** One upstream fan-out (CoinGecko and Yahoo) per instance this often, at most. */
const CACHE_MS = 20_000;

type Body = {
  markets: Awaited<ReturnType<typeof loadLiveMarkets>>;
  ethUsd: number | null;
  hypeUsd: number | null;
  meta: { liveCount: number; total: number; fetchedAt: number };
};

let cached: { at: number; body: Body } | null = null;
let inflight: Promise<Body> | null = null;

async function load(): Promise<Body> {
  const [markets, ethUsd, hypeUsd] = await Promise.all([loadLiveMarkets(), loadEthUsd(), loadHypeUsd()]);
  const liveCount = markets.filter((m) => m.source === "live").length;
  return { markets, ethUsd, hypeUsd, meta: { liveCount, total: markets.length, fetchedAt: Date.now() } };
}

async function fresh(): Promise<Body> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.body;
  if (!inflight) {
    inflight = load()
      .then((body) => {
        cached = { at: Date.now(), body };
        return body;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

export async function GET(req: Request) {
  const rate = await hitRateLimit(clientIp(req), "markets", PER_IP_PER_MIN);
  if (!rate.allowed) {
    return NextResponse.json(
      { markets: [], ethUsd: null, hypeUsd: null, error: "rate_limited" },
      { status: 429, headers: { "Retry-After": String(rate.retryAfterSec), "Cache-Control": "no-store" } },
    );
  }
  try {
    return NextResponse.json(await fresh(), {
      headers: {
        // public quotes: the CDN answers most polls, so a launch-day crowd costs one upstream fan-out per 20 s
        "Cache-Control": "public, s-maxage=20, stale-while-revalidate=120",
      },
    });
  } catch (e) {
    console.error("gloam_markets", logSafe(e));
    return NextResponse.json(
      { markets: [], ethUsd: null, hypeUsd: null, error: "quote_failed" },
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  }
}
