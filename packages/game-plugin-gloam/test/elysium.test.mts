/**
 * Elysium mainnet is a network name the plugin knows, refused by name while the
 * SDK has no values for it, and never guessed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { elysiumMainnetConfig, elysiumTestnetConfig } from "@gloamtrade/sdk";
import { NETWORK_KEYS, isNetworkKey, resolveNetwork } from "../src/networks.js";

test("elysium-mainnet is known, and refused by name until the SDK has its values", () => {
  assert.ok(isNetworkKey("elysium-mainnet"));
  assert.ok(isNetworkKey("elysium"));
  assert.deepEqual(NETWORK_KEYS.slice(-2), ["elysium-mainnet", "elysium"]);
  const cfg = elysiumMainnetConfig();
  if (!cfg) {
    assert.throws(() => resolveNetwork("elysium-mainnet", { env: {} }), /Elysium mainnet is not live in this version/);
  } else {
    const n = resolveNetwork("elysium-mainnet", { env: {} });
    assert.equal(n.chainId, cfg.chainId);
    assert.equal(n.chain.nativeCurrency.symbol, "HYPE");
    assert.deepEqual(n.assets.map((a) => a.symbol), ["USDC"]);
  }
});

test("elysium (testnet) is refused by name until the SDK has its pool", () => {
  const cfg = elysiumTestnetConfig();
  if (!cfg) {
    assert.throws(() => resolveNetwork("elysium", { env: {} }), /Elysium testnet is not live in this version/);
  } else {
    const n = resolveNetwork("elysium", { env: {} });
    assert.equal(n.chainId, 99801);
    assert.ok(n.testnet);
    assert.equal(n.chain.nativeCurrency.symbol, "HYPE");
  }
});
