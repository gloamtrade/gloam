/**
 * Self-test: a payment or cash out never shows "Nothing in your private balance yet" while it is
 * going out, confirming, or showing its result (lib/heldBalance, MoveView).
 *
 * The bug, 23 Nov 2026 (Base mainnet): paying privately, the Pay card switched to the empty state
 * and only then showed the success dialog, so the money looked gone. MoveView picked what to show
 * from the open balances alone, and those drop the spent balance before the result shows:
 *   - the payment lands, its note is marked spent, and the change waits out of the balance
 *     (sweepPending) until the tree read that follows resolves its leaf;
 *   - with no change, the heads-up to the payee goes out next, a second transaction;
 *   - a cash out of part of a balance splits it first, and the pieces wait to land the same way;
 *   - a private cash out schedules every piece, and the last split leaves nothing open.
 * MoveView now holds the balance a flow started from until its result closes.
 *
 * Each step below applies what MoveView's confirm path and lib/cashOutSplit do to the notes, in
 * order, and reads the open balances through the app's own filter (activeSpendableNotes).
 *
 * Run from app/:  ../mcp/node_modules/.bin/tsx scripts/selftest-pay-no-empty-flash.mts
 */
import assert from "node:assert/strict";
import "./browser-shim.mjs";
import type { Address, Hex } from "viem";

const { activeSpendableNotes } = await import("../src/lib/shield");
type LocalNote = import("../src/lib/shield").LocalNote;
const { heldBalance, payCardShows, withHeld } = await import("../src/lib/heldBalance");

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`ok  ${name}`);
}

const USDG = "0x00000000000000000000000000000000000000ee" as Address;
const POOL = "0x39e28cde55cab798874746ac52cb4b5cc99a0194" as Address;
let seq = 0;
function note(id: string, amount: string, extra: Partial<LocalNote> = {}): LocalNote {
  seq++;
  return {
    id,
    chainId: 8453,
    pool: POOL,
    asset: USDG,
    amountWei: amount,
    commitment: `0x${seq.toString(16).padStart(64, "0")}` as Hex,
    secret: `0x${(seq + 1000).toString(16).padStart(64, "0")}` as Hex,
    bound: true,
    scheme: "poseidon",
    leafIndex: seq,
    createdAt: seq,
    status: "open",
    source: "local",
    ...extra,
  };
}
const patch = (list: LocalNote[], id: string, p: Partial<LocalNote>) => list.map((n) => (n.id === id ? { ...n, ...p } : n));

/** One render: what the Pay card shows and which balance the form is on. */
type Frame = { step: string; inFlow: boolean; store: LocalNote[]; runNote?: LocalNote | null };
function render(f: Frame, flowNote: LocalNote | null) {
  const open = activeSpendableNotes(f.store);
  const held = f.runNote ?? heldBalance(open, flowNote, f.inFlow);
  return {
    step: f.step,
    before: open.length > 0 ? "form" : "empty", // what the card showed before this fix
    after: payCardShows(open.length, held),
    picked: held?.id ?? open[0]?.id ?? null,
    listed: withHeld(open, held).map((n) => n.id),
  };
}

/** MoveView's direct payment, as its confirm path runs it. */
function payment(change: boolean): Frame[] {
  const only = note("dep-1", "30000000000");
  const chg = note("chg-1", "29900000000", { sweepPending: true, leafIndex: undefined });
  let store = [only];
  const frames: Frame[] = [];
  frames.push({ step: "ready", inFlow: false, store });
  frames.push({ step: "proving", inFlow: true, store });
  // the change is saved before anything is sent, out of the balance until the chain shows it
  if (change) store = [chg, ...store];
  frames.push({ step: "sent, confirming", inFlow: true, store });
  // landed: the spent note is marked (the store's save listener re-renders before the tree read below)
  store = patch(store, "dep-1", { status: "recovered" });
  frames.push({ step: "landed, tree read for the change", inFlow: true, store });
  if (change) {
    store = patch(store, "chg-1", { sweepPending: false, leafIndex: 77 });
    frames.push({ step: "change saved", inFlow: true, store });
  }
  frames.push({ step: "heads-up going out", inFlow: true, store });
  frames.push({ step: "success dialog", inFlow: true, store });
  frames.push({ step: "dialog closed", inFlow: false, store });
  return frames;
}

