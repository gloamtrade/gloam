"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { AuthState, ClientState, useTurnkey } from "@turnkey/react-wallet-kit";
import { getAddress } from "viem";
import { createWalletErrorText, embeddedFlowStep, pickEmbeddedWallet, walletNameFor, type WalletListState } from "@/lib/embeddedWallet";
import {
  embeddedSignerState,
  getActiveTurnkeyAccount,
  onEmbeddedSignerState,
  onTurnkeyAccountChange,
  openSignInSheet,
  retryEmbeddedSigner,
  signOutEmbedded,
} from "@/lib/turnkeyBridge";
import { PortalError, signInWithSigner } from "./client";
import { shortAddr } from "./ui";
import { Spinner } from "@/components/ui/Spinner";

/** How many times the wallet list is read before saying it couldn't (as EmbeddedWalletFlow does). */
const LIST_TRIES = 3;
/** The chain the sign-in message names. A Gloam wallet is a plain key, so it is checked by recovery on any chain. */
const SIGN_IN_CHAIN = 46630;

const signFailed = () => new PortalError("Your Gloam wallet did not sign. Try again.", "wallet", 0);

/**
 * Partner sign-in with an email, through a Gloam wallet (Turnkey). Mounted only
 * when Gloam wallets are on, inside TurnkeyEmbeddedProvider. Sign in with email
 * opens Gloam's sign-in sheet (GloamSignInSheet); closing it, or choosing a
 * browser wallet from it, comes back to this Sign in card. The email sign-in
 * opens or makes the person's Gloam wallet; that wallet then signs the same
 * partner sign-in message a browser wallet does (lib/partnersAuth), so the
 * session is the usual one. Nothing new on the server.
 *
 * Renders nothing when the kit could not start (Turnkey refused this site).
 */
