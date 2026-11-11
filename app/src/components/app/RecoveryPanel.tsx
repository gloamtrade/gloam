"use client";

import { IntentLink } from "@/components/IntentLink";
import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { useSignMessage } from "wagmi";
import { useAppAccount } from "@/lib/demo";
import { WALLET_BROWSER_NOTE, inWalletBrowser, passkeySupport } from "@/lib/passkey";
import {
  RecoveryError,
  VERSION1_SAVES_UNTIL,
  backupNow,
  bringInOlderBackup,
  connectRecovery,
  keysFromSecret,
  passkeySecret,
  recoveryServerState,
  recoveryState,
  restoreOlderBackup,
  restoreWithWallet,
  startRecoverySync,
  subscribeRecovery,
  turnOffRecovery,
  turnOnWithWallet,
  updateRecoveryKey,
  type RecoverySource,
  type RecoveryState,
  type RecoveryWallet,
} from "@/lib/recovery";
import { isTempoWallet } from "@/lib/tempoWallet";
import { EMBEDDED_CONNECTOR_ID } from "@/lib/embeddedWallet";
import { TURNKEY_CAN_OPEN_TEXT } from "@/lib/embeddedRecovery";
import { useAutoRestore } from "@/hooks/useAutoRestore";

type Busy = "on-wallet" | "on-passkey" | "restore-wallet" | "restore-passkey" | "restore-older" | "save" | "off" | "update" | "older" | null;
/** "wait": nothing went wrong and nothing is finished yet, so it is not shown as done. */
type Message = { tone: "ok" | "wait" | "error"; text: string } | null;

function errorText(e: unknown): string {
  const name = (e as { name?: string } | null)?.name ?? "";
  const text = e instanceof Error ? e.message : "";
  if (name === "UserRejectedRequestError" || /reject|denied|cancel/i.test(text)) {
    return "Signing was cancelled. Nothing changed.";
  }
  return e instanceof RecoveryError ? e.message : "Something went wrong. Nothing changed. Try again.";
}

function notFound(e: unknown): boolean {
  return e instanceof RecoveryError && e.code === "notfound";
}

function plural(n: number, word: string) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function ago(ts: number | null): string {
  if (!ts) return "not backed up yet";
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return "backed up just now";
  if (s < 3600) return `backed up ${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `backed up ${Math.round(s / 3600)} h ago`;
  return `backed up ${new Date(ts).toLocaleDateString()}`;
}

/** When this browser tries again by itself. */
function nextTry(ts: number | null): string {
  if (!ts) return "soon";
  const min = Math.round((ts - Date.now()) / 60_000);
  if (min < 2) return "in a moment";
  return min < 90 ? `in about ${min} min` : `in about ${Math.round(min / 60)} h`;
}

const NO_BACKUP_YET = "Your private balance is only in this browser for now.";

/** In UTC, so everyone reads the same day. */
const OLDER_KEY_ENDS = new Date(VERSION1_SAVES_UNTIL).toLocaleDateString("en-GB", { timeZone: "UTC", dateStyle: "long" });
const SIGN_THREE_TIMES = "Your wallet asks you to sign three times. It's free and sends nothing.";

/** A version 1 key that no longer saves: paused, or never started. */
const pausedTitle = (s: RecoveryState) => (s.savedAt ? "Backups are paused" : "No backup yet");

/** Where a version 1 key stands. */
export function olderKeyText(s: RecoveryState): string {
  if (!s.savedAt) return "This browser hasn't saved a backup yet, and the older key can't start one. Your balance stays here. Update to start saving.";
  if (s.gone) return "Another device moved or removed this backup, so this browser stopped saving. Your balance stays here. Update so your devices share one backup again.";
  if (s.paused) return `Backups from this browser stopped on ${OLDER_KEY_ENDS} and stay paused until you update. Your balance stays here.`;
  return `Backups from this browser stop on ${OLDER_KEY_ENDS} unless you update.`;
}

/** What to say after turning on: "backed up" only when that is true. With no backup yet the card already says so, and why. */
function turnedOn(added: number): Message {
  const s = recoveryState();
  if (!s.savedAt) return null;
  const back = added ? `${plural(added, "balance")} came back from your backup.` : "";
  if (s.error) return { tone: "wait", text: `Recovery is on. ${back ? `${back} ` : ""}The latest save didn't go through, so this browser keeps trying.` };
  return { tone: "ok", text: `Recovery is on. ${back || "Your private balance is backed up."}` };
}

