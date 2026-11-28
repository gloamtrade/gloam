import { NextResponse } from "next/server";
import { readCappedBody } from "@/lib/cspReport";
import { STARKNET_ENABLED } from "@/lib/starknetPrivacy/config";
import { STARKNET_RPC_MAX_BATCH, STARKNET_RPC_MAX_BODY, starknetRpcCallAllowed } from "@/lib/starknetPrivacy/proxyPolicy";
import { serverConfig, starknetProxyRate, starknetUpstream } from "@/lib/starknetPrivacy/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const NO_STORE = { "Cache-Control": "no-store" };

type Call = { jsonrpc?: string; id?: unknown; method?: unknown; params?: unknown };
type Reply = { jsonrpc: "2.0"; id: unknown; result?: unknown; error?: { code: number; message: string } };

const fail = (id: unknown, code: number, message: string): Reply => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

/**
 * Gloam's Starknet RPC: the browser and the SDK read through this, and it reads
 * the node, whose URL stays on the server. Same-origin pages only, the read
 * methods in lib/starknetPrivacy/proxyPolicy (nothing that sends: the relay
 * sends), rate limited per IP.
 */
export async function POST(req: Request) {
  if (!STARKNET_ENABLED) return NextResponse.json({ error: "off" }, { status: 404, headers: NO_STORE });
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin") return NextResponse.json({ error: "forbidden" }, { status: 403, headers: NO_STORE });
  if (!/^application\/json\s*(;|$)/i.test(req.headers.get("content-type") ?? "")) {
    return NextResponse.json({ error: "unsupported_media_type" }, { status: 415, headers: NO_STORE });
  }
  let text: string | null;
  try {
    text = await readCappedBody(req, STARKNET_RPC_MAX_BODY);
  } catch {
    return NextResponse.json(fail(null, -32700, "Parse error"), { status: 400, headers: NO_STORE });
  }
  if (text === null) return NextResponse.json(fail(null, -32600, "Request too large"), { status: 413, headers: NO_STORE });
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return NextResponse.json(fail(null, -32700, "Parse error"), { status: 400, headers: NO_STORE });
  }
  const batch = Array.isArray(body);
  const items = (batch ? body : [body]) as Call[];
  if (items.length === 0 || items.length > STARKNET_RPC_MAX_BATCH) {
    return NextResponse.json(fail(null, -32600, "Invalid request"), { status: 400, headers: NO_STORE });
  }

  const rate = await starknetProxyRate(req, items.length);
  if (!rate.allowed) {
    const replies = items.map((c) => fail(c?.id, -32005, "Too many requests, rate limited"));
    return NextResponse.json(batch ? replies : replies[0], { status: 429, headers: { ...NO_STORE, "Retry-After": String(rate.retryAfterSec) } });
  }

  const allowed = items.filter((c) => c && typeof c === "object" && starknetRpcCallAllowed(c));
  let answered: Reply[] = [];
  if (allowed.length) {
    try {
      const res = await fetch(starknetUpstream(serverConfig()), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(allowed.map((c) => ({ jsonrpc: "2.0", id: c.id ?? null, method: c.method, params: c.params ?? [] }))),
        signal: AbortSignal.timeout(20_000),
        cache: "no-store",
      });
      const json = (await res.json()) as unknown;
      answered = Array.isArray(json) ? (json as Reply[]) : [json as Reply];
    } catch {
      const replies = items.map((c) => fail(c?.id, -32603, "Upstream RPC unavailable"));
      return NextResponse.json(batch ? replies : replies[0], { status: 502, headers: NO_STORE });
    }
  }
  const byId = new Map(answered.map((r) => [JSON.stringify(r?.id ?? null), r]));
  const replies = items.map((c) =>
    allowed.includes(c) ? (byId.get(JSON.stringify(c.id ?? null)) ?? fail(c.id, -32603, "No answer")) : fail(c?.id, -32601, "Method not allowed")
  );
  return NextResponse.json(batch ? replies : replies[0], { headers: NO_STORE });
}

export function GET() {
  return NextResponse.json({ error: "method_not_allowed" }, { status: 405, headers: { Allow: "POST", ...NO_STORE } });
}
