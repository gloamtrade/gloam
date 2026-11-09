"use client";

/**
 * Running a private swap from the browser (lib/vaultSwap has the router and
 * quotes). A swap spends one whole note, so part of a note is first set aside
 * in its own note (lib/cashOutSplit, the same as a partial cash out). Then:
 *
 *   1. make a refund note in the note's own asset, price the swap again (a
 *      quote seen a minute ago may now give less than the market does; the
 *      better of the two is used, lib/vaultSwap replanVaultSwap), then make
 *      the new note for exactly the planned amount, and prove both shields;
 *   2. work out this swap's escrow (derived from the note spent, both new notes
 *      and the route), check it against the router's escrowFor, and prove the
 *      note's unshield to it, so nobody can change what lands;
 *   3. save both new notes before anything is sent, out of the balance until
 *      one lands (sweepPending, named after the note they come from: the sync
 *      that counts one retires that note and the other, lib/claimSweep);
 *   4. hand the proofs to the Gloam relay. The wallet never submits a swap:
 *      that would put it next to the swap on the explorer.
 *
 * The new notes stay saved however the send ends, even when the relay refused it,
 * as the unshield proof stays valid until the note is spent: its refund note and
 * exit key are the way back if that proof ever lands. The next sync settles them,
 * and a note that never moved gets moved after SWAP_UNSEEN_MS, which ends the proof.
 * A swap that landed and reverted is the same, but its proof is public, so that
 * note is marked (swapProofAt) and moved to a fresh note right away, and the
 * sync keeps trying if that try fails (lib/claimSweep moveRevertedNotes). A swap
 * with no saved hash that shows nothing for an hour goes the same way
 * (SWAP_UNSEEN_MS).
 */
import { keccak256, type Address, type Hex } from "viem";
import { buildPoseidonUnshieldWitness } from "./proverPoseidon";
import { fieldToBytes32, proveShieldInBrowser, proveUnshieldInBrowser } from "./proveClient";
import { noteNullifierPoseidon } from "./notePoseidon";
import { fieldToHex, hexToField } from "./poseidon";
import type { PoseidonMerklePath } from "./merklePoseidon";
import { prepareBridgeNote } from "./bridgePrivate";
import { moveRevertedNotes } from "./claimSweep";
import { freshPath, networkOfNote, spendPlanFor, spendWaitMessage, splitForCashOut } from "./cashOutSplit";
import { relayVaultSwap, relayVaultSwapExit, RelaySubmitError, waitForTx } from "./relay/client";
import { publicClientFor } from "./rhClient";
import { assertNoteOnNetwork, saveLocalNote, shieldPoolAbi, updateLocalNote, type LocalNote } from "./shield";
import { walkLogs, walkTuning } from "./leafIndex";
import type { GloamNetwork } from "./networks";
import {
  UNSHIELDED_EVENT,
  encodeRoute,
  escrowAddress,
  exitAccount,
  exitDigest,
  refundAmountFor,
  refundEscrowKey,
  replanVaultSwap,
  swapDeadlineSeconds,
  swapRouterFor,
  vaultSwapAbi,
  vaultSwapV3Abi,
  type EscrowKey,
  type SwapPlan,
  type VaultSwapRefundInfo,
} from "./vaultSwap";

/** Relay codes after which the swap may still have gone out. */
const MAYBE_SENT = new Set(["maybe_sent", "rpc", "network", "error", "internal", "in_flight"]);

export const SWAP_MAYBE_SENT =
  "The swap may have gone out. Your money is safe in the vault: refresh in a minute to see where it landed.";

export const SWAP_REVERTED =
  "The swap didn't go through on this try. Your money is safe in the vault. It moves to a fresh private balance in about a minute: keep Gloam open, or it finishes next time you open the app. Then get a new quote.";

export const SWAP_SPENT =
  "This try didn't go through, but another copy of the swap already spent this balance. Refresh in a minute to see where your money landed.";

export const SWAP_REFUNDED =
  "The swap couldn't finish, so the money went back to your private balance, less up to 1%: the vault's cash-out fee, plus a safety margin that goes to the Gloam treasury.";

export type SwapResult = { hash: Hex; outNote: LocalNote; refunded: boolean };

/** What sendVaultSwap calls: the app's own below, a test's own in scripts/. */
export type SwapSender = {
  relay: typeof relayVaultSwap;
  /** How the transaction ended. Throws when that can't be told yet (a slow network). */
  wait: (hash: Hex) => Promise<"success" | "reverted">;
  isSpent: (nullifier: Hex) => Promise<boolean>;
  /** Starts moving a note whose swap just reverted, without waiting for the move. */
  moveNote: () => void;
};

