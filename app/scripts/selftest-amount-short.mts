/**
 * Self-test: short amounts in the balance pickers and success dialogs, the
 * Cash out amount field, and paying your own Gloam address.
 *
 *  - lib/amountShort: a stablecoin to cents, anything else to 4 places, always
 *    cut down, never rounded up (1,223.109888 USDC reads 1,223.10, and
 *    1,223.999999 reads 1,223.99, never 1,224.00), whatever the decimals (USDT
 *    and USDC have 18 on BNB Chain). Dust reads "<0.01", never "0".
 *  - lib/shield formatAssetShort on BNB Chain (18-decimal stablecoins, BNB, BDX)
 *    and on Robinhood Chain (USDG, 6 decimals): decided by the token, not its decimals.
 *  - The pickers ("Pay from", "Cash out from") show the short amount with the
 *    network under it; the success dialogs use the short format; the exact
 *    places (the amount field, Max, the fee and You get lines) do not.
 *  - lib/cashOutAmount: Cash out opens with the whole balance written in, to the
 *    last unit; an empty field is no amount and never the whole balance.
 *  - Paying your own Gloam address: allowed, with one quiet line under To.
 *
 * BNB Chain is switched on for this run with placeholder values; nothing reaches a host.
 *
 * Run from app/:  ../mcp/node_modules/.bin/tsx scripts/selftest-amount-short.mts
 */
import "./browser-shim.mts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

for (const k of Object.keys(process.env)) if (k.startsWith("NEXT_PUBLIC_BNB_")) delete process.env[k];
process.env.NEXT_PUBLIC_BNB_ENABLED = "1";
process.env.NEXT_PUBLIC_BNB_POOL = "0x89d3042390204f57b8b4F8949D3c2203E4002164";
process.env.NEXT_PUBLIC_BNB_DEPLOY_BLOCK = "134431196";
process.env.NEXT_PUBLIC_BNB_LIVE_SINCE = "19 November 2026";
globalThis.fetch = (async (url: unknown) => {
  throw new Error(`selftest-amount-short: no network calls allowed (${String(url)})`);
}) as typeof fetch;

const { amountDown, shortAmount, stableTextDown } = await import("../src/lib/amountShort");
const { formatAssetShort, formatAssetShortLabel, formatAssetAmountExact, isStableAsset } = await import("../src/lib/shield");
const nets = await import("../src/lib/networks");
const { CASH_OUT_EMPTY_HELP, readCashOutAmount, wholeBalanceText } = await import("../src/lib/cashOutAmount");
const { OWN_GLOAM_ADDRESS_NOTE, isOwnGloamAddress } = await import("../src/lib/payRecipient");

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`ok  ${name}`);
}

const src = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
const E18 = 10n ** 18n;
const USDT_BNB = "0x55d398326f99059fF775485246999027B3197955";
const USDC_BNB = "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d";
const BDX_BNB = "0x9d10a1ec41Fe7878429BB457e31F9b050D38c633";
const USDG_RH = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const NATIVE = "0x0000000000000000000000000000000000000000";

// ------------------------------------------------------------- lib/amountShort

test("a stablecoin shows cents, cut down: 1,223.109888 reads 1,223.10 in 6 or 18 decimals", () => {
  assert.equal(shortAmount(1_223_109_888n, 6, true), "1,223.10");
  assert.equal(shortAmount(1_223_109_888n * 10n ** 12n + 123n, 18, true), "1,223.10");
  assert.equal(shortAmount(1_202_290_000n, 6, true), "1,202.29");
  assert.equal(shortAmount(5_000_000n, 6, true), "5.00");
  assert.equal(shortAmount(25_000_000_000_000n, 6, true), "25,000,000.00");
});

