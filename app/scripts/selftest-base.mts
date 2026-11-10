/**
 * Self-test: Base Sepolia (84532) and Base mainnet (8453) in the app.
 *
 * Two runs of this file:
 *
 *  - as committed: Base Sepolia is live (deployed 24 Oct 2026, pool and memo
 *    board filled in) and Base mainnet is not. Base Sepolia is a network key
 *    the relay serves, the remote MCP lists and Glim knows, with its vault,
 *    block and memo board; Base mainnet exists nowhere yet. Both prove with
 *    the final keys.
 *  - with a placeholder pool put into MAINNET_POOLS[8453] before anything else
 *    loads (a child process of this one): both networks show up in the right
 *    order with the right chain, keys, assets and limits; the relay serves both
 *    chain ids; the bridge and swaps stay off; claim codes from the other Base
 *    network are refused; and Glim and the remote MCP name Base without ever
 *    counting it in the 21 October launch.
 *
 * Once MAINNET_POOLS[8453] holds the real vault (base-mainnet-after-deploy.sh
 * fills it in, with the memo board next to it), the run as committed is the
 * configured one, against that vault and board, so switching Base mainnet on
 * needs no edit here.
 *
 * The placeholder pool is not a contract; nothing reaches any host (fetch
 * fails the run if anything tries).
 *
 * Run from app/:  ../mcp/node_modules/.bin/tsx scripts/selftest-base.mts
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
globalThis.fetch = (async (url: unknown) => {
  throw new Error(`selftest-base: no network calls allowed (${String(url)})`);
}) as typeof fetch;

/** Base Sepolia as deployed (contracts/deployments/base-sepolia.json). */
const SEPOLIA_POOL = "0x39e28cde55cab798874746ac52cb4b5cc99a0194";
const SEPOLIA_MEMO = "0x01B3172d9900Cb26d57E986429b9b23854c74598";

const mainnet = await import("../src/lib/mainnet");
/** Elysium mainnet, while NEXT_PUBLIC_ELYSIUM_ENABLED is on (as production builds it): named last, after Base and Ethereum. */
const { ELYSIUM } = await import("../src/lib/elysium");
/** Base mainnet's real vault, once MAINNET_POOLS[8453] is filled in after the deploy. */
const LIVE = mainnet.mainnetPool(8453);
const CONFIGURED = process.env.GLOAM_SELFTEST_BASE === "configured" || LIVE !== null;
const MAINNET_POOL = LIVE?.pool ?? "0x00000000000000000000000000000000000BA5E2";
const MAINNET_BLOCK = LIVE?.deployBlock ?? 2_000_000n;
if (CONFIGURED && !LIVE) {
  // Filled in the way DEPLOY-BASE.md says, before networks.ts reads it.
  mainnet.MAINNET_POOLS[8453] = { pool: MAINNET_POOL, deployBlock: MAINNET_BLOCK };
}

const nets = await import("../src/lib/networks");
const tokens = await import("../src/lib/tokens");
const { bridgeVisible, BRIDGE_DESTINATIONS } = await import("../src/lib/bridge");
const { VAULT_SWAP_V3_ADDRESS, swapV3Live, vaultSwapRouter } = await import("../src/lib/vaultSwap");
const { faucetFor } = await import("../src/lib/faucet");
const { requestAssetsFor, claimNetworkProblem } = await import("../src/lib/paymentRequest");
const { walkTuning } = await import("../src/lib/leafIndex");
const { gasFor, TRANSFER_GAS_LIMIT } = await import("../src/lib/shield");
const { relayNetworks, networkForChain } = await import("../src/lib/relay/server");
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

// ---------------------------------------------------------------- both runs

check("Base entries are always defined, on the mainnet pool and final keys", () => {
  for (const key of ["base", "base-mainnet"] as const) {
    const n = nets.getNetwork(key);
    assert.equal(n.family, "base");
    assert.equal(n.label, "Base");
    assert.equal(n.paymentsPool, true);
    assert.equal(n.ceremony, "production");
    assert.equal(n.stocks, false);
    assert.equal(n.primaryAsset.symbol, "ETH");
    assert.equal(n.logRange, 50_000n);
    assert.match(n.chain.rpcUrls.default.http[0]!, /publicnode\.com$/);
  }
  assert.equal(nets.getNetwork("base").chainId, 84532);
  assert.equal(nets.getNetwork("base").testnet, true);
  assert.equal(nets.getNetwork("base").chain.testnet, true);
  assert.equal(nets.getNetwork("base-mainnet").chainId, 8453);
  assert.equal(nets.getNetwork("base-mainnet").testnet, false);
  assert.equal(nets.getNetwork("base").explorerTx("0xab"), "https://sepolia.basescan.org/tx/0xab");
  assert.equal(nets.getNetwork("base-mainnet").explorerAddress("0xcd"), "https://basescan.org/address/0xcd");
  // Proofs for Base are never checked against the dev keys, pool or not.
  assert.equal(nets.ceremonyForChain(84532), "production");
  assert.equal(nets.ceremonyForChain(8453), "production");
  // The older testnets keep theirs.
  assert.equal(nets.ceremonyForChain(42431), "dev");
  assert.equal(nets.getNetwork("tempo").paymentsPool, false);
  assert.equal(nets.getNetwork("tempo-mainnet").paymentsPool, true);
});