/**
 * Hands a swap to the relay and follows it to the chain. Returns its hash once
 * it landed without reverting; throws in plain words otherwise. `spentId` is the
 * note the swap spends, and `outId` and `refund` the two saved for it.
 */
export async function sendVaultSwap(
  call: Parameters<typeof relayVaultSwap>[0],
  notes: { spentId: string; outId: string; refund: LocalNote },
  send: SwapSender,
  onSent?: () => void
): Promise<Hex> {
  let hash: Hex;
  try {
    hash = await send.relay(call);
  } catch (e) {
    if (e instanceof RelaySubmitError && MAYBE_SENT.has(e.code)) throw new Error(SWAP_MAYBE_SENT);
    // Refused, but the relay has seen the proofs, and they stay valid until the note
    // moves: both notes stay saved, out of the balance, until the sync settles them.
    throw e;
  }
  // Kept in case this tab never hears how it ended (it closes, the wait gives
  // up): a sync reads the receipt. The swap is out, so a failed save stops nothing.
  const sent = { hash, at: Date.now() };
  await updateLocalNote(notes.refund.id, { vaultSwap: { ...notes.refund.vaultSwap!, sent } }).catch(() => {});

  onSent?.();
  let outcome: "success" | "reverted";
  try {
    outcome = await send.wait(hash);
  } catch {
    // A slow network: it may still land, and the next sync settles it.
    throw new Error(SWAP_MAYBE_SENT);
  }
  if (outcome === "reverted") {
    // Not proof that nothing moved: a copy or a resend of this call may have
    // landed first. Both notes stay saved, out of the balance; the sync settles them.
    if ((await send.isSpent(call.spend.nullifier).catch(() => null)) === true) throw new Error(SWAP_SPENT);
    // Its unshield proof (to this swap's escrow) is public now and stays valid
    // until the note is spent: on disk before anyone hears of it, so a closed
    // tab still moves the note on the next load.
    await updateLocalNote(notes.spentId, { swapProofAt: sent.at }).catch(() => {});
    send.moveNote();
    throw new Error(SWAP_REVERTED);
  }
  return hash;
}

