/**
 * SDK self-test: mainnet networks, key sets, circuit files, fees and limits.
 *
 * Runs against whatever MAINNET_POOLS and BASE_SEPOLIA_POOL hold. A pool still
 * null means its network is hidden and its chain id is refused; once a pool is
 * filled in, its network must show up with the final keys and payments only.
 * Base with its pools filled in is covered by base.selftest.mjs.
 *
 * Run after build:  node test/mainnet.selftest.mjs
 */
import {
  MAINNET_POOLS,
  mainnetPoolFor,
  mainnetNetwork,
  gloamNetworks,
  getGloamNetwork,
  networkForChainId,
  poolForChainId,
  ceremonyForChainId,
  isMainnetChainId,
  isPaymentsPoolChainId,
  testnetNetwork,
  baseSepoliaPool,
  networkName,
  circuitArtifactUrls,
  circuitArtifactFiles,
  CIRCUIT_SHA256,
  cashOutFee,
  CASH_OUT_FEE_BPS,
  assertDepositAllowed,
  buildShieldBoundIntent,
  buildShieldIntent,
  buildPrivateTradeIntent,
  buildGloamPaymentRequirements,
  GLOAM_NETWORKS,
  GLOAM_TESTNETS,
  SEALED_VAULT,
  TEMPO_SEALED_VAULT,
  NATIVE_ASSET,
  RH_MAINNET_USDG,
  GLOAM_TOKEN,
  RH_MAINNET_GRIFT,
  RH_MAINNET_PONS,
  RH_MAINNET_CASHCAT,
  RH_MAINNET_AI,
  RH_MAINNET_ORBIO,
  TEMPO_USDCE,
  TEMPO_USDT0,
  TEMPO_PATHUSD,
  TEMPO_OUSD,
  BASE_USDC,
  BASE_EURC,
  BASE_USDT,
  BASE_BDX,
  ETHEREUM_BDX,
  BASE_SEPOLIA_USDC,
  BASE_SEPOLIA_EURC,
  RH_MAINNET_CHAIN_ID,
  TEMPO_MAINNET_CHAIN_ID,
  BASE_MAINNET_CHAIN_ID,
  RH_TESTNET_CHAIN_ID,
  TEMPO_TESTNET_CHAIN_ID,
  BASE_SEPOLIA_CHAIN_ID,
  BASE_SEPOLIA_PAY_MEMO,
  MAINNET_POSEIDON_T3,
  generateReceiveKey,
  payMemoBoardFor,
} from "../dist/index.js";

let checks = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exit(1);
  }
  checks++;
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
function throws(fn, re, msg) {
  try {
    fn();
  } catch (e) {
    assert(re.test(String(e?.message ?? e)), `${msg}: wrong error "${e?.message}"`);
    return;
  }
  assert(false, `${msg}: did not throw`);
}

// ── testnets unchanged ─────────────────────────────────────────────────────────
assert(GLOAM_TESTNETS === GLOAM_NETWORKS, "GLOAM_TESTNETS aliases GLOAM_NETWORKS");
assert(GLOAM_NETWORKS.robinhood.chainId === RH_TESTNET_CHAIN_ID && GLOAM_NETWORKS.robinhood.pool === SEALED_VAULT, "RH testnet entry");
assert(GLOAM_NETWORKS.tempo.chainId === TEMPO_TESTNET_CHAIN_ID && GLOAM_NETWORKS.tempo.pool === TEMPO_SEALED_VAULT, "Tempo testnet entry");
for (const n of Object.values(GLOAM_NETWORKS)) {
  assert(n.testnet === true && n.ceremony === "dev" && n.payMemo, `${n.key} is a dev-key testnet with a memo board`);
  assert(n.chain.id === n.chainId, `${n.key} viem chain id`);
}
assert(networkForChainId(RH_TESTNET_CHAIN_ID)?.key === "robinhood", "testnet lookup by chain id");
assert(testnetNetwork("robinhood") === GLOAM_NETWORKS.robinhood && testnetNetwork("tempo") === GLOAM_NETWORKS.tempo, "testnetNetwork returns the existing entries");

