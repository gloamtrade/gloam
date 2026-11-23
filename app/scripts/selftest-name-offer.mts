/**
 * Self-test: the "Get your @name" offer (lib/nameOffer).
 *
 *  - shown only to a signed-in account with no name, while the registry is
 *    live and outside the recording demo, and never while names are still
 *    being read (owned null), so it doesn't flash
 *  - "Not now" closes it for that account only: a second account in the same
 *    browser still gets its own offer
 *  - signed out, it reads as closed and closing writes nothing
 *  - the link goes to Receive with the name form opened
 *
 * Run from app/:  ../mcp/node_modules/.bin/tsx scripts/selftest-name-offer.mts
 */
import assert from "node:assert/strict";
import { localStorage } from "./browser-shim.mjs";
import { getAddress } from "viem";

delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;
const win = globalThis.window as unknown as Record<string, unknown>;
win.setTimeout = setTimeout;
win.clearTimeout = clearTimeout;
globalThis.fetch = (async (url: string | URL) => {
  throw new Error(`selftest-name-offer: no network calls allowed (${String(url)})`);
}) as typeof fetch;

const slot = await import("../src/lib/accountSlot");
const scope = await import("../src/lib/accountScope");
const vault = await import("../src/lib/noteVault");
const offer = await import("../src/lib/nameOffer");

slot.enforceAccountScope(true);
scope.setPageReload(() => {});

let passed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  await fn();
  passed++;
  console.log(`ok  ${name}`);
}

const A = getAddress("0x1111111111111111111111111111111111111111");
const B = getAddress("0x2222222222222222222222222222222222222222");
const base = { registryLive: true, demo: false, signedIn: true, closed: false, owned: false as boolean | null };

await test("offered to a signed-in account with no name, and only then", () => {
  assert.equal(offer.shouldOfferName(base), true);
  assert.equal(offer.shouldOfferName({ ...base, owned: true }), false, "has a name");
  assert.equal(offer.shouldOfferName({ ...base, owned: null }), false, "still reading its names: no flash");
  assert.equal(offer.shouldOfferName({ ...base, closed: true }), false, "closed");
  assert.equal(offer.shouldOfferName({ ...base, signedIn: false }), false, "signed out");
  assert.equal(offer.shouldOfferName({ ...base, demo: true }), false, "recording demo");
  assert.equal(offer.shouldOfferName({ ...base, registryLive: false }), false, "no registry");
});

await test("signed out: reads as closed, and closing writes nothing", () => {
  const before = localStorage.length;
  assert.equal(offer.nameOfferClosed(), true);
  offer.closeNameOffer();
  assert.equal(localStorage.length, before, "nothing written");
});

await test("Not now closes it for this account only", async () => {
  await scope.signInAs(A);
  await vault.unlockNoteVault();
  assert.equal(offer.nameOfferClosed(), false, "A has not closed it");
  offer.closeNameOffer();
  assert.equal(offer.nameOfferClosed(), true, "A closed it");

  await vault.notesSettled();
  await slot.unbindSlot();
  await scope.signInAs(null);
  await scope.signInAs(B);
  await vault.unlockNoteVault();
  assert.equal(offer.nameOfferClosed(), false, "B still gets its own offer");

  await vault.notesSettled();
  await slot.unbindSlot();
  await scope.signInAs(null);
  await scope.signInAs(A);
  await vault.unlockNoteVault();
  assert.equal(offer.nameOfferClosed(), true, "and A stays closed when it comes back");
});

await test("the offer opens the name form on Receive", () => {
  assert.equal(offer.GET_NAME_HREF, "/app/vault?tab=move&mode=receive#get-name");
  assert.ok(offer.GET_NAME_HREF.endsWith(offer.GET_NAME_HASH));
});

console.log(`\n${passed} name offer checks passed`);
