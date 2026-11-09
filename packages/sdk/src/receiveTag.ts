/**
 * Gloam receive tags: seal a payment so only its payee can open it.
 *
 * A payee publishes a receive tag, like a shielded address:
 *
 *   gloamr1.<base64url SPKI of a P-256 ECDH public key>
 *
 * A payer seals a payment ticket to that tag:
 *
 *   gloam2t.<base64url( ephemLen (2 bytes, big endian) | ephemSpki | iv (12) | AES-GCM ciphertext )>
 *
 * The AES-256-GCM key is HKDF-SHA256 (empty salt, info "gloam-pay-to-tag-v1")
 * over the ECDH shared secret between a fresh ephemeral key and the tag. Only
 * the holder of the tag's private key can open it. The ticket inside is a
 * compact note package (gloam1.<base64url JSON>).
 *
 * Byte-compatible with the Gloam app (app/src/lib/receiveTag.ts and
 * notePackage.ts): a ticket sealed here opens in the app's Receive screen, and a
 * ticket the app seals opens here. Uses WebCrypto, so it runs in the browser
 * and in Node 20+.
 */

import type { Address, Hex } from "viem";
import { FIELD_PRIME, NATIVE_ASSET } from "./constants.js";
import { noteNullifierPoseidon } from "./note.js";
import { fieldToHex, hexToField } from "./poseidon.js";
import { cleanPaymentNote } from "./paymentNote.js";
import { seedMakesSecret } from "./shortLink.js";
import type { NoteExport } from "./witness.js";

export const RECEIVE_TAG_PREFIX = "gloamr1.";
export const SEALED_TICKET_PREFIX = "gloam2t.";
export const NOTE_PACKAGE_PREFIX = "gloam1.";

const HKDF_INFO = "gloam-pay-to-tag-v1";
const ECDH = { name: "ECDH", namedCurve: "P-256" } as const;
/** DER header of an uncompressed P-256 public key in SPKI form (id-ecPublicKey, prime256v1). */
const P256_SPKI_HEADER = "3059301306072a8648ce3d020106082a8648ce3d03010703420004";
const P256_SPKI_LENGTH = 91;

/** The private half of a receive tag, as a JWK (what the app keeps in localStorage). */
export interface ReceiveKeyJwk {
  kty?: string;
  crv?: string;
  x?: string;
  y?: string;
  d?: string;
  ext?: boolean;
  key_ops?: string[];
}

/** A receive identity: the tag to share and the private key that opens tickets sealed to it. */
export interface ReceiveKey {
  tag: string;
  privateJwk: ReceiveKeyJwk;
  createdAt?: number;
}

type WebCryptoKey = Awaited<ReturnType<typeof crypto.subtle.importKey>>;

// ── encoding helpers (same alphabet and padding rules as the app) ─────────────

function b64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Fresh ArrayBuffer-backed copy, so strict BufferSource typing accepts it. */
function buf(bytes: Uint8Array) {
  const out = new Uint8Array(bytes.byteLength);
  out.set(bytes);
  return out;
}

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

// P-256 (secp256r1): y^2 = x^3 - 3x + b over the prime field p.
const P256_P = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn;
const P256_B = 0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604bn;

/**
 * Whether an uncompressed point (x | y, 32 bytes each) is on P-256. A tag with
 * the right header and length but a point off the curve passes a shape check
 * and only fails when a payment is sealed to it ("DataError: Invalid keyData"),
 * so it is refused here, when the tag is read.
 */
function onP256(xy: Uint8Array): boolean {
  if (xy.length !== 64) return false;
  const x = BigInt(`0x${hex(xy.subarray(0, 32))}`);
  const y = BigInt(`0x${hex(xy.subarray(32))}`);
  if (x >= P256_P || y >= P256_P) return false;
  const rhs = (((x * x) % P256_P) * x - 3n * x + P256_B) % P256_P;
  return (y * y) % P256_P === (rhs + P256_P) % P256_P;
}

// ── tags ──────────────────────────────────────────────────────────────────────

