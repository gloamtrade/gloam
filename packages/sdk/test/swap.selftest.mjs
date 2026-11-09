/**
 * Private swap planning self-test (swap.ts): the routers, the switches, routes,
 * escrows, the refund note's size, and the quote's stops, against a fake chain.
 * The app's own copy is held to the same answers by
 * app/scripts/selftest-sdk-swap-parity.mts.
 *
 * Run after build:  node test/swap.selftest.mjs
 */
import { keccak256, zeroAddress } from "viem";
import {
  BASE_SWAP_POOLS,
  ETHEREUM_SWAP_POOLS,
  IMPACT_STOP_BPS,
  RH_SWAP_POOLS_V2,
  RH_WETH,
  SWAP_ESCROW2_CODE_HASH,
  SWAP_ESCROW2_INIT_CODE,
  SWAP_ESCROW_CODE_HASH,
  SWAP_ESCROW_INIT_CODE,
  SWAP_SEND_MARGIN_SECONDS,
  SwapQuoteRefused,
  VAULT_SWAP_V3_ADDRESS,
  VAULT_SWAP_V3_LIVE,
  cashOutFee,
  encodeRoute,
  escrowAddress,
  exitAccount,
  exitDigest,
  hasSwapFloor,
  isKnownRoute,
  isSwapAsset,
  maxSwapInForRefund,
  planVaultSwap,
  poolId,
  refundAmountFor,
  refundFits,
  routeCurrencies,
  routesBetween,
  smallestSwapUsd,
  swapBufferBps,
  swapChainIds,
  swapChecked,
  swapDeadlineSeconds,
  swapExpired,
  swapGasUnits,
  swapRouterFor,
  swapRoutersOn,
  vaultFeeOf,
  vaultSwapAssets,
  vaultSwapRouter,
} from "../dist/index.js";

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
    assert(re.test(e.message), `${msg}: "${e.message}"`);
    return e;
  }
  assert(false, `${msg}: should throw`);
}
const same = (a, b) => a.toLowerCase() === b.toLowerCase();

const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const GLOAM = "0xDcD885F5c60b3aD49F6D58718696417314e8724d";
const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const BASE_USDT = "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2";
const BASE_EURC = "0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42";
const ETH_USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const ETH_USDT = "0xdAC17F958D2ee523a2206206994597C13D831ec7";

// ── switches and routers ──
assert(same(vaultSwapRouter(4663), "0xfCa1887e77f738ef9C5751974b3f3873d029F2DC"), "Robinhood Chain: router v2 is what new swaps use");
assert(swapRouterFor(4663).version === 2, "Robinhood Chain router is v2");
assert(swapRoutersOn(4663).length === 2 && swapRoutersOn(4663)[1].version === 1, "v1 stays known for its refunds");
assert(same(vaultSwapRouter(4217), "0xfCa1887e77f738ef9C5751974b3f3873d029F2DC") && swapRouterFor(4217).venue === "tempo", "Tempo router");
assert(vaultSwapRouter(8453) === null && swapRouterFor(8453) === null, "Base is off until its switch holds an address");
assert(vaultSwapRouter(1) === null && swapRouterFor(1) === null, "Ethereum is off until its switch holds an address");
assert(vaultSwapAssets(8453).length === 0 && vaultSwapAssets(1).length === 0, "no swap assets while off");
assert(swapChainIds().join(",") === "4663,4217", "live swap chains today");
assert(swapRouterFor(46630) === null && swapRouterFor(84532) === null, "no swaps on the testnets");
assert(swapRouterFor(4663, "0x000000000000000000000000000000000000dEaD") === null, "an unknown router is refused");

