/**
 * Self-test: which tokens the Portfolio's "In your wallet" card reads and how
 * each row's action is chosen (lib/tokens).
 *
 * A stock cashed out of the vault to the wallet (TSLA on Robinhood Chain
 * mainnet) did not show in "In your wallet": the card read only the tokens Add
 * takes (USDG, GLOAM). It now reads those plus the chain's swap tokens, deduped
 * by address with the addable ones first, but only the addable ones offer
 * "Add privately", so what Add lists is unchanged.
 *
 * Run from app/:  ../mcp/node_modules/.bin/tsx scripts/selftest-wallet-tokens.mts
 */
import assert from "node:assert/strict";
import {
  RH_MAINNET_SWAP_TOKENS,
  RH_MAINNET_TOKENS,
  TESTNET_STOCK_TOKENS,
  addableTokensFor,
  hasUiMultiplier,
  isAddableToken,
  isNativeAddable,
  limitGatedAssetsFor,
  limitGatedTokensFor,
  openGatedFromReads,
  shieldTokensFor,
  supportsNativeShield,
  swapDisplayTokensFor,
  walletDisplayTokensFor,
} from "../src/lib/tokens";

const ZERO = "0x0000000000000000000000000000000000000000";

let n = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    n++;
  } catch (e) {
    console.error(`FAIL ${name}`);
    throw e;
  }
}

const RH = 4663;
const tsla = RH_MAINNET_SWAP_TOKENS.find((t) => t.id === "tsla")!;
const usdg = RH_MAINNET_TOKENS.find((t) => t.id === "usdg")!;

check("Robinhood mainnet wallet card reads the addable tokens first, then the swap tokens", () => {
  const list = walletDisplayTokensFor(RH);
  assert.deepEqual(list.slice(0, RH_MAINNET_TOKENS.length), RH_MAINNET_TOKENS);
  // PONS and CASHCAT are on both lists, and read once
  const both = RH_MAINNET_TOKENS.filter((t) => RH_MAINNET_SWAP_TOKENS.includes(t)).map((t) => t.id);
  assert.deepEqual(both, ["pons", "cashcat"]);
  assert.equal(list.length, RH_MAINNET_TOKENS.length + RH_MAINNET_SWAP_TOKENS.length - both.length);
  assert.ok(list.some((t) => t.id === "tsla"));
  assert.ok(list.some((t) => t.id === "weth"));
});

check("no address twice, compared without case", () => {
  const list = walletDisplayTokensFor(RH);
  assert.equal(new Set(list.map((t) => t.address.toLowerCase())).size, list.length);
});

check("what Add offers does not change", () => {
  assert.deepEqual(shieldTokensFor(RH), RH_MAINNET_TOKENS);
  assert.equal(isAddableToken(RH, usdg), true);
  assert.equal(isAddableToken(RH, tsla), false);
  assert.equal(isAddableToken(RH, { address: tsla.address.toLowerCase() as `0x${string}` }), false);
  assert.equal(isAddableToken(RH, { address: usdg.address.toLowerCase() as `0x${string}` }), true);
});

check("a chain with no swap tokens reads exactly what Add lists", () => {
  for (const id of [1, 8453, 84532, 4217, 42431, 11155111, 46630]) {
    assert.deepEqual(swapDisplayTokensFor(id), []);
    assert.deepEqual(walletDisplayTokensFor(id), shieldTokensFor(id));
  }
});

check("the mainnet stocks carry a uiMultiplier; the testnet stocks, WETH and stablecoins do not", () => {
  assert.equal(hasUiMultiplier(RH, tsla), true);
  assert.equal(hasUiMultiplier(RH, RH_MAINNET_SWAP_TOKENS.find((t) => t.id === "weth")!), false);
  assert.equal(hasUiMultiplier(RH, usdg), false);
  const testnetStock = TESTNET_STOCK_TOKENS[0]!;
  assert.equal(hasUiMultiplier(46630, testnetStock), false);
  assert.equal(hasUiMultiplier(RH, testnetStock), false);
});

// The LayerZero OFT named BDX is not Beldex's (Beldex's BDX is only on BNB Chain):
// closed in the Base and Ethereum vaults on 20 Nov 2026 and no longer listed there.
// The gating below is checked with a stand-in token that opens with its limit.
const BDX = "0x6ad12E761b438beA3EA09F6C6266556Bb24C2181";
const bdxLower = BDX.toLowerCase();
const GATED_STANDIN = { id: "bdx", symbol: "BDX", name: "Beldex", address: BDX, decimals: 9, yahoo: "", kind: "token", coingecko: "beldex", opensWithLimit: true } as const;

check("no BDX on Base or Ethereum, and no limit-gated token there", () => {
  for (const id of [8453, 1]) {
    assert.deepEqual(limitGatedTokensFor(id), []);
    assert.ok(!shieldTokensFor(id).some((t) => t.id === "bdx"), "not in the chain's list");
    assert.ok(!walletDisplayTokensFor(id).some((t) => t.id === "bdx"), "not on the wallet card");
  }
  for (const id of [4217, 84532, 11155111, 46630, 42431]) assert.deepEqual(limitGatedTokensFor(id), []);
});

