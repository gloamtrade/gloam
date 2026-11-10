/**
 * Self-test: the vault view's chain reads (26 Oct 2026, perf).
 *
 * 1. A wallet's deposits (its Shielded logs) are read from the deploy block
 *    once per tab; after that only the blocks since the saved part, which
 *    ends RESCAN_OVERLAP blocks below the head it was read at. On Tempo
 *    testnet the full walk was about 40 log reads on every load.
 *    - the rows equal a full walk's, in the same order, after new deposits;
 *    - a deposit in the newest blocks is read again, never only remembered;
 *    - a saved part for another chain, vault or wallet, or one that does not
 *      parse, is never used;
 *    - two callers at once share one read.
 * 2. The spent checks ask about every note at once (one batch) instead of one
 *    read after another, and keep the old rule: only notes with a secret and a
 *    nullifier, on this chain and vault, not already spent here; a `true`
 *    marks the note spent, a failed read leaves it as it is.
 *
 * Run from app/:  ../mcp/node_modules/.bin/tsx scripts/selftest-deposit-scan.mts
 */
import assert from "node:assert/strict";
import "./browser-shim.mjs";
import { keccak256, toHex, type Address, type Hex } from "viem";

globalThis.fetch = (async (url: unknown) => {
  throw new Error(`selftest-deposit-scan: no network calls allowed (${String(url)})`);
}) as typeof fetch;

const scan = await import("../src/lib/depositScan");
const shield = await import("../src/lib/shield");
const spent = await import("../src/lib/spentCheck");

type LocalNote = import("../src/lib/shield").LocalNote;

const POOL = "0x841DC046Ea3CC842BA3A855731472c6Eb0F2d5eb" as Address;
const ME = "0x891E74a11abC5D0eC2EE855B2BD521fF9D18F411" as Address;
const OTHER = "0xb1E994586E62994648a0b866BF33F2EDd942512e" as Address;
const USD = "0x20C0000000000000000000000000000000000000" as Address;
const DEPLOY = 37_000_000n;
const NET = { chainId: 42431, pool: POOL, deployBlock: DEPLOY, logRange: 100_000n } as const;

type Dep = { bn: bigint; from: Address; commitment: Hex; leafIndex: bigint; amount: bigint; tx: Hex };
const deps: Dep[] = [];
let leaf = 0n;
function deposit(bn: bigint, from: Address = ME) {
  const commitment = keccak256(toHex(`c${leaf}`));
  deps.push({ bn, from, commitment, leafIndex: leaf, amount: 1_000_000n + leaf, tx: keccak256(toHex(`tx${leaf}`)) });
  leaf++;
}

/** A node that answers getLogs for the Shielded event, filtered by `from`, like the RPC. */
function fakeClient(head: () => bigint) {
  const calls: { from: bigint; to: bigint }[] = [];
  const client = {
    calls,
    getBlockNumber: async () => head(),
    getLogs: async (q: { address: Address; args?: { from?: Address }; fromBlock: bigint; toBlock: bigint }) => {
      const to = q.toBlock > head() ? head() : q.toBlock;
      assert.ok(to - q.fromBlock < NET.logRange, `a read wider than the node takes: ${q.fromBlock}..${q.toBlock}`);
      calls.push({ from: q.fromBlock, to });
      if (q.address.toLowerCase() !== POOL.toLowerCase()) return [];
      return deps
        .filter((d) => d.bn >= q.fromBlock && d.bn <= to && (!q.args?.from || d.from.toLowerCase() === q.args.from.toLowerCase()))
        .map((d) => ({
          args: { commitment: d.commitment, asset: USD, amount: d.amount, leafIndex: d.leafIndex, from: d.from },
          transactionHash: d.tx,
          blockNumber: d.bn,
        }));
    },
  };
  return client;
}

let pass = 0;
async function ok(name: string, fn: () => Promise<void> | void) {
  await fn();
  pass++;
  console.log(`ok  ${name}`);
}

// ---------------------------------------------------------------- 1. deposits

let head = DEPLOY + 3_950_000n;
deposit(DEPLOY + 10n);
deposit(DEPLOY + 1_200_000n, OTHER);
deposit(DEPLOY + 2_500_000n);
const c1 = fakeClient(() => head);

const first = await scan.scanDeposits(c1 as never, NET, ME);
await ok("the first load walks from the deploy block, in the node's spans", () => {
  assert.equal(c1.calls[0]!.from <= DEPLOY, true);
  assert.equal(c1.calls.length, 40);
  assert.deepEqual(first.map((r) => r.leafIndex), [0, 2]);
});

await ok("the next load reads only from the saved part's end, RESCAN_OVERLAP below the last head", async () => {
  head += 500n;
  deposit(head - 5n); // a new deposit in the newest blocks
  const c2 = fakeClient(() => head);
  const rows = await scan.scanDeposits(c2 as never, NET, ME);
  assert.equal(c2.calls.length, 1);
  assert.equal(c2.calls[0]!.from, DEPLOY + 3_950_000n - scan.RESCAN_OVERLAP + 1n);
  assert.deepEqual(rows.map((r) => r.leafIndex), [0, 2, 3]);
});

