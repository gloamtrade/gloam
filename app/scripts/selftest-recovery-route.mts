/**
 * Self-test: what /api/recovery lets in (app/api/recovery/route.ts).
 *
 * Security review, 25 Oct 2026: backups never expire (a lapsed one can cost
 * someone their funds), so the store must not be fillable. One connection
 * could file 50 new backups of up to 512 KB a day, forever. Now:
 *   - saving to a backup that already exists is always let through and never
 *     counts against anything daily;
 *   - a new backup counts against its connection (5 a day, an IPv6 /48 as one)
 *     and against one daily budget for every new backup
 *     (GLOAM_RECOVERY_NEW_PER_DAY, 300 by default); past it, new backups are
 *     told to try again later, and the server logs it once;
 *   - a request that is not a valid backup is refused before it counts;
 *   - a save flagged mustExist makes no new backup, and spends none of the above.
 *
 * A save with no `v: 2` counts as version 1:
 *   - it never makes a new backup, from the day this deployed, and spends nothing;
 *   - it may update a backup that exists until the end date, on the server's clock;
 *   - from the end date it is refused on any id, before the store is touched;
 *   - reads, deletes and every save with `v: 2` carry on past the end date, on
 *     backups from before the marker too.
 *
 * Uses the in-process store (GLOAM_PARTNERS_STORE=memory) and the real route. The
 * server's clock is set here, apart from the process's own.
 *
 * Run from app/:  ../mcp/node_modules/.bin/tsx scripts/selftest-recovery-route.mts
 */
import assert from "node:assert/strict";
import Module from "node:module";
import { fileURLToPath } from "node:url";

process.env.GLOAM_PARTNERS_STORE = "memory";
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;
const stub = fileURLToPath(new URL("./server-only-stub.cjs", import.meta.url));
const M = Module as unknown as { _resolveFilename: (req: string, ...rest: unknown[]) => string };
const resolve = M._resolveFilename;
M._resolveFilename = function (req: string, ...rest: unknown[]) {
  return req === "server-only" ? stub : resolve.call(this, req, ...rest);
};

const { PUT, GET, DELETE } = await import("../src/app/api/recovery/route");
const { kv, resetMemoryKv } = await import("../src/lib/partnersKv");
const { clientIp, hitRateLimit, ipBucket } = await import("../src/lib/mcpRemote/rateLimit");
const { VERSION1_SAVES_UNTIL } = await import("../src/lib/recoveryEnd");
const { readBackup, setRecoveryClock } = await import("../src/lib/recoveryStore");

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  resetMemoryKv();
  // a fresh day for the counters
  (globalThis as { __gloamMcpRate?: Map<string, unknown> }).__gloamMcpRate?.clear();
  delete process.env.GLOAM_RECOVERY_NEW_PER_DAY;
  setRecoveryClock(null);
  await fn();
  passed++;
  console.log(`ok  ${name}`);
}

let k = 0;
const hex64 = () => (++k).toString(16).padStart(64, "0");
const WRITE = "b".repeat(64);
const BLOB = Buffer.from("sealed backup").toString("base64");

/** A save as a current browser sends it under a newer key. `NO_VERSION` leaves the marker off. */
async function put(ip: string, id: string, n = 1, c = BLOB, extra: Record<string, unknown> = {}) {
  const res = await PUT(
    new Request("http://localhost/api/recovery", {
      method: "PUT",
      headers: { "content-type": "application/json", "x-forwarded-for": ip },
      body: JSON.stringify({ id, write: WRITE, c, n, v: 2, ...extra }),
    })
  );
  const json = (await res.json()) as { ok: boolean; error?: { message: string } };
  return { status: res.status, message: json.error?.message ?? "" };
}
const NO_VERSION = { v: undefined };

await test("a new backup: 5 a day per connection; saving to one that exists always goes through", async () => {
  const ids = Array.from({ length: 5 }, hex64);
  for (const id of ids) assert.equal((await put("203.0.113.10", id)).status, 200);
  const sixth = await put("203.0.113.10", hex64());
  assert.equal(sixth.status, 429, "the sixth new backup from one connection waits for tomorrow");
  // saving to a backup that exists is never counted
  for (let n = 2; n <= 40; n++) assert.equal((await put("203.0.113.10", ids[0]!, n)).status, 200, `update ${n}`);
  // another connection still makes its own
  assert.equal((await put("198.51.100.20", hex64())).status, 200);
});

