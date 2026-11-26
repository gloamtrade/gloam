import { NextResponse } from "next/server";
import { STARKNET_ENABLED } from "@/lib/starknetPrivacy/config";
import { STARKNET_OHTTP_KEYS } from "@/lib/starknetPrivacy/proxyPolicy";
import { serverConfig } from "@/lib/starknetPrivacy/server";

export const runtime = "nodejs";
export const revalidate = 300;

/**
 * The hosted discovery service's OHTTP key config, fetched by Gloam so the page
 * never calls the service itself (lib/starknetPrivacy/client seals discovery
 * requests to this key; ../route relays them). Public bytes, cached briefly.
 */
export async function GET() {
  const cfg = serverConfig();
  if (!STARKNET_ENABLED || cfg.discovery.kind !== "indexer") return NextResponse.json({ error: "off" }, { status: 404, headers: { "Cache-Control": "no-store" } });
  try {
    const res = await fetch(`${cfg.discovery.url}/ohttp-keys`, { signal: AbortSignal.timeout(10_000), redirect: "error", next: { revalidate: 300 } });
    const type = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (!res.ok || type !== STARKNET_OHTTP_KEYS || bytes.byteLength === 0 || bytes.byteLength > 4_096) {
      return NextResponse.json({ error: "upstream_unavailable" }, { status: 502, headers: { "Cache-Control": "no-store" } });
    }
    return new NextResponse(bytes, { headers: { "content-type": STARKNET_OHTTP_KEYS, "Cache-Control": "public, max-age=300" } });
  } catch {
    return NextResponse.json({ error: "upstream_unavailable" }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }
}
