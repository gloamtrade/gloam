"use client";

import Link from "next/link";
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { motion, useReducedMotion } from "framer-motion";
import { AuthState, useTurnkey } from "@turnkey/react-wallet-kit";
import { useAccount } from "wagmi";
import { useModalFocus } from "@/hooks/useModalFocus";
import { bridgeVisible } from "@/lib/bridge";
import { shortAddress } from "@/lib/chain";
import { SPONSOR_CHAINS, TEMPO_FEE_CHAIN_IDS } from "@/lib/embeddedGas";
import {
  TURNKEY_CAN_OPEN_TEXT,
  backUpWithPasskey,
  backUpWithWalletSignature,
  backupAsked,
  backupOffer,
  markBackupAsked,
  passkeyBackupUnavailable,
  otherWalletNotes,
  type BackupOffer,
  type PasskeySupportLevel,
} from "@/lib/embeddedRecovery";
import {
  DEFAULT_WALLET_NAME,
  EMBEDDED_CONNECTOR_ID,
  WALLET_NAME_MAX,
  createWalletErrorText,
  embeddedFlowStep,
  pickEmbeddedWallet,
  walletNameFor,
  walletNameProblem,
  type WalletListState,
} from "@/lib/embeddedWallet";
import { networkName } from "@/lib/networks";
import { getActiveTurnkeyAccount, onEmbeddedSheetRequest, setEmbeddedNeedsWallet } from "@/lib/turnkeyBridge";
import { autoRestoreSyncing } from "@/lib/autoRestore";
import { useAutoRestoreStatus } from "@/hooks/useAutoRestoreStatus";
import { subscribeToUpdates } from "@/lib/updatesClient";
import { useNetwork } from "./NetworkProvider";
import { Spinner } from "@/components/ui/Spinner";

const noopSubscribe = () => () => {};

/** How many times the wallet list is read before the sheet says it couldn't. */
const LIST_TRIES = 3;

/**
 * Creating a Gloam wallet, adding money to it, and backing up its private
 * balance. Opens by itself once someone signs in with no wallet yet, and again
 * from the wallet menu (Add funds).
 *
 *  1. Create your wallet: an optional name and one button. The key is made in
 *     Turnkey's secure hardware; the page never sees it and there is no seed phrase.
 *     After an email sign-in, an unticked "Email me Gloam updates" box under it
 *     sends that email alone to the updates list (lib/updatesClient), never the wallet.
 *  2. Add funds: the ways in the app already has, the ones that cost this wallet
 *     nothing first (lib/embeddedGas), with the backup offer under them.
 *  A wallet made before gets the backup offer on its own (once), when this
 *  browser could back up and doesn't.
 *
 * The steps come from embeddedFlowStep (lib/embeddedWallet), the backup offer from
 * backupOffer (lib/embeddedRecovery). One sheet per sign-in: it is keyed by the
 * account, so signing out starts it over.
 */
export default function EmbeddedWalletFlow() {
  const { authState, session } = useTurnkey();
  const signedIn = authState === AuthState.Authenticated;
  const key = signedIn ? (session?.organizationId ?? "signed-in") : "signed-out";
  return <Sheet key={key} signedIn={signedIn} />;
}

/** What the backup part of the sheet shows. */
export type BackupView =
  | { kind: "offer"; offer: Exclude<BackupOffer, { kind: "none" }>; returning: boolean }
  | { kind: "busy"; with: "passkey" | "signature" }
  | { kind: "done"; with: "passkey" | "signature"; restored: number }
  | { kind: "error"; text: string; offer: Exclude<BackupOffer, { kind: "none" }>; returning: boolean };

