/**
 * Self-test: pay more than one balance holds, in one tap (lib/payAcross).
 *
 * HeisRae and Duke, 23 Nov 2026: with $21 spread over three private balance
 * entries, paying someone $20 took three or four separate sends, because a
 * private transfer spends exactly one note.
 *
 * Here:
 *  - the plan: whole notes largest first, then the rest out of the next one,
 *    the fewest parts there can be; over the balance or over the part limit is
 *    refused with what can go now; checked against the order the engine spends
 *    in, over many random balances
 *  - the run: every part to the same Gloam address, the note on the first part
 *    only, kept apart from payroll runs
 *  - against an in-memory vault (the payroll engine's own rules), through the
 *    app's engine, note store and run store: $20 from $10, $7 and $4 goes as
 *    $10, $7 and $3, each from its own note, with $1 of change back, and the
 *    person's app opens every part
 *  - crash safe: a part whose outcome is unclear stops the run with the parts
 *    before it paid, keeps its note and change, and resuming sends that same
 *    payment again (never a second one) and finishes; no part is ever paid twice
 *  - stopping the rest only when no part is on its way
 *
 * Run from app/:  ../mcp/node_modules/.bin/tsx scripts/selftest-pay-across.mts
 */
import assert from "node:assert/strict";
import "./browser-shim.mts";
import type { Address, Hex, PublicClient } from "viem";
import {
  IncrementalMerkleTreePoseidon,
  fieldToHex,
  hexToField,
  noteCommitmentPoseidon,
  noteNullifierPoseidon,
  randomSecretField,
} from "@gloamtrade/sdk";

const { getActiveNetwork } = await import("../src/lib/networks");
const { getAllNotes } = await import("../src/lib/noteVault");
const { activeSpendableNotes, loadLocalNotes, saveLocalNote } = await import("../src/lib/shield");
const { decodeNotePackage } = await import("../src/lib/notePackage");
const { fundingPlan, loadBatches, newBatch, runPayroll, saveBatch, RUN_ELSEWHERE } = await import("../src/lib/payroll");
const receive = await import("../src/lib/receiveTag");
const across = await import("../src/lib/payAcross");
type LocalNote = import("../src/lib/shield").LocalNote;
type PayrollBatch = import("../src/lib/payroll").PayrollBatch;
type PayrollEngineDeps = import("../src/lib/payroll").PayrollEngineDeps;
type SyncedTree = import("../src/lib/treeSync").SyncedTree;

let passed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  await fn();
  passed++;
  console.log(`ok  ${name}`);
}

const net = getActiveNetwork();
const POOL = net.pool as Address;
const ASSET = "0x00000000000000000000000000000000000000ee" as Address;
const lc = (h: string) => h.toLowerCase();
let people = 0;
const payer = () => `0x${(++people).toString(16).padStart(40, "b")}` as Address;

type Transfer = { root: Hex; nullifier: Hex; commitments: readonly [Hex, Hex] };

