/**
 * Agent commerce with commitments: pay privately, then put a checkable record
 * of the payment into a merkle root you already publish.
 *
 * Many economies (a game city, a marketplace, an agent network) already post a
 * root of their records on chain every night, and that root is how anyone
 * checks them. A Gloam payment fits into it like this:
 *
 *   1. The payer's agent sends a private payment from its private balance to
 *      the payee's receive tag (buildPrivatePaymentWithReceipt). It is a real
 *      vault transaction: transfer(proof, root, nullifier, [payment, change]).
 *   2. Once that transaction lands, the payer proves the payment with the
 *      receipt circuit (buildPaymentReceipt): "a private payment of `asset`,
 *      at least `minAmount` (or exactly `shownAmount`), is in the vault",
 *      bound to one reader and an expiry through `context` (proofContext).
 *   3. The economy hashes that into one bytes32 leaf (paymentReceiptLeaf) and
 *      puts the leaf into its nightly root next to its other records.
 *   4. Later anyone holding the record checks it (checkPaymentReceipt): the
 *      leaf recomputes, the proof verifies, the vault knows the root, and the
 *      named transaction created the payment note. Amounts and the payee stay
 *      out of the root; only the leaf is in it.
 *
 * The leaf, exactly (Solidity, or any language with an ABI encoder):
 *
 *   keccak256(abi.encode(
 *     string  "gloam.receipt-leaf.v1",
 *     uint256 chainId,
 *     address pool,
 *     bytes32 txHash,       // the vault transfer that created the payment note
 *     uint256[7] signals    // the receipt proof's public signals, circuit order:
 *                           // [root, commitment, asset, minAmount, reveal, shownAmount, context]
 *   ))
 *
 * abi.encode, not encodePacked. A uint256[7] encodes as seven words in place,
 * so passing the seven values one by one gives the same bytes.
 *
 * What this does not do, plainly:
 *  - No contract verifies receipt proofs on chain today. The vault verifies the
 *    shield, transfer and cash-out proofs it takes; receipt proofs are checked
 *    off chain with snarkjs and the published checking key (receipt_vkey.json),
 *    by checkPaymentReceipt, gloam.trade/verify or the partner API.
 *  - A receipt shows that a private payment of that asset and size was made
 *    by that transaction. It does not show who received it: the payer picks
 *    the payment note's key, so the payer and the payee can both make it.
 *  - If the payer's wallet signs the vault transfer itself, that wallet is the
 *    transaction's sender. The amount and the payee stay hidden; the fact that
 *    this wallet made a private payment at that time does not. Sending through
 *    the Gloam relay (relayIntent, relayMemo) keeps the wallet out of it.
 *  - Whoever sees a record sees its public signals (the asset, the minimum or
 *    the amount) and its transaction hash. Keep records off chain and publish
 *    only the root if those should stay private.
 */

