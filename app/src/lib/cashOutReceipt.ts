/**
 * A receipt for a cash out to a public wallet, read from the chain.
 *
 * A cash out is public: the vault's `unshield` logs Unshielded(nullifier,
 * asset, to, amount) and, when a fee was kept, WithdrawFee(nullifier, asset,
 * fee) in the same transaction, and `to` gets amount minus fee. So a receipt
 * needs no proof and holds no secret: every line on it is in that
 * transaction, and anyone can check it with the explorer link. It never
 * shows the private balance the money came from, or anything else.
 *
 * Which cash outs are yours: every note this browser holds has its spend
 * marker (nullifier), and a cash out names the one it spent. findCashOuts asks
 * the vault for Unshielded logs with those markers, nothing else.
 */
import {
  TransactionReceiptNotFoundError,
  parseEventLogs,
  type AbiEvent,
  type Address,
  type Hex,
  type Log,
  type PublicClient,
} from "viem";
import { walkLogs, walkTuning } from "./leafIndex";

export const UNSHIELDED_EVENT = {
  type: "event",
  name: "Unshielded",
  inputs: [
    { name: "nullifier", type: "bytes32", indexed: true },
    { name: "asset", type: "address", indexed: true },
    { name: "to", type: "address", indexed: true },
    { name: "amount", type: "uint256", indexed: false },
  ],
} as const satisfies AbiEvent;

export const WITHDRAW_FEE_EVENT = {
  type: "event",
  name: "WithdrawFee",
  inputs: [
    { name: "nullifier", type: "bytes32", indexed: true },
    { name: "asset", type: "address", indexed: true },
    { name: "fee", type: "uint256", indexed: false },
  ],
} as const satisfies AbiEvent;

const RECEIPT_ABI = [UNSHIELDED_EVENT, WITHDRAW_FEE_EVENT] as const;

/** The network a receipt is read on: its id, its vault and its name. */
export type ReceiptNetwork = { chainId: number; pool: Address | null; label: string; deployBlock?: bigint | null; logRange?: bigint };

export type CashOutReceipt = {
  chainId: number;
  network: string;
  pool: Address;
  txHash: Hex;
  blockNumber: bigint;
  /** When the block was made, ms. */
  time: number;
  asset: Address;
  /** The wallet it went to. */
  to: Address;
  /** What left the private balance. */
  amount: bigint;
  /** The cash-out fee the vault kept (0 when none was logged). */
  fee: bigint;
  /** What the wallet got: amount minus fee. */
  delivered: bigint;
  nullifier: Hex;
  /** The account that sent the transaction (the Gloam relay, or the wallet that sent it). */
  sentBy: Address | null;
  /** Cash outs in the same transaction (one, unless a batch). */
  inTx: number;
};

export type ReceiptRead =
  | { ok: true; receipt: CashOutReceipt }
  | { ok: false; reason: "pending" | "failed" | "not_cash_out" | "unreadable"; message: string };

export function isTxHash(s: string): s is Hex {
  return /^0x[0-9a-fA-F]{64}$/.test(s.trim());
}

/**
 * The receipt for the cash out in `hash` on `net`, read from the chain: the
 * transaction must have succeeded and carry an Unshielded log from this
 * network's vault. `nullifier` picks one when a transaction has several.
 */
