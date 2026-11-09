"use client";

/**
 * Payment requests (lib/paymentRequest): the "Request a payment" card on
 * Receive, and the banner the payer sees when a request link opens Pay (or
 * Cash out, for a request to a 0x address or an ENS name).
 * A request is only a link. Nothing about it is posted on chain or sent to a
 * Gloam server; the payer checks the pre-filled form and presses send. The
 * note then travels sealed inside the payment (lib/paymentNote).
 */

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { getNetwork, networkName, type NetworkKey } from "@/lib/networks";
import { amountTextError } from "@/lib/amountText";
import { shortAddress } from "@/lib/chain";
import {
  REQUEST_NAME_MAX,
  REQUEST_NOTE_MAX,
  buildShortPaymentRequestLink,
  cleanRequestText,
  formatRequestAmount,
  isWalletRequest,
  normalizeRequestAmount,
  requestAssetsFor,
  type PaymentRequest,
  type RequestAsset,
} from "@/lib/paymentRequest";
import { isAddableToken, isNativeAddable, shieldTokensFor } from "@/lib/tokens";
import { useOpenGatedTokens } from "@/hooks/useOpenGatedTokens";
import { Select } from "@/components/ui/Select";
import { useNetwork } from "./NetworkProvider";
import { TokenLogo } from "./TokenLogo";

const PRIVACY_LINE =
  "This link stays between you and the person you send it to. Nothing about the request is public on chain.";

type Created = {
  url: string;
  net: NetworkKey;
  tag: string;
  /** "1,250 USDG" or "any amount of USDG" */
  label: string;
  note: string;
};

/** Receive → Request a payment: amount, token and note in, link + QR out. */
export function RequestPaymentCard({ tag }: { tag: string }) {
  const { network } = useNetwork();
  // An asset whose deposit limit has not landed (BDX, ETH on Robinhood Chain) can't be held privately yet, so it can't be asked for.
  const openGated = useOpenGatedTokens();
  const assets = useMemo(
    () => requestAssetsFor(network.key).filter((a) => (a.native ? isNativeAddable(network.chainId, openGated) : isAddableToken(network.chainId, a, openGated))),
    [network.key, network.chainId, openGated]
  );
  const [assetId, setAssetId] = useState("");
  const asset = assets.find((a) => a.id === assetId) ?? assets[0];
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [name, setName] = useState("");
  const [amountError, setAmountError] = useState<string | null>(null);
  const [created, setCreated] = useState<Created | null>(null);
  const amountRef = useRef<HTMLInputElement>(null);

  // A link made for another network or an old address is not shown.
  const live = created && created.net === network.key && created.tag === tag ? created : null;

  function onCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!asset) return;
    const r = normalizeRequestAmount(amount, asset);
    if ("error" in r) {
      setAmountError(r.error);
      setCreated(null);
      amountRef.current?.focus();
      return;
    }
    setAmountError(null);
    setCreated({
      url: buildShortPaymentRequestLink(
        { to: tag, network: network.key, asset, amount: r.value, note, name },
        window.location.origin
      ),
      net: network.key,
      tag,
      label: r.value ? `${formatRequestAmount(r.value)} ${asset.symbol}` : `any amount of ${asset.symbol}`,
      note: cleanRequestText(note, REQUEST_NOTE_MAX),
    });
    void import("@/lib/track").then(({ track }) => {
      track("payment_request_created");
    });
  }

  if (!asset) return null;
  // shown as they type, so "1,25" or "-1" is caught before the link is made
  const typedProblem = amountTextError(amount, asset.decimals);

  return (
    <div>
      <form onSubmit={onCreate} noValidate className="mt-3 space-y-4">
        <div>
          <label htmlFor="req-amount" className="text-[13px] text-mute">
            Amount <span className="text-faint">(optional)</span>
          </label>
          <div
            data-invalid={Boolean(amountError || typedProblem)}
            className="gl-inputcard mt-2 flex items-center gap-2 rounded-[16px] py-2 pl-4 pr-2"
          >
            <input
              ref={amountRef}
              id="req-amount"
              inputMode="decimal"
              autoComplete="off"
              value={amount}
              onChange={(e) => {
                setAmount(e.target.value);
                setAmountError(null);
                setCreated(null);
              }}
              placeholder="0"
              aria-invalid={amountError || typedProblem ? true : undefined}
              aria-describedby="req-amount-hint"
              className="tnum min-w-0 flex-1 bg-transparent text-[28px] font-light leading-[1.25] tracking-[-0.02em] text-foreground outline-none! placeholder:text-faint"
            />
            <AssetPicker
              assets={assets}
              value={asset}
              onChange={(id) => {
                setAssetId(id);
                setAmountError(null);
                setCreated(null);
              }}
            />
          </div>
          {amountError || typedProblem ? (
            <p id="req-amount-hint" role="alert" className="mt-2 text-[12.5px] leading-relaxed text-danger">
              {amountError ?? typedProblem}
            </p>
          ) : (
            <p id="req-amount-hint" className="mt-2 text-[12.5px] leading-relaxed text-mute">
              Leave it empty to let them choose how much.
            </p>
          )}
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="min-w-0">
            <label htmlFor="req-note" className="text-[13px] text-mute">
              Note <span className="text-faint">(optional)</span>
            </label>
            <input
              id="req-note"
              type="text"
              autoComplete="off"
              maxLength={REQUEST_NOTE_MAX}
              value={note}
              onChange={(e) => {
                setNote(e.target.value);
                setCreated(null);
              }}
              placeholder="e.g. Invoice 042"
              className="gl-input mt-2"
            />
          </div>
          <div className="min-w-0">
            <label htmlFor="req-name" className="text-[13px] text-mute">
              Your name <span className="text-faint">(optional)</span>
            </label>
            <input
              id="req-name"
              type="text"
              autoComplete="off"
              maxLength={REQUEST_NAME_MAX}
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setCreated(null);
              }}
              placeholder="Shown to them, like Robin"
              className="gl-input mt-2"
            />
          </div>
        </div>

        <button type="submit" className="btn btn-ink btn-lg btn-block">
          {live ? "Update request link" : "Create request link"}
        </button>
        <p className="flex items-start gap-2 text-[12.5px] leading-relaxed text-mute">
          <span className="mt-[3px] shrink-0 text-sealed" aria-hidden>
            <LockGlyph size={12} />
          </span>
          {PRIVACY_LINE}
        </p>
      </form>

      <div aria-live="polite">
        {live && <RequestLinkResult key={live.url} created={live} />}
      </div>
    </div>
  );
}

