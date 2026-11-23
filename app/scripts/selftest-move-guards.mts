/**
 * Self-test: Pay, Cash out, Claim and Receive take one click at a time, and show
 * plain words, not viem's long errors (components/app/MoveView). Read from the
 * source, like the other view checks. Overnight sweep, 6 Nov 2026.
 *
 * Run from app/:  ../mcp/node_modules/.bin/tsx scripts/selftest-move-guards.mts
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readCashOutAmount } from "../src/lib/cashOutAmount";

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
  const starts = view.match(/setBusy\(true\);(\s*\n\s*\/\/[^\n]*)?\s*\n\s*setShareBlob\(null\);\s*\n\s*setMemoPosted\(false\);/g) ?? [];
  assert.equal(starts.length, 2, "onCashOut and onPrivateCashOut");
});

check("Claim and secure opens one code at a time", () => {
  assert.match(view, /async function onImportNote\([^)]*\) \{\s*\n\s*if \(claimGate\.current\) return;/);
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
  // #325 cut it to one line that covers both the amount and the destination
  assert.ok(view.includes("Cashing out is public."));
});

check("/claim: a damaged unlocked code asks for the whole message instead of offering a claim", () => {
  assert.match(claimPage, /\} catch \{\s*\n\s*return "damaged";/);
  assert.match(claimPage, /ready === "damaged" \? \{ kind: "missing" \} : ready/);
});

// ---------------------------------------------------------------- amount fields

/** Every amount input in the app (inputMode="decimal"), as file and the JSX of its tag. */
function amountInputs(): { file: string; tag: string }[] {
  const root = fileURLToPath(new URL("../src/", import.meta.url));
  const out: { file: string; tag: string }[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith(".tsx")) {
        const body = readFileSync(p, "utf8");
        for (let at = body.indexOf("<input"); at !== -1; at = body.indexOf("<input", at + 1)) {
          const tag = body.slice(at, body.indexOf("/>", at));
          if (/inputMode="decimal"/.test(tag)) out.push({ file: p.slice(root.length), tag });
        }
      }
    }
  };
  walk(root);
  return out;
}

check("no amount field shows a placeholder that looks like a value", () => {
  const inputs = amountInputs();
  assert.ok(inputs.length >= 15, `found ${inputs.length} amount fields`);
  for (const { file, tag } of inputs) {
    const id = `${file}: ${tag.slice(0, 80).replace(/\s+/g, " ")}`;
    // styled like typed text, it reads as an amount already there
    assert.ok(!/placeholder:text-(foreground|soft|mute)\b/.test(tag), `${id}: placeholder styled like a value`);
    // a field drawn by hand styles its placeholder in the faint colour; .gl-input does it in CSS
    if (/placeholder=/.test(tag) && !/\bgl-input\b/.test(tag)) assert.match(tag, /placeholder:text-faint/, id);
    // a balance or a sample amount as the placeholder reads as a value: only a plain 0
    const ph = /placeholder=(\{[^}]*\}|"[^"]*")/.exec(tag)?.[1];
    if (ph) assert.ok(ph === '"0"' || ph === '"0.00"', `${id}: placeholder ${ph}`);
  }
});

check("an empty cash-out amount never cashes out the whole balance", () => {
  // the field opens with the whole balance as real text, to the last unit
  const opened = readCashOutAmount(null, 1_223_109_888_000_000_000_001n, 18);
  assert.equal(opened.text, "1223.109888000000000001");
  assert.equal(opened.amount, 1_223_109_888_000_000_000_001n);
  assert.ok(opened.max);
  // cleared: no amount, Max off, the button off
  const cleared = readCashOutAmount("", 1_202_290_000n, 6);
  assert.equal(cleared.amount, null);
  assert.ok(cleared.empty && !cleared.max);
  assert.ok(!/cashOutInput\.trim\(\) === ""/.test(view), "nothing reads an empty field as the whole balance");
  assert.ok(!/placeholder=\{maxEth\}/.test(view));
  assert.match(view, /const cashOutAmount = cashOutRead\.amount \?\? 0n;/);
  assert.match(view, /const cashOutAmountInvalid = cashOutRead\.amount === null;/);
  // the button stays off on no amount; only a typed amount over this balance that the other
  // balances cover (cash out across, built from typed text only) turns it on
  assert.match(view, /cashOutFeeUnknown \|\|\s*\n\s*cashAcross\.running \|\|\s*\n\s*\(cashOutAmountInvalid && !cashOutAcrossPlan\?\.ok\) \|\|/);
  assert.match(view, /cashOutTyped == null \|\| cashOutTyped <= noteWei\) return null;/);
  // Max writes the whole balance back in, exactly
  assert.match(view, /onMax=\{\(\) => setCashOutInput\(null\)\}/);
});

console.log(`selftest-move-guards: ${n} checks passed`);
