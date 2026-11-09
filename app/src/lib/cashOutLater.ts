"use client";

/**
 * "Cash out later", browser side (the relay keeps and sends the job:
 * lib/relay/scheduled). The note being cashed out is marked with its job
 * (LocalNote.cashOut) in the encrypted local vault, so a closed tab never loses
 * track of it, and is kept out of the balance while it waits.
 *
 * reconcileCashOuts asks the relay how each job stands. One that went out is
 * settled by the chain like any spend (the note's nullifier shows spent). One
 * that came back unsent (refused, a root the vault never knew, or cancelled)
 * makes the note spendable again, but only once the note's own chain shows it
 * unspent: nothing moved. Its proof stays valid until the note is spent, so the
 * note moves to a fresh one first (shield proofLoose). A job that is going out,
 * or may have gone out, never
 * puts its note back; neither does a relay that can't be read or no longer
 * holds the job. The chain settles those.
 *
 * A proof fixes the amount and the address, not the fee. The vault takes its
 * fee when the cash out lands, at the rate that day, so a job set up before the
 * fee rises still lands, and pays that much less. feeRise says so on its row,
 * and cancelling before it goes keeps the money in the private balance.
 */
import { isAddress, type Address, type Hex } from "viem";
import type { CashOutCall } from "./cashOutProof";
import { readDemo } from "./demoFlag";
import { demoCancelCashOut, demoCashOutStatus, demoReplaceCashOutProof, demoScheduleCashOut } from "./demo/chain";
import { getActiveNetwork, type GloamNetwork } from "./networks";
import { getAllNotes } from "./noteVault";
import { noteNullifierPoseidon } from "./notePoseidon";
import { fieldToHex, hexToField } from "./poseidon";
import { publicClientFor } from "./rhClient";
import { HANDOVER_MS, endedPlan, formatAssetLabel, formatFeePercent, markCleared, shieldPoolAbi, updateLocalNote, withdrawFeeOf, type CashOutMark, type LocalNote } from "./shield";
import { JOB_DONE_TTL_SEC, type DelayWindow } from "./relay/scheduled";

/** The windows the relay offers (lib/relay/scheduled DELAY_WINDOWS): about an hour, 6 hours or a day. */
export type CashOutWindow = DelayWindow;
/** When the relay sends it: at a random time in a window from now, or on a day ahead (a prepaid top-up). */
export type CashOutWhen = CashOutWindow | { day: number; webhook?: string };

export type CashOutJobView = {
  id: string;
  chainId: number;
  sendAfter: number;
  status: "scheduled" | "sending" | "sent" | "expired" | "spent" | "failed" | "cancelled";
  updatedAt: number;
  hash?: Hex;
  reason?: string;
};

/**
 * A job as its owner sees it when scheduling: with the address it really
 * pays. `existing` when the relay answered with the job already waiting for
 * this money (its proof is the one it was scheduled with, not the one sent).
 */
export type OwnedCashOutJob = CashOutJobView & { to: Address; existing?: boolean };

export class CashOutLaterError extends Error {
  constructor(
    message: string,
    public code: string,
    /** already_scheduled: the cash out already waiting for this money. */
    public job?: OwnedCashOutJob
  ) {
    super(message);
  }
}

/** A sent job the chain still doesn't show after this long has its transaction checked. */
const SENT_GRACE_MS = 30 * 60 * 1000;
/** The relay keeps a finished job this long, so past it a job it no longer holds is surely over. */
const GONE_MEANS_OVER_MS = JOB_DONE_TTL_SEC * 1000;

function isOwnedJob(v: unknown): v is OwnedCashOutJob {
  const j = v as Partial<OwnedCashOutJob> | null;
  return Boolean(j && typeof j.id === "string" && typeof j.sendAfter === "number" && typeof j.status === "string" && isAddress(j.to ?? ""));
}

/** The note's mark for a job the relay holds: where it really pays, whether it still waits, and the fee it was set up at. */
export function markFor(job: OwnedCashOutJob, proof?: { root: Hex; at: number }, feeBps?: number): CashOutMark {
  return {
    job: job.id,
    at: job.sendAfter,
    to: job.to,
    state: job.status === "scheduled" ? "scheduled" : "sent",
    ...(proof ? { root: proof.root, provenAt: proof.at } : {}),
    ...(feeBps !== undefined ? { feeBps } : {}),
  };
}

