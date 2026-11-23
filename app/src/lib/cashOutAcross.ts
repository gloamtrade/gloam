/**
 * Cash out more than one private balance entry holds, in one go.
 *
 * A cash out spends one whole note (the circuit proves one note out to one
 * address), so $20 from notes of $10, $7 and $4 goes as a few cash outs to the
 * same wallet: the $10 note, the $7 note, then $3 out of the $4 (set aside in
 * its own note first, lib/cashOutSplit, with $1 of change). One confirm, one
 * progress view. Each one is a public withdrawal: the chain shows its amount
 * and where it went, like any cash out.
 *
 * Now only, on the network shown, to one address. Cashing out later, in
 * private pieces, or to another chain stays one balance at a time.
 *
 * Crash safe the same way a payment in parts is (lib/payAcross):
 *  - the run is saved before anything is sent, and each part's nullifier is
 *    saved before that part goes out;
 *  - a part that may have gone out is settled from the chain before anything
 *    else happens to it, and is sent again only when the chain shows its note
 *    unspent and its last send did not land. The vault itself refuses a spent
 *    nullifier, so the same note can never pay out twice;
 *  - one run at a time per account and vault, held under one lock, so two taps
 *    or two tabs start one cash out; Stop the rest works from the stored run.
 * Sending is one function (deps.submit), so the parts can later go out
 * together in one transaction.
 */
import type { Address, Hex } from "viem";
import type { CashOutCall } from "./cashOutProof";
import { PAY_MAX_PARTS, planPayFrom } from "./payAcross";
import { withRunLock } from "./payroll";
import type { LocalNote } from "./shield";

/** At most this many cash outs in one go: each is a proof on this device and a public withdrawal. */
export const CASHOUT_MAX_PARTS = PAY_MAX_PARTS;

/** After this long with no sign of a send, a part whose note is still unspent is sent again. */
export const CASHOUT_RESEND_AFTER_MS = 15 * 60_000;

export const CASHOUT_WAITING = "Waiting for the network to confirm it. Resume in a moment.";
export const CASHOUT_MAYBE_SENT = "It may have gone out. Resume to let the network settle it first.";
export const CASHOUT_MOVED = "That balance moved since, so nothing was cashed out from it.";
export const CASHOUT_CANCELLED = "Cancelled";

export type CashOutPartStatus =
  /** Nothing done yet. */
  | "queued"
  /** Its note is ready to cash out (a split part: set aside already). */
  | "ready"
  /** Handed to the relay or the wallet: the chain settles it. */
  | "sent"
  | "paid"
  | "failed";

export type CashOutPart = {
  /** The note this part comes from. */
  noteId: string;
  /** What this part cashes out, before the vault's fee, in raw units. */
  amount: string;
  /** The whole note goes; otherwise this part is set aside in its own note first. */
  whole: boolean;
  /** The note cashed out: the same note for a whole part, the set-aside one otherwise. */
  targetNoteId?: string;
  /** That note's nullifier, saved before it is sent. */
  nullifier?: Hex;
  txHash?: Hex;
  sentAt?: number;
  status: CashOutPartStatus;
  error?: string;
};

export type CashOutAcrossRun = {
  v: 1;
  id: string;
  chainId: number;
  pool: Address;
  asset: Address;
  owner: Address;
  to: Address;
  /** Through the relay (Hide my wallet) or from the wallet. */
  relay: boolean;
  createdAt: number;
  status: "running" | "done";
  parts: CashOutPart[];
};

/** A note this can cash out whole: open, in the vault, and in no proof or swap that needs it moved first. */
export function cashOutAcrossEligible(n: Pick<LocalNote, "fundsProofAt" | "swapProofAt">): boolean {
  return !n.fundsProofAt && !n.swapProofAt;
}

/**
 * The parts that cash out `amount` from these notes: whole notes largest first,
 * then what is left out of the next one. The fewest parts there can be.
 */
