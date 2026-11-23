/**
 * Self-test: cash out more than one balance holds, in one go (lib/cashOutAcross).
 *
 * Rae and Duke, 23 Nov 2026: with $21 spread over three private balance
 * entries, cashing out $20 took three separate cash outs, because a cash out
 * spends one whole note.
 *
 * Here, against an in-memory vault that refuses a spent nullifier like the real
 * one:
 *  - the plan: whole notes largest first, then the rest out of the next one;
 *    over the balance or the part limit is refused with what can go now; notes
 *    that back a proof or a swap are left out
 *  - $20 from $10, $7 and $4 goes as $10, $7 and $3 (the $3 set aside from the
 *    $4 first, $1 change), each note paid out once, to the same address; the
 *    wallet gets each part less the fee on that part
 *  - crash safe: a part that may have gone out stops the run and is settled
 *    from the chain on resume, never sent twice; one that surely didn't land
 *    goes again; a set-aside part made before a crash is used, not made again
 *  - a set-aside whose transfer never went out (a lost answer) waits, then is
 *    made again from the same note once the resend window passes; the stale
 *    one is never cashed out
 *  - a part whose note something else spent while it waited is "moved", not
 *    paid; an unreadable log waits
 *  - a balance spent elsewhere fails its part and the rest go
 *  - one start at a time per account and vault; Stop the rest only when no part
 *    is on its way, from the stored run, and nothing goes after it
 *
 * Run from app/:  ../mcp/node_modules/.bin/tsx scripts/selftest-cashout-across.mts
 */
import assert from "node:assert/strict";
import "./browser-shim.mts";
import type { Address, Hex } from "viem";

const C = await import("../src/lib/cashOutAcross");
const { RUN_ELSEWHERE, withRunLock } = await import("../src/lib/payroll");
type LocalNote = import("../src/lib/shield").LocalNote;
type Run = import("../src/lib/cashOutAcross").CashOutAcrossRun;
type Deps = import("../src/lib/cashOutAcross").CashOutAcrossDeps;
type Call = import("../src/lib/cashOutProof").CashOutCall;

let passed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  await fn();
  passed++;
  console.log(`ok  ${name}`);
}

const POOL = "0x39E28Cde55CAB798874746ac52cb4B5Cc99a0194" as Address;
const ASSET = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address;
const OWNER = "0x1111111111111111111111111111111111111111" as Address;
const TO = "0x2222222222222222222222222222222222222222" as Address;
const $ = (n: number) => BigInt(Math.round(n * 1_000_000));
let seq = 0;
const hex = (n: number, w = 64) => `0x${n.toString(16).padStart(w, "0")}` as Hex;

function note(amount: bigint, extra: Partial<LocalNote> = {}): LocalNote {
  seq++;
  return {
    id: `n${seq}`,
    chainId: 8453,
    pool: POOL,
    asset: ASSET,
    amountWei: amount.toString(),
    commitment: hex(1000 + seq),
    secret: hex(2000 + seq),
    nullifier: hex(3000 + seq),
    bound: true,
    scheme: "poseidon",
    from: OWNER,
    createdAt: seq,
    status: "open",
    source: "local",
    leafIndex: seq,
    ...extra,
  } as LocalNote;
}

