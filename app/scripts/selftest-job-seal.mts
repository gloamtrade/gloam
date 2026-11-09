/**
 * Self-test: scheduled jobs sealed at rest (lib/relay/jobSeal, scheduledStore).
 *
 * What a seal is: AES-256-GCM, bound to its job, under a key that is 32 bytes or
 * no key at all. What Redis ends up holding: the whole store is dumped, keys and
 * values, and nothing in it gives away a proof, a public input or a webhook, in
 * any spelling. Without a key: a cash out in a window is stored as ever and a
 * dated job is refused, at the route and at the store. Jobs stored in plain text
 * run out their life and are sealed when next saved. A job sealed with a key the
 * relay lacks is never "gone": it stays on record and in the queue, the app is
 * told nothing changed, and it doesn't hold up what is behind it. If that key
 * never comes back the job runs out on the TTL it had, and the app reads it as
 * gone. Then rotation: an old key keeps opening what it sealed, the cron re-seals
 * under the new one without losing a TTL or a run's newer save.
 *
 * fetch is stubbed; keys are made here.
 *
 * Run from app/:  ../mcp/node_modules/.bin/tsx scripts/selftest-job-seal.mts
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import "./browser-shim.mjs";
import { toFunctionSelector, toHex, type Address, type Hex } from "viem";
import { generatePrivateKey } from "viem/accounts";

delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;
delete process.env.CHAINALYSIS_API_KEY;
delete process.env.GLOAM_RELAY_JOB_KEY;
delete process.env.GLOAM_RELAY_JOB_KEYS_OLD;
process.env.GLOAM_RELAYER_PRIVATE_KEY = generatePrivateKey();

const { JobSealError, jobKeyReady, pointerTags, rotating, seal, sealedWithOldKey, unseal } = await import("../src/lib/relay/jobSeal");
const { packJob, scheduledStore, unpackJob } = await import("../src/lib/relay/scheduledStore");
const { cancelJob, DAY_MS, dayOf, memoryJobStore, replaceJobProof, runDueJobs } = await import("../src/lib/relay/scheduled");
const { cashOutJobStatus } = await import("../src/lib/cashOutLater");
const { getActiveNetwork } = await import("../src/lib/networks");
const route = await import("../src/app/api/relay/scheduled/route");
type CashOutJob = import("../src/lib/relay/scheduled").CashOutJob;
type JobStore = import("../src/lib/relay/scheduled").JobStore;

let passed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  await fn();
  passed++;
  console.log(`ok  ${name}`);
}

const KEY_A = randomBytes(32).toString("hex");
const KEY_B = randomBytes(32).toString("base64");
const setKeys = (current?: string, old?: string) => {
  if (current) process.env.GLOAM_RELAY_JOB_KEY = current;
  else delete process.env.GLOAM_RELAY_JOB_KEY;
  if (old) process.env.GLOAM_RELAY_JOB_KEYS_OLD = old;
  else delete process.env.GLOAM_RELAY_JOB_KEYS_OLD;
};

const T0 = 1_800_000_000_000;
const hex32 = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const TO = "0xAbCd1111111111111111111111111111111111Ef" as Address;
const ASSET = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as Address;
const HOOK = "https://hooks.example.com/owner/9f3a";
const PROOF = ("0x" + "2b7e".repeat(128)) as Hex;

let seq = 0;
function job(over: Partial<CashOutJob> = {}): CashOutJob {
  seq++;
  return {
    id: `00000000-0000-4000-8000-${seq.toString(16).padStart(12, "0")}`,
    chainId: 4663,
    proof: PROOF,
    root: hex32(0xa1b2c3 + seq),
    nullifier: hex32(0xd4e5f6 + seq),
    asset: ASSET,
    to: TO,
    amount: "1234567891",
    createdAt: Date.now(),
    sendAfter: Date.now() + 40 * DAY_MS,
    status: "scheduled",
    attempts: 0,
    updatedAt: Date.now(),
    ...over,
  };
}

// ---------------------------------------------------------------- the seal

await test("a seal opens with its key and what it is bound to, and with nothing else", () => {
  setKeys(KEY_A);
  const s = seal("the proof", "job-1:4663");
  assert.equal(unseal(s, "job-1:4663"), "the proof");
  assert.notEqual(seal("the proof", "job-1:4663"), s, "a fresh IV each time");
  assert.throws(() => unseal(s, "job-2:4663"), JobSealError, "another job");
  assert.throws(() => unseal(s, "job-1:1"), JobSealError, "another chain");
  const parts = s.split(".");
  const flip = (i: number) => {
    const p = [...parts];
    const b = Buffer.from(p[i]!, "base64url");
    b[0]! ^= 1;
    p[i] = b.toString("base64url");
    return p.join(".");
  };
  for (const i of [2, 3, 4]) assert.throws(() => unseal(flip(i), "job-1:4663"), JobSealError, `part ${i} tampered`);
  assert.throws(() => unseal("not a seal", "x"), JobSealError);
  assert.throws(() => unseal(`${s}.extra`, "job-1:4663"), JobSealError);
  setKeys(KEY_B);
  assert.throws(() => unseal(s, "job-1:4663"), JobSealError, "another key");
  setKeys();
  assert.throws(() => unseal(s, "job-1:4663"), JobSealError, "no key");
  assert.throws(() => seal("x", "y"), JobSealError, "and never sealed with none");
});

await test("the key is 32 bytes, as hex or base64, or there is no key", () => {
  for (const good of [KEY_A, KEY_B, `  ${KEY_A}\n`]) {
    setKeys(good);
    assert.equal(jobKeyReady(), true, good);
  }
  const warn = console.warn;
  console.warn = () => {};
  try {
    for (const bad of ["short", "00".repeat(31), "00".repeat(33), randomBytes(16).toString("base64"), "not base64 at all !!"]) {
      setKeys(bad);
      assert.equal(jobKeyReady(), false, bad);
    }
  } finally {
    console.warn = warn;
  }
  setKeys();
  assert.equal(jobKeyReady(), false);
  assert.deepEqual(pointerTags(hex32(1)), []);
});

// ---------------------------------------------------------------- Redis

/** Upstash, as far as the store uses it. `dump` is everything anyone with read access would see. */
function fakeRedis() {
  const kv = new Map<string, string>();
  const ttls = new Map<string, number | "kept">();
  const zset = new Map<string, number>();
  const exec = (a: (string | number)[]): unknown => {
    switch (a[0]) {
      case "SET": {
        const [, k, v] = a;
        if (a.includes("NX") && kv.has(String(k))) return null;
        kv.set(String(k), String(v));
        const ex = a.indexOf("EX");
        if (ex > 0) ttls.set(String(k), Number(a[ex + 1]));
        else if (a.includes("KEEPTTL")) ttls.set(`${k}:kept`, "kept");
        return "OK";
      }
      case "GET":
        return kv.get(String(a[1])) ?? null;
      case "EXPIRE":
        ttls.set(String(a[1]), Number(a[2]));
        return 1;
      case "ZADD":
        zset.set(String(a[3]), Number(a[2]));
        return 1;
      case "ZREM":
        return zset.delete(String(a[2])) ? 1 : 0;
      case "ZRANGE":
        return [...zset.entries()].sort((x, y) => x[1] - y[1]).map(([id]) => id).slice(Number(a[2]), Number(a[3]) + 1);
      case "ZRANGEBYSCORE":
        return [...zset.entries()].filter(([, s]) => s <= Number(a[3])).sort((x, y) => x[1] - y[1]).map(([id]) => id).slice(0, Number(a[6]));
      case "EVAL": {
        if (a[2] === 1) return kv.delete(String(a[3])) ? 1 : 0;
        const [nf, rec, , id, json, ttl, score] = a.slice(3);
        const cur = kv.get(String(nf));
        if (cur && cur !== id) return cur;
        kv.set(String(rec), String(json));
        ttls.set(String(rec), Number(ttl));
        zset.set(String(id), Number(score));
        kv.set(String(nf), String(id));
        ttls.set(String(nf), Number(ttl));
        return id;
      }
      default:
        throw new Error(`fake redis: ${a[0]}`);
    }
  };
  return { kv, ttls, zset, exec, dump: () => JSON.stringify([...kv.entries(), ...zset.entries()]).toLowerCase() };
}

