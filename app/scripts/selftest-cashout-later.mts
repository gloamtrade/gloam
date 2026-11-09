/**
 * Self-test: the private cash-out upgrade.
 *
 * Cash out later (lib/relay/scheduled): the cron's job runner against the
 * in-memory store and a fake chain. Covers a due job, one not due yet, a root
 * the vault does not know, a note already spent, a re-run after a send (never
 * twice), a send whose reply was lost, a relay holding the spend in flight, a
 * refusal that can never succeed, a passing failure and the give-up after it,
 * an unreadable node, another run holding the lock, cancelling, and that a
 * job done with drops its proof.
 *
 * The review of 2026-10-22, one block per finding:
 *  1. one job per spend, saved in one step; a retry to another address is a
 *     conflict that carries the address the job really pays
 *  2. a send that may have gone out stays "sending" (never failed, cancelled
 *     or put back), however late, until the chain settles it
 *  3. the relay reads spent and the root at one pinned block
 *  4. (routes) without the shared store: 503, never "not found"
 *  5. the app puts a note back only on its own chain's word
 *  6. a split's two notes name the note they spend, so it is counted once
 *  7. scheduling dry-runs from a funded relay key, skipping an empty one
 *  8. the vault keeps every root, so a long wait does not expire a job
 *
 * Then the browser side: what each job status means for the note (nextMark),
 * and that a waiting cash out is out of the balance while one that came back
 * is spendable again. A different amount (lib/cashOutSplit): the amount match
 * (now lib/cashOutPlan), Round it, and the rule for keeping the split's notes
 * when the first step may have gone out.
 *
 * fetch is stubbed for the relay's chain calls (an in-process fake node);
 * anything else fails. Relay keys are throwaways made here.
 *
 * Run from app/:  ../mcp/node_modules/.bin/tsx scripts/selftest-cashout-later.mts
 */
import assert from "node:assert/strict";
import "./browser-shim.mjs";
import { toFunctionSelector, toHex, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;
delete process.env.CHAINALYSIS_API_KEY;
// Two relay keys: the first one empty, the second funded (finding 7).
const EMPTY_KEY = generatePrivateKey();
const FUNDED_KEY = generatePrivateKey();
process.env.GLOAM_RELAYER_PRIVATE_KEY = EMPTY_KEY;
process.env.GLOAM_RELAYER_PRIVATE_KEYS = FUNDED_KEY;

const {
  DELAY_WINDOWS,
  GIVE_UP_AFTER_MS,
  JOB_TTL_SEC,
  MAX_DELAY_MS,
  liveTtlSec,
  MIN_DELAY_MS,
  SENDING_STALE_MS,
  REPROVE_MIN_LEAD_MS,
  cancelJob,
  drawSendAfter,
  drawSendOn,
  secureRandom,
  jobView,
  memoryJobStore,
  replaceJobProof,
  replaceRefusal,
  runDueJobs,
  scheduleJob,
} = await import("../src/lib/relay/scheduled");
const { markFor, nextMark, reconcileCashOuts, releaseGoneCashOut } = await import("../src/lib/cashOutLater");
const { roundDownToWhole, splitMaybeSent, splitNotes } = await import("../src/lib/cashOutSplit");
const { findCashOutLink } = await import("../src/lib/cashOutPlan");
const { activeSpendableNotes, cashOutPending, notesToMove, proofLoose, saveLocalNote } = await import("../src/lib/shield");
const { getActiveNetwork, getNetwork } = await import("../src/lib/networks");
const { getAllNotes } = await import("../src/lib/noteVault");
const { RelaySubmitError } = await import("../src/lib/relay/client");
const { isSecuredClaim, reconcileClaims } = await import("../src/lib/claimSweep");
const {
  MAYBE_SENT_MESSAGE,
  RelayError,
  checkUnshieldForLater,
  fundedRelayAccounts,
  readSpendState,
  relayUnshield,
  sendFailure,
  sendUnshieldNow,
} = await import("../src/lib/relay/server");
const { CREATE_SCRIPT, scheduledStore } = await import("../src/lib/relay/scheduledStore");
type CashOutJob = import("../src/lib/relay/scheduled").CashOutJob;
type ChainView = import("../src/lib/relay/scheduled").ChainView;
type LocalNote = import("../src/lib/shield").LocalNote;
type CashOutEnv = import("../src/lib/cashOutLater").CashOutEnv;
type ClaimEnv = import("../src/lib/claimSweep").ClaimEnv;

let passed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  await fn();
  passed++;
  console.log(`ok  ${name}`);
}

const T0 = 1_800_000_000_000;
const ASSET = "0x5fc5360d0400a0fd7f72d4d3ad5e65e8ee9cb3d4" as Address;
const TO = "0x1111111111111111111111111111111111111111" as Address;
const hex32 = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;

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
    to: TO,
    amount: "5000000",
    createdAt: T0 - 60_000,
    sendAfter: T0 - 1,
    status: "scheduled",
    attempts: 0,
    updatedAt: T0 - 60_000,
    ...over,
  };
}

class SendError extends Error {
  constructor(
    message: string,
    public code: string
  ) {
    super(message);
  }
}

/** A chain and relay that follow the pool's rules: a nullifier is spent once, an old root is refused. */
function fakeChain() {
  const spent = new Set<string>();
  const known = new Set<string>();
  const sends: string[] = [];
  let clock = T0;
  let nextSend: ((j: CashOutJob) => Hex) | null = null;
  let readFails = false;
  return {
    spent,
    known,
    sends,
    set now(t: number) {
      clock = t;
    },
    get now() {
      return clock;
    },
    failNextSend(f: (j: CashOutJob) => Hex) {
      nextSend = f;
    },
    set readFails(v: boolean) {
      readFails = v;
    },
    deps: {
      now: () => clock,
      readChain: async (j: CashOutJob): Promise<ChainView> => {
        if (readFails) throw new Error("node down");
        return { spent: spent.has(j.nullifier), knownRoot: known.has(j.root) };
      },
      send: async (j: CashOutJob): Promise<Hex> => {
        sends.push(j.id);
        if (nextSend) {
          const f = nextSend;
          nextSend = null;
          return f(j);
        }
        if (spent.has(j.nullifier)) throw new SendError("already spent", "AlreadySpent");
        if (!known.has(j.root)) throw new SendError("unknown root", "UnknownRoot");
        spent.add(j.nullifier);
        return hex32(0xbeef);
      },
    },
  };
}

async function setup(...jobs: CashOutJob[]) {
  const store = memoryJobStore();
  const chain = fakeChain();
  for (const j of jobs) {
    await store.put(j);
    chain.known.add(j.root);
  }
  return { store, chain };
}

// ---------------------------------------------------------------- send time

await test("send time is drawn inside the window, never right away", () => {
  for (const w of ["hour", "6h", "day"] as const) {
    const lo = drawSendAfter(T0, w, () => 0);
    const hi = drawSendAfter(T0, w, () => 0.999999999);
    assert.equal(lo, T0 + MIN_DELAY_MS);
    assert.ok(hi < T0 + DELAY_WINDOWS[w] && hi > T0 + DELAY_WINDOWS[w] - 1000);
    for (let i = 0; i < 500; i++) {
      const t = drawSendAfter(T0, w);
      assert.ok(t >= T0 + MIN_DELAY_MS && t < T0 + DELAY_WINDOWS[w]);
    }
  }
  // drawn from the platform's cryptographic source, not Math.random
  const realRandom = Math.random;
  Math.random = () => 0.5;
  try {
    const draws = new Set(Array.from({ length: 200 }, () => drawSendAfter(T0, "day")));
    assert.ok(draws.size > 190, `send times vary whatever Math.random says (${draws.size} of 200)`);
    const day = T0 - (T0 % 86_400_000) + 3 * 86_400_000;
    const dated = new Set(Array.from({ length: 200 }, () => drawSendOn(T0, day)));
    assert.ok(dated.size > 190 && [...dated].every((t) => t >= day && t < day + 86_400_000), "a dated one too, inside its day");
  } finally {
    Math.random = realRandom;
  }
  const rs = Array.from({ length: 2000 }, secureRandom);
  assert.ok(rs.every((r) => r >= 0 && r < 1), "in [0, 1)");
  assert.ok(rs.some((r) => r < 0.1) && rs.some((r) => r > 0.9), "spread across it");
  assert.equal(DELAY_WINDOWS.hour, 60 * 60 * 1000);
  assert.equal(DELAY_WINDOWS["6h"], 6 * 60 * 60 * 1000);
  assert.equal(DELAY_WINDOWS.day, MAX_DELAY_MS);
  assert.equal(MAX_DELAY_MS, 24 * 60 * 60 * 1000);
  // a job waiting its longest, then retrying until it gives up, is still on record
  assert.ok(JOB_TTL_SEC * 1000 > MAX_DELAY_MS + GIVE_UP_AFTER_MS);
  assert.ok(liveTtlSec({ sendAfter: T0 + MAX_DELAY_MS }, T0) * 1000 > MAX_DELAY_MS + GIVE_UP_AFTER_MS);
});

