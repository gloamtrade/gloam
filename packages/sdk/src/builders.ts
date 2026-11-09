/**
 * Intent builders. Each returns an unsigned GloamIntent an app or agent can
 * inspect, then sign and broadcast. The plan layer is portable; the exec layer
 * is the resolved on-chain call.
 *
 * shieldBound (live deposit), unshield (cash out), and private_send (in-vault
 * transfer) each build a witness, generate a Groth16 proof via the injected
 * prover, and resolve to a signed-ready call. private_trade (sealedSwap) is the
 * old sealed trade, retired: its on-chain path reverts on every live pool. Private
 * swaps are buildSwapIntent (swapIntent.ts).
 *
 * Network: every builder takes `chainId` (default Robinhood Chain testnet, as
 * in 0.0.x) and `poolAddress` (default: Gloam's pool on that chain). For
 * mainnet, pass the mainnet network's chainId (see mainnetNetwork()); a mainnet
 * (or Base Sepolia) whose pool is not in this SDK version is refused rather
 * than guessed, and so is a mainnet vault, or Ethereum Sepolia's, passed with
 * no chainId. Prove with the key set of the same chain:
 * circuitArtifactUrls(circuit, chainId).
 */

import type { Address } from "viem";
import {
  NATIVE_ASSET,
  RH_TESTNET_CHAIN_ID,
  assertDepositAllowed,
  cashOutTargetProblem,
  isPaymentsPoolChainId,
  networkName,
  poolForChainId,
} from "./constants.js";
import { ETHEREUM_SEPOLIA_POOL, MAINNET_POOLS } from "./mainnet.js";
import { makeBoundNotePoseidon, type BoundNote } from "./note.js";
import type { GloamIntent, IntentExec, TradeSide } from "./intents.js";
import type { PoseidonMerklePath } from "./merkle.js";
import { fieldToBytes32 } from "./proof.js";
import { assertDepositWithinLiveLimit, type DepositLimitReader } from "./limits.js";
import { cashOutFeeLive, type FeeReader } from "./fee.js";
import type { Prover } from "./prove.js";
import { toField } from "./poseidon.js";
import {
  buildPoseidonUnshieldWitness,
  buildTransferWitness,
  buildSealedSwapWitness,
  type NoteExport,
} from "./witness.js";

const isNativeAsset = (a: Address) =>
  a.toLowerCase() === NATIVE_ASSET.toLowerCase();

const isMainnetVault = (pool: Address) =>
  Object.values(MAINNET_POOLS).some((m) => m.pool?.toLowerCase() === pool.toLowerCase());

const isEthereumSepoliaVault = (pool: Address) =>
  ETHEREUM_SEPOLIA_POOL.pool?.toLowerCase() === pool.toLowerCase();

/**
 * The chain a builder runs on: `chainId`, or Robinhood Chain testnet when it is
 * left out. A mainnet vault has the same address on every mainnet (and Base
 * Sepolia), so it can't name its chain, and the testnet default would be wrong
 * for it: refused. Ethereum Sepolia's vault is refused the same way, since the
 * default is a different chain, as a Base Sepolia pool is.
 */
function resolveChainId(params: { chainId?: number; poolAddress?: Address }): number {
  if (params.chainId != null) return params.chainId;
  if (params.poolAddress && isMainnetVault(params.poolAddress)) {
    throw new Error(
      `${params.poolAddress} is Gloam's vault on every mainnet, so it doesn't say which chain this is for. Pass chainId too (see mainnetNetwork()).`
    );
  }
  if (params.poolAddress && isEthereumSepoliaVault(params.poolAddress)) {
    throw new Error(
      `${params.poolAddress} is Gloam's vault on Ethereum Sepolia, not on the default chain. Pass chainId too (see testnetNetwork("ethereum")).`
    );
  }
  return RH_TESTNET_CHAIN_ID;
}

export interface ShieldIntentParams {
  /** Amount to shield, in wei (native) or token base units. */
  amountWei: bigint;
  /** Asset address. Defaults to native ETH (zero address). */
  asset?: Address;
  /** Chain to deposit on. Defaults to Robinhood Chain testnet (46630). */
  chainId?: number;
  /** Pool to deposit into. Defaults to Gloam's pool on `chainId`. */
  poolAddress?: Address;
  agentAddress?: Address | null;
}

