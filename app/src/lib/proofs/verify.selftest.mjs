/**
 * Proof of payment, exact balance and payroll total checks, in node: the REAL verifyProof
 * (verify.ts), findNoteTx / payrollLookups (chain.ts), checkPayrollProof
 * (payrollCheck.ts) and the label rules (label.ts), transpiled on the fly. Only
 * the RPC client is replaced, by an in-memory chain that emits the pool's real
 * events and counts every read. Proofs are real Groth16 proofs made with the
 * shipped artifacts in app/public/circuits. Nothing touches a network.
 *
 *   pnpm --filter @gloamtrade/sdk build      # the test uses the SDK's dist
 *   cd app && node src/lib/proofs/verify.selftest.mjs
 *
 * Regressions for the 2026-10-11 audits (Kensho N-1, ZK review ZK-3 and ZK-4):
 *   - a receipt for the prover's own change, own deposit (with no tx hash, or
 *     a made-up one) is not verified
 *   - a payment whose transaction can't be found is "can't confirm", never ok
 *   - change and deposits counted in a payroll total are rejected
 *   - a broken, relabelled or oversized proof is refused before any chain read
 *   - an exact balance (gloambal1) is sealed for its kind, so it can't pass as
 *     a proof of payment or the other way round (ZK-2's replacement)
 * And what the proofs still cannot tell, kept as documented passes:
 *   - a send to yourself, and the payer proving the payee's note, both verify
 *     (no payee key in the note), so the claim wording never says who paid whom
 *   - a payroll payment back to the employer counts as one of the payments
 *     (payments, not people)
 */
import { mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { fileURLToPath, pathToFileURL } from "url";
import ts from "typescript";
import * as snarkjs from "snarkjs";
import { encodeAbiParameters, encodeEventTopics, parseAbi } from "viem";

const here = dirname(fileURLToPath(import.meta.url));
const appDir = join(here, "../../..");
const sdkDist = pathToFileURL(join(appDir, "../packages/sdk/dist/index.js")).href;
const viemEsm = pathToFileURL(join(appDir, "node_modules/viem/_esm/index.js")).href;
const circuits = join(appDir, "public/circuits");
const snarkjsUrl = import.meta.resolve("snarkjs");
const sdk = await import(sdkDist);
const { IncrementalMerkleTreePoseidon, buildReceiptWitness, buildPayrollWitness, fieldToHex, noteCommitmentPoseidon, noteNullifierPoseidon, proofContext } = sdk;
const { parseEventLogs } = await import(viemEsm);

let checks = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exit(1);
  }
  checks++;
}

// ── in-memory chain ─────────────────────────────────────────────────────────
const POOL = "0x841dc046ea3cc842ba3a855731472c6eb0f2d5eb";
const USD = "0x20c0000000000000000000000000000000000000";
const CHAIN = 42431;
const DEPLOY = 37_411_195n;
const HEAD = DEPLOY + 3_000_000n; // 30 chunks of 100k: the oldest notes are past the 24-chunk scan
const NOW = Math.floor(Date.now() / 1000);

const ABI = parseAbi([
  "event Shielded(bytes32 indexed commitment, address indexed asset, uint256 amount, uint256 leafIndex, address indexed from)",
  "event Transferred(bytes32 indexed nullifier, bytes32[2] newCommitments)",
]);
const tree = new IncrementalMerkleTreePoseidon();
await tree.init();
const roots = new Set([tree.currentRoot]);
const seen = new Set();
const logs = [];
const receipts = new Map();
let txN = 1n;
const rpc = { calls: 0, offline: false, logQueries: [] };

