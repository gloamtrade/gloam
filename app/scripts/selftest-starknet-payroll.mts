/**
 * Self-test: payroll on Starknet (lib/starknetPrivacy/payroll, payrollStore,
 * and the pure parts of payrollSession).
 *
 *  - the list: header or none, tabs, semicolons, quoted amounts, a BOM, an
 *    EVM list's note column, bad rows flagged with a reason and skipped, the
 *    account check (no private account, your own account, a first payment),
 *    proofs and Gloam's fee estimated, totals against the private balance;
 *  - fitting a proof under the relay's cap (fitCount);
 *  - the engine against a fake chain that keeps a ledger of who was paid and
 *    which notes are unspent: proofs of up to PAYROLL_PROOF_MAX people, fewer
 *    when they don't fit, the same proof sent again after a 429, a refusal
 *    that stops the run, a save that fails before a send, a stop request, a
 *    fee that changed, and every way a proof can be left in flight (tab closed
 *    before or after the relay sent it, a lost relay answer, a confirmation
 *    that timed out, a revert, past its window, can't tell). Nobody is ever
 *    paid twice, and the run is always saved with its proof in flight before
 *    that proof is sent;
 *  - settleInflight case by case, the results CSV (formula cells defused),
 *    isRun, and the sealed store (wrong key, damaged list, open runs kept).
 *
 * No network. Run from app/:  ../mcp/node_modules/.bin/tsx scripts/selftest-starknet-payroll.mts
 */
import assert from "node:assert/strict";
import Module from "node:module";
import { fileURLToPath } from "node:url";

const stub = fileURLToPath(new URL("./server-only-stub.cjs", import.meta.url));
const M = Module as unknown as { _resolveFilename: (req: string, ...rest: unknown[]) => string };
const resolve = M._resolveFilename;
M._resolveFilename = function (req: string, ...rest: unknown[]) {
  return req === "server-only" ? stub : resolve.call(this, req, ...rest);
};
const env = process.env as Record<string, string | undefined>;
env.NEXT_PUBLIC_STARKNET_ENABLED = "1";
env.NEXT_PUBLIC_STARKNET_NETWORK = "devnet";

const P = await import("../src/lib/starknetPrivacy/payroll");
const S = await import("../src/lib/starknetPrivacy/payrollStore");
const { fitCount } = await import("../src/lib/starknetPrivacy/payrollSession");
const { MAX_ACTIONS } = await import("../src/lib/starknetPrivacy/relayPolicy");
type PayrollRun = import("../src/lib/starknetPrivacy/payroll").PayrollRun;
type Inflight = import("../src/lib/starknetPrivacy/payroll").Inflight;
type Proven = import("../src/lib/starknetPrivacy/payroll").Proven;
type Reach = import("../src/lib/starknetPrivacy/payroll").Reach;

let checks = 0;
let savedBeforeSend = 0;
const ok = (cond: unknown, msg: string) => {
  assert.ok(cond, msg);
  checks++;
};
const eq = <T,>(a: T, b: T, msg: string) => {
  assert.deepEqual(a, b, msg);
  checks++;
};

const USDC = { symbol: "USDC", decimals: 6 };
const addr = (i: number) => `0x${(0x5000n + BigInt(i) * 0x1000003n).toString(16)}${"ab".repeat(20)}`;
const OWNER = addr(999);
const ONE = 1_000_000n;

// ------------------------------------------------------------------ the list

