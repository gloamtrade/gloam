"use client";

/**
 * Encrypted-at-rest store for shield notes (audit M-1).
 *
 * Note secrets used to sit in localStorage as plaintext JSON. This module keeps
 * the working copy in memory and persists it to localStorage encrypted with
 * AES-GCM under a data key. A localStorage dump, backup, or shared-browser
 * snoop yields ciphertext, not spend keys. Other secret-bearing state (payroll
 * runs, schedules, receive keys) is sealed under the same key through
 * sealJson/openJson.
 *
 * Where the data key lives:
 *   - Device key (default): a non-extractable AES-GCM key in IndexedDB.
 *   - Passkey (optional): the key is wrapped under a key derived from a
 *     passkey's PRF output (lib/passkeyWrap.ts) and only the wrapped copy is
 *     stored. Each time the app opens the vault is locked until the passkey
 *     unwraps it; the unwrapped key lives in memory only.
 *
 * The public accessors stay synchronous (components read notes during render):
 * the cache loads a legacy plaintext blob synchronously and is filled from the
 * encrypted blob by an async unlock that the notes hook triggers on mount.
 * Persistence always waits for that unlock first, so a write can never overwrite
 * the encrypted store before it has been merged into the cache. Writes run one
 * at a time, and while a passkey vault is locked they wait for the unlock (the
 * page warns before closing with a write still waiting).
 *
 * Several tabs share one store. Each write runs under a cross-tab lock (Web
 * Locks, with a re-read-before-write check where those are missing), reads
 * what is on disk, and merges this tab's notes into it instead of replacing it,
 * so two tabs saving at once both keep their notes. A note this tab removed is
 * recorded (by id only) so the merge does not bring it back. A write resolves
 * only once the new blob is on disk and reads back the same; when the browser
 * refuses it (storage full, private mode) it rejects with NoteSaveError, so a
 * deposit or payment is never sent with a secret that was not saved.
 */
import type { LocalNote } from "./shield";
import { readDemo } from "./demoFlag";
import { demoNotes, setDemoNotes } from "./demo/store";
import {
  b64,
  newWrappableDataKey,
  parseWrapRecord,
  unwrapDataKey,
  wrapDataKey,
  type PasskeyWrapRecord,
} from "./passkeyWrap";

export const NOTES_KEY = "gloam.shield.notes.v1";
/** Public parts of the passkey wrap (the PRF output never touches disk). */
export const PASSKEY_KEY = "gloam.vault.passkey.v1";
/** A notes blob that could not be opened is copied here before it is replaced. */
const UNREADABLE_KEY = "gloam.shield.notes.unreadable.v1";
/** Locked data set aside by "start over" (lost passkey). Kept, never deleted. */
const ARCHIVE_PREFIX = "gloam.vault.archive.";
const ENC_PREFIX = "gloamenc1:";
/** Ids of notes removed on this browser, so a merge from another tab does not bring them back. */
const REMOVED_KEY = "gloam.shield.notes.removed.v1";
const REMOVED_KEEP = 1000;
/** The Web Lock every tab takes around a notes write. */
const WRITE_LOCK = "gloam-notes-write";
/** The Web Lock around making this browser's data key. */
const KEY_LOCK = "gloam-notes-key";
const DB_NAME = "gloam-vault";
const STORE = "keys";
const KEY_ID = "note-aes-256";

let cache: LocalNote[] = [];
let unlockPromise: Promise<void> | null = null;
let keyPromise: Promise<CryptoKey> | null = null;
/** Passkey mode: resolves keyPromise once the passkey unwraps the data key. */
let releaseKey: ((key: CryptoKey) => void) | null = null;
/** The data key once known in this tab (always set in device mode after load). */
let liveKey: CryptoKey | null = null;
/** Writes run in order, one at a time. */
let writeChain: Promise<void> = Promise.resolve();
let pendingWrites = 0;

const listeners = new Set<() => void>();
function emit() {
  for (const fn of listeners) fn();
}

/** Run after the notes are written to disk (never in the demo). */
const savedListeners = new Set<() => void>();

/** Subscribe to note saves. Recovery uses it to keep the encrypted backup current. */
export function onNotesSaved(fn: () => void): () => void {
  savedListeners.add(fn);
  return () => {
    savedListeners.delete(fn);
  };
}