check("Base assets as checked on chain, with EURC never counted as a dollar", () => {
  const sepolia = tokens.shieldTokensFor(84532);
  assert.deepEqual(
    sepolia.map((t) => [t.symbol, t.address, t.decimals]),
    [
      ["USDC", "0x036CbD53842c5426634e7929541eC2318f3dCF7e", 6],
      ["EURC", "0x808456652fdb597867f38412077A9182bf77359F", 6],
    ]
  );
  const main = tokens.shieldTokensFor(8453);
  assert.deepEqual(
    main.map((t) => [t.symbol, t.address, t.decimals]),
    [
      ["USDC", "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", 6],
      ["EURC", "0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42", 6],
      ["USDT", "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2", 6],
      ["BDX", "0x6ad12E761b438beA3EA09F6C6266556Bb24C2181", 9],
    ]
  );
  assert.equal(tokens.supportsNativeShield(84532), true);
  assert.equal(tokens.supportsNativeShield(8453), true);
  assert.equal(tokens.supportsNativeShield(4217), false);
  for (const t of [...sepolia, ...main]) {
    assert.equal(tokens.isDollarStable(t), t.symbol !== "EURC" && t.symbol !== "BDX", t.symbol);
  }
  // Naming a Base asset by address, on its own chain first.
  assert.equal(tokens.knownTokens(8453)[0]!.symbol, "USDC");
});

check("The testnet bar offers Base Sepolia only Base mainnet, never another chain's", () => {
  assert.equal(nets.mainnetOf(nets.getNetwork("robinhood"))?.key, "robinhood-mainnet");
  assert.equal(nets.mainnetOf(nets.getNetwork("tempo"))?.key, "tempo-mainnet");
  assert.equal(nets.mainnetOf(nets.getNetwork("base"))?.key ?? null, CONFIGURED ? "base-mainnet" : null);
});

check("a bridge into Base (USDC) on mainnet, and swaps only once v3 is on", () => {
  assert.equal(BRIDGE_DESTINATIONS.base?.chainId, 8453);
  assert.equal(BRIDGE_DESTINATIONS.base?.token.address.toLowerCase(), "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913");
  assert.equal(bridgeVisible(nets.getNetwork("base-mainnet")), true);
  assert.equal(bridgeVisible(nets.getNetwork("base")), false);
  assert.equal(vaultSwapRouter(8453), swapV3Live(8453) ? VAULT_SWAP_V3_ADDRESS[8453] : null);
  assert.equal(vaultSwapRouter(84532), null);
});

check("Base reads: 50,000-block spans, and the wallet estimates gas", () => {
  assert.equal(walkTuning(84532, 50_000n).span, 50_000n);
  assert.equal(walkTuning(8453, 50_000n).parallel, 3);
  assert.equal(gasFor(8453, TRANSFER_GAS_LIMIT), undefined);
  assert.equal(gasFor(84532, TRANSFER_GAS_LIMIT), undefined);
  assert.equal(gasFor(4663, TRANSFER_GAS_LIMIT), TRANSFER_GAS_LIMIT);
  assert.equal(gasFor(46630, TRANSFER_GAS_LIMIT), TRANSFER_GAS_LIMIT);
});

check("Base Sepolia's faucet step points at its guide", () => {
  const f = faucetFor("base");
  assert.ok(f);
  assert.equal(f.url, "/docs/testnet#base");
  assert.match(f.assets, /USDC/);
  assert.equal(faucetFor("base-mainnet"), null);
});

// ---------------------------------------------------------------- Base Sepolia, both runs

