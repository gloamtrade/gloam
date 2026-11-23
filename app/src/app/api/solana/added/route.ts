import { NextResponse } from "next/server";
import { SOLANA_RINGS_ENABLED, SOLANA_RINGS_NETWORK } from "@/lib/solanaRings/config";
import { SharedCountUnavailable, addRateCount, clientIp } from "@/lib/mcpRemote/rateLimit";
import { isSignature } from "@/lib/solanaRings/metricsParse";
import { makeRpc, metricsRpcUrl, recordSolanaAdd, solanaRelays } from "@/lib/solanaRings/metricsServer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// a few tries at reading a transaction that only just landed
export const maxDuration = 20;

const NO_STORE = { "Cache-Control": "no-store" };

/** Per-minute limits: per IP, and for everyone. Each check costs one or a few Solana reads. */
const ADDED_PER_IP_PER_MIN = 10;
const ADDED_ALL_PER_MIN = 300;

const answer = (status: number, body: Record<string, unknown>) => NextResponse.json(body, { status, headers: NO_STORE });

/**
 * The app reports a wallet add here once it lands (lib/solanaRings/addReport,
 * from addToPrivate), so /admin can count it: an add the wallet paid for itself
 * names no Gloam account on chain, so the chain alone can't tell it from any
 * other app's. Checked on chain before it is kept (lib/solanaRings/metricsServer
 * recordSolanaAdd): it landed in the last hour, it is one shielded-pool deposit
 * of a listed asset, and the depositing wallet (the fee payer, or the other
 * signer when Gloam's relay paid the fee) is where the money came from. Kept
 * once per signature; an add the relay paid for, also in its history, counts
 * once. Nothing is added to the person's transaction, and the page never waits on this.
 */
export async function POST(req: Request) {
  if (!SOLANA_RINGS_ENABLED || SOLANA_RINGS_NETWORK !== "mainnet") return answer(404, { ok: false, error: "off" });
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin") return answer(403, { ok: false, error: "forbidden" });

  let signature: unknown;
  try {
    const body = (await req.json()) as { signature?: unknown };
    signature = body.signature;
  } catch {
    return answer(400, { ok: false, error: "bad_request" });
  }
  if (!isSignature(signature)) return answer(400, { ok: false, error: "bad_request" });

  const now = Date.now();
  try {
    if ((await addRateCount(clientIp(req), "sol-added", 1, now)) > ADDED_PER_IP_PER_MIN) return answer(429, { ok: false, error: "rate_limited" });
    if ((await addRateCount("all", "sol-added-all", 1, now)) > ADDED_ALL_PER_MIN) return answer(429, { ok: false, error: "rate_limited" });
  } catch (e) {
    return answer(e instanceof SharedCountUnavailable ? 503 : 429, { ok: false, error: "rate_limited" });
  }

  const url = metricsRpcUrl();
  if (!url) return answer(503, { ok: false, error: "unavailable" });
  try {
    const r = await recordSolanaAdd(signature, { rpc: makeRpc(url), relays: await solanaRelays() });
    return answer(200, { ok: true, recorded: r.recorded });
  } catch {
    return answer(503, { ok: false, error: "unavailable" });
  }
}