function Sheet({ signedIn }: { signedIn: boolean }) {
  const { wallets, createWallet, refreshWallets, user } = useTurnkey();
  const { address: connected, connector } = useAccount();

  const [list, setList] = useState<WalletListState>("unknown");
  const [tries, setTries] = useState(0);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [funding, setFunding] = useState(false);
  const [justCreated, setJustCreated] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [name, setName] = useState("");
  const [showAddress, setShowAddress] = useState(false);
  const [updates, setUpdates] = useState(false);
  const updatesSent = useRef(false);
  const signInEmail = user?.userEmail?.trim() || null;

  const wallet = pickEmbeddedWallet(wallets);
  const embeddedConnected = Boolean(
    wallet && connected && connector?.id === EMBEDDED_CONNECTOR_ID && connected.toLowerCase() === wallet.address.toLowerCase(),
  );
  const backup = useBackup(wallet?.address ?? null, embeddedConnected, justCreated);

  const step = embeddedFlowStep({
    signedIn,
    list: wallet ? "read" : list,
    hasWallet: Boolean(wallet),
    creating,
    error,
    funding,
    // a done backup keeps the sheet up to say so, until it is closed
    backup: backup.view !== null,
    dismissed,
  });

  // Read the wallet list after signing in, so someone with a wallet never sees "Create wallet".
  // A failed read is not an empty list: it is read again, and after LIST_TRIES the sheet says so.
  const refresh = useRef(refreshWallets);
  useEffect(() => {
    refresh.current = refreshWallets;
  });
  useEffect(() => {
    if (!signedIn || list !== "unknown") return;
    let live = true;
    const t = window.setTimeout(
      () => {
        void refresh
          .current()
          .then(() => {
            if (live) setList("read");
          })
          .catch(() => {
            if (!live) return;
            if (tries + 1 >= LIST_TRIES) setList("failed");
            else setTries((n) => n + 1);
          });
      },
      tries === 0 ? 0 : 1_500 * tries,
    );
    return () => {
      live = false;
      window.clearTimeout(t);
    };
  }, [signedIn, list, tries]);

  // The header offers Create wallet only on a list that came back with none in it.
  const needsWallet = signedIn && list === "read" && !wallet;
  useEffect(() => {
    setEmbeddedNeedsWallet(needsWallet);
  }, [needsWallet]);
  useEffect(() => () => setEmbeddedNeedsWallet(false), []);

  useEffect(
    () =>
      onEmbeddedSheetRequest((req) => {
        setDismissed(false);
        setError(null);
        if (req === "funding") setFunding(true);
      }),
    []
  );

  const close = () => {
    if (creating || backup.view?.kind === "busy") return;
    backup.seen();
    setDismissed(true);
    setShowAddress(false);
  };

  const nameProblem = walletNameProblem(name);

  async function create() {
    if (creating || nameProblem) return;
    // the email alone, once, and only when the box is ticked: the wallet never goes with it
    if (updates && signInEmail && !updatesSent.current) {
      updatesSent.current = true;
      void subscribeToUpdates(signInEmail, "sign-in");
    }
    setCreating(true);
    setError(null);
    try {
      // Read the list again first: a wallet that is there already is never made twice.
      let fresh: Parameters<typeof pickEmbeddedWallet>[0];
      try {
        fresh = await refresh.current();
      } catch {
        throw new Error("wallet list");
      }
      if (pickEmbeddedWallet(fresh)) {
        setList("read");
        return;
      }
      await createWallet({ walletName: walletNameFor(name), accounts: ["ADDRESS_FORMAT_ETHEREUM"] });
      await refresh.current().catch(() => []);
      setJustCreated(true);
      setFunding(true);
      void import("@/lib/track").then(({ track }) => track("wallet_connect", { method: "gloam_wallet_created" }));
    } catch (e) {
      console.warn("[Gloam] Wallet not created:", e);
      setError(createWalletErrorText(e));
    } finally {
      setCreating(false);
    }
  }

  if (step === "hidden" || step === "checking") return null;
  return (
    <WalletSheet
      step={step}
      name={name}
      onName={setName}
      nameProblem={nameProblem}
      error={error}
      onCreate={() => void create()}
      onRetryList={() => {
        setTries(0);
        setList("unknown");
      }}
      onClose={close}
      address={embeddedConnected ? connected : wallet?.address}
      showAddress={showAddress}
      onShowAddress={() => setShowAddress(true)}
      backup={backup.view}
      onBackup={backup.run}
      updatesEmail={signInEmail}
      updates={updates}
      onUpdates={setUpdates}
    />
  );
}

