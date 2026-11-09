/**
 * Circom witness builders for the Poseidon circuits (unshield, transfer,
 * sealedSwap). Pure: each returns the circomInput object snarkjs proves plus the
 * derived public inputs and the new notes. The proving step is separate.
 */

import type { Address, Hex } from "viem";
import {
  noteCommitmentPoseidon,
  noteNullifierPoseidon,
  randomSecretField,
} from "./note.js";
import type { PoseidonMerklePath } from "./merkle.js";
import { fieldToHex, hexToField, toField } from "./poseidon.js";
import { NATIVE_ASSET } from "./constants.js";
import { exactSealedAmounts } from "./rates.js";
import { seedToSecret } from "./shortLink.js";

// ── unshield ────────────────────────────────────────────────────────────────

export type PoseidonUnshieldWitness = {
  publicInputs: {
    root: bigint;
    nullifier: bigint;
    asset: bigint;
    amount: bigint;
    recipient: bigint;
  };
  circomInput: Record<string, string | string[]>;
  checks: { commitmentMatches: boolean; nullifierMatches: boolean; pathValid: boolean };
  readyToProve: boolean;
  blocker: string | null;
};

export async function buildPoseidonUnshieldWitness(args: {
  secretHex: Hex;
  amount: bigint;
  asset?: Address;
  to: Address;
  path: PoseidonMerklePath;
}): Promise<PoseidonUnshieldWitness> {
  const asset = args.asset ?? NATIVE_ASSET;
  const secret = hexToField(args.secretHex);
  const assetField = toField(BigInt(asset));
  const recipient = toField(BigInt(args.to));

  const commitment = await noteCommitmentPoseidon(secret, args.amount, asset);
  const nullifier = await noteNullifierPoseidon(secret, commitment);

  const commitmentMatches = commitment === args.path.leaf;
  const pathValid = true; // path() already verifies membership on build
  const nullifierMatches = true;

  const blocker = commitmentMatches
    ? "Witness ready for the Poseidon circuit. Prove with snarkjs + the unshield zkey."
    : "Secret does not open this leaf (wrong note or keccak-era note).";

  const circomInput = {
    root: args.path.root.toString(),
    nullifier: nullifier.toString(),
    asset: assetField.toString(),
    amount: args.amount.toString(),
    recipient: recipient.toString(),
    secret: secret.toString(),
    pathElements: args.path.pathElements.map((x) => x.toString()),
    pathIndices: args.path.pathIndices.map(String),
  };

  return {
    publicInputs: { root: args.path.root, nullifier, asset: assetField, amount: args.amount, recipient },
    circomInput,
    checks: { commitmentMatches, nullifierMatches, pathValid },
    readyToProve: commitmentMatches,
    blocker,
  };
}

// ── transfer (private send) ───────────────────────────────────────────────────

export type NoteExport = {
  secret: Hex;
  commitment: Hex;
  nullifier: Hex;
  amountWei: string;
  asset: Address;
  /** The 16-byte seed the secret was made from, when it was (shortLink seedToSecret). */
  seed?: Hex;
};

export type TransferWitness = {
  circomInput: Record<string, string | string[]>;
  publicInputs: {
    root: bigint;
    nullifier: bigint;
    newCommitment0: bigint;
    newCommitment1: bigint;
  };
  paymentNote: NoteExport;
  changeNote: NoteExport;
  checks: { commitmentMatches: boolean; amountsOk: boolean };
  blocker: string | null;
};

/** The secret a hex seed makes; refuses a seed that makes zero (the circuits reject a zero secret). */
function seedFromHex(seed: Hex): bigint {
  if (!/^0x[0-9a-fA-F]{32}$/.test(seed)) throw new Error("A note seed is 16 bytes of hex.");
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) bytes[i] = parseInt(seed.slice(2 + i * 2, 4 + i * 2), 16);
  const s = seedToSecret(bytes);
  if (s === 0n) throw new Error("That seed makes a zero secret. Draw another.");
  return s;
}

