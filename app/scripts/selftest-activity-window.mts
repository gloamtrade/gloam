/**
 * Self-test: the Public activity card's first read on a mainnet is bounded and
 * fills as it goes, and never sits on its skeleton.
 *
 * On BNB Chain the card read every block from the vault's deploy (850,000+) in
 * the network's log range before it showed anything, and on a phone it never
 * finished. Now (lib/walletActivity):
 *   - the first read covers the last week only (a day on BNB Chain), newest blocks first;
 *   - rows show as soon as the newest span comes back (onProgress);
 *   - "Show older" reads another window back, and only that;
 *   - a call answers at its time limit with what is read so far while the read
 *     goes on, and the next call joins it; nothing read in time is an error the
 *     card can retry; reads stop a few blocks short of the head;
 *   - a failing read leaves the rows above it and says so.
 *
 * The chain is a stand-in that answers getLogs by event, filter and block range,
 * makes one block a second, and can be slow or fail per range; nothing reaches
 * a network. Runs on Base mainnet, or on BNB Chain with its variables set (CI
 * runs both).
 *
 * Run from app/:  ../mcp/node_modules/.bin/tsx scripts/selftest-activity-window.mts
 */
import assert from "node:assert/strict";
import "./browser-shim.mjs";
import { parseUnits, type Address, type Hex } from "viem";

globalThis.fetch = (async (url: unknown) => {
  throw new Error(`selftest-activity-window: no network calls allowed (${String(url)})`);
}) as typeof fetch;

const { getNetwork } = await import("../src/lib/networks");
const { shieldTokensFor } = await import("../src/lib/tokens");
const { headLag } = await import("../src/components/transparency/ledger");
const { activityRefetchMs, activityView, activityWindowDays, readWalletActivity, widenWalletActivity } = await import(
  "../src/lib/walletActivity"
);
type ActivityRead = Awaited<ReturnType<typeof readWalletActivity>>;

const KEY = process.env.NEXT_PUBLIC_BNB_ENABLED === "1" ? ("bnb-mainnet" as const) : ("base-mainnet" as const);
const NET = getNetwork(KEY);
assert.ok(NET.pool && NET.deployBlock != null, `${KEY} has a vault`);
const TOKEN = shieldTokensFor(NET.chainId)[0];
const DAY = 86_400n; // the stand-in makes one block a second
const HEAD = NET.deployBlock! + 40n * DAY;
const LAG = headLag(NET.chainId);
const TOP = HEAD - LAG; // the last few blocks wait for the next read
const DAYS = activityWindowDays(NET.chainId); // 7, or 1 on BNB Chain
const WINDOW_START = TOP - BigInt(DAYS) * DAY + 1n;
const lc = (a: string) => a.toLowerCase();
const tx = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const wallet = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const SOMEONE = wallet(0xdead);

type FakeLog = { event: string; address: Address; blockNumber: bigint; transactionHash: Hex; logIndex: number; args: Record<string, unknown> };
let txn = 1;
/** A transfer of 10 tokens from `me` to someone, `back` blocks below the head. */
const sent = (me: Address, back: bigint): FakeLog => ({
  event: "Transfer",
  address: TOKEN.address as Address,
  blockNumber: HEAD - back,
  transactionHash: tx(txn++),
  logIndex: 0,
  args: { from: me, to: SOMEONE, value: parseUnits("10", TOKEN.decimals) },
});

