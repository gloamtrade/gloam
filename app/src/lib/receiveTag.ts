/**
 * Sticky Gloam receive tags, “direct” private pay like a shielded address.
 *
 * Recipient publishes:  gloamr1.<b64url SPKI>
 * Sender encrypts ticket to tag → gloam2t.<b64url payload>
 * Only the tag owner can open the ticket (ECDH P-256 + AES-GCM).
 *
 * On-chain transfer is unchanged; ciphertext is still handed off off-chain
 * (QR/share) until we add an on-chain memo field. UX is address-like for the sender.
 *
 * The tag's private key is sealed at rest like the notes (see storage below).
 */

import { accountShown, scopedKey, SignedOutError, writableKey } from "./accountSlot";
import { readDemo } from "./demoFlag";

/**
 * The receive key of the browser's first account. Every other sign-in's carries
 * a suffix (lib/accountSlot), so each has its own Gloam address and only the
 * account it belongs to opens payments sent to it.
 */
export const ID_KEY = "gloam.receive.identity.v1";
/** Earlier receive keys, kept so payments sent to an older Gloam address still open. */
export const PREV_KEY = "gloam.receive.identity.prev.v1";
/** Fired on window whenever the receive key changes (recovery backs it up). */
export const RECEIVE_IDENTITY_EVENT = "gloam:receive-identity";
export const RECEIVE_TAG_PREFIX = "gloamr1.";
export const PAY_TO_TAG_PREFIX = "gloam2t.";

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

function buf(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(bytes.byteLength);
  out.set(bytes);
  return out;
}

export type ReceiveIdentity = {
  /** Share this, like a shielded receive address */
  tag: string;
  createdAt: number;
};

export type StoredIdentity = {
  v: 1;
  createdAt: number;
  privateJwk: JsonWebKey;
  publicSpkiB64: string;
};

async function generateIdentity(): Promise<StoredIdentity> {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"]
  );
  const privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const spki = new Uint8Array(
    await crypto.subtle.exportKey("spki", pair.publicKey)
  );
  return {
    v: 1,
    createdAt: Date.now(),
    privateJwk,
    publicSpkiB64: b64urlEncode(spki),
  };
}

/* ------------------------------------------------------------ storage */

/*
 * The private halves are sealed at rest under the same data key as the notes
 * (lib/noteVault: a non-extractable AES-GCM key in IndexedDB, or that key
 * wrapped by a passkey), never kept as plain JSON. Sealed values carry the
 * vault's prefix, so turning a passkey on or off reseals them with the notes.
 * Keys an earlier version saved as plain JSON are sealed the first time they
 * are read. Reads and writes run one at a time, so two callers can never make
 * two different addresses or drop an earlier key.
 */

/** Thrown while the vault is locked behind a passkey (recording demo only; elsewhere reads wait for the unlock). */
export class ReceiveKeysLocked extends Error {
  constructor() {
    super("Unlock Gloam to open your Gloam address.");
    this.name = "ReceiveKeysLocked";
  }
}

let queue: Promise<unknown> = Promise.resolve();
function serial<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task);
  queue = run.catch(() => undefined);
  return run;
}

/** Loaded on first use: this module also serves server code that only needs the prefixes. */
function vault() {
  return import("./noteVault");
}

/** Keep a copy of a value that would not open before anything can replace it. */
function setAside(key: string, raw: string) {
  const aside = `${key}.unreadable`;
  try {
    const list = JSON.parse(localStorage.getItem(aside) ?? "[]") as unknown;
    const kept = Array.isArray(list) ? list : [];
    if (!kept.includes(raw)) localStorage.setItem(aside, JSON.stringify([...kept, raw]));
  } catch {
    localStorage.setItem(aside, JSON.stringify([raw]));
  }
}

/** One slot: sealed (opened), plain JSON from an earlier version (sealed now), or null. Null too with no account bound. */
async function readSlot(base: string): Promise<unknown> {
  const key = scopedKey(base);
  if (!key) return null;
  const raw = localStorage.getItem(key);
  if (!raw) return null;
  const v = await vault();
  if (!v.isSealedValue(raw)) {
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      setAside(key, raw);
      return null;
    }
    localStorage.setItem(key, await v.sealJson(value));
    return value;
  }
  if (readDemo() && v.dataKeyLocked()) throw new ReceiveKeysLocked();
  // A key that cannot be had right now is not a damaged value: let it throw.
  await v.vaultKeyReady();
  try {
    return await v.openJsonStrict(raw);
  } catch {
    setAside(key, raw);
    return null;
  }
}