{
  eq(P.RELAY_MAX_ACTIONS, MAX_ACTIONS, "the payroll cap is the relay's");
  const r = P.parseStarknetPayrollCsv(`name,address,amount\nAda,${addr(1)},250\nTunde,${addr(2)},"1,250.5"`, USDC);
  eq(r.error, null, "header list reads");
  eq(r.rows.map((x) => x.amount), [250n * ONE, 1_250_500_000n], "amounts in base units, a quoted grouped amount too");
  eq(r.rows[0]!.address, P.starknetAddressText(addr(1)), "addresses in one form");
  eq(r.notesLeftOut, false, "no note column");

  const tabs = P.parseStarknetPayrollCsv(`﻿Ada\t${addr(1).toUpperCase().replace("0X", "0x")}\t10\nBo\t${addr(2)}\t5`, USDC);
  eq(tabs.rows.map((x) => [x.name, x.amount, x.error]), [["Ada", 10n * ONE, null], ["Bo", 5n * ONE, null]], "tab list with a BOM, upper-case hex");
  eq(tabs.rows[0]!.address, P.starknetAddressText(addr(1)), "upper-case hex becomes the one form");

  const semi = P.parseStarknetPayrollCsv(`Ada;${addr(1)};1,25`, USDC);
  ok(semi.rows[0]!.error?.includes("dot for decimals"), "a semicolon list's decimal comma is refused out loud");

  const two = P.parseStarknetPayrollCsv(`${addr(1)},3\n${addr(2)},4`, USDC);
  eq(two.rows.map((x) => [x.name, x.amount]), [["Person 1", 3n * ONE], ["Person 2", 4n * ONE]], "address, amount lists get names");

  const evm = P.parseStarknetPayrollCsv(`name,gloam_address,amount,note\nAda,${addr(1)},1,September`, USDC);
  ok(evm.error?.includes("address column"), "an EVM header with gloam_address has no Starknet address column");
  const evm2 = P.parseStarknetPayrollCsv(`name,address,amount,note\nAda,${addr(1)},1,September`, USDC);
  eq([evm2.notesLeftOut, evm2.rows[0]!.amount], [true, ONE], "a note column is read past and said");
  const evm3 = P.parseStarknetPayrollCsv(`Ada,${addr(1)},1,September`, USDC);
  eq([evm3.notesLeftOut, evm3.rows[0]!.error], [true, null], "four columns without a header: the EVM order, note left out");

  const bad = P.parseStarknetPayrollCsv(
    [`A,,1`, `B,gloamr1.abc,1`, `C,0x0,1`, `D,0x${"f".repeat(64)},1`, `E,${addr(5)},0`, `F,${addr(6)},1.1234567`, `G,${addr(7)},-1`, `H,${addr(8)},1,2,3`, `I,"${addr(9)},1`].join("\n"),
    USDC
  );
  eq(
    bad.rows.map((x) => x.error),
    [
      "Add their private account on Starknet.",
      "That is a Gloam address for the other networks. Use their private account on Starknet.",
      "Not a Starknet address. Copy their private account again from Gloam.",
      "Not a Starknet address. Copy their private account again from Gloam.",
      "Enter an amount above zero.",
      "Use at most 6 decimal places.",
      "Amounts can't be negative.",
      'This row has more cells than the list has columns. Put an amount with a comma in quotes, like "1,250", and use a dot for decimals.',
      "Check the quotes in this row: a quoted cell needs its closing quote, with nothing after it.",
    ],
    "each bad row says why"
  );
  ok(bad.rows.every((x) => x.amount === null), "bad rows have no amount");

  const dup = P.parseStarknetPayrollCsv(`A,${addr(1)},1\nB,${addr(1)},2`, USDC);
  eq([dup.rows[0]!.note, dup.rows[1]!.note], [undefined, "Same account as line 1. Both lines are paid."], "the same account twice: both paid, said");
  const many = P.parseStarknetPayrollCsv(Array.from({ length: P.PAYROLL_MAX_ROWS + 1 }, (_, i) => `P${i},${addr(i)},1`).join("\n"), USDC);
  ok(many.error?.includes(`Up to ${P.PAYROLL_MAX_ROWS}`), "too many rows refused");
  const empty = P.parseStarknetPayrollCsv(`name,address,amount\n,,\n`, USDC);
  eq(empty.rows, [], "a spreadsheet's empty rows are nothing");
  ok(P.parseStarknetPayrollCsv(`name,amount\nA,1`, USDC).error !== null, "a header with no address column is refused");
  eq(P.starknetAddressText("0x" + "0".repeat(10) + "1"), "0x1", "leading zeros go");
  eq(P.starknetAddressText(`0x${(1n << 251n).toString(16)}`), null, "2^251 is not an address");
  eq(P.readPayrollAmount(`${(1n << 128n).toString()}`, 0), { error: "That amount is too large." }, "above u128 refused");
}

// ------------------------------------------------------------------ the account check and the estimate

{
  const list = P.parseStarknetPayrollCsv([`A,${addr(1)},1`, `B,${addr(2)},2`, `C,${addr(3)},3`, `Me,${OWNER},4`, `A2,${addr(1)},5`].join("\n"), USDC).rows;
  eq(P.addressesToCheck(list, new Map()), [addr(1), addr(2), addr(3), OWNER].map((a) => P.starknetAddressText(a)!), "each account checked once");
  const reach = new Map<string, Reach>([
    [P.starknetAddressText(addr(1))!, "ready"],
    [P.starknetAddressText(addr(2))!, "first"],
    [P.starknetAddressText(addr(3))!, "closed"],
    [P.starknetAddressText(OWNER)!, "ready"],
  ]);
  eq(P.addressesToCheck(list, reach), [], "nothing left to check");
  const checked = P.checkRecipients(list, reach, OWNER);
  eq(
    checked.map((x) => [x.error, Boolean(x.first)]),
    [
      [null, false],
      [null, true],
      [P.NOT_OPEN, false],
      [P.OWN_ACCOUNT, false],
      [null, false],
    ],
    "no private account, own account, first payment"
  );
  const s = P.summarize(checked, 100n * ONE, ONE / 4n);
  eq(s, { ready: 3, skipped: 2, total: 8n * ONE, proofs: 1, links: 0, fees: ONE / 4n, first: 1, short: 0n }, "three people, one proof, one fee");
  eq(P.summarize(checked, 8n * ONE, ONE / 4n).short, ONE / 4n, "short by the fee when the balance only covers the pay");
  eq(P.summarize(checked, 100n * ONE, 0n).fees, 0n, "no fee asked, none counted");

  const ready = (n: number, first = false) => Array.from({ length: n }, (_, i) => ({ address: addr(i), first }));
  eq(P.estimateProofs([]), 0, "nobody, no proofs");
  eq(P.estimateProofs(ready(28)), 1, "28 over open channels fit one proof");
  eq(P.estimateProofs(ready(29)), 2, "29 take two");
  eq(P.estimateProofs(ready(8, true)), 1, "8 first payments fit one");
  eq(P.estimateProofs(ready(9, true)), 2, "9 first payments take two");
  eq(P.estimateProofs(ready(200)), 8, "200 over open channels: 8 proofs");
}

// ------------------------------------------------------------------ fitting a proof

