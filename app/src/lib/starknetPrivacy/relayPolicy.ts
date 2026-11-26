/**
 * What Gloam's Starknet relay will send. The relay's account pays every
 * transaction's STRK, so it sends one call per transaction, of exactly one of
 * these three shapes, and refuses everything else. Pure rules, checked by
 * scripts/selftest-starknet-core.mts.
 *
 *  1. deploy: the Universal Deployer's deploy_contract for Gloam's one account
 *     class, salt = the constructor's public key, not unique, constructor
 *     [public key]. Nothing else can be deployed on the relay's STRK, and the
 *     address is the one lib/starknetPrivacy/account computes for that key.
 *
 *  2. approve: execute_from_outside_v2 on a person's account (SNIP-9), whose
 *     signed outside execution names the relay as its only caller, expires
 *     within MAX_OUTSIDE_WINDOW_S, and holds exactly one call:
 *     token.approve(pool, amount) for a listed token, 0 < amount <= the
 *     network's cap, high word 0. The account pays nothing (the relay sends),
 *     and the approve can only let the pool take the account's own tokens,
 *     which only an add the account proves can do. The route also checks the
 *     account's class on chain before sending (not pure, so not here).
 *
 *  3. apply: the pool's apply_actions with proof facts and a proof (devnet's
 *     mock prover leaves the proof empty, so only devnet takes none). Its server
 *     actions are decoded and must carry no Invoke or InvokeWithComputation (no
 *     external call rides on the relay's STRK), move only listed tokens, stay
 *     under MAX_ACTIONS, and, when the relay asks a fee, withdraw at least that
 *     fee of a listed token to the relay itself. The pool takes its own STRK
 *     fee (get_fee_amount) from its caller: the route (lib/starknetPrivacy/server
 *     relaySend) reads it, refuses one above the relay's cap, and wraps the apply
 *     in approve(pool, exactly that fee) and approve(pool, 0) in the same
 *     transaction, so the pool can take that fee and nothing after it.
 *     The decision names the deposit's screening attestation time (mainnet's
 *     pool takes one only while it is under 300 seconds old), so a stale one is
 *     refused before the relay pays for a transaction that reverts.
 */
import { CallData, hash, num, type Call, type RawArgsObject } from "starknet";
import { PrivacyPoolABI } from "@starkware-libs/starknet-privacy-sdk/abi";
import { listedToken, sameStarknetAddress, type StarknetNetworkConfig } from "./config";

/** An outside execution may run for at most this long after the relay gets it. */
export const MAX_OUTSIDE_WINDOW_S = 3_600;
/** Most server actions one apply_actions may carry (a payment with change and a fee is under 20). */
export const MAX_ACTIONS = 64;
/** At most this many signature felts on an outside execution (an OpenZeppelin account signs with 2). */
const MAX_SIGNATURE_FELTS = 4;

const FELT_MAX = (1n << 251n) + 17n * (1n << 192n); // the Stark prime; a felt is below it
const U128 = 1n << 128n;

export const APPROVE_SELECTOR = hash.getSelectorFromName("approve");
export const OUTSIDE_V2_ENTRYPOINT = "execute_from_outside_v2";
export const APPLY_ENTRYPOINT = "apply_actions";

export type RelayContext = {
  cfg: Pick<StarknetNetworkConfig, "network" | "pool" | "tokens" | "udc" | "accountClassHash">;
  /** The relay's own account address. */
  relay: string;
  /** Unix seconds. */
  now: number;
  /** Most an approve may allow, per token address (lowercase hex); a token missing here can't be approved. */
  maxApprove: Record<string, bigint>;
  /** Least fee an apply must withdraw to the relay, per token address; empty or 0 = no fee asked. */
  minFee?: Record<string, bigint>;
};

export type RelayProof = { proofFacts: readonly string[]; proof: string };

export type RelayDecision =
  | { ok: true; kind: "deploy"; publicKey: string }
  | { ok: true; kind: "approve"; account: string; token: string; amount: bigint }
  | {
      ok: true;
      kind: "apply";
      fee: { token: string; amount: bigint } | null;
      deposits: number;
      withdrawals: number;
      /** The screening attestation's issued_at (unix seconds), or null when the call carries none. */
      attestedAt: number | null;
    }
  | { ok: false; reason: string };

