/**
 * Self-test: payroll on Solana (lib/solanaRings/payroll, payrollStore, and the
 * payroll parts of lib/solanaRings/client).
 *
 *  - the list: header or none, tabs, semicolons, quoted amounts, a BOM, bad
 *    rows flagged with a reason and skipped, the registry check (not set up,
 *    your own account), totals against the private balance;
 *  - pacing: sends at least RELAY_MIN_GAP_MS apart, 429 waits to the next minute;
 *  - the engine against a fake chain that keeps a ledger of who was paid:
 *    batches of 15, halving when a batch is too large, 429 retries, a refusal
 *    that stops the run, a save that fails before a send, a stop request, and
 *    every way a batch can be left in flight (tab closed before or after the
 *    relay sent it, a lost relay answer, a confirmation that timed out, a
 *    failure on chain, dropped, unknown). Nobody is ever paid twice, and the
 *    run is always saved with its batch in flight before that batch is sent;
 *  - the results CSV (formula cells defused) and the sealed store;
 *  - the relay client: which refusals may have been sent, and error codes
 *    wrapped by the SDK.
 *
 * No network. Run from app/:  ../mcp/node_modules/.bin/tsx scripts/selftest-solana-payroll.mts
 */
import assert from "node:assert/strict";
import Module from "node:module";
import { fileURLToPath } from "node:url";
import { getBase58Decoder } from "@solana/kit";

const stub = fileURLToPath(new URL("./server-only-stub.cjs", import.meta.url));
const M = Module as unknown as { _resolveFilename: (req: string, ...rest: unknown[]) => string };
const resolve = M._resolveFilename;
M._resolveFilename = function (req: string, ...rest: unknown[]) {
  return req === "server-only" ? stub : resolve.call(this, req, ...rest);
};
const env = process.env as Record<string, string | undefined>;
env.NEXT_PUBLIC_SOLANA_RINGS_ENABLED = "1";
env.NEXT_PUBLIC_SOLANA_RINGS_NETWORK = "devnet";
/** Claim links in payroll follow NEXT_PUBLIC_SOLANA_CLAIM_LINKS as the shell sets it: CI runs this off and on. */
const LINKS = env.NEXT_PUBLIC_SOLANA_CLAIM_LINKS === "1";

const P = await import("../src/lib/solanaRings/payroll");
const S = await import("../src/lib/solanaRings/payrollStore");
const { ringsAssets, RINGS_PAYROLL_NOTE, RINGS_PRIVACY_NOTE, ringsExplorerTx } = await import("../src/lib/solanaRings/config");
type PayrollRun = import("../src/lib/solanaRings/payroll").PayrollRun;
type Inflight = import("../src/lib/solanaRings/payroll").Inflight;
type InflightResult = import("../src/lib/solanaRings/payroll").InflightResult;

let checks = 0;
/** Sends made with the batch already stored in flight (asserted in the fake relay). */
let savedBeforeSend = 0;
const ok = (cond: unknown, msg: string) => {
  assert.ok(cond, msg);
  checks++;
};
const eq = <T,>(a: T, b: T, msg: string) => {
  assert.deepEqual(a, b, msg);
  checks++;
};

const SOL = ringsAssets("devnet").find((a) => a.id === "sol")!;
const USDC = ringsAssets("devnet").find((a) => a.id === "usdc")!;
const b58 = getBase58Decoder();
const addr = (i: number) => b58.decode(Uint8Array.from({ length: 32 }, (_, j) => (i * 31 + j * 7 + 1) % 256));
const OWNER = addr(999);

// ------------------------------------------------------------------ the list

