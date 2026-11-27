import { NextResponse } from "next/server";
import { isAddress } from "viem";
import { clientIp, hitRateLimit } from "@/lib/mcpRemote/rateLimit";
import { STARKNET_ENABLED } from "@/lib/starknetPrivacy/config";
import { starknetCctp } from "@/lib/starknetPrivacy/cctp";
import { RELAY_HOP, relaySource } from "@/lib/starknetPrivacy/cctpRelay";
import { relayOrder } from "@/lib/starknetPrivacy/cctpRelayServer";
import { cctpFastFees } from "@/lib/starknetPrivacy/cctpServer";
import { serverConfig, wholeToBase } from "@/lib/starknetPrivacy/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const NO_STORE = { "Cache-Control": "no-store" };
/** Orders per IP a minute: each is a fresh Relay order. */
const RATE_LIMIT = 12;
const MIN = 1_000_000n;
const MAX = 10_000_000_000n;

const refuse = (status: number, message: string) => NextResponse.json({ ok: false, error: { message } }, { status, headers: NO_STORE });

/**
 * A bring-in to Starknet from a chain Circle's CCTP doesn't serve
 * (lib/starknetPrivacy/cctpRelay): POST { chainId, symbol, amount, account,
 * sender }. `amount` is the USDC (a decimal string) that arrives on Base and is
 * burned to the Starknet `account`; `sender` is the wallet that pays and gets
 * any refund. Answers the order's transactions on the source chain and what it
 * costs, checked against what was asked (cctpRelayServer readRelayOrder).
 */
export async function POST(req: Request) {
  if (!STARKNET_ENABLED) return refuse(404, "Starknet is not on here.");
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin") return refuse(403, "Forbidden.");
  const cctp = starknetCctp(serverConfig().network);
  if (!cctp) return refuse(503, "Bringing money in to Starknet isn't on here.");
  const rate = await hitRateLimit(clientIp(req), "sn-cctp-relay", RATE_LIMIT);
  if (!rate.allowed) return refuse(429, "Too many tries. Wait a minute.");

  let body: Record<string, unknown>;
  try {
    const parsed = (await req.json()) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("shape");
    body = parsed as Record<string, unknown>;
  } catch {
    return refuse(400, "Send the details as JSON.");
  }
  const source = typeof body.chainId === "number" ? relaySource(body.chainId) : null;
  if (!source) return refuse(400, "That network can't bring money in to Starknet here.");
  const token = source.tokens.find((t) => t.symbol === body.symbol);
  if (!token) return refuse(400, `Pick a stablecoin on ${source.name}.`);
  const amount = typeof body.amount === "string" ? wholeToBase(body.amount, 6) : null;
  if (amount === null || amount < MIN || amount > MAX) return refuse(400, "Enter between 1 and 10,000 USDC.");
  const account = typeof body.account === "string" && /^0x[0-9a-fA-F]{1,64}$/.test(body.account) && BigInt(body.account) > 0n && BigInt(body.account) < 1n << 251n ? body.account : null;
  if (!account) return refuse(400, "Open your private account on Starknet first.");
  const sender = typeof body.sender === "string" && isAddress(body.sender) ? body.sender : null;
  if (!sender) return refuse(400, "Connect a wallet to pay from.");

  const bps = (await cctpFastFees(cctp).catch(() => ({}) as Record<number, number | null>))[RELAY_HOP.domain] ?? null;
  if (bps === null) return refuse(503, "Circle's fee isn't available right now. Try again in a minute.");
  const out = await relayOrder({ source, token, amount, account, sender, bps });
  if (!out.ok) return refuse(out.status, out.message);
  return NextResponse.json({ ok: true, quote: out.quote, bps }, { headers: NO_STORE });
}
