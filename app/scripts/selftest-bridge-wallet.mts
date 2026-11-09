/**
 * Self-test: a bridge paid from the connected EVM wallet to itself (lib/bridge
 * walletBridgeTxs). Only Relay's plain shapes ever reach the wallet:
 * [approve, deposit] or [deposit] for a token, [deposit] for the chain's own
 * coin, all on the source chain. Anything else is refused. Also that the quote
 * route asks Relay for the wallet's own order and the panel offers it first,
 * with the deposit address one tap away.
 *
 * Run from app/:  ../mcp/node_modules/.bin/tsx scripts/selftest-bridge-wallet.mts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const { walletBridgeTxs } = await import("../src/lib/bridge");

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`ok  ${name}`);
}

const BASE = { id: 8453 };
const USDC = { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" };
const ETH = { address: "0x0000000000000000000000000000000000000000" };
const WALLET = "0x76b7E410a227c888aBD2Bdc24Ee32E094B0FD4D8";
const ROUTER = "0x4cd00e387622c35bddb9b4c962c136462338bc31";
const OTHER = "0x1111111111111111111111111111111111111111";
const AMOUNT = BigInt(10_000_000);

const word = (v: bigint | string) => (typeof v === "bigint" ? v.toString(16) : v.slice(2).toLowerCase()).padStart(64, "0");
const approveData = (spender: string, n: bigint) => `0x095ea7b3${word(spender)}${word(n)}`;
const DEPOSIT_DATA = "0xe8017952" + "ab".repeat(68);

type Item = { to: string; data: string; value?: string; chainId: number; from?: string };
const step = (id: string, item: Item, kind = "transaction") => ({ id, kind, requestId: "0x" + "12".repeat(32), items: [{ status: "incomplete", data: item }] });
const approveStep = (over: Partial<Item> = {}) =>
  step("approve", { to: USDC.address, data: approveData(ROUTER, AMOUNT), value: "0", chainId: 8453, from: WALLET, ...over });
const depositStep = (over: Partial<Item> = {}) => step("deposit", { to: ROUTER, data: DEPOSIT_DATA, value: "0", chainId: 8453, from: WALLET, ...over });

test("approve then deposit for a token: both handed out, in order", () => {
  const txs = walletBridgeTxs({ steps: [approveStep(), depositStep()] }, BASE, USDC, AMOUNT, WALLET);
  assert.ok(txs);
  assert.equal(txs.length, 2);
  assert.equal(txs[0]!.to, USDC.address);
  assert.equal(txs[1]!.to, ROUTER);
  assert.deepEqual(txs.map((t) => t.chainId), [8453, 8453]);
  assert.deepEqual(txs.map((t) => t.value), ["0", "0"]);
});

test("an approve for more than the amount is fine (an unlimited one too)", () => {
  assert.ok(walletBridgeTxs({ steps: [approveStep({ data: approveData(ROUTER, AMOUNT * BigInt(3)) }), depositStep()] }, BASE, USDC, AMOUNT, WALLET));
  assert.ok(walletBridgeTxs({ steps: [approveStep({ data: approveData(ROUTER, (BigInt(1) << BigInt(256)) - BigInt(1)) }), depositStep()] }, BASE, USDC, AMOUNT, WALLET));
});

test("deposit alone for a token (already approved)", () => {
  const txs = walletBridgeTxs({ steps: [depositStep()] }, BASE, USDC, AMOUNT, WALLET);
  assert.equal(txs?.length, 1);
});

test("the chain's own coin: one deposit carrying exactly the amount", () => {
  const n = BigInt(10) ** BigInt(16);
  const txs = walletBridgeTxs({ steps: [depositStep({ value: n.toString() })] }, BASE, ETH, n, WALLET);
  assert.equal(txs?.length, 1);
  assert.equal(txs![0]!.value, n.toString());
  assert.equal(walletBridgeTxs({ steps: [depositStep({ value: (n + BigInt(1)).toString() })] }, BASE, ETH, n, WALLET), null);
  assert.equal(walletBridgeTxs({ steps: [depositStep({ value: "0" })] }, BASE, ETH, n, WALLET), null);
  // no approve for a coin
  assert.equal(walletBridgeTxs({ steps: [approveStep(), depositStep({ value: n.toString() })] }, BASE, ETH, n, WALLET), null);
});

test("refused: a step on another chain", () => {
  assert.equal(walletBridgeTxs({ steps: [approveStep(), depositStep({ chainId: 42161 })] }, BASE, USDC, AMOUNT, WALLET), null);
  assert.equal(walletBridgeTxs({ steps: [approveStep({ chainId: 1 }), depositStep()] }, BASE, USDC, AMOUNT, WALLET), null);
});

test("refused: an approve on the wrong token, to another spender, too small, or with value", () => {
  assert.equal(walletBridgeTxs({ steps: [approveStep({ to: OTHER }), depositStep()] }, BASE, USDC, AMOUNT, WALLET), null);
  assert.equal(walletBridgeTxs({ steps: [approveStep({ data: approveData(OTHER, AMOUNT) }), depositStep()] }, BASE, USDC, AMOUNT, WALLET), null);
  assert.equal(walletBridgeTxs({ steps: [approveStep({ data: approveData(ROUTER, AMOUNT - BigInt(1)) }), depositStep()] }, BASE, USDC, AMOUNT, WALLET), null);
  assert.equal(walletBridgeTxs({ steps: [approveStep({ value: "1" }), depositStep()] }, BASE, USDC, AMOUNT, WALLET), null);
  // a first step that isn't an approve at all
  assert.equal(walletBridgeTxs({ steps: [depositStep(), depositStep()] }, BASE, USDC, AMOUNT, WALLET), null);
});

test("refused: a token deposit that also sends coin", () => {
  assert.equal(walletBridgeTxs({ steps: [approveStep(), depositStep({ value: "1" })] }, BASE, USDC, AMOUNT, WALLET), null);
  assert.equal(walletBridgeTxs({ steps: [depositStep({ value: AMOUNT.toString() })] }, BASE, USDC, AMOUNT, WALLET), null);
});

test("refused: an extra step, no steps, a signature step, two items, bad fields", () => {
  assert.equal(walletBridgeTxs({ steps: [approveStep(), depositStep(), depositStep()] }, BASE, USDC, AMOUNT, WALLET), null);
  assert.equal(walletBridgeTxs({ steps: [] }, BASE, USDC, AMOUNT, WALLET), null);
  assert.equal(walletBridgeTxs({}, BASE, USDC, AMOUNT, WALLET), null);
  assert.equal(walletBridgeTxs(null, BASE, USDC, AMOUNT, WALLET), null);
  assert.equal(walletBridgeTxs({ steps: [approveStep(), { ...depositStep(), kind: "signature" }] }, BASE, USDC, AMOUNT, WALLET), null);
  const two = depositStep();
  two.items.push(two.items[0]!);
  assert.equal(walletBridgeTxs({ steps: [two] }, BASE, USDC, AMOUNT, WALLET), null);
  assert.equal(walletBridgeTxs({ steps: [depositStep({ to: "not-an-address" })] }, BASE, USDC, AMOUNT, WALLET), null);
  assert.equal(walletBridgeTxs({ steps: [depositStep({ data: "0xzz" })] }, BASE, USDC, AMOUNT, WALLET), null);
  assert.equal(walletBridgeTxs({ steps: [depositStep({ value: "lots" })] }, BASE, USDC, AMOUNT, WALLET), null);
  // a deposit that is itself an approve
  assert.equal(walletBridgeTxs({ steps: [depositStep({ to: USDC.address, data: approveData(ROUTER, AMOUNT) })] }, BASE, USDC, AMOUNT, WALLET), null);
});

test("refused: built for another sender", () => {
  assert.equal(walletBridgeTxs({ steps: [approveStep({ from: OTHER }), depositStep()] }, BASE, USDC, AMOUNT, WALLET), null);
  assert.equal(walletBridgeTxs({ steps: [depositStep({ from: OTHER })] }, BASE, USDC, AMOUNT, WALLET), null);
});

test("the quote route asks Relay for the wallet's own order and checks it", () => {
  const route = readFileSync(new URL("../src/app/api/bridge/quote/route.ts", import.meta.url), "utf8");
  assert.match(route, /fromWallet = body\.fromWallet === true && chain\.kind === "evm" && !chain\.swap/);
  assert.match(route, /useDepositAddress: !chain\.swap && !fromWallet/);
  assert.match(route, /walletBridgeTxs\(data, chain, token, amount, recipient\)/);
});

test("the panel: wallet first, a deposit address for an exchange, the order followed", () => {
  const panel = readFileSync(new URL("../src/components/app/BridgeIn.tsx", import.meta.url), "utf8");
  assert.match(panel, /fromWallet: true/);
  assert.match(panel, /Sending from an exchange\? Get a deposit address/);
  assert.match(panel, /From your wallet on \$\{chain\.name\} to your wallet on \$\{dest\.chain\}\./);
  assert.match(panel, /wallet\.kind === "sent"\s*\?\s*wallet\.quote\.requestId/);
  assert.doesNotMatch(panel, /—/);
});

console.log(`\n${passed} passed`);