{
  const a1 = addr(1);
  const a2 = addr(2);
  const a3 = addr(3);
  const text = [
    "﻿Name,Solana Address,Amount",
    `Ada Obi,${a1},250`,
    `Tunde Bello,${a2},"1,250.50"`,
    `Bad Amount,${a3},1,25`,
    `No Address,,10`,
    `EVM,0x1111111111111111111111111111111111111111,10`,
    `Junk,notanaddress,10`,
    `Zero,${a3},0`,
    `Negative,${a3},-5`,
    `Too precise,${a3},1.1234567`,
    `Letters,${a3},12abc`,
    `Dup,${a1},5`,
    ",,",
    "",
    `"Quoted, Name",${a3},7.5`,
  ].join("\r\n");
  const { rows, error } = P.parseSolanaPayrollCsv(text, USDC);
  eq(error, null, "a list with a header parses");
  eq(rows.length, 12, "empty rows are dropped, not flagged");
  eq(rows[0]!.amount, 250_000_000n, "250 USDC in base units");
  eq(rows[0]!.line, 2, "lines count from 1, the header included");
  eq(rows[1]!.amount, 1_250_500_000n, "a quoted 1,250.50 reads as 1250.5");
  ok(rows[2]!.error?.includes("more cells"), "an unquoted 1,25 shifts the row: refused, not read as 1 or 125");
  if (LINKS) ok(!rows[3]!.error && rows[3]!.link === true && rows[3]!.amount === 10_000_000n, "claim links on: a missing address gets a claim link, as on the other chains");
  else ok(rows[3]!.error?.includes("Solana private address") && !rows[3]!.link, "claim links off: a missing address says so");
  // either way, by choice
  eq(P.parseSolanaPayrollCsv("Tunde,,5", USDC, { links: false }).rows[0]!.error, P.NO_ADDRESS, "links off: no address is an error");
  ok(P.parseSolanaPayrollCsv("Tunde,,5", USDC, { links: true }).rows[0]!.link === true, "links on: no address is a claim link");
  ok(rows[4]!.error?.includes("EVM address"), "an EVM address is named as one");
  ok(rows[5]!.error?.includes("Not a Solana address"), "junk is not an address");
  ok(rows[6]!.error?.includes("above zero"), "zero is refused");
  ok(rows[7]!.error?.includes("negative"), "a minus sign is refused");
  ok(rows[8]!.error?.includes("6 decimal places"), "USDC takes at most 6 decimals");
  ok(rows[9]!.error, "letters in an amount are refused");
  ok(!rows[10]!.error && rows[10]!.note?.includes("line 2"), "the same address twice is noted, not refused");
  eq(rows[11]!.name, "Quoted, Name", "a quoted name keeps its comma");
  eq(rows[11]!.amount, 7_500_000n, "7.5 USDC");
  for (const r of rows) if (r.error) eq(r.amount, null, `a flagged row has no amount (line ${r.line})`);

  const plain = P.parseSolanaPayrollCsv(`Ada\t${a1}\t1.5\nTunde\t${a2}\t0.000000001`, SOL);
  eq(plain.error, null, "a tab list without a header parses");
  eq(plain.rows.map((r) => r.amount), [1_500_000_000n, 1n], "SOL takes 9 decimals");
  const semi = P.parseSolanaPayrollCsv(`Ada;${a1};2,5`, USDC);
  ok(semi.rows[0]!.error?.includes("dot for decimals"), "a semicolon list's 2,5 is a decimal comma: refused");
  const two = P.parseSolanaPayrollCsv(`${a1},3\n${a2},4`, USDC);
  eq(two.rows.map((r) => [r.address, r.amount, r.name]), [[a1, 3_000_000n, "Person 1"], [a2, 4_000_000n, "Person 2"]], "two columns: address, amount");
  const reordered = P.parseSolanaPayrollCsv(`amount,wallet,name\n9,${a1},Ada`, USDC);
  eq([reordered.rows[0]!.name, reordered.rows[0]!.amount], ["Ada", 9_000_000n], "a header can put the columns in any order");
  ok(P.parseSolanaPayrollCsv("name,amount\nAda,5", USDC).error?.includes("address column"), "a header without an address column says so");
  ok(P.parseSolanaPayrollCsv(`name,address,amount\nA,"${a1},5`, USDC).rows[0]!.error?.includes("quotes"), "an unclosed quote is refused");
  const many = Array.from({ length: P.PAYROLL_MAX_ROWS + 1 }, (_, i) => `P${i},${addr(i)},1`).join("\n");
  ok(P.parseSolanaPayrollCsv(many, SOL).error?.includes(`${P.PAYROLL_MAX_ROWS}`), "over the row limit is refused whole");
  eq(P.parseSolanaPayrollCsv("  \n\n", SOL), { rows: [], error: null }, "an empty list is no error");
  ok(P.readPayrollAmount("18446744073709551616", 0) && "error" in P.readPayrollAmount("18446744073709551616", 0), "over u64 is refused");
  eq(P.readPayrollAmount("$ 12.5", 6), { amount: 12_500_000n }, "a dollar sign and spaces are ignored");
  ok(P.isSolanaAddressText(a1) && !P.isSolanaAddressText("0OIl" + a1.slice(4)) && !P.isSolanaAddressText("1111"), "Solana address shape");

  // registry check
  const known = new Map<string, boolean>([[a1, true]]);
  eq(P.addressesToCheck(rows, known).sort(), [a2, a3].sort(), "only unread addresses of good rows are read");
  known.set(a2, false).set(a3, true);
  const checked = P.checkRecipients(rows, known, a3);
  eq(checked[0]!.error, null, "a registered address stays");
  eq(checked[1]!.error, P.NOT_SET_UP, "an unregistered address says they need a Gloam private account first");
  ok(P.NOT_SET_UP.includes("set up a Gloam private account on Solana first"), "the not-set-up words are plain");
  eq(checked[11]!.error, P.OWN_ACCOUNT, "paying your own private account is refused");
  eq(checked[1]!.amount, null, "a flagged row adds nothing to the total");

  const sum = P.summarize(checked, 300_000_000n);
  if (LINKS) {
    eq(checked[3]!.error, null, "a claim link row needs no registry record");
    eq(sum, { ready: 3, skipped: 9, total: 265_000_000n, short: 0n }, "three ready (Ada, her second line and a claim link), 265 USDC, covered");
    eq(P.summarize(checked, 265_000_000n - 1n).short, 1n, "short by exactly what is missing");
  } else {
    eq(sum, { ready: 2, skipped: 10, total: 255_000_000n, short: 0n }, "two people ready (Ada and her second line), 255 USDC, covered");
    eq(P.summarize(checked, 255_000_000n - 1n).short, 1n, "short by exactly what is missing");
  }
}

// ------------------------------------------------------------------ pacing