async function loadKeys(): Promise<{ current: StoredIdentity | null; previous: StoredIdentity[] }> {
  if (typeof window === "undefined") return { current: null, previous: [] };
  const current = await readSlot(ID_KEY);
  const previous = await readSlot(PREV_KEY);
  return {
    current: validStored(current) ? current : null,
    previous: Array.isArray(previous) ? previous.filter(validStored) : [],
  };
}

async function saveCurrent(s: StoredIdentity) {
  const key = writableKey(ID_KEY);
  localStorage.setItem(key, await (await vault()).sealJson(s));
  window.dispatchEvent(new Event(RECEIVE_IDENTITY_EVENT));
}

async function savePrevious(list: StoredIdentity[]) {
  const key = writableKey(PREV_KEY);
  localStorage.setItem(key, await (await vault()).sealJson(list));
}

function validStored(s: unknown): s is StoredIdentity {
  const x = s as StoredIdentity | null;
  return Boolean(x && x.v === 1 && x.privateJwk && typeof x.publicSpkiB64 === "string");
}

function identityOf(s: StoredIdentity): ReceiveIdentity {
  return { tag: RECEIVE_TAG_PREFIX + s.publicSpkiB64, createdAt: s.createdAt };
}

/** Every receive key on this browser, for the recovery backup. */
export function exportReceiveKeys(): Promise<{ current: StoredIdentity | null; previous: StoredIdentity[] }> {
  return serial(loadKeys);
}

/**
 * Bring back receive keys from a recovery backup. The backup's current key
 * becomes this browser's current key (it is the Gloam address people were
 * given); a different local key is kept among the earlier ones, so nothing
 * stops opening.
 */
export function importReceiveKeys(data: { current?: unknown; previous?: unknown } | null | undefined): Promise<void> {
  return serial(async () => {
    if (!data || typeof window === "undefined") return;
    const restored = validStored(data.current) ? data.current : null;
    const { current: local, previous: prev } = await loadKeys();
    const incoming = Array.isArray(data.previous) ? data.previous.filter(validStored) : [];
    for (const p of incoming) {
      if (!prev.some((x) => x.publicSpkiB64 === p.publicSpkiB64)) prev.push(p);
    }
    if (restored && local && local.publicSpkiB64 !== restored.publicSpkiB64) {
      if (!prev.some((x) => x.publicSpkiB64 === local.publicSpkiB64)) prev.unshift(local);
    }
    const current = restored ?? local;
    await savePrevious(prev.filter((p) => p.publicSpkiB64 !== current?.publicSpkiB64));
    if (restored && local?.publicSpkiB64 !== restored.publicSpkiB64) await saveCurrent(restored);
  });
}

/**
 * Load or create the signed-in account's sticky receive identity. With no
 * account bound to this page it throws SignedOutError and makes nothing: a
 * signed-out page shows no Gloam address.
 */
export function getOrCreateReceiveIdentity(): Promise<ReceiveIdentity> {
  return serial(async () => {
    if (typeof window !== "undefined" && (scopedKey(ID_KEY) === null || !accountShown())) throw new SignedOutError();
    let { current } = await loadKeys();
    if (!current) {
      current = await generateIdentity();
      await saveCurrent(current);
    }
    return identityOf(current);
  });
}

/** New tag. Payments to the old tag still open: its key is kept among the earlier ones. */
export function rotateReceiveIdentity(): Promise<ReceiveIdentity> {
  return serial(async () => {
    if (scopedKey(ID_KEY) === null || !accountShown()) throw new SignedOutError();
    const { current: old, previous } = await loadKeys();
    if (old && !previous.some((p) => p.publicSpkiB64 === old.publicSpkiB64)) {
      await savePrevious([old, ...previous]);
    }
    const s = await generateIdentity();
    await saveCurrent(s);
    return identityOf(s);
  });
}

export function isReceiveTag(input: string): boolean {
  return input.trim().startsWith(RECEIVE_TAG_PREFIX);
}

/** DER header of a P-256 public key (SPKI), then 0x04 for an uncompressed point. */
const P256_SPKI_HEAD = [
  0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a, 0x86, 0x48,
  0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00, 0x04,
];

// P-256: y^2 = x^3 - 3x + b over the prime field p.
const P256_P = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn;
const P256_B = 0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604bn;

const toBig = (bytes: Uint8Array) => BigInt(`0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`);

