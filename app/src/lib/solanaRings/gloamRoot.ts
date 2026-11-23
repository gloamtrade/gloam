/**
 * Where a Gloam account's private account on Solana comes from: a secret that
 * Turnkey never sees, never a signature.
 *
 * A Gloam wallet's signatures are made and kept by Turnkey, and Gloam's Turnkey
 * account can read them, so an account derived from one (lib/solanaRings/account,
 * the way a browser wallet opens one) could be rebuilt without the person. A
 * Gloam account (lib/turnkeySolana) therefore signs Solana transactions only, and
 * its private account opens from one of these roots instead:
 *
 *  - passkey: the WebAuthn PRF output of the passkey the person signs in with,
 *    for a salt only this uses (PRF_SALT_TEXT). It comes out of the
 *    authenticator for the person alone, and a synced passkey gives the same
 *    output on every device it is on, so the same passkey opens the same
 *    private account everywhere. The same mechanism as the recovery backup's
 *    passkey (lib/recovery), with its own salt.
 *  - code: 16 random bytes made in this browser, shown once as a backup code
 *    (backupCodeFor) for the person to save. Kept on this device sealed like the
 *    private balance (lib/solanaRings/gloamCodes), and in the recovery backup
 *    when that backup is keyed by a passkey. A new device asks for the code.
 *
 * The account seed is HKDF-SHA256 over the root, salted for Solana accounts and
 * bound to the root's kind and the account index (accountSeedFromRoot), so a
 * root opens one account per index and never anything else.
 *
 * Changing PRF_SALT_TEXT, ROOT_SALT or the info strings changes every Gloam
 * account's private account.
 */

/** The PRF input that opens a Gloam account's private account on Solana. Never change it. */
export const PRF_SALT_TEXT = "gloam/solana-account/prf/v1";
/** HKDF salt for a private account opened from a root. Never change it. */
const ROOT_SALT = "gloam/solana-account/root/v1";

export type RootKind = "passkey" | "code";

const enc = new TextEncoder();
const buf = (b: Uint8Array): ArrayBuffer => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;

function subtle(): SubtleCrypto {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new GloamRootError("This browser can't open a private Solana account (no Web Crypto).", "unsupported");
  return s;
}

export type GloamRootErrorCode = "cancelled" | "unsupported" | "failed" | "badcode";

/** A root that couldn't be had, in words a person can act on. */
export class GloamRootError extends Error {
  constructor(
    message: string,
    readonly code: GloamRootErrorCode,
  ) {
    super(message);
    this.name = "GloamRootError";
  }
}

/** The 32-byte seed of private account `index` opened from `root`. */
export async function accountSeedFromRoot(root: Uint8Array, kind: RootKind, index: number): Promise<Uint8Array> {
  if (root.length < 16) throw new GloamRootError("That key is too short to open a private account.", "failed");
  if (!Number.isSafeInteger(index) || index < 0 || index > 1_000_000) throw new GloamRootError("Invalid account index.", "failed");
  const key = await subtle().importKey("raw", buf(root), "HKDF", false, ["deriveBits"]);
  const bits = await subtle().deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: buf(enc.encode(ROOT_SALT)), info: buf(enc.encode(`${kind}/account/${index}`)) },
    key,
    256,
  );
  return new Uint8Array(bits);
}

/** The PRF input (salt) the passkey is asked with. */
export async function prfSalt(): Promise<Uint8Array> {
  return new Uint8Array(await subtle().digest("SHA-256", buf(enc.encode(PRF_SALT_TEXT))));
}

/* ---------------------------------------------------------------- passkey */

export const NO_PRF_TEXT =
  "Your passkey can't open a private account in this browser. Try Chrome, Safari or Edge with a passkey saved to your Google or Apple account, or use a backup code instead.";

/** Turnkey's credential ids (base64url) as WebAuthn wants them, or null when one doesn't read. */
export function credentialIdsFrom(ids: readonly string[]): ArrayBuffer[] | null {
  const out: ArrayBuffer[] = [];
  for (const id of ids) {
    const s = id.trim().replace(/-/g, "+").replace(/_/g, "/");
    if (!s || !/^[A-Za-z0-9+/]+=*$/.test(s)) return null;
    try {
      const bin = atob(s + "=".repeat((4 - (s.length % 4)) % 4));
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      if (bytes.length < 16) return null;
      out.push(buf(bytes));
    } catch {
      return null;
    }
  }
  return out;
}

/** The part of the WebAuthn API this asks (navigator.credentials, or a stand-in in tests). */
export type CredentialsApi = { get(options: CredentialRequestOptions): Promise<Credential | null> };

/** A passkey call this fast never showed a prompt: the browser refused it outright. */
const NO_PROMPT_MS = 1_000;