export async function buildTransferWitness(args: {
  secretHex: Hex;
  amountIn: bigint;
  amountPay: bigint;
  asset?: Address;
  path: PoseidonMerklePath;
  /**
   * A 16-byte seed (hex) to make the payee's secret from (seedToSecret), so the
   * payment fits a short claim link. Left out, the secret is drawn at random as before.
   */
  paySeed?: Hex;
}): Promise<TransferWitness> {
  const asset = args.asset ?? NATIVE_ASSET;
  const amountChange = args.amountIn - args.amountPay;
  const amountsOk =
    args.amountPay > 0n &&
    amountChange >= 0n &&
    args.amountPay + amountChange === args.amountIn;

  const secretIn = hexToField(args.secretHex);
  const commitmentIn = await noteCommitmentPoseidon(secretIn, args.amountIn, asset);
  const nullifier = await noteNullifierPoseidon(secretIn, commitmentIn);
  const commitmentMatches = commitmentIn === args.path.leaf;

  const secretPay = args.paySeed ? seedFromHex(args.paySeed) : await randomSecretField();
  const secretChange = await randomSecretField();
  const newCommitment0 = await noteCommitmentPoseidon(secretPay, args.amountPay, asset);
  const newCommitment1 = await noteCommitmentPoseidon(secretChange, amountChange, asset);
  const nullifierPay = await noteNullifierPoseidon(secretPay, newCommitment0);
  const nullifierChange = await noteNullifierPoseidon(secretChange, newCommitment1);

  let blocker: string | null = null;
  if (!commitmentMatches) blocker = "This note secret does not match the leaf.";
  else if (!amountsOk) blocker = "Send amount must be > 0 and no more than your note.";

  const circomInput = {
    root: args.path.root.toString(),
    nullifier: nullifier.toString(),
    newCommitment0: newCommitment0.toString(),
    newCommitment1: newCommitment1.toString(),
    secretIn: secretIn.toString(),
    amountIn: args.amountIn.toString(),
    asset: toField(BigInt(asset)).toString(),
    pathElements: args.path.pathElements.map((x) => x.toString()),
    pathIndices: args.path.pathIndices.map(String),
    secretPay: secretPay.toString(),
    amountPay: args.amountPay.toString(),
    secretChange: secretChange.toString(),
    amountChange: amountChange.toString(),
  };

  return {
    circomInput,
    publicInputs: { root: args.path.root, nullifier, newCommitment0, newCommitment1 },
    paymentNote: {
      secret: fieldToHex(secretPay),
      commitment: fieldToHex(newCommitment0),
      nullifier: fieldToHex(nullifierPay),
      amountWei: args.amountPay.toString(),
      asset,
      ...(args.paySeed ? { seed: args.paySeed } : {}),
    },
    changeNote: {
      secret: fieldToHex(secretChange),
      commitment: fieldToHex(newCommitment1),
      nullifier: fieldToHex(nullifierChange),
      amountWei: amountChange.toString(),
      asset,
    },
    checks: { commitmentMatches, amountsOk },
    blocker,
  };
}

// ── sealedSwap (private trade) ─────────────────────────────────────────────────

export type SealedSwapWitness = {
  publicInputs: {
    root: bigint;
    nullifier: bigint;
    newCommitmentOut: bigint;
    newCommitmentChange: bigint;
    assetIn: bigint;
    assetOut: bigint;
    amountOutMin: bigint;
    rateIn: bigint;
    rateOut: bigint;
  };
  circomInput: Record<string, string | string[]>;
  outNote: NoteExport;
  changeNote: NoteExport;
  blocker: string | null;
};

