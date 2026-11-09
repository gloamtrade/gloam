/**
 * Self-test: the SDK plans private swaps exactly as the app does.
 *
 * packages/sdk/src/swap.ts follows lib/vaultSwap.ts and lib/relay/swapFloor.ts line for
 * line, so an app or agent on the SDK gets the app's quote, route, escrow and refund note.
 * This holds the two to the same answers:
 *
 *  - every table: routers, the switches, pools, assets, escrow code, ABIs, limits and stops
 *  - the router each chain uses and every router either knows, today and with each chain's
 *    v3 switch turned on, so a switch flipped in one and not the other fails here
 *  - every route between every pair of assets, and the router's rules on each
 *  - escrows, exit digests and exit keys, refund sizes, fees, buffers and the floor
 *  - the same quote from the same chain, on Robinhood Chain, Tempo, Base and Ethereum
 *
 * Nothing reaches any host: quotes run against an in-process fake chain.
 *
 * Run from app/:  ../mcp/node_modules/.bin/tsx --tsconfig tsconfig.json scripts/selftest-sdk-swap-parity.mts
 */
import assert from "node:assert/strict";
import { keccak256, toHex, type Address, type Hex, type PublicClient } from "viem";
import * as app from "../src/lib/vaultSwap";
import * as floor from "../src/lib/relay/swapFloor";
import * as sdk from "@gloamtrade/sdk";

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`ok - ${name}`);
  } catch (e) {
    console.error(`not ok - ${name}\n${(e as Error).stack}`);
    process.exit(1);
  }
}

const CHAINS = [4663, 4217, 8453, 1, 46630, 42431, 84532, 11155111];
const SWAP_CHAINS = [4663, 4217, 8453, 1];
const NATIVE = "0x0000000000000000000000000000000000000000" as Address;
const plain = <T,>(v: T) => JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? `${x}n` : x)));

/** Turns v3 on (or off) in both, the way the fork tests do it in the app. */
function setV3(chainId: number, on: boolean) {
  const at = on ? app.VAULT_SWAP_V3_ADDRESS[chainId]! : null;
  app.VAULT_SWAP_V3_LIVE[chainId] = at;
  sdk.VAULT_SWAP_V3_LIVE[chainId] = at;
  // the app works out its router table once, at load
  const v2 = chainId === 4663 ? (app.VAULT_SWAP_V2_ROUTER[4663] ?? "0x34AB06208586A737Bf1607fa996Bc9162271c52d") : chainId === 4217 ? "0xfCa1887e77f738ef9C5751974b3f3873d029F2DC" : null;
  app.VAULT_SWAP_ROUTERS[chainId] = (at ?? v2) as Address | null;
}
const startLive = { ...app.VAULT_SWAP_V3_LIVE };
const startRouters = { ...app.VAULT_SWAP_ROUTERS };
function restore() {
  for (const c of SWAP_CHAINS) {
    app.VAULT_SWAP_V3_LIVE[c] = startLive[c] ?? null;
    sdk.VAULT_SWAP_V3_LIVE[c] = startLive[c] ?? null;
    app.VAULT_SWAP_ROUTERS[c] = startRouters[c] ?? null;
  }
}

function sameRouters(chainId: number) {
  assert.equal(sdk.vaultSwapRouter(chainId), app.vaultSwapRouter(chainId), `router new swaps use on ${chainId}`);
  assert.deepEqual(plain(sdk.swapRouterFor(chainId)), plain(app.swapRouterFor(chainId)), `swapRouterFor(${chainId})`);
  assert.deepEqual(plain(sdk.swapRoutersOn(chainId)), plain(app.swapRoutersOn(chainId)), `swapRoutersOn(${chainId})`);
  for (const r of [...app.EVERY_SWAP_ROUTER, "0x000000000000000000000000000000000000dEaD" as Address]) {
    assert.deepEqual(plain(sdk.swapRouterFor(chainId, r)), plain(app.swapRouterFor(chainId, r)), `swapRouterFor(${chainId}, ${r})`);
  }
  // the app's VAULT_SWAP_ASSETS is the current router's list, worked out at load (checked below as it stands)
  assert.deepEqual([...sdk.vaultSwapAssets(chainId)], [...(app.swapRouterFor(chainId)?.assets ?? [])], `assets on ${chainId}`);
}