function unb64(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function parseNotes(json: string): LocalNote[] {
  try {
    const a = JSON.parse(json);
    return Array.isArray(a) ? (a as LocalNote[]) : [];
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------ IndexedDB */

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
  });
}
async function idbGet(id: string): Promise<CryptoKey | undefined> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, "readonly").objectStore(STORE).get(id);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result as CryptoKey | undefined);
  });
}
async function idbPut(id: string, key: CryptoKey): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(key, id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
async function idbDelete(id: string): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/* ------------------------------------------------------------ keys */

function passkeyOn(): boolean {
  try {
    return localStorage.getItem(PASSKEY_KEY) !== null;
  } catch {
    return false;
  }
}

/** The stored passkey record, or null (not protected, or damaged). */
export function readPasskeyRecord(): PasskeyWrapRecord | null {
  if (typeof window === "undefined") return null;
  return parseWrapRecord(localStorage.getItem(PASSKEY_KEY));
}

/** Get-or-create the non-extractable device key in IndexedDB. */
async function loadDeviceKey(): Promise<CryptoKey> {
  const existing = await idbGet(KEY_ID);
  if (existing) return existing;
  // Under a lock across tabs: two tabs on a first load must not each make a key,
  // since what the loser saved with it would never open again.
  const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
  const create = async () => {
    const made = await idbGet(KEY_ID);
    if (made) return made;
    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
      "encrypt",
      "decrypt",
    ]);
    await idbPut(KEY_ID, key);
    return key;
  };
  return locks?.request ? locks.request(KEY_LOCK, create) : create();
}

function lockedKeyPromise(): Promise<CryptoKey> {
  return new Promise<CryptoKey>((resolve) => {
    releaseKey = resolve;
  });
}

function getKey(): Promise<CryptoKey> {
  if (keyPromise) return keyPromise;
  // Passkey mode never creates a device key: it waits for the unlock.
  keyPromise = passkeyOn()
    ? lockedKeyPromise()
    : loadDeviceKey().then((k) => {
        if (!passkeyOn()) liveKey = k;
        return k;
      });
  return keyPromise;
}

/** Hand the unwrapped key to everything waiting on the unlock. */
function setLiveKey(key: CryptoKey) {
  liveKey = key;
  const release = releaseKey;
  releaseKey = null;
  keyPromise = Promise.resolve(key);
  release?.(key);
}

async function encryptWith(key: CryptoKey, plain: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plain))
  );
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv, 0);
  out.set(ct, iv.length);
  return ENC_PREFIX + b64(out);
}
async function decryptWith(key: CryptoKey, blob: string): Promise<string> {
  const raw = unb64(blob.slice(ENC_PREFIX.length));
  const iv = raw.slice(0, 12);
  const ct = raw.slice(12);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  return new TextDecoder().decode(pt);
}

async function encrypt(plain: string): Promise<string> {
  return encryptWith(await getKey(), plain);
}
async function decrypt(blob: string): Promise<string> {
  const key = await getKey();
  try {
    return await decryptWith(key, blob);
  } catch (e) {
    // A switch to a passkey that was interrupted can leave values under the
    // old device key until the next unlock finishes the move.
    if (passkeyOn()) {
      const old = await idbGet(KEY_ID).catch(() => undefined);
      if (old) return decryptWith(old, blob);
    }
    throw e;
  }
}

/* ------------------------------------------------------------ writes */

/** A notes write the browser refused or did not keep. Nothing that depends on it should be sent. */
export class NoteSaveError extends Error {
  constructor(cause?: unknown) {
    super(
      "This browser couldn't save your private balance, so nothing was sent. Free up some space or leave private browsing, then try again. A backup in Settings keeps a copy safe."
    );
    this.name = "NoteSaveError";
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}

/**
 * What this tab changed and has not written yet: removed ids, ids it added
 * (they win over an old removal), and every note it added or changed, by the
 * copy it changed it to. Only those win over what is on disk: a note this tab
 * merely holds never overwrites another tab's newer copy (spent, say).
 */
const pendingRemoved = new Set<string>();
const pendingAdded = new Set<string>();
const pendingChanged = new Map<string, LocalNote>();

function readRemoved(): Map<string, number> {
  try {
    const raw = JSON.parse(localStorage.getItem(REMOVED_KEY) ?? "[]");
    const out = new Map<string, number>();
    if (Array.isArray(raw)) for (const r of raw) if (r && typeof r.id === "string") out.set(r.id, Number(r.at) || 0);
    return out;
  } catch {
    return new Map();
  }
}

/** Runs `fn` while no other tab is writing notes. Without Web Locks, `fn` re-checks the blob itself. */
function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const locks = (globalThis.navigator as { locks?: { request: (n: string, f: () => Promise<T>) => Promise<T> } } | undefined)
    ?.locks;
  return locks?.request ? locks.request(WRITE_LOCK, fn) : fn();
}

