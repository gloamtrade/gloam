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
 * A cash out across balances (lib/cashOutAcross) goes the same way: its parts'
 * unshields, each spending its own note to the same wallet, in one aggregate3
 * call, all or nothing (unshieldBatchCalls). The vault's unshield() never reads
 * msg.sender either: each proof binds its own amount and wallet.
 *
 * Multicall3 has the same address and the same code on every network the relay
 * serves: Robinhood Chain, Tempo, Base, Ethereum, BNB Chain and Elysium, and
 * their testnets (code hash read on each, 23 November 2026). It sends in one go
 * on all of them but the ones with a public mempool (FRONT_RUN_CHAIN_IDS). A
 * network missing from BATCH_CHAIN_IDS sends its parts one by one, as before.
 *
 * Shared by the relay (lib/relay/server) and the app (lib/relay/client): no
 * server code here.
 */
import { decodeFunctionData, encodeFunctionData, type Address, type Hex } from "viem";

export const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11" as const satisfies Address;
/** keccak256 of Multicall3's runtime code, the same on every chain below. */
export const MULTICALL3_CODEHASH = "0xd5c15df687b16f2ff992fc8d767b4216323184a2bbc6ee2f9c398c318e770891" as const;

/** Where Multicall3 is deployed with that code (read 23 November 2026): the mainnets, then their testnets. */
export const MULTICALL3_CHAIN_IDS: readonly number[] = [4663, 4217, 8453, 1, 56, 99901, 46630, 42431, 84532, 11155111, 99801];

/**
 * Networks with a public mempool, where anyone reads a pending batch's calldata and
 * can outbid it: Ethereum, its Sepolia testnet and BNB Chain. A griefer copies the
 * last part's proof and sends that one spend to the vault first (anyone may, and it
 * pays the person as proven); the batch then runs every other part and reverts on
 * the spent one, so the relay pays for nearly every part and nothing of it lands.
 * There the parts go one by one: a send that loses a race reverts early and cheap.
 *
 * Base and Elysium are in PUBLIC_MEMPOOL_CHAINS (lib/partnerCode) for another
 * reason, a pending block readable before its time; their sequencer takes sends in
 * the order they come, so nobody can get one in ahead of a batch there.
 */
export const FRONT_RUN_CHAIN_IDS: readonly number[] = [1, 11155111, 56];

/** Where payments and cash outs in parts go as one transaction: Multicall3 is there, and nobody can get ahead of it. */
export const BATCH_CHAIN_IDS: ReadonlySet<number> = new Set(MULTICALL3_CHAIN_IDS.filter((id) => !FRONT_RUN_CHAIN_IDS.includes(id)));

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

// ---------------------------------------------------------------- cash outs

/** One part of a cash out in one go: a proven unshield, exactly what a single relayed cash out takes. */
export type UnshieldBatchPart = {
  proof: Hex;
  root: Hex;
  nullifier: Hex;
  asset: Address;
  to: Address;
  amount: bigint;
};

const unshieldAbi = [
  {
    type: "function",
    name: "unshield",
    stateMutability: "nonpayable",
    inputs: [
      { name: "proof", type: "bytes" },
      { name: "root", type: "bytes32" },
      { name: "nullifier", type: "bytes32" },
      { name: "asset", type: "address" },
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

/**
 * The relay refuses a cash out in one go with this code when the vault's cash-out
 * fee is now higher than the one the person confirmed: every part would pay less
 * than it showed. Nothing is sent, and the parts don't go one by one either.
 */
export const FEE_MOVED_CODE = "fee_moved";

/**
 * The calls a cash out in one go makes, in order: each part's unshield on the
 * vault, not allowed to fail. Nothing else: no value, no other target, no other
 * function, no payment message.
 */
export function unshieldBatchCalls(pool: Address, parts: readonly UnshieldBatchPart[]): BatchCall[] {
  return parts.map((p) => ({
    target: pool,
    allowFailure: false,
    callData: encodeFunctionData({ abi: unshieldAbi, functionName: "unshield", args: [p.proof, p.root, p.nullifier, p.asset, p.to, p.amount] }),
  }));
}

/** The aggregate3 calldata for a cash out in one go, as the relay sends it to MULTICALL3. */
export function unshieldBatchCalldata(pool: Address, parts: readonly UnshieldBatchPart[]): Hex {
  return encodeFunctionData({ abi: multicall3Abi, functionName: "aggregate3", args: [unshieldBatchCalls(pool, parts)] });
}

/**
 * What is wrong with a cash out batch's calls, or null when nothing is: one call
 * per part, in order, each the vault's own unshield on `pool`, not allowed to
 * fail, carrying exactly that part's proof, root, nullifier, asset, wallet and
 * amount. The relay checks the calls it built with this just before it sends
 * them, so nothing but those unshields can ever go out in one.
 */
export function unshieldBatchProblem(
  pool: Address,
  parts: readonly UnshieldBatchPart[],
  calls: readonly { target: Address; allowFailure: boolean; callData: Hex }[]
): string | null {
  if (calls.length !== parts.length) return "A cash out in one go makes one call per part.";
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  for (let i = 0; i < calls.length; i++) {
    const c = calls[i]!;
    const p = parts[i]!;
    if (!same(c.target, pool)) return "A cash out in one go only calls this network's vault.";
    if (c.allowFailure !== false) return "No part of a cash out in one go may fail on its own.";
    let args: readonly unknown[] | undefined;
    try {
      const decoded = decodeFunctionData({ abi: unshieldAbi, data: c.callData });
      if (decoded.functionName !== "unshield") return "A cash out in one go only calls the vault's unshield.";
      args = decoded.args;
    } catch {
      return "A cash out in one go only calls the vault's unshield.";
    }
    const [proof, root, nullifier, asset, to, amount] = args as readonly [Hex, Hex, Hex, Address, Address, bigint];
    if (
      !same(proof, p.proof) ||
      !same(root, p.root) ||
      !same(nullifier, p.nullifier) ||
      !same(asset, p.asset) ||
      !same(to, p.to) ||
      amount !== p.amount
    ) {
      return "A call in this cash out isn't the part it was given for.";
    }
    // the calldata is exactly that one call, nothing tacked on after it
    if (!same(c.callData, encodeFunctionData({ abi: unshieldAbi, functionName: "unshield", args: [p.proof, p.root, p.nullifier, p.asset, p.to, p.amount] }))) {
      return "A call in this cash out isn't the part it was given for.";
    }
  }
  return null;
}
