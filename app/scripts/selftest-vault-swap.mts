/**
 * Self-test: private swaps through the vault (lib/vaultSwap, the relay's swap call).
 *
 *  - routes: only the router's allowlisted pools, one hop or two through a shared currency
 *  - v2: every pool and route rule the router has (three hops, ETH through WETH at the ends,
 *    each currency once), the switch, and the relay keeping v1 for its refunds
 *  - the route bytes decode as the router's PoolKey[] and the pool ids are the live ones
 *  - the cash-out fee matches the vault's math
 *  - a quote stops showing once it is old, and the swap sends a fresher price only when it gives more
 *  - the relay refuses a swap while no router is set, and a bad asset or route before any read
 *  - with --live: a real quote on Robinhood Chain and Tempo mainnet (read-only)
 *
 * Run: npx tsx scripts/selftest-vault-swap.mts [--live]
 *      (--live also quotes v2's pairs: USDG, GLOAM, WETH, PONS and CASHCAT both ways, read-only)
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createPublicClient, decodeAbiParameters, encodeAbiParameters, http, keccak256, type Address } from "viem";
import {
  MAX_QUOTED_ROUTES,
  QUOTE_TTL_MS,
  RH_SWAP_ASSETS_V2,
  depositRoom,
  maxSwapInForRefund,
  priceImpactBps,
  refundFits,
  RH_SWAP_POOLS,
  RH_SWAP_POOLS_V2,
  RH_SWAP_POOLS_V2_QUEUED,
  RH_SWAP_ASSETS_V2_QUEUED,
  RH_WETH,
  VAULT_SWAP_ASSETS,
  VAULT_SWAP_V2_ROUTER,
  isSwapAsset,
  livePools,
  offeredSwapAssets,
  poolId,
  routeCurrencies,
  swapRouterFor,
  SWAP_ESCROW_CODE_HASH,
  SWAP_ESCROW_INIT_CODE,
  VAULT_SWAP_ROUTERS,
  encodeRoute,
  escrowAddress,
  refundEscrowKey,
  isKnownRoute,
  planVaultSwap,
  quoteFresh,
  refundAmountFor,
  replanVaultSwap,
  routesBetween,
  vaultFeeOf,
  vaultSwapRouter,
} from "../src/lib/vaultSwap";
import { getNetwork } from "../src/lib/networks";
import { RelayError, relayVaultSwap, relayVaultSwapExit } from "../src/lib/relay/server";
import { cashOutTargetProblem as appCashOutTargetProblem } from "../src/lib/cashOutTarget";
import {
  BASE_SWAP_POOLS,
  ETHEREUM_SWAP_POOLS,
  SWAP_DEADLINE_SECONDS,
  SWAP_ESCROW2_CODE_HASH,
  SWAP_ESCROW2_INIT_CODE,
  VAULT_SWAP_V3_ADDRESS,
  VAULT_SWAP_V3_LIVE,
  swapV3Live,
  canExitVaultSwap,
  exitAccount,
  exitDigest,
  swapBufferBps,
  swapExpired,
  swapRoutersOn,
} from "../src/lib/vaultSwap";
import { knownTokens } from "../src/lib/tokens";

let n = 0;
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as Address;
const GLOAM = "0xDcD885F5c60b3aD49F6D58718696417314e8724d" as Address;
const keyType = [
  { name: "currency0", type: "address" },
  { name: "currency1", type: "address" },
  { name: "fee", type: "uint24" },
  { name: "tickSpacing", type: "int24" },
  { name: "hooks", type: "address" },
] as const;

// The routers deployed on 2026-10-23, and nothing on the testnets. On Robinhood
// Chain new swaps go through v2 (any listed token, stocks included).
const RH_V1 = "0x34AB06208586A737Bf1607fa996Bc9162271c52d" as Address;
const RH_V2 = "0xfCa1887e77f738ef9C5751974b3f3873d029F2DC" as Address;
assert.equal(VAULT_SWAP_V2_ROUTER[4663], RH_V2, "v2 is switched on");
assert.equal(vaultSwapRouter(4663), RH_V2);
assert.deepEqual(VAULT_SWAP_ASSETS[4663], [...RH_SWAP_ASSETS_V2, ...RH_SWAP_ASSETS_V2_QUEUED], "on: v2's tokens, and the two queued ones");
assert.equal(swapRouterFor(4663)!.version, 2);
assert.equal(swapRouterFor(4663, RH_V1)!.version, 1, "the relay still knows v1 for its refunds");
assert.equal(vaultSwapRouter(4217), "0xfCa1887e77f738ef9C5751974b3f3873d029F2DC");
assert.equal(vaultSwapRouter(46630), null);
n += 7;

// The rest runs from the state before the switch (v1 only) and turns v2 on itself.
VAULT_SWAP_V2_ROUTER[4663] = null;
VAULT_SWAP_ROUTERS[4663] = RH_V1;
(VAULT_SWAP_ASSETS as Record<number, readonly Address[]>)[4663] = [USDG, GLOAM];

// The pool ids are the live ones the simulation used.
const ids = RH_SWAP_POOLS.map((k) => keccak256(encodeAbiParameters([{ type: "tuple", components: keyType }], [k])).slice(0, 10));
assert.deepEqual(ids, ["0x3b0cbf06", "0xc5f37371", "0xe5b1e488"]);
assert.deepEqual(RH_SWAP_POOLS.map((k) => poolId(k).slice(0, 10)), ids, "poolId is the v4 PoolId");
n += 2;
// v2's pools are the deploy script's, in order: both pinned by the same fixture
const fixture = JSON.parse(readFileSync(new URL("../../contracts/test/fixtures/vault-swap-v2-pools.json", import.meta.url), "utf8")) as {
  poolIds: string[];
};
assert.deepEqual(RH_SWAP_POOLS_V2.map(poolId), fixture.poolIds, "RH_SWAP_POOLS_V2 is DeployVaultSwapV4b's list");
assert.equal(new Set(fixture.poolIds).size, fixture.poolIds.length, "no pool twice");
for (const k of RH_SWAP_POOLS_V2) {
  assert.ok(BigInt(k.currency0) < BigInt(k.currency1), "v4 keys are sorted");
  assert.notEqual(k.hooks.toLowerCase(), "0x958541c0ce2e1a158309f7d1b141963eda31c880", "never the stale-quote hook");
}
assert.ok(!RH_SWAP_POOLS_V2.some((k) => poolId(k).startsWith("0x3b0cbf06")), "v1's thinned ETH/USDG pool is not v2's hub");
n += 4;
// every v2 token has its metadata, and its pools join it to the rest
for (const a of RH_SWAP_ASSETS_V2) {
  const t = knownTokens(4663).find((x) => x.address.toLowerCase() === a.toLowerCase());
  assert.ok(t && t.decimals > 0 && t.symbol, `metadata for ${a}`);
  assert.ok(RH_SWAP_POOLS_V2.some((k) => [k.currency0, k.currency1].some((c) => c.toLowerCase() === a.toLowerCase()) || a === RH_WETH));
}
assert.equal(new Set(RH_SWAP_ASSETS_V2.map((a) => a.toLowerCase())).size, RH_SWAP_ASSETS_V2.length);
assert.equal(RH_SWAP_ASSETS_V2.length, 29, "USDG, GLOAM, WETH, six more and 20 stock tokens");
n += 2;

// Routes both ways: direct, and through ETH.
const there = routesBetween(USDG, GLOAM);
assert.equal(there.length, 2);
assert.equal(there[0]!.length, 1, "the direct pool");
assert.equal(there[1]!.length, 2, "through ETH");
assert.equal(routesBetween(GLOAM, USDG).length, 2);
assert.equal(routesBetween(USDG, USDG).length, 0);
n += 5;
assert.ok(isKnownRoute(4663, USDG, GLOAM, there[1]!));
assert.ok(!isKnownRoute(4663, USDG, GLOAM, [...there[1]!].reverse()), "hops in the wrong order");
assert.ok(!isKnownRoute(4663, USDG, GLOAM, [{ ...there[0]![0]!, hooks: "0x000000000000000000000000000000000000dEaD" }]));
assert.ok(isKnownRoute(4217, USDG, GLOAM, []), "Tempo takes no route");
assert.ok(!isKnownRoute(4217, USDG, GLOAM, there[0]!));
n += 5;

// The escrow code the app works addresses out from is the pinned one, and (when
// the contracts are built) exactly what the compiler made of SwapEscrow.sol.
assert.equal(keccak256(SWAP_ESCROW_INIT_CODE), SWAP_ESCROW_CODE_HASH);
n++;
const artifact = new URL("../../contracts/out/SwapEscrow.sol/SwapEscrow.json", import.meta.url);
if (existsSync(artifact)) {
  const built = JSON.parse(readFileSync(artifact, "utf8")).bytecode.object as string;
  assert.equal(built.toLowerCase(), SWAP_ESCROW_INIT_CODE.toLowerCase(), "SwapEscrow was changed: update SWAP_ESCROW_INIT_CODE");
  n++;
}
// Every part of the key moves the address; the refund note's key is what the swap used.
{
  const router = "0x00000000000000000000000000000000000beef1" as Address;
  const key = {
    nullifier: `0x${"01".repeat(32)}`,
    amountIn: 20_000_000n,
    outCommitment: `0x${"02".repeat(32)}`,
    assetOut: GLOAM,
    amountOut: 7n * 10n ** 18n,
    refundCommitment: `0x${"03".repeat(32)}`,
    refundAmount: refundAmountFor(20_000_000n),
    routeHash: keccak256(encodeRoute(there[1]!)),
  } as const;
  const base = escrowAddress(router, USDG, key);
  for (const change of [
    { nullifier: `0x${"09".repeat(32)}` },
    { amountIn: 20_000_001n },
    { amountOut: 1n },
    { refundCommitment: `0x${"09".repeat(32)}` },
    { routeHash: keccak256(encodeRoute(there[0]!)) },
  ]) {
    assert.notEqual(escrowAddress(router, USDG, { ...key, ...change } as typeof key), base);
  }
  assert.notEqual(escrowAddress(router, GLOAM, key), base, "another input asset");
  assert.notEqual(escrowAddress("0x00000000000000000000000000000000000beef2", USDG, key), base, "another router");
  const info = {
    router,
    assetIn: USDG,
    amountIn: "20000000",
    out: { commitment: key.outCommitment, asset: GLOAM, amount: key.amountOut.toString() },
    route: there[1]!,
  };
  assert.deepEqual(refundEscrowKey(info, key.nullifier, key.refundCommitment, key.refundAmount), key);
  n += 8;
}

// Route bytes decode as PoolKey[].
const bytes = encodeRoute(there[1]!);
const [decoded] = decodeAbiParameters([{ type: "tuple[]", components: keyType }], bytes);
assert.equal(decoded.length, 2);
assert.equal(decoded[1]!.hooks.toLowerCase(), "0x953391a2ddf7e8437feb878fdf2c6f325fbf00cc");
assert.equal(encodeRoute([]), "0x");
n += 3;

// The vault's fee: floor(amount * bps / 10000), split so it cannot overflow.
assert.equal(vaultFeeOf(20_000_000n, 25), 50_000n);
assert.equal(vaultFeeOf(19_999n, 25), 49n);
assert.equal(vaultFeeOf(10n ** 18n, 0), 0n);
n += 3;
// The refund note is never more than arrives, at any fee the vault allows (up to 1%).
for (const amt of [1n, 99n, 100n, 19_999n, 20_000_000n, 10n ** 18n + 7n]) {
  for (const bps of [0, 25, 100]) assert.ok(refundAmountFor(amt) <= amt - vaultFeeOf(amt, bps), `${amt} at ${bps}`);
}
n++;

// The vault's limits: what one deposit can bring in, and the most one swap may spend so its refund lands.
{
  const v = { perDeposit: 500_000_000n, total: 25_000_000_000n, deposited: 24_800_000_000n };
  assert.equal(depositRoom(v), 200_000_000n, "the total binds");
  assert.equal(depositRoom({ ...v, deposited: 0n }), 500_000_000n, "the per-deposit limit binds");
  assert.equal(depositRoom({ ...v, deposited: 30_000_000_000n }), 0n, "over a lowered total: nothing");
  assert.equal(depositRoom({ perDeposit: 0n, total: 0n, deposited: 0n }), 0n, "not taken");
  const cap = maxSwapInForRefund(v);
  assert.ok(refundAmountFor(cap) <= v.perDeposit && refundAmountFor(cap + 1n) > v.perDeposit, "the largest that fits");
  assert.ok(refundFits(v, cap) && !refundFits(v, cap + 1n));
  assert.ok(!refundFits({ ...v, total: 24_000_000_000n }, 100_000_000n), "a refund past a lowered total");
  assert.equal(maxSwapInForRefund({ perDeposit: 0n, total: 0n, deposited: 0n }), 0n);
  // No limit (type(uint128).max on both sides): the room and the refund cap stay
  // far above any note, so nothing is capped or split, and the math stays exact.
  const MAX = (1n << 128n) - 1n;
  const free = { perDeposit: MAX, total: MAX, deposited: 2_400_000_000_000n };
  const big = 10n ** 30n;
  assert.equal(depositRoom(free), MAX - free.deposited, "no limit: the room is what is left under the max");
  const freeCap = maxSwapInForRefund(free);
  assert.ok(refundAmountFor(freeCap) <= MAX && freeCap > big, "no limit: the refund cap is above any note");
  assert.ok(refundFits(free, big) && refundFits({ ...free, deposited: big }, big), "no limit: any refund fits");
  // mixed: only the finite side binds
  assert.equal(depositRoom({ perDeposit: 500_000_000n, total: MAX, deposited: big }), 500_000_000n, "finite perDeposit binds under a max total");
  assert.equal(depositRoom({ perDeposit: MAX, total: 25_000_000_000n, deposited: 24_800_000_000n }), 200_000_000n, "finite total binds under a max perDeposit");
  n += 1;
  // price impact: the same rate at both sizes is 0, a 2% worse rate at full size is 200 bps
  assert.equal(priceImpactBps(1000n, 2000n, 10n, 20n), 0);
  assert.equal(priceImpactBps(1000n, 1960n, 10n, 20n), 200);
  assert.equal(priceImpactBps(1000n, 2100n, 10n, 20n), 0, "never below 0");
  n += 11;
}

// Quote age: refreshed every 15 seconds, gone once two refreshes are missed.
assert.equal(QUOTE_TTL_MS, 15_000);
assert.ok(quoteFresh(1_000, 1_000));
assert.ok(quoteFresh(1_000, 1_000 + 2 * QUOTE_TTL_MS - 1));
assert.ok(!quoteFresh(1_000, 1_000 + 2 * QUOTE_TTL_MS), "two refreshes missed");
assert.ok(!quoteFresh(1_000, 1_000 + 10 * 60_000), "a quote from ten minutes ago");
n += 4;

// Right before a swap goes, the price is read again (a fake Tempo exchange here).
// The better of that and the quote is sent: a move in the person's favour goes to
// them, not the treasury; a move against them or a failed read keeps the quote.
{
  const pathUSD = "0x20c0000000000000000000000000000000000000" as Address;
  const usdce = "0x20c000000000000000000000b9537d11c60e8b50" as Address;
  const dex = (rate: number | "down") =>
    ({
      readContract: async ({ functionName, args }: { functionName: string; args: readonly bigint[] }) => {
        if (rate === "down") throw new Error("rpc down");
        const amount = args[2]!;
        const scaled = (a: bigint, r: number) => (a * BigInt(Math.round(r * 1e6))) / 1_000_000n;
        if (functionName === "quoteSwapExactAmountIn") return scaled(amount, rate);
        if (functionName === "quoteSwapExactAmountOut") return scaled(amount, 1 / rate) + 1n;
        throw new Error(functionName);
      },
    }) as never;
  const p = { assetIn: pathUSD, assetOut: usdce, amountIn: 10_000_000n, feeBps: 25 };
  const quoted = await planVaultSwap(dex(1), 4217, p);
  assert.equal(quoted.available, 9_975_000n);
  assert.ok(quoted.cost <= quoted.available && quoted.leftover > 0n);
  const better = await replanVaultSwap(dex(1.01), 4217, p, quoted);
  assert.ok(better.amountOut > quoted.amountOut, "a better price since the quote reaches the person");
  assert.ok(better.cost <= better.available);
  assert.equal(await replanVaultSwap(dex(0.995), 4217, p, quoted), quoted, "a worse price keeps what they agreed to");
  assert.equal(await replanVaultSwap(dex(1), 4217, p, quoted).then((x) => x.amountOut), quoted.amountOut);
  assert.equal(await replanVaultSwap(dex("down"), 4217, p, quoted), quoted, "a failed read keeps the quote");
  n += 7;
}

// ── v2 (GloamVaultSwapV4b), switched on here as the one constant would switch it.
{
  const V1 = "0x34AB06208586A737Bf1607fa996Bc9162271c52d" as Address;
  const V2 = "0x00000000000000000000000000000000000b2b2b" as Address;
  const WETH = RH_WETH;
  const ETH = "0x0000000000000000000000000000000000000000" as Address;
  assert.equal(VAULT_SWAP_V2_ROUTER[4663], null, "off, as set above");
  assert.deepEqual(VAULT_SWAP_ASSETS[4663], [USDG, GLOAM], "off: v1's two tokens");
  assert.equal(swapRouterFor(4663)!.version, 1);
  assert.equal(swapRouterFor(4663, V2), null, "unknown while off");
  n += 4;

  VAULT_SWAP_V2_ROUTER[4663] = V2;
  VAULT_SWAP_ROUTERS[4663] = V2;
  const v2 = swapRouterFor(4663)!;
  const v1 = swapRouterFor(4663, V1)!;
  assert.equal(v2.address, V2);
  assert.equal(v2.version, 2);
  assert.equal(v2.maxHops, 3);
  assert.equal(v2.weth, WETH);
  assert.equal(v1.version, 1, "v1 still known, for its refunds");
  assert.deepEqual(v2.assets, [...RH_SWAP_ASSETS_V2, ...RH_SWAP_ASSETS_V2_QUEUED]);
  assert.ok(isSwapAsset(4663, WETH) && isSwapAsset(4663, WETH, V2));
  assert.ok(!isSwapAsset(4663, WETH, V1), "v1 never had WETH");
  n += 8;

  const byId = (prefix: string) => RH_SWAP_POOLS_V2.find((k) => poolId(k).startsWith(prefix))!;
  const ethUsd87 = byId("0x387bf619"); // ETH / USDG 0.05%, the hub (the name kept from v1's tests)
  const ethGloam = byId("0xc5f37371");
  const directDear = byId("0xe5b1e488");
  const wethUsd = byId("0x84bd4e2d");
  const sym = (s: string) => RH_SWAP_ASSETS_V2.find((a) => knownTokens(4663).find((t) => t.address.toLowerCase() === a.toLowerCase())?.symbol === s)!;
  const key = (r: readonly { fee: number; currency0: string }[]) => r.map((k) => `${k.currency0.slice(0, 6)}:${k.fee}`).join(">");

  // ETH through WETH at either end, mirrored from the router's walk
  assert.deepEqual(routeCurrencies(v2, USDG, WETH, [ethUsd87]), [USDG, ETH], "USDG -> ETH, wrapped into WETH");
  assert.deepEqual(routeCurrencies(v2, WETH, USDG, [ethUsd87]), [ETH, USDG], "WETH unwrapped, ETH -> USDG");
  assert.deepEqual(routeCurrencies(v2, WETH, USDG, [wethUsd]), [WETH, USDG], "a WETH pool: no wrapping");
  assert.deepEqual(routeCurrencies(v2, WETH, GLOAM, [ethGloam]), [ETH, GLOAM]);
  assert.equal(routeCurrencies(v2, USDG, GLOAM, [ethUsd87]), null, "ends at ETH, not a WETH note");
  assert.equal(routeCurrencies(v2, USDG, WETH, [wethUsd, ethGloam]), null, "no wrapping in the middle");
  assert.equal(routeCurrencies(v2, USDG, USDG, [ethUsd87]), null);
  assert.equal(routeCurrencies(v2, ETH, USDG, [ethUsd87]), null, "a native note never");
  assert.equal(routeCurrencies(v2, USDG, GLOAM, [directDear, directDear]), null, "a pool twice");
  assert.equal(routeCurrencies(v1, USDG, WETH, [ethUsd87]), null, "v1 has no WETH");
  assert.equal(routeCurrencies(v1, USDG, GLOAM, [byId("0x24107d15"), ethGloam]), null, "a v2 pool on v1");
  n += 11;
  // three hops: WETH -> USDG -> ETH -> GLOAM is one route v2 takes (and v1 could not)
  const wg = routesBetween(WETH, GLOAM, v2);
  assert.ok(wg.some((r) => r.length === 3), "three hops");
  assert.ok(wg.some((r) => key(r) === key([ethGloam])), "unwrapped onto the launch pool");
  assert.ok(wg.every((r) => routeCurrencies(v2, WETH, GLOAM, r) !== null));
  assert.ok(wg.every((r, i) => i === 0 || wg[i - 1]!.length <= r.length), "fewest hops first");
  const uw = routesBetween(USDG, WETH, v2);
  assert.equal(uw.filter((r) => r.length === 1).length, 3, "two ETH pools wrapped, and the WETH pool");
  // stock tokens: one hop to USDG, two between two stocks, ETH-paired ones through ETH
  const SPY = sym("SPY"), NVDA = sym("NVDA"), SPCX = sym("SPCX"), MU = sym("MU");
  assert.ok(routesBetween(USDG, SPY, v2).some((r) => r.length === 1));
  assert.ok(routesBetween(SPY, NVDA, v2).some((r) => r.length === 2), "stock to stock through USDG");
  assert.deepEqual(routeCurrencies(v2, MU, WETH, [byId("0x881b4219")]), [MU, "0x0000000000000000000000000000000000000000"], "MU / ETH, wrapped");
  assert.ok(routesBetween(SPCX, GLOAM, v2).some((r) => r.length === 2), "SPCX -> ETH -> GLOAM");
  // the walk finds exactly what trying every sequence of pools finds
  const brute = (a: Address, b: Address) => {
    const out: string[] = [];
    const go = (route: typeof RH_SWAP_POOLS_V2[number][]) => {
      if (route.length && routeCurrencies(v2, a, b, route)) out.push(route.map(poolId).join(">"));
      if (route.length < 3) for (const k of RH_SWAP_POOLS_V2) if (!route.includes(k)) go([...route, k]);
    };
    go([]);
    return out.sort();
  };
  for (const [a, b] of [[USDG, GLOAM], [RH_WETH, GLOAM], [SPY, NVDA], [GLOAM, MU]] as [Address, Address][]) {
    assert.deepEqual(routesBetween(a, b, v2).map((r) => r.map(poolId).join(">")).sort(), brute(a, b), "walk == brute force");
  }
  assert.ok(MAX_QUOTED_ROUTES >= 12);
  n += 6;
  assert.equal(routesBetween(USDG, GLOAM, v1).length, 2, "v1's routes as before");

  // AI and ORBIO: the four pools queued on v2, with the ids the router holds (rh-assets), never in its deploy list
  const [AI, ORBIO] = RH_SWAP_ASSETS_V2_QUEUED as [Address, Address];
  assert.deepEqual(
    RH_SWAP_POOLS_V2_QUEUED.map(poolId),
    [
      "0x592e3fb7ea947506b36481025abc15baada8e1839a50fded46ecf08b3182fa96",
      "0x7aebd80541bfaaf23dbb6e99ce13d4d31c1a84c91414f971eadbff7db5f85995",
      "0xea9f200e13055b82f175f44f592c4c13dd8c9d9320a66487d3c5cd90d68550ef",
      "0xc761f7de760d2b73cc3e3cc3d729916a4ed2f7fc6b0aa3872e2ced4258961e92",
    ],
    "the queued pools' ids"
  );
  for (const k of RH_SWAP_POOLS_V2_QUEUED) {
    assert.ok(k.currency0.toLowerCase() < k.currency1.toLowerCase(), "sorted as a v4 key");
    assert.ok(!fixture.poolIds.includes(poolId(k)), "not in the list v2 deployed with");
  }
  const queuedIds = new Set(RH_SWAP_POOLS_V2_QUEUED.map(poolId));
  const notQueued = (k: (typeof RH_SWAP_POOLS_V2)[number]) => !queuedIds.has(poolId(k));
  assert.equal(routesBetween(USDG, AI, v2).length, 2, "both AI pools, directly, once live");
  assert.equal(routesBetween(ORBIO, USDG, v2).length, 2, "both ORBIO pools");
  assert.equal(routesBetween(USDG, AI, v2, notQueued).length, 0, "nothing routes through a pool that isn't live");
  assert.equal(routesBetween(AI, ORBIO, v2, notQueued).length, 0);
  assert.ok(routesBetween(AI, ORBIO, v2).length === 4, "AI to ORBIO through USDG");
  assert.ok(routesBetween(USDG, GLOAM, v2, notQueued).length === routesBetween(USDG, GLOAM, v2).filter((r) => r.every(notQueued)).length);
  n += 15;

  // the picker: a queued asset shows only with a live pool and an open vault limit
  const all = [...RH_SWAP_ASSETS_V2, ...RH_SWAP_ASSETS_V2_QUEUED];
  const none = new Set<string>();
  const open = new Set([AI.toLowerCase(), ORBIO.toLowerCase()]);
  assert.deepEqual(offeredSwapAssets(all, v2, none, null), RH_SWAP_ASSETS_V2, "unread: not offered");
  assert.deepEqual(offeredSwapAssets(all, v2, open, null), RH_SWAP_ASSETS_V2, "pools unread: not offered");
  assert.deepEqual(offeredSwapAssets(all, v2, none, () => true), RH_SWAP_ASSETS_V2, "the vault doesn't take them yet");
  assert.deepEqual(offeredSwapAssets(all, v2, open, notQueued), RH_SWAP_ASSETS_V2, "the router hasn't let them in yet");
  assert.deepEqual(offeredSwapAssets(all, v2, open, () => true), all, "both live");
  const aiOnly = (k: (typeof RH_SWAP_POOLS_V2)[number]) => notQueued(k) || poolId(k).startsWith("0x7aebd805");
  assert.deepEqual(offeredSwapAssets(all, v2, open, aiOnly), [...RH_SWAP_ASSETS_V2, AI], "one pool is enough, for its own asset");
  assert.deepEqual(offeredSwapAssets(all, null, open, () => true), RH_SWAP_ASSETS_V2, "no router, no queued asset");
  n += 7;

  // a failed read of the allowlist keeps what was listed at deploy, never a queued pool
  const noRpc = { multicall: () => Promise.reject(new Error("rpc down")) } as never;
  const failed = await livePools(noRpc, v2);
  assert.equal(failed(RH_SWAP_POOLS_V2[0]!), true);
  for (const k of RH_SWAP_POOLS_V2_QUEUED) assert.equal(failed(k), false, "a queued pool needs the router's word");
  n += 5;
  // a removed pool (livePools) is never routed through
  const noLaunch = routesBetween(WETH, GLOAM, v2, (k) => poolId(k) !== poolId(ethGloam));
  assert.ok(noLaunch.length > 0 && noLaunch.every((r) => !r.some((k) => poolId(k) === poolId(ethGloam))));
  n += 7;
  // the relay checks a route against the router it names
  assert.ok(isKnownRoute(4663, USDG, WETH, [ethUsd87]));
  assert.ok(isKnownRoute(4663, USDG, WETH, [ethUsd87], V2));
  assert.ok(!isKnownRoute(4663, USDG, WETH, [ethUsd87], V1));
  assert.ok(isKnownRoute(4663, USDG, GLOAM, there[1]!, V1), "a v1 refund's route");
  assert.ok(!isKnownRoute(4663, USDG, GLOAM, there[1]!, "0x000000000000000000000000000000000000c0de"));
  n += 5;

  const net2 = getNetwork("robinhood-mainnet");
  const base = {
    spend: { proof: `0x${"11".repeat(256)}`, root: `0x${"22".repeat(32)}`, nullifier: `0x${"33".repeat(32)}`, asset: USDG, amount: "20000000" },
    deposit: { proof: `0x${"44".repeat(256)}`, commitment: `0x${"55".repeat(32)}`, asset: WETH, amount: "7000000000000000" },
    refund: { proof: `0x${"66".repeat(256)}`, commitment: `0x${"77".repeat(32)}`, asset: USDG, amount: refundAmountFor(20_000_000n).toString() },
    route: [ethUsd87],
  };
  const no = async (body: Record<string, unknown>, code: string) => {
    await assert.rejects(relayVaultSwap(net2, body), (e: unknown) => e instanceof RelayError && e.code === code);
    n++;
  };
  await no({ ...base, router: V1 }, "swap_asset"); // a WETH swap sent to v1
  await no({ ...base, route: [wethUsd, ethGloam] }, "BadRoute");
  await no({ ...base, route: [ethUsd87, ethUsd87, ethUsd87, ethUsd87] }, "bad_request");
  await no({ ...base, deposit: { ...base.deposit, asset: "0x20c0000000000000000000000000000000000000" } }, "swap_asset");

  VAULT_SWAP_V2_ROUTER[4663] = null;
  VAULT_SWAP_ROUTERS[4663] = V1;
}

// v3 (GloamVaultSwapV4c, GloamVaultSwapTempo2): off everywhere, and pinned to what the contracts say.
{
  const pinned = JSON.parse(readFileSync(new URL("../../contracts/test/fixtures/router-next.json", import.meta.url), "utf8")) as {
    escrowCodeHash: string;
    chains: Record<string, { address: Address; poolIds?: string[] }>;
  };
  // nothing is deployed: every switch off, and Ethereum has a switch of its own
  assert.deepEqual({ ...VAULT_SWAP_V3_LIVE }, { 4663: null, 8453: null, 1: null, 4217: null }, "no router address is filled in, so no chain is on");
  assert.equal(vaultSwapRouter(8453), null, "no swaps on Base yet");
  assert.equal(vaultSwapRouter(1), null, "no swaps on Ethereum yet");
  assert.deepEqual(swapRoutersOn(8453), [], "nothing on /verify that isn't deployed");
  n += 4;

  for (const [id, c] of Object.entries(pinned.chains)) {
    assert.equal(VAULT_SWAP_V3_ADDRESS[Number(id)]!.toLowerCase(), c.address.toLowerCase(), `v3's address on ${id}`);
    const net = getNetwork(({ 4663: "robinhood-mainnet", 8453: "base-mainnet", 1: "ethereum-mainnet", 4217: "tempo-mainnet" } as const)[Number(id) as 4663]);
    assert.ok(appCashOutTargetProblem(c.address, net)?.includes("swap router"), `a cash out to v3 is refused on ${id}, before it deploys`);
    n += 2;
  }
  assert.equal(keccak256(SWAP_ESCROW2_INIT_CODE), SWAP_ESCROW2_CODE_HASH, "the pinned escrow code hashes to its pin");
  assert.equal(SWAP_ESCROW2_CODE_HASH, pinned.escrowCodeHash, "the contracts' escrow");
  assert.deepEqual(BASE_SWAP_POOLS.map(poolId), pinned.chains["8453"]!.poolIds, "Base: the deploy script's list");
  assert.deepEqual(ETHEREUM_SWAP_POOLS.map(poolId), pinned.chains["1"]!.poolIds, "Ethereum: the deploy script's list");
  assert.deepEqual([...RH_SWAP_POOLS_V2, ...RH_SWAP_POOLS_V2_QUEUED].map(poolId), pinned.chains["4663"]!.poolIds, "Robinhood Chain: v2's and the queued");
  for (const k of [...BASE_SWAP_POOLS, ...ETHEREUM_SWAP_POOLS]) assert.equal(BigInt(k.hooks), 0n, "hookless only on Base and Ethereum");
  n += 5;

  // the switch: a router address filled in, v3 is what new swaps use; a wrong address is still off
  const ETH: Address = "0x0000000000000000000000000000000000000000";
  const [BU, BT, BE] = ["0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2", "0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42"] as Address[];
  VAULT_SWAP_V3_LIVE[1] = "0x000000000000000000000000000000000000dEaD";
  assert.equal(swapV3Live(1), false, "an address that isn't the pinned one is off");
  VAULT_SWAP_V3_LIVE[1] = VAULT_SWAP_V3_ADDRESS[1]!;
  assert.equal(swapV3Live(1), true, "the pinned address is on");
  VAULT_SWAP_V3_LIVE[1] = null;
  VAULT_SWAP_V3_LIVE[8453] = VAULT_SWAP_V3_ADDRESS[8453]!;
  VAULT_SWAP_ROUTERS[8453] = VAULT_SWAP_V3_ADDRESS[8453]!;
  const base = swapRouterFor(8453)!;
  assert.equal(base.version, 3);
  assert.equal(base.quoter?.toLowerCase(), "0x0d5e0f971ed27fbff6c2837bf31316121532048d");
  // native notes, on routes the router takes; WETH is no vault asset here, but ETH is
  assert.ok(isSwapAsset(8453, ETH), "an ETH note swaps on Base");
  assert.deepEqual(routesBetween(ETH, BU, base).map((r) => r.length), [1, 1], "both ETH / USDC pools");
  assert.ok(routesBetween(ETH, BT, base).length > 0 && routesBetween(ETH, BT, base).every((r) => r.length === 2), "ETH to USDT goes through USDC");
  assert.ok(routesBetween(BE, ETH, base).every((r) => r.length === 2));
  assert.equal(swapBufferBps(8453, BU, BT), 10, "two dollars: the thin buffer");
  assert.equal(swapBufferBps(8453, ETH, BU), 50, "ETH moves");
  assert.equal(swapBufferBps(8453, BU, BE), 50, "a euro isn't a dollar");
  assert.equal(swapBufferBps(4663, USDG, GLOAM), 50);
  assert.equal(swapBufferBps(4217), 10);
  n += 12;
  VAULT_SWAP_V3_LIVE[8453] = null;
  VAULT_SWAP_ROUTERS[8453] = null;

  // Robinhood Chain: the same rules as GloamVaultSwapV4c._walk, ETH and WETH both
  VAULT_SWAP_V2_ROUTER[4663] = RH_V2;
  VAULT_SWAP_V3_LIVE[4663] = VAULT_SWAP_V3_ADDRESS[4663]!;
  VAULT_SWAP_ROUTERS[4663] = VAULT_SWAP_V3_ADDRESS[4663]!;
  const v3 = swapRouterFor(4663)!;
  assert.equal(v3.version, 3);
  assert.equal(swapRouterFor(4663, RH_V2)!.version, 2, "v2 stays for its refunds");
  assert.equal(swapRouterFor(4663, RH_V1)!.version, 1, "and v1");
  const byHead = (h: string) => RH_SWAP_POOLS_V2.find((k) => poolId(k).startsWith(h))!;
  const ethUsdg = byHead("0x387bf619");
  const wethUsdg = byHead("0x84bd4e2d");
  const ethGloamV3 = byHead("0xc5f37371");
  // an ETH note on an ETH pool pays ETH; on a WETH pool the router wraps it
  assert.deepEqual(routeCurrencies(v3, ETH, USDG, [ethUsdg]), [ETH, USDG]);
  assert.deepEqual(routeCurrencies(v3, ETH, USDG, [wethUsdg]), [RH_WETH, USDG]);
  // into an ETH note, by either kind of pool; a WETH note the same way
  assert.deepEqual(routeCurrencies(v3, USDG, ETH, [ethUsdg]), [USDG, ETH]);
  assert.deepEqual(routeCurrencies(v3, USDG, ETH, [wethUsdg]), [USDG, RH_WETH]);
  assert.deepEqual(routeCurrencies(v3, RH_WETH, USDG, [wethUsdg]), [RH_WETH, USDG]);
  assert.deepEqual(routeCurrencies(v3, RH_WETH, USDG, [ethUsdg]), [ETH, USDG]);
  assert.deepEqual(routeCurrencies(v3, ETH, RH_WETH, [ethUsdg, wethUsdg]), [ETH, USDG, RH_WETH], "both forms, one at each end, no conversion");
  // refused as the router refuses them
  assert.equal(routeCurrencies(v3, ETH, RH_WETH, [wethUsdg, ethUsdg]), null, "converted at both ends");
  assert.equal(routeCurrencies(v3, ETH, GLOAM, [wethUsdg, ethUsdg, ethGloamV3]), null, "ETH inside a route that converted it");
  assert.equal(routeCurrencies(v3, USDG, GLOAM, [ethGloamV3]), null, "a USDG note never pays in ETH");
  assert.equal(routeCurrencies(v3, ETH, ETH, [ethUsdg]), null, "the same asset");
  // v2 still refuses a native note, so a route can't be built for a router that would revert
  const v2only = swapRouterFor(4663, RH_V2)!;
  assert.equal(routeCurrencies(v2only, ETH, USDG, [ethUsdg]), null, "v2 takes no native note");
  assert.equal(routeCurrencies(v2only, USDG, ETH, [ethUsdg]), null);
  assert.deepEqual(routeCurrencies(v2only, RH_WETH, USDG, [ethUsdg]), [ETH, USDG], "v2's WETH routes stand");
  const ethRoutes = routesBetween(ETH, USDG, v3);
  assert.ok(ethRoutes.some((r) => r.length === 1 && poolId(r[0]!) === poolId(wethUsdg)), "the walk finds a WETH pool for an ETH note");
  assert.ok(ethRoutes.every((r) => routeCurrencies(v3, ETH, USDG, r)), "every route it finds, the router takes");
  n += 17;

  // ETH is offered on Robinhood Chain only once the vault's limit lands
  const ethOpen = new Set([ETH.toLowerCase()]);
  assert.ok(!offeredSwapAssets(v3.assets, v3, new Set(), () => true).includes(ETH), "the vault doesn't take ETH yet");
  assert.ok(offeredSwapAssets(v3.assets, v3, ethOpen, () => true).includes(ETH), "and then it does");
  n += 2;

  // the relay: v3 needs its exit key, and an exit is checked like a cash out, before any read
  const net3 = getNetwork("robinhood-mainnet");
  const body = {
    router: VAULT_SWAP_V3_ADDRESS[4663],
    spend: { proof: `0x${"11".repeat(256)}`, root: `0x${"22".repeat(32)}`, nullifier: `0x${"33".repeat(32)}`, asset: ETH, amount: "50000000000000000" },
    deposit: { proof: `0x${"44".repeat(256)}`, commitment: `0x${"55".repeat(32)}`, asset: USDG, amount: "100000000" },
    refund: { proof: `0x${"66".repeat(256)}`, commitment: `0x${"77".repeat(32)}`, asset: ETH, amount: "49500000000000000" },
    route: [ethUsdg],
  };
  await assert.rejects(relayVaultSwap(net3, body), (e: unknown) => e instanceof RelayError && e.code === "bad_request", "no exit key");
  await assert.rejects(
    relayVaultSwap(net3, { ...body, exitKey: "0x00000000000000000000000000000000000e0817" }),
    (e: unknown) => e instanceof RelayError && e.code === "bad_request",
    "no deadline"
  );
  n += 2;
  const exitBody = {
    router: VAULT_SWAP_V3_ADDRESS[4663],
    asset: USDG,
    to: "0x00000000000000000000000000000000000c0de1",
    signature: `0x${"ab".repeat(65)}`,
    key: {
      nullifier: `0x${"33".repeat(32)}`, amountIn: "100", outCommitment: `0x${"55".repeat(32)}`, assetOut: GLOAM, amountOut: "100",
      refundCommitment: `0x${"77".repeat(32)}`, refundAmount: "99", routeHash: `0x${"88".repeat(32)}`, exitKey: "0x00000000000000000000000000000000000e0817",
      deadline: "1800",
    },
  };
  const noExit = async (b: Record<string, unknown>, code: string) => {
    await assert.rejects(relayVaultSwapExit(net3, b), (e: unknown) => e instanceof RelayError && e.code === code, code);
    n++;
  };
  await noExit({ ...exitBody, router: RH_V2 }, "no_exit");
  await noExit({ ...exitBody, router: "0x000000000000000000000000000000000000c0de" }, "swap_router");
  await noExit({ ...exitBody, to: net3.pool! }, "vault_recipient");
  await noExit({ ...exitBody, to: VAULT_SWAP_V3_ADDRESS[4663] }, "vault_recipient");
  await noExit({ ...exitBody, to: USDG }, "vault_recipient");
  await noExit({ ...exitBody, signature: "0x1234" }, "bad_request");
  await noExit({ ...exitBody, key: { ...exitBody.key, deadline: undefined } }, "bad_request");
  VAULT_SWAP_V3_LIVE[4663] = null;
  VAULT_SWAP_ROUTERS[4663] = RH_V1;
  VAULT_SWAP_V2_ROUTER[4663] = null;
  n += 1;

  // the deadline: 30 minutes by default, in the key, and a swap lands up to and including it
  assert.equal(SWAP_DEADLINE_SECONDS, 1800);
  assert.equal(swapExpired(1000n, 999n), false);
  assert.equal(swapExpired(1000n, 1000n), false, "the deadline itself still lands, as on chain");
  assert.equal(swapExpired(1000n, 1001n), true);
  const keyOf = (deadline?: bigint) => ({
    nullifier: `0x${"33".repeat(32)}` as const, amountIn: 100n, outCommitment: `0x${"55".repeat(32)}` as const, assetOut: GLOAM, amountOut: 100n,
    refundCommitment: `0x${"77".repeat(32)}` as const, refundAmount: 99n, routeHash: `0x${"88".repeat(32)}` as const,
    exitKey: "0x00000000000000000000000000000000000e0817" as Address, deadline,
  });
  assert.notEqual(escrowAddress(VAULT_SWAP_V3_ADDRESS[8453]!, USDG, keyOf(1800n)), escrowAddress(VAULT_SWAP_V3_ADDRESS[8453]!, USDG, keyOf(1801n)), "the key fixes it");
  assert.throws(() => escrowAddress(VAULT_SWAP_V3_ADDRESS[8453]!, USDG, keyOf(undefined)), /deadline/, "a v3 key can't go without one");
  n += 6;

  // the exit key: from the refund note's secret, its own for each swap, and the digest fixes every part
  const secret = `0x${"12".repeat(32)}` as const;
  const a = exitAccount(secret);
  assert.equal(a.address, exitAccount(secret).address, "the same note, the same key: a backup restores it");
  assert.notEqual(a.address, exitAccount(`0x${"13".repeat(32)}`).address, "each swap's is its own");
  const R = VAULT_SWAP_V3_ADDRESS[8453]!;
  const E = "0x00000000000000000000000000000000000e5c20" as Address;
  const T = "0x00000000000000000000000000000000000c0de1" as Address;
  const d = exitDigest(8453, R, E, T);
  assert.notEqual(d, exitDigest(1, R, E, T), "another chain");
  assert.notEqual(d, exitDigest(8453, VAULT_SWAP_V3_ADDRESS[1]!, E, T), "another router");
  assert.notEqual(d, exitDigest(8453, R, T, E), "another escrow or address");
  // a refund shows the way out only when the vault refuses it, and only on a swap with an exit key
  const held = { vaultSwap: { exitKey: T }, sweptFrom: {}, sweepPending: true, refundHeld: "blocked" as const };
  assert.ok(canExitVaultSwap(held));
  assert.ok(!canExitVaultSwap({ ...held, refundHeld: "returning" }), "on its way back");
  assert.ok(!canExitVaultSwap({ ...held, vaultSwap: {} }), "an older router has no exit");
  assert.ok(!canExitVaultSwap({ ...held, sweepPending: false }), "already settled");
  n += 9;
}

// The relay: refused while off, then refused on bad input before it reads anything.
const net = getNetwork("robinhood-mainnet");
const good = {
  spend: { proof: `0x${"11".repeat(256)}`, root: `0x${"22".repeat(32)}`, nullifier: `0x${"33".repeat(32)}`, asset: USDG, amount: "20000000" },
  deposit: { proof: `0x${"44".repeat(256)}`, commitment: `0x${"55".repeat(32)}`, asset: GLOAM, amount: "7000000000000000000" },
  refund: { proof: `0x${"66".repeat(256)}`, commitment: `0x${"77".repeat(32)}`, asset: USDG, amount: refundAmountFor(20_000_000n).toString() },
  route: there[1]!,
};
async function refused(body: Record<string, unknown>, code: string) {
  await assert.rejects(relayVaultSwap(net, body), (e: unknown) => e instanceof RelayError && e.code === code);
  n++;
}
const deployed = VAULT_SWAP_ROUTERS[4663];
VAULT_SWAP_ROUTERS[4663] = null;
await refused(good, "no_swap");
VAULT_SWAP_ROUTERS[4663] = "0x000000000000000000000000000000000000beef";
await refused({ ...good, deposit: { ...good.deposit, asset: "0x20c0000000000000000000000000000000000000" } }, "swap_asset");
await refused({ ...good, deposit: { ...good.deposit, asset: USDG } }, "bad_request");
await refused({ ...good, route: [...there[1]!].reverse() }, "BadRoute");
await refused({ ...good, route: [{ ...there[0]![0]!, fee: 3000 }] }, "BadRoute");
await refused({ ...good, route: [there[0]![0], there[0]![0], there[0]![0], there[0]![0]] }, "bad_request");
await refused({ ...good, route: [there[0]![0], there[0]![0], there[0]![0]] }, "BadRoute");
await refused({ ...good, router: "0x000000000000000000000000000000000000c0de" }, "swap_router");
await refused({ ...good, router: "nope" }, "bad_request");
await refused({ ...good, spend: { ...good.spend, proof: "0x12" } }, "bad_request");
await refused({ ...good, refund: { ...good.refund, asset: GLOAM } }, "bad_request");
await refused({ ...good, refund: { ...good.refund, amount: "20000001" } }, "bad_request");
await refused({ ...good, refund: undefined }, "bad_request");
VAULT_SWAP_ROUTERS[4663] = deployed;

if (process.argv.includes("--live")) {
  // v2's pairs, quoted against the live pools (before deploy the allowlist read
  // fails and every listed pool counts, which the router would also allow)
  {
    const rh2 = createPublicClient({ transport: http("https://rpc.mainnet.chain.robinhood.com") });
    VAULT_SWAP_V2_ROUTER[4663] = "0x00000000000000000000000000000000000b2b2b";
    VAULT_SWAP_ROUTERS[4663] = VAULT_SWAP_V2_ROUTER[4663];
    const name: Record<string, string> = { [USDG.toLowerCase()]: "USDG", [GLOAM.toLowerCase()]: "GLOAM", [RH_WETH.toLowerCase()]: "WETH" };
    const dec: Record<string, number> = { USDG: 6, GLOAM: 18, WETH: 18 };
    for (const t of knownTokens(4663)) name[t.address.toLowerCase()] = t.symbol;
    for (const t of knownTokens(4663)) dec[t.symbol] = t.decimals;
    const tok = (s: string) => knownTokens(4663).find((t) => t.symbol === s)!.address as Address;
    const ask: [Address, Address, bigint][] = [
      [USDG, RH_WETH, 50_000_000n],
      [RH_WETH, USDG, 2n * 10n ** 16n],
      [RH_WETH, GLOAM, 10n ** 16n],
      [GLOAM, RH_WETH, 20n * 10n ** 18n],
      [USDG, GLOAM, 20_000_000n],
      [USDG, tok("SPY"), 100_000_000n],
      [tok("SPY"), tok("NVDA"), 10n ** 17n],
      [USDG, tok("GLD"), 100_000_000n],
      [RH_WETH, tok("MU"), 2n * 10n ** 16n],
      [USDG, tok("cbBTC"), 100_000_000n],
      [USDG, tok("PONS"), 100_000_000n],
      [tok("PONS"), USDG, 400n * 10n ** 18n],
      [USDG, tok("CASHCAT"), 100_000_000n],
      [tok("CASHCAT"), USDG, 1_000n * 10n ** 18n],
    ];
    for (const [a, b, amt] of ask) {
      const q = await planVaultSwap(rh2 as never, 4663, { assetIn: a, assetOut: b, amountIn: amt, feeBps: 25 });
      assert.ok(q.cost <= q.available && q.amountOut > 0n);
      const A = name[a.toLowerCase()]!, B = name[b.toLowerCase()]!;
      console.log(
        `live RH v2: ${Number(amt) / 10 ** dec[A]!} ${A} -> ${Number(q.amountOut) / 10 ** dec[B]!} ${B} in ${q.route.length} hop(s) ` +
          `(fees ${q.route.map((k) => k.fee).join(",")}), impact ${q.impactBps ?? "?"} bps, leftover ${Number(q.leftover) / 10 ** dec[A]!} ${A}`
      );
      n++;
    }
    VAULT_SWAP_V2_ROUTER[4663] = null;
    VAULT_SWAP_ROUTERS[4663] = "0x34AB06208586A737Bf1607fa996Bc9162271c52d";
  }
  const rh = createPublicClient({ transport: http("https://rpc.mainnet.chain.robinhood.com") });
  const p = await planVaultSwap(rh as never, 4663, { assetIn: USDG, assetOut: GLOAM, amountIn: 20_000_000n, feeBps: 25 });
  assert.ok(p.cost <= p.available && p.amountOut > 0n);
  console.log(`live RH: 20 USDG -> ${Number(p.amountOut) / 1e18} GLOAM via ${p.route.length} hop(s), leftover ${Number(p.leftover) / 1e6} USDG`);
  const back = await planVaultSwap(rh as never, 4663, { assetIn: GLOAM, assetOut: USDG, amountIn: 10n ** 18n, feeBps: 25 });
  console.log(`live RH: 1 GLOAM -> ${Number(back.amountOut) / 1e6} USDG via ${back.route.length} hop(s)`);
  const tempo = createPublicClient({ transport: http("https://rpc.tempo.xyz") });
  const t = await planVaultSwap(tempo as never, 4217, {
    assetIn: "0x20c0000000000000000000000000000000000000",
    assetOut: "0x20c000000000000000000000b9537d11c60e8b50",
    amountIn: 10_000_000n,
    feeBps: 25,
  });
  assert.ok(t.cost <= t.available);
  console.log(`live Tempo: 10 pathUSD -> ${Number(t.amountOut) / 1e6} USDC.e, leftover ${Number(t.leftover) / 1e6}`);
  n += 3;
}

console.log(`vault swap: ${n} passed`);