// ── key sets and circuit files ─────────────────────────────────────────────────
assert(isMainnetChainId(4663) && isMainnetChainId(4217) && !isMainnetChainId(46630) && !isMainnetChainId(42431), "mainnet chain ids");
assert(BASE_MAINNET_CHAIN_ID === 8453 && BASE_SEPOLIA_CHAIN_ID === 84532, "Base chain ids");
assert(isMainnetChainId(8453) && !isMainnetChainId(84532), "Base mainnet is a mainnet, Base Sepolia is not");
assert(isPaymentsPoolChainId(4663) && isPaymentsPoolChainId(8453) && isPaymentsPoolChainId(84532), "payments pools: every mainnet and Base Sepolia");
assert(!isPaymentsPoolChainId(46630) && !isPaymentsPoolChainId(42431), "the older testnets are not payments pools");
assert(ceremonyForChainId(BASE_MAINNET_CHAIN_ID) === "production" && ceremonyForChainId(BASE_SEPOLIA_CHAIN_ID) === "production", "Base, testnet included, proves with final keys");
assert(ceremonyForChainId(RH_MAINNET_CHAIN_ID) === "production", "RH mainnet proves with final keys");
assert(ceremonyForChainId(TEMPO_MAINNET_CHAIN_ID) === "production", "Tempo mainnet proves with final keys");
assert(ceremonyForChainId(RH_TESTNET_CHAIN_ID) === "dev" && ceremonyForChainId(TEMPO_TESTNET_CHAIN_ID) === "dev", "testnets prove with dev keys");

const tMain = circuitArtifactUrls("transfer", TEMPO_MAINNET_CHAIN_ID);
assert(tMain.wasm === "https://www.gloam.trade/circuits/transfer.wasm", "mainnet wasm url");
assert(tMain.zkey === "https://www.gloam.trade/circuits/final/transfer_final.zkey", "mainnet zkey is the final key");
const sTest = circuitArtifactUrls("shield", RH_TESTNET_CHAIN_ID, "/circuits/");
assert(sTest.wasm === "/circuits/shield.wasm" && sTest.zkey === "/circuits/shield_final.zkey", "testnet files, custom base");
assert(circuitArtifactUrls("shield", BASE_SEPOLIA_CHAIN_ID).zkey === "https://www.gloam.trade/circuits/final/shield_final.zkey", "Base Sepolia proves with the final zkey");
const fFinal = circuitArtifactFiles("unshield", "production");
assert(fFinal.sha256.zkey === CIRCUIT_SHA256.zkey.production.unshield && fFinal.sha256.zkey !== CIRCUIT_SHA256.zkey.dev.unshield, "final and dev zkeys differ");
for (const set of [CIRCUIT_SHA256.wasm, CIRCUIT_SHA256.zkey.dev, CIRCUIT_SHA256.zkey.production]) {
  for (const h of Object.values(set)) assert(/^[0-9a-f]{64}$/.test(h), "sha256 is 64 hex chars");
}

// ── fees ────────────────────────────────────────────────────────────────────────
assert(CASH_OUT_FEE_BPS === 50, "0.5% cash-out fee");
assert(cashOutFee(100_000_000n) === 500_000n, "0.5% of 100 USDC.e is 0.5");
assert(cashOutFee(199n) === 0n, "rounds down in the user's favour");
assert(cashOutFee(399n) === 1n, "rounds down, not to the nearest");
assert(cashOutFee(10_001n) === 50n, "matches the contract's split formula");
assert(cashOutFee(100_000_000n, 25) === 250_000n, "a pool still at 0.25%, such as Base Sepolia");
assert(cashOutFee(10_001n, 25) === 25n, "the same formula at 25 bps");
assert(cashOutFee(1_000n, 0) === 0n, "fee off");
throws(() => cashOutFee(-1n), /negative/, "negative amount");

// ── names ───────────────────────────────────────────────────────────────────────
assert(networkName(4663) === "Robinhood Chain" && networkName(4217) === "Tempo", "mainnet names");
assert(networkName(46630) === "Robinhood Chain testnet" && networkName(42431) === "Tempo testnet", "testnet names");
assert(networkName(8453) === "Base" && networkName(84532) === "Base testnet", "Base names");
assert(MAINNET_POSEIDON_T3 === "0x1a32C2c2A77225EC2dD3BF7be1018819b1039Cb4", "PoseidonT3");

// ── MAINNET_POOLS validation ─────────────────────────────────────────────────────
{
  const saved = { ...MAINNET_POOLS[4663] };
  MAINNET_POOLS[4663] = { pool: "0x1234", deployBlock: 5n };
  throws(() => mainnetPoolFor(4663), /not a pool address/, "a bad pool address throws");
  MAINNET_POOLS[4663] = { pool: "0x0000000000000000000000000000000000000000", deployBlock: 5n };
  throws(() => mainnetPoolFor(4663), /not a pool address/, "the zero address throws");
  MAINNET_POOLS[4663] = { pool: "0x00000000000000000000000000000000000000aa", deployBlock: 0n };
  throws(() => mainnetPoolFor(4663), /deploy block/, "block 0 throws");
  MAINNET_POOLS[4663] = { pool: "0x00000000000000000000000000000000000000aa", deployBlock: 7n };
  assert(mainnetPoolFor(4663)?.deployBlock === 7n, "a good entry resolves");
  MAINNET_POOLS[4663] = saved;
}