/** An in-memory vault and note store, with the engine's deps over them. */
function world(notes: LocalNote[]) {
  const byId = new Map(notes.map((n) => [n.id, n]));
  const runs = new Map<string, Run>();
  const spent = new Set<string>();
  const txs = new Map<string, "success" | "reverted" | null>();
  const paidOut: { to: Address; amount: bigint; nullifier: Hex; block: bigint }[] = [];
  let block = 100n;
  const submits: Hex[] = [];
  let splits = 0;
  let clock = 1_000_000;
  /** What the next submit does: "land", "maybe" (may have gone out, nothing landed yet), "fail" (surely not sent). */
  const plan: ("land" | "maybe" | "maybe-landed" | "fail")[] = [];
  const deps: Deps = {
    load: async (id) => (runs.has(id) ? JSON.parse(JSON.stringify(runs.get(id))) : null),
    save: async (r) => void runs.set(r.id, JSON.parse(JSON.stringify(r))),
    getNote: (id) => byId.get(id),
    findSplitPart: (noteId, amount, skip) =>
      [...byId.values()]
        .filter((n) => n.sweptFrom?.id === noteId && BigInt(n.amountWei) === amount && n.status === "open" && !skip.includes(n.id))
        .sort((a, b) => Number(!!a.sweepPending) - Number(!!b.sweepPending))[0],
    split: async (from, amount) => {
      splits++;
      const part = note(amount, { id: `co-${seq + 1}`, sweptFrom: { id: from.id, nullifier: from.nullifier! } });
      const change = note(BigInt(from.amountWei) - amount, { id: `chg-${seq + 1}`, sweptFrom: { id: from.id, nullifier: from.nullifier! } });
      byId.set(part.id, part);
      byId.set(change.id, change);
      spent.add(from.nullifier!.toLowerCase());
      byId.set(from.id, { ...from, status: "recovered" });
      return part;
    },
    prove: async (n, to): Promise<Call> => ({ chainId: 8453, proof: "0x01", root: "0x02", nullifier: n.nullifier!, asset: n.asset as Address, to, amount: BigInt(n.amountWei) }),
    submit: async (call) => {
      const how = plan.shift() ?? "land";
      submits.push(call.nullifier);
      if (how === "fail") throw new Error("User rejected the request.");
      const h = hex(9000 + submits.length);
      const land = () => {
        if (spent.has(call.nullifier.toLowerCase())) {
          txs.set(h, "reverted");
          return;
        }
        spent.add(call.nullifier.toLowerCase());
        block++;
        paidOut.push({ to: call.to, amount: call.amount, nullifier: call.nullifier, block });
        txs.set(h, "success");
      };
      if (how === "maybe") throw Object.assign(new Error("maybe sent"), { maybe: true });
      if (how === "maybe-landed") {
        land();
        throw Object.assign(new Error("maybe sent"), { maybe: true });
      }
      land();
      return h;
    },
    maybeSent: (e) => Boolean((e as { maybe?: boolean }).maybe),
    waitForTx: async (h) => txs.get(h) ?? null,
    isSpent: async (n) => spent.has(n.toLowerCase()),
    blockNumber: async () => block,
    payoutOf: async (nullifier, from) => {
      const hit = paidOut.find((x) => x.nullifier.toLowerCase() === nullifier.toLowerCase() && x.block >= from);
      return hit ? { to: hit.to, amount: hit.amount } : null;
    },
    markSpent: (id) => {
      const n = byId.get(id);
      if (n) byId.set(id, { ...n, status: "recovered" });
    },
    now: () => clock,
  };
  const store = {
    loadAll: async () => [...runs.values()].map((r) => JSON.parse(JSON.stringify(r)) as Run),
    load: deps.load,
    save: deps.save,
  };
  return {
    deps,
    store,
    byId,
    runs,
    spent,
    paidOut,
    submits,
    plan,
    splits: () => splits,
    tick: (ms: number) => void (clock += ms),
    clock: () => clock,
    /** Another send or cash out of this note, to another address, lands. */
    spendElsewhere: (nullifier: Hex, to: Address, amount: bigint) => {
      spent.add(nullifier.toLowerCase());
      block++;
      paidOut.push({ to, amount, nullifier, block });
    },
  };
}

function runFor(w: ReturnType<typeof world>, amount: bigint, notes: LocalNote[]) {
  const plan = C.planCashOutFrom(amount, notes);
  assert.ok(plan.ok, "planned");
  const amounts: Record<string, string> = {};
  for (const n of notes) amounts[n.id] = n.amountWei;
  return C.newCashOutRun({ chainId: 8453, pool: POOL, asset: ASSET, owner: OWNER, to: TO, relay: true, parts: plan.parts, noteIds: plan.noteIds, noteAmounts: amounts, now: Date.now() + seq++ });
}

