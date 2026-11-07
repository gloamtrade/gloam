/**
 * MCP: Elysium mainnet, offered only once the SDK has every Elysium value
 * (packages/sdk/src/elysium.ts). As committed it is not offered and a limit that
 * names it is refused; with placeholder values put in before the MCP loads (a
 * child process), it is a mainnet with gas in HYPE, USDC as its only asset,
 * the final keys, and a USDC limit can name it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const FILLED = process.env.GLOAM_TEST_ELYSIUM === "filled";
const CHAIN_ID = 990_001;
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
const nets = await import("../src/networks.js");
const policy = await import("../src/policy.js");

if (!FILLED && !LIVE) {
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

  test("a USDC limit can name Elysium", () => {
    const p = policy.resolveAgent("bot", { recipients: "any", assets: { USDC: { network: "elysium-mainnet", maxPerPayment: "10", maxPerDay: "50" } } }, "test");
    const a = p.assets[0]!;
    assert.equal(a.chainId, id);
    assert.equal(a.decimals, 6);
    assert.equal(a.address.toLowerCase(), (LIVE?.usdc ?? USDC).toLowerCase());
    assert.equal(a.maxPerPayment, 10_000_000n);
  });
}
