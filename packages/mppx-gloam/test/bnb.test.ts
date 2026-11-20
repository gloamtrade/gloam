/**
 * BNB Chain (56): its USDT and USDC have 18 decimals, not 6, so a charge
 * there is priced, read and labelled in 18. Refused by name while the SDK has
 * no pool for it; with a placeholder pool put in before the SDK builds its
 * networks (a child process), it is an official pool, USDT is its default
 * currency with 18 decimals, a "0.25" price is 0.25 * 10^18 base units, and
 * the gas coin reads as BNB. On every network a decimals value that disagrees
 * with a listed asset's own is refused, and a chain the SDK does not know has
 * no default asset (it used to fall back to Tempo's PathUSD with 6 decimals).
 */
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseUnits, type Address } from "viem";
// The config module alone, before the SDK builds its networks from it.
import { BNB_MAINNET, bnbMainnetConfig } from "../../sdk/src/bnb.ts";

const FILLED = process.env.GLOAM_TEST_BNB === "filled";
const POOL: Address = "0x89d3042390204f57b8b4F8949D3c2203E4002164";
const USDT: Address = "0x55d398326f99059fF775485246999027B3197955";
const USDC: Address = "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d";
const BDX: Address = "0x9d10a1ec41Fe7878429BB457e31F9b050D38c633";
const BASE_BDX: Address = "0x6ad12E761b438beA3EA09F6C6266556Bb24C2181";
const NATIVE: Address = "0x0000000000000000000000000000000000000000";
const LIVE = bnbMainnetConfig();
if (FILLED && !LIVE) Object.assign(BNB_MAINNET, { pool: POOL, deployBlock: 134_300_000n });

const sdk = await import("@gloamtrade/sdk");
const {
  OFFICIAL_POOLS,
  assetDecimals,
  assetSymbol,
  buildGloamChargeRequest,
  chargeDecimals,
  createGloamPaywall,
  memoryReplayStore,
  parsePaymentChallenges,
  resolveNetwork,
} = await import("../src/core.js");
const { mockPool, stubProve } = await import("./helpers.js");

const payee = await sdk.generateReceiveKey();

test("BNB Chain's assets carry their own decimals and labels, pool or not", () => {
  assert.equal(assetDecimals(USDT), 18);
  assert.equal(assetDecimals(USDC), 18);
  assert.equal(assetDecimals(USDT, 56), 18);
  assert.equal(assetDecimals(BDX), 9);
  assert.equal(assetDecimals(BDX, 56), 9);
  assert.equal(assetDecimals(NATIVE, 56), 18);
  assert.equal(assetSymbol(56, NATIVE), "BNB", "gas in BNB, never ETH");
  assert.equal(assetSymbol(56, USDT), "USDT");
  assert.equal(assetSymbol(56, USDC), "USDC");
  assert.equal(assetSymbol(56, BDX), "BDX");
  assert.equal(assetSymbol(8453, NATIVE), "ETH");
});

test("a decimals value that disagrees with a listed asset is refused", () => {
  assert.throws(() => chargeDecimals(USDT, 56, 6), /USDT on BNB Chain has 18 decimals, not 6/);
  assert.equal(chargeDecimals(USDT, 56, 18), 18);
  assert.equal(chargeDecimals(USDT, 56), 18);
  // a token Gloam does not list takes what it is given
  assert.equal(chargeDecimals("0x0000000000000000000000000000000000001234", 56, 8), 8);
  assert.equal(chargeDecimals("0x0000000000000000000000000000000000001234", 56), undefined);
  const base = sdk.mainnetNetwork("base");
  if (base) {
    const usdc = base.assets.find((a) => a.symbol === "USDC")!;
    assert.throws(() => chargeDecimals(usdc.address, 8453, 18), /USDC on Base has 6 decimals, not 18/);
    assert.equal(assetSymbol(8453, BASE_BDX), "BDX", "BDX on Base reads as BDX, by the network's own list");
  }
});

test("a chain the SDK does not know has no default asset", () => {
  const r = resolveNetwork(999_999);
  assert.equal(r.chainId, 999_999);
  assert.equal(r.currency, undefined, "no silent PathUSD");
  assert.equal(r.decimals, undefined, "no silent 6");
  assert.throws(() => buildGloamChargeRequest({ amountWei: 1n, recipient: payee.tag, network: 999_999 }), /There is no Gloam pool on chain 999999/);
  const pools = { 999_999: POOL };
  assert.throws(() => buildGloamChargeRequest({ amountWei: 1n, recipient: payee.tag, network: 999_999, pools }), /Pass currency/);
  const own = buildGloamChargeRequest({ amountWei: 1n, recipient: payee.tag, network: 999_999, pools, currency: "0x0000000000000000000000000000000000001234", decimals: 8 });
  assert.equal(own.methodDetails.decimals, 8);
});

