"use client";

import { useState, useSyncExternalStore, type ReactNode } from "react";
import {
  embeddedAuth,
  embeddedAvailability,
  embeddedNeedsWallet,
  embeddedSignerState,
  onEmbeddedAuth,
  onEmbeddedAvailability,
  onEmbeddedNeedsWallet,
  onEmbeddedSignerState,
  onSignInWaiting,
  openEmbeddedSheet,
  openSignInSheet,
  retryEmbeddedSigner,
  signInWaiting,
  signOutEmbedded,
} from "@/lib/turnkeyBridge";
import { Spinner } from "@/components/ui/Spinner";
import { forgetClaim } from "@/lib/claimLinkStore";
import { loadTurnkeyAppKit } from "./TurnkeyKitGate";

/**
 * Email or passkey sign-in for a Gloam wallet, sized by `className` for where it
 * sits (sidebar block, top-bar pill, or inline form button).
 *
 * - Signed out: Sign in, which opens Gloam's email and passkey sheet
 *   (GloamSignInSheet). `onUseWallet` is the browser-wallet connect beside it,
 *   offered from inside the sheet too.
 * - Signed in with no wallet yet: Create wallet, which opens the create sheet,
 *   with Sign out beside it.
 * - Signed in with a wallet: a moment while the wallet connects, with Sign out
 *   beside it; if the wallet's signer didn't start, Try again. Then the wallet
 *   menu shows the address and this is gone. Signed in on an earlier visit, the
 *   same moment shows from the first paint while the kit loads, never Sign in.
 * - When the kit could not start (Turnkey refused this site, or no connection),
 *   `fallback` instead: a sign-in that can only fail is never offered.
 *
 * It reads the kit's state from lib/turnkeyBridge, not from the kit, so it never
 * needs the kit itself: the kit loads for someone already signed in, or when Sign
 * in is pressed (TurnkeyKitGate). Touching or pointing at Sign in starts the
 * download, and the button shows it is working until the sheet opens.
 */
export function TurnkeyHeaderSignIn({
  className = "btn btn-ink btn-sm",
  quietClassName = "text-[13px] text-mute transition-colors hover:text-foreground",
  fallback = null,
  onUseWallet,
  walletLabel,
}: {
  className?: string;
  /** The look of the small Sign out next to a wallet that is still opening. */
  quietClassName?: string;
  fallback?: ReactNode;
  /** The browser-wallet connect next to this button, offered inside the sheet as well. */
  onUseWallet?: () => void;
  walletLabel?: string;
} = {}) {
  const auth = useSyncExternalStore(onEmbeddedAuth, embeddedAuth, () => "signed-out" as const);
  const availability = useSyncExternalStore(onEmbeddedAvailability, embeddedAvailability, () => "starting" as const);
  const needsWallet = useSyncExternalStore(onEmbeddedNeedsWallet, embeddedNeedsWallet, () => false);
  const signer = useSyncExternalStore(onEmbeddedSignerState, embeddedSignerState, () => "idle" as const);
  const waiting = useSyncExternalStore(onSignInWaiting, signInWaiting, () => false);
  const [leaving, setLeaving] = useState(false);

  if (availability === "unavailable") return <>{fallback}</>;

  // Signed in on an earlier visit: the kit is loading to open the wallet. Nothing to
  // sign out of yet (the kit holds the session), so no Sign out until it has started.
  if (auth === "restoring") {
    return (
      <button type="button" disabled aria-busy="true" className={className}>
        <Spinner />
        Opening your wallet…
      </button>
    );
  }

  if (auth === "signed-in") {
    const signOut = (
      <button
        type="button"
        disabled={leaving}
        onClick={async () => {
          setLeaving(true);
          // signing out on purpose: a claim link this tab holds goes too (lib/claimLinkStore)
          forgetClaim();
          try {
            await signOutEmbedded();
          } finally {
            setLeaving(false);
          }
        }}
        className={`${quietClassName} inline-flex items-center justify-center gap-1.5`}
      >
        {leaving && <Spinner className="h-3 w-3" />}
        {leaving ? "Signing out…" : "Sign out"}
      </button>
    );
    // Signed in with no wallet yet: Create wallet, and Sign out to use another email or passkey.
    if (needsWallet) {
      return (
        <>
          <button type="button" onClick={() => openEmbeddedSheet("create")} className={className}>
            Create wallet
          </button>
          {signOut}
        </>
      );
    }
    return signer === "failed" ? (
      <>
        <button type="button" onClick={retryEmbeddedSigner} className={className}>
          Try again
        </button>
        {signOut}
      </>
    ) : (
      <>
        <button type="button" disabled aria-busy="true" className={className}>
          <Spinner />
          Opening your wallet…
        </button>
        {signOut}
      </>
    );
  }

  // the kit's code starts downloading on the first sign of a tap, a moment before the click
  const prefetch = () => void loadTurnkeyAppKit().catch(() => {});
  return (
    <button
      type="button"
      onPointerEnter={prefetch}
      onTouchStart={prefetch}
      onFocus={prefetch}
      onClick={() => {
        void import("@/lib/track").then(({ track }) => {
          track("wallet_connect_click", { method: "gloam_wallet" });
        });
        // never dropped: before the sheet is there, the tap waits and the sheet opens with it
        openSignInSheet({ onUseWallet, walletLabel });
      }}
      aria-busy={waiting || undefined}
      className={className}
    >
      {waiting && <Spinner />}
      Sign in
    </button>
  );
}
