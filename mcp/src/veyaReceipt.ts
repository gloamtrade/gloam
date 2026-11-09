/**
 * The receipt of a payment VEYA allowed (optional, off unless
 * GLOAM_VEYA_ANCHOR_URL is set).
 *
 * VEYA's allow carries a check id. Once the payment lands, this proves it with
 * the receipt circuit, with that id as the proof's verifier, hashes the proof
 * into one bytes32 leaf, and sends VEYA the leaf to write to storeCommitment.
 * VEYA gets the leaf and the agent id, nothing else.
 *
 * The money has already moved when this runs, so it never throws and nothing it
 * does changes the payment. It runs after the payment's answer (settleReceiptLater):
 * the answer and its credential never wait on a proof or an anchor, since a
 * challenge can expire meanwhile and the agent would pay again. Its state lives on
 * the payment's note in the note store, saved before each step that can fail, so a
 * failed receipt or anchor can be retried. A record the store could not save is
 * never sent: a retry would build another, a second leaf for one payment. That
 * state holds the full record, which shows the asset, the minimum amount and the
 * transaction hash: only the leaf and a status leave here.
 *
 * Two runs can reach one receipt: reading a mainnet vault's tree can outlast the
 * wait for the answer, so a retry can arrive while the first run is still going, and
 * two processes can share a note store. In one process the second run joins the
 * first. Across processes the store decides: see `advance`.
 */
import { buildPaymentReceipt, cleanReceiptLabel, proofContext, type PaymentReceiptPlan, type ReceiptProver, type syncTree } from "@gloamtrade/sdk";
import type { Hex } from "viem";
import { guardTimeoutMs } from "./guardCall.js";
import type { McpNetwork } from "./networks.js";
import type { NoteReceipt, NoteStore, StoredNote } from "./noteStore.js";
import { anchorLeaf } from "./veyaGuard.js";

type Env = Record<string, string | undefined>;

/** The SDK's default for a receipt. Gloam's /verify reads a receipt as expired after it; the leaf stays on chain. */
const RECEIPT_TTL_S = 30 * 24 * 3600;
/** How long gloam_retry_veya_receipts waits on a receipt before it answers. The work may finish after. */
const RECEIPT_TIMEOUT_MS = 30_000;
/** An RPC can trail the receipt it just gave, so a tree that lacks the payment is read again before giving up. */
const SYNC_TRIES = 3;
const SYNC_WAIT_MS = 1_500;

export interface ReceiptContext {
  net: McpNetwork;
  client: Parameters<typeof syncTree>[0];
  syncTree: typeof syncTree;
  prover(): Promise<ReceiptProver>;
  notes: NoteStore;
  env: Env;
}

/** What the agent sees of a receipt: never the record. */
export interface ReceiptOutcome {
  /** "pending": the payment's own answer, given before the receipt work, which goes on after it. */
  status: "pending" | "anchored" | "anchor_failed" | "receipt_failed";
  /** The payment's note handle, for gloam_retry_veya_receipts. */
  note: string;
  checkId: string;
  leaf: Hex | null;
  /** The transaction VEYA says wrote the leaf. */
  anchorTx: Hex | null;
  /** One line for the agent: a failure here says the payment still went through. */
  message: string;
}

const PAID = "Paid, and the money has moved, so do not pay again.";
const ALREADY = "VEYA already took this receipt's leaf.";
const RETRY = "Call gloam_retry_veya_receipts to try again.";
const FIX_FIRST = "A retry will get the same answer until that changes, then call gloam_retry_veya_receipts.";

/** What goes on the payment's note before it is sent, so a payment that lands with no answer can still get its receipt. */
export const plannedReceipt = (check: { checkId: string; agentId: string }): NoteReceipt => ({
  ...check,
  expiresAt: Math.floor(Date.now() / 1000) + RECEIPT_TTL_S,
  status: "pending",
});

/**
 * A step's result on the receipt the store holds now: anchored is final, and the
 * first record stands, since a second would be a second leaf for the same payment.
 */