/** Token pill that opens the app's dropdown (same as Add). */
function AssetPicker({
  assets,
  value,
  onChange,
}: {
  assets: RequestAsset[];
  value: RequestAsset;
  onChange: (id: string) => void;
}) {
  const { network } = useNetwork();
  const names = useMemo(
    () => new Map(shieldTokensFor(network.chainId).map((t) => [t.id, t.name])),
    [network.chainId]
  );
  return (
    <Select
      variant="pill"
      align="end"
      className="shrink-0"
      label="Token to be paid in"
      value={value.id}
      onChange={onChange}
      options={assets.map((a) => ({
        value: a.id,
        label: a.symbol,
        description: a.native ? (a.symbol === "ETH" ? "Ether" : undefined) : names.get(a.id),
        icon: <AssetGlyph asset={a} size={28} />,
      }))}
    />
  );
}

function RequestLinkResult({ created }: { created: Created }) {
  const [qr, setQr] = useState<string | null>(null);
  const [qrFailed, setQrFailed] = useState(false);
  const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle");
  const [shared, setShared] = useState(false);
  const canShare = typeof navigator !== "undefined" && typeof navigator.share === "function";

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const QR = await import("qrcode");
        const data = await QR.toDataURL(created.url, {
          margin: 2,
          width: 336,
          errorCorrectionLevel: "M",
          color: { dark: "#0a0a0a", light: "#ffffff" },
        });
        if (!cancelled) setQr(data);
      } catch {
        if (!cancelled) setQrFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [created.url]);

  async function onCopy() {
    try {
      await navigator.clipboard.writeText(created.url);
      setCopy("copied");
    } catch {
      setCopy("failed");
    }
    window.setTimeout(() => setCopy("idle"), 2200);
  }

  async function onShare() {
    try {
      await navigator.share({
        title: "Gloam payment request",
        text: `Pay me ${created.label} privately on Gloam${created.note ? ` (${created.note})` : ""}. The link fills in my Gloam address.`,
        url: created.url,
      });
      setShared(true);
      window.setTimeout(() => setShared(false), 2000);
    } catch {
      /* cancelled */
    }
  }

  return (
    <div className="gl-tile mt-4 p-[16px] sm:p-5">
      <div className="flex gap-5 max-sm:flex-col max-sm:items-center">
        {qr ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={qr}
            alt="QR code for this payment request"
            width={168}
            height={168}
            className="h-[168px] w-[168px] shrink-0 rounded-[14px] shadow-card"
          />
        ) : (
          <div className="grid h-[168px] w-[168px] shrink-0 place-items-center rounded-[14px] bg-panel px-3 text-center text-[11px] leading-snug text-mute">
            {qrFailed ? "QR code not available. Copy the link instead." : "Making QR…"}
          </div>
        )}
        <div className="min-w-0 flex-1 max-sm:w-full">
          <p className="text-[15px] font-medium text-foreground">
            Request ready
            <span className="tnum font-normal text-mute">, {created.label}</span>
          </p>
          <p className="mt-1 text-[13px] leading-relaxed text-mute">
            Send it any way you like, or let them scan the code. Gloam fills in
            your address, the amount and your note. They check it and press send,
            and your note comes back sealed inside the payment.
          </p>
          <div className="tnum mt-3 max-h-24 overflow-y-auto break-all rounded-xl bg-panel px-3 py-2.5 text-[12px] leading-relaxed text-mute">
            {created.url}
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" onClick={() => void onCopy()} className="btn btn-ink btn-sm">
              {copy === "copied" ? "Copied" : "Copy link"}
            </button>
            {canShare && (
              <button type="button" onClick={() => void onShare()} className="btn btn-ghost btn-sm">
                {shared ? "Shared" : "Share…"}
              </button>
            )}
          </div>
          {copy === "failed" && (
            <p role="alert" className="mt-2 text-[12.5px] text-danger">
              Could not copy. Select the link above and copy it by hand.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Shown above Pay when a request link opened it. The name in a link is
 * whatever its maker typed, so it is only trusted when it matches a contact
 * the payer saved for that address. A partner's name shows only when the link
 * carries a live partner code, and it comes from the partner's Gloam account
 * (lib/partnerLinkClient), never from the link.
 */
export function PaymentRequestBanner({
  request,
  contactLabel,
  currentNetwork,
  onSwitchNetwork,
  onDismiss,
  balanceHint,
  partnerName = null,
}: {
  request: PaymentRequest;
  contactLabel: string | null;
  currentNetwork: NetworkKey;
  onSwitchNetwork: (key: NetworkKey) => void;
  onDismiss: () => void;
  /** e.g. no private balance in the requested token yet */
  balanceHint: { text: string; addHref?: string } | null;
  /** The partner whose live link code opened this, from their account. */
  partnerName?: string | null;
}) {
  const who = contactLabel ?? request.name;
  const amount = request.amount
    ? `${formatRequestAmount(request.amount)}${request.asset ? ` ${request.asset.symbol}` : ""}`
    : null;
  const wrongNet = request.network && request.network !== currentNetwork ? getNetwork(request.network) : null;
  // A 0x address or an ENS name is paid through Cash out (lib/paymentRequest).
  const toWallet = isWalletRequest(request);
  const walletLabel = request.to && request.toKind === "address" ? shortAddress(request.to) : request.to;

  return (
    <section
      aria-label="Payment request"
      className="mt-5 rounded-[16px] border border-line bg-surface p-4 sm:p-5"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="inline-flex items-center gap-1.5 text-[12px] font-medium text-mute">
            <span className="text-sealed" aria-hidden>
              <LockGlyph size={11} />
            </span>
            Payment request
            {contactLabel && (
              <span className="ml-1 rounded-full bg-sealed-soft px-2 py-0.5 text-[11px] text-sealed">
                Saved contact
              </span>
            )}
          </p>
          <p className="mt-1.5 break-words text-[17px] leading-snug text-foreground">
            {who ? <span className="font-medium">{who}</span> : "Someone"}{" "}
            {amount ? (
              <>
                asked for <span className="tnum font-medium">{amount}</span>
              </>
            ) : request.asset ? (
              <>asked to be paid in {request.asset.symbol}</>
            ) : (
              <>asked to be paid</>
            )}
            {toWallet && walletLabel && (
              <>
                {" "}to <span className="tnum font-medium" title={request.to ?? undefined}>{walletLabel}</span>
              </>
            )}
            {request.note && <span className="text-mute"> · {request.note}</span>}
          </p>
          {partnerName && <PartnerLine name={partnerName} />}
        </div>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Close payment request"
          className="-mr-1.5 -mt-1.5 grid h-10 w-10 shrink-0 place-items-center rounded-full text-mute transition-colors hover:bg-panel hover:text-foreground"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
            <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      <p className="mt-2 text-[12.5px] leading-relaxed text-mute">
        {PRIVACY_LINE}{" "}
        {!request.to
          ? "Nothing was filled in for the address, so you cannot pay this link as it is."
          : toWallet
            ? "Gloam pays this wallet from your private balance. With Hide my wallet on, the relay sends it, so your wallet does not show. The amount and their wallet are public, like any transfer. Check the details below, then press Cash out to this address."
            : "Check the details below, then press Send privately."}
      </p>

      {request.name && !contactLabel && request.to && (
        <p className="mt-2 text-[12.5px] leading-relaxed text-warn">
          The name comes from the link, not your contacts. Check the{" "}
          {toWallet ? "address" : "Gloam address"} with them before you pay.
        </p>
      )}

      {wrongNet && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-xl bg-panel px-3.5 py-2.5">
          <p className="text-[13px] text-foreground">This request is for {networkName(wrongNet)}.</p>
          <button
            type="button"
            onClick={() => onSwitchNetwork(wrongNet.key)}
            className="btn btn-ink btn-sm"
          >
            Switch to {networkName(wrongNet)}
          </button>
        </div>
      )}

      {!wrongNet && balanceHint && (
        <p className="mt-3 rounded-xl bg-panel px-3.5 py-2.5 text-[13px] leading-relaxed text-soft">
          {balanceHint.text}
          {balanceHint.addHref && (
            <>
              {" "}
              <Link
                href={balanceHint.addHref}
                className="font-medium text-foreground underline underline-offset-4"
              >
                Add money
              </Link>
            </>
          )}
        </p>
      )}

      {request.problems.length > 0 && (
        <ul role="alert" className="mt-3 space-y-1 rounded-xl bg-warn-soft px-3.5 py-2.5 text-[12.5px] leading-relaxed text-warn">
          {request.problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** "From Motion · Gloam partner": a partner's name from their account, for a link with their live code. */
export function PartnerLine({ name }: { name: string }) {
  return (
    <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13.5px] text-soft">
      <span className="break-words">
        From <span className="font-medium text-foreground">{name}</span>
      </span>
      <span className="rounded-full bg-sealed-soft px-2 py-0.5 text-[11px] text-sealed" title="This link carries a partner code Gloam issued to them.">
        Gloam partner
      </span>
    </p>
  );
}

function AssetGlyph({ asset, size }: { asset: RequestAsset; size: number }) {
  if (!asset.native) return <TokenLogo id={asset.id} symbol={asset.symbol} size={size} />;
  return (
    <span
      aria-hidden
      className="inline-grid shrink-0 place-items-center rounded-[30%] bg-ink text-on-ink"
      style={{ width: size, height: size }}
    >
      <svg width={size * 0.5} height={size * 0.5} viewBox="0 0 24 24" fill="none">
        <path d="M12 2.5l6 9.75-6 3.5-6-3.5 6-9.75z" fill="currentColor" />
        <path d="M6 13.6l6 3.5 6-3.5-6 8.4-6-8.4z" fill="currentColor" opacity="0.7" />
      </svg>
    </span>
  );
}

function LockGlyph({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="4.5" y="10.5" width="15" height="10" rx="2.5" stroke="currentColor" strokeWidth="2" />
      <path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
