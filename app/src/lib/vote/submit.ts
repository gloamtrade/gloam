/**
 * Taking a signed vote: check the input, the window, the signature and the
 * weight, then keep it if it is the wallet's latest. Server only. The API
 * route passes the vote, its snapshot and the clock in, so the self-test runs
 * the same code against a test vote.
 *
 * A snapshot-weighted vote takes the weight from the snapshot. A
 * close-weighted one reads the wallet's $GLOAM now: it can vote when it holds
 * some, and the ballot keeps that balance (the final weight is set at close).
 */
import "server-only";
import { createPublicClient, getAddress, isAddress, isHex, type Hex, type PublicClient } from "viem";
import { robinhood } from "../chain";
import { serverTransport } from "../serverRpc";
import type { VoteConfig } from "./config";
import {
  ContractCheckDown,
  MAX_SIGNATURE_HEX,
  SIGNED_MAX_AGE_SEC,
  SIGNED_MAX_AHEAD_SEC,
  formatGloam,
  inWindow,
  signatureValid,
  voteMessage,
  voteText,
  voteTypedData,
  weightOf,
  weightingOf,
  type Ballot,
  type VoteMessage,
  type VoteSnapshot,
} from "./core";
import { balanceNow } from "./chainReads";
import type { Excluded } from "./excluded";
import { saveBallot } from "./store";

export class VoteError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "VoteError";
  }
}

export type BallotInput = { voter: `0x${string}`; option: number; timestamp: number; signature: Hex };

/** The body of a vote, checked for shape only. */
export function parseBallotInput(raw: unknown, v: VoteConfig): BallotInput {
  const b = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const voter = typeof b.voter === "string" ? b.voter.trim() : "";
  if (!isAddress(voter, { strict: false })) throw new VoteError(400, "bad_voter", "That wallet address doesn't look right.");
  const option = b.option;
  if (typeof option !== "number" || !Number.isInteger(option) || option < 0 || option >= v.options.length) {
    throw new VoteError(400, "bad_option", "Pick one of the options.");
  }
  const timestamp = b.timestamp;
  if (typeof timestamp !== "number" || !Number.isSafeInteger(timestamp) || timestamp <= 0) {
    throw new VoteError(400, "bad_timestamp", "Something went wrong with that vote. Sign it again.");
  }
  const signature = typeof b.signature === "string" ? b.signature.trim() : "";
  if (!isHex(signature, { strict: true }) || signature.length < 132 || signature.length > MAX_SIGNATURE_HEX) {
    throw new VoteError(400, "bad_signature", "That signature doesn't look right. Sign again.");
  }
  return { voter: getAddress(voter), option, timestamp, signature: signature as Hex };
}

let rhClient: PublicClient | null = null;

/** ERC-1271 and ERC-6492 checks for smart wallets, over Robinhood Chain mainnet. */
async function verifySmartWallet(message: VoteMessage, signature: Hex): Promise<boolean> {
  rhClient ??= createPublicClient({
    chain: robinhood,
    ccipRead: false,
    transport: serverTransport({ chainId: robinhood.id, chain: robinhood, historyRpc: null }, { timeout: 8_000, retryCount: 1 }),
  }) as PublicClient;
  // a smart wallet may have signed the typed data or, on the fallback, the plain-text form
  if (await rhClient.verifyTypedData({ address: message.voter, ...voteTypedData(message), signature })) return true;
  return rhClient.verifyMessage({ address: message.voter, message: voteText(message), signature });
}

/** For a ballot coming in: no answer from the node reads as no, and the voter signs again. */
export function smartWalletCheck(message: VoteMessage, signature: Hex): Promise<boolean> {
  return verifySmartWallet(message, signature).catch(() => false);
}

/** For the final count, which is stored once: no answer stops the count, and it runs again later. */
export function smartWalletFinalCheck(message: VoteMessage, signature: Hex): Promise<boolean> {
  return verifySmartWallet(message, signature).catch(() => {
    throw new ContractCheckDown(message.voter);
  });
}

