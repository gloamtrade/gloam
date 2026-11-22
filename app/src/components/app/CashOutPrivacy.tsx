"use client";

/**
 * The cash-out privacy kit (lib/cashOutPrivacy), drawn the same way wherever
 * money leaves the private balance for a public address: round amounts under
 * the amount field, quiet warnings for an address or amount that ties the cash
 * out back to you, and one plain line on what goes public and what stays
 * private, above the button that sends it. The caller owns the state; these
 * only draw it. Nothing here blocks a cash out.
 */
import { useRef, useState, type ReactNode } from "react";
import { PRIVATE_LINE, publicLine, type CashOutSender, type CashOutWarning, type PresetAmount } from "@/lib/cashOutPrivacy";

/** Round amounts and Max as small chips, with one line on why round amounts help. */
export function CashOutAmountChips({
  presets,
  current,
  maxActive,
  onPick,
  onMax,
  extra,
  disabled,
}: {
  /** lib/cashOutPrivacy presetAmounts: already only those up to the balance. */
  presets: PresetAmount[];
  /** The amount in the field now (base units), or null while it is not valid. */
  current: bigint | null;
  /** The whole balance is in the field. (An empty field is no amount, never the whole balance.) */
  maxActive: boolean;
  onPick: (value: string) => void;
  onMax: () => void;
  /** More chips after Max (Round it). */
  extra?: ReactNode;
  disabled?: boolean;
}) {
  return (
    <div className="mt-3">
      <div role="group" aria-label="Amount presets" className="flex flex-wrap gap-2">
        {presets.map((p) => {
          const on = !maxActive && current === p.wei;
          return (
            <button
              key={p.value}
              type="button"
              disabled={disabled}
              aria-pressed={on}
              onClick={() => onPick(p.value)}
              className={`gl-chip tnum min-h-10 ${on ? "border-foreground! text-foreground!" : ""}`}
            >
              {p.label}
            </button>
          );
        })}
        <button
          type="button"
          disabled={disabled}
          aria-pressed={maxActive}
          onClick={onMax}
          className={`gl-chip min-h-10 ${maxActive ? "border-foreground! text-foreground!" : ""}`}
        >
          Max
        </button>
        {extra}
      </div>
      {presets.length > 0 && (
        <p className="mt-2 text-[12.5px] leading-relaxed text-mute">
          Round amounts are common, so they are harder to match to your deposit.
        </p>
      )}
    </div>
  );
}

const PERCENTS = [25, 50, 75] as const;

/** A share of the balance, floored and cut to 4 decimals so it reads and types cleanly. */
export function percentOf(balance: bigint, pct: number, decimals: number): bigint {
  const raw = (balance * BigInt(pct)) / 100n;
  if (decimals <= 4) return raw;
  const step = 10n ** BigInt(decimals - 4);
  return (raw / step) * step;
}

/**
 * 25%, 50%, 75%, Max and Custom under a cash-out amount. Custom puts the
 * cursor in the field to type any amount. `extra` (Round it) shows only when it
 * changes something, with the one line on why round amounts help.
 */
export function CashOutPercentChips({
  balance,
  decimals,
  current,
  maxActive,
  onPick,
  onMax,
  onCustom,
  extra,
  disabled,
}: {
  /** The whole balance this cash out spends, base units. */
  balance: bigint;
  decimals: number;
  /** The amount in the field now (base units), or null while it is not valid. */
  current: bigint | null;
  /** The whole balance is going out. */
  maxActive: boolean;
  /** A share was picked: the amount as plain text for the field. */
  onPick: (value: string) => void;
  onMax: () => void;
  onCustom: () => void;
  extra?: ReactNode;
  disabled?: boolean;
}) {
  const shares = PERCENTS.map((pct) => ({ pct, wei: percentOf(balance, pct, decimals) })).filter((s) => s.wei > 0n);
  const shareOn = shares.find((s) => !maxActive && current === s.wei)?.pct ?? null;
  const customOn = !maxActive && shareOn === null && current !== null;
  const chip = (on: boolean) => `gl-chip tnum min-h-10 ${on ? "border-foreground! text-foreground!" : ""}`;
  return (
    <div className="mt-3">
      <div role="group" aria-label="Amount" className="flex flex-wrap gap-2">
        {shares.map((s) => (
          <button
            key={s.pct}
            type="button"
            disabled={disabled}
            aria-pressed={shareOn === s.pct}
            onClick={() => onPick(trimZeros(formatUnitsPlain(s.wei, decimals)))}
            className={chip(shareOn === s.pct)}
          >
            {s.pct}%
          </button>
        ))}
        <button type="button" disabled={disabled} aria-pressed={maxActive} onClick={onMax} className={chip(maxActive)}>
          Max
        </button>
        <button type="button" disabled={disabled} aria-pressed={customOn} onClick={onCustom} className={chip(customOn)}>
          Custom
        </button>
        {extra}
      </div>
      {extra && (
        <p className="mt-2 text-[12.5px] leading-relaxed text-mute">
          Round amounts are common, so they are harder to match to your deposit.
        </p>
      )}
    </div>
  );
}

