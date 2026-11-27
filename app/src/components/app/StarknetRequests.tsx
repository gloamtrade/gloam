"use client";

/**
 * Payment requests on Starknet (lib/starknetPrivacy/requestLink), drawn like
 * Solana's (SolanaRequestCard, SolanaRequestBanner):
 *
 *  - StarknetRequestCard: Receive's "Request a payment". A link with this
 *    private account, an amount or none, a note and a name; the link, its QR
 *    (made here, never by a third party), Copy link and Share.
 *  - useStarknetRequestInHash: the request a "#snreq=" link put in the address
 *    bar, read for Pay on this network.
 *  - StarknetRequestBanner: the line Pay shows when a request link filled it.
 *    The name is what the link says, never trusted on its own. Starknet
 *    payments carry no note, so the note stays with the payer. A first payment
 *    to someone shows their private account: the banner says so when it is
 *    one (read like payroll reads it), and says it may when that can't be read.
 *  - StarknetRequestLead: above the open-your-account card when a request
 *    link brought someone here before their account was open.
 */
import { useEffect, useState } from "react";
import { readAmountText } from "@/lib/amountText";
import type { StarknetNetwork, StarknetToken } from "@/lib/starknetPrivacy/config";
import type { Reach } from "@/lib/starknetPrivacy/payroll";
import {
  STARKNET_REQUEST_NAME_MAX,
  STARKNET_REQUEST_NOTE_MAX,
  encodeStarknetRequest,
  starknetRequestForPay,
  starknetRequestLinkUrl,
  type StarknetRequest,
  type StarknetRequestOnPay,
} from "@/lib/starknetPrivacy/requestLink";
import { LockGlyph } from "./SolanaParts";
import { TokenLogo } from "./TokenLogo";
import { parseStarkAmount, shortStark, useStarknet } from "./StarknetAccount";
import { STARKNET_NAME, starkAmount } from "./StarknetParts";

const U64_MAX = (1n << 64n) - 1n;

const amountLabel = (amount: bigint, token: StarknetToken) => `${starkAmount(amount, token)} ${token.symbol}`;

// ---------------------------------------------------------------- the link to send