await test("the same tables: routers, switches, pools, assets, escrow code, ABIs, stops", () => {
  assert.deepEqual(sdk.VAULT_SWAP_V2_ROUTER, app.VAULT_SWAP_V2_ROUTER);
  assert.deepEqual(sdk.VAULT_SWAP_V3_ADDRESS, app.VAULT_SWAP_V3_ADDRESS);
  assert.deepEqual(sdk.VAULT_SWAP_V3_LIVE, app.VAULT_SWAP_V3_LIVE, "the v3 switches: flip both together");
  assert.deepEqual(sdk.EVERY_SWAP_ROUTER, app.EVERY_SWAP_ROUTER);
  for (const k of [
    "RH_POOL_MANAGER", "RH_V4_QUOTER", "RH_MULTICALL3", "RH_WETH", "RH_SWAP_POOLS", "RH_SWAP_POOLS_V2", "RH_SWAP_POOLS_V2_QUEUED",
    "RH_SWAP_ASSETS_V2", "RH_SWAP_ASSETS_V2_QUEUED", "BASE_SWAP_POOLS", "ETHEREUM_SWAP_POOLS", "DOLLARS", "TEMPO_STABLE_DEX",
    "SWAP_ESCROW_INIT_CODE", "SWAP_ESCROW_CODE_HASH", "SWAP_ESCROW2_INIT_CODE", "SWAP_ESCROW2_CODE_HASH", "SWAP_DEADLINE_SECONDS",
    "SWAP_SEND_MARGIN_SECONDS", "MAX_QUOTED_ROUTES", "IMPACT_WARN_BPS", "IMPACT_STOP_BPS", "PEG_WARN_BPS", "PEG_STOP_BPS",
    "VALUE_WARN_BPS", "VALUE_STOP_BPS", "QUOTE_TTL_MS", "SWAP_TOO_THIN", "SWAP_OFF_PEG", "UNSHIELDED_EVENT", "vaultSwapAbi", "vaultSwapV3Abi",
  ] as const) {
    assert.deepEqual((sdk as Record<string, unknown>)[k], (app as Record<string, unknown>)[k], k);
  }
});

await test("the same floor where gas is dear (lib/relay/swapFloor)", () => {
  assert.deepEqual(sdk.ETH_USD_FEED, floor.ETH_USD_FEED);
  assert.deepEqual(sdk.ethUsdFeedAbi, floor.ethUsdFeedAbi);
  assert.equal(sdk.FEED_MAX_AGE_SEC, floor.FEED_MAX_AGE_SEC);
  assert.equal(sdk.SPLIT_GAS_UNITS, floor.SPLIT_GAS_UNITS);
  for (const c of CHAINS) assert.equal(sdk.hasSwapFloor(c), floor.hasSwapFloor(c), `floor on ${c}`);
  for (const hops of [0, 1, 2, 3]) {
    assert.equal(sdk.swapGasUnits(hops), floor.swapGasUnits(hops));
    for (const split of [false, true]) assert.equal(sdk.swapFloorGas(hops, split), floor.swapFloorGas(hops, split));
    for (const [gasPriceWei, ethUsd, feeBps] of [[1_000_000_000n, 3000, 25], [37_000_000n, 2250.5, 25], [5n * 10n ** 9n, 4000, 0], [1n, 1, 10_000]] as const) {
      assert.equal(sdk.smallestSwapUsd({ gasPriceWei, ethUsd, feeBps, hops }), floor.smallestSwapUsd({ gasPriceWei, ethUsd, feeBps, hops }));
    }
  }
  for (const usd of [0, 12.5, 2040, Infinity]) assert.equal(sdk.swapFloorShown(usd), floor.swapFloorShown(usd));
});

await test("the same router per chain and every router known, today", () => {
  for (const c of CHAINS) {
    sameRouters(c);
    assert.deepEqual([...sdk.vaultSwapAssets(c)], [...(app.VAULT_SWAP_ASSETS[c] ?? [])], `VAULT_SWAP_ASSETS[${c}]`);
  }
});

for (const c of [8453, 1, 4663, 4217]) {
  await test(`the same routers with v3 switched on for chain ${c}`, () => {
    setV3(c, true);
    try {
      for (const x of CHAINS) sameRouters(x);
    } finally {
      restore();
    }
  });
}

