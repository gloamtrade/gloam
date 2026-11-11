/**
 * Self-test: a signed-out page lists no private notes and no totals (Duke's
 * report, 11 Nov 2026).
 *
 * After Sign out on gloam.trade/app, the Portfolio hero said "$0.00, Connect a
 * wallet to see your private balance", yet the Private balance card under it
 * still listed his notes (50, 1,192.5 and 1,631.85 USDG, each with a Pay
 * button). loadLocalNotes(address) returned every note on the network when
 * the address was empty, and the notes hook passed the connected address,
 * which is undefined once signed out.
 *
 * Here: what a view reads (loadWalletNotes, visibleNotes) is nothing while
 * signed out, the wallet's own notes once it connects, never another wallet's;
 * a note no wallet is named on stays with any connected wallet (it can't be
 * told whose it is). The store itself is never touched by a read, and the
 * reads that are not a view (backups, payroll, background checks) see what
 * they always saw.
 *
 * Run from app/:  ../mcp/node_modules/.bin/tsx scripts/selftest-signed-out-notes.mts
 */
import assert from "node:assert/strict";
import "./browser-shim.mjs";
import { formatUnits, type Address, type Hex } from "viem";

delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;
// The recording demo is only offered on a local host or a build that turns it on (the last test).
process.env.NEXT_PUBLIC_GLOAM_DEMO = "1";
globalThis.fetch = (async (url: unknown) => {
  throw new Error(`selftest-signed-out-notes: no network calls allowed (${String(url)})`);
}) as typeof fetch;

type LocalNote = import("../src/lib/shield").LocalNote;

window.localStorage.setItem("gloam.network", "robinhood-mainnet");

const nets = await import("../src/lib/networks");
const shield = await import("../src/lib/shield");
const vault = await import("../src/lib/noteVault");
const { DEMO_ADDRESS } = await import("../src/lib/demo/store");
const { loadLocalNotes, loadWalletNotes, notesForWallet, visibleNotes, activeSpendableNotes, sumByAsset, mergeNotes } = shield;

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  await fn();
  passed++;
  console.log(`ok  ${name}`);
}

const RH = nets.getNetwork("robinhood-mainnet");
const DUKE = "0x76b7E410a227c888aBD2Bdc24Ee32E094B0FD4D8" as Address;
const OTHER = "0x1111111111111111111111111111111111111111" as Address;
const USDG = "0xe8b7cdec0a2b6a1d34e3b0c0e4b0e2c7d7a2bb11" as Address;
const hex = (fill: string) => `0x${fill.repeat(64).slice(0, 64)}` as Hex;

