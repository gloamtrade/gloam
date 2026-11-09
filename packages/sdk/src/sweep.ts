/**
 * Payee side of x402: make a received payment final.
 *
 * In the gloam-private scheme the payer builds the payment note, so the payer
 * knows its secret too. Until the payee moves the money, the payer could be
 * served and then spend the note back. The fix is a sweep: a private transfer
 * from the received note into a fresh note only the payee knows (the whole
 * amount, plus a zero-value change note). Once the sweep confirms on chain the
 * received note's nullifier is spent by the payee, and the money is the payee's
 * alone. If the payer already spent it, the sweep cannot land and the payee
 * refuses access.
 *
 * settleGloamPayment is the safe default for servers: open the sealed note,
 * verify it, sweep it, and grant access only when `final` is true. Chain reads
 * and submission are injected, so a server can sweep through its own wallet or
 * through the Gloam relay, and tests can run it against a mock chain.
 */

import { keccak256, toBytes, type Address, type Hex, type PublicClient } from "viem";
import { buildPrivateSendIntent, type PrivateSendIntent } from "./builders.js";
import type { PoseidonMerklePath } from "./merkle.js";
import { noteNullifierPoseidon } from "./note.js";
import { fieldToHex, hexToField } from "./poseidon.js";
import type { Prover } from "./prove.js";
import type { ReceiveKey, ReceiveKeyJwk } from "./receiveTag.js";
import { GloamRelayError, RELAY_MAYBE_SENT, relayIntent, type RelayOptions } from "./relay.js";
import { createTreeSync, type TreeSync, type TreeSyncParams } from "./sync.js";
import type { NoteExport } from "./witness.js";
import {
  checkGloamPaymentBinding,
  openGloamPaymentNote,
  verifyGloamPayment,
  verifyPaymentNoteBinding,
  type GloamPaymentPayload,
  type GloamPaymentRequirements,
  type VerifyResult,
} from "./x402.js";

/** ShieldPoolPoseidon.transfer, for signing a sweep (or any private send) with your own wallet. */
export const POOL_TRANSFER_ABI = [
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "proof", type: "bytes" },
      { name: "root", type: "bytes32" },
      { name: "nullifier", type: "bytes32" },
      { name: "newCommitments", type: "bytes32[2]" },
    ],
    outputs: [],
  },
] as const;

/** The pool reads a sweep needs. */
export const POOL_STATE_ABI = [
  {
    type: "function",
    name: "isSpent",
    stateMutability: "view",
    inputs: [{ name: "nullifier", type: "bytes32" }],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "commitmentSeen",
    stateMutability: "view",
    inputs: [{ name: "commitment", type: "bytes32" }],
    outputs: [{ type: "bool" }],
  },
] as const;

/** A private send's exec args typed for POOL_TRANSFER_ABI: `writeContract({ address, abi, functionName: "transfer", args })`. */
export function transferCallArgs(intent: PrivateSendIntent): readonly [Hex, Hex, Hex, readonly [Hex, Hex]] {
  return intent.exec.args as readonly [Hex, Hex, Hex, readonly [Hex, Hex]];
}

/** A log as a receipt carries it. */
export interface ReceiptLog {
  address: string;
  topics: readonly string[];
  data: string;
}

/** topic0 of the pool's Transferred(bytes32 indexed nullifier, bytes32[2] newCommitments). */
const TRANSFERRED_TOPIC0 = keccak256(toBytes("Transferred(bytes32,bytes32[2])"));

/** Whether `logs` hold a Transferred event from `pool` whose payment output is `commitment`. */
export function receiptInsertsCommitment(logs: readonly ReceiptLog[], pool: Address, commitment: Hex): boolean {
  const want = commitment.toLowerCase().slice(2);
  return logs.some(
    (l) =>
      l.address.toLowerCase() === pool.toLowerCase() &&
      (l.topics[0] ?? "").toLowerCase() === TRANSFERRED_TOPIC0 &&
      /^0x[0-9a-fA-F]{128}$/.test(l.data) &&
      l.data.slice(2, 66).toLowerCase() === want
  );
}

/** What a sweep needs to know about the chain. */
export interface SweepChain {
  /** pool.isSpent(nullifier) */
  isSpent(nullifier: Hex): Promise<boolean>;
  /** pool.commitmentSeen(commitment) */
  isCommitmentSeen(commitment: Hex): Promise<boolean>;
  /** Membership path for a commitment, or null when it is not a leaf yet. */
  pathForCommitment(commitment: Hex): Promise<PoseidonMerklePath | null>;
  /**
   * Wait for a submitted transaction and report how it ended. With its logs, a
   * sweep that emitted the fresh note from the pool is final without one more
   * read of the pool (commitmentSeen).
   */
  waitForReceipt(hash: Hex): Promise<{ status: "success" | "reverted"; logs?: readonly ReceiptLog[] }>;
  /**
   * The chain these reads answer for (the RPC's own eth_chainId). Gloam's vault
   * has one address on every chain and native ETH is 0x0 on all of them, so a
   * reader on the wrong chain answers as if it were the right one. When this is
   * given, a sweep or charge for another chain is refused before anything is
   * read or sent. sweepChainFromClient sets it; a custom chain should too.
   */
  chainId?(): Promise<number>;
}

