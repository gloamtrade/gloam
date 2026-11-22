import { NextResponse } from "next/server";
import { getBase64Decoder, getBase64Encoder, getTransactionDecoder, getTransactionEncoder, partiallySignTransaction } from "@solana/kit";
import { SOLANA_RINGS_ENABLED, SOLANA_RINGS_NETWORK } from "@/lib/solanaRings/config";
import { checkSponsoredTransaction } from "@/lib/solanaRings/relayPolicy";
import { heliusRpcUrl, relayerSigner, ringsRelayRate } from "@/lib/solanaRings/server";
import { screenOtherChainAddresses } from "@/lib/screeningServer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const NO_STORE = { "Cache-Control": "no-store" };
const MAX_TX_BYTES = 8 * 1024;

const refuse = (status: number, code: string, message: string) =>
  NextResponse.json({ ok: false, error: { code, message } }, { status, headers: NO_STORE });

/**
 * Gloam's Solana fee sponsor: a private Solana account never holds SOL, so it
 * never needs any from its owner's main wallet. GET says whether the relay is
 * on and names its address (the fee payer the SDK builds against). POST takes a
 * version 1 Privacy Rings transaction the private account has already signed,
 * checks it against lib/solanaRings/relayPolicy, screens the accounts it names,
 * simulates it, adds the relay's signature as fee payer and sends it.
 */
/** Below this the relay reports itself empty: enough for a few dozen payments or a handful of registrations. */
const RELAY_LOW_LAMPORTS = 10_000_000;

export async function GET() {
  const signer = SOLANA_RINGS_ENABLED ? await relayerSigner() : null;
  const url = heliusRpcUrl();
  let funded = false;
  if (signer && url) {
    try {
      const bal = await rpc<{ value?: number }>(url, "getBalance", [signer.address, { commitment: "confirmed" }]);
      funded = (bal.result?.value ?? 0) >= RELAY_LOW_LAMPORTS;
    } catch {
      funded = false;
    }
  }
  return NextResponse.json(
    { ok: true, on: Boolean(signer && url), funded, relayer: signer?.address ?? null, network: SOLANA_RINGS_NETWORK },
    { headers: NO_STORE }
  );
}

async function rpc<T>(url: string, method: string, params: unknown[]): Promise<{ result?: T; error?: { message?: string } }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(15_000),
    cache: "no-store",
  });
  return (await res.json()) as { result?: T; error?: { message?: string } };
}

export async function POST(req: Request) {
  if (!SOLANA_RINGS_ENABLED) return refuse(404, "off", "Solana is not on here.");
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin") return refuse(403, "forbidden", "Forbidden.");
  const url = heliusRpcUrl();
  const signer = await relayerSigner();
  if (!url || !signer) return refuse(503, "relay_off", "Gloam's Solana relay isn't set up yet.");

  let wire: Uint8Array;
  try {
    const body = (await req.json()) as { tx?: unknown };
    if (typeof body.tx !== "string" || body.tx.length > MAX_TX_BYTES * 2) return refuse(400, "bad_request", "Send { tx: base64 }.");
    wire = new Uint8Array(getBase64Encoder().encode(body.tx));
  } catch {
    return refuse(400, "bad_request", "Send { tx: base64 }.");
  }
  if (wire.length === 0 || wire.length > MAX_TX_BYTES) return refuse(400, "bad_request", "That transaction is too large.");

  const verdict = checkSponsoredTransaction(wire, signer.address);
  if (!verdict.ok) return refuse(422, "not_sponsorable", `Gloam's relay doesn't pay for this: ${verdict.reason}.`);

  // A cash out that creates the recipient's token account costs the relay rent,
  // like a registration does: count it with them.
  let paysRent = verdict.kind === "register";
  if (!paysRent && verdict.ataAccounts.length) {
    try {
      const found = await rpc<{ value?: (unknown | null)[] }>(url, "getMultipleAccounts", [verdict.ataAccounts, { encoding: "base64", commitment: "confirmed" }]);
      const value = found.result?.value;
      if (!Array.isArray(value) || value.length !== verdict.ataAccounts.length) return refuse(502, "upstream_unavailable", "Solana is slow to answer. Try again.");
      paysRent = value.some((a) => a === null);
    } catch {
      return refuse(502, "upstream_unavailable", "Solana is slow to answer. Try again.");
    }
  }
  const rate = await ringsRelayRate(req, paysRent ? "rent" : "transact");
  if (rate === "unavailable") return refuse(503, "relay_unavailable", "Gloam's Solana relay is paused for a moment. Try again shortly.");
  if (rate === "limited") return refuse(429, "rate_limited", "Too many requests. Try again in a little while.");
  if (!(await screenOtherChainAddresses(verdict.accounts))) return refuse(403, "screened", "This transaction can't go through Gloam.");

  let signedBase64: string;
  try {
    const tx = getTransactionDecoder().decode(wire);
    const signed = await partiallySignTransaction([signer.keyPair], tx as never);
    signedBase64 = getBase64Decoder().decode(getTransactionEncoder().encode(signed as never));
  } catch {
    return refuse(400, "bad_request", "That transaction couldn't be signed.");
  }

  try {
    const sim = await rpc<{ value?: { err?: unknown; logs?: string[] } }>(url, "simulateTransaction", [
      signedBase64,
      { encoding: "base64", sigVerify: true, commitment: "processed" },
    ]);
    if (sim.error) return refuse(502, "simulate_failed", "Solana didn't accept the check run. Try again.");
    const err = sim.result?.value?.err;
    if (err === "AccountNotFound" || err === "InsufficientFundsForFee" || err === "InsufficientFundsForRent") {
      return refuse(503, "relay_empty", "Gloam's Solana relay is out of SOL for fees. Try again later.");
    }
    if (err) return refuse(422, "would_fail", "This transaction would fail on Solana, so it wasn't sent.");
    const sent = await rpc<string>(url, "sendTransaction", [signedBase64, { encoding: "base64", skipPreflight: true, maxRetries: 5 }]);
    if (!sent.result) return refuse(502, "send_failed", "Solana didn't take it. Try again.");
    return NextResponse.json({ ok: true, signature: sent.result }, { headers: NO_STORE });
  } catch {
    return refuse(502, "upstream_unavailable", "Solana is slow to answer. Try again.");
  }
}
