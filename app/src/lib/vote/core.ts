/**
 * $GLOAM holder votes: the rules, shared by the page, the API, the snapshot
 * and recount scripts, and the self-test. Nothing here touches storage or the
 * network, so anyone can run the same code to recount a vote.
 *
 * - Weight: a wallet's public $GLOAM balance on Robinhood Chain mainnet, minus
 *   the excluded addresses (lib/vote/excluded), which weigh nothing. Which
 *   balance depends on the vote's `weighting`: at its snapshot block (read
 *   from lib/vote/snapshots), or at its closing block (the first block at or
 *   after `end`; live balances stand in until then). See lib/vote/config.
 * - A vote is an EIP-712 signature (VOTE_DOMAIN, VOTE_TYPES): no transaction
 *   and no gas. It names the vote, the option and its label, the voter, the
 *   snapshot block and the time it was signed.
 * - One wallet, one weighted vote. A wallet can vote again until the end; the
 *   signature with the latest timestamp wins.
 */
import { getAddress, isAddress, recoverMessageAddress, recoverTypedDataAddress, type Address, type Hex } from "viem";
import { displayAmount } from "../amountShort";
import type { VoteConfig } from "./config";
import type { Excluded } from "./excluded";

export const VOTE_CHAIN_ID = 4663;
export const GLOAM_TOKEN_ADDRESS: Address = "0xDcD885F5c60b3aD49F6D58718696417314e8724d";
/** The block $GLOAM was minted in (its first Transfer log). Replays start here. */
export const GLOAM_FIRST_BLOCK = 39_918_259;
export const GLOAM_DECIMALS = 18;

/** No chainId: a wallet signs from whatever chain it is on, so nobody has to switch networks to vote. */
export const VOTE_DOMAIN = { name: "Gloam holder vote", version: "1" } as const;

export const VOTE_TYPES = {
  Vote: [
    { name: "vote", type: "string" },
    { name: "option", type: "uint8" },
    { name: "choice", type: "string" },
    { name: "voter", type: "address" },
    { name: "snapshotBlock", type: "uint256" },
    { name: "timestamp", type: "uint64" },
  ],
} as const;

/** Holder feedback is signed the same way: the wallet shows the whole note before it goes. */
export const FEEDBACK_TYPES = {
  Feedback: [
    { name: "purpose", type: "string" },
    { name: "category", type: "string" },
    { name: "message", type: "string" },
    { name: "author", type: "address" },
    { name: "timestamp", type: "uint64" },
  ],
} as const;
export const FEEDBACK_PURPOSE = "Private feedback to the Gloam team";
export const FEEDBACK_CATEGORIES = ["Feature", "Bug", "Idea", "Other"] as const;
export type FeedbackCategory = (typeof FEEDBACK_CATEGORIES)[number];
export const FEEDBACK_MAX = 1_000;

/** A note as people type it, made safe to keep and show: no tags, no control characters, trimmed, capped. */
export function cleanFeedback(raw: string): string {
  return raw
    .replace(/<\/?[a-zA-Z!][^>]*>/g, " ")
    .replace(/[<>]/g, "")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, FEEDBACK_MAX);
}

export function feedbackTypedData(m: { category: string; message: string; author: Address; timestamp: number }) {
  return {
    domain: VOTE_DOMAIN,
    types: FEEDBACK_TYPES,
    primaryType: "Feedback" as const,
    message: { purpose: FEEDBACK_PURPOSE, category: m.category, message: m.message, author: getAddress(m.author), timestamp: BigInt(m.timestamp) },
  };
}

export type VoteMessage = {
  vote: string;
  option: number;
  choice: string;
  voter: Address;
  snapshotBlock: bigint;
  timestamp: bigint;
};

/** A signed vote as it is stored and published. Amounts are wei strings. */
export type Ballot = {
  voter: Address;
  option: number;
  choice: string;
  weight: string;
  /** Seconds, as signed. */
  timestamp: number;
  signature: Hex;
  /** Milliseconds, when the server took it. Not signed. */
  receivedAt: number;
};

