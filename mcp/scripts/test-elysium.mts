/**
 * MCP: Elysium mainnet, offered only once the SDK has every Elysium value
 * (packages/sdk/src/elysium.ts). As committed it is not offered and a limit that
 * names it is refused; with placeholder values put in before the MCP loads (a
 * child process), it is a mainnet with gas in HYPE, USDC as its only asset,
 * the final keys, and a USDC limit can name it. Its testnet ("elysium", 99801)
 * the same way, once the SDK has the testnet's pool (a second child process).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const FILLED = process.env.GLOAM_TEST_ELYSIUM === "filled";
const TESTNET = process.env.GLOAM_TEST_ELYSIUM === "testnet";
const CHAIN_ID = 99901;
const TESTNET_ID = 99801;
const TESTNET_USDC = "0x7D29d8047B905000459c0E80c34a26CeedcB47b2";
const USDC = "0x00000000000000000000000000000000000E1a5c";

// The SDK's config module on its own, before the SDK's networks are built from it.
// In this workspace @gloamtrade/sdk is its src/ (package.json), so this is the same module.
const ely = await import("../../packages/sdk/src/elysium.js");
const LIVE = ely.elysiumMainnetConfig();
if (FILLED && !LIVE) {
  Object.assign(ely.ELYSIUM_MAINNET, {
    chainId: CHAIN_ID,
    rpcUrl: "https://rpc.elysium.example",
    explorerUrl: "https://explorer.elysium.example",
    usdc: USDC,
    usdcDecimals: 6,
    pool: "0x39E28Cde55CAB798874746ac52cb4B5Cc99a0194",
    deployBlock: 1234n,
  });
}
const LIVE_TESTNET = ely.elysiumTestnetConfig();
if (TESTNET && !LIVE_TESTNET) {
  Object.assign(ely.ELYSIUM_TESTNET, { pool: "0x39E28Cde55CAB798874746ac52cb4B5Cc99a0194", deployBlock: 5678n });
}
const nets = await import("../src/networks.js");
const policy = await import("../src/policy.js");
const data = await import("../src/data.js");
const sdk = await import("../../packages/sdk/src/index.js");

if (TESTNET) {
  test("Elysium testnet is a testnet with gas in HYPE and test USDC only", () => {
    const n = nets.networkByKey("elysium");
    assert.equal(n.chainId, TESTNET_ID);
    assert.equal(n.family, "elysium");
    assert.equal(n.testnet, true);
    assert.equal(n.ceremony, "production");
    assert.equal(n.name, "Elysium Testnet");
    assert.equal(nets.describeNetwork(n), "Elysium testnet");
    assert.equal(n.nativeCurrency.symbol, "HYPE");
    assert.equal(n.nativeShield, false);
    assert.equal(n.defaultAssetSymbol, "USDC");
    assert.equal(n.defaultAsset.toLowerCase(), (LIVE_TESTNET?.usdc ?? TESTNET_USDC).toLowerCase());
    assert.equal(nets.networkByChainId(TESTNET_ID)?.key, "elysium");
    assert.equal(nets.NETWORK_KEYS[nets.NETWORK_KEYS.length - 1], "elysium", "listed last, after the other testnets");
    if (!LIVE) assert.ok(!nets.NETWORK_KEYS.includes("elysium-mainnet"), "mainnet stays hidden without its values");
  });

  test("a USDC limit can name Elysium testnet", () => {
    const p = policy.resolveAgent("bot", { recipients: "any", assets: { USDC: { network: "elysium", maxPerPayment: "10", maxPerDay: "50" } } }, "test");
    assert.equal(p.assets[0]!.chainId, TESTNET_ID);
    assert.equal(p.assets[0]!.address.toLowerCase(), (LIVE_TESTNET?.usdc ?? TESTNET_USDC).toLowerCase());
  });

  test("private swaps are refused by name on Elysium testnet", async () => {
    await assert.rejects(sdk.planVaultSwap({} as never, TESTNET_ID, { assetIn: TESTNET_USDC, assetOut: TESTNET_USDC, amountIn: 1n, feeBps: 50 } as never), /not on Elysium yet/);
  });
} else if (!FILLED && !LIVE) {
  test("Elysium is not offered while the SDK has no values", () => {
    assert.ok(!nets.NETWORK_KEYS.includes("elysium-mainnet"));
    assert.ok(nets.ALL_NETWORK_KEYS.includes("elysium-mainnet"));
    assert.throws(() => nets.networkByKey("elysium-mainnet"), /not available/);
    assert.throws(() => nets.defaultNetworkKey({ GLOAM_NETWORK: "elysium-mainnet" }), /no elysium-mainnet pool yet/);
    assert.throws(
      () => policy.resolveAgent("bot", { recipients: "any", assets: { USDC: { network: "elysium-mainnet", maxPerPayment: "10", maxPerDay: "50" } } }, "test"),
      /not available in this version/
    );
  });

  test("Elysium testnet is not offered while the SDK has no pool for it", () => {
    if (LIVE_TESTNET) return;
    assert.ok(!nets.NETWORK_KEYS.includes("elysium"));
    assert.ok(nets.ALL_NETWORK_KEYS.includes("elysium"));
    assert.throws(() => nets.networkByKey("elysium"), /not available/);
    assert.throws(() => nets.defaultNetworkKey({ GLOAM_NETWORK: "elysium" }), /no elysium pool yet/);
    assert.throws(
      () => policy.resolveAgent("bot", { recipients: "any", assets: { USDC: { network: "elysium", maxPerPayment: "10", maxPerDay: "50" } } }, "test"),
      /not available in this version/
    );
  });

  test("with its pool in, Elysium testnet is a testnet (child process)", () => {
    const child = spawnSync(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url)], {
      env: { ...process.env, GLOAM_TEST_ELYSIUM: "testnet" },
      encoding: "utf8",
    });
    assert.equal(child.status, 0, child.stdout + child.stderr);
  });

  test("the facts never name Elysium while it is off", () => {
    assert.ok(!/elysium/i.test(JSON.stringify(data.PRIVACY_STATUS)));
    const loaded = policy.loadPolicy({ GLOAM_LIMIT_NETWORK: "nope", GLOAM_LIMIT_ASSETS: "USDC" }, () => "");
    assert.equal(loaded.mode, "invalid");
    assert.ok(loaded.mode === "invalid" && !/elysium/.test(loaded.error), "the limit error does not offer it");
  });

  test("with its values in, Elysium is a mainnet (child process)", () => {
    const child = spawnSync(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url)], {
      env: { ...process.env, GLOAM_TEST_ELYSIUM: "filled" },
      encoding: "utf8",
    });
    assert.equal(child.status, 0, child.stdout + child.stderr);
  });
} else {
  const id = LIVE?.chainId ?? CHAIN_ID;
  test("Elysium is a mainnet with gas in HYPE and USDC only", () => {
    const n = nets.networkByKey("elysium-mainnet");
    assert.equal(n.chainId, id);
    assert.equal(n.family, "elysium");
    assert.equal(n.testnet, false);
    assert.equal(n.ceremony, "production");
    assert.equal(n.name, "Elysium Mainnet");
    assert.equal(n.nativeCurrency.symbol, "HYPE");
    assert.equal(n.nativeShield, false);
    assert.equal(n.defaultAssetSymbol, "USDC");
    assert.equal(nets.describeNetwork(n), "Elysium mainnet");
    assert.equal(nets.networkByChainId(id)?.key, "elysium-mainnet");
    const mains = nets.NETWORK_KEYS.filter((k) => !nets.networkByKey(k).testnet);
    assert.equal(mains[mains.length - 1], "elysium-mainnet");
  });

  test("the facts name Elysium, with gas in HYPE and its USDC limits", () => {
    assert.match(data.PRIVACY_STATUS.network, /Elysium \(gas in HYPE\)/);
    assert.match(data.PRIVACY_STATUS.mainnetLimits, /500 and 25,000 for USDC on Elysium/);
  });

  test("private swaps are refused by name on Elysium", async () => {
    assert.ok(!sdk.swapChainIds().includes(id));
    await assert.rejects(sdk.planVaultSwap({} as never, id, { assetIn: USDC, assetOut: USDC, amountIn: 1n, feeBps: 50 } as never), /not on Elysium yet/);
  });

  test("a USDC limit can name Elysium", () => {
    const p = policy.resolveAgent("bot", { recipients: "any", assets: { USDC: { network: "elysium-mainnet", maxPerPayment: "10", maxPerDay: "50" } } }, "test");
    const a = p.assets[0]!;
    assert.equal(a.chainId, id);
    assert.equal(a.decimals, 6);
    assert.equal(a.address.toLowerCase(), (LIVE?.usdc ?? USDC).toLowerCase());
    assert.equal(a.maxPerPayment, 10_000_000n);
  });
}
