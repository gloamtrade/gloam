import { NextResponse } from "next/server";
import { KvUnavailableError } from "@/lib/partnersKv";
import { recordDeliveryEvent, verifyWebhook } from "@/lib/updatesDelivery";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Resend's events are small; anything larger isn't one. */
const MAX_BODY = 64_000;

function answer(status: number, message?: string) {
  return NextResponse.json(message ? { ok: false, error: { message } } : { ok: true }, { status, headers: { "Cache-Control": "no-store" } });
}

/**
 * Resend's delivery webhook (Webhooks in the Resend dashboard, events
 * email.delivered, email.bounced, email.complained, email.delivery_delayed).
 * Signed with RESEND_WEBHOOK_SECRET; an unsigned or stale call is refused.
 * A hard bounce or a spam complaint takes the address off the updates list.
 */
export async function POST(req: Request) {
  const secret = process.env.RESEND_WEBHOOK_SECRET?.trim() ?? "";
  if (!secret) return answer(503, "Delivery tracking is off.");
  const body = await req.text();
  if (body.length > MAX_BODY) return answer(413, "Too large.");
  const headers = {
    id: req.headers.get("svix-id"),
    timestamp: req.headers.get("svix-timestamp"),
    signature: req.headers.get("svix-signature"),
  };
  if (!verifyWebhook(secret, headers, body)) return answer(401, "Bad signature.");
  let event: unknown;
  try {
    event = JSON.parse(body);
  } catch {
    return answer(400, "Not JSON.");
  }
  if (!event || typeof event !== "object") return answer(400, "Not an event.");
  try {
    await recordDeliveryEvent(headers.id!, event as Parameters<typeof recordDeliveryEvent>[1]);
    return answer(200);
  } catch (e) {
    // a 5xx makes Resend try again later, which is what we want while the store is down
    if (e instanceof KvUnavailableError) return answer(503, "Store unavailable.");
    return answer(500, "Failed.");
  }
}