export type SubmitContext = {
  vote: VoteConfig;
  /** Needed for a snapshot-weighted vote; a close-weighted one reads balances now. */
  snapshot: VoteSnapshot | null;
  /** The wallet's $GLOAM now, or null when it can't be read. Defaults to a fresh chain read. */
  balanceNow?: (address: string) => Promise<bigint | null>;
  excluded: Map<string, Excluded>;
  /** ms */
  now?: number;
  contractCheck?: (message: VoteMessage, signature: Hex) => Promise<boolean>;
};

/** Checks and keeps one signed vote. Throws VoteError with a message the voter can act on. */
export async function submitBallot(raw: unknown, ctx: SubmitContext): Promise<{ ballot: Ballot; changed: boolean }> {
  const { vote: v, snapshot } = ctx;
  const now = ctx.now ?? Date.now();
  if (!inWindow(v, now)) {
    throw now < Date.parse(v.start)
      ? new VoteError(409, "not_open", "This vote hasn't opened yet.")
      : new VoteError(409, "closed", "This vote has closed.");
  }
  const input = parseBallotInput(raw, v);

  const nowSec = Math.floor(now / 1000);
  if (input.timestamp < nowSec - SIGNED_MAX_AGE_SEC || input.timestamp > nowSec + SIGNED_MAX_AHEAD_SEC) {
    throw new VoteError(400, "stale", "That signature is too old. Sign again.");
  }
  // A fast device clock can sign past the close. The count would throw that out, and with it the earlier vote this replaces.
  if (input.timestamp >= Date.parse(v.end) / 1000) {
    throw new VoteError(400, "stale", "Your device's clock is ahead of the vote's close. Set it right and sign again.");
  }
  // The same for a slow clock, or a signature made before the vote opened: the count only takes ones signed inside the window.
  if (input.timestamp < Date.parse(v.start) / 1000) {
    throw new VoteError(400, "stale", "That signature is from before this vote opened. Sign again now.");
  }

  const message = voteMessage(v, input.option, input.voter, input.timestamp);
  if (!(await signatureValid(message, input.signature, ctx.contractCheck))) {
    throw new VoteError(401, "bad_signature", "That signature doesn't match this wallet. Sign again.");
  }

  let weight: bigint;
  if (weightingOf(v) === "close") {
    const ex = ctx.excluded.get(input.voter.toLowerCase());
    if (ex) throw new VoteError(403, "excluded", `This address doesn't vote. ${ex.reason}.`);
    const held = await (ctx.balanceNow ?? ((a: string) => balanceNow(a, { fresh: true })))(input.voter);
    if (held === null) throw new VoteError(503, "balance_unavailable", "We couldn't read this wallet's $GLOAM just now. Try again in a moment.");
    if (held === 0n) throw new VoteError(403, "no_balance", "You need $GLOAM in this wallet to vote.");
    weight = held;
    // the read takes a moment: a vote that started in the last second must not land after the close
    if (!inWindow(v, ctx.now ?? Date.now())) throw new VoteError(409, "closed", "This vote has closed.");
  } else {
    if (!snapshot) throw new VoteError(409, "not_open", "This vote isn't open.");
    const w = weightOf(snapshot, ctx.excluded, input.voter);
    if (w.excluded) throw new VoteError(403, "excluded", `This address doesn't vote. ${w.excluded.reason}.`);
    if (w.weight === 0n) {
      throw new VoteError(
        403,
        "no_balance",
        `This wallet held no $GLOAM at block ${snapshot.block.toLocaleString("en-US")}, so it has no vote here.`,
      );
    }
    weight = w.weight;
  }

  const ballot: Ballot = {
    voter: input.voter,
    option: input.option,
    choice: v.options[input.option]!,
    weight: weight.toString(),
    timestamp: input.timestamp,
    signature: input.signature,
    receivedAt: now,
  };
  const res = await saveBallot(v.id, ballot);
  // the same signature sent twice (a double tap, a retry): already in
  if (!res.saved && res.current.signature.toLowerCase() === input.signature.toLowerCase()) return { ballot: res.current, changed: false };
  if (!res.saved) {
    throw new VoteError(409, "newer", `A newer vote from this wallet is already in (${res.current.choice}, ${formatGloam(res.current.weight)} GLOAM).`);
  }
  return { ballot, changed: res.previous !== null };
}
