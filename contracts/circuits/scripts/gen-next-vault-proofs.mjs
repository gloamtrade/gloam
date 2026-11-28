#!/usr/bin/env node
/**
 * Real final-key proofs for the next vault's cash-out floor
 * (contracts/test/next/NextVaultProofs.t.sol, contracts/test/fork/NextVaultFork.t.sol),
 * written to contracts/test/fixtures/next-vault-proofs.json. The next vault is
 * not deployed and not audited. The story:
 *
 *   1. deposit a 100 USDC note (leaf 0) and a 50 USDC note (leaf 1);
 *   2. a private send of 60 out of the first, leaving 40 in change (leaves 2 and 3);
 *   3. cash out the 60 with no floor: a proof shaped exactly like a live vault's;
 *   4. cash out the 40 with a floor of 39.8, what 0.5% leaves;
 *   5. cash out the 50 with a floor of 49.875, what 0.25% leaves, so it passes at
 *      a 0.25% fee and reverts at 0.5%.
 *
 * No circuit changed: the floored proofs use the ceremony's final keys
 * (app/public/circuits/final), the same the live verifiers hold. A floor sits in
 * the proof's `recipient` public input, which the circuit leaves free
 * (ShieldPoolCore2.recipientInput). The asset is Base's USDC so the fork test can
 * run this on the live verifiers with the real token. The secrets are fixed test
 * values, not anyone's money.
 *
 *   node contracts/circuits/scripts/gen-next-vault-proofs.mjs
 *
 * snarkjs, circomlibjs and viem come from the app's dependencies.
 */
import { writeFileSync } from "fs";
import { createRequire } from "module";
import { fileURLToPath } from "url";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const appRequire = createRequire(here("../../../app/package.json"));
const snarkjs = appRequire("snarkjs");
const { buildPoseidon } = appRequire("circomlibjs");
const { encodeAbiParameters, keccak256 } = appRequire("viem");

const WASM = here("../../../app/public/circuits/");
const FINAL = here("../../../app/public/circuits/final/");
const OUT = here("../../test/fixtures/next-vault-proofs.json");

const USDC = 0x833589fcd6edb6e08f4c7c32d4f71b54bda02913n;
const RECIPIENT = 0x000000000000000000000000000000000000e7e0n;
const DEPTH = 20;

const poseidon = await buildPoseidon();
const H2 = (a, b) => poseidon.F.toObject(poseidon([a, b]));
const H3 = (a, b, c) => poseidon.F.toObject(poseidon([a, b, c]));

function note(secret, amount) {
  const commitment = H3(secret, amount, USDC);
  return { secret, amount, commitment, nullifier: H2(secret, commitment) };
}
const big = note(7357000000000000000011n, 100_000_000n);
const tight = note(7357000000000000000012n, 50_000_000n);
const pay = note(7357000000000000000013n, 60_000_000n);
const change = note(7357000000000000000014n, 40_000_000n);

const zeros = [0n];
for (let i = 1; i < DEPTH; i++) zeros.push(H2(zeros[i - 1], zeros[i - 1]));

/** Root of `leaves` and the path of leaf `index`. */
function pathFor(leaves, index) {
  let layer = leaves.slice();
  let idx = index;
  const pathElements = [];
  const pathIndices = [];
  for (let level = 0; level < DEPTH; level++) {
    const right = idx % 2 === 1;
    const sib = right ? idx - 1 : idx + 1;
    pathElements.push(sib < layer.length ? layer[sib] : zeros[level]);
    pathIndices.push(right ? 1 : 0);
    const next = [];
    for (let i = 0; i < layer.length; i += 2) next.push(H2(layer[i], i + 1 < layer.length ? layer[i + 1] : zeros[level]));
    layer = next;
    idx = Math.floor(idx / 2);
  }
  return { root: layer[0], pathElements: pathElements.map(String), pathIndices: pathIndices.map(String) };
}

