/**
 * What the vote page and the public API show: the vote, live totals, one
 * wallet's standing, and the full list of signed votes for a recount. Server
 * only. Amounts are wei strings so nothing is rounded on the way out.
 *
 * A close-weighted vote's totals are live while it runs (each voter's $GLOAM
 * now, read at most once a minute), then final once the count at the closing
 * block is in (lib/vote/final).
 */
import "server-only";
import type { VoteConfig } from "./config";
import {
  GLOAM_TOKEN_ADDRESS,
  VOTE_CHAIN_ID,
  VOTE_DOMAIN,
  VOTE_TYPES,
  eligibleTotal,
  liveWeights,
  percentOf,
  tally,
  voteStatus,
  weightOf,
  weightingOf,
  type Ballot,
  type FinalWeights,
  type VoteSnapshot,
  type VoteStatus,
  type Weighting,
} from "./core";
import { balanceNow, balancesNow, eligibleNow } from "./chainReads";
import type { Excluded } from "./excluded";
import { ensureFinal, storedFinal } from "./final";
import { smartWalletFinalCheck } from "./submit";
import { acceptingVotes } from "./registry";
import { cachedBallots, getBallot } from "./store";

/**
 * Where the totals come from: "snapshot" (balances at the snapshot block),
 * "live" (each voter's $GLOAM now, while a close-weighted vote runs),
 * "counting" (closed, the final count not in yet: still live) or "final"
 * (balances at the closing block).
 */
export type TallyBasis = "snapshot" | "live" | "counting" | "final";

export type VoteSummary = {
  id: string;
  draft: boolean;
  question: string;
  description: string;
  options: string[];
  details: string[];
  status: VoteStatus;
  start: string;
  end: string;
  chainId: number;
  token: string;
  snapshotBlock: number;
  /** Whether the weights the vote needs to take votes are in: its snapshot, or always for a close-weighted vote. */
  snapshotReady: boolean;
  weighting: Weighting;
  basis: TallyBasis;
  /** What the team is doing with the result, once the final count is in. */
  outcome: string | null;
  /** The closing block, once the final count is in. */
  closeBlock: number | null;
  accepting: boolean;
  /** `wallets` is null when only the total is known (live: the supply less the excluded addresses). */
  eligible: { weight: string; wallets: number | null } | null;
  totals: {
    weight: string;
    wallets: number;
    options: { option: number; label: string; weight: string; wallets: number; percent: number }[];
  };
  excluded: { address: string; reason: string }[];
  updatedAt: number;
};

export type VoterStanding = {
  address: string;
  /** Wei. At the snapshot, now (a close-weighted vote that is open), or at the closing block once the final count is in. */
  held: string;
  weight: string;
  basis: "snapshot" | "now" | "close";
  excluded: string | null;
  ballot: Ballot | null;
};

function excludedList(excluded: Map<string, Excluded>) {
  return [...excluded.values()].map((e) => ({ address: e.address, reason: e.reason }));
}

/** Each ballot weighted by what its wallet holds now (the last signed weight when a read fails). */
export async function liveBallots(v: VoteConfig, ballots: Ballot[], excluded: Map<string, Excluded>, now: number = Date.now()): Promise<Ballot[]> {
  if (!ballots.length) return [];
  return liveWeights(ballots, await balancesNow(ballots.map((b) => b.voter), { now }), excluded);
}

/** Each stored ballot with its final weight ("0" for one that doesn't count). */
export function finalBallots(ballots: Ballot[], final: FinalWeights): Ballot[] {
  const counted = new Map(final.counted.map((b) => [b.voter.toLowerCase(), b]));
  return ballots.map((b) => {
    const c = counted.get(b.voter.toLowerCase());
    return c && c.signature === b.signature ? c : { ...b, weight: "0" };
  });
}

/**
 * A close-weighted vote's final count: the stored one, or, with `finalize`,
 * worked out now when it is due (the API routes pass it; the pages only read,
 * so a page load never waits on the chain).
 */