// a switch holding any address but the pinned one stays off
VAULT_SWAP_V3_LIVE[8453] = "0x000000000000000000000000000000000000bEEF";
assert(vaultSwapRouter(8453) === null, "a switch with an unpinned address stays off");
VAULT_SWAP_V3_LIVE[8453] = VAULT_SWAP_V3_ADDRESS[8453];
const base = swapRouterFor(8453);
assert(base && base.version === 3 && same(base.address, VAULT_SWAP_V3_ADDRESS[8453]), "Base turns on at its pinned address");
assert(vaultSwapAssets(8453).length === 4 && isSwapAsset(8453, zeroAddress), "Base assets, native ETH included");
assert(swapChainIds().includes(8453), "Base listed once on");
assert(swapChecked(8453) && swapChecked(1) && !swapChecked(4663), "Base and Ethereum quotes are held to the stops");
assert(swapDeadlineSeconds(8453) === 600 && swapDeadlineSeconds(4663) === 1800, "deadlines: 10 minutes where checked, else 30");
VAULT_SWAP_V3_LIVE[8453] = null;
assert(vaultSwapRouter(8453) === null, "switched back off");

// ── routes ──
const rh = swapRouterFor(4663);
const direct = routesBetween(USDG, GLOAM, rh);
assert(direct.length > 0 && direct[0].length === 1, "USDG -> GLOAM has a one-hop route");
for (const r of direct.slice(0, 10)) assert(routeCurrencies(rh, USDG, GLOAM, r) !== null, "every route passes the router's own rules");
assert(isKnownRoute(4663, USDG, GLOAM, direct[0]), "known route");
assert(!isKnownRoute(4663, USDG, GLOAM, [BASE_SWAP_POOLS[0]]), "a pool that isn't the router's is refused");
assert(!isKnownRoute(4663, USDG, GLOAM, []), "an empty route on v4 is refused");
assert(isKnownRoute(4217, "0x20c000000000000000000000b9537d11c60e8b50", "0x20c0000000000000000000000000000000000000", []), "Tempo takes no route");
assert(routeCurrencies(rh, zeroAddress, USDG, [RH_SWAP_POOLS_V2[0]]) === null, "v2 takes no native ETH note");
assert(routeCurrencies(rh, USDG, USDG, [RH_SWAP_POOLS_V2[0]]) === null, "same asset refused");
assert(routesBetween(USDG, RH_WETH, rh).some((r) => r.length === 1), "WETH reachable");
const enc = encodeRoute(direct[0]);
assert(keccak256(enc).length === 66 && encodeRoute([]) === "0x", "route bytes");
assert(poolId(RH_SWAP_POOLS_V2[0]).length === 66, "pool id");

// ── escrow and exit ──
assert(keccak256(SWAP_ESCROW_INIT_CODE) === SWAP_ESCROW_CODE_HASH, "SwapEscrow init code matches its pinned hash");
assert(keccak256(SWAP_ESCROW2_INIT_CODE) === SWAP_ESCROW2_CODE_HASH, "SwapEscrow2 init code matches its pinned hash");
const H = (n) => "0x" + n.toString(16).padStart(64, "0");
const key = {
  nullifier: H(1), amountIn: 100n, outCommitment: H(2), assetOut: GLOAM, amountOut: 5n,
  refundCommitment: H(3), refundAmount: 99n, routeHash: keccak256(enc),
};
const e1 = escrowAddress(rh.address, USDG, key);
assert(/^0x[0-9a-fA-F]{40}$/.test(e1), "escrow is an address");
assert(e1 !== escrowAddress(rh.address, USDG, { ...key, amountOut: 6n }), "the escrow changes with the new note's amount");
assert(e1 !== escrowAddress(rh.address, GLOAM, key), "and with the asset in");
let threw = false;
try {
  escrowAddress(rh.address, USDG, { ...key, exitKey: "0x0000000000000000000000000000000000000001" });
} catch {
  threw = true;
}
assert(threw, "an exit key with no deadline is refused");
const e3 = escrowAddress(VAULT_SWAP_V3_ADDRESS[1], ETH_USDC, { ...key, exitKey: "0x0000000000000000000000000000000000000001", deadline: 10n });
assert(e3 !== escrowAddress(VAULT_SWAP_V3_ADDRESS[1], ETH_USDC, { ...key, exitKey: "0x0000000000000000000000000000000000000001", deadline: 11n }), "the deadline is in the v3 escrow key");
const acct = exitAccount(H(42));
assert(acct.address === exitAccount(H(42)).address && acct.address !== exitAccount(H(43)).address, "one exit key per refund secret");
const dig = exitDigest(1, VAULT_SWAP_V3_ADDRESS[1], e3, "0x00000000000000000000000000000000000000aa");
assert(dig !== exitDigest(8453, VAULT_SWAP_V3_ADDRESS[1], e3, "0x00000000000000000000000000000000000000aa"), "exit digest names the chain");
assert(dig !== exitDigest(1, VAULT_SWAP_V3_ADDRESS[1], e3, "0x00000000000000000000000000000000000000bb"), "exit digest names the recipient");