function advance(current: NoteReceipt, patch: Partial<NoteReceipt>): NoteReceipt {
  if (current.status === "anchored") return current;
  return current.record ? { ...current, ...patch, record: current.record, leaf: current.leaf } : { ...current, ...patch };
}

function receiptPlan(note: StoredNote, receipt: NoteReceipt): PaymentReceiptPlan {
  const verifier = cleanReceiptLabel(receipt.checkId);
  return {
    chainId: note.chainId,
    pool: note.pool,
    asset: note.asset,
    paymentNote: { secret: note.secret, commitment: note.commitment, nullifier: note.nullifier, amountWei: note.amountWei, asset: note.asset },
    reveal: false,
    minAmountWei: BigInt(note.amountWei),
    verifier,
    expiresAt: receipt.expiresAt,
    context: proofContext({ kind: "payment", chainId: note.chainId, pool: note.pool, verifier, expiresAt: receipt.expiresAt }),
  };
}

/** The payment's path, from a tree read now: the one it was paid from was read before the payment existed. */
async function pathAfterLanding(note: StoredNote, ctx: ReceiptContext) {
  for (let tries = 0; tries < SYNC_TRIES; tries++) {
    if (tries) await new Promise((r) => setTimeout(r, SYNC_WAIT_MS));
    const tree = await ctx.syncTree(ctx.client, { pool: note.pool, fromBlock: ctx.net.deployBlock });
    const path = await tree.pathForCommitment(note.commitment);
    if (path) return path;
  }
  return null;
}

/**
 * Build the receipt if it is not built yet, then send VEYA its leaf if it has not
 * taken it. A built record is never rebuilt: a new root would make a new leaf for
 * the same payment. `note.createdTx` is the transaction that landed. Never throws.
 */
export async function settleReceipt(note: StoredNote & { receipt: NoteReceipt }, ctx: ReceiptContext): Promise<ReceiptOutcome> {
  let receipt = note.receipt;
  let kept = true;
  try {
    receipt = ctx.notes.get(note.handle)?.receipt ?? receipt; // the note passed in may be older than the store
  } catch {
    kept = false;
  }
  /** Save a step under the store's lock. False when the store did not take it, and then the step is in memory only. */
  const keep = (patch: Partial<NoteReceipt>): boolean => {
    try {
      const saved = ctx.notes.updateReceipt(note.handle, (current) => advance(current, patch));
      if (saved) {
        receipt = saved;
        return true;
      }
    } catch {
      // the store could not be read or written
    }
    kept = false;
    receipt = advance(receipt, patch);
    return false;
  };
  const outcome = (status: ReceiptOutcome["status"], message: string): ReceiptOutcome => ({
    status,
    note: note.handle,
    checkId: receipt.checkId,
    leaf: receipt.leaf ?? null,
    anchorTx: receipt.anchorTx ?? null,
    message: kept ? message : `${message} The receipt could not be saved in the note store, so it may not be possible to retry it.`,
  });

  // A function, since keep() can change it: another run may finish at any step here.
  const anchored = () => receipt.status === "anchored";
  if (anchored()) return outcome("anchored", ALREADY);
  if (!receipt.record) {
    let why: string | null = null;
    if (!note.createdTx) why = "The payment's transaction is not known yet.";
    else {
      try {
        const path = await pathAfterLanding(note, ctx);
        if (!path) why = "The payment does not show in the vault's tree yet, so its receipt could not be built.";
        else {
          const record = await buildPaymentReceipt({ plan: receiptPlan(note, receipt), path, txHash: note.createdTx, prove: await ctx.prover() });
          // Saved before it goes out, so a crash here leaves a leaf to send again, not a second one. A record the
          // store did not take never goes out: a retry would build another, and VEYA would hold two leaves for one payment.
          if (!keep({ status: "anchor_failed", record, leaf: record.leaf })) {
            receipt = { ...receipt, status: "receipt_failed", record: undefined, leaf: undefined };
            keep({ status: "receipt_failed" });
            return {
              status: "receipt_failed",
              note: note.handle,
              checkId: receipt.checkId,
              leaf: null,
              anchorTx: null,
              message: `${PAID} The receipt was built, but the note store could not save it, so its leaf was not sent to VEYA. ${RETRY}`,
            };
          }
        }
      } catch {
        why = "The receipt could not be built.";
      }
    }
    if (why) {
      keep({ status: "receipt_failed" });
      // Another run may have got further while this one failed, and then its result stands.
      if (!receipt.record) return outcome("receipt_failed", `${PAID} ${why} Nothing went to VEYA. ${RETRY}`);
    }
    if (anchored()) return outcome("anchored", ALREADY);
  }

  const sent = await anchorLeaf(receipt.leaf!, receipt.agentId, ctx.env);
  if (!sent.anchored) {
    keep({ status: "anchor_failed" });
    if (anchored()) return outcome("anchored", ALREADY);
    return outcome("anchor_failed", `${PAID} The receipt is built and kept, but VEYA did not take its leaf: ${sent.why}. ${sent.retry ? RETRY : FIX_FIRST}`);
  }
  keep({ status: "anchored", anchorTx: sent.txHash });
  return outcome("anchored", sent.duplicate ? "Paid, and VEYA already had the receipt's leaf." : "Paid, and VEYA took the receipt's leaf.");
}

