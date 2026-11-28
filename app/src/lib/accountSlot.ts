/**
 * Which private account this page reads and writes (Duke, 22 Nov 2026).
 *
 * A private account (notes, receive keys, recovery settings, payroll runs and
 * schedules, sent codes, contacts, names) lives in this browser, sealed under
 * the browser's data key (lib/noteVault). It used to be one per browser, so
 * the next person to sign in, or a second wallet, saw and could spend it.
 * Now each sign-in has its own: its keys carry a suffix, `<key>@<slot>`. The
 * browser's first account, from before this change, keeps the keys with no
 * suffix (slot ""), and belongs to one sign-in only (lib/accountScope decides
 * which, and records it).
 *
 * A page binds one account at most. Until it does, the app reads nothing and
 * writes nothing: every store gets null from scopedKey and shows an empty
 * account. When the signed-in account changes, the page reloads
 * (lib/accountScope), so nothing of one account stays in memory for the next.
 *
 * No imports: every store reads it, and lib/accountScope imports the stores.
 *
 * Self-tests that run storage code in Node have no `document`, and run with
 * the scope off: the keys with no suffix, as before. scripts/selftest-account-scope
 * turns it on (enforceAccountScope).
 */

/** What a view shows while no sign-in is bound to this page. */
export const SIGNED_OUT_MESSAGE = "Sign in to see your private account.";

/** Thrown by a write while no sign-in is bound: nothing was saved. */
export class SignedOutError extends Error {
  constructor() {
    super("Sign in to use your private account. Nothing was saved.");
    this.name = "SignedOutError";
  }
}

let enforced = typeof document !== "undefined";
/** "" for the browser's first account (keys with no suffix), else the account's hash. Null: none bound. */
let slot: string | null = null;
/** The bound account, as a lowercase address. */
let account: string | null = null;
/** The bound account is the one signed in now. */
let signedIn = false;

/** Turn the scope on outside a browser (the self-test), or off again. */
export function enforceAccountScope(on = true) {
  enforced = on;
}

/** Whether this page keeps accounts apart. True in every browser. */
export function accountScopeOn(): boolean {
  return enforced;
}

/** The bound account's lowercase address, or null. */
export function boundAccount(): string | null {
  return account;
}

/** The bound slot: "" for the browser's first account, a hash for any other, null for none. */
export function boundSlot(): string | null {
  return slot;
}

/**
 * Where `base` lives for the bound account: `base` itself for the browser's
 * first account, `base@<slot>` for any other. Null while none is bound (with the
 * scope on): read nothing.
 */
export function scopedKey(base: string): string | null {
  if (slot === null) return enforced ? null : base;
  return slot === "" ? base : `${base}@${slot}`;
}

/** scopedKey for a write: throws SignedOutError while no account is bound. */
export function writableKey(base: string): string {
  const key = scopedKey(base);
  if (key === null) throw new SignedOutError();
  return key;
}

/** `base` as it is kept for the account in `inSlot` ("" or a hash). */
export function keyInSlot(base: string, inSlot: string): string {
  return inSlot === "" ? base : `${base}@${inSlot}`;
}

/**
 * Whether private data may be shown and spent now: the bound account is the
 * one signed in. Always true with the scope off.
 */
export function accountShown(): boolean {
  return !enforced || (slot !== null && signedIn);
}

/** Set by lib/accountScope as the bound account signs out and back in. */
export function setAccountSignedIn(on: boolean) {
  signedIn = on && slot !== null;
}

type BindHook = () => void | Promise<void>;
const hooks = new Set<BindHook>();

/**
 * Run `fn` each time an account is bound (or unbound), before anything reads
 * the stores: a store resets what it holds in memory and reads the new
 * account's keys.
 */
export function onAccountBound(fn: BindHook): () => void {
  hooks.add(fn);
  return () => {
    hooks.delete(fn);
  };
}

/** Bind `addr` to `inSlot` for this page. Only lib/accountScope calls it. */
export async function bindSlot(addr: string, inSlot: string): Promise<void> {
  slot = inSlot;
  account = addr.toLowerCase();
  signedIn = true;
  for (const fn of [...hooks]) await fn();
}

/**
 * Unbind, as a page reload does: no account, and every store drops what it
 * holds in memory. The app never calls it (it reloads instead); the self-test
 * does, to stand for one.
 */
export async function unbindSlot(): Promise<void> {
  slot = null;
  account = null;
  signedIn = false;
  for (const fn of [...hooks]) await fn();
}
