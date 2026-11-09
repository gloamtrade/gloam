/**
 * Self-test: prepaid agent top-ups (lib/agentTopUp, on lib/relay/scheduled).
 *
 * The relay: a dated job's send time (inside its UTC day, up to about 90 days
 * ahead), the existing windows unchanged, a record that can't expire before
 * its job runs (the Redis store, proof swaps included, against a fake
 * Upstash), a passing problem getting a day and never crowding out what is
 * due, and cancelling or renewing a job months ahead. The route: who can read
 * or cancel a job, and a batch of 12 inside the rate limits with them still
 * holding.
 *
 * The browser: a series end to end, from lib/agentTopUp through the real
 * schedule-and-mark path and the real route, against the note vault and a fake
 * node, with a split that saves its notes like lib/cashOutSplit does. Then
 * every way it can stop midway (a refused split, one that may have gone out, a
 * failed proof, a relay that is down, a rate limit, a closed tab) with nothing
 * lost, nothing counted twice, and each top-up accounted for; finishing a
 * stopped series; cancelling; and a job the relay no longer holds after months
 * away.
 *
 * A proof stays valid until its note is spent, so a top-up cancelled, refused or
 * given up on moves to a fresh note before it can be spent. Those tests run the
 * real move (the SDK sweep, on a real Poseidon tree) and then send the old proof
 * through the relay's own checks: it passes before the move and fails after it,
 * across a reload too. Then top-ups off on Ethereum mainnet, in the relay as well
 * as the app.
 *
 * Relay keys are throwaways made here; fetch is stubbed.
 *
 * Run from app/:  ../mcp/node_modules/.bin/tsx scripts/selftest-agent-topups.mts
 */
import assert from "node:assert/strict";
import "./browser-shim.mjs";
import { toFunctionSelector, toHex, type Address, type Hex } from "viem";
import { generatePrivateKey } from "viem/accounts";

delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;
delete process.env.CHAINALYSIS_API_KEY;
process.env.GLOAM_RELAYER_PRIVATE_KEY = generatePrivateKey();
process.env.GLOAM_RELAY_JOB_KEY = Buffer.alloc(32, 7).toString("hex");

const {
  DATED_GIVE_UP_AFTER_MS,
  DATED_OFF_MESSAGE,
  DATED_RETRY_MS,
  DAY_MS,
  DELAY_WINDOWS,
  GAS_WAIT_MAX_MS,
  GIVE_UP_AFTER_MS,
  JOB_DONE_TTL_SEC,
  JOB_TTL_SEC,
  MAX_DATED_DAYS,
  MAX_DELAY_MS,
  MIN_DELAY_MS,
  cancelJob,
  datedOff,
  dayOf,
  drawSendAfter,
  drawSendOn,
  jobView,
  liveTtlSec,
  memoryJobStore,
  nextSendDay,
  replaceJobProof,
  runDueJobs,
  sendDayProblem,
} = await import("../src/lib/relay/scheduled");
const { scheduledStore, unpackJob } = await import("../src/lib/relay/scheduledStore");
const {
  FUNDING_WAIT_LEAVES,
  FUNDING_WAIT_MS,
  TOP_UPS_MAX,
  TOP_UP_EVERY,
  agentGasLine,
  cancelTopUp,
  finishTopUps,
  fundingGate,
  fundingWaitLine,
  largestTopUpNote,
  mostTopUps,
  pickReadyNote,
  pickTopUpNote,
  reconcileTopUps,
  setUpTopUps,
  topUpAmountProblem,
  topUpDays,
  topUpRows,
  topUpSeries,
  topUpSetAside,
  topUpState,
  topUpTotals,
  topUpWhen,
} = await import("../src/lib/agentTopUp");
const { checkPlan, schedulePiece, unscheduledPieces, keepPiece, cancelledPiece } = await import("../src/lib/cashOutPrivately");
const { cancelCashOut, cashOutJobStatus, dismissReturnedCashOut, feeMovedLine, feeRise, feeRiseLine, feeRiseNotice, markFor, waitingFeeRises, nextMark, releaseGoneCashOut, returnedCashOutNotes, scheduleNoteCashOut } = await import("../src/lib/cashOutLater");
const { SPLIT_MAYBE_SENT, splitNotes } = await import("../src/lib/cashOutSplit");
const { HANDOVER_MS, RELAY_SPEND_LOCK_MS, activeSpendableNotes, exportNotesBackup, notesToMove, proofLoose, saveLocalNote, updateLocalNote, cashOutPending, endedPlan } = await import(
  "../src/lib/shield"
);
const { getAllNotes } = await import("../src/lib/noteVault");
const { getActiveNetwork, getNetwork } = await import("../src/lib/networks");
const { moveRevertedNotes, reconcileClaims } = await import("../src/lib/claimSweep");
const { RelayError, checkUnshieldForLater, sendUnshieldNow } = await import("../src/lib/relay/server");
const { demoScheduleCashOut } = await import("../src/lib/demo/chain");
const { IncrementalMerkleTreePoseidon, fieldToHex, hexToField, noteCommitmentPoseidon, noteNullifierPoseidon, randomSecretField } = await import(
  "@gloamtrade/sdk"
);
const route = await import("../src/app/api/relay/scheduled/route");
type CashOutJob = import("../src/lib/relay/scheduled").CashOutJob;
type ChainView = import("../src/lib/relay/scheduled").ChainView;
type LocalNote = import("../src/lib/shield").LocalNote;
type SplitArgs = import("../src/lib/cashOutSplit").SplitArgs;
type CashOutEnv = import("../src/lib/cashOutLater").CashOutEnv;
type ClaimEnv = import("../src/lib/claimSweep").ClaimEnv;
type PoseidonMerklePath = import("../src/lib/merklePoseidon").PoseidonMerklePath;

let passed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  await fn();
  passed++;
  console.log(`ok  ${name}`);
}

const T0 = 1_800_000_000_000;
const U = 1_000_000n;
const ASSET = "0x5fc5360d0400a0fd4f2af552add042d716f1d168" as Address;
const AGENT = "0x1111111111111111111111111111111111111111" as Address;
const ME = "0x3333333333333333333333333333333333333333" as Address;
const PROOF = ("0x" + "22".repeat(256)) as Hex;
const hex32 = (n: number | bigint) => `0x${BigInt(n).toString(16).padStart(64, "0")}` as Hex;
const sum = (xs: bigint[]) => xs.reduce((s, x) => s + x, 0n);

// ---------------------------------------------------------------- send time

await test("a dated job goes out at a random time inside its UTC day, not at a fixed time", () => {
  const day = dayOf(T0) + 7 * DAY_MS;
  assert.equal(drawSendOn(T0, day, () => 0), day);
  assert.equal(drawSendOn(T0, day, () => 0.999999999) >= day + DAY_MS - 1_000, true);
  const seen = new Set<number>();
  for (let i = 0; i < 2000; i++) {
    const t = drawSendOn(T0, day);
    assert.ok(t >= day && t < day + DAY_MS);
    seen.add(Math.floor((t - day) / (60 * 60 * 1000)));
  }
  assert.equal(seen.size, 24, "every hour of the day gets drawn");
});

await test("today's day never draws sooner than the usual minimum, and never past its end", () => {
  const today = dayOf(T0);
  const now = today + DAY_MS - 10 * 60 * 1000;
  assert.equal(drawSendOn(now, today, () => 0), now + MIN_DELAY_MS);
  for (let i = 0; i < 500; i++) {
    const t = drawSendOn(now, today);
    assert.ok(t >= now + MIN_DELAY_MS && t < today + DAY_MS);
  }
});

await test("a send day must be a whole UTC day, not passed, and about 90 days out at most", () => {
  const today = dayOf(T0);
  for (const bad of [undefined, null, "x", 1.5, -DAY_MS, 0, today + 1, NaN, Infinity]) {
    assert.ok(sendDayProblem(bad, T0), String(bad));
  }
  assert.match(sendDayProblem(today - DAY_MS, T0)!, /passed/);
  assert.match(sendDayProblem(today, today + DAY_MS - MIN_DELAY_MS)!, /passed/, "no room left in it");
  assert.equal(sendDayProblem(today, T0), null);
  assert.equal(sendDayProblem(today + MAX_DATED_DAYS * DAY_MS, T0), null);
  assert.match(sendDayProblem(today + (MAX_DATED_DAYS + 1) * DAY_MS, T0)!, /within 90 days/);
  assert.equal(MAX_DATED_DAYS, 90);
});

await test("a piece scheduled late keeps its day, or takes tomorrow once that has passed", () => {
  const today = dayOf(T0);
  assert.equal(nextSendDay(today + 7 * DAY_MS, T0), today + 7 * DAY_MS);
  assert.equal(nextSendDay(today, T0), today);
  assert.equal(nextSendDay(today - 3 * DAY_MS, T0), today + DAY_MS);
  assert.equal(sendDayProblem(nextSendDay(today - 3 * DAY_MS, T0), T0), null);
});

await test("the windows are exactly what they were", () => {
  assert.deepEqual(Object.keys(DELAY_WINDOWS), ["hour", "6h", "day"]);
  assert.equal(DELAY_WINDOWS.hour, 60 * 60 * 1000);
  assert.equal(DELAY_WINDOWS["6h"], 6 * 60 * 60 * 1000);
  assert.equal(DELAY_WINDOWS.day, 24 * 60 * 60 * 1000);
  assert.equal(MAX_DELAY_MS, 24 * 60 * 60 * 1000);
  assert.equal(GIVE_UP_AFTER_MS, 2 * 60 * 60 * 1000);
  for (const w of ["hour", "6h", "day"] as const) {
    assert.equal(drawSendAfter(T0, w, () => 0), T0 + MIN_DELAY_MS);
    assert.ok(drawSendAfter(T0, w, () => 0.999999999) < T0 + DELAY_WINDOWS[w]);
  }
});

// ---------------------------------------------------------------- the record's lifetime

let seq = 0;
function job(over: Partial<CashOutJob> = {}): CashOutJob {
  seq++;
  return {
    id: `00000000-0000-4000-8000-${seq.toString(16).padStart(12, "0")}`,
    chainId: 4663,
    proof: "0xabcdef",
    root: hex32(1000 + seq),
    nullifier: hex32(seq),
    asset: ASSET,
    to: AGENT,
    amount: "5000000",
    createdAt: T0 - 60_000,
    sendAfter: T0 - 1,
    status: "scheduled",
    attempts: 0,
    updatedAt: T0 - 60_000,
    ...over,
  };
}

await test("a live record outlasts the job whatever its date, gas wait and give-up included", () => {
  for (const lead of [0, MIN_DELAY_MS, MAX_DELAY_MS, 7 * DAY_MS, MAX_DATED_DAYS * DAY_MS]) {
    const ttl = liveTtlSec({ sendAfter: T0 + lead }, T0);
    assert.ok(ttl * 1000 > lead + DATED_GIVE_UP_AFTER_MS, `give-up, ${lead}`);
    assert.ok(ttl * 1000 >= lead + GAS_WAIT_MAX_MS, `gas, ${lead}`);
    assert.equal(ttl, Math.ceil(ttl), "a whole number of seconds");
  }
  assert.equal(liveTtlSec({ sendAfter: T0 - DAY_MS }, T0), JOB_TTL_SEC, "overdue: never less than the floor");
});