import {
  encodeAbiParameters,
  getAddress,
  keccak256,
  parseEventLogs,
  stringToHex,
  toFunctionSelector,
  type AbiFunction,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { buildPrivateSendIntent, type PrivateSendIntent } from "./builders.js";
import { FIELD_PRIME, NATIVE_ASSET, RH_MAINNET_CHAIN_ID, networkForChainId, poolForChainId, type GloamNetworkKey } from "./constants.js";
import { payMemoBoardFor } from "./incoming.js";
import type { PoseidonMerklePath } from "./merkle.js";
import { fieldToHex } from "./poseidon.js";
import { RECEIPT_PUBLIC_SIGNALS, buildReceiptWitness, proofContext, readReceiptSignals } from "./proofs.js";
import type { Prover } from "./prove.js";
import { assertReceiveTag, encodeNotePackage, sealToReceiveTag } from "./receiveTag.js";
import { POOL_TRANSFER_ABI } from "./sweep.js";
import type { NoteExport } from "./witness.js";

// ── the leaf ─────────────────────────────────────────────────────────────────

/** Domain tag of the receipt leaf. A new encoding gets a new tag, never a silent change. */
export const RECEIPT_LEAF_DOMAIN = "gloam.receipt-leaf.v1";

const LEAF_TYPES = [
  { type: "string" },
  { type: "uint256" },
  { type: "address" },
  { type: "bytes32" },
  { type: "uint256[7]" },
] as const;

/** What a receipt leaf commits to. */
export interface ReceiptLeafFields {
  chainId: number;
  /** The vault the payment went through. */
  pool: Address;
  /** The vault transfer that created the payment note (its Transferred event carries the commitment first). */
  txHash: Hex;
  /** The receipt proof's 7 public signals, in circuit order (RECEIPT_PUBLIC_SIGNALS), as decimal strings or bigints. */
  publicSignals: readonly (string | bigint)[];
}

function leafSignals(signals: readonly (string | bigint)[]): bigint[] {
  if (!Array.isArray(signals) || signals.length !== RECEIPT_PUBLIC_SIGNALS.length) {
    throw new Error(`A receipt has ${RECEIPT_PUBLIC_SIGNALS.length} public signals.`);
  }
  const v = signals.map((s) => {
    if (typeof s === "bigint") return s;
    if (typeof s !== "string" || !/^\d{1,78}$/.test(s)) throw new Error("Public signals are decimal field elements.");
    return BigInt(s);
  });
  if (v.some((x) => x < 0n || x >= FIELD_PRIME)) throw new Error("A public signal is not a field element.");
  const s = readReceiptSignals(v.map(String));
  if (s.reveal !== 0n && s.reveal !== 1n) throw new Error("The reveal signal must be 0 or 1.");
  return v;
}

/**
 * The bytes32 leaf for one private payment, to put in an external merkle tree:
 *
 *   keccak256(abi.encode("gloam.receipt-leaf.v1", chainId, pool, txHash, signals))
 *
 * with chainId a uint256, pool an address, txHash a bytes32 and signals the
 * receipt proof's public signals as a uint256[7]. Deterministic: the same
 * payment and proof always give the same leaf. Throws on malformed input.
 */
export function paymentReceiptLeaf(fields: ReceiptLeafFields): Hex {
  if (!Number.isSafeInteger(fields.chainId) || fields.chainId <= 0) throw new Error("Bad chain id.");
  if (typeof fields.pool !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(fields.pool)) throw new Error("Bad pool address.");
  if (typeof fields.txHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(fields.txHash)) throw new Error("Bad transaction hash.");
  const signals = leafSignals(fields.publicSignals);
  return keccak256(
    encodeAbiParameters(LEAF_TYPES, [
      RECEIPT_LEAF_DOMAIN,
      BigInt(fields.chainId),
      fields.pool.toLowerCase() as Address,
      fields.txHash.toLowerCase() as Hex,
      signals as unknown as readonly [bigint, bigint, bigint, bigint, bigint, bigint, bigint],
    ])
  );
}

/** True when `leaf` is exactly paymentReceiptLeaf(fields). False (never a throw) for malformed input. */
export function verifyPaymentReceiptLeaf(leaf: string, fields: ReceiptLeafFields): boolean {
  if (typeof leaf !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(leaf)) return false;
  try {
    return paymentReceiptLeaf(fields).toLowerCase() === leaf.toLowerCase();
  } catch {
    return false;
  }
}

// ── who the receipt is for ───────────────────────────────────────────────────

/** Longest reader label, as in the Gloam app's proofs. */
export const RECEIPT_LABEL_MAX = 80;
const HIDDEN = /[\p{Cf}\u0000-\u0008\u000E-\u001F\u007F-\u009F]/gu;
const DEFAULT_RECEIPT_TTL_S = 30 * 24 * 3600;

/**
 * The reader label exactly as it is sealed into the proof's context: hidden
 * characters removed, spaces squeezed, trimmed (the app's rule, so the record
 * also checks out at gloam.trade/verify). A record id fits here, for example
 * "nightly-root:sale:8812".
 */
export function cleanReceiptLabel(label: string): string {
  const v = String(label ?? "").replace(HIDDEN, "").replace(/\s+/g, " ").trim();
  if (!v) throw new Error("Say who this receipt is for.");
  if (Array.from(v).length > RECEIPT_LABEL_MAX) throw new Error(`Keep the label under ${RECEIPT_LABEL_MAX} characters.`);
  return v;
}

// ── pay privately, plan the receipt ─────────────────────────────────────────

/** GloamPayMemo.postMemo, so the payee finds the payment with its receive key. */
export const PAY_MEMO_ABI = [
  {
    type: "function",
    name: "postMemo",
    stateMutability: "nonpayable",
    inputs: [
      { name: "paymentCommitment", type: "bytes32" },
      { name: "memo", type: "bytes" },
    ],
    outputs: [],
  },
] as const;

/** Everything buildPaymentReceipt needs once the payment is in the vault. Holds the payment note's secret: keep it private. */
export interface PaymentReceiptPlan {
  chainId: number;
  pool: Address;
  asset: Address;
  /** The payment note (the payee's side of the transfer). */
  paymentNote: NoteExport;
  reveal: boolean;
  minAmountWei: bigint;
  /** The cleaned reader label sealed into the context. */
  verifier: string;
  expiresAt: number;
  /** proofContext({ kind: "payment", chainId, pool, verifier, expiresAt }). */
  context: bigint;
}

export interface PrivatePaymentWithReceiptParams {
  /** The payee's receive tag (gloamr1.…). The payment note is sealed to it. */
  payTo: string;
  chainId: number;
  /** Defaults to Gloam's vault on `chainId`. */
  poolAddress?: Address;
  asset: Address;
  /** What the payee gets. */
  amountWei: bigint;
  /** The payer's private note that funds it, its amount and its membership path (syncTree.pathForCommitment). */
  from: { secretHex: Hex; amountWei: bigint; path: PoseidonMerklePath };
  /** Transfer-circuit prover. */
  prove: Prover;
  /** A private line only the payee reads (an order id), at most 80 characters. */
  note?: string;
  receipt: {
    /** Who the receipt is for, sealed into the proof (cleanReceiptLabel). */
    verifier: string;
    /** Unix seconds. Default 30 days from now. Gloam's /verify reads a receipt as expired after it. */
    expiresAt?: number;
    /** Show the exact amount in the receipt. Default false: it shows only that the payment was at least minAmountWei. */
    reveal?: boolean;
    /** The floor the receipt shows when not revealing. Default the whole amount. */
    minAmountWei?: bigint;
  };
}

export interface PrivatePaymentWithReceipt {
  /** The private send: sign intent.exec, transfer(proof, root, nullifier, [payment, change]) on the vault. */
  intent: PrivateSendIntent;
  /** The payee's note. The payer knows it until the payee sweeps; never publish it. */
  paymentNote: NoteExport;
  /** The payer's change. Persist its secret: it is the rest of the payer's balance. */
  changeNote: NoteExport;
  /** The payment note sealed to payTo (gloam2t.…). Hand it to the payee, or post it with `memo`. */
  sealedTicket: string;
  /**
   * The postMemo call that lets the payee find the payment by scanning the
   * board, or null where the chain has no board. Post it after the transfer
   * lands, from any wallet or through relayMemo. Skip it when you hand the
   * sealed ticket to the payee another way.
   */
  memo: { address: Address; abi: typeof PAY_MEMO_ABI; functionName: "postMemo"; args: readonly [Hex, Hex] } | null;
  receiptPlan: PaymentReceiptPlan;
}

/**
 * Build a private payment to a receive tag and the plan for its receipt, in
 * one place. Composes buildPrivateSendIntent, encodeNotePackage and
 * sealToReceiveTag; it signs and sends nothing.
 */
export async function buildPrivatePaymentWithReceipt(p: PrivatePaymentWithReceiptParams): Promise<PrivatePaymentWithReceipt> {
  assertReceiveTag(p.payTo, "payTo");
  if (p.amountWei <= 0n) throw new Error("The payment must be above zero.");
  if (p.from.amountWei < p.amountWei) throw new Error("The funding note does not cover the payment.");
  const pool = p.poolAddress ?? poolForChainId(p.chainId);
  const verifier = cleanReceiptLabel(p.receipt.verifier);
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = p.receipt.expiresAt ?? now + DEFAULT_RECEIPT_TTL_S;
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) throw new Error("Pick a receipt expiry in the future.");
  const reveal = p.receipt.reveal ?? false;
  const minAmountWei = reveal ? p.amountWei : (p.receipt.minAmountWei ?? p.amountWei);
  if (minAmountWei < 0n || minAmountWei > p.amountWei) throw new Error("The receipt minimum must be between zero and the payment.");
  const context = proofContext({ kind: "payment", chainId: p.chainId, pool, verifier, expiresAt });

  const intent = await buildPrivateSendIntent({
    secretHex: p.from.secretHex,
    amountInWei: p.from.amountWei,
    amountPayWei: p.amountWei,
    asset: p.asset,
    path: p.from.path,
    prove: p.prove,
    poolAddress: pool,
    chainId: p.chainId,
  });
  const paymentNote = intent.paymentNote;
  const sealedTicket = await sealToReceiveTag(
    encodeNotePackage({
      pool,
      asset: paymentNote.asset,
      amountWei: paymentNote.amountWei,
      secret: paymentNote.secret,
      commitment: paymentNote.commitment,
      chainId: p.chainId,
      ...(p.note ? { note: p.note } : {}),
    }),
    p.payTo
  );
  const board = payMemoBoardFor(p.chainId);
  return {
    intent,
    paymentNote,
    changeNote: intent.changeNote,
    sealedTicket,
    memo: board
      ? { address: board.address, abi: PAY_MEMO_ABI, functionName: "postMemo", args: [paymentNote.commitment, stringToHex(sealedTicket)] }
      : null,
    receiptPlan: { chainId: p.chainId, pool, asset: p.asset, paymentNote, reveal, minAmountWei, verifier, expiresAt, context },
  };
}

