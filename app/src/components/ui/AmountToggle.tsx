"use client";

import { useHideAmounts } from "@/lib/hideAmounts";

/** The eye that hides or shows every amount in the app. */
export function AmountToggle({ className = "" }: { className?: string }) {
  const [hidden, toggle] = useHideAmounts();
  return (
    <button
      type="button"
      onClick={toggle}
      aria-pressed={hidden}
      aria-label={hidden ? "Show amounts" : "Hide amounts"}
      title={hidden ? "Show amounts" : "Hide amounts"}
      className={`grid h-10 w-10 place-items-center rounded-full text-mute transition-colors hover:bg-surface hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground/50 ${className}`}
    >
      <EyeIcon off={hidden} />
    </button>
  );
}

export function EyeIcon({ off = false }: { off?: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M2.5 12s3.5-6.5 9.5-6.5S21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="12" r="2.75" stroke="currentColor" strokeWidth="1.6" />
      {off && <path d="M4 20L20 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />}
    </svg>
  );
}
