/**
 * Payee side of a gloam charge: verify a credential, then make it final.
 *
 * validateGloamCharge is read-only. It opens the sealed ticket with the payee's
 * receive key and checks that the note binds the requested amount and asset,
 * that the credential is bound to this challenge, and that the note is the
 * payment output of a Transferred event in the official Gloam pool (push) or
 * of the presented transfer call (pull).
 *
 * settleGloamCharge is the terminal step. In pull mode it first submits the
 * payer's transfer. Then it runs the SDK's settleGloamPayment, which sweeps
 * the payment into a fresh note only the payee knows, and returns a receipt
 * only once that sweep confirms. The payer created the payment note and knows
 * its secret, so a payment is never final before the sweep.
 *
 * Replay protection is the payment note's nullifier: the sweep spends it on
 * chain exactly once. A replay store in front of it keeps concurrent requests
 * with the same credential from racing, and remembers a sweep whose receipt
 * was lost so a retry of the same credential can still be served once. Every
 * receipt comes from one atomic claim on the payment, so however the requests
 * for it overlap, one of them is served.
 */

import { encodeFunctionData, keccak256, toBytes, type Address, type Hex } from "viem";
import {
  fieldToHex,
  hexToField,
  noteNullifierPoseidon,
  openGloamPaymentNote,
  settleGloamPayment,
  createTreeSync,
  sweepChainFromClient,
  sweepChainProblem,
  verifyPaymentNoteBinding,
  GLOAM_X402_SCHEME,
  GLOAM_X402_VERSION,
  type GloamIntent,
  type GloamPaymentPayload,
  type IntentExec,
  type NoteExport,
  type PrivateSendIntent,
  type Prover,
  type ReceiveKey,
  type SweepChain,
  type SweepChainParams,
} from "@gloamtrade/sdk";
import {
  allowedModes,
  challengeBinding,
  officialPool,
  parseGloamChargePayload,
  parseGloamChargeRequest,
  toPaymentRequirements,
  GloamChargeError,
  GLOAM_METHOD,
  GLOAM_MODES,
  type GloamChargePayload,
  type GloamChargeReceipt,
  type GloamChargeRequest,
  type GloamMode,
  type GloamPools,
} from "./charge.js";
import type { GloamSubmitter } from "./client.js";
import { constantTimeEqual, isExpired } from "./wire.js";

// ── chain access ─────────────────────────────────────────────────────────────

export interface MinimalLog {
  address: string;
  topics: readonly string[];
  data: string;
}

export interface MinimalReceipt {
  status: "success" | "reverted";
  logs: readonly MinimalLog[];
}

/** What a gloam charge server needs from the chain: the sweep reads plus transaction receipts. */
/** A payer's proven transfer, as a pull credential carries it. */
export interface PullTransfer {
  proof: Hex;
  root: Hex;
  nullifier: Hex;
  newCommitments: readonly [Hex, Hex];
}

export interface GloamChargeChain extends SweepChain {
  /** The receipt of `hash` with its logs, or null while it is not mined (or unknown). */
  getReceipt(hash: Hex): Promise<MinimalReceipt | null>;
  /**
   * Whether `pool` takes this transfer now: a call of transfer() that sends
   * nothing runs the pool's own checks (an unspent note, a known root, a proof
   * that holds). true: it would; false: the pool refuses it; null: the node
   * could not say. Optional: without it, a pull transfer is submitted as before.
   */
  transferWouldLand?(pool: Address, transfer: PullTransfer): Promise<boolean | null>;
}

