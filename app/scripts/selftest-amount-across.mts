/**
 * Self-test: two places on the screens only next-release has (lib/amountShort).
 *
 *  - One balance on every network (AllNetworksCard): each amount from its raw
 *    units through displayAmount, never through a float, so 0.999999999999999999
 *    ETH reads 0.99, never 1.00.
 *  - Cash-out receipts: the list (Prove > Cash out) and the receipt sheet show
 *    two places, cut down, like the payroll invoice; the transaction it links to
 *    has every unit.
 *  - Pay and cash out in parts (PayAcross, CashOutAcross): how a run ended and
 *    each part read two places; while a run goes, or waits on Resume, its line
 *    says the amount typed with every unit, as a single payment's Sending line does.
 *  - MoveView's lines for paying or cashing out in parts (up to, fee, You get)
 *    read two places.
 *
 * Nothing reaches a host.
 *
 * Run from app/:  ../mcp/node_modules/.bin/tsx scripts/selftest-amount-across.mts
 */
import "./browser-shim.mts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

globalThis.fetch = (async (url: unknown) => {
  throw new Error(`selftest-amount-across: no network calls allowed (${String(url)})`);
}) as typeof fetch;

const { displayAmount } = await import("../src/lib/amountShort");
const { formatAssetLabel, formatAssetAmountExact, assetLabel } = await import("../src/lib/shield");
const { payRunTotal, payRunPaid } = await import("../src/lib/payAcross");
const { cashOutTotal, cashOutPaid } = await import("../src/lib/cashOutAcross");
const nets = await import("../src/lib/networks");

const src = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
const E18 = 10n ** 18n;
const USDG_RH = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`ok  ${name}`);
}

test("one balance on every network: two places from the raw units, never rounded up through a float", () => {
  const card = src("../src/components/app/AllNetworksCard.tsx");
  assert.match(card, /const amountOf = \(r: PricedHolding\) => `\$\{displayAmount\(r\.amount, r\.decimals\)\} \$\{r\.symbol\}`;/);
  assert.ok(!/tidyAmount|formatUnits/.test(card), "no float on the way to the screen");
  // what a float would have done: Number("0.999999999999999999") is 1
  assert.equal(Number("0.999999999999999999"), 1);
  assert.equal(displayAmount(E18 - 1n, 18), "0.99");
  assert.equal(displayAmount(1_223_109_888n, 6), "1,223.10");
  assert.equal(displayAmount(4_000_000_000_000n, 18), "<0.01");
  assert.equal(displayAmount(0n, 18), "0.00");
});

test("cash-out receipts: the list and the sheet show two places, cut down", () => {
  const sheet = src("../src/components/app/CashOutReceiptSheet.tsx");
  assert.match(sheet, /const money = \(raw: bigint\) => `\$\{displayAmount\(raw, decimals\)\} \$\{symbol\}`;/);
  assert.ok(!/formatUnits|function exact/.test(sheet), "the every-unit formatter is gone from the sheet");
  // every money line goes through it: Cashed out, the fee, what the wallet got (twice)
  assert.equal((sheet.match(/money\(receipt\.(amount|fee|delivered)\)/g) ?? []).length, 4);
  const list = src("../src/components/app/prove/CashOutReceipts.tsx");
  assert.match(list, /const amount = \(raw: bigint, asset: string\) => formatAssetLabel\(raw, asset\);/);
  assert.ok(!/formatAssetAmountExact/.test(list));
  nets.setShownNetworkKey("robinhood-mainnet");
  // 1,250.505 USDG cashed out, 0.005 fee: never rounded up to 1,250.51
  assert.equal(formatAssetLabel(1_250_505_000n, USDG_RH), "1,250.50 USDG");
  assert.equal(formatAssetLabel(5_000n, USDG_RH), "<0.01 USDG");
});