/** What to say after a restore, including where the backup's key ended up. */
function restored(added: number, key: Awaited<ReturnType<typeof restoreWithWallet>>["key"]): string {
  const done = added
    ? `Restored ${plural(added, "balance")}. Recovery is on for this browser too.`
    : "Your backup is connected. This browser already had everything in it.";
  if (key === "waiting") return `${done} The backup moves to the newer recovery key on its own as soon as it can.`;
  if (key === "older") {
    return recoveryState().paused
      ? `${done} Backups stay paused until you update your recovery key in Settings.`
      : `${done} The backup stays on the older recovery key for now. Update it in Settings before ${OLDER_KEY_ENDS} to keep it saving.`;
  }
  return done;
}

/** Shared state and actions for the settings card and the portfolio nudge. */
function useRecovery() {
  const state = useSyncExternalStore(subscribeRecovery, recoveryState, recoveryServerState);
  const { address, isConnected, connector, demo } = useAppAccount();
  const { signMessageAsync } = useSignMessage();
  const [passkeyOk, setPasskeyOk] = useState(false);
  const [walletBrowser, setWalletBrowser] = useState(false);
  const [busy, setBusy] = useState<Busy>(null);
  const [message, setMessage] = useState<Message>(null);
  /** A wallet restore found nothing, so the older backup step is on offer. */
  const [offerOlder, setOfferOlder] = useState(false);

  useEffect(() => {
    startRecoverySync();
    let live = true;
    void passkeySupport().then((s) => {
      if (!live) return;
      setPasskeyOk(s !== "no");
      setWalletBrowser(inWalletBrowser());
    });
    return () => {
      live = false;
    };
  }, []);

  const active = isConnected && !demo;
  // Tempo Wallet signs with a passkey, differently every time: it can't hold a key.
  const walletOk = active && !isTempoWallet(connector);
  // A Gloam wallet: Turnkey makes its signatures, so a passkey comes first and the
  // wallet option says Turnkey could open a backup made with it.
  const embedded = active && connector?.id === EMBEDDED_CONNECTOR_ID;

  const wallet = (): RecoveryWallet => ({ address: address as string, sign: (message) => signMessageAsync({ message }) });

  async function run(kind: Exclude<Busy, null>, task: () => Promise<string | Message>) {
    if (busy) return;
    setBusy(kind);
    setMessage(null);
    try {
      const done = await task();
      setMessage(typeof done === "string" ? { tone: "ok", text: done } : done);
    } catch (e) {
      setMessage({ tone: "error", text: errorText(e) });
    } finally {
      setBusy(null);
    }
  }

  const turnOn = (source: RecoverySource) =>
    run(source === "wallet" ? "on-wallet" : "on-passkey", async () =>
      turnedOn(
        source === "wallet"
          ? await turnOnWithWallet(wallet())
          : await connectRecovery(await keysFromSecret("passkey", await passkeySecret("create")), address),
      ),
    );

  const restore = (source: RecoverySource) =>
    run(source === "wallet" ? "restore-wallet" : "restore-passkey", async () => {
      if (source === "wallet") {
        try {
          const { added, key } = await restoreWithWallet(wallet());
          return restored(added, key);
        } catch (e) {
          setOfferOlder(notFound(e));
          throw e;
        }
      }
      const keys = await keysFromSecret("passkey", await passkeySecret("use"));
      return restored(await connectRecovery(keys, address, { mustExist: true }), "newest");
    });

  const restoreOlder = () =>
    run("restore-older", async () => {
      try {
        const { added, key } = await restoreOlderBackup(wallet());
        setOfferOlder(false);
        return restored(added, key);
      } catch (e) {
        if (notFound(e)) setOfferOlder(false);
        throw e;
      }
    });

  const save = () =>
    run("save", async () => {
      await backupNow();
      return "Backed up.";
    });

  const off = () =>
    run("off", async () => {
      await turnOffRecovery({ deleteBackup: true });
      return "Recovery is off and the backup is deleted. Your balance stays in this browser.";
    });

  const update = () =>
    run("update", async () =>
      (await updateRecoveryKey(wallet())) === "newest"
        ? "Recovery key updated. Your backup moved across."
        : { tone: "wait", text: "Your backup stays on the older key for now. It moves on its own as soon as it can." },
    );

  const older = () =>
    run("older", async () => {
      const added = await bringInOlderBackup(wallet());
      return added
        ? `Brought in ${plural(added, "balance")} from your older backup.`
        : "Your older backup is merged in. This browser already had everything in it.";
    });

  return { state, active, walletOk, embedded, passkeyOk, walletBrowser, busy, message, offerOlder, turnOn, restore, restoreOlder, save, off, update, older };
}

