/**
 * Kensho 2026-10-11 PoC: what the /verify page accepts as "proof of payment"
 * and "payroll total". Offline only. Nothing is sent to any network.
 *
 * Runs the REAL verifyProof (verify.ts), findNoteTx (chain.ts) and
 * checkPayrollProof (payrollCheck.ts), transpiled on the fly. Only the RPC
 * client is replaced, by an in-memory chain that returns the same logs and
 * receipts the pool contract emits. Proofs are real Groth16 proofs made with
 * the shipped artifacts in app/public/circuits.
 *
 *   pnpm --filter @gloamtrade/sdk build
 *   cd app && node src/lib/proofs/kensho-oct11.poc.mjs
 *
 * Scenarios. Before the fix all four came back ok=true, which was the finding.
 * After the fix (branch proofix) the script asserts:
 *   A. Receipt for the prover's OWN change note (Transferred newCommitments[1]):
 *      REJECTED.
 *   B. Receipt for the prover's OWN deposit, older than the bounded log scan,
 *      with no tx hash in the proof: NOT VERIFIED ("can't confirm this payment").
 *   C. Receipt for a note the prover sent to themselves (self-transfer, slot 0):
 *      still verifies. Nothing on chain tells a self-send apart without a payee
 *      key in the note, so the claim now reads "a private payment was made",
 *      never "someone paid you".
 *   D. Payroll total that counts a self-payment as one of the payments: still
 *      verifies, now worded as "a run of N payments funded by the prover", not
 *      "N people". (Change counted as a payroll payment is rejected, see
 *      verify.selftest.mjs.)
 * The full regression set is verify.selftest.mjs next to this file.
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
const HEAD = DEPLOY + 3_000_000n; // 30 chunks of 100k: older than the 24-chunk scan
const NOW = Math.floor(Date.now() / 1000);

const ABI = parseAbi([
  "event Shielded(bytes32 indexed commitment, address indexed asset, uint256 amount, uint256 leafIndex, address indexed from)",
  "event Transferred(bytes32 indexed nullifier, bytes32[2] newCommitments)",
]);
const tree = new IncrementalMerkleTreePoseidon();
await tree.init();
const roots = new Set([tree.currentRoot]);
const seen = new Set();
const logs = []; // raw logs with blockNumber + transactionHash
const receipts = new Map();
let txN = 1n;

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

globalThis.__fakeClient = {
  async readContract({ functionName, args }) {
    if (functionName === "isKnownRoot") return roots.has(BigInt(args[0]));
    if (functionName === "commitmentSeen") return seen.has(args[0].toLowerCase());
    if (functionName === "isSpent") return false;
    throw new Error("unexpected read " + functionName);
  },
  async getBlockNumber() { return HEAD; },
  async getBlock({ blockNumber }) { return { timestamp: BigInt(NOW - Number(HEAD - blockNumber)) }; },
  async getTransactionReceipt({ hash }) { const r = receipts.get(hash); if (!r) throw new Error("no receipt"); return r; },
  async getLogs({ fromBlock, toBlock, events, event, args }) {
    const { parseEventLogs } = await import(viemEsm);
    const inRange = logs.filter((l) => l.blockNumber >= fromBlock && l.blockNumber <= toBlock);
    let parsed = parseEventLogs({ abi: events ?? [event], logs: inRange });
    if (args?.nullifier) parsed = parsed.filter((l) => l.args.nullifier?.toLowerCase() === args.nullifier.toLowerCase());
    return parsed;
  },
};

// ── load the real checkers ─────────────────────────────────────────────────
const tmp = mkdtempSync(join(tmpdir(), "gloam-kensho-poc-"));
const url = (f) => pathToFileURL(join(tmp, f)).href;
function load(file, rewrites) {
  let js = ts.transpileModule(readFileSync(join(here, file), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  for (const [from, to] of rewrites) js = js.split(`from "${from}"`).join(`from ${JSON.stringify(to)}`);
  // sibling modules (./label, ./types, ...) load from the temp dir
  js = js.replace(/from "\.\/([^"]+)"/g, (_, name) => `from ${JSON.stringify(url(name + ".mjs"))}`);
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
load("label.ts", []);
load("types.ts", []);
load("payrollCheck.ts", [["@gloamtrade/sdk", sdkDist]]);
load("chain.ts", [["viem", url("viem-shim.mjs")], ["@/lib/networks", url("networks-stub.mjs")], ["@/lib/serverRpc", url("server-rpc-stub.mjs")], ["./payrollCheck", url("payrollCheck.mjs")]]);
load("verify.ts", [["@gloamtrade/sdk", sdkDist], ["@/lib/networks", url("networks-stub.mjs")], ["@/lib/demo/proof", url("demo-stub.mjs")], ["./artifacts", url("artifacts-stub.mjs")], ["./chain", url("chain.mjs")], ["./payrollCheck", url("payrollCheck.mjs")]]);
const { verifyProof } = await import(url("verify.mjs"));

// ── Alice's history (all her own money) ─────────────────────────────────────
const S = (n) => 0x1000n + BigInt(n); // test secrets
const D_AMT = 50_000_000_000n; // 50,000 USDG (6 dec), Alice's deposit, long ago
const dSecret = S(1);
const D = await noteCommitmentPoseidon(dSecret, D_AMT, USD);
const dep = await shieldTx(D, D_AMT, DEPLOY + 10n); // ~3M blocks before HEAD

// A second deposit she later spends: 10,000 -> [1 to a shop, 9,999 change to herself]
const E_AMT = 10_000_000_000n;
const eSecret = S(2);
const E = await noteCommitmentPoseidon(eSecret, E_AMT, USD);
await shieldTx(E, E_AMT, HEAD - 50_000n);
const shopAmt = 1_000_000n;
const changeAmt = E_AMT - shopAmt;
const shopNote = await noteCommitmentPoseidon(S(3), shopAmt, USD);
const changeNote = await noteCommitmentPoseidon(S(4), changeAmt, USD);
const eNull = await noteNullifierPoseidon(eSecret, E);
const send = await transferTx(eNull, shopNote, changeNote, HEAD - 40_000n);

// A third deposit she "pays" to herself in slot 0 (self-transfer)
const F_AMT = 25_000_000_000n;
const fSecret = S(5);
const F = await noteCommitmentPoseidon(fSecret, F_AMT, USD);
await shieldTx(F, F_AMT, HEAD - 30_000n);
const selfNote = await noteCommitmentPoseidon(S(6), F_AMT - 1n, USD);
const selfChange = await noteCommitmentPoseidon(S(7), 1n, USD);
const self = await transferTx(await noteNullifierPoseidon(fSecret, F), selfNote, selfChange, HEAD - 20_000n);

async function receiptProof({ secret, amount, leafIndex, txHash, verifier }) {
  const expiresAt = NOW + 7 * 86400;
  const context = proofContext({ kind: "payment", chainId: CHAIN, pool: POOL, verifier, expiresAt });
  const path = await tree.path(leafIndex);
  const w = await buildReceiptWitness({ secretHex: fieldToHex(secret), amount, asset: USD, path, reveal: true, context });
  assert(w.blocker === null, `receipt witness: ${w.blocker}`);
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(w.circomInput, join(circuits, "receipt.wasm"), join(circuits, "receipt_final.zkey"));
  return {
    v: 1, kind: "payment", chainId: CHAIN, pool: POOL, verifier, expiresAt,
    asset: USD, commitment: fieldToHex(w.publicInputs.commitment), amount: amount.toString(), minAmount: amount.toString(),
    txHash, proof, publicSignals,
  };
}
const show = (tag, r) => {
  console.log(`\n${tag}: ok=${r.ok}`);
  for (const c of r.checks) console.log(`  [${c.state}] ${c.label}${c.detail ? " :: " + c.detail : ""}`);
};

// A. own change note, with its tx hash
{
  const p = await receiptProof({ secret: S(4), amount: changeAmt, leafIndex: send.i1, txHash: send.hash, verifier: "Acme Bank (income check)" });
  const r = await verifyProof(p);
  show("A. receipt for the prover's own CHANGE (Transferred slot 1)", r);
  assert(r.ok === false, "A: own change is rejected");
}
// B. own old deposit, no tx hash
{
  const p = await receiptProof({ secret: dSecret, amount: D_AMT, leafIndex: dep.idx, txHash: null, verifier: "Acme Bank (income check)" });
  const r = await verifyProof(p);
  show("B. receipt for the prover's own DEPOSIT older than the scan, no tx hash", r);
  assert(r.ok === false, "B: old self-deposit with no tx hash is not verified");
  // control: the same proof WITH the tx hash is caught as a deposit
  const r2 = await verifyProof({ ...p, txHash: dep.hash });
  assert(r2.ok === false, "B control: naming the deposit tx is rejected");
}
// C. self-transfer, slot 0
{
  const p = await receiptProof({ secret: S(6), amount: F_AMT - 1n, leafIndex: self.i0, txHash: self.hash, verifier: "Acme Bank (income check)" });
  const r = await verifyProof(p);
  show("C. receipt for a note the prover sent to THEMSELVES (slot 0)", r);
  assert(r.ok === true, "C: documented, a self-send still verifies; the claim no longer says who paid");
}

// D. payroll total padded with a self-payment
{
  const { checkPayrollProof, classifyPaymentLogs } = await import(url("payrollCheck.mjs"));
  const vkey = JSON.parse(readFileSync(join(circuits, "payroll_total_vkey.json"), "utf8"));
  // Employer note G pays one real employee 3,000; employer note H "pays" 40,000 back to the employer.
  const mk = async (i, amount) => {
    const spendSecret = S(100 + i), spendAmount = amount + 5n;
    const spendC = await noteCommitmentPoseidon(spendSecret, spendAmount, USD);
    const commitment = await noteCommitmentPoseidon(S(200 + i), amount, USD);
    const nullifier = await noteNullifierPoseidon(spendSecret, spendC);
    const tx = await transferTx(nullifier, commitment, await noteCommitmentPoseidon(S(300 + i), 5n, USD), HEAD - 1000n + BigInt(i));
    return { secret: fieldToHex(S(200 + i)), amount, spendSecret: fieldToHex(spendSecret), spendAmount, commitment: fieldToHex(commitment), nullifier: fieldToHex(nullifier), txHash: tx.hash };
  };
  const realEmployee = await mk(1, 3_000_000_000n);
  const selfPayment = await mk(2, 40_000_000_000n); // payee note is the employer's own
  const verifier = "Tax office";
  const expiresAt = NOW + 7 * 86400;
  const context = proofContext({ kind: "payroll", chainId: CHAIN, pool: POOL, verifier, expiresAt });
  const run = [realEmployee, selfPayment];
  const w = await buildPayrollWitness({ asset: USD, context, payments: run.map((p) => ({ secretHex: p.secret, amount: p.amount, spendSecretHex: p.spendSecret, spendAmount: p.spendAmount })) });
  assert(w.blocker === null, `payroll witness: ${w.blocker}`);
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(w.circomInput, join(circuits, "payroll_total.wasm"), join(circuits, "payroll_total_final.zkey"));
  const p = { v: 1, kind: "payroll", chainId: CHAIN, pool: POOL, verifier, expiresAt, asset: USD,
    total: (realEmployee.amount + selfPayment.amount).toString(), count: 2,
    payments: run.map((x) => ({ commitment: x.commitment, nullifier: x.nullifier, txHash: x.txHash })), parts: [{ proof, publicSignals }] };
  const r = await checkPayrollProof(p, {
    verifySnark: (part) => snarkjs.groth16.verify(vkey, part.publicSignals, part.proof),
    vault: { label: "Tempo" },
    findPayment: async (pay) => {
      const rc = receipts.get(pay.txHash);
      const { parseEventLogs } = await import(viemEsm);
      const v = classifyPaymentLogs(parseEventLogs({ abi: ABI, logs: rc.logs }), POOL, pay.commitment, pay.nullifier);
      return v === "found" ? { state: "found", txHash: pay.txHash, paidAt: NOW - 60 } : { state: v };
    },
    now: NOW,
    when: (u) => new Date(u * 1000).toISOString(),
  });
  show("D. payroll total, 43,000 USDG in 2 payments, one of them back to the employer", r);
  assert(r.ok === true, "D: documented, a self-payment counts as a payment (payments, not people)");
  assert(r.checks.some((c) => c.label === "Total and count match the proof"), "D: the check says count, not people");
}

console.log(`\nkensho-oct11 PoC: ${checks} assertions. A and B rejected; C and D verify as documented limits`);
process.exit(0);
