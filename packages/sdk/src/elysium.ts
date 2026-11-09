/**
 * Elysium mainnet: the one place its values live, for the SDK, the MCP server
 * and the app (which can also take them from NEXT_PUBLIC_ELYSIUM_* at build
 * time, app/src/lib/elysium.ts).
 *
 * Elysium is Kinetiq's Hyperliquid L2: an Arbitrum Orbit chain that settles to
 * HyperEVM (999; its testnet to HyperEVM testnet 998), with HYPE as its gas coin
 * and blocks about every 100 ms. Its mainnet chain id is 99901 (Kinetiq's docs,
 * elysium.kinetiq.xyz/docs/connecting-to-elysium); its public RPC, explorer and
 * USDC address are published at launch, so those start empty and Elysium
 * mainnet does not exist for the SDK until all of them are in:
 * elysiumMainnetConfig() returns null, gloamNetworks() leaves it out, and the
 * builders refuse its chain id instead of guessing a pool.
 *
 * FILLED IN ON LAUNCH DAY (DEPLOY-ELYSIUM.md):
 *   rpcUrl, explorerUrl, usdc (and usdcDecimals if it is not 6) by hand, from
 *   Kinetiq's docs, each checked on chain first (chainId is in already);
 *   rpcUrl must be a public URL with no API key in it: this file is public and
 *   ships in the npm package. A keyed RPC (Kinetiq recommends
 *   https://elysium-mainnet.g.alchemy.com/v2/{API_KEY}) goes in the app's env;
 *   pool, deployBlock, payMemo and payMemoBlock by
 *   contracts/elysium-mainnet-after-deploy.sh, which reads them from the deploy.
 *
 * Write the blocks as bigints (123n). Keep each field on its own line: the
 * after-deploy script finds them by their text.
 */
import type { Address } from "viem";

export interface ElysiumMainnetInput {
  /** Elysium mainnet's chain id. Not 99801, the reported testnet id. */
  chainId: number | null;
  /** A public Elysium RPC that answers eth_getLogs (the vault tree is rebuilt from logs). */
  rpcUrl: string | null;
  /** The block explorer's base URL, without a trailing slash. */
  explorerUrl: string | null;
  /** USDC on Elysium. */
  usdc: Address | null;
  /** USDC's decimals, checked on chain. */
  usdcDecimals: number;
  /** ShieldPoolPayments on Elysium, from the deploy. */
  pool: Address | null;
  /** Block the pool's deploy transaction landed in. */
  deployBlock: bigint | null;
  /** The payment-message board (GloamPayMemo), if deployed. */
  payMemo: Address | null;
  /** Block the board's deploy transaction landed in. */
  payMemoBlock: bigint | null;
}

export const ELYSIUM_MAINNET: ElysiumMainnetInput = {
  chainId: 99901,
  rpcUrl: "https://rpc.elysium.kinetiq.xyz",
  explorerUrl: "https://elysium.kinetiq.xyz/explorer",
  usdc: "0xb47c4C8F73F009CC0C0d3f92B388d13E293F0B65",
  usdcDecimals: 6,
  pool: null,
  deployBlock: null,
  payMemo: null,
  payMemoBlock: null,
};

/** Elysium mainnet's chain id (0x1863d), from Kinetiq's docs. */
export const ELYSIUM_MAINNET_CHAIN_ID = 99901;

/** Elysium's testnet chain id (0x185d9). Never taken for mainnet. */
export const ELYSIUM_TESTNET_CHAIN_ID = 99801;

/** Wrapped HYPE on Elysium's testnet. Not a pool asset. */
export const ELYSIUM_TESTNET_WHYPE: Address = "0xCD57F65c2B0e5881CFC2E609F7CD53b746E1F234";

/** Multicall3, at its usual address on both Elysium networks. */
export const ELYSIUM_MULTICALL3: Address = "0xcA11bde05977b3631167028862bE2a173976CA11";

/**
 * Elysium testnet (99801), a Gloam testnet like Base Sepolia: the mainnet vault
 * (ShieldPoolPayments, born guarded), the final keys, test USDC. Chain id, RPC,
 * explorer and USDC are Kinetiq's published values, checked on chain on
 * 7 November 2026 (chain id 0x185d9, USDC symbol USDC with 6 decimals, Multicall3
 * deployed, eth_getLogs over 20,000,000 blocks with a 10,000-log cap). pool,
 * deployBlock, payMemo and payMemoBlock are written by
 * contracts/elysium-testnet-after-deploy.sh; until pool and deployBlock are in,
 * the testnet does not exist for the SDK either.
 */
