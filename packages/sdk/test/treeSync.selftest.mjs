/**
 * SDK self-test: createTreeSync (the pool tree kept up to date) and the
 * pieces around it (parseTreeSnapshot, gloamLeafSeed, sweepChainFromClient).
 *
 * A mock client holds a growing log history. Each check compares the kept
 * tree against a fresh syncTree over the same history: the roots must match,
 * later syncs must read only the blocks since the last one, and a stored or
 * seeded list the pool does not know must be dropped for a walk of the chain.
 *
 * Run after build:  node test/treeSync.selftest.mjs
 */
import {
  createTreeSync,
  gloamLeafSeed,
  parseTreeSnapshot,
  sweepChainFromClient,
  syncTree,
  SEALED_VAULT,
} from "../dist/index.js";

let checks = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exit(1);
  }
  checks++;
}

const hex = (n) => "0x" + n.toString(16).padStart(64, "0");
let nextC = 1;
const c = () => hex(nextC++);

function chain() {
  const logs = { Shielded: [], Transferred: [], SealedSwapped: [] };
  const state = { head: 100n, known: new Set(), seen: new Set(), reads: [], rootReads: 0, knownAnswer: null };
  const client = {
    async getBlockNumber() {
      return state.head;
    },
    async getLogs({ event, fromBlock, toBlock }) {
      state.reads.push([event.name, fromBlock, toBlock]);
      return logs[event.name].filter((l) => l.blockNumber >= fromBlock && l.blockNumber <= toBlock);
    },
    async readContract({ functionName, args }) {
      if (functionName === "isKnownRoot") {
        state.rootReads++;
        if (state.knownAnswer) return state.knownAnswer(args[0]);
        return state.known.has(args[0].toLowerCase());
      }
      if (functionName === "commitmentSeen") return state.seen.has(args[0].toLowerCase());
      if (functionName === "isSpent") return false;
      throw new Error(`unexpected ${functionName}`);
    },
    async getChainId() {
      return 46630;
    },
  };
  const shield = (bn, li, commitment = c()) => {
    logs.Shielded.push({ args: { commitment, asset: "0x0000000000000000000000000000000000000001", amount: 5n, from: "0x0000000000000000000000000000000000000002" }, blockNumber: bn, logIndex: li, transactionHash: hex(1000 + li) });
    return commitment;
  };
  const transfer = (bn, li) => {
    const pair = [c(), c()];
    logs.Transferred.push({ args: { newCommitments: pair }, blockNumber: bn, logIndex: li, transactionHash: hex(2000 + li) });
    return pair;
  };
  const swap = (bn, li) => {
    const pair = [c(), c()];
    logs.SealedSwapped.push({ args: { newCommitmentOut: pair[0], newCommitmentChange: pair[1], assetOut: "0x0000000000000000000000000000000000000003" }, blockNumber: bn, logIndex: li });
    return pair;
  };
  /** The root a full rebuild gives now; the pool "knows" it. */
  const truth = async () => {
    const t = await syncTree(client, { pool: SEALED_VAULT, fromBlock: 0n });
    state.known.add(t.root.toLowerCase());
    for (const l of t.leaves) state.seen.add(l.commitment.toLowerCase());
    return t;
  };
  return { client, state, shield, transfer, swap, truth };
}