function Note({ message }: { message: Message }) {
  if (!message) return null;
  return (
    <p
      role={message.tone === "error" ? "alert" : "status"}
      className={`mt-3 text-[13px] leading-relaxed ${message.tone === "error" ? "text-danger" : message.tone === "wait" ? "text-warn" : "text-sealed"}`}
    >
      {message.text}
    </p>
  );
}

function Choice({
  label,
  hint,
  children,
}: {
  label: string;
  hint: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 py-4">
      <div className="min-w-0 max-w-[52ch]">
        <p className="text-[14px] text-foreground">{label}</p>
        <p className="mt-0.5 text-[13px] leading-relaxed text-mute">{hint}</p>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}

/** Settings: turn recovery on, restore from it, or turn it off. */
export function RecoverySettingsCard() {
  const r = useRecovery();
  const [confirmOff, setConfirmOff] = useState(false);
  const { state, busy } = r;
  const noBackup = state.on && !state.savedAt && !state.paused;

  return (
    <section id="recovery" className="gl-card scroll-mt-24">
      <header className="max-sm:px-5 max-sm:pt-5 sm:px-6 sm:pt-6">
        <h2 className="text-[17px] text-foreground">Recovery</h2>
        <p className="mt-1 max-w-[62ch] text-[13.5px] leading-relaxed text-mute">
          Get your private balance back on any device, just by signing in. Your browser encrypts a copy before it leaves,
          and only your wallet or passkey can open it. We can&apos;t read it.
        </p>
        <p className="mt-2 max-w-[62ch] text-[13px] leading-relaxed text-faint">
          The copy holds your private notes, your receive keys, payment links you sent that haven&apos;t been claimed
          yet (with their codes) and payroll runs still on their way. It stays until you turn recovery off, which
          deletes it. Anyone with your recovery signature or passkey could open it, so only sign on gloam.trade.
        </p>
      </header>
      <div className="mt-2 divide-y divide-line pb-1 max-sm:px-5 max-sm:pb-4 sm:px-6 sm:pb-5">
        {!r.active ? (
          <Choice label="Recovery" hint="Connect a wallet to set up recovery.">
            {null}
          </Choice>
        ) : state.on ? (
          <div className="py-4">
            <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
              <div className="min-w-0">
                <p className="flex items-center gap-2 text-[14px] text-foreground">
                  <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${noBackup || state.paused ? "bg-warn" : "bg-sealed"}`} />
                  {state.paused ? pausedTitle(state) : noBackup ? "No backup yet" : "Recovery is on"}
                </p>
                <p className="mt-0.5 text-[13px] text-mute">
                  {state.source === "passkey" ? "With a passkey" : "With your wallet"}
                  {state.busy ? " · backing up…" : noBackup ? "" : ` · ${ago(state.savedAt)}`}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {!state.paused && (
                  <button type="button" onClick={r.save} disabled={Boolean(busy) || state.busy} className="btn btn-ghost btn-sm">
                    {busy === "save" ? "Backing up…" : noBackup ? "Try now" : "Back up now"}
                  </button>
                )}
                {!confirmOff ? (
                  <button type="button" onClick={() => setConfirmOff(true)} disabled={Boolean(busy)} className="btn btn-ghost btn-sm">
                    Turn off
                  </button>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={() => {
                        setConfirmOff(false);
                        r.off();
                      }}
                      disabled={Boolean(busy)}
                      className="btn btn-ink btn-sm"
                    >
                      {busy === "off" ? "Turning off…" : "Turn off and delete backup"}
                    </button>
                    <button type="button" onClick={() => setConfirmOff(false)} className="btn btn-ghost btn-sm">
                      Keep it on
                    </button>
                  </>
                )}
              </div>
            </div>
            {noBackup && (
              <p className="mt-3 max-w-[62ch] text-[13px] leading-relaxed text-mute">
                {NO_BACKUP_YET} This browser tries again on its own {nextTry(state.retryAt)}, or the next time you open Gloam after that.
              </p>
            )}
            {r.embedded && state.source === "wallet" && (
              <p className="mt-3 max-w-[62ch] text-[13px] leading-relaxed text-mute">
                {TURNKEY_CAN_OPEN_TEXT} To move to a passkey, turn recovery off, then on with a passkey.
              </p>
            )}
            {state.error && r.message?.tone !== "error" && <p className="mt-3 text-[13px] text-danger">{state.error}</p>}
            <Note message={r.message} />
          </div>
        ) : (
          <>
            <Choice
              label="Turn on recovery"
              hint={
                r.embedded
                  ? r.passkeyOk
                    ? `A passkey keeps the backup's key on your device. ${TURNKEY_CAN_OPEN_TEXT}`
                    : TURNKEY_CAN_OPEN_TEXT
                  : r.walletOk
                    ? "Your wallet asks you to sign twice. It's free and sends nothing."
                    : "Tempo Wallet can't sign a recovery key, so use a passkey."
              }
            >
              {r.embedded && r.passkeyOk && (
                <button type="button" onClick={() => r.turnOn("passkey")} disabled={Boolean(busy)} className="btn btn-ink btn-sm">
                  {busy === "on-passkey" ? "Check your passkey…" : "With a passkey"}
                </button>
              )}
              {r.walletOk && (
                <button
                  type="button"
                  onClick={() => r.turnOn("wallet")}
                  disabled={Boolean(busy)}
                  className={r.embedded ? "btn btn-ghost btn-sm" : "btn btn-ink btn-sm"}
                >
                  {busy === "on-wallet" ? "Check your wallet…" : r.embedded ? "With the wallet's signature" : "With your wallet"}
                </button>
              )}
              {!r.embedded && r.passkeyOk && (
                <button
                  type="button"
                  onClick={() => r.turnOn("passkey")}
                  disabled={Boolean(busy)}
                  className={r.walletOk ? "btn btn-ghost btn-sm" : "btn btn-ink btn-sm"}
                >
                  {busy === "on-passkey" ? "Check your passkey…" : "With a passkey"}
                </button>
              )}
            </Choice>
            <Choice
              label="Restore from your backup"
              hint="On a new device? Sign in the same way you did when you turned recovery on."
            >
              {r.walletOk && (
                <button type="button" onClick={() => r.restore("wallet")} disabled={Boolean(busy)} className="btn btn-ghost btn-sm">
                  {busy === "restore-wallet" ? "Check your wallet…" : "With your wallet"}
                </button>
              )}
              {r.passkeyOk && (
                <button type="button" onClick={() => r.restore("passkey")} disabled={Boolean(busy)} className="btn btn-ghost btn-sm">
                  {busy === "restore-passkey" ? "Check your passkey…" : "With a passkey"}
                </button>
              )}
            </Choice>
            {r.walletBrowser && !r.passkeyOk && (
              <p className="py-2 text-[12px] leading-relaxed text-mute">{WALLET_BROWSER_NOTE}</p>
            )}
            {r.message && (
              <div className="py-3">
                <Note message={r.message} />
              </div>
            )}
            {r.offerOlder && r.walletOk && (
              <Choice
                label="Older backup"
                hint="If you turned on recovery before November 2026, your backup may use the older key. Your wallet asks you to sign up to three times. It's free and sends nothing."
              >
                <button type="button" onClick={r.restoreOlder} disabled={Boolean(busy)} className="btn btn-ghost btn-sm">
                  {busy === "restore-older" ? "Check your wallet…" : "I have an older backup"}
                </button>
              </Choice>
            )}
          </>
        )}
        {state.olderKey && r.active && (
          <Choice
            label={state.gone ? "This backup moved" : state.moving ? "Newer recovery key" : "Update your recovery key"}
            hint={
              state.moving
                ? "Your backup is moving to the newer key. It finishes on its own."
                : !r.walletOk
                  ? `${olderKeyText(state)} Connect the wallet you turned recovery on with to update.`
                  : state.paused
                    ? `${olderKeyText(state)} ${SIGN_THREE_TIMES}`
                    : `${olderKeyText(state)} The newer key names this site, so wallets that check can warn you if another site asks for it. ${SIGN_THREE_TIMES}`
            }
          >
            {!state.moving && r.walletOk && (
              <button type="button" onClick={r.update} disabled={Boolean(busy) || state.busy} className="btn btn-ghost btn-sm">
                {busy === "update" ? "Check your wallet…" : "Update key"}
              </button>
            )}
          </Choice>
        )}
        {state.newerKey && r.walletOk && (
          <Choice label="Older backup" hint="Used recovery on another device before? Bring that backup in here.">
            <button type="button" onClick={r.older} disabled={Boolean(busy) || state.busy} className="btn btn-ghost btn-sm">
              {busy === "older" ? "Check your wallet…" : "Look for it"}
            </button>
          </Choice>
        )}
      </div>
    </section>
  );
}

