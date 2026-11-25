import { NextResponse } from "next/server";
import { parseUnits } from "viem";
import { getAddressEncoder, type Address } from "@solana/kit";
import { clientIp, hitRateLimit } from "@/lib/mcpRemote/rateLimit";
import { SOLANA_BRIDGE_IN_ENABLED } from "@/lib/solanaRings/bridgeIn";
import { SOLANA_RINGS_ENABLED, SOLANA_RINGS_NETWORK, ZEC_DECIMALS } from "@/lib/solanaRings/config";
import {
  ONECLICK_API,
  SOLANA_ZCASH_IN_ENABLED,
  ZCASH_PREVIEW_REFUND,
  parseZcashQuote,
  parseZcashStatus,
  zcashQuoteRequest,
  zcashRefusal,
} from "@/lib/solanaRings/zcashIn";
import { validZcashTransparent, zcashRefundProblem } from "@/lib/zcashAddress";
import { screenOtherChainAddresses } from "@/lib/screeningServer";
import { SCREEN_BLOCKED_MESSAGE } from "@/lib/screening";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Quotes per IP per minute. Each real one makes a fresh 1Click deposit address. */
const RATE_LIMIT = 12;
/** Live prices per IP per minute, while an amount is typed. */
const PREVIEW_RATE_LIMIT = 40;
/** Status checks per IP per minute. The panel asks every 5 seconds. */
const STATUS_RATE_LIMIT = 30;
const ROUTE_BUSY = "NEAR Intents couldn't make a route right now. Try again.";

function fail(status: number, message: string, headers?: HeadersInit) {
  return NextResponse.json({ ok: false, error: { message } }, { status, headers: { "Cache-Control": "no-store", ...headers } });
}

function on(): boolean {
  return SOLANA_RINGS_ENABLED && SOLANA_BRIDGE_IN_ENABLED && SOLANA_ZCASH_IN_ENABLED;
}

function isSolanaAddress(v: string): boolean {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v)) return false;
  try {
    return getAddressEncoder().encode(v as Address).length === 32;
  } catch {
    return false;
  }
}

/** The partner JWT, when Gloam has one (server only): 1Click's partner fees instead of its unauthenticated one. */
function keyHeaders(): Record<string, string> {
  const key = process.env.NEAR_INTENTS_API_KEY?.trim();
  return key ? { "X-API-Key": key } : {};
}

/** 1Click's words for the logs, with anything address-like taken out. */
function loggable(message: string): string {
  return message.slice(0, 300).replace(/[1-9A-HJ-NP-Za-km-z]{25,}/g, "[address]");
}

/**
 * A NEAR Intents (1Click) quote for ZEC from a Zcash wallet into a private
 * account on Solana (lib/solanaRings/zcashIn): { amount, recipient, refundTo?, preview? }.
 *
 * `recipient` is the private account's own address; the app makes what lands
 * there private itself (lib/solanaRings/arrivals). `amount` is the ZEC sent
 * from Zcash (exact input), so all of what arrives goes private. `refundTo` is
 * the person's transparent Zcash address (t1 or t3), where 1Click returns the
 * ZEC if it can't deliver.
 *
 * With `preview: true` it is the live price under the amount field: a dry
 * quote, no deposit address, nothing counted; a stand-in refund address is used
 * until one is typed. Both ends are screened. Gloam keeps nothing.
 */
