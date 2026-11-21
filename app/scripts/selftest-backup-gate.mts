/**
 * Self-test: the backup step before money first lands in this browser's private
 * balance (lib/backupGate).
 *
 *  - it shows only with recovery off, a wallet connected, the settings read,
 *    and a way to make the key here (the wallet's signature, else a passkey)
 *  - never in the demo, never for a Gloam wallet (it has its own offer), never
 *    once recovery was turned off here by the person
 *  - "Skip for now" holds for a week per wallet, then it asks again
 *  - asking the browser to keep storage is once per page load and never throws
 *
 * Run from app/:  ../mcp/node_modules/.bin/tsx scripts/selftest-backup-gate.mts
 */
import assert from "node:assert/strict";
import { localStorage, resetBrowser } from "./browser-shim.mjs";

const { BACKUP_SKIP_MS, backupRoute, backupSkippedAt, backupStepNeeded, keepStorage, skipBackupStep } = await import(
  "../src/lib/backupGate"
);

let n = 0;
function check(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve(fn()).then(() => {
    n++;
    console.log(`  ok  ${name}`);
  });
}

const NOW = 1_800_000_000_000;
const base = {
  demo: false,
  active: true,
  ready: true,
  on: false,
  turnedOff: false,
  embedded: false,
  route: "wallet" as const,
  skippedAt: null,
  now: NOW,
};

await check("asks a connected browser wallet with recovery off", () => {
  assert.equal(backupStepNeeded(base), true);
  assert.equal(backupStepNeeded({ ...base, route: "passkey" }), true, "a passkey route asks too");
});

await check("never asks once recovery is on, or after the person turned it off here", () => {
  assert.equal(backupStepNeeded({ ...base, on: true }), false);
  assert.equal(backupStepNeeded({ ...base, turnedOff: true }), false);
});

await check("never in the demo, signed out, or before the settings are read", () => {
  assert.equal(backupStepNeeded({ ...base, demo: true }), false);
  assert.equal(backupStepNeeded({ ...base, active: false }), false);
  assert.equal(backupStepNeeded({ ...base, ready: false }), false, "unknown is not off");
});

await check("never for a Gloam wallet (its own offer), nor where no key can be made", () => {
  assert.equal(backupStepNeeded({ ...base, embedded: true }), false);
  assert.equal(backupStepNeeded({ ...base, route: null }), false);
});

await check("Skip for now holds a week, then it asks again", () => {
  assert.equal(backupStepNeeded({ ...base, skippedAt: NOW - 1000 }), false);
  assert.equal(backupStepNeeded({ ...base, skippedAt: NOW - BACKUP_SKIP_MS + 1 }), false);
  assert.equal(backupStepNeeded({ ...base, skippedAt: NOW - BACKUP_SKIP_MS }), true);
});

await check("the route: the wallet's signature where it can make the key, else a passkey", () => {
  assert.equal(backupRoute({ walletOk: true, passkeyOk: true }), "wallet");
  assert.equal(backupRoute({ walletOk: false, passkeyOk: true }), "passkey", "Tempo Wallet: its signatures change");
  assert.equal(backupRoute({ walletOk: false, passkeyOk: false }), null);
});

await check("a skip is remembered per wallet, whatever the letter case", () => {
  resetBrowser();
  const a = "0x5E60000000000000000000000000000000009fbA";
  const b = "0x1111111111111111111111111111111111111234";
  assert.equal(backupSkippedAt(a), null);
  skipBackupStep(a, NOW);
  assert.equal(backupSkippedAt(a.toLowerCase()), NOW);
  assert.equal(backupSkippedAt(b), null, "another wallet is still asked");
  localStorage.setItem(`gloam.backup.skip.v1:${b.toLowerCase()}`, "garbage");
  assert.equal(backupSkippedAt(b), null, "an unreadable mark counts as no skip");
});

await check("asking the browser to keep storage: once per page load, and never throws", async () => {
  let asked = 0;
  let checked = 0;
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      storage: {
        persisted: async () => {
          checked++;
          return false;
        },
        persist: async () => {
          asked++;
          throw new Error("refused");
        },
      },
    },
  });
  keepStorage();
  keepStorage();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(checked, 1);
  assert.equal(asked, 1, "a refusal is swallowed, and it isn't asked twice");
});

console.log(`selftest-backup-gate: ${n} checks passed`);
