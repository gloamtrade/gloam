/**
 * Self-test: the wallet balance the bridge panel shows under the amount
 * (lib/bridge formatBridgeBalance). Rounded down, never up: two decimals for a
 * stablecoin, up to six significant digits for a chain's own coin. Also that
 * the panel reads it from the source chain, keeps it to a note when the amount
 * is more, and shows Relay's logo in the footer.
 *
 * Run from app/:  ../mcp/node_modules/.bin/tsx scripts/selftest-bridge-balance.mts
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const { formatBridgeBalance } = await import("../src/lib/bridge");

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`ok  ${name}`);
}

const e = (n: number) => BigInt(10) ** BigInt(n);

test("stablecoins: two decimals, rounded down, grouped", () => {
  assert.equal(formatBridgeBalance(BigInt(727_493_821), 6, true), "727.49");
  assert.equal(formatBridgeBalance(BigInt(290_000), 6, true), "0.29");
  assert.equal(formatBridgeBalance(BigInt(999_999), 6, true), "0.99");
  assert.equal(formatBridgeBalance(BigInt(0), 6, true), "0.00");
  assert.equal(formatBridgeBalance(BigInt(1_234_567_890_000), 6, true), "1,234,567.89");
  // BNB Chain's USDC has 18 decimals
  assert.equal(formatBridgeBalance(BigInt(72_749) * e(16), 18, true), "727.49");
});

test("a chain's own coin: up to six significant digits, rounded down", () => {
  assert.equal(formatBridgeBalance(BigInt("123456789012345678"), 18), "0.123456");
  assert.equal(formatBridgeBalance(BigInt("12345678901234567890"), 18), "12.3456");
  assert.equal(formatBridgeBalance(BigInt("1234567890123456789012"), 18), "1,234.56");
  assert.equal(formatBridgeBalance(BigInt(15) * e(14), 18), "0.0015");
  assert.equal(formatBridgeBalance(BigInt(1), 18), "0.000000000000000001");
  assert.equal(formatBridgeBalance(BigInt(0), 18), "0");
  assert.equal(formatBridgeBalance(e(18), 18), "1");
});

const view = readFileSync(new URL("../src/components/app/BridgeIn.tsx", import.meta.url), "utf8");

test("the balance is read on the source chain, only where wagmi knows it", () => {
  assert.match(view, /config\.chains\.some\(\(c\) => c\.id === chain\.id\)/);
  assert.match(view, /useBalance\(\{\s*address: recipient as Address,\s*chainId: chain\.id as GloamChainId/);
  assert.match(view, /functionName: "balanceOf",\s*args: \[recipient as Address\],\s*chainId: chain\.id as GloamChainId/);
});

test("more than the balance is a note, not a block", () => {
  assert.match(view, /More than your balance on \{over\}\./);
  const amountOk = view.match(/const amountOk = [\s\S]*?;\n/)?.[0] ?? "";
  assert.ok(amountOk.length > 0);
  assert.doesNotMatch(amountOk, /overSource/);
});

test("the footer shows Relay's logo, linked", () => {
  assert.doesNotMatch(view, /Powered by Relay\./);
  assert.match(view, /href="https:\/\/relay\.link"/);
  assert.ok(existsSync(new URL("../public/brand/partners/relay.svg", import.meta.url)));
  assert.ok(existsSync(new URL("../public/brand/partners/relay-white.svg", import.meta.url)));
});

console.log(`\nbridge balance: ${passed} passed`);
