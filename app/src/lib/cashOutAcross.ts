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
 *
 * Through the relay (Hide my wallet), where the network has Multicall3, the cash
 * outs go together in one transaction (deps.submitTogether, lib/relay/batch), all
 * or nothing: a set-aside step first if the last part needs one, then one send
 * for every part, so at most two relay transactions. Each part keeps its own
 * nullifier on record before that send, and is settled from the chain on its
 * own after it, exactly as when the parts go one by one. Refused with nothing
 * sent (an older relay, a batch too big for the network), the parts go one by
 * one. From the wallet they always go one by one.
 */
import type { Address, Hex } from "viem";
import type { CashOutCall } from "./cashOutProof";
import { BATCH_MIN_PARTS } from "./relay/batch";
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
  /** The chain's block just before it was sent, so its payout can be found in the vault's log later. */
  sentBlock?: string;
  /**
   * Notes set aside for this part whose transfer never went out. They stay
   * saved (the sync drops them once the note they came from is spent) and are
   * never cashed out.
   */
  staleSetAsides?: string[];
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
  /**
   * The vault's cash-out fee shown when it was confirmed, in basis points: the parts
   * go together only at that fee or lower (the relay checks). Unknown, they go one by one.
   */
  feeBps?: number;
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
  /** The cash-out fee on screen when it was confirmed, when it was read. */
  feeBps?: number | null;
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
    ...(typeof args.feeBps === "number" ? { feeBps: args.feeBps } : {}),
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
  /** The note an earlier split of `noteId` set aside for `amount`, if one was made (none of `skip`). */
  findSplitPart: (noteId: string, amount: bigint, skip: string[]) => LocalNote | undefined;
  /** Set `amount` of `note` aside in its own note (lib/cashOutSplit splitForCashOut), landed. */
  split: (note: LocalNote, amount: bigint) => Promise<LocalNote>;
  /** A cash out of all of `note` to `to`. */
  prove: (note: LocalNote, to: Address) => Promise<CashOutCall>;
  /** Hand one cash out to the relay or the wallet. */
  submit: (call: CashOutCall) => Promise<Hex>;
  /**
   * Every part's cash out in one transaction through the relay (lib/relay/batch), all or
   * nothing. Left out (the wallet sends, or the network has no Multicall3), each part goes
   * on its own through submit.
   */
  submitTogether?: (calls: CashOutCall[]) => Promise<Hex>;
  /**
   * A failed submitTogether that surely sent nothing, after which the parts may go one by
   * one (an older relay, a batch too big here). Not a fee that went up since it was shown.
   */
  togetherRefused?: (e: unknown) => boolean;
  /** A failed submit or submitTogether that may still have gone out. */
  maybeSent: (e: unknown) => boolean;
  waitForTx: (hash: Hex) => Promise<"success" | "reverted" | null>;
  isSpent: (nullifier: Hex) => Promise<boolean>;
  /** The chain's latest block, saved with each part as it goes out. */
  blockNumber?: () => Promise<bigint>;
  /**
   * The cash out that spent `nullifier`, from the vault's log from block `from`
   * on: where it went and how much (before the fee), or null when no cash out did.
   */
  payoutOf?: (nullifier: Hex, from: bigint) => Promise<{ to: Address; amount: bigint } | null>;
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
 * Who spent a part's note, once the chain shows it spent: this cash out
 * ("paid": the vault paid this part's amount to the run's wallet), something
 * else ("moved": another send or cash out of the same note), or "unknown" when
 * the vault's log can't be read now. The proof binds the wallet and the
 * amount, so a copy of this part's own send still counts as paid.
 */
async function spentBy(part: CashOutPart, to: Address, deps: CashOutAcrossDeps): Promise<"paid" | "moved" | "unknown"> {
  // a run saved before parts kept their block: counted as before
  if (!part.nullifier || !deps.payoutOf || part.sentBlock == null) return "paid";
  let from: bigint;
  try {
    from = BigInt(part.sentBlock);
  } catch {
    return "paid";
  }
  const out = await deps.payoutOf(part.nullifier, from).catch(() => undefined);
  if (out === undefined) return "unknown";
  return out && out.to.toLowerCase() === to.toLowerCase() && out.amount === BigInt(part.amount) ? "paid" : "moved";
}