function formatUnitsPlain(wei: bigint, decimals: number): string {
  const neg = wei < 0n;
  const v = neg ? -wei : wei;
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  const frac = (v % base).toString().padStart(decimals, "0");
  return `${neg ? "-" : ""}${whole}${decimals > 0 ? `.${frac}` : ""}`;
}

function trimZeros(s: string): string {
  return s.includes(".") ? s.replace(/\.?0+$/, "") : s;
}

/**
 * Quiet warnings, one line each, each dismissible for this cash out
 * (`scope`, e.g. the balance it spends: a new cash out shows them again). The
 * region is always there, so a screen reader hears a warning when it appears
 * and nothing more.
 */
export function CashOutWarnings({
  warnings,
  scope,
  onElsewhere,
  amountAction,
  disabled,
  className = "mt-3",
}: {
  warnings: CashOutWarning[];
  scope: string;
  /** "Cash out somewhere else": move to the address field. */
  onElsewhere?: () => void;
  /** A next step shown with a warning about the amount ("Cash out privately instead"). */
  amountAction?: ReactNode;
  /** A cash out is on its way: the actions wait. */
  disabled?: boolean;
  className?: string;
}) {
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
  const region = useRef<HTMLDivElement>(null);
  const shown = warnings.filter((w) => !dismissed.has(`${scope}|${w.key}`));
  return (
    <div ref={region} role="status" tabIndex={-1} className={shown.length ? `${className} space-y-2 outline-none` : "sr-only"}>
      {shown.map((w) => (
        <div
          key={w.key}
          className="flex items-start gap-1 rounded-[12px] bg-warn-soft py-1 pl-3.5 pr-1 text-[12.5px] leading-relaxed text-foreground"
        >
          <WarnGlyph />
          <div className="min-w-0 flex-1 py-[7px] pl-1.5">
            <p>{w.text}</p>
            {w.aboutAddress && onElsewhere && (
              <button
                type="button"
                disabled={disabled}
                onClick={onElsewhere}
                className="-my-1.5 inline-flex min-h-10 items-center font-medium underline underline-offset-4 disabled:opacity-50"
              >
                Cash out somewhere else
              </button>
            )}
            {!w.aboutAddress && amountAction}
          </div>
          <button
            type="button"
            aria-label="Dismiss this note"
            disabled={disabled}
            onClick={() => {
              setDismissed((s) => new Set(s).add(`${scope}|${w.key}`));
              region.current?.focus({ preventScroll: true });
            }}
            className="grid h-10 w-10 shrink-0 place-items-center rounded-full text-mute transition-colors hover:text-foreground disabled:opacity-50"
          >
            <CloseGlyph />
          </button>
        </div>
      ))}
    </div>
  );
}

/**
 * What a cash out makes public and what stays private, said once, plainly,
 * where the person confirms it.
 */
export function CashOutPrivacyLine({ sender, pieces = false }: { sender: CashOutSender; pieces?: boolean }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] items-start gap-x-3 gap-y-1.5 rounded-[14px] border border-line px-4 py-3 text-[12.5px] leading-relaxed">
      <dt className="text-foreground">Public</dt>
      <dd className="text-soft">{publicLine({ sender, pieces })}</dd>
      <dt className="flex items-center gap-1.5 text-sealed">
        <LockGlyph />
        Private
      </dt>
      <dd className="text-soft">{PRIVATE_LINE}</dd>
    </dl>
  );
}

function WarnGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden className="mt-[10px] shrink-0 text-warn">
      <path d="M12 8.5v4.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <circle cx="12" cy="16.25" r="1.05" fill="currentColor" />
      <circle cx="12" cy="12" r="8.75" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}

function CloseGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}

function LockGlyph() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="4.5" y="10.5" width="15" height="10" rx="2.5" stroke="currentColor" strokeWidth="2" />
      <path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