// ── 1. incremental: later syncs read only new blocks, and match a full rebuild ──
{
  const m = chain();
  m.shield(10n, 0);
  m.transfer(20n, 1);
  m.swap(30n, 0);
  let want = await m.truth();
  const ts = createTreeSync(m.client, { pool: SEALED_VAULT, fromBlock: 0n, chunkSize: 1000n, overlap: 4n });
  assert(ts.toBlock === null, "no block read before the first sync");
  const first = await ts.sync();
  assert(first.root === want.root, "first sync matches a full rebuild");
  assert(first.leafCount === 5, `5 leaves, got ${first.leafCount}`);
  assert(ts.toBlock === 100n, "read up to the head");
  assert(m.state.rootReads === 1, "the root is checked once");

  // Nothing new: no logs read, no root check.
  m.state.reads = [];
  await ts.sync();
  assert(m.state.reads.length === 0, "no getLogs when the head has not moved");
  assert(m.state.rootReads === 1, "no root check when nothing changed");

  // New blocks: only the tail (with the overlap) is read.
  m.state.head = 150n;
  m.transfer(120n, 3);
  const late = m.shield(149n, 0);
  want = await m.truth();
  m.state.reads = [];
  const second = await ts.sync();
  assert(second.root === want.root, "second sync matches a full rebuild");
  assert(m.state.reads.length === 3 && m.state.reads.every(([, f, t]) => f === 97n && t === 150n), `tail read from 97 (overlap 4), got ${JSON.stringify(m.state.reads.map((r) => r.map(String)))}`);
  const p = await ts.pathForCommitment(late);
  assert(p && p.leafIndex === 7, "path for the newest leaf");
  assert(p.root === BigInt(want.root), "the path's root is the current root");
  assert((await ts.pathForCommitment(hex(99999))) === null, "unknown commitment -> null");

  // A log the node had not served yet, in a block already read: rebuilt in order.
  m.state.head = 151n;
  m.transfer(149n, 5); // after the deposit at (149, 0): appends
  m.shield(148n, 2); // before it: forces a rebuild
  want = await m.truth();
  const third = await ts.sync();
  assert(third.root === want.root, "a late log in an earlier block is put in order");
  assert(third.leafCount === want.leafCount, "no leaf counted twice across the overlap");
}

// ── 2. store: a restart reads only the blocks since the stored copy ──
{
  const m = chain();
  for (let i = 0; i < 5; i++) m.transfer(BigInt(10 + i), 0);
  await m.truth();
  let saved = null;
  const store = { load: async () => saved && JSON.parse(JSON.stringify(saved)), save: async (s) => void (saved = s) };
  const a = createTreeSync(m.client, { pool: SEALED_VAULT, fromBlock: 0n, chunkSize: 1000n, store });
  await a.sync();
  assert(saved && saved.v === 1 && saved.toBlock === "100" && saved.leafCount === 10, "saved after the first sync");
  assert(parseTreeSnapshot(saved, SEALED_VAULT) !== null, "a saved snapshot parses");

  m.state.head = 200n;
  m.shield(180n, 0);
  const want = await m.truth();
  m.state.reads = [];
  const b = createTreeSync(m.client, { pool: SEALED_VAULT, fromBlock: 0n, chunkSize: 1000n, store });
  const t = await b.sync();
  assert(t.root === want.root, "restart from the store matches a full rebuild");
  assert(m.state.reads.every(([, f]) => f === 85n), "restart reads only from the stored block (minus the default overlap of 16)");
  assert(saved.toBlock === "200" && saved.leafCount === 11, "the store is updated");

  // A store that throws or holds junk: the sync goes on without it.
  const broken = createTreeSync(m.client, {
    pool: SEALED_VAULT,
    fromBlock: 0n,
    store: { load: async () => ({ v: 1, pool: SEALED_VAULT, items: "junk" }), save: async () => { throw new Error("disk full"); } },
  });
  assert((await broken.sync()).root === want.root, "a broken store is ignored");
}

