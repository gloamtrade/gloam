import { defineChain, zeroAddress, type Address, type Chain } from "viem";
import { base, baseSepolia, mainnet as ethereum, sepolia } from "viem/chains";
import { baseSepoliaPool, ethereumSepoliaPayMemo, ethereumSepoliaPool, mainnetPoolFor, type MainnetChainId } from "./mainnet.js";
import type { HistoryRpc } from "./rpc.js";
import {
  ELYSIUM_NATIVE_CURRENCY,
  ELYSIUM_TESTNET_CHAIN_ID,
  elysiumChainId,
  elysiumMainnetConfig,
  elysiumTestnetConfig,
  type ElysiumMainnet,
  type ElysiumTestnet,
} from "./elysium.js";

/** Native ETH is represented as the zero address across the vault. */
export const NATIVE_ASSET: Address = zeroAddress;

/** BN254 scalar field modulus. */
export const FIELD_PRIME =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

/** Robinhood Chain. */
export const RH_TESTNET_CHAIN_ID = 46630;
export const RH_MAINNET_CHAIN_ID = 4663;

/** Tempo Moderato testnet. Payments-first stablecoin L1; native is USD and it
 *  blocks native msg.value, so shields there are ERC-20-only (PathUSD, 6-dec). */
export const TEMPO_TESTNET_CHAIN_ID = 42431;
/** Tempo mainnet. */
export const TEMPO_MAINNET_CHAIN_ID = 4217;

/** Base mainnet (an OP Stack L2, gas in ETH). */
export const BASE_MAINNET_CHAIN_ID = 8453;
/** Base Sepolia: Base's testnet, on the mainnet pool and keys. */
export const BASE_SEPOLIA_CHAIN_ID = 84532;

/** Ethereum mainnet. */
export const ETHEREUM_MAINNET_CHAIN_ID = 1;
/** Ethereum Sepolia: Ethereum's testnet, on the mainnet pool and keys. */
export const ETHEREUM_SEPOLIA_CHAIN_ID = 11155111;

/** Contracts of record (RH testnet 46630). */
// No-middlemen Poseidon pool (shieldVerifier enforced, no emergencyWithdraw,
// admin changes behind a public 3-day timelock). Redeployed 2026-09-29;
// supersedes 0xAc25c3C4A880194324d1fC78722694e0F315aF1c and 0xaEbB…1834.
// NEVER the drainable pre-C1 pool 0x4F38…12D8F (audit H-P1).
export const SEALED_VAULT: Address =
  "0x72406D9597807A46f730d8b4fDBC5aC45Dc1d740";
export const SEALED_VAULT_DEPLOY_BLOCK = 126_185_021n;
export const GLOAM_PAY_MEMO: Address =
  "0x689ebd9d30E0235c73fd8f10236F850CDB3c5DCE";
/** ShieldIVerifier adapter — set as the pool's shieldVerifier; shield() reverts,
 *  deposits must go through shieldBound() with a proof. */
export const SHIELD_VERIFIER: Address =
  "0x28E6d0D02568EE634f9596645775275DE76b2847";

/** No-middlemen Poseidon pool on Tempo Moderato (42431). Redeployed 2026-09-29,
 *  reuses the same verifiers + Poseidon2 as Robinhood, so the same circuits and
 *  proving path work unchanged — only the pool address and chain id differ. */
export const TEMPO_SEALED_VAULT: Address =
  "0x841DC046Ea3CC842BA3A855731472c6Eb0F2d5eb";
export const TEMPO_SEALED_VAULT_DEPLOY_BLOCK = 37_411_195n;
/** Encrypted payment-message board on Base Sepolia (84532), deployed after the pool; the event has no poster address. */
export const BASE_SEPOLIA_PAY_MEMO: Address =
  "0x01B3172d9900Cb26d57E986429b9b23854c74598";
/** Encrypted payment-message board on Tempo (event has no poster address). */
export const TEMPO_PAY_MEMO: Address =
  "0x3ca88712e9219b5EE4c82D31cAfEaB64C9E9b4E3";
/** Paxos Global Dollar (USDG) on Robinhood Chain testnet, 6 decimals. */
export const RH_USDG: Address =
  "0x7E955252E15c84f5768B83c41a71F9eba181802F";
/** OpenUSD (OUSD), Tempo's recommended stablecoin; 6 decimals, same address on mainnet and Moderato. */
export const TEMPO_OUSD: Address =
  "0x20c0000000000000000000006a37da5c996874be";
/** PathUSD, the primary 6-decimal shieldable stablecoin on Tempo; same address on mainnet and Moderato. */
export const TEMPO_PATHUSD: Address =
  "0x20c0000000000000000000000000000000000000";

// ── Mainnet ───────────────────────────────────────────────────────────────────
// Pool addresses and deploy blocks come from MAINNET_POOLS (src/mainnet.ts),
// the only place they are written. Everything below is known ahead of deploy.

/** Paxos Global Dollar (USDG) on Robinhood Chain mainnet, 6 decimals. */
export const RH_MAINNET_USDG: Address =
  "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
/** $GLOAM on Robinhood Chain mainnet, 18 decimals. */
export const GLOAM_TOKEN: Address =
  "0xDcD885F5c60b3aD49F6D58718696417314e8724d";
/**
 * $GRIFT, San Verano's token, on Robinhood Chain mainnet, 18 decimals. A plain
 * OpenZeppelin ERC-20 from the Pons v2 launcher (Sourcify exact match): no
 * transfer fee, no rebasing. 0 on the vault until its limit lands through the
 * timelock (contracts/script/NoDepositLimits.s.sol).
 */
export const RH_MAINNET_GRIFT: Address =
  "0x9f4BA41F91a59A34e17eE8C9EB3A51363B11aBD5";
/**
 * $PONS on Robinhood Chain mainnet, 18 decimals. A plain ERC-20 from its own
 * launcher (Sourcify match): fixed supply, no owner, no transfer fee, no rebasing;
 * its launch limits ended at block 25,526,532.
 */
export const RH_MAINNET_PONS: Address =
  "0x39dBED3a2bd333467115dE45665cC57F813C4571";
/** $CASHCAT on Robinhood Chain mainnet, 18 decimals. A plain ERC-20 of the same kind as PONS (Sourcify match). */
export const RH_MAINNET_CASHCAT: Address =
  "0x020bfC650A365f8BB26819deAAbF3E21291018b4";
/**
 * Artificial Inu ($AI) on Robinhood Chain mainnet, 18 decimals: an immutable
 * clone of Doppler's DopplerERC20V1 (Sourcify match on the implementation),
 * no mint, no transfer fee, no rebasing. Its owner is Doppler's Airlock, which
 * can only hand it on to 0xdead, so lockPool can't run again. 0 on the vault
 * until its limit lands through the timelock.
 */
export const RH_MAINNET_AI: Address =
  "0x2E8c31162b855A2ffa90F6F8634643Ad6F111e18";
/**
 * Orbio.so ($ORBIO) on Robinhood Chain mainnet, 18 decimals. A plain ERC-20 from
 * the Pons v2 launcher (Sourcify exact match): no owner, no transfer fee, no
 * rebasing. 0 on the vault until its limit lands through the timelock.
 */
export const RH_MAINNET_ORBIO: Address =
  "0xAa07A0e9209e16aC99708C3EC70159c6eF3128A3";
/** Bridged USDC (USDC.e) on Tempo mainnet, TIP-20, 6 decimals. */
export const TEMPO_USDCE: Address =
  "0x20c000000000000000000000b9537d11c60e8b50";