/** Every holder's balance at one block, as scripts/vote-snapshot.mts writes it. */
export type VoteSnapshot = {
  voteId: string;
  chainId: number;
  token: string;
  block: number;
  blockHash: string;
  /** Seconds. */
  blockTime: number;
  /** ISO time the snapshot was taken. */
  takenAt: string;
  /** Lowercase address to balance in wei, holders above zero only. */
  balances: Record<string, string>;
  /** How many balances were also read with balanceOf at the block, and how many differed (must be 0). */
  checked: { balanceOf: number; mismatches: number } | null;
};

export type VoteStatus = "draft" | "upcoming" | "open" | "closed";

export type Weighting = "snapshot" | "close";

/** What sets a wallet's weight in this vote. A vote without the field weighs the snapshot, as before. */
export function weightingOf(v: Pick<VoteConfig, "weighting">): Weighting {
  return v.weighting === "close" ? "close" : "snapshot";
}

/**
 * A close-weighted vote's final weights: every voter's $GLOAM at the closing
 * block, worked out from the Transfer logs, and the count they give. Stored
 * once, the first time results are asked for after the close; computing it
 * again gives the same numbers (only `computedAt` moves).
 */
export type FinalWeights = {
  voteId: string;
  chainId: number;
  token: string;
  /** The vote's end, as configured. */
  end: string;
  /** The first block whose timestamp is at or after `end`. */
  closeBlock: number;
  closeBlockHash: string;
  /** Seconds. */
  closeBlockTime: number;
  /** The checked block the Transfer replay started from (the snapshot), or 0 for a replay from launch. */
  replayFrom: number;
  /** How many Transfer logs were replayed after `replayFrom`. */
  logs: number;
  /** ISO time it was worked out. Not part of the result. */
  computedAt: string;
  /** Every voter's balance at `closeBlock`, lowercase address to wei, zeros included. */
  balances: Record<string, string>;
  /** All the GLOAM that could vote at `closeBlock`, less the excluded addresses. */
  eligible: { weight: string; wallets: number };
  /** Voters' balances read again with balanceOf at the block, when the RPC still had its state. */
  checked: { balanceOf: number; mismatches: number } | null;
  /** The ballots that count, with their final weights. */
  counted: Ballot[];
  problems: RecountProblem[];
  totals: { weight: string; wallets: number; options: { option: number; label: string; weight: string; wallets: number }[] };
};

export const MAX_OPTIONS = 5;
/** How far a signed timestamp may sit from the server's clock: behind, and ahead. */
export const SIGNED_MAX_AGE_SEC = 15 * 60;
export const SIGNED_MAX_AHEAD_SEC = 2 * 60;
/** The longest signature taken: a smart wallet's ERC-1271 or ERC-6492 signature can run long. */
export const MAX_SIGNATURE_HEX = 6_000;

/** Paths under /api/vote that are not votes. */
const RESERVED_IDS = new Set(["me", "all", "feedback"]);
const ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

/** What's wrong with a vote's configuration, or an empty list. */
export function configProblems(v: VoteConfig): string[] {
  const out: string[] = [];
  if (!ID_RE.test(v.id)) out.push(`${v.id}: id must be lowercase letters, digits and dashes`);
  if (!v.question.trim()) out.push(`${v.id}: question is empty`);
  if (v.options.length < 2 || v.options.length > MAX_OPTIONS) out.push(`${v.id}: needs 2 to ${MAX_OPTIONS} options`);
  const labels = v.options.map((o) => o.trim().toLowerCase());
  if (labels.some((o) => !o)) out.push(`${v.id}: an option is empty`);
  if (new Set(labels).size !== labels.length) out.push(`${v.id}: two options are the same`);
  if (v.options.some((o) => o.length > 80)) out.push(`${v.id}: keep each option under 80 characters`);
  if (v.details && v.details.length !== v.options.length) out.push(`${v.id}: details needs one line per option`);
  if (v.details?.some((d) => !d.trim() || d.length > 160)) out.push(`${v.id}: keep each detail to one line under 160 characters`);
  if (RESERVED_IDS.has(v.id)) out.push(`${v.id}: that id is taken by the site`);
  if (!Number.isSafeInteger(v.snapshotBlock) || v.snapshotBlock < 0) out.push(`${v.id}: snapshotBlock must be a block number`);
  if (v.snapshotBlock > 0 && v.snapshotBlock < GLOAM_FIRST_BLOCK) out.push(`${v.id}: snapshotBlock is before $GLOAM existed`);
  const start = Date.parse(v.start);
  const end = Date.parse(v.end);
  if (!/Z$/.test(v.start) || !/Z$/.test(v.end)) out.push(`${v.id}: start and end must be UTC (end in Z)`);
  if (!Number.isFinite(start) || !Number.isFinite(end)) out.push(`${v.id}: start or end is not a date`);
  else if (end <= start) out.push(`${v.id}: end must be after start`);
  if (v.weighting !== undefined && v.weighting !== "snapshot" && v.weighting !== "close") out.push(`${v.id}: weighting must be "snapshot" or "close"`);
  if (v.published && v.snapshotBlock === 0 && weightingOf(v) === "snapshot") out.push(`${v.id}: published without a snapshot block`);
  for (const e of v.exclude ?? []) if (!isAddress(e.address, { strict: false })) out.push(`${v.id}: bad excluded address ${e.address}`);
  return out;
}

