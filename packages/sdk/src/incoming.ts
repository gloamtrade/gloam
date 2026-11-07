/**
 * Payee side: find the payments sent to your Gloam address, and read their notes.
 *
 * When someone pays a Gloam address (gloamr1.…), their app seals the payment
 * (gloam2t.…) so only that address's key opens it. Where the network has a
 * payment-message board (GloamPayMemo), the sealed payment is posted there
 * next to the payment's commitment, and the payee finds it by scanning the
 * board: scanIncomingPayments. Where there is no board, the payer hands the
 * sealed code over directly, and openIncomingPayment checks it.
 *
 * Anyone who knows your Gloam address can post a message to it, so a payment
 * only counts when its code opens the commitment the message names, and that
 * note is in the vault and not yet spent, both read at one pinned block (the
 * same rule the Gloam app's inbox uses). A payment is not yours until you
 * secure it: the payer made its secret and could still spend it back. Move it
 * into a fresh note only you know with sweepReceivedNote before you credit
 * anything.
 */

import type { Address, Hex, PublicClient } from "viem";
import {
  BASE_SEPOLIA_CHAIN_ID,
  BASE_SEPOLIA_PAY_MEMO,
  ETHEREUM_SEPOLIA_CHAIN_ID,
  GLOAM_PAY_MEMO,
  RH_MAINNET_CHAIN_ID,
  RH_TESTNET_CHAIN_ID,
  TEMPO_MAINNET_CHAIN_ID,
  TEMPO_PAY_MEMO,
  TEMPO_TESTNET_CHAIN_ID,
  networkName,
  type GloamNetwork,
} from "./constants.js";
import { noteCommitmentPoseidon, noteNullifierPoseidon } from "./note.js";
import { fieldToHex, getPoseidon, hexToField } from "./poseidon.js";
import {
  decodeNotePackage,
  isSealedTicket,
  openSealedTicket,
  type NotePackage,
  type ReceiveKey,
  type ReceiveKeyJwk,
} from "./receiveTag.js";
import { POOL_STATE_ABI } from "./sweep.js";
import { ethereumSepoliaPayMemo } from "./mainnet.js";
import { elysiumMainnetConfig, elysiumTestnetConfig } from "./elysium.js";

/** A payment-message board: where payers post sealed payments for their payees to find. */
export interface PayMemoBoard {
  address: Address;
  /** Block the board was deployed at (scans start here, or at the pool's deploy block if later). */
  deployBlock: bigint;
  /** The first testnet board also indexed the poster's address; boards since emit only commitment and memo. */
  emitsPoster: boolean;
}

/**
 * The boards Gloam runs, by chain id: Robinhood Chain and Tempo, testnet and
 * mainnet, Base and Ethereum mainnet (added by their deploy,
 * contracts/base-mainnet-after-deploy.sh and ethereum-mainnet-after-deploy.sh),
 * Base Sepolia and Ethereum Sepolia.
 * On a chain with no board, payments to a Gloam address are handed over as a
 * sealed code (openIncomingPayment).
 */
export const PAY_MEMO_BOARDS: Record<number, PayMemoBoard | null> = {
  [RH_TESTNET_CHAIN_ID]: { address: GLOAM_PAY_MEMO, deployBlock: 90_421_567n, emitsPoster: true },
  [TEMPO_TESTNET_CHAIN_ID]: { address: TEMPO_PAY_MEMO, deployBlock: 37_410_900n, emitsPoster: false },
  [BASE_SEPOLIA_CHAIN_ID]: { address: BASE_SEPOLIA_PAY_MEMO, deployBlock: 49_804_175n, emitsPoster: false },
  [RH_MAINNET_CHAIN_ID]: { address: "0x01B3172d9900Cb26d57E986429b9b23854c74598", deployBlock: 95_494_392n, emitsPoster: false },
  [TEMPO_MAINNET_CHAIN_ID]: { address: "0x342E3745967FDB4223902E196Ceb792c15d8C1c4", deployBlock: 45_417_629n, emitsPoster: false },
  // Ethereum mainnet's, deployed 26 Oct 2026 after the vault.
  1: { address: "0x8699D015087dE6D25d55d5ceB63b34b9d773f135", deployBlock: 26276234n, emitsPoster: false },
  // Base mainnet's, deployed 26 Oct 2026 after the vault.
  8453: { address: "0xfCa1887e77f738ef9C5751974b3f3873d029F2DC", deployBlock: 53109729n, emitsPoster: false },
  // Ethereum Sepolia's, once it is filled in next to its pool (ETHEREUM_SEPOLIA_POOL in mainnet.ts).
  [ETHEREUM_SEPOLIA_CHAIN_ID]: ethereumSepoliaBoard(),
};

