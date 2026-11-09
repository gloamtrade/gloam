/**
 * Recovery: get your private balance back on any device by signing in.
 *
 * This browser keeps an encrypted copy of its private balance (the notes it
 * can spend, plus its receive keys) on Gloam's server, with the payment codes
 * only it may hold: sent codes whose money has not moved (Sent links) and
 * payroll runs with a payment that may still land. The key comes from one
 * of two places:
 *  - a wallet signature over a fixed message. A browser wallet signs the same
 *    message the same way every time, so the same wallet always rebuilds the
 *    same key. Checked by signing twice when recovery is turned on.
 *  - a passkey's PRF output, which works with any wallet (Tempo Wallet too)
 *    and follows the user wherever their passkeys sync.
 * From that secret, HKDF derives the backup id (where the copy is filed), a
 * write token (to replace or delete it) and the AES-GCM key. The server only
 * ever sees the id, the token's hash and ciphertext.
 *
 * The wallet message has two versions, and each gives a different key. Version
 * 1 is plain text, which a wallet can't tie to a site. Version 2 is a Sign-In
 * with Ethereum message naming Gloam's host, so a wallet that checks can warn
 * when any other site asks for it. Turning on and restoring use version 2. A
 * version 1 signature is only asked for when the person says they have an older
 * backup (restoreOlderBackup), or to update the key in Settings; either way the
 * backup moves across (see moveBackup). A browser still on version 1 saves to the
 * backup it has until VERSION1_SAVES_UNTIL, and starts none. The server holds both
 * rules. Version 1 backups stay on the server after that, and can always be opened.
 */
import { getAddress, hexToBytes, keccak256, type Address, type Hex } from "viem";
import { readDemo } from "./demoFlag";
import { dataKeyLocked, getAllNotes, onNotesSaved, openJson, sealJson, setAllNotes, storedNotesOpen, syncFromDisk, unlockNoteVault } from "./noteVault";
import { PROMPT_DID_NOT_OPEN } from "./passkey";
import type { PayrollBatch } from "./payroll";
import { PAYROLL_SAVED_EVENT, pendingPayrollRuns, restorePayrollRuns } from "./payrollStore";
import { RECEIVE_IDENTITY_EVENT, exportReceiveKeys, importReceiveKeys } from "./receiveTag";
import { NEWER_KEY, VERSION1_SAVES_UNTIL } from "./recoveryEnd";
import type { SentLink } from "./sentLinks";
import { openSentLinks, restoreSentLinks, subscribeSentLinks } from "./sentLinksStore";
import type { LocalNote } from "./shield";

/**
 * Version 1 of the wallet message. Backups on mainnet are keyed to these exact
 * bytes, so this text must never change.
 */
export const RECOVERY_MESSAGE = [
  "Gloam recovery key",
  "",
  "Signing creates the key that backs up and restores your private balance on gloam.trade. It costs nothing and sends nothing.",
  "",
  "Only sign this on gloam.trade. Anyone with this signature could open your backup.",
  "",
  "Version 1",
].join("\n");

export { VERSION1_SAVES_UNTIL };

/**
 * The one host version 2 of the message names, in its domain and its URI.
 *
 * It is www, not the bare domain: gloam.trade answers with a 308 to
 * www.gloam.trade, so every real session runs on the www origin. MetaMask-style
 * checks compare the message's domain with the page's hostname exactly (ignoring
 * case, with no subdomain rule) and do not read the URI, so naming gloam.trade
 * would warn every real user on the real site. recoveryRpId below uses the bare
 * domain because WebAuthn lets a page claim its parent domain. Sign-In with
 * Ethereum has no such rule.
 *
 * This is part of the signed text, so it is part of the key. Never read it from
 * window.location: the same wallet would get a different key on each host. If
 * the site ever moves, wallets warn there and the key stays the same, until a
 * new message version moves the backups.
 */
const RECOVERY_DOMAIN = "www.gloam.trade";
const RECOVERY_STATEMENT =
  "Create the key that backs up and restores your private balance on Gloam. It costs nothing and sends nothing. Anyone with this signature could open your backup, so only sign it on www.gloam.trade.";
/**
 * Every field that is normally fresh stays fixed, because the same wallet must
 * sign the same bytes forever. Nothing here is a sign-in the server checks: the
 * signature never leaves the browser, so there is no replay for a nonce to stop.
 */
const RECOVERY_NONCE = "gloamrecovery2";
const RECOVERY_ISSUED_AT = "2026-10-31T00:00:00.000Z";
/** Ethereum, for every wallet on every network: the key must not follow the chain the wallet is on. */
const RECOVERY_CHAIN_ID = 1;

/**
 * Version 2 of the wallet message, an EIP-4361 message for this address in
 * EIP-55 form. "Version: 1" is EIP-4361's own format version, not ours.
 *
 * Written out by hand rather than through viem's createSiweMessage: these bytes
 * are the key, so no library update may ever be able to change them.
 * selftest-recovery-v2 pins them and checks them against viem.
 */
export function recoveryMessageV2(address: string): string {
  return [
    `${RECOVERY_DOMAIN} wants you to sign in with your Ethereum account:`,
    getAddress(address),
    "",
    RECOVERY_STATEMENT,
    "",
    `URI: https://${RECOVERY_DOMAIN}`,
    "Version: 1",
    `Chain ID: ${RECOVERY_CHAIN_ID}`,
    `Nonce: ${RECOVERY_NONCE}`,
    `Issued At: ${RECOVERY_ISSUED_AT}`,
  ].join("\n");
}

export type RecoverySource = "wallet" | "passkey";

export type RecoveryKeys = {
  source: RecoverySource;
  /** Where the backup is filed (hex). */
  id: string;
  /** Proves the right to replace or delete it (hex). */
  write: string;
  /** AES-256-GCM key (base64). */
  key: string;
  /** On keys from the version 2 wallet message: the wallet that signed it. */
  wallet?: string;
};

type WalletKeys = RecoveryKeys & { wallet: string };

export type RecoveryErrorCode = "cancelled" | "unsupported" | "notfound" | "failed";