eq(P.paceDelay(undefined, 1000), 0, "the first send waits for nothing");
eq(P.paceDelay(10_000, 12_000), P.RELAY_MIN_GAP_MS - 2_000, "a send waits out the gap");
eq(P.paceDelay(10_000, 10_000 + P.RELAY_MIN_GAP_MS + 5), 0, "past the gap: no wait");
ok(Math.ceil(60_000 / P.RELAY_MIN_GAP_MS) < 10, "at most 9 sends in any relay minute (its limit is 10 per address)");
eq(P.rateLimitDelay(1, 120_000 + 15_000), 45_000 + 1_500, "a 429 waits for the next minute");
eq(P.rateLimitDelay(3, 120_000 + 59_000), 1_000 + 1_500 + 60_000, "later 429s wait longer");
ok(P.PAYROLL_BATCH_MAX === 15, "15 people per transaction, as the SDK allows");

// ------------------------------------------------------------------ engine on a fake chain

type Build = { id: number; sig: string; nullifiers: string[]; blockhash: string; payments: { address: string; amount: bigint }[]; landed: boolean; failed: boolean };
type SendMode = "ok" | "429" | "422" | "lost-landed" | "lost-not-sent" | "hang-landed" | "hang-not-sent";
type ConfirmMode = "ok" | "timeout" | "failed-on-chain";

function fakeChain() {
  const builds: Build[] = [];
  const ledger = new Map<string, bigint>();
  const sends: number[] = [];
  return {
    builds,
    ledger,
    sends,
    build(payments: { address: string; amount: bigint }[]) {
      const id = builds.length;
      const b: Build = { id, sig: `sig${id}`, nullifiers: [`${id.toString(16).padStart(2, "0")}aa`], blockhash: `bh${id}`, payments, landed: false, failed: false };
      builds.push(b);
      return { wire: new TextEncoder().encode(`tx${id}`), nullifiers: b.nullifiers, blockhash: b.blockhash };
    },
    byWire(wire: Uint8Array) {
      return builds[Number(new TextDecoder().decode(wire).slice(2))]!;
    },
    land(b: Build) {
      if (b.landed) throw new Error(`build ${b.id} landed twice`);
      b.landed = true;
      for (const p of b.payments) ledger.set(p.address, (ledger.get(p.address) ?? 0n) + p.amount);
    },
  };
}

type Scenario = {
  send?: SendMode[];
  confirm?: ConfirmMode[];
  /** Per blockhash: how many checks it stays valid. */
  validFor?: number;
  unknown?: boolean;
  tooBigOver?: number;
  saveFailsAt?: number;
  stopAfterSends?: number;
  buildError?: Error;
};

function harness(chain: ReturnType<typeof fakeChain>, sc: Scenario = {}) {
  let now = 1_700_000_000_000;
  const sleeps: number[] = [];
  const sendTimes: number[] = [];
  const saved: PayrollRun[] = [];
  let releases = 0;
  let stop = false;
  const validLeft = new Map<string, number>();
  const sendModes = [...(sc.send ?? [])];
  const confirmModes = [...(sc.confirm ?? [])];
  let saves = 0;
  const deps: import("../src/lib/solanaRings/payroll").PayrollDeps = {
    async save(run) {
      saves++;
      if (sc.saveFailsAt !== undefined && saves === sc.saveFailsAt) throw new Error("QuotaExceededError");
      saved.push(JSON.parse(JSON.stringify(run)) as PayrollRun);
    },
    async build(payments) {
      if (sc.buildError) throw sc.buildError;
      if (sc.tooBigOver !== undefined && payments.length > sc.tooBigOver) throw Object.assign(new Error("WALLET_BUILD_TRANSFER"), { code: "WALLET_BUILD_TRANSFER", causeCodes: ["INTERFACE_TRANSACTION_TOO_LARGE"] });
      return chain.build(payments);
    },
    async send(wire) {
      const b = chain.byWire(wire);
      // The crash-safety invariant: the last stored run has this batch in flight.
      const last = saved.at(-1)!;
      assert.ok(last.inflight && last.inflight.blockhash === b.blockhash && last.inflight.nullifiers.join() === b.nullifiers.join(), "saved in flight before the send");
      assert.ok(last.inflight.rows.every((i) => last.rows[i]!.status === "sending"), "its rows are saved as sending");
      checks += 2;
      savedBeforeSend++;
      sendTimes.push(now);
      chain.sends.push(b.id);
      const mode = sendModes.shift() ?? "ok";
      if (sc.stopAfterSends !== undefined && chain.sends.length === sc.stopAfterSends) stop = true;
      switch (mode) {
        case "ok":
          chain.land(b);
          return b.sig;
        case "429":
          throw { status: 429, code: "rate_limited", message: "Too many requests.", maybeSent: false };
        case "422":
          throw { status: 422, code: "would_fail", message: "This transaction would fail on Solana, so it wasn't sent.", maybeSent: false };
        case "lost-landed":
          chain.land(b);
          throw { status: 502, code: "upstream_unavailable", message: "Solana is slow to answer.", maybeSent: true };
        case "lost-not-sent":
          throw { status: 0, code: "network", message: "Gloam's relay didn't answer.", maybeSent: true };
        case "hang-landed":
          chain.land(b);
          return new Promise<string>(() => {}); // the tab closes here
        case "hang-not-sent":
          return new Promise<string>(() => {});
      }
    },
    async release() {
      releases++;
    },
    async confirm(sig) {
      const b = chain.builds.find((x) => x.sig === sig)!;
      const mode = confirmModes.shift() ?? "ok";
      if (mode === "timeout") throw new Error("CLIENT_RPC signature not confirmed");
      if (mode === "failed-on-chain") {
        // it reached Solana and failed: nothing moved
        b.failed = true;
        if (b.landed) throw new Error("test setup: a failed batch can't have landed");
        throw new Error("CLIENT_RPC transaction failed");
      }
      assert.ok(b.landed, "confirmed only what landed");
    },
    async resolve(f: Inflight): Promise<InflightResult> {
      const b = chain.builds.find((x) => x.blockhash === f.blockhash)!;
      if (f.signature && b.failed) return { state: "failed", message: "That batch failed on Solana, so nobody in it was paid. Resume to try again." };
      if (b.landed) return { state: "landed", ...(f.signature ? { signature: f.signature } : { signature: b.sig }) };
      const left = validLeft.get(f.blockhash) ?? sc.validFor ?? 0;
      if (left > 0) {
        validLeft.set(f.blockhash, left - 1);
        return { state: "pending" };
      }
      if (sc.unknown) return { state: "unknown" };
      return { state: "dropped" };
    },
    message: (e) => (e instanceof Error ? e.message : String(e)),
    tooBig: (e) => ((e as { causeCodes?: string[] }).causeCodes ?? []).includes("INTERFACE_TRANSACTION_TOO_LARGE"),
    async sleep(ms) {
      sleeps.push(ms);
      now += ms;
    },
    now: () => now,
    stopRequested: () => stop,
  };
  return {
    deps,
    sleeps,
    sendTimes,
    saved,
    get releases() {
      return releases;
    },
    resume() {
      stop = false;
    },
    tick(ms: number) {
      now += ms;
    },
  };
}

