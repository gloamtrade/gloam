/**
 * On-chain payment memos (GloamPayMemo), Zcash/Solana-style discovery.
 * After vault transfer, sender posts encrypted ticket; recipient scans logs.
 */

import { parseEventLogs, type Address, type Hex, type PublicClient } from "viem";
import { walkLogs, walkTuning } from "./leafIndex";
import { getActiveNetwork, type GloamNetwork, type PayMemoBoard } from "./networks";
import { readDemo } from "./demoFlag";
import { demoPaymentMemos } from "./demo/chain";

/** Live RH testnet deploy (see contracts/deployments/poseidon-testnet.json) */
export const TESTNET_PAY_MEMO =
  "0x689ebd9d30E0235c73fd8f10236F850CDB3c5DCE" as const satisfies Address;

/** Memo board for the network the app is pointed at, or null if none is deployed there. */
export function activePayMemo(): PayMemoBoard | null {
  return getActiveNetwork().payMemo;
}

export function payMemoAddress(): Address | null {
  return activePayMemo()?.address ?? null;
}

export const payMemoAbi = [
  {
    type: "function",
    name: "postMemo",
    stateMutability: "nonpayable",
    inputs: [
      { name: "paymentCommitment", type: "bytes32" },
      { name: "memo", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "event",
    name: "PaymentMemo",
    inputs: [
      { name: "paymentCommitment", type: "bytes32", indexed: true },
      { name: "poster", type: "address", indexed: true },
      { name: "memo", type: "bytes", indexed: false },
    ],
  },
] as const;

export function isPayMemoLive(): boolean {
  return Boolean(activePayMemo());
}

/**
 * GloamPayMemo.MAX_MEMO: the board rejects a memo longer than this. A sealed
 * ticket (gloam2t) is about 0.85 KB, and the longest private note (80 characters,
 * lib/paymentNote) takes it to 1739 bytes at most, so every ticket fits with
 * room to spare, and well inside MEMO_GAS_LIMIT (about 80k gas at the largest,
 * on Tempo). The Gloam relay posts no more than 2048 bytes
 * (RELAY_MEMO_MAX_BYTES in lib/relay/server, with the arithmetic).
 */
export const PAY_MEMO_MAX_BYTES = 8192;

/** Encode ticket string as hex bytes for postMemo */
export function ticketToMemoBytes(ticket: string): Hex {
  const enc = new TextEncoder().encode(ticket);
  let hex = "0x";
  for (const b of enc) hex += b.toString(16).padStart(2, "0");
  return hex as Hex;
}

export function memoBytesToTicket(data: Hex): string {
  const hex = data.startsWith("0x") ? data.slice(2) : data;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return new TextDecoder().decode(bytes);
}

export type ScannedMemo = {
  paymentCommitment: Hex;
  poster: Address;
  ticket: string;
  txHash?: Hex;
  blockNumber?: bigint;
};

/**
 * Scan recent PaymentMemo logs (chunked). Caller tries decrypt with receive tag.
 */
export async function fetchPaymentMemos(
  client: PublicClient,
  fromBlockOverride?: bigint,
  toBlock?: bigint,
  /** The network to read; the one the app shows when left out. */
  network?: GloamNetwork
): Promise<ScannedMemo[]> {
  // Recording demo: the board holds the one payment waiting for the pretend wallet.
  if (readDemo()) return demoPaymentMemos();
  const net = network ?? getActiveNetwork();
  const board = net.payMemo;
  if (!board) return [];
  // a memo from before the pool existed can't be for one of its notes, so start at whichever came later
  const floor = net.deployBlock != null && net.deployBlock > board.deployBlock ? net.deployBlock : board.deployBlock;
  const fromBlock = fromBlockOverride ?? floor;
  // First deploy indexed the poster too; the fixed board emits only commitment + memo.
  const inputs = board.emitsPoster
    ? ([
        { name: "paymentCommitment", type: "bytes32", indexed: true },
        { name: "poster", type: "address", indexed: true },
        { name: "memo", type: "bytes", indexed: false },
      ] as const)
    : ([
        { name: "paymentCommitment", type: "bytes32", indexed: true },
        { name: "memo", type: "bytes", indexed: false },
      ] as const);
  const latest = toBlock ?? (await client.getBlockNumber());
  if (latest < fromBlock) return [];
  const raw = await walkLogs(client, board.address, fromBlock, latest, walkTuning(net.chainId, net.logRange));
  const logs = parseEventLogs({ abi: [{ type: "event", name: "PaymentMemo", inputs }], logs: raw, strict: false });
  const out: ScannedMemo[] = [];
  for (const log of logs) {
    const args = log.args as {
      paymentCommitment?: Hex;
      poster?: Address;
      memo?: Hex;
    };
    if (!args.paymentCommitment || !args.memo) continue;
    try {
      out.push({
        paymentCommitment: args.paymentCommitment,
        poster: (args.poster ??
          "0x0000000000000000000000000000000000000000") as Address,
        ticket: memoBytesToTicket(args.memo),
        txHash: log.transactionHash as Hex | undefined,
        blockNumber: log.blockNumber ?? undefined,
      });
    } catch {
      /* skip */
    }
  }
  return out.reverse(); // newest first
}

export const MEMO_GAS_LIMIT = 200_000n;