{
  const calls: number[] = [];
  const linear = (base: number, per: number) => async (n: number) => {
    calls.push(n);
    return base + per * n;
  };
  eq(await fitCount(28, linear(8, 2)), 28, "28 open-channel payments fit");
  calls.length = 0;
  eq(await fitCount(28, linear(8, 7)), 8, "first payments: 8 fit");
  ok(calls.length <= 3, `found in a few tries (${calls.join(",")})`);
  eq(await fitCount(5, linear(70, 1)), 0, "nothing fits: 0");
  eq(await fitCount(0, linear(8, 2)), 0, "nobody: 0");
  // uneven: the first two cost a lot
  eq(await fitCount(10, async (n) => 8 + Math.min(n, 2) * 25 + Math.max(0, n - 2) * 2), 5, "uneven costs settle on the most that fit");
}

// ------------------------------------------------------------------ the page's chain side, before any proof

{
  const { starknetPayrollDeps } = await import("../src/lib/starknetPrivacy/payrollSession");
  const { StarknetRelayError } = await import("../src/lib/starknetPrivacy/session");
  const token = { symbol: "USDC", name: "USD Coin", address: "0x1234", decimals: 6 };
  const fake = (info: Record<string, unknown>, changed = false, relay?: () => Promise<string>) => {
    const calls: string[] = [];
    const s = {
      cfg: { discovery: { kind: "indexer" }, pool: "0x99" },
      address: OWNER,
      relayInfo: { on: true, funded: true, relayer: "0x5", moves: "on", fee: {}, maxApprove: {}, network: "devnet", pool: "0x99", ...info },
      refreshRelay: async () => (calls.push("refresh"), changed),
      settle: async () => (calls.push("settle"), 100),
      relay: relay ?? (async () => "0xabc"),
    };
    return { deps: starknetPayrollDeps(s as never, token), calls };
  };
  const stops = async (info: Record<string, unknown>, changed: boolean, code: string, label: string) => {
    const f = fake(info, changed);
    let got: unknown = null;
    try {
      await f.deps.prove([{ address: addr(1), amount: 1n }], () => {});
    } catch (e) {
      got = e;
    }
    ok(got instanceof StarknetRelayError && got.code === code, `${label}: stops with ${code}`);
    eq(f.calls, ["refresh"], `${label}: before waiting or proving anything`);
  };
  await stops({ funded: false }, false, "relay_paused", "a relay out of STRK");
  await stops({ moves: "off" }, false, "moves_off", "moves not open");
  await stops({}, true, "relay_changed", "a fee that changed since the page read it");

  const refusal = async (e: unknown) => {
    try {
      await fake({}, false, async () => {
        throw e;
      }).deps.send({ count: 1, spends: [], change: [], provedAt: 1, fee: 0n, payload: { callAndProof: { call: { contractAddress: "0x1", entrypoint: "apply_actions", calldata: [] }, proof: { proofFacts: [], data: "" } } } });
    } catch (x) {
      return x as { status: number; code: string; message: string; maybeSent: boolean };
    }
    return null;
  };
  eq(await refusal(new StarknetRelayError("rate_limited", "Too many")), { status: 429, code: "rate_limited", message: "Too many", maybeSent: false }, "a 429 sent nothing");
  eq((await refusal(new StarknetRelayError("already_sent", "x")))?.maybeSent, true, "already sent: it may have landed");
  eq((await refusal(new StarknetRelayError("relay_failed", "x")))?.maybeSent, true, "no answer the page could read: it may have landed");
  eq((await refusal(new TypeError("Failed to fetch")))?.maybeSent, true, "the request failed: it may have reached the relay");
  eq((await refusal(new StarknetRelayError("not_relayable", "x")))?.maybeSent, false, "a refusal by policy sent nothing");
}

// ------------------------------------------------------------------ the engine

type Build = { id: number; spends: string[]; change: string[]; provedAt: number; payments: { address: string; amount: bigint }[]; landed: boolean; reverted: boolean; hash: string };
type SendMode = "ok" | "429" | "422" | "lost-landed" | "lost-not-sent" | "hang-landed" | "hang-not-sent";
type ConfirmMode = "ok" | "timeout" | "reverted";

function fakeChain(validity = 12) {
  const builds: Build[] = [];
  const ledger = new Map<string, bigint>();
  const sends: number[] = [];
  const unspent = new Set<string>(["0xa0"]);
  let current = "0xa0";
  let head = 1_000;
  return {
    builds,
    ledger,
    sends,
    unspent,
    validity,
    get head() {
      return head;
    },
    advance(blocks: number) {
      head += blocks;
    },
    build(payments: { address: string; amount: bigint }[], count: number): Build {
      const id = builds.length;
      const b: Build = { id, spends: [current], change: [`0xc${id.toString(16)}`], provedAt: head - 10, payments: payments.slice(0, count), landed: false, reverted: false, hash: `0x7${id.toString(16)}` };
      builds.push(b);
      return b;
    },
    land(b: Build) {
      if (b.landed) throw new Error(`proof ${b.id} landed twice`);
      if (!b.spends.every((s) => unspent.has(s))) throw new Error(`proof ${b.id} spends a spent note`);
      b.landed = true;
      for (const s of b.spends) unspent.delete(s);
      for (const c of b.change) unspent.add(c);
      current = b.change[0]!;
      for (const p of b.payments) ledger.set(p.address, (ledger.get(p.address) ?? 0n) + p.amount);
      head += 1;
    },
    /** Another tab spends the current note (a Vault payment). */
    spendElsewhere() {
      unspent.delete(current);
      current = "0xe0";
      unspent.add(current);
    },
  };
}

