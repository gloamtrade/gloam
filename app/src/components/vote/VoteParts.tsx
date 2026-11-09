"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useSignMessage, useSignTypedData } from "wagmi";
import { robinhood } from "@/lib/chain";
import {
  VOTE_CHAIN_ID,
  formatGloam,
  percentOf,
  sharePercent,
  shortAddress,
  timeLeft,
  voteMessage,
  voteText,
  voteTypedData,
  whenPhrase,
  type Ballot,
} from "@/lib/vote/core";
import type { VoteConfig } from "@/lib/vote/config";
import type { VoteSummary } from "@/lib/vote/results";
import { TokenLogo } from "@/components/app/TokenLogo";
import { useNow, useSeen, type Me, type Standing } from "./voteHooks";
import { OptionArt } from "./OptionArt";
import { Spinner } from "@/components/ui/Spinner";
import m from "./vote.module.css";

const AUTO_ADVANCE_MS = 1_900;
const SPARKS = [0, 45, 90, 135, 180, 225, 270, 315];

/** The thank-you mark: a green disc that bounces in, a check that draws itself, and a small burst of light. */
function SealMark() {
  return (
    <span className="relative mt-0.5 grid h-10 w-10 shrink-0 place-items-center">
      <span aria-hidden className={m.burst} />
      {SPARKS.map((a) => (
        <span key={a} aria-hidden className={m.spark} style={{ ["--a" as string]: `${a}deg` }} />
      ))}
      <span className={`${m.seal} grid h-10 w-10 place-items-center rounded-full bg-sealed text-panel`}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden className={m.draw}>
          <path d="M5 12.5l4.2 4.2L19 7" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
    </span>
  );
}

export const explorer = (a: string) => `${robinhood.blockExplorers.default.url}/address/${a}`;
const blockText = (n: number) => n.toLocaleString("en-US");

/** The vote as the config has it, rebuilt from the summary for signing. */
function asConfig(s: VoteSummary): VoteConfig {
  return { id: s.id, published: !s.draft, question: s.question, description: s.description, options: s.options, snapshotBlock: s.snapshotBlock, start: s.start, end: s.end };
}

