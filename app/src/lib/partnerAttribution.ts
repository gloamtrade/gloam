/**
 * Link attribution: a payment, cash out or swap opened from a partner's link,
 * counted to that partner. Server only.
 *
 * Two bindings, both made by the time the transaction is sent, so nobody can claim
 * someone else's landed transaction afterwards (a payment that reverted and is sent
 * again is a new transaction: see the relay's rule below):
 *
 *  - Relay-bound (fee-split grade). The app hands the link's code to the relay
 *    with the proof (payments and cash outs by default, swaps always).
 *    1. Once the relay's checks, dry run and holds have passed, just before the
 *       transaction goes out, the code is bound to that exact payment
 *       (bindRelaySpend): the spend's public inputs, every proof left out (spendIdOf).
 *       The first binding of a payment stands. Kept an hour; if the send then surely
 *       didn't go out, it is taken back.
 *    2. Once it is out, the code is bound to the hash of the transaction the relay
 *       sent (bindRelayTx), the payment binding is kept as long, and the
 *       transaction is counted once it lands.
 *    A cash out sent later keeps its code with its job, and the run binds it to the
 *    transaction it sends for that job (afterScheduledSend).
 *    A payment or cash out in one go (lib/relay/batch: every part in one Multicall3
 *    call) is bound the same way, as one payment: its identity is every part's. Each
 *    part's own identity is bound with it too, and a batch counts to the earliest of
 *    its own binding and its parts', so a part of a reverted batch resent alone, or a
 *    reverted payment resent inside a new batch, stays with the first link.
 *    A transaction the relay itself sent counts to the payment binding of its exact
 *    call made before its block's second, else to its hash binding, else to nobody;
 *    never to a wallet registration. A count asked for before the relay's binding
 *    exists just fails and leaves the transaction for it. Another valid proof of the
 *    same payment matches the same binding, so a reverted link payment that someone
 *    resends with another code stays with the first link; a different spend of the
 *    same note (other outputs, another root) does not, so a binding made by anyone
 *    who can prove a spend of the note (its payer, say) never takes the owner's own
 *    later spend. Payment bindings are not kept on Ethereum or Base, whose pending
 *    calldata is public: there the hash binding is the only one.
 *
 *  - Wallet-registered (attribution grade). Before the payer's wallet is asked,
 *    the app registers the spend: a hash of its nullifier, the link's code, and a
 *    hash of a value only the spender has when it sends (POST /api/partners/register):
 *    the payment's new note commitment, or the cash out's proof. The transaction
 *    counts only when that value is the one in it, and the registration came
 *    before its block's second began. Knowing a nullifier ahead of time (a payer
 *    knows the nullifier of every note it pays out) is not enough. If two codes
 *    register the same spend with the right value in time, it counts for nobody; a
 *    late registration plays no part. Registrations last an hour. Not taken on
 *    chains where pending transactions are readable before their block (Ethereum,
 *    Base), where the value could be copied.
 *
 * Counting (settleLinkTx: POST /api/partners/attribute, the relay, the scheduled run,
 * the on-chain match) reads the receipt on its chain through the relay's read-only
 * client and counts a real vault action that fits the flow. Who asks changes
 * nothing. A cash out that pays a partner's own proven address (lib/partnerAddresses)
 * is that partner's, matched on chain, whatever link it came from.
 *
 * Payments in parts (lib/payAcross, lib/cashOutAcross) count as one payment. Sent in
 * one go they are one transaction, so one count, with every part's amount and vault
 * fee added up (lib/partnerVerify). Sent part by part, each part carries the same
 * random payment tag with the code (`payment`, made by the app for that payment): the
 * first of its transactions counted is the payment, and every other is counted as a
 * later part of it (lib/partners ActivityRecord part), adding its own amount and fees
 * but never another payment or another flat fee. The tag only ever joins parts, so
 * it can lower a count, never raise one; it is kept with the bindings and in one
 * short-lived key per payment, never with a record.
 *
 * Kept: what the chain shows and nothing more (lib/partners ActivityRecord). Never
 * the payer's wallet, the address a cash out paid, a note, the caller's IP or
 * anything else. No partner and no third party is called. Nothing here ever holds
 * up a send: failures are logged and dropped.
 */
import { decodeFunctionData, encodeAbiParameters, isAddress, keccak256, parseAbiParameters, toFunctionSelector, type Hex } from "viem";
import { ApiError } from "./partnersApi";
import { attributedTo, claimTransaction, getPartner, recordActivity, type ActivityRecord } from "./partners";
import { resolveLinkCode } from "./partnerLinks";
import { isBytes32, isLinkCodeShape, linkBindHash, linkNullifierHash, proofBindValue, PUBLIC_MEMPOOL_CHAINS } from "./partnerCode";
import { BATCH_MAX_PARTS, BATCH_MIN_PARTS, batchesOn, MULTICALL3, multicall3Abi } from "./relay/batch";
import { classifyVaultTx, kindFitsFlow, LINK_FLOWS, type LinkFlow, type ReceiptLog, type VaultTxFacts } from "./partnerVerify";
import { jsonOf, k, kv, kv1, type KvCommand } from "./partnersKv";
import { addressOwner } from "./partnerAddresses";
import { networkForChain, relayerAccounts, relayPoolAbi, relayPublicClient } from "./relay/server";
import { EVERY_SWAP_ROUTER, swapRoutersOn, vaultSwapAbi, vaultSwapV3Abi } from "./vaultSwap";
import { GLOAM_RELAYERS } from "./contractDirectory";
import { logSafe } from "./logSafe";
import type { GloamNetwork } from "./networks";

