/**
 * Self-test: the one formatter every shown token amount goes through
 * (lib/amountShort displayAmount, displayAmountText, displayAmountNumber, and
 * lib/shield formatAssetAmount / formatAssetLabel on top of it).
 *
 *  - Two places, always written out, cut down and never rounded up:
 *    7.869953 reads 7.86, 1,223.999999 reads 1,223.99, never 1,224.00.
 *  - Above zero but under a cent reads "<0.01"; zero reads "0.00".
 *  - Thousands separators as before: 1,200.00, 25,000,000.00.
 *  - Any decimals: USDG (6), ETH and $GLOAM (18), USDT and USDC (18 on BNB Chain).
 *  - Bigints past what a float holds keep every digit of the whole part.
 *  - The exact formatter (formatAssetAmountExact) still keeps every unit, for
 *    what is sent, copied, exported or proved.
 *
 * BNB Chain is switched on for this run with placeholder values; nothing reaches a host.
 *
 * Run from app/:  ../mcp/node_modules/.bin/tsx scripts/selftest-amount-display.mts
 */
import "./browser-shim.mts";
import assert from "node:assert/strict";

for (const k of Object.keys(process.env)) if (k.startsWith("NEXT_PUBLIC_BNB_")) delete process.env[k];
process.env.NEXT_PUBLIC_BNB_ENABLED = "1";
process.env.NEXT_PUBLIC_BNB_POOL = "0x89d3042390204f57b8b4F8949D3c2203E4002164";
process.env.NEXT_PUBLIC_BNB_DEPLOY_BLOCK = "134431196";
process.env.NEXT_PUBLIC_BNB_LIVE_SINCE = "19 November 2026";
globalThis.fetch = (async (url: unknown) => {
  throw new Error(`selftest-amount-display: no network calls allowed (${String(url)})`);
}) as typeof fetch;

const { displayAmount, displayAmountText, displayAmountNumber, SHOWN_PLACES, SHOWN_DUST } = await import("../src/lib/amountShort");
const { formatAssetAmount, formatAssetLabel, formatAssetAmountExact } = await import("../src/lib/shield");
const nets = await import("../src/lib/networks");

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`ok  ${name}`);
}

const E6 = 10n ** 6n;
const E18 = 10n ** 18n;
const USDG_RH = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const USDT_BNB = "0x55d398326f99059fF775485246999027B3197955";
const NATIVE = "0x0000000000000000000000000000000000000000";

/** The shown text read back into units: what the screen claims is held. */
function readBack(shown: string, decimals: number): bigint {
  const [w, f = ""] = shown.replace(/,/g, "").split(".");
  return BigInt(w!) * 10n ** BigInt(decimals) + BigInt(f.padEnd(decimals, "0").slice(0, decimals) || "0");
}

test("two places, always written out", () => {
  assert.equal(SHOWN_PLACES, 2);
  assert.equal(displayAmount(5n * E6, 6), "5.00");
  assert.equal(displayAmount(12_500_000n, 6), "12.50");
  assert.equal(displayAmount(600n * E18, 18), "600.00");
});

test("cut down, never rounded up: 7.869953 reads 7.86", () => {
  assert.equal(displayAmount(7_869_953n, 6), "7.86");
  assert.equal(displayAmount(7_869_953n * 10n ** 12n, 18), "7.86");
  assert.equal(displayAmount(1_223_999_999n, 6), "1,223.99");
  assert.equal(displayAmount(E18 - 1n, 18), "0.99");
  assert.equal(displayAmount(213_400_000_000_000_000n, 18), "0.21", "0.2134 ETH reads 0.21");
  assert.equal(displayAmount(2_939_999n, 6), "2.93");
});

test("a shown amount is never more than is held", () => {
  const raws = [1n, 9_999n, 10_000n, 1_005_000n, 7_869_953n, 123_456_789n, E18 - 1n, 7n * 10n ** 17n + 3n, 999_999_999_999n];
  for (const raw of raws) {
    for (const dec of [6, 8, 9, 18]) {
      const shown = displayAmount(raw, dec);
      if (shown === SHOWN_DUST) continue;
      const back = readBack(shown, dec);
      assert.ok(back <= raw, `${raw} at ${dec} decimals read ${shown}`);
      // and it is the largest two-place figure that is not more
      assert.ok(raw - back < 10n ** BigInt(Math.max(dec - 2, 0)), `${raw} at ${dec} decimals cut too far: ${shown}`);
    }
  }
});

test('above zero but under a cent reads "<0.01"; zero reads "0.00"', () => {
  assert.equal(SHOWN_DUST, "<0.01");
  assert.equal(displayAmount(1n, 6), "<0.01");
  assert.equal(displayAmount(9_999n, 6), "<0.01");
  assert.equal(displayAmount(10_000n, 6), "0.01");
  assert.equal(displayAmount(1n, 18), "<0.01");
  assert.equal(displayAmount(4n * 10n ** 15n, 18), "<0.01", "0.004 ETH");
  assert.equal(displayAmount(0n, 6), "0.00");
  assert.equal(displayAmount(0n, 18), "0.00");
  assert.equal(displayAmount(0n, 0), "0.00");
});

