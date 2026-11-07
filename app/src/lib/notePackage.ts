/**
 * Portable **payment tickets** for Gloam vault pay.
 * Not a traditional address transfer, bearer secret for a vault note.
 * - Compact: gloam1.<base64url>
 * - Optional passphrase: gloam1e.<base64url> (AES-GCM)
 * Still accepts legacy JSON for older shares.
 *
 * A package can carry the payer's private note ("Invoice 042", lib/paymentNote)
 * under its own key: `n` in the compact form, `note` in the full JSON that
 * gloam1e locks. It is optional both ways: packages without it decode as
 * before, and older app versions skip the key they do not know. The note only
 * ever sits inside the payment (sealed, locked or in a claim link's fragment).
 */

import type { Address, Hex } from "viem";
import { NATIVE_ASSET } from "./shield";
import { cleanPaymentNote } from "./paymentNote";
import { codeFromLinkText } from "./claimLink";
import { SHORT_CLAIM_PREFIX, decodeShortClaim, seedMakesSecret, shortClaimBodyIn } from "@gloamtrade/sdk";

export type NotePackage = {
  v: 1;
  type: "gloam-private-note";
  scheme: "poseidon";
  pool: Address;
  asset: Address;
  amountWei: string;
  secret: Hex;
  commitment: Hex;
  message?: string;
  /** The payer's private note to the payee, cleaned, at most 80 characters. */
  note?: string;
  /**
   * The chain the payment is on. The vault has one address on every chain and
   * native ETH is 0x0 on all of them, so pool and asset can't tell Base from
   * Base Sepolia or Ethereum. Codes made since 25 Oct 2026 carry it (`ch`);
   * older ones don't, and are matched on pool and asset as before.
   */
  chainId?: number;
  /**
   * The 16-byte seed (hex) the secret was made from, for payments made since
   * short links (lib/claimLink): the short link carries the seed instead of the
   * secret. `sd` in the compact form; older readers skip it.
   */
  seed?: Hex;
};

const PREFIX_PLAIN = "gloam1.";
const PREFIX_ENC = "gloam1e.";

function b64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + pad;
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function utf8Decode(b: Uint8Array): string {
  return new TextDecoder().decode(b);
}

/** Fresh ArrayBuffer-backed view, satisfies strict BufferSource typing (TS 5.x). */
function buf(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(bytes.byteLength);
  out.set(bytes);
  return out;
}

export function buildNotePackage(args: {
  pool: Address;
  asset?: Address;
  amountWei: string;
  secret: Hex;
  commitment: Hex;
  /** Optional private note for the payee ("Invoice 042"). */
  note?: string;
  /** The chain the payment is on: every new code names it. */
  chainId?: number;
  /** The seed the secret was made from, when it was. Kept only when it makes the secret. */
  seed?: Hex;
}): NotePackage {
  const note = cleanPaymentNote(args.note);
  return {
    v: 1,
    type: "gloam-private-note",
    scheme: "poseidon",
    pool: args.pool,
    asset: args.asset ?? NATIVE_ASSET,
    amountWei: args.amountWei,
    secret: args.secret,
    commitment: args.commitment,
    message: "Gloam payment, import under Move → Receive. Keep secret.",
    ...(note ? { note } : {}),
    ...(validChainId(args.chainId) ? { chainId: args.chainId } : {}),
    ...(seedMakesSecret(args.seed, args.secret) ? { seed: args.seed } : {}),
  };
}

function validChainId(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v > 0;
}

/** The chain a code names (`ch`, or `chainId` in the long form), or nothing for an older code. */
function chainOf(obj: Record<string, unknown>): { chainId?: number } {
  const v = obj.ch ?? obj.chainId;
  const n = typeof v === "string" && /^\d{1,12}$/.test(v) ? Number(v) : v;
  return validChainId(n) ? { chainId: n } : {};
}

/** The package as short-keyed JSON, the form both plain and locked codes carry. */
function compactJson(pack: NotePackage): string {
  const note = cleanPaymentNote(pack.note);
  return JSON.stringify({
    v: pack.v,
    t: pack.type,
    s: pack.scheme,
    p: pack.pool,
    a: pack.asset,
    w: pack.amountWei,
    k: pack.secret,
    c: pack.commitment,
    // The chain, when known: older readers skip a key they don't know.
    ...(validChainId(pack.chainId) ? { ch: pack.chainId } : {}),
    // Only when there is one, so a package without a note is byte-for-byte the old format.
    ...(note ? { n: note } : {}),
    // The seed, only when it makes the secret (the SDK writes the same key).
    ...(seedMakesSecret(pack.seed, pack.secret) ? { sd: pack.seed } : {}),
  });
}

