"use client";

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { Mark } from "@/components/Logo";
import { useModalFocus } from "@/hooks/useModalFocus";
import { displayAmount } from "@/lib/amountShort";
import { shortAddress } from "@/lib/chain";
import { receiptNetworkOf, receiptNumber, receiptToken, type CashOutReceipt } from "@/lib/cashOutReceipt";
import type { BridgeMark } from "@/lib/cashOutBridge";

/**
 * A Gloam receipt for a cash out to a public wallet, the same sheet as the
 * payroll invoice. Every line is read from the transaction on chain
 * (lib/cashOutReceipt), so it says "Verified on-chain" and links to it.
 * Built in the browser, never stored by Gloam. "Download PDF" prints only the
 * sheet (the #gl-invoice print rules in globals.css).
 */
export function CashOutReceiptSheet({
  receipt,
  bridge,
  onClose,
}: {
  receipt: CashOutReceipt;
  /** Where a cross-chain cash out was bridging to, when this browser made it (lib/cashOutBridge). */
  bridge?: BridgeMark | null;
  onClose: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const number = receiptNumber(receipt);
  // links, testnet and the token are the receipt's own chain's, whatever the app shows now
  const net = receiptNetworkOf(receipt.chainId);
  const testnet = Boolean(net?.testnet);
  const explorerTx = (h: string) => net?.explorerTx(h) ?? "#";
  const explorerAddress = (a: string) => net?.explorerAddress(a) ?? "#";
  const { symbol, decimals } = receiptToken(receipt.chainId, receipt.asset);
  // two places, cut down and never rounded up, like every amount shown and the payroll invoice
  // (lib/amountShort); the transaction linked below has every unit
  const money = (raw: bigint) => `${displayAmount(raw, decimals)} ${symbol}`;
  const when = new Date(receipt.time);
  // the day in UTC, like the time beside it: a cash out at 23:43 UTC is that day everywhere
  const day = when.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
  const time = when.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", timeZone: "UTC", hour12: false });

  useModalFocus(dialog, onClose, { initial: closeRef });

  useEffect(() => {
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = "";
    };
  }, []);

  function downloadPdf() {
    // The browser names the PDF after the page title, so borrow the receipt number.
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
    <div ref={dialog} id="gl-invoice" className="fixed inset-0 z-[200] overflow-y-auto" role="dialog" aria-modal="true" aria-labelledby="gl-receipt-title">
      <button
        type="button"
        tabIndex={-1}
        aria-hidden="true"
        className="gl-invoice-backdrop fixed inset-0 bg-black/45 backdrop-blur-sm"
        aria-label="Close receipt"
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
                <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-mute">Receipt</p>
                <p className="tnum mt-1 text-[14px] text-foreground">{number}</p>
              </div>
            </header>

            <div className="mt-10 flex flex-wrap items-end justify-between gap-4 border-b border-line pb-7">
              <div className="min-w-0">
                <h2 id="gl-receipt-title" className="tnum text-[30px] font-light leading-[1.1] tracking-[-0.02em] sm:text-[38px]">
                  {money(receipt.delivered)}
                </h2>
                <p className="mt-2 text-[14px] text-mute">
                  Cash out on {day} at {time} UTC, {receipt.network}
                  {testnet ? " testnet" : ""}
                </p>
              </div>
              <span
                className="inline-flex h-8 items-center gap-1.5 rounded-full px-3.5 text-[13px] font-medium"
                style={{ background: "var(--sealed-soft)", color: "var(--sealed)" }}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden>
                  <path d="M5 12.5l4.2 4.2L19 7" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                Verified on-chain
              </span>
            </div>

            <dl className="grid grid-cols-2 gap-x-6 gap-y-5 border-b border-line py-7 sm:grid-cols-4">
              <Meta k="Sent from" v="Gloam vault" sub="A private balance" />
              {bridge ? (
                <Meta k="Sent to" v="Relay" sub={`Bridging to ${bridge.chain}`} />
              ) : (
                <Meta k="Sent to" v={shortAddress(receipt.to, 4)} sub="Public wallet" />
              )}
              <Meta k="Network" v={receipt.network} sub={testnet ? "Testnet" : "Mainnet"} />
              <Meta k="Currency" v={symbol} sub={receipt.network} />
            </dl>

            <dl className="divide-y divide-line border-b border-line text-[13.5px]">
              {bridge && (
                <Row k={`Lands on ${bridge.chain}`}>
                  <span className="tnum break-all">
                    {bridge.recipient}, as {bridge.symbol}
                  </span>
                </Row>
              )}
              <Row k={bridge ? "Relay address" : "Recipient wallet"}>
                <a
                  href={explorerAddress(receipt.to)}
                  target="_blank"
                  rel="noreferrer"
                  className="tnum break-all underline-offset-2 hover:underline"
                >
                  {receipt.to}
                </a>
              </Row>
              <Row k="Transaction">
                <a href={explorerTx(receipt.txHash)} target="_blank" rel="noreferrer" className="tnum break-all underline-offset-2 hover:underline">
                  {receipt.txHash}
                </a>
              </Row>
              <Row k="Block">
                <span className="tnum">{receipt.blockNumber.toLocaleString("en-US")}</span>
              </Row>
            </dl>

            <div className="mt-6 flex justify-end">
              <dl className="w-full max-w-[340px] text-[13.5px]">
                <div className="flex justify-between gap-4 py-1.5">
                  <dt className="text-mute">Cashed out</dt>
                  <dd className="tnum text-foreground">{money(receipt.amount)}</dd>
                </div>
                <div className="flex justify-between gap-4 py-1.5">
                  <dt className="text-mute">Cash-out fee</dt>
                  <dd className="tnum text-foreground">{receipt.fee > 0n ? money(receipt.fee) : "None"}</dd>
                </div>
                <div className="mt-2 flex items-baseline justify-between gap-4 border-t border-foreground/80 pt-3">
                  <dt className="text-[14px] text-foreground">{bridge ? "Paid to Relay" : "Received by the wallet"}</dt>
                  <dd className="tnum text-[22px] font-light tracking-[-0.015em] text-foreground">{money(receipt.delivered)}</dd>
                </div>
              </dl>
            </div>

            <div className="mt-9 rounded-[16px] bg-surface px-5 py-4 text-[13px] leading-relaxed text-soft">
              <p className="text-foreground">What this receipt shows</p>
              <p className="mt-1">
                A cash out from the Gloam vault is public: the amount, the wallet it went to and when. Every line here is
                read from that transaction, and anyone can check it with the link above. It doesn&apos;t show your
                private balance, your other payments or where the money came from.
              </p>
              {bridge && (
                <p className="mt-2">
                  Relay then delivered it on {bridge.chain}, minus its own fee. That part is on {bridge.chain}&apos;s explorer.
                </p>
              )}
              <p className="mt-2">Made in your browser from the public chain. Gloam does not keep a copy.</p>
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

function Row({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1 py-3 sm:grid-cols-[160px_minmax(0,1fr)] sm:gap-4">
      <dt className="text-mute">{k}</dt>
      <dd className="min-w-0 text-foreground">{children}</dd>
    </div>
  );
}
