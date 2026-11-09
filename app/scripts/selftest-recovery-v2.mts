/**
 * Self-test: the version 2 wallet message and moving backups onto it
 * (lib/recovery), and a browser that stays honest when a new backup is refused.
 *
 * Security review, 31 Oct 2026. Version 1 of the wallet message is plain text,
 * which no wallet can tie to a site, and backups under it hold real note
 * secrets. Version 2 is a fixed EIP-4361 message. Here:
 *   - version 1 has not moved by a byte, and neither has its key derivation;
 *   - version 2 is exact, valid EIP-4361, and the same forever for one wallet,
 *     wherever the page runs;
 *   - a failure at any step of a move leaves the version 1 backup as it was,
 *     and this browser saving to it;
 *   - wallet prompts are counted, in order, for each kind of user;
 *   - a refused new backup never reads as backed up, and keeps retrying alone;
 *   - a restore asks for version 2 only, and version 1 only on the explicit step;
 *   - a version 1 browser never brings back a backup that has left the server;
 *   - version 1 stops saving at its end date, with nothing deleted, and updating
 *     or opening an older backup works the same after it;
 *   - the server holds that date on its own clock, for a browser with a wrong
 *     clock and a tab on an earlier build, and nobody loses a backup or a note.
 *
 * Uses the real /api/recovery route and store (in-process), and real signatures
 * from a local account. Nothing leaves the process. The server's clock follows
 * the tests' clock unless a test sets it apart with serverClock().
 *
 * Run from app/:  ../mcp/node_modules/.bin/tsx scripts/selftest-recovery-v2.mts
 */
import assert from "node:assert/strict";
import { createHash, hkdfSync } from "node:crypto";
import Module from "node:module";
import { fileURLToPath } from "node:url";
import { keccak256, toHex, type Hex } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { createSiweMessage, parseSiweMessage, validateSiweMessage } from "viem/siwe";
import { localStorage, resetBrowser } from "./browser-shim.mjs";
import type { LocalNote } from "../src/lib/shield";

process.env.GLOAM_PARTNERS_STORE = "memory";
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;
const stub = fileURLToPath(new URL("./server-only-stub.cjs", import.meta.url));
const M = Module as unknown as { _resolveFilename: (req: string, ...rest: unknown[]) => string };
const resolve = M._resolveFilename;
M._resolveFilename = function (req: string, ...rest: unknown[]) {
  return req === "server-only" ? stub : resolve.call(this, req, ...rest);
};

const win = globalThis.window as unknown as Record<string, unknown> & { dispatchEvent: (e: unknown) => boolean };
win.setTimeout = setTimeout;
win.clearTimeout = clearTimeout;

/**
 * The tests keep a clock of their own, a month before the end date unless a test
 * moves it, so they mean the same thing whichever day they run.
 */
const realNow = Date.now.bind(Date);
let clockShift = 0;
const ticking = () => realNow() + clockShift;
Date.now = ticking;
const setClock = (ms: number) => void (clockShift = ms - realNow());

const route = await import("../src/app/api/recovery/route");
const { readBackup, setRecoveryClock, writeBackup } = await import("../src/lib/recoveryStore");
const { kv, resetMemoryKv } = await import("../src/lib/partnersKv");
const { olderKeyText } = await import("../src/components/app/RecoveryPanel");

/** Sets the server's clock apart from this browser's. */
const serverClock = (ms: number) => setRecoveryClock(() => ms);

/* A test can answer any call itself; everything else reaches the real route. */
type Fault = (method: string, id: string) => Response | null | Promise<null>;
let fault: Fault | null = null;
const calls: string[] = [];
/** What each save said about itself. */
const saves: { id: string; v?: unknown; mustExist?: unknown }[] = [];
/** While set, saves go out the way a tab on an earlier build sends them: saying nothing about their key. */
let earlierBuild = false;

globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
  const method = init?.method ?? "GET";
  const full = new URL(String(url), "https://www.gloam.trade");
  let body = init?.body ? String(init.body) : undefined;
  if (method === "PUT" && earlierBuild) {
    const { v: _v, mustExist: _mustExist, ...rest } = JSON.parse(body!) as Record<string, unknown>;
    body = JSON.stringify(rest);
  }
  const id = full.searchParams.get("id") ?? (body ? (JSON.parse(body) as { id: string }).id : "");
  calls.push(`${method} ${id}`);
  if (method === "PUT") saves.push(JSON.parse(body!));
  const forced = await fault?.(method, id);
  if (forced) return forced;
  const req = new Request(full, {
    method,
    body,
    headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.7" },
  });
  return route[method as "GET" | "PUT" | "DELETE"](req);
}) as typeof fetch;

const recovery = await import("../src/lib/recovery");
const vault = await import("../src/lib/noteVault");
const {
  RECOVERY_MESSAGE,
  VERSION1_SAVES_UNTIL,
  backupNow,
  bringInOlderBackup,
  connectRecovery,
  keysFromSecret,
  recoveryMessageV2,
  recoveryState,
  restoreOlderBackup,
  restoreWithWallet,
  startRecoverySync,
  turnOffRecovery,
  turnOnWithWallet,
  updateRecoveryKey,
  walletSecret,
} = recovery;
type Keys = Awaited<ReturnType<typeof keysFromSecret>>;

startRecoverySync();

/** A second copy of the module, which is what a new page or another tab has. */
const openPage = (name: string): Promise<typeof recovery> => import(`../src/lib/recovery?page=${name}`);

const CONFIG_KEY = "gloam.recovery.v1";
const ALICE = privateKeyToAccount(`0x${"11".repeat(32)}`);
const BOB = privateKeyToAccount(`0x${"22".repeat(32)}`);

const DAY = 86_400_000;
const BEFORE_THE_END = VERSION1_SAVES_UNTIL - 30 * DAY;
const AFTER_THE_END = VERSION1_SAVES_UNTIL + DAY;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(ok: () => boolean, what: string, ms = 5_000) {
  const end = Date.now() + ms;
  while (!ok() && Date.now() < end) await sleep(20);
  assert.ok(ok(), what);
}

/** A wallet that signs for real and writes down each prompt. */
function walletOf(account: PrivateKeyAccount) {
  const prompts: string[] = [];
  return {
    address: account.address as string,
    prompts,
    sign: async (message: string): Promise<Hex> => {
      prompts.push(message === RECOVERY_MESSAGE ? "v1" : message === recoveryMessageV2(account.address) ? "v2" : "other");
      return account.signMessage({ message });
    },
  };
}

const keysOf = async (account: PrivateKeyAccount, message: string): Promise<Keys> =>
  keysFromSecret("wallet", walletSecret(await account.signMessage({ message }))!);
const v1Keys = (account: PrivateKeyAccount) => keysOf(account, RECOVERY_MESSAGE);
const v2Keys = (account: PrivateKeyAccount) => keysOf(account, recoveryMessageV2(account.address));

const note = (name: string, from?: string) =>
  ({
    id: `note-${name}`,
    chainId: 4663,
    pool: `0x${"a".repeat(40)}`,
    asset: `0x${"b".repeat(40)}`,
    amountWei: "1000000",
    commitment: keccak256(toHex(`commitment ${name}`)),
    secret: keccak256(toHex(`secret ${name}`)),
    createdAt: 1,
    status: "open",
    source: "local",
    from,
  }) as unknown as LocalNote;

const here = (name: string) => vault.getAllNotes().some((n) => n.id === `note-${name}`);

/** Opens a backup without the app's own code, as a check on it. */
async function backupNotes(keys: Keys): Promise<string[]> {
  const backup = await readBackup(keys.id);
  assert.ok(backup, "a backup is there");
  const raw = Buffer.from(backup.c, "base64");
  const key = await crypto.subtle.importKey("raw", Buffer.from(keys.key, "base64"), "AES-GCM", false, ["decrypt"]);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: raw.subarray(0, 12), additionalData: new TextEncoder().encode(keys.id) },
    key,
    raw.subarray(12),
  );
  return (JSON.parse(new TextDecoder().decode(plain)) as { notes: LocalNote[] }).notes.map((n) => n.id).sort();
}

/** What a browser does when a tab changes the settings: every other tab hears of it. */
async function tellOtherTabs() {
  win.dispatchEvent({ type: "storage", key: CONFIG_KEY });
  await sleep(20);
}

/** A browser with nothing in it, and an empty server. */
async function freshWorld() {
  setClock(BEFORE_THE_END);
  setRecoveryClock(null);
  earlierBuild = false;
  fault = null;
  await turnOffRecovery({ deleteBackup: false });
  await vault.setAllNotes([]);
  resetBrowser();
  await tellOtherTabs();
  resetMemoryKv();
  (globalThis as { __gloamMcpRate?: Map<string, unknown> }).__gloamMcpRate?.clear();
  delete process.env.GLOAM_RECOVERY_NEW_PER_DAY;
  calls.length = 0;
  saves.length = 0;
}

/** Leaves this device behind: same server, a browser with nothing in it. */
async function newDevice() {
  await turnOffRecovery({ deleteBackup: false });
  await vault.setAllNotes([]);
  resetBrowser();
  await tellOtherTabs();
  calls.length = 0;
}