export default function PartnerEmailSignIn({
  onSignedIn,
  onError,
  disabled,
  autoStart,
  onUseWallet,
}: {
  onSignedIn: () => void;
  onError: (message: string | null) => void;
  /** A browser wallet sign-in is running. */
  disabled: boolean;
  /** Open the email sheet as soon as the kit is ready (the landing page's Sign in with email). */
  autoStart: boolean;
  /** The card's browser-wallet sign-in, offered from inside the sheet. */
  onUseWallet?: () => void;
}) {
  const { authState, clientState, wallets, createWallet, refreshWallets, session } = useTurnkey();
  const signedIn = authState === AuthState.Authenticated;
  /** The wallet list is read once per sign-in: a new sign-in starts the reads over. */
  const sessionKey = signedIn ? (session?.organizationId ?? "signed-in") : "signed-out";
  const signer = useSyncExternalStore(onEmbeddedSignerState, embeddedSignerState, () => "idle" as const);
  const account = useSyncExternalStore(onTurnkeyAccountChange, getActiveTurnkeyAccount, () => null);

  const [reads, setReads] = useState<{ key: string; list: WalletListState; tries: number }>({ key: "", list: "unknown", tries: 0 });
  const list: WalletListState = reads.key === sessionKey ? reads.list : "unknown";
  const tries = reads.key === sessionKey ? reads.tries : 0;
  const setList = (next: WalletListState) => setReads({ key: sessionKey, list: next, tries: 0 });
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"sign" | "out" | null>(null);
  /** Started from this page: once the wallet is ready, sign in without another click. */
  const [started, setStarted] = useState(false);
  const autoOpened = useRef(false);
  const autoSigned = useRef(false);

  const wallet = pickEmbeddedWallet(wallets);
  const step = embeddedFlowStep({
    signedIn,
    list: wallet ? "read" : list,
    hasWallet: Boolean(wallet),
    creating,
    error: createError,
    funding: false,
    backup: false,
    dismissed: false,
  });

  const refresh = useRef(refreshWallets);
  const walletRef = useRef(onUseWallet);
  useEffect(() => {
    refresh.current = refreshWallets;
    walletRef.current = onUseWallet;
  });

  // After an email sign-in, read the wallet list, so someone with a wallet never sees "Create".
  useEffect(() => {
    if (!signedIn || list !== "unknown") return;
    let live = true;
    const t = window.setTimeout(
      () => {
        void refresh
          .current()
          .then(() => {
            if (live) setReads({ key: sessionKey, list: "read", tries: 0 });
          })
          .catch(() => {
            if (!live) return;
            setReads({ key: sessionKey, list: tries + 1 >= LIST_TRIES ? "failed" : "unknown", tries: tries + 1 });
          });
      },
      tries === 0 ? 0 : 1_500 * tries
    );
    return () => {
      live = false;
      window.clearTimeout(t);
    };
  }, [signedIn, sessionKey, list, tries]);

  function open() {
    onError(null);
    setStarted(true);
    // read when tapped, so the card's latest wallet list is the one used; with no
    // browser wallet found the card passes none, and the sheet offers none
    openSignInSheet(walletRef.current ? { onUseWallet: () => walletRef.current?.() } : {});
  }

  async function create() {
    if (creating) return;
    setCreating(true);
    setCreateError(null);
    try {
      // a wallet that is there already is never made twice
      const fresh = await refresh.current().catch(() => {
        throw new Error("wallet list");
      });
      if (!pickEmbeddedWallet(fresh)) {
        await createWallet({ walletName: walletNameFor(""), accounts: ["ADDRESS_FORMAT_ETHEREUM"] });
        await refresh.current().catch(() => []);
      }
      setStarted(true);
    } catch (e) {
      setCreateError(createWalletErrorText(e));
    } finally {
      setCreating(false);
    }
  }

  async function signIn() {
    const acct = getActiveTurnkeyAccount();
    if (!acct || busy === "sign") return;
    setBusy("sign");
    onError(null);
    try {
      await signInWithSigner(getAddress(acct.address), SIGN_IN_CHAIN, (message) => acct.signMessage({ message }), signFailed);
      onSignedIn();
    } catch (e) {
      onError(e instanceof PortalError ? e.message : "Sign-in did not work. Try again.");
    } finally {
      setBusy(null);
    }
  }

  async function signOut() {
    setBusy("out");
    try {
      await signOutEmbedded();
    } finally {
      setStarted(false);
      autoSigned.current = false;
      setBusy(null);
    }
  }

  // from the landing page's Sign in with email: open the sheet once the kit is up.
  // Once, and the ?with=email comes off the address, so a reload or a Back lands
  // on this Sign in card with both ways in.
  useEffect(() => {
    if (!autoStart || autoOpened.current || clientState !== ClientState.Ready || signedIn) return;
    autoOpened.current = true;
    const url = new URL(window.location.href);
    if (url.searchParams.has("with")) {
      url.searchParams.delete("with");
      window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
    }
    const t = window.setTimeout(() => open(), 0);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoStart, clientState, signedIn]);

  // the email flow was started here and the wallet is ready: finish without another click
  const ready = step === "hidden" && signer === "ready" && Boolean(account);
  useEffect(() => {
    if (!ready || !started || autoSigned.current) return;
    autoSigned.current = true;
    const t = window.setTimeout(() => void signIn(), 0);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, started]);

  if (clientState === ClientState.Error) return null;

  const quiet = "btn btn-quiet btn-sm btn-block";
  const main = "btn btn-ghost btn-lg btn-block";

  if (!signedIn) {
    return (
      // Not held back while the kit starts: the sheet opens at once and says "Getting sign-in ready…".
      <button type="button" disabled={disabled || busy !== null} onClick={open} className={main}>
        Sign in with email
      </button>
    );
  }

  let body: React.ReactNode;
  if (step === "checking" || (step === "hidden" && signer !== "ready" && signer !== "failed")) {
    body = (
      <button type="button" disabled aria-busy="true" className={main}>
        <Spinner />
        Opening your Gloam wallet…
      </button>
    );
  } else if (step === "unreadable") {
    body = (
      <>
        <p className="text-[13px] text-mute">Couldn&apos;t read your Gloam wallets.</p>
        <button type="button" onClick={() => setList("unknown")} className={main}>
          Try again
        </button>
      </>
    );
  } else if (step === "create" || step === "creating" || step === "failed") {
    body = (
      <>
        <p className="text-[13px] text-mute">Signed in. Create your Gloam wallet to own the account. There is no seed phrase.</p>
        <button type="button" disabled={creating || disabled} onClick={() => void create()} aria-busy={creating} className="btn btn-ink btn-lg btn-block">
          {creating && <Spinner />}
          {creating ? "Creating…" : step === "failed" ? "Try again" : "Create Gloam wallet"}
        </button>
        {createError && <p className="text-[13px] text-danger">{createError}</p>}
      </>
    );
  } else if (signer === "failed") {
    body = (
      <button type="button" onClick={retryEmbeddedSigner} className={main}>
        Try again
      </button>
    );
  } else {
    body = (
      <button type="button" disabled={disabled || busy !== null} onClick={() => void signIn()} aria-busy={busy === "sign"} className="btn btn-ink btn-lg btn-block">
        {busy === "sign" && <Spinner />}
        {busy === "sign" ? "Signing in…" : `Continue as ${shortAddr(account!.address)}`}
      </button>
    );
  }

  return (
    <div className="space-y-2">
      {body}
      <button type="button" disabled={busy !== null || creating} onClick={() => void signOut()} className={quiet}>
        {busy === "out" && <Spinner />}
        {busy === "out" ? "Signing out…" : "Use another email"}
      </button>
    </div>
  );
}
