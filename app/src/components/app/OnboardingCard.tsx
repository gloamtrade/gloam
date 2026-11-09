"use client";

import Link from "next/link";
import { createPortal } from "react-dom";
import { useCallback, useEffect, useRef, useState } from "react";
import { useModalFocus } from "@/hooks/useModalFocus";
import { FAUCET_URL, faucetFor } from "@/lib/faucet";
import { useNetwork } from "./NetworkProvider";
import { useTempoFaucet } from "@/hooks/useTempoFaucet";
import { SealedField } from "@/components/ui/SealedField";
import {
  ONBOARDING_STEPS,
  dismissOnboarding,
  loadOnboarding,
  markOnboardingStep,
  type OnboardingState,
} from "@/lib/onboarding";

/** Fire this to open the getting-started modal from anywhere in the app. */
export const OPEN_ONBOARDING_EVENT = "gloam:open-onboarding";

export function openOnboarding() {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(OPEN_ONBOARDING_EVENT));
  }
}

/**
 * Getting-started guide as a modal. It opens only from the "Getting started"
 * link in the portfolio strip (which dispatches OPEN_ONBOARDING_EVENT).
 */
export function OnboardingCard() {
  const [state, setState] = useState<OnboardingState | null>(null);
  const [open, setOpen] = useState(false);
  const dialog = useRef<HTMLDivElement>(null);
  useModalFocus(dialog, () => setOpen(false), { open });
  const { network } = useNetwork();
  const isTempo = network.key === "tempo";
  // A mainnet has no faucet, so no faucet step.
  const steps = network.testnet ? ONBOARDING_STEPS : ONBOARDING_STEPS.filter((s) => s.id !== "faucet");
  const tempoFaucet = useTempoFaucet();
  // Robinhood Chain's faucet, or Base Sepolia's faucet guide (Circle's test USDC and EURC, and test ETH).
  const faucetUrl = faucetFor(network.key)?.url ?? FAUCET_URL;
  const faucetExternal = faucetUrl.startsWith("http");

  const refresh = useCallback(() => setState(loadOnboarding()), []);

  // Load persisted progress. The guide never opens by itself: a first visit gets
  // the welcome, and returning users shouldn't meet a checklist every session.
  // It opens from the "Getting started" link (OPEN_ONBOARDING_EVENT).
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- setup progress lives in this browser; read once after mount
    setState(loadOnboarding());
  }, []);

  // Let any "Getting started" trigger reopen it (even after dismiss).
  useEffect(() => {
    const onOpen = () => {
      setState(loadOnboarding());
      setOpen(true);
    };
    window.addEventListener(OPEN_ONBOARDING_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_ONBOARDING_EVENT, onOpen);
  }, []);

  // Body scroll lock while open.
  useEffect(() => {
    if (!open) return;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = "";
    };
  }, [open]);

  if (!state || !open || typeof document === "undefined") return null;

  const remaining = steps.filter((s) => !state.done.includes(s.id));
  const next = remaining[0] ?? null;
  const doneCount = steps.length - remaining.length;

  const allDone = remaining.length === 0;

  // Portal to <body> so the fixed overlay centres in the viewport rather than
  // inside the app's content wrapper.
  return createPortal(
    <div
      ref={dialog}
      tabIndex={-1}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 outline-none backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="onboarding-title"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) setOpen(false);
      }}
    >
      <div className="max-h-[min(90dvh,720px)] w-full max-w-[440px] overflow-y-auto rounded-[24px] border border-line bg-panel shadow-pop">
        <div className="relative overflow-hidden px-7 pb-6 pt-7">
          <SealedField tone="soft" />
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="absolute right-4 top-4 z-[2] grid h-10 w-10 place-items-center rounded-full text-mute transition-colors hover:bg-surface hover:text-foreground"
            aria-label="Close"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
              <path
                d="M6 6l12 12M18 6L6 18"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
              />
            </svg>
          </button>
          <div className="relative z-[1] pr-10">
            <p className="t-eyebrow">
              {allDone
                ? "Setup complete"
                : `${doneCount} of ${steps.length} done`}
            </p>
            <h2
              id="onboarding-title"
              className="mt-2 text-[28px] font-light leading-[1.1] tracking-[-0.018em] text-foreground"
            >
              {allDone ? "You’re all set" : "Getting started"}
            </h2>
            <p className="mt-2 text-[14px] leading-relaxed text-mute">
              {allDone
                ? "Add money privately, send it, and prove what you hold whenever you like."
                : "A few steps to get going. Each one takes a minute."}
            </p>
          </div>
          {!allDone && (
            <div
              className="relative z-[1] mt-5 h-1 w-full overflow-hidden rounded-full bg-surface-2"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={steps.length}
              aria-valuenow={doneCount}
              aria-label="Setup progress"
            >
              <span
                className="block h-full rounded-full bg-ink transition-[width] duration-500"
                style={{
                  width: `${(doneCount / steps.length) * 100}%`,
                }}
              />
            </div>
          )}
        </div>

        {!allDone && (
          <ol className="border-t border-line px-7">
            {steps.map((step, i) => {
              const done = state.done.includes(step.id);
              const isNext = next?.id === step.id;
              return (
                <li
                  key={step.id}
                  className="flex min-h-[60px] items-center justify-between gap-3 border-t border-line py-3 first:border-t-0"
                >
                  <span className="flex min-w-0 items-start gap-3">
                    <span
                      aria-hidden
                      className={`tnum mt-px grid h-6 w-6 shrink-0 place-items-center rounded-full text-[12px] font-medium ${
                        done
                          ? "bg-ink text-on-ink"
                          : isNext
                            ? "text-foreground ring-1 ring-foreground"
                            : "bg-surface text-mute"
                      }`}
                    >
                      {done ? (
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
                          <path
                            d="m5.5 12.5 4 4 9-9"
                            stroke="currentColor"
                            strokeWidth="2.4"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                      ) : (
                        i + 1
                      )}
                    </span>
                    <span className="min-w-0">
                      <span
                        className={`block text-[14px] ${
                          done
                            ? "text-mute line-through decoration-line-strong"
                            : "font-medium text-foreground"
                        }`}
                      >
                        <span className="sr-only">{done ? "Done: " : ""}</span>
                        {step.title}
                      </span>
                      {isNext && step.body && (
                        <span className="mt-0.5 block text-[12.5px] leading-relaxed text-mute">
                          {step.body}
                        </span>
                      )}
                    </span>
                  </span>
                  {!done &&
                    (isNext ? (
                      step.href === "external:faucet" ? (
                        isTempo ? (
                          <button
                            type="button"
                            onClick={() => {
                              void tempoFaucet.claim();
                              markOnboardingStep(step.id);
                              refresh();
                            }}
                            disabled={
                              !tempoFaucet.ready ||
                              tempoFaucet.status === "pending"
                            }
                            className="btn btn-ink btn-sm shrink-0"
                          >
                            {tempoFaucet.status === "pending"
                              ? "Funding…"
                              : tempoFaucet.status === "done"
                                ? "Funded"
                                : tempoFaucet.status === "enough"
                                  ? "Already funded"
                                  : "Claim"}
                          </button>
                        ) : (
                          <a
                            href={faucetUrl}
                            target={faucetExternal ? "_blank" : undefined}
                            rel={faucetExternal ? "noreferrer" : undefined}
                            onClick={() => {
                              markOnboardingStep(step.id);
                              refresh();
                            }}
                            className="btn btn-ink btn-sm shrink-0"
                          >
                            Open
                          </a>
                        )
                      ) : (
                        <Link
                          href={step.href}
                          onClick={() => {
                            markOnboardingStep(step.id);
                            setOpen(false);
                          }}
                          className="btn btn-ink btn-sm shrink-0"
                        >
                          Go
                        </Link>
                      )
                    ) : (
                      <button
                        type="button"
                        onClick={() => {
                          markOnboardingStep(step.id);
                          refresh();
                        }}
                        className="btn btn-quiet btn-sm shrink-0 text-mute"
                      >
                        Mark done
                      </button>
                    ))}
                </li>
              );
            })}
          </ol>
        )}

        <div className="flex items-center justify-between gap-3 border-t border-line px-7 py-4">
          <button
            type="button"
            onClick={() => {
              dismissOnboarding();
              refresh();
              setOpen(false);
            }}
            className="btn btn-quiet btn-sm -ml-3 text-mute"
          >
            Don’t show again
          </button>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="btn btn-ghost btn-sm"
          >
            Close
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