const NUDGE_KEY = "gloam.recovery.nudge.v1";
const NUDGE_SNOOZE_MS = 7 * 86_400_000;

const nudgeListeners = new Set<() => void>();

function subscribeNudge(fn: () => void): () => void {
  nudgeListeners.add(fn);
  return () => {
    nudgeListeners.delete(fn);
  };
}

/** "hidden" while snoozed (or before the browser can say), else "shown". */
function nudgeSnapshot(): "hidden" | "shown" {
  try {
    return Date.now() - Number(localStorage.getItem(NUDGE_KEY) ?? 0) < NUDGE_SNOOZE_MS ? "hidden" : "shown";
  } catch {
    return "shown";
  }
}

const nudgeServerSnapshot = () => "hidden" as const;

function snoozeNudge() {
  try {
    localStorage.setItem(NUDGE_KEY, String(Date.now()));
  } catch {
    /* private mode */
  }
  for (const fn of nudgeListeners) fn();
}

/**
 * Portfolio: asks people with a private balance to turn recovery on, and
 * stays up (no snooze) while recovery is on with no backup to show for it. A
 * browser on the older key is asked to update, whatever it holds, and once its
 * backups have stopped that stays up too.
 *
 * A wallet whose deposits this browser can't see gets its balance back by itself
 * (lib/autoRestore): nothing shows here while that runs, or after it worked. Only
 * when it can't (a closed signature request, no backup under this sign-in, a
 * wallet that can't make the key, a failure) does a card say why and offer the
 * one step left. A failure stays up.
 */