/** The vault, following transfer's rules (as in selftest-payroll). */
function mockPool() {
  const tree = new IncrementalMerkleTreePoseidon();
  const index = new Map<string, number>();
  const roots = new Set<string>();
  const spent = new Set<string>();
  const receipts = new Map<string, "success" | "reverted">();
  const held = new Map<string, Transfer>();
  const heldAll = new Map<string, Transfer[]>();
  let n = 0;
  const nextHash = () => `0x${(++n).toString(16).padStart(64, "0")}` as Hex;
  async function insert(c: Hex) {
    index.set(lc(c), await tree.insert(hexToField(c)));
    roots.add(lc(fieldToHex(tree.currentRoot)));
  }
  async function apply(t: Transfer) {
    const ok = roots.has(lc(t.root)) && !spent.has(lc(t.nullifier)) && t.commitments.every((c) => !index.has(lc(c)));
    if (ok) {
      spent.add(lc(t.nullifier));
      for (const c of t.commitments) await insert(c);
    }
    return ok;
  }
  return {
    insert,
    index,
    spent,
    receipts,
    async land(t: Transfer): Promise<Hex> {
      const hash = nextHash();
      receipts.set(hash, (await apply(t)) ? "success" : "reverted");
      return hash;
    },
    /** Every part in one transaction: all land, or none does (Multicall3 with allowFailure false). */
    async landAll(ts: Transfer[]): Promise<Hex> {
      const hash = nextHash();
      const seen = new Set<string>();
      let ok = true;
      for (const t of ts) {
        const outs = t.commitments.map(lc);
        if (!roots.has(lc(t.root)) || spent.has(lc(t.nullifier)) || seen.has(lc(t.nullifier))) ok = false;
        if (outs.some((c) => index.has(c) || seen.has(c))) ok = false;
        seen.add(lc(t.nullifier));
        for (const c of outs) seen.add(c);
      }
      if (ok) for (const t of ts) await apply(t);
      receipts.set(hash, ok ? "success" : "reverted");
      return hash;
    },
    holdAll(ts: Transfer[]): Hex {
      const hash = nextHash();
      heldAll.set(hash, ts);
      return hash;
    },
    async mineAll(hash: Hex) {
      const ts = heldAll.get(hash)!;
      heldAll.delete(hash);
      let ok = ts.every((t) => roots.has(lc(t.root)) && !spent.has(lc(t.nullifier)) && t.commitments.every((c) => !index.has(lc(c))));
      if (ok) for (const t of ts) ok = (await apply(t)) && ok;
      receipts.set(hash, ok ? "success" : "reverted");
    },
    /** A transaction that reverts: nothing lands. */
    revert(): Hex {
      const hash = nextHash();
      receipts.set(hash, "reverted");
      return hash;
    },
    hold(t: Transfer): Hex {
      const hash = nextHash();
      held.set(hash, t);
      return hash;
    },
    async mine(hash: Hex) {
      const t = held.get(hash)!;
      held.delete(hash);
      receipts.set(hash, (await apply(t)) ? "success" : "reverted");
    },
    client: {
      getBlockNumber: async () => BigInt(1),
      readContract: async ({ functionName, args }: { functionName: string; args: [Hex] }) => {
        if (functionName === "isSpent") return spent.has(lc(args[0]));
        if (functionName === "commitmentSeen") return index.has(lc(args[0]));
        throw new Error(`unexpected read ${functionName}`);
      },
      getTransactionReceipt: async ({ hash }: { hash: Hex }) => {
        const status = receipts.get(hash);
        if (!status) throw new Error("Transaction receipt could not be found.");
        return { status };
      },
    } as unknown as PublicClient,
    waitForTx: async (hash: Hex) => {
      const status = receipts.get(hash);
      if (!status) throw new Error("Timed out while waiting for transaction.");
      return status;
    },
    syncTree: async () =>
      ({
        scheme: "poseidon",
        leaves: [],
        root: fieldToHex(tree.currentRoot),
        leafCount: index.size,
        indexByCommitment: new Map(index),
        pathForLeaf: (i: number) => tree.path(i),
      }) as unknown as SyncedTree,
  };
}
type Pool = ReturnType<typeof mockPool>;

function deps(pool: Pool, send: (t: Transfer) => Promise<Hex> | Hex, sent: Transfer[] = []): PayrollEngineDeps {
  return {
    client: pool.client,
    submitTransfer: async (a) => {
      const t = { root: a.root, nullifier: a.nullifier, commitments: a.commitments };
      sent.push(t);
      return send(t);
    },
    submitMemo: null,
    waitForTx: pool.waitForTx,
    onUpdate: () => {},
    shouldStop: () => false,
    syncTree: pool.syncTree,
    prove: async () => ({ proofBytes: "0xdeadbeef" }),
  };
}

async function fund(pool: Pool, owner: Address, amount: bigint, id: string): Promise<LocalNote> {
  const secret = await randomSecretField();
  const commitment = fieldToHex(await noteCommitmentPoseidon(secret, amount, ASSET));
  const nullifier = fieldToHex(await noteNullifierPoseidon(secret, hexToField(commitment)));
  await pool.insert(commitment);
  const note: LocalNote = {
    id,
    chainId: net.chainId,
    pool: POOL,
    asset: ASSET,
    amountWei: amount.toString(),
    commitment,
    secret: fieldToHex(secret),
    nullifier,
    bound: true,
    scheme: "poseidon",
    from: owner,
    createdAt: Date.now(),
    status: "open",
    source: "local",
  };
  await saveLocalNote(note);
  return note;
}