await test("an IPv6 /48 is one connection for new backups, however many /64s it rotates through", async () => {
  for (let i = 1; i <= 5; i++) assert.equal((await put(`2001:db8:7:${i}::1`, hex64())).status, 200, `/64 number ${i}`);
  const sixth = await put("2001:db8:7:ffff::1", hex64());
  assert.equal(sixth.status, 429, "a sixth /64 in the same /48 waits for tomorrow");
  assert.match(sixth.message, /this connection/);
  // written differently, still the same /48
  assert.equal((await put("2001:0DB8:0007:0::2", hex64())).status, 429);
  // the next /48 along is someone else
  assert.equal((await put("2001:db8:8::1", hex64())).status, 200);
});

await test("the /48 applies to new backups only: every other limit still counts an IPv6 /64, and clientIp is untouched", async () => {
  assert.equal(ipBucket("2001:db8:7:9::1"), "2001:db8:7:9::/64", "the default");
  assert.equal(ipBucket("2001:db8:7:9::1", 48), "2001:db8:7::/48");
  assert.equal(ipBucket("2001:DB8:0007:0009:aaaa:bbbb:cccc:dddd", 48), "2001:db8:7::/48");
  assert.equal(ipBucket("2001:db8::1", 48), "2001:db8:0::/48");
  assert.equal(ipBucket("::1", 48), "0:0:0::/48");
  assert.equal(ipBucket("203.0.113.10", 48), "203.0.113.10", "IPv4 is an address either way");
  assert.equal(ipBucket("::ffff:203.0.113.10", 48), "203.0.113.10", "and so is IPv4 written as IPv6");
  assert.equal(ipBucket("local", 48), "local");

  const req = new Request("http://localhost/", { headers: { "x-forwarded-for": "2001:db8:7:9::1, 10.0.0.1" } });
  assert.equal(clientIp(req), "2001:db8:7:9::1", "clientIp still gives the plain address");

  // another limit, same two /64s in one /48: counted apart
  for (let i = 0; i < 3; i++) assert.ok((await hitRateLimit("2001:db8:1:1::1", "recovery", 3)).allowed);
  assert.equal((await hitRateLimit("2001:db8:1:1::2", "recovery", 3)).allowed, false, "same /64, spent");
  assert.ok((await hitRateLimit("2001:db8:1:2::1", "recovery", 3)).allowed, "the next /64 has its own count");

  // saving to a backup that exists is still not counted against anything daily
  const id = hex64();
  for (let i = 0; i < 2; i++) assert.equal((await put("2001:db8:9:1::1", i ? id : hex64())).status, 200);
  for (let n = 2; n <= 8; n++) assert.equal((await put(`2001:db8:9:${n}::1`, id, n)).status, 200, `update ${n}`);
});

await test("a save says whether the id held anything, so a browser can tell its backup has gone", async () => {
  const id = hex64();
  const created = async (n: number) => {
    const res = await PUT(
      new Request("http://localhost/api/recovery", {
        method: "PUT",
        headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.70" },
        body: JSON.stringify({ id, write: WRITE, c: BLOB, n, v: 2 }),
      })
    );
    return ((await res.json()) as { data: { created: boolean } }).data.created;
  };
  assert.equal(await created(1), true);
  assert.equal(await created(2), false);
});

await test("the daily budget for new backups: past it, new ones are told to try again later and it is logged once; existing ones keep saving", async () => {
  process.env.GLOAM_RECOVERY_NEW_PER_DAY = "3";
  const warn = console.warn;
  const logged: string[] = [];
  console.warn = (...a: unknown[]) => void logged.push(a.map(String).join(" "));
  try {
    const mine = hex64();
    assert.equal((await put("192.0.2.1", mine)).status, 200);
    assert.equal((await put("192.0.2.2", hex64())).status, 200);
    assert.equal((await put("192.0.2.3", hex64())).status, 200);
    for (const ip of ["192.0.2.4", "192.0.2.5", "192.0.2.6"]) {
      const r = await put(ip, hex64());
      assert.equal(r.status, 429, ip);
      assert.match(r.message, /try again later/i);
    }
    assert.equal(logged.filter((l) => l.includes("gloam_recovery_new_budget_full")).length, 1, "logged once");
    // someone with a backup is never affected
    assert.equal((await put("192.0.2.4", mine, 2)).status, 200);
    const read = await GET(new Request(`http://localhost/api/recovery?id=${mine}`, { headers: { "x-forwarded-for": "192.0.2.9" } }));
    assert.equal(read.status, 200);
  } finally {
    console.warn = warn;
  }
});