function rawLog(eventName, args, data, blockNumber, hash) {
  const topics = encodeEventTopics({ abi: ABI, eventName, args });
  return { address: POOL, topics, data, blockNumber, transactionHash: hash, logIndex: 0, transactionIndex: 0, blockHash: fieldToHex(blockNumber), removed: false };
}
async function insert(c) {
  const idx = await tree.insert(c);
  roots.add(tree.currentRoot);
  seen.add(fieldToHex(c));
  return idx;
}
async function shieldTx(c, amount, block) {
  const idx = await insert(c);
  const hash = fieldToHex(0xdead0000n + txN++);
  const log = rawLog("Shielded", { commitment: fieldToHex(c), asset: USD, from: "0x000000000000000000000000000000000000a11c" },
    encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [amount, BigInt(idx)]), block, hash);
  logs.push(log);
  receipts.set(hash, { status: "success", blockNumber: block, logs: [log] });
  return { hash, idx };
}
async function transferTx(nullifier, c0, c1, block) {
  const i0 = await insert(c0);
  const i1 = await insert(c1);
  const hash = fieldToHex(0xbeef0000n + txN++);
  const log = rawLog("Transferred", { nullifier: fieldToHex(nullifier) },
    encodeAbiParameters([{ type: "bytes32[2]" }], [[fieldToHex(c0), fieldToHex(c1)]]), block, hash);
  logs.push(log);
  receipts.set(hash, { status: "success", blockNumber: block, logs: [log] });
  return { hash, i0, i1 };
}

class TransactionReceiptNotFoundError extends Error {
  name = "TransactionReceiptNotFoundError";
}
function hit() {
  rpc.calls++;
  if (rpc.offline) throw new Error("fetch failed");
}
globalThis.__fakeClient = {
  async readContract({ functionName, args }) {
    hit();
    if (functionName === "isKnownRoot") return roots.has(BigInt(args[0]));
    if (functionName === "commitmentSeen") return seen.has(args[0].toLowerCase());
    if (functionName === "isSpent") return false;
    throw new Error("unexpected read " + functionName);
  },
  async getBlockNumber() { hit(); return HEAD; },
  async getBlock({ blockNumber }) { hit(); return { timestamp: BigInt(NOW - Number(HEAD - blockNumber)) }; },
  async getTransactionReceipt({ hash }) {
    hit();
    const r = receipts.get(hash);
    if (!r) throw new TransactionReceiptNotFoundError(`Transaction receipt with hash "${hash}" could not be found.`);
    return r;
  },
  async getLogs({ fromBlock, toBlock, events, event, args }) {
    hit();
    const inRange = logs.filter((l) => l.blockNumber >= fromBlock && l.blockNumber <= toBlock);
    let parsed = parseEventLogs({ abi: events ?? [event], logs: inRange });
    // one value, or several OR'd (an array), as eth_getLogs takes a topic
    const wanted = args?.nullifier ? [args.nullifier].flat().map((n) => n.toLowerCase()) : null;
    if (wanted) parsed = parsed.filter((l) => wanted.includes(l.args.nullifier?.toLowerCase()));
    rpc.logQueries.push(wanted?.length ?? 0);
    return parsed;
  },
};

// ── load the real checkers ─────────────────────────────────────────────────
const tmp = mkdtempSync(join(tmpdir(), "gloam-verify-selftest-"));
const url = (f) => pathToFileURL(join(tmp, f)).href;
const ALIASES = {
  "@gloamtrade/sdk": sdkDist,
  viem: url("viem-shim.mjs"),
  "@/lib/networks": url("networks-stub.mjs"),
  "@/lib/serverRpc": url("server-rpc-stub.mjs"),
  "@/lib/demo/proof": url("demo-stub.mjs"),
  "./artifacts": url("artifacts-stub.mjs"),
};
function load(file) {
  let js = ts.transpileModule(readFileSync(join(here, file), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  js = js.replace(/from "([^"]+)"/g, (m, spec) => {
    if (ALIASES[spec]) return `from ${JSON.stringify(ALIASES[spec])}`;
    if (spec.startsWith("./")) return `from ${JSON.stringify(url(spec.slice(2) + ".mjs"))}`;
    return m;
  });
  // verify.ts loads snarkjs lazily; resolve it from the app, not the temp dir
  js = js.split(`import("snarkjs")`).join(`import(${JSON.stringify(snarkjsUrl)})`);
  writeFileSync(join(tmp, file.replace(/\.ts$/, ".mjs")), js);
}
writeFileSync(join(tmp, "viem-shim.mjs"),
  `export { parseEventLogs } from ${JSON.stringify(viemEsm)};\n` +
  `export const http = () => null;\nexport const createPublicClient = () => globalThis.__fakeClient;\n`);
