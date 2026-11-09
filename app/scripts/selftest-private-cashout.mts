/**
 * Self-test: smarter cash-out defaults ("cash out privately").
 *
 * The piece planner (lib/cashOutPlan planPieces): pieces add up to exactly the
 * amount, 2 to 4 of them, round sizes plus a remainder, never within 1% of
 * recent money in, nothing offered at or below 5 whole units, and the same
 * seed always gives the same plan.
 *
 * The link detector (findCashOutLink): an amount within 1% of a deposit or a
 * payment received in the last 30 days, or any deposit in the last 3 hours,
 * read only from this browser's own deposit and claim notes.
 *
 * The run (lib/cashOutPrivately) against the app's note vault, the real
 * schedule-and-mark path (lib/cashOutLater) behind a stubbed relay, and a
 * split that saves its notes like lib/cashOutSplit does: a whole note and a
 * part of one, then every way it can stop (a refused split, one that may have
 * gone out, a proof that fails, a relay that is down, a conflict, a closed tab)
 * with nothing lost and every piece accounted for.
 *
 * Run from app/:  ../mcp/node_modules/.bin/tsx scripts/selftest-private-cashout.mts
 */
import assert from "node:assert/strict";
import "./browser-shim.mjs";
import type { Address, Hex } from "viem";

const plan = await import("../src/lib/cashOutPlan");
const {
  MAX_PIECES,
  PRIVATE_MIN_UNITS,
  findCashOutLink,
  linkMessage,
  moneyInKind,
  mostPieces,
  nearAmount,
  niceUnits,
  piecesFee,
  piecesOk,
  planPieces,
  planSteps,
  recentMoneyIn,
  seededRandom,
  whenLabel,
} = plan;
const { runPrivateCashOut, schedulePiece, keepPiece, unscheduledPieces, checkPlan } = await import("../src/lib/cashOutPrivately");
const { scheduleNoteCashOut, dismissReturnedCashOut, scheduledCashOutNotes } = await import("../src/lib/cashOutLater");
const { SPLIT_MAYBE_SENT, splitNotes } = await import("../src/lib/cashOutSplit");
const { activeSpendableNotes, notesToMove, proofLoose, saveLocalNote, updateLocalNote, withdrawFeeOf } = await import("../src/lib/shield");
const { getAllNotes } = await import("../src/lib/noteVault");
const { getActiveNetwork } = await import("../src/lib/networks");
const { reconcileClaims } = await import("../src/lib/claimSweep");
type LocalNote = import("../src/lib/shield").LocalNote;
type SplitArgs = import("../src/lib/cashOutSplit").SplitArgs;
type ClaimEnv = import("../src/lib/claimSweep").ClaimEnv;
type PoseidonMerklePath = import("../src/lib/merklePoseidon").PoseidonMerklePath;

let passed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  await fn();
  passed++;
  console.log(`ok  ${name}`);
}

const U = 1_000_000n; // one whole USDG (6 decimals)
const ASSET = "0x5fc5360d0400a0fd4f2af552add042d716f1d168" as Address;
const OTHER_ASSET = "0x20c0000000000000000000000000000000000000" as Address;
const TO = "0x1111111111111111111111111111111111111111" as Address;
const TO2 = "0x2222222222222222222222222222222222222222" as Address;
const ME = "0x3333333333333333333333333333333333333333" as Address;
const T0 = 1_800_000_000_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const hex32 = (n: number | bigint) => `0x${BigInt(n).toString(16).padStart(64, "0")}` as Hex;
const sum = (xs: bigint[]) => xs.reduce((s, x) => s + x, 0n);

// ---------------------------------------------------------------- the planner

await test("nothing is offered at or below 5 whole units; just above, a plan", () => {
  assert.equal(PRIVATE_MIN_UNITS, 5n);
  for (const amount of [0n, 1n, 4_999_999n, 5n * U]) {
    assert.equal(planPieces({ amount, decimals: 6, random: seededRandom(1) }), null, String(amount));
  }
  const just = planPieces({ amount: 5n * U + 1n, decimals: 6, random: seededRandom(1) });
  assert.ok(just);
  assert.equal(sum(just.pieces), 5n * U + 1n);
  // 18 decimals the same way
  assert.equal(planPieces({ amount: 5n * 10n ** 18n, decimals: 18 }), null);
  assert.ok(planPieces({ amount: 6n * 10n ** 18n, decimals: 18 }));
});