/** What is on disk now, or null when it cannot be read (then this tab's copy is written as before). */
async function readDiskNotes(raw: string | null): Promise<LocalNote[] | null> {
  if (!raw) return [];
  if (!raw.startsWith(ENC_PREFIX)) return parseNotes(raw);
  try {
    return parseNotes(await decrypt(raw));
  } catch {
    return null;
  }
}

/**
 * Merge this tab's notes into what is on disk and write the result, under the
 * cross-tab lock. Resolves only once the blob is stored and reads back the same.
 */
async function writeBlob(): Promise<void> {
  await withWriteLock(async () => {
    for (let attempt = 0; ; attempt++) {
      // a snapshot: notes saved in this tab while this write runs go in the next one
      const mine = cache;
      const gone = new Set(pendingRemoved);
      const back = new Set(pendingAdded);
      const changed = new Map(pendingChanged);
      const raw = localStorage.getItem(NOTES_KEY);
      const disk = await readDiskNotes(raw);
      const removed = readRemoved();
      for (const id of gone) removed.set(id, Date.now());
      for (const id of back) removed.delete(id);
      let merged: LocalNote[];
      if (disk) {
        const byId = new Map<string, LocalNote>();
        for (const n of disk) if (!removed.has(n.id)) byId.set(n.id, n);
        // this tab's copy wins for the notes it changed, and is kept for any the disk lacks
        for (const n of mine) if (!removed.has(n.id) && (changed.has(n.id) || !byId.has(n.id))) byId.set(n.id, n);
        merged = [...byId.values()];
      } else {
        merged = mine;
      }
      const enc = await encrypt(JSON.stringify(merged));
      // Without a lock, another tab may have written while this one encrypted: merge again.
      if (localStorage.getItem(NOTES_KEY) !== raw && attempt < 5) continue;
      const removedList = [...removed.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, REMOVED_KEEP)
        .map(([id, at]) => ({ id, at }));
      try {
        localStorage.setItem(NOTES_KEY, enc);
        localStorage.setItem(REMOVED_KEY, JSON.stringify(removedList));
      } catch (e) {
        throw new NoteSaveError(e);
      }
      if (localStorage.getItem(NOTES_KEY) !== enc) throw new NoteSaveError();
      for (const id of gone) pendingRemoved.delete(id);
      for (const id of back) pendingAdded.delete(id);
      for (const [id, n] of changed) if (pendingChanged.get(id) === n) pendingChanged.delete(id);
      // Pick up what other tabs saved or removed, keeping everything this tab changed since.
      cache = foldIn(merged, removed);
      return;
    }
  });
}

/**
 * Take what is on disk into the cache without losing anything this tab has
 * not written yet. A note goes only when another tab removed it on purpose
 * (its id is in `removed`), never because a copy on disk lacks it.
 */
function foldIn(disk: LocalNote[], removed: Map<string, number>): LocalNote[] {
  const onDisk = new Map(disk.map((n) => [n.id, n]));
  const next: LocalNote[] = [];
  for (const n of cache) {
    if (pendingChanged.has(n.id)) next.push(n);
    else if (onDisk.has(n.id)) next.push(onDisk.get(n.id)!);
    else if (!removed.has(n.id)) next.push(n);
  }
  const have = new Set(next.map((n) => n.id));
  for (const n of disk) if (!have.has(n.id) && !pendingRemoved.has(n.id)) next.push(n);
  return next.length === cache.length && next.every((n, i) => n === cache[i]) ? cache : next;
}

/** Queue work behind every earlier write (and behind the unlock). */
function enqueue(task: () => Promise<void>): Promise<void> {
  pendingWrites++;
  const run = writeChain.then(task).finally(() => {
    pendingWrites--;
  });
  writeChain = run.catch(() => undefined);
  return run;
}

/** Wait for every queued write to land. */
function flushWrites(): Promise<void> {
  return writeChain;
}