/** Compact share string (no passphrase). */
export function encodeNotePackage(pack: NotePackage): string {
  return PREFIX_PLAIN + b64urlEncode(utf8(compactJson(pack)));
}

/**
 * How a phrase is matched: capitals, extra spaces and curly quotes do not count.
 * Phone keyboards capitalise the first letter and curl apostrophes, so the right
 * phrase typed on a phone used to fail with "Wrong passphrase".
 */
export function canonicalPhrase(passphrase: string): string {
  return tidyPhrase(passphrase).toLowerCase();
}

function tidyPhrase(passphrase: string): string {
  return passphrase
    .normalize("NFKC")
    .replace(/[\u2018\u2019\u201A\u201B\u2032]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F\u2033]/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Phrases to try on a locked code: the matched form first (codes made since
 * 16 Oct 2026), then the phrase as typed and its near misses for older codes,
 * which were locked with the exact phrase.
 */
function phraseCandidates(passphrase: string): string[] {
  const tidy = tidyPhrase(passphrase);
  const flipped = tidy
    ? (tidy[0] === tidy[0].toUpperCase() ? tidy[0].toLowerCase() : tidy[0].toUpperCase()) + tidy.slice(1)
    : tidy;
  return [...new Set([canonicalPhrase(passphrase), passphrase.trim(), tidy, flipped])].filter(Boolean);
}

/**
 * PBKDF2 rounds. Codes locked from 20 Oct 2026 use 310,000 (OWASP's floor for
 * PBKDF2-SHA256); older ones used 120,000 and still open. The count isn't in the
 * code, so opening tries the current one first.
 */
const PBKDF2_ROUNDS = 310_000;
const PBKDF2_ROUNDS_BEFORE = [120_000];

async function deriveKey(passphrase: string, salt: Uint8Array, iterations = PBKDF2_ROUNDS): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey(
    "raw",
    buf(utf8(passphrase)),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: buf(salt),
      iterations,
      hash: "SHA-256",
    },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

/** Encrypt package with a shared passphrase (sender tells recipient the phrase). */
export async function encodeNotePackageEncrypted(
  pack: NotePackage,
  passphrase: string
): Promise<string> {
  if (!passphrase.trim()) throw new Error("Passphrase required");
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(canonicalPhrase(passphrase), salt);
  // The same short-keyed JSON as a plain code, so a locked link is barely longer
  // than an open one. Readers have always accepted both key styles.
  const plain = buf(utf8(compactJson(pack)));
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: buf(iv) }, key, plain)
  );
  const out = new Uint8Array(salt.length + iv.length + cipher.length);
  out.set(salt, 0);
  out.set(iv, 16);
  out.set(cipher, 28);
  return PREFIX_ENC + b64urlEncode(out);
}

/** The note as the payee keeps it: whatever the sender put there, cleaned again. */
function noteOf(obj: Record<string, unknown>): { note?: string } {
  const note = cleanPaymentNote(obj.note ?? obj.n);
  return note ? { note } : {};
}

/** The seed a code carries (`sd`), only when it makes the code's secret. */
function seedOf(obj: Record<string, unknown>, secret: unknown): { seed?: Hex } {
  const sd = obj.sd ?? obj.seed;
  return typeof sd === "string" && typeof secret === "string" && seedMakesSecret(sd, secret) ? { seed: sd as Hex } : {};
}

/** Notes are range checked to < 2^128 in every Gloam circuit. */
const AMOUNT_LIMIT = 1n << 128n;

/**
 * An amount the circuits can hold: plain digits below 2^128. Poseidon reads the
 * amount mod the field prime, so a code claiming amount + p would open the same
 * note as the real one and show a balance it does not have.
 */
function amountInRange(w: string): boolean {
  return /^\d{1,39}$/.test(w) && BigInt(w) < AMOUNT_LIMIT;
}

function expandCompact(obj: Record<string, unknown>): NotePackage | null {
  const pack = readFields(obj);
  return pack && amountInRange(pack.amountWei) ? pack : null;
}

