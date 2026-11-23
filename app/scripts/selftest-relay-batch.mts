/**
 * Self-test: a payment in parts sent as one transaction (lib/relay/batch,
 * lib/relay/server relayTransferBatch, api/relay action "transferBatch").
 *
 *  - the calls are built by the relay: only this network's vault (transfer) and
 *    memo board (postMemo, for the part's own payment), no value, through
 *    Multicall3's aggregate3 with allowFailure false
 *  - refused with nothing sent: one part or more than six, a part twice, a new
 *    note twice, a message where no memo board is live, a spent part, a batch
 *    bigger than its parts' gas room
 *  - every part's lock, all or none: one part already being sent refuses the
 *    batch and leaves the others free; a sent batch keeps every lock, one that
 *    may have gone out too, one refused before sending drops them all
 *  - every part's spend is on record with the one transaction
 *  - through the route, rate limits count each part
 *
 * fetch is stubbed: chain calls go to an in-process fake. The relay key is a
 * throwaway made here. Nothing reaches any host.
 *
 * Run from app/:  ../mcp/node_modules/.bin/tsx scripts/selftest-relay-batch.mts
 */
import assert from "node:assert/strict";
import { decodeFunctionData, getAddress, parseTransaction, toFunctionSelector, toHex, type Address, type Hex } from "viem";
import { generatePrivateKey } from "viem/accounts";

delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;
delete process.env.CHAINALYSIS_API_KEY;
process.env.GLOAM_RELAYER_PRIVATE_KEY = generatePrivateKey();

const server = await import("../src/lib/relay/server");
const batch = await import("../src/lib/relay/batch");
const { inflightKey, takeInflight, readSent } = await import("../src/lib/relay/inflight");
const { getNetwork } = await import("../src/lib/networks");
const { POST: relayPost } = await import("../src/app/api/relay/route");

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  await fn();
  passed++;
  console.log(`ok  ${name}`);
}
function isRelayError(code: string, status?: number) {
  return (e: unknown) => {
    assert.ok(e instanceof server.RelayError, `expected a RelayError, got ${String(e)}`);
    assert.equal(e.code, code);
    if (status !== undefined) assert.equal(e.status, status);
    return true;
  };
}

const net = getNetwork("robinhood");
assert.ok(net.pool && net.payMemo, "robinhood needs a pool and a memo board");
const POOL = getAddress(net.pool);
const BOARD = getAddress(net.payMemo.address);
const RPC = net.chain.rpcUrls.default.http[0]!;
const PROOF = ("0x" + "22".repeat(256)) as Hex;
const ROOT = ("0x" + "11".repeat(32)) as Hex;
const TX_HASH = ("0x" + "ab".repeat(32)) as Hex;
let counter = 0;
const fresh = (): Hex => `0x${(++counter).toString(16).padStart(64, "0")}` as Hex;

// ---------------------------------------------------------------- fake chain
const chain = {
  spent: new Set<string>(),
  estimate: 1_800_000n,
  send: "ok" as "ok" | "drop" | "reject",
};
const sentRaw: Hex[] = [];
const methods: string[] = [];
const SEL = {
  spent: toFunctionSelector("spent(bytes32)"),
  isKnownRoot: toFunctionSelector("isKnownRoot(bytes32)"),
  commitmentSeen: toFunctionSelector("commitmentSeen(bytes32)"),
};
const word = (b: boolean) => "0x" + (b ? "1" : "0").padStart(64, "0");
const Z32 = "0x" + "00".repeat(32);
const BLOCK = {
  number: "0x1", hash: "0x" + "12".repeat(32), parentHash: Z32, nonce: "0x0000000000000000", sha3Uncles: Z32,
  logsBloom: "0x" + "00".repeat(256), transactionsRoot: Z32, stateRoot: Z32, receiptsRoot: Z32, miner: "0x" + "00".repeat(20),
  difficulty: "0x0", totalDifficulty: "0x0", extraData: "0x", size: "0x1", gasLimit: "0x1c9c380", gasUsed: "0x0",
  timestamp: "0x1", baseFeePerGas: "0x1", transactions: [], uncles: [],
};
type RpcReq = { id: number; method: string; params?: unknown[] };
function answer(r: RpcReq): { result?: unknown; error?: { code: number; message: string } } {
  methods.push(r.method);
  switch (r.method) {
    case "eth_chainId":
      return { result: toHex(net.chainId) };
    case "eth_blockNumber":
      return { result: "0x1" };
    case "eth_getBlockByNumber":
      return { result: BLOCK };
    case "eth_getTransactionCount":
      return { result: "0x0" };
    case "eth_maxPriorityFeePerGas":
    case "eth_gasPrice":
      return { result: "0x1" };
    case "eth_estimateGas":
      return { result: toHex(chain.estimate) };
    case "eth_getBalance":
      return { result: toHex(10n ** 20n) };
    case "eth_call": {
      const p = r.params?.[0] as { data?: string; input?: string };
      const data = String(p?.data ?? p?.input);
      const sel = data.slice(0, 10);
      if (sel === SEL.spent) return { result: word(chain.spent.has(("0x" + data.slice(10, 74)).toLowerCase())) };
      if (sel === SEL.isKnownRoot) return { result: word(true) };
      if (sel === SEL.commitmentSeen) return { result: word(false) };
      return { error: { code: -32000, message: `fake chain: unknown call ${sel}` } };
    }
    case "eth_getTransactionByHash":
      return { result: null };
    case "eth_getTransactionReceipt":
      return { result: null };
    case "eth_sendRawTransaction":
      sentRaw.push(String(r.params?.[0]) as Hex);
      if (chain.send === "reject") return { error: { code: -32000, message: "insufficient funds for gas * price + value" } };
      return { result: TX_HASH };
    default:
      return { error: { code: -32601, message: `fake chain: ${r.method} not handled` } };
  }
}
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (!url.startsWith(RPC)) throw new Error(`selftest-relay-batch: no call to ${url}`);
  const body = JSON.parse(String(init?.body)) as RpcReq | RpcReq[];
  const list = Array.isArray(body) ? body : [body];
  if (chain.send === "drop" && list.some((r) => r.method === "eth_sendRawTransaction")) {
    for (const r of list) if (r.method === "eth_sendRawTransaction") sentRaw.push(String(r.params?.[0]) as Hex);
    throw new TypeError("fetch failed");
  }
  const out = list.map((r) => ({ jsonrpc: "2.0", id: r.id, ...answer(r) }));
  return new Response(JSON.stringify(Array.isArray(body) ? out : out[0]), { status: 200, headers: { "Content-Type": "application/json" } });
}) as typeof fetch;