await ok("rows equal a full walk's, in order, and the newest blocks are always read again", async () => {
  // the deposit at head-5 is in the overlap: it was returned but not saved, so a
  // node that no longer shows it (a reorganised block) drops it next time
  const removed = deps.pop()!;
  const c3 = fakeClient(() => head);
  const rows = await scan.scanDeposits(c3 as never, NET, ME);
  assert.deepEqual(rows.map((r) => r.leafIndex), [0, 2]);
  deps.push(removed);
  scan.clearDepositScans();
  const full = await scan.scanDeposits(fakeClient(() => head) as never, NET, ME);
  const again = await scan.scanDeposits(fakeClient(() => head) as never, NET, ME);
  assert.deepEqual(again, full);
  assert.deepEqual(full.map((r) => r.leafIndex), [0, 2, 3]);
});

await ok("a node behind the saved part reads nothing new and keeps the rows", async () => {
  const behind = fakeClient(() => head - 10_000n);
  const rows = await scan.scanDeposits(behind as never, NET, ME);
  assert.equal(behind.calls.length, 0);
  assert.deepEqual(rows.map((r) => r.leafIndex), [0, 2]);
});

await ok("a saved part for another chain, vault or wallet is never used", async () => {
  const other = fakeClient(() => head);
  const rows = await scan.scanDeposits(other as never, NET, OTHER);
  assert.equal(other.calls.length, 40);
  assert.deepEqual(rows.map((r) => r.leafIndex), [1]);
  const chain = fakeClient(() => head);
  await scan.scanDeposits(chain as never, { ...NET, chainId: 4217 }, ME);
  assert.ok(chain.calls.length > 1);
  const vault = fakeClient(() => head);
  await scan.scanDeposits(vault as never, { ...NET, pool: "0x39e28cde55cab798874746ac52cb4b5cc99a0194" }, ME);
  assert.ok(vault.calls.length > 1);
});

await ok("a saved part that does not parse is ignored, and a full walk runs", async () => {
  scan.clearDepositScans();
  const key = `gloam.deposits.v1:${NET.chainId}:${POOL.toLowerCase()}:${ME.toLowerCase()}`;
  const bad = [
    "{not json",
    JSON.stringify({ v: 1, toBlock: String(head), rows: [{ commitment: "0x12", asset: USD, amount: "1", leafIndex: 0, txHash: null, bn: "1" }] }),
    // a row past the part's end
    JSON.stringify({ v: 1, toBlock: String(DEPLOY), rows: [{ commitment: deps[0]!.commitment, asset: USD, amount: "1", leafIndex: 0, txHash: null, bn: String(DEPLOY + 10n) }] }),
    JSON.stringify({ v: 2, toBlock: String(head), rows: [] }),
  ];
  for (const raw of bad) {
    scan.clearDepositScans();
    window.sessionStorage.setItem(key, raw);
    const c = fakeClient(() => head);
    const rows = await scan.scanDeposits(c as never, NET, ME);
    assert.equal(c.calls.length, 40, raw.slice(0, 40));
    assert.deepEqual(rows.map((r) => r.leafIndex), [0, 2, 3]);
  }
});

await ok("a first walk that stops halfway keeps what it read, and the next load starts there", async () => {
  scan.clearDepositScans();
  // the node goes away after 20 reads
  const c = fakeClient(() => head);
  const getLogs = c.getLogs;
  let n = 0;
  c.getLogs = (async (q: Parameters<typeof getLogs>[0]) => {
    if (++n > 20) throw new Error("connection reset");
    return getLogs(q);
  }) as typeof getLogs;
  await assert.rejects(scan.scanDeposits(c as never, NET, ME));
  // parts of 3 rounds of 3 spans (900k blocks) are saved as they end: 18 reads made it
  const c2 = fakeClient(() => head);
  const rows = await scan.scanDeposits(c2 as never, NET, ME);
  assert.equal(c2.calls[0]!.from, DEPLOY + 1_800_000n);
  assert.equal(c2.calls.length, 40 - 18);
  assert.deepEqual(rows.map((r) => r.leafIndex), [0, 2, 3]);
  const again = await scan.scanDeposits(fakeClient(() => head) as never, NET, ME);
  assert.deepEqual(again, rows);
});

await ok("two callers at once share one read", async () => {
  scan.clearDepositScans();
  const c = fakeClient(() => head);
  const [a, b] = await Promise.all([scan.scanDeposits(c as never, NET, ME), scan.scanDeposits(c as never, NET, ME)]);
  assert.equal(c.calls.length, 40);
  assert.deepEqual(a, b);
});