writeFileSync(join(tmp, "server-rpc-stub.mjs"), `export const serverTransport = () => null;\n`);
writeFileSync(join(tmp, "networks-stub.mjs"),
  `export const NETWORK_KEYS = ["tempo"];\n` +
  `export const ceremonyForChain = () => "dev";\n` +
  `export const networkName = (n) => (n.testnet ? n.label + " testnet" : n.label);\n` +
  `export const getNetwork = () => ({ key: "tempo", label: "Tempo", chainId: ${CHAIN}, pool: "${POOL}", deployBlock: ${DEPLOY}n, logRange: 100000n, chain: { rpcUrls: { default: { http: ["memory://"] } } } });\n`);
writeFileSync(join(tmp, "demo-stub.mjs"), `export const isDemoProof = () => false;\nexport const demoHolderChecks = async () => ({ paidAt: 0 });\n`);
writeFileSync(join(tmp, "artifacts-stub.mjs"),
  `import { readFileSync } from "fs";\nexport async function verificationKey(kind) {\n` +
  `  const f = { funds: "funds", receipt: "receipt", payroll: "payroll_total" }[kind];\n` +
  `  return JSON.parse(readFileSync(${JSON.stringify(circuits)} + "/" + f + "_vkey.json", "utf8"));\n}\n`);
for (const f of ["label.ts", "types.ts", "payrollCheck.ts", "chain.ts", "verify.ts"]) load(f);
const { verifyProof, PAID_BY_SEND } = await import(url("verify.mjs"));
const { payrollLookups, PAYROLL_MAX_READS } = await import(url("chain.mjs"));
const { displayLabel, plainLabel, isPlainLabel } = await import(url("label.mjs"));

// ── history: Alice deposits, pays Bob, pays herself ─────────────────────────
const S = (n) => 0x1000n + BigInt(n); // test secrets
const D_AMT = 50_000_000_000n; // 50,000 USDG (6 dec), Alice's deposit, long ago
const D = await noteCommitmentPoseidon(S(1), D_AMT, USD);
const dep = await shieldTx(D, D_AMT, DEPLOY + 10n); // ~3M blocks before HEAD

const E_AMT = 10_000_000_000n; // a recent deposit she spends: 4,000 to Bob, 6,000 change
const E = await noteCommitmentPoseidon(S(2), E_AMT, USD);
const depE = await shieldTx(E, E_AMT, HEAD - 50_000n);
const bobAmt = 4_000_000_000n;
const changeAmt = E_AMT - bobAmt;
const bobNote = await noteCommitmentPoseidon(S(3), bobAmt, USD);
const changeNote = await noteCommitmentPoseidon(S(4), changeAmt, USD);
const send = await transferTx(await noteNullifierPoseidon(S(2), E), bobNote, changeNote, HEAD - 40_000n);

const F_AMT = 25_000_000_000n; // a deposit she sends to herself in slot 0
const F = await noteCommitmentPoseidon(S(5), F_AMT, USD);
await shieldTx(F, F_AMT, HEAD - 30_000n);
const selfNote = await noteCommitmentPoseidon(S(6), F_AMT - 1n, USD);
const selfChange = await noteCommitmentPoseidon(S(7), 1n, USD);
const self = await transferTx(await noteNullifierPoseidon(S(5), F), selfNote, selfChange, HEAD - 20_000n);

