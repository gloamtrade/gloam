"use client";

/**
 * "Cash out privately": one cash out made into a few pieces (lib/cashOutPlan
 * picks them), each handed to the relay through "cash out later", so each goes
 * out at its own random time inside the window the person picked.
 *
 * No new money logic: each piece is split off with lib/cashOutSplit (a private
 * transfer to the person's own two new notes, both saved before it is sent),
 * proven like any cash out (lib/cashOutProof), and scheduled with
 * lib/cashOutLater. One piece at a time, in order: split it off, prove it,
 * schedule it, then the next one from the change. Everything goes through the
 * relay, so the wallet never shows.
 *
 * Every piece is tagged (LocalNote.cashOutPlan) when it is split off, before
 * anything is sent. So whatever stops a run (a refused split, a relay that is
 * down, a closed tab), nothing is lost and nothing is hidden:
 *  - pieces already scheduled go out as planned, and each can be cancelled;
 *  - a piece split off but not scheduled stays in the private balance and
 *    shows as one (unscheduledPieces), to schedule again or keep;
 *  - the rest of the money stays in the private balance as one note;
 *  - a split that may have gone out keeps both its notes, out of the balance
 *    until the next sync settles them (lib/claimSweep), like any split.
 * A run stops at the first problem. It never guesses past one.
 *
 * A proof stays valid until its note is spent, so a piece whose proof reached the
 * relay and did not go out moves to a fresh note before it can be spent, however
 * that came about (shield proofLoose): it is not one to schedule again.
 *
 * A prepaid agent top-up (lib/agentTopUp) is the same run with more pieces,
 * each sent on a day of its own instead of inside a window.
 */
import type { Address, Hex } from "viem";
import { moveRevertedNotes, type ClaimEnv } from "./claimSweep";
import { readDemo } from "./demoFlag";
import { cashOutPending, endedPlan, markCleared, notesToMove, proofLoose, updateLocalNote, type CashOutPlanTag, type LocalNote } from "./shield";
import { getAllNotes } from "./noteVault";
import type { PoseidonMerklePath } from "./merklePoseidon";
import { proveCashOut, type CashOutCall } from "./cashOutProof";
import { freshPath, networkOfNote, SPLIT_MAYBE_SENT, spendWaitMessage, splitNote, type SplitArgs } from "./cashOutSplit";
import { scheduleNoteCashOut, type CashOutWhen, type CashOutWindow, type OwnedCashOutJob } from "./cashOutLater";
import { MAX_PIECES, MIN_PIECES } from "./cashOutPlan";
import { nextSendDay } from "./relay/scheduled";

export type PieceState = "waiting" | "splitting" | "proving" | "scheduling" | "scheduled" | "stopped";

export type PieceProgress = { amount: bigint; to: Address; state: PieceState; at?: number };

/** What a run uses to move money: the app's own paths, swapped for fakes in the selftest. */
export type PrivateCashOutDeps = {
  /** A note's path in the vault tree, read fresh from the chain. */
  pathOf: (n: LocalNote) => Promise<PoseidonMerklePath | null>;
  split: (a: SplitArgs) => Promise<{ part: LocalNote; change: LocalNote | null }>;
  prove: (n: LocalNote, to: Address, path: PoseidonMerklePath, chainId: number) => Promise<CashOutCall>;
  schedule: (n: LocalNote, call: CashOutCall, when: CashOutWhen, feeBps?: number) => Promise<OwnedCashOutJob>;
  newId: () => string;
};

const appDeps: PrivateCashOutDeps = {
  // the piece's own network, even if the page switched while the run goes on
  pathOf: async (n) => {
    const net = networkOfNote(n);
    return net ? ((await freshPath(n.commitment, net))?.path ?? null) : null;
  },
  split: splitNote,
  prove: proveCashOut,
  schedule: scheduleNoteCashOut,
  newId: () => crypto.randomUUID(),
};

