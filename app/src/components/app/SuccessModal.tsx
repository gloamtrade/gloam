"use client";

import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { useModalFocus } from "@/hooks/useModalFocus";
import { createPortal } from "react-dom";
import Link from "next/link";
import { motion, useReducedMotion } from "framer-motion";
import { SealedField } from "@/components/ui/SealedField";

const noopSubscribe = () => () => {};

/** The check, drawn in once. */
function SuccessCheck({ size, weight, still }: { size: number; weight: number; still: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <motion.path
        d="M5 12.5l4.5 4.5L19 7"
        stroke="currentColor"
        strokeWidth={weight}
        strokeLinecap="round"
        strokeLinejoin="round"
        initial={still ? false : { pathLength: 0 }}
        animate={{ pathLength: 1 }}
        transition={{
          duration: 0.45,
          delay: 0.14,
          ease: [0.22, 1, 0.36, 1],
        }}
      />
    </svg>
  );
}

/**
 * The receipt itself: one green check, what happened, a line or two under it.
 * SuccessModal puts it in a dialog of its own; a sheet that is already open
 * puts it in place. `logo` sets the check on the token's own mark, and `amount`
 * makes the amount the big line, with the title as its label.
 */
export function SuccessReceipt({
  title,
  titleId = "success-title",
  body,
  logo,
  amount,
  detail,
}: {
  title: string;
  titleId?: string;
  body: React.ReactNode;
  logo?: React.ReactNode;
  amount?: React.ReactNode;
  /** Full-width content under the message (e.g. a claim code to save). */
  detail?: React.ReactNode;
}) {
  const still = Boolean(useReducedMotion());
  return (
    <>
      <motion.div
        className={
          logo
            ? "relative mx-auto h-14 w-14"
            : "mx-auto grid h-14 w-14 place-items-center rounded-full bg-sealed-soft text-sealed"
        }
        initial={still ? false : { scale: 0.7, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{
          type: "spring",
          stiffness: 420,
          damping: 22,
          delay: 0.04,
        }}
      >
        {logo ? (
          <>
            {logo}
            <span className="absolute -bottom-1 -right-1 grid h-6 w-6 place-items-center rounded-full bg-sealed text-panel ring-2 ring-panel">
              <SuccessCheck size={14} weight={2.6} still={still} />
            </span>
          </>
        ) : (
          <SuccessCheck size={26} weight={2} still={still} />
        )}
      </motion.div>

      {amount ? (
        <>
          <h2 id={titleId} className="mt-6 text-[13.5px] font-medium text-sealed">
            {title}
          </h2>
          <p className="tnum mt-2 text-[34px] font-light leading-[1.1] tracking-[-0.022em] text-foreground sm:text-[40px]">
            {amount}
          </p>
        </>
      ) : (
        <>
          <p className="t-eyebrow mt-6">Confirmed</p>
          <h2
            id={titleId}
            className="mt-2 text-balance text-[28px] font-light leading-[1.12] tracking-[-0.018em] text-foreground"
          >
            {title}
          </h2>
        </>
      )}
      <div className="mx-auto mt-3 max-w-[34ch] text-[14px] leading-relaxed text-mute">
        {body}
      </div>
      {detail && <div className="mt-5 text-left">{detail}</div>}
    </>
  );
}

/**
 * Success dialog portaled to document.body so AppShell `.rise` transforms
 * cannot pin fixed positioning mid-page. A calm receipt: the sealed field glows
 * in the corner, one green check says it is done.
 */
export function SuccessModal({
  open,
  title,
  body,
  primaryHref,
  primaryLabel,
  secondaryLabel = "Done",
  footer,
  detail,
  hold,
  onClose,
}: {
  open: boolean;
  title: string;
  body: React.ReactNode;
  primaryHref?: string;
  primaryLabel?: string;
  secondaryLabel?: string;
  /** Optional extra step under the actions (e.g. sharing a private payment). */
  footer?: React.ReactNode;
  /** Full-width content between the message and the buttons (e.g. a claim code to save). */
  detail?: React.ReactNode;
  /** While set, the dialog cannot be closed and the close button shows this instead. */
  hold?: string | null;
  onClose: () => void;
}) {
  // nothing closes the dialog while something on it must be done first
  const close = useCallback(() => {
    if (!hold) onClose();
  }, [hold, onClose]);
  const reduce = useReducedMotion();
  // Portals need document.body, so render only on the client.
  const mounted = useSyncExternalStore(noopSubscribe, () => true, () => false);

  const dialog = useRef<HTMLDivElement>(null);
  useModalFocus(dialog, close, { open: open && mounted });

  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  if (!open || !mounted) return null;

  const external =
    primaryHref?.startsWith("http") || primaryHref?.startsWith("https");

  return createPortal(
    <div
      ref={dialog}
      tabIndex={-1}
      className="fixed inset-0 z-[200] flex items-center justify-center p-[16px] outline-none sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="success-title"
    >
      <motion.button
        type="button"
        tabIndex={-1}
        aria-hidden="true"
        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
        aria-label="Close"
        onClick={close}
        initial={reduce ? false : { opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.2 }}
      />
      <motion.div
        className="relative z-[1] w-full max-w-[400px] overflow-hidden rounded-[24px] bg-panel shadow-pop"
        initial={reduce ? false : { opacity: 0, y: 8, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ type: "spring", stiffness: 420, damping: 34 }}
      >
        <SealedField tone="soft" />
        <div className="relative max-h-[min(88dvh,680px)] overflow-y-auto overflow-x-hidden px-6 pb-6 pt-9 text-center sm:px-8 sm:pb-8">
          <SuccessReceipt title={title} body={body} detail={detail} />

          <div className="mt-8 flex gap-2 max-sm:flex-col">
            {primaryHref &&
              primaryLabel &&
              (external ? (
                <a
                  href={primaryHref}
                  target="_blank"
                  rel="noreferrer"
                  className="btn btn-ink sm:flex-1"
                >
                  {primaryLabel}
                </a>
              ) : (
                <Link href={primaryHref} onClick={close} className="btn btn-ink sm:flex-1">
                  {primaryLabel}
                </Link>
              ))}
            <button type="button" onClick={close} disabled={Boolean(hold)} className="btn btn-ghost sm:flex-1">
              {hold ?? secondaryLabel}
            </button>
          </div>
          {footer && <div className="mt-6 border-t border-line pt-5">{footer}</div>}
        </div>
      </motion.div>
    </div>,
    document.body
  );
}