test("thousands separators as before", () => {
  assert.equal(displayAmount(1_200n * E6, 6), "1,200.00");
  assert.equal(displayAmount(1_223_109_888n, 6), "1,223.10");
  assert.equal(displayAmount(25_000_000n * E6, 6), "25,000,000.00");
  assert.equal(displayAmount(999n * E6, 6), "999.00");
  assert.equal(displayAmount(1_000n * E6, 6), "1,000.00");
});

test("6- and 18-decimal tokens read the same for the same amount", () => {
  for (const [six, eighteen, shown] of [
    [1_250_500_000n, 1_250_500_000n * 10n ** 12n, "1,250.50"],
    [7_869_953n, 7_869_953n * 10n ** 12n + 999n, "7.86"],
    [9_999n, 9_999n * 10n ** 12n, "<0.01"],
  ] as const) {
    assert.equal(displayAmount(six, 6), shown);
    assert.equal(displayAmount(eighteen, 18), shown);
  }
});

test("bigints past a float keep every digit of the whole part", () => {
  // 123,456,789,012,345,678,901.23 at 18 decimals: Number() would lose the tail
  const big = 123_456_789_012_345_678_901_239_999_999_999_999_999n;
  assert.equal(displayAmount(big, 18), "123,456,789,012,345,678,901.23");
  assert.equal(displayAmount(2n ** 200n, 0), `${(2n ** 200n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.00`);
  assert.equal(displayAmount(10n ** 30n + 1n, 6), "1,000,000,000,000,000,000,000,000.00");
});

test("negative amounts cut toward zero", () => {
  assert.equal(displayAmount(-7_869_953n, 6), "-7.86");
  assert.equal(displayAmount(-1n, 6), "<0.01");
});

test("decimal text (a Relay quote, an API figure) reads the same way", () => {
  assert.equal(displayAmountText("9.9005400052586123"), "9.90");
  assert.equal(displayAmountText("2.939999"), "2.93");
  assert.equal(displayAmountText("7.869953"), "7.86");
  assert.equal(displayAmountText("1234.5"), "1,234.50");
  assert.equal(displayAmountText("1,234.5"), "1,234.50", "separators in the text are read through");
  assert.equal(displayAmountText("600"), "600.00");
  assert.equal(displayAmountText("0"), "0.00");
  assert.equal(displayAmountText("0.000000000000000000000001"), "<0.01", "more places than 18");
  assert.equal(displayAmountText(" 12.3 "), "12.30");
  assert.equal(displayAmountText("-3.456"), "-3.45");
  // not a plain decimal: shown as it came, never guessed at
  assert.equal(displayAmountText("1,25"), "1,25");
  assert.equal(displayAmountText("abc"), "abc");
  assert.equal(displayAmountText("1e-7"), "1e-7");
});

test("a number (a float total) reads as its shortest text, so float error never cuts a cent", () => {
  assert.equal(displayAmountNumber(0.29), "0.29", "0.29 * 100 is 28.999..., must still read 0.29");
  assert.equal(displayAmountNumber(1.1), "1.10");
  assert.equal(displayAmountNumber(7.869953), "7.86");
  assert.equal(displayAmountNumber(1234.567891), "1,234.56");
  assert.equal(displayAmountNumber(25_000), "25,000.00");
  assert.equal(displayAmountNumber(0), "0.00");
  assert.equal(displayAmountNumber(1e-7), "<0.01");
  assert.equal(displayAmountNumber(1e21), "1,000,000,000,000,000,000,000.00");
  assert.equal(displayAmountNumber(-2.5), "-2.50");
  assert.equal(displayAmountNumber(Number.NaN), "0.00");
  assert.equal(displayAmountNumber(Number.POSITIVE_INFINITY), "0.00");
});

test("lib/shield: formatAssetAmount and formatAssetLabel use the token's own decimals", () => {
  nets.setShownNetworkKey("robinhood-mainnet");
  assert.equal(formatAssetAmount(7_869_953n, USDG_RH), "7.86");
  assert.equal(formatAssetLabel(600n * E6, USDG_RH), "600.00 USDG");
  assert.equal(formatAssetAmount("2939999", USDG_RH), "2.93", "a note's amountWei string");
  assert.equal(formatAssetLabel(213_400_000_000_000_000n, NATIVE), "0.21 ETH");
  assert.equal(formatAssetAmount(0n, USDG_RH), "0.00");
  assert.equal(formatAssetAmount(1n, NATIVE), "<0.01");
  nets.setShownNetworkKey("bnb-mainnet");
  assert.equal(formatAssetLabel(1_223_109_888n * 10n ** 12n + 1n, USDT_BNB), "1,223.10 USDT", "USDT has 18 decimals on BNB Chain");
  assert.equal(formatAssetLabel(3_868_049_052_992_449n, NATIVE), "<0.01 BNB");
  assert.equal(formatAssetLabel(12n * E18, NATIVE), "12.00 BNB");
});

test("the exact formatter still keeps every unit, for what is sent, copied, exported or proved", () => {
  nets.setShownNetworkKey("robinhood-mainnet");
  assert.equal(formatAssetAmountExact(7_869_953n, USDG_RH), "7.869953");
  assert.equal(formatAssetAmountExact(1_250_500_000n, USDG_RH, 2), "1,250.50");
  nets.setShownNetworkKey("bnb-mainnet");
  assert.equal(formatAssetAmountExact(1_223_109_888_000_000_000_001n, USDT_BNB), "1,223.109888000000000001");
});

console.log(`\namount display: ${passed} passed`);
