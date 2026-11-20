/**
 * Self-test: BNB Chain mainnet (56) in the app, OFF unless NEXT_PUBLIC_BNB_ENABLED
 * is "1" (or "true", "on", "yes") and its pool is in.
 *
 * Runs of this file (all but the first as child processes):
 *
 *  - off (no NEXT_PUBLIC_BNB_* set, as a preview build or a missing variable
 *    leaves it): BNB Chain does not exist. Not a network key, not served by the
 *    relay, not in the CSP, not in the RPC proxy, no tokens, no fixed gas. The
 *    flag's words are checked here: only the on words turn it on, and the CSP
 *    reads them the same. Chain 56 still proves with the final keys.
 *  - nopool (flag "1", the SDK file without its pool, as before the deploy):
 *    still nothing anywhere.
 *  - on (flag "1" and NEXT_PUBLIC_BNB_POOL / _DEPLOY_BLOCK / _LIVE_SINCE): BNB
 *    Chain shows last among the mainnets, gas in BNB which the vault lists, USDT
 *    and USDC with 18 decimals, BDX with 9, fixed deposit gas, the relay serves it
 *    with a 0.05 BNB hourly cap and a 1 gwei gas ceiling, the CSP allows its RPCs,
 *    the RPC proxy serves 56, and every read goes through the pruned-logs check:
 *    on the server an empty old answer from a pruned RPC fails loudly; in the
 *    browser it is asked again of the proxy, which answers from the archive.
 *  - nolivesince (flag on with a pool but no NEXT_PUBLIC_BNB_LIVE_SINCE): the build fails.
 *  - badpool, keyed: a wrong pool fails the build, and so does nothing else quietly.
 *
 * The placeholder values reach no host: fetch is replaced by fake RPCs.
 *
 * Run from app/:  ../mcp/node_modules/.bin/tsx scripts/selftest-bnb.mts
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const MODE = process.env.GLOAM_SELFTEST_BNB ?? "off";
const CHAIN_ID = 56;
const POOL = "0x89d3042390204f57b8b4F8949D3c2203E4002164";
// Is the pool written into the SDK file yet (bnb-mainnet-after-deploy.sh)? The CSP reads the same file.
const SDK_BNB_SRC = (await import("node:fs")).readFileSync(new URL("../../packages/sdk/src/bnb.ts", import.meta.url), "utf8");
const SDK_POOL_IN = /^\s*pool:\s*"0x[0-9a-fA-F]{40}",\s*$/m.test(SDK_BNB_SRC);
/** The deploy block the SDK file holds once the pool is in (bnb-mainnet-after-deploy.sh writes both). */
const SDK_DEPLOY_BLOCK = SDK_POOL_IN ? BigInt(/^\s*deployBlock:\s*(\d+)n,\s*$/m.exec(SDK_BNB_SRC)?.[1] ?? "0") : null;
const USDT = "0x55d398326f99059fF775485246999027B3197955";
const USDC = "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d";
const BDX = "0x9d10a1ec41Fe7878429BB457e31F9b050D38c633";

for (const k of Object.keys(process.env)) if (k.startsWith("NEXT_PUBLIC_BNB_")) delete process.env[k];
delete process.env.GLOAM_RPC_URL_56;
delete process.env.GLOAM_RELAY_HOURLY_SPEND_56;
delete process.env.GLOAM_RELAY_MAX_GAS_GWEI_56;
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;
if (MODE !== "off") process.env.NEXT_PUBLIC_BNB_ENABLED = "1";
if (MODE === "on" || MODE === "nolivesince" || MODE === "badpool") {
  process.env.NEXT_PUBLIC_BNB_POOL = MODE === "badpool" ? "0x1234" : POOL;
  process.env.NEXT_PUBLIC_BNB_DEPLOY_BLOCK = "134300000";
}
if (MODE === "on" || MODE === "badpool") process.env.NEXT_PUBLIC_BNB_LIVE_SINCE = "21 November 2026";
// Once the SDK file holds the pool, "no pool in the env" is no longer off: the flag alone turns BNB Chain on
// with the SDK's pool, and the build then needs its live-since date like any other "on".
if (MODE === "nopool" && SDK_POOL_IN) process.env.NEXT_PUBLIC_BNB_LIVE_SINCE = "19 November 2026";