// ── the receipt ──────────────────────────────────────────────────────────────

/** A receipt-circuit prover that returns the raw snarkjs proof, e.g. (input) => proveGroth16(input, wasm, zkey). */
export type ReceiptProver = (circomInput: Record<string, string | string[]>) => Promise<{ proof: unknown; publicSignals: string[] }>;

/**
 * What the economy keeps for one leaf, off chain. It is the Gloam app's proof of
 * payment (gloampay1) plus the leaf, so paymentProofText(record) also checks
 * out at gloam.trade/verify and through the partner API.
 */
export interface PaymentReceiptRecord {
  v: 1;
  kind: "payment";
  chainId: number;
  pool: Address;
  verifier: string;
  expiresAt: number;
  asset: Address;
  /** The payment note's commitment: the receipt's anchor in the vault. */
  commitment: Hex;
  /** The amount, when revealed; else null. */
  amount: string | null;
  minAmount: string;
  txHash: Hex;
  /** Raw snarkjs Groth16 proof (pi_a, pi_b, pi_c). */
  proof: unknown;
  publicSignals: string[];
  /** paymentReceiptLeaf over the fields above. */
  leaf: Hex;
}

/**
 * Prove a payment made with buildPrivatePaymentWithReceipt, once its transfer
 * `txHash` has landed and `path` (the payment note's membership path, from a
 * tree synced after it landed) is known. Works after the payee has swept the
 * note too: the vault keeps every root it ever had (isKnownRoot).
 */
