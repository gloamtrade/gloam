/**
 * SDK self-test: Ethereum mainnet, before and after its pool is filled in.
 *
 * Ethereum (1) stays hidden until its pool address is written into
 * MAINNET_POOLS[1]. This file checks that state, then runs itself again in a
 * child process with a placeholder pool put in before the SDK loads, so the
 * rest of the SDK can be checked against it: the final keys, payments only, the
 * five listed stablecoins and ETH with their deposit limits, no testnet, and no
 * memo board until the real deploy fills one in next to the vault. USDT's
 * approve rule is checked in both.
 *
 * Run after build:  node test/ethereum.selftest.mjs
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const { MAINNET_POOLS, mainnetPoolFor } = await import("../dist/mainnet.js");
/** The real vault, once MAINNET_POOLS[1] is filled in after the deploy: then this run checks it, with no edit here. */
const LIVE = mainnetPoolFor(1);
const FILLED = process.env.GLOAM_SELFTEST_ETHEREUM === "filled" || LIVE !== null;
const POOL = LIVE?.pool ?? "0x00000000000000000000000000000000000000e1";
const DEPLOY_BLOCK = LIVE?.deployBlock ?? 21_000_000n;
// Before constants.js loads: the networks are built from this when it does.
if (FILLED && !LIVE) MAINNET_POOLS[1] = { pool: POOL, deployBlock: DEPLOY_BLOCK };
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
async function throwsAsync(fn, re, msg) {
  try {
    await fn();
  } catch (e) {
    assert(re.test(String(e?.message ?? e)), `${msg}: wrong error "${e?.message}"`);
    return;
  }
  assert(false, `${msg}: did not throw`);
}

const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const USDT = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
const USDG = "0xe343167631d89B6Ffc58B88d6b7fB0228795491D";
const PYUSD = "0x6c3ea9036406852006290770BEdFcAbA0e23A0e8";
const EURC = "0x1aBaEA1f7C830bD89Acc67eC4af516284b1bC33c";
const BDX = "0x6ad12E761b438beA3EA09F6C6266556Bb24C2181";

// ── before the pool is in ────────────────────────────────────────────────────────
if (!FILLED) {
  assert(sdk.MAINNET_POOLS[1].pool === null && sdk.MAINNET_POOLS[1].deployBlock === null, "MAINNET_POOLS[1] is empty until the deploy");
  assert(sdk.mainnetNetwork("ethereum") === null && sdk.getGloamNetwork("ethereum-mainnet") === null, "no Ethereum network without its pool");
  assert(sdk.networkForChainId(1) === undefined, "chain 1 resolves to nothing");
  assert(!sdk.gloamNetworks().some((n) => n.chainId === 1), "gloamNetworks leaves Ethereum mainnet out");
  throws(() => sdk.poolForChainId(1), /Ethereum mainnet is not in this version/, "builders refuse chain 1 instead of guessing a pool");
  await throwsAsync(
    () => sdk.buildShieldBoundIntent({ chainId: 1, asset: USDC, amountWei: 1n, prover: async () => ({ proofBytes: "0x", publicSignals: [] }) }),
    /not in this version/,
    "no deposit intent on chain 1"
  );
  assert(sdk.isMainnetChainId(1) && sdk.isPaymentsPoolChainId(1), "chain 1 is a mainnet on the payments pool, pool or not");
  assert(sdk.ceremonyForChainId(1) === "production", "Ethereum proves with the final keys, pool or not");
  assert(sdk.circuitArtifactUrls("transfer", 1).zkey.endsWith("/final/transfer_final.zkey"), "final-key artifacts for chain 1");
  assert(sdk.networkName(1) === "Ethereum", "name");
  assert(sdk.testnetNetwork("ethereum")?.chainId !== 1, "Ethereum's testnet entry is Sepolia, never chain 1");
  assert(sdk.payMemoBoardFor(1) === null, "no memo board on Ethereum");
  assert(sdk.ETHEREUM_MAINNET_CHAIN_ID === 1 && sdk.ETHEREUM_MAINNET_CHAIN.id === 1, "chain id and viem chain");
  assert(new URL(sdk.ETHEREUM_MAINNET_CHAIN.rpcUrls.default.http[0]).host === "rpc.mevblocker.io", "default RPC keeps old state and logs");
  assert(sdk.ETHEREUM_MAINNET_CHAIN.blockExplorers.default.url === "https://etherscan.io", "Etherscan");
}

