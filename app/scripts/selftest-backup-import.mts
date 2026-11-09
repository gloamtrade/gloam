/**
 * Self-test: restoring a notes backup (Settings, lib/shield importNotesBackup)
 * and the passphrase that locks one (lib/secretBox).
 *
 * Security review, 25 Oct 2026:
 *   - a restore took any note with a secret, a commitment and an amount, while
 *     a claim checks the amount range, recomputes the commitment and asks the
 *     vault. A made-up backup file showed any balance (p + 5, or ten million),
 *     and an amount like "1e5" made every balance sum throw, so the Vault broke
 *     and the bad note went out again with the next backup. Now a note new here
 *     must be canonical (field elements, an amount below 2^128, addresses) with
 *     its commitment equal to Poseidon(secret, amount, asset), or it is left out;
 *     and one the vault has not seen goes in out of the balance until it does.
 *   - a locked backup (gloambak1.) used 120,000 PBKDF2 rounds after claim codes
 *     moved to 310,000 on 20 Oct. New ones use 310,000; old ones still open.
 *
 * Run from app/:  ../mcp/node_modules/.bin/tsx scripts/selftest-backup-import.mts
 */
import assert from "node:assert/strict";
import { createDecipheriv, pbkdf2Sync } from "node:crypto";
import "./browser-shim.mjs";
import type { Address, Hex } from "viem";

type LocalNote = import("../src/lib/shield").LocalNote;

const shield = await import("../src/lib/shield");
const { reconcileUnfunded } = await import("../src/lib/claimSweep");
const { getActiveNetwork } = await import("../src/lib/networks");
const { noteCommitmentPoseidon, fieldToHex } = await import("@gloamtrade/sdk");
const { sealWithPassphrase, openWithPassphrase } = await import("../src/lib/secretBox");

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  await fn();
  passed++;
  console.log(`ok  ${name}`);
}

const net = getActiveNetwork();
const ME = "0x1111111111111111111111111111111111111111" as Address;
const ASSET = "0x00000000000000000000000000000000000000ee" as Address;
const P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

let n = 0;
/** A real note: its commitment is Poseidon(secret, amount, asset). */
async function realNote(amount: bigint, extra: Partial<LocalNote> = {}): Promise<LocalNote> {
  n++;
  const secret = 0x5000n + BigInt(n);
  return {
    id: `t-${Date.now()}-${n}`,
    chainId: net.chainId,
    pool: net.pool as Address,
    asset: ASSET,
    amountWei: amount.toString(),
    commitment: fieldToHex(await noteCommitmentPoseidon(secret, amount, ASSET)) as Hex,
    secret: fieldToHex(secret) as Hex,
    nullifier: "0x" as Hex,
    bound: true,
    scheme: "poseidon",
    createdAt: Date.now(),
    status: "open",
    source: "local",
    ...extra,
  };
}

const backupOf = (notes: unknown[]) => JSON.stringify({ v: 1, type: "gloam-notes-backup", exportedAt: Date.now(), chainId: net.chainId, notes });
const notSpent = async () => false;
const seenAll = async () => true;
const balance = () => shield.sumByAsset(shield.activeSpendableNotes(shield.loadLocalNotes(ME))).get(ASSET.toLowerCase()) ?? 0n;
const stored = (id: string) => shield.loadLocalNotes(ME).find((x) => x.id === id);
/** A restored note: under a new id of its own, found by its commitment. */
const restored = (n: LocalNote) => shield.loadLocalNotes(ME).find((x) => x.commitment.toLowerCase() === n.commitment.toLowerCase());

await test("a real note the vault holds is restored and counted", async () => {
  const before = balance();
  const good = await realNote(10_000_000n);
  const res = await shield.importNotesBackup(backupOf([good]), ME, notSpent, seenAll);
  assert.ok(res.ok && res.count === 1, JSON.stringify(res));
  assert.equal(balance() - before, 10_000_000n);
});

await test("made-up notes are left out: an amount past the field, a commitment that is not the note's, junk fields", async () => {
  const before = balance();
  const base = await realNote(5_000_000n);
  const bad: unknown[] = [
    { ...base, id: "x-1", amountWei: (P + 5n).toString() },
    { ...base, id: "x-2", amountWei: "1e5" },
    { ...base, id: "x-3", amountWei: "10000000000000" }, // ten million, same commitment: not this note's
    { ...base, id: "x-4", commitment: "0x" + "ab".repeat(32), amountWei: "10000000000000" },
    { ...base, id: "x-5", secret: "0xnothex" },
    { ...base, id: "x-6", amountWei: (1n << 128n).toString() },
    { ...base, id: "x-7", asset: "0x1234" },
    { ...base, id: "x-8", amountWei: "0" },
    { ...base, id: "x-9", commitment: "0x" + (P + 1n).toString(16) },
  ];
  const res = await shield.importNotesBackup(backupOf(bad), ME, notSpent, seenAll);
  assert.ok(res.ok, JSON.stringify(res));
  if (!res.ok) return;
  assert.equal(res.count, 0, "nothing counted");
  assert.equal(res.skipped, bad.length, "each one left out, and said so");
  for (const x of bad as { id: string }[]) assert.equal(stored(x.id), undefined, `${x.id} is not kept`);
  assert.equal(balance(), before);
  assert.doesNotThrow(() => shield.sumByAsset(shield.loadLocalNotes(ME)), "every balance sum still adds up");
  const exported = await shield.exportNotesBackup(ME);
  assert.ok(!exported.notes.some((x) => x.id.startsWith("x-")), "and nothing bad goes out with the next backup");
});