type Scenario = {
  send?: SendMode[];
  confirm?: ConfirmMode[];
  /** Most people one proof takes. */
  fit?: number;
  saveFailsAt?: number;
  stopAfterSends?: number;
  proveError?: Error;
};

function harness(chain: ReturnType<typeof fakeChain>, sc: Scenario = {}) {
  let now = 1_700_000_000_000;
  const sleeps: number[] = [];
  const saved: PayrollRun[] = [];
  let stop = false;
  const sendModes = [...(sc.send ?? [])];
  const confirmModes = [...(sc.confirm ?? [])];
  let saves = 0;
  let proofs = 0;
  const deps: import("../src/lib/starknetPrivacy/payroll").PayrollDeps = {
    async save(run) {
      saves++;
      if (sc.saveFailsAt !== undefined && saves === sc.saveFailsAt) throw new Error("QuotaExceededError");
      saved.push(JSON.parse(JSON.stringify(run)) as PayrollRun);
    },
    async prove(payments, onWait) {
      onWait("A few more blocks");
      if (sc.proveError) throw sc.proveError;
      proofs++;
      const b = chain.build(payments, Math.min(payments.length, sc.fit ?? P.PAYROLL_PROOF_MAX));
      return { count: b.payments.length, spends: b.spends, change: b.change, provedAt: b.provedAt, fee: ONE / 4n, payload: b.id } satisfies Proven;
    },
    async send(proven) {
      const b = chain.builds[proven.payload as number]!;
      const last = saved.at(-1)!;
      assert.ok(last.inflight && last.inflight.spends.join() === b.spends.join() && last.inflight.provedAt === b.provedAt, "saved in flight before the send");
      assert.ok(last.inflight.rows.every((i) => last.rows[i]!.status === "sending"), "its rows are saved as sending");
      checks += 2;
      savedBeforeSend++;
      chain.sends.push(b.id);
      const mode = sendModes.shift() ?? "ok";
      if (sc.stopAfterSends !== undefined && chain.sends.length === sc.stopAfterSends) stop = true;
      switch (mode) {
        case "ok":
          chain.land(b);
          return b.hash;
        case "429":
          throw { status: 429, code: "rate_limited", message: "Too many requests.", maybeSent: false };
        case "422":
          throw { status: 400, code: "not_relayable", message: "Gloam's relay doesn't send this: too_many_actions.", maybeSent: false };
        case "lost-landed":
          chain.land(b);
          throw { status: 0, code: "network", message: "Failed to fetch", maybeSent: true };
        case "lost-not-sent":
          throw { status: 0, code: "network", message: "Failed to fetch", maybeSent: true };
        case "hang-landed":
          chain.land(b);
          return new Promise<string>(() => {});
        case "hang-not-sent":
          return new Promise<string>(() => {});
      }
    },
    async confirm(hash) {
      const b = chain.builds.find((x) => x.hash === hash)!;
      const mode = confirmModes.shift() ?? "ok";
      if (mode === "timeout") throw new Error("Starknet hasn't confirmed it yet.");
      if (mode === "reverted") {
        if (b.landed) throw new Error("test setup: a reverted proof can't have landed");
        b.reverted = true;
        throw new Error("Starknet reverted it.");
      }
      assert.ok(b.landed, "confirmed only what landed");
    },
    async resolve(f: Inflight) {
      const b = chain.builds.find((x) => x.spends.join() === f.spends.join() && x.provedAt === f.provedAt)!;
      const receipt = f.txHash && b.landed ? { status: "succeeded" as const } : f.txHash && b.reverted ? { status: "reverted" as const } : null;
      return P.settleInflight(f, { receipt, unspent: chain.unspent, head: chain.head, validity: chain.validity });
    },
    message: (e) => (e instanceof Error ? e.message : String(e)),
    async sleep(ms) {
      sleeps.push(ms);
      now += ms;
      chain.advance(Math.ceil(ms / 2_000));
    },
    now: () => now,
    stopRequested: () => stop,
  };
  return {
    deps,
    sleeps,
    saved,
    get proofs() {
      return proofs;
    },
    resume() {
      stop = false;
    },
  };
}

function draft(n: number, bad = 0) {
  const lines = ["name,address,amount"];
  for (let i = 0; i < n; i++) lines.push(`Person ${i},${addr(i + 10)},${i + 1}`);
  for (let i = 0; i < bad; i++) lines.push(`Bad ${i},nope,1`);
  return P.parseStarknetPayrollCsv(lines.join("\n"), USDC).rows;
}
const mkRun = (n: number, bad = 0) => P.newRun({ id: "run-1", network: "devnet", owner: OWNER, token: "0x1234", rows: draft(n, bad), now: 1 });
const expected = (run: PayrollRun) => {
  const m = new Map<string, bigint>();
  for (const r of run.rows.filter((x) => x.status !== "skipped")) m.set(r.address, (m.get(r.address) ?? 0n) + BigInt(r.amount));
  return m;
};
const paidOnce = (chain: ReturnType<typeof fakeChain>, run: PayrollRun, label: string) => {
  eq(chain.ledger, expected(run), `${label}: everyone paid exactly once`);
  ok(chain.builds.every((b) => !(b.landed && b.reverted)), `${label}: nothing both landed and reverted`);
};
const tick = () => new Promise((r) => setTimeout(r, 20));

