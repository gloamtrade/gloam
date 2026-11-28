/**
 * Claiming a Solana claim link (lib/solanaRings/claimLink): the one-time
 * account the link opens moves everything it holds into the claimer's own
 * private balance. Pure rules, with the chain passed in (lib/solanaRings/client
 * wires the browser's), so scripts/selftest-solana-claim-links.mts runs them
 * against a fake ledger.
 *
 *  - Only the link can claim. The one-time account's key comes from the
 *    link's secret alone, on the claimer's device. The claim is a private
 *    transfer that account signs, paying the claimer's own shielded address,
 *    and the proof and the signature fix that destination: Gloam's relay only
 *    adds its signature as fee payer, and nobody who sees the transaction can
 *    send the money anywhere else.
 *  - Used once. Solana spends each note once (its nullifier). Two people
 *    claiming at once: the second claim can only fail, and is read back here
 *    as "used".
 *  - Take back is the same claim, by the sender into their own balance, and
 *    only works while nobody has claimed it.
 *  - Each move goes through the guarded send (lib/solanaRings/send): a relay
 *    answer lost after the send is settled on chain before anything else, so
 *    a claim that went through after all is reported as claimed, not as
 *    "someone else took it".
 */
import { LAST_PAYMENT_LANDED } from "./send";

/** What the one-time account holds, as a sync of it reads. */
export type ClaimHolding = {
  /** Notes it has ever held: 0 means nothing has arrived. */
  notes: number;
  /** What it holds unspent now, base units by asset id. */
  unspent: Readonly<Record<string, bigint>>;
};

/** "unused": money waits in it. "used": it held money and holds none now. "empty": nothing has arrived. */
export type LinkState = "unused" | "used" | "empty";

export function linkState(h: ClaimHolding): LinkState {
  if (Object.values(h.unspent).some((v) => v > 0n)) return "unused";
  return h.notes > 0 ? "used" : "empty";
}

export type ClaimDeps = {
  /** Sync the one-time account and say what it holds. */
  read(): Promise<ClaimHolding>;
  /** Move `amount` of `assetId` from it to the claimer, privately. Its signature. Throws when it doesn't go. */
  move(assetId: string, amount: bigint): Promise<string>;
};

export type Moved = { assetId: string; amount: bigint; signature: string };

export type ClaimResult = { state: "claimed"; moved: Moved[] } | { state: "used" } | { state: "empty" };

/** Said when the money has already left the link: claimed by someone, or by this person on another try. */
export const CLAIMED_ALREADY = "This link was already claimed.";
export const NOTHING_YET = "Nothing has arrived in this link yet. If it was just sent, check again in a minute.";

/**
 * Claim everything the one-time account holds. "used" when it held money and
 * holds none (claimed, or taken back), "empty" when nothing has arrived. A move
 * that fails is read back: when the money is gone from the account by then,
 * someone else's claim landed first.
 */
export async function claimAll(deps: ClaimDeps): Promise<ClaimResult> {
  const first = await deps.read();
  const state = linkState(first);
  if (state !== "unused") return { state };
  const moved: Moved[] = [];
  for (const [assetId, amount] of Object.entries(first.unspent)) {
    if (amount <= 0n) continue;
    try {
      moved.push({ assetId, amount, signature: await deps.move(assetId, amount) });
    } catch (e) {
      // An earlier claim of this one from this browser went through after all.
      if (e instanceof Error && e.message === LAST_PAYMENT_LANDED) {
        moved.push({ assetId, amount, signature: "" });
        continue;
      }
      let after: ClaimHolding | null = null;
      try {
        after = await deps.read();
      } catch {
        after = null;
      }
      // Gone by now, and not by this claim: someone else's landed first.
      if (after && after.notes > 0 && (after.unspent[assetId] ?? 0n) === 0n) {
        if (moved.length) continue;
        return { state: "used" };
      }
      throw e;
    }
  }
  return moved.length ? { state: "claimed", moved } : { state: "used" };
}

// ------------------------------------------------------------------ making one

export const LINK_NOT_KEPT = "This browser couldn't keep the link before paying it, so nothing was sent. Free some space and try again.";

export type NewLinkDeps = {
  /** Keep the link (sealed, under Sent links). Resolves once it reads back; throws when it can't be kept. */
  keep(): Promise<void>;
  /** Drop the kept link again. */
  forget(): Promise<void>;
  /** Pay the link's one-time account. `handed` is called each time the payment goes to the relay. */
  pay(handed: () => void): Promise<string>;
  /** Whether an error from `pay` says nothing can have moved (lib/solanaRings/client surelyNotSent). */
  surelyNotSent(e: unknown): boolean;
};

/**
 * Pay a new claim link so a lost link is never lost money, as on the other
 * chains: the link is kept before anything is sent (if it can't be, nothing
 * is), and dropped again only when the payment surely went nowhere (never
 * handed to the relay, or refused or dropped with nothing moved). A payment
 * that may have landed keeps its link: Sent links reads its account and says.
 */
export async function payNewLink(deps: NewLinkDeps): Promise<string> {
  try {
    await deps.keep();
  } catch {
    throw new Error(LINK_NOT_KEPT);
  }
  let handed = false;
  try {
    return await deps.pay(() => {
      handed = true;
    });
  } catch (e) {
    if (!handed || deps.surelyNotSent(e)) await deps.forget().catch(() => undefined);
    throw e;
  }
}
