/**
 * What happened to each update after Resend took it: delivered, bounced or
 * marked as spam. Server only.
 *
 * Resend calls api/updates/webhook for each email it delivers, bounces or gets
 * a complaint about. The call is signed (Svix): we check the signature with
 * RESEND_WEBHOOK_SECRET and refuse anything older than five minutes. Then:
 *  - each update counts delivered, bounced, complaints and delays, once per
 *    email (Resend's email id), whatever the retries;
 *  - a hard bounce or a spam complaint takes that address off the list, so we
 *    never mail it again, and goes on a short list the admin can read;
 *  - a soft bounce (mailbox full, a server down) is only counted.
 * Never opens or clicks: those aren't tracked at all.
 */
import { createHash, createHmac, timingSafeEqual } from "crypto";
import { jsonOf, kv } from "./partnersKv";
import { normalizeEmail } from "./updatesEmail";
import { UPDATES_PREFIX, unsubscribeEmail } from "./updatesList";

const P = UPDATES_PREFIX;
/** The emails (Resend ids) of one update that reached each outcome. */
const outcomeKey = (updateId: string, outcome: Outcome) => `${P}mail:${updateId}:dlv:${outcome}`;
/** Each webhook call handled, by its Svix id, so a retry changes nothing. */
const seenKey = (svixId: string) => `${P}wh:${createHash("sha256").update(svixId).digest("hex").slice(0, 32)}`;
/** Bounces and complaints, newest first, for the admin. */
export const PROBLEMS_KEY = `${P}problems`;
const PROBLEMS_MAX = 500;
/** How long a webhook call may take to reach us, in seconds. */
export const WEBHOOK_TOLERANCE_SEC = 5 * 60;

export const OUTCOMES = ["delivered", "bounced", "complained", "delayed"] as const;
export type Outcome = (typeof OUTCOMES)[number];
export type DeliveryCounts = Record<Outcome, number>;

export type DeliveryProblem = {
  email: string;
  kind: "bounced" | "complained";
  /** Resend's words for it, such as "Permanent" or the mail server's reply. */
  detail: string;
  /** The update it came from, or null for a test or an email we can't place. */
  updateId: string | null;
  at: number;
  /** True when the address was on the list and is now off it. */
  removed: boolean;
};

/** Whether Resend can tell us about deliveries: the webhook secret is set. */
export function deliveryTrackingOn(): boolean {
  return !!process.env.RESEND_WEBHOOK_SECRET?.trim();
}

/**
 * Checks a Resend (Svix) webhook call. The signature is HMAC-SHA256 over
 * "<id>.<timestamp>.<body>" with the secret after "whsec_", in base64; the
 * header can carry several, space-separated, each "v1,<signature>".
 */
export function verifyWebhook(
  secret: string,
  headers: { id: string | null; timestamp: string | null; signature: string | null },
  body: string,
  nowSec = Math.floor(Date.now() / 1000),
): boolean {
  const { id, timestamp, signature } = headers;
  if (!secret || !id || !timestamp || !signature) return false;
  if (!/^\d{1,12}$/.test(timestamp)) return false;
  if (Math.abs(nowSec - Number(timestamp)) > WEBHOOK_TOLERANCE_SEC) return false;
  let key: Buffer;
  try {
    key = Buffer.from(secret.startsWith("whsec_") ? secret.slice(6) : secret, "base64");
  } catch {
    return false;
  }
  if (key.length === 0) return false;
  const expected = createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest();
  for (const part of signature.split(" ")) {
    const [version, sig] = part.split(",");
    if (version !== "v1" || !sig) continue;
    let given: Buffer;
    try {
      given = Buffer.from(sig, "base64");
    } catch {
      continue;
    }
    if (given.length === expected.length && timingSafeEqual(given, expected)) return true;
  }
  return false;
}

type ResendEvent = {
  type?: unknown;
  created_at?: unknown;
  data?: {
    email_id?: unknown;
    to?: unknown;
    tags?: unknown;
    bounce?: { type?: unknown; subType?: unknown; message?: unknown };
  };
};

