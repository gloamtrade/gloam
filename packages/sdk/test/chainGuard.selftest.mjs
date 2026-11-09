/**
 * SDK self-test: which chain a builder runs on when `chainId` is left out.
 *
 * The vault has one address on all four mainnets (and Base Sepolia), so a
 * builder can't tell the chain from `poolAddress`, and the Robinhood Chain
 * testnet default is wrong for it. Each builder refuses that before any proof
 * is made and asks for `chainId`, in any spelling of the address, and refuses
 * Ethereum Sepolia's vault the same way. With `chainId` the chain's own rules
 * apply and the intent names it. Everything else keeps the testnet default: no
 * pool at all, a Robinhood or Tempo testnet pool, a pool of the caller's.
 *
 * Run after build:  node test/chainGuard.selftest.mjs
 */
import { getAddress } from "viem";
import {
  BASE_SEPOLIA_CHAIN_ID,
  ETHEREUM_SEPOLIA_CHAIN_ID,
  IncrementalMerkleTreePoseidon,
  MAINNET_POOLS,
  NATIVE_ASSET,
  RH_MAINNET_CHAIN_ID,
  RH_MAINNET_USDG,
  RH_TESTNET_CHAIN_ID,
  SEALED_VAULT,
  TEMPO_SEALED_VAULT,
  baseSepoliaPool,
  buildPrivateSendIntent,
  buildPrivateTradeIntent,
  buildShieldBoundIntent,
  buildShieldIntent,
  buildUnshieldIntent,
  ethereumSepoliaPool,
  fieldToHex,
  mainnetNetwork,
  poseidon3,
} from "../dist/index.js";

let checks = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exit(1);
  }
  checks++;
}
const is = (actual, expected, msg) => assert(actual === expected, `${msg}: got ${JSON.stringify(actual)}`);

const WALLET = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const SOMEONES_POOL = "0x00000000000000000000000000000000000000cc";
const SECRET = 777n;
const AMOUNT = 5_000_000n;
const tree = new IncrementalMerkleTreePoseidon();
await tree.insert(await poseidon3(SECRET, AMOUNT, 0n));
const path = await tree.path(0);

let proofs = 0;
const prove = async () => (proofs++, { proofBytes: "0xdeadbeef" });
const spend = { secretHex: fieldToHex(SECRET), asset: NATIVE_ASSET, path, prove };

/** Every builder that takes a pool, each with what it needs to get as far as its proof. */
const BUILDERS = {
  buildShieldIntent: (over) => buildShieldIntent({ amountWei: 1n, ...over }),
  buildShieldBoundIntent: (over) => buildShieldBoundIntent({ amountWei: 1n, prover: prove, ...over }),
  buildUnshieldIntent: (over) => buildUnshieldIntent({ ...spend, amountWei: AMOUNT, to: WALLET, ...over }),
  buildPrivateSendIntent: (over) => buildPrivateSendIntent({ ...spend, amountInWei: AMOUNT, amountPayWei: AMOUNT, ...over }),
  buildPrivateTradeIntent: (over) =>
    buildPrivateTradeIntent({
      secretHex: fieldToHex(SECRET),
      assetIn: NATIVE_ASSET,
      path,
      prove,
      amountInWei: AMOUNT,
      amountSwapWei: AMOUNT / 2n,
      assetOut: WALLET,
      amountOutMinWei: 1n,
      rateIn: 1n,
      rateOut: 1n,
      ...over,
    }),
};

const refused = (run) => run.then(() => null, (e) => e);

const vaults = Object.values(MAINNET_POOLS).map((m) => m.pool);
is(vaults.length, 4, "four mainnets");
assert(new Set(vaults.map((v) => v.toLowerCase())).size === 1, "one vault address across the mainnets");
is(baseSepoliaPool().pool.toLowerCase(), vaults[0].toLowerCase(), "Base Sepolia runs at that address too");

// A mainnet vault with no chainId: refused before any proof, by every builder, in any spelling.
const hex = vaults[0].slice(2);
const spellings = [...new Set(vaults), `0x${hex.toLowerCase()}`, getAddress(vaults[0]), `0x${hex.toUpperCase()}`];
for (const [name, build] of Object.entries(BUILDERS)) {
  for (const poolAddress of spellings) {
    for (const over of [{ poolAddress }, { poolAddress, chainId: undefined }, { poolAddress, chainId: null }]) {
      proofs = 0;
      const err = await refused(build(over));
      assert(err && /Pass chainId/.test(err.message), `${name} refuses ${poolAddress} with no chainId: ${err?.message ?? "built"}`);
      is(proofs, 0, `${name} makes no proof first`);
    }
  }
}