export async function finalFor(
  v: VoteConfig,
  snapshot: VoteSnapshot | null,
  excluded: Map<string, Excluded>,
  opts: { finalize?: boolean; now?: number } = {},
): Promise<FinalWeights | null> {
  if (weightingOf(v) !== "close" || voteStatus(v, opts.now) !== "closed") return null;
  return opts.finalize ? ensureFinal(v, excluded, snapshot, { now: opts.now, contractCheck: smartWalletFinalCheck }) : storedFinal(v.id);
}

export async function voteSummary(
  v: VoteConfig,
  snapshot: VoteSnapshot | null,
  excluded: Map<string, Excluded>,
  now: number = Date.now(),
  opts: { tolerateStore?: boolean; finalize?: boolean } = {},
): Promise<VoteSummary> {
  const weighting = weightingOf(v);
  const ready = weighting === "close" || snapshot !== null;
  // the page still renders the vote when the store is down (with empty totals the client fills in later); the API says 503
  const read = ready ? cachedBallots(v.id, now) : Promise.resolve([]);
  const ballots = opts.tolerateStore ? await read.catch(() => []) : await read;

  let basis: TallyBasis = "snapshot";
  let counted = ballots;
  let eligible: VoteSummary["eligible"] = null;
  let closeBlock: number | null = null;
  if (weighting === "close") {
    const final = await (opts.tolerateStore ? finalFor(v, snapshot, excluded, { ...opts, now }).catch(() => null) : finalFor(v, snapshot, excluded, { ...opts, now }));
    if (final) {
      basis = "final";
      counted = final.counted;
      eligible = final.eligible;
      closeBlock = final.closeBlock;
    } else {
      basis = voteStatus(v, now) === "closed" ? "counting" : "live";
      const [live, total] = await Promise.all([liveBallots(v, ballots, excluded, now), eligibleNow(excluded, now)]);
      counted = live;
      eligible = total === null ? null : { weight: total.toString(), wallets: null };
    }
  } else if (snapshot) {
    const e = eligibleTotal(snapshot, excluded);
    eligible = { weight: e.weight.toString(), wallets: e.wallets };
  }
  const t = tally(v, counted);
  return {
    id: v.id,
    draft: !v.published,
    question: v.question,
    description: v.description,
    options: v.options,
    details: v.details ?? v.options.map(() => ""),
    status: voteStatus(v, now),
    start: v.start,
    end: v.end,
    chainId: VOTE_CHAIN_ID,
    token: GLOAM_TOKEN_ADDRESS,
    snapshotBlock: v.snapshotBlock,
    snapshotReady: ready,
    weighting,
    basis,
    outcome: basis === "final" ? (v.outcome ?? null) : null,
    closeBlock,
    accepting: acceptingVotes(v, snapshot, now),
    eligible,
    totals: {
      weight: t.weight.toString(),
      wallets: t.wallets,
      options: t.options.map((o) => ({ ...o, weight: o.weight.toString(), percent: percentOf(o.weight, t.weight) })),
    },
    excluded: excludedList(excluded),
    updatedAt: now,
  };
}

/** Thrown when a wallet's $GLOAM now can't be read, so its standing can't be shown. */
export class BalanceUnavailableError extends Error {
  constructor() {
    super("balance unavailable");
    this.name = "BalanceUnavailableError";
  }
}

/**
 * One wallet in one vote: what it holds (at the snapshot, now, or at the
 * closing block), its weight, why it is excluded, and its vote so far.
 * Throws BalanceUnavailableError when a close-weighted vote needs a balance
 * now and the chain doesn't answer.
 */
