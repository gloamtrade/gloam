/**
 * Self-test: the relay's gas ceiling (lib/relay/gasCeiling), for Ethereum.
 *
 *  - the ceiling: 3 gwei on chain 1 by default, none on the other chains,
 *    GLOAM_RELAY_MAX_GAS_GWEI_<chainId> sets or turns it off, and a value that
 *    is not a number keeps the default instead of lifting it
 *  - reading gas: over the ceiling is "high", a read that fails is "high" too,
 *    and a chain with no ceiling never reads the price
 *  - the relay against a fake Ethereum node: over the ceiling a private send
 *    or cash out is refused with gas_high and the plain message, before the
 *    dry run and before anything is sent, and the spend's lock is let go; the
 *    route answers 503; under it the send goes out with its max fee per gas
 *    capped at 1.5 times the ceiling; the status says gas is high while the
 *    relay stays on, and a spike does not make a funded relay look empty;
 *    scheduling a cash out for later still works while gas is high
 *  - scheduled cash outs: a due job waits while gas is high (still scheduled,
 *    no try counted, still cancellable, out of the due queue until its next
 *    look, never given up by the 2-hour rule), goes out once gas comes down,
 *    waits again if the relay refuses over gas at the last moment, and gives
 *    up after three days of high gas with nothing moved; one that may already
 *    be out is left to the chain
 *  - the scheduled row says it is waiting for gas
 *
 * fetch is stubbed: chain calls go to an in-process fake node at the
 * Ethereum RPC, and anything else fails. The relay key is a throwaway made
 * here. Nothing reaches any host.
 *
 * Run from app/:  ../mcp/node_modules/.bin/tsx scripts/selftest-gas-ceiling.mts
 */
import assert from "node:assert/strict";
import "./browser-shim.mjs";
import { parseTransaction, toFunctionSelector, toHex, type Address, type Hex } from "viem";
import { generatePrivateKey } from "viem/accounts";

delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;
delete process.env.CHAINALYSIS_API_KEY;
delete process.env.GLOAM_RELAY_MAX_GAS_GWEI_1;
delete process.env.GLOAM_RPC_URL_1;
process.env.GLOAM_RELAYER_PRIVATE_KEY = generatePrivateKey();

const POOL = "0x00000000000000000000000000000000000e7e01" as Address;
const mainnet = await import("../src/lib/mainnet");
mainnet.MAINNET_POOLS[1] = { pool: POOL, deployBlock: 23_000_000 };

const { getNetwork } = await import("../src/lib/networks");
const gas = await import("../src/lib/relay/gasCeiling");
const relay = await import("../src/lib/relay/server");
const { POST: relayPost } = await import("../src/app/api/relay/route");
const { inflightKey, takeInflight } = await import("../src/lib/relay/inflight");
const sched = await import("../src/lib/relay/scheduled");
const { scheduledLine } = await import("../src/components/app/PrivateCashOut");

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  await fn();
  passed++;
  console.log(`ok  ${name}`);
}

const GWEI = 1_000_000_000n;
const eth = getNetwork("ethereum-mainnet");
assert.equal(eth.pool, POOL, "Ethereum needs its placeholder pool for this test");
const RPC = eth.chain.rpcUrls.default.http[0]!.replace(/\/$/, "");
const PROOF = ("0x" + "22".repeat(256)) as Hex;
const H32 = ("0x" + "11".repeat(32)) as Hex;
const TX_HASH = ("0x" + "ab".repeat(32)) as Hex;
const CLEAN = "0x1111111111111111111111111111111111111111" as Address;
let n = 0;
function nullifier(): Hex {
  n++;
  return `0x${(0xe7e00000 + n).toString(16).padStart(64, "0")}` as Hex;
}

// ---------------------------------------------------------------- fake Ethereum node