export class RecoveryError extends Error {
  constructor(
    message: string,
    readonly code: RecoveryErrorCode = "failed",
    /** The server refused for now and said how long to wait. */
    readonly retryAfterSec?: number,
  ) {
    super(message);
    this.name = "RecoveryError";
  }
}

/* ------------------------------------------------------------ bytes */

const enc = new TextEncoder();

function ab(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(bytes.byteLength);
  out.set(bytes);
  return out;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function toB64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function fromB64(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/* ------------------------------------------------------------ keys */

const HKDF_SALT = enc.encode("gloam/recovery/v1");

async function hkdf(secret: Uint8Array, info: string): Promise<Uint8Array> {
  const base = await crypto.subtle.importKey("raw", ab(secret), "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: HKDF_SALT, info: enc.encode(info) },
    base,
    256,
  );
  return new Uint8Array(bits);
}

export async function keysFromSecret(source: RecoverySource, secret: Uint8Array): Promise<RecoveryKeys> {
  const [id, write, key] = await Promise.all([
    hkdf(secret, "backup id"),
    hkdf(secret, "write token"),
    hkdf(secret, "backup key"),
  ]);
  return { source, id: toHex(id), write: toHex(write), key: toB64(key) };
}

/**
 * The secret inside a wallet signature of either message, or null when the
 * signature can't serve as a key (smart accounts and passkey wallets sign
 * differently every time, or in a different format).
 */
export function walletSecret(signature: Hex): Uint8Array | null {
  let bytes: Uint8Array;
  try {
    bytes = hexToBytes(signature);
  } catch {
    return null;
  }
  if (bytes.length !== 65) return null;
  // r and s only: wallets disagree on how they write v, never on r and s.
  return hexToBytes(keccak256(bytes.slice(0, 64)));
}

/** The connected wallet, as recovery uses it. `sign` is one prompt in the wallet. */
export type RecoveryWallet = { address: string; sign: (message: string) => Promise<Hex> };

async function walletKeys(wallet: RecoveryWallet, message: string): Promise<RecoveryKeys> {
  const secret = walletSecret(await wallet.sign(message));
  if (!secret) throw new RecoveryError("This wallet can't create a recovery key. Use a passkey instead.", "unsupported");
  return keysFromSecret("wallet", secret);
}

/** Keys from version 1, only ever to find, open or delete a backup made with them. */
function version1Keys(wallet: RecoveryWallet): Promise<RecoveryKeys> {
  return walletKeys(wallet, RECOVERY_MESSAGE);
}

async function version2Keys(wallet: RecoveryWallet): Promise<WalletKeys> {
  return { ...(await walletKeys(wallet, recoveryMessageV2(wallet.address))), wallet: getAddress(wallet.address) };
}

/**
 * Signs version 2 a second time and compares. Any key nothing has proved yet
 * needs this, because a wallet that signs differently each time could never
 * rebuild it. A version 1 key proves nothing here: the check has to be on these
 * bytes, from the wallet connected now. Opening an existing backup needs no
 * second signature, since the backup is the proof.
 */
async function checkSteady(wallet: RecoveryWallet, keys: WalletKeys): Promise<void> {
  if ((await version2Keys(wallet)).id !== keys.id) {
    throw new RecoveryError(
      "Your wallet signs differently each time, so it can't hold a recovery key. Use a passkey instead.",
      "unsupported",
    );
  }
}

/* ------------------------------------------------------------ passkey */

/** One rpId for gloam.trade and www.gloam.trade, so a passkey works on both. */
function recoveryRpId(): string {
  const h = window.location.hostname;
  return h === "gloam.trade" || h.endsWith(".gloam.trade") ? "gloam.trade" : h;
}

async function prfSalt(): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode("gloam/recovery/prf/v1")));
}

function randomBytes(n: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(n);
  crypto.getRandomValues(out);
  return out;
}

const NO_PRF =
  "This browser or passkey can't create a recovery key. Use Chrome, Safari or Edge with a passkey saved to your Google or Apple account, or use your wallet.";

/** The browser or passkey can't give a recovery key at all (no PRF), as opposed to a prompt that was closed. */
export function noPasskeyRecovery(e: unknown): boolean {
  return e instanceof RecoveryError && e.code === "unsupported" && e.message === NO_PRF;
}

/** A passkey call that fails this fast never showed a prompt: the browser refused it outright. */
const NO_PROMPT_MS = 1_000;

function passkeyError(e: unknown, ms = Infinity): RecoveryError {
  if (e instanceof RecoveryError) return e;
  const name = e instanceof DOMException ? e.name : "";
  if (name === "NotAllowedError" && ms < NO_PROMPT_MS) return new RecoveryError(PROMPT_DID_NOT_OPEN, "unsupported");
  if (name === "NotAllowedError" || name === "AbortError") {
    return new RecoveryError("The passkey prompt was closed. Nothing changed.", "cancelled");
  }
  if (name === "NotSupportedError") return new RecoveryError(NO_PRF, "unsupported");
  if (name === "SecurityError") {
    return new RecoveryError("Passkeys don't work on this address. Open Gloam on gloam.trade.", "failed");
  }
  return new RecoveryError("The passkey didn't respond. Nothing changed. Try again.", "failed");
}

function prfOutput(cred: PublicKeyCredential | null): Uint8Array | null {
  const first = cred?.getClientExtensionResults().prf?.results?.first;
  if (!first) return null;
  return first instanceof ArrayBuffer ? new Uint8Array(first) : new Uint8Array(first.buffer, first.byteOffset, first.byteLength);
}

async function passkeyGet(rpId: string, salt: Uint8Array<ArrayBuffer>, credentialId?: ArrayBuffer): Promise<Uint8Array> {
  let cred: PublicKeyCredential | null;
  const t0 = Date.now();
  try {
    cred = (await navigator.credentials.get({
      publicKey: {
        challenge: randomBytes(32),
        rpId,
        userVerification: "required",
        timeout: 120_000,
        ...(credentialId ? { allowCredentials: [{ type: "public-key" as const, id: credentialId }] } : {}),
        extensions: { prf: { eval: { first: salt } } },
      },
    })) as PublicKeyCredential | null;
  } catch (e) {
    throw passkeyError(e, Date.now() - t0);
  }
  if (!cred) throw new RecoveryError("The passkey prompt was closed. Nothing changed.", "cancelled");
  const out = prfOutput(cred);
  if (!out) throw new RecoveryError(NO_PRF, "unsupported");
  return out;
}

