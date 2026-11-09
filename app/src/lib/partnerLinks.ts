/**
 * Partner link codes: what a pay link or a swap link carries as `p=<code>` so a
 * payment or swap opened from a partner's link is counted to that partner
 * (lib/partnerAttribution). Server only.
 *
 * A code is 20 random letters and digits (about 119 bits) made here, stored
 * here and mapped to one partner account. A name in a link (`name`, `ref`) is
 * whatever its maker typed and counts for nothing; only a code this store issued,
 * still live, does. A code is not a secret: it sits in every link the partner
 * shares. It only says which partner a link is from. A revoked or expired code
 * counts for nothing from then on; what it counted before stays counted.
 *
 * Bounded: an account holds at most MAX_LIVE_CODES live codes and MAX_CODES in
 * all; a revoked code's record goes away REVOKED_TTL_SEC after it was revoked
 * (or expired), and listing reads only what is still there.
 *
 * Storage (lib/partnersKv), under gloam:partners:v1:
 *   link:<code>             the code's record (JSON)
 *   links:<partnerId>       set of the partner's codes still on record
 *   links-live:<partnerId>  set of its live codes
 */
import { randomInt } from "crypto";
import { cleanText } from "./paymentNote";
import { jsonOf, k, kv, kv1, type KvCommand } from "./partnersKv";
import { getPartner, PartnerError, type Partner } from "./partners";
import { isLinkCodeShape, LINK_CODE_LENGTH } from "./partnerCode";

export { isLinkCodeShape, LINK_CODE_LENGTH };
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/** Live codes a partner may hold at once. */
export const MAX_LIVE_CODES = 20;
/** Codes a partner may have on record at once, live, revoked or expired. */
export const MAX_CODES = 100;
/** How long a revoked or expired code's record is kept, for the partner's list. */
export const REVOKED_TTL_SEC = 30 * 86_400;
export const LINK_LABEL_MAX = 40;
/** The longest a code can be set to last, in days; no expiry when none is asked for. */
export const MAX_EXPIRY_DAYS = 730;

export type LinkCode = {
  code: string;
  partnerId: string;
  /** What the partner calls it ("Fund button", "Swap page"). */
  label: string;
  createdAt: number;
  /** Who made it. */
  createdBy: "partner" | "admin";
  /** ms; null: no expiry. */
  expiresAt: number | null;
  revokedAt: number | null;
};