// ── USDT's approve rule ──────────────────────────────────────────────────────────
{
  const { approvalSteps, approveNeedsReset } = sdk;
  assert(approveNeedsReset(1, USDT) && approveNeedsReset(1, USDT.toLowerCase()), "USDT on Ethereum resets first");
  assert(!approveNeedsReset(1, USDC) && !approveNeedsReset(8453, "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2"), "USDC, and Base's bridged USDT, approve straight");
  const steps = (...a) => approvalSteps(...a).map(String).join(",");
  assert(steps(1, USDT, 0n, 100n) === "100", "no allowance: one exact approve");
  assert(steps(1, USDT, 30n, 100n) === "0,100", "a stale USDT allowance goes to 0 first");
  assert(steps(1, USDT, 100n, 100n) === "" && steps(1, USDT, 150n, 100n) === "", "an allowance that covers it: nothing to approve");
  assert(steps(1, USDC, 30n, 100n) === "100", "USDC changes its allowance in one step");
  throws(() => approvalSteps(1, USDT, 0n, 0n), /positive/, "zero deposit refused");
}

// ── with the pool filled in ──────────────────────────────────────────────────────
const {
  mainnetNetwork,
  gloamNetworks,
  getGloamNetwork,
  networkForChainId,
  poolForChainId,
  assertDepositAllowed,
  buildShieldBoundIntent,
  buildShieldIntent,
  buildPrivateTradeIntent,
  buildGloamPaymentRequirements,
  buildPaymentRequestLink,
  parsePaymentRequestLink,
  payMemoBoardFor,
  generateReceiveKey,
  NATIVE_ASSET,
  ETHEREUM_MAINNET_ASSETS,
  ETHEREUM_BDX,
  assertDepositWithinLiveLimit,
} = sdk;
if (FILLED) {
  const net = mainnetNetwork("ethereum");
  assert(net && net.key === "ethereum-mainnet" && net.chainId === 1 && net.pool === POOL && net.deployBlock === DEPLOY_BLOCK, "Ethereum entry");
  assert(net.label === "Ethereum" && net.family === "ethereum" && net.testnet === false, "label, family, mainnet");
  assert(net.ceremony === "production" && net.nativeShield === true, "final keys, ETH listed");
  // The memo board comes in with the vault (ethereum-mainnet-after-deploy.sh writes both); the placeholder run has none.
  const board = payMemoBoardFor(1);
  assert(net.payMemo === (board?.address ?? null), "the network's memo board is the one payments are scanned on");
  if (LIVE) {
    assert(/^0x[0-9a-fA-F]{40}$/.test(board?.address ?? "") && board.deployBlock >= DEPLOY_BLOCK && board.emitsPoster === false, "Ethereum's memo board, deployed after its vault, never logs the poster");
  } else {
    assert(board === null, "no memo board on Ethereum before its deploy");
  }
  assert(net.explorerUrl === "https://etherscan.io" && net.rpcUrl === "https://rpc.mevblocker.io", "explorer and RPC");
  assert(net.assets.map((a) => a.symbol).join() === "USDC,USDT,USDG,PYUSD,EURC,ETH,BDX", "assets in the deploy's order, then BDX");
  assert(net.assets.map((a) => a.address).join() === [USDC, USDT, USDG, PYUSD, EURC, NATIVE_ASSET, BDX].join(), "asset addresses as checked on chain");
  assert(ETHEREUM_BDX === BDX, "ETHEREUM_BDX");
  for (const a of ETHEREUM_MAINNET_ASSETS) {
    if (a.symbol === "BDX") {
      assert(a.decimals === 9 && a.depositLimit.perDeposit === (1n << 128n) - 1n && a.depositLimit.total === (1n << 128n) - 1n, "BDX: no limit once its timelocked change lands");
    } else if (a.symbol === "ETH") {
      assert(a.decimals === 18 && a.depositLimit.perDeposit === 20n * 10n ** 18n && a.depositLimit.total === 1_000n * 10n ** 18n, "ETH: 20 per deposit, 1,000 in total, as read on chain");
    } else {
      assert(a.decimals === 6 && a.depositLimit.perDeposit === 50_000_000_000n && a.depositLimit.total === 2_500_000_000_000n, `${a.symbol}: 50,000 per deposit, 2,500,000 in total, as read on chain`);
    }
  }
  const keys = gloamNetworks().map((n) => n.key);
  assert(keys.indexOf("ethereum-mainnet") > keys.indexOf("tempo-mainnet") && keys.indexOf("ethereum-mainnet") < keys.indexOf("robinhood"), `Ethereum with the mainnets, before the testnets (${keys.join()})`);
  assert(getGloamNetwork("ethereum-mainnet") === net && networkForChainId(1) === net && poolForChainId(1) === POOL, "lookups");

  // deposits
  assertDepositAllowed(1, USDT, 500_000_000n);
  assertDepositAllowed(1, PYUSD, 1n);
  assertDepositAllowed(1, NATIVE_ASSET, 2n * 10n ** 17n);
  // amounts are read live from the vault now (limits.selftest), not from the launch values
  assertDepositAllowed(1, USDG, 500_000_001n);
  assertDepositAllowed(1, NATIVE_ASSET, 2n * 10n ** 17n + 1n);
  throws(() => assertDepositAllowed(1, "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", 1n), /does not list/, "Base's USDC is not listed on Ethereum");
  // BDX is listed, but the vault takes it only once its timelocked limit lands: read live.
  assertDepositAllowed(1, BDX, 1n);
  const vault = (per, total) => ({
    readContract: async ({ functionName }) =>
      functionName === "depositLimitsOn" ? true : functionName === "depositLimit" ? [per, total] : 0n,
  });
  await throwsAsync(() => assertDepositWithinLiveLimit(vault(0n, 0n), 1, BDX, 10n ** 9n), /The Ethereum vault takes no BDX deposits/, "BDX before its limit lands");
  await assertDepositWithinLiveLimit(vault(100_000n * 10n ** 9n, 2_000_000n * 10n ** 9n), 1, BDX, 100_000n * 10n ** 9n);
  await throwsAsync(
    () => assertDepositWithinLiveLimit(vault(100_000n * 10n ** 9n, 2_000_000n * 10n ** 9n), 1, BDX, 100_000n * 10n ** 9n + 1n),
    /at most 100,000 BDX per deposit/,
    "BDX over its per-deposit limit, in BDX's 9 decimals"
  );

  // builders
  const prover = async () => ({ proofBytes: "0x" + "ab".repeat(256), publicSignals: [] });
  const i = await buildShieldBoundIntent({ chainId: 1, asset: USDT, amountWei: 100_000_000n, prover });
  assert(i.exec.poolAddress === POOL && i.exec.fn === "shieldBound" && i.exec.valueWei === 0n, "USDT deposit goes to the Ethereum pool with no value");
  const e = await buildShieldBoundIntent({ chainId: 1, asset: NATIVE_ASSET, amountWei: 10n ** 16n, prover });
  assert(e.exec.valueWei === 10n ** 16n, "ETH deposit carries its value");
  await throwsAsync(() => buildShieldIntent({ chainId: 1, amountWei: 1n }), /Plain shield\(\) is off/, "no plain shield on Ethereum");
  await throwsAsync(
    () => buildPrivateTradeIntent({ chainId: 1, secretHex: "0x01", amountInWei: 1n, amountSwapWei: 1n, assetOut: USDC, amountOutMinWei: 1n, rateIn: 1n, rateOut: 1n, path: {}, prove: prover }),
    /payments only/,
    "no private trading on Ethereum"
  );

  // payments, requests, boards
  const payee = await generateReceiveKey();
  const req = buildGloamPaymentRequirements({ amountWei: 10n, asset: USDC, payTo: payee.tag, resource: "r", network: 1 });
  assert(req.poolAddress === POOL, "x402 requirements on Ethereum name its pool");
  const link = buildPaymentRequestLink({ payTo: payee.tag, network: "ethereum-mainnet", asset: "pyusd", amount: "12.5" });
  const read = parsePaymentRequestLink(link);
  assert(read.networkKey === "ethereum-mainnet" && read.asset === PYUSD && read.amount === "12.5", "request link on Ethereum");
  assert(parsePaymentRequestLink(buildPaymentRequestLink({ payTo: payee.tag, network: 1, asset: "ETH" })).asset === NATIVE_ASSET, "request for ETH on Ethereum");
}

if (!FILLED) {
  const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
    env: { ...process.env, GLOAM_SELFTEST_ETHEREUM: "filled" },
    encoding: "utf8",
  });
  process.stdout.write(child.stdout);
  process.stderr.write(child.stderr);
  assert(child.status === 0, "the run with the pool filled in failed");
}

console.log(`ethereum selftest${FILLED ? " (pool filled in)" : ""}: ${checks} checks passed`);
