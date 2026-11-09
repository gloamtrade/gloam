/**
 * SDK self-test: Base, as it will be once its pools are filled in.
 *
 * Base mainnet (8453) and Base Sepolia (84532) stay hidden until their pool
 * addresses are written into MAINNET_POOLS and BASE_SEPOLIA_POOL (that state is
 * checked in mainnet.selftest.mjs). Here both get placeholder pools before the
 * networks are built, so the rest of the SDK can be checked against them: the
 * mainnet keys on both, payments only, the listed assets and deposit limits, ETH
 * listed, Base Sepolia's memo board (and Base mainnet's once its deploy has
 * filled it in next to the vault), and Base Sepolia after the older testnets.
 *
 * Run after build:  node test/base.selftest.mjs
 */
import { MAINNET_POOLS, BASE_SEPOLIA_POOL } from "../dist/mainnet.js";
import { elysiumMainnetConfig, elysiumTestnetConfig } from "../dist/elysium.js";

/** Base mainnet's real vault, once base-mainnet-after-deploy.sh has filled it in; its memo board comes with it. */
const LIVE = MAINNET_POOLS[8453].pool !== null ? { ...MAINNET_POOLS[8453] } : null;

const MAIN_POOL = "0x00000000000000000000000000000000000000b5";
const TEST_POOL = "0x00000000000000000000000000000000000000b6";
// Before constants.js loads: the networks are built from these when it does.
MAINNET_POOLS[8453] = { pool: MAIN_POOL, deployBlock: 100n };
BASE_SEPOLIA_POOL.pool = TEST_POOL;
BASE_SEPOLIA_POOL.deployBlock = 200n;

const {
  mainnetPoolFor,
  mainnetNetwork,
  testnetNetwork,
  gloamNetworks,
  getGloamNetwork,
  networkForChainId,
  poolForChainId,
  baseSepoliaPool,
  networkName,
  circuitArtifactUrls,
  assertDepositAllowed,
  buildShieldBoundIntent,
  buildShieldIntent,
  buildPrivateTradeIntent,
  buildGloamPaymentRequirements,
  buildPaymentRequestLink,
  parsePaymentRequestLink,
  payMemoBoardFor,
  generateReceiveKey,
  GLOAM_NETWORKS,
  NATIVE_ASSET,
  BASE_USDC,
  BASE_USDT,
  BASE_SEPOLIA_USDC,
  BASE_SEPOLIA_EURC,
} = await import("../dist/index.js");
const BASE_MAINNET_BOARD = payMemoBoardFor(8453);

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
const eth = (s) => BigInt(Math.round(Number(s) * 1e6)) * 10n ** 12n;

// ── the two networks ─────────────────────────────────────────────────────────────
const main = mainnetNetwork("base");
const test = testnetNetwork("base");
assert(main && main.key === "base-mainnet" && main.chainId === 8453 && main.pool === MAIN_POOL && main.deployBlock === 100n, "Base mainnet entry");
assert(test && test.key === "base" && test.chainId === 84532 && test.pool === TEST_POOL && test.deployBlock === 200n, "Base Sepolia entry");
for (const n of [main, test]) {
  assert(n.label === "Base" && n.family === "base", `${n.key}: label and family`);
  assert(n.ceremony === "production", `${n.key}: the ceremony's final keys`);
  assert(n.nativeShield === true, `${n.key}: ETH listed`);
  assert(n.chain.id === n.chainId && /publicnode\.com$/.test(new URL(n.rpcUrl).host), `${n.key}: viem chain, an RPC that serves eth_getLogs`);
}
assert(main.testnet === false && test.testnet === true, "Base is mainnet, Base Sepolia is a testnet");
assert(test.payMemo === "0x01B3172d9900Cb26d57E986429b9b23854c74598", "a memo board on Base Sepolia");
// Base mainnet's board comes in with its vault (base-mainnet-after-deploy.sh writes both): none before then.
assert(main.payMemo === (BASE_MAINNET_BOARD?.address ?? null), "Base mainnet's memo board, once it is filled in");
if (!LIVE) assert(main.payMemo === null, "no memo board on Base mainnet before its deploy");
assert(main.explorerUrl === "https://basescan.org" && test.explorerUrl === "https://sepolia.basescan.org", "Basescan");
assert(main.assets.map((a) => a.symbol).join() === "USDC,EURC,USDT,ETH,BDX", "Base mainnet assets, BDX last");
assert(test.assets.map((a) => a.symbol).join() === "USDC,EURC,ETH", "Base Sepolia assets, no USDT");
assert(baseSepoliaPool()?.pool === TEST_POOL, "baseSepoliaPool reads BASE_SEPOLIA_POOL");