async function receiptProof({ secret, amount, leafIndex, txHash, verifier = "Acme Bank (income check)", reveal = true }) {
  const expiresAt = NOW + 7 * 86400;
  const context = proofContext({ kind: "payment", chainId: CHAIN, pool: POOL, verifier, expiresAt });
  const path = await tree.path(leafIndex);
  const w = await buildReceiptWitness({ secretHex: fieldToHex(secret), amount, asset: USD, path, reveal, context });
  assert(w.blocker === null, `receipt witness: ${w.blocker}`);
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(w.circomInput, join(circuits, "receipt.wasm"), join(circuits, "receipt_final.zkey"));
  return {
    v: 1, kind: "payment", chainId: CHAIN, pool: POOL, verifier, expiresAt,
    asset: USD, commitment: fieldToHex(w.publicInputs.commitment), amount: reveal ? amount.toString() : null, minAmount: amount.toString(),
    txHash, proof, publicSignals,
  };
}
const clone = (p) => JSON.parse(JSON.stringify(p));
const check = (r, label) => r.checks.find((c) => c.label.startsWith(label));
const show = (tag, r) => {
  console.log(`\n${tag}: ok=${r.ok}`);
  for (const c of r.checks) console.log(`  [${c.state}] ${c.label}${c.detail ? " :: " + c.detail : ""}`);
};
async function run(p) {
  rpc.calls = 0;
  rpc.logQueries = [];
  const r = await verifyProof(p);
  return { r, calls: rpc.calls };
}
const RANDOM_TX = "0x" + "5a".repeat(32);

// ── proof of payment: the real payment passes ───────────────────────────────
const bobProof = await receiptProof({ secret: S(3), amount: bobAmt, leafIndex: send.i0, txHash: send.hash });
{
  const { r } = await run(bobProof);
  show("control: Bob's receipt for the payment Alice sent him", r);
  assert(r.ok, "a real payment with its tx hash verifies");
  assert(check(r, PAID_BY_SEND)?.state === "pass" && r.paidAt === NOW - 40_000, "says when it landed");
  const { r: r2 } = await run({ ...bobProof, txHash: null });
  assert(r2.ok, "a recent payment with no tx hash is found by the scan");
}

// ── N-1 A: the prover's own change ─────────────────────────────────────────
{
  const p = await receiptProof({ secret: S(4), amount: changeAmt, leafIndex: send.i1, txHash: send.hash });
  const { r } = await run(p);
  show("N-1 A: receipt for the prover's own CHANGE (Transferred slot 1)", r);
  assert(!r.ok, "own change is not a payment received");
  assert(check(r, PAID_BY_SEND)?.state === "fail" && /change/.test(check(r, PAID_BY_SEND).detail), "says it is change");
  const { r: r2 } = await run({ ...p, txHash: null });
  assert(!r2.ok && /change/.test(check(r2, PAID_BY_SEND).detail), "change found by the scan is rejected too");
}

