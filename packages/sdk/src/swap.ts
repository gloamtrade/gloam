/**
 * Private swaps: the routers, pools, routes and quotes. The same planning as the
 * Gloam app (app/src/lib/vaultSwap.ts, which this file follows line for line;
 * app/scripts/selftest-sdk-swap-parity.mts checks the two give the same answers),
 * so a quote here is the quote the app would show. swapIntent.ts builds the swap
 * itself, and its refund and exit.
 *
 * Swapping inside the private balance, through the vault (contracts/src/
 * GloamVaultSwap*.sol). One relayed transaction takes one note out of the
 * vault, buys an exact amount of another asset on a DEX, and puts that amount
 * back into the vault as a new note. Who swapped stays private; the tokens and
 * the amounts are public, like any DEX trade.
 *
 * The note's unshield proof names a per-swap escrow as `to` (escrowFor on the
 * router), derived from the new note, a refund note and the route, so nobody
 * who copies the proof can change any of them. The refund note only lands if
 * someone sends the unshield on its own; then the money comes back as it.
 *
 * Robinhood Chain has two routers. v1 (GloamVaultSwapV4) swaps USDG and GLOAM
 * over three pools fixed at deploy. v2 (GloamVaultSwapV4b) swaps any token in
 * RH_SWAP_ASSETS_V2 for any other over RH_SWAP_POOLS_V2, in up to three hops,
 * with ETH held in the vault as WETH. One switch, VAULT_SWAP_V2_ROUTER, picks
 * which one new swaps use; the relay keeps both, so a refund of a swap made
 * through either still finishes.
 *
 * v3 (GloamVaultSwapV4c, and GloamVaultSwapTempo2 on Tempo) adds native ETH notes,
 * Base and Ethereum, and an exit for money a refund can't bring back. It is off
 * until a router address is filled into VAULT_SWAP_V3_LIVE, chain by chain
 * (DEPLOY-ROUTER.md). Its escrow key has two more fields, so a swap is built for the
 * router it goes through.
 *
 * The switches here are read on every call, so a test (or a fork) that fills one in
 * sees it at once. A switch only turns on the address pinned for that chain.
 *
 * Elysium (mainnet and testnet) has no swap router: private swaps are not on Elysium yet, and a
 * swap asked for there is refused by name (planVaultSwap).
 */
import {
  concatHex,
  encodeAbiParameters,
  getContractAddress,
  keccak256,
  pad,
  toEventSelector,
  toHex,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ELYSIUM_TESTNET_CHAIN_ID, elysiumChainId } from "./elysium.js";

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

// GloamVaultSwapV4, deployed 2026-10-23 (block 95481565); pools match RH_SWAP_POOLS
const RH_ROUTER_V1: Address = "0x34AB06208586A737Bf1607fa996Bc9162271c52d";
// GloamVaultSwapTempo, deployed 2026-10-23 (block 45415156)
const TEMPO_ROUTER: Address = "0xfCa1887e77f738ef9C5751974b3f3873d029F2DC";

/**
 * The one switch for private swaps v2 (GloamVaultSwapV4b) on Robinhood Chain.
 * null: new swaps go through v1, as they do today. Put v2's address here once
 * it is deployed (contracts/script/DeployVaultSwapV4b.s.sol) and the vault
 * takes WETH. New swaps then go through v2: any token in RH_SWAP_ASSETS_V2 for
 * any other, over RH_SWAP_POOLS_V2. v1 stays known to the relay, so a refund
 * of a swap made through it still finishes.
 */
export const VAULT_SWAP_V2_ROUTER: Record<number, Address | null> = {
  // GloamVaultSwapV4b, deployed 2026-10-23 (block 96142003); the vault's 28 asset limits ran 2026-10-27
  4663: "0xfCa1887e77f738ef9C5751974b3f3873d029F2DC",
};

/**
 * Where v3 lands on each chain, known before it deploys: the CREATE2 factory's
 * address for the repo's compile (contracts/test/fixtures/router-next.json pins these,
 * and contracts/launch/router-fixture.mjs writes it). Any edit to the contracts moves them.
 */
export const VAULT_SWAP_V3_ADDRESS: Record<number, Address> = {
  4663: "0x9CdA89fA6E6f796a1623C2086b2C710DCa64486d",
  8453: "0x3A99f461bdbfc86fbd4e84ee80Bfb2fd73f3576a",
  1: "0x2E0c06Ac42Cc6f0ecC3eDc86bC0d67F3c2DC7E6A",
  4217: "0x991efFC6cA44BD578000d32C1351d78298BdBC0a",
};

/**
 * The switch for v3, chain by chain: null until the router is deployed and its read-backs
 * passed (DEPLOY-ROUTER.md), then its address. Nothing is deployed yet, so merging this
 * turns nothing on. An address that isn't the one pinned in VAULT_SWAP_V3_ADDRESS counts
 * as off. New swaps on a chain go through v3 from then on, and earlier routers stay known
 * for their refunds. It only goes one way: back to null, the relay no longer knows v3
 * there, so a refund or an exit of a swap made through it is refused. To stop swaps on a
 * chain, take its pools off instead.
 */
export const VAULT_SWAP_V3_LIVE: Record<number, Address | null> = { 4663: null, 8453: null, 1: null, 4217: null };

function v3On(chainId: number): boolean {
  const at = VAULT_SWAP_V3_LIVE[chainId];
  return Boolean(at) && same(at!, VAULT_SWAP_V3_ADDRESS[chainId] ?? "");
}

/**
 * Every router Gloam has on a chain or will have, whatever the switches say: a router
 * stays Gloam's after the next one replaces it, so its past deposits never read as a
 * person's. New swaps use only VAULT_SWAP_ROUTERS.
 */
export const EVERY_SWAP_ROUTER: readonly Address[] = [
  RH_ROUTER_V1,
  TEMPO_ROUTER, // also GloamVaultSwapV4b on Robinhood Chain
  ...Object.values(VAULT_SWAP_V3_ADDRESS),
];

/** Whether v3 is what new swaps use on a chain. */
export const swapV3Live = v3On;

const v3Address = (chainId: number): Address | null => (v3On(chainId) ? VAULT_SWAP_V3_ADDRESS[chainId]! : null);

/** The router new swaps go through on a chain, or null while swaps are off there (the app's VAULT_SWAP_ROUTERS). */
export function vaultSwapRouter(chainId: number): Address | null {
  if (chainId === 4663) return v3Address(4663) ?? VAULT_SWAP_V2_ROUTER[4663] ?? RH_ROUTER_V1;
  if (chainId === 4217) return v3Address(4217) ?? TEMPO_ROUTER;
  if (chainId === 8453 || chainId === 1) return v3Address(chainId);
  return null;
}

/** The chains where a new private swap can be made right now. */
export function swapChainIds(): number[] {
  return [4663, 4217, 8453, 1].filter((id) => vaultSwapRouter(id) !== null);
}

// ---------------------------------------------------------------- Robinhood Chain (Uniswap v4)

export const RH_POOL_MANAGER: Address = "0x8366a39cc670b4001a1121b8f6a443a643e40951";
export const RH_V4_QUOTER: Address = "0x8dc178efb8111bb0973dd9d722ebeff267c98f94";
/** Uniswap's V4Quoter on Base and Ethereum: its poolManager() names the PoolManager v3 is fixed to (checked 2026-10-31). */
const BASE_V4_QUOTER: Address = "0x0d5e0f971ed27fbff6c2837bf31316121532048d";
const ETHEREUM_V4_QUOTER: Address = "0x52f0e24d1c21c8a0cb1e5a5dd6198556bd9e1203";

export const RH_MULTICALL3: Address = "0xcA11bde05977b3631167028862bE2a173976CA11";

const RH_USDG: Address = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const RH_GLOAM: Address = "0xDcD885F5c60b3aD49F6D58718696417314e8724d";
/**
 * Robinhood Chain's canonical WETH: Arbitrum's aeWETH behind the chain's token
 * bridge (l2Weth() on its WETH gateway 0x1D187C3E…F055, l1Address() is mainnet
 * WETH9), and the WETH9 of Uniswap v4's PositionManager there. Fully backed:
 * totalSupply equals its ETH balance (checked 2026-10-23).
 */
export const RH_WETH: Address = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const NATIVE: Address = "0x0000000000000000000000000000000000000000";
const ORYNTH_HOOK: Address = "0x953391a2DDf7E8437FeB878FDF2C6f325Fbf00CC";

export type PoolKey = { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address };

/**
 * v1's pools, fixed when it was deployed (contracts/script/archive/DeployVaultSwapRobinhood.s.sol).
 * Any other pool is refused on chain.
 */
export const RH_SWAP_POOLS: readonly PoolKey[] = [
  // ETH / USDG, fee 0.0087%, hookless
  { currency0: NATIVE, currency1: RH_USDG, fee: 87, tickSpacing: 1, hooks: NATIVE },
  // ETH / GLOAM, the launch pool (Orynth hook, which takes the creator fee)
  { currency0: NATIVE, currency1: RH_GLOAM, fee: 0, tickSpacing: 200, hooks: ORYNTH_HOOK },
  // USDG / GLOAM direct, fee 4.215%: dear, only used when it is the better price
  { currency0: RH_USDG, currency1: RH_GLOAM, fee: 42150, tickSpacing: 422, hooks: NATIVE },
];

/**
 * v2's pools: exactly the list DeployVaultSwapV4b.s.sol allows at deploy, in
 * the same order (contracts/test/fixtures/vault-swap-v2-pools.json pins both).
 * To add one, the router's owner queues it on chain (usable 3 days later) and
 * it is added here too. The app routes only through a pool that is on this list
 * and that the router allows right now (livePools), so one the owner removed is
 * skipped at once.
 *
 * Picked from live Robinhood Chain state on 2026-10-23 (price impact quoted at
 * $50 to $5,000): ETH and USDG as the hubs, then each token's deepest hookless
 * pool, and where a Fables pool is deeper or close, that one too as a second
 * route. Fables hooks are not upgradeable and only set the pool's fee (their
 * admin can change it or pause a pool); GLOAM's launch pool has the Orynth
 * hook, which takes the creator fee. Never a pool with the unverified hook
 * 0x958541c0…c880 (it quotes stale prices). Whatever a hook does, the router
 * pays at most what arrived and delivers the exact note, so a hook can cost a
 * swap its buffer at most, or make it fail.
 */