// ── fake RPCs: publicnode keeps logs from PRUNED_FROM on; the archive (the proxy) keeps all ──
const HEAD = 135_000_000n;
const PRUNED_FROM = HEAD - 220_000n;
const VAULT_LOG_BLOCK = 134_300_010n;
/** A second vault log just inside what publicnode keeps: a range from before it straddles the edge. */
const VAULT_LOG_BLOCK_2 = PRUNED_FROM + 10n;
/** Keyed RPCs that keep every log but take at most this many blocks a read: one says so with -32602, one with -32005. */
const KEYED_RANGE = 10_000n;
/** While true, publicnode fails every call as a node (HTTP 500). */
let publicDown = false;
const asked: { url: string; method: string; params: unknown[] }[] = [];
const hex = (n: bigint) => `0x${n.toString(16)}`;
function answer(url: string, method: string, params: unknown[]): unknown {
  if (method === "eth_chainId") return "0x38";
  if (method === "eth_blockNumber") return hex(HEAD);
  if (method === "eth_getLogs") {
    const f = params[0] as { address?: string; fromBlock?: string; toBlock?: string };
    const from = BigInt(f.fromBlock ?? "0x0");
    const to = f.toBlock ? BigInt(f.toBlock) : HEAD;
    const keepsFrom = /\/api\/rpc\/56|archive\.example|capped/.test(url) ? 0n : PRUNED_FROM;
    if (to < keepsFrom) return [];
    if (String(f.address).toLowerCase() === USDT.toLowerCase()) {
      return [{ address: USDT, blockNumber: hex(from), blockHash: `0x${"11".repeat(32)}`, transactionHash: `0x${"22".repeat(32)}`, transactionIndex: "0x0", logIndex: "0x0", data: "0x", topics: [], removed: false }];
    }
    return [VAULT_LOG_BLOCK, VAULT_LOG_BLOCK_2]
      .filter((b) => b >= from && b <= to && b >= keepsFrom)
      .map((b) => ({ address: POOL, blockNumber: hex(b), blockHash: `0x${"33".repeat(32)}`, transactionHash: `0x${"44".repeat(32)}`, transactionIndex: "0x0", logIndex: "0x0", data: "0x", topics: [], removed: false }));
  }
  throw new Error(`fake RPC: ${method} not expected`);
}
globalThis.fetch = (async (input: unknown, init?: { body?: string }) => {
  const url = String(input instanceof Request ? input.url : input);
  if (!/bsc-rpc\.publicnode\.com|bsc-dataseed\.bnbchain\.org|\/api\/rpc\/56|archive\.example|capped\.example|capped32005\.example/.test(url)) {
    throw new Error(`selftest-bnb: no network calls allowed (${url})`);
  }
  if (publicDown && url.includes("publicnode")) return new Response("upstream down", { status: 500 });
  const body = JSON.parse(init?.body ?? "null");
  const one = (b: { id: number; method: string; params?: unknown[] }) => {
    asked.push({ url, method: b.method, params: b.params ?? [] });
    if (b.method === "eth_getLogs" && url.includes("bsc-dataseed")) return { jsonrpc: "2.0", id: b.id, error: { code: -32005, message: "limit exceeded" } };
    if (b.method === "eth_getLogs" && url.includes("capped")) {
      const f = (b.params ?? [])[0] as { fromBlock: string; toBlock: string };
      if (BigInt(f.toBlock) - BigInt(f.fromBlock) + 1n > KEYED_RANGE) {
        const error = url.includes("capped32005") ? { code: -32005, message: "limit exceeded" } : { code: -32602, message: "eth_getLogs is limited to a 10,000 block range" };
        return { jsonrpc: "2.0", id: b.id, error };
      }
    }
    return { jsonrpc: "2.0", id: b.id, result: answer(url, b.method, b.params ?? []) };
  };
  const out = Array.isArray(body) ? body.map(one) : one(body);
  return new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;

if (MODE === "nolivesince") {
  await assert.rejects(import("../src/lib/bnb"), /NEXT_PUBLIC_BNB_LIVE_SINCE/);
  console.log("selftest-bnb (nolivesince): ok (on with a pool but no live-since date fails the build)");
  process.exit(0);
}
if (MODE === "badpool") {
  await assert.rejects(import("../src/lib/bnb"), /pool is not a pool address/);
  console.log("selftest-bnb (badpool): ok (a pool that is not an address fails the build)");
  process.exit(0);
}

const bnb = await import("../src/lib/bnb");
const nets = await import("../src/lib/networks");
const tokens = await import("../src/lib/tokens");
const mainnet = await import("../src/lib/mainnet");
const { CSP_CONNECT_SOURCES, bnbConnectSources } = await import("../csp.config.mjs");
const { hourlySpendWei } = await import("../src/lib/relay/spendCap");
const { maxGasPriceWei } = await import("../src/lib/relay/gasCeiling");
const { relayNetworks, networkForChain, sendGasMost } = await import("../src/lib/relay/server");
const { walkTuning } = await import("../src/lib/leafIndex");
const { gasFor, nativeGasReserve, summaryDecimals, SHIELD_BOUND_GAS_LIMIT, APPROVE_GAS_LIMIT, TRANSFER_GAS_LIMIT } = await import("../src/lib/shield");
const { rpcProxyChainIds } = await import("../src/lib/rpcProxy");
const { readTransport } = await import("../src/lib/readTransport");
const { serverTransport, resetRpcChecks } = await import("../src/lib/serverRpc");
const { PUBLIC_MEMPOOL_CHAINS } = await import("../src/lib/partnerCode");
const { VAULT_SWAP_ROUTERS } = await import("../src/lib/vaultSwap");
const { NO_LOG_RPCS } = nets;

let checks = 0;
const ok = (cond: unknown, msg: string) => {
  assert.ok(cond, msg);
  checks++;
};

// Every run: the entry is defined, a payments pool on the final keys, gas in BNB.
const e = nets.getNetwork("bnb-mainnet");
ok(e.family === "bnb" && e.label === "BNB Chain" && !e.testnet && e.chainId === CHAIN_ID, "the entry is defined");
ok(e.paymentsPool && e.ceremony === "production", "mainnet pool on the final keys");
ok(e.primaryAsset.symbol === "BNB" && e.primaryAsset.decimals === 18 && e.chain.nativeCurrency.symbol === "BNB", "gas in BNB");
ok(e.logCanary?.address === USDT && e.logCanary.trustRecentBlocks === 1_000n, "reads carry the pruned-logs check (USDT), trusting only the last 1,000 blocks");
ok(e.chain.rpcUrls.default.http[0] === "https://bsc-rpc.publicnode.com" && e.chain.rpcUrls.default.http.every((u) => !/key|\/v\d+\//i.test(u)), "public RPCs only, no key, for wallets");
ok(NO_LOG_RPCS.has("https://bsc-dataseed.bnbchain.org"), "the dataseed never gets a log read");
ok(nets.ceremonyForChain(CHAIN_ID) === "production", "a proof for 56 uses the final keys, on or off");
ok(tokens.nativeTokenFor(CHAIN_ID).symbol === "BNB", "a wallet on 56 holds BNB, never ETH");
ok(maxGasPriceWei(CHAIN_ID, {}) === 1_000_000_000n, "the relay's gas ceiling on BNB Chain: 1 gwei");
ok(maxGasPriceWei(CHAIN_ID, { GLOAM_RELAY_MAX_GAS_GWEI_56: "0.5" }) === 500_000_000n && maxGasPriceWei(CHAIN_ID, { GLOAM_RELAY_MAX_GAS_GWEI_56: "off" }) === null, "the ceiling's env");
ok(maxGasPriceWei(1, {}) === 3_000_000_000n && maxGasPriceWei(8453, {}) === null, "Ethereum keeps 3 gwei, Base none");
ok(!VAULT_SWAP_ROUTERS[CHAIN_ID], "no swap router on BNB Chain");
ok(PUBLIC_MEMPOOL_CHAINS.includes(CHAIN_ID), "a public mempool: only relay-sent link payments count");
ok(sendGasMost(CHAIN_ID, "unshield") === 1_200_000n, "a relayed cash out may use up to 1.2M gas (0.46M to 0.83M on a BNB Chain fork)");
ok(mainnet.liveMainnetCount() >= 5, "the other mainnets still count");

if (MODE === "off") {
  for (const raw of ["1", "true", "TRUE", "on", "yes", " 1 "]) {
    ok(bnb.bnbFlagFrom(raw), `${JSON.stringify(raw)} is on`);
    ok(bnbConnectSources({ NEXT_PUBLIC_BNB_ENABLED: raw, NEXT_PUBLIC_BNB_POOL: POOL } as unknown as NodeJS.ProcessEnv).length === 2, `${JSON.stringify(raw)} with a pool: the CSP allows its two RPCs`);
    // Without NEXT_PUBLIC_BNB_POOL the CSP falls back to the SDK file: nothing to allow before the deploy, the two RPCs after it.
    ok(bnbConnectSources({ NEXT_PUBLIC_BNB_ENABLED: raw } as unknown as NodeJS.ProcessEnv).length === (SDK_POOL_IN ? 2 : 0), `${JSON.stringify(raw)} with no pool in the env: ${SDK_POOL_IN ? "the SDK's pool, its two RPCs" : "nothing to allow"}`);
  }
  for (const raw of [undefined, "", " ", "0", "false", "off", "no", "enabled", "2", "maybe"]) {
    ok(!bnb.bnbFlagFrom(raw), `${JSON.stringify(raw)} is off`);
    ok(bnbConnectSources({ NEXT_PUBLIC_BNB_ENABLED: raw, NEXT_PUBLIC_BNB_POOL: POOL } as unknown as NodeJS.ProcessEnv).length === 0, `${JSON.stringify(raw)}: no BNB Chain RPC in the CSP`);
  }
  ok(!bnb.BNB_FLAG, "off: no flag set");
}

if (MODE === "off" || (MODE === "nopool" && !SDK_POOL_IN)) {
  ok(bnb.BNB === null && !bnb.BNB_ENABLED, `${MODE}: BNB Chain is off`);
  ok(!nets.NETWORK_KEYS.includes("bnb-mainnet") && !nets.isNetworkKey("bnb-mainnet") && !nets.isShownNetworkKey("bnb-mainnet"), `${MODE}: not a network key, not shown`);
  ok(e.pool === null && e.deployBlock === null, `${MODE}: no pool`);
  ok(!relayNetworks().some((n) => n.family === "bnb"), `${MODE}: the relay does not serve it`);
  assert.throws(() => networkForChain(CHAIN_ID), /not supported/);
  checks++;
  ok(!mainnet.liveMainnetNames().includes("BNB"), `${MODE}: not in the live names`);
  ok(!CSP_CONNECT_SOURCES.includes("https://bsc-rpc.publicnode.com") && !CSP_CONNECT_SOURCES.includes("https://bsc-dataseed.bnbchain.org"), `${MODE}: no BNB Chain RPC in the CSP`);
  ok(!rpcProxyChainIds().includes(CHAIN_ID), `${MODE}: the RPC proxy does not serve 56`);
  ok(tokens.shieldTokensFor(CHAIN_ID).every((t) => t.address.toLowerCase() !== USDT.toLowerCase()), `${MODE}: no BNB Chain USDT`);
  ok(gasFor(CHAIN_ID, SHIELD_BOUND_GAS_LIMIT) === undefined, `${MODE}: no fixed gas for a chain the build does not run`);
  ok(hourlySpendWei(CHAIN_ID, {}) === null || hourlySpendWei(CHAIN_ID, {}) === 0n || hourlySpendWei(CHAIN_ID, {}) === undefined, `${MODE}: no relay budget for BNB Chain`);
}

if (MODE === "nopool" && SDK_POOL_IN) {
  ok(bnb.BNB_ENABLED && bnb.BNB?.chainId === CHAIN_ID && bnb.BNB_LIVE_SINCE === "19 November 2026", "nopool: the flag and the SDK file's pool turn BNB Chain on");
  ok(e.pool === POOL && e.deployBlock === SDK_DEPLOY_BLOCK && SDK_DEPLOY_BLOCK !== null && SDK_DEPLOY_BLOCK > 0n, "nopool: the pool and block come from the SDK file");
  ok(mainnet.mainnetChainPool(CHAIN_ID)?.pool === POOL, "nopool: its pool from lib/bnb");
  ok(nets.NETWORK_KEYS.includes("bnb-mainnet") && nets.isShownNetworkKey("bnb-mainnet"), "nopool: a network key, shown");
  ok(CSP_CONNECT_SOURCES.includes("https://bsc-rpc.publicnode.com"), "nopool: the CSP allows its public RPC");
}

if (MODE === "on") {
  ok(bnb.BNB_ENABLED && bnb.BNB?.chainId === CHAIN_ID && bnb.BNB_LIVE_SINCE === "21 November 2026", "on: BNB Chain is on");
  ok(nets.NETWORK_KEYS.includes("bnb-mainnet") && nets.isShownNetworkKey("bnb-mainnet"), "on: a network key, shown with the mainnets");
  const mainnets = nets.NETWORK_KEYS.filter((k) => !nets.getNetwork(k).testnet);
  ok(mainnets[mainnets.length - 1] === "bnb-mainnet", "on: listed after the other mainnets");
  ok(e.pool === POOL && e.deployBlock === 134_300_000n, "on: its pool and block");
  ok(e.explorerTx("0xab") === "https://bscscan.com/tx/0xab", "on: BscScan links");
  ok(nets.isNetworkWritable(e), "on: writable");
  ok(mainnet.liveMainnetNames().endsWith("and BNB Chain"), "on: named last in the live mainnets");
  ok(mainnet.mainnetChainPool(CHAIN_ID)?.pool === POOL, "on: its pool from lib/bnb");

  // Tokens: each in its own decimals, never 6 by accident.
  const add = tokens.shieldTokensFor(CHAIN_ID);
  const by = Object.fromEntries(add.map((t) => [t.symbol, t]));
  ok(add.map((t) => t.symbol).join(",") === "USDT,USDC,BDX", "on: USDT, USDC, BDX (and BNB, the native coin)");
  ok(by.USDT!.address === USDT && by.USDT!.decimals === 18 && by.USDT!.kind === "stablecoin", "on: USDT, 18 decimals");
  ok(by.USDC!.address === USDC && by.USDC!.decimals === 18 && by.USDC!.kind === "stablecoin", "on: USDC, 18 decimals");
  ok(by.BDX!.address === BDX && by.BDX!.decimals === 9 && by.BDX!.opensWithLimit === true, "on: BDX, 9 decimals, read from its live limit");
  ok(tokens.supportsNativeShield(CHAIN_ID) && tokens.isNativeAddable(CHAIN_ID), "on: BNB listed and offered (no limit from the deploy)");
  nets.setShownNetworkKey("bnb-mainnet");
  ok(summaryDecimals(USDT) === 2 && summaryDecimals(USDC) === 2, "on: 18-decimal stablecoins show cents in summaries");
  ok(summaryDecimals("0x0000000000000000000000000000000000000000") === 6 && summaryDecimals(BDX) === 6, "on: BNB and BDX show 6 places");

  // Gas: fixed limits for deposits, and a native reserve from BNB's own price.
  ok(gasFor(CHAIN_ID, SHIELD_BOUND_GAS_LIMIT) === SHIELD_BOUND_GAS_LIMIT && gasFor(CHAIN_ID, APPROVE_GAS_LIMIT) === APPROVE_GAS_LIMIT, "on: deposits carry a fixed gas limit");
  ok(SHIELD_BOUND_GAS_LIMIT >= 1_800_000n && TRANSFER_GAS_LIMIT >= 2_000_000n, "on: limits above the fork's 1.69M first deposit and 1.89M private send");
  ok(nativeGasReserve(CHAIN_ID, null) === SHIELD_BOUND_GAS_LIMIT * 100_000_000n * 3n, "on: unread gas price: 0.1 gwei, three times over");
  ok(nativeGasReserve(CHAIN_ID, 50_000_000n) === SHIELD_BOUND_GAS_LIMIT * 50_000_000n * 3n, "on: read gas price used");

  // The relay.
  // Without GLOAM_RPC_URL_56 the server neither sends there nor keeps the leaf list: closed, with a clear error.
  ok(!relayNetworks().some((n) => n.family === "bnb"), "on, no GLOAM_RPC_URL_56: the relay does not list it");
  await assert.rejects(async () => networkForChain(CHAIN_ID), (err: Error & { status?: number }) => err.status === 503 && /BNB Chain is not open on the relay yet/.test(err.message));
  checks++;
  const { getLeafSnapshot } = await import("../src/lib/leafIndexServer");
  await assert.rejects(getLeafSnapshot("bnb-mainnet", () => {}), /needs GLOAM_RPC_URL_56/);
  checks++;
  process.env.GLOAM_RPC_URL_56 = "https://archive.example/bsc";
  ok(networkForChain(CHAIN_ID).key === "bnb-mainnet" && relayNetworks().some((n) => n.family === "bnb"), "on, with GLOAM_RPC_URL_56: the relay serves it");
  delete process.env.GLOAM_RPC_URL_56;
  ok(hourlySpendWei(CHAIN_ID, {}) === 50_000_000_000_000_000n, "on: the relay's hourly cap is 0.05 BNB by default");
  ok(hourlySpendWei(CHAIN_ID, { GLOAM_RELAY_HOURLY_SPEND_56: "0.2" }) === 200_000_000_000_000_000n, "on: GLOAM_RELAY_HOURLY_SPEND_56 changes it");
  ok(walkTuning(CHAIN_ID, e.logRange).span === 50_000n, "on: tree reads at publicnode's 50,000 blocks");
  ok(CSP_CONNECT_SOURCES.includes("https://bsc-rpc.publicnode.com") && CSP_CONNECT_SOURCES.includes("https://bsc-dataseed.bnbchain.org"), "on: the CSP allows its RPCs");
  ok(rpcProxyChainIds().includes(CHAIN_ID), "on: the RPC proxy serves 56 (the browser's way to old logs)");

  // Reads: the pruned-logs check, end to end through the app's own transports.
  const { createPublicClient } = await import("viem");
  const vaultLogs = { method: "eth_getLogs", params: [{ address: POOL, fromBlock: hex(134_300_000n), toBlock: hex(134_349_999n) }] } as const;
  const recentLogs = { method: "eth_getLogs", params: [{ address: POOL, fromBlock: hex(HEAD - 1_000n), toBlock: hex(HEAD) }] } as const;
  ok(readTransport(e)({}).config.type === "gloamPrunedGuard" && serverTransport(e)({}).config.type === "gloamPrunedGuard", "on: browser and server reads are guarded");
  ok(nets.getNetwork("base-mainnet").logCanary == null && readTransport(nets.getNetwork("base-mainnet"))({}).config.type !== "gloamPrunedGuard", "other networks read as before");

  // The server with no GLOAM_RPC_URL_56: publicnode answers [] for the vault's old blocks; that fails loudly.
  resetRpcChecks();
  const server = createPublicClient({ chain: e.chain, transport: serverTransport(e, { retryCount: 0 }) });
  await assert.rejects(server.request(vaultLogs as never), /no logs at block 134300000[\s\S]*GLOAM_RPC_URL_56/);
  checks++;
  ok(((await server.request(recentLogs as never)) as unknown[]).length === 0, "on: a recent empty range is trusted");
  ok(!asked.some((a) => a.method === "eth_getLogs" && a.url.includes("bsc-dataseed")), "on: the dataseed was never asked for logs");

  // The server with GLOAM_RPC_URL_56 set to an archive: the vault's old log comes back.
  process.env.GLOAM_RPC_URL_56 = "https://archive.example/bsc";
  resetRpcChecks();
  const keyed = createPublicClient({ chain: e.chain, transport: serverTransport(e, { retryCount: 0 }) });
  const got = (await keyed.request(vaultLogs as never)) as { blockNumber: string }[];
  ok(got.length === 1 && BigInt(got[0]!.blockNumber) === VAULT_LOG_BLOCK, "on: with GLOAM_RPC_URL_56 the old log is read");
  delete process.env.GLOAM_RPC_URL_56;
  resetRpcChecks();

  // The browser: the pruned answer is asked again of the proxy (the archive), which has it.
  const browser = createPublicClient({ chain: e.chain, transport: readTransport(e, { retryCount: 0 }, { proxy: "https://www.gloam.trade/api/rpc/56" }) });
  const viaProxy = (await browser.request(vaultLogs as never)) as { blockNumber: string }[];
  ok(viaProxy.length === 1 && asked.some((a) => a.url.includes("/api/rpc/56") && a.method === "eth_getLogs"), "on: the browser gets the old log through the proxy");

  // A range straddling the oldest block publicnode keeps: it answers only the newer log.
  // Never passed as the whole range: the server without a key fails loudly, the browser asks the proxy.
  const straddle = { method: "eth_getLogs", params: [{ address: POOL, fromBlock: hex(VAULT_LOG_BLOCK - 10n), toBlock: hex(VAULT_LOG_BLOCK_2) }] } as const;
  resetRpcChecks();
  await assert.rejects(createPublicClient({ chain: e.chain, transport: serverTransport(e, { retryCount: 0 }) }).request(straddle as never), /no logs at block/);
  checks++;
  const straddled = (await browser.request(straddle as never)) as unknown[];
  ok(straddled.length === 2, "on: a straddling range comes back whole through the proxy, never as its newer half");

  // GLOAM_RPC_URL_56 on a plan that takes 10,000 blocks a read. Its refusal reaches the caller, so
  // the walk splits the range, instead of the public RPC answering [] for blocks it dropped.
  for (const host of ["capped", "capped32005"]) {
    process.env.GLOAM_RPC_URL_56 = `https://${host}.example/bsc`;
    resetRpcChecks();
    const capped = createPublicClient({ chain: e.chain, transport: serverTransport(e, { retryCount: 0 }) });
    const wide = await capped.request(vaultLogs as never).then(
      (r) => r as unknown[],
      (err: unknown) => err as Error
    );
    ok(wide instanceof Error && /10,000 block range|limit exceeded/.test(String((wide as { details?: string }).details ?? wide.message)), `on: ${host}: a range the keyed RPC refuses is refused, never read as [] from the public RPC`);
    const before = asked.length;
    const narrow = (await capped.request({ method: "eth_getLogs", params: [{ address: POOL, fromBlock: hex(134_300_000n), toBlock: hex(134_309_999n) }] } as never)) as unknown[];
    ok(narrow.length === 1 && asked.slice(before).some((a) => a.url.includes(host) && a.method === "eth_getLogs"), `on: ${host}: the split range is read from the keyed RPC (not passed over)`);
  }
  delete process.env.GLOAM_RPC_URL_56;
  resetRpcChecks();

  // The browser with publicnode down: log reads go to the proxy through the check, as before.
  publicDown = true;
  const viaProxyDown = (await browser.request(vaultLogs as never)) as unknown[];
  publicDown = false;
  ok(viaProxyDown.length === 1, "on: with publicnode down the browser reads the old log through the proxy");

  // The proxy on 56 reads the server's paid archive RPC: only the app's own log reads.
  const { checkCall } = await import("../src/lib/rpcProxyServer");
  const call = (filter: Record<string, unknown>) => checkCall({ jsonrpc: "2.0", id: 1, method: "eth_getLogs", params: [filter] }, e);
  const refused = (r: ReturnType<typeof call>) => ("reply" in r ? (r.reply.error?.message ?? "") : null);
  const span = (a: bigint, b: bigint) => ({ fromBlock: hex(a), toBlock: hex(b) });
  const WALLET = `0x${"0".repeat(24)}${"ab".repeat(20)}`;
  const TRANSFER = `0x${"dd".repeat(32)}`;
  ok(refused(call({ address: POOL, ...span(134_300_000n, 134_349_999n) })) === null, "proxy: the vault over logRange blocks");
  ok(/maximum block range is 50000/.test(refused(call({ address: POOL, ...span(134_300_000n, 134_350_000n) })) ?? ""), "proxy: the vault over more is refused as a range a walk splits");
  ok(refused(call({ address: POOL, fromBlock: hex(134_300_000n), toBlock: "latest" })) === null, "proxy: the vault up to latest (the tree's tail read)");
  ok(refused(call({ address: USDT, ...span(134_300_000n, 134_300_002n) })) === null, "proxy: the canary's three blocks");
  ok(/maximum block range is 3/.test(refused(call({ address: USDT, ...span(134_300_000n, 134_300_003n) })) ?? ""), "proxy: USDT over more, with no wallet, is refused");
  ok(refused(call({ address: [USDT, USDC, BDX], topics: [TRANSFER, null, WALLET], ...span(134_300_000n, 134_349_999n) })) === null, "proxy: listed tokens narrowed to a wallet (activity)");
  ok(/only the Gloam vault/.test(refused(call({ address: "0x" + "12".repeat(20), ...span(134_300_000n, 134_300_001n) })) ?? ""), "proxy: any other contract is refused");
  ok(/only the Gloam vault/.test(refused(call({ address: [POOL, "0x" + "12".repeat(20)], ...span(134_300_000n, 134_300_001n) })) ?? ""), "proxy: a list with another contract is refused");
  ok(refused(checkCall({ jsonrpc: "2.0", id: 1, method: "eth_getLogs", params: [{ address: "0x" + "12".repeat(20), ...span(1n, 9_000_000n) }] }, nets.getNetwork("base-mainnet"))) === null, "proxy: other networks keep their rules");
}

if (MODE === "off") {
  for (const mode of ["nopool", "on", "nolivesince", "badpool"]) {
    const child = spawnSync(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url)], {
      env: { ...process.env, GLOAM_SELFTEST_BNB: mode },
      encoding: "utf8",
    });
    if (child.status !== 0) {
      console.error(child.stdout, child.stderr);
      assert.fail(`the ${mode} run failed`);
    }
    process.stdout.write(child.stdout);
    checks++;
  }
}
console.log(`selftest-bnb (${MODE}): ok (${checks} checks)`);
