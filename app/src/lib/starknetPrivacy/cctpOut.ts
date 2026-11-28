/**
 * Cashing out from a Gloam private account on Starknet to another chain with
 * Circle's CCTP V2. Shared by the browser and the server; pure, checked by
 * scripts/selftest-starknet-cctp-out.mts.
 *
 * One Starknet transaction, sent by Gloam's relay, does all of it, so nothing
 * is ever left half way:
 *  1. the pool's apply_actions (the person's proven cash out) withdraws the
 *     amount and Gloam's burn fee to a one-time account, and pays the relay its
 *     usual fee inside the proof;
 *  2. the relay deploys that one-time account (Gloam's account class, from a
 *     key derived from the private account's key and an index);
 *  3. the one-time account's own signed outside execution approves Circle's
 *     TokenMessengerMinterV2, calls deposit_for_burn_with_hook(amount, the
 *     destination's domain, the recipient, USDC, 0, maxFee, fast, the
 *     forwarding hook) and pays the relay Gloam's burn fee.
 * If any part fails, all of it does, and the relay's estimate catches that
 * before anything is sent. Circle's Forwarding Service then mints on the
 * destination chain and pays its gas (it serves Base, Ethereum, Arbitrum and
 * the rest of CCTP_DESTINATIONS from Starknet; its fee API answered for each on
 * 2026-11-27), so the person needs nothing on the destination chain.
 *
 * Who pays what: Circle's fast transfer fee (12 bps from Starknet on
 * 2026-11-27) and its forwarding fee (about 0.05 USDC to Base, 0.74 to
 * Ethereum) come out of the amount: with forwarding Circle takes the whole
 * maxFee, so Gloam sets it to exactly those two and shows it as one fee.
 * Gloam's fee on a cash out (STARKNET_RELAY_FEE, inside the proof) and its burn
 * fee (STARKNET_CCTP_FEE, from the one-time account) pay the relay's STRK.
 *
 * What is public, the same as any cash out: the amount and the destination
 * address (now on another chain), never which private account it came from.
 * The pool's withdrawal goes to a fresh one-time account, never the person's
 * own account, and each cash out uses a new one, so cash outs aren't linked to
 * each other on chain either. Timing is visible, as with any cash out.
 */
import { ec, hash, num, type Call } from "starknet";
import { accountAddress } from "./account";
import { CCTP_SOURCES, CCTP_FAST, CCTP_STANDARD, OUTSIDE_V2, byteArrayCalldata, circleFee, evmToBytes32, hexToBytes, sameBytes32, type CctpSource, type StarknetCctp } from "./cctp";
import { decodeApply } from "./relayPolicy";

/** Circle's Forwarding Service hook, version 0 with no extra data: "cctp-forward", version 0, length 0. */
export const FORWARD_HOOK = "0x636374702d666f72776172640000000000000000000000000000000000000000";

/**
 * Where a cash out can go: the EVM chains Gloam brings money in from, each one
 * a Forwarding Service destination (Circle's supported chains page). Solana
 * needs its recipient's USDC token account and, when it has none, Circle to
 * create it: a follow-up.
 */
export const CCTP_DESTINATIONS: readonly CctpSource[] = CCTP_SOURCES.filter((s) => s.kind === "evm");

export function cctpDestinationByDomain(domain: number): CctpSource | null {
  return CCTP_DESTINATIONS.find((s) => s.domain === domain) ?? null;
}

export function cctpDestinationByChain(chainId: number): CctpSource | null {
  return CCTP_DESTINATIONS.find((s) => s.chainId === chainId) ?? null;
}

/** Circle's forwarding fee row for a route (GET /v2/burn/USDC/fees/25/{d}?forward=true), base units. */
export type ForwardFee = { low: bigint; med: bigint; high: bigint };

export function forwardFeeFrom(json: unknown, threshold = CCTP_FAST): ForwardFee | null {
  if (!Array.isArray(json)) return null;
  const row = json.find((r) => (r as { finalityThreshold?: unknown })?.finalityThreshold === threshold) as { forwardFee?: { low?: unknown; med?: unknown; high?: unknown } } | undefined;
  const f = row?.forwardFee;
  try {
    const out = { low: BigInt(f?.low as number), med: BigInt(f?.med as number), high: BigInt(f?.high as number) };
    return out.low >= 0n && out.med >= out.low && out.high >= out.med && out.high < 100_000_000n ? out : null;
  } catch {
    return null;
  }
}