function StarknetRequestShare({ url, label }: { url: string; label: string }) {
  const [qr, setQr] = useState<{ url: string; data: string | null } | null>(null);
  const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle");
  const [shared, setShared] = useState(false);
  const canShare = typeof navigator !== "undefined" && typeof navigator.share === "function";
  const data = qr?.url === url ? qr.data : undefined;

  useEffect(() => {
    let live = true;
    void import("qrcode")
      .then((QR) => QR.toDataURL(url, { margin: 2, width: 272, errorCorrectionLevel: "M", color: { dark: "#0a0a0a", light: "#ffffff" } }))
      .then((d) => live && setQr({ url, data: d }))
      .catch(() => live && setQr({ url, data: null }));
    return () => {
      live = false;
    };
  }, [url]);

  async function onCopy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopy("copied");
    } catch {
      setCopy("failed");
    }
    window.setTimeout(() => setCopy("idle"), 2000);
  }

  async function onShare() {
    try {
      await navigator.share({ title: "Gloam payment request", text: `Pay me ${label} privately on Gloam, on Starknet. The link fills in my private account.`, url });
      setShared(true);
      window.setTimeout(() => setShared(false), 2000);
    } catch {
      /* cancelled */
    }
  }

  return (
    <div className="gl-tile p-[16px] text-left sm:p-5">
      <div className="flex gap-5 max-sm:flex-col max-sm:items-center">
        {data ? (
          // eslint-disable-next-line @next/next/no-img-element -- made here, never by a third party
          <img src={data} alt="QR code for this payment request" width={136} height={136} className="h-[136px] w-[136px] shrink-0 rounded-[14px] shadow-card" />
        ) : (
          <div className="grid h-[136px] w-[136px] shrink-0 place-items-center rounded-[14px] bg-panel px-3 text-center text-[11px] leading-snug text-mute">
            {data === null ? "QR code not available. Copy the link instead." : "Making QR..."}
          </div>
        )}
        <div className="min-w-0 flex-1 max-sm:w-full">
          <p className="text-[15px] font-medium text-foreground">
            Request ready<span className="tnum font-normal text-mute">, {label}</span>
          </p>
          <p className="mt-1 text-[13px] leading-relaxed text-mute">Send it any way you like. Gloam fills in your private account and the amount. They check it and press Pay.</p>
          <div className="tnum mt-3 max-h-24 overflow-y-auto break-all rounded-xl bg-panel px-3 py-2.5 text-[12px] leading-relaxed text-mute">{url}</div>
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" onClick={() => void onCopy()} className="btn btn-ink btn-sm h-10" aria-live="polite">
              {copy === "copied" ? "Copied" : "Copy link"}
            </button>
            {canShare && (
              <button type="button" onClick={() => void onShare()} className="btn btn-ghost btn-sm h-10">
                {shared ? "Shared" : "Share..."}
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

// ---------------------------------------------------------------- Receive: Request a payment

export function StarknetRequestCard({ token }: { token: StarknetToken }) {
  const sn = useStarknet()!;
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [made, setMade] = useState<{ url: string; label: string; to: string } | null>(null);
  const to = sn.address;
  const live = made && made.to === to ? made : null;
  const typed = readAmountText(amount, token.decimals);
  const typedProblem = typed.ok ? null : typed.error;

  function onCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!to) return;
    if (!typed.ok) {
      setError(typed.error);
      setMade(null);
      return;
    }
    const value = typed.text ? parseStarkAmount(typed.text, token.decimals) : null;
    if (typed.text && (value === null || value > U64_MAX)) {
      setError(value === null ? "Enter an amount above zero, or leave it empty." : "That amount is too large.");
      setMade(null);
      return;
    }
    const request: StarknetRequest = { network: sn.network, to, token: 0, amount: value, note, name };
    try {
      const body = encodeStarknetRequest(request);
      setError(null);
      setMade({ url: starknetRequestLinkUrl(body, window.location.origin), label: value !== null ? amountLabel(value, token) : `any amount of ${token.symbol}`, to });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't make the link.");
      setMade(null);
    }
  }

  const shown = error ?? typedProblem;
  return (
    <div>
      <form onSubmit={onCreate} noValidate className="mt-3 space-y-4">
        <div>
          <label htmlFor="sn-req-amount" className="text-[13px] text-mute">
            Amount <span className="text-faint">(optional)</span>
          </label>
          <div data-invalid={Boolean(shown) || undefined} className="gl-inputcard mt-2 flex items-center gap-2 rounded-[16px] py-2 pl-4 pr-2">
            <input
              id="sn-req-amount"
              inputMode="decimal"
              autoComplete="off"
              value={amount}
              onChange={(e) => {
                setAmount(e.target.value);
                setError(null);
                setMade(null);
              }}
              placeholder="0"
              aria-invalid={shown ? true : undefined}
              aria-describedby="sn-req-amount-hint"
              className="tnum min-w-0 flex-1 bg-transparent text-[28px] font-light leading-[1.25] tracking-[-0.02em] text-foreground outline-none! placeholder:text-faint"
            />
            <span className="flex h-10 shrink-0 items-center gap-2 rounded-full bg-surface pl-1.5 pr-3.5 text-[14px] text-foreground">
              <TokenLogo id="usdc" symbol={token.symbol} size={26} />
              {token.symbol}
            </span>
          </div>
          {shown ? (
            <p id="sn-req-amount-hint" role="alert" className="mt-2 text-[12.5px] leading-relaxed text-danger">
              {shown}
            </p>
          ) : (
            <p id="sn-req-amount-hint" className="mt-2 text-[12.5px] leading-relaxed text-mute">
              Leave it empty to let them choose how much.
            </p>
          )}
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="min-w-0">
            <label htmlFor="sn-req-note" className="text-[13px] text-mute">
              Note <span className="text-faint">(optional)</span>
            </label>
            <input
              id="sn-req-note"
              type="text"
              autoComplete="off"
              maxLength={STARKNET_REQUEST_NOTE_MAX}
              value={note}
              onChange={(e) => {
                setNote(e.target.value);
                setMade(null);
              }}
              placeholder="e.g. Invoice 042"
              className="gl-input mt-2"
            />
          </div>
          <div className="min-w-0">
            <label htmlFor="sn-req-name" className="text-[13px] text-mute">
              Your name <span className="text-faint">(optional)</span>
            </label>
            <input
              id="sn-req-name"
              type="text"
              autoComplete="off"
              maxLength={STARKNET_REQUEST_NAME_MAX}
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setMade(null);
              }}
              placeholder="Shown to them, like Robin"
              className="gl-input mt-2"
            />
          </div>
        </div>
        <button type="submit" className="btn btn-ink btn-lg btn-block" disabled={!to}>
          {live ? "Update request link" : "Create request link"}
        </button>
        <p className="flex items-start gap-2 text-[12.5px] leading-relaxed text-mute">
          <span className="mt-[3px] shrink-0 text-sealed" aria-hidden>
            <LockGlyph />
          </span>
          This link stays between you and the person you send it to. Nothing about the request goes on chain, and on Starknet the payment carries no note.
        </p>
      </form>
      <div aria-live="polite" className="mt-4">
        {live && <StarknetRequestShare key={live.url} url={live.url} label={live.label} />}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Pay: the request a link opened

/** The request in the address bar ("#snreq="), read for Pay on `network`, on arrival and on each new link. */
export function useStarknetRequestInHash(network: StarknetNetwork, tokens: number): StarknetRequestOnPay | null {
  const [found, setFound] = useState<StarknetRequestOnPay | null>(null);
  useEffect(() => {
    const read = () => setFound((was) => {
      const now = starknetRequestForPay(window.location.hash, network, tokens);
      // the same link read again keeps its object, so Pay fills it in once
      return now && was && now.body === was.body ? was : now;
    });
    read();
    window.addEventListener("hashchange", read);
    return () => window.removeEventListener("hashchange", read);
  }, [network, tokens]);
  return found;
}

/** Whether paying `to` from this account is a first payment (it shows their account), read once; null while unread or unreadable. */
function useReach(to: string): Reach | null {
  const sn = useStarknet();
  const engine = sn?.payroll ?? null;
  const [reach, setReach] = useState<{ to: string; at: Reach } | null>(null);
  useEffect(() => {
    if (!engine) return;
    let live = true;
    void engine
      .reach([to])
      .then((m) => {
        const at = m.get(to);
        if (live && at) setReach({ to, at });
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [engine, to]);
  return reach?.to === to ? reach.at : null;
}

/** Shown above Pay when a request link filled it. */
export function StarknetRequestBanner({ request, token, onDismiss }: { request: StarknetRequest; token: StarknetToken; onDismiss: () => void }) {
  const reach = useReach(request.to);
  const amount = request.amount !== null ? amountLabel(request.amount, token) : null;
  return (
    <section aria-label="Payment request" className="mt-5 rounded-[16px] border border-line bg-surface p-4 sm:p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="inline-flex items-center gap-1.5 text-[12px] font-medium text-mute">
            <span className="text-sealed" aria-hidden>
              <LockGlyph />
            </span>
            Payment request
          </p>
          <p className="mt-1.5 break-words text-[17px] leading-snug text-foreground">
            {request.name ? <span className="font-medium">{request.name}</span> : "Someone"}{" "}
            {amount ? (
              <>
                asked for <span className="tnum font-medium">{amount}</span>
              </>
            ) : (
              <>asked to be paid in {token.symbol}</>
            )}
            {request.note && <span className="text-mute"> · {request.note}</span>}
          </p>
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
        To <span className="tnum">{shortStark(request.to)}</span>. Check the details below, then press Pay privately. The note stays with you: a payment on Starknet carries none.
      </p>
      {reach === "closed" ? (
        <p className="mt-2 text-[12.5px] leading-relaxed text-warn">That private account isn&apos;t open on {STARKNET_NAME} yet. Ask them to open it in Gloam first.</p>
      ) : reach === "first" ? (
        <p className="mt-2 text-[12.5px] leading-relaxed text-soft">This is your first payment to them, so it shows their private account on {STARKNET_NAME}. It never shows who paid or how much.</p>
      ) : reach === null ? (
        <p className="mt-2 text-[12.5px] leading-relaxed text-mute">If this is your first payment to them, it shows their private account on {STARKNET_NAME}. It never shows who paid or how much.</p>
      ) : null}
      {request.name && <p className="mt-2 text-[12.5px] leading-relaxed text-warn">The name comes from the link. Check the account with them before you pay.</p>}
    </section>
  );
}

/** Above the open-your-account card when a request link brought someone here. */
export function StarknetRequestLead({ request, token }: { request: StarknetRequest; token: StarknetToken | null }) {
  return (
    <section className="gl-card p-5 sm:p-6">
      <p className="t-eyebrow">A payment request</p>
      <p className="mt-2 break-words text-[17px] leading-snug text-foreground">
        {request.name ? <span className="font-medium">{request.name}</span> : "Someone"}{" "}
        {request.amount !== null ? (
          <>
            asked for <span className="tnum font-medium">{token ? amountLabel(request.amount, token) : "..."}</span>
          </>
        ) : (
          <>asked to be paid{token ? ` in ${token.symbol}` : ""}</>
        )}
      </p>
      <p className="mt-2 text-[14px] leading-relaxed text-mute">Open your private account on {STARKNET_NAME} below. Pay fills in the request after that.</p>
    </section>
  );
}