/** Whether the uncompressed point x | y (32 bytes each) is on P-256. */
function onP256(xy: Uint8Array): boolean {
  if (xy.length !== 64) return false;
  const x = toBig(xy.subarray(0, 32));
  const y = toBig(xy.subarray(32));
  if (x >= P256_P || y >= P256_P) return false;
  const rhs = (((((x * x) % P256_P) * x - 3n * x + P256_B) % P256_P) + P256_P) % P256_P;
  return (y * y) % P256_P === rhs;
}

/**
 * A whole Gloam address: gloamr1. followed by a P-256 public key that decodes,
 * not just the prefix, and whose point is on the curve. "gloamr1.",
 * "gloamr1.invalid" or a key off the curve fail here, so a payroll row or a
 * payment is refused when it is entered, not after it is proven (sealing to a
 * key off the curve fails with "Invalid keyData").
 */
export function isValidReceiveTag(input: string): boolean {
  const t = input.trim();
  if (!t.startsWith(RECEIVE_TAG_PREFIX)) return false;
  const body = t.slice(RECEIVE_TAG_PREFIX.length);
  if (!/^[A-Za-z0-9_-]{120,124}$/.test(body)) return false;
  let bytes: Uint8Array;
  try {
    bytes = b64urlDecode(body);
  } catch {
    return false;
  }
  return bytes.length === 91 && P256_SPKI_HEAD.every((b, i) => bytes[i] === b) && onP256(bytes.subarray(P256_SPKI_HEAD.length));
}