/** A wallet registration is kept this long: it only has to outlast the wallet's prompt and the block. */
export const REGISTRATION_TTL_SEC = 3600;
/** A relay binding is kept this long, so a later count (the app, the on-chain match) still finds it. */
export const RELAY_BINDING_TTL_SEC = 7 * 86_400;
/** A payment binding the relay made just before a send is kept this long, until the send is out and bound by its hash. */
export const RELAY_PENDING_TTL_SEC = 3600;
/** A cash out scheduled for later keeps its code this long: a dated one goes out up to 90 days ahead. */
export const JOB_CODE_TTL_SEC = 100 * 86_400;
/** A transaction can be counted to a link this long after it lands. */
export const ATTRIBUTION_WINDOW_SEC = 7 * 86_400;
/** A payment in parts keeps which transaction counted it this long: its parts land together, and each can be counted for a week. */
export const PAYMENT_PARTS_TTL_SEC = 14 * 86_400;

/** The claim a transaction gets when two codes registered it: it counts for nobody. */
const NOBODY = { id: "conflict" };

export type Registration = {
  partnerId: string;
  code: string;
  flow: LinkFlow;
  /** ms: when the server took it. */
  at: number;
  /** linkBindHash of the value only the spender had when it sent. */
  bind: Hex;
  /** The payment in parts this spend is a part of (the app's random tag), if it is one. */
  payment?: Hex;
};

export type RelayBinding = {
  partnerId: string;
  code: string;
  flow: LinkFlow;
  at: number;
  /** The payment in parts this send is (a part of), if it is one (the app's random tag). */
  payment?: Hex;
};

/** A payment tag as sent (32 bytes), lowercase; undefined for anything else, so a bad one just counts as no tag. */
export function paymentTagOf(raw: unknown): Hex | undefined {
  return isBytes32(raw) ? (raw.toLowerCase() as Hex) : undefined;
}

/** The relay's signing accounts: a transaction from one of these is counted from relay bindings only. */
export function relaySigners(): string[] {
  return [...relayerAccounts().map((a) => a.address), ...GLOAM_RELAYERS].map((a) => a.toLowerCase());
}

const spendKey = (chainId: number, id: Hex) => k("relayspend", chainId, id.toLowerCase());
/** Marks that some payment of a note was bound, so the on-chain match knows a cash out of it may be a link's. */
const spendSeenKey = (chainId: number, nullifier: Hex) => k("relayspendnf", chainId, linkNullifierHash(nullifier).toLowerCase());

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
type SpendTuple = { root: Hex; nullifier: Hex; asset: Hex; amount: bigint };
type NoteTuple = { commitment: Hex; asset: Hex; amount: bigint };

/**
 * A spend's identity (spendIdOf): `nullifiers` names every note it spends, `nullifier` the first.
 * A payment or cash out in one go also names `parts`: each part's own identity, as if sent alone.
 */
export type SpendId = { id: Hex; nullifier: Hex; nullifiers: readonly Hex[]; parts?: readonly Hex[] };

/** One transfer or cash out on the vault, as its identity names it (spendIdOf); null for any other call. */
function vaultSpendIdOf(chain: bigint, pool: Hex, input: Hex): { id: Hex; nullifier: Hex; fn: "transfer" | "unshield" } | null {
  const call = decodeFunctionData({ abi: relayPoolAbi, data: input });
  if (call.functionName === "transfer") {
    const [, root, nullifier, out] = call.args as readonly [Hex, Hex, Hex, readonly [Hex, Hex]];
    const id = keccak256(
      encodeAbiParameters(parseAbiParameters("string, uint256, address, bytes32, bytes32, bytes32, bytes32"), ["transfer", chain, pool, root, nullifier, out[0], out[1]])
    );
    return { id, nullifier, fn: "transfer" };
  }
  if (call.functionName === "unshield") {
    const [, root, nullifier, asset, recipient, amount] = call.args as readonly [Hex, Hex, Hex, Hex, Hex, bigint];
    const id = keccak256(
      encodeAbiParameters(parseAbiParameters("string, uint256, address, bytes32, bytes32, address, address, uint256"), ["unshield", chain, pool, root, nullifier, asset, recipient, amount])
    );
    return { id, nullifier, fn: "unshield" };
  }
  return null;
}

const POST_MEMO_SELECTOR = toFunctionSelector("postMemo(bytes32,bytes)");

/**
 * A payment or cash out in one go (lib/relay/batch), as the relay sends it: one
 * aggregate3 call to Multicall3 whose calls are BATCH_MIN_PARTS to BATCH_MAX_PARTS
 * of this vault's transfers (each may have its payment message to this network's
 * memo board after it) or of its cash outs, never both, none allowed to fail. Its
 * identity is its parts' own identities, in order, each as if sent alone; a
 * message is no part of what was paid. Null for any other call, and on a network
 * where the relay doesn't send in one go.
 */