/** Just enough of Upstash: strings with their TTLs, the queue, and the two scripts. */
function fakeRedis() {
  const kv = new Map<string, string>();
  const ttls = new Map<string, number>();
  const zset = new Map<string, number>();
  const exec = (a: (string | number)[]): unknown => {
    switch (a[0]) {
      case "SET": {
        const [, k, v] = a;
        if (a.includes("NX") && kv.has(String(k))) return null;
        kv.set(String(k), String(v));
        const ex = a.indexOf("EX");
        if (ex > 0) ttls.set(String(k), Number(a[ex + 1]));
        return "OK";
      }
      case "GET":
        return kv.get(String(a[1])) ?? null;
      case "ZADD":
        zset.set(String(a[3]), Number(a[2]));
        return 1;
      case "ZREM":
        return zset.delete(String(a[2])) ? 1 : 0;
      case "EVAL": {
        if (a[2] === 1) return kv.delete(String(a[3])) ? 1 : 0; // the lock's release
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
  return { kv, ttls, zset, exec };
}

/** The key of a job's spend pointer: it names the job, and carries a tag, not the nullifier. */
function pointerOf(r: ReturnType<typeof fakeRedis>, j: CashOutJob): string {
  const key = [...r.kv].find(([k, v]) => k.startsWith("gloam:cashout:nf:") && v === j.id)?.[0];
  assert.ok(key, "a pointer exists");
  return key;
}

/** Runs `fn` with the Redis store on, over the fake. */
async function withRedis<T>(fn: (r: ReturnType<typeof fakeRedis>) => Promise<T>): Promise<T> {
  const r = fakeRedis();
  const real = globalThis.fetch;
  process.env.UPSTASH_REDIS_REST_URL = "https://redis.selftest.invalid";
  process.env.UPSTASH_REDIS_REST_TOKEN = "selftest";
  globalThis.fetch = (async (_u: string | URL | Request, init?: RequestInit) =>
    new Response(JSON.stringify({ result: r.exec(JSON.parse(String(init?.body))) }), { status: 200 })) as typeof fetch;
  try {
    return await fn(r);
  } finally {
    globalThis.fetch = real;
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
  }
}

await test("in Redis a job 90 days out keeps its record and its spend's pointer for all of it", async () => {
  await withRedis(async (r) => {
    const lead = MAX_DATED_DAYS * DAY_MS;
    const j = job({ sendAfter: Date.now() + lead, dated: true });
    await scheduledStore().create(j);
    const rec = `gloam:cashout:job:${j.id}`;
    const nf = pointerOf(r, j);
    assert.ok(r.ttls.get(rec)! * 1000 >= lead + GAS_WAIT_MAX_MS - 2_000, "record");
    assert.ok(r.ttls.get(nf)! * 1000 >= lead + GAS_WAIT_MAX_MS - 2_000, "pointer");
    assert.equal(r.zset.get(j.id), j.sendAfter, "in the queue for its own time");
  });
});

await test("in Redis a proof swapped in months ahead does not cut the record back to 3 days", async () => {
  await withRedis(async (r) => {
    const store = scheduledStore();
    const lead = 80 * DAY_MS;
    const j = job({ sendAfter: Date.now() + lead, dated: true });
    await store.create(j);
    const next = { chainId: j.chainId, proof: "0xfeed" as Hex, root: hex32(0x9999), nullifier: j.nullifier, asset: j.asset, to: j.to, amount: j.amount };
    const out = await replaceJobProof(store, j.id, next, Date.now());
    assert.equal(out.ok, true);
    const rec = `gloam:cashout:job:${j.id}`;
    assert.ok(r.ttls.get(rec)! * 1000 > lead, `ttl ${r.ttls.get(rec)}s`);
    assert.ok(r.ttls.get(pointerOf(r, j))! * 1000 > lead);
    assert.equal(unpackJob(r.kv.get(rec)!)!.dated, true, "still dated");
    assert.equal(unpackJob(r.kv.get(rec)!)!.sendAfter, j.sendAfter, "same send time");
  });
});

await test("in Redis a finished job goes back to the short record, without its proof", async () => {
  await withRedis(async (r) => {
    const store = scheduledStore();
    const j = job({ sendAfter: Date.now() + 40 * DAY_MS, dated: true });
    await store.create(j);
    assert.equal(await cancelJob(store, j.id, Date.now(), j.nullifier), "cancelled");
    const rec = `gloam:cashout:job:${j.id}`;
    assert.equal(r.ttls.get(rec), JOB_DONE_TTL_SEC);
    assert.equal(unpackJob(r.kv.get(rec)!)!.proof, "0x");
    assert.equal(r.zset.has(j.id), false, "out of the queue");
  });
});

// ---------------------------------------------------------------- the runner

class SendError extends Error {
  constructor(
    message: string,
    public code: string
  ) {
    super(message);
  }
}

function fakeChain() {
  const spent = new Set<string>();
  const sends: string[] = [];
  let nextFail: string | null = null;
  const c = {
    now: T0,
    spent,
    sends,
    failNext: (code: string | null) => {
      nextFail = code;
    },
    deps: {
      now: () => c.now,
      readChain: async (j: CashOutJob): Promise<ChainView> => ({ spent: spent.has(j.nullifier), knownRoot: true }),
      send: async (j: CashOutJob): Promise<Hex> => {
        sends.push(j.id);
        if (nextFail) throw new SendError("passing", nextFail);
        spent.add(j.nullifier);
        return hex32(0xbeef);
      },
    },
  };
  return c;
}

await test("a job months out is left alone until its time, then goes out once", async () => {
  const j = job({ sendAfter: T0 + 60 * DAY_MS, dated: true });
  const store = memoryJobStore();
  const chain = fakeChain();
  await store.put(j);
  for (const t of [T0, T0 + DAY_MS, T0 + 59 * DAY_MS, j.sendAfter - 1]) {
    chain.now = t;
    assert.deepEqual(await runDueJobs(store, chain.deps), []);
  }
  chain.now = j.sendAfter;
  assert.deepEqual(await runDueJobs(store, chain.deps), [{ id: j.id, status: "sent" }]);
  assert.equal((await store.get(j.id))!.proof, "0x");
  assert.equal(chain.sends.length, 1);
});

await test("a job can be cancelled, or its proof renewed, months ahead", async () => {
  const store = memoryJobStore();
  const a = job({ sendAfter: T0 + 60 * DAY_MS, dated: true });
  await store.put(a);
  assert.equal(await cancelJob(store, a.id, T0, a.nullifier), "cancelled");
  assert.equal((await store.get(a.id))!.proof, "0x", "the relay no longer holds a proof it could send");
  const b = job({ sendAfter: T0 + 60 * DAY_MS, dated: true });
  await store.put(b);
  const r = await replaceJobProof(store, b.id, { chainId: b.chainId, proof: "0xfeed" as Hex, root: hex32(7), nullifier: b.nullifier, asset: b.asset, to: b.to, amount: b.amount }, T0);
  assert.equal(r.ok, true);
  const after = (await store.get(b.id))!;
  assert.deepEqual([after.sendAfter, after.dated, after.proof], [b.sendAfter, true, "0xfeed"]);
});

await test("nobody is at the screen for a dated job: a passing problem gets a day, not 2 hours", async () => {
  const j = job({ sendAfter: T0, dated: true });
  const store = memoryJobStore();
  const chain = fakeChain();
  await store.put(j);
  chain.failNext("relay_empty");
  assert.deepEqual(await runDueJobs(store, chain.deps), [{ id: j.id, status: "scheduled" }]);
  assert.equal((await store.get(j.id))!.notBefore, T0 + DATED_RETRY_MS, "tried again in a few minutes");
  chain.now = T0 + 1_000;
  assert.deepEqual(await runDueJobs(store, chain.deps), [], "not on the next pass");

  chain.now = T0 + GIVE_UP_AFTER_MS + 1;
  assert.deepEqual(await runDueJobs(store, chain.deps), [{ id: j.id, status: "scheduled" }], "past where a cash out in a window gives up");
  chain.now = T0 + DATED_GIVE_UP_AFTER_MS + 1;
  assert.deepEqual(await runDueJobs(store, chain.deps), [{ id: j.id, status: "failed" }]);

  // and if the relay is back in time, it goes out
  const k = job({ sendAfter: T0, dated: true });
  const s2 = memoryJobStore();
  const c2 = fakeChain();
  await s2.put(k);
  c2.failNext("relay_empty");
  await runDueJobs(s2, c2.deps);
  c2.failNext(null);
  c2.now = T0 + DATED_RETRY_MS;
  assert.deepEqual(await runDueJobs(s2, c2.deps), [{ id: k.id, status: "sent" }]);
});

await test("a cash out in a window still gives up after 2 hours, retrying on the next pass", async () => {
  const j = job({ sendAfter: T0 });
  const store = memoryJobStore();
  const chain = fakeChain();
  await store.put(j);
  chain.failNext("busy");
  await runDueJobs(store, chain.deps);
  assert.equal((await store.get(j.id))!.notBefore, undefined);
  chain.now = T0 + GIVE_UP_AFTER_MS + 1;
  assert.deepEqual(await runDueJobs(store, chain.deps), [{ id: j.id, status: "failed" }]);
});

await test("retrying dated jobs never crowd out what is due now", async () => {
  const stuck = Array.from({ length: 25 }, () => job({ sendAfter: T0 - 60_000, dated: true }));
  const store = memoryJobStore();
  const chain = fakeChain();
  for (const j of stuck) await store.put(j);
  chain.failNext("busy");
  await runDueJobs(store, chain.deps, 25);
  chain.failNext(null);
  const fresh = job({ sendAfter: T0 + 1_000 });
  await store.put(fresh);
  chain.now = T0 + 1_000;
  assert.deepEqual(await runDueJobs(store, chain.deps), [{ id: fresh.id, status: "sent" }]);
});

await test("a job waiting for gas keeps its record and still gives up with nothing moved", async () => {
  const j = job({ sendAfter: T0, dated: true });
  const store = memoryJobStore();
  const chain = fakeChain();
  await store.put(j);
  const deps = { ...chain.deps, gasHigh: async () => true };
  assert.deepEqual(await runDueJobs(store, deps), [{ id: j.id, status: "scheduled" }]);
  chain.now = T0 + GAS_WAIT_MAX_MS + 1;
  assert.deepEqual(await runDueJobs(store, deps), [{ id: j.id, status: "failed" }]);
  assert.equal(chain.sends.length, 0);
});

// ---------------------------------------------------------------- the relay's route, against a fake node

const net = getActiveNetwork();
assert.ok(net.pool);
const RPC = net.chain.rpcUrls.default.http[0];
const SEL = { spent: toFunctionSelector("spent(bytes32)"), isKnownRoot: toFunctionSelector("isKnownRoot(bytes32)") };
const word = (b: boolean) => "0x" + (b ? "1" : "0").padStart(64, "0");
const Z32 = "0x" + "00".repeat(32);
const BLOCK = {
  number: "0x7",
  hash: "0x" + "12".repeat(32),
  parentHash: Z32,
  nonce: "0x0000000000000000",
  sha3Uncles: Z32,
  logsBloom: "0x" + "00".repeat(256),
  transactionsRoot: Z32,
  stateRoot: Z32,
  receiptsRoot: Z32,
  miner: "0x" + "00".repeat(20),
  difficulty: "0x0",
  totalDifficulty: "0x0",
  extraData: "0x",
  size: "0x1",
  gasLimit: "0x1c9c380",
  gasUsed: "0x0",
  timestamp: "0x1",
  baseFeePerGas: "0x1",
  transactions: [],
  uncles: [],
};
/** What the chain shows spent: the fake node answers from it and the vault below writes to it. */
const chainSpent = new Set<string>();
let rpcCalls = 0;
type RpcReq = { id: number; method: string; params?: unknown[] };
function answer(r: RpcReq): { result?: unknown; error?: { code: number; message: string } } {
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
      const data = String((r.params?.[0] as { data?: string }).data);
      const sel = data.slice(0, 10);
      if (sel === SEL.spent) return { result: word(chainSpent.has(`0x${data.slice(10, 74)}`.toLowerCase())) };
      if (sel === SEL.isKnownRoot) return { result: word(true) };
      return { error: { code: -32000, message: `fake node: unknown call ${sel}` } };
    }
    default:
      return { error: { code: -32601, message: `fake node: ${r.method} not handled` } };
  }
}

/** What the next POSTs to the relay do instead of reaching it: "down", or a status and body. */
const replies: ("down" | { status: number; body: object })[] = [];
const asked: Record<string, unknown>[] = [];
const callRoute = (method: string, url: string, init?: RequestInit, ip = "10.1.1.1") =>
  new Request(`http://localhost${url}`, { method, headers: { "Content-Type": "application/json", "x-forwarded-for": ip }, ...(init?.body ? { body: init.body } : {}) });

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.startsWith("/api/relay/scheduled")) {
    const method = init?.method ?? "GET";
    if (method === "POST") {
      asked.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      const r = replies.shift();
      if (r === "down") throw new TypeError("fetch failed");
      if (r) return new Response(JSON.stringify(r.body), { status: r.status });
      // each batch from its own address, so the route's limits are not what these tests are about
      return route.POST(callRoute(method, url, init, `10.3.${(asked.length >> 8) & 255}.${asked.length & 255}`));
    }
    if (method === "DELETE") return route.DELETE(callRoute(method, url, init));
    if (method === "GET") return route.GET(callRoute(method, url, init));
    throw new Error(`selftest: unexpected ${method} ${url}`);
  }
  rpcCalls++;
  if (url.replace(/\/$/, "") !== RPC.replace(/\/$/, "")) throw new Error(`selftest: no network (${url})`);
  const body = JSON.parse(String(init?.body)) as RpcReq | RpcReq[];
  const list = Array.isArray(body) ? body : [body];
  const out = list.map((r) => ({ jsonrpc: "2.0", id: r.id, ...answer(r) }));
  return new Response(JSON.stringify(Array.isArray(body) ? out : out[0]), { status: 200, headers: { "Content-Type": "application/json" } });
}) as typeof fetch;