// ── mainnet networks, as filled in ───────────────────────────────────────────────
const prover = async () => ({ proofBytes: "0x" + "ab".repeat(256), publicSignals: [] });
const live = gloamNetworks();
{
  const firstTest = live.findIndex((n) => n.testnet);
  assert(firstTest >= 0 && live.slice(firstTest).every((n) => n.testnet), "testnets come last");
  assert(live.slice(firstTest, firstTest + 2).map((n) => n.key).join() === "robinhood,tempo", "Robinhood Chain and Tempo testnets first among them");
}

// Base Sepolia: hidden and refused until BASE_SEPOLIA_POOL is in.
if (!baseSepoliaPool()) {
  assert(testnetNetwork("base") === null && getGloamNetwork("base") === null && networkForChainId(BASE_SEPOLIA_CHAIN_ID) === undefined, "Base Sepolia hidden until its pool is in");
  assert(!live.some((n) => n.family === "base" && n.testnet), "gloamNetworks leaves Base Sepolia out");
  throws(() => poolForChainId(BASE_SEPOLIA_CHAIN_ID), /Base testnet is not in this version/, "Base Sepolia: no pool guessed");
  await throwsAsync(
    () => buildShieldBoundIntent({ chainId: BASE_SEPOLIA_CHAIN_ID, asset: BASE_SEPOLIA_USDC, amountWei: 1_000_000n, prover }),
    /not in this version/,
    "Base Sepolia: builder refuses it without a pool"
  );
} else {
  // Deployed 24 Oct 2026 (contracts/deployments/base-sepolia.json).
  const n = testnetNetwork("base");
  assert(n && n.pool.toLowerCase() === "0x39e28cde55cab798874746ac52cb4b5cc99a0194" && n.deployBlock === 49_802_958n, "Base Sepolia: the deployed vault and its block");
  assert(getGloamNetwork("base") === n && networkForChainId(BASE_SEPOLIA_CHAIN_ID) === n && poolForChainId(BASE_SEPOLIA_CHAIN_ID) === n.pool, "Base Sepolia found by key and chain id");
  assert(n.testnet && n.ceremony === "production" && n.nativeShield, "Base Sepolia: test funds, final keys, ETH listed");
  assert(live.indexOf(n) === live.indexOf(GLOAM_NETWORKS.tempo) + 1, "gloamNetworks puts Base Sepolia after the older testnets");
  assert(n.payMemo === BASE_SEPOLIA_PAY_MEMO && payMemoBoardFor(BASE_SEPOLIA_CHAIN_ID)?.deployBlock === 49_804_175n, "Base Sepolia's memo board");
  assertDepositAllowed(BASE_SEPOLIA_CHAIN_ID, BASE_SEPOLIA_USDC, 500_000_000n);
  // amounts are read live from the vault now (limits.selftest), not from the launch values
  assertDepositAllowed(BASE_SEPOLIA_CHAIN_ID, BASE_SEPOLIA_EURC, 500_000_001n);
  assertDepositAllowed(BASE_SEPOLIA_CHAIN_ID, NATIVE_ASSET, 210_000_000_000_000_000n);
  throws(() => assertDepositAllowed(BASE_SEPOLIA_CHAIN_ID, BASE_USDT, 1n), /does not list/, "Base Sepolia: mainnet USDT refused");
}
await throwsAsync(
  () => buildShieldIntent({ chainId: BASE_SEPOLIA_CHAIN_ID, poolAddress: "0x00000000000000000000000000000000000000cc", amountWei: 1n }),
  /Plain shield\(\) is off on Base testnet/,
  "Base Sepolia: plain shield is refused, pool or not"
);

