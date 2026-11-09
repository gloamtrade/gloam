/**
 * Payroll total verifier, in node: real Groth16 proofs from the shipped
 * payroll_total artifacts, checked by the same checkPayrollProof the /verify
 * page runs, against a pretend chain (receipts keyed by tx hash, decoded the
 * way viem's parseEventLogs returns them).
 *
 *   pnpm --filter @gloamtrade/sdk build      # the test uses the SDK's dist
 *   cd app && node src/lib/proofs/payrollCheck.selftest.mjs
 *
 * payrollCheck.ts is transpiled on the fly with the app's TypeScript (it only
 * imports @gloamtrade/sdk at runtime, which is pointed at the SDK's dist).
 */
import { mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { fileURLToPath, pathToFileURL } from "url";
import ts from "typescript";
import * as snarkjs from "snarkjs";

const here = dirname(fileURLToPath(import.meta.url));
const appDir = join(here, "../../..");
const sdkDist = join(appDir, "../packages/sdk/dist/index.js");
const circuits = join(appDir, "public/circuits");

const sdk = await import(pathToFileURL(sdkDist).href);
const {
  buildPayrollWitness,
  fieldToHex,
  noteCommitmentPoseidon,
  noteNullifierPoseidon,
  proofContext,
} = sdk;

// ── load the checker (and the sibling modules it imports) ──
const tmp = mkdtempSync(join(tmpdir(), "gloam-payroll-check-"));
for (const file of ["label.ts", "types.ts", "payrollCheck.ts"]) {
  const js = ts
    .transpileModule(readFileSync(join(here, file), "utf8"), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } })
    .outputText.replace(/from "@gloamtrade\/sdk"/g, `from ${JSON.stringify(pathToFileURL(sdkDist).href)}`)
    .replace(/from "\.\/([^"]+)"/g, (_, name) => `from ${JSON.stringify(pathToFileURL(join(tmp, name + ".mjs")).href)}`);
  writeFileSync(join(tmp, file.replace(/\.ts$/, ".mjs")), js);
}
const { checkPayrollProof, classifyPaymentLogs } = await import(pathToFileURL(join(tmp, "payrollCheck.mjs")).href);

let checks = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exit(1);
  }
  checks++;
}

const POOL = "0x841dc046ea3cc842ba3a855731472c6eb0f2d5eb";
const OTHER_POOL = "0x72406d9597807a46f730d8b4fdbc5ac45dc1d740";
const USD = "0x20c0000000000000000000000000000000000000";
const CHAIN = 42431;
const NOW = 1_800_000_000;
const EXPIRES = NOW + 30 * 86400;
const VERIFIER = "My accountant";
const vkey = JSON.parse(readFileSync(join(circuits, "payroll_total_vkey.json"), "utf8"));

// ── classifier ──
{
  const c = "0x" + "aa".repeat(32);
  const n = "0x" + "bb".repeat(32);
  const ch = "0x" + "cc".repeat(32);
  const t = (args, address = POOL) => ({ eventName: "Transferred", address, args });
  assert(classifyPaymentLogs([t({ nullifier: n, newCommitments: [c, ch] })], POOL, c, n) === "found", "payment slot is found");
  assert(classifyPaymentLogs([t({ nullifier: n, newCommitments: [c.toUpperCase().replace("0X", "0x"), ch] })], POOL, c, n) === "found", "hex case does not matter");
  assert(classifyPaymentLogs([t({ nullifier: n, newCommitments: [ch, c] })], POOL, c, n) === "change", "change slot is not a payment");
  assert(classifyPaymentLogs([t({ nullifier: ch, newCommitments: [c, n] })], POOL, c, n) === "mismatch", "another spend's payment does not count");
  assert(classifyPaymentLogs([t({ nullifier: n, newCommitments: [c, ch] }, OTHER_POOL)], POOL, c, n) === "mismatch", "another vault's event does not count");
  assert(
    classifyPaymentLogs([{ eventName: "Shielded", address: POOL, args: { commitment: c } }], POOL, c, n) === "deposit",
    "a deposit is a deposit"
  );
  assert(
    classifyPaymentLogs([{ eventName: "SealedSwapped", address: POOL, args: { newCommitmentOut: c } }], POOL, c, n) === "trade",
    "a trade output is a trade"
  );
  assert(classifyPaymentLogs([], POOL, c, n) === "mismatch", "no events is a mismatch");
}