// Synchronous bootstrap: a legacy plaintext blob is loaded now so reads work
// before the async unlock; an encrypted blob waits for unlock to decrypt.
function initSync() {
  if (typeof window === "undefined") return;
  const raw = localStorage.getItem(NOTES_KEY);
  if (raw && !raw.startsWith(ENC_PREFIX)) cache = parseNotes(raw);

  // A note written while the vault is locked waits for the passkey. Warn
  // before the page closes so it is never silently dropped.
  window.addEventListener("beforeunload", (e) => {
    if (pendingWrites > 0) e.preventDefault();
  });
  // Another tab turned the passkey on or off: follow it.
  window.addEventListener("storage", (e) => {
    if (e.key === PASSKEY_KEY) onModeChangedElsewhere();
  });
}
initSync();

function onModeChangedElsewhere() {
  if (passkeyOn()) {
    // Now protected: lock this tab too. The cache stays (nothing is lost);
    // writes wait for the unlock, which re-merges what is on disk.
    if (!releaseKey) {
      liveKey = null;
      keyPromise = lockedKeyPromise();
      unlockPromise = null;
    }
  } else {
    // Protection removed: the device key is back in IndexedDB.
    const waiting = releaseKey;
    releaseKey = null;
    keyPromise = null;
    if (waiting) void getKey().then(waiting);
  }
  emit();
}

/* ------------------------------------------------------------ notes API */

/** Ensure the encrypted store is decrypted (or legacy plaintext migrated) into the cache. */
export function unlockNoteVault(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  return (unlockPromise ??= (async () => {
    // Read the blob only once the key is ready (a passkey vault waits here).
    if (localStorage.getItem(NOTES_KEY)?.startsWith(ENC_PREFIX)) await getKey();
    const raw = localStorage.getItem(NOTES_KEY);
    if (raw && raw.startsWith(ENC_PREFIX)) {
      try {
        const disk = parseNotes(await decrypt(raw));
        // Merge disk into cache; any pre-unlock write (already in cache) wins by id.
        const byId = new Map<string, LocalNote>();
        for (const n of disk) byId.set(n.id, n);
        for (const n of cache) byId.set(n.id, n);
        cache = [...byId.values()];
      } catch {
        // Wrong key or corrupt blob: keep the cache, and keep a copy of the
        // ciphertext aside so a later write can never destroy it.
        if (!localStorage.getItem(UNREADABLE_KEY)) localStorage.setItem(UNREADABLE_KEY, raw);
      }
    } else if (raw) {
      // Legacy plaintext already in cache from initSync: re-persist encrypted.
      await writeBlob();
    } else {
      await getKey();
    }
  })());
}

/** Re-read the encrypted blob from disk into the cache (cross-tab updates). */
export async function syncFromDisk(): Promise<void> {
  if (typeof window === "undefined") return;
  if (localStorage.getItem(NOTES_KEY)?.startsWith(ENC_PREFIX)) await getKey();
  const raw = localStorage.getItem(NOTES_KEY);
  if (raw && raw.startsWith(ENC_PREFIX)) {
    try {
      cache = foldIn(parseNotes(await decrypt(raw)), readRemoved());
    } catch {
      /* ignore */
    }
  } else if (raw) {
    cache = foldIn(parseNotes(raw), readRemoved());
  }
}

/**
 * Whether the notes on disk open with this browser's key. False (wrong key,
 * damaged) means the cache is not what this browser holds, so nothing built
 * from it may stand in for them.
 */
export async function storedNotesOpen(): Promise<boolean> {
  if (typeof window === "undefined") return true;
  const raw = localStorage.getItem(NOTES_KEY);
  if (!raw?.startsWith(ENC_PREFIX)) return true;
  try {
    await decrypt(raw);
    return true;
  } catch {
    return false;
  }
}

/** All notes in the in-memory cache (unfiltered). */
export function getAllNotes(): LocalNote[] {
  // Recording demo: the pretend wallet's notes, never this browser's own.
  if (readDemo()) return demoNotes();
  return cache;
}

/**
 * Replace the cache and persist it encrypted (after ensuring unlock). The
 * returned promise settles once the notes are on disk: await it before sending
 * anything whose secret is in `next`. It rejects with NoteSaveError when the
 * browser refuses the write; callers that don't await it lose nothing new (the
 * failure stays caught here).
 */