export async function POST(req: Request) {
  if (!on()) return fail(404, "Bringing ZEC over from Zcash isn't on here.");
  // A private account has the same address on every network: never send mainnet money to a devnet build's account.
  if (SOLANA_RINGS_NETWORK !== "mainnet") return fail(400, "NEAR Intents only delivers to Solana mainnet.");

  let parsed: unknown;
  try {
    parsed = await req.json();
  } catch {
    return fail(400, "Send the details as JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return fail(400, "Send the details as JSON.");
  const body = parsed as Record<string, unknown>;
  const preview = body.preview === true;
  const rate = await hitRateLimit(clientIp(req), preview ? "bridge-zcash-preview" : "bridge-zcash", preview ? PREVIEW_RATE_LIMIT : RATE_LIMIT);
  if (!rate.allowed) return fail(429, preview ? "Prices are paused for a minute. Try again shortly." : "Too many tries. Wait a minute.", { "Retry-After": String(rate.retryAfterSec) });

  const recipient = typeof body.recipient === "string" ? body.recipient.trim() : "";
  if (!isSolanaAddress(recipient)) return fail(400, "Open your private account on Solana first.");

  const amountText = typeof body.amount === "string" ? body.amount.trim() : "";
  if (!/^\d{1,12}(\.\d+)?$/.test(amountText) || !(Number(amountText) > 0)) return fail(400, "Enter an amount.");
  // viem rounds extra places away; a deposit amount is never rounded.
  if ((amountText.split(".")[1] ?? "").length > ZEC_DECIMALS) return fail(400, "That amount has too many decimals. ZEC has 8.");
  const amount = parseUnits(amountText, ZEC_DECIMALS);
  if (amount <= 0n) return fail(400, "Enter an amount.");

  const given = typeof body.refundTo === "string" ? body.refundTo.trim() : "";
  // A price needs no refund address yet: 1Click is asked with a well-formed stand-in, and nothing comes back to send to.
  const standIn = preview && !validZcashTransparent(given);
  const refundTo = standIn ? ZCASH_PREVIEW_REFUND : given;
  if (!validZcashTransparent(refundTo)) {
    return fail(400, zcashRefundProblem(refundTo) ?? "Add your Zcash address (t1 or t3), so a failed transfer can be sent back to you.");
  }

  // Both ends: the private account it lands in, and the Zcash address a refund goes to.
  if (!(await screenOtherChainAddresses(standIn ? [recipient] : [recipient, refundTo]))) return fail(403, SCREEN_BLOCKED_MESSAGE);

  const asked = zcashQuoteRequest({ amount, recipient, refundTo, dry: preview, now: Date.now() });
  let res: Response;
  try {
    res = await fetch(`${ONECLICK_API}/v0/quote`, {
      method: "POST",
      headers: { "content-type": "application/json", ...keyHeaders() },
      body: JSON.stringify(asked),
      signal: AbortSignal.timeout(20_000),
      cache: "no-store",
    });
  } catch {
    return fail(502, "Couldn't reach NEAR Intents. Try again.");
  }
  const data = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) {
    const message = data && typeof data === "object" && typeof (data as { message?: unknown }).message === "string" ? (data as { message: string }).message : "";
    // Why 1Click said no, for the logs: its status and words, never an address or the amount asked.
    console.warn("[bridge/solana-zcash] 1Click refused the quote", { status: res.status, message: loggable(message), preview });
    const why = zcashRefusal(message);
    return fail(why ? 400 : 502, why ?? ROUTE_BUSY);
  }
  const quote = parseZcashQuote(data, asked);
  if (!quote.ok) {
    if (quote.status === 502) console.warn("[bridge/solana-zcash] 1Click answered a different route or shape", { preview });
    return fail(quote.status, quote.message);
  }
  return NextResponse.json({ ok: true, data: quote.quote }, { headers: { "Cache-Control": "no-store" } });
}

/** Where a transfer stands: ?depositAddress=t1… from the quote. */
export async function GET(req: Request) {
  if (!on()) return fail(404, "Bringing ZEC over from Zcash isn't on here.");
  const rate = await hitRateLimit(clientIp(req), "bridge-zcash-status", STATUS_RATE_LIMIT);
  if (!rate.allowed) return fail(429, "Too many checks. Wait a minute.", { "Retry-After": String(rate.retryAfterSec) });

  const depositAddress = new URL(req.url).searchParams.get("depositAddress") ?? "";
  if (!validZcashTransparent(depositAddress)) return fail(400, "Unknown transfer.");

  let res: Response;
  try {
    res = await fetch(`${ONECLICK_API}/v0/status?depositAddress=${encodeURIComponent(depositAddress)}`, {
      headers: keyHeaders(),
      signal: AbortSignal.timeout(10_000),
      cache: "no-store",
    });
  } catch {
    return fail(502, "Couldn't check the transfer. Trying again.");
  }
  if (res.status === 404) return fail(404, "NEAR Intents doesn't know this transfer yet.");
  const data = (await res.json().catch(() => null)) as unknown;
  const status = res.ok ? parseZcashStatus(data, depositAddress) : null;
  if (!status) return fail(502, "Couldn't check the transfer. Trying again.");
  return NextResponse.json({ ok: true, data: status }, { headers: { "Cache-Control": "no-store" } });
}