function draft(n: number, bad = 0) {
  const lines = ["name,address,amount"];
  for (let i = 0; i < n; i++) lines.push(`Person ${i},${addr(i + 10)},${i + 1}`);
  for (let i = 0; i < bad; i++) lines.push(`Bad ${i},nope,1`);
  return P.parseSolanaPayrollCsv(lines.join("\n"), USDC).rows;
}
const mkRun = (n: number, bad = 0) => P.newRun({ id: "run-1", network: "devnet", owner: OWNER, asset: "usdc", rows: draft(n, bad), now: 1 });
const expected = (run: PayrollRun) =>
  new Map(run.rows.filter((r) => r.status !== "skipped").map((r) => [r.address, BigInt(r.amount)] as const));
const paidOnce = (chain: ReturnType<typeof fakeChain>, run: PayrollRun, label: string) => {
  eq(chain.ledger, expected(run), `${label}: everyone paid exactly once`);
  ok(chain.builds.every((b) => !(b.landed && b.failed)), `${label}: nothing both landed and failed`);
};

// A. 20 people and 2 bad rows: batches of 15 and 5, paced.
{
  const chain = fakeChain();
  const h = harness(chain);
  const run = mkRun(20, 2);
  eq(run.rows.filter((r) => r.status === "skipped").length, 2, "bad rows go in the run as skipped");
  const out = await P.runPayroll(run, h.deps);
  eq(out.state, "done", "A: done");
  eq(chain.sends.length, 2, "A: 20 people in two transactions");
  eq(chain.builds.map((b) => b.payments.length), [15, 5], "A: 15 then 5");
  paidOnce(chain, out, "A");
  ok(out.rows.filter((r) => r.status === "paid").every((r) => r.signature === "sig0" || r.signature === "sig1"), "A: each paid row has its transaction");
  ok(out.rows.filter((r) => r.status === "skipped").every((r) => !r.signature && r.reason), "A: skipped rows keep their reason, no transaction");
  ok(h.sendTimes[1]! - h.sendTimes[0]! >= P.RELAY_MIN_GAP_MS, "A: sends are at least the gap apart");
  eq(out.inflight, null, "A: nothing left in flight");
  eq(h.saved.at(-1)!.state, "done", "A: the stored run is done");
  eq(P.runCounts(out), { paid: 20, toPay: 0, skipped: 2, unknown: 0, paidAmount: 210_000_000n, total: 210_000_000n }, "A: counts");
  ok(!P.runOpen(out), "A: finished");
}

// B. 429 twice, then it goes through.
{
  const chain = fakeChain();
  const h = harness(chain, { send: ["429", "429", "ok"] });
  const out = await P.runPayroll(mkRun(3), h.deps);
  eq(out.state, "done", "B: done after two 429s");
  eq(chain.sends.length, 3, "B: sent three times, landed once");
  paidOnce(chain, out, "B");
  eq(h.releases, 2, "B: each refusal frees its notes");
  ok(h.sleeps.some((s) => s >= 1_500 && s <= 61_500), "B: waited for the next minute");
  ok(h.sleeps.some((s) => s >= 31_500), "B: the second 429 waits longer");
}

// C. A refusal that sent nothing stops the run; resume pays.
{
  const chain = fakeChain();
  const h = harness(chain, { send: ["422"] });
  const run = mkRun(4);
  const out = await P.runPayroll(run, h.deps);
  eq(out.state, "paused", "C: paused on a refusal");
  ok(out.error?.includes("would fail"), "C: the relay's words are shown");
  eq(chain.ledger.size, 0, "C: nobody paid");
  ok(out.rows.every((r) => r.status === "queued"), "C: rows wait to be paid");
  eq(out.inflight, null, "C: nothing in flight");
  const again = await P.runPayroll(out, h.deps);
  eq(again.state, "done", "C: resume pays");
  paidOnce(chain, again, "C");
}