test("never rounded up: a shown balance is never more than is held", () => {
  assert.equal(shortAmount(1_223_999_999n, 6, true), "1,223.99");
  assert.equal(shortAmount(999_999_999_999_999_999n, 18, true), "0.99");
  assert.equal(amountDown(1_999_999n, 6, 4), "1.9999");
  // whatever the amount, the shown number read back is at most the amount
  for (const raw of [1n, 9_999n, 1_005_000n, 123_456_789n, 10n ** 18n - 1n, 7n * 10n ** 17n + 3n]) {
    for (const [dec, stable] of [[6, true], [18, true], [18, false], [9, false]] as const) {
      if (raw > 10n ** BigInt(dec + 8)) continue;
      const shown = shortAmount(raw, dec, stable);
      if (shown.startsWith("<")) continue;
      const [w, f = ""] = shown.replace(/,/g, "").split(".");
      const back = BigInt(w!) * 10n ** BigInt(dec) + (f ? BigInt(f.padEnd(dec, "0").slice(0, dec)) : 0n);
      assert.ok(back <= raw, `${raw} at ${dec} read ${shown}`);
    }
  }
});

test("dust reads as under a cent (or 0.0001), never as 0; zero reads 0", () => {
  assert.equal(shortAmount(4_000n, 6, true), "<0.01");
  assert.equal(shortAmount(4n * 10n ** 15n, 18, true), "<0.01");
  assert.equal(shortAmount(1n, 18, false), "<0.0001");
  assert.equal(shortAmount(0n, 6, true), "0.00");
  assert.equal(shortAmount(0n, 18, false), "0");
});

test("anything else to 4 places, trailing zeros dropped", () => {
  assert.equal(shortAmount(3_868_049_052_992_449n, 18, false), "0.0038");
  assert.equal(shortAmount(12n * E18, 18, false), "12");
  assert.equal(shortAmount(1_250_000_500_000_000_000_000_000n, 18, false), "1,250,000.5");
  assert.equal(shortAmount(123_456_789_123n, 9, false), "123.4567");
});

test("a Relay amount as text is cut to cents the same way", () => {
  assert.equal(stableTextDown("9.9005400052586123"), "9.90");
  assert.equal(stableTextDown("9.999999"), "9.99");
  assert.equal(stableTextDown("1234.5"), "1,234.50");
  assert.equal(stableTextDown("not a number"), "not a number");
});

// ------------------------------------------------------------- lib/shield, by token

test("BNB Chain: USDT and USDC (18 decimals) show cents; BNB and BDX show 4 places", () => {
  nets.setShownNetworkKey("bnb-mainnet");
  assert.ok(isStableAsset(USDT_BNB) && isStableAsset(USDC_BNB.toLowerCase()));
  assert.ok(!isStableAsset(NATIVE) && !isStableAsset(BDX_BNB));
  assert.equal(formatAssetShortLabel(1_223_109_888_000_000_000_001n * 1000n, USDC_BNB), "1,223,109.88 USDC");
  assert.equal(formatAssetShortLabel(1_223_109_888n * 10n ** 12n, USDT_BNB), "1,223.10 USDT");
  assert.equal(formatAssetShortLabel(3_868_049_052_992_449n, NATIVE), "0.0038 BNB");
  assert.equal(formatAssetShortLabel(1_234_567_891_234n, BDX_BNB), "1,234.5678 BDX");
  // the exact formatter keeps every unit, for the places that must
  assert.equal(formatAssetAmountExact(1_223_109_888_000_000_000_001n, USDC_BNB), "1,223.109888000000000001");
});

test("Robinhood Chain: USDG (6 decimals) shows cents too", () => {
  nets.setShownNetworkKey("robinhood-mainnet");
  assert.equal(formatAssetShortLabel(1_202_290_000n, USDG_RH), "1,202.29 USDG");
  assert.equal(formatAssetShort("1223109888", USDG_RH), "1,223.10");
});

// ------------------------------------------------------------- where it shows, and where it doesn't

