/**
 * Payment requests on Starknet: what a request link carries and how it reads
 * back. Pure (no SDK, no storage, no network), so
 * scripts/selftest-starknet-requests.mts holds every rule here.
 *
 * A request asks to be paid into a Gloam private account on Starknet, with an
 * amount (or none, and the payer chooses), a note and a name. Nothing about it
 * goes on chain: it only fills in Pay for the payer, who checks it and presses
 * Pay privately. Starknet payments carry no note, so the note and the name are
 * only shown to the payer, and the name is never trusted on its own.
 *
 *   https://gloam.trade/app/vault?tab=move&mode=pay#snreq=<base58>
 *
 * The body is base58 (letters and digits only) behind "snreq=", so the whole
 * fragment is letters, digits and "=". No other link reads it, and it reads no
 * other: a Starknet claim link is "#sn=" ("snreq" is not "sn"), Solana's are
 * "#sol=" and "#solreq=", an EVM claim link is "#claim=gloam1=" or a bare
 * short code (no "="), and an EVM request names its fields (to, amount, asset,
 * ...), none of them "snreq". It rides in the fragment, which browsers never
 * send to a server.
 *
 * Body:
 *   [0] version, 1
 *   [1] network: 0 mainnet, 1 sepolia, 2 devnet (as a claim link's)
 *   [2] token: index into the network's listed tokens (0: USDC)
 *   [3] flags (bit 0: an amount follows)
 *   [u64 amount, little-endian, base units]
 *   [32 bytes: the private account, big-endian]
 *   [1 byte length][note, UTF-8]  [1 byte length][name, UTF-8]
 *   [4 bytes: FNV-1a 32 over "snreq" and all before, so a cut or mistyped
 *    link is refused; the "snreq" in it keeps a Solana request's body, laid
 *    out the same way, from ever reading as a Starknet one, and the other way round]
 */
import { cleanText, PAYMENT_NOTE_MAX } from "@/lib/paymentNote";
import { base58, isStarknetClaimHash, unbase58 } from "./claimLink";
import type { StarknetNetwork } from "./config";

/** The fragment key. Never a claim link's ("sn"), Solana's ("sol", "solreq") or an EVM field. */
export const REQUEST_KEY = "snreq";

/** The most a note and a name in a request say, as on the other chains (lib/paymentRequest). */
export const STARKNET_REQUEST_NOTE_MAX = PAYMENT_NOTE_MAX;
export const STARKNET_REQUEST_NAME_MAX = 40;

const VERSION = 1;
const NETWORK_CODES: Readonly<Record<StarknetNetwork, number>> = { mainnet: 0, sepolia: 1, devnet: 2 };
const U64_MAX = (1n << 64n) - 1n;
const ADDRESS_MAX = 1n << 251n;
const BASE58 = "[1-9A-HJ-NP-Za-km-z]";

export type StarknetRequest = {
  network: StarknetNetwork;
  /** The private account to pay (0x, lower case, no leading zeros). */
  to: string;
  /** Index into the network's listed tokens (0: USDC). */
  token: number;
  /** Base units; null lets the payer choose. */
  amount: bigint | null;
  note: string;
  name: string;
};

export type StarknetRequestRead =
  | { ok: true; request: StarknetRequest }
  /** "damaged": cut short, mistyped or not Gloam's; "unknown": a newer link this app can't read. */
  | { ok: false; why: "damaged" | "unknown" };

const enc = new TextEncoder();
const TAG = enc.encode(REQUEST_KEY);

/**
 * FNV-1a, 32 bits, little-endian, over the tag "snreq" and then the body:
 * catches a cut or mistyped link, and no other Gloam link's body passes it.
 * Not a secret and not a signature.
 */
function check(bytes: Uint8Array): Uint8Array {
  let h = 0x811c9dc5;
  for (const part of [TAG, bytes])
    for (const b of part) {
      h ^= b;
      h = Math.imul(h, 0x01000193) >>> 0;
    }
  return Uint8Array.of(h & 255, (h >>> 8) & 255, (h >>> 16) & 255, h >>> 24);
}

/** `text` cleaned to `max` characters, then cut down whole characters until it fits 255 bytes of UTF-8 (a length byte holds 255). */
function cleanBytes(text: string, max: number): Uint8Array {
  let chars = Array.from(cleanText(text, max));
  let out = enc.encode(chars.join(""));
  while (out.length > 255) {
    chars = chars.slice(0, -1);
    out = enc.encode(chars.join("").trim());
  }
  return out;
}

/** A Starknet address as one form (0x, lower case, no leading zeros), or null when it isn't one. */
export function starknetRequestAddress(v: string): string | null {
  const t = v.trim();
  if (!/^0x[0-9a-fA-F]{1,64}$/.test(t)) return null;
  const n = BigInt(t);
  return n > 0n && n < ADDRESS_MAX ? `0x${n.toString(16)}` : null;
}

