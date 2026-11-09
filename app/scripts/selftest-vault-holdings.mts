/**
 * Self-test: what the admin, stats API and MCP count as "held in the vault".
 *
 * The vault holds more than the tokens Add lists: a private swap lands in
 * WETH, stock tokens, cbBTC and the rest (lib/vaultSwap RH_SWAP_ASSETS_V2).
 * Reading only the listed tokens left those out of heldUsd. Checks:
 *  - holdableTokens(chain) = listed + swap-landable, each address once, and it
 *    covers every address a swap can land in on every chain
 *  - assetInfo knows their decimals (cbBTC is 8) and which are dollar stablecoins
 *  - usdOf: stablecoins $1, WETH at ETH's price, a token at its mark, none
 *    without a mark (never $0)
 *  - a stock is the live market mark times uiMultiplier / 1e18 (as VaultSwapView)
 *  - figures() sums the priced holdings and lists the unpriced ones
 *
 * Run from app/:  pnpm dlx tsx scripts/selftest-vault-holdings.mts
 */
import assert from "node:assert/strict";
import { getNetwork } from "../src/lib/networks";
import { RH_MAINNET_SWAP_TOKENS, shieldTokensFor } from "../src/lib/tokens";
import { RH_SWAP_ASSETS_V2, VAULT_SWAP_ASSETS } from "../src/lib/vaultSwap";
import { assetInfo, figures, holdableTokens, swapTokenPrice, usdOf, type Prices } from "../src/lib/onchainMetrics";

let checks = 0;
const check = (name: string, fn: () => void) => {
  fn();
  checks++;
  console.log("ok  ", name);
};
const lc = (a: string) => a.toLowerCase();
const rh = getNetwork("robinhood-mainnet");
const bySymbol = (s: string) => RH_MAINNET_SWAP_TOKENS.find((t) => t.symbol === s)!;
const addr = (s: string) => lc(bySymbol(s).address);

check("Robinhood mainnet: the listed tokens first, then every swap-landable one, each once", () => {
  const h = holdableTokens(4663).map((t) => lc(t.address));
  const listed = shieldTokensFor(4663).map((t) => lc(t.address));
  assert.deepEqual(h.slice(0, listed.length), listed);
  assert.equal(new Set(h).size, h.length, "no address twice");
  // PONS and CASHCAT are on both lists
  assert.equal(h.length, new Set([...listed, ...RH_MAINNET_SWAP_TOKENS.map((t) => lc(t.address))]).size);
  for (const t of RH_MAINNET_SWAP_TOKENS) assert.ok(h.includes(lc(t.address)), t.symbol);
});

check("every address a swap can land in is read, on every chain", () => {
  for (const [chain, assets] of Object.entries(VAULT_SWAP_ASSETS)) {
    const h = new Set(holdableTokens(Number(chain)).map((t) => lc(t.address)));
    // a native ETH note is read as the chain's own coin (onchainMetrics), never as a token
    for (const a of assets) assert.ok(BigInt(a) === 0n || h.has(lc(a)), `${chain} ${a}`);
  }
  const h = new Set(holdableTokens(4663).map((t) => lc(t.address)));
  for (const a of RH_SWAP_ASSETS_V2) assert.ok(h.has(lc(a)), `v2 ${a}`);
});

check("a chain with no swap-only tokens reads exactly its listed ones", () => {
  for (const chain of [4217, 8453, 1, 84532, 11155111, 42431, 46630]) {
    assert.deepEqual(
      holdableTokens(chain).map((t) => lc(t.address)),
      shieldTokensFor(chain).map((t) => lc(t.address)),
      String(chain)
    );
  }
});

check("assetInfo: real decimals and symbols for swap tokens, the safe fallback for strangers", () => {
  assert.deepEqual(assetInfo(rh, addr("cbBTC")), { symbol: "cbBTC", decimals: 8, stable: false });
  assert.deepEqual(assetInfo(rh, addr("USDe")), { symbol: "USDe", decimals: 18, stable: true });
  assert.deepEqual(assetInfo(rh, addr("U")), { symbol: "U", decimals: 18, stable: true });
  assert.deepEqual(assetInfo(rh, addr("TSLA")), { symbol: "TSLA", decimals: 18, stable: false });
  assert.equal(assetInfo(rh, addr("WETH")).weth, true);
  assert.equal(assetInfo(rh, "0x1111111111111111111111111111111111111111").decimals, 18);
  assert.equal(assetInfo(rh, "0x1111111111111111111111111111111111111111").stable, false);
});

