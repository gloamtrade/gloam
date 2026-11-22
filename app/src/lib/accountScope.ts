/**
 * Whose private account this browser shows (Duke, 22 Nov 2026).
 *
 * After signing out, Receive still showed his Gloam address and QR, and two
 * different wallets signed in on one browser both showed his @duke name and
 * the same 1,214 USDC on BNB Chain, and both could cash it out. The private
 * account lived in the browser, not in the sign-in.
 *
 * Now every sign-in has its own private account here (lib/accountSlot), and a
 * page shows one, the signed-in account's, once this module binds it:
 *
 *  - Signed out: nothing is bound, so nothing is read or shown anywhere.
 *  - The account id is the signed-in address, lowercase: a browser wallet's
 *    address, or for a Gloam wallet (email or passkey sign-in) its Turnkey
 *    wallet's address, the sub-organization's oldest embedded wallet
 *    (lib/embeddedWallet pickEmbeddedWallet), the same on every sign-in.
 *  - Its data is kept under `<key>@<hash>` (hash: accountHash), sealed under
 *    the browser's data key like before, with a sealed owner record
 *    (OWNER_KEY) naming the address it belongs to.
 *  - When the signed-in account changes, or signs out and stays out for a
 *    moment, the page saves what it is writing and reloads, so nothing of one
 *    account stays in memory for the next. Signing back in shows it again.
 *
 * The browser's first account (the keys with no suffix, from before this) has
 * no owner yet. It goes to one sign-in only, decided once (chooseSlot) and
 * recorded in its sealed owner record. Nothing is moved or deleted:
 *
 *  1. Its owner record, when there is one, decides.
 *  2. A sign-in that already has its own account here keeps it.
 *  3. Empty (no notes, address, settings, runs, codes, contacts or names): the
 *     first sign-in takes it. Nothing to hand over.
 *  4. Recovery is on with a wallet key (version 2, or moving to one): that
 *     wallet. It signed the key twice and its backup already holds all of this.
 *  5. Every note that names a wallet, and every payroll run, names the same one,
 *     and no note that can still be spent names none: that wallet.
 *  6. Otherwise the sign-in is asked, once, whether it is theirs (its Gloam
 *     address shown short). Yes: theirs. No: they get their own, recorded so
 *     they are not asked again, and it waits for its owner.
 *
 * Never used: the last wallet connected (wagmi's store, Turnkey's sessions, the
 * per-wallet skip and restore marks). They say which wallets used the browser,
 * not whose balance it is: after Duke's two sign-ins the last one was the
 * second wallet.
 *
 * Checked by scripts/selftest-account-scope.mts.
 */
import { isAddress, keccak256, toBytes } from "viem";
import { bindSlot, boundAccount, boundSlot, keyInSlot, setAccountSignedIn } from "./accountSlot";
import { isSealedValue, notesSettled, openJson, sealJson } from "./noteVault";
import { RECEIVE_TAG_PREFIX } from "./receiveTag";
import type { LocalNote } from "./shield";

/** The sealed record of who an account's data belongs to, in each account's own keys. */
export const OWNER_KEY = "gloam.account.owner.v1";
/** Plain: sign-ins that said the browser's first account is not theirs (hashes only). */
export const ACCOUNTS_KEY = "gloam.accounts.v1";
const ACCOUNTS_LOCK = "gloam-accounts";

/**
 * Every key that holds an account's private data, as each store names it
 * (selftest-account-scope checks them against the stores). Removed-note ids,
 * the backup marks and the owner record follow along but hold nothing of their own.
 */
export const PRIVATE_KEYS = {
  notes: "gloam.shield.notes.v1",
  notesUnreadable: "gloam.shield.notes.unreadable.v1",
  receive: "gloam.receive.identity.v1",
  receivePrevious: "gloam.receive.identity.prev.v1",
  recovery: "gloam.recovery.v1",
  payroll: "gloam.payroll.v1",
  payrollUnreadable: "gloam.payroll.v1.unreadable",
  schedules: "gloam.payroll.schedules.v1",
  sentLinks: "gloam.sentlinks.v1",
  sentLinksUnreadable: "gloam.sentlinks.unreadable.v1",
  contacts: "gloam.contacts.v1",
  names: "gloam.names.mine.v1",
} as const;

/** Lists: present but empty is no data. */
const LIST_KEYS = new Set<string>([PRIVATE_KEYS.notes, PRIVATE_KEYS.payroll, PRIVATE_KEYS.schedules, PRIVATE_KEYS.sentLinks, PRIVATE_KEYS.contacts, PRIVATE_KEYS.names]);