const POOL_TRANSFER_ABI = [
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

/** A node's answer that the call reverted, as against one that never ran (a timeout, a node down). */
export function callReverted(e: unknown): boolean {
  for (let x: unknown = e, depth = 0; x && depth < 8; x = (x as { cause?: unknown }).cause, depth++) {
    const err = x as { name?: string; message?: string; details?: string; data?: unknown };
    if (err.name === "ExecutionRevertedError" || err.name === "ContractFunctionRevertedError" || err.name === "RawContractError") return true;
    if (/execution reverted|reverted/i.test(`${err.details ?? ""} ${err.message ?? ""}`)) return true;
  }
  return false;
}

/**
 * transferWouldLand for a viem public client: an eth_call of the pool's
 * transfer() (anyone may submit a proven transfer, so no sender is needed).
 */
export function transferCheckFromCall(call: (args: { to: Address; data: Hex }) => Promise<unknown>): NonNullable<GloamChargeChain["transferWouldLand"]> {
  return async (pool, t) => {
    try {
      await call({
        to: pool,
        data: encodeFunctionData({ abi: POOL_TRANSFER_ABI, functionName: "transfer", args: [t.proof, t.root, t.nullifier, [t.newCommitments[0], t.newCommitments[1]]] }),
      });
      return true;
    } catch (e) {
      return callReverted(e) ? false : null;
    }
  };
}

/** topic0 of ShieldPoolPoseidon's Transferred(bytes32 indexed nullifier, bytes32[2] newCommitments). */
export const TRANSFERRED_TOPIC: Hex = keccak256(toBytes("Transferred(bytes32,bytes32[2])"));

export interface TransferredEvent {
  nullifier: Hex;
  newCommitments: [Hex, Hex];
}

/** The Transferred events `pool` emitted in a receipt. Logs from any other address are ignored. */
export function transfersInReceipt(receipt: MinimalReceipt, pool: Address): TransferredEvent[] {
  const out: TransferredEvent[] = [];
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== pool.toLowerCase()) continue;
    if ((log.topics[0] ?? "").toLowerCase() !== TRANSFERRED_TOPIC) continue;
    const data = log.data.toLowerCase();
    if (log.topics.length < 2 || !/^0x[0-9a-f]{128}$/.test(data)) continue;
    out.push({
      nullifier: log.topics[1]!.toLowerCase() as Hex,
      newCommitments: [`0x${data.slice(2, 66)}` as Hex, `0x${data.slice(66, 130)}` as Hex],
    });
  }
  return out;
}

type SdkPublicClient = Parameters<typeof sweepChainFromClient>[0];

/**
 * A GloamChargeChain over a viem PublicClient. It keeps the pool's tree for the
 * life of the server (the SDK's createTreeSync), so a sweep reads only the
 * blocks since the last one. Make it once and share it between requests. For
 * a fast cold start pass `seed: gloamLeafSeed(network)` (and a `store` to keep
 * the leaf list across restarts), and call `warm()` at startup.
 */
export function gloamChargeChainFromClient(client: SdkPublicClient, params: SweepChainParams): GloamChargeChain & { warm(): Promise<void> } {
  const tree = params.tree ?? createTreeSync(client, params);
  const sweep = sweepChainFromClient(client, { ...params, tree });
  return {
    ...sweep,
    /** Sync the tree (and read the RPC's chain id) now, at startup, so the first payment does not wait for them. */
    warm: async () => {
      await Promise.all([tree.sync(), sweep.chainId?.()]);
    },
    transferWouldLand: transferCheckFromCall((a) => client.call(a)),
    async getReceipt(hash) {
      try {
        const r = await client.getTransactionReceipt({ hash });
        return { status: r.status, logs: r.logs };
      } catch (e) {
        if (e instanceof Error && /not.?found|could not be found/i.test(`${e.name} ${e.message}`)) return null;
        throw e;
      }
    },
  };
}

// ── replay store ─────────────────────────────────────────────────────────────

export interface GloamReplayRecord {
  /** settling: a request is working on it. sent: the sweep went out, outcome unknown. settled: final, served once. */
  state: "settling" | "sent" | "settled";
  at: number;
  freshCommitment?: Hex;
  sweepHash?: Hex | null;
  receipt?: GloamChargeReceipt;
  /** On a `challenge:<id>` record: the payment that holds the challenge. */
  paymentNullifier?: Hex;
}

/**
 * Keyed by the payment note's nullifier, by `challenge:<id>` so that a challenge
 * settles one payment only, and by `served:<nullifier>` so that a payment gets
 * one receipt. Use a shared store (Redis, a database) when several instances settle.
 */