// ── a run of five, and a pretend chain that holds it ──
const chain = new Map(); // txHash -> { logs, paidAt }
let nextTx = 1n;
const txHash = () => fieldToHex(nextTx++);
const rand = (i) => 10_000n + BigInt(i);

async function payment(i, amount, { slot = 0, shield = false } = {}) {
  const secret = rand(i);
  const spendSecret = rand(1000 + i);
  const spendAmount = amount * 3n;
  const commitment = fieldToHex(await noteCommitmentPoseidon(secret, amount, USD));
  const nullifier = fieldToHex(await noteNullifierPoseidon(spendSecret, await noteCommitmentPoseidon(spendSecret, spendAmount, USD)));
  const change = fieldToHex(BigInt(commitment) ^ 1n);
  const hash = txHash();
  const logs = shield
    ? [{ eventName: "Shielded", address: POOL, args: { commitment, asset: USD } }]
    : [{ eventName: "Transferred", address: POOL, args: { nullifier, newCommitments: slot === 0 ? [commitment, change] : [change, commitment] } }];
  chain.set(hash, { logs, paidAt: NOW - 7200 + i * 9 });
  return { secret: fieldToHex(secret), amount, commitment, spendSecret: fieldToHex(spendSecret), spendAmount, nullifier, txHash: hash };
}

const run = [];
for (const [i, amt] of [6000n, 4800n, 4200n, 3600n, 2900n].entries()) run.push(await payment(i, amt * 1_000_000n));

/** Prove one part per slice, the way provePayrollTotal does (slices given, not balanced). */
async function makeProof(slices, { verifier = VERIFIER, expiresAt = EXPIRES } = {}) {
  const context = proofContext({ kind: "payroll", chainId: CHAIN, pool: POOL, verifier, expiresAt });
  const parts = [];
  const payments = [];
  for (const slice of slices) {
    const w = await buildPayrollWitness({
      asset: USD,
      context,
      payments: slice.map((p) => ({ secretHex: p.secret, amount: p.amount, spendSecretHex: p.spendSecret, spendAmount: p.spendAmount })),
    });
    assert(w.blocker === null, `witness ready: ${w.blocker}`);
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(
      w.circomInput,
      join(circuits, "payroll_total.wasm"),
      join(circuits, "payroll_total_final.zkey")
    );
    parts.push({ proof, publicSignals });
    for (const p of slice) payments.push({ commitment: p.commitment, nullifier: p.nullifier, txHash: p.txHash });
  }
  const all = slices.flat();
  return {
    v: 1,
    kind: "payroll",
    chainId: CHAIN,
    pool: POOL,
    verifier,
    expiresAt,
    asset: USD,
    total: all.reduce((s, p) => s + p.amount, 0n).toString(),
    count: all.length,
    payments,
    parts,
  };
}

const when = (unix) => new Date(unix * 1000).toISOString();
function deps(over = {}) {
  return {
    verifySnark: (part) => snarkjs.groth16.verify(vkey, part.publicSignals, part.proof),
    vault: { label: "Tempo" },
    findPayment: async (pay) => {
      const tx = pay.txHash && chain.get(pay.txHash);
      if (!tx) return { state: "not-found" };
      const v = classifyPaymentLogs(tx.logs, POOL, pay.commitment, pay.nullifier);
      if (v === "found") return { state: "found", txHash: pay.txHash, paidAt: tx.paidAt };
      if (v === "deposit" || v === "trade") return { state: "wrong-origin", origin: v };
      return { state: v };
    },
    now: NOW,
    when,
    ...over,
  };
}
const clone = (p) => JSON.parse(JSON.stringify(p));
const stateOf = (r, label) => r.checks.find((c) => c.label.startsWith(label))?.state;
const detailOf = (r, label) => r.checks.find((c) => c.label.startsWith(label))?.detail ?? "";