await test("the round sizes: 1-2-3-4-5-6, then 10 15 20 25 30 40 50 60 75 and on up", () => {
  assert.deepEqual(niceUnits(100n).map(Number), [1, 2, 3, 4, 5, 6, 10, 15, 20, 25, 30, 40, 50, 60, 75, 100]);
  assert.deepEqual(niceUnits(1000n).slice(-9).map(Number), [125, 150, 200, 250, 300, 400, 500, 600, 750].slice(-8).concat([1000]));
  assert.deepEqual(niceUnits(0n), []);
});

await test("pieces always add up to exactly the amount: 2 to 4, at least one unit, round sizes plus a remainder", () => {
  const rand = seededRandom(20261023);
  let plans = 0;
  for (let i = 0; i < 4000; i++) {
    // 5.000001 to about 30,000 USDG, cents and odd base units included
    const amount = 5n * U + 1n + BigInt(Math.floor(rand() * 30_000 * 1_000_000));
    const r = planPieces({ amount, decimals: 6, random: seededRandom(i) });
    assert.ok(r, `no plan for ${amount} with nothing to avoid`);
    plans++;
    const { pieces } = r;
    assert.equal(sum(pieces), amount, `sum for ${amount}`);
    assert.ok(pieces.length >= 2 && pieces.length <= MAX_PIECES, `count ${pieces.length}`);
    assert.ok(pieces.length <= mostPieces(amount / U));
    for (const p of pieces) {
      assert.ok(p >= U, `a piece under one unit: ${p}`);
      assert.ok(p * 10n < amount * 9n, `a piece of 90% or more: ${p} of ${amount}`);
    }
    const round = new Set(niceUnits(amount / U).map((x) => (x * U).toString()));
    for (const p of pieces.slice(0, -1)) assert.ok(round.has(p.toString()), `not a round size: ${p}`);
  }
  assert.equal(plans, 4000);
});

await test("no piece is ever within 1% of recent money in", () => {
  const rand = seededRandom(7);
  const common = [5, 10, 15, 20, 25, 30, 40, 50, 60, 75, 100, 150, 200, 250, 500].map((x) => BigInt(x) * U);
  let found = 0;
  for (let i = 0; i < 3000; i++) {
    const amount = 6n * U + BigInt(Math.floor(rand() * 2_000 * 1_000_000));
    // the amount itself, a few round amounts people often add, and some odd ones
    const avoid = [amount, ...common.filter(() => rand() < 0.35), BigInt(Math.floor(rand() * 500 * 1_000_000)) + U];
    const r = planPieces({ amount, decimals: 6, avoid, random: seededRandom(i) });
    if (!r) continue;
    found++;
    assert.equal(sum(r.pieces), amount);
    for (const p of r.pieces) for (const d of avoid) assert.ok(!nearAmount(p, d), `piece ${p} is within 1% of ${d}`);
  }
  assert.ok(found > 2900, `plans found: ${found} of 3000`);
  // the example: 10 added, 10 cashed out
  const ten = planPieces({ amount: 10n * U, decimals: 6, avoid: [10n * U], random: seededRandom(3) });
  assert.ok(ten && ten.pieces.every((p) => !nearAmount(p, 10n * U)));
});

await test("with room to spare, no two pieces are the same and no group of them adds up to money in", () => {
  for (let seed = 1; seed <= 300; seed++) {
    const r = planPieces({ amount: 100n * U, decimals: 6, avoid: [100n * U, 30n * U, 45n * U], random: seededRandom(seed) });
    assert.ok(r);
    assert.equal(new Set(r.pieces.map(String)).size, r.pieces.length, `duplicate in ${r.pieces}`);
    assert.ok(piecesOk(r.pieces, 100n * U, U, [100n * U, 30n * U, 45n * U], MAX_PIECES, true), `not strict: ${r.pieces}`);
    assert.ok(r.pieces.every((p) => p * 4n <= 300n * U), `a piece over 75%: ${r.pieces}`);
  }
});

await test("caps: never more than 4 pieces, 2 for small amounts, and a lower cap holds", () => {
  assert.equal(mostPieces(6n), 2);
  assert.equal(mostPieces(14n), 2);
  assert.equal(mostPieces(15n), 3);
  assert.equal(mostPieces(49n), 3);
  assert.equal(mostPieces(50n), 4);
  assert.equal(mostPieces(10n ** 9n), 4);
  assert.equal(mostPieces(10n ** 9n, 9), 4, "a cap above 4 is still 4");
  for (let seed = 0; seed < 200; seed++) {
    assert.equal(planPieces({ amount: 9n * U, decimals: 6, random: seededRandom(seed) })!.pieces.length, 2);
    assert.equal(planPieces({ amount: 900n * U, decimals: 6, maxPieces: 2, random: seededRandom(seed) })!.pieces.length, 2);
    assert.ok(planPieces({ amount: 900n * U, decimals: 6, maxPieces: 99, random: seededRandom(seed) })!.pieces.length <= 4);
  }
  // when nothing safe exists there is no plan, never an unsafe one
  assert.equal(planPieces({ amount: 6n * U, decimals: 6, avoid: [1n * U, 2n * U, 3n * U, 4n * U, 5n * U, 6n * U].flatMap((x) => [x, x + U / 2n]) }), null);
});

