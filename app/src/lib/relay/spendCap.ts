/**
 * The most the relay spends on gas in an hour, per chain, across every kind of send.
 * New sends may use NEW_SEND_SHARE_PCT of it, and cash outs CASH_OUT_SHARE_PCT. The
 * last part is kept for refunds and exits alone, so money on its way back from a swap
 * can always come back. Each send holds what it could cost before it goes, and gives
 * back what it didn't use once its receipt is read. On Base that includes the fee for
 * posting it to Ethereum (L1_FEE_MARGIN_PCT).
 *
 * One sender (an IP, or a partner account) may hold a share of the cap in an hour,
 * every kind of send it asks for together, apart from refunds and exits: the larger of
 * SENDER_SHARE_PCT of the cap and PAYROLL_SENDS sends like the one being held (their
 * dry-run gas at the network's gas price now, unpadded), but never more than
 * MAX_SENDER_SHARE_PCT. So a 200-payment payroll from one browser fits its share up to
 * about 0.034 gwei on Robinhood Chain, 0.016 on Base and 0.084 on Ethereum (on 2 November:
 * about 0.02, 0.006 and 0.04), and one sender always leaves part of the new-send part
 * to everyone else. A partner account no admin approved holds against the calling IP's
 * share as well as its own: accounts are free to make, an IP is not.
 * GLOAM_RELAY_SENDER_SHARE_<chainId> sets the percent, or "off" for no share. The
 * busiest hour so far, every sender together, used about 6%.
 *
 * Refunds and exits hold against no sender's share. On a chain without a swap floor
 * (lib/relay/swapFloor), the ones an IP asks for hold against a budget of their own
 * (BACK_SHARE_PCT, or five like the one being held at today's gas if that is more): that
 * IP's sends never stand in the way of its refunds. Where there is a floor, refunds under
 * it have their own hourly budget instead.
 *
 * GLOAM_RELAY_HOURLY_SPEND_<chainId> (server env) sets it, in the chain's gas coin
 * ("0.02"); "off" turns it off for that chain. The defaults sit well over what the
 * chains have used so far (peak hour to 2 November 2026: none on Ethereum, 15 sends on
 * Base, 34 on Robinhood Chain, 1 on Tempo) and leave room for a 200-person payroll at
 * ordinary gas. A chain not listed has no cap.
 *
 * GLOAM_RELAY_IP_SENDS_<chainId> sets how many sends one IP may ask for in 10 minutes
 * on a chain with a lower limit than the relay's own, or "off" for none. Payment
 * messages don't count, and a browser proves each send first, so a payroll stays under it.
 *
 * What reverts has a share of its own per sender (R3, 7 November 2026 router review): a
 * send that reverts on chain burns the relay's gas and brings nothing back, and apart from
 * Ethereum's swap budgets only the hourly cap stood in its way. Each send holds what it
 * could cost against its sender's revert share too, and keeps it counted only if it
 * reverts (or no receipt was seen): the larger of REVERT_SHARE_PCT of the cap and
 * REVERT_SENDS sends like it at today's gas, never past MAX_SENDER_SHARE_PCT. It applies
 * to every kind of send, refunds and exits included where there is no swap floor (where
 * there is one, its own budgets apply). Scheduled cash outs keep no IP, so they all hold
 * as one sender, SCHEDULED_SENDER, against both this share and the sender share.
 * GLOAM_RELAY_REVERT_SHARE_<chainId> sets the percent, or "off" for none.
 */
import { parseEther } from "viem";
import { ELYSIUM } from "../elysium";

type Env = Record<string, string | undefined>;

export const DEFAULT_HOURLY_SPEND: Readonly<Record<number, string>> = {
  1: "0.05",
  8453: "0.01",
  4663: "0.02",
  4217: "1",
  // Elysium, in HYPE, only while it is on (lib/elysium): a starting guess, sized like
  // Base's. Check it against real gas on launch day (DEPLOY-ELYSIUM.md) and set
  // GLOAM_RELAY_HOURLY_SPEND_<chainId> to change it without a deploy.
  ...(ELYSIUM ? { [ELYSIUM.chainId]: "1" } : {}),
};
export const NEW_SEND_SHARE_PCT = 80n;
/** Cash outs stop here. What is left above it is for refunds and exits only. */
export const CASH_OUT_SHARE_PCT = 92n;
/** A sender's share fits this many sends like the one being held, up to MAX_SENDER_SHARE_PCT: a payroll's most payments. */
export const PAYROLL_SENDS = 200n;
/** No sender's share passes this part of the cap, whatever a payroll would cost. */
export const MAX_SENDER_SHARE_PCT = 60n;
/**
 * The refunds and exits one IP asks for, on a chain without a swap floor: the larger of this
 * share of the cap an hour and BACK_SENDS like the one being held at today's gas, never more
 * than the part of the cap kept for refunds and exits.
 */
