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
 * Run after build:  node test/elysium.selftest.mjs
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const elysium = await import("../dist/elysium.js");
const LIVE = elysium.elysiumMainnetConfig();
const MODE = process.env.GLOAM_SELFTEST_ELYSIUM ?? (LIVE ? "live" : "empty");

// Placeholders, put in before constants.js loads (the networks are built from them).
const CHAIN_ID = 990_001;
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
for (const id of [1, 4663, 4217, 8453, 46630, 42431, 84532, 11155111]) {
  throws(() => sdk.checkElysiumMainnet({ ...base, chainId: id }), /another chain Gloam runs on/, `chain ${id} is refused`);
}
throws(() => sdk.checkElysiumMainnet({ ...base, rpcUrl: "http://rpc.elysium.example" }), /https/, "a plain http RPC is refused");
throws(() => sdk.checkElysiumMainnet({ ...base, explorerUrl: "elysium" }), /https/, "an explorer that is not a URL is refused");
throws(() => sdk.checkElysiumMainnet({ ...base, usdc: "0x0000000000000000000000000000000000000000" }), /usdc/, "a zero USDC is refused");
throws(() => sdk.checkElysiumMainnet({ ...base, pool: "0x1234" }), /pool/, "a short pool is refused");
throws(() => sdk.checkElysiumMainnet({ ...base, deployBlock: 0n }), /deployBlock/, "block 0 is refused");
throws(() => sdk.checkElysiumMainnet({ ...base, payMemo: MEMO }), /payMemoBlock/, "a board without its block is refused");
assert(sdk.checkElysiumMainnet({ ...base, explorerUrl: "https://x.example//" }).explorerUrl === "https://x.example", "trailing slashes come off the explorer");
assert(sdk.ELYSIUM_NATIVE_CURRENCY.symbol === "HYPE" && sdk.ELYSIUM_NATIVE_CURRENCY.decimals === 18, "HYPE, 18 decimals");
assert(sdk.ELYSIUM_TESTNET_CHAIN_ID === 99801, "the testnet id");

if (MODE === "empty") {
  assert(sdk.elysiumMainnetConfig() === null, "empty: no config");
  assert(sdk.mainnetNetwork("elysium") === null, "empty: no mainnet network");
  assert(sdk.testnetNetwork("elysium") === null, "empty: no testnet network");
  assert(!sdk.gloamNetworks().some((n) => n.family === "elysium"), "empty: not in gloamNetworks");
  assert(sdk.elysiumMainnetChain() === null, "empty: no chain");
  assert(sdk.elysiumMainnetAssets().length === 0, "empty: no assets");
  assert(sdk.ceremonyForChainId(99801) === "dev", "the testnet id is not a Gloam chain");
  throws(() => sdk.poolForChainId(CHAIN_ID), /no pool on chain/, "empty: no pool for a made-up chain id");
  // The other chains are untouched.
  assert(sdk.gloamNetworks().length >= 8, "the other networks are all there");

  for (const mode of ["filled", "filled-memo"]) {
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