let nfSeq = 0x7000;
const scheduleBody = (over: Record<string, unknown> = {}) => ({
  chainId: net.chainId,
  proof: PROOF,
  root: hex32(0x77),
  nullifier: hex32(++nfSeq),
  asset: ASSET,
  to: AGENT,
  amount: "5000000",
  ...over,
});
type Answer = { ok?: boolean; id?: string; sendAfter?: number; to?: string; code?: string; error?: string; status?: string };
const post = async (payload: object, ip: string) => {
  const r = await route.POST(callRoute("POST", "/api/relay/scheduled", { body: JSON.stringify(payload) }, ip));
  return { status: r.status, json: (await r.json()) as Answer };
};
const tomorrow = () => dayOf(Date.now()) + DAY_MS;
const store = scheduledStore();

await test("the route takes a day, and draws the send time inside it", async () => {
  const day = tomorrow() + 13 * DAY_MS;
  const r = await post(scheduleBody({ day }), "10.2.0.1");
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.ok(r.json.sendAfter! >= day && r.json.sendAfter! < day + DAY_MS);
  const saved = (await store.get(r.json.id!))!;
  assert.equal(saved.dated, true);
  assert.equal(saved.sendAfter, r.json.sendAfter);
  assert.equal(saved.to.toLowerCase(), AGENT.toLowerCase());
});

await test("the route refuses a bad day, and both a window and a day", async () => {
  for (const bad of [{ day: 123 }, { day: "tomorrow" }, { day: dayOf(Date.now()) - DAY_MS }, { day: dayOf(Date.now()) + (MAX_DATED_DAYS + 1) * DAY_MS }, { day: tomorrow(), window: "hour" }]) {
    const r = await post(scheduleBody(bad), "10.2.0.2");
    assert.equal(r.status, 400, JSON.stringify(bad));
    assert.equal(r.json.ok, false);
  }
  assert.equal((await post(scheduleBody({}), "10.2.0.2")).status, 400, "neither");
  assert.equal((await post(scheduleBody({ window: "week" }), "10.2.0.2")).status, 400, "no new window");
});

await test("a job in a window through the route is exactly what it was: not dated, inside its window", async () => {
  const before = Date.now();
  const r = await post(scheduleBody({ window: "6h" }), "10.2.0.3");
  assert.equal(r.status, 200);
  const saved = (await store.get(r.json.id!))!;
  assert.equal(saved.dated, undefined);
  assert.ok(saved.sendAfter >= before + MIN_DELAY_MS && saved.sendAfter < Date.now() + DELAY_WINDOWS["6h"]);
});

await test("asking again for the same top-up returns the job already waiting, on its own day", async () => {
  const body = scheduleBody({ day: tomorrow() + 7 * DAY_MS });
  const first = await post(body, "10.2.0.4");
  const again = await post({ ...body, day: tomorrow() + 21 * DAY_MS }, "10.2.0.4");
  assert.equal(again.json.id, first.json.id);
  assert.equal(again.json.sendAfter, first.json.sendAfter);
  const other = await post({ ...body, to: "0x2222222222222222222222222222222222222222", day: tomorrow() }, "10.2.0.4");
  assert.equal(other.status, 409);
  assert.equal(other.json.code, "already_scheduled");
});

await test("a batch of 12 fits, a second one does, and the limit still holds past that", async () => {
  const realNow = Date.now;
  const start = dayOf(realNow()) + 60 * 60 * 1000 + 1;
  Date.now = () => start;
  try {
    const ip = "10.2.0.5";
    const day = dayOf(start) + 7 * DAY_MS;
    for (let i = 0; i < 24; i++) assert.equal((await post(scheduleBody({ day }), ip)).status, 200, `top-up ${i + 1}`);
    const over = await post(scheduleBody({ day }), ip);
    assert.deepEqual([over.status, over.json.code], [429, "rate_limit"]);
    // counted apart: an ordinary cash out in the same hour still goes, and uses up nothing of the batch's
    assert.equal((await post(scheduleBody({ window: "hour" }), ip)).status, 200);
    // and the other way: a full hour of ordinary cash outs doesn't stop a batch
    const busy = "10.2.0.6";
    for (let i = 0; i < 20; i++) assert.equal((await post(scheduleBody({ window: "day" }), busy)).status, 200);
    assert.equal((await post(scheduleBody({ window: "day" }), busy)).status, 429, "their limit is the same 20");
    for (let i = 0; i < 12; i++) assert.equal((await post(scheduleBody({ day }), busy)).status, 200);

    // a day's cap on top: these stay on record for months
    Date.now = () => start + 60 * 60 * 1000;
    for (let i = 0; i < 24; i++) assert.equal((await post(scheduleBody({ day }), ip)).status, 200, `next hour ${i + 1}`);
    Date.now = () => start + 2 * 60 * 60 * 1000;
    assert.equal((await post(scheduleBody({ day }), ip)).status, 429, "48 a day from one sender");
  } finally {
    Date.now = realNow;
  }
});

await test("a job can only be read or cancelled with its id, and reading it shows no proof, amount or address", async () => {
  const r = await post(scheduleBody({ day: tomorrow() + 14 * DAY_MS }), "10.2.0.7");
  const id = r.json.id!;
  const read = await route.GET(callRoute("GET", `/api/relay/scheduled?id=${id}`));
  const seen = (await read.json()) as Record<string, unknown>;
  assert.deepEqual(Object.keys(seen).sort(), ["chainId", "id", "ok", "sendAfter", "status", "updatedAt"]);
  const stranger = "00000000-0000-4000-8000-00000000abcd";
  assert.equal((await route.GET(callRoute("GET", `/api/relay/scheduled?id=${stranger}`))).status, 404);
  const owner = (nullifier: string) => ({ body: JSON.stringify({ nullifier }) });
  assert.equal((await route.DELETE(callRoute("DELETE", `/api/relay/scheduled?id=${stranger}`, owner(`0x${"11".repeat(32)}`)))).status, 404);
  assert.equal((await route.DELETE(callRoute("DELETE", `/api/relay/scheduled?id=nope`))).status, 400);
  assert.equal((await route.DELETE(callRoute("DELETE", `/api/relay/scheduled`))).status, 400, "no id, no list");
  assert.equal((await store.get(id))!.status, "scheduled", "none of that touched it");
  // an id is unguessable: a random UUID, handed only to whoever scheduled it, and kept in their encrypted notes
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(jobView((await store.get(id))!).hash, undefined);
});

// ---------------------------------------------------------------- the series

const active = net;
const FEE_BPS = 50;

await test("how far a series can run: 12 weekly, and every 2 weeks only as far as the relay holds one", () => {
  assert.equal(mostTopUps("week"), 12);
  assert.equal(mostTopUps("2weeks"), 7);
  const now = T0;
  for (const every of ["week", "2weeks"] as const) {
    const days = topUpDays(now, every, mostTopUps(every));
    assert.equal(days[0], dayOf(now) + DAY_MS, "the first goes tomorrow");
    for (const d of days) assert.equal(sendDayProblem(d, now), null, `${every} ${d}`);
    for (let i = 1; i < days.length; i++) assert.equal(days[i]! - days[i - 1]!, TOP_UP_EVERY[every] * DAY_MS);
    // the longest series still fits with the setup running up to a day late
    assert.equal(sendDayProblem(days.at(-1)!, now + DAY_MS - 1), null);
  }
  assert.equal(TOP_UPS_MAX, 12);
});

await test("the fee comes out of each top-up; the whole total is set aside", () => {
  assert.deepEqual(topUpTotals(50n * U, 12, FEE_BPS), { total: 600n * U, feeEach: 250_000n, agentGets: 49_750_000n });
  assert.deepEqual(topUpTotals(50n * U, 12, 25), { total: 600n * U, feeEach: 125_000n, agentGets: 49_875_000n }, "a pool still at 0.25%");
  assert.deepEqual(topUpTotals(50n * U, 2, 0), { total: 100n * U, feeEach: 0n, agentGets: 50n * U });
  assert.equal(topUpAmountProblem(U, 6), null);
  assert.ok(topUpAmountProblem(U - 1n, 6));
});

let leaf = 100;
function vaultNote(id: string, wei: bigint, over: Partial<LocalNote> = {}): LocalNote {
  const n = id.length * 7 + (leaf += 3);
  const note: LocalNote = {
    id,
    chainId: active.chainId,
    pool: active.pool!,
    asset: ASSET,
    amountWei: wei.toString(),
    commitment: hex32(0x500000 + n),
    secret: hex32(0x600000 + n),
    nullifier: hex32(0x700000 + n),
    createdAt: Date.now() - 30 * DAY_MS,
    bound: true,
    scheme: "poseidon",
    status: "open",
    source: "local",
    leafIndex: n,
    ...over,
  };
  saveLocalNote(note);
  return note;
}
/** A vault long past any note here: only the tests of the rule itself use another. */
const busyVault = { leafCount: 10_000_000, leafOf: () => undefined };
const byId = (id: string) => getAllNotes().find((n) => n.id === id)!;
const spendable = (ids: string[]) => activeSpendableNotes(getAllNotes()).filter((n) => ids.includes(n.id));
const total = (ns: LocalNote[]) => sum(ns.map((n) => BigInt(n.amountWei)));
const PATH = { leafIndex: 0 } as unknown as PoseidonMerklePath;

/** Saves its notes the way lib/cashOutSplit does. `fail` stops before the send, `maybe` after it, `close` as a tab closing. */
function fakeSplitter() {
  let calls = 0;
  const plan: Record<number, "fail" | "maybe" | "close"> = {};
  const created: string[] = [];
  async function split(a: SplitArgs): Promise<{ part: LocalNote; change: LocalNote | null }> {
    const call = ++calls;
    const base = (leaf += 11) * 1000;
    const whole = BigInt(a.note.amountWei);
    const out = (k: number, amt: bigint) => ({
      amountWei: amt.toString(),
      commitment: hex32(0xe0000000 + base + k),
      secret: hex32(0xf0000000 + base + k),
      nullifier: hex32(0x100000000 + base + k),
    });
    const w = { paymentNote: out(1, a.amount), changeNote: out(2, whole - a.amount) } as never;
    const both = splitNotes(a.note, w, a.note.nullifier!, a.owner, T0 + base);
    const part = a.partTag ? { ...both.part, cashOutPlan: a.partTag } : both.part;
    const change = both.change && a.changeTag ? { ...both.change, cashOutPlan: a.changeTag } : both.change;
    if (plan[call] === "fail") throw new Error("The relay is busy. Try again shortly or send from your wallet.");
    await saveLocalNote({ ...part, sweepPending: true });
    if (change) await saveLocalNote({ ...change, sweepPending: true });
    created.push(part.id, ...(change ? [change.id] : []));
    if (plan[call] === "maybe") throw new Error(SPLIT_MAYBE_SENT);
    if (plan[call] === "close") throw new Error("tab closed");
    const hash = hex32(0x20000 + base);
    updateLocalNote(a.note.id, { status: "recovered", txHash: hash });
    updateLocalNote(part.id, { sweepPending: false, txHash: hash, leafIndex: (leaf += 1) });
    if (change) updateLocalNote(change.id, { sweepPending: false, txHash: hash, leafIndex: (leaf += 1) });
    return { part: byId(part.id), change: change ? byId(change.id) : null };
  }
  return { split, plan, created, calls: () => calls };
}

let planSeq = 0;
function deps(s: ReturnType<typeof fakeSplitter>, proveFailsOn?: number) {
  return {
    pathOf: async () => PATH,
    split: s.split,
    prove: async (n: LocalNote, to: Address) => {
      if (proveFailsOn && n.cashOutPlan?.piece === proveFailsOn) throw new Error("This balance does not match the vault.");
      return { chainId: n.chainId, proof: PROOF, root: hex32(0x77), nullifier: n.nullifier!, asset: n.asset, to, amount: BigInt(n.amountWei) };
    },
    schedule: scheduleNoteCashOut,
    newId: () => `series-${++planSeq}`,
    vault: async () => busyVault,
  };
}
function reset() {
  replies.length = 0;
  asked.length = 0;
}
const AMOUNT = 50n * U;
const start = (note: LocalNote, s: ReturnType<typeof fakeSplitter>, count = 12, proveFailsOn?: number, every: "week" | "2weeks" = "week") =>
  setUpTopUps({ note, owner: ME, agent: AGENT, amount: AMOUNT, every, count, deps: deps(s, proveFailsOn) });
/** Every coin of a series, wherever it is now. */
const accounted = (s: ReturnType<typeof fakeSplitter>) => {
  const mine = s.created.map(byId).filter((n) => n && n.status !== "recovered");
  return {
    balance: total(activeSpendableNotes(mine)),
    waiting: total(mine.filter(cashOutPending)),
    landing: total(mine.filter((n) => n.sweepPending)),
    moving: total(mine.filter(proofLoose)),
  };
};

