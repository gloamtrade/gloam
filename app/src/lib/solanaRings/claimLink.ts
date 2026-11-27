/**
 * Claim links and payment requests on Solana: what the links carry and how
 * they read back. Pure (no SDK, no storage, no network), so
 * scripts/selftest-solana-claim-links.mts holds every rule here.
 *
 * A claim link is a one-time private account (lib/solanaRings/claim). The
 * sender pays it privately, and the link carries the 16 random bytes its key
 * comes from. Whoever opens the link derives that key on their own device and
 * moves the money into their own private balance; the sender can do the same
 * to take back a link nobody used. The link is the only thing that can claim:
 * the account's key exists nowhere else, and Solana spends each note once.
 *
 *   https://gloam.trade/c#sol=<base58>
 *
 * The body is base58 (letters and digits only), behind "sol=", so the whole
 * fragment is letters, digits and "=": what every chat app keeps inside a
 * link. It never collides with the EVM links, which stay as they are: /c reads
 * a bare run of letters and digits (a gloam3 short code) or "#claim=gloam1=",
 * and neither matches "#sol=" ("=" is not in a short code, "sol" is not
 * "claim"); isClaimLink (lib/funnel) wants "gloam1" or "gloam3" before its
 * "=", and base58 has no "=" in it. It rides in the fragment, which browsers
 * never send to a server, so link previews and Gloam's own server never see it.
 *
 * Claim body, 31 bytes:
 *   [0]      version, 1
 *   [1]      network: 0 mainnet, 1 devnet
 *   [2]      asset (ASSET_CODES)
 *   [3..11]  amount, u64 little-endian, base units: for the page to show, the
 *            claim itself moves whatever the account holds
 *   [11..27] the secret (16 bytes)
 *   [27..31] check: FNV-1a 32 over [0..27), so a cut or mistyped link is
 *            refused instead of opening an empty account
 *
 * A payment request asks to be paid an amount at a private address. Nothing
 * about it is posted anywhere: it only fills in Pay for the payer, who checks
 * it and presses Pay. On Solana a payment carries no note, so the note and the
 * name are only shown to the payer.
 *
 *   https://gloam.trade/app/vault?tab=move&mode=pay#solreq=<base58>
 *
 * "solreq" is no EVM request field (lib/paymentRequest reads to, amount,
 * asset, ...), so an EVM build reads no request from it.
 *
 * Request body:
 *   [0] version, 1   [1] network   [2] asset   [3] flags (bit 0: an amount follows)
 *   [u64 amount]     [32 bytes: the private address]
 *   [1 byte length][note, UTF-8]  [1 byte length][name, UTF-8]
 *   [4 bytes check over all before]
 */
import { getAddressDecoder, getAddressEncoder, getBase58Decoder, getBase58Encoder, type Address } from "@solana/kit";
import { cleanText, PAYMENT_NOTE_MAX } from "@/lib/paymentNote";
import { ringsAssets, type RingsAsset, type RingsNetwork } from "./config";

/** The fragment keys: a claim link's and a request's. Never an EVM fragment's. */
export const CLAIM_KEY = "sol";
export const REQUEST_KEY = "solreq";

/** Asset codes in a link. Never renumber one: links already sent carry them. */
export const ASSET_CODES: Readonly<Record<string, number>> = { sol: 0, usdc: 1, usdt: 2, zec: 3 };

const NETWORK_CODES: Readonly<Record<RingsNetwork, number>> = { mainnet: 0, devnet: 1 };

const VERSION = 1;
export const SECRET_BYTES = 16;
const CLAIM_BYTES = 3 + 8 + SECRET_BYTES + 4;

/** The most a note and a name in a request say, as on the other chains (lib/paymentRequest). */
export const SOLANA_REQUEST_NOTE_MAX = PAYMENT_NOTE_MAX;
export const SOLANA_REQUEST_NAME_MAX = 40;

const U64_MAX = (1n << 64n) - 1n;
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]+$/;