export async function buildPaymentReceipt(args: {
  plan: PaymentReceiptPlan;
  path: PoseidonMerklePath;
  txHash: Hex;
  prove: ReceiptProver;
}): Promise<PaymentReceiptRecord> {
  const { plan } = args;
  if (!/^0x[0-9a-fA-F]{64}$/.test(args.txHash)) throw new Error("Bad transaction hash.");
  const w = await buildReceiptWitness({
    secretHex: plan.paymentNote.secret,
    amount: BigInt(plan.paymentNote.amountWei),
    asset: plan.asset,
    path: args.path,
    reveal: plan.reveal,
    minAmount: plan.minAmountWei,
    context: plan.context,
  });
  if (w.blocker) throw new Error(w.blocker);
  const { proof, publicSignals } = await args.prove(w.circomInput);
  if (publicSignals.length !== w.publicSignals.length || publicSignals.some((s, i) => s !== w.publicSignals[i])) {
    throw new Error("The receipt proof did not come out as expected (wrong circuit or keys).");
  }
  const record: Omit<PaymentReceiptRecord, "leaf"> = {
    v: 1,
    kind: "payment",
    chainId: plan.chainId,
    pool: plan.pool,
    verifier: plan.verifier,
    expiresAt: plan.expiresAt,
    asset: plan.asset,
    commitment: fieldToHex(w.publicInputs.commitment),
    amount: plan.reveal ? plan.paymentNote.amountWei : null,
    minAmount: w.publicInputs.minAmount.toString(),
    txHash: args.txHash.toLowerCase() as Hex,
    proof,
    publicSignals,
  };
  return { ...record, leaf: paymentReceiptLeaf(record) };
}

