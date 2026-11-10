"use client";

import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { useDisconnect } from "wagmi";
import { walletParamsForChain } from "@/lib/chain";
import { exitDemo, useAppAccount } from "@/lib/demo";
import { useNetwork } from "./NetworkProvider";
import { faucetFor } from "@/lib/faucet";
import { addableTokensFor } from "@/lib/tokens";
import { useOpenGatedTokens } from "@/hooks/useOpenGatedTokens";
import {
  exportNotesBackup,
  importNotesBackup,
} from "@/lib/shield";
import {
  isSealedBackup,
  openWithPassphrase,
  sealWithPassphrase,
} from "@/lib/secretBox";
import {
  circuitArtifactsFor,
  assertTransferArtifacts,
  assertUnshieldArtifacts,
} from "@/lib/circuitArtifacts";
import { resetOnboarding } from "@/lib/onboarding";
import { lockVault } from "@/lib/noteVault";
import {
  NO_PRF_MESSAGE,
  PasskeyError,
  confirmWithPasskey,
  passkeySupport,
  protectWithPasskey,
  removePasskey,
  useVaultStatus,
  type PasskeySupport,
} from "@/lib/passkey";
import { useTradingSettings } from "@/hooks/useTradingSettings";
import { ThemeSegmented } from "@/components/ThemeToggle";
import { WalletMenu } from "./WalletMenu";
import { StatusPill } from "./StatusPill";
import { VaultHealth } from "./VaultHealth";
import { RecoverySettingsCard } from "./RecoveryPanel";
import { restoreMessage } from "@/lib/restoreMessage";
import { embeddedSignInEmail, onEmbeddedSignInEmail } from "@/lib/turnkeyBridge";
import { subscribeToUpdates } from "@/lib/updatesClient";
import { BusyLabel } from "@/components/ui/Spinner";

/* ------------------------------------------------------------ primitives */

function Card({
  id,
  title,
  description,
  children,
  flush = false,
}: {
  id?: string;
  title: string;
  description?: ReactNode;
  children: ReactNode;
  /** Rows run edge to edge with hairlines (true) or sit in padded body (false). */
  flush?: boolean;
}) {
  return (
    <section id={id} className="gl-card scroll-mt-24">
      <header className="max-sm:px-5 max-sm:pt-5 sm:px-6 sm:pt-6">
        <h2 className="text-[17px] text-foreground">{title}</h2>
        {description && (
          <p className="mt-1 max-w-[62ch] text-[13.5px] leading-relaxed text-mute">{description}</p>
        )}
      </header>
      <div
        className={
          flush
            ? "mt-2 divide-y divide-line pb-1 max-sm:px-5 sm:px-6"
            : "pt-4 max-sm:px-5 max-sm:pb-5 sm:px-6 sm:pb-6"
        }
      >
        {children}
      </div>
    </section>
  );
}

function Row({
  label,
  hint,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 py-4">
      <div className="min-w-0 max-w-[52ch]">
        <p className="text-[14px] text-foreground">{label}</p>
        {hint && <p className="mt-0.5 text-[13px] leading-relaxed text-mute">{hint}</p>}
      </div>
      {children && <div className="flex min-w-0 max-w-full shrink-0 flex-wrap items-center gap-2">{children}</div>}
    </div>
  );
}

function Toggle({
  on,
  onChange,
  label,
  hint,
}: {
  on: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hint?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={() => onChange(!on)}
      className="group flex min-h-[64px] w-full items-center justify-between gap-6 py-4 text-left"
    >
      <span className="min-w-0">
        <span className="block text-[14px] text-foreground" aria-hidden>
          {label}
        </span>
        {hint && (
          <span className="mt-0.5 block text-[13px] leading-relaxed text-mute">{hint}</span>
        )}
      </span>
      <span
        className={`relative inline-flex h-6 w-10 shrink-0 items-center rounded-full transition-colors duration-200 ${
          on ? "bg-ink" : "bg-line-strong group-hover:bg-faint"
        }`}
        aria-hidden
      >
        <span
          className={`absolute h-5 w-5 rounded-full shadow-card transition-transform duration-200 ${
            on ? "translate-x-[18px] bg-on-ink" : "translate-x-0.5 bg-panel"
          }`}
        />
      </span>
    </button>
  );
}

