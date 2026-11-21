"use client";

/**
 * Claiming a Gloam name from the private balance, in the browser (lib/nameClaim has
 * the registrar and the escrow). The same steps as a private swap (lib/vaultSwapRun):
 *
 *   1. carve a GLOAM note of exactly what the claim needs (the price, plus the vault's
 *      cash-out fee), through the relay, if no note is already that amount;
 *   2. read the price again, make the refund note, work out this claim's escrow
 *      (derived from the note, the name, key, holder, years and the refund note),
 *      check it against the registrar's escrowFor, and prove the unshield to it;
 *   3. save the refund note before anything is sent, out of the balance until the
 *      sync settles it (it lands only if someone sent the unshield on its own);
 *   4. hand the proofs to the Gloam relay. No wallet ever submits or pays, so the
 *      explorer shows the vault paying the registry and nothing about who.
 */
import type { Address, Hex } from "viem";
import { buildPoseidonUnshieldWitness } from "./proverPoseidon";
import { fieldToBytes32, proveUnshieldInBrowser } from "./proveClient";
import { noteNullifierPoseidon } from "./notePoseidon";
import { fieldToHex, hexToField } from "./poseidon";
import { prepareBridgeNote } from "./bridgePrivate";
import { moveRevertedNotes } from "./claimSweep";
import { freshPath, spendPlanFor, spendWaitMessage, splitForCashOut } from "./cashOutSplit";
import { RelaySubmitError, relayNameClaim, waitForTx } from "./relay/client";
import { publicClientFor } from "./rhClient";
import { assertNoteOnNetwork, saveLocalNote, shieldPoolAbi, updateLocalNote, type LocalNote } from "./shield";
import { getNetwork } from "./networks";
import { GLOAM_TOKEN } from "./buybacks";
import { GLOAM_NAMES_ADDRESS, gloamNamesAbi } from "./gloamNames";
import {
  NAMES_REGISTRAR_ADDRESS,
  claimEscrowKey,
  nameClaimRefundAmount,
  nameEscrowAddress,
  namesRegistrarAbi,
  noteForPrice,
  type NameClaimClaim,
} from "./nameClaim";

const MAYBE_SENT = new Set(["maybe_sent", "rpc", "network", "error", "internal", "in_flight"]);

export const CLAIM_MAYBE_SENT = "The claim may have gone out. Your money is safe in the vault: refresh in a minute to see your name.";
export const CLAIM_REVERTED =
  "The claim didn't go through. Your money is safe in the vault and moves to a fresh private balance in about a minute. Then try again.";

/** The note a claim of `amount` spends: an exact match first, else the smallest that covers it. */
export function pickClaimNote(notes: readonly LocalNote[], amount: bigint): LocalNote | null {
  const exact = notes.find((n) => BigInt(n.amountWei) === amount);
  if (exact) return exact;
  const covering = notes.filter((n) => BigInt(n.amountWei) >= amount).sort((a, b) => (BigInt(a.amountWei) < BigInt(b.amountWei) ? -1 : 1));
  return covering[0] ?? null;
}

