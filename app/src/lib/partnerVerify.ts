/**
 * What a transaction did in Gloam's vault, read from its receipt's logs alone,
 * for partner attribution (lib/partnerAttribution, lib/partnerBackfill). Pure:
 * no RPC, no storage, so the selftest can hold it against recorded receipts.
 *
 * A transaction is one of these, or nothing:
 *   private_payment  exactly one Transferred from the vault, and no note in or out
 *   cash_out         exactly one Unshielded from the vault, to an address that is
 *                    not a swap router, with no swap and no note going in
 *   private_swap     exactly one VaultSwap from a router Gloam runs on that chain,
 *                    whose note left the vault in the same transaction (Unshielded,
 *                    same nullifier) and whose new note came back in through that
 *                    router (Shielded, same commitment, from the router)
 * Anything else (a deposit, a refund, a swap's exit, two actions packed into one
 * transaction, logs from some other contract) is refused: attribution fails closed.
 *
 * What comes out is only what the chain already shows: the kind, the spend's
 * nullifier, and for a cash out or a swap the asset and amount that left the
 * vault and the vault's own fee on it (its WithdrawFee log, same nullifier; 0
 * when there is none). A cash out's receiving address comes out too, so it can
 * be matched to a partner's own address; callers never store it.
 */
import { decodeEventLog, toEventSelector, type Address, type Hex } from "viem";

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
      /** The payment's new note commitment (newCommitments[0]): chosen by the payer when it sends. */
      paymentCommitment: Hex;
    }
  | {
      ok: true;
      kind: "cash_out" | "private_swap";
      /** The spend's nullifier: what a link registration is found by (lib/partnerAttribution). */
      nullifier: Hex;
      /** The asset and amount that left the vault (the note's full amount, before the fee). */
      asset: Address;
      amount: bigint;
      /** The vault's own fee on it, in the same asset (WithdrawFee); 0n when it kept none. */
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
    return { ok: true, kind: "private_swap", nullifier: out.nullifier, asset: out.asset, amount: out.amount, vaultFee: feeFor(out.nullifier, out.asset), to: null };
  }

  // a note a router put in with no swap beside it is a refund: money coming back, not anyone's payment
  if (shielded.some((s) => anyRouter.has(s.from.toLowerCase()))) return { ok: false, reason: "refund" };
  if (vault.length === 0) return { ok: false, reason: "not_vault" };
  if (shielded.length) return { ok: false, reason: unshielded.length || transferred.length ? "mixed" : "not_vault" };

  if (unshielded.length === 1 && transferred.length === 0) {
    const out = unshielded[0]!;
    // a cash out never pays a router (lib/cashOutTarget refuses it); one that did is a swap's leg
    if (anyRouter.has(out.to.toLowerCase())) return { ok: false, reason: "mixed" };
    return { ok: true, kind: "cash_out", nullifier: out.nullifier, asset: out.asset, amount: out.amount, vaultFee: feeFor(out.nullifier, out.asset), to: out.to };
  }
  if (transferred.length === 1 && unshielded.length === 0) {
    const t = transferred[0]!;
    return { ok: true, kind: "private_payment", nullifier: t.nullifier, paymentCommitment: t.newCommitments[0] };
  }
  return { ok: false, reason: unshielded.length || transferred.length ? "mixed" : "not_vault" };
}

/** The flows a link opens, and what each may count as. */
export type LinkFlow = "pay" | "swap";
export const LINK_FLOWS: readonly LinkFlow[] = ["pay", "swap"];

export function kindFitsFlow(kind: VaultTxKind, flow: LinkFlow): boolean {
  return flow === "swap" ? kind === "private_swap" : kind === "private_payment" || kind === "cash_out";
}