function batchSpendIdOf(net: GloamNetwork, input: Hex): SpendId | null {
  if (!batchesOn(net.chainId)) return null;
  const call = decodeFunctionData({ abi: multicall3Abi, data: input });
  if (call.functionName !== "aggregate3") return null;
  const pool = net.pool!.toLowerCase() as Hex;
  const board = net.payMemo?.address.toLowerCase() ?? null;
  const chain = BigInt(net.chainId);
  const parts: { id: Hex; nullifier: Hex; fn: "transfer" | "unshield" }[] = [];
  let messages = 0;
  for (const c of call.args[0]) {
    if (c.allowFailure !== false) return null;
    const target = c.target.toLowerCase();
    if (target === pool) {
      const part = vaultSpendIdOf(chain, pool, c.callData);
      if (!part) return null;
      parts.push(part);
    } else if (board && target === board && c.callData.slice(0, 10).toLowerCase() === POST_MEMO_SELECTOR) {
      messages++;
    } else {
      return null;
    }
  }
  if (parts.length < BATCH_MIN_PARTS || parts.length > BATCH_MAX_PARTS) return null;
  const fn = parts[0]!.fn;
  // one kind of spend; a message only with payments
  if (parts.some((p) => p.fn !== fn) || (messages > 0 && fn !== "transfer")) return null;
  const id = keccak256(
    encodeAbiParameters(parseAbiParameters("string, uint256, address, address, string, bytes32[]"), [
      "batch",
      chain,
      MULTICALL3,
      pool,
      fn,
      parts.map((p) => p.id),
    ])
  );
  return { id, nullifier: parts[0]!.nullifier, nullifiers: parts.map((p) => p.nullifier), parts: parts.map((p) => p.id) };
}

/**
 * A payment's identity, for a relay binding: the chain, the contract called, and
 * the call's public inputs with every proof left out. A transfer: root, nullifier
 * and both new commitments. A cash out: root, nullifier, asset, recipient and
 * amount. A swap: the spend (root, nullifier, asset, amount), the new and refund
 * notes (commitment, asset, amount), the route, and on newer routers the exit key
 * and deadline. A payment or cash out in one go: every part's identity, in order
 * (batchSpendIdOf). Another valid proof of the same payment has the same identity;
 * a different spend of the same note does not. Null for any other call.
 */
export function spendIdOf(net: GloamNetwork, tx: { to: string | null; input: Hex }): SpendId | null {
  if (!tx.to || !net.pool) return null;
  const to = tx.to.toLowerCase() as Hex;
  const chain = BigInt(net.chainId);
  try {
    if (to === net.pool.toLowerCase()) {
      const one = vaultSpendIdOf(chain, to, tx.input);
      return one ? { id: one.id, nullifier: one.nullifier, nullifiers: [one.nullifier] } : null;
    }
    if (to === MULTICALL3.toLowerCase()) return batchSpendIdOf(net, tx.input);
    if (!swapRoutersOn(net.chainId).some((r) => r.address.toLowerCase() === to)) return null;
    for (const abi of [vaultSwapAbi, vaultSwapV3Abi] as const) {
      let args: readonly unknown[];
      try {
        const call = decodeFunctionData({ abi, data: tx.input });
        if (call.functionName !== "swap") continue;
        args = call.args as readonly unknown[];
      } catch {
        continue; // the other version
      }
      const [sp, d, r, route, exitKey, deadline] = args as readonly [SpendTuple, NoteTuple, NoteTuple, Hex, Hex | undefined, bigint | undefined];
      const id = keccak256(
        encodeAbiParameters(
          parseAbiParameters("string, uint256, address, bytes32, bytes32, address, uint256, bytes32, address, uint256, bytes32, address, uint256, bytes, address, uint256"),
          ["swap", chain, to, sp.root, sp.nullifier, sp.asset, sp.amount, d.commitment, d.asset, d.amount, r.commitment, r.asset, r.amount, route, exitKey ?? ZERO_ADDRESS, deadline ?? 0n]
        )
      );
      return { id, nullifier: sp.nullifier, nullifiers: [sp.nullifier] };
    }
  } catch {
    /* not a call we know */
  }
  return null;
}

/**
 * A payment binding this relay request made, so it can be kept once sent or taken back if the
 * send didn't go out. `seen`: one key per note it spends. `parts`: for a payment or cash out in
 * one go, each part's own binding, and whether this request wrote it.
 */
export type BoundSpend = { key: string; seen: string[]; value: string; wrote: boolean; parts?: { key: string; wrote: boolean }[] };

/**
 * Called by the relay route from the relay's beforeBroadcast hook, with the call
 * about to go out: the request passed the relay's checks, its dry run and its
 * holds. Binds the code to that exact payment (spendIdOf); the first binding of a
 * payment stands. Kept an hour (RELAY_PENDING_TTL_SEC); once the send is out,
 * afterRelaySend keeps it as long as the hash binding, and if the send surely
 * didn't go out, unbindRelaySpend takes it back. Only a transaction the relay
 * itself sends is ever counted from it (settleLinkTx). Not kept on chains whose
 * public mempool shows a pending transaction's calldata. `payment`: the app's tag
 * when this send is (a part of) a payment in parts.
 *
 * A payment or cash out in one go also binds each part's own identity, first binding
 * standing as ever: if the batch reverts, its parts' proofs are public, and one of them
 * relayed again alone with another code would otherwise be a payment nobody bound.
 */
