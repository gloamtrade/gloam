/**
 * Where Solana payroll runs live in this browser (the runs themselves in
 * lib/solanaRings/payroll), one list per private account and network.
 *
 * A run names who is paid and how much, so it is sealed: AES-256-GCM under a
 * key of its own (runCipher), HKDF from the private account's viewing secret
 * with a payroll domain, so it is never the balance snapshot's key, and bound
 * to the account's address. Only the account that wrote a run can open it.
 * Runs stay in this browser: they are not in any backup.
 *
 * As lib/payrollStore does for the other chains: writes take turns across tabs
 * (Web Locks), a write resolves only once the sealed list reads back from
 * storage (so a batch is never sent on progress that wasn't saved), a list
 * this account can't open is set aside rather than written over, and finished
 * runs make room for new ones while a run that is still open is never dropped.
 * One tab pays a run at a time (withRunLock).
 */
import { isRun, runOpen, type PayrollRun } from "./payroll";
import type { RingsNetwork } from "./config";

export type RunCipher = { seal(plain: string): Promise<string>; open(sealed: string): Promise<string> };
export type RunStorage = Pick<Storage, "getItem" | "setItem">;

const DOMAIN = "gloam/solana-payroll/v1\n";
/** Finished runs kept besides the open ones. */
const KEEP_FINISHED = 10;

export function payrollStoreKey(network: RingsNetwork, owner: string): string {
  return `gloam:solana-payroll:v1:${network}:${owner}`;
}

const SEALED_PREFIX = "gsp1.";
const enc = new TextEncoder();
const buf = (b: Uint8Array): ArrayBuffer => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
function b64(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/**
 * The cipher a private account's runs are sealed with: AES-256-GCM, its key
 * HKDF-SHA256 over the account's 32-byte viewing secret (salt
 * "gloam/solana-payroll/v1", info the account's address), each seal under a
 * fresh nonce and bound to the address. The caller wipes `secret` after.
 */
export async function runCipher(secret: Uint8Array, owner: string): Promise<RunCipher> {
  if (secret.length !== 32) throw new Error("A viewing secret is 32 bytes.");
  const subtle = globalThis.crypto.subtle;
  const ikm = await subtle.importKey("raw", buf(secret), "HKDF", false, ["deriveKey"]);
  const key = await subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: buf(enc.encode(DOMAIN.trim())), info: buf(enc.encode(owner)) },
    ikm,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
  const aad = buf(enc.encode(`${DOMAIN}${owner}`));
  return {
    async seal(plain) {
      const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
      const data = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv: buf(iv), additionalData: aad }, key, buf(enc.encode(plain))));
      return `${SEALED_PREFIX}${b64(iv)}.${b64(data)}`;
    },
    async open(sealed) {
      if (!sealed.startsWith(SEALED_PREFIX)) throw new Error("not a sealed run list");
      const [iv, data] = sealed.slice(SEALED_PREFIX.length).split(".");
      if (!iv || !data) throw new Error("not a sealed run list");
      const plain = await subtle.decrypt({ name: "AES-GCM", iv: buf(unb64(iv)), additionalData: aad }, key, buf(unb64(data)));
      return new TextDecoder().decode(plain);
    },
  };
}

type Locks = { request<T>(name: string, fn: () => Promise<T>): Promise<T> };

function locks(): Locks | null {
  const l = (globalThis.navigator as { locks?: Locks } | undefined)?.locks;
  return l?.request ? l : null;
}

export function payrollStore(opts: { key: string; cipher: RunCipher; storage?: RunStorage }) {
  const storage = opts.storage ?? globalThis.localStorage;
  const unreadableKey = `${opts.key}:unreadable`;

  async function read(raw: string | null): Promise<PayrollRun[]> {
    if (!raw) return [];
    try {
      const plain = await opts.cipher.open(raw);
      if (!plain.startsWith(DOMAIN)) throw new Error("not a payroll list");
      const all = JSON.parse(plain.slice(DOMAIN.length)) as unknown;
      if (!Array.isArray(all)) throw new Error("not a payroll list");
      return all.filter(isRun);
    } catch {
      // Damaged, or sealed by something else: keep it aside before anything writes over it.
      if (!storage.getItem(unreadableKey)) storage.setItem(unreadableKey, raw);
      return [];
    }
  }

  const sorted = (all: PayrollRun[]) => [...all].sort((a, b) => b.createdAt - a.createdAt);

  /** The runs, newest first. */
  async function load(): Promise<PayrollRun[]> {
    return sorted(await read(storage.getItem(opts.key)));
  }

  async function write(change: (all: PayrollRun[]) => PayrollRun[]): Promise<void> {
    const task = async () => {
      const next = sorted(change(await read(storage.getItem(opts.key))));
      let finished = 0;
      const kept = next.filter((r) => runOpen(r) || ++finished <= KEEP_FINISHED);
      const sealed = await opts.cipher.seal(DOMAIN + JSON.stringify(kept));
      storage.setItem(opts.key, sealed); // throws when storage is full or off
      if (storage.getItem(opts.key) !== sealed) throw new Error("The run didn't save in this browser.");
    };
    const l = locks();
    await (l ? l.request(`gloam-solana-payroll-store:${opts.key}`, task) : task());
  }

  /** Store `run` (replacing the one with its id). Resolves once it reads back. */
  function save(run: PayrollRun): Promise<void> {
    const copy = JSON.parse(JSON.stringify(run)) as PayrollRun;
    return write((all) => [copy, ...all.filter((r) => r.id !== copy.id)]);
  }

  return { load, save };
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
  return l.request(`gloam-solana-payroll-run:${owner}`, { ifAvailable: true }, async (lock) => {
    if (!lock) return false;
    await fn();
    return true;
  });
}