/** Where a vote stands at `now` (ms). An unpublished vote is a draft whatever the dates say. */
export function voteStatus(v: VoteConfig, now: number = Date.now()): VoteStatus {
  if (!v.published) return "draft";
  if (now < Date.parse(v.start)) return "upcoming";
  if (now >= Date.parse(v.end)) return "closed";
  return "open";
}

/** Inside the voting window at `now` (ms), whatever the published flag says. */
export function inWindow(v: VoteConfig, now: number = Date.now()): boolean {
  return now >= Date.parse(v.start) && now < Date.parse(v.end);
}

/** The message a wallet signs for this choice. */
export function voteMessage(v: VoteConfig, option: number, voter: Address, timestamp: number): VoteMessage {
  return {
    vote: v.id,
    option,
    choice: v.options[option] ?? "",
    voter: getAddress(voter),
    snapshotBlock: BigInt(v.snapshotBlock),
    timestamp: BigInt(timestamp),
  };
}

/** The full typed data for signTypedData and verifyTypedData. */
export function voteTypedData(message: VoteMessage) {
  return { domain: VOTE_DOMAIN, types: VOTE_TYPES, primaryType: "Vote" as const, message };
}

/**
 * Chains some wallets (OKX among them) write into the domain on their own when
 * the typed data has no chainId. A signature made that way is still this vote.
 */
export const WALLET_DOMAIN_CHAINS = [4663, 1, 8453, 4217, 56, 196, 42161, 10, 137, 43114, 59144, 324, 534352, 81457, 5000] as const;

/**
 * The same vote as plain text, for wallets that can't sign typed data: the
 * page falls back to it, and it names everything the typed data does.
 */
export function voteText(message: VoteMessage): string {
  return [
    "Gloam holder vote",
    `Vote: ${message.vote}`,
    `Option: ${message.option}`,
    `Choice: ${message.choice}`,
    `Voter: ${message.voter}`,
    `Snapshot block: ${message.snapshotBlock}`,
    `Timestamp: ${message.timestamp}`,
  ].join("\n");
}

/**
 * Every address the signature recovers to under the forms a wallet may have
 * signed: the typed data as given, the typed data with a chainId the wallet
 * added, and the plain-text form.
 */
async function recoverCandidates(message: VoteMessage, signature: Hex): Promise<Address[]> {
  const out: Address[] = [];
  const add = async (f: () => Promise<Address>) => {
    try {
      out.push(await f());
    } catch {
      /* not this form */
    }
  };
  await add(() => recoverTypedDataAddress({ ...voteTypedData(message), signature }));
  await add(() => recoverMessageAddress({ message: voteText(message), signature }));
  for (const chainId of WALLET_DOMAIN_CHAINS) {
    await add(() => recoverTypedDataAddress({ ...voteTypedData(message), domain: { ...VOTE_DOMAIN, chainId }, signature }));
  }
  return out;
}