/**
 * The secret from a recovery passkey. "create" makes a new passkey (and may
 * need one more prompt to read its secret); "use" lets the person pick the
 * passkey they made before, on any device it synced to.
 */
export async function passkeySecret(mode: "create" | "use"): Promise<Uint8Array> {
  if (typeof window === "undefined" || !window.PublicKeyCredential || !navigator.credentials) {
    throw new RecoveryError(NO_PRF, "unsupported");
  }
  const rpId = recoveryRpId();
  const salt = await prfSalt();
  if (mode === "use") return passkeyGet(rpId, salt);

  let cred: PublicKeyCredential | null;
  const t0 = Date.now();
  try {
    cred = (await navigator.credentials.create({
      publicKey: {
        rp: { id: rpId, name: "Gloam" },
        user: { id: randomBytes(16), name: "Gloam recovery", displayName: "Gloam recovery" },
        challenge: randomBytes(32),
        pubKeyCredParams: [
          { type: "public-key", alg: -7 },
          { type: "public-key", alg: -257 },
        ],
        authenticatorSelection: { residentKey: "required", userVerification: "required" },
        timeout: 120_000,
        extensions: { prf: { eval: { first: salt } } },
      },
    })) as PublicKeyCredential | null;
  } catch (e) {
    throw passkeyError(e, Date.now() - t0);
  }
  if (!cred) throw new RecoveryError("The passkey prompt was closed. Nothing changed.", "cancelled");
  const direct = prfOutput(cred);
  if (direct) return direct;
  if (cred.getClientExtensionResults().prf?.enabled === false) throw new RecoveryError(NO_PRF, "unsupported");
  // Many authenticators only return the secret on sign-in, not at creation.
  return passkeyGet(rpId, salt, cred.rawId);
}

/* ------------------------------------------------------------ backup payload */

type ReceiveKeys = Awaited<ReturnType<typeof exportReceiveKeys>>;

type Payload = {
  v: 1;
  savedAt: number;
  notes: LocalNote[];
  receive: ReceiveKeys;
  /** Sent codes whose money has not moved. For a claim link this may be the only copy. */
  links?: SentLink[];
  /** Payroll runs holding a payment that may still land, with its codes and secrets. */
  payroll?: PayrollBatch[];
};

function spendable(n: LocalNote): boolean {
  return n.status !== "recovered" && Boolean(n.secret) && n.secret !== "0x" && !n.id.startsWith("pay-");
}

/** What a restore takes from a backup. */
function restorable(n: LocalNote): boolean {
  if (!n?.id || !n.secret || n.secret === "0x" || !n.commitment || !n.amountWei) return false;
  return !n.id.startsWith("pay-") && n.status !== "recovered";
}

const noteKey = (n: LocalNote) => `${n.chainId}:${n.commitment.toLowerCase()}`;

function receiveIds(r: ReceiveKeys | undefined): string[] {
  return [r?.current, ...(r?.previous ?? [])].flatMap((k) => (k ? [k.publicSpkiB64] : []));
}

/**
 * Whether `next` holds what restoring `old` would have given back: every note
 * (or this browser has seen it spent) and every receive key. Sent codes and
 * payroll runs are left out, since this browser may rightly have closed them.
 */
function carriedOver(old: Payload, next: Payload): boolean {
  const notes = new Set([...next.notes, ...getAllNotes().filter((n) => n.status === "recovered")].filter((n) => n.commitment).map(noteKey));
  const receive = new Set(receiveIds(next.receive));
  return old.notes.filter(restorable).every((n) => notes.has(noteKey(n))) && receiveIds(old.receive).every((k) => receive.has(k));
}

/**
 * This tab's copy of the notes brought up to the store. A page without the notes
 * hook holds nothing until the vault is unlocked, and a tab left open holds what
 * it read last, so neither can stand for what this browser has. A vault behind
 * its passkey waits here for the unlock, and this never asks for it.
 */
async function readNotesNow(): Promise<void> {
  if (readDemo()) return;
  await unlockNoteVault();
  await syncFromDisk();
}

async function collect(): Promise<Payload> {
  await readNotesNow();
  // A save replaces the backup, so an empty list from notes that didn't open must never be one.
  if (!(await storedNotesOpen())) throw new RecoveryError("This browser can't open its private balance, so the backup stays as it is.");
  return {
    v: 1,
    savedAt: Date.now(),
    notes: getAllNotes().filter(spendable),
    receive: await exportReceiveKeys(),
    links: await openSentLinks(),
    payroll: await pendingPayrollRuns(),
  };
}

/** What a save holds, leaving out when it was made: the same unless something changed. */
async function contentMark(p: Payload): Promise<string> {
  const held: Partial<Payload> = { ...p };
  delete held.savedAt;
  return toB64(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(JSON.stringify(held)))));
}

async function aesKey(keys: RecoveryKeys): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", fromB64(keys.key), "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function seal(keys: RecoveryKeys, payload: Payload): Promise<string> {
  const iv = randomBytes(12);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: enc.encode(keys.id) },
      await aesKey(keys),
      enc.encode(JSON.stringify(payload)),
    ),
  );
  const out = new Uint8Array(12 + ct.length);
  out.set(iv);
  out.set(ct, 12);
  return toB64(out);
}

async function open(keys: RecoveryKeys, blob: string): Promise<Payload> {
  try {
    const raw = fromB64(blob);
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: raw.slice(0, 12), additionalData: enc.encode(keys.id) },
      await aesKey(keys),
      raw.slice(12),
    );
    const p = JSON.parse(new TextDecoder().decode(plain)) as Payload;
    if (p?.v !== 1 || !Array.isArray(p.notes)) throw new Error("bad payload");
    return p;
  } catch {
    throw new RecoveryError("This key doesn't open the saved backup.", "failed");
  }
}

/**
 * Adds restored notes this browser doesn't have yet. With `owner`, restored
 * notes are shown under that wallet (the one signed in now). Returns how many
 * were added.
 */