/**
 * What became of a part handed out before: "paid" when this cash out spent
 * its note, "moved" when something else did, "unsent" when it surely didn't
 * land and its note is unspent (safe to send again: the vault refuses a spent
 * nullifier anyway), "waiting" otherwise.
 */
async function settleSent(part: CashOutPart, to: Address, deps: CashOutAcrossDeps, now: number): Promise<"paid" | "moved" | "unsent" | "waiting"> {
  if (!part.nullifier) return "unsent";
  if (part.txHash) {
    const outcome = await deps.waitForTx(part.txHash).catch(() => null);
    // this part's own send landed: its note is spent by it
    if (outcome === "success") return (await deps.isSpent(part.nullifier)) ? "paid" : "waiting";
    if (outcome === "reverted" && !(await deps.isSpent(part.nullifier))) return "unsent";
  }
  if (await deps.isSpent(part.nullifier)) {
    const by = await spentBy(part, to, deps);
    return by === "unknown" ? "waiting" : by;
  }
  return part.sentAt != null && now - part.sentAt > CASHOUT_RESEND_AFTER_MS ? "unsent" : "waiting";
}

/**
 * A note set aside for a part that is still landing: "waiting" while its
 * transfer may still go out or has gone out and the sync hasn't counted it
 * yet, "again" when the note it came from is still unspent long after (the
 * transfer never went out, so the part is set aside again from that same
 * note; only one of the two can ever land, since both spend it).
 */
async function setAsideState(note: LocalNote, deps: CashOutAcrossDeps, now: number): Promise<"waiting" | "again"> {
  const from = note.sweptFrom?.nullifier;
  if (!from) return "waiting";
  if (await deps.isSpent(from)) return "waiting";
  return now - (note.createdAt ?? now) > CASHOUT_RESEND_AFTER_MS ? "again" : "waiting";
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

    // Through the relay, every part's note is made ready first (1 and 2), then they are
    // proven and sent together (sendTogether); what that can't send goes one by one.
    const together: ReadyPart[] | null = r.relay && deps.submitTogether ? [] : null;
    for (const part of r.parts) {
      if (part.status === "paid" || part.status === "failed") continue;
      if (deps.shouldStop?.()) break;

      // 1. A part handed out before: the chain settles it first, so it never goes twice.
      if (part.status === "sent") {
        const settled = await settleSent(part, r.to, deps, now());
        if (settled === "paid") {
          part.status = "paid";
          delete part.error;
          if (part.targetNoteId && part.txHash) deps.markSpent(part.targetNoteId, part.txHash);
          await save();
          continue;
        }
        if (settled === "moved") {
          // spent, but not by this cash out: nothing of it reached the wallet
          part.status = "failed";
          part.error = CASHOUT_MOVED;
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
        target = deps.findSplitPart(part.noteId, BigInt(part.amount), part.staleSetAsides ?? []);
        if (target) {
          part.targetNoteId = target.id;
          await save();
        }
      }
      if (!part.whole && target?.sweepPending) {
        // set aside before, still landing: wait for the sync, unless that transfer surely never went out
        if ((await setAsideState(target, deps, now())) === "waiting") {
          part.error = CASHOUT_WAITING;
          await save();
          return r;
        }
        part.staleSetAsides = [...(part.staleSetAsides ?? []), target.id];
        delete part.targetNoteId;
        target = undefined;
        await save();
      }
      if (!part.whole && !target) {
        const from = deps.getNote(part.noteId);
        if (!from || from.status !== "open") {
          part.status = "failed";
          part.error = CASHOUT_MOVED;
          await save();
          continue;
        }
        target = await deps.split(from, BigInt(part.amount));
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

      // 3. Prove, save the nullifier, then send: now, or with the other parts in one transaction.
      if (together) {
        together.push({ part, target });
        continue;
      }
      if ((await sendOne(r, part, target, deps, save, now)) === "held") return r;
    }

    // Every part's note is ready: they go together, and what can't go that way goes one by one.
    if (together?.length && !deps.shouldStop?.()) {
      const left = await sendTogether(r, together, deps, save, now);
      if (left === "held") return r;
      for (const one of left) {
        if (deps.shouldStop?.()) break;
        if ((await sendOne(r, one.part, one.target, deps, save, now, one.call)) === "held") return r;
      }
    }

    if (r.parts.every((p) => p.status === "paid" || p.status === "failed")) {
      r.status = "done";
      await save();
    }
    return r;
  });
}

