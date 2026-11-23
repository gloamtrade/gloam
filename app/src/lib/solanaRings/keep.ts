/**
 * Staying signed in to Gloam on Solana on this device, the way the EVM app
 * keeps its private balance open (lib/noteVault: note secrets sealed at rest
 * under a non-extractable AES-GCM key that lives in IndexedDB).
 *
 *  - The main wallet: its name and address in localStorage (WALLET_KEY), public
 *    facts, so the app reconnects it on load without a prompt (Wallet Standard
 *    connect with `silent`) until the person signs out.
 *  - The private account: the 32-byte seed of the one account that is open
 *    (lib/solanaRings/account accountSeed), never the wallet's signature (which
 *    would open every account index), sealed with AES-GCM under a
 *    non-extractable key made for it. Both sit in IndexedDB; nothing secret
 *    touches localStorage. The record is bound to its network, main wallet and
 *    account index (they are the cipher's additional data, so a record moved to
 *    another wallet fails to open), and it ends KEEP_DAYS after the signature
 *    that made it. Signing out, disconnecting or switching wallets removes the
 *    record and the key that sealed it.
 *
 * Like the EVM device key, this keeps the account from a storage dump or a
 * backup (the key can't be exported, so the ciphertext opens only inside this
 * origin in this browser). It does not keep it from code running on the page
 * itself, which could open it while it lasts, the same as the open account in
 * memory. That is the trade for not asking for a signature on every visit.
 */
import type { RingsNetwork } from "./config";

/** localStorage: the main wallet to reconnect, { name, address }. */
export const WALLET_KEY = "gloam:solana-wallet:v1";

/** How long a signature keeps the private account open on this device. */
export const KEEP_DAYS = 7;
const KEEP_MS = KEEP_DAYS * 24 * 60 * 60 * 1000;

const DB_NAME = "gloam-solana-keep";
const STORE = "keep";
const WRAP_ID = "wrap";
const ACCOUNT_ID = "account";

/** What keeps the sealed account: IndexedDB in the browser, a Map in tests. */
export type KeepDb = {
  get(id: string): Promise<unknown>;
  put(id: string, value: unknown): Promise<void>;
  del(id: string): Promise<void>;
};

type Sealed = { v: 1; network: RingsNetwork; owner: string; index: number; expires: number; iv: Uint8Array; data: ArrayBuffer };

const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

// ---------------------------------------------------------------- the main wallet

/** The main wallet to reconnect on load, or null. */
export function keptWallet(storage: Pick<Storage, "getItem"> | null): { name: string; address: string } | null {
  try {
    const raw = storage?.getItem(WALLET_KEY);
    const v = raw ? (JSON.parse(raw) as { name?: unknown; address?: unknown }) : null;
    if (v && typeof v.name === "string" && v.name && typeof v.address === "string" && SOLANA_ADDRESS.test(v.address)) {
      return { name: v.name, address: v.address };
    }
  } catch {
    /* malformed or blocked: nothing to reconnect */
  }
  return null;
}

export function keepWallet(storage: Pick<Storage, "setItem"> | null, w: { name: string; address: string }): void {
  if (!SOLANA_ADDRESS.test(w.address)) return;
  try {
    storage?.setItem(WALLET_KEY, JSON.stringify({ name: w.name, address: w.address }));
  } catch {
    /* blocked storage: the next visit connects by hand */
  }
}

export function forgetWallet(storage: Partial<Pick<Storage, "removeItem">> | null): void {
  try {
    storage?.removeItem?.(WALLET_KEY);
  } catch {
    /* blocked storage */
  }
}

// ---------------------------------------------------------------- the private account

const scope = (network: RingsNetwork, owner: string, index: number) => new TextEncoder().encode(`gloam/solana-keep/v1:${network}:${owner}:${index}`);
const buf = (b: Uint8Array): ArrayBuffer => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;

/**
 * Keep the open account's seed on this device for KEEP_DAYS: sealed under a
 * fresh non-extractable key, replacing whatever was kept before.
 */
export async function keepAccount(
  db: KeepDb,
  input: { network: RingsNetwork; owner: string; index: number; seed: Uint8Array; now?: number }
): Promise<void> {
  if (input.seed.length !== 32 || !SOLANA_ADDRESS.test(input.owner)) throw new Error("Nothing to keep.");
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: buf(iv), additionalData: buf(scope(input.network, input.owner, input.index)) },
    key,
    buf(input.seed)
  );
  const sealed: Sealed = {
    v: 1,
    network: input.network,
    owner: input.owner,
    index: input.index,
    expires: (input.now ?? Date.now()) + KEEP_MS,
    iv,
    data,
  };
  // The old record goes first: a half-written pair never opens (the new key can't open the old data).
  await forgetAccount(db);
  await db.put(WRAP_ID, key);
  await db.put(ACCOUNT_ID, sealed);
}

/**
 * The kept seed of `owner`'s account `index` on `network`, or null: none kept,
 * kept for another wallet, account or network, ended, or unreadable. Anything
 * but a match for this wallet is removed.
 */
export async function keptAccount(
  db: KeepDb,
  input: { network: RingsNetwork; owner: string; index: number; now?: number }
): Promise<Uint8Array | null> {
  let sealed: Sealed | null = null;
  let key: CryptoKey | null = null;
  try {
    sealed = ((await db.get(ACCOUNT_ID)) as Sealed | undefined) ?? null;
    key = ((await db.get(WRAP_ID)) as CryptoKey | undefined) ?? null;
  } catch {
    return null;
  }
  if (!sealed) return null;
  const now = input.now ?? Date.now();
  const mine = sealed.v === 1 && sealed.network === input.network && sealed.owner === input.owner && sealed.index === input.index;
  if (!mine || !key || !(sealed.expires > now) || sealed.expires > now + KEEP_MS) {
    await forgetAccount(db).catch(() => {});
    return null;
  }
  try {
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: buf(new Uint8Array(sealed.iv)), additionalData: buf(scope(sealed.network, sealed.owner, sealed.index)) },
      key,
      sealed.data
    );
    const seed = new Uint8Array(plain);
    if (seed.length === 32) return seed;
    seed.fill(0);
  } catch {
    /* tampered or from another key */
  }
  await forgetAccount(db).catch(() => {});
  return null;
}

/** Remove the kept account and the key that sealed it. */
export async function forgetAccount(db: KeepDb): Promise<void> {
  await db.del(ACCOUNT_ID);
  await db.del(WRAP_ID);
}

// ---------------------------------------------------------------- IndexedDB

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
  });
}

function request<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const req = fn(tx.objectStore(STORE));
        let out: T;
        req.onsuccess = () => void (out = req.result as T);
        tx.oncomplete = () => {
          db.close();
          resolve(out);
        };
        tx.onerror = () => {
          db.close();
          reject(tx.error);
        };
        tx.onabort = () => {
          db.close();
          reject(tx.error);
        };
      })
  );
}

/** The browser's IndexedDB as a KeepDb, or null where there is none (the server, some private modes). */
export function browserKeepDb(): KeepDb | null {
  if (typeof indexedDB === "undefined") return null;
  return {
    get: (id) => request<unknown>("readonly", (s) => s.get(id)),
    put: (id, value) => request<void>("readwrite", (s) => s.put(value, id)).then(() => {}),
    del: (id) => request<void>("readwrite", (s) => s.delete(id)).then(() => {}),
  };
}
