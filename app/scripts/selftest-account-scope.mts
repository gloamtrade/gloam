/**
 * Self-test: each sign-in has its own private account in a browser (Duke's
 * report, 22 Nov 2026).
 *
 * After Sign out, Vault > Receive still showed his Gloam address and QR. Two
 * different wallets signed in on one browser both showed his @duke name and the
 * same 1,214 USDC on BNB Chain, and both could cash it out: the notes, the
 * receive key, the names and the runs were one per browser.
 *
 * Here, with the browser's storage seeded the way main's code left it (Duke's
 * notes naming no wallet, his receive key, name, payroll run, sent code,
 * contact and recovery with his wallet):
 *  - signed out, nothing is read, shown, written or spent
 *  - a second wallet that signs in first gets its own empty account: none of
 *    Duke's notes, address, name, runs, codes or contacts, and every spend
 *    path refuses his notes; a payment to his address doesn't open for it
 *  - switching back reloads the page and shows Duke's account as it was
 *  - the browser's first account goes to its owner on evidence only (recovery
 *    wallet, or every note naming one wallet), otherwise the sign-in is asked;
 *    "no" keeps it untouched, and it never goes to a second wallet
 *  - backups and restores stay per account, and nothing ever saves an empty one
 *
 * Fails on main: lib/accountSlot and lib/accountScope don't exist there, and
 * the first check below shows what main's code does with this storage.
 *
 * Run from app/:  ../mcp/node_modules/.bin/tsx scripts/selftest-account-scope.mts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { localStorage, resetBrowser } from "./browser-shim.mjs";

const sessionStorage = (globalThis as unknown as { sessionStorage: Storage }).sessionStorage;
import { formatUnits, getAddress, type Address, type Hex } from "viem";

delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;
// BNB Chain on, as production runs it (the same values CI uses for the CSP checks).
process.env.NEXT_PUBLIC_BNB_ENABLED = "1";
process.env.NEXT_PUBLIC_BNB_POOL = "0x89d3042390204f57b8b4F8949D3c2203E4002164";
process.env.NEXT_PUBLIC_BNB_DEPLOY_BLOCK = "134300000";
process.env.NEXT_PUBLIC_BNB_LIVE_SINCE = "19 November 2026";

const win = globalThis.window as unknown as Record<string, unknown>;
win.setTimeout = setTimeout;
win.clearTimeout = clearTimeout;

// A stand-in /api/recovery. Nothing leaves the process.
const backups = new Map<string, { c: string; n: number; t: number }>();
let puts = 0;
globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
  const u = new URL(String(url), "https://gloam.trade");
  if (u.pathname !== "/api/recovery") throw new Error(`selftest-account-scope: no network calls allowed (${String(url)})`);
  const method = init?.method ?? "GET";
  if (method === "GET") {
    const b = backups.get(u.searchParams.get("id")!);
    return b ? Response.json({ data: b }) : Response.json({ error: { message: "none" } }, { status: 404 });
  }
  const body = JSON.parse(String(init!.body)) as { id: string; c?: string; n?: number };
  if (method === "PUT") {
    puts++;
    const t = Date.now();
    backups.set(body.id, { c: body.c!, n: body.n!, t });
    return Response.json({ data: { n: body.n, t } });
  }
  if (method === "DELETE") {
    backups.delete(body.id);
    return Response.json({ ok: true });
  }
  throw new Error(`unexpected ${method}`);
}) as typeof fetch;

type LocalNote = import("../src/lib/shield").LocalNote;

localStorage.setItem("gloam.network", "bnb-mainnet");

const slot = await import("../src/lib/accountSlot");
const scope = await import("../src/lib/accountScope");
const vault = await import("../src/lib/noteVault");
const shield = await import("../src/lib/shield");
const nets = await import("../src/lib/networks");
const receive = await import("../src/lib/receiveTag");
const recovery = await import("../src/lib/recovery");
const payrollStore = await import("../src/lib/payrollStore");
const payroll = await import("../src/lib/payroll");
const schedules = await import("../src/lib/payrollSchedule");
const sentLinks = await import("../src/lib/sentLinks");
const sentLinksStore = await import("../src/lib/sentLinksStore");
const contacts = await import("../src/lib/contacts");
const names = await import("../src/lib/gloamNames");
const { proveCashOut } = await import("../src/lib/cashOutProof");
const { splitForCashOut } = await import("../src/lib/cashOutSplit");
const { runVaultSwap } = await import("../src/lib/vaultSwapRun");
const { runPrivateNameClaim } = await import("../src/lib/nameClaimRun");
const { secureClaim } = await import("../src/lib/claimSweep");
const { GLOAM_TOKEN } = await import("../src/lib/buybacks");

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  await fn();
  passed++;
  console.log(`ok  ${name}`);
}

const BNB = nets.getNetwork("bnb-mainnet");
const RH = nets.getNetwork("robinhood-mainnet");
assert.ok(BNB.pool, "BNB Chain is on for this test");
const USDC = "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d" as Address; // 18 decimals on BNB Chain
const DUKE = "0x76b7E410a227c888aBD2Bdc24Ee32E094B0FD4D8" as Address; // the wallet his recovery was turned on with
const SECOND = "0x2222222222222222222222222222222222222222" as Address; // his second wallet
const GUEST = "0x3333333333333333333333333333333333333333" as Address;
const OTHER = "0x4444444444444444444444444444444444444444" as Address;
const hex = (fill: string) => `0x${fill.repeat(64).slice(0, 64)}` as Hex;

let k = 0;
function note(amountWei: string, from: Address | undefined, extra: Partial<LocalNote> = {}): LocalNote {
  k++;
  return {
    id: `n-${k}`,
    chainId: BNB.chainId,
    pool: BNB.pool as Address,
    asset: USDC,
    amountWei,
    commitment: hex(`${k}c`),
    secret: hex(`${k}a`),
    nullifier: hex(`${k}b`),
    bound: true,
    scheme: "poseidon",
    leafIndex: k,
    txHash: hex(`${k}d`),
    ...(from ? { from } : {}),
    createdAt: 1_700_000_000_000 + k,
    status: "open",
    source: "local",
    ...extra,
  };
}

const usdc = (notes: LocalNote[]) => formatUnits(shield.sumByAsset(shield.activeSpendableNotes(notes)).get(USDC.toLowerCase()) ?? 0n, 18);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Every key this browser keeps, as it is on disk now. */
function disk(): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)!;
    out[key] = localStorage.getItem(key);
  }
  return out;
}
/** The keys of the browser's first account (no suffix) that hold private data. */
function firstAccountDisk(): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const base of Object.values(scope.PRIVATE_KEYS)) out[base] = localStorage.getItem(base);
  return out;
}