await ok("fetchChainShieldNotes builds the same rows as before (ids, amounts, chain-only, no secret)", async () => {
  scan.clearDepositScans();
  const net = { ...NET, key: "tempo" } as never;
  // createdAt is Date.now() - i per row, so under load a millisecond could tick between
  // two rows and tie them. The clock is held for the rows; the walk runs first on the
  // real clock (its reads are spaced by it), so the held call only reads the newest blocks.
  await scan.scanDeposits(fakeClient(() => head) as never, NET, ME);
  const realNow = Date.now;
  const frozen = realNow();
  Date.now = () => frozen;
  let notes: Awaited<ReturnType<typeof shield.fetchChainShieldNotes>>;
  try {
    notes = await shield.fetchChainShieldNotes(fakeClient(() => head) as never, ME, net);
  } finally {
    Date.now = realNow;
  }
  assert.equal(notes.length, 3);
  const d = deps[0]!;
  assert.deepEqual(
    { id: notes[0]!.id, asset: notes[0]!.asset, amountWei: notes[0]!.amountWei, commitment: notes[0]!.commitment, leafIndex: notes[0]!.leafIndex, txHash: notes[0]!.txHash, secret: notes[0]!.secret, source: notes[0]!.source, status: notes[0]!.status, chainId: notes[0]!.chainId, pool: notes[0]!.pool, from: notes[0]!.from },
    { id: `chain-${d.tx}-${d.leafIndex}`, asset: USD, amountWei: d.amount.toString(), commitment: d.commitment, leafIndex: 0, txHash: d.tx, secret: "0x", source: "chain", status: "open", chainId: 42431, pool: POOL, from: ME }
  );
  // newest first by createdAt, as before (merge sorts on it)
  assert.deepEqual(notes.map((x) => x.createdAt), [frozen, frozen - 1, frozen - 2]);
  // a chain that can't be read: no rows, as before
  const down = { getBlockNumber: async () => { throw new Error("down"); }, getLogs: async () => [] };
  scan.clearDepositScans();
  assert.deepEqual(await shield.fetchChainShieldNotes(down as never, ME, net), []);
});

// ---------------------------------------------------------------- 2. spent checks

function note(id: string, over: Partial<LocalNote> = {}): LocalNote {
  return {
    id,
    chainId: 42431,
    pool: POOL,
    asset: USD,
    amountWei: "1",
    commitment: keccak256(toHex(id)),
    secret: keccak256(toHex(`s-${id}`)),
    nullifier: keccak256(toHex(`n-${id}`)),
    createdAt: 1,
    status: "open",
    ...over,
  } as LocalNote;
}

await ok("spent checks: every note asked at once, the old rule for which, true marks, a failed read leaves it", async () => {
  const notes = [
    note("a"),
    note("b"),
    note("c"),
    note("d"),
    note("gone", { status: "recovered" }),
    note("chainrow", { secret: "0x" as Hex }),
    note("nonull", { nullifier: "0x" as Hex }),
    note("othernet", { chainId: 4217 }),
    note("othervault", { pool: "0x39e28cde55cab798874746ac52cb4b5cc99a0194" }),
  ];
  const asked: string[] = [];
  let inFlight = 0;
  let peak = 0;
  const release: (() => void)[] = [];
  const byNullifier = new Map(notes.map((n) => [n.nullifier!.toLowerCase(), n.id]));
  const client = {
    readContract: (q: { address: Address; functionName: string; args: [Hex] }) => {
      assert.equal(q.functionName, "isSpent");
      assert.equal(q.address, POOL);
      const id = byNullifier.get(q.args[0].toLowerCase())!;
      asked.push(id);
      inFlight++;
      peak = Math.max(peak, inFlight);
      return new Promise<boolean>((resolve, reject) => {
        release.push(() => {
          inFlight--;
          if (id === "c") reject(new Error("rpc down"));
          else resolve(id === "b" || id === "d");
        });
      });
    },
  };
  const marked: string[] = [];
  const p = spent.markSpentNotes(client as never, notes, NET, (id) => marked.push(id));
  await new Promise((r) => setTimeout(r, 10));
  // all four asked before any answered: one batch, not one after another
  assert.equal(peak, 4);
  assert.deepEqual(asked.sort(), ["a", "b", "c", "d"]);
  release.forEach((f) => f());
  assert.equal(await p, true);
  assert.deepEqual(marked.sort(), ["b", "d"]);
  // same candidates as the rule the hook used before (secret, nullifier, not spent, this chain and vault)
  assert.deepEqual(spent.spentCheckCandidates(notes, NET).map((n) => n.id), ["a", "b", "c", "d"]);
  // nothing to ask, nothing marked
  assert.equal(await spent.markSpentNotes(client as never, [note("gone2", { status: "recovered" })], NET, () => assert.fail()), false);
  assert.equal(await spent.markSpentNotes(client as never, notes, { ...NET, pool: null }, () => assert.fail()), false);
});

console.log(`deposit scan: ${pass} passed`);
