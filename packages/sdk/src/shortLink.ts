/**
 * Short claim and request links.
 *
 *   https://gloam.trade/c#<about 30 letters and digits>   a payment anyone with the link can claim
 *   https://gloam.trade/r#<about 55 letters and digits>   a request to be paid
 *
 * Everything after the # is a small binary record written in base62, so the
 * link holds only letters and digits: chat apps ended older links at ".", "-"
 * and "%2E" (see the app's lib/claimLink). It stays in the URL fragment, which
 * browsers never send to a server, so no server ever sees the secret.
 *
 * What makes a claim link short:
 *  - the note's secret is made from a 16-byte random seed (seedToSecret), so a
 *    new link carries 16 bytes instead of 32. 128 bits of randomness is the
 *    whole security of the link, the same bar as a 128-bit key.
 *  - chain, vault and token are one small number from a fixed table (WHERE),
 *    instead of a chain id and two 20-byte addresses.
 *  - the commitment is left out: it is Poseidon(secret, amount, asset), which
 *    the reader works out again (decodeShortClaim).
 *  - the amount is written as digits times a power of ten, so 100 USDG is one byte.
 * A payment made before seeds (a 32-byte secret) still gets a short link, with
 * the whole secret in it (about 50 characters). Old gloam1 codes and links keep
 * working everywhere; nothing here changes how they read.
 *
 * Record layout (byte 0 is the kind in the high four bits and flags in the low four):
 *   claim, seed     0x1f: where, amount, [note], seed(16), check(1)
 *   claim, secret   0x2f: where, amount, [note], secret(32), check(1)
 *   request         0x30, flags: where, to, [amount], [note], [name], [partner], check(2)
 * where   = varint id into WHERE (id >= 1), or 0 then varint chainId,
 *           pool (20 bytes, claims only) and asset (20 bytes)
 * amount  = varint (digits << 5 | power of ten), power at most 31
 * text    = varint byte length, then UTF-8
 * check   = the first bytes of keccak256 of every byte before it, so a link cut
 *           short or changed on the way is refused instead of read as another one
 *
 * WHERE only ever grows: an id, once given, means the same vault and token
 * forever, or links already sent would open as something else.
 *
 * Id 45 is Elysium mainnet's USDC and id 46 Elysium testnet's, read from
 * src/elysium.ts (ELYSIUM_MAINNET and ELYSIUM_TESTNET: chain id, pool and USDC).
 * Their pools were not deployed when the ids were given, so until every value
 * of a network is in, its id is reserved: nothing writes it and a record that
 * names it is refused. A link to Elysium made before then is written out in
 * full (id 0). Only the SDK's own file decides them, never an app's env, so
 * every reader agrees on what ids 45 and 46 mean.
 *
 * Id 47 is KNTQ (Kinetiq) in the same Elysium mainnet vault, given after
 * launch when the app listed it (0xe45a355d9e9cAd2aD85F2d03E3eE3102A036acF0);
 * like id 45 it takes the vault from src/elysium.ts.
 */

import { getAddress, keccak256, type Address, type Hex } from "viem";
import { FIELD_PRIME, NATIVE_ASSET } from "./constants.js";
import { noteCommitmentPoseidon } from "./note.js";
import { fieldToHex, hexToField } from "./poseidon.js";
import { cleanPaymentNote, cleanText, PAYMENT_NOTE_MAX } from "./paymentNote.js";
import { elysiumMainnetConfig, elysiumTestnetConfig } from "./elysium.js";

// ── the fixed table: (chain, vault, token) -> small id ─────────────────────────

const MAINNET_VAULT: Address = "0x39E28Cde55CAB798874746ac52cb4B5Cc99a0194";
const RH_TESTNET_VAULT: Address = "0x72406D9597807A46f730d8b4fDBC5aC45Dc1d740";
const TEMPO_TESTNET_VAULT: Address = "0x841DC046Ea3CC842BA3A855731472c6Eb0F2d5eb";
const ETH_SEPOLIA_VAULT: Address = "0x465EbfcdE1e384C7B1e8388E1aFEA95438c7A0ef";

export interface ShortLinkPlace {
  chainId: number;
  pool: Address;
  asset: Address;
}

