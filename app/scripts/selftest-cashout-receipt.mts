/**
 * Self-test: a receipt for a cash out to a public wallet (lib/cashOutReceipt).
 *
 * HeisRae's ask, 23 Nov 2026: "I sent money to a public wallet, I wish there's
 * an option in the prove section to show proof that I sent the money."
 *
 * Against a fake chain:
 *  - a cash out's receipt has the amount, the fee from WithdrawFee, what the
 *    wallet got, the wallet, the block time and who sent the transaction
 *  - no fee logged reads as none; a batch picks the cash out asked for
 *  - a failed transaction, one not landed yet, one with no vault log, and an
 *    Unshielded log from another contract are refused with plain words
 *  - findCashOuts returns only the cash outs that spent a marker this browser
 *    holds, from this network's vault, newest first, each once, asking in chunks
 *  - receipt numbers and hash checks
 *
 * Run from app/:  ../mcp/node_modules/.bin/tsx scripts/selftest-cashout-receipt.mts
 */
import assert from "node:assert/strict";
import "./browser-shim.mjs";
import {
  TransactionReceiptNotFoundError,
  encodeAbiParameters,
  encodeEventTopics,
  getAddress,
  type Address,
  type Hex,
  type Log,
} from "viem";

const r = await import("../src/lib/cashOutReceipt");

let passed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  await fn();
  passed++;
  console.log(`ok  ${name}`);
}

const POOL = getAddress("0x39E28Cde55CAB798874746ac52cb4B5Cc99a0194");
const OTHER = getAddress("0x2222222222222222222222222222222222222222");
const USDC = getAddress("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48");
const TO = getAddress("0x3333333333333333333333333333333333333333");
const RELAY = getAddress("0x4444444444444444444444444444444444444444");
const NET = { chainId: 1, pool: POOL, label: "Ethereum", deployBlock: 100n, logRange: 10_000n };
const nul = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const hash = (n: number) => `0x${(0xabc000 + n).toString(16).padStart(64, "0")}` as Hex;

let logIndex = 0;
function unshieldLog(address: Address, nullifier: Hex, amount: bigint, block: bigint, tx: Hex): Log {
  return {
    address,
    topics: encodeEventTopics({ abi: [r.UNSHIELDED_EVENT], eventName: "Unshielded", args: { nullifier, asset: USDC, to: TO } }) as [Hex, ...Hex[]],
    data: encodeAbiParameters([{ type: "uint256" }], [amount]),
    blockNumber: block,
    blockHash: `0x${"cd".repeat(32)}`,
    transactionHash: tx,
    transactionIndex: 0,
    logIndex: logIndex++,
    removed: false,
  } as Log;
}
function feeLog(nullifier: Hex, fee: bigint, block: bigint, tx: Hex): Log {
  return {
    address: POOL,
    topics: encodeEventTopics({ abi: [r.WITHDRAW_FEE_EVENT], eventName: "WithdrawFee", args: { nullifier, asset: USDC } }) as [Hex, ...Hex[]],
    data: encodeAbiParameters([{ type: "uint256" }], [fee]),
    blockNumber: block,
    blockHash: `0x${"cd".repeat(32)}`,
    transactionHash: tx,
    transactionIndex: 0,
    logIndex: logIndex++,
    removed: false,
  } as Log;
}

type FakeTx = { status: "success" | "reverted"; block: bigint; logs: Log[]; from: Address };
const txs = new Map<string, FakeTx>();
const allLogs: Log[] = [];
const queries: { nullifiers: string[] }[] = [];
function addTx(h: Hex, t: FakeTx) {
  txs.set(h.toLowerCase(), t);
  allLogs.push(...t.logs);
}

const client = {
  getBlockNumber: async () => 10_000n,
  getTransactionReceipt: async ({ hash: h }: { hash: Hex }) => {
    const t = txs.get(h.toLowerCase());
    if (!t) throw new TransactionReceiptNotFoundError({ hash: h });
    return { status: t.status, blockNumber: t.block, logs: t.logs };
  },
  getBlock: async ({ blockNumber }: { blockNumber: bigint }) => ({ timestamp: 1_795_400_000n + blockNumber }),
  getTransaction: async ({ hash: h }: { hash: Hex }) => ({ from: txs.get(h.toLowerCase())!.from }),
  getLogs: async (a: { address: Address; args?: { nullifier?: Hex[] }; fromBlock: bigint; toBlock: bigint }) => {
    const want = (a.args?.nullifier ?? []).map((x) => x.toLowerCase());
    queries.push({ nullifiers: want });
    const topic0 = encodeEventTopics({ abi: [r.UNSHIELDED_EVENT], eventName: "Unshielded" })[0];
    return allLogs.filter(
      (l) =>
        l.address.toLowerCase() === a.address.toLowerCase() &&
        l.topics[0] === topic0 &&
        l.blockNumber! >= a.fromBlock &&
        l.blockNumber! <= a.toBlock &&
        (want.length === 0 || want.includes(l.topics[1]!.toLowerCase()))
    );
  },
} as never;

