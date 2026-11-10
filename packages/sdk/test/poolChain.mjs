/**
 * A mock chain for the tree sync self-tests: the pool's logs as an RPC returns
 * them (raw topics and data, address-only eth_getLogs), the pool's root at any
 * block (currentRoot), the roots it has had (isKnownRoot), and switches to make
 * it fail the ways real RPCs do. Not a test itself.
 */
import { encodeAbiParameters, encodeEventTopics, parseAbi } from "viem";
import { IncrementalMerkleTreePoseidon, fieldToHex, hexToField } from "../dist/index.js";

export const POOL_ABI = parseAbi([
  "event Shielded(bytes32 indexed commitment, address indexed asset, uint256 amount, uint256 leafIndex, address indexed from)",
  "event Transferred(bytes32 indexed nullifier, bytes32[2] newCommitments)",
  "event SealedSwapped(bytes32 indexed nullifier, address indexed assetIn, address indexed assetOut, bytes32 newCommitmentOut, bytes32 newCommitmentChange)",
  "event Unshielded(bytes32 indexed nullifier, address indexed asset, uint256 amount, address indexed to)",
]);

export const hex = (n) => "0x" + BigInt(n).toString(16).padStart(64, "0");
const ASSET = "0x0000000000000000000000000000000000000001";
const FROM = "0x0000000000000000000000000000000000000002";
const OUT = "0x0000000000000000000000000000000000000003";

function rawLog(pool, eventName, args, data, bn, li, tx) {
  return {
    address: pool,
    topics: encodeEventTopics({ abi: POOL_ABI, eventName, args }),
    data,
    blockNumber: bn,
    logIndex: li,
    transactionHash: tx,
    transactionIndex: 0,
    blockHash: hex(bn),
    removed: false,
  };
}

/**
 * `pool`: the pool address. `opts.chainId`: put a `chain` on the client (per-chain defaults).
 * Returns { client, state, shield, transfer, swap, unshield, drop, truth, rootAt }.
 */
export function poolChain(pool, opts = {}) {
  let nextC = opts.firstCommitment ?? 1;
  const c = () => hex(nextC++);
  /** Every log the pool emitted, in no particular order. */
  const logs = [];
  const state = {
    head: opts.head ?? 100n,
    /** [fromBlock, toBlock] of each eth_getLogs. */
    reads: [],
    /** currentRoot and isKnownRoot calls. */
    rootReads: 0,
    /** Override: the pool's root at a block (return a root, or throw). */
    rootAnswer: null,
    /** Override: isKnownRoot (return a bool, or throw). */
    knownAnswer: null,
    seen: new Set(),
    /** Hook before each eth_getLogs: throw to fail it, or return a replacement list. */
    onGetLogs: null,
  };
  let leafCount = 0;

  /** The pool's root once every insert up to `block` is in. */
  const rootAt = async (block) => {
    const inserts = logs
      .filter((l) => l.blockNumber <= block && l.commitments)
      .sort((x, y) => (x.blockNumber === y.blockNumber ? x.logIndex - y.logIndex : x.blockNumber < y.blockNumber ? -1 : 1));
    const tree = new IncrementalMerkleTreePoseidon();
    await tree.init();
    for (const l of inserts) for (const cm of l.commitments) await tree.insert(hexToField(cm));
    return fieldToHex(tree.currentRoot);
  };
  /** Every root the pool has had up to the head (Gloam pools keep them all). */
  const knownRoots = async () => {
    const blocks = [...new Set(logs.filter((l) => l.commitments).map((l) => l.blockNumber))];
    const roots = new Set([(await rootAt(-1n)).toLowerCase()]);
    for (const b of blocks) if (b <= state.head) roots.add((await rootAt(b)).toLowerCase());
    return roots;
  };

  const client = {
    ...(opts.chainId ? { chain: { id: opts.chainId } } : {}),
    async getBlockNumber() {
      return state.head;
    },
    async getChainId() {
      return opts.chainId ?? 46630;
    },
    async getLogs(args) {
      if (args.event || args.events || args.topics || args.args) throw new Error("the tree sync must read by address only");
      const { fromBlock, toBlock } = args;
      state.reads.push([fromBlock, toBlock]);
      const answer = logs
        .filter((l) => l.address.toLowerCase() === args.address.toLowerCase() && l.blockNumber >= fromBlock && l.blockNumber <= toBlock)
        .map(({ commitments, ...l }) => ({ ...l }));
      if (state.onGetLogs) {
        const replaced = await state.onGetLogs(args, answer);
        if (replaced) return replaced;
      }
      return answer;
    },
    async readContract({ functionName, args, blockNumber }) {
      if (functionName === "currentRoot") {
        state.rootReads++;
        if (state.rootAnswer) return state.rootAnswer(blockNumber ?? state.head);
        return rootAt(blockNumber ?? state.head);
      }
      if (functionName === "isKnownRoot") {
        state.rootReads++;
        if (state.knownAnswer) return state.knownAnswer(args[0]);
        return (await knownRoots()).has(args[0].toLowerCase());
      }
      if (functionName === "commitmentSeen") return state.seen.has(args[0].toLowerCase());
      if (functionName === "isSpent") return false;
      throw new Error(`unexpected ${functionName}`);
    },
  };

  const push = (log, commitments) => {
    logs.push({ ...log, commitments });
    for (const cm of commitments) state.seen.add(cm.toLowerCase());
  };
  const shield = (bn, li, commitment = c()) => {
    const data = encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [5n, BigInt(leafCount)]);
    push(rawLog(pool, "Shielded", { commitment, asset: ASSET, from: FROM }, data, bn, li, hex(1000 + li)), [commitment]);
    leafCount += 1;
    return commitment;
  };
  const transfer = (bn, li) => {
    const pair = [c(), c()];
    const data = encodeAbiParameters([{ type: "bytes32[2]" }], [pair]);
    push(rawLog(pool, "Transferred", { nullifier: hex(5000 + nextC) }, data, bn, li, hex(2000 + li)), pair);
    leafCount += 2;
    return pair;
  };
  const swap = (bn, li) => {
    const pair = [c(), c()];
    const data = encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }], pair);
    push(rawLog(pool, "SealedSwapped", { nullifier: hex(6000 + nextC), assetIn: ASSET, assetOut: OUT }, data, bn, li, hex(3000 + li)), pair);
    leafCount += 2;
    return pair;
  };
  /** A pool event that inserts no leaf (a cash-out): the sync must pass over it. */
  const unshield = (bn, li) => {
    const data = encodeAbiParameters([{ type: "uint256" }], [7n]);
    logs.push(rawLog(pool, "Unshielded", { nullifier: hex(7000 + li), asset: ASSET, to: FROM }, data, bn, li, hex(4000 + li)));
  };
  /** A log the chain no longer has (a reorg took it out). */
  const drop = (commitment) => {
    const i = logs.findIndex((l) => l.commitments?.some((x) => x.toLowerCase() === commitment.toLowerCase()));
    if (i < 0) throw new Error("no such log");
    const [l] = logs.splice(i, 1);
    leafCount -= l.commitments.length;
    for (const cm of l.commitments) state.seen.delete(cm.toLowerCase());
  };
  /** The root at the head, and the leaf count, for comparing. */
  const truth = async () => ({ root: await rootAt(state.head), leafCount: logs.filter((l) => l.blockNumber <= state.head && l.commitments).reduce((n, l) => n + l.commitments.length, 0) });
  return { client, state, shield, transfer, swap, unshield, drop, truth, rootAt, logs };
}