// ── N-1 B / ZK-3: the prover's own deposit ─────────────────────────────────
{
  const p = await receiptProof({ secret: S(1), amount: D_AMT, leafIndex: dep.idx, txHash: null });
  const { r } = await run(p);
  show("N-1 B: receipt for an old DEPOSIT, older than the scan, no tx hash", r);
  assert(!r.ok, "old deposit with no tx hash is not verified");
  assert(check(r, PAID_BY_SEND)?.state === "unknown" && /Can't confirm this payment/.test(check(r, PAID_BY_SEND).detail), "says it can't confirm the payment");

  const { r: r2 } = await run({ ...p, txHash: dep.hash });
  assert(!r2.ok && /deposit/.test(check(r2, PAID_BY_SEND).detail), "naming the deposit tx is rejected as a deposit");

  const { r: r3 } = await run({ ...p, txHash: RANDOM_TX });
  show("ZK-3: the same deposit with a made-up tx hash", r3);
  assert(!r3.ok && check(r3, PAID_BY_SEND)?.state === "fail" && /not on Tempo/.test(check(r3, PAID_BY_SEND).detail), "a made-up tx hash fails");

  const pe = await receiptProof({ secret: S(2), amount: E_AMT, leafIndex: depE.idx, txHash: null });
  const { r: r4 } = await run(pe);
  assert(!r4.ok && /deposit/.test(check(r4, PAID_BY_SEND).detail), "a recent deposit found by the scan is rejected");

  const { r: r5 } = await run({ ...bobProof, txHash: depE.hash });
  assert(!r5.ok && /did not make this payment/.test(check(r5, PAID_BY_SEND).detail), "a real payment pinned to another tx fails");
}

// ── fail closed when the network does not answer ───────────────────────────
{
  rpc.offline = true;
  const { r } = await run(bobProof);
  rpc.offline = false;
  assert(!r.ok && r.checks.some((c) => c.state === "unknown"), "offline is never ok");
}

// ── documented: what a proof of payment cannot tell ────────────────────────
{
  const p = await receiptProof({ secret: S(6), amount: F_AMT - 1n, leafIndex: self.i0, txHash: self.hash });
  const { r } = await run(p);
  show("documented: receipt for a send to YOURSELF (slot 0)", r);
  assert(r.ok, "a send to yourself still verifies: no payee key in the note, so the claim never says a third party paid");

  // The payer chose Bob's note secret, so the payer can make Bob's receipt.
  const byAlice = await receiptProof({ secret: S(3), amount: bobAmt, leafIndex: send.i0, txHash: send.hash, verifier: "My landlord" });
  const { r: r2 } = await run(byAlice);
  assert(r2.ok, "the payer can prove the payee's note too: the claim says a payment was made, not who received it");
}

// ── ZK-4: nothing is read from the chain for a proof that already failed ───
{
  const edited = clone(bobProof);
  edited.proof.pi_a[0] = "1";
  const { r, calls } = await run(edited);
  assert(!r.ok && check(r, "The proof checks out")?.state === "fail", "an edited proof fails");
  assert(calls === 0, `an edited proof makes no chain reads (made ${calls})`);

  const { r: r2, calls: c2 } = await run({ ...bobProof, verifier: "Someone else" });
  assert(!r2.ok && check(r2, "Made for")?.state === "fail" && c2 === 0, "a relabelled proof fails with no chain reads");

  const { r: r3, calls: c3 } = await run({ ...bobProof, amount: (bobAmt * 2n).toString() });
  assert(!r3.ok && check(r3, "Asset and amount")?.state === "fail" && c3 === 0, "a changed amount fails with no chain reads");

  const { r: r4, calls: c4 } = await run({ ...bobProof, txHash: "0x1234" });
  assert(!r4.ok && c4 === 0, "a malformed tx hash fails with no chain reads");

  const { r: r5, calls: c5 } = await run({ ...bobProof, pool: "0x1111111111111111111111111111111111111111" });
  assert(!r5.ok && c5 === 0, "another vault fails with no chain reads");
}

// ── payroll ────────────────────────────────────────────────────────────────
const vkeyPayroll = JSON.parse(readFileSync(join(circuits, "payroll_total_vkey.json"), "utf8"));
async function payrollPayment(i, amount, { slot = 0, shield = false } = {}) {
  const spendSecret = S(100 + i);
  const spendAmount = amount + 5n;
  const spendC = await noteCommitmentPoseidon(spendSecret, spendAmount, USD);
  await shieldTx(spendC, spendAmount, HEAD - 2000n + BigInt(i));
  const secret = S(200 + i);
  const commitment = await noteCommitmentPoseidon(secret, amount, USD);
  const nullifier = await noteNullifierPoseidon(spendSecret, spendC);
  const other = await noteCommitmentPoseidon(S(300 + i), 5n, USD);
  let hash;
  if (shield) hash = (await shieldTx(commitment, amount, HEAD - 1000n + BigInt(i))).hash;
  else hash = (await transferTx(nullifier, slot === 0 ? commitment : other, slot === 0 ? other : commitment, HEAD - 1000n + BigInt(i))).hash;
  return { secret: fieldToHex(secret), amount, spendSecret: fieldToHex(spendSecret), spendAmount, commitment: fieldToHex(commitment), nullifier: fieldToHex(nullifier), txHash: hash };
}
async function payrollProof(run, { verifier = "Tax office", parts: split, expiresAt = NOW + 7 * 86400 } = {}) {
  const context = proofContext({ kind: "payroll", chainId: CHAIN, pool: POOL, verifier, expiresAt });
  const slices = split ?? [run];
  const parts = [];
  for (const slice of slices) {
    const w = await buildPayrollWitness({ asset: USD, context, payments: slice.map((p) => ({ secretHex: p.secret, amount: p.amount, spendSecretHex: p.spendSecret, spendAmount: p.spendAmount })) });
    assert(w.blocker === null, `payroll witness: ${w.blocker}`);
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(w.circomInput, join(circuits, "payroll_total.wasm"), join(circuits, "payroll_total_final.zkey"));
    assert(await snarkjs.groth16.verify(vkeyPayroll, publicSignals, proof), "payroll part verifies");
    parts.push({ proof, publicSignals });
  }
  return {
    v: 1, kind: "payroll", chainId: CHAIN, pool: POOL, verifier, expiresAt, asset: USD,
    total: run.reduce((s, p) => s + p.amount, 0n).toString(), count: run.length,
    payments: run.map((x) => ({ commitment: x.commitment, nullifier: x.nullifier, txHash: x.txHash })), parts,
  };
}
const employee = await payrollPayment(1, 3_000_000_000n);
const backToEmployer = await payrollPayment(2, 40_000_000_000n); // the payee note is the employer's own
const changeAsPay = await payrollPayment(3, 7_000_000_000n, { slot: 1 });
const depositAsPay = await payrollPayment(4, 9_000_000_000n, { shield: true });
{
  const p = await payrollProof([employee, backToEmployer]);
  const { r } = await run(p);
  show("documented: payroll total where one payment went back to the employer", r);
  assert(r.ok, "a payment back to yourself still counts: the claim is N payments funded by the prover, not N people");
  assert(check(r, "Total and count match")?.state === "pass", "label says count, not people");
  const { r: r2 } = await run({ ...p, payments: p.payments.map((x) => ({ ...x, txHash: null })) });
  assert(r2.ok, "recent payroll payments with no tx hash are found by the scan");
}
{
  const p = await payrollProof([employee, changeAsPay]);
  const { r } = await run(p);
  show("N-1: payroll total that counts the prover's own change", r);
  assert(!r.ok && check(r, "Each one is a private payment")?.state === "fail" && /change/.test(check(r, "Each one is a private payment").detail), "self-funded change in a payroll is rejected");
}
{
  const p = await payrollProof([employee, depositAsPay]);
  const { r } = await run(p);
  assert(!r.ok && /deposit/.test(check(r, "Each one is a private payment").detail), "a deposit in a payroll is rejected");
}
{
  const p = await payrollProof([employee, backToEmployer]);
  p.payments[1].txHash = RANDOM_TX;
  const { r } = await run(p);
  assert(!r.ok && check(r, "Each one is a private payment")?.state === "fail" && /not on this network/.test(check(r, "Each one is a private payment").detail), "a made-up tx hash in a payroll fails");
}
{
  const p = await payrollProof([employee, backToEmployer]);
  rpc.offline = true;
  const { r } = await run(p);
  rpc.offline = false;
  assert(!r.ok && check(r, "Each one is a private payment")?.state === "unknown", "payroll offline is not ok");
}
{
  // ZK-4: oversized, broken or relabelled payroll proofs are refused before any chain read.
  const p = await payrollProof([employee, backToEmployer]);
  const big = clone(p);
  big.parts = Array.from({ length: 9 }, () => clone(p.parts[0]));
  const { r, calls } = await run(big);
  assert(!r.ok && r.checks[0].state === "fail" && /at most 256/.test(r.checks[0].detail) && calls === 0, "nine parts are refused before the math");
  const many = clone(p);
  many.payments = Array.from({ length: 257 }, () => clone(p.payments[0]));
  const { r: r2, calls: c2 } = await run(many);
  assert(!r2.ok && c2 === 0, "257 payments are refused before the math");
  const edited = clone(p);
  edited.parts[0].proof.pi_a[0] = "1";
  const { r: r3, calls: c3 } = await run(edited);
  assert(!r3.ok && check(r3, "The proof checks out")?.state === "fail" && c3 === 0, "a broken payroll proof makes no chain reads");
  const { r: r4, calls: c4 } = await run({ ...p, verifier: "Someone else" });
  assert(!r4.ok && c4 === 0, "a relabelled payroll proof makes no chain reads");
}

{
  // Chain reads per check: the payments of a group share one log query per block range,
  // lookups stop at the first payment not found, and an expired proof reads nothing.
  const p = await payrollProof([employee, backToEmployer]);
  const { r, calls } = await run(p);
  assert(r.ok && calls === 4, `two named payments: two receipts and two block times (${calls} reads)`);
  const { r: r2, calls: c2 } = await run({ ...p, payments: p.payments.map((x) => ({ ...x, txHash: null })) });
  assert(r2.ok && c2 === 4 && rpc.logQueries.length === 1 && rpc.logQueries[0] === 2, `two unnamed payments: the head, one log query for both, two block times (${c2} reads)`);

  // payments never made (their spend markers are on no transfer): one scan for the group, then it stops
  const unpaid = [];
  for (let i = 0; i < 5; i++) {
    const spendSecret = S(600 + i);
    const spendAmount = 1_000_005n;
    const spendC = await noteCommitmentPoseidon(spendSecret, spendAmount, USD);
    const secret = S(700 + i);
    unpaid.push({
      secret: fieldToHex(secret), amount: 1_000_000n, spendSecret: fieldToHex(spendSecret), spendAmount,
      commitment: fieldToHex(await noteCommitmentPoseidon(secret, 1_000_000n, USD)),
      nullifier: fieldToHex(await noteNullifierPoseidon(spendSecret, spendC)), txHash: null,
    });
  }
  const q = await payrollProof(unpaid);
  const { r: r3, calls: c3 } = await run(q);
  assert(!r3.ok && check(r3, "Each one is a private payment")?.state === "unknown", "payments that are not on chain are not confirmed");
  assert(c3 === 25 && rpc.logQueries.every((n) => n === 5), `five unnamed payments: the head and 24 log queries in all (${c3} reads)`);

  const old = await payrollProof([employee, backToEmployer], { expiresAt: NOW - 60 });
  const { r: r4, calls: c4 } = await run(old);
  assert(!r4.ok && r4.expired && c4 === 0, `an expired payroll proof makes no chain reads (${c4})`);
  const { r: r5, calls: c5 } = await run({ ...old, payments: old.payments.map((x) => ({ ...x, txHash: null })) });
  assert(!r5.ok && r5.expired && c5 === 0, "an expired payroll proof with no transactions named makes no chain reads");

  // one check's reads have a ceiling
  const net = { chainId: CHAIN, pool: POOL, deployBlock: DEPLOY, logRange: 100000n };
  assert(PAYROLL_MAX_READS === 512, "a check reads the chain at most 512 times");
  rpc.calls = 0;
  const l = payrollLookups(globalThis.__fakeClient, net, POOL, 3);
  const named = await l.find(p.payments);
  assert(rpc.calls === 2 && l.reads() === 2 && named.every((x) => x?.state === "found"), "receipts count as reads");
  const more = await l.find(q.payments);
  assert(rpc.calls === 3 && l.reads() === 3 && more.every((x) => x?.state === "over-limit"), `past the ceiling nothing more is read (${rpc.calls} reads)`);
  await l.blockTime(1n).then(() => assert(false, "a block time past the ceiling is not read"), () => assert(rpc.calls === 3, "a block time past the ceiling is refused"));
}

// ── exact balance (gloambal1, replaces the copyable gloamdisc1, ZK-2) ───────
async function balanceProof({ secret, amount, leafIndex, verifier = "Acme Bank" }) {
  const expiresAt = NOW + 7 * 86400;
  const context = proofContext({ kind: "balance", chainId: CHAIN, pool: POOL, verifier, expiresAt });
  const w = await buildReceiptWitness({ secretHex: fieldToHex(secret), amount, asset: USD, path: await tree.path(leafIndex), reveal: true, minAmount: amount, context });
  assert(w.blocker === null, `balance witness: ${w.blocker}`);
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(w.circomInput, join(circuits, "receipt.wasm"), join(circuits, "receipt_final.zkey"));
  return { v: 1, kind: "balance", chainId: CHAIN, pool: POOL, verifier, expiresAt, asset: USD, commitment: fieldToHex(w.publicInputs.commitment), amount: amount.toString(), proof, publicSignals };
}
{
  const p = await balanceProof({ secret: S(1), amount: D_AMT, leafIndex: dep.idx });
  const { r } = await run(p);
  show("exact balance: one deposit, amount shown, sealed for a verifier", r);
  assert(r.ok && r.kind === "balance", "an exact balance verifies (any note, deposits included)");
  assert(check(r, "Balance is in the vault")?.state === "pass", "checks the note is in the vault");

  const { r: r2, calls } = await run({ ...p, amount: (D_AMT + 1n).toString() });
  assert(!r2.ok && check(r2, "Asset and amount")?.state === "fail" && calls === 0, "a changed amount fails with no chain reads");

  const { r: r3 } = await run({ ...p, verifier: "Someone else" });
  assert(!r3.ok && check(r3, "Made for")?.state === "fail", "a relabelled balance fails");

  // The same circuit backs a proof of payment: the kind sealed in the context keeps them apart.
  const asBalance = { ...bobProof, kind: "balance", amount: bobAmt.toString() };
  delete asBalance.minAmount;
  delete asBalance.txHash;
  const { r: r4, calls: c4 } = await run(asBalance);
  assert(!r4.ok && check(r4, "Made for")?.state === "fail" && c4 === 0, "a proof of payment can't pass as an exact balance");
  const asPayment = { ...p, kind: "payment", minAmount: p.amount, txHash: null };
  const { r: r5 } = await run(asPayment);
  assert(!r5.ok && check(r5, "Made for")?.state === "fail", "an exact balance can't pass as a proof of payment");

  const hidden = await receiptProof({ secret: S(3), amount: bobAmt, leafIndex: send.i0, txHash: null, reveal: false });
  const { r: r6 } = await run({ ...hidden, kind: "balance", amount: bobAmt.toString() });
  assert(!r6.ok, "a hidden-amount receipt is not an exact balance");
}

// ── labels: hidden characters never reach the page ─────────────────────────
{
  const spoof = "Acme ‮knab‬ Bank​";
  assert(plainLabel(spoof) === "Acme knab Bank", "bidi overrides and zero-width characters are removed");
  assert(!isPlainLabel(spoof) && isPlainLabel("Acme Bank"), "a label with hidden characters is not plain");
  assert(displayLabel("x".repeat(200)).length === 81, "long labels are cut for display");
  const p = await receiptProof({ secret: S(3), amount: bobAmt, leafIndex: send.i0, txHash: send.hash, verifier: spoof });
  const { r } = await run(p);
  const made = check(r, "Made for");
  assert(made?.label === 'Made for "Acme knab Bank"' && /Hidden characters/.test(made.detail), "the page shows the plain label and says so");
}

globalThis.curve_bn128?.terminate?.();
console.log(`\nverify.selftest: ok (${checks} assertions)`);
process.exit(0);