function mergeNotes(restored: LocalNote[], owner?: string | null): number {
  const local = getAllNotes();
  const ids = new Set(local.map((n) => n.id));
  const commitments = new Set(local.map((n) => `${n.chainId}:${n.commitment.toLowerCase()}`));
  const added: LocalNote[] = [];
  for (const n of restored) {
    if (!restorable(n)) continue;
    if (ids.has(n.id) || commitments.has(noteKey(n))) continue;
    added.push({ ...n, from: owner ? (owner as Address) : n.from, status: "open", source: "local" });
  }
  if (added.length) setAllNotes([...added, ...local]);
  return added.length;
}

/**
 * Takes in a backup: its notes, then the codes it carries, each added only
 * where this browser does not have it yet. Returns how many notes were added.
 */
async function mergePayload(p: Payload, owner?: string | null): Promise<number> {
  await readNotesNow();
  const added = mergeNotes(p.notes, owner);
  await restoreSentLinks(p.links);
  await restorePayrollRuns(p.payroll, owner);
  return added;
}

/**
 * Takes in a backup beside what this browser holds, keeping this browser's
 * Gloam address: the backup's receive keys join the earlier ones. Returns how
 * many notes were added.
 */
async function absorb(p: Payload, owner?: string | null): Promise<number> {
  const added = await mergePayload(p, owner);
  await importReceiveKeys({ current: null, previous: [p.receive?.current, ...(p.receive?.previous ?? [])] });
  return added;
}

/* ------------------------------------------------------------ server */

type Remote = { c: string; n: number; t: number };

async function errorText(res: Response): Promise<string> {
  const json = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
  return json?.error?.message ?? `The backup service answered ${res.status}.`;
}

/** A refused save as an error, carrying the server's wait when it gave one. */
async function refusal(res: Response): Promise<RecoveryError> {
  const wait = res.status === 429 ? Number(res.headers.get("Retry-After")) : 0;
  return new RecoveryError(await errorText(res), "failed", wait > 0 ? Math.min(wait, 86_400) : undefined);
}

async function fetchRemote(id: string): Promise<Remote | null> {
  let res: Response;
  try {
    res = await fetch(`/api/recovery?id=${id}`, { cache: "no-store" });
  } catch {
    throw new RecoveryError("No connection. Check your internet and try again.");
  }
  if (res.status === 404) return null;
  if (!res.ok) throw new RecoveryError(await errorText(res));
  const json = (await res.json()) as { data: Remote };
  return json.data;
}

/**
 * A newer key says so on every save. A version 1 key says nothing and must find
 * a backup there: with none, or past the end date, the server answers 410 and
 * writes nothing.
 */
async function putBackup(keys: RecoveryKeys, c: string, n: number): Promise<Response> {
  try {
    return await fetch("/api/recovery", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: keys.id, write: keys.write, c, n, ...(isVersion1(keys) ? { mustExist: true } : { v: NEWER_KEY }) }),
    });
  } catch {
    throw new RecoveryError("No connection. Your balance is safe here and backs up when you're back online.");
  }
}

/** Null when the request never got an answer. */
function deleteRemote(backup: { id: string; write: string }): Promise<Response | null> {
  return fetch("/api/recovery", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: backup.id, write: backup.write }),
  }).catch(() => null);
}

/* ------------------------------------------------------------ state */

const CONFIG_KEY = "gloam.recovery.v1";
/** contentMark of the last save, to tell on a page load whether something since never went up. */
const MARK_KEY = "gloam.recovery.mark.v1";
/** Set when the person turns recovery off on this browser, cleared when it is turned on again. */
const TURNED_OFF_KEY = "gloam.recovery.off.v1";

/** The person turned recovery off on this browser, so nothing may offer to turn it on for them. */
export function recoveryTurnedOffHere(): boolean {
  try {
    return localStorage.getItem(TURNED_OFF_KEY) === "1";
  } catch {
    return false;
  }
}

/** A storage that refuses (private mode, a full quota) must not stop recovery turning on or off. */
function markTurnedOff(off: boolean) {
  try {
    if (off) localStorage.setItem(TURNED_OFF_KEY, "1");
    else localStorage.removeItem(TURNED_OFF_KEY);
  } catch {
    /* the mark is a courtesy: the setting itself is saved */
  }
}

/**
 * What this browser keeps, sealed by the note vault. Settings saved before
 * version 2 have none of the optional fields, and go on working as they are.
 */
type Config = RecoveryKeys & {
  n: number;
  /** When the backup last saved. Null means the server holds nothing for these keys yet. */
  savedAt: number | null;
  /** The server refused the last save: no automatic try before this time. */
  retryAt?: number;
  /** Version 2 keys a version 1 backup is still moving to. Finishes with no wallet prompt. */
  next?: { keys: WalletKeys; tries: number; retryAt: number };
  /** A backup already moved to these keys, still to be deleted. */
  retire?: { id: string; write: string };
  /** This version 1 backup vanished from the server: another device moved or deleted it. */
  gone?: boolean;
  /** The server refused this version 1 backup for the end date, whatever this browser's clock says. */
  ended?: boolean;
};

/** A wallet key from the version 1 message. */
function isVersion1(c: Pick<RecoveryKeys, "source" | "wallet">): boolean {
  return c.source === "wallet" && !c.wallet;
}

/**
 * This browser no longer saves under its version 1 key: it never made a backup,
 * and the server starts no new ones; the backup left the server; or the end date
 * passed. Everything stays here, and updating the key starts saving again.
 */
function savesPaused(c: Config): boolean {
  return isVersion1(c) && (c.n === 0 || Boolean(c.gone || c.ended) || Date.now() >= VERSION1_SAVES_UNTIL);
}

export type RecoveryState = {
  /** The saved settings have been read. */
  ready: boolean;
  on: boolean;
  source: RecoverySource | null;
  /** When the backup last saved. On, with this null: nothing is backed up yet. */
  savedAt: number | null;
  busy: boolean;
  error: string | null;
  /** When this browser next tries by itself, after the server refused a save. */
  retryAt: number | null;
  /** On with a version 1 wallet key: it works, and can be updated. */
  olderKey: boolean;
  /** On with a version 2 wallet key. */
  newerKey: boolean;
  /** A version 1 backup is moving to the newer key, and needs no more signatures. */
  moving: boolean;
  /** Another device moved or deleted this version 1 backup. Never true on a browser that didn't save to it. */
  gone: boolean;
  /** On with a version 1 wallet key that no longer saves, until it is updated. With savedAt null, it never did. */
  paused: boolean;
};

