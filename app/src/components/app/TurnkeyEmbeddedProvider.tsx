"use client";

import dynamic from "next/dynamic";
import type { ReactNode } from "react";
import { EMBEDDED_WALLETS } from "@/lib/embeddedWallet";

/**
 * Gloam wallets (email or passkey sign-in, keys kept by Turnkey) are off until
 * NEXT_PUBLIC_TURNKEY_ENABLED is "true" and both dashboard ids are set
 * (lib/embeddedWallet). DEPLOY-TURNKEY.md lists every setting first.
 */
export const TURNKEY_ENABLED = EMBEDDED_WALLETS;

/** The kit is a large bundle; it only downloads when the flag is on. */
const TurnkeyKitProvider = dynamic(() => import("./TurnkeyKit"));

/**
 * Wraps a page with Turnkey embedded wallets (passkey / email login), for pages
 * that call the kit directly (the partner portal). The app does not wrap its
 * pages: it starts the kit beside them only when needed (TurnkeyKitGate).
 */
export function TurnkeyEmbeddedProvider({ children }: { children: ReactNode }) {
  if (!TURNKEY_ENABLED) return <>{children}</>;
  return <TurnkeyKitProvider>{children}</TurnkeyKitProvider>;
}
