/**
 * Elysium in the app: Kinetiq's Hyperliquid L2, an Arbitrum Orbit chain that
 * settles to HyperEVM, gas paid in HYPE, blocks about every 100 ms. Mainnet is
 * chain 99901, its testnet 99801 (Kinetiq's docs).
 *
 * Off unless NEXT_PUBLIC_ELYSIUM_ENABLED is "1" (or "true") AND every value is
 * in. The values come from the SDK's one config (packages/sdk/src/elysium.ts),
 * and each can be set or replaced at build time by its NEXT_PUBLIC_ELYSIUM_*
 * variable below, so launch day can run from Vercel's settings with no commit:
 *
 *   NEXT_PUBLIC_ELYSIUM_ENABLED=1
 *   NEXT_PUBLIC_ELYSIUM_CHAIN_ID         99901, already in the SDK file; anything else fails the build
 *   NEXT_PUBLIC_ELYSIUM_RPC_URL          an RPC that answers eth_getLogs. It may carry an API key
 *                                        (Kinetiq recommends https://elysium-mainnet.g.alchemy.com/v2/{API_KEY}):
 *                                        it is then in the browser bundle, so restrict the key to
 *                                        gloam.trade in its dashboard. Pages, Glim and the MCP only
 *                                        ever show it redacted (ELYSIUM_RPC_DISPLAY). The server can
 *                                        use its own GLOAM_RPC_URL_99901 instead (lib/serverRpc).
 *   NEXT_PUBLIC_ELYSIUM_EXPLORER_URL     the block explorer
 *   NEXT_PUBLIC_ELYSIUM_USDC             USDC on Elysium
 *   NEXT_PUBLIC_ELYSIUM_USDC_DECIMALS    6 unless checked otherwise
 *   NEXT_PUBLIC_ELYSIUM_POOL             the vault, from the deploy
 *   NEXT_PUBLIC_ELYSIUM_DEPLOY_BLOCK     its deploy block
 *   NEXT_PUBLIC_ELYSIUM_PAY_MEMO         the memo board, optional
 *   NEXT_PUBLIC_ELYSIUM_PAY_MEMO_BLOCK   its deploy block
 *   NEXT_PUBLIC_ELYSIUM_LOG_RANGE        largest eth_getLogs range the RPC takes, default 1,000,000
 *                                        blocks (about 28 hours at 100 ms; the public RPCs cap logs, not range)
 *   NEXT_PUBLIC_ELYSIUM_LIVE_SINCE       the day it went live, as the copy writes dates
 *
 *
 * Elysium's testnet (network key "elysium", like Base Sepolia: the mainnet vault
 * born guarded, the final keys, test USDC) has its own switch,
 * NEXT_PUBLIC_ELYSIUM_TESTNET_ENABLED, and needs its pool in
 * (packages/sdk/src/elysium.ts ELYSIUM_TESTNET, written by
 * contracts/elysium-testnet-after-deploy.sh, or NEXT_PUBLIC_ELYSIUM_TESTNET_POOL
 * and NEXT_PUBLIC_ELYSIUM_TESTNET_DEPLOY_BLOCK, plus the optional
 * NEXT_PUBLIC_ELYSIUM_TESTNET_PAY_MEMO / _PAY_MEMO_BLOCK / _RPC_URL).
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
import {
  ELYSIUM_LOG_RANGE_DEFAULT,
  ELYSIUM_MAINNET,
  ELYSIUM_MAINNET_CHAIN_ID,
  ELYSIUM_TESTNET as SDK_ELYSIUM_TESTNET,
  checkElysiumMainnet,
  checkElysiumTestnet,
  redactRpcUrl,
  type ElysiumMainnet,
  type ElysiumMainnetInput,
  type ElysiumTestnet,
} from "@gloamtrade/sdk";

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
  // Only Elysium mainnet's published id (99901) counts; anything else fails the build once every value is in.
  return id === ELYSIUM_MAINNET_CHAIN_ID ? id : null;
})();

/**
 * Largest eth_getLogs block range Elysium's RPC takes. Blocks come about every
 * 100 ms, and the public RPCs cap a call at 10,000 logs rather than at a range,
 * so the default is 1,000,000 blocks (about 28 hours). An RPC with a range cap
 * (some keyed plans have one) sets NEXT_PUBLIC_ELYSIUM_LOG_RANGE to it.
 */
