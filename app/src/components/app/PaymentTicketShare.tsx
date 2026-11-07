"use client";

/**
 * Share a Gloam payment ticket, not a wallet address.
 * QR is generated locally so the ticket never hits a third-party API.
 *
 * Two shapes: a claim link (code, copy, download, share) and a Gloam address
 * (`gloamr1.`), where the parent already shows the address and its copy button,
 * so this adds the scannable QR plus download and share.
 */

import { useEffect, useState } from "react";
import { useNetwork } from "@/components/app/NetworkProvider";
import { appClaimPath, claimLinkFor, shortCodeFor } from "@/lib/claimLink";
import { isClaimLink } from "@/lib/funnel";

export function PaymentTicketShare({
  code,
  amountLabel,
  locked,
  stacked = false,
  onSaved,
}: {
  code: string;
  amountLabel?: string | null;
  locked: boolean;
  /** QR above the text, for narrow spots like the success dialog. */
  stacked?: boolean;
  /** Called once the code is copied, downloaded or shared. */
  onSaved?: () => void;
}) {
  const [copied, setCopied] = useState(false);
  // The QR made for one text; a QR for an earlier code never shows for a new one.
  const [qr, setQr] = useState<{ text: string; url: string | null; error: string | null } | null>(null);
  const [shared, setShared] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);
  const { networkKey } = useNetwork();
  const isAddr = code.startsWith("gloamr1.");
  // A tappable link: plain claim codes open the claim page, anything else opens the app's claim screen.
  const origin = typeof window === "undefined" ? "https://www.gloam.trade" : window.location.origin;
  const link = isAddr ? null : isClaimLink(code) ? claimLinkFor(code, networkKey, origin) : `${origin}${appClaimPath(code, networkKey)}`;
  // The code people see and copy: the short gloam3 form when the payment has a
  // short link (the same body), else the full code. Both paste back in Claim.
  const shown = isAddr ? code : shortCodeFor(code, networkKey);

  const qrText = link ?? shown;
  const qrDataUrl = qr?.text === qrText ? qr.url : null;
  const qrError = qr?.text === qrText ? qr.error : null;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const QR = await import("qrcode");
        const url = await QR.toDataURL(qrText, {
          margin: 2,
          width: 240,
          errorCorrectionLevel: "M",
          color: { dark: "#0a0a0a", light: "#ffffff" },
        });
        if (!cancelled) setQr({ text: qrText, url, error: null });
      } catch {
        if (!cancelled) {
          setQr({ text: qrText, url: null, error: "QR code not available. Copy the code instead." });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [qrText]);

  async function copyLink() {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      onSaved?.();
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 2000);
    } catch {
      /* parent may surface */
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(shown);
      onSaved?.();
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* parent may surface */
    }
  }

  function downloadTxt() {
    const blob = new Blob([shown], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `gloam-ticket-${amountLabel?.replace(/\s/g, "") ?? "pay"}.txt`;
    a.click();
    URL.revokeObjectURL(url);
    onSaved?.();
  }

  async function nativeShare() {
    if (!navigator.share) return;
    try {
      await navigator.share({
        title: "Gloam payment",
        text: code.startsWith("gloamr1.")
          ? `My Gloam address. Paste it in Gloam under Pay privately to send me money.\n\n${code}`
          : locked
          ? `I sent you a private payment on Gloam${amountLabel ? ` (${amountLabel})` : ""}. It's locked: I'll send you the phrase separately. Tap to claim it:\n\n${link ?? shown}`
          : `I sent you a private payment on Gloam${amountLabel ? ` (${amountLabel})` : ""}. Tap to claim it:\n\n${link ?? shown}`,
      });
      onSaved?.();
      setShared(true);
      setTimeout(() => setShared(false), 2000);
    } catch {
      /* user cancelled */
    }
  }

  const canShare =
    typeof navigator !== "undefined" && typeof navigator.share === "function";
  const isAddress = code.startsWith("gloamr1.");

  return (
    <div className="gl-tile p-[16px] sm:p-5">
      <div className={stacked ? "flex flex-col items-center gap-4" : "flex gap-5 max-sm:flex-col max-sm:items-center"}>
        {qrDataUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={qrDataUrl}
            alt={isAddress ? "QR code for your Gloam address" : "Payment QR code"}
            width={136}
            height={136}
            className="h-[136px] w-[136px] shrink-0 rounded-[14px] shadow-card"
          />
        ) : (
          <div className="grid h-[136px] w-[136px] shrink-0 place-items-center rounded-[14px] bg-panel px-3 text-center text-[11px] leading-snug text-mute">
            {qrError ?? "Making QR…"}
          </div>
        )}

        <div className={stacked ? "w-full min-w-0" : "min-w-0 flex-1 max-sm:w-full"}>
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-[15px] font-medium text-foreground">
              {isAddress ? "Scan to pay privately" : "Claim link ready"}
              {amountLabel ? (
                <span className="tnum font-normal text-mute">, {amountLabel}</span>
              ) : null}
            </p>
            {locked && (
              <span className="inline-flex items-center gap-1 rounded-full bg-sealed-soft px-2 py-0.5 text-[11.5px] font-medium text-sealed">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" aria-hidden>
                  <rect x="4" y="10.5" width="16" height="10" rx="2.2" fill="currentColor" />
                  <path d="M8 10.5V7a4 4 0 0 1 8 0v3.5" stroke="currentColor" strokeWidth="2" />
                </svg>
                Locked
              </span>
            )}
          </div>
          <p className="mt-1 text-[13px] leading-relaxed text-mute">
            {isAddress ? (
              <>
                Anyone on Gloam can scan this to pay you privately. It is not a
                public wallet address.
              </>
            ) : (
              <>
                Send the link any way you like: a message, AirDrop or this QR code.
                They tap it and claim in Gloam.
                {locked
                  ? " It is locked, so only the right phrase opens it."
                  : " Anyone with this link can claim it, so treat it like cash."}
              </>
            )}
          </p>

          {!isAddress && (
            <div className="tnum mt-3 max-h-24 overflow-y-auto break-all rounded-xl bg-panel px-3 py-2.5 text-[12px] leading-relaxed text-mute">
              {shown}
            </div>
          )}

          <div className="mt-3 flex flex-wrap gap-2">
            {link && (
              <button
                type="button"
                onClick={() => void copyLink()}
                className="btn btn-ink btn-sm"
                aria-live="polite"
              >
                {linkCopied ? "Copied" : "Copy link"}
              </button>
            )}
            {!isAddress && (
              <button
                type="button"
                onClick={() => void copy()}
                className="btn btn-ghost btn-sm"
                aria-live="polite"
              >
                {copied ? "Copied" : "Copy code"}
              </button>
            )}
            <button type="button" onClick={downloadTxt} className="btn btn-ghost btn-sm">
              Download
            </button>
            {canShare && (
              <button
                type="button"
                onClick={() => void nativeShare()}
                className="btn btn-ghost btn-sm"
              >
                {shared ? "Shared" : "Share…"}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