/**
 * Why `chain` can't settle a payment on `chainId`, or null when it reads that
 * chain (or does not say which chain it reads). Throws when the chain id could
 * not be read.
 */
export async function sweepChainProblem(chain: Pick<SweepChain, "chainId">, chainId: number): Promise<string | null> {
  if (!chain.chainId) return null;
  // compared as numbers: a custom reader may answer with a bigint or a string
  const actual = Number(await chain.chainId());
  if (actual === Number(chainId)) return null;
  return `These chain reads go to chain ${actual}, and the payment is on chain ${chainId}. Nothing was settled: point the reader at chain ${chainId}.`;
}

/**
 * Submits a built private send and returns its transaction hash. A submitter
 * that throws without knowing whether the transaction went out (a timeout, a
 * reply lost after the node took it) should throw an error with
 * `maybeSent: true`, and its `hash` when known, so the sweep keeps the fresh
 * note instead of reporting that nothing moved. A GloamRelayError with an
 * unclear code counts the same.
 */
export type SweepSubmitter = (intent: PrivateSendIntent) => Promise<Hex>;

/** The hash a submitter's error carries for a send that may have gone out, or null. */
function sentHashOf(e: unknown): Hex | null {
  const h = (e as { hash?: unknown } | null)?.hash;
  return typeof h === "string" && /^0x[0-9a-fA-F]{64}$/.test(h) ? (h as Hex) : null;
}

export interface SweepChainParams extends TreeSyncParams {
  /** A tree to share (one per pool per process). Default: one made from these params, kept by this chain. */
  tree?: TreeSync;
  /** How often to poll for a receipt, in ms. Default: the client's pollingInterval. */
  pollingInterval?: number;
}

/**
 * A SweepChain over a viem PublicClient: reads the pool, and keeps the pool's
 * tree (createTreeSync), so each path reads only the blocks since the last one.
 * Pass a `store` and a `seed` (see createTreeSync) to skip the walk over the
 * pool's history on a cold start too.
 */
export function sweepChainFromClient(client: PublicClient, params: SweepChainParams): SweepChain {
  // asked of the RPC once (a client's chain label can say one chain while its RPC is another's)
  let id: Promise<number> | null = null;
  const tree = params.tree ?? createTreeSync(client, params);
  /** The newest block a receipt was read in: a payment that just landed is in it or before it. */
  let receiptBlock: bigint | undefined;
  const isCommitmentSeen = (commitment: Hex) =>
    client.readContract({ address: params.pool, abi: POOL_STATE_ABI, functionName: "commitmentSeen", args: [commitment] });
  return {
    chainId: () =>
      (id ??= client.getChainId().catch((e: unknown) => {
        id = null;
        throw e;
      })),
    isSpent: (nullifier) =>
      client.readContract({ address: params.pool, abi: POOL_STATE_ABI, functionName: "isSpent", args: [nullifier] }),
    isCommitmentSeen,
    pathForCommitment: async (commitment) => {
      for (let attempt = 0; ; attempt++) {
        const path = await tree.pathForCommitment(commitment, attempt === 0 ? { atBlock: receiptBlock } : undefined);
        if (path || attempt >= 4) return path;
        // In the pool but not in the logs yet: the node that served them is a little behind.
        if (!(await isCommitmentSeen(commitment).catch(() => false))) return null;
        await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
      }
    },
    waitForReceipt: async (hash) => {
      const r = await client.waitForTransactionReceipt({ hash, ...(params.pollingInterval ? { pollingInterval: params.pollingInterval } : {}) });
      if (receiptBlock === undefined || r.blockNumber > receiptBlock) receiptBlock = r.blockNumber;
      return { status: r.status, logs: r.logs };
    },
  };
}

/** Submit sweeps through the Gloam relay, so the payee's wallet never appears and needs no gas. */
export function relaySubmitter(opts: RelayOptions = {}): SweepSubmitter {
  return (intent) => relayIntent(intent, opts);
}

export type SweepStatus = "swept" | "already_spent" | "not_settled" | "bad_note" | "unconfirmed" | "failed";

export interface SweepResult {
  ok: boolean;
  /** True only when the money now sits in a note only the payee knows: the fresh note is in the pool. */
  final: boolean;
  status: SweepStatus;
  reason: string | null;
  hash: Hex | null;
  /**
   * The payee's fresh note. Set when swept, and when unconfirmed (the sweep may
   * still land, so keep it). Its secret is the money: store it before anything else.
   */
  freshNote: NoteExport | null;
  amountWei: string;
  asset: Address;
}