// ---------------------------------------------------------------- the runner

await test("a due job is sent once and recorded with its hash", async () => {
  const j = job();
  const { store, chain } = await setup(j);
  const out = await runDueJobs(store, chain.deps);
  assert.deepEqual(out, [{ id: j.id, status: "sent" }]);
  const after = (await store.get(j.id))!;
  assert.equal(after.status, "sent");
  assert.equal(after.hash, hex32(0xbeef));
  assert.equal(after.attempts, 1);
  assert.equal(after.proof, "0x", "a sent job drops its proof");
  assert.equal(after.createdAt, 0, "and when it was asked for");
  assert.equal(after.sendAfter, j.sendAfter, "the job view still reads");
  assert.equal(chain.sends.length, 1);
});

await test("a job not due yet is left alone", async () => {
  const j = job({ sendAfter: T0 + 60_000 });
  const { store, chain } = await setup(j);
  assert.deepEqual(await runDueJobs(store, chain.deps), []);
  assert.equal((await store.get(j.id))!.status, "scheduled");
  assert.equal(chain.sends.length, 0);
  chain.now = T0 + 60_000;
  assert.deepEqual(await runDueJobs(store, chain.deps), [{ id: j.id, status: "sent" }]);
});

await test("a root the vault does not know expires the job and sends nothing", async () => {
  const j = job();
  const { store, chain } = await setup(j);
  chain.known.delete(j.root);
  assert.deepEqual(await runDueJobs(store, chain.deps), [{ id: j.id, status: "expired" }]);
  const after = (await store.get(j.id))!;
  assert.equal(after.proof, "0x");
  assert.ok(after.reason);
  assert.equal(chain.sends.length, 0);
});

await test("a note already spent elsewhere is marked spent, not sent", async () => {
  const j = job();
  const { store, chain } = await setup(j);
  chain.spent.add(j.nullifier);
  assert.deepEqual(await runDueJobs(store, chain.deps), [{ id: j.id, status: "spent" }]);
  assert.equal(chain.sends.length, 0);
});

await test("re-running after a send never sends again", async () => {
  const j = job();
  const { store, chain } = await setup(j);
  await runDueJobs(store, chain.deps);
  chain.now = T0 + 10 * 60_000;
  assert.deepEqual(await runDueJobs(store, chain.deps), []);
  // even if the record were put back in the queue by mistake
  await store.put({ ...(await store.get(j.id))!, status: "scheduled", proof: "0xabcdef" });
  assert.deepEqual(await runDueJobs(store, chain.deps), [{ id: j.id, status: "sent" }]);
  assert.equal(chain.sends.length, 1, "the chain read found it spent: no second send");
});

await test("a send that went out but lost its reply stays 'sending', then settles as sent from the chain", async () => {
  const j = job();
  const { store, chain } = await setup(j);
  chain.failNextSend((x) => {
    chain.spent.add(x.nullifier); // it landed
    throw new SendError("timeout", "maybe_sent");
  });
  assert.deepEqual(await runDueJobs(store, chain.deps), [{ id: j.id, status: "sending" }]);
  chain.now = T0 + 60_000;
  assert.deepEqual(await runDueJobs(store, chain.deps), [], "read again only once the send is stale");
  chain.now = T0 + SENDING_STALE_MS + 1;
  assert.deepEqual(await runDueJobs(store, chain.deps), [{ id: j.id, status: "sent" }]);
  assert.equal(chain.sends.length, 1);
});

await test("a crash mid-send is read back from the chain, not sent twice", async () => {
  // the run died after marking "sending" and after the transaction went out
  const j = job({ status: "sending", attempts: 1, updatedAt: T0 - 1_000 });
  const { store, chain } = await setup(j);
  chain.spent.add(j.nullifier);
  assert.deepEqual(await runDueJobs(store, chain.deps), [], "fresh 'sending' is left to its run");
  chain.now = T0 + SENDING_STALE_MS + 1;
  assert.deepEqual(await runDueJobs(store, chain.deps), [{ id: j.id, status: "sent" }]);
  assert.equal(chain.sends.length, 0);
});

await test("a stale 'sending' that never went out is sent once", async () => {
  const j = job({ status: "sending", attempts: 1, updatedAt: T0 - SENDING_STALE_MS - 1 });
  const { store, chain } = await setup(j);
  assert.deepEqual(await runDueJobs(store, chain.deps), [{ id: j.id, status: "sent" }]);
  assert.equal(chain.sends.length, 1);
  assert.equal((await store.get(j.id))!.attempts, 2);
});

await test("a spend the relay holds in flight stays 'sending' and is read again later", async () => {
  const j = job();
  const { store, chain } = await setup(j);
  chain.failNextSend(() => {
    throw new SendError("already being sent", "in_flight");
  });
  assert.deepEqual(await runDueJobs(store, chain.deps), [{ id: j.id, status: "sending" }]);
  chain.now = T0 + 60_000;
  assert.deepEqual(await runDueJobs(store, chain.deps), []);
  chain.now = T0 + SENDING_STALE_MS + 60_000;
  assert.deepEqual(await runDueJobs(store, chain.deps), [{ id: j.id, status: "sent" }]);
  assert.equal(chain.sends.length, 2);
});

await test("a refusal that can never succeed fails at once and drops the proof", async () => {
  for (const code of ["screened", "asset_policy", "vault_recipient", "InvalidProof"]) {
    const j = job();
    const { store, chain } = await setup(j);
    chain.failNextSend(() => {
      throw new SendError("refused", code);
    });
    assert.deepEqual(await runDueJobs(store, chain.deps), [{ id: j.id, status: "failed" }], code);
    assert.equal((await store.get(j.id))!.proof, "0x");
  }
});

await test("the relay's own spent / old-root answers settle the job", async () => {
  const a = job();
  const b = job();
  const { store, chain } = await setup(a, b);
  chain.failNextSend(() => {
    throw new SendError("spent", "AlreadySpent");
  });
  await runDueJobs(store, chain.deps, 1);
  assert.equal((await store.get(a.id))!.status, "spent");
  chain.failNextSend(() => {
    throw new SendError("old root", "UnknownRoot");
  });
  await runDueJobs(store, chain.deps, 1);
  assert.equal((await store.get(b.id))!.status, "expired");
});

await test("a passing failure retries, then gives up when long overdue", async () => {
  const j = job();
  const { store, chain } = await setup(j);
  chain.failNextSend(() => {
    throw new SendError("busy", "busy");
  });
  assert.deepEqual(await runDueJobs(store, chain.deps), [{ id: j.id, status: "scheduled" }]);
  assert.ok((await store.get(j.id))!.reason);
  chain.now = j.sendAfter + GIVE_UP_AFTER_MS + 1;
  chain.failNextSend(() => {
    throw new SendError("busy", "busy");
  });
  assert.deepEqual(await runDueJobs(store, chain.deps), [{ id: j.id, status: "failed" }]);
  assert.equal(chain.sends.length, 2);
});

await test("an unreadable node sends nothing and tries again", async () => {
  const j = job();
  const { store, chain } = await setup(j);
  chain.readFails = true;
  assert.deepEqual(await runDueJobs(store, chain.deps), [{ id: j.id, status: "scheduled" }]);
  chain.now = j.sendAfter + GIVE_UP_AFTER_MS + 1;
  assert.deepEqual(await runDueJobs(store, chain.deps), [{ id: j.id, status: "failed" }]);
  assert.equal(chain.sends.length, 0);
});

await test("a job another run holds is skipped", async () => {
  const j = job();
  const { store, chain } = await setup(j);
  const release = (await store.lock(j.id, 90))!;
  assert.deepEqual(await runDueJobs(store, chain.deps), [{ id: j.id, status: "skipped" }]);
  await release();
  assert.deepEqual(await runDueJobs(store, chain.deps), [{ id: j.id, status: "sent" }]);
});