function part(memo = false): { proof: Hex; root: Hex; nullifier: Hex; commitments: [Hex, Hex]; memo?: Hex } {
  return { proof: PROOF, root: ROOT, nullifier: fresh(), commitments: [fresh(), fresh()], ...(memo ? { memo: ("0x" + "aa".repeat(300)) as Hex } : {}) };
}
const free = async (nul: Hex) => {
  const lock = await takeInflight(inflightKey(net.chainId, nul), 5);
  if (lock) await lock.release();
  return lock !== null;
};

// ---------------------------------------------------------------- the calls
await test("a batch is only the vault's transfer and the memo board's postMemo, in order, through aggregate3", () => {
  const parts = [part(true), part(false), part(true)];
  const calls = batch.batchCalls(POOL, BOARD, parts);
  assert.deepEqual(
    calls.map((c) => c.target),
    [POOL, BOARD, POOL, POOL, BOARD],
    "transfer, its message, transfer, transfer, its message"
  );
  assert.ok(calls.every((c) => c.allowFailure === false), "nothing may fail on its own");
  const transferSel = toFunctionSelector("transfer(bytes,bytes32,bytes32,bytes32[2])");
  const memoSel = toFunctionSelector("postMemo(bytes32,bytes)");
  assert.deepEqual(calls.map((c) => c.callData.slice(0, 10)), [transferSel, memoSel, transferSel, transferSel, memoSel]);
  const memoArgs = decodeFunctionData({ abi: [{ type: "function", name: "postMemo", inputs: [{ type: "bytes32" }, { type: "bytes" }], outputs: [], stateMutability: "nonpayable" }], data: calls[1]!.callData }).args!;
  assert.equal(memoArgs[0], parts[0]!.commitments[0], "a message names its own part's payment");
  assert.throws(() => batch.batchCalls(POOL, null, [part(true)]), /No memo board/);
});

// ---------------------------------------------------------------- refused, nothing sent
await test("refused with nothing sent: wrong number of parts, a part or a note twice, a message with no board", async () => {
  const before = sentRaw.length;
  await assert.rejects(server.relayTransferBatch(net, { parts: [part()] }), isRelayError("batch_parts", 400));
  await assert.rejects(server.relayTransferBatch(net, { parts: Array.from({ length: 7 }, () => part()) }), isRelayError("batch_parts", 400));
  await assert.rejects(server.relayTransferBatch(net, { parts: "nope" }), isRelayError("batch_parts", 400));
  const a = part();
  await assert.rejects(server.relayTransferBatch(net, { parts: [a, { ...part(), nullifier: a.nullifier }] }), isRelayError("batch_repeat", 400));
  await assert.rejects(server.relayTransferBatch(net, { parts: [a, { ...part(), commitments: [a.commitments[0], fresh()] }] }), isRelayError("batch_repeat", 400));
  const noBoard = { ...net, payMemo: null };
  await assert.rejects(server.relayTransferBatch(noBoard as never, { parts: [part(true), part()] }), isRelayError("no_memo", 400));
  assert.equal(sentRaw.length, before, "nothing went out");
  assert.ok(await free(a.nullifier), "and no lock was left behind");
});

await test("a spent part refuses the batch before the dry run, and every lock is dropped", async () => {
  const parts = [part(), part(), part()];
  chain.spent.add(parts[1]!.nullifier.toLowerCase());
  methods.length = 0;
  const before = sentRaw.length;
  await assert.rejects(server.relayTransferBatch(net, { parts }), isRelayError("AlreadySpent", 409));
  assert.ok(!methods.includes("eth_estimateGas"), "no dry run");
  assert.equal(sentRaw.length, before);
  for (const p of parts) assert.ok(await free(p.nullifier), "lock dropped");
});