export function planCashOutFrom(
  amount: bigint,
  notes: { id: string; amountWei: string }[],
  maxParts = CASHOUT_MAX_PARTS
): ReturnType<typeof planPayFrom> {
  return planPayFrom(amount, notes, maxParts);
}

/** What the wallet gets in all: each part less the vault's fee on that part. */
export function cashOutAcrossReceived(parts: bigint[], feeOf: (amount: bigint) => bigint): bigint {
  return parts.reduce((s, p) => s + (p - feeOf(p)), 0n);
}

export function newCashOutRun(args: {
  chainId: number;
  pool: Address;
  asset: Address;
  owner: Address;
  to: Address;
  relay: boolean;
  parts: bigint[];
  noteIds: string[];
  noteAmounts: Record<string, string>;
  now?: number;
}): CashOutAcrossRun {
  const now = args.now ?? Date.now();
  return {
    v: 1,
    id: `cashout-${now}`,
    chainId: args.chainId,
    pool: args.pool,
    asset: args.asset,
    owner: args.owner,
    to: args.to,
    relay: args.relay,
    createdAt: now,
    status: "running",
    parts: args.parts.map((amount, i) => {
      const noteId = args.noteIds[i]!;
      const whole = args.noteAmounts[noteId] === amount.toString();
      return { noteId, amount: amount.toString(), whole, ...(whole ? { targetNoteId: noteId } : {}), status: "queued" as const };
    }),
  };
}

export type CashOutProgress = { parts: number; paid: number; failed: number; done: boolean; waiting: boolean };

export function cashOutProgress(run: CashOutAcrossRun): CashOutProgress {
  return {
    parts: run.parts.length,
    paid: run.parts.filter((p) => p.status === "paid").length,
    failed: run.parts.filter((p) => p.status === "failed").length,
    done: run.status === "done",
    waiting: run.parts.some((p) => p.status === "sent"),
  };
}

/** What has gone out so far (before fees), in raw units. */
export function cashOutPaid(run: CashOutAcrossRun): bigint {
  return run.parts.filter((p) => p.status === "paid").reduce((s, p) => s + BigInt(p.amount), 0n);
}

export function cashOutTotal(run: CashOutAcrossRun): bigint {
  return run.parts.reduce((s, p) => s + BigInt(p.amount), 0n);
}

export type CashOutAcrossDeps = {
  /** The run as stored now (null when none): a run is always worked from its stored copy. */
  load: (id: string) => Promise<CashOutAcrossRun | null>;
  save: (run: CashOutAcrossRun) => Promise<void>;
  /** A note in this browser's balance, by id. */
  getNote: (id: string) => LocalNote | undefined;
  /** The note an earlier split of `noteId` set aside for `amount`, if one was made. */
  findSplitPart: (noteId: string, amount: bigint) => LocalNote | undefined;
  /** Set `amount` of `note` aside in its own note (lib/cashOutSplit splitForCashOut), landed. */
  split: (note: LocalNote, amount: bigint) => Promise<LocalNote>;
  /** A cash out of all of `note` to `to`. */
  prove: (note: LocalNote, to: Address) => Promise<CashOutCall>;
  /** Hand the cash out to the relay or the wallet. One function, so parts can later go out together. */
  submit: (call: CashOutCall) => Promise<Hex>;
  /** A failed submit that may still have gone out. */
  maybeSent: (e: unknown) => boolean;
  waitForTx: (hash: Hex) => Promise<"success" | "reverted" | null>;
  isSpent: (nullifier: Hex) => Promise<boolean>;
  /** The note left the balance (paid out). */
  markSpent: (noteId: string, hash: Hex) => void;
  onUpdate?: (run: CashOutAcrossRun) => void;
  shouldStop?: () => boolean;
  now?: () => number;
};

function copy(run: CashOutAcrossRun): CashOutAcrossRun {
  return JSON.parse(JSON.stringify(run)) as CashOutAcrossRun;
}

/**
 * What became of a part handed out before: "paid" when its note is spent,
 * "unsent" when it surely didn't land and its note is unspent (safe to send
 * again: the vault refuses a spent nullifier anyway), "waiting" otherwise.
 */
