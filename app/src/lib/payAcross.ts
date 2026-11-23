/**
 * Pay one person more than any single private balance entry holds.
 *
 * A private transfer spends exactly one note (the circuit is one in, two out:
 * the payment and the change). So $20 from notes of $10, $7 and $4 can't go as
 * one transfer. Here it goes as a few, back to back, to the same Gloam address:
 * $10, $7, then $3 out of the $4 (with $1 of change). One confirm, one progress
 * view, and the person paid sees each part land on its own (lib/autoReceive).
 *
 * The parts run on payroll's engine (lib/payroll runPayroll): a "pay" run whose
 * rows all pay the same person. That engine is already crash safe: each part's
 * change and code are saved before it is sent, a part is never sent twice, a
 * refresh resumes where it stopped, and a part whose outcome is unclear is held
 * until the chain settles it. Pay runs are kept with payroll's (so the backup
 * carries a part still landing) but never listed as payroll runs.
 *
 * The private note goes with the first part only, so it is read once.
 */
import type { Address } from "viem";
import { fundingPlan, newBatch, withRunLock, type DraftRow, type PayrollBatch } from "./payroll";
import { loadBatches, loadStoredRun, saveBatch } from "./payrollStore";

/** At most this many parts in one payment: each is a relayed transfer and a proof on this device. */
export const PAY_MAX_PARTS = 6;

export type PayPartsPlan =
  /** The amounts to send, largest first; one part means a single note covers it. */
  | { ok: true; parts: bigint[] }
  /** More than the balance holds, or than PAY_MAX_PARTS parts can carry: `most` is what can go now. */
  | { ok: false; reason: "over_total" | "too_many_parts"; most: bigint };

/**
 * The parts that pay `amount` from notes of these sizes: whole notes, largest
 * first, then what is left out of the next one. That is the fewest parts there
 * can be. Checked against the order the engine spends in (each part from the
 * smallest note that covers it), so the run never comes up short.
 */
export function planPayParts(amount: bigint, noteAmounts: bigint[], maxParts = PAY_MAX_PARTS): PayPartsPlan {
  const notes = noteAmounts.filter((n) => n > 0n).sort((a, b) => (a > b ? -1 : a < b ? 1 : 0));
  const total = notes.reduce((s, n) => s + n, 0n);
  const cap = Math.max(1, maxParts);
  const most = notes.slice(0, cap).reduce((s, n) => s + n, 0n);
  if (amount <= 0n) return { ok: false, reason: "over_total", most };
  if (amount > total) return { ok: false, reason: "over_total", most };
  const parts: bigint[] = [];
  let left = amount;
  for (const n of notes) {
    if (left <= n) {
      parts.push(left);
      left = 0n;
      break;
    }
    parts.push(n);
    left -= n;
  }
  if (left > 0n || parts.length > cap) return { ok: false, reason: "too_many_parts", most };
  // the engine pays each part from the smallest note that covers it: it must cover them all
  if (fundingPlan(parts, notes).shortfall !== 0n) return { ok: false, reason: "too_many_parts", most };
  return { ok: true, parts };
}

/**
 * planPayParts over the notes themselves: each part with the note it spends.
 * Whole notes largest first, and the last part out of the next one, so every
 * part spends a note that exists now, only the last has change, and no part
 * waits on another's change. The parts are independent: all could be proven
 * against one vault root and sent together.
 */
export function planPayFrom(
  amount: bigint,
  notes: { id: string; amountWei: string }[],
  maxParts = PAY_MAX_PARTS
): { ok: true; parts: bigint[]; noteIds: string[] } | { ok: false; reason: "over_total" | "too_many_parts"; most: bigint } {
  const sorted = notes
    .map((n) => ({ id: n.id, amount: BigInt(n.amountWei) }))
    .filter((n) => n.amount > 0n)
    .sort((a, b) => (a.amount > b.amount ? -1 : a.amount < b.amount ? 1 : a.id < b.id ? -1 : 1));
  const plan = planPayParts(amount, sorted.map((n) => n.amount), maxParts);
  if (!plan.ok) return plan;
  // planPayParts takes the notes in this same order, one per part
  return { ok: true, parts: plan.parts, noteIds: sorted.slice(0, plan.parts.length).map((n) => n.id) };
}

/** A run made by Pay rather than by Payroll. */
export function isPayRun(b: Pick<PayrollBatch, "purpose">): boolean {
  return b.purpose === "pay";
}

/**
 * The run that sends `parts` to one Gloam address. `label` is how the person
 * shows ("@ada", or the start of their address); `name` the Gloam name it was
 * paid by, if any.
 */