export function setAllNotes(next: LocalNote[]): Promise<void> {
  if (readDemo()) {
    setDemoNotes(next);
    return Promise.resolve();
  }
  const before = new Map(cache.map((n) => [n.id, n]));
  const after = new Set(next.map((n) => n.id));
  for (const id of before.keys()) if (!after.has(id)) {
    pendingRemoved.add(id);
    pendingAdded.delete(id);
    pendingChanged.delete(id);
  }
  for (const n of next) {
    const was = before.get(n.id);
    if (!was) {
      pendingAdded.add(n.id);
      pendingRemoved.delete(n.id);
    }
    if (was !== n) pendingChanged.set(n.id, n);
  }
  cache = next;
  if (typeof window === "undefined") return Promise.resolve();
  const saved = enqueue(async () => {
    await unlockNoteVault();
    await writeBlob();
    for (const fn of savedListeners) fn();
  });
  saved.catch(() => undefined);
  return saved;
}

/**
 * Encrypt any JSON value under the same data key as the notes
 * (for other secret-bearing local state, e.g. payroll claim links).
 */
export async function sealJson(value: unknown): Promise<string> {
  return encrypt(JSON.stringify(value));
}

/** A value sealJson wrote (as opposed to plain JSON from before encryption at rest). */
export function isSealedValue(value: string | null): boolean {
  return Boolean(value?.startsWith(ENC_PREFIX));
}

/** Resolves once the data key is usable (after the passkey unlock, if one guards it). */
export async function vaultKeyReady(): Promise<void> {
  await getKey();
}

/** A passkey guards the data key and this tab has not unlocked it yet (demo or not). */
export function dataKeyLocked(): boolean {
  return typeof window !== "undefined" && passkeyOn() && !liveKey;
}

/**
 * Like openJson, but throws when the value does not open (wrong key, damaged)
 * instead of returning null, so a caller can tell that from a missing value.
 * Waits for the unlock.
 */
export async function openJsonStrict<T>(blob: string): Promise<T> {
  if (!isSealedValue(blob)) throw new Error("Not a sealed value.");
  return JSON.parse(await decrypt(blob)) as T;
}