function readFields(obj: Record<string, unknown>): NotePackage | null {
  if (obj.t !== "gloam-private-note" && obj.type !== "gloam-private-note") {
    // compact form uses t/s/p/a/w/k/c
    if (obj.t && obj.k && obj.w) {
      return {
        v: 1,
        type: "gloam-private-note",
        scheme: "poseidon",
        pool: String(obj.p) as Address,
        asset: (String(obj.a || NATIVE_ASSET) as Address),
        amountWei: String(obj.w),
        secret: String(obj.k) as Hex,
        commitment: String(obj.c || "0x") as Hex,
        ...noteOf(obj),
        ...chainOf(obj),
        ...seedOf(obj, obj.k),
      };
    }
    return null;
  }
  return {
    v: 1,
    type: "gloam-private-note",
    scheme: "poseidon",
    pool: String(obj.pool || obj.p) as Address,
    asset: String(obj.asset || obj.a || NATIVE_ASSET) as Address,
    amountWei: String(obj.amountWei || obj.w),
    secret: String(obj.secret || obj.k) as Hex,
    commitment: String(obj.commitment || obj.c || "0x") as Hex,
    message: obj.message ? String(obj.message) : undefined,
    ...noteOf(obj),
    ...chainOf(obj),
    ...seedOf(obj, obj.secret || obj.k),
  };
}

/**
 * Parse legacy JSON, gloam1.*, gloam1e.* (passphrase), or gloam2t.* (receive tag).
 * For gloam2t, pass `tryTagDecrypt: true` to use this browser’s viewing key.
 */
export async function decodeNotePackage(
  input: string,
  passphrase?: string,
  opts?: { tryTagDecrypt?: boolean }
): Promise<NotePackage> {
  try {
    return await decodeCode(paymentCodeIn(input), passphrase, opts);
  } catch (err) {
    // A code an email or chat broke over lines reads short. Try it with the
    // following pieces joined back on; only a reading that opens is taken
    // (a plain code must parse, a locked or sealed one must decrypt).
    for (const longer of wrappedCodeCandidates(input)) {
      try {
        return await decodeCode(longer, passphrase, opts);
      } catch {
        /* the next reading */
      }
    }
    throw err;
  }
}

async function decodeCode(
  code: string,
  passphrase?: string,
  opts?: { tryTagDecrypt?: boolean }
): Promise<NotePackage> {
  const s = codeFromLinkText(code);

  // A short claim link's code (gloam.trade/c#...): the commitment is worked out again.
  if (s.startsWith(SHORT_CLAIM_PREFIX)) {
    const f = await decodeShortClaim(s.slice(SHORT_CLAIM_PREFIX.length));
    return buildNotePackage({
      pool: f.pool,
      asset: f.asset,
      amountWei: f.amountWei,
      secret: f.secret,
      commitment: f.commitment,
      note: f.note,
      chainId: f.chainId,
      seed: f.seed,
    });
  }

  // Pay-to-tag sealed package, only recipient’s receive key opens it
  if (s.startsWith("gloam2t.")) {
    if (!opts?.tryTagDecrypt) {
      throw new Error(
        "This ticket is encrypted to a receive tag. Claim it in the browser that owns that tag."
      );
    }
    const { decryptTicketWithLocalTag } = await import("./receiveTag");
    const inner = await decryptTicketWithLocalTag(s);
    // Recurse without tag prefix (inner is gloam1 / gloam1e / JSON)
    return decodeNotePackage(inner, passphrase, { tryTagDecrypt: false });
  }

  if (s.startsWith(PREFIX_ENC)) {
    if (!passphrase?.trim()) {
      throw new Error("This payment is locked, enter the passphrase from the sender.");
    }
    const raw = b64urlDecode(s.slice(PREFIX_ENC.length));
    if (raw.length < 29) throw new Error("Corrupt locked payment.");
    const salt = raw.slice(0, 16);
    const iv = raw.slice(16, 28);
    const cipher = raw.slice(28);
    let plain: Uint8Array | null = null;
    rounds: for (const iterations of [PBKDF2_ROUNDS, ...PBKDF2_ROUNDS_BEFORE]) {
      for (const phrase of phraseCandidates(passphrase)) {
        try {
          const key = await deriveKey(phrase, salt, iterations);
          plain = new Uint8Array(
            await crypto.subtle.decrypt({ name: "AES-GCM", iv: buf(iv) }, key, buf(cipher))
          );
          break rounds;
        } catch {
          /* try the next form */
        }
      }
    }
    if (!plain) throw new Error("Wrong passphrase or corrupt payment.");
    try {
      const pack = expandCompact(JSON.parse(utf8Decode(plain)) as Record<string, unknown>);
      if (!pack?.secret || !pack.amountWei) throw new Error("Invalid payment.");
      return pack;
    } catch {
      throw new Error("Wrong passphrase or corrupt payment.");
    }
  }

  if (s.startsWith(PREFIX_PLAIN)) {
    const body = s.slice(PREFIX_PLAIN.length);
    const pack = readPlainBody(body) ?? readRepairedBody(body);
    if (!pack) {
      throw new Error(
        "This payment code is damaged, often when it is copied from a screenshot. Ask the sender to send the link as text and paste the whole link."
      );
    }
    return pack;
  }

  // Legacy pretty JSON
  if (s.startsWith("{")) {
    const pack = expandCompact(JSON.parse(s) as Record<string, unknown>);
    if (!pack?.secret || !pack.amountWei) {
      throw new Error("Not a valid Gloam payment package.");
    }
    return pack;
  }

  throw new Error(
    "That isn't a whole Gloam payment. Paste the full claim link, or the code that starts with gloam1, gloam1e or gloam2t. If the sender's message cut it off, ask them to send it again."
  );
}