const OFF: RecoveryState = {
  ready: false,
  on: false,
  source: null,
  savedAt: null,
  busy: false,
  error: null,
  retryAt: null,
  olderKey: false,
  newerKey: false,
  moving: false,
  gone: false,
  paused: false,
};

let config: Config | null = null;
let loading: Promise<Config | null> | null = null;
let state: RecoveryState = OFF;
const subscribers = new Set<() => void>();

function setState(patch: Partial<RecoveryState>) {
  state = { ...state, ...patch };
  for (const fn of subscribers) fn();
}

export function recoveryState(): RecoveryState {
  return state;
}

export function recoveryServerState(): RecoveryState {
  return OFF;
}

export function subscribeRecovery(fn: () => void): () => void {
  subscribers.add(fn);
  return () => {
    subscribers.delete(fn);
  };
}

/** The part of the state that comes from the saved settings. */
function shownState(c: Config | null): Partial<RecoveryState> {
  return {
    on: Boolean(c),
    source: c?.source ?? null,
    savedAt: c?.savedAt ?? null,
    retryAt: c?.retryAt ?? null,
    olderKey: c ? isVersion1(c) : false,
    newerKey: Boolean(c?.wallet),
    moving: Boolean(c?.next),
    gone: Boolean(c && c.gone && isVersion1(c) && c.n > 0),
    paused: c ? savesPaused(c) : false,
  };
}

function loadConfig(): Promise<Config | null> {
  return (loading ??= (async () => {
    config = await openJson<Config>(localStorage.getItem(CONFIG_KEY));
    setState({ ready: true, ...shownState(config) });
    return config;
  })());
}

async function saveConfig(next: Config | null) {
  config = next;
  // a later loadConfig() reads this, not the settings as they were first read
  loading = Promise.resolve(next);
  if (next) localStorage.setItem(CONFIG_KEY, await sealJson(next));
  else {
    localStorage.removeItem(CONFIG_KEY);
    localStorage.removeItem(MARK_KEY);
  }
  setState(shownState(next));
}

/* ------------------------------------------------------------ sync */

/**
 * Set while recovery is being turned off: no new save starts, and one that
 * finishes doesn't turn recovery back on.
 */
let stopping = false;
/** The job under way (settled either way), so turning off can wait for it. */
let inFlight: Promise<void> | null = null;

function tracked<T>(job: Promise<T>): Promise<T> {
  const settled = job.then(
    () => undefined,
    () => undefined,
  );
  inFlight = settled;
  void settled.then(() => {
    if (inFlight === settled) inFlight = null;
  });
  return job;
}

/** Whether `c` is still the backup this browser saves to. */
function stillOn(c: Config): boolean {
  return !stopping && config?.id === c.id;
}

/** The server said to wait, so a change saves nothing until then. "Back up now" still tries. */
function holding(c: Config): boolean {
  return Boolean(c.retryAt && c.retryAt > Date.now());
}

function moveDue(c: Config): boolean {
  return Boolean(c.next && c.next.retryAt <= Date.now());
}

/** Work that nothing else would start after a page load. */
function unfinished(c: Config): boolean {
  return !c.savedAt || Boolean(c.retryAt || c.next || c.retire);
}

/** Spread over which browsers refused for the day come back, so they don't all land at midnight. */
const RETRY_SPREAD_MS = 10 * 60_000;
const BACKOFF_START_MS = 60_000;
const BACKOFF_MAX_MS = 30 * 60_000;

/** The server's wait when it gave one, a little spread out; otherwise doubling from a minute. */
function retryDelay(e: unknown, tries: number): number {
  const sec = e instanceof RecoveryError ? e.retryAfterSec : undefined;
  if (sec) return sec * 1000 + Math.random() * Math.min(sec * 100, RETRY_SPREAD_MS);
  return Math.min(BACKOFF_START_MS * 2 ** tries, BACKOFF_MAX_MS);
}

/**
 * Saves this browser's private balance to the backup. One retry after a conflict.
 * With `skipSame`, a save holding exactly what the backup already holds (the last
 * save, or a pull that found it all there) isn't sent.
 */
async function upload(c: Config, { skipSame = false }: { skipSame?: boolean } = {}): Promise<void> {
  let current = c;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!stillOn(current) || savesPaused(current)) return;
    const payload = await collect();
    if (skipSame && attempt === 0 && localStorage.getItem(MARK_KEY) === (await contentMark(payload))) return;
    const blob = await seal(current, payload);
    if (!stillOn(current)) return;
    const res = await putBackup(current, blob, current.n + 1);
    if (res.ok) {
      const { data } = (await res.json()) as { data: { n: number; t: number } };
      const mark = await contentMark(payload);
      // Turned off while this was saving: it stays off.
      if (stillOn(current)) {
        await saveConfig({ ...config!, n: data.n, savedAt: data.t, retryAt: undefined });
        localStorage.setItem(MARK_KEY, mark);
      }
      return;
    }
    if (res.status === 410) {
      // Nothing was written, and this browser keeps its copy. A backup still there
      // means the end date passed on the server's clock, whatever this one says. One
      // that isn't left the server. Either way the panel asks to update.
      const held = await fetchRemote(current.id);
      if (stillOn(current)) await saveConfig({ ...config!, retryAt: undefined, ...(held ? { ended: true } : { gone: true }) });
      return;
    }
    if (res.status === 409 && attempt === 0) {
      // Another device saved first: take in what it has, then save on top.
      const remote = await fetchRemote(current.id);
      if (remote) {
        await absorb(await open(current, remote.c));
        current = { ...current, n: remote.n };
        continue;
      }
    }
    throw await refusal(res);
  }
}

/**
 * Saves this browser's whole copy under `to`, then reads it back from the server
 * and opens it. Throws unless what came back holds everything `old` held.
 */