let reloads = 0;
scope.setPageReload(() => {
  reloads++;
});

/** What a page reload does: the next page starts with nothing bound and nothing held. */
async function newPage() {
  await vault.notesSettled();
  await slot.unbindSlot();
  await scope.signInAs(null);
}

/** Sign in on a fresh page and wait for its account. */
async function signIn(address: Address) {
  await scope.signInAs(address);
  await vault.unlockNoteVault();
}

/** A backup as the server holds it, opened with its keys (lib/recovery seals it this way). */
async function openBackup(keys: { id: string; key: string }, c: string) {
  const raw = Uint8Array.from(atob(c), (ch) => ch.charCodeAt(0));
  const aes = await crypto.subtle.importKey("raw", Uint8Array.from(atob(keys.key), (ch) => ch.charCodeAt(0)), "AES-GCM", false, ["decrypt"]);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: raw.slice(0, 12), additionalData: new TextEncoder().encode(keys.id) },
    aes,
    raw.slice(12)
  );
  return JSON.parse(new TextDecoder().decode(plain)) as { notes: LocalNote[]; receive: { current: { publicSpkiB64: string } | null } };
}

/* ------------------------------------------------------------ the browser as main left it */

// Main's code: one private account per browser (the scope off writes the keys with no suffix).
slot.enforceAccountScope(false);
// Duke's 1,214 USDC on BNB Chain, in notes that name no wallet: both of his wallets saw them.
const dukeNotes = [note("1000000000000000000000", undefined), note("214000000000000000000", undefined)];
const dukeClaim = note("5000000000000000000", undefined, { id: "imp-1" });
await vault.unlockNoteVault();
await vault.setAllNotes([...dukeNotes, dukeClaim]);
const dukeTag = (await receive.getOrCreateReceiveIdentity()).tag;
const dukeRun = payroll.newBatch({ title: "November", chainId: BNB.chainId, pool: BNB.pool as Address, asset: USDC, employer: DUKE, relay: true, rows: [] });
await payrollStore.saveBatch(dukeRun);
await sentLinksStore.saveSentLink(
  sentLinks.makeSentLink({ code: "gloam1.ZHVrZS1jb2RlLW9uZQ", chainId: BNB.chainId, pool: BNB.pool as Address, asset: USDC, symbol: "USDC", amountWei: "1" })
);
contacts.upsertContact("Ayo", dukeTag);
names.rememberMyName("duke");
const dukeKeys = { ...(await recovery.keysFromSecret("wallet", crypto.getRandomValues(new Uint8Array(32)))), wallet: getAddress(DUKE) };
localStorage.setItem("gloam.recovery.v1", await vault.sealJson({ ...dukeKeys, n: 0, savedAt: null }));