let headNow = HEAD;
type Q = { address: Address | Address[]; event: { name: string }; args?: Record<string, unknown>; fromBlock: bigint; toBlock: bigint };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A stand-in chain. `slow(q)` answers a getLogs after that many ms; `fail(q)` makes it throw. */
function chain(logs: FakeLog[], opts: { slow?: (q: Q) => number; fail?: (q: Q) => boolean; head?: () => Promise<bigint> } = {}) {
  const calls: Q[] = [];
  const client = {
    getBlockNumber: opts.head ?? (async () => headNow),
    getBlock: async ({ blockNumber }: { blockNumber: bigint }) => ({ number: blockNumber, timestamp: blockNumber }),
    getLogs: async (q: Q) => {
      calls.push(q);
      const ms = opts.slow?.(q) ?? 0;
      if (ms) await sleep(ms);
      if (opts.fail?.(q)) throw new Error("upstream unavailable");
      const addrs = (Array.isArray(q.address) ? q.address : [q.address]).map(lc);
      return logs.filter(
        (l) =>
          l.event === q.event.name &&
          addrs.includes(lc(l.address)) &&
          l.blockNumber >= q.fromBlock &&
          l.blockNumber <= q.toBlock &&
          Object.entries(q.args ?? {}).every(([k, v]) => lc(String(l.args[k])) === lc(String(v)))
      );
    },
  };
  return { client: client as never, calls };
}

let passed = 0;
async function ok(name: string, fn: () => Promise<void> | void) {
  await fn();
  passed++;
  console.log(`  ok  ${name}`);
}
const blocksOf = (r: ActivityRead) => r.txs.map((t) => (t as unknown as { block: string }).block);

console.log(`selftest-activity-window (${NET.label}, head ${HEAD}, window from ${WINDOW_START})`);

await ok("the first read covers the last window only (a week; a day on BNB Chain), newest blocks first, and rows show as the first span returns", async () => {
  const me = wallet(1);
  const newest = sent(me, LAG + 10n);
  const mid = sent(me, 70_000n);
  const edge = sent(me, BigInt(DAYS) * DAY - 100n);
  const old = sent(me, 10n * DAY);
  const theirs = { ...sent(SOMEONE, 5n), args: { from: SOMEONE, to: wallet(2), value: 1n } };
  // every span below the newest answers late, so the newest one is plainly first
  const { client, calls } = chain([newest, mid, edge, old, theirs], { slow: (q) => (q.toBlock < TOP - 40_000n ? 40 : 0) });
  const events: { at: number; blocks: string[] }[] = [];
  const t0 = Date.now();
  const out = await readWalletActivity(KEY, me, client, { onProgress: (r) => events.push({ at: Date.now() - t0, blocks: blocksOf(r) }) });
  const end = Date.now() - t0;

  assert.ok(calls.length > 0);
  assert.equal(calls[0].toBlock, TOP, "the first query is for the newest blocks, a few short of the head");
  assert.ok(calls.every((q) => q.toBlock <= TOP), "no block past the lag line, which a balanced RPC may not have yet");
  const lowest = calls.reduce((m, q) => (q.fromBlock < m ? q.fromBlock : m), HEAD);
  assert.equal(lowest, WINDOW_START, "nothing older than the window is read");
  assert.ok(calls.every((q) => q.toBlock - q.fromBlock + 1n <= NET.logRange || q.toBlock - q.fromBlock + 1n <= 4_000_000n), "spans stay in the network's range");
  assert.deepEqual(blocksOf(out), [newest, mid, edge].map((l) => String(l.blockNumber)), "the week's rows, newest first; not the older one, not another wallet's");
  assert.ok(events.length >= 2, "the list grows span by span");
  assert.deepEqual(events[0].blocks, [String(newest.blockNumber)], "the first rows shown are the newest");
  assert.ok(events[0].at < end - 20, `the newest row shows before the read is done (${events[0].at} ms of ${end} ms)`);
  assert.deepEqual(out.scope && { ...out.scope, progress: undefined }, { days: DAYS, complete: false, reading: false, progress: undefined, stalled: false });
  assert.equal(out.scope!.progress, 1);
  assert.equal(activityView({ isLoading: false, isError: false, data: out }), "list");
  assert.equal(activityRefetchMs({ status: "success", data: out }), 30_000);

  // a refresh reads only the blocks since
  calls.length = 0;
  const again = await readWalletActivity(KEY, me, client);
  assert.deepEqual(blocksOf(again), blocksOf(out), "the same rows, once each");
  assert.equal(calls.length, 0, "nothing new at the head: nothing read");
  headNow = HEAD + 500n;
  const later = await readWalletActivity(KEY, me, client);
  assert.ok(calls.length > 0 && calls.every((q) => q.fromBlock === TOP + 1n && q.toBlock === TOP + 500n), "a refresh reads only the blocks since");
  assert.deepEqual(blocksOf(later), blocksOf(out));
  headNow = HEAD;
});

