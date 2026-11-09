"use client";

/**
 * Pay > Cash out, "cash out privately" (lib/cashOutPrivately): the calm note
 * when a cash out lines up with money that came in, the pieces it would be
 * made of, the window they spread over, and a piece that did not get
 * scheduled. MoveView owns the state; these only draw it.
 */
import type { ReactNode } from "react";
import type { Address } from "viem";
import { shortAddress } from "@/lib/chain";
import { feeRise, feeRiseLine, type CashOutWindow } from "@/lib/cashOutLater";
import type { PieceProgress, PieceState } from "@/lib/cashOutPrivately";
import { assetLabel, formatAssetAmount, formatAssetLabel, type LocalNote } from "@/lib/shield";

export const PLAN_WINDOWS: [CashOutWindow, string, string][] = [
  ["hour", "About an hour", "about an hour"],
  ["6h", "About 6 hours", "about 6 hours"],
  ["day", "About a day", "about a day"],
];

export function windowWords(w: CashOutWindow): string {
  return PLAN_WINDOWS.find(([k]) => k === w)?.[2] ?? "a while";
}

function clock(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** "about 15:40" today, "tomorrow at about 09:12", "Sat at about 09:12" this week, or "Nov 14 at about 09:12" past it. */
export function aboutTime(at: number, now = Date.now()): string {
  const day = (t: number) => new Date(t).toDateString();
  if (day(at) === day(now)) return `about ${clock(at)}`;
  if (day(at) === day(now + 86_400_000)) return `tomorrow at about ${clock(at)}`;
  // a prepaid top-up can be weeks off, where a weekday alone says nothing
  const far = at - now >= 6 * 86_400_000;
  return `${new Date(at).toLocaleDateString("en-US", far ? { month: "short", day: "numeric" } : { weekday: "short" })} at about ${clock(at)}`;
}

function capital(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}

/** The calm note under the amount: what lines this cash out up with money that came in. */
export function CashOutLinkNote({ text, action }: { text: string; action?: ReactNode }) {
  return (
    <div className="mt-3 flex items-start gap-2.5 rounded-[12px] bg-panel px-3.5 py-3 text-[12.5px] leading-relaxed text-soft">
      <LinkGlyph />
      <p className="min-w-0">
        {text}
        {action ? <> {action}</> : null}
      </p>
    </div>
  );
}

/** How: in pieces over time, or all at once. */
export function HowChoice({
  privately,
  onChange,
  pieceCount,
  window,
  disabled,
}: {
  privately: boolean;
  onChange: (privately: boolean) => void;
  pieceCount: number;
  window: CashOutWindow;
  disabled?: boolean;
}) {
  const options = [
    [false, "Now", "Arrives in one go"],
    [true, "Privately", `${pieceCount} pieces over ${windowWords(window)}`],
  ] as const;
  return (
    <div>
      <p id="cashout-how" className="text-[13px] text-mute">
        How
      </p>
      <div role="radiogroup" aria-labelledby="cashout-how" className="mt-2 grid grid-cols-2 gap-2">
        {options.map(([value, label, hint]) => {
          const active = privately === value;
          return (
            <button
              key={label}
              type="button"
              role="radio"
              aria-checked={active}
              disabled={disabled}
              onClick={() => onChange(value)}
              className={`flex min-h-[60px] min-w-0 items-start gap-3 rounded-[14px] border px-3.5 py-3 text-left transition-colors disabled:opacity-60 ${
                active ? "border-foreground bg-panel" : "border-line hover:border-line-strong hover:bg-surface"
              }`}
            >
              <span
                aria-hidden
                className={`mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full border transition-colors ${
                  active ? "border-foreground bg-foreground" : "border-line-strong"
                }`}
              >
                {active && <span className="h-2 w-2 rounded-full bg-panel" />}
              </span>
              <span className="min-w-0">
                <span className="block text-[14.5px] leading-snug text-foreground">{label}</span>
                <span className="mt-0.5 block text-[12px] leading-snug text-mute">{hint}</span>
              </span>
            </button>
          );
        })}
      </div>
      <p className="mt-2 text-[12.5px] leading-relaxed text-mute">
        {privately
          ? `It arrives in pieces at different times over ${windowWords(window)}, so it is much harder to match to what you added. You can cancel any piece before it goes.`
          : "Want it harder to trace? Privately sends it in a few pieces at different times, so it can't easily be matched to what you added."}
      </p>
    </div>
  );
}

const STATE_WORDS: Record<PieceState, string> = {
  waiting: "Waiting its turn",
  splitting: "Setting it aside",
  proving: "Proving",
  scheduling: "Scheduling",
  scheduled: "Scheduled",
  stopped: "Not scheduled",
};

/**
 * The pieces: round sizes plus a remainder, in the private tint. While the
 * cash out is being set up, each piece's progress instead.
 */
export function PiecesCard({
  pieces,
  asset,
  amount,
  avoiding,
  tailMatch,
  run,
  onReroll,
  onRound,
}: {
  pieces: bigint[];
  asset: string;
  amount: bigint;
  /** What the pieces stay clear of, in words ("money you added"), or null when there is nothing to avoid. */
  avoiding: string | null;
  tailMatch: boolean;
  run: PieceProgress[] | null;
  onReroll?: () => void;
  onRound?: () => void;
}) {
  const symbol = assetLabel(asset);
  return (
    <div className="rounded-[16px] bg-sealed-soft px-4 py-4 sm:px-5">
      <div className="flex items-center justify-between gap-3">
        <p className="text-[13px] font-medium text-sealed">{`In ${pieces.length} pieces`}</p>
        {onReroll && !run && (
          <button
            type="button"
            onClick={onReroll}
            className="-my-2 -mr-2 inline-flex min-h-10 items-center rounded-full px-2 text-[13px] text-mute transition-colors hover:text-foreground"
          >
            Other sizes
          </button>
        )}
      </div>
      {run ? (
        <ul className="mt-2" aria-live="polite">
          {run.map((p, i) => {
            const busy = p.state === "splitting" || p.state === "proving" || p.state === "scheduling";
            return (
              <li key={i} className="flex items-center justify-between gap-3 py-2 text-[14px]">
                <span className="tnum text-foreground">
                  {formatAssetAmount(p.amount, asset)} <span className="text-mute">{symbol}</span>
                </span>
                <span className={`flex items-center gap-2 text-[12.5px] ${p.state === "stopped" ? "text-warn" : "text-mute"}`}>
                  {busy && <Dot />}
                  {p.state === "scheduled" && p.at ? `Scheduled, ${aboutTime(p.at)}` : `${STATE_WORDS[p.state]}${busy ? "…" : ""}`}
                </span>
              </li>
            );
          })}
        </ul>
      ) : (
        <ul className="mt-3 flex flex-wrap gap-2">
          {pieces.map((p, i) => (
            <li key={i} className="tnum rounded-full bg-panel px-3.5 py-1.5 text-[15px] text-foreground">
              {formatAssetAmount(p, asset)} <span className="text-[13px] text-mute">{symbol}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-3 text-[12.5px] leading-relaxed text-soft">
        {avoiding ? `None of them matches ${avoiding}. ` : ""}
        {`Together they make exactly ${formatAssetLabel(amount, asset)}.`}
      </p>
      {tailMatch && !run && (
        <p className="mt-2 text-[12.5px] leading-relaxed text-soft">
          One piece keeps the cents of money you added, which can tie it back.{" "}
          {onRound && (
            <button type="button" onClick={onRound} className="font-medium text-foreground underline underline-offset-4">
              Round it
            </button>
          )}{" "}
          to leave them in your balance.
        </p>
      )}
    </div>
  );
}

/** The window the pieces spread over. */
export function SpreadOver({
  value,
  onChange,
  disabled,
}: {
  value: CashOutWindow;
  onChange: (w: CashOutWindow) => void;
  disabled?: boolean;
}) {
  return (
    <div>
      <p id="cashout-spread" className="text-[13px] text-mute">
        Spread over
      </p>
      <div role="radiogroup" aria-labelledby="cashout-spread" className="mt-2 grid grid-cols-3 gap-2">
        {PLAN_WINDOWS.map(([w, label]) => {
          const active = value === w;
          return (
            <button
              key={w}
              type="button"
              role="radio"
              aria-checked={active}
              disabled={disabled}
              onClick={() => onChange(w)}
              className={`min-h-[48px] rounded-[14px] border px-2 py-2.5 text-center text-[13.5px] leading-snug transition-colors disabled:opacity-60 ${
                active ? "border-foreground bg-panel text-foreground" : "border-line text-soft hover:border-line-strong hover:bg-surface"
              }`}
            >
              {label}
            </button>
          );
        })}
      </div>
      <p className="mt-2 text-[12.5px] leading-relaxed text-mute">
        Each piece goes out at its own random time in that window, sent by the Gloam relay so your wallet stays out of
        it. The vault takes its fee as each one goes out, at the rate then. Once they are scheduled you can close Gloam.
      </p>
      <p className="mt-2 text-[12.5px] leading-relaxed text-mute">
        Each proof shows roughly when it was made, so pieces made together can be grouped. While Gloam is open it
        remakes them, last shortly before each one goes. A piece that goes out while Gloam is closed shows when it was
        last made.
      </p>
    </div>
  );
}

/** A piece split off for a private cash out that did not get scheduled: still in the private balance. */
export function PieceLeftover({
  note,
  busy,
  scheduling,
  onSchedule,
  onKeep,
}: {
  note: LocalNote;
  busy: boolean;
  /** This piece is being scheduled right now. */
  scheduling: boolean;
  onSchedule: () => void;
  onKeep: () => void;
}) {
  const tag = note.cashOutPlan!;
  return (
    <div className="rounded-[16px] bg-surface px-4 py-3.5 text-[13px] leading-relaxed">
      <p className="text-foreground">
        {`A piece of your private cash out, ${formatAssetLabel(note.amountWei, note.asset)} to ${shortAddress(tag.to as Address)}, wasn't scheduled. It's safe in your private balance.`}
      </p>
      <div className="mt-1 flex flex-wrap gap-x-5">
        <button
          type="button"
          disabled={busy}
          onClick={onSchedule}
          className="inline-flex min-h-10 items-center font-medium underline underline-offset-4 disabled:opacity-50"
        >
          {scheduling ? "Scheduling…" : `Schedule it over ${windowWords(tag.window)}`}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={onKeep}
          className="inline-flex min-h-10 items-center text-mute underline underline-offset-4 hover:text-foreground disabled:opacity-50"
        >
          Keep it in my balance
        </button>
      </div>
    </div>
  );
}

/**
 * One row of Scheduled cash outs: when it goes, and for a piece, which one.
 * `gasWait`: gas on its chain is over the relay's ceiling (Ethereum), so one
 * whose time has come waits for it to come down.
 */
export function scheduledLine(n: LocalNote, now = Date.now(), gasWait = false): string {
  const piece = n.cashOutPlan ? `${n.cashOutPlan.topUp ? "Top-up" : "Piece"} ${n.cashOutPlan.piece} of ${n.cashOutPlan.of} · ` : "";
  const waiting = gasWait && n.cashOut?.state === "scheduled" && n.cashOut.at <= now;
  const when = n.cashOut?.state === "sent" ? "On its way" : waiting ? "Waiting for gas to come down" : capital(aboutTime(n.cashOut!.at, now));
  return `${piece}${when} · to ${shortAddress(n.cashOut!.to)}`;
}

/**
 * Scheduled cash outs: when each goes, and, for one set up before the vault's
 * fee rose (lib/cashOutLater feeRise), what it pays now.
 */
export function ScheduledCashOuts({
  rows,
  liveFeeBps,
  gasHigh,
  onCancel,
}: {
  rows: LocalNote[];
  liveFeeBps: number | null;
  gasHigh: boolean;
  onCancel: (n: LocalNote) => Promise<void>;
}) {
  if (!rows.length) return null;
  return (
    <div className="rounded-[16px] bg-surface px-4 py-3">
      <p className="text-[13px] text-mute">Scheduled cash outs</p>
      <ul className="mt-1 divide-y divide-line">
        {rows.map((n) => {
          const rise = feeRise(n, liveFeeBps);
          return (
            <li key={n.id} className="flex items-center justify-between gap-3 py-2.5 text-[13.5px]">
              <span className="min-w-0">
                <span className="tnum block text-foreground">{formatAssetLabel(n.amountWei, n.asset)}</span>
                <span className="block truncate text-[12px] text-mute">{scheduledLine(n, undefined, gasHigh)}</span>
                {rise && <span className="tnum block text-[12px] leading-relaxed text-warn">{feeRiseLine(rise, n.asset)}</span>}
              </span>
              {n.cashOut?.state === "scheduled" && (
                <button type="button" className="btn btn-ghost btn-sm shrink-0" onClick={() => void onCancel(n)}>
                  Cancel
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Dot() {
  return <span aria-hidden className="h-1.5 w-1.5 animate-pulse rounded-full bg-sealed motion-reduce:animate-none" />;
}

function LinkGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden className="mt-[3px] shrink-0 text-mute">
      <path d="M10 14a4.5 4.5 0 0 0 6.36 0l3-3a4.5 4.5 0 0 0-6.36-6.36l-1.25 1.25" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M14 10a4.5 4.5 0 0 0-6.36 0l-3 3a4.5 4.5 0 0 0 6.36 6.36l1.25-1.25" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}
