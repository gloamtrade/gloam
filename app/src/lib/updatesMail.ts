/**
 * Sending Gloam email updates to the people on the updates list. Server only.
 *
 * Mail goes through Resend's batch endpoint (POST /emails/batch, up to 100
 * messages a call), one message per person: each has its own To, its own
 * unsubscribe link and RFC 8058 one-click headers. Nobody ever sees anyone
 * else's address. RESEND_API_KEY unset means sending is off.
 *
 * Only the updates list (lib/updatesList) is ever read for recipients:
 * never testers, contest entries, partners or anything else.
 *
 * Never twice. An update has an id and its stored email (subject, HTML and text,
 * with a mark where each person's link goes, so a resend is byte for byte the
 * same). Sending works through the list in batches:
 *  1. take up to 100 people not yet in the update's `claimed` set and claim
 *     them (SADD, one at a time, so a second sender can't take the same person),
 *     writing the batch (who is in it, when it started) as pending, in the same
 *     round trip;
 *  2. send it with the Idempotency-Key gloam-update/<id>/<batch>;
 *  3. on success, count it and drop the pending batch.
 * A sender that dies between 1 and 3 leaves the batch pending. The next run
 * sends pending batches first with the same key, and Resend answers a repeated
 * key with the first answer instead of sending again. Keys last 24 hours, so a
 * pending batch older than 23 hours is never sent again: it is counted as
 * "unknown" (it may or may not have gone out). Only an answer that says nothing
 * went out (a refused key, a used-up quota, a bad address) puts people back.
 * One sender runs per update at a time (a lock), and the admin page drives it
 * in steps of about 25 seconds, so a send of any size fits the function limit
 * and a send that stops halfway resumes from the admin.
 *
 * A pending batch holds its people's emails and unsubscribe tokens (so a resend
 * is the same message) and is deleted as soon as the batch settles. The rest is
 * subscriber ids, which are hashes.
 */
import "server-only";
import { createHash, randomBytes } from "crypto";
import { hashNumbers, jsonOf, kv } from "./partnersKv";
import { normalizeEmail } from "./updatesEmail";
import {
  UPDATES_IDS,
  UPDATES_PREFIX,
  oneClickUnsubscribeUrl,
  subscriberKey,
  unsubscribeUrl,
  type UpdatesSubscriber,
} from "./updatesList";
import { SITE, UNSUBSCRIBE_MARK, checkUpdate, escapeHtml, renderUpdateEmail } from "./updatesMailRender";

export const RESEND_BATCH_URL = "https://api.resend.com/emails/batch";
export const DEFAULT_FROM = "Gloam <updates@gloam.trade>";
export const DEFAULT_REPLY_TO = "hello@gloam.trade";
/** Resend takes at most 100 messages in one batch call. */
export const BATCH_MAX = 100;
/** Resend keeps an idempotency key for 24 hours; past this, a pending batch is not sent again. */
export const RESEND_WINDOW_MS = 23 * 60 * 60 * 1000;
const STEP_BUDGET_MS = 25_000;
const REQUEST_TIMEOUT_MS = 15_000;
/** At most five calls a second: Resend's default limit is ten for the whole team. */
const MIN_GAP_MS = 200;
const MAX_ATTEMPTS = 4;
const LOCK_SEC = 90;
const USER_AGENT = "gloam-updates/1.0 (+https://www.gloam.trade)";

export const UPDATE_ID = /^[a-z0-9][a-z0-9-]{0,79}$/;

// ------------------------------------------------------------------ config

export type MailConfig =
  | { on: true; apiKey: string; from: string; replyTo: string }
  | { on: false; reason: string; from: string; replyTo: string };