/** The public key bytes inside a receive tag, or null if it is not a well-formed tag. */
function tagSpki(tag: string): Uint8Array | null {
  const t = tag.trim();
  if (!t.startsWith(RECEIVE_TAG_PREFIX)) return null;
  const body = t.slice(RECEIVE_TAG_PREFIX.length);
  if (!/^[A-Za-z0-9_-]+$/.test(body)) return null;
  let spki: Uint8Array;
  try {
    spki = b64urlDecode(body);
  } catch {
    return null;
  }
  if (spki.length !== P256_SPKI_LENGTH || !hex(spki).startsWith(P256_SPKI_HEADER)) return null;
  if (!onP256(spki.subarray(P256_SPKI_HEADER.length / 2))) return null;
  return spki;
}

/** True for a well-formed Gloam receive tag (gloamr1. plus a P-256 public key that is on the curve). */
export function isReceiveTag(input: string): boolean {
  return typeof input === "string" && tagSpki(input) !== null;
}

/** Throw a plain error unless `input` is a receive tag. */
export function assertReceiveTag(input: string, what = "payTo"): void {
  if (isReceiveTag(input)) return;
  const shown = typeof input === "string" && input.length > 40 ? `${input.slice(0, 24)}…` : String(input);
  throw new Error(
    `${what} must be a Gloam receive tag (gloamr1.…) so the payment can be sealed to the payee and only the payee can open it. Got "${shown}". A payee makes one with generateReceiveKey(), or copies it from the Gloam app under Receive.`
  );
}

export function isSealedTicket(input: string): boolean {
  return typeof input === "string" && input.trim().startsWith(SEALED_TICKET_PREFIX);
}

/** Make a new receive identity. Keep `privateJwk` secret; share `tag`. */
export async function generateReceiveKey(): Promise<ReceiveKey> {
  const pair = await crypto.subtle.generateKey(ECDH, true, ["deriveBits"]);
  const privateJwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as ReceiveKeyJwk;
  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey));
  return { tag: RECEIVE_TAG_PREFIX + b64urlEncode(spki), privateJwk, createdAt: Date.now() };
}

async function importPublic(spki: Uint8Array): Promise<WebCryptoKey> {
  return crypto.subtle.importKey("spki", buf(spki), ECDH, false, []);
}

async function importPrivate(jwk: ReceiveKeyJwk): Promise<WebCryptoKey> {
  return crypto.subtle.importKey("jwk", jwk, ECDH, false, ["deriveBits"]);
}

async function ecdhAesKey(privateKey: WebCryptoKey, publicKey: WebCryptoKey): Promise<WebCryptoKey> {
  const bits = await crypto.subtle.deriveBits({ name: "ECDH", public: publicKey }, privateKey, 256);
  const base = await crypto.subtle.importKey("raw", bits, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: buf(new TextEncoder().encode(HKDF_INFO)) },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

/**
 * A sealed ticket's length would show the amount's size and the note's length,
 * so the plaintext is padded with spaces to a 512-byte step. The cap is the
 * largest note package (1177 bytes: a 78-digit amount, an 8-digit chain id and
 * an 80-character note), so no ticket grows past what the memo board and the
 * relay take, and the app pads the same. Openers trim the padding off.
 */
const SEAL_PAD_STEP = 512;
const SEAL_PAD_MAX = 1177;

function padSealed(raw: Uint8Array): Uint8Array {
  if (raw.length >= SEAL_PAD_MAX) return raw;
  const out = new Uint8Array(Math.min(Math.ceil(raw.length / SEAL_PAD_STEP) * SEAL_PAD_STEP, SEAL_PAD_MAX)).fill(0x20);
  out.set(raw);
  return out;
}

/** Seal a ticket (any string, usually a gloam1. note package) so only `tag`'s owner can open it. */
export async function sealToReceiveTag(plaintext: string, tag: string): Promise<string> {
  const theirSpki = tagSpki(tag);
  if (!theirSpki) assertReceiveTag(tag, "The receive tag");
  const theirPub = await importPublic(theirSpki!);
  const ephem = await crypto.subtle.generateKey(ECDH, true, ["deriveBits"]);
  const ephemSpki = new Uint8Array(await crypto.subtle.exportKey("spki", ephem.publicKey));
  const aes = await ecdhAesKey(ephem.privateKey, theirPub);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: buf(iv) }, aes, buf(padSealed(new TextEncoder().encode(plaintext))))
  );
  const out = new Uint8Array(2 + ephemSpki.length + 12 + cipher.length);
  out[0] = (ephemSpki.length >> 8) & 0xff;
  out[1] = ephemSpki.length & 0xff;
  out.set(ephemSpki, 2);
  out.set(iv, 2 + ephemSpki.length);
  out.set(cipher, 2 + ephemSpki.length + 12);
  return SEALED_TICKET_PREFIX + b64urlEncode(out);
}

