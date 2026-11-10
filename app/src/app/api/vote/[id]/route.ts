import { NextResponse } from "next/server";
import { clientIp, hitRateLimit } from "@/lib/mcpRemote/rateLimit";
import { KvUnavailableError } from "@/lib/partnersKv";
import { acceptingVotes, excludedForVote, findVote, snapshotFor } from "@/lib/vote/registry";
import { weightingOf } from "@/lib/vote/core";
import { voteSummary } from "@/lib/vote/results";
import { BallotBusyError } from "@/lib/vote/store";
import { VoteError, smartWalletCheck, submitBallot } from "@/lib/vote/submit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// the first request after a close-weighted vote ends works out its final count
export const maxDuration = 60;

/** Reads per IP per minute: the page polls the totals every few seconds. */
const READS_PER_MINUTE = 120;
/** Votes per IP per minute and per hour. A wallet votes once or twice; carriers put many people behind one IP. */
const VOTES_PER_MINUTE = 20;
const VOTES_PER_HOUR = 300;
const MAX_BODY = 8_000;

function fail(status: number, code: string, message: string, headers?: HeadersInit) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status, headers: { "Cache-Control": "no-store", ...headers } });
}

function notFound() {
  return fail(404, "not_found", "There is no vote here.");
}

/**
 * A vote's live totals: the same for everyone, so the edge keeps them a few
 * seconds. A wallet's own weight and vote come from POST /api/vote/me, with the
 * wallet in the body: in a URL it would sit in access logs next to the IP.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (new URL(req.url).searchParams.has("address")) {
    return fail(400, "address_in_url", "Send the wallet in the body of a POST to /api/vote/me, not in the URL.");
  }
  const rate = await hitRateLimit(clientIp(req), "vote-read", READS_PER_MINUTE);
  if (!rate.allowed) return fail(429, "rate_limited", "Too many requests. Wait a minute.", { "Retry-After": String(rate.retryAfterSec) });

  const { id } = await ctx.params;
  const vote = findVote(id);
  if (!vote) return notFound();

  try {
    const summary = await voteSummary(vote, snapshotFor(vote), excludedForVote(vote), undefined, { finalize: true });
    return NextResponse.json(
      { ok: true, data: summary },
      // the totals change only when someone votes; a few seconds at the edge spares the store
      { headers: { "Cache-Control": "public, s-maxage=5, stale-while-revalidate=15" } },
    );
  } catch (e) {
    if (e instanceof KvUnavailableError) return fail(503, "storage", "Results are not available for a moment. Try again shortly.");
    return fail(500, "error", "Something went wrong reading the results.");
  }
}

/** Cast or change a vote: { voter, option, timestamp, signature }, signed with EIP-712. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const ip = clientIp(req);
  const minute = await hitRateLimit(ip, "vote", VOTES_PER_MINUTE);
  if (!minute.allowed) return fail(429, "rate_limited", "Too many tries. Wait a minute and sign again.", { "Retry-After": String(minute.retryAfterSec) });

  const { id } = await ctx.params;
  const vote = findVote(id);
  if (!vote) return notFound();
  const snapshot = snapshotFor(vote);
  const ready = snapshot !== null || weightingOf(vote) === "close";
  if (!ready || !acceptingVotes(vote, snapshot)) {
    return fail(409, "not_open", vote.published && ready && Date.now() >= Date.parse(vote.end) ? "This vote has closed." : "This vote isn't open.");
  }

  const raw = await req.text();
  if (raw.length > MAX_BODY) return fail(413, "too_large", "That vote is larger than expected. Sign again.");
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return fail(400, "bad_body", "Something went wrong sending your vote. Refresh and try again.");
  }

  const hour = await hitRateLimit(ip, "vote-hour", VOTES_PER_HOUR, Date.now(), 3600);
  if (!hour.allowed) return fail(429, "rate_limited", "Too many votes from this connection. Try again later.", { "Retry-After": String(hour.retryAfterSec) });

  try {
    const { ballot, changed } = await submitBallot(body, {
      vote,
      snapshot,
      excluded: excludedForVote(vote),
      contractCheck: smartWalletCheck,
    });
    return NextResponse.json({ ok: true, data: { ballot, changed } }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    if (e instanceof VoteError) return fail(e.status, e.code, e.message);
    if (e instanceof BallotBusyError) return fail(409, "busy", "Your last vote is still being saved. Try again in a few seconds.");
    if (e instanceof KvUnavailableError) return fail(503, "storage", "Votes can't be saved for a moment. Try again shortly.");
    return fail(500, "error", "We couldn't save that vote. Try again.");
  }
}