const at = (chainId: number, pool: Address, asset: Address): ShortLinkPlace => ({ chainId, pool, asset });

const ZERO: Address = "0x0000000000000000000000000000000000000000";

/** A reserved id: chain 0 matches no network, and reading it is refused. */
const RESERVED: ShortLinkPlace = Object.freeze({ chainId: 0, pool: ZERO, asset: ZERO });

/** Elysium mainnet's USDC (id 45) once every value in src/elysium.ts is in, else reserved. */
function elysiumUsdc(): ShortLinkPlace {
  const cfg = elysiumMainnetConfig();
  return cfg ? at(cfg.chainId, cfg.pool, cfg.usdc) : RESERVED;
}

/** Elysium testnet's USDC (id 46) once ELYSIUM_TESTNET's pool is in, else reserved. */
function elysiumTestnetUsdc(): ShortLinkPlace {
  const cfg = elysiumTestnetConfig();
  return cfg ? at(cfg.chainId, cfg.pool, cfg.usdc) : RESERVED;
}

/** KNTQ (Kinetiq) on Elysium mainnet, 18 decimals, bridged through Elysium's canonical gateway. */
const ELYSIUM_KNTQ: Address = "0xe45a355d9e9cAd2aD85F2d03E3eE3102A036acF0";

/** Elysium mainnet's KNTQ (id 47) in the vault from src/elysium.ts, reserved while its values are not in. */
function elysiumKntq(): ShortLinkPlace {
  const cfg = elysiumMainnetConfig();
  return cfg ? at(cfg.chainId, cfg.pool, ELYSIUM_KNTQ) : RESERVED;
}

/**
 * Id n is WHERE[n - 1]. Append only: never reorder, remove or edit an entry.
 * A token or vault that is not here still links, with its addresses written out.
 */
