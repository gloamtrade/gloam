import type { NextRequest } from "next/server";
import { ApiError, portal, sessionWallet } from "@/lib/partnersApi";
import { getPartnerByOwner, isTier, readPartnerStats, STATS_DAYS } from "@/lib/partners";
import { PRIVATE_PAYMENTS_NOT_MATCHED, SWAPS_NOT_MATCHED } from "@/lib/partnerBackfill";
import { MAINNET_ENABLED } from "@/lib/networks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Volume and would-be commissions for the signed-in partner, and only theirs, for
 * one tier (?tier=mainnet, the default, or testnet; never added together): totals,
 * by kind, by source (API key, link, matched on chain), by network, by asset, the
 * vault's own fee, the last 14 days (?days=30 or 90 for more), and the latest 50
 * cash outs, deposits and swaps. Private payments show only as counts per day,
 * never one by one, so no hidden payment can be tied to an invoice.
 * Partner fees are not collected on any network yet, mainnet included: nothing
 * is charged; fees show what the setting would have earned.
 */
export async function GET(req: NextRequest) {
  return portal(async () => {
    const partner = await getPartnerByOwner(sessionWallet(req));
    if (!partner) throw new ApiError(404, "no_account", "Create your partner account first.");
    const q = new URL(req.url).searchParams;
    const asked = Number(q.get("days"));
    const days = [30, 90].includes(asked) ? asked : STATS_DAYS;
    const tier = isTier(q.get("tier")) ? (q.get("tier") as "mainnet" | "testnet") : "mainnet";
    const stats = await readPartnerStats(partner.id, { recent: 50, days, tier, forPartner: true });
    // Where the counts come from: the testnets, plus the mainnets once a mainnet pool is in.
    return {
      data: {
        ...stats,
        days,
        charged: false,
        network: MAINNET_ENABLED ? "mainnet and testnet" : "testnet",
        notMatched: { privatePayments: PRIVATE_PAYMENTS_NOT_MATCHED, swaps: SWAPS_NOT_MATCHED },
      },
    };
  });
}
