import { NextResponse } from "next/server";
import { isAdminAuthenticated } from "@/lib/adminAuth";
import { clientIp, hitRateLimit } from "@/lib/mcpRemote/rateLimit";
import { KvUnavailableError, kvBackend } from "@/lib/partnersKv";
import { isUpdatesSource, normalizeEmail } from "@/lib/updatesEmail";
import {
  UpdatesListFullError,
  listUpdatesSubscribers,
  subscribeToUpdates,
  unsubscribeEmail,
  unsubscribeToken,
  updatesCsv,
  updatesSummary,
} from "@/lib/updatesList";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY = 1_000;
/** Tries per IP per minute. Generous because mobile carriers put many people behind one IP. */
const RATE_LIMIT = 30;
/** New emails per IP per hour: a person signs up once, so this keeps one sender from filling the list. */
const SUBSCRIBES_PER_HOUR = 10;

/**
 * The only fields each call takes. Anything else, a wallet address above all,
 * is refused rather than dropped, so a client bug can't quietly send one.
 */
const SUBSCRIBE_FIELDS = new Set(["email", "source", "hp"]);
const UNSUBSCRIBE_FIELDS = new Set(["email", "token"]);

function fail(status: number, message: string, headers?: HeadersInit) {
  return NextResponse.json({ ok: false, error: { message } }, { status, headers });
}

const ok = (subscribed: boolean) => NextResponse.json({ ok: true, data: { subscribed } }, { headers: { "Cache-Control": "no-store" } });

type Read = { body: Record<string, unknown> } | { res: Response };

async function readBody(req: Request, fields: Set<string>): Promise<Read> {
  const rate = await hitRateLimit(clientIp(req), "updates", RATE_LIMIT);
  if (!rate.allowed) {
    return { res: fail(429, "Too many tries. Wait a minute and try again.", { "Retry-After": String(rate.retryAfterSec) }) };
  }
  const raw = await req.text();
  if (raw.length > MAX_BODY) return { res: fail(413, "That's more than this form takes.") };
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return { res: fail(400, "Something went wrong sending that. Refresh and try again.") };
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { res: fail(400, "Something went wrong sending that. Refresh and try again.") };
  }
  if (Object.keys(body).some((k) => !fields.has(k))) {
    return { res: fail(400, "Only an email address is taken here.") };
  }
  return { body: body as Record<string, unknown> };
}

function storeFailed(e: unknown) {
  if (e instanceof KvUnavailableError) return fail(503, "Updates are paused for a moment. Try again shortly.");
  return fail(500, "We couldn't save that. Try again in a moment.");
}

/**
 * Join the updates list: `{ email, source }`, source being "sign-in", "settings"
 * or "site". The answer is the same whether the email was on the list already.
 */
export async function POST(req: Request) {
  const read = await readBody(req, SUBSCRIBE_FIELDS);
  if ("res" in read) return read.res;
  const { body } = read;

  // a field people never see: bots fill it, so pretend it worked and keep nothing
  if (typeof body.hp === "string" && body.hp.trim()) return ok(true);

  const email = normalizeEmail(body.email);
  if (!email) return fail(400, "That email doesn't look right. Check it and try again.");
  const source = isUpdatesSource(body.source) ? body.source : "site";

  const hourly = await hitRateLimit(clientIp(req), "updates-subscribe", SUBSCRIBES_PER_HOUR, Date.now(), 3600);
  if (!hourly.allowed) {
    return fail(429, "Too many sign-ups from this connection. Try again later.", { "Retry-After": String(hourly.retryAfterSec) });
  }
  try {
    await subscribeToUpdates(email, source);
    return ok(true);
  } catch (e) {
    if (e instanceof UpdatesListFullError) return fail(503, "The updates list can't take more emails right now. Follow @gloamtrade on X instead.");
    return storeFailed(e);
  }
}

/**
 * Leave the updates list: `{ email }` or `{ token }` (the token from an
 * unsubscribe link). The answer is the same whether the email was on the list.
 */
export async function DELETE(req: Request) {
  const read = await readBody(req, UNSUBSCRIBE_FIELDS);
  if ("res" in read) return read.res;
  const { body } = read;
  try {
    if (typeof body.token === "string" && body.token) {
      await unsubscribeToken(body.token);
      return ok(false);
    }
    const email = normalizeEmail(body.email);
    if (!email) return fail(400, "That email doesn't look right. Check it and try again.");
    await unsubscribeEmail(email);
    return ok(false);
  } catch (e) {
    return storeFailed(e);
  }
}

/** Admin only: how many are on the list. `?format=csv` downloads it. */
export async function GET(req: Request) {
  if (!(await isAdminAuthenticated())) return fail(401, "Admin session required.");
  const backend = kvBackend();
  const subs = backend === "none" ? [] : await listUpdatesSubscribers();

  if (new URL(req.url).searchParams.get("format") === "csv") {
    return new Response(updatesCsv(subs), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": 'attachment; filename="gloam-updates-list.csv"',
        "Cache-Control": "no-store",
      },
    });
  }
  const { count, bySource } = updatesSummary(subs);
  return NextResponse.json({ ok: true, data: { backend, count, bySource } }, { headers: { "Cache-Control": "no-store" } });
}