/** Every route between every pair, and each route checked by both routers' rules. */
function sameRoutes(chainId: number) {
  const ar = app.swapRouterFor(chainId);
  const sr = sdk.swapRouterFor(chainId);
  if (!ar || !sr) return 0;
  let n = 0;
  for (const a of ar.assets) {
    for (const b of ar.assets) {
      const ra = app.routesBetween(a, b, ar);
      const rs = sdk.routesBetween(a, b, sr);
      assert.deepEqual(rs, ra, `routes ${a} -> ${b} on ${chainId}`);
      for (const r of ra.slice(0, 4)) {
        assert.deepEqual(sdk.routeCurrencies(sr, a, b, r), app.routeCurrencies(ar, a, b, r));
        assert.equal(sdk.isKnownRoute(chainId, a, b, r), app.isKnownRoute(chainId, a, b, r));
        assert.equal(sdk.encodeRoute(r), app.encodeRoute(r));
        n++;
      }
      assert.equal(sdk.isKnownRoute(chainId, a, b, []), app.isKnownRoute(chainId, a, b, []));
      assert.equal(sdk.swapBufferBps(chainId, a, b), app.swapBufferBps(chainId, a, b));
      assert.equal(sdk.isSwapAsset(chainId, a), app.isSwapAsset(chainId, a));
    }
  }
  for (const k of ar.pools) assert.equal(sdk.poolId(k), app.poolId(k));
  return n;
}

await test("the same routes between every pair, today", () => {
  let n = 0;
  for (const c of SWAP_CHAINS) n += sameRoutes(c);
  assert.ok(n > 100, `routes compared: ${n}`);
});

await test("the same routes with v3 on, on every chain at once", () => {
  for (const c of SWAP_CHAINS) setV3(c, true);
  try {
    let n = 0;
    for (const c of SWAP_CHAINS) n += sameRoutes(c);
    assert.ok(n > 100, `routes compared: ${n}`);
    // the queued assets and native ETH open the same way
    const live = (k: app.PoolKey) => !app.RH_SWAP_POOLS_V2_QUEUED.some((q) => app.poolId(q) === app.poolId(k));
    for (const open of [new Set<string>(), new Set([NATIVE, app.RH_SWAP_ASSETS_V2_QUEUED[0]!.toLowerCase()])]) {
      for (const l of [null, live, () => true]) {
        assert.deepEqual(
          sdk.offeredSwapAssets(sdk.vaultSwapAssets(4663), sdk.swapRouterFor(4663), open, l),
          app.offeredSwapAssets(app.swapRouterFor(4663)!.assets, app.swapRouterFor(4663), open, l)
        );
      }
    }
  } finally {
    restore();
  }
});

