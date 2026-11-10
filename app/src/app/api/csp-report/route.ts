import { NextResponse } from "next/server";
import { clientIp, hitRateLimit } from "@/lib/mcpRemote/rateLimit";
import { countCspViolations, foldViolations, parseCspReports, readCappedBody } from "@/lib/cspReport";
import { logSafe } from "@/lib/logSafe";

/** Reports per IP per minute. A page with a broken policy sends a few per load; the rest is noise. */
const PER_IP_PER_MIN = 30;

/** report-uri sends application/csp-report, report-to application/reports+json; some browsers say json. */
const REPORT_TYPES = /^application\/(?:csp-report|reports\+json|json)\s*(?:;|$)/i;

/**
 * Where browsers send Content-Security-Policy violation reports (report-uri and
 * report-to in csp.config.mjs). A report holds the page's whole address, and on
 * the claim pages the fragment is a claim code, so only the page's path, the
 * directive, what was blocked (its origin or kind) and whether the policy was
 * enforced are read out (lib/cspReport); those are logged and counted per
 * directive per day. Nothing else in the body is kept or logged.
 */
export async function POST(req: Request) {
  const rate = await hitRateLimit(clientIp(req), "csp-report", PER_IP_PER_MIN);
  if (!rate.allowed) {
    return new NextResponse(null, { status: 429, headers: { "Retry-After": String(rate.retryAfterSec) } });
  }
  const type = req.headers.get("content-type") ?? "";
  if (!REPORT_TYPES.test(type)) return new NextResponse(null, { status: 415 });
  let text: string | null;
  try {
    text = await readCappedBody(req);
  } catch (e) {
    console.warn("gloam_csp_report_unread", logSafe(e));
    return new NextResponse(null, { status: 400 });
  }
  if (text === null) return new NextResponse(null, { status: 413 });
  const list = parseCspReports(type, text);
  if (!list) return new NextResponse(null, { status: 400 });
  for (const v of foldViolations(list)) console.info("gloam_csp_violation", JSON.stringify(v));
  await countCspViolations(list);
  return new NextResponse(null, { status: 204 });
}