/** USDT0 on Tempo mainnet, TIP-20, 6 decimals. */
export const TEMPO_USDT0: Address =
  "0x20c00000000000000000000014f22ca97301eb73";

/** Circle's USDC on Base mainnet, 6 decimals. */
export const BASE_USDC: Address =
  "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
/** Circle's EURC on Base mainnet, 6 decimals. */
export const BASE_EURC: Address =
  "0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42";
/** USDT on Base mainnet: Tether bridged from Ethereum over Base's standard bridge, 6 decimals. */
export const BASE_USDT: Address =
  "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2";
/**
 * Beldex's BDX on Base mainnet: a LayerZero OFT, 9 decimals, the same contract
 * and address as on Ethereum (ETHEREUM_BDX). A plain ERC-20 (no transfer fee, no
 * rebasing); Beldex's owner can mint and pause mint and burn, never transfers.
 */
export const BASE_BDX: Address =
  "0x6ad12E761b438beA3EA09F6C6266556Bb24C2181";
/** Circle's test USDC on Base Sepolia, 6 decimals (faucet.circle.com). */
export const BASE_SEPOLIA_USDC: Address =
  "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
/** Circle's test EURC on Base Sepolia, 6 decimals (faucet.circle.com). */
export const BASE_SEPOLIA_EURC: Address =
  "0x808456652fdb597867f38412077A9182bf77359F";

/** Circle's USDC on Ethereum, 6 decimals. */
export const ETHEREUM_USDC: Address =
  "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
/**
 * Tether's USDT on Ethereum, 6 decimals. Its approve() and transfer() return
 * nothing, and approve() refuses to change one non-zero allowance into another:
 * see approvalSteps.
 */
export const ETHEREUM_USDT: Address =
  "0xdAC17F958D2ee523a2206206994597C13D831ec7";
/** Paxos Global Dollar (USDG) on Ethereum, 6 decimals. */
export const ETHEREUM_USDG: Address =
  "0xe343167631d89B6Ffc58B88d6b7fB0228795491D";
/** PayPal USD (PYUSD, issued by Paxos) on Ethereum, 6 decimals. */
export const ETHEREUM_PYUSD: Address =
  "0x6c3ea9036406852006290770BEdFcAbA0e23A0e8";
/** Circle's EURC on Ethereum, 6 decimals. A euro stablecoin, never a dollar. */
export const ETHEREUM_EURC: Address =
  "0x1aBaEA1f7C830bD89Acc67eC4af516284b1bC33c";
/** Beldex's BDX on Ethereum: the same LayerZero OFT and address as on Base (BASE_BDX), 9 decimals. */
export const ETHEREUM_BDX: Address = BASE_BDX;
/** Circle's test USDC on Ethereum Sepolia, 6 decimals (faucet.circle.com). */
export const ETHEREUM_SEPOLIA_USDC: Address =
  "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";
/** Paxos's test USDG on Ethereum Sepolia, 6 decimals (faucet.paxos.com). */
export const ETHEREUM_SEPOLIA_USDG: Address =
  "0xfBb2A78CceEb415b00300925e464C3E44E6e06b0";
/** Paxos's test PYUSD on Ethereum Sepolia, 6 decimals (faucet.paxos.com). */
export const ETHEREUM_SEPOLIA_PYUSD: Address =
  "0xCaC524BcA292aaade2DF8A05cC58F0a65B1B3bB9";
/** Circle's test EURC on Ethereum Sepolia, 6 decimals (faucet.circle.com). A euro stablecoin. */
export const ETHEREUM_SEPOLIA_EURC: Address =
  "0x08210F9170F89Ab7658F0B5E3fF39b0E03C594D4";

/** PoseidonT3 (circomlib, 2 inputs) the mainnet pools hash with, same address on every mainnet. */
export const MAINNET_POSEIDON_T3: Address =
  "0x1a32C2c2A77225EC2dD3BF7be1018819b1039Cb4";

/**
 * Cash-out fee on the mainnet pools: 0.5% (50 basis points) of the amount
 * unshielded, kept by the pool. It was 0.25% until 3 November 2026. Base Sepolia
 * and Ethereum Sepolia still charge 0.25%. Direct deposits and private payments
 * are free. The pool takes the fee when a cash out lands, at the rate that day,
 * and the owner can change it through the timelock, so a value that matters
 * comes from the pool: readCashOutFeeBps (lib fee).
 */
export const CASH_OUT_FEE_BPS = 50;

/**
 * What the pool keeps from a cash out of `amount` base units, rounded down the
 * same way the contract does (the recipient gets amount - fee).
 */
export function cashOutFee(amount: bigint, bps: number = CASH_OUT_FEE_BPS): bigint {
  if (amount < 0n) throw new Error("amount must not be negative");
  if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) throw new Error("bps must be an integer from 0 to 10000");
  const b = BigInt(bps);
  return (amount / 10_000n) * b + ((amount % 10_000n) * b) / 10_000n;
}

/**
 * Which trusted-setup keys a network's verifiers hold. The Robinhood Chain and
 * Tempo testnets use the single-party dev keys. Every mainnet, Base Sepolia and
 * Ethereum Sepolia (which run the mainnet pool) use the final keys of the 13-contributor ceremony
 * (drand round 6561386, release ceremony-final). A proof made with one set never
 * verifies against the other.
 */
export type CeremonyKind = "dev" | "production";

/**
 * Deposit limit for one asset, in its base units, as it was at launch.
 * The vault's owner changes limits through its timelock: read the current ones
 * with readDepositLimit (lib limits). The live read wins, and a live value of
 * type(uint128).max means no limit (isNoLimit).
 */
export interface DepositLimit {
  perDeposit: bigint;
  total: bigint;
}

/** An asset a Gloam pool takes. */
export interface GloamAsset {
  symbol: string;
  /** Token address; the zero address (NATIVE_ASSET) for the chain's native coin. */
  address: Address;
  decimals: number;
  /** Deposit limit on the payments pools (mainnet, Base Sepolia); null where none is set (the older testnets). */
  depositLimit: DepositLimit | null;
}

export type GloamNetworkKey =
  | "robinhood"
  | "tempo"
  | "base"
  | "ethereum"
  | "robinhood-mainnet"
  | "tempo-mainnet"
  | "base-mainnet"
  | "ethereum-mainnet"
  | "elysium-mainnet"
  | "elysium";

/** The chain a network runs on, testnet or mainnet. Elysium's testnet is "elysium", its mainnet "elysium-mainnet". */
export type GloamChainFamily = "robinhood" | "tempo" | "base" | "ethereum" | "elysium";

/** Robinhood Chain mainnet (4663). */
export const RH_MAINNET_CHAIN: Chain = defineChain({
  id: RH_MAINNET_CHAIN_ID,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.mainnet.chain.robinhood.com"] } },
  blockExplorers: { default: { name: "RobinScan", url: "https://robin.etherscan.io" } },
  contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
});

/** Robinhood Chain testnet (46630). */
export const RH_TESTNET_CHAIN: Chain = defineChain({
  id: RH_TESTNET_CHAIN_ID,
  name: "Robinhood Chain Testnet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.testnet.chain.robinhood.com"] } },
  blockExplorers: { default: { name: "Robinhood Testnet Explorer", url: "https://explorer.testnet.chain.robinhood.com" } },
  contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
  testnet: true,
});