/**
 * The backup offer for this wallet on this browser, and its actions. Nothing
 * starts without the person's tap. Marked as asked once it was shown and closed,
 * or acted on: it is offered once.
 */
function useBackup(address: string | null, embeddedConnected: boolean, justCreated: boolean) {
  const [passkey, setPasskey] = useState<PasskeySupportLevel | null>(null);
  const [state, setState] = useState<{ on: boolean; turnedOff: boolean; otherNotes: number; for: string } | null>(null);
  const [asked, setAsked] = useState(false);
  const [forceSignature, setForceSignature] = useState(false);
  const [action, setAction] = useState<BackupView | null>(null);

  useEffect(() => {
    let live = true;
    void import("@/lib/passkey").then(({ passkeySupport }) => passkeySupport()).then((s) => live && setPasskey(s));
    return () => {
      live = false;
    };
  }, []);

  // What this browser holds, read once the Gloam wallet is the connected one. Recovery
  // turning on afterwards (the restore that runs by itself after sign-in, lib/autoRestore)
  // takes the offer away.
  useEffect(() => {
    if (!address || !embeddedConnected) return;
    let live = true;
    let stop: (() => void) | null = null;
    void (async () => {
      const recovery = await import("@/lib/recovery");
      const vault = await import("@/lib/noteVault");
      recovery.startRecoverySync();
      await vault.unlockNoteVault();
      await vault.syncFromDisk();
      // the saved recovery settings load with the sync; wait for them
      for (let i = 0; i < 50 && !recovery.recoveryState().ready; i++) await new Promise((r) => setTimeout(r, 100));
      if (!live || !recovery.recoveryState().ready) return;
      setState({
        on: recovery.recoveryState().on,
        turnedOff: recovery.recoveryTurnedOffHere(),
        otherNotes: otherWalletNotes(vault.getAllNotes(), address),
        for: address,
      });
      setAsked(backupAsked(address));
      stop = recovery.subscribeRecovery(() => {
        const on = recovery.recoveryState().on;
        setState((s) => (s && s.on !== on ? { ...s, on } : s));
      });
      if (!live) stop();
    })();
    return () => {
      live = false;
      stop?.();
    };
  }, [address, embeddedConnected]);

  // While the backup may still come back by itself, offering to start one would be early.
  const restoring = autoRestoreSyncing(useAutoRestoreStatus(address));

  const offer: BackupOffer | null =
    address && passkey && state?.for === address && !restoring
      ? backupOffer({
          on: state.on,
          turnedOff: state.turnedOff,
          asked,
          embeddedConnected,
          otherNotes: state.otherNotes,
          passkey: forceSignature ? "no" : passkey,
        })
      : null;

  const view: BackupView | null =
    action ?? (offer && offer.kind !== "none" ? { kind: "offer", offer, returning: !justCreated } : null);

  function seen() {
    if (address && offer && offer.kind !== "none") {
      markBackupAsked(address);
      setAsked(true);
    }
  }

  async function run(how: "passkey-create" | "passkey-use" | "signature") {
    if (!address || !offer || offer.kind === "none") return;
    const returning = !justCreated;
    const using = how === "signature" ? "signature" : "passkey";
    setAction({ kind: "busy", with: using });
    try {
      let restored: number;
      if (how === "signature") {
        const account = getActiveTurnkeyAccount();
        if (!account) throw new Error("Your wallet isn't ready yet. Try again in a moment.");
        restored = await backUpWithWalletSignature({ address: account.address, sign: (message) => account.signMessage({ message }) });
      } else {
        restored = await backUpWithPasskey(address, how === "passkey-create" ? "create" : "use");
      }
      markBackupAsked(address);
      setAsked(true);
      setAction({ kind: "done", with: using, restored });
    } catch (e) {
      const { PROMPT_DID_NOT_OPEN } = await import("@/lib/passkey");
      // Only a browser or passkey that can't make a passkey backup moves the offer to the
      // signature, with its warning. A prompt closed (however fast) leaves the passkey on offer.
      if (passkeyBackupUnavailable(e) && how !== "signature") {
        setForceSignature(true);
        setAction(null);
        return;
      }
      const text =
        e instanceof Error && e.message === PROMPT_DID_NOT_OPEN
          ? "The passkey prompt closed. Nothing changed. Try again when you're ready."
          : e instanceof Error
            ? e.message
            : "The backup didn't turn on. Try again.";
      setAction({ kind: "error", text, offer, returning });
    }
  }

  return { view, run, seen };
}

