"use client";

/**
 * The privacy switch, drawn the same way in every flow (Pay, Receive, Cash out):
 * one card with a lock, a title, one line and a switch, tinted green when on.
 * Choices that belong to it go inside, as children, shown while it is on.
 */
import type { ReactNode } from "react";

export function PrivacyCard({
  title,
  line,
  on,
  onToggle,
  available = true,
  reason,
  disabled,
  children,
}: {
  title: string;
  /** One short line: what it does now. */
  line: string;
  on: boolean;
  onToggle: (on: boolean) => void;
  available?: boolean;
  /** Why it can't be switched (shown in place of the line when not available). */
  reason?: string | null;
  disabled?: boolean;
  children?: ReactNode;
}) {
  return (
    <div
      className={`rounded-[18px] border px-4 py-4 transition-colors sm:px-5 ${
        on && available ? "border-sealed/30 bg-sealed-soft" : "border-line bg-surface"
      }`}
    >
      <button
        type="button"
        role="switch"
        aria-checked={on && available}
        disabled={disabled || !available}
        onClick={() => onToggle(!on)}
        className="flex w-full items-center gap-3.5 text-left disabled:cursor-not-allowed"
      >
        <span
          aria-hidden
          className={`grid h-10 w-10 shrink-0 place-items-center rounded-full transition-colors ${
            on && available ? "bg-sealed text-panel" : "bg-panel text-mute"
          }`}
        >
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none">
            <rect x="5" y="10.5" width="14" height="9.5" rx="2.5" stroke="currentColor" strokeWidth="1.9" />
            <path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
          </svg>
        </span>
        <span className="min-w-0 flex-1">
          <span className={`block text-[15.5px] font-medium ${available ? "text-foreground" : "text-mute"}`}>{title}</span>
          <span className="mt-0.5 block text-[12.5px] leading-relaxed text-mute">
            {available ? line : (reason ?? "Not available right now.")}
          </span>
        </span>
        <span
          aria-hidden
          className={`relative h-[26px] w-[46px] shrink-0 rounded-full transition-colors ${
            on && available ? "bg-sealed" : "bg-line-strong"
          } ${available ? "" : "opacity-50"}`}
        >
          <span
            className={`absolute top-[3px] h-5 w-5 rounded-full bg-panel shadow transition-[left] duration-200 ${
              on && available ? "left-[23px]" : "left-[3px]"
            }`}
          />
        </span>
      </button>
      {on && available && children ? <div className="mt-4 space-y-4 border-t border-sealed/20 pt-4">{children}</div> : null}
    </div>
  );
}