/** The address an EOA signature recovers to, or null when it doesn't recover to the voter. */
export async function recoverVoter(message: VoteMessage, signature: Hex): Promise<Address | null> {
  const want = message.voter.toLowerCase();
  const all = await recoverCandidates(message, signature);
  return all.find((a) => a.toLowerCase() === want) ?? all[0] ?? null;
}

/** A contract check that got no answer, which says nothing about the signature. */
export class ContractCheckDown extends Error {
  constructor(voter: string) {
    super(`no answer checking the signature of ${voter}`);
    this.name = "ContractCheckDown";
  }
}

/**
 * Checks a signature for `message.voter`. An ordinary wallet (an EOA, EIP-7702
 * ones included) is checked here, offline. A smart wallet goes to `contractCheck`
 * (ERC-1271 or ERC-6492 through an RPC) when one is given. ContractCheckDown
 * comes through: the final count stops on it rather than drop the vote for good.
 */
export async function signatureValid(
  message: VoteMessage,
  signature: Hex,
  contractCheck?: (message: VoteMessage, signature: Hex) => Promise<boolean>,
): Promise<boolean> {
  const recovered = await recoverVoter(message, signature);
  if (recovered && recovered.toLowerCase() === message.voter.toLowerCase()) return true;
  if (!contractCheck) return false;
  try {
    return await contractCheck(message, signature);
  } catch (e) {
    if (e instanceof ContractCheckDown) throw e;
    return false;
  }
}

/** A wallet's weight in wei, and the reason when it is excluded (then the weight is 0). */
export function weightOf(
  snapshot: Pick<VoteSnapshot, "balances">,
  excluded: Map<string, Excluded>,
  address: string,
): { weight: bigint; held: bigint; excluded: Excluded | null } {
  const key = address.toLowerCase();
  const held = BigInt(snapshot.balances[key] ?? "0");
  const ex = excluded.get(key) ?? null;
  return { weight: ex ? 0n : held, held, excluded: ex };
}

/** All the GLOAM that can vote: every balance at the block, less the excluded ones. */
export function eligibleTotal(snapshot: Pick<VoteSnapshot, "balances">, excluded: Map<string, Excluded>): { weight: bigint; wallets: number } {
  let weight = 0n;
  let wallets = 0;
  for (const [addr, bal] of Object.entries(snapshot.balances)) {
    if (excluded.has(addr)) continue;
    const b = BigInt(bal);
    if (b <= 0n) continue;
    weight += b;
    wallets++;
  }
  return { weight, wallets };
}

export type Tally = {
  options: { option: number; label: string; weight: bigint; wallets: number }[];
  weight: bigint;
  wallets: number;
};

/** Totals per option. Expects one ballot per wallet (the store keeps only the latest). */
export function tally(v: VoteConfig, ballots: Pick<Ballot, "option" | "weight">[]): Tally {
  const options = v.options.map((label, option) => ({ option, label, weight: 0n, wallets: 0 }));
  let weight = 0n;
  let wallets = 0;
  for (const b of ballots) {
    const row = options[b.option];
    if (!row) continue;
    const w = BigInt(b.weight);
    // a wallet that holds nothing now (it sold or moved its GLOAM) carries no weight
    if (w === 0n) continue;
    row.weight += w;
    row.wallets++;
    weight += w;
    wallets++;
  }
  return { options, weight, wallets };
}

/**
 * A close-weighted vote's live count: each wallet's latest ballot weighted by
 * what it holds now (`now`, lowercase address to wei; a wallet whose balance
 * couldn't be read keeps the weight it signed with). Excluded wallets and
 * wallets holding nothing now count for nothing, but stay in the list.
 */
export function liveWeights(ballots: Ballot[], now: Map<string, bigint | null>, excluded: Map<string, Excluded>): Ballot[] {
  return latestPerVoter(ballots).map((b) => {
    const key = b.voter.toLowerCase();
    if (excluded.has(key)) return { ...b, weight: "0" };
    const held = now.get(key);
    return held === undefined || held === null ? b : { ...b, weight: held.toString() };
  });
}

