/**
 * Showing the payments between two private accounts on Starknet (the STRK20
 * privacy pool, starkware-libs/starknet-privacy), checked by anyone against
 * the pool's own storage.
 *
 * This is a disclosure, not a zero-knowledge proof, and it shows more than one
 * payment. In the pool, every note from a sender to a recipient lives in one
 * channel, under one key:
 *   channel key = H(sender, sender's private key, recipient, recipient's public key)
 *   note id     = H("NOTE_ID_TAG:V1", channel key, token, index)
 *   amount      = packed value (salt, enc) opened with H("ENC_AMOUNT_TAG:V1", channel key, token, index, salt)
 * (Poseidon on the Stark field, double tagged: packages/privacy/src/hashes.cairo).
 * There is no narrower opening: one payment's amount can only be read with
 * the channel key, and the channel key reads them all. So whoever holds this
 * sees every payment the sender has made to the recipient in that channel,
 * every token, before and after it was made, for good: viewing keys never
 * change in the pool (WriteOnce). It does not show any other channel, either
 * account's balance, or when a payment was spent (that needs the recipient's
 * private key).
 *
 * Why the pool vouches for it: the pool wrote channel_exists[H("CHANNEL_MARKER_TAG:V1",
 * channel key, sender, recipient, recipient's public key)] when the sender opened the
 * channel, inside a run that checked the sender's registered key and was
 * signed by the sender's account (privacy.cairo open_channel). Notes in it
 * can only be made by that sender (create_enc_note derives the key from the
 * caller's own key), and each note's amount was taken from the sender's
 * private balance in the same run.
 *
 * The disclosure is signed by the account that makes it (the sender or the
 * recipient), SNIP-12 typed data checked by that account's own
 * is_valid_signature, so the name of who it is for and its expiry are that
 * account's. The expiry says when to stop relying on it; it can't stop the
 * reader from reading the channel later.
 */
import { ec, shortString } from "starknet";
import { displayLabel, isPlainLabel, MAX_LABEL, plainLabel } from "./label";
import type { ChainCheck, ChainCheckState } from "./solanaPayment";

export const STARKNET_CHANNEL_PREFIX = "gloamsnpay1:";

export type StarknetProofNetwork = "mainnet" | "sepolia" | "devnet";

export type StarknetChannelProof = {
  v: 1;
  kind: "starknet-channel";
  network: StarknetProofNetwork;
  pool: string;
  sender: string;
  recipient: string;
  /** The channel's key: it opens every payment in the channel. */
  channelKey: string;
  /** Which of the two accounts made and signed it. */
  by: "recipient" | "sender";
  verifier: string;
  expiresAt: number;
  /** The maker account's signature over starknetChannelTypedData(proof). */
  signature: string[];
};

/** One payment in the channel, as read from the pool. */
export type ChannelPayment = {
  token: string;
  index: number;
  amount: bigint;
  noteId: string;
  /** When it was made, from its EncNoteCreated event's block; absent when it wasn't read. */
  at?: number;
  tx?: string;
};

export type StarknetChannelResult = {
  ok: boolean;
  checks: ChainCheck[];
  expired: boolean;
  payments: ChannelPayment[];
  /** Notes that came in from outside the pool (a bridge or a swap), not from the sender's balance: not counted. */
  outside: number;
};

/** The pool's views and the chain facts the checks read. Throws when the network can't be reached. */
export type StarknetChannelReader = {
  publicKey(user: bigint): Promise<bigint>;
  channelExists(marker: bigint): Promise<boolean>;
  subchannelInfo(id: bigint): Promise<{ salt: bigint; encToken: bigint }>;
  subchannelExists(marker: bigint): Promise<boolean>;
  note(id: bigint): Promise<{ packed: bigint }>;
  /** Block time and transaction of each note's creation event, where found. */
  noteEvents(ids: bigint[]): Promise<Map<bigint, { at: number; tx: string }>>;
  /** The account's own is_valid_signature on `hash` (false when there is no such account or it refuses). */
  isValidSignature(account: bigint, hash: string, signature: string[]): Promise<boolean>;
};

export type StarknetChannelDeps = {
  /** The reader for a network this page checks, or null for one it doesn't. */
  reader(network: StarknetProofNetwork): StarknetChannelReader | null;
  /** The pool this page trusts on that network (Starknet's canonical pool on mainnet). */
  pool(network: StarknetProofNetwork): string | null;
  chainId(network: StarknetProofNetwork): string;
  /** SNIP-12 message hash of the typed data for `account` (starknet.js typedData.getMessageHash). */
  messageHash(typedData: ReturnType<typeof starknetChannelTypedData>, account: string): string;
  now?: () => number;
  when?: (unix: number) => string;
};