test("pay in parts: how it ended reads two places, the run in flight says the typed amount", () => {
  const view = src("../src/components/app/PayAcross.tsx");
  assert.match(view, /const total = formatAssetLabel\(payRunTotal\(run\), run\.asset\);/);
  assert.match(view, /const paid = formatAssetLabel\(payRunPaid\(run\), run\.asset\);/);
  assert.match(view, /const typed = `\$\{formatAssetAmountExact\(payRunTotal\(run\), run\.asset\)\} \$\{assetLabel\(run\.asset\)\}`;/);
  assert.match(view, /`Paying \$\{typed\} to \$\{to\}`/);
  assert.match(view, /`Your payment of \$\{typed\} to \$\{to\} isn't finished`/);
  assert.match(view, /Paid \{total\} to \{to\} privately/);
  assert.match(view, /Paid \{paid\} of \{total\} to \{to\}/);
  nets.setShownNetworkKey("robinhood-mainnet");
  // 12.345678 USDG typed, in two parts, one landed
  const run = {
    asset: USDG_RH,
    rows: [
      { amount: "10000000", status: "paid" },
      { amount: "2345678", status: "failed" },
    ],
  } as unknown as Parameters<typeof payRunTotal>[0];
  assert.equal(formatAssetLabel(payRunTotal(run), USDG_RH), "12.34 USDG");
  assert.equal(`${formatAssetAmountExact(payRunTotal(run), USDG_RH)} ${assetLabel(USDG_RH)}`, "12.345678 USDG");
  assert.equal(typeof payRunPaid(run), "bigint");
});

test("cash out in parts: how it ended and each part read two places, the run in flight says the typed amount", () => {
  const view = src("../src/components/app/CashOutAcross.tsx");
  assert.match(view, /const total = formatAssetLabel\(cashOutTotal\(run\), run\.asset\);/);
  assert.match(view, /const paid = formatAssetLabel\(cashOutPaid\(run\), run\.asset\);/);
  assert.match(view, /const typed = `\$\{formatAssetAmountExact\(cashOutTotal\(run\), run\.asset\)\} \$\{assetLabel\(run\.asset\)\}`;/);
  assert.match(view, /`Cashing out \$\{typed\}`/);
  assert.match(view, /`Your cash out of \$\{typed\} isn't finished`/);
  assert.match(view, /`Cashed out \$\{total\} as \$\{p\.parts\} withdrawals to the same wallet\.`/);
  assert.match(view, /Part \{i \+ 1\}: \{formatAssetLabel\(x\.amount, run\.asset\)\}/);
  nets.setShownNetworkKey("robinhood-mainnet");
  const run = {
    asset: USDG_RH,
    parts: [
      { amount: "5000000", status: "paid" },
      { amount: "2999999", status: "paid" },
    ],
  } as unknown as Parameters<typeof cashOutTotal>[0];
  assert.equal(formatAssetLabel(cashOutTotal(run), USDG_RH), "7.99 USDG");
  assert.equal(formatAssetAmountExact(cashOutTotal(run), USDG_RH), "7.999999");
  assert.equal(typeof cashOutPaid(run), "bigint");
});

test("MoveView: paying or cashing out in parts shows up to, fee and You get in two places", () => {
  const move = src("../src/components/app/MoveView.tsx");
  assert.match(move, /You can send up to \$\{formatAssetLabel\(acrossPlan\.most, selected\.asset\)\}/);
  assert.match(move, /You can cash out up to \$\{formatAssetLabel\(cashOutAcrossPlan\.most, selected\.asset\)\}/);
  assert.match(move, /fee on each, \$\{formatAssetLabel\(acrossFee, selected\.asset\)\} in total/);
  assert.match(move, /formatAssetAmount\(cashOutAcrossPlan\?\.ok \? acrossReceived : cashOutAmount - outFee, selected\.asset\)/);
});

test("no em dashes and no 'happy to' in the changed screens", () => {
  for (const f of [
    "../src/components/app/AllNetworksCard.tsx",
    "../src/components/app/CashOutReceiptSheet.tsx",
    "../src/components/app/prove/CashOutReceipts.tsx",
    "../src/components/app/PayAcross.tsx",
    "../src/components/app/CashOutAcross.tsx",
  ]) {
    const s = src(f);
    assert.ok(!s.includes("—"), f);
    assert.ok(!/happy to/i.test(s), f);
  }
});

console.log(`\namount across: ${passed} passed`);