/** A backup as earlier builds saved it, with no marker on the record and nothing in it yet. */
async function earlierBackup(keys: Keys) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey("raw", Buffer.from(keys.key, "base64"), "AES-GCM", false, ["encrypt"]);
  const payload = JSON.stringify({ v: 1, savedAt: 1, notes: [], receive: { current: null, previous: [] } });
  const sealed = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(keys.id) }, key, new TextEncoder().encode(payload));
  await writeBackup({ id: keys.id, write: keys.write, c: Buffer.concat([iv, new Uint8Array(sealed)]).toString("base64"), n: 1 });
}

/** What an older build left behind: a version 1 backup, and these settings in the browser. */
async function version1Browser(account: PrivateKeyAccount, notes: LocalNote[]) {
  await vault.setAllNotes(notes);
  const keys = await v1Keys(account);
  await earlierBackup(keys);
  await connectRecovery(keys, account.address);
  assert.ok(await readBackup(keys.id), "the version 1 backup is saved");
  return keys;
}

/** A version 1 backup whose device is gone. */
async function version1BackupOnly(account: PrivateKeyAccount, notes: LocalNote[]) {
  const keys = await version1Browser(account, notes);
  await newDevice();
  return keys;
}

/** Deletes a backup at the server, the way another device would. */
async function deleteFromServer(keys: Keys) {
  const res = await route.DELETE(
    new Request("https://www.gloam.trade/api/recovery", {
      method: "DELETE",
      headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.8" },
      body: JSON.stringify({ id: keys.id, write: keys.write }),
    }),
  );
  assert.equal(res.status, 200);
}

const refused = (sec: number) =>
  Response.json(
    { ok: false, error: { message: "New backups are paused for today. Try again later. A backup you already have keeps saving." } },
    { status: 429, headers: { "Retry-After": String(sec) } },
  );
const broken = () => Response.json({ ok: false, error: { message: "The backup service failed. Try again." } }, { status: 500 });

/** Spends today's budget for new backups, so the next one is refused for real. */
async function spendBudget() {
  process.env.GLOAM_RECOVERY_NEW_PER_DAY = "1";
  const res = await route.PUT(
    new Request("https://www.gloam.trade/api/recovery", {
      method: "PUT",
      headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.1" },
      body: JSON.stringify({ id: "c".repeat(64), write: "d".repeat(64), c: "AAAA", n: 1, v: 2 }),
    }),
  );
  assert.equal(res.status, 200);
}

const puts = (id?: string) => calls.filter((c) => c.startsWith("PUT") && (!id || c.endsWith(id))).length;
const deletes = (id?: string) => calls.filter((c) => c.startsWith("DELETE") && (!id || c.endsWith(id))).length;

let passed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  await freshWorld();
  await fn();
  passed++;
  console.log(`ok  ${name}`);
}

/* ------------------------------------------------------------ version 1 is frozen */

await test("version 1 has not changed by a byte, and neither has its key derivation", async () => {
  // Taken from main before version 2 existed. Changing either locks people out of real backups.
  assert.equal(
    createHash("sha256").update(RECOVERY_MESSAGE).digest("hex"),
    "88e6ceb624243a1334978e27860e05aeae03951272cd888a281f29db244be535",
  );
  const secret = new Uint8Array(32).fill(7);
  const keys = await keysFromSecret("wallet", secret);
  assert.equal(keys.id, "41c8aa68d96b9697f598de278b744470af389e5a2c9f7f1fd583fc2ac25faaea");
  assert.equal(keys.write, "60047fe1393d6ff62a887146a4e5fbdff83f46eba86af1f3dba629b250ae543b");
  assert.equal(keys.key, "Abwe8W4QiPHwmwukM4COvcPvZpX+5zGcYh+N0sbp7dM=");
  assert.equal(keys.wallet, undefined, "and they don't say a version");
  const again = (info: string) => Buffer.from(hkdfSync("sha256", secret, "gloam/recovery/v1", info, 32)).toString("hex");
  assert.equal(keys.id, again("backup id"), "plain HKDF agrees");
});

/* ------------------------------------------------------------ the version 2 message */

const PINNED = [
  "www.gloam.trade wants you to sign in with your Ethereum account:",
  ALICE.address,
  "",
  "Create the key that backs up and restores your private balance on Gloam. It costs nothing and sends nothing. Anyone with this signature could open your backup, so only sign it on www.gloam.trade.",
  "",
  "URI: https://www.gloam.trade",
  "Version: 1",
  "Chain ID: 1",
  "Nonce: gloamrecovery2",
  "Issued At: 2026-10-31T00:00:00.000Z",
].join("\n");

await test("version 2 is exactly this text", () => {
  assert.equal(recoveryMessageV2(ALICE.address), PINNED);
  assert.equal(ALICE.address, "0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A", "the wallet these pins belong to");
  assert.equal(createHash("sha256").update(recoveryMessageV2(ALICE.address)).digest("hex"), "bb8b6100e6787c3ed808ecf4df83862b9f78ef2987ec49c13de69b163249079a");
});

await test("version 2 is the EIP-4361 text viem writes and valid to its parser", () => {
  const message = recoveryMessageV2(ALICE.address);
  const fields = parseSiweMessage(message);
  assert.equal(
    createSiweMessage({
      domain: fields.domain!,
      address: fields.address!,
      statement: fields.statement,
      uri: fields.uri!,
      version: "1",
      chainId: fields.chainId!,
      nonce: fields.nonce!,
      issuedAt: fields.issuedAt,
    }),
    message,
    "byte for byte",
  );
  assert.equal(fields.domain, "www.gloam.trade");
  assert.equal(new URL(fields.uri!).host, fields.domain, "domain and URI name one host");
  assert.equal(fields.address, ALICE.address);
  assert.equal(fields.version, "1");
  assert.equal(fields.chainId, 1);
  assert.match(fields.nonce!, /^[a-zA-Z0-9]{8,}$/);
  assert.equal(fields.expirationTime, undefined, "it never expires");
  assert.equal(fields.notBefore, undefined);
  // viem's parser is looser than the EIP. This is the grammar's own set of characters.
  assert.match(fields.statement!, /^[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;= ]+$/);
  assert.ok(validateSiweMessage({ message: fields, domain: "www.gloam.trade", address: ALICE.address, time: new Date("2040-01-01") }));
});

await test("the host it names is the host wallets will see, and no other", () => {
  // The check MetaMask-style wallets run: the domain's hostname against the page's, exactly.
  const walletAccepts = (origin: string) =>
    parseSiweMessage(recoveryMessageV2(ALICE.address)).domain!.localeCompare(new URL(origin).hostname, undefined, { sensitivity: "accent" }) === 0;
  assert.ok(walletAccepts("https://www.gloam.trade"), "the site, after gloam.trade redirects to it");
  assert.ok(!walletAccepts("https://gloam.trade"));
  assert.ok(!walletAccepts("https://gloam-trade.example"));
  assert.ok(!walletAccepts("https://www.gloam.trade.example"));
});

await test("one wallet gets one key, wherever the page runs and however its address is written", async () => {
  const lower = recoveryMessageV2(ALICE.address.toLowerCase());
  assert.equal(lower, PINNED, "the address always reads in EIP-55 form");
  const before = win.location;
  win.location = new URL("https://gloam-trade.example/app");
  assert.equal(recoveryMessageV2(ALICE.address), PINNED, "the page's host has no say");
  win.location = before;
  assert.equal((await v2Keys(ALICE)).id, (await v2Keys(ALICE)).id, "a real signature, twice");
  assert.notEqual((await v2Keys(ALICE)).id, (await v2Keys(BOB)).id, "another wallet, another key");
  assert.notEqual((await v2Keys(ALICE)).id, (await v1Keys(ALICE)).id, "and version 2 is not version 1");
});

await test("version 2 keeps the same key for this wallet from here on", async () => {
  // Pinned on first release. If this fails, people's version 2 backups just became unreachable.
  assert.equal(walletSecret(await ALICE.signMessage({ message: PINNED }))!.length, 32);
  assert.equal((await v2Keys(ALICE)).id, "c6f54e80797168ac0a9aa7ab54d35cc5226d92ae8fd11f2d6419d45143118bf5");
});

/* ------------------------------------------------------------ a new person */

await test("turning on: version 2, signed twice, with no version 1 prompt", async () => {
  await vault.setAllNotes([note("a")]);
  const w = walletOf(ALICE);
  assert.equal(await turnOnWithWallet(w), 0);
  assert.deepEqual(w.prompts, ["v2", "v2"]);
  const keys = await v2Keys(ALICE);
  assert.deepEqual(await backupNotes(keys), ["note-a"]);
  assert.equal(await readBackup((await v1Keys(ALICE)).id), null, "nothing goes under version 1");
  const s = recoveryState();
  assert.ok(s.on && s.savedAt && s.newerKey && !s.olderKey);
});

await test("a wallet that signs differently each time can't turn it on", async () => {
  let k = 0;
  const w = { address: ALICE.address as string, sign: async () => `0x${(++k).toString(16).padStart(64, "0")}${"ab".repeat(32)}1b` as Hex };
  await assert.rejects(turnOnWithWallet(w), /signs differently each time/);
  assert.equal(recoveryState().on, false);
  assert.equal(puts(), 0);
});