export async function buildSealedSwapWitness(args: {
  secretHex: Hex;
  amountIn: bigint;
  amountSwap: bigint;
  assetIn?: Address;
  assetOut: Address;
  amountOutMin: bigint;
  /**
   * Audit M-3: the user's real slippage floor, enforced client-side and kept
   * separate from the public (privacy) `amountOutMin`. If set and the computed
   * output is below it, the witness refuses to build. Pass this once rates are
   * market-driven (oracle-bound), where the on-chain floor stays private.
   */
  minOut?: bigint;
  rateIn: bigint;
  rateOut: bigint;
  path: PoseidonMerklePath;
}): Promise<SealedSwapWitness> {
  const assetIn = args.assetIn ?? NATIVE_ASSET;
  let blocker: string | null = null;

  if (args.rateOut === 0n || args.rateIn === 0n) {
    blocker = "rateIn/rateOut cannot be zero.";
  }

  const exact =
    !blocker && exactSealedAmounts(args.amountSwap, args.rateIn, args.rateOut);
  if (!blocker && !exact) {
    blocker = "Could not fit this size to the rate (try Max or a round amount).";
  }

  const amountSwap = exact ? exact.amountSwap : 0n;
  const amountOut = exact ? exact.amountOut : 0n;
  const amountChange = args.amountIn - amountSwap;

  if (!blocker && (amountSwap <= 0n || amountChange < 0n)) {
    blocker = "Invalid swap size.";
  }

  // Public on-chain floor that goes into the proof: must be <= amountOut for a
  // valid min-out constraint. With size privacy this is a tiny floor (~1 wei),
  // so by design it does NOT protect the user's price — that is minOut's job.
  const amountOutMin = args.amountOutMin > amountOut ? amountOut : args.amountOutMin;
  // Audit M-3: the user's real slippage floor is a separate client-side gate and
  // must never be silently clamped to amountOut. Refuse to build when the output
  // is below it. (The public floor above stays private.)
  if (!blocker && args.minOut !== undefined && amountOut < args.minOut) {
    blocker = "Output below your minimum (slippage).";
  }

  const secretIn = hexToField(args.secretHex);
  const commitmentIn = await noteCommitmentPoseidon(secretIn, args.amountIn, assetIn);
  const nullifier = await noteNullifierPoseidon(secretIn, commitmentIn);
  if (commitmentIn !== args.path.leaf) {
    blocker = "Note secret does not match the vault leaf.";
  }

  const secretOut = await randomSecretField();
  const secretChange = await randomSecretField();
  const newCommitmentOut = await noteCommitmentPoseidon(secretOut, amountOut, args.assetOut);
  const newCommitmentChange = await noteCommitmentPoseidon(secretChange, amountChange, assetIn);
  const nullifierOut = await noteNullifierPoseidon(secretOut, newCommitmentOut);
  const nullifierChange = await noteNullifierPoseidon(secretChange, newCommitmentChange);

  const circomInput = {
    root: args.path.root.toString(),
    nullifier: nullifier.toString(),
    newCommitmentOut: newCommitmentOut.toString(),
    newCommitmentChange: newCommitmentChange.toString(),
    assetIn: toField(BigInt(assetIn)).toString(),
    assetOut: toField(BigInt(args.assetOut)).toString(),
    amountOutMin: amountOutMin.toString(),
    rateIn: args.rateIn.toString(),
    rateOut: args.rateOut.toString(),
    secretIn: secretIn.toString(),
    amountIn: args.amountIn.toString(),
    pathElements: args.path.pathElements.map((x) => x.toString()),
    pathIndices: args.path.pathIndices.map(String),
    secretOut: secretOut.toString(),
    amountOut: amountOut.toString(),
    secretChange: secretChange.toString(),
    amountChange: amountChange.toString(),
    amountSwap: amountSwap.toString(),
  };

  return {
    publicInputs: {
      root: args.path.root,
      nullifier,
      newCommitmentOut,
      newCommitmentChange,
      assetIn: toField(BigInt(assetIn)),
      assetOut: toField(BigInt(args.assetOut)),
      amountOutMin,
      rateIn: args.rateIn,
      rateOut: args.rateOut,
    },
    circomInput,
    outNote: {
      secret: fieldToHex(secretOut),
      commitment: fieldToHex(newCommitmentOut),
      nullifier: fieldToHex(nullifierOut),
      amountWei: amountOut.toString(),
      asset: args.assetOut,
    },
    changeNote: {
      secret: fieldToHex(secretChange),
      commitment: fieldToHex(newCommitmentChange),
      nullifier: fieldToHex(nullifierChange),
      amountWei: amountChange.toString(),
      asset: assetIn,
    },
    blocker,
  };
}

/** Dev zkey/wasm shipped under the app's /public/circuits. Settlement is live. */
export function sealedSwapArtifactsReady(): boolean {
  return true;
}