export interface GloamReplayStore {
  get(key: string): Promise<GloamReplayRecord | undefined>;
  /** Create the record only if none exists; true when this call created it. Must be atomic. */
  claim(key: string, record: GloamReplayRecord): Promise<boolean>;
  put(key: string, record: GloamReplayRecord): Promise<void>;
  delete(key: string): Promise<void>;
}

export function memoryReplayStore(): GloamReplayStore {
  const m = new Map<string, GloamReplayRecord>();
  return {
    get: async (k) => m.get(k),
    claim: async (k, r) => {
      if (m.has(k)) return false;
      m.set(k, r);
      return true;
    },
    put: async (k, r) => void m.set(k, r),
    delete: async (k) => void m.delete(k),
  };
}

// ── config ───────────────────────────────────────────────────────────────────

export interface GloamChargeServerConfig {
  /** The payee's receive key. Its tag is the recipient of every charge this server issues. */
  receiveKey: ReceiveKey;
  /** Chain access, or a function of the chain id when the server prices on several networks. */
  chain: GloamChargeChain | ((chainId: number) => GloamChargeChain);
  /** Transfer-circuit prover for the sweep. */
  prove: Prover;
  /** Submits the sweep, and the payer's transfer in pull mode: your wallet, or relaySubmitter(). */
  submit: GloamSubmitter;
  /** Accepted modes. Default both. */
  modes?: GloamMode[];
  pools?: GloamPools;
  replay?: GloamReplayStore;
  /**
   * Called with the payee's fresh note after it is proved and before the sweep
   * is submitted. Persist it here: its secret is the money, and this is the only
   * place it comes out. Required, since a sweep without it pays nobody.
   */
  beforeSubmit: (freshNote: NoteExport, intent: PrivateSendIntent) => void | Promise<void>;
  /** How long a settling record blocks another request for the same payment. Default 120 s. */
  settlingTimeoutMs?: number;
  now?: () => number;
}

/** What checking a payment needs: it never sweeps, so it has no note to keep. */
export type GloamChargeReadConfig = Omit<GloamChargeServerConfig, "beforeSubmit">;

const fail = (message: string, retryable = false) => new GloamChargeError("verification-failed", message, retryable);

/** Refuses a server that would throw away what it earns: nothing else hands out a sweep's fresh note. */
export function assertKeepsFreshNotes(config: Pick<GloamChargeServerConfig, "beforeSubmit">): void {
  if (typeof config.beforeSubmit !== "function") {
    throw new Error("Pass beforeSubmit to keep each fresh note: it holds the money a charge earns, and it comes out nowhere else.");
  }
}
const lc = (s: string) => s.toLowerCase();
const chainFor = (config: GloamChargeReadConfig, chainId: number) =>
  typeof config.chain === "function" ? config.chain(chainId) : config.chain;

/** Refuses a chain reader that answers for another chain than the charge's. */
async function requireChain(chain: GloamChargeChain, chainId: number): Promise<void> {
  let problem: string | null;
  try {
    problem = await sweepChainProblem(chain, chainId);
  } catch {
    throw fail("Could not read which chain this server's reader is on. Retry shortly.", true);
  }
  if (problem) throw fail(problem.replace("the payment is on", "the charge is on"));
}

const replayStores = new WeakMap<GloamChargeReadConfig, GloamReplayStore>();
const challengeKey = (id: string) => `challenge:${id}`;
const servedKey = (paymentNullifier: Hex) => `served:${paymentNullifier}`;
/** The config's replay store, or one in-memory store per config object. */
export function replayStoreOf(config: GloamChargeReadConfig): GloamReplayStore {
  if (config.replay) return config.replay;
  let s = replayStores.get(config);
  if (!s) replayStores.set(config, (s = memoryReplayStore()));
  return s;
}

// ── validate ─────────────────────────────────────────────────────────────────

/** The challenge fields a gloam charge needs (an echoed challenge from any MPP library fits). */
export interface ChargeChallengeLike {
  id: string;
  realm: string;
  request: unknown;
  expires?: string;
}