// A. 40 people and 2 bad rows: proofs of 28 and 12, one fee each.
{
  const chain = fakeChain();
  const h = harness(chain);
  const run = mkRun(40, 2);
  eq(run.rows.filter((r) => r.status === "skipped").length, 2, "A: bad rows go in the run as skipped");
  const out = await P.runPayroll(run, h.deps);
  eq(out.state, "done", "A: done");
  eq(chain.builds.map((b) => b.payments.length), [28, 12], "A: 28 then 12");
  eq([out.proofs, out.feesPaid], [2, (ONE / 2n).toString()], "A: two proofs, two fees");
  paidOnce(chain, out, "A");
  ok(out.rows.filter((r) => r.status === "paid").every((r) => r.txHash === "0x70" || r.txHash === "0x71"), "A: each paid row has its transaction");
  ok(out.rows.filter((r) => r.status === "skipped").every((r) => !r.txHash && r.reason), "A: skipped rows keep their reason");
  eq(out.inflight, null, "A: nothing in flight");
  eq(h.saved.at(-1)!.state, "done", "A: the stored run is done");
  ok(!P.runOpen(out), "A: finished");
  const c = P.runCounts(out);
  eq([c.paid, c.toPay, c.skipped, c.unknown], [40, 0, 2, 0], "A: counts");
}

// B. Fewer fit: the run takes what the proof took and goes on.
{
  const chain = fakeChain();
  const h = harness(chain, { fit: 9 });
  const out = await P.runPayroll(mkRun(20), h.deps);
  eq(chain.builds.map((b) => b.payments.length), [9, 9, 2], "B: 9, 9, 2");
  paidOnce(chain, out, "B");
}

// C. 429 twice: the same proof goes again once the minute turns, no new proof made.
{
  const chain = fakeChain();
  const h = harness(chain, { send: ["429", "429", "ok"] });
  const out = await P.runPayroll(mkRun(3), h.deps);
  eq(out.state, "done", "C: done after two 429s");
  eq([h.proofs, chain.sends.length], [1, 3], "C: one proof, sent three times");
  ok(h.sleeps.some((s) => s >= 1_500 && s <= 61_500) && h.sleeps.some((s) => s >= 31_500), "C: waited to the next minute, then longer");
  paidOnce(chain, out, "C");
}

// C2. 429 past the tries: paused, rows wait, nothing in flight.
{
  const chain = fakeChain();
  const h = harness(chain, { send: Array(P.RELAY_LIMITED_TRIES + 1).fill("429") });
  const out = await P.runPayroll(mkRun(2), h.deps);
  eq([out.state, out.error], ["paused", P.RELAY_BUSY], "C2: paused at the relay's limit");
  ok(out.rows.every((r) => r.status === "queued") && out.inflight === null, "C2: rows wait, nothing in flight");
  const again = await P.runPayroll(out, harness(chain).deps);
  paidOnce(chain, again, "C2");
}

// D. A refusal that sent nothing stops the run; resume pays.
{
  const chain = fakeChain();
  const h = harness(chain, { send: ["422"] });
  const out = await P.runPayroll(mkRun(4), h.deps);
  eq(out.state, "paused", "D: paused on a refusal");
  ok(out.error?.includes("too_many_actions"), "D: the relay's words are shown");
  eq(chain.ledger.size, 0, "D: nobody paid");
  ok(out.rows.every((r) => r.status === "queued") && out.inflight === null, "D: rows wait, nothing in flight");
  const again = await P.runPayroll(out, h.deps);
  eq(again.state, "done", "D: resume pays");
  paidOnce(chain, again, "D");
}

// E. A proof that can't be made (the day's proofs are used, a fee changed): paused, nothing in flight.
{
  const chain = fakeChain();
  const h = harness(chain, { proveError: new Error("Gloam's fee on Starknet just changed. Check it and resume.") });
  const out = await P.runPayroll(mkRun(3), h.deps);
  eq([out.state, out.error], ["paused", "Gloam's fee on Starknet just changed. Check it and resume."], "E: paused with why");
  ok(out.rows.every((r) => r.status === "queued") && out.inflight === null, "E: rows wait");
  eq(chain.sends.length, 0, "E: nothing sent");
}

// F. The save before a send fails: nothing is sent.
{
  const chain = fakeChain();
  const h = harness(chain, { saveFailsAt: 2 });
  const out = await P.runPayroll(mkRun(3), h.deps);
  eq([out.state, out.error], ["paused", P.SAVE_FAILED], "F: paused, said");
  eq(chain.sends.length, 0, "F: nothing sent on progress that wasn't saved");
  ok(out.inflight === null && out.rows.every((r) => r.status === "queued"), "F: rows wait");
}

// G. Stop after the first proof.
{
  const chain = fakeChain();
  const h = harness(chain, { stopAfterSends: 1 });
  const out = await P.runPayroll(mkRun(30), h.deps);
  eq(out.state, "paused", "G: paused on request");
  eq(P.runCounts(out).paid, 28, "G: the first proof's people are paid");
  h.resume();
  const again = await P.runPayroll(out, h.deps);
  paidOnce(chain, again, "G");
}

