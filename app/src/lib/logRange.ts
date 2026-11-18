/**
 * getLogs over a block range that the node may refuse as too wide or too big
 * (Robinhood Chain's RPC refuses a query matching more than 10,000 logs):
 * retried on a transient failure, halved on a range error. Shared by the vault
 * scanner (lib/onchainMetrics) and the creator-fee read (lib/creatorFees).
 */
import type { Log } from "viem";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function errText(e: unknown): string {
  if (e && typeof e === "object") {
    const o = e as { details?: unknown; shortMessage?: unknown; message?: unknown };
    return String(o.details ?? o.shortMessage ?? o.message ?? e);
  }
  return String(e);
}

/** The node refusing a span as too wide or too big (not a rate limit). */
const RANGE_ERROR =
  /block range|range (is )?too|exceeds? (the )?max|max(imum)? block|only \d+ are allowed|more than \d+ (results|logs)|too many (results|logs)|response size|query timeout|query timed out|limit exceeded|exceeds limit of \d+|logs matched by query/i;

export function isRateLimit(e: unknown): boolean {
  const status = (e as { status?: number })?.status;
  return status === 429 || /429|too many requests|rate ?limit/i.test(errText(e));
}

/** A log read the node refused as too wide or too big: an answer about the range, which a walk splits on. */
export function isRangeError(e: unknown): boolean {
  return !isRateLimit(e) && RANGE_ERROR.test(errText(e));
}

/**
 * getLogs for one range: retries transient failures, halves the range when the
 * node says it is too wide. Generic so typed event logs (getLogs with `events`)
 * keep their decoded args.
 */
export async function getLogsSafe<T = Log>(
  fetchRange: (from: bigint, to: bigint) => Promise<T[]>,
  from: bigint,
  to: bigint,
  depth = 0
): Promise<T[]> {
  let last: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await fetchRange(from, to);
    } catch (e) {
      last = e;
      if (!isRateLimit(e) && RANGE_ERROR.test(errText(e)) && to > from && depth < 10) {
        const mid = from + (to - from) / 2n;
        const a = await getLogsSafe(fetchRange, from, mid, depth + 1);
        const b = await getLogsSafe(fetchRange, mid + 1n, to, depth + 1);
        return [...a, ...b];
      }
      await sleep(1500 * (attempt + 1));
    }
  }
  throw last;
}

