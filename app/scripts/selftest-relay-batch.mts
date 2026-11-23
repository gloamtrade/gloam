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
 *  - only on a network with the canonical Multicall3: outside BATCH_CHAIN_IDS, or with
 *    other code at its address, a batch is refused as batch_network, nothing sent
 *  - never where the mempool is public (Ethereum, Sepolia, BNB Chain): a part copied
 *    and sent ahead would make the relay pay for the rest in a revert, so a payment or
 *    a cash out in one go is refused there as batch_network, before any read or lock
 *
 * A cash out in one go (relayUnshieldBatch, action "unshieldBatch"):
 *  - the calls are only the vault's unshield, one per part, on this network's vault, not
 *    allowed to fail; unshieldBatchProblem refuses any other call, target or part
 *  - refused with nothing sent: one part or a 7th, another vault, two wallets or two
 *    assets, a part twice, a bad proof or amount or fee, a wallet that strands the money
 *    (the vault) or is a swap's escrow or is sanctioned, a fee higher than the one
 *    confirmed, a spent part, a part already being sent, a batch past its gas room
 *  - sent: one transaction to Multicall3, no value, every lock kept, every spend on record
 *  - may have gone out keeps every lock; refused by the node drops them all
 *  - through the route, rate limits count each part
 *
 * A note that keeps reverting (lib/relay/server assertNoteUnderReverts): either one in
 * one go that reverts on chain counts a revert against every part's note; one part whose
 * note reverted twice this hour refuses the batch as note_wait before its dry run, every
 * lock dropped, and the other parts still go; one that lands or may have gone out counts
 * nothing.
 *
 * A partner's link (lib/partnerAttribution): either one in one go hands its
 * before-broadcast hook the one aggregate3 call that goes out, which names every
 * part; a batch refused before it goes out never calls it, one the node refuses
 * takes it back; through the route, a link's code and payment tag change nothing
 * about the send.
 *
 * fetch is stubbed: chain calls go to an in-process fake. The relay key is a
 * throwaway made here. Nothing reaches any host.
 *
 * Run from app/:  ../mcp/node_modules/.bin/tsx scripts/selftest-relay-batch.mts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { decodeFunctionData, encodeFunctionData, getAddress, keccak256, parseTransaction, toFunctionSelector, toHex, type Address, type Hex } from "viem";
import { generatePrivateKey } from "viem/accounts";

delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;
delete process.env.CHAINALYSIS_API_KEY;
process.env.GLOAM_RELAYER_PRIVATE_KEY = generatePrivateKey();