export function RecoveryNudge({ hasBalance, hasDeposits }: { hasBalance: boolean; hasDeposits: boolean }) {
  const r = useRecovery();
  const hidden = useSyncExternalStore(subscribeNudge, nudgeSnapshot, nudgeServerSnapshot) === "hidden";

  const restoreMode = !hasBalance && hasDeposits;
  const auto = useAutoRestore(restoreMode);
  const older = r.state.olderKey && !r.state.moving;
  const failed = auto.status.kind === "failed";
  const fallback = r.active && !r.state.on && !older && (restoreMode || failed) ? auto.fallback(r.passkeyOk) : null;
  const noBackup = r.state.on && !r.state.savedAt && !r.state.paused && !older;
  const stayUp = noBackup || (older && r.state.paused) || (Boolean(fallback) && failed);
  const done = Boolean(r.message) && r.message?.tone !== "error" && !noBackup;
  if (!r.active || !r.state.ready || (r.state.on && !done && !noBackup && !older) || (hidden && !stayUp) || (!hasBalance && !hasDeposits && !older && !done && !fallback)) return null;
  // Restoring by itself, or nothing left to offer: the balance says how it's going.
  if (restoreMode && !fallback && !done && !older) return null;
  if (fallback && !done) {
    return (
      <RestoreFallback
        r={r}
        text={fallback.text}
        action={fallback.action}
        failed={failed}
        onWallet={auto.retry}
        walletLabel={auto.kind === "embedded" || failed ? "Try again" : "Restore with your wallet"}
        // Before November 2026 a wallet's backup used the older key, which takes one more signature to find.
        offerOlder={auto.status.kind === "none" && r.walletOk && auto.kind === "browser"}
        onSnooze={stayUp ? null : snoozeNudge}
      />
    );
  }

  // A Gloam wallet's signature is Turnkey's to make: the nudge offers its passkey, and leaves
  // the wallet option to Settings, where what it means is said.
  const source: RecoverySource | null = r.embedded
    ? r.passkeyOk
      ? "passkey"
      : null
    : r.walletOk
      ? "wallet"
      : r.passkeyOk
        ? "passkey"
        : null;
  const busy = Boolean(r.busy);
  const label = noBackup ? "Try now" : source === "wallet" ? "Turn on with your wallet" : "Turn on with a passkey";

  return (
    <section aria-labelledby="recovery-nudge-title" className="gl-card flex gap-4 max-sm:items-start max-sm:p-5 sm:items-center sm:py-4 sm:pl-6 sm:pr-4">
      <span aria-hidden className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-sealed-soft text-sealed">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
          <path d="M20 12a8 8 0 1 1-2.34-5.66M20 4v4.5h-4.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
      <div className="flex min-w-0 flex-1 max-sm:flex-col max-sm:gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
        <div className="min-w-0">
          <h2 id="recovery-nudge-title" className="text-[15px] text-foreground">
            {older
              ? r.state.gone
                ? "This backup moved"
                : r.state.paused
                  ? pausedTitle(r.state)
                  : "Update your recovery key"
              : done
                ? "Recovery is on"
                : noBackup
                  ? "No backup yet"
                  : "Don't lose your private balance"}
          </h2>
          {done ? (
            <p className={`mt-0.5 max-w-[62ch] text-[13px] leading-relaxed ${r.message?.tone === "wait" ? "text-warn" : "text-sealed"}`} role="status">
              {r.message?.text}
            </p>
          ) : (
            <p className="mt-0.5 max-w-[62ch] text-[13px] leading-relaxed text-mute">
              {older
                ? `${olderKeyText(r.state)} ${r.walletOk ? SIGN_THREE_TIMES : "Connect the wallet you turned recovery on with to update."}`
                : noBackup
                  ? `${NO_BACKUP_YET} This browser keeps trying on its own.`
                  : "Turn on recovery and you can get it back on any device by signing in."}
              {noBackup && r.state.error && r.message?.tone !== "error" && <span className="mt-1 block text-danger">{r.state.error}</span>}
              {r.message?.tone === "error" && <span className="mt-1 block text-danger">{r.message.text}</span>}
            </p>
          )}
        </div>
        {!done && (
          <div className="flex shrink-0 flex-wrap items-center gap-2 max-sm:self-start">
            {older ? (
              r.walletOk && (
                <button type="button" onClick={r.update} disabled={busy || r.state.busy} className="btn btn-ink btn-sm">
                  {busy ? "Check your wallet…" : "Update key"}
                </button>
              )
            ) : noBackup ? (
              <button type="button" onClick={r.save} disabled={busy || r.state.busy} className="btn btn-ink btn-sm">
                {busy || r.state.busy ? "Backing up…" : label}
              </button>
            ) : source ? (
              <button type="button" onClick={() => r.turnOn(source)} disabled={busy} className="btn btn-ink btn-sm">
                {busy && r.busy !== "restore-older" ? (source === "wallet" ? "Check your wallet…" : "Check your passkey…") : label}
              </button>
            ) : null}
            {r.offerOlder && r.walletOk && (
              <button type="button" onClick={r.restoreOlder} disabled={busy} className="btn btn-ghost btn-sm">
                {r.busy === "restore-older" ? "Check your wallet…" : "I have an older backup"}
              </button>
            )}
            <IntentLink href="/app/settings#recovery" className="btn btn-ghost btn-sm">
              {noBackup || older ? "See recovery" : "Other ways"}
            </IntentLink>
          </div>
        )}
      </div>
      {!stayUp && (
        <button
          type="button"
          onClick={snoozeNudge}
          aria-label="Hide for a week"
          title="Hide for a week"
          className="-mr-1.5 grid h-9 w-9 shrink-0 place-items-center rounded-full text-mute transition-colors hover:bg-surface hover:text-foreground max-sm:-mt-1.5"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
            <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
          </svg>
        </button>
      )}
    </section>
  );
}