// ── valid ──
const good = await makeProof([run]);
{
  const r = await checkPayrollProof(good, deps());
  assert(r.ok, `valid proof passes: ${JSON.stringify(r.checks.filter((c) => c.state !== "pass"))}`);
  assert(r.kind === "payroll" && !r.expired, "kind and not expired");
  assert(r.checks.every((c) => c.state === "pass"), "every check passes");
  assert(good.total === "21500000000" && good.count === 5, "21,500 USDG in 5 payments");
  assert(r.paidBetween?.[0] === NOW - 7200 && r.paidBetween?.[1] === NOW - 7200 + 36, "time span of the run");
  assert(r.checks.some((c) => c.label === 'Made for "My accountant"'), "names who it is for");
}

// ── tampered total ──
{
  const p = clone(good);
  p.total = (BigInt(p.total) + 1_000_000n).toString();
  const r = await checkPayrollProof(p, deps());
  assert(!r.ok && stateOf(r, "Total and count") === "fail", "tampered plain total fails");
}
{
  const p = clone(good);
  p.parts[0].publicSignals[1] = (BigInt(p.parts[0].publicSignals[1]) + 1_000_000n).toString();
  p.total = p.parts[0].publicSignals[1];
  const r = await checkPayrollProof(p, deps());
  assert(!r.ok && stateOf(r, "The proof checks out") === "fail", "tampered total signal fails the snark");
}
{
  const p = clone(good);
  p.count = 6;
  const r = await checkPayrollProof(p, deps());
  assert(!r.ok && stateOf(r, "Total and count") === "fail", "tampered count fails");
}

// ── swapped commitment / reordered list / dropped payment ──
{
  const outsider = await payment(77, 9_999_000_000n);
  const p = clone(good);
  p.payments[2] = { commitment: outsider.commitment, nullifier: outsider.nullifier, txHash: outsider.txHash };
  const r = await checkPayrollProof(p, deps());
  assert(!r.ok && stateOf(r, "Total and count") === "fail", "swapped commitment fails the list hash");
}
{
  const p = clone(good);
  [p.payments[0], p.payments[1]] = [p.payments[1], p.payments[0]];
  const r = await checkPayrollProof(p, deps());
  assert(!r.ok && stateOf(r, "Total and count") === "fail", "reordered payments fail the list hash");
}
{
  const p = clone(good);
  p.payments.pop();
  p.count = 4;
  const r = await checkPayrollProof(p, deps());
  assert(!r.ok && stateOf(r, "Total and count") === "fail", "dropped payment fails");
}

// ── a deposit passed off as a payment ──
{
  // The prover deposited this note (knows its secret) and pairs it with a spend of their own:
  // the circuit cannot tell, the vault can.
  const dep = await payment(40, 5_000_000_000n, { shield: true });
  const p = await makeProof([[run[0], run[1], dep]]);
  const r = await checkPayrollProof(p, deps());
  assert(stateOf(r, "The proof checks out") === "pass", "deposit proof is valid math");
  assert(!r.ok && stateOf(r, "Each one is a private payment") === "fail", "deposit-created commitment is rejected");
  assert(/deposit/.test(detailOf(r, "Each one is a private payment")), "says it was a deposit");
}
{
  // Pointing the deposit at a real payroll transaction instead.
  const dep = await payment(41, 5_000_000_000n, { shield: true });
  const p = await makeProof([[run[0], dep]]);
  p.payments[1].txHash = run[2].txHash;
  const r = await checkPayrollProof(p, deps());
  assert(!r.ok && /did not make that payment/.test(detailOf(r, "Each one is a private payment")), "deposit behind someone else's transaction is rejected");
}
{
  const chg = await payment(42, 1_000_000n, { slot: 1 });
  const p = await makeProof([[run[0], chg]]);
  const r = await checkPayrollProof(p, deps());
  assert(!r.ok && /change/.test(detailOf(r, "Each one is a private payment")), "change counted as a payment is rejected");
}

