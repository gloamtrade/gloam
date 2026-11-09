/**
 * SDK self-test: Elysium mainnet, before and after its values are filled in.
 *
 * Elysium stays hidden until every value in src/elysium.ts is in (chain id,
 * RPC, explorer, USDC, pool and deploy block). This file checks that state,
 * then runs itself again in a child process with placeholder values put in
 * before the SDK loads, so the rest of the SDK can be checked against them: the
 * final keys, payments only, USDC alone with the launch limits, HYPE as the gas
 * coin and not listed, no testnet, and the memo board only once it is in. Bad
 * values (the testnet's id, another Gloam chain's id, a plain http RPC, a pool
 * that is not an address) throw instead of hiding the chain.
 *
 * The testnet (99801, ELYSIUM_TESTNET) the same way: hidden while its pool is
 * not in, then a child run with a placeholder pool ("testnet") checks it is a
 * testnet on the final keys with test USDC only and gas in HYPE. A keyed RPC in
 * the file, or a wrong testnet chain id, throws.
 *
 * Run after build:  node test/elysium.selftest.mjs
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const elysium = await import("../dist/elysium.js");
const LIVE = elysium.elysiumMainnetConfig();
const MODE = process.env.GLOAM_SELFTEST_ELYSIUM ?? (LIVE ? "live" : "empty");

// Placeholders, put in before constants.js loads (the networks are built from them).
const CHAIN_ID = 99901;
const TESTNET_ID = 99801;
const TESTNET_USDC = "0x7D29d8047B905000459c0E80c34a26CeedcB47b2";
const POOL = "0x39E28Cde55CAB798874746ac52cb4B5Cc99a0194";
const USDC = "0x00000000000000000000000000000000000e1a5c";
const MEMO = "0x00000000000000000000000000000000000e1a5e";
if (MODE === "filled" || MODE === "filled-memo") {
  Object.assign(elysium.ELYSIUM_MAINNET, {
    chainId: CHAIN_ID,
    rpcUrl: "https://rpc.elysium.example",
    explorerUrl: "https://explorer.elysium.example/",
    usdc: USDC,
    usdcDecimals: 6,
    pool: POOL,
    deployBlock: 1_234n,
    ...(MODE === "filled-memo" ? { payMemo: MEMO, payMemoBlock: 1_240n } : {}),
  });
}
if (MODE === "testnet") {
  Object.assign(elysium.ELYSIUM_TESTNET, { pool: POOL, deployBlock: 5_678n, payMemo: MEMO, payMemoBlock: 5_700n });
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
function throws(fn, re, msg) {
  try {
    fn();
  } catch (e) {
    assert(re.test(String(e?.message ?? e)), `${msg}: wrong error "${e?.message}"`);
    return;
  }
  assert(false, `${msg}: did not throw`);
}

const base = {
  chainId: CHAIN_ID,
  rpcUrl: "https://rpc.elysium.example",
  explorerUrl: "https://explorer.elysium.example",
  usdc: USDC,
  usdcDecimals: 6,
  pool: POOL,
  deployBlock: 1n,
  payMemo: null,
  payMemoBlock: null,
};

// Checks on the values themselves, in every mode.
assert(sdk.checkElysiumMainnet({ ...base, chainId: null }) === null, "a missing chain id hides Elysium");
assert(sdk.checkElysiumMainnet({ ...base, pool: null }) === null, "a missing pool hides Elysium");
assert(sdk.checkElysiumMainnet({ ...base, deployBlock: null }) === null, "a missing deploy block hides Elysium");
assert(sdk.checkElysiumMainnet({ ...base, usdc: null }) === null, "a missing USDC hides Elysium");
throws(() => sdk.checkElysiumMainnet({ ...base, chainId: 99801 }), /testnet/, "the testnet id is refused");
for (const id of [1, 4663, 4217, 8453, 46630, 42431, 84532, 11155111, 990_001]) {
  throws(() => sdk.checkElysiumMainnet({ ...base, chainId: id }), /must be 99901|another chain Gloam runs on/, `chain ${id} is refused`);
}
assert(sdk.ELYSIUM_MAINNET_CHAIN_ID === 99901 && sdk.ELYSIUM_MAINNET.chainId === 99901, "mainnet's id is in: 99901");
throws(() => sdk.checkElysiumMainnet({ ...base, rpcUrl: "http://rpc.elysium.example" }), /https/, "a plain http RPC is refused");
throws(() => sdk.checkElysiumMainnet({ ...base, explorerUrl: "elysium" }), /https/, "an explorer that is not a URL is refused");
throws(() => sdk.checkElysiumMainnet({ ...base, usdc: "0x0000000000000000000000000000000000000000" }), /usdc/, "a zero USDC is refused");
throws(() => sdk.checkElysiumMainnet({ ...base, pool: "0x1234" }), /pool/, "a short pool is refused");
throws(() => sdk.checkElysiumMainnet({ ...base, deployBlock: 0n }), /deployBlock/, "block 0 is refused");
throws(() => sdk.checkElysiumMainnet({ ...base, payMemo: MEMO }), /payMemoBlock/, "a board without its block is refused");
assert(sdk.checkElysiumMainnet({ ...base, explorerUrl: "https://x.example//" }).explorerUrl === "https://x.example", "trailing slashes come off the explorer");
assert(sdk.ELYSIUM_NATIVE_CURRENCY.symbol === "HYPE" && sdk.ELYSIUM_NATIVE_CURRENCY.decimals === 18, "HYPE, 18 decimals");
assert(sdk.ELYSIUM_TESTNET_CHAIN_ID === 99801, "the testnet id");

// The testnet's values: Kinetiq's published ones, no pool yet.
const tbase = { ...sdk.ELYSIUM_TESTNET, pool: POOL, deployBlock: 1n, payMemo: null, payMemoBlock: null };
assert(sdk.ELYSIUM_TESTNET.chainId === TESTNET_ID && sdk.ELYSIUM_TESTNET.usdc === TESTNET_USDC && sdk.ELYSIUM_TESTNET.usdcDecimals === 6, "testnet: id and test USDC");
assert(sdk.ELYSIUM_TESTNET.rpcUrl === "https://testnet-rpc.elysium.kinetiq.xyz", "testnet: its public RPC");
assert(sdk.checkElysiumTestnet({ ...tbase, pool: null }) === null, "testnet: a missing pool hides it");
assert(sdk.checkElysiumTestnet(tbase).chainId === TESTNET_ID, "testnet: its values pass");
for (const id of [CHAIN_ID, 46630, 84532, 990_001]) {
  throws(() => sdk.checkElysiumTestnet({ ...tbase, chainId: id }), /must be 99801/, `testnet: chain ${id} is refused`);
}
throws(() => sdk.checkElysiumTestnet({ ...tbase, rpcUrl: "http://x.example" }), /https/, "testnet: a plain http RPC is refused");
throws(() => sdk.checkElysiumTestnet({ ...tbase, usdc: "0x0000000000000000000000000000000000000000" }), /usdc/, "testnet: a zero USDC is refused");

// An API key in the file's RPC is refused, for both networks; redactRpcUrl hides keys.
for (const [cfg, read, name] of [
  [sdk.ELYSIUM_TESTNET, sdk.elysiumTestnetConfig, "testnet"],
  [sdk.ELYSIUM_MAINNET, sdk.elysiumMainnetConfig, "mainnet"],
]) {
  const before = cfg.rpcUrl;
  cfg.rpcUrl = "https://elysium-mainnet.g.alchemy.com/v2/abcDEF1234567890xyz";
  throws(() => read(), /API key/, `${name}: a keyed RPC in the file is refused`);
  cfg.rpcUrl = "https://rpc.example/?apikey=secret123";
  throws(() => read(), /API key/, `${name}: a key in the query is refused`);
  cfg.rpcUrl = before;
}
for (const [url, want] of [
  ["https://elysium-mainnet.g.alchemy.com/v2/abcDEF1234567890xyz", "https://elysium-mainnet.g.alchemy.com/v2/{API_KEY}"],
  ["https://mainnet.infura.io/v3/0123456789abcdef0123456789abcdef", "https://mainnet.infura.io/v3/{API_KEY}"],
  ["https://rpc.example/x?key=abc&chain=1", "https://rpc.example/x?key={API_KEY}&chain=1"],
  ["https://rpc.example/abcdefghijklmnopqrstuvwxyz012345", "https://rpc.example/{API_KEY}"],
  ["https://testnet-rpc.elysium.kinetiq.xyz", "https://testnet-rpc.elysium.kinetiq.xyz"],
  [sdk.ELYSIUM_TESTNET_RPC_FALLBACK, sdk.ELYSIUM_TESTNET_RPC_FALLBACK],
  ["https://rpc.example/v1", "https://rpc.example/v1"],
]) {
  assert(sdk.redactRpcUrl(url) === want, `redactRpcUrl(${url}) is ${want}, got ${sdk.redactRpcUrl(url)}`);
}
assert(sdk.networkName(TESTNET_ID) === "Elysium testnet", "networkName(99801)");
assert(!sdk.isMainnetChainId(TESTNET_ID), "99801 is never mainnet");
assert(sdk.ceremonyForChainId(TESTNET_ID) === "production", "a proof for the testnet uses the final keys, pool or not");
await (async () => {
  try {
    await sdk.planVaultSwap({}, TESTNET_ID, { assetIn: TESTNET_USDC, assetOut: TESTNET_USDC, amountIn: 1n, feeBps: 50 });
    assert(false, "a swap on Elysium testnet is refused");
  } catch (e) {
    assert(/not on Elysium yet/.test(String(e?.message)), `a swap on Elysium testnet is refused by name: ${e?.message}`);
  }
})();

if (MODE === "testnet") {
  const t = sdk.testnetNetwork("elysium");
  assert(t !== null, "testnet: Elysium testnet is a network");
  assert(t.key === "elysium" && t.label === "Elysium" && t.family === "elysium" && t.testnet, "testnet: key, label, family, testnet");
  assert(t.chainId === TESTNET_ID && t.ceremony === "production", "testnet: 99801 on the final keys");
  assert(t.chain.nativeCurrency.symbol === "HYPE" && t.chain.testnet === true, "testnet: gas in HYPE");
  assert(t.nativeShield === false, "testnet: HYPE is not listed");
  assert(t.assets.length === 1 && t.assets[0].symbol === "USDC" && t.assets[0].address === TESTNET_USDC, "testnet: test USDC only");
  assert(t.assets[0].depositLimit.perDeposit === 500_000_000n && t.assets[0].depositLimit.total === 25_000_000_000n, "testnet: Base Sepolia's 500 / 25,000");
  assert(t.rpcUrl === "https://testnet-rpc.elysium.kinetiq.xyz" && t.explorerUrl === "https://elysium.kinetiq.xyz/testnet-explorer", "testnet: RPC and explorer");
  assert(sdk.getGloamNetwork("elysium") === t && sdk.networkForChainId(TESTNET_ID) === t, "testnet: found by key and chain id");
  assert(sdk.gloamNetworks().at(-1) === t, "testnet: listed last, after the other testnets");
  assert(sdk.poolForChainId(TESTNET_ID).toLowerCase() === POOL.toLowerCase(), "testnet: the builders find its pool");
  assert(sdk.payMemoBoardFor(TESTNET_ID)?.address.toLowerCase() === MEMO.toLowerCase() && t.payMemo === MEMO, "testnet: its board");
  assert(sdk.mainnetNetwork("elysium") === null || LIVE, "testnet: mainnet stays hidden without its values");
  assert(sdk.circuitArtifactUrls("shield", TESTNET_ID).zkey.endsWith("/final/shield_final.zkey"), "testnet: final-key zkey");
  throws(() => sdk.assertDepositAllowed(TESTNET_ID, sdk.NATIVE_ASSET, 1n), /no native deposits/, "testnet: a HYPE deposit is refused");
} else if (MODE === "empty") {
  assert(sdk.elysiumMainnetConfig() === null, "empty: no config");
  assert(sdk.elysiumTestnetConfig() === null, "empty: no testnet config");
  assert(sdk.mainnetNetwork("elysium") === null, "empty: no mainnet network");
  assert(sdk.testnetNetwork("elysium") === null, "empty: no testnet network");
  assert(!sdk.gloamNetworks().some((n) => n.family === "elysium"), "empty: not in gloamNetworks");
  assert(sdk.elysiumMainnetChain() === null, "empty: no chain");
  assert(sdk.elysiumMainnetAssets().length === 0, "empty: no assets");
  assert(sdk.networkName(CHAIN_ID) === "Elysium" && sdk.isMainnetChainId(CHAIN_ID), "empty: 99901 is known as Elysium mainnet");
  assert(sdk.ceremonyForChainId(CHAIN_ID) === "production", "empty: proofs for it use the final keys");
  throws(() => sdk.poolForChainId(CHAIN_ID), /not in this version/, "empty: its pool is refused by name, not guessed");
  throws(() => sdk.poolForChainId(TESTNET_ID), /Elysium testnet.*not in this version/, "empty: the testnet's pool too");
  // The other chains are untouched.
  assert(sdk.gloamNetworks().length >= 8, "the other networks are all there");

  for (const mode of ["filled", "filled-memo", "testnet"]) {
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
      env: { ...process.env, GLOAM_SELFTEST_ELYSIUM: mode },
      encoding: "utf8",
    });
    if (child.status !== 0) {
      console.error(child.stdout, child.stderr);
      assert(false, `the ${mode} run failed`);
    }
    process.stdout.write(child.stdout);
    checks++;
  }
} else {
  const id = LIVE?.chainId ?? CHAIN_ID;
  const net = sdk.mainnetNetwork("elysium");
  assert(net !== null, "filled: Elysium is a mainnet network");
  assert(net.key === "elysium-mainnet" && net.label === "Elysium" && net.family === "elysium", "filled: key, label, family");
  assert(net.chainId === id && !net.testnet, "filled: chain id, mainnet");
  assert(net.ceremony === "production", "filled: final keys");
  assert(sdk.ceremonyForChainId(id) === "production", "filled: proofs for it use the final keys");
  assert(sdk.isMainnetChainId(id) && sdk.isPaymentsPoolChainId(id), "filled: a mainnet payments pool");
  assert(sdk.networkName(id) === "Elysium", "filled: its name");
  assert(sdk.networkForChainId(id) === net, "filled: found by chain id");
  assert(sdk.getGloamNetwork("elysium-mainnet") === net, "filled: found by key");
  assert(sdk.poolForChainId(id).toLowerCase() === net.pool.toLowerCase(), "filled: the builders find its pool");
  assert(net.chain.nativeCurrency.symbol === "HYPE", "filled: gas in HYPE");
  assert(net.nativeShield === false, "filled: HYPE is not listed");
  assert(net.assets.length === 1 && net.assets[0].symbol === "USDC", "filled: USDC only");
  if (!LIVE) {
    assert(net.assets[0].depositLimit.perDeposit === 500_000_000n && net.assets[0].depositLimit.total === 25_000_000_000n, "filled: 500 / 25,000 USDC");
    assert(net.explorerUrl === "https://explorer.elysium.example", "filled: explorer without the slash");
  }
  assert(sdk.testnetNetwork("elysium") === null, "filled: no testnet");
  assert(sdk.gloamNetworks().filter((n) => !n.testnet).at(-1) === net, "filled: listed after the other mainnets");
  throws(() => sdk.assertDepositAllowed(id, sdk.NATIVE_ASSET, 1n), /no native deposits/, "filled: a HYPE deposit is refused");
  throws(() => sdk.assertDepositAllowed(id, "0x00000000000000000000000000000000000000aa", 1n), /does not list/, "filled: an unlisted token is refused");
  sdk.assertDepositAllowed(id, net.assets[0].address, 1n);
  assert(sdk.cashOutTargetProblem(net.pool, { chainId: id }) === sdk.CASH_OUT_TO_VAULT_MESSAGE, "filled: cash out to the vault refused");
  assert(sdk.cashOutTargetProblem(net.assets[0].address, { chainId: id }) === sdk.CASH_OUT_TO_TOKEN_MESSAGE, "filled: cash out to USDC refused");
  const urls = sdk.circuitArtifactUrls("shield", id);
  assert(urls.zkey.endsWith("/final/shield_final.zkey"), "filled: final-key zkey");
  if (MODE === "filled-memo" || LIVE?.payMemo) {
    assert(net.payMemo !== null, "memo: the board is on the network");
    assert(sdk.payMemoBoardFor(id)?.address.toLowerCase() === net.payMemo.toLowerCase(), "memo: payMemoBoardFor finds it");
    assert(sdk.cashOutTargetProblem(net.payMemo, { chainId: id }) === sdk.CASH_OUT_TO_BOARD_MESSAGE, "memo: cash out to the board refused");
  } else {
    assert(net.payMemo === null && sdk.payMemoBoardFor(id) === null, "no memo: no board");
  }
}

console.log(`elysium.selftest (${MODE}): ok (${checks} assertions)`);