/**
 * The sheet itself, drawn from props only (the Turnkey wiring is in Sheet above),
 * so every step can be looked at without a live sign-in.
 */
export function WalletSheet({
  step,
  name,
  onName,
  nameProblem,
  error,
  onCreate,
  onRetryList,
  onClose,
  address,
  showAddress,
  onShowAddress,
  backup,
  onBackup,
  updatesEmail = null,
  updates = false,
  onUpdates,
}: {
  step: "unreadable" | "create" | "creating" | "failed" | "funding" | "backup";
  name: string;
  onName: (name: string) => void;
  nameProblem: string | null;
  error: string | null;
  onCreate: () => void;
  onRetryList: () => void;
  onClose: () => void;
  address: string | undefined;
  showAddress: boolean;
  onShowAddress: () => void;
  backup: BackupView | null;
  onBackup: (how: "passkey-create" | "passkey-use" | "signature") => void;
  /** The email this sign-in used, when it was an email: offers the updates box. */
  updatesEmail?: string | null;
  updates?: boolean;
  onUpdates?: (on: boolean) => void;
}) {
  const { network } = useNetwork();
  const mounted = useSyncExternalStore(noopSubscribe, () => true, () => false);
  const reduce = useReducedMotion();
  const dialog = useRef<HTMLDivElement>(null);
  const nameField = useRef<HTMLInputElement>(null);
  const creating = step === "creating";
  useModalFocus(dialog, onClose, { initial: step === "create" ? nameField : undefined });

  if (!mounted) return null;
  const where = networkName(network);
  const title =
    step === "funding" ? "Add funds" : step === "backup" ? "Back up your private balance" : step === "unreadable" ? "Your wallet" : "Create your wallet";

  return createPortal(
    <div
      ref={dialog}
      tabIndex={-1}
      className="fixed inset-0 z-[210] flex items-end justify-center outline-none sm:items-center sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="gw-title"
    >
      <motion.button
        type="button"
        tabIndex={-1}
        aria-hidden="true"
        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
        aria-label="Close"
        onClick={onClose}
        initial={reduce ? false : { opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.2 }}
      />
      <motion.div
        className="relative z-[1] max-h-[92dvh] w-full max-w-[440px] overflow-y-auto rounded-t-[24px] bg-panel px-6 pb-[max(24px,env(safe-area-inset-bottom))] pt-6 shadow-pop sm:rounded-[24px] sm:px-7 sm:pb-7"
        initial={reduce ? false : { opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ type: "spring", stiffness: 420, damping: 36 }}
      >
        <div className="flex items-start justify-between gap-4">
          <h2 id="gw-title" className="text-[20px] font-medium tracking-[-0.01em] text-foreground">
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            disabled={creating || backup?.kind === "busy"}
            aria-label="Close"
            className="-mr-2 -mt-1 grid h-10 w-10 shrink-0 place-items-center rounded-full text-mute transition-colors hover:bg-surface hover:text-foreground disabled:opacity-50"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
              <path d="M6 6l12 12M18 6 6 18" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        {step === "funding" ? (
          <FundingStep
            address={address}
            where={where}
            chainId={network.chainId}
            coin={network.chain.nativeCurrency.symbol}
            bridge={bridgeVisible(network)}
            showAddress={showAddress}
            onShowAddress={onShowAddress}
            onLeave={onClose}
            backup={backup}
            onBackup={onBackup}
          />
        ) : step === "backup" ? (
          <div className="mt-2">
            {backup && <BackupPart view={backup} onBackup={onBackup} standalone />}
            <button type="button" onClick={onClose} disabled={backup?.kind === "busy"} className="btn btn-quiet btn-block mt-5">
              {backup?.kind === "done" ? "Done" : "Not now"}
            </button>
          </div>
        ) : step === "unreadable" ? (
          <div className="mt-2">
            <p className="text-[13.5px] leading-relaxed text-mute">
              Couldn&apos;t read your wallets just now, so nothing was made. Check your connection and try again.
            </p>
            <button type="button" onClick={onRetryList} className="btn btn-ink btn-lg btn-block mt-6">
              Try again
            </button>
          </div>
        ) : (
          <form
            className="mt-2"
            onSubmit={(e) => {
              e.preventDefault();
              onCreate();
            }}
          >
            <p className="text-[13.5px] leading-relaxed text-mute">
              Its key is made inside Turnkey&apos;s secure hardware and never reaches this page. There&apos;s no seed
              phrase to write down.
            </p>
            <label htmlFor="gw-name" className="mt-5 block text-[13px] text-mute">
              Wallet name (optional)
            </label>
            <input
              id="gw-name"
              ref={nameField}
              className="gl-input mt-2 text-[14px]"
              placeholder={DEFAULT_WALLET_NAME}
              maxLength={WALLET_NAME_MAX + 10}
              autoComplete="off"
              spellCheck={false}
              disabled={creating}
              value={name}
              onChange={(e) => onName(e.target.value)}
              aria-invalid={Boolean(nameProblem)}
            />
            {nameProblem && <p className="mt-1.5 text-[12.5px] leading-relaxed text-warn">{nameProblem}</p>}
            <p className="mt-3 text-[12.5px] leading-relaxed text-mute">
              Sign in with the same email or passkey on any device to open it again.
            </p>
            {updatesEmail && onUpdates && (
              <label className="mt-5 flex cursor-pointer items-start gap-3 rounded-[14px] bg-surface px-4 py-3">
                <input
                  type="checkbox"
                  checked={updates}
                  disabled={creating}
                  onChange={(e) => onUpdates(e.target.checked)}
                  className="mt-0.5 h-4 w-4 shrink-0 accent-ink"
                />
                <span className="min-w-0">
                  <span className="block text-[13.5px] text-foreground">Email me Gloam updates</span>
                  <span className="mt-0.5 block text-[12.5px] leading-relaxed text-mute [overflow-wrap:anywhere]">
                    Sent to {updatesEmail}. Kept apart from your wallet. Unsubscribe any time.
                  </span>
                </span>
              </label>
            )}
            {step === "failed" && error && (
              <p role="alert" className="mt-4 text-[13px] leading-relaxed text-danger">
                {error}
              </p>
            )}
            <button type="submit" disabled={creating || Boolean(nameProblem)} aria-busy={creating} className="btn btn-ink btn-lg btn-block mt-6">
              {creating && <Spinner />}
              {creating ? "Creating…" : step === "failed" ? "Try again" : "Create wallet"}
            </button>
          </form>
        )}
      </motion.div>
    </div>,
    document.body
  );
}

