import { NextResponse } from "next/server";
import { isAdminAuthenticated } from "@/lib/adminAuth";
import { getNetwork } from "@/lib/networks";
import { publicClientFor } from "@/lib/rhClient";
import { readClaimedNames } from "@/lib/nameStats";
import { excludedFor } from "@/lib/vote/excluded";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Team wallets beyond the vote list: the deployer that made the registry, and the Safe that owns it. */
const TEAM_EXTRA = [
  { address: "0xec9993765e249e8e9DC677B7BCB61F78b31c6b60", reason: "Team: the deployer" },
  { address: "0x8E74b2b85b40f36771f92392b42BBaeacDC75507", reason: "Team: the Gloam Owner Safe" },
];

/**
 * Admin only: every Gloam name claimed so far, read from the registry on
 * Robinhood Chain (lib/nameStats). Names and holders are public on chain.
 */
export async function GET() {
  if (!(await isAdminAuthenticated())) {
    return NextResponse.json({ ok: false, error: { message: "Admin session required." } }, { status: 401 });
  }
  try {
    const client = publicClientFor(getNetwork("robinhood-mainnet"));
    const snap = await readClaimedNames(client);
    const team = excludedFor(TEAM_EXTRA);
    const names = snap.names.map((n) => ({ ...n, team: team.has(n.holder.toLowerCase()) }));
    return NextResponse.json({ ok: true, data: { ...snap, names, readAt: Math.floor(Date.now() / 1000) } }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ ok: false, error: { message: "Could not read the names registry just now." } }, { status: 503 });
  }
}