const no = (reason: string): RelayDecision => ({ ok: false, reason });

function felt(x: unknown): bigint | null {
  try {
    const v = typeof x === "bigint" ? x : BigInt(x as string | number);
    return v >= 0n && v < FELT_MAX ? v : null;
  } catch {
    return null;
  }
}

const key = (a: string | bigint): string => num.toHex(BigInt(a));

function feltsOf(call: Call): bigint[] | null {
  const raw = call.calldata;
  if (!Array.isArray(raw)) return null;
  const out: bigint[] = [];
  for (const x of raw) {
    const v = felt(x);
    if (v === null) return null;
    out.push(v);
  }
  return out;
}

/** The one check every relayed transaction goes through. */
export function checkRelayCall(calls: readonly Call[], ctx: RelayContext, proof?: RelayProof): RelayDecision {
  if (!Array.isArray(calls) || calls.length !== 1) return no("one_call_only");
  const call = calls[0];
  const to = felt(call?.contractAddress);
  if (to === null || typeof call.entrypoint !== "string") return no("bad_call");
  const cd = feltsOf(call);
  if (!cd) return no("bad_calldata");

  if (to === BigInt(ctx.cfg.udc)) return checkDeploy(call.entrypoint, cd, ctx, proof);
  if (ctx.cfg.pool && to === BigInt(ctx.cfg.pool)) return checkApply(call.entrypoint, cd, ctx, proof);
  if (call.entrypoint === OUTSIDE_V2_ENTRYPOINT) return checkApprove(key(to), cd, ctx, proof);
  return no("not_allowed");
}

function checkDeploy(entrypoint: string, cd: bigint[], ctx: RelayContext, proof?: RelayProof): RelayDecision {
  if (proof) return no("deploy_takes_no_proof");
  if (entrypoint !== "deploy_contract") return no("not_allowed");
  // class_hash, salt, unique, calldata_len, ...calldata
  if (cd.length !== 5) return no("deploy_shape");
  const [classHash, salt, unique, len, pub] = cd;
  if (classHash !== BigInt(ctx.cfg.accountClassHash)) return no("deploy_class");
  if (unique !== 0n) return no("deploy_unique");
  if (len !== 1n) return no("deploy_shape");
  if (pub === 0n || salt !== pub) return no("deploy_salt");
  return { ok: true, kind: "deploy", publicKey: key(pub) };
}

function checkApprove(account: string, cd: bigint[], ctx: RelayContext, proof?: RelayProof): RelayDecision {
  if (proof) return no("approve_takes_no_proof");
  if (!ctx.cfg.pool) return no("no_pool");
  // OutsideExecution v2: caller, nonce, execute_after, execute_before, calls_len,
  // then each call: to, selector, calldata_len, ...calldata; then signature_len, ...signature.
  if (cd.length < 5) return no("outside_shape");
  const [caller, , after, before, nCalls] = cd;
  if (!sameStarknetAddress(caller, ctx.relay)) return no("outside_caller");
  if (nCalls !== 1n) return no("outside_one_call");
  const now = BigInt(Math.floor(ctx.now));
  if (before <= now) return no("outside_expired");
  if (before - now > BigInt(MAX_OUTSIDE_WINDOW_S)) return no("outside_window");
  if (after >= before) return no("outside_window");
  if (cd.length < 8) return no("outside_shape");
  const [token, selector, cdLen] = cd.slice(5, 8);
  if (cdLen !== 3n) return no("approve_shape");
  if (cd.length < 8 + 3 + 1) return no("outside_shape");
  const [spender, low, high] = cd.slice(8, 11);
  const sigLen = cd[11];
  if (sigLen === 0n || sigLen > BigInt(MAX_SIGNATURE_FELTS)) return no("outside_signature");
  if (cd.length !== 12 + Number(sigLen)) return no("outside_shape");
  if (selector !== BigInt(APPROVE_SELECTOR)) return no("approve_only");
  const listed = listedToken(ctx.cfg, token);
  if (!listed) return no("token_not_listed");
  if (spender !== BigInt(ctx.cfg.pool)) return no("approve_spender");
  if (high !== 0n || low >= U128) return no("approve_amount");
  const cap = ctx.maxApprove[key(listed.address)] ?? 0n;
  if (low === 0n || low > cap) return no("approve_amount");
  return { ok: true, kind: "approve", account, token: key(listed.address), amount: low };
}