// ── 3. seed: used when it matches the pool, dropped for the chain when it does not ──
{
  const m = chain();
  const deposits = [m.shield(10n, 0), m.shield(11n, 0)];
  m.transfer(12n, 0);
  const want = await m.truth();
  const hosted = {
    v: 1,
    chainId: 46630,
    pool: SEALED_VAULT,
    deployBlock: "0",
    toBlock: "50",
    leafCount: 4,
    items: [
      { k: "s", c: [deposits[0]], bn: "10", li: 0, i: 0 },
      { k: "s", c: [deposits[1]], bn: "11", li: 0, i: 1 },
      { k: "t", c: want.leaves.slice(2).map((l) => l.commitment), bn: "12", li: 0, i: 2 },
    ],
  };
  m.state.reads = [];
  const good = createTreeSync(m.client, { pool: SEALED_VAULT, fromBlock: 0n, chunkSize: 1000n, seed: async () => hosted });
  assert((await good.sync()).root === want.root, "a matching seed is used");
  assert(m.state.reads.every(([, f]) => f === 35n), "only the blocks after the seed are read");

  // A seed with a leaf left out: its root is not the pool's, so the chain is walked.
  const bad = { ...hosted, toBlock: "100", leafCount: 3, items: hosted.items.slice(1).map((r, i) => ({ ...r, i: i === 0 ? 0 : 1 })) };
  m.state.reads = [];
  const t0 = Date.now();
  const fallback = createTreeSync(m.client, { pool: SEALED_VAULT, fromBlock: 0n, chunkSize: 1000n, seed: async () => bad });
  const t = await fallback.sync();
  assert(t.root === want.root, "a wrong seed is dropped and the chain walked");
  assert(t.leafCount === 4, "every leaf after the walk");
  assert(m.state.reads.some(([, f]) => f === 0n), "the walk starts at fromBlock");
  assert(Date.now() - t0 < 5_000, "the fallback does not hang");

  // A seed for another pool never parses.
  assert(parseTreeSnapshot({ ...hosted, pool: "0x0000000000000000000000000000000000000009" }, SEALED_VAULT) === null, "another pool's list is refused");
  assert(parseTreeSnapshot({ ...hosted, leafCount: 9 }, SEALED_VAULT) === null, "a wrong leaf count is refused");
  assert(parseTreeSnapshot({ ...hosted, items: [hosted.items[1], hosted.items[0], hosted.items[2]] }, SEALED_VAULT) === null, "out-of-order items are refused");
  assert(parseTreeSnapshot({ ...hosted, items: [{ ...hosted.items[0], c: ["0x12"] }] }, SEALED_VAULT) === null, "a malformed commitment is refused");
  assert(parseTreeSnapshot({ ...hosted, items: [{ ...hosted.items[0], bn: "51" }] }, SEALED_VAULT) === null, "an item past toBlock is refused");
}

// ── 4. a chain walk whose root the pool does not know is an error, and the next sync starts over ──
{
  const m = chain();
  m.shield(10n, 0);
  const want = await m.truth();
  m.state.knownAnswer = () => false;
  const ts = createTreeSync(m.client, { pool: SEALED_VAULT, fromBlock: 0n });
  let threw = false;
  try {
    await ts.sync();
  } catch (e) {
    threw = /not one the pool knows/.test(e.message);
  }
  assert(threw, "an unknown root after a chain walk throws");
  assert(ts.toBlock === null, "and the kept tree is dropped");
  m.state.knownAnswer = null;
  assert((await ts.sync()).root === want.root, "the next sync rebuilds");

  // A pool without isKnownRoot: taken as it is.
  m.state.knownAnswer = () => {
    throw new Error("execution reverted");
  };
  const noCheck = createTreeSync(m.client, { pool: SEALED_VAULT, fromBlock: 0n });
  assert((await noCheck.sync()).root === want.root, "no isKnownRoot: the walked tree is used");
  // verifyRoot: false never asks.
  m.state.rootReads = 0;
  m.state.knownAnswer = null;
  await createTreeSync(m.client, { pool: SEALED_VAULT, fromBlock: 0n, verifyRoot: false }).sync();
  assert(m.state.rootReads === 0, "verifyRoot: false skips the check");
}

// ── 5. concurrent calls share one tree and stay consistent ──
{
  const m = chain();
  const cs = [];
  for (let i = 0; i < 6; i++) cs.push(m.shield(BigInt(10 + i), 0));
  const want = await m.truth();
  const ts = createTreeSync(m.client, { pool: SEALED_VAULT, fromBlock: 0n });
  const paths = await Promise.all(cs.map((x) => ts.pathForCommitment(x)));
  assert(paths.every((p, i) => p && p.leafIndex === i && p.root === BigInt(want.root)), "parallel paths all at the current root");
}