/** "Name <address>" or a bare address, checked. Null when it isn't one. */
function checkFrom(raw: string): string | null {
  const s = raw.trim();
  const m = /^([^<>"\r\n]{1,64}?)\s*<([^<>\s]+)>$/.exec(s);
  const addr = normalizeEmail(m ? m[2] : s);
  if (!addr) return null;
  return m ? `${m[1]!.trim()} <${addr}>` : addr;
}

/** What sending would use. Never returns the key to a caller outside this file but the sender. */
export function mailConfig(): MailConfig {
  const rawFrom = process.env.UPDATES_FROM?.trim() || DEFAULT_FROM;
  const rawReply = process.env.UPDATES_REPLY_TO?.trim() || DEFAULT_REPLY_TO;
  const from = checkFrom(rawFrom);
  const replyTo = normalizeEmail(rawReply);
  const apiKey = process.env.RESEND_API_KEY?.trim() ?? "";
  if (!apiKey) return { on: false, reason: "RESEND_API_KEY isn't set on this server, so nothing can be sent.", from: from ?? rawFrom, replyTo: replyTo ?? rawReply };
  if (!from) return { on: false, reason: "UPDATES_FROM isn't a valid sender. Use Name <address> or an address.", from: rawFrom, replyTo: replyTo ?? rawReply };
  if (!replyTo) return { on: false, reason: "UPDATES_REPLY_TO isn't a valid email address.", from, replyTo: rawReply };
  return { on: true, apiKey, from, replyTo };
}

/** What the admin may see: on or off and why, the sender and the reply address. Never the key. */
export function publicMailConfig(): { on: boolean; reason: string | null; from: string; replyTo: string } {
  const c = mailConfig();
  return { on: c.on, reason: c.on ? null : c.reason, from: c.from, replyTo: c.replyTo };
}

export class MailOffError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "MailOffError";
  }
}

export class MailInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MailInputError";
  }
}

// ------------------------------------------------------------------ store

const P = UPDATES_PREFIX;
/** Every update's id, newest first (a list: plain values, so the dev store reads it from any route). */
const MAILS = `${P}mails`;
const recKey = (id: string) => `${P}mail:${id}`;
const hashKey = (sha: string) => `${P}mailhash:${sha}`;
/** Who the update goes to: the list as it stood when it started. */
const audienceKey = (id: string) => `${P}mail:${id}:to`;
const claimedKey = (id: string) => `${P}mail:${id}:claimed`;
const failedKey = (id: string) => `${P}mail:${id}:failed`;
const countsKey = (id: string) => `${P}mail:${id}:n`;
const seqKey = (id: string) => `${P}mail:${id}:seq`;
const pendingKey = (id: string) => `${P}mail:${id}:pending`;
const batchKey = (id: string, seq: number) => `${P}mail:${id}:batch:${seq}`;
const lockKey = (id: string) => `${P}mail:${id}:lock`;
const noteKey = (id: string) => `${P}mail:${id}:note`;

export type UpdateRecord = {
  id: string;
  subject: string;
  /** The markdown the admin wrote. */
  body: string;
  /** The UTC day the send started, YYYY-MM-DD. */
  day: string;
  createdAt: number;
  status: "sending" | "sent";
  finishedAt: number | null;
  /** True once the first batch went out: from then on /updates shows it. */
  published: boolean;
  /** When the list was copied as this update's audience; null until then. */
  audienceAt: number | null;
  /** The email as sent, with UNSUBSCRIBE_MARK where each person's link goes. */
  html: string;
  text: string;
  from: string;
  replyTo: string;
};

type Recipient = { id: string; email: string; token: string };
type PendingBatch = { at: number; rcpts: Recipient[] };

export type SendProgress = {
  id: string;
  status: "sending" | "sent";
  sent: number;
  failed: number;
  unknown: number;
  /** On the list and not yet in a batch. */
  left: number;
  /** In a batch whose answer isn't in yet (sent again with the same key on resume). */
  pending: number;
  done: boolean;
  /** Another step is running for this update right now. */
  busy: boolean;
  /** Why this step stopped early, in plain words; null when it simply ran out of time or finished. */
  stopped: string | null;
};

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function contentHash(subject: string, body: string): string {
  return createHash("sha256").update(`${subject.trim()}\u0000${body.trim()}`).digest("hex").slice(0, 40);
}

