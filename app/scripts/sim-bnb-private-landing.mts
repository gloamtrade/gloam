/**
 * Bring money over into the private balance on BNB Chain, checked against the
 * live vault without sending anything (app/api/bridge/private, lib/bridge
 * BRIDGE_DESTINATIONS.bnb).
 *
 * When money arrives, Relay's router runs [approve, shieldBound] on the vault.
 * This makes a real shield proof on the ceremony's final keys (the files the
 * app serves, checked against the app's own SHA-256 list) for 10 USDT and
 * 10 USDC in their 18 decimals, asks the vault's own verifier, then eth_calls
 * and estimates the exact shieldBound the private route hands Relay, from
 * Relay's router. The router's token balance and its approval to the vault are
 * written in by state override, standing in for the delivery and the approve
 * that come first. No key is used and nothing is broadcast.
 *
 * On 2026-11-19 both passed: the router is deployed on BNB Chain at the same
 * address as on Robinhood Chain and Tempo, the verifier took both proofs, and
 * shieldBound used about 1.17M gas.
 *
 * Run from app/:  ../mcp/node_modules/.bin/tsx scripts/sim-bnb-private-landing.mts
 * SIM_RPC overrides the public RPC.
 */
import "./browser-shim.mts";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as snarkjs from "snarkjs";
import {
  createPublicClient,
  decodeErrorResult,
  encodeAbiParameters,
  encodeFunctionData,
  http,
  keccak256,
  parseAbi,
  parseUnits,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { makeBoundNotePoseidon, packGroth16Proof, type Groth16Proof } from "@gloamtrade/sdk";

const { shieldPoolAbi } = await import("../src/lib/shield");
const { circuitArtifactsFor } = await import("../src/lib/circuitArtifacts");

const POOL = "0x89d3042390204f57b8b4F8949D3c2203E4002164" as Address;
/** Relay's router: msg.sender of shieldBound on Robinhood Chain and Tempo, the same address on BNB Chain. */
const ROUTER = "0xb92fe925dc43a0ecde6c8b1a2709c170ec4fff4f" as Address;
const ASSETS = [
  ["USDT", "0x55d398326f99059fF775485246999027B3197955"],
  ["USDC", "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d"],
] as const;

const client = createPublicClient({
  transport: http(process.env.SIM_RPC ?? "https://bsc-rpc.publicnode.com", { timeout: 15_000, retryCount: 1 }),
});
const erc20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
]);
const verifierAbi = parseAbi(["function verify(bytes proof, uint256[] publicInputs) view returns (bool)"]);
const shieldBoundAbi = parseAbi(["function shieldBound(address asset, uint256 amount, bytes32 commitment, bytes proof)"]);
const errors = parseAbi([
  "error OverDepositLimit()",
  "error InvalidProof()",
  "error InvalidAmount()",
  "error DuplicateCommitment()",
  "error TransferFailed()",
  "error FeeOnTransferNotSupported()",
  "error Error(string)",
]);

const files = circuitArtifactsFor("production");
const local = (p: string) => fileURLToPath(new URL(`../public${p}`, import.meta.url));
for (const k of ["shieldWasm", "shieldZkey"] as const) {
  const got = createHash("sha256").update(readFileSync(local(files[k].path))).digest("hex");
  if (got !== files[k].sha256) throw new Error(`${files[k].path}: sha256 ${got}, the app expects ${files[k].sha256}`);
}
const vkey = JSON.parse(readFileSync(local("/circuits/final/shield_vkey.json"), "utf8"));

const mapSlot = (key: Address, base: bigint) => keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [key, base]));
const allowSlot = (owner: Address, spender: Address, base: bigint) =>
  keccak256(encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [spender, mapSlot(owner, base)]));