/** What to say when the fee on screen is no longer the vault's. Null when it still is, or when either side isn't known. */
export function feeMovedLine(shownBps: number | null, liveBps: unknown): string | null {
  if (shownBps === null || typeof liveBps !== "number" || liveBps === shownBps) return null;
  return `The cash-out fee just changed to ${formatFeePercent(liveBps)}. Check the new numbers, then confirm again.`;
}

/**
 * Asked right before anything moves, so nobody confirms a number that just
 * changed. A failed read says nothing: the screen's own read, a minute old at
 * most, stands.
 */
export async function feeMoved(net: Pick<GloamNetwork, "chainId" | "chain" | "historyRpc" | "pool">, shownBps: number | null): Promise<string | null> {
  if (shownBps === null || !net.pool || readDemo()) return null;
  const live = await publicClientFor(net)
    .readContract({ address: net.pool, abi: shieldPoolAbi, functionName: "withdrawFeeBps" })
    .catch(() => null);
  return feeMovedLine(shownBps, live);
}

/** What every vault charged until 3 November 2026: a mark with no feeBps was set up at this. */
const FEE_BEFORE_MARKS_KEPT_IT = 25;

export type FeeRise = {
  shownBps: number;
  liveBps: number;
  /** What it showed the recipient would get. */
  shownGets: bigint;
  /** What the recipient gets at today's rate. */
  nowGets: bigint;
};

/**
 * A waiting cash out that will pay less than it showed: the vault's fee has
 * risen since it was set up. Null when it pays what it showed (or more), once
 * it is on its way and can't be stopped, or with no live fee to compare.
 */
export function feeRise(n: Pick<LocalNote, "amountWei" | "cashOut">, liveBps: number | null): FeeRise | null {
  if (n.cashOut?.state !== "scheduled" || liveBps === null) return null;
  const shownBps = n.cashOut.feeBps ?? FEE_BEFORE_MARKS_KEPT_IT;
  if (liveBps <= shownBps) return null;
  const amount = BigInt(n.amountWei);
  return { shownBps, liveBps, shownGets: amount - withdrawFeeOf(amount, shownBps), nowGets: amount - withdrawFeeOf(amount, liveBps) };
}

export type WaitingRise = { note: LocalNote; rise: FeeRise };

/** The jobs in `notes` that will pay less than they showed, each against its own vault's live fee. */
export function waitingFeeRises(notes: LocalNote[], liveBpsOf: (n: LocalNote) => number | null): WaitingRise[] {
  return notes.flatMap((note) => {
    const rise = note.status === "recovered" ? null : feeRise(note, liveBpsOf(note));
    return rise ? [{ note, rise }] : [];
  });
}

/** One row's line: what it pays now against what it showed. */
export function feeRiseLine(rise: FeeRise, asset: string): string {
  return `Pays ${formatAssetLabel(rise.nowGets, asset)}, not the ${formatAssetLabel(rise.shownGets, asset)} it showed.`;
}

/** Said above the rows: why, and what the person can do. `what` names them: "cash out", "top-up". */
export function feeRiseNotice(rises: FeeRise[], what: string): string {
  const fee = formatFeePercent(rises[0]!.liveBps);
  return rises.length === 1
    ? `The cash-out fee went up to ${fee} after you set up this ${what}. The vault takes the fee when it goes out, so it pays less than it showed. Cancel it before it goes to keep the money in your private balance.`
    : `The cash-out fee went up to ${fee} after you set up ${rises.length} ${what}s. The vault takes the fee when each one goes out, so they pay less than they showed. Cancel any of them before it goes to keep that money in your private balance.`;
}

/**
 * Hands a proven cash out to the relay to send at a random time inside
 * `window`, or inside the UTC day `day`. Asking again for the same money
 * returns the job already waiting; when that one pays another address, a
 * CashOutLaterError carries it.
 */
