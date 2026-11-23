/**
 * Self-test: the private balance on every network, for the home screen
 * (lib/allNetworkBalances, components/app/AllNetworksCard).
 *
 * The app shows one network at a time, so a payment that landed on Ethereum or
 * BNB Chain while Robinhood Chain was shown stayed out of sight. Here, with
 * notes on three networks in one signed-in account's store:
 *  - each network's money is summed by asset, by the rules each network's own
 *    view uses: claimed payments the vault hasn't shown, notes on their way and
 *    spent ones are never counted, and the same payment saved twice counts once
 *  - prices: the gas coin by its own feed (ETH, BNB), a dollar stablecoin $1, a
 *    CoinGecko-marked token its mark; a token with no price is listed and left
 *    out of the total
 *  - another account's notes are never counted, and signed out shows nothing
 *  - the card shows only when money sits on a network other than the one shown
 *
 * Run from app/:  ../mcp/node_modules/.bin/tsx scripts/selftest-all-networks.mts
 */
import assert from "node:assert/strict";
import { localStorage } from "./browser-shim.mjs";
import { getAddress, type Address, type Hex } from "viem";

delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;
process.env.NEXT_PUBLIC_BNB_ENABLED = "1";
process.env.NEXT_PUBLIC_BNB_POOL = "0x89d3042390204f57b8b4F8949D3c2203E4002164";
process.env.NEXT_PUBLIC_BNB_DEPLOY_BLOCK = "134300000";
process.env.NEXT_PUBLIC_BNB_LIVE_SINCE = "19 November 2026";
const win = globalThis.window as unknown as Record<string, unknown>;
win.setTimeout = setTimeout;
win.clearTimeout = clearTimeout;
globalThis.fetch = (async (url: string | URL) => {
  throw new Error(`selftest-all-networks: no network calls allowed (${String(url)})`);
}) as typeof fetch;

localStorage.setItem("gloam.network", "robinhood-mainnet");

type LocalNote = import("../src/lib/shield").LocalNote;
type GloamNetwork = import("../src/lib/networks").GloamNetwork;

const slot = await import("../src/lib/accountSlot");
const scope = await import("../src/lib/accountScope");
const vault = await import("../src/lib/noteVault");
const nets = await import("../src/lib/networks");
const all = await import("../src/lib/allNetworkBalances");
const tokens = await import("../src/lib/tokens");

slot.enforceAccountScope(true);
scope.setPageReload(() => {});

let passed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  await fn();
  passed++;
  console.log(`ok  ${name}`);
}

const ME = getAddress("0x1111111111111111111111111111111111111111");
const OTHER = getAddress("0x2222222222222222222222222222222222222222");
const POOL = getAddress("0x39E28Cde55CAB798874746ac52cb4B5Cc99a0194");
const NATIVE = "0x0000000000000000000000000000000000000000";

const live = (key: Parameters<typeof nets.getNetwork>[0], pool: Address = POOL): GloamNetwork => ({ ...nets.getNetwork(key), pool, status: "live" });
const RH = live("robinhood-mainnet");
const ETH = live("ethereum-mainnet");
const BNB = live("bnb-mainnet", getAddress("0x89d3042390204f57b8b4F8949D3c2203E4002164"));
const NETWORKS = [RH, ETH, BNB];

/** A token the app lists on `chainId` by symbol. */
const token = (chainId: number, symbol: string) => {
  const t = tokens.knownTokens(chainId).find((x) => x.symbol === symbol);
  assert.ok(t, `${symbol} listed on ${chainId}`);
  return t!;
};
const USDG_RH = token(RH.chainId, "USDG");
const USDC_ETH = token(ETH.chainId, "USDC");
const USDT_BNB = token(BNB.chainId, "USDT");

let k = 0;
const hex = (s: string) => `0x${Buffer.from(s).toString("hex").padStart(64, "0").slice(-64)}` as Hex;
function note(net: GloamNetwork, asset: string, amountWei: string, extra: Partial<LocalNote> = {}): LocalNote {
  k++;
  return {
    id: `n-${k}`,
    chainId: net.chainId,
    pool: net.pool as Address,
    asset: asset as Address,
    amountWei,
    commitment: hex(`${k}c`),
    secret: hex(`${k}a`),
    nullifier: hex(`${k}b`),
    bound: true,
    scheme: "poseidon",
    leafIndex: k,
    txHash: hex(`${k}d`),
    from: ME,
    createdAt: 1_700_000_000_000 + k,
    status: "open",
    source: "local",
    ...extra,
  };
}

const PRICES = { ethUsd: 3000, bnbUsd: 600, hypeUsd: 30, marks: new Map<string, number>() };

await scope.signInAs(ME);
await vault.unlockNoteVault();