export const ELYSIUM_TESTNET: ElysiumMainnetInput = {
  chainId: 99801,
  rpcUrl: "https://testnet-rpc.elysium.kinetiq.xyz",
  explorerUrl: "https://elysium.kinetiq.xyz/testnet-explorer",
  usdc: "0x7D29d8047B905000459c0E80c34a26CeedcB47b2",
  usdcDecimals: 6,
  pool: null,
  deployBlock: null,
  payMemo: null,
  payMemoBlock: null,
};

/** A second public RPC for Elysium's testnet (Conduit's), for a fallback. */
export const ELYSIUM_TESTNET_RPC_FALLBACK = "https://rpc-elysium-testnet.t.conduit.xyz";

/** HYPE, Elysium's gas coin. */
export const ELYSIUM_NATIVE_CURRENCY = { name: "HYPE", symbol: "HYPE", decimals: 18 } as const;

/** Chain ids Gloam already runs on, mainnet and testnet: none of them can be Elysium. */
const OTHER_GLOAM_CHAIN_IDS = new Set([1, 4663, 4217, 8453, 46630, 42431, 84532, 11155111]);

/** Elysium mainnet with every value in and checked. */
export interface ElysiumMainnet {
  chainId: number;
  rpcUrl: string;
  explorerUrl: string;
  usdc: Address;
  usdcDecimals: number;
  pool: Address;
  deployBlock: bigint;
  payMemo: { address: Address; deployBlock: bigint } | null;
}

const isAddress = (v: unknown): v is Address => typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v) && !/^0x0{40}$/.test(v);
const isHttpsUrl = (v: unknown): v is string => typeof v === "string" && /^https:\/\/[^\s/]+[^\s]*$/.test(v);

/**
 * An RPC URL as it may be shown: an API key in its path (Alchemy's
 * /v2/<key>, Infura's /v3/<key>, a trailing long token) or query is replaced
 * by {API_KEY}, so docs, Glim and logs never print a key.
 */