export async function voterStanding(
  v: VoteConfig,
  snapshot: VoteSnapshot | null,
  excluded: Map<string, Excluded>,
  address: string,
  opts: { now?: number } = {},
): Promise<VoterStanding> {
  const ex = excluded.get(address.toLowerCase()) ?? null;
  const ballot = await getBallot(v.id, address);
  if (weightingOf(v) === "close") {
    const final = await finalFor(v, snapshot, excluded, { now: opts.now });
    const atClose = final?.balances[address.toLowerCase()];
    let held: bigint;
    if (atClose !== undefined) held = BigInt(atClose);
    else {
      const now = await balanceNow(address, { now: opts.now });
      if (now === null) throw new BalanceUnavailableError();
      held = now;
    }
    return {
      address,
      held: held.toString(),
      weight: ex ? "0" : held.toString(),
      basis: atClose !== undefined ? "close" : "now",
      excluded: ex?.reason ?? null,
      ballot,
    };
  }
  const w = snapshot ? weightOf(snapshot, excluded, address) : { weight: 0n, held: 0n };
  return { address, held: w.held.toString(), weight: w.weight.toString(), basis: "snapshot", excluded: ex?.reason ?? null, ballot };
}

/**
 * Everything a recount needs, as one JSON document. For a close-weighted
 * vote each ballot's weight is the live one while it runs, and the final one
 * (at `final.closeBlock`) once the count is in.
 */
export async function ballotsExport(v: VoteConfig, snapshot: VoteSnapshot | null, excluded: Map<string, Excluded>, opts: { finalize?: boolean; now?: number } = {}) {
  const close = weightingOf(v) === "close";
  const stored = snapshot || close ? await cachedBallots(v.id) : [];
  const final = close ? await finalFor(v, snapshot, excluded, opts) : null;
  const ballots = final ? finalBallots(stored, final) : close ? await liveBallots(v, stored, excluded, opts.now) : stored;
  return {
    vote: { id: v.id, question: v.question, options: v.options, start: v.start, end: v.end, snapshotBlock: v.snapshotBlock, weighting: weightingOf(v) },
    chainId: VOTE_CHAIN_ID,
    token: GLOAM_TOKEN_ADDRESS,
    snapshot: snapshot ? { block: snapshot.block, blockHash: snapshot.blockHash, blockTime: snapshot.blockTime } : null,
    final: final
      ? { closeBlock: final.closeBlock, closeBlockHash: final.closeBlockHash, closeBlockTime: final.closeBlockTime, eligible: final.eligible, problems: final.problems }
      : null,
    howToCheck: close
      ? "Each signature is EIP-712 over typedData with message { vote, option, choice, voter, snapshotBlock, timestamp }; snapshotBlock is signed but sets no weight here. A wallet's weight is its $GLOAM balanceOf on Robinhood Chain (4663) at the closing block: the first block whose timestamp is at or after the vote's end (final.closeBlock once counted). Until then the weights shown are each wallet's balance now. Excluded addresses weigh nothing. Each wallet's latest timestamp counts."
      : "Each signature is EIP-712 over typedData with message { vote, option, choice, voter, snapshotBlock, timestamp }. A wallet's weight is its $GLOAM balanceOf at snapshot.block on Robinhood Chain (4663), zero for the excluded addresses. Each wallet's latest timestamp counts.",
    typedData: { domain: VOTE_DOMAIN, types: VOTE_TYPES, primaryType: "Vote" },
    excluded: excludedList(excluded),
    ballots,
  };
}

/** The votes as a spreadsheet. Cells that start like a formula are quoted as text. */
export function ballotsCsv(ballots: Ballot[]): string {
  const cell = (s: string) => `"${(/^[=+\-@\t\r]/.test(s) ? `'${s}` : s).replace(/"/g, '""')}"`;
  const header = ["voter", "option", "choice", "weight_wei", "signed_at_utc", "timestamp", "signature"];
  const rows = ballots.map((b) =>
    [b.voter, String(b.option), b.choice, b.weight, new Date(b.timestamp * 1000).toISOString(), String(b.timestamp), b.signature].map(cell),
  );
  return [header.map(cell), ...rows].map((r) => r.join(",")).join("\r\n") + "\r\n";
}