const twice = note(ETH, USDC_ETH.address, "5000000"); // 5 USDC on Ethereum
await vault.setAllNotes([
  note(RH, USDG_RH.address, "50000000"), // 50 USDG
  note(RH, NATIVE, "1000000000000000000"), // 1 ETH on Robinhood Chain
  note(ETH, NATIVE, "7000000000000000"), // 0.007 ETH on Ethereum
  twice,
  { ...twice, id: "n-copy" }, // the same payment saved twice (another tab)
  note(ETH, USDC_ETH.address, "9000000", { unfunded: true }), // a claimed payment the vault hasn't shown
  note(ETH, USDC_ETH.address, "11000000", { sweepPending: true }), // a move on its way
  note(ETH, USDC_ETH.address, "13000000", { status: "recovered" }), // spent
  note(BNB, USDT_BNB.address, "25000000000000000000"), // 25 USDT (18 decimals on BNB Chain)
  note(BNB, "0x9d10000000000000000000000000000000000c633", "100000000000"), // a token nothing prices here
]);
await vault.notesSettled();

await test("every network's private money, summed by the rules each network's own view uses", () => {
  const h = all.holdingsAcrossNetworks(ME, NETWORKS);
  const by = (net: GloamNetwork, symbol: string) => h.find((x) => x.networkKey === net.key && x.symbol === symbol);
  assert.equal(by(RH, "USDG")?.amount, 50_000_000n);
  assert.equal(by(RH, RH.primaryAsset.symbol)?.amount, 10n ** 18n);
  assert.equal(by(ETH, ETH.primaryAsset.symbol)?.amount, 7_000_000_000_000_000n);
  assert.equal(by(ETH, "USDC")?.amount, 5_000_000n, "the payment saved twice counts once; unfunded, on its way and spent never");
  assert.equal(by(BNB, "USDT")?.amount, 25n * 10n ** 18n);
  assert.equal(h.filter((x) => x.networkKey === BNB.key).length, 2, "and the token with no price");
  assert.equal(h[0]!.networkKey, RH.key, "networks in the app's order");
  assert.equal(h[0]!.network, "Robinhood Chain", "the network's name as the app shows it");
  const test = all.holdingsAcrossNetworks(ME, [{ ...nets.getNetwork("robinhood"), pool: RH.pool, chainId: RH.chainId, status: "live" }]);
  assert.ok(test.every((x) => x.network === "Robinhood Chain testnet"), "a testnet says so");
  assert.equal(h.filter((x) => x.networkKey === RH.key)[0]!.symbol, RH.primaryAsset.symbol, "the gas coin first in each network");
});

await test("one total in dollars; a token with no price is listed and left out", () => {
  const p = all.priceHoldings(all.holdingsAcrossNetworks(ME, NETWORKS), PRICES);
  // 50 + 3000 (1 ETH) + 21 (0.007 ETH) + 5 + 25 (USDT) = 3101
  assert.equal(Math.round(p.totalUsd * 100) / 100, 3101);
  assert.equal(p.unpriced.length, 1, "the token with no price");
  assert.equal(p.networks, 3);
  const bnbNative = all.unitUsdOf({ asset: NATIVE, family: "bnb", chainId: BNB.chainId }, PRICES);
  assert.equal(bnbNative, 600, "BNB Chain's gas coin is priced as BNB, never ETH");
  assert.equal(all.unitUsdOf({ asset: NATIVE, family: "ethereum", chainId: ETH.chainId }, { ...PRICES, ethUsd: null }), null, "no feed, no price");
  const marked = all.priceHoldings(all.holdingsAcrossNetworks(ME, NETWORKS), {
    ...PRICES,
    marks: new Map([["0x9d10000000000000000000000000000000000c633", 0.05]]),
  });
  assert.equal(marked.unpriced.length, 0, "a CoinGecko mark prices it");
});

await test("shown only when money sits on another network", () => {
  const h = all.holdingsAcrossNetworks(ME, NETWORKS);
  assert.equal(all.hasMoneyElsewhere(h, RH.key), true);
  const onlyRh = all.holdingsAcrossNetworks(ME, [RH]);
  assert.equal(all.hasMoneyElsewhere(onlyRh, RH.key), false, "all of it on the network shown: the hero already says it");
  assert.equal(all.hasMoneyElsewhere([], RH.key), false);
});

await test("a network that isn't live or has no vault is skipped", () => {
  const planned = { ...ETH, status: "planned" as const };
  const noPool = { ...BNB, pool: null };
  const h = all.holdingsAcrossNetworks(ME, [RH, planned, noPool]);
  assert.ok(h.every((x) => x.networkKey === RH.key));
});

await test("another account's notes are never counted, and signed out shows nothing", async () => {
  await vault.notesSettled();
  await slot.unbindSlot();
  await scope.signInAs(OTHER);
  await vault.unlockNoteVault();
  assert.deepEqual(all.holdingsAcrossNetworks(OTHER, NETWORKS), [], "a second wallet sees none of the first's");
  assert.deepEqual(all.holdingsAcrossNetworks(ME, NETWORKS), [], "nor does asking for the first wallet while the second is signed in");
  await vault.notesSettled();
  await slot.unbindSlot();
  await scope.signInAs(null);
  assert.deepEqual(all.holdingsAcrossNetworks(ME, NETWORKS), [], "signed out: nothing");
  assert.deepEqual(all.holdingsAcrossNetworks(null, NETWORKS), []);
});

console.log(`\n${passed} all-networks checks passed`);