export const RH_SWAP_POOLS_V2: readonly PoolKey[] = [
  // ETH / USDG, 0.05%, hookless (0x387bf619…)
  { currency0: NATIVE, currency1: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", fee: 500, tickSpacing: 10, hooks: NATIVE },
  // ETH / USDG, 0.01%, hookless (0x24107d15…)
  { currency0: NATIVE, currency1: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", fee: 100, tickSpacing: 1, hooks: NATIVE },
  // WETH / USDG, 0.02%, hookless (0x84bd4e2d…)
  { currency0: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73", currency1: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", fee: 200, tickSpacing: 4, hooks: NATIVE },
  // ETH / GLOAM, 0%, Orynth launch hook (0xc5f37371…)
  { currency0: NATIVE, currency1: "0xDcD885F5c60b3aD49F6D58718696417314e8724d", fee: 0, tickSpacing: 200, hooks: "0x953391a2DDf7E8437FeB878FDF2C6f325Fbf00CC" },
  // USDG / GLOAM, 4.215%, hookless (0xe5b1e488…)
  { currency0: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", currency1: "0xDcD885F5c60b3aD49F6D58718696417314e8724d", fee: 42150, tickSpacing: 422, hooks: NATIVE },
  // USDG / GLOAM, 2.4%, hookless (0x9200eb96…)
  { currency0: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", currency1: "0xDcD885F5c60b3aD49F6D58718696417314e8724d", fee: 24000, tickSpacing: 240, hooks: NATIVE },
  // USDe / USDG, 0.01%, hookless (0xa5f23cae…)
  { currency0: "0x5d3a1Ff2b6BAb83b63cd9AD0787074081a52ef34", currency1: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", fee: 100, tickSpacing: 1, hooks: NATIVE },
  // USDG / U, 0.0075%, hookless (0xf399bd15…)
  { currency0: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", currency1: "0xcE24439F2D9C6a2289F741120FE202248B666666", fee: 75, tickSpacing: 1, hooks: NATIVE },
  // USDG / cbBTC, 0.15%, hookless (0x94c62eeb…)
  { currency0: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", currency1: "0xCEC185eB182c47d1bA1EFc84e6959e18cd620Be4", fee: 1500, tickSpacing: 15, hooks: NATIVE },
  // PONS / USDG, 0.3%, hookless (0x4be9657e…)
  { currency0: "0x39dBED3a2bd333467115dE45665cC57F813C4571", currency1: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", fee: 3000, tickSpacing: 60, hooks: NATIVE },
  // CASHCAT / USDG, 0.269%, hookless (0xa92a3df2…)
  { currency0: "0x020bfC650A365f8BB26819deAAbF3E21291018b4", currency1: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", fee: 2690, tickSpacing: 54, hooks: NATIVE },
  // CASHCAT / USDG, dynamic fee, Fables fee hook (0x31608601…)
  { currency0: "0x020bfC650A365f8BB26819deAAbF3E21291018b4", currency1: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", fee: 8388608, tickSpacing: 60, hooks: "0x08E52564Bad99E05a694b4809F397edcA417A080" },
  // USDG / VIRTUAL, 0.3%, hookless (0xa9573206…)
  { currency0: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", currency1: "0xc6911796042b15d7Fa4F6CDe69e245DdCd3d9c31", fee: 3000, tickSpacing: 60, hooks: NATIVE },
  // SPY / USDG, 0.01%, hookless (0xe1ae6a4c…)
  { currency0: "0x117cc2133c37B721F49dE2A7a74833232B3B4C0C", currency1: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", fee: 100, tickSpacing: 1, hooks: NATIVE },
  // USDG / NVDA, 0.01%, hookless (0x6444a8e0…)
  { currency0: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", currency1: "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC", fee: 100, tickSpacing: 1, hooks: NATIVE },
  // TSLA / USDG, 0.3%, hookless (0x8517f807…)
  { currency0: "0x322F0929c4625eD5bAd873c95208D54E1c003b2d", currency1: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", fee: 3000, tickSpacing: 60, hooks: NATIVE },
  // TSLA / USDG, dynamic fee, Fables fee hook (0xd5effce8…)
  { currency0: "0x322F0929c4625eD5bAd873c95208D54E1c003b2d", currency1: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", fee: 8388608, tickSpacing: 10, hooks: "0x67D86050d22D574Df046F3D90F722045F714e080" },
  // AMZN / USDG, 0.24%, hookless (0xefc94885…)
  { currency0: "0x12f190a9F9d7D37a250758b26824B97CE941bF54", currency1: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", fee: 2400, tickSpacing: 24, hooks: NATIVE },
  // AMZN / USDG, dynamic fee, Fables fee hook (0x5619cb84…)
  { currency0: "0x12f190a9F9d7D37a250758b26824B97CE941bF54", currency1: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", fee: 8388608, tickSpacing: 60, hooks: "0x5Eb87F69bE00Df39981622Fd60A8De4b7837e080" },
  // ETH / SPCX, 0.3%, hookless (0x541942af…)
  { currency0: NATIVE, currency1: "0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa", fee: 3000, tickSpacing: 30, hooks: NATIVE },
  // SPCX / USDG, dynamic fee, Fables fee hook (0xb81d873d…)
  { currency0: "0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa", currency1: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", fee: 8388608, tickSpacing: 10, hooks: "0x5Eb87F69bE00Df39981622Fd60A8De4b7837e080" },
  // ETH / CRCL, 0.15%, hookless (0x6d9af55c…)
  { currency0: NATIVE, currency1: "0xdF0992E440dD0be65BD8439b609d6D4366bf1CB5", fee: 1500, tickSpacing: 15, hooks: NATIVE },
  // USDG / CRCL, dynamic fee, Fables fee hook (0xdb9c3400…)
  { currency0: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", currency1: "0xdF0992E440dD0be65BD8439b609d6D4366bf1CB5", fee: 8388608, tickSpacing: 60, hooks: "0x5Eb87F69bE00Df39981622Fd60A8De4b7837e080" },
  // USDG / META, 0.3%, hookless (0x5875d407…)
  { currency0: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", currency1: "0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35", fee: 3000, tickSpacing: 60, hooks: NATIVE },
  // USDG / MSTR, 0.24%, hookless (0xc105b830…)
  { currency0: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", currency1: "0xec262a75e413fAfD0dF80480274532C79D42da09", fee: 2400, tickSpacing: 24, hooks: NATIVE },
  // GOOGL / USDG, 0.3%, hookless (0xd4ecb79f…)
  { currency0: "0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3", currency1: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", fee: 3000, tickSpacing: 60, hooks: NATIVE },
  // USDG / AAPL, 0.3%, hookless (0xc748f467…)
  { currency0: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", currency1: "0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9", fee: 3000, tickSpacing: 60, hooks: NATIVE },
  // USDG / AAPL, dynamic fee, Fables fee hook (0xa2347ba6…)
  { currency0: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", currency1: "0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9", fee: 8388608, tickSpacing: 10, hooks: "0x70a9A88402989226847Ec122043CE5e7FF462080" },
  // USDG / MSFT, 0.3%, hookless (0x9194a557…)
  { currency0: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", currency1: "0xe93237C50D904957Cf27E7B1133b510C669c2e74", fee: 3000, tickSpacing: 60, hooks: NATIVE },
  // USDG / PLTR, 0.15%, hookless (0xc59eaeda…)
  { currency0: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", currency1: "0x894E1EC2D74FFE5AEF8Dc8A9e84686acCB964F2A", fee: 1500, tickSpacing: 15, hooks: NATIVE },
  // USDG / AMD, 1%, hookless (0xde9f85fd…)
  { currency0: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", currency1: "0x86923f96303D656E4aa86D9d42D1e57ad2023fdC", fee: 10000, tickSpacing: 200, hooks: NATIVE },
  // USDG / COIN, 0.25%, hookless (0xe2e1a0e3…)
  { currency0: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", currency1: "0x6330D8C3178a418788dF01a47479c0ce7CCF450b", fee: 2500, tickSpacing: 25, hooks: NATIVE },
  // AMC / USDG, 0.05%, hookless (0x06b97324…)
  { currency0: "0x05a3d1Cd21d0C88145E82600E62e7E496e0F222B", currency1: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", fee: 500, tickSpacing: 5, hooks: NATIVE },
  // USDG / HIMS, 0.9%, hookless (0x68d4f28f…)
  { currency0: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", currency1: "0xCceE82fE024c36fA15E1005edE3E9e4787e23D09", fee: 9000, tickSpacing: 90, hooks: NATIVE },
  // USDG / HIMS, dynamic fee, Fables fee hook (0x16dce5f6…)
  { currency0: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", currency1: "0xCceE82fE024c36fA15E1005edE3E9e4787e23D09", fee: 8388608, tickSpacing: 60, hooks: "0x5Eb87F69bE00Df39981622Fd60A8De4b7837e080" },
  // USDG / INTC, 1%, hookless (0xf2e329e6…)
  { currency0: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", currency1: "0xc72b96e0E48ecd4DC75E1e45396e26300BC39681", fee: 10000, tickSpacing: 200, hooks: NATIVE },
  // USDG / INTC, dynamic fee, Fables fee hook (0x5e4c3534…)
  { currency0: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", currency1: "0xc72b96e0E48ecd4DC75E1e45396e26300BC39681", fee: 8388608, tickSpacing: 60, hooks: "0x5Eb87F69bE00Df39981622Fd60A8De4b7837e080" },
  // TSM / USDG, 0.75%, hookless (0x0ba5d53d…)
  { currency0: "0x58FfE4a942d3885bAa22D7520691F611EF09e7AA", currency1: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", fee: 7500, tickSpacing: 75, hooks: NATIVE },
  // USDG / GLD, 0.21%, hookless (0xd85389e6…)
  { currency0: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", currency1: "0xC9a981FEE1F9DEc688bb123ccDeCc63D0deBFC4e", fee: 2100, tickSpacing: 21, hooks: NATIVE },
  // USDG / GLD, dynamic fee, Fables fee hook (0xfe281bbf…)
  { currency0: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", currency1: "0xC9a981FEE1F9DEc688bb123ccDeCc63D0deBFC4e", fee: 8388608, tickSpacing: 10, hooks: "0xB608a78761f179f7C56f15E7D13921B92F00a080" },
  // ETH / MU, 0.8%, hookless (0x881b4219…)
  { currency0: NATIVE, currency1: "0xfF080c8ce2E5feadaCa0Da81314Ae59D232d4afD", fee: 8000, tickSpacing: 80, hooks: NATIVE },
];

const RH_AI: Address = "0x2E8c31162b855A2ffa90F6F8634643Ad6F111e18";
const RH_ORBIO: Address = "0xAa07A0e9209e16aC99708C3EC70159c6eF3128A3";
/** The fee hook v2 already allows on CASHCAT / USDG. */
const FABLES_HOOK: Address = "0x08E52564Bad99E05a694b4809F397edcA417A080";

/**
 * Pools queued on v2 after its deploy: live on the router by themselves once
 * their 3-day notice ends (AI and ORBIO, 2026-11-03 at 17:09 UTC). Kept apart
 * from RH_SWAP_POOLS_V2, which stays exactly what v2 allowed at deploy. Each key
 * was read from the PoolManager's Initialize event for its pool id. The app
 * routes through one only once the router says it is live (livePools).
 */
export const RH_SWAP_POOLS_V2_QUEUED: readonly PoolKey[] = [
  // AI / USDG, dynamic fee, Fables fee hook (0x592e3fb7…)
  { currency0: RH_AI, currency1: RH_USDG, fee: 8388608, tickSpacing: 60, hooks: FABLES_HOOK },
  // AI / USDG, 0.23%, hookless (0x7aebd805…)
  { currency0: RH_AI, currency1: RH_USDG, fee: 2300, tickSpacing: 23, hooks: NATIVE },
  // USDG / ORBIO, 0.8%, hookless (0xea9f200e…)
  { currency0: RH_USDG, currency1: RH_ORBIO, fee: 8000, tickSpacing: 80, hooks: NATIVE },
  // USDG / ORBIO, dynamic fee, Fables fee hook (0xc761f7de…)
  { currency0: RH_USDG, currency1: RH_ORBIO, fee: 8388608, tickSpacing: 200, hooks: FABLES_HOOK },
];

/** What v1 swaps between. */
const RH_SWAP_ASSETS_V1: readonly Address[] = [RH_USDG, RH_GLOAM];
/**
 * What v2 swaps between, in the order the picker lists them: the dollar, $GLOAM,
 * ETH (as WETH), two more dollars, crypto, then Robinhood's stock tokens. Each
 * one's metadata is in lib/tokens RH_MAINNET_SWAP_TOKENS. To offer another
 * token: add it here and there, its pools to RH_SWAP_POOLS_V2 (queued on the
 * router first), and have the vault take it (a deposit limit, queued on the
 * vault). Left out on purpose: HOOD (a third-party vault share), QQQ (6 to 17%
 * price impact at $5,000 on v4), tokens with a transfer tax or one-sided
 * liquidity, and tokens that trade only on Uniswap v3.
 */
export const RH_SWAP_ASSETS_V2: readonly Address[] = [
  RH_USDG,
  RH_GLOAM,
  RH_WETH,
  "0x5d3a1Ff2b6BAb83b63cd9AD0787074081a52ef34", // USDe
  "0xcE24439F2D9C6a2289F741120FE202248B666666", // U
  "0xCEC185eB182c47d1bA1EFc84e6959e18cd620Be4", // cbBTC
  "0x39dBED3a2bd333467115dE45665cC57F813C4571", // PONS
  "0x020bfC650A365f8BB26819deAAbF3E21291018b4", // CASHCAT
  "0xc6911796042b15d7Fa4F6CDe69e245DdCd3d9c31", // VIRTUAL
  "0x117cc2133c37B721F49dE2A7a74833232B3B4C0C", // SPY
  "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC", // NVDA
  "0x322F0929c4625eD5bAd873c95208D54E1c003b2d", // TSLA
  "0x12f190a9F9d7D37a250758b26824B97CE941bF54", // AMZN
  "0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa", // SPCX
  "0xdF0992E440dD0be65BD8439b609d6D4366bf1CB5", // CRCL
  "0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35", // META
  "0xec262a75e413fAfD0dF80480274532C79D42da09", // MSTR
  "0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3", // GOOGL
  "0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9", // AAPL
  "0xe93237C50D904957Cf27E7B1133b510C669c2e74", // MSFT
  "0x894E1EC2D74FFE5AEF8Dc8A9e84686acCB964F2A", // PLTR
  "0x86923f96303D656E4aa86D9d42D1e57ad2023fdC", // AMD
  "0x6330D8C3178a418788dF01a47479c0ce7CCF450b", // COIN
  "0x05a3d1Cd21d0C88145E82600E62e7E496e0F222B", // AMC
  "0xCceE82fE024c36fA15E1005edE3E9e4787e23D09", // HIMS
  "0xc72b96e0E48ecd4DC75E1e45396e26300BC39681", // INTC
  "0x58FfE4a942d3885bAa22D7520691F611EF09e7AA", // TSM
  "0xC9a981FEE1F9DEc688bb123ccDeCc63D0deBFC4e", // GLD
  "0xfF080c8ce2E5feadaCa0Da81314Ae59D232d4afD", // MU
];

/**
 * What the queued pools add. The picker offers one only once a pool of its is
 * live on the router and the vault takes deposits of it (offeredSwapAssets).
 */
export const RH_SWAP_ASSETS_V2_QUEUED: readonly Address[] = [RH_AI, RH_ORBIO];

// ---------------------------------------------------------------- Base and Ethereum (Uniswap v4, v3 only)

const BASE_USDC: Address = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const BASE_USDT: Address = "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2";
const BASE_EURC: Address = "0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42";
const BASE_WETH: Address = "0x4200000000000000000000000000000000000006";
const ETH_USDC: Address = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const ETH_USDT: Address = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
const ETH_USDG: Address = "0xe343167631d89B6Ffc58B88d6b7fB0228795491D";
const ETH_EURC: Address = "0x1aBaEA1f7C830bD89Acc67eC4af516284b1bC33c";
const ETH_WETH: Address = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";

const hookless = (currency0: Address, currency1: Address, fee: number, tickSpacing: number): PoolKey => ({
  currency0,
  currency1,
  fee,
  tickSpacing,
  hooks: NATIVE,
});

/**
 * The pools v3 allows at deploy on Base, in DeployVaultSwapV4c.s.sol's order
 * (contracts/test/fixtures/router-next.json pins both). Hookless only, picked from
 * live state on 2026-10-31 by quoting $100, $500 and $5,000 both ways against Uniswap v3.
 */
export const BASE_SWAP_POOLS: readonly PoolKey[] = [
  hookless(NATIVE, BASE_USDC, 500, 10),
  hookless(NATIVE, BASE_USDC, 3000, 60),
  hookless(BASE_USDC, BASE_USDT, 7, 1),
  hookless(BASE_USDC, BASE_USDT, 6, 1),
  hookless(BASE_USDC, BASE_USDT, 4, 1),
  hookless(BASE_USDC, BASE_USDT, 100, 1),
  hookless(BASE_EURC, BASE_USDC, 500, 10),
];

/**
 * v3's pools on Ethereum, the same way. Left out, checked on chain on 2026-11-01:
 * PYUSD ($100 into its USDC pool returns about $6) and BDX (v4 pools on both chains,
 * about $1,100 at most, nearly all at LP fees of 9% to 98%, and selling $100 returns under $10).
 */
export const ETHEREUM_SWAP_POOLS: readonly PoolKey[] = [
  hookless(NATIVE, ETH_USDC, 500, 10),
  hookless(NATIVE, ETH_USDC, 100, 1),
  hookless(NATIVE, ETH_USDT, 500, 10),
  hookless(NATIVE, ETH_USDT, 100, 1),
  hookless(ETH_USDC, ETH_USDT, 7, 1),
  hookless(ETH_USDC, ETH_USDT, 8, 1),
  hookless(ETH_USDC, ETH_USDT, 10, 1),
  hookless(ETH_USDC, ETH_USDT, 100, 1),
  hookless(ETH_USDC, ETH_USDG, 65, 1),
  hookless(ETH_USDC, ETH_USDG, 100, 1),
  hookless(ETH_USDT, ETH_USDG, 100, 1),
  hookless(ETH_EURC, ETH_USDC, 250, 3),
  hookless(ETH_EURC, ETH_USDC, 300, 6),
];

/** The dollar stablecoins, whose pairs barely move, so a swap between two asks a thinner buffer. 6 decimals each. */
export const DOLLARS: readonly Address[] = [RH_USDG, BASE_USDC, BASE_USDT, ETH_USDC, ETH_USDT, ETH_USDG];

// ---------------------------------------------------------------- Tempo (Stablecoin DEX)

export const TEMPO_STABLE_DEX: Address = "0xdec0000000000000000000000000000000000000";

const TEMPO_SWAP_ASSETS: readonly Address[] = [
  "0x20c000000000000000000000b9537d11c60e8b50", // USDC.e
  "0x20c0000000000000000000000000000000000000", // pathUSD
  "0x20c00000000000000000000014f22ca97301eb73", // USDT0
  "0x20c0000000000000000000006a37da5c996874be", // OUSD
];

/** What v3 swaps between, per chain, in the order the picker lists them. Native ETH is address(0). */
const RH_SWAP_ASSETS_V3: readonly Address[] = [RH_USDG, NATIVE, ...RH_SWAP_ASSETS_V2.slice(1), ...RH_SWAP_ASSETS_V2_QUEUED];
const BASE_SWAP_ASSETS: readonly Address[] = [BASE_USDC, BASE_USDT, BASE_EURC, NATIVE];
const ETHEREUM_SWAP_ASSETS: readonly Address[] = [ETH_USDC, ETH_USDT, ETH_USDG, ETH_EURC, NATIVE];

/** The assets a new swap can go between on a chain (the current router's list; the app's VAULT_SWAP_ASSETS). */
export function vaultSwapAssets(chainId: number): readonly Address[] {
  if (chainId === 4663) {
    return v3On(4663) ? RH_SWAP_ASSETS_V3 : VAULT_SWAP_V2_ROUTER[4663] ? [...RH_SWAP_ASSETS_V2, ...RH_SWAP_ASSETS_V2_QUEUED] : RH_SWAP_ASSETS_V1;
  }
  if (chainId === 4217) return TEMPO_SWAP_ASSETS;
  if (chainId === 8453) return v3On(8453) ? BASE_SWAP_ASSETS : [];
  if (chainId === 1) return v3On(1) ? ETHEREUM_SWAP_ASSETS : [];
  return [];
}

// ---------------------------------------------------------------- routers

export type SwapRouter = {
  address: Address;
  /** "v4": Uniswap v4 routes (GloamVaultSwapV4, V4b). "tempo": the Stablecoin DEX, no route. */
  venue: "v4" | "tempo";
  /** 1: GloamVaultSwapV4 or GloamVaultSwapTempo. 2: GloamVaultSwapV4b. 3: GloamVaultSwapV4c or GloamVaultSwapTempo2. */
  version: 1 | 2 | 3;
  /** The pools a route may use (on chain, an allowlist has the last word from v2 on). */
  pools: readonly PoolKey[];
  maxHops: number;
  /** From v2 on: the chain's WETH, converted to or from ETH at a route's ends. */
  weth: Address | null;
  /** What a swap through it can go between. */
  assets: readonly Address[];
  /** Where its quotes come from. null: no v4 route (Tempo's DEX). */
  quoter?: Address | null;
  /** Assets offered only once they open on chain (offeredSwapAssets). */
  gated?: readonly Address[];
};

/** v3 on a chain, deployed or not: the switches decide when anything uses it. */
function routerV3(chainId: number): SwapRouter | null {
  const address = VAULT_SWAP_V3_ADDRESS[chainId];
  if (!address) return null;
  if (chainId === 4217) return { address, venue: "tempo", version: 3, pools: [], maxHops: 0, weth: null, assets: TEMPO_SWAP_ASSETS, quoter: null };
  if (chainId === 8453) return { address, venue: "v4", version: 3, pools: BASE_SWAP_POOLS, maxHops: 3, weth: BASE_WETH, assets: BASE_SWAP_ASSETS, quoter: BASE_V4_QUOTER };
  if (chainId === 1) return { address, venue: "v4", version: 3, pools: ETHEREUM_SWAP_POOLS, maxHops: 3, weth: ETH_WETH, assets: ETHEREUM_SWAP_ASSETS, quoter: ETHEREUM_V4_QUOTER };
  return {
    address,
    venue: "v4",
    version: 3,
    pools: [...RH_SWAP_POOLS_V2, ...RH_SWAP_POOLS_V2_QUEUED],
    maxHops: 3,
    weth: RH_WETH,
    assets: RH_SWAP_ASSETS_V3,
    quoter: RH_V4_QUOTER,
    // the vault's native ETH limit lands through its timelock, like AI's and ORBIO's
    gated: [NATIVE, ...RH_SWAP_ASSETS_V2_QUEUED],
  };
}

/** Every router on a chain, the newest first. */
function routerList(chainId: number): SwapRouter[] {
  const v3 = v3On(chainId) ? [routerV3(chainId)!] : [];
  return [...v3, ...olderRouters(chainId)];
}

function olderRouters(chainId: number): SwapRouter[] {
  if (chainId === 4663) {
    const v1: SwapRouter = {
      address: RH_ROUTER_V1, venue: "v4", version: 1, pools: RH_SWAP_POOLS, maxHops: 2, weth: null, assets: RH_SWAP_ASSETS_V1,
    };
    const v2 = VAULT_SWAP_V2_ROUTER[4663];
    return v2
      ? [{ address: v2, venue: "v4", version: 2, pools: [...RH_SWAP_POOLS_V2, ...RH_SWAP_POOLS_V2_QUEUED], maxHops: 3, weth: RH_WETH, assets: [...RH_SWAP_ASSETS_V2, ...RH_SWAP_ASSETS_V2_QUEUED], gated: RH_SWAP_ASSETS_V2_QUEUED }, v1]
      : [v1];
  }
  if (chainId === 4217) {
    return [{ address: TEMPO_ROUTER, venue: "tempo", version: 1, pools: [], maxHops: 0, weth: null, assets: TEMPO_SWAP_ASSETS }];
  }
  return [];
}

/**
 * A router the app and the relay know: with no address, the one new swaps go
 * through; with one, that router (a refund goes back through the router its
 * swap used). null while swaps are off on the chain, or for an unknown address.
 */
export function swapRouterFor(chainId: number, address?: string | null): SwapRouter | null {
  const current = vaultSwapRouter(chainId);
  if (!current) return null;
  const all = routerList(chainId);
  if (!all.length) return null;
  if (!address || same(address, current)) return { ...all[0]!, address: current };
  return all.find((r) => same(r.address, address)) ?? null;
}

/**
 * Every router on a chain the relay still knows, the one new swaps go through
 * first (an older one stays for refunds of swaps made through it). Empty while
 * swaps are off there. For the contract list on /verify.
 */
export function swapRoutersOn(chainId: number): SwapRouter[] {
  const current = vaultSwapRouter(chainId);
  if (!current) return [];
  const all = routerList(chainId);
  return all.map((r, i) => (i === 0 ? { ...r, address: current } : r));
}

export function isSwapAsset(chainId: number, asset: string, router?: string | null): boolean {
  const list = swapRouterFor(chainId, router)?.assets ?? vaultSwapAssets(chainId);
  return list.some((a) => same(a, asset));
}

/**
 * How far below the quote the swap asks, in basis points. The trade must
 * cost no more than what arrives, or it reverts whole and nothing moves; the
 * part it does not use goes to the treasury. GLOAM moves, stablecoins barely.
 * Off Robinhood Chain, a swap between two dollars asks the thinner buffer too.
 */
export function swapBufferBps(chainId: number, assetIn?: Address, assetOut?: Address): number {
  if (chainId === 4217) return 10;
  return chainId !== 4663 && isDollar(assetIn) && isDollar(assetOut) ? 10 : 50;
}

// ---------------------------------------------------------------- contract

const SWAP_ERRORS = [
  "ZeroAddress", "NotAContract", "SameAsset", "NativeNotSupported", "InvalidAmount", "Reentrancy", "TokenCallFailed",
  "BadRoute", "NotPoolManager", "MiddleNotSettled", "BadRefund", "EscrowUsed", "NativeRefused",
].map((name) => ({ type: "error" as const, name, inputs: [] }));

/** GloamVaultSwap.EscrowKey, in order: what a swap's escrow address is derived from. */
const ESCROW_KEY_COMPONENTS = [
  { name: "nullifier", type: "bytes32" },
  { name: "amountIn", type: "uint256" },
  { name: "outCommitment", type: "bytes32" },
  { name: "assetOut", type: "address" },
  { name: "amountOut", type: "uint256" },
  { name: "refundCommitment", type: "bytes32" },
  { name: "refundAmount", type: "uint256" },
  { name: "routeHash", type: "bytes32" },
] as const;

/** GloamVaultSwap2.EscrowKey: the same, then the swap's exit key and deadline. */
const ESCROW_KEY_V3_COMPONENTS = [
  ...ESCROW_KEY_COMPONENTS,
  { name: "exitKey", type: "address" },
  { name: "deadline", type: "uint256" },
] as const;

/** How long a v3 swap has to land, from the chain's own clock when it is made. */
export const SWAP_DEADLINE_SECONDS = 30 * 60;
/**
 * On Base and Ethereum, 10 minutes: until a swap lands or its note moves, anyone can land it
 * at the rate agreed, and a stablecoin that loses its peg in that time is what a deadline is for.
 */
export function swapDeadlineSeconds(chainId: number): number {
  return swapChecked(chainId) ? 10 * 60 : SWAP_DEADLINE_SECONDS;
}
/** The relay sends a swap only with at least this long left: closer than that it could pass the dry run and land late. */
export const SWAP_SEND_MARGIN_SECONDS = 60;

/** Whether a swap can no longer land at `now`, in seconds: it lands up to and including its deadline. */
export function swapExpired(deadline: bigint, now: bigint): boolean {
  return now > deadline;
}

export type EscrowKey = {
  nullifier: Hex;
  amountIn: bigint;
  outCommitment: Hex;
  assetOut: Address;
  amountOut: bigint;
  refundCommitment: Hex;
  refundAmount: bigint;
  routeHash: Hex;
  /** v3: the swap's one-time exit key. Without it, the key of the routers before v3. */
  exitKey?: Address;
  /** v3: the last time the swap can land, in seconds. It comes with the exit key. */
  deadline?: bigint;
};

/**
 * SwapEscrow's creation code (contracts/src/SwapEscrow.sol, solc 0.8.24,
 * optimizer 200, shanghai), pinned: keccak256 is SWAP_ESCROW_CODE_HASH, the
 * same value VaultSwapReview.t.sol checks against the compiled contract. The
 * app works each swap's escrow out from it and refuses to swap if the router's
 * own escrowFor disagrees.
 */
export const SWAP_ESCROW_INIT_CODE: Hex =
  "0x608060405234801561000f575f80fd5b5060405161023438038061023483398101604081905261002e916101a4565b6040516370a0823160e01b81523060048201525f906001600160a01b038316906370a0823190602401602060405180830381865afa158015610072573d5f803e3d5ffd5b505050506040513d601f19601f8201168201806040525081019061009691906101d1565b905080156101a25760408051336024820152604480820184905282518083039091018152606490910182526020810180516001600160e01b031663a9059cbb60e01b17905290515f9182916001600160a01b038616916100f5916101e8565b5f604051808303815f865af19150503d805f811461012e576040519150601f19603f3d011682016040523d82523d5f602084013e610133565b606091505b509150915081801561015d57508051158061015d57508080602001905181019061015d9190610214565b61019f5760405162461bcd60e51b815260206004820152600f60248201526e32b9b1b937bb903a3930b739b332b960891b604482015260640160405180910390fd5b50505b005b5f602082840312156101b4575f80fd5b81516001600160a01b03811681146101ca575f80fd5b9392505050565b5f602082840312156101e1575f80fd5b5051919050565b5f82515f5b8181101561020757602081860181015185830152016101ed565b505f920191825250919050565b5f60208284031215610224575f80fd5b815180151581146101ca575f80fdfe";
export const SWAP_ESCROW_CODE_HASH: Hex = "0x192133b7cb5a5193a55ec981c9f7272702248f684d2b85aa1dd843dde9b85bd4";

/**
 * SwapEscrow2's creation code (contracts/src/SwapEscrow2.sol), pinned the same way:
 * keccak256 is SWAP_ESCROW2_CODE_HASH, the value in contracts/test/fixtures/router-next.json.
 */
export const SWAP_ESCROW2_INIT_CODE: Hex =
  "0x608060405234801561000f575f80fd5b5060405161035338038061035383398101604081905261002e916102c3565b5f336001600160a01b0316632b4611906040518163ffffffff1660e01b8152600401602060405180830381865afa15801561006b573d5f803e3d5ffd5b505050506040513d601f19601f8201168201806040525081019061008f91906102c3565b90506001600160a01b0382166101445747801561013e575f826001600160a01b0316826040515f6040518083038185875af1925050503d805f81146100ef576040519150601f19603f3d011682016040523d82523d5f602084013e6100f4565b606091505b505090508061013c5760405162461bcd60e51b815260206004820152600f60248201526e32b9b1b937bb903a3930b739b332b960891b60448201526064015b60405180910390fd5b505b506102ba565b6040516370a0823160e01b81523060048201525f906001600160a01b038416906370a0823190602401602060405180830381865afa158015610188573d5f803e3d5ffd5b505050506040513d601f19601f820116820180604052508101906101ac91906102f0565b905080156102b857604080516001600160a01b038481166024830152604480830185905283518084039091018152606490920183526020820180516001600160e01b031663a9059cbb60e01b17905291515f9283929087169161020f9190610307565b5f604051808303815f865af19150503d805f8114610248576040519150601f19603f3d011682016040523d82523d5f602084013e61024d565b606091505b50915091508180156102775750805115806102775750808060200190518101906102779190610333565b6102b55760405162461bcd60e51b815260206004820152600f60248201526e32b9b1b937bb903a3930b739b332b960891b6044820152606401610133565b50505b505b60fe5f5360015ff35b5f602082840312156102d3575f80fd5b81516001600160a01b03811681146102e9575f80fd5b9392505050565b5f60208284031215610300575f80fd5b5051919050565b5f82515f5b81811015610326576020818601810151858301520161030c565b505f920191825250919050565b5f60208284031215610343575f80fd5b815180151581146102e9575f80fdfe";
export const SWAP_ESCROW2_CODE_HASH: Hex = "0x929521c51ece2df1d9b72eb6ff3b7e94b036bfe9d7c70d18cea088fcb6a079c6";

/** A swap's escrow, worked out here: CREATE2 from the router, salt keccak256(abi.encode(key)). */
export function escrowAddress(router: Address, assetIn: Address, key: EscrowKey): Address {
  const fields = [key.nullifier, key.amountIn, key.outCommitment, key.assetOut, key.amountOut, key.refundCommitment, key.refundAmount, key.routeHash] as const;
  if (key.exitKey && key.deadline === undefined) throw new Error("A v3 swap needs a deadline.");
  const salt = keccak256(
    key.exitKey
      ? encodeAbiParameters(ESCROW_KEY_V3_COMPONENTS, [...fields, key.exitKey, key.deadline!])
      : encodeAbiParameters(ESCROW_KEY_COMPONENTS, fields)
  );
  const init = key.exitKey ? SWAP_ESCROW2_INIT_CODE : SWAP_ESCROW_INIT_CODE;
  const bytecode = concatHex([init, encodeAbiParameters([{ type: "address" }], [assetIn])]);
  return getContractAddress({ opcode: "CREATE2", from: router, salt, bytecode });
}

/** Keeps an exit signature from meaning anything else (GloamVaultSwap2.EXIT_DOMAIN). */
const EXIT_DOMAIN = keccak256(toHex("gloam.vault-swap.exit.v1"));

/** What a swap's exit key signs to send its escrow to `to`: GloamVaultSwap2.exitDigest, worked out here. */
export function exitDigest(chainId: number, router: Address, escrow: Address, to: Address): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "uint256" }, { type: "address" }, { type: "address" }, { type: "address" }],
      [EXIT_DOMAIN, BigInt(chainId), router, escrow, to]
    )
  );
}

/**
 * A swap's one-time exit key, from its refund note's secret. Whoever can spend the
 * refund note can exit, a backup restores it with the note, and the secret itself
 * never leaves whatever holds the note. Each swap's is its own. A secret can't be a
 * key as it stands: hashing it also keeps a signature from saying anything about the note.
 * The same derivation as the app, so a refund note made by either can exit with either.
 */
export function exitAccount(refundSecret: Hex) {
  return privateKeyToAccount(keccak256(concatHex([toHex("gloam.vault-swap.exit-key.v1"), refundSecret])));
}

/**
 * What a swap's refund note keeps, so the refund can be finished later if someone
 * sent the note's unshield on its own (swapIntent.ts buildSwapRefund). The same
 * shape as the app's. Amounts as decimal strings, so it stores as JSON.
 */
export type VaultSwapRefundInfo = {
  router: Address;
  assetIn: Address;
  amountIn: string;
  out: { commitment: Hex; asset: Address; amount: string };
  route: PoolKey[];
  /** v3: the swap's exit key, the public half (exitAccount has the rest). */
  exitKey?: Address;
  /** v3: the swap's deadline, in seconds, as a decimal string. */
  deadline?: string;
  /** The transaction that paid the escrow, once found (findSwapUnshieldTx): what a refund or an exit shows the relay. */
  unshieldTx?: Hex;
  /** The relay's send of this swap, once it answered: how it ended can be read from it later. */
  sent?: { hash: Hex; at: number };
};

/** The escrow key for a refund note, from what it keeps. */
export function refundEscrowKey(info: VaultSwapRefundInfo, nullifier: Hex, refundCommitment: Hex, refundAmount: bigint): EscrowKey {
  return {
    nullifier,
    amountIn: BigInt(info.amountIn),
    outCommitment: info.out.commitment,
    assetOut: info.out.asset,
    amountOut: BigInt(info.out.amount),
    refundCommitment,
    refundAmount,
    routeHash: keccak256(encodeRoute(info.route)),
    ...(info.exitKey ? { exitKey: info.exitKey, deadline: BigInt(info.deadline ?? "0") } : {}),
  };
}

const balanceOfAbi = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

/** The vault's event for a note leaving it. The amount is the note's, before the vault's fee. */
export const UNSHIELDED_EVENT = {
  type: "event",
  name: "Unshielded",
  inputs: [
    { name: "nullifier", type: "bytes32", indexed: true },
    { name: "asset", type: "address", indexed: true },
    { name: "to", type: "address", indexed: true },
    { name: "amount", type: "uint256", indexed: false },
  ],
} as const;

const UNSHIELDED_TOPIC = toEventSelector(UNSHIELDED_EVENT);

/** Whether a receipt's logs show `vault` paying this note out to `escrow`, for this amount. */
export function receiptPaysEscrow(
  logs: readonly { address: string; topics: readonly string[]; data: string }[],
  vault: string,
  paid: { nullifier: Hex; asset: Address; escrow: Address; amount: bigint }
): boolean {
  const word = (a: string) => pad(a.toLowerCase() as Hex, { size: 32 });
  return logs.some(
    (l) =>
      same(l.address, vault) &&
      l.topics[0] === UNSHIELDED_TOPIC &&
      same(l.topics[1] ?? "", paid.nullifier) &&
      same(l.topics[2] ?? "", word(paid.asset)) &&
      same(l.topics[3] ?? "", word(paid.escrow)) &&
      BigInt(l.data || "0x0") === paid.amount
  );
}

/**
 * Whether a swap's money waits at its escrow (someone sent the note's unshield on its
 * own, and no refund has finished yet): true when it covers the refund note; "short"
 * when the note's money is there but the vault's fee rose past what the refund note
 * allowed for, so that note can't land and the exit is the way back; false otherwise.
 * "short" asks for at least what the vault's highest fee leaves, so a stray transfer
 * to an escrow is never read as a swap's money.
 */
export async function escrowHolds(
  client: PublicClient,
  info: VaultSwapRefundInfo,
  nullifier: Hex,
  refundCommitment: Hex,
  refundAmount: bigint,
  blockNumber?: bigint
): Promise<boolean | "short"> {
  const escrow = escrowAddress(info.router, info.assetIn, refundEscrowKey(info, nullifier, refundCommitment, refundAmount));
  const at = blockNumber !== undefined ? { blockNumber } : {};
  const held = same(info.assetIn, NATIVE)
    ? await client.getBalance({ address: escrow, ...at })
    : await client.readContract({ address: info.assetIn, abi: balanceOfAbi, functionName: "balanceOf", args: [escrow], ...at });
  if (held >= refundAmount) return true;
  return held > 0n && held >= refundAmountFor(BigInt(info.amountIn)) ? "short" : false;
}

const DEPOSIT_COMPONENTS = [
  { name: "proof", type: "bytes" },
  { name: "commitment", type: "bytes32" },
  { name: "asset", type: "address" },
  { name: "amount", type: "uint256" },
] as const;

export const vaultSwapAbi = [
  {
    type: "function",
    name: "swap",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "s",
        type: "tuple",
        components: [
          { name: "proof", type: "bytes" },
          { name: "root", type: "bytes32" },
          { name: "nullifier", type: "bytes32" },
          { name: "asset", type: "address" },
          { name: "amount", type: "uint256" },
        ],
      },
      { name: "d", type: "tuple", components: DEPOSIT_COMPONENTS },
      { name: "r", type: "tuple", components: DEPOSIT_COMPONENTS },
      { name: "route", type: "bytes" },
    ],
    outputs: [{ name: "amountIn", type: "uint256" }],
  },
  {
    type: "function",
    name: "escrowFor",
    stateMutability: "view",
    inputs: [
      { name: "assetIn", type: "address" },
      { name: "k", type: "tuple", components: ESCROW_KEY_COMPONENTS },
    ],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "error",
    name: "OverInput",
    inputs: [
      { name: "needed", type: "uint256" },
      { name: "available", type: "uint256" },
    ],
  },
  {
    type: "error",
    name: "ShortOutput",
    inputs: [
      { name: "got", type: "uint256" },
      { name: "wanted", type: "uint256" },
    ],
  },
  { type: "error", name: "PoolNotAllowed", inputs: [{ name: "poolId", type: "bytes32" }] },
  ...SWAP_ERRORS,
] as const;

const SPEND_COMPONENTS = [
  { name: "proof", type: "bytes" },
  { name: "root", type: "bytes32" },
  { name: "nullifier", type: "bytes32" },
  { name: "asset", type: "address" },
  { name: "amount", type: "uint256" },
] as const;

/** v3's own calls: swap() names the exit key, escrowFor() takes the longer key, and exit() is new. */
export const vaultSwapV3Abi = [
  {
    type: "function",
    name: "swap",
    stateMutability: "nonpayable",
    inputs: [
      { name: "s", type: "tuple", components: SPEND_COMPONENTS },
      { name: "d", type: "tuple", components: DEPOSIT_COMPONENTS },
      { name: "r", type: "tuple", components: DEPOSIT_COMPONENTS },
      { name: "route", type: "bytes" },
      { name: "exitKey", type: "address" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [{ name: "amountIn", type: "uint256" }],
  },
  {
    type: "function",
    name: "escrowFor",
    stateMutability: "view",
    inputs: [
      { name: "assetIn", type: "address" },
      { name: "k", type: "tuple", components: ESCROW_KEY_V3_COMPONENTS },
    ],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "exit",
    stateMutability: "nonpayable",
    inputs: [
      { name: "assetIn", type: "address" },
      { name: "k", type: "tuple", components: ESCROW_KEY_V3_COMPONENTS },
      { name: "to", type: "address" },
      { name: "signature", type: "bytes" },
    ],
    outputs: [{ name: "amount", type: "uint256" }],
  },
  {
    type: "error",
    name: "OverInput",
    inputs: [
      { name: "needed", type: "uint256" },
      { name: "available", type: "uint256" },
    ],
  },
  {
    type: "error",
    name: "ShortOutput",
    inputs: [
      { name: "got", type: "uint256" },
      { name: "wanted", type: "uint256" },
    ],
  },
  { type: "error", name: "PoolNotAllowed", inputs: [{ name: "poolId", type: "bytes32" }] },
  { type: "error", name: "BadExit", inputs: [] },
  { type: "error", name: "SwapExpired", inputs: [] },
  { type: "error", name: "EscrowFailed", inputs: [] },
  { type: "error", name: "ReceiveBlocked", inputs: [] },
  ...SWAP_ERRORS,
] as const;

const POOL_KEY_COMPONENTS = [
  { name: "currency0", type: "address" },
  { name: "currency1", type: "address" },
  { name: "fee", type: "uint24" },
  { name: "tickSpacing", type: "int24" },
  { name: "hooks", type: "address" },
] as const;

/** The route bytes the router takes: abi.encode(PoolKey[]) on Robinhood Chain, nothing on Tempo. */
export function encodeRoute(route: readonly PoolKey[]): Hex {
  if (!route.length) return "0x";
  return encodeAbiParameters([{ type: "tuple[]", components: POOL_KEY_COMPONENTS }], [
    route.map((k) => ({ ...k })),
  ]);
}

/** A pool's v4 PoolId, keccak256(abi.encode(PoolKey)): what the routers' allowlists hold. */
export function poolId(k: PoolKey): Hex {
  return keccak256(encodeAbiParameters([{ type: "tuple", components: POOL_KEY_COMPONENTS }], [{ ...k }]));
}

const sameKey = (a: PoolKey, b: PoolKey) =>
  same(a.currency0, b.currency0) && same(a.currency1, b.currency1) && a.fee === b.fee && a.tickSpacing === b.tickSpacing && same(a.hooks, b.hooks);
const holds = (k: PoolKey, c: string) => same(k.currency0, c) || same(k.currency1, c);

/**
 * The currencies a route passes through, as the PoolManager sees them, worked
 * out exactly as the router does it (GloamVaultSwapV4b and V4c _walk), or null when
 * the router would refuse the route. A note in one form of ETH pays in the other
 * when its first pool holds only that one, and a route can end in the other form
 * from the new note. Each currency once, and an end that is converted nowhere
 * inside the route in the form the note holds. v3 alone takes native ETH notes.
 * Every pool must be one of the router's (and pass `allowed`).
 */
export function routeCurrencies(
  r: SwapRouter,
  assetIn: Address,
  assetOut: Address,
  route: readonly PoolKey[],
  allowed?: (k: PoolKey) => boolean
): Address[] | null {
  const n = route.length;
  if (r.venue !== "v4" || n === 0 || n > r.maxHops) return null;
  if (same(assetIn, assetOut)) return null;
  if (r.version < 3 && (same(assetIn, NATIVE) || same(assetOut, NATIVE))) return null;
  const twin = (a: Address) => ethTwin(r, a);
  let cur: Address = assetIn;
  const inTwin = twin(assetIn);
  if (inTwin !== null && !holds(route[0]!, assetIn) && holds(route[0]!, inTwin)) cur = inTwin;
  const path: Address[] = [cur];
  for (const k of route) {
    if (!r.pools.some((p) => sameKey(p, k)) || (allowed && !allowed(k))) return null;
    if (same(k.currency0, cur)) cur = k.currency1;
    else if (same(k.currency1, cur)) cur = k.currency0;
    else return null;
    path.push(cur);
  }
  const outTwin = twin(assetOut);
  if (!same(cur, assetOut) && !(outTwin !== null && same(cur, outTwin))) return null;
  for (let i = 0; i <= n; i++) {
    if (!same(path[0]!, assetIn) && same(path[i]!, assetIn)) return null;
    if (!same(path[n]!, assetOut) && same(path[i]!, assetOut)) return null;
    for (let j = i + 1; j <= n; j++) if (same(path[i]!, path[j]!)) return null;
  }
  return path;
}

/** The other form of ETH for `a`, or null when `a` is no ETH this router converts. */
function ethTwin(r: SwapRouter, a: Address): Address | null {
  if (!r.weth) return null;
  if (same(a, r.weth)) return NATIVE;
  return same(a, NATIVE) ? r.weth : null;
}

/**
 * Every route the router takes from `assetIn` to `assetOut`, fewest hops
 * first: a walk over the pools that join, each route checked by
 * routeCurrencies, the router's own rules.
 */
export function routesBetween(
  assetIn: Address,
  assetOut: Address,
  r: SwapRouter | null = swapRouterFor(4663),
  allowed?: (k: PoolKey) => boolean
): PoolKey[][] {
  if (!r || r.venue !== "v4") return [];
  const pools = allowed ? r.pools.filter(allowed) : r.pools;
  const inTwin = ethTwin(r, assetIn);
  const out: PoolKey[][] = [];
  const extend = (route: PoolKey[], cur: Address) => {
    for (const k of pools) {
      if (route.includes(k)) continue;
      // a note pays its first pool in the other form of ETH when that pool holds only that one
      const from = !route.length && inTwin !== null && !holds(k, assetIn) && holds(k, inTwin) ? inTwin : cur;
      if (!holds(k, from)) continue;
      const next = same(k.currency0, from) ? k.currency1 : k.currency0;
      const at = [...route, k];
      if (routeCurrencies(r, assetIn, assetOut, at)) out.push(at);
      // past the output a route could only come back to it
      if (at.length < r.maxHops && !same(next, assetOut)) extend(at, next);
    }
  };
  extend([], assetIn);
  return out.sort((a, b) => a.length - b.length);
}

/** The most routes one quote asks about, fewest hops first: one multicall, kept small. */
export const MAX_QUOTED_ROUTES = 24;

/** Whether `route` is one the router would take, for the relay to check before it pays gas. */
export function isKnownRoute(
  chainId: number,
  assetIn: Address,
  assetOut: Address,
  route: readonly PoolKey[],
  router?: string | null
): boolean {
  const r = swapRouterFor(chainId, router);
  if (!r) return false;
  if (r.venue === "tempo") return route.length === 0;
  return routeCurrencies(r, assetIn, assetOut, route) !== null;
}

const allowedPoolAbi = [
  { type: "function", name: "allowedPool", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "bool" }] },
] as const;
const liveCache = new Map<string, { at: number; live: Set<Hex> }>();
const LIVE_TTL_MS = 60_000;

/**
 * Which of the router's pools it allows right now, read from the chain (one
 * multicall, kept a minute). v1's list is fixed, so all of them. A failed read
 * keeps every listed pool but the queued ones: the router itself still refuses
 * one it doesn't allow, and a queued one shows only on the router's own word.
 */
export async function livePools(client: PublicClient, r: SwapRouter): Promise<(k: PoolKey) => boolean> {
  if (r.version === 1 || r.venue !== "v4") return () => true;
  const key = r.address.toLowerCase();
  const hit = liveCache.get(key);
  const ids = r.pools.map(poolId);
  const isLive = (live: Set<Hex>) => {
    const ok = r.pools.filter((_, i) => live.has(ids[i]!));
    return (k: PoolKey) => ok.some((p) => sameKey(p, k));
  };
  if (hit && Date.now() - hit.at < LIVE_TTL_MS) return isLive(hit.live);
  const res = await client
    .multicall({
      multicallAddress: RH_MULTICALL3,
      allowFailure: false,
      contracts: ids.map((id) => ({ address: r.address, abi: allowedPoolAbi, functionName: "allowedPool", args: [id] }) as const),
    })
    .catch(() => null);
  if (!res) return (k) => !RH_SWAP_POOLS_V2_QUEUED.some((q) => sameKey(q, k));
  const live = new Set(ids.filter((_, i) => res[i] === true));
  liveCache.set(key, { at: Date.now(), live });
  return isLive(live);
}

/**
 * The assets the picker offers now. A queued asset only once a pool of its is
 * live on the router (`live`, null while unread) and the vault takes deposits of
 * it (`openGated`, lowercase addresses, hooks/useOpenGatedTokens). Everything
 * else as it is: on chain it is the router and the vault that decide.
 */
export function offeredSwapAssets(
  assets: readonly Address[],
  r: SwapRouter | null,
  openGated: ReadonlySet<string>,
  live: ((k: PoolKey) => boolean) | null
): Address[] {
  const gated = r?.gated ?? RH_SWAP_ASSETS_V2_QUEUED;
  return assets.filter((a) => {
    if (!gated.some((q) => same(q, a))) return true;
    if (!r || !live || !openGated.has(a.toLowerCase())) return false;
    return r.pools.some((k) => holds(k, a) && live(k));
  });
}

// ---------------------------------------------------------------- quotes

const PATH_KEY_COMPONENTS = [
  { name: "intermediateCurrency", type: "address" },
  { name: "fee", type: "uint24" },
  { name: "tickSpacing", type: "int24" },
  { name: "hooks", type: "address" },
  { name: "hookData", type: "bytes" },
] as const;

const QUOTE_EXACT_PARAMS = [
  {
    name: "params",
    type: "tuple",
    components: [
      { name: "exactCurrency", type: "address" },
      { name: "path", type: "tuple[]", components: PATH_KEY_COMPONENTS },
      { name: "exactAmount", type: "uint128" },
    ],
  },
] as const;

/** Uniswap's V4Quoter, multi-hop: the same pools in the same order the router swaps them. */
const quoterAbi = [
  {
    type: "function",
    name: "quoteExactInput",
    stateMutability: "nonpayable",
    inputs: QUOTE_EXACT_PARAMS,
    outputs: [
      { name: "amountOut", type: "uint256" },
      { name: "gasEstimate", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "quoteExactOutput",
    stateMutability: "nonpayable",
    inputs: QUOTE_EXACT_PARAMS,
    outputs: [
      { name: "amountIn", type: "uint256" },
      { name: "gasEstimate", type: "uint256" },
    ],
  },
] as const;

const dexAbi = [
  {
    type: "function",
    name: "quoteSwapExactAmountIn",
    stateMutability: "view",
    inputs: [
      { name: "tokenIn", type: "address" },
      { name: "tokenOut", type: "address" },
      { name: "amountIn", type: "uint128" },
    ],
    outputs: [{ name: "amountOut", type: "uint128" }],
  },
  {
    type: "function",
    name: "quoteSwapExactAmountOut",
    stateMutability: "view",
    inputs: [
      { name: "tokenIn", type: "address" },
      { name: "tokenOut", type: "address" },
      { name: "amountOut", type: "uint128" },
    ],
    outputs: [{ name: "amountIn", type: "uint128" }],
  },
] as const;

/**
 * The quoter's params for a route. Exact input names the currency paid and,
 * per hop, the one it comes out in; exact output names the currency bought
 * and, per hop, the one it goes in with (V4Router's order).
 */
function quoteParams(route: readonly PoolKey[], path: readonly Address[], exactIn: boolean, amount: bigint) {
  const n = route.length;
  return {
    exactCurrency: exactIn ? path[0]! : path[n]!,
    path: route.map((k, i) => ({
      intermediateCurrency: exactIn ? path[i + 1]! : path[i]!,
      fee: k.fee,
      tickSpacing: k.tickSpacing,
      hooks: k.hooks,
      hookData: "0x" as Hex,
    })),
    exactAmount: amount,
  };
}

/** What each route's amount buys along it, all in one multicall. 0 where a route can't fill. */
async function v4ExactInAll(
  client: PublicClient,
  r: SwapRouter,
  routes: readonly PoolKey[][],
  assetIn: Address,
  assetOut: Address,
  amountIn: readonly bigint[]
): Promise<bigint[]> {
  const res = await client.multicall({
    multicallAddress: RH_MULTICALL3,
    allowFailure: true,
    contracts: routes.map(
      (route, i) =>
        ({
          address: r.quoter ?? RH_V4_QUOTER,
          abi: quoterAbi,
          functionName: "quoteExactInput",
          args: [quoteParams(route, routeCurrencies(r, assetIn, assetOut, route)!, true, amountIn[i]!)],
        }) as const
    ),
  });
  return res.map((x) => (x.status === "success" ? x.result[0] : 0n));
}

/** What buying exactly `amountOut` costs along `route`, hop by hop from the last, as the router does it. */
async function v4ExactOut(
  client: PublicClient,
  r: SwapRouter,
  route: readonly PoolKey[],
  assetIn: Address,
  assetOut: Address,
  amountOut: bigint
): Promise<bigint> {
  const { result } = await client.simulateContract({
    address: r.quoter ?? RH_V4_QUOTER,
    abi: quoterAbi,
    functionName: "quoteExactOutput",
    args: [quoteParams(route, routeCurrencies(r, assetIn, assetOut, route)!, false, amountOut)],
  });
  return result[0];
}

/**
 * The refund note a swap makes in advance, used only if someone sends the
 * note's unshield on its own (GloamVaultSwap): the amount less the vault's
 * highest possible cash-out fee (1%), so it is never more than arrives.
 *
 * With `feeBps`, for a router with an exit: the amount less the vault's fee now and
 * 0.1%, so a refund costs about what the swap would have. A raise of the fee waits out
 * a 3-day timelock; should a proof outlive that, the refund won't land and the app
 * offers the exit (escrowHolds).
 */
export function refundAmountFor(amount: bigint, feeBps?: number): bigint {
  if (feeBps === undefined) return amount - amount / 100n;
  return amount - vaultFeeOf(amount, feeBps) - amount / 1_000n;
}

/** One asset's deposit limits in the vault, and what it holds of it now. */
export type VaultRoom = { perDeposit: bigint; total: bigint; deposited: bigint };

/** The most one deposit of the asset can bring in right now: 0 when the vault doesn't take it or is full. */
export function depositRoom(v: VaultRoom): bigint {
  const left = v.total > v.deposited ? v.total - v.deposited : 0n;
  return v.perDeposit < left ? v.perDeposit : left;
}

/**
 * Whether a swap spending `amount` of a note could always land its refund note
 * (refundAmountFor) back in the vault: within the input asset's per-deposit
 * limit, and within its total once the note itself has left. A refund that
 * doesn't fit waits at the escrow until the limit is raised, so the app never
 * makes one: a larger note is split first.
 */
export function refundFits(v: VaultRoom, amount: bigint, feeBps?: number): boolean {
  const back = refundAmountFor(amount, feeBps);
  return back <= v.perDeposit && v.deposited - amount + back <= v.total;
}

/** The most of one note a single swap may spend so its refund note fits (refundFits). */
export function maxSwapInForRefund(v: VaultRoom, feeBps?: number): bigint {
  // what the refund keeps, in basis points, at its smallest: rounding lands within a few units of this
  const keeps = feeBps === undefined ? 9_900n : 9_990n - BigInt(feeBps);
  let a = (v.perDeposit * 10_000n) / keeps + 3n;
  while (a > 0n && refundAmountFor(a, feeBps) > v.perDeposit) a--;
  return a;
}

/** The vault's cash-out fee on `amount` (ShieldPoolCore._withdrawFee). */
export function vaultFeeOf(amount: bigint, feeBps: number): bigint {
  const bps = BigInt(feeBps);
  return (amount / 10_000n) * bps + ((amount % 10_000n) * bps) / 10_000n;
}

export type SwapPlan = {
  /** The router the plan is for: the route is checked against its pools. */
  router: Address;
  /** What arrives at the router: the note's value less the vault's cash-out fee. */
  available: bigint;
  /** What the new note will hold. */
  amountOut: bigint;
  /** What buying amountOut costs at the quote. Never above `available`. */
  cost: bigint;
  /** available - cost, at the quote: goes to the treasury. */
  leftover: bigint;
  route: PoolKey[];
  /**
   * How much worse this size trades than a hundredth of it on the same route,
   * in basis points (pool fees cancel out): the price impact. null when unknown.
   */
  impactBps?: number | null;
  /** Between two dollar stablecoins: how far the route's rate falls below a dollar for a dollar. */
  pegBps?: number | null;
};

/** Above this price impact the swap tab warns that a smaller amount gets a better rate. */
export const IMPACT_WARN_BPS = 100;
/**
 * On Base and Ethereum a quote past this impact is refused. Their stablecoin pools hold a
 * few hundred dollars at the market price and far more at any price: Base's EURC / USDC
 * pool fills $10,000 at 13 cents on the dollar, without reverting, so a warning is not enough.
 */
export const IMPACT_STOP_BPS = 200;
/** How far below a dollar for a dollar two dollar stablecoins may trade, in basis points, before the swap tab says so. */
export const PEG_WARN_BPS = 50;
/** And before the quote is refused: a pool this far off is drained or stale, or one of the two has lost its peg. */
export const PEG_STOP_BPS = 200;

/**
 * A swap against market prices, on the same chains. A euro pair has no peg to hold it
 * to, so the app weighs what goes in and what comes out at the marks it shows, fees
 * included. It warns, and past the stop it won't send: marks are off-chain, so this
 * lives in the swap tab alone, and no mark means no check.
 */
export const VALUE_WARN_BPS = 200;
export const VALUE_STOP_BPS = 400;

/** How much less `getUsd` is than `payUsd`, in basis points, never below 0. */
export function valueGapBps(payUsd: number, getUsd: number): number | null {
  if (!(payUsd > 0) || !(getUsd > 0)) return null;
  return Math.max(0, Math.round((1 - getUsd / payUsd) * 10_000));
}

const CHECKED_CHAINS: readonly number[] = [8453, 1];

/** Whether quotes on a chain are held to IMPACT_STOP_BPS and PEG_STOP_BPS. */
export function swapChecked(chainId: number): boolean {
  return CHECKED_CHAINS.includes(chainId);
}

const isDollar = (a?: Address) => Boolean(a) && DOLLARS.some((d) => same(d, a!));

/** How far `out` falls below a dollar for a dollar of `amountIn`, in basis points, never below 0. */
export function pegGapBps(amountIn: bigint, out: bigint): number {
  if (amountIn <= 0n) return 0;
  const bps = 10_000n - (out * 10_000n) / amountIn;
  return bps > 0n ? Number(bps) : 0;
}

/** Why a quote was refused, and about the most of the note that would pass. null: no size would. */
export class SwapQuoteRefused extends Error {
  constructor(
    message: string,
    readonly fitsIn: bigint | null = null
  ) {
    super(message);
    this.name = "SwapQuoteRefused";
  }
}

export const SWAP_TOO_THIN = "This pool is too thin for that amount.";
export const SWAP_OFF_PEG = "These two are too far apart right now. Nothing was swapped.";

/**
 * The best swap of a note worth `amountIn` of `assetIn` into `assetOut`: the
 * expected output at the best allowed route, less the buffer, checked by an
 * exact-output quote so it costs no more than what arrives.
 */
export type SwapAsk = {
  assetIn: Address;
  assetOut: Address;
  amountIn: bigint;
  feeBps: number;
  /** The router to plan for; the one new swaps use when left out. */
  router?: Address;
};

export async function planVaultSwap(client: PublicClient, chainId: number, p: SwapAsk): Promise<SwapPlan> {
  const r = swapRouterFor(chainId, p.router);
  if (!r) {
    const id = elysiumChainId();
    if ((id !== null && chainId === id) || chainId === ELYSIUM_TESTNET_CHAIN_ID) throw new Error("Private swaps are not on Elysium yet.");
    throw new Error("Private swaps are not live on this network yet.");
  }
  if (!isSwapAsset(chainId, p.assetIn, r.address) || !isSwapAsset(chainId, p.assetOut, r.address)) {
    throw new Error("There is no swap between these two yet.");
  }
  const available = p.amountIn - vaultFeeOf(p.amountIn, p.feeBps);
  if (available <= 0n) throw new Error("That amount is too small to swap.");
  const buffer = BigInt(swapBufferBps(chainId, p.assetIn, p.assetOut));

  if (chainId === 4217) {
    const expected = await client.readContract({
      address: TEMPO_STABLE_DEX,
      abi: dexAbi,
      functionName: "quoteSwapExactAmountIn",
      args: [p.assetIn, p.assetOut, available],
    });
    const amountOut = (expected * (10_000n - buffer)) / 10_000n;
    if (amountOut <= 0n) throw new Error("That amount is too small to swap.");
    const cost = await client.readContract({
      address: TEMPO_STABLE_DEX,
      abi: dexAbi,
      functionName: "quoteSwapExactAmountOut",
      args: [p.assetIn, p.assetOut, amountOut],
    });
    if (cost > available) throw new Error("The price is moving too fast. Try again in a moment.");
    return { router: r.address, available, amountOut, cost, leftover: available - cost, route: [] };
  }

  const routes = routesBetween(p.assetIn, p.assetOut, r, await livePools(client, r)).slice(0, MAX_QUOTED_ROUTES);
  if (!routes.length) throw new Error("There is no swap between these two yet.");
  // every route at the full size and at a hundredth of it, in one multicall
  const probe = available / 100n;
  const outs = await v4ExactInAll(client, r, [...routes, ...(probe > 0n ? routes : [])], p.assetIn, p.assetOut, [
    ...routes.map(() => available),
    ...(probe > 0n ? routes.map(() => probe) : []),
  ]);
  let best = 0;
  for (let i = 1; i < routes.length; i++) if (outs[i]! > outs[best]!) best = i;
  if (!(outs[best]! > 0n)) throw new Error("No pool can fill this swap right now. Try a smaller amount.");
  const route = routes[best]!;
  const amountOut = (outs[best]! * (10_000n - buffer)) / 10_000n;
  if (amountOut <= 0n) throw new Error("That amount is too small to swap.");
  const small = probe > 0n ? outs[routes.length + best]! : 0n;
  const impactBps = small > 0n ? priceImpactBps(available, outs[best]!, probe, small) : null;
  const pegBps = isDollar(p.assetIn) && isDollar(p.assetOut) ? pegGapBps(available, outs[best]!) : null;
  if (swapChecked(chainId)) {
    // thin first: a pool that ran out reads as off its peg too, and only this says what size fits
    if (impactBps !== null && impactBps > IMPACT_STOP_BPS) {
      const fits = await largestFair(client, r, route, p, available, probe, small);
      throw new SwapQuoteRefused(SWAP_TOO_THIN, fits > 0n ? noteFor(fits, p.feeBps) : null);
    }
    if (pegBps !== null && pegBps > PEG_STOP_BPS) throw new SwapQuoteRefused(SWAP_OFF_PEG);
  }
  // the buffer asks for less than the pool quoted, so one that can't fill even that moved since
  const cost = await v4ExactOut(client, r, route, p.assetIn, p.assetOut, amountOut).catch(() => available + 1n);
  if (cost > available) throw new Error("The price is moving too fast. Try again in a moment.");
  return { router: r.address, available, amountOut, cost, leftover: available - cost, route, impactBps, pegBps };
}

/** The note that brings in about `arrives` after the vault's fee. */
export function noteFor(arrives: bigint, feeBps: number): bigint {
  return (arrives * 10_000n) / (10_000n - BigInt(feeBps));
}

/** The largest of a few halvings of `available` that `route` fills within IMPACT_WARN_BPS. 0 when none does. */
async function largestFair(
  client: PublicClient,
  r: SwapRouter,
  route: PoolKey[],
  p: SwapAsk,
  available: bigint,
  probe: bigint,
  small: bigint
): Promise<bigint> {
  const sizes = [2n, 4n, 8n, 16n, 32n, 64n].map((d) => available / d).filter((a) => a > probe);
  if (!sizes.length) return 0n;
  const outs = await v4ExactInAll(client, r, sizes.map(() => route), p.assetIn, p.assetOut, sizes);
  const i = sizes.findIndex((a, j) => outs[j]! > 0n && priceImpactBps(a, outs[j]!, probe, small) <= IMPACT_WARN_BPS);
  return i < 0 ? 0n : sizes[i]!;
}

/**
 * SDK only (swapIntent's impact stop on every chain): about the largest note on `route`
 * whose price impact stays within IMPACT_WARN_BPS, from a few halvings of what arrives,
 * in one multicall. 0 when none does.
 */
export async function largestFairNote(client: PublicClient, r: SwapRouter, route: PoolKey[], p: SwapAsk, available: bigint): Promise<bigint> {
  if (r.venue !== "v4" || !route.length) return 0n;
  const probe = available / 100n;
  if (probe <= 0n) return 0n;
  const sizes = [2n, 4n, 8n, 16n, 32n, 64n].map((d) => available / d).filter((a) => a > probe);
  if (!sizes.length) return 0n;
  const outs = await v4ExactInAll(client, r, [route, ...sizes.map(() => route)], p.assetIn, p.assetOut, [probe, ...sizes]);
  const small = outs[0]!;
  if (small <= 0n) return 0n;
  const i = sizes.findIndex((a, j) => outs[j + 1]! > 0n && priceImpactBps(a, outs[j + 1]!, probe, small) <= IMPACT_WARN_BPS);
  return i < 0 ? 0n : noteFor(sizes[i]!, p.feeBps);
}

/** 1 - (out / in) / (smallOut / smallIn), in basis points, never below 0. */
export function priceImpactBps(amountIn: bigint, out: bigint, smallIn: bigint, smallOut: bigint): number {
  if (amountIn <= 0n || smallIn <= 0n || smallOut <= 0n) return 0;
  const bps = 10_000n - (out * smallIn * 10_000n) / (smallOut * amountIn);
  return bps > 0n ? Number(bps) : 0;
}

/** How often a quote on screen is asked again. One older than two of these stops showing. */
export const QUOTE_TTL_MS = 15_000;

/** Whether a quote made at `at` may still show at `now`. */
export function quoteFresh(at: number, now: number): boolean {
  return now - at < 2 * QUOTE_TTL_MS;
}

/**
 * The plan to send: priced again right before the swap, and used only if it
 * gives more than the quote the person saw. The router buys exactly amountOut
 * and the rest goes to the treasury, so a price that moved their way since the
 * quote now goes to them. One that moved against them keeps what they agreed
 * to (the router refuses it if the buffer no longer covers it), and a failed
 * read keeps the quote.
 */
export async function replanVaultSwap(
  client: PublicClient,
  chainId: number,
  p: SwapAsk,
  quoted: SwapPlan
): Promise<SwapPlan> {
  const fresh = await planVaultSwap(client, chainId, { ...p, router: quoted.router }).catch(() => null);
  return fresh && fresh.amountOut > quoted.amountOut ? fresh : quoted;
}

// ---------------------------------------------------------------- the relay's floor (app/src/lib/relay/swapFloor.ts)

/**
 * The smallest private swap on a chain where gas is dear. The relay pays a swap's gas
 * (about 1.7M on Ethereum) and the vault's cash-out fee is all that surely comes back,
 * so below this floor the relay does not send a swap (code swap_small). Nothing is
 * charged for it. A swap sent from your own wallet has no floor.
 */
export const ETH_USD_FEED: Readonly<Record<number, Address>> = {
  1: "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419",
};

export const ethUsdFeedAbi = [
  {
    type: "function",
    name: "latestRoundData",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "roundId", type: "uint80" },
      { name: "answer", type: "int256" },
      { name: "startedAt", type: "uint256" },
      { name: "updatedAt", type: "uint256" },
      { name: "answeredInRound", type: "uint80" },
    ],
  },
] as const;

/** The feed updates at least hourly. Older than this, the relay won't price a swap with it. */
export const FEED_MAX_AGE_SEC = 2 * 3600;

/** Whether a relayed swap on this chain has to pay for its own gas. */
export function hasSwapFloor(chainId: number): boolean {
  return ETH_USD_FEED[chainId] !== undefined;
}

const SWAP_GAS_FIRST_HOP = 1_700_000n;
const SWAP_GAS_NEXT_HOP = 60_000n;

/** Gas one swap costs the relay, by hops. */
export function swapGasUnits(hops: number): bigint {
  return SWAP_GAS_FIRST_HOP + SWAP_GAS_NEXT_HOP * BigInt(Math.max(0, hops - 1));
}

/** The private send that sets part of a note aside before a swap. */
export const SPLIT_GAS_UNITS = 1_800_000n;

/** What a swap's vault fee is weighed against: the swap, and the split when there is one. */
export function swapFloorGas(hops: number, split: boolean): bigint {
  return swapGasUnits(hops) + (split ? SPLIT_GAS_UNITS : 0n);
}

/** The smallest swap, in dollars, whose vault fee covers its gas. Infinity while the vault takes no fee. */
export function smallestSwapUsd(p: { gasPriceWei: bigint; ethUsd: number; feeBps: number; hops: number }): number {
  if (p.feeBps <= 0) return Number.POSITIVE_INFINITY;
  const gasUsd = (Number(swapGasUnits(p.hops) * p.gasPriceWei) / 1e18) * p.ethUsd;
  return (gasUsd * 10_000) / p.feeBps;
}

/** A little above the relay's floor, as the app asks, so gas that moves a few percent while a swap is proved doesn't turn it away. */
export function swapFloorShown(usd: number): number {
  return usd * 1.1;
}
