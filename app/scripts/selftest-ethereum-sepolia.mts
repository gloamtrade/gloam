/**
 * Self-test: Ethereum Sepolia (11155111) in the app.
 *
 * Two runs of this file:
 *
 *  - as committed: ETHEREUM_SEPOLIA_POOL as it is in lib/mainnet.ts. Empty
 *    until the deploy, so Ethereum Sepolia is no network key: the selector,
 *    relay, remote MCP and Glim act as if it did not exist, while its entry,
 *    assets and keys are already right. Once the deploy is pasted in, the same
 *    run checks it as live with the real values.
 *  - with a placeholder pool and memo board put into ETHEREUM_SEPOLIA_POOL
 *    before anything else loads (a child process of this one): Ethereum
 *    Sepolia shows up after the other testnets on the final keys with its
 *    assets and limits, the relay serves it, payment requests and claim codes
 *    work, Glim knows it and fixes a wrong-network error, and the remote MCP
 *    lists it with final-key snippets.
 *
 * The placeholder pool is not a contract; nothing reaches any host (fetch
 * fails the run if anything tries).
 *
 * Run from app/:  ../mcp/node_modules/.bin/tsx scripts/selftest-ethereum-sepolia.mts
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
  throw new Error(`selftest-ethereum-sepolia: no network calls allowed (${String(url)})`);
}) as typeof fetch;

const CONFIGURED = process.env.GLOAM_SELFTEST_SEPOLIA === "configured";
const PLACEHOLDER_POOL = "0x0000000000000000000000000000000000005E91";
const PLACEHOLDER_MEMO = "0x0000000000000000000000000000000000005E92";
const SEPOLIA_USDC = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";
const BASE_SEPOLIA_USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

const mainnet = await import("../src/lib/mainnet");
if (CONFIGURED) {
  // Filled in the way DEPLOY-ETHEREUM-SEPOLIA.md says, before networks.ts reads it.
  Object.assign(mainnet.ETHEREUM_SEPOLIA_POOL, {
    pool: PLACEHOLDER_POOL,
    deployBlock: 11_990_000n,
    payMemo: PLACEHOLDER_MEMO,
    payMemoBlock: 11_990_002n,
  });
}

const nets = await import("../src/lib/networks");
const tokens = await import("../src/lib/tokens");
const { bridgeVisible } = await import("../src/lib/bridge");
const { vaultSwapRouter } = await import("../src/lib/vaultSwap");
const { faucetFor } = await import("../src/lib/faucet");
const { requestAssetsFor, claimNetworkProblem } = await import("../src/lib/paymentRequest");
const { walkTuning } = await import("../src/lib/leafIndex");
const { gasFor, TRANSFER_GAS_LIMIT } = await import("../src/lib/shield");
const { relayNetworks, networkForChain } = await import("../src/lib/relay/server");
const { knowledgeBlock } = await import("../src/lib/telegramBot/knowledge");
const { chainFix, chainMismatch } = await import("../src/lib/telegramBot/rules");
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

const live = mainnet.ethereumSepoliaPool();
const on = CONFIGURED || live !== null;

// ---------------------------------------------------------------- both runs

check("the entry is always defined: a testnet on the mainnet pool and final keys", () => {
  const n = nets.getNetwork("ethereum");
  assert.equal(n.family, "ethereum");
  assert.equal(n.label, "Ethereum");
  assert.equal(n.testnet, true);
  assert.equal(n.chain.testnet, true);
  assert.equal(n.chainId, 11155111);
  assert.equal(n.paymentsPool, true);
  assert.equal(n.ceremony, "production");
  assert.equal(n.stocks, false);
  assert.equal(n.primaryAsset.symbol, "ETH");
  assert.equal(n.logRange, 50_000n);
  // publicnode first, at the head; Tenderly's gateway (the whole history, trailing the head) for old blocks
  assert.deepEqual(n.chain.rpcUrls.default.http, ["https://ethereum-sepolia-rpc.publicnode.com", "https://sepolia.gateway.tenderly.co"]);
  assert.deepEqual(n.historyRpc, { url: "https://sepolia.gateway.tenderly.co", recentBlocks: 9_000n });
  assert.equal(n.explorerTx("0xab"), "https://sepolia.etherscan.io/tx/0xab");
  assert.equal(n.explorerAddress("0xcd"), "https://sepolia.etherscan.io/address/0xcd");
  assert.equal(nets.networkName(n), "Ethereum Sepolia");
  assert.doesNotMatch(n.note, /real money|play money|test funds|—/);
  // Proofs for Sepolia are never checked against the dev keys, pool or not.
  assert.equal(nets.ceremonyForChain(11155111), "production");
});

check("assets as checked on chain, with EURC never counted as a dollar", () => {
  const list = tokens.shieldTokensFor(11155111);
  assert.deepEqual(
    list.map((t) => [t.symbol, t.address, t.decimals]),
    [
      ["USDC", SEPOLIA_USDC, 6],
      ["USDG", "0xfBb2A78CceEb415b00300925e464C3E44E6e06b0", 6],
      ["PYUSD", "0xCaC524BcA292aaade2DF8A05cC58F0a65B1B3bB9", 6],
      ["EURC", "0x08210F9170F89Ab7658F0B5E3fF39b0E03C594D4", 6],
    ]
  );
  for (const t of list) assert.equal(tokens.isDollarStable(t), t.symbol !== "EURC", t.symbol);
  assert.equal(tokens.supportsNativeShield(11155111), true);
  assert.equal(tokens.knownTokens(11155111)[0]!.symbol, "USDC");
});

check("no bridge and no swaps there; reads in 50,000-block spans; the wallet estimates gas", () => {
  assert.equal(bridgeVisible(nets.getNetwork("ethereum")), false);
  assert.equal(vaultSwapRouter(11155111), null);
  assert.equal(walkTuning(11155111, 50_000n).span, 50_000n);
  assert.equal(gasFor(11155111, TRANSFER_GAS_LIMIT), undefined);
});

check("its faucet step points at its guide", () => {
  const f = faucetFor("ethereum");
  assert.ok(f);
  assert.equal(f.url, "/docs/testnet#ethereum");
  assert.match(f.assets, /PYUSD/);
  assert.doesNotMatch(f.blurb, /play money|real money|—/);
});

check("Glim reads an 8-digit chain id from a wrong-network error", () => {
  const m = chainMismatch(
    "The current chain of the wallet (id: 1) does not match the target chain for the transaction (id: 11155111 – Ethereum Sepolia)."
  );
  assert.deepEqual(m, { wallet: 1, want: 11155111 });
  const fix = chainFix("Ada", { wallet: 1, want: 11155111 });
  assert.match(fix, /Switch to Ethereum/);
  assert.match(fix, /Ethereum Sepolia testnet \(11155111\)/);
  assert.match(fix, /chain ID 11155111/);
});

// ---------------------------------------------------------------- not deployed yet

if (!on) {
  check("as shipped: Ethereum Sepolia is no network key anywhere", () => {
    assert.equal(nets.isNetworkKey("ethereum"), false);
    assert.ok(!nets.NETWORK_KEYS.includes("ethereum"));
    assert.ok(!nets.allNetworks().some((n) => n.key === "ethereum"));
    assert.doesNotMatch(nets.networkKeyChoices(), /"ethereum"/);
    assert.equal(nets.getNetwork("ethereum").pool, null);
    assert.equal(nets.getNetwork("ethereum").payMemo, null);
    assert.equal(mainnet.ethereumSepoliaPayMemo(), null);
    assert.throws(() => networkForChain(11155111), /not supported by the relay/);
  });

  check("as shipped: Glim never names it", () => {
    const k = knowledgeBlock();
    assert.doesNotMatch(k, /Ethereum Sepolia \(chain ID 11155111\)/);
  });

  await checkAsync("as shipped: the remote MCP neither lists nor takes it", async () => {
    const one = await toolJson("gloam_networks", { network: "ethereum" });
    assert.equal(one.isError, true);
    const info = await toolJson("gloam_info");
    assert.doesNotMatch(info.text, /11155111/);
  });

  // The same file again, with a placeholder pool and board filled in.
  const child = spawnSync(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url)], {
    env: { ...process.env, GLOAM_SELFTEST_SEPOLIA: "configured" },
    encoding: "utf8",
  });
  process.stdout.write(child.stdout);
  process.stderr.write(child.stderr);
  assert.equal(child.status, 0, "the configured run failed");
  console.log(`selftest-ethereum-sepolia (as shipped, not deployed): ${checks} checks passed`);
}

// ---------------------------------------------------------------- with its pool in

if (on) {
  const pool = CONFIGURED ? PLACEHOLDER_POOL : live!.pool;
  const memo = CONFIGURED ? PLACEHOLDER_MEMO : mainnet.ETHEREUM_SEPOLIA_POOL.payMemo;

  check("its pool in: listed after the other testnets, writable, with its memo board", () => {
    const n = nets.getNetwork("ethereum");
    assert.equal(n.pool, pool);
    if (CONFIGURED) assert.equal(n.deployBlock, 11_990_000n);
    if (memo) assert.deepEqual(n.payMemo, { address: memo, deployBlock: CONFIGURED ? 11_990_002n : n.payMemo!.deployBlock, emitsPoster: false });
    assert.equal(nets.isNetworkKey("ethereum"), true);
    assert.equal(nets.isNetworkWritable(n), true);
    const keys = nets.NETWORK_KEYS;
    assert.equal(keys[keys.length - 1], "ethereum");
    assert.ok(keys.indexOf("ethereum") > keys.indexOf("tempo"));
    if (keys.includes("base")) assert.ok(keys.indexOf("ethereum") > keys.indexOf("base"));
    assert.match(nets.networkKeyChoices(), /"ethereum"/);
  });

  check("its pool in: the relay serves it with the same relay key", () => {
    assert.equal(networkForChain(11155111).key, "ethereum");
    assert.equal(networkForChain("11155111").key, "ethereum");
    assert.ok(relayNetworks().some((n) => n.chainId === 11155111));
  });

  check("its pool in: payment requests and claim codes", () => {
    assert.deepEqual(
      requestAssetsFor("ethereum").map((a) => a.symbol),
      ["USDC", "USDG", "PYUSD", "EURC", "ETH"]
    );
    assert.ok(requestAssetsFor("ethereum").find((a) => a.symbol === "ETH")!.native);
    // A Base Sepolia USDC code opened here (the vaults share an address) is refused.
    assert.match(
      claimNetworkProblem({ key: "ethereum", pool }, { pool, asset: BASE_SEPOLIA_USDC }) ?? "",
      /different network/
    );
    assert.equal(claimNetworkProblem({ key: "ethereum", pool }, { pool, asset: SEPOLIA_USDC }), null);
  });

  check("its pool in: Glim knows it, with its faucets and chain details", () => {
    const k = knowledgeBlock();
    assert.match(k, /Ethereum Sepolia \(chain ID 11155111\)/);
    assert.match(k, /https:\/\/sepolia\.etherscan\.io/);
    const start = k.indexOf("\nETHEREUM SEPOLIA");
    const section = k.slice(start, k.indexOf("\n\n", start + 1));
    assert.ok(section.length > 100);
    assert.match(section, /PYUSD/);
    assert.match(section, /Google Cloud/);
    assert.doesNotMatch(section, /—|real money|play money|test funds/);
  });

  await checkAsync("its pool in: the remote MCP lists it and gives final-key snippets", async () => {
    const one = await toolJson("gloam_networks", { network: "ethereum" });
    assert.equal(one.isError, false);
    assert.match(one.text, /"chainId": 11155111/);
    assert.match(one.text, /"symbol": "PYUSD"/);
    // the head RPC, and where to read old blocks
    assert.match(one.text, /"rpc": "https:\/\/ethereum-sepolia-rpc\.publicnode\.com"/);
    assert.match(one.text, /"historyRpc": \{\s*"url": "https:\/\/sepolia\.gateway\.tenderly\.co",\s*"recentBlocks": 9000/);
    const base = await toolJson("gloam_networks", { network: "base" });
    assert.doesNotMatch(base.text, /historyRpc/, "one RPC keeps everything elsewhere");
    if (memo) assert.match(one.text, new RegExp(`"paymentMessageBoard": "${memo}"`));
    const mpp = await toolJson("gloam_mpp_how_to", { network: "ethereum" });
    assert.equal(mpp.isError, false);
    assert.match(mpp.text, /testnetNetwork\(\\"ethereum\\"\)/);
    assert.match(mpp.text, /ETHEREUM_SEPOLIA_USDC/);
    assert.match(mpp.text, SDK_PIN, "the SDK version the guide installs is the SDK's own");
    assert.match(mpp.text, /Ethereum Sepolia/);
    assert.doesNotMatch(mpp.text, /play money|real money|test funds/);
    const info = await toolJson("gloam_info");
    assert.match(info.text, /Ethereum Sepolia \(11155111\)/);
  });

  console.log(`selftest-ethereum-sepolia (${CONFIGURED ? "placeholder pool and board" : "live"}): ${checks} checks passed`);
}