async function saveConfirmed(to: RecoveryKeys, old: Payload | null, owner?: string | null): Promise<Remote> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const there = await fetchRemote(to.id);
    if (there) await absorb(await open(to, there.c), owner);
    const res = await putBackup(to, await seal(to, await collect()), (there?.n ?? 0) + 1);
    if (res.status === 409 && attempt === 0) continue;
    if (!res.ok) throw await refusal(res);
    const back = await fetchRemote(to.id);
    const opened = back ? await open(to, back.c) : null;
    if (!back || !opened || (old && !carriedOver(old, opened))) break;
    return back;
  }
  throw new RecoveryError("The new copy of your backup didn't check out. Your backup wasn't changed.");
}

/** Deletes a backup that moved. A failure leaves `retire` set, so a later sync tries again. */
async function retireOld(c: Config): Promise<void> {
  const res = c.retire ? await deleteRemote(c.retire) : null;
  if (res?.ok && stillOn(c)) await saveConfig({ ...config!, retire: undefined });
}

/**
 * Moves the version 1 backup this browser uses to version 2 keys. The order is
 * what keeps people's money reachable, and the old backup is never written to:
 *
 *  1. read and open the old backup, and take it in here
 *  2. take in any backup already under the new keys, from another device
 *  3. save the whole copy under the new keys, read it back, and check it
 *  4. only then switch this browser over, with the old backup marked to delete
 *  5. delete it
 *
 * A failure before step 4 leaves the old backup as it was, and this browser
 * keeps saving to it until the end date. The new keys wait in the settings, so the move finishes
 * later on its own with no wallet prompt: the new copy is a new backup, which
 * the server can refuse for the day. A page closed between 4 and 5 finishes the
 * delete on its next load. Always runs alone (see `alone`).
 */
async function moveBackup(to: WalletKeys, owner?: string | null): Promise<"newest" | "waiting"> {
  const from = config;
  if (!from || !isVersion1(from)) return "waiting";
  try {
    const remote = await fetchRemote(from.id);
    const old = remote ? await open(from, remote.c) : null;
    if (old) await absorb(old, owner);
    const saved = await saveConfirmed(to, old, owner);
    if (!stillOn(from)) {
      // Turned off meanwhile. It stays off, so the copy just made goes too.
      await deleteRemote(to);
      return "waiting";
    }
    await saveConfig({ ...to, n: saved.n, savedAt: saved.t, retire: { id: from.id, write: from.write } });
    await retireOld(config!);
    // a change that landed during the move saves to the new backup
    schedule();
    return "newest";
  } catch (e) {
    if (stillOn(from)) {
      const tries = (from.next?.tries ?? 0) + 1;
      await saveConfig({ ...config!, next: { keys: to, tries, retryAt: Date.now() + retryDelay(e, tries - 1) } });
      armRetry();
    }
    return "waiting";
  }
}

/** The parts of a move still to finish. Needs no signature: the keys are already here. */
async function finishMove(): Promise<void> {
  if (config && !stopping && moveDue(config)) await moveBackup(config.next!.keys);
  if (config?.retire && !stopping) await retireOld(config);
}

let timer: number | undefined;
let retryTimer: number | undefined;
let running = false;
let again = false;
/** Failed saves in a row that the server gave no wait for. */
let failures = 0;

function retryIn(ms: number) {
  window.clearTimeout(retryTimer);
  retryTimer = window.setTimeout(() => void runSync("retry"), ms);
}

/** Sets the timer for the next wait in the settings. A page load calls this too, so waits outlive the page. */
function armRetry() {
  if (!config || stopping) return;
  // a wait for a save that won't happen has nothing to come back for
  const times = [savesPaused(config) ? undefined : config.retryAt, config.next?.retryAt].filter((t): t is number => Boolean(t));
  if (times.length) retryIn(Math.max(0, Math.min(...times) - Date.now()));
}

/** After a failed save: says why, and tries again later without being asked. */
async function waitToRetry(e: RecoveryError) {
  setState({ error: e.message });
  const c = config;
  if (!c || !stillOn(c)) return;
  const wait = retryDelay(e, failures++);
  // A refusal goes in the settings: the page may close long before the wait ends.
  if (e.retryAfterSec) await saveConfig({ ...c, retryAt: Date.now() + wait });
  retryIn(wait);
}

/** Runs `job` with no save or move beside it. A change meanwhile is saved right after. */
async function alone<T>(job: () => Promise<T>): Promise<T> {
  while (running) await (inFlight ?? new Promise((r) => window.setTimeout(r, 50)));
  running = true;
  setState({ busy: true });
  try {
    return await tracked(job());
  } finally {
    running = false;
    setState({ busy: false });
    if (again) {
      again = false;
      schedule();
    }
  }
}

const SAVES_PAUSED = "This browser has stopped saving. Update your recovery key to start again.";

/** A save went unfinished, so a retry should make one. A retry that is only for a move should not. */
function saveOwed(c: Config): boolean {
  return !c.savedAt || Boolean(c.retryAt) || failures > 0;
}

/** The end date can pass with a page open. */
function showPause(c: Config) {
  if (savesPaused(c) !== state.paused) setState(shownState(c));
}

/**
 * One round of saving. "change": something changed. "retry": a timer came due.
 * "button": Back up now, which also tries through a server wait. Returns what
 * went wrong.
 */
async function runSync(trigger: "change" | "retry" | "button"): Promise<RecoveryError | null> {
  const c = config ?? (await loadConfig());
  if (!c || stopping) return null;
  if (running && trigger !== "button") {
    again = true;
    return null;
  }
  showPause(c);
  const save = !savesPaused(c) && (trigger === "button" || (!holding(c) && (trigger === "change" || saveOwed(c))));
  // Back up now must not read as saved when this browser no longer saves.
  const unsaved = () => (trigger === "button" && config && savesPaused(config) ? new RecoveryError(SAVES_PAUSED) : null);
  if (!save && !moveDue(c) && !c.retire) {
    // A timer can run a moment before the wait ends, since it doesn't share the
    // wall clock. Setting it again keeps the retry from being dropped here.
    armRetry();
    return unsaved();
  }
  return alone(async () => {
    try {
      if (save && config) {
        await upload(config, { skipSame: trigger === "change" && !saveOwed(config) });
        failures = 0;
        setState({ error: null });
      }
      await finishMove();
      armRetry();
      return unsaved();
    } catch (e) {
      const failed = e instanceof RecoveryError ? e : new RecoveryError("The backup didn't save. It will try again.");
      await waitToRetry(failed);
      return failed;
    }
  });
}

