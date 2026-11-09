/**
 * Self-test: encrypted recovery backups on the server (lib/recoveryStore).
 *
 *  - two devices saving from the same version at the same moment: exactly one
 *    is saved, the other gets a 409, and after it merges and saves on top the
 *    backup holds both devices' data (before the fix both saved and the later
 *    one silently dropped the other's data)
 *  - versions only go up, the write token is checked, a held lock frees itself,
 *    and delete needs the token
 *  - a save that must find a backup there writes nothing when there is none
 *  - the marker for a newer key goes on the record and stays there, and a read
 *    doesn't show it
 *
 * Uses the in-process store (GLOAM_PARTNERS_STORE=memory). The ciphertext here
 * is stand-in base64; the store never reads it.
 *
 * Run from app/:  ../mcp/node_modules/.bin/tsx scripts/selftest-recovery-store.mts
 */
import assert from "node:assert/strict";
import Module from "node:module";
import { fileURLToPath } from "node:url";

process.env.GLOAM_PARTNERS_STORE = "memory";
const stub = fileURLToPath(new URL("./server-only-stub.cjs", import.meta.url));
const M = Module as unknown as { _resolveFilename: (req: string, ...rest: unknown[]) => string };
const resolve = M._resolveFilename;
M._resolveFilename = function (req: string, ...rest: unknown[]) {
  return req === "server-only" ? stub : resolve.call(this, req, ...rest);
};

const { RecoveryError, readBackup, writeBackup, deleteBackup } = await import("../src/lib/recoveryStore");
const { kv, resetMemoryKv } = await import("../src/lib/partnersKv");

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  resetMemoryKv();
  await fn();
  passed++;
  console.log(`ok  ${name}`);
}

const ID = "a".repeat(64);
const WRITE = "b".repeat(64);
const b64 = (s: string) => Buffer.from(s).toString("base64");
const text = (c: string) => Buffer.from(c, "base64").toString();
const status = (e: unknown) => (e instanceof RecoveryError ? e.status : -1);

await test("two devices saving from the same version: one wins, the other is told to merge, and nothing is lost", async () => {
  await writeBackup({ id: ID, write: WRITE, c: b64("start"), n: 1 });
  // both devices last saw version 1 and save version 2 at the same moment
  const [a, b] = await Promise.allSettled([
    writeBackup({ id: ID, write: WRITE, c: b64("start+laptop"), n: 2 }),
    writeBackup({ id: ID, write: WRITE, c: b64("start+phone"), n: 2 }),
  ]);
  const won = [a, b].filter((r) => r.status === "fulfilled");
  const lost = [a, b].filter((r) => r.status === "rejected") as PromiseRejectedResult[];
  assert.equal(won.length, 1, "exactly one save goes through");
  assert.equal(lost.length, 1);
  assert.equal(status(lost[0]!.reason), 409, "the other gets a 409, so the client merges");
  // the loser does what lib/recovery upload does: read the newer copy, merge, save on top
  const latest = (await readBackup(ID))!;
  assert.equal(latest.n, 2);
  const winner = text(latest.c);
  const loserData = winner === "start+laptop" ? "phone" : "laptop";
  await writeBackup({ id: ID, write: WRITE, c: b64(`${winner}+${loserData}`), n: latest.n + 1 });
  const final = text((await readBackup(ID))!.c);
  assert.ok(final.includes("laptop") && final.includes("phone"), `both devices' data is in the backup (${final})`);
});

await test("a stale version is refused and a newer one is kept", async () => {
  await writeBackup({ id: ID, write: WRITE, c: b64("v3"), n: 3 });
  await assert.rejects(writeBackup({ id: ID, write: WRITE, c: b64("v2"), n: 2 }), (e) => status(e) === 409);
  await assert.rejects(writeBackup({ id: ID, write: WRITE, c: b64("v3 again"), n: 3 }), (e) => status(e) === 409);
  assert.equal(text((await readBackup(ID))!.c), "v3");
});

await test("the write token is checked on save and on delete", async () => {
  await writeBackup({ id: ID, write: WRITE, c: b64("mine"), n: 1 });
  await assert.rejects(writeBackup({ id: ID, write: "c".repeat(64), c: b64("theirs"), n: 2 }), (e) => status(e) === 403);
  await assert.rejects(deleteBackup(ID, "c".repeat(64)), (e) => status(e) === 403);
  await deleteBackup(ID, WRITE);
  assert.equal(await readBackup(ID), null);
});