await test("a request that is not a valid backup is refused before it counts", async () => {
  for (const bad of ["not base64!", "", "A".repeat(600_000)]) {
    const r = await put("203.0.113.50", hex64(), 1, bad);
    assert.ok(r.status === 400 || r.status === 413, `refused: ${r.status}`);
  }
  const zero = await PUT(
    new Request("http://localhost/api/recovery", {
      method: "PUT",
      headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.50" },
      body: JSON.stringify({ id: hex64(), write: WRITE, c: BLOB, n: 0, v: 2 }),
    })
  );
  assert.equal(zero.status, 400);
  // the connection still has all five of its new backups
  for (let i = 0; i < 5; i++) assert.equal((await put("203.0.113.50", hex64())).status, 200);
});

await test("a full-size backup still fits", async () => {
  const big = "A".repeat(511_996) + "AA==";
  assert.equal((await put("203.0.113.60", hex64(), 1, big)).status, 200);
  assert.equal((await put("203.0.113.60", hex64(), 1, big + "AAAA")).status, 400);
});

const held = async (id: string) =>
  (await GET(new Request(`http://localhost/api/recovery?id=${id}`, { headers: { "x-forwarded-for": "203.0.113.90" } }))).status === 200;
const rawRecord = async (id: string) => JSON.parse(String((await kv([["GET", `gloam:recovery:v1:${id}`]]))[0])) as Record<string, unknown>;

await test("mustExist with nothing there: a 410, nothing written, and no new backup spent", async () => {
  const ip = "203.0.113.80";
  for (let i = 0; i < 12; i++) {
    const id = hex64();
    assert.equal((await put(ip, id, 2, BLOB, { mustExist: true })).status, 410);
    assert.equal(await held(id), false, "the id still holds nothing");
  }
  // the connection still has all five of its new backups
  for (let i = 0; i < 5; i++) assert.equal((await put(ip, hex64())).status, 200);
});

await test("mustExist goes by its own answer when the day's budget is spent, and is limited per connection", async () => {
  process.env.GLOAM_RECOVERY_NEW_PER_DAY = "1";
  assert.equal((await put("192.0.2.40", hex64())).status, 200);
  assert.equal((await put("192.0.2.41", hex64())).status, 429, "the budget is spent");
  assert.equal((await put("192.0.2.42", hex64(), 2, BLOB, { mustExist: true })).status, 410, "this one is told the backup is gone");
  for (let i = 0; i < 59; i++) await put("192.0.2.43", hex64(), 2, BLOB, { mustExist: true });
  const last = await put("192.0.2.43", hex64(), 2, BLOB, { mustExist: true });
  assert.equal(last.status, 410);
  assert.equal((await put("192.0.2.43", hex64(), 2, BLOB, { mustExist: true })).status, 429, "past a minute's limit it waits");
});

await test("mustExist with a backup there: it saves as usual", async () => {
  const id = hex64();
  assert.equal((await put("203.0.113.81", id)).status, 200);
  assert.equal((await put("203.0.113.81", id, 2, BLOB, { mustExist: true })).status, 200);
  const r = await put("203.0.113.81", id, 2, BLOB, { mustExist: true });
  assert.equal(r.status, 409, "a stale version is still refused");
});

await test("a newer key without the flag still makes a new backup", async () => {
  const id = hex64();
  assert.equal((await put("203.0.113.82", id, 2, BLOB, { mustExist: "yes" })).status, 200, "only true counts");
  assert.equal(await held(id), true);
});

/* ------------------------------------------------------------ the end date, on the server */

const DAY = 86_400_000;
const BEFORE_THE_END = VERSION1_SAVES_UNTIL - 30 * DAY;
const AFTER_THE_END = VERSION1_SAVES_UNTIL + DAY;
const atTime = (ms: number) => setRecoveryClock(() => ms);
const marker = async (id: string) => (await rawRecord(id)).v;

/** Spends a connection's five new backups and shows they were all still there. */
async function stillHasAllFive(ip: string) {
  for (let i = 0; i < 5; i++) assert.equal((await put(ip, hex64())).status, 200, `new backup ${i + 1}`);
  assert.equal((await put(ip, hex64())).status, 429);
}

