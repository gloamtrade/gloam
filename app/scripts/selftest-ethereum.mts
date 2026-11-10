/**
 * Self-test: Ethereum mainnet (1) in the app.
 *
 * Two runs of this file:
 *
 *  - as committed (MAINNET_POOLS[1] empty): Ethereum is no Gloam network. Not
 *    a network key, not in the API's choices, not served by the relay or the
 *    remote MCP, and Glim says nothing about it. It stays a bridge origin, and
 *    its proofs would still use the final keys.
 *  - with a placeholder pool put into MAINNET_POOLS[1] before anything else
 *    loads (a child process of this one): Ethereum shows up with the mainnets,
 *    with its chain, keys, assets and limits; the relay serves chain 1; the
 *    bridge into it and swaps stay off, and so does the payment-memo board
 *    until the real deploy fills it in next to the vault; claim codes
 *    from another network are refused; and Glim and the remote MCP name
 *    Ethereum, its gas ceiling, and never count it in the 21 October launch.
 *
 * Once MAINNET_POOLS[1] holds the real vault (after the deploy), the run as
 * committed is the configured one, against that vault, so switching Ethereum
 * on needs no edit here.
 *
 * The placeholder pool is not a contract; nothing reaches any host (fetch
 * fails the run if anything tries).
 *
 * Run from app/:  ../mcp/node_modules/.bin/tsx scripts/selftest-ethereum.mts
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

/** What the MPP guide pins: the SDK package's own version, read from its package.json (never a copy here that goes stale). */
const SDK_PIN = new RegExp(`@gloamtrade/sdk@\\^${(JSON.parse(readFileSync(new URL("../../packages/sdk/package.json", import.meta.url), "utf8")) as { version: string }).version.replace(/\./g, "\\.")}`);

delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;
delete process.env.CHAINALYSIS_API_KEY;
delete process.env.GLOAM_RELAY_MAX_GAS_GWEI_1;
globalThis.fetch = (async (url: unknown) => {
  throw new Error(`selftest-ethereum: no network calls allowed (${String(url)})`);
}) as typeof fetch;

const mainnet = await import("../src/lib/mainnet");
/** Elysium mainnet, while NEXT_PUBLIC_ELYSIUM_ENABLED is on (as production builds it): named last, after Ethereum. */
const { ELYSIUM } = await import("../src/lib/elysium");
/** The real vault, once MAINNET_POOLS[1] is filled in after the deploy. */
const LIVE = mainnet.mainnetPool(1);
const CONFIGURED = process.env.GLOAM_SELFTEST_ETHEREUM === "configured" || LIVE !== null;
const POOL = LIVE?.pool ?? "0x00000000000000000000000000000000000e7e01";
const DEPLOY_BLOCK = LIVE?.deployBlock ?? 23_000_000n;
if (CONFIGURED && !LIVE) {
  // Filled in the way DEPLOY-ETHEREUM.md says, before networks.ts reads it.
  mainnet.MAINNET_POOLS[1] = { pool: POOL, deployBlock: DEPLOY_BLOCK };
}

const nets = await import("../src/lib/networks");
const tokens = await import("../src/lib/tokens");
const { bridgeVisible, bridgeChain, BRIDGE_DESTINATIONS } = await import("../src/lib/bridge");
const { ORIGIN_CHAINS } = await import("../src/lib/originChains");
const { VAULT_SWAP_V3_ADDRESS, swapV3Live, vaultSwapRouter } = await import("../src/lib/vaultSwap");
const { faucetFor } = await import("../src/lib/faucet");
const { requestAssetsFor, claimNetworkProblem } = await import("../src/lib/paymentRequest");
const { walkTuning } = await import("../src/lib/leafIndex");
const { gasFor, TRANSFER_GAS_LIMIT } = await import("../src/lib/shield");
const { relayNetworks, networkForChain } = await import("../src/lib/relay/server");
const { maxGasPriceWei } = await import("../src/lib/relay/gasCeiling");
const { knowledgeBlock } = await import("../src/lib/telegramBot/knowledge");
const { chainFix } = await import("../src/lib/telegramBot/rules");
const { callTool } = await import("../src/lib/mcpRemote/tools");

let checks = 0;
function check(name: string, fn: () => void) {
  fn();
  checks++;
  void name;
}
async function checkAsync(name: string, fn: () => Promise<void>) {
  await fn();
  checks++;
  void name;
}