await test("jobs go out oldest first, and a run stops taking new ones past its budget", async () => {
  const late = job({ sendAfter: T0 - 10 });
  const early = job({ sendAfter: T0 - 500 });
  const { store, chain } = await setup(late, early);
  const out = await runDueJobs(store, chain.deps);
  assert.deepEqual(out.map((r) => r.id), [early.id, late.id]);

  const a = job();
  const b = job();
  const s2 = await setup(a, b);
  let t = T0;
  const slow = { ...s2.chain.deps, now: () => (t += 30_000) };
  const out2 = await runDueJobs(s2.store, slow, 20, 40_000);
  assert.equal(out2.length, 1, "the second job waits for the next pass");
});

await test("a job record that is gone is taken out of the queue", async () => {
  const ghost = job();
  const { store, chain } = await setup(ghost);
  const forgot: string[] = [];
  const lost = {
    ...store,
    get: async () => null,
    forget: async (id: string) => {
      forgot.push(id);
      await store.forget(id);
    },
  };
  assert.deepEqual(await runDueJobs(lost, chain.deps), [{ id: ghost.id, status: "skipped" }]);
  assert.deepEqual(forgot, [ghost.id]);
  assert.deepEqual(await store.due(T0, 20), []);
  assert.equal(chain.sends.length, 0);
});

await test("one live job per spend", async () => {
  const j = job();
  const { store } = await setup(j);
  assert.equal(await store.byNullifier(4663, j.nullifier), j.id);
  assert.equal(await store.byNullifier(4663, j.nullifier.toUpperCase().replace("0X", "0x") as Hex), j.id);
  assert.equal(await store.byNullifier(4217, j.nullifier), null);
  await store.put({ ...j, status: "expired" });
  assert.equal(await store.byNullifier(4663, j.nullifier), null);
});

await test("cancel works only before it goes out", async () => {
  const j = job({ sendAfter: T0 + 60_000 });
  const { store, chain } = await setup(j);
  assert.equal(await cancelJob(store, j.id, T0, j.nullifier), "cancelled");
  assert.equal((await store.get(j.id))!.proof, "0x");
  chain.now = T0 + 120_000;
  assert.deepEqual(await runDueJobs(store, chain.deps), []);
  assert.equal(chain.sends.length, 0);

  const k = job({ status: "sending" });
  await store.put(k);
  assert.equal(await cancelJob(store, k.id, T0, k.nullifier), "sending");
  const held = (await store.lock(k.id, 30))!;
  assert.equal(await cancelJob(store, job().id, T0, `0x${"11".repeat(32)}`), null);
  assert.equal(await cancelJob(store, k.id, T0, k.nullifier), "sending", "a held lock means a run is sending it");
  await held();
});

await test("only whoever holds the note can cancel: the job's id alone is not enough", async () => {
  const j = job({ sendAfter: T0 + 60_000 });
  const { store } = await setup(j);
  for (const other of [`0x${"22".repeat(32)}`, "", "0x", j.nullifier.slice(0, 40), "not hex"]) {
    assert.equal(await cancelJob(store, j.id, T0, other), "not_yours", JSON.stringify(other));
  }
  assert.equal((await store.get(j.id))!.status, "scheduled", "nothing changed");
  assert.equal(await cancelJob(store, j.id, T0, j.nullifier.toUpperCase().replace("0X", "0x")), "cancelled", "the note's own, in any letter case");
});

await test("what a person can read about a job holds no proof or inputs", async () => {
  const v = jobView(job({ hash: hex32(7), reason: "x" })) as Record<string, unknown>;
  assert.deepEqual(Object.keys(v).sort(), ["chainId", "hash", "id", "reason", "sendAfter", "status", "updatedAt"]);
});

// ---------------------------------------------------------------- the browser side

const mark = { job: "j", at: T0 + 1_000, to: TO, state: "scheduled" as const };
const view = (status: string, over: object = {}) =>
  ({ id: "j", chainId: 4663, sendAfter: T0 + 1_000, status, updatedAt: T0, ...over }) as never;

await test("nextMark: each job status for the note", () => {
  assert.equal(nextMark(mark, view("scheduled")), null);
  assert.deepEqual(nextMark(mark, view("scheduled", { sendAfter: T0 + 5_000 })), { ...mark, at: T0 + 5_000 });
  // going out (or may be): on its way, no Cancel, never back to waiting
  assert.deepEqual(nextMark(mark, view("sending")), { ...mark, state: "sent" });
  const sentMark = { ...mark, state: "sent" as const };
  assert.equal(nextMark(sentMark, view("sending")), null);
  assert.equal(nextMark(sentMark, view("scheduled")), null);
  assert.deepEqual(nextMark(mark, view("sent")), { ...mark, state: "sent" });
  assert.deepEqual(nextMark(mark, view("spent")), { ...mark, state: "sent" });
  assert.deepEqual(nextMark(mark, view("expired")), { ...mark, state: "expired" });
  assert.deepEqual(nextMark(mark, view("failed")), { ...mark, state: "failed" });
  assert.deepEqual(nextMark(mark, view("cancelled")), { ...mark, state: "cancelled" });
  // the relay no longer holds it: says nothing (the chain settles a spend)
  assert.equal(nextMark(mark, "gone"), null);
  assert.equal(nextMark(sentMark, "gone"), null);
  // sent and old: no longer put back on time alone (reconcileCashOuts checks the receipt)
  assert.equal(nextMark(sentMark, view("sent", { updatedAt: T0 - 24 * 3_600_000 })), null);
});

await test("a waiting cash out is out of the balance, and one that came back stays out until its note has moved", () => {
  const net = getActiveNetwork();
  const base = {
    chainId: net.chainId,
    pool: net.pool!,
    asset: ASSET,
    amountWei: "5000000",
    createdAt: T0,
    bound: true,
    scheme: "poseidon" as const,
    status: "open" as const,
    source: "local" as const,
  };
  const n = (i: number, cashOut?: LocalNote["cashOut"]): LocalNote => ({
    ...base,
    id: `t-${i}`,
    commitment: hex32(500 + i),
    secret: hex32(600 + i),
    nullifier: hex32(700 + i),
    ...(cashOut ? { cashOut } : {}),
  });
  const notes = [
    n(1),
    n(2, { ...mark, state: "scheduled" }),
    n(3, { ...mark, state: "sent" }),
    n(4, { ...mark, state: "expired" }),
    n(5, { ...mark, state: "failed" }),
    n(6, { ...mark, state: "cancelled" }),
  ];
  for (const x of notes) saveLocalNote(x);
  assert.deepEqual(notes.map(cashOutPending), [false, true, true, false, false, false]);
  const ids = activeSpendableNotes(getAllNotes())
    .map((x) => x.id)
    .filter((id) => id.startsWith("t-"))
    .sort();
  // its proof is still good until the note is spent, however old the mark
  assert.deepEqual(ids, ["t-1"]);
  const moving = notesToMove(getAllNotes())
    .map((x) => x.id)
    .filter((id) => id.startsWith("t-"))
    .sort();
  assert.deepEqual(moving, ["t-4", "t-5", "t-6"]);
});

// ---------------------------------------------------------------- a different amount

await test("Round it rounds down to whole units", () => {
  assert.equal(roundDownToWhole(12_345_678n, 6), 12_000_000n);
  assert.equal(roundDownToWhole(999_999n, 6), 0n);
  assert.equal(roundDownToWhole(5_000_000n, 6), 5_000_000n);
  assert.equal(roundDownToWhole(1_500_000_000_000_000_000n, 18), 1_000_000_000_000_000_000n);
});

await test("an amount within 1% of money that came in the last 30 days is flagged (lib/cashOutPlan)", () => {
  const now = T0;
  const DAY = 24 * 3_600_000;
  const inc = (id: string, amountWei: string, ageMs: number, asset = ASSET) =>
    ({ id, amountWei, asset, createdAt: now - ageMs }) as LocalNote;
  // a deposit days ago, so only the amount lines it up (a deposit hours old is flagged whatever its amount)
  const notes = [inc(`${T0}-0xd1`, "100000000", 2 * DAY)];
  const flagged = (amount: bigint, ns = notes, asset: string = ASSET) => findCashOutLink(amount, ns, asset, now) !== null;
  assert.equal(flagged(100_000_000n), true, "exact");
  assert.equal(flagged(99_000_000n), true, "1% under");
  assert.equal(flagged(101_000_000n), true, "1% over");
  assert.equal(flagged(98_900_000n), false, "past 1%");
  assert.equal(flagged(100_000_000n, notes, ASSET.toUpperCase()), true, "asset case");
  assert.equal(flagged(100_000_000n, notes, TO), false, "another asset");
  assert.equal(flagged(100_000_000n, [inc(`${T0}-0xd2`, "100000000", 31 * DAY)]), false, "older than 30 days");
  assert.equal(flagged(100_000_000n, [inc("chg-1", "100000000", DAY)]), false, "change is not money in");
  assert.equal(flagged(100_000_000n, [inc("co-1", "100000000", DAY)]), false, "own split is not money in");
  assert.equal(flagged(100_000_000n, [inc("imp-1", "100000000", DAY)]), true, "a payment received is");
  assert.equal(flagged(0n), false);
});