/** A new code: uniform over the alphabet (no modulo bias). */
export function generateLinkCode(): string {
  let out = "";
  for (let i = 0; i < LINK_CODE_LENGTH; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}

export function linkCodeState(c: LinkCode, now = Date.now()): "live" | "revoked" | "expired" {
  if (c.revokedAt != null) return "revoked";
  if (c.expiresAt != null && c.expiresAt <= now) return "expired";
  return "live";
}

/** What a code looks like over the wire, to its partner or an admin. */
export function linkCodeView(c: LinkCode, now = Date.now()) {
  return { ...c, state: linkCodeState(c, now) };
}

export async function getLinkCode(code: string): Promise<LinkCode | null> {
  if (!isLinkCodeShape(code)) return null;
  return jsonOf<LinkCode>(await kv1(["GET", k("link", code)]));
}

/**
 * Every code a partner holds, newest first: live, and revoked or expired ones
 * still on record. Codes whose record went away are dropped from the sets, and
 * an expired code leaves the live set and starts its own expiry.
 */
export async function listLinkCodes(partnerId: string, now = Date.now()): Promise<LinkCode[]> {
  const [all, liveSet] = await kv([
    ["SMEMBERS", k("links", partnerId)],
    ["SMEMBERS", k("links-live", partnerId)],
  ]);
  const codes = (Array.isArray(all) ? all : []) as string[];
  if (codes.length === 0) return [];
  const live = new Set(Array.isArray(liveSet) ? (liveSet as string[]) : []);
  const raw = await kv(codes.map((c) => ["GET", k("link", c)] as KvCommand));
  const tidy: KvCommand[] = [];
  const out: LinkCode[] = [];
  codes.forEach((code, i) => {
    const c = jsonOf<LinkCode>(raw[i]);
    if (!c || c.partnerId !== partnerId) {
      tidy.push(["SREM", k("links", partnerId), code], ["SREM", k("links-live", partnerId), code]);
      return;
    }
    // an expired code leaves the live set once, and its record's 30 days start then, not on every read
    if (linkCodeState(c, now) === "expired" && live.has(code)) {
      tidy.push(["SREM", k("links-live", partnerId), code], ["EXPIRE", k("link", code), REVOKED_TTL_SEC]);
    }
    out.push(c);
  });
  if (tidy.length) await kv(tidy).catch(() => undefined);
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

/** Issues a new code for a partner. `expiresInDays`: whole days, 1 to MAX_EXPIRY_DAYS, or none. */
export async function issueLinkCode(args: {
  partnerId: string;
  label?: unknown;
  expiresInDays?: unknown;
  by: "partner" | "admin";
  now?: number;
}): Promise<LinkCode> {
  const now = args.now ?? Date.now();
  if (!(await getPartner(args.partnerId))) throw new PartnerError("No partner with that id.", 404, "not_found");
  const label = cleanText(typeof args.label === "string" ? args.label : "", LINK_LABEL_MAX);
  let expiresAt: number | null = null;
  if (args.expiresInDays != null && args.expiresInDays !== "") {
    const d = typeof args.expiresInDays === "string" ? Number(args.expiresInDays) : args.expiresInDays;
    if (typeof d !== "number" || !Number.isInteger(d) || d < 1 || d > MAX_EXPIRY_DAYS) {
      throw new PartnerError(`Expiry must be a whole number of days from 1 to ${MAX_EXPIRY_DAYS}, or none.`, 400, "bad_expiry");
    }
    expiresAt = now + d * 86_400_000;
  }
  const all = await listLinkCodes(args.partnerId, now);
  if (all.filter((c) => linkCodeState(c, now) === "live").length >= MAX_LIVE_CODES) {
    throw new PartnerError(`An account can hold ${MAX_LIVE_CODES} live link codes. Revoke one first.`, 400, "too_many_codes");
  }
  if (all.length >= MAX_CODES) {
    throw new PartnerError(`An account can have ${MAX_CODES} link codes on record. Revoked ones go after 30 days.`, 400, "too_many_codes");
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    const c: LinkCode = {
      code: generateLinkCode(),
      partnerId: args.partnerId,
      label,
      createdAt: now,
      createdBy: args.by,
      expiresAt,
      revokedAt: null,
    };
    const [set] = await kv([["SET", k("link", c.code), JSON.stringify(c), "NX"]]);
    if (set !== "OK") continue; // never happens at 119 bits
    await kv([
      ["SADD", k("links", c.partnerId), c.code],
      ["SADD", k("links-live", c.partnerId), c.code],
    ]);
    return c;
  }
  throw new PartnerError("Could not make a code. Try again.", 500, "internal");
}

/**
 * Revokes a code. Only the partner it belongs to can, or an admin (no partnerId).
 * Revoking twice keeps the first time. The record stays REVOKED_TTL_SEC, then goes.
 * Null when there is no such code for them.
 */
export async function revokeLinkCode(args: { code: string; partnerId?: string; now?: number }): Promise<LinkCode | null> {
  const c = await getLinkCode(args.code);
  if (!c || (args.partnerId !== undefined && c.partnerId !== args.partnerId)) return null;
  if (c.revokedAt != null) return c;
  const next: LinkCode = { ...c, revokedAt: args.now ?? Date.now() };
  await kv([
    ["SET", k("link", c.code), JSON.stringify(next), "EX", REVOKED_TTL_SEC],
    ["SREM", k("links-live", c.partnerId), c.code],
  ]);
  return next;
}

export type ResolvedCode = { code: LinkCode; partner: Partner };

/**
 * The partner a code counts for, or null: an unknown, malformed, revoked or
 * expired code, or one whose account is gone, counts for nobody.
 */
export async function resolveLinkCode(raw: unknown, now = Date.now()): Promise<ResolvedCode | null> {
  if (!isLinkCodeShape(raw)) return null;
  const code = await getLinkCode(raw);
  if (!code || linkCodeState(code, now) !== "live") return null;
  const partner = await getPartner(code.partnerId);
  return partner ? { code, partner } : null;
}