/** The update an email belongs to, from its "update" tag (an object or a list of {name, value}). */
function updateIdOf(tags: unknown): string | null {
  let v: unknown = null;
  if (Array.isArray(tags)) v = tags.find((t) => t && typeof t === "object" && (t as { name?: unknown }).name === "update")?.value;
  else if (tags && typeof tags === "object") v = (tags as Record<string, unknown>).update;
  return typeof v === "string" && /^[A-Za-z0-9_-]{1,256}$/.test(v) ? v : null;
}

const OUTCOME_OF: Record<string, Outcome> = {
  "email.delivered": "delivered",
  "email.bounced": "bounced",
  "email.complained": "complained",
  "email.delivery_delayed": "delayed",
};

export type HandledEvent = { handled: boolean; outcome: Outcome | null; removed: number };

/**
 * Records one verified Resend event. `svixId` makes it safe to receive the
 * same call twice. Events we don't use (sent, opened, clicked) are ignored.
 */
export async function recordDeliveryEvent(svixId: string, event: ResendEvent, now = Date.now()): Promise<HandledEvent> {
  const type = typeof event.type === "string" ? event.type : "";
  const outcome = OUTCOME_OF[type] ?? null;
  if (!outcome) return { handled: false, outcome: null, removed: 0 };

  // handled before? A retry of a call that failed partway finds no mark and does
  // the rest: every step below is safe to repeat, and the mark is set last.
  const [seen] = await kv([["GET", seenKey(svixId)]]);
  if (seen != null) return { handled: false, outcome, removed: 0 };

  const data = event.data ?? {};
  const emailId = typeof data.email_id === "string" && data.email_id.length <= 200 ? data.email_id : null;
  const updateId = updateIdOf(data.tags);
  if (updateId && emailId) await kv([["SADD", outcomeKey(updateId, outcome), emailId]]);

  const done = async (removed: number): Promise<HandledEvent> => {
    await kv([["SET", seenKey(svixId), "1", "EX", 14 * 86_400]]);
    return { handled: true, outcome, removed };
  };
  if (outcome !== "bounced" && outcome !== "complained") return done(0);

  // a soft bounce is counted and nothing more: the address may work next time
  const bounceType = typeof data.bounce?.type === "string" ? data.bounce.type : "";
  if (outcome === "bounced" && bounceType && bounceType !== "Permanent") return done(0);

  const to = Array.isArray(data.to) ? data.to : typeof data.to === "string" ? [data.to] : [];
  const detail = (
    outcome === "complained"
      ? "Marked as spam"
      : [bounceType, data.bounce?.subType, data.bounce?.message].filter((x) => typeof x === "string" && x).join(": ")
  ).slice(0, 300);
  let removed = 0;
  for (const raw of to.slice(0, 50)) {
    const email = normalizeEmail(raw);
    if (!email) continue;
    const wasOn = await unsubscribeEmail(email, outcome === "complained" ? "complained" : "bounced");
    if (wasOn) removed++;
    // listed once per call and address, even when Resend sends the call again
    const [first] = await kv([["SET", `${seenKey(svixId)}:${createHash("sha256").update(email).digest("hex").slice(0, 16)}`, "1", "NX", "EX", 14 * 86_400]]);
    if (first === null) continue;
    const problem: DeliveryProblem = { email, kind: outcome, detail: detail || "Bounced", updateId, at: now, removed: wasOn };
    await kv([
      ["LPUSH", PROBLEMS_KEY, JSON.stringify(problem)],
      ["LTRIM", PROBLEMS_KEY, 0, PROBLEMS_MAX - 1],
    ]);
  }
  return done(removed);
}

/** Delivered, bounced, complaints and delays for one update. */
export async function deliveryCounts(updateId: string): Promise<DeliveryCounts> {
  const r = await kv(OUTCOMES.map((o) => ["SCARD", outcomeKey(updateId, o)]));
  return { delivered: Number(r[0]) || 0, bounced: Number(r[1]) || 0, complained: Number(r[2]) || 0, delayed: Number(r[3]) || 0 };
}

/** The latest bounces and complaints, newest first. */
export async function listDeliveryProblems(limit = 100): Promise<DeliveryProblem[]> {
  const [raw] = await kv([["LRANGE", PROBLEMS_KEY, 0, Math.max(0, limit - 1)]]);
  if (!Array.isArray(raw)) return [];
  return raw.map((r) => jsonOf<DeliveryProblem>(r)).filter((p): p is DeliveryProblem => p !== null);
}