/** How long a sign-out may last before the page reloads: a wallet that drops for a moment and comes back keeps the page. */
export const SIGN_OUT_GRACE_MS = 1_500;

/** An address's slot: 24 hex characters of a hash, so the keys don't list who used this browser. */
export function accountHash(address: string): string {
  return keccak256(toBytes(`gloam/account/v1:${address.toLowerCase()}`)).slice(2, 26);
}

/* ---------------------------------------------------------------- the rule */

export type ClaimReason = "empty" | "recovery" | "notes" | "answer";

/** What lib/accountScope reads about the browser's first account. */
export type FirstAccountFacts = {
  /** Its owner record, when one was written: the owner's lowercase address. */
  owner: string | null;
  /** It holds anything (lib/accountScope PRIVATE_KEYS). */
  hasData: boolean;
  /** Recovery is on with a wallet key (version 2, or moving to one): that wallet. */
  recoveryWallet: string | null;
  /** Every wallet its notes and payroll runs name, lowercase. */
  namedWallets: string[];
  /** Notes that can still be spent and name no wallet. */
  unnamedSpendable: number;
};

export type SlotChoice =
  /** Use `slot` ("" is the first account). With `claim`, first record the first account's owner. */
  | { slot: string; claim?: { owner: string; by: ClaimReason } }
  /** Ask `me` whether the first account is theirs. */
  | { ask: true };

/**
 * Where `me` (a lowercase address) goes. Pure: the rule above, step by step.
 * `ownHasData`: `me` already has its own account here. `declined`: `me` said
 * the first account is not theirs.
 */
export function chooseSlot(me: string, facts: FirstAccountFacts, opts: { ownHasData: boolean; declined: boolean }): SlotChoice {
  const own = accountHash(me);
  const to = (owner: string, by?: ClaimReason): SlotChoice => ({
    slot: owner === me ? "" : own,
    ...(by ? { claim: { owner, by } } : {}),
  });
  if (facts.owner) return to(facts.owner);
  if (opts.ownHasData) return { slot: own };
  if (!facts.hasData) return to(me, "empty");
  if (facts.recoveryWallet) return to(facts.recoveryWallet, "recovery");
  if (facts.namedWallets.length === 1 && facts.unnamedSpendable === 0) return to(facts.namedWallets[0]!, "notes");
  if (opts.declined) return { slot: own };
  return { ask: true };
}

/**
 * Whether this browser holds private data of an account other than the one
 * bound to this page (the recording demo's keys aside). A passkey lock covers
 * every account here, so lib/passkey offers it only where there is one.
 */
export function otherAccountsHere(): boolean {
  const mine = boundSlot();
  const bases = Object.values(PRIVATE_KEYS) as string[];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k) continue;
    for (const base of bases) {
      const slot = k === base ? "" : k.startsWith(`${base}@`) ? k.slice(base.length + 1) : null;
      if (slot !== null && slot !== mine && slot !== "demo") return true;
    }
  }
  return false;
}

/* ---------------------------------------------------------------- reading the first account */

const lower = (a: unknown): string | null => (typeof a === "string" && isAddress(a, { strict: false }) ? a.toLowerCase() : null);