function Segmented({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div role="group" aria-label={label} className="inline-flex rounded-full bg-surface p-1 text-[13px]">
      {children}
    </div>
  );
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`gl-tap h-8 rounded-full px-3.5 capitalize transition-colors duration-200 ${
        active
          ? "bg-panel text-foreground shadow-card"
          : "text-mute hover:text-foreground"
      }`}
    >
      {children}
    </button>
  );
}

function Status({ children }: { children: ReactNode }) {
  return (
    <p className="mt-3 rounded-[12px] bg-surface px-3.5 py-2.5 text-[13px] leading-relaxed text-soft" role="status">
      {children}
    </p>
  );
}

/* ------------------------------------------------------------ updates */

/**
 * Email updates: subscribe with an email. Filled in only with the email a Gloam
 * wallet signed in with, when this page already has it in memory. Only the email
 * is sent (lib/updatesClient); the wallet never goes with it. Leaving is by the
 * link in every update, never by typing an email, so nobody can take someone
 * else off the list.
 */
function UpdatesCard() {
  const signInEmail = useSyncExternalStore(onEmbeddedSignInEmail, embeddedSignInEmail, () => null);
  const [typed, setTyped] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const email = typed ?? signInEmail ?? "";

  async function run() {
    if (busy) return;
    setBusy(true);
    setMsg(null);
    const res = await subscribeToUpdates(email, "settings");
    setBusy(false);
    setMsg(res.ok ? "You're on the list. Every update has an unsubscribe link." : res.message);
  }

  return (
    <Card
      title="Email updates"
      description="News about Gloam now and then. We keep only the email, apart from your wallet."
    >
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
      >
        <label htmlFor="updates-email" className="sr-only">
          Email
        </label>
        <input
          id="updates-email"
          type="email"
          inputMode="email"
          autoComplete="email"
          autoCapitalize="none"
          spellCheck={false}
          maxLength={254}
          placeholder="you@example.com"
          className="gl-input h-10 min-w-0 flex-1 basis-[220px] text-[14px]"
          value={email}
          onChange={(e) => setTyped(e.target.value)}
        />
        <button type="submit" disabled={busy || !email.trim()} aria-busy={busy} className="btn btn-ink btn-sm h-10">
          <BusyLabel busy={busy}>Subscribe</BusyLabel>
        </button>
      </form>
      {msg && <Status>{msg}</Status>}
      <p className="mt-3 text-[13px] leading-relaxed text-mute">
        To leave, open the unsubscribe link at the bottom of any update.
      </p>
    </Card>
  );
}

/* ------------------------------------------------------------ passkey */

function passkeyMessage(e: unknown, fallback: string): string {
  return e instanceof PasskeyError ? e.message : fallback;
}

