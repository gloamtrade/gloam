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
  treeLogRange,
  SEALED_VAULT,
} from "../dist/index.js";
import { hex, poolChain } from "./poolChain.mjs";

let checks = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exit(1);
  }
  checks++;
}

/** The shared mock chain (raw pool logs, address-only reads). `truth()`: a fresh full rebuild, which must be the pool's root. */
function chain() {
  const m = poolChain(SEALED_VAULT);
  const truth = async () => {
    const t = await syncTree(m.client, { pool: SEALED_VAULT, fromBlock: 0n });
    const root = await m.rootAt(m.state.head);
    if (t.root !== root) throw new Error(`mock: a full rebuild (${t.root}) is not the pool's root (${root})`);
    return t;
  };
  return { ...m, truth };
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
  assert(m.state.reads.length === 1 && m.state.reads.every(([f, t]) => f === 97n && t === 150n), `one tail read from 97 (overlap 4), got ${JSON.stringify(m.state.reads.map((r) => r.map(String)))}`);
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
  assert(m.state.reads.every(([f]) => f === 85n), "restart reads only from the stored block (minus the default overlap of 16)");
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
  assert(m.state.reads.every(([f]) => f === 35n), "only the blocks after the seed are read");

  // A seed with a leaf left out: its root is not the pool's, so the chain is walked.
  const bad = { ...hosted, toBlock: "100", leafCount: 3, items: hosted.items.slice(1).map((r, i) => ({ ...r, i: i === 0 ? 0 : 1 })) };
  m.state.reads = [];
  const t0 = Date.now();
  const fallback = createTreeSync(m.client, { pool: SEALED_VAULT, fromBlock: 0n, chunkSize: 1000n, seed: async () => bad });
  const t = await fallback.sync();
  assert(t.root === want.root, "a wrong seed is dropped and the chain walked");
  assert(t.leafCount === 4, "every leaf after the walk");
  assert(m.state.reads.some(([f]) => f === 0n), "the walk starts at fromBlock");
  assert(Date.now() - t0 < 5_000, "the fallback does not hang");

  // A seed for another pool never parses.
  assert(parseTreeSnapshot({ ...hosted, pool: "0x0000000000000000000000000000000000000009" }, SEALED_VAULT) === null, "another pool's list is refused");
  assert(parseTreeSnapshot({ ...hosted, leafCount: 9 }, SEALED_VAULT) === null, "a wrong leaf count is refused");
  assert(parseTreeSnapshot({ ...hosted, items: [hosted.items[1], hosted.items[0], hosted.items[2]] }, SEALED_VAULT) === null, "out-of-order items are refused");
  assert(parseTreeSnapshot({ ...hosted, items: [{ ...hosted.items[0], c: ["0x12"] }] }, SEALED_VAULT) === null, "a malformed commitment is refused");
  assert(parseTreeSnapshot({ ...hosted, items: [{ ...hosted.items[0], bn: "51" }] }, SEALED_VAULT) === null, "an item past toBlock is refused");
}

