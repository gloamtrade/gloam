/**
 * Self-test: token prices from the server (lib/tokenMarksServer, /api/token-marks).
 * CoinGecko first, DEX Screener by address for what it doesn't answer, the last
 * good price when neither does, and a list that says nothing about a viewer.
 *
 * Run from app/:  ../mcp/node_modules/.bin/tsx scripts/selftest-token-marks.mts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.GLOAM_PARTNERS_STORE = "memory";
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;

const { COINGECKO_MARKED, MARKED_BY_CHAIN, STOCK_FALLBACK_MARKED, hasCoingeckoMarks } = await import("../src/lib/markedTokens");
const { dexPrices, loadTokenMarks } = await import("../src/lib/tokenMarksServer");
const { GET } = await import("../src/app/api/token-marks/route");

const addr = (symbol: string) => COINGECKO_MARKED.find((t) => t.symbol === symbol)!.address.toLowerCase();
const symbols = COINGECKO_MARKED.map((t) => t.symbol);

// ---- The fixed list.
for (const s of ["PONS", "CASHCAT", "GLOAM", "AI", "ORBIO"]) assert.ok(symbols.includes(s), `${s} is on the list`);
for (const s of ["EURC", "USDC", "USDG", "WETH", "NVDA"]) assert.ok(!symbols.includes(s), `${s} is not priced here`);
// Stocks are priced by the markets feed; the server's price is only the swap and transparency pages' fallback.
assert.ok(STOCK_FALLBACK_MARKED.some((t) => t.symbol === "NVDA"), "a stock has a fallback price");
assert.ok(STOCK_FALLBACK_MARKED.every((t) => t.kind === "stock"), "only stocks are on the fallback list");
// Base and Ethereum list no token priced here since the BDX OFT (not Beldex's) was closed on 20 Nov 2026.
assert.ok(hasCoingeckoMarks(4663) && !hasCoingeckoMarks(8453) && !hasCoingeckoMarks(1) && !hasCoingeckoMarks(4217));
assert.ok(
  !MARKED_BY_CHAIN.find((c) => c.chainId === 8453)!.tokens.some((t) => t.symbol === "BDX") &&
    !MARKED_BY_CHAIN.find((c) => c.chainId === 1)!.tokens.some((t) => t.symbol === "BDX"),
  "no BDX on Base or Ethereum"
);

// ---- DEX Screener: only a pool that has the token as its base prices it.
const PONS = addr("PONS");
const pair = (over: Record<string, unknown> = {}) => ({
  chainId: "robinhood",
  priceUsd: "0.24",
  baseToken: { address: PONS.toUpperCase().replace("0X", "0x") },
  liquidity: { usd: 2_000_000 },
  ...over,
});
assert.equal(dexPrices([pair()], "robinhood", [PONS]).get(PONS), 0.24, "address case doesn't matter");
assert.equal(dexPrices([pair({ baseToken: { address: "0xdead" } })], "robinhood", [PONS]).size, 0, "on the quote side, priceUsd is the other token's");
assert.equal(dexPrices([pair({ chainId: "ethereum" })], "robinhood", [PONS]).size, 0, "another chain's pool is another token");
assert.equal(dexPrices([pair({ liquidity: { usd: 100 } })], "robinhood", [PONS]).size, 0, "too thin to trust");
assert.equal(dexPrices([pair({ priceUsd: "0" }), pair({ priceUsd: "nope" })], "robinhood", [PONS]).size, 0, "no price, no mark");
assert.equal(
  dexPrices([pair({ priceUsd: "9", liquidity: { usd: 6_000 } }), pair({ priceUsd: "0.24" })], "robinhood", [PONS]).get(PONS),
  0.24,
  "the deepest pool wins"
);

// ---- The route's sources, with time under test control.
let now = Date.now();
const realNow = Date.now;
Date.now = () => now;
const tick = (ms: number) => (now += ms);

const gecko: Record<string, { usd: number }> = {};
for (const t of COINGECKO_MARKED) gecko[t.coingecko!] = { usd: 2 };
let geckoStatus = 200;
let geckoBody: Record<string, { usd?: unknown }> = gecko;
let dexUp = true;
let geckoCalls = 0;
let dexCalls: string[] = [];

globalThis.fetch = (async (input: string | URL) => {
  const url = new URL(String(input));
  if (url.hostname === "api.coingecko.com") {
    geckoCalls++;
    return new Response(JSON.stringify(geckoBody), { status: geckoStatus });
  }
  if (url.hostname === "api.dexscreener.com") {
    dexCalls.push(url.pathname);
    if (!dexUp) return new Response("no", { status: 503 });
    const [, , , chain, list] = url.pathname.split("/");
    return new Response(
      JSON.stringify(
        list!.split(",").map((a) => ({ chainId: chain, priceUsd: "3", baseToken: { address: a }, liquidity: { usd: 1_000_000 } }))
      )
    );
  }
  throw new Error(`unexpected fetch ${url}`);
}) as typeof fetch;

{
  const m = await loadTokenMarks();
  assert.equal(m[PONS], 2, "CoinGecko first");
  assert.equal(m[addr("GLOAM")], 2);
  assert.equal(dexCalls.length, 0, "DEX Screener isn't asked what CoinGecko answered");
  const calls = geckoCalls;
  await loadTokenMarks();
  assert.equal(geckoCalls, calls, "one read serves everyone for a minute");
}

// CoinGecko refuses, as it does the browser: every token still gets a price.
tick(61_000);
geckoStatus = 429;
geckoBody = {};
{
  const m = await loadTokenMarks();
  for (const s of ["PONS", "CASHCAT", "GLOAM", "AI", "ORBIO"]) assert.equal(m[addr(s)], 3, `${s} priced from DEX Screener by address`);
  assert.ok(dexCalls.some((p) => p.includes("/robinhood/")));
}

// One token missing from CoinGecko: DEX Screener is asked for that one alone.
tick(61_000);
dexCalls = [];
geckoStatus = 200;
geckoBody = { ...gecko };
delete geckoBody.gloam;
{
  const m = await loadTokenMarks();
  assert.equal(m[PONS], 2);
  assert.equal(m[addr("GLOAM")], 3);
  assert.deepEqual(dexCalls, [`/tokens/v1/robinhood/${addr("GLOAM")}`]);
}

// Neither answers: the last good price stands in, for a while, then the token goes unpriced.
tick(61_000);
geckoStatus = 503;
geckoBody = {};
dexUp = false;
{
  const m = await loadTokenMarks();
  assert.equal(m[PONS], 2, "the last good price, not a hole in the headline");
}
tick(7 * 3_600_000);
{
  const m = await loadTokenMarks();
  assert.equal(m[PONS], undefined, "never an old price forever");
  assert.deepEqual(m, {});
}

// ---- The route: no input, and an outage isn't cached.
{
  const res = await GET(new Request("https://gloam.trade/api/token-marks"));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store", "an empty answer stays off the CDN");
}
tick(61_000);
geckoStatus = 200;
geckoBody = gecko;
{
  const res = await GET(new Request("https://gloam.trade/api/token-marks?wallet=0xabc", { headers: { "x-forwarded-for": "1.2.3.4" } }));
  const body = (await res.json()) as { marks: Record<string, number> };
  assert.equal(body.marks[PONS], 2);
  assert.match(res.headers.get("cache-control") ?? "", /s-maxage=60/, "the CDN shares one answer between visitors");
  assert.ok(!JSON.stringify(body).includes("0xabc"));
}

// ---- The browser asks our server, for the whole list, and nobody else.
{
  const hook = readFileSync(new URL("../src/hooks/useCoingeckoMarks.ts", import.meta.url), "utf8");
  assert.ok(!/https?:\/\//.test(hook), "the hook calls no outside host");
  assert.ok(hook.includes('fetch("/api/token-marks"'), "and sends nothing about the viewer");
}

Date.now = realNow;
console.log("selftest-token-marks: all checks passed");
process.exit(0);
