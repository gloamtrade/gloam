/**
 * Self-test: Public send carries every token listed on a chain, next to the
 * native coin where the chain has one (lib/publicSend), and Tempo, which has
 * none, sends its stablecoins. A public send refuses the addresses a cash out
 * refuses, since money sent to one can't be got back, and a Max on Tempo leaves
 * the token's gas behind. The demo wallet tells an ERC-20's transfer(to, amount)
 * from the vault's own transfer. A deposit limit has no say: a public send never
 * touches the vault.
 *
 * Run from app/:  ../mcp/node_modules/.bin/tsx --tsconfig tsconfig.json scripts/selftest-public-send.mts
 */
import assert from "node:assert/strict";
import { parseUnits, zeroAddress, type Address } from "viem";

const { hasNativeCoin, maxTokenSend, NATIVE_CHOICE, pickedToken, publicSendTargetProblem, publicSendTokens } = await import("../src/lib/publicSend");
const { demoWriteEffect } = await import("../src/lib/demo/store");
const { limitGatedTokensFor } = await import("../src/lib/tokens");

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`ok  ${name}`);
}

const VAULT = "0x39E28Cde55CAB798874746ac52cb4B5Cc99a0194";
const robinhood = { family: "robinhood", chainId: 4663, pool: VAULT, payMemo: { address: "0x01B3172d9900Cb26d57E986429b9b23854c74598" } };
const tempo = { family: "tempo", chainId: 4217, pool: VAULT, payMemo: { address: "0x342E3745967FDB4223902E196Ceb792c15d8C1c4" } };
const WALLET = "0x00000000000000000000000000000000000000b2";
const symbols = (chainId: number) => publicSendTokens(chainId).map((t) => t.symbol);

test("every listed token goes out on every chain", () => {
  assert.deepEqual(symbols(4663), ["USDG", "GLOAM", "GRIFT", "PONS", "CASHCAT", "AI", "ORBIO"]);
  assert.deepEqual(symbols(4217), ["USDC.e", "pathUSD", "USDT0", "OUSD"]);
  assert.deepEqual(symbols(8453), ["USDC", "EURC", "USDT"]);
  assert.deepEqual(symbols(1), ["USDC", "USDT", "USDG", "PYUSD", "EURC"]);
});

test("a token the vault does not take yet still goes out: no limit applies to a public send", () => {
  // Base and Ethereum have none since the BDX OFT (not Beldex's) was dropped on 20 Nov 2026.
  for (const chainId of [8453, 1]) assert.deepEqual(limitGatedTokensFor(chainId), [], `${chainId} has no gated token`);
  for (const chainId of [4663]) {
    const gated = limitGatedTokensFor(chainId);
    assert.ok(gated.length > 0, `${chainId} has a gated token`);
    for (const t of gated) assert.ok(publicSendTokens(chainId).some((x) => x.id === t.id), `${t.symbol} on ${chainId}`);
  }
});

test("the native coin is there except on Tempo", () => {
  assert.equal(hasNativeCoin(robinhood), true);
  assert.equal(hasNativeCoin(tempo), false);
  assert.equal(pickedToken(NATIVE_CHOICE, robinhood, publicSendTokens(4663)), null, "ETH on Robinhood Chain");
  assert.equal(pickedToken(NATIVE_CHOICE, tempo, publicSendTokens(4217))?.symbol, "USDC.e", "Tempo starts on its first stablecoin");
});

test("a pick follows the network", () => {
  assert.equal(pickedToken("pons", robinhood, publicSendTokens(4663))?.symbol, "PONS");
  assert.equal(pickedToken("cashcat", robinhood, publicSendTokens(4663))?.symbol, "CASHCAT");
  assert.equal(pickedToken("pons", { family: "base" }, publicSendTokens(8453)), null, "PONS is not on Base: back to ETH");
  assert.equal(pickedToken("pons", tempo, publicSendTokens(4217))?.symbol, "USDC.e", "nor on Tempo: back to the first token");
  assert.equal(pickedToken("usdc", { family: "ethereum" }, publicSendTokens(1))?.address, "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", "the same id names this chain's token");
});

test("Max sends the whole balance where gas is ETH, and keeps the gas on Tempo", () => {
  const pons = parseUnits("1234.567890123456789012", 18);
  assert.equal(maxTokenSend(pons, 18, robinhood), pons, "every last unit, no rounding");
  assert.equal(maxTokenSend(5_000_000n, 6, tempo), 4_980_000n, "0.02 stays for the fee");
  assert.equal(maxTokenSend(10_000n, 6, tempo), 0n, "a balance under the fee sends nothing");
});

test("an address that would lose the money is refused, in a public send's words", () => {
  const PONS = "0x39dBED3a2bd333467115dE45665cC57F813C4571";
  const AI = "0x2E8c31162b855A2ffa90F6F8634643Ad6F111e18";
  for (const to of [VAULT, PONS, AI, zeroAddress, "0xfCa1887e77f738ef9C5751974b3f3873d029F2DC", robinhood.payMemo.address]) {
    const why = publicSendTargetProblem(to, robinhood);
    assert.ok(why, `${to} is refused`);
    assert.ok(!/cash out/i.test(why), `${why} speaks of a send`);
  }
  assert.equal(publicSendTargetProblem(WALLET, robinhood), null, "a wallet is fine");
  assert.equal(publicSendTargetProblem(PONS, { ...tempo }), null, "PONS's address is nothing on Tempo");
});

test("the demo wallet moves the token for an ERC-20 transfer, and leaves the vault's own transfer alone", () => {
  const token = "0x39dBED3a2bd333467115dE45665cC57F813C4571" as Address;
  const out = demoWriteEffect({ to: token, functionName: "transfer", args: [WALLET, 5n] });
  assert.deepEqual(out.wallet, [[token, -5n]]);
  const inside = demoWriteEffect({ to: VAULT as Address, functionName: "transfer", args: ["0x", "0x", "0x", ["0xaa", "0xbb"]] });
  assert.equal(inside.wallet, undefined, "a private send leaves the public wallet alone");
  assert.deepEqual(inside.sent, ["0xaa"]);
});

console.log(`selftest-public-send: ${passed} passed`);