/* ---------- the pool's hashes (packages/privacy/src/hashes.cairo, mirrored by the SDK's utils/hashes) ---------- */

const P = ec.starkCurve.CURVE.Fp.ORDER;
const TWO_128 = 1n << 128n;
const tag = (t: string) => BigInt(shortString.encodeShortString(t));
const H = (...v: bigint[]) => ec.starkCurve.poseidonHashMany(v);

export const channelMarker = (ck: bigint, sender: bigint, recipient: bigint, rpk: bigint) =>
  H(tag("CHANNEL_MARKER_TAG:V1"), ck, sender, recipient, rpk);
export const subchannelId = (ck: bigint, index: number) => H(tag("SUBCHANNEL_ID_TAG:V1"), ck, BigInt(index), 0n);
export const subchannelMarker = (ck: bigint, recipient: bigint, rpk: bigint, token: bigint) =>
  H(tag("SUBCHANNEL_MARKER_TAG:V1"), ck, recipient, rpk, token);
export const noteId = (ck: bigint, token: bigint, index: number) => H(tag("NOTE_ID_TAG:V1"), ck, token, BigInt(index), 0n);
const encTokenPad = (ck: bigint, index: number, salt: bigint) => H(tag("ENC_TOKEN_TAG:V1"), ck, BigInt(index), 0n, salt);
const encAmountPad = (ck: bigint, token: bigint, index: number, salt: bigint) => H(tag("ENC_AMOUNT_TAG:V1"), ck, token, BigInt(index), 0n, salt);

export function subchannelToken(ck: bigint, index: number, salt: bigint, encToken: bigint): bigint {
  return (((encToken - encTokenPad(ck, index, salt)) % P) + P) % P;
}

/** A note's amount from its packed value, and whether it is an open note (salt 1: plain amount, funded from outside). */
export function noteAmount(packed: bigint, ck: bigint, token: bigint, index: number): { amount: bigint; open: boolean } {
  const salt = packed / TWO_128;
  const enc = packed % TWO_128;
  if (salt === 1n) return { amount: enc, open: true };
  const pad = encAmountPad(ck, token, index, salt) % TWO_128;
  return { amount: (enc + TWO_128 - pad) % TWO_128, open: false };
}

/* ---------- the shareable text and what gets signed ---------- */

const FELT = /^0x[0-9a-f]{1,64}$/;
const isStr = (v: unknown): v is string => typeof v === "string";
const felt = (v: string) => `0x${BigInt(v).toString(16)}`;

export function cleanStarknetLabel(label: string): string {
  const v = plainLabel(label);
  if (!v) throw new Error("Say who this is for.");
  if (Array.from(v).length > MAX_LABEL) throw new Error(`Keep the name under ${MAX_LABEL} characters.`);
  return v;
}

/** SNIP-12 (revision 1) typed data the maker's account signs. */
export function starknetChannelTypedData(p: Omit<StarknetChannelProof, "signature">, chainId: string) {
  return {
    types: {
      StarknetDomain: [
        { name: "name", type: "shortstring" },
        { name: "version", type: "shortstring" },
        { name: "chainId", type: "shortstring" },
        { name: "revision", type: "shortstring" },
      ],
      Disclosure: [
        { name: "kind", type: "shortstring" },
        { name: "pool", type: "ContractAddress" },
        { name: "sender", type: "ContractAddress" },
        { name: "recipient", type: "ContractAddress" },
        { name: "channel", type: "felt" },
        { name: "by", type: "shortstring" },
        { name: "verifier", type: "string" },
        { name: "expires", type: "timestamp" },
      ],
    },
    primaryType: "Disclosure",
    domain: { name: "Gloam proof", version: "1", chainId, revision: "1" },
    message: {
      kind: "payments in a channel",
      pool: felt(p.pool),
      sender: felt(p.sender),
      recipient: felt(p.recipient),
      channel: felt(p.channelKey),
      by: p.by,
      verifier: p.verifier,
      expires: p.expiresAt,
    },
  };
}

function toBase64(text: string): string {
  let bin = "";
  for (const b of new TextEncoder().encode(text)) bin += String.fromCharCode(b);
  return btoa(bin);
}