async function settleSent(part: CashOutPart, deps: CashOutAcrossDeps, now: number): Promise<"paid" | "unsent" | "waiting"> {
  if (!part.nullifier) return "unsent";
  if (await deps.isSpent(part.nullifier)) return "paid";
  if (part.txHash) {
    const outcome = await deps.waitForTx(part.txHash).catch(() => null);
    if (outcome === "success") return (await deps.isSpent(part.nullifier)) ? "paid" : "waiting";
    if (outcome === "reverted") return (await deps.isSpent(part.nullifier)) ? "paid" : "unsent";
  }
  return part.sentAt != null && now - part.sentAt > CASHOUT_RESEND_AFTER_MS ? "unsent" : "waiting";
}

/**
 * Run (or resume) a cash out across balances. Held for this tab only
 * (RUN_ELSEWHERE while another holds it), worked from the stored copy, saved
 * at every step. Resolves when every part is paid or failed, or when it stops
 * (Stop, a part waiting on the chain, or an error: the run says which).
 */
export function runCashOutAcross(run: Pick<CashOutAcrossRun, "id">, deps: CashOutAcrossDeps): Promise<CashOutAcrossRun> {
  return withRunLock(run.id, async () => {
    const stored = await deps.load(run.id);
    if (!stored) throw new Error("This cash out isn't saved in this browser.");
    const r = copy(stored);
    const now = () => (deps.now ?? Date.now)();
    const save = async () => {
      await deps.save(r);
      deps.onUpdate?.(copy(r));
    };
    if (r.status === "done") return r;

    for (const part of r.parts) {
      if (part.status === "paid" || part.status === "failed") continue;
      if (deps.shouldStop?.()) break;

      // 1. A part handed out before: the chain settles it first, so it never goes twice.
      if (part.status === "sent") {
        const settled = await settleSent(part, deps, now());
        if (settled === "paid") {
          part.status = "paid";
          delete part.error;
          if (part.targetNoteId && part.txHash) deps.markSpent(part.targetNoteId, part.txHash);
          await save();
          continue;
        }
        if (settled === "waiting") {
          part.error = CASHOUT_WAITING;
          await save();
          return r;
        }
        part.status = "ready";
        delete part.txHash;
        delete part.sentAt;
      }

      // 2. The note to cash out: the whole note, or the part set aside from it.
      let target = part.targetNoteId ? deps.getNote(part.targetNoteId) : undefined;
      if (!part.whole && !target) {
        const earlier = deps.findSplitPart(part.noteId, BigInt(part.amount));
        if (earlier?.sweepPending) {
          // set aside already, still landing: the sync settles it, then resume
          part.targetNoteId = earlier.id;
          part.error = CASHOUT_WAITING;
          await save();
          return r;
        }
        if (earlier) {
          target = earlier;
        } else {
          const from = deps.getNote(part.noteId);
          if (!from || from.status !== "open") {
            part.status = "failed";
            part.error = CASHOUT_MOVED;
            await save();
            continue;
          }
          target = await deps.split(from, BigInt(part.amount));
        }
        part.targetNoteId = target.id;
        part.status = "ready";
        delete part.error;
        await save();
      }
      if (!target || target.status !== "open" || BigInt(target.amountWei) !== BigInt(part.amount)) {
        part.status = "failed";
        part.error = CASHOUT_MOVED;
        await save();
        continue;
      }

      // 3. Prove, save the nullifier, then send.
      const call = await deps.prove(target, r.to);
      if (call.to.toLowerCase() !== r.to.toLowerCase() || call.amount !== BigInt(part.amount)) {
        throw new Error("The cash out didn't match what was set up, so nothing was sent.");
      }
      if (await deps.isSpent(call.nullifier)) {
        // spent elsewhere (another tab or device) before this run sent it
        part.status = "failed";
        part.error = CASHOUT_MOVED;
        await save();
        continue;
      }
      part.nullifier = call.nullifier;
      part.targetNoteId = target.id;
      part.status = "sent";
      part.sentAt = now();
      delete part.error;
      await save();

      let hash: Hex;
      try {
        hash = await deps.submit(call);
      } catch (e) {
        if (deps.maybeSent(e)) {
          part.error = CASHOUT_MAYBE_SENT;
          await save();
          return r;
        }
        // surely not sent: the part waits for the next try
        part.status = "ready";
        delete part.sentAt;
        part.error = e instanceof Error ? e.message : "The cash out didn't go through.";
        await save();
        throw e;
      }
      part.txHash = hash;
      await save();

      const outcome = await deps.waitForTx(hash).catch(() => null);
      if (outcome === "success") {
        part.status = "paid";
        deps.markSpent(target.id, hash);
        await save();
        continue;
      }
      if (outcome === "reverted" && !(await deps.isSpent(call.nullifier))) {
        part.status = "ready";
        delete part.sentAt;
        part.error = "This part didn't go through on this try. Resume to try it again.";
        await save();
        return r;
      }
      if (outcome === "reverted") {
        // reverted, yet the note is spent: an earlier send of it landed
        part.status = "paid";
        deps.markSpent(target.id, hash);
        await save();
        continue;
      }
      part.error = CASHOUT_WAITING;
      await save();
      return r;
    }

    if (r.parts.every((p) => p.status === "paid" || p.status === "failed")) {
      r.status = "done";
      await save();
    }
    return r;
  });
}