export interface ValidatedGloamCharge {
  challengeId: string;
  realm: string;
  request: GloamChargeRequest;
  payload: GloamChargePayload;
  mode: GloamMode;
  /** The opened payment note. Keep it server side; its secret is spendable until the sweep. */
  note: NoteExport;
  paymentNullifier: Hex;
  /** The payer's transfer: from the Transferred event (push) or the presented call (pull). */
  transfer: { nullifier: Hex; newCommitments: [Hex, Hex]; proof?: Hex; root?: Hex };
  /** True when the payer's transfer is already in the pool. */
  landed: boolean;
  /** A record left by an earlier attempt with this payment (a sweep whose outcome was unknown). */
  pending: GloamReplayRecord | null;
  /** When the chain was read for this validation (ms, the config's clock). */
  checkedAt?: number;
}

/**
 * Read-only verification of a gloam charge credential against the challenge it
 * echoes. The caller must already have checked that the challenge is its own
 * (HMAC id) and is the price of the resource requested; MPP libraries do that.
 */
export async function validateGloamCharge(args: {
  challenge: ChargeChallengeLike;
  payload: unknown;
  config: GloamChargeReadConfig;
}): Promise<ValidatedGloamCharge> {
  const { challenge, config } = args;
  const now = config.now?.() ?? Date.now();
  if (isExpired(challenge, now)) throw new GloamChargeError("payment-expired", "This challenge has expired.");

  const request = parseGloamChargeRequest(challenge.request);
  const md = request.methodDetails;
  const official = officialPool(md.chainId, config.pools);
  if (!official || lc(official) !== lc(md.pool)) {
    throw fail(`The challenge names pool ${md.pool} on chain ${md.chainId}, which is not the Gloam pool. Not settling there.`);
  }
  // The vault and native ETH share their addresses across chains: only the reader's own chain id tells.
  const chain = chainFor(config, md.chainId);
  await requireChain(chain, md.chainId);
  if (request.recipient.trim() !== config.receiveKey.tag.trim()) {
    throw fail("This charge pays a different receive tag than this server's.");
  }

  const payload = parseGloamChargePayload(args.payload);
  const mode: GloamMode = payload.type === "hash" ? "push" : "pull";
  const serverModes = config.modes ?? GLOAM_MODES;
  if (!allowedModes(request).includes(mode) || !serverModes.includes(mode)) {
    throw fail(`This server does not accept ${mode} mode for this charge.`);
  }

  let note: NoteExport & { pool?: Address; chainId?: number };
  try {
    note = await openGloamPaymentNote(payload.ticket, config.receiveKey);
  } catch {
    throw fail("The ticket does not open with this server's receive key: it was sealed to someone else, or it is corrupt.");
  }
  if (note.pool && lc(note.pool) !== lc(md.pool)) throw fail("The payment note belongs to a different pool.");
  if (note.chainId !== undefined && note.chainId !== md.chainId) {
    throw fail(`The payment note is on chain ${note.chainId}; the charge is on chain ${md.chainId}.`);
  }
  if (lc(note.asset) !== lc(request.currency)) throw fail("The payment note holds a different asset than the charge asks for.");
  if (BigInt(note.amountWei) !== BigInt(request.amount)) {
    throw fail(`The payment note carries ${note.amountWei} base units; the charge is ${request.amount}.`);
  }
  if (!(await verifyPaymentNoteBinding(note))) throw fail("The payment note's amount does not bind to its commitment.");
  const expected = await challengeBinding({
    secret: note.secret,
    realm: challenge.realm,
    challengeId: challenge.id,
    commitment: note.commitment,
  });
  if (!constantTimeEqual(expected, payload.binding)) throw fail("This credential is bound to a different challenge.");

  const paymentNullifier = fieldToHex(await noteNullifierPoseidon(hexToField(note.secret), hexToField(note.commitment)));
  const pending = (await replayStoreOf(config).get(paymentNullifier)) ?? null;
  if (pending?.state === "settled") throw fail("This payment was already used.");
  const holder = await replayStoreOf(config).get(challengeKey(challenge.id));
  if (holder?.state === "settled" && holder.paymentNullifier !== paymentNullifier) {
    throw new GloamChargeError("invalid-challenge", "This challenge was already paid and used. Request the resource again for a fresh one.");
  }

  // The reads below are independent: in pull mode they go out together, and are looked at in this order.
  const t = payload.type === "hash" ? null : payload.transfer;
  const early = <T>(p: Promise<T>) => p.then((v) => ({ v }), (e: unknown) => ({ e }));
  const open = <T>(r: { v: T } | { e: unknown }): T => {
    if ("e" in r) throw r.e;
    return r.v;
  };
  const reads = t
    ? {
        seen: early(chain.isCommitmentSeen(note.commitment)),
        sourceSpent: pending ? null : early(chain.isSpent(t.nullifier)),
        wouldLand:
          !pending && chain.transferWouldLand && t.proof && t.root
            ? chain.transferWouldLand(md.pool, { proof: t.proof, root: t.root, nullifier: t.nullifier, newCommitments: t.newCommitments }).catch(() => null)
            : null,
      }
    : null;

  // Spent with no record of ours: the payer (who also knows the secret) moved it, or another server took it.
  if (!pending && (await chain.isSpent(paymentNullifier))) {
    throw fail("The payment note was already spent, most likely by the payer who created it. Do not grant access.");
  }

  let transfer: ValidatedGloamCharge["transfer"];
  let landed: boolean;
  if (payload.type === "hash") {
    const receipt = await chain.getReceipt(payload.hash);
    if (!receipt) throw fail(`The payment transfer ${payload.hash} is not mined yet. Retry shortly with the same credential.`, true);
    if (receipt.status !== "success") throw fail(`The payment transfer ${payload.hash} reverted.`);
    const event = transfersInReceipt(receipt, md.pool).find((e) => lc(e.newCommitments[0]) === lc(note.commitment));
    if (!event) throw fail("The payment note is not the payment output of a Transferred event from the Gloam pool in that transaction.");
    transfer = event;
    landed = true;
  } else {
    const pt = payload.transfer;
    if (lc(pt.newCommitments[0]) !== lc(note.commitment)) throw fail("The payment note is not the payment output of the presented transfer.");
    transfer = pt;
    landed = open(await reads!.seen);
    if (!landed && reads!.sourceSpent && open(await reads!.sourceSpent)) {
      throw fail("The note that funds this transfer was already spent elsewhere, so the transfer cannot land.");
    }
    // The pool's own checks run first, sending nothing: a transfer it would refuse is never submitted.
    if (!landed && reads!.wouldLand && (await reads!.wouldLand) === false) {
      throw fail("The pool would not take the presented transfer (its proof, root or note does not hold), so nothing was sent.");
    }
  }

  return { challengeId: challenge.id, realm: challenge.realm, request, payload, mode, note, paymentNullifier, transfer, landed, pending, checkedAt: now };
}