/**
 * The maxFee for a forwarded fast burn of `amount`: Circle's fast fee (rounded
 * up) plus its forwarding fee at the high estimate. Circle takes all of it, and
 * a maxFee short of both turns the transfer into a standard one (hours from
 * Starknet), so the high estimate is the honest price.
 */
export function outMaxFee(amount: bigint, fastBps: number, forward: ForwardFee): bigint {
  return circleFee(amount, fastBps) + forward.high;
}

/** deposit_for_burn_with_hook on Starknet's TokenMessengerMinterV2, with the forwarding hook. */
export function burnWithForwardCall(cctp: Pick<StarknetCctp, "tokenMessengerMinter" | "usdc">, input: { amount: bigint; domain: number; recipient: string; maxFee: bigint; finality?: number }): Call {
  const u256 = (v: bigint) => [num.toHex(v & ((1n << 128n) - 1n)), num.toHex(v >> 128n)];
  return {
    contractAddress: cctp.tokenMessengerMinter,
    entrypoint: "deposit_for_burn_with_hook",
    calldata: [
      ...u256(input.amount),
      num.toHex(input.domain),
      ...u256(BigInt(evmToBytes32(input.recipient))),
      cctp.usdc,
      "0x0",
      "0x0",
      ...u256(input.maxFee),
      num.toHex(input.finality ?? CCTP_FAST),
      ...byteArrayCalldata(hexToBytes(FORWARD_HOOK)),
    ],
  };
}

/** The three calls the one-time account signs: approve the minter, burn with forwarding, pay the relay. */
export function oneTimeCalls(cctp: Pick<StarknetCctp, "tokenMessengerMinter" | "usdc">, input: { amount: bigint; domain: number; recipient: string; maxFee: bigint; relay: string; fee: bigint; finality?: number }): Call[] {
  const u256 = (v: bigint) => [num.toHex(v & ((1n << 128n) - 1n)), num.toHex(v >> 128n)];
  return [
    { contractAddress: cctp.usdc, entrypoint: "approve", calldata: [cctp.tokenMessengerMinter, ...u256(input.amount)] },
    burnWithForwardCall(cctp, input),
    { contractAddress: cctp.usdc, entrypoint: "transfer", calldata: [input.relay, ...u256(input.fee)] },
  ];
}

// ------------------------------------------------------------------ one-time accounts

const CURVE_ORDER: bigint = ec.starkCurve.CURVE.n;
const enc = new TextEncoder();

async function hkdf(ikm: Uint8Array, info: string): Promise<Uint8Array> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("This browser can't cash out to another network (no Web Crypto).");
  const ab = (b: Uint8Array) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
  const key = await subtle.importKey("raw", ab(ikm), "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: ab(enc.encode("gloam/starknet-cctp-out/v1")), info: ab(enc.encode(info)) }, key, 512));
}

export type OneTimeKeys = { index: number; key: bigint; publicKey: string; address: string };

/**
 * One-time account `index` of a private account: a key derived from the
 * private account's own key (never stored), so the same index always gives
 * the same account and nothing but this key can move what lands on it.
 */
export async function oneTimeKeys(accountKey: bigint, index: number): Promise<OneTimeKeys> {
  if (!Number.isSafeInteger(index) || index < 0 || index > 1_000_000) throw new Error("Invalid index.");
  const seed = hexToBytes("0x" + accountKey.toString(16).padStart(64, "0"));
  const bits = await hkdf(seed, `one-time/${index}`);
  seed.fill(0);
  let k = BigInt("0x" + Array.from(bits, (x) => x.toString(16).padStart(2, "0")).join("")) % CURVE_ORDER;
  if (k === 0n) k = 1n;
  const publicKey = ec.starkCurve.getStarkKey(num.toHex(k));
  return { index, key: k, publicKey, address: accountAddress(publicKey) };
}

// ------------------------------------------------------------------ the relay's burn

const FELT_MAX = (1n << 251n) + 17n * (1n << 192n);
const U128 = 1n << 128n;
const SEL = {
  approve: BigInt(hash.getSelectorFromName("approve")),
  transfer: BigInt(hash.getSelectorFromName("transfer")),
  burn: BigInt(hash.getSelectorFromName("deposit_for_burn_with_hook")),
};
const HOOK_FELTS = byteArrayCalldata(hexToBytes(FORWARD_HOOK)).map((x) => BigInt(x));
/** An outside execution may run for at most this long after the relay gets it. */
export const OUT_WINDOW_S = 3_600;

export type CctpBurnContext = {
  cctp: Pick<StarknetCctp, "tokenMessengerMinter" | "usdc">;
  relay: string;
  now: number;
  /** The least the one-time account must pay the relay (STARKNET_CCTP_FEE), base units. */
  minFee: bigint;
  accountClassHash: string;
};