/**
 * Tempo mainnet (4217). No gas coin: fees are paid in USD stablecoins. The
 * native currency keeps 18 decimals because wallets refuse to add a chain
 * otherwise; Gloam never moves it.
 */
export const TEMPO_MAINNET_CHAIN: Chain = defineChain({
  id: TEMPO_MAINNET_CHAIN_ID,
  name: "Tempo",
  nativeCurrency: { name: "US Dollar", symbol: "USD", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.tempo.xyz"] } },
  blockExplorers: { default: { name: "Tempo Explorer", url: "https://explore.tempo.xyz" } },
  contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
});

/** Tempo Moderato testnet (42431). */
export const TEMPO_TESTNET_CHAIN: Chain = defineChain({
  id: TEMPO_TESTNET_CHAIN_ID,
  name: "Tempo Testnet (Moderato)",
  nativeCurrency: { name: "US Dollar", symbol: "USD", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.moderato.tempo.xyz"] } },
  blockExplorers: { default: { name: "Tempo Testnet Explorer", url: "https://explore.testnet.tempo.xyz" } },
  contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
  testnet: true,
});

/**
 * Base mainnet (8453), from viem's definition (OP Stack fees and formatters).
 * The default RPC is publicnode's: Base's own public RPC refuses eth_getLogs,
 * and rebuilding the pool tree needs it (publicnode takes 50,000-block ranges).
 */
export const BASE_MAINNET_CHAIN: Chain = defineChain({
  ...base,
  rpcUrls: { default: { http: ["https://base-rpc.publicnode.com", "https://mainnet.base.org"] } },
});

/** Base Sepolia (84532). Same RPC choice as Base mainnet: sepolia.base.org caps eth_getLogs at 200 blocks. */
export const BASE_SEPOLIA_CHAIN: Chain = defineChain({
  ...baseSepolia,
  rpcUrls: { default: { http: ["https://base-sepolia-rpc.publicnode.com", "https://sepolia.base.org"] } },
});

/**
 * Ethereum mainnet (1), from viem's definition. The default RPC is MEV Blocker's:
 * it keeps old state and answers eth_getLogs over 10,000 blocks (any range under
 * 10,000 logs), which rebuilding the pool tree needs. publicnode, second, serves
 * only the last 10,000 blocks of logs and 128 blocks of state.
 */
export const ETHEREUM_MAINNET_CHAIN: Chain = defineChain({
  ...ethereum,
  rpcUrls: { default: { http: ["https://rpc.mevblocker.io", "https://ethereum-rpc.publicnode.com"] } },
});

/**
 * Ethereum Sepolia (11155111), from viem's definition. The default RPC is
 * publicnode's: it is at the chain head, so receipts and fresh state show up
 * within seconds, but it keeps only about the last 10,000 blocks of logs,
 * receipts and state. Older reads (rebuilding the pool tree from its deploy
 * block) go to Tenderly's public gateway, ETHEREUM_SEPOLIA_HISTORY_RPC, which
 * keeps everything but trails the head by up to a few minutes. Read through
 * gloamReadTransport(network) to get both. Checked 2026-10-25.
 */
export const ETHEREUM_SEPOLIA_CHAIN: Chain = defineChain({
  ...sepolia,
  name: "Ethereum Sepolia",
  rpcUrls: { default: { http: ["https://ethereum-sepolia-rpc.publicnode.com", "https://sepolia.gateway.tenderly.co"] } },
});

/**
 * Ethereum Sepolia's history RPC: logs, receipts and state older than 9,000
 * blocks (about 30 hours), under the roughly 10,000 that publicnode keeps.
 */
export const ETHEREUM_SEPOLIA_HISTORY_RPC: HistoryRpc = {
  url: "https://sepolia.gateway.tenderly.co",
  recentBlocks: 9_000n,
};

const units = (whole: bigint, decimals: number) => whole * 10n ** BigInt(decimals);
/**
 * Each stablecoin's limit on the four mainnet vaults, as read on chain on
 * 2026-11-02 (depositLimit on 0x39E2…0194): 50,000 per deposit and 2,500,000 in
 * total. The limits change through the vault's timelock (a change to no limit
 * is queued for every asset), so readDepositLimit reads the live value.
 */
const stableLimit: DepositLimit = { perDeposit: units(50_000n, 6), total: units(2_500_000n, 6) };
/** Each stablecoin's limit on the Sepolia vaults: the launch value, still live there. */
const sepoliaStableLimit: DepositLimit = { perDeposit: units(500n, 6), total: units(25_000n, 6) };

/**
 * Robinhood Chain mainnet pool assets and their deposit limits. USDG,
 * GLOAM, PONS and CASHCAT are the limits read on chain on 2026-11-02. GRIFT
 * opens with no limit once its timelocked change lands; 0 on chain until then,
 * so the vault refuses it and assertDepositWithinLiveLimit says so.
 *
 * ETH, AI and ORBIO are the same: about $25,000 per deposit and $250,000 in total
 * at the prices of 2026-10-31, queued through contracts/script/
 * QueueRobinhoodAssets.s.sol (ready on 2026-11-03), 0 on chain until each lands.
 * In every case the live read wins.
 */
export const RH_MAINNET_ASSETS: GloamAsset[] = [
  { symbol: "USDG", address: RH_MAINNET_USDG, decimals: 6, depositLimit: stableLimit },
  { symbol: "GLOAM", address: GLOAM_TOKEN, decimals: 18, depositLimit: { perDeposit: units(2_500_000n, 18), total: units(25_000_000n, 18) } },
  { symbol: "GRIFT", address: RH_MAINNET_GRIFT, decimals: 18, depositLimit: { perDeposit: (1n << 128n) - 1n, total: (1n << 128n) - 1n } },
  { symbol: "ETH", address: NATIVE_ASSET, decimals: 18, depositLimit: { perDeposit: units(11n, 18), total: units(110n, 18) } },
  { symbol: "PONS", address: RH_MAINNET_PONS, decimals: 18, depositLimit: { perDeposit: units(390_000n, 18), total: units(9_800_000n, 18) } },
  { symbol: "CASHCAT", address: RH_MAINNET_CASHCAT, decimals: 18, depositLimit: { perDeposit: units(960_000n, 18), total: units(24_000_000n, 18) } },
  { symbol: "AI", address: RH_MAINNET_AI, decimals: 18, depositLimit: { perDeposit: units(400_000n, 18), total: units(4_000_000n, 18) } },
  { symbol: "ORBIO", address: RH_MAINNET_ORBIO, decimals: 18, depositLimit: { perDeposit: units(1_000_000n, 18), total: units(10_000_000n, 18) } },
];

/** Tempo mainnet pool assets (TIP-20, 6 decimals) and their deposit limits. */
export const TEMPO_MAINNET_ASSETS: GloamAsset[] = [
  { symbol: "USDC.e", address: TEMPO_USDCE, decimals: 6, depositLimit: stableLimit },
  { symbol: "pathUSD", address: TEMPO_PATHUSD, decimals: 6, depositLimit: stableLimit },
  { symbol: "USDT0", address: TEMPO_USDT0, decimals: 6, depositLimit: stableLimit },
  { symbol: "OUSD", address: TEMPO_OUSD, decimals: 6, depositLimit: stableLimit },
];

/**
 * Native ETH on the Base and Ethereum mainnet vaults, as read on chain on
 * 2026-11-02: 20 per deposit and 1,000 in total. readDepositLimit reads it live.
 */
const baseEthLimit: DepositLimit = { perDeposit: units(20n, 18), total: units(1_000n, 18) };
/** Native ETH on the Sepolia vaults: the launch value, still live there. */
const sepoliaEthLimit: DepositLimit = { perDeposit: 2n * 10n ** 17n, total: units(10n, 18) };

/**
 * BDX on Base and Ethereum: no limit once its timelocked change lands (queued
 * 2026-10-30 through contracts/script/NoDepositLimits.s.sol, ready from
 * 2026-11-02). It reads 0 on chain until then, so the vault refuses BDX
 * deposits before it runs: assertDepositWithinLiveLimit reads the live value
 * and says so.
 */
const bdxLimit: DepositLimit = { perDeposit: (1n << 128n) - 1n, total: (1n << 128n) - 1n };

/** Base mainnet pool assets and their deposit limits. Native ETH is listed, then BDX. */
export const BASE_MAINNET_ASSETS: GloamAsset[] = [
  { symbol: "USDC", address: BASE_USDC, decimals: 6, depositLimit: stableLimit },
  { symbol: "EURC", address: BASE_EURC, decimals: 6, depositLimit: stableLimit },
  { symbol: "USDT", address: BASE_USDT, decimals: 6, depositLimit: stableLimit },
  { symbol: "ETH", address: NATIVE_ASSET, decimals: 18, depositLimit: baseEthLimit },
  { symbol: "BDX", address: BASE_BDX, decimals: 9, depositLimit: bdxLimit },
];

/** Ethereum mainnet pool assets and their deposit limits: five stablecoins, ETH with Base's limit, then BDX. */
export const ETHEREUM_MAINNET_ASSETS: GloamAsset[] = [
  { symbol: "USDC", address: ETHEREUM_USDC, decimals: 6, depositLimit: stableLimit },
  { symbol: "USDT", address: ETHEREUM_USDT, decimals: 6, depositLimit: stableLimit },
  { symbol: "USDG", address: ETHEREUM_USDG, decimals: 6, depositLimit: stableLimit },
  { symbol: "PYUSD", address: ETHEREUM_PYUSD, decimals: 6, depositLimit: stableLimit },
  { symbol: "EURC", address: ETHEREUM_EURC, decimals: 6, depositLimit: stableLimit },
  { symbol: "ETH", address: NATIVE_ASSET, decimals: 18, depositLimit: baseEthLimit },
  { symbol: "BDX", address: ETHEREUM_BDX, decimals: 9, depositLimit: bdxLimit },
];

/**
 * Elysium mainnet (Kinetiq's Hyperliquid L2, an Arbitrum Orbit chain, gas in
 * HYPE), from the values in src/elysium.ts, or null until they are all in.
 */
export function elysiumMainnetChain(cfg: ElysiumMainnet | null = elysiumMainnetConfig()): Chain | null {
  if (!cfg) return null;
  return defineChain({
    id: cfg.chainId,
    name: "Elysium",
    nativeCurrency: ELYSIUM_NATIVE_CURRENCY,
    rpcUrls: { default: { http: [cfg.rpcUrl] } },
    blockExplorers: { default: { name: "Elysium Explorer", url: cfg.explorerUrl } },
  });
}

/**
 * Elysium mainnet pool assets: USDC only at launch, with the launch limits every
 * mainnet started on (500 per deposit, 25,000 in total), in USDC's own decimals.
 * HYPE is not listed. readDepositLimit reads the live value.
 */
export function elysiumMainnetAssets(cfg: ElysiumMainnet | null = elysiumMainnetConfig()): GloamAsset[] {
  if (!cfg) return [];
  return [{ symbol: "USDC", address: cfg.usdc, decimals: cfg.usdcDecimals, depositLimit: { perDeposit: units(500n, cfg.usdcDecimals), total: units(25_000n, cfg.usdcDecimals) } }];
}

/**
 * Elysium testnet (99801), from ELYSIUM_TESTNET in src/elysium.ts, or null until
 * its pool is in. Gas in HYPE, like mainnet.
 */
export function elysiumTestnetChain(cfg: ElysiumTestnet | null = elysiumTestnetConfig()): Chain | null {
  if (!cfg) return null;
  return defineChain({
    id: cfg.chainId,
    name: "Elysium Testnet",
    nativeCurrency: ELYSIUM_NATIVE_CURRENCY,
    rpcUrls: { default: { http: [cfg.rpcUrl] } },
    blockExplorers: { default: { name: "Elysium Testnet Explorer", url: cfg.explorerUrl } },
    testnet: true,
  });
}

/** Elysium testnet pool assets: test USDC only, at Base Sepolia's testnet limits (500 per deposit, 25,000 in total). HYPE is not listed. */
export function elysiumTestnetAssets(cfg: ElysiumTestnet | null = elysiumTestnetConfig()): GloamAsset[] {
  if (!cfg) return [];
  return [{ symbol: "USDC", address: cfg.usdc, decimals: cfg.usdcDecimals, depositLimit: { perDeposit: units(500n, cfg.usdcDecimals), total: units(25_000n, cfg.usdcDecimals) } }];
}

/** Base Sepolia pool assets: Circle's test USDC and EURC (500 / 25,000 each), and ETH (0.2 / 10). No USDT there. */
export const BASE_SEPOLIA_ASSETS: GloamAsset[] = [
  { symbol: "USDC", address: BASE_SEPOLIA_USDC, decimals: 6, depositLimit: sepoliaStableLimit },
  { symbol: "EURC", address: BASE_SEPOLIA_EURC, decimals: 6, depositLimit: sepoliaStableLimit },
  { symbol: "ETH", address: NATIVE_ASSET, decimals: 18, depositLimit: sepoliaEthLimit },
];

/**
 * Ethereum Sepolia pool assets: Circle's test USDC and EURC, Paxos's test USDG
 * and PYUSD, and ETH, with the same limits as Base Sepolia. No USDT there.
 */
export const ETHEREUM_SEPOLIA_ASSETS: GloamAsset[] = [
  { symbol: "USDC", address: ETHEREUM_SEPOLIA_USDC, decimals: 6, depositLimit: sepoliaStableLimit },
  { symbol: "USDG", address: ETHEREUM_SEPOLIA_USDG, decimals: 6, depositLimit: sepoliaStableLimit },
  { symbol: "PYUSD", address: ETHEREUM_SEPOLIA_PYUSD, decimals: 6, depositLimit: sepoliaStableLimit },
  { symbol: "EURC", address: ETHEREUM_SEPOLIA_EURC, decimals: 6, depositLimit: sepoliaStableLimit },
  { symbol: "ETH", address: NATIVE_ASSET, decimals: 18, depositLimit: sepoliaEthLimit },
];

/**
 * The networks Gloam's private core runs on. Robinhood Chain, Tempo, Base and
 * Ethereum are separate deployments of the same shielded-pool design (not a
 * bridge, not one cross-chain pool), each with a mainnet and a testnet. An
 * app or agent picks one and points the builders at that network's pool and
 * chain id.
 */
export interface GloamNetwork {
  key: GloamNetworkKey;
  /** The chain's name, the same for its mainnet and testnet ("Robinhood Chain", "Tempo", "Base", "Ethereum"). */
  label: string;
  chainId: number;
  /** Shielded pool address. */
  pool: Address;
  /** Block the pool was deployed at (start of tree scans). */
  deployBlock: bigint;
  /** Encrypted payment-message board for this network, or null where there is none (Base mainnet and Ethereum mainnet so far). */
  payMemo: Address | null;
  /** Whether native-value shields are allowed (Tempo blocks native msg.value; Robinhood Chain, Base and Ethereum list ETH). */
  nativeShield: boolean;
  /** Which chain this is, testnet or mainnet. */
  family: GloamChainFamily;
  /** Testnet (true) or mainnet (false). */
  testnet: boolean;
  /** The key set this network's verifiers hold; prove with the same set. */
  ceremony: CeremonyKind;
  /** viem chain, for clients and wallet_addEthereumChain. */
  chain: Chain;
  /** The RPC at the chain head: receipts, fresh state, sends. */
  rpcUrl: string;
  /**
   * Where reads about old blocks go when `rpcUrl` keeps only recent history
   * (Ethereum Sepolia), or null where `rpcUrl` keeps everything. Read through
   * gloamReadTransport(network) and both are used for you.
   */
  historyRpc: HistoryRpc | null;
  explorerUrl: string;
  /** Assets the pool takes, with deposit limits on the payments pools. */
  assets: GloamAsset[];
}

/** A testnet entry: always has a payment-message board. */
export type GloamTestnetNetwork = GloamNetwork & { key: "robinhood" | "tempo"; payMemo: Address; testnet: true };

/**
 * The two TESTNETS, by chain: Robinhood Chain testnet (46630) and Tempo
 * Moderato (42431). Unchanged since 0.0.x so existing code keeps working; for
 * mainnet use mainnetNetwork() or gloamNetworks(), and for Base Sepolia and
 * Ethereum Sepolia testnetNetwork("base") and testnetNetwork("ethereum").
 */
export const GLOAM_NETWORKS: Record<"robinhood" | "tempo", GloamTestnetNetwork> = {
  robinhood: {
    key: "robinhood",
    label: "Robinhood Chain",
    chainId: RH_TESTNET_CHAIN_ID,
    pool: SEALED_VAULT,
    deployBlock: SEALED_VAULT_DEPLOY_BLOCK,
    payMemo: GLOAM_PAY_MEMO,
    nativeShield: true,
    family: "robinhood",
    testnet: true,
    ceremony: "dev",
    chain: RH_TESTNET_CHAIN,
    rpcUrl: "https://rpc.testnet.chain.robinhood.com",
    historyRpc: null,
    explorerUrl: "https://explorer.testnet.chain.robinhood.com",
    // Plus the faucet stock tokens (TSLA, AMZN, PLTR, NFLX, AMD), testnet only.
    assets: [
      { symbol: "ETH", address: NATIVE_ASSET, decimals: 18, depositLimit: null },
      { symbol: "USDG", address: RH_USDG, decimals: 6, depositLimit: null },
    ],
  },
  tempo: {
    key: "tempo",
    label: "Tempo",
    chainId: TEMPO_TESTNET_CHAIN_ID,
    pool: TEMPO_SEALED_VAULT,
    deployBlock: TEMPO_SEALED_VAULT_DEPLOY_BLOCK,
    payMemo: TEMPO_PAY_MEMO,
    nativeShield: false,
    family: "tempo",
    testnet: true,
    ceremony: "dev",
    chain: TEMPO_TESTNET_CHAIN,
    rpcUrl: "https://rpc.moderato.tempo.xyz",
    historyRpc: null,
    explorerUrl: "https://explore.testnet.tempo.xyz",
    assets: [
      { symbol: "PathUSD", address: TEMPO_PATHUSD, decimals: 6, depositLimit: null },
      { symbol: "OUSD", address: TEMPO_OUSD, decimals: 6, depositLimit: null },
      { symbol: "AlphaUSD", address: "0x20c0000000000000000000000000000000000001", decimals: 6, depositLimit: null },
      { symbol: "BetaUSD", address: "0x20c0000000000000000000000000000000000002", decimals: 6, depositLimit: null },
      { symbol: "ThetaUSD", address: "0x20c0000000000000000000000000000000000003", decimals: 6, depositLimit: null },
    ],
  },
};

/** The two TESTNETS, by chain. Same object as GLOAM_NETWORKS, named for what it holds. */
export const GLOAM_TESTNETS = GLOAM_NETWORKS;

/** What a mainnet entry needs beyond its pool, per chain (Ethereum: none in this version). */
const MAINNET_SPECS: Partial<Record<
  GloamChainFamily,
  { chainId: MainnetChainId; key: GloamNetworkKey; label: string; chain: Chain; payMemo: Address | null; nativeShield: boolean; assets: GloamAsset[] }
>> = {
  // Payment-message boards on Robinhood Chain and Tempo deployed 2026-10-23 (no owner, never log the poster).
  robinhood: { chainId: 4663, key: "robinhood-mainnet", label: "Robinhood Chain", chain: RH_MAINNET_CHAIN, payMemo: "0x01B3172d9900Cb26d57E986429b9b23854c74598", nativeShield: true, assets: RH_MAINNET_ASSETS },
  tempo: { chainId: 4217, key: "tempo-mainnet", label: "Tempo", chain: TEMPO_MAINNET_CHAIN, payMemo: "0x342E3745967FDB4223902E196Ceb792c15d8C1c4", nativeShield: false, assets: TEMPO_MAINNET_ASSETS },
  // Base's payment-message board, deployed 26 Oct 2026 after the vault (no owner, never logs the poster).
  base: { chainId: 8453, key: "base-mainnet", label: "Base", chain: BASE_MAINNET_CHAIN, payMemo: "0xfCa1887e77f738ef9C5751974b3f3873d029F2DC", nativeShield: true, assets: BASE_MAINNET_ASSETS },
  // Ethereum's payment-message board, deployed 26 Oct 2026 after the vault (no owner, never logs the poster).
  ethereum: { chainId: 1, key: "ethereum-mainnet", label: "Ethereum", chain: ETHEREUM_MAINNET_CHAIN, payMemo: "0x8699D015087dE6D25d55d5ceB63b34b9d773f135", nativeShield: true, assets: ETHEREUM_MAINNET_ASSETS },
};

function buildMainnet(family: GloamChainFamily): GloamNetwork | null {
  const spec = MAINNET_SPECS[family];
  if (!spec) return null;
  const p = mainnetPoolFor(spec.chainId);
  if (!p) return null;
  return {
    key: spec.key,
    label: spec.label,
    chainId: spec.chainId,
    pool: p.pool,
    deployBlock: p.deployBlock,
    payMemo: spec.payMemo,
    nativeShield: spec.nativeShield,
    family,
    testnet: false,
    ceremony: "production",
    chain: spec.chain,
    rpcUrl: spec.chain.rpcUrls.default.http[0]!,
    historyRpc: null,
    explorerUrl: spec.chain.blockExplorers!.default.url,
    assets: spec.assets,
  };
}

/**
 * Elysium mainnet, or null until every value in src/elysium.ts is in. Its pool
 * is owned by a VaultOwnerGuard from the deploy, so its proof checkers can never
 * be replaced. Native HYPE is not listed, so nativeShield is off.
 */
function buildElysium(): GloamNetwork | null {
  const cfg = elysiumMainnetConfig();
  const chain = elysiumMainnetChain(cfg);
  if (!cfg || !chain) return null;
  return {
    key: "elysium-mainnet",
    label: "Elysium",
    chainId: cfg.chainId,
    pool: cfg.pool,
    deployBlock: cfg.deployBlock,
    payMemo: cfg.payMemo?.address ?? null,
    nativeShield: false,
    family: "elysium",
    testnet: false,
    ceremony: "production",
    chain,
    rpcUrl: cfg.rpcUrl,
    historyRpc: null,
    explorerUrl: cfg.explorerUrl,
    assets: elysiumMainnetAssets(cfg),
  };
}

const MAINNETS: Partial<Record<GloamChainFamily, GloamNetwork | null>> = {
  robinhood: buildMainnet("robinhood"),
  tempo: buildMainnet("tempo"),
  base: buildMainnet("base"),
  ethereum: buildMainnet("ethereum"),
  elysium: buildElysium(),
};

/**
 * Base Sepolia, or null while BASE_SEPOLIA_POOL is not filled in. A testnet,
 * but on the mainnet pool: ShieldPoolPayments on the final keys, payments only,
 * the same listed assets as Base mainnet, its own deposit limits, the cash-out fee.
 */
const BASE_TESTNET: GloamNetwork | null = (() => {
  const p = baseSepoliaPool();
  if (!p) return null;
  return {
    key: "base",
    label: "Base",
    chainId: BASE_SEPOLIA_CHAIN_ID,
    pool: p.pool,
    deployBlock: p.deployBlock,
    payMemo: BASE_SEPOLIA_PAY_MEMO,
    nativeShield: true,
    family: "base",
    testnet: true,
    ceremony: "production",
    chain: BASE_SEPOLIA_CHAIN,
    rpcUrl: BASE_SEPOLIA_CHAIN.rpcUrls.default.http[0]!,
    historyRpc: null,
    explorerUrl: BASE_SEPOLIA_CHAIN.blockExplorers!.default.url,
    assets: BASE_SEPOLIA_ASSETS,
  };
})();

/**
 * Ethereum Sepolia, or null while ETHEREUM_SEPOLIA_POOL is not filled in. A
 * testnet on the mainnet pool: ShieldPoolPayments on the final keys, payments
 * only, deposit limits, the cash-out fee, and its payment-message board.
 */
const ETHEREUM_TESTNET: GloamNetwork | null = (() => {
  const p = ethereumSepoliaPool();
  if (!p) return null;
  return {
    key: "ethereum",
    label: "Ethereum",
    chainId: ETHEREUM_SEPOLIA_CHAIN_ID,
    pool: p.pool,
    deployBlock: p.deployBlock,
    payMemo: ethereumSepoliaPayMemo()?.address ?? null,
    nativeShield: true,
    family: "ethereum",
    testnet: true,
    ceremony: "production",
    chain: ETHEREUM_SEPOLIA_CHAIN,
    rpcUrl: ETHEREUM_SEPOLIA_CHAIN.rpcUrls.default.http[0]!,
    historyRpc: ETHEREUM_SEPOLIA_HISTORY_RPC,
    explorerUrl: ETHEREUM_SEPOLIA_CHAIN.blockExplorers!.default.url,
    assets: ETHEREUM_SEPOLIA_ASSETS,
  };
})();

/**
 * Elysium testnet (99801), or null while ELYSIUM_TESTNET's pool is not filled
 * in. A testnet on the mainnet pool like Base Sepolia: ShieldPoolPayments born
 * owned by a VaultOwnerGuard, the final keys, test USDC only, gas in HYPE (not
 * listed, so nativeShield is off).
 */
const ELYSIUM_TESTNET_NETWORK: GloamNetwork | null = (() => {
  const cfg = elysiumTestnetConfig();
  const chain = elysiumTestnetChain(cfg);
  if (!cfg || !chain) return null;
  return {
    key: "elysium",
    label: "Elysium",
    chainId: cfg.chainId,
    pool: cfg.pool,
    deployBlock: cfg.deployBlock,
    payMemo: cfg.payMemo?.address ?? null,
    nativeShield: false,
    family: "elysium",
    testnet: true,
    ceremony: "production",
    chain,
    rpcUrl: cfg.rpcUrl,
    historyRpc: null,
    explorerUrl: cfg.explorerUrl,
    assets: elysiumTestnetAssets(cfg),
  };
})();

/**
 * A chain's MAINNET network, or null while its pool is not in
 * this SDK version. Mainnet pools are ShieldPoolPayments: payments only,
 * deposit limits, the ceremony's final keys, a 0.5% cash-out fee.
 */
export function mainnetNetwork(family: GloamChainFamily): GloamNetwork | null {
  return MAINNETS[family] ?? null;
}

/**
 * A chain's TESTNET network, or null while its pool is not in this
 * SDK version: GLOAM_NETWORKS.robinhood and .tempo, and Base Sepolia,
 * Ethereum Sepolia and Elysium testnet once each pool is filled in.
 */
export function testnetNetwork(family: GloamChainFamily): GloamNetwork | null {
  if (family === "elysium") return ELYSIUM_TESTNET_NETWORK;
  if (family === "base") return BASE_TESTNET;
  if (family === "ethereum") return ETHEREUM_TESTNET;
  return GLOAM_NETWORKS[family];
}

/** Every network Gloam runs on right now: mainnets with a pool first, then the testnets. */
export function gloamNetworks(): GloamNetwork[] {
  const live = [MAINNETS.robinhood, MAINNETS.tempo, MAINNETS.base, MAINNETS.ethereum, MAINNETS.elysium].filter((n): n is GloamNetwork => n !== null);
  return [
    ...live,
    GLOAM_NETWORKS.robinhood,
    GLOAM_NETWORKS.tempo,
    ...(BASE_TESTNET ? [BASE_TESTNET] : []),
    ...(ETHEREUM_TESTNET ? [ETHEREUM_TESTNET] : []),
    ...(ELYSIUM_TESTNET_NETWORK ? [ELYSIUM_TESTNET_NETWORK] : []),
  ];
}

/** A network by key ("robinhood-mainnet", "tempo-mainnet", "base", "robinhood" and so on), or null if it has no pool yet. */
export function getGloamNetwork(key: GloamNetworkKey): GloamNetwork | null {
  return gloamNetworks().find((n) => n.key === key) ?? null;
}

/** Resolve the Gloam network for a chain id, or undefined if Gloam has no pool there (yet). */
export function networkForChainId(chainId: number): GloamNetwork | undefined {
  return gloamNetworks().find((n) => n.chainId === chainId);
}

/**
 * True for Robinhood Chain (4663), Tempo (4217), Base (8453) and Ethereum (1)
 * mainnet, pool or not, and for Elysium mainnet once its chain id is filled in.
 * Never for Elysium's testnet (99801).
 */
export function isMainnetChainId(chainId: number): boolean {
  return (
    chainId === RH_MAINNET_CHAIN_ID ||
    chainId === TEMPO_MAINNET_CHAIN_ID ||
    chainId === BASE_MAINNET_CHAIN_ID ||
    chainId === ETHEREUM_MAINNET_CHAIN_ID ||
    (elysiumChainId() !== null && chainId === elysiumChainId())
  );
}

/**
 * True where the pool is ShieldPoolPayments, pool or not: every mainnet, Base
 * Sepolia, Ethereum Sepolia and Elysium testnet. Deposits there need a proof, assets are listed
 * with deposit limits, a cash out pays the fee and there is no private trading.
 */
export function isPaymentsPoolChainId(chainId: number): boolean {
  return isMainnetChainId(chainId) || chainId === BASE_SEPOLIA_CHAIN_ID || chainId === ETHEREUM_SEPOLIA_CHAIN_ID || chainId === ELYSIUM_TESTNET_CHAIN_ID;
}

/**
 * The key set a proof for `chainId` must use. Mainnet chain ids, Base Sepolia
 * and Ethereum Sepolia always answer "production", pool or not, so a proof for
 * them is never made with dev keys.
 */
export function ceremonyForChainId(chainId: number): CeremonyKind {
  return isPaymentsPoolChainId(chainId) ? "production" : "dev";
}

/** "Robinhood Chain testnet", "Tempo testnet", "Base testnet", "Ethereum Sepolia", or the chain's plain name on mainnet. */
export function networkName(chainId: number): string {
  if (chainId === RH_MAINNET_CHAIN_ID) return "Robinhood Chain";
  if (chainId === TEMPO_MAINNET_CHAIN_ID) return "Tempo";
  if (chainId === BASE_MAINNET_CHAIN_ID) return "Base";
  if (chainId === ETHEREUM_MAINNET_CHAIN_ID) return "Ethereum";
  if (elysiumChainId() !== null && chainId === elysiumChainId()) return "Elysium";
  if (chainId === RH_TESTNET_CHAIN_ID) return "Robinhood Chain testnet";
  if (chainId === TEMPO_TESTNET_CHAIN_ID) return "Tempo testnet";
  if (chainId === BASE_SEPOLIA_CHAIN_ID) return "Base testnet";
  if (chainId === ETHEREUM_SEPOLIA_CHAIN_ID) return "Ethereum Sepolia";
  if (chainId === ELYSIUM_TESTNET_CHAIN_ID) return "Elysium testnet";
  return `chain ${chainId}`;
}

/**
 * The Gloam pool on `chainId`, for builders called without a poolAddress.
 * Throws on a mainnet whose pool is not in this SDK version and on chains Gloam
 * does not run on, rather than guess a pool.
 */
export function poolForChainId(chainId: number): Address {
  const net = networkForChainId(chainId);
  if (net) return net.pool;
  if (isPaymentsPoolChainId(chainId)) {
    throw new Error(
      `The Gloam pool on ${networkName(chainId)}${isMainnetChainId(chainId) ? " mainnet" : ""} is not in this version of @gloamtrade/sdk. Update the SDK, or pass poolAddress.`
    );
  }
  throw new Error(`Gloam has no pool on chain ${chainId}. Pass poolAddress.`);
}

/**
 * Checks a deposit against what the network's pool takes, before any proof is
 * made: a native deposit where the pool takes none, or an asset a payments pool
 * (mainnet, Base Sepolia) does not list. Unknown chains (a pool passed in
 * explicitly) are not checked, nor are the older testnets, whose pools list
 * nothing.
 *
 * The amount is not checked here: the deposit limits change through the vault's
 * timelock, so the `depositLimit` on each asset is only a snapshot. Read
 * them live with assertDepositWithinLiveLimit (lib limits), which
 * buildShieldBoundIntent does when given a `client`. `amount` is kept so
 * existing callers compile.
 */
export function assertDepositAllowed(chainId: number, asset: Address, amount: bigint): void {
  void amount;
  const net = networkForChainId(chainId);
  if (!net) return;
  const where = networkName(chainId);
  if (asset.toLowerCase() === NATIVE_ASSET.toLowerCase() && !net.nativeShield) {
    throw new Error(`The ${where} pool takes no native deposits. Pass an asset it lists: ${net.assets.map((a) => a.symbol).join(", ")}.`);
  }
  if (!net.assets.some((a) => a.depositLimit)) return;
  const listed = net.assets.find((a) => a.address.toLowerCase() === asset.toLowerCase());
  if (!listed) {
    throw new Error(`The ${where} pool does not list ${asset}. It takes ${net.assets.map((a) => a.symbol).join(", ")}.`);
  }
}

// ── Cash-out recipients ───────────────────────────────────────────────────────

export const CASH_OUT_TO_VAULT_MESSAGE = "That address is the vault itself. Cash out to a wallet you control.";
export const CASH_OUT_TO_BOARD_MESSAGE =
  "That address is Gloam's payment message board. Cash out to a wallet you control.";
export const CASH_OUT_TO_TOKEN_MESSAGE =
  "That address is a token contract, not a wallet. Money sent there would be lost. Cash out to a wallet you control.";
export const CASH_OUT_TO_ROUTER_MESSAGE =
  "That address is Gloam's swap router, not a wallet. Money sent there goes to the treasury. Cash out to a wallet you control.";
export const CASH_OUT_TO_ZERO_MESSAGE = "That is the zero address, which nobody controls. Cash out to a wallet you control.";

/**
 * Gloam's swap routers, by chain, the newest first. GloamVaultSwapV4c on Robinhood
 * Chain, Base and Ethereum and GloamVaultSwapTempo2 on Tempo land through the CREATE2
 * factory, so each address is known before it deploys and a cash out is refused from
 * the start (contracts/test/fixtures/router-next.json pins them). The older routers
 * stay listed for good: GloamVaultSwapV4b and GloamVaultSwapV4 on Robinhood Chain,
 * GloamVaultSwapTempo on Tempo. How swaps run is the app's (app/src/lib/vaultSwap.ts).
 */
const VAULT_SWAP_ROUTERS: Record<number, readonly Address[]> = {
  [RH_MAINNET_CHAIN_ID]: ["0x9CdA89fA6E6f796a1623C2086b2C710DCa64486d", "0xfCa1887e77f738ef9C5751974b3f3873d029F2DC", "0x34AB06208586A737Bf1607fa996Bc9162271c52d"],
  [TEMPO_MAINNET_CHAIN_ID]: ["0x991efFC6cA44BD578000d32C1351d78298BdBC0a", "0xfCa1887e77f738ef9C5751974b3f3873d029F2DC"],
  [BASE_MAINNET_CHAIN_ID]: ["0x3A99f461bdbfc86fbd4e84ee80Bfb2fd73f3576a"],
  [ETHEREUM_MAINNET_CHAIN_ID]: ["0x2E0c06Ac42Cc6f0ecC3eDc86bC0d67F3c2DC7E6A"],
};

/**
 * Tokens that are not in a network's `assets` because its pool doesn't take a
 * deposit of them, but a cash out could still be pointed at. On Robinhood Chain
 * mainnet: what a private swap can land in (the app's RH_SWAP_ASSETS_V2, past
 * the listed USDG, GLOAM, PONS and CASHCAT). On Base and Ethereum: WETH, which the
 * swap router there converts to and from. On Robinhood Chain's testnet: the faucet
 * stock tokens. Kept out of `assets` on purpose: assertDepositAllowed reads that list.
 */
const UNLISTED_TOKENS: Record<number, readonly Address[]> = {
  [BASE_MAINNET_CHAIN_ID]: ["0x4200000000000000000000000000000000000006"], // WETH
  [ETHEREUM_MAINNET_CHAIN_ID]: ["0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"], // WETH
  [RH_MAINNET_CHAIN_ID]: [
    "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73", // WETH
    "0x5d3a1Ff2b6BAb83b63cd9AD0787074081a52ef34", // USDe
    "0xcE24439F2D9C6a2289F741120FE202248B666666", // U
    "0xCEC185eB182c47d1bA1EFc84e6959e18cd620Be4", // cbBTC
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
  ],
  [RH_TESTNET_CHAIN_ID]: [
    "0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E", // TSLA
    "0x5884aD2f920c162CFBbACc88C9C51AA75eC09E02", // AMZN
    "0x1FBE1a0e43594b3455993B5dE5Fd0A7A266298d0", // PLTR
    "0x3b8262A63d25f0477c4DDE23F83cfe22Cb768C93", // NFLX
    "0x71178BAc73cBeb415514eB542a8995b82669778d", // AMD
  ],
};

/** The network a cash out is on. A GloamNetwork fits as it is. */
export interface CashOutTargetNetwork {
  chainId: number;
  /** The vault being cashed out of. The network's own vault is refused either way. */
  pool?: string | null;
  /** A payment-message board, on top of the network's own. */
  payMemo?: string | null;
  /** Swap routers to refuse on top of the ones the SDK knows. */
  routers?: readonly string[];
  /** Token contracts to refuse on top of the ones the SDK knows. */
  tokens?: readonly string[];
}

/**
 * Why a cash out to `to` on this network would be lost, or null when it is fine.
 * buildUnshieldIntent checks this before proving, and the Gloam app and relay
 * use it too, so an agent that sends from its own wallet gets the same answer.
 *
 * Refused: the vault, where the money stays put and its books go down; the
 * payment-message board and a token contract, which can never pay it out; a swap
 * router, which sends what it holds to the treasury; and the zero address. Only
 * the note's owner picks the address, so this guards against a slip, not an attack.
 *
 * Each list is matched on its own chain only, because the same address can be
 * a wallet somewhere else: 0xfCa1...F2DC is a router on Robinhood Chain and
 * Tempo, the board on Base, and just an address on Ethereum.
 */
export function cashOutTargetProblem(to: string, net: CashOutTargetNetwork): string | null {
  const target = to.trim().toLowerCase();
  const isTarget = (a: string | null | undefined) => a?.trim().toLowerCase() === target;
  const known = networkForChainId(net.chainId);
  if ([net.pool, known?.pool].some(isTarget)) return CASH_OUT_TO_VAULT_MESSAGE;
  if ([net.payMemo, known?.payMemo].some(isTarget)) return CASH_OUT_TO_BOARD_MESSAGE;
  if (isTarget(zeroAddress)) return CASH_OUT_TO_ZERO_MESSAGE;
  const routers = [...(VAULT_SWAP_ROUTERS[net.chainId] ?? []), ...(net.routers ?? [])];
  if (routers.some(isTarget)) return CASH_OUT_TO_ROUTER_MESSAGE;
  const tokens = [...(known?.assets ?? []).map((a) => a.address), ...(UNLISTED_TOKENS[net.chainId] ?? []), ...(net.tokens ?? [])];
  return tokens.some(isTarget) ? CASH_OUT_TO_TOKEN_MESSAGE : null;
}

/** Tokens whose approve() refuses to change one non-zero allowance into another, by chain. */
const APPROVE_RESET_FIRST: Record<number, Address[]> = {
  [ETHEREUM_MAINNET_CHAIN_ID]: [ETHEREUM_USDT],
};

/**
 * True for a token whose approve() reverts when it would change one non-zero
 * allowance into another (Tether's USDT on Ethereum): it must go to 0 first.
 */
export function approveNeedsReset(chainId: number, token: Address): boolean {
  return (APPROVE_RESET_FIRST[chainId] ?? []).some((t) => t.toLowerCase() === token.toLowerCase());
}

/**
 * The approve(pool, value) calls a deposit of `amount` needs, in order, given
 * the allowance the pool has now: none when it already covers the deposit;
 * [0, amount] for a token that refuses to go from one non-zero allowance to
 * another (a stale allowance left by a deposit that never went through);
 * otherwise [amount]. Always exact amounts, never an open-ended allowance.
 * Send each one and wait for it to land before the next, then the deposit.
 */
export function approvalSteps(chainId: number, token: Address, allowance: bigint, amount: bigint): bigint[] {
  if (amount <= 0n) throw new Error("amount must be positive");
  if (allowance >= amount) return [];
  if (allowance > 0n && approveNeedsReset(chainId, token)) return [0n, amount];
  return [amount];
}

// ── Circuit artifacts ─────────────────────────────────────────────────────────

/** Where Gloam hosts the circuit files. Dev keys at the root, the ceremony's final keys under /final. */
export const GLOAM_ARTIFACTS_URL = "https://www.gloam.trade/circuits";

/** The pool circuits: deposit, private send, cash out. */
export type PoolCircuit = "shield" | "transfer" | "unshield";

/** Every circuit pinned here: the pool's, and the receipt circuit behind a proof of payment, which is checked off chain. */
export type GloamCircuit = PoolCircuit | "receipt";

/**
 * SHA-256 of each circuit file, to check a download before proving with it.
 * The .wasm files are the same for both key sets; the zkeys differ.
 */
export const CIRCUIT_SHA256: {
  wasm: Record<GloamCircuit, string>;
  zkey: Record<CeremonyKind, Record<GloamCircuit, string>>;
} = {
  wasm: {
    shield: "58157ec90f8af891acfa998bd599511b4d5cd06803cea32ab28a6eea8a9b2336",
    transfer: "081929509c3477ee264cb2422183018c23122d59952ed4a61c4932c95d360872",
    unshield: "84ac0942b1618c6112a10bfe82ff0a62a80b7a14881565781eb513e9e581c480",
    receipt: "14733e0d4f598d6b392ce8e955eae5624ace80932aa9acdb9298d26c6d1a8fc1",
  },
  zkey: {
    dev: {
      shield: "e4d42271b99faa218faebb38a06f69b5ccf01e328d3dea4381ab567e9fbd2481",
      transfer: "f75bc324f12e1f467f5779a7275737aa0fa514a6c317e3d775f1dba8f0234666",
      unshield: "f4b4c5bfa315cef38634eec1b64b8d9ad1d28725f61fde5e169fef1896360b63",
      receipt: "600652865c27f9b1dafa4edfe65da7c4f8b7c9c6099bf0c85da0151d91830a9a",
    },
    production: {
      shield: "3054877c35e2e0e9f76c43aa4791ac2b3ac51b8967d51be2215e89c0a5fbb512",
      transfer: "bdbae966705bc85e76571b4945da74a43fc4503a955fd4e3799358bcff749cdb",
      unshield: "5a12073f3f84b52f794feaf862fb1d48301124319db95a9c6d0dc58277fa54ed",
      receipt: "b6b2352ecb393c7f0709177f89168d9d4fef53282fb24a98c1c08d9adb7cdd86",
    },
  },
};

/** One circuit's files for a key set, as paths relative to the artifacts root, with their SHA-256. */
export function circuitArtifactFiles(
  circuit: GloamCircuit,
  ceremony: CeremonyKind
): { wasm: string; zkey: string; sha256: { wasm: string; zkey: string } } {
  return {
    wasm: `${circuit}.wasm`,
    zkey: ceremony === "production" ? `final/${circuit}_final.zkey` : `${circuit}_final.zkey`,
    sha256: { wasm: CIRCUIT_SHA256.wasm[circuit], zkey: CIRCUIT_SHA256.zkey[ceremony][circuit] },
  };
}

/**
 * URLs of the wasm and zkey to prove `circuit` for `chainId`, with the key set
 * that chain's verifiers hold (final keys on mainnet, dev keys on testnet).
 * Pass straight to artifactProver in the browser; in node, download them first
 * (snarkjs proves from local paths there) and check CIRCUIT_SHA256.
 */
export function circuitArtifactUrls(
  circuit: GloamCircuit,
  chainId: number,
  base: string = GLOAM_ARTIFACTS_URL
): { wasm: string; zkey: string } {
  const root = base.replace(/\/+$/, "");
  const f = circuitArtifactFiles(circuit, ceremonyForChainId(chainId));
  return { wasm: `${root}/${f.wasm}`, zkey: `${root}/${f.zkey}` };
}