await test("the same escrows, exit digests, exit keys and receipts", () => {
  const H = (n: number) => keccak256(toHex(`k${n}`));
  for (let i = 0; i < 20; i++) {
    const key: app.EscrowKey = {
      nullifier: H(i),
      amountIn: BigInt(i + 1) * 1_234_567n,
      outCommitment: H(i + 100),
      assetOut: app.DOLLARS[i % app.DOLLARS.length]!,
      amountOut: BigInt(i) * 99n + 1n,
      refundCommitment: H(i + 200),
      refundAmount: BigInt(i + 1) * 1_222_222n,
      routeHash: H(i + 300),
      ...(i % 2 ? { exitKey: `0x${(i + 1).toString(16).padStart(40, "0")}` as Address, deadline: BigInt(1_800_000_000 + i) } : {}),
    };
    for (const router of app.EVERY_SWAP_ROUTER) {
      for (const assetIn of [NATIVE, app.RH_WETH, app.DOLLARS[0]!]) {
        assert.equal(sdk.escrowAddress(router, assetIn, key), app.escrowAddress(router, assetIn, key));
      }
    }
    const to = `0x${(i + 7).toString(16).padStart(40, "a")}` as Address;
    for (const c of SWAP_CHAINS) assert.equal(sdk.exitDigest(c, app.EVERY_SWAP_ROUTER[0]!, to, to), app.exitDigest(c, app.EVERY_SWAP_ROUTER[0]!, to, to));
    assert.equal(sdk.exitAccount(H(i)).address, app.exitAccount(H(i)).address);
    const info: app.VaultSwapRefundInfo = {
      router: app.EVERY_SWAP_ROUTER[i % app.EVERY_SWAP_ROUTER.length]!,
      assetIn: NATIVE,
      amountIn: key.amountIn.toString(),
      out: { commitment: key.outCommitment, asset: key.assetOut, amount: key.amountOut.toString() },
      route: app.BASE_SWAP_POOLS.slice(0, (i % 3) + 1),
      ...(key.exitKey ? { exitKey: key.exitKey, deadline: key.deadline!.toString() } : {}),
    };
    assert.deepEqual(sdk.refundEscrowKey(info, key.nullifier, key.refundCommitment, key.refundAmount), app.refundEscrowKey(info, key.nullifier, key.refundCommitment, key.refundAmount));
  }
  const word = (a: string) => `0x${a.toLowerCase().slice(2).padStart(64, "0")}` as Hex;
  const topic = keccak256(toHex("Unshielded(bytes32,address,address,uint256)"));
  const vault = "0x39e28cde55cab798874746ac52cb4b5cc99a0194" as Address;
  const paid = { nullifier: H(1), asset: app.DOLLARS[0]!, escrow: "0x00000000000000000000000000000000000000e5" as Address, amount: 5n };
  const logs = [{ address: vault, topics: [topic, paid.nullifier, word(paid.asset), word(paid.escrow)], data: toHex(5n, { size: 32 }) }];
  for (const l of [logs, [{ ...logs[0]!, data: toHex(6n, { size: 32 }) }], [{ ...logs[0]!, address: paid.escrow }], []]) {
    assert.equal(sdk.receiptPaysEscrow(l, vault, paid), app.receiptPaysEscrow(l, vault, paid));
  }
});

await test("the same refund note, fees, limits, deadlines and stops", () => {
  const amounts = [0n, 1n, 7n, 9_999n, 10_000n, 1_000_000n, 123_456_789n, 50_000_000_000n, 10n ** 18n, 12_345n * 10n ** 18n];
  for (const a of amounts) {
    assert.equal(sdk.refundAmountFor(a), app.refundAmountFor(a));
    for (const bps of [0, 1, 25, 50, 100]) {
      assert.equal(sdk.refundAmountFor(a, bps), app.refundAmountFor(a, bps));
      assert.equal(sdk.vaultFeeOf(a, bps), app.vaultFeeOf(a, bps));
      for (const v of [
        { perDeposit: 50_000_000_000n, total: 2_500_000_000_000n, deposited: 0n },
        { perDeposit: 50_000_000_000n, total: 2_500_000_000_000n, deposited: 2_499_000_000_000n },
        { perDeposit: 0n, total: 0n, deposited: 0n },
        { perDeposit: 10n ** 22n, total: 10n ** 23n, deposited: 5n * 10n ** 22n },
      ]) {
        assert.equal(sdk.refundFits(v, a, bps), app.refundFits(v, a, bps));
        assert.equal(sdk.refundFits(v, a), app.refundFits(v, a));
        assert.equal(sdk.maxSwapInForRefund(v, bps), app.maxSwapInForRefund(v, bps));
        assert.equal(sdk.maxSwapInForRefund(v), app.maxSwapInForRefund(v));
        assert.equal(sdk.depositRoom(v), app.depositRoom(v));
      }
    }
  }
  for (const c of CHAINS) {
    assert.equal(sdk.swapChecked(c), app.swapChecked(c));
    assert.equal(sdk.swapDeadlineSeconds(c), app.swapDeadlineSeconds(c));
  }
  for (const [d, n] of [[100n, 99n], [100n, 100n], [100n, 101n]] as const) assert.equal(sdk.swapExpired(d, n), app.swapExpired(d, n));
  for (const [at, now] of [[0, 29_999], [0, 30_000], [5, 1]] as const) assert.equal(sdk.quoteFresh(at, now), app.quoteFresh(at, now));
  for (const [a, b] of [[1000, 900], [100, 100], [0, 5], [5, 0], [100, 150]] as const) assert.equal(sdk.valueGapBps(a, b), app.valueGapBps(a, b));
  for (const [i, o] of [[1_000_000n, 990_000n], [1_000_000n, 1_100_000n], [0n, 5n]] as const) assert.equal(sdk.pegGapBps(i, o), app.pegGapBps(i, o));
  for (const [i, o, si, so] of [[100n, 90n, 1n, 1n], [100n, 100n, 1n, 1n], [0n, 1n, 1n, 1n], [10_000n, 9_000n, 100n, 99n]] as const) {
    assert.equal(sdk.priceImpactBps(i, o, si, so), app.priceImpactBps(i, o, si, so));
  }
});