// D. Too large for one transaction: halve and build again, nothing sent meanwhile.
{
  const chain = fakeChain();
  const h = harness(chain, { tooBigOver: 7 });
  const out = await P.runPayroll(mkRun(20), h.deps);
  eq(out.state, "done", "D: done");
  eq(chain.builds.map((b) => b.payments.length), [7, 7, 6], "D: 15 is too large, 7 fits");
  paidOnce(chain, out, "D");
}

// E. The tab closes after the relay sent a batch (no signature saved): resume finds it landed.
{
  const chain = fakeChain();
  const h = harness(chain, { send: ["hang-landed"] });
  void P.runPayroll(mkRun(18), h.deps); // never settles: the tab is gone
  await new Promise((r) => setTimeout(r, 20));
  const stored = h.saved.at(-1)!;
  ok(stored.inflight && !stored.inflight.signature, "E: stored with its batch in flight, no signature");
  const h2 = harness(chain);
  const out = await P.runPayroll(JSON.parse(JSON.stringify(stored)) as PayrollRun, h2.deps);
  eq(out.state, "done", "E: resumed to the end");
  eq(chain.sends.length, 2, "E: the landed batch was not sent again");
  paidOnce(chain, out, "E");
  ok(out.rows.slice(0, 15).every((r) => r.status === "paid" && r.signature === "sig0"), "E: its rows are paid, with the transaction found by their notes");
}

// F. The tab closes before the relay sent it: resume waits for its blockhash to expire, then sends it again.
{
  const chain = fakeChain();
  const h = harness(chain, { send: ["hang-not-sent"] });
  void P.runPayroll(mkRun(5), h.deps);
  await new Promise((r) => setTimeout(r, 20));
  const stored = h.saved.at(-1)!;
  const h2 = harness(chain, { validFor: 3 });
  const out = await P.runPayroll(JSON.parse(JSON.stringify(stored)) as PayrollRun, h2.deps);
  eq(out.state, "done", "F: done");
  eq(h2.sleeps.filter((s) => s === P.INFLIGHT_POLL_MS).length, 3, "F: checked again while it could still land");
  eq(chain.builds.length, 2, "F: built again only after it could no longer land");
  paidOnce(chain, out, "F");
}

// G. The relay's answer is lost after it sent: settled by its notes, not sent again.
{
  const chain = fakeChain();
  const h = harness(chain, { send: ["lost-landed"] });
  const out = await P.runPayroll(mkRun(16), h.deps);
  eq(out.state, "done", "G: done");
  eq(chain.sends.length, 2, "G: 15 then 1, the first never sent twice");
  paidOnce(chain, out, "G");
  eq(h.releases, 0, "G: notes that may be spent are never freed early");
}

// G2. Lost answer and it never got sent: dropped, sent again once.
{
  const chain = fakeChain();
  const h = harness(chain, { send: ["lost-not-sent"], validFor: 1 });
  const out = await P.runPayroll(mkRun(2), h.deps);
  eq(out.state, "done", "G2: done");
  eq(chain.sends.length, 2, "G2: sent again after it was dropped");
  paidOnce(chain, out, "G2");
}

// G3. Solana never says (an in-flight batch stays pending): the run pauses at the deadline, the batch
// still in flight, and a resume settles it before anything else is sent. Never an endless wait.
{
  const chain = fakeChain();
  const h = harness(chain, { send: ["lost-not-sent"], validFor: 1_000_000 });
  const out = await P.runPayroll(mkRun(2), h.deps);
  eq(out.state, "paused", "G3: paused, not waiting forever");
  eq(out.error, P.BATCH_STILL_CHECKING, "G3: says Solana hasn't answered yet");
  ok(out.inflight !== null && out.rows.every((r) => r.status === "checking"), "G3: the batch stays in flight, never sent again blind");
  const waited = h.sleeps.filter((x) => x === P.INFLIGHT_POLL_MS).length * P.INFLIGHT_POLL_MS;
  ok(waited >= P.INFLIGHT_MAX_MS && waited < P.INFLIGHT_MAX_MS + 2 * P.INFLIGHT_POLL_MS, `G3: stopped at the deadline (${waited} ms of checks)`);
  eq(chain.sends.length, 1, "G3: sent once");
  const h2 = harness(chain, { validFor: 0 });
  const done = await P.runPayroll(JSON.parse(JSON.stringify(out)) as PayrollRun, h2.deps);
  eq(done.state, "done", "G3: resumed, settled as dropped, paid");
  eq(chain.sends.length, 2, "G3: sent again only once it could no longer land");
  paidOnce(chain, done, "G3");
}

// H. Confirmation timed out but it landed: asked by signature, paid once.
{
  const chain = fakeChain();
  const h = harness(chain, { confirm: ["timeout"] });
  const out = await P.runPayroll(mkRun(3), h.deps);
  eq(out.state, "done", "H: done");
  eq(chain.sends.length, 1, "H: not sent again");
  paidOnce(chain, out, "H");
}