const realFetch = globalThis.fetch;
async function withRedis<T>(fn: (r: ReturnType<typeof fakeRedis>, store: JobStore) => Promise<T>): Promise<T> {
  const r = fakeRedis();
  process.env.UPSTASH_REDIS_REST_URL = "https://redis.selftest.invalid";
  process.env.UPSTASH_REDIS_REST_TOKEN = "selftest";
  globalThis.fetch = (async (_u: string | URL | Request, init?: RequestInit) =>
    new Response(JSON.stringify({ result: r.exec(JSON.parse(String(init?.body))) }), { status: 200 })) as typeof fetch;
  try {
    return await fn(r, scheduledStore());
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
  }
}
const rec = (j: CashOutJob) => `gloam:cashout:job:${j.id}`;
const secrets = (j: CashOutJob) => [
  j.proof,
  j.proof.slice(2),
  j.proof.slice(2, 66),
  j.root,
  j.root.slice(2),
  j.nullifier,
  j.nullifier.slice(2),
  j.asset,
  j.asset.slice(2),
  j.to,
  j.to.slice(2),
  j.amount,
  ...(j.webhook ? [j.webhook.url, "hooks.example.com", j.webhook.series] : []),
];

await test("with read access to everything in Redis, no proof, input or webhook shows, in any spelling", async () => {
  setKeys(KEY_A);
  await withRedis(async (r, store) => {
    const j = job({ dated: true, webhook: { url: HOOK, series: "series-7f2c" } });
    await store.create(j);
    const later = { ...j, attempts: 1, notBefore: j.sendAfter + 1 };
    await store.put(later);
    const dump = r.dump();
    for (const s of secrets(j)) assert.ok(!dump.includes(s.toLowerCase()), `Redis shows ${s.slice(0, 18)}`);
    assert.deepEqual(await store.get(j.id), later, "and the relay reads back exactly what it wrote");
    assert.equal(await store.byNullifier(j.chainId, j.nullifier), j.id, "and still finds a spend's job");
    // what stays readable is only what the queue needs
    const kept = JSON.parse(r.kv.get(rec(j))!) as Record<string, unknown>;
    assert.deepEqual(Object.keys(kept).sort(), ["attempts", "chainId", "createdAt", "dated", "id", "notBefore", "sealed", "sendAfter", "status", "updatedAt"]);
  });
});