export function slugFor(subject: string): string {
  const s = subject
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/, "");
  return s || "update";
}

export function updateUrl(id: string): string {
  return `${SITE}/updates/${id}`;
}

export async function getUpdate(id: string): Promise<UpdateRecord | null> {
  if (!UPDATE_ID.test(id)) return null;
  const [raw] = await kv([["GET", recKey(id)]]);
  return jsonOf<UpdateRecord>(raw);
}

async function saveRecord(rec: UpdateRecord) {
  await kv([["SET", recKey(rec.id), JSON.stringify(rec)]]);
}

/**
 * Fixes who an update goes to: everyone on the list now. People who join later
 * don't get it, whatever is resumed or retried; people who leave before their
 * batch are skipped.
 */
async function ensureAudience(rec: UpdateRecord, now: number) {
  if (rec.audienceAt || rec.status === "sent") return;
  await kv([["SUNIONSTORE", audienceKey(rec.id), UPDATES_IDS]]);
  rec.audienceAt = now;
  await saveRecord(rec);
}

/** Puts an update in the list the admin and /updates read, once. */
async function ensureListed(id: string) {
  const [ids] = await kv([["LRANGE", MAILS, 0, -1]]);
  if (!(Array.isArray(ids) && ids.map(String).includes(id))) await kv([["LPUSH", MAILS, id]]);
}

/** Every step of starting an update, again: a start that died halfway is finished by the next. */
async function finishStart(rec: UpdateRecord, now: number): Promise<UpdateRecord> {
  await ensureAudience(rec, now);
  await ensureListed(rec.id);
  return rec;
}

/**
 * Starts an update: stores it with a new id, ready to send. The same subject and
 * body again gives back the update already started (a double click, a second
 * tab), never a second one. Refused while sending is off.
 */
export async function startUpdate(subject: string, body: string, now = Date.now()): Promise<{ update: UpdateRecord; existing: boolean }> {
  const bad = checkUpdate(subject, body);
  if (bad) throw new MailInputError(bad);
  const cfg = mailConfig();
  if (!cfg.on) throw new MailOffError(cfg.reason);
  const sha = contentHash(subject, body);

  const [known] = await kv([["GET", hashKey(sha)]]);
  if (typeof known === "string") {
    const rec = await getUpdate(known);
    if (rec) return { update: await finishStart(rec, now), existing: true };
  }

  const day = utcDay(now);
  const base = `${day}-${slugFor(subject)}`;
  let rec: UpdateRecord | null = null;
  for (let n = 1; n <= 30 && !rec; n++) {
    const id = n === 1 ? base : n <= 20 ? `${base}-${n}` : `${base}-${randomBytes(3).toString("hex")}`;
    const { html, text } = renderUpdateEmail({ subject, body, day, webUrl: updateUrl(id), unsubscribeUrl: UNSUBSCRIBE_MARK });
    const candidate: UpdateRecord = {
      id,
      subject: subject.trim(),
      body,
      day,
      createdAt: now,
      status: "sending",
      finishedAt: null,
      published: false,
      audienceAt: null,
      html,
      text,
      from: cfg.from,
      replyTo: cfg.replyTo,
    };
    const [ok] = await kv([["SET", recKey(id), JSON.stringify(candidate), "NX"]]);
    if (ok === "OK") rec = candidate;
  }
  if (!rec) throw new Error("no free id for this update");

  const [claimed] = await kv([["SET", hashKey(sha), rec.id, "NX"]]);
  if (claimed === null) {
    // the same update was started a moment ago by another click: that one stands
    await kv([["DEL", recKey(rec.id)]]);
    const [other] = await kv([["GET", hashKey(sha)]]);
    const theirs = typeof other === "string" ? await getUpdate(other) : null;
    if (theirs) return { update: await finishStart(theirs, now), existing: true };
    throw new Error("update start raced and lost");
  }
  return { update: await finishStart(rec, now), existing: false };
}

