/**
 * What a transaction did in Gloam's vault, read from its receipt's logs alone,
 * for partner attribution (lib/partnerAttribution, lib/partnerBackfill). Pure:
 * no RPC, no storage, so the selftest can hold it against recorded receipts.
 *
 * A transaction is one of these, or nothing:
 *   private_payment  one Transferred from the vault, and no note in or out; or a
 *                    payment in one go (lib/relay/batch): 2 to BATCH_MAX_PARTS
 *                    Transferred and nothing else, one payment in parts
 *   cash_out         one Unshielded from the vault, to an address that is not a
 *                    swap router, with no swap and no note going in; or a cash out
 *                    in one go: 2 to BATCH_MAX_PARTS Unshielded, every one to the
 *                    same address in the same asset, and nothing else
 *   private_swap     exactly one VaultSwap from a router Gloam runs on that chain,
 *                    whose note left the vault in the same transaction (Unshielded,
 *                    same nullifier) and whose new note came back in through that
 *                    router (Shielded, same commitment, from the router)
 * Anything else (a deposit, a refund, a swap's exit, two kinds of action packed
 * into one transaction, cash outs to two addresses or in two assets, logs from
 * some other contract) is refused: attribution fails closed.
 *
 * What comes out is only what the chain already shows: the kind, the spends'
 * nullifiers, and for a cash out or a swap the asset and amount that left the
 * vault and the vault's own fee on it (its WithdrawFee logs, same nullifier; 0
 * when there is none). A cash out in one go is one cash out: its parts' amounts
 * and fees added up. A cash out's receiving address comes out too, so it can be
 * matched to a partner's own address; callers never store it.
 */
import { decodeEventLog, toEventSelector, type Address, type Hex } from "viem";
import { BATCH_MAX_PARTS } from "./relay/batch";

export type ReceiptLog = { address: string; topics: readonly string[]; data: string };

