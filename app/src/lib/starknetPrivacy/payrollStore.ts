/**
 * Where Starknet payroll runs live in this browser (the runs themselves in
 * lib/starknetPrivacy/payroll), one list per private account and network.
 *
 * A run names who is paid and how much, so it is sealed: AES-256-GCM under a
 * key of its own, HKDF-SHA256 from the account's viewing key with a payroll
 * domain, bound to the account's address. Only the account that wrote a run
 * can open it, and the key never leaves the page's session. Runs stay in this
 * browser: they are not in any backup.
 *
 * As the other chains' stores do (lib/payrollStore, lib/solanaRings/payrollStore):
 * writes take turns across tabs (Web Locks), a write resolves only once the
 * sealed list reads back (so a proof is never sent on progress that wasn't
 * saved), a list this account can't open is set aside rather than written
 * over, and finished runs make room for new ones while an open run is never
 * dropped. One tab pays a run at a time (withRunLock).
 */
import { isRun, runOpen, type PayrollRun } from "./payroll";
import type { StarknetNetwork } from "./config";

export type RunCipher = { seal(plain: string): Promise<string>; open(sealed: string): Promise<string> };
export type RunStorage = Pick<Storage, "getItem" | "setItem">;

const DOMAIN = "gloam/starknet-payroll/v1\n";
/** Finished runs kept besides the open ones. */
const KEEP_FINISHED = 10;
const SEALED_PREFIX = "gsnp1.";

export function payrollStoreKey(network: StarknetNetwork, owner: string): string {
  return `gloam:starknet-payroll:v1:${network}:${BigInt(owner).toString(16)}`;
}

const enc = new TextEncoder();
const buf = (b: Uint8Array): ArrayBuffer => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
function b64(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** A viewing key (a scalar below the curve order) as 32 bytes, big-endian. */
export function viewingKeyBytes(k: bigint): Uint8Array {
  if (k <= 0n || k >= 1n << 256n) throw new Error("Invalid viewing key.");
  const hex = k.toString(16).padStart(64, "0");
  return Uint8Array.from(hex.match(/../g)!, (x) => parseInt(x, 16));
}

/**
 * The cipher an account's runs are sealed with: AES-256-GCM, its key
 * HKDF-SHA256 over the account's viewing key (salt `domain`, info the
 * account's address), each seal under a fresh nonce and bound to the address.
 * Another `domain` (Starknet's sent links) gets a key of its own.
 */
export async function runCipher(viewingKey: bigint, owner: string, domain = DOMAIN): Promise<RunCipher> {
  const subtle = globalThis.crypto.subtle;
  const secret = viewingKeyBytes(viewingKey);
  const who = `0x${BigInt(owner).toString(16)}`;
  try {
    const ikm = await subtle.importKey("raw", buf(secret), "HKDF", false, ["deriveKey"]);
    const key = await subtle.deriveKey(
      { name: "HKDF", hash: "SHA-256", salt: buf(enc.encode(domain.trim())), info: buf(enc.encode(who)) },
      ikm,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"]
    );
    const aad = buf(enc.encode(`${domain}${who}`));
    return {
      async seal(plain) {
        const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
        const data = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv: buf(iv), additionalData: aad }, key, buf(enc.encode(plain))));
        return `${SEALED_PREFIX}${b64(iv)}.${b64(data)}`;
      },
      async open(sealed) {
        if (!sealed.startsWith(SEALED_PREFIX)) throw new Error("not a sealed list");
        const [iv, data] = sealed.slice(SEALED_PREFIX.length).split(".");
        if (!iv || !data) throw new Error("not a sealed list");
        const plain = await subtle.decrypt({ name: "AES-GCM", iv: buf(unb64(iv)), additionalData: aad }, key, buf(unb64(data)));
        return new TextDecoder().decode(plain);
      },
    };
  } finally {
    secret.fill(0);
  }
}