const byId = (id: string) => getAllNotes().find((n) => n.id === id)!;
const counted = (owner: Address) => activeSpendableNotes(loadLocalNotes(owner)).map((n) => [n.id, n.amountWei]);
async function stored(id: string): Promise<PayrollBatch> {
  const b = (await loadBatches(net.chainId, POOL)).find((x) => x.id === id);
  assert.ok(b, "the run is stored");
  return b;
}
async function storedLater(id: string): Promise<PayrollBatch> {
  const b = await stored(id);
  for (const r of b.rows) if (r.sentAt) r.sentAt -= 11 * 60_000;
  await saveBatch(b);
  return b;
}

// the person paid: this browser's own Gloam address, so the test can open what they get
const TAG = (await receive.getOrCreateReceiveIdentity()).tag;

function payRun(owner: Address, parts: bigint[], note?: string) {
  return across.newPayRun({ chainId: net.chainId, pool: POOL, asset: ASSET, payer: owner, tag: TAG, label: "@ada", name: "ada", parts, note });
}

// ------------------------------------------------------------------ the plan

await test("the plan: whole notes largest first, then the rest, the fewest parts", () => {
  const { planPayParts } = across;
  assert.deepEqual(planPayParts(20n, [10n, 7n, 4n]), { ok: true, parts: [10n, 7n, 3n] }, "HeisRae's case");
  assert.deepEqual(planPayParts(20n, [4n, 10n, 7n]), { ok: true, parts: [10n, 7n, 3n] }, "any order of notes");
  assert.deepEqual(planPayParts(21n, [10n, 7n, 4n]), { ok: true, parts: [10n, 7n, 4n] }, "the whole balance");
  assert.deepEqual(planPayParts(8n, [10n, 7n, 4n]), { ok: true, parts: [8n] }, "one note covers it: one part");
  assert.deepEqual(planPayParts(12n, [10n, 7n, 4n]), { ok: true, parts: [10n, 2n] });
  assert.deepEqual(planPayParts(22n, [10n, 7n, 4n]), { ok: false, reason: "over_total", most: 21n }, "more than the balance");
  assert.deepEqual(planPayParts(0n, [10n]), { ok: false, reason: "over_total", most: 10n }, "nothing to pay");
  assert.deepEqual(planPayParts(7n, [1n, 1n, 1n, 1n, 1n, 1n, 1n]), { ok: false, reason: "too_many_parts", most: 6n }, "more parts than allowed");
  assert.deepEqual(planPayParts(5n, [3n, 0n, 2n]), { ok: true, parts: [3n, 2n] }, "an empty note is skipped");
});

await test("the plan always fits the order the engine spends in, over 2,000 random balances", () => {
  let seed = 11;
  const rand = (n: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n);
  for (let i = 0; i < 2000; i++) {
    const notes = Array.from({ length: 1 + rand(9) }, () => BigInt(1 + rand(50)));
    const total = notes.reduce((s, n) => s + n, 0n);
    const amount = BigInt(1 + rand(Number(total) + 5));
    const plan = across.planPayParts(amount, notes);
    if (!plan.ok) {
      const sorted = [...notes].sort((a, b) => (a > b ? -1 : 1));
      const fewest = (() => {
        let left = amount;
        let k = 0;
        for (const n of sorted) {
          k++;
          if (left <= n) return k;
          left -= n;
        }
        return Infinity;
      })();
      assert.ok(amount > total || fewest > across.PAY_MAX_PARTS, `refused only when it can't fit: ${notes} pay ${amount}`);
      continue;
    }
    assert.equal(plan.parts.reduce((s, p) => s + p, 0n), amount, "the parts add up to the amount");
    assert.ok(plan.parts.length <= across.PAY_MAX_PARTS);
    assert.ok(plan.parts.every((p) => p > 0n));
    assert.equal(fundingPlan(plan.parts, notes).shortfall, 0n, `the engine covers every part: ${notes} pay ${amount}`);
  }
});