await test("a real note the vault has not seen goes in out of the balance, and counts once the vault shows it", async () => {
  const before = balance();
  const waiting = await realNote(7_000_000n);
  const res = await shield.importNotesBackup(backupOf([waiting]), ME, notSpent, async () => false);
  assert.ok(res.ok, JSON.stringify(res));
  if (!res.ok) return;
  assert.equal(res.count, 0);
  assert.equal(res.unseen, 1);
  assert.equal(restored(waiting)?.unfunded, true);
  assert.equal(balance(), before, "not money until it lands");
  // the sync asks again: still not there, then there
  const env = (seen: boolean) =>
    ({ chainId: net.chainId, pool: net.pool, chain: { isCommitmentSeen: async () => seen } }) as unknown as Parameters<typeof reconcileUnfunded>[0];
  assert.equal(await reconcileUnfunded(env(false)), false);
  assert.equal(balance(), before);
  assert.equal(await reconcileUnfunded(env(true)), true);
  assert.equal(restored(waiting)?.unfunded, false);
  assert.equal(balance() - before, 7_000_000n);
});

await test("a restore that can't ask the vault still adds a real note, as before", async () => {
  const before = balance();
  const note = await realNote(3_000_000n);
  const res = await shield.importNotesBackup(backupOf([note]), ME, notSpent, async () => {
    throw new Error("rpc down");
  });
  assert.ok(res.ok && res.count === 1 && res.unseen === 0, JSON.stringify(res));
  assert.equal(balance() - before, 3_000_000n);
});

// ---------------------------------------------------------------- what a restore takes from a file

const { getAllNotes, setAllNotes } = await import("../src/lib/noteVault");
const { reconcileClaims } = await import("../src/lib/claimSweep");
const { noteNullifierPoseidon } = await import("@gloamtrade/sdk");
const nullifierOf = async (x: LocalNote) => fieldToHex(await noteNullifierPoseidon(BigInt(x.secret), BigInt(x.commitment))) as Hex;

await test("a restored note is rebuilt from its money fields under a new id; what the file says about state is not taken", async () => {
  const mine = await realNote(4_000_000n);
  await shield.saveLocalNote(mine);
  const theirs = await realNote(1_000_000n, {
    id: mine.id, // the id of a note already here
    status: "open",
    secured: true,
    nullifier: `0x${"77".repeat(32)}` as Hex,
    unfunded: false,
    leafIndex: 3,
    txHash: `0x${"88".repeat(32)}` as Hex,
    cashOut: { job: "job-1", at: Date.now(), to: ME, state: "scheduled" },
    refundHeld: "blocked",
    restoredSpent: true,
    source: "chain",
    note: "Invoice 042",
  });
  const asked: (Hex | undefined)[] = [];
  const res = await shield.importNotesBackup(backupOf([theirs]), ME, async (x) => (asked.push(x.nullifier), false), seenAll);
  assert.ok(res.ok && res.count === 1, JSON.stringify(res));
  const back = restored(theirs)!;
  assert.notEqual(back.id, mine.id, "a new id, never one already here");
  assert.deepEqual(stored(mine.id), mine, "the note already here is exactly as it was");
  assert.equal(back.nullifier, await nullifierOf(theirs), "the spend marker comes from the secret");
  assert.deepEqual(asked, [undefined], "and the vault is asked by it, not by the file's");
  for (const k of ["secured", "leafIndex", "txHash", "cashOut", "refundHeld", "restoredSpent", "unfunded", "sweptFrom", "sweepPending"] as const) {
    assert.equal(back[k], undefined, `${k} is not taken from the file`);
  }
  assert.equal(back.source, "local");
  assert.equal(back.status, "open");
  assert.equal(back.note, "Invoice 042", "the memo comes along");
});