await test("12 top-ups from a note of exactly that much: 11 splits, each to the agent on its own day, none in the balance", async () => {
  reset();
  const src = vaultNote("dep-1", 600n * U);
  const s = fakeSplitter();
  const r = await start(src, s);
  assert.equal(r.stoppedAt, null, r.error ?? "");
  assert.equal(r.jobs.length, 12);
  assert.equal(s.calls(), 11, "the last top-up is the last split's change");
  assert.equal(byId(src.id).status, "recovered");

  const days = topUpDays(Date.now(), "week", 12);
  assert.deepEqual(asked.map((b) => b.day), days, "each handed over for its own day");
  assert.ok(asked.every((b) => b.window === undefined && String(b.to).toLowerCase() === AGENT.toLowerCase() && b.amount === AMOUNT.toString()));
  r.jobs.forEach((j, i) => assert.ok(j.sendAfter >= days[i]! && j.sendAfter < days[i]! + DAY_MS, `job ${i}`));

  const rows = topUpRows(getAllNotes()).filter((x) => s.created.includes(x.note.id));
  assert.deepEqual(rows.map((x) => x.piece), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  assert.ok(rows.every((x) => x.state === "upcoming" && x.of === 12));
  assert.equal(new Set(rows.map((x) => x.note.cashOutPlan!.plan)).size, 1, "one series");
  assert.deepEqual(accounted(s), { balance: 0n, waiting: 600n * U, landing: 0n, moving: 0n }, "nothing counted while it waits");
  assert.equal(topUpSetAside(rows).get(ASSET.toLowerCase()), 600n * U);
  assert.deepEqual(unscheduledPieces().filter((n) => s.created.includes(n.id)), []);
});

await test("a fee that rises after setup: each waiting job says what it pays now, and nothing else does", () => {
  const waiting = (feeBps?: number, state: "scheduled" | "sent" = "scheduled") => ({
    amountWei: AMOUNT.toString(),
    cashOut: { job: "job", at: T0, to: AGENT, state, ...(feeBps === undefined ? {} : { feeBps }) },
  });
  // proven before the app kept the fee: every vault charged 0.25% then
  const old = feeRise(waiting(), 50);
  assert.deepEqual(old, { shownBps: 25, liveBps: 50, shownGets: 49_875_000n, nowGets: 49_750_000n });
  assert.equal(feeRiseLine(old!, ASSET), "Pays 49.75 USDG, not the 49.875 USDG it showed.");
  assert.deepEqual(feeRise(waiting(25), 50), old, "a job that kept 0.25%");
  assert.deepEqual(feeRise(waiting(50), 100), { shownBps: 50, liveBps: 100, shownGets: 49_750_000n, nowGets: 49_500_000n }, "the next rise, from what it showed");

  assert.equal(feeRise(waiting(50), 50), null, "set up at the new fee: it pays what it showed");
  assert.equal(feeRise(waiting(), 25), null, "a pool still at 0.25%, as Base Sepolia is");
  assert.equal(feeRise(waiting(50), 25), null, "a fee that fell pays more, nothing to warn about");
  assert.equal(feeRise(waiting(), null), null, "no live fee: the older testnet pools have none");
  assert.equal(feeRise(waiting(25, "sent"), 50), null, "on its way: it can't be stopped");
  assert.equal(feeRise({ amountWei: "1", cashOut: undefined }, 50), null, "not a scheduled cash out");

  const one = feeRiseNotice([old!], "top-up");
  assert.match(one, /went up to 0\.5%/);
  assert.match(one, /after you set up this top-up/);
  assert.match(one, /pays less than it showed/);
  assert.match(one, /Cancel it before it goes/);
  assert.match(feeRiseNotice([old!, old!, old!], "scheduled cash out"), /after you set up 3 scheduled cash outs/);
  assert.match(feeRiseNotice([old!, old!], "scheduled cash out"), /they pay less than they showed/);
});

await test("the notice on every page finds jobs on any network, each against its own vault's fee", () => {
  const job = (id: string, chainId: number, feeBps?: number, status: "open" | "recovered" = "open") =>
    ({
      id,
      chainId,
      status,
      amountWei: AMOUNT.toString(),
      cashOut: { job: id, at: T0, to: AGENT, state: "scheduled", ...(feeBps === undefined ? {} : { feeBps }) },
    }) as LocalNote;
  const live: Record<number, number | null> = { 4663: 50, 8453: 50, 84532: 25, 46630: null };
  const found = waitingFeeRises(
    [job("rh", 4663), job("base", 8453, 25), job("new", 4663, 50), job("sepolia", 84532), job("old-testnet", 46630), job("gone", 4663, undefined, "recovered")],
    (n) => live[n.chainId] ?? null
  );
  assert.deepEqual(found.map((r) => r.note.id), ["rh", "base"], "a job on another network counts; one at today's fee, a pool still at 0.25%, a pool with no fee and a spent note don't");
});

await test("a fee that changes under an open screen stops the confirm, with the new number", () => {
  assert.equal(feeMovedLine(25, 50), "The cash-out fee just changed to 0.5%. Check the new numbers, then confirm again.");
  assert.equal(feeMovedLine(50, 50), null, "the same fee goes ahead");
  assert.equal(feeMovedLine(25, null), null, "a read that failed doesn't stop anyone: the screen's read stands");
  assert.equal(feeMovedLine(null, 50), null, "no fee on screen yet");
});

await test("the fee a job showed stays on its mark, through the relay's updates and a job handed back", async () => {
  reset();
  const src = vaultNote("fee-kept", 200n * U);
  const s = fakeSplitter();
  const r = await setUpTopUps({ note: src, owner: ME, agent: AGENT, amount: AMOUNT, every: "week", count: 2, feeBps: FEE_BPS, deps: deps(s) });
  assert.equal(r.stoppedAt, null, r.error ?? "");
  const rows = topUpRows(getAllNotes()).filter((x) => s.created.includes(x.note.id));
  assert.equal(rows.length, 2);
  assert.ok(rows.every((x) => x.note.cashOut?.feeBps === FEE_BPS), "each job keeps the fee on screen");
  assert.ok(rows.every((x) => feeRise(x.note, FEE_BPS) === null), "and a job set up at today's fee never warns");

  const job = { id: "j", chainId: 4663, sendAfter: T0, status: "scheduled" as const, updatedAt: T0, to: AGENT };
  const mark = markFor(job, undefined, FEE_BPS);
  assert.equal(mark.feeBps, FEE_BPS);
  assert.equal(markFor(job).feeBps, undefined, "left out, not written as undefined over nothing");
  assert.equal(nextMark(mark, { ...job, sendAfter: T0 + 60_000 })!.feeBps, FEE_BPS, "a new send time keeps it");
  assert.equal(nextMark(mark, { ...job, status: "sent" })!.feeBps, FEE_BPS, "so does going out");
});

await test("from a bigger note: one split each, and the rest stays plain money in the balance", async () => {
  reset();
  const src = vaultNote("dep-2", 1_000n * U);
  const s = fakeSplitter();
  const r = await start(src, s, 4);
  assert.equal(r.stoppedAt, null);
  assert.equal(s.calls(), 4);
  assert.deepEqual(accounted(s), { balance: 800n * U, waiting: 200n * U, landing: 0n, moving: 0n });
  const left = spendable(s.created);
  assert.equal(left.length, 1);
  assert.equal(left[0]!.cashOutPlan, undefined, "the rest is not a top-up");
});

await test("a split refused midway: the earlier ones still go, nothing lost, and the series can be finished", async () => {
  reset();
  const src = vaultNote("dep-3", 600n * U);
  const s = fakeSplitter();
  s.plan[6] = "fail";
  const r = await start(src, s);
  assert.equal(r.stoppedAt, 5);
  assert.equal(r.jobs.length, 5);
  assert.equal(r.maybeSent, false);
  assert.match(r.error!, /busy/);
  assert.equal(s.calls(), 6, "nothing tried past the problem");
  assert.deepEqual(accounted(s), { balance: 350n * U, waiting: 250n * U, landing: 0n, moving: 0n }, "every coin accounted for, once");

  const series = topUpSeries(getAllNotes(), Date.now()).find((x) => x.rows.some((y) => s.created.includes(y.note.id)))!;
  assert.deepEqual(series.missing.map((m) => m.piece), [6, 7, 8, 9, 10, 11, 12]);
  assert.equal(series.of, 12);
  assert.equal(series.amount, AMOUNT);
  assert.deepEqual([series.scheduled, series.settling], [5, false]);
  const days = topUpDays(Date.now(), "week", 12);
  assert.deepEqual(series.missing.map((m) => m.day), days.slice(5), "their days follow from the ones made");

  // finished from the rest, in the same series
  const rest = pickTopUpNote(spendable(s.created), ASSET, 350n * U)!;
  assert.equal(BigInt(rest.amountWei), 350n * U);
  const again = fakeSplitter();
  const f = await finishTopUps({ note: rest, owner: ME, series, deps: deps(again) });
  assert.equal(f.stoppedAt, null, f.error ?? "");
  assert.equal(f.jobs.length, 7);
  assert.deepEqual(asked.slice(-7).map((b) => b.day), days.slice(5));
  const done = topUpSeries(getAllNotes(), Date.now()).find((x) => x.id === series.id)!;
  assert.deepEqual(done.rows.map((x) => x.piece), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  assert.deepEqual(done.missing, []);
  assert.equal(done.scheduled, 12);
  assert.equal(topUpSetAside(done.rows).get(ASSET.toLowerCase()), 600n * U);
  assert.equal(byId(rest.id).status, "recovered");
});

await test("finishing with one top-up left, from a note of just that size: it is still tagged, and still a fresh note", async () => {
  reset();
  const src = vaultNote("dep-3b", 1_000n * U);
  const s = fakeSplitter();
  s.plan[2] = "fail";
  await start(src, s, 2);
  const series = topUpSeries(getAllNotes(), Date.now()).find((x) => x.rows.some((y) => s.created.includes(y.note.id)))!;
  assert.deepEqual(series.missing.map((m) => m.piece), [2]);
  const exact = vaultNote("dep-3c", 50n * U, { fundsProofAt: T0 });
  const again = fakeSplitter();
  const f = await finishTopUps({ note: exact, owner: ME, series, deps: deps(again) });
  assert.equal(f.stoppedAt, null, f.error ?? "");
  assert.equal(again.calls(), 1, "moved to a fresh note, so a note that backed a proof of funds never shows next to the cash out");
  const made = byId(again.created[0]!);
  assert.equal(made.cashOutPlan!.piece, 2);
  assert.equal(made.cashOutPlan!.plan, series.id);
  assert.equal(topUpState(made), "upcoming");
});

await test("a split that may have gone out: both notes kept out of the balance, and never offered again", async () => {
  reset();
  const src = vaultNote("dep-4", 600n * U);
  const s = fakeSplitter();
  s.plan[4] = "maybe";
  const r = await start(src, s);
  assert.equal(r.stoppedAt, 3);
  assert.equal(r.maybeSent, true);
  assert.equal(r.error, SPLIT_MAYBE_SENT);
  // the note it spends still counts until the sync settles it; the two it made stay out of the balance
  assert.deepEqual(accounted(s), { balance: 450n * U, waiting: 150n * U, landing: 450n * U, moving: 0n });
  const rows = topUpRows(getAllNotes()).filter((x) => s.created.includes(x.note.id));
  assert.equal(rows.find((x) => x.piece === 4)!.state, "landing");
  assert.equal(topUpSetAside(rows).get(ASSET.toLowerCase()), 150n * U, "still landing: not called set aside yet");
  const landing = s.created.map(byId).filter((n) => n.sweepPending);
  assert.equal(landing.length, 2);
  assert.equal(pickTopUpNote(landing, ASSET, 1n), null, "neither is offered to split from");
  // a run never guesses past a stop: finishing waits for the sync, and only what the relay holds counts as scheduled
  const series = topUpSeries(getAllNotes(), Date.now()).find((x) => x.rows.some((y) => s.created.includes(y.note.id)))!;
  assert.deepEqual([series.scheduled, series.settling], [3, true]);
});

await test("the relay down at scheduling: the proof may be out, so the top-up moves back, and its slot can be set up again", async () => {
  reset();
  const src = vaultNote("dep-5", 600n * U);
  const s = fakeSplitter();
  const r0 = deps(s);
  let n = 0;
  const schedule: typeof r0.schedule = async (note, call, when) => {
    if (++n === 3) replies.push("down");
    return scheduleNoteCashOut(note, call, when);
  };
  const r = await setUpTopUps({ note: src, owner: ME, agent: AGENT, amount: AMOUNT, every: "week", count: 12, deps: { ...r0, schedule } });
  assert.equal(r.stoppedAt, 2);
  assert.equal(r.error, "Could not reach the relay. Check your connection.");
  const third = s.created.map(byId).find((x) => x.cashOutPlan?.piece === 3)!;
  assert.ok(third.proofOutAt, "marked before the proof went, and nothing says it did not arrive");
  assert.equal(topUpState(third), "returned");
  assert.deepEqual(unscheduledPieces().filter((x) => s.created.includes(x.id)), [], "not offered to schedule: it moves");
  assert.deepEqual(accounted(s), { balance: 450n * U, waiting: 100n * U, landing: 0n, moving: 50n * U }, "every coin, once");
  const series = topUpSeries(getAllNotes(), Date.now()).find((x) => x.rows.some((y) => s.created.includes(y.note.id)))!;
  assert.equal(series.scheduled, 2, "a top-up the relay does not hold is not called scheduled");
  assert.deepEqual(series.missing.map((m) => m.piece), [3, 4, 5, 6, 7, 8, 9, 10, 11, 12], "its slot comes back");
});

await test("a top-up scheduled again after its day passed goes tomorrow, not never", async () => {
  reset();
  const yesterday = dayOf(Date.now()) - DAY_MS;
  const n = vaultNote("dep-6", 50n * U, { cashOutPlan: { plan: "p6", piece: 1, of: 2, to: AGENT, window: "day", topUp: { day: yesterday, everyDays: 7 } } });
  const job = await schedulePiece(n, { pathOf: async () => PATH, prove: deps(fakeSplitter()).prove });
  assert.equal(asked.at(-1)!.day, dayOf(Date.now()) + DAY_MS);
  assert.ok(job.sendAfter >= dayOf(Date.now()) + DAY_MS);
});

await test("a proof that fails never left: the top-up stays one to schedule, for its own day", async () => {
  reset();
  const src = vaultNote("dep-7", 600n * U);
  const s = fakeSplitter();
  const r = await start(src, s, 12, 3);
  assert.equal(r.stoppedAt, 2);
  assert.equal(r.jobs.length, 2);
  const left = unscheduledPieces().filter((x) => s.created.includes(x.id));
  assert.deepEqual(left.map((x) => x.cashOutPlan!.piece), [3]);
  assert.equal(left[0]!.proofOutAt, undefined);
  assert.equal(topUpState(left[0]!), "unscheduled");
  assert.deepEqual(accounted(s), { balance: 500n * U, waiting: 100n * U, landing: 0n, moving: 0n });
  assert.deepEqual(notesToMove([left[0]!]), [], "no proof out, so nothing to move");

  const day = left[0]!.cashOutPlan!.topUp!.day;
  const job = await schedulePiece(left[0]!, { pathOf: async () => PATH, prove: deps(s).prove });
  assert.equal(asked.at(-1)!.day, day);
  assert.equal(asked.at(-1)!.window, undefined);
  assert.ok(job.sendAfter >= day && job.sendAfter < day + DAY_MS);
  assert.equal(topUpState(byId(left[0]!.id)), "upcoming");
  assert.deepEqual(accounted(s), { balance: 450n * U, waiting: 150n * U, landing: 0n, moving: 0n });
});

await test("a rate limit midway: the relay saw that proof, so that top-up moves back and the rest is safe", async () => {
  reset();
  const src2 = vaultNote("dep-8", 600n * U);
  const s2 = fakeSplitter();
  const d = deps(s2);
  let k = 0;
  const schedule: typeof d.schedule = async (note, call, when) => {
    if (++k === 9) replies.push({ status: 429, body: { ok: false, code: "rate_limit", error: "Too many scheduled cash outs from this device. Wait a while." } });
    return scheduleNoteCashOut(note, call, when);
  };
  const r2 = await setUpTopUps({ note: src2, owner: ME, agent: AGENT, amount: AMOUNT, every: "week", count: 12, deps: { ...d, schedule } });
  assert.equal(r2.stoppedAt, 8);
  assert.match(r2.error!, /Too many/);
  assert.deepEqual(accounted(s2), { balance: 150n * U, waiting: 400n * U, landing: 0n, moving: 50n * U });
});

await test("a closed tab mid-split: the notes are kept, the next sync lands them, and the top-up shows as not scheduled", async () => {
  reset();
  const src = vaultNote("dep-9", 600n * U);
  const s = fakeSplitter();
  s.plan[1] = "close";
  const r = await start(src, s);
  assert.equal(r.stoppedAt, 0);
  const everything = () => [src.id, ...s.created];
  assert.equal(total(spendable(everything())), 600n * U, "the original still counts, once");
  const part = s.created.map(byId).find((n) => n.cashOutPlan)!;
  assert.equal(part.secret !== "0x" && part.secret.length, 66, "its secret was saved before anything was sent");
  const env = {
    chainId: active.chainId,
    pool: active.pool!,
    stateAt: async () => ({ spent: true, seen: true, block: 1n }),
    leafIndexOf: async () => (leaf += 1),
  } as unknown as ClaimEnv;
  assert.equal(await reconcileClaims(env), true);
  assert.equal(byId(src.id).status, "recovered");
  assert.equal(total(spendable(everything())), 600n * U, "counted once: the two new notes");
  assert.deepEqual(unscheduledPieces().filter((n) => s.created.includes(n.id)).map((n) => n.cashOutPlan!.piece), [1]);
  // the slots never reached show too, and the change is what can finish them
  const series = topUpSeries(getAllNotes(), Date.now()).find((x) => x.rows.some((y) => s.created.includes(y.note.id)))!;
  assert.equal(series.missing.length, 11);
});

await test("a note whose swap just reverted waits, like any cash out, then a series moves it to fresh notes", async () => {
  reset();
  const held = vaultNote("swap-1", 200n * U, { swapProofAt: Date.now() });
  const s = fakeSplitter();
  await assert.rejects(start(held, s, 4), /moving to a fresh private balance/);
  assert.equal(s.calls(), 0, "nothing moved");
  assert.equal(byId(held.id).status, "open");
  assert.equal(asked.length, 0);

  // once the relay takes it: every top-up comes from a split, which ends that swap's proof
  const ready = vaultNote("swap-2", 200n * U, { swapProofAt: Date.now() - RELAY_SPEND_LOCK_MS - 1 });
  const s2 = fakeSplitter();
  const r = await start(ready, s2, 4);
  assert.equal(r.stoppedAt, null, r.error ?? "");
  assert.equal(s2.calls(), 3);
  assert.equal(byId(ready.id).status, "recovered");
  assert.ok(s2.created.map(byId).every((n) => !n.swapProofAt), "the proof stays behind on the spent note");
});

await test("the series comes out of the smallest note that covers it, never one that's busy", () => {
  const notes = [
    vaultNote("pick-1", 100n * U),
    vaultNote("pick-2", 300n * U),
    vaultNote("pick-3", 900n * U),
    vaultNote("pick-4", 5_000n * U, { cashOut: { job: "j", at: T0, to: AGENT, state: "scheduled" } }),
    vaultNote("pick-5", 6_000n * U, { sweepPending: true }),
    vaultNote("pick-6", 7_000n * U, { asset: AGENT }),
    vaultNote("pick-7", 8_000n * U, { status: "recovered" }),
    vaultNote("pick-8", 9_000n * U, { cashOutPlan: { plan: "p", piece: 1, of: 2, to: AGENT, window: "day", topUp: { day: T0, everyDays: 7 } } }),
    vaultNote("pick-9", 200n * U, { cashOut: { job: "j", at: T0, to: AGENT, state: "failed" } }),
  ];
  assert.equal(pickTopUpNote(notes, ASSET, 250n * U)!.id, "pick-2");
  assert.equal(pickTopUpNote(notes, ASSET, 150n * U)!.id, "pick-2", "one that came back is blocked until it has moved");
  assert.equal(pickTopUpNote(notes, ASSET.toUpperCase().replace("0X", "0x"), 150n * U)!.id, "pick-2");
  assert.equal(pickTopUpNote(notes, ASSET, 901n * U), null, "a series comes out of one note");
  assert.equal(largestTopUpNote(notes, ASSET), 900n * U);
});

// ---------------------------------------------------------------- after setup

/** A series of `count` already scheduled, for the tests below. */
async function live(count = 3) {
  reset();
  const s = fakeSplitter();
  const src = vaultNote(`dep-live-${++leaf}`, 50n * U * BigInt(count));
  const r = await start(src, s, count);
  assert.equal(r.stoppedAt, null, r.error ?? "");
  return { s, rows: topUpRows(getAllNotes()).filter((x) => s.created.includes(x.note.id)) };
}

await test("cancelling a top-up keeps it out of the balance until it has moved, and it stays on the list as cancelled", async () => {
  const { s, rows } = await live(3);
  const target = rows[1]!.note;
  assert.ok(target.proofOutAt, "marked when it went to the relay");
  assert.equal(await cancelTopUp(target), null);
  const after = byId(target.id);
  assert.equal(after.cashOut, undefined);
  assert.equal(topUpState(after), "cancelled");
  assert.deepEqual(spendable(s.created).map((n) => n.id), [], "nothing can spend it yet");
  assert.ok(!unscheduledPieces().some((n) => n.id === target.id), "not a top-up still to schedule");
  assert.deepEqual(notesToMove([after]).map((n) => n.id), [target.id], "and the sync moves it");
  assert.equal(accounted(s).waiting, 100n * U);
  assert.equal(accounted(s).moving, 50n * U);
  const left = topUpRows(getAllNotes()).filter((x) => s.created.includes(x.note.id));
  assert.equal(topUpSetAside(left).get(ASSET.toLowerCase()), 100n * U, "on its way back is not set aside");
  const row = left.find((x) => x.note.id === target.id)!;
  assert.equal(row.moving, true);
  assert.equal(topUpWhen(row, Date.now()), "Cancelled. Moving back to your balance");
  // the relay holds no proof for it any more
  assert.equal((await store.get(rows[1]!.note.cashOut!.job))!.proof, "0x");
  // a series with a cancelled slot does not offer it back
  const series = topUpSeries(getAllNotes(), Date.now()).find((x) => x.rows.some((y) => s.created.includes(y.note.id)))!;
  assert.deepEqual(series.missing, []);
});

await test("cancel from Pay does the same; an ordinary piece still drops its tag", async () => {
  const { rows } = await live(2);
  cancelledPiece(rows[0]!.note.id);
  assert.equal(topUpState(byId(rows[0]!.note.id)), "cancelled");
  const plain = vaultNote("plain-1", 5n * U, { cashOutPlan: { plan: "p", piece: 1, of: 2, to: AGENT, window: "6h" } });
  cancelledPiece(plain.id);
  assert.equal(byId(plain.id).cashOutPlan, undefined);
  assert.equal(endedPlan(undefined, "kept"), undefined);
  const kept = vaultNote("plain-2", 5n * U, { cashOutPlan: { plan: "p", piece: 2, of: 2, to: AGENT, window: "6h" } });
  keepPiece(kept.id);
  assert.equal(byId(kept.id).cashOutPlan, undefined);
});

await test("keeping a top-up that wasn't scheduled: plain money, on the record as cancelled", () => {
  const n = vaultNote("keep-1", 50n * U, { cashOutPlan: { plan: "pk", piece: 1, of: 2, to: AGENT, window: "day", topUp: { day: dayOf(Date.now()) + DAY_MS, everyDays: 7 } } });
  assert.ok(unscheduledPieces().some((x) => x.id === n.id));
  keepPiece(n.id);
  assert.ok(!unscheduledPieces().some((x) => x.id === n.id));
  assert.equal(topUpState(byId(n.id)), "cancelled");
  assert.equal(activeSpendableNotes(getAllNotes()).some((x) => x.id === n.id), true);
});

await test("a top-up already on its way can't be cancelled; a relay that can't be reached changes nothing", async () => {
  const { rows } = await live(2);
  const going = rows[0]!.note;
  const j = (await store.get(going.cashOut!.job))!;
  await store.put({ ...j, status: "sending", attempts: 1 });
  assert.match((await cancelTopUp(going))!, /already going out/);
  assert.equal(byId(going.id).cashOut!.state, "sent");
  assert.equal(topUpState(byId(going.id)), "going");

  const real = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new TypeError("fetch failed");
  }) as typeof fetch;
  try {
    assert.match((await cancelTopUp(rows[1]!.note))!, /could not be reached/);
  } finally {
    globalThis.fetch = real;
  }
  assert.equal(byId(rows[1]!.note.id).cashOut!.state, "scheduled");
});