// Elysium's, once its values and the board's are in (src/elysium.ts).
const ELYSIUM = elysiumMainnetConfig();
if (ELYSIUM?.payMemo) PAY_MEMO_BOARDS[ELYSIUM.chainId] = { address: ELYSIUM.payMemo.address, deployBlock: ELYSIUM.payMemo.deployBlock, emitsPoster: false };
// And Elysium testnet's, once its pool and board are in.
const ELYSIUM_TESTNET = elysiumTestnetConfig();
if (ELYSIUM_TESTNET?.payMemo) PAY_MEMO_BOARDS[ELYSIUM_TESTNET.chainId] = { address: ELYSIUM_TESTNET.payMemo.address, deployBlock: ELYSIUM_TESTNET.payMemo.deployBlock, emitsPoster: false };

function ethereumSepoliaBoard(): PayMemoBoard | null {
  const m = ethereumSepoliaPayMemo();
  return m ? { address: m.address, deployBlock: m.deployBlock, emitsPoster: false } : null;
}

/** The payment-message board on a chain, or null where there is none. */
export function payMemoBoardFor(chainId: number): PayMemoBoard | null {
  return PAY_MEMO_BOARDS[chainId] ?? null;
}

/** Thrown when a network has no payment-message board to scan. */
export class NoPayMemoBoardError extends Error {
  constructor(chainId: number) {
    super(
      `${networkName(chainId)} has no payment-message board, so payments to a Gloam address are not posted on chain there. Ask the payer for the sealed code (gloam2t.…) and check it with openIncomingPayment.`
    );
    this.name = "NoPayMemoBoardError";
  }
}

/** A payment sent to your Gloam address: in the vault and not yet spent at `checkedAt`. */
export interface IncomingPayment {
  /** The payment's commitment in the vault. */
  commitment: Hex;
  /** Spent once the payment is secured (or taken back by the payer). */
  nullifier: Hex;
  amountWei: string;
  asset: Address;
  /** The payer's private note (an agent ID, an invoice number), or null. */
  note: string | null;
  /** The sealed code (gloam2t.…). It is the money until secured: store it safely. */
  sealedTicket: string;
  /** The opened payment. Pass notePackageToExport(notePackage) to sweepReceivedNote to secure it. */
  notePackage: NotePackage;
  /** Where the board posted it (null for a code handed over directly). */
  blockNumber: bigint | null;
  txHash: Hex | null;
}

export interface ScanIncomingParams {
  client: PublicClient;
  /** The network to scan: mainnetNetwork("robinhood"), GLOAM_NETWORKS.tempo, and so on. */
  network: GloamNetwork;
  /** Your receive key (the one behind your gloamr1. address). Keep it server-side. */
  receiveKey: ReceiveKey | ReceiveKeyJwk;
  /** First block to scan. Default: where the board (or the pool, if later) was deployed. Pass the last scannedTo + 1 to resume. */
  fromBlock?: bigint;
  /** Last block to scan, and the block every check is read at. Default: the latest block. */
  toBlock?: bigint;
  /** Scan this board instead of the network's own (for a board this SDK version does not know yet). */
  board?: PayMemoBoard;
  /** Blocks per getLogs request. Default 100_000 (Tempo's cap); a range the node refuses is split. */
  chunkSize?: bigint;
}

export interface ScanIncomingResult {
  /** Payments to you, oldest first. Already-secured and taken-back ones are left out. */
  payments: IncomingPayment[];
  /** The block everything was read at. Resume the next scan from scannedTo + 1. */
  scannedTo: bigint;
}

const PAYMENT_MEMO_EVENT = {
  type: "event",
  name: "PaymentMemo",
  inputs: [
    { name: "paymentCommitment", type: "bytes32", indexed: true },
    { name: "memo", type: "bytes", indexed: false },
  ],
} as const;