/** FNV-1a, 32 bits, little-endian: catches a cut or mistyped link. Not a secret and not a signature. */
function check(bytes: Uint8Array): Uint8Array {
  let h = 0x811c9dc5;
  for (const b of bytes) {
    h ^= b;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return Uint8Array.of(h & 255, (h >>> 8) & 255, (h >>> 16) & 255, h >>> 24);
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

function u64le(v: bigint): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, v, true);
  return b;
}

function readU64(b: Uint8Array, at: number): bigint {
  return new DataView(b.buffer, b.byteOffset, b.byteLength).getBigUint64(at, true);
}

function networkFrom(code: number): RingsNetwork | null {
  return code === 0 ? "mainnet" : code === 1 ? "devnet" : null;
}

/** The listed asset a link's code names on `network`, or null. */
export function assetForCode(code: number, network: RingsNetwork): RingsAsset | null {
  const id = Object.keys(ASSET_CODES).find((k) => ASSET_CODES[k] === code);
  return (id && ringsAssets(network).find((a) => a.id === id)) || null;
}

function codeForAsset(id: string, network: RingsNetwork): number {
  const code = ASSET_CODES[id];
  if (code === undefined || !ringsAssets(network).some((a) => a.id === id)) throw new Error(`No link code for ${id} on Solana ${network}.`);
  return code;
}

function toBase58(bytes: Uint8Array): string {
  return getBase58Decoder().decode(bytes);
}

