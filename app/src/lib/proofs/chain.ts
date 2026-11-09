/**
 * On-chain checks behind verifyProof. Reads only, against the network the proof
 * names (not the network the viewer has selected), with one public client per
 * chain. Pool events are matched here because a payment note can come from a
 * deposit (Shielded), a private send (Transferred) or a trade (SealedSwapped).
 */
import { createPublicClient, parseEventLogs, type Address, type Hex, type PublicClient } from "viem";
import { getNetwork, NETWORK_KEYS, type GloamNetwork } from "@/lib/networks";
import { classifyPaymentLogs, type PaymentLookup, type PoolEventLog } from "./payrollCheck";
import { PAYROLL_MAX_PAYMENTS, PAYROLL_MAX_PAYMENTS_TOTAL, type PayrollPayment } from "./types";
import { serverTransport } from "@/lib/serverRpc";

const POOL_ABI = [
  {
    type: "function",
    name: "isKnownRoot",
    stateMutability: "view",
    inputs: [{ name: "root", type: "bytes32" }],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "isSpent",
    stateMutability: "view",
    inputs: [{ name: "nullifier", type: "bytes32" }],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "commitmentSeen",
    stateMutability: "view",
    inputs: [{ name: "commitment", type: "bytes32" }],
    outputs: [{ type: "bool" }],
  },
] as const;

const NOTE_EVENTS = [
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
    name: "SealedSwapped",
    inputs: [
      { name: "nullifier", type: "bytes32", indexed: true },
      { name: "assetIn", type: "address", indexed: true },
      { name: "assetOut", type: "address", indexed: true },
      { name: "newCommitmentOut", type: "bytes32", indexed: false },
      { name: "newCommitmentChange", type: "bytes32", indexed: false },
    ],
  },
] as const;

/** How far back a payment is looked up when the proof carries no tx hash. */
const MAX_SCAN_CHUNKS = 24;
const SCAN_PARALLEL = 4;
/** Receipts read at once for a payroll check. */
const RECEIPT_PARALLEL = 6;
/** Spend markers asked for in one log query (one value each, OR'd in the topic): one part's worth. */
const NULLIFIERS_PER_QUERY = PAYROLL_MAX_PAYMENTS;

/**
 * Most chain reads one payroll check makes. The largest real proof, 256
 * payments, needs one receipt per payment when it names their transactions,
 * or at most MAX_SCAN_CHUNKS log queries per part of 32 when it does not, plus
 * the head and two block times (the first and the last payment).
 */
export const PAYROLL_MAX_READS = 2 * PAYROLL_MAX_PAYMENTS_TOTAL;

export function networkForChain(chainId: number): GloamNetwork | null {
  for (const key of NETWORK_KEYS) {
    const n = getNetwork(key);
    if (n.chainId === chainId) return n;
  }
  return null;
}

const clients = new Map<number, PublicClient>();

export function clientFor(net: GloamNetwork): PublicClient {
  const existing = clients.get(net.chainId);
  if (existing) return existing;
  const client = createPublicClient({
    chain: net.chain,
    ccipRead: false,
    transport: serverTransport(net, { timeout: 25_000, retryCount: 2 }),
  });
  clients.set(net.chainId, client);
  return client;
}

export function isKnownRoot(client: PublicClient, pool: Address, root: Hex): Promise<boolean> {
  return client.readContract({ address: pool, abi: POOL_ABI, functionName: "isKnownRoot", args: [root] });
}

export function isSpent(client: PublicClient, pool: Address, nullifier: Hex): Promise<boolean> {
  return client.readContract({ address: pool, abi: POOL_ABI, functionName: "isSpent", args: [nullifier] });
}

export function commitmentSeen(client: PublicClient, pool: Address, commitment: Hex): Promise<boolean> {
  return client.readContract({ address: pool, abi: POOL_ABI, functionName: "commitmentSeen", args: [commitment] });
}

type PoolLog = {
  eventName: "Shielded" | "Transferred" | "SealedSwapped";
  args: Record<string, unknown>;
  address: Address;
  blockNumber: bigint | null;
  transactionHash: Hex | null;
};

/** How a note entered the vault, read from the event that inserted it. */
export type NoteOrigin =
  /** The holder's own deposit. */
  | "deposit"
  /** The payment output of a private send (Transferred newCommitments[0]). */
  | "payment"
  /** The change a sender kept from a private send (Transferred newCommitments[1]). */
  | "change"
  /** An output of a private trade. */
  | "trade";

/**
 * Which output of `log` is `commitment`, or null when the log did not make it.
 * The app, the SDK and the payroll runner all build a send the same way
 * (buildTransferWitness): output 0 is the payee's note, output 1 the sender's
 * change, and the pool inserts and emits them in that order.
 */