export function CheckIcon({ size = 14, stroke = 2 }: { size?: number; stroke?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M5 12.5l4.2 4.2L19 7" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/* ------------------------------------------------------------------ time */

/** "Closes Sunday 1 Nov at midnight UTC", and once mounted, how long is left. */
export function ClosingLine({ s, className = "" }: { s: Pick<VoteSummary, "status" | "start" | "end" | "draft">; className?: string }) {
  const now = useNow(30_000);
  const upcoming = s.status === "upcoming" || (s.draft && now !== null && now < Date.parse(s.start));
  const closed = s.status === "closed";
  const target = Date.parse(upcoming ? s.start : s.end);
  const words = closed ? `Closed ${whenPhrase(s.end)}` : upcoming ? `Opens ${whenPhrase(s.start)}` : `Closes ${whenPhrase(s.end)}`;
  return (
    <p className={`flex flex-wrap items-center gap-2 text-[14px] ${className}`}>
      <span className={s.draft ? "text-warn" : "text-foreground"}>{s.draft ? `Draft. ${words}` : words}</span>
      {!closed && now !== null && target > now && (
        <span className="tnum inline-flex items-center gap-2 rounded-full border border-sealed/35 bg-sealed-soft px-3 py-1 text-[13px] text-foreground">
          <span aria-hidden className={`h-1.5 w-1.5 rounded-full bg-sealed ${m.live}`} />
          {timeLeft(target - now)} {upcoming ? "to go" : "left"}
        </span>
      )}
    </p>
  );
}

/* ------------------------------------------------------------------ welcome */

/** How long the check shows at least, so the answer reads as a result rather than a flicker. */
const CHECK_MIN_MS = 900;

/** The $GLOAM mark with a small green check that pops in on it. */
function HolderMark() {
  return (
    <span className="relative grid h-12 w-12 shrink-0 place-items-center">
      <span aria-hidden className={m.burst} />
      <TokenLogo id="gloam" symbol="GLOAM" size={48} />
      <span className={`${m.seal} absolute -bottom-1 -right-1 grid h-[22px] w-[22px] place-items-center rounded-full bg-sealed text-panel ring-2 ring-panel`}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden className={m.draw}>
          <path d="M5 12.5l4.2 4.2L19 7" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
    </span>
  );
}

/**
 * A connected wallet, greeted by name, then a short check of its $GLOAM. In a
 * snapshot-weighted vote: what it held at the snapshot, its share of the
 * vote, and what it holds now when that differs. In a close-weighted vote:
 * what it holds now, which is what counts if it is still there at the close.
 * Key it by address, so a new wallet gets a fresh check.
 */
export function Welcome({
  me,
  address,
  chainId,
  failed,
  onRetry,
  onDisconnect,
  focus,
  block,
  onStart,
  startLabel = "Start voting",
  onResults,
  closesAt,
}: {
  me: Me | null;
  address: string;
  chainId: number | undefined;
  failed: boolean;
  onRetry: () => void;
  onDisconnect: () => void;
  /** The vote whose numbers to show; the first with a snapshot when not given. */
  focus?: string;
  /** The snapshot block, for the notes about it. */
  block?: number;
  /** Takes a holder who can vote to the ballot. */
  onStart?: () => void;
  startLabel?: string;
  /** Opens the live results. */
  onResults?: () => void;
  /** When voting closes (ISO), for a close-weighted vote. */
  closesAt?: string;
}) {
  const standing = me ? (focus ? me.votes[focus] : Object.values(me.votes).find((x) => x !== null)) ?? null : null;
  const who = me?.name ?? shortAddress(address);
  const current = useSeen(address);
  const [minDone, setMinDone] = useState(false);
  useEffect(() => {
    const t = window.setTimeout(() => setMinDone(true), CHECK_MIN_MS);
    return () => window.clearTimeout(t);
  }, []);
  const checking = !failed && (!standing || !minDone);
  const held = standing ? BigInt(standing.held) : 0n;
  const atBlock = block ? ` at block ${blockText(block)}` : "";
  const now = current !== undefined && current !== null ? current : null;
  const basis = standing?.basis ?? "snapshot";
  const closeWords = closesAt ? whenPhrase(closesAt) : "the end";

  return (
    <section aria-label="Your wallet" className="gl-card p-5 sm:p-7">
      <div className="flex items-start justify-between gap-4">
        <p className="min-w-0 text-[19px] leading-snug tracking-[-0.01em] text-foreground sm:text-[21px]">
          Welcome, <span className="[overflow-wrap:anywhere]">{who}</span>
        </p>
        <button type="button" onClick={onDisconnect} className="-mr-2 -mt-1 inline-flex min-h-10 shrink-0 items-center rounded-full px-3 text-[13px] text-mute transition-colors hover:bg-surface hover:text-foreground">
          Disconnect
        </button>
      </div>
      <div aria-live="polite">
        {failed ? (
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2" role="alert">
            <p className="text-[14.5px] text-soft">We couldn&apos;t load your voting weight.</p>
            <button type="button" onClick={onRetry} className="btn btn-quiet btn-sm">
              Try again
            </button>
          </div>
        ) : checking || !standing ? (
          <div className="mt-5 flex items-center gap-3.5" role="status">
            <span className="relative grid h-12 w-12 shrink-0 place-items-center">
              <span aria-hidden className={`absolute inset-0 rounded-full border-2 border-sealed/20 border-t-sealed ${m.spin}`} />
              <span className="opacity-60">
                <TokenLogo id="gloam" symbol="GLOAM" size={34} />
              </span>
            </span>
            <p className="text-[16px] text-soft">Checking your $GLOAM…</p>
          </div>
        ) : standing.excluded ? (
          <p className={`${m.rise} mt-3 max-w-[56ch] text-[14.5px] leading-relaxed text-soft`}>
            This address belongs to the Gloam team or one of its contracts, so it sits these votes out. {standing.excluded}.
          </p>
        ) : BigInt(standing.weight) === 0n && basis !== "snapshot" ? (
          <div className={`${m.rise} mt-4 max-w-[58ch] space-y-2.5 text-[14.5px] leading-relaxed text-soft`}>
            <p className="text-[16.5px] leading-snug text-foreground">
              {basis === "close" ? "This wallet held no $GLOAM when voting closed." : "You need $GLOAM in this wallet to vote"}
            </p>
            {basis === "now" && (
              <p>
                If you hold GLOAM in another wallet, switch to it in your wallet app. GLOAM kept privately inside Gloam can vote once private voting
                arrives, which is next on the roadmap. The live results are open to everyone.
              </p>
            )}
            {onResults && (
              <button type="button" onClick={onResults} className="btn btn-quiet btn-sm mt-1 min-h-10">
                See the live results
              </button>
            )}
          </div>
        ) : BigInt(standing.weight) === 0n ? (
          <div className={`${m.rise} mt-4 max-w-[58ch] space-y-2.5 text-[14.5px] leading-relaxed text-soft`}>
            <p className="text-[16.5px] leading-snug text-foreground">This wallet held no $GLOAM at the snapshot, so it can&apos;t vote this time.</p>
            {now !== null && now > 0n ? (
              <p className="tnum">
                It holds {formatGloam(now)} GLOAM now. Votes count the balance{atBlock}, taken before voting opened, so GLOAM bought or
                moved in since then doesn&apos;t count in these votes.
              </p>
            ) : (
              <p>Votes count the $GLOAM each wallet held{atBlock}, taken before voting opened.</p>
            )}
            <p>
              If you hold GLOAM in another wallet, switch to it in your wallet app. GLOAM kept privately inside Gloam can vote once private voting
              arrives, which is next on the roadmap. The live results are open to everyone.
            </p>
            {onResults && (
              <button type="button" onClick={onResults} className="btn btn-quiet btn-sm mt-1 min-h-10">
                See the live results
              </button>
            )}
          </div>
        ) : (
          <div className={`${m.rise} mt-5`}>
            <div className="flex items-center gap-4">
              <HolderMark />
              <div className="min-w-0">
                <p className="text-[13px] font-medium text-sealed">{basis === "close" ? "Your final weight" : "You can vote"}</p>
                <p className="tnum mt-0.5 text-[24px] leading-tight tracking-[-0.02em] text-foreground sm:text-[28px]">
                  {basis === "close" ? `You held ${formatGloam(held)} GLOAM` : `You hold ${formatGloam(held)} GLOAM`}
                </p>
              </div>
            </div>
            {basis !== "snapshot" ? (
              <p className="mt-4 text-[15px] leading-relaxed text-soft">
                {basis === "close" ? "That was in this wallet when voting closed, and it is what your vote counted." : `Your vote counts what you hold when voting closes, ${closeWords}.`}
              </p>
            ) : (
            <div className="mt-4 space-y-1.5 text-[15px] leading-relaxed">
              <p className="tnum text-soft">
                That&apos;s <span className="text-foreground">{sharePercent(BigInt(standing.weight), BigInt(standing.eligibleWeight))}</span> of the vote. You&apos;re
                one of {standing.eligibleWallets.toLocaleString("en-US")} holders shaping what Gloam builds next.
              </p>
              {now !== null && now !== held && (
                <p className="tnum text-[13.5px] text-mute">
                  {formatGloam(now)} GLOAM in this wallet now. Voting uses the balance{atBlock || " at the snapshot"}.
                </p>
              )}
            </div>
            )}
            {onStart && (
              <button type="button" onClick={onStart} className="btn btn-ink btn-lg mt-5 w-full sm:w-auto">
                {startLabel} <span aria-hidden>→</span>
              </button>
            )}
          </div>
        )}
      </div>
      {chainId !== undefined && chainId !== VOTE_CHAIN_ID && (
        <p className="mt-4 border-t border-line pt-4 text-[13.5px] leading-relaxed text-mute">
          Your wallet is on another network. That&apos;s fine: a vote is a signature, so it works from any network and nothing is sent on chain.
        </p>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ ballot */

type Phase =
  | { k: "choose" }
  | { k: "signing" }
  | { k: "saving" }
  | { k: "done"; changed: boolean }
  | { k: "rejected" }
  | { k: "failed"; message: string; retry: boolean };

type Wallet = {
  address: string | undefined;
  mounted: boolean;
  reconnecting: boolean;
  connecting: boolean;
  connectFailed: boolean;
  canConnect: boolean;
  walletConnectOn: boolean;
  open: () => void;
};

/**
 * One question: the options as cards (real radio buttons, so arrows, Tab and
 * screen readers work as they should), and one action that follows the
 * wallet's state: connect, sign, the thank-you, or why this wallet can't vote.
 */
export function BallotCard({
  s,
  standing,
  wallet,
  meFailed,
  onSigned,
  step,
  headingRef,
  headingLevel = "h2",
}: {
  s: VoteSummary;
  standing: Standing | null;
  wallet: Wallet;
  meFailed: boolean;
  onSigned: (b: Ballot) => void;
  step?: { index: number; total: number; next?: () => void; nextLabel?: string; back?: () => void; auto?: boolean };
  headingRef?: React.Ref<HTMLHeadingElement>;
  headingLevel?: "h1" | "h2";
}) {
  const Heading = headingLevel;
  const mine = standing?.ballot ?? null;
  const [picked, setPicked] = useState<number | null>(mine?.option ?? null);
  const [phase, setPhase] = useState<Phase>({ k: "choose" });
  const lastSent = useRef<{ voter: string; option: number; timestamp: number; signature: string } | null>(null);
  const { signTypedDataAsync } = useSignTypedData();
  const { signMessageAsync } = useSignMessage();
  const doneRef = useRef<HTMLDivElement>(null);

  // the wallet's earlier vote arrives after the page: show it picked
  const mineOption = mine?.option;
  const [seenMine, setSeenMine] = useState<number | undefined>(undefined);
  if (mineOption !== undefined && mineOption !== seenMine) {
    setSeenMine(mineOption);
    if (picked === null) setPicked(mineOption);
  }

  // after a vote, a short beat for the thank-you, then on to the next question (unless they chose to stay)
  const [held, setHeld] = useState(false);
  const advance = step?.auto && !held ? step.next : undefined;
  useEffect(() => {
    if (phase.k !== "done") return;
    doneRef.current?.focus({ preventScroll: true });
    doneRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    if (!advance) return;
    const t = window.setTimeout(advance, AUTO_ADVANCE_MS);
    return () => window.clearTimeout(t);
  }, [phase.k, advance]);

  const accepting = s.accepting;
  const canVote = accepting && !!wallet.address && !!standing && !standing.excluded && BigInt(standing.weight) > 0n;
  const busy = phase.k === "signing" || phase.k === "saving";
  const locked = !accepting || busy || phase.k === "done";

  /** Sends a signed vote. With `quiet`, a refused signature returns its code instead of showing the failure. */
  async function send(body: { voter: string; option: number; timestamp: number; signature: string }, quiet = false): Promise<string | null> {
    setPhase({ k: "saving" });
    try {
      const res = await fetch(`/api/vote/${s.id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const j = (await res.json().catch(() => null)) as
        | { ok: true; data: { ballot: Ballot; changed: boolean } }
        | { ok: false; error: { code: string; message: string } }
        | null;
      if (j?.ok) {
        lastSent.current = null;
        onSigned(j.data.ballot);
        setPhase({ k: "done", changed: j.data.changed });
        return null;
      }
      const code = j && !j.ok ? j.error.code : "";
      if (quiet && code === "bad_signature") return code;
      // a store or network hiccup: the same signature can go again; anything else needs a fresh one
      // a balance that couldn't be read can go again with the same signature too
      const retry = !j || ["storage", "error", "busy", "rate_limited", "balance_unavailable"].includes(code);
      setPhase({ k: "failed", message: j && !j.ok ? j.error.message : "We couldn't reach Gloam. Check your connection.", retry });
      return code || "error";
    } catch {
      setPhase({ k: "failed", message: "We couldn't reach Gloam. Check your connection.", retry: true });
      return "network";
    }
  }

  async function sign() {
    if (!wallet.address || picked === null || busy) return;
    setPhase({ k: "signing" });
    const rejected = (e: unknown) => {
      const name = e instanceof Error ? e.name : "";
      const msg = e instanceof Error ? e.message : "";
      return name === "UserRejectedRequestError" || /reject|denied|cancel/i.test(msg);
    };
    try {
      const account = wallet.address as `0x${string}`;
      const timestamp = Math.floor(Date.now() / 1000);
      const message = voteMessage(asConfig(s), picked, account, timestamp);
      // Typed data first. Some wallets (OKX among them) can't sign it, or sign a
      // changed form the server can't match: then the same vote goes as plain text.
      const plain = async () => {
        setPhase({ k: "signing" });
        return signMessageAsync({ message: voteText(message), account });
      };
      let signature: string;
      let usedPlain = false;
      try {
        signature = await signTypedDataAsync({ ...voteTypedData(message), account });
      } catch (e) {
        if (rejected(e)) throw e;
        signature = await plain();
        usedPlain = true;
      }
      const body = { voter: wallet.address, option: picked, timestamp, signature };
      lastSent.current = body;
      const code = await send(body, !usedPlain);
      if (code === "bad_signature" && !usedPlain) {
        const second = { ...body, signature: await plain() };
        lastSent.current = second;
        await send(second);
      }
    } catch (e) {
      const name = e instanceof Error ? e.name : "";
      const msg = e instanceof Error ? e.message : "";
      if (name === "UserRejectedRequestError" || /reject|denied|cancel/i.test(msg)) setPhase({ k: "rejected" });
      else setPhase({ k: "failed", message: "Your wallet couldn't sign that.", retry: false });
    }
  }

  const choice = picked !== null ? s.options[picked] : null;

  return (
    <section aria-labelledby={`q-${s.id}`} className="gl-card overflow-hidden">
      <div className="px-5 pt-6 sm:px-8 sm:pt-8">
        {step && step.total > 1 && <p className="tnum text-[13.5px] text-mute">Question {step.index + 1} of {step.total}</p>}
        <Heading id={`q-${s.id}`} ref={headingRef} tabIndex={-1} className="mt-2 text-[24px] leading-[1.2] tracking-[-0.02em] text-foreground outline-none [text-wrap:balance] sm:text-[30px]">
          {s.question}
        </Heading>
        {s.description && <p className="mt-3 max-w-[58ch] text-[15px] leading-relaxed text-soft">{s.description}</p>}
      </div>

      <fieldset className="mt-6 px-3 sm:px-5" disabled={locked && phase.k !== "done"}>
        <legend className="sr-only">Pick one answer</legend>
        <div className="flex flex-col gap-2">
          {s.options.map((label, i) => {
            const on = picked === i;
            const isMine = mine?.option === i;
            return (
              <label
                key={label}
                className={`group relative flex min-h-[72px] items-center gap-4 rounded-[16px] border px-4 py-4 transition-[transform,box-shadow,border-color,background-color] duration-200 motion-reduce:transition-none sm:px-5 has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-sealed ${
                  on
                    ? "-translate-y-0.5 border-sealed bg-sealed-soft shadow-[0_0_0_4px_color-mix(in_srgb,var(--sealed)_16%,transparent),0_14px_34px_-16px_color-mix(in_srgb,var(--sealed)_60%,transparent)]"
                    : "border-line bg-panel"
                } ${locked ? "cursor-default" : "cursor-pointer hover:-translate-y-0.5 hover:border-sealed/50 hover:shadow-card"}`}
              >
                <input
                  type="radio"
                  name={`vote-${s.id}`}
                  value={i}
                  checked={on}
                  disabled={locked}
                  onChange={() => {
                    setPicked(i);
                    if (phase.k !== "choose") setPhase({ k: "choose" });
                  }}
                  className="sr-only"
                />
                <OptionArt voteId={s.id} index={i} />
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <span className="text-[16.5px] leading-snug text-foreground">{label}</span>
                    {isMine && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-sealed px-2 py-0.5 text-[11.5px] font-medium text-panel">
                        <CheckIcon size={11} stroke={2.4} /> Your vote
                      </span>
                    )}
                  </span>
                  {s.details[i] && <span className="mt-1 block text-[14px] leading-relaxed text-mute">{s.details[i]}</span>}
                </span>
                <span
                  aria-hidden
                  className={`grid h-6 w-6 shrink-0 place-items-center rounded-full border-2 transition-colors ${
                    on ? `${m.pulse} border-sealed bg-sealed` : "border-line-strong group-hover:border-sealed/60"
                  }`}
                >
                  <span className={`h-2 w-2 rounded-full bg-panel transition-transform duration-200 motion-reduce:transition-none ${on ? "scale-100" : "scale-0"}`} />
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>

      <div className="mt-6 border-t border-line px-5 py-6 sm:px-8" aria-live="polite">
        {s.status === "closed" ? (
          <p className="text-[15px] leading-relaxed text-soft">
            {s.basis === "counting"
              ? "This vote has closed. The final count, by what each wallet held when voting closed, is on its way."
              : "This vote has closed and the results are final."}
            {mine ? ` You voted ${mine.choice}. Thank you.` : ""}
          </p>
        ) : !s.snapshotReady ? (
          <p className="text-[15px] leading-relaxed text-soft">The balance snapshot for this vote isn&apos;t in yet, so it can&apos;t take votes.</p>
        ) : !accepting ? (
          <p className="text-[15px] leading-relaxed text-soft">Voting opens {whenPhrase(s.start)}. Read the options now and come back then.</p>
        ) : !wallet.mounted || (wallet.reconnecting && !wallet.address) ? (
          <div className="gl-skeleton h-12 w-full rounded-full sm:w-56" aria-hidden />
        ) : !wallet.address ? (
          <div>
            {wallet.canConnect ? (
              <button type="button" onClick={wallet.open} disabled={wallet.connecting} aria-busy={wallet.connecting} className="btn btn-ink btn-lg w-full sm:w-auto">
                {wallet.connecting && <Spinner />}
                {wallet.connecting ? "Check your wallet…" : "Connect wallet to vote"}
              </button>
            ) : (
              <p className="text-[15px] leading-relaxed text-soft">
                No wallet found in this browser. Open gloam.trade/vote in your wallet app&apos;s browser
                {wallet.walletConnectOn ? "" : ", or on a computer with a wallet extension"} to vote.
              </p>
            )}
            <p className="mt-3 text-[13.5px] leading-relaxed text-mute">Voting is free. You sign a message; nothing is sent and no gas is paid.</p>
            {wallet.connectFailed && <p className="mt-2 text-[13.5px] text-danger">Your wallet didn&apos;t connect. Try again.</p>}
          </div>
        ) : meFailed ? (
          <p className="text-[15px] leading-relaxed text-soft">Your voting weight didn&apos;t load. Use Try again above.</p>
        ) : !standing ? (
          <div className="gl-skeleton h-12 w-full rounded-full sm:w-56" aria-hidden />
        ) : standing.excluded ? (
          <p className="text-[15px] leading-relaxed text-soft">Team and contract addresses don&apos;t vote. You can still follow the results below.</p>
        ) : !canVote ? (
          <p className="text-[15px] leading-relaxed text-soft">
            {s.weighting === "close"
              ? "You need $GLOAM in this wallet to vote. The results below are open to everyone."
              : "This wallet has no vote here, but the results below are open to everyone."}
          </p>
        ) : phase.k === "done" ? (
          <div ref={doneRef} tabIndex={-1} className="gl-settle outline-none">
            <div className="flex items-start gap-3">
              <SealMark />
              <div className="min-w-0">
                <p className="text-[19px] leading-snug tracking-[-0.01em] text-foreground">
                  {phase.changed ? "Your vote is changed. Thank you." : "Your vote is in. Thank you."}
                </p>
                <p className="mt-1 text-[14.5px] leading-relaxed text-soft">
                  You chose {choice}. You can change it until {whenPhrase(s.end)}.
                </p>
              </div>
            </div>
            {step?.next && step.auto && !held && (
              <div className="mt-5">
                <p className="text-[13px] text-mute">Next question in a moment</p>
                <div className="mt-2 h-1 overflow-hidden rounded-full bg-surface-2">
                  <div className={`h-full rounded-full bg-sealed ${m.beat}`} style={{ ["--beat" as string]: `${AUTO_ADVANCE_MS}ms` }} />
                </div>
              </div>
            )}
            <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:items-center">
              <button type="button" onClick={() => { setHeld(true); setPhase({ k: "choose" }); }} className="btn btn-quiet btn-lg w-full sm:w-auto">
                Change my vote
              </button>
              {step?.next && (
                <button type="button" onClick={step.next} className="btn btn-ink btn-lg w-full sm:w-auto">
                  {step.nextLabel ?? "Next question"} <span aria-hidden>→</span>
                </button>
              )}
            </div>
          </div>
        ) : (
          <div>
            <button
              type="button"
              onClick={sign}
              disabled={picked === null || busy || (mine?.option === picked && phase.k === "choose")}
              aria-busy={busy}
              className="btn btn-ink btn-lg w-full sm:w-auto"
            >
              {busy && <Spinner />}
              {phase.k === "signing"
                ? "Sign in your wallet…"
                : phase.k === "saving"
                  ? "Saving your vote…"
                  : picked === null
                    ? "Pick an answer"
                    : mine?.option === picked
                      ? "This is your vote"
                      : mine
                        ? `Change my vote to ${choice}`
                        : "Sign my vote"}
            </button>
            {phase.k === "rejected" ? (
              <p className="mt-3 text-[14px] leading-relaxed text-soft">No problem. Nothing was signed. Sign when you&apos;re ready.</p>
            ) : phase.k === "failed" ? (
              <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2" role="alert">
                <p className="text-[14px] leading-relaxed text-danger">{phase.message}</p>
                {phase.retry ? (
                  <button type="button" onClick={() => lastSent.current && send(lastSent.current)} className="btn btn-quiet btn-sm">
                    Try again
                  </button>
                ) : (
                  <button type="button" onClick={sign} className="btn btn-quiet btn-sm">
                    Sign again
                  </button>
                )}
              </div>
            ) : (
              <p className="mt-3 max-w-[60ch] text-[13.5px] leading-relaxed text-mute">
                {picked === null
                  ? "Pick one, then sign. You can change it until the vote closes."
                  : `Your wallet will ask you to sign a message that says you chose ${choice}. It's free, nothing is sent, and you can change it later.`}
              </p>
            )}
            {mine && mine.option !== picked && phase.k === "choose" && (
              <p className="mt-2 text-[13.5px] text-mute">Right now your vote is {mine.choice}.</p>
            )}
          </div>
        )}
      </div>

      {step && (
        <nav aria-label="Move between questions" className="flex items-center justify-between gap-3 border-t border-line px-3 py-2.5 sm:px-5">
          <button type="button" onClick={step.back} disabled={!step.back} className="btn btn-quiet btn-sm min-h-11 disabled:opacity-40">
            <span aria-hidden>←</span> Previous
          </button>
          <span className="tnum text-[12.5px] text-mute">
            {step.index + 1} / {step.total}
          </span>
          <button type="button" onClick={step.next} disabled={!step.next} className="btn btn-quiet btn-sm min-h-11 disabled:opacity-40">
            {step.nextLabel ?? "Next question"} <span aria-hidden>→</span>
          </button>
        </nav>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ progress */

/** Which question you're on and which you've answered: a green fill that moves with you, and dots that light up. */
export function Progress({
  votes,
  current,
  voted,
  onJump,
}: {
  votes: VoteSummary[];
  current: number | "summary";
  voted: (id: string) => boolean;
  onJump: (i: number | "summary") => void;
}) {
  const at = current === "summary" ? votes.length : current;
  const fill = current === "summary" ? 100 : ((at + 0.5) / votes.length) * 100;
  return (
    <nav aria-label="Questions" className="px-1">
      <div className="relative h-1.5 overflow-hidden rounded-full bg-surface-2">
        <div className="h-full rounded-full bg-sealed transition-[width] duration-500 ease-out motion-reduce:transition-none" style={{ width: `${fill}%` }} />
      </div>
      <ol className="mt-3 flex items-center justify-between gap-2">
        {votes.map((v, i) => {
          const done = voted(v.id);
          const here = current === i;
          return (
            <li key={v.id}>
              <button
                type="button"
                onClick={() => onJump(i)}
                aria-current={here ? "step" : undefined}
                aria-label={`Question ${i + 1}: ${v.question}${done ? " (answered)" : ""}`}
                className="group flex min-h-11 items-center gap-2 rounded-full pr-2 text-[13px]"
              >
                <span
                  className={`grid h-7 w-7 place-items-center rounded-full border text-[12px] transition-all duration-300 motion-reduce:transition-none ${
                    done
                      ? "border-sealed bg-sealed text-panel shadow-[0_0_0_4px_color-mix(in_srgb,var(--sealed)_18%,transparent)]"
                      : here
                        ? "border-foreground text-foreground"
                        : "border-line-strong text-mute group-hover:border-sealed group-hover:text-foreground"
                  }`}
                >
                  {done ? <CheckIcon size={13} stroke={2.6} /> : i + 1}
                </span>
                <span className={`hidden sm:inline ${here ? "text-foreground" : "text-mute"}`}>Question {i + 1}</span>
              </button>
            </li>
          );
        })}
        <li>
          <button
            type="button"
            onClick={() => onJump("summary")}
            aria-current={current === "summary" ? "step" : undefined}
            className={`min-h-11 rounded-full px-3 text-[13px] transition-colors hover:bg-surface ${current === "summary" ? "text-foreground" : "text-mute"}`}
          >
            Summary
          </button>
        </li>
      </ol>
    </nav>
  );
}

/* ------------------------------------------------------------------ results */

/** Where a close-weighted vote's numbers come from, in one plain line. Nothing for a snapshot-weighted vote. */
export function basisLine(s: Pick<VoteSummary, "basis" | "closeBlock">): string | null {
  if (s.basis === "live") return "Live, final weights are counted when the vote closes.";
  if (s.basis === "counting") return "Voting has closed. These are still live weights while the final count comes in.";
  if (s.basis === "final") return `Final, weighted by the $GLOAM each wallet held when voting closed (block ${blockText(s.closeBlock ?? 0)}).`;
  return null;
}

/** One vote's live totals: a bar per answer, its share, its weight and its wallets. */
export function ResultsCard({ s, mine, link = true }: { s: VoteSummary; mine?: Ballot | null; link?: boolean }) {
  const total = BigInt(s.totals.weight);
  const lead = s.totals.options.reduce((a, b) => (BigInt(b.weight) > BigInt(a.weight) ? b : a), s.totals.options[0]!);
  return (
    <article className="gl-card p-5 sm:p-7" aria-label={`Results: ${s.question}`}>
      <h3 className="text-[17px] leading-snug tracking-[-0.01em] text-foreground [text-wrap:balance] sm:text-[19px]">{s.question}</h3>
      <ul className="mt-5 flex flex-col gap-2.5">
        {s.totals.options.map((o) => {
          const pct = percentOf(BigInt(o.weight), total);
          const leading = total > 0n && o.option === lead.option;
          const yours = mine?.option === o.option;
          return (
            <li key={o.option} className={`-mx-2 rounded-[12px] px-2 py-1.5 ${yours ? "bg-sealed-soft" : ""}`}>
              <div className="flex items-center justify-between gap-3">
                <span className="flex min-w-0 items-center gap-2.5">
                  <OptionArt voteId={s.id} index={o.option} size={20} />
                  <span className="min-w-0 text-[15px] leading-snug text-foreground">
                    {o.label}
                    {yours && (
                      <span className="ml-2 inline-flex items-center gap-1 rounded-full bg-sealed px-1.5 py-px align-middle text-[11px] font-medium text-panel">
                        <CheckIcon size={10} stroke={2.6} /> You
                      </span>
                    )}
                  </span>
                </span>
                <span className={`tnum shrink-0 text-[17px] ${leading ? "text-foreground" : "text-soft"}`}>{pct}%</span>
              </div>
              <div
                className="mt-2 h-2.5 overflow-hidden rounded-full bg-surface-2"
                role="img"
                aria-label={`${o.label}: ${pct}% of the vote, ${formatGloam(o.weight)} GLOAM from ${o.wallets} ${o.wallets === 1 ? "wallet" : "wallets"}`}
              >
                <div
                  className={`${m.grow} h-full rounded-full transition-[width] duration-700 ease-out motion-reduce:transition-none ${leading ? "bg-sealed" : "bg-sealed/45"}`}
                  style={{ width: `${pct}%` }}
                />
              </div>
              <p className="tnum mt-1.5 text-[12.5px] text-mute">
                {formatGloam(o.weight)} GLOAM · {o.wallets} {o.wallets === 1 ? "wallet" : "wallets"}
              </p>
            </li>
          );
        })}
      </ul>
      {/* the hub leads with these; a vote's own page shows it here */}
      {s.outcome && !link && <p className="mt-5 rounded-[12px] bg-surface px-4 py-3 text-[14.5px] leading-relaxed text-foreground">{s.outcome}</p>}
      <div className="mt-5 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-line pt-4">
        <p className="tnum text-[13px] text-mute">
          {s.totals.wallets} {s.totals.wallets === 1 ? "wallet" : "wallets"} · {formatGloam(s.totals.weight)} GLOAM
          {s.eligible ? ` of ${formatGloam(s.eligible.weight)}` : ""}
        </p>
        {link && (
          <Link href={`/vote/${s.id}`} className="gl-arrowlink text-[13.5px]">
            Every vote <span aria-hidden>→</span>
          </Link>
        )}
      </div>
      {basisLine(s) && <p className="mt-2 text-[12.5px] leading-relaxed text-mute">{basisLine(s)}</p>}
    </article>
  );
}

/** "Updated 8 seconds ago", kept fresh. */
export function UpdatedAgo({ at }: { at: number | null }) {
  const now = useNow(5_000);
  if (at === null || now === null) return <span className="text-[13px] text-mute">Live</span>;
  const sec = Math.max(0, Math.round((now - at) / 1000));
  return (
    <span className="tnum text-[13px] text-mute" aria-live="off">
      Updated {sec < 10 ? "just now" : sec < 60 ? `${sec} seconds ago` : `${Math.round(sec / 60)} min ago`}
    </span>
  );
}

/** Where to download every signed vote and count again. */
export function Recount({ votes }: { votes: Pick<VoteSummary, "id" | "question">[] }) {
  return (
    <section aria-labelledby="recount-title" className="rounded-[18px] border border-line p-5 sm:p-7">
      <h2 id="recount-title" className="text-[17px] tracking-[-0.01em] text-foreground">
        Count it yourself
      </h2>
      <p className="mt-2 max-w-[60ch] text-[14px] leading-relaxed text-mute">
        Every vote is a public EIP-712 signature. The downloads carry each wallet, its answer, its weight and its signature, with the message
        format, so anyone can check every one and recount.
      </p>
      <ul className="mt-4 divide-y divide-line border-t border-line">
        {votes.map((v) => (
          <li key={v.id} className="flex flex-col gap-2 py-3.5 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
            <span className="min-w-0 text-[14px] text-soft">{v.question}</span>
            <span className="flex shrink-0 gap-2">
              <a href={`/api/vote/${v.id}/ballots?download=1`} className="btn btn-ghost btn-sm">
                JSON
              </a>
              <a href={`/api/vote/${v.id}/ballots?format=csv`} className="btn btn-ghost btn-sm">
                CSV
              </a>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** A prefilled X post. Never carries the wallet. */
export function ShareVoted({ endPhrase }: { endPhrase: string }) {
  const text = `I voted in the $GLOAM holder votes on what Gloam builds next. Open until ${endPhrase}.\n\ngloam.trade/vote`;
  return (
    <a
      href={`https://x.com/intent/post?text=${encodeURIComponent(text)}`}
      target="_blank"
      rel="noopener noreferrer"
      className="btn btn-ghost btn-lg w-full sm:w-auto"
    >
      Share that you voted <span aria-hidden>↗</span>
    </a>
  );
}

/* ------------------------------------------------------------------ the plain rules */

export function HowItWorks({ block, firstId, closesAt }: { block: number; firstId?: string; /** For a close-weighted vote: when voting closes (ISO). */ closesAt?: string }) {
  const weight = closesAt
    ? [
        `Any wallet holding $GLOAM can vote. Your weight is the $GLOAM in your wallet when voting closes, ${whenPhrase(closesAt)}, read on Robinhood Chain at the first block at or after that time.`,
        "Until then the results are live: each vote counts what its wallet holds now. GLOAM can only be in one wallet when voting closes, so the same GLOAM can't be counted twice.",
      ]
    : [`Your weight is the $GLOAM your wallet held at Robinhood Chain block ${block ? blockText(block) : "(not set yet)"}. Buying or moving GLOAM after that changes nothing.`];
  const lines = [
    "This is an open vote. Every vote, with the wallet that cast it, is public.",
    ...weight,
    "Voting is free: you sign a message, nothing is sent and no gas is paid. You can change your vote until it closes; your latest signature counts.",
    "Team wallets, Gloam's own contracts and the trading pools don't count.",
    "When you connect, we note your wallet and its $GLOAM balance so we can count how many holders took part. Nothing else is kept.",
    "GLOAM held privately inside Gloam can't be counted in an open vote. Private voting, where you prove your balance without showing your wallet, is the next step on the roadmap.",
    "The results are advisory, and the team will act on them.",
  ];
  return (
    <section aria-labelledby="how-title">
      <h2 id="how-title" className="t-display-m">
        How this vote works
      </h2>
      <ul className="mt-6 divide-y divide-line border-y border-line">
        {lines.map((line) => (
          <li key={line} className="py-4 text-[15px] leading-relaxed text-soft">
            {line}
          </li>
        ))}
      </ul>
      {firstId && (
        <Link href={`/vote/${firstId}#not-counted`} className="gl-arrowlink mt-5 inline-flex text-[14px]">
          The addresses that don&apos;t count <span aria-hidden>→</span>
        </Link>
      )}
    </section>
  );
}