await test("the run: every part to the same address, the note once, never listed as payroll", () => {
  const run = payRun(payer(), [10n, 7n, 3n], "Rent");
  assert.ok(across.isPayRun(run));
  assert.equal(across.isPayRun(newBatch({ title: "x", chainId: 1, pool: POOL, asset: ASSET, employer: POOL, relay: true, rows: [] })), false);
  assert.match(run.id, /^pay-/);
  assert.equal(run.relay, true, "always through the relay");
  assert.deepEqual(run.rows.map((r) => r.amount), ["10", "7", "3"]);
  assert.ok(run.rows.every((r) => r.kind === "gloam" && r.recipient === TAG && r.payName === "ada"));
  assert.deepEqual(run.rows.map((r) => r.note ?? ""), ["Rent", "", ""], "the note goes with the first part only");
  assert.equal(across.payRunTotal(run), 20n);
});

// ------------------------------------------------------------------ the engine

await test("$20 from $10, $7 and $4: three parts, each from its own note, $1 back, every part opens for them", async () => {
  const pool = mockPool();
  const me = payer();
  await fund(pool, me, 10_000n, "pa-10");
  await fund(pool, me, 7_000n, "pa-7");
  await fund(pool, me, 4_000n, "pa-4");
  const plan = across.planPayParts(20_000n, [10_000n, 7_000n, 4_000n]);
  assert.ok(plan.ok);
  const run = payRun(me, plan.parts, "Rent");
  await saveBatch(run);
  const sent: Transfer[] = [];
  const done = await runPayroll(run, deps(pool, (t) => pool.land(t), sent));
  assert.equal(done.status, "done");
  assert.deepEqual(across.payRunProgress(done), { parts: 3, sent: 3, failed: 0, done: true, unconfirmed: false });
  assert.equal(sent.length, 3, "three relayed transfers, one per part");
  assert.equal(new Set(sent.map((t) => lc(t.nullifier))).size, 3, "each spends a different note");
  assert.deepEqual(done.rows.map((r) => r.spendNoteId), ["pa-10", "pa-7", "pa-4"]);
  for (const id of ["pa-10", "pa-7", "pa-4"]) assert.equal(byId(id).status, "recovered", `${id} is spent`);
  const left = counted(me);
  assert.equal(left.length, 1);
  assert.equal(left[0]![1], "1000", "$1 of change counts once its part lands");
  // what the person gets: three payments, all to them, adding up, the note once
  const opened = await Promise.all(done.rows.map((r) => decodeNotePackage(r.ticket!, undefined, { tryTagDecrypt: true })));
  assert.deepEqual(opened.map((p) => p.amountWei), ["10000", "7000", "3000"]);
  assert.deepEqual(opened.map((p) => p.note ?? ""), ["Rent", "", ""]);
  for (const r of done.rows) assert.ok(pool.index.has(lc(r.paymentCommitment!)), "each payment is in the vault");
});

await test("a part whose outcome is unclear stops the run, keeps its note, and resuming never pays twice", async () => {
  const pool = mockPool();
  const me = payer();
  await fund(pool, me, 10_000n, "pb-10");
  await fund(pool, me, 7_000n, "pb-7");
  await fund(pool, me, 4_000n, "pb-4");
  const run = payRun(me, [10_000n, 7_000n, 3_000n]);
  await saveBatch(run);
  const sent: Transfer[] = [];
  let held: Hex | undefined;
  let k = 0;
  // the first part lands; the relay takes the second but it isn't mined (a lost reply, a slow chain)
  await runPayroll(run, deps(pool, (t) => (++k === 1 ? pool.land(t) : (held = pool.hold(t))), sent));
  assert.equal(run.status, "paused");
  assert.deepEqual(run.rows.map((r) => r.status), ["paid", "unconfirmed", "queued"]);
  assert.equal(sent.length, 2, "nothing after the unclear part goes");
  const second = run.rows[1]!;
  assert.equal(byId(second.spendNoteId!).status, "open", "its note is kept");
  assert.equal(byId(second.changeNoteId ?? "none")?.status ?? "open", "open");
  assert.equal(across.cancelPayRest(run), null, "the rest can't be stopped while a part is on its way");

  // a refresh: the stored run, past the wait, with the held part still not mined
  const later = await storedLater(run.id);
  const resent: Transfer[] = [];
  await runPayroll(later, deps(pool, (t) => pool.land(t), resent));
  assert.equal(later.status, "done");
  assert.deepEqual(later.rows.map((r) => r.status), ["paid", "paid", "paid"]);
  assert.equal(resent.length, 2, "the first part is never sent again");
  assert.equal(lc(resent[0]!.nullifier), lc(sent[1]!.nullifier), "the unclear part goes again as the very same payment");
  assert.deepEqual(resent[0]!.commitments.map(lc), sent[1]!.commitments.map(lc));
  // the first copy turns up late: it can't land a second time
  await pool.mine(held!);
  assert.equal(pool.receipts.get(held!), "reverted");
  const paidTo = later.rows.map((r) => lc(r.paymentCommitment!));
  assert.equal(new Set(paidTo).size, 3, "three payments, no part paid twice");
});