export async function scheduleCashOut(p: {
  chainId: number;
  proof: Hex;
  root: Hex;
  nullifier: Hex;
  asset: Address;
  to: Address;
  amount: bigint;
  window?: CashOutWindow;
  day?: number;
  webhook?: { url: string; series: string };
  /** A partner's link code: the relay registers the cash out under it when scheduling (lib/partnerAttribution). */
  partnerCode?: string;
}): Promise<OwnedCashOutJob> {
  // Recording demo: the pretend relay keeps the job (lib/demo/chain), by the same rules.
  if (readDemo()) {
    const r = await demoScheduleCashOut(p);
    if (r.ok) return r.job;
    throw new CashOutLaterError(r.error, r.code, r.job);
  }
  let res: Response;
  try {
    res = await fetch("/api/relay/scheduled", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...p, amount: p.amount.toString() }),
    });
  } catch {
    throw new CashOutLaterError("Could not reach the relay. Check your connection.", "network");
  }
  const json = (await res.json().catch(() => ({}))) as Partial<OwnedCashOutJob> & {
    ok?: boolean;
    error?: string;
    code?: string;
    job?: unknown;
  };
  if (json.code === "already_scheduled" && isOwnedJob(json.job)) {
    throw new CashOutLaterError(json.error ?? "Already scheduled to another address. Cancel it first.", json.code, json.job);
  }
  if (!res.ok || !json.ok || !isOwnedJob(json)) {
    throw new CashOutLaterError(json.error ?? "Could not schedule this cash out.", json.code ?? "error");
  }
  return json;
}

/**
 * The job's status, "gone" once the relay no longer keeps it, or null when it
 * could not be read (offline, a relay error, or cashing out later is off).
 */
export async function cashOutJobStatus(id: string): Promise<CashOutJobView | "gone" | null> {
  if (readDemo()) return demoCashOutStatus(id);
  try {
    const res = await fetch(`/api/relay/scheduled?id=${encodeURIComponent(id)}`, { cache: "no-store" });
    if (res.status === 404) return "gone";
    const json = (await res.json().catch(() => ({}))) as Partial<CashOutJobView> & { ok?: boolean };
    return res.ok && json.ok && json.status ? (json as CashOutJobView) : null;
  } catch {
    return null;
  }
}

/**
 * What asking to cancel did: "cancelled" now; "over" when it already ended
 * without going out (the next reconcile settles it); "going" once it is on its
 * way or went out; "gone" when the relay no longer holds it; null when the
 * relay could not be asked.
 */
export type CancelResult = "cancelled" | "over" | "going" | "gone" | null;

/**
 * Asks the relay to cancel `note`'s cash out (job `id`). The relay cancels only
 * for whoever holds the note: the request carries the note's nullifier, worked
 * out here from its secret.
 */
export async function cancelCashOut(id: string, note: LocalNote): Promise<CancelResult> {
  if (readDemo()) return demoCancelCashOut(id);
  const nullifier = await nullifierOf(note);
  if (!nullifier) return null;
  try {
    const res = await fetch(`/api/relay/scheduled?id=${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nullifier }),
    });
    if (res.status === 404) return "gone";
    if (!res.ok) return null;
    const json = (await res.json().catch(() => ({}))) as { ok?: boolean; status?: string };
    if (json.ok) return "cancelled";
    if (json.status === "expired" || json.status === "failed" || json.status === "cancelled") return "over";
    if (json.status === "sending" || json.status === "sent" || json.status === "spent") return "going";
    return null;
  } catch {
    return null;
  }
}

/**
 * Hands a proven cash out of `note` to the relay and marks the note with the
 * job, out of the balance while it waits. The address shown is the one the
 * relay holds, not the one asked for: when this money already has a cash out
 * waiting to another address, the note is marked with that one and this throws.
 */
export async function scheduleNoteCashOut(
  note: LocalNote,
  call: CashOutCall,
  when: CashOutWhen,
  feeBps?: number,
  opts: { partnerCode?: string } = {}
): Promise<OwnedCashOutJob> {
  // Every scheduled cash out comes through here. On disk before the proof goes:
  // however this ends, a closed tab included, the note can't be spent past that
  // proof. The lease keeps any tab's sync from moving it until the reply says how
  // it went (shield HANDOVER_MS).
  await updateLocalNote(note.id, { proofOutAt: Date.now(), handoverUntil: Date.now() + HANDOVER_MS });
  const lease = { handoverUntil: undefined };
  // A job already waiting for this money keeps the fee it was set up at.
  const shown = note.cashOut?.feeBps ?? feeBps;
  const series = note.cashOutPlan?.plan;
  const at =
    typeof when === "string"
      ? { window: when }
      : { day: when.day, ...(when.webhook && series ? { webhook: { url: when.webhook, series } } : {}) };
  let job: OwnedCashOutJob;
  try {
    job = await scheduleCashOut({ ...call, ...at, ...(opts.partnerCode ? { partnerCode: opts.partnerCode } : {}) });
  } catch (e) {
    await updateLocalNote(note.id, e instanceof CashOutLaterError && e.job ? { cashOut: markFor(e.job, undefined, shown), ...lease } : lease);
    throw e;
  }
  // The relay may hand back the job already waiting for this money: its proof's root is not this one.
  await updateLocalNote(note.id, { cashOut: markFor(job, job.existing ? undefined : { root: call.root, at: Date.now() }, shown), ...lease });
  return job;
}

/**
 * What handing in a newer proof did: "replaced" (the same job, its send time
 * unchanged), "kept" (refused, with the relay's code: the old proof stays and
 * the cash out goes out as scheduled), or null when the relay could not be
 * asked. Either way nothing is lost: both proofs are of the same cash out.
 */
export type ReplaceProofResult = { status: "replaced"; job: OwnedCashOutJob } | { status: "kept"; code: string } | null;

export async function replaceCashOutProof(id: string, call: CashOutCall): Promise<ReplaceProofResult> {
  if (readDemo()) return demoReplaceCashOutProof(id, call);
  let res: Response;
  try {
    res = await fetch(`/api/relay/scheduled?id=${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...call, amount: call.amount.toString() }),
    });
  } catch {
    return null;
  }
  const json = (await res.json().catch(() => ({}))) as Partial<OwnedCashOutJob> & { ok?: boolean; code?: string };
  if (res.ok && json.ok && isOwnedJob(json)) return { status: "replaced", job: json };
  return json.code ? { status: "kept", code: json.code } : null;
}