export interface ShieldIntent extends GloamIntent<"shield"> {
  /** The freshly minted note. The caller MUST persist `note.secret` to spend later. */
  note: BoundNote;
  /** Builders always resolve the call, so `exec` is guaranteed here. */
  exec: IntentExec;
}

/**
 * Build an unsigned shield (deposit) intent. Computes the Poseidon note
 * commitment that binds (secret, amount, asset) and the exec args for
 * ShieldPoolPoseidon.shield(asset, amount, commitment).
 */
export async function buildShieldIntent(
  params: ShieldIntentParams
): Promise<ShieldIntent> {
  if (params.amountWei <= 0n) throw new Error("amountWei must be positive");
  const chainId = resolveChainId(params);
  if (isPaymentsPoolChainId(chainId)) {
    throw new Error(`Plain shield() is off on ${networkName(chainId)}: the pool takes deposits with a proof only. Use buildShieldBoundIntent.`);
  }
  const asset = params.asset ?? NATIVE_ASSET;
  const isNative = isNativeAsset(asset);
  const poolAddress = params.poolAddress ?? poolForChainId(chainId);
  const note = await makeBoundNotePoseidon(params.amountWei, asset);

  return {
    intent: "shield",
    chainId,
    agentAddress: params.agentAddress ?? null,
    plan: {
      asset: isNative ? "ETH" : asset,
      amountWei: params.amountWei,
    },
    privacy:
      "Shielding is a public deposit: the amount and asset are visible on-chain. The note commitment hides who can later spend it, so future private sends and trades are unlinkable to this deposit.",
    execution:
      `Unsigned. Sign and broadcast shield(asset, amount, commitment) on ${networkName(chainId)}; attach msg.value for native ETH. Persist note.secret to spend later.`,
    exec: {
      poolAddress,
      fn: "shield",
      valueWei: isNative ? params.amountWei : 0n,
      args: [asset, params.amountWei, note.commitment],
    },
    note,
  };
}

export interface ShieldBoundIntentParams extends ShieldIntentParams {
  /**
   * Injected shield prover bound to the shield circuit artifacts
   * (artifactProver({ wasm, zkey })). Required because the hardened pool enforces
   * a proof at deposit.
   */
  prover: Prover;
  /**
   * Reads the vault's live deposit limits (a viem PublicClient on this chain), so a
   * deposit over them is refused before any proof is made. Left out, or when
   * the read fails, the amount is not checked here and the vault enforces it.
   */
  client?: DepositLimitReader;
}

/**
 * Build a hardened shield intent for a pool whose shieldVerifier is set (audit
 * C1). Mints the note AND generates the shield proof binding the commitment to
 * (amount, asset), then resolves shieldBound(asset, amount, commitment, proof).
 * Use this on every live Gloam pool, mainnet and testnet: plain shield()
 * reverts there (ShieldProofRequired). On mainnet, the asset must be one the
 * pool lists and the amount within its deposit limits; with a `client`, both are
 * read live from the vault before any proof is made.
 */
export async function buildShieldBoundIntent(
  params: ShieldBoundIntentParams
): Promise<ShieldIntent> {
  if (params.amountWei <= 0n) throw new Error("amountWei must be positive");
  const chainId = resolveChainId(params);
  const asset = params.asset ?? NATIVE_ASSET;
  const isNative = isNativeAsset(asset);
  const poolAddress = params.poolAddress ?? poolForChainId(chainId);
  // The vault's own answer when it can be read: it also covers an asset added after this release.
  const live = params.client
    ? await assertDepositWithinLiveLimit(params.client, chainId, asset, params.amountWei, poolAddress)
    : null;
  if (!live || !live.on) assertDepositAllowed(chainId, asset, params.amountWei);
  const note = await makeBoundNotePoseidon(params.amountWei, asset);
  const { proofBytes } = await params.prover({
    commitment: note.commitmentField.toString(),
    amount: params.amountWei.toString(),
    asset: toField(BigInt(asset)).toString(),
    secret: note.secretField.toString(),
  });

  return {
    intent: "shield",
    chainId,
    agentAddress: params.agentAddress ?? null,
    plan: {
      asset: isNative ? "ETH" : asset,
      amountWei: params.amountWei,
    },
    privacy:
      "Shielding is a public deposit: the amount and asset are visible on-chain. The note commitment hides who can later spend it, so future private sends and trades are unlinkable to this deposit.",
    execution: `Unsigned. Sign and broadcast shieldBound(asset, amount, commitment, proof) on ${networkName(chainId)}${
      isNative ? "; attach msg.value for native ETH" : ", after approving the pool to pull the token"
    }. Persist note.secret to spend later.`,
    exec: {
      poolAddress,
      fn: "shieldBound",
      valueWei: isNative ? params.amountWei : 0n,
      args: [asset, params.amountWei, note.commitment, proofBytes],
    },
    note,
  };
}