const ctx = { origin: "https://www.gloam.trade", ip: "127.0.0.1" };
async function toolJson(name: string, args: Record<string, unknown> = {}) {
  const r = await callTool(name, args, ctx);
  const first = r.content[0] as { type: string; text: string };
  return { isError: Boolean(r.isError), text: first.text };
}

const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const USDT = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
const USDG = "0xe343167631d89B6Ffc58B88d6b7fB0228795491D";
const PYUSD = "0x6c3ea9036406852006290770BEdFcAbA0e23A0e8";
const BDX = "0x6ad12E761b438beA3EA09F6C6266556Bb24C2181";
const EURC = "0x1aBaEA1f7C830bD89Acc67eC4af516284b1bC33c";

// ---------------------------------------------------------------- both runs

check("the Ethereum entry is always defined, on the mainnet pool and final keys", () => {
  const n = nets.getNetwork("ethereum-mainnet");
  assert.equal(n.family, "ethereum");
  assert.equal(n.label, "Ethereum");
  assert.equal(n.chainId, 1);
  assert.equal(n.testnet, false);
  assert.equal(n.chain.testnet, undefined);
  assert.equal(n.paymentsPool, true);
  assert.equal(n.ceremony, "production");
  assert.equal(n.stocks, false);
  assert.equal(n.primaryAsset.symbol, "ETH");
  assert.equal(n.logRange, 10_000n);
  // The memo board comes in with the real vault (ethereum-mainnet-after-deploy.sh writes both).
  if (LIVE) {
    assert.match(n.payMemo?.address ?? "", /^0x[0-9a-fA-F]{40}$/);
    assert.ok(n.payMemo!.deployBlock >= LIVE.deployBlock, "the board is deployed after the vault");
    assert.equal(n.payMemo!.emitsPoster, false);
  } else {
    assert.equal(n.payMemo, null);
  }
  assert.equal(new URL(n.chain.rpcUrls.default.http[0]!).host, "rpc.mevblocker.io");
  assert.equal(n.explorerTx("0xab"), "https://etherscan.io/tx/0xab");
  assert.equal(n.explorerAddress("0xcd"), "https://etherscan.io/address/0xcd");
  assert.doesNotMatch(n.note, /real money|play money/);
  // Ethereum proofs are never checked against the dev keys, pool or not.
  assert.equal(nets.ceremonyForChain(1), "production");
});

check("Ethereum assets as checked on chain, EURC never a dollar, USDT approvals reset first", () => {
  const list = tokens.shieldTokensFor(1);
  assert.deepEqual(
    list.map((t) => [t.symbol, t.address, t.decimals]),
    [
      ["USDC", USDC, 6],
      ["USDT", USDT, 6],
      ["USDG", USDG, 6],
      ["PYUSD", PYUSD, 6],
      ["EURC", EURC, 6],
      ["BDX", BDX, 9],
    ]
  );
  assert.equal(tokens.supportsNativeShield(1), true);
  for (const t of list) {
    assert.equal(tokens.isDollarStable(t), t.symbol !== "EURC" && t.symbol !== "BDX", t.symbol);
    assert.equal(Boolean(t.approveResetFirst), t.symbol === "USDT", t.symbol);
  }
  const usdt = list.find((t) => t.symbol === "USDT")!;
  const usdc = list.find((t) => t.symbol === "USDC")!;
  assert.deepEqual(tokens.approvalSteps(usdt, 0n, 100n), [100n]);
  assert.deepEqual(tokens.approvalSteps(usdt, 30n, 100n), [0n, 100n], "a stale USDT allowance goes to 0 first");
  assert.deepEqual(tokens.approvalSteps(usdt, 100n, 100n), []);
  assert.deepEqual(tokens.approvalSteps(usdc, 30n, 100n), [100n], "USDC changes its allowance in one step");
  // Naming an Ethereum asset by address, on its own chain first.
  assert.equal(tokens.knownTokens(1)[0]!.symbol, "USDC");
});

