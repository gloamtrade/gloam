"use client";

/**
 * Passkey lock for the private balance (WebAuthn + the PRF extension).
 *
 * A passkey here is not a login: there is no server and no account. Gloam asks
 * the passkey (Face ID, Touch ID, Windows Hello, a security key) for its PRF
 * output, a secret only that passkey can produce for a given input, and uses
 * it to wrap the key that encrypts notes at rest (lib/noteVault.ts,
 * lib/passkeyWrap.ts). Browsers or passkeys without PRF get a plain message and
 * keep today's device key; nothing changes for them.
 */
import { useSyncExternalStore } from "react";
import {
  checkVaultPrf,
  protectVaultWithPrf,
  readPasskeyRecord,
  removeVaultPasskey,
  subscribeVault,
  unlockVaultWithPrf,
  vaultStatus,
  type VaultStatus,
} from "./noteVault";
import { b64, b64url, bytes, randomBytes, unb64, unb64url, type PasskeyWrapRecord } from "./passkeyWrap";
import { otherAccountsHere } from "./accountScope";

/** One passkey lock covers every private account in the browser, so it is only offered where there is one. */
export const OTHER_ACCOUNTS_MESSAGE =
  "This browser also holds another sign-in's private account, and a passkey lock would lock it too. Nothing changed.";

export const NO_PRF_MESSAGE =
  "This browser or passkey can't lock your vault. Nothing changed: your balance stays encrypted on this device, as before.";

export type PasskeyErrorCode = "cancelled" | "unsupported" | "wrong" | "failed";

export class PasskeyError extends Error {
  constructor(
    message: string,
    public code: PasskeyErrorCode
  ) {
    super(message);
  }
}

/** Shown where passkeys are hidden because the page is open inside a wallet app. */
export const WALLET_BROWSER_NOTE =
  "Passkeys don't work in a wallet app's built-in browser. Use your wallet here, or open gloam.trade in Safari or Chrome to use a passkey.";

/** A passkey call that fails this fast never showed a prompt: the browser refused it outright. */
const NO_PROMPT_MS = 1_000;
export const PROMPT_DID_NOT_OPEN =
  "The passkey prompt didn't open in this browser. Nothing changed. If you're in a wallet app's browser, use your wallet instead, or open gloam.trade in Safari or Chrome.";

/** Wallet apps' own browsers (MetaMask, Trust, Coinbase, OKX, Bitget, Phantom, ...), which can't show passkey prompts. */
const WALLET_APP_UA = /MetaMaskMobile|Trust\/|TrustWallet|CoinbaseWallet|OKApp|BitKeep|Bitget|Phantom|Rainbow|imToken|TokenPocket|SafePal|Rabby|Zerion/i;

export function inWalletBrowser(): boolean {
  if (typeof navigator === "undefined" || typeof window === "undefined") return false;
  const ua = navigator.userAgent;
  if (WALLET_APP_UA.test(ua)) return true;
  // an in-app web view (Android "; wv)", or iOS without Safari's token) with an injected wallet
  const webView = /; wv\)/.test(ua) || (/(iPhone|iPad|iPod)/.test(ua) && /AppleWebKit/.test(ua) && !/Safari\//.test(ua));
  return webView && typeof (window as { ethereum?: unknown }).ethereum !== "undefined";
}

/** "no": skip the button. "yes" / "maybe": try (only the passkey itself can say for sure). */
export type PasskeySupport = "yes" | "maybe" | "no";

export async function passkeySupport(): Promise<PasskeySupport> {
  if (
    typeof window === "undefined" ||
    !window.isSecureContext ||
    typeof window.PublicKeyCredential === "undefined" ||
    !navigator.credentials?.create ||
    inWalletBrowser()
  ) {
    return "no";
  }
  const pkc = window.PublicKeyCredential as typeof PublicKeyCredential & {
    getClientCapabilities?: () => Promise<Record<string, boolean | undefined>>;
  };
  if (typeof pkc.getClientCapabilities === "function") {
    try {
      const caps = await pkc.getClientCapabilities();
      if (caps["extension:prf"] === false) return "no";
      if (caps["extension:prf"] === true) return "yes";
    } catch {
      /* unknown */
    }
  }
  return "maybe";
}

function mapError(e: unknown, ms = Infinity): PasskeyError {
  if (e instanceof PasskeyError) return e;
  const name = e instanceof DOMException ? e.name : "";
  if (name === "NotAllowedError" && ms < NO_PROMPT_MS) return new PasskeyError(PROMPT_DID_NOT_OPEN, "unsupported");
  if (name === "NotAllowedError" || name === "AbortError") {
    return new PasskeyError("The passkey prompt was closed. Nothing changed.", "cancelled");
  }
  if (name === "NotSupportedError") return new PasskeyError(NO_PRF_MESSAGE, "unsupported");
  if (name === "SecurityError") {
    return new PasskeyError("Passkeys don't work on this address. Open Gloam on its usual site.", "failed");
  }
  return new PasskeyError("The passkey didn't respond. Nothing changed. Try again.", "failed");
}

/** Ask the browser to drop a passkey we cannot use (where it supports that). */
function forgetCredential(rpId: string, credentialId: string) {
  const pkc = window.PublicKeyCredential as typeof PublicKeyCredential & {
    signalUnknownCredential?: (o: { rpId: string; credentialId: string }) => Promise<void>;
  };
  void pkc.signalUnknownCredential?.({ rpId, credentialId }).catch(() => undefined);
}

