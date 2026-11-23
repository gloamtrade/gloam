"use client";

import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { Spinner } from "@/components/ui/Spinner";
import { EMBEDDED_WALLETS } from "@/lib/embeddedWallet";
import { embeddedAuth, onEmbeddedAuth } from "@/lib/turnkeyBridge";
import { GLOAM_ACCOUNT_NOTE, GLOAM_SOLANA_OFF, gloamSolana, isGloamAccount, onGloamSolana, retryGloamSolana } from "@/lib/turnkeySolana";

/** How long "Opening your Gloam account" waits for the kit before it stops saying so. */
const STARTING_MS = 12_000;

/**
 * Solana's connect card, for someone signed in with a Gloam wallet: their Gloam
 * account (lib/turnkeySolana) is on its way, so the card says so instead of
 * "No Solana wallet in this browser" (`children`); or it couldn't be made, and
 * the card says why with Try again. Anyone else sees `children` as before.
 */
export function GloamAccountHint({ children }: { children?: ReactNode }) {
  const gloam = useSyncExternalStore(onGloamSolana, gloamSolana, () => GLOAM_SOLANA_OFF);
  const auth = useSyncExternalStore(onEmbeddedAuth, embeddedAuth, () => "signed-out" as const);
  const starting = EMBEDDED_WALLETS && (gloam.status === "starting" || (gloam.status === "off" && auth === "restoring"));
  // A sign-in the kit never finishes looking at stops showing as on its way.
  const [waited, setWaited] = useState(false);
  useEffect(() => {
    if (!starting) return;
    const t = window.setTimeout(() => setWaited(true), STARTING_MS);
    return () => window.clearTimeout(t);
  }, [starting]);

  if (gloam.status === "making" || (starting && !waited)) {
    return (
      <p role="status" aria-live="polite" className="mt-5 flex items-center gap-2.5 rounded-[16px] bg-surface px-4 py-3.5 text-[13.5px] text-foreground">
        <Spinner />
        Opening your Gloam account on Solana
      </p>
    );
  }
  if (gloam.status === "failed") {
    return (
      <>
        <div role="alert" className="mt-5 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-[16px] bg-surface px-4 py-3 text-[13.5px] leading-relaxed text-soft">
          <span className="min-w-0 flex-1">{gloam.error ?? "Your Gloam account couldn't open on Solana."}</span>
          <button type="button" className="btn btn-quiet btn-sm h-10" onClick={retryGloamSolana}>
            Try again
          </button>
        </div>
        {children}
      </>
    );
  }
  return <>{children}</>;
}

/**
 * Before a Gloam account signs the message that opens a private account: who
 * else could open it (lib/turnkeySolana GLOAM_ACCOUNT_NOTE, as /privacy says).
 */
export function GloamAccountNote({ wallet, className = "" }: { wallet: { name: string; wallet?: unknown } | null | undefined; className?: string }) {
  if (!isGloamAccount(wallet)) return null;
  return <p className={`text-[12.5px] leading-relaxed text-mute ${className}`}>{GLOAM_ACCOUNT_NOTE}</p>;
}