export async function bindRelaySpend(args: {
  net: GloamNetwork;
  tx: { to: string; data: Hex };
  code: unknown;
  flow: LinkFlow;
  at: number;
  payment?: unknown;
}): Promise<BoundSpend | null> {
  if (!isLinkCodeShape(args.code) || PUBLIC_MEMPOOL_CHAINS.includes(args.net.chainId)) return null;
  const spend = spendIdOf(args.net, { to: args.tx.to, input: args.tx.data });
  if (!spend) return null;
  const resolved = await resolveLinkCode(args.code, args.at);
  if (!resolved) return null;
  const key = spendKey(args.net.chainId, spend.id);
  const seen = spend.nullifiers.map((n) => spendSeenKey(args.net.chainId, n));
  const payment = paymentTagOf(args.payment);
  const value = JSON.stringify({
    partnerId: resolved.partner.id,
    code: resolved.code.code,
    flow: args.flow,
    at: args.at,
    ...(payment ? { payment } : {}),
  } satisfies RelayBinding);
  const partKeys = (spend.parts ?? []).map((id) => spendKey(args.net.chainId, id));
  const [set, ...rest] = await kv([
    ["SET", key, value, "NX", "EX", RELAY_PENDING_TTL_SEC],
    ...partKeys.map((p): KvCommand => ["SET", p, value, "NX", "EX", RELAY_PENDING_TTL_SEC]),
    ...seen.map((s): KvCommand => ["SET", s, "1", "NX", "EX", RELAY_PENDING_TTL_SEC]),
  ]);
  return {
    key,
    seen,
    value,
    wrote: set === "OK",
    ...(partKeys.length ? { parts: partKeys.map((p, i) => ({ key: p, wrote: rest[i] === "OK" })) } : {}),
  };
}

/** Takes back a payment binding this request made (and its parts' it wrote), when its send surely didn't go out. Never throws. */
export async function unbindRelaySpend(b: BoundSpend | null): Promise<void> {
  try {
    if (!b) return;
    const mine = [...(b.wrote ? [b.key] : []), ...(b.parts ?? []).filter((p) => p.wrote).map((p) => p.key)];
    for (const key of mine) {
      if ((await kv1(["GET", key])) === b.value) await kv1(["DEL", key]);
    }
  } catch (e) {
    console.error("gloam_partner_unbind", logSafe(e));
  }
}

function isRelayBinding(b: RelayBinding | null): b is RelayBinding {
  return (
    !!b &&
    typeof b.partnerId === "string" &&
    typeof b.code === "string" &&
    typeof b.at === "number" &&
    LINK_FLOWS.includes(b.flow) &&
    (b.payment === undefined || isBytes32(b.payment))
  );
}

/** The same notes spent, whatever the order. */
function sameSpends(a: readonly Hex[], b: readonly Hex[]): boolean {
  if (a.length !== b.length) return false;
  const x = a.map((n) => n.toLowerCase()).sort();
  const y = b.map((n) => n.toLowerCase()).sort();
  return x.every((n, i) => n === y[i]);
}

/**
 * The binding of this exact payment made before `beforeMs`, if any: the call must spend exactly
 * the notes the vault logged. For a payment or cash out in one go, the earliest of its own
 * binding and each part's: a part bound first, sent alone before and reverted, keeps its link
 * when someone puts it in a new batch (a fresh identity) with another code.
 */
async function paymentBinding(net: GloamNetwork, t: { to: string | null; input: Hex }, nullifiers: readonly Hex[], beforeMs: number): Promise<RelayBinding | null> {
  if (PUBLIC_MEMPOOL_CHAINS.includes(net.chainId)) return null;
  const spend = spendIdOf(net, t);
  if (!spend || !sameSpends(spend.nullifiers, nullifiers)) return null;
  const raw = await kv([spend.id, ...(spend.parts ?? [])].map((id): KvCommand => ["GET", spendKey(net.chainId, id)]));
  let first: { b: RelayBinding; own: boolean } | null = null;
  for (const r of raw) {
    const b = jsonOf<RelayBinding>(r);
    if (!isRelayBinding(b) || b.at >= beforeMs) continue;
    // a part bound by the batch's own request holds the very same value as the batch
    const own = r === raw[0];
    // the earliest; in the same millisecond, a part binding another send made beats the
    // batch's own, since the batch's request found that part already taken
    if (!first || b.at < first.b.at || (b.at === first.b.at && first.own && !own)) first = { b, own };
  }
  return first?.b ?? null;
}

/**
 * Registers a wallet send under a live code, before the wallet is asked. One code
 * per spend at a time (the same code again keeps its first registration); a second
 * code is kept too, and makes the spend count for nobody if both match it.
 */