/** A stored value as JSON: sealed (opened, or null when it doesn't open) or plain. Undefined when absent. */
async function readValue(key: string): Promise<unknown> {
  const raw = localStorage.getItem(key);
  if (raw === null) return undefined;
  if (isSealedValue(raw)) return openJson<unknown>(raw);
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

/** Whether the account in `slot` holds anything. A value that can't be read counts: it may be someone's. */
export async function slotHasData(slot: string): Promise<boolean> {
  for (const base of Object.values(PRIVATE_KEYS)) {
    const key = keyInSlot(base, slot);
    if (localStorage.getItem(key) === null) continue;
    if (!LIST_KEYS.has(base)) return true;
    const value = await readValue(key);
    if (!Array.isArray(value) || value.length > 0) return true;
  }
  return false;
}

/** The owner an account's sealed record names, or null (none, or it doesn't open). */
async function ownerOf(slot: string): Promise<string | null> {
  const value = (await readValue(keyInSlot(OWNER_KEY, slot))) as { account?: unknown } | null | undefined;
  return lower(value?.account);
}

function spendable(n: LocalNote): boolean {
  return n.status !== "recovered" && Boolean(n.secret) && n.secret !== "0x" && !n.id.startsWith("pay-");
}

/** What the rule reads about the browser's first account. */
export async function firstAccountFacts(): Promise<FirstAccountFacts> {
  const notes = await readValue(PRIVATE_KEYS.notes);
  const runs = await readValue(PRIVATE_KEYS.payroll);
  const recovery = (await readValue(PRIVATE_KEYS.recovery)) as
    | { source?: unknown; wallet?: unknown; next?: { keys?: { wallet?: unknown } } }
    | null
    | undefined;
  const named = new Set<string>();
  let unnamedSpendable = 0;
  for (const n of Array.isArray(notes) ? (notes as LocalNote[]) : []) {
    if (!n || typeof n.id !== "string") continue;
    const from = lower(n.from);
    if (from) named.add(from);
    else if (spendable(n)) unnamedSpendable++;
  }
  for (const r of Array.isArray(runs) ? (runs as { employer?: unknown }[]) : []) {
    const employer = lower(r?.employer);
    if (employer) named.add(employer);
  }
  const wallet = recovery?.source === "wallet" ? (lower(recovery.wallet) ?? lower(recovery.next?.keys?.wallet)) : null;
  return {
    owner: await ownerOf(""),
    hasData: await slotHasData(""),
    recoveryWallet: wallet,
    namedWallets: [...named],
    unnamedSpendable,
  };
}

/** The first account's Gloam address, for the question. Null when it has none (or it doesn't open). */
export async function firstAccountTag(): Promise<string | null> {
  const value = (await readValue(PRIVATE_KEYS.receive)) as { publicSpkiB64?: unknown } | null | undefined;
  return typeof value?.publicSpkiB64 === "string" ? RECEIVE_TAG_PREFIX + value.publicSpkiB64 : null;
}

/* ---------------------------------------------------------------- records */

function readDeclined(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(ACCOUNTS_KEY) ?? "null") as { declined?: unknown } | null;
    return Array.isArray(v?.declined) ? v.declined.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function addDeclined(hash: string) {
  const declined = readDeclined();
  if (declined.includes(hash)) return;
  localStorage.setItem(ACCOUNTS_KEY, JSON.stringify({ v: 1, declined: [...declined, hash] }));
}

/** Seal `owner` as the owner of the account in `slot`. */
async function writeOwner(slot: string, owner: string, by: ClaimReason | "own") {
  const sealed = await sealJson({ v: 1, account: owner, by, at: Date.now() });
  localStorage.setItem(keyInSlot(OWNER_KEY, slot), sealed);
}

/** Runs `fn` while no other tab decides (Web Locks; without them, the owner record is read again first). */
function withAccountsLock<T>(fn: () => Promise<T>): Promise<T> {
  const locks = (globalThis.navigator as { locks?: { request: (n: string, f: () => Promise<T>) => Promise<T> } } | undefined)?.locks;
  return locks?.request ? locks.request(ACCOUNTS_LOCK, fn) : fn();
}

/** Decide and record where `me` goes. Waits for a passkey unlock where one guards the data key. */
async function decide(me: string): Promise<SlotChoice> {
  return withAccountsLock(async () => {
    const own = accountHash(me);
    const choice = chooseSlot(me, await firstAccountFacts(), {
      ownHasData: await slotHasData(own),
      declined: readDeclined().includes(own),
    });
    if ("slot" in choice && choice.claim && !(await ownerOf(""))) await writeOwner("", choice.claim.owner, choice.claim.by);
    return choice;
  });
}

/* ---------------------------------------------------------------- the page's state */

export type ScopePhase =
  /** No one signed in: nothing shown. */
  | "signed-out"
  /** Signed in, finding which account is theirs. */
  | "checking"
  /** Signed in, asked whether the browser's first account is theirs. */
  | "asking"
  /** Signed in, their account bound: shown. */
  | "ready"
  /** Another account signed in: the page is reloading. */
  | "leaving";

export type ScopeState = {
  phase: ScopePhase;
  /** The signed-in address, lowercase. */
  account: string | null;
  /** While asking: the first account's Gloam address, or null when it has none. */
  tag: string | null;
  /** The question could not be recorded: say so and let it be answered again. */
  error: string | null;
};

const SIGNED_OUT: ScopeState = { phase: "signed-out", account: null, tag: null, error: null };
let state: ScopeState = SIGNED_OUT;
const subscribers = new Set<() => void>();
let run = 0;
let leaveTimer: ReturnType<typeof setTimeout> | undefined;

function set(next: Partial<ScopeState> & Pick<ScopeState, "phase">) {
  state = { account: null, tag: null, error: null, ...next };
  for (const fn of subscribers) fn();
}

export function accountScopeState(): ScopeState {
  return state;
}

export function accountScopeServerState(): ScopeState {
  return SIGNED_OUT;
}

export function subscribeAccountScope(fn: () => void): () => void {
  subscribers.add(fn);
  return () => {
    subscribers.delete(fn);
  };
}

/** What leaving the page does: save what is being written, then reload. The self-test puts its own in. */
let reloadPage: () => void = () => window.location.reload();

export function setPageReload(fn: () => void) {
  reloadPage = fn;
}

/** This tab's recent reloads for a change of account (sessionStorage), so a wallet that keeps flipping can't loop the page. */
const RELOADS_KEY = "gloam.accounts.reloads.v1";
const RELOAD_WINDOW_MS = 30_000;
const RELOADS_MAX = 3;

function mayReload(now = Date.now()): boolean {
  try {
    const recent = (JSON.parse(sessionStorage.getItem(RELOADS_KEY) ?? "[]") as unknown[]).filter(
      (t): t is number => typeof t === "number" && now - t < RELOAD_WINDOW_MS
    );
    if (recent.length >= RELOADS_MAX) return false;
    sessionStorage.setItem(RELOADS_KEY, JSON.stringify([...recent, now]));
  } catch {
    /* storage refused: reload anyway, a page can always be left */
  }
  return true;
}

async function leavePage() {
  await notesSettled().catch(() => undefined);
  if (mayReload()) {
    reloadPage();
    return;
  }
  // Nothing is shown or spent meanwhile: the bound account is not the one signed in.
  set({ phase: "leaving", account: state.account, error: "Your wallet keeps switching accounts. Reload the page to open your private account." });
}

/**
 * The signed-in address changed (components/app/AccountScope calls this on
 * every change). Null: signed out. `demo`: the recording demo's pretend wallet,
 * kept in its own keys and never given the browser's first account.
 */
export async function signInAs(address: string | null | undefined, opts: { demo?: boolean } = {}): Promise<void> {
  const me = typeof address === "string" && isAddress(address, { strict: false }) ? address.toLowerCase() : null;
  const bound = boundAccount();
  clearTimeout(leaveTimer);
  if (bound) {
    if (me === bound) {
      setAccountSignedIn(true);
      set({ phase: "ready", account: me });
      return;
    }
    // Nothing is spent or shown from here: the account bound to this page is not the one signed in.
    setAccountSignedIn(false);
    if (!me) {
      set({ phase: "signed-out" });
      leaveTimer = setTimeout(() => void leavePage(), SIGN_OUT_GRACE_MS);
      return;
    }
    set({ phase: "leaving", account: me });
    await leavePage();
    return;
  }
  const token = ++run;
  if (!me) {
    set({ phase: "signed-out" });
    return;
  }
  set({ phase: "checking", account: me });
  try {
    if (opts.demo) {
      await bindSlot(me, "demo");
    } else {
      const choice = await decide(me);
      if (token !== run) return;
      if ("ask" in choice) {
        set({ phase: "asking", account: me, tag: await firstAccountTag().catch(() => null) });
        return;
      }
      await bindAs(me, choice.slot);
    }
    if (token !== run) return;
    set({ phase: "ready", account: me });
  } catch {
    // Storage refused or the data key is gone: stay unbound (nothing shown), and try again on the next sign-in.
    if (token === run) set({ phase: "checking", account: me, error: "This browser couldn't open your private account. Reload the page to try again." });
  }
}

/** Bind `me` to `slot`, sealing its owner record first when its own account has none. */
async function bindAs(me: string, slot: string) {
  if (slot !== "" && !(await ownerOf(slot))) await writeOwner(slot, me, "own");
  await bindSlot(me, slot);
}

/**
 * The answer to "Is this private account yours?". Yes: the browser's first
 * account becomes theirs. No: they get their own, and the first one waits for
 * its owner, untouched. Recorded either way, so it is asked once.
 */
export async function answerFirstAccount(mine: boolean): Promise<void> {
  if (state.phase !== "asking" || !state.account) return;
  const me = state.account;
  const token = ++run;
  const tag = state.tag;
  set({ phase: "checking", account: me });
  try {
    const slot = await withAccountsLock(async () => {
      // another tab may have answered meanwhile: its answer stands
      const owner = await ownerOf("");
      if (owner) return owner === me ? "" : accountHash(me);
      if (mine) {
        await writeOwner("", me, "answer");
        return "";
      }
      addDeclined(accountHash(me));
      return accountHash(me);
    });
    if (token !== run) return;
    await bindAs(me, slot);
    if (token !== run) return;
    set({ phase: "ready", account: me });
  } catch {
    if (token === run) set({ phase: "asking", account: me, tag, error: "That didn't save in this browser. Try again." });
  }
}
