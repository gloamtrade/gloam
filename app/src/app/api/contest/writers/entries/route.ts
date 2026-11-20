import { NextResponse } from "next/server";
import { isAdminAuthenticated } from "@/lib/adminAuth";
import { listWritingEntries, writingCsv, type WritingEntry } from "@/lib/writingEntries";
import { kvBackend } from "@/lib/partnersKv";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Admin only: every writing contest entry, newest first. `?format=csv` downloads a spreadsheet. */
export async function GET(req: Request) {
  if (!(await isAdminAuthenticated())) {
    return NextResponse.json({ ok: false, error: { field: null, message: "Admin session required." } }, { status: 401 });
  }
  const backend = kvBackend();
  let entries: WritingEntry[];
  try {
    entries = backend === "none" ? [] : await listWritingEntries();
  } catch {
    return NextResponse.json(
      { ok: false, error: { field: null, message: "Could not read writing contest entries." } },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }

  if (new URL(req.url).searchParams.get("format") === "csv") {
    return new Response(writingCsv(entries), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": 'attachment; filename="gloam-writing-contest.csv"',
        "Cache-Control": "no-store",
      },
    });
  }
  return NextResponse.json({ ok: true, data: { backend, entries } }, { headers: { "Cache-Control": "no-store" } });
}