for (const [family, chainId, key, assets, native, memo] of [
  ["robinhood", RH_MAINNET_CHAIN_ID, "robinhood-mainnet", [RH_MAINNET_USDG, GLOAM_TOKEN, RH_MAINNET_GRIFT, NATIVE_ASSET, RH_MAINNET_PONS, RH_MAINNET_CASHCAT, RH_MAINNET_AI, RH_MAINNET_ORBIO], true, true],
  ["tempo", TEMPO_MAINNET_CHAIN_ID, "tempo-mainnet", [TEMPO_USDCE, TEMPO_PATHUSD, TEMPO_USDT0, TEMPO_OUSD], false, true],
  ["base", BASE_MAINNET_CHAIN_ID, "base-mainnet", [BASE_USDC, BASE_EURC, BASE_USDT, NATIVE_ASSET, BASE_BDX], true, false],
]) {
  const filled = mainnetPoolFor(chainId);
  const net = mainnetNetwork(family);
  if (!filled) {
    // Before deploy day: hidden, and refused rather than guessed.
    assert(net === null && getGloamNetwork(key) === null && networkForChainId(chainId) === undefined, `${key} hidden until its pool is in`);
    throws(() => poolForChainId(chainId), /not in this version/, `${key}: no pool guessed`);
    await throwsAsync(
      () => buildShieldBoundIntent({ chainId, asset: assets[0], amountWei: 1_000_000n, prover }),
      /not in this version/,
      `${key}: builder refuses a mainnet without a pool`
    );
    continue;
  }
  assert(net && net.key === key && net.chainId === chainId && net.pool === filled.pool && net.deployBlock === filled.deployBlock, `${key} entry`);
  assert(net.testnet === false && net.ceremony === "production" && net.nativeShield === native, `${key}: mainnet, final keys, native ${native ? "listed" : "not listed"}`);
  // Robinhood Chain and Tempo have a board. Base gets its own with its vault: base-mainnet-after-deploy.sh
  // writes both, so a board, when there is one, is the one incoming payments are scanned on, posted after the vault.
  const board = payMemoBoardFor(chainId);
  if (memo) assert(/^0x[0-9a-fA-F]{40}$/.test(net.payMemo ?? ""), `${key}: its memo board`);
  assert(net.payMemo === (board?.address ?? null), `${key}: the network's memo board is the one payments are scanned on`);
  if (board) assert(board.deployBlock >= filled.deployBlock && board.emitsPoster === false, `${key}: board deployed after the vault, never logs the poster`);
  assert(net.assets.map((a) => a.address).join() === assets.join(), `${key} assets`);
  assert(live[0].testnet === false, "mainnets come first");
  assert(poolForChainId(chainId) === filled.pool, `${key} pool by chain id`);
  // Deposits: listed assets only, within the per-deposit limit, never native.
  const usd = net.assets[0];
  assertDepositAllowed(chainId, usd.address, usd.depositLimit.perDeposit);
  assertDepositAllowed(chainId, usd.address, usd.depositLimit.perDeposit + 1n); // amounts are read live, never from this table
  if (!native) throws(() => assertDepositAllowed(chainId, NATIVE_ASSET, 1n), /no native deposits/, `${key}: native refused`);
  throws(() => assertDepositAllowed(chainId, "0x00000000000000000000000000000000000000bb", 1n), /does not list/, `${key}: unlisted asset refused`);
  const intent = await buildShieldBoundIntent({ chainId, asset: usd.address, amountWei: usd.depositLimit.perDeposit, prover });
  assert(intent.exec.poolAddress === filled.pool && intent.chainId === chainId, `${key}: shield targets the mainnet pool`);
  await throwsAsync(
    () => buildPrivateTradeIntent({ chainId, secretHex: "0x01", amountInWei: 1n, amountSwapWei: 1n, assetOut: usd.address, amountOutMinWei: 1n, rateIn: 1n, rateOut: 1n, path: {}, prove: prover }),
    /payments only/,
    `${key}: no private trading`
  );
}