/** Passkey lock: protect, lock now, remove. Off in the recording demo. */
function PasskeyCard({ demo }: { demo: boolean }) {
  const vault = useVaultStatus();
  const [support, setSupport] = useState<PasskeySupport | null>(null);
  const [busy, setBusy] = useState<"create" | "remove" | "lock" | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void passkeySupport().then((s) => {
      if (live) setSupport(s);
    });
    return () => {
      live = false;
    };
  }, []);

  async function create() {
    setBusy("create");
    setMsg(null);
    try {
      await protectWithPasskey();
      setMsg("Locked with your passkey. Gloam asks for it each time the app opens.");
    } catch (e) {
      setMsg(passkeyMessage(e, "Could not set up the passkey. Nothing changed."));
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    setBusy("remove");
    setMsg(null);
    try {
      await removePasskey();
      setMsg(
        "Passkey lock removed. Your balance stays encrypted with this browser's device key. You can delete the passkey itself in your password manager."
      );
    } catch (e) {
      setMsg(passkeyMessage(e, "Could not remove the passkey. Nothing changed."));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card
      title="Passkey lock"
      description="Lock your private balance on this browser with Face ID, Touch ID, or a security key. Gloam asks for it each time the app opens."
      flush
    >
      {demo ? (
        <Row label="Passkey lock" hint="Off in the demo." />
      ) : vault.protected ? (
        <>
          <Row
            label={
              <span className="inline-flex items-center gap-2">
                Passkey lock
                <StatusPill tone="lime" dot>
                  On
                </StatusPill>
              </span>
            }
            hint="Unlocked in this tab. Lock it now when you step away."
          >
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => {
                setBusy("lock");
                void lockVault();
              }}
              className="btn btn-ghost btn-sm h-10"
            >
              {busy === "lock" ? "Locking…" : "Lock now"}
            </button>
          </Row>
          <Row
            label="Remove passkey"
            hint="Asks for your passkey, then goes back to this browser's device key."
          >
            <button
              type="button"
              disabled={busy !== null}
              onClick={remove}
              className="btn btn-quiet btn-sm h-10 text-mute"
            >
              {busy === "remove" ? "Waiting for your passkey…" : "Remove passkey"}
            </button>
          </Row>
        </>
      ) : support === "no" ? (
        <Row label="Passkey lock" hint={NO_PRF_MESSAGE} />
      ) : (
        <Row
          label="Protect with a passkey"
          hint="Save a backup first. If you lose the passkey, only a backup brings your balance back."
        >
          <button
            type="button"
            disabled={busy !== null || support === null}
            onClick={create}
            className="btn btn-ink btn-sm h-10"
          >
            {busy === "create" ? "Waiting for your passkey…" : "Protect with a passkey"}
          </button>
        </Row>
      )}
      {msg && (
        <div className="py-4">
          <Status>{msg}</Status>
        </div>
      )}
    </Card>
  );
}

/* ------------------------------------------------------------ view */