export const VAULT_EVENTS = [
  {
    type: "event",
    name: "Shielded",
    inputs: [
      { name: "commitment", type: "bytes32", indexed: true },
      { name: "asset", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
      { name: "leafIndex", type: "uint256", indexed: false },
      { name: "from", type: "address", indexed: true },
    ],
  },
  {
    type: "event",
    name: "Transferred",
    inputs: [
      { name: "nullifier", type: "bytes32", indexed: true },
      { name: "newCommitments", type: "bytes32[2]", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Unshielded",
    inputs: [
      { name: "nullifier", type: "bytes32", indexed: true },
      { name: "asset", type: "address", indexed: true },
      { name: "to", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "WithdrawFee",
    inputs: [
      { name: "nullifier", type: "bytes32", indexed: true },
      { name: "asset", type: "address", indexed: true },
      { name: "fee", type: "uint256", indexed: false },
    ],
  },
] as const;

/** Every router version emits this one (GloamVaultSwap, GloamVaultSwap2). */
export const VAULT_SWAP_EVENT = {
  type: "event",
  name: "VaultSwap",
  inputs: [
    { name: "nullifier", type: "bytes32", indexed: true },
    { name: "commitment", type: "bytes32", indexed: true },
    { name: "assetIn", type: "address", indexed: true },
    { name: "assetOut", type: "address", indexed: false },
    { name: "amountIn", type: "uint256", indexed: false },
    { name: "amountOut", type: "uint256", indexed: false },
    { name: "leftover", type: "uint256", indexed: false },
  ],
} as const;

export const UNSHIELDED_TOPIC = toEventSelector(VAULT_EVENTS[2]);
export const VAULT_SWAP_TOPIC = toEventSelector(VAULT_SWAP_EVENT);
const VAULT_TOPICS = new Set<string>(VAULT_EVENTS.map((e) => toEventSelector(e)));

export type VaultTxKind = "private_payment" | "cash_out" | "private_swap";

export type VaultTxFacts =
  | {
      ok: true;
      kind: "private_payment";
      nullifier: Hex;
      /** Every spend in it, in log order: one, or a payment in one go's parts. `nullifier` is the first. */
      nullifiers: readonly Hex[];
      /** The payment's new note commitment (newCommitments[0]): chosen by the payer when it sends. The first part's in a payment in one go. */
      paymentCommitment: Hex;
    }
  | {
      ok: true;
      kind: "cash_out" | "private_swap";
      /** The spend's nullifier: what a link registration is found by (lib/partnerAttribution). The first part's in a cash out in one go. */
      nullifier: Hex;
      /** Every spend in it, in log order: one, or a cash out in one go's parts. */
      nullifiers: readonly Hex[];
      /** The asset and amount that left the vault (the notes' full amount, before the fee; every part's, added up). */
      asset: Address;
      amount: bigint;
      /** The vault's own fee on it, in the same asset (WithdrawFee, every part's); 0n when it kept none. */
      vaultFee: bigint;
      /** A cash out's receiving address (read to match a partner's own address; never stored with a record). */
      to: Address | null;
    }
  | { ok: false; reason: "not_vault" | "mixed" | "refund" | "unknown_router" };

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

type Decoded =
  | { name: "Shielded"; commitment: Hex; asset: Address; amount: bigint; from: Address }
  | { name: "Transferred"; nullifier: Hex; newCommitments: readonly [Hex, Hex] }
  | { name: "Unshielded"; nullifier: Hex; asset: Address; to: Address; amount: bigint }
  | { name: "WithdrawFee"; nullifier: Hex; asset: Address; fee: bigint };

function decodeVault(l: ReceiptLog): Decoded | null {
  if (!VAULT_TOPICS.has(l.topics[0] ?? "")) return null;
  try {
    const d = decodeEventLog({ abi: VAULT_EVENTS, topics: l.topics as [Hex, ...Hex[]], data: l.data as Hex });
    return { name: d.eventName, ...(d.args as object) } as Decoded;
  } catch {
    return null;
  }
}

function decodeSwap(l: ReceiptLog): { nullifier: Hex; commitment: Hex; assetIn: Address } | null {
  if (l.topics[0] !== VAULT_SWAP_TOPIC) return null;
  try {
    const d = decodeEventLog({ abi: [VAULT_SWAP_EVENT], topics: l.topics as [Hex, ...Hex[]], data: l.data as Hex });
    return d.args;
  } catch {
    return null;
  }
}

/**
 * Reads one receipt's logs. `pool` is the vault on the receipt's chain; `routers`
 * every swap router Gloam runs there (lib/vaultSwap swapRoutersOn), and `anyRouter`
 * every router Gloam has anywhere (EVERY_SWAP_ROUTER), so a note a router put in
 * reads as a router's, never a person's.
 */
export function classifyVaultTx(
  logs: readonly ReceiptLog[],
  ctx: { pool: string; routers: readonly string[]; anyRouter?: readonly string[] }
): VaultTxFacts {
  const routers = ctx.routers.map((r) => r.toLowerCase());
  const anyRouter = new Set([...(ctx.anyRouter ?? []), ...ctx.routers].map((r) => r.toLowerCase()));
  const vault = logs.filter((l) => same(l.address, ctx.pool)).map(decodeVault).filter((d): d is Decoded => d !== null);
  const shielded = vault.filter((d) => d.name === "Shielded");
  const transferred = vault.filter((d) => d.name === "Transferred");
  const unshielded = vault.filter((d) => d.name === "Unshielded");
  const fees = vault.filter((d) => d.name === "WithdrawFee");
  // a VaultSwap event from any address: only a known router's is believed
  const swapLogs = logs.filter((l) => l.topics[0] === VAULT_SWAP_TOPIC);
  const feeFor = (nullifier: Hex, asset: Address) =>
    fees.filter((f) => same(f.nullifier, nullifier) && same(f.asset, asset)).reduce((s, f) => s + f.fee, 0n);

  if (swapLogs.length > 0) {
    if (swapLogs.length !== 1) return { ok: false, reason: "mixed" };
    const log = swapLogs[0]!;
    if (!routers.includes(log.address.toLowerCase())) return { ok: false, reason: "unknown_router" };
    const swap = decodeSwap(log);
    if (!swap) return { ok: false, reason: "unknown_router" };
    if (transferred.length || unshielded.length !== 1 || shielded.length !== 1) return { ok: false, reason: "mixed" };
    const out = unshielded[0]!;
    const back = shielded[0]!;
    if (!same(out.nullifier, swap.nullifier) || !same(back.commitment, swap.commitment) || !same(back.from, log.address)) {
      return { ok: false, reason: "mixed" };
    }
    return {
      ok: true,
      kind: "private_swap",
      nullifier: out.nullifier,
      nullifiers: [out.nullifier],
      asset: out.asset,
      amount: out.amount,
      vaultFee: feeFor(out.nullifier, out.asset),
      to: null,
    };
  }

  // a note a router put in with no swap beside it is a refund: money coming back, not anyone's payment
  if (shielded.some((s) => anyRouter.has(s.from.toLowerCase()))) return { ok: false, reason: "refund" };
  if (vault.length === 0) return { ok: false, reason: "not_vault" };
  if (shielded.length) return { ok: false, reason: unshielded.length || transferred.length ? "mixed" : "not_vault" };

  // One cash out, or a cash out in one go: every part to the same address in the same asset.
  if (unshielded.length >= 1 && transferred.length === 0) {
    const out = unshielded[0]!;
    if (unshielded.length > BATCH_MAX_PARTS || !distinct(unshielded.map((u) => u.nullifier))) return { ok: false, reason: "mixed" };
    if (unshielded.some((u) => !same(u.to, out.to) || !same(u.asset, out.asset))) return { ok: false, reason: "mixed" };
    // a cash out never pays a router (lib/cashOutTarget refuses it); one that did is a swap's leg
    if (anyRouter.has(out.to.toLowerCase())) return { ok: false, reason: "mixed" };
    return {
      ok: true,
      kind: "cash_out",
      nullifier: out.nullifier,
      nullifiers: unshielded.map((u) => u.nullifier),
      asset: out.asset,
      amount: unshielded.reduce((s, u) => s + u.amount, 0n),
      vaultFee: unshielded.reduce((s, u) => s + feeFor(u.nullifier, out.asset), 0n),
      to: out.to,
    };
  }
  // One private payment, or a payment in one go.
  if (transferred.length >= 1 && unshielded.length === 0) {
    const t = transferred[0]!;
    if (transferred.length > BATCH_MAX_PARTS || !distinct(transferred.map((x) => x.nullifier))) return { ok: false, reason: "mixed" };
    return { ok: true, kind: "private_payment", nullifier: t.nullifier, nullifiers: transferred.map((x) => x.nullifier), paymentCommitment: t.newCommitments[0] };
  }
  return { ok: false, reason: unshielded.length || transferred.length ? "mixed" : "not_vault" };
}

/** No nullifier twice (the vault refuses a spent one anyway). */
function distinct(nullifiers: readonly Hex[]): boolean {
  return new Set(nullifiers.map((n) => n.toLowerCase())).size === nullifiers.length;
}

/** The flows a link opens, and what each may count as. */
export type LinkFlow = "pay" | "swap";
export const LINK_FLOWS: readonly LinkFlow[] = ["pay", "swap"];

export function kindFitsFlow(kind: VaultTxKind, flow: LinkFlow): boolean {
  return flow === "swap" ? kind === "private_swap" : kind === "private_payment" || kind === "cash_out";
}
