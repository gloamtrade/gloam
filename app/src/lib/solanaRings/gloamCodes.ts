"use client";

/**
 * Where a Gloam account's backup-code secret is kept (lib/solanaRings/gloamRoot):
 * the way the app keeps its other per-account secrets (sent links, payroll runs).
 *
 * Sealed with sealJson under the private balance's data key (lib/noteVault: a
 * non-extractable AES-GCM key in IndexedDB), in localStorage under the signed-in
 * account's own key (lib/accountSlot), as { [Solana main wallet]: secret }. A
 * secret is never replaced: the person saved that code, and their private
 * account comes from it. A stored list that can't be opened is set aside, never
 * overwritten. The recovery backup (lib/recovery) carries these secrets only
 * when its key is a passkey, never a Gloam wallet's signature, which Turnkey keeps.
 *
 * The plain logic (parseCodes, mergeCodes) is checked by scripts/selftest-turnkey-solana.mts.
 */
import { scopedKey, writableKey } from "../accountSlot";
import { openJson, sealJson } from "../noteVault";
import { CODE_SECRET_BYTES, GloamRootError } from "./gloamRoot";

export const STORE_KEY = "gloam.solana-codes.v1";
const UNREADABLE_KEY = "gloam.solana-codes.unreadable.v1";

/** Fired after a secret is saved here, so a recovery backup takes it in. */
export const SOLANA_CODES_SAVED_EVENT = "gloam:solana-codes-saved";

/** One kept secret, as the backup carries it: the Solana main wallet and the secret in hex. */
export type SolanaCodeEntry = { owner: string; secret: string };

const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SECRET_HEX = new RegExp(`^[0-9a-f]{${CODE_SECRET_BYTES * 2}}$`);

/** The kept secrets in `value`, with anything malformed left out. */
export function parseCodes(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  for (const [owner, secret] of Object.entries(value as Record<string, unknown>)) {
    if (SOLANA_ADDRESS.test(owner) && typeof secret === "string" && SECRET_HEX.test(secret)) out[owner] = secret;
  }
  return out;
}

/** `kept` with `incoming` added where nothing is kept yet: a kept secret is never replaced. */
export function mergeCodes(kept: Record<string, string>, incoming: readonly SolanaCodeEntry[] | undefined): Record<string, string> {
  const out = { ...kept };
  for (const e of incoming ?? []) {
    if (!e || !SOLANA_ADDRESS.test(e.owner) || typeof e.secret !== "string" || !SECRET_HEX.test(e.secret)) continue;
    if (!(e.owner in out)) out[e.owner] = e.secret;
  }
  return out;
}

const toHex = (b: Uint8Array) => Array.from(b, (v) => v.toString(16).padStart(2, "0")).join("");
const fromHex = (h: string) => new Uint8Array(h.match(/../g)!.map((x) => parseInt(x, 16)));

async function readAll(): Promise<Record<string, string>> {
  if (typeof window === "undefined") return {};
  const key = scopedKey(STORE_KEY);
  const raw = key ? window.localStorage.getItem(key) : null;
  if (!raw) return {};
  const value = await openJson<unknown>(raw);
  if (value === null) {
    // Another key or damaged data: keep the ciphertext aside so a write never destroys it.
    const aside = scopedKey(UNREADABLE_KEY);
    if (aside && !window.localStorage.getItem(aside)) window.localStorage.setItem(aside, raw);
    return {};
  }
  return parseCodes(value);
}

let writeQueue: Promise<unknown> = Promise.resolve();
function update<T>(fn: (kept: Record<string, string>) => { next: Record<string, string> | null; out: T }): Promise<T> {
  const run = writeQueue.then(async () => {
    const { next, out } = fn(await readAll());
    if (next) {
      window.localStorage.setItem(writableKey(STORE_KEY), await sealJson(next));
      window.dispatchEvent(new Event(SOLANA_CODES_SAVED_EVENT));
    }
    return out;
  });
  writeQueue = run.catch(() => undefined);
  return run;
}

/** The backup-code secret kept here for `owner`, or null. */
export async function keptCodeSecret(owner: string): Promise<Uint8Array | null> {
  await writeQueue;
  const hex = (await readAll())[owner];
  return hex ? fromHex(hex) : null;
}

/**
 * Keep `secret` for `owner`. Resolves to the secret kept for it afterwards: this
 * one, or the one kept before (never replaced), which the caller must then use.
 */
export function keepCodeSecret(owner: string, secret: Uint8Array): Promise<Uint8Array> {
  if (!SOLANA_ADDRESS.test(owner) || secret.length !== CODE_SECRET_BYTES) return Promise.reject(new Error("Nothing to keep."));
  return update((kept) => {
    if (kept[owner]) return { next: null, out: fromHex(kept[owner]) };
    return { next: { ...kept, [owner]: toHex(secret) }, out: secret.slice() };
  });
}

/**
 * The backup-code secret that opens `owner`'s private account now (a copy: wipe it when done).
 *  - `secret` null: the one this browser keeps.
 *  - a code just made here: kept first, never over another; refused when this browser
 *    already keeps another (a screen from before it was kept).
 *  - a code the person typed (`typed`): kept when none is; when this browser keeps
 *    another, it still opens with the typed one, and the kept one stays (it may open
 *    a private account of its own). A browser that keeps one code never locks the
 *    person out of the account another code opens.
 */
export async function codeRootFor(owner: string, secret: Uint8Array | null, typed = false): Promise<Uint8Array> {
  if (!secret) {
    const kept = await keptCodeSecret(owner);
    if (!kept) throw new GloamRootError("This browser no longer holds your backup code. Enter it to open your private account.", "badcode");
    return kept;
  }
  const kept = await keepCodeSecret(owner, secret);
  if (kept.length === secret.length && kept.every((b, i) => b === secret[i])) return kept;
  kept.fill(0);
  if (typed) return secret.slice();
  throw new GloamRootError("This browser holds another backup code for this account. Reload the page to open with it.", "badcode");
}

/** What the recovery backup carries: every secret kept for the signed-in account. */
export async function codesForBackup(): Promise<SolanaCodeEntry[]> {
  await writeQueue;
  return Object.entries(await readAll()).map(([owner, secret]) => ({ owner, secret }));
}

/** Take in the secrets a backup carried, beside (never over) the ones kept here. */
export function restoreCodes(entries: readonly SolanaCodeEntry[] | undefined): Promise<void> {
  if (!entries?.length) return Promise.resolve();
  return update((kept) => {
    const next = mergeCodes(kept, entries);
    return { next: Object.keys(next).length === Object.keys(kept).length ? null : next, out: undefined };
  });
}