// ── deadlines ──
assert(!swapExpired(100n, 100n) && swapExpired(100n, 101n), "a swap lands up to and including its deadline");
assert(SWAP_SEND_MARGIN_SECONDS === 60, "the relay's send margin");

// ── refund note and fees ──
for (const [amt, bps] of [[1_000_000n, 25], [123_456_789n, 25], [7n, 25], [10n ** 18n, 100], [99_999n, 0]]) {
  assert(vaultFeeOf(amt, bps) === cashOutFee(amt, bps), `vault fee matches cashOutFee (${amt}, ${bps})`);
}
assert(refundAmountFor(1_000_000n) === 990_000n, "older routers: the amount less 1%");
assert(refundAmountFor(1_000_000n, 25) === 1_000_000n - 2_500n - 1_000n, "routers with an exit: less the fee now and 0.1%");
const room = { perDeposit: 50_000_000_000n, total: 2_500_000_000_000n, deposited: 1_000_000_000_000n };
const maxV3 = maxSwapInForRefund(room, 25);
assert(refundFits(room, maxV3, 25) && !refundFits(room, maxV3 + 1n, 25), "the most one swap may spend is exactly where its refund stops fitting");
const maxV2 = maxSwapInForRefund(room);
assert(refundFits(room, maxV2) && !refundFits(room, maxV2 + 1n), "the same for older routers");
assert(!refundFits({ ...room, perDeposit: 0n }, 1_000n, 25), "a vault taking none of the asset fits no refund");
assert(swapBufferBps(4217) === 10 && swapBufferBps(4663, USDG, GLOAM) === 50 && swapBufferBps(8453, BASE_USDC, BASE_USDT) === 10 && swapBufferBps(8453, BASE_USDC, BASE_EURC) === 50, "buffers");

// ── the relay's floor ──
assert(hasSwapFloor(1) && !hasSwapFloor(8453) && !hasSwapFloor(4663), "only Ethereum has a floor");
assert(swapGasUnits(1) === 1_700_000n && swapGasUnits(3) === 1_820_000n, "gas per hop");
const floor = smallestSwapUsd({ gasPriceWei: 1_000_000_000n, ethUsd: 3000, feeBps: 25, hops: 1 });
assert(Math.abs(floor - 2040) < 1e-6, `floor at 1 gwei, $3000, 0.25%: ${floor}`);
assert(smallestSwapUsd({ gasPriceWei: 1n, ethUsd: 1, feeBps: 0, hops: 1 }) === Infinity, "no fee, no floor");

// ── quotes, against a fake chain ──
function fakeQuoter({ out, small, cost, failExactOut = false, allowed = () => true }) {
  return {
    multicall: async ({ contracts }) =>
      contracts.map((c) => {
        if (c.functionName === "allowedPool") return allowed(c.args[0]);
        const amt = c.args[0].exactAmount;
        return { status: "success", result: [typeof out === "function" ? out(amt) : amt === small?.in ? small.out : out, 0n] };
      }),
    simulateContract: async () => {
      if (failExactOut) throw new Error("rpc down");
      return { result: [cost, 0n] };
    },
    readContract: async ({ functionName, args }) => {
      if (functionName === "quoteSwapExactAmountIn") return args[2];
      if (functionName === "quoteSwapExactAmountOut") return args[2];
      throw new Error(`unexpected read ${functionName}`);
    },
  };
}