/** Prefix of the Gloam app's proof of payment text. */
export const PAYMENT_PROOF_PREFIX = "gloampay1:";

/** The record as gloampay1:… text (base64 of the JSON, the leaf left out), for gloam.trade/verify or GloamApiClient.verifyProof. */
export function paymentProofText(record: PaymentReceiptRecord): string {
  const { leaf: _leaf, ...proof } = record;
  let bin = "";
  for (const b of new TextEncoder().encode(JSON.stringify(proof))) bin += String.fromCharCode(b);
  return PAYMENT_PROOF_PREFIX + btoa(bin);
}

// ── checking a record ────────────────────────────────────────────────────────

export type ReceiptCheckState = "pass" | "fail" | "unknown" | "skipped";

export interface ReceiptCheck {
  id: "leaf" | "fields" | "context" | "vault" | "snark" | "chain" | "root" | "payment";
  state: ReceiptCheckState;
  detail: string;
}

export interface ReceiptCheckResult {
  /** True only when every check ran and passed. A skipped check (no verifySnark, no client) leaves it false. */
  ok: boolean;
  /** Past expiresAt. Not part of `ok`: an old record in a root stays true, but gloam.trade/verify fails an expired proof. */
  expired: boolean;
  /** The Gloam network the record's chain id resolves to (its key, e.g. "base-mainnet" or "base"), or null for a chain Gloam does not run on. */
  network: GloamNetworkKey | null;
  /**
   * True when that network is a Gloam testnet, false on a mainnet, null when the chain is unknown.
   * Testnet value is free (faucet tokens) or, on the dev-key testnets, can be made up, so a testnet
   * record is never `ok` unless the check was called with `allowTestnet: true`.
   */
  testnet: boolean | null;
  checks: ReceiptCheck[];
}

const TRANSFERRED_EVENT = [
  {
    type: "event",
    name: "Transferred",
    inputs: [
      { name: "nullifier", type: "bytes32", indexed: true },
      { name: "newCommitments", type: "bytes32[2]", indexed: false },
    ],
  },
] as const;

const KNOWN_ROOT_ABI = [
  {
    type: "function",
    name: "isKnownRoot",
    stateMutability: "view",
    inputs: [{ name: "root", type: "bytes32" }],
    outputs: [{ type: "bool" }],
  },
] as const;

/** The chain reads a full check needs: a viem PublicClient fits. */
export type ReceiptChainReader = Pick<PublicClient, "getChainId" | "readContract" | "getTransactionReceipt">;

const sameField = (hex: string, field: bigint) => {
  try {
    return BigInt(hex) === field;
  } catch {
    return false;
  }
};