export type PrivateCashOutResult = {
  /** The jobs the relay holds, in piece order. */
  jobs: OwnedCashOutJob[];
  /** null when every piece is scheduled; else the piece (from 0) the run stopped at. */
  stoppedAt: number | null;
  /** What stopped it, in plain words. */
  error: string | null;
  /** The split that stopped it may have gone out: its notes settle on the next sync. */
  maybeSent: boolean;
};

const NO_PATH = "Could not read your private balance. Refresh and try again.";

/** The relay sends every step of a private cash out; the wallet is never asked. */
function noWallet(): Promise<Hex> {
  return Promise.reject(new Error("A private cash out goes through the Gloam relay."));
}

function lowerFirst(s: string): string {
  return s ? s[0]!.toLowerCase() + s.slice(1) : s;
}

/**
 * Checks a plan against its note before anything moves: 2 to 4 pieces (`most`
 * for a top-up), each with an address, adding up to at most the note. Throws
 * in plain words.
 */
export function checkPlan(note: LocalNote, pieces: bigint[], to: Address[], most = MAX_PIECES, least = MIN_PIECES): void {
  if (pieces.length < least || pieces.length > most) throw new Error(`A private cash out has ${least} to ${most} pieces.`);
  if (to.length !== pieces.length) throw new Error("Each piece needs an address.");
  if (pieces.some((p) => p <= 0n)) throw new Error("Each piece needs an amount.");
  const total = pieces.reduce((s, p) => s + p, 0n);
  if (total > BigInt(note.amountWei)) throw new Error("The pieces add up to more than this balance.");
  if (note.status === "recovered" || note.sweepPending || cashOutPending(note) || proofLoose(note)) {
    throw new Error("This balance is busy. Refresh and try again.");
  }
  const moving = spendWaitMessage(note);
  if (moving) throw new Error(moving);
}

/** A run of prepaid top-ups: which slots of the series it sets up, and the series they belong to. */
export type TopUpRun = {
  /** The series' id, when this finishes one that stopped part way. */
  plan?: string;
  /** Each piece's place in the series, from 1, and its UTC day. */
  slots: { piece: number; day: number }[];
  /** How many top-ups the series has. */
  of: number;
  everyDays: number;
  /** The most pieces one run may take. */
  most: number;
  /** Where the relay says this series failed or is held. */
  webhook?: string;
};

/**
 * Runs a private cash out of `pieces` (base units, adding up to at most the
 * note) to `to` (one address per piece), each scheduled inside `window`, or on
 * its own day with `topUp`. Resolves with what was scheduled and, when it
 * stopped early, where and why; it throws only when the plan is refused before
 * anything moved.
 */
