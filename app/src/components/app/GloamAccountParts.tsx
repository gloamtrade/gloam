"use client";

import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { Spinner } from "@/components/ui/Spinner";
import { EMBEDDED_WALLETS, embeddedRpId } from "@/lib/embeddedWallet";
import { embeddedAuth, onEmbeddedAuth } from "@/lib/turnkeyBridge";
import { GLOAM_SOLANA_OFF, gloamSolana, onGloamSolana, retryGloamSolana } from "@/lib/turnkeySolana";
import { codeRootFor, keptCodeSecret } from "@/lib/solanaRings/gloamCodes";
import {
  BAD_CODE_TEXT,
  accountSeedFromRoot,
  backupCodeFor,
  gloamOpenView,
  newCodeSecret,
  passkeyRoot,
  secretFromBackupCode,
  type GloamOpenMode,
} from "@/lib/solanaRings/gloamRoot";
import { useSolana } from "./SolanaAccount";

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

/** What the setup card's button is: the card's own SolanaActionButton, with `stop` when it can't go yet. */
export type GloamAccountAction = (label: string, onClick: () => void, stop?: string | null) => ReactNode;

/**
 * How a Gloam account (lib/turnkeySolana) opens its private account on Solana,
 * in the setup card: never from a signature, which Turnkey keeps, but from a
 * secret Turnkey never sees (lib/solanaRings/gloamRoot).
 *  - This browser keeps the account's backup code: it opens with no prompt.
 *    The passkey and another code stay a tap away: a code kept here (made here,
 *    or brought in by a recovery backup) never locks out the account another opens.
 *  - Signed in with a passkey: the passkey opens it (one prompt), on every
 *    device that has the passkey. "Use a backup code" stays open for a browser
 *    where the passkey can't.
 *  - Signed in with an email alone: a backup code made here, shown once to save,
 *    then kept sealed in this browser (lib/solanaRings/gloamCodes) and in a
 *    passkey recovery backup. A new device asks for it.
 */
export function GloamAccountOpen({ returning, action }: { returning: boolean; action: GloamAccountAction }) {
  const sol = useSolana();
  const gloam = useSyncExternalStore(onGloamSolana, gloamSolana, () => GLOAM_SOLANA_OFF);
  return (
    <GloamRootOpen
      owner={sol?.main?.account.address ?? null}
      passkeys={gloam.passkeys}
      task={sol?.task ?? null}
      returning={returning}
      codes={SOLANA_CODES}
      seedFromRoot={accountSeedFromRoot}
      open={(opener) => void sol?.setUp(opener)}
      action={action}
    />
  );
}

const SOLANA_CODES: GloamRootCodes = { kept: keptCodeSecret, rootFor: codeRootFor };

/** How a private account opens from a root: what the wait's first step says, and its seed for an index. */
export type GloamRootOpener = { first: string; seed: (index: number) => Promise<Uint8Array> };

/** Where a network keeps a Gloam wallet's backup-code secrets (lib/solanaRings/gloamCodes, lib/starknetPrivacy/gloamCodes). */
export type GloamRootCodes = {
  kept(owner: string): Promise<Uint8Array | null>;
  rootFor(owner: string, secret: Uint8Array | null, typed?: boolean): Promise<Uint8Array>;
};

/**
 * The open card itself, for any network whose Gloam-wallet private account
 * opens from a root (a passkey's PRF output or a backup code): Solana
 * (GloamAccountOpen, above) and Starknet (StarknetParts). `owner` is the
 * Gloam wallet's address on that network, `codes` where that network keeps
 * its backup codes, `seedFromRoot` its own salted derivation, and `open` its
 * setUp. `task` is the network's wait, while one runs.
 */
