/**
 * MCP: BNB Chain mainnet (56), offered only once the SDK has its pool
 * (packages/sdk/src/bnb.ts). As committed it is not offered and a limit that
 * names it is refused; with a placeholder pool put in before the MCP loads (a
 * child process), it is a mainnet with gas in BNB, USDT and USDC counted in 18
 * decimals (not 6), BDX in 9, the final keys, reads that fail loudly on a
 * pruned RPC, and swaps refused by name. Decimals an agent passes for a listed
 * asset that disagree with the asset's own are refused on every network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseUnits } from "viem";

const FILLED = process.env.GLOAM_TEST_BNB === "filled";
const POOL = "0x89d3042390204f57b8b4F8949D3c2203E4002164";
const USDT = "0x55d398326f99059fF775485246999027B3197955";
const USDC = "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d";
const BDX = "0x9d10a1ec41Fe7878429BB457e31F9b050D38c633";

// The SDK's config module on its own, before the SDK's networks are built from it.
// In this workspace @gloamtrade/sdk is its src/ (package.json), so this is the same module.
const bnb = await import("../../packages/sdk/src/bnb.js");
const LIVE = bnb.bnbMainnetConfig();
if (FILLED && !LIVE) Object.assign(bnb.BNB_MAINNET, { pool: POOL, deployBlock: 134_300_000n });
const nets = await import("../src/networks.js");
const policy = await import("../src/policy.js");
const data = await import("../src/data.js");
const server = await import("../src/server.js");
const signer = await import("../src/signer.js");
const sdk = await import("../../packages/sdk/src/index.js");

test("an agent's decimals for a listed asset must be the asset's own", () => {
  const base = nets.MCP_MAINNETS.find((n) => n.key === "base-mainnet");
  if (!base) return;
  assert.deepEqual(server.amountDecimals(base.chainId, base.defaultAsset, undefined), { decimals: 6 });
  assert.deepEqual(server.amountDecimals(base.chainId, base.defaultAsset, 6), { decimals: 6 });
  const r = server.amountDecimals(base.chainId, base.defaultAsset, 18);
  assert.ok("error" in r && /USDC on Base has 6 decimals, not 18/.test(r.error), JSON.stringify(r));
  // a token Gloam does not list takes the agent's value, or the fallback
  assert.deepEqual(server.amountDecimals(base.chainId, "0x0000000000000000000000000000000000001234", 8), { decimals: 8 });
  assert.deepEqual(server.amountDecimals(base.chainId, "0x0000000000000000000000000000000000001234", undefined, 18), { decimals: 18 });
});

if (!FILLED && !LIVE) {
  test("BNB Chain is not offered while the SDK has no pool for it", () => {
    assert.ok(!nets.NETWORK_KEYS.includes("bnb-mainnet"));
    assert.ok(nets.ALL_NETWORK_KEYS.includes("bnb-mainnet"));
    assert.throws(() => nets.networkByKey("bnb-mainnet"), /not available/);
    assert.throws(() => nets.defaultNetworkKey({ GLOAM_NETWORK: "bnb-mainnet" }), /no bnb-mainnet pool yet/);
    assert.equal(nets.networkByChainId(56), undefined);
    assert.throws(
      () => policy.resolveAgent("bot", { recipients: "any", assets: { USDT: { network: "bnb-mainnet", maxPerPayment: "10", maxPerDay: "50" } } }, "test"),
      /not available in this version/
    );
    assert.ok(!policy.KNOWN_ASSETS.some((a) => a.chainId === 56), "no BNB Chain rows before the pool");
  });

  test("the facts never name BNB Chain while it is off", () => {
    assert.ok(!/bnb/i.test(JSON.stringify(data.PRIVACY_STATUS)));
    const loaded = policy.loadPolicy({ GLOAM_LIMIT_NETWORK: "nope", GLOAM_LIMIT_ASSETS: "USDC" }, () => "");
    assert.ok(loaded.mode === "invalid" && !/bnb/.test(loaded.error), "the limit error does not offer it");
  });

  test("with its pool in, BNB Chain is a mainnet (child process)", () => {
    const child = spawnSync(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url)], {
      env: { ...process.env, GLOAM_TEST_BNB: "filled" },
      encoding: "utf8",
    });
    assert.equal(child.status, 0, child.stdout + child.stderr);
  });
} else {
  test("BNB Chain is a mainnet with gas in BNB and USDT first", () => {
    const n = nets.networkByKey("bnb-mainnet");
    assert.equal(n.chainId, 56);
    assert.equal(n.family, "bnb");
    assert.equal(n.testnet, false);
    assert.equal(n.ceremony, "production");
    assert.equal(n.name, "BNB Chain Mainnet");
    assert.equal(nets.describeNetwork(n), "BNB Chain mainnet");
    assert.equal(n.nativeCurrency.symbol, "BNB");
    assert.equal(n.nativeShield, true);
    assert.equal(n.defaultAssetSymbol, "USDT");
    assert.equal(n.defaultAsset, USDT);
    assert.equal(n.defaultAssetDecimals, 18, "USDT on BNB Chain has 18 decimals");
    assert.equal(nets.networkByChainId(56)?.key, "bnb-mainnet");
    const mains = nets.NETWORK_KEYS.filter((k) => !nets.networkByKey(k).testnet);
    assert.equal(mains[mains.length - 1], "bnb-mainnet", "listed last among the mainnets");
    assert.ok(n.logCanary && n.logCanary.address === USDT, "reads carry the pruned-logs canary");
  });

  test("reads on BNB Chain go through the pruned-logs guard", () => {
    const c = signer.getPublicClient(nets.networkByKey("bnb-mainnet"));
    assert.equal(c.transport.type, "gloamPrunedGuard");
    const other = nets.MCP_MAINNETS.find((n) => n.key === "base-mainnet");
    if (other) assert.notEqual(signer.getPublicClient(other).transport.type, "gloamPrunedGuard");
  });

  test("the facts name BNB Chain, gas in BNB, and its limits", () => {
    assert.match(data.PRIVACY_STATUS.network, /BNB Chain \(gas in BNB\)/);
    assert.match(data.PRIVACY_STATUS.mainnetLimits, /on BNB Chain no limit for USDT, USDC and BNB, with BDX at 100,000 and 2,000,000/);
  });

  test("Gloam's list counts BNB Chain's stablecoins in 18 decimals", () => {
    const rows = policy.KNOWN_ASSETS.filter((a) => a.chainId === 56);
    assert.deepEqual(rows.map((a) => [a.symbol, a.decimals, a.stable]), [
      ["USDT", 18, true],
      ["USDC", 18, true],
      ["BNB", 18, false],
      ["BDX", 9, false],
    ]);
    assert.deepEqual(server.amountDecimals(56, USDT, undefined), { decimals: 18 });
    assert.deepEqual(server.amountDecimals(56, USDC, 18), { decimals: 18 });
    const r = server.amountDecimals(56, USDT, 6);
    assert.ok("error" in r && /USDT on BNB Chain has 18 decimals, not 6/.test(r.error), "6 for BNB Chain's USDT is refused");
    assert.deepEqual(server.amountDecimals(56, BDX, undefined), { decimals: 9 });
  });

  test("a USDT limit naming BNB Chain counts in 18 decimals; a bare USDT keeps its old meaning", () => {
    const p = policy.resolveAgent("bot", { recipients: "any", assets: { USDT: { network: "bnb-mainnet", maxPerPayment: "10", maxPerDay: "50" } } }, "test");
    const a = p.assets[0]!;
    assert.equal(a.chainId, 56);
    assert.equal(a.address, USDT);
    assert.equal(a.decimals, 18);
    assert.equal(a.maxPerPayment, parseUnits("10", 18));
    // by address, with no network: BNB Chain's row, 18 decimals
    const byAddr = policy.resolveAgent("bot", { recipients: "any", assets: { [USDC]: { maxPerPayment: "1", maxPerDay: "5" } } }, "test");
    assert.equal(byAddr.assets[0]!.chainId, 56);
    assert.equal(byAddr.assets[0]!.decimals, 18);
    // GLOAM_LIMIT_NETWORK names BNB Chain for every bare symbol
    const env = policy.loadPolicy(
      { GLOAM_LIMIT_NETWORK: "bnb-mainnet", GLOAM_LIMIT_ASSETS: "USDT,USDC", GLOAM_LIMIT_MAX_PER_PAYMENT: "5", GLOAM_LIMIT_MAX_PER_DAY: "20", GLOAM_LIMIT_RECIPIENTS: "any" },
      () => ""
    );
    assert.equal(env.mode, "enforced");
    if (env.mode === "enforced") {
      assert.ok(env.policy.assets.every((x) => x.chainId === 56 && x.decimals === 18));
      assert.equal(env.policy.assets[0]!.maxPerDay, parseUnits("20", 18));
    }
    // a bare USDT is still Base's, so it never caps BNB Chain's in the wrong decimals
    const bare = policy.resolveAgent("bot", { recipients: "any", assets: { USDT: { maxPerPayment: "10", maxPerDay: "50" } } }, "test");
    assert.notEqual(bare.assets[0]!.chainId, 56);
  });

  test("BNB and BDX take their own caps, never the stablecoins' agent-wide one", () => {
    assert.throws(
      () => policy.resolveAgent("bot", { recipients: "any", maxPerPayment: "10", maxPerDay: "50", assets: { USDT: { network: "bnb-mainnet" }, BDX: { network: "bnb-mainnet" } } }, "test"),
      /can't cap/
    );
  });

  test("private swaps are refused by name on BNB Chain", async () => {
    assert.ok(!sdk.swapChainIds().includes(56));
    await assert.rejects(sdk.planVaultSwap({} as never, 56, { assetIn: USDT, assetOut: USDC, amountIn: 1n, feeBps: 50 } as never), /not on BNB Chain yet/);
  });
}
