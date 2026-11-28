import { NextResponse } from "next/server";
import { STARKNET_ENABLED } from "@/lib/starknetPrivacy/config";
import { STARKNET_DISCOVERY_MAX_BODY, STARKNET_OHTTP_REQUEST, STARKNET_OHTTP_RESPONSE } from "@/lib/starknetPrivacy/proxyPolicy";
import { serverConfig, starknetProxyRate } from "@/lib/starknetPrivacy/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * Gloam as the OHTTP relay (RFC 9458) for Starknet's hosted discovery service
 * (mainnet). The page seals each request to the service's key (the SDK's
 * IndexerDiscoveryProvider over OHTTP, key config from ./ohttp-keys), so this
 * route passes bytes it can't read: the service reads the request (an
 * account's address and viewing key, to find its notes) but never sees who
 * asked, and Gloam sees who asked but never what. Nothing here is logged or
 * kept, and nothing about the caller is passed on.
 */
export async function POST(req: Request) {
  if (!STARKNET_ENABLED) return NextResponse.json({ error: "off" }, { status: 404, headers: NO_STORE });
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin") return NextResponse.json({ error: "forbidden" }, { status: 403, headers: NO_STORE });
  const cfg = serverConfig();
  if (cfg.discovery.kind !== "indexer") return NextResponse.json({ error: "no_discovery_service" }, { status: 404, headers: NO_STORE });
  if ((req.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase() !== STARKNET_OHTTP_REQUEST) {
    return NextResponse.json({ error: "unsupported_media_type" }, { status: 415, headers: NO_STORE });
  }
  const rate = await starknetProxyRate(req, 1);
  if (!rate.allowed) return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: { ...NO_STORE, "Retry-After": String(rate.retryAfterSec) } });

  const body = await readCappedBytes(req, STARKNET_DISCOVERY_MAX_BODY);
  if (!body) return NextResponse.json({ error: "too_large" }, { status: 413, headers: NO_STORE });
  let res: Response;
  try {
    res = await fetch(cfg.discovery.url, {
      method: "POST",
      headers: { "content-type": STARKNET_OHTTP_REQUEST },
      body: body as BodyInit,
      signal: AbortSignal.timeout(25_000),
      cache: "no-store",
      redirect: "error",
    });
  } catch {
    return NextResponse.json({ error: "upstream_unavailable" }, { status: 502, headers: NO_STORE });
  }
  const type = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength > STARKNET_DISCOVERY_MAX_BODY * 16) return NextResponse.json({ error: "upstream_too_large" }, { status: 502, headers: NO_STORE });
  // A sealed answer, or the service's own plain error (the SDK reads both).
  return new NextResponse(bytes, {
    status: res.status,
    headers: { ...NO_STORE, "content-type": type === STARKNET_OHTTP_RESPONSE ? STARKNET_OHTTP_RESPONSE : type || "application/octet-stream" },
  });
}

export function GET() {
  return NextResponse.json({ error: "method_not_allowed" }, { status: 405, headers: { Allow: "POST", ...NO_STORE } });
}

/** The request body as bytes, or null past `max`. */
async function readCappedBytes(req: Request, max: number): Promise<Uint8Array | null> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > max) return null;
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    parts.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}