export function redactRpcUrl(url: string): string {
  return url
    .replace(/\/(v\d+)\/[A-Za-z0-9_-]{8,}/g, "/$1/{API_KEY}")
    .replace(/([?&](?:api[-_]?key|key|token|apikey)=)[^&#]+/gi, "$1{API_KEY}")
    .replace(/\/[A-Za-z0-9_-]{24,}(?=\/?$)/, "/{API_KEY}");
}

/**
 * Checks a set of Elysium values. Returns null while any is missing; throws on
 * a value that is in but wrong, so a typo fails loudly instead of pointing
 * money at the wrong chain or contract.
 */
export function checkElysiumMainnet(input: ElysiumMainnetInput, name = "ELYSIUM_MAINNET"): ElysiumMainnet | null {
  const { chainId, rpcUrl, explorerUrl, usdc, usdcDecimals, pool, deployBlock, payMemo, payMemoBlock } = input;
  if (chainId === null || rpcUrl === null || explorerUrl === null || usdc === null || pool === null || deployBlock === null) return null;
  if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new Error(`${name}.chainId is not a chain id: ${chainId}`);
  if (chainId === ELYSIUM_TESTNET_CHAIN_ID) throw new Error(`${name}.chainId is ${chainId}, Elysium's testnet, not its mainnet`);
  if (chainId !== ELYSIUM_MAINNET_CHAIN_ID) throw new Error(`${name}.chainId must be ${ELYSIUM_MAINNET_CHAIN_ID}, Elysium mainnet's (Kinetiq's docs), got ${chainId}`);
  if (OTHER_GLOAM_CHAIN_IDS.has(chainId)) throw new Error(`${name}.chainId is ${chainId}, another chain Gloam runs on`);
  if (!isHttpsUrl(rpcUrl)) throw new Error(`${name}.rpcUrl must be an https URL, got ${rpcUrl}`);
  if (!isHttpsUrl(explorerUrl)) throw new Error(`${name}.explorerUrl must be an https URL, got ${explorerUrl}`);
  if (!isAddress(usdc)) throw new Error(`${name}.usdc is not a token address: ${usdc}`);
  if (!Number.isInteger(usdcDecimals) || usdcDecimals < 0 || usdcDecimals > 36) throw new Error(`${name}.usdcDecimals is not a decimals count: ${usdcDecimals}`);
  if (!isAddress(pool)) throw new Error(`${name}.pool is not a pool address: ${pool}`);
  if (deployBlock <= 0n) throw new Error(`${name}.deployBlock must be the deploy block, got ${deployBlock}`);
  let memo: ElysiumMainnet["payMemo"] = null;
  if (payMemo !== null || payMemoBlock !== null) {
    if (!isAddress(payMemo)) throw new Error(`${name}.payMemo is not an address: ${payMemo}`);
    if (payMemoBlock === null || payMemoBlock <= 0n) throw new Error(`${name}.payMemoBlock must be the board's deploy block, got ${payMemoBlock}`);
    memo = { address: payMemo, deployBlock: payMemoBlock };
  }
  return { chainId, rpcUrl, explorerUrl: explorerUrl.replace(/\/+$/, ""), usdc, usdcDecimals, pool, deployBlock, payMemo: memo };
}

/** Elysium mainnet as filled in above, or null until every value is in. */
export function elysiumMainnetConfig(): ElysiumMainnet | null {
  noKeyInFile(ELYSIUM_MAINNET, "ELYSIUM_MAINNET");
  return checkElysiumMainnet(ELYSIUM_MAINNET);
}

/** This file is public and ships in the npm package: an RPC URL with an API key in it is refused. */
function noKeyInFile(input: ElysiumMainnetInput, name: string) {
  if (input.rpcUrl !== null && redactRpcUrl(input.rpcUrl) !== input.rpcUrl) {
    throw new Error(`${name}.rpcUrl has an API key in it; put a keyed RPC in the app's NEXT_PUBLIC_ELYSIUM_RPC_URL or GLOAM_RPC_URL_<chainId>, never in this file`);
  }
}

/**
 * Elysium's chain id once it is filled in (even before the pool is), else null.
 * A proof for it is always made with the ceremony's final keys.
 */
export function elysiumChainId(): number | null {
  const id = ELYSIUM_MAINNET.chainId;
  return id !== null && Number.isSafeInteger(id) && id > 0 && id !== ELYSIUM_TESTNET_CHAIN_ID && !OTHER_GLOAM_CHAIN_IDS.has(id) ? id : null;
}

/** Elysium testnet with every value in and checked. Same shape as mainnet. */
export type ElysiumTestnet = ElysiumMainnet;

/**
 * Checks Elysium testnet's values: null while the pool or its block is missing,
 * throws on a value that is in but wrong (it must be the testnet's chain id).
 */
export function checkElysiumTestnet(input: ElysiumMainnetInput, name = "ELYSIUM_TESTNET"): ElysiumTestnet | null {
  const { chainId, rpcUrl, explorerUrl, usdc, usdcDecimals, pool, deployBlock, payMemo, payMemoBlock } = input;
  if (chainId === null || rpcUrl === null || explorerUrl === null || usdc === null || pool === null || deployBlock === null) return null;
  if (chainId !== ELYSIUM_TESTNET_CHAIN_ID) throw new Error(`${name}.chainId must be ${ELYSIUM_TESTNET_CHAIN_ID}, Elysium's testnet, got ${chainId}`);
  if (!isHttpsUrl(rpcUrl)) throw new Error(`${name}.rpcUrl must be an https URL, got ${rpcUrl}`);
  if (!isHttpsUrl(explorerUrl)) throw new Error(`${name}.explorerUrl must be an https URL, got ${explorerUrl}`);
  if (!isAddress(usdc)) throw new Error(`${name}.usdc is not a token address: ${usdc}`);
  if (!Number.isInteger(usdcDecimals) || usdcDecimals < 0 || usdcDecimals > 36) throw new Error(`${name}.usdcDecimals is not a decimals count: ${usdcDecimals}`);
  if (!isAddress(pool)) throw new Error(`${name}.pool is not a pool address: ${pool}`);
  if (deployBlock <= 0n) throw new Error(`${name}.deployBlock must be the deploy block, got ${deployBlock}`);
  let memo: ElysiumMainnet["payMemo"] = null;
  if (payMemo !== null || payMemoBlock !== null) {
    if (!isAddress(payMemo)) throw new Error(`${name}.payMemo is not an address: ${payMemo}`);
    if (payMemoBlock === null || payMemoBlock <= 0n) throw new Error(`${name}.payMemoBlock must be the board's deploy block, got ${payMemoBlock}`);
    memo = { address: payMemo, deployBlock: payMemoBlock };
  }
  return { chainId, rpcUrl, explorerUrl: explorerUrl.replace(/\/+$/, ""), usdc, usdcDecimals, pool, deployBlock, payMemo: memo };
}

/** Elysium testnet as filled in above, or null until its pool is in. */
export function elysiumTestnetConfig(): ElysiumTestnet | null {
  noKeyInFile(ELYSIUM_TESTNET, "ELYSIUM_TESTNET");
  return checkElysiumTestnet(ELYSIUM_TESTNET);
}

/**
 * Elysium's block time is about 100 ms (checked on its testnet, 7 November
 * 2026), so a day is about 860,000 blocks. Its public RPCs cap eth_getLogs at
 * 10,000 logs, not at a block range: the vault's own logs fit 1,000,000 blocks
 * (about 28 hours) per call comfortably.
 */
export const ELYSIUM_BLOCK_MS = 100;
export const ELYSIUM_LOG_RANGE_DEFAULT = 1_000_000;