await test("a smart account's signature can't make a key", async () => {
  const w = { address: ALICE.address as string, sign: async () => `0x${"ab".repeat(100)}` as Hex };
  await assert.rejects(turnOnWithWallet(w), /can't create a recovery key/);
});

await test("passkey recovery is as it was: no wallet version, nothing to update", async () => {
  const keys = await keysFromSecret("passkey", new Uint8Array(32).fill(9));
  await connectRecovery(keys, null);
  const s = recoveryState();
  assert.ok(s.on && s.savedAt);
  assert.ok(!s.olderKey && !s.newerKey && !s.moving);
});

/* ------------------------------------------------------------ restoring */

await test("restore with a version 2 backup: one signature", async () => {
  await vault.setAllNotes([note("a")]);
  await turnOnWithWallet(walletOf(ALICE));
  await newDevice();
  const w = walletOf(ALICE);
  const { added, key } = await restoreWithWallet(w);
  assert.deepEqual(w.prompts, ["v2"]);
  assert.equal(added, 1);
  assert.equal(key, "newest");
  assert.ok(here("a"));
});

await test("the older backup step: opened, moved to version 2, read back, then deleted", async () => {
  const v1 = await version1BackupOnly(ALICE, [note("a"), note("b")]);
  const before = await readBackup(v1.id);
  const w = walletOf(ALICE);
  const { added, key } = await restoreOlderBackup(w);
  assert.deepEqual(w.prompts, ["v1", "v2", "v2"], "version 2 is signed twice before the old backup can go");
  assert.equal(added, 2);
  assert.equal(key, "newest");
  assert.ok(here("a") && here("b"));
  const v2 = await v2Keys(ALICE);
  assert.deepEqual(await backupNotes(v2), ["note-a", "note-b"]);
  assert.equal(await readBackup(v1.id), null, "the old backup is gone");
  assert.ok(before, "it was there");
  assert.equal(puts(v1.id), 0, "and was never written to");
  // read back before the delete
  const order = calls.filter((c) => c.endsWith(v2.id) || c.endsWith(v1.id));
  assert.ok(order.lastIndexOf(`GET ${v2.id}`) > order.lastIndexOf(`PUT ${v2.id}`), "the new copy is read back");
  assert.ok(order.lastIndexOf(`GET ${v2.id}`) < order.indexOf(`DELETE ${v1.id}`), "before the old one is deleted");
  const s = recoveryState();
  assert.ok(s.newerKey && !s.olderKey && !s.moving);
  // a later save goes to the new backup
  await backupNow();
  assert.equal(await readBackup(v1.id), null);
  assert.equal((await readBackup(v2.id))!.n, 2);
});

const notFoundWith = (text: RegExp) => (e: Error & { code?: string }) => e.code === "notfound" && text.test(e.message);

await test("restore with no backup anywhere: one signature, a plain answer, and no version 1 prompt", async () => {
  const w = walletOf(ALICE);
  await assert.rejects(restoreWithWallet(w), notFoundWith(/No backup found for this wallet/));
  assert.deepEqual(w.prompts, ["v2"]);
  assert.equal(recoveryState().on, false);
  assert.equal(puts(), 0);
});

await test("restore with only a version 1 backup there: still one signature, and the backup is left alone", async () => {
  const v1 = await version1BackupOnly(ALICE, [note("a")]);
  const before = await readBackup(v1.id);
  const w = walletOf(ALICE);
  await assert.rejects(restoreWithWallet(w), notFoundWith(/No backup found for this wallet/));
  assert.deepEqual(w.prompts, ["v2"]);
  assert.deepEqual(await readBackup(v1.id), before);
  assert.ok(!here("a"));
  assert.equal(recoveryState().on, false);
});

await test("nothing found, then the person says they have an older backup: that step brings it back", async () => {
  const v1 = await version1BackupOnly(ALICE, [note("a")]);
  const w = walletOf(ALICE);
  await assert.rejects(restoreWithWallet(w), notFoundWith(/No backup found/));
  const { added, key } = await restoreOlderBackup(w);
  assert.deepEqual(w.prompts, ["v2", "v1", "v2", "v2"], "the version 1 prompt comes only with this step");
  assert.equal(added, 1);
  assert.equal(key, "newest");
  assert.ok(here("a"));
  assert.deepEqual(await backupNotes(await v2Keys(ALICE)), ["note-a"]);
  assert.equal(await readBackup(v1.id), null);
});

await test("the older backup step with nothing there: one signature, a plain answer, nothing changed", async () => {
  const w = walletOf(ALICE);
  await assert.rejects(restoreOlderBackup(w), notFoundWith(/No older backup found/));
  assert.deepEqual(w.prompts, ["v1"]);
  assert.equal(recoveryState().on, false);
  assert.equal(puts(), 0);
});

for (const [name, declined, prompts] of [
  ["the second signature is declined", 1, ["v1", "declined"]],
  ["the third signature is declined", 2, ["v1", "v2", "declined"]],
] as const) {
  await test(`the older backup step, then ${name}: the money is back and version 1 still works`, async () => {
    const v1 = await version1BackupOnly(ALICE, [note("a")]);
    const w = walletOf(ALICE);
    const sign = w.sign;
    w.sign = async (m) => {
      if (w.prompts.length === declined) {
        w.prompts.push("declined");
        throw new Error("User rejected the request.");
      }
      return sign(m);
    };
    const { added, key } = await restoreOlderBackup(w);
    assert.deepEqual(w.prompts, prompts);
    assert.equal(added, 1);
    assert.equal(key, "older");
    assert.ok(here("a"));
    assert.ok(await readBackup(v1.id), "version 1 is still there");
    assert.equal(await readBackup((await v2Keys(ALICE)).id), null, "no version 2 was made");
    const s = recoveryState();
    assert.ok(s.on && s.olderKey);
  });
}

await test("the older backup step on a wallet that signs version 2 differently each time: stays on version 1", async () => {
  const v1 = await version1BackupOnly(ALICE, [note("a")]);
  const w = walletOf(ALICE);
  const sign = w.sign;
  w.sign = async (m) => (w.prompts.length === 2 ? (w.prompts.push("v2"), `0x${"cd".repeat(64)}1b` as Hex) : sign(m));
  const { key } = await restoreOlderBackup(w);
  assert.equal(key, "older");
  assert.ok(await readBackup(v1.id));
  assert.equal(await readBackup((await v2Keys(ALICE)).id), null);
});

/* ------------------------------------------------------------ a failure anywhere leaves version 1 intact */

for (const [name, make] of [
  ["the new copy is refused for the day", () => (m: string, id: string, v2: string) => (m === "PUT" && id === v2 ? refused(3600) : null)],
  ["the new copy fails to save", () => (m: string, id: string, v2: string) => (m === "PUT" && id === v2 ? broken() : null)],
  [
    "the new copy doesn't read back",
    () => {
      let saved = false;
      return (m: string, id: string, v2: string) => {
        if (m === "PUT" && id === v2) saved = true;
        return m === "GET" && id === v2 && saved ? Response.json({ ok: false, error: { message: "none" } }, { status: 404 }) : null;
      };
    },
  ],
  [
    "the new copy reads back as junk",
    () => {
      let saved = false;
      return (m: string, id: string, v2: string) => {
        if (m === "PUT" && id === v2) saved = true;
        return m === "GET" && id === v2 && saved ? Response.json({ ok: true, data: { c: "AAAAAAAAAAAAAAAAAAAAAAAAAAAA", n: 1, t: 1 } }) : null;
      };
    },
  ],
] as const) {
  await test(`a move where ${name}: version 1 untouched, nothing deleted, and it keeps working`, async () => {
    const v1 = await version1BackupOnly(ALICE, [note("a")]);
    const before = await readBackup(v1.id);
    const v2 = await v2Keys(ALICE);
    const rule = make();
    fault = (m, id) => rule(m, id, v2.id);
    const w = walletOf(ALICE);
    const { added, key } = await restoreOlderBackup(w);
    assert.equal(added, 1);
    assert.equal(key, "waiting");
    assert.ok(here("a"), "the money is back all the same");
    assert.deepEqual(await readBackup(v1.id), before, "version 1 is byte for byte what it was");
    assert.equal(deletes(), 0, "nothing was deleted");
    assert.equal(puts(v1.id), 0, "nothing was written to it");
    const s = recoveryState();
    assert.ok(s.on && s.olderKey && s.moving && s.savedAt, "this browser stays on version 1, with the move waiting");
    // and it still saves there
    fault = null;
    await vault.setAllNotes([...vault.getAllNotes(), note("later")]);
    await backupNow();
    assert.deepEqual(await backupNotes(v1), ["note-a", "note-later"]);
  });
}

await test("a move that can't carry every note stops short of deleting version 1", async () => {
  // Reads back fine and opens fine, under the right key, but a note is missing.
  await vault.setAllNotes([]);
  const v2 = await v2Keys(ALICE);
  const w0 = walletOf(ALICE);
  await turnOnWithWallet(w0);
  const hollow = await readBackup(v2.id);
  await newDevice();
  await deleteFromServer(v2);
  const v1 = await version1BackupOnly(ALICE, [note("a")]);
  const before = await readBackup(v1.id);
  let saved = false;
  fault = (m, id) => {
    if (m === "PUT" && id === v2.id) saved = true;
    return m === "GET" && id === v2.id && saved ? Response.json({ ok: true, data: hollow }) : null;
  };
  const { key } = await restoreOlderBackup(walletOf(ALICE));
  assert.equal(key, "waiting");
  assert.deepEqual(await readBackup(v1.id), before);
  assert.equal(deletes(), 0);
});

await test("the move refused for the day finishes by itself later, with no wallet prompt", async () => {
  const v1 = await version1BackupOnly(ALICE, [note("a")]);
  const v2 = await v2Keys(ALICE);
  fault = (m, id) => (m === "PUT" && id === v2.id ? refused(1) : null);
  const w = walletOf(ALICE);
  const { key } = await restoreOlderBackup(w);
  assert.equal(key, "waiting");
  assert.deepEqual(w.prompts, ["v1", "v2", "v2"]);
  fault = null;
  await until(() => recoveryState().newerKey, "the move finishes alone once the wait is over");
  assert.deepEqual(w.prompts, ["v1", "v2", "v2"], "with no more prompts");
  assert.deepEqual(await backupNotes(v2), ["note-a"]);
  await until(() => calls.includes(`DELETE ${v1.id}`), "the old backup is deleted");
  assert.equal(await readBackup(v1.id), null);
  assert.ok(!recoveryState().moving);
});

await test("a delete that fails after the move: version 2 is in use, and the delete is tried again", async () => {
  const v1 = await version1BackupOnly(ALICE, [note("a")]);
  fault = (m, id) => (m === "DELETE" && id === v1.id ? broken() : null);
  const { key } = await restoreOlderBackup(walletOf(ALICE));
  assert.equal(key, "newest", "the move itself is done");
  assert.ok(recoveryState().newerKey);
  assert.ok(await readBackup(v1.id), "the old backup is still there for now");
  fault = null;
  await backupNow();
  assert.equal(await readBackup(v1.id), null, "the next sync finishes the delete");
});

await test("the delete is remembered across a page load", async () => {
  const v1 = await version1BackupOnly(ALICE, [note("a")]);
  fault = (m, id) => (m === "DELETE" && id === v1.id ? broken() : null);
  await restoreOlderBackup(walletOf(ALICE));
  const saved = await vault.openJson<{ retire?: { id: string } }>(localStorage.getItem(CONFIG_KEY));
  assert.equal(saved?.retire?.id, v1.id, "it is in the saved settings");
  fault = null;
  calls.length = 0;
  const reloaded = await openPage("delete");
  reloaded.startRecoverySync();
  await until(() => calls.includes(`DELETE ${v1.id}`), "a new page finishes it");
  await sleep(50);
  assert.equal(await readBackup(v1.id), null);
  const after = await vault.openJson<{ retire?: unknown }>(localStorage.getItem(CONFIG_KEY));
  assert.equal(after?.retire, undefined, "and forgets it");
  await reloaded.turnOffRecovery({ deleteBackup: false });
});

/* ------------------------------------------------------------ a browser with version 1 on */

await test("settings from before version 2 keep working and keep saving, with no prompt", async () => {
  const v1 = await version1Browser(ALICE, [note("a")]);
  const saved = await vault.openJson<Record<string, unknown>>(localStorage.getItem(CONFIG_KEY));
  assert.deepEqual(Object.keys(saved!).sort(), ["id", "key", "n", "savedAt", "source", "write"], "exactly what older builds saved");
  await vault.setAllNotes([...vault.getAllNotes(), note("b")]);
  await backupNow();
  assert.deepEqual(await backupNotes(v1), ["note-a", "note-b"]);
  const s = recoveryState();
  assert.ok(s.on && s.olderKey && !s.newerKey && !s.moving);
});

await test("updating: one version 1 signature, two version 2, then the backup moves and saves there", async () => {
  const v1 = await version1Browser(ALICE, [note("a")]);
  const w = walletOf(ALICE);
  assert.equal(await updateRecoveryKey(w), "newest");
  assert.deepEqual(w.prompts, ["v1", "v2", "v2"]);
  const v2 = await v2Keys(ALICE);
  assert.deepEqual(await backupNotes(v2), ["note-a"]);
  assert.equal(await readBackup(v1.id), null);
  await vault.setAllNotes([...vault.getAllNotes(), note("b")]);
  await backupNow();
  assert.deepEqual(await backupNotes(v2), ["note-a", "note-b"]);
  assert.equal(await readBackup(v1.id), null, "the old backup stays gone");
});

await test("updating with a different wallet connected stops at the first signature", async () => {
  const v1 = await version1Browser(ALICE, [note("a")]);
  const before = await readBackup(v1.id);
  const w = walletOf(BOB);
  await assert.rejects(updateRecoveryKey(w), /isn't the wallet recovery was turned on with/);
  assert.deepEqual(w.prompts, ["v1"], "no more prompts");
  assert.deepEqual(await readBackup(v1.id), before);
  assert.equal(await readBackup((await v2Keys(BOB)).id), null, "the backup did not move to that wallet");
  assert.ok(recoveryState().olderKey);
});

await test("updating on a wallet that signs version 2 differently each time changes nothing", async () => {
  const v1 = await version1Browser(ALICE, [note("a")]);
  const before = await readBackup(v1.id);
  const w = walletOf(ALICE);
  const sign = w.sign;
  w.sign = async (m) => (w.prompts.length === 2 ? (w.prompts.push("v2"), `0x${"cd".repeat(64)}1b` as Hex) : sign(m));
  await assert.rejects(updateRecoveryKey(w), /signs differently each time/);
  assert.deepEqual(await readBackup(v1.id), before);
  assert.ok(recoveryState().olderKey && !recoveryState().moving);
});

await test("updating when new backups are refused: keeps saving to version 1, and finishes alone", async () => {
  const v1 = await version1Browser(ALICE, [note("a")]);
  const v2 = await v2Keys(ALICE);
  fault = (m, id) => (m === "PUT" && id === v2.id ? refused(1) : null);
  const w = walletOf(ALICE);
  assert.equal(await updateRecoveryKey(w), "waiting");
  assert.ok(recoveryState().moving && recoveryState().olderKey);
  assert.ok(await readBackup(v1.id));
  fault = null;
  await until(() => recoveryState().newerKey, "it finishes");
  assert.equal(w.prompts.length, 3, "no more prompts");
  await sleep(50);
  assert.equal(await readBackup(v1.id), null);
});

await test("a version 2 backup already there is merged, not replaced", async () => {
  // Another device turned on version 2 for this wallet.
  await vault.setAllNotes([note("newer-device")]);
  await turnOnWithWallet(walletOf(ALICE));
  await newDevice();
  const v1 = await version1Browser(ALICE, [note("old-device")]);
  assert.equal(await updateRecoveryKey(walletOf(ALICE)), "newest");
  assert.deepEqual(await backupNotes(await v2Keys(ALICE)), ["note-newer-device", "note-old-device"]);
  assert.equal(await readBackup(v1.id), null);
});

await test("two devices on version 1: one moves, the other writes nothing, says so, and joins up", async () => {
  // Device Y has moved, so the version 1 backup is gone. Device X's settings still point at it.
  const v1 = await version1BackupOnly(ALICE, [note("x")]);
  await restoreOlderBackup(walletOf(ALICE));
  assert.equal(await readBackup(v1.id), null);
  const v2 = await v2Keys(ALICE);
  await newDevice();

  const stale = await openPage("device-x");
  stale.startRecoverySync();
  await vault.setAllNotes([note("x"), note("only-on-x")]);
  await earlierBackup(v1);
  await stale.connectRecovery(v1, ALICE.address);
  assert.equal(stale.recoveryState().gone, false);
  await deleteFromServer(v1); // device Y moved it again, while X was away
  await assert.rejects(stale.backupNow(), /stopped saving/, "Back up now can't claim a save");
  assert.equal(await readBackup(v1.id), null, "the backup is not brought back");
  assert.equal(stale.recoveryState().gone, true, "and it says this backup isn't where it was");
  assert.ok(here("x") && here("only-on-x"), "nothing is lost: it all stays here");

  assert.equal(await stale.updateRecoveryKey(walletOf(ALICE)), "newest");
  assert.deepEqual(await backupNotes(v2), ["note-only-on-x", "note-x"], "one backup again, with both");
  assert.equal(await readBackup(v1.id), null);
  await stale.turnOffRecovery({ deleteBackup: false });
});

await test("a backup that left the server: a change writes nothing, tries once, and it stays that way after a reload", async () => {
  const v1 = await version1Browser(ALICE, [note("a")]);
  await deleteFromServer(v1);
  calls.length = 0;
  await vault.setAllNotes([...vault.getAllNotes(), note("b")]);
  await until(() => recoveryState().gone, "the next save finds it gone");
  assert.equal(await readBackup(v1.id), null, "nothing was written");
  assert.equal(puts(v1.id), 1);
  const s = recoveryState();
  assert.ok(s.on && s.olderKey && s.paused, "it says so");
  assert.equal(s.error, null, "this is a state to show, not a failed save");

  await vault.setAllNotes([...vault.getAllNotes(), note("c")]);
  await sleep(2_700);
  assert.equal(puts(v1.id), 1, "a browser that knows it is gone doesn't ask again");

  const page = await openPage("gone-reload");
  page.startRecoverySync();
  await until(() => page.recoveryState().ready, "a new page has read the settings");
  assert.ok(page.recoveryState().gone && page.recoveryState().paused, "a new page knows too");
  await sleep(2_700);
  assert.equal(puts(v1.id), 1);
  assert.equal(await readBackup(v1.id), null);
  await page.turnOffRecovery({ deleteBackup: false });
});

await test("a browser that never saved makes no version 1 backup before the end date either, and says so", async () => {
  // Older builds left on, savedAt null: the server starts no new version 1 backup, at any date.
  const v1 = await v1Keys(ALICE);
  await vault.setAllNotes([note("a")]);
  localStorage.setItem(CONFIG_KEY, await vault.sealJson({ ...v1, n: 0, savedAt: null }));
  const page = await openPage("never-saved-early");
  page.startRecoverySync();
  await until(() => page.recoveryState().ready, "a new page has read the settings");
  await vault.setAllNotes([...vault.getAllNotes(), note("b")]);
  await sleep(2_700);
  assert.equal(puts(), 0, "it doesn't try");
  assert.equal(await readBackup(v1.id), null);
  const s = page.recoveryState();
  assert.ok(s.on && s.olderKey && s.paused && !s.gone && !s.savedAt, "paused, and not called moved");
  assert.equal(s.error, null);
  assert.match(olderKeyText(s), /hasn't saved a backup yet/);
  assert.doesNotMatch(olderKeyText(s), /Another device|moved|removed|stopped on/);
  await assert.rejects(page.backupNow(), /stopped saving/, "Back up now can't claim a save");

  // connecting those keys directly starts nothing either
  await page.turnOffRecovery({ deleteBackup: false });
  await connectRecovery(v1, ALICE.address);
  assert.ok(recoveryState().paused);
  assert.equal(puts(), 0);
  assert.equal(await readBackup(v1.id), null);

  assert.equal(await updateRecoveryKey(walletOf(ALICE)), "newest", "updating is the way on");
  assert.deepEqual(await backupNotes(await v2Keys(ALICE)), ["note-a", "note-b"], "with everything in it");
  assert.ok(!recoveryState().paused && recoveryState().newerKey);
});

await test("a browser that never saved, with a backup from another device under the same key: updating takes it in", async () => {
  const v1 = await version1BackupOnly(ALICE, [note("elsewhere")]);
  await vault.setAllNotes([note("here")]);
  localStorage.setItem(CONFIG_KEY, await vault.sealJson({ ...v1, n: 0, savedAt: null }));
  const page = await openPage("never-saved-with-backup");
  page.startRecoverySync();
  await until(() => page.recoveryState().ready, "a new page has read the settings");
  assert.equal(await page.updateRecoveryKey(walletOf(ALICE)), "newest");
  assert.deepEqual(await backupNotes(await v2Keys(ALICE)), ["note-elsewhere", "note-here"]);
  assert.equal(await readBackup(v1.id), null);
  await page.turnOffRecovery({ deleteBackup: false });
});

await test("settings an earlier build marked gone: a browser that never saved isn't told a backup moved", async () => {
  const v1 = await v1Keys(ALICE);
  localStorage.setItem(CONFIG_KEY, await vault.sealJson({ ...v1, n: 0, savedAt: null, gone: true }));
  const page = await openPage("never-saved-gone");
  page.startRecoverySync();
  await until(() => page.recoveryState().ready, "a new page has read the settings");
  const s = page.recoveryState();
  assert.ok(s.paused && !s.gone);
  assert.match(olderKeyText(s), /hasn't saved a backup yet/);
  await page.turnOffRecovery({ deleteBackup: false });
});

await test("a second tab follows a move instead of saving to the old backup", async () => {
  const v1 = await version1Browser(ALICE, [note("a")]);
  const other = await openPage("tab-b");
  other.startRecoverySync();
  await until(() => other.recoveryState().ready, "the other tab has read the settings");
  assert.ok(other.recoveryState().olderKey);
  await updateRecoveryKey(walletOf(ALICE));
  win.dispatchEvent({ type: "storage", key: CONFIG_KEY });
  await until(() => other.recoveryState().newerKey, "the other tab sees the new settings");
  await other.backupNow();
  assert.equal(await readBackup(v1.id), null, "version 1 did not come back");
  assert.ok(recoveryState().newerKey, "and the settings were not put back");
  await other.turnOffRecovery({ deleteBackup: false });
});

await test("turning off and deleting takes every copy, the one still moving too", async () => {
  const v1 = await version1Browser(ALICE, [note("a")]);
  const v2 = await v2Keys(ALICE);
  let reads = 0;
  // the new copy lands, but its read-back fails: both copies now exist
  fault = (m, id) => (m === "GET" && id === v2.id && ++reads === 2 ? Response.json({ ok: false }, { status: 404 }) : null);
  assert.equal(await updateRecoveryKey(walletOf(ALICE)), "waiting");
  assert.ok(await readBackup(v1.id));
  assert.ok(await readBackup(v2.id));
  fault = null;
  await turnOffRecovery({ deleteBackup: true });
  assert.equal(await readBackup(v1.id), null);
  assert.equal(await readBackup(v2.id), null);
  assert.equal(recoveryState().on, false);
});

await test("turning off and deleting while a move is running: it waits, and no copy is left behind", async () => {
  const v1 = await version1Browser(ALICE, [note("a")]);
  const v2 = await v2Keys(ALICE);
  let release!: () => void;
  const held = new Promise<null>((r) => (release = () => r(null)));
  let reachedPut = false;
  fault = (m, id) => {
    if (m !== "PUT" || id !== v2.id) return null;
    reachedPut = true;
    return held;
  };
  const moving = updateRecoveryKey(walletOf(ALICE));
  await until(() => reachedPut, "the move has reached the new copy");
  const off = turnOffRecovery({ deleteBackup: true });
  await sleep(50);
  assert.ok(await readBackup(v1.id), "turning off waits for the move");
  release();
  assert.equal(await moving, "waiting");
  await off;
  assert.equal(await readBackup(v1.id), null);
  assert.equal(await readBackup(v2.id), null, "the new copy goes too");
  assert.equal(recoveryState().on, false);
  assert.equal(localStorage.getItem(CONFIG_KEY), null);
});

/* ------------------------------------------------------------ the end date */

await test("the end date is 1 December 2026, 00:00 UTC", () => {
  assert.equal(new Date(VERSION1_SAVES_UNTIL).toISOString(), "2026-12-01T00:00:00.000Z");
});

await test("before the end date: a version 1 browser is told to update, and keeps saving", async () => {
  setClock(VERSION1_SAVES_UNTIL - 60_000);
  const v1 = await version1Browser(ALICE, [note("a")]);
  const s = recoveryState();
  assert.ok(s.on && s.olderKey && !s.paused && !s.gone, "the prompt to update, with backups still running");
  await vault.setAllNotes([...vault.getAllNotes(), note("b")]);
  await backupNow();
  assert.deepEqual(await backupNotes(v1), ["note-a", "note-b"]);
});

await test("after the end date: a version 1 browser stops saving, says so, and nothing is deleted", async () => {
  const v1 = await version1Browser(ALICE, [note("a")]);
  const before = await readBackup(v1.id);
  setClock(AFTER_THE_END);
  calls.length = 0;
  await vault.setAllNotes([...vault.getAllNotes(), note("b")]);
  await sleep(2_700);
  assert.equal(puts(), 0, "a change saves nothing");
  assert.ok(recoveryState().paused, "and an open page finds out");
  await assert.rejects(backupNow(), /stopped saving/, "Back up now can't claim a save");
  assert.equal(puts(), 0);
  assert.deepEqual(await readBackup(v1.id), before, "the backup stays as it was");
  assert.equal(deletes(), 0);
  assert.ok(here("a") && here("b"), "and everything stays here");
  const s = recoveryState();
  assert.ok(s.on && s.olderKey && s.paused && !s.gone);

  const page = await openPage("past-the-end");
  page.startRecoverySync();
  await until(() => page.recoveryState().ready, "a new page has read the settings");
  assert.ok(page.recoveryState().paused, "a new page says so from the start");
  await page.turnOffRecovery({ deleteBackup: false });
});

await test("the end date holds from its first moment", async () => {
  const v1 = await version1Browser(ALICE, [note("a")]);
  Date.now = () => VERSION1_SAVES_UNTIL;
  try {
    await assert.rejects(backupNow(), /stopped saving/);
  } finally {
    Date.now = ticking;
  }
  assert.equal(puts(v1.id), 1, "only the save from before");
});

await test("after the end date: a browser that never saved makes no version 1 backup", async () => {
  const v1 = await v1Keys(ALICE);
  await vault.setAllNotes([note("a")]);
  setClock(AFTER_THE_END);
  localStorage.setItem(CONFIG_KEY, await vault.sealJson({ ...v1, n: 0, savedAt: null }));
  const page = await openPage("never-saved");
  page.startRecoverySync();
  await until(() => page.recoveryState().ready, "a new page has read the settings");
  await sleep(2_700);
  assert.ok(page.recoveryState().paused);
  assert.equal(puts(), 0);
  assert.equal(await readBackup(v1.id), null);
  await page.turnOffRecovery({ deleteBackup: false });

  // and connecting those keys directly saves nothing either
  await connectRecovery(v1, ALICE.address);
  assert.ok(recoveryState().paused);
  assert.equal(puts(), 0);
  assert.equal(await readBackup(v1.id), null);
});

await test("after the end date: a wait left from before it doesn't keep waking the page", async () => {
  const v1 = await version1Browser(ALICE, [note("a")]);
  const saved = await vault.openJson<Record<string, unknown>>(localStorage.getItem(CONFIG_KEY));
  localStorage.setItem(CONFIG_KEY, await vault.sealJson({ ...saved, retryAt: Date.now() - 1_000 }));
  setClock(AFTER_THE_END);
  let timers = 0;
  win.setTimeout = ((fn: () => void, ms: number) => (timers++, setTimeout(fn, ms))) as unknown;
  try {
    const page = await openPage("old-wait");
    page.startRecoverySync();
    await until(() => page.recoveryState().ready, "a new page has read the settings");
    await sleep(300);
    assert.ok(timers < 4, `no retry loop (${timers} timers)`);
    assert.equal(puts(v1.id), 1, "only the save from before");
    await page.turnOffRecovery({ deleteBackup: false });
  } finally {
    win.setTimeout = setTimeout;
  }
});

await test("after the end date: updating works, and everything since the last save comes across", async () => {
  const v1 = await version1Browser(ALICE, [note("a")]);
  setClock(AFTER_THE_END);
  await vault.setAllNotes([...vault.getAllNotes(), note("b")]);
  const w = walletOf(ALICE);
  assert.equal(await updateRecoveryKey(w), "newest");
  assert.deepEqual(w.prompts, ["v1", "v2", "v2"]);
  const v2 = await v2Keys(ALICE);
  assert.deepEqual(await backupNotes(v2), ["note-a", "note-b"]);
  assert.equal(await readBackup(v1.id), null, "moved, so the old copy goes as it always has");
  const s = recoveryState();
  assert.ok(s.newerKey && !s.olderKey && !s.paused, "backups are back on");
  await vault.setAllNotes([...vault.getAllNotes(), note("c")]);
  await backupNow();
  assert.deepEqual(await backupNotes(v2), ["note-a", "note-b", "note-c"]);
});

await test("after the end date: a browser whose backup left the server updates and joins up", async () => {
  const v1 = await version1Browser(ALICE, [note("a")]);
  await deleteFromServer(v1);
  setClock(AFTER_THE_END);
  assert.equal(await updateRecoveryKey(walletOf(ALICE)), "newest");
  assert.deepEqual(await backupNotes(await v2Keys(ALICE)), ["note-a"]);
  assert.ok(!recoveryState().gone && !recoveryState().paused);
});

await test("after the end date: a move refused for the day waits, then finishes alone", async () => {
  const v1 = await version1Browser(ALICE, [note("a")]);
  setClock(AFTER_THE_END);
  const v2 = await v2Keys(ALICE);
  fault = (m, id) => (m === "PUT" && id === v2.id ? refused(1) : null);
  const saves = puts(v1.id);
  assert.equal(await updateRecoveryKey(walletOf(ALICE)), "waiting");
  assert.ok(recoveryState().moving && recoveryState().paused, "still paused while it waits");
  await assert.rejects(backupNow(), /stopped saving/);
  fault = null;
  await until(() => recoveryState().newerKey, "it finishes");
  assert.equal(puts(v1.id), saves, "and never wrote to the old backup");
  assert.deepEqual(await backupNotes(v2), ["note-a"]);
});

await test("a move that was waiting when the end date passed still finishes", async () => {
  const v1 = await version1Browser(ALICE, [note("a")]);
  const v2 = await v2Keys(ALICE);
  fault = (m, id) => (m === "PUT" && id === v2.id ? refused(1) : null);
  assert.equal(await updateRecoveryKey(walletOf(ALICE)), "waiting");
  setClock(AFTER_THE_END);
  fault = null;
  await until(() => recoveryState().newerKey, "it finishes");
  assert.deepEqual(await backupNotes(v2), ["note-a"]);
  await sleep(50);
  assert.equal(await readBackup(v1.id), null);
});

await test("after the end date: the older backup step still opens and moves a version 1 backup", async () => {
  const v1 = await version1BackupOnly(ALICE, [note("a")]);
  setClock(AFTER_THE_END);
  const w = walletOf(ALICE);
  await assert.rejects(restoreWithWallet(w), notFoundWith(/No backup found/));
  const { added, key } = await restoreOlderBackup(w);
  assert.deepEqual(w.prompts, ["v2", "v1", "v2", "v2"]);
  assert.equal(added, 1);
  assert.equal(key, "newest");
  assert.ok(here("a"));
  assert.deepEqual(await backupNotes(await v2Keys(ALICE)), ["note-a"]);
  assert.equal(await readBackup(v1.id), null);
});

await test("after the end date: the older backup step with version 2 declined gives the money back, then stays paused", async () => {
  const v1 = await version1BackupOnly(ALICE, [note("a")]);
  const before = await readBackup(v1.id);
  setClock(AFTER_THE_END);
  const w = walletOf(ALICE);
  const sign = w.sign;
  w.sign = async (m) => {
    if (w.prompts.length === 1) throw new Error("User rejected the request.");
    return sign(m);
  };
  const { added, key } = await restoreOlderBackup(w);
  assert.equal(added, 1);
  assert.equal(key, "older");
  assert.ok(here("a"));
  assert.ok(recoveryState().paused);
  await sleep(2_700);
  assert.deepEqual(await readBackup(v1.id), before, "nothing is written and nothing is deleted");
  assert.equal(puts(v1.id), 0);
});

await test("after the end date: bringing in an older backup still works", async () => {
  const v1 = await version1BackupOnly(ALICE, [note("elsewhere")]);
  await vault.setAllNotes([note("here")]);
  setClock(AFTER_THE_END);
  await turnOnWithWallet(walletOf(ALICE));
  assert.equal(await bringInOlderBackup(walletOf(ALICE)), 1);
  assert.deepEqual(await backupNotes(await v2Keys(ALICE)), ["note-elsewhere", "note-here"]);
  assert.equal(await readBackup(v1.id), null);
});

await test("after the end date: version 2 and passkeys save as ever", async () => {
  setClock(AFTER_THE_END);
  await vault.setAllNotes([note("a")]);
  await turnOnWithWallet(walletOf(ALICE));
  const v2 = await v2Keys(ALICE);
  assert.ok(!recoveryState().paused);
  await vault.setAllNotes([...vault.getAllNotes(), note("b")]);
  await backupNow();
  assert.deepEqual(await backupNotes(v2), ["note-a", "note-b"]);
  await turnOffRecovery({ deleteBackup: false });

  const keys = await keysFromSecret("passkey", new Uint8Array(32).fill(9));
  await connectRecovery(keys, null);
  assert.ok(!recoveryState().paused);
  await vault.setAllNotes([...vault.getAllNotes(), note("c")]);
  await backupNow();
  assert.deepEqual(await backupNotes(keys), ["note-a", "note-b", "note-c"]);
});

/* ------------------------------------------------------------ the end date on the server's clock */

const lastSave = (id: string) => saves.filter((s) => s.id === id).at(-1);
const marker = async (id: string) => (JSON.parse(String((await kv([["GET", `gloam:recovery:v1:${id}`]]))[0])) as { v?: number }).v;

await test("every save says which key it is under: version 2 and passkeys do, version 1 never does", async () => {
  await vault.setAllNotes([note("a")]);
  await turnOnWithWallet(walletOf(ALICE));
  const v2 = await v2Keys(ALICE);
  assert.deepEqual(saves.map(({ v, mustExist }) => ({ v, mustExist })), [{ v: 2, mustExist: undefined }]);
  await turnOffRecovery({ deleteBackup: false });

  const passkey = await keysFromSecret("passkey", new Uint8Array(32).fill(9));
  await connectRecovery(passkey, null);
  assert.equal(lastSave(passkey.id)?.v, 2);
  await turnOffRecovery({ deleteBackup: false });
  await newDevice();

  const v1 = await version1Browser(BOB, [note("b")]);
  assert.equal(lastSave(v1.id)?.v, undefined);
  assert.equal(lastSave(v1.id)?.mustExist, true, "and must find a backup there");
  assert.equal(await marker(v1.id), undefined, "so its record has no marker");

  await updateRecoveryKey(walletOf(BOB));
  const moved = await v2Keys(BOB);
  assert.equal(lastSave(moved.id)?.v, 2, "the copy a move makes is a newer key's save");
  assert.equal(await marker(moved.id), 2);
  assert.equal(await marker(v2.id), 2);
});

await test("a first-time user on the current build: fine on either side of the end date, by wallet or passkey", async () => {
  for (const when of [BEFORE_THE_END, AFTER_THE_END]) {
    await newDevice();
    resetMemoryKv();
    setClock(when);
    await vault.setAllNotes([note("a")]);
    assert.equal(await turnOnWithWallet(walletOf(ALICE)), 0);
    assert.deepEqual(await backupNotes(await v2Keys(ALICE)), ["note-a"]);
    await turnOffRecovery({ deleteBackup: false });
    const passkey = await keysFromSecret("passkey", new Uint8Array(32).fill(9));
    await connectRecovery(passkey, null);
    assert.deepEqual(await backupNotes(passkey), ["note-a"]);
    assert.ok(recoveryState().savedAt && !recoveryState().paused);
  }
});

await test("a slow clock, past the end date: the server refuses, nothing is written, and it reads as paused", async () => {
  const v1 = await version1Browser(ALICE, [note("a")]);
  const before = await readBackup(v1.id);
  serverClock(AFTER_THE_END); // this browser still thinks it is a month earlier
  await vault.setAllNotes([...vault.getAllNotes(), note("b")]);
  await assert.rejects(backupNow(), /stopped saving/, "Back up now can't claim a save");
  assert.deepEqual(await readBackup(v1.id), before, "the backup stays as it was");
  assert.equal(deletes(), 0);
  assert.ok(here("a") && here("b"), "and everything stays here");
  const s = recoveryState();
  assert.ok(s.on && s.olderKey && s.paused && !s.gone, "paused, not called gone: the backup is still there");
  assert.equal(s.error, null, "a state to show, not a failed save");
  assert.match(olderKeyText(s), /stopped on 1 December 2026/);

  const sent = puts(v1.id);
  await vault.setAllNotes([...vault.getAllNotes(), note("c")]);
  await sleep(2_700);
  assert.equal(puts(v1.id), sent, "it doesn't ask again");

  const page = await openPage("slow-clock");
  page.startRecoverySync();
  await until(() => page.recoveryState().ready, "a new page has read the settings");
  assert.ok(page.recoveryState().paused, "a new page knows too, whatever its clock says");
  await page.turnOffRecovery({ deleteBackup: false });
  await connectRecovery(v1, ALICE.address, { save: false });

  const w = walletOf(ALICE);
  assert.equal(await updateRecoveryKey(w), "newest", "updating works");
  assert.deepEqual(await backupNotes(await v2Keys(ALICE)), ["note-a", "note-b", "note-c"], "and nothing was dropped");
  assert.equal(await readBackup(v1.id), null);
  assert.ok(recoveryState().newerKey && !recoveryState().paused);
});

await test("a slow clock, past the end date: the older backup step still restores and moves it", async () => {
  const v1 = await version1BackupOnly(ALICE, [note("a")]);
  serverClock(AFTER_THE_END);
  const { added, key } = await restoreOlderBackup(walletOf(ALICE));
  assert.equal(added, 1);
  assert.equal(key, "newest");
  assert.deepEqual(await backupNotes(await v2Keys(ALICE)), ["note-a"]);
  assert.equal(await readBackup(v1.id), null);
});

await test("a slow clock with the wallet declining version 2: the money is back, and the server keeps the backup as it was", async () => {
  const v1 = await version1BackupOnly(ALICE, [note("a")]);
  const before = await readBackup(v1.id);
  serverClock(AFTER_THE_END);
  const w = walletOf(ALICE);
  const sign = w.sign;
  w.sign = async (m) => {
    if (w.prompts.length === 1) throw new Error("User rejected the request.");
    return sign(m);
  };
  const { added, key } = await restoreOlderBackup(w);
  assert.equal(added, 1);
  assert.equal(key, "older");
  assert.ok(here("a"));
  await until(() => recoveryState().paused, "the first save finds out");
  assert.deepEqual(await readBackup(v1.id), before);
  assert.ok(!recoveryState().gone);
});

await test("a fast clock, before the end date: paused early here, nothing lost, and updating works", async () => {
  const v1 = await version1Browser(ALICE, [note("a")]);
  setClock(AFTER_THE_END);
  serverClock(BEFORE_THE_END);
  await vault.setAllNotes([...vault.getAllNotes(), note("b")]);
  await assert.rejects(backupNow(), /stopped saving/);
  assert.ok(await readBackup(v1.id), "nothing left the server");
  assert.equal(await updateRecoveryKey(walletOf(ALICE)), "newest");
  assert.deepEqual(await backupNotes(await v2Keys(ALICE)), ["note-a", "note-b"]);
});

await test("a wrong clock changes nothing on version 2 or a passkey", async () => {
  for (const [browser, server] of [
    [BEFORE_THE_END, AFTER_THE_END],
    [AFTER_THE_END, BEFORE_THE_END],
  ] as const) {
    await newDevice();
    resetMemoryKv();
    setClock(browser);
    serverClock(server);
    await vault.setAllNotes([note("a")]);
    await turnOnWithWallet(walletOf(ALICE));
    await vault.setAllNotes([...vault.getAllNotes(), note("b")]);
    await backupNow();
    assert.deepEqual(await backupNotes(await v2Keys(ALICE)), ["note-a", "note-b"]);
    await turnOffRecovery({ deleteBackup: false });
    const passkey = await keysFromSecret("passkey", new Uint8Array(32).fill(9));
    await connectRecovery(passkey, null);
    await vault.setAllNotes([...vault.getAllNotes(), note("c")]);
    await backupNow();
    assert.deepEqual(await backupNotes(passkey), ["note-a", "note-b", "note-c"]);
  }
});

await test("mid-move past the end date on the server's clock: it finishes, and the old backup is never written to", async () => {
  const v1 = await version1Browser(ALICE, [note("a")]);
  const v2 = await v2Keys(ALICE);
  fault = (m, id) => (m === "PUT" && id === v2.id ? refused(1) : null);
  assert.equal(await updateRecoveryKey(walletOf(ALICE)), "waiting");
  serverClock(AFTER_THE_END);
  const sent = puts(v1.id);
  fault = null;
  await until(() => recoveryState().newerKey, "it finishes");
  assert.equal(puts(v1.id), sent);
  assert.deepEqual(await backupNotes(v2), ["note-a"]);
  await sleep(50);
  assert.equal(await readBackup(v1.id), null, "moved, so the old copy goes as it always has");
});

await test("a backup from before the marker, past the end date: its next save from a current browser works and marks it", async () => {
  const v2 = await v2Keys(ALICE);
  await earlierBackup(v2);
  assert.equal(await marker(v2.id), undefined);
  setClock(AFTER_THE_END);
  await vault.setAllNotes([note("a")]);
  await restoreWithWallet(walletOf(ALICE));
  assert.deepEqual(await backupNotes(v2), ["note-a"]);
  assert.equal(await marker(v2.id), 2);

  await turnOffRecovery({ deleteBackup: false });
  const passkey = await keysFromSecret("passkey", new Uint8Array(32).fill(9));
  await earlierBackup(passkey);
  await connectRecovery(passkey, null, { mustExist: true });
  assert.equal(await marker(passkey.id), 2, "the same for a passkey");
});

await test("a second device on an earlier build: it saves until the end date, then waits, and nothing is lost", async () => {
  await vault.setAllNotes([note("a")]);
  await turnOnWithWallet(walletOf(ALICE));
  const v2 = await v2Keys(ALICE);
  earlierBuild = true;
  await vault.setAllNotes([...vault.getAllNotes(), note("b")]);
  await backupNow();
  assert.deepEqual(await backupNotes(v2), ["note-a", "note-b"], "before the date it saves as it did");
  assert.equal(await marker(v2.id), 2, "and doesn't take the marker off");

  setClock(AFTER_THE_END);
  const before = await readBackup(v2.id);
  await vault.setAllNotes([...vault.getAllNotes(), note("c")]);
  await backupNow();
  assert.deepEqual(await readBackup(v2.id), before, "after the date it writes nothing");
  assert.ok(here("a") && here("b") && here("c"), "and keeps it all here");

  earlierBuild = false; // the tab reloads, onto the current build
  const page = await openPage("second-device");
  page.startRecoverySync();
  await until(() => saves.at(-1)?.v === 2, "the new page saves what the old tab couldn't");
  await until(() => page.recoveryState().ready, "a new page has read the settings");
  assert.ok(!page.recoveryState().gone && !page.recoveryState().paused, "and says nothing is wrong");
  await sleep(100);
  assert.deepEqual(await backupNotes(v2), ["note-a", "note-b", "note-c"]);
  await page.turnOffRecovery({ deleteBackup: false });
});

await test("a first-time user on an earlier build: nothing is made, and the next page load saves it", async () => {
  earlierBuild = true;
  await vault.setAllNotes([note("a")]);
  await turnOnWithWallet(walletOf(ALICE));
  const v2 = await v2Keys(ALICE);
  assert.equal(await readBackup(v2.id), null);
  assert.equal(recoveryState().savedAt, null, "nothing says it is backed up");

  earlierBuild = false;
  const page = await openPage("first-time-earlier");
  page.startRecoverySync();
  await until(() => Boolean(page.recoveryState().savedAt), "it saved on load, with nobody asking");
  assert.deepEqual(await backupNotes(v2), ["note-a"]);
  await page.turnOffRecovery({ deleteBackup: false });
});

await test("a move from a tab on an earlier build: refused with version 1 as it was, and the current build finishes it", async () => {
  const v1 = await version1Browser(ALICE, [note("a")]);
  const before = await readBackup(v1.id);
  const v2 = await v2Keys(ALICE);
  earlierBuild = true;
  assert.equal(await updateRecoveryKey(walletOf(ALICE)), "waiting");
  assert.equal(await readBackup(v2.id), null, "no new copy");
  assert.deepEqual(await readBackup(v1.id), before, "the old backup is as it was");
  assert.equal(deletes(), 0);
  assert.ok(recoveryState().moving && recoveryState().olderKey);
  earlierBuild = false;
  setClock(Date.now() + 2 * 60_000);
  await backupNow();
  assert.ok(recoveryState().newerKey, "the waiting move finishes with no prompt");
  assert.deepEqual(await backupNotes(v2), ["note-a"]);
  assert.equal(await marker(v2.id), 2);
  assert.equal(await readBackup(v1.id), null);
});

await test("a version 1 browser on an earlier build: no save brings back a backup that left, at any date", async () => {
  const v1 = await version1Browser(ALICE, [note("a")]);
  earlierBuild = true;
  await deleteFromServer(v1);
  await vault.setAllNotes([...vault.getAllNotes(), note("b")]);
  await assert.rejects(backupNow(), /stopped saving/);
  assert.equal(await readBackup(v1.id), null);
  assert.ok(here("a") && here("b"));
});

await test("settings an earlier build marked gone on a newer key: nothing shows, and it keeps saving", async () => {
  await vault.setAllNotes([note("a")]);
  await turnOnWithWallet(walletOf(ALICE));
  const saved = await vault.openJson<Record<string, unknown>>(localStorage.getItem(CONFIG_KEY));
  localStorage.setItem(CONFIG_KEY, await vault.sealJson({ ...saved, gone: true }));
  const page = await openPage("newer-gone");
  page.startRecoverySync();
  await until(() => page.recoveryState().ready, "a new page has read the settings");
  assert.ok(!page.recoveryState().gone && !page.recoveryState().paused);
  await vault.setAllNotes([...vault.getAllNotes(), note("b")]);
  await page.backupNow();
  assert.deepEqual(await backupNotes(await v2Keys(ALICE)), ["note-a", "note-b"]);
  await page.turnOffRecovery({ deleteBackup: false });
});

/* ------------------------------------------------------------ a version 1 backup left elsewhere */

await test("recovery turned on here while a version 1 backup sits elsewhere: one signature brings it in", async () => {
  const v1 = await version1BackupOnly(ALICE, [note("elsewhere")]);
  await vault.setAllNotes([note("here")]);
  const on = walletOf(ALICE);
  await turnOnWithWallet(on);
  assert.deepEqual(on.prompts, ["v2", "v2"], "turning on doesn't go looking");
  assert.ok(await readBackup(v1.id), "it doesn't touch the old backup either");

  const w = walletOf(ALICE);
  assert.equal(await bringInOlderBackup(w), 1);
  assert.deepEqual(w.prompts, ["v1"]);
  assert.ok(here("elsewhere"));
  assert.deepEqual(await backupNotes(await v2Keys(ALICE)), ["note-elsewhere", "note-here"]);
  assert.equal(await readBackup(v1.id), null);
});

await test("bringing it in: no such backup, wrong wallet, or a failed save all change nothing", async () => {
  await vault.setAllNotes([note("here")]);
  await turnOnWithWallet(walletOf(ALICE));
  await assert.rejects(bringInOlderBackup(walletOf(ALICE)), /No older backup found/);
  const bob = walletOf(BOB);
  await assert.rejects(bringInOlderBackup(bob), /isn't the wallet recovery was turned on with/);
  assert.deepEqual(bob.prompts, [], "the wrong wallet is never even asked");

  await newDevice();
  const v1 = await version1BackupOnly(ALICE, [note("elsewhere")]);
  const before = await readBackup(v1.id);
  await vault.setAllNotes([note("here")]);
  await turnOnWithWallet(walletOf(ALICE));
  const v2 = await v2Keys(ALICE);
  fault = (m, id) => (m === "PUT" && id === v2.id ? broken() : null);
  await assert.rejects(bringInOlderBackup(walletOf(ALICE)), /backup service failed/);
  assert.deepEqual(await readBackup(v1.id), before, "the older backup stays as it was");
  assert.equal(deletes(), 0);
});

/* ------------------------------------------------------------ refused: honest and persistent */

await test("a new backup refused for the day: on, no backup yet, the reason, and the time it tries again", async () => {
  await spendBudget();
  await vault.setAllNotes([note("a")]);
  const started = Date.now();
  // doesn't throw: this is a state to show, not a failed action
  assert.equal(await turnOnWithWallet(walletOf(ALICE)), 0);
  const s = recoveryState();
  assert.equal(s.on, true);
  assert.equal(s.savedAt, null, "nothing says it is backed up");
  assert.match(s.error ?? "", /paused for today/);
  assert.ok(s.retryAt && s.retryAt > started, "it knows when to try again");
  const day = 86_400_000;
  const midnight = (Math.floor(started / day) + 1) * day;
  assert.ok(s.retryAt! >= midnight - 1_000 && s.retryAt! <= midnight + 11 * 60_000, "just after the day turns over");
  assert.equal(await readBackup((await v2Keys(ALICE)).id), null);
});

await test("the Back up now button can't claim a save that was refused", async () => {
  await spendBudget();
  await turnOnWithWallet(walletOf(ALICE));
  await assert.rejects(backupNow(), /paused for today/);
  assert.equal(recoveryState().savedAt, null);
  assert.match(recoveryState().error ?? "", /paused for today/);
});

await test("while refused, a change doesn't go asking again and spending the connection's count", async () => {
  await spendBudget();
  await turnOnWithWallet(walletOf(ALICE));
  const before = puts();
  await vault.setAllNotes([note("a")]);
  await sleep(2_700);
  assert.equal(puts(), before, "nothing was sent");
  assert.match(recoveryState().error ?? "", /paused for today/, "and the reason is still shown");
});

await test("while refused, a second tab holds off too", async () => {
  await spendBudget();
  const other = await openPage("tab-wait");
  other.startRecoverySync();
  await turnOnWithWallet(walletOf(ALICE));
  await tellOtherTabs();
  assert.ok(other.recoveryState().on && other.recoveryState().retryAt, "the other tab knows about the wait");
  const before = puts();
  await vault.setAllNotes([note("a")]);
  await sleep(2_700);
  assert.equal(puts(), before, "neither tab sent anything");
  await other.turnOffRecovery({ deleteBackup: false });
});

await test("the wait is over: it saves on its own, and only then says so", async () => {
  await vault.setAllNotes([note("a")]);
  fault = (m) => (m === "PUT" ? refused(1) : null);
  await turnOnWithWallet(walletOf(ALICE));
  assert.equal(recoveryState().savedAt, null);
  fault = null;
  await until(() => Boolean(recoveryState().savedAt), "it saved with nobody asking");
  const s = recoveryState();
  assert.equal(s.error, null);
  assert.equal(s.retryAt, null);
  assert.deepEqual(await backupNotes(await v2Keys(ALICE)), ["note-a"]);
});

await test("a timer that fires a moment before the wait ends doesn't lose the retry", async () => {
  // Timers and the wall clock disagree by a little: a timer can run while the
  // wait still has a moment left. The retry must be set again, not dropped.
  await vault.setAllNotes([note("a")]);
  fault = (m) => (m === "PUT" ? refused(1) : null);
  win.setTimeout = ((fn: () => void, ms: number) => setTimeout(fn, Math.max(0, ms - 150))) as unknown;
  try {
    await turnOnWithWallet(walletOf(ALICE));
    fault = null;
    await until(() => Boolean(recoveryState().savedAt), "it still saved, with nobody asking");
  } finally {
    win.setTimeout = setTimeout;
  }
});

await test("the same for a move that is waiting", async () => {
  const v1 = await version1Browser(ALICE, [note("a")]);
  const v2 = await v2Keys(ALICE);
  fault = (m, id) => (m === "PUT" && id === v2.id ? refused(1) : null);
  win.setTimeout = ((fn: () => void, ms: number) => setTimeout(fn, Math.max(0, ms - 150))) as unknown;
  try {
    assert.equal(await updateRecoveryKey(walletOf(ALICE)), "waiting");
    fault = null;
    const saves = puts(v1.id);
    await until(() => recoveryState().newerKey, "the move still finished");
    assert.equal(puts(v1.id), saves, "waiting for a move saves nothing extra to the old backup");
  } finally {
    win.setTimeout = setTimeout;
  }
  await sleep(50);
  assert.equal(await readBackup(v1.id), null);
});

await test("refused for longer than the page is open: the next page load picks it up", async () => {
  await vault.setAllNotes([note("a")]);
  fault = (m) => (m === "PUT" ? refused(3600) : null);
  await turnOnWithWallet(walletOf(ALICE));
  const saved = await vault.openJson<{ retryAt?: number } & Record<string, unknown>>(localStorage.getItem(CONFIG_KEY));
  assert.ok(saved?.retryAt, "the wait is kept with the settings");
  // the hour goes by with the page closed
  localStorage.setItem(CONFIG_KEY, await vault.sealJson({ ...saved, retryAt: Date.now() - 1_000 }));
  fault = null;
  const before = puts();
  const page = await openPage("later");
  page.startRecoverySync();
  await until(() => Boolean(page.recoveryState().savedAt), "it saved on load, with nobody asking");
  assert.deepEqual(await backupNotes(await v2Keys(ALICE)), ["note-a"]);
  await sleep(2_700);
  assert.equal(puts(), before + 1, "once: the wait's own timer is enough");
  await page.turnOffRecovery({ deleteBackup: false });
});

await test("a browser left in the stuck state by an older build recovers on its next load", async () => {
  // Older builds left on, savedAt null, no retry time, and only retried when a note changed.
  const keys = await v2Keys(ALICE);
  await vault.setAllNotes([note("a")]);
  localStorage.setItem(CONFIG_KEY, await vault.sealJson({ ...keys, wallet: ALICE.address, n: 0, savedAt: null }));
  const page = await openPage("stuck");
  page.startRecoverySync();
  await until(() => Boolean(page.recoveryState().savedAt), "it saved");
  await page.turnOffRecovery({ deleteBackup: false });
});

await test("a save that merely fails isn't called backed up either, and the state says why", async () => {
  await vault.setAllNotes([note("a")]);
  fault = (m) => (m === "PUT" ? broken() : null);
  assert.equal(await turnOnWithWallet(walletOf(ALICE)), 0);
  assert.equal(recoveryState().savedAt, null);
  assert.match(recoveryState().error ?? "", /backup service failed/);
  await assert.rejects(backupNow(), /backup service failed/);
  fault = null;
  await backupNow();
  assert.ok(recoveryState().savedAt);
  assert.equal(recoveryState().error, null);
});

console.log(`\nrecovery v2: ${passed} passed`);
// a refused save leaves a retry timer set for tomorrow
process.exit(0);
