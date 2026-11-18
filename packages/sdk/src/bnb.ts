/**
 * BNB Chain (BNB Smart Chain) mainnet: the one place its values live, for the
 * SDK, the MCP server and the app (which can also take them from
 * NEXT_PUBLIC_BNB_* at build time, app/src/lib/bnb.ts).
 *
 * BNB Smart Chain is an EVM L1, chain id 56 (0x38), gas paid in BNB, blocks
 * about every 0.45 s (measured 18 November 2026: 100,000 blocks in 45,018 s).
 * Everything but the vault is known ahead of the deploy and was checked on
 * chain on 18 November 2026:
 *
 *   USDT  0x55d398326f99059fF775485246999027B3197955  symbol USDT, 18 decimals
 *   USDC  0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d  symbol USDC, 18 decimals
 *   BDX   0x6ad12E761b438beA3EA09F6C6266556Bb24C2181  symbol BDX, 9 decimals, Beldex's
 *         LayerZero OFT (token() is itself, endpoint 0x1a44…728c), the same contract
 *         and owner as on Base and Ethereum
 *   Multicall3 at its usual address
 *
 * The stablecoins on BNB Chain have 18 decimals, not 6 like everywhere else
 * Gloam runs. Every amount is read with the asset's own decimals; nothing here
 * or in the builders may assume 6.
 *
 * Until the pool and its deploy block are in, BNB Chain does not exist for the
 * SDK: bnbMainnetConfig() returns null, gloamNetworks() leaves it out, and the
 * builders refuse chain 56 instead of guessing a pool. A proof for chain 56 is
 * always made with the ceremony's final keys, pool or not.
 *
 * Logs: the public RPCs keep very little history. publicnode answers
 * eth_getLogs over 50,000 blocks but only for about the last 27 hours (about
 * 220,000 blocks, measured 18 November 2026) and answers an EMPTY list for
 * anything older, as if nothing happened there. BNB Chain's own dataseed RPCs
 * refuse eth_getLogs ("limit exceeded"). So every read for this network goes
 * through guardPrunedLogs (src/rpc.ts): an empty answer about old blocks is
 * checked against USDT's logs at the same blocks, and if those are missing too
 * the read fails loudly (PrunedLogsError) instead of passing as "no events".
 * A keyed RPC that keeps every log goes in the app's env (GLOAM_RPC_URL_56 on
 * the server, NEXT_PUBLIC_BNB_RPC_URL in the browser), never in this file.
 *
 * FILLED IN AFTER THE DEPLOY (DEPLOY-BNB.md): pool, deployBlock, payMemo and
 * payMemoBlock, by contracts/bnb-mainnet-after-deploy.sh, which reads them
 * from the deploy. Write the blocks as bigints (123n). Keep each field on its
 * own line: the after-deploy script finds them by their text.
 */
import type { Address } from "viem";
import { redactRpcUrl } from "./elysium.js";

/** One token the BNB Chain vault lists, with the decimals read on chain. */
export interface BnbToken {
  address: Address;
  decimals: number;
}

export interface BnbMainnetInput {
  /** BNB Smart Chain mainnet's chain id: 56. */
  chainId: number;
  /** Public RPCs, in order: the first answers eth_getLogs (recent blocks only), the rest serve state and sends. No API key. */
  rpcUrls: readonly string[];
  /** The block explorer's base URL, without a trailing slash. */
  explorerUrl: string;
  /** Tether's USDT on BNB Chain (Binance-Peg), 18 decimals. */
  usdt: BnbToken;
  /** USDC on BNB Chain (Binance-Peg), 18 decimals. */
  usdc: BnbToken;
  /** Beldex's BDX, the LayerZero OFT, 9 decimals. */
  bdx: BnbToken;
  /** ShieldPoolPayments on BNB Chain, from the deploy. */
  pool: Address | null;
  /** Block the pool's deploy transaction landed in. */
  deployBlock: bigint | null;
  /** The payment-message board (GloamPayMemo), if deployed. */
  payMemo: Address | null;
  /** Block the board's deploy transaction landed in. */
  payMemoBlock: bigint | null;
}