await test("a finished job stays sealed too, and a seal can't be moved onto another job", async () => {
  setKeys(KEY_A);
  await withRedis(async (r, store) => {
    const j = job({ dated: true });
    await store.create(j);
    await store.put({ ...j, status: "sent", proof: "0x", hash: hex32(9) });
    for (const s of secrets(j).slice(3)) assert.ok(!r.dump().includes(s.toLowerCase()), s.slice(0, 18));
    const a = job({ dated: true });
    const b = job({ dated: true });
    await store.create(a);
    await store.create(b);
    const stolen = JSON.parse(r.kv.get(rec(a))!) as { sealed: string };
    const onB = JSON.parse(r.kv.get(rec(b))!) as { sealed: string };
    r.kv.set(rec(b), JSON.stringify({ ...onB, sealed: stolen.sealed }));
    await assert.rejects(store.get(b.id), JobSealError);
  });
});

await test("without a key a cash out in a window is kept as ever, and a dated job is never written, even past the route", async () => {
  setKeys();
  await withRedis(async (r, store) => {
    const plain = job({ sendAfter: Date.now() + 60_000 });
    await store.create(plain);
    assert.equal(JSON.parse(r.kv.get(rec(plain))!).proof, PROOF);
    assert.ok(r.kv.has(`gloam:cashout:nf:${plain.chainId}:${plain.nullifier}`), "the pointer as it always was");
    assert.deepEqual(await store.get(plain.id), plain);
    const before = r.kv.size;
    const dated = job({ dated: true });
    await assert.rejects(store.create(dated), JobSealError);
    await assert.rejects(store.put(dated), JobSealError);
    assert.throws(() => packJob(dated), JobSealError);
    assert.equal(r.kv.size, before, "nothing written");
    assert.ok(!r.dump().includes(dated.nullifier));
  });
});

await test("a job stored in plain text runs out its life, and is sealed the next time it is saved", async () => {
  setKeys();
  await withRedis(async (r, store) => {
    const old = job({ sendAfter: Date.now() + 3_600_000 });
    await store.create(old);
    setKeys(KEY_A);
    assert.deepEqual(await store.get(old.id), old, "reads as it is");
    assert.equal(await store.byNullifier(old.chainId, old.nullifier), old.id, "found under its bare pointer");
    const next = { chainId: old.chainId, proof: "0xfeed" as Hex, root: hex32(0x99), nullifier: old.nullifier, asset: old.asset, to: old.to, amount: old.amount };
    assert.equal((await replaceJobProof(store, old.id, next, Date.now())).ok, true);
    const kept = JSON.parse(r.kv.get(rec(old))!) as { sealed?: string; proof?: string };
    assert.ok(kept.sealed, "sealed by that save");
    assert.equal(kept.proof, undefined);
    assert.equal(await store.byNullifier(old.chainId, old.nullifier), old.id, "and found under its tag");
    // and it goes out like any other
    const sends: string[] = [];
    const due = await runDueJobs(store, {
      now: () => old.sendAfter,
      readChain: async () => ({ spent: false, knownRoot: true }),
      send: async (j) => {
        sends.push(j.nullifier);
        return hex32(1);
      },
    });
    assert.deepEqual(due, [{ id: old.id, status: "sent" }]);
    assert.deepEqual(sends, [old.nullifier], "with the real inputs");
  });
});

