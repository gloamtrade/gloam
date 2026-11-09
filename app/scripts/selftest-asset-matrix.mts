/**
 * Self-test: what every listed asset on every mainnet can do. Add, private send,
 * claim links, cash out and Public send hold for all of them; a swap holds where
 * a router and its allowlisted pools do, and the gaps are written down here so a
 * new listing can't quietly leave one.
 *
 *  - Base and Ethereum have no swap router deployed.
 *  - ETH on Robinhood Chain can't swap: the deployed router refuses a native note
 *    (GloamVaultSwap: NativeNotSupported). WETH notes swap.
 *  - GRIFT has no pool on the router yet: a pool goes through the router's own
 *    3-day queue first. AI's and ORBIO's are queued (lib/vaultSwap
 *    RH_SWAP_ASSETS_V2_QUEUED); the picker offers them once those are live.
 *
 * Run from app/:  ../mcp/node_modules/.bin/tsx --tsconfig tsconfig.json scripts/selftest-asset-matrix.mts
 */
import assert from "node:assert/strict";
import { zeroAddress } from "viem";

const { claimNetworkProblem, requestAssetsFor } = await import("../src/lib/paymentRequest");
const { cashOutTargetProblem } = await import("../src/lib/cashOutTarget");
const { getNetwork } = await import("../src/lib/networks");
const { hasNativeCoin, publicSendTokens } = await import("../src/lib/publicSend");
const { RH_MAINNET_SWAP_TOKENS, addableTokensFor, isNativeAddable, limitGatedAssetsFor, shieldTokensFor, supportsNativeShield } = await import("../src/lib/tokens");
const { isSwapAsset, swapV3Live } = await import("../src/lib/vaultSwap");

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`ok  ${name}`);
}

const WALLET = "0x00000000000000000000000000000000000000b2";
/** What swaps on each mainnet, by symbol. Everything else listed there does not, yet. */
const SWAPS: Record<string, readonly string[]> = {
  "robinhood-mainnet": ["USDG", "GLOAM", "PONS", "CASHCAT", "AI", "ORBIO"],
  "tempo-mainnet": ["USDC.e", "pathUSD", "USDT0", "OUSD"],
  "base-mainnet": swapV3Live(8453) ? ["USDC", "USDT", "EURC"] : [],
  "ethereum-mainnet": swapV3Live(1) ? ["USDC", "USDT", "USDG", "EURC"] : [],
};
const KEYS = Object.keys(SWAPS) as (keyof typeof SWAPS & Parameters<typeof getNetwork>[0])[];
/** Every gated asset read open: the app once each limit has landed. */
const allOpen = (chainId: number) => new Set(limitGatedAssetsFor(chainId).map((a) => a.address.toLowerCase()));

for (const key of KEYS) {
  const net = getNetwork(key);
  const tokens = shieldTokensFor(net.chainId);

  test(`${key}: Add takes every listed token once its limit is open, and the native coin where there is one`, () => {
    assert.deepEqual(addableTokensFor(net.chainId, allOpen(net.chainId)).map((t) => t.id), tokens.map((t) => t.id));
    assert.equal(isNativeAddable(net.chainId, allOpen(net.chainId)), supportsNativeShield(net.chainId));
  });

  test(`${key}: every listed asset can be asked for, and its claim link is good here`, () => {
    const assets = requestAssetsFor(key);
    assert.equal(assets.length, tokens.length + (supportsNativeShield(net.chainId) ? 1 : 0));
    for (const a of assets) {
      assert.equal(claimNetworkProblem({ key, pool: net.pool }, { pool: net.pool!, asset: a.address, chainId: net.chainId }), null, a.symbol);
    }
  });

  test(`${key}: every listed token goes out by Public send, and a cash out has a wallet to go to`, () => {
    assert.deepEqual(publicSendTokens(net.chainId).map((t) => t.id), tokens.map((t) => t.id));
    assert.equal(hasNativeCoin(net), supportsNativeShield(net.chainId), "the native coin where the vault lists one");
    assert.equal(cashOutTargetProblem(WALLET, net), null);
  });

  test(`${key}: swaps are what this file says they are`, () => {
    const swaps = tokens.filter((t) => isSwapAsset(net.chainId, t.address)).map((t) => t.symbol);
    assert.deepEqual(swaps.sort(), [...SWAPS[key]!].sort());
    assert.equal(isSwapAsset(net.chainId, zeroAddress), swapV3Live(net.chainId) && supportsNativeShield(net.chainId), "a native note swaps only with v3");
  });
}

test("a claim link for a token a swap landed in works, and a stock's too", () => {
  const net = getNetwork("robinhood-mainnet");
  for (const t of RH_MAINNET_SWAP_TOKENS) {
    assert.equal(claimNetworkProblem({ key: "robinhood-mainnet", pool: net.pool }, { pool: net.pool!, asset: t.address, chainId: 4663 }), null, t.symbol);
  }
  const tsla = RH_MAINNET_SWAP_TOKENS.find((t) => t.id === "tsla")!;
  assert.match(claimNetworkProblem({ key: "base-mainnet", pool: net.pool }, { pool: net.pool!, asset: tsla.address }) ?? "", /different network/, "and it stays a Robinhood Chain asset");
});

test("an ETH code that names no chain was never made on Robinhood Chain: refused, not left unsettled", () => {
  const rh = getNetwork("robinhood-mainnet");
  const base = getNetwork("base-mainnet");
  assert.match(claimNetworkProblem({ key: "robinhood-mainnet", pool: rh.pool }, { pool: rh.pool!, asset: zeroAddress }) ?? "", /different network/);
  assert.equal(claimNetworkProblem({ key: "base-mainnet", pool: base.pool }, { pool: base.pool!, asset: zeroAddress }), null, "Base's older codes still claim");
});

console.log(`selftest-asset-matrix: ${passed} passed`);