export const BNB_MAINNET: BnbMainnetInput = {
  chainId: 56,
  rpcUrls: ["https://bsc-rpc.publicnode.com", "https://bsc-dataseed.bnbchain.org"],
  explorerUrl: "https://bscscan.com",
  usdt: { address: "0x55d398326f99059fF775485246999027B3197955", decimals: 18 },
  usdc: { address: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", decimals: 18 },
  bdx: { address: "0x6ad12E761b438beA3EA09F6C6266556Bb24C2181", decimals: 9 },
  pool: null,
  deployBlock: null,
  payMemo: null,
  payMemoBlock: null,
};

/** BNB Smart Chain mainnet's chain id (0x38). */
export const BNB_MAINNET_CHAIN_ID = 56;

/** BNB Smart Chain's testnet (0x61). Gloam has no vault there; never taken for mainnet. */
export const BNB_TESTNET_CHAIN_ID = 97;

/** BNB, the gas coin. The vault lists it as address(0). */
export const BNB_NATIVE_CURRENCY = { name: "BNB", symbol: "BNB", decimals: 18 } as const;

/** Wrapped BNB. Not a pool asset; a cash out to it is refused (it is a token contract). */
export const BNB_WBNB: Address = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";

/** Multicall3, at its usual address on BNB Chain (checked on chain). */
export const BNB_MULTICALL3: Address = "0xcA11bde05977b3631167028862bE2a173976CA11";

/**
 * The public RPCs that refuse eth_getLogs ("limit exceeded"): BNB Chain's own
 * dataseeds. They serve state, receipts and sends, never a log read.
 */
export const BNB_NO_LOG_RPCS: readonly string[] = ["https://bsc-dataseed.bnbchain.org"];

/**
 * Blocks per eth_getLogs the public log RPC takes (publicnode: "exceed maximum
 * block range: 50000"). A keyed RPC with a smaller cap says so and the range
 * is split to it.
 */
export const BNB_LOG_RANGE_DEFAULT = 50_000;

/**
 * How far below the head an empty eth_getLogs answer is trusted without a
 * check: 100,000 blocks, about 12.5 hours, well inside the roughly 27 hours
 * publicnode keeps. Older empty answers are checked against USDT's logs.
 */
export const BNB_TRUST_RECENT_BLOCKS = 100_000n;

/**
 * The canary for pruned logs: USDT on BNB Chain logs dozens of transfers in
 * every block, so three blocks with none of its logs means the RPC has no logs
 * that old (checked 18 November 2026: 136 to 192 of its logs in three blocks at
 * 100,000,000, 110,000,000 and 120,000,000). A read that starts before
 * `sinceBlock` is checked at it; the vault comes long after.
 */
export const BNB_LOG_CANARY = {
  address: "0x55d398326f99059fF775485246999027B3197955" as Address,
  blocks: 3n,
  sinceBlock: 100_000_000n,
  trustRecentBlocks: BNB_TRUST_RECENT_BLOCKS,
  hint: "BNB Chain's public RPCs keep about a day of logs. Use an RPC that keeps every log (on gloam.trade: GLOAM_RPC_URL_56, NEXT_PUBLIC_BNB_RPC_URL).",
} as const;

/** Chain ids Gloam already runs on, mainnet and testnet: none of them can be BNB Chain. */
const OTHER_GLOAM_CHAIN_IDS = new Set([1, 4663, 4217, 8453, 99901, 46630, 42431, 84532, 11155111, 99801]);

/** BNB Chain mainnet with every value in and checked. */
export interface BnbMainnet {
  chainId: number;
  rpcUrls: readonly string[];
  explorerUrl: string;
  usdt: BnbToken;
  usdc: BnbToken;
  bdx: BnbToken;
  pool: Address;
  deployBlock: bigint;
  payMemo: { address: Address; deployBlock: bigint } | null;
}

const isAddress = (v: unknown): v is Address => typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v) && !/^0x0{40}$/.test(v);
const isHttpsUrl = (v: unknown): v is string => typeof v === "string" && /^https:\/\/[^\s/]+[^\s]*$/.test(v);

