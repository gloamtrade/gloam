"use client";

import { useEffect } from "react";
import { AuthState, useTurnkey } from "@turnkey/react-wallet-kit";
import { setGloamPasskeys } from "@/lib/gloamPasskeys";

/**
 * Publishes the signed-in Gloam wallet's passkey credential ids (lib/gloamPasskeys)
 * for Starknet's open card. Lives in the app's kit (TurnkeyAppKit). Renders nothing.
 */
export function TurnkeyPasskeysSync() {
  const { authState, user } = useTurnkey();
  const signedIn = authState === AuthState.Authenticated;
  const ids = signedIn ? (user?.authenticators ?? []).map((a) => a.credentialId).filter((id): id is string => typeof id === "string" && id.length > 0) : [];
  const key = ids.join(",");
  useEffect(() => {
    setGloamPasskeys(key ? key.split(",") : []);
  }, [key]);
  useEffect(() => () => setGloamPasskeys([]), []);
  return null;
}
