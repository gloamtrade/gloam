#!/usr/bin/env node
/**
 * Real final-key proofs for the BNB Chain mainnet fork test
 * (contracts/test/fork/BnbMainnetFork.t.sol), written to
 * contracts/test/fixtures/bnb-fork-proofs.json. BNB Chain's stablecoins have
 * 18 decimals, so every amount here is in 18 (USDT, BNB) or 9 (BDX) decimals:
 * the proofs show the circuits and the vault take them as they are. The story:
 *
 *   1. deposit a 100 USDT note (leaf 0, 100e18), a 1,000 BDX note (leaf 1,
 *      1000e9) and a 0.01 BNB note (leaf 2), each with its shield proof;
 *   2. a private send of 60 of the USDT, leaving 40 in change (leaves 3 and 4),
 *      proved against the root after step 1;
 *   3. cash out the 60 USDT payment, the BDX note and the BNB note to RECIPIENT,
 *      proved against the root after step 2.
 * Plus a valid deposit proof for 100,001 BDX, one over its cap, which the vault refuses.
 *
 * The keys are the ceremony's final ones (app/public/circuits/final), the same
 * the mainnet verifiers hold. The secrets are fixed test values, not anyone's money.
 *
 *   node contracts/circuits/scripts/gen-bnb-fork-proofs.mjs
 *
 * snarkjs and viem come from the app's dependencies, circomlibjs from the SDK's.
 */
import { writeFileSync } from "fs";
import { createRequire } from "module";
import { fileURLToPath } from "url";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const appRequire = createRequire(here("../../../app/package.json"));
const snarkjs = appRequire("snarkjs");
// circomlibjs is the SDK's dependency (the app takes it through the SDK)
const { buildPoseidon } = createRequire(here("../../../packages/sdk/package.json"))("circomlibjs");
const { encodeAbiParameters, getAddress } = appRequire("viem");

const WASM = here("../../../app/public/circuits/");
const FINAL = here("../../../app/public/circuits/final/");
const OUT = here("../../test/fixtures/bnb-fork-proofs.json");

const USDT = 0x55d398326f99059ff775485246999027b3197955n;
const BDX = 0x6ad12e761b438bea3ea09f6c6266556bb24c2181n;
const RECIPIENT = 0x000000000000000000000000000000000000b5c0n;
const DEPTH = 20;
const E18 = 10n ** 18n;

const poseidon = await buildPoseidon();
const H2 = (a, b) => poseidon.F.toObject(poseidon([a, b]));
const H3 = (a, b, c) => poseidon.F.toObject(poseidon([a, b, c]));

function note(secret, amount, asset) {
  const commitment = H3(secret, amount, asset);
  return { secret, amount, asset, commitment, nullifier: H2(secret, commitment) };
}
const usdt = note(5650000000000000000001n, 100n * E18, USDT);
const bdx = note(5650000000000000000002n, 1_000n * 10n ** 9n, BDX);
const bnb = note(5650000000000000000003n, E18 / 100n, 0n);
const pay = note(5650000000000000000004n, 60n * E18, USDT);
const change = note(5650000000000000000005n, 40n * E18, USDT);
// A valid proof for 100,001 BDX: one over the 100,000 cap, so the vault refuses it on the limit.
const bdxOver = note(5650000000000000000006n, 100_001n * 10n ** 9n, BDX);

// The vault's tree (IncrementalMerkleTreePoseidon): zeros[0] = 0, zeros[i+1] = H2(zeros[i], zeros[i]).
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
  // abi.encode(a, b, c) with b in verifier order, as the IVerifier adapters take it
  return encodeAbiParameters(
    [{ type: "uint256[2]" }, { type: "uint256[2][2]" }, { type: "uint256[2]" }],
    [a.map(BigInt), b.map((r) => r.map(BigInt)), c.map(BigInt)],
  );
}

const hex = (v) => `0x${v.toString(16).padStart(64, "0")}`;
const shieldProof = (n) =>
  prove("shield", { commitment: String(n.commitment), amount: String(n.amount), asset: String(n.asset), secret: String(n.secret) });
async function unshieldProof(n, leaves, index) {
  const p = pathFor(leaves, index);
  const proof = await prove("unshield", {
    root: String(p.root),
    nullifier: String(n.nullifier),
    asset: String(n.asset),
    amount: String(n.amount),
    recipient: String(RECIPIENT),
    secret: String(n.secret),
    pathElements: p.pathElements,
    pathIndices: p.pathIndices,
  });
  return { amount: String(n.amount), nullifier: hex(n.nullifier), root: hex(p.root), proof };
}

const afterDeposits = [usdt.commitment, bdx.commitment, bnb.commitment];
const afterSend = [...afterDeposits, pay.commitment, change.commitment];
const sendPath = pathFor(afterDeposits, 0);

const out = {
  recipient: getAddress(`0x${RECIPIENT.toString(16).padStart(40, "0")}`),
  shieldUsdt: { amount: String(usdt.amount), commitment: hex(usdt.commitment), proof: await shieldProof(usdt) },
  shieldBdx: { amount: String(bdx.amount), commitment: hex(bdx.commitment), proof: await shieldProof(bdx) },
  shieldBnb: { amount: String(bnb.amount), commitment: hex(bnb.commitment), proof: await shieldProof(bnb) },
  shieldBdxOverCap: { amount: String(bdxOver.amount), commitment: hex(bdxOver.commitment), proof: await shieldProof(bdxOver) },
  send: {
    root: hex(sendPath.root),
    nullifier: hex(usdt.nullifier),
    payment: hex(pay.commitment),
    change: hex(change.commitment),
    proof: await prove("transfer", {
      root: String(sendPath.root),
      nullifier: String(usdt.nullifier),
      newCommitment0: String(pay.commitment),
      newCommitment1: String(change.commitment),
      secretIn: String(usdt.secret),
      amountIn: String(usdt.amount),
      asset: String(USDT),
      pathElements: sendPath.pathElements,
      pathIndices: sendPath.pathIndices,
      secretPay: String(pay.secret),
      amountPay: String(pay.amount),
      secretChange: String(change.secret),
      amountChange: String(change.amount),
    }),
  },
  cashOutUsdt: await unshieldProof(pay, afterSend, 3),
  cashOutBdx: await unshieldProof(bdx, afterSend, 1),
  cashOutBnb: await unshieldProof(bnb, afterSend, 2),
};

writeFileSync(OUT, `${JSON.stringify(out, null, 2)}\n`);
console.log("wrote", OUT);
// snarkjs keeps its worker threads open; nothing else is left to do
process.exit(0);