const node = {
  gasPrice: 30_000_000n, // 0.03 gwei, a quiet day
  baseFee: 25_000_000n,
  tip: 1_000_000n,
  balance: 10n ** 17n,
  failGasPrice: false,
  dryRunGas: 500_000n,
};
const calls: string[] = [];
const raws: Hex[] = [];
const SEL = {
  spent: toFunctionSelector("spent(bytes32)"),
  isKnownRoot: toFunctionSelector("isKnownRoot(bytes32)"),
};
const word = (b: boolean) => "0x" + (b ? "1" : "0").padStart(64, "0");
const Z32 = "0x" + "00".repeat(32);
const block = () => ({
  number: "0x1",
  hash: "0x" + "12".repeat(32),
  parentHash: Z32,
  nonce: "0x0000000000000000",
  sha3Uncles: Z32,
  logsBloom: "0x" + "00".repeat(256),
  transactionsRoot: Z32,
  stateRoot: Z32,
  receiptsRoot: Z32,
  miner: "0x" + "00".repeat(20),
  difficulty: "0x0",
  totalDifficulty: "0x0",
  extraData: "0x",
  size: "0x1",
  gasLimit: "0x3938700",
  gasUsed: "0x0",
  timestamp: "0x1",
  baseFeePerGas: toHex(node.baseFee),
  transactions: [],
  uncles: [],
});

type RpcReq = { id: number; method: string; params?: unknown[] };
function answer(r: RpcReq): { result?: unknown; error?: { code: number; message: string } } {
  switch (r.method) {
    case "eth_chainId":
      return { result: "0x1" };
    case "eth_blockNumber":
      return { result: "0x1" };
    case "eth_getBlockByNumber":
      return { result: block() };
    case "eth_getTransactionCount":
      return { result: "0x0" };
    case "eth_getBalance":
      return { result: toHex(node.balance) };
    case "eth_gasPrice":
      if (node.failGasPrice) return { error: { code: -32000, message: "fake node: busy" } };
      return { result: toHex(node.gasPrice) };
    case "eth_maxPriorityFeePerGas":
      return { result: toHex(node.tip) };
    case "eth_estimateGas":
      return { result: toHex(node.dryRunGas) };
    case "eth_call": {
      const p = r.params?.[0] as { data?: string; input?: string };
      const sel = String(p?.data ?? p?.input).slice(0, 10);
      if (sel === SEL.spent) return { result: word(false) };
      if (sel === SEL.isKnownRoot) return { result: word(true) };
      return { error: { code: -32000, message: `fake node: unknown call ${sel}` } };
    }
    case "eth_sendRawTransaction":
      raws.push((r.params as Hex[])[0]!);
      return { result: TX_HASH };
    case "eth_getTransactionReceipt":
      return { result: { status: "0x1" } };
    default:
      return { error: { code: -32601, message: `fake node: ${r.method} not handled` } };
  }
}

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = (typeof input === "string" ? input : input instanceof URL ? input.href : input.url).replace(/\/$/, "");
  if (url !== RPC) throw new Error(`selftest: no network (${url})`);
  const body = JSON.parse(String(init?.body)) as RpcReq | RpcReq[];
  const list = Array.isArray(body) ? body : [body];
  for (const r of list) calls.push(r.method);
  const out = list.map((r) => ({ jsonrpc: "2.0", id: r.id, ...answer(r) }));
  return new Response(JSON.stringify(Array.isArray(body) ? out : out[0]), { status: 200, headers: { "Content-Type": "application/json" } });
}) as typeof fetch;

function setNode(state: Partial<typeof node>) {
  Object.assign(node, { gasPrice: 30_000_000n, baseFee: 25_000_000n, tip: 1_000_000n, balance: 10n ** 17n, failGasPrice: false, dryRunGas: 500_000n }, state);
  calls.length = 0;
  raws.length = 0;
  gas.resetGasReads();
}

