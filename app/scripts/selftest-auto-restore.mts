/**
 * Self-test: the private balance comes back on a new device by itself
 * (lib/autoRestore), and a device with recovery on reads what another device
 * saved (lib/recovery pullBackup), against a stand-in /api/recovery.
 *
 *  - who is restored silently, who is asked once, and who is left a card, and why
 *  - a Gloam wallet's restore: one silent signature, the notes are back, no card
 *  - no backup under the wallet's key: nothing saved, recovery stays off
 *  - a closed signature request: asked once only, and the card says why
 *  - a device with recovery on takes in a newer backup from another device, and
 *    saves nothing back when it holds nothing new; a note only it holds still goes up
 *  - the backup stays end-to-end encrypted: the server only sees id, token, ciphertext
 *
 * Nothing leaves the process.
 *
 * Run from app/:  ../mcp/node_modules/.bin/tsx scripts/selftest-auto-restore.mts
 */
import assert from "node:assert/strict";
import "./browser-shim.mjs";
import type { Address, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

type LocalNote = import("../src/lib/shield").LocalNote;

const win = globalThis.window as unknown as Record<string, unknown>;
win.setTimeout = setTimeout;
win.clearTimeout = clearTimeout;

/* ------------------------------------------------------------ stand-in server */

const backups = new Map<string, { c: string; n: number; t: number }>();
const bodies: string[] = [];
let puts = 0;
globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
  const method = init?.method ?? "GET";
  if (init?.body) bodies.push(String(init.body));
  if (method === "GET") {
    const id = new URL(String(url), "https://www.gloam.trade").searchParams.get("id")!;
    const b = backups.get(id);
    return b ? Response.json({ data: b }) : Response.json({ error: { message: "none" } }, { status: 404 });
  }
  const body = JSON.parse(String(init!.body)) as { id: string; c?: string; n?: number };
  if (method === "PUT") {
    const now = backups.get(body.id);
    if (body.n !== (now?.n ?? 0) + 1) return Response.json({ error: { message: "conflict" } }, { status: 409 });
    puts++;
    const t = Date.now();
    backups.set(body.id, { c: body.c!, n: body.n!, t });
    return Response.json({ data: { n: body.n, t } });
  }
  throw new Error(`unexpected ${method}`);
}) as typeof fetch;

/* ------------------------------------------------------------ helpers */

const ALICE = privateKeyToAccount(`0x${"11".repeat(32)}`);
const BOB = privateKeyToAccount(`0x${"22".repeat(32)}`);
const ASSET = "0x00000000000000000000000000000000000000ee" as Address;
const hex = (fill: string) => `0x${fill.repeat(64).slice(0, 64)}` as Hex;
let seq = 0;
function note(id: string, from: Address = ALICE.address, extra: Partial<LocalNote> = {}): LocalNote {
  seq++;
  return {
    id,
    chainId: 46630,
    pool: "0x72406D9597807A46f730d8b4fDBC5aC45Dc1d740" as Address,
    asset: ASSET,
    amountWei: "10000000",
    commitment: hex(`${seq}c`),
    secret: hex(`${seq}a`),
    nullifier: hex(`${seq}b`),
    bound: true,
    scheme: "poseidon",
    from,
    createdAt: 1_000 + seq,
    status: "open",
    source: "local",
    ...extra,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  await fn();
  passed++;
  console.log(`ok  ${name}`);
}

const auto = await import("../src/lib/autoRestore");
const recovery = await import("../src/lib/recovery");
const vault = await import("../src/lib/noteVault");
await vault.unlockNoteVault();

/** Alice's version 2 wallet keys, as any device of hers derives them. */
async function aliceKeys() {
  const sig = await ALICE.signMessage({ message: recovery.recoveryMessageV2(ALICE.address) });
  return recovery.keysFromSecret("wallet", recovery.walletSecret(sig)!);
}

/** What another device saves: sealed exactly as lib/recovery seals. */
async function sealFor(keys: { id: string; key: string }, notes: LocalNote[]): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey("raw", Uint8Array.from(atob(keys.key), (ch) => ch.charCodeAt(0)), "AES-GCM", false, ["encrypt"]);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(keys.id) },
      key,
      new TextEncoder().encode(JSON.stringify({ v: 1, savedAt: Date.now(), notes, receive: { current: null, previous: [] } })),
    ),
  );
  const out = new Uint8Array(12 + ct.length);
  out.set(iv);
  out.set(ct, 12);
  return btoa(String.fromCharCode(...out));
}