// ── unshield (cash out) ───────────────────────────────────────────────────────

export interface UnshieldIntentParams {
  secretHex: `0x${string}`;
  amountWei: bigint;
  asset?: Address;
  to: Address;
  path: PoseidonMerklePath;
  prove: Prover;
  poolAddress?: Address;
  chainId?: number;
  agentAddress?: Address | null;
  /**
   * Reads the vault's cash-out fee live (a viem PublicClient on this chain), so the
   * plan says what the vault keeps and what `to` receives. Left out, the plan has no fee.
   */
  client?: FeeReader;
}

/** Build a signed-ready unshield intent. exec.args match unshield(proof, root, nullifier, asset, to, amount). */
export async function buildUnshieldIntent(
  params: UnshieldIntentParams
): Promise<GloamIntent<"unshield"> & { exec: IntentExec }> {
  const asset = params.asset ?? NATIVE_ASSET;
  const chainId = resolveChainId(params);
  const poolAddress = params.poolAddress ?? poolForChainId(chainId);
  // Checked before proving: a cash out to one of these addresses would be lost.
  const problem = cashOutTargetProblem(params.to, { chainId, pool: poolAddress });
  if (problem) throw new Error(problem);
  const w = await buildPoseidonUnshieldWitness({
    secretHex: params.secretHex,
    amount: params.amountWei,
    asset,
    to: params.to,
    path: params.path,
  });
  if (!w.readyToProve) throw new Error(w.blocker ?? "unshield witness not ready");
  // the fee the vault charges now, when it can be read; the vault applies its own either way
  const fee =
    params.client && isPaymentsPoolChainId(chainId) ? await cashOutFeeLive(params.client, poolAddress, params.amountWei).catch(() => null) : null;
  const { proofBytes } = await params.prove(w.circomInput);

  return {
    intent: "unshield",
    chainId,
    agentAddress: params.agentAddress ?? null,
    plan: {
      asset: isNativeAsset(asset) ? "ETH" : asset,
      amountWei: params.amountWei,
      to: params.to,
      ...(fee ? { feeBps: fee.feeBps, feeWei: fee.fee, receivesWei: fee.receives } : {}),
    },
    privacy:
      "Unshield is the public exit: the amount, asset, and recipient become visible. The nullifier keeps the source note unlinkable to your other activity.",
    execution: `Unsigned. Sign and broadcast unshield(proof, root, nullifier, asset, to, amount) on ${networkName(chainId)}.${
      isPaymentsPoolChainId(chainId)
        ? ` The pool keeps its cash-out fee (${fee ? `${fee.feeBps / 100}% now` : "readCashOutFeeBps reads it"}) at the rate when this lands, and sends the rest to the recipient.`
        : ""
    }`,
    exec: {
      poolAddress,
      fn: "unshield",
      valueWei: 0n,
      args: [
        proofBytes,
        fieldToBytes32(w.publicInputs.root),
        fieldToBytes32(w.publicInputs.nullifier),
        asset,
        params.to,
        params.amountWei,
      ],
    },
  };
}

// ── private send (transfer) ───────────────────────────────────────────────────

export interface PrivateSendIntentParams {
  secretHex: `0x${string}`;
  amountInWei: bigint;
  amountPayWei: bigint;
  asset?: Address;
  path: PoseidonMerklePath;
  prove: Prover;
  poolAddress?: Address;
  chainId?: number;
  agentAddress?: Address | null;
}

export interface PrivateSendIntent extends GloamIntent<"private_send"> {
  /** Payment note to hand the recipient; change note stays with the sender. */
  paymentNote: NoteExport;
  changeNote: NoteExport;
  exec: IntentExec;
}

