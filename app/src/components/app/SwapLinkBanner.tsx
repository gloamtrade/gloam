"use client";

import Link from "next/link";
import { getNetwork, networkName, type NetworkKey } from "@/lib/networks";
import { swapLinkSummary, swapNetworks, type SwapLink, type SwapLinkStep } from "@/lib/swapLink";
import { addAssetHref } from "@/lib/vaultHub";
import { PartnerLine } from "./PaymentRequest";

/**
 * A swap link (lib/swapLink) opened on the Swap tab: who sent it, the swap it
 * filled in, and what to do before it can go. With a live partner code (p=) the
 * sender shown is the partner's name from their Gloam account; without one, the
 * link's own `ref`, said to come from the link. It never swaps: the person
 * checks the quote under it and taps Swap privately. Laid out like a payment
 * request's banner (components/app/PaymentRequest).
 */
export function SwapLinkBanner({
  link,
  currentNetwork,
  onSwitchNetwork,
  onDismiss,
  step,
  notOpen = [],
  partnerName = null,
}: {
  link: SwapLink;
  currentNetwork: NetworkKey;
  onSwitchNetwork: (key: NetworkKey) => void;
  onDismiss: () => void;
  /** Add first, when the private balance in the token to pay with is none or too little. */
  step: SwapLinkStep | null;
  /** Lines for tokens the router lists but that are not open for swaps yet. */
  notOpen?: readonly string[];
  /** The partner whose live link code opened this, from their account. */
  partnerName?: string | null;
}) {
  // The link's tokens were read on `on`; anywhere else they mean nothing, so offer the switch.
  const wrongNet = link.on && link.on !== currentNetwork ? getNetwork(link.on) : null;
  const filled = Boolean(link.from || link.to || link.amount);
  const problems = [...link.problems, ...notOpen];
  const add = !wrongNet && step?.kind === "add" ? step : null;

  return (
    <section aria-label="Swap link" className="mb-5 rounded-[16px] border border-line bg-surface p-4 sm:p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="inline-flex items-center gap-1.5 text-[12px] font-medium text-mute">
            <span className="text-sealed" aria-hidden>
              <LockGlyph />
            </span>
            Swap link
          </p>
          {partnerName ? (
            <PartnerLine name={partnerName} />
          ) : (
            link.ref && (
              <p className="mt-1.5 break-words text-[13.5px] text-soft">
                From <span className="font-medium text-foreground">{link.ref}</span>
              </p>
            )
          )}
          <p className="tnum mt-1 break-words text-[17px] leading-snug text-foreground">{swapLinkSummary(link)}</p>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Close swap link"
          className="-mr-1.5 -mt-1.5 grid h-10 w-10 shrink-0 place-items-center rounded-full text-mute transition-colors hover:bg-panel hover:text-foreground"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
            <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      <p className="mt-2 text-[12.5px] leading-relaxed text-mute">
        {filled
          ? "Filled in from the link. Nothing swaps until you check the price below and tap Swap privately."
          : "Nothing from this link could be filled in. You can still pick a swap yourself."}
        {link.ref && !partnerName ? " The name comes from the link too." : ""}
      </p>

      {wrongNet && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-xl bg-panel px-3.5 py-2.5">
          <p className="text-[13px] text-foreground">This swap is for {networkName(wrongNet)}.</p>
          <button type="button" onClick={() => onSwitchNetwork(wrongNet.key)} className="btn btn-ink btn-sm">
            Switch to {networkName(wrongNet)}
          </button>
        </div>
      )}

      {add && (
        <div className="mt-3 rounded-xl bg-panel px-3.5 py-3">
          <p className="text-[13px] leading-relaxed text-soft">{add.text}</p>
          {(add.addable || add.bridge) && (
            <div className="mt-2.5 flex flex-wrap gap-2">
              {add.addable && (
                <Link href={addAssetHref(add.token.id)} className="btn btn-ink btn-sm">
                  Add {add.token.symbol} privately
                </Link>
              )}
              {add.bridge && (
                <Link href="/app/vault?tab=shield" className="btn btn-ghost btn-sm">
                  Bring money over
                </Link>
              )}
            </div>
          )}
        </div>
      )}

      {problems.length > 0 && (
        <ul role="alert" className="mt-3 space-y-1 rounded-xl bg-warn-soft px-3.5 py-2.5 text-[12.5px] leading-relaxed text-warn">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * The Vault on ?tab=swap where the network has no private swaps (a testnet,
 * Base or Ethereum while their switches are off): where swaps run, with a
 * switch to each, above the overview.
 */
export function SwapsElsewhere({ note, onSwitch }: { note: string; onSwitch: (key: NetworkKey) => void }) {
  return (
    <section aria-label="Private swaps" className="gl-card flex flex-wrap items-center justify-between gap-3 p-5">
      <p className="min-w-0 text-[14px] leading-relaxed text-soft">{note}</p>
      <div className="flex flex-wrap gap-2">
        {swapNetworks().map((k) => (
          <button key={k} type="button" onClick={() => onSwitch(k)} className="btn btn-ghost btn-sm">
            Switch to {networkName(getNetwork(k))}
          </button>
        ))}
      </div>
    </section>
  );
}

function LockGlyph() {
  return (
    <svg width={11} height={11} viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="4.5" y="10.5" width="15" height="10" rx="2.5" stroke="currentColor" strokeWidth="2" />
      <path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