export async function registerLink(args: {
  chainId: number;
  nullifierHash: Hex;
  bindHash: Hex;
  code: string;
  flow: LinkFlow;
  at?: number;
  /** The payment in parts this spend is a part of (the app's random tag). */
  payment?: Hex;
}): Promise<{ registered: boolean; reason?: "code_not_live" | "public_mempool" | "relay_only" }> {
  const at = args.at ?? Date.now();
  if (PUBLIC_MEMPOOL_CHAINS.includes(args.chainId)) return { registered: false, reason: "public_mempool" };
  // a swap only ever goes through the relay, which binds it itself
  if (args.flow !== "pay") return { registered: false, reason: "relay_only" };
  const resolved = await resolveLinkCode(args.code, at);
  if (!resolved) return { registered: false, reason: "code_not_live" };
  const key = k("reg", args.chainId, args.nullifierHash.toLowerCase());
  const payment = paymentTagOf(args.payment);
  const reg: Registration = {
    partnerId: resolved.partner.id,
    code: resolved.code.code,
    flow: args.flow,
    at,
    bind: args.bindHash.toLowerCase() as Hex,
    ...(payment ? { payment } : {}),
  };
  await kv([
    ["HSETNX", key, `${reg.code}|${reg.bind}`, JSON.stringify(reg)],
    ["EXPIRE", key, REGISTRATION_TTL_SEC],
  ]);
  return { registered: true };
}

export async function registrationsOf(chainId: number, nullifier: Hex): Promise<Registration[]> {
  const raw = await kv1(["HGETALL", k("reg", chainId, linkNullifierHash(nullifier).toLowerCase())]);
  const out: Registration[] = [];
  if (Array.isArray(raw)) for (let i = 1; i < raw.length; i += 2) {
    const r = jsonOf<Registration>(raw[i]);
    if (r) out.push(r);
  }
  return out;
}

/** The relay binds a link's code to the transaction it sent. Authoritative for that transaction. */
export async function bindRelayTx(args: { chainId: number; txHash: Hex; code: string; flow: LinkFlow; at: number; payment?: unknown }): Promise<boolean> {
  const resolved = await resolveLinkCode(args.code, args.at);
  if (!resolved) return false;
  const payment = paymentTagOf(args.payment);
  const b: RelayBinding = { partnerId: resolved.partner.id, code: resolved.code.code, flow: args.flow, at: args.at, ...(payment ? { payment } : {}) };
  await kv1(["SET", k("relaytx", args.chainId, args.txHash.toLowerCase()), JSON.stringify(b), "EX", RELAY_BINDING_TTL_SEC]);
  return true;
}

export async function relayBindingOf(chainId: number, txHash: string): Promise<RelayBinding | null> {
  return jsonOf<RelayBinding>(await kv1(["GET", k("relaytx", chainId, txHash.toLowerCase())]));
}

export type AttributionReceipt = {
  status: "success" | "reverted";
  blockNumber: bigint;
  logs: readonly ReceiptLog[];
};

export type AttributionDeps = {
  /** The receipt on that chain, or null when it is not there (yet). */
  receipt: (net: GloamNetwork, hash: Hex) => Promise<AttributionReceipt | null>;
  /** The block's time, seconds. */
  blockTime: (net: GloamNetwork, block: bigint) => Promise<number>;
  /** The transaction's sender, target and calldata; null when not read. */
  tx: (net: GloamNetwork, hash: Hex) => Promise<{ from: string; to: string | null; input: Hex } | null>;
  /** The relay's signing accounts, lowercase. */
  relaySigners: () => string[];
  record: typeof recordActivity;
  now: () => number;
};

export const attributionDeps: AttributionDeps = {
  receipt: async (net, hash) => {
    const r = await relayPublicClient(net)
      .getTransactionReceipt({ hash })
      .catch(() => null);
    return r ? { status: r.status, blockNumber: r.blockNumber, logs: r.logs } : null;
  },
  blockTime: async (net, block) => Number((await relayPublicClient(net).getBlock({ blockNumber: block })).timestamp),
  tx: async (net, hash) => {
    const t = await relayPublicClient(net)
      .getTransaction({ hash })
      .catch(() => null);
    return t ? { from: t.from, to: t.to ?? null, input: t.input } : null;
  },
  relaySigners,
  record: recordActivity,
  now: () => Date.now(),
};

export type SettleInput = { chainId: number; txHash: Hex };

/** The settle request's body, checked to the letter, or a 400. Extra fields are refused, not ignored. */
export function readSettleInput(body: Record<string, unknown>): SettleInput {
  if (Object.keys(body).some((key) => key !== "chainId" && key !== "txHash")) {
    throw new ApiError(400, "bad_request", "Send only { chainId, txHash }.");
  }
  if (typeof body.chainId !== "number" || !Number.isSafeInteger(body.chainId) || body.chainId <= 0) {
    throw new ApiError(400, "bad_chain", "chainId must be a chain id number.");
  }
  if (!isBytes32(body.txHash)) throw new ApiError(400, "bad_tx", "txHash must be a 32-byte transaction hash.");
  return { chainId: body.chainId, txHash: body.txHash.toLowerCase() as Hex };
}

export type RegisterInput = { chainId: number; nullifierHash: Hex; bindHash: Hex; code: string; flow: LinkFlow; payment?: Hex };

