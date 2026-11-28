/* eslint-disable @typescript-eslint/no-explicit-any -- Relay's quote JSON is read field by field and checked below */
import { NextResponse } from "next/server";
import { formatUnits, isAddress, parseUnits } from "viem";
import { getAddressEncoder, type Address } from "@solana/kit";
import { clientIp, hitRateLimit } from "@/lib/mcpRemote/rateLimit";
import { displayAmountNumber } from "@/lib/amountShort";
import {
  BRIDGE_MAX_USD,
  BRIDGE_MIN_USD,
  RELAY_REFERRER,
  bridgeChain,
  bridgeFeeSetting,
  bridgeToken,
  quotedAppFee,
  relayAppFees,
  validRefundAddress,
  walletBridgeTxs,
} from "@/lib/bridge";
import {
  PREVIEW_STAND_IN,
  RELAY_SOLANA_CHAIN_ID,
  SOLANA_BRIDGE_IN_ENABLED,
  landingAssets,
  orNames,
  relayCurrency,
  relayRefusal,
  solanaBridgeSources,
  type SolanaBridgeQuote,
} from "@/lib/solanaRings/bridgeIn";
import { SOLANA_RINGS_ENABLED, SOLANA_RINGS_NETWORK } from "@/lib/solanaRings/config";
import { noteRelayQuote } from "@/lib/relayLedger";
import { screenAddresses, screenOtherChainAddresses } from "@/lib/screeningServer";
import { SCREEN_BLOCKED_MESSAGE } from "@/lib/screening";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RELAY_API = "https://api.relay.link";
/** Quotes per IP per minute. Each one makes a fresh Relay order (and a deposit address). */
const RATE_LIMIT = 12;
/** Live prices per IP per minute, while an amount is typed (one per pause, one every 20 seconds after). */
const PREVIEW_RATE_LIMIT = 40;
const ROUTE_BUSY = "The bridge couldn't make a route right now. Try again.";
const ADDRESS_NAME: Record<string, string> = { svm: "Solana", tvm: "Tron", bvm: "Bitcoin" };

function fail(status: number, message: string, headers?: HeadersInit) {
  return NextResponse.json({ ok: false, error: { message } }, { status, headers: { "Cache-Control": "no-store", ...headers } });
}

function isSolanaAddress(v: string): boolean {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v)) return false;
  try {
    return getAddressEncoder().encode(v as Address).length === 32;
  } catch {
    return false;
  }
}

/**
 * A Relay order that delivers to a private account on Solana (lib/solanaRings/bridgeIn):
 * { chainId, symbol, asset: "usdc" | "usdt" | "sol" | "zec", amount, recipient, sender? , refundTo? }.
 *
 * `recipient` is the private account's own address; the app makes what lands
 * there private itself (lib/solanaRings/arrivals). `amount` is what is sent
 * (EXACT_INPUT), so all of what arrives goes private and nothing is left over.
 *  - With `sender` (an EVM wallet on an EVM chain), the wallet pays: the quote
 *    carries what it signs (an approve and the deposit, or the deposit alone),
 *    checked by walletBridgeTxs, and a refund goes back to it.
 *  - Otherwise a one-time deposit address, paid from any wallet or exchange; a
 *    refund goes to `refundTo`, the person's address on the source chain.
 * Gloam keeps nothing unless BRIDGE_FEE_BPS is set; the quote says so either way.
 *
 * With `preview: true` it is the live price under the amount field: the same
 * Relay order shape (wallet or deposit address), but nothing to act on comes
 * back (no deposit address, nothing to sign) and it isn't counted. A refund
 * address isn't needed yet; a stand-in of the source chain's kind is used.
 * When Relay refuses, the reason is logged (code and message, no addresses or
 * amount) and said plainly: under its minimum, no route, too large.
 */