await test("each part spends the note it was planned on: independent parts, only the last with change", async () => {
  const pool = mockPool();
  const me = payer();
  await fund(pool, me, 10_000n, "pd-a");
  await fund(pool, me, 7_000n, "pd-b");
  await fund(pool, me, 4_000n, "pd-c");
  await fund(pool, me, 3_000n, "pd-d");
  const notes = loadLocalNotes(me).filter((n) => n.id.startsWith("pd-"));
  const plan = across.planPayFrom(20_000n, notes);
  assert.ok(plan.ok);
  assert.deepEqual(plan.parts, [10_000n, 7_000n, 3_000n]);
  assert.deepEqual(plan.noteIds, ["pd-a", "pd-b", "pd-c"], "whole notes largest first, the last part from the next");
  const run = across.newPayRun({ chainId: net.chainId, pool: POOL, asset: ASSET, payer: me, tag: TAG, label: "@ada", parts: plan.parts, noteIds: plan.noteIds });
  assert.deepEqual(run.rows.map((r) => r.planNoteId), ["pd-a", "pd-b", "pd-c"]);
  await saveBatch(run);
  const sent: Transfer[] = [];
  await runPayroll(run, deps(pool, (t) => pool.land(t), sent));
  assert.equal(run.status, "done");
  // left alone, the engine would have paid the $3 part from the $3 note; the plan keeps it on the $4
  assert.deepEqual(run.rows.map((r) => r.spendNoteId), ["pd-a", "pd-b", "pd-c"], "each part from its planned note");
  assert.deepEqual(run.rows.map((r) => Boolean(r.changeNoteId)), [false, false, true], "only the last part has change");
  assert.equal(byId("pd-d").status, "open", "the note left out stays");
  // independent: every part was proven against a root the vault already had before the run
  assert.equal(new Set(sent.map((t) => lc(t.nullifier))).size, 3);
  assert.deepEqual(across.planPayFrom(30_000n, notes), { ok: false, reason: "over_total", most: 24_000n });
});

await test("stop the rest: only the parts not sent, and only when none is on its way", async () => {
  const pool = mockPool();
  const me = payer();
  await fund(pool, me, 5_000n, "pc-5");
  const run = payRun(me, [5_000n, 2_000n]);
  await saveBatch(run);
  // the first lands; the second finds no note big enough and waits for money
  await runPayroll(run, deps(pool, (t) => pool.land(t)));
  assert.equal(run.status, "needs_funds");
  assert.deepEqual(run.rows.map((r) => r.status), ["paid", "queued"]);
  const stopped = across.cancelPayRest(run);
  assert.ok(stopped);
  assert.equal(stopped.status, "done");
  assert.deepEqual(stopped.rows.map((r) => [r.status, r.error ?? ""]), [["paid", ""], ["failed", "Cancelled"]]);
  assert.equal(across.payRunPaid(stopped), 5_000n);
});


