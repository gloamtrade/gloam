/**
 * SDK self-test: Ethereum Sepolia (11155111).
 *
 * Two runs of this file:
 *
 *  - as committed: ETHEREUM_SEPOLIA_POOL as it is in src/mainnet.ts. Empty
 *    until the deploy, so Ethereum Sepolia exists nowhere in the SDK (no
 *    network, no pool, no board) while its chain id still proves with the
 *    final keys. Once the deploy is pasted in, the same run checks it as live.
 *  - with a placeholder pool and board put into ETHEREUM_SEPOLIA_POOL before
 *    the networks are built (a child process of this one): the network, its
 *    assets and deposit limits, ETH listed, the board, the builders, payment
 *    requests and x402, and Ethereum Sepolia listed after the other testnets.
 *
 * Run after build:  node test/ethereum-sepolia.selftest.mjs
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const CONFIGURED = process.env.GLOAM_SDK_SEPOLIA === "configured";
const POOL = "0x00000000000000000000000000000000000000e5";
const MEMO = "0x00000000000000000000000000000000000000e6";

const mainnet = await import("../dist/mainnet.js");
// Filled in the way DEPLOY-ETHEREUM-SEPOLIA.md says, before constants.js builds the networks.
if (CONFIGURED) Object.assign(mainnet.ETHEREUM_SEPOLIA_POOL, { pool: POOL, deployBlock: 300n, payMemo: MEMO, payMemoBlock: 301n });

const {
  testnetNetwork,
  mainnetNetwork,
  gloamNetworks,
  getGloamNetwork,
  networkForChainId,
  poolForChainId,
  ethereumSepoliaPool,
  ethereumSepoliaPayMemo,
  networkName,
  isPaymentsPoolChainId,
  isMainnetChainId,
  ceremonyForChainId,
  circuitArtifactUrls,
  assertDepositAllowed,
  buildShieldBoundIntent,
  buildShieldIntent,
  buildGloamPaymentRequirements,
  buildPaymentRequestLink,
  parsePaymentRequestLink,
  payMemoBoardFor,
  generateReceiveKey,
  GLOAM_NETWORKS,
  NATIVE_ASSET,
  ETHEREUM_SEPOLIA_CHAIN_ID,
  ETHEREUM_SEPOLIA_CHAIN,
  ETHEREUM_SEPOLIA_ASSETS,
  ETHEREUM_SEPOLIA_USDC,
  ETHEREUM_SEPOLIA_USDG,
  ETHEREUM_SEPOLIA_PYUSD,
  ETHEREUM_SEPOLIA_EURC,
  BASE_SEPOLIA_USDC,
  approvalSteps,
  approveNeedsReset,
} = await import("../dist/index.js");

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
async function throwsAsync(fn, re, msg) {
  try {
    await fn();
  } catch (e) {
    assert(re.test(String(e?.message ?? e)), `${msg}: wrong error "${e?.message}"`);
    return;
  }
  assert(false, `${msg}: did not throw`);
}
const prover = async () => ({ proofBytes: "0x" + "ab".repeat(256), publicSignals: [] });
const SIX = 10n ** 6n;

// ── both runs: the chain, its assets, its keys ────────────────────────────────────
assert(ETHEREUM_SEPOLIA_CHAIN_ID === 11155111 && ETHEREUM_SEPOLIA_CHAIN.id === 11155111, "chain id");
assert(ETHEREUM_SEPOLIA_CHAIN.testnet === true && ETHEREUM_SEPOLIA_CHAIN.name === "Ethereum Sepolia", "a testnet named Ethereum Sepolia");
assert(ETHEREUM_SEPOLIA_CHAIN.blockExplorers.default.url === "https://sepolia.etherscan.io", "explorer");
assert(
  ETHEREUM_SEPOLIA_CHAIN.rpcUrls.default.http.join() === "https://ethereum-sepolia-rpc.publicnode.com,https://sepolia.gateway.tenderly.co",
  "publicnode first (at the head), Tenderly's gateway second"
);
assert(
  ETHEREUM_SEPOLIA_ASSETS.map((a) => `${a.symbol}:${a.address}:${a.decimals}`).join() ===
    [
      "USDC:0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238:6",
      "USDG:0xfBb2A78CceEb415b00300925e464C3E44E6e06b0:6",
      "PYUSD:0xCaC524BcA292aaade2DF8A05cC58F0a65B1B3bB9:6",
      "EURC:0x08210F9170F89Ab7658F0B5E3fF39b0E03C594D4:6",
      `ETH:${NATIVE_ASSET}:18`,
    ].join(),
  "assets as checked on chain, in the deploy's order"
);
for (const a of ETHEREUM_SEPOLIA_ASSETS) {
  const want = a.symbol === "ETH" ? [2n * 10n ** 17n, 10n * 10n ** 18n] : [500n * SIX, 25_000n * SIX];
  assert(a.depositLimit.perDeposit === want[0] && a.depositLimit.total === want[1], `${a.symbol}: the deploy's deposit limits`);
}
// No Sepolia token needs its allowance reset first (Tether issues no USDT there):
// a deposit approves the exact amount once, or nothing when the allowance covers it.
for (const a of ETHEREUM_SEPOLIA_ASSETS.filter((x) => x.address !== NATIVE_ASSET)) {
  assert(!approveNeedsReset(11155111, a.address), `${a.symbol}: no reset to 0 first`);
  const steps = (allowance) => approvalSteps(11155111, a.address, allowance, 20n * SIX).map(String).join(",");
  assert(steps(0n) === String(20n * SIX), `${a.symbol}: no allowance, one exact approve`);
  assert(steps(5n * SIX) === String(20n * SIX), `${a.symbol}: a smaller allowance, one exact approve and no reset`);
  assert(steps(20n * SIX) === "" && steps(40n * SIX) === "", `${a.symbol}: an allowance that covers it, nothing to approve`);
}
assert(isPaymentsPoolChainId(11155111) && !isMainnetChainId(11155111), "the payments pool, on a testnet");
assert(ceremonyForChainId(11155111) === "production", "proofs for Sepolia always use the final keys, pool or not");
assert(circuitArtifactUrls("transfer", 11155111).zkey.endsWith("/final/transfer_final.zkey"), "final-key artifacts");
assert(networkName(11155111) === "Ethereum Sepolia", "name");
assert(mainnetNetwork("ethereum")?.chainId !== 11155111, "the mainnet entry is never Sepolia");
assert(!("ethereum" in GLOAM_NETWORKS), "GLOAM_NETWORKS keeps its two testnets");

const live = ethereumSepoliaPool();

// ── as committed, before the deploy: nowhere ──────────────────────────────────────
if (!CONFIGURED && live === null) {
  assert(testnetNetwork("ethereum") === null && getGloamNetwork("ethereum") === null, "no network yet");
  assert(networkForChainId(11155111) === undefined, "no network by chain id");
  assert(!gloamNetworks().some((n) => n.family === "ethereum"), "not listed");
  assert(ethereumSepoliaPayMemo() === null && payMemoBoardFor(11155111) === null, "no board yet");
  throws(() => poolForChainId(11155111), /Ethereum Sepolia is not in this version/, "the pool is refused by name, never guessed");
  await throwsAsync(() => buildShieldIntent({ chainId: 11155111, amountWei: 1n }), /Plain shield\(\) is off/, "no plain shield there, pool or not");
  await throwsAsync(
    () => buildShieldBoundIntent({ chainId: 11155111, asset: ETHEREUM_SEPOLIA_USDC, amountWei: 1n, prover }),
    /not in this version/,
    "a deposit with no pool in the SDK is refused"
  );
}

// ── once a pool is in (the placeholder, or the real one after the deploy) ─────────
if (CONFIGURED || live !== null) {
  const n = testnetNetwork("ethereum");
  const pool = CONFIGURED ? POOL : live.pool;
  assert(n && n.key === "ethereum" && n.family === "ethereum" && n.label === "Ethereum", "the network");
  assert(n.chainId === 11155111 && n.pool === pool && n.testnet === true && n.ceremony === "production", "pool, testnet, final keys");
  assert(n.nativeShield === true && n.assets === ETHEREUM_SEPOLIA_ASSETS, "ETH and the stablecoins listed");
  assert(n.rpcUrl === "https://ethereum-sepolia-rpc.publicnode.com" && n.explorerUrl === "https://sepolia.etherscan.io", "rpc at the head, and explorer");
  assert(n.historyRpc?.url === "https://sepolia.gateway.tenderly.co" && n.historyRpc.recentBlocks === 9_000n, "old blocks from Tenderly's gateway, which keeps the whole history");
  const keys = gloamNetworks().map((x) => x.key);
  assert(keys[keys.length - 1] === "ethereum" && keys.indexOf("ethereum") > keys.indexOf("tempo"), `listed after the other testnets (${keys.join()})`);
  assert(getGloamNetwork("ethereum") === n && networkForChainId(11155111) === n && poolForChainId(11155111) === pool, "lookups");

  assertDepositAllowed(11155111, ETHEREUM_SEPOLIA_PYUSD, 500n * SIX);
  assertDepositAllowed(11155111, ETHEREUM_SEPOLIA_USDG, 500n * SIX);
  assertDepositAllowed(11155111, NATIVE_ASSET, 2n * 10n ** 17n);
  // amounts are not checked from the launch values any more: the vault's live limits decide (limits.selftest)
  assertDepositAllowed(11155111, ETHEREUM_SEPOLIA_EURC, 500n * SIX + 1n);
  assertDepositAllowed(11155111, NATIVE_ASSET, 2n * 10n ** 17n + 1n);
  throws(() => assertDepositAllowed(11155111, BASE_SEPOLIA_USDC, 1n), /does not list/, "Base Sepolia's USDC is not listed here");

  const i = await buildShieldBoundIntent({ chainId: 11155111, asset: ETHEREUM_SEPOLIA_USDC, amountWei: 100n * SIX, prover });
  assert(i.exec.poolAddress === pool && i.exec.fn === "shieldBound", "a USDC deposit goes to its pool with a proof");
  await throwsAsync(
    () =>
      buildShieldBoundIntent({
        chainId: 11155111, asset: ETHEREUM_SEPOLIA_USDC, amountWei: 501n * SIX, prover,
        // the vault's own answer, read live: 500 per deposit
        client: { readContract: async ({ functionName }) => (functionName === "depositLimitsOn" ? true : functionName === "depositLimit" ? [500n * SIX, 25_000n * SIX] : 0n) },
      }),
    /deposit limit/,
    "the builder checks the vault's live limit before proving"
  );

  const payee = await generateReceiveKey();
  const req = buildGloamPaymentRequirements({ amountWei: 10n, asset: ETHEREUM_SEPOLIA_PYUSD, payTo: payee.tag, resource: "r", network: 11155111 });
  assert(req.poolAddress === pool, "x402 requirements name its pool");
  const read = parsePaymentRequestLink(buildPaymentRequestLink({ payTo: payee.tag, network: "ethereum", asset: "pyusd", amount: "12.5" }));
  assert(read.networkKey === "ethereum" && read.asset === ETHEREUM_SEPOLIA_PYUSD && read.amount === "12.5", "a request link on Ethereum Sepolia");
  throws(() => buildPaymentRequestLink({ payTo: payee.tag, network: "ethereum", asset: "USDT" }), /does not take "USDT"/, "no USDT request there");

  const board = payMemoBoardFor(11155111);
  const memo = CONFIGURED ? MEMO : mainnet.ETHEREUM_SEPOLIA_POOL.payMemo;
  if (memo) {
    assert(n.payMemo === memo && board?.address === memo && board.emitsPoster === false, "its memo board, which never logs the poster");
    if (CONFIGURED) assert(board.deployBlock === 301n, "the board's own deploy block");
  }
}

// ── ETHEREUM_SEPOLIA_POOL is checked like MAINNET_POOLS ───────────────────────────
if (CONFIGURED) {
  mainnet.ETHEREUM_SEPOLIA_POOL.pool = "0x1234";
  throws(() => ethereumSepoliaPool(), /ETHEREUM_SEPOLIA_POOL\.pool is not a pool address/, "a bad address throws");
  mainnet.ETHEREUM_SEPOLIA_POOL.pool = POOL;
  mainnet.ETHEREUM_SEPOLIA_POOL.payMemoBlock = 0n;
  throws(() => ethereumSepoliaPayMemo(), /ETHEREUM_SEPOLIA_POOL\.payMemo\.deployBlock/, "board block 0 throws");
  console.log(`ethereum-sepolia selftest (placeholder pool and board): ${checks} checks passed`);
} else {
  const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
    env: { ...process.env, GLOAM_SDK_SEPOLIA: "configured" },
    encoding: "utf8",
  });
  process.stdout.write(child.stdout);
  process.stderr.write(child.stderr);
  if (child.status !== 0) {
    console.error("FAIL: the placeholder run failed");
    process.exit(1);
  }
  console.log(`ethereum-sepolia selftest (${live ? "live" : "as shipped, not deployed"}): ${checks} checks passed`);
}
