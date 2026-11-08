import { NextResponse } from "next/server";
import { isAdminAuthenticated } from "@/lib/adminAuth";
import { contestCsv, listContestEntries } from "@/lib/contestEntries";
import { kvBackend } from "@/lib/partnersKv";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Admin only: every contest entry, newest first. `?format=csv` downloads a spreadsheet. */
export async function GET(req: Request) {
  if (!(await isAdminAuthenticated())) {
    return NextResponse.json({ ok: false, error: { field: null, message: "Admin session required." } }, { status: 401 });
  }
  const backend = kvBackend();
  const entries = backend === "none" ? [] : await listContestEntries();

  if (new URL(req.url).searchParams.get("format") === "csv") {
    return new Response(contestCsv(entries), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": 'attachment; filename="gloam-video-contest.csv"',
        "Cache-Control": "no-store",
      },
    });
  }
  return NextResponse.json({ ok: true, data: { backend, entries } }, { headers: { "Cache-Control": "no-store" } });
}
