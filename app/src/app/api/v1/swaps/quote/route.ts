import { ApiError, jsonBody, requireKeyEnv, withApiKey } from "@/lib/partnersApi";
import { keyEnvForNetwork } from "@/lib/apiKeys";
import { getNetwork, isNetworkKey, type GloamNetwork } from "@/lib/networks";
import { clientIp, hitRateLimit } from "@/lib/mcpRemote/rateLimit";
import { networkForChain } from "@/lib/relay/server";
import { SWAP_QUOTE_PER_MINUTE, SwapQuoteError, quoteSwapServer } from "@/lib/swapQuote";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** A quote body is a few short fields. */
const MAX_BODY_BYTES = 4_096;

function networkOf(body: Record<string, unknown>): GloamNetwork {
  if (body.network != null) {
    if (typeof body.network !== "string" || !isNetworkKey(body.network)) {
      throw new ApiError(400, "network", "network must be a Gloam network key, e.g. robinhood-mainnet.");
    }
    const net = getNetwork(body.network);
    if (body.chainId != null && Number(body.chainId) !== net.chainId) {
      throw new ApiError(400, "network", "network and chainId name different chains.");
    }
    return net;
  }
  return networkForChain(body.chainId);
}

/**
 * Quote a private swap: { chainId | network, assetIn, assetOut, amountIn, via?, maxImpactBps? }.
 * amountIn is the note's value in base units, as a string. Read only: nothing is
 * proved or sent. The answer has the price, the route, and `stop`, the first thing
 * that would keep this swap from going (null when nothing does). A live key quotes
 * the mainnets, a test key the testnets. Each quote is a few dozen chain reads, so on
 * top of withApiKey's limits it has its own: SWAP_QUOTE_PER_MINUTE per partner account
 * (all its keys together) and per IP. The SDK's quoteSwap prices the same way from
 * your own RPC, with no such limit.
 */
export async function POST(req: Request) {
  return withApiKey(req, async ({ key, partner }) => {
    const body = await jsonBody(req, MAX_BODY_BYTES);
    const net = networkOf(body);
    requireKeyEnv(key, keyEnvForNetwork(net), net.label);
    for (const [who, bucket] of [
      [`partner|${partner.id}`, "api-swap-quote"],
      [clientIp(req), "api-swap-quote-ip"],
    ] as const) {
      const rl = await hitRateLimit(who, bucket, SWAP_QUOTE_PER_MINUTE, Date.now(), 60);
      if (!rl.allowed) {
        throw new ApiError(429, "rate_limited", `At most ${SWAP_QUOTE_PER_MINUTE} swap quotes a minute. Retry in ${rl.retryAfterSec} seconds, or quote with the SDK's quoteSwap on your own RPC.`);
      }
    }
    try {
      return {
        data: await quoteSwapServer(net, { assetIn: body.assetIn, assetOut: body.assetOut, amountIn: body.amountIn, via: body.via, maxImpactBps: body.maxImpactBps }),
      };
    } catch (e) {
      if (e instanceof SwapQuoteError) throw new ApiError(e.status, e.code, e.message);
      throw e;
    }
  });
}