await test("a job sealed with a key the relay lacks is not gone: it stays, and nothing else waits on it", async () => {
  setKeys(KEY_A);
  await withRedis(async (r, store) => {
    const sealedJobs = Array.from({ length: 25 }, () => job({ dated: true, sendAfter: T0 }));
    for (const j of sealedJobs) await store.create(j);
    setKeys();
    const plain = job({ sendAfter: T0 + 1 });
    await store.create(plain);
    await assert.rejects(store.get(sealedJobs[0]!.id), JobSealError);
    await assert.rejects(cancelJob(store, sealedJobs[0]!.id, T0, sealedJobs[0]!.nullifier), JobSealError);
    const deps = { now: () => T0 + 10, readChain: async () => ({ spent: false, knownRoot: true }), send: async () => hex32(1) };
    const first = await runDueJobs(store, deps);
    assert.equal(first.length, 20);
    assert.ok(first.every((x) => x.status === "skipped"));
    for (const j of sealedJobs) assert.ok(r.kv.has(rec(j)), "the record stays");
    assert.ok(sealedJobs.every((j) => r.zset.has(j.id)), "and stays in the queue");
    const second = await runDueJobs(store, deps);
    assert.ok(second.some((x) => x.id === plain.id && x.status === "sent"), "the plain job behind them goes out");
    // the key comes back: nothing was lost
    setKeys(KEY_A);
    const j = (await store.get(sealedJobs[0]!.id))!;
    assert.equal(j.proof, PROOF);
    assert.equal(j.status, "scheduled");
  });
});

// ---------------------------------------------------------------- rotation

await test("rotation: the old key keeps opening what it sealed, and new saves use the new one", async () => {
  setKeys(KEY_A);
  await withRedis(async (r, store) => {
    const j = job({ dated: true });
    await store.create(j);
    setKeys(KEY_B, KEY_A);
    assert.equal(rotating(), true);
    assert.deepEqual(await store.get(j.id), j);
    assert.equal(await store.byNullifier(j.chainId, j.nullifier), j.id, "its pointer is under the old key's tag");
    assert.equal(sealedWithOldKey((JSON.parse(r.kv.get(rec(j))!) as { sealed: string }).sealed), true);
    await store.put({ ...j, attempts: 1 });
    assert.equal(sealedWithOldKey((JSON.parse(r.kv.get(rec(j))!) as { sealed: string }).sealed), false);
    assert.equal(await store.byNullifier(j.chainId, j.nullifier), j.id);
    setKeys(KEY_B);
    assert.equal((await store.get(j.id))!.attempts, 1, "the old key can go");
  });
});

await test("rotation: the cron re-seals what is waiting, keeps its TTL and leaves a job a run holds alone", async () => {
  setKeys(KEY_A);
  await withRedis(async (r, store) => {
    const jobs = Array.from({ length: 7 }, () => job({ dated: true }));
    for (const j of jobs) await store.create(j);
    const held = jobs[1]!;
    assert.equal(await store.reseal!(10), 0, "nothing to do without an old key");
    assert.equal(rotating(), false);
    setKeys(KEY_B, KEY_A);
    const release = (await store.lock(held.id, 30))!;
    const sealedOld = (j: CashOutJob) => sealedWithOldKey((JSON.parse(r.kv.get(rec(j))!) as { sealed: string }).sealed);
    assert.equal(await store.reseal!(4), 3, "three of the first four: one is locked");
    assert.equal(sealedOld(held), true, "a run holds it: an older copy must not land on its save");
    assert.equal(await store.reseal!(4), 3, "the cursor moved on");
    await release();
    assert.equal(await store.reseal!(4), 1, "the round starts again and finds the one it left");
    assert.equal(await store.reseal!(4), 0, "and then nothing is left");
    assert.ok(jobs.every((j) => !sealedOld(j)));
    assert.ok(jobs.every((j) => r.ttls.get(`${rec(j)}:kept`) === "kept"), "re-sealed with its TTL kept");
    setKeys(KEY_B);
    for (const j of jobs) assert.deepEqual(await store.get(j.id), j);
  });
});

