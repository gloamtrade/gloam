"use client";

import dynamic from "next/dynamic";
import { Component, useEffect, useSyncExternalStore, type ReactNode } from "react";
import {
  dropSignInWaiting,
  embeddedKitWanted,
  onEmbeddedKitWanted,
  setEmbeddedAuth,
  setEmbeddedAvailability,
  wantEmbeddedKitIfSignedIn,
} from "@/lib/turnkeyBridge";

/** The kit and everything on it (TurnkeyAppKit). Sign in calls this on touch, so the download starts before the click. */
export const loadTurnkeyAppKit = () => import("./TurnkeyAppKit");

// The same module as loadTurnkeyAppKit, written out in full for Next's dynamic transform.
const TurnkeyAppKit = dynamic(() => import("./TurnkeyAppKit"), { ssr: false });

function localStore(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

// Read as the app's scripts run, before the page is interactive: for someone signed
// in, the kit's download starts beside the page's own instead of after them.
if (typeof window !== "undefined" && wantEmbeddedKitIfSignedIn(localStore())) {
  void loadTurnkeyAppKit().catch(() => {});
}

/**
 * A kit that failed to load (a dropped connection mid-download) leaves the app as
 * it was, with email sign-in marked unavailable here, like a kit that could not
 * start: the header offers the browser wallet instead.
 */
class KitBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.error("[Gloam] Email and passkey sign-in didn't load:", error);
    setEmbeddedAvailability("unavailable");
    setEmbeddedAuth("signed-out");
    dropSignInWaiting();
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}

/**
 * Starts the Turnkey kit (Gloam wallets: email and passkey sign-in) only when it is
 * needed: on load when this browser holds a sign-in that may still be good
 * (lib/embeddedWallet storedTurnkeySession), or once someone asks to sign in
 * (openSignInSheet in lib/turnkeyBridge). Everyone else never downloads it. Mounted
 * once in the app (Web3Provider) when Gloam wallets are on; renders nothing until then.
 */
export function TurnkeyKitGate() {
  const wanted = useSyncExternalStore(onEmbeddedKitWanted, embeddedKitWanted, () => false);

  // Back in the app after signing in elsewhere on this site (the partner portal) in this tab.
  useEffect(() => {
    wantEmbeddedKitIfSignedIn(localStore());
  }, []);

  return wanted ? (
    <KitBoundary>
      <TurnkeyAppKit />
    </KitBoundary>
  ) : null;
}