function env(views: Record<string, unknown>, spent: Record<string, boolean | null>, now: number): CashOutEnv {
  return {
    chainId: active.chainId,
    pool: active.pool!,
    now: () => now,
    status: async (id) => (views[id] as never) ?? null,
    isSpent: async (nf) => (nf in spent ? spent[nf]! : null),
    receipt: async () => null,
  };
}
const dated = (id: string, wei: bigint, mark: Partial<NonNullable<LocalNote["cashOut"]>>) =>
  vaultNote(id, wei, {
    proofOutAt: T0,
    cashOutPlan: { plan: "pg", piece: 1, of: 2, to: AGENT, window: "day", topUp: { day: dayOf(T0), everyDays: 7 } },
    cashOut: { job: `job-${id}`, at: T0, to: AGENT, state: "scheduled", ...mark },
  });

await test("back after months: a top-up the relay no longer holds is settled from the chain", async () => {
  const later = T0 + 30 * DAY_MS;
  const unspent = dated("gone-1", 50n * U, {});
  const spent = dated("gone-2", 50n * U, {});
  const unread = dated("gone-3", 50n * U, {});
  const ahead = dated("gone-4", 50n * U, { at: later + 7 * DAY_MS });
  const plain = vaultNote("gone-5", 50n * U, { cashOut: { job: "job-gone-5", at: T0, to: AGENT, state: "scheduled" } });
  const views = Object.fromEntries(["gone-1", "gone-2", "gone-3", "gone-4", "gone-5"].map((id) => [`job-${id}`, "gone"]));
  const chain = { [unspent.nullifier!]: false, [spent.nullifier!]: true, [unread.nullifier!]: null, [ahead.nullifier!]: false, [plain.nullifier!]: false };
  assert.equal(await reconcileTopUps(env(views, chain, later)), true);

  assert.equal(byId(unspent.id).cashOut!.state, "failed", "it can never go out now, and nothing moved");
  assert.equal(topUpState(byId(unspent.id)), "returned");
  assert.ok(!activeSpendableNotes(getAllNotes()).some((n) => n.id === unspent.id), "its proof was out for months: it moves first");
  assert.ok(notesToMove(getAllNotes()).some((n) => n.id === unspent.id));
  assert.ok(!returnedCashOutNotes().some((n) => n.id === unspent.id), "it shows on its own screen, and is not back yet");
  assert.equal(byId(spent.id).cashOut!.state, "sent", "the chain shows it went out");
  assert.ok(!activeSpendableNotes(getAllNotes()).some((n) => n.id === spent.id));
  assert.equal(byId(unread.id).cashOut!.state, "scheduled", "chain unread: left as it is");
  assert.equal(byId(ahead.id).cashOut!.state, "scheduled", "not past its time: left as it is");
  assert.equal(byId(plain.id).cashOut!.state, "scheduled", "an ordinary cash out keeps its rule: the chain settles it");
});

