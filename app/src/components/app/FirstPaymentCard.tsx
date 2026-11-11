"use client";

import { IntentLink } from "@/components/IntentLink";
import { useMemo, useSyncExternalStore } from "react";
import type { LocalNote } from "@/lib/shield";
import {
  dismissFirstPayNudge,
  firstPayHref,
  firstPaySnapshot,
  firstPaySuggestion,
  hasPaidPrivately,
  parseFirstPay,
  subscribeFirstPay,
} from "@/lib/firstPayment";
import { formatRequestAmount } from "@/lib/paymentRequest";
import { track } from "@/lib/track";

const serverSnapshot = () => "";

/**
 * Shown on the portfolio to someone who holds a private balance here but has
 * never paid privately from this device. One button opens the existing Pay
 * form with a small amount filled in; dismissing it is remembered on this
 * device. The parent only renders it when there is a private balance.
 */
export function FirstPaymentCard({
  open,
  all,
  chainId,
}: {
  /** Spendable private balances on this network. */
  open: LocalNote[];
  /** Every note loaded for this network, spent ones included. */
  all: LocalNote[];
  chainId: number;
}) {
  const raw = useSyncExternalStore(subscribeFirstPay, firstPaySnapshot, serverSnapshot);
  const state = useMemo(() => parseFirstPay(raw), [raw]);
  const suggestion = useMemo(() => firstPaySuggestion(open, chainId), [open, chainId]);

  if (state.dismissed || hasPaidPrivately(state, all)) return null;

  const label = suggestion
    ? `Send ${formatRequestAmount(suggestion.amount)} ${suggestion.symbol} privately`
    : "Pay privately";

  return (
    <section
      aria-labelledby="first-pay-title"
      className="gl-card flex gap-4 max-sm:items-start max-sm:p-5 sm:items-center sm:py-4 sm:pl-6 sm:pr-4"
    >
      <span
        aria-hidden
        className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-sealed-soft text-sealed"
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
          <path
            d="M7 17L17 7M9 7h8v8"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>

      <div className="flex min-w-0 flex-1 max-sm:flex-col max-sm:gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
        <div className="min-w-0">
          <h2 id="first-pay-title" className="text-[15px] text-foreground">
            Send your first private payment
          </h2>
          <p className="mt-0.5 max-w-[62ch] text-[13px] leading-relaxed text-mute">
            The amount and who you pay stay hidden. The explorer only shows
            Gloam transactions.
          </p>
        </div>
        <IntentLink
          href={firstPayHref(suggestion)}
          onClick={() => track("first_pay_nudge_open", { chainId })}
          className="btn btn-ink btn-sm shrink-0 max-sm:self-start"
        >
          {label}
        </IntentLink>
      </div>

      <button
        type="button"
        onClick={() => {
          dismissFirstPayNudge();
          track("first_pay_nudge_dismiss", { chainId });
        }}
        aria-label="Don’t show this again"
        title="Don’t show this again"
        className="-mr-1.5 grid h-9 w-9 shrink-0 place-items-center rounded-full text-mute transition-colors hover:bg-surface hover:text-foreground max-sm:-mt-1.5"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
          <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
        </svg>
      </button>
    </section>
  );
}