await test("the plan: whole notes largest first, then the rest; over the balance or the limit says what can go", () => {
  const ten = note($(10)), seven = note($(7)), four = note($(4));
  const plan = C.planCashOutFrom($(20), [four, ten, seven]);
  assert.ok(plan.ok);
  assert.deepEqual(plan.parts, [$(10), $(7), $(3)]);
  assert.deepEqual(plan.noteIds, [ten.id, seven.id, four.id]);
  const over = C.planCashOutFrom($(22), [four, ten, seven]);
  assert.ok(!over.ok && over.reason === "over_total" && over.most === $(21));
  const many = C.planCashOutFrom($(7), Array.from({ length: 8 }, () => note($(1))));
  assert.ok(!many.ok && many.reason === "too_many_parts" && many.most === $(6));
  assert.equal(C.cashOutAcrossEligible(note($(1), { fundsProofAt: 1 } as Partial<LocalNote>)), false, "a note behind a proof of funds moves first, so it isn't planned");
  assert.equal(C.cashOutAcrossEligible(note($(1), { swapProofAt: 1 } as Partial<LocalNote>)), false);
  assert.equal(C.cashOutAcrossEligible(ten), true);
  const run = runFor(world([ten, seven, four]), $(20), [ten, seven, four]);
  assert.deepEqual(run.parts.map((p) => [p.whole, p.amount]), [[true, $(10).toString()], [true, $(7).toString()], [false, $(3).toString()]]);
  // 0.5% on each part
  const fee = (a: bigint) => (a * 50n) / 10_000n;
  assert.equal(C.cashOutAcrossReceived(plan.parts, fee), $(20) - fee($(10)) - fee($(7)) - fee($(3)));
});

await test("$20 from $10, $7 and $4: each note paid out once to one wallet, $1 of change kept", async () => {
  const ten = note($(10)), seven = note($(7)), four = note($(4));
  const w = world([ten, seven, four]);
  const run = runFor(w, $(20), [ten, seven, four]);
  await w.store.save(run);
  const done = await C.runCashOutAcross(run, w.deps);
  assert.equal(done.status, "done");
  assert.deepEqual(done.parts.map((p) => p.status), ["paid", "paid", "paid"]);
  assert.equal(w.splits(), 1, "only the last part is set aside first");
  assert.equal(w.paidOut.reduce((s, x) => s + x.amount, 0n), $(20), "exactly $20 left the vault");
  assert.ok(w.paidOut.every((x) => x.to === TO), "all to the same wallet");
  assert.equal(new Set(w.submits).size, w.submits.length, "no note sent twice");
  const change = [...w.byId.values()].find((n) => n.id.startsWith("chg-"));
  assert.equal(change?.amountWei, $(1).toString(), "$1 of change stays private");
  assert.ok([ten, seven].every((n) => w.byId.get(n.id)!.status === "recovered"), "the paid notes left the balance");
});

await test("a part that may have gone out is settled from the chain, never sent twice", async () => {
  const ten = note($(10)), seven = note($(7)), four = note($(4));
  const w = world([ten, seven, four]);
  const run = runFor(w, $(20), [ten, seven, four]);
  await w.store.save(run);
  // part 2's send is answered "may have gone out", and it did land
  w.plan.push("land", "maybe-landed");
  const first = await C.runCashOutAcross(run, w.deps);
  assert.equal(first.status, "running");
  assert.deepEqual(first.parts.map((p) => p.status), ["paid", "sent", "queued"]);
  assert.equal(first.parts[1]!.error, C.CASHOUT_MAYBE_SENT);
  const before = w.submits.length;
  const second = await C.runCashOutAcross(run, w.deps);
  assert.equal(second.status, "done");
  assert.deepEqual(second.parts.map((p) => p.status), ["paid", "paid", "paid"]);
  assert.equal(w.submits.length, before + 1, "resume sent only part 3: part 2 was found spent on the chain");
  assert.equal(w.paidOut.reduce((s, x) => s + x.amount, 0n), $(20), "and $20 left in all, not $27");
});

await test("one that surely never landed goes again, once; a fresh one waits for the chain", async () => {
  const ten = note($(10)), seven = note($(7));
  const w = world([ten, seven]);
  const run = runFor(w, $(17), [ten, seven]);
  await w.store.save(run);
  w.plan.push("land", "maybe");
  const first = await C.runCashOutAcross(run, w.deps);
  assert.equal(first.parts[1]!.status, "sent");
  // a minute later: not spent, no hash: still waiting, nothing sent
  w.tick(60_000);
  const wait = await C.runCashOutAcross(run, w.deps);
  assert.equal(wait.parts[1]!.status, "sent");
  assert.equal(wait.parts[1]!.error, C.CASHOUT_WAITING);
  assert.equal(w.submits.length, 2);
  // past the resend window, still unspent: sent again, and it lands
  w.tick(C.CASHOUT_RESEND_AFTER_MS);
  const done = await C.runCashOutAcross(run, w.deps);
  assert.equal(done.status, "done");
  assert.equal(w.paidOut.length, 2, "two payouts in all");
  assert.equal(w.paidOut.filter((x) => x.nullifier === seven.nullifier).length, 1, "the $7 note paid out once");
});