// With chainId: the intent names that mainnet and its own rules apply.
for (const key of ["robinhood", "tempo", "base", "ethereum"]) {
  const net = mainnetNetwork(key);
  assert(net, `${key} mainnet is in this SDK`);
  const over = { chainId: net.chainId, poolAddress: net.pool };
  const asset = net.assets.find((a) => a.address !== NATIVE_ASSET);
  const shielded = await BUILDERS.buildShieldBoundIntent({ ...over, asset: asset.address });
  const out = await BUILDERS.buildUnshieldIntent(over);
  const sent = await BUILDERS.buildPrivateSendIntent(over);
  for (const intent of [shielded, out, sent]) {
    is(intent.chainId, net.chainId, `${intent.intent} names ${key}`);
    is(intent.exec.poolAddress, net.pool, `${intent.intent} targets the vault passed in`);
  }
  assert(out.execution.includes("cash-out fee"), `${key} is treated as a mainnet pool`);
}
const rhErr = await refused(BUILDERS.buildUnshieldIntent({ chainId: RH_MAINNET_CHAIN_ID, poolAddress: vaults[0], to: RH_MAINNET_USDG }));
assert(rhErr && /token contract/.test(rhErr.message), "a mainnet token list applies once the chain is known");
for (const name of ["buildShieldIntent", "buildPrivateTradeIntent"]) {
  const err = await refused(BUILDERS[name]({ chainId: RH_MAINNET_CHAIN_ID, poolAddress: vaults[0] }));
  assert(err && !/Pass chainId/.test(err.message), `${name} keeps its own refusal on mainnet: ${err?.message ?? "built"}`);
}

// Base Sepolia shares the address, and its chainId is all it takes.
const onSepolia = await BUILDERS.buildUnshieldIntent({ chainId: BASE_SEPOLIA_CHAIN_ID, poolAddress: baseSepoliaPool().pool });
is(onSepolia.chainId, BASE_SEPOLIA_CHAIN_ID, "Base Sepolia keeps its chain");

// Ethereum Sepolia's vault has its own address, and never falls to the Robinhood testnet default.
const sepoliaVault = ethereumSepoliaPool().pool;
assert(!vaults.some((v) => v.toLowerCase() === sepoliaVault.toLowerCase()), "Ethereum Sepolia's vault is not the mainnet address");
const sepoliaHex = sepoliaVault.slice(2);
for (const [name, build] of Object.entries(BUILDERS)) {
  for (const poolAddress of [sepoliaVault, `0x${sepoliaHex.toLowerCase()}`, getAddress(sepoliaVault), `0x${sepoliaHex.toUpperCase()}`]) {
    for (const over of [{ poolAddress }, { poolAddress, chainId: undefined }, { poolAddress, chainId: null }]) {
      proofs = 0;
      const err = await refused(build(over));
      assert(err && /Ethereum Sepolia.*Pass chainId/.test(err.message), `${name} refuses ${poolAddress} with no chainId: ${err?.message ?? "built"}`);
      is(proofs, 0, `${name} makes no proof first`);
    }
  }
}
const overSepolia = { chainId: ETHEREUM_SEPOLIA_CHAIN_ID, poolAddress: sepoliaVault };
for (const intent of [await BUILDERS.buildUnshieldIntent(overSepolia), await BUILDERS.buildPrivateSendIntent(overSepolia)]) {
  is(intent.chainId, ETHEREUM_SEPOLIA_CHAIN_ID, `${intent.intent} keeps Ethereum Sepolia when chainId is passed`);
  is(intent.exec.poolAddress, sepoliaVault, `${intent.intent} targets the vault passed in`);
}

// The testnet default is unchanged for everything else.
for (const [name, build] of Object.entries(BUILDERS)) {
  const none = await build({});
  is(none.chainId, RH_TESTNET_CHAIN_ID, `${name} still defaults to the testnet`);
  is(none.exec.poolAddress, SEALED_VAULT, `${name} on the testnet pool`);
  for (const poolAddress of [SEALED_VAULT, TEMPO_SEALED_VAULT, SOMEONES_POOL]) {
    const given = await build({ poolAddress });
    is(given.chainId, RH_TESTNET_CHAIN_ID, `${name} with ${poolAddress} keeps the default`);
    is(given.exec.poolAddress, poolAddress, `${name} uses the pool passed in`);
  }
}

console.log(`chainGuard.selftest: ok (${checks} assertions)`);
process.exit(0);