/** Notes with a cash out still waiting or on its way. */
export function scheduledCashOutNotes(notes: LocalNote[] = getAllNotes()): LocalNote[] {
  return notes.filter((n) => n.status !== "recovered" && (n.cashOut?.state === "scheduled" || n.cashOut?.state === "sent"));
}

/** Notes whose scheduled cash out came back unsent, for a one-time notice. A top-up shows on its own screen, and is not back yet. */
export function returnedCashOutNotes(notes: LocalNote[] = getAllNotes()): LocalNote[] {
  return notes.filter(
    (n) => n.status !== "recovered" && !n.cashOutPlan?.topUp && (n.cashOut?.state === "expired" || n.cashOut?.state === "failed")
  );
}

const RETURNED = new Set<CashOutMark["state"]>(["expired", "failed", "cancelled"]);

/**
 * What the relay's answer means for the note's mark, or null to leave it. A
 * job going out (or that may have) is "on its way" and never waits again. A
 * relay that no longer holds the job says nothing: the chain settles a spend.
 * A returned state still needs the chain's word (reconcileCashOuts).
 */
export function nextMark(mark: CashOutMark, view: CashOutJobView | "gone"): CashOutMark | null {
  if (view === "gone") return null;
  switch (view.status) {
    case "scheduled":
      return view.sendAfter !== mark.at ? { ...mark, at: view.sendAfter } : null;
    case "sending":
    case "sent":
    case "spent":
      // On its way, or the note's own spend: the chain marks it spent on a later read.
      return mark.state === "sent" ? null : { ...mark, state: "sent" };
    case "expired":
    case "failed":
    case "cancelled":
      return { ...mark, state: view.status };
  }
}

/** What reconciling reads: the relay, and the active network's vault. */
export type CashOutEnv = {
  chainId: number;
  pool: Address | null;
  now: () => number;
  status: (id: string) => Promise<CashOutJobView | "gone" | null>;
  /** null: could not be read. */
  isSpent: (nullifier: Hex) => Promise<boolean | null>;
  /** A sent transaction's outcome; null while it has no receipt or can't be read. */
  receipt: (hash: Hex) => Promise<"success" | "reverted" | null>;
};

/** The relay and the active network's vault, over the app's own RPC. */
export function appCashOutEnv(): CashOutEnv {
  const net = getActiveNetwork();
  const pool = net.pool ?? null;
  // every read of this pass goes to this network's chain, even if the page switches meanwhile
  const client = publicClientFor(net);
  return {
    chainId: net.chainId,
    pool,
    now: () => Date.now(),
    status: cashOutJobStatus,
    isSpent: async (nullifier) => {
      if (!pool) return null;
      try {
        return (await client.readContract({
          address: pool,
          abi: shieldPoolAbi,
          functionName: "isSpent",
          args: [nullifier],
        })) as boolean;
      } catch {
        return null;
      }
    },
    receipt: async (hash) => {
      try {
        return (await client.getTransactionReceipt({ hash })).status;
      } catch {
        return null;
      }
    },
  };
}