const transferBody = (nul: Hex) => ({ proof: PROOF, root: H32, nullifier: nul, commitments: [H32, H32] });
const unshieldBody = (nul: Hex) => ({ proof: PROOF, root: H32, nullifier: nul, asset: "0x0000000000000000000000000000000000000000", to: CLEAN, amount: "1000" });
const isGasHigh = (e: unknown) => {
  assert.ok(e instanceof relay.RelayError, `expected a RelayError, got ${String(e)}`);
  assert.equal(e.code, "gas_high");
  assert.equal(e.status, 503);
  assert.equal(e.message, "Ethereum gas is high right now; try again shortly.");
  return true;
};

// ---------------------------------------------------------------- the ceiling

await test("3 gwei on Ethereum by default, no ceiling on the other chains", () => {
  assert.equal(gas.maxGasPriceWei(1, {}), 3n * GWEI);
  for (const id of [4663, 4217, 8453, 84532, 46630, 42431]) assert.equal(gas.maxGasPriceWei(id, {}), null, String(id));
  assert.equal(gas.maxFeeCapWei(3n * GWEI), 4_500_000_000n);
  assert.equal(gas.formatGwei(3n * GWEI), "3");
  assert.equal(gas.formatGwei(34_950_952n), "0.034");
  assert.equal(gas.formatGwei(12_500_000_000n), "12.5");
});

await test("GLOAM_RELAY_MAX_GAS_GWEI_<chainId> sets it, turns it off, and never lifts it by mistake", () => {
  assert.equal(gas.maxGasPriceWei(1, { GLOAM_RELAY_MAX_GAS_GWEI_1: "1.5" }), 1_500_000_000n);
  assert.equal(gas.maxGasPriceWei(1, { GLOAM_RELAY_MAX_GAS_GWEI_1: " 0.25 " }), 250_000_000n);
  assert.equal(gas.maxGasPriceWei(1, { GLOAM_RELAY_MAX_GAS_GWEI_1: "off" }), null);
  for (const bad of ["abc", "0", "-1", "1e3", "3gwei"]) {
    assert.equal(gas.maxGasPriceWei(1, { GLOAM_RELAY_MAX_GAS_GWEI_1: bad }), 3n * GWEI, `"${bad}" keeps the default`);
  }
  assert.equal(gas.maxGasPriceWei(8453, { GLOAM_RELAY_MAX_GAS_GWEI_8453: "0.5" }), 500_000_000n, "any chain can have one");
});

await test("reading gas: over the ceiling or unreadable is high; no ceiling, no read", async () => {
  let reads = 0;
  const client = (wei: bigint | null) => ({
    getGasPrice: async () => {
      reads++;
      if (wei === null) throw new Error("rpc down");
      return wei;
    },
  });
  gas.resetGasReads();
  assert.deepEqual(await gas.readGas(1, client(12n * GWEI), { env: {} }), { ceilingWei: 3n * GWEI, gasPriceWei: 12n * GWEI, high: true });
  // a fresh read for sends, a cached one for status polls
  assert.equal((await gas.readGas(1, client(GWEI), { env: {} })).high, true, "cached for a few seconds");
  assert.equal((await gas.readGas(1, client(GWEI), { env: {}, fresh: true })).high, false);
  assert.equal((await gas.readGas(1, client(3n * GWEI), { env: {}, fresh: true })).high, false, "at the ceiling is fine");
  assert.equal((await gas.readGas(1, client(null), { env: {}, fresh: true })).high, true, "can't read: wait");
  const before = reads;
  assert.deepEqual(await gas.readGas(4663, client(99n * GWEI), { env: {} }), { ceilingWei: null, gasPriceWei: null, high: false });
  assert.equal(reads, before, "a chain with no ceiling never reads the price");
});

// ---------------------------------------------------------------- the relay

await test("over the ceiling: a private send is refused before the dry run, nothing sent, the lock let go", async () => {
  setNode({ gasPrice: 12n * GWEI });
  const nul = nullifier();
  await assert.rejects(relay.relayTransfer(eth, transferBody(nul)), isGasHigh);
  assert.ok(!calls.includes("eth_estimateGas"), "no dry run");
  assert.ok(!calls.includes("eth_sendRawTransaction") && raws.length === 0, "nothing sent");
  const lock = await takeInflight(inflightKey(1, nul));
  assert.ok(lock, "the spend can be tried again at once");
  await lock.release();
});

