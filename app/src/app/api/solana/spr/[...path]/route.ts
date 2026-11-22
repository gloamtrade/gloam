import { NextResponse } from "next/server";
import { SOLANA_RINGS_ENABLED } from "@/lib/solanaRings/config";
import { RINGS_SPR_MAX_BODY, SPR_REQUEST_HEADERS, SPR_RESPONSE_HEADERS, sprQuery, sprRoute } from "@/lib/solanaRings/proxyPolicy";
import { heliusSprUrl, ringsProxyRate } from "@/lib/solanaRings/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * Gloam's proxy to Helius's /v1/spr namespace: the Privacy Rings indexer and
 * the prover, with the API key added here. Only the routes in
 * lib/solanaRings/proxyPolicy pass. The SDK encrypts every prover request to
 * the attested Helius enclave, so what crosses this proxy for a proof is
 * ciphertext; indexer reads (which encrypted outputs to fetch) are plain.
 */
async function forward(req: Request, ctx: { params: Promise<{ path: string[] }> }, method: "GET" | "POST") {
  if (!SOLANA_RINGS_ENABLED) return NextResponse.json({ error: "off" }, { status: 404, headers: NO_STORE });
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin") return NextResponse.json({ error: "forbidden" }, { status: 403, headers: NO_STORE });

  const { path } = await ctx.params;
  const route = sprRoute(path ?? [], method);
  if (!route) return NextResponse.json({ error: "not_found" }, { status: 404, headers: NO_STORE });
  const query = sprQuery(route, new URL(req.url).searchParams);
  if (!query) return NextResponse.json({ error: "bad_query" }, { status: 400, headers: NO_STORE });
  const upstream = heliusSprUrl(route, query);
  if (!upstream) return NextResponse.json({ error: "not_configured" }, { status: 503, headers: NO_STORE });

  const rate = await ringsProxyRate(req, 1);
  if (!rate.allowed) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: { ...NO_STORE, "Retry-After": String(rate.retryAfterSec) } });
  }

  const headers = new Headers();
  for (const h of SPR_REQUEST_HEADERS) {
    const v = req.headers.get(h);
    if (v !== null) headers.set(h, v);
  }
  let body: ArrayBuffer | undefined;
  if (method === "POST") {
    const declared = Number(req.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > RINGS_SPR_MAX_BODY) {
      return NextResponse.json({ error: "too_large" }, { status: 413, headers: NO_STORE });
    }
    body = await req.arrayBuffer();
    if (body.byteLength > RINGS_SPR_MAX_BODY) return NextResponse.json({ error: "too_large" }, { status: 413, headers: NO_STORE });
  }

  let res: Response;
  try {
    res = await fetch(upstream, { method, headers, body, redirect: "error", cache: "no-store", signal: AbortSignal.timeout(55_000) });
  } catch {
    return NextResponse.json({ error: "upstream_unavailable" }, { status: 502, headers: NO_STORE });
  }
  const out = new Headers(NO_STORE);
  for (const h of SPR_RESPONSE_HEADERS) {
    const v = res.headers.get(h);
    if (v !== null) out.set(h, v);
  }
  return new Response(res.body, { status: res.status, headers: out });
}

export function GET(req: Request, ctx: { params: Promise<{ path: string[] }> }) {
  return forward(req, ctx, "GET");
}

export function POST(req: Request, ctx: { params: Promise<{ path: string[] }> }) {
  return forward(req, ctx, "POST");
}