async function nullifierOf(n: LocalNote): Promise<Hex | null> {
  if (n.nullifier && n.nullifier !== "0x") return n.nullifier;
  try {
    return fieldToHex(await noteNullifierPoseidon(hexToField(n.secret), hexToField(n.commitment)));
  } catch {
    return null;
  }
}

/** Whether the note's own chain shows it unspent (false: spent, null: could not tell). */
async function unspentOnChain(n: LocalNote, env: CashOutEnv): Promise<boolean | null> {
  const nullifier = await nullifierOf(n);
  if (!nullifier) return null;
  const spent = await env.isSpent(nullifier);
  return spent === null ? null : !spent;
}

/** Notes this env can read: on the active network's vault (another network's are left for when it is active). */
function onEnvChain(n: LocalNote, env: CashOutEnv): boolean {
  return n.chainId === env.chainId && Boolean(env.pool) && n.pool.toLowerCase() === env.pool!.toLowerCase();
}

/**
 * Updates every waiting cash out on the active network from the relay. A note
 * goes back to the balance only when the relay says it ended unsent and the
 * note's chain shows it unspent, or its transaction reverted with the note
 * unspent. True when a note changed.
 */
export async function reconcileCashOuts(env?: CashOutEnv): Promise<boolean> {
  if (!env && typeof window === "undefined") return false;
  const e = env ?? appCashOutEnv();
  let changed = false;
  for (const n of scheduledCashOutNotes()) {
    if (!onEnvChain(n, e)) continue;
    const mark = n.cashOut!;
    const view = await e.status(mark.job);
    if (view === null) continue;
    let next = nextMark(mark, view);
    if (next && RETURNED.has(next.state)) {
      const unspent = await unspentOnChain(n, e);
      if (unspent === null) continue;
      // Spent after all: it went out, and the chain retires the note.
      if (!unspent) next = mark.state === "sent" ? null : { ...mark, state: "sent" };
    } else if (
      !next &&
      view !== "gone" &&
      view.status === "sent" &&
      view.hash &&
      e.now() - view.updatedAt > SENT_GRACE_MS &&
      (await e.receipt(view.hash)) === "reverted" &&
      (await unspentOnChain(n, e)) === true
    ) {
      // Sent, but the transaction reverted and the note is unspent: nothing moved.
      next = { ...mark, state: "failed" };
    } else if (!next && view === "gone" && mark.state === "sent" && e.now() - mark.at > GONE_MEANS_OVER_MS && (await unspentOnChain(n, e)) === true) {
      // On its way when last read, the relay has let the job go, and the note is
      // unspent: it ended unsent while the app was closed. A job going out has no
      // Cancel, so nothing else would ever bring this note back.
      next = { ...mark, state: "failed" };
    }
    if (next) {
      updateLocalNote(n.id, { cashOut: next });
      changed = true;
    }
  }
  return changed;
}

/**
 * A job the relay no longer holds can't be sent by it. Its note is spendable
 * again once its own chain shows it unspent. True when it was put back.
 */
export async function releaseGoneCashOut(n: LocalNote, env: CashOutEnv = appCashOutEnv()): Promise<boolean> {
  if (!n.cashOut || !onEnvChain(n, env)) return false;
  if ((await unspentOnChain(n, env)) !== true) return false;
  await updateLocalNote(n.id, markCleared(n));
  return true;
}

/**
 * A prepaid top-up can wait months and the app can stay closed for longer than
 * the relay keeps a finished job, so "gone" can only mean it is over. The note
 * is settled from its own chain: spent, it went out; unspent, the relay can no
 * longer send it, so it comes back with the usual notice. True when it was.
 */
export async function settleGoneCashOut(n: LocalNote, env: CashOutEnv = appCashOutEnv()): Promise<boolean> {
  if (!n.cashOut || !onEnvChain(n, env)) return false;
  const unspent = await unspentOnChain(n, env);
  if (unspent === null) return false;
  updateLocalNote(n.id, { cashOut: { ...n.cashOut, state: unspent ? "failed" : "sent" } });
  return true;
}

/**
 * Clears the notice on a note whose cash out came back, once it was shown or
 * it is spent again. A private cash out's piece stops being one too: it is
 * plain money in the balance from here, not a piece still to schedule.
 */
export function dismissReturnedCashOut(noteId: string) {
  const n = getAllNotes().find((x) => x.id === noteId);
  if (n) updateLocalNote(noteId, { ...markCleared(n), cashOutPlan: endedPlan(n.cashOutPlan, "returned") });
}