await test("a top-up that came back stays on the record after its notice is dismissed", () => {
  const n = dated("back-1", 50n * U, { state: "failed" });
  assert.equal(topUpState(n), "returned");
  dismissReturnedCashOut(n.id);
  assert.equal(byId(n.id).cashOut, undefined);
  assert.equal(topUpState(byId(n.id)), "returned");
  assert.ok(!unscheduledPieces().some((x) => x.id === n.id), "not one still to schedule");
  assert.equal(proofLoose(byId(n.id)), true, "and dismissing it does not let the note skip its move");
  assert.ok(!activeSpendableNotes(getAllNotes()).some((x) => x.id === n.id));
});

await test("each state of a top-up reads plainly, and sent means the chain shows it", () => {
  const tag = { plan: "ps", piece: 1, of: 2, to: AGENT, window: "day" as const, topUp: { day: T0, everyDays: 7 } };
  const base = { ...vaultNote("state-1", 5n * U), cashOutPlan: tag };
  const mark = { job: "j", at: T0 + DAY_MS, to: AGENT };
  const cases: [Partial<LocalNote>, string][] = [
    [{ cashOut: { ...mark, state: "scheduled" } }, "upcoming"],
    [{ cashOut: { ...mark, state: "sent" } }, "going"],
    [{ cashOut: { ...mark, state: "sent" }, status: "recovered" }, "sent"],
    [{ cashOut: { ...mark, state: "scheduled" }, status: "recovered" }, "sent"],
    [{ cashOut: { ...mark, state: "failed" } }, "returned"],
    [{ cashOut: { ...mark, state: "expired" } }, "returned"],
    [{ cashOut: { ...mark, state: "cancelled" } }, "cancelled"],
    [{ sweepPending: true }, "landing"],
    [{}, "unscheduled"],
    [{ proofOutAt: T0 }, "returned"],
    [{ status: "recovered" }, "cancelled"],
    [{ cashOutPlan: { ...tag, topUp: { ...tag.topUp, ended: "cancelled" } } }, "cancelled"],
    [{ cashOutPlan: { ...tag, topUp: { ...tag.topUp, ended: "kept" } } }, "cancelled"],
    [{ cashOutPlan: { ...tag, topUp: { ...tag.topUp, ended: "returned" } } }, "returned"],
  ];
  for (const [over, want] of cases) assert.equal(topUpState({ ...base, ...over }), want, JSON.stringify(over));
  assert.equal(topUpWhen({ state: "upcoming", at: T0 - 1 }, T0), "Going out now");
  assert.equal(topUpWhen({ state: "returned", at: T0, moving: true }, T0), "Didn't go out. Moving back to your balance");
  assert.match(topUpWhen({ state: "upcoming", at: T0 + DAY_MS }, T0), /^[A-Z][a-z]{2} \d+, about /);
});

// ---------------------------------------------------------------- the proof dies with the note

const lc = (h: string) => h.toLowerCase();

/** The vault: a real Poseidon tree, so the move below is the real sweep and its proofs line up. */
function mockVault() {
  const tree = new IncrementalMerkleTreePoseidon();
  const index = new Map<string, number>();
  const roots = new Set<string>();
  const receipts = new Map<string, "success" | "reverted">();
  let n = 0;
  async function insert(c: Hex) {
    index.set(lc(c), await tree.insert(hexToField(c)));
    roots.add(lc(fieldToHex(tree.currentRoot)));
  }
  const vault = {
    insert,
    transfers: 0,
    env(over: Partial<ClaimEnv> = {}): ClaimEnv {
      return {
        chainId: active.chainId,
        pool: active.pool!,
        chain: {
          isSpent: async (nf) => chainSpent.has(lc(nf)),
          isCommitmentSeen: async (c) => index.has(lc(c)),
          pathForCommitment: async (c) => {
            const i = index.get(lc(c));
            return i == null ? null : ((await tree.path(i)) as PoseidonMerklePath);
          },
          waitForReceipt: async (h) => ({ status: receipts.get(h) ?? "reverted" }),
        },
        prove: async () => ({ proofBytes: "0xdeadbeef" }),
        relay: async (t) => {
          vault.transfers++;
          const hash = `0x${(++n).toString(16).padStart(64, "0")}` as Hex;
          const ok = roots.has(lc(t.root)) && !chainSpent.has(lc(t.nullifier));
          if (ok) {
            chainSpent.add(lc(t.nullifier));
            for (const c of t.commitments) await insert(c);
          }
          receipts.set(hash, ok ? "success" : "reverted");
          return hash;
        },
        leafIndexOf: async (c) => index.get(lc(c)),
        stateAt: async (nf, c) => ({ spent: nf ? chainSpent.has(lc(nf)) : null, seen: index.has(lc(c)), block: 1n }),
        ...over,
      };
    },
  };
  return vault;
}
const pool = mockVault();

let realSeq = 0;
/** A real note in the vault, tagged as a top-up, and its cash out handed to the relay: the proof as it left the browser comes back. */
async function handedOver(value = AMOUNT) {
  reset();
  const secret = await randomSecretField();
  const commitment = fieldToHex(await noteCommitmentPoseidon(secret, value, ASSET));
  const day = tomorrow() + 7 * DAY_MS;
  const note: LocalNote = {
    id: `co-real-${++realSeq}`,
    chainId: active.chainId,
    pool: active.pool!,
    asset: ASSET,
    amountWei: value.toString(),
    commitment,
    secret: fieldToHex(secret),
    nullifier: fieldToHex(await noteNullifierPoseidon(secret, hexToField(commitment))),
    bound: true,
    scheme: "poseidon",
    from: ME,
    createdAt: Date.now(),
    status: "open",
    source: "local",
    cashOutPlan: { plan: `real-${realSeq}`, piece: 1, of: 2, to: AGENT, window: "day", topUp: { day, everyDays: 7 } },
  };
  await saveLocalNote(note);
  await pool.insert(commitment);
  const call = { chainId: active.chainId, proof: PROOF, root: hex32(0x77), nullifier: note.nullifier!, asset: ASSET, to: AGENT, amount: value };
  return { note, call, day, sent: { ...call, amount: value.toString() } as Record<string, unknown> };
}
async function scheduled(value = AMOUNT) {
  const h = await handedOver(value);
  const job = await scheduleNoteCashOut(h.note, h.call, { day: h.day });
  return { ...h, job };
}
const moves = (n: LocalNote) => getAllNotes().filter((x) => x.sweptFrom?.id === n.id);
const refused = (e: unknown) => e instanceof RelayError && e.code === "AlreadySpent";
/** The old proof, sent every way there is: the relay's checks, a send, and scheduling it again. */
async function assertDead(sent: Record<string, unknown>) {
  await assert.rejects(checkUnshieldForLater(active, sent), refused, "the relay's checks");
  await assert.rejects(sendUnshieldNow(active, sent), refused, "a send");
  const again = await post({ ...sent, day: tomorrow() + 14 * DAY_MS }, `10.2.1.${++realSeq % 250}`);
  assert.deepEqual([again.status, again.json.code], [409, "AlreadySpent"], "scheduling it again");
}
function assertMoved(n: LocalNote) {
  const made = moves(n);
  assert.equal(made.length, 1, "one fresh note");
  assert.equal(byId(n.id).status, "recovered");
  assert.ok(chainSpent.has(lc(n.nullifier!)), "the old nullifier is spent");
  assert.equal(BigInt(made[0]!.amountWei), BigInt(n.amountWei), "all of it");
  assert.ok(activeSpendableNotes(getAllNotes()).some((x) => x.id === made[0]!.id), "and it is in the balance");
  assert.ok(!activeSpendableNotes(getAllNotes()).some((x) => x.id === n.id), "once");
  assert.equal(made[0]!.proofOutAt, undefined, "no proof of the fresh note has ever left");
  assert.equal(made[0]!.cashOutPlan, undefined, "plain money");
}

let copies = 0;
/** The note store and the sync a reload starts with: over the same disk, remembering no tries. */
async function reloaded() {
  const v = (await import(`../src/lib/noteVault.ts?tab=${++copies}`)) as typeof import("../src/lib/noteVault");
  await v.unlockNoteVault();
  await v.syncFromDisk();
  const sync = (await import(`../src/lib/claimSweep.ts?tab=${++copies}`)) as typeof import("../src/lib/claimSweep");
  return { store: v, sync };
}

await test("a cancelled top-up's proof passes until the note moves, then fails against the spent nullifier", async () => {
  const { note, sent, job } = await scheduled();
  await checkUnshieldForLater(active, sent); // the control: this proof really is live
  assert.equal(await cancelTopUp(byId(note.id)), null);
  assert.equal((await store.get(job.id))!.status, "cancelled");
  // the relay dropped its copy, and the proof is exactly as good as it was: this is why the note has to move
  await checkUnshieldForLater(active, sent);

  const held = byId(note.id);
  assert.equal(proofLoose(held), true);
  assert.ok(!activeSpendableNotes(getAllNotes()).some((n) => n.id === note.id), "nothing can spend it");
  assert.equal(pickTopUpNote([held], ASSET, U), null, "not even a new series");
  assert.throws(() => checkPlan(held, [U, U], [AGENT, AGENT]), /busy/);

  await moveRevertedNotes(pool.env());
  assertMoved(note);
  await assertDead(sent);
  const row = topUpRows(getAllNotes()).find((x) => x.note.id === note.id)!;
  assert.deepEqual([row.state, row.moving], ["cancelled", false]);
});

await test("the same across a reload: the mark is on disk, the block holds, and the next load finishes the move", async () => {
  const { note, sent } = await scheduled();
  assert.equal(await cancelTopUp(byId(note.id)), null);
  const { store: tab, sync } = await reloaded();
  const onDisk = tab.getAllNotes().find((n) => n.id === note.id)!;
  assert.equal(proofLoose(onDisk), true, "from disk, in a tab that saw none of this");
  assert.ok(!activeSpendableNotes(tab.getAllNotes()).some((n) => n.id === note.id));
  await checkUnshieldForLater(active, sent); // still live: nothing has moved it yet
  assert.ok((await exportNotesBackup(ME)).notes.find((n) => n.id === note.id)?.proofOutAt, "a backup carries the mark too");
  await sync.moveRevertedNotes(pool.env());
  await reloaded(); // and whatever that tab wrote is what the next one reads
  assertMoved(note);
  await assertDead(sent);
});

await test("a tab closed after the relay cancelled but before the note heard: the next load finds out and moves it", async () => {
  const { note, sent, job } = await scheduled();
  // the DELETE reached the relay, and this tab closed before writing anything
  await route.DELETE(callRoute("DELETE", `/api/relay/scheduled?id=${job.id}`, { body: JSON.stringify({ nullifier: sent.nullifier }) }));
  assert.equal(byId(note.id).cashOut!.state, "scheduled");
  assert.ok(!activeSpendableNotes(getAllNotes()).some((n) => n.id === note.id), "still out of the balance");
  await reconcileTopUps(cashEnv(job.id));
  assert.equal(byId(note.id).cashOut!.state, "cancelled");
  assert.equal(proofLoose(byId(note.id)), true, "came back, and still can't be spent");
  assert.ok(!activeSpendableNotes(getAllNotes()).some((n) => n.id === note.id));
  await moveRevertedNotes(pool.env());
  assertMoved(note);
  await assertDead(sent);
});