await test("the same seed gives the same plan; other seeds give other plans", () => {
  const a = planPieces({ amount: 52_500_000n, decimals: 6, avoid: [50n * U], random: seededRandom(42) });
  const b = planPieces({ amount: 52_500_000n, decimals: 6, avoid: [50n * U], random: seededRandom(42) });
  assert.deepEqual(a, b);
  const kinds = new Set<string>();
  for (let seed = 0; seed < 50; seed++) kinds.add(planPieces({ amount: 52_500_000n, decimals: 6, random: seededRandom(seed) })!.pieces.join(","));
  assert.ok(kinds.size >= 8, `only ${kinds.size} different plans`);
  // the random source is all it reads: a fixed one gives a fixed plan
  const fixed = () => 0.5;
  assert.deepEqual(planPieces({ amount: 52_500_000n, decimals: 6, random: fixed }), planPieces({ amount: 52_500_000n, decimals: 6, random: fixed }));
});

await test("odd cents that match money in are flagged, so rounding can leave them in the vault", () => {
  const odd = 10_123_456n;
  const r = planPieces({ amount: odd, decimals: 6, avoid: [odd], random: seededRandom(1) });
  assert.ok(r);
  assert.equal(r.tailMatch, true);
  assert.equal(r.pieces[r.pieces.length - 1]! % U, 123_456n, "the remainder carries the cents");
  assert.equal(planPieces({ amount: 10n * U, decimals: 6, avoid: [odd], random: seededRandom(1) })!.tailMatch, false);
  assert.equal(planPieces({ amount: 10_123_456n, decimals: 6, avoid: [7n * U], random: seededRandom(1) })!.tailMatch, false);
});

await test("every piece pays the pool's fee on its own amount: the same 0.5% in total, never more", () => {
  const pieces = [20n * U, 25n * U, 7_500_000n];
  assert.equal(piecesFee(pieces, 50), 100_000n + 125_000n + 37_500n);
  assert.equal(piecesFee(pieces, 50), withdrawFeeOf(52_500_000n, 50));
  assert.equal(piecesFee(pieces, 25), 50_000n + 62_500n + 18_750n, "a pool still at 0.25%");
  assert.equal(piecesFee(pieces, 0), 0n);
  const rand = seededRandom(9);
  for (let i = 0; i < 2000; i++) {
    const amount = 6n * U + BigInt(Math.floor(rand() * 10_000 * 1_000_000));
    const r = planPieces({ amount, decimals: 6, random: seededRandom(i) })!;
    const whole = withdrawFeeOf(amount, 50);
    const parts = piecesFee(r.pieces, 50);
    assert.ok(parts <= whole && whole - parts < BigInt(r.pieces.length), `fee ${parts} vs ${whole}`);
  }
});

await test("steps: a split per piece, one fewer when the pieces are the whole note, and a proof each", () => {
  assert.deepEqual(planSteps([10n, 15n, 5n], 30n), { splits: 2, proofs: 5 });
  assert.deepEqual(planSteps([10n, 15n, 5n], 100n), { splits: 3, proofs: 6 });
});

// ---------------------------------------------------------------- spotting the link

const note = (id: string, amountWei: bigint, createdAt: number, over: Partial<LocalNote> = {}) =>
  ({
    id,
    chainId: 4663,
    pool: TO,
    asset: ASSET,
    amountWei: amountWei.toString(),
    commitment: hex32(id.length),
    secret: hex32(1),
    createdAt,
    status: "open",
    source: "local",
    ...over,
  }) as LocalNote;

await test("what counts as money in: deposits and claimed payments only", () => {
  const kinds: [string, LocalNote["source"], string | null][] = [
    [`${T0}-0xabcdef0123`, "local", "deposit"],
    ["vt-1800000000000", "local", "deposit"],
    ["imp-1800000000000", "local", "received"],
    ["demo-robinhood-3", "local", "deposit"],
    ["chg-1800000000000", "local", null],
    ["chg-demo-robinhood-6", "local", null],
    ["chg-pr-row-1", "local", null],
    ["co-1800000000000", "local", null],
    ["swp-1800000000000", "local", null],
    ["sw-1800000000000", "local", null],
    ["swr-1800000000000", "local", null],
    ["ss-out-1800000000000", "local", null],
    ["pay-1800000000000", "local", null],
    [`chain-0x${"ab".repeat(32)}-4`, "chain", null],
    [`${T0}-0xabcdef0123`, "chain", null],
  ];
  for (const [id, source, want] of kinds) assert.equal(moneyInKind({ id, source }), want, id);
});