export interface SweepParams {
  /** The received note, opened (see openGloamPaymentNote). */
  note: NoteExport;
  poolAddress: Address;
  chainId: number;
  /** Transfer-circuit prover (artifactProver over transfer.wasm + transfer_final.zkey). */
  prove: Prover;
  chain: SweepChain;
  submit: SweepSubmitter;
  /**
   * Called with the fresh note after it is proved and before it is submitted.
   * Persist it here: if the process dies after submitting, this is the only copy.
   */
  beforeSubmit?: (freshNote: NoteExport, intent: PrivateSendIntent) => void | Promise<void>;
}

const ALREADY_SPENT =
  "The payment note was already spent, most likely by the payer who created it. The money is not yours: do not grant access.";

/**
 * Move a received note into a fresh note only you know. Returns final: true
 * only after the sweep confirms and the fresh note is in the pool (a successful
 * receipt alone is not enough: see GHSA-p2wm-6x89-63c2). Refuses (already_spent) when the note was spent
 * before the sweep could land, and reports not_settled when the payment is not
 * in the pool yet.
 */
export async function sweepReceivedNote(params: SweepParams): Promise<SweepResult> {
  const { note, chain } = params;
  const base = { amountWei: note.amountWei, asset: note.asset };
  const result = (status: SweepStatus, reason: string | null, extra: Partial<SweepResult> = {}): SweepResult => ({
    ok: status === "swept",
    final: status === "swept",
    status,
    reason,
    hash: null,
    freshNote: null,
    ...base,
    ...extra,
  });

  let amount: bigint;
  try {
    amount = BigInt(note.amountWei);
  } catch {
    return result("bad_note", "The received note has no readable amount.");
  }
  if (amount <= 0n) return result("bad_note", "The received note carries no value.");
  // only on the payment's own chain: the vault and ETH have the same address on every chain
  const wrongChain = await sweepChainProblem(chain, params.chainId).catch(
    () => "Could not read which chain the reader is on, so nothing was settled. Try again."
  );
  if (wrongChain) return result("failed", wrongChain);
  if (!(await verifyPaymentNoteBinding(note))) {
    return result("bad_note", "The received note's amount does not match its commitment.");
  }
  const nullifier = fieldToHex(await noteNullifierPoseidon(hexToField(note.secret), hexToField(note.commitment)));
  // Both reads at once (the path is only used when the note is unspent).
  const pathRead = chain.pathForCommitment(note.commitment).then(
    (p) => ({ p }),
    (e: unknown) => ({ e })
  );
  if (await chain.isSpent(nullifier)) return result("already_spent", ALREADY_SPENT);
  const read = await pathRead;
  if ("e" in read) throw read.e;
  const path = read.p;
  if (!path) {
    return result("not_settled", "The payment is not in the pool yet. Wait for the payer's transfer to confirm, then try again.");
  }

  // The whole amount to a fresh payee note; the change note is zero.
  const intent = await buildPrivateSendIntent({
    secretHex: note.secret,
    amountInWei: amount,
    amountPayWei: amount,
    asset: note.asset,
    path,
    prove: params.prove,
    poolAddress: params.poolAddress,
    chainId: params.chainId,
  });
  const fresh = intent.paymentNote;
  await params.beforeSubmit?.(fresh, intent);

  let hash: Hex | null = null;
  let reverted = false;
  let error = "";
  // The relay could not say whether it sent the sweep (a timeout after the node took it, a lost reply):
  // it may still land, so the fresh note is kept rather than reported as nothing moved.
  let maybeSent = false;
  // The transaction succeeded but the fresh note was not (yet) seen in the pool.
  let outerOnly = false;
  try {
    hash = await params.submit(intent);
    const receipt = await chain.waitForReceipt(hash);
    if (receipt.status === "success") {
      // A receipt's status is the outer transaction's. Sent through a smart account, a bundler,
      // a batch or a forwarder, it can succeed while the pool transfer inside it reverted (say,
      // on a note the payer spent back first). Only the fresh note in the pool proves the sweep:
      // the pool's own Transferred event for it in this receipt (a reverted call leaves no logs),
      // or the pool saying it has seen it.
      if (
        (receipt.logs && receiptInsertsCommitment(receipt.logs, params.poolAddress, fresh.commitment)) ||
        (await chain.isCommitmentSeen(fresh.commitment).catch(() => null)) === true
      ) {
        return result("swept", null, { hash, freshNote: fresh });
      }
      outerOnly = true;
    } else {
      reverted = true;
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
    if (!hash) {
      maybeSent =
        (e instanceof GloamRelayError && RELAY_MAYBE_SENT.has(e.code)) || (e as { maybeSent?: unknown } | null)?.maybeSent === true;
      if (maybeSent) hash = sentHashOf(e);
    }
  }

  // It did not confirm cleanly. Ask the chain what actually happened. The spend is read
  // before the fresh note: the sweep spends the one and makes the other in the same block,
  // so a spend seen first and no fresh note read after it was another transaction's. Read
  // the other way round, a sweep landing between the two reads would look like someone
  // else's spend, and the fresh note would be given up while it holds the money.
  const spent = await chain.isSpent(nullifier).catch(() => null);
  const landed = await chain.isCommitmentSeen(fresh.commitment).catch(() => null);
  if (landed === true) return result("swept", null, { hash, freshNote: fresh });
  // Only a sweep that surely did nothing (never sent, or reverted) is given up on. One that
  // may be on its way keeps its fresh note, even with the note spent: two reads can come
  // from nodes at different heights.
  const didNothing = reverted || (!hash && !maybeSent);
  if (landed === false && spent === true && didNothing) return result("already_spent", ALREADY_SPENT, { hash });
  if (landed === false && spent === false && didNothing) {
    return result("failed", `The sweep did not go through and nothing moved${error ? `: ${error}` : "."} It can be retried.`, { hash });
  }
  if (outerOnly) {
    return result(
      "unconfirmed",
      `The transaction ${hash} succeeded, but the fresh note is not in the pool. If it went through a smart account, bundler or forwarder, the transfer inside it may have reverted. Keep the fresh note and do not grant access until it is in the pool.`,
      { hash, freshNote: fresh }
    );
  }
  return result(
    "unconfirmed",
    `The sweep was sent but has not confirmed${error ? ` (${error})` : ""}. Keep the fresh note and check again before granting access.`,
    { hash, freshNote: fresh }
  );
}

export interface SettleParams {
  requirements: GloamPaymentRequirements;
  payload: GloamPaymentPayload;
  /** The payee's receive key (the one behind requirements.payTo). Needed for sealed notes. */
  receiveKey?: ReceiveKey | ReceiveKeyJwk;
  prove: Prover;
  chain: SweepChain;
  submit: SweepSubmitter;
  beforeSubmit?: SweepParams["beforeSubmit"];
  /**
   * Take a payment with no binding (from a payer older than it). Off by default: a
   * sealed ticket copied from the payment board has none either (checkGloamPaymentBinding).
   * A binding that is there and wrong is refused either way.
   */
  allowUnbound?: boolean;
}

export interface SettleResult {
  /** Grant access only when this is true. Same as `final`. */
  grantAccess: boolean;
  ok: boolean;
  final: boolean;
  status: "rejected" | SweepStatus;
  reason: string | null;
  verify: VerifyResult | null;
  sweep: SweepResult | null;
  /** The payee's fresh note (see SweepResult.freshNote). Store its secret. */
  freshNote: NoteExport | null;
}

/**
 * Server side, the safe default: open the payment note with the payee's receive
 * key, verify it against the requirements, and sweep it into a fresh note only
 * the payee knows. grantAccess is true only after the sweep confirms on chain.
 */
export async function settleGloamPayment(params: SettleParams): Promise<SettleResult> {
  const { requirements: req, payload } = params;
  const reject = (reason: string, verify: VerifyResult | null = null): SettleResult => ({
    grantAccess: false,
    ok: false,
    final: false,
    status: "rejected",
    reason,
    verify,
    sweep: null,
    freshNote: null,
  });

  const key = params.receiveKey;
  if (key && "tag" in key && key.tag && key.tag.trim() !== String(req.payTo).trim()) {
    return reject("These requirements ask for payment to a different receive tag than this key.");
  }
  let note: NoteExport;
  try {
    note = await openGloamPaymentNote(payload.payload.paymentNote, key);
  } catch (e) {
    return reject(`Could not open the payment note: ${e instanceof Error ? e.message : String(e)}`);
  }
  const verify = verifyGloamPayment({ requirements: req, payload, note });
  if (!verify.ok) return reject(verify.reason ?? "payment did not verify", verify);
  // made as this payment, by its payer: not a sealed ticket copied from the payment board
  const unbound = await checkGloamPaymentBinding({ requirements: req, payload, note, allowUnbound: params.allowUnbound });
  if (unbound) return reject(unbound, verify);

  const sweep = await sweepReceivedNote({
    note,
    poolAddress: req.poolAddress,
    chainId: req.network,
    prove: params.prove,
    chain: params.chain,
    submit: params.submit,
    beforeSubmit: params.beforeSubmit,
  });
  return {
    grantAccess: sweep.final,
    ok: sweep.ok,
    final: sweep.final,
    status: sweep.status,
    reason: sweep.reason,
    verify,
    sweep,
    freshNote: sweep.freshNote,
  };
}