const PAYMENT_MEMO_EVENT_WITH_POSTER = {
  type: "event",
  name: "PaymentMemo",
  inputs: [
    { name: "paymentCommitment", type: "bytes32", indexed: true },
    { name: "poster", type: "address", indexed: true },
    { name: "memo", type: "bytes", indexed: false },
  ],
} as const;

/** The node refusing a span as too wide or too big (Robinhood Chain refuses over 10,000 logs; Tempo over 100,000 blocks). */
const RANGE_ERROR =
  /block range|range (is )?too|exceeds? (the )?max|max(imum)? block|only \d+ are allowed|more than \d+ (results|logs)|too many (results|logs)|response size|query timeout|limit exceeded|exceeds limit of \d+|logs matched by query/i;

function errText(e: unknown): string {
  if (e && typeof e === "object") {
    const o = e as { details?: unknown; shortMessage?: unknown; message?: unknown };
    return String(o.details ?? o.shortMessage ?? o.message ?? e);
  }
  return String(e);
}

type MemoLog = { args: { paymentCommitment?: Hex; memo?: Hex }; blockNumber: bigint | null; transactionHash: Hex | null };

async function memoLogs(client: PublicClient, board: PayMemoBoard, from: bigint, to: bigint, depth = 0): Promise<MemoLog[]> {
  try {
    return (await client.getLogs({
      address: board.address,
      event: (board.emitsPoster ? PAYMENT_MEMO_EVENT_WITH_POSTER : PAYMENT_MEMO_EVENT) as never,
      fromBlock: from,
      toBlock: to,
    })) as unknown as MemoLog[];
  } catch (e) {
    if (!RANGE_ERROR.test(errText(e)) || to <= from || depth >= 12) throw e;
    const mid = from + (to - from) / 2n;
    return [...(await memoLogs(client, board, from, mid, depth + 1)), ...(await memoLogs(client, board, mid + 1n, to, depth + 1))];
  }
}

function memoText(memo: Hex): string {
  const hex = memo.startsWith("0x") ? memo.slice(2) : memo;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return new TextDecoder().decode(bytes);
}

/** Opens a sealed code with the key and checks it is a real payment for `commitment` (when given). Null if it is not for this key. */
async function openForKey(
  sealed: string,
  key: ReceiveKey | ReceiveKeyJwk,
  network: GloamNetwork,
  commitment?: Hex
): Promise<{ pack: NotePackage; commitment: Hex; nullifier: Hex } | null> {
  if (!isSealedTicket(sealed)) return null;
  let pack: NotePackage;
  try {
    pack = decodeNotePackage(await openSealedTicket(sealed, key));
  } catch {
    return null; // sealed to someone else, or not a payment
  }
  if (pack.pool && pack.pool.toLowerCase() !== network.pool.toLowerCase()) return null;
  // A code that names its chain is only this network's if it names this chain (the vault has one address everywhere).
  if (pack.chainId !== undefined && pack.chainId !== network.chainId) return null;
  // The code must open the commitment it names: Poseidon(secret, amount, asset).
  const real = fieldToHex(await noteCommitmentPoseidon(hexToField(pack.secret), BigInt(pack.amountWei), pack.asset));
  if (real.toLowerCase() !== pack.commitment.toLowerCase()) return null;
  if (commitment && real.toLowerCase() !== commitment.toLowerCase()) return null;
  const nullifier = fieldToHex(await noteNullifierPoseidon(hexToField(pack.secret), hexToField(real)));
  return { pack, commitment: real, nullifier };
}

async function stateAt(client: PublicClient, pool: Address, commitment: Hex, nullifier: Hex, blockNumber: bigint) {
  const [inVault, spent] = await Promise.all([
    client.readContract({ address: pool, abi: POOL_STATE_ABI, functionName: "commitmentSeen", args: [commitment], blockNumber }),
    client.readContract({ address: pool, abi: POOL_STATE_ABI, functionName: "isSpent", args: [nullifier], blockNumber }),
  ]);
  return { inVault, spent };
}

/**
 * Scan the network's payment-message board for payments sealed to your key.
 * Throws NoPayMemoBoardError where the network has no board, and passes a failed chain read on rather than skip
 * a payment, so a server can retry the same range later.
 */
