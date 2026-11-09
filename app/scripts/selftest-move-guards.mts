/**
 * Self-test: Pay, Cash out, Claim and Receive take one click at a time, and show
 * plain words, not viem's long errors (components/app/MoveView). Read from the
 * source, like the other view checks. Overnight sweep, 6 Nov 2026.
 *
 * Run from app/:  ../mcp/node_modules/.bin/tsx scripts/selftest-move-guards.mts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const view = readFileSync(new URL("../src/components/app/MoveView.tsx", import.meta.url), "utf8");
const claimPage = readFileSync(new URL("../src/app/claim/page.tsx", import.meta.url), "utf8");

let n = 0;
function check(name: string, fn: () => void) {
  fn();
  n++;
  console.log(`  ok  ${name}`);
}

check("the cash out button goes through one gate, held from the click to the end of its checks", () => {
  assert.match(view, /onClick=\{\(\) => void startCashOut\(\)\}/);
  assert.match(view, /async function startCashOut\(\) \{\s*\n\s*if \(cashOutGate\.current\) return;\s*\n\s*cashOutGate\.current = true;/);
  assert.match(view, /working \|\|\s*\n\s*cashOutChecking \|\|/);
  assert.ok(!/void \(planActive \? onPrivateCashOut\(\) : onCashOut\(\)\)/.test(view));
});

check("a cash out clears the last payment's claim code, so its success shows the cash out", () => {
  const starts = view.match(/setBusy\(true\);\s*\n\s*setPaidPrivately\(false\);(\s*\n\s*\/\/[^\n]*)?\s*\n\s*setShareBlob\(null\);\s*\n\s*setMemoPosted\(false\);/g) ?? [];
  assert.equal(starts.length, 2, "onCashOut and onPrivateCashOut");
});

check("Claim and secure opens one code at a time", () => {
  assert.match(view, /async function onImportNote\(\) \{\s*\n\s*if \(claimGate\.current\) return;/);
  assert.match(view, /disabled=\{!importText\.trim\(\) \|\| !isConnected \|\| working \|\| claimOpening\}/);
});

check("Check now waits for the scan in flight and never shows the RPC's text", () => {
  // a network switch still starts its own scan: only the button waits
  assert.match(view, /const run = \+\+scanRun\.current;/);
  assert.match(view, /if \(run === scanRun\.current\) setScanning\(false\);/);
  assert.match(view, /disabled=\{scanning\}/);
  assert.ok(!/setInboxStatus\(e instanceof Error \? e\.message/.test(view));
});

check("no raw wallet error on screen", () => {
  assert.ok(!/writeError\?\.message\.slice/.test(view));
  assert.match(view, /\{error \|\| walletErrorForPeople\(writeError\)\}/);
});

check("a request link opened in the tab pays the requester, never a claim link", () => {
  assert.match(view, /setRecipientTag\(r\.to \?\? ""\);[\s\S]{0,200}if \(r\.to\) \{\s*\n\s*setPayStyle\("direct"\);/);
});

check("cash-out copy says the destination is public too", () => {
  assert.ok(!view.includes("Cashing out makes this amount public"));
  assert.ok(view.includes("Cashing out makes the amount and where it goes public"));
});

check("/claim: a damaged unlocked code asks for the whole message instead of offering a claim", () => {
  assert.match(claimPage, /\} catch \{\s*\n\s*return "damaged";/);
  assert.match(claimPage, /ready === "damaged" \? \{ kind: "missing" \} : ready/);
});

console.log(`selftest-move-guards: ${n} checks passed`);