/** Decrypt a value sealed with sealJson. Returns null if it cannot be opened. */
export async function openJson<T>(blob: string | null): Promise<T | null> {
  if (!blob || !blob.startsWith(ENC_PREFIX)) return null;
  // Recording demo never waits on (or reads) a locked vault.
  if (readDemo() && passkeyOn() && !liveKey) return null;
  try {
    return JSON.parse(await decrypt(blob)) as T;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------ passkey lock */

export type VaultStatus = {
  /** A passkey guards the data key on this browser. */
  protected: boolean;
  /** Protected and not yet unlocked in this tab. */
  locked: boolean;
};

const OPEN: VaultStatus = { protected: false, locked: false };
const PROTECTED_OPEN: VaultStatus = { protected: true, locked: false };
const PROTECTED_LOCKED: VaultStatus = { protected: true, locked: true };

/** Current lock state. The recording demo is never protected or locked. */
export function vaultStatus(): VaultStatus {
  if (typeof window === "undefined" || readDemo()) return OPEN;
  if (!passkeyOn()) return OPEN;
  return liveKey ? PROTECTED_OPEN : PROTECTED_LOCKED;
}

export function subscribeVault(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Every key in localStorage holding a sealed value. */
function sealedEntries(): [string, string][] {
  const out: [string, string][] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k || k.startsWith(ARCHIVE_PREFIX) || k === UNREADABLE_KEY) continue;
    const v = localStorage.getItem(k);
    if (v && v.startsWith(ENC_PREFIX)) out.push([k, v]);
  }
  return out;
}

/**
 * Re-encrypt values that open under `from` so they open under `to`. Values
 * that already open under `to`, or open under neither, are left as they are.
 */
async function reseal(from: CryptoKey, to: CryptoKey): Promise<[string, string][]> {
  const out: [string, string][] = [];
  for (const [k, v] of sealedEntries()) {
    let plain: string;
    try {
      plain = await decryptWith(from, v);
    } catch {
      continue;
    }
    out.push([k, await encryptWith(to, plain)]);
  }
  return out;
}

/**
 * Turn passkey protection on. The current device key cannot be wrapped (it was
 * created non-extractable), so every sealed value moves to a fresh data key:
 * wrap it, prove the passkey output reopens it, re-encrypt, then commit the
 * record and the new values in one synchronous pass, and only then forget the
 * device key. If anything fails before the commit, nothing on disk changed.
 */
export function protectVaultWithPrf(p: {
  credentialId: string;
  rpId: string;
  prfSalt: Uint8Array;
  prfOutput: Uint8Array;
}): Promise<void> {
  return enqueue(async () => {
    if (passkeyOn()) throw new Error("A passkey already protects this vault.");
    await unlockNoteVault();
    const oldKey = await getKey();
    const dataKey = await newWrappableDataKey();
    const record: PasskeyWrapRecord = {
      v: 1,
      credentialId: p.credentialId,
      rpId: p.rpId,
      prfSalt: b64(p.prfSalt),
      ...(await wrapDataKey(dataKey, p.prfOutput, p.credentialId)),
      createdAt: Date.now(),
    };
    // Round trip first: the passkey output must reopen the key it just wrapped.
    const memKey = await unwrapDataKey(record, p.prfOutput);
    const rewrites = await reseal(oldKey, memKey);
    for (const [, v] of rewrites) await decryptWith(memKey, v);

    // Commit.
    localStorage.setItem(PASSKEY_KEY, JSON.stringify(record));
    for (const [k, v] of rewrites) localStorage.setItem(k, v);
    setLiveKey(memKey);
    emit();

    // Anything another tab sealed with the old key meanwhile moves too.
    await new Promise((r) => setTimeout(r, 800));
    for (const [k, v] of await reseal(oldKey, memKey)) localStorage.setItem(k, v);
    await idbDelete(KEY_ID);
  });
}

/**
 * Unlock with the passkey's PRF output. Throws if it does not unwrap the key
 * (wrong passkey, damaged record); nothing changes in that case.
 */
export async function unlockVaultWithPrf(prfOutput: Uint8Array): Promise<void> {
  const record = readPasskeyRecord();
  if (!record) throw new Error("This browser's passkey record is damaged.");
  const key = await unwrapDataKey(record, prfOutput);
  if (!liveKey) setLiveKey(key);
  // Finish a switch that was interrupted: move values still under the old
  // device key, then forget it.
  const old = await idbGet(KEY_ID).catch(() => undefined);
  if (old) {
    for (const [k, v] of await reseal(old, key)) localStorage.setItem(k, v);
    await idbDelete(KEY_ID);
  }
  await unlockNoteVault();
  emit();
}

/** Check a passkey output against the stored record without changing anything. */
export async function checkVaultPrf(prfOutput: Uint8Array): Promise<boolean> {
  const record = readPasskeyRecord();
  if (!record) return false;
  try {
    await unwrapDataKey(record, prfOutput);
    return true;
  } catch {
    return false;
  }
}

/**
 * Turn passkey protection off: the same data key goes back into IndexedDB as
 * the device key (non-extractable, as before), then the record is removed. No
 * value is re-encrypted. Requires the passkey output, not just an open tab.
 */
export function removeVaultPasskey(prfOutput: Uint8Array): Promise<void> {
  return enqueue(async () => {
    const record = readPasskeyRecord();
    if (!record) return;
    const key = await unwrapDataKey(record, prfOutput);
    await idbPut(KEY_ID, key);
    localStorage.removeItem(PASSKEY_KEY);
    setLiveKey(key);
    emit();
  });
}

/** Lock now: let queued writes land, then reload so nothing stays in memory. */
export async function lockVault(): Promise<void> {
  await flushWrites();
  window.location.reload();
}

/**
 * Lost passkey: set the locked data aside (moved, not deleted) and start this
 * browser over on a fresh device key, ready for a backup restore.
 */
export async function startOverWithoutPasskey(): Promise<void> {
  if (!passkeyOn()) return;
  const archive = {
    v: 1,
    archivedAt: Date.now(),
    passkey: localStorage.getItem(PASSKEY_KEY),
    values: Object.fromEntries(sealedEntries()),
  };
  localStorage.setItem(`${ARCHIVE_PREFIX}${archive.archivedAt}`, JSON.stringify(archive));
  for (const k of Object.keys(archive.values)) localStorage.removeItem(k);
  localStorage.removeItem(PASSKEY_KEY);
  // Values from a half-finished switch are in the archive; the old device key
  // can still open them, so it stays in IndexedDB under its own name.
  const old = await idbGet(KEY_ID).catch(() => undefined);
  if (old) {
    await idbPut(`${KEY_ID}.archived.${archive.archivedAt}`, old);
    await idbDelete(KEY_ID);
  }
  cache = [];
  unlockPromise = null;
  keyPromise = null;
  liveKey = null;
  const waiting = releaseKey;
  releaseKey = null;
  const key = await getKey();
  waiting?.(key);
  emit();
}