export async function runPrivateNameClaim(args: {
  /** The person's open GLOAM notes in the Robinhood Chain vault. */
  notes: readonly LocalNote[];
  claim: Omit<NameClaimClaim, "years"> & { years: number };
  /** The price shown, for these years. Read again before proving; a change stops the claim. */
  price: bigint;
  /** The vault's cash-out fee now. */
  feeBps: number;
  owner: Address;
  onStatus: (s: string) => void;
}): Promise<{ hash: Hex; refunded: boolean }> {
  const registrar = NAMES_REGISTRAR_ADDRESS;
  const names = GLOAM_NAMES_ADDRESS;
  if (!registrar || !names) throw new Error("Private name claims are not live yet.");
  const network = getNetwork("robinhood-mainnet");
  if (!network.pool) throw new Error("The Robinhood Chain vault isn't set up here.");
  const client = publicClientFor(network);
  const years = BigInt(args.claim.years);

  const amount = noteForPrice(args.price, args.feeBps);
  const note = pickClaimNote(args.notes, amount);
  if (!note) throw new Error("No single private $GLOAM balance covers this name yet. Add or swap into $GLOAM privately, then try again.");
  assertNoteOnNetwork(note, network);
  const moving = spendWaitMessage(note);
  if (moving) throw new Error(moving);

  // 1. A note of exactly what the claim needs (the rest stays a note of its own).
  let target = note;
  const plan = spendPlanFor(note, amount);
  if (plan !== "direct") {
    const start = await freshPath(note.commitment, network);
    if (!start) throw new Error("Could not read your private balance. Refresh and try again.");
    target = await splitForCashOut({
      note,
      amount,
      path: start.path,
      owner: args.owner,
      relayOn: true,
      allowWhole: plan === "move",
      sendWithWallet: () => Promise.reject(new Error("Private claims go through the Gloam relay.")),
      onStatus: args.onStatus,
    });
  }
  const targetWei = BigInt(target.amountWei);

  // 2. The price again: the claim pays exactly what the registry asks when it lands.
  args.onStatus("Proving privately, this takes 10 to 30 seconds…");
  const price = await client.readContract({ address: names, abi: gloamNamesAbi, functionName: "priceOf", args: [args.claim.name, years] });
  if (price !== args.price) throw new Error("The price of this name just changed. Check it and try again.");
  if (targetWei < noteForPrice(price, args.feeBps)) throw new Error("This balance no longer covers the name. Refresh and try again.");

  const back = await prepareBridgeNote(nameClaimRefundAmount(targetWei), GLOAM_TOKEN, network, args.owner);
  const nullifier =
    target.nullifier && target.nullifier !== "0x"
      ? target.nullifier
      : (fieldToHex(await noteNullifierPoseidon(hexToField(target.secret), hexToField(target.commitment))) as Hex);
  const claim: NameClaimClaim = { ...args.claim, years };
  const refund = { proof: back.proof, commitment: back.note.commitment, amount: BigInt(back.note.amountWei) };
  const key = claimEscrowKey({ proof: "0x", root: "0x", nullifier, amount: targetWei }, claim, refund);
  const escrow = nameEscrowAddress(registrar, key);
  const registrarSays = await client.readContract({
    address: registrar,
    abi: namesRegistrarAbi,
    functionName: "escrowFor",
    args: [{ ...key, years_: key.years }],
  });
  if (registrarSays.toLowerCase() !== escrow.toLowerCase()) {
    throw new Error("This claim's address didn't check out, so nothing was sent. Refresh and try again.");
  }
  const at = await freshPath(target.commitment, network);
  if (!at) throw new Error("Could not read your private balance. Refresh and try again.");
  const w = await buildPoseidonUnshieldWitness({ secretHex: target.secret, amount: targetWei, asset: target.asset, to: escrow, path: at.path });
  if (!w.checks.commitmentMatches) throw new Error(w.blocker ?? "This balance does not match the vault.");
  if (fieldToBytes32(w.publicInputs.nullifier).toLowerCase() !== nullifier.toLowerCase()) {
    throw new Error("This balance does not match the vault.");
  }
  const { proofBytes } = await proveUnshieldInBrowser(w.circomInput);

  // 3. The refund note on disk before anything is sent.
  const refundNote: LocalNote = { ...back.note, id: `nmr-${Date.now()}`, sweptFrom: { id: target.id, nullifier }, sweepPending: true };
  await saveLocalNote(refundNote);

  // 4. Through the relay only.
  args.onStatus(`Claiming @${args.claim.name} through the Gloam relay…`);
  let hash: Hex;
  try {
    hash = await relayNameClaim({
      chainId: network.chainId,
      registrar,
      spend: { proof: proofBytes, root: fieldToBytes32(w.publicInputs.root), nullifier, amount: targetWei },
      claim,
      refund,
    });
  } catch (e) {
    if (e instanceof RelaySubmitError && MAYBE_SENT.has(e.code)) throw new Error(CLAIM_MAYBE_SENT);
    throw e;
  }
  args.onStatus(`Saving @${args.claim.name} on Robinhood Chain…`);
  let outcome: "success" | "reverted";
  try {
    outcome = await waitForTx(hash, undefined, client);
  } catch {
    throw new Error(CLAIM_MAYBE_SENT);
  }
  if (outcome === "reverted") {
    // its unshield proof is public now and valid until the note moves: move it (lib/claimSweep)
    const spent = await client
      .readContract({ address: network.pool, abi: shieldPoolAbi, functionName: "isSpent", args: [nullifier] })
      .catch(() => null);
    if (spent !== true) {
      await updateLocalNote(target.id, { swapProofAt: Date.now() }).catch(() => {});
      void moveRevertedNotes().catch(() => {});
    }
    throw new Error(CLAIM_REVERTED);
  }

  // Landed: the name, or (if someone sent the unshield on its own first) the refund note.
  const refunded = await client
    .readContract({ address: network.pool, abi: shieldPoolAbi, functionName: "commitmentSeen", args: [refundNote.commitment] })
    .catch(() => false);
  updateLocalNote(target.id, { status: "recovered", txHash: hash });
  if (refunded) {
    const p = await freshPath(refundNote.commitment, network);
    updateLocalNote(refundNote.id, { status: "open", sweepPending: false, txHash: hash, ...(p ? { leafIndex: p.leafIndex } : {}) });
  } else {
    updateLocalNote(refundNote.id, { status: "recovered", sweepPending: false });
  }
  return { hash, refunded };
}
