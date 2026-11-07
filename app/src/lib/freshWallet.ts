"use client";

/**
 * Fund a fresh wallet from the private balance, ready to use Borro on Robinhood
 * Chain. The position stays public; it just doesn't point to the main wallet.
 *
 * No new money logic. The two payments are a private cash out's two pieces
 * (lib/cashOutPrivately): each is split off, proven and handed to the relay, in
 * order, and a run stops at the first problem with the rest safe in the private
 * balance. Gas is set up first, so the wallet's USDG is never committed without
 * it. With Now it also lands first. With a window each piece goes at its own
 * random time, so the USDG can land before the gas money does. The only new
 * thing is "Now", which sends a piece at once instead of scheduling it, the same
 * relayed cash out as Pay > Cash out. A wallet that already has gas can skip the
 * gas piece.
 *
 * Then lib/gasStation: the USDG waits at the wallet's station until the relay
 * makes it and pumps it into ETH. Every step reads from the chain, so nothing
 * has to be remembered: paste the same address later and it picks up.
 */
import { isAddress, type Address, type Hex } from "viem";
import { normAddress } from "./cashOutPrivacy";
import { runPrivateCashOut, type PieceProgress, type PrivateCashOutDeps, type PrivateCashOutResult } from "./cashOutPrivately";
import { splitMaybeSent } from "./cashOutSplit";
import type { CashOutCall } from "./cashOutProof";
import type { CashOutWindow, OwnedCashOutJob } from "./cashOutLater";
import { FRESH_WALLET_PATH, GAS_STATION_CHAIN_ID, STATION_MAX_PUMP_USDG, STATION_USDG, predictStation, fundingStep, readStationState, walletHasGas, type StationState } from "./gasStation";
import { getNetwork } from "./networks";
import { buildShortPaymentRequestLink, requestAssetsFor } from "./paymentRequest";
import { RelaySubmitError, relayGasStation, relayUnshield, waitForTx } from "./relay/client";
import { publicClientFor } from "./rhClient";
import { updateLocalNote, withdrawFeeOf, type LocalNote } from "./shield";

/** When the two pieces go: at once, or each at its own random time in a window. */
export type FundWhen = "now" | CashOutWindow;

/** The fewest USDG worth sending to the wallet. */
export const FRESH_MIN_USDG = 500_000n;
/** The least gas money, in USDG: after the cash-out fee it still clears what the relay acts on. */
export const FRESH_MIN_GAS = 500_000n;
/** The most gas money: one relayed pump swaps no more than this. */
export const FRESH_MAX_GAS = STATION_MAX_PUMP_USDG;
export const GAS_PRESETS = ["0.5", "1", "2"] as const;
export const GAS_DEFAULT = "1";

/** Shown while the address came from a link: a link can name anyone's wallet. */
export const LINKED_ADDRESS_NOTE = "This address came from a link. Check you control it: whoever holds its key gets this money.";
/** A contract, or an account delegating to one: the relay won't pay for its gas (lib/relay/gasStation). */
export const WALLET_CODE_PROBLEM = "This address is a contract or points to one, so the relay can't get it gas. Use a plain new wallet.";
export const NEEDS_GAS_PROBLEM = "This wallet has no gas yet, so it needs some gas money.";

const SAME_WALLET = "That's the wallet you're signed in with. Use a fresh one, or the position points straight to it.";
const DEPOSIT_WALLET = "You added money to Gloam from this address, so it points straight to you. Use a fresh one.";

/**
 * Why this address can't be the fresh wallet, or null. The signed-in wallet and
 * any wallet this browser deposited from are refused outright: funding one would
 * cost a fee and leave the link it was meant to avoid.
 */