await test("one part already being sent refuses the batch, and leaves the other parts free", async () => {
  const parts = [part(), part(), part()];
  const held = await takeInflight(inflightKey(net.chainId, parts[1]!.nullifier), 60);
  assert.ok(held);
  const before = sentRaw.length;
  await assert.rejects(server.relayTransferBatch(net, { parts }), isRelayError("in_flight", 409));
  assert.equal(sentRaw.length, before);
  assert.ok(await free(parts[0]!.nullifier), "the first part's lock was given back");
  assert.ok(await free(parts[2]!.nullifier), "the last part was never locked");
  await held!.release();
});

await test("a batch bigger than its parts' gas room is refused as batch_big, nothing sent", async () => {
  const parts = [part(), part()];
  chain.estimate = 50_000_000n;
  const before = sentRaw.length;
  await assert.rejects(server.relayTransferBatch(net, { parts }), isRelayError("batch_big", 422));
  assert.equal(sentRaw.length, before);
  for (const p of parts) assert.ok(await free(p.nullifier));
  chain.estimate = 1_800_000n;
  assert.equal(server.batchGasMost(net.chainId, [{}, { memo: "0x01" }]), (2n * server.BATCH_TRANSFER_GAS_MOST + server.BATCH_MEMO_GAS_MOST) * 4n, "Robinhood Chain gets four times the room");
  assert.equal(server.batchGasMost(4217, [{}, {}]), null, "Tempo has no gas room, like every send there");
});

// ---------------------------------------------------------------- sent
await test("three parts and two messages go as one transaction to Multicall3, every lock kept, every spend on record", async () => {
  const parts = [part(true), part(false), part(true)];
  const before = sentRaw.length;
  const hash = await server.relayTransferBatch(net, { parts });
  assert.equal(hash, TX_HASH);
  assert.equal(sentRaw.length, before + 1, "one transaction");
  const tx = parseTransaction(sentRaw[sentRaw.length - 1]!);
  assert.equal(getAddress(tx.to!), batch.MULTICALL3, "to Multicall3");
  assert.equal(tx.value ?? 0n, 0n, "no value");
  const { args } = decodeFunctionData({ abi: batch.multicall3Abi, data: tx.data! });
  const calls = args![0] as readonly { target: Address; allowFailure: boolean; callData: Hex }[];
  assert.deepEqual(calls.map((c) => getAddress(c.target)), [POOL, BOARD, POOL, POOL, BOARD]);
  assert.ok(calls.every((c) => !c.allowFailure));
  for (const p of parts) {
    assert.ok(!(await free(p.nullifier)), "the lock stays while the batch may land");
    const rec = await readSent(inflightKey(net.chainId, p.nullifier));
    assert.equal(rec?.hash, TX_HASH, "each part's spend is on record with the one transaction");
  }
  // a copy of any part is refused while the batch may land
  await assert.rejects(server.relayTransfer(net, { proof: PROOF, root: ROOT, nullifier: parts[0]!.nullifier, commitments: parts[0]!.commitments }), isRelayError("in_flight", 409));
});

await test("a batch that may have gone out keeps every lock and says maybe_sent", async () => {
  const parts = [part(), part()];
  chain.send = "drop";
  await assert.rejects(server.relayTransferBatch(net, { parts }), isRelayError("maybe_sent", 502));
  chain.send = "ok";
  for (const p of parts) assert.ok(!(await free(p.nullifier)), "kept: it may land");
});

await test("a batch the node refuses outright drops every lock", async () => {
  const parts = [part(), part()];
  chain.send = "reject";
  await assert.rejects(server.relayTransferBatch(net, { parts }), (e: unknown) => e instanceof server.RelayError && e.code !== "maybe_sent");
  chain.send = "ok";
  for (const p of parts) assert.ok(await free(p.nullifier), "dropped: nothing went out");
});

// ---------------------------------------------------------------- the route
await test("through /api/relay: one hash back, and each part counts against the rate limits", async () => {
  const req = (parts: unknown[], ip: string) =>
    relayPost(
      new Request("https://gloam.trade/api/relay", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-forwarded-for": ip },
        body: JSON.stringify({ chainId: net.chainId, action: "transferBatch", parts }),
      })
    );
  const ok = await req([part(true), part()], "198.51.100.7");
  const body = (await ok.json()) as { ok: boolean; hash?: string };
  assert.equal(ok.status, 200);
  assert.deepEqual(body, { ok: true, hash: TX_HASH });
  // 400 requests per IP in ten minutes: six-part batches reach it after about 67, not 400
  let limitedAt = 0;
  for (let i = 1; i <= 80 && !limitedAt; i++) {
    const r = await req(Array.from({ length: 6 }, () => part()), "198.51.100.8");
    if (r.status === 429) limitedAt = i;
  }
  assert.ok(limitedAt > 0 && limitedAt <= 68, `six parts count as six sends against the limits (limited at batch ${limitedAt})`);
});

console.log(`\n${passed} relay batch checks passed`);
