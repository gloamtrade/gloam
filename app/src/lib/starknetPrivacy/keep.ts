/**
 * Staying open on Starknet on this device, the way Solana does (lib/solanaRings/keep)
 * and the EVM app keeps its private balance open (lib/noteVault): the 32-byte
 * seed of the one private account that is open (lib/starknetPrivacy/account,
 * never the wallet's signature or the Gloam wallet's root, which would open
 * every account index), sealed with AES-GCM under a non-extractable key made
 * for it, both in IndexedDB. Nothing secret touches localStorage. The record
 * is bound to its network, main wallet and account index (the cipher's
 * additional data, so a record moved to another wallet fails to open), and it
 * ends KEEP_DAYS after the signature (or passkey, or code) that made it.
 * Signing out, disconnecting or switching wallets removes the record and the
 * key that sealed it.
 *
 * It keeps the account from a storage dump or a backup (the key can't be
 * exported, so the ciphertext opens only inside this origin in this browser).
 * It does not keep it from code running on the page itself, which could open
 * it while it lasts, the same as the open account in memory. That is the
 * trade for not asking again on every visit.
 */
import type { StarknetNetwork } from "./config";

/** How long opening keeps the private account open on this device. */
export const KEEP_DAYS = 7;
const KEEP_MS = KEEP_DAYS * 24 * 60 * 60 * 1000;

const DB_NAME = "gloam-starknet-keep";
const STORE = "keep";
const WRAP_ID = "wrap";
const ACCOUNT_ID = "account";

/** What keeps the sealed account: IndexedDB in the browser, a Map in tests. */
export type KeepDb = {
  get(id: string): Promise<unknown>;
  put(id: string, value: unknown): Promise<void>;
  del(id: string): Promise<void>;
};

type Sealed = { v: 1; network: StarknetNetwork; owner: string; index: number; expires: number; iv: Uint8Array; data: ArrayBuffer };

const OWNER = /^0x[0-9a-f]{40}$/;
const scope = (network: StarknetNetwork, owner: string, index: number) => new TextEncoder().encode(`gloam/starknet-keep/v1:${network}:${owner}:${index}`);
const buf = (b: Uint8Array): ArrayBuffer => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;

/** Keep the open account's seed on this device for KEEP_DAYS, replacing whatever was kept before. */
export async function keepStarknetAccount(
  db: KeepDb,
  input: { network: StarknetNetwork; owner: string; index: number; seed: Uint8Array; now?: number }
): Promise<void> {
  const owner = input.owner.toLowerCase();
  if (input.seed.length !== 32 || !OWNER.test(owner)) throw new Error("Nothing to keep.");
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv: buf(iv), additionalData: buf(scope(input.network, owner, input.index)) }, key, buf(input.seed));
  const sealed: Sealed = { v: 1, network: input.network, owner, index: input.index, expires: (input.now ?? Date.now()) + KEEP_MS, iv, data };
  // The old record goes first: a half-written pair never opens (the new key can't open the old data).
  await forgetStarknetAccount(db);
  await db.put(WRAP_ID, key);
  await db.put(ACCOUNT_ID, sealed);
}

/**
 * The kept seed of `owner`'s account `index` on `network`, or null: none kept,
 * kept for another wallet, account or network, ended, or unreadable. Anything
 * but a match for this wallet is removed.
 */
export async function keptStarknetAccount(db: KeepDb, input: { network: StarknetNetwork; owner: string; index: number; now?: number }): Promise<Uint8Array | null> {
  const owner = input.owner.toLowerCase();
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
  const mine = sealed.v === 1 && sealed.network === input.network && sealed.owner === owner && sealed.index === input.index;
  if (!mine || !key || !(sealed.expires > now) || sealed.expires > now + KEEP_MS) {
    await forgetStarknetAccount(db).catch(() => {});
    return null;
  }
  try {
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: buf(new Uint8Array(sealed.iv)), additionalData: buf(scope(sealed.network, sealed.owner, sealed.index)) }, key, sealed.data);
    const seed = new Uint8Array(plain);
    if (seed.length === 32) return seed;
    seed.fill(0);
  } catch {
    /* tampered or from another key */
  }
  await forgetStarknetAccount(db).catch(() => {});
  return null;
}

/** Remove the kept account and the key that sealed it. */
export async function forgetStarknetAccount(db: KeepDb): Promise<void> {
  await db.del(ACCOUNT_ID);
  await db.del(WRAP_ID);
}

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
export function starknetKeepDb(): KeepDb | null {
  if (typeof indexedDB === "undefined") return null;
  return {
    get: (id) => request<unknown>("readonly", (s) => s.get(id)),
    put: (id, value) => request<void>("readwrite", (s) => s.put(value, id)).then(() => {}),
    del: (id) => request<void>("readwrite", (s) => s.delete(id)).then(() => {}),
  };
}