await test("over the ceiling: a cash out is refused the same way, and the route answers 503 gas_high", async () => {
  setNode({ gasPrice: 50n * GWEI });
  await assert.rejects(relay.relayUnshield(eth, unshieldBody(nullifier())), isGasHigh);
  const res = await relayPost(
    new Request("http://localhost/api/relay", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": "203.0.113.77" },
      body: JSON.stringify({ chainId: 1, action: "unshield", ...unshieldBody(nullifier()) }),
    })
  );
  assert.equal(res.status, 503);
  const json = (await res.json()) as { ok: boolean; code: string; error: string };
  assert.deepEqual([json.ok, json.code, json.error], [false, "gas_high", "Ethereum gas is high right now; try again shortly."]);
  assert.equal(raws.length, 0);
});

await test("gas that can't be read counts as high", async () => {
  setNode({ failGasPrice: true });
  await assert.rejects(relay.relayTransfer(eth, transferBody(nullifier())), isGasHigh);
  assert.equal(raws.length, 0);
});

await test("under the ceiling: the send goes out, its max fee capped at 1.5 times the ceiling", async () => {
  // 2.9 gwei now, but the node suggests base 3 x 1.2 + 2 = 5.6 gwei: capped to 4.5
  setNode({ gasPrice: 2_900_000_000n, baseFee: 3n * GWEI, tip: 2n * GWEI });
  assert.equal(await relay.relayTransfer(eth, transferBody(nullifier())), TX_HASH);
  assert.equal(raws.length, 1);
  const tx = parseTransaction(raws[0]!);
  assert.equal(tx.chainId, 1);
  assert.equal(tx.maxFeePerGas, 4_500_000_000n, "never more than 1.5 x the ceiling");
  assert.equal(tx.maxPriorityFeePerGas, 2n * GWEI);
});

await test("a quiet day: the node's own fee suggestion, well under the cap", async () => {
  setNode({ gasPrice: 30_000_000n, baseFee: 25_000_000n, tip: 1_000_000n });
  assert.equal(await relay.relayUnshield(eth, unshieldBody(nullifier())), TX_HASH);
  const tx = parseTransaction(raws[0]!);
  assert.ok(tx.maxFeePerGas! < 100_000_000n, `about 0.03 gwei, got ${tx.maxFeePerGas}`);
  assert.equal(tx.maxPriorityFeePerGas, 1_000_000n);
});

await test("a tip above the cap is cut to it, so the send is still valid", async () => {
  setNode({ gasPrice: 2n * GWEI, baseFee: GWEI, tip: 9n * GWEI });
  await relay.relayTransfer(eth, transferBody(nullifier()));
  const tx = parseTransaction(raws[0]!);
  assert.equal(tx.maxFeePerGas, 4_500_000_000n);
  assert.equal(tx.maxPriorityFeePerGas, 4_500_000_000n);
});

await test("status: gas high is said plainly, the relay stays on, and a spike does not look like an empty relay", async () => {
  // 0.02 ETH covers two sends at the ceiling (2 x 2.4M gas x 3 gwei = 0.0144), not at 50 gwei
  setNode({ gasPrice: 50n * GWEI, balance: 2n * 10n ** 16n });
  const all = await relay.relayStatus();
  const s = all.find((x) => x.chainId === 1)!;
  assert.deepEqual(
    [s.enabled, s.lowBalance, s.gasHigh, s.maxGasGwei, s.gasGwei],
    [true, false, true, "3", "50"]
  );
  for (const other of all.filter((x) => x.chainId !== 1)) {
    assert.deepEqual([other.gasHigh, other.maxGasGwei, other.gasGwei], [false, null, null], `chain ${other.chainId} has no ceiling`);
  }
  // top-ups: off everywhere until the relay can seal them, then off on Ethereum mainnet only
  assert.ok(all.every((x) => x.topUps === false), "no job key: none");
  process.env.GLOAM_RELAY_JOB_KEY = "11".repeat(32);
  try {
    const keyed = await relay.relayStatus();
    for (const x of keyed) assert.equal(x.topUps, x.chainId !== 1, `chain ${x.chainId}`);
  } finally {
    delete process.env.GLOAM_RELAY_JOB_KEY;
  }
});

