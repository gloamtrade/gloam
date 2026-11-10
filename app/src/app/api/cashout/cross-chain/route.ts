import { NextResponse } from "next/server";
import { isAddress } from "viem";
import { clientIp, hitRateLimit } from "@/lib/mcpRemote/rateLimit";
import { getNetwork, isNetworkKey } from "@/lib/networks";
import {
  crossChainAmountProblem,
  crossChainDestination,
  crossChainRelayBody,
  crossChainSource,
  readCrossChainQuote,
  validCrossChainRecipient,
  type CrossChainAsk,
} from "@/lib/cashOutCrossChain";
import { noteRelayQuote } from "@/lib/relayLedger";
import { screenAddresses } from "@/lib/screeningServer";
import { SCREEN_BLOCKED_MESSAGE } from "@/lib/screening";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RELAY_API = "https://api.relay.link";
/** Quotes per IP per minute. Each one makes a fresh strict Relay order. */
const RATE_LIMIT = 12;

function fail(status: number, message: string, headers?: HeadersInit) {
  return NextResponse.json({ ok: false, error: { message } }, { status, headers: { "Cache-Control": "no-store", ...headers } });
}

/**
 * A price and a one-time Relay deposit address for a cash out to another
 * chain (lib/cashOutCrossChain): { network, asset, amount, destination, recipient, refundTo }.
 *
 * `amount` is what the vault will pay the deposit address, in the asset's raw
 * units: the cash out less the vault's fee. The browser then proves the cash
 * out to that address. Relay's answer is refused unless its order pays in
 * exactly that amount of that asset, delivers to `recipient` and refunds to
 * `refundTo` on the vault's chain. Nothing here holds money or a secret.
 */
export async function POST(req: Request) {
  const rate = await hitRateLimit(clientIp(req), "xchain-cashout-quote", RATE_LIMIT);
  if (!rate.allowed) return fail(429, "Too many tries. Wait a minute.", { "Retry-After": String(rate.retryAfterSec) });

  let parsed: unknown;
  try {
    parsed = await req.json();
  } catch {
    return fail(400, "Send the details as JSON.");
  }
  // `null`, a number or an array is valid JSON but not the details
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return fail(400, "Send the details as JSON.");
  const body = parsed as Record<string, unknown>;

  if (typeof body.network !== "string" || !isNetworkKey(body.network)) return fail(400, "Pick a Gloam network.");
  const network = getNetwork(body.network);
  if (network.chain.testnet || !network.pool) return fail(400, "Cashing out to another chain works on mainnet only.");
  const asset = typeof body.asset === "string" && isAddress(body.asset) ? body.asset : "";
  const source = asset ? crossChainSource(network.chainId, asset) : null;
  if (!source) return fail(400, `This can't be cashed out to another chain from ${network.label} yet.`);

  const destination = crossChainDestination(body.destination);
  if (!destination || destination.chainId === network.chainId) return fail(400, "Pick where the money should land.");

  const recipient = typeof body.recipient === "string" ? body.recipient.trim() : "";
  if (!validCrossChainRecipient(destination, recipient)) {
    return fail(400, destination.kind === "svm" ? "Paste a Solana address to receive it." : `Paste a 0x address to receive it on ${destination.chain}.`);
  }
  const refundTo = typeof body.refundTo === "string" ? body.refundTo.trim() : "";
  if (!isAddress(refundTo) || /^0x0{40}$/i.test(refundTo)) return fail(400, "Connect a wallet, so a failed transfer can come back to you.");

  const amountText = typeof body.amount === "string" ? body.amount : "";
  if (!/^\d{1,40}$/.test(amountText)) return fail(400, "Enter an amount.");
  const amount = BigInt(amountText);
  const amountProblem = crossChainAmountProblem(amount, source.decimals);
  if (amountProblem) return fail(400, amountProblem);

  // The wallet that receives on the other chain, and the one a refund goes to.
  const screen = await screenAddresses([recipient, refundTo], { chainId: network.chainId, asset, flow: "cashout" });
  if (!screen.allowed) return fail(403, screen.message ?? SCREEN_BLOCKED_MESSAGE);

  const ask: CrossChainAsk = { sourceChainId: network.chainId, asset, amount, destination, recipient, refundTo };
  const apiKey = process.env.RELAY_API_KEY;
  let res: Response;
  try {
    res = await fetch(`${RELAY_API}/quote`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(apiKey ? { "x-api-key": apiKey } : {}) },
      body: JSON.stringify(crossChainRelayBody(ask, { apiKey: Boolean(apiKey) })),
      signal: AbortSignal.timeout(20_000),
      cache: "no-store",
    });
  } catch {
    return fail(502, "Couldn't reach Relay. Try again.");
  }

  const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok || !data) {
    const msg = typeof data?.message === "string" ? data.message : "";
    return fail(502, /amount|too (low|small)|insufficient/i.test(msg) ? "That amount is too small to send to another chain. Try a little more." : "Relay couldn't make a route right now. Try again.");
  }
  const read = readCrossChainQuote(data, ask);
  if (!read.ok) {
    console.warn("xchain_cashout_quote_refused", read.reason);
    return fail(502, "Relay couldn't make a route right now. Try again.");
  }
  // For /admin's count (lib/relayLedger), with no wallet.
  if (apiKey) await noteRelayQuote(read.quote.requestId, read.quote.depositAddress);
  return NextResponse.json({ ok: true, data: read.quote }, { headers: { "Cache-Control": "no-store" } });
}