await test("no version, new id, before the end date: a 410, nothing written, nothing spent", async () => {
  atTime(BEFORE_THE_END);
  const ip = "203.0.113.100";
  for (let i = 0; i < 8; i++) {
    const id = hex64();
    const r = await put(ip, id, 1, BLOB, NO_VERSION);
    assert.equal(r.status, 410, "even with n = 1, the way a first save looks");
    assert.equal(await held(id), false);
  }
  await stillHasAllFive(ip);
});

await test("no version, new id, today's real clock: refused too, not only past the date", async () => {
  const id = hex64();
  assert.equal((await put("203.0.113.101", id, 1, BLOB, NO_VERSION)).status, 410);
  assert.equal(await held(id), false);
});

await test("no version goes by its own answer when the day's budget is spent, and spends none of it", async () => {
  atTime(BEFORE_THE_END);
  process.env.GLOAM_RECOVERY_NEW_PER_DAY = "1";
  assert.equal((await put("192.0.2.60", hex64(), 2, BLOB, NO_VERSION)).status, 410);
  assert.equal((await put("192.0.2.61", hex64())).status, 200, "the one new backup of the day is still there");
  assert.equal((await put("192.0.2.62", hex64(), 2, BLOB, NO_VERSION)).status, 410, "and it isn't told to wait for tomorrow");
});

await test("no version, existing id: it saves until the end date, up to the last moment", async () => {
  const id = hex64();
  atTime(BEFORE_THE_END);
  assert.equal((await put("203.0.113.102", id, 1)).status, 200);
  assert.equal((await put("203.0.113.102", id, 2, BLOB, NO_VERSION)).status, 200);
  atTime(VERSION1_SAVES_UNTIL - 1);
  assert.equal((await put("203.0.113.102", id, 3, BLOB, NO_VERSION)).status, 200);
  assert.equal((await readBackup(id))!.n, 3);
  atTime(VERSION1_SAVES_UNTIL);
  assert.equal((await put("203.0.113.102", id, 4, BLOB, NO_VERSION)).status, 410, "refused from the first moment of the date");
  assert.equal((await readBackup(id))!.n, 3);
});

await test("no version, existing id, the usual checks still apply", async () => {
  atTime(BEFORE_THE_END);
  const id = hex64();
  assert.equal((await put("203.0.113.103", id, 2)).status, 200);
  assert.equal((await put("203.0.113.103", id, 2, BLOB, NO_VERSION)).status, 409);
  assert.equal(
    (await PUT(new Request("http://localhost/api/recovery", { method: "PUT", body: JSON.stringify({ id, write: "c".repeat(64), c: BLOB, n: 3 }) }))).status,
    403
  );
});

await test("no version, after the end date: refused on a new id and an existing one, nothing written or spent", async () => {
  atTime(BEFORE_THE_END);
  const ip = "203.0.113.104";
  const mine = hex64();
  assert.equal((await put(ip, mine, 1, BLOB)).status, 200);
  const before = await readBackup(mine);
  (globalThis as { __gloamMcpRate?: Map<string, unknown> }).__gloamMcpRate?.clear();
  atTime(AFTER_THE_END);
  const statuses = new Set<number>();
  for (let i = 0; i < 80; i++) {
    const fresh = hex64();
    statuses.add((await put(ip, fresh, 1, BLOB, NO_VERSION)).status);
    assert.equal(await held(fresh), false);
  }
  assert.deepEqual([...statuses], [410], "past any per-minute limit too: nothing is counted");
  assert.equal((await put(ip, mine, 2, BLOB, NO_VERSION)).status, 410);
  assert.equal((await put(ip, mine, 2, BLOB, { ...NO_VERSION, mustExist: true })).status, 410, "as a current version 1 browser sends it");
  assert.deepEqual(await readBackup(mine), before, "the backup is as it was");
  await stillHasAllFive(ip);
});