await test("the same amount added in the last 30 days is spotted, with when", () => {
  const notes = [note(`${T0 - 2 * DAY}-0xaa`, 10n * U, T0 - 2 * DAY)];
  const link = findCashOutLink(10n * U, notes, ASSET, T0);
  assert.deepEqual(link, { kind: "same", source: "deposit", at: T0 - 2 * DAY, amountWei: 10n * U });
  const day = new Date(T0 - 2 * DAY).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  assert.equal(linkMessage(link!, T0), `This is the same amount you added on ${day}, so anyone can link the two.`);
  // within 1% either way is close; past it is nothing
  assert.equal(findCashOutLink(9_900_000n, notes, ASSET, T0)?.kind, "close");
  assert.equal(findCashOutLink(10_100_000n, notes, ASSET, T0)?.kind, "close");
  assert.match(linkMessage(findCashOutLink(10_100_000n, notes, ASSET, T0)!, T0), /^This is close to the amount you added on /);
  assert.equal(findCashOutLink(9_890_000n, notes, ASSET, T0), null);
  // older than 30 days, another asset, nothing to cash out: nothing
  assert.equal(findCashOutLink(10n * U, [note(`${T0}-0xab`, 10n * U, T0 - 31 * DAY)], ASSET, T0), null);
  assert.equal(findCashOutLink(10n * U, notes, OTHER_ASSET, T0), null);
  assert.ok(findCashOutLink(10n * U, notes, ASSET.toUpperCase().replace("0X", "0x"), T0), "asset case does not matter");
  assert.equal(findCashOutLink(0n, notes, ASSET, T0), null);
  // a deposit already spent inside the vault still counts: its amount is public
  assert.equal(findCashOutLink(10n * U, [note(`${T0}-0xac`, 10n * U, T0 - DAY, { status: "recovered" })], ASSET, T0)?.kind, "same");
});

await test("a payment received at the same amount: whoever paid could spot it", () => {
  const link = findCashOutLink(25n * U, [note("imp-1", 25n * U, T0 - 5 * DAY)], ASSET, T0)!;
  assert.equal(link.source, "received");
  assert.match(linkMessage(link, T0), /^This is the same amount you were paid on .+, so whoever paid you could spot it\.$/);
});

await test("a deposit in the last 3 hours is flagged whatever its amount", () => {
  const recent = [note(`${T0}-0xad`, 300n * U, T0 - 2 * HOUR)];
  const link = findCashOutLink(42n * U, recent, ASSET, T0)!;
  assert.equal(link.kind, "recent");
  assert.equal(linkMessage(link, T0), "You added money about 2 hours ago. A cash out this soon after is easy to line up with it.");
  assert.equal(findCashOutLink(42n * U, [note(`${T0}-0xae`, 300n * U, T0 - 4 * HOUR)], ASSET, T0), null);
  // a claimed payment is not a deposit: timing alone is not flagged for it
  assert.equal(findCashOutLink(42n * U, [note("imp-2", 300n * U, T0 - HOUR)], ASSET, T0), null);
});

await test("the plainest link wins: an amount over timing, exact over close, a deposit over a payment, newest first", () => {
  const notes = [
    note(`${T0}-0xb1`, 77n * U, T0 - 10 * 60_000), // recent, other amount
    note("imp-9", 50n * U, T0 - DAY), // payment, exact
    note(`${T0}-0xb2`, 50_200_000n, T0 - 2 * DAY), // deposit, close
    note(`${T0}-0xb3`, 50n * U, T0 - 9 * DAY), // deposit, exact, older
    note(`${T0}-0xb4`, 50n * U, T0 - 3 * DAY), // deposit, exact, newer
  ];
  assert.deepEqual(findCashOutLink(50n * U, notes, ASSET, T0), { kind: "same", source: "deposit", at: T0 - 3 * DAY, amountWei: 50n * U });
  assert.equal(findCashOutLink(50n * U, notes.slice(0, 3), ASSET, T0)?.source, "received");
  assert.equal(findCashOutLink(50n * U, [notes[0]!, notes[2]!], ASSET, T0)?.kind, "close");
  assert.equal(findCashOutLink(13n * U, notes, ASSET, T0)?.kind, "recent");
});