export type CctpBurnDecision =
  | { ok: true; oneTime: string; amount: bigint; fee: bigint; withdrawn: bigint; domain: number; recipient: string; maxFee: bigint; finality: number }
  | { ok: false; reason: string };

const no = (reason: string): CctpBurnDecision => ({ ok: false, reason });

function felts(call: Call | undefined): bigint[] | null {
  if (!call || !Array.isArray(call.calldata)) return null;
  const out: bigint[] = [];
  for (const x of call.calldata as unknown[]) {
    try {
      const v = BigInt(x as string);
      if (v < 0n || v >= FELT_MAX) return null;
      out.push(v);
    } catch {
      return null;
    }
  }
  return out;
}

/**
 * The shape the relay sends for a cash out to another chain, besides the
 * pool's own checks (relayPolicy checkRelayCall on the apply): the apply
 * withdraws exactly amount + fee to one account and nothing anywhere else but
 * the relay's fee, adds nothing; `deploy`, when given, deploys exactly that
 * account; and that account's outside execution (caller the relay, a short
 * window) holds exactly [USDC.approve(minter, amount),
 * deposit_for_burn_with_hook(amount, a listed destination, an EVM address,
 * USDC, 0, 0 < maxFee < amount, fast or standard, Circle's forwarding hook),
 * USDC.transfer(relay, fee)] with fee at least the relay's.
 */
export function checkCctpBurn(input: { apply: Call; deploy?: string | null; outside: Call }, ctx: CctpBurnContext): CctpBurnDecision {
  const usdc = BigInt(ctx.cctp.usdc);
  const tmm = BigInt(ctx.cctp.tokenMessengerMinter);
  // The one-time account's outside execution.
  const o = input.outside;
  if (!o || typeof o.contractAddress !== "string" || o.entrypoint !== OUTSIDE_V2) return no("outside_shape");
  const cd = felts(o);
  if (!cd || cd.length < 5) return no("outside_shape");
  let oneTime: bigint;
  try {
    oneTime = BigInt(o.contractAddress);
  } catch {
    return no("outside_shape");
  }
  const [caller, , after, before, nCalls] = cd;
  if (!sameBytes32(caller!, ctx.relay)) return no("outside_caller");
  if (nCalls !== 3n) return no("outside_three_calls");
  const now = BigInt(Math.floor(ctx.now));
  if (before! <= now) return no("outside_expired");
  if (before! - now > BigInt(OUT_WINDOW_S) || after! >= before!) return no("outside_window");
  let at = 5;
  const take = (): { to: bigint; sel: bigint; args: bigint[] } | null => {
    if (cd.length < at + 3) return null;
    const [to, sel, len] = cd.slice(at, at + 3);
    const n = Number(len);
    if (!Number.isSafeInteger(n) || n < 0 || cd.length < at + 3 + n) return null;
    const args = cd.slice(at + 3, at + 3 + n);
    at += 3 + n;
    return { to: to!, sel: sel!, args };
  };
  const approve = take();
  const burn = take();
  const pay = take();
  if (!approve || !burn || !pay) return no("outside_shape");
  if (cd.length < at + 1) return no("outside_shape");
  const sigLen = cd[at]!;
  if (sigLen === 0n || sigLen > 4n || cd.length !== at + 1 + Number(sigLen)) return no("outside_signature");
  if (approve.to !== usdc || approve.sel !== SEL.approve || approve.args.length !== 3 || approve.args[0] !== tmm || approve.args[2] !== 0n) return no("approve_minter_only");
  const amount = approve.args[1]!;
  if (pay.to !== usdc || pay.sel !== SEL.transfer || pay.args.length !== 3 || !sameBytes32(pay.args[0]!, ctx.relay) || pay.args[2] !== 0n) return no("fee_to_relay_only");
  const fee = pay.args[1]!;
  if (fee < ctx.minFee || fee >= U128) return no("fee_too_low");
  // deposit_for_burn_with_hook: amount, domain, mint_recipient, burn_token, destination_caller, max_fee, min_finality, hook.
  const b = burn.args;
  if (burn.to !== tmm || burn.sel !== SEL.burn || b.length !== 11 + HOOK_FELTS.length) return no("burn_shape");
  if (b[0] !== amount || b[1] !== 0n || amount <= 0n || amount >= U128) return no("burn_amount");
  const dest = cctpDestinationByDomain(Number(b[2]));
  if (!dest || b[2]! > 0xffffffffn) return no("destination_not_listed");
  const recipient = b[3]! + (b[4]! << 128n);
  if (recipient === 0n || recipient >= 1n << 160n) return no("recipient");
  if (b[5] !== usdc) return no("not_usdc");
  if (b[6] !== 0n || b[7] !== 0n) return no("destination_caller");
  const maxFee = b[8]! + (b[9]! << 128n);
  if (maxFee === 0n || maxFee >= amount) return no("max_fee");
  const finality = Number(b[10]);
  if (finality !== CCTP_FAST && finality !== CCTP_STANDARD) return no("finality");
  if (b.slice(11).some((x, i) => x !== HOOK_FELTS[i])) return no("not_forwarding");
  // The deploy, when sent, is of this one-time account.
  if (input.deploy !== undefined && input.deploy !== null) {
    let pub: bigint;
    try {
      pub = BigInt(input.deploy);
    } catch {
      return no("deploy_key");
    }
    if (pub === 0n || BigInt(accountAddress(num.toHex(pub), ctx.accountClassHash)) !== oneTime) return no("deploy_key");
  }
  // The apply withdraws amount + fee to the one-time account, and nothing else but the relay's fee.
  const apply = felts(input.apply);
  if (!apply || input.apply.entrypoint !== "apply_actions") return no("apply_shape");
  const decoded = decodeApply(apply);
  if (!decoded) return no("apply_shape");
  let withdrawn = 0n;
  for (const a of decoded.actions) {
    const v = a.activeVariant();
    if (v === "TransferFrom") return no("adds_too");
    if (v !== "TransferTo") continue;
    const x = a.unwrap() as { to_addr: bigint | string; token: bigint | string; amount: bigint | string };
    if (BigInt(x.token) !== usdc) return no("apply_token");
    if (BigInt(x.to_addr) === oneTime) withdrawn += BigInt(x.amount);
    else if (!sameBytes32(x.to_addr, ctx.relay)) return no("apply_elsewhere");
  }
  if (withdrawn !== amount + fee) return no("withdrawn_not_burned");
  return { ok: true, oneTime: num.toHex(oneTime), amount, fee, withdrawn, domain: dest.domain, recipient: "0x" + recipient.toString(16).padStart(40, "0"), maxFee, finality };
}