// ------------------------------------------------------------ from the 23 Nov bug sweep
await test("two taps (or two tabs) at once start one payment, never two", async () => {
  const pool = mockPool();
  const me = payer();
  await fund(pool, me, 10_000n, "pe-a");
  await fund(pool, me, 10_000n, "pe-b");
  await fund(pool, me, 7_000n, "pe-c");
  await fund(pool, me, 4_000n, "pe-d");
  await fund(pool, me, 10_000n, "pe-e");
  const notes = activeSpendableNotes(loadLocalNotes(me)).filter((n) => n.id.startsWith("pe-"));
  const plan = across.planPayFrom(15_000n, notes);
  assert.ok(plan.ok);
  const mk = () => across.newPayRun({ chainId: net.chainId, pool: POOL, asset: ASSET, payer: me, tag: TAG, label: "@ada", name: "ada", parts: plan.parts, noteIds: plan.noteIds });
  const r1 = mk();
  await new Promise((r) => setTimeout(r, 3));
  const r2 = mk();
  assert.notEqual(r1.id, r2.id, "two runs from one plan, as two taps made them");
  // at the same moment: one starts, the other is refused or handed the first
  const both = await Promise.allSettled([across.startPayRun(r1), across.startPayRun(r2)]);
  const started = both.filter((x) => x.status === "fulfilled" && x.value.started).map((x) => (x as PromiseFulfilledResult<{ run: PayrollBatch }>).value.run);
  assert.equal(started.length, 1, "one of the two starts");
  for (const x of both) if (x.status === "rejected") assert.equal((x.reason as Error).message, RUN_ELSEWHERE);
  // a tap after it is saved gets the first one back to finish, not a second payment
  const third = await across.startPayRun(mk());
  assert.equal(third.started, false);
  assert.equal(third.run.id, started[0]!.id);
  const runs = (await loadBatches(net.chainId, POOL)).filter((b) => across.isPayRun(b) && b.employer === me);
  assert.equal(runs.length, 1, "one payment stored");
  const sent: Transfer[] = [];
  const done = await runPayroll(started[0]!, deps(pool, (t) => pool.land(t), sent));
  assert.equal(done.status, "done");
  assert.equal(across.payRunPaid(done), 15_000n, "paid once");
  assert.equal(sent.length, plan.parts.length, "one transfer per part, no more");
  const opened = await Promise.all(done.rows.map((r) => decodeNotePackage(r.ticket!, undefined, { tryTagDecrypt: true })));
  assert.equal(opened.reduce((sum, p) => sum + BigInt(p.amountWei), 0n), 15_000n, "the person gets exactly 15,000");
  // once it's done, a new payment can start
  assert.equal((await across.startPayRun(mk())).started, true);
});

await test("Stop the rest in another tab: refused while a tab pays it, and a stored stop is never written over", async () => {
  // tab A pays $20 as $10 + $7 + $3; tab B, opened meanwhile, shows it unfinished
  const setup = async (prefix: string) => {
    const pool = mockPool();
    const me = payer();
    await fund(pool, me, 10_000n, `${prefix}-a`);
    await fund(pool, me, 7_000n, `${prefix}-b`);
    await fund(pool, me, 4_000n, `${prefix}-c`);
    const notes = activeSpendableNotes(loadLocalNotes(me)).filter((n) => n.id.startsWith(`${prefix}-`));
    const plan = across.planPayFrom(20_000n, notes);
    assert.ok(plan.ok);
    const run = across.newPayRun({ chainId: net.chainId, pool: POOL, asset: ASSET, payer: me, tag: TAG, label: "@ada", parts: plan.parts, noteIds: plan.noteIds });
    await saveBatch(run);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let proofs = 0;
    const d = deps(pool, (t) => pool.land(t));
    d.prove = async () => {
      if (++proofs === 2) await gate; // tab A is proving part 2
      return { proofBytes: "0xdeadbeef" };
    };
    const a = runPayroll(run, d);
    while (proofs < 2) await new Promise((r) => setTimeout(r, 5));
    const inB = (await loadBatches(net.chainId, POOL)).find((x) => x.id === run.id)!;
    return { run, a, release, inB };
  };

  // the button: under the run's lock, so it's refused while tab A pays
  {
    const { run, a, release, inB } = await setup("pf");
    await assert.rejects(across.stopPayRest(inB), (e: Error) => e.message === RUN_ELSEWHERE, "refused while another tab pays it");
    release();
    const done = await a;
    assert.equal(done.status, "done");
    assert.equal(across.payRunPaid(done), 20_000n, "tab A pays it all, and tab B never said it stopped");
    const stored = (await loadBatches(net.chainId, POOL)).find((x) => x.id === run.id)!;
    assert.deepEqual(stored.rows.map((r) => r.status), ["paid", "paid", "paid"]);
  }

  // a stop saved anyway (an older page without the lock): tab A keeps it and stops before part 3
  {
    const { run, a, release, inB } = await setup("pg");
    const stopped = across.cancelPayRest(inB)!;
    assert.ok(stopped);
    await saveBatch(stopped);
    release();
    const done = await a;
    const stored = (await loadBatches(net.chainId, POOL)).find((x) => x.id === run.id)!;
    assert.equal(stored.status, "done");
    assert.deepEqual(stored.rows.map((r) => r.status), ["paid", "paid", "failed"], "part 2 was on its way and lands; part 3 stays stopped");
    assert.equal(stored.rows[2]!.error, "Cancelled");
    assert.equal(across.payRunPaid(stored), across.payRunPaid(done), "the stored run and tab A agree on what was paid");
    assert.equal(across.payRunPaid(stored), 17_000n, "17,000 of 20,000, never all of it after a stop");
  }

  // with no tab paying it, Stop the rest works from the stored run
  {
    const pool = mockPool();
    const me = payer();
    await fund(pool, me, 5_000n, "ph-5");
    const run = payRun(me, [5_000n, 2_000n]);
    await saveBatch(run);
    await runPayroll(run, deps(pool, (t) => pool.land(t)));
    const stale = { ...run, rows: run.rows.map((r) => ({ ...r, status: "queued" as const })) };
    const stopped = await across.stopPayRest(stale);
    assert.ok(stopped);
    assert.deepEqual(stopped.rows.map((r) => r.status), ["paid", "failed"], "from the stored run, not the stale copy");
  }
});