check("a bridge origin and a bridge into Ethereum (USDC), no swaps", () => {
  assert.equal(BRIDGE_DESTINATIONS.ethereum?.chainId, 1);
  assert.equal(BRIDGE_DESTINATIONS.ethereum?.token.address.toLowerCase(), "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48");
  assert.equal(bridgeVisible(nets.getNetwork("ethereum-mainnet")), true);
  assert.equal(bridgeVisible(nets.getNetwork("ethereum")), false, "Relay only delivers to mainnets");
  const origin = bridgeChain(1);
  assert.ok(origin, "Ethereum stays a chain money can be brought over from");
  assert.deepEqual(origin.tokens.map((t) => t.symbol), ["USDC", "USDT", "USDG", "PYUSD", "ETH"]);
  assert.ok(ORIGIN_CHAINS.some((c) => c.id === 1));
  assert.equal(vaultSwapRouter(1), swapV3Live(1) ? VAULT_SWAP_V3_ADDRESS[1] : null);
  assert.equal(faucetFor("ethereum-mainnet"), null);
});

check("Ethereum reads: 10,000-block spans, the wallet estimates gas, the relay's ceiling is 3 gwei", () => {
  assert.equal(walkTuning(1, 10_000n).span, 10_000n);
  assert.equal(walkTuning(1, 10_000n).parallel, 3);
  assert.equal(gasFor(1, TRANSFER_GAS_LIMIT), undefined);
  assert.equal(maxGasPriceWei(1, {}), 3_000_000_000n);
});

// ---------------------------------------------------------------- before the pool is in

if (!CONFIGURED) {
  check("unconfigured: Ethereum is no network key anywhere", () => {
    assert.equal(nets.isNetworkKey("ethereum-mainnet"), false);
    // Ethereum Sepolia ("ethereum", 11155111) is its own network: selftest-ethereum-sepolia.mts.
    assert.ok(!nets.NETWORK_KEYS.some((k) => nets.getNetwork(k).chainId === 1));
    assert.ok(!nets.allNetworks().some((n) => n.chainId === 1));
    assert.doesNotMatch(nets.networkKeyChoices(), /ethereum-mainnet/);
    assert.equal(nets.getNetwork("ethereum-mainnet").pool, null);
    assert.equal(nets.isNetworkWritable(nets.getNetwork("ethereum-mainnet")), false);
    assert.equal(mainnet.mainnetPool(1), null);
    assert.doesNotMatch(mainnet.liveMainnetNames(), /Ethereum/);
  });

  check("unconfigured: the relay refuses chain 1", () => {
    assert.ok(!relayNetworks().some((n) => n.chainId === 1));
    assert.throws(() => networkForChain(1), /not supported by the relay/);
    assert.throws(() => networkForChain("1"), /not supported by the relay/);
  });

  check("unconfigured: Glim says nothing about Ethereum as a Gloam network", () => {
    const k = knowledgeBlock();
    // "ETHEREUM SEPOLIA" is the testnet's own section (selftest-ethereum-sepolia.mts)
    assert.doesNotMatch(k, /\nETHEREUM \(|Ethereum mainnet \(chain ID 1\)|Ethereum gas is high/);
  });

  await checkAsync("unconfigured: the remote MCP neither lists nor takes Ethereum", async () => {
    const all = await toolJson("gloam_networks");
    assert.doesNotMatch(all.text, /"ethereum-mainnet"/);
    const one = await toolJson("gloam_networks", { network: "ethereum-mainnet" });
    assert.equal(one.isError, true);
    const info = await toolJson("gloam_info");
    assert.doesNotMatch(info.text, /Ethereum \(1\)/);
  });

  // The same file again, with the Ethereum pool filled in.
  const child = spawnSync(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url)], {
    env: { ...process.env, GLOAM_SELFTEST_ETHEREUM: "configured" },
    encoding: "utf8",
  });
  process.stdout.write(child.stdout);
  process.stderr.write(child.stderr);
  assert.equal(child.status, 0, "the configured run failed");
  console.log(`selftest-ethereum (unconfigured): ${checks} checks passed`);
}

// ---------------------------------------------------------------- with the pool filled in