function schedule() {
  if (!config || stopping) return;
  window.clearTimeout(timer);
  timer = window.setTimeout(() => void runSync("change"), 2500);
}

/** Picks up anything left to do: on load, back online, or back on this tab. */
function resume() {
  if (!config || stopping) return;
  showPause(config);
  armRetry();
  // a wait in the settings has its own timer, and a save now would only go twice
  if (unfinished(config) && !config.retryAt && !config.next) schedule();
  void pullBackup();
}

/** How often coming back to the tab reads the backup for what other devices saved. */
const PULL_EVERY_MS = 30_000;
let lastPull = 0;

/**
 * Brings in what another device saved to this backup since this browser last
 * saw it, so the balance is the same on every device without a save here first.
 * Uses the keys already in the settings: no prompt. Read only: the backup is
 * opened here and nothing about it changes on the server. A newer copy is taken
 * in the way a save conflict takes one in (absorb), and a change it brings is
 * saved back up as usual. Quiet on any failure: the next focus tries again.
 */
export async function pullBackup({ force = false }: { force?: boolean } = {}): Promise<number> {
  if (typeof window === "undefined" || readDemo()) return 0;
  const c = config ?? (await loadConfig());
  // A vault behind its passkey opens only when the person unlocks it, and a pull must not hold the saves up meanwhile.
  if (!c || stopping || dataKeyLocked()) return 0;
  if (!force && Date.now() - lastPull < PULL_EVERY_MS) return 0;
  lastPull = Date.now();
  try {
    // A look first, outside `alone`: most of the time nothing is newer, and nothing should show as busy.
    const peek = await fetchRemote(c.id);
    if (!peek || peek.n <= c.n || !stillOn(c)) return 0;
    return await alone(async () => {
      const now = config;
      if (!now || !stillOn(now)) return 0;
      const remote = await fetchRemote(now.id);
      if (!remote || remote.n <= now.n) return 0;
      const theirs = await open(now, remote.c);
      const added = await absorb(theirs);
      if (!stillOn(now)) return added;
      await saveConfig({ ...config!, n: remote.n, savedAt: remote.t, gone: undefined });
      // Everything here is already in the backup: say so, so the change this pull made saves nothing.
      // Anything the backup lacks still goes up, as a change always does.
      const mine = await collect().catch(() => null);
      if (mine && holdsAll(theirs, mine)) localStorage.setItem(MARK_KEY, await contentMark(mine));
      return added;
    });
  } catch {
    return 0;
  }
}

/**
 * Whether `backup` already holds everything `here` would save: every note (or
 * this browser has seen it spent), every receive key, every open sent code and
 * every payroll run.
 */
function holdsAll(backup: Payload, here: Payload): boolean {
  if (!carriedOver(here, backup)) return false;
  const codes = new Set((backup.links ?? []).map((l) => l.code));
  const runs = new Set((backup.payroll ?? []).map((b) => b.id));
  return (here.links ?? []).every((l) => codes.has(l.code)) && (here.payroll ?? []).every((b) => runs.has(b.id));
}

/**
 * Saves what the last save didn't hold: a change made while no backup was
 * running, or on a page that closed before its save. Nothing else would start
 * one, since a page load changes no note. A browser that can't read its notes
 * yet, or at all, saves nothing here.
 */
async function catchUp(): Promise<void> {
  const c = config;
  // Work already waiting (resume) saves everything anyway.
  if (!c || stopping || unfinished(c)) return;
  const current = await collect().catch(() => null);
  if (current && stillOn(c) && localStorage.getItem(MARK_KEY) !== (await contentMark(current))) schedule();
}

let started = false;

/** Keep the backup current from now on. Safe to call more than once. */
export function startRecoverySync() {
  if (started || typeof window === "undefined" || readDemo()) return;
  started = true;
  onNotesSaved(schedule);
  subscribeSentLinks(schedule);
  window.addEventListener(PAYROLL_SAVED_EVENT, schedule);
  window.addEventListener(RECEIVE_IDENTITY_EVENT, schedule);
  window.addEventListener("online", resume);
  window.addEventListener("focus", resume);
  // Another tab moved the backup or turned recovery off: follow it, so this tab
  // can't save to the old backup or write the old settings back.
  window.addEventListener("storage", (e) => {
    if (e.key !== CONFIG_KEY) return;
    loading = null;
    void loadConfig().then(resume);
  });
  void loadConfig().then(() => {
    resume();
    return catchUp();
  });
}

/** Save now (the "Back up now" button). Throws when it didn't save, so nothing can say it did. */
export async function backupNow(): Promise<void> {
  const failed = await runSync("button");
  if (failed) throw failed;
}

/**
 * Turns recovery on with these keys. A backup that already exists for them
 * (made on another device) is merged in first, so turning it on also restores.
 * With `mustExist`, a missing backup is an error ("restore" rather than
 * "turn on"). With `save: false`, the backup is only read. Returns how many
 * notes came back.
 *
 * A save that fails here doesn't throw: recovery is on, savedAt stays as the
 * server left it (null means no backup yet), the reason is in the state, and
 * this browser keeps trying.
 */
export async function connectRecovery(
  keys: RecoveryKeys,
  owner: string | null | undefined,
  { mustExist = false, save = true }: { mustExist?: boolean; save?: boolean } = {},
): Promise<number> {
  startRecoverySync();
  await loadConfig();
  setState({ busy: true, error: null });
  try {
    const remote = await fetchRemote(keys.id);
    if (!remote && mustExist) {
      throw new RecoveryError(
        keys.source === "wallet"
          ? "No backup found for this wallet. Turn on recovery on the device that has your balance first."
          : "No backup found for this passkey. Turn on recovery on the device that has your balance first.",
        "notfound",
      );
    }
    let added = 0;
    if (remote) {
      const p = await open(keys, remote.c);
      added = await mergePayload(p, owner);
      await importReceiveKeys(p.receive);
    }
    const next: Config = { ...keys, n: remote?.n ?? 0, savedAt: remote?.t ?? null };
    await saveConfig(next);
    markTurnedOff(false);
    if (save) {
      try {
        await tracked(upload(next));
        setState({ error: null });
      } catch (e) {
        await waitToRetry(e instanceof RecoveryError ? e : new RecoveryError("The backup didn't save. It will try again."));
      }
    }
    return added;
  } finally {
    setState({ busy: false });
  }
}