await test("money in, newest first, for the planner to avoid", () => {
  const ins = recentMoneyIn(
    [note(`${T0}-0xc1`, 5n * U, T0 - DAY), note("imp-3", 6n * U, T0 - HOUR), note("chg-1", 7n * U, T0), note(`${T0}-0xc2`, 8n * U, T0 - 40 * DAY)],
    ASSET,
    T0
  );
  assert.deepEqual(ins.map((m) => [m.kind, m.amountWei]), [["received", 6n * U], ["deposit", 5n * U]]);
});

await test("when: minutes, hours, then the date", () => {
  assert.equal(whenLabel(T0 - 20_000, T0), "just now");
  assert.equal(whenLabel(T0 - 60_000, T0), "a minute ago");
  assert.equal(whenLabel(T0 - 25 * 60_000, T0), "25 minutes ago");
  assert.equal(whenLabel(T0 - 70 * 60_000, T0), "about an hour ago");
  assert.equal(whenLabel(T0 - 5 * HOUR, T0), "about 5 hours ago");
  assert.match(whenLabel(T0 - 3 * DAY, T0), /^on [A-Z][a-z]{2} \d{1,2}$/);
});

// ---------------------------------------------------------------- the run

const active = getActiveNetwork();
let leaf = 100;
let made = 0;

function vaultNote(id: string, amountWei: bigint): LocalNote {
  made++;
  const n: LocalNote = {
    id,
    chainId: active.chainId,
    pool: active.pool!,
    asset: ASSET,
    amountWei: amountWei.toString(),
    commitment: hex32(0xa000 + made),
    secret: hex32(0xb000 + made),
    nullifier: hex32(0xc000 + made),
    bound: true,
    scheme: "poseidon",
    from: ME,
    createdAt: T0,
    status: "open",
    source: "local",
    txHash: hex32(0xd000 + made),
    leafIndex: leaf++,
  };
  saveLocalNote(n);
  return n;
}

const byId = (id: string) => getAllNotes().find((n) => n.id === id)!;
const spendable = (ids: string[]) => activeSpendableNotes(getAllNotes()).filter((n) => ids.includes(n.id));
const total = (ns: LocalNote[]) => sum(ns.map((n) => BigInt(n.amountWei)));
const PATH = { leafIndex: 0 } as unknown as PoseidonMerklePath;

/**
 * A split that keeps its notes the way lib/cashOutSplit splitNote does: both
 * saved (tagged) before the send, the original retired once it lands. `fail`
 * stops it before the send (nothing kept), `maybe` after it (both kept, out of
 * the balance), `close` as a tab closing mid-send (both kept, nothing settled).
 */
function fakeSplitter() {
  let calls = 0;
  const plan: Record<number, "fail" | "maybe" | "close"> = {};
  const created: string[] = [];
  async function split(a: SplitArgs): Promise<{ part: LocalNote; change: LocalNote | null }> {
    const call = ++calls;
    const total = BigInt(a.note.amountWei);
    const out = (k: number, amt: bigint) => ({
      amountWei: amt.toString(),
      commitment: hex32(0xe000 + call * 10 + k),
      secret: hex32(0xf000 + call * 10 + k),
      nullifier: hex32(0x10000 + call * 10 + k),
    });
    const w = { paymentNote: out(1, a.amount), changeNote: out(2, total - a.amount) } as never;
    const both = splitNotes(a.note, w, a.note.nullifier!, a.owner, T0 + call * 1000);
    const part = a.partTag ? { ...both.part, cashOutPlan: a.partTag } : both.part;
    const change = both.change && a.changeTag ? { ...both.change, cashOutPlan: a.changeTag } : both.change;
    if (plan[call] === "fail") throw new Error("The relay is busy. Try again shortly or send from your wallet.");
    saveLocalNote({ ...part, sweepPending: true });
    if (change) saveLocalNote({ ...change, sweepPending: true });
    created.push(part.id, ...(change ? [change.id] : []));
    if (plan[call] === "maybe") throw new Error(SPLIT_MAYBE_SENT);
    if (plan[call] === "close") throw new Error("tab closed");
    const hash = hex32(0x20000 + call);
    updateLocalNote(a.note.id, { status: "recovered", txHash: hash });
    updateLocalNote(part.id, { sweepPending: false, txHash: hash, leafIndex: leaf++ });
    if (change) updateLocalNote(change.id, { sweepPending: false, txHash: hash, leafIndex: leaf++ });
    return { part: byId(part.id), change: change ? byId(change.id) : null };
  }
  return { split, plan, created, calls: () => calls };
}