/**
 * The backup offer: a passkey first, the wallet's signature only where this
 * browser can't make a passkey backup, with what that means said plainly.
 * "Backed up" is said only after a backup turned on here, never for one that
 * was there already.
 */
function BackupPart({
  view,
  onBackup,
  standalone = false,
}: {
  view: BackupView;
  onBackup: (how: "passkey-create" | "passkey-use" | "signature") => void;
  standalone?: boolean;
}) {
  if (view.kind === "done") {
    return (
      <p role="status" className="flex items-start gap-2 text-[13px] leading-relaxed text-soft">
        <span className="mt-[3px] shrink-0 text-sealed" aria-hidden>
          <LockGlyph />
        </span>
        <span>
          {view.restored > 0
            ? `Brought back ${view.restored} ${view.restored === 1 ? "note" : "notes"} from your backup, and this browser backs up to it from now on.`
            : view.with === "passkey"
              ? "Backed up with your passkey. On another device, sign in and use the same passkey in Settings to bring it back."
              : "Backed up with this wallet's signature. On another device, sign in and restore it in Settings."}
        </span>
      </p>
    );
  }
  const busy = view.kind === "busy";
  const offer = view.kind === "offer" || view.kind === "error" ? view.offer : null;
  const returning = view.kind === "offer" || view.kind === "error" ? view.returning : false;
  const signature = offer?.kind === "signature";

  return (
    <div>
      {!standalone && <p className="text-[14.5px] text-foreground">Back up your private balance</p>}
      <p className={`${standalone ? "" : "mt-0.5 "}text-[12.5px] leading-relaxed text-mute`}>
        {signature
          ? "Your private balance lives in this browser. This browser can't save a passkey backup, so the other way is this wallet's signature. "
          : "Your private balance lives in this browser. Save it with a passkey and it comes back on any device. Only your passkey can open the backup."}
        {signature && TURNKEY_CAN_OPEN_TEXT}
      </p>
      {offer?.shared && (
        <p className="mt-2 text-[12.5px] leading-relaxed text-mute">
          This browser also holds private notes from another wallet. They go into this backup too.
        </p>
      )}
      {view.kind === "error" && (
        <p role="alert" className="mt-2 text-[12.5px] leading-relaxed text-danger">
          {view.text}
        </p>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {signature ? (
          <button type="button" onClick={() => onBackup("signature")} disabled={busy} aria-busy={busy} className="btn btn-ghost btn-sm">
            {busy && <Spinner />}
            {busy ? "Backing up…" : "Back up with this wallet's signature"}
          </button>
        ) : (
          <>
            <button
              type="button"
              onClick={() => onBackup("passkey-create")}
              disabled={busy}
              aria-busy={busy}
              className={standalone ? "btn btn-ink btn-sm" : "btn btn-ghost btn-sm"}
            >
              {busy && <Spinner />}
              {busy ? "Check your passkey…" : "Back up with a passkey"}
            </button>
            {returning && (
              <button type="button" onClick={() => onBackup("passkey-use")} disabled={busy} className="btn btn-quiet btn-sm">
                I backed up before
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function FundingStep({
  address,
  where,
  chainId,
  coin,
  bridge,
  showAddress,
  onShowAddress,
  onLeave,
  backup,
  onBackup,
}: {
  address: string | undefined;
  where: string;
  chainId: number;
  coin: string;
  bridge: boolean;
  showAddress: boolean;
  onShowAddress: () => void;
  onLeave: () => void;
  backup: BackupView | null;
  onBackup: (how: "passkey-create" | "passkey-use" | "signature") => void;
}) {
  const fees = TEMPO_FEE_CHAIN_IDS.has(chainId)
    ? "Network fees come out of the stablecoin you send."
    : SPONSOR_CHAINS.has(chainId)
      ? "Network fees for adding it privately are covered."
      : `Keep a little ${coin} in it for network fees.`;

  return (
    <div className="mt-2">
      <p className="text-[13.5px] leading-relaxed text-mute">
        Your wallet is ready on {where}.
      </p>
      <ul className="mt-4 grid gap-1">
        <FundRow href="/app/vault?tab=move&mode=receive" title="Claim a payment link" onGo={onLeave}>
          Open a link someone sent you, or paste it in Receive. No gas needed.
        </FundRow>
        <FundRow href="/app/vault?tab=move&mode=receive" title="Receive a private payment" onGo={onLeave}>
          Share your Gloam address. Payments land in your private balance, with no gas needed.
        </FundRow>
        {bridge && (
          <FundRow href="/app/vault?tab=shield&bridge=open" title="Bring money from another chain" onGo={onLeave}>
            From a Solana wallet it goes straight into your private balance. From other chains it lands here first.
          </FundRow>
        )}
        <li>
          <button
            type="button"
            onClick={onShowAddress}
            aria-expanded={showAddress}
            className="flex w-full items-start gap-3 rounded-[12px] px-3 py-3 text-left transition-colors hover:bg-surface"
          >
            <span className="min-w-0 flex-1">
              <span className="block text-[14.5px] text-foreground">Send from another wallet or an exchange</span>
              <span className="mt-0.5 block text-[12.5px] leading-relaxed text-mute">
                Send to this wallet&apos;s address on {where}, then add it privately.
              </span>
            </span>
            <Chevron down={showAddress} />
          </button>
          {showAddress && address && <AddressPanel address={address} fees={fees} onLeave={onLeave} />}
        </li>
      </ul>

      {backup && (
        <div className="mx-3 mt-4 border-t border-line pt-4">
          <BackupPart view={backup} onBackup={onBackup} />
        </div>
      )}

      <button type="button" onClick={onLeave} disabled={backup?.kind === "busy"} className="btn btn-quiet btn-block mt-5">
        Later
      </button>
    </div>
  );
}

function FundRow({ href, title, children, onGo }: { href: string; title: string; children: ReactNode; onGo: () => void }) {
  return (
    <li>
      <Link
        href={href}
        onClick={onGo}
        className="flex items-start gap-3 rounded-[12px] px-3 py-3 transition-colors hover:bg-surface"
      >
        <span className="min-w-0 flex-1">
          <span className="block text-[14.5px] text-foreground">{title}</span>
          <span className="mt-0.5 block text-[12.5px] leading-relaxed text-mute">{children}</span>
        </span>
        <Chevron />
      </Link>
    </li>
  );
}

function AddressPanel({ address, fees, onLeave }: { address: string; fees: string; onLeave: () => void }) {
  const [qr, setQr] = useState<{ for: string; src: string } | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let live = true;
    void import("qrcode")
      .then((QR) => QR.toDataURL(address, { margin: 1, width: 320, errorCorrectionLevel: "M" }))
      .then((src) => live && setQr({ for: address, src }))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [address]);

  return (
    <div className="mx-3 mb-2 mt-1 rounded-[12px] bg-surface p-4">
      {qr?.for === address && (
        // eslint-disable-next-line @next/next/no-img-element -- a local data URL
        <img src={qr.src} alt="This wallet's address as a QR code" width={160} height={160} className="mx-auto mb-3 rounded-[10px] bg-white p-1.5" />
      )}
      <p className="tnum break-all text-center text-[13px] text-foreground">{address}</p>
      <div className="mt-3 flex justify-center">
        <button
          type="button"
          onClick={() =>
            void navigator.clipboard?.writeText(address).then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1400);
            })
          }
          className="btn btn-ghost btn-sm"
          aria-label={`Copy address ${shortAddress(address)}`}
        >
          {copied ? "Copied" : "Copy address"}
        </button>
      </div>
      <p className="mt-3 text-center text-[12.5px] leading-relaxed text-mute">
        {fees}{" "}
        <Link href="/app/vault?tab=shield" onClick={onLeave} className="text-foreground underline underline-offset-2">
          Add privately
        </Link>{" "}
        once it arrives.
      </p>
    </div>
  );
}

function Chevron({ down = false }: { down?: boolean }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden
      className={`mt-1 shrink-0 text-faint transition-transform ${down ? "rotate-90" : ""}`}
    >
      <path d="m9 6 6 6-6 6" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function LockGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
      <rect x="5" y="10.5" width="14" height="9.5" rx="2.2" stroke="currentColor" strokeWidth="1.8" />
      <path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}