/** The relay's real answer for this one job: every waiting note of every earlier test would use up the status limit. */
function cashEnv(job: string, now = Date.now()): CashOutEnv {
  return {
    chainId: active.chainId,
    pool: active.pool!,
    now: () => now,
    status: async (id) => (id === job ? cashOutJobStatus(id) : null),
    isSpent: async (nf) => chainSpent.has(lc(nf)),
    receipt: async () => null,
  };
}

await test("a top-up the relay gave up on, found expired, or no longer holds: each moves, and each proof dies", async () => {
  for (const ending of ["failed", "expired", "gone"] as const) {
    const { note, sent, job } = await scheduled();
    if (ending === "gone") await store.forget(job.id);
    else await store.put({ ...(await store.get(job.id))!, status: ending, proof: "0x", reason: "Nothing moved." });
    await reconcileTopUps(cashEnv(job.id, job.sendAfter + DAY_MS));
    assert.equal(byId(note.id).cashOut!.state, ending === "expired" ? "expired" : "failed", ending);
    assert.equal(topUpState(byId(note.id)), "returned", ending);
    assert.equal(proofLoose(byId(note.id)), true, ending);
    assert.ok(!activeSpendableNotes(getAllNotes()).some((n) => n.id === note.id), ending);
    await moveRevertedNotes(pool.env());
    assertMoved(note);
    await assertDead(sent);
  }
});

await test("a refusal at scheduling, and a reply that never came: the mark is on disk first, and a job the relay did keep dies with the note", async () => {
  // the mark is on disk at the moment the proof goes
  const h = await handedOver();
  const seen: (number | undefined)[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).startsWith("/api/relay/scheduled") && init?.method === "POST") {
      const { store: tab } = await reloaded();
      seen.push(tab.getAllNotes().find((n) => n.id === h.note.id)?.proofOutAt);
    }
    return real(input, init);
  }) as typeof fetch;
  try {
    replies.push({ status: 429, body: { ok: false, code: "rate_limit", error: "Too many." } });
    await assert.rejects(scheduleNoteCashOut(h.note, h.call, { day: h.day }), /Too many/);
  } finally {
    globalThis.fetch = real;
  }
  assert.equal(seen.length, 1);
  assert.ok(seen[0], "on disk, read back by another tab, as the proof left");
  assert.equal(topUpState(byId(h.note.id)), "returned");
  assert.ok(!activeSpendableNotes(getAllNotes()).some((n) => n.id === h.note.id));
  await moveRevertedNotes(pool.env());
  assertMoved(h.note);
  await assertDead(h.sent);

  // the relay took it and the reply was lost: a live job this browser knows nothing of
  const lost = await handedOver();
  const made = await post({ ...lost.sent, day: lost.day }, "10.2.0.40");
  assert.equal(made.status, 200);
  replies.push("down");
  await assert.rejects(scheduleNoteCashOut(lost.note, lost.call, { day: lost.day }), /Could not reach/);
  await moveRevertedNotes(pool.env());
  assertMoved(lost.note);
  const sends: string[] = [];
  const alone = memoryJobStore();
  await alone.put((await store.get(made.json.id!))!);
  const due = await runDueJobs(alone, {
    now: () => made.json.sendAfter!,
    readChain: async (j) => ({ spent: chainSpent.has(lc(j.nullifier)), knownRoot: true }),
    send: async (j) => {
      sends.push(j.id);
      return hex32(1);
    },
  });
  assert.deepEqual(due, [{ id: made.json.id!, status: "spent" }], "it comes due and finds the note spent");
  assert.deepEqual(sends, [], "nothing moved");
});

await test("a proof on its way to the relay is not moved from under it, by this tab or another, and a closed tab lets go", async () => {
  // the sync fires, here and in a second tab, while the POST is out
  const h = await handedOver();
  const before = pool.transfers;
  const real = globalThis.fetch;
  let during: { blocked: boolean; held: number } | null = null;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).startsWith("/api/relay/scheduled") && init?.method === "POST") {
      const { store: tab, sync } = await reloaded();
      const onDisk = tab.getAllNotes().find((n) => n.id === h.note.id)!;
      during = { blocked: proofLoose(onDisk), held: notesToMove([onDisk]).length };
      await moveRevertedNotes(pool.env());
      await sync.moveRevertedNotes(pool.env());
    }
    return real(input, init);
  }) as typeof fetch;
  let job;
  try {
    job = await scheduleNoteCashOut(h.note, h.call, { day: h.day });
  } finally {
    globalThis.fetch = real;
  }
  assert.deepEqual(during, { blocked: true, held: 0 }, "can't be spent, and isn't moved");
  assert.equal(pool.transfers, before, "nothing moved it");
  assert.ok(!chainSpent.has(lc(h.note.nullifier!)), "so the top-up is alive");
  assert.equal(byId(h.note.id).cashOut!.job, job.id);
  assert.equal(byId(h.note.id).handoverUntil, undefined, "the lease ends with the reply");
  await checkUnshieldForLater(active, h.sent);

  // a refusal ends the lease at once: the owner's money isn't held up for it
  const refusedNow = await handedOver();
  replies.push({ status: 429, body: { ok: false, code: "rate_limit", error: "Too many." } });
  await assert.rejects(scheduleNoteCashOut(refusedNow.note, refusedNow.call, { day: refusedNow.day }));
  assert.deepEqual(notesToMove([byId(refusedNow.note.id)]).map((n) => n.id), [refusedNow.note.id]);

  // the tab closed with the POST out: nothing says how it ended, so the lease runs out and then it moves
  const closed = await handedOver();
  await updateLocalNote(closed.note.id, { proofOutAt: Date.now(), handoverUntil: Date.now() + HANDOVER_MS });
  const held = byId(closed.note.id);
  assert.equal(proofLoose(held), true, "blocked throughout");
  assert.ok(!activeSpendableNotes(getAllNotes()).some((n) => n.id === held.id));
  assert.deepEqual(notesToMove([held]), [], "not yet");
  assert.deepEqual(notesToMove([held], held.handoverUntil! - 1), []);
  assert.deepEqual(notesToMove([held], held.handoverUntil!).map((n) => n.id), [held.id], "once it runs out");
});

await test("while the move lands the money counts nowhere twice, and a relay that is off leaves it blocked", async () => {
  const { note, sent } = await scheduled();
  await cancelTopUp(byId(note.id));
  const counted = () => activeSpendableNotes(getAllNotes()).filter((n) => n.id === note.id || n.sweptFrom?.id === note.id);

  const before = pool.transfers;
  await moveRevertedNotes(pool.env({ relayReady: async () => false }));
  assert.equal(pool.transfers, before, "nothing tried while the relay is off");
  assert.equal(proofLoose(byId(note.id)), true);
  assert.deepEqual(counted(), [], "still blocked");

  // the relay is back: mid-send the old note and the fresh one both stay out, and afterwards exactly one counts
  const { sync } = await reloaded();
  const env = pool.env();
  await sync.moveRevertedNotes({
    ...env,
    relay: async (t) => {
      assert.deepEqual(counted(), [], "neither counts mid-send");
      assert.equal(moves(note)[0]?.sweepPending, true, "the fresh note's secret is saved before the move goes");
      return env.relay(t);
    },
  });
  await reloaded();
  assert.deepEqual(counted().map((n) => n.id), [moves(note)[0]!.id]);
  await assertDead(sent);
});

await test("a top-up whose proof never left needs no move", async () => {
  // split off, then stopped before the proof went: plain money once kept, with no relay transaction
  const never = vaultNote("never-1", 50n * U, { cashOutPlan: { plan: "pn", piece: 1, of: 2, to: AGENT, window: "day", topUp: { day: tomorrow(), everyDays: 7 } } });
  assert.deepEqual(notesToMove([never]), []);
  keepPiece(never.id);
  assert.deepEqual(notesToMove([byId(never.id)]), []);
  assert.ok(activeSpendableNotes(getAllNotes()).some((n) => n.id === never.id));
});

// ---------------------------------------------------------------- every cash out, not only a top-up

/** A real note in the vault with a cash out in a window handed to the relay, tagged as a piece or not. */
async function laterCashOut(piece: boolean) {
  const h = await handedOver();
  await updateLocalNote(h.note.id, { cashOutPlan: piece ? { plan: `lp-${realSeq}`, piece: 1, of: 2, to: AGENT, window: "6h" } : undefined });
  const job = await scheduleNoteCashOut(byId(h.note.id), h.call, "6h");
  return { ...h, job };
}

await test("a cash out later, and a private cash out's piece, go the same way: marked, leased, cancelled, moved, dead", async () => {
  for (const piece of [false, true]) {
    const { note, sent, job } = await laterCashOut(piece);
    const held = byId(note.id);
    assert.ok(held.proofOutAt, "marked");
    assert.equal(held.handoverUntil, undefined, "the lease ended with the reply");
    await checkUnshieldForLater(active, sent);
    assert.equal(await cancelCashOut(job.id, byId(note.id)), "cancelled");
    await cancelledPiece(note.id);
    assert.equal(proofLoose(byId(note.id)), true);
    assert.ok(!activeSpendableNotes(getAllNotes()).some((n) => n.id === note.id), "blocked");
    assert.equal(byId(note.id).cashOutPlan, undefined, "a piece stops being one");
    await moveRevertedNotes(pool.env());
    assertMoved(note);
    await assertDead(sent);
  }
});

await test("a refused, failed, expired or gone cash out in a window moves too, and a job the relay kept dies with it", async () => {
  // refused: the relay saw the proof and said no
  const refusedNow = await handedOver();
  replies.push({ status: 429, body: { ok: false, code: "rate_limit", error: "Too many." } });
  await assert.rejects(scheduleNoteCashOut(refusedNow.note, refusedNow.call, "hour"), /Too many/);
  assert.equal(proofLoose(byId(refusedNow.note.id)), true);
  await moveRevertedNotes(pool.env());
  assertMoved(refusedNow.note);
  await assertDead(refusedNow.sent);

  for (const ending of ["failed", "expired", "gone"] as const) {
    const { note, sent, job } = await laterCashOut(false);
    if (ending === "gone") await store.forget(job.id);
    else await store.put({ ...(await store.get(job.id))!, status: ending, proof: "0x", reason: "Nothing moved." });
    if (ending === "gone") {
      assert.equal(await releaseGoneCashOut(byId(note.id), cashEnv(job.id)), true, "the Cancel a job the relay lost");
    } else {
      await reconcileTopUps(cashEnv(job.id));
      assert.equal(byId(note.id).cashOut!.state, ending);
      assert.ok(returnedCashOutNotes().some((n) => n.id === note.id), "a plain cash out still shows its notice");
      dismissReturnedCashOut(note.id);
    }
    assert.equal(proofLoose(byId(note.id)), true, ending);
    await moveRevertedNotes(pool.env());
    assertMoved(note);
    await assertDead(sent);
  }
});

await test("a cash out scheduled before the mark existed is caught when it comes back", async () => {
  // a browser that scheduled this yesterday: a mark, and no proofOutAt
  const { note, sent, job } = await laterCashOut(false);
  await updateLocalNote(note.id, { proofOutAt: undefined });
  assert.equal(byId(note.id).proofOutAt, undefined);
  assert.equal(await cancelCashOut(job.id, byId(note.id)), "cancelled");
  await cancelledPiece(note.id);
  assert.ok(byId(note.id).proofOutAt, "the mark says a proof left, so clearing it keeps that");
  assert.equal(proofLoose(byId(note.id)), true);
  await moveRevertedNotes(pool.env());
  assertMoved(note);
  await assertDead(sent);
});

await test("a cash out now, which is no job, leaves no mark", () => {
  const n = vaultNote("now-1", 5n * U);
  assert.equal(n.proofOutAt, undefined);
  assert.equal(proofLoose(n), false);
  assert.ok(activeSpendableNotes(getAllNotes()).some((x) => x.id === n.id));
});

// ---------------------------------------------------------------- not from a fresh deposit

const HOUR = 3_600_000;
const NOW = T0 + 100 * DAY_MS;
const quiet = (leafCount: number) => ({ leafCount, leafOf: () => undefined });
const depositId = (at: number) => `${at}-0xabcdef12`;
function note(id: string, createdAt: number, leafIndex: number | undefined, over: Partial<LocalNote> = {}): LocalNote {
  return { id, chainId: active.chainId, pool: active.pool!, asset: ASSET, amountWei: (600n * U).toString(), commitment: hex32(BigInt(0x9000000) + BigInt(leafIndex ?? 7)), secret: hex32(1), createdAt, leafIndex, bound: true, scheme: "poseidon", status: "open", source: "local", ...over };
}