// a cash out of 100 USDC with a 0.5 USDC fee, sent by the relay
addTx(hash(1), { status: "success", block: 500n, from: RELAY, logs: [unshieldLog(POOL, nul(1), 100_000_000n, 500n, hash(1)), feeLog(nul(1), 500_000n, 500n, hash(1))] });
// no fee logged
addTx(hash(2), { status: "success", block: 600n, from: TO, logs: [unshieldLog(POOL, nul(2), 7_000_000n, 600n, hash(2))] });
// a batch of two
addTx(hash(3), {
  status: "success",
  block: 700n,
  from: RELAY,
  logs: [unshieldLog(POOL, nul(3), 1_000_000n, 700n, hash(3)), unshieldLog(POOL, nul(4), 2_000_000n, 700n, hash(3)), feeLog(nul(4), 10_000n, 700n, hash(3))],
});
// failed
addTx(hash(5), { status: "reverted", block: 800n, from: RELAY, logs: [] });
// a plain transfer with no vault log
addTx(hash(6), { status: "success", block: 801n, from: RELAY, logs: [] });
// an Unshielded-shaped log from another contract
addTx(hash(7), { status: "success", block: 802n, from: RELAY, logs: [unshieldLog(OTHER, nul(7), 9n, 802n, hash(7))] });

await test("a cash out's receipt: amount, fee, what the wallet got, where, when, who sent it", async () => {
  const out = await r.readCashOutReceipt(client, NET, hash(1));
  assert.ok(out.ok);
  const x = out.receipt;
  assert.equal(x.amount, 100_000_000n);
  assert.equal(x.fee, 500_000n);
  assert.equal(x.delivered, 99_500_000n);
  assert.equal(x.to, TO);
  assert.equal(x.asset, USDC);
  assert.equal(x.nullifier, nul(1));
  assert.equal(x.blockNumber, 500n);
  assert.equal(x.time, (1_795_400_000 + 500) * 1000);
  assert.equal(x.sentBy, RELAY);
  assert.equal(x.network, "Ethereum");
  assert.equal(x.inTx, 1);
  assert.equal(x.txHash, hash(1).toLowerCase());
});

await test("no fee logged reads as none; a batch picks the one asked for", async () => {
  const two = await r.readCashOutReceipt(client, NET, hash(2));
  assert.ok(two.ok);
  assert.equal(two.receipt.fee, 0n);
  assert.equal(two.receipt.delivered, 7_000_000n);
  const batch = await r.readCashOutReceipt(client, NET, hash(3), { nullifier: nul(4) });
  assert.ok(batch.ok);
  assert.equal(batch.receipt.amount, 2_000_000n);
  assert.equal(batch.receipt.fee, 10_000n, "its own fee, by marker");
  assert.equal(batch.receipt.inTx, 2);
  const first = await r.readCashOutReceipt(client, NET, hash(3));
  assert.ok(first.ok);
  assert.equal(first.receipt.fee, 0n, "the first, whose fee line isn't there");
});

await test("failed, not landed, not a cash out, another contract, not a hash, no vault: plain refusals", async () => {
  const failed = await r.readCashOutReceipt(client, NET, hash(5));
  assert.ok(!failed.ok && failed.reason === "failed");
  const pending = await r.readCashOutReceipt(client, NET, hash(99));
  assert.ok(!pending.ok && pending.reason === "pending");
  const plain = await r.readCashOutReceipt(client, NET, hash(6));
  assert.ok(!plain.ok && plain.reason === "not_cash_out");
  const other = await r.readCashOutReceipt(client, NET, hash(7));
  assert.ok(!other.ok && other.reason === "not_cash_out", "a lookalike log from another contract isn't a cash out");
  const bad = await r.readCashOutReceipt(client, NET, "0x1234");
  assert.ok(!bad.ok && bad.reason === "unreadable");
  const noVault = await r.readCashOutReceipt(client, { ...NET, pool: null }, hash(1));
  assert.ok(!noVault.ok && noVault.reason === "not_cash_out");
  for (const o of [failed, pending, plain, other, bad, noVault]) assert.ok(!o.ok && !/—/.test(o.message), "no em dashes");
});

await test("findCashOuts: only this browser's markers, this vault, newest first, each once, in chunks", async () => {
  const mine = [nul(1), nul(4), nul(7), nul(1), ...Array.from({ length: 60 }, (_, i) => nul(1000 + i))];
  queries.length = 0;
  const found = await r.findCashOuts(client, NET, mine);
  assert.deepEqual(
    found.map((f) => [f.txHash, f.nullifier, f.amount]),
    [
      [hash(3), nul(4), 2_000_000n],
      [hash(1), nul(1), 100_000_000n],
    ],
    "nul(7) was on another contract, nul(2) and nul(3) aren't held here"
  );
  assert.ok(queries.length >= 2, "more than 50 markers are asked in chunks");
  assert.ok(queries.every((q) => q.nullifiers.length <= r.NULLIFIERS_PER_QUERY));
  assert.deepEqual(await r.findCashOuts(client, NET, []), [], "nothing held, nothing asked");
});

await test("receipt numbers and hash checks", () => {
  assert.equal(r.receiptNumber({ time: Date.UTC(2026, 10, 23, 2, 50), txHash: `0x${"0".repeat(60)}b7f8` }), "RCT-20261123-B7F8");
  assert.ok(r.isTxHash(hash(1)));
  assert.ok(!r.isTxHash("0x1234"));
  assert.ok(!r.isTxHash(TO), "an address isn't a transaction");
});

console.log(`\n${passed} cash-out receipt checks passed`);