export function GloamRootOpen({
  owner,
  passkeys,
  task,
  returning,
  codes,
  seedFromRoot,
  open,
  action,
}: {
  owner: string | null;
  passkeys: readonly string[];
  task: unknown;
  returning: boolean;
  codes: GloamRootCodes;
  seedFromRoot: (root: Uint8Array, kind: "passkey" | "code", index: number) => Promise<Uint8Array>;
  open: (opener: GloamRootOpener) => void;
  action: GloamAccountAction;
}) {
  const passkey = passkeys.length > 0;
  const [stored, setStored] = useState<{ owner: string; has: boolean } | null>(null);
  const [mode, setMode] = useState<GloamOpenMode>("auto");
  const [fresh, setFresh] = useState<{ owner: string; secret: Uint8Array; code: string } | null>(null);
  const [saved, setSaved] = useState(false);
  const [typed, setTyped] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const busy = Boolean(task);

  // Whether this browser keeps this account's backup code (read once per account).
  useEffect(() => {
    if (!owner) return;
    let live = true;
    void codes
      .kept(owner)
      .then((secret) => {
        secret?.fill(0);
        if (live) setStored({ owner, has: Boolean(secret) });
      })
      .catch(() => live && setStored({ owner, has: false }));
    return () => {
      live = false;
    };
  }, [owner, task, codes]);

  // The code made for this account is wiped from memory when the card goes.
  useEffect(
    () => () => {
      fresh?.secret.fill(0);
    },
    [fresh],
  );

  if (!owner) return null;
  const known = stored?.owner === owner ? stored.has : null;

  /**
   * Open with a backup code: `secret` (made here, or `typed`), or the one this browser
   * keeps. Kept first, never over another; a typed code opens even when another is kept (lib/solanaRings/gloamCodes codeRootFor).
   */
  const openWithCode = (secret: Uint8Array | null, typed = false) =>
    open({
      first: "Reading your backup code",
      seed: async (index) => {
        const root = await codes.rootFor(owner, secret, typed);
        try {
          return await seedFromRoot(root, "code", index);
        } finally {
          root.fill(0);
        }
      },
    });

  const openWithPasskey = () =>
    open({
      first: "Confirm with your passkey",
      seed: async (index) => {
        const root = await passkeyRoot({ rpId: embeddedRpId(window.location.hostname), credentialIds: passkeys });
        try {
          return await seedFromRoot(root, "passkey", index);
        } finally {
          root.fill(0);
        }
      },
    });

  const lead = (text: string) => <p className="mt-4 max-w-[56ch] text-[13.5px] leading-relaxed text-mute">{text}</p>;
  const link = (text: string, onClick: () => void) => (
    <button type="button" disabled={busy} onClick={onClick} className="btn btn-quiet btn-sm mt-2 h-10 text-mute">
      {text}
    </button>
  );

  const view = gloamOpenView({ mode, known: Boolean(known), passkey, returning, fresh: fresh?.owner === owner });

  if (known === null) {
    return (
      <p role="status" aria-live="polite" className="mt-5 flex items-center gap-2.5 rounded-[16px] bg-surface px-4 py-3.5 text-[13.5px] text-foreground">
        <Spinner />
        Checking this browser
      </p>
    );
  }

  // Kept here: no prompt at all. The passkey or another code is still the person's to pick.
  if (view === "kept") {
    return (
      <>
        {lead("This browser keeps your backup code, so your private account opens with no prompt.")}
        {action(returning ? "Open your private account" : "Set up your private account", () => openWithCode(null))}
        {passkey && link("Use my passkey instead", () => setMode("passkey"))}
        {link("Use another backup code", () => setMode("code-enter"))}
      </>
    );
  }

  if (view === "code-show" && fresh) {
    const copy = () =>
      void navigator.clipboard?.writeText(fresh.code).then(
        () => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1400);
        },
        () => undefined,
      );
    return (
      <>
        {lead("Save this code somewhere safe, like a password manager. It opens your private account on a new device, and it is shown only once.")}
        <div className="mt-4 flex items-center gap-3 rounded-[16px] bg-surface py-3 pl-4 pr-2">
          <p className="tnum min-w-0 flex-1 select-all break-all text-[15px] font-medium tracking-wide text-foreground" aria-label="Your backup code">
            {fresh.code}
          </p>
          <button type="button" onClick={copy} className="btn btn-quiet btn-sm h-10 shrink-0">
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
        <label className="mt-4 flex cursor-pointer items-start gap-3 rounded-[14px] px-1 py-1">
          <input type="checkbox" checked={saved} disabled={busy} onChange={(e) => setSaved(e.target.checked)} className="mt-0.5 h-4 w-4 shrink-0 accent-ink" />
          <span className="text-[13.5px] text-foreground">I saved my backup code</span>
        </label>
        {action("Continue", () => openWithCode(fresh.secret), saved ? null : "Save your code to continue")}
      </>
    );
  }

  if (view === "code-enter") {
    const go = async () => {
      setProblem(null);
      const secret = await secretFromBackupCode(typed);
      if (!secret) {
        setProblem(BAD_CODE_TEXT);
        return;
      }
      openWithCode(secret, true);
    };
    return (
      <>
        {lead("Enter the backup code you saved when you set up your private account.")}
        <label htmlFor="gloam-backup-code" className="mt-4 block text-[13px] text-mute">
          Backup code
        </label>
        <input
          id="gloam-backup-code"
          className="gl-input tnum mt-1.5 text-[15px] tracking-wide"
          value={typed}
          onChange={(e) => {
            setTyped(e.target.value);
            setProblem(null);
          }}
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="characters"
          placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX"
          disabled={busy}
          aria-invalid={Boolean(problem) || undefined}
        />
        {problem && (
          <p role="alert" className="mt-1.5 text-[13px] text-danger">
            {problem}
          </p>
        )}
        {action("Open your private account", () => void go(), typed.trim() ? null : "Enter your backup code")}
        {link(passkey ? "Use my passkey instead" : known ? "Back" : returning ? "I don't have a code: set up a new private account" : "Back", () => {
          setProblem(null);
          setMode(passkey ? "passkey" : known ? "auto" : "code-new");
        })}
      </>
    );
  }

  if (view === "passkey") {
    return (
      <>
        {lead(
          returning
            ? "Your passkey opens it again. Nothing new is created."
            : "Your passkey opens it, on any device that has the passkey. The key comes from your passkey, so Turnkey and Gloam's servers never see it.",
        )}
        {action(returning ? "Open with passkey" : "Set up with passkey", openWithPasskey)}
        {link("No passkey here? Use a backup code", () => setMode("code-new"))}
      </>
    );
  }

  // Email sign-in (or a passkey that can't here): a backup code made in this browser.
  const make = () => {
    fresh?.secret.fill(0);
    const secret = newCodeSecret();
    void backupCodeFor(secret).then((code) => {
      setFresh({ owner, secret, code });
      setSaved(false);
      setMode("code-show");
    });
  };
  return (
    <>
      {lead("A backup code opens it. The code is made in this browser, so Turnkey and Gloam's servers never see it.")}
      {action("Make my backup code", make)}
      {link("I have a backup code", () => setMode("code-enter"))}
      {passkey && link("Use my passkey instead", () => setMode("passkey"))}
    </>
  );
}