await test("the bug: with one account per browser, his second wallet sees Duke's 1,214 USDC and his address", async () => {
  assert.equal((await sentLinksStore.loadSentLinks(BNB.chainId, BNB.pool as Address)).length, 1, "his sent code is stored");
  assert.equal((await payrollStore.loadBatches(BNB.chainId, BNB.pool as Address)).length, 1, "his run is stored");
  const seen = shield.visibleNotes(vault.getAllNotes(), [], BNB, true, SECOND).local;
  assert.equal(usdc(seen), "1219", "his 1,214 and the 5 claimed: no note names a wallet, so every wallet sees them");
  assert.equal(usdc(dukeNotes), "1214");
  assert.equal((await receive.getOrCreateReceiveIdentity()).tag, dukeTag, "one address for whoever signs in");
});

// This code, as a browser runs it: the next page load.
slot.enforceAccountScope(true);
await newPage();
const before = disk();
const firstBefore = firstAccountDisk();

/* ------------------------------------------------------------ signed out */

await test("signed out: nothing is read, shown or written, and nothing is deleted", async () => {
  assert.equal(scope.accountScopeState().phase, "signed-out");
  await vault.unlockNoteVault();
  assert.deepEqual(vault.getAllNotes(), []);
  assert.deepEqual(shield.loadWalletNotes(null, BNB), []);
  assert.deepEqual(shield.loadLocalNotes(undefined, BNB), [], "not even the reads that are not a view");
  await assert.rejects(receive.getOrCreateReceiveIdentity(), slot.SignedOutError, "no Gloam address, no QR");
  assert.deepEqual(await receive.exportReceiveKeys(), { current: null, previous: [] });
  await assert.rejects(receive.decryptTicketWithLocalTag(await receive.encryptTicketForTag("x", dukeTag)), slot.SignedOutError);
  assert.deepEqual(names.loadMyNames(), [], "no @name");
  assert.deepEqual(await payrollStore.loadBatches(BNB.chainId, BNB.pool as Address), [], "no payroll runs");
  assert.deepEqual(await schedules.loadSchedules(BNB.chainId, BNB.pool as Address), []);
  assert.deepEqual(await sentLinksStore.loadSentLinks(BNB.chainId, BNB.pool as Address), [], "no claim codes");
  assert.deepEqual(contacts.loadContacts(), []);
  assert.equal(recovery.recoveryState().on, false);
  await assert.rejects(vault.setAllNotes([note("1", undefined)]), slot.SignedOutError);
  await assert.rejects(payrollStore.saveBatch(dukeRun), slot.SignedOutError);
  assert.throws(() => contacts.upsertContact("x", dukeTag), slot.SignedOutError);
  assert.equal(shield.noteNetworkProblem(dukeNotes[0]!, BNB), slot.SIGNED_OUT_MESSAGE, "nothing is spent");
  assert.equal(shield.SIGNED_OUT_BALANCE_MESSAGE, "Sign in to see your private account.");
  assert.deepEqual(disk(), before, "the store is exactly as it was");
});

/* ------------------------------------------------------------ a second wallet signs in first */

let secondTag = "";
await test("his second wallet signs in first: its own empty account, and Duke's goes to his recovery wallet", async () => {
  await signIn(SECOND);
  const s = scope.accountScopeState();
  assert.equal(s.phase, "ready");
  assert.equal(slot.boundSlot(), scope.accountHash(SECOND), "its own keys, with a suffix");
  assert.deepEqual(vault.getAllNotes(), []);
  assert.deepEqual(shield.loadWalletNotes(SECOND, BNB), []);
  // what a view still held from before can't show either
  assert.deepEqual(shield.visibleNotes([...dukeNotes, dukeClaim], [], BNB, true, SECOND).local, []);
  secondTag = (await receive.getOrCreateReceiveIdentity()).tag;
  assert.notEqual(secondTag, dukeTag, "its own Gloam address");
  assert.deepEqual(names.loadMyNames(), [], "Duke's @duke is not its name");
  assert.deepEqual(await payrollStore.loadBatches(BNB.chainId, BNB.pool as Address), []);
  assert.deepEqual(await sentLinksStore.loadSentLinks(BNB.chainId, BNB.pool as Address), []);
  assert.deepEqual(contacts.loadContacts(), []);
  await sleep(0);
  assert.equal(recovery.recoveryState().on, false, "Duke's recovery is his");
  assert.deepEqual(firstAccountDisk(), firstBefore, "Duke's account is untouched");
  // Duke's sealed owner record: his recovery wallet signed the key twice and its backup holds all of this
  const owner = await vault.openJson<{ account: string; by: string }>(localStorage.getItem(scope.OWNER_KEY));
  assert.deepEqual([owner?.account, owner?.by], [DUKE.toLowerCase(), "recovery"]);
  assert.ok(vault.isSealedValue(localStorage.getItem(`${scope.OWNER_KEY}@${scope.accountHash(SECOND)}`)), "its own owner record, sealed");
});