// ── settle ───────────────────────────────────────────────────────────────────

/**
 * What the paying client is told about a sweep that did not finish. These two carry the failure's own text in
 * the SDK, for the operator. The client gets fixed words.
 */
function sweepReason(result: { status: string; reason: string | null }): string {
  if (result.status === "unconfirmed") return "The sweep has not confirmed.";
  if (result.status === "failed") return "The sweep did not go through and nothing moved. It can be retried.";
  return result.reason ?? "The payment could not be settled.";
}

function receiptOf(v: ValidatedGloamCharge, sweepHash: Hex, now: number): GloamChargeReceipt {
  return {
    status: "success",
    method: GLOAM_METHOD,
    timestamp: new Date(now).toISOString().replace(/\.\d{3}Z$/, "Z"),
    reference: sweepHash,
    challengeId: v.challengeId,
    chainId: v.request.methodDetails.chainId,
    ...(v.request.externalId !== undefined ? { externalId: v.request.externalId } : {}),
  };
}

/** The payer's transfer from a pull credential, as an intent any submitter (wallet or relay) can send. */
export function payerTransferIntent(chainId: number, pool: Address, t: ValidatedGloamCharge["transfer"]): GloamIntent<"private_send"> & { exec: IntentExec } {
  if (!t.proof || !t.root) throw fail("The transfer call is incomplete.");
  return {
    intent: "private_send",
    chainId,
    agentAddress: null,
    plan: { asset: "shielded" },
    privacy: "A payer's private send, submitted by the payee. The public sees a shielded transfer.",
    execution: "Submitted by the payee on the payer's behalf (pull mode).",
    exec: { poolAddress: pool, fn: "transfer", valueWei: 0n, args: [t.proof, t.root, t.nullifier, t.newCommitments] },
  };
}