/** Open a gloam2t. ticket with the receive key it was sealed to (padding trimmed). Throws if it was sealed to someone else. */
export async function openSealedTicket(sealed: string, key: ReceiveKey | ReceiveKeyJwk): Promise<string> {
  const s = sealed.trim();
  if (!s.startsWith(SEALED_TICKET_PREFIX)) throw new Error("Not a sealed Gloam ticket (gloam2t.…).");
  const raw = b64urlDecode(s.slice(SEALED_TICKET_PREFIX.length));
  if (raw.length < 2 + 12 + 16) throw new Error("Corrupt sealed ticket.");
  const ephemLen = (raw[0]! << 8) | raw[1]!;
  if (raw.length < 2 + ephemLen + 12 + 1) throw new Error("Corrupt sealed ticket length.");
  const ephemSpki = raw.slice(2, 2 + ephemLen);
  const iv = raw.slice(2 + ephemLen, 2 + ephemLen + 12);
  const cipher = raw.slice(2 + ephemLen + 12);
  const jwk = "privateJwk" in key ? key.privateJwk : key;
  const aes = await ecdhAesKey(await importPrivate(jwk), await importPublic(ephemSpki));
  try {
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: buf(iv) }, aes, buf(cipher));
    return new TextDecoder().decode(new Uint8Array(plain)).trimEnd();
  } catch {
    throw new Error("This ticket was sealed to a different receive tag.");
  }
}

// ── note packages (the ticket inside a seal) ─────────────────────────────────

/** A spendable note as the app shares it. `secret` is the spend authority. */
export interface NotePackage {
  v: 1;
  type: "gloam-private-note";
  scheme: "poseidon";
  pool: Address;
  asset: Address;
  amountWei: string;
  secret: Hex;
  commitment: Hex;
  message?: string;
  /** The payer's private note to the payee (an invoice number, an agent ID), cleaned, at most 80 characters. */
  note?: string;
  /**
   * The chain the payment is on. The vault has one address on every chain and
   * native ETH is 0x0 everywhere, so pool and asset alone can't tell Base from
   * Base Sepolia or Ethereum. Packages made since SDK 0.4.0 carry it (`ch`);
   * older ones don't, and readers skip a key they don't know.
   */
  chainId?: number;
  /** The 16-byte seed (hex) the secret was made from, when it was: lets the payment have a short link. */
  seed?: Hex;
}

function validChainId(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v > 0;
}

/** Notes are range checked to < 2^128 in every Gloam circuit. */
const AMOUNT_LIMIT = 1n << 128n;

const FIELD_HEX = /^0x[0-9a-fA-F]{1,64}$/;

/**
 * Why a note's fields are not the values the circuits see, or null when they
 * are. Poseidon reduces its inputs modulo the field prime, so a note claiming
 * amount + p (or secret + p) opens the same commitment as the real one: a payer
 * holding 1 base unit could claim it holds 1 + p. Only canonical fields count:
 * secret and commitment below the field prime, the amount in plain digits below
 * 2^128, and the asset a 20-byte address.
 */
