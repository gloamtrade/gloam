"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { AuthState, useTurnkey } from "@turnkey/react-wallet-kit";
import { SOLANA_RINGS_ENABLED } from "@/lib/solanaRings/config";
import { embeddedNeedsWallet, onEmbeddedNeedsWallet } from "@/lib/turnkeyBridge";
import {
  GLOAM_SOLANA_ACCOUNT,
  createSolanaErrorText,
  gloamSolanaRetries,
  gloamSolanaSignedOut,
  makeGloamSolanaWallet,
  onGloamSolanaRetry,
  registerStandardWallet,
  setGloamSolana,
  solanaAccountPlan,
  turnkeyEd25519Signer,
  type RawPayloadClient,
} from "@/lib/turnkeySolana";
import { useNetwork } from "./NetworkProvider";

/**
 * The Gloam wallet's Solana account (lib/turnkeySolana), kept in step with the
 * Turnkey session. Lives in the app's kit (TurnkeyAppKit). Renders nothing.
 *
 * - Its Solana account is made the first time someone signed in picks Solana:
 *   one more account in the same Turnkey wallet (createWalletAccounts), never a
 *   second wallet. A wallet made since this change has it from the start
 *   (EmbeddedWalletFlow). Two tabs at once: the second's request fails and the
 *   list read after it shows the account the first made.
 * - Once it is there, it is announced on the page as the Solana wallet "Gloam
 *   account", signing through Turnkey with the session's own key, as the
 *   Ethereum account does (TurnkeyWagmiSync). Signing out takes it away, and
 *   Solana leaves it too (GloamSolanaAutoConnect).
 */
export function TurnkeySolanaSync() {
  const { authState, wallets, httpClient, session, createWalletAccounts, refreshWallets } = useTurnkey();
  const { solana } = useNetwork();
  const signedIn = authState === AuthState.Authenticated;
  const organizationId = session?.organizationId ?? null;
  const plan = signedIn ? solanaAccountPlan(wallets) : ({ kind: "none" } as const);
  const needsWallet = useSyncExternalStore(onEmbeddedNeedsWallet, embeddedNeedsWallet, () => false);
  const retries = useSyncExternalStore(onGloamSolanaRetry, gloamSolanaRetries, () => 0);

  // The latest client values, read when something is signed.
  const latest = useRef({ client: httpClient as unknown as RawPayloadClient | undefined, organizationId });
  useEffect(() => {
    latest.current = { client: httpClient as unknown as RawPayloadClient | undefined, organizationId };
  });

  // Signed in and then not, while the page is open: a sign-out, or the session ended.
  const wasSignedIn = useRef(false);
  useEffect(() => {
    if (signedIn) wasSignedIn.current = true;
    else if (wasSignedIn.current) {
      wasSignedIn.current = false;
      gloamSolanaSignedOut();
    }
  }, [signedIn]);

  // Make the Solana account: once per wallet, and again only on Try again.
  const [making, setMaking] = useState<{ walletId: string; failed: string | null } | null>(null);
  const createId = plan.kind === "create" ? plan.walletId : null;
  const want = Boolean(createId) && solana && SOLANA_RINGS_ENABLED;
  const create = useRef(createWalletAccounts);
  const refresh = useRef(refreshWallets);
  useEffect(() => {
    create.current = createWalletAccounts;
    refresh.current = refreshWallets;
  });
  useEffect(() => {
    if (!want || !createId) return;
    let live = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the request below is the effect; its state shows while it runs
    setMaking({ walletId: createId, failed: null });
    void (async () => {
      let error: unknown = null;
      try {
        await create.current({ walletId: createId, accounts: [{ ...GLOAM_SOLANA_ACCOUNT }] });
      } catch (e) {
        // Another tab may have made it a moment before: the list read next decides.
        error = e;
      }
      let fresh: Parameters<typeof solanaAccountPlan>[0] = [];
      try {
        fresh = await refresh.current();
      } catch {
        /* read again on the next change */
      }
      if (!live) return;
      if (solanaAccountPlan(fresh).kind === "ready") setMaking(null);
      else {
        if (error) console.warn("[Gloam] The Gloam account's Solana account wasn't made:", error);
        setMaking({ walletId: createId, failed: createSolanaErrorText(error) });
      }
    })();
    return () => {
      live = false;
    };
  }, [want, createId, retries]);

  // Announce it as a Solana wallet while signed in.
  const address = plan.kind === "ready" ? plan.address : null;
  useEffect(() => {
    if (!address || !organizationId) return;
    const sign = turnkeyEd25519Signer(() => latest.current, address);
    const wallet = makeGloamSolanaWallet({ address, sign });
    const undo = registerStandardWallet(wallet, window);
    return () => {
      wallet.end();
      undo();
    };
  }, [address, organizationId]);

  // What the rest of the app reads (the wallet menu, Solana's connect card).
  const status =
    plan.kind === "ready"
      ? { status: "ready" as const, address: plan.address, error: null }
      : plan.kind === "create" && making?.walletId === plan.walletId
        ? making.failed
          ? { status: "failed" as const, address: null, error: making.failed }
          : { status: "making" as const, address: null, error: null }
        : signedIn && plan.kind === "none" && !needsWallet
          ? { status: "starting" as const, address: null, error: null }
          : { status: "off" as const, address: null, error: null };
  useEffect(() => {
    setGloamSolana(status);
  }, [status.status, status.address, status.error]); // eslint-disable-line react-hooks/exhaustive-deps -- the object is rebuilt each render; its fields are what change
  useEffect(() => () => setGloamSolana({ status: "off", address: null, error: null }), []);

  return null;
}
