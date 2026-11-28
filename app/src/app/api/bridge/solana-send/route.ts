import { NextResponse } from "next/server";
import { clientIp, hitRateLimit } from "@/lib/mcpRemote/rateLimit";
import { sendSolanaTxChecked } from "@/lib/solanaTx";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RATE_LIMIT = 12;

function fail(status: number, message: string) {
  return NextResponse.json({ ok: false, error: { message } }, { status, headers: { "Cache-Control": "no-store" } });
}

/**
 * Sends a Solana transaction the person's wallet signed (lib/solanaWallet
 * paySolana signs only, so Gloam sends it and can say when Solana refuses it).
 * Body: { tx: base64 }. Answers { signature }.
 */
export async function POST(req: Request) {
  const rate = await hitRateLimit(clientIp(req), "solana-send", RATE_LIMIT);
  if (!rate.allowed) return fail(429, "Too many tries. Wait a minute.");
  const body = (await req.json().catch(() => null)) as { tx?: unknown } | null;
  const tx = typeof body?.tx === "string" ? body.tx : "";
  if (!tx || tx.length > 4000 || !/^[A-Za-z0-9+/=]+$/.test(tx)) return fail(400, "That transaction isn't valid.");
  const sent = await sendSolanaTxChecked(tx);
  if (!sent.ok) {
    // The first two can never land: the page drops its note and lets the person try again.
    if (sent.reason === "expired") return fail(400, "It was approved after its price ran out. Nothing left your wallet. Try again.");
    if (sent.reason === "refused") return fail(400, "Solana refused it, so nothing left your wallet. Check you hold enough, then try again.");
    if (sent.reason === "invalid") return fail(400, "That transaction isn't valid.");
    return fail(502, "Couldn't send it to Solana. Try again.");
  }
  return NextResponse.json({ ok: true, data: { signature: sent.signature } }, { headers: { "Cache-Control": "no-store" } });
}