// I. It failed on chain: nobody in it paid, the run stops and says so; resume pays.
{
  const chain = fakeChain();
  // a batch that reaches Solana and fails there: the relay returned its signature, it never landed
  const h1 = harness(chain, {});
  h1.deps.send = async (wire) => {
    const b = chain.byWire(wire);
    chain.sends.push(b.id);
    return b.sig;
  };
  h1.deps.confirm = async (sig) => {
    chain.builds.find((x) => x.sig === sig)!.failed = true;
    throw new Error("CLIENT_RPC transaction failed");
  };
  const out = await P.runPayroll(mkRun(3), h1.deps);
  eq(out.state, "paused", "I: paused");
  ok(out.error?.includes("failed on Solana"), "I: says it failed on Solana");
  ok(out.rows.every((r) => r.status === "queued" && !r.signature), "I: rows wait again, no transaction kept");
  eq(chain.ledger.size, 0, "I: nobody paid");
  const again = await P.runPayroll(out, harness(chain).deps);
  eq(again.state, "done", "I: resume pays");
  paidOnce(chain, again, "I");
}

// J. Pause after this batch, then resume.
{
  const chain = fakeChain();
  const h = harness(chain, { stopAfterSends: 1 });
  const out = await P.runPayroll(mkRun(20), h.deps);
  eq(out.state, "paused", "J: paused when asked");
  eq(out.rows.filter((r) => r.status === "paid").length, 15, "J: after the batch it was on");
  ok(P.runOpen(out), "J: still open");
  h.resume();
  const again = await P.runPayroll(out, h.deps);
  eq(again.state, "done", "J: resume finishes");
  paidOnce(chain, again, "J");
}

// K. The save before a send fails: nothing sent.
{
  const chain = fakeChain();
  const h = harness(chain, { saveFailsAt: 2 }); // 1: running, 2: in flight
  const out = await P.runPayroll(mkRun(3), h.deps);
  eq(out.state, "paused", "K: paused");
  eq(out.error, P.SAVE_FAILED, "K: says the run couldn't be saved");
  eq(chain.sends.length, 0, "K: nothing sent");
  eq(h.releases, 1, "K: its notes are freed");
  eq(out.inflight, null, "K: nothing in flight");
}

// L. Can't tell: those rows are never sent again, the rest are paid.
{
  const chain = fakeChain();
  const h = harness(chain, { send: ["lost-not-sent"], unknown: true });
  const out = await P.runPayroll(mkRun(17), h.deps);
  eq(out.state, "done", "L: done");
  eq(out.rows.filter((r) => r.status === "unknown").length, 15, "L: the unsure batch is marked");
  eq(out.rows.filter((r) => r.status === "paid").length, 2, "L: the rest are paid");
  eq(chain.sends.length, 2, "L: the unsure batch is not sent again");
  eq(P.runCounts(out).unknown, 15, "L: counted");
}

// M. Dropped twice in a row: stop and say so.
{
  const chain = fakeChain();
  const h = harness(chain, { send: ["lost-not-sent", "lost-not-sent"] });
  const out = await P.runPayroll(mkRun(2), h.deps);
  eq(out.state, "paused", "M: paused");
  eq(out.error, P.BATCH_DROPPED, "M: says the batch didn't land");
  eq(chain.ledger.size, 0, "M: nobody paid");
  ok(out.rows.every((r) => r.status === "queued"), "M: rows wait again");
}

// N. The relay stays at its limit: the run pauses itself, nothing paid twice.
{
  const chain = fakeChain();
  const h = harness(chain, { send: Array(P.RELAY_LIMITED_TRIES + 1).fill("429") as SendMode[] });
  const out = await P.runPayroll(mkRun(2), h.deps);
  eq(out.state, "paused", "N: paused");
  eq(out.error, P.RELAY_BUSY, "N: says the relay is at its limit");
  eq(chain.sends.length, P.RELAY_LIMITED_TRIES + 1, "N: tried, then stopped");
}

// O. A build error that isn't about size stops the run with its words.
{
  const chain = fakeChain();
  const h = harness(chain, { buildError: new Error("Your private balance is too low for that.") });
  const out = await P.runPayroll(mkRun(2), h.deps);
  eq([out.state, out.error], ["paused", "Your private balance is too low for that."], "O: stops and shows it");
  eq(chain.sends.length, 0, "O: nothing sent");
}

// Every send above (but scenario I's, which swaps the relay out) went out with its batch stored in flight first.
ok(savedBeforeSend >= 30, `the run was stored in flight before each of ${savedBeforeSend} sends`);

// ------------------------------------------------------------------ close, counts, results, isRun

{
  const run = mkRun(3, 1);
  run.rows[0]!.status = "paid";
  run.rows[0]!.signature = "5sig";
  run.rows[1]!.name = "=HYPERLINK(\"https://evil\")";
  const closed = P.closeRun(run);
  eq(closed.rows.map((r) => r.status), ["paid", "not_paid", "not_paid", "skipped"], "closing marks the rest not paid");
  eq(closed.state, "done", "a closed run is done");
  assert.throws(() => P.closeRun({ ...run, inflight: { rows: [1], nullifiers: ["aa"], blockhash: "bh", at: 1 } }), /may still land/);
  checks++;
  const csv = P.resultsCsv(closed, USDC).split("\n");
  eq(csv[0], "row,name,address,amount,asset,status,signature,reason", "the CSV header");
  eq(csv[1], `2,Person 0,${addr(10)},1,USDC,paid,5sig,`, "a paid row");
  ok(csv[2]!.startsWith(`3,"'=HYPERLINK(""https://evil"")"`), "a formula name is defused");
  ok(csv[4]!.includes(",skipped,,") && csv[4]!.includes("Not a Solana address"), "a skipped row has its reason");
  eq(P.formatUnits(1_500_000_000n, 9), "1.5", "exact units");
  eq(P.formatUnits(7n, 6), "0.000007", "small amounts stay exact");
  ok(P.isRun(closed) && P.isRun(mkRun(2)), "runs read back");
  ok(!P.isRun({ ...mkRun(2), v: 2 }) && !P.isRun(null) && !P.isRun({ ...mkRun(2), rows: [{ address: "x", amount: "1e9", status: "paid" }] }), "anything else is refused");
  ok(!P.isRun({ ...mkRun(2), inflight: { rows: [9], nullifiers: [], blockhash: "x", at: 1 } }), "an in-flight batch naming rows the run doesn't have is refused");
}