function fromBase64(b64: string): string {
  const bin = atob(b64.replace(/\s+/g, ""));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

export function encodeStarknetChannel(p: StarknetChannelProof): string {
  return STARKNET_CHANNEL_PREFIX + toBase64(JSON.stringify(p));
}

export function isStarknetChannelText(text: string): boolean {
  return text.trim().startsWith(STARKNET_CHANNEL_PREFIX);
}

function wellFormed(p: StarknetChannelProof): boolean {
  return (
    p.v === 1 &&
    p.kind === "starknet-channel" &&
    (p.network === "mainnet" || p.network === "sepolia" || p.network === "devnet") &&
    [p.pool, p.sender, p.recipient, p.channelKey].every((x) => isStr(x) && FELT.test(x)) &&
    (p.by === "recipient" || p.by === "sender") &&
    isStr(p.verifier) &&
    Number.isSafeInteger(p.expiresAt) &&
    Array.isArray(p.signature) &&
    p.signature.length > 0 &&
    p.signature.length <= 8 &&
    p.signature.every((x) => isStr(x) && FELT.test(x))
  );
}

export function decodeStarknetChannel(text: string): StarknetChannelProof {
  const t = text.trim();
  if (!t.startsWith(STARKNET_CHANNEL_PREFIX)) throw new Error("Not a Gloam proof.");
  let p: StarknetChannelProof;
  try {
    p = JSON.parse(fromBase64(t.slice(STARKNET_CHANNEL_PREFIX.length))) as StarknetChannelProof;
  } catch {
    throw new Error("This proof is damaged. Ask for it again.");
  }
  if (!p || typeof p !== "object" || !wellFormed(p)) throw new Error("This proof is damaged. Ask for it again.");
  return p;
}

/* ---------- reading the channel ---------- */

/** Most tokens and notes per token read from one channel (a reader's cost stays bounded). */
export const MAX_SUBCHANNELS = 16;
export const MAX_NOTES_PER_TOKEN = 200;

/**
 * Every payment in the channel, read from the pool: each token's subchannel,
 * then its notes in order until the first that does not exist. Throws when
 * the network fails, or with "too many" past the bounds above.
 */
export async function readChannel(
  r: StarknetChannelReader,
  ck: bigint,
  recipient: bigint,
  rpk: bigint
): Promise<{ payments: ChannelPayment[]; outside: number; tokens: number }> {
  const payments: ChannelPayment[] = [];
  let outside = 0;
  let tokens = 0;
  for (let k = 0; ; k++) {
    if (k >= MAX_SUBCHANNELS) throw new Error("too many");
    const sub = await r.subchannelInfo(subchannelId(ck, k));
    if (sub.salt === 0n) break;
    const token = subchannelToken(ck, k, sub.salt, sub.encToken);
    // the pool wrote this marker in the same run as the subchannel: the token read is the one the sender opened
    if (!(await r.subchannelExists(subchannelMarker(ck, recipient, rpk, token)))) throw new Error("subchannel");
    tokens++;
    for (let i = 0; ; i++) {
      if (i >= MAX_NOTES_PER_TOKEN) throw new Error("too many");
      const id = noteId(ck, token, i);
      const n = await r.note(id);
      if (n.packed === 0n) break;
      const { amount, open } = noteAmount(n.packed, ck, token, i);
      if (open) {
        outside++;
        continue;
      }
      // a zero note fills a reverted index (CreateEncNoteInput): not a payment
      if (amount === 0n) continue;
      payments.push({ token: `0x${token.toString(16)}`, index: i, amount, noteId: `0x${id.toString(16)}` });
    }
  }
  return { payments, outside, tokens };
}

function localWhen(unix: number): string {
  return new Date(unix * 1000).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
}

const NAMES: Record<StarknetProofNetwork, string> = { mainnet: "Starknet", sepolia: "Starknet Sepolia", devnet: "Starknet devnet" };
export const starknetNetworkName = (n: StarknetProofNetwork) => NAMES[n] ?? "Starknet";

/** Every check, in order. A check that could not run is never a pass. */
export async function verifyStarknetChannel(p: StarknetChannelProof, deps: StarknetChannelDeps): Promise<StarknetChannelResult> {
  const now = deps.now?.() ?? Math.floor(Date.now() / 1000);
  const when = deps.when ?? localWhen;
  const checks: ChainCheck[] = [];
  const add = (label: string, state: ChainCheckState, detail?: string) => checks.push({ label, state, detail });
  const expired = !(Number.isSafeInteger(p.expiresAt) && now <= p.expiresAt);
  const expiry = () => add(expired ? "Expired" : "Not expired", expired ? "fail" : "pass", `Valid until ${when(p.expiresAt)}.`);
  let payments: ChannelPayment[] = [];
  let outside = 0;
  const finish = (): StarknetChannelResult => ({
    ok: !expired && checks.length > 0 && checks.every((c) => c.state === "pass"),
    checks,
    expired,
    payments,
    outside,
  });
  const net = starknetNetworkName(p.network);
  const reader = deps.reader(p.network);
  const trusted = deps.pool(p.network);

  // 1) The network and the pool: Starknet's own privacy pool there.
  const official = Boolean(trusted && BigInt(trusted) === BigInt(p.pool));
  if (!reader) {
    add(`Made on ${net}`, "fail", `This page checks a different Starknet network. This was made on ${net}.`);
    expiry();
    return finish();
  }
  add(
    official ? `Made on Starknet's privacy pool on ${net}` : "Made on Starknet's privacy pool",
    official ? "pass" : "fail",
    official ? undefined : "The pool named is not the one Gloam uses, so what it holds can't be trusted."
  );
  if (!official) {
    expiry();
    return finish();
  }

  const sender = BigInt(p.sender);
  const recipient = BigInt(p.recipient);
  const ck = BigInt(p.channelKey);
  const offline = `Could not reach ${net}. Try again.`;

  // 2) Signed by the account that made it, for this reader.
  const maker = p.by === "recipient" ? recipient : sender;
  let signed: boolean | null = null;
  try {
    const { signature: _drop, ...rest } = p;
    void _drop;
    const hash = deps.messageHash(starknetChannelTypedData(rest, deps.chainId(p.network)), p.by === "recipient" ? p.recipient : p.sender);
    signed = await reader.isValidSignature(maker, hash, p.signature);
  } catch {
    signed = null;
  }
  const who = p.by === "recipient" ? "the account paid" : "the account that paid";
  add(
    `Made for "${displayLabel(p.verifier)}"`,
    signed == null ? "unknown" : signed ? "pass" : "fail",
    signed == null
      ? offline
      : signed
        ? isPlainLabel(p.verifier)
          ? `Signed by ${who}. The name and the expiry are sealed into it.`
          : `Signed by ${who}. Hidden characters in the name are not shown.`
        : "The signature does not match. It was edited, or the account named did not make it."
  );
  if (signed !== true) {
    expiry();
    return finish();
  }

  // 3) The channel: opened by the sender, to the recipient, with this key.
  if (sender === recipient) {
    add("Payments from one account to another", "fail", "This is an account's own channel: money it moved to itself, not payments.");
    expiry();
    return finish();
  }
  let rpk: bigint;
  let exists: boolean;
  try {
    rpk = await reader.publicKey(recipient);
    exists = rpk !== 0n && (await reader.channelExists(channelMarker(ck, sender, recipient, rpk)));
  } catch {
    add("Payments from one account to another", "unknown", offline);
    expiry();
    return finish();
  }
  add(
    "Payments from one account to another",
    exists ? "pass" : "fail",
    exists
      ? `The pool opened this channel from ${p.sender} to ${p.recipient}, with this key.`
      : "The pool has no such channel between these accounts. The key or an address was changed."
  );
  if (!exists) {
    expiry();
    return finish();
  }

  // 4) What the channel holds, read from the pool.
  try {
    const read = await readChannel(reader, ck, recipient, rpk);
    payments = read.payments;
    outside = read.outside;
    add(
      "Every payment read from the pool",
      payments.length > 0 ? "pass" : "fail",
      payments.length > 0
        ? `${payments.length} ${payments.length === 1 ? "payment" : "payments"}, each amount opened from the pool's own record.`
        : "There are no payments in this channel yet."
    );
  } catch (e) {
    const many = e instanceof Error && e.message === "too many";
    add(
      "Every payment read from the pool",
      many ? "fail" : "unknown",
      many ? "This channel holds more payments than this page reads at once." : offline
    );
    expiry();
    return finish();
  }

  // When each was made: read from the pool's events. Only dates read from chain are ever shown.
  try {
    const events = await reader.noteEvents(payments.map((x) => BigInt(x.noteId)));
    payments = payments.map((x) => {
      const ev = events.get(BigInt(x.noteId));
      return ev ? { ...x, at: ev.at, tx: ev.tx } : x;
    });
  } catch {
    /* dates are shown only when read; the amounts above stand on their own */
  }

  // 5) Expiry.
  expiry();
  return finish();
}
