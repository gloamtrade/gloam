/**
 * Browser snarkjs fullProve for the Poseidon circuits (shield, unshield,
 * transfer). Artifacts under /public/circuits, with the trusted setup's final
 * keys under /public/circuits/final for mainnet. Proof packing and field helpers come from @gloamtrade/sdk; this file
 * is the browser-specific proving glue.
 */

import type { Hex } from "viem";
import { packGroth16Proof, type Groth16Proof } from "@gloamtrade/sdk";
import {
  assertShieldArtifacts,
  assertTransferArtifacts,
  assertUnshieldArtifacts,
  activeCircuitArtifacts,
} from "./circuitArtifacts";
import { readDemo } from "./demoFlag";
import { demoProve } from "./demo/proof";

export { fieldToBytes32 } from "@gloamtrade/sdk";
export type { Groth16Proof };

// The network's key set decides the files, so read them at prove time (lib/circuitArtifacts).
const files = () => activeCircuitArtifacts();

let proving = 0;

/** A proof is being made in this tab right now: background work (lib/cashOutReprove) waits its turn. */
export function provingNow(): boolean {
  return proving > 0;
}

async function fullProve(
  circomInput: Record<string, string | string[]>,
  wasm: string,
  zkey: string
): Promise<{ proofBytes: Hex; publicSignals: string[]; proof: Groth16Proof }> {
  const snarkjs = await import("snarkjs");
  proving++;
  let made: Awaited<ReturnType<typeof snarkjs.groth16.fullProve>>;
  try {
    made = await snarkjs.groth16.fullProve(circomInput, wasm, zkey);
  } finally {
    proving--;
  }
  const { proof, publicSignals } = made;
  return {
    proofBytes: packGroth16Proof(proof as Groth16Proof),
    publicSignals: publicSignals as string[],
    proof: proof as Groth16Proof,
  };
}

export async function proveUnshieldInBrowser(
  circomInput: Record<string, string | string[]>
) {
  // Recording demo: no proof is built, it only takes as long as one.
  if (readDemo()) return demoProve(circomInput);
  await assertUnshieldArtifacts();
  return fullProve(circomInput, files().unshieldWasm.path, files().unshieldZkey.path);
}

export async function proveTransferInBrowser(
  circomInput: Record<string, string | string[]>
) {
  if (readDemo()) return demoProve(circomInput);
  await assertTransferArtifacts();
  return fullProve(circomInput, files().transferWasm.path, files().transferZkey.path);
}

/**
 * Prove shield (C1): binds commitment == Poseidon(secret, amount, asset) at
 * deposit. Public [commitment, amount, asset] — order matches shield.circom and
 * ShieldPoolPoseidon.shieldBound. Only needed when the pool has a shieldVerifier.
 */
export async function proveShieldInBrowser(
  circomInput: Record<string, string | string[]>
) {
  if (readDemo()) return demoProve(circomInput, ["commitment", "amount", "asset"]);
  await assertShieldArtifacts();
  return fullProve(circomInput, files().shieldWasm.path, files().shieldZkey.path);
}