await test("the split keeps its notes unless the first step surely never went out", () => {
  // through the relay: only a clear refusal means nothing went out
  for (const code of ["maybe_sent", "rpc", "network", "error", "internal", "in_flight"]) {
    assert.equal(splitMaybeSent(new RelaySubmitError("x", code), true), true, code);
  }
  for (const code of ["AlreadySpent", "UnknownRoot", "busy", "rate_limit", "relay_off", "screened", "check_failed"]) {
    assert.equal(splitMaybeSent(new RelaySubmitError("x", code), true), false, code);
  }
  assert.equal(splitMaybeSent(new Error("odd"), true), false, "not a relay answer: thrown before the relay was asked");
  // from the wallet: only a declined prompt or a failure before sending
  const declined = Object.assign(new Error("User rejected the request."), { name: "UserRejectedRequestError" });
  const reverted = Object.assign(new Error("would revert"), { name: "ContractFunctionRevertedError" });
  const timeout = Object.assign(new Error("request timed out"), { name: "TimeoutError" });
  assert.equal(splitMaybeSent(declined, false), false);
  assert.equal(splitMaybeSent(reverted, false), false);
  assert.equal(splitMaybeSent(timeout, false), true);
  assert.equal(splitMaybeSent(new Error("lost"), false), true);
});

// ---------------------------------------------------------------- review 2026-10-22

const OTHER = "0x2222222222222222222222222222222222222222" as Address;

// 1. A retry pays the old address while the app shows the new one.

await test("1. one job per spend: the same cash out comes back, another address is a conflict with the real one", async () => {
  const store = memoryJobStore();
  const a = job();
  assert.deepEqual(await scheduleJob(store, a), { job: a, outcome: "created" });
  // the same money, asked again with a fresh proof to the same address
  const again = await scheduleJob(store, { ...job(), nullifier: a.nullifier, root: a.root, proof: "0x1234" });
  assert.equal(again.outcome, "existing");
  assert.equal(again.job.id, a.id);
  // the same money to another address: refused, and what comes back pays the old one
  const moved = await scheduleJob(store, { ...job(), nullifier: a.nullifier, to: OTHER });
  assert.equal(moved.outcome, "conflict");
  assert.equal(moved.job.id, a.id);
  assert.equal(moved.job.to, TO);
  assert.deepEqual(markFor({ ...jobView(moved.job), to: moved.job.to }), { job: a.id, at: a.sendAfter, to: TO, state: "scheduled" });
  // another amount or asset is a conflict too
  assert.equal((await scheduleJob(store, { ...job(), nullifier: a.nullifier, amount: "1" })).outcome, "conflict");
  assert.equal((await scheduleJob(store, { ...job(), nullifier: a.nullifier, asset: OTHER })).outcome, "conflict");
  assert.equal(await store.byNullifier(4663, a.nullifier), a.id);
  // a job already going out shows as on its way
  await store.put({ ...a, status: "sending" });
  assert.equal(markFor({ ...jobView({ ...a, status: "sending" }), to: TO }).state, "sent");
});

await test("1. two requests for one spend at the same moment: exactly one is saved", async () => {
  const store = memoryJobStore();
  const x = job();
  const y = { ...job(), nullifier: x.nullifier, to: OTHER };
  const [rx, ry] = await Promise.all([scheduleJob(store, x), scheduleJob(store, y)]);
  assert.deepEqual([rx.outcome, ry.outcome].sort(), ["conflict", "created"]);
  const winner = rx.outcome === "created" ? x : y;
  assert.equal(await store.byNullifier(4663, x.nullifier), winner.id);
  assert.equal((await store.due(T0, 20)).length, 1);
});

await test("1. a spend whose job is over (or gone) can be scheduled again", async () => {
  const store = memoryJobStore();
  const a = job();
  await scheduleJob(store, a);
  await store.put({ ...a, status: "expired", proof: "0x" });
  const b = { ...job(), nullifier: a.nullifier, to: OTHER };
  assert.equal((await scheduleJob(store, b)).outcome, "created");
  assert.equal(await store.byNullifier(4663, a.nullifier), b.id);
  // the pointer names a job whose record is gone
  await store.forget(b.id);
  const c = { ...job(), nullifier: a.nullifier };
  assert.equal((await scheduleJob(store, c)).outcome, "created");
  assert.equal(await store.byNullifier(4663, a.nullifier), c.id);
});

await test("1. in Redis a new job is one EVAL: pointer, record and queue together", async () => {
  const realFetch = globalThis.fetch;
  const sent: unknown[] = [];
  process.env.UPSTASH_REDIS_REST_URL = "https://redis.selftest.invalid";
  process.env.UPSTASH_REDIS_REST_TOKEN = "selftest";
  globalThis.fetch = (async (_u: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as unknown[];
    sent.push(body);
    return new Response(JSON.stringify({ result: body[6] }), { status: 200 });
  }) as typeof fetch;
  try {
    const j = job();
    assert.equal(await scheduledStore().create(j), j.id);
    assert.equal(sent.length, 1, "one round trip");
    const [cmd, script, nkeys, nf, rec, due, id, json, ttl, score, replace] = sent[0] as unknown[];
    assert.equal(cmd, "EVAL");
    assert.equal(script, CREATE_SCRIPT);
    assert.equal(nkeys, 3);
    assert.equal(nf, `gloam:cashout:nf:4663:${j.nullifier}`);
    assert.equal(rec, `gloam:cashout:job:${j.id}`);
    assert.equal(due, "gloam:cashout:due");
    assert.equal(id, j.id);
    assert.equal(JSON.parse(String(json)).to, TO);
    assert.ok(Number(ttl) > 0);
    assert.equal(score, j.sendAfter);
    assert.equal(replace, "");
    // the script refuses to write over another job's pointer
    assert.match(CREATE_SCRIPT, /if cur and cur ~= ARGV\[1\] and cur ~= ARGV\[5\] then return cur end/);
    assert.ok(CREATE_SCRIPT.indexOf("return cur") < CREATE_SCRIPT.indexOf('"SET", KEYS[2]'), "checks before it writes");
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
  }
});

// 2. A maybe-sent cash out can be cancelled or failed, and the app says "nothing moved".

/** A relay that times out after the node took the transaction. */
function timesOutAfterSend(chain: ReturnType<typeof fakeChain>, code = "maybe_sent") {
  return (x: CashOutJob): Hex => {
    void x;
    throw new SendError("This may have gone out already.", code);
  };
}

await test("2. a send that may have gone out stays 'sending': cancel refused, the app never puts it back", async () => {
  for (const code of ["maybe_sent", "rpc", "error", "internal"]) {
    const j = job();
    const { store, chain } = await setup(j);
    chain.failNextSend(timesOutAfterSend(chain, code));
    assert.deepEqual(await runDueJobs(store, chain.deps), [{ id: j.id, status: "sending" }], code);
    const after = (await store.get(j.id))!;
    assert.equal(after.status, "sending");
    assert.equal(after.maybeSent, true);
    assert.equal(after.proof, j.proof, "the proof is kept: it can still be read back or sent");
    assert.equal(await cancelJob(store, j.id, chain.now, j.nullifier), "sending");
    assert.equal((await store.get(j.id))!.status, "sending");
    // the app: on its way, out of the balance
    const next = nextMark({ job: j.id, at: j.sendAfter, to: TO, state: "scheduled" }, jobView(after));
    assert.equal(next?.state, "sent");
    assert.equal(cashOutPending({ cashOut: next! }), true);
    // the transaction lands: the chain settles it as sent
    chain.spent.add(j.nullifier);
    chain.now = T0 + SENDING_STALE_MS + 1;
    assert.deepEqual(await runDueJobs(store, chain.deps), [{ id: j.id, status: "sent" }]);
  }
});