/**
 * Check one record end to end:
 *
 *   leaf     the leaf recomputes from the record (compare it with the leaf in your root)
 *   fields   the plain fields (asset, commitment, amounts) match the public signals
 *   context  the reader label, expiry, chain and vault are the ones sealed into the proof
 *   vault    the pool is Gloam's vault on that chain, and that chain is a mainnet
 *            (a testnet record fails here unless you pass `allowTestnet: true`)
 *   snark    the Groth16 proof verifies (needs `verifySnark`, e.g. snarkjs with receipt_vkey.json)
 *   chain    the reader is on the record's chain (needs `client`)
 *   root     the vault has had the proof's root (isKnownRoot; needs `client`)
 *   payment  the transaction succeeded and the vault's Transferred event in it
 *            created this note as the payment output, not change (needs `client`)
 *
 * Pass `leaf` to compare against the leaf you hold rather than the record's own.
 *
 * Testnet records: Base Sepolia and Ethereum Sepolia share the mainnet vault address
 * and keys, and the Robinhood Chain and Tempo testnets run development keys, so a
 * receipt from any Gloam testnet can be real proof of a payment worth nothing. The
 * `vault` check fails on a testnet chain unless `allowTestnet` is true; `network` and
 * `testnet` in the result say which chain the record is from either way. Build your
 * chain client from your own list of chains you accept, not from the record.
 */
