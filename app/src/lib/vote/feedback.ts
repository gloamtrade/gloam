/**
 * Holder feedback: an optional note after voting, private to the Gloam team.
 * Server only. Never shown on the site; only /admin reads it.
 *
 * Only a wallet that carries weight in a vote open right now can send one,
 * and it signs the note (EIP-712, free, nothing on chain), so a note always
 * comes from a real holder. Limits: a few notes per wallet per day, and per
 * IP per hour (in the route). Notes are kept in the app's store
 * (lib/partnersKv: Upstash Redis, eviction off) with no expiry, newest
 * first, up to MAX_KEPT; past that the oldest drop off.
 */
import "server-only";
import { createHash, randomUUID } from "crypto";
import { createPublicClient, getAddress, isAddress, isHex, recoverTypedDataAddress, type Hex, type PublicClient } from "viem";
import { robinhood } from "../chain";
import { serverTransport } from "../serverRpc";
import { jsonOf, kv } from "../partnersKv";
import {
  FEEDBACK_CATEGORIES,
  FEEDBACK_MAX,
  MAX_SIGNATURE_HEX,
  SIGNED_MAX_AGE_SEC,
  SIGNED_MAX_AHEAD_SEC,
  WALLET_DOMAIN_CHAINS,
  cleanFeedback,
  feedbackTypedData,
  weightOf,
  weightingOf,
  type FeedbackCategory,
} from "./core";
import { balanceNow } from "./chainReads";
import type { VoteConfig } from "./config";
import { acceptingVotes, excludedForVote, snapshotFor, visibleVotes } from "./registry";
import { VoteError } from "./submit";

const PREFIX = "gloam:vote:v1:feedback:";
const LIST = `${PREFIX}list`;
export const FEEDBACK_MAX_KEPT = 20_000;
/** Notes one wallet can send in a UTC day. */
export const FEEDBACK_PER_WALLET_PER_DAY = 3;

export type Feedback = {
  id: string;
  author: `0x${string}`;
  category: FeedbackCategory;
  message: string;
  /** Seconds, as signed. */
  timestamp: number;
  signature: Hex;
  /** ms, when the server took it. */
  receivedAt: number;
};

type Verify = (author: `0x${string}`, typed: ReturnType<typeof feedbackTypedData>, signature: Hex) => Promise<boolean>;

let rhClient: PublicClient | null = null;

/** EOAs offline; smart wallets through ERC-1271/6492 over Robinhood Chain, like the votes. */
async function defaultVerify(author: `0x${string}`, typed: ReturnType<typeof feedbackTypedData>, signature: Hex): Promise<boolean> {
  // the typed data as sent, then as a wallet that adds its chain to the domain signs it, as a vote allows
  for (const domain of [typed.domain, ...WALLET_DOMAIN_CHAINS.map((chainId) => ({ ...typed.domain, chainId }))]) {
    try {
      const got = await recoverTypedDataAddress({ ...typed, domain, signature });
      if (got.toLowerCase() === author.toLowerCase()) return true;
    } catch {
      /* not an EOA signature: try the contract check */
    }
  }
  rhClient ??= createPublicClient({
    chain: robinhood,
    ccipRead: false,
    transport: serverTransport({ chainId: robinhood.id, chain: robinhood, historyRpc: null }, { timeout: 8_000, retryCount: 1 }),
  }) as PublicClient;
  try {
    return await rhClient.verifyTypedData({ address: author, ...typed, signature });
  } catch {
    return false;
  }
}

/** The wallet's weight in the votes open now (its $GLOAM now in a close-weighted one); feedback needs some. */
export async function feedbackWeight(author: string, votes: VoteConfig[] = visibleVotes(), now: number = Date.now()): Promise<bigint> {
  let best = 0n;
  for (const v of votes) {
    const snap = snapshotFor(v);
    if (!acceptingVotes(v, snap, now)) continue;
    const excluded = excludedForVote(v);
    let weight = 0n;
    if (weightingOf(v) === "close") weight = excluded.has(author.toLowerCase()) ? 0n : ((await balanceNow(author, { now })) ?? 0n);
    else if (snap) weight = weightOf(snap, excluded, author).weight;
    if (weight > best) best = weight;
  }
  return best;
}