/** Keeps each wallet's latest ballot (highest timestamp; a tie keeps the one taken first). */
export function latestPerVoter<T extends Pick<Ballot, "voter" | "timestamp" | "receivedAt">>(ballots: T[]): T[] {
  const by = new Map<string, T>();
  for (const b of ballots) {
    const k = b.voter.toLowerCase();
    const cur = by.get(k);
    if (!cur || b.timestamp > cur.timestamp || (b.timestamp === cur.timestamp && b.receivedAt < cur.receivedAt)) by.set(k, b);
  }
  return [...by.values()];
}

export type RecountProblem = { voter: string; problem: string };

/**
 * Recounts a published list of ballots from scratch: keeps each wallet's
 * latest, checks every signature, takes each weight from the balances again
 * (never from the list), and drops excluded wallets and any vote outside the
 * window. Anyone can run this against the downloaded votes.
 *
 * `snapshot` is the balances the weights come from: the snapshot for a
 * snapshot-weighted vote, or the balances at the closing block with
 * `{ closeBlock }` for a close-weighted one. Then the weight a ballot listed
 * when it was signed (that wallet's balance at the time) is not a problem.
 */
export async function recount(
  v: VoteConfig,
  snapshot: Pick<VoteSnapshot, "balances" | "block">,
  excluded: Map<string, Excluded>,
  ballots: Ballot[],
  contractCheck?: (message: VoteMessage, signature: Hex) => Promise<boolean>,
  opts: { closeBlock?: number } = {},
): Promise<{ tally: Tally; counted: Ballot[]; problems: RecountProblem[] }> {
  const problems: RecountProblem[] = [];
  const counted: Ballot[] = [];
  const atClose = opts.closeBlock !== undefined;
  if (atClose && snapshot.block !== opts.closeBlock) problems.push({ voter: "-", problem: `balances are for block ${snapshot.block}, the vote closed at block ${opts.closeBlock}` });
  if (!atClose && snapshot.block !== v.snapshotBlock) problems.push({ voter: "-", problem: `snapshot is block ${snapshot.block}, the vote says ${v.snapshotBlock}` });
  const startSec = Date.parse(v.start) / 1000;
  const endSec = Date.parse(v.end) / 1000;
  for (const b of latestPerVoter(ballots)) {
    if (!isAddress(b.voter, { strict: false })) {
      problems.push({ voter: String(b.voter), problem: "not an address" });
      continue;
    }
    if (!Number.isInteger(b.option) || b.option < 0 || b.option >= v.options.length) {
      problems.push({ voter: b.voter, problem: "no such option" });
      continue;
    }
    if (b.timestamp < startSec || b.timestamp >= endSec) {
      problems.push({ voter: b.voter, problem: "signed outside the voting window" });
      continue;
    }
    const message = voteMessage(v, b.option, b.voter, b.timestamp);
    if (!(await signatureValid(message, b.signature, contractCheck))) {
      problems.push({ voter: b.voter, problem: "signature does not match" });
      continue;
    }
    const { weight, excluded: ex } = weightOf(snapshot, excluded, b.voter);
    if (ex) {
      problems.push({ voter: b.voter, problem: `excluded: ${ex.reason}` });
      continue;
    }
    if (weight === 0n) {
      problems.push({ voter: b.voter, problem: atClose ? `held no GLOAM at the closing block ${snapshot.block}` : "held no GLOAM at the snapshot block" });
      continue;
    }
    if (!atClose && weight.toString() !== b.weight) problems.push({ voter: b.voter, problem: `listed weight ${b.weight}, snapshot says ${weight}` });
    counted.push({ ...b, weight: weight.toString(), choice: v.options[b.option]! });
  }
  return { tally: tally(v, counted), counted, problems };
}

/** One Transfer log, as eth_getLogs returns it. */
export type TransferLog = { blockNumber: string; topics: string[]; data: string };

export const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/**
 * Every holder's balance after `toBlock`, from the token's Transfer logs since
 * it was minted. The public RPC keeps state for only a few minutes of blocks,
 * so this is how a balance at an older block is worked out; the snapshot
 * script checks it against balanceOf at the block while that still answers.
 * The zero address goes negative by the minted supply and is left out.
 *
 * With `base` (every balance at an earlier, checked block, like a snapshot),
 * the replay starts from those balances and takes only the logs after it.
 */