// ── limits per asset ──────────────────────────────────────────────────────────────
// Checked on the asset tables directly, so they hold before the pools are in too.
{
  const { RH_MAINNET_ASSETS, TEMPO_MAINNET_ASSETS, BASE_MAINNET_ASSETS, BASE_SEPOLIA_ASSETS } = await import("../dist/index.js");
  const stable = (a) => a.symbol !== "ETH" && a.symbol !== "BDX";
  // The mainnet stablecoins as read on chain on 2026-11-02; Base Sepolia keeps its launch value.
  for (const a of [...TEMPO_MAINNET_ASSETS, RH_MAINNET_ASSETS[0], ...BASE_MAINNET_ASSETS.filter(stable)]) {
    assert(a.decimals === 6 && a.depositLimit.perDeposit === 50_000_000_000n && a.depositLimit.total === 2_500_000_000_000n, `${a.symbol}: 50,000 per deposit, 2,500,000 total`);
  }
  for (const a of BASE_SEPOLIA_ASSETS.filter(stable)) {
    assert(a.decimals === 6 && a.depositLimit.perDeposit === 500_000_000n && a.depositLimit.total === 25_000_000_000n, `${a.symbol} on Base Sepolia: 500 per deposit, 25,000 total`);
  }
  const g = RH_MAINNET_ASSETS[1];
  assert(g.symbol === "GLOAM" && g.decimals === 18 && g.depositLimit.perDeposit === 2_500_000n * 10n ** 18n && g.depositLimit.total === 25_000_000n * 10n ** 18n, "GLOAM: 2,500,000 per deposit, 25,000,000 total");
  // The limit queued for each of ETH, AI and ORBIO (contracts/script/archive/QueueRobinhoodAssets.s.sol, 0 on chain
  // until it lands), and the limit live on PONS and CASHCAT, as read on chain on 2026-11-02.
  const whole = (n) => BigInt(n) * 10n ** 18n;
  const rhLimits = {
    ETH: [NATIVE_ASSET, 11, 110],
    PONS: [RH_MAINNET_PONS, 390_000, 9_800_000],
    CASHCAT: [RH_MAINNET_CASHCAT, 960_000, 24_000_000],
    AI: [RH_MAINNET_AI, 400_000, 4_000_000],
    ORBIO: [RH_MAINNET_ORBIO, 1_000_000, 10_000_000],
  };
  for (const [symbol, [address, per, total]] of Object.entries(rhLimits)) {
    const a = RH_MAINNET_ASSETS.find((x) => x.symbol === symbol);
    assert(a.address === address && a.decimals === 18, `${symbol}: its address, 18 decimals`);
    assert(a.depositLimit.perDeposit === whole(per) && a.depositLimit.total === whole(total), `${symbol}: ${per} per deposit, ${total} total`);
  }
  assert(BASE_MAINNET_ASSETS.map((a) => a.address).join() === [BASE_USDC, BASE_EURC, BASE_USDT, NATIVE_ASSET, BASE_BDX].join(), "Base mainnet lists USDC, EURC, USDT, ETH and BDX");
  // BDX (Beldex, LayerZero OFT): the same address on Base and Ethereum, 9 decimals,
  // no limit once its timelocked change lands (0 on chain until then).
  assert(BASE_BDX === "0x6ad12E761b438beA3EA09F6C6266556Bb24C2181" && ETHEREUM_BDX === BASE_BDX, "BDX: one address on Base and Ethereum");
  const bdx = BASE_MAINNET_ASSETS.find((a) => a.symbol === "BDX");
  assert(bdx.decimals === 9 && bdx.depositLimit.perDeposit === (1n << 128n) - 1n && bdx.depositLimit.total === (1n << 128n) - 1n, "BDX: no limit once it lands");
  assert(!BASE_SEPOLIA_ASSETS.some((a) => a.symbol === "BDX"), "no BDX on Base Sepolia");
  assert(BASE_SEPOLIA_ASSETS.map((a) => a.address).join() === [BASE_SEPOLIA_USDC, BASE_SEPOLIA_EURC, NATIVE_ASSET].join(), "Base Sepolia lists USDC, EURC and ETH (no USDT)");
  const mainEth = BASE_MAINNET_ASSETS.find((a) => a.symbol === "ETH");
  assert(mainEth.decimals === 18 && mainEth.depositLimit.perDeposit === 20n * 10n ** 18n && mainEth.depositLimit.total === 1_000n * 10n ** 18n, "Base ETH: 20 per deposit, 1,000 total");
  const testEth = BASE_SEPOLIA_ASSETS.find((a) => a.symbol === "ETH");
  assert(testEth.decimals === 18 && testEth.depositLimit.perDeposit === 2n * 10n ** 17n && testEth.depositLimit.total === 10n * 10n ** 18n, "Base Sepolia ETH: 0.2 per deposit, 10 total");
}

// ── x402 requirements resolve the pool from the network ─────────────────────────
{
  const payee = await generateReceiveKey();
  const req = buildGloamPaymentRequirements({ amountWei: 10n, asset: TEMPO_PATHUSD, payTo: payee.tag, resource: "r", network: TEMPO_TESTNET_CHAIN_ID });
  assert(req.poolAddress === TEMPO_SEALED_VAULT, "requirements on Tempo testnet name the Tempo pool");
  if (!mainnetPoolFor(TEMPO_MAINNET_CHAIN_ID)) {
    throws(
      () => buildGloamPaymentRequirements({ amountWei: 10n, asset: TEMPO_USDCE, payTo: payee.tag, resource: "r", network: TEMPO_MAINNET_CHAIN_ID }),
      /not in this version/,
      "requirements refuse a mainnet without a pool"
    );
  }
}

console.log(`mainnet selftest: ${checks} checks passed`);
