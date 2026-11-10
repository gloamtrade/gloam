/**
 * The agent's vault tree (src/treeSync.ts, over the SDK's createTreeSync)
 * against a fake RPC: raw pool logs read by address only, and the vault's
 * root at any block. No chain, no network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IncrementalMerkleTreePoseidon, fieldToHex, hexToField } from "@gloamtrade/sdk";
import { encodeAbiParameters, encodeEventTopics, parseAbi, type Address, type Hex, type PublicClient } from "viem";
import { TreeSync } from "../src/treeSync.ts";

const POOL = "0x39e28cde55cab798874746ac52cb4b5cc99a0194" as Address;
const ASSET = "0x036cbd53842c5426634e7929541ec2318f3dcf7e" as Address;
const ABI = parseAbi([
  "event Shielded(bytes32 indexed commitment, address indexed asset, uint256 amount, uint256 leafIndex, address indexed from)",
  "event Transferred(bytes32 indexed nullifier, bytes32[2] newCommitments)",
  "event SealedSwapped(bytes32 indexed nullifier, address indexed assetIn, address indexed assetOut, bytes32 newCommitmentOut, bytes32 newCommitmentChange)",
]);
const word = (n: number | bigint) => `0x${BigInt(n).toString(16).padStart(64, "0")}` as Hex;
const VAULT = { chainId: 84532, pool: POOL, deployBlock: 100n, key: "base" };

/** A Base Sepolia RPC that answers what the tree sync asks: address-only getLogs, currentRoot at a block. */
function fakeRpc() {
  type Entry = { bn: bigint; li: number; c: Hex[]; log: Record<string, unknown> };
  const entries: Entry[] = [];
  const state = { head: 1_000n, reads: [] as [bigint, bigint][], fail: null as Error | null, maxRange: null as bigint | null };
  let n = 1;
  const add = (bn: bigint, li: number, eventName: "Shielded" | "Transferred" | "SealedSwapped") => {
    const c = eventName === "Shielded" ? [word(n++)] : [word(n++), word(n++)];
    const topics =
      eventName === "Shielded"
        ? encodeEventTopics({ abi: ABI, eventName, args: { commitment: c[0], asset: ASSET, from: ASSET } })
        : eventName === "Transferred"
          ? encodeEventTopics({ abi: ABI, eventName, args: { nullifier: word(9000 + n) } })
          : encodeEventTopics({ abi: ABI, eventName, args: { nullifier: word(9000 + n), assetIn: ASSET, assetOut: ASSET } });
    const data =
      eventName === "Shielded"
        ? encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [1n, 0n])
        : eventName === "Transferred"
          ? encodeAbiParameters([{ type: "bytes32[2]" }], [c as [Hex, Hex]])
          : encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }], [c[0]!, c[1]!]);
    entries.push({ bn, li, c, log: { address: POOL, topics, data, blockNumber: bn, logIndex: li, transactionHash: word(bn * 1000n + BigInt(li)), removed: false } });
    return c;
  };
  const rootAt = async (block: bigint) => {
    const tree = new IncrementalMerkleTreePoseidon();
    await tree.init();
    const sorted = entries.filter((e) => e.bn <= block).sort((x, y) => (x.bn === y.bn ? x.li - y.li : x.bn < y.bn ? -1 : 1));
    for (const e of sorted) for (const c of e.c) await tree.insert(hexToField(c));
    return fieldToHex(tree.currentRoot);
  };
  const client = {
    chain: { id: 84532 },
    getBlockNumber: async () => state.head,
    getChainId: async () => 84532,
    getLogs: async (args: { address: Address; fromBlock: bigint; toBlock: bigint; event?: unknown; events?: unknown }) => {
      assert.ok(!args.event && !args.events, "the vault is read by address only");
      if (state.fail) throw state.fail;
      if (state.maxRange !== null && args.toBlock - args.fromBlock + 1n > state.maxRange) {
        throw Object.assign(new Error("RPC error"), { code: -32614, details: `eth_getLogs is limited to a ${state.maxRange} range` });
      }
      state.reads.push([args.fromBlock, args.toBlock]);
      return entries.filter((e) => e.bn >= args.fromBlock && e.bn <= args.toBlock).map((e) => ({ ...e.log }));
    },
    readContract: async ({ functionName, blockNumber }: { functionName: string; blockNumber?: bigint }) => {
      if (functionName === "currentRoot") return rootAt(blockNumber ?? state.head);
      throw new Error(`fake rpc: no ${functionName}`);
    },
  };
  return { client: client as unknown as PublicClient, state, add, rootAt };
}