/** The one card left when the balance couldn't come back by itself: why, and the step that's left. */
function RestoreFallback({
  r,
  text,
  action,
  failed,
  onWallet,
  walletLabel,
  offerOlder,
  onSnooze,
}: {
  r: ReturnType<typeof useRecovery>;
  text: string;
  action: "wallet" | "passkey" | null;
  failed: boolean;
  onWallet: () => void;
  walletLabel: string;
  offerOlder: boolean;
  onSnooze: (() => void) | null;
}) {
  const busy = Boolean(r.busy);
  return (
    <section aria-labelledby="restore-fallback-title" className="gl-card flex gap-4 max-sm:items-start max-sm:p-5 sm:items-center sm:py-4 sm:pl-6 sm:pr-4">
      <span aria-hidden className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-sealed-soft text-sealed">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
          <path d="M20 12a8 8 0 1 1-2.34-5.66M20 4v4.5h-4.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
      <div className="flex min-w-0 flex-1 max-sm:flex-col max-sm:gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
        <div className="min-w-0">
          <h2 id="restore-fallback-title" className="text-[15px] text-foreground">
            {failed ? "Your private balance didn't load" : "Bring your private balance here"}
          </h2>
          <p className="mt-0.5 max-w-[62ch] text-[13px] leading-relaxed text-mute">
            {text}
            {r.message?.tone === "error" && <span className="mt-1 block text-danger" role="alert">{r.message.text}</span>}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2 max-sm:self-start">
          {action === "wallet" && (
            <button type="button" onClick={onWallet} disabled={busy} className="btn btn-ink btn-sm">
              {walletLabel}
            </button>
          )}
          {action === "passkey" && (
            <button type="button" onClick={() => r.restore("passkey")} disabled={busy} className="btn btn-ink btn-sm">
              {r.busy === "restore-passkey" ? "Check your passkey…" : "Restore with a passkey"}
            </button>
          )}
          {offerOlder && (
            <button type="button" onClick={r.restoreOlder} disabled={busy} className="btn btn-ghost btn-sm">
              {r.busy === "restore-older" ? "Check your wallet…" : "I have an older backup"}
            </button>
          )}
          <IntentLink href="/app/settings#backup" className="btn btn-ghost btn-sm">
            Use a backup file
          </IntentLink>
        </div>
      </div>
      {onSnooze && (
        <button
          type="button"
          onClick={onSnooze}
          aria-label="Hide for a week"
          title="Hide for a week"
          className="-mr-1.5 grid h-9 w-9 shrink-0 place-items-center rounded-full text-mute transition-colors hover:bg-surface hover:text-foreground max-sm:-mt-1.5"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
            <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
          </svg>
        </button>
      )}
    </section>
  );
}
