import { NextResponse } from "next/server";
import { isAdminAuthenticated } from "@/lib/adminAuth";
import { huntSetup, readHuntProgress } from "@/lib/hunt";
import { prizeState } from "@/lib/huntPrize";
import { kvBackend } from "@/lib/partnersKv";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Admin only: the treasure hunt's progress (lib/hunt). How many people reached
 * each step, which parts are set up, and whether the prize is claimed (when
 * HUNT_PRIZE_NULLIFIER is set). Never what any part holds.
 */
export async function GET() {
  if (!(await isAdminAuthenticated())) {
    return NextResponse.json({ ok: false, error: { message: "Admin session required." } }, { status: 401 });
  }
  const backend = kvBackend();
  try {
    const [reached, prize] = await Promise.all([readHuntProgress(), prizeState()]);
    return NextResponse.json({ ok: true, data: { backend, setup: huntSetup(), reached, prize } }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ ok: false, error: { message: "Could not read the hunt's progress." } }, { status: 503 });
  }
}