async function openBackup(keys: { id: string; key: string }): Promise<LocalNote[]> {
  const raw = Uint8Array.from(atob(backups.get(keys.id)!.c), (ch) => ch.charCodeAt(0));
  const key = await crypto.subtle.importKey("raw", Uint8Array.from(atob(keys.key), (ch) => ch.charCodeAt(0)), "AES-GCM", false, ["decrypt"]);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: raw.slice(0, 12), additionalData: new TextEncoder().encode(keys.id) },
    key,
    raw.slice(12),
  );
  return (JSON.parse(new TextDecoder().decode(plain)) as { notes: LocalNote[] }).notes;
}

/* ------------------------------------------------------------ the plan */

const base = { kind: "embedded" as const, ready: true, on: false, turnedOff: false, otherNotes: 0, missing: null, tried: false };

await test("a Gloam wallet restores silently, whether or not a deposit is known to be missing", () => {
  assert.deepEqual(auto.planAutoRestore(base), { run: "silent" });
  assert.deepEqual(auto.planAutoRestore({ ...base, missing: false }), { run: "silent" });
});

await test("a browser wallet is asked once, only when its deposits are missing here", () => {
  const b = { ...base, kind: "browser" as const };
  assert.deepEqual(auto.planAutoRestore({ ...b, missing: true }), { run: "prompt" });
  assert.deepEqual(auto.planAutoRestore({ ...b, missing: false }), { run: "no", why: "nothing-missing" });
  assert.deepEqual(auto.planAutoRestore({ ...b, missing: null }), { run: "no", why: "wait" });
  assert.deepEqual(auto.planAutoRestore({ ...b, missing: true, tried: true }), { run: "no", why: "tried" });
});

await test("nothing runs before the settings are read, with recovery on or turned off, or for Tempo Wallet", () => {
  assert.deepEqual(auto.planAutoRestore({ ...base, ready: false }), { run: "no", why: "wait" });
  assert.deepEqual(auto.planAutoRestore({ ...base, on: true }), { run: "no", why: "on" });
  assert.deepEqual(auto.planAutoRestore({ ...base, turnedOff: true }), { run: "no", why: "turned-off" });
  assert.deepEqual(auto.planAutoRestore({ ...base, kind: "tempo", missing: true }), { run: "no", why: "tempo" });
});

await test("a browser holding another wallet's notes waits for the person", () => {
  assert.deepEqual(auto.planAutoRestore({ ...base, otherNotes: 2 }), { run: "no", why: "shared" });
  assert.deepEqual(auto.planAutoRestore({ ...base, kind: "browser", missing: true, otherNotes: 1 }), { run: "no", why: "shared" });
});