/** The storage base of a token's balance or allowance mapping, found by reading it back under an override. */
async function findSlot(asset: Address, kind: "balance" | "allowance", amount: bigint): Promise<bigint | null> {
  for (const base of [0n, 1n, 2n, 3n, 51n, 52n]) {
    const slot = kind === "balance" ? mapSlot(ROUTER, base) : allowSlot(ROUTER, POOL, base);
    const read = await client
      .readContract({
        address: asset,
        abi: erc20,
        functionName: kind === "balance" ? "balanceOf" : "allowance",
        args: (kind === "balance" ? [ROUTER] : [ROUTER, POOL]) as never,
        stateOverride: [{ address: asset, stateDiff: [{ slot, value: toHex(amount, { size: 32 }) }] }],
      })
      .catch(() => null);
    if (read === amount) return base;
  }
  return null;
}

function why(e: unknown): string {
  let cur = e as { data?: unknown; cause?: unknown } | undefined;
  for (let i = 0; cur && i < 8; i++) {
    const d = cur.data as Hex | { data?: Hex } | undefined;
    const raw = typeof d === "string" ? d : d?.data;
    if (raw && raw.startsWith("0x") && raw.length >= 10) {
      try {
        return decodeErrorResult({ abi: errors, data: raw }).errorName;
      } catch {
        return `revert ${raw.slice(0, 10)}`;
      }
    }
    cur = cur.cause as typeof cur;
  }
  return ((e as { shortMessage?: string }).shortMessage ?? String(e)).split("\n")[0]!;
}

const code = await client.getCode({ address: ROUTER });
console.log(`Relay router ${ROUTER} on BNB Chain: ${code && code.length > 2 ? `a contract, ${(code.length - 2) / 2} bytes` : "NO CODE"}`);
const verifier = (await client.readContract({ address: POOL, abi: shieldPoolAbi, functionName: "shieldVerifier" })) as Address;

let failed = false;
for (const [symbol, asset] of ASSETS) {
  const amount = parseUnits("10", 18);
  const [balanceBase, allowanceBase] = await Promise.all([findSlot(asset, "balance", amount), findSlot(asset, "allowance", amount)]);
  if (balanceBase === null || allowanceBase === null) {
    console.log(`${symbol}: could not place the router's balance or approval in storage`);
    failed = true;
    continue;
  }
  const t0 = performance.now();
  const note = await makeBoundNotePoseidon(amount, asset);
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    { commitment: BigInt(note.commitment).toString(), amount: amount.toString(), asset: BigInt(asset).toString(), secret: BigInt(note.secret).toString() },
    local(files.shieldWasm.path),
    local(files.shieldZkey.path)
  );
  const localOk = await snarkjs.groth16.verify(vkey, publicSignals, proof);
  const proofBytes = packGroth16Proof(proof as Groth16Proof);
  const vaultOk = await client.readContract({
    address: verifier,
    abi: verifierAbi,
    functionName: "verify",
    args: [proofBytes, [BigInt(note.commitment), amount, BigInt(asset)]],
  });
  // The exact call app/api/bridge/private asks Relay to run.
  const data = encodeFunctionData({ abi: shieldBoundAbi, functionName: "shieldBound", args: [asset, amount, note.commitment as Hex, proofBytes] });
  const stateOverride = [
    {
      address: asset as Address,
      stateDiff: [
        { slot: mapSlot(ROUTER, balanceBase), value: toHex(amount, { size: 32 }) },
        { slot: allowSlot(ROUTER, POOL, allowanceBase), value: toHex(amount, { size: 32 }) },
      ],
    },
  ];
  const head = `${symbol} 10 (18 decimals): proof in ${((performance.now() - t0) / 1000).toFixed(1)} s, verifies locally ${localOk}, by the vault's verifier ${vaultOk}`;
  try {
    await client.call({ account: ROUTER, to: POOL, data, stateOverride });
    const gas = await client.estimateGas({ account: ROUTER, to: POOL, data, stateOverride });
    console.log(`${head}; shieldBound from Relay's router: eth_call OK, gas ${gas}`);
    if (!localOk || !vaultOk) failed = true;
  } catch (e) {
    console.log(`${head}; shieldBound from Relay's router reverts: ${why(e)}`);
    failed = true;
  }
}
// snarkjs keeps its worker threads alive: leave once the report is out
process.exit(failed ? 1 : 0);