await test("a deposit needs 6 hours and 3 later leaves, both, and the boundary is exact", () => {
  assert.equal(FUNDING_WAIT_MS, 6 * HOUR);
  assert.equal(FUNDING_WAIT_LEAVES, 3);
  const at = NOW - 6 * HOUR;
  const n = note(depositId(at), at, 100);
  assert.deepEqual(fundingGate(n, [n], quiet(104), NOW), { ok: true }, "6 hours and leaves 101, 102 and 103");
  assert.deepEqual(fundingGate(n, [n], quiet(104), NOW - 1), { ok: false, from: NOW, leavesLeft: 0 }, "a moment short of the time");
  assert.deepEqual(fundingGate(n, [n], quiet(103), NOW), { ok: false, from: NOW, leavesLeft: 1 }, "a leaf short");
  assert.deepEqual(fundingGate(n, [n], quiet(101), NOW + 30 * DAY_MS), { ok: false, from: NOW, leavesLeft: 3 }, "any amount of time is not enough alone");
  assert.deepEqual(fundingGate(n, [n], quiet(10_000), NOW - HOUR), { ok: false, from: NOW, leavesLeft: 0 }, "nor any number of leaves");
});

await test("the owner's own leaves don't count: a setup can't make its own room", () => {
  const at = NOW - 7 * HOUR;
  const n = note(depositId(at), at, 100);
  const mine = [note("co-a", at, 101), note("chg-b", at, 102), note("co-c", at, 103, { leafIndex: undefined, commitment: hex32(0xc0c) })];
  const vault = { leafCount: 104, leafOf: (c: string) => (c === hex32(0xc0c) ? 103 : undefined) };
  assert.deepEqual(fundingGate(n, [n, ...mine], vault, NOW), { ok: false, from: NOW - HOUR, leavesLeft: 3 });
  assert.deepEqual(fundingGate(n, [n, ...mine], { ...vault, leafCount: 106 }, NOW), { ok: false, from: NOW - HOUR, leavesLeft: 1 });
  assert.deepEqual(fundingGate(n, [n, ...mine], { ...vault, leafCount: 107 }, NOW), { ok: true });
});

await test("a balance split or moved from a deposit answers for that deposit, however many steps back", () => {
  const at = NOW - HOUR;
  const dep = note(depositId(at), at, 100, { status: "recovered" });
  const co = note("co-1", NOW - 20 * DAY_MS, 500, { status: "recovered", sweptFrom: { id: dep.id, nullifier: hex32(1) } });
  const chg = note("chg-2", NOW - 20 * DAY_MS, 501, { sweptFrom: { id: co.id, nullifier: hex32(2) } });
  const gate = fundingGate(chg, [dep, co, chg], quiet(10_000), NOW);
  assert.equal(gate.ok, false, "its own age says nothing: the deposit behind it is an hour old");
  assert.equal(!gate.ok && gate.from, at + FUNDING_WAIT_MS);
  assert.deepEqual(fundingGate(chg, [dep, co, chg], quiet(10_000), NOW + 6 * HOUR), { ok: true });
  // a reshield after a public swap is a deposit too
  const vt = note("vt-9", at, 100);
  assert.equal(fundingGate(vt, [vt], quiet(10_000), NOW).ok, false);
});

await test("a payment received has no deposit to point at, so it does not wait; neither does what came from it", () => {
  const imp = note("imp-1", NOW - 60_000, 100);
  assert.deepEqual(fundingGate(imp, [imp], quiet(101), NOW), { ok: true }, "a minute old, nothing after it");
  const secured = note("swp-1", NOW - 30_000, 102, { sweptFrom: { id: imp.id, nullifier: hex32(1) } });
  assert.deepEqual(fundingGate(secured, [imp, secured], quiet(103), NOW), { ok: true });
  const chg = note("chg-3", NOW - 1_000, 103, { sweptFrom: { id: secured.id, nullifier: hex32(2) } });
  assert.deepEqual(fundingGate(chg, [imp, secured, chg], quiet(104), NOW), { ok: true });
});

await test("where the trail stops short the last note found stands in, and a leaf that can't be placed counts as none later", () => {
  // change from a private payment keeps no link, and old rows are trimmed
  const chg = note("chg-4", NOW - HOUR, 100);
  assert.equal(fundingGate(chg, [chg], quiet(10_000), NOW).ok, false, "fresh, and nothing says what it came from");
  const orphan = note("chg-5", NOW - 30 * DAY_MS, 100, { sweptFrom: { id: "trimmed", nullifier: hex32(3) } });
  assert.deepEqual(fundingGate(orphan, [orphan], quiet(10_000), NOW), { ok: true }, "old enough itself");
  const nowhere = note("dep-1", NOW - 30 * DAY_MS, undefined);
  assert.deepEqual(fundingGate(nowhere, [nowhere], quiet(10_000), NOW), { ok: false, from: nowhere.createdAt + FUNDING_WAIT_MS, leavesLeft: 3 });
});

await test("the rule is checked at setup against the chain: nothing moves, and an unread vault stops it", async () => {
  reset();
  const at = Date.now() - HOUR;
  const fresh = vaultNote(depositId(at), 600n * U, { createdAt: at });
  const s = fakeSplitter();
  const d = deps(s);
  await assert.rejects(start(fresh, s), (e: Error) => {
    assert.match(e.message, /too recent to start from/);
    assert.match(e.message, /after /);
    return true;
  });
  assert.equal(s.calls(), 0, "nothing split");
  assert.equal(asked.length, 0, "nothing asked of the relay");
  assert.equal(byId(fresh.id).status, "open");
  // the leaves come from what the chain says now, not from what the note knows
  const old = vaultNote("dep-gate-1", 600n * U, { leafIndex: 50 });
  const quietChain = { ...d, vault: async () => quiet(51) };
  await assert.rejects(setUpTopUps({ note: old, owner: ME, agent: AGENT, amount: AMOUNT, every: "week", count: 2, deps: quietChain }), /3 more deposits or payments reach the vault/);
  // unread: refused, never waved through
  const down = { ...d, vault: async () => Promise.reject(new Error("Could not read the vault. Try again in a moment.")) };
  await assert.rejects(setUpTopUps({ note: old, owner: ME, agent: AGENT, amount: AMOUNT, every: "week", count: 2, deps: down }), /Could not read the vault/);
  assert.equal(s.calls(), 0);
  // finishing a series goes through the same door
  const series = { id: "s", to: AGENT, asset: ASSET, amount: AMOUNT, everyDays: 7, of: 4, rows: [], scheduled: 1, settling: false, missing: [{ piece: 2, day: tomorrow() }] };
  await assert.rejects(finishTopUps({ note: fresh, owner: ME, series, deps: d }), /too recent/);
  assert.equal(s.calls(), 0);
});

await test("a series takes the first balance it can start from, and says what the soonest one waits for", () => {
  const fresher = note(depositId(NOW - HOUR), NOW - HOUR, 100, { amountWei: (600n * U).toString() });
  const older = note(depositId(NOW - 9 * HOUR), NOW - 9 * HOUR, 90, { amountWei: (900n * U).toString() });
  const all = [fresher, older];
  assert.equal(pickReadyNote(all, all, quiet(10_000), NOW).note?.id, older.id, "skips the fresh one");
  const both = pickReadyNote([fresher, note(depositId(NOW - 2 * HOUR), NOW - 2 * HOUR, 95)], all, quiet(10_000), NOW);
  assert.equal(both.note, null);
  assert.ok(both.wait && !both.wait.ok);
  assert.equal(!both.wait!.ok && both.wait!.from, NOW + 4 * HOUR, "the sooner of the two");
});

await test("the wait reads plainly, with the time, the leaves, or both", () => {
  const today = new Date(2027, 5, 15, 9, 0).getTime();
  const later = new Date(2027, 5, 15, 16, 10).getTime();
  const both = fundingWaitLine({ ok: false, from: later, leavesLeft: 2 }, today);
  assert.match(both, /^This balance is too recent to start from: a top-up's proof could point back at your deposit\. You can start after 4:10\sPM, once 2 more deposits or payments reach the vault\.$/);
  assert.match(fundingWaitLine({ ok: false, from: later, leavesLeft: 0 }, today), /You can start after 4:10\sPM\.$/);
  assert.match(fundingWaitLine({ ok: false, from: today - 1, leavesLeft: 1 }, today), /You can start once 1 more deposit or payment reaches the vault\.$/);
  assert.match(fundingWaitLine({ ok: false, from: new Date(2027, 5, 16, 2, 0).getTime(), leavesLeft: 0 }, today), /after tomorrow at 2:00\sAM\.$/);
  assert.match(fundingWaitLine({ ok: false, from: new Date(2027, 5, 20, 2, 0).getTime(), leavesLeft: 0 }, today), /after Jun 20 at 2:00\sAM\.$/);
  assert.doesNotMatch(both, /\u2014|anonymous|untraceable/i);
});

// ---------------------------------------------------------------- off on Ethereum mainnet

await test("top-ups are off on Ethereum mainnet and nowhere else", () => {
  assert.equal(getNetwork("ethereum-mainnet").chainId, 1);
  assert.equal(datedOff(1), true);
  for (const key of ["robinhood-mainnet", "tempo-mainnet", "base-mainnet", "robinhood", "tempo", "base", "ethereum"] as const) {
    assert.equal(datedOff(getNetwork(key).chainId), false, key);
  }
  assert.match(DATED_OFF_MESSAGE, /aren't offered on Ethereum/);
  assert.match(DATED_OFF_MESSAGE, /gas there costs more than the fee/);
  assert.doesNotMatch(DATED_OFF_MESSAGE, /\u2014|anonymous|untraceable/i);
});

await test("the relay refuses a dated job on Ethereum mainnet itself, before any count or chain read, and takes the same job elsewhere", async () => {
  const before = rpcCalls;
  const r = await post(scheduleBody({ chainId: 1, day: tomorrow() + 7 * DAY_MS }), "10.2.0.50");
  assert.deepEqual([r.status, r.json.code, r.json.error], [400, "dated_off", DATED_OFF_MESSAGE]);
  assert.equal(rpcCalls, before, "nothing read the chain");
  // a bad day is refused first or not, it is refused all the same; and the app's checks are not what stopped it
  assert.equal((await post(scheduleBody({ chainId: 1, day: 123 }), "10.2.0.50")).status, 400);
  // the same request on a chain that takes them
  const elsewhere = await post(scheduleBody({ day: tomorrow() + 7 * DAY_MS }), "10.2.0.50");
  assert.equal(elsewhere.status, 200, JSON.stringify(elsewhere.json));
  // an ordinary cash out on Ethereum is none of this rule's business
  const window = await post(scheduleBody({ chainId: 1, window: "6h" }), "10.2.0.51");
  assert.notEqual(window.json.code, "dated_off");
});

await test("the app refuses too, before anything moves, and the demo's pretend relay keeps the same rule", async () => {
  reset();
  const eth = vaultNote("eth-1", 600n * U, { chainId: 1 });
  const s = fakeSplitter();
  await assert.rejects(start(eth, s), /aren't offered on Ethereum/);
  assert.equal(s.calls(), 0, "nothing split");
  assert.equal(asked.length, 0, "nothing asked of the relay");
  assert.equal(byId(eth.id).status, "open");
  const r = await demoScheduleCashOut({ chainId: 1, nullifier: hex32(1), asset: ASSET, to: AGENT, amount: U, day: tomorrow() });
  assert.deepEqual(r.ok ? "taken" : r.code, "dated_off");
  const held = await demoScheduleCashOut({ chainId: 8453, nullifier: hex32(2), asset: ASSET, to: AGENT, amount: U, day: tomorrow() });
  assert.equal(held.ok, true, "Base keeps them");
});

await test("the copy says what shows, and promises nothing the chain can't keep", () => {
  const mainnet = getNetwork("robinhood-mainnet");
  assert.match(agentGasLine(mainnet)!, /its own ETH for gas on Robinhood Chain/);
  assert.match(agentGasLine(mainnet)!, /stablecoins only/);
  assert.match(agentGasLine(getNetwork("base-mainnet"))!, /its own ETH for gas on Base/);
  assert.equal(agentGasLine(getNetwork("tempo-mainnet")), null, "gas on Tempo is paid in stablecoins");
  const lines = [
    agentGasLine(mainnet)!,
    agentGasLine(getNetwork("base-mainnet"))!,
    ...(["upcoming", "going", "landing", "unscheduled", "sent", "returned", "cancelled"] as const).map((state) => topUpWhen({ state, at: T0 }, T0 + 1)),
  ];
  for (const l of lines) {
    assert.doesNotMatch(l, /—/);
    assert.doesNotMatch(l, /anonymous|untraceable/i);
  }
});

console.log(`\n${passed} passed`);
