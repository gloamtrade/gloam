/**
 * SDK self-test — tree sync ordering.
 *
 * syncTree must replay every leaf-inserting event in on-chain order
 * (blockNumber, then logIndex, then sub-index within a pair), across Shielded /
 * Transferred / SealedSwapped. Getting the order wrong yields a root that will
 * not match chain and paths that fail to prove. This drives syncTree with a
 * mock RPC whose raw logs arrive deliberately out of order, mixed with pool
 * events that insert no leaf and a log from another address.
 *
 * Run after build:  node test/sync.selftest.mjs
 */
import { syncTree, assertTreeMatchesChain, SEALED_VAULT } from "../dist/index.js";
import { hex, poolChain } from "./poolChain.mjs";

let checks = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exit(1);
  }
  checks++;
}

const h = (byte) => "0x" + byte.repeat(64); // distinct non-zero bytes32
const cB = h("1");
const cA = h("2");

// Correct insertion order is by (blockNumber, logIndex, subIndex):
//   cB(99,1) -> cA(100,2) -> transfer pair (100,5) -> swap pair (101,0)
const m = poolChain(SEALED_VAULT, { head: 101n, firstCommitment: 0x100 });
m.shield(100n, 2, cA);
m.shield(99n, 1, cB);
const [cT0, cT1] = m.transfer(100n, 5);
m.unshield(100n, 3); // a cash-out: in the pool's logs, no leaf
const [cS0, cS1] = m.swap(101n, 0);
const foreign = { ...m.logs[0], address: "0x00000000000000000000000000000000000000ff", logIndex: 9 };
// The RPC answers out of order, with another contract's log mixed in.
m.state.onGetLogs = (_args, answer) => [foreign, ...answer.reverse()];

const synced = await syncTree(m.client, { pool: SEALED_VAULT, fromBlock: 0n });
assert(m.state.reads.length === 1, `one eth_getLogs for all three events, got ${m.state.reads.length}`);

// leaf count = 1 shield + 1 shield + 2 transfer + 2 swap
assert(synced.leafCount === 6, `leafCount: got ${synced.leafCount}, want 6`);
assert(synced.leaves.length === 6, "leaves array length 6");

// exact insertion order
const order = [cB, cA, cT0, cT1, cS0, cS1];
order.forEach((c, i) => {
  assert(
    synced.indexByCommitment.get(c.toLowerCase()) === i,
    `commitment ${c.slice(0, 6)} should be leaf ${i}, got ${synced.indexByCommitment.get(c.toLowerCase())}`
  );
});

// kinds are labelled right
assert(synced.leaves[0].kind === "shield", "leaf 0 is a shield");
assert(synced.leaves[2].kind === "transfer", "leaf 2 is a transfer");
assert(synced.leaves[0].amount === 5n && synced.leaves[0].asset, "a deposit keeps its amount and asset");
assert(synced.root === (await m.rootAt(101n)), "the root is the pool's");

// pathForCommitment resolves to the right leaf and verifies internally
const pB = await synced.pathForCommitment(cB);
assert(pB && pB.leafIndex === 0, "pathForCommitment(cB) -> leaf 0");
const pS1 = await synced.pathForCommitment(cS1);
assert(pS1 && pS1.leafIndex === 5, "pathForCommitment(cS1) -> leaf 5");
assert(pS1.root === pB.root, "all paths share the one current root");

// unknown commitment -> null
const pNone = await synced.pathForCommitment(h("9"));
assert(pNone === null, "unknown commitment -> null path");

// assertTreeMatchesChain: true when chain root matches, false otherwise
const ok = await assertTreeMatchesChain(m.client, SEALED_VAULT, synced);
assert(ok === true, "matches chain when currentRoot() == synced.root");
m.state.rootAnswer = () => hex(0);
const bad = await assertTreeMatchesChain(m.client, SEALED_VAULT, synced);
assert(bad === false, "does not match when currentRoot() differs");

// The same log twice in one answer is taken once; two different logs at one position is an error.
m.state.rootAnswer = null;
m.state.onGetLogs = (_args, answer) => [...answer, answer[0]];
assert((await syncTree(m.client, { pool: SEALED_VAULT, fromBlock: 0n })).leafCount === 6, "a repeated log is counted once");
m.state.onGetLogs = (_args, answer) => [...answer, { ...answer[1], logIndex: answer[0].logIndex, blockNumber: answer[0].blockNumber }];
let clash = false;
try {
  await syncTree(m.client, { pool: SEALED_VAULT, fromBlock: 0n });
} catch (e) {
  clash = e.name === "TreeSyncError" && /two different logs/.test(e.message);
}
assert(clash, "two different logs at one position throw");

// A log of a leaf event that does not decode is an error, never skipped.
m.state.onGetLogs = (_args, answer) => answer.map((l, i) => (i === 0 ? { ...l, data: "0x01" } : l));
let undecodable = false;
try {
  await syncTree(m.client, { pool: SEALED_VAULT, fromBlock: 0n });
} catch (e) {
  undecodable = e.name === "TreeSyncError" && /does not decode/.test(e.message);
}
assert(undecodable, "an undecodable leaf log throws");

console.log(`sync.selftest: ok (${checks} assertions)`);