// ── 5b. reuseMs: a leaf already in a fresh tree needs no read; follow keeps it fresh ──
{
  const m = chain();
  const first = m.shield(10n, 0);
  await m.truth();
  const ts = createTreeSync(m.client, { pool: SEALED_VAULT, fromBlock: 0n, reuseMs: 60_000 });
  await ts.sync();
  let heads = 0;
  const realHead = m.client.getBlockNumber;
  m.client.getBlockNumber = async () => (heads++, realHead());
  assert((await ts.pathForCommitment(first))?.leafIndex === 0, "a kept leaf's path");
  assert(heads === 0, "served from the fresh tree without a read");
  m.state.head = 130n;
  const later = m.shield(120n, 0);
  await m.truth();
  heads = 0;
  assert((await ts.pathForCommitment(later))?.leafIndex === 1, "a new leaf still syncs");
  assert(heads === 1, "one read for it");

  const stale = createTreeSync(m.client, { pool: SEALED_VAULT, fromBlock: 0n });
  await stale.sync();
  heads = 0;
  await stale.pathForCommitment(first);
  assert(heads === 1, "reuseMs 0 (default) syncs on every path");

  const followed = createTreeSync(m.client, { pool: SEALED_VAULT, fromBlock: 0n });
  const stop = followed.follow(20);
  await new Promise((r) => setTimeout(r, 30));
  m.state.head = 140n;
  m.shield(135n, 0);
  const want = await m.truth();
  await new Promise((r) => setTimeout(r, 120));
  stop();
  assert(followed.toBlock === 140n, `follow keeps syncing (toBlock ${followed.toBlock})`);
  assert((await followed.sync()).root === want.root, "and stays at the pool's root");
}

// ── 5c. knownPath: the stored tree's path, one root check, no log reads; atBlock skips the head read ──
{
  const m = chain();
  const mine = m.shield(10n, 0);
  m.transfer(11n, 0);
  await m.truth();
  let saved = null;
  const store = { load: async () => saved && JSON.parse(JSON.stringify(saved)), save: async (x) => void (saved = x) };
  await createTreeSync(m.client, { pool: SEALED_VAULT, fromBlock: 0n, store }).sync();
  // Later: more leaves on chain, a new process with the stored copy.
  m.state.head = 300n;
  m.shield(250n, 0);
  await m.truth();
  m.state.reads = [];
  m.state.rootReads = 0;
  const ts = createTreeSync(m.client, { pool: SEALED_VAULT, fromBlock: 0n, store });
  assert(saved.root && saved.root === saved.root.toLowerCase(), "the store keeps the root the pool confirmed");
  const p = await ts.knownPath(mine);
  assert(p && p.leafIndex === 0, "knownPath gives the stored leaf's path");
  assert(m.state.reads.length === 0 && m.state.rootReads === 0, "a confirmed stored copy: no log reads, no root check");
  assert(m.state.known.has("0x" + p.root.toString(16).padStart(64, "0")), "at a root the pool knows (an older one)");
  assert((await ts.knownPath(hex(777777))) === null, "a leaf not in the copy: null");

  // A stored copy without a confirmed root (or one that does not match its items) is checked once.
  const unconfirmed = { ...saved };
  delete unconfirmed.root;
  for (const copy of [unconfirmed, { ...saved, root: hex(31337) }]) {
    m.state.rootReads = 0;
    const u = createTreeSync(m.client, { pool: SEALED_VAULT, fromBlock: 0n, store: { load: async () => copy, save: async () => {} } });
    assert((await u.knownPath(mine))?.leafIndex === 0, "an unconfirmed copy still answers");
    assert(m.state.rootReads === 1, "after one root check");
    assert((await u.knownPath(mine))?.leafIndex === 0 && m.state.rootReads === 1, "and only one");
  }
  // A seed's root claim is never taken.
  m.state.rootReads = 0;
  const seeded = createTreeSync(m.client, { pool: SEALED_VAULT, fromBlock: 0n, seed: async () => saved });
  await seeded.knownPath(mine);
  assert(m.state.rootReads === 1, "a seed is always checked, root field or not");
  // A store written by a class (methods on the prototype) works.
  class Store { constructor(v) { this.v = v; } async load() { return this.v; } async save(x) { this.v = x; } }
  assert((await createTreeSync(m.client, { pool: SEALED_VAULT, fromBlock: 0n, store: new Store(saved) }).knownPath(mine))?.leafIndex === 0, "a class-based store loads");

  // A copy whose root the pool does not know gives nothing.
  const forged = { ...saved, items: saved.items.slice(1), leafCount: saved.leafCount - 1 };
  const other = createTreeSync(m.client, { pool: SEALED_VAULT, fromBlock: 0n, store: { load: async () => forged, save: async () => {} } });
  const leaf1 = saved.items[1].c[0];
  assert((await other.knownPath(leaf1)) === null, "an unconfirmed root: null");
  assert((await other.pathForCommitment(leaf1))?.leafIndex === 1, "and pathForCommitment walks the chain to the right index");

  // atBlock: read up to the receipt's block without asking for the head.
  const hinted = createTreeSync(m.client, { pool: SEALED_VAULT, fromBlock: 0n });
  await hinted.sync();
  m.state.head = 400n;
  const [pay] = m.transfer(380n, 0);
  await m.truth();
  let heads = 0;
  const realHead = m.client.getBlockNumber;
  m.client.getBlockNumber = async () => (heads++, realHead());
  const hp = await hinted.pathForCommitment(pay, { atBlock: 380n });
  assert(hp && hp.leafIndex === 4, "the hinted path");
  assert(heads === 0 && hinted.toBlock === 380n, "read to the hinted block, no head read");
  // A node that refuses the hinted block: the head is asked as usual.
  m.state.head = 420n;
  const [pay2] = m.transfer(410n, 0);
  await m.truth();
  const realLogs = m.client.getLogs;
  m.client.getLogs = async (args) => {
    if (args.toBlock === 999n) throw new Error("block range extends beyond current head block");
    return realLogs(args);
  };
  heads = 0;
  const hp2 = await hinted.pathForCommitment(pay2, { atBlock: 999n });
  assert(hp2 && hp2.leafIndex === 6 && heads === 1 && hinted.toBlock === 420n, "a refused hint falls back to the head");
  m.client.getLogs = realLogs;
  m.client.getBlockNumber = realHead;
}