export async function runVaultSwap(args: {
  network: GloamNetwork;
  router: Address;
  note: LocalNote;
  /** How much of the note to swap; below its value, the rest stays a note of its own. */
  amount: bigint;
  assetOut: Address;
  /** The quote the person saw. Priced again before proving; the better plan is sent. */
  plan: SwapPlan;
  /** The vault's cash-out fee the quote was made with. */
  feeBps: number;
  owner: Address;
  /** The note's tree path, read fresh. */
  pathFor: (note: LocalNote) => Promise<PoseidonMerklePath | null>;
  onStatus: (s: string) => void;
  /** A partner's link code: it goes to the relay with the swap, which counts it to them once it lands. */
  partnerCode?: string;
}): Promise<SwapResult> {
  const { network, note, amount, router } = args;
  if (!network.pool) throw new Error("This network has no vault yet.");
  assertNoteOnNetwork(note, network);
  const moving = spendWaitMessage(note);
  if (moving) throw new Error(moving);
  // every read of this swap, before and after the send, goes to its own network's chain
  const client = publicClientFor(network);
  const noteWei = BigInt(note.amountWei);
  if (amount <= 0n || amount > noteWei) throw new Error("Pick an amount up to this balance.");

  // The note to spend: the whole one, or the part set aside. A note that backed a proof
  // of funds moves whole to a fresh note first, so the proof can't point at this swap, and
  // so does one whose last swap reverted, so that swap's proof can't be used.
  let target = note;
  const spendPlan = spendPlanFor(note, amount);
  if (spendPlan !== "direct") {
    const start = await args.pathFor(note);
    if (!start) throw new Error("Could not read your private balance. Refresh and try again.");
    target = await splitForCashOut({
      note,
      amount,
      path: start,
      owner: args.owner,
      // the split goes through the relay too: a swap never shows the wallet
      relayOn: true,
      allowWhole: spendPlan === "move",
      sendWithWallet: () => Promise.reject(new Error("Swaps go through the Gloam relay.")),
      onStatus: args.onStatus,
    });
  }
  const targetWei = BigInt(target.amountWei);

  // 1. The refund note first (it doesn't depend on the price), then the price
  //    again, as close to sending as the proofs allow: the new note and the
  //    escrow below are bound to amountOut.
  args.onStatus("Proving privately, this takes 10 to 30 seconds…");
  const swapRouter = swapRouterFor(network.chainId, router);
  const withExit = swapRouter?.version === 3;
  const back = await prepareBridgeNote(refundAmountFor(targetWei, withExit ? args.feeBps : undefined), target.asset, network, args.owner);
  if (args.plan.router.toLowerCase() !== router.toLowerCase()) {
    throw new Error("This quote was for another swap router. Get a new quote and try again.");
  }
  const plan = await replanVaultSwap(
    client,
    network.chainId,
    { assetIn: target.asset, assetOut: args.assetOut, amountIn: targetWei, feeBps: args.feeBps, router },
    args.plan
  );
  const out = await prepareBridgeNote(plan.amountOut, args.assetOut, network, args.owner);

  // 2. The escrow the unshield must name: worked out here, and checked against
  //    the router's own answer, so a wrong RPC can't send the note elsewhere.
  const nullifier =
    target.nullifier && target.nullifier !== "0x"
      ? target.nullifier
      : (fieldToHex(await noteNullifierPoseidon(hexToField(target.secret), hexToField(target.commitment))) as Hex);
  const routeBytes = encodeRoute(plan.route);
  // v3 names a one-time exit key, from the refund note's own secret, in the escrow key.
  const exitKey = withExit ? exitAccount(back.note.secret).address : undefined;
  // and a deadline, from the chain's clock rather than this device's
  const deadline = exitKey ? (await client.getBlock()).timestamp + BigInt(swapDeadlineSeconds(network.chainId)) : undefined;
  const key: EscrowKey = {
    nullifier,
    amountIn: targetWei,
    outCommitment: out.note.commitment,
    assetOut: args.assetOut,
    amountOut: plan.amountOut,
    refundCommitment: back.note.commitment,
    refundAmount: BigInt(back.note.amountWei),
    routeHash: keccak256(routeBytes),
    ...(exitKey ? { exitKey, deadline } : {}),
  };
  const escrow = escrowAddress(router, target.asset, key);
  const routerSays = exitKey
    ? await client.readContract({ address: router, abi: vaultSwapV3Abi, functionName: "escrowFor", args: [target.asset, { ...key, exitKey, deadline: deadline! }] })
    : await client.readContract({ address: router, abi: vaultSwapAbi, functionName: "escrowFor", args: [target.asset, key] });
  if (routerSays.toLowerCase() !== escrow.toLowerCase()) {
    throw new Error("This swap's address didn't check out, so nothing was sent. Refresh and try again.");
  }
  const path = await args.pathFor(target);
  if (!path) throw new Error("Could not read your private balance. Refresh and try again.");
  const w = await buildPoseidonUnshieldWitness({
    secretHex: target.secret,
    amount: targetWei,
    asset: target.asset,
    to: escrow,
    path,
  });
  if (!w.checks.commitmentMatches) throw new Error(w.blocker ?? "This balance does not match the vault.");
  if (fieldToBytes32(w.publicInputs.nullifier).toLowerCase() !== nullifier.toLowerCase()) {
    throw new Error("This balance does not match the vault.");
  }
  const { proofBytes } = await proveUnshieldInBrowser(w.circomInput);

  // 3. Both saved before anything is sent. The refund note keeps what finishing
  //    a refund needs (finishVaultSwapRefund), in case it is ever wanted.
  const now = Date.now();
  const refundInfo: VaultSwapRefundInfo = {
    router,
    assetIn: target.asset,
    amountIn: targetWei.toString(),
    out: { commitment: out.note.commitment, asset: args.assetOut, amount: plan.amountOut.toString() },
    route: plan.route,
    ...(exitKey ? { exitKey, deadline: deadline!.toString() } : {}),
  };
  const outNote: LocalNote = { ...out.note, id: `sw-${now}`, sweptFrom: { id: target.id, nullifier }, sweepPending: true };
  const refundNote: LocalNote = {
    ...back.note,
    id: `swr-${now}`,
    sweptFrom: { id: target.id, nullifier },
    sweepPending: true,
    vaultSwap: refundInfo,
  };
  // on disk and read back before the swap is sent, or nothing is sent
  await saveLocalNote(outNote);
  await saveLocalNote(refundNote);

  // 4. Through the relay only.
  args.onStatus("Swapping through the Gloam relay…");
  const hash = await sendVaultSwap(
    {
      chainId: network.chainId,
      router,
      spend: { proof: proofBytes, root: fieldToBytes32(w.publicInputs.root), nullifier, asset: target.asset, amount: targetWei },
      deposit: { proof: out.proof, commitment: outNote.commitment, asset: args.assetOut, amount: plan.amountOut },
      refund: { proof: back.proof, commitment: refundNote.commitment, asset: target.asset, amount: BigInt(refundNote.amountWei) },
      route: plan.route,
      ...(exitKey ? { exitKey, deadline } : {}),
      ...(args.partnerCode ? { partnerCode: args.partnerCode } : {}),
    },
    { spentId: target.id, outId: outNote.id, refund: refundNote },
    {
      relay: relayVaultSwap,
      wait: (h) => waitForTx(h, undefined, client),
      isSpent: (n) => client.readContract({ address: network.pool!, abi: shieldPoolAbi, functionName: "isSpent", args: [n] }),
      moveNote: () => void moveRevertedNotes().catch(() => {}),
    },
    () => args.onStatus("Waiting for the swap to land…")
  );

  // Landed: the new note, or (if someone sent the unshield on its own first)
  // the refund note. Which one is read from the vault; if that read fails both
  // stay pending and the next sync settles them, so no money is ever hidden.
  const seen = (c: Hex) =>
    client.readContract({ address: network.pool!, abi: shieldPoolAbi, functionName: "commitmentSeen", args: [c] });
  const [outSeen, refundSeen] = await Promise.all([seen(outNote.commitment), seen(refundNote.commitment)]).catch(
    () => [false, false] as const
  );
  if (!outSeen && !refundSeen) throw new Error("The swap went out. Refresh in a minute to see it in your balance.");
  const refunded = !outSeen;
  const landed = refunded ? refundNote : outNote;
  const unused = refunded ? outNote : refundNote;
  const at = await freshPath(landed.commitment, network);
  updateLocalNote(target.id, { status: "recovered", txHash: hash });
  updateLocalNote(unused.id, { status: "recovered", sweepPending: false });
  updateLocalNote(landed.id, { status: "open", sweepPending: false, txHash: hash, ...(at ? { leafIndex: at.leafIndex } : {}) });
  return {
    hash,
    refunded,
    outNote: { ...landed, txHash: hash, sweepPending: false, ...(at ? { leafIndex: at.leafIndex } : {}) },
  };
}