const server = await import("../src/lib/relay/server");
const batch = await import("../src/lib/relay/batch");
const { inflightKey, takeInflight, readSent, markSwapEscrow } = await import("../src/lib/relay/inflight");
const { getNetwork } = await import("../src/lib/networks");
const { readRateLimit } = await import("../src/lib/mcpRemote/rateLimit");
const { POST: relayPost } = await import("../src/app/api/relay/route");
const { spendIdOf } = await import("../src/lib/partnerAttribution");

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
/** Multicall3's runtime code as Base mainnet holds it (fixtures/multicall3-runtime.json). */
const MULTICALL3_CODE = (JSON.parse(readFileSync(new URL("./fixtures/multicall3-runtime.json", import.meta.url), "utf8")) as { code: Hex }).code;
assert.equal(keccak256(MULTICALL3_CODE), batch.MULTICALL3_CODEHASH, "the fixture is the canonical Multicall3");
const chain = {
  spent: new Set<string>(),
  estimate: 1_800_000n,
  send: "ok" as "ok" | "drop" | "reject",
  /** What eth_getCode answers at MULTICALL3. */
  code: MULTICALL3_CODE as Hex,
  /** The vault's cash-out fee, in basis points. */
  feeBps: 50,
  /** How the sent transaction ended, or "none" for no receipt yet. */
  receipt: "none" as "none" | "success" | "reverted",
};
const sentRaw: Hex[] = [];
const methods: string[] = [];
const SEL = {
  spent: toFunctionSelector("spent(bytes32)"),
  isKnownRoot: toFunctionSelector("isKnownRoot(bytes32)"),
  commitmentSeen: toFunctionSelector("commitmentSeen(bytes32)"),
  withdrawFeeBps: toFunctionSelector("withdrawFeeBps()"),
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
    case "eth_getCode": {
      const at = String(r.params?.[0]).toLowerCase();
      return { result: at === batch.MULTICALL3.toLowerCase() ? chain.code : "0x" };
    }
    case "eth_call": {
      const p = r.params?.[0] as { data?: string; input?: string };
      const data = String(p?.data ?? p?.input);
      const sel = data.slice(0, 10);
      if (sel === SEL.spent) return { result: word(chain.spent.has(("0x" + data.slice(10, 74)).toLowerCase())) };
      if (sel === SEL.isKnownRoot) return { result: word(true) };
      if (sel === SEL.commitmentSeen) return { result: word(false) };
      if (sel === SEL.withdrawFeeBps) return { result: "0x" + chain.feeBps.toString(16).padStart(64, "0") };
      return { error: { code: -32000, message: `fake chain: unknown call ${sel}` } };
    }
    case "eth_getTransactionByHash":
      return { result: null };
    case "eth_getTransactionReceipt":
      if (chain.receipt === "none") return { result: null };
      return {
        result: {
          transactionHash: String(r.params?.[0]),
          transactionIndex: "0x0",
          blockHash: BLOCK.hash,
          blockNumber: "0x1",
          from: "0x" + "00".repeat(20),
          to: batch.MULTICALL3,
          cumulativeGasUsed: "0x1",
          gasUsed: "0x1",
          effectiveGasPrice: "0x1",
          contractAddress: null,
          logs: [],
          logsBloom: BLOCK.logsBloom,
          status: chain.receipt === "success" ? "0x1" : "0x0",
          type: "0x2",
        },
      };
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

// ---------------------------------------------------------------- only where Multicall3 is
await test("a payment in one go is refused as batch_network outside BATCH_CHAIN_IDS, before any lock or chain call", async () => {
  const elsewhere = { ...net, chainId: 31337 };
  const parts = [part(), part()];
  methods.length = 0;
  const before = sentRaw.length;
  await assert.rejects(server.relayTransferBatch(elsewhere as never, { parts }), isRelayError("batch_network", 400));
  assert.equal(methods.length, 0, "no chain call");
  assert.equal(sentRaw.length, before);
  for (const p of parts) assert.ok(await free(p.nullifier), "no lock taken");
});

await test("other code at MULTICALL3, or none, refuses a payment in one go as batch_network, every lock dropped; the right code is read once", async () => {
  for (const code of ["0x", "0x6080604052"] as Hex[]) {
    server.resetMulticall3Seen();
    chain.code = code;
    const parts = [part(), part()];
    methods.length = 0;
    const before = sentRaw.length;
    await assert.rejects(server.relayTransferBatch(net, { parts }), isRelayError("batch_network", 400));
    assert.ok(!methods.includes("eth_estimateGas"), "no dry run");
    assert.equal(sentRaw.length, before);
    for (const p of parts) assert.ok(await free(p.nullifier), "lock dropped");
  }
  chain.code = MULTICALL3_CODE;
  server.resetMulticall3Seen();
  methods.length = 0;
  await server.relayTransferBatch(net, { parts: [part(), part()] });
  await server.relayTransferBatch(net, { parts: [part(), part()] });
  assert.equal(methods.filter((m) => m === "eth_getCode").length, 1, "read once for this network");
});

// ---------------------------------------------------------------- cash outs in one go
const CLEAN = getAddress("0x1111111111111111111111111111111111111111");
const OTHER = getAddress("0x3333333333333333333333333333333333333333");
// Lazarus Group (Ronin bridge exploit), on the OFAC SDN list since 2022-04-14
const LISTED = getAddress("0x098b716b8aaf21512996dc57eb0615e2383e2f96");
const ASSET = getAddress("0x4444444444444444444444444444444444444444");
const ASSET2 = getAddress("0x5555555555555555555555555555555555555555");
type CashPart = { proof: Hex; root: Hex; nullifier: Hex; asset: Address; to: Address; amount: string };
function cash(over: Partial<CashPart> = {}): CashPart {
  return { proof: PROOF, root: ROOT, nullifier: fresh(), asset: ASSET, to: CLEAN, amount: "10000000", ...over };
}
const cashBody = (parts: unknown[], over: Record<string, unknown> = {}) => ({ pool: POOL, feeBps: 50, parts, ...over });
const asBatchPart = (p: CashPart) => ({ ...p, amount: BigInt(p.amount) });
const unshieldSel = toFunctionSelector("unshield(bytes,bytes32,bytes32,address,address,uint256)");

await test("a cash out in one go is only the vault's unshield, once per part, on this vault, nothing allowed to fail", () => {
  const parts = [cash(), cash({ amount: "7000000" }), cash({ amount: "3000000" })].map(asBatchPart);
  const calls = batch.unshieldBatchCalls(POOL, parts);
  assert.equal(calls.length, 3);
  assert.ok(calls.every((c) => c.target === POOL && c.allowFailure === false && c.callData.slice(0, 10) === unshieldSel));
  assert.equal(batch.unshieldBatchProblem(POOL, parts, calls), null, "the calls it builds pass its own check");
  const unshieldArgs = decodeFunctionData({ abi: server.relayPoolAbi, data: calls[1]!.callData }).args!;
  assert.deepEqual(unshieldArgs, [parts[1]!.proof, parts[1]!.root, parts[1]!.nullifier, parts[1]!.asset, parts[1]!.to, parts[1]!.amount]);
});

await test("unshieldBatchProblem refuses a non-unshield call, another target, a call allowed to fail, a call for another part, extra bytes, a call too many", () => {
  const parts = [cash(), cash()].map(asBatchPart);
  const good = batch.unshieldBatchCalls(POOL, parts);
  const swap = (i: number, c: Partial<(typeof good)[number]>) => good.map((g, j) => (j === i ? { ...g, ...c } : g));
  // the vault's transfer, the vault's spent(), postMemo on the board: none is a cash out
  const transfer = encodeFunctionData({ abi: server.relayPoolAbi, functionName: "transfer", args: [PROOF, ROOT, parts[1]!.nullifier, [fresh(), fresh()]] });
  const spentCall = encodeFunctionData({ abi: server.relayPoolAbi, functionName: "spent", args: [parts[1]!.nullifier] });
  assert.match(String(batch.unshieldBatchProblem(POOL, parts, swap(1, { callData: transfer }))), /only calls the vault's unshield/);
  assert.match(String(batch.unshieldBatchProblem(POOL, parts, swap(1, { callData: spentCall }))), /only calls the vault's unshield/);
  assert.match(String(batch.unshieldBatchProblem(POOL, parts, swap(0, { target: BOARD }))), /only calls this network's vault/);
  assert.match(String(batch.unshieldBatchProblem(POOL, parts, swap(0, { target: batch.MULTICALL3 }))), /only calls this network's vault/);
  assert.match(String(batch.unshieldBatchProblem(OTHER, parts, good)), /only calls this network's vault/, "a wrong pool");
  assert.match(String(batch.unshieldBatchProblem(POOL, parts, swap(0, { allowFailure: true as false }))), /may fail on its own/);
  const otherWallet = batch.unshieldBatchCalls(POOL, [parts[0]!, { ...parts[1]!, to: OTHER }]);
  assert.match(String(batch.unshieldBatchProblem(POOL, parts, otherWallet)), /isn't the part it was given for/, "another wallet");
  const otherAmount = batch.unshieldBatchCalls(POOL, [parts[0]!, { ...parts[1]!, amount: parts[1]!.amount + 1n }]);
  assert.match(String(batch.unshieldBatchProblem(POOL, parts, otherAmount)), /isn't the part it was given for/, "another amount");
  assert.match(String(batch.unshieldBatchProblem(POOL, parts, swap(1, { callData: (good[1]!.callData + "00") as Hex }))), /isn't the part it was given for/, "bytes tacked on");
  assert.match(String(batch.unshieldBatchProblem(POOL, parts, [...good, good[0]!])), /one call per part/, "a call too many");
});

await test("cash out in one go, refused with nothing sent and no lock: parts, vault, wallets, assets, repeats, formats, fee", async () => {
  const before = sentRaw.length;
  methods.length = 0;
  const a = cash();
  const refusals: [Record<string, unknown>, string, number][] = [
    [cashBody([cash()]), "batch_parts", 400],
    [cashBody(Array.from({ length: 7 }, () => cash())), "batch_parts", 400],
    [cashBody("nope" as never), "batch_parts", 400],
    [cashBody([cash(), cash()], { pool: OTHER }), "batch_pool", 400],
    [cashBody([cash(), cash()], { pool: undefined }), "bad_request", 400],
    [cashBody([a, cash({ to: OTHER })]), "batch_mismatch", 400],
    [cashBody([a, cash({ asset: ASSET2 })]), "batch_mismatch", 400],
    [cashBody([a, cash({ nullifier: a.nullifier })]), "batch_repeat", 400],
    [cashBody([a, cash({ proof: "0x1234" })]), "bad_request", 400],
    [cashBody([a, cash({ amount: "0" })]), "bad_request", 400],
    [cashBody([a, cash({ amount: 5 as never })]), "bad_request", 400],
    [cashBody([a, cash()], { feeBps: undefined }), "bad_request", 400],
    [cashBody([a, cash()], { feeBps: -1 }), "bad_request", 400],
    [cashBody([a, cash()], { feeBps: 0.5 }), "bad_request", 400],
    [cashBody([cash({ to: POOL }), cash({ to: POOL })]), "vault_recipient", 400],
    [cashBody([cash({ to: BOARD }), cash({ to: BOARD })]), "vault_recipient", 400],
    [cashBody([cash({ to: LISTED }), cash({ to: LISTED })]), "screened", 403],
  ];
  for (const [body, code, status] of refusals) {
    await assert.rejects(server.relayUnshieldBatch(net, body), isRelayError(code, status), `${code}: ${JSON.stringify(body).slice(0, 80)}`);
  }
  await assert.rejects(server.relayUnshieldBatch({ ...net, chainId: 31337 } as never, cashBody([cash(), cash()])), isRelayError("batch_network", 400));
  assert.equal(sentRaw.length, before, "nothing went out");
  assert.equal(methods.length, 0, "and nothing was read from the chain");
  assert.ok(await free(a.nullifier), "no lock left behind");
});

await test("Ethereum, Sepolia and BNB Chain have a public mempool: a payment or a cash out in one go is refused there as batch_network, nothing read, sent or locked", async () => {
  const { PUBLIC_MEMPOOL_CHAINS } = await import("../src/lib/partnerCode");
  assert.deepEqual([...batch.FRONT_RUN_CHAIN_IDS].sort((a, b) => a - b), [1, 56, 11155111]);
  for (const id of batch.FRONT_RUN_CHAIN_IDS) assert.ok(PUBLIC_MEMPOOL_CHAINS.includes(id), `${id} is a public-mempool chain for links too`);
  const freeOn = async (chainId: number, nul: Hex) => {
    const lock = await takeInflight(inflightKey(chainId, nul), 5);
    if (lock) await lock.release();
    return lock !== null;
  };
  for (const key of ["ethereum-mainnet", "ethereum", "bnb-mainnet"] as const) {
    const there = getNetwork(key);
    assert.ok(batch.MULTICALL3_CHAIN_IDS.includes(there.chainId), `${key}: Multicall3 is there`);
    assert.equal(batch.batchesOn(there.chainId), false, `${key}: its parts go one by one`);
    const parts = [part(true), part()];
    const cashParts = [cash(), cash()];
    methods.length = 0;
    const before = sentRaw.length;
    await assert.rejects(server.relayTransferBatch(there, { parts }), isRelayError("batch_network", 400), `${key}: a payment in one go`);
    await assert.rejects(server.relayUnshieldBatch(there, cashBody(cashParts, { pool: there.pool ?? POOL })), isRelayError("batch_network", 400), `${key}: a cash out in one go`);
    assert.equal(methods.length, 0, `${key}: no chain call`);
    assert.equal(sentRaw.length, before, `${key}: nothing sent`);
    for (const p of [...parts, ...cashParts]) assert.ok(await freeOn(there.chainId, p.nullifier), `${key}: no lock taken`);
  }
  // everywhere else Multicall3 is, the parts still go in one
  for (const id of batch.MULTICALL3_CHAIN_IDS) assert.equal(batch.batchesOn(id), !batch.FRONT_RUN_CHAIN_IDS.includes(id), `chain ${id}`);
  for (const key of ["robinhood-mainnet", "tempo-mainnet", "base-mainnet", "elysium-mainnet", "robinhood", "tempo", "base", "elysium"] as const) {
    assert.equal(batch.batchesOn(getNetwork(key).chainId), true, `${key} sends in one go`);
  }
});

await test("a cash out in one go to a swap's escrow is refused, as a single cash out is", async () => {
  const escrow = getAddress("0x6666666666666666666666666666666666666666");
  await markSwapEscrow(net.chainId, escrow);
  const parts = [cash({ to: escrow }), cash({ to: escrow })];
  await assert.rejects(server.relayUnshieldBatch(net, cashBody(parts)), isRelayError("vault_recipient", 400));
  for (const p of parts) assert.ok(await free(p.nullifier));
});

await test("a vault fee higher than the one confirmed refuses it as fee_moved, every lock dropped; the same or lower goes", async () => {
  chain.feeBps = 60;
  const parts = [cash(), cash()];
  const before = sentRaw.length;
  methods.length = 0;
  await assert.rejects(server.relayUnshieldBatch(net, cashBody(parts, { feeBps: 50 })), isRelayError(batch.FEE_MOVED_CODE, 409));
  assert.ok(!methods.includes("eth_estimateGas"), "no dry run");
  assert.equal(sentRaw.length, before);
  for (const p of parts) assert.ok(await free(p.nullifier), "lock dropped");
  chain.feeBps = 50;
  assert.equal(await server.relayUnshieldBatch(net, cashBody([cash(), cash()], { feeBps: 50 })), TX_HASH, "the fee confirmed");
  chain.feeBps = 25;
  assert.equal(await server.relayUnshieldBatch(net, cashBody([cash(), cash()], { feeBps: 50 })), TX_HASH, "a lower fee pays more than shown");
  chain.feeBps = 50;
});

await test("a spent part refuses the cash out before the dry run; a part already being sent refuses it and leaves the rest free", async () => {
  const parts = [cash(), cash(), cash()];
  chain.spent.add(parts[2]!.nullifier.toLowerCase());
  methods.length = 0;
  const before = sentRaw.length;
  await assert.rejects(server.relayUnshieldBatch(net, cashBody(parts)), isRelayError("AlreadySpent", 409));
  assert.ok(!methods.includes("eth_estimateGas"));
  for (const p of parts) assert.ok(await free(p.nullifier));
  const parts2 = [cash(), cash(), cash()];
  const held = await takeInflight(inflightKey(net.chainId, parts2[1]!.nullifier), 60);
  await assert.rejects(server.relayUnshieldBatch(net, cashBody(parts2)), isRelayError("in_flight", 409));
  assert.ok(await free(parts2[0]!.nullifier));
  assert.ok(await free(parts2[2]!.nullifier));
  await held!.release();
  assert.equal(sentRaw.length, before);
});

await test("a cash out in one go past its parts' summed cash-out gas room is refused as batch_big, nothing sent", async () => {
  // Robinhood Chain: 1.2M a cash out, times four for the parent chain, per part
  assert.equal(server.unshieldBatchGasMost(net.chainId, 3), 3n * 1_200_000n * 4n);
  assert.equal(server.unshieldBatchGasMost(8453, 3), 3n * 1_200_000n, "Base: a single cash out's room per part");
  assert.equal(server.unshieldBatchGasMost(4217, 3), null, "Tempo: none, like every send there");
  chain.estimate = 2n * 1_200_000n * 4n + 1n;
  const parts = [cash(), cash()];
  const before = sentRaw.length;
  await assert.rejects(server.relayUnshieldBatch(net, cashBody(parts)), isRelayError("batch_big", 422));
  assert.equal(sentRaw.length, before);
  for (const p of parts) assert.ok(await free(p.nullifier));
  chain.estimate = 1_800_000n;
});

await test("three cash outs go as one transaction to Multicall3: only their unshields on the vault, no value, every lock kept, every spend on record", async () => {
  const parts = [cash(), cash({ amount: "7000000" }), cash({ amount: "3000000" })];
  const before = sentRaw.length;
  // a request can't name anything else to call: extra fields are never read
  const sneaky = {
    calls: [{ target: BOARD, allowFailure: true, callData: "0xdeadbeef" }],
    target: BOARD,
    data: "0xdeadbeef",
    value: "1",
  };
  const hash = await server.relayUnshieldBatch(net, cashBody(parts.map((p) => ({ ...p, target: BOARD, callData: "0xdeadbeef" })), sneaky));
  assert.equal(hash, TX_HASH);
  assert.equal(sentRaw.length, before + 1, "one transaction");
  const tx = parseTransaction(sentRaw[sentRaw.length - 1]!);
  assert.equal(getAddress(tx.to!), batch.MULTICALL3);
  assert.equal(tx.value ?? 0n, 0n, "no value");
  const { functionName, args } = decodeFunctionData({ abi: batch.multicall3Abi, data: tx.data! });
  assert.equal(functionName, "aggregate3");
  const calls = args![0] as readonly { target: Address; allowFailure: boolean; callData: Hex }[];
  assert.equal(batch.unshieldBatchProblem(POOL, parts.map(asBatchPart), calls), null, "exactly the three parts' unshields");
  for (const p of parts) {
    assert.ok(!(await free(p.nullifier)), "the lock stays while it may land");
    assert.equal((await readSent(inflightKey(net.chainId, p.nullifier)))?.hash, TX_HASH, "each spend on record with the one transaction");
  }
  // a copy of any part, alone or in another batch, is refused while it may land
  await assert.rejects(server.relayUnshield(net, { ...parts[0]! }), isRelayError("in_flight", 409));
  await assert.rejects(server.relayUnshieldBatch(net, cashBody([parts[1]!, cash()])), isRelayError("in_flight", 409));
});

await test("a cash out in one go that may have gone out keeps every lock; one the node refuses drops them all", async () => {
  const maybe = [cash(), cash()];
  chain.send = "drop";
  await assert.rejects(server.relayUnshieldBatch(net, cashBody(maybe)), isRelayError("maybe_sent", 502));
  for (const p of maybe) assert.ok(!(await free(p.nullifier)), "kept: it may land");
  const refused = [cash(), cash()];
  chain.send = "reject";
  await assert.rejects(server.relayUnshieldBatch(net, cashBody(refused)), (e: unknown) => e instanceof server.RelayError && e.code !== "maybe_sent");
  chain.send = "ok";
  for (const p of refused) assert.ok(await free(p.nullifier), "dropped: nothing went out");
});

await test("through /api/relay: unshieldBatch answers one hash, each part counts against the rate limits, a partner code changes nothing", async () => {
  const req = (body: Record<string, unknown>, ip: string) =>
    relayPost(
      new Request("https://gloam.trade/api/relay", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-forwarded-for": ip },
        body: JSON.stringify({ chainId: net.chainId, action: "unshieldBatch", ...body }),
      })
    );
  const ok = await req(cashBody([cash(), cash()], { partnerCode: "abc" }), "198.51.100.17");
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { ok: true, hash: TX_HASH });
  const bad = await req(cashBody([cash(), cash({ to: OTHER })]), "198.51.100.17");
  assert.equal(bad.status, 400);
  assert.equal(((await bad.json()) as { code: string }).code, "batch_mismatch");
  let limitedAt = 0;
  for (let i = 1; i <= 80 && !limitedAt; i++) {
    const r = await req(cashBody(Array.from({ length: 6 }, () => cash())), "198.51.100.18");
    if (r.status === 429) limitedAt = i;
  }
  assert.ok(limitedAt > 0 && limitedAt <= 68, `six parts count as six cash outs against the limits (limited at batch ${limitedAt})`);
});

// ---------------------------------------------------------------- a partner's link
await test("a partner link's hook is handed the one aggregate3 call that goes out, naming every part; never for a refused batch", async () => {
  const handed: { to: Address; data: Hex }[] = [];
  let undone = 0;
  const hooks = {
    beforeBroadcast: (tx: { to: Address; data: Hex }) => {
      handed.push(tx);
      return () => void undone++;
    },
  };
  // a payment in one go
  const parts = [part(true), part(), part(true)];
  assert.equal(await server.relayTransferBatch(net, { parts }, undefined, hooks), TX_HASH);
  assert.equal(handed.length, 1);
  assert.equal(getAddress(handed[0]!.to), batch.MULTICALL3);
  assert.equal(handed[0]!.data, parseTransaction(sentRaw[sentRaw.length - 1]!).data, "exactly the call that went out");
  assert.deepEqual(spendIdOf(net, { to: handed[0]!.to, input: handed[0]!.data })?.nullifiers, parts.map((p) => p.nullifier));
  // a cash out in one go
  const cashParts = [cash(), cash({ amount: "7000000" })];
  assert.equal(await server.relayUnshieldBatch(net, cashBody(cashParts), undefined, hooks), TX_HASH);
  assert.equal(handed.length, 2);
  assert.equal(getAddress(handed[1]!.to), batch.MULTICALL3);
  assert.equal(handed[1]!.data, parseTransaction(sentRaw[sentRaw.length - 1]!).data);
  assert.deepEqual(spendIdOf(net, { to: handed[1]!.to, input: handed[1]!.data })?.nullifiers, cashParts.map((p) => p.nullifier));
  // refused before anything goes out: never called
  await assert.rejects(server.relayTransferBatch(net, { parts: [part()] }, undefined, hooks), isRelayError("batch_parts", 400));
  await assert.rejects(server.relayUnshieldBatch(net, cashBody([cash(), cash({ to: OTHER })]), undefined, hooks), isRelayError("batch_mismatch", 400));
  assert.equal(handed.length, 2);
  assert.equal(undone, 0);
  // the node refused it: what the hook returned takes the binding back
  chain.send = "reject";
  await assert.rejects(server.relayUnshieldBatch(net, cashBody([cash(), cash()]), undefined, hooks), (e: unknown) => e instanceof server.RelayError && e.code !== "maybe_sent");
  chain.send = "ok";
  assert.equal(handed.length, 3);
  assert.equal(undone, 1);
});

await test("through /api/relay: a link's code and payment tag on either batch change nothing about the send", async () => {
  const send = (body: Record<string, unknown>, ip: string) =>
    relayPost(
      new Request("https://gloam.trade/api/relay", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-forwarded-for": ip },
        body: JSON.stringify({ chainId: net.chainId, ...body }),
      })
    );
  const link = { partnerCode: "AbCdEfGhIjKlMnOpQrSt", partnerPayment: `0x${"5a".repeat(32)}` };
  const before = sentRaw.length;
  const pay = await send({ action: "transferBatch", parts: [part(true), part()], ...link }, "198.51.100.41");
  assert.equal(pay.status, 200);
  assert.deepEqual(await pay.json(), { ok: true, hash: TX_HASH });
  const out = await send({ action: "unshieldBatch", ...cashBody([cash(), cash()]), ...link }, "198.51.100.42");
  assert.equal(out.status, 200);
  assert.deepEqual(await out.json(), { ok: true, hash: TX_HASH });
  assert.equal(sentRaw.length, before + 2, "each went out as one transaction");
});

// ---------------------------------------------------------------- a note that keeps reverting
/** The reverts the relay counted against a note this hour. */
const noteReverts = (nul: Hex) => readRateLimit(nul, "relay-note-reverts", Date.now(), 3600);
/** Waits until a reverted receipt gave every lock back: the reverts were counted just before. */
async function untilFree(nuls: Hex[]) {
  for (let i = 0; i < 400; i++) {
    const all = await Promise.all(nuls.map(free));
    if (all.every(Boolean)) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.fail("the reverted receipt gave every lock back");
}

await test("a cash out in one go that reverts counts against every part's note; twice in an hour, and each of them waits", async () => {
  chain.receipt = "reverted";
  const parts = [cash(), cash(), cash()];
  for (let i = 0; i < 2; i++) {
    assert.equal(await server.relayUnshieldBatch(net, cashBody(parts)), TX_HASH);
    await untilFree(parts.map((p) => p.nullifier));
  }
  for (const p of parts) assert.equal(await noteReverts(p.nullifier), 2, "every part's note, once per revert");
  methods.length = 0;
  const before = sentRaw.length;
  await assert.rejects(server.relayUnshieldBatch(net, cashBody(parts)), isRelayError("note_wait", 429));
  assert.ok(!methods.includes("eth_estimateGas"), "no dry run");
  // and each part alone, as a cash out or a private send
  for (const p of parts) await assert.rejects(server.relayUnshield(net, { ...p }), isRelayError("note_wait", 429));
  await assert.rejects(server.relayTransfer(net, { proof: PROOF, root: ROOT, nullifier: parts[0]!.nullifier, commitments: [fresh(), fresh()] }), isRelayError("note_wait", 429));
  assert.equal(sentRaw.length, before, "nothing more went out");
  for (const p of parts) assert.ok(await free(p.nullifier), "every lock dropped");
  chain.receipt = "none";
});

await test("one part whose note is over its reverts refuses a cash out in one go, every lock dropped; the other parts still go", async () => {
  chain.receipt = "reverted";
  const tired = cash();
  for (let i = 0; i < 2; i++) {
    assert.equal(await server.relayUnshield(net, { ...tired }), TX_HASH);
    await untilFree([tired.nullifier]);
  }
  chain.receipt = "none";
  const parts = [cash(), tired, cash()];
  methods.length = 0;
  const before = sentRaw.length;
  await assert.rejects(server.relayUnshieldBatch(net, cashBody(parts)), isRelayError("note_wait", 429));
  assert.ok(!methods.includes("eth_estimateGas"), "no dry run");
  assert.equal(sentRaw.length, before);
  for (const p of parts) assert.ok(await free(p.nullifier), "every lock dropped");
  for (const p of [parts[0]!, parts[2]!]) assert.equal(await noteReverts(p.nullifier), 0, "the refusal counted nothing");
  assert.equal(await server.relayUnshieldBatch(net, cashBody([parts[0]!, parts[2]!])), TX_HASH);
  assert.equal(sentRaw.length, before + 1, "the others went");
});

await test("a payment in one go: a revert counts against every part's note, and one part over refuses it", async () => {
  chain.receipt = "reverted";
  const parts = [part(true), part(), part()];
  for (let i = 0; i < 2; i++) {
    // each try with new notes out, as the app proves them afresh
    const again = parts.map((p) => ({ ...p, commitments: [fresh(), fresh()] as [Hex, Hex] }));
    assert.equal(await server.relayTransferBatch(net, { parts: again }), TX_HASH);
    await untilFree(parts.map((p) => p.nullifier));
  }
  chain.receipt = "none";
  for (const p of parts) assert.equal(await noteReverts(p.nullifier), 2);
  const before = sentRaw.length;
  await assert.rejects(server.relayTransferBatch(net, { parts: [part(), { ...parts[1]!, commitments: [fresh(), fresh()] }] }), isRelayError("note_wait", 429));
  assert.equal(sentRaw.length, before);
  assert.equal(await server.relayTransferBatch(net, { parts: [part(), part()] }), TX_HASH, "other notes go");
});

await test("either one in one go that lands, or may have gone out, counts nothing against its parts' notes", async () => {
  chain.receipt = "success";
  const ended: string[] = [];
  const hooks = { onEnd: async (status: "success" | "reverted") => void ended.push(status) };
  const cashParts = [cash(), cash()];
  const payParts = [part(), part()];
  assert.equal(await server.relayUnshieldBatch(net, cashBody(cashParts), undefined, hooks), TX_HASH);
  assert.equal(await server.relayTransferBatch(net, { parts: payParts }, undefined, hooks), TX_HASH);
  for (let i = 0; i < 400 && ended.length < 2; i++) await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(ended, ["success", "success"], "the caller's own hook still runs");
  for (const p of [...cashParts, ...payParts]) assert.equal(await noteReverts(p.nullifier), 0);
  chain.receipt = "reverted";
  chain.send = "drop";
  const maybe = [cash(), cash()];
  await assert.rejects(server.relayUnshieldBatch(net, cashBody(maybe)), isRelayError("maybe_sent", 502));
  chain.send = "ok";
  await new Promise((r) => setTimeout(r, 30));
  for (const p of maybe) assert.equal(await noteReverts(p.nullifier), 0, "nobody saw it land");
  chain.receipt = "none";
});

console.log(`\n${passed} relay batch checks passed`);