// H. The tab closes after the relay sent it (no hash saved): resume finds it landed by its change note.
{
  const chain = fakeChain();
  const h = harness(chain, { send: ["hang-landed"] });
  void P.runPayroll(mkRun(30), h.deps);
  await tick();
  const stored = h.saved.at(-1)!;
  ok(stored.inflight && !stored.inflight.txHash && stored.inflight.change.length === 1, "H: stored in flight with its change, no hash");
  const out = await P.runPayroll(JSON.parse(JSON.stringify(stored)) as PayrollRun, harness(chain).deps);
  eq(out.state, "done", "H: resumed to the end");
  eq(chain.sends.length, 2, "H: the landed proof was not sent again");
  paidOnce(chain, out, "H");
}

// I. The tab closes before the relay sent it: resume waits for the window to close, then proves again.
{
  const chain = fakeChain(12);
  const h = harness(chain, { send: ["hang-not-sent"] });
  void P.runPayroll(mkRun(5), h.deps);
  await tick();
  const stored = h.saved.at(-1)!;
  const h2 = harness(chain);
  const out = await P.runPayroll(JSON.parse(JSON.stringify(stored)) as PayrollRun, h2.deps);
  eq(out.state, "done", "I: done");
  ok(h2.sleeps.filter((s) => s === P.INFLIGHT_POLL_MS).length >= 1, "I: checked again while it could still land");
  eq(chain.builds.length, 2, "I: proven again only once it could no longer land");
  ok(chain.head > chain.builds[0]!.provedAt + chain.validity, "I: past the first proof's window");
  paidOnce(chain, out, "I");
}

// J. The relay's answer is lost after it sent: settled by its notes, not sent again.
{
  const chain = fakeChain();
  const h = harness(chain, { send: ["lost-landed"] });
  const out = await P.runPayroll(mkRun(30), h.deps);
  eq(out.state, "done", "J: done");
  eq(chain.sends.length, 2, "J: 28 then 2, the first never sent twice");
  paidOnce(chain, out, "J");
}

// J2. Lost answer and it never got sent: dropped once its window closes, proven and sent again.
{
  const chain = fakeChain(6);
  const h = harness(chain, { send: ["lost-not-sent"] });
  const out = await P.runPayroll(mkRun(2), h.deps);
  eq(out.state, "done", "J2: done");
  eq([chain.builds.length, chain.sends.length], [2, 2], "J2: proven again after it was dropped");
  paidOnce(chain, out, "J2");
}

// K. The confirmation times out but it landed: settled by its receipt.
{
  const chain = fakeChain();
  const h = harness(chain, { confirm: ["timeout"] });
  const out = await P.runPayroll(mkRun(3), h.deps);
  eq(out.state, "done", "K: done");
  eq(chain.sends.length, 1, "K: sent once");
  ok(out.rows.every((r) => r.txHash === "0x70"), "K: rows keep the transaction");
  paidOnce(chain, out, "K");
}

// L. Reverted on Starknet: nobody paid, the run pauses with why, resume proves again.
{
  const chain = fakeChain();
  const h = harness(chain);
  const realSend = h.deps.send;
  let first = true;
  h.deps.send = async (p) => {
    if (!first) return realSend(p);
    first = false;
    const b = chain.builds[p.payload as number]!;
    savedBeforeSend++;
    chain.sends.push(b.id);
    return b.hash; // sent, not landed
  };
  const realConfirm = h.deps.confirm;
  let firstConfirm = true;
  h.deps.confirm = async (hash) => {
    if (!firstConfirm) return realConfirm(hash);
    firstConfirm = false;
    chain.builds.find((x) => x.hash === hash)!.reverted = true;
    throw new Error("Starknet reverted it.");
  };
  const out = await P.runPayroll(mkRun(3), h.deps);
  eq(out.state, "paused", "L: paused on a revert");
  ok(out.error?.startsWith("Starknet reverted it"), "L: says it reverted");
  eq(chain.ledger.size, 0, "L: nobody paid");
  ok(out.rows.every((r) => r.status === "queued" && !r.txHash), "L: rows wait, no transaction kept");
  const again = await P.runPayroll(out, harness(chain).deps);
  eq(again.state, "done", "L: resume pays");
  paidOnce(chain, again, "L");
}

// M. Can't tell: its notes are gone (another tab spent them), no change and no hash. Never sent again.
{
  const chain = fakeChain();
  const h = harness(chain, { send: ["hang-not-sent"] });
  void P.runPayroll(mkRun(4), h.deps);
  await tick();
  const stored = JSON.parse(JSON.stringify(h.saved.at(-1)!)) as PayrollRun;
  chain.spendElsewhere();
  const out = await P.runPayroll(stored, harness(chain).deps);
  eq(out.state, "done", "M: the run ends");
  ok(out.rows.every((r) => r.status === "unknown" && r.reason === P.NOT_SURE), "M: rows say it can't tell");
  eq(chain.sends.length, 1, "M: never sent again");
  eq(P.runCounts(out).unknown, 4, "M: counted as not sure");
  ok(!P.runOpen(out), "M: nothing left to pay");
}