/** Stop the parts not sent yet, from the stored run. Null while a part is on its way (the chain settles it first). */
export function cancelCashOutRest(run: CashOutAcrossRun): CashOutAcrossRun | null {
  if (run.parts.some((p) => p.status === "sent")) return null;
  return {
    ...run,
    status: "done",
    parts: run.parts.map((p) => (p.status === "paid" || p.status === "failed" ? p : { ...p, status: "failed" as const, error: CASHOUT_CANCELLED })),
  };
}

/** This account's cash out across balances not finished on this vault, newest first, or null. */
export function unfinishedCashOut(runs: CashOutAcrossRun[], who: { owner: Address; chainId: number; pool: Address }): CashOutAcrossRun | null {
  return (
    runs
      .filter(
        (r) =>
          r.status !== "done" &&
          r.chainId === who.chainId &&
          r.pool.toLowerCase() === who.pool.toLowerCase() &&
          r.owner.toLowerCase() === who.owner.toLowerCase()
      )
      .sort((a, b) => b.createdAt - a.createdAt)[0] ?? null
  );
}

/**
 * Save `run` to start it, unless this account has one not finished on this
 * vault: that one comes back instead. One lock per account and vault, so two
 * taps or tabs start one.
 */
export function startCashOutRun(
  run: CashOutAcrossRun,
  store: { loadAll: (chainId: number, pool: Address) => Promise<CashOutAcrossRun[]>; save: (r: CashOutAcrossRun) => Promise<void> }
): Promise<{ run: CashOutAcrossRun; started: boolean }> {
  const lock = `cashout-start-${run.chainId}-${run.pool.toLowerCase()}-${run.owner.toLowerCase()}`;
  return withRunLock(lock, async () => {
    const left = unfinishedCashOut(await store.loadAll(run.chainId, run.pool), { owner: run.owner, chainId: run.chainId, pool: run.pool });
    if (left) return { run: left, started: false };
    await store.save(run);
    return { run, started: true };
  });
}

/** Stop the rest under the run's own lock, from the stored copy. Null while a part is on its way. */
export function stopCashOutRest(
  run: Pick<CashOutAcrossRun, "id">,
  store: { load: (id: string) => Promise<CashOutAcrossRun | null>; save: (r: CashOutAcrossRun) => Promise<void> }
): Promise<CashOutAcrossRun | null> {
  return withRunLock(run.id, async () => {
    const fresh = await store.load(run.id);
    if (!fresh) return null;
    const stopped = cancelCashOutRest(fresh);
    if (stopped) await store.save(stopped);
    return stopped;
  });
}