check("Base Sepolia: the deployed vault, its block and its memo board", () => {
  const sepolia = nets.getNetwork("base");
  assert.equal(sepolia.pool?.toLowerCase(), SEPOLIA_POOL);
  assert.equal(sepolia.deployBlock, 49_802_958n);
  assert.deepEqual(sepolia.payMemo, { address: SEPOLIA_MEMO, deployBlock: 49_804_175n, emitsPoster: false });
  assert.equal(nets.isNetworkKey("base"), true);
  assert.equal(nets.isNetworkWritable(sepolia), true);
  // Last of the testnets, or just before Ethereum Sepolia once that is in too.
  const testnetKeys = nets.NETWORK_KEYS.filter((k) => k !== "ethereum");
  assert.equal(testnetKeys[testnetKeys.length - 1], "base");
  assert.match(nets.networkKeyChoices(), /"base"/);
  assert.equal(nets.networkName(sepolia), "Base testnet");
  // Base mainnet's board comes in with its vault (base-mainnet-after-deploy.sh writes both).
  const mainMemo = nets.getNetwork("base-mainnet").payMemo;
  if (LIVE) {
    assert.match(mainMemo?.address ?? "", /^0x[0-9a-fA-F]{40}$/);
    assert.ok(mainMemo!.deployBlock >= LIVE.deployBlock, "the board is deployed after the vault");
    assert.equal(mainMemo!.emitsPoster, false);
  } else {
    assert.equal(mainMemo, null);
  }
});

check("Base Sepolia: the relay serves it with the same relay key", () => {
  assert.equal(networkForChain(84532).key, "base");
  assert.ok(relayNetworks().some((n) => n.chainId === 84532));
});