await ok("nothing in the window: an honest empty state, and Show older reads one more window back, and only that", async () => {
  const me = wallet(3);
  const old = sent(me, BigInt(DAYS) * DAY + DAY / 2n);
  const older = sent(me, 3n * BigInt(DAYS) * DAY);
  const { client, calls } = chain([old, older]);
  const first = await readWalletActivity(KEY, me, client);
  assert.deepEqual(first.txs, []);
  assert.equal(first.scope!.reading, false);
  assert.equal(first.scope!.complete, false);
  assert.equal(activityView({ isLoading: false, isError: false, data: first }), "empty-window", "No public transfers in the last week (day on BNB Chain)");

  calls.length = 0;
  assert.equal(widenWalletActivity(KEY, me), true);
  const second = await readWalletActivity(KEY, me, client);
  const prevStart = WINDOW_START;
  const newStart = TOP - 2n * BigInt(DAYS) * DAY + 1n;
  assert.ok(calls.length > 0 && calls.every((q) => q.toBlock < prevStart && q.fromBlock >= newStart), "the second window is read, not the first again");
  assert.deepEqual(blocksOf(second), [String(old.blockNumber)], "the row from one window back, not the one from three");
  assert.equal(second.scope!.days, 2 * DAYS);
  assert.equal(activityView({ isLoading: false, isError: false, data: second }), "list");
});

await ok("Show older reaches the deploy block at most, and then everything is read", async () => {
  const me = wallet(4);
  const { client } = chain([]);
  await readWalletActivity(KEY, me, client);
  let widened = 0;
  while (widenWalletActivity(KEY, me)) {
    widened++;
    await readWalletActivity(KEY, me, client);
  }
  assert.equal(widened, Math.ceil(40 / DAYS) - 1);
  const last = await readWalletActivity(KEY, me, client);
  assert.equal(last.scope!.complete, true);
  assert.equal(activityView({ isLoading: false, isError: false, data: last }), "empty", "Nothing public yet");
});

await ok("a call answers at its time limit with the rows read so far; the read goes on and is not started again", async () => {
  const me = wallet(5);
  const newest = sent(me, LAG + 10n);
  const mid = sent(me, 70_000n);
  // older spans answer long after the call's limit
  const slow = chain([newest, mid], { slow: (q) => (q.toBlock < TOP - 40_000n ? 700 : 0) });
  const t0 = Date.now();
  const first = await readWalletActivity(KEY, me, slow.client, { passMs: 300 });
  const took = Date.now() - t0;
  assert.ok(took < 600, `the call answered at its limit (${took} ms)`);
  assert.deepEqual(blocksOf(first), [String(newest.blockNumber)]);
  assert.equal(first.scope!.reading, true, "the card says it is still reading");
  assert.equal(first.scope!.stalled, false);
  assert.ok(first.scope!.progress > 0 && first.scope!.progress < 1);
  assert.equal(activityView({ isLoading: false, isError: false, data: first }), "list");
  assert.equal(activityRefetchMs({ status: "success", data: first }), 1_000, "the next call comes at once");

  // the next call joins the same read and gets the rest
  const seen: string[][] = [];
  const second = await readWalletActivity(KEY, me, undefined, { onProgress: (r) => seen.push(blocksOf(r)) });
  assert.deepEqual(seen[0], blocksOf(first), "a call that joins sees the list so far at once");
  assert.deepEqual(blocksOf(second), [newest, mid].map((l) => String(l.blockNumber)));
  assert.equal(second.scope!.reading, false);
  const ranges = slow.calls.map((q) => `${q.event.name}:${JSON.stringify(q.args)}:${q.fromBlock}-${q.toBlock}`);
  assert.equal(new Set(ranges).size, ranges.length, "no block range is read twice");
});