/** The registration request's body, to the letter, or a 400. `payment` (a part of a payment in parts) may be left out. */
export function readRegisterInput(body: Record<string, unknown>): RegisterInput {
  if (Object.keys(body).some((key) => !["chainId", "nullifierHash", "bindHash", "code", "flow", "payment"].includes(key))) {
    throw new ApiError(400, "bad_request", "Send only { chainId, nullifierHash, bindHash, code, flow, payment? }.");
  }
  if (typeof body.chainId !== "number" || !Number.isSafeInteger(body.chainId) || body.chainId <= 0) {
    throw new ApiError(400, "bad_chain", "chainId must be a chain id number.");
  }
  if (!isBytes32(body.nullifierHash)) throw new ApiError(400, "bad_hash", "nullifierHash must be 32 bytes.");
  if (!isBytes32(body.bindHash)) throw new ApiError(400, "bad_hash", "bindHash must be 32 bytes.");
  if (!isLinkCodeShape(body.code)) throw new ApiError(400, "bad_code", "That is not a partner link code.");
  if (typeof body.flow !== "string" || !LINK_FLOWS.includes(body.flow as LinkFlow)) {
    throw new ApiError(400, "bad_flow", 'flow must be "pay" or "swap".');
  }
  if (body.payment !== undefined && !isBytes32(body.payment)) throw new ApiError(400, "bad_hash", "payment must be 32 bytes.");
  return {
    chainId: body.chainId,
    nullifierHash: body.nullifierHash.toLowerCase() as Hex,
    bindHash: body.bindHash.toLowerCase() as Hex,
    code: body.code,
    flow: body.flow as LinkFlow,
    ...(body.payment !== undefined ? { payment: (body.payment as Hex).toLowerCase() as Hex } : {}),
  };
}

function netFor(chainId: number): GloamNetwork {
  try {
    return networkForChain(chainId);
  } catch {
    throw new ApiError(400, "bad_chain", "Gloam does not run a vault on that chain.");
  }
}

export function classify(net: GloamNetwork, logs: readonly ReceiptLog[]): VaultTxFacts {
  return classifyVaultTx(logs, { pool: net.pool!, routers: swapRoutersOn(net.chainId).map((r) => r.address), anyRouter: EVERY_SWAP_ROUTER });
}

/**
 * The value a wallet send's registration has to name, read from the transaction:
 * a private payment's new note commitment (from its log), a cash out's proof (from
 * the call, made straight to the vault). null when it can't be read: then a wallet
 * registration can't match. Never for several spends in one transaction: the app
 * sends those through the relay only, and a registration names one spend.
 */
function bindOf(net: GloamNetwork, t: { to: string | null; input: Hex }, facts: Extract<VaultTxFacts, { ok: true }>): Hex | null {
  if (facts.nullifiers.length !== 1) return null;
  if (facts.kind === "private_payment") return linkBindHash(facts.paymentCommitment);
  if (facts.kind !== "cash_out") return null;
  if (!t.to || t.to.toLowerCase() !== net.pool!.toLowerCase()) return null;
  try {
    const call = decodeFunctionData({ abi: relayPoolAbi, data: t.input });
    // the call must be this very spend: its nullifier is the one the vault logged
    if (call.functionName !== "unshield" || String(call.args[2]).toLowerCase() !== facts.nullifier.toLowerCase()) return null;
    return linkBindHash(proofBindValue(call.args[0] as Hex));
  } catch {
    return null;
  }
}

/**
 * Counts one landed transaction to the link it was bound to, or throws an ApiError
 * saying why not. A cash out to a partner's own proven address goes to that
 * partner instead, as matched on chain.
 */
