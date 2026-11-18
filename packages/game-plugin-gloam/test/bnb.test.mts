/**
 * BNB Chain mainnet ("bnb-mainnet", 56) is a network name the plugin knows,
 * refused by name while the SDK has no pool for it. With a placeholder pool
 * put in before the SDK builds its networks (a child process), it resolves
 * with gas in BNB, USDT and USDC in 18 decimals (not 6), BDX in 9, and reads
 * that refuse a pruned log answer; an owner's limit counts in 18 decimals and
 * a decimals value that disagrees with a listed asset is refused.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseUnits } from "viem";
// The config module alone, before the SDK builds its networks from it.
import { BNB_MAINNET, bnbMainnetConfig } from "../../sdk/src/bnb.ts";

const FILLED = process.env.GLOAM_TEST_BNB === "filled";
const POOL = "0x89d3042390204f57b8b4F8949D3c2203E4002164";
const USDT = "0x55d398326f99059fF775485246999027B3197955";
const LIVE = bnbMainnetConfig();
if (FILLED && !LIVE) Object.assign(BNB_MAINNET, { pool: POOL, deployBlock: 134_300_000n });

const { NETWORK_KEYS, isNetworkKey, resolveNetwork, findAsset, defaultAsset } = await import("../src/networks.js");
const { resolveLimits } = await import("../src/limits.js");
const { GloamAgent } = await import("../src/agent.js");

test("bnb-mainnet is a network name the plugin knows", () => {
  assert.ok(isNetworkKey("bnb-mainnet"));
  assert.ok(NETWORK_KEYS.includes("bnb-mainnet"));
});

if (!FILLED && !LIVE) {
  test("bnb-mainnet is refused by name until the SDK has its pool", () => {
    assert.throws(() => resolveNetwork("bnb-mainnet", { env: {} }), /BNB Chain mainnet is not live in this version/);
    assert.throws(
      () => resolveLimits("bot", { recipients: "any", assets: { USDT: { maxPerPayment: "1", maxPerDay: "5" } } }, "test", "bnb-mainnet"),
      /bnb-mainnet has no Gloam pool in this SDK version/
    );
  });

  test("with its pool in, BNB Chain resolves with 18-decimal stablecoins (child process)", () => {
    const child = spawnSync(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url)], {
      env: { ...process.env, GLOAM_TEST_BNB: "filled" },
      encoding: "utf8",
    });
    assert.equal(child.status, 0, child.stdout + child.stderr);
  });
} else {
  test("BNB Chain: gas in BNB, USDT first with 18 decimals, BDX with 9", () => {
    const n = resolveNetwork("bnb-mainnet", { env: {} });
    assert.equal(n.chainId, 56);
    assert.equal(n.testnet, false);
    assert.equal(n.chain.nativeCurrency.symbol, "BNB");
    assert.deepEqual(n.assets.map((a) => [a.symbol, a.decimals]), [["USDT", 18], ["USDC", 18], ["BNB", 18], ["BDX", 9]]);
    assert.equal(defaultAsset(n).address, USDT);
    assert.equal(findAsset(n, "usdc")?.decimals, 18);
    assert.equal(resolveNetwork("bnb-mainnet", { env: { GLOAM_RPC_URL_56: "https://bsc.example/v1" } }).rpc, "https://bsc.example/v1");
  });

  test("an owner's USDT limit on BNB Chain counts in 18 decimals; a wrong decimals is refused", () => {
    const p = resolveLimits("bot", { recipients: "any", assets: { USDT: { maxPerPayment: "10", maxPerDay: "50" } } }, "test", "bnb-mainnet");
    assert.equal(p.assets[0]!.decimals, 18);
    assert.equal(p.assets[0]!.maxPerPayment, parseUnits("10", 18));
    assert.throws(
      () => resolveLimits("bot", { recipients: "any", assets: { USDT: { maxPerPayment: "10", maxPerDay: "50", decimals: 6 } } }, "test", "bnb-mainnet"),
      /USDT on BNB Chain has 18 decimals, not 6/
    );
  });

  test("the agent reads BNB Chain through the pruned-logs guard", () => {
    const dir = mkdtempSync(join(tmpdir(), "gloam-bnb-"));
    // a throwaway note-store key, random per run: no wallet, nothing signed or sent
    const agent = new GloamAgent({ network: "bnb-mainnet", dataDir: dir, env: { GLOAM_NOTE_KEY: randomBytes(32).toString("hex"), GLOAM_NOTE_STORE: join(dir, "notes.json") } });
    assert.equal((agent as unknown as { publicClient: { transport: { type: string } } }).publicClient.transport.type, "gloamPrunedGuard");
  });
}