// ── 4. a chain walk that does not build the pool's root is an error, and the next sync starts over ──
{
  const m = chain();
  m.shield(10n, 0);
  const want = await m.truth();
  m.state.rootAnswer = () => hex(31337);
  const ts = createTreeSync(m.client, { pool: SEALED_VAULT, fromBlock: 0n });
  let threw = false;
  try {
    await ts.sync();
  } catch (e) {
    threw = e.name === "TreeSyncError" && /does not match the pool's root/.test(e.message);
  }
  assert(threw, "a root that is not the pool's after a chain walk throws");
  assert(ts.toBlock === null, "and the kept tree is dropped");
  m.state.rootAnswer = null;
  assert((await ts.sync()).root === want.root, "the next sync rebuilds");

  // The node no longer keeps that block's state: the pool is asked whether it knows the root at all.
  m.state.rootAnswer = () => {
    throw new Error("missing trie node 0xabc (path ) state is not available");
  };
  m.state.rootReads = 0;
  const pruned = createTreeSync(m.client, { pool: SEALED_VAULT, fromBlock: 0n, retryDelayMs: 1 });
  assert((await pruned.sync()).root === want.root, "a known root is taken when the root at the block can't be read");
  assert(m.state.rootReads === 2, `one currentRoot (not retried: pruned state) and one isKnownRoot, got ${m.state.rootReads}`);
  m.state.knownAnswer = () => false;
  let refused = false;
  try {
    await createTreeSync(m.client, { pool: SEALED_VAULT, fromBlock: 0n, retryDelayMs: 1 }).sync();
  } catch (e) {
    refused = /does not match the pool's root/.test(e.message);
  }
  assert(refused, "and an unknown one is refused");

  // A pool with neither currentRoot nor isKnownRoot: taken as it is.
  m.state.rootAnswer = () => {
    throw new Error("execution reverted");
  };
  m.state.knownAnswer = () => {
    throw new Error("execution reverted");
  };
  const noCheck = createTreeSync(m.client, { pool: SEALED_VAULT, fromBlock: 0n });
  assert((await noCheck.sync()).root === want.root, "no root functions: the walked tree is used");
  // An RPC that can't answer the root check at all: an error, not an unchecked tree.
  m.state.rootAnswer = () => {
    throw Object.assign(new Error("HTTP request failed. Status: 503"), { status: 503 });
  };
  m.state.knownAnswer = m.state.rootAnswer;
  let down = false;
  try {
    await createTreeSync(m.client, { pool: SEALED_VAULT, fromBlock: 0n, retries: 1, retryDelayMs: 1 }).sync();
  } catch (e) {
    down = e.name === "TreeSyncError" && /could not read the pool's root/.test(e.message);
  }
  assert(down, "a root check the RPC can't answer throws");
  m.state.rootAnswer = null;
  // verifyRoot: false never asks.
  m.state.rootReads = 0;
  m.state.knownAnswer = null;
  m.state.rootAnswer = null;
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
  assert((await m.client.readContract({ functionName: "isKnownRoot", args: [hex(p.root)] })) === true, "at a root the pool knows (an older one)");
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
  const hinted = createTreeSync(m.client, { pool: SEALED_VAULT, fromBlock: 0n, retryDelayMs: 1 });
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
  assert(m.state.reads.every(([f]) => f >= 85n), "the shared tree reads only the tail");
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

// ── 8. two incremental syncs give the same tree as one full sync; a view handed out never changes ──
{
  const m = chain();
  const mine = [];
  let bn = 0n;
  for (let i = 0; i < 60; i++) {
    bn += BigInt(1 + ((i * 37) % 50));
    const k = i % 5;
    if (k === 0 || k === 3) mine.push(m.shield(bn, i % 3));
    else if (k === 1) mine.push(...m.transfer(bn, 0));
    else if (k === 2) mine.push(...m.swap(bn, 1));
    else m.unshield(bn, 2);
  }
  const last = bn;
  const mid = last / 2n;
  const params = { pool: SEALED_VAULT, fromBlock: 0n, chunkSize: 97n, concurrency: 3 };

  m.state.head = last + 5n;
  const full = await syncTree(m.client, params);
  assert(full.root === (await m.rootAt(m.state.head)), "a full sync builds the pool's root");
  const ranges = Math.ceil(Number(m.state.head + 1n) / 97);
  assert(m.state.reads.length === ranges, `one eth_getLogs per range for all three events (${ranges}), got ${m.state.reads.length}`);

  m.state.head = mid;
  m.state.reads = [];
  const ts = createTreeSync(m.client, params);
  const first = await ts.sync();
  const firstRoot = first.root;
  const firstCount = first.leafCount;
  assert(firstRoot === (await m.rootAt(mid)), "step one: the pool's root at its block");
  const early = first.leaves[1].commitment;

  m.state.head = last + 5n;
  m.state.reads = [];
  const second = await ts.sync();
  assert(second.root === full.root, "step two: the same root as one full sync");
  assert(second.leafCount === full.leafCount && second.leafCount === mine.length, `the same leaves (${second.leafCount} / ${full.leafCount} / ${mine.length})`);
  assert(second.leaves.every((l, i) => l.commitment === full.leaves[i].commitment), "in the same order");
  assert(m.state.reads.every(([f]) => f >= mid + 1n - 16n), "step two read only the blocks since step one (less the overlap)");
  assert(first.root === firstRoot && first.leafCount === firstCount && first.tree.nextIndex === firstCount, "the first view did not change");
  const oldPath = await first.pathForCommitment(early);
  assert(oldPath && oldPath.root === BigInt(firstRoot), "a path from the first view is at the first root");
  assert((await second.pathForCommitment(early)).root === BigInt(full.root), "and from the second at the new one");
}

// ── 9. an RPC error is an error, never an empty answer; transient ones are retried, wide ranges split ──
{
  const m = chain();
  m.shield(10n, 0);
  m.transfer(500n, 0);
  m.swap(900n, 0);
  m.state.head = 1000n;
  const want = await m.truth();
  const fast = { pool: SEALED_VAULT, fromBlock: 0n, chunkSize: 100n, retries: 2, retryDelayMs: 1 };

  // A range the node keeps failing: syncTree throws, naming the chain and the blocks.
  let tries = 0;
  m.state.onGetLogs = (args) => {
    if (args.fromBlock <= 500n && args.toBlock >= 500n) {
      tries++;
      throw Object.assign(new Error("HTTP request failed. Status: 502"), { status: 502 });
    }
  };
  let err = null;
  try {
    await syncTree(m.client, fast);
  } catch (e) {
    err = e;
  }
  assert(err && err.name === "TreeSyncError", `a failing range throws a TreeSyncError, got ${err}`);
  assert(/chain 46630/.test(err.message) && /blocks 500-599/.test(err.message) && /3 tries/.test(err.message), `the message names chain, blocks and tries: ${err.message}`);
  assert(err.fromBlock === 500n && err.toBlock === 599n && err.chainId === 46630, "and carries them");
  assert(tries === 3, `tried 1 + 2 more times, got ${tries}`);

  // createTreeSync: the failed sync throws and keeps the last good block; the next one finishes.
  m.state.onGetLogs = null;
  m.state.head = 400n;
  const ts = createTreeSync(m.client, fast);
  await ts.sync();
  assert(ts.toBlock === 400n, "synced to 400");
  m.state.head = 1000n;
  m.state.onGetLogs = (args) => {
    if (args.toBlock >= 500n) throw new Error("internal error");
  };
  let failed = false;
  try {
    await ts.sync();
  } catch (e) {
    failed = e.name === "TreeSyncError";
  }
  assert(failed, "the sync over a failing node throws");
  assert(ts.toBlock === 400n, `and does not move past what it read, got ${ts.toBlock}`);
  m.state.onGetLogs = null;
  assert((await ts.sync()).root === want.root, "the next sync finishes the job");

  // A rate limit, twice: waited out, and the answer is complete.
  let limited = 2;
  m.state.onGetLogs = () => {
    if (limited-- > 0) throw Object.assign(new Error("RPC Request failed."), { code: 429, details: "Too Many Requests" });
  };
  assert((await syncTree(m.client, fast)).root === want.root, "a 429 is retried");

  // A request the node will never take (bad params): not retried.
  tries = 0;
  m.state.onGetLogs = () => {
    tries++;
    throw Object.assign(new Error("Invalid parameters were provided to the RPC method."), { code: -32602, details: "invalid argument 0: hex string of odd length" });
  };
  try {
    await syncTree(m.client, fast);
  } catch {
    // expected
  }
  assert(tries === 1, `a bad request is sent once, got ${tries}`);

  // A range the node calls too wide: split to the size it names, kept for the rest of the read.
  m.state.onGetLogs = (args) => {
    const span = args.toBlock - args.fromBlock + 1n;
    if (span > 150n) throw Object.assign(new Error("RPC error"), { code: -32602, details: `query spans ${span} blocks (${args.fromBlock} to ${args.toBlock}), but only 150 are allowed for this request; narrow the block range` });
  };
  m.state.reads = [];
  const split = await syncTree(m.client, { ...fast, chunkSize: 600n, concurrency: 2 });
  assert(split.root === want.root, "a refused range is split and read");
  const after = m.state.reads.filter(([f, t]) => t - f + 1n <= 150n);
  assert(after.length >= 7 && m.state.reads.filter(([f, t]) => t - f + 1n > 150n).length <= 2, `the named size is used from then on (${m.state.reads.map(([f, t]) => `${f}-${t}`).join(" ")})`);
  // Tempo's wording, no size named: halved until it fits.
  m.state.onGetLogs = (args) => {
    if (args.toBlock - args.fromBlock + 1n > 300n) throw Object.assign(new Error("RPC error"), { code: -32602, details: "query exceeds max block range" });
  };
  assert((await syncTree(m.client, { ...fast, chunkSize: 1001n })).root === want.root, "halved when no size is named");
  m.state.onGetLogs = null;

  // A node a block behind: "beyond current head" is waited out.
  let behind = 1;
  m.state.onGetLogs = () => {
    if (behind-- > 0) throw new Error("block range extends beyond current head block");
  };
  assert((await syncTree(m.client, fast)).root === want.root, "a node behind is waited for");
  m.state.onGetLogs = null;
}

// ── 10. the range per chain: Robinhood Chain and Elysium take wide ranges, others the default ──
{
  assert(treeLogRange(4663) === 10_000_000n && treeLogRange(46630) === 10_000_000n, "Robinhood Chain: 10,000,000 blocks per read");
  assert(treeLogRange(99901) === 1_000_000n && treeLogRange(99801) === 1_000_000n, "Elysium: 1,000,000");
  assert(treeLogRange(4217) === 100_000n && treeLogRange(8453) === 50_000n && treeLogRange(1) === 10_000n, "Tempo, Base, Ethereum");
  assert(treeLogRange(12345) === 40_000n && treeLogRange(undefined) === 40_000n, "anything else: 40,000");
  for (const [chainId, head, reads] of [
    [99901, 2_500_000n, 3],
    [4663, 25_000_000n, 3],
    [777, 100_000n, 3],
  ]) {
    const m = poolChain(SEALED_VAULT, { chainId, head });
    m.shield(head - 5n, 0);
    const t = await syncTree(m.client, { pool: SEALED_VAULT, fromBlock: 0n });
    assert(t.leafCount === 1, `chain ${chainId}: the leaf`);
    assert(m.state.reads.length === reads, `chain ${chainId}: ${reads} reads from block 0 to ${head}, got ${m.state.reads.length}`);
  }
}

// ── 11. a reorg that takes a held leaf out is caught, even with nothing new after it ──
{
  const m = chain();
  m.shield(10n, 0);
  const late = m.shield(95n, 0);
  m.state.head = 100n;
  await m.truth();
  const ts = createTreeSync(m.client, { pool: SEALED_VAULT, fromBlock: 0n });
  assert((await ts.sync()).leafCount === 2, "two leaves before the reorg");
  m.drop(late);
  m.state.head = 101n;
  const want = await m.truth();
  const t = await ts.sync();
  assert(t.root === want.root && t.leafCount === 1, "the leaf the chain dropped is dropped");
  assert((await ts.pathForCommitment(late)) === null, "and has no path");
  // The same deposit mined again in a later block: once, at its new place.
  m.shield(101n, 0, late);
  m.state.head = 102n;
  const again = await m.truth();
  const t2 = await ts.sync();
  assert(t2.root === again.root && t2.leafCount === 2, "taken again once");
  assert((await ts.pathForCommitment(late))?.leafIndex === 1, "with its path");
}

// ── 12. a node that leaves a log out is caught by the root check: an error, not a wrong tree ──
{
  const m = chain();
  const gone = m.shield(10n, 0);
  m.transfer(20n, 0);
  await m.truth();
  m.state.onGetLogs = (_args, answer) => answer.filter((l) => !l.topics.includes(gone));
  const ts = createTreeSync(m.client, { pool: SEALED_VAULT, fromBlock: 0n });
  let caught = false;
  try {
    await ts.sync();
  } catch (e) {
    caught = e.name === "TreeSyncError" && /does not match the pool's root/.test(e.message);
  }
  assert(caught, "a tree with a log left out is refused");
  assert(ts.toBlock === null, "and not kept");
  m.state.onGetLogs = null;
  assert((await ts.sync()).leafCount === 3, "an honest answer then syncs");

  // A node with the newest block but not yet its logs: nothing looks changed, the root check reads again.
  m.state.head = 120n;
  m.shield(118n, 0);
  const want = await m.truth();
  let lagging = 1;
  m.state.onGetLogs = (_args, answer) => (lagging-- > 0 ? answer.filter((l) => l.blockNumber < 118n) : null);
  const t = await ts.sync();
  assert(t.root === want.root && t.leafCount === 4, `a sync that read a lagging node still ends at the pool's root (${t.leafCount} leaves)`);
  m.state.onGetLogs = null;
}

// ── 13. a stored copy the pool confirmed, then a deep reorg while the process was down: walked again, not refused ──
{
  const m = chain();
  m.shield(10n, 0);
  const orphan = m.shield(20n, 0);
  let saved = null;
  const store = { load: async () => saved && JSON.parse(JSON.stringify(saved)), save: async (x) => void (saved = x) };
  await createTreeSync(m.client, { pool: SEALED_VAULT, fromBlock: 0n, store }).sync();
  assert(saved.root && saved.leafCount === 2, "saved with its confirmed root");
  m.drop(orphan);
  m.shield(60n, 0);
  m.state.head = 200n;
  const want = await m.truth();
  m.state.reads = [];
  const ts = createTreeSync(m.client, { pool: SEALED_VAULT, fromBlock: 0n, store });
  const t = await ts.sync();
  assert(t.root === want.root && t.leafCount === 2, "the chain is walked and the tree matches");
  assert(m.state.reads.some(([f]) => f === 0n), "from the deploy block");
  assert(saved.leafCount === 2 && saved.items.every((r) => r.c[0] !== orphan), "and the store no longer holds the orphan");

  // logRange: the chain's default, then what the RPC named.
  const r = poolChain(SEALED_VAULT, { chainId: 8453, head: 60_000n });
  const narrow = createTreeSync(r.client, { pool: SEALED_VAULT, fromBlock: 0n, retryDelayMs: 1 });
  assert(narrow.logRange === 50_000n, "Base starts at 50,000");
  r.state.onGetLogs = (args) => {
    if (args.toBlock - args.fromBlock + 1n > 200n) throw Object.assign(new Error("RPC error"), { code: -32614, details: "eth_getLogs is limited to a 200 range" });
  };
  r.shield(59_950n, 0);
  await narrow.sync();
  assert(narrow.logRange === 200n, `then the 200 the RPC named, got ${narrow.logRange}`);
}

// ── 14. a root check that could not run is run on the next sync; a node behind on a re-read drops nothing ──
{
  const m = chain();
  m.shield(10n, 0);
  m.state.head = 150n;
  const ts = createTreeSync(m.client, { pool: SEALED_VAULT, fromBlock: 0n, retries: 0 });
  await ts.sync();
  m.shield(155n, 0);
  m.state.head = 160n;
  const want = await m.truth();
  const down = () => {
    throw Object.assign(new Error("HTTP request failed. Status: 503"), { status: 503 });
  };
  m.state.rootAnswer = down;
  m.state.knownAnswer = down;
  let failed = false;
  try {
    await ts.sync();
  } catch (e) {
    failed = /could not read the pool's root/.test(e.message);
  }
  assert(failed, "the sync whose root check could not run throws");
  m.state.rootAnswer = null;
  m.state.knownAnswer = null;
  m.state.rootReads = 0;
  const t = await ts.sync();
  assert(m.state.rootReads === 1 && t.root === want.root, "the next one checks the root before handing the tree out, though no block is new");

  // The head this node gives is behind the blocks already read: the leaves past it stay.
  const realHead = m.client.getBlockNumber;
  m.client.getBlockNumber = async () => 152n;
  const p = await ts.pathForCommitment(hex(424242));
  assert(p === null && ts.toBlock === 160n, "an unknown leaf, nothing dropped");
  assert((await ts.sync()).leafCount === want.leafCount, "the leaf at 155 is still there");
  m.client.getBlockNumber = realHead;
}

console.log(`treeSync.selftest: ok (${checks} assertions)`);