/** A chain whose quoters answer from a rate, the same for both. */
function fakeChain(rate: (amount: bigint, hops: number) => bigint): PublicClient {
  return {
    multicall: async ({ contracts }: { contracts: { functionName: string; args: [{ exactAmount: bigint; path: unknown[] }] }[] }) =>
      contracts.map((c) =>
        c.functionName === "allowedPool" ? true : { status: "success", result: [rate(c.args[0].exactAmount, c.args[0].path.length), 0n] }
      ),
    simulateContract: async ({ args }: { args: [{ exactAmount: bigint; path: unknown[] }] }) => ({ result: [args[0].exactAmount / 2n + 1n, 0n] }),
    readContract: async ({ args }: { args: [Address, Address, bigint] }) => args[2],
  } as unknown as PublicClient;
}

async function samePlan(chainId: number, assetIn: Address, assetOut: Address, amountIn: bigint, rate: (a: bigint, hops: number) => bigint) {
  const ask = { assetIn, assetOut, amountIn, feeBps: 25 };
  const a = await app.planVaultSwap(fakeChain(rate), chainId, ask).then((p) => ({ p }), (e: Error) => ({ e: `${e.name}:${e.message}:${(e as app.SwapQuoteRefused).fitsIn ?? ""}` }));
  const s = await sdk.planVaultSwap(fakeChain(rate) as unknown as Parameters<typeof sdk.planVaultSwap>[0], chainId, ask).then((p) => ({ p }), (e: Error) => ({ e: `${e.name}:${e.message}:${(e as sdk.SwapQuoteRefused).fitsIn ?? ""}` }));
  assert.deepEqual(plain(s), plain(a), `plan ${assetIn} -> ${assetOut} (${amountIn}) on ${chainId}`);
  outcomes["p" in a ? "priced" : "refused"]++;
  return a;
}
const outcomes = { priced: 0, refused: 0 };

await test("the same quotes from the same chain", async () => {
  const RH_USDG = app.RH_SWAP_ASSETS_V2[0]!;
  const GLOAM = app.RH_SWAP_ASSETS_V2[1]!;
  const fair = (a: bigint) => a;
  const moreHopsWorse = (a: bigint, hops: number) => (a * BigInt(100 - hops)) / 100n;
  await samePlan(4663, RH_USDG, GLOAM, 100_000_000n, moreHopsWorse);
  await samePlan(4663, GLOAM, app.RH_WETH, 10n ** 21n, moreHopsWorse);
  await samePlan(4663, RH_USDG, GLOAM, 1n, fair);
  await samePlan(4217, "0x20c000000000000000000000b9537d11c60e8b50", "0x20c0000000000000000000000000000000000000", 50_000_000n, fair);
  await samePlan(8453, app.DOLLARS[1]!, app.DOLLARS[2]!, 1_000_000n, fair); // off: both refuse
  for (const c of [8453, 1]) setV3(c, true);
  try {
    const [, bu, bt, eu, et, eg] = app.DOLLARS;
    const thin = (a: bigint) => (a > 10_000_000n ? a / 3n : a);
    const offPeg = (a: bigint) => (a * 96n) / 100n;
    for (const [c, x, y] of [[8453, bu, bt], [1, eu, et], [1, eg, eu], [1, et, NATIVE], [8453, NATIVE, bu]] as const) {
      for (const amt of [1_000_000n, 100_000_000n, 10_000_000_000n]) {
        for (const r of [fair, thin, offPeg, moreHopsWorse]) await samePlan(c, x!, y!, amt, r);
      }
    }
  } finally {
    restore();
  }
  // both kinds of answer were compared, not just refusals
  assert.ok(outcomes.priced >= 20 && outcomes.refused >= 10, `priced ${outcomes.priced}, refused ${outcomes.refused}`);
});

console.log(`\n${passed} passed`);