function prfFirst(cred: PublicKeyCredential): Uint8Array | null {
  const first = cred.getClientExtensionResults().prf?.results?.first;
  return first ? bytes(first) : null;
}

/** One passkey prompt: the PRF output for this vault's passkey. */
async function evaluate(record: Pick<PasskeyWrapRecord, "credentialId" | "rpId" | "prfSalt">): Promise<Uint8Array> {
  let cred: PublicKeyCredential | null;
  const t0 = Date.now();
  try {
    cred = (await navigator.credentials.get({
      publicKey: {
        challenge: randomBytes(32),
        rpId: record.rpId,
        allowCredentials: [{ type: "public-key", id: unb64url(record.credentialId) }],
        userVerification: "required",
        timeout: 120_000,
        extensions: { prf: { eval: { first: unb64(record.prfSalt) } } },
      },
    })) as PublicKeyCredential | null;
  } catch (e) {
    throw mapError(e, Date.now() - t0);
  }
  if (!cred) throw new PasskeyError("The passkey prompt was closed. Nothing changed.", "cancelled");
  const out = prfFirst(cred);
  if (!out) throw new PasskeyError(NO_PRF_MESSAGE, "unsupported");
  return out;
}

function storedRecord(): PasskeyWrapRecord {
  const record = readPasskeyRecord();
  if (!record) {
    throw new PasskeyError("This browser's passkey details are damaged. Use Lost your passkey to start over.", "failed");
  }
  return record;
}

/**
 * Create a passkey and move the vault onto it. Up to two prompts: create, then
 * (when the passkey does not return its PRF output at creation) one sign-in.
 */
export async function protectWithPasskey(): Promise<void> {
  if ((await passkeySupport()) === "no") throw new PasskeyError(NO_PRF_MESSAGE, "unsupported");
  if (otherAccountsHere()) throw new PasskeyError(OTHER_ACCOUNTS_MESSAGE, "failed");
  const rpId = window.location.hostname;
  const prfSalt = randomBytes(32);
  let cred: PublicKeyCredential | null;
  const t0 = Date.now();
  try {
    cred = (await navigator.credentials.create({
      publicKey: {
        rp: { name: "Gloam", id: rpId },
        user: {
          id: randomBytes(16),
          name: "Gloam private balance",
          displayName: "Gloam private balance",
        },
        challenge: randomBytes(32),
        pubKeyCredParams: [
          { type: "public-key", alg: -7 },
          { type: "public-key", alg: -257 },
        ],
        authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
        attestation: "none",
        timeout: 120_000,
        extensions: { prf: { eval: { first: prfSalt } } },
      },
    })) as PublicKeyCredential | null;
  } catch (e) {
    throw mapError(e, Date.now() - t0);
  }
  if (!cred) throw new PasskeyError("The passkey prompt was closed. Nothing changed.", "cancelled");

  const credentialId = b64url(new Uint8Array(cred.rawId));
  const ext = cred.getClientExtensionResults().prf;
  let prfOutput = prfFirst(cred);
  if (!prfOutput && !ext?.enabled) {
    forgetCredential(rpId, credentialId);
    throw new PasskeyError(NO_PRF_MESSAGE, "unsupported");
  }
  if (!prfOutput) {
    try {
      prfOutput = await evaluate({ credentialId, rpId, prfSalt: b64(prfSalt) });
    } catch (e) {
      if (e instanceof PasskeyError && e.code === "unsupported") forgetCredential(rpId, credentialId);
      throw e;
    }
  }
  try {
    await protectVaultWithPrf({ credentialId, rpId, prfSalt, prfOutput });
  } catch (e) {
    forgetCredential(rpId, credentialId);
    throw e instanceof PasskeyError
      ? e
      : new PasskeyError("Could not lock the vault. Nothing changed.", "failed");
  } finally {
    prfOutput.fill(0);
  }
}

/** Unlock this tab's vault with the passkey. */
export async function unlockWithPasskey(): Promise<void> {
  const out = await evaluate(storedRecord());
  try {
    await unlockVaultWithPrf(out);
  } catch {
    throw new PasskeyError("That passkey doesn't open this vault. Try the one you set up here.", "wrong");
  } finally {
    out.fill(0);
  }
}

/** A fresh passkey check (e.g. before exporting a backup). Throws unless it matches. */
export async function confirmWithPasskey(): Promise<void> {
  const out = await evaluate(storedRecord());
  try {
    if (!(await checkVaultPrf(out))) {
      throw new PasskeyError("That passkey doesn't open this vault. Try the one you set up here.", "wrong");
    }
  } finally {
    out.fill(0);
  }
}

/** Remove the passkey lock (asks for the passkey first). */
export async function removePasskey(): Promise<void> {
  const out = await evaluate(storedRecord());
  try {
    await removeVaultPasskey(out);
  } catch {
    throw new PasskeyError("That passkey doesn't open this vault. Nothing changed.", "wrong");
  } finally {
    out.fill(0);
  }
}

const SERVER_STATUS: VaultStatus = { protected: false, locked: false };

/** Live lock state for components. */
export function useVaultStatus(): VaultStatus {
  return useSyncExternalStore(subscribeVault, vaultStatus, () => SERVER_STATUS);
}