export function SettingsView() {
  const openGated = useOpenGatedTokens();
  const { address, isConnected, chainId, demo } = useAppAccount();
  const { disconnect: wagmiDisconnect } = useDisconnect();
  const disconnect = demo ? exitDemo : wagmiDisconnect;
  const { network } = useNetwork();
  const { settings, setSettings } = useTradingSettings();
  const [copied, setCopied] = useState(false);
  const [netMsg, setNetMsg] = useState<string | null>(null);
  const [backupMsg, setBackupMsg] = useState<string | null>(null);
  // A backup is per wallet: with none connected, export would take every wallet's balances on this browser.
  const backupReady = isConnected && Boolean(address);
  const [backupImport, setBackupImport] = useState("");
  const [backupPass, setBackupPass] = useState("");
  const [integrityMsg, setIntegrityMsg] = useState<string | null>(null);
  const [integrityBusy, setIntegrityBusy] = useState(false);
  const vault = useVaultStatus();
  const exportOkUntil = useRef(0);

  /**
   * A backup holds spend keys: with a passkey lock on, exporting asks for it.
   * One confirmation covers a minute of copy and download.
   */
  async function passkeyAllowsExport(): Promise<boolean> {
    if (!vault.protected || Date.now() < exportOkUntil.current) return true;
    try {
      await confirmWithPasskey();
      exportOkUntil.current = Date.now() + 60_000;
      return true;
    } catch (e) {
      setBackupMsg(passkeyMessage(e, "Could not check your passkey. Nothing was exported."));
      return false;
    }
  }

  useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(t);
  }, [copied]);

  async function copyAddr() {
    if (!address) return;
    await navigator.clipboard.writeText(address);
    setCopied(true);
  }

  async function addNetwork() {
    setNetMsg(null);
    const eth = (
      window as Window & {
        ethereum?: {
          request: (a: {
            method: string;
            params?: unknown[];
          }) => Promise<unknown>;
        };
      }
    ).ethereum;
    if (!eth?.request) {
      setNetMsg("No wallet found.");
      return;
    }
    try {
      await eth.request({
        method: "wallet_addEthereumChain",
        params: [walletParamsForChain(network.chain)],
      });
      setNetMsg("Network ready.");
    } catch (e) {
      setNetMsg(
        e instanceof Error ? e.message.slice(0, 120) : "Could not add network"
      );
    }
  }

  const onProduct = chainId === network.chainId;
  const faucet = faucetFor(network.key);
  // Trading preferences only mean something where there are markets to trade.
  const isTempo = !network.stocks;

  return (
    <div className="max-w-[880px] space-y-5">
      {/* Account: wallet + appearance */}
      <Card title="Account" flush>
        {!isConnected || !address ? (
          <Row label="Wallet" hint="Connect to manage your session.">
            <WalletMenu />
          </Row>
        ) : (
          <div className="py-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-[14px] text-foreground">Wallet</p>
                <p className="tnum mt-0.5 break-all text-[13px] text-mute">{address}</p>
              </div>
              {onProduct ? (
                <StatusPill tone="mute" dot>
                  On {network.label}
                </StatusPill>
              ) : (
                <StatusPill tone="warn" dot>
                  Wrong network
                </StatusPill>
              )}
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <button type="button" onClick={copyAddr} className="btn btn-ghost btn-sm h-10">
                {copied ? "Copied" : "Copy address"}
              </button>
              <a
                href={network.explorerAddress(address)}
                target="_blank"
                rel="noreferrer"
                className="btn btn-ghost btn-sm h-10"
              >
                Explorer
              </a>
              <button type="button" onClick={() => disconnect()} className="btn btn-quiet btn-sm h-10 text-mute">
                Disconnect
              </button>
            </div>
          </div>
        )}
        <Row label="Appearance" hint="Light, dark, or match your device.">
          <ThemeSegmented />
        </Row>
      </Card>

      {/* Preferences */}
      <Card title="Preferences" flush>
        {!isTempo && (
          <>
            <Row label="Default side" hint="Where the trade ticket starts.">
              <Segmented label="Default side">
                <Chip
                  active={settings.defaultSide === "buy"}
                  onClick={() => setSettings({ defaultSide: "buy" })}
                >
                  Buy
                </Chip>
                <Chip
                  active={settings.defaultSide === "sell"}
                  onClick={() => setSettings({ defaultSide: "sell" })}
                >
                  Sell
                </Chip>
              </Segmented>
            </Row>
            <Row label="Markets filter" hint="What Markets shows first.">
              <Segmented label="Markets filter">
                {(
                  [
                    ["all", "All"],
                    ["onchain", "Crypto"],
                    ["stocks", "Stocks"],
                  ] as const
                ).map(([k, label]) => (
                  <Chip
                    key={k}
                    active={settings.marketFilter === k}
                    onClick={() => setSettings({ marketFilter: k })}
                  >
                    {label}
                  </Chip>
                ))}
              </Segmented>
            </Row>
          </>
        )}
        <Toggle
          on={settings.showUsd}
          onChange={(v) => setSettings({ showUsd: v })}
          label="Show USD"
          hint="Dollar values on Portfolio and in trades."
        />
        <Toggle
          on={settings.hideZeroBalances}
          onChange={(v) => setSettings({ hideZeroBalances: v })}
          label="Hide empty"
          hint="Only list tokens you hold."
        />
        <Toggle
          on={settings.confirmSends}
          onChange={(v) => setSettings({ confirmSends: v })}
          label="Success message"
          hint="Show a message after a send goes through."
        />
        {!isTempo && (
          <Toggle
            on={settings.compactCharts}
            onChange={(v) => setSettings({ compactCharts: v })}
            label="Compact charts"
            hint="Smaller charts on Trade."
          />
        )}
        <Toggle
          on={settings.fastSend}
          onChange={(v) => setSettings({ fastSend: v })}
          label="Fast send"
          hint="Skip the review step. You still confirm in your wallet, and we never hold keys."
        />
      </Card>

      {/* Network + faucet */}
      <Card title="Network" flush>
        <div className="py-4">
          <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
            <div className="min-w-0">
              <p className="text-[14px] text-foreground">
                {network.label}{network.testnet ? " testnet" : " mainnet"}
              </p>
              <p className="mt-0.5 text-[13px] text-mute">
                {faucet ? (
                  <>Test funds: {faucet.assets}</>
                ) : (
                  <>Assets: {addableTokensFor(network.chainId, openGated).map((t) => t.symbol).join(" · ")}</>
                )}
              </p>
            </div>
            <button type="button" onClick={addNetwork} className="btn btn-ghost btn-sm h-10">
              Add to wallet
            </button>
          </div>
          {netMsg && <Status>{netMsg}</Status>}
        </div>
        {faucet && (
          <Row label={faucet.title} hint={faucet.blurb}>
            <a
              href={faucet.url}
              target={faucet.url.startsWith("http") ? "_blank" : undefined}
              rel={faucet.url.startsWith("http") ? "noreferrer" : undefined}
              className="btn btn-ghost btn-sm h-10"
            >
              {faucet.cta.replace(/\s*→\s*$/, "")}
            </a>
          </Row>
        )}
      </Card>

      <RecoverySettingsCard />

      <PasskeyCard demo={demo} />

      {/* Vault note backup, secrets leave this browser only when you export */}
      <Card
        id="backup"
        title="Backup"
        description="Your private balances live in this browser. Export a backup before you clear site data, and add a passphrase so a stolen file can't be spent."
      >
        <div className="flex items-start gap-3 rounded-[14px] bg-warn-soft px-4 py-3 text-[13px] leading-relaxed text-warn">
          <svg className="mt-0.5 h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="none" aria-hidden>
            <circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeWidth="1.6" />
            <path d="M12 7.75v5M12 16.25v.01" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
          <span>
            If you lose this backup, you lose access to your vault. Nobody can
            recover it, including us.
          </span>
        </div>
        <p className="mt-4 max-w-[62ch] text-[13px] leading-relaxed text-mute">
          A backup holds your balances themselves, not this browser&apos;s key or
          your passkey. To restore it on any browser you need only the backup,
          plus its passphrase if you set one. Each backup holds one network, the one you&apos;re on now: {network.label}.
          Switch networks to back up the others.
          {vault.protected && " With the passkey lock on, exporting asks for your passkey."}
        </p>
        {!backupReady && (
          <Status>
            Connect your wallet to back up or restore. A backup holds the private balances of the wallet you
            connect, and a restore adds them to that wallet, so nothing is copied or restored until one is
            connected.
          </Status>
        )}

        <label htmlFor="backup-pass" className="mt-5 block text-[13px] text-mute">
          Backup passphrase <span className="text-faint">(recommended)</span>
        </label>
        <input
          id="backup-pass"
          type="password"
          autoComplete="new-password"
          value={backupPass}
          onChange={(e) => setBackupPass(e.target.value)}
          placeholder="Locks and unlocks the backup"
          className="gl-input mt-2 max-w-[440px]"
        />
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            disabled={!backupReady}
            onClick={async () => {
              setBackupMsg(null);
              try {
                // Build the text and hand the clipboard a promise of it inside this click.
                // A plain writeText after the passkey prompt and the slow passphrase lock
                // can be refused once the click has expired, which left whatever was on
                // the clipboard before in place. The notes are read from the store as it
                // is now: another tab may have secured a claim since this page opened.
                let count = 0;
                const textPromise = (async () => {
                  const backup = await exportNotesBackup(address);
                  if (!backup.notes.length) throw new Error("empty");
                  if (!(await passkeyAllowsExport())) throw new Error("cancelled");
                  count = backup.notes.length;
                  const json = JSON.stringify(backup, null, 2);
                  return backupPass.trim() ? await sealWithPassphrase(json, backupPass) : json;
                })();
                try {
                  if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
                    await navigator.clipboard.write([
                      new ClipboardItem({ "text/plain": textPromise.then((t) => new Blob([t], { type: "text/plain" })) }),
                    ]);
                  } else {
                    await navigator.clipboard.writeText(await textPromise);
                  }
                } catch (err) {
                  const why = await textPromise.then(
                    () => null,
                    (e: unknown) => (e instanceof Error ? e.message : null)
                  );
                  if (why === "empty") {
                    setBackupMsg("No private balances to export.");
                    return;
                  }
                  if (why === "cancelled" || (err instanceof Error && err.message === "cancelled")) return;
                  // Last try: write the finished text directly.
                  const text = await textPromise.catch(() => null);
                  if (text === null) return;
                  await navigator.clipboard.writeText(text).catch(() => {
                    throw new Error("Your browser blocked the copy. Press Copy backup again, or use Download.");
                  });
                }
                setBackupMsg(
                  backupPass.trim()
                    ? `Copied a locked backup (${count} balance(s) on ${network.label}).`
                    : `Copied a plain backup (${count} balance(s) on ${network.label}). Anyone with this file can spend it.`
                );
              } catch (e) {
                setBackupMsg(
                  e instanceof Error ? e.message : "Could not copy backup."
                );
              }
            }}
            className="btn btn-ink"
          >
            Copy backup
          </button>
          <button
            type="button"
            disabled={!backupReady}
            onClick={async () => {
              setBackupMsg(null);
              try {
                const backup = await exportNotesBackup(address);
                if (backup.notes.length && !(await passkeyAllowsExport())) return;
                const json = JSON.stringify(backup, null, 2);
                const text = backupPass.trim()
                  ? await sealWithPassphrase(json, backupPass)
                  : json;
                const blob = new Blob([text], {
                  type: backupPass.trim()
                    ? "text/plain"
                    : "application/json",
                });
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url;
                a.download = backupPass.trim()
                  ? `gloam-notes-locked-${Date.now()}.txt`
                  : `gloam-notes-${Date.now()}.json`;
                a.click();
                URL.revokeObjectURL(url);
                setBackupMsg(
                  backup.notes.length
                    ? `Downloaded ${backup.notes.length} balance(s) on ${network.label}${
                        backupPass.trim() ? ", locked" : ""
                      }.`
                    : "Empty backup file downloaded."
                );
              } catch (e) {
                setBackupMsg(
                  e instanceof Error ? e.message : "Download failed."
                );
              }
            }}
            className="btn btn-ghost"
          >
            Download
          </button>
        </div>

        <div className="mt-6 border-t border-line pt-5">
          <label htmlFor="backup-import" className="block text-[14px] text-foreground">
            Restore a backup
          </label>
          <p className="mt-0.5 text-[13px] text-mute">
            Paste a plain or locked backup. For a locked one, enter its passphrase above.
          </p>
          <textarea
            id="backup-import"
            value={backupImport}
            onChange={(e) => setBackupImport(e.target.value)}
            rows={3}
            placeholder="Paste your backup here"
            className="gl-input tnum mt-3 h-auto resize-y break-all py-3 text-[12.5px] leading-relaxed"
          />
          <button
            type="button"
            disabled={!backupImport.trim() || !backupReady}
            onClick={() => {
              void (async () => {
                setBackupMsg(null);
                try {
                  let raw = backupImport.trim();
                  if (isSealedBackup(raw)) {
                    if (!backupPass.trim()) {
                      setBackupMsg("Enter the passphrase for this locked backup.");
                      return;
                    }
                    raw = await openWithPassphrase(raw, backupPass);
                  }
                  // the vault is asked about each note new here, so one spent since the backup never shows as money
                  setBackupMsg("Checking this backup against the vault…");
                  const { backupSeenCheck, backupSpentCheck } = await import("@/lib/claimSweep");
                  const res = await importNotesBackup(raw, address, backupSpentCheck(), backupSeenCheck());
                  if (res.ok) {
                    setBackupMsg(restoreMessage(res));
                    setBackupImport("");
                  } else {
                    setBackupMsg(res.error);
                  }
                } catch (e) {
                  setBackupMsg(
                    e instanceof Error ? e.message : "Import failed."
                  );
                }
              })();
            }}
            className="btn btn-ghost mt-3"
          >
            Restore
          </button>
        </div>
        {backupMsg && <Status>{backupMsg}</Status>}
        <p className="mt-5 text-[12.5px] leading-relaxed text-mute">
          {!network.paymentsPool
            ? "To stay private, keep money in your vault and send or trade from there."
            : "To stay private, keep money in your vault and send from there."}{" "}
          Cashing out shows the amount.
        </p>
      </Card>

      <Card title="Vault health">
        <VaultHealth />
      </Card>

      <Card
        title="Proof files"
        description={
          <>
            Your browser builds private payments with these files.{" "}
            {network.ceremony === "dev"
              ? "This network uses test keys, for testnet only."
              : "This network uses the final keys from Gloam's trusted setup."}
          </>
        }
      >
        <ul className="divide-y divide-line rounded-[14px] bg-surface px-4">
          {(
            [
              ["Cash out proof key", circuitArtifactsFor(network.ceremony).unshieldZkey.sha256],
              ["Send proof key", circuitArtifactsFor(network.ceremony).transferZkey.sha256],
              ["Cash out proof program", circuitArtifactsFor(network.ceremony).unshieldWasm.sha256],
              ["Send proof program", circuitArtifactsFor(network.ceremony).transferWasm.sha256],
            ] as const
          ).map(([label, hash]) => (
            <li key={label} className="flex min-h-[44px] justify-between gap-x-4 gap-y-0.5 py-2.5 max-sm:flex-col sm:items-center">
              <span className="text-[13px] text-mute">{label}</span>
              <span className="tnum text-[12.5px] text-soft">
                {hash.slice(0, 12)}…{hash.slice(-8)}
              </span>
            </li>
          ))}
        </ul>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={integrityBusy}
            onClick={() => {
              void (async () => {
                setIntegrityBusy(true);
                setIntegrityMsg(null);
                try {
                  await assertUnshieldArtifacts();
                  await assertTransferArtifacts();
                  setIntegrityMsg("All four proof files check out.");
                } catch (e) {
                  setIntegrityMsg(
                    e instanceof Error ? e.message : "Check failed. Files do not match."
                  );
                } finally {
                  setIntegrityBusy(false);
                }
              })();
            }}
            className="btn btn-ghost btn-sm h-10"
          >
            {integrityBusy ? "Checking…" : "Verify proof files"}
          </button>
          <a href="/docs/production" className="btn btn-quiet btn-sm h-10 text-mute">
            Going live
          </a>
          <button
            type="button"
            className="btn btn-quiet btn-sm h-10 text-mute"
            onClick={() => {
              resetOnboarding();
              setIntegrityMsg("Start checklist restored on Portfolio.");
            }}
          >
            Show start checklist
          </button>
        </div>
        {integrityMsg && <Status>{integrityMsg}</Status>}
      </Card>

      <UpdatesCard />

      <Card id="help" title="Help" flush>
        <Row label="Telegram" hint="Ask the team and other testers.">
          <a href="https://t.me/gloamhq" target="_blank" rel="noreferrer" className="btn btn-ghost btn-sm h-10">
            Open group
          </a>
        </Row>
        <Row label="Email" hint="hello@gloam.trade, for bugs, questions and partners.">
          <a href="mailto:hello@gloam.trade" className="btn btn-ghost btn-sm h-10">
            Write to us
          </a>
        </Row>
        <Row label="X" hint="Updates and releases from @gloamtrade.">
          <a href="https://x.com/gloamtrade" target="_blank" rel="noreferrer" className="btn btn-ghost btn-sm h-10">
            Follow
          </a>
        </Row>
      </Card>
    </div>
  );
}