await test("2. long overdue and maybe sent: never failed, the proof kept", async () => {
  const j = job({ sendAfter: T0 - GIVE_UP_AFTER_MS - 1 });
  const { store, chain } = await setup(j);
  chain.failNextSend(timesOutAfterSend(chain));
  assert.deepEqual(await runDueJobs(store, chain.deps), [{ id: j.id, status: "sending" }]);
  // later passes keep failing in passing ways: still not "failed"
  for (let i = 1; i <= 3; i++) {
    chain.now = T0 + i * (SENDING_STALE_MS + 1);
    chain.failNextSend(() => {
      throw new SendError("busy", "busy");
    });
    assert.deepEqual(await runDueJobs(store, chain.deps), [{ id: j.id, status: "sending" }]);
  }
  const after = (await store.get(j.id))!;
  assert.equal(after.status, "sending");
  assert.equal(after.proof, j.proof);
  // the relay's dry run finds it spent (the first try landed): sent, not "spent elsewhere"
  chain.now += SENDING_STALE_MS + 1;
  chain.failNextSend(() => {
    throw new SendError("spent", "AlreadySpent");
  });
  assert.deepEqual(await runDueJobs(store, chain.deps), [{ id: j.id, status: "sent" }]);
});

await test("2. a stale 'sending' job and an unreadable node: stays 'sending', cancel refused", async () => {
  const j = job({ status: "sending", attempts: 1, updatedAt: T0 - SENDING_STALE_MS - 1 });
  const { store, chain } = await setup(j);
  chain.readFails = true;
  chain.now = T0 + GIVE_UP_AFTER_MS + 1;
  assert.deepEqual(await runDueJobs(store, chain.deps), [{ id: j.id, status: "sending" }]);
  assert.equal((await store.get(j.id))!.status, "sending");
  assert.equal(await cancelJob(store, j.id, chain.now, j.nullifier), "sending");
  assert.equal(chain.sends.length, 0);
});

await test("2. once a run reached the send, cancel is refused even if it waits again", async () => {
  const j = job();
  const { store, chain } = await setup(j);
  chain.failNextSend(() => {
    throw new SendError("busy", "busy");
  });
  assert.deepEqual(await runDueJobs(store, chain.deps), [{ id: j.id, status: "scheduled" }]);
  assert.equal(await cancelJob(store, j.id, chain.now, j.nullifier), "sending");
  assert.equal((await store.get(j.id))!.status, "scheduled", "left to go out on the next pass");
});

await test("2. the chain is the only way out unsent: root unknown with the note unspent", async () => {
  const j = job({ status: "sending", attempts: 1, maybeSent: true, updatedAt: T0 - SENDING_STALE_MS - 1 });
  const { store, chain } = await setup(j);
  chain.known.delete(j.root);
  assert.deepEqual(await runDueJobs(store, chain.deps), [{ id: j.id, status: "expired" }]);
  assert.equal(chain.sends.length, 0);
  // a refusal raised before the node only ends a job that never may have gone out
  const k = job({ status: "scheduled", attempts: 1, maybeSent: true });
  const s2 = await setup(k);
  s2.chain.failNextSend(() => {
    throw new SendError("refused", "screened");
  });
  assert.deepEqual(await runDueJobs(s2.store, s2.chain.deps), [{ id: k.id, status: "sending" }]);
});

await test("2. a send over its gas limit went nowhere: the job tries again, and gives up in time", async () => {
  const j = job();
  const { store, chain } = await setup(j);
  chain.failNextSend(() => {
    throw new SendError("refused", "gas_most");
  });
  assert.deepEqual(await runDueJobs(store, chain.deps), [{ id: j.id, status: "scheduled" }]);
  assert.ok(!(await store.get(j.id))!.maybeSent, "nothing went out");

  const late = job({ sendAfter: T0 - GIVE_UP_AFTER_MS - 1 });
  const s2 = await setup(late);
  s2.chain.failNextSend(() => {
    throw new SendError("refused", "gas_most");
  });
  assert.deepEqual(await runDueJobs(s2.store, s2.chain.deps), [{ id: late.id, status: "failed" }]);
});

await test("2. stuck 'sending' jobs never crowd a due one out of a run", async () => {
  const stuck = Array.from({ length: 25 }, () => job({ status: "sending", maybeSent: true, sendAfter: T0 - 600_000, updatedAt: T0 - 1_000 }));
  const fresh = job();
  const { store, chain } = await setup(...stuck, fresh);
  assert.deepEqual(await runDueJobs(store, chain.deps), [{ id: fresh.id, status: "sent" }]);
});

// 2 + 3 + 7: the relay itself, against a fake node.

const net = getNetwork("robinhood");
assert.ok(net.pool);
const RPC = net.chain.rpcUrls.default.http[0];
const SEL = { spent: toFunctionSelector("spent(bytes32)"), isKnownRoot: toFunctionSelector("isKnownRoot(bytes32)") };
const node = {
  block: 7n,
  spent: false,
  known: true,
  drop: false,
  lagging: false,
  calls: [] as { method: string; params: unknown[] }[],
};
const emptyAddr = privateKeyToAccount(EMPTY_KEY).address.toLowerCase();
const fundedAddr = privateKeyToAccount(FUNDED_KEY).address;
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
const TX_HASH = ("0x" + "ab".repeat(32)) as Hex;
type RpcReq = { id: number; method: string; params?: unknown[] };
function answer(r: RpcReq): { result?: unknown; error?: { code: number; message: string } } {
  const params = r.params ?? [];
  switch (r.method) {
    case "eth_chainId":
      return { result: toHex(net.chainId) };
    case "eth_blockNumber":
      return { result: toHex(node.block) };
    case "eth_getBlockByNumber":
      return { result: BLOCK };
    case "eth_getTransactionCount":
      return { result: "0x0" };
    case "eth_gasPrice":
    case "eth_maxPriorityFeePerGas":
      return { result: "0x1" };
    case "eth_getBalance":
      return { result: String(params[0]).toLowerCase() === emptyAddr ? "0x0" : toHex(10n ** 18n) };
    case "eth_estimateGas":
      return { result: "0x1b7740" };
    case "eth_call": {
      const tag = params[1];
      if (node.lagging && tag !== "latest") return { error: { code: -32000, message: "header not found" } };
      const sel = String((params[0] as { data?: string }).data).slice(0, 10);
      if (sel === SEL.spent) return { result: word(node.spent) };
      if (sel === SEL.isKnownRoot) return { result: word(node.known) };
      return { error: { code: -32000, message: `fake node: unknown call ${sel}` } };
    }
    case "eth_sendRawTransaction":
      return { result: TX_HASH };
    default:
      return { error: { code: -32601, message: `fake node: ${r.method} not handled` } };
  }
}
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.replace(/\/$/, "") !== RPC.replace(/\/$/, "")) throw new Error(`selftest: no network (${url})`);
  const body = JSON.parse(String(init?.body)) as RpcReq | RpcReq[];
  const list = Array.isArray(body) ? body : [body];
  for (const r of list) node.calls.push({ method: r.method, params: r.params ?? [] });
  // A dropped connection on the send: the node may or may not have the transaction.
  if (node.drop && list.some((r) => r.method === "eth_sendRawTransaction")) throw new TypeError("fetch failed");
  const out = list.map((r) => ({ jsonrpc: "2.0", id: r.id, ...answer(r) }));
  return new Response(JSON.stringify(Array.isArray(body) ? out : out[0]), { status: 200, headers: { "Content-Type": "application/json" } });
}) as typeof fetch;

function resetNode(over: Partial<typeof node> = {}) {
  Object.assign(node, { spent: false, known: true, drop: false, lagging: false }, over);
  node.calls.length = 0;
}
const PROOF = ("0x" + "22".repeat(256)) as Hex;
let nfSeq = 0x5000;
const body = (over: Record<string, unknown> = {}) => ({
  chainId: net.chainId,
  proof: PROOF,
  root: hex32(0x77),
  nullifier: hex32(++nfSeq),
  asset: ASSET,
  to: TO,
  amount: "5000000",
  ...over,
});

