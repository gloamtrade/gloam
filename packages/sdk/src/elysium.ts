/**
 * Elysium mainnet: the one place its values live, for the SDK, the MCP server
 * and the app (which can also take them from NEXT_PUBLIC_ELYSIUM_* at build
 * time, app/src/lib/elysium.ts).
 *
 * Elysium is Kinetiq's Hyperliquid L2: an Arbitrum Orbit chain that settles to
 * HyperEVM, with HYPE as its gas coin. Its mainnet chain id, RPC, explorer and
 * USDC address were not public when this was written, so every value below
 * starts empty and Elysium does not exist for the SDK until all of them are in:
 * elysiumMainnetConfig() returns null, gloamNetworks() leaves it out, and the
 * builders refuse its chain id instead of guessing a pool.
 *
 * FILLED IN ON LAUNCH DAY (DEPLOY-ELYSIUM.md):
 *   chainId, rpcUrl, explorerUrl, usdc (and usdcDecimals if it is not 6) by hand,
 *   from Kinetiq's docs, each checked on chain first;
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
  chainId: null,
  rpcUrl: null,
  explorerUrl: null,
  usdc: null,
  usdcDecimals: 6,
  pool: null,
  deployBlock: null,
  payMemo: null,
  payMemoBlock: null,
};

/** Elysium's testnet, as reported. Gloam has no pool there; it is never taken for mainnet. */
export const ELYSIUM_TESTNET_CHAIN_ID = 99801;

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
 * Checks a set of Elysium values. Returns null while any is missing; throws on
 * a value that is in but wrong, so a typo fails loudly instead of pointing
 * money at the wrong chain or contract.
 */
export function checkElysiumMainnet(input: ElysiumMainnetInput, name = "ELYSIUM_MAINNET"): ElysiumMainnet | null {
  const { chainId, rpcUrl, explorerUrl, usdc, usdcDecimals, pool, deployBlock, payMemo, payMemoBlock } = input;
  if (chainId === null || rpcUrl === null || explorerUrl === null || usdc === null || pool === null || deployBlock === null) return null;
  if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new Error(`${name}.chainId is not a chain id: ${chainId}`);
  if (chainId === ELYSIUM_TESTNET_CHAIN_ID) throw new Error(`${name}.chainId is ${chainId}, Elysium's testnet, not its mainnet`);
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
  return checkElysiumMainnet(ELYSIUM_MAINNET);
}

/**
 * Elysium's chain id once it is filled in (even before the pool is), else null.
 * A proof for it is always made with the ceremony's final keys.
 */
export function elysiumChainId(): number | null {
  const id = ELYSIUM_MAINNET.chainId;
  return id !== null && Number.isSafeInteger(id) && id > 0 && id !== ELYSIUM_TESTNET_CHAIN_ID && !OTHER_GLOAM_CHAIN_IDS.has(id) ? id : null;
}