await ok("nothing read in time: an error the card can retry, not a skeleton; Retry joins the read still going", async () => {
  const me = wallet(6);
  let wait = 600;
  const slow = chain([sent(me, LAG + 10n)], { slow: () => wait });
  const t0 = Date.now();
  await assert.rejects(readWalletActivity(KEY, me, slow.client, { passMs: 250 }), /activity_timeout/);
  assert.ok(Date.now() - t0 < 500);
  assert.equal(activityView({ isLoading: false, isError: true }), "error");
  assert.equal(activityRefetchMs({ status: "error" }), 30_000);
  wait = 0;
  const retry = await readWalletActivity(KEY, me, chain([]).client);
  assert.equal(retry.txs.length, 1, "Retry gets the read that kept going, not a new one");

  const noHead = chain([], { head: () => sleep(600).then(() => HEAD) });
  await assert.rejects(readWalletActivity(KEY, wallet(7), noHead.client, { passMs: 200 }), /activity_timeout/, "a head that does not come in time");
  await readWalletActivity(KEY, wallet(7), noHead.client);
});

await ok("a read that fails keeps the rows above it, says so, and does not hammer the RPC", async () => {
  const me = wallet(8);
  const newest = sent(me, LAG + 10n);
  const { client, calls } = chain([newest, sent(me, 70_000n)], { fail: (q) => q.toBlock < TOP - 40_000n });
  const out = await readWalletActivity(KEY, me, client);
  assert.deepEqual(blocksOf(out), [String(newest.blockNumber)]);
  assert.equal(out.scope!.stalled, true);
  assert.equal(activityView({ isLoading: false, isError: false, data: out }), "list", "rows, with 'Some blocks could not be read' and Try again");
  assert.equal(activityRefetchMs({ status: "success", data: out }), 30_000, "no quick re-reads of a failing RPC");
  const failedSpans = new Set(calls.filter((q) => q.toBlock < TOP - 40_000n).map((q) => q.fromBlock));
  assert.ok(failedSpans.size <= 3, `no span is started after one failed (${failedSpans.size})`);

  const down = chain([], { fail: () => true });
  await assert.rejects(readWalletActivity(KEY, wallet(9), down.client), /activity_failed/);
});

await ok("the card's states: reading, error, empty week, empty, list", () => {
  const scope = { days: 7, complete: false, reading: false, progress: 1, stalled: false };
  assert.equal(activityView({ isLoading: true, isError: false }), "reading");
  assert.equal(activityView({ isLoading: false, isError: false, data: { txs: [], scope: { ...scope, reading: true, progress: 0.4 } } }), "reading");
  assert.equal(activityView({ isLoading: false, isError: false, data: { txs: [], scope: { ...scope, reading: true, stalled: true } } }), "error");
  assert.equal(activityView({ isLoading: false, isError: true, data: { txs: [], scope: { ...scope, reading: true } } }), "error");
  assert.equal(activityView({ isLoading: false, isError: false, data: { txs: [], scope } }), "empty-window");
  assert.equal(activityView({ isLoading: false, isError: false, data: { txs: [], scope: { ...scope, complete: true } } }), "empty");
  assert.equal(activityView({ isLoading: false, isError: false, data: { txs: [] } }), "empty", "a testnet's explorer answer");
  const row = { hash: tx(1), from: SOMEONE, to: wallet(1), valueWei: "1", timestamp: 0, ok: true };
  assert.equal(activityView({ isLoading: false, isError: true, data: { txs: [row] } }), "list", "rows stay when a later read fails");
});

console.log(`selftest-activity-window: ${passed} checks passed`);
process.exit(0);
