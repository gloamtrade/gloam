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
 *      sync settles it (it lands only if someone sent the unshield on its own),
 *      with the claim it was made for (`nameClaim`), so a sync can send the claim
 *      again for the registrar's refunding branch (finishNameClaimRefund);
 *   4. hand the proofs to the Gloam relay. No wallet ever submits or pays, so the
 *      explorer shows the vault paying the registry and nothing about who.
 */
import type { Address, Hex } from "viem";
import { buildPoseidonUnshieldWitness } from "./proverPoseidon";
import { fieldToBytes32, proveShieldInBrowser, proveUnshieldInBrowser } from "./proveClient";
import { noteNullifierPoseidon } from "./notePoseidon";
import { fieldToHex, hexToField } from "./poseidon";
import { prepareBridgeNote } from "./bridgePrivate";
import { moveRevertedNotes } from "./claimSweep";
import { freshPath, networkOfNote, spendPlanFor, spendWaitMessage, splitForCashOut } from "./cashOutSplit";
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
  nameRefundClaim,
  namesRegistrarAbi,
  noteForPrice,
  type NameClaimClaim,
  type NameClaimRefundInfo,
} from "./nameClaim";

const MAYBE_SENT = new Set(["maybe_sent", "rpc", "network", "error", "internal", "in_flight"]);

/** How the claim ended isn't known here yet (the card then watches the registry for the name). */
export const CLAIM_MAYBE_SENT = "The claim may have gone out and may still land. Your money is safe in the vault either way.";
export const CLAIM_REVERTED =
  "The claim didn't go through. Your money is safe in the vault and moves to a fresh private balance in about a minute. Then try again.";
/** A claim that reverted with its note spent: the money waits at the claim's escrow and the sync puts it back. */
export const CLAIM_REFUNDING =
  "The claim didn't go through. Your money is on its way back to your private balance, less 1% in fees.";

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

  // 3. The refund note on disk before anything is sent, with what sending the claim again needs.
  const info: NameClaimRefundInfo = {
    registrar,
    amount: targetWei.toString(),
    name: claim.name,
    keyX: claim.keyX,
    keyY: claim.keyY,
    holder: claim.holder,
    years: years.toString(),
  };
  const refundNote: LocalNote = {
    ...back.note,
    id: `nmr-${Date.now()}`,
    sweptFrom: { id: target.id, nullifier },
    sweepPending: true,
    nameClaim: info,
  };
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
    // With no hash, a sync moves the note once it has sat unspent for an hour (lib/claimSweep markRevertedSwap).
    if (e instanceof RelaySubmitError && MAYBE_SENT.has(e.code)) throw new Error(CLAIM_MAYBE_SENT);
    throw e;
  }
  // Kept in case this tab never hears how it ended (it closes, the wait gives up):
  // a sync reads the receipt, and moves the note if the claim reverted.
  const sent = { hash, at: Date.now() };
  await updateLocalNote(refundNote.id, { nameClaim: { ...info, sent } }).catch(() => {});
  args.onStatus(`Saving @${args.claim.name} on Robinhood Chain…`);
  let outcome: "success" | "reverted";
  try {
    outcome = await waitForTx(hash, undefined, client);
  } catch {
    throw new Error(CLAIM_MAYBE_SENT);
  }
  if (outcome === "reverted") {
    const spent = await client
      .readContract({ address: network.pool, abi: shieldPoolAbi, functionName: "isSpent", args: [nullifier] })
      .catch(() => null);
    // spent some other way (its unshield, sent on its own): the sync puts it back as the refund note
    if (spent === true) throw new Error(CLAIM_REFUNDING);
    // its unshield proof is public now and valid until the note moves: move it (lib/claimSweep)
    await updateLocalNote(target.id, { swapProofAt: sent.at }).catch(() => {});
    void moveRevertedNotes().catch(() => {});
    throw new Error(CLAIM_REVERTED);
  }

  // Landed: the name, or (if someone sent the unshield on its own first) the refund note.
  const refunded = await client
    .readContract({ address: network.pool, abi: shieldPoolAbi, functionName: "commitmentSeen", args: [refundNote.commitment] })
    .catch(() => null);
  // either way the note is spent
  updateLocalNote(target.id, { status: "recovered", txHash: hash });
  // unread: the refund note stays pending until a sync sees which it was
  if (refunded === null) throw new Error(CLAIM_MAYBE_SENT);
  if (refunded) {
    const p = await freshPath(refundNote.commitment, network);
    updateLocalNote(refundNote.id, { status: "open", sweepPending: false, txHash: hash, ...(p ? { leafIndex: p.leafIndex } : {}) });
  } else {
    updateLocalNote(refundNote.id, { status: "recovered", sweepPending: false });
  }
  return { hash, refunded };
}

const UNUSED_PROOF = `0x${"00".repeat(64)}` as Hex;
const UNUSED_ROOT = `0x${"00".repeat(32)}` as Hex;
/** Between tries at finishing one refund. */
const RETRY_MS = 60_000;
/** Between tries while the vault won't take it. */
const BLOCKED_RETRY_MS = 10 * 60_000;
const lastTry = new Map<string, number>();

/**
 * Puts a name claim's waiting money back as its refund note: a sync found the claimed
 * note spent, by an unshield to the claim's escrow sent on its own, and the money
 * there (lib/claimSweep). The same claim, sent again, takes the registrar's refunding
 * branch: it opens the escrow and shields the refund note, the note less 1%. That
 * branch never reads the spend proof, so none is made; the refund's shield proof is
 * made again from the note's secret. True when one was sent. A refund the vault
 * refuses (a closed limit) throws the relay's error, for the sync to mark.
 */
export async function finishNameClaimRefund(note: LocalNote): Promise<boolean> {
  const info = note.nameClaim;
  const from = note.sweptFrom;
  if (!info || !from || !note.sweepPending) return false;
  const last = lastTry.get(note.id);
  if (last !== undefined && Date.now() - last < (note.refundHeld === "blocked" ? BLOCKED_RETRY_MS : RETRY_MS)) return false;
  lastTry.set(note.id, Date.now());

  const { proofBytes } = await proveShieldInBrowser({
    commitment: BigInt(note.commitment).toString(),
    amount: note.amountWei,
    asset: BigInt(note.asset).toString(),
    secret: BigInt(note.secret).toString(),
  });
  const hash = await relayNameClaim({
    chainId: note.chainId,
    registrar: info.registrar,
    spend: { proof: UNUSED_PROOF, root: UNUSED_ROOT, nullifier: from.nullifier, amount: BigInt(info.amount) },
    claim: nameRefundClaim(info),
    refund: { proof: proofBytes, commitment: note.commitment, amount: BigInt(note.amountWei) },
  });
  // the receipt is read on the note's own chain, whatever the page shows by now
  const net = networkOfNote(note);
  await waitForTx(hash, undefined, net ? publicClientFor(net) : undefined).catch(() => null);
  return true;
}
