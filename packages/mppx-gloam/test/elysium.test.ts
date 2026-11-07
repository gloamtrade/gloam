/**
 * Elysium mainnet: refused by name while the SDK has no values for it; with
 * placeholder values put in before the SDK builds its networks (a child
 * process), it is an official pool, USDC is its default currency with 6
 * decimals, and its gas coin reads as HYPE, never ETH.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
// The config module alone, before the SDK builds its networks from it.
import { ELYSIUM_MAINNET, ELYSIUM_TESTNET, elysiumMainnetConfig, elysiumTestnetConfig } from "../../sdk/src/elysium.ts";

const FILLED = process.env.GLOAM_TEST_ELYSIUM === "filled";
const TESTNET = process.env.GLOAM_TEST_ELYSIUM === "testnet";
const CHAIN_ID = 99901;
const TESTNET_ID = 99801;
const TESTNET_USDC = "0x7D29d8047B905000459c0E80c34a26CeedcB47b2";
const POOL = "0x39E28Cde55CAB798874746ac52cb4B5Cc99a0194";
const USDC = "0x00000000000000000000000000000000000E1a5c";
const LIVE = elysiumMainnetConfig();
if (FILLED && !LIVE) {
  Object.assign(ELYSIUM_MAINNET, {
    chainId: CHAIN_ID,
    rpcUrl: "https://rpc.elysium.example",
    explorerUrl: "https://explorer.elysium.example",
    usdc: USDC,
    usdcDecimals: 6,
    pool: POOL,
    deployBlock: 1234n,
  });
}
const LIVE_TESTNET = elysiumTestnetConfig();
if (TESTNET && !LIVE_TESTNET) Object.assign(ELYSIUM_TESTNET, { pool: POOL, deployBlock: 5678n });
const { OFFICIAL_POOLS, assetDecimals, assetSymbol, resolveNetwork } = await import("../src/index.js");

if (TESTNET) {
  test("Elysium testnet: official pool, test USDC by default, gas in HYPE", () => {
    const r = resolveNetwork("elysium");
    assert.equal(r.chainId, TESTNET_ID);
    assert.equal(r.currency.toLowerCase(), TESTNET_USDC.toLowerCase());
    assert.equal(r.decimals, 6);
    assert.equal(OFFICIAL_POOLS[TESTNET_ID]?.toLowerCase(), (LIVE_TESTNET?.pool ?? POOL).toLowerCase());
  });
} else if (!FILLED && !LIVE) {
  test("Elysium is refused by name while the SDK has no values", () => {
    assert.throws(() => resolveNetwork("elysium-mainnet"), /Elysium mainnet is not live in this version/);
    assert.equal(OFFICIAL_POOLS[CHAIN_ID], undefined);
    assert.equal(assetSymbol(CHAIN_ID, "0x0000000000000000000000000000000000000000"), "ETH", "an unknown chain keeps the old label");
  });

  test("Elysium testnet is refused by name until the SDK has its pool, and its USDC has a label", () => {
    if (!LIVE_TESTNET) {
      assert.throws(() => resolveNetwork("elysium"), /Elysium testnet is not live in this version/);
      assert.equal(OFFICIAL_POOLS[TESTNET_ID], undefined);
    }
    assert.equal(assetSymbol(TESTNET_ID, TESTNET_USDC), "USDC");
    assert.equal(assetDecimals(TESTNET_USDC), 6);
    assert.equal(assetSymbol(TESTNET_ID, "0x0000000000000000000000000000000000000000"), "HYPE");
  });

  test("with its pool in, Elysium testnet is an official pool (child process)", () => {
    const child = spawnSync(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url)], {
      env: { ...process.env, GLOAM_TEST_ELYSIUM: "testnet" },
      encoding: "utf8",
    });
    assert.equal(child.status, 0, child.stdout + child.stderr);
  });

  test("with its values in, Elysium is an official pool (child process)", () => {
    const child = spawnSync(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url)], {
      env: { ...process.env, GLOAM_TEST_ELYSIUM: "filled" },
      encoding: "utf8",
    });
    assert.equal(child.status, 0, child.stdout + child.stderr);
  });
} else {
  const id = LIVE?.chainId ?? CHAIN_ID;
  const usdc = LIVE?.usdc ?? USDC;
  test("Elysium: official pool, USDC by default, gas in HYPE", () => {
    const r = resolveNetwork("elysium-mainnet");
    assert.equal(r.chainId, id);
    assert.equal(r.currency.toLowerCase(), usdc.toLowerCase());
    assert.equal(r.decimals, LIVE?.usdcDecimals ?? 6);
    assert.equal(OFFICIAL_POOLS[id]?.toLowerCase(), (LIVE?.pool ?? POOL).toLowerCase());
    assert.equal(assetSymbol(id, usdc), "USDC");
    assert.equal(assetDecimals(usdc), LIVE?.usdcDecimals ?? 6);
    assert.equal(assetSymbol(id, "0x0000000000000000000000000000000000000000"), "HYPE");
    assert.equal(assetSymbol(8453, "0x0000000000000000000000000000000000000000"), "ETH");
  });
}
