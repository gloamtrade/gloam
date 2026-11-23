import { NextResponse } from "next/server";
import { isAdminAuthenticated } from "@/lib/adminAuth";
import { KvUnavailableError } from "@/lib/partnersKv";
import { sameSiteJson } from "@/lib/partnersAuth";
import { UpdatesListFullError } from "@/lib/updatesList";
import { addContestEmailsToUpdates } from "@/lib/updatesImport";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function fail(status: number, message: string) {
  return NextResponse.json({ ok: false, error: { message } }, { status, headers: { "Cache-Control": "no-store" } });
}

/**
 * Admin only, a JSON body from the Gloam admin: `{ from: "contests" }` adds
 * every video and writing contest entrant's email to the updates list, with
 * the source "contest". Counts come back, never an email.
 */
export async function POST(req: Request) {
  if (!sameSiteJson(req)) return fail(403, "Add emails from the Gloam admin.");
  if (!(await isAdminAuthenticated())) return fail(401, "Admin session required.");
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail(400, "Something went wrong sending that. Refresh and try again.");
  }
  if (!body || typeof body !== "object" || (body as { from?: unknown }).from !== "contests") {
    return fail(400, "Only the contest entrants can be added here.");
  }
  try {
    const data = await addContestEmailsToUpdates();
    return NextResponse.json({ ok: true, data }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    if (e instanceof UpdatesListFullError) return fail(503, "The updates list is full.");
    if (e instanceof KvUnavailableError) return fail(503, "The store didn't answer. Try again; nobody is added twice.");
    return fail(500, "That didn't work. Try again; nobody is added twice.");
  }
}