/** A part whose note is ready to cash out, and its proof once made. */
type ReadyPart = { part: CashOutPart; target: LocalNote; call?: CashOutCall };

/**
 * A part's note found spent before it was sent: paid by an earlier send of this same
 * part that landed late, or moved (another tab or device). "held" when the vault's log
 * can't say which yet. Saved either way.
 */
async function spentBeforeSend(r: CashOutAcrossRun, part: CashOutPart, call: CashOutCall, deps: CashOutAcrossDeps, save: () => Promise<void>): Promise<"next" | "held"> {
  const by = part.nullifier === call.nullifier ? await spentBy(part, r.to, deps) : "moved";
  if (by === "unknown") {
    part.error = CASHOUT_WAITING;
    await save();
    return "held";
  }
  part.status = by === "paid" ? "paid" : "failed";
  if (by === "paid") delete part.error;
  else part.error = CASHOUT_MOVED;
  await save();
  return "next";
}

/**
 * 3. One part on its own: prove it (or take the proof made to send it with the others),
 * save its nullifier and the chain's block, then send it and settle it. "held" when the
 * run stops here for the chain or the person to settle it; throws when the send surely
 * didn't go out (the part waits for the next try).
 */
async function sendOne(
  r: CashOutAcrossRun,
  part: CashOutPart,
  target: LocalNote,
  deps: CashOutAcrossDeps,
  save: () => Promise<void>,
  now: () => number,
  proven?: CashOutCall
): Promise<"next" | "held"> {
  const call = proven ?? (await deps.prove(target, r.to));
  if (call.to.toLowerCase() !== r.to.toLowerCase() || call.amount !== BigInt(part.amount)) {
    throw new Error("The cash out didn't match what was set up, so nothing was sent.");
  }
  // spent before this send: by an earlier send of this part that landed late, or elsewhere
  // (another tab or device)
  if (await deps.isSpent(call.nullifier)) return spentBeforeSend(r, part, call, deps, save);
  const block = deps.blockNumber ? await deps.blockNumber().catch(() => null) : null;
  part.nullifier = call.nullifier;
  part.targetNoteId = target.id;
  part.status = "sent";
  part.sentAt = now();
  if (block != null) part.sentBlock = block.toString();
  else delete part.sentBlock;
  delete part.error;
  await save();

  let hash: Hex;
  try {
    hash = await deps.submit(call);
  } catch (e) {
    if (deps.maybeSent(e)) {
      part.error = CASHOUT_MAYBE_SENT;
      await save();
      return "held";
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
    return "next";
  }
  if (outcome === "reverted" && !(await deps.isSpent(call.nullifier))) {
    part.status = "ready";
    delete part.sentAt;
    part.error = "This part didn't go through on this try. Resume to try it again.";
    await save();
    return "held";
  }
  if (outcome === "reverted") {
    // reverted, yet the note is spent: an earlier send of it landed, or something else spent it
    const by = await spentBy(part, r.to, deps);
    if (by === "unknown") {
      part.error = CASHOUT_WAITING;
      await save();
      return "held";
    }
    if (by === "moved") {
      part.status = "failed";
      part.error = CASHOUT_MOVED;
      await save();
      return "next";
    }
    part.status = "paid";
    deps.markSpent(target.id, hash);
    await save();
    return "next";
  }
  part.error = CASHOUT_WAITING;
  await save();
  return "held";
}

/**
 * Every ready part in one transaction (deps.submitTogether). Each part is proven and
 * checked as sendOne checks it, and every part's nullifier, marked sent, and the chain's
 * block are saved before the one send goes. Then:
 *  - landed: every part's own cash out ran in it (all or nothing), so each is paid
 *  - refused with nothing sent (deps.togetherRefused): back to ready, and returned to go
 *    one by one with the proofs already made
 *  - reverted: nothing in it landed; a part whose note is unspent goes again on its own,
 *    proven afresh; one whose note is spent is settled as sendOne settles it (spentBy:
 *    paid by an earlier send of it, or moved by something else)
 *  - may have gone out, or no answer: "held", every part kept as sent until the chain
 *    settles it (runCashOutAcross step 1, settleSent, part by part, never sent twice)
 *  - any other refusal (a fee that went up, a rate limit): back to ready, and thrown
 * Fewer than two parts left to send come back to go one by one.
 */
async function sendTogether(
  r: CashOutAcrossRun,
  ready: ReadyPart[],
  deps: CashOutAcrossDeps,
  save: () => Promise<void>,
  now: () => number
): Promise<ReadyPart[] | "held"> {
  if (ready.length < BATCH_MIN_PARTS || !deps.submitTogether) return ready;
  const going: Required<ReadyPart>[] = [];
  for (const one of ready) {
    if (deps.shouldStop?.()) return "held";
    const call = await deps.prove(one.target, r.to);
    if (call.to.toLowerCase() !== r.to.toLowerCase() || call.amount !== BigInt(one.part.amount)) {
      throw new Error("The cash out didn't match what was set up, so nothing was sent.");
    }
    if (await deps.isSpent(call.nullifier)) {
      if ((await spentBeforeSend(r, one.part, call, deps, save)) === "held") return "held";
      continue;
    }
    going.push({ ...one, call });
  }
  if (going.length < BATCH_MIN_PARTS) return going;
  if (deps.shouldStop?.()) return "held";

  // every part's nullifier and the chain's block on record before the one send
  const block = deps.blockNumber ? await deps.blockNumber().catch(() => null) : null;
  const sentAt = now();
  for (const g of going) {
    g.part.nullifier = g.call.nullifier;
    g.part.targetNoteId = g.target.id;
    g.part.status = "sent";
    g.part.sentAt = sentAt;
    if (block != null) g.part.sentBlock = block.toString();
    else delete g.part.sentBlock;
    delete g.part.txHash;
    delete g.part.error;
  }
  await save();

  let hash: Hex;
  try {
    hash = await deps.submitTogether(going.map((g) => g.call));
  } catch (e) {
    if (deps.maybeSent(e)) {
      for (const g of going) g.part.error = CASHOUT_MAYBE_SENT;
      await save();
      return "held";
    }
    // surely not sent: every part waits for its next try
    for (const g of going) {
      g.part.status = "ready";
      delete g.part.sentAt;
    }
    if (deps.togetherRefused?.(e)) {
      await save();
      return going;
    }
    for (const g of going) g.part.error = e instanceof Error ? e.message : "The cash out didn't go through.";
    await save();
    throw e;
  }
  for (const g of going) g.part.txHash = hash;
  await save();

  const outcome = await deps.waitForTx(hash).catch(() => null);
  if (outcome === "success") {
    // allowFailure false: the transaction succeeded only if every part's cash out did
    for (const g of going) {
      g.part.status = "paid";
      deps.markSpent(g.target.id, hash);
    }
    await save();
    return [];
  }
  if (outcome !== "reverted") {
    for (const g of going) g.part.error = CASHOUT_WAITING;
    await save();
    return "held";
  }
  // reverted: none of it landed
  const again: ReadyPart[] = [];
  let held = false;
  for (const g of going) {
    if (!(await deps.isSpent(g.call.nullifier))) {
      g.part.status = "ready";
      delete g.part.sentAt;
      delete g.part.txHash;
      again.push({ part: g.part, target: g.target });
      continue;
    }
    // spent all the same: an earlier send of it landed, or something else spent it
    const by = await spentBy(g.part, r.to, deps);
    if (by === "unknown") {
      g.part.error = CASHOUT_WAITING;
      held = true;
    } else if (by === "moved") {
      g.part.status = "failed";
      g.part.error = CASHOUT_MOVED;
    } else {
      g.part.status = "paid";
      deps.markSpent(g.target.id, hash);
    }
  }
  await save();
  return held ? "held" : again;
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