await test("the refusal after the end date doesn't claim the backup is gone", async () => {
  atTime(AFTER_THE_END);
  const { message } = await put("203.0.113.105", hex64(), 1, BLOB, NO_VERSION);
  assert.doesNotMatch(message, /isn't on the server/);
});

await test("a bad request stays a 400 after the end date", async () => {
  atTime(AFTER_THE_END);
  assert.equal((await put("203.0.113.106", hex64(), 1, "not base64!", NO_VERSION)).status, 400);
  assert.equal((await put("203.0.113.106", "nope", 1, BLOB, NO_VERSION)).status, 400);
});

await test("only v: 2 is the marker", async () => {
  atTime(BEFORE_THE_END);
  for (const v of ["2", 1, 3, 2.5, true, null, [2], {}]) {
    const id = hex64();
    assert.equal((await put("203.0.113.107", id, 1, BLOB, { v })).status, 410, `v: ${JSON.stringify(v)}`);
    assert.equal(await held(id), false);
  }
});

await test("version 2 after the end date: a new backup, the next save, and a backup from before the marker", async () => {
  const old = hex64();
  atTime(BEFORE_THE_END);
  assert.equal((await put("203.0.113.108", old, 1)).status, 200);
  await kv([["SET", `gloam:recovery:v1:${old}`, JSON.stringify({ ...(await rawRecord(old)), v: undefined })]]);
  assert.equal(await marker(old), undefined, "a record from before the marker");

  atTime(AFTER_THE_END);
  const fresh = hex64();
  assert.equal((await put("203.0.113.108", fresh, 1)).status, 200, "a first-time user");
  assert.equal(await marker(fresh), 2);
  assert.equal((await put("203.0.113.108", fresh, 2)).status, 200, "and their next save");
  assert.equal((await put("203.0.113.108", old, 2)).status, 200, "the old record's next save");
  assert.equal(await marker(old), 2, "and it carries the marker from here");
  assert.equal((await put("203.0.113.108", old, 3)).status, 200);
});

await test("a marked record doesn't excuse a save with no version: the date goes by the request", async () => {
  const id = hex64();
  atTime(BEFORE_THE_END);
  assert.equal((await put("203.0.113.109", id, 1)).status, 200);
  assert.equal(await marker(id), 2);
  assert.equal((await put("203.0.113.109", id, 2, BLOB, NO_VERSION)).status, 200, "a tab on an earlier build, before the date");
  assert.equal(await marker(id), 2, "doesn't take the marker off");
  atTime(AFTER_THE_END);
  assert.equal((await put("203.0.113.109", id, 3, BLOB, NO_VERSION)).status, 410, "and is refused after it");
  assert.equal((await readBackup(id))!.n, 2);
});

await test("no version, a backup deleted just after the save saw it: it stays deleted", async () => {
  atTime(BEFORE_THE_END);
  const ip = "203.0.113.113";
  const id = hex64();
  assert.equal((await put(ip, id, 1)).status, 200);
  // The save is counted once it has seen the backup there, so another device deletes it at that moment.
  const counts = (globalThis as unknown as { __gloamMcpRate: Map<string, unknown> }).__gloamMcpRate;
  counts.get = function (this: Map<string, unknown>, key: string) {
    if (key.includes("recovery-save")) void kv([["DEL", `gloam:recovery:v1:${id}`]]);
    return Map.prototype.get.call(this, key);
  };
  try {
    assert.equal((await put(ip, id, 2, BLOB, NO_VERSION)).status, 410);
  } finally {
    delete (counts as unknown as { get?: unknown }).get;
  }
  assert.equal(await held(id), false, "the save doesn't bring it back");
});

await test("reads stay open and deletes still need the token, past the end date", async () => {
  const id = hex64();
  atTime(BEFORE_THE_END);
  assert.equal((await put("203.0.113.110", id, 1)).status, 200);
  await kv([["SET", `gloam:recovery:v1:${id}`, JSON.stringify({ ...(await rawRecord(id)), v: undefined })]]);
  atTime(AFTER_THE_END);
  const read = await GET(new Request(`http://localhost/api/recovery?id=${id}`, { headers: { "x-forwarded-for": "203.0.113.111" } }));
  assert.equal(read.status, 200);
  assert.deepEqual(Object.keys(((await read.json()) as { data: object }).data).sort(), ["c", "n", "t"], "what a read has always shown");
  const del = (write: string) =>
    DELETE(new Request("http://localhost/api/recovery", { method: "DELETE", body: JSON.stringify({ id, write }), headers: { "x-forwarded-for": "203.0.113.112" } }));
  assert.equal((await del("c".repeat(64))).status, 403);
  assert.ok(await held(id), "nothing goes by itself");
  assert.equal((await del(WRITE)).status, 200);
  assert.equal(await held(id), false);
});

console.log(`\nrecovery route: ${passed} passed`);
