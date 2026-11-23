"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { useModalFocus } from "@/hooks/useModalFocus";
import { createPortal } from "react-dom";
import { motion, useReducedMotion } from "framer-motion";
import { payrollParts } from "@gloamtrade/sdk";
import { encodeProof, provePayrollTotal, type PayrollNote } from "@/lib/proofs";
import { payrollProofNotes, type PayrollBatch } from "@/lib/payroll";
import { formatAssetAmount } from "@/lib/shield";
import { track } from "@/lib/track";
import { SealDots } from "@/components/ui/SealDots";
import { SealedField } from "@/components/ui/SealedField";
import { CheckMark, ExpiryPicker, Notice, ShieldCheck, Spinner } from "../prove/ProofParts";
import { MAX_LINK_LENGTH, VERIFIER_MAX, expiresAtFor, longDate, verifierLabel, type ExpiryId } from "../prove/proofUtils";
import { TokenLogo } from "../TokenLogo";
import { ScheduleIcon } from "./scheduleUi";

/**
 * "Prove the total" for a finished payroll run: the employer shows someone
 * (their accountant, a tax office) a run of this many payments adding up to
 * exactly this much, paid out of their own balance, without showing any one
 * payment. It does not show who was paid (payments, not people). Made on this
 * device from the run's own records (lib/payroll payrollProofNotes), checked at
 * /verify.
 */

type Records = { kind: "loading" } | { kind: "ready"; notes: PayrollNote[]; failed: number } | { kind: "blocked"; why: string };

type Done = { token: string; verifier: string; expiresAt: number };

const FOR_EXAMPLES = ["My accountant", "Tax office", "Auditor"];

const noopSubscribe = () => () => {};

function payments(n: number) {
  return `${n.toLocaleString("en-US")} ${n === 1 ? "payment" : "payments"}`;
}

/** "24, 23 and 23" */
function listParts(sizes: number[]) {
  const s = sizes.map(String);
  return s.length < 2 ? s.join("") : `${s.slice(0, -1).join(", ")} and ${s[s.length - 1]}`;
}