check("Base Sepolia: payment requests and claim codes", () => {
  const assets = requestAssetsFor("base");
  assert.deepEqual(
    assets.map((a) => a.symbol),
    ["USDC", "EURC", "ETH"]
  );
  assert.ok(assets.find((a) => a.symbol === "ETH")!.native);
  // EURC is a stablecoin, but a euro one: never flagged as a dollar stablecoin
  const eurc = assets.find((a) => a.symbol === "EURC")!;
  assert.equal(eurc.stable, false);
  assert.equal(eurc.peg, "EUR");
  assert.equal(assets.find((a) => a.symbol === "USDC")!.stable, true);
  // A Base mainnet USDC code opened on Base Sepolia (the same vault address) is refused.
  assert.match(
    claimNetworkProblem({ key: "base", pool: SEPOLIA_POOL }, { pool: SEPOLIA_POOL, asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" }) ?? "",
    /different network/
  );
  assert.equal(
    claimNetworkProblem({ key: "base", pool: SEPOLIA_POOL }, { pool: SEPOLIA_POOL, asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" }),
    null
  );
});

check("Base Sepolia: Glim knows it, with its faucet guide and chain details", () => {
  const k = knowledgeBlock();
  assert.match(k, /Base Sepolia \(chain ID 84532\)/);
  assert.match(k, /https:\/\/sepolia\.basescan\.org/);
  const baseSection = k.slice(k.indexOf("\nBASE"), k.indexOf("\n\n", k.indexOf("\nBASE") + 1));
  assert.ok(baseSection.length > 100);
  assert.doesNotMatch(baseSection, /\u2014/);
  const fix = chainFix("Ada", { wallet: 8453, want: 84532 });
  assert.match(fix, /Switch to Base/);
  assert.match(fix, /chain ID 84532/);
});

await checkAsync("Base Sepolia: the remote MCP lists it and gives final-key snippets", async () => {
  const one = await toolJson("gloam_networks", { network: "base" });
  assert.equal(one.isError, false);
  assert.match(one.text, /"chainId": 84532/);
  assert.match(one.text, /"symbol": "EURC"/);
  // gloam_networks never calls EURC a (dollar) stablecoin, and says what it is pegged to
  const eurcView = (JSON.parse(one.text) as { networks: { assets: { symbol: string; stablecoin: boolean; peg?: string }[] }[] }).networks[0]!.assets.find((a) => a.symbol === "EURC")!;
  assert.deepEqual([eurcView.stablecoin, eurcView.peg], [false, "EUR"]);
  assert.match(one.text, new RegExp(`"paymentMessageBoard": "${SEPOLIA_MEMO}"`));
  const mpp = await toolJson("gloam_mpp_how_to", { network: "base" });
  assert.equal(mpp.isError, false);
  assert.match(mpp.text, /testnetNetwork\(\\"base\\"\)/);
  assert.match(mpp.text, /BASE_SEPOLIA_USDC/);
  assert.match(mpp.text, SDK_PIN, "the SDK version the guide installs is the SDK's own");
  const info = await toolJson("gloam_info");
  assert.match(info.text, /Base Sepolia \(84532\)/);
});

// ---------------------------------------------------------------- as shipped: Base mainnet not in yet

if (!CONFIGURED) {
  check("as shipped: Base mainnet is no network key anywhere", () => {
    assert.equal(nets.isNetworkKey("base-mainnet"), false);
    assert.ok(!nets.NETWORK_KEYS.includes("base-mainnet"));
    assert.ok(!nets.allNetworks().some((n) => n.key === "base-mainnet"));
    assert.doesNotMatch(nets.networkKeyChoices(), /base-mainnet/);
    assert.equal(nets.getNetwork("base-mainnet").pool, null);
    assert.equal(mainnet.mainnetPool(8453), null);
    // Ethereum may be live beside them (MAINNET_POOLS[1]); Base mainnet never is here
    assert.doesNotMatch(mainnet.liveMainnetNames(), /Base/);
    assert.throws(() => networkForChain(8453), /not supported by the relay/);
  });

  check("as shipped: Glim never names Base mainnet", () => {
    const k = knowledgeBlock();
    assert.doesNotMatch(k, /Base mainnet \(chain ID 8453\)/);
    assert.match(k, /went live on mainnet on Wednesday 21 October 2026 at 13:00 UTC, on Robinhood Chain and Tempo\.( Ethereum mainnet joined after that, on 26 October 2026 \(see ETHEREUM\)\.)? The vault has the same address/);
  });

  await checkAsync("as shipped: the remote MCP neither lists nor takes base-mainnet", async () => {
    const one = await toolJson("gloam_networks", { network: "base-mainnet" });
    assert.equal(one.isError, true);
    const info = await toolJson("gloam_info");
    assert.doesNotMatch(info.text, /Base \(8453\)/);
  });

  // The same file again, with Base mainnet's pool filled in too.
  const child = spawnSync(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url)], {
    env: { ...process.env, GLOAM_SELFTEST_BASE: "configured" },
    encoding: "utf8",
  });
  process.stdout.write(child.stdout);
  process.stderr.write(child.stderr);
  assert.equal(child.status, 0, "the configured run failed");
  console.log(`selftest-base (as shipped): ${checks} checks passed`);
}

// ---------------------------------------------------------------- with the pools filled in

if (CONFIGURED) {
  check("configured: Base mainnet joins, after the other mainnets", () => {
    const keys = nets.NETWORK_KEYS;
    assert.ok(keys.indexOf("base-mainnet") > keys.indexOf("tempo-mainnet"));
    assert.ok(keys.indexOf("base-mainnet") < keys.indexOf("robinhood"));
    assert.equal(keys.filter((k) => k !== "ethereum").pop(), "base");
    assert.equal(nets.isNetworkKey("base-mainnet"), true);
    assert.match(nets.networkKeyChoices(), /"base-mainnet"/);
    assert.equal(nets.getNetwork("base-mainnet").pool, MAINNET_POOL);
    assert.equal(nets.getNetwork("base-mainnet").deployBlock, MAINNET_BLOCK);
    assert.equal(nets.networkName(nets.getNetwork("base-mainnet")), "Base");
    assert.match(mainnet.liveMainnetNames(), ELYSIUM ? /^Robinhood Chain, Tempo, Base(, Ethereum)? and Elysium$/ : /^Robinhood Chain, Tempo(, Base and Ethereum| and Base)$/);
  });

  check("configured: the relay serves both Base chain ids with the same relay key", () => {
    const ids = relayNetworks().map((n) => n.chainId);
    assert.ok(ids.includes(84532) && ids.includes(8453));
    assert.equal(networkForChain("8453").key, "base-mainnet");
  });

  check("configured: Glim knows Base mainnet, never as part of the 21 October launch", () => {
    const k = knowledgeBlock();
    assert.match(k, /Base mainnet \(chain ID 8453\)/);
    assert.match(k, /went live on mainnet on Wednesday 21 October 2026 at 13:00 UTC, on Robinhood Chain and Tempo\. Base( and Ethereum)? mainnet joined after that/);
    assert.doesNotMatch(k, /21 October[^.\n]*Tempo and Base/);
  });

  await checkAsync("configured: the remote MCP lists Base mainnet with its own snippets", async () => {
    const main = await toolJson("gloam_mpp_how_to", { network: "base-mainnet" });
    assert.equal(main.isError, false);
    assert.match(main.text, /mainnetNetwork\(\\"base\\"\)/);
    assert.match(main.text, /BASE_USDC/);
    const info = await toolJson("gloam_info");
    assert.match(info.text, /Base \(8453\)/);
  });

  console.log(`selftest-base (Base mainnet filled in too): ${checks} checks passed`);
}
