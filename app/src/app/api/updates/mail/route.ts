import { NextResponse } from "next/server";
import { isAdminAuthenticated } from "@/lib/adminAuth";
import { hitRateLimit } from "@/lib/mcpRemote/rateLimit";
import { KvUnavailableError, kv, kvBackend } from "@/lib/partnersKv";
import { sameSiteJson } from "@/lib/partnersAuth";
import { UPDATES_IDS } from "@/lib/updatesList";
import { deliveryTrackingOn, listDeliveryProblems } from "@/lib/updatesDelivery";
import {
  MailInputError,
  MailOffError,
  UPDATE_ID,
  listUpdatesForAdmin,
  publicMailConfig,
  retryFailed,
  sendStep,
  sendTest,
  startUpdate,
} from "@/lib/updatesMail";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** One send step runs about 25 seconds, plus one slow answer from Resend. */
export const maxDuration = 60;

const MAX_BODY = 64_000;
/** Test emails an hour, from every admin together. */
const TESTS_PER_HOUR = 20;

const noStore = { "Cache-Control": "no-store" };

function fail(status: number, message: string) {
  return NextResponse.json({ ok: false, error: { message } }, { status, headers: noStore });
}

function done<T>(data: T) {
  return NextResponse.json({ ok: true, data }, { headers: noStore });
}

function failed(e: unknown) {
  if (e instanceof MailInputError) return fail(400, e.message);
  if (e instanceof MailOffError) return fail(409, `Sending is off: ${e.message}`);
  if (e instanceof KvUnavailableError) return fail(503, "The updates store didn't answer. Try again in a moment; nobody gets an update twice.");
  console.warn("gloam_updates_mail_failed", e instanceof Error ? e.name : typeof e);
  return fail(500, "That didn't work. Try again in a moment; nobody gets an update twice.");
}

/**
 * Admin only: whether sending is on (and why not), the sender, how many are
 * on the list, and every update with its counts and what Resend said after
 * (delivered, bounced, complaints). Never the API key; the only emails are
 * bounced or complaining addresses, so the admin sees who left the list and why.
 */
export async function GET() {
  if (!(await isAdminAuthenticated())) return fail(401, "Admin session required.");
  const backend = kvBackend();
  const mail = publicMailConfig();
  const tracking = deliveryTrackingOn();
  if (backend === "none") return done({ mail, backend, subscribers: 0, updates: [], tracking, problems: [] });
  try {
    const [count] = await kv([["SCARD", UPDATES_IDS]]);
    const updates = await listUpdatesForAdmin();
    const problems = await listDeliveryProblems(100);
    return done({ mail, backend, subscribers: Number(count) || 0, updates, tracking, problems });
  } catch (e) {
    return failed(e);
  }
}

/**
 * Admin only, a JSON body from the Gloam site:
 *   { action: "test", subject, body, to }  one test email to one address, nothing stored
 *   { action: "start", subject, body }     stores the update and gives its id; the same
 *                                          text again gives back the same update
 *   { action: "send", id }                 one step of sending (about 25 seconds); call
 *                                          again until done. Resumes a stopped send.
 *   { action: "retryFailed", id }          puts the people Resend refused back in line
 */
export async function POST(req: Request) {
  if (!sameSiteJson(req)) return fail(403, "Send updates from the Gloam admin.");
  if (!(await isAdminAuthenticated())) return fail(401, "Admin session required.");
  const raw = await req.text();
  if (raw.length > MAX_BODY) return fail(413, "That update is too long.");
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    body = parsed as Record<string, unknown>;
  } catch {
    return fail(400, "Something went wrong sending that. Refresh and try again.");
  }

  try {
    switch (body.action) {
      case "test": {
        const rate = await hitRateLimit("admin", "updates-test", TESTS_PER_HOUR, Date.now(), 3600);
        if (!rate.allowed) return fail(429, "That's a lot of tests for one hour. Try again later.");
        await sendTest(String(body.subject ?? ""), String(body.body ?? ""), String(body.to ?? ""));
        return done({ tested: true });
      }
      case "start": {
        const { update, existing } = await startUpdate(String(body.subject ?? ""), String(body.body ?? ""));
        return done({ id: update.id, status: update.status, day: update.day, existing });
      }
      case "send":
      case "retryFailed": {
        const id = typeof body.id === "string" ? body.id : "";
        if (!UPDATE_ID.test(id)) return fail(400, "No update with that id.");
        return done(body.action === "send" ? await sendStep(id) : await retryFailed(id));
      }
      default:
        return fail(400, "Send { action: \"test\" | \"start\" | \"send\" | \"retryFailed\" }.");
    }
  } catch (e) {
    return failed(e);
  }
}
