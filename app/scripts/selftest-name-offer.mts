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
 * Bug sweep, 23 Nov 2026 (finding 4): the offer showed to people who already
 * own a name (a new device, cleared site data, a fresh account slot) because
 * it only knew the names this browser saved, and only by holder. Now:
 *  - owned is the Receive card's rule: the wallet holds the name, or the name
 *    pays one of this account's Gloam addresses
 *  - the registry's logs find names by holder (registered or given), so a
 *    name bought elsewhere counts
 *  - a failed read is "unknown" and hides the card; only sure answers are
 *    kept, per account, for six hours
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
const own = await import("../src/lib/nameOwnership");

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

await test("owned: held by the wallet or paying this account's Gloam address, from saved names or the registry's logs", async () => {
  const ME = getAddress("0x1111111111111111111111111111111111111111");
  const OTHER = getAddress("0x2222222222222222222222222222222222222222");
  const MY_TAG = "gloamr1.mine";
  const records: Record<string, { name: string; tag: string; holder: `0x${string}`; expires: number } | null | "failed"> = {
    held: { name: "held", tag: "gloamr1.x", holder: ME, expires: 2e9 },
    mytag: { name: "mytag", tag: MY_TAG, holder: OTHER, expires: 2e9 },
    gone: { name: "gone", tag: "gloamr1.y", holder: OTHER, expires: 2e9 },
    lapsed: null,
    flaky: "failed",
  };
  const lookup = async (n: string) => (n in records ? records[n]! : null);
  const base = { address: ME, myTags: [MY_TAG], lookup };
  assert.equal(await own.accountOwnsName({ ...base, remembered: ["held"], namesFromLogs: async () => [] }), true, "a saved name the wallet holds");
  assert.equal(await own.accountOwnsName({ ...base, remembered: ["mytag"], namesFromLogs: async () => [] }), true, "a saved name that pays this account's address, held by another wallet");
  assert.equal(await own.accountOwnsName({ ...base, remembered: [], namesFromLogs: async () => ["held"] }), true, "a name bought on another device, found in the logs");
  assert.equal(await own.accountOwnsName({ ...base, remembered: ["gone"], namesFromLogs: async () => ["lapsed", "gone"] }), false, "given away or lapsed: no name");
  assert.equal(await own.accountOwnsName({ ...base, remembered: [], namesFromLogs: async () => [] }), false, "never had one");
  assert.equal(await own.accountOwnsName({ ...base, remembered: ["flaky"], namesFromLogs: async () => [] }), null, "a failed lookup can't tell");
  assert.equal(
    await own.accountOwnsName({ ...base, remembered: [], namesFromLogs: async () => { throw new Error("rpc down"); } }),
    null,
    "logs that can't be read can't tell"
  );
  assert.equal(await own.accountOwnsName({ ...base, remembered: ["flaky"], namesFromLogs: async () => ["held"] }), true, "a sure yes wins over one failed read");
});

await test("the registry's logs: names registered by the wallet, and names given to it", async () => {
  const H = getAddress("0x3333333333333333333333333333333333333333");
  const NODE = `0x${"ab".repeat(32)}` as `0x${string}`;
  const seen: string[] = [];
  const names = await own.namesHeldInLogs(H, async ({ event, args }) => {
    seen.push(`${event.name}:${Object.keys(args).join(",")}`);
    if (event.name === "NameRegistered" && "holder" in args) return [{ args: { name: "bought" } }];
    if (event.name === "NameTransferred") return [{ args: { node: NODE } }];
    if (event.name === "NameRegistered" && "node" in args) return [{ args: { name: "given" } }];
    return [];
  });
  assert.deepEqual(names.sort(), ["bought", "given"]);
  assert.deepEqual(seen, ["NameRegistered:holder", "NameTransferred:to", "NameRegistered:node"], "asked by the indexed holder, then by node");
});

await test("only sure answers are kept, per account, for six hours", async () => {
  const A2 = getAddress("0x4444444444444444444444444444444444444444");
  const B2 = getAddress("0x5555555555555555555555555555555555555555");
  await vault.notesSettled();
  await slot.unbindSlot();
  await scope.signInAs(null);
  assert.equal(offer.cachedNameOwned(), null, "signed out: nothing");
  offer.rememberNameOwned(true);
  await scope.signInAs(A2);
  await vault.unlockNoteVault();
  assert.equal(offer.cachedNameOwned(), null, "signed out wrote nothing");
  offer.rememberNameOwned(null, 1000);
  assert.equal(offer.cachedNameOwned(1000), null, "unknown is never kept");
  offer.rememberNameOwned(false, 1000);
  assert.equal(offer.cachedNameOwned(1000 + 60_000), false);
  assert.equal(offer.cachedNameOwned(1000 + offer.NAME_OWNED_TTL_MS + 1), null, "stale after six hours");
  await vault.notesSettled();
  await slot.unbindSlot();
  await scope.signInAs(null);
  await scope.signInAs(B2);
  await vault.unlockNoteVault();
  assert.equal(offer.cachedNameOwned(1000 + 60_000), null, "another account doesn't see A's answer");
});

console.log(`\n${passed} name offer checks passed`);