// N. Close a paused run: rows not paid stay unpaid; refused while a proof is in flight.
{
  const chain = fakeChain();
  const h = harness(chain, { stopAfterSends: 1 });
  const out = await P.runPayroll(mkRun(30), h.deps);
  const closed = P.closeRun(out);
  eq([closed.state, closed.rows.filter((r) => r.status === "not_paid").length], ["done", 2], "N: closed, two not paid");
  assert.throws(() => P.closeRun({ ...out, inflight: { rows: [0], spends: ["0x1"], change: [], provedAt: 1, at: 1 } }), /may still land/);
  checks++;
}

ok(savedBeforeSend > 15, `every send went out with its proof saved in flight (${savedBeforeSend})`);

// ------------------------------------------------------------------ settleInflight

{
  const f: Pick<Inflight, "spends" | "change" | "provedAt"> = { spends: ["0xa"], change: ["0xc"], provedAt: 100 };
  const now = (over: Partial<Parameters<typeof P.settleInflight>[1]>) => ({ receipt: null, unspent: new Set(["0xa"]), head: 105, validity: 20, ...over });
  eq(P.settleInflight({ ...f, txHash: "0x1" }, now({ receipt: { status: "succeeded" } })), { state: "landed", txHash: "0x1" }, "a receipt that succeeded: landed");
  eq(P.settleInflight({ ...f, txHash: "0x1" }, now({ receipt: { status: "reverted", reason: "nullifier used" } })), { state: "failed", message: "Starknet reverted it: nullifier used" }, "reverted: failed");
  eq(P.settleInflight(f, now({})), { state: "pending" }, "notes unspent inside the window: pending");
  eq(P.settleInflight(f, now({ head: 121 })), { state: "pending" }, "one block of margin past the window");
  eq(P.settleInflight(f, now({ head: 122 })), { state: "dropped" }, "past the window, notes unspent: dropped");
  eq(P.settleInflight(f, now({ unspent: new Set(["0xc"]) })), { state: "landed" }, "notes spent and its change there: landed");
  eq(P.settleInflight(f, now({ unspent: new Set(["0xe"]) })), { state: "unknown" }, "notes spent, no change, no hash: can't tell");
  eq(P.settleInflight({ ...f, txHash: "0x1" }, now({ unspent: new Set(["0xe"]) })), { state: "pending" }, "notes spent, hash known but no receipt yet: wait for it");
  eq(P.settleInflight({ ...f, change: [] }, now({ unspent: new Set() })), { state: "unknown" }, "an exact spend with no hash: can't tell");
}

// ------------------------------------------------------------------ results and storage

{
  const run = mkRun(2);
  run.rows[0] = { ...run.rows[0]!, name: "=HYPERLINK(1)", status: "paid", txHash: "0x99" };
  run.rows[1] = { ...run.rows[1]!, status: "not_paid", reason: "Closed early" };
  const csv = P.resultsCsv(run, USDC).split("\n");
  eq(csv[0], "row,name,account,amount,token,status,transaction,claim link,reason", "results header");
  ok(csv[1]!.includes("'=HYPERLINK(1)") && csv[1]!.includes(",1,USDC,paid,0x99,,"), "a formula name is defused, amount exact");
  ok(csv[2]!.endsWith("not paid,,,Closed early"), "a row not paid says why");

  ok(P.isRun(JSON.parse(JSON.stringify(run))), "a run reads back");
  ok(!P.isRun({ ...run, v: 2 }), "another version doesn't");
  ok(!P.isRun({ ...run, inflight: { rows: [5], spends: [], change: [], provedAt: 1, at: 1 } }), "an in-flight row out of range doesn't");
  ok(!P.isRun({ ...run, inflight: { rows: [0], spends: ["nope"], change: [], provedAt: 1, at: 1 } }), "a bad note id doesn't");
  ok(!P.isRun({ ...run, feesPaid: "-1" }), "a bad fee total doesn't");

  const mem = new Map<string, string>();
  const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
  const key = S.payrollStoreKey("devnet", OWNER);
  ok(key.startsWith("gloam:starknet-payroll:v1:devnet:"), "the store's key names the network and account");
  const store = S.payrollStore({ key, cipher: await S.runCipher(123456789n, OWNER), storage });
  const open = { ...mkRun(1), id: "open", createdAt: 1 };
  await store.save(open);
  for (let i = 0; i < 12; i++) await store.save({ ...P.closeRun(mkRun(1)), id: `done-${i}`, createdAt: 10 + i });
  const all = await store.load();
  eq(all.length, 11, "ten finished runs kept, and the open one");
  ok(all.some((r) => r.id === "open"), "the open run is never dropped");
  eq(all[0]!.id, "done-11", "newest first");
  ok(!mem.get(key)!.includes("Person"), "names are sealed");
  const other = S.payrollStore({ key, cipher: await S.runCipher(987654321n, OWNER), storage });
  eq(await other.load(), [], "another key reads nothing");
  ok(mem.has(`${key}:unreadable`), "and the list it can't open is set aside");
  const moved = S.payrollStore({ key, cipher: await S.runCipher(123456789n, addr(7)), storage });
  mem.delete(`${key}:unreadable`);
  eq(await moved.load(), [], "the same key bound to another account reads nothing");
  eq(S.viewingKeyBytes(1n).length, 32, "a viewing key is 32 bytes");
  assert.throws(() => S.viewingKeyBytes(0n));
  checks++;
}

// ------------------------------------------------------------------ schedules