// ── the same payment in two parts ──
{
  const p = await makeProof([run.slice(0, 3), run.slice(2)]);
  assert(p.parts.length === 2 && p.count === 6, "two parts, payment 3 in both");
  const r = await checkPayrollProof(p, deps());
  assert(stateOf(r, "The proof checks out") === "pass" && stateOf(r, "Total and count") === "pass", "each part holds on its own");
  assert(!r.ok && stateOf(r, "No payment counted twice") === "fail", "a payment in two parts is caught");
}
{
  const p = await makeProof([run.slice(0, 3), run.slice(3)]);
  const r = await checkPayrollProof(p, deps());
  assert(r.ok && /All 2 parts/.test(detailOf(r, "The proof checks out")), "a two-part proof passes");
}

// ── expired, relabelled, wrong vault, offline ──
{
  let looked = 0;
  const r = await checkPayrollProof(good, deps({ now: EXPIRES + 1, findPayment: async () => { looked++; return { state: "not-found" }; } }));
  assert(!r.ok && r.expired && stateOf(r, "Expired") === "fail", "expired proof is not ok");
  assert(looked === 0 && stateOf(r, "Each one is a private payment") === "unknown", "an expired proof is not looked up on chain");
  assert(/expired/.test(detailOf(r, "Each one is a private payment")), "says why the payments were not looked up");
  assert(
    r.checks.filter((c) => c.label !== "Expired" && !c.label.startsWith("Each one is a private payment")).every((c) => c.state === "pass"),
    "expired but otherwise true"
  );
}
{
  const p = clone(good);
  p.verifier = "Someone else";
  const r = await checkPayrollProof(p, deps());
  assert(!r.ok && stateOf(r, "Made for") === "fail", "relabelled proof fails");
}
{
  const p = clone(good);
  p.expiresAt = EXPIRES + 86400;
  const r = await checkPayrollProof(p, deps());
  assert(!r.ok && stateOf(r, "Made for") === "fail", "extended expiry fails");
}
{
  const r = await checkPayrollProof(good, deps({ vault: null }));
  assert(!r.ok && stateOf(r, "Made on Gloam's vault") === "fail", "a vault that is not Gloam's fails");
}
{
  const r = await checkPayrollProof(good, deps({ findPayment: async () => { throw new Error("offline"); } }));
  assert(!r.ok && stateOf(r, "Each one is a private payment") === "unknown", "offline is not a pass");
}
{
  const p = clone(good);
  p.payments[4].txHash = fieldToHex(999_999n);
  const r = await checkPayrollProof(p, deps());
  assert(!r.ok && stateOf(r, "Each one is a private payment") === "unknown", "a payment not found is not a pass");
}
{
  const r = await checkPayrollProof(good, deps({ findPayment: async () => ({ state: "no-tx" }) }));
  assert(!r.ok && /not on this network/.test(detailOf(r, "Each one is a private payment")), "a named transaction missing from the chain fails");
}
{
  // Size caps come before any math or lookup.
  let looked = 0;
  const counting = deps({ findPayment: async () => { looked++; return { state: "not-found" }; }, verifySnark: async () => { looked++; return true; } });
  const p = clone(good);
  p.parts = Array.from({ length: 9 }, () => clone(good.parts[0]));
  const r = await checkPayrollProof(p, counting);
  assert(!r.ok && r.checks.length === 1 && looked === 0, "nine parts are refused before anything runs");
  const q = clone(good);
  q.payments = Array.from({ length: 257 }, () => clone(good.payments[0]));
  const r2 = await checkPayrollProof(q, counting);
  assert(!r2.ok && r2.checks.length === 1 && looked === 0, "257 payments are refused before anything runs");
}
{
  // Nothing is looked up for a proof that already failed.
  let looked = 0;
  const p = clone(good);
  p.parts[0].proof.pi_a[0] = "1";
  const r = await checkPayrollProof(p, deps({ findPayment: async () => { looked++; return { state: "not-found" }; } }));
  assert(!r.ok && looked === 0, "a broken proof triggers no lookups");
}
{
  const p = clone(good);
  p.parts[0].proof.pi_a[0] = "1";
  const r = await checkPayrollProof(p, deps());
  assert(!r.ok && stateOf(r, "The proof checks out") === "fail", "an edited proof fails");
}
{
  const p = clone(good);
  p.parts[0].publicSignals = p.parts[0].publicSignals.slice(0, 4);
  const r = await checkPayrollProof(p, deps());
  assert(!r.ok && r.checks.length === 1, "a damaged proof stops early");
}

