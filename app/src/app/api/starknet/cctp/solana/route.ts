import { NextResponse } from "next/server";
import { clientIp, hitRateLimit } from "@/lib/mcpRemote/rateLimit";
import { STARKNET_ENABLED } from "@/lib/starknetPrivacy/config";
import { starknetCctp } from "@/lib/starknetPrivacy/cctp";
import { cctpFastFees } from "@/lib/starknetPrivacy/cctpServer";
import { buildSolanaBurn, solanaBalances, solanaBurnStatus } from "@/lib/starknetPrivacy/cctpSolanaServer";
import { serverConfig, wholeToBase } from "@/lib/starknetPrivacy/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const NO_STORE = { "Cache-Control": "no-store" };
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SIG = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;
const MIN = 1_000_000n;
const MAX = 10_000_000_000n;
const refuse = (status: number, message: string) => NextResponse.json({ ok: false, error: { message } }, { status, headers: NO_STORE });

/**
 * Bringing USDC in to Starknet from a Solana wallet with Circle's CCTP
 * (lib/starknetPrivacy/cctpSolanaServer).
 *
 * GET ?owner=<wallet>: its USDC and SOL. GET ?signature=&lastValid=: where a
 * burn it sent stands (landed, failed, expired, pending). POST { owner,
 * amount, account }: the burn for the wallet to sign, built and simulated
 * here, `amount` USDC (a decimal string) to the Starknet `account`.
 */
export async function GET(req: Request) {
  if (!STARKNET_ENABLED || !starknetCctp(serverConfig().network)) return refuse(404, "Bringing money in to Starknet isn't on here.");
  const rate = await hitRateLimit(clientIp(req), "sn-cctp-solana-read", 40);
  if (!rate.allowed) return refuse(429, "Too many requests. Try again in a little while.");
  const u = new URL(req.url);
  const owner = u.searchParams.get("owner") ?? "";
  const signature = u.searchParams.get("signature") ?? "";
  if (BASE58.test(owner)) {
    const b = await solanaBalances(owner);
    return NextResponse.json({ ok: true, usdc: b.usdc?.toString() ?? null, sol: b.sol?.toString() ?? null }, { headers: NO_STORE });
  }
  const lastValid = Number(u.searchParams.get("lastValid"));
  if (SIG.test(signature) && Number.isSafeInteger(lastValid) && lastValid > 0) {
    return NextResponse.json({ ok: true, status: await solanaBurnStatus(signature, lastValid) }, { headers: NO_STORE });
  }
  return refuse(400, "Send ?owner= or ?signature=&lastValid=.");
}

export async function POST(req: Request) {
  if (!STARKNET_ENABLED) return refuse(404, "Starknet is not on here.");
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin") return refuse(403, "Forbidden.");
  const cctp = starknetCctp(serverConfig().network);
  if (!cctp) return refuse(503, "Bringing money in to Starknet isn't on here.");
  const rate = await hitRateLimit(clientIp(req), "sn-cctp-solana", 12);
  if (!rate.allowed) return refuse(429, "Too many tries. Wait a minute.");
  const body = (await req.json().catch(() => null)) as { owner?: unknown; amount?: unknown; account?: unknown } | null;
  const owner = typeof body?.owner === "string" && BASE58.test(body.owner) ? body.owner : null;
  const amount = typeof body?.amount === "string" ? wholeToBase(body.amount, 6) : null;
  const account = typeof body?.account === "string" && /^0x[0-9a-fA-F]{1,64}$/.test(body.account) && BigInt(body.account) > 0n && BigInt(body.account) < 1n << 251n ? body.account : null;
  if (!owner) return refuse(400, "Connect a Solana wallet.");
  if (amount === null || amount < MIN || amount > MAX) return refuse(400, "Enter between 1 and 10,000 USDC.");
  if (!account) return refuse(400, "Open your private account on Starknet first.");
  const bps = (await cctpFastFees(cctp).catch(() => ({}) as Record<number, number | null>))[5] ?? null;
  if (bps === null) return refuse(503, "Circle's fee isn't available right now. Try again in a minute.");
  const built = await buildSolanaBurn(owner, { amount, account, bps });
  if (!built.ok) {
    if (built.reason === "funds") return refuse(400, "That wallet doesn't hold enough USDC, or SOL for the network fee and the message account.");
    return refuse(502, built.reason === "rpc" ? "Solana is slow to answer. Try again." : "Couldn't make that transfer on Solana. Try again.");
  }
  return NextResponse.json({ ok: true, tx: built.tx, lastValidBlockHeight: built.lastValidBlockHeight, bps }, { headers: NO_STORE });
}
