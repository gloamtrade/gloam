/**
 * The wallet behind the previews: it signs only inside a running preview, and
 * only the calls that preview named.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeFunctionData, parseAbi, type Address, type Hex } from "viem";
import { isNotSent, type CallSender } from "@gloamtrade/game-plugin-gloam/engine";
import { guardedSender, type DecodedCall, type Expectation } from "../src/index.ts";
import { POOL, USDC, hashOf } from "./helpers.mts";

const ABI = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function shieldBound(address asset, uint256 amount, bytes32 commitment, bytes proof) payable",
  "function transfer(bytes proof, bytes32 root, bytes32 nullifier, bytes32[2] commitments)",
  "function unshield(bytes proof, bytes32 root, bytes32 nullifier, address asset, address to, uint256 amount)",
  "function postMemo(bytes32 paymentCommitment, bytes memo)",
]);
const H = ("0x" + "11".repeat(32)) as Hex;
const OTHER = "0x00000000000000000000000000000000000000c3" as Address;
const BOARD = "0x00000000000000000000000000000000000000d4" as Address;
const approve = (spender: Address, amount: bigint) => ({ to: USDC, data: encodeFunctionData({ abi: ABI, functionName: "approve", args: [spender, amount] }) });
const shield = (asset: Address, amount: bigint, value = 0n) => ({ to: POOL, data: encodeFunctionData({ abi: ABI, functionName: "shieldBound", args: [asset, amount, H, "0x00"] }), value });
const transfer = (to: Address = POOL) => ({ to, data: encodeFunctionData({ abi: ABI, functionName: "transfer", args: ["0x00", H, H, [H, H]] }) });
const unshield = (to: Address, amount: bigint) => ({ to: POOL, data: encodeFunctionData({ abi: ABI, functionName: "unshield", args: ["0x00", H, H, USDC, to, amount] }) });
const memo = () => ({ to: BOARD, data: encodeFunctionData({ abi: ABI, functionName: "postMemo", args: [H, "0xabcd"] }) });

function wallet() {
  const sent: unknown[] = [];
  const inner: CallSender = { address: "0x00000000000000000000000000000000000000a1", sendCalls: async (c) => (sent.push(c), hashOf(sent.length)) };
  return { inner, sent };
}
const SHIELD: Expectation = { kind: "shield", pool: POOL, asset: USDC, amountWei: 25_000_000n, native: false };
const ctx = { previewId: "pv_test", action: "shield" };

async function refusedWith(p: Promise<unknown>, re: RegExp) {
  await assert.rejects(p, (e: Error) => isNotSent(e) && re.test(e.message));
}

test("outside a preview the wallet signs nothing", async () => {
  const { inner, sent } = wallet();
  const g = guardedSender(inner);
  await refusedWith(g.sendCalls([approve(POOL, 1n)]), /only inside an approved preview/);
  assert.equal(sent.length, 0);
});

test("a deposit signs exactly the previewed approve and shieldBound", async () => {
  const { inner, sent } = wallet();
  const g = guardedSender(inner);
  await g.within(SHIELD, ctx, () => g.sendCalls([approve(POOL, 25_000_000n), shield(USDC, 25_000_000n)]));
  await g.within(SHIELD, ctx, () => g.sendCalls([approve(POOL, 0n), approve(POOL, 25_000_000n), shield(USDC, 25_000_000n)]));
  await g.within(SHIELD, ctx, () => g.sendCalls([shield(USDC, 25_000_000n)]));
  assert.equal(sent.length, 3);
  await refusedWith(g.within(SHIELD, ctx, () => g.sendCalls([approve(OTHER, 25_000_000n), shield(USDC, 25_000_000n)])), /not the vault/);
  await refusedWith(g.within(SHIELD, ctx, () => g.sendCalls([approve(POOL, 2n ** 255n), shield(USDC, 25_000_000n)])), /not the 25000000 previewed/);
  await refusedWith(g.within(SHIELD, ctx, () => g.sendCalls([shield(USDC, 26_000_000n)])), /asset and amount previewed/);
  await refusedWith(g.within(SHIELD, ctx, () => g.sendCalls([shield(USDC, 25_000_000n, 1n)])), /value/);
  await refusedWith(g.within(SHIELD, ctx, () => g.sendCalls([transfer()])), /not the deposit/);
  await refusedWith(g.within(SHIELD, ctx, () => g.sendCalls([{ to: USDC, data: "0xdeadbeef" }])), /not one a Gloam action makes/);
  assert.equal(sent.length, 3, "nothing refused reached the wallet");
});

test("a private payment from the wallet signs transfers and payment messages only; a cash out only its own recipient", async () => {
  const { inner, sent } = wallet();
  const g = guardedSender(inner);
  const pay: Expectation = { kind: "private", pool: POOL, board: BOARD };
  await g.within(pay, ctx, () => g.sendCalls([transfer()]));
  await g.within(pay, ctx, () => g.sendCalls([memo()]));
  await refusedWith(g.within(pay, ctx, () => g.sendCalls([unshield(OTHER, 1n)])), /not part of this preview/);
  await refusedWith(g.within(pay, ctx, () => g.sendCalls([transfer(OTHER)])), /not part of this preview/);
  const out: Expectation = { kind: "private", pool: POOL, board: BOARD, cashOut: { asset: USDC, to: OTHER, amountWei: 10n } };
  await g.within(out, ctx, () => g.sendCalls([unshield(OTHER, 10n)]));
  await refusedWith(g.within(out, ctx, () => g.sendCalls([unshield(OTHER, 11n)])), /recipient and amount previewed/);
  await refusedWith(g.within(out, ctx, () => g.sendCalls([unshield(POOL, 10n)])), /recipient and amount previewed/);
  await refusedWith(g.within({ kind: "none" }, ctx, () => g.sendCalls([transfer()])), /signs nothing/);
  assert.equal(sent.length, 3);
});

test("onSign sees the calls decoded and can still refuse", async () => {
  const { inner, sent } = wallet();
  const seen: DecodedCall[][] = [];
  let allow = false;
  const g = guardedSender(inner, (calls, c) => {
    seen.push(calls);
    assert.equal(c.previewId, "pv_test");
    return allow;
  });
  await refusedWith(g.within(SHIELD, ctx, () => g.sendCalls([shield(USDC, 25_000_000n)])), /declined/);
  allow = true;
  await g.within(SHIELD, ctx, () => g.sendCalls([approve(POOL, 25_000_000n), shield(USDC, 25_000_000n)]));
  assert.equal(sent.length, 1);
  assert.deepEqual(seen[1]!.map((c) => c.fn), ["approve", "shieldBound"]);
  assert.equal(seen[1]![0]!.args.spender!.toLowerCase(), POOL.toLowerCase());
  assert.equal(seen[1]![1]!.args.amount, "25000000");
});

test("one action at a time", async () => {
  const { inner } = wallet();
  const g = guardedSender(inner);
  let release!: () => void;
  const first = g.within(SHIELD, ctx, () => new Promise<void>((r) => (release = r)));
  await assert.rejects(g.within(SHIELD, ctx, async () => undefined), /Another Gloam action is running/);
  release();
  await first;
});