export async function runPrivateCashOut(args: {
  note: LocalNote;
  pieces: bigint[];
  to: Address[];
  window: CashOutWindow;
  owner: Address;
  topUp?: TopUpRun;
  /** The fee the screen showed, kept on each job: the vault takes the rate of the day it lands. */
  feeBps?: number;
  /** The fewest pieces this run takes: 2 unless the caller means less, like funding a wallet that needs no gas. */
  least?: number;
  onStatus?: (s: string) => void;
  onPiece?: (i: number, p: Partial<PieceProgress>) => void;
  deps?: Partial<PrivateCashOutDeps>;
}): Promise<PrivateCashOutResult> {
  const { note, pieces, to, window, owner, topUp } = args;
  // one left to finish a series is a run of one: there is no smaller top-up run
  checkPlan(note, pieces, to, topUp?.most, args.least ?? (topUp ? 1 : undefined));
  const d: PrivateCashOutDeps = { ...appDeps, ...args.deps };
  const status = args.onStatus ?? (() => {});
  const piece = args.onPiece ?? (() => {});
  const n = pieces.length;
  const whole = pieces.reduce((s, p) => s + p, 0n) === BigInt(note.amountWei);
  const plan = topUp?.plan ?? d.newId();
  const tagOf = (i: number): CashOutPlanTag => ({
    plan,
    piece: topUp?.slots[i]!.piece ?? i + 1,
    of: topUp?.of ?? n,
    to: to[i]!,
    window,
    ...(topUp ? { topUp: { day: topUp.slots[i]!.day, everyDays: topUp.everyDays, ...(topUp.webhook ? { webhook: topUp.webhook } : {}) } } : {}),
  });
  const whenOf = (i: number): CashOutWhen => (topUp ? { day: topUp.slots[i]!.day, webhook: topUp.webhook } : window);
  const jobs: OwnedCashOutJob[] = [];
  const stop = (i: number, e: unknown): PrivateCashOutResult => {
    piece(i, { state: "stopped" });
    const error = e instanceof Error && e.message ? e.message : "Something went wrong.";
    return { jobs, stoppedAt: i, error, maybeSent: error === SPLIT_MAYBE_SENT };
  };

  let rest: LocalNote = note;
  for (let i = 0; i < n; i++) {
    const label = topUp ? `Top-up ${tagOf(i).piece} of ${topUp.of}` : `Piece ${i + 1} of ${n}`;
    let target: LocalNote;
    try {
      if (i > 0 && BigInt(rest.amountWei) === pieces[i]) {
        // The last piece of a plan for the whole note: the change of the split
        // before, tagged as this piece when it was made.
        target = rest;
      } else {
        piece(i, { state: "splitting" });
        status(`${label}: setting it aside…`);
        const path = await d.pathOf(rest);
        if (!path) throw new Error(NO_PATH);
        const { part, change } = await d.split({
          note: rest,
          amount: pieces[i]!,
          path,
          owner,
          relayOn: true,
          sendWithWallet: noWallet,
          onStatus: (s) => status(`${label}: ${lowerFirst(s)}`),
          partTag: tagOf(i),
          // finishing a series with its one last top-up from a note of just that size: a fresh, tagged note all the same
          allowWhole: BigInt(rest.amountWei) === pieces[i],
          // when the pieces are the whole note, the change of the second-last split is the last piece
          changeTag: whole && i === n - 2 ? tagOf(n - 1) : undefined,
        });
        // Every split but one for the whole note leaves change; without it there is nothing left to split.
        if (!change && i < n - 1) throw new Error("The rest of this cash out could not be set aside. It is in your private balance.");
        target = part;
        if (change) rest = change;
      }
    } catch (e) {
      return stop(i, e);
    }
    try {
      piece(i, { state: "proving" });
      status(`${label}: proving privately…`);
      const path = await d.pathOf(target);
      if (!path) throw new Error(NO_PATH);
      const call = await d.prove(target, to[i]!, path, target.chainId);
      piece(i, { state: "scheduling" });
      status(`${label}: scheduling with the Gloam relay…`);
      const job = await d.schedule(target, call, whenOf(i), args.feeBps);
      jobs.push(job);
      piece(i, { state: "scheduled", at: job.sendAfter });
    } catch (e) {
      return stop(i, e);
    }
  }
  return { jobs, stoppedAt: null, error: null, maybeSent: false };
}

/**
 * Pieces of a private cash out that are in the private balance but not
 * scheduled: split off, then stopped (a relay that was down, a closed tab). A
 * piece whose cash out came back shows that notice instead, and one still
 * landing shows once the sync settles it. A top-up whose proof already left is
 * not one of these: it moves to a fresh note instead (shield proofLoose).
 */
export function unscheduledPieces(notes: LocalNote[] = getAllNotes()): LocalNote[] {
  return notes.filter(
    (n) => n.cashOutPlan && !n.cashOutPlan.topUp?.ended && n.status !== "recovered" && !n.sweepPending && !n.cashOut && !n.proofOutAt
  );
}

function planOf(noteId: string): CashOutPlanTag | undefined {
  return getAllNotes().find((n) => n.id === noteId)?.cashOutPlan;
}