export function freshAddressProblem(p: {
  to: string;
  connected: string | null | undefined;
  /** Wallets this browser added money from (lib/cashOutPrivacy depositWallets). */
  deposited: ReadonlySet<string>;
  /** Why a cash out could not go here (lib/cashOutTarget). */
  targetProblem: (to: string) => string | null;
}): string | null {
  const to = p.to.trim();
  if (!to) return null;
  if (!isAddress(to)) return "Paste a 0x address.";
  const target = p.targetProblem(to);
  if (target) return target;
  const low = normAddress(to);
  if (low && low === normAddress(p.connected)) return SAME_WALLET;
  if (low && p.deposited.has(low)) return DEPOSIT_WALLET;
  return null;
}

export function amountProblem(amount: bigint | null, typed: string): string | null {
  if (!typed.trim()) return null;
  if (amount === null) return "Enter an amount.";
  return amount < FRESH_MIN_USDG ? "Send at least 0.5 USDG." : null;
}

/** `hasGas`: the wallet already holds enough ETH, so it can do with none. */
export function gasProblem(gas: bigint | null, typed: string, hasGas = false): string | null {
  if (!typed.trim()) return hasGas ? null : "Enter how much USDG to turn into gas.";
  if (gas === null) return "Enter an amount.";
  if (gas === 0n && hasGas) return null;
  return gas < FRESH_MIN_GAS || gas > FRESH_MAX_GAS ? "Gas money is 0.5 to 5 USDG." : null;
}

export type FundingPlan = {
  /** Gas first, then the wallet's USDG. Just the USDG when there is no gas money. */
  pieces: bigint[];
  to: Address[];
  /** What leaves the private balance. */
  total: bigint;
  /** The cash-out fee on both pieces. */
  fee: bigint;
  arrives: { station: bigint; wallet: bigint };
};

/** The cash outs, in the order they are set up. `feeBps` is the vault's own, read live. */
export function fundingPlan(p: { wallet: Address; amount: bigint; gas: bigint; feeBps: number }): FundingPlan {
  const gasFee = withdrawFeeOf(p.gas, p.feeBps);
  const walletFee = withdrawFeeOf(p.amount, p.feeBps);
  const withGas = p.gas > 0n;
  return {
    pieces: withGas ? [p.gas, p.amount] : [p.amount],
    to: withGas ? [predictStation(p.wallet), p.wallet] : [p.wallet],
    total: p.gas + p.amount,
    fee: gasFee + walletFee,
    arrives: { station: p.gas - gasFee, wallet: p.amount - walletFee },
  };
}

/** A cash out sent right now: the relayed send Pay > Cash out makes, settled once it lands. */
export type SendNowDeps = {
  send: (call: CashOutCall) => Promise<Hex>;
  wait: (hash: Hex) => Promise<"success" | "reverted">;
  settle: (noteId: string, hash: Hex) => void;
  now: () => number;
};

const appSendDeps: SendNowDeps = {
  send: relayUnshield,
  wait: (hash) => waitForTx(hash, undefined, publicClientFor(getNetwork("robinhood-mainnet"))),
  settle: (noteId, hash) => void updateLocalNote(noteId, { status: "recovered", txHash: hash }),
  now: () => Date.now(),
};

export const SEND_REVERTED = "This cash out didn't go through. Your money is safe in the vault. Refresh and try again.";
export const SEND_SLOW = "This cash out may still be landing. It shows here once it does, so check before you try again.";

/**
 * Stands in for scheduling when the person chose Now. A note is only marked
 * spent once its receipt says so: a send that may have gone out leaves it for
 * the next sync, which reads the chain.
 */
export async function sendPieceNow(note: LocalNote, call: CashOutCall, deps: SendNowDeps = appSendDeps): Promise<OwnedCashOutJob> {
  const hash = await deps.send(call);
  let outcome: "success" | "reverted";
  try {
    outcome = await deps.wait(hash);
  } catch {
    throw new Error(SEND_SLOW);
  }
  if (outcome === "reverted") throw new Error(SEND_REVERTED);
  deps.settle(note.id, hash);
  const at = deps.now();
  return { id: hash, chainId: call.chainId, sendAfter: at, status: "sent", updatedAt: at, hash, to: call.to };
}

/** The most the wallet can get from a balance, once the gas money has come out of it. */
export function mostForWallet(largest: bigint, gas: bigint | null): bigint {
  return gas !== null && largest > gas ? largest - gas : 0n;
}