export async function scanIncomingPayments(params: ScanIncomingParams): Promise<ScanIncomingResult> {
  const { client, network, receiveKey } = params;
  const board = params.board ?? payMemoBoardFor(network.chainId);
  if (!board) throw new NoPayMemoBoardError(network.chainId);

  const scannedTo = params.toBlock ?? (await client.getBlockNumber({ cacheTime: 0 }));
  // A message from before the board or the pool existed cannot be for one of its notes.
  const floor = board.deployBlock > network.deployBlock ? board.deployBlock : network.deployBlock;
  const from = params.fromBlock !== undefined && params.fromBlock > floor ? params.fromBlock : floor;
  if (from > scannedTo) return { payments: [], scannedTo };

  const chunk = params.chunkSize ?? 100_000n;
  const logs: MemoLog[] = [];
  for (let start = from; start <= scannedTo; start += chunk) {
    const end = start + chunk - 1n > scannedTo ? scannedTo : start + chunk - 1n;
    logs.push(...(await memoLogs(client, board, start, end)));
  }

  const payments: IncomingPayment[] = [];
  const seen = new Set<string>();
  // Load the hash up front, so a failure to load it is passed on (and the range
  // retried) instead of every message reading as a bad code below.
  if (logs.length) await getPoseidon();
  for (const log of logs) {
    const { paymentCommitment, memo } = log.args;
    if (!paymentCommitment || !memo) continue;
    let sealed: string;
    try {
      sealed = memoText(memo).trim();
    } catch {
      continue;
    }
    // Anyone can post to the board: one malformed code must not stop the scan.
    const opened = await openForKey(sealed, receiveKey, network, paymentCommitment).catch(() => null);
    if (!opened || seen.has(opened.commitment.toLowerCase())) continue;
    const { inVault, spent } = await stateAt(client, network.pool, opened.commitment, opened.nullifier, scannedTo);
    if (!inVault || spent) continue;
    seen.add(opened.commitment.toLowerCase());
    payments.push({
      commitment: opened.commitment,
      nullifier: opened.nullifier,
      amountWei: opened.pack.amountWei,
      asset: opened.pack.asset,
      note: opened.pack.note ?? null,
      sealedTicket: sealed,
      notePackage: opened.pack,
      blockNumber: log.blockNumber ?? null,
      txHash: log.transactionHash ?? null,
    });
  }
  return { payments, scannedTo };
}

export type IncomingCheck =
  | { status: "ready"; payment: IncomingPayment; checkedAt: bigint }
  /** The payer's transfer has not landed yet: check again shortly. */
  | { status: "not_in_vault_yet"; payment: IncomingPayment; checkedAt: bigint }
  /** Already secured, or spent back by the payer: nothing to credit. */
  | { status: "already_spent"; payment: IncomingPayment; checkedAt: bigint };

/**
 * Check a sealed code (gloam2t.…) the payer handed over directly, for networks
 * with no payment-message board. Throws if the code is not a payment sealed to
 * this key on this network's vault; otherwise says whether it is ready to
 * secure, not in the vault yet, or already spent.
 */
export async function openIncomingPayment(params: {
  client: PublicClient;
  network: GloamNetwork;
  receiveKey: ReceiveKey | ReceiveKeyJwk;
  sealedTicket: string;
  /** Block to read at. Default: the latest block. */
  blockNumber?: bigint;
}): Promise<IncomingCheck> {
  const sealed = params.sealedTicket.trim();
  const opened = await openForKey(sealed, params.receiveKey, params.network);
  if (!opened) {
    throw new Error("This code is not a Gloam payment sealed to this receive key on this network's vault.");
  }
  const checkedAt = params.blockNumber ?? (await params.client.getBlockNumber({ cacheTime: 0 }));
  const { inVault, spent } = await stateAt(params.client, params.network.pool, opened.commitment, opened.nullifier, checkedAt);
  const payment: IncomingPayment = {
    commitment: opened.commitment,
    nullifier: opened.nullifier,
    amountWei: opened.pack.amountWei,
    asset: opened.pack.asset,
    note: opened.pack.note ?? null,
    sealedTicket: sealed,
    notePackage: opened.pack,
    blockNumber: null,
    txHash: null,
  };
  if (spent) return { status: "already_spent", payment, checkedAt };
  if (!inVault) return { status: "not_in_vault_yet", payment, checkedAt };
  return { status: "ready", payment, checkedAt };
}