// Robinhood Chain: a plain quote
{
  const amountIn = 100_000_000n;
  const available = amountIn - vaultFeeOf(amountIn, 25);
  const c = fakeQuoter({ out: (a) => a * 10n ** 12n, cost: available - 1000n });
  const plan = await planVaultSwap(c, 4663, { assetIn: USDG, assetOut: GLOAM, amountIn, feeBps: 25 });
  assert(plan.available === available, "available is the note less the vault fee");
  assert(plan.amountOut === (available * 10n ** 12n * 9950n) / 10_000n, "the new note is the quote less the buffer");
  assert(plan.cost <= plan.available && plan.leftover === plan.available - plan.cost, "cost and leftover");
  assert(isKnownRoute(4663, USDG, GLOAM, plan.route), "the planned route is one the router takes");
}
// the price moved: the exact-output check costs more than arrives
{
  const c = fakeQuoter({ out: (a) => a, cost: 10n ** 30n });
  await rejects(planVaultSwap(c, 4663, { assetIn: USDG, assetOut: GLOAM, amountIn: 1_000_000n, feeBps: 25 }), /moving too fast/, "a cost past what arrives is refused");
}
// Tempo
{
  const amountIn = 50_000_000n;
  const c = fakeQuoter({ out: 0n, cost: 0n });
  const plan = await planVaultSwap(c, 4217, { assetIn: "0x20c000000000000000000000b9537d11c60e8b50", assetOut: "0x20c0000000000000000000000000000000000000", amountIn, feeBps: 25 });
  assert(plan.route.length === 0 && plan.amountOut === ((amountIn - vaultFeeOf(amountIn, 25)) * 9990n) / 10_000n, "Tempo: no route, 0.1% buffer");
}
await rejects(planVaultSwap(fakeQuoter({ out: 1n, cost: 1n }), 8453, { assetIn: BASE_USDC, assetOut: BASE_USDT, amountIn: 1_000_000n, feeBps: 25 }), /not live/, "Base is refused while off");

// Base, switched on: the stops
VAULT_SWAP_V3_LIVE[8453] = VAULT_SWAP_V3_ADDRESS[8453];
{
  const amountIn = 10_000_000_000n;
  const available = amountIn - vaultFeeOf(amountIn, 25);
  // a thin pool: the full size gets far less per dollar than a hundredth of it
  const thin = fakeQuoter({ out: (a) => (a === available / 100n ? a : a / 2n), cost: 1n });
  const e = await rejects(planVaultSwap(thin, 8453, { assetIn: BASE_USDC, assetOut: BASE_EURC, amountIn, feeBps: 25 }), /too thin/, "a thin pool is refused on Base");
  assert(e instanceof SwapQuoteRefused, "as a SwapQuoteRefused");
  // two dollars far apart
  const offPeg = fakeQuoter({ out: (a) => (a * 95n) / 100n, cost: 1n });
  await rejects(planVaultSwap(offPeg, 8453, { assetIn: BASE_USDC, assetOut: BASE_USDT, amountIn: 1_000_000_000n, feeBps: 25 }), /too far apart/, "an off-peg dollar pair is refused on Base");
  // a fair dollar pair goes, with the thin buffer
  const fair = fakeQuoter({ out: (a) => a, cost: 1n });
  const plan = await planVaultSwap(fair, 8453, { assetIn: BASE_USDC, assetOut: BASE_USDT, amountIn: 1_000_000_000n, feeBps: 25 });
  assert(plan.impactBps === 0 && plan.pegBps === 0 && plan.route.length >= 1, "a fair quote on Base");
  assert(IMPACT_STOP_BPS === 200, "impact stop");
  assert(routesBetween(BASE_USDC, zeroAddress, swapRouterFor(8453)).length > 0, "USDC -> native ETH on Base");
}
VAULT_SWAP_V3_LIVE[8453] = null;
VAULT_SWAP_V3_LIVE[1] = VAULT_SWAP_V3_ADDRESS[1];
assert(swapRouterFor(1).pools.length === ETHEREUM_SWAP_POOLS.length && isSwapAsset(1, ETH_USDT), "Ethereum on: its pools and assets");
VAULT_SWAP_V3_LIVE[1] = null;


console.log(`swap selftest: ${checks} checks passed`);
