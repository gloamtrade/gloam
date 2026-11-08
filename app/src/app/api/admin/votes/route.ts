import { NextResponse } from "next/server";
import { isAdminAuthenticated } from "@/lib/adminAuth";
import { kvBackend } from "@/lib/partnersKv";
import { FEEDBACK_MAX_KEPT, feedbackCsv, listFeedback } from "@/lib/vote/feedback";
import { holdersCsv, listHolders } from "@/lib/vote/holders";
import { VOTES } from "@/lib/vote/config";
import { configProblems, weightingOf } from "@/lib/vote/core";
import { excludedForVote, snapshotFor } from "@/lib/vote/registry";
import { ballotsCsv, finalBallots, finalFor, liveBallots, voteSummary } from "@/lib/vote/results";
import { listBallots } from "@/lib/vote/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const noStore = { "Cache-Control": "no-store" };

/**
 * Admin only: every vote (drafts too) with its tallies and every ballot, and
 * every feedback note, and every connected wallet (holders) with the votes it
 * has a ballot in. ?format=csv&kind=votes[&vote=<id>], kind=feedback or
 * kind=holders downloads a spreadsheet; ?download=1 the whole JSON.
 *
 * For a close-weighted vote each ballot also carries `live` (its wallet's
 * $GLOAM now) and, once the vote is counted, `final` (at the closing block).
 */
export async function GET(req: Request) {
  if (!(await isAdminAuthenticated())) {
    return NextResponse.json({ ok: false, error: { message: "Admin session required." } }, { status: 401, headers: noStore });
  }
  const backend = kvBackend();
  const url = new URL(req.url);
  try {
    const votes = VOTES.filter((v) => configProblems(v).length === 0);
    const rows = await Promise.all(
      votes.map(async (v) => {
        const snapshot = snapshotFor(v);
        const excluded = excludedForVote(v);
        const summary = await voteSummary(v, snapshot, excluded, undefined, { finalize: true });
        const ballots = backend === "none" ? [] : await listBallots(v.id);
        if (weightingOf(v) !== "close") return { summary, ballots };
        const [live, final] = await Promise.all([liveBallots(v, ballots, excluded), finalFor(v, snapshot, excluded)]);
        const liveBy = new Map(live.map((b) => [b.voter.toLowerCase(), b.weight]));
        const finalBy = final ? new Map(finalBallots(ballots, final).map((b) => [b.voter.toLowerCase(), b.weight])) : null;
        return {
          summary,
          ballots: ballots.map((b) => ({ ...b, live: liveBy.get(b.voter.toLowerCase()) ?? null, final: finalBy?.get(b.voter.toLowerCase()) ?? null })),
        };
      }),
    );
    const feedback = backend === "none" ? [] : await listFeedback();
    // which votes each wallet has a ballot in now (a wallet can vote after it was last seen)
    const votedBy = new Map<string, Set<string>>();
    for (const r of rows) for (const b of r.ballots) votedBy.set(b.voter.toLowerCase(), (votedBy.get(b.voter.toLowerCase()) ?? new Set()).add(r.summary.id));
    const holders = (backend === "none" ? [] : await listHolders()).map((h) => ({
      ...h,
      voted: [...new Set([...h.signed, ...(votedBy.get(h.address.toLowerCase()) ?? [])])].sort(),
    }));

    if (url.searchParams.get("format") === "csv") {
      const kind = url.searchParams.get("kind");
      const date = new Date().toISOString().slice(0, 10);
      if (kind === "holders") {
        return new Response(holdersCsv(holders), {
          headers: { ...noStore, "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="gloam-vote-holders-${date}.csv"` },
        });
      }
      if (kind === "feedback") {
        return new Response(feedbackCsv(feedback), {
          headers: { ...noStore, "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="gloam-feedback-${date}.csv"` },
        });
      }
      const only = url.searchParams.get("vote");
      const pick = rows.filter((r) => !only || r.summary.id === only);
      const csv = pick.length === 1 ? ballotsCsv(pick[0]!.ballots) : allVotesCsv(pick.map((r) => ({ id: r.summary.id, ballots: r.ballots })));
      // the file is named from a vote id the config holds, never from the query as typed
      const name = only && pick.length === 1 ? safeFileName(pick[0]!.summary.id) : "all";
      return new Response(csv, {
        headers: { ...noStore, "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="gloam-votes-${name}-${date}.csv"` },
      });
    }

    const data = { backend, kept: { ballots: "until deleted", feedback: `newest ${FEEDBACK_MAX_KEPT.toLocaleString("en-US")}` }, votes: rows, feedback, holders };
    return NextResponse.json(
      { ok: true, data },
      { headers: { ...noStore, ...(url.searchParams.get("download") === "1" ? { "Content-Disposition": `attachment; filename="gloam-votes-and-feedback.json"` } : {}) } },
    );
  } catch {
    return NextResponse.json({ ok: false, error: { message: "Could not read votes." } }, { status: 503, headers: noStore });
  }
}

/** Letters, digits, dot, dash and underscore only, so a name never ends the header's quoted value. */
function safeFileName(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 80) || "vote";
}

function allVotesCsv(sets: { id: string; ballots: { voter: string; option: number; choice: string; weight: string; timestamp: number; signature: string }[] }[]): string {
  const cell = (s: string) => `"${(/^[=+\-@\t\r]/.test(s) ? `'${s}` : s).replace(/"/g, '""')}"`;
  const header = ["vote", "voter", "option", "choice", "weight_wei", "signed_at_utc", "timestamp", "signature"];
  const lines = sets.flatMap((s) =>
    s.ballots.map((b) => [s.id, b.voter, String(b.option), b.choice, b.weight, new Date(b.timestamp * 1000).toISOString(), String(b.timestamp), b.signature].map(cell)),
  );
  return [header.map(cell), ...lines].map((r) => r.join(",")).join("\r\n") + "\r\n";
}