test("a cold start loads the leaf list, a restart the cache, and each reads only the blocks after it", async () => {
  const rpc = fakeRpc();
  const [dep] = rpc.add(200n, 0, "Shielded");
  const [pay, change] = rpc.add(300n, 1, "Transferred");
  const [out] = rpc.add(400n, 0, "SealedSwapped");
  const listed = { v: 1, chainId: 84532, pool: POOL, deployBlock: "100", toBlock: "900", leafCount: 5, items: [
    { k: "s", c: [dep], tx: word(200_000n), bn: "200", li: 0, i: 0 },
    { k: "t", c: [pay, change], tx: word(300_001n), bn: "300", li: 1, i: 1 },
    { k: "w", c: [out, word(5)], a: ASSET, tx: word(400_000n), bn: "400", li: 0, i: 3 },
  ] };
  let seeded = 0;
  const cacheDir = mkdtempSync(join(tmpdir(), "gloam-tree-"));
  const tree = new TreeSync(rpc.client, VAULT, { cacheDir, seed: async () => (seeded++, listed) });
  const v = await tree.sync();
  assert.equal(seeded, 1);
  assert.deepEqual(rpc.state.reads, [[885n, 1_000n]], "only the blocks after the list");
  assert.equal(v.root, await rpc.rootAt(1_000n));
  assert.equal(v.leafCount, 5);
  assert.equal(v.atBlock, 1_000n);
  assert.deepEqual(
    [dep, pay, change, out].map((c) => v.leafInfo(c!)?.kind),
    ["d", "p", "x", "t"],
    "deposit, payment, change, trade"
  );
  assert.equal(v.leafInfo(pay!)?.tx, word(300_001n));
  assert.equal((await v.pathForCommitment(change!))?.leafIndex, 2);
  assert.ok(existsSync(join(cacheDir, `tree.84532.${POOL}.json`)), "the leaf cache is written");

  // A new process with the cache: no leaf list, a read from the cached block.
  rpc.state.head = 1_200n;
  const [later] = rpc.add(1_100n, 0, "Shielded");
  rpc.state.reads = [];
  const again = new TreeSync(rpc.client, VAULT, { cacheDir, seed: async () => (seeded++, listed) });
  const v2 = await again.sync();
  assert.equal(seeded, 1, "the cache, not the list");
  assert.deepEqual(rpc.state.reads, [[985n, 1_200n]]);
  assert.equal((await v2.pathForCommitment(later!))?.leafIndex, 5);
});

test("a vault read once keeps its root for every path, however many syncs come after (proofs over several notes)", async () => {
  const rpc = fakeRpc();
  const [a] = rpc.add(200n, 0, "Shielded");
  const [b] = rpc.add(210n, 0, "Shielded");
  const tree = new TreeSync(rpc.client, VAULT, { seed: false });
  const v = await tree.sync();
  rpc.state.head = 1_100n;
  rpc.add(1_050n, 0, "Shielded");
  const v2 = await tree.sync();
  const [pa, pb] = await Promise.all([v.pathForCommitment(a!), v.pathForCommitment(b!)]);
  assert.equal(pa?.root, pb?.root);
  assert.equal(fieldToHex(pa!.root), v.root, "at the first read's root");
  assert.notEqual(v.root, v2.root);
  assert.equal(fieldToHex((await v2.pathForCommitment(a!))!.root), v2.root);
  assert.ok(rpc.state.reads.some(([from]) => from === 100n), "seed: false walks from the deploy block");
});

test("an RPC that fails is an error naming the chain and blocks, and a narrow RPC is read at the range it names", async () => {
  const rpc = fakeRpc();
  rpc.add(200n, 0, "Shielded");
  rpc.state.fail = Object.assign(new Error("RPC error"), { code: -32601, details: "the method eth_getLogs does not exist/is not available" });
  const tree = new TreeSync(rpc.client, VAULT, { seed: false });
  await assert.rejects(tree.sync(), (e: Error) => e.name === "TreeSyncError" && /chain 84532: eth_getLogs .* blocks 100-1000/.test(e.message));
  rpc.state.fail = null;

  rpc.state.maxRange = 200n;
  const narrow = new TreeSync(rpc.client, VAULT, { seed: false });
  assert.equal(narrow.logChunk, 50_000n, "Base Sepolia starts at publicnode's 50,000");
  const v = await narrow.sync();
  assert.equal(v.leafCount, 1);
  assert.equal(narrow.logChunk, 200n, "then the 200 the RPC named");
});
