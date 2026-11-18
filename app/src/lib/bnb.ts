/**
 * BNB Chain in the app: BNB Smart Chain mainnet, chain id 56, gas paid in BNB,
 * blocks about every 0.45 s. USDT and USDC have 18 decimals there, BDX 9.
 *
 * OFF by default, like Elysium before its launch: it shows only when
 * NEXT_PUBLIC_BNB_ENABLED is "1" (or "true", "on", "yes") AND its pool is in
 * (packages/sdk/src/bnb.ts, written by contracts/bnb-mainnet-after-deploy.sh,
 * or NEXT_PUBLIC_BNB_POOL and NEXT_PUBLIC_BNB_DEPLOY_BLOCK). A preview build or
 * a missing variable leaves it hidden. Off, or with the pool missing, BNB Chain
 * does not exist anywhere: the app, the API, the relay, the remote MCP, Glim and
 * proofs act as if it were not there. On, a value that is in but wrong fails the
 * build instead of quietly pointing money somewhere else.
 *
 *   NEXT_PUBLIC_BNB_ENABLED            "1" turns it on; unset or anything else: off
 *   NEXT_PUBLIC_BNB_POOL               the vault, from the deploy (overrides the SDK file)
 *   NEXT_PUBLIC_BNB_DEPLOY_BLOCK       its deploy block
 *   NEXT_PUBLIC_BNB_PAY_MEMO           the memo board, optional
 *   NEXT_PUBLIC_BNB_PAY_MEMO_BLOCK     its deploy block
 *   NEXT_PUBLIC_BNB_LOG_RANGE          largest eth_getLogs range the log RPC takes, default 50,000
 *   NEXT_PUBLIC_BNB_LIVE_SINCE         the day it went live, as the copy writes dates; required with the flag
 *   NEXT_PUBLIC_BNB_ARCHIVE_RPC_URL    optional, browser only: an RPC that keeps every log, asked
 *                                      only when the public RPC turns out to have dropped old logs.
 *                                      It is in the browser bundle, so a key in it must be
 *                                      restricted to gloam.trade. Not needed: without it the
 *                                      browser asks gloam.trade's own proxy, which reads through
 *                                      the server's GLOAM_RPC_URL_56.
 *
 * Server only (never NEXT_PUBLIC_):
 *   GLOAM_RPC_URL_56                   REQUIRED before the flag goes on: a BNB Chain RPC that keeps
 *                                      every log from the vault's deploy block (an archive or
 *                                      full-history plan). The relay, the leaf list, stats and proofs
 *                                      read through it (lib/serverRpc).
 *   GLOAM_RELAY_HOURLY_SPEND_56        BNB the relay may spend on gas an hour, default 0.05
 *   GLOAM_RELAY_MAX_GAS_GWEI_56        the relay's gas price ceiling, default 1 gwei ("off" for none)
 *
 * Why the archive RPC matters: BNB Chain's public RPCs keep very little history.
 * publicnode keeps about 27 hours of logs and answers an EMPTY list for older
 * blocks; BNB Chain's own dataseeds refuse log reads. Every read for this network
 * goes through the SDK's guardPrunedLogs (lib/readTransport, lib/serverRpc): an
 * empty answer about old blocks is checked against USDT's logs at the same
 * blocks, and if those are missing too the read fails loudly instead of reading
 * as "no deposits, no payments".
 *
 * NEXT_PUBLIC_ variables are written into the build, so each is named in full
 * below (Next only inlines process.env.NEXT_PUBLIC_X written out like that).
 */
import {
  BNB_LOG_CANARY,
  BNB_LOG_RANGE_DEFAULT,
  BNB_MAINNET,
  BNB_MAINNET_CHAIN_ID,
  checkBnbMainnet,
  type BnbMainnet,
  type BnbMainnetInput,
  type LogCanary,
} from "@gloamtrade/sdk";

/**
 * NEXT_PUBLIC_BNB_ENABLED read as the switch: on only for "1", "true", "on" or
 * "yes" (any case). Unset, empty or anything else is off. csp.config.mjs reads
 * the variable by the same rule.
 */
export function bnbFlagFrom(raw: string | undefined): boolean {
  return /^(1|true|on|yes)$/i.test((raw ?? "").trim());
}

