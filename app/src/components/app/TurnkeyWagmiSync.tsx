"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";
import { AuthState, ClientState, useTurnkey } from "@turnkey/react-wallet-kit";
import type { Hex } from "viem";
import { SPONSOR_CHAINS, sendSponsored, sponsorRefusedText, type SponsorClient } from "@/lib/embeddedGas";
import { EmbeddedNotSentError } from "@/lib/embeddedErrors";
import { pickEmbeddedWallet } from "@/lib/embeddedWallet";
import {
  buildTurnkeyAccount,
  embeddedSignerRetries,
  onEmbeddedSignerRetry,
  setActiveTurnkeySigner,
  setEmbeddedAuth,
  setEmbeddedAvailability,
  setEmbeddedSignInEmail,
  setEmbeddedSignOut,
  setEmbeddedSignerState,
  type EmbeddedSigner,
  type SponsoredTx,
} from "@/lib/turnkeyBridge";

/**
 * Once a sign-in completes and the Gloam wallet exists, builds the viem signer
 * for it and publishes it for the wagmi connector (lib/turnkeyBridge). Also
 * reports whether the kit started, whether someone is signed in and whether the
 * signer started (so the header, outside the kit, can offer Sign in or a way
 * out), wires sign-out, and holds the sign-in email in memory for the updates
 * field in Settings. Renders nothing.
 *
 * The private-balance backup is never turned on from here: a Gloam wallet's
 * signatures are made and kept by Turnkey, so its backup goes through a passkey
 * the person chooses (EmbeddedWalletFlow, lib/embeddedRecovery).
 */
export function TurnkeyWagmiSync() {
  const { authState, clientState, wallets, httpClient, session, logout, user } = useTurnkey();
  const organizationId = session?.organizationId;
  const address = pickEmbeddedWallet(wallets)?.address;
  const retries = useSyncExternalStore(onEmbeddedSignerRetry, embeddedSignerRetries, () => 0);

  // The latest client values, read when a sponsored send goes out.
  const latest = useRef({ httpClient, organizationId });
  useEffect(() => {
    latest.current = { httpClient, organizationId };
  });

  useEffect(() => {
    if (clientState === ClientState.Error) {
      // This kit version reports a refused auth proxy config to no one. The usual
      // cause: this page's origin is not in the dashboard's Allowed Origins.
      console.warn(
        `[Gloam] Email and passkey sign-in did not start on ${window.location.origin}. Check that this origin is in the Turnkey dashboard's Allowed Origins (DEPLOY-TURNKEY.md).`,
      );
    }
    setEmbeddedAvailability(
      clientState === ClientState.Error ? "unavailable" : clientState === ClientState.Ready ? "ready" : "starting",
    );
  }, [clientState]);

  // Signed in or not, for the header's Sign in, which sits outside the kit (lib/turnkeyBridge).
  // Signed out only once the kit has looked at what this browser holds: while it starts,
  // a stored sign-in stays "restoring", so the header never says Sign in to someone signed in.
  const signedIn = authState === AuthState.Authenticated;
  const looked = clientState === ClientState.Error || (clientState === ClientState.Ready && !session);
  useEffect(() => {
    if (signedIn) setEmbeddedAuth("signed-in");
    else if (looked) setEmbeddedAuth("signed-out");
  }, [signedIn, looked]);
  useEffect(() => () => setEmbeddedAuth("signed-out"), []);

  // The sign-in email, in memory, for the updates field in Settings (lib/turnkeyBridge).
  const email = authState === AuthState.Authenticated ? (user?.userEmail ?? null) : null;
  useEffect(() => {
    setEmbeddedSignInEmail(email);
  }, [email]);
  useEffect(() => () => setEmbeddedSignInEmail(null), []);

  useEffect(() => {
    setEmbeddedSignOut(async () => {
      await logout();
    });
    return () => setEmbeddedSignOut(null);
  }, [logout]);

  useEffect(() => {
    if (authState !== AuthState.Authenticated) {
      setActiveTurnkeySigner(null);
      setEmbeddedSignerState("idle");
      return;
    }
    // Signed in and the wallet list says nothing yet (or no wallet): the create
    // sheet takes it from here (EmbeddedWalletFlow).
    if (!httpClient || !organizationId || !address) return;

    async function sponsoredSend(tx: SponsoredTx): Promise<Hex> {
      const { httpClient: client, organizationId: org } = latest.current;
      if (!client || !org) throw new EmbeddedNotSentError(sponsorRefusedText(tx.coin));
      return sendSponsored(client as unknown as SponsorClient, {
        organizationId: org,
        chainId: tx.chainId,
        from: tx.from,
        to: tx.to,
        data: tx.data,
        value: tx.value,
        coin: tx.coin,
      });
    }

    let cancelled = false;
    setEmbeddedSignerState("starting");
    void buildTurnkeyAccount(httpClient, organizationId, address)
      .then((account) => {
        if (cancelled) return;
        const signer: EmbeddedSigner = SPONSOR_CHAINS.size > 0 ? { account, sponsoredSend } : { account };
        setActiveTurnkeySigner(signer);
        setEmbeddedSignerState("ready");
      })
      .catch((err) => {
        if (cancelled) return;
        console.error("[Gloam] The Gloam wallet's signer didn't start:", err);
        setEmbeddedSignerState("failed");
      });
    return () => {
      cancelled = true;
    };
  }, [authState, httpClient, organizationId, address, retries]);

  return null;
}