export const SHORT_LINK_WHERE: readonly ShortLinkPlace[] = Object.freeze([
  // Robinhood Chain mainnet (4663)
  at(4663, MAINNET_VAULT, "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168"), // 1 USDG
  at(4663, MAINNET_VAULT, NATIVE_ASSET), // 2 ETH
  at(4663, MAINNET_VAULT, "0xDcD885F5c60b3aD49F6D58718696417314e8724d"), // 3 GLOAM
  at(4663, MAINNET_VAULT, "0x9f4BA41F91a59A34e17eE8C9EB3A51363B11aBD5"), // 4 GRIFT
  at(4663, MAINNET_VAULT, "0x39dBED3a2bd333467115dE45665cC57F813C4571"), // 5 PONS
  at(4663, MAINNET_VAULT, "0x020bfC650A365f8BB26819deAAbF3E21291018b4"), // 6 CASHCAT
  at(4663, MAINNET_VAULT, "0x2E8c31162b855A2ffa90F6F8634643Ad6F111e18"), // 7 AI
  at(4663, MAINNET_VAULT, "0xAa07A0e9209e16aC99708C3EC70159c6eF3128A3"), // 8 ORBIO
  // Tempo mainnet (4217)
  at(4217, MAINNET_VAULT, "0x20c000000000000000000000b9537d11c60e8b50"), // 9 USDC.e
  at(4217, MAINNET_VAULT, "0x20c0000000000000000000000000000000000000"), // 10 pathUSD
  at(4217, MAINNET_VAULT, "0x20c00000000000000000000014f22ca97301eb73"), // 11 USDT0
  at(4217, MAINNET_VAULT, "0x20c0000000000000000000006a37da5c996874be"), // 12 OUSD
  // Base mainnet (8453)
  at(8453, MAINNET_VAULT, "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"), // 13 USDC
  at(8453, MAINNET_VAULT, "0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42"), // 14 EURC
  at(8453, MAINNET_VAULT, "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2"), // 15 USDT
  at(8453, MAINNET_VAULT, NATIVE_ASSET), // 16 ETH
  at(8453, MAINNET_VAULT, "0x6ad12E761b438beA3EA09F6C6266556Bb24C2181"), // 17 BDX
  // Ethereum mainnet (1)
  at(1, MAINNET_VAULT, "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"), // 18 USDC
  at(1, MAINNET_VAULT, "0xdAC17F958D2ee523a2206206994597C13D831ec7"), // 19 USDT
  at(1, MAINNET_VAULT, "0xe343167631d89B6Ffc58B88d6b7fB0228795491D"), // 20 USDG
  at(1, MAINNET_VAULT, "0x6c3ea9036406852006290770BEdFcAbA0e23A0e8"), // 21 PYUSD
  at(1, MAINNET_VAULT, "0x1aBaEA1f7C830bD89Acc67eC4af516284b1bC33c"), // 22 EURC
  at(1, MAINNET_VAULT, NATIVE_ASSET), // 23 ETH
  at(1, MAINNET_VAULT, "0x6ad12E761b438beA3EA09F6C6266556Bb24C2181"), // 24 BDX
  // Base Sepolia (84532)
  at(84532, MAINNET_VAULT, "0x036CbD53842c5426634e7929541eC2318f3dCF7e"), // 25 USDC
  at(84532, MAINNET_VAULT, "0x808456652fdb597867f38412077A9182bf77359F"), // 26 EURC
  at(84532, MAINNET_VAULT, NATIVE_ASSET), // 27 ETH
  // Ethereum Sepolia (11155111)
  at(11155111, ETH_SEPOLIA_VAULT, "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238"), // 28 USDC
  at(11155111, ETH_SEPOLIA_VAULT, "0xfBb2A78CceEb415b00300925e464C3E44E6e06b0"), // 29 USDG
  at(11155111, ETH_SEPOLIA_VAULT, "0xCaC524BcA292aaade2DF8A05cC58F0a65B1B3bB9"), // 30 PYUSD
  at(11155111, ETH_SEPOLIA_VAULT, "0x08210F9170F89Ab7658F0B5E3fF39b0E03C594D4"), // 31 EURC
  at(11155111, ETH_SEPOLIA_VAULT, NATIVE_ASSET), // 32 ETH
  // Robinhood Chain testnet (46630)
  at(46630, RH_TESTNET_VAULT, NATIVE_ASSET), // 33 ETH
  at(46630, RH_TESTNET_VAULT, "0x7E955252E15c84f5768B83c41a71F9eba181802F"), // 34 USDG
  // Tempo testnet (42431)
  at(42431, TEMPO_TESTNET_VAULT, "0x20c0000000000000000000000000000000000000"), // 35 PathUSD
  at(42431, TEMPO_TESTNET_VAULT, "0x20c0000000000000000000006a37da5c996874be"), // 36 OUSD
  at(42431, TEMPO_TESTNET_VAULT, "0x20c0000000000000000000000000000000000001"), // 37 AlphaUSD
  at(42431, TEMPO_TESTNET_VAULT, "0x20c0000000000000000000000000000000000002"), // 38 BetaUSD
  at(42431, TEMPO_TESTNET_VAULT, "0x20c0000000000000000000000000000000000003"), // 39 ThetaUSD
  // Robinhood Chain testnet faucet stocks (46630)
  at(46630, RH_TESTNET_VAULT, "0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E"), // 40 TSLA
  at(46630, RH_TESTNET_VAULT, "0x5884aD2f920c162CFBbACc88C9C51AA75eC09E02"), // 41 AMZN
  at(46630, RH_TESTNET_VAULT, "0x1FBE1a0e43594b3455993B5dE5Fd0A7A266298d0"), // 42 PLTR
  at(46630, RH_TESTNET_VAULT, "0x3b8262A63d25f0477c4DDE23F83cfe22Cb768C93"), // 43 NFLX
  at(46630, RH_TESTNET_VAULT, "0x71178BAc73cBeb415514eB542a8995b82669778d"), // 44 AMD
  // Elysium mainnet: USDC, from src/elysium.ts; reserved until its values are in
  elysiumUsdc(), // 45 USDC
  // Elysium testnet (99801): test USDC, from src/elysium.ts; reserved until its pool is in
  elysiumTestnetUsdc(), // 46 USDC
  // Elysium mainnet (99901): KNTQ, in the vault from src/elysium.ts
  elysiumKntq(), // 47 KNTQ
]);

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** The table id for a place, or 0 when it is not in the table. `pool` null matches any vault (requests). */
function whereId(chainId: number, pool: string | null, asset: string): number {
  const i = SHORT_LINK_WHERE.findIndex(
    (w) => w.chainId > 0 && w.chainId === chainId && same(w.asset, asset) && (pool === null || same(w.pool, pool))
  );
  return i + 1;
}

