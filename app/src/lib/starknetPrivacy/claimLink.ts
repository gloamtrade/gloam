/**
 * Claim links on Starknet: what a link carries and how it reads back. Pure (no
 * SDK, no storage, no network), so scripts/selftest-starknet-claim-links.mts
 * holds every rule here; lib/starknetPrivacy/claim says how a link is paid,
 * claimed and taken back.
 *
 * A claim link is a one-time private account on the Starknet privacy pool.
 * The link carries the 16 random bytes its key comes from (claimSeed), so
 * whoever opens the link holds that account: they move what it holds into
 * their own private account, and the sender, who kept the link, can do the
 * same to take back one nobody used. The account's key exists nowhere else.
 *
 *   https://gloam.trade/c#sn=<base58>
 *
 * The body is base58 (letters and digits only) behind "sn=", so the whole
 * fragment is letters, digits and "=": what every chat app keeps inside a
 * link. It never collides with the other links: /c reads a bare run of letters
 * and digits (an EVM short code, no "="), "#claim=gloam1=" (EVM) and "#sol="
 * (Solana); "sn" is none of those, and base58 has no "=" in it. It rides in the
 * fragment, which browsers never send to a server.
 *
 * Body, 31 bytes:
 *   [0]      version, 1
 *   [1]      network: 0 mainnet, 1 sepolia, 2 devnet
 *   [2]      token: 0, the network's first listed token (USDC)
 *   [3..11]  amount, u64 little-endian, base units: for the pages to show; the
 *            claim moves whatever the account holds
 *   [11..27] the secret (16 bytes)
 *   [27..31] check: FNV-1a 32 over [0..27), so a cut or mistyped link is
 *            refused instead of opening an empty account
 */
import type { StarknetNetwork } from "./config";

/** The fragment key. Never an EVM or Solana fragment's. */
export const CLAIM_KEY = "sn";

const VERSION = 1;
export const SECRET_BYTES = 16;
const BODY_BYTES = 3 + 8 + SECRET_BYTES + 4;
const NETWORK_CODES: Readonly<Record<StarknetNetwork, number>> = { mainnet: 0, sepolia: 1, devnet: 2 };
const U64_MAX = (1n << 64n) - 1n;

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]+$/;

/** Base58 (Bitcoin's alphabet), leading zero bytes kept as "1"s. */
export function base58(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = "";
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out;
}

export function unbase58(s: string): Uint8Array | null {
  if (!BASE58.test(s)) return null;
  let n = 0n;
  for (const ch of s) n = n * 58n + BigInt(ALPHABET.indexOf(ch));
  const body: number[] = [];
  while (n > 0n) {
    body.unshift(Number(n & 255n));
    n >>= 8n;
  }
  let zeros = 0;
  while (s[zeros] === "1") zeros++;
  return Uint8Array.from([...new Array<number>(zeros).fill(0), ...body]);
}

/** FNV-1a, 32 bits, little-endian: catches a cut or mistyped link. Not a secret and not a signature. */
function check(bytes: Uint8Array): Uint8Array {
  let h = 0x811c9dc5;
  for (const b of bytes) {
    h ^= b;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return Uint8Array.of(h & 255, (h >>> 8) & 255, (h >>> 16) & 255, h >>> 24);
}

export type StarknetClaim = {
  network: StarknetNetwork;
  /** Index into the network's listed tokens (0: USDC). */
  token: number;
  /** Base units, what was sent (for display). */
  amount: bigint;
  secret: Uint8Array;
};

/** The link's body (base58). */
export function claimBody(c: StarknetClaim): string {
  if (c.secret.length !== SECRET_BYTES) throw new Error("A claim secret is 16 bytes.");
  if (c.amount < 0n || c.amount > U64_MAX) throw new Error("That amount is too large for a link.");
  if (!Number.isInteger(c.token) || c.token < 0 || c.token > 255) throw new Error("Invalid token.");
  const b = new Uint8Array(BODY_BYTES);
  b[0] = VERSION;
  b[1] = NETWORK_CODES[c.network];
  b[2] = c.token;
  new DataView(b.buffer).setBigUint64(3, c.amount, true);
  b.set(c.secret, 11);
  b.set(check(b.subarray(0, 27)), 27);
  return base58(b);
}

/** The link itself: gloam.trade/c#sn=<body>. */
export function claimLinkUrl(c: StarknetClaim, origin = "https://www.gloam.trade"): string {
  return `${origin}/c#${CLAIM_KEY}=${claimBody(c)}`;
}

/** A body back to its claim, or null when it isn't one (cut short, mistyped, another version). */
export function readClaimBody(body: string): StarknetClaim | null {
  const b = unbase58(body.trim());
  if (!b || b.length !== BODY_BYTES || b[0] !== VERSION) return null;
  const sum = check(b.subarray(0, 27));
  if (!sum.every((x, i) => x === b[27 + i])) return null;
  const network = (Object.keys(NETWORK_CODES) as StarknetNetwork[]).find((k) => NETWORK_CODES[k] === b[1]);
  if (!network) return null;
  return { network, token: b[2]!, amount: new DataView(b.buffer, b.byteOffset).getBigUint64(3, true), secret: b.slice(11, 27) };
}

/** The claim in a "#sn=" fragment (or a pasted link that has one), or null. */
export function claimFromHash(hash: string): StarknetClaim | null {
  const m = hash.match(/#sn=([1-9A-HJ-NP-Za-km-z]+)/);
  return m ? readClaimBody(m[1]!) : null;
}

/** Whether a fragment is a Starknet claim link's (read before anything else claims it). */
export function isStarknetClaimHash(hash: string): boolean {
  return /^#sn=[1-9A-HJ-NP-Za-km-z]+$/.test(hash.trim());
}

/** Where a claim link opens in the app: the Vault's Receive, which claims it (no ?net=: that names an EVM network). */
export function appClaimPathFor(body: string): string {
  return `/app/vault?tab=move&mode=receive#${CLAIM_KEY}=${body}`;
}

const enc = new TextEncoder();
const ab = (b: Uint8Array): ArrayBuffer => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;

/**
 * The one-time account's 32-byte seed from the link's secret: HKDF-SHA256
 * (salt "gloam/starknet-claim/v1", info "account"). Its keys and address come
 * from it as any private account's do (lib/starknetPrivacy/account keysFromSeed),
 * with this salt so no other account ever shares them.
 */
export async function claimSeed(secret: Uint8Array): Promise<Uint8Array> {
  if (secret.length !== SECRET_BYTES) throw new Error("A claim secret is 16 bytes.");
  const subtle = globalThis.crypto.subtle;
  const key = await subtle.importKey("raw", ab(secret), "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: ab(enc.encode("gloam/starknet-claim/v1")), info: ab(enc.encode("account")) }, key, 256));
}

/** A fresh secret for a new link. */
export function newClaimSecret(): Uint8Array {
  return globalThis.crypto.getRandomValues(new Uint8Array(SECRET_BYTES));
}

export const hexOf = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
export const bytesOf = (h: string): Uint8Array => Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));