/** A plain code's body as a package, or null when it does not read as one. */
function readPlainBody(body: string): NotePackage | null {
  try {
    const pack = expandCompact(JSON.parse(utf8Decode(b64urlDecode(body))) as Record<string, unknown>);
    return pack?.secret && pack.amountWei ? pack : null;
  } catch {
    return null;
  }
}

/**
 * A plain code whose letters changed case, read with the case put back. The
 * money fields come back exactly; the note's own capitals are a guess, so the
 * note is left out, and the addresses are written in small letters, which
 * every check accepts, instead of a checksum casing that may be off.
 */
function readRepairedBody(body: string): NotePackage | null {
  const pack = readPlainBody(repairLetterCase(body));
  if (!pack) return null;
  const { note: _guessed, message: _alsoGuessed, ...rest } = pack;
  void _guessed;
  void _alsoGuessed;
  return { ...rest, pool: pack.pool.toLowerCase() as Address, asset: pack.asset.toLowerCase() as Address, secret: pack.secret.toLowerCase() as Hex, commitment: pack.commitment.toLowerCase() as Hex };
}

const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/**
 * How much a decoded byte looks like a package's JSON. Secrets and commitments
 * are small-letter hex, so those digits and the JSON punctuation score highest;
 * capital hex (checksummed addresses) and other text less; anything else nothing.
 */