/** The relay's /api/relay/scheduled, answering POSTs from a queue (the default: a new job). */
const replies: (((body: Record<string, unknown>) => Response) | "down")[] = [];
const scheduled: Record<string, unknown>[] = [];
let jobSeq = 0;
function newJob(body: Record<string, unknown>) {
  jobSeq++;
  return {
    id: `00000000-0000-4000-8000-${jobSeq.toString(16).padStart(12, "0")}`,
    chainId: body.chainId,
    sendAfter: T0 + jobSeq * 600_000,
    status: "scheduled",
    updatedAt: T0,
    to: body.to,
  };
}
globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
  const u = String(url);
  if (u.startsWith("/api/relay/scheduled") && init?.method === "POST") {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    const r = replies.shift();
    if (r === "down") throw new TypeError("fetch failed");
    scheduled.push(body);
    if (r) return r(body);
    return new Response(JSON.stringify({ ok: true, ...newJob(body) }), { status: 200 });
  }
  throw new Error(`unexpected fetch ${u}`);
}) as typeof fetch;

function deps(splitter: ReturnType<typeof fakeSplitter>, proveFailsOn?: string) {
  return {
    pathOf: async () => PATH,
    split: splitter.split,
    prove: async (n: LocalNote, to: Address) => {
      if (proveFailsOn && n.cashOutPlan?.piece === Number(proveFailsOn)) throw new Error("This balance does not match the vault.");
      return { chainId: n.chainId, proof: "0xabcdef" as Hex, root: hex32(1), nullifier: n.nullifier!, asset: n.asset, to, amount: BigInt(n.amountWei) };
    },
    schedule: scheduleNoteCashOut,
    newId: () => `plan-${++made}`,
  };
}

function reset() {
  replies.length = 0;
  scheduled.length = 0;
}

await test("a whole note in 3 pieces: 2 splits, the last piece is the change, each scheduled and out of the balance", async () => {
  reset();
  const src = vaultNote("dep-run-1", 30n * U);
  const s = fakeSplitter();
  const states: string[] = [];
  const r = await runPrivateCashOut({
    note: src,
    pieces: [10n * U, 15n * U, 5n * U],
    to: [TO, TO, TO],
    window: "6h",
    owner: ME,
    onPiece: (i, p) => p.state && states.push(`${i}:${p.state}`),
    deps: deps(s),
  });
  assert.equal(r.stoppedAt, null);
  assert.equal(r.error, null);
  assert.equal(r.jobs.length, 3);
  assert.equal(s.calls(), 2, "the last piece is the second split's change: no third split");
  assert.deepEqual(scheduled.map((b) => b.amount), ["10000000", "15000000", "5000000"]);
  assert.deepEqual(scheduled.map((b) => b.window), ["6h", "6h", "6h"]);
  assert.equal(byId(src.id).status, "recovered");
  const pieces = s.created.map(byId).filter((n) => n.cashOutPlan);
  assert.deepEqual(pieces.map((n) => [n.cashOutPlan!.piece, n.cashOutPlan!.of, BigInt(n.amountWei)]), [[1, 3, 10n * U], [2, 3, 15n * U], [3, 3, 5n * U]]);
  assert.equal(new Set(pieces.map((n) => n.cashOutPlan!.plan)).size, 1, "one plan id");
  assert.ok(pieces.every((n) => n.cashOut?.state === "scheduled" && n.cashOut.to === TO));
  assert.equal(total(spendable(s.created)), 0n, "nothing counted while they wait");
  assert.equal(scheduledCashOutNotes().filter((n) => s.created.includes(n.id)).length, 3);
  assert.deepEqual(unscheduledPieces().filter((n) => s.created.includes(n.id)), []);
  assert.deepEqual(states.filter((x) => x.endsWith("scheduled")), ["0:scheduled", "1:scheduled", "2:scheduled"]);
});

await test("part of a note in 3 pieces, each to its own address: 3 splits, and the rest stays as plain money", async () => {
  reset();
  const src = vaultNote("dep-run-2", 100n * U);
  const s = fakeSplitter();
  const r = await runPrivateCashOut({ note: src, pieces: [20n * U, 25n * U, 7_500_000n], to: [TO, TO2, ME], window: "day", owner: ME, deps: deps(s) });
  assert.equal(r.stoppedAt, null);
  assert.equal(s.calls(), 3);
  assert.deepEqual(scheduled.map((b) => b.to), [TO, TO2, ME]);
  assert.deepEqual(scheduled.map((b) => b.window), ["day", "day", "day"]);
  const left = spendable(s.created);
  assert.equal(left.length, 1);
  assert.equal(BigInt(left[0]!.amountWei), 47_500_000n);
  assert.equal(left[0]!.cashOutPlan, undefined, "the rest is not a piece");
});

