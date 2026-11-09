/**
 * Auto-restore: the private balance follows the person to a new device by itself.
 *
 * Notes live in the browser, and the recovery backup (lib/recovery) is what
 * carries them across. Restoring used to wait for a tap on a card. Now, right
 * after sign-in, this browser opens the backup itself when it can, with the same
 * key and the same backup format as the manual restore:
 *
 *  - A Gloam wallet (Turnkey) signs without a prompt, so the version 2 wallet
 *    message is signed silently and the backup it keys, if any, is restored. It
 *    turns nothing on that wasn't on: with no backup under that key, nothing is
 *    saved and nothing changes. A Turnkey signature of this message already exists
 *    for any backup made with one (making it took one), so signing it again shows
 *    Turnkey nothing new. A backup made with a passkey can't open without the
 *    person: a passkey always needs their touch.
 *  - A browser wallet (MetaMask and the like) would pop a signature request, so
 *    it is asked once, by itself, and only when this browser is missing the
 *    wallet's deposits. Never again on this browser after that one ask.
 *  - Tempo Wallet can't make a recovery key at all (it signs differently every
 *    time), so its backup is a passkey one, and the person is told so.
 *  - A browser that holds another wallet's notes waits for the person: restoring
 *    turns recovery on here, and the backup would then carry those notes too.
 *  - Recovery already on here, or turned off here by the person: nothing to do.
 *    A browser with recovery on reads what other devices saved by itself
 *    (lib/recovery pullBackup).
 *
 * Every visible fallback says why it is there (see autoRestoreFallback).
 * Checked by scripts/selftest-auto-restore.mts.
 */
// Types only: lib/recovery loads when a restore starts, so pages that only read the status stay light.
import type { RecoveryErrorCode, RecoveryWallet } from "./recovery";

/** lib/recovery's RecoveryError, told apart without loading it. */
function recoveryCode(e: unknown): RecoveryErrorCode | null {
  const x = e as { name?: string; code?: RecoveryErrorCode } | null;
  return x?.name === "RecoveryError" && x.code ? x.code : null;
}

export type WalletKind = "embedded" | "browser" | "tempo";

export type AutoRestoreInput = {
  kind: WalletKind;
  /** The recovery settings and this browser's notes have been read. */
  ready: boolean;
  /** Recovery is on in this browser. */
  on: boolean;
  /** The person turned recovery off in this browser. */
  turnedOff: boolean;
  /** Notes here from other wallets, or naming none. */
  otherNotes: number;
  /** This wallet has deposits this browser holds no note for. Null: not known yet. */
  missing: boolean | null;
  /** Already tried for this wallet: this session for a Gloam wallet, ever on this browser for a browser wallet. */
  tried: boolean;
};

export type AutoRestorePlan =
  | { run: "silent" }
  | { run: "prompt" }
  | { run: "no"; why: "wait" | "on" | "turned-off" | "tried" | "tempo" | "shared" | "nothing-missing" };

export function planAutoRestore(i: AutoRestoreInput): AutoRestorePlan {
  if (!i.ready) return { run: "no", why: "wait" };
  if (i.on) return { run: "no", why: "on" };
  if (i.turnedOff) return { run: "no", why: "turned-off" };
  if (i.tried) return { run: "no", why: "tried" };
  if (i.kind === "tempo") return { run: "no", why: "tempo" };
  if (i.otherNotes > 0) return { run: "no", why: "shared" };
  if (i.kind === "embedded") return { run: "silent" };
  if (i.missing === null) return { run: "no", why: "wait" };
  return i.missing ? { run: "prompt" } : { run: "no", why: "nothing-missing" };
}

export type AutoRestoreStatus =
  | { kind: "idle" }
  /** A silent restore is expected and about to start: the balance isn't known yet. */
  | { kind: "checking" }
  | { kind: "running"; prompt: boolean }
  | { kind: "restored"; added: number }
  /** No backup under this wallet's key. */
  | { kind: "none" }
  | { kind: "failed"; cancelled: boolean; text: string };

const IDLE: AutoRestoreStatus = { kind: "idle" };

const statuses = new Map<string, AutoRestoreStatus>();
const listeners = new Set<() => void>();
const inFlight = new Map<string, Promise<AutoRestoreStatus>>();
/** Gloam wallets tried in this tab (sessionStorage keeps it across reloads). */
const triedHere = new Set<string>();

const norm = (address: string) => address.toLowerCase();

function set(address: string, s: AutoRestoreStatus) {
  statuses.set(norm(address), s);
  for (const fn of listeners) fn();
}

export function autoRestoreStatus(address: string | null | undefined): AutoRestoreStatus {
  return (address && statuses.get(norm(address))) || IDLE;
}