// ── lookups ──────────────────────────────────────────────────────────────────────
// Ethereum sits with the mainnets once MAINNET_POOLS[1] is filled in, and Ethereum Sepolia after
// Base Sepolia once its pool is in (ethereum-sepolia.selftest.mjs). Elysium comes last on each side:
// its mainnet once src/elysium.ts has every value in, its testnet once ELYSIUM_TESTNET's pool is in
// (elysium.selftest.mjs); nothing here needs editing then.
const keys = gloamNetworks().map((n) => n.key).filter((k) => k !== "ethereum");
const order = [
  "robinhood-mainnet",
  "tempo-mainnet",
  "base-mainnet",
  ...(mainnetPoolFor(1) ? ["ethereum-mainnet"] : []),
  ...(elysiumMainnetConfig() ? ["elysium-mainnet"] : []),
  "robinhood",
  "tempo",
  "base",
  ...(elysiumTestnetConfig() ? ["elysium"] : []),
];
assert(keys.join() === order.join(), `network order (${keys.join()})`);
assert(getGloamNetwork("base") === test && getGloamNetwork("base-mainnet") === main, "by key");
assert(networkForChainId(84532) === test && networkForChainId(8453) === main, "by chain id");
assert(poolForChainId(84532) === TEST_POOL && poolForChainId(8453) === MAIN_POOL, "pool by chain id");
assert(testnetNetwork("tempo") === GLOAM_NETWORKS.tempo && !("base" in GLOAM_NETWORKS), "GLOAM_NETWORKS keeps its two testnets");
assert(networkName(84532) === "Base testnet" && networkName(8453) === "Base", "names");
assert(circuitArtifactUrls("unshield", 84532).zkey.endsWith("/final/unshield_final.zkey"), "Sepolia proves with the final keys");

// ── deposits: listed assets only, within the deposit limits ─────────────────────────
assertDepositAllowed(84532, BASE_SEPOLIA_USDC, 500_000_000n);
assertDepositAllowed(84532, BASE_SEPOLIA_EURC, 500_000_001n); // amounts are read live (limits.selftest)
throws(() => assertDepositAllowed(84532, BASE_USDC, 1n), /does not list/, "mainnet USDC is not listed on Sepolia");
throws(() => assertDepositAllowed(84532, BASE_USDT, 1n), /does not list/, "no USDT on Sepolia");
throws(() => assertDepositAllowed(84532, "0x00000000000000000000000000000000000000bb", 1n), /does not list/, "unlisted asset refused");
assertDepositAllowed(84532, NATIVE_ASSET, eth("0.2"));
assertDepositAllowed(84532, NATIVE_ASSET, eth("0.21"));
assertDepositAllowed(8453, BASE_USDT, 500_000_000n);
assertDepositAllowed(8453, NATIVE_ASSET, eth("0.2"));
assertDepositAllowed(8453, BASE_USDC, 500_000_001n);
throws(() => assertDepositAllowed(8453, BASE_SEPOLIA_USDC, 1n), /does not list/, "test USDC is not listed on mainnet");