await test("2. the relay answers maybe_sent when the node may have taken the send; a refusal is not that", async () => {
  resetNode({ drop: true });
  await assert.rejects(relayUnshield(net, body()), (e: unknown) => {
    assert.ok(e instanceof RelayError);
    assert.equal(e.code, "maybe_sent");
    assert.equal(e.message, MAYBE_SENT_MESSAGE);
    return true;
  });
  assert.ok(node.calls.some((c) => c.method === "eth_sendRawTransaction"));
  assert.equal(sendFailure(new Error("The request timed out.")).code, "maybe_sent");
  assert.equal(sendFailure(new Error("already known")).code, "maybe_sent");
  assert.equal(sendFailure(new Error("insufficient funds for gas * price + value")).code, "relay_empty");
  assert.equal(sendFailure(new Error("nonce too low")).code, "rpc");
});

await test("2. end to end: a dropped send through the relay keeps the job 'sending' until the chain shows it", async () => {
  resetNode({ drop: true });
  const b = body();
  const j = job({ nullifier: b.nullifier as Hex, root: b.root as Hex, proof: PROOF });
  const store = memoryJobStore();
  await store.put(j);
  let clock = T0;
  const deps = {
    now: () => clock,
    readChain: (x: CashOutJob) => readSpendState(net, x.root, x.nullifier),
    send: (x: CashOutJob) => sendUnshieldNow(net, { proof: x.proof, root: x.root, nullifier: x.nullifier, asset: x.asset, to: x.to, amount: x.amount }),
  };
  assert.deepEqual(await runDueJobs(store, deps), [{ id: j.id, status: "sending" }]);
  assert.equal((await store.get(j.id))!.maybeSent, true);
  assert.equal(await cancelJob(store, j.id, clock, j.nullifier), "sending");
  // stale: read again; the relay still holds the spend in flight, so it stays "sending"
  resetNode();
  clock += SENDING_STALE_MS + 1;
  assert.deepEqual(await runDueJobs(store, deps), [{ id: j.id, status: "sending" }]);
  assert.ok(!node.calls.some((c) => c.method === "eth_sendRawTransaction"), "no second send while in flight");
  // it landed
  resetNode({ spent: true });
  clock += SENDING_STALE_MS + 1;
  assert.deepEqual(await runDueJobs(store, deps), [{ id: j.id, status: "sent" }]);
});

// 3. Expiry reads can disagree.

await test("3. spent and the root are read at one pinned block; a node without it counts as unread", async () => {
  resetNode();
  node.block = 0x2a_1234n;
  assert.deepEqual(await readSpendState(net, hex32(1), hex32(2)), { spent: false, knownRoot: true });
  const calls = node.calls.filter((c) => c.method === "eth_call");
  assert.equal(calls.length, 2);
  for (const c of calls) assert.equal(c.params[1], toHex(node.block), "both reads at the block just read");
  assert.ok(node.calls.findIndex((c) => c.method === "eth_blockNumber") < node.calls.findIndex((c) => c.method === "eth_call"));
  resetNode({ lagging: true });
  await assert.rejects(readSpendState(net, hex32(1), hex32(2)));
  node.block = 7n;
});

// 7. One empty relay key blocks scheduling.

await test("7. scheduling dry-runs from a funded key, skipping an empty first one", async () => {
  resetNode();
  const accounts = await fundedRelayAccounts(net);
  assert.deepEqual(accounts.map((a) => a.address), [fundedAddr]);
  await checkUnshieldForLater(net, body());
  const est = node.calls.find((c) => c.method === "eth_estimateGas");
  assert.ok(est);
  assert.equal(String((est.params[0] as { from?: string }).from).toLowerCase(), fundedAddr.toLowerCase());
  // every key empty: refused as the relay being out of gas, like a send now
  await assert.rejects(
    fundedRelayAccounts(net, undefined, async () => true),
    (e: unknown) => e instanceof RelayError && e.code === "relay_empty"
  );
});

// 5. A sent cash out shows as returned on another network.

const active = getActiveNetwork();
let markSeq = 0;
function marked(state: "scheduled" | "sent", over: Partial<LocalNote> = {}): LocalNote {
  markSeq++;
  const n: LocalNote = {
    id: `r5-${markSeq}`,
    chainId: active.chainId,
    pool: active.pool!,
    asset: ASSET,
    amountWei: "5000000",
    commitment: hex32(0x9000 + markSeq),
    secret: hex32(0xa000 + markSeq),
    nullifier: hex32(0xb000 + markSeq),
    createdAt: T0,
    bound: true,
    scheme: "poseidon",
    status: "open",
    source: "local",
    cashOut: { job: `job-r5-${markSeq}`, at: T0, to: TO, state },
    ...over,
  };
  saveLocalNote(n);
  return n;
}
const noteById = (id: string) => getAllNotes().find((n) => n.id === id)!;

function cashEnv(over: {
  views?: Record<string, unknown>;
  spent?: Record<string, boolean | null>;
  receipts?: Record<string, "success" | "reverted" | null>;
  now?: number;
}): CashOutEnv {
  return {
    chainId: active.chainId,
    pool: active.pool!,
    now: () => over.now ?? T0,
    status: async (id) => (over.views?.[id] as never) ?? null,
    isSpent: async (nf) => (over.spent && nf in over.spent ? over.spent[nf]! : null),
    receipt: async (h) => over.receipts?.[h] ?? null,
  };
}
const v = (id: string, status: string, extra: object = {}) => ({ id, chainId: active.chainId, sendAfter: T0, status, updatedAt: T0, ...extra });

await test("5. a note goes back only when its own chain shows it unspent", async () => {
  const spentNote = marked("scheduled");
  const unread = marked("scheduled");
  const unspent = marked("scheduled");
  const elsewhere = marked("scheduled", { chainId: active.chainId + 1 });
  const env = cashEnv({
    views: {
      [spentNote.cashOut!.job]: v(spentNote.cashOut!.job, "failed"),
      [unread.cashOut!.job]: v(unread.cashOut!.job, "failed"),
      [unspent.cashOut!.job]: v(unspent.cashOut!.job, "failed"),
      [elsewhere.cashOut!.job]: v(elsewhere.cashOut!.job, "failed"),
    },
    spent: { [spentNote.nullifier!]: true, [unread.nullifier!]: null, [unspent.nullifier!]: false, [elsewhere.nullifier!]: false },
  });
  assert.equal(await reconcileCashOuts(env), true);
  assert.equal(noteById(spentNote.id).cashOut!.state, "sent", "spent after all: on its way, the chain retires it");
  assert.equal(noteById(unread.id).cashOut!.state, "scheduled", "chain unread: left as it is");
  assert.equal(noteById(unspent.id).cashOut!.state, "failed", "relay and chain agree: it came back");
  assert.equal(proofLoose(noteById(unspent.id)), true, "and its note moves before it can be spent");
  assert.equal(noteById(elsewhere.id).cashOut!.state, "scheduled", "another network's note is not read on this one");
  const spendable = new Set(activeSpendableNotes(getAllNotes()).map((n) => n.id));
  assert.deepEqual([spentNote, unread, unspent, elsewhere].map((n) => spendable.has(n.id)), [false, false, false, false]);
});

await test("5. sent but not landed: back only on a reverted receipt with the note unspent", async () => {
  const reverted = marked("sent");
  const pending = marked("sent");
  const early = marked("sent");
  const hashOf = (n: LocalNote) => hex32(0xc000 + Number(n.id.slice(3)));
  const views: Record<string, unknown> = {};
  for (const n of [reverted, pending]) views[n.cashOut!.job] = v(n.cashOut!.job, "sent", { hash: hashOf(n), updatedAt: T0 - 31 * 60_000 });
  views[early.cashOut!.job] = v(early.cashOut!.job, "sent", { hash: hashOf(early), updatedAt: T0 - 60_000 });
  const env = cashEnv({
    views,
    spent: { [reverted.nullifier!]: false, [pending.nullifier!]: false, [early.nullifier!]: false },
    receipts: { [hashOf(reverted)]: "reverted", [hashOf(pending)]: null, [hashOf(early)]: "reverted" },
  });
  await reconcileCashOuts(env);
  assert.equal(noteById(reverted.id).cashOut!.state, "failed");
  assert.equal(noteById(pending.id).cashOut!.state, "sent", "no receipt yet: still on its way");
  assert.equal(noteById(early.id).cashOut!.state, "sent", "inside the grace period: not checked");
});