/** One person's message: their own To, unsubscribe link and one-click headers. */
function messageFor(rec: UpdateRecord, r: Recipient) {
  const page = unsubscribeUrl(r.token);
  return {
    from: rec.from,
    to: [r.email],
    reply_to: rec.replyTo,
    subject: rec.subject,
    html: rec.html.split(UNSUBSCRIBE_MARK).join(escapeHtml(page)),
    text: rec.text.split(UNSUBSCRIBE_MARK).join(page),
    headers: {
      "List-Unsubscribe": `<${oneClickUnsubscribeUrl(r.token)}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
    tags: [{ name: "update", value: rec.id }],
  };
}

// ------------------------------------------------------------------ Resend

export type ResendOutcome =
  | { kind: "sent" }
  /** 429 rate_limit_exceeded: nothing went out, try again after a wait. */
  | { kind: "rate"; waitMs: number }
  /** 429 daily or monthly quota: nothing went out. */
  | { kind: "quota"; message: string }
  /** 422: Resend checked the messages and refused them; nothing went out. */
  | { kind: "invalid"; message: string }
  /** 400, 401, 403: the key, the sender or the account was refused. */
  | { kind: "refused"; status: number; message: string }
  /** 409: this key went with a different body before. Whether that went out is unknown. */
  | { kind: "conflict"; message: string }
  /** 409: a request with this key is still running. */
  | { kind: "busy" }
  /** 5xx, a timeout, no connection: it may or may not have gone out. */
  | { kind: "unsure"; message: string };

type Fetch = typeof fetch;

/** One call to Resend's batch endpoint. Never throws. */
export async function resendBatch(
  apiKey: string,
  messages: unknown[],
  idempotencyKey: string | null,
  fetchImpl: Fetch = fetch,
): Promise<ResendOutcome> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    "User-Agent": USER_AGENT,
  };
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  let res: Response;
  try {
    res = await fetchImpl(RESEND_BATCH_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(messages),
      cache: "no-store",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    return { kind: "unsure", message: "Resend didn't answer." };
  }
  if (res.ok) return { kind: "sent" };
  const json = (await res.json().catch(() => null)) as { name?: unknown; message?: unknown } | null;
  const name = typeof json?.name === "string" ? json.name : "";
  const message = (typeof json?.message === "string" ? json.message : `Resend answered ${res.status}.`).slice(0, 300);
  if (res.status === 429) {
    if (name === "daily_quota_exceeded") return { kind: "quota", message: "Resend's daily sending limit is used up. Resume tomorrow." };
    if (name === "monthly_quota_exceeded") return { kind: "quota", message: "Resend's monthly sending limit is used up. Raise the plan, then resume." };
    const after = Number(res.headers.get("retry-after") ?? res.headers.get("ratelimit-reset") ?? "1");
    return { kind: "rate", waitMs: Math.min(Math.max(Number.isFinite(after) ? after : 1, 0.5), 30) * 1000 };
  }
  if (res.status === 409) {
    if (name === "concurrent_idempotent_requests") return { kind: "busy" };
    return { kind: "conflict", message };
  }
  if (res.status === 422) return { kind: "invalid", message };
  if (res.status === 400 || res.status === 401 || res.status === 403) return { kind: "refused", status: res.status, message };
  return { kind: "unsure", message };
}

// ------------------------------------------------------------------ sending

export type SendOptions = {
  fetch?: Fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** How long one step may keep starting batches. */
  budgetMs?: number;
  batchSize?: number;
  minGapMs?: number;
  /** Self-tests only: runs after Resend took a batch and before the store hears of it. */
  afterResendAccepted?: (seq: number) => void | Promise<void>;
};

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function refusedText(status: number, message: string): string {
  if (status === 401 || status === 403) return `Resend refused the key or the sender (${message}). Check RESEND_API_KEY and that gloam.trade is verified in Resend, then resume.`;
  return `Resend refused the request (${message}). Resume once it's fixed.`;
}

/**
 * Sends one test of an update to one address. Nothing is stored. The subject
 * starts with [Test]; the unsubscribe link opens the page without a token and
 * the web link goes to /updates.
 */
export async function sendTest(subject: string, body: string, to: string, opts: SendOptions = {}): Promise<void> {
  const bad = checkUpdate(subject, body);
  if (bad) throw new MailInputError(bad);
  const email = normalizeEmail(to);
  if (!email) throw new MailInputError("That test address doesn't look right.");
  const cfg = mailConfig();
  if (!cfg.on) throw new MailOffError(cfg.reason);
  const now = (opts.now ?? Date.now)();
  const { html, text } = renderUpdateEmail({
    subject,
    body,
    day: utcDay(now),
    webUrl: `${SITE}/updates`,
    unsubscribeUrl: `${SITE}/unsubscribe`,
  });
  const out = await resendBatch(
    cfg.apiKey,
    [{ from: cfg.from, to: [email], reply_to: cfg.replyTo, subject: `[Test] ${subject.trim()}`, html, text }],
    null,
    opts.fetch,
  );
  if (out.kind === "sent") return;
  if (out.kind === "rate") throw new MailInputError("Resend is busy. Try the test again in a moment.");
  if (out.kind === "busy") throw new MailInputError("Resend is busy. Try the test again in a moment.");
  if (out.kind === "refused") throw new MailInputError(refusedText(out.status, out.message).replace(", then resume.", "."));
  throw new MailInputError("message" in out ? out.message : "Resend didn't send the test.");
}

/** Where one update stands, read from the store. Who is left is only read while it sends. */
export async function progressOf(rec: UpdateRecord): Promise<SendProgress> {
  const sending = rec.status !== "sent";
  const [counts, pending, left] = await kv([
    ["HGETALL", countsKey(rec.id)],
    ["SCARD", pendingKey(rec.id)],
    ...(sending ? [["SDIFF", audienceKey(rec.id), claimedKey(rec.id)]] : []),
  ]);
  const c = hashNumbers(counts);
  return {
    id: rec.id,
    status: rec.status,
    sent: c.sent ?? 0,
    failed: c.failed ?? 0,
    unknown: c.unknown ?? 0,
    left: sending && Array.isArray(left) ? left.length : 0,
    pending: Number(pending) || 0,
    done: rec.status === "sent",
    busy: false,
    stopped: null,
  };
}

/**
 * One step of sending an update: pending batches from an earlier step first,
 * then new batches, until the list is done, the step's time is up, or Resend
 * says stop. Call again until `done`. Safe to call twice at once: the second
 * answers `busy` and sends nothing. A finished update sends nothing more.
 */
export async function sendStep(id: string, opts: SendOptions = {}): Promise<SendProgress> {
  const cfg = mailConfig();
  if (!cfg.on) throw new MailOffError(cfg.reason);
  const rec = await getUpdate(id);
  if (!rec) throw new MailInputError("No update with that id.");
  if (rec.status === "sent") return progressOf(rec);

  const fetchImpl = opts.fetch ?? fetch;
  const sleep = opts.sleep ?? realSleep;
  const now = opts.now ?? Date.now;
  const budget = opts.budgetMs ?? STEP_BUDGET_MS;
  const size = Math.min(Math.max(opts.batchSize ?? BATCH_MAX, 1), BATCH_MAX);
  const gap = opts.minGapMs ?? MIN_GAP_MS;
  const started = now();
  const timeUp = () => now() - started >= budget;

  const lock = randomBytes(12).toString("hex");
  const [got] = await kv([["SET", lockKey(id), lock, "NX", "EX", LOCK_SEC]]);
  if (got !== "OK") return { ...(await progressOf(rec)), busy: true };

  let stopped: string | null = null;
  let lastCall = 0;
  let sentThisStep = 0;
  let singleFailsInARow = 0;

  /** Paces calls, then sends with retries. "later" leaves the batch pending. */
  const deliver = async (
    seq: number,
    rcpts: Recipient[],
    resumed: boolean,
  ): Promise<ResendOutcome | { kind: "later"; message: string | null }> => {
    let unsure = resumed;
    let lastMessage: string | null = null;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const wait = lastCall + gap - now();
      if (wait > 0) await sleep(wait);
      lastCall = now();
      const out = await resendBatch(cfg.apiKey, rcpts.map((r) => messageFor(rec, r)), `gloam-update/${rec.id}/${seq}`, fetchImpl);
      if (out.kind === "sent") return out;
      if (out.kind === "busy") return { kind: "later", message: "A batch is still going through at Resend. Resume in a minute." };
      if (out.kind === "rate" || out.kind === "unsure") {
        if (out.kind === "unsure") {
          unsure = true;
          lastMessage = "Resend didn't answer clearly. Resume in a minute; nobody gets it twice.";
        } else lastMessage = "Resend is busy. Resume in a minute.";
        const backoff = out.kind === "rate" ? out.waitMs : 1000 * 2 ** attempt;
        if (now() - started + backoff >= budget) return { kind: "later", message: out.kind === "rate" ? null : lastMessage };
        await sleep(backoff);
        continue;
      }
      // an answer that says nothing went out this time, after an attempt that may have:
      // the earlier one's fate is unknown, so the batch stays pending for its key
      if (unsure && (out.kind === "refused" || out.kind === "quota")) {
        return { kind: "later", message: out.kind === "quota" ? out.message : refusedText(out.status, out.message) };
      }
      return out;
    }
    return { kind: "later", message: lastMessage };
  };

  /** Closes a batch once. A batch another step already closed is only tidied, never counted twice. */
  const settle = async (seq: number, rcpts: Recipient[], how: "sent" | "unknown" | "failed" | "release") => {
    const [mine] = await kv([["SREM", pendingKey(id), String(seq)]]);
    const cmds: (string | number)[][] = [];
    if (Number(mine) === 1) {
      if (how === "release") cmds.push(["SREM", claimedKey(id), ...rcpts.map((r) => r.id)]);
      else cmds.push(["HINCRBY", countsKey(id), how, rcpts.length]);
      if (how === "failed") cmds.push(["SADD", failedKey(id), ...rcpts.map((r) => r.id)]);
    }
    cmds.push(["DEL", batchKey(id, seq)]);
    await kv(cmds);
    if (how === "sent") {
      sentThisStep += rcpts.length;
      singleFailsInARow = 0;
      if (!rec.published) {
        rec.published = true;
        await saveRecord(rec);
      }
    }
  };

  /** Handles what came back for a batch. Returns false when the step should stop. */
  const handle = async (
    seq: number,
    rcpts: Recipient[],
    out: ResendOutcome | { kind: "later"; message: string | null },
  ): Promise<boolean> => {
    switch (out.kind) {
      case "sent":
        if (opts.afterResendAccepted) await opts.afterResendAccepted(seq);
        await settle(seq, rcpts, "sent");
        return true;
      case "later":
        if (out.message) stopped = out.message;
        return false;
      case "conflict":
        // the key went out with another body before: never send it again
        await settle(seq, rcpts, "unknown");
        return true;
      case "quota":
        await settle(seq, rcpts, "release");
        stopped = out.message;
        return false;
      case "refused":
        await settle(seq, rcpts, "release");
        stopped = refusedText(out.status, out.message);
        return false;
      case "invalid":
        // a refused batch sent nothing: split it to find the address Resend won't take
        if (rcpts.length > 1) {
          await settle(seq, rcpts, "release");
          const half = Math.ceil(rcpts.length / 2);
          for (const part of [rcpts.slice(0, half), rcpts.slice(half)]) {
            if (!(await sendNew(part))) return false;
          }
          return true;
        }
        await settle(seq, rcpts, "failed");
        await kv([["SET", noteKey(id), `Resend refused an address: ${out.message}`]]);
        singleFailsInARow++;
        if (singleFailsInARow >= 3 && sentThisStep === 0) {
          stopped = `Resend refused every message (${out.message}). Fix it, then use Retry failed.`;
          return false;
        }
        return true;
      default:
        stopped = "Resend didn't answer clearly. Resume in a minute; nobody gets it twice.";
        return false;
    }
  };

  /** Claims people, writes the batch as pending, sends it. Out of time: leaves them for the next step. */
  const sendNew = async (people: Recipient[]): Promise<boolean> => {
    if (timeUp()) return false;
    const [seqRaw] = await kv([["INCR", seqKey(id)]]);
    const seq = Number(seqRaw);
    const batch: PendingBatch = { at: now(), rcpts: people };
    const res = await kv([
      ...people.map((r) => ["SADD", claimedKey(id), r.id]),
      ["SET", batchKey(id, seq), JSON.stringify(batch)],
      ["SADD", pendingKey(id), String(seq)],
    ]);
    const mine = people.filter((_, i) => Number(res[i]) === 1);
    if (mine.length !== people.length) {
      // someone else took some of them: this batch is only the rest
      if (mine.length === 0) {
        await kv([["DEL", batchKey(id, seq)], ["SREM", pendingKey(id), String(seq)]]);
        return true;
      }
      batch.rcpts = mine;
      await kv([["SET", batchKey(id, seq), JSON.stringify(batch)]]);
    }
    return handle(seq, batch.rcpts, await deliver(seq, batch.rcpts, false));
  };

  try {
    await ensureAudience(rec, now());

    // 1. batches an earlier step left without an answer, same key as before
    const [pendingRaw] = await kv([["SMEMBERS", pendingKey(id)]]);
    const pendingSeqs = (Array.isArray(pendingRaw) ? pendingRaw : []).map(Number).filter((n) => Number.isInteger(n)).sort((a, b) => a - b);
    let go = true;
    for (const seq of pendingSeqs) {
      if (!go || timeUp()) break;
      const [raw] = await kv([["GET", batchKey(id, seq)]]);
      const batch = jsonOf<PendingBatch>(raw);
      if (!batch || !Array.isArray(batch.rcpts) || batch.rcpts.length === 0) {
        await kv([["SREM", pendingKey(id), String(seq)]]);
        continue;
      }
      if (now() - batch.at > RESEND_WINDOW_MS) {
        // the key has lapsed at Resend: sending again could send twice
        await settle(seq, batch.rcpts, "unknown");
        continue;
      }
      go = await handle(seq, batch.rcpts, await deliver(seq, batch.rcpts, true));
    }

    // 2. everyone the update goes to who isn't in a batch yet
    if (go && !timeUp()) {
      const [leftRaw] = await kv([["SDIFF", audienceKey(id), claimedKey(id)]]);
      const left = (Array.isArray(leftRaw) ? leftRaw : []).map(String).sort();
      for (let i = 0; go && i < left.length && !timeUp(); i += size) {
        const ids = left.slice(i, i + size);
        const subs = await kv(ids.map((sid) => ["GET", subscriberKey(sid)]));
        const people: Recipient[] = [];
        const gone: string[] = [];
        subs.forEach((raw, j) => {
          const s = jsonOf<UpdatesSubscriber>(raw);
          if (s && s.email && s.token) people.push({ id: ids[j]!, email: s.email, token: s.token });
          else gone.push(ids[j]!);
        });
        // they unsubscribed since the update started: they get nothing, and aren't left to do
        if (gone.length) await kv([["SADD", claimedKey(id), ...gone]]);
        if (people.length) go = await sendNew(people);
      }
    }

    const progress = await progressOf(rec);
    if (stopped) {
      await kv([["SET", noteKey(id), stopped]]);
      return { ...progress, stopped };
    }
    // a step that ran clean clears an old stop reason; a refused address stays noted while it counts
    if (progress.failed === 0) await kv([["DEL", noteKey(id)]]);
    if (progress.left === 0 && progress.pending === 0) {
      rec.status = "sent";
      rec.finishedAt = now();
      await saveRecord(rec);
      return { ...progress, status: "sent", left: 0, done: true };
    }
    return progress;
  } finally {
    const [held] = await kv([["GET", lockKey(id)]]).catch(() => [null]);
    if (held === lock) await kv([["DEL", lockKey(id)]]).catch(() => undefined);
  }
}

/**
 * Puts the people Resend refused back in line, for after the cause is fixed.
 * Safe: a refused message never went out.
 */
export async function retryFailed(id: string): Promise<SendProgress> {
  const rec = await getUpdate(id);
  if (!rec) throw new MailInputError("No update with that id.");
  const [failed] = await kv([["SMEMBERS", failedKey(id)]]);
  const ids = Array.isArray(failed) ? failed.map(String) : [];
  if (ids.length) {
    await kv([
      ["SREM", claimedKey(id), ...ids],
      ["DEL", failedKey(id)],
      ["HINCRBY", countsKey(id), "failed", -ids.length],
      ["DEL", noteKey(id)],
    ]);
    if (rec.status === "sent") {
      rec.status = "sending";
      rec.finishedAt = null;
      await saveRecord(rec);
    }
  }
  return progressOf(rec);
}

// ------------------------------------------------------------------ reading

export type AdminUpdate = Omit<SendProgress, "busy" | "stopped"> & {
  subject: string;
  day: string;
  createdAt: number;
  finishedAt: number | null;
  published: boolean;
  /** The last reason a step stopped, or a refused address. */
  note: string | null;
};

/** Every update, newest first, with its counts. For the admin. */
export async function listUpdatesForAdmin(): Promise<AdminUpdate[]> {
  const [idsRaw] = await kv([["LRANGE", MAILS, 0, -1]]);
  const ids = Array.isArray(idsRaw) ? idsRaw.map(String) : [];
  const out: AdminUpdate[] = [];
  for (const id of ids) {
    const [raw, note] = await kv([["GET", recKey(id)], ["GET", noteKey(id)]]);
    const rec = jsonOf<UpdateRecord>(raw);
    if (!rec) continue;
    const p = await progressOf(rec);
    out.push({
      id: rec.id,
      status: rec.status,
      sent: p.sent,
      failed: p.failed,
      unknown: p.unknown,
      left: p.left,
      pending: p.pending,
      done: p.done,
      subject: rec.subject,
      day: rec.day,
      createdAt: rec.createdAt,
      finishedAt: rec.finishedAt,
      published: rec.published,
      note: typeof note === "string" ? note : null,
    });
  }
  return out;
}

/** What /updates shows of an update: never who got it or how many. */
export type PublicUpdate = { id: string; subject: string; body: string; day: string };

const toPublic = (r: UpdateRecord): PublicUpdate => ({ id: r.id, subject: r.subject, body: r.body, day: r.day });

/** An update that went out, for its web page. */
export async function getPublishedUpdate(id: string): Promise<PublicUpdate | null> {
  const rec = await getUpdate(id);
  return rec && rec.published ? toPublic(rec) : null;
}

/** Every update that went out, newest first. */
export async function listPublishedUpdates(): Promise<PublicUpdate[]> {
  const [idsRaw] = await kv([["LRANGE", MAILS, 0, -1]]);
  const ids = Array.isArray(idsRaw) ? idsRaw.map(String) : [];
  if (ids.length === 0) return [];
  const raws = await kv(ids.map((id) => ["GET", recKey(id)]));
  return raws
    .map((r) => jsonOf<UpdateRecord>(r))
    .filter((r): r is UpdateRecord => !!r && r.published)
    .map(toPublic);
}