/**
 * What went wrong, in words that never call an unknown outcome nothing. A send
 * that may have gone out must not read as safe to repeat: that pays twice.
 */
export function stoppedLine(r: Pick<PrivateCashOutResult, "jobs" | "stoppedAt" | "error" | "maybeSent">, withGas: boolean): string {
  const usdgPiece = !withGas || r.stoppedAt === 1;
  if (r.maybeSent) {
    const which = usdgPiece ? "Your USDG" : "The gas money";
    const first = withGas && usdgPiece ? "The gas money is on its way. " : "";
    return `${first}${which} may have gone out. Check where the wallet stands before you send again, or you could pay twice. What didn't go out is safe in your private balance.`;
  }
  const said = r.jobs.length ? "The gas money is on its way, your USDG is not." : "Nothing has gone out.";
  return `${said} ${r.error ?? ""} The rest is safe in your private balance.`.replace(/\s+/g, " ");
}

/** The runner's words, for these two pieces. */
export function pieceWords(s: string, when: FundWhen): string {
  const named = s.replace(/^Piece 1 of 2/, "Gas money").replace(/^Piece (2 of 2|1 of 1)/, "Your USDG");
  return when === "now" ? named.replace("scheduling with the Gloam relay", "sending through the Gloam relay") : named;
}

export type FundDeps = {
  read: (wallet: Address) => Promise<StationState>;
  run: typeof runPrivateCashOut;
  /** Replaces scheduling when the person chose Now. */
  sendNow: PrivateCashOutDeps["schedule"];
};

const appFundDeps: FundDeps = {
  read: (wallet) => readStationState(publicClientFor(getNetwork("robinhood-mainnet")), wallet),
  run: runPrivateCashOut,
  sendNow: (note, call) => sendPieceNow(note, call),
};

/** Whether a piece sent now failed in a way that may still have put it on chain. */
function sendMaybeOut(e: unknown): boolean {
  return splitMaybeSent(e, true) || (e instanceof Error && e.message === SEND_SLOW);
}

/**
 * Sends the pieces out of one note. The chain is read first, so a piece never
 * goes to a station the factory doesn't confirm, or anywhere the relay couldn't
 * finish the job. A piece sent now that may have gone out counts as maybeSent.
 */
export async function fundFreshWallet(args: {
  note: LocalNote;
  wallet: Address;
  amount: bigint;
  gas: bigint;
  feeBps: number;
  when: FundWhen;
  owner: Address;
  onStatus?: (s: string) => void;
  onPiece?: (i: number, p: Partial<PieceProgress>) => void;
  deps?: Partial<FundDeps>;
}): Promise<PrivateCashOutResult> {
  const d: FundDeps = { ...appFundDeps, ...args.deps };
  if (args.note.chainId !== GAS_STATION_CHAIN_ID) throw new Error("This runs on Robinhood Chain mainnet.");
  if (args.note.asset.toLowerCase() !== STATION_USDG.toLowerCase()) throw new Error("This needs a USDG balance.");
  const state = await d.read(args.wallet);
  if (state.walletHasCode && args.gas > 0n) throw new Error(WALLET_CODE_PROBLEM);
  if (args.gas === 0n && !walletHasGas(state)) throw new Error(NEEDS_GAS_PROBLEM);
  const plan = fundingPlan({ wallet: args.wallet, amount: args.amount, gas: args.gas, feeBps: args.feeBps });
  let uncertain = false;
  const sendNow: PrivateCashOutDeps["schedule"] = async (note, call, when) => {
    try {
      return await d.sendNow(note, call, when);
    } catch (e) {
      uncertain = sendMaybeOut(e);
      throw e;
    }
  };
  const r = await d.run({
    note: args.note,
    pieces: plan.pieces,
    to: plan.to,
    window: args.when === "now" ? "hour" : args.when,
    owner: args.owner,
    least: 1,
    onStatus: (s) => args.onStatus?.(pieceWords(s, args.when)),
    onPiece: args.onPiece,
    deps: args.when === "now" ? { schedule: sendNow } : undefined,
  });
  return uncertain ? { ...r, maybeSent: true } : r;
}