type Locks = { request<T>(name: string, fn: () => Promise<T>): Promise<T> };

function locks(): Locks | null {
  const l = (globalThis.navigator as { locks?: Locks } | undefined)?.locks;
  return l?.request ? l : null;
}

/**
 * A sealed list of records in this browser, newest first, with the rules
 * above: `isItem` checks each one read back, `keep` says which may never be
 * dropped. Payroll runs use it (payrollStore), and so can other lists sealed
 * per account.
 */
export function sealedList<T extends { id: string; createdAt: number }>(opts: {
  key: string;
  cipher: RunCipher;
  domain: string;
  isItem: (v: unknown) => v is T;
  keep: (v: T) => boolean;
  keepOthers?: number;
  storage?: RunStorage;
}) {
  const storage = opts.storage ?? globalThis.localStorage;
  const unreadableKey = `${opts.key}:unreadable`;
  const keepOthers = opts.keepOthers ?? KEEP_FINISHED;

  async function read(raw: string | null): Promise<T[]> {
    if (!raw) return [];
    try {
      const plain = await opts.cipher.open(raw);
      if (!plain.startsWith(opts.domain)) throw new Error("not this list");
      const all = JSON.parse(plain.slice(opts.domain.length)) as unknown;
      if (!Array.isArray(all)) throw new Error("not this list");
      return all.filter(opts.isItem);
    } catch {
      // Damaged, or sealed by something else: keep it aside before anything writes over it.
      if (!storage.getItem(unreadableKey)) storage.setItem(unreadableKey, raw);
      return [];
    }
  }

  const sorted = (all: T[]) => [...all].sort((a, b) => b.createdAt - a.createdAt);

  async function load(): Promise<T[]> {
    return sorted(await read(storage.getItem(opts.key)));
  }

  async function write(change: (all: T[]) => T[]): Promise<void> {
    const task = async () => {
      const next = sorted(change(await read(storage.getItem(opts.key))));
      let others = 0;
      const kept = next.filter((r) => opts.keep(r) || ++others <= keepOthers);
      const sealed = await opts.cipher.seal(opts.domain + JSON.stringify(kept));
      storage.setItem(opts.key, sealed); // throws when storage is full or off
      if (storage.getItem(opts.key) !== sealed) throw new Error("It didn't save in this browser.");
    };
    const l = locks();
    await (l ? l.request(`gloam-starknet-list:${opts.key}`, task) : task());
  }

  /** Store `item` (replacing the one with its id). Resolves once it reads back. */
  function save(item: T): Promise<void> {
    const copy = JSON.parse(JSON.stringify(item)) as T;
    return write((all) => [copy, ...all.filter((r) => r.id !== copy.id)]);
  }

  /** Drop the item with this id. Resolves once the list reads back. */
  function remove(id: string): Promise<void> {
    return write((all) => all.filter((r) => r.id !== id));
  }

  return { load, save, remove };
}

export function payrollStore(opts: { key: string; cipher: RunCipher; storage?: RunStorage }) {
  return sealedList<PayrollRun>({ ...opts, domain: DOMAIN, isItem: isRun, keep: runOpen });
}

export type PayrollStore = ReturnType<typeof payrollStore>;

/**
 * Run `fn` only if no other tab is paying this account's runs: false (and `fn`
 * not run) when one is. Without Web Locks it just runs.
 */
export async function withRunLock(owner: string, fn: () => Promise<void>): Promise<boolean> {
  const l = (globalThis.navigator as { locks?: { request: (n: string, o: { ifAvailable: boolean }, f: (lock: unknown) => Promise<boolean>) => Promise<boolean> } } | undefined)
    ?.locks;
  if (!l?.request) {
    await fn();
    return true;
  }
  return l.request(`gloam-starknet-payroll-run:${BigInt(owner).toString(16)}`, { ifAvailable: true }, async (lock) => {
    if (!lock) return false;
    await fn();
    return true;
  });
}