// ── seeds: 16 random bytes -> a note secret ───────────────────────────────────

/** Domain for seedToSecret. Changing it would change every note made from a seed. */
const SEED_DOMAIN = new TextEncoder().encode("gloam/note-seed/v1");
export const NOTE_SEED_BYTES = 16;

/**
 * The note secret a seed stands for: the low 248 bits of
 * keccak256("gloam/note-seed/v1" ‖ seed). Below 2^248, so always a field
 * element, the same range randomSecretField draws from, and the circuits ask
 * nothing more of a secret than that it is a field element other than zero.
 */
export function seedToSecret(seed: Uint8Array): bigint {
  if (seed.length !== NOTE_SEED_BYTES) throw new Error(`A note seed is ${NOTE_SEED_BYTES} bytes.`);
  const h = BigInt(keccak256(concat([SEED_DOMAIN, seed])));
  return h & ((1n << 248n) - 1n);
}

/** A fresh seed and the secret it makes. Draws again in the (2^-248) case the secret is zero. */
export function randomNoteSeed(): { seed: Hex; secret: bigint } {
  for (;;) {
    const seed = crypto.getRandomValues(new Uint8Array(NOTE_SEED_BYTES));
    const secret = seedToSecret(seed);
    if (secret !== 0n) return { seed: toHex(seed), secret };
  }
}

/** Whether `seed` (hex) makes `secret` (hex). */
export function seedMakesSecret(seed: string | undefined, secret: string): boolean {
  if (!seed || !/^0x[0-9a-fA-F]{32}$/.test(seed)) return false;
  try {
    return seedToSecret(fromHex(seed)) === BigInt(secret);
  } catch {
    return false;
  }
}

// ── bytes ─────────────────────────────────────────────────────────────────────

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function toHex(b: Uint8Array): Hex {
  return `0x${Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")}` as Hex;
}

