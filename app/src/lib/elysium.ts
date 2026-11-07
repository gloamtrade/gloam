/**
 * Elysium mainnet in the app: Kinetiq's Hyperliquid L2, an Arbitrum Orbit chain
 * that settles to HyperEVM, gas paid in HYPE.
 *
 * Off unless NEXT_PUBLIC_ELYSIUM_ENABLED is "1" (or "true") AND every value is
 * in. The values come from the SDK's one config (packages/sdk/src/elysium.ts),
 * and each can be set or replaced at build time by its NEXT_PUBLIC_ELYSIUM_*
 * variable below, so launch day can run from Vercel's settings with no commit:
 *
 *   NEXT_PUBLIC_ELYSIUM_ENABLED=1
 *   NEXT_PUBLIC_ELYSIUM_CHAIN_ID         Elysium mainnet's chain id
 *   NEXT_PUBLIC_ELYSIUM_RPC_URL          a public RPC that answers eth_getLogs
 *   NEXT_PUBLIC_ELYSIUM_EXPLORER_URL     the block explorer
 *   NEXT_PUBLIC_ELYSIUM_USDC             USDC on Elysium
 *   NEXT_PUBLIC_ELYSIUM_USDC_DECIMALS    6 unless checked otherwise
 *   NEXT_PUBLIC_ELYSIUM_POOL             the vault, from the deploy
 *   NEXT_PUBLIC_ELYSIUM_DEPLOY_BLOCK     its deploy block
 *   NEXT_PUBLIC_ELYSIUM_PAY_MEMO         the memo board, optional
 *   NEXT_PUBLIC_ELYSIUM_PAY_MEMO_BLOCK   its deploy block
 *   NEXT_PUBLIC_ELYSIUM_LOG_RANGE        largest eth_getLogs range the RPC takes, default 50000
 *   NEXT_PUBLIC_ELYSIUM_LIVE_SINCE       the day it went live, as the copy writes dates
 *
 * Off, Elysium does not exist anywhere: the app, the API, the relay, the remote
 * MCP, Glim and proofs act as if it were not there, exactly as a mainnet with
 * no pool. On, a value that is in but wrong (the testnet's chain id, another
 * Gloam chain's, an RPC that is not https, a pool that is not an address) fails
 * the build instead of quietly pointing money somewhere else.
 *
 * NEXT_PUBLIC_ variables are written into the build, so each is named in full
 * below (Next only inlines process.env.NEXT_PUBLIC_X written out like that).
 */
import { ELYSIUM_MAINNET, checkElysiumMainnet, type ElysiumMainnet, type ElysiumMainnetInput } from "@gloamtrade/sdk";

/** The flag on its own, values or not. */
export const ELYSIUM_FLAG = /^(1|true|on|yes)$/i.test((process.env.NEXT_PUBLIC_ELYSIUM_ENABLED ?? "").trim());

const text = (v: string | undefined) => (v && v.trim() ? v.trim() : null);

function intFrom(v: string | undefined, fallback: number | null): number | null {
  const t = text(v);
  return t === null ? fallback : Number(t);
}

function blockFrom(v: string | undefined, fallback: bigint | null): bigint | null {
  const t = text(v);
  if (t === null) return fallback;
  try {
    return BigInt(t);
  } catch {
    // Not a number: checkElysiumMainnet refuses -1 as a deploy block.
    return BigInt(-1);
  }
}

/** The SDK's values with any NEXT_PUBLIC_ELYSIUM_* set on top. */
export function elysiumInput(): ElysiumMainnetInput {
  const sdk = ELYSIUM_MAINNET;
  return {
    chainId: intFrom(process.env.NEXT_PUBLIC_ELYSIUM_CHAIN_ID, sdk.chainId),
    rpcUrl: text(process.env.NEXT_PUBLIC_ELYSIUM_RPC_URL) ?? sdk.rpcUrl,
    explorerUrl: text(process.env.NEXT_PUBLIC_ELYSIUM_EXPLORER_URL) ?? sdk.explorerUrl,
    usdc: (text(process.env.NEXT_PUBLIC_ELYSIUM_USDC) as `0x${string}` | null) ?? sdk.usdc,
    usdcDecimals: intFrom(process.env.NEXT_PUBLIC_ELYSIUM_USDC_DECIMALS, sdk.usdcDecimals) ?? 6,
    pool: (text(process.env.NEXT_PUBLIC_ELYSIUM_POOL) as `0x${string}` | null) ?? sdk.pool,
    deployBlock: blockFrom(process.env.NEXT_PUBLIC_ELYSIUM_DEPLOY_BLOCK, sdk.deployBlock),
    payMemo: (text(process.env.NEXT_PUBLIC_ELYSIUM_PAY_MEMO) as `0x${string}` | null) ?? sdk.payMemo,
    payMemoBlock: blockFrom(process.env.NEXT_PUBLIC_ELYSIUM_PAY_MEMO_BLOCK, sdk.payMemoBlock),
  };
}

/**
 * Elysium mainnet as the app runs it: null while the flag is off or any value
 * is missing. Throws on a wrong value only while the flag is on.
 */
export const ELYSIUM: ElysiumMainnet | null = ELYSIUM_FLAG ? checkElysiumMainnet(elysiumInput(), "Elysium (NEXT_PUBLIC_ELYSIUM_* or packages/sdk/src/elysium.ts)") : null;

/** Elysium is on in this build: the flag and every value. */
export const ELYSIUM_ENABLED = ELYSIUM !== null;

/**
 * Elysium's chain id while the flag is on and the id is in, pool or not, so a
 * proof for it is never made with the dev keys. Null otherwise.
 */
export const ELYSIUM_CHAIN_ID: number | null = (() => {
  if (!ELYSIUM_FLAG) return null;
  if (ELYSIUM) return ELYSIUM.chainId;
  const id = elysiumInput().chainId;
  const taken = [99801, 1, 4663, 4217, 8453, 46630, 42431, 84532, 11155111];
  return id !== null && Number.isSafeInteger(id) && id > 0 && !taken.includes(id) ? id : null;
})();

/** Largest eth_getLogs block range Elysium's RPC takes. Arbitrum Orbit nodes take large ones; public gateways cap them. */
export const ELYSIUM_LOG_RANGE: bigint = (() => {
  const n = intFrom(process.env.NEXT_PUBLIC_ELYSIUM_LOG_RANGE, 50_000);
  return n !== null && Number.isSafeInteger(n) && n >= 1_000 ? BigInt(n) : BigInt(50_000);
})();

/** The day Elysium went live, written the way the copy writes dates. */
export const ELYSIUM_LIVE_SINCE = text(process.env.NEXT_PUBLIC_ELYSIUM_LIVE_SINCE) ?? "9 November 2026";

/** True for Elysium's chain id while it is on. */
export function isElysiumChainId(chainId: unknown): boolean {
  return ELYSIUM !== null && Number(chainId) === ELYSIUM.chainId;
}
