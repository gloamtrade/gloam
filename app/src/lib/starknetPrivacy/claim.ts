/**
 * Claiming a Starknet claim link (lib/starknetPrivacy/claimLink): the link's
 * one-time account moves what it holds, less Gloam's fee for this move, into
 * the claimer's own private account. Pure rules with the chain passed in
 * (lib/starknetPrivacy/claimSession wires the page's), so
 * scripts/selftest-starknet-claim-links.mts runs them against a fake ledger.
 *
 *  - Only the link can claim: the one-time account's key comes from the link's
 *    secret alone, on the claimer's device, and the payment it proves names
 *    the claimer's account. Gloam's relay sends it and can't change where it goes.
 *  - Used once: the pool spends each note once (its nullifier). Two people
 *    claiming at once: the second can only fail, and reads back as used.
 *  - Take back is the same move, by the sender into their own account, while
 *    nobody has claimed it.
 *  - The fee for the move was paid into the link by the sender, so the claimer
 *    gets what was sent.
 */

/** What the one-time account holds now, as the page reads it. */
export type LinkHolding = {
  /** Its account is open on the pool (deployed and registered): false until the sender's link step ran. */
  open: boolean;
  /** Its private balance, base units. */
  balance: bigint;
};

export type ClaimDeps = {
  read(): Promise<LinkHolding>;
  /** Gloam's fee for the move now (0 when it asks none). */
  fee(): Promise<bigint>;
  /** Move `amount` from the link to the claimer, privately; its transaction. Throws when it doesn't go. */
  move(amount: bigint): Promise<string>;
};

export type ClaimResult =
  | { state: "claimed"; amount: bigint; txHash: string }
  /** Nothing in it: claimed already, taken back, or not paid yet. */
  | { state: "empty"; open: boolean }
  /** Less in it than the fee for moving it. */
  | { state: "too_small"; balance: bigint; fee: bigint };

export const LINK_EMPTY = "This link has nothing in it now. It was claimed or taken back, or the payment hasn't landed yet.";
export const LINK_NOT_READY = "Nothing has arrived in this link yet. If it was just sent, check again in a few minutes.";
export const LINK_GONE_AFTER = "This link is empty now. If you just claimed it, it's in your private balance.";
export const LINK_TOO_SMALL = "There is less in this link than Gloam's fee to move it.";

/** Say what a claim result means, for the page. */
export function claimMessage(r: ClaimResult): string | null {
  if (r.state === "empty") return r.open ? LINK_EMPTY : LINK_NOT_READY;
  if (r.state === "too_small") return LINK_TOO_SMALL;
  return null;
}

/**
 * Move everything the link holds, less the fee. A move that fails is read
 * back: when the link is empty by then, the money went (this claim's answer
 * was lost, or someone else's claim landed first), and that is said, never a
 * second move.
 */
export async function claimAll(deps: ClaimDeps): Promise<ClaimResult> {
  const h = await deps.read();
  if (!h.open || h.balance === 0n) return { state: "empty", open: h.open };
  const fee = await deps.fee();
  if (h.balance <= fee) return { state: "too_small", balance: h.balance, fee };
  const amount = h.balance - fee;
  try {
    return { state: "claimed", amount, txHash: await deps.move(amount) };
  } catch (e) {
    let after: LinkHolding | null = null;
    try {
      after = await deps.read();
    } catch {
      after = null;
    }
    if (after && after.open && after.balance === 0n) throw new Error(LINK_GONE_AFTER);
    throw e;
  }
}

/** Where a sent link stands from its holding: paid and waiting, or empty (used, or never paid). */
export function linkStanding(h: LinkHolding, everPaid: boolean): "waiting" | "used" | "not_paid" {
  if (h.open && h.balance > 0n) return "waiting";
  return everPaid ? "used" : "not_paid";
}