async function prove(circuit, input) {
  const zkey = `${FINAL}${circuit}_final.zkey`;
  const vkey = await snarkjs.zKey.exportVerificationKey(zkey);
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, `${WASM}${circuit}.wasm`, zkey);
  if (!(await snarkjs.groth16.verify(vkey, publicSignals, proof))) throw new Error(`${circuit} proof does not verify`);
  const [a, b, c] = JSON.parse(`[${await snarkjs.groth16.exportSolidityCallData(proof, publicSignals)}]`);
  return encodeAbiParameters(
    [{ type: "uint256[2]" }, { type: "uint256[2][2]" }, { type: "uint256[2]" }],
    [a.map(BigInt), b.map((row) => row.map(BigInt)), c.map(BigInt)]
  );
}

/** ShieldPoolCore2.recipientInput: `to` with no floor, a hash of both with one. */
function recipientInput(to, minReceived) {
  if (minReceived === 0n) return to;
  const hash = keccak256(
    encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [`0x${to.toString(16).padStart(40, "0")}`, minReceived])
  );
  return (BigInt(hash) >> 8n) | (1n << 247n);
}

const hex = (v) => `0x${v.toString(16).padStart(64, "0")}`;
const shieldProof = (n) =>
  prove("shield", { commitment: String(n.commitment), amount: String(n.amount), asset: String(USDC), secret: String(n.secret) });

async function cashOut(n, leaves, index, minReceived) {
  const p = pathFor(leaves, index);
  const recipient = recipientInput(RECIPIENT, minReceived);
  const proof = await prove("unshield", {
    root: String(p.root),
    nullifier: String(n.nullifier),
    asset: String(USDC),
    amount: String(n.amount),
    recipient: String(recipient),
    secret: String(n.secret),
    pathElements: p.pathElements,
    pathIndices: p.pathIndices,
  });
  return {
    amount: String(n.amount),
    nullifier: hex(n.nullifier),
    root: hex(p.root),
    minReceived: String(minReceived),
    recipientInput: hex(recipient),
    proof,
  };
}

const afterDeposits = [big.commitment, tight.commitment];
const afterSend = [...afterDeposits, pay.commitment, change.commitment];
const sendPath = pathFor(afterDeposits, 0);

const out = {
  note: "Not live notes. Fixed test secrets, final keys, Base USDC. See circuits/scripts/gen-next-vault-proofs.mjs.",
  asset: `0x${USDC.toString(16).padStart(40, "0")}`,
  recipient: `0x${RECIPIENT.toString(16).padStart(40, "0")}`,
  shieldBig: { amount: String(big.amount), commitment: hex(big.commitment), proof: await shieldProof(big) },
  shieldTight: { amount: String(tight.amount), commitment: hex(tight.commitment), proof: await shieldProof(tight) },
  send: {
    root: hex(sendPath.root),
    nullifier: hex(big.nullifier),
    payment: hex(pay.commitment),
    change: hex(change.commitment),
    proof: await prove("transfer", {
      root: String(sendPath.root),
      nullifier: String(big.nullifier),
      newCommitment0: String(pay.commitment),
      newCommitment1: String(change.commitment),
      secretIn: String(big.secret),
      amountIn: String(big.amount),
      asset: String(USDC),
      pathElements: sendPath.pathElements,
      pathIndices: sendPath.pathIndices,
      secretPay: String(pay.secret),
      amountPay: String(pay.amount),
      secretChange: String(change.secret),
      amountChange: String(change.amount),
    }),
  },
  plain: await cashOut(pay, afterSend, 2, 0n),
  floored: await cashOut(change, afterSend, 3, 39_800_000n),
  tight: await cashOut(tight, afterSend, 1, 49_875_000n),
};

writeFileSync(OUT, `${JSON.stringify(out, null, 2)}\n`);
console.log("wrote", OUT);
// snarkjs keeps its worker threads open; nothing else is left to do
process.exit(0);