export function newPayRun(args: {
  chainId: number;
  pool: Address;
  asset: Address;
  payer: Address;
  tag: string;
  label: string;
  name?: string;
  parts: bigint[];
  /** The note each part spends (planPayFrom), same order as `parts`. */
  noteIds?: string[];
  note?: string;
}): PayrollBatch {
  const rows: DraftRow[] = args.parts.map((amount, i) => ({
    line: i + 1,
    name: args.label,
    recipient: args.tag,
    kind: "gloam",
    amountInput: amount.toString(),
    amount,
    // the note is read once, with the first part
    note: i === 0 && args.note ? args.note : "",
    ...(args.name ? { payName: args.name } : {}),
    ...(args.noteIds?.[i] ? { planNoteId: args.noteIds[i] } : {}),
    error: null,
  }));
  const run = newBatch({
    title: `Payment to ${args.label}`,
    chainId: args.chainId,
    pool: args.pool,
    asset: args.asset,
    employer: args.payer,
    relay: true,
    rows,
  });
  return { ...run, id: `pay-${run.createdAt}`, purpose: "pay" };
}

export type PayRunProgress = {
  parts: number;
  /** Landed in the vault. */
  sent: number;
  failed: number;
  /** Every part settled, paid or failed. */
  done: boolean;
  /** A part sent whose outcome the chain hasn't settled yet. */
  unconfirmed: boolean;
};

export function payRunProgress(run: PayrollBatch): PayRunProgress {
  const sent = run.rows.filter((r) => r.status === "paid").length;
  const failed = run.rows.filter((r) => r.status === "failed").length;
  return {
    parts: run.rows.length,
    sent,
    failed,
    done: run.status === "done",
    unconfirmed: run.rows.some((r) => r.status === "unconfirmed"),
  };
}

/** What was paid so far, in raw units. */
export function payRunPaid(run: PayrollBatch): bigint {
  return run.rows.filter((r) => r.status === "paid").reduce((s, r) => s + BigInt(r.amount), 0n);
}

/** What the run pays in all, in raw units. */
export function payRunTotal(run: PayrollBatch): bigint {
  return run.rows.reduce((s, r) => s + BigInt(r.amount), 0n);
}

/**
 * Stop the parts not sent yet. Only when none is on its way: a part already
 * handed to the relay must be settled by the chain first (resume does that).
 * Returns the run as it should be saved, or null when it can't stop now.
 */
export function cancelPayRest(run: PayrollBatch): PayrollBatch | null {
  if (run.rows.some((r) => r.spendNullifier && r.status !== "paid" && r.status !== "failed")) return null;
  return {
    ...run,
    status: "done",
    rows: run.rows.map((r) => (r.status === "paid" || r.status === "failed" ? r : { ...r, status: "failed" as const, error: "Cancelled" })),
  };
}

/** A pay run not finished: parts still to send, or one the chain hasn't settled. */
export function payRunUnfinished(run: Pick<PayrollBatch, "status">): boolean {
  return run.status !== "done";
}

/** This account's unfinished pay run on this vault, newest first, or null. */
export function unfinishedPayRun(
  runs: PayrollBatch[],
  who: { employer: Address; chainId: number; pool: Address }
): PayrollBatch | null {
  const mine = runs.filter(
    (r) =>
      isPayRun(r) &&
      payRunUnfinished(r) &&
      r.chainId === who.chainId &&
      r.pool.toLowerCase() === who.pool.toLowerCase() &&
      r.employer.toLowerCase() === who.employer.toLowerCase()
  );
  return mine.sort((a, b) => b.createdAt - a.createdAt)[0] ?? null;
}

/**
 * Saves `run` to start it, unless this account already has a payment in parts
 * not finished on this vault: then that one comes back to finish (Resume, or
 * Stop the rest), and `run` is dropped unsaved. Held under one lock per account
 * and vault, so two taps or two tabs at once start one payment, never two.
 * Throws RUN_ELSEWHERE while another start holds the lock.
 */
export async function startPayRun(run: PayrollBatch): Promise<{ run: PayrollBatch; started: boolean }> {
  const lock = `pay-start-${run.chainId}-${run.pool.toLowerCase()}-${run.employer.toLowerCase()}`;
  return withRunLock(lock, async () => {
    const left = unfinishedPayRun(await loadBatches(run.chainId, run.pool), { employer: run.employer, chainId: run.chainId, pool: run.pool });
    if (left) return { run: left, started: false };
    await saveBatch(run);
    return { run, started: true };
  });
}

/**
 * Stop the rest, safely: under the run's own lock (RUN_ELSEWHERE while a tab is
 * paying it) and from the stored run, never a copy loaded earlier. Null when a
 * part is on its way (the chain settles it first).
 */
export async function stopPayRest(run: Pick<PayrollBatch, "id">): Promise<PayrollBatch | null> {
  return withRunLock(run.id, async () => {
    const fresh = await loadStoredRun(run.id);
    if (!fresh) return null;
    const stopped = cancelPayRest(fresh);
    if (stopped) await saveBatch(stopped);
    return stopped;
  });
}
