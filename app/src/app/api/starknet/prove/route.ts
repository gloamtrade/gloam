import { NextResponse } from "next/server";
import { readCappedBody } from "@/lib/cspReport";
import { STARKNET_ENABLED, STARKNET_NETWORK, sameStarknetAddress } from "@/lib/starknetPrivacy/config";
import { STARKNET_PROVE_MAX_BODY, STARKNET_PROVE_METHODS } from "@/lib/starknetPrivacy/proxyPolicy";
import { StarkscanProveError, starkscanProve } from "@/lib/starknetPrivacy/starkscanProver";
import { serverConfig, starknetProveRate, starknetUpstream, starkscanAdmit, starkscanRounds } from "@/lib/starknetPrivacy/server";
import { devnetMockProve } from "@/lib/starknetPrivacy/devnetProver";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Starkscan publishes no proving time: its job is polled for up to STARKSCAN_WAIT_MS, then
// the SDK's retry (same body, same job) picks it up again.
export const maxDuration = 300;
const STARKSCAN_WAIT_MS = 270_000;

const NO_STORE = { "Cache-Control": "no-store" };

type Rpc = { jsonrpc?: string; id?: unknown; method?: unknown; params?: unknown };

const rpcError = (id: unknown, code: number, message: string, status = 200) =>
  NextResponse.json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } }, { status, headers: NO_STORE });

/**
 * Gloam's Starknet prover, for the SDK's proving-service protocol (JSON-RPC
 * starknet_proveTransaction, the SDK's ProvingServiceProofProvider): the page
 * proves through this and never holds a prover key or URL. Behind it, by
 * what this deployment has:
 *  - STARKNET_PROVER_URL: a proving service that speaks the same protocol
 *    (StarkWare's transaction prover run for Sepolia): passed on as is.
 *  - mainnet with STARKSCAN_API_KEY: Starkscan's job API (lib/starknetPrivacy/starkscanProver).
 *  - a local devnet with neither: the SDK's mock prover (the pool's own logic
 *    runs; devnet takes no real proof).
 * The prover runs the transaction to prove it, so it sees what it does; the
 * page says so where it says what Starknet shows.
 */
export async function POST(req: Request) {
  if (!STARKNET_ENABLED) return NextResponse.json({ error: "off" }, { status: 404, headers: NO_STORE });
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin") return NextResponse.json({ error: "forbidden" }, { status: 403, headers: NO_STORE });

  let call: Rpc;
  try {
    const text = await readCappedBody(req, STARKNET_PROVE_MAX_BODY);
    if (text === null) return rpcError(null, -32600, "Request too large", 413);
    call = JSON.parse(text) as Rpc;
  } catch {
    return rpcError(null, -32700, "Parse error", 400);
  }
  if (!call || typeof call !== "object" || Array.isArray(call)) return rpcError(null, -32600, "Invalid request", 400);
  if (typeof call.method !== "string" || !STARKNET_PROVE_METHODS.has(call.method)) return rpcError(call.id, -32601, "Method not allowed");
  if (call.method === "starknet_specVersion") return NextResponse.json({ jsonrpc: "2.0", id: call.id ?? null, result: "0.10.0" }, { headers: NO_STORE });

  const p = call.params as { block_id?: unknown; transaction?: unknown } | undefined;
  if (!p || typeof p !== "object" || !p.transaction || typeof p.transaction !== "object") return rpcError(call.id, -32602, "Invalid params");
  // Only the pool's own proof invocations: Gloam's prover budget proves nothing else.
  const cfg = serverConfig();
  const sender = (p.transaction as { sender_address?: unknown }).sender_address;
  if (!cfg.pool || typeof sender !== "string" || !sameStarknetAddress(sender, cfg.pool)) return rpcError(call.id, -32602, "Only the privacy pool's transactions are proved here.");

  const rate = await starknetProveRate(req);
  if (rate === "unavailable") return rpcError(call.id, -32005, "Proving is paused for a moment. Try again shortly.", 503);
  if (rate === "limited") return rpcError(call.id, -32005, "Too many proofs. Try again in a little while.", 429);

  const proverUrl = cfg.proverUrl;
  try {
    if (proverUrl) {
      const res = await fetch(proverUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: call.id ?? null, method: "starknet_proveTransaction", params: { block_id: p.block_id ?? "latest", transaction: p.transaction } }),
        signal: AbortSignal.timeout(55_000),
        cache: "no-store",
      });
      if (res.status === 503) return rpcError(call.id, -32005, "The prover is busy. Try again shortly.", 503);
      const json = (await res.json()) as unknown;
      return NextResponse.json(json, { headers: NO_STORE });
    }
    if (STARKNET_NETWORK === "mainnet") {
      const key = (process.env.STARKSCAN_API_KEY ?? "").trim();
      if (!key || !cfg.starkscanProveUrl) return rpcError(call.id, -32603, "Proving on Starknet isn't set up yet.");
      const result = await starkscanProve(
        { url: cfg.starkscanProveUrl, apiKey: key, timeoutMs: STARKSCAN_WAIT_MS, rounds: starkscanRounds(), admit: starkscanAdmit(req) },
        p.block_id as never,
        p.transaction
      );
      return NextResponse.json({ jsonrpc: "2.0", id: call.id ?? null, result }, { headers: NO_STORE });
    }
    if (STARKNET_NETWORK === "devnet") {
      const result = await devnetMockProve(starknetUpstream(cfg), cfg.chainId, p.block_id, p.transaction);
      return NextResponse.json({ jsonrpc: "2.0", id: call.id ?? null, result }, { headers: NO_STORE });
    }
    return rpcError(call.id, -32603, "Proving on Starknet Sepolia isn't set up yet.");
  } catch (e) {
    if (e instanceof StarkscanProveError) {
      // The prover's own code on a failed job (10000: screening refused the deposit), so the SDK names it.
      if (e.prover) return NextResponse.json({ jsonrpc: "2.0", id: call.id ?? null, error: { code: e.prover.code, message: e.message, ...(e.prover.data !== undefined ? { data: e.prover.data } : {}) } }, { headers: NO_STORE });
      // This caller's new proofs for the day are used: 429, which the SDK doesn't retry.
      if (e.code === "limited") return rpcError(call.id, -32005, e.message, 429);
      // Busy, or still proving: the SDK retries the same body, which finds the same job.
      const code = e.code === "unavailable" || e.code === "timeout" ? -32005 : -32603;
      return rpcError(call.id, code, e.message);
    }
    const why = e instanceof Error ? e.message.replace(/\s+/g, " ").slice(0, 240) : "prove failed";
    return rpcError(call.id, -32603, `The proof failed: ${why}`);
  }
}

export function GET() {
  return NextResponse.json({ error: "method_not_allowed" }, { status: 405, headers: { Allow: "POST", ...NO_STORE } });
}