export const BACK_SHARE_PCT = 2n;
export const BACK_SENDS = 5n;
/** Payment messages outside the relay's paid message budget may hold this share of the cap between them. */
export const MEMO_SPEND_SHARE_PCT = 20n;
export const DEFAULT_IP_SENDS: Readonly<Record<number, number>> = { 1: 120 };
/** A sender's sends that revert may burn this share of the cap an hour, or REVERT_SENDS like the one being held if that is more. */
export const DEFAULT_REVERT_SHARE_PCT = 10;
export const REVERT_SENDS = 20n;
/** Who every scheduled cash out holds as: jobs keep no IP, so they share one sender. No ":" (lib/mcpRemote/rateLimit reads that as IPv6). */
export const SCHEDULED_SENDER = "later|scheduled";
export const DEFAULT_SENDER_SHARE_PCT = 40;
/**
 * Chains that charge for posting a transaction to Ethereum on top of its gas. A send
 * there holds this much more than its gas, and settles at what its receipt shows (l1Fee).
 * Measured on Base: about 1% of the gas normally, 38% in one spike.
 */
export const L1_FEE_MARGIN_PCT: Readonly<Record<number, bigint>> = { 8453: 50n, 84532: 50n };

const warned = new Set<string>();

function warnOnce(name: string) {
  if (!warned.has(name)) console.warn("gloam_relay_limit_invalid", JSON.stringify({ name }));
  warned.add(name);
}

/** The chain's cap in its gas coin's smallest unit, or null when it has none. A value that isn't a number keeps the default. */
export function hourlySpendWei(chainId: number, env: Env = process.env): bigint | null {
  const name = `GLOAM_RELAY_HOURLY_SPEND_${chainId}`;
  const raw = env[name]?.trim();
  const fallback = DEFAULT_HOURLY_SPEND[chainId];
  if (raw?.toLowerCase() === "off") return null;
  if (raw) {
    if (/^\d{1,9}(\.\d{1,18})?$/.test(raw) && parseEther(raw) > 0n) return parseEther(raw);
    warnOnce(name);
  }
  return fallback ? parseEther(fallback) : null;
}

/** Sends one IP may ask for in 10 minutes on this chain, or null when only the relay's own limit applies. */
export function ipSendsLimit(chainId: number, env: Env = process.env): number | null {
  const name = `GLOAM_RELAY_IP_SENDS_${chainId}`;
  const raw = env[name]?.trim();
  if (raw?.toLowerCase() === "off") return null;
  if (raw) {
    const n = Number(raw);
    if (Number.isSafeInteger(n) && n > 0) return n;
    warnOnce(name);
  }
  return DEFAULT_IP_SENDS[chainId] ?? null;
}

/** The share of the cap one sender may hold in an hour, in percent, or null for no share of its own. */
export function senderSharePct(chainId: number, env: Env = process.env): number | null {
  const name = `GLOAM_RELAY_SENDER_SHARE_${chainId}`;
  const raw = env[name]?.trim();
  if (raw?.toLowerCase() === "off") return null;
  if (raw) {
    const n = Number(raw);
    if (Number.isSafeInteger(n) && n > 0 && n <= 100) return n;
    warnOnce(name);
  }
  return DEFAULT_SENDER_SHARE_PCT;
}

/** The share of the cap one sender's reverted sends may burn in an hour, in percent, or null for none. */
export function revertSharePct(chainId: number, env: Env = process.env): number | null {
  const name = `GLOAM_RELAY_REVERT_SHARE_${chainId}`;
  const raw = env[name]?.trim();
  if (raw?.toLowerCase() === "off") return null;
  if (raw) {
    const n = Number(raw);
    if (Number.isSafeInteger(n) && n > 0 && n <= 100) return n;
    warnOnce(name);
  }
  return DEFAULT_REVERT_SHARE_PCT;
}