// ------------------------------------------------------------------ one transaction (lib/relay/batch)

type BatchSent = { parts: (Transfer & { memo?: Hex })[] };
function batchDeps(
  pool: Pool,
  sendAll: (ts: Transfer[]) => Promise<Hex> | Hex,
  log: { batches: BatchSent[]; singles: Transfer[]; memos: Hex[] },
  refused: (e: unknown) => boolean = () => false
): PayrollEngineDeps {
  return {
    ...deps(pool, (t) => pool.land(t), log.singles),
    submitMemo: async (m) => {
      log.memos.push(m.paymentCommitment);
      return pool.land({ root: "0x00", nullifier: "0x00", commitments: ["0x00", "0x00"] } as never).catch(() => "0x01" as Hex);
    },
    submitTransferBatch: async (parts) => {
      const ts = parts.map((p) => ({ root: p.root, nullifier: p.nullifier, commitments: p.commitments, ...(p.memo ? { memo: p.memo } : {}) }));
      log.batches.push({ parts: ts });
      return sendAll(ts);
    },
    batchRefused: refused,
  };
}
async function threeNotes(pool: Pool, me: Address, tag: string) {
  await fund(pool, me, 10_000n, `${tag}-10`);
  await fund(pool, me, 7_000n, `${tag}-7`);
  await fund(pool, me, 4_000n, `${tag}-4`);
}

await test("in one transaction: $20 from $10, $7 and $4 as one batch, every part with its message, all settled from one receipt", async () => {
  const pool = mockPool();
  const me = payer();
  await threeNotes(pool, me, "bt");
  const run = payRun(me, [10_000n, 7_000n, 3_000n], "Rent");
  await saveBatch(run);
  const log = { batches: [] as BatchSent[], singles: [] as Transfer[], memos: [] as Hex[] };
  const done = await runPayroll(run, batchDeps(pool, (ts) => pool.landAll(ts), log));
  assert.equal(done.status, "done");
  assert.deepEqual(done.rows.map((r) => r.status), ["paid", "paid", "paid"]);
  assert.equal(log.batches.length, 1, "one transaction");
  assert.equal(log.singles.length, 0, "no part went on its own");
  assert.equal(log.memos.length, 0, "no message went on its own");
  const parts = log.batches[0]!.parts;
  assert.equal(parts.length, 3);
  assert.ok(parts.every((p) => p.memo && p.memo.length > 2), "every part carries its message");
  assert.equal(new Set(parts.map((p) => lc(p.root))).size, 1, "every part proven against one vault root");
  assert.equal(new Set(parts.map((p) => lc(p.nullifier))).size, 3, "each spends its own note");
  assert.deepEqual(done.rows.map((r) => r.spendNoteId), ["bt-10", "bt-7", "bt-4"], "each part from its planned note");
  assert.ok(done.rows.every((r) => r.memoPosted === true), "every message counts as posted");
  assert.equal(new Set(done.rows.map((r) => r.txHash)).size, 1, "one hash for all");
  const left = counted(me);
  assert.equal(left.length, 1);
  assert.equal(left[0]![1], "1000", "$1 of change back");
});