await test("a cash out for later still schedules while gas is high (it waits; the send is checked then)", async () => {
  setNode({ gasPrice: 50n * GWEI });
  const call = await relay.checkUnshieldForLater(eth, unshieldBody(nullifier()));
  assert.equal(call.kind, "unshield");
  assert.ok(calls.includes("eth_estimateGas"), "dry-run as usual");
  assert.equal(raws.length, 0);
});

await test("a cash out over its gas limit: refused after the dry run, nothing sent, now or for later", async () => {
  setNode({ dryRunGas: 20_000_000n });
  const isGasMost = (e: unknown) => {
    assert.ok(e instanceof relay.RelayError, `expected a RelayError, got ${String(e)}`);
    assert.equal(e.code, "gas_most");
    assert.equal(e.status, 422);
    assert.equal(e.message, relay.GAS_TOO_MUCH_MESSAGE);
    return true;
  };
  await assert.rejects(relay.relayUnshield(eth, unshieldBody(nullifier())), isGasMost);
  await assert.rejects(relay.checkUnshieldForLater(eth, unshieldBody(nullifier())), isGasMost);
  assert.equal(raws.length, 0, "nothing went out");

  setNode({ dryRunGas: relay.sendGasMost(1, "unshield")! });
  await relay.relayUnshield(eth, unshieldBody(nullifier()));
  assert.equal(raws.length, 1, "exactly at the limit still goes");
});

await test("the gas limit: a parent-chain cost gives Robinhood Chain more, Tempo and other sends have none", () => {
  assert.equal(relay.sendGasMost(1, "unshield"), 1_200_000n);
  assert.equal(relay.sendGasMost(8453, "unshield"), 1_200_000n);
  assert.equal(relay.sendGasMost(4663, "unshield"), 4_800_000n);
  assert.equal(relay.sendGasMost(4217, "unshield"), null);
  assert.equal(relay.sendGasMost(1, "transfer"), null);
});

// ---------------------------------------------------------------- scheduled cash outs

const HOUR = 3_600_000;
function job(over: Partial<import("../src/lib/relay/scheduled").CashOutJob> = {}) {
  const now = Date.UTC(2026, 9, 26, 12);
  return {
    id: `job-${++n}`,
    chainId: 1,
    proof: PROOF,
    root: H32,
    nullifier: nullifier(),
    asset: "0x0000000000000000000000000000000000000000" as Address,
    to: CLEAN,
    amount: "1000",
    createdAt: now - 2 * HOUR,
    sendAfter: now - 60_000,
    status: "scheduled" as const,
    attempts: 0,
    updatedAt: now - 2 * HOUR,
    ...over,
  };
}
function deps(state: { now: number; high: boolean | "throw"; sends: number; sendErr?: { code: string; message: string } }) {
  return {
    now: () => state.now,
    readChain: async () => ({ spent: false, knownRoot: true }),
    send: async () => {
      state.sends++;
      if (state.sendErr) throw Object.assign(new Error(state.sendErr.message), { code: state.sendErr.code });
      return TX_HASH;
    },
    gasHigh: async () => {
      if (state.high === "throw") throw new Error("rpc down");
      return state.high;
    },
  };
}