check("every stablecoin in the swap list is a dollar stablecoin", () => {
  for (const t of RH_MAINNET_SWAP_TOKENS.filter((x) => x.kind === "stablecoin")) {
    assert.equal(assetInfo(rh, lc(t.address)).stable, true, t.symbol);
  }
});

const prices = (marks: [string, number][] = [], ethUsd: number | null = 2000): Prices => ({
  at: Date.now(),
  ethUsd,
  marks: new Map(marks),
  stocks: "live",
});
const usd = (sym: string, units: number, p: Prices) => usdOf(rh, addr(sym), units, assetInfo(rh, addr(sym)), p);

check("usdOf: dollars, WETH at ETH, a token at its mark, never $0 without one", () => {
  const p = prices([[addr("TSLA"), 400]]);
  assert.equal(usd("USDe", 5, p), 5);
  assert.equal(usd("WETH", 0.5, p), 1000);
  assert.equal(usd("WETH", 0.5, prices([], null)), null, "ETH price down: unpriced");
  assert.equal(usd("TSLA", 2, p), 800);
  assert.equal(usd("cbBTC", 1, p), null);
  assert.equal(usd("PONS", 1, p), null);
});

check("a stock is the live mark times uiMultiplier / 1e18; share price alone is never used", () => {
  const live = [{ id: "tsla", source: "live", mark: 400 }, { id: "aapl", source: "static", mark: 200 }];
  const tsla = bySymbol("TSLA");
  const aapl = bySymbol("AAPL");
  const one = 10n ** 18n;
  assert.equal(swapTokenPrice(4663, tsla, live, one, undefined), 400);
  assert.equal(swapTokenPrice(4663, tsla, live, 1_000_566_080_061_092_436n, undefined), (400 * 1_000_566_080_061_092_436) / 1e18);
  assert.equal(swapTokenPrice(4663, tsla, live, null, undefined), null, "multiplier unread, no CoinGecko: unpriced");
  assert.equal(swapTokenPrice(4663, tsla, live, null, 399), 399, "multiplier unread: CoinGecko's price for the token");
  assert.equal(swapTokenPrice(4663, aapl, live, one, undefined), null, "a static fallback mark is not a price");
  assert.equal(swapTokenPrice(4663, aapl, live, one, 210), 210);
  assert.equal(swapTokenPrice(4663, bySymbol("cbBTC"), live, null, 100_000), 100_000);
  assert.equal(swapTokenPrice(4663, bySymbol("cbBTC"), live, null, undefined), null);
  // a testnet stock has no multiplier: its mark is the price (handled by the markets feed, not here)
  assert.equal(swapTokenPrice(46630, tsla, live, one, undefined), null);
});

check("figures(): swap tokens held are counted in heldUsd, the unpriced ones are named", () => {
  const raw = (sym: string, whole: string) => {
    const [i, f = ""] = whole.split(".");
    const d = bySymbol(sym).decimals;
    return BigInt(i + f.padEnd(d, "0").slice(0, d));
  };
  const holdings = [
    { asset: lc(shieldTokensFor(4663)[0]!.address), raw: 500_000_000n }, // 500 USDG
    { asset: addr("TSLA"), raw: raw("TSLA", "2") },
    { asset: addr("WETH"), raw: raw("WETH", "0.5") },
    { asset: addr("USDe"), raw: raw("USDe", "10") },
    { asset: addr("cbBTC"), raw: raw("cbBTC", "0.01") }, // no price
    { asset: addr("PONS"), raw: 0n }, // none held: not listed, not unpriced
    { asset: addr("NVDA"), raw: null }, // read failed: not unpriced either
  ];
  const state = { v: 1 as const, pool: "0x", scannedTo: 0, memoScannedTo: 0, memos: 0, startTs: 0, events: [] };
  const m = figures(rh, state, holdings, prices([[addr("TSLA"), 400]]), [], { blocksRead: 0n, latest: null, readMs: 0, error: null }, { settings: null, days: [] });
  assert.equal(m.heldUsd, 500 + 800 + 1000 + 10);
  assert.deepEqual(m.unpriced, ["cbBTC"]);
  const row = (s: string) => m.assets.find((a) => a.symbol === s);
  assert.equal(row("TSLA")?.heldUsd, 800);
  assert.equal(row("cbBTC")?.held, "0.01", "cbBTC shown with its own 8 decimals");
  assert.equal(row("cbBTC")?.heldUsd, null);
  assert.equal(row("PONS"), undefined);
  assert.equal(m.deposits + m.transfers + m.cashouts + m.trades, 0, "counts come from events, not holdings");
});

console.log(`selftest-vault-holdings: ${checks} checks passed`);