/** The leaf the note store holds for a payment, if the receipt got that far. */
function keptLeaf(handle: string, ctx: ReceiptContext): Hex | null {
  try {
    return ctx.notes.get(handle)?.receipt?.leaf ?? null;
  } catch {
    return null;
  }
}

/** Receipts being worked on in this process, by note store and note. */
const running = new Map<string, Promise<ReceiptOutcome>>();

/** A run for this note if one is going, else a new one. */
function settleOnce(note: StoredNote & { receipt: NoteReceipt }, ctx: ReceiptContext): Promise<ReceiptOutcome> {
  const key = `${ctx.notes.path}\n${note.handle}`;
  const already = running.get(key);
  if (already) return already;
  const run = settleReceipt(note, ctx).finally(() => running.delete(key));
  running.set(key, run);
  return run;
}

/**
 * Start the receipt and answer at once. The payment's answer, and the credential in it, never wait on a proof or an
 * anchor. The work goes on in this process: `work` settles with its outcome, and gloam_retry_veya_receipts joins it
 * while it runs, or picks it up from the note store after a restart. Never throws.
 */
export function settleReceiptLater(note: StoredNote & { receipt: NoteReceipt }, ctx: ReceiptContext): { now: ReceiptOutcome; work: Promise<ReceiptOutcome> } {
  const now: ReceiptOutcome = {
    status: "pending",
    note: note.handle,
    checkId: note.receipt.checkId,
    leaf: null,
    anchorTx: null,
    message: `${PAID} Its receipt is built and sent to VEYA after this answer, so nothing here waits on it. Keep this server running until it is done; gloam_retry_veya_receipts shows where it stands.`,
  };
  const work = settleOnce(note, ctx).catch(
    (): ReceiptOutcome => ({ ...now, status: "receipt_failed", message: `${PAID} The receipt could not be built. Nothing went to VEYA. ${RETRY}` })
  );
  return { now, work };
}

/** settleReceipt, but the caller stops waiting at the deadline. The work may still finish; a retry shows where it stands. */
export async function settleReceiptInTime(note: StoredNote & { receipt: NoteReceipt }, ctx: ReceiptContext): Promise<ReceiptOutcome> {
  const ms = guardTimeoutMs(ctx.env.GLOAM_VEYA_RECEIPT_TIMEOUT_MS, RECEIPT_TIMEOUT_MS);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<ReceiptOutcome>((resolve) => {
    timer = setTimeout(() => {
      const leaf = keptLeaf(note.handle, ctx);
      resolve({
        status: leaf ? "anchor_failed" : "receipt_failed",
        note: note.handle,
        checkId: note.receipt.checkId,
        leaf,
        anchorTx: null,
        message: `${PAID} ${leaf ? "The receipt is built and kept, but VEYA has not taken its leaf yet" : "The receipt is not built yet"} after ${ms / 1000}s, and that may still finish. ${RETRY}`,
      });
    }, ms);
  });
  try {
    return await Promise.race([settleOnce(note, ctx), late]);
  } finally {
    clearTimeout(timer);
  }
}