export async function POST(req: Request) {
  if (!SOLANA_RINGS_ENABLED || !SOLANA_BRIDGE_IN_ENABLED) return fail(404, "Bringing money over to Solana isn't on here.");
  // A private account has the same address on every network: never send mainnet money to a devnet build's account.
  if (SOLANA_RINGS_NETWORK !== "mainnet") return fail(400, "Relay only delivers to Solana mainnet.");

  let parsed: unknown;
  try {
    parsed = await req.json();
  } catch {
    return fail(400, "Send the details as JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return fail(400, "Send the details as JSON.");
  const body = parsed as Record<string, unknown>;
  const preview = body.preview === true;
  const rate = await hitRateLimit(clientIp(req), preview ? "bridge-solana-preview" : "bridge-solana", preview ? PREVIEW_RATE_LIMIT : RATE_LIMIT);
  if (!rate.allowed) return fail(429, preview ? "Prices are paused for a minute. Try again shortly." : "Too many tries. Wait a minute.", { "Retry-After": String(rate.retryAfterSec) });

  const chain = solanaBridgeSources().find((c) => c.id === Number(body.chainId)) ?? null;
  const token = chain && typeof body.symbol === "string" ? bridgeToken(chain, body.symbol) : null;
  if (!chain || !token || !bridgeChain(chain.id)) return fail(400, "Pick where the money is coming from.");
  const asset = landingAssets().find((a) => a.id === body.asset);
  if (!asset) return fail(400, `Pick what it lands as: ${orNames(landingAssets())}.`);

  const recipient = typeof body.recipient === "string" ? body.recipient.trim() : "";
  if (!isSolanaAddress(recipient)) return fail(400, "Open your private account on Solana first.");

  const amountText = typeof body.amount === "string" ? body.amount.trim() : "";
  if (!/^\d+(\.\d+)?$/.test(amountText) || !(Number(amountText) > 0)) return fail(400, "Enter an amount.");
  if (token.stable && (Number(amountText) < BRIDGE_MIN_USD || Number(amountText) > BRIDGE_MAX_USD)) {
    return fail(400, `Enter an amount from ${displayAmountNumber(BRIDGE_MIN_USD)} to ${displayAmountNumber(BRIDGE_MAX_USD)}.`);
  }
  let amount: bigint;
  try {
    amount = parseUnits(amountText, token.decimals);
  } catch {
    return fail(400, "That amount has too many decimals.");
  }

  // The wallet pays (an EVM wallet on its own chain), or a deposit address does.
  const sender = typeof body.sender === "string" ? body.sender.trim() : "";
  const fromWallet = sender !== "" && chain.kind === "evm";
  if (fromWallet && !isAddress(sender)) return fail(400, "Pay from the wallet that's connected.");
  const given = fromWallet ? sender : typeof body.refundTo === "string" ? body.refundTo.trim() : "";
  // A price needs no refund address yet: Relay is asked for a well-formed stand-in, and nothing comes back to send to.
  const standIn = preview && !validRefundAddress(chain.kind, given);
  const refundTo = standIn ? PREVIEW_STAND_IN[chain.kind] : given;
  if (!validRefundAddress(chain.kind, refundTo)) {
    return fail(400, `Add your ${ADDRESS_NAME[chain.kind] ?? chain.name} address, so a failed transfer can be sent back to you.`);
  }

  // Both ends: the private account it lands in, and the wallet that pays or gets a refund.
  const [solOk, evmOk] = await Promise.all([
    screenOtherChainAddresses([recipient]),
    chain.kind === "evm" && !standIn ? screenAddresses([refundTo]).then((r) => r.allowed) : Promise.resolve(true),
  ]);
  if (!solOk || !evmOk) return fail(403, SCREEN_BLOCKED_MESSAGE);

  const apiKey = process.env.RELAY_API_KEY;
  if (chain.needsKey && !apiKey) return fail(400, `${chain.name} transfers aren't switched on yet.`);
  const feeSetting = bridgeFeeSetting(process.env);
  const destCurrency = relayCurrency(asset);

  let res: Response;
  try {
    res = await fetch(`${RELAY_API}/quote`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(apiKey ? { "x-api-key": apiKey } : {}) },
      body: JSON.stringify({
        user: fromWallet ? sender : chain.kind === "evm" ? "0x000000000000000000000000000000000000dEaD" : refundTo,
        recipient,
        originChainId: chain.id,
        destinationChainId: RELAY_SOLANA_CHAIN_ID,
        originCurrency: token.address,
        destinationCurrency: destCurrency,
        amount: amount.toString(),
        tradeType: "EXACT_INPUT",
        useDepositAddress: !fromWallet,
        refundTo,
        appFees: relayAppFees(feeSetting),
        ...(apiKey ? { referrer: RELAY_REFERRER } : {}),
      }),
      signal: AbortSignal.timeout(20_000),
      cache: "no-store",
    });
  } catch {
    return fail(502, "Couldn't reach the bridge. Try again.");
  }

  const data = (await res.json().catch(() => null)) as Record<string, any> | null;
  const steps: any[] = Array.isArray(data?.steps) ? data.steps : [];
  const step = steps.find((s) => typeof s?.requestId === "string") ?? steps[0];
  const out = data?.details?.currencyOut;
  if (!res.ok || !step?.requestId || !out) {
    const message = typeof data?.message === "string" ? data.message.slice(0, 300) : "";
    const code = typeof data?.errorCode === "string" ? data.errorCode.slice(0, 64) : "";
    // Why Relay said no, for the logs: its code and words, the route, never an address or the amount.
    console.warn("[bridge/solana] Relay refused the quote", { status: res.status, code, message, from: chain.id, token: token.symbol, lands: asset.id, wallet: fromWallet, preview });
    const why = relayRefusal({ code, message }, { symbol: token.symbol, chain: chain.name, lands: asset.symbol });
    return fail(why ? 400 : 502, why ?? ROUTE_BUSY);
  }
  // It must land on Solana, in the asset asked for, at the private account.
  const outOk =
    Number(out?.currency?.chainId) === RELAY_SOLANA_CHAIN_ID &&
    String(out?.currency?.address ?? "") === destCurrency &&
    /^0x[0-9a-fA-F]{64}$/.test(String(step.requestId)) &&
    steps.every((s) => s?.requestId === undefined || s.requestId === step.requestId);
  if (!outOk) return fail(502, ROUTE_BUSY);

  let evmTxs: SolanaBridgeQuote["evmTxs"] = null;
  let depositAddress = "";
  if (preview) {
    // A price only: nothing to send to and nothing to sign leaves this route.
  } else if (fromWallet) {
    // Only the plain approve and deposit on this chain, for exactly this amount, ever reach the wallet.
    evmTxs = walletBridgeTxs(data, chain, token, amount, sender);
    if (!evmTxs) return fail(502, ROUTE_BUSY);
  } else {
    depositAddress = typeof step.depositAddress === "string" ? step.depositAddress : "";
    if (!/^[A-Za-z0-9]{25,64}$/.test(depositAddress)) return fail(502, ROUTE_BUSY);
  }

  const usdIn = Number(data?.details?.currencyIn?.amountUsd ?? NaN);
  if (Number.isFinite(usdIn) && usdIn < BRIDGE_MIN_USD) {
    return fail(400, `That's about $${usdIn.toFixed(2)}, under the $${BRIDGE_MIN_USD} minimum. Bring over at least $${BRIDGE_MIN_USD} worth at a time.`);
  }
  if (Number.isFinite(usdIn) && usdIn > BRIDGE_MAX_USD) {
    return fail(400, `That's about $${usdIn.toFixed(2)}. Bring over at most $${BRIDGE_MAX_USD.toLocaleString("en-US")} worth at a time.`);
  }
  const feeUsd = ["relayer", "app"].reduce((sum, k) => sum + Number(data?.fees?.[k]?.amountUsd ?? 0), 0);
  const gasUsd = Number(data?.fees?.gas?.amountUsd ?? NaN);
  let outAmount: bigint;
  let outMin: bigint;
  try {
    outAmount = BigInt(out.amount ?? 0);
    outMin = BigInt(out.minimumAmount ?? out.amount ?? 0);
  } catch {
    return fail(502, ROUTE_BUSY);
  }
  if (outAmount <= BigInt(0)) return fail(502, ROUTE_BUSY);

  const quote: SolanaBridgeQuote = {
    requestId: String(step.requestId),
    depositAddress,
    evmTxs,
    send: {
      amount: amountText,
      symbol: token.symbol,
      chain: chain.name,
      chainId: chain.id,
      logo: token.logo,
      usd: Number.isFinite(usdIn) ? Math.round(usdIn * 100) / 100 : null,
    },
    receive: {
      amount: formatUnits(outAmount, asset.decimals),
      minimum: formatUnits(outMin, asset.decimals),
      symbol: asset.symbol,
      assetId: asset.id,
      decimals: asset.decimals,
      logo: `/brand/tokens/${asset.id}.png`,
    },
    refundTo: standIn ? "" : refundTo,
    feeUsd: Math.round(feeUsd * 100) / 100,
    appFee: quotedAppFee(feeSetting, data?.fees?.app?.amountUsd, usdIn),
    gasUsd: fromWallet && Number.isFinite(gasUsd) ? Math.round(gasUsd * 100) / 100 : null,
    timeSec: Number(data?.details?.timeEstimate ?? 0),
    bitcoin: chain.kind === "bvm",
  };
  // For /admin's count (lib/relayLedger), with no wallet or account. A price isn't an order.
  if (apiKey && !preview) await noteRelayQuote(quote.requestId, depositAddress || null);
  return NextResponse.json({ ok: true, data: quote }, { headers: { "Cache-Control": "no-store" } });
}