type Variant = { activeVariant(): string; unwrap(): unknown };

const poolCallData = new CallData(PrivacyPoolABI);
const APPLY_TYPES = [
  "core::array::Span::<privacy::actions::ServerAction>",
  "core::option::Option::<privacy::snip12::ScreeningAttestation>",
];

/** The server actions an apply_actions call carries, or null when they don't decode exactly. */
export function decodeServerActions(cd: readonly bigint[]): Variant[] | null {
  return decodeApply(cd)?.actions ?? null;
}

/** An apply_actions call's server actions and its screening attestation time, or null when they don't decode exactly. */
export function decodeApply(cd: readonly bigint[]): { actions: Variant[]; attestedAt: number | null } | null {
  try {
    const decoded = poolCallData.decodeParameters(APPLY_TYPES, cd.map((x) => num.toHex(x))) as unknown[];
    const actions = decoded?.[0] as unknown;
    if (!Array.isArray(actions)) return null;
    // Re-encode to be sure nothing trails the two parameters.
    const again = poolCallData.compile(APPLY_ENTRYPOINT, { actions, screening: decoded[1] } as RawArgsObject);
    if (again.length !== cd.length || again.some((x, i) => BigInt(x) !== cd[i])) return null;
    const screening = decoded[1] as { isSome?: () => boolean; unwrap?: () => { issued_at?: unknown } } | undefined;
    let attestedAt: number | null = null;
    if (screening?.isSome?.()) {
      const at = Number(BigInt((screening.unwrap?.()?.issued_at ?? 0) as bigint | string | number));
      attestedAt = Number.isSafeInteger(at) && at > 0 ? at : 0;
    }
    return { actions: actions as Variant[], attestedAt };
  } catch {
    return null;
  }
}

function checkApply(entrypoint: string, cd: bigint[], ctx: RelayContext, proof?: RelayProof): RelayDecision {
  if (entrypoint !== APPLY_ENTRYPOINT) return no("pool_apply_only");
  if (!proof || !Array.isArray(proof.proofFacts) || proof.proofFacts.length === 0) return no("no_proof_facts");
  // starknet-devnet runs with --proof-mode none and the SDK's mock prover leaves the proof empty;
  // every other network needs one.
  const proofBody = typeof proof.proof === "string" ? proof.proof : "";
  if (proofBody.length === 0 && ctx.cfg.network !== "devnet") return no("no_proof");
  const decoded = decodeApply(cd);
  if (!decoded) return no("actions_decode");
  const { actions, attestedAt } = decoded;
  if (actions.length === 0) return no("no_actions");
  if (actions.length > MAX_ACTIONS) return no("too_many_actions");
  let fee: { token: string; amount: bigint } | null = null;
  let deposits = 0;
  let withdrawals = 0;
  for (const a of actions) {
    const v = a.activeVariant();
    if (v === "Invoke" || v === "InvokeWithComputation") return no("no_external_calls");
    if (v === "TransferFrom" || v === "TransferTo") {
      const x = a.unwrap() as { token: bigint | string; amount: bigint | string; to_addr?: bigint | string };
      const listed = listedToken(ctx.cfg, x.token);
      if (!listed) return no("token_not_listed");
      if (v === "TransferFrom") deposits++;
      else {
        withdrawals++;
        if (x.to_addr !== undefined && sameStarknetAddress(x.to_addr, ctx.relay)) {
          const amount = BigInt(x.amount);
          if (!fee || amount > fee.amount) fee = { token: key(listed.address), amount };
        }
      }
    }
  }
  const asks = Object.entries(ctx.minFee ?? {}).filter(([, v]) => v > 0n);
  if (asks.length) {
    if (!fee) return no("fee_missing");
    const min = ctx.minFee?.[fee.token] ?? 0n;
    if (min <= 0n || fee.amount < min) return no("fee_too_low");
  }
  return { ok: true, kind: "apply", fee, deposits, withdrawals, attestedAt };
}