export function noteOriginIn(log: { eventName: string; args: Record<string, unknown> }, commitment: string): NoteOrigin | null {
  const a = log.args;
  const want = commitment.toLowerCase();
  const hits = (v: unknown) => typeof v === "string" && v.toLowerCase() === want;
  if (log.eventName === "Shielded") return hits(a.commitment) ? "deposit" : null;
  if (log.eventName === "Transferred") {
    const out = Array.isArray(a.newCommitments) ? a.newCommitments : [];
    if (hits(out[0])) return "payment";
    if (hits(out[1])) return "change";
    return null;
  }
  if (log.eventName === "SealedSwapped") return hits(a.newCommitmentOut) || hits(a.newCommitmentChange) ? "trade" : null;
  return null;
}

export type NoteTx =
  | { state: "found"; txHash: Hex; blockNumber: bigint; paidAt: number; origin: NoteOrigin }
  /** The named transaction exists but did not create this note in this pool. */
  | { state: "mismatch" }
  /** The named transaction is not on this network. */
  | { state: "no-tx" }
  /** No transaction named, and the note is older than the bounded scan. */
  | { state: "not-found" };

async function found(client: PublicClient, origin: NoteOrigin, txHash: Hex, blockNumber: bigint): Promise<NoteTx> {
  const block = await client.getBlock({ blockNumber });
  return { state: "found", txHash, blockNumber, paidAt: Number(block.timestamp), origin };
}

/** viem throws this when a hash has no receipt; anything else is the network failing. */
function receiptMissing(e: unknown): boolean {
  return e instanceof Error && e.name === "TransactionReceiptNotFoundError";
}

/**
 * The transaction that put `commitment` in the pool, how, and when it landed.
 * With a tx hash, that receipt is read and must contain the note (else
 * "mismatch", or "no-tx" when the chain has no such transaction); without one,
 * recent blocks are scanned newest first, at most MAX_SCAN_CHUNKS eth_getLogs
 * ranges of the network's allowed size (Tempo caps at 100k blocks). Throws when
 * the network cannot be reached, so the caller can tell that apart.
 */
export async function findNoteTx(
  client: PublicClient,
  net: GloamNetwork,
  pool: Address,
  commitment: Hex,
  txHash: Hex | null
): Promise<NoteTx> {
  const poolLower = pool.toLowerCase();

  if (txHash) {
    let receipt: Awaited<ReturnType<PublicClient["getTransactionReceipt"]>>;
    try {
      receipt = await client.getTransactionReceipt({ hash: txHash });
    } catch (e) {
      if (receiptMissing(e)) return { state: "no-tx" };
      throw e;
    }
    if (receipt.status !== "success") return { state: "mismatch" };
    const logs = parseEventLogs({ abi: NOTE_EVENTS, logs: receipt.logs }) as unknown as PoolLog[];
    for (const l of logs) {
      if (l.address.toLowerCase() !== poolLower) continue;
      const origin = noteOriginIn(l, commitment);
      if (origin) return found(client, origin, txHash, receipt.blockNumber);
    }
    return { state: "mismatch" };
  }

  const latest = await client.getBlockNumber();
  const floor = net.deployBlock ?? 0n;
  const range = net.logRange;
  const chunks: [bigint, bigint][] = [];
  for (let end = latest; end >= floor && chunks.length < MAX_SCAN_CHUNKS; end -= range) {
    const start = end - range + 1n > floor ? end - range + 1n : floor;
    chunks.push([start, end]);
    if (start === floor) break;
  }
  for (let i = 0; i < chunks.length; i += SCAN_PARALLEL) {
    const batch = await Promise.all(
      chunks.slice(i, i + SCAN_PARALLEL).map(([fromBlock, toBlock]) =>
        client.getLogs({ address: pool, events: NOTE_EVENTS, fromBlock, toBlock })
      )
    );
    // Batches run newest first, so the first hit is the one to report.
    for (const logs of batch) {
      for (const l of logs as unknown as PoolLog[]) {
        const origin = noteOriginIn(l, commitment);
        if (origin && l.transactionHash && l.blockNumber != null) {
          return found(client, origin, l.transactionHash, l.blockNumber);
        }
      }
    }
  }
  return { state: "not-found" };
}

/** The most chain reads a payroll check makes has been reached. */
class ReadLimitReached extends Error {
  constructor() {
    super("payroll check read limit reached");
    this.name = "ReadLimitReached";
  }
}

/** Payroll lookups for one check, sharing its reads, its block times and its read limit. */
export type PayrollLookups = {
  /**
   * Looks a group of payments up: a receipt for each that names its
   * transaction (stopping at the first that is not a plain find), then one log
   * query per block range for all the others together. An entry left undefined
   * was not looked up. Throws when the network cannot be reached.
   */
  find: (pays: PayrollPayment[]) => Promise<(PaymentLookup | undefined)[]>;
  /** When a block landed, unix seconds. */
  blockTime: (block: bigint) => Promise<number>;
  /** Chain reads made so far. */
  reads: () => number;
};

/**
 * One payroll payment on chain: the transaction must hold the pool's
 * Transferred(nullifier, [commitment, change]). With a tx hash that receipt is
 * read ("no-tx" when the chain has no such transaction); without one,
 * Transferred events are looked up by the spend marker (an indexed topic) over
 * the same bounded range as findNoteTx, for every such payment of the group in
 * one query per range. At most `maxReads` reads in all (PAYROLL_MAX_READS);
 * past that, payments come back "over-limit" without a read.
 */
