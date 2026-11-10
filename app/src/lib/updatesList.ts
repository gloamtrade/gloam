/**
 * The "Email me Gloam updates" list. Server only.
 *
 * Stored in the partner program's store (lib/partnersKv: Upstash Redis in
 * production, in-process locally) under its own prefix, apart from everything
 * else. A subscriber is the email alone, with:
 *  - the day they asked (a UTC date, not a time, so it can't be lined up with
 *    anything else that happened that minute),
 *  - where they asked ("sign-in", "settings" or "site"),
 *  - a random unsubscribe token for the link in each update.
 * Never a wallet address, a Gloam wallet id, a Turnkey sub-org id, an IP or a
 * device. The route refuses a request that carries any field besides the email
 * and where it came from, and nothing here takes one.
 *
 * Subscribers sit in a set, not a list, so the store keeps no order of sign-ups
 * either. The rate limit holds a hashed IP in its own keys for up to two hours.
 */
import { createHash, randomBytes } from "crypto";
import { jsonOf, kv } from "./partnersKv";
import { normalizeEmail, type UpdatesSource } from "./updatesEmail";

const PREFIX = "gloam:updates:v1:";
const IDS = `${PREFIX}ids`;
/** A ceiling, so a flood of made-up addresses can't fill the store. */
export const MAX_SUBSCRIBERS = 50_000;

/** A key for an email: a hash, so keys carry no raw address. */
function idFor(email: string): string {
  return createHash("sha256").update(`gloam-updates|${email}`).digest("hex").slice(0, 40);
}
const subKey = (id: string) => `${PREFIX}sub:${id}`;
const tokenKey = (token: string) => `${PREFIX}tok:${token}`;

export const UNSUBSCRIBE_TOKEN = /^[A-Za-z0-9_-]{32}$/;

export type UpdatesSubscriber = {
  email: string;
  /** The UTC day they asked, YYYY-MM-DD. */
  day: string;
  source: UpdatesSource;
  token: string;
};

export class UpdatesListFullError extends Error {
  constructor() {
    super("The updates list is full.");
    this.name = "UpdatesListFullError";
  }
}

function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/**
 * Adds an email to the list. Asking again with the same email changes nothing:
 * the first day, source and token stay. `added` is false for a repeat.
 */
export async function subscribeToUpdates(
  rawEmail: string,
  source: UpdatesSource,
  now = Date.now(),
): Promise<{ added: boolean }> {
  const email = normalizeEmail(rawEmail);
  if (!email) throw new Error("not an email");
  const id = idFor(email);

  const [count, existing] = await kv([["SCARD", IDS], ["EXISTS", subKey(id)]]);
  if (Number(existing) > 0) return { added: false };
  if (Number(count) >= MAX_SUBSCRIBERS) throw new UpdatesListFullError();

  const sub: UpdatesSubscriber = { email, day: utcDay(now), source, token: randomBytes(24).toString("base64url") };
  // the token first, so a saved subscriber always has a working unsubscribe link
  const [, claimed] = await kv([
    ["SET", tokenKey(sub.token), id],
    ["SET", subKey(id), JSON.stringify(sub), "NX"],
    ["SADD", IDS, id],
  ]);
  if (claimed === null) {
    // someone else saved this email a moment ago: theirs stays, this token goes
    await kv([["DEL", tokenKey(sub.token)]]);
    return { added: false };
  }
  return { added: true };
}

async function removeId(id: string): Promise<boolean> {
  const [raw] = await kv([["GET", subKey(id)]]);
  const sub = jsonOf<UpdatesSubscriber>(raw);
  const cmds: (string | number)[][] = [
    ["DEL", subKey(id)],
    ["SREM", IDS, id],
  ];
  if (sub?.token) cmds.push(["DEL", tokenKey(sub.token)]);
  await kv(cmds);
  return sub !== null;
}

/**
 * Takes an email off the list. True when it was on it. Never wire this to a
 * public route: anyone can type anyone's email. api/updates takes the link token.
 */
export async function unsubscribeEmail(rawEmail: string): Promise<boolean> {
  const email = normalizeEmail(rawEmail);
  if (!email) return false;
  return removeId(idFor(email));
}

/** Takes the email behind an unsubscribe link off the list. True when the link was live. */
export async function unsubscribeToken(token: string): Promise<boolean> {
  if (!UNSUBSCRIBE_TOKEN.test(token)) return false;
  const [id] = await kv([["GET", tokenKey(token)]]);
  if (typeof id !== "string") return false;
  const [raw] = await kv([["GET", subKey(id)]]);
  const sub = jsonOf<UpdatesSubscriber>(raw);
  if (!sub || sub.token !== token) {
    await kv([["DEL", tokenKey(token)]]);
    return false;
  }
  return removeId(id);
}

/** Everyone on the list, newest day first, then by email. */
export async function listUpdatesSubscribers(): Promise<UpdatesSubscriber[]> {
  const [ids] = await kv([["SMEMBERS", IDS]]);
  if (!Array.isArray(ids) || ids.length === 0) return [];
  const out: UpdatesSubscriber[] = [];
  for (let i = 0; i < ids.length; i += 500) {
    const raws = await kv(ids.slice(i, i + 500).map((id) => ["GET", subKey(String(id))]));
    for (const r of raws) {
      const sub = jsonOf<UpdatesSubscriber>(r);
      if (sub) out.push(sub);
    }
  }
  return out.sort((a, b) => (a.day === b.day ? a.email.localeCompare(b.email) : a.day < b.day ? 1 : -1));
}

/** How many are on the list, and from where. */
export function updatesSummary(subs: UpdatesSubscriber[]): { count: number; bySource: Record<UpdatesSource, number> } {
  const bySource: Record<UpdatesSource, number> = { "sign-in": 0, settings: 0, site: 0 };
  for (const s of subs) if (s.source in bySource) bySource[s.source]++;
  return { count: subs.length, bySource };
}

export function unsubscribeUrl(token: string, origin = "https://gloam.trade"): string {
  return `${origin}/unsubscribe?token=${encodeURIComponent(token)}`;
}

/**
 * A spreadsheet of the list: email, day, source, and each person's unsubscribe
 * link for the footer of an update. Cells that start like a formula are quoted as text.
 */
export function updatesCsv(subs: UpdatesSubscriber[]): string {
  const cell = (v: string) => {
    let s = v;
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return `"${s.replace(/"/g, '""')}"`;
  };
  const header = ["Email", "Signed up (UTC day)", "Source", "Unsubscribe link"];
  const rows = subs.map((s) => [s.email, s.day, s.source, unsubscribeUrl(s.token)].map(cell));
  return [header.map(cell), ...rows].map((r) => r.join(",")).join("\r\n") + "\r\n";
}
