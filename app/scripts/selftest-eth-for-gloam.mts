/**
 * Self-test: lib/ethForGloam, the Universal Router call that buys $GLOAM with ETH.
 * Decodes what it builds and checks every field, and the slippage rounding.
 * The live encoding is proven by scripts/fork-pay-with-eth.mts on a fork.
 *
 * Run from app/:  pnpm dlx tsx scripts/selftest-eth-for-gloam.mts
 */
import assert from "node:assert/strict";
import { decodeAbiParameters, decodeFunctionData, parseEther, zeroAddress } from "viem";
import { ETH_GLOAM_POOL, RH_GLOAM, RH_UNIVERSAL_ROUTER, buildEthToGloamSwap, ethWithBuffer, quoteCall, universalRouterAbi } from "../src/lib/ethForGloam";

let passed = 0;
const test = (name: string, fn: () => void) => {
  fn();
  passed++;
  console.log(`ok  ${name}`);
};

test("the buffer is 2%, rounded up, never zero", () => {
  assert.equal(ethWithBuffer(10_000n), 10_200n);
  assert.equal(ethWithBuffer(1n), 2n);
  assert.equal(ethWithBuffer(parseEther("0.0029")), parseEther("0.002958"));
});

test("the quote asks for exactly the GLOAM still needed, ETH in", () => {
  const q = quoteCall(15n * 10n ** 18n);
  const p = q.args[0];
  assert.equal(p.exactAmount, 15n * 10n ** 18n);
  assert.equal(p.zeroForOne, true);
  assert.deepEqual(p.poolKey, ETH_GLOAM_POOL);
  assert.equal(ETH_GLOAM_POOL.currency0, zeroAddress);
  assert.equal(ETH_GLOAM_POOL.currency1, RH_GLOAM);
});

test("the router call: one V4_SWAP, exact-in single, settle ETH, take GLOAM", () => {
  const ethIn = parseEther("0.003"), out = 15n * 10n ** 18n, deadline = 1_800_000_000n;
  const tx = buildEthToGloamSwap(ethIn, out, deadline);
  assert.equal(tx.to, RH_UNIVERSAL_ROUTER);
  assert.equal(tx.value, ethIn);
  const { args } = decodeFunctionData({ abi: universalRouterAbi, data: tx.data });
  const [commands, inputs, dl] = args as readonly [`0x${string}`, readonly `0x${string}`[], bigint];
  assert.equal(commands, "0x10");
  assert.equal(inputs.length, 1);
  assert.equal(dl, deadline);
  const [actions, params] = decodeAbiParameters([{ type: "bytes" }, { type: "bytes[]" }], inputs[0]);
  assert.equal(actions, "0x060c0f");
  assert.equal(params.length, 3);
  const [swap] = decodeAbiParameters(
    [{ type: "tuple", components: [
      { name: "poolKey", type: "tuple", components: [{ name: "currency0", type: "address" }, { name: "currency1", type: "address" }, { name: "fee", type: "uint24" }, { name: "tickSpacing", type: "int24" }, { name: "hooks", type: "address" }] },
      { name: "zeroForOne", type: "bool" }, { name: "amountIn", type: "uint128" }, { name: "amountOutMinimum", type: "uint128" }, { name: "hookData", type: "bytes" },
    ] }],
    params[0]
  );
  assert.equal(swap.amountIn, ethIn);
  assert.equal(swap.amountOutMinimum, out);
  assert.equal(swap.zeroForOne, true);
  assert.equal(swap.poolKey.hooks.toLowerCase(), ETH_GLOAM_POOL.hooks.toLowerCase());
  const [c1, max] = decodeAbiParameters([{ type: "address" }, { type: "uint256" }], params[1]);
  assert.equal(c1, zeroAddress);
  assert.equal(max, ethIn, "settles exactly what was sent, so nothing stays in the router");
  const [c2, min] = decodeAbiParameters([{ type: "address" }, { type: "uint256" }], params[2]);
  assert.equal(c2.toLowerCase(), RH_GLOAM.toLowerCase());
  assert.equal(min, out, "takes at least the GLOAM the name needs");
});

console.log(`\n${passed} passed`);