export function payrollLookups(
  client: PublicClient,
  net: GloamNetwork,
  pool: Address,
  maxReads: number = PAYROLL_MAX_READS
): PayrollLookups {
  let used = 0;
  const take = () => {
    if (used >= maxReads) throw new ReadLimitReached();
    used++;
  };
  const times = new Map<bigint, Promise<number>>();
  const blockTime = (blockNumber: bigint) => {
    let t = times.get(blockNumber);
    if (!t) {
      take();
      t = client.getBlock({ blockNumber }).then((b) => Number(b.timestamp));
      times.set(blockNumber, t);
    }
    return t;
  };
  let head: Promise<bigint> | null = null;
  const latest = () => {
    if (!head) {
      take();
      head = client.getBlockNumber();
    }
    return head;
  };
  const judge = (logs: PoolEventLog[], pay: PayrollPayment, txHash: Hex, block: bigint): PaymentLookup => {
    const v = classifyPaymentLogs(logs, pool, pay.commitment, pay.nullifier);
    if (v === "found") return { state: "found", txHash, block };
    if (v === "deposit" || v === "trade") return { state: "wrong-origin", origin: v };
    return { state: v };
  };

  const byReceipt = async (pay: PayrollPayment & { txHash: Hex }): Promise<PaymentLookup> => {
    try {
      take();
    } catch {
      return { state: "over-limit" };
    }
    let receipt: Awaited<ReturnType<PublicClient["getTransactionReceipt"]>>;
    try {
      receipt = await client.getTransactionReceipt({ hash: pay.txHash });
    } catch (e) {
      if (receiptMissing(e)) return { state: "no-tx" };
      throw e;
    }
    if (receipt.status !== "success") return { state: "mismatch" };
    const logs = parseEventLogs({ abi: NOTE_EVENTS, logs: receipt.logs }) as unknown as PoolEventLog[];
    return judge(logs, pay, pay.txHash, receipt.blockNumber);
  };

  /** Newest range first, every remaining spend marker in one query per range, until each is found. */
  const byScan = async (pays: PayrollPayment[]): Promise<Map<PayrollPayment, PaymentLookup>> => {
    const out = new Map<PayrollPayment, PaymentLookup>();
    const left = new Map(pays.map((p) => [p.nullifier.toLowerCase(), p]));
    try {
      const top = await latest();
      const floor = net.deployBlock ?? 0n;
      const range = net.logRange;
      for (let end = top, n = 0; end >= floor && n < MAX_SCAN_CHUNKS && left.size > 0; end -= range, n++) {
        const start = end - range + 1n > floor ? end - range + 1n : floor;
        const wanted = [...left.keys()];
        for (let i = 0; i < wanted.length; i += NULLIFIERS_PER_QUERY) {
          take();
          const logs = (await client.getLogs({
            address: pool,
            event: NOTE_EVENTS[1],
            args: { nullifier: wanted.slice(i, i + NULLIFIERS_PER_QUERY) as Hex[] },
            fromBlock: start,
            toBlock: end,
          })) as unknown as (PoolEventLog & { transactionHash: Hex | null; blockNumber: bigint | null })[];
          for (const l of logs) {
            const key = typeof l.args.nullifier === "string" ? l.args.nullifier.toLowerCase() : "";
            const pay = left.get(key);
            if (!pay || !l.transactionHash || l.blockNumber == null) continue;
            out.set(pay, judge([l], pay, l.transactionHash, l.blockNumber));
            left.delete(key);
          }
        }
        if (start === floor) break;
      }
    } catch (e) {
      if (!(e instanceof ReadLimitReached)) throw e;
      for (const p of left.values()) out.set(p, { state: "over-limit" });
      return out;
    }
    for (const p of left.values()) out.set(p, { state: "not-found" });
    return out;
  };

  const find = async (pays: PayrollPayment[]): Promise<(PaymentLookup | undefined)[]> => {
    const results = new Map<PayrollPayment, PaymentLookup>();
    const named = pays.filter((p): p is PayrollPayment & { txHash: Hex } => Boolean(p.txHash));
    for (let i = 0; i < named.length; i += RECEIPT_PARALLEL) {
      const batch = named.slice(i, i + RECEIPT_PARALLEL);
      const got = await Promise.all(batch.map(byReceipt));
      batch.forEach((p, j) => results.set(p, got[j]!));
      if (got.some((r) => r.state !== "found")) return pays.map((p) => results.get(p));
    }
    const unnamed = pays.filter((p) => !p.txHash);
    if (unnamed.length) for (const [p, r] of await byScan(unnamed)) results.set(p, r);
    return pays.map((p) => results.get(p));
  };

  return {
    find,
    blockTime: (block) => {
      try {
        return blockTime(block);
      } catch (e) {
        return Promise.reject(e);
      }
    },
    reads: () => used,
  };
}