await test("5. a relay that forgot the job, or can't be read, never puts a note back on its own", async () => {
  const gone = marked("scheduled");
  const down = marked("sent");
  const env = cashEnv({ views: { [gone.cashOut!.job]: "gone" }, spent: { [gone.nullifier!]: false, [down.nullifier!]: false } });
  assert.equal(await reconcileCashOuts(env), false);
  assert.equal(noteById(gone.id).cashOut!.state, "scheduled");
  assert.equal(noteById(down.id).cashOut!.state, "sent");
  // Cancel on a job the relay no longer holds: back only when the chain shows it unspent
  const goneSpent = marked("scheduled");
  assert.equal(await releaseGoneCashOut(goneSpent, cashEnv({ spent: { [goneSpent.nullifier!]: true } })), false);
  assert.equal(await releaseGoneCashOut(goneSpent, cashEnv({ spent: { [goneSpent.nullifier!]: null } })), false);
  assert.equal(noteById(goneSpent.id).cashOut!.state, "scheduled");
  assert.equal(await releaseGoneCashOut(gone, env), true);
  assert.equal(noteById(gone.id).cashOut, undefined);
});

await test("5b. a job on its way that the relay let go of comes back, once its record has aged out and the note is unspent", async () => {
  const days = (d: number) => d * 24 * 60 * 60 * 1000;
  const aged = marked("sent");
  const fresh = marked("sent");
  const spent = marked("sent");
  const env = cashEnv({
    now: aged.cashOut!.at + days(8),
    views: { [aged.cashOut!.job]: "gone", [spent.cashOut!.job]: "gone" },
    spent: { [aged.nullifier!]: false, [spent.nullifier!]: true },
  });
  await reconcileCashOuts(env);
  assert.equal(noteById(aged.id).cashOut!.state, "failed", "over: it shows as returned");
  assert.equal(noteById(spent.id).cashOut!.state, "sent", "spent: it went out");
  // A job missing inside the time a finished one is kept says nothing yet.
  await reconcileCashOuts(cashEnv({ now: fresh.cashOut!.at + days(1), views: { [fresh.cashOut!.job]: "gone" }, spent: { [fresh.nullifier!]: false } }));
  assert.equal(noteById(fresh.id).cashOut!.state, "sent");
});

// 6. A split can be counted twice.

await test("6. a split's notes name the note they spend, and landing retires it: counted once", async () => {
  const original: LocalNote = {
    id: "dep-split-1",
    chainId: active.chainId,
    pool: active.pool!,
    asset: ASSET,
    amountWei: "10000000",
    commitment: hex32(0xd001),
    secret: hex32(0xd002),
    nullifier: hex32(0xd003),
    createdAt: T0,
    bound: true,
    scheme: "poseidon",
    status: "open",
    source: "local",
  };
  const out = (i: number, amountWei: string) => ({ amountWei, commitment: hex32(0xe000 + i), secret: hex32(0xe100 + i), nullifier: hex32(0xe200 + i) });
  const w = { paymentNote: out(1, "4000000"), changeNote: out(2, "6000000") } as never;
  const { part, change } = splitNotes(original, w, original.nullifier!, TO, T0);
  assert.ok(change);
  for (const n of [part, change]) {
    assert.deepEqual(n.sweptFrom, { id: original.id, nullifier: original.nullifier });
    assert.equal(isSecuredClaim(n), false, "a split is not a received payment");
  }
  assert.equal(isSecuredClaim({ ...part, sweptFrom: { id: "imp-1", nullifier: hex32(1) } }), true);
  assert.equal(splitNotes(original, { paymentNote: out(3, "10000000"), changeNote: out(4, "0") } as never, original.nullifier!, TO, T0 + 1).change, null);

  // the transfer may have gone out: both kept as pending, the original still open
  saveLocalNote(original);
  saveLocalNote({ ...part, sweepPending: true });
  saveLocalNote({ ...change, sweepPending: true });
  const ids = [original.id, part.id, change.id];
  const counted = () =>
    activeSpendableNotes(getAllNotes())
      .filter((n) => ids.includes(n.id))
      .reduce((t, n) => t + BigInt(n.amountWei), 0n);
  assert.equal(counted(), 10_000_000n, "before it lands: only the original counts");
  // it landed: the sync counts the new notes and, in the same step, retires the original
  const env = {
    chainId: active.chainId,
    pool: active.pool!,
    stateAt: async () => ({ spent: true, seen: true }),
    leafIndexOf: async () => 3,
  } as unknown as ClaimEnv;
  assert.equal(await reconcileClaims(env), true);
  assert.equal(noteById(original.id).status, "recovered");
  assert.equal(counted(), 10_000_000n, "after: the two new notes, never the original as well");
});

await test("6. a split that can never land (the original spent another way) leaves the balance", async () => {
  const original: LocalNote = {
    id: "dep-split-2",
    chainId: active.chainId,
    pool: active.pool!,
    asset: ASSET,
    amountWei: "8000000",
    commitment: hex32(0xd101),
    secret: hex32(0xd102),
    nullifier: hex32(0xd103),
    createdAt: T0,
    bound: true,
    scheme: "poseidon",
    status: "open",
    source: "local",
  };
  const out = (i: number, amountWei: string) => ({ amountWei, commitment: hex32(0xf000 + i), secret: hex32(0xf100 + i), nullifier: hex32(0xf200 + i) });
  const { part, change } = splitNotes(original, { paymentNote: out(1, "3000000"), changeNote: out(2, "5000000") } as never, original.nullifier!, TO, T0 + 7);
  saveLocalNote({ ...part, sweepPending: true });
  saveLocalNote({ ...change!, sweepPending: true });
  const env = {
    chainId: active.chainId,
    pool: active.pool!,
    stateAt: async () => ({ spent: true, seen: false }),
    leafIndexOf: async () => undefined,
  } as unknown as ClaimEnv;
  await reconcileClaims(env);
  assert.equal(noteById(part.id).status, "recovered");
  assert.equal(noteById(change!.id).status, "recovered");
});

// 8. Long windows will often expire.

await test("8. a job that waited its whole window still goes out: the vault keeps every root", async () => {
  // The pool's isKnownRoot reads knownRoots (every root it ever had), not its
  // 100-entry history (contracts/src/lib/IncrementalMerkleTreePoseidon.sol).
  // On Robinhood mainnet, the empty tree's root is still known after 232 leaves.
  const j = job({ createdAt: T0 - MAX_DELAY_MS, sendAfter: T0 - 1 });
  const { store, chain } = await setup(j);
  assert.deepEqual(await runDueJobs(store, chain.deps), [{ id: j.id, status: "sent" }]);
  assert.deepEqual(Object.keys(DELAY_WINDOWS), ["hour", "6h", "day"]);
});

// 9. A waiting proof shows when it was made: the app swaps in a fresher one.

/** The same cash out as `j`, proven again against a later root. */
const fresher = (j: CashOutJob, over: Partial<Record<"chainId" | "nullifier" | "asset" | "to" | "amount", unknown>> = {}) =>
  ({
    chainId: j.chainId,
    proof: "0xfeed" as Hex,
    root: hex32(0x9999),
    nullifier: j.nullifier,
    asset: j.asset,
    to: j.to,
    amount: j.amount,
    ...over,
  }) as Parameters<typeof replaceJobProof>[2];

await test("9. a fresher proof of the same cash out replaces the old one: same job, send time, spend, recipient and amount", async () => {
  const j = job({ sendAfter: T0 + 3_600_000 });
  const { store, chain } = await setup(j);
  const r = await replaceJobProof(store, j.id, fresher(j), T0);
  assert.equal(r.ok, true);
  const after = (await store.get(j.id))!;
  assert.equal(after.proof, "0xfeed");
  assert.equal(after.root, hex32(0x9999));
  for (const k of ["id", "chainId", "nullifier", "asset", "to", "amount", "sendAfter", "status", "attempts", "createdAt"] as const) {
    assert.deepEqual(after[k], j[k], k);
  }
  // still the one job for its spend, still not due before its time
  assert.equal(await store.byNullifier(j.chainId, j.nullifier), j.id);
  assert.deepEqual(await store.due(T0, 10), []);
  // and at its time it goes out with the new proof: the chain here knows only the new root
  chain.known.clear();
  chain.known.add(hex32(0x9999));
  chain.now = j.sendAfter;
  assert.deepEqual(await runDueJobs(store, chain.deps), [{ id: j.id, status: "sent" }]);
  assert.deepEqual(chain.sends, [j.id]);
});