/**
 * Make a gloam charge final and return its receipt. Validates first unless a
 * validation from this same request is passed in. Throws GloamChargeError;
 * `retryable` errors mean the same credential may succeed on a later try.
 */
export async function settleGloamCharge(args: {
  challenge: ChargeChallengeLike;
  payload: unknown;
  config: GloamChargeServerConfig;
  validated?: ValidatedGloamCharge;
}): Promise<GloamChargeReceipt> {
  const { config } = args;
  assertKeepsFreshNotes(config);
  const v = args.validated ?? (await validateGloamCharge(args));
  const md = v.request.methodDetails;
  const chain = chainFor(config, md.chainId);
  await requireChain(chain, md.chainId);
  const replay = replayStoreOf(config);
  const clock = () => config.now?.() ?? Date.now();
  const key = v.paymentNullifier;

  const timeout = config.settlingTimeoutMs ?? 120_000;
  const ckey = challengeKey(v.challengeId);
  const markChallenge = (state: GloamReplayRecord["state"]) => replay.put(ckey, { state, at: clock(), paymentNullifier: key });
  const releaseChallenge = async () => {
    const h = await replay.get(ckey);
    if (h?.paymentNullifier === key) await replay.delete(ckey);
  };

  // One receipt per payment, whichever request gets here first: the one that swept it, a retry waiting on the same
  // sweep, or the payment bound to another challenge. The reads above can all pass at once, so this claim decides.
  const finalize = async (record: GloamReplayRecord) => {
    const served = servedKey(key);
    if (!(await replay.claim(served, { state: "settled", at: record.at }))) {
      await markChallenge("settled");
      throw fail("This payment was already used.");
    }
    try {
      // The payment's record last: once it says settled, a retry stops short of this point.
      await markChallenge("settled");
      await replay.put(key, record);
    } catch (e) {
      // Nothing was handed out, so a retry can still be served.
      await replay.delete(served).catch(() => undefined);
      throw e;
    }
  };

  // A challenge settles one payment. Another payment that holds it blocks this one (before anything is swept).
  const holder = await replay.get(ckey);
  if (holder && holder.paymentNullifier !== key) {
    if (holder.state === "settled") {
      throw new GloamChargeError("invalid-challenge", "This challenge was already paid and used. Request the resource again for a fresh one.");
    }
    if (holder.state === "sent" || clock() - holder.at < timeout) {
      throw fail("Another payment for this challenge is being settled. Retry shortly.", true);
    }
  }

  // An earlier attempt with this payment: finish it, wait for it, or refuse.
  const existing = await replay.get(key);
  if (existing?.state === "settled") throw fail("This payment was already used.");
  if (existing?.state === "sent") {
    // The spend first: a sweep does both in one block, so a spend read with no fresh note read after it was another
    // transaction's. The other way round, a sweep landing between the two reads looks like someone else's spend.
    const spent = await chain.isSpent(key);
    if (existing.freshCommitment && (await chain.isCommitmentSeen(existing.freshCommitment))) {
      const reference = existing.sweepHash ?? (v.payload.type === "hash" ? v.payload.hash : existing.freshCommitment);
      const receipt = receiptOf(v, reference, clock());
      await finalize({ ...existing, state: "settled", at: clock(), receipt });
      return receipt;
    }
    if (spent) {
      await replay.delete(key);
      await releaseChallenge();
      throw fail("The payment note was spent by someone else before this server's sweep landed. Do not grant access.");
    }
    throw fail("A sweep of this payment was sent and has not confirmed yet. Retry shortly with the same credential.", true);
  }
  if (existing?.state === "settling" && clock() - existing.at < timeout) {
    throw fail("This payment is being settled by another request. Retry shortly.", true);
  }
  const claim: GloamReplayRecord = { state: "settling", at: clock() };
  if (existing) await replay.put(key, claim);
  else if (!(await replay.claim(key, claim))) throw fail("This payment is being settled by another request. Retry shortly.", true);
  // Then the challenge, atomically (a stale claim by another payment is taken over).
  const challengeClaim: GloamReplayRecord = { state: "settling", at: clock(), paymentNullifier: key };
  if (holder) await replay.put(ckey, challengeClaim);
  else if (!(await replay.claim(ckey, challengeClaim))) {
    await replay.delete(key);
    throw fail("Another payment for this challenge is being settled. Retry shortly.", true);
  }

  let sent = false;
  try {
    // Pull: the payer's transfer has to land before the payment note can be swept.
    let paymentHash: Hex | null = v.payload.type === "hash" ? v.payload.hash : null;
    // Read again unless this request's own validation just read it (a transfer that lands in between is caught below).
    const justChecked = args.validated !== undefined && v.checkedAt !== undefined && clock() - v.checkedAt < 5_000;
    if (v.mode === "pull" && !v.landed && (justChecked || !(await chain.isCommitmentSeen(v.note.commitment)))) {
      let ok = false;
      try {
        paymentHash = await config.submit(payerTransferIntent(md.chainId, md.pool, v.transfer));
        ok = (await chain.waitForReceipt(paymentHash)).status === "success";
      } catch {
        ok = false;
      }
      if (!ok && !(await chain.isCommitmentSeen(v.note.commitment).catch(() => false))) {
        throw fail("The payer's transfer did not go through (its note may have been spent elsewhere). Nothing was paid.");
      }
    }

    const x402Payload: GloamPaymentPayload = {
      x402Version: GLOAM_X402_VERSION,
      scheme: GLOAM_X402_SCHEME,
      network: md.chainId,
      payload: {
        paymentNote: v.payload.ticket,
        txHash: paymentHash,
        exec: {
          poolAddress: md.pool,
          fn: "transfer",
          valueWei: 0n,
          args: [v.transfer.proof ?? "0x", v.transfer.root ?? "0x", v.transfer.nullifier, v.transfer.newCommitments],
        },
      },
    };
    const result = await settleGloamPayment({
      requirements: toPaymentRequirements(v.request, v.realm),
      payload: x402Payload,
      receiveKey: config.receiveKey,
      prove: config.prove,
      chain,
      submit: config.submit,
      // the x402 binding is for X-PAYMENT: this credential's own binding, keyed by the same note
      // secret over this challenge (challengeBinding), was checked in validateGloamCharge
      allowUnbound: true,
      beforeSubmit: async (fresh, intent) => {
        // The note first: a failure here means nothing went out, and a sent record would block every retry.
        await config.beforeSubmit(fresh, intent);
        // Remember the sweep before it goes out, so a lost receipt cannot cost the payer its access.
        await replay.put(key, { state: "sent", at: clock(), freshCommitment: fresh.commitment, sweepHash: null });
        await markChallenge("sent");
        sent = true;
      },
    });

    if (result.grantAccess && result.freshNote) {
      // The chain can show the sweep landed when the relay never gave its hash (its answer was lost after it
      // sent): settled all the same, and referenced as a retry of a sent record is.
      const sweepHash = result.sweep?.hash ?? null;
      const receipt = receiptOf(v, sweepHash ?? (v.payload.type === "hash" ? v.payload.hash : result.freshNote.commitment), clock());
      await finalize({
        state: "settled",
        at: clock(),
        freshCommitment: result.freshNote.commitment,
        sweepHash,
        receipt,
      });
      return receipt;
    }
    if (result.status === "unconfirmed") {
      await replay.put(key, {
        state: "sent",
        at: clock(),
        freshCommitment: result.freshNote?.commitment,
        sweepHash: result.sweep?.hash ?? null,
      });
      throw fail(`${sweepReason(result)} Retry shortly with the same credential.`, true);
    }
    await replay.delete(key);
    await releaseChallenge();
    throw fail(sweepReason(result));
  } catch (e) {
    // Keep a sent record (money may be moving); drop a bare claim unless the failure is worth retrying.
    const drop = !sent && (!(e instanceof GloamChargeError) || !e.retryable);
    if (drop) {
      await replay.delete(key).catch(() => undefined);
      await releaseChallenge().catch(() => undefined);
    }
    throw e;
  }
}