await test("a move in a file can name a note of the same file, never one already here", async () => {
  const mine = await realNote(6_000_000n);
  await shield.saveLocalNote(mine);
  const src = await realNote(2_000_000n);
  const viaMine = await realNote(2_000_000n, { sweepPending: true, sweptFrom: { id: mine.id, nullifier: await nullifierOf(mine) } });
  const viaSrc = await realNote(2_000_000n, { sweepPending: true, sweptFrom: { id: src.id, nullifier: await nullifierOf(src) } });
  const viaNone = await realNote(2_000_000n, { sweepPending: true, sweptFrom: { id: "imp-1", nullifier: `0x${"12".repeat(32)}` as Hex } });
  const res = await shield.importNotesBackup(backupOf([viaMine, src, viaSrc, viaNone]), ME, notSpent, seenAll);
  assert.ok(res.ok && res.skipped === 0, JSON.stringify(res));
  assert.equal(restored(viaMine)!.sweptFrom, undefined, "naming a note already here: dropped");
  assert.equal(restored(viaMine)!.sweepPending, undefined);
  assert.equal(restored(viaSrc)!.sweptFrom?.id, restored(src)!.id, "naming a note of this file: its new id");
  assert.equal(restored(viaSrc)!.sweepPending, true);
  const none = restored(viaNone)!.sweptFrom!;
  assert.ok(none.id !== "imp-1" && none.id.startsWith("imp-") && !getAllNotes().some((m) => m.id === none.id), "naming neither: an id no note has");
  // the sync settles every pending move; the note already here is never touched
  const env = {
    chainId: net.chainId,
    pool: net.pool,
    chain: { isSpent: async () => true, isCommitmentSeen: async () => true, pathForCommitment: async () => null, waitForReceipt: async () => ({ status: "success" }) },
    leafIndexOf: async () => 1,
  } as unknown as Parameters<typeof reconcileClaims>[0];
  await reconcileClaims(env);
  assert.deepEqual(stored(mine.id), mine, "a note already here keeps its state");
  assert.equal(restored(src)!.status, "recovered", "the source in the same file is the one settled");
});

await test("history a restore brings in is never trimmed, and never pushes other history out", async () => {
  const keep = await realNote(1_000_000n, { status: "recovered", createdAt: 1 });
  const open = await realNote(9_000_000n, { createdAt: 2 });
  await setAllNotes([keep, open, ...getAllNotes()]);
  const spentOnes: LocalNote[] = [];
  for (let i = 0; i < 230; i++) spentOnes.push(await realNote(BigInt(1_000 + i)));
  const res = await shield.importNotesBackup(backupOf(spentOnes), ME, async () => true, seenAll);
  assert.ok(res.ok && res.moved === 230, JSON.stringify(res));
  for (const x of spentOnes) assert.equal(restored(x)?.restoredSpent, true);
  // more history saved later trims only the app's own history, past the cap
  for (let i = 0; i < 205; i++) await shield.saveLocalNote({ ...(await realNote(BigInt(2_000 + i))), status: "recovered" });
  assert.ok(spentOnes.every((x) => restored(x)), "every spent note a restore brought in is still here");
  assert.ok(stored(open.id), "a spendable note is never trimmed");
  assert.equal(stored(open.id)?.status, "open");
});

// ---------------------------------------------------------------- locked backups

function openAt(sealed: string, passphrase: string, rounds: number): string {
  const raw = Buffer.from(sealed.slice("gloambak1.".length), "base64url");
  const key = pbkdf2Sync(passphrase, raw.subarray(0, 16), rounds, 32, "sha256");
  const d = createDecipheriv("aes-256-gcm", key, raw.subarray(16, 28));
  d.setAuthTag(raw.subarray(raw.length - 16));
  return Buffer.concat([d.update(raw.subarray(28, raw.length - 16)), d.final()]).toString("utf8");
}

async function sealAt(plain: string, passphrase: string, rounds: number): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations: rounds, hash: "SHA-256" }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plain)));
  return "gloambak1." + Buffer.concat([salt, iv, cipher]).toString("base64url");
}

await test("a locked backup uses 310,000 rounds; one locked before still opens; a wrong passphrase does not", async () => {
  const plain = backupOf([]);
  const sealed = await sealWithPassphrase(plain, "correct horse battery");
  assert.equal(openAt(sealed, "correct horse battery", 310_000), plain, "310,000 rounds");
  assert.throws(() => openAt(sealed, "correct horse battery", 120_000));
  assert.equal(await openWithPassphrase(sealed, "correct horse battery"), plain);
  const old = await sealAt(plain, "correct horse battery", 120_000);
  assert.equal(await openWithPassphrase(old, "correct horse battery"), plain, "a backup locked with 120,000 rounds still opens");
  await assert.rejects(openWithPassphrase(sealed, "wrong"), /Wrong passphrase/);
  await assert.rejects(openWithPassphrase(old, "wrong"), /Wrong passphrase/);
});

await new Promise((r) => setTimeout(r, 50));
console.log(`\nbackup import: ${passed} passed`);