/** The flag on its own, values or not. */
export const BNB_FLAG = bnbFlagFrom(process.env.NEXT_PUBLIC_BNB_ENABLED);

const text = (v: string | undefined) => (v && v.trim() ? v.trim() : null);

function blockFrom(v: string | undefined, fallback: bigint | null): bigint | null {
  const t = text(v);
  if (t === null) return fallback;
  try {
    return BigInt(t);
  } catch {
    // Not a number: checkBnbMainnet refuses -1 as a deploy block.
    return BigInt(-1);
  }
}

/** The SDK's values with any NEXT_PUBLIC_BNB_* set on top. */
export function bnbInput(): BnbMainnetInput {
  const sdk = BNB_MAINNET;
  return {
    ...sdk,
    pool: (text(process.env.NEXT_PUBLIC_BNB_POOL) as `0x${string}` | null) ?? sdk.pool,
    deployBlock: blockFrom(process.env.NEXT_PUBLIC_BNB_DEPLOY_BLOCK, sdk.deployBlock),
    payMemo: (text(process.env.NEXT_PUBLIC_BNB_PAY_MEMO) as `0x${string}` | null) ?? sdk.payMemo,
    payMemoBlock: blockFrom(process.env.NEXT_PUBLIC_BNB_PAY_MEMO_BLOCK, sdk.payMemoBlock),
  };
}

/**
 * BNB Chain as the app runs it: null while the flag is off or the pool is not
 * in. Throws on a wrong value only while the flag is on.
 */
export const BNB: BnbMainnet | null = BNB_FLAG ? checkBnbMainnet(bnbInput(), "BNB Chain (NEXT_PUBLIC_BNB_* or packages/sdk/src/bnb.ts)") : null;

/** BNB Chain is on in this build: the flag and the pool. */
export const BNB_ENABLED = BNB !== null;

/** BNB Chain's chain id, 56. A proof for it uses the final keys whether it is on or not. */
export const BNB_CHAIN_ID = BNB_MAINNET_CHAIN_ID;

/** True for chain 56 while BNB Chain is on. */
export function isBnbChainId(chainId: unknown): boolean {
  return BNB !== null && Number(chainId) === BNB.chainId;
}

/** Largest eth_getLogs range the public log RPC takes (publicnode: 50,000). */
export const BNB_LOG_RANGE: bigint = (() => {
  const t = text(process.env.NEXT_PUBLIC_BNB_LOG_RANGE);
  const n = t === null ? BNB_LOG_RANGE_DEFAULT : Number(t);
  return Number.isSafeInteger(n) && n >= 100 ? BigInt(n) : BigInt(BNB_LOG_RANGE_DEFAULT);
})();

/** The pruned-logs check every BNB Chain read goes through (the SDK's guardPrunedLogs). */
export const BNB_LOG_GUARD: LogCanary = { ...BNB_LOG_CANARY };

/**
 * The browser's archive RPC for old logs, when one is set; else null and the
 * browser asks gloam.trade's proxy (lib/rpcProxy).
 */
export const BNB_BROWSER_ARCHIVE_RPC: string | null = (() => {
  const t = text(process.env.NEXT_PUBLIC_BNB_ARCHIVE_RPC_URL);
  return t && /^https:\/\/\S+$/.test(t) ? t : null;
})();

/**
 * The day BNB Chain went live, written the way the copy writes dates ("21 November
 * 2026"). Set with the flag on launch day; with BNB Chain on and no date the build
 * fails, so no page ever says "live since" with nothing after it.
 */
export const BNB_LIVE_SINCE: string = (() => {
  const t = text(process.env.NEXT_PUBLIC_BNB_LIVE_SINCE);
  if (t) return t;
  if (BNB) throw new Error("BNB Chain is on: set NEXT_PUBLIC_BNB_LIVE_SINCE to the day it went live, for example \"21 November 2026\"");
  return "";
})();

/** BNB's gas price while it is unread: 0.1 gwei, twice what BNB Chain charged on 18 Nov 2026 (0.05 gwei). */
export const BNB_GAS_PRICE_FALLBACK = 100_000_000n;
