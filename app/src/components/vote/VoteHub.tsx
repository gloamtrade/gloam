"use client";

import dynamic from "next/dynamic";
import { useCallback, useRef, useState } from "react";
import { whenPhrase, type Ballot } from "@/lib/vote/core";
import type { VoteSummary } from "@/lib/vote/results";
import { FeedbackBox } from "./FeedbackBox";
import { OptionArt } from "./OptionArt";
import { ResultsButton, ResultsDrawer } from "./ResultsDrawer";
import m from "./vote.module.css";
import { BallotCard, CheckIcon, ClosingLine, HowItWorks, Progress, ResultsCard, ShareVoted, Welcome } from "./VoteParts";
import { useLiveVotes, useMe, useVoteWallet } from "./voteHooks";

const WalletConnectSheet = dynamic(() => import("@/components/app/WalletConnectSheet").then((m) => m.WalletConnectSheet), { ssr: false });

const isActive = (v: VoteSummary) => v.status === "open" || v.status === "upcoming" || v.draft;
const leader = (v: VoteSummary) => v.totals.options.reduce((a, b) => (BigInt(b.weight) > BigInt(a.weight) ? b : a), v.totals.options[0]!);

/**
 * /vote: every open question as one guided ballot, a question per screen,
 * then a thank-you summary, with the live results and the recount below.
 */
