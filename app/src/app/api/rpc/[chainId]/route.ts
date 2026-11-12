import { NextResponse } from "next/server";
import { rpcProxyResponse } from "@/lib/rpcProxyServer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * gloam.trade's JSON-RPC proxy for the mainnets with one public RPC (Robinhood
 * Chain, Tempo, Elysium). The browser asks it only after that RPC failed for it
 * (lib/rpcProxy), for reads only; the rules and limits are in lib/rpcProxyServer.
 */
export async function POST(req: Request, ctx: { params: Promise<{ chainId: string }> }) {
  const { chainId } = await ctx.params;
  return rpcProxyResponse(req, chainId);
}

/** JSON-RPC goes in a POST body only. */
export function GET() {
  return NextResponse.json({ error: "method_not_allowed" }, { status: 405, headers: { Allow: "POST", "Cache-Control": "no-store" } });
}
