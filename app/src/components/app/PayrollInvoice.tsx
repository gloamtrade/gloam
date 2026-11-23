"use client";

import { useEffect, useRef } from "react";
import { useModalFocus } from "@/hooks/useModalFocus";
import { createPortal } from "react-dom";
import { Mark } from "@/components/Logo";
import { shortAddress } from "@/lib/chain";
import { formatAssetAmount } from "@/lib/shield";
import type { PayrollBatch } from "@/lib/payroll";

/**
 * A Gloam invoice for a finished payroll run: who was paid, how much, and how
 * it went out. Built in the browser from the run itself, never stored by Gloam.
 * "Download PDF" prints only the sheet (see the print rules in globals.css).
 */
export function PayrollInvoice({
  batch,
  symbol,
  networkLabel,
  testnet,
  explorerTx,
  linkRefs,
  onClose,
}: {
  batch: PayrollBatch;
  symbol: string;
  networkLabel: string;
  testnet: boolean;
  explorerTx: (hash: string) => string;
  /** false when references are not real transactions (the recording demo). */
  linkRefs: boolean;
  onClose: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const number = invoiceNumber(batch);
  const paid = batch.rows.filter((r) => r.status === "paid");
  const total = paid.reduce((s, r) => s + BigInt(r.amount), 0n);
  const issued = new Date(batch.createdAt).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
  // Two places, cut down and never rounded up, as every amount shows (lib/amountShort).
  // The results CSV keeps every unit.
  const money = (raw: bigint | string) => `${formatAssetAmount(raw, batch.asset)} ${symbol}`;

  useModalFocus(dialog, onClose, { initial: closeRef });

  useEffect(() => {
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = "";
    };
  }, []);

  function downloadPdf() {
    // The browser names the PDF after the page title, so borrow the invoice number.
    const title = document.title;
    document.title = `Gloam ${number}`;
    const restore = () => {
      document.title = title;
      window.removeEventListener("afterprint", restore);
    };
    window.addEventListener("afterprint", restore);
    window.print();
  }

  return createPortal(
    <div
      ref={dialog}
      id="gl-invoice"
      className="fixed inset-0 z-[200] overflow-y-auto"
      role="dialog"
      aria-modal="true"
      aria-labelledby="gl-invoice-title"
    >
      <button
        type="button"
        tabIndex={-1}
        aria-hidden="true"
        className="gl-invoice-backdrop fixed inset-0 bg-black/45 backdrop-blur-sm"
        aria-label="Close invoice"
        onClick={onClose}
      />

      <div className="relative z-[1] mx-auto flex min-h-full max-w-[820px] flex-col px-4 py-6 sm:py-10">
        <div className="gl-invoice-actions mb-3 flex items-center justify-end gap-2">
          <button type="button" onClick={downloadPdf} className="btn btn-ink btn-sm h-10">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
              <path
                d="M12 4v11M7.5 10.5L12 15l4.5-4.5M5 17v1a2 2 0 002 2h10a2 2 0 002-2v-1"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            Download PDF
          </button>
          <button ref={closeRef} type="button" onClick={onClose} className="btn btn-ghost btn-sm h-10 bg-panel">
            Close
          </button>
        </div>

        <article className="gl-invoice-sheet theme-light relative overflow-hidden rounded-[22px] bg-background text-foreground shadow-pop">
          {/* the green glint, the one bit of colour on the page */}
          <div
            aria-hidden
            className="pointer-events-none absolute -right-24 -top-28 h-72 w-72 rounded-full opacity-70 blur-3xl"
            style={{ background: "radial-gradient(closest-side, var(--sealed-soft), transparent)" }}
          />

          <div className="relative px-6 pb-8 pt-7 sm:px-12 sm:pb-12 sm:pt-11">
            <header className="flex items-start justify-between gap-6">
              <div className="flex items-center gap-2.5">
                <Mark size={30} />
                <span className="text-[20px] font-medium tracking-[-0.015em]">Gloam</span>
              </div>
              <div className="text-right">
                <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-mute">Invoice</p>
                <p className="tnum mt-1 text-[14px] text-foreground">{number}</p>
              </div>
            </header>

            <div className="mt-10 flex flex-wrap items-end justify-between gap-4 border-b border-line pb-7">
              <div className="min-w-0">
                <h2 id="gl-invoice-title" className="text-[30px] font-light leading-[1.1] tracking-[-0.02em] sm:text-[38px]">
                  {batch.title}
                </h2>
                <p className="mt-2 text-[14px] text-mute">
                  Issued {issued}, {networkLabel}
                  {testnet ? " testnet" : ""}
                </p>
              </div>
              <span
                className="inline-flex h-8 items-center gap-1.5 rounded-full px-3.5 text-[13px] font-medium"
                style={{ background: "var(--sealed-soft)", color: "var(--sealed)" }}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden>
                  <rect x="5" y="10.5" width="14" height="10" rx="2.5" stroke="currentColor" strokeWidth="1.8" />
                  <path d="M8.5 10.5V8a3.5 3.5 0 017 0v2.5" stroke="currentColor" strokeWidth="1.8" />
                </svg>
                Paid privately
              </span>
            </div>

            <dl className="grid grid-cols-2 gap-x-6 gap-y-5 border-b border-line py-7 sm:grid-cols-4">
              <Meta k="Paid by" v={shortAddress(batch.employer, 4)} sub="Employer wallet" />
              <Meta
                k="Sent through"
                v={batch.relay ? "Gloam relay" : "Your wallet"}
                sub={batch.relay ? "Wallet hidden" : "Wallet visible"}
              />
              <Meta k="Paid to" v={`${paid.length} ${paid.length === 1 ? "person" : "people"}`} sub="Team payroll" />
              <Meta k="Currency" v={symbol} sub={networkLabel} />
            </dl>

            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px] text-left text-[13.5px]">
                <thead>
                  <tr className="border-b border-line text-[11px] uppercase tracking-[0.14em] text-mute">
                    <th className="py-3 pr-4 font-medium">Payee</th>
                    <th className="py-3 pr-4 font-medium">Delivered to</th>
                    <th className="py-3 pr-4 font-medium">Reference</th>
                    <th className="py-3 text-right font-medium">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {paid.map((r) => (
                    <tr key={r.id} className="border-b border-line align-top">
                      <td className="py-3.5 pr-4 text-foreground">
                        {r.name}
                        {r.note && <span className="block break-words text-[12px] text-mute">{r.note}</span>}
                      </td>
                      <td className="py-3.5 pr-4 text-soft">
                        {r.kind === "gloam" ? (
                          <>
                            Gloam address
                            <span className="tnum block text-[12px] text-mute">{shortTag(r.recipient)}</span>
                          </>
                        ) : (
                          <>
                            Claim link
                            <span className="block text-[12px] text-mute">Shared by you</span>
                          </>
                        )}
                      </td>
                      <td className="tnum py-3.5 pr-4 text-mute">
                        {r.txHash ? (
                          linkRefs ? (
                            <a
                              href={explorerTx(r.txHash)}
                              target="_blank"
                              rel="noreferrer"
                              className="underline-offset-2 hover:text-foreground hover:underline"
                            >
                              {shortAddress(r.txHash, 4)}
                            </a>
                          ) : (
                            shortAddress(r.txHash, 4)
                          )
                        ) : (
                          "Private transfer"
                        )}
                      </td>
                      <td className="tnum py-3.5 text-right text-foreground">{money(r.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="mt-6 flex justify-end">
              <dl className="w-full max-w-[320px] text-[13.5px]">
                <div className="flex justify-between gap-4 py-1.5">
                  <dt className="text-mute">Subtotal</dt>
                  <dd className="tnum text-foreground">{money(total)}</dd>
                </div>
                <div className="flex justify-between gap-4 py-1.5">
                  <dt className="text-mute">Network fees</dt>
                  <dd className="text-foreground">{batch.relay ? "Covered by Gloam" : "Paid by your wallet"}</dd>
                </div>
                <div className="mt-2 flex items-baseline justify-between gap-4 border-t border-foreground/80 pt-3">
                  <dt className="text-[14px] text-foreground">Total paid</dt>
                  <dd className="tnum text-[22px] font-light tracking-[-0.015em] text-foreground">{money(total)}</dd>
                </div>
              </dl>
            </div>

            <div className="mt-9 rounded-[16px] bg-surface px-5 py-4 text-[13px] leading-relaxed text-soft">
              <p className="text-foreground">What the public chain shows</p>
              <p className="mt-1">
                {paid.length} private {paid.length === 1 ? "transfer" : "transfers"}, with no names and no amounts
                {batch.relay ? ", sent by Gloam so your wallet never appears next to them" : ""}. Only you hold
                this invoice: it is made in your browser and Gloam does not keep a copy.
              </p>
            </div>

            <footer className="mt-10 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-5 text-[12px] text-mute">
              <span>Gloam, private money on public chains</span>
              <span>gloam.trade</span>
            </footer>
          </div>
        </article>
      </div>
    </div>,
    document.body
  );
}

function Meta({ k, v, sub }: { k: string; v: string; sub: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-medium uppercase tracking-[0.14em] text-mute">{k}</dt>
      <dd className="tnum mt-1.5 truncate text-[14.5px] text-foreground">{v}</dd>
      <dd className="mt-0.5 truncate text-[12px] text-mute">{sub}</dd>
    </div>
  );
}

/** INV-20261003-8F2A: the run's date plus the tail of its id. */
function invoiceNumber(b: PayrollBatch) {
  const d = new Date(b.createdAt);
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  const tail = b.id.replace(/[^a-zA-Z0-9]/g, "").slice(-4).toUpperCase();
  return `INV-${ymd}-${tail}`;
}

function shortTag(tag: string) {
  return tag.length > 24 ? `${tag.slice(0, 13)}…${tag.slice(-5)}` : tag;
}