function fromBase58(text: string): Uint8Array | null {
  if (!BASE58.test(text)) return null;
  try {
    return new Uint8Array(getBase58Encoder().encode(text));
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ claim links

export type SolanaClaim = {
  network: RingsNetwork;
  asset: RingsAsset;
  /** What the sender paid in, base units, as the link says it. */
  amount: bigint;
  /** The 16 bytes the one-time account's key comes from. Bearer: this is the money. */
  secret: Uint8Array;
};

/** A new claim: fresh random secret. */
export function newClaim(network: RingsNetwork, asset: RingsAsset, amount: bigint, random: (n: number) => Uint8Array = randomBytes): SolanaClaim {
  if (amount <= 0n || amount > U64_MAX) throw new Error("A claim link needs an amount above zero.");
  codeForAsset(asset.id, network);
  const secret = random(SECRET_BYTES);
  if (secret.length !== SECRET_BYTES || secret.every((b) => b === 0)) throw new Error("No randomness for a claim link.");
  return { network, asset, amount, secret };
}

function randomBytes(n: number): Uint8Array {
  return globalThis.crypto.getRandomValues(new Uint8Array(n));
}

/** The link's body, base58. */
export function encodeClaim(c: SolanaClaim): string {
  if (c.secret.length !== SECRET_BYTES) throw new Error("A claim secret is 16 bytes.");
  if (c.amount <= 0n || c.amount > U64_MAX) throw new Error("A claim link needs an amount above zero.");
  const head = new Uint8Array(CLAIM_BYTES - 4);
  head[0] = VERSION;
  head[1] = NETWORK_CODES[c.network];
  head[2] = codeForAsset(c.asset.id, c.network);
  head.set(u64le(c.amount), 3);
  head.set(c.secret, 11);
  const out = new Uint8Array(CLAIM_BYTES);
  out.set(head);
  out.set(check(head), head.length);
  return toBase58(out);
}

export type ClaimRead =
  | { ok: true; body: string; claim: SolanaClaim }
  /** "damaged": cut short, mistyped or not Gloam's; "unknown": a newer link this app can't read. */
  | { ok: false; why: "damaged" | "unknown" };

/** A link body back to its claim. */
export function decodeClaim(body: string): ClaimRead {
  const bytes = fromBase58(body.trim());
  if (!bytes || bytes.length !== CLAIM_BYTES) {
    // Another length is a newer link only when it is whole (its own check holds) and says a newer version; else it was cut.
    const whole = bytes && bytes.length > 4 && sameBytes(check(bytes.subarray(0, bytes.length - 4)), bytes.subarray(bytes.length - 4));
    return { ok: false, why: whole && bytes![0]! > VERSION ? "unknown" : "damaged" };
  }
  const head = bytes.subarray(0, CLAIM_BYTES - 4);
  if (!sameBytes(check(head), bytes.subarray(CLAIM_BYTES - 4))) return { ok: false, why: "damaged" };
  if (head[0] !== VERSION) return { ok: false, why: head[0]! > VERSION ? "unknown" : "damaged" };
  const network = networkFrom(head[1]!);
  if (!network) return { ok: false, why: "unknown" };
  const asset = assetForCode(head[2]!, network);
  if (!asset) return { ok: false, why: "unknown" };
  const amount = readU64(head, 3);
  if (amount === 0n) return { ok: false, why: "damaged" };
  const secret = head.slice(11, 11 + SECRET_BYTES);
  return { ok: true, body: body.trim(), claim: { network, asset, amount, secret } };
}

const CLAIM_IN_TEXT = new RegExp(`(?:^|[^A-Za-z0-9])${CLAIM_KEY}=([1-9A-HJ-NP-Za-km-z]{20,80})`);

/**
 * The claim body in anything pasted: the whole link, the message it came in,
 * "sol=<body>", or the bare body. Null when there is none.
 */
export function claimBodyIn(text: string): string | null {
  const t = text.trim();
  const m = t.match(CLAIM_IN_TEXT);
  if (m) return m[1]!;
  return BASE58.test(t) && t.length >= 20 && t.length <= 80 ? t : null;
}

/** The claim in a fragment ("#sol=<body>"), or null when the fragment is not a Solana claim link. */
export function claimBodyFromHash(hash: string): string | null {
  const m = hash.match(new RegExp(`^#${CLAIM_KEY}=([1-9A-HJ-NP-Za-km-z]{20,80})$`));
  return m ? m[1]! : null;
}

/** The link to share: gloam.trade/c#sol=<body>, read by the claim page. */
export function claimLinkUrl(body: string, origin = "https://www.gloam.trade"): string {
  return `${origin.replace(/\/+$/, "")}/c#${CLAIM_KEY}=${body}`;
}

/** The app's claim screen for a body (Receive on Solana), where the claim page sends people. */
export function appClaimPath(body: string): string {
  return `/app/vault?tab=move&mode=receive#${CLAIM_KEY}=${body}`;
}

/**
 * The 32-byte Ed25519 seed of a claim's one-time account: HKDF-SHA256 over the
 * link's secret, salt "gloam/solana-claim/v1", info "claim/<network>". A devnet
 * link and a mainnet link with the same bytes are other accounts. Never change.
 */
export async function claimSeed(secret: Uint8Array, network: RingsNetwork): Promise<Uint8Array> {
  if (secret.length !== SECRET_BYTES) throw new Error("A claim secret is 16 bytes.");
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("This browser can't open a claim link (no Web Crypto).");
  const buf = (b: Uint8Array): ArrayBuffer => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
  const enc = new TextEncoder();
  const key = await subtle.importKey("raw", buf(secret), "HKDF", false, ["deriveBits"]);
  const bits = await subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: buf(enc.encode("gloam/solana-claim/v1")), info: buf(enc.encode(`claim/${network}`)) },
    key,
    256
  );
  return new Uint8Array(bits);
}

// ------------------------------------------------------------------ which link a fragment is

/** Which Solana link a fragment carries, or null for anything else (an EVM link, nothing). */
export function solanaLinkKind(hash: string): "claim" | "request" | null {
  if (claimBodyFromHash(hash)) return "claim";
  if (requestBodyFromHash(hash)) return "request";
  return null;
}

// ------------------------------------------------------------------ payment requests

export type SolanaRequest = {
  network: RingsNetwork;
  /** The private address to pay. */
  to: string;
  asset: RingsAsset;
  /** Base units; null lets the payer choose. */
  amount: bigint | null;
  note: string;
  name: string;
};

const enc = new TextEncoder();