await test("a due job waits while gas is high: still scheduled, no try counted, out of the queue until its next look", async () => {
  const store = sched.memoryJobStore();
  const j = job();
  await store.put(j);
  const state = { now: j.sendAfter + 120_000, high: true as boolean | "throw", sends: 0 };
  const r = await sched.runDueJobs(store, deps(state));
  assert.deepEqual(r, [{ id: j.id, status: "scheduled" }]);
  assert.equal(state.sends, 0);
  const held = (await store.get(j.id))!;
  assert.equal(held.status, "scheduled");
  assert.equal(held.attempts, 0, "waiting for gas is not a try");
  assert.equal(held.reason, sched.GAS_WAIT_REASON);
  assert.equal(held.notBefore, state.now + sched.GAS_RECHECK_MS);
  assert.equal(sched.dueAt(held), held.notBefore);
  assert.deepEqual(await store.due(state.now + 60_000, 20), [], "not due again until its next look");
  assert.equal(sched.jobView(held).reason, sched.GAS_WAIT_REASON, "the app can say why");
  // a pass before the next look leaves it alone
  state.high = false;
  state.now += 60_000;
  assert.deepEqual(await sched.runDueJobs(store, deps(state)), []);
  assert.equal(state.sends, 0);
  // gas came down: it goes out, and no longer says it waits
  state.now = held.notBefore! + 1;
  assert.deepEqual(await sched.runDueJobs(store, deps(state)), [{ id: j.id, status: "sent" }]);
  const sent = (await store.get(j.id))!;
  assert.equal(state.sends, 1);
  assert.equal(sent.hash, TX_HASH);
  assert.equal(sent.reason, undefined);
  assert.equal(sent.notBefore, undefined);
});

await test("a job waiting for gas can still be cancelled", async () => {
  const store = sched.memoryJobStore();
  const j = job();
  await store.put(j);
  const state = { now: j.sendAfter + 1, high: true as boolean | "throw", sends: 0 };
  await sched.runDueJobs(store, deps(state));
  assert.equal(await sched.cancelJob(store, j.id, state.now + 1, j.nullifier), "cancelled");
});

await test("waiting for gas never uses up the 2-hour give-up time", async () => {
  const store = sched.memoryJobStore();
  const j = job();
  await store.put(j);
  const state = { now: j.sendAfter + sched.GIVE_UP_AFTER_MS + 10 * 60_000, high: true as boolean | "throw", sends: 0 };
  assert.deepEqual(await sched.runDueJobs(store, deps(state)), [{ id: j.id, status: "scheduled" }]);
  // and a busy relay after a long gas wait: that try counts, but the job keeps its chance
  state.high = false;
  state.now = (await store.get(j.id))!.notBefore! + 1;
  assert.deepEqual(await sched.runDueJobs(store, deps(state)), [{ id: j.id, status: "sent" }]);
});

await test("after a long gas wait, a passing problem gets its 2 hours from the end of the wait, not from the send time", async () => {
  for (const kind of ["busy", "rate_limit", "relay_empty", "check_failed", "read fails"]) {
    const store = sched.memoryJobStore();
    const j = job();
    await store.put(j);
    const state = { now: j.sendAfter + 1, high: true, failRead: false };
    const d = {
      now: () => state.now,
      readChain: async () => {
        if (state.failRead) throw new Error("rpc down");
        return { spent: false, knownRoot: true };
      },
      send: async (): Promise<Hex> => {
        throw Object.assign(new Error(kind), { code: kind });
      },
      gasHigh: async () => state.high,
    };
    // three hours of high gas, looked at every 5 minutes
    while (state.now < j.sendAfter + 3 * HOUR) {
      await sched.runDueJobs(store, d);
      state.now += sched.GAS_RECHECK_MS + 1;
    }
    // gas comes down, and the first pass meets one passing problem: it waits, it does not fail
    state.high = false;
    state.failRead = kind === "read fails";
    await sched.runDueJobs(store, d);
    const after = (await store.get(j.id))!;
    assert.equal(after.status, "scheduled", `${kind} right after a 3-hour gas wait`);
    if (kind !== "read fails") assert.equal(after.reason, kind, `${kind}: the reason is the new problem, not gas`);
    assert.equal(after.attempts, kind === "read fails" ? 0 : 1);
    // the 2-hour rule still holds, counted from the end of the wait
    state.now += sched.GIVE_UP_AFTER_MS + 60_000;
    await sched.runDueJobs(store, d);
    assert.equal((await store.get(j.id))!.status, "failed", `${kind} 2 hours after the gas wait ended`);
  }
});