function jsonish(byte: number): number {
  const ch = String.fromCharCode(byte);
  if (/[0-9a-f"{}:,]/.test(ch)) return 6;
  if (/[xA-F]/.test(ch)) return 3;
  if (/[a-zA-Z .!'-]/.test(ch)) return 1;
  return byte >= 0x20 && byte < 0x7f ? 0 : -6;
}

/**
 * A plain code with its letters' case changed on the way (a phone's text
 * recognition, an app that lowercases links) still holds every bit except
 * which letters were capitals. Each group of four characters decodes to three
 * bytes on its own, so try the capitals and small letters of each group and
 * keep the one that reads most like the package's JSON. A wrong guess cannot
 * spend anything: the claim checks the code's secret against its commitment.
 */
function repairLetterCase(body: string): string {
  let out = "";
  for (let i = 0; i < body.length; i += 4) {
    const group = body.slice(i, i + 4);
    const letters = [...group].map((ch, j) => (/[a-z]/i.test(ch) ? j : -1)).filter((j) => j >= 0);
    let best = group;
    let bestScore = -1;
    for (let mask = 0; mask < 1 << letters.length; mask++) {
      const chars = [...group];
      letters.forEach((j, bit) => {
        chars[j] = mask & (1 << bit) ? chars[j]!.toUpperCase() : chars[j]!.toLowerCase();
      });
      const v = chars.map((ch) => B64URL.indexOf(ch));
      if (v.some((x) => x < 0)) continue;
      const bytes = [(v[0]! << 2) | ((v[1] ?? 0) >> 4), (((v[1] ?? 0) & 15) << 4) | ((v[2] ?? 0) >> 2), (((v[2] ?? 0) & 3) << 6) | (v[3] ?? 0)];
      const used = Math.max(0, chars.length - 1);
      const score = bytes.slice(0, used).reduce((sum, b) => sum + jsonish(b), 0);
      if (score > bestScore) {
        bestScore = score;
        best = chars.join("");
      }
    }
    out += best;
  }
  return out;
}

/** A code inside a longer paste: up to the first character a code never has. */
// A code, with the dot after its prefix ("gloam1.") or what links write
// instead ("gloam1=", older "gloam1-"); lib/claimLink codeFromLinkText reads those back.
// A short claim link's code is "gloam3." and letters and digits.
const CODE_IN_TEXT = /gloam(?:2t|1e|1|3)[.=-][A-Za-z0-9_\-.=]+/;

/**
 * The payment code in whatever was pasted. People paste the whole claim link
 * (gloam.trade/claim?...#claim=gloam1%2E...), the code with its dot still
 * written %2E, the code inside a longer message, or only the part after
 * "gloam1." when a chat app linked just the start of it. All of these hold the
 * same code, so all of them claim.
 */
/** What was pasted, from the "#claim=" part on when there is one, with %-escapes undone. */
function pastedText(input: string): string {
  let s = input.trim();
  // A short claim link (…/c#<letters and digits>): read as its gloam3 code.
  const short = s.search(/\/c(?:#|%23)[0-9A-Za-z]{8,}/);
  if (short !== -1 && shortClaimBodyIn(s.slice(short))) {
    return s.slice(short).replace(/^\/c(?:#|%23)/, "gloam3=");
  }
  const hashAt = s.search(/(?:#|%23)claim(?:=|%3D)/i);
  if (hashAt !== -1) s = s.slice(hashAt).replace(/^(?:#|%23)claim(?:=|%3D)/i, "");
  if (s.includes("%")) {
    try {
      s = decodeURIComponent(s);
    } catch {
      // keep it as pasted
    }
  }
  return s;
}

/**
 * Longer readings of a code that a line break or space cut short: the code
 * with the next piece joined on, then the next two, and so on. A piece that
 * ends in other punctuation ends the code.
 */
export function wrappedCodeCandidates(input: string): string[] {
  const s = pastedText(input);
  const at = s.search(CODE_IN_TEXT);
  if (at === -1) return [];
  const pieces = s.slice(at).split(/\s+/);
  const out: string[] = [];
  let joined = pieces[0]!.match(CODE_IN_TEXT)?.[0] ?? "";
  if (joined.length !== pieces[0]!.length) return [];
  for (let i = 1; i < pieces.length && i <= 8; i++) {
    const piece = pieces[i]!.match(/^[A-Za-z0-9_\-.=]+/)?.[0];
    if (!piece) break;
    joined += piece;
    out.push(joined.replace(/\.+$/, ""));
    if (piece.length !== pieces[i]!.length) break;
  }
  return out;
}

export function paymentCodeIn(input: string): string {
  if (input.trim().startsWith("{")) return input.trim(); // an old JSON package
  const s = pastedText(input);
  const found = s.match(CODE_IN_TEXT) ?? s.replace(/\s+/g, "").match(CODE_IN_TEXT);
  if (found) return codeFromLinkText(found[0].replace(/[.=]+$/, ""));
  // "gloam1." lost on the way: a plain code's body is base64 JSON, which starts
  // "eyJ". WhatsApp cut links at "gloam1" and left the rest as text starting
  // "%2EeyJ", so a leading dot (or "=" or "-") is dropped too.
  const body = s.replace(/\s+/g, "").replace(/^[.=-]+/, "");
  if (/^eyJ[A-Za-z0-9_-]{20,}$/.test(body)) return PREFIX_PLAIN + body;
  return s;
}

export function isEncryptedPackage(input: string): boolean {
  const t = paymentCodeIn(input);
  return t.startsWith(PREFIX_ENC) || t.startsWith("gloam2t.");
}

export function isPayToTagSealed(input: string): boolean {
  return paymentCodeIn(input).startsWith("gloam2t.");
}

export function formatAmountEth(wei: string): string {
  try {
    const n = Number(wei) / 1e18;
    if (!Number.isFinite(n)) return wei;
    if (n === 0) return "0";
    if (n < 0.0001) return "<0.0001";
    return n.toLocaleString(undefined, { maximumFractionDigits: 6 });
  } catch {
    return wei;
  }
}
