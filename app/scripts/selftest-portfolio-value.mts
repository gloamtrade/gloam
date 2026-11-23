/**
 * Self-test: the Portfolio's private balance headline. A vault of 100 USDG and
 * 1,000 GLOAM read "2 assets" once an unpriced asset stopped being counted as
 * $0; it reads "$100 + 1,000 GLOAM" where GLOAM has no price, and dollars only
 * when everything is priced. What sits beside the dollars is an amount with
 * two places, cut down (lib/amountShort).
 *
 * Run from app/:  ../mcp/node_modules/.bin/tsx scripts/selftest-portfolio-value.mts
 */
import assert from "node:assert/strict";
import { privateHeadline, tidyAmount } from "../src/lib/portfolioValue";

const usd = (n: number) => `$${n.toLocaleString("en-US")}`;
const h = (sealedUsd: number, unpriced: string[], showUsd = true) =>
  privateHeadline({ showUsd, sealedUsd, unpriced, vaultValue: "2 assets", formatUsd: usd });

assert.equal(h(1100, []), "$1,100", "everything priced: dollars");
assert.equal(h(100, ["1,000 GLOAM"]), "$100 + 1,000 GLOAM", "the priced part, and the amount of what has no price");
assert.equal(h(0, ["500 EURC"]), "500 EURC", "nothing priced: the amount, never $0");
assert.equal(h(10, ["500 EURC", "0.1 ETH", "3 cbBTC", "1 PONS"]), "$10 + 500 EURC + 0.1 ETH + 2 more");
assert.equal(h(0, []), "$0", "an empty vault");
assert.equal(h(100, ["1,000 GLOAM"], false), "2 assets", "dollars off: amounts");

// The amounts in the big number: two places, cut down and never rounded up, like
// every amount the app shows (lib/amountShort), since 23 Nov 2026.
assert.equal(h(1204, [`${tidyAmount(8.032039)} PONS`]), "$1,204 + 8.03 PONS", "the reported headline");
assert.equal(tidyAmount(8.032039), "8.03");
assert.equal(tidyAmount(7.869953), "7.86", "cut down, never 7.87");
assert.equal(tidyAmount(8), "8.00");
assert.equal(tidyAmount(500), "500.00", "EURC stays by amount");
assert.equal(tidyAmount(500.5), "500.50");
assert.equal(tidyAmount(1234.567891), "1,234.56", "never rounded up to 1,235");
assert.equal(tidyAmount(999_999.4), "999,999.40");
assert.equal(tidyAmount(12_345_678.123456), "12,345,678.12");
assert.equal(tidyAmount(0.0339), "0.03");
assert.equal(tidyAmount(0.29), "0.29", "no float error turns 0.29 into 0.28");
assert.equal(tidyAmount(0.00012345), "<0.01");
assert.equal(tidyAmount(0.00001), "<0.01");
assert.equal(tidyAmount(0), "0.00");
assert.equal(tidyAmount(Number.NaN), "0.00");
assert.equal(h(10, [`${tidyAmount(500)} EURC`]), "$10 + 500.00 EURC", "EURC is left out of the dollars and named by amount");
for (const n of [8.032039, 0.123456789, 1234.567891, 3.14159265, 99.999999, 0.000123456789]) {
  assert.match(tidyAmount(n), /^(<0\.01|[\d,]+\.\d{2})$/, `${n} reads two places: ${tidyAmount(n)}`);
}
console.log("selftest-portfolio-value: all checks passed");