export async function settleLinkTx(
  input: SettleInput,
  deps: AttributionDeps = attributionDeps
): Promise<{ kind: ActivityRecord["kind"]; record: ActivityRecord }> {
  const net = netFor(input.chainId);
  // counted already (to anyone, or to nobody): no chain read
  if (await attributedTo(net.chainId, input.txHash)) throw new ApiError(409, "already_attributed", "That transaction is already counted.");

  const receipt = await deps.receipt(net, input.txHash);
  if (!receipt) throw new ApiError(404, "tx_not_found", `No confirmed transaction with that hash on ${net.label} yet.`);
  if (receipt.status !== "success") throw new ApiError(422, "tx_failed", "That transaction failed on chain.");
  const facts = classify(net, receipt.logs);
  if (!facts.ok) throw new ApiError(422, "not_vault_action", "That transaction is not a payment, cash out or swap in Gloam's vault.");
  const ts = await deps.blockTime(net, receipt.blockNumber);
  if (!Number.isFinite(ts) || ts <= 0) throw new ApiError(502, "rpc", "Could not read the block. Try again.");
  if (Math.floor(deps.now() / 1000) - ts > ATTRIBUTION_WINDOW_SEC) {
    throw new ApiError(422, "too_old", "Link payments can be counted for seven days after they land.");
  }

  const t = await deps.tx(net, input.txHash);
  if (!t) throw new ApiError(502, "rpc", "Could not read the transaction. Try again.");
  let bound: { partnerId: string; code: string; flow: LinkFlow; payment?: Hex; by: "relay" | "wallet" } | null = null;
  if (deps.relaySigners().includes(t.from.toLowerCase())) {
    // 1. Sent by the relay: its own bindings only, never a wallet registration. The binding of this
    // exact payment (its public inputs) made before its block's second wins; the binding of this very
    // transaction's hash only when there is none. So a reverted link payment that someone resends with
    // another code stays with the first link, and a different spend of the same note is never taken.
    const relay = (await paymentBinding(net, t, facts.nullifiers, ts * 1000)) ?? (await relayBindingOf(net.chainId, input.txHash));
    if (relay) bound = { ...relay, by: "relay" };
  } else if (!PUBLIC_MEMPOOL_CHAINS.includes(net.chainId)) {
    // 2. From a wallet: registrations of this spend that name the value only its spender had, made
    // before its block's second began. A later one plays no part, in a conflict or otherwise.
    const want = bindOf(net, t, facts);
    const regs = want ? (await registrationsOf(net.chainId, facts.nullifier)).filter((r) => r.bind === want && r.at < ts * 1000) : [];
    const codes = new Set(regs.map((r) => r.code));
    if (codes.size > 1) {
      // two links registered the same spend: it counts for nobody, now or later
      await claimTransaction(NOBODY, net.chainId, input.txHash);
      throw new ApiError(409, "conflicting_codes", "Two links registered that transaction, so it counts for neither.");
    }
    if (regs[0]) bound = { ...regs[0], by: "wallet" };
  }
  if (!bound) throw new ApiError(404, "not_registered", "That transaction did not come from a partner's link.");
  if (!kindFitsFlow(facts.kind, bound.flow)) {
    throw new ApiError(422, "wrong_flow", bound.flow === "swap" ? "A swap link counts private swaps only." : "A pay link counts payments and cash outs only.");
  }

  const edge = facts.kind === "private_payment" ? null : { asset: facts.asset, amount: facts.amount };
  if (edge && !isAddress(edge.asset)) throw new ApiError(422, "not_vault_action", "That transaction is not a payment, cash out or swap in Gloam's vault.");
  // a cash out to a partner's own proven address is theirs, whichever link it came from
  const owner = facts.kind === "cash_out" && facts.to ? await addressOwner(net.chainId, facts.to) : null;
  const ownerPartner = owner ? await getPartner(owner) : null;
  const partner = ownerPartner ?? (await getPartner(bound.partnerId));
  if (!partner) throw new ApiError(404, "not_registered", "The partner behind that link is gone.");
  // part of a payment in parts: counted as the payment once, every other part adds only its amount and fees
  const tag = paymentTagOf(bound.payment);
  const part = tag ? await laterPart(net.chainId, partner.id, tag, input.txHash) : false;
  const r = await deps.record({
    partner,
    keyId: null,
    source: ownerPartner ? "chain" : "link",
    linkCode: ownerPartner ? null : bound.code,
    linkBind: ownerPartner ? null : bound.by,
    network: net,
    kind: facts.kind,
    txHash: input.txHash,
    edge,
    vaultFee: facts.kind === "private_payment" ? 0n : facts.vaultFee,
    // the day it landed, which for a cash out sent later is not the day it was reported
    now: ts * 1000,
    ...(part ? { part: true } : {}),
  });
  if (!r.recorded) throw new ApiError(409, "already_attributed", "That transaction is already counted.");
  return { kind: facts.kind, record: r.record };
}

/**
 * Whether this transaction is a later part of a payment in parts already counted. The
 * first of the payment's transactions to be counted holds its place (by its hash, so
 * two counts of that same transaction at once both see it as the payment, and the
 * claim keeps one); every other transaction of it is a later part. Per partner and chain.
 */
async function laterPart(chainId: number, partnerId: string, payment: Hex, txHash: Hex): Promise<boolean> {
  const key = k("linkpay", chainId, partnerId, payment.toLowerCase());
  const tx = txHash.toLowerCase();
  const [, held] = await kv([
    ["SET", key, tx, "NX", "EX", PAYMENT_PARTS_TTL_SEC],
    ["GET", key],
  ]);
  return typeof held === "string" && held !== tx;
}

/** The flow a relay action belongs to; null for anything a link doesn't count (a memo, a refund, an exit). */
export function relayFlowOf(body: Record<string, unknown>): LinkFlow | null {
  // a payment or a cash out in one go is a payment or a cash out (lib/relay/batch)
  if (body.action === "transfer" || body.action === "unshield" || body.action === "transferBatch" || body.action === "unshieldBatch") return "pay";
  if (body.action === "swap" && body.unshieldTx === undefined) return "swap";
  return null;
}

/** How long the relay's after-send step waits for the receipt before leaving the count to a later settle. */
const AFTER_SEND_WAIT_MS = 40_000;

/**
 * After the relay sent a transaction from a partner's link: binds the code to that
 * transaction's hash (the relay's own), keeps the spend's bindings as long, then
 * waits for the receipt and counts it. Runs after the response (next/server after),
 * never throws; a miss is counted later by the app's own count call, or for a cash
 * out by the on-chain match, which find the same bindings.
 */