// ── builders ─────────────────────────────────────────────────────────────────────
{
  const i = await buildShieldBoundIntent({ chainId: 84532, asset: NATIVE_ASSET, amountWei: eth("0.2"), prover });
  assert(i.exec.poolAddress === TEST_POOL && i.exec.fn === "shieldBound" && i.exec.valueWei === eth("0.2"), "ETH deposit on Sepolia sends value to its pool");
  await throwsAsync(
    () =>
      buildShieldBoundIntent({
        chainId: 84532, asset: NATIVE_ASSET, amountWei: eth("0.21"), prover,
        // the vault's own answer, read live: 0.2 per deposit
        client: { readContract: async ({ functionName }) => (functionName === "depositLimitsOn" ? true : functionName === "depositLimit" ? [eth("0.2"), eth("10")] : 0n) },
      }),
    /deposit limit/,
    "builder checks the vault's live limit before proving"
  );
  await throwsAsync(() => buildShieldIntent({ chainId: 84532, amountWei: 1n }), /Plain shield\(\) is off/, "no plain shield on Sepolia");
  await throwsAsync(
    () => buildPrivateTradeIntent({ chainId: 84532, secretHex: "0x01", amountInWei: 1n, amountSwapWei: 1n, assetOut: BASE_SEPOLIA_USDC, amountOutMinWei: 1n, rateIn: 1n, rateOut: 1n, path: {}, prove: prover }),
    /payments only/,
    "no private trading on Sepolia"
  );
}

// ── payments, requests, boards ───────────────────────────────────────────────────
{
  const payee = await generateReceiveKey();
  const req = buildGloamPaymentRequirements({ amountWei: 10n, asset: BASE_SEPOLIA_USDC, payTo: payee.tag, resource: "r", network: 84532 });
  assert(req.poolAddress === TEST_POOL, "x402 requirements on Base Sepolia name its pool");
  const link = buildPaymentRequestLink({ payTo: payee.tag, network: "base", asset: "eurc", amount: "12.5" });
  const read = parsePaymentRequestLink(link);
  assert(read.networkKey === "base" && read.asset === BASE_SEPOLIA_EURC && read.amount === "12.5", "request link on Base Sepolia");
  assert(parsePaymentRequestLink(buildPaymentRequestLink({ payTo: payee.tag, network: 8453, asset: "ETH" })).asset === NATIVE_ASSET, "request for ETH on Base mainnet");
  throws(() => buildPaymentRequestLink({ payTo: payee.tag, network: "base", asset: "USDT" }), /does not take "USDT"/, "no USDT request on Sepolia");
  const board = payMemoBoardFor(84532);
  assert(board?.address === "0x01B3172d9900Cb26d57E986429b9b23854c74598" && board.deployBlock === 49_804_175n && board.emitsPoster === false, "Base Sepolia's memo board, deployed after the pool, never logs the poster");
  if (LIVE) {
    assert(/^0x[0-9a-fA-F]{40}$/.test(BASE_MAINNET_BOARD?.address ?? "") && BASE_MAINNET_BOARD.deployBlock >= LIVE.deployBlock && BASE_MAINNET_BOARD.emitsPoster === false, "Base mainnet's memo board, deployed after its vault, never logs the poster");
  } else {
    assert(payMemoBoardFor(8453) === null, "no memo board on Base mainnet before its deploy");
  }
}

// ── BASE_SEPOLIA_POOL is checked like MAINNET_POOLS ──────────────────────────────
BASE_SEPOLIA_POOL.pool = "0x1234";
throws(() => baseSepoliaPool(), /BASE_SEPOLIA_POOL\.pool is not a pool address/, "a bad address throws");
BASE_SEPOLIA_POOL.pool = TEST_POOL;
BASE_SEPOLIA_POOL.deployBlock = 0n;
throws(() => baseSepoliaPool(), /BASE_SEPOLIA_POOL\.deployBlock/, "block 0 throws");

console.log(`base selftest: ${checks} checks passed`);
