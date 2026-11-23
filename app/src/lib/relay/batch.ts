/**
 * One payment in parts, sent as one transaction (lib/payAcross).
 *
 * A private transfer spends one note, so a payment bigger than any single note
 * goes as a few transfers to the same Gloam address. The vault's transfer() is
 * permissionless and takes any root it knows, and each part spends its own
 * existing note against the same root, so the parts are independent: the relay
 * can put them all in one Multicall3 aggregate3 call with allowFailure false.
 * Either every part lands, with its payment message, or none does.
 *
 * Multicall3 has the same address and the same code on every network the relay
 * serves: Robinhood Chain, Tempo, Base, Ethereum, BNB Chain and Elysium, and
 * their testnets (code hash read on each, 23 November 2026). A network missing from BATCH_CHAIN_IDS sends
 * its parts one by one, as before.
 *
 * Shared by the relay (lib/relay/server) and the app (lib/relay/client): no
 * server code here.
 */
import { encodeFunctionData, type Address, type Hex } from "viem";

export const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11" as const satisfies Address;
/** keccak256 of Multicall3's runtime code, the same on every chain below. */
export const MULTICALL3_CODEHASH = "0xd5c15df687b16f2ff992fc8d767b4216323184a2bbc6ee2f9c398c318e770891" as const;

/** Where Multicall3 is deployed with that code (read 23 November 2026): the mainnets, then their testnets. */
export const BATCH_CHAIN_IDS: ReadonlySet<number> = new Set([4663, 4217, 8453, 1, 56, 99901, 46630, 42431, 84532, 11155111, 99801]);

/** A batch carries this many parts at least (one part is an ordinary transfer) and at most PAY_MAX_PARTS. */
export const BATCH_MIN_PARTS = 2;
export const BATCH_MAX_PARTS = 6;

/** One part: a proven transfer, and the payment message for its payment (commitments[0]) if any. */
export type BatchPart = {
  proof: Hex;
  root: Hex;
  nullifier: Hex;
  commitments: readonly [Hex, Hex];
  /** The sealed payment code for the person paid, as memo bytes (lib/payMemo ticketToMemoBytes). */
  memo?: Hex;
};

export const multicall3Abi = [
  {
    type: "function",
    name: "aggregate3",
    stateMutability: "payable",
    inputs: [
      {
        name: "calls",
        type: "tuple[]",
        components: [
          { name: "target", type: "address" },
          { name: "allowFailure", type: "bool" },
          { name: "callData", type: "bytes" },
        ],
      },
    ],
    outputs: [
      {
        name: "returnData",
        type: "tuple[]",
        components: [
          { name: "success", type: "bool" },
          { name: "returnData", type: "bytes" },
        ],
      },
    ],
  },
] as const;

const transferAbi = [
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "proof", type: "bytes" },
      { name: "root", type: "bytes32" },
      { name: "nullifier", type: "bytes32" },
      { name: "newCommitments", type: "bytes32[2]" },
    ],
    outputs: [],
  },
] as const;

const postMemoAbi = [
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
] as const;

export type BatchCall = { target: Address; allowFailure: false; callData: Hex };

/**
 * The calls one batch makes, in order: each part's transfer to the vault, then
 * that part's payment message to the memo board. Nothing else: no value, no
 * other target, no other function. A message is only ever for its own part's
 * payment, which the transfer before it puts in the vault in the same call.
 */
export function batchCalls(pool: Address, memoBoard: Address | null, parts: readonly BatchPart[]): BatchCall[] {
  const out: BatchCall[] = [];
  for (const p of parts) {
    out.push({
      target: pool,
      allowFailure: false,
      callData: encodeFunctionData({ abi: transferAbi, functionName: "transfer", args: [p.proof, p.root, p.nullifier, [p.commitments[0], p.commitments[1]]] }),
    });
    if (p.memo) {
      if (!memoBoard) throw new Error("No memo board on this network.");
      out.push({
        target: memoBoard,
        allowFailure: false,
        callData: encodeFunctionData({ abi: postMemoAbi, functionName: "postMemo", args: [p.commitments[0], p.memo] }),
      });
    }
  }
  return out;
}

/** The aggregate3 calldata for a batch, as the relay sends it to MULTICALL3. */
export function batchCalldata(pool: Address, memoBoard: Address | null, parts: readonly BatchPart[]): Hex {
  return encodeFunctionData({ abi: multicall3Abi, functionName: "aggregate3", args: [batchCalls(pool, memoBoard, parts)] });
}

/** Whether payments in parts go as one transaction on this network. */
export function batchesOn(chainId: number): boolean {
  return BATCH_CHAIN_IDS.has(chainId);
}