export async function afterRelaySend(args: {
  net: GloamNetwork;
  hash: Hex;
  code: unknown;
  flow: LinkFlow | null;
  at: number;
  /** The payment binding started just before the send (bindRelaySpend), finished here first and kept as long as the hash binding. */
  bound?: Promise<BoundSpend | null>;
  /** The app's tag when this send is (a part of) a payment in parts. */
  payment?: unknown;
  wait?: (net: GloamNetwork, hash: Hex) => Promise<void>;
  deps?: AttributionDeps;
}): Promise<void> {
  try {
    const spend = (await args.bound?.catch(() => null)) ?? null;
    if (!args.flow || !isLinkCodeShape(args.code)) return;
    if (!(await bindRelayTx({ chainId: args.net.chainId, txHash: args.hash, code: args.code, flow: args.flow, at: args.at, payment: args.payment }))) return;
    // the send is out: its payment binding is no longer pending
    if (spend) {
      await kv([
        ["EXPIRE", spend.key, RELAY_BINDING_TTL_SEC],
        ...(spend.parts ?? []).map((p): KvCommand => ["EXPIRE", p.key, RELAY_BINDING_TTL_SEC]),
        ...spend.seen.map((s): KvCommand => ["EXPIRE", s, RELAY_BINDING_TTL_SEC]),
      ]);
    }
    const wait =
      args.wait ??
      (async (net: GloamNetwork, hash: Hex) => {
        await relayPublicClient(net).waitForTransactionReceipt({ hash, timeout: AFTER_SEND_WAIT_MS, pollingInterval: 1_500 });
      });
    // not landed in time (or never): the binding stays, and a later count finds it
    if (!(await wait(args.net, args.hash).then(() => true).catch(() => false))) return;
    await settleLinkTx({ chainId: args.net.chainId, txHash: args.hash.toLowerCase() as Hex }, args.deps);
  } catch (e) {
    if (e instanceof ApiError && ["already_attributed", "not_registered", "not_vault_action", "wrong_flow", "tx_failed"].includes(e.code)) return;
    console.error("gloam_partner_after_send", logSafe(e));
  }
}

/**
 * A cash out scheduled for later from a partner's link: its code waits with the job
 * (the job passed the relay's checks and dry run), and counts only for the
 * transaction the run sends for that job (afterScheduledSend), never for another
 * spend of the same note.
 */
export async function bindScheduledJob(args: { jobId: string; code: unknown; at: number }): Promise<void> {
  try {
    if (!isLinkCodeShape(args.code) || !(await resolveLinkCode(args.code, args.at))) return;
    await kv1(["SET", k("jobcode", args.jobId), JSON.stringify({ code: args.code, at: args.at }), "EX", JOB_CODE_TTL_SEC]);
  } catch (e) {
    console.error("gloam_partner_bind_scheduled", logSafe(e));
  }
}

type JobCode = { code: string; at: number };

/**
 * After the scheduled run sent a job: binds its code (if any) to the relay's transaction and counts it.
 * `code` is the job's code when the caller already read it (afterScheduledSends).
 */
export async function afterScheduledSend(args: { net: GloamNetwork; jobId: string; hash: Hex; deps?: AttributionDeps; code?: JobCode }): Promise<void> {
  try {
    const j = args.code ?? jsonOf<JobCode>(await kv1(["GET", k("jobcode", args.jobId)]));
    if (!j) return;
    if (!(await bindRelayTx({ chainId: args.net.chainId, txHash: args.hash, code: j.code, flow: "pay", at: j.at }))) return;
    await settleLinkTx({ chainId: args.net.chainId, txHash: args.hash.toLowerCase() as Hex }, args.deps);
  } catch (e) {
    if (e instanceof ApiError && ["already_attributed", "not_registered", "tx_not_found", "tx_failed"].includes(e.code)) return;
    console.error("gloam_partner_settle_scheduled", logSafe(e));
  }
}

/** Jobs bound and counted at once by afterScheduledSends: each reads the chain a few times. */
export const SCHEDULED_SETTLE_BATCH = 4;

/**
 * afterScheduledSend for every job one scheduled run sent. Their codes are read
 * in one round trip; most jobs have none and cost nothing more. A job with one is
 * read (`readJob`: its network and the hash the run sent; null skips it), bound
 * and counted, SCHEDULED_SETTLE_BATCH at a time. Each settle stays idempotent on
 * its own: a transaction is counted once, by its claim, so a job that two
 * overlapping runs both report counts once. Never throws.
 */
export async function afterScheduledSends(
  jobIds: readonly string[],
  readJob: (jobId: string) => Promise<{ net: GloamNetwork; hash: Hex } | null>,
  deps?: AttributionDeps,
): Promise<void> {
  const ids = [...new Set(jobIds)];
  if (!ids.length) return;
  let raw: unknown[];
  try {
    raw = await kv(ids.map((id) => ["GET", k("jobcode", id)]));
  } catch (e) {
    console.error("gloam_partner_settle_scheduled", logSafe(e));
    return;
  }
  const coded = ids.flatMap((jobId, i) => {
    const code = jsonOf<JobCode>(raw[i]);
    return code ? [{ jobId, code }] : [];
  });
  for (let i = 0; i < coded.length; i += SCHEDULED_SETTLE_BATCH) {
    await Promise.all(
      coded.slice(i, i + SCHEDULED_SETTLE_BATCH).map(async ({ jobId, code }) => {
        const job = await readJob(jobId).catch(() => null);
        if (job) await afterScheduledSend({ net: job.net, jobId, hash: job.hash, deps, code });
      }),
    );
  }
}
