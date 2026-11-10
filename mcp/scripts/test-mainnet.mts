/**
 * Mainnet tests: which networks this build offers, how a mainnet is named in
 * limits, that a testnet config never approves mainnet assets by itself, the key
 * set each network proves with, and that a price on a chain this build has no
 * pool for is refused.
 *
 *   pnpm --filter @gloamtrade/mcp test
 *
 * Nothing here touches a chain. Mainnet pools come from the SDK's MAINNET_POOLS;
 * before deploy day they are null, and these tests cover that state.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseUnits, type Address } from "viem";
import {
  BASE_SEPOLIA_EURC,
  BASE_SEPOLIA_USDC,
  BASE_USDC,
  BASE_USDT,
  GLOAM_NETWORKS,
  GLOAM_TOKEN,
  NATIVE_ASSET,
  RH_MAINNET_USDG,
  RH_USDG,
  TEMPO_PATHUSD,
  TEMPO_USDCE,
  baseSepoliaPool,
  circuitArtifactFiles,
  ethereumSepoliaPool,
  mainnetPoolFor,
} from "@gloamtrade/sdk";
import { checkSpend, loadPolicy, resolveAgent, type Spend } from "../src/policy.js";
import { MCP_MAINNETS, MCP_NETWORKS, NETWORK_KEYS, allNetworks, defaultNetworkKey, networkByChainId, tempoAccessNetwork } from "../src/networks.js";
import { parseFlags } from "../src/cli.js";

const read = (p: string) => readFileSync(p, "utf8");
const NOW = Date.parse("2026-10-21T14:00:00Z");
const PAYEE = "gloamr1.payee-tag-for-tests";

const spend = (over: Partial<Spend>): Spend => ({
  tool: "pay",
  network: "robinhood-mainnet",
  chainId: 4663,
  asset: RH_MAINNET_USDG,
  amountWei: parseUnits("1", 6),
  recipient: PAYEE,
  ...over,
});

test("networks: older testnets always; a mainnet or Base Sepolia only once the SDK has its pool", () => {
  const rhLive = mainnetPoolFor(4663) !== null;
  const tempoLive = mainnetPoolFor(4217) !== null;
  const baseLive = mainnetPoolFor(8453) !== null;
  const ethLive = mainnetPoolFor(1) !== null;
  const baseTestLive = baseSepoliaPool() !== null;
  const sepoliaLive = ethereumSepoliaPool() !== null;
  // Elysium (both networks) is checked in test-elysium.mts; here it only counts.
  const elysiumLive = NETWORK_KEYS.includes("elysium-mainnet");
  const elysiumTestLive = NETWORK_KEYS.includes("elysium");
  assert.equal(MCP_MAINNETS.length, Number(rhLive) + Number(tempoLive) + Number(baseLive) + Number(ethLive) + Number(elysiumLive));
  const firstTest = NETWORK_KEYS.indexOf("robinhood");
  assert.deepEqual(
    NETWORK_KEYS.slice(firstTest),
    ["robinhood", "tempo", ...(baseTestLive ? ["base"] : []), ...(sepoliaLive ? ["ethereum"] : []), ...(elysiumTestLive ? ["elysium"] : [])],
    "testnets last"
  );
  assert.equal(NETWORK_KEYS.includes("robinhood-mainnet"), rhLive);
  assert.equal(NETWORK_KEYS.includes("tempo-mainnet"), tempoLive);
  assert.equal(NETWORK_KEYS.includes("base-mainnet"), baseLive);
  assert.equal(NETWORK_KEYS.includes("base"), baseTestLive);
  assert.equal(NETWORK_KEYS.includes("ethereum-mainnet"), ethLive);
  assert.equal(NETWORK_KEYS.includes("ethereum"), sepoliaLive);
  for (const n of allNetworks()) {
    // Base Sepolia and Ethereum Sepolia run the mainnet pool, so they prove with the final keys too.
    const older = n.family === "robinhood" || n.family === "tempo";
    assert.equal(n.ceremony, n.testnet && older ? "dev" : "production", `${n.key} proves with the right keys`);
    if (!n.testnet) {
      // Elysium opened with USDC only; HYPE joins once its deposit limit lands through the guard.
      assert.equal(n.nativeShield, n.family !== "tempo" && n.family !== "elysium", `${n.key}: native deposits everywhere but Tempo and Elysium`);
      assert.notEqual(n.defaultAsset, "0x0000000000000000000000000000000000000000");
    }
  }
  if (!baseLive) assert.equal(networkByChainId(8453), undefined, "no Base pool, no Base mainnet");
  if (!baseTestLive) assert.equal(networkByChainId(84532), undefined, "no Base Sepolia pool, no Base Sepolia");
  if (!ethLive) assert.equal(networkByChainId(1), undefined, "no Ethereum pool, no Ethereum");
  if (!sepoliaLive) assert.equal(networkByChainId(11155111), undefined, "no Ethereum Sepolia pool, no Ethereum Sepolia");
  assert.equal(MCP_NETWORKS.tempo.chainId, GLOAM_NETWORKS.tempo.chainId);
  if (!rhLive) assert.equal(networkByChainId(4663), undefined, "no pool, no network");
});

test("GLOAM_NETWORK picks the default network, and a missing or wrong one fails loudly", () => {
  assert.equal(defaultNetworkKey({}), "robinhood");
  assert.equal(defaultNetworkKey({ GLOAM_NETWORK: "tempo" }), "tempo");
  assert.throws(() => defaultNetworkKey({ GLOAM_NETWORK: "mainnet" }), /not a Gloam network/);
  if (mainnetPoolFor(4217) === null) {
    assert.throws(() => defaultNetworkKey({ GLOAM_NETWORK: "tempo-mainnet" }), /no tempo-mainnet pool yet/);
  } else {
    assert.equal(defaultNetworkKey({ GLOAM_NETWORK: "tempo-mainnet" }), "tempo-mainnet");
    assert.equal(tempoAccessNetwork({ GLOAM_NETWORK: "tempo-mainnet" }).chainId, 4217);
  }
  assert.equal(tempoAccessNetwork({}).chainId, GLOAM_NETWORKS.tempo.chainId, "access keys default to Tempo testnet");
  if (baseSepoliaPool() === null) assert.throws(() => defaultNetworkKey({ GLOAM_NETWORK: "base" }), /no base pool yet/);
  if (mainnetPoolFor(8453) === null) assert.throws(() => defaultNetworkKey({ GLOAM_NETWORK: "base-mainnet" }), /no base-mainnet pool yet/);
  if (mainnetPoolFor(1) === null) assert.throws(() => defaultNetworkKey({ GLOAM_NETWORK: "ethereum-mainnet" }), /no ethereum-mainnet pool yet/);
  if (ethereumSepoliaPool() === null) assert.throws(() => defaultNetworkKey({ GLOAM_NETWORK: "ethereum" }), /no ethereum pool yet/);
});

test("mainnet proofs use the final keys, kept apart from the dev keys", () => {
  const dev = circuitArtifactFiles("transfer", "dev");
  const fin = circuitArtifactFiles("transfer", "production");
  assert.equal(dev.zkey, "transfer_final.zkey");
  assert.equal(fin.zkey, "final/transfer_final.zkey");
  assert.equal(dev.wasm, fin.wasm, "one wasm for both key sets");
  assert.notEqual(dev.sha256.zkey, fin.sha256.zkey);
});

test("a testnet limits config never approves mainnet assets by itself", () => {
  // "USDG" alone is the testnet USDG.
  const testnetOnly = resolveAgent("bot", { recipients: "any", maxPerPayment: "5", maxPerDay: "10", assets: ["USDG"] }, "test");
  assert.equal(testnetOnly.assets[0]!.address, RH_USDG);
  assert.equal(testnetOnly.assets[0]!.chainId, GLOAM_NETWORKS.robinhood.chainId);
  const r = checkSpend(testnetOnly, spend({}), [], NOW);
  assert.equal(r?.code, "asset_not_allowed");
  assert.match(r!.message, /USDG on Robinhood Chain is not one of this agent's assets/);
  // pathUSD shares its address on both Tempo networks: an address alone means the testnet too.
  const byAddress = resolveAgent("bot", { recipients: "any", maxPerPayment: "5", maxPerDay: "10", assets: [TEMPO_PATHUSD] }, "test");
  assert.equal(byAddress.assets[0]!.chainId, GLOAM_NETWORKS.tempo.chainId);
  assert.equal(checkSpend(byAddress, spend({ network: "tempo-mainnet", chainId: 4217, asset: TEMPO_PATHUSD }), [], NOW)?.code, "asset_not_allowed");
});

test("Robinhood Chain mainnet's newer assets: their symbols name them, and ETH still needs the network named", () => {
  const p = resolveAgent(
    "bot",
    {
      recipients: [PAYEE],
      assets: {
        PONS: { maxPerPayment: "5", maxPerDay: "10" },
        CASHCAT: { maxPerPayment: "5", maxPerDay: "10" },
        AI: { maxPerPayment: "5", maxPerDay: "10" },
        ORBIO: { maxPerPayment: "5", maxPerDay: "10" },
        ETH: { network: "robinhood-mainnet", maxPerPayment: "1", maxPerDay: "2" },
      },
    },
    "test"
  );
  assert.deepEqual(p.assets.map((a) => [a.symbol, a.chainId, a.decimals]), [
    ["PONS", 4663, 18],
    ["CASHCAT", 4663, 18],
    ["AI", 4663, 18],
    ["ORBIO", 4663, 18],
    ["ETH", 4663, 18],
  ]);
  const bare = resolveAgent("bot", { recipients: [PAYEE], assets: { ETH: { maxPerPayment: "1", maxPerDay: "2" } } }, "test");
  assert.equal(bare.assets[0]!.chainId, GLOAM_NETWORKS.robinhood.chainId, "a bare ETH stays the testnet's");
});

test("naming a mainnet network in limits allows exactly that asset there", () => {
  const p = resolveAgent(
    "bot",
    {
      recipients: [PAYEE],
      assets: {
        USDG: { network: "robinhood-mainnet", maxPerPayment: "5", maxPerDay: "10" },
        pathUSD: { network: "tempo-mainnet", maxPerPayment: "2", maxPerDay: "4" },
        "USDC.e": { maxPerPayment: "3", maxPerDay: "6" },
        GLOAM: { maxPerPayment: "100", maxPerDay: "100" },
      },
    },
    "test"
  );
  const [usdg, path, usdce, gloam] = p.assets;
  assert.deepEqual([usdg!.address, usdg!.chainId, usdg!.decimals], [RH_MAINNET_USDG, 4663, 6]);
  assert.deepEqual([path!.address, path!.chainId], [TEMPO_PATHUSD, 4217]);
  assert.deepEqual([usdce!.address, usdce!.chainId], [TEMPO_USDCE, 4217], "USDC.e is mainnet only");
  assert.deepEqual([gloam!.address, gloam!.chainId, gloam!.decimals], [GLOAM_TOKEN, 4663, 18]);
  assert.equal(checkSpend(p, spend({}), [], NOW), null);
  assert.equal(checkSpend(p, spend({ amountWei: parseUnits("6", 6) }), [], NOW)?.code, "over_per_payment");
  // The mainnet entry does not open the testnet asset of the same name.
  assert.equal(checkSpend(p, spend({ network: "robinhood", chainId: GLOAM_NETWORKS.robinhood.chainId, asset: RH_USDG }), [], NOW)?.code, "asset_not_allowed");
  assert.equal(checkSpend(p, spend({ network: "tempo", chainId: GLOAM_NETWORKS.tempo.chainId, asset: TEMPO_PATHUSD }), [], NOW)?.code, "asset_not_allowed");
});

test("Base in limits: a symbol on both sides is the testnet; base-mainnet names the mainnet asset", () => {
  // USDC, EURC and ETH are on both Base networks: alone they are the testnet ones (ETH alone stays Robinhood Chain testnet).
  const caps = { maxPerPayment: "5", maxPerDay: "10" };
  const plain = resolveAgent("bot", { recipients: "any", assets: { USDC: caps, EURC: caps, ETH: caps, [NATIVE_ASSET]: caps } }, "test");
  assert.deepEqual(
    plain.assets.map((a) => [a.address, a.chainId]),
    [
      [BASE_SEPOLIA_USDC, 84532],
      [BASE_SEPOLIA_EURC, 84532],
      [NATIVE_ASSET, GLOAM_NETWORKS.robinhood.chainId],
      [NATIVE_ASSET, GLOAM_NETWORKS.robinhood.chainId],
    ]
  );
  assert.equal(checkSpend(plain, spend({ network: "base-mainnet", chainId: 8453, asset: BASE_USDC }), [], NOW)?.code, "asset_not_allowed");
  assert.equal(checkSpend(plain, spend({ network: "base-mainnet", chainId: 8453, asset: NATIVE_ASSET, amountWei: 1n }), [], NOW)?.code, "asset_not_allowed");
  assert.equal(checkSpend(plain, spend({ network: "base", chainId: 84532, asset: BASE_SEPOLIA_USDC }), [], NOW), null);

  const real = resolveAgent(
    "bot",
    {
      recipients: [PAYEE],
      assets: {
        USDC: { network: "base-mainnet", maxPerPayment: "5", maxPerDay: "10" },
        ETH: { network: "base-mainnet", maxPerPayment: "0.01", maxPerDay: "0.05" },
        USDT: { maxPerPayment: "3", maxPerDay: "6" },
      },
    },
    "test"
  );
  const [usdc, eth, usdt] = real.assets;
  assert.deepEqual([usdc!.address, usdc!.chainId, usdc!.decimals], [BASE_USDC, 8453, 6]);
  assert.deepEqual([eth!.address, eth!.chainId, eth!.decimals], [NATIVE_ASSET, 8453, 18]);
  assert.deepEqual([usdt!.address, usdt!.chainId], [BASE_USDT, 8453], "USDT is Base mainnet only");
  const ethSpend = (wei: bigint) => spend({ network: "base-mainnet", chainId: 8453, asset: NATIVE_ASSET, amountWei: wei });
  assert.equal(checkSpend(real, ethSpend(parseUnits("0.01", 18)), [], NOW), null);
  assert.equal(checkSpend(real, ethSpend(parseUnits("0.02", 18)), [], NOW)?.code, "over_per_payment");
  // The Base mainnet ETH entry does not open ETH on Robinhood Chain testnet or Base Sepolia.
  assert.equal(checkSpend(real, spend({ network: "base", chainId: 84532, asset: NATIVE_ASSET, amountWei: 1n }), [], NOW)?.code, "asset_not_allowed");

  const read2 = (p: string) => readFileSync(p, "utf8");
  const env = { GLOAM_LIMIT_MAX_PER_PAYMENT: "5", GLOAM_LIMIT_MAX_PER_DAY: "10", GLOAM_LIMIT_RECIPIENTS: "any" };
  const inline = loadPolicy({ ...env, GLOAM_LIMIT_ASSETS: "USDC,EURC,USDT", GLOAM_LIMIT_NETWORK: "base-mainnet" }, read2);
  assert.equal(inline.mode, "enforced");
  if (inline.mode === "enforced") assert.deepEqual(inline.policy.assets.map((a) => a.chainId), [8453, 8453, 8453]);
  // There is no USDT on Base Sepolia, so naming it there fails closed.
  assert.equal(loadPolicy({ ...env, GLOAM_LIMIT_ASSETS: "USDT", GLOAM_LIMIT_NETWORK: "base" }, read2).mode, "invalid");
});

test("GLOAM_LIMIT_NETWORK names the network of inline limits", () => {
  const dir = mkdtempSync(join(tmpdir(), "gloam-mainnet-"));
  writeFileSync(join(dir, "x"), "");
  const base = { GLOAM_LIMIT_ASSETS: "pathUSD,USDC.e", GLOAM_LIMIT_MAX_PER_PAYMENT: "5", GLOAM_LIMIT_MAX_PER_DAY: "10", GLOAM_LIMIT_RECIPIENTS: "any" };
  const mainnet = loadPolicy({ ...base, GLOAM_LIMIT_NETWORK: "tempo-mainnet" }, read);
  assert.equal(mainnet.mode, "enforced");
  if (mainnet.mode === "enforced") assert.deepEqual(mainnet.policy.assets.map((a) => a.chainId), [4217, 4217]);
  const bad = loadPolicy({ ...base, GLOAM_LIMIT_NETWORK: "mainnet" }, read);
  assert.equal(bad.mode, "invalid");
  // USDC.e does not exist on the testnet, so naming the testnet for it fails closed.
  const wrong = loadPolicy({ ...base, GLOAM_LIMIT_NETWORK: "tempo" }, read);
  assert.equal(wrong.mode, "invalid");
});

test("authorize-access-key takes --network", () => {
  assert.equal(parseFlags(["--network", "tempo-mainnet", "--owner", "0x1"]).network, "tempo-mainnet");
  assert.equal(parseFlags(["--network=tempo"]).network, "tempo");
});

test("one agent-wide cap never covers ETH and dollars together: 50 would have meant 50 ETH", () => {
  const ownUnits = /count in each asset's own units/;
  // The inline form has only the agent-wide numbers: USDC, EURC and ETH on Base mainnet are refused.
  const inline = loadPolicy(
    {
      GLOAM_LIMIT_ASSETS: "USDC,EURC,ETH",
      GLOAM_LIMIT_NETWORK: "base-mainnet",
      GLOAM_LIMIT_MAX_PER_PAYMENT: "50",
      GLOAM_LIMIT_MAX_PER_DAY: "200",
      GLOAM_LIMIT_RECIPIENTS: "any",
    },
    read
  );
  assert.equal(inline.mode, "invalid");
  if (inline.mode === "invalid") assert.match(inline.error, ownUnits);
  // In a file too, wherever the agent-wide numbers reach more than one kind of asset.
  const bad: unknown[] = [
    { recipients: "any", maxPerPayment: "50", maxPerDay: "200", assets: ["USDG", "GLOAM"] },
    { recipients: "any", maxPerPayment: "50", maxPerDay: "200", assets: { USDC: { network: "base-mainnet" }, ETH: { network: "base-mainnet" } } },
    // ETH and GLOAM are different assets too
    { recipients: "any", maxPerPayment: "50", maxPerDay: "200", assets: { ETH: {}, GLOAM: {} } },
    // one cap of its own is not enough: the other still comes from the agent
    { recipients: "any", maxPerPayment: "50", maxPerDay: "200", assets: { USDC: { network: "base-mainnet" }, ETH: { network: "base-mainnet", maxPerPayment: "0.01" } } },
  ];
  for (const cfg of bad) assert.throws(() => resolveAgent("bot", cfg as never, "test"), ownUnits, JSON.stringify(cfg));
  // Stablecoins share one number; ETH with caps of its own sits beside them.
  const ok = resolveAgent(
    "bot",
    {
      recipients: "any",
      maxPerPayment: "50",
      maxPerDay: "200",
      assets: {
        USDC: { network: "base-mainnet" },
        USDT: {},
        ETH: { network: "base-mainnet", maxPerPayment: "0.01", maxPerDay: "0.05" },
      },
    },
    "test"
  );
  const eth = ok.assets.find((a) => a.symbol === "ETH")!;
  assert.equal(eth.maxPerPayment, parseUnits("0.01", 18));
  assert.equal(eth.maxPerDay, parseUnits("0.05", 18));
  assert.equal(ok.assets.find((a) => a.symbol === "USDT")!.maxPerPayment, parseUnits("50", 6));
  const ethSpend = (wei: bigint): Spend => ({ tool: "pay", network: "base-mainnet", chainId: 8453, asset: NATIVE_ASSET, amountWei: wei, recipient: PAYEE });
  assert.equal(checkSpend(ok, ethSpend(parseUnits("49", 18)), [], NOW)?.code, "over_per_payment");
  // A single asset, the stablecoins together (EURC too: counted, never priced), and the README's
  // two dollar stablecoins still take the agent-wide caps.
  assert.doesNotThrow(() => resolveAgent("bot", { recipients: "any", maxPerPayment: "5", maxPerDay: "10", assets: { USDC: { network: "base-mainnet" }, EURC: { network: "base-mainnet" } } }, "test"));
  // every listed stablecoin counts alike, PYUSD on Ethereum too (KnownAsset.stable), while ETH next to USDG does not
  assert.doesNotThrow(() => resolveAgent("bot", { recipients: "any", maxPerPayment: "5", maxPerDay: "10", assets: { USDC: { network: "ethereum-mainnet" }, PYUSD: { network: "ethereum-mainnet" } } }, "test"));
  assert.throws(() => resolveAgent("bot", { recipients: "any", maxPerPayment: "5", maxPerDay: "10", assets: ["ETH", "USDG"] }, "test"), ownUnits);
  assert.doesNotThrow(() => resolveAgent("bot", { recipients: "any", maxPerPayment: "0.1", maxPerDay: "1", assets: ["ETH"] }, "test"));
  assert.doesNotThrow(() =>
    resolveAgent("bot", { recipients: "any", maxPerPayment: "250", maxPerDay: "1000", assets: { USDG: { network: "robinhood-mainnet" }, USDT0: {} } }, "test")
  );
});