// ------------------------------------------------------------------ what it costs

export type CashOutToChainCosts = {
  /** Circle's fast fee and its delivery on the destination, all of maxFee. */
  circle: bigint;
  /** Gloam's fees: on the cash out (in the proof) and on the burn. */
  gloam: bigint;
  /** What leaves the private balance. */
  spent: bigint;
  /** What arrives at the recipient. */
  arrives: bigint;
  maxFee: bigint;
};

/** A cash out of `amount` (what is burned) to `dest`: what it costs and what arrives. Null when nothing would. */
export function cashOutToChainCosts(amount: bigint, fastBps: number, forward: ForwardFee, relayFee: bigint, burnFee: bigint): CashOutToChainCosts | null {
  if (amount <= 0n) return null;
  const maxFee = outMaxFee(amount, fastBps, forward);
  if (maxFee >= amount) return null;
  return { circle: maxFee, gloam: relayFee + burnFee, spent: amount + relayFee + burnFee, arrives: amount - maxFee, maxFee };
}

// ------------------------------------------------------------------ Circle's answer about a cash out

export type IrisOutbound = { status: "pending" } | { status: "complete"; forwardState: string | null; destinationMintTxHash: string | null; destinationDomain: number };

/** Circle's view of the burn in a Starknet transaction (GET /v2/messages/25?transactionHash=): pending, or signed and how its delivery stands. */
export function irisOutboundFrom(json: unknown): IrisOutbound | null {
  const list = (json as { messages?: unknown } | null)?.messages;
  if (!Array.isArray(list) || !list.length) return null;
  const m = list[0] as { status?: unknown; forwardState?: unknown; destinationMintTxHash?: unknown; decodedMessage?: { sourceDomain?: unknown; destinationDomain?: unknown } | null };
  const src = m.decodedMessage?.sourceDomain;
  if (src !== undefined && src !== null && Number(src) !== 25) return null;
  if (m.status !== "complete") return { status: "pending" };
  const dst = Number(m.decodedMessage?.destinationDomain);
  const hash = typeof m.destinationMintTxHash === "string" && /^0x[0-9a-fA-F]+$/.test(m.destinationMintTxHash) ? m.destinationMintTxHash : null;
  return { status: "complete", forwardState: typeof m.forwardState === "string" ? m.forwardState : null, destinationMintTxHash: hash, destinationDomain: Number.isSafeInteger(dst) ? dst : -1 };
}
