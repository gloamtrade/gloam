/**
 * What a Gloam private account does on Starknet, each as one pool transaction
 * built and proven here and sent by Gloam's relay:
 *
 *  - openAccount: register the viewing key AND open the account's own channel
 *    for each listed token, in one transaction. Registering shows the account's
 *    address anyway; opening its own channel then means change notes and the
 *    first cash out never open one later, which would name the account on the
 *    cash out.
 *  - add: move tokens the account holds into the pool (the depositor and the
 *    amount are public; the token's approve runs first, relayPolicy).
 *  - pay: a private payment. The first payment to someone opens a channel to
 *    them, which shows their account's address; later ones show nothing.
 *  - cashOut: a withdrawal to any address (its destination and amount are
 *    public, never the account it came from).
 *
 * `fee` adds a withdrawal of `fee.amount` of the same token to Gloam's relay,
 * inside the proof, which is how the relay is paid for the STRK it spends
 * (the same shape as AVNU's private paymaster). relayPolicy checks it.
 *
 * Each returns the SDK's ExecuteResult: the call and its proof to hand to the
 * relay, the updated registry, and the SDK's privacy warnings.
 */
import type { ExecuteOptions, ExecuteResult, PrivateTransfersInterface, ProvingBlockId } from "@starkware-libs/starknet-privacy-sdk";
import { num, type Call } from "starknet";

/** u128: the pool's amount type. */
const U128_MAX = (1n << 128n) - 1n;

export type RelayFee = { recipient: string; amount: bigint };

type Common = {
  token: string;
  /** The account itself: change comes back here. */
  self: string;
  fee?: RelayFee | null;
  /** Pin discovery and proving to one block (the SDK's sequencing recipe: latest minus 10). */
  provingBlockId?: ProvingBlockId;
};

function checkAmount(amount: bigint, what = "amount"): void {
  if (typeof amount !== "bigint" || amount <= 0n || amount > U128_MAX) throw new Error(`Invalid ${what}.`);
}

function checkFee(fee: RelayFee | null | undefined): void {
  if (!fee) return;
  if (!/^0x[0-9a-fA-F]{1,64}$/.test(fee.recipient)) throw new Error("Invalid relay fee recipient.");
  checkAmount(fee.amount, "relay fee");
}

const refresh = { notes: "refresh", channels: "refresh" } as const;

function opts(c: Pick<Common, "provingBlockId">, extra: ExecuteOptions = {}): ExecuteOptions {
  return { autoSetup: true, autoDiscover: refresh, ...(c.provingBlockId !== undefined ? { provingBlockId: c.provingBlockId } : {}), ...extra };
}

/** Register the viewing key and open the account's own channel for each token, in one transaction. */
export async function openAccount(t: PrivateTransfersInterface, input: { self: string; tokens: string[]; provingBlockId?: ProvingBlockId }): Promise<ExecuteResult> {
  if (!input.tokens.length) throw new Error("No tokens to open.");
  let b = t.build(opts(input, { autoSetup: false })).register().setup(input.self);
  for (const token of input.tokens) b = b.with(token, (tb) => void tb.setup(input.self));
  return b.execute();
}

/** Add `amount` of `token` (already approved to the pool) to the private balance. */
export async function add(t: PrivateTransfersInterface, input: Common & { amount: bigint }): Promise<ExecuteResult> {
  checkAmount(input.amount);
  checkFee(input.fee);
  if (input.fee && input.fee.amount >= input.amount) throw new Error("The relay fee is more than the amount.");
  const tb = t.build(opts(input)).with(input.token).deposit({ amount: input.amount });
  if (input.fee) tb.withdraw({ recipient: input.fee.recipient, amount: input.fee.amount });
  return tb.surplusTo(input.self).execute();
}

/** Pay `amount` of `token` privately to another account (`to`, a Gloam Starknet account address). */
export async function pay(t: PrivateTransfersInterface, input: Common & { to: string; amount: bigint }): Promise<ExecuteResult> {
  checkAmount(input.amount);
  checkFee(input.fee);
  if (BigInt(input.to) === BigInt(input.self)) throw new Error("That is this account.");
  const tb = t.build(opts(input, { autoSelectNotes: "naive" })).with(input.token).transfer({ recipient: input.to, amount: input.amount });
  if (input.fee) tb.withdraw({ recipient: input.fee.recipient, amount: input.fee.amount });
  return tb.surplusTo(input.self).execute();
}

/** Cash out `amount` of `token` to the public address `to`. */
export async function cashOut(t: PrivateTransfersInterface, input: Common & { to: string; amount: bigint }): Promise<ExecuteResult> {
  checkAmount(input.amount);
  checkFee(input.fee);
  if (!/^0x[0-9a-fA-F]{1,64}$/.test(input.to)) throw new Error("Invalid address.");
  const tb = t.build(opts(input, { autoSelectNotes: "naive" })).with(input.token).withdraw({ recipient: input.to, amount: input.amount });
  if (input.fee) tb.withdraw({ recipient: input.fee.recipient, amount: input.fee.amount });
  return tb.surplusTo(input.self).execute();
}

/**
 * The token approve an add needs, run as the account (signed as a SNIP-9
 * outside execution, sent by the relay: relayPolicy's "approve" shape).
 */
export function approveCall(token: string, pool: string, amount: bigint): Call {
  checkAmount(amount);
  return { contractAddress: token, entrypoint: "approve", calldata: [pool, num.toHex(amount), "0x0"] };
}

/** The private balance of `token`: the sum of the account's unspent notes. */
export async function privateBalance(t: PrivateTransfersInterface, token: string): Promise<bigint> {
  const { notes } = await t.discoverNotes();
  return (notes.get(token) ?? []).reduce((s, n) => s + n.amount, 0n);
}