const move = src("../src/components/app/MoveView.tsx");
const picker = src("../src/components/app/BalancePicker.tsx");
const shield = src("../src/components/app/ShieldView.tsx");
const swap = src("../src/components/app/VaultSwapView.tsx");
const send = src("../src/components/app/SendView.tsx");

test("the pickers show the short amount, with the network under it in the smaller muted line", () => {
  const options = move.slice(move.indexOf("<BalancePicker"), move.indexOf("</section>", move.indexOf("<BalancePicker")));
  assert.match(options, /formatAssetShort\(n\.amountWei, n\.asset\)/);
  assert.match(options, /network: network\.label,/);
  assert.ok(!/formatAssetAmount\(n\.amountWei/.test(options), "the picker no longer shows 6 places");
  assert.match(picker, /network\?: string;/);
  assert.match(picker, /<span className="block truncate text-\[12px\] text-mute">\s*\{o\.network\}/);
  // a warning colours its own part, never the network
  assert.match(picker, /<span className=\{o\.warn \? "text-warn" : undefined\}>\{o\.sub\}<\/span>/);
});

test("success dialogs show the short amount", () => {
  assert.match(shield, /setSentLabel\(`\$\{shortAmount\(value, decimals, selectedToken\?\.kind === "stablecoin"\)\} \$\{symbol\}`\)/);
  assert.ok(!/frac\.slice\(0, 6\)/.test(shield), "the old 6-place receipt cut is gone");
  assert.match(move, /amount: formatAssetShortLabel\(w\.paymentNote\.amountWei, w\.paymentNote\.asset\)/);
  assert.match(move, /amountLabel: formatAssetShortLabel\(w\.paymentNote\.amountWei, w\.paymentNote\.asset\)/);
  assert.match(swap, /\$\{formatAssetShortLabel\(receipt\.receiveAmount, receipt\.receive\)\} is in your private balance\./);
  assert.match(swap, /const paid = formatAssetShort\(payAmount, pay\);/);
  assert.match(send, /setSentAmount\(shortAmount\(value, token\?\.decimals \?\? 18, token\?\.kind === "stablecoin"\)\);/);
});

test("the exact places stay exact: Max, the fee and You get lines", () => {
  assert.match(move, /const maxEth = selected\s*\?\s*formatUnits\(BigInt\(selected\.amountWei\), assetDecimals\(selected\.asset\)\)/);
  assert.match(move, /onMax=\{\(\) => setSendAmount\(maxEth\)\}/);
  assert.match(move, /fee: \$\{formatAssetLabel\(cashOutFee, selected\.asset\)\}/);
  assert.match(move, /\{formatAssetAmount\(cashOutAmount - outFee, selected\.asset\)\}/);
});

// ------------------------------------------------------------- the Cash out amount field

test("Cash out opens with the whole balance written in, every unit, Max on", () => {
  const r = readCashOutAmount(null, 1_202_290_000n, 6);
  assert.equal(r.text, "1202.29");
  assert.equal(r.amount, 1_202_290_000n);
  assert.ok(r.max && !r.partial && !r.empty && !r.invalid);
  const big = 1_223_109_888_000_000_000_001n;
  const b = readCashOutAmount(null, big, 18);
  assert.equal(b.text, "1223.109888000000000001", "18 decimals, to the last unit");
  assert.equal(b.amount, big);
  assert.equal(wholeBalanceText(big, 18), "1223.109888000000000001");
});

test("an empty field is no amount, never the whole balance", () => {
  for (const empty of ["", " ", "   "]) {
    const r = readCashOutAmount(empty, 1_202_290_000n, 6);
    assert.equal(r.amount, null, JSON.stringify(empty));
    assert.ok(r.empty && !r.max && !r.partial && !r.invalid);
    assert.equal(r.text, empty, "the field stays empty: its placeholder shows, not a value");
  }
  assert.equal(CASH_OUT_EMPTY_HELP, "Enter an amount, or pick Max.");
});

test("a typed amount: partial, the whole balance, too much or not a number", () => {
  const bal = 1_202_290_000n;
  const part = readCashOutAmount("50", bal, 6);
  assert.equal(part.amount, 50_000_000n);
  assert.ok(part.partial && !part.max);
  assert.ok(readCashOutAmount("1202.29", bal, 6).max);
  for (const bad of ["1202.300001", "0", "-1", "1,25", "abc", "1.0000001"]) {
    const r = readCashOutAmount(bad, bal, 6);
    assert.equal(r.amount, null, bad);
    assert.ok(r.invalid && !r.empty, bad);
  }
});

test("MoveView: the field shows real text, its placeholder is a muted 0, and empty never cashes out the whole balance", () => {
  const input = move.slice(move.indexOf('id="cashout-amt"'), move.indexOf("/>", move.indexOf('id="cashout-amt"')));
  assert.match(input, /value=\{cashOutText\}/);
  assert.match(input, /placeholder="0"/);
  assert.match(input, /placeholder:text-faint/);
  assert.ok(!/placeholder:text-foreground/.test(input));
  assert.ok(!/placeholder=\{maxEth\}/.test(move));
  assert.match(move, /useState<string \| null>\(null\);\s*\n\s*const cashOutInputRef/);
  assert.match(move, /const cashOutAmount = cashOutRead\.amount \?\? 0n;/);
  assert.match(move, /const cashOutAmountInvalid = cashOutRead\.amount === null;/);
  assert.match(move, /maxActive=\{cashOutRead\.max\}/);
  assert.match(move, /onMax=\{\(\) => setCashOutInput\(null\)\}/);
  // nothing reads an empty field as the whole balance any more
  assert.ok(!/cashOutInput\.trim\(\) === ""/.test(move));
  assert.ok(!/setCashOutInput\(""\)/.test(move));
  // the button waits for an amount
  assert.match(move, /cashOutFeeUnknown \|\|\s*\n\s*cashOutAmountInvalid \|\|/);
  assert.match(move, /cashOutRead\.empty\s*\n\s*\? CASH_OUT_EMPTY_HELP/);
});

// ------------------------------------------------------------- paying your own Gloam address

test("To is your own Gloam address: allowed, one quiet line, no warning", () => {
  const mine = "gloamr1.abc";
  assert.ok(isOwnGloamAddress(mine, mine));
  assert.ok(isOwnGloamAddress(` ${mine} `, mine));
  assert.ok(!isOwnGloamAddress("gloamr1.xyz", mine));
  assert.ok(!isOwnGloamAddress("", mine));
  assert.ok(!isOwnGloamAddress(mine, null));
  assert.ok(!isOwnGloamAddress("", ""));
  assert.equal(
    OWN_GLOAM_ADDRESS_NOTE,
    "This is your own Gloam address. The money stays yours in a fresh note, which no longer links back to your deposit."
  );
  assert.match(move, /const payingSelf = payStyle === "direct" && !payToWallet && isValidReceiveTag\(payTag\) && isOwnGloamAddress\(payTag, myIdentity\?\.tag\);/);
  const line = move.slice(move.indexOf("{payingSelf && ("), move.indexOf("{OWN_GLOAM_ADDRESS_NOTE}"));
  assert.match(line, /text-mute/);
  assert.ok(!/text-warn|text-danger|role="alert"/.test(line), "no warning colour");
  // nothing in the send path stops it
  assert.equal((move.match(/payingSelf/g) ?? []).length, 2, "declared once, drawn once: never a gate");
});

// ------------------------------------------------------------- copy

test("no em dashes and no 'happy to' in the new copy", () => {
  for (const f of ["../src/lib/amountShort.ts", "../src/lib/cashOutAmount.ts", "../src/lib/payRecipient.ts"]) {
    const s = src(f);
    assert.ok(!s.includes("\u2014"), f);
    assert.ok(!/happy to/i.test(s), f);
  }
});

console.log(`\namount short: ${passed} passed`);