/** Build a signed-ready private-send intent. exec.args match transfer(proof, root, nullifier, [c0, c1]). */
export async function buildPrivateSendIntent(
  params: PrivateSendIntentParams
): Promise<PrivateSendIntent> {
  const asset = params.asset ?? NATIVE_ASSET;
  const chainId = resolveChainId(params);
  const poolAddress = params.poolAddress ?? poolForChainId(chainId);
  const w = await buildTransferWitness({
    secretHex: params.secretHex,
    amountIn: params.amountInWei,
    amountPay: params.amountPayWei,
    asset,
    path: params.path,
  });
  if (w.blocker) throw new Error(w.blocker);
  const { proofBytes } = await params.prove(w.circomInput);

  return {
    intent: "private_send",
    chainId,
    agentAddress: params.agentAddress ?? null,
    plan: { asset: isNativeAsset(asset) ? "ETH" : asset, amountWei: params.amountPayWei },
    privacy:
      "Private send stays inside the vault: no public transfer, no visible amount. The recipient opens the payment note; the change note stays with you.",
    execution: `Unsigned. Sign and broadcast transfer(proof, root, nullifier, [c0, c1]) on ${networkName(chainId)}, then hand the payment note to the recipient (or post it via GloamPayMemo where the network has one).`,
    exec: {
      poolAddress,
      fn: "transfer",
      valueWei: 0n,
      args: [
        proofBytes,
        fieldToBytes32(w.publicInputs.root),
        fieldToBytes32(w.publicInputs.nullifier),
        [
          fieldToBytes32(w.publicInputs.newCommitment0),
          fieldToBytes32(w.publicInputs.newCommitment1),
        ],
      ],
    },
    paymentNote: w.paymentNote,
    changeNote: w.changeNote,
  };
}

// ── private trade (sealedSwap) ────────────────────────────────────────────────

export interface PrivateTradeIntentParams {
  secretHex: `0x${string}`;
  amountInWei: bigint;
  amountSwapWei: bigint;
  assetIn?: Address;
  assetOut: Address;
  amountOutMinWei: bigint;
  rateIn: bigint;
  rateOut: bigint;
  side?: TradeSide;
  market?: string;
  path: PoseidonMerklePath;
  prove: Prover;
  poolAddress?: Address;
  chainId?: number;
  agentAddress?: Address | null;
}

export interface PrivateTradeIntent extends GloamIntent<"private_trade"> {
  outNote: NoteExport;
  changeNote: NoteExport;
  exec: IntentExec;
}

/**
 * Build a signed-ready private-trade intent. exec.args match
 * sealedSwap(proof, root, nullifier, cOut, cChange, assetIn, assetOut, amountOutMin, rateIn, rateOut).
 */
export async function buildPrivateTradeIntent(
  params: PrivateTradeIntentParams
): Promise<PrivateTradeIntent> {
  const assetIn = params.assetIn ?? NATIVE_ASSET;
  const chainId = resolveChainId(params);
  if (isPaymentsPoolChainId(chainId)) {
    throw new Error(`Private trading is not on ${networkName(chainId)}: the pool there takes payments only.`);
  }
  const poolAddress = params.poolAddress ?? poolForChainId(chainId);
  const w = await buildSealedSwapWitness({
    secretHex: params.secretHex,
    amountIn: params.amountInWei,
    amountSwap: params.amountSwapWei,
    assetIn,
    assetOut: params.assetOut,
    amountOutMin: params.amountOutMinWei,
    rateIn: params.rateIn,
    rateOut: params.rateOut,
    path: params.path,
  });
  if (w.blocker) throw new Error(w.blocker);
  const { proofBytes } = await params.prove(w.circomInput);

  return {
    intent: "private_trade",
    chainId,
    agentAddress: params.agentAddress ?? null,
    plan: {
      market: params.market ?? params.assetOut,
      side: params.side ?? "buy",
    },
    privacy:
      "Private trade keeps the size off the open book: on-chain min-out is a floor, not your real amount. The explorer sees a proof and an asset pair, never how much.",
    execution: `Unsigned. sealedSwap(proof, root, nullifier, cOut, cChange, assetIn, assetOut, amountOutMin, rateIn, rateOut) on ${networkName(chainId)}. Private trading is switched off on every live pool, so this call reverts there today.`,
    exec: {
      poolAddress,
      fn: "sealedSwap",
      valueWei: 0n,
      args: [
        proofBytes,
        fieldToBytes32(w.publicInputs.root),
        fieldToBytes32(w.publicInputs.nullifier),
        fieldToBytes32(w.publicInputs.newCommitmentOut),
        fieldToBytes32(w.publicInputs.newCommitmentChange),
        assetIn,
        params.assetOut,
        w.publicInputs.amountOutMin,
        w.publicInputs.rateIn,
        w.publicInputs.rateOut,
      ],
    },
    outNote: w.outNote,
    changeNote: w.changeNote,
  };
}