if (!FILLED && !LIVE) {
  test("BNB Chain is refused by name while the SDK has no pool for it", () => {
    assert.equal(OFFICIAL_POOLS[56], undefined);
    assert.throws(() => resolveNetwork("bnb-mainnet"), /BNB Chain mainnet is not live in this version/);
    assert.throws(() => buildGloamChargeRequest({ amountWei: 1n, recipient: payee.tag, network: 56 }), /no BNB Chain mainnet pool yet/);
  });

  test("with its pool in, BNB Chain is an official pool priced in 18 decimals (child process)", () => {
    const child = spawnSync(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url)], {
      env: { ...process.env, GLOAM_TEST_BNB: "filled" },
      encoding: "utf8",
    });
    assert.equal(child.status, 0, child.stdout + child.stderr);
  });
} else {
  const pool = LIVE?.pool ?? POOL;
  test("BNB Chain: official pool, USDT by default with 18 decimals", () => {
    const r = resolveNetwork("bnb-mainnet");
    assert.equal(r.chainId, 56);
    assert.equal(r.currency, USDT);
    assert.equal(r.decimals, 18);
    assert.equal(OFFICIAL_POOLS[56]?.toLowerCase(), pool.toLowerCase());
    assert.deepEqual(resolveNetwork(56), r, "by chain id too");
  });

  test("a charge on BNB Chain is written in 18 decimals", () => {
    const req = buildGloamChargeRequest({ amountWei: parseUnits("0.25", 18), recipient: payee.tag, network: "bnb-mainnet" });
    assert.equal(req.amount, "250000000000000000");
    assert.equal(req.currency, USDT);
    assert.deepEqual(req.methodDetails, { chainId: 56, pool, decimals: 18 });
    const usdc = buildGloamChargeRequest({ amountWei: 1n, recipient: payee.tag, network: 56, currency: USDC });
    assert.equal(usdc.methodDetails.decimals, 18);
    assert.throws(() => buildGloamChargeRequest({ amountWei: 1n, recipient: payee.tag, network: 56, currency: USDC, decimals: 6 }), /18 decimals, not 6/);
  });

  test("a payer's cap on BNB Chain pinned to USDT on 56 refuses 0.05 BNB and 50,000,000 BDX", async () => {
    const { assertPayable } = await import("../src/client.js");
    const cap = parseUnits("0.05", 18);
    // the policy the remote MCP's gloam_mpp_how_to writes for BNB Chain
    const policy = { maxAmountWei: cap, currencies: [USDT], chainIds: [56] };
    const charge = (currency: Address, amount: bigint, decimals: number) => ({
      amount: amount.toString(),
      currency,
      recipient: payee.tag,
      methodDetails: { chainId: 56, pool, decimals },
    });
    assert.doesNotThrow(() => assertPayable(charge(USDT, cap, 18), policy), "0.05 USDT is paid");
    assert.throws(() => assertPayable(charge(USDT, cap + 1n, 18), policy), /over the payer's limit/);
    assert.throws(() => assertPayable(charge(NATIVE, cap, 18), policy), /not allowed by this payer/, "0.05 BNB, the same base units");
    assert.throws(() => assertPayable(charge(BDX, cap, 9), policy), /not allowed by this payer/, "5 * 10^16 BDX base units is 50,000,000 BDX");
    // what the cap alone used to allow
    assert.doesNotThrow(() => assertPayable(charge(BDX, cap, 9), { maxAmountWei: cap }));
  });

  test("the paywall reads a 0.25 price on BNB Chain as 0.25 USDT, not 0.25 * 10^-12", async () => {
    const mock = mockPool(pool as Address);
    const paywall = createGloamPaywall({
      secretKey: randomBytes(24).toString("hex"),
      network: "bnb-mainnet",
      server: { receiveKey: payee, chain: mock.chain, prove: stubProve, submit: mock.submitter("payee"), replay: memoryReplayStore(), beforeSubmit: () => {} },
    });
    const r = await paywall.charge({ amount: "0.25" })(new Request("https://api.example.com/answer"));
    assert.equal(r.status, 402);
    const [ch] = parsePaymentChallenges(r.status === 402 ? r.challenge.headers.get("www-authenticate") : null);
    assert.ok(ch);
    assert.deepEqual(ch.request, { amount: "250000000000000000", currency: USDT, recipient: payee.tag, methodDetails: { chainId: 56, pool, decimals: 18 } });
    assert.throws(
      () =>
        createGloamPaywall({
          secretKey: randomBytes(24).toString("hex"),
          network: "bnb-mainnet",
          decimals: 6,
          server: { receiveKey: payee, chain: mock.chain, prove: stubProve, submit: mock.submitter("payee"), replay: memoryReplayStore(), beforeSubmit: () => {} },
        }),
      /USDT on BNB Chain has 18 decimals, not 6/
    );
  });
}
