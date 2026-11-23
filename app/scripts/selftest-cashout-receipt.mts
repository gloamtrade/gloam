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
 * Bug sweep, 23 Nov 2026 (findings 1, 3, 5 and 6):
 *  - a private swap and a name purchase pay out of the vault too, and got a
 *    "Verified on-chain" cash-out receipt: now refused. A real Robinhood Chain
 *    swap (fixture) is refused and a real Base cash out (fixture) still reads
 *  - the list skips notes a swap or a name spent, and payouts to Gloam's routers
 *  - a receipt names its own chain's network and token, never the one shown
 *  - a cross-chain cash out is remembered as "Relay, bridging to <chain>"
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
const bridgeLib = await import("../src/lib/cashOutBridge");
const { readFileSync } = await import("node:fs");

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

// ------------------------------------------------------------ only a plain cash out (bug sweep 23 Nov)
type Fixture = { chainId: number; hash: Hex; status: "success" | "reverted"; blockNumber: string; timestamp: string; to: Address; from: Address; logs: { address: Address; topics: Hex[]; data: Hex; logIndex: number }[] };
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")) as Fixture;
const fixtureClient = (f: Fixture) =>
  ({
    getTransactionReceipt: async () => ({
      status: f.status,
      blockNumber: BigInt(f.blockNumber),
      logs: f.logs.map((l) => ({ ...l, blockNumber: BigInt(f.blockNumber), transactionHash: f.hash, blockHash: `0x${"00".repeat(32)}`, transactionIndex: 0, removed: false })),
    }),
    getTransaction: async () => ({ to: f.to, from: f.from }),
    getBlock: async () => ({ timestamp: BigInt(f.timestamp) }),
  }) as never;

await test("a real private swap on Robinhood Chain gets no cash-out receipt", async () => {
  const f = fixture("receipt-rh-private-swap.json");
  const net = { chainId: 4663, pool: POOL, label: "Robinhood Chain" };
  const out = await r.readCashOutReceipt(fixtureClient(f), net, f.hash);
  assert.ok(!out.ok && out.reason === "not_cash_out", "refused: the money went to an escrow and came back into the vault");
  assert.match(out.ok ? "" : out.message, /inside Gloam/);
  assert.ok(r.receiptGuardFor(4663).notTo.includes(f.to.toLowerCase()), "the swap router is one of Gloam's");
});

await test("a real Base cash out still reads, and what the wallet got matches the token transfer", async () => {
  const f = fixture("receipt-base-cash-out.json");
  const net = { chainId: 8453, pool: POOL, label: "Base" };
  const out = await r.readCashOutReceipt(fixtureClient(f), net, f.hash);
  assert.ok(out.ok);
  const x = out.receipt;
  const transferTopic = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
  const toWallet = f.logs.find((l) => l.topics[0] === transferTopic && `0x${l.topics[2]!.slice(26)}`.toLowerCase() === x.to.toLowerCase());
  assert.ok(toWallet, "the token moved to the receipt's wallet");
  assert.equal(x.delivered, BigInt(toWallet!.data), "received = the transfer to that wallet");
  assert.ok(x.fee > 0n && x.amount === x.delivered + x.fee);
});