// ── lookups stop at the first payment not found ──
{
  const long = [];
  for (let i = 0; i < 13; i++) long.push(await payment(500 + i, 1_000_000n + BigInt(i)));
  const p = await makeProof([long]);
  const honest = await checkPayrollProof(p, deps());
  assert(honest.ok, "a run of 13 passes");
  let looked = 0;
  const counting = (over) => deps({ findPayment: async (pay) => { looked++; return over(pay); } });
  const unnamed = clone(p);
  unnamed.payments[0].txHash = null;
  const r = await checkPayrollProof(unnamed, counting(async () => ({ state: "not-found" })));
  assert(!r.ok && stateOf(r, "Each one is a private payment") === "unknown", "a payment not found is not a pass");
  assert(looked === 6, `lookups stop after the first batch with a payment not found (${looked} of 13 looked up)`);
  looked = 0;
  const r2 = await checkPayrollProof(p, counting(async () => ({ state: "no-tx" })));
  assert(!r2.ok && stateOf(r2, "Each one is a private payment") === "fail" && looked === 6, "lookups stop after a payment that fails");
}

// ── a group looked up in one call, two block times read ──
{
  let calls = 0;
  let timed = 0;
  const grouped = deps({
    findPayment: undefined,
    findPayments: async (pays) => {
      calls++;
      return pays.map((pay, i) => ({ state: "found", txHash: pay.txHash, block: 100n + BigInt(i) }));
    },
    blockTime: async (b) => {
      timed++;
      return NOW - 7200 + Number(b - 100n) * 9;
    },
  });
  const r = await checkPayrollProof(good, grouped);
  assert(r.ok && calls === 1 && timed === 2, `one call for the group and two block times (${calls} calls, ${timed} times)`);
  assert(r.paidBetween?.[0] === NOW - 7200 && r.paidBetween?.[1] === NOW - 7200 + 36, "time span from the first and last block");
  const capped = await checkPayrollProof(
    good,
    deps({
      findPayment: undefined,
      findPayments: async (pays) => pays.map((pay, i) => (i < 2 ? { state: "found", txHash: pay.txHash, block: 1n } : i === 2 ? { state: "over-limit" } : undefined)),
      blockTime: async () => NOW,
    })
  );
  assert(!capped.ok && stateOf(capped, "Each one is a private payment") === "unknown", "a check past its read limit is not a pass");
  assert(/more network reads/.test(detailOf(capped, "Each one is a private payment")), "says the check hit its read limit");
  const partial = await checkPayrollProof(
    good,
    deps({ findPayment: undefined, findPayments: async (pays) => pays.map((pay, i) => (i < 4 ? { state: "found", txHash: pay.txHash, paidAt: NOW } : undefined)) })
  );
  assert(!partial.ok && stateOf(partial, "Each one is a private payment") === "unknown", "a payment left unread is not a pass");
  const unclocked = await checkPayrollProof(
    good,
    deps({ findPayment: undefined, findPayments: async (pays) => pays.map((pay) => ({ state: "found", txHash: pay.txHash, block: 7n })), blockTime: async () => { throw new Error("offline"); } })
  );
  assert(!unclocked.ok && stateOf(unclocked, "When the payments landed") === "unknown", "a time that could not be read is not a pass");
  const offline = await checkPayrollProof(good, deps({ findPayment: undefined, findPayments: async () => { throw new Error("offline"); } }));
  assert(!offline.ok && stateOf(offline, "Each one is a private payment") === "unknown", "a group lookup offline is not a pass");
}

globalThis.curve_bn128?.terminate?.();
console.log(`payrollCheck.selftest: ok (${checks} assertions)`);
process.exit(0);
