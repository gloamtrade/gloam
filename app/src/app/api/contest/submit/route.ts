import { NextResponse } from "next/server";
import { CONTEST, CONTEST_FIELDS, ContestInputError, contestClosed, contestDay, contestTime, parseContestInput } from "@/lib/contest";
import { ContestFullError, saveContestEntry } from "@/lib/contestEntries";
import { clientIp, hitRateLimit } from "@/lib/mcpRemote/rateLimit";
import { sameSiteJson } from "@/lib/partnersAuth";
import { KvUnavailableError } from "@/lib/partnersKv";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY = 3_000;
/** Tries per IP per minute. Generous because mobile carriers put many people behind one IP. */
const RATE_LIMIT = 30;
/** Saved entries per IP per hour. A person enters once or twice; this keeps one sender from filling the list. */
const ENTRIES_PER_HOUR = 10;

const FIELDS = new Set<string>(CONTEST_FIELDS);

function fail(status: number, message: string, field: string | null = null, headers?: HeadersInit) {
  return NextResponse.json({ ok: false, error: { field, message } }, { status, headers: { "Cache-Control": "no-store", ...headers } });
}

const ok = (updated: boolean) => NextResponse.json({ ok: true, data: { updated } }, { headers: { "Cache-Control": "no-store" } });

/**
 * Enter the video contest: `{ name, handle, post, note, email, network, agree }`.
 * One entry per X handle; the same handle again replaces it (`updated: true`).
 */
export async function POST(req: Request) {
  // A JSON body from this site only, before anything is counted.
  if (!sameSiteJson(req)) return fail(403, "Send your entry from the form on gloam.trade/contest.");

  const rate = await hitRateLimit(clientIp(req), "contest", RATE_LIMIT);
  if (!rate.allowed) {
    return fail(429, "Too many tries. Wait a minute and send it again.", null, { "Retry-After": String(rate.retryAfterSec) });
  }

  if (contestClosed()) {
    return fail(403, `Entries closed on ${contestDay(CONTEST.closesAt)} at ${contestTime(CONTEST.closesAt)}.`);
  }

  const raw = await req.text();
  if (raw.length > MAX_BODY) return fail(413, "That's more than the form takes. Shorten your note and try again.");
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return fail(400, "Something went wrong sending the form. Refresh and try again.");
  }
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((k) => !FIELDS.has(k))) {
    return fail(400, "Something went wrong sending the form. Refresh and try again.");
  }

  // a field people never see: bots fill it, so pretend it worked and keep nothing
  const trap = (body as { hp?: unknown }).hp;
  if (typeof trap === "string" && trap.trim()) return ok(false);

  try {
    const input = parseContestInput(body);
    const hourly = await hitRateLimit(clientIp(req), "contest-submit", ENTRIES_PER_HOUR, Date.now(), 3600);
    if (!hourly.allowed) {
      return fail(429, "Too many entries from this connection. Try again later, or email hello@gloam.trade.", null, {
        "Retry-After": String(hourly.retryAfterSec),
      });
    }
    const { updated } = await saveContestEntry(input);
    return ok(updated);
  } catch (e) {
    if (e instanceof ContestInputError) return fail(400, e.message, e.field);
    if (e instanceof KvUnavailableError || e instanceof ContestFullError) {
      return fail(503, "Entries are paused for a moment. Try again shortly, or email hello@gloam.trade.");
    }
    return fail(500, "We couldn't save that. Try again, or email hello@gloam.trade.");
  }
}