await test("a split refused before it went out: the run stops, earlier pieces still go, the rest stays in the balance", async () => {
  reset();
  const src = vaultNote("dep-run-3", 30n * U);
  const s = fakeSplitter();
  s.plan[2] = "fail";
  const r = await runPrivateCashOut({ note: src, pieces: [10n * U, 15n * U, 5n * U], to: [TO, TO, TO], window: "hour", owner: ME, deps: deps(s) });
  assert.equal(r.stoppedAt, 1);
  assert.equal(r.jobs.length, 1);
  assert.equal(r.maybeSent, false);
  assert.match(r.error!, /busy/);
  assert.equal(s.calls(), 2, "nothing tried past the problem");
  assert.equal(scheduled.length, 1);
  // 10 waiting to go out, 20 in the balance: all 30 accounted for
  const left = spendable(s.created);
  assert.equal(total(left), 20n * U);
  assert.equal(total(scheduledCashOutNotes().filter((n) => s.created.includes(n.id))), 10n * U);
  assert.deepEqual(unscheduledPieces().filter((n) => s.created.includes(n.id)), []);
});

await test("a split that may have gone out: both notes kept out of the balance, the run says so", async () => {
  reset();
  const src = vaultNote("dep-run-4", 40n * U);
  const s = fakeSplitter();
  s.plan[2] = "maybe";
  const r = await runPrivateCashOut({ note: src, pieces: [10n * U, 20n * U, 10n * U - 1n], to: [TO, TO, TO], window: "6h", owner: ME, deps: deps(s) });
  assert.equal(r.stoppedAt, 1);
  assert.equal(r.maybeSent, true);
  assert.equal(r.error, SPLIT_MAYBE_SENT);
  const pending = getAllNotes().filter((n) => s.created.includes(n.id) && n.sweepPending);
  assert.equal(pending.length, 2, "the maybe-sent split's two notes are kept");
  // what counts now: the first split's change (30), nothing twice
  assert.equal(total(spendable(s.created)), 30n * U);
});

await test("the relay down at scheduling: that proof may be out, so its piece moves, and the piece behind it can still be scheduled", async () => {
  reset();
  const src = vaultNote("dep-run-5", 30n * U);
  const s = fakeSplitter();
  replies.push((b) => new Response(JSON.stringify({ ok: true, ...newJob(b) })), "down");
  const r = await runPrivateCashOut({ note: src, pieces: [10n * U, 15n * U, 5n * U], to: [TO, TO, TO], window: "6h", owner: ME, deps: deps(s) });
  assert.equal(r.stoppedAt, 1);
  assert.equal(r.error, "Could not reach the relay. Check your connection.");
  const second = s.created.map(byId).find((n) => n.cashOutPlan?.piece === 2)!;
  assert.ok(second.proofOutAt, "marked before the proof went");
  assert.equal(second.handoverUntil, undefined, "and the lease ended with the failure");
  assert.equal(proofLoose(second), true);
  assert.deepEqual(notesToMove([second]).map((n) => n.id), [second.id]);
  // piece 3, the second split's change, never had a proof made: still one to schedule
  const left = unscheduledPieces().filter((n) => s.created.includes(n.id));
  assert.deepEqual(left.map((n) => [n.cashOutPlan!.piece, BigInt(n.amountWei)]), [[3, 5n * U]]);
  assert.deepEqual([left[0]!.cashOutPlan!.to, left[0]!.cashOutPlan!.window], [TO, "6h"]);
  assert.equal(total(spendable(s.created)), 5n * U, "the 10 waits to go out, the 15 is moving, the 5 is spendable");

  // scheduled later, as planned: same address, same window
  const job = await schedulePiece(left[0]!, { pathOf: async () => PATH, prove: deps(s).prove });
  assert.equal(job.to, TO);
  assert.equal(scheduled.at(-1)!.window, "6h");
  assert.equal(byId(left[0]!.id).cashOut?.state, "scheduled");
  assert.equal(total(spendable(s.created)), 0n);
});

await test("a proof that fails: nothing scheduled for that piece, it stays in the balance as a piece to schedule", async () => {
  reset();
  const src = vaultNote("dep-run-6", 30n * U);
  const s = fakeSplitter();
  const r = await runPrivateCashOut({ note: src, pieces: [10n * U, 15n * U, 5n * U], to: [TO, TO, TO], window: "6h", owner: ME, deps: deps(s, "1") });
  assert.equal(r.stoppedAt, 0);
  assert.equal(r.jobs.length, 0);
  assert.equal(scheduled.length, 0);
  const left = unscheduledPieces().filter((n) => s.created.includes(n.id));
  assert.deepEqual(left.map((n) => n.cashOutPlan!.piece), [1]);
  assert.equal(total(spendable(s.created)), 30n * U, "all of it still in the balance");
  // keeping it makes it plain money
  keepPiece(left[0]!.id);
  assert.equal(byId(left[0]!.id).cashOutPlan, undefined);
  assert.ok(!unscheduledPieces().some((n) => n.id === left[0]!.id));
});

