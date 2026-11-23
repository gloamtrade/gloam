/*
 * The balance a payment or cash out is spending, kept on screen until its result closes.
 *
 * Mid-flow the list of open balances can drop that balance before the result shows: the
 * payment lands and its note is marked spent while the change is still waiting on the tree,
 * the heads-up is still going out, a split leaves only pieces that wait to land, or a sync
 * marks it spent. A view that picks from the live list alone then has nothing to show and
 * falls back to "Nothing in your private balance yet" mid-payment. Views hold the balance
 * here instead. Rendering only: nothing about the notes themselves changes.
 */

type Identified = { id: string };

/**
 * The balance to show for a flow in progress: the live copy while the list still has it,
 * else the one the flow started from. None once the flow is over.
 */
export function heldBalance<T extends Identified>(open: readonly T[], held: T | null, inFlow: boolean): T | null {
  if (!inFlow || !held) return null;
  return open.find((n) => n.id === held.id) ?? held;
}

/** What a balance picker lists: the open balances, and the held one first if the list has dropped it. */
export function withHeld<T extends Identified>(open: readonly T[], held: T | null): T[] {
  return held && !open.some((n) => n.id === held.id) ? [held, ...open] : [...open];
}

/** The Pay card: the form (with the balance it spends), or the empty state when nothing is open and no flow holds one. */
export function payCardShows(openCount: number, held: Identified | null): "form" | "empty" {
  return openCount > 0 || held ? "form" : "empty";
}