export async function checkPaymentReceipt(
  record: PaymentReceiptRecord,
  opts: {
    leaf?: Hex;
    verifySnark?: (publicSignals: string[], proof: unknown) => Promise<boolean>;
    client?: ReceiptChainReader;
    now?: number;
    /** Accept records from Gloam testnets (test value only). Default false: a testnet record is never `ok`. */
    allowTestnet?: boolean;
  } = {}
): Promise<ReceiptCheckResult> {
  const checks: ReceiptCheck[] = [];
  const add = (id: ReceiptCheck["id"], state: ReceiptCheckState, detail: string) => checks.push({ id, state, detail });
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const expired = !(Number.isSafeInteger(record.expiresAt) && now <= record.expiresAt);
  const net = Number.isSafeInteger(record.chainId) ? networkForChainId(record.chainId) : undefined;
  const network = net ? net.key : null;
  const testnet = net ? net.testnet : null;
  const done = (): ReceiptCheckResult => ({ ok: checks.length === 8 && checks.every((c) => c.state === "pass"), expired, network, testnet, checks });

  const leaf = opts.leaf ?? record.leaf;
  const leafOk = verifyPaymentReceiptLeaf(leaf, record);
  add("leaf", leafOk ? "pass" : "fail", leafOk ? "The leaf recomputes from the record." : "The leaf does not match the record.");

  let s: ReturnType<typeof readReceiptSignals> | null = null;
  try {
    leafSignals(record.publicSignals);
    s = readReceiptSignals(record.publicSignals);
  } catch {
    s = null;
  }
  const shown = record.amount != null;
  const fieldsOk =
    s !== null &&
    sameField(record.asset, s.asset) &&
    sameField(record.commitment, s.commitment) &&
    /^\d+$/.test(String(record.minAmount)) &&
    BigInt(record.minAmount) === s.minAmount &&
    s.reveal === (shown ? 1n : 0n) &&
    (shown ? /^\d+$/.test(String(record.amount)) && BigInt(record.amount!) === s.shownAmount : s.shownAmount === 0n);
  add("fields", fieldsOk ? "pass" : "fail", fieldsOk ? "Asset and amounts match the proof." : "The asset or amounts were changed after the proof was made.");

  let contextOk = false;
  try {
    contextOk =
      s !== null &&
      cleanReceiptLabel(record.verifier) === record.verifier &&
      proofContext({ kind: "payment", chainId: record.chainId, pool: record.pool, verifier: record.verifier, expiresAt: record.expiresAt }) ===
        s.context;
  } catch {
    contextOk = false;
  }
  add(
    "context",
    contextOk ? "pass" : "fail",
    contextOk ? `Made for "${record.verifier}", sealed with its expiry, chain and vault.` : "The label, expiry, chain or vault was changed after the proof was made."
  );

  const vaultMatch = Boolean(net && typeof record.pool === "string" && net.pool.toLowerCase() === record.pool.toLowerCase());
  const testnetRefused = vaultMatch && net!.testnet && opts.allowTestnet !== true;
  const official = vaultMatch && !testnetRefused;
  add(
    "vault",
    official ? "pass" : "fail",
    official
      ? `Gloam's vault on chain ${record.chainId}${net!.testnet ? " (a testnet: test value only)" : ""}.`
      : testnetRefused
        ? `Chain ${record.chainId} is a Gloam testnet. Pass allowTestnet to accept test payments.`
        : "Not Gloam's vault on that chain."
  );

  if (opts.verifySnark) {
    const valid = s !== null && (await opts.verifySnark(record.publicSignals.map(String), record.proof).catch(() => false));
    add("snark", valid ? "pass" : "fail", valid ? "The zero-knowledge proof verifies." : "The proof does not verify against the receipt checking key.");
  } else {
    add("snark", "skipped", "No verifySnark given: the proof itself was not checked.");
  }

  const client = opts.client;
  if (!client || !s || !official) {
    const why = !client ? "No chain client given." : "Skipped: the record failed an earlier check.";
    add("chain", "skipped", why);
    add("root", "skipped", why);
    add("payment", "skipped", why);
    return done();
  }

  const chainId = await client.getChainId().catch(() => null);
  if (chainId !== record.chainId) {
    add("chain", chainId == null ? "unknown" : "fail", chainId == null ? "Could not read the chain id." : `The client reads chain ${chainId}, the record is on ${record.chainId}.`);
    add("root", "skipped", "Not read on the wrong chain.");
    add("payment", "skipped", "Not read on the wrong chain.");
    return done();
  }
  add("chain", "pass", `Read on chain ${chainId}.`);

  const rootKnown = await client
    .readContract({ address: record.pool, abi: KNOWN_ROOT_ABI, functionName: "isKnownRoot", args: [fieldToHex(s.root)] })
    .catch(() => null);
  add(
    "root",
    rootKnown == null ? "unknown" : rootKnown ? "pass" : "fail",
    rootKnown == null ? "Could not read the vault." : rootKnown ? "The vault has had this root." : "The vault never had the state this proof was made against."
  );

  let payment: ReceiptCheckState = "unknown";
  let detail = "Could not read the transaction.";
  try {
    const receipt = await client.getTransactionReceipt({ hash: record.txHash });
    if (receipt.status !== "success") {
      payment = "fail";
      detail = "The transaction reverted.";
    } else {
      const logs = parseEventLogs({ abi: TRANSFERRED_EVENT, logs: receipt.logs }).filter(
        (l) => l.address.toLowerCase() === record.pool.toLowerCase()
      );
      const out = logs.find((l) => sameField(l.args.newCommitments[0], s!.commitment));
      const change = logs.some((l) => sameField(l.args.newCommitments[1], s!.commitment));
      payment = out ? "pass" : "fail";
      detail = out
        ? "The transaction is a private send that created this payment."
        : change
          ? "This note is the change of that transaction, not the payment."
          : "That transaction did not create this note in the vault.";
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/could not be found|not found/i.test(msg)) {
      payment = "fail";
      detail = "No such transaction on this chain.";
    }
  }
  add("payment", payment, detail);
  return done();
}

// ── what an agent signs ──────────────────────────────────────────────────────