check("GRIFT, AI and ORBIO are listed on Robinhood Chain mainnet only, gated by their live limits", () => {
  const gated = limitGatedTokensFor(4663);
  assert.deepEqual(
    gated.map((t) => [t.symbol, t.address, t.decimals, t.kind, t.coingecko]),
    [
      ["GRIFT", "0x9f4BA41F91a59A34e17eE8C9EB3A51363B11aBD5", 18, "token", "grift-world"],
      ["AI", "0x2E8c31162b855A2ffa90F6F8634643Ad6F111e18", 18, "token", "artificial-inu-3"],
      ["ORBIO", "0xAa07A0e9209e16aC99708C3EC70159c6eF3128A3", 18, "token", "orbio-so"],
    ]
  );
  for (const t of gated) assert.ok(walletDisplayTokensFor(4663).some((x) => x.id === t.id), `the wallet card reads ${t.symbol}`);
  assert.equal(openGatedFromReads(gated, true, gated.map(() => [0n, 0n])).size, 0, "closed while a limit is 0");
  const max = (1n << 128n) - 1n;
  const grift = gated[0]!.address.toLowerCase();
  const justGrift = openGatedFromReads(gated, true, [[max, max], [0n, 0n], undefined]);
  assert.deepEqual([...justGrift], [grift], "each opens on its own, at no limit too, and a failed read stays closed");
});

check("PONS and CASHCAT are open on Robinhood Chain mainnet now: Add takes them with no live read", () => {
  const ids = addableTokensFor(4663).map((t) => t.id);
  assert.deepEqual(ids, ["usdg", "gloam", "pons", "cashcat"]);
});

check("ETH on Robinhood Chain mainnet: listed, but Add offers it only once its live limit is open", () => {
  const assets = limitGatedAssetsFor(4663);
  assert.equal(assets[0]!.address, ZERO, "the native coin is read with the gated tokens");
  assert.equal(assets.length, limitGatedTokensFor(4663).length + 1);
  assert.equal(supportsNativeShield(4663), true, "the vault lists it, so its balance and fees are read");
  assert.equal(isNativeAddable(4663), false, "nothing read: not offered");
  assert.equal(isNativeAddable(4663, new Set()), false, "read closed: not offered");
  assert.equal(isNativeAddable(4663, openGatedFromReads(assets, true, assets.map(() => [0n, 0n]))), false, "a limit of 0: not offered");
  const open = openGatedFromReads(assets, true, assets.map((_, i) => (i === 0 ? [11n, 110n] : [0n, 0n])));
  assert.equal(isNativeAddable(4663, open), true, "open once the limit lands");
  assert.equal(open.size, 1, "and no token opened with it");
});

check("ETH needs no live read where it was listed from the start, and Tempo never has it", () => {
  for (const id of [8453, 1, 84532, 11155111, 46630]) {
    assert.equal(isNativeAddable(id), true, `${id}`);
    assert.ok(!limitGatedAssetsFor(id).some((a) => a.address === ZERO), `${id} reads no native limit`);
  }
  for (const id of [4217, 42431]) assert.equal(isNativeAddable(id, new Set([ZERO])), false, `${id}`);
});

check("Add never offers BDX on Base or Ethereum, even if a read came back open", () => {
  for (const id of [8453, 1]) {
    assert.ok(!addableTokensFor(id).some((t) => t.id === "bdx"), "no reads: not offered");
    assert.ok(!addableTokensFor(id, new Set([bdxLower])).some((t) => t.id === "bdx"), "not listed: never offered");
    assert.deepEqual(addableTokensFor(id).map((t) => t.id), shieldTokensFor(id).map((t) => t.id));
  }
});

check("the live reads open BDX only with a limit above 0, and never while unread", () => {
  const gated = [GATED_STANDIN] as unknown as ReturnType<typeof limitGatedTokensFor>;
  const per = 100_000n * 10n ** 9n;
  const total = 2_000_000n * 10n ** 9n;
  assert.equal(openGatedFromReads(gated, undefined, [[per, total]]).size, 0, "depositLimitsOn unread");
  assert.equal(openGatedFromReads(gated, true, [undefined]).size, 0, "the limit unread");
  assert.equal(openGatedFromReads(gated, true, [[0n, 0n]]).size, 0, "queued, not landed: 0 / 0");
  assert.equal(openGatedFromReads(gated, true, [[0n, total]]).size, 0, "a zero per-deposit limit takes nothing");
  assert.deepEqual([...openGatedFromReads(gated, true, [[per, total]])], [bdxLower], "landed");
  const MAX = (1n << 128n) - 1n;
  assert.deepEqual([...openGatedFromReads(gated, true, [[MAX, MAX]])], [bdxLower], "no limit (uint128 max) is open");
  assert.deepEqual([...openGatedFromReads(gated, false, [undefined])], [bdxLower], "a pool with no limits takes it");
});

console.log(`selftest-wallet-tokens: ${n} checks passed`);