await test("9. a fresher proof is refused for another amount, recipient, asset, spend or chain, and the old one stays", async () => {
  const j = job({ sendAfter: T0 + 3_600_000 });
  const { store } = await setup(j);
  const cases: [string, Parameters<typeof fresher>[1]][] = [
    ["amount", { amount: "5000001" }],
    ["recipient", { to: OTHER }],
    ["asset", { asset: TO }],
    ["spend", { nullifier: hex32(0xdead) }],
    ["chain", { chainId: 46630 }],
  ];
  for (const [what, over] of cases) {
    const r = await replaceJobProof(store, j.id, fresher(j, over), T0);
    assert.deepEqual(r.ok ? "replaced" : r.code, "mismatch", what);
  }
  assert.equal((await store.get(j.id))!.proof, j.proof, "the old proof stays");
  assert.equal((await store.get(j.id))!.root, j.root);
});

await test("9. a fresher proof is refused once the job is not waiting untouched, or is under a minute from its time", async () => {
  const now = T0;
  const notLive = [
    job({ status: "cancelled", sendAfter: now + 3_600_000 }),
    job({ status: "sending", sendAfter: now + 3_600_000 }),
    job({ status: "sent", sendAfter: now + 3_600_000, hash: hex32(1) }),
    job({ status: "expired", sendAfter: now + 3_600_000 }),
    job({ status: "scheduled", attempts: 1, sendAfter: now + 3_600_000 }),
    job({ status: "scheduled", maybeSent: true, sendAfter: now + 3_600_000 }),
  ];
  const late = [job({ sendAfter: now + REPROVE_MIN_LEAD_MS - 1 }), job({ sendAfter: now - 1 })];
  const { store } = await setup(...notLive, ...late);
  for (const j of notLive) {
    const r = await replaceJobProof(store, j.id, fresher(j), now);
    assert.deepEqual(r.ok ? "replaced" : r.code, "not_live", `${j.status}/${j.attempts}/${j.maybeSent}`);
    assert.equal((await store.get(j.id))!.proof, j.proof);
  }
  for (const j of late) {
    const r = await replaceJobProof(store, j.id, fresher(j), now);
    assert.deepEqual(r.ok ? "replaced" : r.code, "too_late");
    assert.equal((await store.get(j.id))!.proof, j.proof);
  }
  assert.equal(replaceRefusal(null, fresher(job()), now), "not_found");
  // exactly a minute away is still taken
  assert.equal(replaceRefusal(job({ sendAfter: now + REPROVE_MIN_LEAD_MS }), fresher(job()), now) === "too_late", false);
});

await test("9. a fresher proof waits for a run holding the job, and never makes a second job for the spend", async () => {
  const j = job({ sendAfter: T0 + 3_600_000 });
  const { store } = await setup(j);
  const release = await store.lock(j.id, 90);
  const busy = await replaceJobProof(store, j.id, fresher(j), T0);
  assert.deepEqual(busy.ok ? "replaced" : busy.code, "busy");
  assert.equal((await store.get(j.id))!.proof, j.proof);
  await release!();
  assert.equal((await replaceJobProof(store, j.id, fresher(j), T0)).ok, true);
  assert.equal((await replaceJobProof(store, j.id, fresher(j, {}), T0 + 60_000)).ok, true, "again later: fine");
  // scheduling the same spend again still finds this one job, replaced or not
  const again = { ...job(), nullifier: j.nullifier, to: j.to, amount: j.amount, asset: j.asset, chainId: j.chainId };
  const s = await scheduleJob(store, again);
  assert.equal(s.outcome, "existing");
  assert.equal(s.job.id, j.id);
  const other = { ...job(), nullifier: j.nullifier, chainId: j.chainId, to: OTHER };
  assert.equal((await scheduleJob(store, other)).outcome, "conflict");
  assert.equal(await store.byNullifier(j.chainId, j.nullifier), j.id);
});

// 9 (routes): PATCH /api/relay/scheduled, the relay's own checks and dry run, against the fake node.

const route = await import("../src/app/api/relay/scheduled/route");
const routeStore = scheduledStore();
const call = (method: string, id: string | null, payload?: unknown) =>
  new Request(`http://localhost/api/relay/scheduled${id ? `?id=${id}` : ""}`, {
    method,
    headers: { "Content-Type": "application/json", "x-forwarded-for": "10.9.9.9" },
    ...(payload ? { body: JSON.stringify(payload) } : {}),
  });
type Answer = { ok?: boolean; id?: string; sendAfter?: number; to?: string; code?: string; existing?: boolean };
const read = async (r: Response) => ({ status: r.status, json: (await r.json()) as Answer });

await test("9 (routes). PATCH swaps the proof after the same checks and dry run; refusals keep the old one", async () => {
  resetNode();
  const first = body();
  const made = await read(await route.POST(call("POST", null, { ...first, window: "6h" })));
  assert.equal(made.status, 200);
  const id = made.json.id!;
  const stored = (await routeStore.get(id))!;
  assert.equal(stored.root, first.root);

  // asked again for the same cash out: the job already waiting, flagged so the app knows its proof isn't the new one
  const again = await read(await route.POST(call("POST", null, { ...first, window: "6h" })));
  assert.deepEqual([again.json.id, again.json.existing], [id, true]);

  // a fresher proof of the same cash out: the same job and send time
  resetNode();
  const newer = { ...first, proof: ("0x" + "33".repeat(256)) as Hex, root: hex32(0x78) };
  const swapped = await read(await route.PATCH(call("PATCH", id, newer)));
  assert.equal(swapped.status, 200);
  assert.deepEqual([swapped.json.id, swapped.json.sendAfter, swapped.json.to?.toLowerCase()], [id, made.json.sendAfter, TO.toLowerCase()]);
  assert.ok(node.calls.some((c) => c.method === "eth_estimateGas"), "dry-run like scheduling");
  assert.deepEqual([(await routeStore.get(id))!.root, (await routeStore.get(id))!.proof], [newer.root, newer.proof]);
  assert.equal(await routeStore.byNullifier(net.chainId, first.nullifier), id, "still the one job for the spend");

  // another amount or recipient: refused, nothing changes
  for (const over of [{ amount: "5000001" }, { to: OTHER }]) {
    const r = await read(await route.PATCH(call("PATCH", id, { ...newer, proof: ("0x" + "44".repeat(256)) as Hex, ...over })));
    assert.deepEqual([r.status, r.json.code], [409, "mismatch"]);
    assert.equal((await routeStore.get(id))!.proof, newer.proof);
  }
  // a root the vault doesn't know: the dry run refuses it, the last good proof stays
  resetNode({ known: false });
  const unknown = await read(await route.PATCH(call("PATCH", id, { ...newer, proof: ("0x" + "55".repeat(256)) as Hex, root: hex32(0x79) })));
  assert.equal(unknown.json.ok, false);
  assert.equal((await routeStore.get(id))!.root, newer.root);
  resetNode();

  // cancelling needs the spend's nullifier: without it, or with another, nothing changes
  const bare = await read(await route.DELETE(call("DELETE", id)));
  assert.deepEqual([bare.status, bare.json.code], [400, "owner_proof"]);
  const wrong = await read(await route.DELETE(call("DELETE", id, { nullifier: hex32(0x9999) })));
  assert.deepEqual([wrong.status, wrong.json.code], [403, "not_yours"]);
  assert.equal((await routeStore.get(id))!.status, "scheduled", "still waiting");
  // past waiting: cancelled, then nothing can replace it
  const cancelled = await read(await route.DELETE(call("DELETE", id, { nullifier: first.nullifier })));
  assert.equal(cancelled.json.ok, true);
  const gone = await read(await route.PATCH(call("PATCH", id, newer)));
  assert.deepEqual([gone.status, gone.json.code], [409, "not_live"]);

  // under a minute from its send time: refused before the dry run
  const soon = job({ chainId: net.chainId, nullifier: hex32(0x6100), sendAfter: Date.now() + 30_000 });
  await routeStore.put(soon);
  node.calls.length = 0;
  const tooLate = await read(
    await route.PATCH(call("PATCH", soon.id, { chainId: net.chainId, proof: newer.proof, root: hex32(0x78), nullifier: soon.nullifier, asset: soon.asset, to: soon.to, amount: soon.amount }))
  );
  assert.deepEqual([tooLate.status, tooLate.json.code], [409, "too_late"]);
  assert.equal(node.calls.length, 0, "no dry run for one that could never be taken");
  assert.equal((await routeStore.get(soon.id))!.proof, soon.proof);

  // an unknown job, and a malformed id
  assert.equal((await route.PATCH(call("PATCH", "00000000-0000-4000-8000-00000000ffff", newer))).status, 404);
  assert.equal((await route.PATCH(call("PATCH", "nope", newer))).status, 400);
});

console.log(`\n${passed} passed`);
