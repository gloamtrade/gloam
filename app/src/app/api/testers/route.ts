import { NextResponse } from "next/server";
import { isAdminAuthenticated } from "@/lib/adminAuth";
import { clientIp, hitRateLimit } from "@/lib/mcpRemote/rateLimit";
import { KvUnavailableError, kvBackend } from "@/lib/partnersKv";
import { recordTractionEvent } from "@/lib/tractionStore";
import {
  TesterInputError,
  isPaidTester,
  listTesterApplications,
  parseTesterInput,
  saveTesterApplication,
  testersCap,
  testersCsv,
  testersGroupUrl,
  type TesterApplication,
} from "@/lib/testers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY = 4_000;
/** Tries per IP per minute. Generous because mobile carriers put many people behind one IP. */
const RATE_LIMIT = 30;
/**
 * Complete applications per IP per hour. A person applies once; this keeps one
 * sender from filling the paid spots with made-up applicants.
 */
const APPLICATIONS_PER_HOUR = 10;

function fail(status: number, message: string, field: string | null = null, headers?: HeadersInit) {
  return NextResponse.json({ ok: false, error: { field, message } }, { status, headers });
}

/** Apply to the testers group. On success the group invite comes back (when it is set). */
export async function POST(req: Request) {
  const rate = await hitRateLimit(clientIp(req), "testers", RATE_LIMIT);
  if (!rate.allowed) {
    return fail(429, "Too many tries. Wait a minute and send it again.", null, {
      "Retry-After": String(rate.retryAfterSec),
    });
  }

  const raw = await req.text();
  if (raw.length > MAX_BODY) return fail(413, "That's more than the form takes. Shorten your note and try again.");
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return fail(400, "Something went wrong sending the form. Refresh and try again.");
  }

  // a field people never see: bots fill it, so pretend it worked and keep nothing
  const trap = (body as { hp?: unknown } | null)?.hp;
  if (typeof trap === "string" && trap.trim()) {
    return NextResponse.json({ ok: true, data: { duplicate: false, paid: false, group: null } });
  }

  try {
    const input = parseTesterInput(body);
    const hourly = await hitRateLimit(clientIp(req), "testers-apply", APPLICATIONS_PER_HOUR, Date.now(), 3600);
    if (!hourly.allowed) {
      return fail(429, "Too many applications from this connection. Try again later, or email hello@gloam.trade.", null, {
        "Retry-After": String(hourly.retryAfterSec),
      });
    }
    const { application, duplicate } = await saveTesterApplication(input);
    if (!duplicate) {
      await recordTractionEvent({
        t: "tester_applied",
        path: "/testers",
        ref: null,
        meta: { network: input.network },
        ts: Date.now(),
        ua: null,
      }).catch(() => {});
    }
    return NextResponse.json({
      ok: true,
      data: { duplicate, paid: isPaidTester(application), group: testersGroupUrl() },
    });
  } catch (e) {
    if (e instanceof TesterInputError) return fail(400, e.message, e.field);
    if (e instanceof KvUnavailableError) {
      return fail(503, "Applications are paused for a moment. Try again shortly, or email hello@gloam.trade.");
    }
    return fail(500, "We couldn't save that. Try again, or email hello@gloam.trade.");
  }
}

/** Admin only: every application, newest first. `?format=csv` downloads a spreadsheet. */
export async function GET(req: Request) {
  if (!(await isAdminAuthenticated())) return fail(401, "Admin session required.");
  const backend = kvBackend();
  let applications: TesterApplication[];
  try {
    applications = backend === "none" ? [] : await listTesterApplications();
  } catch {
    return fail(503, "Could not read tester applications.");
  }

  if (new URL(req.url).searchParams.get("format") === "csv") {
    return new Response(testersCsv(applications), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": 'attachment; filename="gloam-testers.csv"',
        "Cache-Control": "no-store",
      },
    });
  }
  return NextResponse.json({ ok: true, data: { backend, cap: testersCap(), applications } });
}