/** `text` cleaned to `max` characters, then cut down whole characters until it fits `bytes` bytes of UTF-8 (a length byte holds 255). */
function cleanBytes(text: string, max: number, bytes = 255): Uint8Array {
  let chars = Array.from(cleanText(text, max));
  let out = enc.encode(chars.join(""));
  while (out.length > bytes) {
    chars = chars.slice(0, -1);
    out = enc.encode(chars.join("").trim());
  }
  return out;
}

/** The request's body, base58. Refuses an address that isn't one. */
export function encodeRequest(r: SolanaRequest): string {
  let to: Uint8Array;
  try {
    to = new Uint8Array(getAddressEncoder().encode(r.to as Address));
  } catch {
    throw new Error("That isn't a Solana address.");
  }
  if (r.amount !== null && (r.amount <= 0n || r.amount > U64_MAX)) throw new Error("Enter an amount above zero, or leave it empty.");
  const note = cleanBytes(r.note, SOLANA_REQUEST_NOTE_MAX);
  const name = cleanBytes(r.name, SOLANA_REQUEST_NAME_MAX);
  const parts: Uint8Array[] = [
    Uint8Array.of(VERSION, NETWORK_CODES[r.network], codeForAsset(r.asset.id, r.network), r.amount !== null ? 1 : 0),
    ...(r.amount !== null ? [u64le(r.amount)] : []),
    to,
    Uint8Array.of(note.length),
    note,
    Uint8Array.of(name.length),
    name,
  ];
  const head = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    head.set(p, at);
    at += p.length;
  }
  const out = new Uint8Array(head.length + 4);
  out.set(head);
  out.set(check(head), head.length);
  return toBase58(out);
}

export type RequestRead = { ok: true; request: SolanaRequest } | { ok: false; why: "damaged" | "unknown" };

export function decodeRequest(body: string): RequestRead {
  const bytes = fromBase58(body.trim());
  const damaged = { ok: false as const, why: "damaged" as const };
  if (!bytes || bytes.length < 4 + 32 + 2 + 4) return damaged;
  const head = bytes.subarray(0, bytes.length - 4);
  if (!sameBytes(check(head), bytes.subarray(bytes.length - 4))) return damaged;
  if (head[0] !== VERSION) return { ok: false, why: head[0]! > VERSION ? "unknown" : "damaged" };
  const network = networkFrom(head[1]!);
  if (!network) return { ok: false, why: "unknown" };
  const asset = assetForCode(head[2]!, network);
  if (!asset) return { ok: false, why: "unknown" };
  const flags = head[3]!;
  if (flags & ~1) return { ok: false, why: "unknown" };
  let at = 4;
  let amount: bigint | null = null;
  if (flags & 1) {
    if (head.length < at + 8) return damaged;
    amount = readU64(head, at);
    at += 8;
    if (amount === 0n) return damaged;
  }
  if (head.length < at + 32) return damaged;
  const to = getAddressDecoder().decode(head.subarray(at, at + 32)) as string;
  at += 32;
  const text = (max: number): string | null => {
    if (head.length < at + 1) return null;
    const n = head[at]!;
    at += 1;
    if (head.length < at + n) return null;
    let s: string;
    try {
      s = new TextDecoder("utf-8", { fatal: true }).decode(head.subarray(at, at + n));
    } catch {
      return null;
    }
    at += n;
    return cleanText(s, max);
  };
  const note = text(SOLANA_REQUEST_NOTE_MAX);
  const name = text(SOLANA_REQUEST_NAME_MAX);
  if (note === null || name === null || at !== head.length) return damaged;
  return { ok: true, request: { network, to, asset, amount, note, name } };
}

/** The request in a fragment ("#solreq=<body>"), or null. */
export function requestBodyFromHash(hash: string): string | null {
  const m = hash.match(new RegExp(`^#${REQUEST_KEY}=([1-9A-HJ-NP-Za-km-z]{40,700})$`));
  return m ? m[1]! : null;
}

/** The link to share: Pay on Solana, filled in. */
export function requestLinkUrl(body: string, origin = "https://www.gloam.trade"): string {
  return `${origin.replace(/\/+$/, "")}/app/vault?tab=move&mode=pay#${REQUEST_KEY}=${body}`;
}