export async function readCashOutReceipt(
  client: Pick<PublicClient, "getTransactionReceipt" | "getBlock" | "getTransaction">,
  net: ReceiptNetwork,
  hash: string,
  opts: { nullifier?: Hex } = {}
): Promise<ReceiptRead> {
  const h = hash.trim();
  if (!isTxHash(h)) return { ok: false, reason: "unreadable", message: "That isn't a transaction hash. It starts with 0x and has 64 letters and numbers after it." };
  if (!net.pool) return { ok: false, reason: "not_cash_out", message: `Gloam has no vault on ${net.label}.` };
  const pool = net.pool.toLowerCase();

  let receipt: Awaited<ReturnType<PublicClient["getTransactionReceipt"]>>;
  try {
    receipt = await client.getTransactionReceipt({ hash: h as Hex });
  } catch (e) {
    if (e instanceof TransactionReceiptNotFoundError || /not be found|not found/i.test(String((e as Error)?.message ?? ""))) {
      return { ok: false, reason: "pending", message: `Not on ${net.label} yet. A cash out takes a moment to land.` };
    }
    return { ok: false, reason: "unreadable", message: `Couldn't read ${net.label} just now. Try again in a moment.` };
  }
  if (receipt.status !== "success") {
    return { ok: false, reason: "failed", message: "This transaction failed on chain, so no money moved." };
  }

  const fromVault = receipt.logs.filter((l) => l.address.toLowerCase() === pool);
  const events = parseEventLogs({ abi: RECEIPT_ABI, logs: fromVault as Log[], strict: true });
  const unshields = events.filter((e) => e.eventName === "Unshielded");
  if (unshields.length === 0) {
    return { ok: false, reason: "not_cash_out", message: `This transaction isn't a cash out from the Gloam vault on ${net.label}.` };
  }
  const want = opts.nullifier?.toLowerCase();
  const pick = (want && unshields.find((e) => (e.args as { nullifier: Hex }).nullifier.toLowerCase() === want)) || unshields[0]!;
  const u = pick.args as { nullifier: Hex; asset: Address; to: Address; amount: bigint };
  const feeLog = events.find(
    (e) => e.eventName === "WithdrawFee" && (e.args as { nullifier: Hex }).nullifier.toLowerCase() === u.nullifier.toLowerCase()
  );
  const fee = feeLog ? (feeLog.args as { fee: bigint }).fee : 0n;

  const [block, tx] = await Promise.all([
    client.getBlock({ blockNumber: receipt.blockNumber }).catch(() => null),
    client.getTransaction({ hash: h as Hex }).catch(() => null),
  ]);
  if (!block) return { ok: false, reason: "unreadable", message: `Couldn't read ${net.label} just now. Try again in a moment.` };

  return {
    ok: true,
    receipt: {
      chainId: net.chainId,
      network: net.label,
      pool: net.pool,
      txHash: h.toLowerCase() as Hex,
      blockNumber: receipt.blockNumber,
      time: Number(block.timestamp) * 1000,
      asset: u.asset,
      to: u.to,
      amount: u.amount,
      fee,
      delivered: u.amount > fee ? u.amount - fee : 0n,
      nullifier: u.nullifier,
      sentBy: tx?.from ?? null,
      inTx: unshields.length,
    },
  };
}

/** RCT-20261123-B7F8: the day it landed (UTC) plus the end of its transaction hash. */
export function receiptNumber(r: Pick<CashOutReceipt, "time" | "txHash">): string {
  const d = new Date(r.time);
  const ymd = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
  return `RCT-${ymd}-${r.txHash.slice(-4).toUpperCase()}`;
}

export type FoundCashOut = { txHash: Hex; blockNumber: bigint; nullifier: Hex; asset: Address; to: Address; amount: bigint };

/** How many spend markers go in one log query (an OR of topics). */
export const NULLIFIERS_PER_QUERY = 50;

/**
 * This browser's cash outs on `net`: the vault's Unshielded logs whose spend
 * marker is one of `nullifiers`, newest first.
 */
export async function findCashOuts(
  client: PublicClient,
  net: ReceiptNetwork,
  nullifiers: readonly Hex[],
  head?: bigint
): Promise<FoundCashOut[]> {
  if (!net.pool || nullifiers.length === 0) return [];
  const unique = [...new Set(nullifiers.map((n) => n.toLowerCase() as Hex))];
  const to = head ?? (await client.getBlockNumber());
  const from = net.deployBlock ?? 0n;
  const tuning = walkTuning(net.chainId, net.logRange ?? 10_000n);
  const out: FoundCashOut[] = [];
  for (let i = 0; i < unique.length; i += NULLIFIERS_PER_QUERY) {
    const chunk = unique.slice(i, i + NULLIFIERS_PER_QUERY);
    const raw = await walkLogs(client, net.pool, from, to, tuning, { event: UNSHIELDED_EVENT, args: { nullifier: chunk } });
    const pool = net.pool.toLowerCase();
    const logs = parseEventLogs({ abi: [UNSHIELDED_EVENT], logs: raw.filter((l) => l.address.toLowerCase() === pool), strict: true });
    for (const l of logs) {
      const a = l.args as { nullifier: Hex; asset: Address; to: Address; amount: bigint };
      // only the markers asked for, whatever a node sends back
      if (!chunk.includes(a.nullifier.toLowerCase() as Hex)) continue;
      if (!l.transactionHash || l.blockNumber == null) continue;
      out.push({ txHash: l.transactionHash, blockNumber: l.blockNumber, nullifier: a.nullifier, asset: a.asset, to: a.to, amount: a.amount });
    }
  }
  const seen = new Set<string>();
  return out
    .filter((c) => {
      const k = `${c.txHash.toLowerCase()}:${c.nullifier.toLowerCase()}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((a, b) => (a.blockNumber === b.blockNumber ? 0 : a.blockNumber > b.blockNumber ? -1 : 1));
}