function fromHex(h: string): Uint8Array {
  const s = h.replace(/^0x/, "");
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bigToBytes(v: bigint, len: number): Uint8Array {
  const out = new Uint8Array(len);
  for (let i = len - 1; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  if (v !== 0n) throw new Error("Value too large.");
  return out;
}

function bytesToBig(b: Uint8Array): bigint {
  let v = 0n;
  for (const x of b) v = (v << 8n) | BigInt(x);
  return v;
}

class Writer {
  private parts: number[] = [];
  byte(b: number) {
    this.parts.push(b & 0xff);
  }
  bytes(b: Uint8Array) {
    for (const x of b) this.parts.push(x);
  }
  varint(v: bigint | number) {
    let n = BigInt(v);
    if (n < 0n) throw new Error("Negative varint.");
    do {
      let b = Number(n & 0x7fn);
      n >>= 7n;
      if (n > 0n) b |= 0x80;
      this.parts.push(b);
    } while (n > 0n);
  }
  text(s: string) {
    const b = new TextEncoder().encode(s);
    this.varint(b.length);
    this.bytes(b);
  }
  done(checkBytes: number): Uint8Array {
    const body = Uint8Array.from(this.parts);
    return concat([body, fromHex(keccak256(body)).subarray(0, checkBytes)]);
  }
}

class Reader {
  private i = 0;
  constructor(private b: Uint8Array) {}
  byte(): number {
    if (this.i >= this.b.length) throw new Error("short");
    return this.b[this.i++]!;
  }
  bytes(n: number): Uint8Array {
    if (this.i + n > this.b.length) throw new Error("short");
    const out = this.b.subarray(this.i, this.i + n);
    this.i += n;
    return out;
  }
  varint(): bigint {
    let v = 0n;
    for (let shift = 0n; shift < 200n; shift += 7n) {
      const b = this.byte();
      v |= BigInt(b & 0x7f) << shift;
      if (!(b & 0x80)) return v;
    }
    throw new Error("varint");
  }
  text(max: number): string {
    const len = Number(this.varint());
    if (len > max) throw new Error("text");
    return new TextDecoder("utf-8", { fatal: true }).decode(this.bytes(len));
  }
  get left(): number {
    return this.b.length - this.i;
  }
}

/** Splits the check off a record and confirms it, or throws. */
function checked(raw: Uint8Array, checkBytes: number): Uint8Array {
  if (raw.length <= checkBytes) throw new Error("short");
  const body = raw.subarray(0, raw.length - checkBytes);
  const want = fromHex(keccak256(body)).subarray(0, checkBytes);
  const got = raw.subarray(raw.length - checkBytes);
  if (!want.every((x, i) => x === got[i])) throw new Error("check");
  return body;
}

// ── base62 (0-9, A-Z, a-z) ────────────────────────────────────────────────────

const B62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** Bytes as base62. The first byte of every record here is never 0, so no length is lost. */
export function toBase62(bytes: Uint8Array): string {
  let v = bytesToBig(bytes);
  if (v === 0n) return "0";
  let s = "";
  while (v > 0n) {
    s = B62[Number(v % 62n)]! + s;
    v /= 62n;
  }
  return s;
}

export function fromBase62(s: string): Uint8Array {
  if (!/^[0-9A-Za-z]+$/.test(s)) throw new Error("base62");
  let v = 0n;
  for (const ch of s) v = v * 62n + BigInt(B62.indexOf(ch));
  const out: number[] = [];
  while (v > 0n) {
    out.unshift(Number(v & 0xffn));
    v >>= 8n;
  }
  return Uint8Array.from(out);
}

// ── amounts: digits times a power of ten ──────────────────────────────────────

function writeAmount(w: Writer, amount: bigint) {
  let m = amount;
  let e = 0;
  while (m > 0n && m % 10n === 0n && e < 31) {
    m /= 10n;
    e++;
  }
  w.varint((m << 5n) | BigInt(e));
}

const AMOUNT_LIMIT = 1n << 128n;

function readAmount(r: Reader): bigint {
  const v = r.varint();
  const amount = (v >> 5n) * 10n ** (v & 31n);
  if (amount >= AMOUNT_LIMIT) throw new Error("amount");
  return amount;
}

// ── where ─────────────────────────────────────────────────────────────────────

function writeWhere(w: Writer, chainId: number, pool: string | null, asset: string) {
  const id = whereId(chainId, pool, asset);
  w.varint(id);
  if (id) return;
  w.varint(chainId);
  if (pool !== null) w.bytes(fromHex(pool));
  w.bytes(fromHex(asset));
}

function readWhere(r: Reader, withPool: boolean): { chainId: number; pool: Address | null; asset: Address } {
  const id = Number(r.varint());
  if (id > 0) {
    const w = SHORT_LINK_WHERE[id - 1];
    // A reserved id (Elysium's, before its values are in) is refused, never read as chain 0.
    if (!w || w.chainId <= 0) throw new Error("where");
    return { chainId: w.chainId, pool: withPool ? w.pool : null, asset: w.asset };
  }
  const chainId = Number(r.varint());
  if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new Error("chain");
  const pool = withPool ? getAddress(toHex(r.bytes(20))) : null;
  const asset = getAddress(toHex(r.bytes(20)));
  return { chainId, pool, asset };
}

// ── claim links ───────────────────────────────────────────────────────────────

/** The internal code for a short claim (what a pasted /c# link reads as), next to gloam1. and friends. */
export const SHORT_CLAIM_PREFIX = "gloam3.";

const KIND_SEED = 0x1;
const KIND_SECRET = 0x2;
const KIND_REQUEST = 0x3;
const FLAG_NOTE = 0x1;
const CLAIM_CHECK = 1;
const REQUEST_CHECK = 2;

/** What a short claim link needs from a payment: the fields of a note package, plus its seed when it has one. */
export interface ShortClaimInput {
  pool: string;
  asset: string;
  amountWei: string;
  secret: string;
  chainId?: number;
  note?: string;
  /** The 16-byte seed the secret was made from (hex), when it was. */
  seed?: string;
}

/** A short claim as read back: every field of the payment except the commitment. */
export interface ShortClaimFields {
  chainId: number;
  pool: Address;
  asset: Address;
  amountWei: string;
  secret: Hex;
  note?: string;
  /** Set when the link carried a seed. */
  seed?: Hex;
}

/**
 * The base62 body of a short claim link, or null when this payment can't have
 * one (no chain named, or a field out of range): it then keeps its long link.
 */
export function encodeShortClaim(p: ShortClaimInput): string | null {
  try {
    if (!p.chainId || !Number.isSafeInteger(p.chainId) || p.chainId <= 0) return null;
    if (!/^0x[0-9a-fA-F]{40}$/.test(p.pool) || !/^0x[0-9a-fA-F]{40}$/.test(p.asset)) return null;
    if (!/^\d{1,39}$/.test(p.amountWei)) return null;
    const amount = BigInt(p.amountWei);
    if (amount >= AMOUNT_LIMIT) return null;
    if (!/^0x[0-9a-fA-F]{1,64}$/.test(p.secret)) return null;
    const secret = BigInt(p.secret);
    if (secret === 0n || secret >= FIELD_PRIME) return null;
    const note = cleanPaymentNote(p.note);
    const useSeed = seedMakesSecret(p.seed, p.secret);
    const w = new Writer();
    w.byte(((useSeed ? KIND_SEED : KIND_SECRET) << 4) | (note ? FLAG_NOTE : 0));
    writeWhere(w, p.chainId, p.pool, p.asset);
    writeAmount(w, amount);
    if (note) w.text(note);
    w.bytes(useSeed ? fromHex(p.seed!) : bigToBytes(secret, 32));
    return toBase62(w.done(CLAIM_CHECK));
  } catch {
    return null;
  }
}

/** Reads a short claim body (no commitment yet: see decodeShortClaim). Throws on a cut or changed link. */
export function readShortClaim(body: string): ShortClaimFields {
  let raw: Uint8Array;
  try {
    raw = checked(fromBase62(body.trim()), CLAIM_CHECK);
  } catch {
    throw new Error("This claim link is cut off or damaged. Ask the sender to send it again.");
  }
  try {
    const r = new Reader(raw);
    const head = r.byte();
    const kind = head >> 4;
    if (kind !== KIND_SEED && kind !== KIND_SECRET) throw new Error("kind");
    const where = readWhere(r, true);
    const amount = readAmount(r);
    const note = head & FLAG_NOTE ? cleanPaymentNote(r.text(PAYMENT_NOTE_MAX * 4)) : "";
    let secret: bigint;
    let seed: Hex | undefined;
    if (kind === KIND_SEED) {
      const s = r.bytes(NOTE_SEED_BYTES);
      seed = toHex(s);
      secret = seedToSecret(s);
    } else {
      secret = bytesToBig(r.bytes(32));
    }
    if (r.left !== 0 || secret === 0n || secret >= FIELD_PRIME) throw new Error("rest");
    return {
      chainId: where.chainId,
      pool: where.pool!,
      asset: where.asset,
      amountWei: amount.toString(),
      secret: fieldToHex(secret),
      ...(note ? { note } : {}),
      ...(seed ? { seed } : {}),
    };
  } catch {
    throw new Error("This claim link is cut off or damaged. Ask the sender to send it again.");
  }
}

/** A short claim read back with its commitment worked out (Poseidon(secret, amount, asset)). */
export async function decodeShortClaim(body: string): Promise<ShortClaimFields & { commitment: Hex }> {
  const f = readShortClaim(body);
  const c = await noteCommitmentPoseidon(hexToField(f.secret), BigInt(f.amountWei), f.asset);
  return { ...f, commitment: fieldToHex(c) };
}

/** https://gloam.trade/c#<body> */
export function shortClaimLink(body: string, origin = "https://gloam.trade"): string {
  return `${origin.replace(/\/+$/, "")}/c#${body}`;
}

/** The short claim body in a pasted link or text ("…/c#<body>"), or null. */
export function shortClaimBodyIn(text: string): string | null {
  const m = text.match(/\/c(?:#|%23)([0-9A-Za-z]{8,})/);
  return m ? m[1]! : null;
}

// ── request links ─────────────────────────────────────────────────────────────

// P-256: the SPKI header of an uncompressed public key, then 04 ‖ x ‖ y.
const P256_P = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn;
const P256_B = 0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604bn;
const SPKI_HEAD = fromHex("3059301306072a8648ce3d020106082a8648ce3d030107034200");
const TAG_PREFIX = "gloamr1.";

function modPow(b: bigint, e: bigint, m: bigint): bigint {
  let r = 1n;
  b %= m;
  while (e > 0n) {
    if (e & 1n) r = (r * b) % m;
    b = (b * b) % m;
    e >>= 1n;
  }
  return r;
}

function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function unb64url(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/** A Gloam address as its key's x and the parity of y, or null when it isn't exactly a P-256 tag. */
function compressTag(tag: string): { x: Uint8Array; odd: boolean } | null {
  const t = tag.trim();
  if (!t.startsWith(TAG_PREFIX)) return null;
  let spki: Uint8Array;
  try {
    spki = unb64url(t.slice(TAG_PREFIX.length));
  } catch {
    return null;
  }
  if (spki.length !== SPKI_HEAD.length + 65 || !SPKI_HEAD.every((x, i) => spki[i] === x) || spki[SPKI_HEAD.length] !== 4) return null;
  const x = spki.subarray(SPKI_HEAD.length + 1, SPKI_HEAD.length + 33);
  const y = bytesToBig(spki.subarray(SPKI_HEAD.length + 33));
  const odd = (y & 1n) === 1n;
  // Only when it comes back as the very same text.
  return expandTag(x, odd) === t ? { x: Uint8Array.from(x), odd } : null;
}

/** The Gloam address for a compressed key, or null when x is not on the curve. */
function expandTag(xb: Uint8Array, odd: boolean): string | null {
  const x = bytesToBig(xb);
  if (x >= P256_P) return null;
  const rhs = (((((x * x) % P256_P) * x - 3n * x + P256_B) % P256_P) + P256_P) % P256_P;
  let y = modPow(rhs, (P256_P + 1n) / 4n, P256_P);
  if ((y * y) % P256_P !== rhs) return null;
  if (((y & 1n) === 1n) !== odd) y = P256_P - y;
  return TAG_PREFIX + b64url(concat([SPKI_HEAD, Uint8Array.of(4), bigToBytes(x, 32), bigToBytes(y, 32)]));
}

const REQ_AMOUNT = 0x01;
const REQ_NOTE = 0x02;
const REQ_NAME = 0x04;
const REQ_PARTNER = 0x08;
const REQ_TO_SHIFT = 4; // two bits: 0 Gloam address (y even), 1 Gloam address (y odd), 2 0x address, 3 ENS name
export const REQUEST_NAME_MAX_SHORT = 40;

/** A payment request as a short link carries it. `amount` is a plain decimal in whole units ("12.5"). */
export interface ShortRequestFields {
  to: string;
  chainId: number;
  asset: Address;
  /** The token's decimals, to write the amount in base units. */
  decimals: number;
  amount?: string;
  note?: string;
  name?: string;
  partnerCode?: string;
}

function decimalToUnits(amount: string, decimals: number): bigint | null {
  const m = amount.match(/^(\d+)(?:\.(\d+))?$/);
  if (!m) return null;
  const frac = m[2] ?? "";
  if (frac.length > decimals) return null;
  return BigInt(m[1]!) * 10n ** BigInt(decimals) + BigInt((frac + "0".repeat(decimals)).slice(0, decimals) || "0");
}

function unitsToDecimal(units: bigint, decimals: number): string {
  const s = units.toString().padStart(decimals + 1, "0");
  const int = s.slice(0, s.length - decimals).replace(/^0+(?=\d)/, "");
  const frac = s.slice(s.length - decimals).replace(/0+$/, "");
  return frac ? `${int}.${frac}` : int;
}

/**
 * The base62 body of a short request link, or null when the request can't be
 * written short (then the long link is used). Fields are taken as already
 * checked and cleaned by the caller.
 */
export function encodeShortRequest(r: ShortRequestFields): string | null {
  try {
    if (!Number.isSafeInteger(r.chainId) || r.chainId <= 0 || !/^0x[0-9a-fA-F]{40}$/.test(r.asset)) return null;
    const w = new Writer();
    let flags = 0;
    const to = r.to.trim();
    let toKind: number;
    let toBytes: Uint8Array | null = null;
    const tag = compressTag(to);
    if (tag) {
      toKind = tag.odd ? 1 : 0;
      toBytes = tag.x;
    } else if (/^0x[0-9a-fA-F]{40}$/.test(to)) {
      if (getAddress(to) !== to) return null; // only a checksummed address comes back the same
      toKind = 2;
      toBytes = fromHex(to);
    } else if (/^[^\s]{3,255}$/.test(to) && to.includes(".") && !to.startsWith("gloam")) {
      toKind = 3;
    } else return null;
    let units: bigint | null = null;
    if (r.amount) {
      units = decimalToUnits(r.amount, r.decimals);
      if (units === null || unitsToDecimal(units, r.decimals) !== r.amount) return null;
      flags |= REQ_AMOUNT;
    }
    if (r.note) flags |= REQ_NOTE;
    if (r.name) flags |= REQ_NAME;
    if (r.partnerCode) {
      if (!/^[A-Za-z0-9]{1,64}$/.test(r.partnerCode)) return null;
      flags |= REQ_PARTNER;
    }
    w.byte(KIND_REQUEST << 4);
    w.byte(flags | (toKind << REQ_TO_SHIFT));
    writeWhere(w, r.chainId, null, r.asset);
    if (toBytes) w.bytes(toBytes);
    else w.text(to);
    if (units !== null) writeAmount(w, units);
    if (r.note) w.text(r.note);
    if (r.name) w.text(r.name);
    if (r.partnerCode) w.text(r.partnerCode);
    return toBase62(w.done(REQUEST_CHECK));
  } catch {
    return null;
  }
}

/**
 * Reads a short request body. The amount comes back as a decimal in whole
 * units once `decimalsOf` gives the token's decimals; a token the caller does
 * not know gets no amount. Throws on a cut or changed link.
 */
export function decodeShortRequest(
  body: string,
  decimalsOf: (chainId: number, asset: Address) => number | null
): Omit<ShortRequestFields, "decimals"> {
  try {
    const r = new Reader(checked(fromBase62(body.trim()), REQUEST_CHECK));
    if (r.byte() >> 4 !== KIND_REQUEST) throw new Error("kind");
    const flags = r.byte();
    const where = readWhere(r, false);
    const toKind = (flags >> REQ_TO_SHIFT) & 3;
    let to: string;
    if (toKind <= 1) {
      const t = expandTag(r.bytes(32), toKind === 1);
      if (!t) throw new Error("tag");
      to = t;
    } else if (toKind === 2) to = getAddress(toHex(r.bytes(20)));
    else to = r.text(255);
    let amount: string | undefined;
    if (flags & REQ_AMOUNT) {
      const units = readAmount(r);
      const d = decimalsOf(where.chainId, where.asset);
      if (d !== null) amount = unitsToDecimal(units, d);
    }
    const note = flags & REQ_NOTE ? cleanText(r.text(PAYMENT_NOTE_MAX * 4), PAYMENT_NOTE_MAX) : "";
    const name = flags & REQ_NAME ? cleanText(r.text(REQUEST_NAME_MAX_SHORT * 4), REQUEST_NAME_MAX_SHORT) : "";
    const partnerCode = flags & REQ_PARTNER ? r.text(64) : "";
    if (r.left !== 0) throw new Error("rest");
    return {
      to,
      chainId: where.chainId,
      asset: where.asset,
      ...(amount ? { amount } : {}),
      ...(note ? { note } : {}),
      ...(name ? { name } : {}),
      ...(partnerCode ? { partnerCode } : {}),
    };
  } catch {
    throw new Error("This request link is cut off or damaged. Ask for it again.");
  }
}

/** https://gloam.trade/r#<body> */
export function shortRequestLink(body: string, origin = "https://gloam.trade"): string {
  return `${origin.replace(/\/+$/, "")}/r#${body}`;
}
