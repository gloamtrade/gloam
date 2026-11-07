import { NextResponse } from "next/server";
import { clientIp, hitRateLimit } from "@/lib/mcpRemote/rateLimit";
import { HUNT_INPUT_MAX, checkRiddleAnswer, countHuntStep, huntPagePath, huntSubject } from "@/lib/hunt";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY = 1_000;
/** Answers per IP: a few a minute, and a cap per day, so the answer can't be found by trying words. */
const ANSWERS_PER_MINUTE = 8;
const ANSWERS_PER_DAY = 60;

const NO_STORE = { "Cache-Control": "no-store" };

function notFound() {
  return NextResponse.json({ ok: false, error: { message: "Not found." } }, { status: 404, headers: NO_STORE });
}

function tooMany(retryAfterSec: number) {
  return NextResponse.json(
    { ok: false, error: { message: "Too many tries. Take a break and come back later." } },
    { status: 429, headers: { ...NO_STORE, "Retry-After": String(retryAfterSec) } },
  );
}

/**
 * The hidden page's answer check (lib/hunt): `{ answer }` is checked on the
 * server and, when it is right, the next clue comes back. 404 while the hunt is off.
 */
export async function POST(req: Request) {
  if (!huntPagePath()) return notFound();
  const ip = clientIp(req);
  const raw = await req.text();
  if (raw.length > MAX_BODY) return NextResponse.json({ ok: false, error: { message: "Too long." } }, { status: 413, headers: NO_STORE });
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    /* handled below */
  }
  if (!parsed || typeof parsed !== "object") return NextResponse.json({ ok: false, error: { message: "Bad request." } }, { status: 400, headers: NO_STORE });
  const body = parsed as { answer?: unknown };

  if (typeof body.answer !== "string" || !body.answer.trim() || body.answer.length > HUNT_INPUT_MAX) {
    return NextResponse.json({ ok: false, error: { message: "Type an answer first." } }, { status: 400, headers: NO_STORE });
  }
  const minute = await hitRateLimit(ip, "hunt-answer", ANSWERS_PER_MINUTE);
  if (!minute.allowed) return tooMany(minute.retryAfterSec);
  const day = await hitRateLimit(ip, "hunt-answer-day", ANSWERS_PER_DAY, Date.now(), 86_400);
  if (!day.allowed) return tooMany(day.retryAfterSec);

  const next = checkRiddleAnswer(body.answer);
  if (!next) return NextResponse.json({ ok: true, data: {} }, { headers: NO_STORE });
  await countHuntStep("riddle", huntSubject("ip", ip));
  return NextResponse.json({ ok: true, data: { next } }, { headers: NO_STORE });
}