// ── 6. gloamLeafSeed: one GET naming the network, null on any failure ──
{
  let asked = null;
  const ok = gloamLeafSeed("tempo", {
    url: "https://example.test/leaves",
    fetch: async (url, init) => {
      asked = { url, init };
      return new Response(JSON.stringify({ v: 1 }), { status: 200 });
    },
  });
  assert((await ok())?.v === 1, "the seed returns the JSON");
  assert(asked.url === "https://example.test/leaves?network=tempo", `asks with the network only, got ${asked.url}`);
  assert(!asked.init.method || asked.init.method === "GET", "a GET");
  const down = gloamLeafSeed("tempo", { fetch: async () => new Response("no", { status: 503 }) });
  assert((await down()) === null, "a failed list is null");
  const throws = gloamLeafSeed("tempo", { fetch: async () => { throw new Error("offline"); } });
  assert((await throws()) === null, "an unreachable list is null");
}

// ── 7. sweepChainFromClient keeps one tree and waits for a node behind ──
{
  const m = chain();
  m.shield(10n, 0);
  await m.truth();
  const sc = sweepChainFromClient(m.client, { pool: SEALED_VAULT, fromBlock: 0n, chunkSize: 1000n });
  await sc.pathForCommitment(hex(1));
  // The pool has a new commitment, but the logs node is behind for one read.
  m.state.head = 120n;
  const [payment] = m.transfer(110n, 0);
  await m.truth();
  const realGetLogs = m.client.getLogs;
  let lagging = 1;
  m.client.getLogs = async (args) => (lagging-- > 0 ? realGetLogs({ ...args, toBlock: 105n }) : realGetLogs(args));
  m.state.reads = [];
  const p = await sc.pathForCommitment(payment);
  assert(p && p.leafIndex === 1, "the path is found once the node catches up");
  assert(m.state.reads.every(([, f]) => f >= 85n), "the shared tree reads only the tail");
  // A commitment the pool has never seen: null, no waiting.
  const t0 = Date.now();
  assert((await sc.pathForCommitment(hex(424242))) === null, "an unknown note is null");
  assert(Date.now() - t0 < 1_000, "without retries");

  // After a receipt, the next path reads up to the receipt's block without asking for the head.
  m.client.getLogs = realGetLogs;
  m.client.waitForTransactionReceipt = async () => ({ status: "success", blockNumber: 130n, logs: [] });
  m.state.head = 135n;
  const [paid] = m.transfer(130n, 0);
  await m.truth();
  const r = await sc.waitForReceipt(hex(5));
  assert(r.status === "success" && Array.isArray(r.logs), "waitForReceipt passes the logs on");
  let heads = 0;
  const realHead = m.client.getBlockNumber;
  m.client.getBlockNumber = async () => (heads++, realHead());
  const pp = await sc.pathForCommitment(paid);
  assert(pp && pp.leafIndex === 3 && heads === 0, "the receipt's block is the hint");
}

console.log(`treeSync.selftest: ok (${checks} assertions)`);
