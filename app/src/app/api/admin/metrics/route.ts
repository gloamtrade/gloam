import { NextResponse } from "next/server";
import { isAdminAuthenticated } from "@/lib/adminAuth";
import { bridgeFeeSetting } from "@/lib/bridge";
import { fetchOnchainMetrics } from "@/lib/onchainMetrics";
import { fetchRelayVolume } from "@/lib/relayVolume";
import { readTractionSummary } from "@/lib/tractionStore";
import { readFunnel } from "@/lib/funnelStore";
import { readPeople } from "@/lib/peopleStore";
import {
  isTestnetOpen,
  testnetOpensAtMs,
  testnetForceOpen,
} from "@/lib/testnetLaunch";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** The bridge's own cut, as api/bridge/quote reads it: on only with a valid rate and recipient. */
function bridgeFeeBps(): number | null {
  return bridgeFeeSetting(process.env)?.bps ?? null;
}

/**
 * Admin metrics: on-chain figures for both networks (cached about a minute,
 * see lib/onchainMetrics) plus the product event summary. `?fresh=1` skips the
 * snapshot cache (still at most one chain read per 15s).
 */
export async function GET(req: Request) {
  if (!(await isAdminAuthenticated())) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const force = new URL(req.url).searchParams.get("fresh") === "1";
  const chainRead = fetchOnchainMetrics({ force }).catch((e) => {
    console.error("gloam_admin_metrics", e instanceof Error ? e.message : "unknown");
    return { error: "Could not read the chains. The details are in the server logs." };
  });
  const [onchain, product, claimLinks, relay, people] = await Promise.all([
    chainRead,
    readTractionSummary().catch(() => ({
      backend: "memory" as const,
      totalEvents: 0,
      counters: {},
      dims: {},
      daily: [],
      recent: [],
    })),
    readFunnel(14).catch(() => []),
    fetchRelayVolume().catch((e) => {
      console.error("gloam_admin_relay", e instanceof Error ? e.message : "unknown");
      return { error: "Could not read Relay. The details are in the server logs." };
    }),
    // after the chain read, so the public wallets it just added are in the counts
    chainRead.then(() => readPeople()),
  ]);

  return NextResponse.json({
    ok: true,
    generatedAt: new Date().toISOString(),
    launch: {
      open: isTestnetOpen(),
      forceOpen: testnetForceOpen(),
      opensAt: new Date(testnetOpensAtMs()).toISOString(),
      opensAtMs: testnetOpensAtMs(),
    },
    onchain,
    product,
    claimLinks,
    relay,
    people,
    revenueConfig: { bridgeFeeBps: bridgeFeeBps() },
  });
}