export type GasDeps = {
  read: (wallet: Address) => Promise<StationState>;
  send: (p: { chainId: number; wallet: Address; step: "make" | "pump" }) => Promise<Hex>;
  wait: (hash: Hex) => Promise<"success" | "reverted">;
  sleep: (ms: number) => Promise<void>;
};

const appGasDeps: GasDeps = {
  read: appFundDeps.read,
  send: relayGasStation,
  wait: appSendDeps.wait,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

export const GAS_REVERTED = "That step didn't go through. Your USDG stays at the station. Try again.";
/** The relay reads its own node, which can be a moment behind the one that showed the receipt. */
const LAG = { tries: 4, delayMs: 2_000 };

/**
 * Makes the wallet's station if it needs it, then pumps. Starts from what the
 * chain shows, so a run that stopped half way goes on from there.
 */
export async function getGas(args: { wallet: Address; onStatus?: (s: string) => void; deps?: Partial<GasDeps> }): Promise<StationState> {
  const d: GasDeps = { ...appGasDeps, ...args.deps };
  let state = await d.read(args.wallet);
  for (let round = 0; round < 2; round++) {
    const step = fundingStep(state);
    if (step !== "make" && step !== "pump") return state;
    args.onStatus?.(step === "make" ? "Making the gas station…" : "Turning USDG into ETH…");
    let hash: Hex | null = null;
    for (let attempt = 1; hash === null; attempt++) {
      try {
        hash = await d.send({ chainId: GAS_STATION_CHAIN_ID, wallet: args.wallet, step });
      } catch (e) {
        if (!(e instanceof RelaySubmitError && e.code === "not_made") || attempt >= LAG.tries) throw e;
        await d.sleep(LAG.delayMs);
      }
    }
    if ((await d.wait(hash)) === "reverted") throw new Error(GAS_REVERTED);
    const before = state;
    const moved = () => state.made !== before.made || state.stationUsdg !== before.stationUsdg;
    state = await d.read(args.wallet);
    for (let i = 0; i < LAG.tries && !moved(); i++) {
      await d.sleep(LAG.delayMs);
      state = await d.read(args.wallet);
    }
    // One pump a run: the relay holds this wallet's pump for a few minutes after a send.
    if (step === "pump") return state;
  }
  return state;
}

/**
 * A link that opens this flow filled in, the same shape as a payment request:
 * everything sits in the fragment, which never reaches a server.
 */
export function fundLink(to: Address, amount?: string, origin = "https://gloam.trade"): string {
  const p = new URLSearchParams({ to });
  if (amount) p.set("amount", amount);
  return `${origin}${FRESH_WALLET_PATH}#${p.toString()}`;
}

/** What a link's fragment fills in. Anything malformed is left out. It only fills the form: nothing moves until the person presses send. */
export function readFundLink(hash: string): { to: string; amount: string } {
  const p = new URLSearchParams(hash.replace(/^#/, ""));
  const to = p.get("to") ?? "";
  const amount = p.get("amount") ?? "";
  return { to: isAddress(to) ? to : "", amount: /^\d{1,9}(\.\d{1,6})?$/.test(amount) ? amount : "" };
}

/**
 * The way back: a payment request for USDG to the person's own Gloam address.
 * Opened with the fresh wallet connected, it adds the USDG privately and pays it
 * to them. Notes belong to the wallet that made them, so a deposit from the fresh
 * wallet alone would never show under the main one.
 */
export function backLink(tag: string, origin = "https://gloam.trade"): string {
  const asset = requestAssetsFor("robinhood-mainnet").find((a) => !a.native && a.address.toLowerCase() === STATION_USDG.toLowerCase());
  if (!asset) throw new Error("USDG is not listed on Robinhood Chain.");
  return buildShortPaymentRequestLink({ to: tag, network: "robinhood-mainnet", asset, amount: "" }, origin);
}