const toHex32 = (bytes: Uint8Array): `0x${string}` =>
  `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;

/**
 * The point (x, y) inside a whole Gloam address, as two 32-byte hex words: what
 * the GloamNames registry stores for a name. null when the address is not whole.
 */
export function receiveTagPoint(tag: string): { x: `0x${string}`; y: `0x${string}` } | null {
  if (!isValidReceiveTag(tag)) return null;
  const xy = b64urlDecode(tag.trim().slice(RECEIVE_TAG_PREFIX.length)).subarray(P256_SPKI_HEAD.length);
  return { x: toHex32(xy.subarray(0, 32)), y: toHex32(xy.subarray(32)) };
}

/**
 * The Gloam address for a P-256 point (x, y) read from the GloamNames registry.
 * null unless the point is on the curve, so a bad record never becomes an address.
 */
export function receiveTagFromPoint(x: string, y: string): string | null {
  const word = /^0x[0-9a-fA-F]{64}$/;
  if (!word.test(x) || !word.test(y)) return null;
  const bytes = new Uint8Array(P256_SPKI_HEAD.length + 64);
  bytes.set(P256_SPKI_HEAD);
  for (let i = 0; i < 32; i++) {
    bytes[P256_SPKI_HEAD.length + i] = parseInt(x.slice(2 + i * 2, 4 + i * 2), 16);
    bytes[P256_SPKI_HEAD.length + 32 + i] = parseInt(y.slice(2 + i * 2, 4 + i * 2), 16);
  }
  const tag = RECEIVE_TAG_PREFIX + b64urlEncode(bytes);
  return isValidReceiveTag(tag) ? tag : null;
}

export function isPayToTagPackage(input: string): boolean {
  return input.trim().startsWith(PAY_TO_TAG_PREFIX);
}

function parseTagSpki(tag: string): Uint8Array {
  const t = tag.trim();
  if (!t.startsWith(RECEIVE_TAG_PREFIX)) {
    throw new Error("Not a Gloam receive tag (expected gloamr1…).");
  }
  const body = t.slice(RECEIVE_TAG_PREFIX.length);
  if (body.length < 40) throw new Error("Receive tag looks truncated.");
  return b64urlDecode(body);
}

async function importRecipientPublic(spki: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "spki",
    buf(spki),
    { name: "ECDH", namedCurve: "P-256" },
    false,
    []
  );
}

async function importOurPrivate(jwk: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"]
  );
}

async function ecdhAesKey(
  privateKey: CryptoKey,
  publicKey: CryptoKey
): Promise<CryptoKey> {
  const bits = await crypto.subtle.deriveBits(
    { name: "ECDH", public: publicKey },
    privateKey,
    256
  );
  // HKDF for domain separation
  const base = await crypto.subtle.importKey("raw", bits, "HKDF", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(0),
      info: buf(new TextEncoder().encode("gloam-pay-to-tag-v1")),
    },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

/** Sealed tickets grow in steps of this many bytes before they are encrypted. */
const SEAL_PAD_STEP = 512;
/**
 * The largest plaintext a ticket can be (a 78-digit amount, an 8-digit chain id
 * and an 80-character note at its worst, RELAY_MEMO_MAX_BYTES in
 * lib/relay/server has the sums): the last step stops here, so padding never
 * makes a ticket bigger than the biggest one already was. The SDK pads the same.
 */
const SEAL_PAD_MAX = 1177;

/**
 * Pads a ticket with spaces to the next 512-byte step (512, 1024, then 1177),
 * so a payment message's length on the public board no longer gives away how
 * many digits the amount has or how long the note is. Readers trim it: the
 * app's and the SDK's decodeNotePackage, and decryptTicketWithLocalTag here.
 */
export function padSealed(raw: Uint8Array): Uint8Array {
  const size = Math.min(Math.ceil(raw.length / SEAL_PAD_STEP) * SEAL_PAD_STEP, SEAL_PAD_MAX);
  if (raw.length >= size) return raw;
  const out = new Uint8Array(size).fill(0x20);
  out.set(raw);
  return out;
}

/**
 * Encrypt a payment ticket JSON string for a receive tag, padded (padSealed).
 * Returns gloam2t.… for handoff (QR/share), only tag owner can open.
 */
export async function encryptTicketForTag(
  plainTicketJsonOrGloam1: string,
  recipientTag: string
): Promise<string> {
  const theirSpki = parseTagSpki(recipientTag);
  const theirPub = await importRecipientPublic(theirSpki);

  const ephem = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"]
  );
  const ephemSpki = new Uint8Array(
    await crypto.subtle.exportKey("spki", ephem.publicKey)
  );
  const aes = await ecdhAesKey(ephem.privateKey, theirPub);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: buf(iv) },
      aes,
      buf(padSealed(new TextEncoder().encode(plainTicketJsonOrGloam1)))
    )
  );

  // layout: ephemLen(2 BE) | ephemSpki | iv(12) | cipher
  if (ephemSpki.length > 0xffff) throw new Error("ephem key too large");
  const out = new Uint8Array(2 + ephemSpki.length + 12 + cipher.length);
  out[0] = (ephemSpki.length >> 8) & 0xff;
  out[1] = ephemSpki.length & 0xff;
  out.set(ephemSpki, 2);
  out.set(iv, 2 + ephemSpki.length);
  out.set(cipher, 2 + ephemSpki.length + 12);
  return PAY_TO_TAG_PREFIX + b64urlEncode(out);
}

/**
 * Decrypt gloam2t.… using this browser’s receive identity. Returns the ticket
 * as it was sealed, without the padding.
 */
export async function decryptTicketWithLocalTag(
  sealed: string
): Promise<string> {
  const s = sealed.trim();
  if (!s.startsWith(PAY_TO_TAG_PREFIX)) {
    throw new Error("Not a pay-to-tag package (gloam2t…).");
  }
  // Only the signed-in account's keys: a payment sent to another account's address waits for that account.
  if (!accountShown()) throw new SignedOutError();
  const { current, previous } = await serial(loadKeys);
  const keys = [...(current ? [current] : []), ...previous];
  if (!keys.length) {
    if (scopedKey(ID_KEY) === null) throw new SignedOutError();
    throw new Error("No receive tag in this browser, generate one under Claim.");
  }
  const raw = b64urlDecode(s.slice(PAY_TO_TAG_PREFIX.length));
  if (raw.length < 2 + 12 + 16) throw new Error("Corrupt pay-to-tag package.");
  const ephemLen = (raw[0]! << 8) | raw[1]!;
  if (raw.length < 2 + ephemLen + 12 + 1) throw new Error("Corrupt package length.");
  const ephemSpki = raw.slice(2, 2 + ephemLen);
  const iv = raw.slice(2 + ephemLen, 2 + ephemLen + 12);
  const cipher = raw.slice(2 + ephemLen + 12);

  const ephemPub = await importRecipientPublic(ephemSpki);
  // The current key first, then earlier ones (payments sent to an older address).
  for (const key of keys) {
    try {
      const ourPriv = await importOurPrivate(key.privateJwk);
      const aes = await ecdhAesKey(ourPriv, ephemPub);
      const plain = new Uint8Array(
        await crypto.subtle.decrypt(
          { name: "AES-GCM", iv: buf(iv) },
          aes,
          buf(cipher)
        )
      );
      return new TextDecoder().decode(plain).trimEnd();
    } catch {
      /* not for this key */
    }
  }
  throw new Error(
    "Could not open this ticket with your tag, it was encrypted for someone else."
  );
}

export function shortTag(tag: string, head = 14, tail = 8): string {
  const t = tag.trim();
  if (t.length <= head + tail + 1) return t;
  return `${t.slice(0, head)}…${t.slice(-tail)}`;
}