/** Keeps a piece as plain money in the balance: it no longer shows as a piece to schedule. */
export function keepPiece(noteId: string) {
  updateLocalNote(noteId, { cashOutPlan: endedPlan(planOf(noteId), "kept") });
}

/** A cancelled cash out: plain money, not a piece still to schedule, once it has moved to a fresh note. Settles once that is on disk. */
export function cancelledPiece(noteId: string): Promise<void> {
  const n = getAllNotes().find((x) => x.id === noteId);
  return n ? updateLocalNote(noteId, { ...markCleared(n), cashOutPlan: endedPlan(n.cashOutPlan, "cancelled") }) : Promise.resolve();
}

let demoMoving = false;

/** The recording demo has no tree to prove a move against: the app's own whole-note split, on the pretend relay. */
async function demoMoveNotes(): Promise<void> {
  if (demoMoving) return;
  demoMoving = true;
  try {
    for (const n of notesToMove(getAllNotes())) {
      const at = await freshPath(n.commitment).catch(() => null);
      if (!at) continue;
      await splitNote({
        note: n,
        amount: BigInt(n.amountWei),
        allowWhole: true,
        path: at.path,
        owner: n.from as Address,
        relayOn: true,
        sendWithWallet: noWallet,
        onStatus: () => {},
      }).catch(() => {});
    }
  } finally {
    demoMoving = false;
  }
}

/** Starts moving every note whose proof is still out, so a cancel takes effect now, not at the next sync. */
export function moveLooseProofs(env?: ClaimEnv): Promise<void> {
  return readDemo() ? demoMoveNotes() : moveRevertedNotes(env);
}

// ---------------------------------------------------------------- the person's choice

const PREF_KEY = "gloam.cashout.private";

export type PrivateCashOutPref = {
  /** Cash out privately when it is offered, or all at once (the default: most people want it now). */
  on: boolean;
  window: CashOutWindow;
};

const WINDOWS: readonly CashOutWindow[] = ["hour", "6h", "day"];

/** What this browser last chose: all at once unless the person turned on privately (over about 6 hours). */
export function readPrivatePref(): PrivateCashOutPref {
  const fallback: PrivateCashOutPref = { on: false, window: "6h" };
  if (typeof window === "undefined") return fallback;
  try {
    const raw = JSON.parse(window.localStorage.getItem(PREF_KEY) ?? "null") as Partial<PrivateCashOutPref> | null;
    return {
      on: typeof raw?.on === "boolean" ? raw.on : fallback.on,
      window: raw?.window && WINDOWS.includes(raw.window) ? raw.window : fallback.window,
    };
  } catch {
    return fallback;
  }
}

export function savePrivatePref(patch: Partial<PrivateCashOutPref>) {
  try {
    window.localStorage.setItem(PREF_KEY, JSON.stringify({ ...readPrivatePref(), ...patch }));
  } catch {
    /* a private window: the choice lasts this visit */
  }
}

/**
 * Schedules a piece that was split off but not scheduled, as it was planned:
 * the same address and window, or for a top-up its day (the next one if that
 * has passed). The caller checks the address first, as for any cash out.
 */
export async function schedulePiece(note: LocalNote, deps: Partial<PrivateCashOutDeps> = {}, feeBps?: number): Promise<OwnedCashOutJob> {
  const tag = note.cashOutPlan;
  if (!tag) throw new Error("This is not a piece of a private cash out.");
  const d: PrivateCashOutDeps = { ...appDeps, ...deps };
  const path = await d.pathOf(note);
  if (!path) throw new Error(NO_PATH);
  const call = await d.prove(note, tag.to, path, note.chainId);
  return d.schedule(note, call, tag.topUp ? { day: nextSendDay(tag.topUp.day, Date.now()), webhook: tag.topUp.webhook } : tag.window, feeBps);
}