/**
 * The transaction that paid a swap's escrow: what a refund or an exit shows the relay.
 * Found by its nullifier and kept on the note, as anyone may have sent it. The note came
 * first, so the search starts where the chain stood then, at up to 12 blocks a second
 * (Robinhood Chain makes about 10). If nothing is found there, it searches again from
 * the vault's first block, in case a chain ran faster than that.
 */
async function unshieldTxOf(note: LocalNote, escrow: Address): Promise<Hex | null> {
  const info = note.vaultSwap;
  const net = networkOfNote(note);
  if (!info || !note.sweptFrom || !net?.pool) return null;
  if (info.unshieldTx) return info.unshieldTx;
  const client = publicClientFor(net);
  const head = await client.getBlockNumber();
  const floor = net.deployBlock ?? 0n;
  const age = Number.isFinite(note.createdAt) ? Math.ceil((Date.now() - note.createdAt) / 1000) + 3600 : null;
  const back = age === null ? null : head - BigInt(age) * 12n;
  const from = back !== null && back > floor ? back : floor;
  const search = (start: bigint, end: bigint) =>
    walkLogs(client, net.pool!, start, end, { ...walkTuning(net.chainId, net.logRange), span: net.logRange }, {
      event: UNSHIELDED_EVENT,
      args: { nullifier: note.sweptFrom!.nullifier, asset: info.assetIn, to: escrow },
    });
  let logs = await search(from, head);
  if (!logs.length && from > floor) logs = await search(floor, from - 1n);
  const hash = logs[0]?.transactionHash ?? null;
  if (hash) await updateLocalNote(note.id, { vaultSwap: { ...info, unshieldTx: hash } }).catch(() => {});
  return hash;
}

/** Proof bytes and a root the router never reads on the refund path (64 zero bytes, a zero root). */
const UNUSED_PROOF = `0x${"00".repeat(64)}` as Hex;
const UNUSED_ROOT = `0x${"00".repeat(32)}` as Hex;
const RETRY_MS = 60_000;
/** A vault that refused the refund is asked less often: each try is a proof, and its limit can stay closed for days. */
const BLOCKED_RETRY_MS = 10 * 60_000;
const lastTry = new Map<string, number>();