await test("a part set aside before a crash is used, not set aside again; one still landing waits", async () => {
  const ten = note($(10)), four = note($(4));
  const w = world([ten, four]);
  const run = runFor(w, $(13), [ten, four]);
  await w.store.save(run);
  // the crash came after the set-aside was made, before the run saved it
  const part = note($(3), { id: "co-made", sweptFrom: { id: four.id, nullifier: four.nullifier! }, sweepPending: true, createdAt: w.clock() } as Partial<LocalNote>);
  w.byId.set(part.id, part);
  const held = await C.runCashOutAcross(run, w.deps);
  assert.equal(held.parts[1]!.error, C.CASHOUT_WAITING, "still landing: it waits");
  assert.equal(w.splits(), 0);
  w.byId.set(part.id, { ...part, sweepPending: false });
  const done = await C.runCashOutAcross(run, w.deps);
  assert.equal(done.status, "done");
  assert.equal(w.splits(), 0, "never set aside twice");
  assert.equal(done.parts[1]!.targetNoteId, "co-made");
});

await test("a set-aside that never went out waits, then is made again from the same note; the stale one is never cashed out", async () => {
  const ten = note($(10)), four = note($(4));
  const w = world([ten, four]);
  const run = runFor(w, $(13), [ten, four]);
  await w.store.save(run);
  // the set-aside's answer was lost: both new notes saved as landing, nothing went out
  const realSplit = w.deps.split;
  let lost = true;
  w.deps.split = async (from, amount) => {
    if (!lost) return realSplit(from, amount);
    lost = false;
    const was = { id: from.id, nullifier: from.nullifier! };
    w.byId.set("co-lost", note(amount, { id: "co-lost", sweptFrom: was, sweepPending: true, createdAt: w.clock() } as Partial<LocalNote>));
    w.byId.set("chg-lost", note(BigInt(from.amountWei) - amount, { id: "chg-lost", sweptFrom: was, sweepPending: true, createdAt: w.clock() } as Partial<LocalNote>));
    throw Object.assign(new Error("It may have gone out."), { maybe: true });
  };
  await assert.rejects(C.runCashOutAcross(run, w.deps));
  // soon after: it may still land, so it waits, and nothing is set aside again
  w.tick(60_000);
  const held = await C.runCashOutAcross(run, w.deps);
  assert.equal(held.parts[1]!.error, C.CASHOUT_WAITING);
  assert.equal(held.parts[1]!.targetNoteId, "co-lost");
  assert.equal(w.splits(), 0);
  // the note it came from is spent (it landed, the sync hasn't counted it yet): still waits, even when old
  w.spent.add(four.nullifier!.toLowerCase());
  w.tick(C.CASHOUT_RESEND_AFTER_MS);
  assert.equal((await C.runCashOutAcross(run, w.deps)).parts[1]!.error, C.CASHOUT_WAITING);
  assert.equal(w.splits(), 0);
  w.spent.delete(four.nullifier!.toLowerCase());
  // long after with the note unspent: it never went out, so it is set aside again and the run finishes
  const done = await C.runCashOutAcross(run, w.deps);
  assert.equal(done.status, "done");
  assert.deepEqual(done.parts.map((p) => p.status), ["paid", "paid"]);
  assert.equal(w.splits(), 1, "set aside once more");
  assert.deepEqual(done.parts[1]!.staleSetAsides, ["co-lost"]);
  assert.notEqual(done.parts[1]!.targetNoteId, "co-lost");
  assert.ok(!w.submits.includes(w.byId.get("co-lost")!.nullifier!), "the stale set-aside is never cashed out");
  assert.equal(w.paidOut.reduce((s, x) => s + x.amount, 0n), $(13));
  assert.equal(w.byId.get("co-lost")!.status, "open", "kept for the sync, which drops it once the note it came from is spent");
});