export function replayTransfers(logs: TransferLog[], toBlock: number, base?: { block: number; balances: Record<string, string> }): Map<string, bigint> {
  const bal = new Map<string, bigint>();
  if (base) for (const [addr, b] of Object.entries(base.balances)) bal.set(addr.toLowerCase(), BigInt(b));
  for (const l of logs) {
    const n = parseInt(l.blockNumber, 16);
    if (n > toBlock || (base && n <= base.block)) continue;
    if (l.topics[0]?.toLowerCase() !== TRANSFER_TOPIC || l.topics.length < 3) continue;
    const from = `0x${l.topics[1]!.slice(26)}`.toLowerCase();
    const to = `0x${l.topics[2]!.slice(26)}`.toLowerCase();
    const value = BigInt(l.data === "0x" ? 0 : l.data);
    bal.set(from, (bal.get(from) ?? 0n) - value);
    bal.set(to, (bal.get(to) ?? 0n) + value);
  }
  for (const [addr, b] of bal) if (b <= 0n) bal.delete(addr);
  return bal;
}

/** A GLOAM amount from wei for display: two places, cut down, "<0.01" for dust (lib/amountShort displayAmount). */
export function formatGloam(wei: bigint | string): string {
  const w = typeof wei === "string" ? BigInt(wei) : wei;
  return displayAmount(w, GLOAM_DECIMALS);
}

/** A share in percent with one decimal, "0" when there is nothing to share. */
export function percentOf(part: bigint, whole: bigint): number {
  if (whole <= 0n) return 0;
  return Number((part * 1000n) / whole) / 10;
}

/** "3 Nov 2026, 13:00 UTC": the same on the server and in every browser. */
export function formatUtc(iso: string): string {
  const d = new Date(iso);
  const date = d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" });
  return `${date}, ${time} UTC`;
}

/** 0x1234…abcd */
export function shortAddress(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

function utcDay(d: Date): string {
  const weekday = d.toLocaleDateString("en-GB", { weekday: "long", timeZone: "UTC" });
  const date = d.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
  return `${weekday} ${date}`;
}

/** "11pm", "4:15pm", "noon", "midnight", in UTC. */
function clock(d: Date): string {
  const h = d.getUTCHours();
  const m = d.getUTCMinutes();
  if (m === 0 && h === 12) return "noon";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}${m ? `:${String(m).padStart(2, "0")}` : ""}${h < 12 ? "am" : "pm"}`;
}

/**
 * A time in plain words: "Sunday 1 Nov at 11pm UTC". The midnight that ends a
 * day reads as that day ("Sunday 1 Nov at midnight UTC"), the way people say it.
 */
export function whenPhrase(iso: string): string {
  const d = new Date(iso);
  if (d.getUTCHours() === 0 && d.getUTCMinutes() === 0) return `${utcDay(new Date(d.getTime() - 1))} at midnight UTC`;
  return `${utcDay(d)} at ${clock(d)} UTC`;
}

/** "2 days, 7 hours", "5 hours, 12 minutes", "12 minutes", "less than a minute". */
export function timeLeft(ms: number): string {
  if (ms < 60_000) return "less than a minute";
  const min = Math.floor(ms / 60_000);
  const days = Math.floor(min / 1440);
  const hours = Math.floor((min % 1440) / 60);
  const mins = min % 60;
  const n = (k: number, one: string) => `${k} ${one}${k === 1 ? "" : "s"}`;
  if (days > 0) return hours > 0 ? `${n(days, "day")}, ${n(hours, "hour")}` : n(days, "day");
  if (hours > 0) return mins > 0 ? `${n(hours, "hour")}, ${n(mins, "minute")}` : n(hours, "hour");
  return n(mins, "minute");
}

/** A small share in percent with two decimals: "0.28%", "<0.01%" for dust, "0%" for nothing. */
export function sharePercent(part: bigint, whole: bigint): string {
  if (whole <= 0n || part <= 0n) return "0%";
  const bp = (part * 10_000n) / whole;
  if (bp === 0n) return "<0.01%";
  return `${(Number(bp) / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}%`;
}