/** Turns recovery on with the wallet: version 2, signed twice. */
export async function turnOnWithWallet(wallet: RecoveryWallet): Promise<number> {
  const keys = await version2Keys(wallet);
  await checkSteady(wallet, keys);
  return connectRecovery(keys, wallet.address);
}

/** Moves the backup with `alone`, since a save must not land on the old one as it goes. */
function moveNow(to: WalletKeys, owner?: string | null): Promise<"newest" | "waiting"> {
  return alone(() => moveBackup(to, owner));
}

/**
 * Where a restored backup ended up: "newest" on version 2, "waiting" on its way
 * there by itself, "older" staying on version 1, where it can be updated from
 * Settings.
 */
type Restored = { added: number; key: "newest" | "waiting" | "older" };

/**
 * Restores with the wallet: version 2, one signature, and the backup it finds is
 * the proof that the key holds. With none there it says so, and asks for nothing
 * else. Someone with a version 1 backup takes the next step: restoreOlderBackup.
 */
export async function restoreWithWallet(wallet: RecoveryWallet): Promise<Restored> {
  return { added: await connectRecovery(await version2Keys(wallet), wallet.address, { mustExist: true }), key: "newest" };
}

/**
 * Restores a version 1 backup, for someone who says they have one. It opens with
 * one signature, then version 2 is signed twice before the backup can move.
 * Getting the money back comes first, so nothing after the restore can undo it:
 * if those two are declined or don't match, it stays on version 1 ("older").
 * This works on any date.
 */
export async function restoreOlderBackup(wallet: RecoveryWallet): Promise<Restored> {
  const from = await version1Keys(wallet);
  if (!(await fetchRemote(from.id))) throw new RecoveryError(NO_OLDER_BACKUP, "notfound");
  const added = await connectRecovery(from, wallet.address, { mustExist: true, save: false });
  let to: WalletKeys;
  try {
    to = await version2Keys(wallet);
    await checkSteady(wallet, to);
  } catch {
    // from here it is a browser with version 1 on: it saves as those do, until the end date
    schedule();
    return { added, key: "older" };
  }
  return { added, key: await moveNow(to, wallet.address) };
}

const NO_OLDER_BACKUP = "No older backup found for this wallet.";
const WRONG_WALLET = "This isn't the wallet recovery was turned on with. Connect that wallet and try again. Nothing changed.";

/**
 * Updates a browser that has version 1 recovery on: three signatures, once.
 * Version 1 first, because settings from then don't say which wallet made them,
 * and moving the backup to whichever wallet is connected could leave it out of
 * reach of the wallet the person restores with. Then version 2 twice, because
 * the old backup is about to go and nothing has proved the new key yet.
 */
export async function updateRecoveryKey(wallet: RecoveryWallet): Promise<"newest" | "waiting"> {
  const c = config ?? (await loadConfig());
  if (!c || !isVersion1(c)) throw new RecoveryError("Your recovery key is already up to date.");
  if ((await version1Keys(wallet)).id !== c.id) throw new RecoveryError(WRONG_WALLET);
  const to = await version2Keys(wallet);
  await checkSteady(wallet, to);
  return moveNow(to);
}

/**
 * Brings a version 1 backup into the version 2 backup this browser already
 * uses, then deletes it. For a wallet that turned recovery on here without
 * restoring: finding a version 1 backup takes a signature, so turning on never
 * looks for one. One signature, since the version 2 key is already proved.
 * A failure at any step leaves the older backup as it was.
 */
export async function bringInOlderBackup(wallet: RecoveryWallet): Promise<number> {
  const c = config ?? (await loadConfig());
  if (!c?.wallet) throw new RecoveryError("This only applies to recovery with your wallet.");
  if (getAddress(wallet.address) !== c.wallet) throw new RecoveryError(WRONG_WALLET);
  const from = await version1Keys(wallet);
  return alone(async () => {
    const remote = await fetchRemote(from.id);
    if (!remote) throw new RecoveryError(NO_OLDER_BACKUP, "notfound");
    const old = await open(from, remote.c);
    const added = await absorb(old, wallet.address);
    const saved = await saveConfirmed(c, old, wallet.address);
    if (stillOn(c)) {
      await saveConfig({ ...config!, n: saved.n, savedAt: saved.t, retryAt: undefined, retire: { id: from.id, write: from.write } });
      await retireOld(config!);
    }
    return added;
  });
}

/**
 * Turns recovery off on this browser, and deletes the saved backup when asked.
 * Nothing new is saved from the start, and a save already sent finishes
 * first: one landing after the delete would bring the backup back.
 */
export async function turnOffRecovery({ deleteBackup }: { deleteBackup: boolean }): Promise<void> {
  await loadConfig();
  stopping = true;
  window.clearTimeout(timer);
  window.clearTimeout(retryTimer);
  let off = false;
  try {
    await inFlight;
    // read after the wait: a move that just finished changed where the backup is
    const c = config;
    if (c && deleteBackup) {
      // every copy, the one this browser saves to last: a failure leaves it on and saving
      for (const backup of [c.retire, c.next?.keys, c]) {
        if (!backup) continue;
        const res = await deleteRemote(backup);
        if (!res?.ok) throw new RecoveryError(res ? await errorText(res) : "No connection. Try again.");
      }
    }
    window.clearTimeout(timer);
    await saveConfig(null);
    off = true;
    // Remembered so nothing offers to turn it back on (lib/embeddedRecovery). Turning it on clears it.
    markTurnedOff(true);
    setState({ error: null });
  } finally {
    stopping = false;
    // Still on (the delete failed): what changed meanwhile still gets saved.
    if (!off) schedule();
  }
}