await test("rotation: a job no key opens is skipped, and a job in plain text is sealed along the way", async () => {
  setKeys();
  await withRedis(async (r, store) => {
    const plain = job({ sendAfter: Date.now() + 3_600_000 });
    await store.create(plain);
    setKeys(randomBytes(32).toString("hex"));
    const lost = job({ dated: true });
    await store.create(lost);
    setKeys(KEY_B, KEY_A);
    assert.equal(await store.reseal!(10), 1);
    assert.ok((JSON.parse(r.kv.get(rec(plain))!) as { sealed?: string }).sealed);
    assert.ok(r.kv.has(rec(lost)), "left where it is");
  });
});

// ---------------------------------------------------------------- the route

const net = getActiveNetwork();
assert.ok(net.pool);
const RPC = net.chain.rpcUrls.default.http[0];
const SEL = { spent: toFunctionSelector("spent(bytes32)"), isKnownRoot: toFunctionSelector("isKnownRoot(bytes32)") };
const word = (b: boolean) => "0x" + (b ? "1" : "0").padStart(64, "0");
const Z32 = "0x" + "00".repeat(32);
const BLOCK = { number: "0x7", hash: "0x" + "12".repeat(32), parentHash: Z32, nonce: "0x0000000000000000", sha3Uncles: Z32, logsBloom: "0x" + "00".repeat(256), transactionsRoot: Z32, stateRoot: Z32, receiptsRoot: Z32, miner: "0x" + "00".repeat(20), difficulty: "0x0", totalDifficulty: "0x0", extraData: "0x", size: "0x1", gasLimit: "0x1c9c380", gasUsed: "0x0", timestamp: "0x1", baseFeePerGas: "0x1", transactions: [], uncles: [] };
let rpcCalls = 0;
function answer(r: { method: string; params?: unknown[] }): object {
  switch (r.method) {
    case "eth_chainId":
      return { result: toHex(net.chainId) };
    case "eth_blockNumber":
      return { result: "0x7" };
    case "eth_getBlockByNumber":
      return { result: BLOCK };
    case "eth_getTransactionCount":
      return { result: "0x0" };
    case "eth_gasPrice":
    case "eth_maxPriorityFeePerGas":
      return { result: "0x1" };
    case "eth_getBalance":
      return { result: toHex(10n ** 18n) };
    case "eth_estimateGas":
      return { result: "0x1b7740" };
    case "eth_call": {
      const sel = String((r.params?.[0] as { data?: string }).data).slice(0, 10);
      return sel === SEL.spent ? { result: word(false) } : sel === SEL.isKnownRoot ? { result: word(true) } : { error: { code: -32000, message: "unknown" } };
    }
    default:
      return { error: { code: -32601, message: r.method } };
  }
}
function fakeNode() {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith("/api/relay/scheduled")) {
      const id = new URL(url, "http://x").searchParams.get("id");
      return route.GET(call("GET", id));
    }
    rpcCalls++;
    if (url.replace(/\/$/, "") !== RPC.replace(/\/$/, "")) throw new Error(`selftest: no network (${url})`);
    const body = JSON.parse(String(init?.body)) as { id: number; method: string; params?: unknown[] } | { id: number; method: string; params?: unknown[] }[];
    const list = Array.isArray(body) ? body : [body];
    const out = list.map((r) => ({ jsonrpc: "2.0", id: r.id, ...answer(r) }));
    return new Response(JSON.stringify(Array.isArray(body) ? out : out[0]), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
}
const call = (method: string, id: string | null, payload?: unknown, ip = "10.5.0.1") =>
  new Request(`http://localhost/api/relay/scheduled${id ? `?id=${id}` : ""}`, {
    method,
    headers: { "Content-Type": "application/json", "x-forwarded-for": ip },
    ...(payload ? { body: JSON.stringify(payload) } : {}),
  });
let nfSeq = 0x4000;
const scheduleBody = (over: object = {}) => ({ chainId: net.chainId, proof: PROOF, root: hex32(0x77), nullifier: hex32(++nfSeq), asset: ASSET.toLowerCase(), to: TO.toLowerCase(), amount: "5000000", ...over });
const tomorrow = () => dayOf(Date.now()) + DAY_MS;