export function VoteHub({ initial }: { initial: VoteSummary[] }) {
  const wallet = useVoteWallet();
  const { me, failed, retry, recordBallot } = useMe(wallet.address);
  const { votes, updatedAt, refresh } = useLiveVotes(initial, "all");
  const active = votes.filter(isActive);
  const past = votes.filter((v) => !isActive(v));
  // closed with the final count in and a plan to show: what the page leads with until the next vote
  const decided = active.length === 0 ? votes.filter((v) => v.outcome) : [];

  const voted = useCallback((id: string) => Boolean(me?.votes[id]?.ballot), [me]);
  const firstOpen = active.findIndex((v) => !voted(v.id));
  const auto: number | "summary" = me && active.length > 0 && firstOpen === -1 ? "summary" : Math.max(0, firstOpen);
  const [chosen, setChosen] = useState<number | "summary" | null>(null);
  const [drawer, setDrawer] = useState(false);
  const step = chosen ?? auto;

  const headingRef = useRef<HTMLHeadingElement>(null);
  const summaryRef = useRef<HTMLHeadingElement>(null);
  const ballotTop = useRef<HTMLDivElement>(null);

  const go = (to: number | "summary") => {
    setChosen(to);
    // move focus with the step, so a screen reader reads the new question; keep its top in view
    window.requestAnimationFrame(() => {
      (to === "summary" ? summaryRef.current : headingRef.current)?.focus({ preventScroll: true });
      const top = ballotTop.current?.getBoundingClientRect().top ?? 0;
      if (top < 64) ballotTop.current?.scrollIntoView({ block: "start", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    });
  };

  // from the holder check: straight to the first question not answered yet, scrolled into view
  const start = () => {
    const to: number | "summary" = firstOpen === -1 ? "summary" : firstOpen;
    setChosen(to);
    window.requestAnimationFrame(() => {
      (to === "summary" ? summaryRef.current : headingRef.current)?.focus({ preventScroll: true });
      ballotTop.current?.scrollIntoView({ block: "start", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    });
  };

  const onSigned = (id: string) => (b: Ballot) => {
    // stay on this question for the thank-you; the next one is a tap away
    setChosen((c) => c ?? step);
    recordBallot(id, b);
    void refresh();
  };

  const shared = active.length > 0 && active.every((v) => v.end === active[0]!.end && v.start === active[0]!.start) ? active[0]! : null;
  const block = votes[0]?.snapshotBlock ?? 0;
  // close-weighted votes count what each wallet holds when voting closes
  const closesAt = votes[0]?.weighting === "close" ? (shared ?? active[0] ?? votes[0])!.end : undefined;
  const anyVoted = active.some((v) => voted(v.id));
  // the note is for holders who voted, while a vote they can vote in is open
  const canNote = anyVoted && active.some((v) => v.accepting && BigInt(me?.votes[v.id]?.weight ?? "0") > 0n);

  return (
    <>
      {/* the welcome: a soft green light behind the title */}
      <section className="mx-auto max-w-[760px] px-5 pt-3 sm:px-7 sm:pt-6">
        <div className="gl-panel relative overflow-hidden border border-line bg-panel px-5 pb-10 pt-12 sm:px-9 sm:pb-12 sm:pt-16">
          <div aria-hidden className={m.glow} />
          <div className="relative mx-auto max-w-[760px]">
            <p className="inline-flex items-center gap-2 text-[14px] text-soft">
              <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-sealed" />
              $GLOAM holder votes
            </p>
            <h1 className="mt-5 max-w-[15ch] text-[clamp(40px,7.4vw,76px)] font-light leading-[0.98] tracking-[-0.035em] text-foreground [text-wrap:balance]">
              Help decide what Gloam builds next
            </h1>
            <p className="mt-6 max-w-[52ch] text-[16.5px] leading-relaxed text-soft sm:text-[18px]">
              {decided.length > 0 ? (
                "The votes are closed. Here's what holders chose and what we're doing about it."
              ) : (
                <>
              {active.length > 1 ? `${["", "One", "Two", "Three", "Four", "Five"][active.length] ?? active.length} questions.` : "One question."} Each
              answer is a free signature,{" "}
              {closesAt ? "weighted by the $GLOAM in your wallet when voting closes." : `weighted by the $GLOAM you held at block ${block.toLocaleString("en-US")}.`}
                </>
              )}
            </p>
            {shared && <ClosingLine s={shared} className="mt-6" />}
          </div>
        </div>
      </section>

      {decided.length > 0 ? (
        <section className="mx-auto max-w-[760px] px-5 pt-12 sm:px-7" aria-labelledby="decided-title">
          <h2 id="decided-title" className="t-display-m">
            The votes are in
          </h2>
          <p className="mt-3 text-[15px] leading-relaxed text-soft">
            {Math.max(...decided.map((v) => v.totals.wallets)).toLocaleString("en-US")} wallets voted. The results are advisory, and this is what we&apos;re doing with them.
          </p>
          <ol className="mt-6 divide-y divide-line border-y border-line">
            {decided.map((v) => {
              const won = leader(v);
              return (
                <li key={v.id} className="py-5">
                  <p className="text-[13.5px] text-mute">{v.question}</p>
                  <p className="mt-2 flex items-center gap-2.5 text-[19px] leading-snug tracking-[-0.01em] text-foreground">
                    <OptionArt voteId={v.id} index={won.option} size={22} />
                    <span className="min-w-0">{won.label}</span>
                    <span className="tnum ml-auto shrink-0 text-[17px] text-soft">{won.percent}%</span>
                  </p>
                  <p className="mt-2 max-w-[60ch] text-[15px] leading-relaxed text-soft">{v.outcome}</p>
                </li>
              );
            })}
          </ol>
          <p className="mt-4 text-[14.5px] leading-relaxed text-mute">The next vote is announced on X @gloamtrade and in the Telegram group.</p>
        </section>
      ) : active.length === 0 ? (
        <section className="mx-auto max-w-[760px] px-5 pt-12 sm:px-7">
          <div className="border-y border-line py-8">
            <p className="text-[17px] text-foreground">No vote is open right now.</p>
            <p className="mt-2 text-[14.5px] leading-relaxed text-mute">The next one is announced on X @gloamtrade and in the Telegram group.</p>
          </div>
        </section>
      ) : (
        <section className="mx-auto max-w-[760px] px-5 pt-10 sm:px-7" aria-label="Your ballot">
          {wallet.address && (
            <div className="mb-4">
              <Welcome
                key={wallet.address}
                me={me}
                address={wallet.address}
                chainId={wallet.chainId}
                failed={failed}
                onRetry={retry}
                onDisconnect={wallet.disconnect}
                block={block}
                closesAt={closesAt}
                onResults={() => setDrawer(true)}
                onStart={chosen === null ? start : undefined}
                startLabel={firstOpen === -1 ? "See your answers" : anyVoted ? "Continue voting" : "Start voting"}
              />
            </div>
          )}

          <div ref={ballotTop} className="scroll-mt-20">
            {active.length > 1 && <Progress votes={active} current={step} voted={voted} onJump={go} />}

            <div key={String(step)} className="gl-settle mt-2">
              {step === "summary" ? (
                <>
                <section aria-labelledby="summary-title" className="gl-card p-5 sm:p-8">
                  <h2 id="summary-title" ref={summaryRef} tabIndex={-1} className="text-[24px] leading-[1.2] tracking-[-0.02em] text-foreground outline-none sm:text-[30px]">
                    {active.every((v) => voted(v.id)) ? "Thank you for voting" : "Your answers so far"}
                  </h2>
                  <p className="mt-3 max-w-[56ch] text-[15px] leading-relaxed text-soft">
                    {wallet.address
                      ? active.every((v) => voted(v.id))
                        ? `Your voice counts in ${active.length === 1 ? "this vote" : `all ${["", "", "two", "three", "four", "five"][active.length] ?? active.length}`}. You can change any answer until ${whenPhrase(active[0]!.end)}.`
                        : "Answer the rest whenever you like, until the votes close."
                      : "Connect your wallet to vote."}
                  </p>
                  <ol className="mt-6 divide-y divide-line border-y border-line">
                    {active.map((v, i) => {
                      const b = me?.votes[v.id]?.ballot ?? null;
                      return (
                        <li key={v.id} className="flex items-center justify-between gap-4 py-4">
                          <div className="min-w-0">
                            <p className="text-[13.5px] text-mute">{v.question}</p>
                            <p className={`mt-1 flex items-center gap-2 text-[16px] ${b ? "text-foreground" : "text-faint"}`}>
                              {b && (
                                <span className="text-sealed">
                                  <CheckIcon />
                                </span>
                              )}
                              {b ? b.choice : "Not answered yet"}
                            </p>
                          </div>
                          <button type="button" onClick={() => go(i)} className="btn btn-quiet btn-sm min-h-10 shrink-0">
                            {b ? "Change" : "Answer"}
                          </button>
                        </li>
                      );
                    })}
                  </ol>
                  <div className="mt-6 flex flex-col gap-2 sm:flex-row sm:items-center">
                    <button type="button" onClick={() => setDrawer(true)} className="btn btn-ink btn-lg w-full sm:w-auto">
                      See the live results
                    </button>
                    {anyVoted && <ShareVoted endPhrase={whenPhrase(active[0]!.end)} />}
                  </div>
                  {anyVoted && <p className="mt-3 text-[12.5px] text-mute">The post doesn&apos;t include your wallet address.</p>}
                </section>
                {canNote && wallet.address && (
                  <div className="mt-4">
                    <FeedbackBox address={wallet.address as `0x${string}`} />
                  </div>
                )}
                </>
              ) : (
                <BallotCard
                  key={active[step]!.id}
                  s={active[step]!}
                  standing={me?.votes[active[step]!.id] ?? null}
                  wallet={wallet}
                  meFailed={failed}
                  onSigned={onSigned(active[step]!.id)}
                  headingRef={headingRef}
                  step={{
                    auto: true,
                    index: step,
                    total: active.length,
                    back: step > 0 ? () => go(step - 1) : undefined,
                    next: () => go(step + 1 < active.length ? step + 1 : "summary"),
                    nextLabel: step + 1 < active.length ? "Next question" : "See your summary",
                  }}
                />
              )}
            </div>
          </div>
        </section>
      )}

      {/* live results: in a drawer, opened from the sticky button */}
      {votes.length > 0 && (
        <>
          {active.length > 0 && (
            <>
              <ResultsDrawer votes={active} mine={(id) => me?.votes[id]?.ballot ?? null} updatedAt={updatedAt} open={drawer} onClose={() => setDrawer(false)} />
              {!drawer && <ResultsButton onOpen={() => setDrawer(true)} wallets={Math.max(0, ...active.map((v) => v.totals.wallets))} />}
            </>
          )}
          {active.length === 0 && (
            <section className="mx-auto max-w-[760px] px-5 pt-16 sm:px-7" aria-labelledby="final-title">
              <h2 id="final-title" className="t-display-m">
                Final results
              </h2>
              <div className="mt-6 flex flex-col gap-4">
                {votes.map((v) => (
                  <ResultsCard key={v.id} s={v} />
                ))}
              </div>
            </section>
          )}
        </>
      )}

      <section className="mx-auto max-w-[760px] px-5 pt-16 sm:px-7 sm:pt-24">
        <HowItWorks block={block} firstId={votes[0]?.id} closesAt={closesAt} />
      </section>

      {active.length > 0 && past.length > 0 && (
        <section className="mx-auto max-w-[760px] px-5 pt-16 sm:px-7" aria-labelledby="past-title">
          <h2 id="past-title" className="t-display-m">
            Past votes
          </h2>
          <div className="mt-6 flex flex-col gap-4">
            {past.map((v) => (
              <ResultsCard key={v.id} s={v} />
            ))}
          </div>
        </section>
      )}

      <div className="pb-32 sm:pb-36" />
      {wallet.sheetOpen && <WalletConnectSheet open={wallet.sheetOpen} onClose={wallet.closeSheet} />}
    </>
  );
}