{
  const SC = await import("../src/lib/starknetPrivacy/payrollSchedule");
  const rows = P.parseStarknetPayrollCsv(`name,address,amount\n"Obi, Ada",${addr(1)},1250.5\nBo,${addr(2)},3\nBad,nope,1`, USDC).rows;
  const people = SC.peopleFromRows(rows);
  eq(people.map((p) => p.amount), ["1250500000", "3000000"], "a schedule keeps the rows that can be paid");
  assert.throws(() => SC.newSchedule({ id: "x", name: "T", network: "devnet", owner: OWNER, token: "0x1", cadence: { kind: "monthly", day: 25 }, startsOn: "2026-11-27", people: [], now: 1 }), /team/);
  checks++;
  const s = SC.newSchedule({ id: "s1", name: "  Team  ", network: "devnet", owner: OWNER, token: "0x1", cadence: { kind: "monthly", day: 25 }, startsOn: "2026-12-25", people, now: 5 });
  eq([s.name, s.paused, s.endsOn], ["Team", false, undefined], "a new schedule");
  ok(SC.isSchedule(JSON.parse(JSON.stringify(s))), "it reads back");
  ok(!SC.isSchedule({ ...s, people: [{ ...people[0]!, address: "0xABC" }] }), "an address not in the one form doesn't");
  ok(!SC.isSchedule({ ...s, people: [{ ...people[0]!, amount: "0" }] }), "a zero amount doesn't");
  ok(!SC.isSchedule({ ...s, cadence: { kind: "monthly", day: 40 } }), "a bad cadence doesn't");
  eq(SC.starknetScheduleState(s, "2026-12-01").status, "upcoming", "before its first payday: upcoming");
  eq(SC.paydayToRun(s, "2026-12-01"), null, "nothing owed yet");
  eq([SC.starknetScheduleState(s, "2026-12-26").status, SC.paydayToRun(s, "2026-12-26")], ["due", "2026-12-25"], "the day after: due, for the 25th");
  eq(SC.starknetScheduleState(s, "2027-01-02").status, "overdue", "a week late: overdue");
  const paid = SC.withPaid(s, "2026-12-25", "run-9", 99);
  eq([paid.paidThrough, paid.lastRunId, SC.paydayToRun(paid, "2026-12-26")], ["2026-12-25", "run-9", null], "paid through the 25th, nothing owed until January");
  eq(SC.withPaid(paid, "2026-11-25", "old", 100).paidThrough, "2026-12-25", "an older payday never moves it back");
  eq(SC.starknetScheduleState({ ...s, paused: true }, "2026-12-26").status, "paused", "paused");
  const once = SC.newSchedule({ id: "s2", name: "Bonus", network: "devnet", owner: OWNER, token: "0x1", cadence: { kind: "once", on: "2026-12-01" }, startsOn: "2026-12-01", people, now: 6 });
  eq(SC.starknetScheduleState(once, "2026-12-09").status, "overdue", "a one-time schedule not paid stays owed");
  eq(SC.starknetScheduleState(SC.withPaid(once, "2026-12-01", "r", 1), "2026-12-02").status, "ended", "and ends once paid");
  eq(SC.sortStarknetSchedules([s, once], "2026-12-02").map((x) => x.id), ["s2", "s1"], "the one due comes first");
  const text = SC.scheduleListText(s, USDC);
  const back = P.parseStarknetPayrollCsv(text, USDC).rows;
  eq(back.map((r) => [r.name, r.address, r.amount, r.error]), rows.slice(0, 2).map((r) => [r.name, r.address, r.amount, null]), "a schedule's list loads back as the same rows");
  eq(SC.firstPaydayFrom({ kind: "weekly", weekday: 5 }, "2026-11-27"), "2026-11-27", "a Friday schedule made on a Friday pays that day");

  const mem = new Map<string, string>();
  const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
  const key = SC.scheduleStoreKey("devnet", OWNER);
  const store = SC.scheduleStore({ key, cipher: await S.runCipher(42n, OWNER, SC.SCHEDULE_DOMAIN), storage });
  await store.save(s);
  await store.save(once);
  eq((await store.load()).map((x) => x.id).sort(), ["s1", "s2"], "schedules save and load");
  await store.remove("s2");
  eq((await store.load()).map((x) => x.id), ["s1"], "and delete");
  ok(!mem.get(key)!.includes("Obi"), "schedules are sealed");
  const runsKey = await S.runCipher(42n, OWNER);
  await assert.rejects(runsKey.open(mem.get(key)!));
  checks++;
  for (let i = 0; i < SC.MAX_SCHEDULES - 1; i++) await store.save({ ...s, id: `m${i}`, createdAt: 10 + i });
  await assert.rejects(store.save({ ...s, id: "one-too-many" }), /Up to 50/);
  checks++;
  eq((await store.load()).length, SC.MAX_SCHEDULES, "none dropped to make room");
  const run = P.newRun({ id: "r", network: "devnet", owner: OWNER, token: "0x1", rows, now: 1, schedule: { id: "s1", payday: "2026-12-25" } });
  eq([run.scheduleId, run.payday], ["s1", "2026-12-25"], "a run of a schedule names it and its payday");
  ok(P.isRun(JSON.parse(JSON.stringify(run))), "and reads back");
}

console.log(`selftest-starknet-payroll: ${checks} checks passed`);