function checkToken(t: BnbToken | null | undefined, name: string): BnbToken {
  if (!t || !isAddress(t.address)) throw new Error(`${name}.address is not a token address: ${t?.address}`);
  if (!Number.isInteger(t.decimals) || t.decimals < 0 || t.decimals > 36) throw new Error(`${name}.decimals is not a decimals count: ${t.decimals}`);
  return { address: t.address, decimals: t.decimals };
}

/**
 * Checks a set of BNB Chain values. Returns null while the pool or its block
 * is missing; throws on a value that is in but wrong (another chain's id, the
 * testnet's, an RPC that is not https, a token that is not an address), so a
 * typo fails loudly instead of pointing money at the wrong chain or contract.
 */
export function checkBnbMainnet(input: BnbMainnetInput, name = "BNB_MAINNET"): BnbMainnet | null {
  const { chainId, rpcUrls, explorerUrl, pool, deployBlock, payMemo, payMemoBlock } = input;
  if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new Error(`${name}.chainId is not a chain id: ${chainId}`);
  if (chainId === BNB_TESTNET_CHAIN_ID) throw new Error(`${name}.chainId is ${chainId}, BNB Chain's testnet, not its mainnet`);
  if (OTHER_GLOAM_CHAIN_IDS.has(chainId)) throw new Error(`${name}.chainId is ${chainId}, another chain Gloam runs on`);
  if (chainId !== BNB_MAINNET_CHAIN_ID) throw new Error(`${name}.chainId must be ${BNB_MAINNET_CHAIN_ID}, BNB Smart Chain mainnet's, got ${chainId}`);
  if (!Array.isArray(rpcUrls) || rpcUrls.length === 0) throw new Error(`${name}.rpcUrls must list at least one RPC`);
  for (const u of rpcUrls) if (!isHttpsUrl(u)) throw new Error(`${name}.rpcUrls must be https URLs, got ${u}`);
  if (!isHttpsUrl(explorerUrl)) throw new Error(`${name}.explorerUrl must be an https URL, got ${explorerUrl}`);
  const usdt = checkToken(input.usdt, `${name}.usdt`);
  const usdc = checkToken(input.usdc, `${name}.usdc`);
  const bdx = checkToken(input.bdx, `${name}.bdx`);
  if (pool === null || deployBlock === null) return null;
  if (!isAddress(pool)) throw new Error(`${name}.pool is not a pool address: ${pool}`);
  if (deployBlock <= 0n) throw new Error(`${name}.deployBlock must be the deploy block, got ${deployBlock}`);
  let memo: BnbMainnet["payMemo"] = null;
  if (payMemo !== null || payMemoBlock !== null) {
    if (!isAddress(payMemo)) throw new Error(`${name}.payMemo is not an address: ${payMemo}`);
    if (payMemoBlock === null || payMemoBlock <= 0n) throw new Error(`${name}.payMemoBlock must be the board's deploy block, got ${payMemoBlock}`);
    memo = { address: payMemo, deployBlock: payMemoBlock };
  }
  return { chainId, rpcUrls: [...rpcUrls], explorerUrl: explorerUrl.replace(/\/+$/, ""), usdt, usdc, bdx, pool, deployBlock, payMemo: memo };
}

/** This file is public and ships in the npm package: an RPC URL with an API key in it is refused. */
function noKeyInFile(input: BnbMainnetInput, name: string) {
  for (const u of input.rpcUrls) {
    if (redactRpcUrl(u) !== u) {
      throw new Error(`${name}.rpcUrls has an API key in it; put a keyed RPC in the app's NEXT_PUBLIC_BNB_RPC_URL or GLOAM_RPC_URL_56, never in this file`);
    }
  }
}

/** BNB Chain mainnet as filled in above, or null until its pool and deploy block are in. */
export function bnbMainnetConfig(): BnbMainnet | null {
  noKeyInFile(BNB_MAINNET, "BNB_MAINNET");
  return checkBnbMainnet(BNB_MAINNET);
}