await test("this money already scheduled to another address: marked with that job, never a second one", async () => {
  reset();
  const src = vaultNote("dep-run-7", 30n * U);
  const s = fakeSplitter();
  replies.push((b) =>
    new Response(
      JSON.stringify({ ok: false, code: "already_scheduled", error: "Already scheduled to another address. Cancel it first.", job: { ...newJob(b), to: TO2 } }),
      { status: 409 }
    )
  );
  const r = await runPrivateCashOut({ note: src, pieces: [10n * U, 15n * U, 5n * U], to: [TO, TO, TO], window: "6h", owner: ME, deps: deps(s) });
  assert.equal(r.stoppedAt, 0);
  assert.match(r.error!, /another address/);
  const first = s.created.map(byId).find((n) => n.cashOutPlan?.piece === 1)!;
  assert.equal(first.cashOut?.to, TO2, "shows the address the relay really pays");
  assert.ok(!unscheduledPieces().some((n) => n.id === first.id));
});

await test("a closed tab mid-split: the notes are kept, the next sync lands them, and the piece shows as not scheduled", async () => {
  reset();
  const src = vaultNote("dep-run-8", 30n * U);
  const s = fakeSplitter();
  s.plan[1] = "close";
  const r = await runPrivateCashOut({ note: src, pieces: [10n * U, 15n * U, 5n * U], to: [TO, TO, TO], window: "6h", owner: ME, deps: deps(s) });
  assert.equal(r.stoppedAt, 0);
  // before the sync: the original still counts, the two new notes wait
  assert.equal(total(spendable([src.id, ...s.created])), 30n * U);
  // next visit: the split landed (the original spent, both new notes in the vault)
  const env = {
    chainId: active.chainId,
    pool: active.pool!,
    stateAt: async () => ({ spent: true, seen: true, block: 1n }),
    leafIndexOf: async () => leaf++,
  } as unknown as ClaimEnv;
  assert.equal(await reconcileClaims(env), true);
  assert.equal(byId(src.id).status, "recovered");
  assert.equal(total(spendable([src.id, ...s.created])), 30n * U, "counted once: the two new notes");
  const left = unscheduledPieces().filter((n) => s.created.includes(n.id));
  assert.deepEqual(left.map((n) => [n.cashOutPlan!.piece, BigInt(n.amountWei)]), [[1, 10n * U]]);
});

await test("a piece whose cash out came back: its notice, then plain money once dismissed", () => {
  const n = vaultNote("dep-run-9", 12n * U);
  updateLocalNote(n.id, {
    cashOutPlan: { plan: "p", piece: 1, of: 2, to: TO, window: "6h" },
    cashOut: { job: "j", at: T0, to: TO, state: "failed" },
  });
  assert.ok(!unscheduledPieces().some((x) => x.id === n.id), "the returned notice shows, not a second one");
  dismissReturnedCashOut(n.id);
  assert.equal(byId(n.id).cashOut, undefined);
  assert.equal(byId(n.id).cashOutPlan, undefined);
  assert.ok(!unscheduledPieces().some((x) => x.id === n.id));
});

await test("a plan is refused before anything moves when it doesn't fit its note", async () => {
  const src = vaultNote("dep-run-10", 30n * U);
  const before = getAllNotes().length;
  assert.throws(() => checkPlan(src, [30n * U], [TO]), /2 to 4/);
  assert.throws(() => checkPlan(src, [5n * U, 5n * U, 5n * U, 5n * U, 5n * U], [TO, TO, TO, TO, TO]), /2 to 4/);
  assert.throws(() => checkPlan(src, [10n * U, 10n * U], [TO]), /address/);
  assert.throws(() => checkPlan(src, [20n * U, 11n * U], [TO, TO]), /more than this balance/);
  assert.throws(() => checkPlan(src, [0n, 10n * U], [TO, TO]), /amount/);
  assert.throws(() => checkPlan({ ...src, cashOut: { job: "j", at: T0, to: TO, state: "scheduled" } }, [10n * U, 10n * U], [TO, TO]), /busy/);
  await assert.rejects(runPrivateCashOut({ note: src, pieces: [31n * U, 1n], to: [TO, TO], window: "6h", owner: ME, deps: deps(fakeSplitter()) }));
  assert.equal(getAllNotes().length, before, "nothing saved");
});

console.log(`\n${passed} passed`);
