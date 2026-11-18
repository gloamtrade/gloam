/**
 * SDK self-test: BNB Chain mainnet (56), before and after its pool is filled in,
 * and the pruned-logs guard its reads go through.
 *
 * BNB Chain stays hidden until the pool and its deploy block are in src/bnb.ts.
 * This file checks that state (chain 56 is a mainnet on the final keys either
 * way, and the builders refuse it by name), then runs itself again in a child
 * process with a placeholder pool put in before the SDK loads, so the network
 * can be checked: payments only, USDT and USDC with 18 decimals, BNB listed,
 * BDX with 9 decimals and its cap, no testnet, the memo board only once it is
 * in, and reads that fail loudly on a pruned RPC. Bad values (the testnet's id,
 * another Gloam chain's id, a plain http RPC, a keyed RPC in the file) throw.
 *
 * Nothing here reaches any host: fetch throws, and the RPCs are fakes.
 *
 * Run after build:  node test/bnb.selftest.mjs
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createPublicClient, custom, toHex } from "viem";

globalThis.fetch = async (url) => {
  throw new Error(`bnb selftest: no network calls allowed (${String(url)})`);
};

const bnb = await import("../dist/bnb.js");
const MODE = process.env.GLOAM_SELFTEST_BNB ?? (bnb.bnbMainnetConfig() ? "live" : "empty");

const POOL = "0x89d3042390204f57b8b4F8949D3c2203E4002164";
const MEMO = "0x00000000000000000000000000000000000b0b0e";
if (MODE === "filled" || MODE === "filled-memo") {
  Object.assign(bnb.BNB_MAINNET, {
    pool: POOL,
    deployBlock: 134_300_000n,
    ...(MODE === "filled-memo" ? { payMemo: MEMO, payMemoBlock: 134_300_100n } : {}),
  });
}
if (MODE === "keyed") {
  Object.assign(bnb.BNB_MAINNET, { rpcUrls: ["https://bnb-mainnet.g.alchemy.com/v2/abcdefghijklmnopqrstuvwx"] });
}
if (MODE === "keyed") {
  // The SDK builds its networks as it loads, so a keyed RPC in the file stops it there.
  let err = null;
  await import("../dist/index.js").catch((e) => (err = e));
  if (!err || !/API key/.test(err.message)) {
    console.error("FAIL: a keyed RPC in src/bnb.ts must stop the SDK from loading", err?.message);
    process.exit(1);
  }
  console.log("bnb selftest (keyed): 1 check passed");
  process.exit(0);
}
const sdk = await import("../dist/index.js");

let checks = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exit(1);
  }
  checks++;
}
async function rejects(p, re, msg) {
  try {
    await p;
  } catch (e) {
    assert(re.test(String(e?.message ?? e)), `${msg} (threw: ${e?.message ?? e})`);
    return e;
  }
  assert(false, `${msg} (did not throw)`);
}
function throws(fn, re, msg) {
  try {
    fn();
  } catch (e) {
    assert(re.test(String(e?.message ?? e)), `${msg} (threw: ${e?.message ?? e})`);
    return;
  }
  assert(false, `${msg} (did not throw)`);
}

const NO_LIMIT = (1n << 128n) - 1n;
const USDT = "0x55d398326f99059fF775485246999027B3197955";
const USDC = "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d";
const BDX = "0x6ad12E761b438beA3EA09F6C6266556Bb24C2181";
const ZERO = "0x0000000000000000000000000000000000000000";

// ── the values, pool or not ────────────────────────────────────────────────────────
{
  assert(sdk.BNB_MAINNET_CHAIN_ID === 56 && bnb.BNB_MAINNET.chainId === 56, "chain id 56");
  assert(bnb.BNB_MAINNET.usdt.address === USDT && bnb.BNB_MAINNET.usdt.decimals === 18, "USDT, 18 decimals (checked on chain)");
  assert(bnb.BNB_MAINNET.usdc.address === USDC && bnb.BNB_MAINNET.usdc.decimals === 18, "USDC, 18 decimals (checked on chain)");
  assert(bnb.BNB_MAINNET.bdx.address === BDX && bnb.BNB_MAINNET.bdx.decimals === 9, "BDX OFT, 9 decimals, the same address as on Base and Ethereum");
  assert(sdk.BASE_BDX === BDX, "one BDX address on Base and BNB Chain");
  assert(bnb.BNB_MAINNET.rpcUrls[0] === "https://bsc-rpc.publicnode.com", "first RPC answers eth_getLogs (recent blocks)");
  assert(bnb.BNB_NO_LOG_RPCS.includes("https://bsc-dataseed.bnbchain.org"), "the dataseed refuses log reads");
  assert(sdk.BNB_MAINNET_CHAIN.id === 56 && sdk.BNB_MAINNET_CHAIN.nativeCurrency.symbol === "BNB", "viem chain: 56, gas in BNB");
  assert(sdk.BNB_MAINNET_CHAIN.rpcUrls.default.http[0] === "https://bsc-rpc.publicnode.com", "viem chain carries the file's RPCs");
  assert(sdk.BNB_MAINNET_CHAIN.contracts?.multicall3?.address?.toLowerCase() === "0xca11bde05977b3631167028862be2a173976ca11", "Multicall3 at its usual address");

  // limits are in each token's own decimals
  const assets = sdk.bnbMainnetAssets();
  assert(assets.map((a) => a.symbol).join(",") === "USDT,USDC,BNB,BDX", "USDT, USDC, BNB, BDX");
  const by = Object.fromEntries(assets.map((a) => [a.symbol, a]));
  assert(by.USDT.decimals === 18 && by.USDC.decimals === 18 && by.BNB.decimals === 18 && by.BDX.decimals === 9, "decimals per asset");
  assert(by.BNB.address === ZERO, "BNB is the vault's address(0)");
  for (const s of ["USDT", "USDC", "BNB"]) assert(by[s].depositLimit.perDeposit === NO_LIMIT && by[s].depositLimit.total === NO_LIMIT, `${s}: no limit, like Base`);
  assert(by.BDX.depositLimit.perDeposit === 100_000n * 10n ** 9n && by.BDX.depositLimit.total === 2_000_000n * 10n ** 9n, "BDX capped at 100,000 / 2,000,000 in 9 decimals");
  assert(sdk.isNoLimit(by.USDT.depositLimit.perDeposit) && !sdk.isNoLimit(by.BDX.depositLimit.perDeposit), "isNoLimit reads max as no limit, BDX's cap as a cap");

  // a stablecoin limit is never in 6 decimals by accident
  assert(sdk.stableLimitFor(6).perDeposit === 50_000_000_000n, "50,000 at 6 decimals");
  assert(sdk.stableLimitFor(18).perDeposit === 50_000n * 10n ** 18n && sdk.stableLimitFor(18).total === 2_500_000n * 10n ** 18n, "50,000 / 2,500,000 at 18 decimals");
  throws(() => sdk.stableLimitFor(-1), /decimals/, "a negative decimals count is refused");
  const base = sdk.mainnetNetwork("base");
  if (base) assert(base.assets.find((a) => a.symbol === "USDC").depositLimit.perDeposit === 50_000_000_000n, "Base USDC keeps its 6-decimal snapshot");

  // chain 56 is a mainnet on the final keys, pool or not
  assert(sdk.isMainnetChainId(56) && sdk.isPaymentsPoolChainId(56), "56 is a mainnet payments pool");
  assert(sdk.ceremonyForChainId(56) === "production", "a proof for 56 uses the final keys");
  assert(sdk.circuitArtifactUrls("shield", 56).zkey.endsWith("/final/shield_final.zkey"), "final-key artifacts for 56");
  assert(sdk.networkName(56) === "BNB Chain", "named BNB Chain");
  assert(!sdk.isMainnetChainId(97) && sdk.ceremonyForChainId(97) === "dev", "97, BNB's testnet, is not a Gloam chain");
  assert(sdk.testnetNetwork("bnb") === null, "no Gloam testnet on BNB Chain");

  // bad values throw
  const good = { ...bnb.BNB_MAINNET, pool: POOL, deployBlock: 1n };
  throws(() => bnb.checkBnbMainnet({ ...good, chainId: 97 }), /testnet/, "the testnet's id is refused");
  throws(() => bnb.checkBnbMainnet({ ...good, chainId: 8453 }), /another chain Gloam runs on/, "Base's id is refused");
  throws(() => bnb.checkBnbMainnet({ ...good, chainId: 99901 }), /another chain Gloam runs on/, "Elysium's id is refused");
  throws(() => bnb.checkBnbMainnet({ ...good, chainId: 57 }), /must be 56/, "any other id is refused");
  throws(() => bnb.checkBnbMainnet({ ...good, rpcUrls: ["http://bsc.example"] }), /https/, "a plain http RPC is refused");
  throws(() => bnb.checkBnbMainnet({ ...good, rpcUrls: [] }), /at least one/, "no RPC is refused");
  throws(() => bnb.checkBnbMainnet({ ...good, pool: ZERO }), /pool/, "the zero address is not a pool");
  throws(() => bnb.checkBnbMainnet({ ...good, deployBlock: 0n }), /deploy block/, "block 0 is not a deploy block");
  throws(() => bnb.checkBnbMainnet({ ...good, usdt: { address: USDT, decimals: 77 } }), /decimals/, "a wrong decimals count is refused");
  throws(() => bnb.checkBnbMainnet({ ...good, payMemo: MEMO, payMemoBlock: null }), /payMemoBlock/, "a board needs its block");
  assert(bnb.checkBnbMainnet({ ...good, pool: null }) === null, "no pool: not there yet");
  assert(bnb.checkBnbMainnet({ ...good, explorerUrl: "https://bscscan.com/" }).explorerUrl === "https://bscscan.com", "explorer trailing slash dropped");
}

// ── before the pool is in ──────────────────────────────────────────────────────────
if (MODE === "empty") {
  assert(bnb.bnbMainnetConfig() === null, "no pool: no config");
  assert(sdk.mainnetNetwork("bnb") === null, "no pool: no mainnet network");
  assert(!sdk.gloamNetworks().some((n) => n.chainId === 56), "no pool: not in gloamNetworks()");
  assert(sdk.networkForChainId(56) === undefined, "no pool: networkForChainId(56) is nothing");
  throws(() => sdk.poolForChainId(56), /BNB Chain mainnet is not in this version/, "builders refuse 56 by name");
  assert(!(56 in sdk.PAY_MEMO_BOARDS) || sdk.PAY_MEMO_BOARDS[56] === null, "no board yet");
}

// ── with the pool in ────────────────────────────────────────────────────────────────
if (MODE === "filled" || MODE === "filled-memo" || MODE === "live") {
  const n = sdk.mainnetNetwork("bnb");
  assert(n && n.key === "bnb-mainnet" && n.label === "BNB Chain" && n.family === "bnb", "the network");
  assert(n.chainId === 56 && !n.testnet && n.ceremony === "production" && n.nativeShield, "mainnet, final keys, BNB deposits allowed");
  if (MODE !== "live") assert(n.pool === POOL && n.deployBlock === 134_300_000n, "pool and deploy block from the file");
  assert(n.rpcUrl === "https://bsc-rpc.publicnode.com" && n.explorerUrl === "https://bscscan.com" && n.historyRpc === null, "RPC and explorer");
  assert(n.logCanary && n.logCanary.address === USDT && n.logCanary.trustRecentBlocks === 100_000n, "reads carry the pruned-logs canary (USDT)");
  assert(sdk.gloamReadTransport(n)({}).config.type === "gloamPrunedGuard", "gloamReadTransport guards BNB reads");
  assert(sdk.gloamNetworks().at(-1 - sdk.gloamNetworks().filter((x) => x.testnet).length).key === "bnb-mainnet", "BNB Chain is the last mainnet");
  assert(sdk.networkForChainId(56) === n && sdk.getGloamNetwork("bnb-mainnet") === n, "found by chain id and key");
  assert(sdk.poolForChainId(56) === n.pool, "builders find the pool");
  sdk.assertDepositAllowed(56, ZERO, 1n);
  sdk.assertDepositAllowed(56, USDT, 10n ** 18n);
  sdk.assertDepositAllowed(56, BDX, 10n ** 9n);
  throws(() => sdk.assertDepositAllowed(56, "0x0000000000000000000000000000000000001234", 1n), /does not list/, "an unlisted token is refused");
  assert(sdk.cashOutTargetProblem(n.pool, { chainId: 56 }) === sdk.CASH_OUT_TO_VAULT_MESSAGE, "cash out to the vault refused");
  assert(sdk.cashOutTargetProblem(USDT, { chainId: 56 }) === sdk.CASH_OUT_TO_TOKEN_MESSAGE, "cash out to USDT refused");
  assert(sdk.cashOutTargetProblem(bnb.BNB_WBNB, { chainId: 56 }) === sdk.CASH_OUT_TO_TOKEN_MESSAGE, "cash out to WBNB refused");
  assert(sdk.cashOutTargetProblem("0x76b7E410a227c888aBD2Bdc24Ee32E094B0FD4D8", { chainId: 56 }) === null, "a wallet is fine");
  assert(sdk.treeLogRange(56) === 50_000n, "50,000 blocks a log read (publicnode)");
  await rejects(sdk.planVaultSwap(null, 56, { assetIn: USDT, assetOut: USDC, amountIn: 1n, feeBps: 50 }), /not on BNB Chain yet/, "a swap on BNB Chain is refused by name");
  if (MODE === "filled") assert(n.payMemo === null && !sdk.PAY_MEMO_BOARDS[56], "no board until it is in");
  if (MODE === "filled-memo") {
    assert(n.payMemo === MEMO, "board on the network");
    assert(sdk.PAY_MEMO_BOARDS[56]?.address === MEMO && sdk.PAY_MEMO_BOARDS[56].deployBlock === 134_300_100n, "board scanned for incoming payments");
    assert(sdk.cashOutTargetProblem(MEMO, { chainId: 56 }) === sdk.CASH_OUT_TO_BOARD_MESSAGE, "cash out to the board refused");
  }
}

// ── the pruned-logs guard ───────────────────────────────────────────────────────────
if (MODE === "empty" || MODE === "live") {
  const HEAD = 134_500_000n;
  const CANARY = { ...bnb.BNB_LOG_CANARY };
  /** A fake RPC: logs for `address` only from `keepsFrom` on (older ones: an empty list, like publicnode). */
  function fakeRpc({ keepsFrom, vaultLogs = [] }) {
    const asked = [];
    const request = async ({ method, params }) => {
      asked.push({ method, params });
      if (method === "eth_blockNumber") return toHex(HEAD);
      if (method === "eth_chainId") return "0x38";
      if (method === "eth_getLogs") {
        const f = params[0];
        if (f.blockHash || !f.fromBlock || f.fromBlock === "latest") return [];
        const from = BigInt(f.fromBlock);
        const to = f.toBlock ? BigInt(f.toBlock) : HEAD;
        if (to < keepsFrom) return [];
        if (f.address === CANARY.address) return [{ blockNumber: toHex(from), address: CANARY.address }];
        return vaultLogs.filter((l) => BigInt(l.blockNumber) >= from && BigInt(l.blockNumber) <= to && BigInt(l.blockNumber) >= keepsFrom);
      }
      return null;
    };
    return { asked, transport: custom({ request }) };
  }
  const client = (t) => createPublicClient({ transport: t });
  const logs = (from, to, address = POOL) => ({ method: "eth_getLogs", params: [{ address, fromBlock: toHex(from), toBlock: toHex(to) }] });
  const canaryAsks = (asked) => asked.filter((a) => a.method === "eth_getLogs" && a.params[0].address === CANARY.address).length;

  // an RPC that keeps everything: empty old ranges are checked once each, then trusted
  {
    const rpc = fakeRpc({ keepsFrom: 0n });
    const c = client(sdk.guardPrunedLogs(rpc.transport, CANARY));
    const out = await c.request(logs(134_000_000n, 134_049_999n));
    assert(Array.isArray(out) && out.length === 0, "archive RPC: an empty old range is real");
    assert(canaryAsks(rpc.asked) === 1, "one canary read for it");
  }
  // an old non-empty answer is checked too (it could be the newer part of a pruned range);
  // recent ranges pass with no extra read
  {
    const rpc = fakeRpc({ keepsFrom: 0n, vaultLogs: [{ blockNumber: toHex(134_000_010n), address: POOL }] });
    const c = client(sdk.guardPrunedLogs(rpc.transport, CANARY));
    assert((await c.request(logs(134_000_000n, 134_049_999n))).length === 1, "logs come back as they are");
    assert(canaryAsks(rpc.asked) === 1, "one canary read for the old range");
    assert((await c.request(logs(HEAD - 1_000n, HEAD))).length === 0, "a recent empty range passes");
    assert(canaryAsks(rpc.asked) === 1, "no canary read for the recent one");
  }
  // a range straddling the oldest block a pruned RPC keeps: publicnode answers only its newer part
  {
    const keepsFrom = HEAD - 220_000n;
    const vaultLogs = [{ blockNumber: toHex(keepsFrom - 10n), address: POOL }, { blockNumber: toHex(keepsFrom + 10n), address: POOL }];
    const rpc = fakeRpc({ keepsFrom, vaultLogs });
    const c = client(sdk.guardPrunedLogs(rpc.transport, CANARY));
    await rejects(c.request(logs(keepsFrom - 20n, keepsFrom + 20n)), /has no logs at block/, "a partial answer fails loudly, never passes as the whole range");
    const archive = fakeRpc({ keepsFrom: 0n, vaultLogs });
    const c2 = client(sdk.guardPrunedLogs(rpc.transport, CANARY, { archive: archive.transport }));
    assert((await c2.request(logs(keepsFrom - 20n, keepsFrom + 20n))).length === 2, "with an archive, both logs come back");
  }
  // each RPC's proven block is kept for a while: a walk from the deploy block asks the canary once
  {
    const rpc = fakeRpc({ keepsFrom: 0n });
    const c = client(sdk.guardPrunedLogs(rpc.transport, CANARY));
    for (let s = 134_000_000n; s < 134_250_000n; s += 50_000n) await c.request(logs(s, s + 49_999n));
    assert(canaryAsks(rpc.asked) === 1, "five old ranges, one canary read");
    await c.request(logs(133_900_000n, 133_949_999n));
    assert(canaryAsks(rpc.asked) === 2, "an older range than the proven block is checked again");
    const fresh = fakeRpc({ keepsFrom: 0n });
    const c2 = client(sdk.guardPrunedLogs(fresh.transport, CANARY, { floorTtlMs: 0 }));
    await c2.request(logs(134_000_000n, 134_049_999n));
    await c2.request(logs(134_050_000n, 134_099_999n));
    assert(canaryAsks(fresh.asked) === 2, "once the proof is stale, the canary is asked again");
  }
  // archiveOnError: a log read the RPC fails goes to the archive, whose answer is checked too
  {
    const down = { asked: [], transport: custom({ request: async ({ method }) => { if (method === "eth_blockNumber") return toHex(HEAD); throw new Error("upstream down"); } }) };
    const archive = fakeRpc({ keepsFrom: 0n, vaultLogs: [{ blockNumber: toHex(134_000_010n), address: POOL }] });
    const c = client(sdk.guardPrunedLogs(down.transport, CANARY, { archive: archive.transport, archiveOnError: true }));
    assert((await c.request(logs(134_000_000n, 134_049_999n))).length === 1, "the archive answers when the RPC is down");
    const prunedArchive = fakeRpc({ keepsFrom: HEAD - 220_000n });
    const c2 = client(sdk.guardPrunedLogs(down.transport, CANARY, { archive: prunedArchive.transport, archiveOnError: true }));
    await rejects(c2.request(logs(134_000_000n, 134_049_999n)), /upstream down/, "a pruned archive's answer is refused, and the RPC's own error is thrown");
    const c3 = client(sdk.guardPrunedLogs(down.transport, CANARY, { archive: archive.transport }));
    await rejects(c3.request(logs(134_000_000n, 134_049_999n)), /upstream down/, "without archiveOnError the RPC's error stands");
  }
  // a pruned RPC (publicnode: about 220,000 blocks): an empty old range throws
  {
    const rpc = fakeRpc({ keepsFrom: HEAD - 220_000n });
    const c = client(sdk.guardPrunedLogs(rpc.transport, CANARY));
    const e = await rejects(c.request(logs(134_000_000n, 134_049_999n)), /has no logs at block 134000000/, "pruned RPC: an empty old range fails loudly");
    assert(e.name === "PrunedLogsError" || e.cause?.name === "PrunedLogsError" || /GLOAM_RPC_URL_56/.test(e.message), "the error names what to set");
    assert((await c.request(logs(HEAD - 150_000n, HEAD - 100_001n))).length === 0, "inside what it keeps: an empty range is real");
    assert((await c.request(logs(HEAD - 500n, HEAD))).length === 0, "recent: passes");
  }
  // with an archive (in the app: gloam.trade's proxy), a pruned answer is asked again there
  {
    const pruned = fakeRpc({ keepsFrom: HEAD - 220_000n });
    const archive = fakeRpc({ keepsFrom: 0n, vaultLogs: [{ blockNumber: toHex(134_000_010n), address: POOL }] });
    const c = client(sdk.guardPrunedLogs(pruned.transport, CANARY, { archive: archive.transport }));
    assert((await c.request(logs(134_000_000n, 134_049_999n))).length === 1, "the archive answers what the pruned RPC dropped");
    const emptyArchive = fakeRpc({ keepsFrom: 0n });
    const c2 = client(sdk.guardPrunedLogs(pruned.transport, CANARY, { archive: emptyArchive.transport }));
    assert((await c2.request(logs(134_000_000n, 134_049_999n))).length === 0, "an archive's empty answer is real once its canary shows");
    const prunedArchive = fakeRpc({ keepsFrom: HEAD - 220_000n });
    const c3 = client(sdk.guardPrunedLogs(pruned.transport, CANARY, { archive: prunedArchive.transport }));
    await rejects(c3.request(logs(134_000_000n, 134_049_999n)), /has no logs/, "a pruned archive fails loudly too");
  }
  // ranges the canary says nothing about, and other methods
  {
    const rpc = fakeRpc({ keepsFrom: HEAD - 220_000n });
    const c = client(sdk.guardPrunedLogs(rpc.transport, CANARY));
    assert((await c.request(logs(1n, 99_999_999n))).length === 0, "a range that ends before the canary logs passes");
    assert((await c.request({ method: "eth_getLogs", params: [{ address: POOL, blockHash: "0x" + "ab".repeat(32) }] })).length === 0, "by block hash passes");
    assert((await c.request({ method: "eth_getLogs", params: [{ address: POOL, fromBlock: "latest" }] })).length === 0, "from latest passes");
    assert((await c.request({ method: "eth_chainId" })) === "0x38", "other methods pass through");
    assert(canaryAsks(rpc.asked) === 0, "none of these asks the canary");
  }
  // through the network's own read transport (a pruned default RPC behind it fails loudly)
  {
    const net = { rpcUrl: "https://bsc-rpc.publicnode.com", historyRpc: null, logCanary: CANARY };
    assert(sdk.gloamReadTransport(net)({}).config.type === "gloamPrunedGuard", "a network with a canary reads through the guard");
    assert(sdk.gloamReadTransport({ rpcUrl: "https://mainnet.base.org", historyRpc: null })({}).config.type === "http", "others: plain http, as before");
  }
}

console.log(`bnb selftest (${MODE}): ${checks} checks passed`);

// ── the other states, each in its own process ──────────────────────────────────────
if (!process.env.GLOAM_SELFTEST_BNB && MODE === "empty") {
  const self = fileURLToPath(import.meta.url);
  for (const mode of ["filled", "filled-memo", "keyed"]) {
    const r = spawnSync(process.execPath, [self], { env: { ...process.env, GLOAM_SELFTEST_BNB: mode }, encoding: "utf8" });
    process.stdout.write(r.stdout);
    if (r.status !== 0) {
      process.stderr.write(r.stderr);
      console.error(`FAIL: bnb selftest (${mode}) exited ${r.status}`);
      process.exit(1);
    }
  }
}