export function noteFieldProblem(note: { secret: string; commitment: string; amountWei: string; asset: string }): string | null {
  const { secret, commitment, amountWei, asset } = note;
  if (typeof secret !== "string" || !FIELD_HEX.test(secret) || BigInt(secret) >= FIELD_PRIME) {
    return "The secret is not a field element.";
  }
  if (typeof commitment !== "string" || !FIELD_HEX.test(commitment) || BigInt(commitment) >= FIELD_PRIME) {
    return "The commitment is not a field element.";
  }
  if (typeof amountWei !== "string" || !/^\d{1,39}$/.test(amountWei) || BigInt(amountWei) >= AMOUNT_LIMIT) {
    return "The amount is not a whole number of base units below 2^128.";
  }
  if (typeof asset !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(asset)) return "The asset is not an address.";
  return null;
}

/** Compact gloam1. form, byte-identical to the app's encodeNotePackage (a note goes under "n"). */
export function encodeNotePackage(pack: Omit<NotePackage, "v" | "type" | "scheme"> & Partial<NotePackage>): string {
  const note = cleanPaymentNote(pack.note);
  const json = JSON.stringify({
    v: 1,
    t: "gloam-private-note",
    s: "poseidon",
    p: pack.pool,
    a: pack.asset ?? NATIVE_ASSET,
    w: pack.amountWei,
    k: pack.secret,
    c: pack.commitment,
    // The chain, when known (same key and place as the app's codes).
    ...(validChainId(pack.chainId) ? { ch: pack.chainId } : {}),
    // Only when there is one, so a package without a note keeps the old bytes.
    ...(note ? { n: note } : {}),
    // The seed, only when it makes the secret (same key as the app's codes).
    ...(seedMakesSecret(pack.seed, pack.secret) ? { sd: pack.seed } : {}),
  });
  return NOTE_PACKAGE_PREFIX + b64urlEncode(new TextEncoder().encode(json));
}

/** Parse a gloam1. package or its JSON (compact or long keys). Sealed tickets must be opened first. */
export function decodeNotePackage(input: string): NotePackage {
  const s = input.trim();
  let obj: Record<string, unknown>;
  try {
    obj = s.startsWith(NOTE_PACKAGE_PREFIX)
      ? JSON.parse(new TextDecoder().decode(b64urlDecode(s.slice(NOTE_PACKAGE_PREFIX.length))))
      : JSON.parse(s);
  } catch {
    throw new Error("Not a Gloam note package (gloam1.…).");
  }
  const pack: NotePackage = {
    v: 1,
    type: "gloam-private-note",
    scheme: "poseidon",
    pool: String(obj.pool ?? obj.p ?? "") as Address,
    asset: String(obj.asset ?? obj.a ?? NATIVE_ASSET) as Address,
    amountWei: String(obj.amountWei ?? obj.w ?? ""),
    secret: String(obj.secret ?? obj.k ?? "") as Hex,
    commitment: String(obj.commitment ?? obj.c ?? "") as Hex,
  };
  const note = cleanPaymentNote(obj.note ?? obj.n);
  if (note) pack.note = note;
  const ch = obj.ch ?? obj.chainId;
  if (validChainId(ch)) pack.chainId = ch;
  const sd = typeof obj.sd === "string" ? obj.sd : undefined;
  if (sd && seedMakesSecret(sd, pack.secret)) pack.seed = sd as Hex;
  const problem = noteFieldProblem(pack);
  if (problem) throw new Error(`Not a valid Gloam note package. ${problem}`);
  return pack;
}

/** A note package as the NoteExport the spend builders take (nullifier derived). */
export async function notePackageToExport(pack: NotePackage): Promise<NoteExport & { pool: Address; chainId?: number }> {
  const nullifier = await noteNullifierPoseidon(hexToField(pack.secret), hexToField(pack.commitment));
  return {
    secret: pack.secret,
    commitment: pack.commitment,
    nullifier: fieldToHex(nullifier),
    amountWei: pack.amountWei,
    asset: pack.asset,
    pool: pack.pool,
    ...(pack.chainId !== undefined ? { chainId: pack.chainId } : {}),
  };
}