await test("until the owner sets the key, dated jobs stay off and short cash outs keep working", async () => {
  setKeys();
  fakeNode();
  const before = rpcCalls;
  const dated = await route.POST(call("POST", null, scheduleBody({ day: tomorrow() })));
  const json = (await dated.json()) as { ok: boolean; code: string; error: string };
  assert.deepEqual([dated.status, json.ok, json.code], [503, false, "dated_no_key"]);
  assert.match(json.error, /aren't switched on yet\. Nothing was set aside/);
  assert.equal(rpcCalls, before, "refused before any chain read");
  for (const window of ["hour", "6h", "day"]) {
    const r = await route.POST(call("POST", null, scheduleBody({ window })));
    assert.equal(r.status, 200, window);
  }
  setKeys(KEY_A);
  const on = await route.POST(call("POST", null, scheduleBody({ day: tomorrow() })));
  assert.equal(on.status, 200, "the same request, once it is set");
  // the order of refusals: Ethereum says why it is off, whether or not there is a key
  setKeys();
  const eth = (await (await route.POST(call("POST", null, scheduleBody({ chainId: 1, day: tomorrow() })))).json()) as { code: string };
  assert.equal(eth.code, "dated_off");
});

await test("an unreadable job answers as a relay that can't say, never as unknown, so the app changes nothing", async () => {
  setKeys(KEY_A);
  await withRedis(async (r, store) => {
    const sealed = job({ dated: true });
    await store.create(sealed);
    setKeys();
    const read = await route.GET(call("GET", sealed.id));
    assert.deepEqual([read.status, ((await read.json()) as { code: string }).code], [503, "later_off"]);
    const del = await route.DELETE(call("DELETE", sealed.id, { nullifier: sealed.nullifier }));
    assert.deepEqual([del.status, ((await del.json()) as { code: string }).code], [503, "later_off"]);
    assert.ok(r.kv.has(rec(sealed)), "nothing changed");
  });
  // what the app makes of that answer: could not be read, so it leaves the note alone
  globalThis.fetch = (async () => new Response(JSON.stringify({ ok: false, code: "later_off" }), { status: 503 })) as typeof fetch;
  try {
    assert.equal(await cashOutJobStatus(job().id), null);
  } finally {
    globalThis.fetch = realFetch;
  }
});

await test("a key lost for good strands nothing: its job runs out on the TTL it had, reads as gone and leaves the queue", async () => {
  setKeys(KEY_A);
  await withRedis(async (r, store) => {
    const lost = job({ dated: true, sendAfter: T0 });
    await store.create(lost);
    const ttl = r.ttls.get(rec(lost));
    const sealedText = r.kv.get(rec(lost));
    setKeys(KEY_B); // a new key, and the old one is nowhere
    let now = T0 + 10;
    const deps = { now: () => now, readChain: async () => ({ spent: false, knownRoot: true }), send: async () => hex32(1) };
    for (let pass = 0; pass < 3; pass++, now += 6 * 60 * 1000) assert.equal((await runDueJobs(store, deps))[0]?.status, "skipped");
    assert.equal(r.ttls.get(rec(lost)), ttl, "waiting never extends it, or a lost key would hold this note for ever");
    assert.equal(r.kv.get(rec(lost)), sealedText, "and never rewrites it");
    assert.equal(r.zset.has(lost.id), true);
    r.kv.delete(rec(lost)); // the TTL runs out
    const read = await route.GET(call("GET", lost.id));
    assert.deepEqual([read.status, ((await read.json()) as { code: string }).code], [404, "not_found"]);
    await runDueJobs(store, deps);
    assert.equal(r.zset.has(lost.id), false, "and the queue lets it go");
    // what the app makes of that answer: gone, which sets it moving the note
    globalThis.fetch = (async () => new Response(JSON.stringify({ ok: false, code: "not_found" }), { status: 404 })) as typeof fetch;
    assert.equal(await cashOutJobStatus(lost.id), "gone");
  });
});

await test("a memory store is unchanged: local runs and tests keep their plain jobs", async () => {
  setKeys();
  const store = memoryJobStore();
  const j = job({ sendAfter: T0 });
  await store.put(j);
  assert.deepEqual(await store.get(j.id), j);
  assert.equal(unpackJob("not json"), null, "and a record that is not a job is still just not one");
});

console.log(`\n${passed} passed`);