await test("every spend path refuses Duke's notes on the second wallet's account", async () => {
  const mine = vault.NOTE_NOT_YOURS_MESSAGE;
  const theirs = dukeNotes[0]!;
  assert.equal(vault.noteOwnerProblem(theirs), mine);
  assert.equal(shield.noteNetworkProblem(theirs, BNB), mine, "the gate Pay, Cash out and private send ask");
  const path = { pathElements: [], pathIndices: [], root: 0n } as never;
  const refused = new RegExp(mine.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  await assert.rejects(proveCashOut(theirs, SECOND, path, BNB.chainId), refused, "cash out, cash out later, private cash out");
  await assert.rejects(
    splitForCashOut({ note: theirs, amount: 1n, path, owner: SECOND, relayOn: true, sendWithWallet: () => Promise.reject(new Error("must not send")), onStatus: () => {} }),
    refused,
    "setting part aside (partial cash out, swap, top-ups)"
  );
  await assert.rejects(
    runVaultSwap({ network: BNB, router: SECOND, note: theirs, amount: 1n, assetOut: USDC, plan: {} as never, feeBps: 50, owner: SECOND, pathFor: () => Promise.reject(new Error("must not read")), onStatus: () => {} }),
    refused,
    "a private swap"
  );
  const gloam = { ...note("1000000000000000000000000", undefined), chainId: RH.chainId, pool: RH.pool as Address, asset: GLOAM_TOKEN as Address };
  await assert.rejects(
    runPrivateNameClaim({ notes: [gloam], claim: { name: "duke", years: 1 } as never, price: 50n * 10n ** 18n, feeBps: 50, owner: SECOND, onStatus: () => {} }),
    refused,
    "a name paid privately"
  );
  const env = { chainId: BNB.chainId, pool: BNB.pool as Address, chain: {} as never, prove: () => Promise.reject(new Error("must not prove")), relay: () => Promise.reject(new Error("must not send")), leafIndexOf: async () => undefined } as never;
  await assert.rejects(secureClaim({ note: dukeClaim, relay: true, sendWithWallet: () => Promise.reject(new Error("must not send")) }, env), refused, "securing a claim");
  assert.deepEqual(payroll.fundingNotes(DUKE, USDC, null, BNB), [], "a run of Duke's funds from nothing here");
  assert.deepEqual(payroll.fundingNotes(SECOND, USDC, null, BNB), []);
  assert.equal(payroll.runNetworkProblem(dukeRun, { chain: { id: BNB.chainId } }), null);
});

await test("a payment to Duke's address doesn't open for the second wallet; one to its own does", async () => {
  await assert.rejects(receive.decryptTicketWithLocalTag(await receive.encryptTicketForTag("for duke", dukeTag)), /encrypted for someone else/);
  assert.equal(await receive.decryptTicketWithLocalTag(await receive.encryptTicketForTag("for second", secondTag)), "for second");
});

await test("a passkey lock isn't offered: it would lock Duke's account too", () => {
  assert.equal(scope.otherAccountsHere(), true);
});

/* ------------------------------------------------------------ backups per account */

const secondKeys = await recovery.keysFromSecret("passkey", crypto.getRandomValues(new Uint8Array(32)));
await test("the second wallet's backup holds its own account only", async () => {
  await shield.saveLocalNote(note("7000000000000000000", SECOND));
  const firstConfig = localStorage.getItem("gloam.recovery.v1");
  await recovery.connectRecovery(secondKeys, SECOND);
  assert.equal(recovery.recoveryState().on, true);
  assert.equal(localStorage.getItem("gloam.recovery.v1"), firstConfig, "Duke's settings unchanged");
  assert.ok(localStorage.getItem(`gloam.recovery.v1@${scope.accountHash(SECOND)}`), "its own settings");
  const saved = await openBackup(secondKeys, backups.get(secondKeys.id)!.c);
  assert.equal(usdc(saved.notes), "7", "its 7 USDC, none of Duke's 1,214");
  assert.equal(receive.RECEIVE_TAG_PREFIX + saved.receive.current!.publicSpkiB64, secondTag, "its own address");
});

/* ------------------------------------------------------------ switching back */

await test("Duke signs in on that page: it saves and reloads, never showing his account under the other one", async () => {
  const at = reloads;
  await scope.signInAs(DUKE);
  assert.equal(scope.accountScopeState().phase, "leaving");
  assert.equal(reloads, at + 1);
  assert.deepEqual(shield.loadWalletNotes(DUKE, BNB), [], "nothing of Duke's while the page goes");
  assert.equal(shield.noteNetworkProblem(vault.getAllNotes()[0]!, BNB), slot.SIGNED_OUT_MESSAGE, "nor is the bound account's spent");
});

await test("after the reload Duke has his account back, exactly as it was", async () => {
  await newPage();
  await signIn(DUKE);
  assert.equal(scope.accountScopeState().phase, "ready");
  assert.equal(slot.boundSlot(), "", "the browser's first account is his");
  assert.equal(usdc(shield.visibleNotes(shield.loadWalletNotes(DUKE, BNB), [], BNB, true, DUKE).local), "1219");
  assert.equal((await receive.getOrCreateReceiveIdentity()).tag, dukeTag, "the same Gloam address");
  assert.deepEqual(names.loadMyNames(), ["duke"]);
  assert.equal((await payrollStore.loadBatches(BNB.chainId, BNB.pool as Address)).length, 1);
  assert.equal((await sentLinksStore.loadSentLinks(BNB.chainId, BNB.pool as Address)).length, 1);
  assert.deepEqual(contacts.loadContacts().map((c) => c.label), ["Ayo"]);
  await sleep(0);
  assert.equal(recovery.recoveryState().on, true);
  assert.equal(recovery.recoveryState().newerKey, true, "his wallet key");
  assert.equal(shield.noteNetworkProblem(dukeNotes[0]!, BNB), null, "his own notes spend as before");
  assert.equal(scope.otherAccountsHere(), true, "the second wallet's account is here too");
  // the second wallet's note never came over
  assert.ok(!vault.getAllNotes().some((n) => n.from === SECOND));
  assert.equal(await receive.decryptTicketWithLocalTag(await receive.encryptTicketForTag("for duke", dukeTag)), "for duke");
  await assert.rejects(receive.decryptTicketWithLocalTag(await receive.encryptTicketForTag("for second", secondTag)), /encrypted for someone else/);
});

await test("Duke's backup saves his account, not the second wallet's", async () => {
  await recovery.backupNow();
  const saved = await openBackup(dukeKeys, backups.get(dukeKeys.id)!.c);
  assert.equal(usdc(saved.notes), "1219");
  assert.equal(receive.RECEIVE_TAG_PREFIX + saved.receive.current!.publicSpkiB64, dukeTag);
});

await test("Sign out: hidden and unspendable at once, and the page reloads unless he's back in a moment", async () => {
  const at = reloads;
  await scope.signInAs(null);
  assert.equal(scope.accountScopeState().phase, "signed-out");
  assert.deepEqual(shield.loadWalletNotes(null, BNB), []);
  assert.equal(shield.noteNetworkProblem(dukeNotes[0]!, BNB), slot.SIGNED_OUT_MESSAGE);
  await assert.rejects(receive.getOrCreateReceiveIdentity(), slot.SignedOutError);
  // back within the moment: same page, shown again
  await scope.signInAs(DUKE);
  assert.equal(scope.accountScopeState().phase, "ready");
  await sleep(scope.SIGN_OUT_GRACE_MS + 100);
  assert.equal(reloads, at, "no reload");
  // gone for good: the page reloads
  await scope.signInAs(null);
  await sleep(scope.SIGN_OUT_GRACE_MS + 100);
  assert.equal(reloads, at + 1);
});

await test("a wallet that keeps flipping accounts can't loop the page: the third reload in half a minute waits for a person", async () => {
  sessionStorage.clear();
  const at = reloads;
  for (let i = 0; i < 4; i++) {
    await newPage();
    await signIn(DUKE);
    await scope.signInAs(i % 2 ? DUKE : SECOND);
    if (i % 2) await scope.signInAs(SECOND);
  }
  assert.equal(reloads, at + 3);
  const s = scope.accountScopeState();
  assert.equal(s.phase, "leaving");
  assert.match(s.error ?? "", /Reload the page/);
  assert.equal(slot.accountShown(), false, "nothing shown or spent meanwhile");
  sessionStorage.clear();
});

await test("a page with no account never sends a backup, and never an empty one", async () => {
  await newPage();
  const at = puts;
  await recovery.backupNow();
  await sleep(10);
  assert.equal(puts, at);
});

/* ------------------------------------------------------------ restore on another device */

await test("restore stays per account on a new browser", async () => {
  resetBrowser();
  localStorage.setItem("gloam.network", "bnb-mainnet");
  await newPage();
  // the second wallet first: an empty browser's first account is simply its own
  await signIn(SECOND);
  assert.equal(slot.boundSlot(), "");
  assert.equal(await recovery.connectRecovery(secondKeys, SECOND, { mustExist: true }), 1);
  assert.equal(usdc(shield.loadWalletNotes(SECOND, BNB)), "7");
  assert.equal((await receive.getOrCreateReceiveIdentity()).tag, secondTag, "its address came back");
  // then Duke, on a new page: his own account, his backup only
  await newPage();
  await signIn(DUKE);
  assert.equal(slot.boundSlot(), scope.accountHash(DUKE));
  assert.deepEqual(vault.getAllNotes(), []);
  await recovery.connectRecovery(dukeKeys, DUKE, { mustExist: true });
  assert.equal(usdc(shield.loadWalletNotes(DUKE, BNB)), "1219");
  assert.equal((await receive.getOrCreateReceiveIdentity()).tag, dukeTag);
  // and the second wallet's account is as its restore left it
  await newPage();
  await signIn(SECOND);
  assert.equal(usdc(shield.loadWalletNotes(SECOND, BNB)), "7");
});

/* ------------------------------------------------------------ the rule */

const own = (a: string) => scope.accountHash(a);
const facts = (f: Partial<import("../src/lib/accountScope").FirstAccountFacts>) => ({
  owner: null,
  hasData: true,
  recoveryWallet: null,
  namedWallets: [],
  unnamedSpendable: 0,
  ...f,
});
const none = { ownHasData: false, declined: false };
const d = DUKE.toLowerCase();
const s2 = SECOND.toLowerCase();

await test("the rule: an owner record decides, and nothing else is read", () => {
  assert.deepEqual(scope.chooseSlot(d, facts({ owner: d, recoveryWallet: s2 }), none), { slot: "" });
  assert.deepEqual(scope.chooseSlot(s2, facts({ owner: d }), none), { slot: own(s2) });
});

await test("the rule: a sign-in with its own account here keeps it", () => {
  assert.deepEqual(scope.chooseSlot(d, facts({ recoveryWallet: d }), { ownHasData: true, declined: false }), { slot: own(d) });
  assert.deepEqual(scope.chooseSlot(d, facts({ hasData: false }), { ownHasData: true, declined: false }), { slot: own(d) });
});

await test("the rule: an empty first account goes to whoever signs in first", () => {
  assert.deepEqual(scope.chooseSlot(s2, facts({ hasData: false }), none), { slot: "", claim: { owner: s2, by: "empty" } });
});

await test("the rule: the recovery wallet, never a second wallet that signs in first", () => {
  assert.deepEqual(scope.chooseSlot(s2, facts({ recoveryWallet: d, namedWallets: [s2] }), none), { slot: own(s2), claim: { owner: d, by: "recovery" } });
  assert.deepEqual(scope.chooseSlot(d, facts({ recoveryWallet: d }), none), { slot: "", claim: { owner: d, by: "recovery" } });
});

await test("the rule: notes all naming one wallet go to it; two wallets, or a spendable note naming none, ask", () => {
  assert.deepEqual(scope.chooseSlot(s2, facts({ namedWallets: [d] }), none), { slot: own(s2), claim: { owner: d, by: "notes" } });
  assert.deepEqual(scope.chooseSlot(s2, facts({ namedWallets: [d, s2] }), none), { ask: true });
  assert.deepEqual(scope.chooseSlot(d, facts({ namedWallets: [d], unnamedSpendable: 1 }), none), { ask: true });
  assert.deepEqual(scope.chooseSlot(d, facts({}), none), { ask: true });
  assert.deepEqual(scope.chooseSlot(d, facts({}), { ownHasData: false, declined: true }), { slot: own(d) }, "asked once");
});

await test("the facts: recovery with a version 1 key or a passkey names no wallet", async () => {
  resetBrowser();
  slot.enforceAccountScope(false);
  await newPage();
  localStorage.setItem("gloam.recovery.v1", await vault.sealJson({ source: "wallet", id: "a", write: "b", key: "c", n: 1, savedAt: 1 }));
  assert.equal((await scope.firstAccountFacts()).recoveryWallet, null);
  localStorage.setItem("gloam.recovery.v1", await vault.sealJson({ source: "passkey", id: "a", write: "b", key: "c", n: 1, savedAt: 1 }));
  assert.equal((await scope.firstAccountFacts()).recoveryWallet, null);
  localStorage.setItem(
    "gloam.recovery.v1",
    await vault.sealJson({ source: "wallet", id: "a", write: "b", key: "c", n: 1, savedAt: 1, next: { keys: { wallet: getAddress(DUKE) }, tries: 1, retryAt: 0 } })
  );
  assert.equal((await scope.firstAccountFacts()).recoveryWallet, d, "a version 1 backup moving to Duke's version 2 key");
  slot.enforceAccountScope(true);
});

/* ------------------------------------------------------------ asking */

await test("no evidence: the sign-in is asked, and No leaves the account untouched for its owner", async () => {
  resetBrowser();
  localStorage.setItem("gloam.network", "bnb-mainnet");
  slot.enforceAccountScope(false);
  await newPage();
  await vault.unlockNoteVault();
  await vault.setAllNotes([note("3000000000000000000", undefined)]);
  const tag = (await receive.getOrCreateReceiveIdentity()).tag;
  slot.enforceAccountScope(true);
  await newPage();
  const kept = firstAccountDisk();

  await scope.signInAs(GUEST);
  const asked = scope.accountScopeState();
  assert.equal(asked.phase, "asking");
  assert.equal(asked.tag, tag, "its Gloam address, for the question");
  assert.equal(slot.boundSlot(), null, "nothing bound while it's asked");
  assert.deepEqual(vault.getAllNotes(), []);
  await scope.answerFirstAccount(false);
  assert.equal(scope.accountScopeState().phase, "ready");
  assert.equal(slot.boundSlot(), own(GUEST));
  await vault.unlockNoteVault();
  assert.deepEqual(vault.getAllNotes(), []);
  assert.deepEqual(firstAccountDisk(), kept, "untouched");
  assert.equal(localStorage.getItem(scope.OWNER_KEY), null, "still no owner");

  // asked once: next time it goes straight to its own
  await newPage();
  await scope.signInAs(GUEST);
  assert.equal(scope.accountScopeState().phase, "ready");
  assert.equal(slot.boundSlot(), own(GUEST));

  // the next sign-in is asked, says yes, and it's theirs
  await newPage();
  await scope.signInAs(OTHER);
  assert.equal(scope.accountScopeState().phase, "asking");
  await scope.answerFirstAccount(true);
  assert.equal(slot.boundSlot(), "");
  await vault.unlockNoteVault();
  assert.equal(usdc(shield.loadWalletNotes(OTHER, BNB)), "3");
  const owner = await vault.openJson<{ account: string; by: string }>(localStorage.getItem(scope.OWNER_KEY));
  assert.deepEqual([owner?.account, owner?.by], [OTHER.toLowerCase(), "answer"]);

  // from then on everyone else goes to their own, unasked
  await newPage();
  await scope.signInAs(DUKE);
  assert.equal(scope.accountScopeState().phase, "ready");
  assert.equal(slot.boundSlot(), own(DUKE));
});

await test("signing out while asked binds nothing", async () => {
  resetBrowser();
  localStorage.setItem("gloam.network", "bnb-mainnet");
  slot.enforceAccountScope(false);
  await newPage();
  await vault.unlockNoteVault();
  await vault.setAllNotes([note("1", undefined)]);
  slot.enforceAccountScope(true);
  await newPage();
  await scope.signInAs(GUEST);
  assert.equal(scope.accountScopeState().phase, "asking");
  await scope.signInAs(null);
  await scope.answerFirstAccount(true);
  assert.equal(slot.boundSlot(), null);
  assert.equal(localStorage.getItem(scope.OWNER_KEY), null);
});

await test("notes naming one wallet: that wallet's, decided with no question", async () => {
  resetBrowser();
  localStorage.setItem("gloam.network", "bnb-mainnet");
  slot.enforceAccountScope(false);
  await newPage();
  await vault.unlockNoteVault();
  await vault.setAllNotes([note("2000000000000000000", DUKE), note("1", undefined, { status: "recovered" })]);
  slot.enforceAccountScope(true);
  await newPage();
  await scope.signInAs(GUEST);
  assert.equal(scope.accountScopeState().phase, "ready");
  assert.equal(slot.boundSlot(), own(GUEST));
  await newPage();
  await signIn(DUKE);
  assert.equal(slot.boundSlot(), "");
  assert.equal(usdc(shield.loadWalletNotes(DUKE, BNB)), "2");
});

/* ------------------------------------------------------------ the keys */

await test("the keys the rule reads are the keys the stores write", () => {
  const src = (f: string) => readFileSync(new URL(`../src/lib/${f}`, import.meta.url), "utf8");
  const k = scope.PRIVATE_KEYS;
  assert.equal(k.notes, vault.NOTES_KEY);
  assert.equal(k.receive, receive.ID_KEY);
  assert.equal(k.receivePrevious, receive.PREV_KEY);
  assert.equal(k.recovery, recovery.CONFIG_KEY);
  assert.equal(k.payroll, payrollStore.STORE_KEY);
  assert.equal(k.schedules, schedules.STORE_KEY);
  assert.equal(k.sentLinks, sentLinksStore.STORE_KEY);
  assert.equal(k.contacts, contacts.KEY);
  assert.equal(k.names, names.MINE_KEY);
  assert.ok(src("noteVault.ts").includes(`UNREADABLE_KEY = "${k.notesUnreadable}"`));
  assert.ok(src("payrollStore.ts").includes(`UNREADABLE_KEY = "${k.payrollUnreadable}"`));
  assert.ok(src("sentLinksStore.ts").includes(`UNREADABLE_KEY = "${k.sentLinksUnreadable}"`));
});

await test("the app binds the account on every app page, and Receive shows only the signed-in account's address", () => {
  const read = (f: string) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
  const provider = read("components/app/Web3Provider.tsx");
  assert.ok(provider.indexOf("<AccountScope />") > 0 && provider.indexOf("<AccountScope />") < provider.indexOf("<RecoverySync />"));
  const move = read("components/app/MoveView.tsx");
  assert.match(move, /useWalletState<ReceiveIdentity \| null>\(shownAccount, null\)/, "the address goes on sign out");
  assert.match(move, /if \(!shownAccount\) return;\s*\n\s*void getOrCreateReceiveIdentity\(\)/);
  assert.match(move, /isConnected \? "Opening your private account…" : SIGNED_OUT_BALANCE_MESSAGE/);
  assert.match(read("lib/passkey.ts"), /if \(otherAccountsHere\(\)\) throw/);
});

await test("the wallet keeps switching: past the reload cap the page stays on the old account, and a deposit can't land in it", async () => {
  await newPage();
  sessionStorage.removeItem("gloam.accounts.reloads.v1");
  await signIn(SECOND);
  assert.equal(scope.accountScopeState().phase, "ready");
  const bound = slot.boundSlot();
  const before = vault.getAllNotes().map((n) => n.id).sort();
  // three changes of account in 30 seconds already used this tab's reloads
  const now = Date.now();
  sessionStorage.setItem("gloam.accounts.reloads.v1", JSON.stringify([now, now, now]));
  const at = reloads;
  await scope.signInAs(DUKE);
  const st = scope.accountScopeState();
  assert.equal(st.phase, "leaving", "the page can't reload again yet");
  assert.equal(reloads, at, "and doesn't");
  assert.ok(st.error, "it says so");
  assert.equal(slot.boundSlot(), bound, "still bound to the second wallet's account");
  await assert.rejects(shield.saveLocalNote(note("5000000000000000000", DUKE)), slot.SignedOutError, "Duke's new deposit note is refused");
  assert.deepEqual(vault.getAllNotes().map((n) => n.id).sort(), before, "nothing landed in the second wallet's account");
  const read = (f: string) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
  assert.match(read("components/app/ShieldView.tsx"), /if \(scopeLeaving\) \{\s*\n\s*setFormError/, "Add stops before anything is proven or sent");
  assert.match(read("components/app/BridgeIn.tsx"), /if \(scopeLeaving\) \{\s*\n\s*setPriv/, "and so does bringing money over privately");
  sessionStorage.removeItem("gloam.accounts.reloads.v1");
});

console.log(`selftest-account-scope: ${passed} checks passed`);