if (CONFIGURED) {
  check("configured: Ethereum is in, with the mainnets", () => {
    const keys = nets.NETWORK_KEYS;
    assert.ok(keys.includes("ethereum-mainnet"));
    assert.ok(keys.indexOf("ethereum-mainnet") > keys.indexOf("tempo-mainnet"));
    assert.ok(keys.indexOf("ethereum-mainnet") < keys.indexOf("robinhood"));
    assert.equal(nets.isNetworkKey("ethereum-mainnet"), true);
    assert.match(nets.networkKeyChoices(), /"ethereum-mainnet"/);
    const n = nets.getNetwork("ethereum-mainnet");
    assert.equal(n.pool, POOL);
    assert.equal(n.deployBlock, DEPLOY_BLOCK);
    assert.equal(nets.isNetworkWritable(n), true);
    assert.equal(nets.networkName(n), "Ethereum");
    assert.match(mainnet.liveMainnetNames(), ELYSIUM ? /^Robinhood Chain, Tempo(, Base)?, Ethereum and Elysium$/ : /^Robinhood Chain, Tempo(, Base)? and Ethereum$/);
    assert.ok(mainnet.mainnetChainPool(1));
  });

  check("configured: the relay serves chain 1 with the same relay key", () => {
    assert.ok(relayNetworks().some((n) => n.chainId === 1));
    assert.equal(networkForChain(1).key, "ethereum-mainnet");
    assert.equal(networkForChain("1").key, "ethereum-mainnet");
  });

  check("configured: payment requests and claim codes on Ethereum", () => {
    const assets = requestAssetsFor("ethereum-mainnet");
    assert.deepEqual(
      assets.map((a) => a.symbol),
      ["USDC", "USDT", "USDG", "PYUSD", "EURC", "ETH", "BDX"]
    );
    assert.ok(assets.find((a) => a.symbol === "ETH")!.native);
    // A Base mainnet USDC code opened on Ethereum (same vault address) is refused.
    const net = { key: "ethereum-mainnet" as const, pool: POOL };
    assert.match(claimNetworkProblem(net, { pool: POOL, asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" }) ?? "", /different network/);
    // And Robinhood Chain mainnet's USDG, a different address from Ethereum's.
    assert.match(claimNetworkProblem(net, { pool: POOL, asset: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" }) ?? "", /different network/);
    assert.equal(claimNetworkProblem(net, { pool: POOL, asset: USDT }), null);
    assert.equal(claimNetworkProblem(net, { pool: POOL, asset: PYUSD.toLowerCase() }), null);
  });

  check("configured: Glim knows Ethereum and its gas ceiling, never as part of the 21 October launch", () => {
    const k = knowledgeBlock();
    assert.match(k, /Ethereum mainnet \(chain ID 1\)/);
    assert.match(k, /USDC, USDT, USDG, PYUSD, EURC and ETH/);
    assert.match(k, /Ethereum gas is high right now; try again shortly/);
    assert.match(k, /https:\/\/etherscan\.io/);
    assert.match(k, /went live on mainnet on Wednesday 21 October 2026 at 13:00 UTC, on Robinhood Chain and Tempo\. (Base and )?Ethereum mainnet joined after that/);
    assert.doesNotMatch(k, /21 October[^.\n]*Tempo and Ethereum/);
    const section = k.slice(k.indexOf("\nETHEREUM ("), k.indexOf("\n\n", k.indexOf("\nETHEREUM (") + 1));
    assert.ok(section.length > 200);
    assert.doesNotMatch(section, /\u2014|real money|play money|happy to/);
    const fix = chainFix("Ada", { wallet: 4663, want: 1 });
    assert.match(fix, /Switch to Ethereum/);
  });

  await checkAsync("configured: the remote MCP lists Ethereum with its gas ceiling and SDK 0.4.0 snippets", async () => {
    const one = await toolJson("gloam_networks", { network: "ethereum-mainnet" });
    assert.equal(one.isError, false);
    assert.match(one.text, /"chainId": 1,/);
    assert.match(one.text, /"symbol": "PYUSD"/);
    assert.match(one.text, /"relayMaxGasGwei": "3"/);
    const mpp = await toolJson("gloam_mpp_how_to", { network: "ethereum-mainnet" });
    assert.equal(mpp.isError, false);
    assert.match(mpp.text, /mainnetNetwork\(\\"ethereum\\"\)/);
    assert.match(mpp.text, /ETHEREUM_USDC/);
    assert.match(mpp.text, SDK_PIN, "the SDK version the guide installs is the SDK's own");
    assert.doesNotMatch(mpp.text, /GLOAM_NETWORKS\.ethereum/);
    const info = await toolJson("gloam_info");
    assert.match(info.text, /Ethereum \(1\)/);
    assert.match(info.text, /gas is over its ceiling \(3 gwei\)/);
  });

  console.log(`selftest-ethereum (configured): ${checks} checks passed`);
}