// ------------------------------------------------------------------ copy

for (const s of [RINGS_PAYROLL_NOTE, P.NOT_SET_UP, P.OWN_ACCOUNT, P.RELAY_BUSY, P.SAVE_FAILED, P.BATCH_DROPPED]) {
  ok(!/[—–]/.test(s) && !/happy to/i.test(s), `plain copy: ${s.slice(0, 32)}`);
}
ok(RINGS_PAYROLL_NOTE.startsWith("On Solana,") && RINGS_PRIVACY_NOTE.startsWith("On Solana,"), "payroll says what is public the way every Solana screen does");
eq(ringsExplorerTx("abc", "devnet"), "https://solscan.io/tx/abc?cluster=devnet", "devnet explorer link");
eq(ringsExplorerTx("abc", "mainnet"), "https://solscan.io/tx/abc", "mainnet explorer link");

// ------------------------------------------------------------------ the store

{
  const mem = new Map<string, string>();
  const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
  const cipher = (tag: string) => ({
    seal: async (p: string) => `${tag}:${Buffer.from(p).toString("base64")}`,
    open: async (s: string) => {
      if (!s.startsWith(`${tag}:`)) throw new Error("wrong key");
      return Buffer.from(s.slice(tag.length + 1), "base64").toString();
    },
  });
  const key = S.payrollStoreKey("devnet", OWNER);
  eq(key, `gloam:solana-payroll:v1:devnet:${OWNER}`, "one list per network and private account");
  const store = S.payrollStore({ key, cipher: cipher("k1"), storage });
  eq(await store.load(), [], "empty at first");
  const r1 = mkRun(2);
  await store.save(r1);
  ok(!mem.get(key)!.includes(r1.rows[0]!.address), "stored sealed: no address in the clear");
  eq((await store.load())[0], r1, "a run reads back");
  await store.save({ ...r1, state: "running" });
  eq((await store.load()).length, 1, "saving a run replaces it");
  for (let i = 0; i < 14; i++) await store.save(P.closeRun({ ...mkRun(1), id: `done-${i}`, createdAt: 10 + i }));
  const all = await store.load();
  eq(all.length, 11, "ten finished runs are kept, besides the open one");
  ok(all.some((r) => r.id === r1.id), "an open run is never dropped, however old");
  eq(all[0]!.id, "done-13", "newest first");

  // another key can't open it: set aside, not written over
  const other = S.payrollStore({ key, cipher: cipher("k2"), storage });
  eq(await other.load(), [], "a list another account sealed reads as empty");
  ok(mem.get(`${key}:unreadable`)?.startsWith("k1:"), "and is kept aside before anything writes over it");
  // a balance snapshot under the same key never reads as runs
  const snap = S.payrollStore({ key: "snap", cipher: cipher("k1"), storage });
  mem.set("snap", await cipher("k1").seal(JSON.stringify([r1])));
  eq(await snap.load(), [], "sealed text without the payroll domain line is not a run");

  // a write that doesn't stick throws (so the engine sends nothing)
  const full = S.payrollStore({ key: "full", cipher: cipher("k1"), storage: { getItem: () => null, setItem: () => { throw new Error("QuotaExceededError"); } } });
  await assert.rejects(full.save(r1), /Quota/);
  const liar = S.payrollStore({ key: "liar", cipher: cipher("k1"), storage: { getItem: () => null, setItem: () => undefined } });
  await assert.rejects(liar.save(r1), /didn't save/);
  checks += 2;

  // the real cipher: its own key from the viewing secret, bound to the account
  const secret = Uint8Array.from({ length: 32 }, (_, i) => i * 3 + 1);
  const c1 = await S.runCipher(secret, OWNER);
  // The marker has a space and a "|", which sealed text (base64 and dots) never holds, so
  // finding it there can only mean the plaintext leaked. Random base64 is no good for this:
  // it holds "xxxx" by chance in about 2% of runs.
  const MARK = "in the clear | ";
  const big = MARK.repeat(20_000);
  const sealedBig = await c1.seal(big);
  eq(await c1.open(sealedBig), big, "a large list seals and opens");
  const [, ivB64, bodyB64] = sealedBig.split(".");
  const body = Buffer.from(bodyB64!, "base64");
  ok(sealedBig.startsWith("gsp1.") && !sealedBig.includes(MARK), "sealed, nothing in the clear");
  // nor merely base64'd: the decoded body is the plaintext plus a 16-byte tag, with no run of it
  ok(Buffer.from(ivB64!, "base64").length === 12 && body.length === big.length + 16 && !body.includes(Buffer.from(MARK)), "the body is ciphertext, not the plaintext encoded");
  ok((await c1.seal("same")) !== (await c1.seal("same")), "a fresh nonce each time");
  await assert.rejects((await S.runCipher(secret, addr(5))).open(await c1.seal("hi")), "another account's address can't open it");
  await assert.rejects((await S.runCipher(Uint8Array.from(secret, (b) => b ^ 1), OWNER)).open(await c1.seal("hi")), "another secret can't open it");
  // Flip one bit of the ciphertext itself. Swapping in a base64 letter can leave the bytes as
  // they were: the letter it put in was already there in about 1 run in 64.
  const flipped = Buffer.from(body);
  flipped[100] ^= 1;
  const tampered = `gsp1.${ivB64}.${flipped.toString("base64")}`;
  ok(tampered !== sealedBig, "the tampered list really differs");
  await assert.rejects(c1.open(tampered), "a changed byte fails to open");
  checks += 3;
  const real = S.payrollStore({ key: "real", cipher: c1, storage });
  await real.save(r1);
  eq((await real.load())[0], r1, "the store works with the real cipher");

  // one tab pays at a time
  const locks = (globalThis.navigator as { locks?: unknown } | undefined)?.locks;
  if (locks) {
    let release!: () => void;
    const first = S.withRunLock(OWNER, () => new Promise<void>((r) => (release = r)));
    await new Promise((r) => setTimeout(r, 10));
    eq(await S.withRunLock(OWNER, async () => undefined), false, "a second tab can't pay the same account's run");
    release();
    eq(await first, true, "the first tab paid");
    eq(await S.withRunLock(OWNER, async () => undefined), true, "free again after");
  } else {
    eq(await S.withRunLock(OWNER, async () => undefined), true, "without Web Locks it just runs");
  }
}

// ------------------------------------------------------------------ the relay client

{
  const store = new Map<string, string>();
  Object.assign(globalThis, {
    location: { origin: "http://localhost:3999" },
    localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) },
  });
  const C = await import("../src/lib/solanaRings/client");
  const realFetch = globalThis.fetch;
  const answer = (status: number, body: unknown) => async () =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const cases: [string, () => Promise<Response>, boolean | null][] = [
    ["200 with a signature", answer(200, { ok: true, signature: "5sig" }), null],
    ["429 rate limited", answer(429, { ok: false, error: { code: "rate_limited", message: "Too many requests." } }), false],
    ["422 would fail", answer(422, { ok: false, error: { code: "would_fail", message: "x" } }), false],
    ["403 screened", answer(403, { ok: false, error: { code: "screened", message: "x" } }), false],
    ["503 relay empty", answer(503, { ok: false, error: { code: "relay_empty", message: "x" } }), false],
    ["503 relay unavailable", answer(503, { ok: false, error: { code: "relay_unavailable", message: "x" } }), false],
    ["502 check run failed", answer(502, { ok: false, error: { code: "simulate_failed", message: "x" } }), false],
    ["502 send failed", answer(502, { ok: false, error: { code: "send_failed", message: "x" } }), true],
    ["502 upstream", answer(502, { ok: false, error: { code: "upstream_unavailable", message: "x" } }), true],
    ["504 timeout page", answer(504, "<html>timeout</html>"), true],
    ["no answer", async () => {
      throw new TypeError("fetch failed");
    }, true],
  ];
  for (const [label, fake, maybeSent] of cases) {
    globalThis.fetch = fake as typeof fetch;
    try {
      const sig = await C.sendPayments(new Uint8Array([1, 2, 3]));
      eq([label, sig], [label, "5sig"], "the relay's signature comes back");
      ok(maybeSent === null, `${label}: accepted`);
    } catch (e) {
      ok(e instanceof C.RingsRelayError, `${label}: a RingsRelayError`);
      eq([label, (e as InstanceType<typeof C.RingsRelayError>).maybeSent], [label, maybeSent], `${label}: may it have been sent`);
      ok(P.isRelayRefusal(e), `${label}: the engine reads it as a relay refusal`);
    }
  }
  globalThis.fetch = realFetch;

  const wrapped = Object.assign(new Error("WALLET_BUILD_TRANSFER"), { code: "WALLET_BUILD_TRANSFER", causeCode: "WALLET_INSUFFICIENT_BALANCE", causeCodes: ["WALLET_INSUFFICIENT_BALANCE"] });
  eq(C.ringsErrorMessage(wrapped), "Your private balance is too low for that.", "a wrapped SDK code still gets plain words");
  const deep = Object.assign(new Error("WALLET_BUILD_TRANSFER"), { code: "WALLET_BUILD_TRANSFER", cause: { code: "X", cause: { code: "INTERFACE_TRANSACTION_TOO_LARGE" } } });
  ok(C.paymentsTooBig(deep), "too large, found down the cause chain");
  ok(C.paymentsTooBig({ code: "WALLET_CREATE_TRANSFER", causeCodes: ["WALLET_TOO_MANY_INPUTS"] }), "too many inputs: fewer people per transaction");
  ok(!C.paymentsTooBig(wrapped), "a low balance is not about size");
  eq(C.ringsErrorMessage(new C.RingsRelayError("Too many requests.", 429, "rate_limited", false)), "Too many requests.", "the relay's words are kept");
}

console.log(`selftest-solana-payroll (claim links ${LINKS ? "on" : "off"}): ${checks} checks passed`);
process.exit(0);