await test("a batch that may have gone out holds every part, and resuming settles them from the chain, nothing sent again", async () => {
  const pool = mockPool();
  const me = payer();
  await threeNotes(pool, me, "bm");
  const run = payRun(me, [10_000n, 7_000n, 3_000n]);
  await saveBatch(run);
  const log = { batches: [] as BatchSent[], singles: [] as Transfer[], memos: [] as Hex[] };
  let held: Hex | undefined;
  // the relay took it and the reply was lost
  await runPayroll(
    run,
    batchDeps(pool, (ts) => {
      held = pool.holdAll(ts);
      throw new Error("Could not reach the relay. Check your connection.");
    }, log)
  );
  assert.equal(run.status, "paused");
  assert.deepEqual(run.rows.map((r) => r.status), ["unconfirmed", "unconfirmed", "unconfirmed"]);
  assert.ok(run.rows.every((r) => r.spendNullifier && r.paymentCommitment), "every part keeps its payment");
  await pool.mineAll(held!);
  const later = await storedLater(run.id);
  const log2 = { batches: [] as BatchSent[], singles: [] as Transfer[], memos: [] as Hex[] };
  const done = await runPayroll(later, batchDeps(pool, (ts) => pool.landAll(ts), log2));
  assert.equal(done.status, "done");
  assert.deepEqual(done.rows.map((r) => r.status), ["paid", "paid", "paid"]);
  assert.equal(log2.batches.length + log2.singles.length, 0, "nothing sent again");
  assert.equal(log2.memos.length, 0, "the messages went with the batch, not again");
  assert.ok(done.rows.every((r) => r.memoPosted === true));
});

await test("a batch refused with nothing sent goes part by part, each with its message after it lands", async () => {
  const pool = mockPool();
  const me = payer();
  await threeNotes(pool, me, "br");
  const run = payRun(me, [10_000n, 7_000n, 3_000n]);
  await saveBatch(run);
  const log = { batches: [] as BatchSent[], singles: [] as Transfer[], memos: [] as Hex[] };
  const refusal = new Error("This payment is too big to send in one go here.");
  const done = await runPayroll(
    run,
    batchDeps(pool, () => {
      throw refusal;
    }, log, (e) => e === refusal)
  );
  assert.equal(done.status, "done");
  assert.deepEqual(done.rows.map((r) => r.status), ["paid", "paid", "paid"]);
  assert.equal(log.batches.length, 1, "the batch was tried once");
  assert.equal(log.singles.length, 3, "then each part on its own");
  assert.equal(log.memos.length, 3, "each message after its part lands");
  assert.ok(done.rows.every((r) => !r.memoInBatch));
  assert.equal(counted(me).length, 1, "one change note, no leftover from the refused try");
});

await test("a batch that reverts lands nothing, and each part goes again on its own as that same payment", async () => {
  const pool = mockPool();
  const me = payer();
  await threeNotes(pool, me, "bv");
  const run = payRun(me, [10_000n, 7_000n, 3_000n]);
  await saveBatch(run);
  const log = { batches: [] as BatchSent[], singles: [] as Transfer[], memos: [] as Hex[] };
  const done = await runPayroll(run, batchDeps(pool, () => pool.revert(), log));
  assert.equal(done.status, "done");
  assert.deepEqual(done.rows.map((r) => r.status), ["paid", "paid", "paid"]);
  assert.equal(log.batches.length, 1);
  assert.equal(log.singles.length, 3, "each part again, on its own");
  assert.deepEqual(log.singles.map((t) => lc(t.nullifier)), log.batches[0]!.parts.map((p) => lc(p.nullifier)), "the very same payments, never new ones");
  assert.deepEqual(log.singles.map((t) => t.commitments.map(lc)), log.batches[0]!.parts.map((p) => p.commitments.map(lc)));
  assert.equal(log.memos.length, 3, "messages go after, since the batch's never landed");
});

console.log(`\n${passed} pay-across checks passed`);