export const ELYSIUM_LOG_RANGE: bigint = (() => {
  const n = intFrom(process.env.NEXT_PUBLIC_ELYSIUM_LOG_RANGE, ELYSIUM_LOG_RANGE_DEFAULT);
  return n !== null && Number.isSafeInteger(n) && n >= 1_000 ? BigInt(n) : BigInt(ELYSIUM_LOG_RANGE_DEFAULT);
})();

/** Elysium mainnet's RPC as pages, Glim and the MCP may show it: an API key in it is replaced by {API_KEY}. */
export const ELYSIUM_RPC_DISPLAY: string | null = ELYSIUM ? redactRpcUrl(ELYSIUM.rpcUrl) : null;

/** The testnet switch on its own, values or not. */
export const ELYSIUM_TESTNET_FLAG = /^(1|true|on|yes)$/i.test((process.env.NEXT_PUBLIC_ELYSIUM_TESTNET_ENABLED ?? "").trim());

/** The SDK's testnet values with any NEXT_PUBLIC_ELYSIUM_TESTNET_* set on top. */
export function elysiumTestnetInput(): ElysiumMainnetInput {
  const sdk = SDK_ELYSIUM_TESTNET;
  return {
    ...sdk,
    rpcUrl: text(process.env.NEXT_PUBLIC_ELYSIUM_TESTNET_RPC_URL) ?? sdk.rpcUrl,
    pool: (text(process.env.NEXT_PUBLIC_ELYSIUM_TESTNET_POOL) as `0x${string}` | null) ?? sdk.pool,
    deployBlock: blockFrom(process.env.NEXT_PUBLIC_ELYSIUM_TESTNET_DEPLOY_BLOCK, sdk.deployBlock),
    payMemo: (text(process.env.NEXT_PUBLIC_ELYSIUM_TESTNET_PAY_MEMO) as `0x${string}` | null) ?? sdk.payMemo,
    payMemoBlock: blockFrom(process.env.NEXT_PUBLIC_ELYSIUM_TESTNET_PAY_MEMO_BLOCK, sdk.payMemoBlock),
  };
}

/**
 * Elysium testnet as the app runs it: null while its switch is off or its pool
 * is not in. Throws on a wrong value only while the switch is on.
 */
export const ELYSIUM_TESTNET: ElysiumTestnet | null = ELYSIUM_TESTNET_FLAG
  ? checkElysiumTestnet(elysiumTestnetInput(), "Elysium testnet (NEXT_PUBLIC_ELYSIUM_TESTNET_* or packages/sdk/src/elysium.ts)")
  : null;

/** True for Elysium testnet's chain id (99801) while it is on. */
export function isElysiumTestnetChainId(chainId: unknown): boolean {
  return ELYSIUM_TESTNET !== null && Number(chainId) === ELYSIUM_TESTNET.chainId;
}

/** True for either Elysium network while it is on: HYPE gas, USDC only, no native shield. */
export function isElysiumFamilyChainId(chainId: unknown): boolean {
  return isElysiumChainId(chainId) || isElysiumTestnetChainId(chainId);
}

/** The day Elysium went live, written the way the copy writes dates. */
export const ELYSIUM_LIVE_SINCE = text(process.env.NEXT_PUBLIC_ELYSIUM_LIVE_SINCE) ?? "9 November 2026";

/** True for Elysium's chain id while it is on. */
export function isElysiumChainId(chainId: unknown): boolean {
  return ELYSIUM !== null && Number(chainId) === ELYSIUM.chainId;
}

const ELYSIUM_PRIVATE_TRIAL_KEY = "gloam:elysium-private-trial";

/**
 * The private landing on Elysium is off until one has landed end to end. Opening the
 * app once with ?trial=elysium-private turns it on in that browser only, for a test
 * with a small amount; ?trial=off turns it back off.
 */
export function elysiumPrivateTrial(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const flag = new URLSearchParams(window.location.search).get("trial");
    if (flag === "elysium-private") window.localStorage.setItem(ELYSIUM_PRIVATE_TRIAL_KEY, "1");
    if (flag === "off") window.localStorage.removeItem(ELYSIUM_PRIVATE_TRIAL_KEY);
    return window.localStorage.getItem(ELYSIUM_PRIVATE_TRIAL_KEY) === "1";
  } catch {
    return false;
  }
}