function passkeyError(e: unknown, ms: number): GloamRootError {
  if (e instanceof GloamRootError) return e;
  const name = (e as { name?: string } | null)?.name ?? "";
  if (name === "NotAllowedError" && ms < NO_PROMPT_MS) {
    return new GloamRootError("The passkey prompt didn't open. Try again, or use a backup code instead.", "unsupported");
  }
  if (name === "NotAllowedError" || name === "AbortError") return new GloamRootError("The passkey prompt was closed. Nothing changed.", "cancelled");
  if (name === "NotSupportedError") return new GloamRootError(NO_PRF_TEXT, "unsupported");
  if (name === "SecurityError") return new GloamRootError("Passkeys don't work on this address. Open Gloam on gloam.trade.", "failed");
  return new GloamRootError("The passkey didn't respond. Nothing changed. Try again.", "failed");
}

/**
 * The passkey's PRF output for PRF_SALT_TEXT: one passkey prompt, on the passkey
 * the person signs in to Gloam with (Turnkey's `credentialIds`, when they read;
 * any of this site's passkeys otherwise). Nothing goes to Turnkey or Gloam.
 */
export async function passkeyRoot(opts: { rpId: string; credentialIds: readonly string[]; credentials?: CredentialsApi; now?: () => number }): Promise<Uint8Array> {
  const api = opts.credentials ?? (typeof navigator !== "undefined" ? (navigator.credentials as CredentialsApi | undefined) : undefined);
  if (!api || (typeof window !== "undefined" && !("PublicKeyCredential" in window) && !opts.credentials)) {
    throw new GloamRootError(NO_PRF_TEXT, "unsupported");
  }
  const now = opts.now ?? Date.now;
  const allow = credentialIdsFrom(opts.credentialIds);
  const challenge = new Uint8Array(32);
  crypto.getRandomValues(challenge);
  const t0 = now();
  let cred: Credential | null;
  try {
    cred = await api.get({
      publicKey: {
        challenge,
        rpId: opts.rpId,
        userVerification: "required",
        timeout: 120_000,
        ...(allow && allow.length ? { allowCredentials: allow.map((id) => ({ type: "public-key" as const, id })) } : {}),
        extensions: { prf: { eval: { first: buf(await prfSalt()) } } },
      },
    });
  } catch (e) {
    throw passkeyError(e, now() - t0);
  }
  if (!cred) throw new GloamRootError("The passkey prompt was closed. Nothing changed.", "cancelled");
  const first = (cred as PublicKeyCredential).getClientExtensionResults?.().prf?.results?.first;
  if (!first) throw new GloamRootError(NO_PRF_TEXT, "unsupported");
  const out = first instanceof ArrayBuffer ? new Uint8Array(first.slice(0)) : new Uint8Array(buf(new Uint8Array(first.buffer, first.byteOffset, first.byteLength)));
  if (out.length < 16) throw new GloamRootError(NO_PRF_TEXT, "unsupported");
  return out;
}

/* ---------------------------------------------------------------- backup code */

/** Bytes of secret in a backup code. */
export const CODE_SECRET_BYTES = 16;
const CODE_CHECK_BYTES = 4;
/** Crockford's base32: no I, L, O or U, so a code read aloud or retyped stays one code. */
const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

async function codeCheck(secret: Uint8Array): Promise<Uint8Array> {
  const d = new Uint8Array(await subtle().digest("SHA-256", buf(new Uint8Array([...enc.encode("gloam/solana-backup-code/v1:"), ...secret]))));
  return d.slice(0, CODE_CHECK_BYTES);
}

/** A new backup-code secret, made in this browser. */
export function newCodeSecret(): Uint8Array {
  const s = new Uint8Array(CODE_SECRET_BYTES);
  crypto.getRandomValues(s);
  return s;
}

/** The code for `secret`: 32 characters in groups of four, with a check so a typo is caught. */
export async function backupCodeFor(secret: Uint8Array): Promise<string> {
  if (secret.length !== CODE_SECRET_BYTES) throw new GloamRootError("A backup code holds 16 bytes.", "failed");
  const bytes = new Uint8Array([...secret, ...(await codeCheck(secret))]);
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return out.match(/.{4}/g)!.join("-");
}

/**
 * The secret in a typed code, or null when it isn't one (a wrong length, a
 * character that isn't in a code, or a check that fails: a typo). Spaces, dashes
 * and case don't matter; O reads as 0 and I or L as 1.
 */
export async function secretFromBackupCode(text: string): Promise<Uint8Array | null> {
  const clean = text
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
  if (clean.length !== 32) return null;
  const bytes: number[] = [];
  let bits = 0;
  let value = 0;
  for (const c of clean) {
    const v = B32.indexOf(c);
    if (v < 0) return null;
    value = ((value << 5) | v) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  if (bytes.length !== CODE_SECRET_BYTES + CODE_CHECK_BYTES) return null;
  const secret = new Uint8Array(bytes.slice(0, CODE_SECRET_BYTES));
  const check = await codeCheck(secret);
  return check.every((b, i) => b === bytes[CODE_SECRET_BYTES + i]) ? secret : null;
}

/** What a mistyped code says. */
export const BAD_CODE_TEXT = "That code doesn't check out. Check each group of four and try again.";