export async function submitFeedback(
  raw: unknown,
  ctx: { now?: number; votes?: VoteConfig[]; verify?: Verify; weight?: (author: string) => bigint | Promise<bigint> } = {},
): Promise<Feedback> {
  const now = ctx.now ?? Date.now();
  const b = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const author = typeof b.author === "string" ? b.author.trim() : "";
  if (!isAddress(author, { strict: false })) throw new VoteError(400, "bad_author", "Connect your wallet first.");
  const category = FEEDBACK_CATEGORIES.includes(b.category as FeedbackCategory) ? (b.category as FeedbackCategory) : null;
  if (!category) throw new VoteError(400, "bad_category", "Pick what kind of note this is.");
  if (typeof b.message !== "string" || b.message.length > FEEDBACK_MAX * 2) throw new VoteError(400, "bad_message", `Keep it under ${FEEDBACK_MAX.toLocaleString("en-US")} characters.`);
  const message = cleanFeedback(b.message);
  // what was signed must already be clean, so the stored note is exactly the signed one
  if (message !== b.message) throw new VoteError(400, "unclean", "That note has characters we can't keep. Edit it and send again.");
  if (message.length < 3) throw new VoteError(400, "too_short", "Write a few words first.");
  const timestamp = b.timestamp;
  if (typeof timestamp !== "number" || !Number.isSafeInteger(timestamp)) throw new VoteError(400, "bad_timestamp", "Something went wrong. Send it again.");
  const nowSec = Math.floor(now / 1000);
  if (timestamp < nowSec - SIGNED_MAX_AGE_SEC || timestamp > nowSec + SIGNED_MAX_AHEAD_SEC) throw new VoteError(400, "stale", "That signature is too old. Send it again.");
  const signature = typeof b.signature === "string" ? b.signature.trim() : "";
  if (!isHex(signature, { strict: true }) || signature.length < 132 || signature.length > MAX_SIGNATURE_HEX) {
    throw new VoteError(400, "bad_signature", "That signature doesn't look right. Send it again.");
  }

  const who = getAddress(author);
  if ((await (ctx.weight ? ctx.weight(who) : feedbackWeight(who, ctx.votes, now))) === 0n) {
    throw new VoteError(403, "not_holder", "Notes come from wallets that can vote in an open vote, so we know each one is from a holder.");
  }
  const typed = feedbackTypedData({ category, message, author: who, timestamp });
  if (!(await (ctx.verify ?? defaultVerify)(who, typed, signature as Hex))) {
    throw new VoteError(401, "bad_signature", "That signature doesn't match this wallet. Send it again.");
  }

  // the same signed note twice is one note
  const sigKey = `${PREFIX}sig:${createHash("sha256").update(signature.toLowerCase()).digest("hex")}`;
  const day = Math.floor(now / 86_400_000);
  const countKey = `${PREFIX}count:${who.toLowerCase()}:${day}`;
  const [sent] = await kv([["GET", countKey]]);
  if (Number(sent ?? 0) >= FEEDBACK_PER_WALLET_PER_DAY) {
    throw new VoteError(429, "wallet_limit", `That's ${FEEDBACK_PER_WALLET_PER_DAY} notes from this wallet today. Send more tomorrow, or email hello@gloam.trade.`);
  }
  const [fresh] = await kv([["SET", sigKey, "1", "NX", "EX", 7 * 86_400]]);
  if (fresh === null) throw new VoteError(409, "duplicate", "We already have this note. Thank you.");
  await kv([["INCR", countKey], ["EXPIRE", countKey, 2 * 86_400]]);

  const entry: Feedback = { id: randomUUID(), author: who, category, message, timestamp, signature: signature as Hex, receivedAt: now };
  await kv([
    ["LPUSH", LIST, JSON.stringify(entry)],
    ["LTRIM", LIST, 0, FEEDBACK_MAX_KEPT - 1],
  ]);
  return entry;
}

/** Every note, newest first. Admin only: the route checks the session. */
export async function listFeedback(limit = FEEDBACK_MAX_KEPT): Promise<Feedback[]> {
  const [raw] = await kv([["LRANGE", LIST, 0, limit - 1]]);
  return (Array.isArray(raw) ? raw : []).map((r) => jsonOf<Feedback>(r)).filter((f): f is Feedback => f !== null);
}

export function feedbackCsv(rows: Feedback[]): string {
  const cell = (s: string) => `"${(/^[=+\-@\t\r]/.test(s) ? `'${s}` : s).replace(/"/g, '""')}"`;
  const header = ["received_utc", "author", "category", "message", "timestamp", "signature"];
  const lines = rows.map((f) => [new Date(f.receivedAt).toISOString(), f.author, f.category, f.message, String(f.timestamp), f.signature].map(cell));
  return [header.map(cell), ...lines].map((r) => r.join(",")).join("\r\n") + "\r\n";
}

