import { NextResponse } from "next/server";
import { webhookSecretOk } from "@/lib/telegramBot/rules";
import { runStatusChecks } from "@/lib/status/checks";
import { recordRun } from "@/lib/status/history";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Runs the status checks and counts them into today's history
 * (lib/status/history), for the 90-day bars on status.gloam.trade. Vercel's
 * cron calls it every 5 minutes (vercel.json) with `Authorization: Bearer
 * <CRON_SECRET>`; without CRON_SECRET nothing gets in.
 */
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret || !webhookSecretOk(req.headers.get("authorization"), `Bearer ${secret}`)) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }
  const s = await runStatusChecks();
  try {
    await recordRun(s);
  } catch {
    console.error("gloam_status_record_failed");
    return NextResponse.json({ ok: false, code: "store_off" }, { status: 503 });
  }
  // states only: no reasons, no latencies in the logs
  const tally: Record<string, number> = {};
  for (const p of s.parts) tally[p.status] = (tally[p.status] ?? 0) + 1;
  console.log("gloam_status_run", JSON.stringify({ overall: s.overall, ...tally }));
  return NextResponse.json({ ok: true, data: { overall: s.overall, parts: s.parts.length } });
}
