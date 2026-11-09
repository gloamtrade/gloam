/**
 * The private-balance backup (lib/recovery) for a Gloam wallet.
 *
 * A Gloam wallet opens on any device with the same email or passkey, but its
 * private balance lives in the browser, so the backup is what brings it along.
 *
 * Recovery can key a backup two ways. With a browser wallet, a wallet signature
 * of a fixed message works: only that wallet can make it. A Gloam wallet's
 * signatures are made by Turnkey and kept as activity results Turnkey holds, which
 * Gloam's Turnkey account can also read, so a key made from one could be rebuilt
 * without the person. So for a Gloam wallet:
 *  - the backup uses a passkey (WebAuthn PRF): its secret comes out of the
 *    authenticator only for the person, and never leaves their device
 *  - a wallet-signature backup is offered only where this browser can't make a
 *    passkey backup, and only with a plain warning that Turnkey could open it
 *  - nothing new turns on by itself: each needs the person's tap (a passkey can't
 *    be asked for without one anyway). The one exception is a backup that already
 *    exists under this wallet's signature: after sign-in on a new device it is
 *    opened silently and this browser joins it (lib/autoRestore), since the person
 *    chose that backup already and Turnkey already holds that signature
 *  - it is offered once per wallet per browser, only while the Gloam wallet is
 *    the connected wallet, never when recovery is already on or was turned off
 *    here, and on a browser that holds other wallets' notes the offer says
 *    they would go into the backup too
 *
 * Checked by scripts/selftest-embedded-recovery.mts.
 */
import type { LocalNote } from "./shield";
import {
  connectRecovery,
  keysFromSecret,
  noPasskeyRecovery,
  passkeySecret,
  turnOnWithWallet,
  type RecoveryWallet,
} from "./recovery";

export type PasskeySupportLevel = "yes" | "maybe" | "no";

export type BackupOfferInput = {
  /** Recovery is on in this browser (with any key). */
  on: boolean;
  /** The person turned recovery off in this browser (lib/recovery recoveryTurnedOffHere). */
  turnedOff: boolean;
  /** Already offered for this wallet on this browser. */
  asked: boolean;
  /** The Gloam wallet is the wallet connected now. */
  embeddedConnected: boolean;
  /** Notes in this browser from other wallets (otherWalletNotes). */
  otherNotes: number;
  /** Whether this browser can make a passkey backup (lib/passkey passkeySupport). */
  passkey: PasskeySupportLevel;
};

export type BackupOffer =
  | { kind: "none"; why: "on" | "declined" | "asked" | "not-connected" }
  /** Offer a passkey backup. `shared`: other wallets' notes would go in too. */
  | { kind: "passkey"; shared: boolean }
  /** No passkey backup here: offer the wallet signature, saying Turnkey could open it. */
  | { kind: "signature"; shared: boolean };

export function backupOffer(i: BackupOfferInput): BackupOffer {
  if (i.on) return { kind: "none", why: "on" };
  if (i.turnedOff) return { kind: "none", why: "declined" };
  if (!i.embeddedConnected) return { kind: "none", why: "not-connected" };
  if (i.asked) return { kind: "none", why: "asked" };
  const shared = i.otherNotes > 0;
  return i.passkey === "no" ? { kind: "signature", shared } : { kind: "passkey", shared };
}

/** Notes in this browser that another wallet made, or that name no wallet. */
export function otherWalletNotes(notes: readonly Pick<LocalNote, "from">[], address: string): number {
  const me = address.toLowerCase();
  return notes.filter((n) => (n.from ?? "").toLowerCase() !== me).length;
}

const askedKey = (address: string) => `gloam.recovery.embedded.asked.v1:${address.toLowerCase()}`;

/** The backup was offered for this wallet on this browser. */
export function backupAsked(address: string): boolean {
  try {
    return localStorage.getItem(askedKey(address)) === "1";
  } catch {
    return false;
  }
}

export function markBackupAsked(address: string) {
  try {
    localStorage.setItem(askedKey(address), "1");
  } catch {
    /* private mode: it may be offered again */
  }
}

/**
 * Backs up with a passkey. "create" makes a new one for this backup; "use" lets
 * the person pick one they backed up with before, on any device it synced to, and
 * brings back what was saved with it. "use" needs that backup to exist, as restoring
 * in Settings does: picking any other passkey (the sign-in one, say) says no backup
 * was found, instead of starting an empty one and calling it backed up. Returns how
 * many notes came back.
 */
export async function backUpWithPasskey(address: string, mode: "create" | "use"): Promise<number> {
  const keys = await keysFromSecret("passkey", await passkeySecret(mode));
  return connectRecovery(keys, address, { mustExist: mode === "use" });
}

/**
 * This browser or passkey can't make a passkey backup at all, so the wallet's
 * signature is the only other way. A prompt that was closed, however fast, is not
 * that: the passkey stays on offer.
 */
export function passkeyBackupUnavailable(e: unknown): boolean {
  return noPasskeyRecovery(e);
}

/**
 * Backs up with the Gloam wallet's signature: only after the person read that
 * Turnkey, which makes the signature, could open the backup. Returns how many
 * notes came back.
 */
export function backUpWithWalletSignature(wallet: RecoveryWallet): Promise<number> {
  return turnOnWithWallet(wallet);
}

/** What the sheet and Settings say about a wallet-signature backup of a Gloam wallet. */
export const TURNKEY_CAN_OPEN_TEXT =
  "Turnkey makes this wallet's signatures and keeps a record of them, so Turnkey, and anyone with access to Gloam's Turnkey account, could open a backup made with one. Only you can open a passkey backup.";