export function subscribeAutoRestore(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** The balance may still change because a restore is on its way. */
export function autoRestoreSyncing(s: AutoRestoreStatus): boolean {
  return s.kind === "checking" || s.kind === "running";
}

/** A silent restore is about to start: show the balance as syncing, not as 0. */
export function markAutoRestoreChecking(address: string) {
  const now = autoRestoreStatus(address);
  if (now.kind === "idle") set(address, { kind: "checking" });
}

/** Nothing will start after all. */
export function clearAutoRestoreChecking(address: string) {
  if (autoRestoreStatus(address).kind === "checking") set(address, IDLE);
}

const triedKey = (address: string) => `gloam.recovery.auto.v1:${norm(address)}`;

export function autoRestoreTried(address: string, kind: WalletKind): boolean {
  if (kind === "embedded") {
    if (triedHere.has(norm(address))) return true;
    try {
      return sessionStorage.getItem(triedKey(address)) === "1";
    } catch {
      return false;
    }
  }
  try {
    return localStorage.getItem(triedKey(address)) === "1";
  } catch {
    return false;
  }
}

function markTried(address: string, kind: WalletKind) {
  if (kind === "embedded") triedHere.add(norm(address));
  try {
    (kind === "embedded" ? sessionStorage : localStorage).setItem(triedKey(address), "1");
  } catch {
    /* private mode: a Gloam wallet may be tried again on the next load, which is silent anyway */
  }
}

function cancelled(e: unknown): boolean {
  const name = (e as { name?: string } | null)?.name ?? "";
  const text = e instanceof Error ? e.message : "";
  return name === "UserRejectedRequestError" || recoveryCode(e) === "cancelled" || /reject|denied|cancel/i.test(text);
}

function failureText(e: unknown): string {
  if (cancelled(e)) return "You closed the signature request, so your private balance didn't load on this device.";
  if (recoveryCode(e) && e instanceof Error) return e.message;
  return "Your private balance couldn't load from your backup.";
}

/** Tries a silent signer twice: a wallet that only just connected can miss the first. */
const SILENT_TRIES = 2;
const SILENT_RETRY_MS = 2_000;

/**
 * Restores this wallet's backup by its signature. One run per wallet at a time;
 * "silent" for a wallet that signs with no prompt, "prompt" for one that asks.
 */
export function runAutoRestore(
  address: string,
  wallet: RecoveryWallet,
  how: "silent" | "prompt",
  kind: WalletKind,
): Promise<AutoRestoreStatus> {
  const key = norm(address);
  const running = inFlight.get(key);
  if (running) return running;
  // A browser wallet is asked once on this browser, whatever comes of it.
  if (how === "prompt") markTried(address, kind);
  const job = (async (): Promise<AutoRestoreStatus> => {
    set(address, { kind: "running", prompt: how === "prompt" });
    let result: AutoRestoreStatus = IDLE;
    for (let attempt = 0; attempt < (how === "silent" ? SILENT_TRIES : 1); attempt++) {
      try {
        const { restoreWithWallet } = await import("./recovery");
        const { added } = await restoreWithWallet(wallet);
        result = { kind: "restored", added };
        break;
      } catch (e) {
        if (recoveryCode(e) === "notfound") {
          result = { kind: "none" };
          break;
        }
        if (recoveryCode(e) === "unsupported") {
          result = { kind: "failed", cancelled: false, text: (e as Error).message };
          break;
        }
        result = { kind: "failed", cancelled: cancelled(e), text: failureText(e) };
        if (result.cancelled) break;
        if (attempt + 1 < SILENT_TRIES && how === "silent") await new Promise((r) => setTimeout(r, SILENT_RETRY_MS));
      }
    }
    // A Gloam wallet is not tried again this session once it has an answer. A failure tries again on the next load.
    if (how === "silent" && result.kind !== "failed") markTried(address, kind);
    set(address, result);
    return result;
  })();
  inFlight.set(key, job);
  void job.finally(() => inFlight.delete(key));
  return job;
}

/**
 * What the portfolio says when the balance can't load by itself and the person
 * has to act, and why. Null: nothing to show (it loaded, is loading, or nothing
 * is missing).
 */
export type AutoRestoreFallback = {
  text: string;
  /** The action on offer: the wallet's signature again, or a passkey. */
  action: "wallet" | "passkey" | null;
};

export function autoRestoreFallback(p: {
  kind: WalletKind;
  status: AutoRestoreStatus;
  plan: AutoRestorePlan;
  /** This browser could ask for a passkey. */
  passkey: boolean;
}): AutoRestoreFallback | null {
  const { kind, status, plan, passkey } = p;
  if (autoRestoreSyncing(status) || status.kind === "restored") return null;
  const passkeyAction = passkey ? ("passkey" as const) : null;
  if (status.kind === "failed") {
    return status.cancelled
      ? { text: `${status.text} Sign once to bring it back. It's free and sends nothing.`, action: "wallet" }
      : { text: `Your private balance didn't load by itself: ${lowerFirst(status.text)}`, action: kind === "tempo" ? passkeyAction : "wallet" };
  }
  const none: AutoRestoreFallback = {
    text:
      kind === "embedded"
        ? "No backup opens with this sign-in. If you saved one with a passkey, use that passkey here."
        : "No backup opens with this wallet's signature. If you saved one with a passkey, use that passkey here.",
    action: passkeyAction,
  };
  if (status.kind === "none") return none;
  if (plan.run !== "no") return null;
  if (plan.why === "tempo") {
    return { text: "Tempo Wallet can't make a recovery key, so your backup opens with a passkey.", action: passkeyAction };
  }
  if (plan.why === "shared") {
    return {
      text: "This browser also holds another wallet's private balance, and restoring would add it to this wallet's backup, so it waits for you.",
      action: "wallet",
    };
  }
  // Tried before. A Gloam wallet found no backup under its key this session; a
  // browser wallet was asked once on this browser, and is asked again only from here.
  if (plan.why === "tried") {
    return kind === "embedded"
      ? none
      : { text: "This wallet made deposits this browser can't see. Sign once to bring them back from your backup. It's free and sends nothing.", action: "wallet" };
  }
  return null;
}

function lowerFirst(s: string): string {
  return s ? s[0].toLowerCase() + s.slice(1) : s;
}