/** The request's body (base58). Refuses an address that isn't one, and an amount of zero. */
export function encodeStarknetRequest(r: StarknetRequest): string {
  const to = starknetRequestAddress(r.to);
  if (!to) throw new Error("That isn't a Starknet address.");
  if (r.amount !== null && (r.amount <= 0n || r.amount > U64_MAX)) throw new Error("Enter an amount above zero, or leave it empty.");
  if (!Number.isInteger(r.token) || r.token < 0 || r.token > 255) throw new Error("Invalid token.");
  const account = new Uint8Array(32);
  let n = BigInt(to);
  for (let i = 31; i >= 0; i--) {
    account[i] = Number(n & 255n);
    n >>= 8n;
  }
  const amount = new Uint8Array(r.amount !== null ? 8 : 0);
  if (r.amount !== null) new DataView(amount.buffer).setBigUint64(0, r.amount, true);
  const note = cleanBytes(r.note, STARKNET_REQUEST_NOTE_MAX);
  const name = cleanBytes(r.name, STARKNET_REQUEST_NAME_MAX);
  const parts = [Uint8Array.of(VERSION, NETWORK_CODES[r.network], r.token, r.amount !== null ? 1 : 0), amount, account, Uint8Array.of(note.length), note, Uint8Array.of(name.length), name];
  const head = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let at = 0;
  for (const p of parts) {
    head.set(p, at);
    at += p.length;
  }
  const out = new Uint8Array(head.length + 4);
  out.set(head);
  out.set(check(head), head.length);
  return base58(out);
}

/** A body back to its request. */
export function decodeStarknetRequest(body: string): StarknetRequestRead {
  const damaged = { ok: false as const, why: "damaged" as const };
  const bytes = unbase58(body.trim());
  if (!bytes || bytes.length < 4 + 32 + 2 + 4) return damaged;
  const head = bytes.subarray(0, bytes.length - 4);
  if (!check(head).every((x, i) => x === bytes[head.length + i])) return damaged;
  if (head[0] !== VERSION) return { ok: false, why: head[0]! > VERSION ? "unknown" : "damaged" };
  const network = (Object.keys(NETWORK_CODES) as StarknetNetwork[]).find((k) => NETWORK_CODES[k] === head[1]);
  if (!network) return { ok: false, why: "unknown" };
  const token = head[2]!;
  const flags = head[3]!;
  if (flags & ~1) return { ok: false, why: "unknown" };
  let at = 4;
  let amount: bigint | null = null;
  if (flags & 1) {
    if (head.length < at + 8) return damaged;
    amount = new DataView(head.buffer, head.byteOffset + at, 8).getBigUint64(0, true);
    at += 8;
    if (amount === 0n) return damaged;
  }
  if (head.length < at + 32) return damaged;
  let n = 0n;
  for (const b of head.subarray(at, at + 32)) n = (n << 8n) | BigInt(b);
  at += 32;
  if (n === 0n || n >= ADDRESS_MAX) return damaged;
  const text = (max: number): string | null => {
    if (head.length < at + 1) return null;
    const len = head[at]!;
    at += 1;
    if (head.length < at + len) return null;
    let s: string;
    try {
      s = new TextDecoder("utf-8", { fatal: true }).decode(head.subarray(at, at + len));
    } catch {
      return null;
    }
    at += len;
    return cleanText(s, max);
  };
  const note = text(STARKNET_REQUEST_NOTE_MAX);
  const name = text(STARKNET_REQUEST_NAME_MAX);
  if (note === null || name === null || at !== head.length) return damaged;
  return { ok: true, request: { network, to: `0x${n.toString(16)}`, token, amount, note, name } };
}

/**
 * The request in a fragment ("#snreq=<body>"), or null. The longest body (an
 * amount, a note and a name of four-byte characters, 465 bytes) is 636 letters.
 */
export function starknetRequestBodyFromHash(hash: string): string | null {
  const m = hash.trim().match(new RegExp(`^#${REQUEST_KEY}=(${BASE58}{40,700})$`));
  return m ? m[1]! : null;
}

/** The link to share: Pay on Starknet, filled in. No ?net=: that names an EVM network. */
export function starknetRequestLinkUrl(body: string, origin = "https://www.gloam.trade"): string {
  return `${origin.replace(/\/+$/, "")}/app/vault?tab=move&mode=pay#${REQUEST_KEY}=${body}`;
}

/** Which Starknet link a fragment carries, or null for anything else (an EVM or Solana link, nothing). */
export function starknetLinkKind(hash: string): "claim" | "request" | null {
  if (isStarknetClaimHash(hash)) return "claim";
  if (starknetRequestBodyFromHash(hash)) return "request";
  return null;
}

/** "Starknet", "Starknet Sepolia" or "Starknet devnet". */
function networkName(n: StarknetNetwork): string {
  return n === "mainnet" ? "Starknet" : n === "sepolia" ? "Starknet Sepolia" : "Starknet devnet";
}

/** What Pay does with the request in a fragment: fill it in, or say why it can't. Null when the fragment holds none. */
export type StarknetRequestOnPay = { body: string; request: StarknetRequest; problem: null } | { body: string; request: null; problem: string };

/** Reads a request link for Pay on `network`, where `tokens` are the listed tokens (lib/starknetPrivacy/config). */
export function starknetRequestForPay(hash: string, network: StarknetNetwork, tokens: number): StarknetRequestOnPay | null {
  const body = starknetRequestBodyFromHash(hash);
  if (!body) return null;
  const r = decodeStarknetRequest(body);
  if (!r.ok)
    return {
      body,
      request: null,
      problem: r.why === "unknown" ? "This request is from a newer Gloam. Reload the page and try again." : "This request link is cut off or damaged. Ask them to send it again.",
    };
  if (r.request.network !== network) return { body, request: null, problem: `This request is for ${networkName(r.request.network)}, and this is Gloam on ${networkName(network)}.` };
  if (r.request.token >= tokens) return { body, request: null, problem: "This request asks for a token Gloam doesn't list on Starknet." };
  return { body, request: r.request, problem: null };
}

/** The amount as Pay's field takes it: every decimal kept, none added ("25", "12.5"). */
export function requestAmountText(amount: bigint, decimals: number): string {
  const base = 10n ** BigInt(decimals);
  const frac = (amount % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return frac ? `${amount / base}.${frac}` : `${amount / base}`;
}