/** The vault calls an agent signs itself (ShieldPoolPayments / ShieldPoolPoseidon). */
export const GLOAM_VAULT_AGENT_ABI = [
  {
    type: "function",
    name: "shieldBound",
    stateMutability: "payable",
    inputs: [
      { name: "asset", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "commitment", type: "bytes32" },
      { name: "proof", type: "bytes" },
    ],
    outputs: [],
  },
  POOL_TRANSFER_ABI[0],
  {
    type: "function",
    name: "unshield",
    stateMutability: "nonpayable",
    inputs: [
      { name: "proof", type: "bytes" },
      { name: "root", type: "bytes32" },
      { name: "nullifier", type: "bytes32" },
      { name: "asset", type: "address" },
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

const ERC20_APPROVE: AbiFunction = {
  type: "function",
  name: "approve",
  stateMutability: "nonpayable",
  inputs: [
    { name: "spender", type: "address" },
    { name: "amount", type: "uint256" },
  ],
  outputs: [{ type: "bool" }],
};

/** One call an agent may be asked to sign, for a signing allowlist. */
export interface AgentSigningEntry {
  /** Stable id, e.g. "gloam.vault.transfer". */
  id: string;
  chainId: number;
  /** The contract called. */
  to: Address;
  /** Canonical signature, e.g. "transfer(bytes,bytes32,bytes32,bytes32[2])". */
  signature: string;
  /** First 4 bytes of the calldata. */
  selector: Hex;
  /** Native value sent with the call: always 0 for these entries. */
  value: "0";
  /** What it does, in a line. */
  purpose: string;
  /** Rules on the arguments a signer should enforce. */
  rules: string[];
}

function signatureOf(fn: AbiFunction): string {
  return `${fn.name}(${fn.inputs.map((i) => i.type).join(",")})`;
}

function entry(
  id: string,
  chainId: number,
  to: Address,
  fn: AbiFunction,
  purpose: string,
  rules: string[]
): AgentSigningEntry {
  return { id, chainId, to: getAddress(to), signature: signatureOf(fn), selector: toFunctionSelector(fn), value: "0", purpose, rules };
}

/**
 * Every call an agent signs to use Gloam on one chain, for a signing allowlist:
 * an ERC-20 approve of the vault per token, the vault's shieldBound (deposit),
 * transfer (private send, also a payee's sweep) and unshield (cash out), and
 * the payment board's postMemo where the chain has one. Selectors come from
 * the ABIs the SDK signs with. Native value is 0 on every entry: tokens only.
 *
 * `assets` defaults to every token the vault lists on that chain. Robinhood
 * Chain mainnet by default.
 */
export function agentSigningAllowlist(opts: { chainId?: number; assets?: { symbol: string; address: Address }[] } = {}): AgentSigningEntry[] {
  const chainId = opts.chainId ?? RH_MAINNET_CHAIN_ID;
  const pool = poolForChainId(chainId);
  const tokens = (opts.assets ?? networkForChainId(chainId)?.assets ?? []).filter(
    (a) => a.address.toLowerCase() !== NATIVE_ASSET.toLowerCase()
  );
  const [shieldBound, transfer, unshield] = GLOAM_VAULT_AGENT_ABI as unknown as [AbiFunction, AbiFunction, AbiFunction];
  const out: AgentSigningEntry[] = tokens.map((t) =>
    entry(`erc20.${t.symbol.toLowerCase()}.approve`, chainId, t.address, ERC20_APPROVE, `Let the vault pull ${t.symbol} for a deposit.`, [
      `spender must be the vault ${getAddress(pool)}`,
      "amount should be the exact deposit, not unlimited",
    ])
  );
  out.push(
    entry("gloam.vault.shieldBound", chainId, pool, shieldBound, "Deposit into the private balance (the amount is public).", [
      `asset must be one of: ${tokens.map((t) => t.symbol).join(", ") || "the vault's tokens"}`,
      "value must be 0",
    ]),
    entry("gloam.vault.transfer", chainId, pool, transfer, "Private send, or a payee's sweep of a received payment. No amount or payee on chain.", [
      "no value; the proof binds every argument",
    ]),
    entry("gloam.vault.unshield", chainId, pool, unshield, "Cash out from the private balance to a public address (amount and recipient are public).", [
      "to should be a wallet the business controls",
    ])
  );
  const board = payMemoBoardFor(chainId);
  if (board) {
    out.push(
      entry("gloam.memo.postMemo", chainId, board.address, PAY_MEMO_ABI[0] as unknown as AbiFunction, "Post the sealed payment ticket so the payee finds it.", [
        "paymentCommitment is the transfer's first new commitment",
        "memo is the gloam2t. ticket, only the payee's key opens it",
      ])
    );
  }
  return out;
}
