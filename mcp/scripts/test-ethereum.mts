/**
 * Ethereum tests: the server as it will be once a release has the Ethereum pool.
 *
 * The SDK builds its networks when it loads, from MAINNET_POOLS, where chain 1
 * is still null (test-mainnet.mts covers that state). Here it gets a
 * placeholder pool before anything else loads, so this file runs on its own
 * (node --test gives each file its own process).
 *
 *   pnpm --filter @gloamtrade/mcp test
 *
 * Nothing here touches a chain.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
// The SDK's own mainnet module, the same file @gloamtrade/sdk loads; patched before the networks are built.
import { MAINNET_POOLS } from "../../packages/sdk/src/mainnet.js";
import type { Spend } from "../src/policy.js";

MAINNET_POOLS[1] = { pool: "0x00000000000000000000000000000000000000e1", deployBlock: 23_000_000n };

const { ETHEREUM_PYUSD, ETHEREUM_USDC, ETHEREUM_USDT, ETHEREUM_BDX, BASE_BDX, BASE_USDT, NATIVE_ASSET, assertDepositAllowed, assertDepositWithinLiveLimit, approvalSteps, ethereumSepoliaPool } = await import("@gloamtrade/sdk");
const nets = await import("../src/networks.js");
const { checkSpend, loadPolicy, resolveAgent } = await import("../src/policy.js");

const NOW = Date.UTC(2026, 9, 26, 12);
const PAYEE = "0x00000000000000000000000000000000000000aa";
const spend = (over: Partial<Spend>): Spend => ({
  tool: "pay",
  network: "ethereum-mainnet",
  chainId: 1,
  asset: ETHEREUM_USDC,
  amountWei: 1_000_000n,
  recipient: PAYEE,
  ...over,
});

test("Ethereum is offered with the mainnets once its pool is in", () => {
  const keys = nets.NETWORK_KEYS;
  assert.ok(keys.includes("ethereum-mainnet"));
  assert.ok(keys.indexOf("ethereum-mainnet") < keys.indexOf("robinhood"), "with the mainnets, before the testnets");
  const n = nets.networkByKey("ethereum-mainnet");
  assert.equal(n.chainId, 1);
  assert.equal(n.family, "ethereum");
  assert.equal(n.testnet, false);
  assert.equal(n.ceremony, "production", "the ceremony's final keys");
  assert.equal(n.nativeShield, true, "ETH is listed");
  assert.equal(n.nativeCurrency.symbol, "ETH");
  assert.equal(n.defaultAsset, ETHEREUM_USDC);
  assert.equal(n.name, "Ethereum Mainnet");
  assert.equal(nets.describeNetwork(n), "Ethereum mainnet");
  assert.equal(n.explorer, "https://etherscan.io");
  assert.equal(n.rpc, "https://rpc.mevblocker.io", "an RPC that keeps old logs");
  assert.equal(nets.networkByChainId(1)?.key, "ethereum-mainnet");
});

test("GLOAM_NETWORK takes ethereum-mainnet, the access key goes to Tempo mainnet, and GLOAM_RPC_URL_1 is read", () => {
  assert.equal(nets.defaultNetworkKey({ GLOAM_NETWORK: "ethereum-mainnet" }), "ethereum-mainnet");
  assert.equal(nets.tempoAccessNetwork({ GLOAM_NETWORK: "ethereum-mainnet" }).chainId, 4217);
  // "ethereum" is Ethereum Sepolia: refused by name until the SDK has its pool (test-ethereum-sepolia.mts).
  if (ethereumSepoliaPool() === null) assert.throws(() => nets.defaultNetworkKey({ GLOAM_NETWORK: "ethereum" }), /no ethereum pool yet/);
  const src = readFileSync(new URL("../src/networks.ts", import.meta.url), "utf8");
  assert.match(src, /GLOAM_RPC_URL_\$\{chainId\}/, "any chain id, 1 included");
});

test("deposits on Ethereum are checked against its listed assets and limits", async () => {
  assert.doesNotThrow(() => assertDepositAllowed(1, ETHEREUM_PYUSD, 500_000_000n));
  // amounts are read live from the vault, so a new limit is taken the day it lands
  assert.doesNotThrow(() => assertDepositAllowed(1, ETHEREUM_USDT, 500_000_001n));
  assert.doesNotThrow(() => assertDepositAllowed(1, NATIVE_ASSET, 2n * 10n ** 17n + 1n));
  const vault = (per: bigint) => ({
    readContract: (async ({ functionName }: { functionName: string }) =>
      functionName === "depositLimitsOn" ? true : functionName === "depositLimit" ? [per, per * 50n] : 0n) as never,
  });
  await assert.rejects(assertDepositWithinLiveLimit(vault(500_000_000n), 1, ETHEREUM_USDT, 500_000_001n), /at most 500 USDT per deposit/);
  await assertDepositWithinLiveLimit(vault(50_000_000_000n), 1, ETHEREUM_USDT, 500_000_001n);
  const down = { readContract: (async () => { throw new Error("rpc down"); }) as never };
  assert.equal(await assertDepositWithinLiveLimit(down, 1, ETHEREUM_USDT, 10n ** 30n), null, "an unreadable vault refuses nothing");
  assert.throws(() => assertDepositAllowed(1, BASE_USDT, 1n), /does not list/);
});

test("BDX: listed on Ethereum, refused while its live limit is 0, taken once it lands", async () => {
  assert.doesNotThrow(() => assertDepositAllowed(1, ETHEREUM_BDX, 1n));
  const vault = (per: bigint, total: bigint) => ({
    readContract: (async ({ functionName }: { functionName: string }) =>
      functionName === "depositLimitsOn" ? true : functionName === "depositLimit" ? [per, total] : 0n) as never,
  });
  await assert.rejects(assertDepositWithinLiveLimit(vault(0n, 0n), 1, ETHEREUM_BDX, 10n ** 9n), /The Ethereum vault takes no BDX deposits/);
  await assertDepositWithinLiveLimit(vault(100_000n * 10n ** 9n, 2_000_000n * 10n ** 9n), 1, ETHEREUM_BDX, 100_000n * 10n ** 9n);
});

test("no limit: a vault limit of uint128 max takes any amount and is never quoted as a number", async () => {
  const MAX = (1n << 128n) - 1n;
  const vault = (per: bigint, total: bigint) => ({
    readContract: (async ({ functionName }: { functionName: string }) =>
      functionName === "depositLimitsOn" ? true : functionName === "depositLimit" ? [per, total] : 0n) as never,
  });
  const lim = await assertDepositWithinLiveLimit(vault(MAX, MAX), 1, ETHEREUM_USDT, 10n ** 18n);
  assert.equal(lim?.unlimited, true);
  await assertDepositWithinLiveLimit(vault(MAX, MAX), 1, ETHEREUM_BDX, 10n ** 24n);
  // a finite side under a max one still applies, and its words never carry the max
  await assert.rejects(assertDepositWithinLiveLimit(vault(500_000_000n, MAX), 1, ETHEREUM_USDT, 500_000_001n), /^Error: Over the deposit limit on Ethereum: at most 500 USDT per deposit\.$/);
});

test("BDX in limits: 9 decimals, Base's when no network is named, Ethereum's when it is", () => {
  const bare = resolveAgent("bot", { recipients: "any", maxPerPayment: "1000", maxPerDay: "5000", assets: ["BDX"] }, "test");
  assert.deepEqual([bare.assets[0]!.address, bare.assets[0]!.chainId, bare.assets[0]!.decimals], [BASE_BDX, 8453, 9]);
  assert.equal(bare.assets[0]!.maxPerPayment, 1000n * 10n ** 9n);
  const eth = resolveAgent("bot", { recipients: "any", assets: { BDX: { network: "ethereum-mainnet", maxPerPayment: "1000", maxPerDay: "5000" } } }, "test");
  assert.deepEqual([eth.assets[0]!.address, eth.assets[0]!.chainId], [ETHEREUM_BDX, 1]);
  assert.equal(checkSpend(eth, spend({ asset: ETHEREUM_BDX, amountWei: 1000n * 10n ** 9n }), [], NOW), null);
  assert.equal(checkSpend(eth, spend({ asset: ETHEREUM_BDX, amountWei: 1000n * 10n ** 9n + 1n }), [], NOW)?.code, "over_per_payment");
  // Ethereum's BDX entry does not open Base's, though the address is the same
  assert.equal(checkSpend(eth, spend({ network: "base-mainnet", chainId: 8453, asset: BASE_BDX, amountWei: 1n }), [], NOW)?.code, "asset_not_allowed");
});

test("a stale USDT allowance is cleared before the shield's approval", () => {
  assert.deepEqual(approvalSteps(1, ETHEREUM_USDT, 7n, 100n), [0n, 100n]);
  assert.deepEqual(approvalSteps(1, ETHEREUM_USDC, 7n, 100n), [100n]);
  const src = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
  assert.match(src, /approveNeedsReset\(net\.chainId, assetAddr\)/, "the shield tool checks it");
});

test("Ethereum in limits: name the network; Ethereum's addresses are mainnet already, and PYUSD alone is Ethereum Sepolia's", () => {
  const real = resolveAgent(
    "bot",
    {
      recipients: [PAYEE],
      assets: {
        USDC: { network: "ethereum-mainnet", maxPerPayment: "5", maxPerDay: "10" },
        USDT: { network: "ethereum-mainnet", maxPerPayment: "5", maxPerDay: "10" },
        ETH: { network: "ethereum-mainnet", maxPerPayment: "0.01", maxPerDay: "0.05" },
        PYUSD: { network: "ethereum-mainnet", maxPerPayment: "3", maxPerDay: "6" },
      },
    },
    "test"
  );
  const [usdc, usdt, ethAsset, pyusd] = real.assets;
  assert.deepEqual([usdc!.address, usdc!.chainId], [ETHEREUM_USDC, 1]);
  assert.deepEqual([usdt!.address, usdt!.chainId], [ETHEREUM_USDT, 1]);
  assert.deepEqual([ethAsset!.address, ethAsset!.chainId, ethAsset!.decimals], [NATIVE_ASSET, 1, 18]);
  assert.deepEqual([pyusd!.address, pyusd!.chainId], [ETHEREUM_PYUSD, 1], "PYUSD on Ethereum mainnet when the entry names it");
  // A symbol on both sides is the testnet's unless a network is named: PYUSD alone is Ethereum Sepolia's.
  const bare = resolveAgent("bot", { recipients: "any", maxPerPayment: "5", maxPerDay: "10", assets: ["PYUSD"] }, "test");
  assert.equal(bare.assets[0]!.chainId, 11155111);
  assert.equal(checkSpend(real, spend({}), [], NOW), null);
  assert.equal(checkSpend(real, spend({ amountWei: 6_000_000n }), [], NOW)?.code, "over_per_payment");
  // Ethereum's USDT entry does not open Base's USDT
  assert.equal(checkSpend(real, spend({ network: "base-mainnet", chainId: 8453, asset: BASE_USDT }), [], NOW)?.code, "asset_not_allowed");

  // "USDT" alone still names Base's, as before Ethereum was added
  const plain = resolveAgent("bot", { recipients: "any", maxPerPayment: "5", maxPerDay: "10", assets: ["USDT"] }, "test");
  assert.equal(plain.assets[0]!.chainId, 8453);
  // an Ethereum address names Ethereum
  const byAddr = resolveAgent("bot", { recipients: "any", maxPerPayment: "5", maxPerDay: "10", assets: [ETHEREUM_USDC] }, "test");
  assert.deepEqual([byAddr.assets[0]!.chainId, byAddr.assets[0]!.decimals], [1, 6]);

  const read = (p: string) => readFileSync(p, "utf8");
  const env = { GLOAM_LIMIT_MAX_PER_PAYMENT: "5", GLOAM_LIMIT_MAX_PER_DAY: "10", GLOAM_LIMIT_RECIPIENTS: "any" };
  const inline = loadPolicy({ ...env, GLOAM_LIMIT_ASSETS: "USDC,USDT,USDG,PYUSD,EURC", GLOAM_LIMIT_NETWORK: "ethereum-mainnet" }, read);
  assert.equal(inline.mode, "enforced");
  if (inline.mode === "enforced") assert.deepEqual(inline.policy.assets.map((a) => a.chainId), [1, 1, 1, 1, 1]);
  // one pair of caps can't cover ETH next to the stablecoins ("5" would be 5 ETH): refused by design
  const withEth = loadPolicy({ ...env, GLOAM_LIMIT_ASSETS: "USDC,USDT,USDG,PYUSD,EURC,ETH", GLOAM_LIMIT_NETWORK: "ethereum-mainnet" }, read);
  assert.equal(withEth.mode, "invalid");
  if (withEth.mode === "invalid") assert.match(withEth.error, /count in each asset's own units/);
  // "ethereum" is Ethereum Sepolia, the testnet; a name Gloam does not use is refused with the right one in the message.
  const sepolia = loadPolicy({ ...env, GLOAM_LIMIT_ASSETS: "USDC", GLOAM_LIMIT_NETWORK: "ethereum" }, read);
  if (sepolia.mode === "enforced") assert.deepEqual(sepolia.policy.assets.map((a) => a.chainId), [11155111]);
  else assert.fail("GLOAM_LIMIT_NETWORK=ethereum names Ethereum Sepolia");
  const bad = loadPolicy({ ...env, GLOAM_LIMIT_ASSETS: "USDC", GLOAM_LIMIT_NETWORK: "eth" }, read);
  assert.equal(bad.mode, "invalid");
  if (bad.mode === "invalid") assert.match(bad.error, /ethereum-mainnet/);
});