await test("every card left says why, and none shows while a restore runs or after it worked", () => {
  const fb = (kind: "embedded" | "browser" | "tempo", status: Parameters<typeof auto.autoRestoreFallback>[0]["status"], plan = { run: "silent" } as ReturnType<typeof auto.planAutoRestore>) =>
    auto.autoRestoreFallback({ kind, status, plan, passkey: true });
  assert.equal(fb("embedded", { kind: "running", prompt: false }), null);
  assert.equal(fb("embedded", { kind: "checking" }), null);
  assert.equal(fb("embedded", { kind: "restored", added: 3 }), null);
  assert.equal(fb("browser", { kind: "idle" }, { run: "no", why: "nothing-missing" }), null);
  const closed = fb("browser", { kind: "failed", cancelled: true, text: "You closed the signature request, so your private balance didn't load on this device." })!;
  assert.equal(closed.action, "wallet");
  assert.match(closed.text, /closed the signature request/);
  const broke = fb("embedded", { kind: "failed", cancelled: false, text: "No connection. Check your internet and try again." })!;
  assert.match(broke.text, /didn't load by itself: no connection/);
  assert.equal(fb("embedded", { kind: "none" })!.action, "passkey");
  assert.match(fb("embedded", { kind: "none" })!.text, /No backup opens with this sign-in/);
  assert.match(fb("tempo", { kind: "idle" }, { run: "no", why: "tempo" })!.text, /Tempo Wallet can't make a recovery key/);
  assert.match(fb("browser", { kind: "idle" }, { run: "no", why: "shared" })!.text, /another wallet's private balance/);
  assert.equal(auto.autoRestoreFallback({ kind: "embedded", status: { kind: "none" }, plan: { run: "silent" }, passkey: false })!.action, null);
});

/* ------------------------------------------------------------ restoring */

let signatures = 0;
const silentAlice = {
  address: ALICE.address,
  sign: async (message: string) => {
    signatures++;
    return ALICE.signMessage({ message });
  },
};

await test("no backup under the wallet's key: nothing saved, recovery stays off", async () => {
  const before = puts;
  const s = await auto.runAutoRestore(ALICE.address, silentAlice, "silent", "embedded");
  assert.deepEqual(s, { kind: "none" });
  assert.equal(puts, before, "nothing saved");
  assert.equal(recovery.recoveryState().on, false);
  assert.equal(auto.autoRestoreTried(ALICE.address, "embedded"), true, "not tried again this session");
  assert.equal(vault.getAllNotes().length, 0);
});

await test("a Gloam wallet's balance comes back with one silent signature, and recovery is on here too", async () => {
  // Alice saved three notes from her desktop.
  const keys = await aliceKeys();
  const desktop = [note("d-1"), note("d-2"), note("d-3")];
  backups.set(keys.id, { c: await sealFor(keys, desktop), n: 1, t: Date.now() });
  // A new sign-in on the phone: a fresh session.
  sessionStorage.clear();
  signatures = 0;
  const s = await auto.runAutoRestore(ALICE.address, silentAlice, "silent", "embedded");
  assert.deepEqual(s, { kind: "restored", added: 3 });
  assert.equal(signatures, 1, "one signature, made silently");
  assert.deepEqual(vault.getAllNotes().map((n) => n.id).sort(), ["d-1", "d-2", "d-3"]);
  assert.ok(vault.getAllNotes().every((n) => n.from === ALICE.address && n.status === "open"));
  assert.equal(recovery.recoveryState().on, true);
  assert.equal(auto.autoRestoreStatus(ALICE.address).kind, "restored");
});

await test("the server only ever saw an id, a token and ciphertext", async () => {
  for (const b of bodies) {
    assert.ok(!b.includes("d-1") && !b.includes(hex("1a")), "no note in the clear");
    const j = JSON.parse(b) as Record<string, unknown>;
    assert.deepEqual(Object.keys(j).filter((k) => !["id", "write", "c", "n", "v", "mustExist"].includes(k)), []);
  }
});

await test("a device with recovery on takes in what another device saved, and saves nothing back", async () => {
  const keys = await aliceKeys();
  const desktop = await openBackup(keys);
  const newer = [note("d-4"), ...desktop];
  const now = backups.get(keys.id)!;
  backups.set(keys.id, { c: await sealFor(keys, newer), n: now.n + 1, t: Date.now() });
  const before = puts;
  const added = await recovery.pullBackup({ force: true });
  assert.equal(added, 1);
  assert.ok(vault.getAllNotes().some((n) => n.id === "d-4"));
  await sleep(3_500);
  assert.equal(puts, before, "it held nothing the backup didn't");
  assert.equal(await recovery.pullBackup({ force: true }), 0, "nothing newer the second time");
});

await test("a note only this device holds still goes up after a pull", async () => {
  const keys = await aliceKeys();
  const now = backups.get(keys.id)!;
  backups.set(keys.id, { c: await sealFor(keys, [note("d-5"), ...(await openBackup(keys))]), n: now.n + 1, t: Date.now() });
  // A deposit made here a moment ago, whose save hasn't gone yet.
  await vault.setAllNotes([note("phone-1"), ...vault.getAllNotes()]);
  await recovery.pullBackup({ force: true });
  for (let i = 0; i < 400 && !(await openBackup(keys)).some((n) => n.id === "phone-1"); i++) await sleep(20);
  const ids = (await openBackup(keys)).map((n) => n.id);
  assert.ok(ids.includes("phone-1") && ids.includes("d-5"), "both sides in the backup");
});

await test("a closed signature request asks once only, and says why", async () => {
  const bob = {
    address: BOB.address,
    sign: async () => {
      throw Object.assign(new Error("User rejected the request."), { name: "UserRejectedRequestError" });
    },
  };
  assert.equal(auto.autoRestoreTried(BOB.address, "browser"), false);
  const s = await auto.runAutoRestore(BOB.address, bob, "prompt", "browser");
  assert.equal(s.kind, "failed");
  assert.equal(s.kind === "failed" && s.cancelled, true);
  assert.equal(auto.autoRestoreTried(BOB.address, "browser"), true, "never popped by itself again on this browser");
  const card = auto.autoRestoreFallback({ kind: "browser", status: s, plan: { run: "no", why: "tried" }, passkey: true })!;
  assert.equal(card.action, "wallet");
});

await test("the status of one wallet never shows for another", () => {
  assert.equal(auto.autoRestoreStatus(ALICE.address.toLowerCase()).kind, "restored");
  assert.equal(auto.autoRestoreStatus("0x3333333333333333333333333333333333333333").kind, "idle");
  assert.equal(auto.autoRestoreStatus(null).kind, "idle");
});

console.log(`selftest-auto-restore: ${passed} passed`);
process.exit(0);