await test("a part whose note something else spent while it waited is moved, not paid; an unreadable log waits", async () => {
  const ten = note($(10)), seven = note($(7));
  const w = world([ten, seven]);
  const run = runFor(w, $(17), [ten, seven]);
  await w.store.save(run);
  w.plan.push("land", "maybe");
  const first = await C.runCashOutAcross(run, w.deps);
  assert.equal(first.parts[1]!.status, "sent");
  assert.ok(first.parts[1]!.sentBlock, "the block is saved as it goes out");
  // the relay never sent it; the same note is cashed out elsewhere, to another wallet
  const OTHER = "0x3333333333333333333333333333333333333333" as Address;
  w.spendElsewhere(seven.nullifier!, OTHER, $(7));
  // the vault's log can't be read now: it waits rather than guess
  const unread = await C.runCashOutAcross(run, { ...w.deps, payoutOf: async () => Promise.reject(new Error("rpc down")) });
  assert.equal(unread.parts[1]!.status, "sent");
  assert.equal(unread.parts[1]!.error, C.CASHOUT_WAITING);
  const done = await C.runCashOutAcross(run, w.deps);
  assert.equal(done.status, "done");
  assert.deepEqual(done.parts.map((p) => p.status), ["paid", "failed"]);
  assert.equal(done.parts[1]!.error, C.CASHOUT_MOVED);
  assert.equal(C.cashOutPaid(done), $(10), "only the $10 counts as cashed out");
});

await test("a balance spent elsewhere fails its part, the rest go", async () => {
  const ten = note($(10)), seven = note($(7));
  const w = world([ten, seven]);
  const run = runFor(w, $(17), [ten, seven]);
  await w.store.save(run);
  w.spent.add(ten.nullifier!.toLowerCase());
  const done = await C.runCashOutAcross(run, w.deps);
  assert.deepEqual(done.parts.map((p) => p.status), ["failed", "paid"]);
  assert.equal(done.parts[0]!.error, C.CASHOUT_MOVED);
  assert.equal(w.paidOut.length, 1);
});

await test("a wallet that refuses stops the run with nothing lost; resume sends it", async () => {
  const ten = note($(10)), seven = note($(7));
  const w = world([ten, seven]);
  const run = runFor(w, $(17), [ten, seven]);
  await w.store.save(run);
  w.plan.push("land", "fail");
  await assert.rejects(C.runCashOutAcross(run, w.deps));
  const stored = (await w.store.load(run.id))!;
  assert.deepEqual(stored.parts.map((p) => p.status), ["paid", "ready"]);
  const done = await C.runCashOutAcross(run, w.deps);
  assert.equal(done.status, "done");
  assert.equal(w.paidOut.length, 2);
});

await test("one start at a time; Stop the rest only with nothing on its way, and nothing goes after it", async () => {
  const ten = note($(10)), seven = note($(7)), four = note($(4));
  const w = world([ten, seven, four]);
  const a = runFor(w, $(20), [ten, seven, four]);
  const b = runFor(w, $(20), [ten, seven, four]);
  const [x, y] = await Promise.all([C.startCashOutRun(a, w.store), C.startCashOutRun(b, w.store).catch((e) => e as Error)]);
  const started = [x, y].filter((r) => !(r instanceof Error) && r.started);
  assert.equal(started.length, 1, "two taps at once start one cash out");
  const again = await C.startCashOutRun(b, w.store);
  assert.equal(again.started, false, "while one isn't finished, a new one isn't started");
  assert.equal(again.run.id, (started[0] as { run: Run }).run.id, "the unfinished one comes back");
  const runId = again.run.id;

  // part 1 may have gone out: stopping now is refused
  w.plan.push("maybe");
  await C.runCashOutAcross({ id: runId }, w.deps);
  assert.equal(await C.stopCashOutRest({ id: runId }, w.store), null, "not while a part is on its way");
  // the chain settles it, then the rest can be stopped
  w.tick(C.CASHOUT_RESEND_AFTER_MS + 1);
  const r1 = await C.runCashOutAcross({ id: runId }, { ...w.deps, shouldStop: (() => { let n = 0; return () => n++ > 0; })() });
  assert.equal(r1.parts[0]!.status, "paid");
  const stopped = await C.stopCashOutRest({ id: runId }, w.store);
  assert.ok(stopped && stopped.status === "done");
  assert.deepEqual(stopped!.parts.map((p) => p.status), ["paid", "failed", "failed"]);
  assert.equal(stopped!.parts[1]!.error, C.CASHOUT_CANCELLED);
  const sends = w.submits.length;
  await C.runCashOutAcross({ id: runId }, w.deps);
  assert.equal(w.submits.length, sends, "a stopped cash out sends nothing more");
  // and a stop while another tab is cashing it out is refused
  const c = runFor(w, $(1), [note($(1))]);
  await w.store.save(c);
  await withRunLock(c.id, async () => {
    await assert.rejects(C.stopCashOutRest({ id: c.id }, w.store), (e: Error) => e.message === RUN_ELSEWHERE);
  });
});

console.log(`\n${passed} cash-out-across checks passed`);
