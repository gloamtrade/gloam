/**
 * Self-test: ZEC on Gloam on Solana (Zcash bridged by NEAR's Omni Bridge).
 *
 *  - the listing: ZEC on mainnet only, the Omni Bridge mint, SPL Token, 8
 *    decimals, not a stablecoin, kept off screens until it is set up; the SDK
 *    lists the same mint and decimals;
 *  - the gate: shownAssets leaves ZEC out until client assetsReady reads its
 *    ring interface (the SPL asset registry account) on chain, with Solana
 *    faked: there, it shows; missing or unreadable, it doesn't; money already
 *    held in it always shows;
 *  - dollar values: stablecoins at a dollar, SOL and ZEC at their price, none
 *    when the price is unknown;
 *  - amounts: two places, cut down, dust as "<0.01", typed amounts up to 8 places;
 *  - balances and the relay's rules: a private ZEC balance reads back, and a
 *    relayed deposit of ZEC is allowed from 0.001 ZEC;
 *  - the Zcash mark ships, and the note says plainly what stays public.
 *
 * No network. Run from app/:  ../mcp/node_modules/.bin/tsx scripts/selftest-solana-zec.mts
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import Module from "node:module";
import { fileURLToPath } from "node:url";

const stub = fileURLToPath(new URL("./server-only-stub.cjs", import.meta.url));
const M = Module as unknown as { _resolveFilename: (req: string, ...rest: unknown[]) => string };
const resolve = M._resolveFilename;
M._resolveFilename = function (req: string, ...rest: unknown[]) {
  return req === "server-only" ? stub : resolve.call(this, req, ...rest);
};

const env = process.env as Record<string, string | undefined>;
env.NEXT_PUBLIC_SOLANA_RINGS_ENABLED = "1";
env.NEXT_PUBLIC_SOLANA_RINGS_NETWORK = "mainnet";

const config = await import("../src/lib/solanaRings/config");
const policy = await import("../src/lib/solanaRings/relayPolicy");
const payroll = await import("../src/lib/solanaRings/payroll");
const { displayAmount } = await import("../src/lib/amountShort");
const sdk = await import("../../packages/sdk/src/solanaInfo");
const { getSplAssetRegistryAddress } = await import("@heliuslabs/spr/addresses");

let n = 0;
const ok = (cond: unknown, msg: string) => {
  assert.ok(cond, msg);
  n++;
};

// The mint read on chain on 2026-11-23 (Jupiter verified, Kamino's ZEC market, omni.bridge.near).
const MINT = "A7bdiYdS5GjqGFtxf17ppRHtDKPkkRqbKtR27dxvQXaS";
// Its Privacy Rings SPL asset registry on mainnet, created 2026-11-10.
const REGISTRY = "4tB2qXKcRtDdkprU6NeovJCfLbTefeyEbnhfqh2HwpXr";

// ---------------------------------------------------------------- the listing

const ZEC = config.ringsAssets("mainnet").find((a) => a.id === "zec")!;
ok(ZEC && ZEC.symbol === "ZEC" && ZEC.mint === MINT && ZEC.mint === config.ZEC_SOLANA_MINT, "ZEC is listed on mainnet under the Omni Bridge mint");
ok(ZEC.decimals === 8 && (ZEC.tokenProgram ?? "token") === "token", "in 8 decimals, on the SPL Token program (no Token-2022)");
ok(!ZEC.stable && ZEC.hiddenUntilReady === true, "not a stablecoin, and kept off screens until it is set up");
ok(!config.ringsAssets("devnet").some((a) => a.id === "zec"), "not on devnet");
ok(config.ringsAssets("mainnet").filter((a) => a.stable).map((a) => a.id).join() === "usdc,usdt", "USDC and USDT are the stablecoins");
ok((await getSplAssetRegistryAddress(MINT as never)) === REGISTRY, "its ring registry is the account read on mainnet");
{
  const s = sdk.SOLANA_ASSETS.mainnet.find((a) => a.id === "zec");
  ok(s && s.mint === ZEC.mint && s.decimals === ZEC.decimals && s.symbol === "ZEC" && !s.stable && s.mint === sdk.SOLANA_ZEC_MINT, "the SDK lists the same mint and decimals");
  ok(
    sdk.SOLANA_ASSETS.mainnet.map((a) => `${a.id}:${a.mint}:${a.decimals}`).join() === config.ringsAssets("mainnet").map((a) => `${a.id}:${a.mint}:${a.decimals}`).join(),
    "the SDK's Solana list matches the app's"
  );
  ok(sdk.solanaAsset("zec")?.id === "zec" && sdk.solanaAsset(MINT)?.id === "zec" && sdk.solanaAsset("ZEC", "devnet") === null, "the SDK finds it by id, symbol and mint, on mainnet only");
}

// ---------------------------------------------------------------- the gate

const ids = (list: readonly { id: string }[]) => list.map((a) => a.id).join();
ok(ids(config.shownAssets({}, "mainnet")) === "sol,usdc,usdt", "before the setup read comes back, ZEC is not shown");
ok(ids(config.shownAssets({ sol: true, usdc: true, usdt: true, zec: false }, "mainnet")) === "sol,usdc,usdt", "read as not set up, it is not shown");
ok(ids(config.shownAssets({ sol: true, usdc: false, usdt: false, zec: false }, "mainnet")) === "sol,usdc,usdt", "USDC and USDT still show (as not set up yet), as before");
ok(ids(config.shownAssets({ sol: true, usdc: true, usdt: true, zec: true }, "mainnet")) === "sol,usdc,usdt,zec", "read as set up, it shows");
ok(ids(config.shownAssets({}, "mainnet", { zec: 1n })) === "sol,usdc,usdt,zec", "money already held in it always shows");
ok(ids(config.shownAssets({}, "mainnet", { zec: 0n })) === "sol,usdc,usdt", "a zero balance does not");
ok(ids(config.shownAssets({ zec: true }, "devnet")) === "sol,usdc", "devnet has no ZEC to show");

// client assetsReady against a faked Solana (through Gloam's proxy): ZEC is ready only when its registry exists
{
  const store = new Map<string, string>();
  Object.assign(globalThis, {
    location: { origin: "http://localhost:3999" },
    localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) },
  });
  const client = await import("../src/lib/solanaRings/client");
  const realFetch = globalThis.fetch;
  let present = new Set<string>();
  let asked: string[] = [];
  let down = false;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    if (down) throw new TypeError("fetch failed");
    assert.equal(String(url), "http://localhost:3999/api/solana/rpc", "it asks through Gloam's proxy");
    const body = JSON.parse(String(init?.body)) as { method: string; params: [string[], unknown] };
    assert.equal(body.method, "getMultipleAccounts");
    asked = body.params[0];
    const value = asked.map((a) => (present.has(a) ? { data: ["AQID", "base64"], owner: "ring1GaLCuJnkUMVkX2JeZLTTX17wKsV4fZmPVzXANW" } : null));
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { value } }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const usdc = await getSplAssetRegistryAddress(config.ringsAssets("mainnet").find((a) => a.id === "usdc")!.mint as never);
    const usdt = await getSplAssetRegistryAddress(config.ringsAssets("mainnet").find((a) => a.id === "usdt")!.mint as never);
    present = new Set([usdc, usdt]);
    let ready = await client.assetsReady("mainnet");
    ok(asked.includes(REGISTRY), "assetsReady reads ZEC's registry account");
    ok(ready.zec === false && ready.usdc === true && ids(config.shownAssets(ready, "mainnet")) === "sol,usdc,usdt", "no registry on chain: ZEC stays off the screen");
    present = new Set([usdc, usdt, REGISTRY]);
    ready = await client.assetsReady("mainnet");
    ok(ready.zec === true && ids(config.shownAssets(ready, "mainnet")) === "sol,usdc,usdt,zec", "its registry on chain: ZEC shows");
    down = true;
    ready = await client.assetsReady("mainnet");
    ok(ready.zec === false && ready.sol === true && ids(config.shownAssets(ready, "mainnet")) === "sol,usdc,usdt", "Solana not answering: ZEC stays off, never shown on a guess");
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ---------------------------------------------------------------- dollar values

{
  const USDC = config.ringsAssets("mainnet").find((a) => a.id === "usdc")!;
  const SOL = config.ringsAssets("mainnet").find((a) => a.id === "sol")!;
  const prices = { solUsd: 140, zecUsd: 876.3 };
  ok(config.ringsUsd(USDC, 1_250_000_000n, prices) === 1250, "USDC at a dollar");
  ok(Math.abs(config.ringsUsd(SOL, 2_000_000_000n, prices)! - 280) < 1e-9, "SOL at its price");
  ok(Math.abs(config.ringsUsd(ZEC, 50_000_000n, prices)! - 438.15) < 1e-9, "0.5 ZEC at Zcash's price");
  ok(config.ringsUsd(ZEC, 50_000_000n, { solUsd: 140, zecUsd: null }) === null, "ZEC with no price has no dollar value, never a guess");
  ok(config.ringsUsd(ZEC, 50_000_000n, { solUsd: 140, zecUsd: Number.NaN }) === null && config.ringsUsd(ZEC, 1n, { solUsd: 1, zecUsd: 0 }) === null, "nor with a broken price");
  ok(config.ringsUsd({ id: "bonk", decimals: 5 }, 1n, prices) === null, "an asset with no price source has none");
}
{
  const src = readFileSync(new URL("../src/lib/live-quotes.ts", import.meta.url), "utf8");
  ok(/zcash: "ZECUSDT"/.test(src) && /export async function loadZecUsd\(\)[\s\S]{0,80}coinUsd\("zcash"\)/.test(src), "ZEC's price comes from CoinGecko's zcash, then Binance's ZECUSDT, like SOL's");
  const route = readFileSync(new URL("../src/app/api/markets/route.ts", import.meta.url), "utf8");
  ok(/SOLANA_RINGS_ENABLED \? loadZecUsd\(\)/.test(route) && /\{ solUsd, zecUsd \}/.test(route), "the markets feed carries it while Solana is on");
}

// ---------------------------------------------------------------- amounts

ok(displayAmount(2_271_865n, 8) === "0.02", "0.02271865 ZEC shows as 0.02 (two places, cut down)");
ok(displayAmount(199_999_999n, 8) === "1.99", "1.99999999 ZEC shows as 1.99, never rounded up");
ok(displayAmount(999_999n, 8) === "<0.01" && displayAmount(0n, 8) === "0.00", "dust shows as <0.01, nothing as 0.00");
ok(displayAmount(10_987_460_374_094n, 8) === "109,874.60", "the whole bridged supply reads grouped");
{
  const r = payroll.readPayrollAmount("0.12345678", 8);
  ok("amount" in r && r.amount === 12_345_678n, "a typed amount reads to 8 places");
  ok("error" in payroll.readPayrollAmount("0.123456789", 8), "a ninth place is refused");
  const csv = payroll.parseSolanaPayrollCsv("name,address,zec\nAda,9wPkC6bZ3mWtq8FxVhN2sRj4LdYa7GuE5oTcKpB1iHzX,0.5\n", ZEC);
  ok(!csv.error && csv.rows.length === 1 && csv.rows[0]!.amount === 50_000_000n, "a payroll list with a zec column reads in ZEC's decimals");
}

// ---------------------------------------------------------------- balances and the relay's rules

{
  const got = config.ringsBalancesFrom([{ mint: MINT, amount: 50_000_000n }], "mainnet");
  ok(got.zec === 50_000_000n && got.usdc === 0n && got.sol === 0n, "a private ZEC balance reads back under zec");
  ok(policy.RELAYED_DEPOSIT_MIN.zec === 100_000n, "the relay deposits ZEC from 0.001 ZEC");
  ok(policy.relayedDepositMins("mainnet").get(MINT) === 100_000n && !policy.relayedDepositMins("devnet").has(MINT), "on mainnet, by its mint");
}

// ---------------------------------------------------------------- the mark and the words

{
  const svg = readFileSync(new URL("../public/brand/tokens/zec.svg", import.meta.url), "utf8");
  ok(/viewBox="20 20 450.8 450.8"/.test(svg) && /#f4b728/i.test(svg) && !/<script|href=/i.test(svg), "the official Zcash icon ships, cropped to its disc, with nothing but paths");
  ok(existsSync(fileURLToPath(new URL("../public/brand/tokens/zec.png", import.meta.url))), "and a PNG of it for the bridge's token marks");
  const logo = readFileSync(new URL("../src/components/app/TokenLogo.tsx", import.meta.url), "utf8");
  ok(/zec: "\/brand\/tokens\/zec\.svg"/.test(logo) && /DISC_LOGO_IDS = new Set\(\[[^\]]*"zec"/.test(logo), "TokenLogo draws ZEC as its round mark");
}
for (const note of [config.RINGS_ZEC_NOTE, sdk.SOLANA_ZEC_NOTE]) {
  ok(!/—|–/.test(note) && !/anonymous|untraceable|happy to/i.test(note), "the ZEC note has no dashes and no overclaims");
  ok(/Omni Bridge/.test(note) && /token and the amount stay hidden/.test(note) && /bridge itself and adding from (your|a) wallet are public/.test(note), "it says what stays hidden and what is public");
}
ok(ZEC.note === config.RINGS_ZEC_NOTE, "the app shows that note with ZEC");

console.log(`selftest-solana-zec: ${n} checks passed`);
