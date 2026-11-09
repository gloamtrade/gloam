/**
 * Cash-out recipient self-test.
 *
 * An agent that signs its own cash out never reaches the relay, so the SDK has
 * to refuse what the relay refuses, on every network. Boards and routers below
 * are read from contracts/deployments, not from the SDK, so a wrong address in
 * the SDK fails here. selftest-relay in app/ checks the SDK against every token
 * the app lists.
 *
 * Run after build:  node test/cashOutRecipient.selftest.mjs
 */
import { readFileSync } from "node:fs";
import {
  CASH_OUT_TO_BOARD_MESSAGE,
  CASH_OUT_TO_ROUTER_MESSAGE,
  CASH_OUT_TO_TOKEN_MESSAGE,
  CASH_OUT_TO_VAULT_MESSAGE,
  CASH_OUT_TO_ZERO_MESSAGE,
  GLOAM_NETWORKS,
  IncrementalMerkleTreePoseidon,
  NATIVE_ASSET,
  RH_MAINNET_USDG,
  assertDepositAllowed,
  buildUnshieldIntent,
  cashOutTargetProblem,
  fieldToHex,
  getGloamNetwork,
  gloamNetworks,
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

const deployed = (file) => JSON.parse(readFileSync(new URL(`../../../contracts/deployments/${file}`, import.meta.url), "utf8"));
const chains = deployed("mainnet.json").chains;

const ZERO = "0x0000000000000000000000000000000000000000";
const WALLET = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const RH_V1 = chains[4663].GloamVaultSwapV4;
const RH_V2 = chains[4663].GloamVaultSwapV4b;
const TEMPO_ROUTER = chains[4217].GloamVaultSwapTempo;

const BOARDS = {
  "robinhood-mainnet": chains[4663].GloamPayMemo,
  "tempo-mainnet": chains[4217].GloamPayMemo,
  "base-mainnet": deployed("base-mainnet.json").contracts.GloamPayMemo,
  "ethereum-mainnet": deployed("ethereum-mainnet.json").contracts.GloamPayMemo,
  robinhood: deployed("poseidon-testnet.json").contracts.GloamPayMemo,
  tempo: GLOAM_NETWORKS.tempo.payMemo, // Moderato has no deployment record
  base: deployed("base-sepolia.json").contracts.GloamPayMemo,
  ethereum: deployed("ethereum-sepolia.json").contracts.GloamPayMemo,
};
const ROUTERS = { "robinhood-mainnet": [RH_V1, RH_V2], "tempo-mainnet": [TEMPO_ROUTER] };

const nets = gloamNetworks();
is(nets.length, Object.keys(BOARDS).length, "every network is checked, none skipped");

// The same answer on every network, in any letter case.
const spellings = (a) => [a, a.toLowerCase(), a.toUpperCase().replace("0X", "0x"), `  ${a}\n`];
for (const net of nets) {
  const refuses = (a, message, what) => {
    for (const to of spellings(a)) is(cashOutTargetProblem(to, net), message, `${what} on ${net.key} (${to})`);
  };
  refuses(net.pool, CASH_OUT_TO_VAULT_MESSAGE, "the vault");
  refuses(BOARDS[net.key], CASH_OUT_TO_BOARD_MESSAGE, "the board");
  refuses(ZERO, CASH_OUT_TO_ZERO_MESSAGE, "the zero address");
  for (const r of ROUTERS[net.key] ?? []) refuses(r, CASH_OUT_TO_ROUTER_MESSAGE, "a router");
  const tokens = net.assets.filter((a) => a.address !== NATIVE_ASSET);
  assert(tokens.length > 0, `${net.key} lists tokens`);
  for (const t of tokens) refuses(t.address, CASH_OUT_TO_TOKEN_MESSAGE, t.symbol);
  is(cashOutTargetProblem(WALLET, net), null, `a wallet on ${net.key}`);
}

// The next routers' addresses are known before they deploy, and refused from the start.
const pinned = JSON.parse(readFileSync(new URL("../../../contracts/test/fixtures/router-next.json", import.meta.url), "utf8"));
for (const [id, c] of Object.entries(pinned.chains)) {
  is(cashOutTargetProblem(c.address, { chainId: Number(id) }), CASH_OUT_TO_ROUTER_MESSAGE, `${c.name}: the next router`);
  is(cashOutTargetProblem(c.address, { chainId: 46630 }), null, `${c.name}: its router is nothing on another chain`);
}

// WETH isn't a vault asset on Base or Ethereum, but money sent to its contract is lost all the same.
is(cashOutTargetProblem("0x4200000000000000000000000000000000000006", { chainId: 8453 }), CASH_OUT_TO_TOKEN_MESSAGE, "WETH on Base");
is(cashOutTargetProblem("0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", { chainId: 1 }), CASH_OUT_TO_TOKEN_MESSAGE, "WETH on Ethereum");

// One address, a different answer on each chain: lists are never matched across chains.
const shared = "0xfCa1887e77f738ef9C5751974b3f3873d029F2DC";
is(cashOutTargetProblem(shared, { chainId: 4663 }), CASH_OUT_TO_ROUTER_MESSAGE, "0xfCa1 is a router on Robinhood Chain");
is(cashOutTargetProblem(shared, { chainId: 4217 }), CASH_OUT_TO_ROUTER_MESSAGE, "0xfCa1 is a router on Tempo");
is(cashOutTargetProblem(shared, { chainId: 8453 }), CASH_OUT_TO_BOARD_MESSAGE, "0xfCa1 is the board on Base");
for (const chainId of [1, 84532, 11155111, 46630, 42431]) is(cashOutTargetProblem(shared, { chainId }), null, `0xfCa1 is nothing on ${chainId}`);
for (const chainId of [4217, 8453, 1]) is(cashOutTargetProblem(RH_V1, { chainId }), null, `the old router is nothing on ${chainId}`);
is(cashOutTargetProblem(BOARDS["robinhood-mainnet"], { chainId: 84532 }), CASH_OUT_TO_BOARD_MESSAGE, "that board address is Base Sepolia's too");
is(cashOutTargetProblem(BOARDS["robinhood-mainnet"], { chainId: 8453 }), null, "and nothing on Base mainnet");
is(cashOutTargetProblem(RH_MAINNET_USDG, { chainId: 8453 }), null, "Robinhood Chain's USDG is nothing on Base");

// Tokens the pool doesn't list are refused as recipients and stay refused as deposits.
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const TSLA = "0x322F0929c4625eD5bAd873c95208D54E1c003b2d";
const MU = "0xfF080c8ce2E5feadaCa0Da81314Ae59D232d4afD";
const TESTNET_TSLA = "0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E";
for (const a of [WETH, TSLA, MU]) {
  is(cashOutTargetProblem(a, { chainId: 4663 }), CASH_OUT_TO_TOKEN_MESSAGE, `${a} on Robinhood Chain`);
  is(cashOutTargetProblem(a, { chainId: 8453 }), null, `${a} on Base`);
  let refused = false;
  try {
    assertDepositAllowed(4663, a, 1n);
  } catch {
    refused = true;
  }
  assert(refused, `${a} is still no deposit`);
  assert(!getGloamNetwork("robinhood-mainnet").assets.some((x) => x.address === a), `${a} is not a listed asset`);
}
// Listed tokens are refused as recipients through `assets`: PONS and CASHCAT moved there from the
// unlisted list, and AI and ORBIO are new. Each is a deposit now, and still never a place to cash out to.
const PONS = "0x39dBED3a2bd333467115dE45665cC57F813C4571";
const CASHCAT = "0x020bfC650A365f8BB26819deAAbF3E21291018b4";
const AI = "0x2E8c31162b855A2ffa90F6F8634643Ad6F111e18";
const ORBIO = "0xAa07A0e9209e16aC99708C3EC70159c6eF3128A3";
for (const a of [PONS, CASHCAT, AI, ORBIO]) {
  is(cashOutTargetProblem(a, { chainId: 4663 }), CASH_OUT_TO_TOKEN_MESSAGE, `${a} on Robinhood Chain`);
  is(cashOutTargetProblem(a.toLowerCase(), { chainId: 4663 }), CASH_OUT_TO_TOKEN_MESSAGE, `${a} in lowercase`);
  is(cashOutTargetProblem(a, { chainId: 8453 }), null, `${a} is nothing on Base`);
  assertDepositAllowed(4663, a, 1n);
}
// ETH sits in `assets` as the zero address: still the zero-address answer, not "a token".
is(cashOutTargetProblem("0x0000000000000000000000000000000000000000", { chainId: 4663 }), CASH_OUT_TO_ZERO_MESSAGE, "the zero address on Robinhood Chain");
assertDepositAllowed(4663, "0x0000000000000000000000000000000000000000", 1n);
is(cashOutTargetProblem(TESTNET_TSLA, { chainId: 46630 }), CASH_OUT_TO_TOKEN_MESSAGE, "a faucet stock token on the testnet");
is(cashOutTargetProblem(TESTNET_TSLA, { chainId: 4663 }), null, "and nothing on mainnet");
assert(!GLOAM_NETWORKS.robinhood.assets.some((x) => x.address === TESTNET_TSLA), "the faucet stock tokens stay out of the testnet's assets");

// What a caller adds, and a chain the SDK doesn't know.
const OTHER_POOL = "0x1111111111111111111111111111111111111111";
const base = getGloamNetwork("base-mainnet");
is(cashOutTargetProblem(OTHER_POOL, { chainId: base.chainId, pool: OTHER_POOL }), CASH_OUT_TO_VAULT_MESSAGE, "the vault passed in");
is(cashOutTargetProblem(base.pool, { chainId: base.chainId, pool: OTHER_POOL }), CASH_OUT_TO_VAULT_MESSAGE, "the network's own vault, with another passed in");
is(cashOutTargetProblem(OTHER_POOL, { chainId: base.chainId, pool: null, payMemo: null }), null, "no vault passed in: an address");
is(cashOutTargetProblem(OTHER_POOL, { chainId: 8453, payMemo: OTHER_POOL }), CASH_OUT_TO_BOARD_MESSAGE, "a board passed in");
is(cashOutTargetProblem(OTHER_POOL, { chainId: 8453, routers: [OTHER_POOL] }), CASH_OUT_TO_ROUTER_MESSAGE, "a router passed in");
is(cashOutTargetProblem(OTHER_POOL, { chainId: 8453, tokens: [OTHER_POOL] }), CASH_OUT_TO_TOKEN_MESSAGE, "a token passed in");
is(cashOutTargetProblem(OTHER_POOL, { chainId: 999, pool: OTHER_POOL }), CASH_OUT_TO_VAULT_MESSAGE, "an unknown chain still has its vault");
is(cashOutTargetProblem(ZERO, { chainId: 999 }), CASH_OUT_TO_ZERO_MESSAGE, "and the zero address");
is(cashOutTargetProblem(shared, { chainId: 999 }), null, "and nothing else");

// The builder refuses before any proof is made, and a wallet still goes through.
const SECRET = 777n;
const AMOUNT = 5_000_000n;
const tree = new IncrementalMerkleTreePoseidon();
await tree.insert(await poseidon3(SECRET, AMOUNT, 0n));
const path = await tree.path(0);
const cases = [
  ["robinhood-mainnet", RH_V2, /swap router/],
  ["robinhood-mainnet", RH_V1, /swap router/],
  ["robinhood-mainnet", WETH, /token contract/],
  ["tempo-mainnet", TEMPO_ROUTER, /swap router/],
  ["base-mainnet", BOARDS["base-mainnet"], /message board/],
  ["base-mainnet", base.assets[0].address, /token contract/],
  ["ethereum-mainnet", BOARDS["ethereum-mainnet"], /message board/],
  ["ethereum-mainnet", getGloamNetwork("ethereum-mainnet").assets[0].address, /token contract/],
  ["ethereum-mainnet", ZERO, /zero address/],
  ["base-mainnet", base.pool, /vault itself/],
];
for (const [key, to, why] of cases) {
  const net = getGloamNetwork(key);
  let proved = false;
  const err = await buildUnshieldIntent({
    secretHex: fieldToHex(SECRET),
    amountWei: AMOUNT,
    asset: NATIVE_ASSET,
    to,
    path,
    chainId: net.chainId,
    prove: async () => ((proved = true), { proofBytes: "0xdeadbeef" }),
  }).then(() => null, (e) => e);
  assert(err && why.test(err.message) && !proved, `${to} on ${key} is refused before proving`);
}
for (const net of nets) {
  const u = await buildUnshieldIntent({
    secretHex: fieldToHex(SECRET),
    amountWei: AMOUNT,
    asset: NATIVE_ASSET,
    to: WALLET,
    path,
    chainId: net.chainId,
    prove: async () => ({ proofBytes: "0xdeadbeef" }),
  });
  is(u.exec.args[4], WALLET, `a wallet builds on ${net.key}`);
}

console.log(`cashOutRecipient.selftest: ok (${checks} assertions)`);
process.exit(0);