export function ProveTotal({
  batch,
  symbol,
  logoId,
  networkLabel,
  onClose,
}: {
  batch: PayrollBatch;
  symbol: string;
  logoId: string;
  networkLabel: string;
  onClose: () => void;
}) {
  const ids = useId();
  const reduce = useReducedMotion();
  // Focus lands on the dialog itself: no ring on the close button, no keyboard popping up on a phone.
  const panelRef = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const mounted = useSyncExternalStore(noopSubscribe, () => true, () => false);
  const [records, setRecords] = useState<Records>({ kind: "loading" });
  const [verifier, setVerifier] = useState("");
  const [expiry, setExpiry] = useState<ExpiryId>("30d");
  const [busy, setBusy] = useState<{ part: number; of: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<Done | null>(null);

  const paidRows = batch.rows.filter((r) => r.status === "paid");
  const total = paidRows.reduce((s, r) => s + BigInt(r.amount), 0n);
  const count = paidRows.length;
  const sizes = payrollParts(count);
  const paidOn = new Date(batch.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

  useEffect(() => {
    let live = true;
    void payrollProofNotes(batch).then((r) => {
      if (!live) return;
      setRecords("blocker" in r ? { kind: "blocked", why: r.blocker } : { kind: "ready", notes: r.notes, failed: r.failed });
    });
    return () => {
      live = false;
    };
  }, [batch]);

  useModalFocus(dialog, onClose, { initial: panelRef });

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  const forLabel = verifierLabel(verifier);
  const canCreate = records.kind === "ready" && !busy && forLabel != null;

  async function create() {
    if (records.kind !== "ready" || !forLabel) return;
    setErr(null);
    setBusy({ part: 0, of: sizes.length });
    try {
      const p = await provePayrollTotal({
        chainId: batch.chainId,
        pool: batch.pool,
        asset: batch.asset,
        payments: records.notes,
        verifier: forLabel,
        expiresAt: expiresAtFor(expiry),
        onPart: (part, of) => setBusy({ part, of }),
      });
      setDone({ token: encodeProof(p), verifier: p.verifier, expiresAt: p.expiresAt });
      // How many and where, never the amounts, the names or who it is for.
      track("payroll_total_proof_created", { people: p.count, parts: p.parts.length, chainId: batch.chainId });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "";
      setErr(
        /reject|denied|cancel/i.test(msg)
          ? "Stopped before the proof was made. Nothing was shared."
          : msg || "Could not build the proof. Try again in a moment."
      );
    } finally {
      setBusy(null);
    }
  }

  if (!mounted) return null;

  return createPortal(
    <div
      ref={dialog}
      className="fixed inset-0 z-[200] flex items-end justify-center sm:items-center sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby={`${ids}-title`}
    >
      <motion.button
        type="button"
        tabIndex={-1}
        aria-hidden="true"
        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
        aria-label="Close"
        onClick={onClose}
        initial={reduce ? false : { opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.2 }}
      />
      <motion.div
        ref={panelRef}
        tabIndex={-1}
        className="relative z-[1] flex max-h-[min(92dvh,860px)] w-full max-w-[600px] flex-col overflow-hidden bg-panel shadow-pop outline-none max-sm:rounded-t-[22px] sm:rounded-[24px]"
        initial={reduce ? false : { opacity: 0, y: 14 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ type: "spring", stiffness: 420, damping: 36 }}
      >
        <header className="flex items-start justify-between gap-4 border-b border-line max-sm:px-5 pb-4 pt-5 sm:px-7 sm:pt-6">
          <div className="min-w-0">
            <p className="t-eyebrow">Prove the total</p>
            <h2
              id={`${ids}-title`}
              className="mt-1.5 truncate text-[22px] font-light leading-tight tracking-[-0.012em] text-foreground"
            >
              {batch.title}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="-mr-2 grid h-10 w-10 shrink-0 place-items-center rounded-full text-mute transition-colors hover:bg-surface hover:text-foreground"
          >
            <ScheduleIcon name="x" />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {done ? (
            <ShareCard
              token={done.token}
              total={total}
              count={count}
              symbol={symbol}
              asset={batch.asset}
              verifier={done.verifier}
              expiresAt={done.expiresAt}
              networkLabel={networkLabel}
              onEdit={() => setDone(null)}
            />
          ) : (
            <div className="space-y-6 max-sm:px-5 py-5 sm:px-7 sm:py-6">
              {/* the claim */}
              <section className="relative overflow-hidden rounded-[18px] bg-surface max-sm:p-5 sm:p-6">
                <SealedField tone="soft" />
                <div className="relative">
                  <p className="text-[13px] text-mute">The proof says</p>
                  <p className="tnum mt-2 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[28px] font-light leading-tight tracking-[-0.018em] text-foreground">
                    <span>Paid {formatAssetAmount(total, batch.asset)}</span>
                    <TokenLogo id={logoId} symbol={symbol} size={22} />
                    <span className="text-mute">{symbol}</span>
                  </p>
                  <p className="mt-1 text-[15px] text-soft">
                    in {payments(count)} from your balance, in a run on {paidOn}
                  </p>
                </div>
              </section>

              {/* what they see */}
              <section aria-label="What the proof shows">
                <dl className="divide-y divide-line border-y border-line text-[14px]">
                  {[
                    ["The total and the asset", "Shown"],
                    ["How many payments", "Shown"],
                    ["When the payments landed", "Shown"],
                    ["Who it is for", forLabel ?? "Not set yet"],
                  ].map(([k, v]) => (
                    <div key={k} className="flex min-h-11 items-center justify-between gap-3 py-2">
                      <dt className="text-mute">{k}</dt>
                      <dd className={`min-w-0 truncate text-right ${v === "Not set yet" ? "text-faint" : "text-foreground"}`}>{v}</dd>
                    </div>
                  ))}
                </dl>
                <ul className="mt-3 divide-y divide-line rounded-[14px] bg-surface px-4 text-[13.5px]">
                  {["Each payment's amount", "Who was paid", "Your wallet and your balance"].map((n) => (
                    <li key={n} className="flex min-h-11 items-center justify-between gap-3 py-2">
                      <span className="text-soft">{n}</span>
                      <SealDots n={5} className="shrink-0 text-foreground/45" label="Hidden" />
                    </li>
                  ))}
                </ul>
              </section>

              {records.kind === "blocked" ? (
                <Notice tone="warn">{records.why}</Notice>
              ) : (
                <>
                  {count === 1 && (
                    <Notice tone="warn">With one payment, the total is that payment. Whoever you show it to will see it.</Notice>
                  )}
                  {sizes.length > 1 && (
                    <p className="text-[13px] leading-relaxed text-mute">
                      One proof holds up to 32 payments, so this one is made in {sizes.length} parts of{" "}
                      {listParts(sizes)} payments, sealed together. Each part also shows its own subtotal.
                    </p>
                  )}
                  {records.kind === "ready" && records.failed > 0 && (
                    <p className="text-[13px] leading-relaxed text-mute">
                      {records.failed === 1 ? "One payment" : `${records.failed} payments`} failed and paid
                      nothing, so {records.failed === 1 ? "it is" : "they are"} not counted.
                    </p>
                  )}

                  <div>
                    <label htmlFor={`${ids}-for`} className="text-[13px] text-mute">
                      Who is this for?
                    </label>
                    <input
                      id={`${ids}-for`}
                      value={verifier}
                      maxLength={VERIFIER_MAX}
                      autoComplete="off"
                      onChange={(e) => setVerifier(e.target.value)}
                      placeholder="A name they will recognize"
                      aria-describedby={`${ids}-for-hint`}
                      className="gl-input mt-2"
                    />
                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      <span className="text-[12.5px] text-mute">For example</span>
                      {FOR_EXAMPLES.map((ex) => (
                        <button
                          key={ex}
                          type="button"
                          onClick={() => setVerifier(ex)}
                          className="inline-flex h-8 items-center rounded-full bg-surface px-3 text-[12.5px] text-soft transition-colors hover:bg-surface-2 hover:text-foreground"
                        >
                          {ex}
                        </button>
                      ))}
                    </div>
                    <p id={`${ids}-for-hint`} className="mt-2 text-[12.5px] leading-relaxed text-mute">
                      Their name goes into the proof. If they pass it on, it still shows who it was made for.
                    </p>
                  </div>

                  <ExpiryPicker value={expiry} onChange={setExpiry} />
                </>
              )}

              {err && <Notice tone="danger">{err}</Notice>}

              {busy ? (
                <Progress part={busy.part} of={busy.of} />
              ) : records.kind === "blocked" ? (
                <button type="button" onClick={onClose} className="btn btn-ghost btn-lg max-sm:w-full">
                  Close
                </button>
              ) : (
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                  <button
                    type="button"
                    onClick={() => void create()}
                    disabled={!canCreate}
                    className="btn btn-ink btn-lg max-sm:w-full"
                  >
                    {records.kind === "loading" ? <Spinner /> : <ShieldCheck className="h-4 w-4" />}
                    Create proof
                  </button>
                  {records.kind === "ready" && !forLabel && <span className="text-[13px] text-mute">Say who it is for</span>}
                </div>
              )}
            </div>
          )}
        </div>
      </motion.div>
    </div>,
    document.body
  );
}

/** The proving steps; each part of a large run ticks by on its own line. */
function Progress({ part, of }: { part: number; of: number }) {
  const steps =
    of > 1
      ? ["Getting the proving key ready", ...Array.from({ length: of }, (_, i) => `Proving part ${i + 1} of ${of}`)]
      : ["Getting the proving key ready", "Building your proof"];
  // The first step clears once the key is in, which the prover does not report: a beat, then on.
  const [keyReady, setKeyReady] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollIntoView({ block: "nearest" });
    const t = window.setTimeout(() => setKeyReady(true), 1800);
    return () => window.clearTimeout(t);
  }, []);
  const step = part > 0 ? part + 1 : keyReady ? 1 : 0;
  return (
    <div ref={ref} className="rounded-[16px] bg-surface p-4" role="status" aria-live="polite">
      <ul className="space-y-2.5">
        {steps.map((label, i) => {
          const isDone = i < step;
          const now = i === step;
          return (
            <li key={label} className="flex items-center gap-3 text-[14px]">
              <span
                className={`grid h-5 w-5 shrink-0 place-items-center rounded-full ${
                  isDone ? "bg-sealed-soft text-sealed" : now ? "text-foreground" : "text-faint"
                }`}
              >
                {isDone ? <CheckMark size={11} /> : now ? <Spinner /> : <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-current" />}
              </span>
              <span className={isDone ? "text-mute" : now ? "text-foreground" : "text-faint"}>
                {label}
                {now ? "…" : ""}
              </span>
            </li>
          );
        })}
      </ul>
      <p className="mt-3 border-t border-line pt-3 text-[12.5px] leading-relaxed text-mute">
        {of > 1 ? "Several seconds per part" : "Up to about fifteen seconds"}, longer the first time while the proving key
        loads. It runs on this device, and nothing leaves this browser.
      </p>
    </div>
  );
}

function ShareCard({
  token,
  total,
  count,
  symbol,
  asset,
  verifier,
  expiresAt,
  networkLabel,
  onEdit,
}: {
  token: string;
  total: bigint;
  count: number;
  symbol: string;
  asset: PayrollBatch["asset"];
  verifier: string;
  expiresAt: number;
  networkLabel: string;
  onEdit: () => void;
}) {
  const ids = useId();
  const [copied, setCopied] = useState<"proof" | "link" | null>(null);
  // The proof rides after `#`, so neither link ever sends it to a server. Long
  // runs make long proofs: the shareable link is offered only while it is short
  // enough to survive a chat app; opening the verifier here always works.
  const href = `/verify#proof=${encodeURIComponent(token)}`;
  const link = typeof window === "undefined" ? null : `${window.location.origin}${href}`;
  const shareable = link != null && link.length <= MAX_LINK_LENGTH;

  async function copy(what: "proof" | "link", value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(what);
      window.setTimeout(() => setCopied((c) => (c === what ? null : c)), 1500);
    } catch {
      /* clipboard unavailable */
    }
  }

  const rows = [
    { label: "For", value: verifier },
    { label: "Good until", value: longDate(expiresAt * 1000) },
    { label: "Network", value: networkLabel },
    { label: "Each payment", value: "Hidden" },
  ];

  return (
    <section aria-labelledby={`${ids}-title`}>
      <div className="relative overflow-hidden border-b border-line max-sm:p-5 sm:p-7">
        <SealedField tone="soft" />
        <div className="relative">
          <span className="inline-flex h-6 items-center gap-1.5 rounded-full bg-sealed-soft px-2.5 text-[12px] font-medium text-sealed">
            <ShieldCheck className="h-3.5 w-3.5" />
            Proof ready
          </span>
          <p
            id={`${ids}-title`}
            className="tnum mt-4 text-[26px] font-light leading-tight tracking-[-0.018em] text-foreground sm:text-[30px]"
          >
            {payments(count)} adding up to {formatAssetAmount(total, asset)} <span className="text-mute">{symbol}</span>
          </p>
          <dl className="mt-4 grid grid-cols-1 gap-x-8 gap-y-2 text-[13.5px] sm:grid-cols-2">
            {rows.map((r) => (
              <div key={r.label} className="flex min-w-0 items-baseline gap-2">
                <dt className="shrink-0 text-mute">{r.label}</dt>
                <dd className="min-w-0 truncate text-foreground">{r.value}</dd>
              </div>
            ))}
          </dl>
        </div>
      </div>

      <div className="bg-surface/50 max-sm:p-5 sm:p-7">
        <label htmlFor={`${ids}-token`} className="text-[13px] text-mute">
          Your proof. Send it to them however you like.
        </label>
        <textarea
          id={`${ids}-token`}
          readOnly
          value={token}
          rows={3}
          onFocus={(e) => e.currentTarget.select()}
          className="gl-input tnum mt-2 h-auto resize-none break-all py-3 text-[12px] leading-relaxed text-soft"
        />
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button type="button" onClick={() => void copy("proof", token)} className="btn btn-ink btn-sm h-10">
            {copied === "proof" ? <CheckMark /> : null}
            <span aria-live="polite">{copied === "proof" ? "Copied" : "Copy proof"}</span>
          </button>
          {shareable && (
            <button type="button" onClick={() => void copy("link", link!)} className="btn btn-quiet btn-sm h-10">
              {copied === "link" ? <CheckMark /> : null}
              <span aria-live="polite">{copied === "link" ? "Link copied" : "Copy link"}</span>
            </button>
          )}
          <Link href={href} className="btn btn-quiet btn-sm h-10">
            Open the verifier
          </Link>
          <button type="button" onClick={onEdit} className="btn btn-quiet btn-sm h-10 text-mute sm:ml-auto">
            Make another
          </button>
        </div>
        <p className="mt-3 text-[12.5px] leading-relaxed text-mute">
          {shareable
            ? "The link opens the verifier with this proof filled in. It stays in the link, nothing is sent to Gloam."
            : "This proof is too long for a link. Copy it, and they can paste it at gloam.trade/verify."}{" "}
          It proves the total you paid out, not who was paid or that they work for you.
        </p>
      </div>
    </section>
  );
}