test("paying the whole balance: the empty state showed mid-payment before; never now", () => {
  const frames = payment(false);
  const flowNote = activeSpendableNotes(frames[0]!.store)[0]!;
  const shown = frames.map((f) => render(f, f.step === "ready" ? null : flowNote));
  // the bug, as it was: empty from the moment the payment landed, through the heads-up and behind the dialog
  assert.deepEqual(
    shown.filter((s) => s.before === "empty").map((s) => s.step),
    ["landed, tree read for the change", "heads-up going out", "success dialog", "dialog closed"]
  );
  for (const s of shown.slice(0, -1)) {
    assert.equal(s.after, "form", `${s.step}: still on the payment`);
    assert.equal(s.picked, "dep-1", `${s.step}: on the balance it spends`);
    assert.deepEqual(s.listed, ["dep-1"], `${s.step}: the picker still lists it`);
  }
  // once nobody is mid-flow and nothing is left, the empty state is right
  assert.equal(shown.at(-1)!.after, "empty");
});

test("paying part of the only balance: no empty state while the change waits on the tree", () => {
  const frames = payment(true);
  const flowNote = activeSpendableNotes(frames[0]!.store)[0]!;
  const shown = frames.map((f) => render(f, f.step === "ready" ? null : flowNote));
  assert.deepEqual(
    shown.filter((s) => s.before === "empty").map((s) => s.step),
    ["landed, tree read for the change"]
  );
  for (const s of shown.slice(0, -1)) assert.equal(s.after, "form", s.step);
  // the form stays on the balance being spent until the result closes, then moves to the change
  assert.equal(shown.find((s) => s.step === "change saved")!.picked, "dep-1");
  assert.deepEqual(shown.find((s) => s.step === "change saved")!.listed, ["dep-1", "chg-1"]);
  assert.equal(shown.at(-1)!.after, "form");
  assert.equal(shown.at(-1)!.picked, "chg-1");
});

test("cashing out part of the only balance: the split's pieces waiting to land show no empty state", () => {
  const only = note("dep-2", "5000000000");
  const part = note("co-1", "1000000000", { sweepPending: true, leafIndex: undefined });
  const rest = note("chg-2", "4000000000", { sweepPending: true, leafIndex: undefined });
  const frames: Frame[] = [];
  let store = [only];
  frames.push({ step: "setting the amount aside", inFlow: true, store });
  store = [part, rest, ...store];
  frames.push({ step: "split sent", inFlow: true, store });
  // lib/cashOutSplit: the source is marked spent, then the pieces after a tree read each
  store = patch(store, "dep-2", { status: "recovered" });
  frames.push({ step: "split landed, reading the tree", inFlow: true, store });
  store = patch(store, "chg-2", { sweepPending: false, leafIndex: 90 });
  store = patch(store, "co-1", { sweepPending: false, leafIndex: 91 });
  frames.push({ step: "pieces open", inFlow: true, store });
  store = patch(store, "co-1", { status: "recovered" });
  frames.push({ step: "cashed out, dialog", inFlow: true, store });
  frames.push({ step: "dialog closed", inFlow: false, store });
  const shown = frames.map((f) => render(f, only));
  assert.deepEqual(shown.filter((s) => s.before === "empty").map((s) => s.step), ["split landed, reading the tree"]);
  for (const s of shown) assert.equal(s.after, "form", s.step);
  assert.equal(shown.at(-1)!.picked, "chg-2");
});

test("a private cash out of everything: the run stays on screen until the last piece is scheduled", () => {
  const only = note("dep-3", "30000000000");
  const frames: Frame[] = [];
  let store = [only];
  frames.push({ step: "piece 1", inFlow: true, store, runNote: only });
  store = patch(store, "dep-3", { status: "recovered" });
  // every piece is scheduled (cashOut set), so none of them counts as open
  store = [
    ...store,
    note("co-a", "12500000000", { cashOut: { job: "j1", at: 1, state: "scheduled" } as never }),
    note("co-b", "17500000000", { sweepPending: true, leafIndex: undefined }),
  ];
  frames.push({ step: "piece 3 proving", inFlow: true, store, runNote: only });
  frames.push({ step: "run over", inFlow: false, store, runNote: null });
  const shown = frames.map((f) => render(f, null));
  assert.equal(shown[1]!.before, "empty");
  assert.equal(shown[1]!.after, "form");
  assert.equal(shown[1]!.picked, "dep-3");
  // nothing open and nobody mid-flow: the card says so (with the scheduled rows and the notice above it)
  assert.equal(shown[2]!.after, "empty");
});

test("a held balance never outlives its flow", () => {
  const spent = note("dep-4", "1000000", { status: "recovered" });
  const other = note("dep-5", "2000000");
  const open = activeSpendableNotes([spent, other]);
  // the next flow (securing a claim, say) did not start from a balance: nothing is held for it
  assert.equal(heldBalance(open, spent, false), null);
  assert.deepEqual(withHeld(open, null).map((n) => n.id), ["dep-5"]);
  // while held, the live copy wins over the snapshot taken when the flow started
  const live = { ...other, leafIndex: 999 };
  assert.equal(heldBalance([live], other, true), live);
});

console.log(`\n${passed} pay flash checks passed`);