await test("the lock is released after each save, and a lock left behind expires", async () => {
  await writeBackup({ id: ID, write: WRITE, c: b64("one"), n: 1 });
  await writeBackup({ id: ID, write: WRITE, c: b64("two"), n: 2 });
  assert.deepEqual(await kv([["EXISTS", `gloam:recovery:v1:${ID}:lock`]]), [0], "no lock left after a save");
  // a server that died mid-save left its lock: saves are refused until it expires
  await kv([["SET", `gloam:recovery:v1:${ID}:lock`, "dead", "EX", 1]]);
  await assert.rejects(writeBackup({ id: ID, write: WRITE, c: b64("three"), n: 3 }), (e) => status(e) === 409);
  await new Promise((r) => setTimeout(r, 1_100));
  await writeBackup({ id: ID, write: WRITE, c: b64("three"), n: 3 });
  assert.equal(text((await readBackup(ID))!.c), "three");
});

await test("a failed save never leaves the lock held", async () => {
  await writeBackup({ id: ID, write: WRITE, c: b64("ok"), n: 5 });
  await assert.rejects(writeBackup({ id: ID, write: WRITE, c: b64("old"), n: 4 }), (e) => status(e) === 409);
  assert.deepEqual(await kv([["EXISTS", `gloam:recovery:v1:${ID}:lock`]]), [0]);
});

await test("a save that must find a backup there: nothing there means a 410 and nothing written", async () => {
  await assert.rejects(writeBackup({ id: ID, write: WRITE, c: b64("back again"), n: 2, mustExist: true }), (e) => status(e) === 410);
  assert.equal(await readBackup(ID), null, "the id still holds nothing");
  assert.deepEqual(await kv([["EXISTS", `gloam:recovery:v1:${ID}:lock`]]), [0], "and the lock is free");
});

await test("a save that must find a backup there, after a delete: the backup stays gone", async () => {
  await writeBackup({ id: ID, write: WRITE, c: b64("one"), n: 1 });
  await deleteBackup(ID, WRITE);
  await assert.rejects(writeBackup({ id: ID, write: WRITE, c: b64("two"), n: 2, mustExist: true }), (e) => status(e) === 410);
  assert.equal(await readBackup(ID), null);
});

await test("a save that must find a backup there and does: the usual checks, then it saves", async () => {
  await writeBackup({ id: ID, write: WRITE, c: b64("one"), n: 1 });
  const saved = await writeBackup({ id: ID, write: WRITE, c: b64("two"), n: 2, mustExist: true });
  assert.equal(saved.created, false);
  assert.equal(text((await readBackup(ID))!.c), "two");
  await assert.rejects(writeBackup({ id: ID, write: "c".repeat(64), c: b64("theirs"), n: 3, mustExist: true }), (e) => status(e) === 403);
  await assert.rejects(writeBackup({ id: ID, write: WRITE, c: b64("old"), n: 2, mustExist: true }), (e) => status(e) === 409);
});

const stored = async () => JSON.parse(String((await kv([["GET", `gloam:recovery:v1:${ID}`]]))[0])) as { v?: number };

await test("a backup from before the marker has none, and gets it on its next save from a newer key", async () => {
  await writeBackup({ id: ID, write: WRITE, c: b64("one"), n: 1 });
  assert.equal((await stored()).v, undefined);
  await writeBackup({ id: ID, write: WRITE, c: b64("two"), n: 2, v: 2 });
  assert.equal((await stored()).v, 2);
});

await test("a save without the marker doesn't take it off the record", async () => {
  await writeBackup({ id: ID, write: WRITE, c: b64("one"), n: 1, v: 2 });
  await writeBackup({ id: ID, write: WRITE, c: b64("two"), n: 2, mustExist: true });
  assert.equal((await stored()).v, 2);
  assert.equal(text((await readBackup(ID))!.c), "two");
});

await test("a read shows what it always has, with no marker", async () => {
  await writeBackup({ id: ID, write: WRITE, c: b64("one"), n: 1, v: 2 });
  assert.deepEqual(Object.keys((await readBackup(ID))!).sort(), ["c", "n", "t"]);
});

console.log(`\nrecovery store: ${passed} passed`);