/**
 * Puts a swap's waiting money back as its refund note: the case where someone
 * sent the swapped note's unshield on its own, so the money sits at the swap's
 * escrow (lib/claimSweep finds it and calls this). Proves the refund note's
 * shield again from its saved secret and sends the same swap call through the
 * relay; the router sees the note spent and makes the refund. At most one try
 * a minute per note; the next sync counts the note once it lands. True when one
 * was sent. A refund the vault refuses (a closed limit) throws the relay's
 * refusal, and the note stays pending for the next sync (lib/claimSweep).
 */
export async function finishVaultSwapRefund(note: LocalNote): Promise<boolean> {
  const info = note.vaultSwap;
  const from = note.sweptFrom;
  if (!info || !from || !note.sweepPending) return false;
  const last = lastTry.get(note.id);
  if (last !== undefined && Date.now() - last < (note.refundHeld === "blocked" ? BLOCKED_RETRY_MS : RETRY_MS)) return false;
  lastTry.set(note.id, Date.now());

  // nothing to show the relay yet, so no proof to make: the next sync asks again
  const key = refundEscrowKey(info, from.nullifier, note.commitment, BigInt(note.amountWei));
  const unshieldTx = await unshieldTxOf(note, escrowAddress(info.router, info.assetIn, key)).catch(() => null);
  if (!unshieldTx) return false;

  const { proofBytes } = await proveShieldInBrowser({
    commitment: BigInt(note.commitment).toString(),
    amount: note.amountWei,
    asset: BigInt(note.asset).toString(),
    secret: BigInt(note.secret).toString(),
  });
  const hash = await relayVaultSwap({
    chainId: note.chainId,
    // the router this swap went through, which may not be the one new swaps use now
    router: info.router,
    spend: { proof: UNUSED_PROOF, root: UNUSED_ROOT, nullifier: from.nullifier, asset: info.assetIn, amount: BigInt(info.amountIn) },
    deposit: { proof: UNUSED_PROOF, commitment: info.out.commitment, asset: info.out.asset, amount: BigInt(info.out.amount) },
    refund: { proof: proofBytes, commitment: note.commitment, asset: note.asset, amount: BigInt(note.amountWei) },
    route: info.route,
    unshieldTx,
    ...(info.exitKey ? { exitKey: info.exitKey, deadline: BigInt(info.deadline ?? "0") } : {}),
  });
  // the receipt is read on the note's own chain, whatever the page shows by now
  const net = networkOfNote(note);
  await waitForTx(hash, undefined, net ? publicClientFor(net) : undefined).catch(() => null);
  return true;
}

/**
 * Takes a swap's waiting money out to `to`, in the clear, when its refund can't land
 * (GloamVaultSwap2.exit). The key that signs comes from the refund note's secret and
 * stays here; the signature names `to`, so the relay can only send it there. The whole
 * escrow leaves, so the refund note is retired once the chain says it landed.
 */
export async function exitVaultSwap(note: LocalNote, to: Address): Promise<Hex> {
  const info = note.vaultSwap;
  const from = note.sweptFrom;
  if (!info?.exitKey || !from) throw new Error("A swap through this router has no exit. Its refund lands once the vault has room.");
  const key = refundEscrowKey(info, from.nullifier, note.commitment, BigInt(note.amountWei));
  const account = exitAccount(note.secret);
  if (account.address.toLowerCase() !== info.exitKey.toLowerCase()) throw new Error("This note doesn't hold this swap's exit key.");
  const escrow = escrowAddress(info.router, info.assetIn, key);
  // the router refuses these (BadExit): the money would stop there for good
  const stops = [escrow, info.router, networkOfNote(note)?.pool ?? null, info.assetIn].filter(Boolean) as Address[];
  if (stops.some((a) => a.toLowerCase() === to.toLowerCase())) throw new Error("An exit can't go to that address. Pick a wallet address.");
  const unshieldTx = await unshieldTxOf(note, escrow).catch(() => null);
  if (!unshieldTx) throw new Error("The vault's payment to this swap can't be read yet. Try again in a minute.");
  const signature = await account.sign({ hash: exitDigest(note.chainId, info.router, escrow, to) });
  const hash = await relayVaultSwapExit({
    chainId: note.chainId,
    router: info.router,
    asset: info.assetIn,
    key: { ...key, exitKey: info.exitKey, deadline: BigInt(info.deadline ?? "0") },
    to,
    signature,
    unshieldTx,
  });
  const net = networkOfNote(note);
  const outcome = await waitForTx(hash, undefined, net ? publicClientFor(net) : undefined);
  if (outcome !== "success") throw new Error("The exit didn't go through, and the money is still waiting. Try again in a minute.");
  await updateLocalNote(note.id, { status: "recovered", sweepPending: false, refundHeld: undefined, txHash: hash });
  return hash;
}