await test("a name purchase, a payout to a router, or a note put back in the vault is refused", async () => {
  const REGISTRAR = getAddress("0x2B28b693EA3A880085fe582E55B7f0EEC86d3EDB");
  const REGISTRY = getAddress("0x62c435CE6886fa91e3b0e91500c6dC9219723457");
  const ROUTER = getAddress("0xfCa1887e77f738ef9C5751974b3f3873d029F2DC");
  const guard = { notTo: [REGISTRAR, REGISTRY, ROUTER].map((a) => a.toLowerCase()), noLogsFrom: [REGISTRY.toLowerCase()] };
  const g = { ...NET, guard };
  const local = new Map<string, { to: Address; logs: Log[] }>();
  const c = {
    getTransactionReceipt: async ({ hash: h }: { hash: Hex }) => ({ status: "success", blockNumber: 900n, logs: local.get(h.toLowerCase())!.logs }),
    getTransaction: async ({ hash: h }: { hash: Hex }) => ({ to: local.get(h.toLowerCase())!.to, from: RELAY }),
    getBlock: async () => ({ timestamp: 1_795_400_900n }),
  } as never;
  // sent to the registrar
  local.set(hash(20).toLowerCase(), { to: REGISTRAR, logs: [unshieldLog(POOL, nul(20), 5_000_000n, 900n, hash(20))] });
  // a names registry log in the transaction
  const reg = { ...unshieldLog(REGISTRY, nul(21), 1n, 900n, hash(21)) } as Log;
  local.set(hash(21).toLowerCase(), { to: POOL, logs: [unshieldLog(POOL, nul(21), 5_000_000n, 900n, hash(21)), reg] });
  // a note put back in the vault in the same transaction (a swap's return leg)
  const shielded = {
    address: POOL,
    topics: encodeEventTopics({
      abi: [{ type: "event", name: "Shielded", inputs: [{ name: "commitment", type: "bytes32", indexed: true }, { name: "asset", type: "address", indexed: true }, { name: "amount", type: "uint256", indexed: false }, { name: "leafIndex", type: "uint256", indexed: false }, { name: "from", type: "address", indexed: true }] }],
      eventName: "Shielded",
      args: { commitment: nul(99), asset: USDC, from: OTHER },
    }) as [Hex, ...Hex[]],
    data: encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [1n, 7n]),
    blockNumber: 900n,
    blockHash: `0x${"cd".repeat(32)}`,
    transactionHash: hash(22),
    transactionIndex: 0,
    logIndex: 99,
    removed: false,
  } as Log;
  local.set(hash(22).toLowerCase(), { to: POOL, logs: [unshieldLog(POOL, nul(22), 5_000_000n, 900n, hash(22)), shielded] });
  // a plain cash out with the same guard reads
  local.set(hash(23).toLowerCase(), { to: POOL, logs: [unshieldLog(POOL, nul(23), 5_000_000n, 900n, hash(23))] });
  for (const n of [20, 21, 22]) {
    const o = await r.readCashOutReceipt(c, g, hash(n));
    assert.ok(!o.ok && o.reason === "not_cash_out", `tx ${n} refused`);
  }
  const fine = await r.readCashOutReceipt(c, g, hash(23));
  assert.ok(fine.ok, "a plain cash out still gets its receipt");
});

await test("the list skips notes a swap or a name spent, and other networks' notes", () => {
  const base = { chainId: 1, pool: POOL };
  const notes = [
    { ...base, id: "a", nullifier: nul(31) },
    { ...base, id: "b", nullifier: nul(32), swapProofAt: 5 },
    { ...base, id: "c", nullifier: nul(33) },
    { ...base, id: "refund", nullifier: nul(34), vaultSwap: {} as never, sweptFrom: { id: "c", nullifier: nul(33) } },
    { ...base, id: "d", nullifier: nul(35) },
    { ...base, id: "name-refund", nullifier: nul(36), nameClaim: {} as never, sweptFrom: { id: "d", nullifier: nul(35) } },
    { chainId: 8453, pool: POOL, id: "e", nullifier: nul(37) },
  ] as never[];
  assert.deepEqual(r.cashOutMarkers(notes, 1, POOL), [nul(31), nul(34), nul(36)], "swap-spent, swap-refunded and name-spent notes are left out");
});

await test("a receipt is drawn with its own chain's network and token", () => {
  assert.equal(r.receiptNetworkOf(8453)?.label, "Base");
  assert.equal(r.receiptNetworkOf(1)?.label, "Ethereum");
  const usdcBase = r.receiptToken(8453, "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
  assert.deepEqual(usdcBase, { symbol: "USDC", decimals: 6 }, "Base USDC, whatever network the app shows");
  assert.equal(r.receiptToken(1, "0x0000000000000000000000000000000000000000").symbol, "ETH");
  assert.equal(r.receiptNetworkOf(424242), null, "an unknown chain is no network");
});

await test("a cross-chain cash out is remembered for its receipt", () => {
  bridgeLib.rememberBridgeCashOut(nul(40), { chain: "Base", chainId: 8453, symbol: "USDC", recipient: TO }, 1000);
  const m = bridgeLib.bridgeMarkFor(nul(40).toUpperCase().replace("0X", "0x"));
  assert.deepEqual(m, { chain: "Base", chainId: 8453, symbol: "USDC", recipient: TO, at: 1000 }, "found by its spend marker, any case");
  assert.equal(bridgeLib.bridgeMarkFor(nul(41)), null);
  for (let i = 0; i < 205; i++) bridgeLib.rememberBridgeCashOut(nul(500 + i), { chain: "Base", chainId: 8453, symbol: "USDC", recipient: TO }, 2000 + i);
  assert.equal(bridgeLib.bridgeMarkFor(nul(40)), null, "only the newest 200 are kept");
  assert.ok(bridgeLib.bridgeMarkFor(nul(704)));
});

console.log(`\n${passed} cash-out receipt checks passed`);