let k = 0;
function note(amountWei: string, from: Address | undefined, extra: Partial<LocalNote> = {}): LocalNote {
  k++;
  return {
    id: `n-${k}`,
    chainId: RH.chainId,
    pool: RH.pool as Address,
    asset: USDG,
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

// Duke's three notes from the report, another wallet's note, and a legacy note no wallet is named on.
const dukes = [note("50000000", DUKE), note("1192500000", DUKE), note("1631850000", DUKE)];
const others = [note("7000000", OTHER)];
const legacy = note("3000000", undefined);
const seeded = [...dukes, ...others, legacy];
// A chain row for Duke's wallet (a deposit read from the vault's events: no secret).
const chainRow: LocalNote = { ...note("9000000", DUKE), id: "chain-x", secret: "0x" as Hex, source: "chain" };

await vault.unlockNoteVault();
await vault.setAllNotes(seeded);

const ids = (notes: readonly { id: string }[]) => notes.map((n) => n.id).sort();
const usdg = (notes: LocalNote[]) => formatUnits(sumByAsset(activeSpendableNotes(notes)).get(USDG.toLowerCase()) ?? 0n, 6);

/** Every key this browser keeps, as it is on disk now. */
function disk(): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (let i = 0; i < window.localStorage.length; i++) {
    const key = window.localStorage.key(i)!;
    out[key] = window.localStorage.getItem(key);
  }
  return out;
}
const before = disk();
const storedBefore = structuredClone(vault.getAllNotes());

await test("the bug: the old read with no address lists Duke's 2,874.35 USDG and every other wallet's notes", () => {
  // loadLocalNotes keeps this for work that is not a view; a view must never use it.
  const all = loadLocalNotes(undefined, RH);
  assert.deepEqual(ids(all), ids(seeded));
  assert.equal(usdg(dukes), "2874.35");
});

await test("signed out: a view reads no notes and no total, whatever the empty address looks like", () => {
  for (const signedOut of [undefined, null, ""]) {
    assert.deepEqual(loadWalletNotes(signedOut, RH), []);
    assert.deepEqual(loadWalletNotes(signedOut), [], "on the active network too");
    assert.deepEqual(notesForWallet(seeded, signedOut), []);
    const shown = visibleNotes(seeded, [chainRow], RH, true, signedOut);
    assert.deepEqual(shown, { local: [], chain: [] });
    const merged = mergeNotes(shown.local, shown.chain);
    assert.equal(sumByAsset(activeSpendableNotes(merged)).size, 0, "no balance row, no headline, no Pay button");
  }
});

await test("the render that signs out: the hook's state still holds Duke's notes, and none of them shows", () => {
  // useLocalShieldNotes keeps the last read in state until its next one; the filter runs on that render.
  const held = loadWalletNotes(DUKE, RH);
  assert.equal(held.length, 4);
  assert.deepEqual(visibleNotes(held, [chainRow], RH, true, undefined), { local: [], chain: [] });
});

await test("connected as Duke: his notes and the legacy one, never another wallet's", () => {
  const mine = loadWalletNotes(DUKE, RH);
  assert.deepEqual(ids(mine), ids([...dukes, legacy]));
  assert.equal(usdg(mine), "2877.35");
  // the address as a wallet reports it, in any case
  assert.deepEqual(ids(loadWalletNotes(DUKE.toLowerCase(), RH)), ids(mine));
  const shown = visibleNotes(mine, [chainRow], RH, true, DUKE);
  assert.deepEqual(ids(shown.local), ids(mine));
  assert.deepEqual(ids(shown.chain), [chainRow.id]);
});

await test("connected as another wallet: its notes and the legacy one, never Duke's, even from the state Duke left", () => {
  const theirs = loadWalletNotes(OTHER, RH);
  assert.deepEqual(ids(theirs), ids([...others, legacy]));
  assert.ok(!theirs.some((n) => n.from?.toLowerCase() === DUKE.toLowerCase()));
  // a switch of account: the hook's state and chain rows are still Duke's on this render
  const shown = visibleNotes(loadWalletNotes(DUKE, RH), [chainRow], RH, true, OTHER);
  assert.deepEqual(ids(shown.local), [legacy.id]);
  assert.deepEqual(shown.chain, []);
});

await test("a note no wallet is named on is shown to a connected wallet only, never signed out", () => {
  assert.deepEqual(ids(notesForWallet([legacy], DUKE)), [legacy.id]);
  assert.deepEqual(ids(notesForWallet([legacy], OTHER)), [legacy.id]);
  assert.deepEqual(notesForWallet([legacy], undefined), []);
});

await test("reads that are not a view see what they always saw", async () => {
  // a backup made for a wallet, payroll, the privacy kit's check across this browser
  assert.deepEqual(ids(loadLocalNotes(DUKE, RH)), ids([...dukes, legacy]));
  assert.deepEqual(ids(loadLocalNotes(null, RH)), ids(seeded));
  const backup = await shield.exportNotesBackup(DUKE);
  assert.deepEqual(ids(backup.notes), ids([...dukes, legacy]));
});

await test("storage untouched: every read above left the store and the disk as they were", async () => {
  assert.deepEqual(vault.getAllNotes(), storedBefore);
  assert.deepEqual(disk(), before);
  // and what is on disk opens to every note, Duke's included
  await vault.syncFromDisk();
  assert.deepEqual(ids(vault.getAllNotes()), ids(seeded));
});

await test("recording demo: the pretend wallet's notes still show (the hook passes its address when wagmi has none)", () => {
  window.sessionStorage.setItem("gloam_demo", "1");
  try {
    const pretend = vault.getAllNotes();
    assert.ok(pretend.length > 0, "the demo seeds a pretend wallet");
    assert.ok(!pretend.some((n) => seeded.some((s) => s.id === n.id)), "never this browser's own notes");
    const net = pretend[0]!;
    const scope = { chainId: net.chainId, pool: net.pool };
    const onNet = shield.notesOnNetwork(pretend, scope);
    assert.deepEqual(ids(loadWalletNotes(DEMO_ADDRESS, scope)), ids(onNet));
    assert.ok(onNet.length > 0);
  } finally {
    window.sessionStorage.removeItem("gloam_demo");
    window.sessionStorage.removeItem("gloam_demo_state");
  }
  assert.deepEqual(ids(vault.getAllNotes()), ids(seeded), "out of the demo, the browser's own notes again");
});

console.log(`\n${passed} passed`);
