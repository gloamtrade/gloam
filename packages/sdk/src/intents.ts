/**
 * Canonical Gloam intent shapes — the contract of record shared by the app,
 * the SDK, and the @gloamtrade/mcp agent server.
 *
 * An intent has two layers:
 *   plan  — portable, USD/symbol-denominated, no secrets (matches MCP plan_*).
 *   exec  — resolved on-chain call (wei, addresses, proof args). Optional; built
 *           by the SDK's pure witness/prover helpers. Never carries a secret in
 *           a form that leaves the owner's environment.
 *
 * Public-input orderings below are pinned to the deployed verifiers and MUST NOT
 * drift — they are asserted against ShieldPoolPoseidon and the circom circuits.
 */

import type { Address } from "viem";

export type IntentKind = "shield" | "private_send" | "unshield" | "private_trade";

export type TradeSide = "buy" | "sell";

/** Planning layer — safe to log, safe to hand an agent. No note secrets. */
export interface ShieldPlan {
  asset: string; // symbol, e.g. "ETH"
  usd?: number;
  amountWei?: bigint;
}
export interface PrivateSendPlan {
  asset: string;
  usd?: number;
  amountWei?: bigint;
  to?: Address; // or a receive tag, resolved by the SDK
  tag?: string;
}
export interface UnshieldPlan {
  asset: string;
  usd?: number;
  amountWei?: bigint;
  to: Address;
  /** The vault's cash-out fee, read live (buildUnshieldIntent with a client), and what it keeps and pays out. */
  feeBps?: number;
  feeWei?: bigint;
  receivesWei?: bigint;
}
export interface PrivateTradePlan {
  market: string; // symbol
  side: TradeSide;
  usd?: number;
  amountWei?: bigint;
}

export type PlanFor<K extends IntentKind> = K extends "shield"
  ? ShieldPlan
  : K extends "private_send"
    ? PrivateSendPlan
    : K extends "unshield"
      ? UnshieldPlan
      : PrivateTradePlan;

/** ABI function the exec layer targets on ShieldPoolPoseidon. */
export type PoolFn =
  | "shield"
  | "shieldBound"
  | "unshield"
  | "transfer"
  | "sealedSwap";

/** Resolved on-chain call. Built by the SDK; consumed by an executor (wallet or MCP signer). */
export interface IntentExec {
  poolAddress: Address;
  fn: PoolFn;
  /** ETH value to attach (native shield only). */
  valueWei: bigint;
  /** Encoded call args in ABI order. */
  args: readonly unknown[];
}

/** A full intent: portable plan + honest prose + optional resolved exec. */
export interface GloamIntent<K extends IntentKind = IntentKind> {
  intent: K;
  chainId: number;
  agentAddress: Address | null;
  plan: PlanFor<K>;
  /** Plain-language privacy note (what is and is not hidden). */
  privacy: string;
  /** Plain-language execution note (signed? broadcast? testnet?). */
  execution: string;
  exec?: IntentExec;
}

/**
 * Pinned public-input orderings (contract of record).
 * These match ShieldPoolPoseidon._require*Proof and the circom `main` signals.
 */
export const PUBLIC_INPUTS = {
  /** [root, nullifier, asset, amount, to] */
  unshield: ["root", "nullifier", "asset", "amount", "to"] as const,
  /** [root, nullifier, newCommitment0, newCommitment1] */
  transfer: ["root", "nullifier", "newCommitment0", "newCommitment1"] as const,
  /** [root, nullifier, newCOut, newCChange, assetIn, assetOut, amountOutMin, rateIn, rateOut] */
  sealedSwap: [
    "root",
    "nullifier",
    "newCommitmentOut",
    "newCommitmentChange",
    "assetIn",
    "assetOut",
    "amountOutMin",
    "rateIn",
    "rateOut",
  ] as const,
} as const;