await test("a relay that refuses over gas at the last moment: the job waits, the try not counted", async () => {
  const store = sched.memoryJobStore();
  const j = job();
  await store.put(j);
  const state = {
    now: j.sendAfter + 1,
    high: false as boolean | "throw",
    sends: 0,
    sendErr: { code: "gas_high", message: "Ethereum gas is high right now; try again shortly." },
  };
  assert.deepEqual(await sched.runDueJobs(store, deps(state)), [{ id: j.id, status: "scheduled" }]);
  const held = (await store.get(j.id))!;
  assert.equal(state.sends, 1);
  assert.equal(held.attempts, 0);
  assert.equal(held.maybeSent, undefined);
  assert.equal(held.reason, sched.GAS_WAIT_REASON);
  assert.equal(await sched.cancelJob(store, j.id, state.now + 1, j.nullifier), "cancelled", "still cancellable");
});

await test("a gas check that fails holds the job too", async () => {
  const store = sched.memoryJobStore();
  const j = job();
  await store.put(j);
  const state = { now: j.sendAfter + 1, high: "throw" as boolean | "throw", sends: 0 };
  assert.deepEqual(await sched.runDueJobs(store, deps(state)), [{ id: j.id, status: "scheduled" }]);
  assert.equal(state.sends, 0);
});

await test("three days of high gas: it gives up, nothing moved, the proof dropped", async () => {
  const store = sched.memoryJobStore();
  const j = job();
  await store.put(j);
  const state = { now: j.sendAfter + sched.GAS_WAIT_MAX_MS + 1, high: true as boolean | "throw", sends: 0 };
  assert.deepEqual(await sched.runDueJobs(store, deps(state)), [{ id: j.id, status: "failed" }]);
  const done = (await store.get(j.id))!;
  assert.equal(done.proof, "0x");
  assert.match(done.reason ?? "", /Nothing moved/);
  assert.equal(state.sends, 0);
});

await test("a job that may already be out is left to the chain while gas is high", async () => {
  const store = sched.memoryJobStore();
  const base = job();
  const j = { ...base, status: "sending" as const, attempts: 1, updatedAt: base.sendAfter, maybeSent: true };
  await store.put(j);
  const state = { now: j.updatedAt + sched.SENDING_STALE_MS + 1, high: true as boolean | "throw", sends: 0 };
  assert.deepEqual(await sched.runDueJobs(store, deps(state)), [{ id: j.id, status: "sending" }]);
  assert.equal(state.sends, 0);
  assert.equal((await store.get(j.id))!.maybeSent, true);
});

await test("without a gas check (no chain has a ceiling) jobs go out as before", async () => {
  const store = sched.memoryJobStore();
  const j = job({ chainId: 4663 });
  await store.put(j);
  const state = { now: j.sendAfter + 1, high: true as boolean | "throw", sends: 0 };
  const d = deps(state);
  const { gasHigh: _ignored, ...plain } = d;
  void _ignored;
  assert.deepEqual(await sched.runDueJobs(store, plain), [{ id: j.id, status: "sent" }]);
});

await test("the scheduled row says it is waiting for gas, only once its time has come", () => {
  const now = Date.UTC(2026, 9, 26, 12);
  const note = (at: number) =>
    ({ cashOut: { job: "j", at, to: CLEAN, state: "scheduled" } }) as unknown as Parameters<typeof scheduledLine>[0];
  assert.match(scheduledLine(note(now - 1), now, true), /^Waiting for gas to come down · to 0x1111/);
  assert.doesNotMatch(scheduledLine(note(now + HOUR), now, true), /Waiting for gas/);
  assert.doesNotMatch(scheduledLine(note(now - 1), now, false), /Waiting for gas/);
});

console.log(`gas ceiling: ${passed} passed`);
