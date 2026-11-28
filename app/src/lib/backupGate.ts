/**
 * The backup step before money first lands in this browser's private balance.
 *
 * A private balance lives in this browser: its notes are sealed in localStorage
 * under a key kept in IndexedDB. A browser can lose that key (Chrome clears
 * IndexedDB under storage pressure and keeps localStorage), and without a
 * recovery backup the balance is gone for good. So before a deposit or a claim,
 * a browser with recovery off is asked once to turn it on: one wallet signature
 * (or a passkey where the wallet can't make the key). "Skip for now" holds for a
 * week per wallet, so it never asks again in a loop.
 *
 * Never asked:
 *  - in the demo
 *  - with recovery already on, or turned off here by the person (lib/recovery
 *    recoveryTurnedOffHere: nothing may offer to turn it back on for them)
 *  - for a Gloam wallet, which has its own backup offer with the Turnkey caveats
 *    (lib/embeddedRecovery)
 *  - when neither a wallet signature nor a passkey can make the key here
 *  - before the saved recovery settings are read (unknown is not "off")
 *
 * Checked by scripts/selftest-backup-gate.mts.
 */

export type BackupRoute = "wallet" | "passkey";

export type BackupGateInput = {
  demo: boolean;
  /** A wallet is connected. */
  active: boolean;
  /** The saved recovery settings have been read (lib/recovery recoveryState().ready). */
  ready: boolean;
  /** Recovery is on in this browser, with any key. */
  on: boolean;
  /** The person turned recovery off in this browser. */
  turnedOff: boolean;
  /** The connected wallet is a Gloam wallet. */
  embedded: boolean;
  /** How this browser can make the key, or null when it can't. */
  route: BackupRoute | null;
  /** When this wallet last chose "Skip for now" here, or null. */
  skippedAt: number | null;
  now: number;
};

/** How long "Skip for now" holds for a wallet. */
export const BACKUP_SKIP_MS = 7 * 86_400_000;

/** The route the step offers: the wallet's signature where it can make the key, else a passkey. */
export function backupRoute(i: { walletOk: boolean; passkeyOk: boolean }): BackupRoute | null {
  if (i.walletOk) return "wallet";
  if (i.passkeyOk) return "passkey";
  return null;
}

export function backupStepNeeded(i: BackupGateInput): boolean {
  if (i.demo || !i.active || !i.ready) return false;
  if (i.on || i.turnedOff || i.embedded) return false;
  if (!i.route) return false;
  if (i.skippedAt !== null && i.now - i.skippedAt < BACKUP_SKIP_MS) return false;
  return true;
}

const skipKey = (address: string) => `gloam.backup.skip.v1:${address.toLowerCase()}`;

/** When this wallet last skipped the step in this browser, or null. */
export function backupSkippedAt(address: string): number | null {
  try {
    const v = Number(localStorage.getItem(skipKey(address)));
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}

/** Remember "Skip for now" for this wallet. Storage that refuses means it may ask again next time. */
export function skipBackupStep(address: string, now: number) {
  try {
    localStorage.setItem(skipKey(address), String(now));
  } catch {
    /* private mode */
  }
}

let persistAsked = false;

/**
 * Asks the browser to keep this site's storage (navigator.storage.persist), so it
 * doesn't clear the note key under storage pressure. Called from the person's own
 * actions (a deposit, a claim, turning on a backup), never on page load, since some
 * browsers answer it with a prompt. Once per page load. A refusal changes nothing.
 */
export function keepStorage(): void {
  if (persistAsked || typeof navigator === "undefined") return;
  persistAsked = true;
  try {
    const storage = navigator.storage;
    if (!storage?.persist || !storage.persisted) return;
    void storage
      .persisted()
      .then((already) => (already ? true : storage.persist()))
      .catch(() => false);
  } catch {
    /* not offered here */
  }
}
