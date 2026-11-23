import { NextResponse } from "next/server";
import { getBase64Decoder, getBase64Encoder, getTransactionDecoder, getTransactionEncoder, partiallySignTransaction } from "@solana/kit";
import { RINGS_RELAY_LOW_LAMPORTS, SOLANA_RINGS_ENABLED, SOLANA_RINGS_NETWORK } from "@/lib/solanaRings/config";
import { RELAY_CALL_TIMEOUT_MS, RINGS_TREE, relayBroadcast, signatureOfWire, sigStatusFrom } from "@/lib/solanaRings/landing";
import { SHIELDED_POOL_PROGRAM, USER_REGISTRY_PROGRAM, checkSponsoredTransaction } from "@/lib/solanaRings/relayPolicy";
import { heliusRpcUrl, relayerSigner, ringsRelayRate } from "@/lib/solanaRings/server";
import { screenOtherChainAddresses } from "@/lib/screeningServer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// the check run, the first send and a few seconds of rebroadcasting (lib/solanaRings/landing relayBroadcast)
export const maxDuration = 45;

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
 * simulates it, adds the relay's signature as fee payer and sends it, then
 * sends the same signed transaction again every two seconds for a few seconds
 * until Solana has seen it (lib/solanaRings/landing). It answers with the
 * signature and the signed transaction, so the page can keep rebroadcasting it
 * until it is confirmed or its blockhash expires.
 *
 * GET also gives Helius's recommended priority fee price (micro-lamports per
 * compute unit, what its staked connections ask for): the page sets each
 * transaction's fee from it, within the policy's cap, before anyone signs.
 */
export async function GET() {
  // The address is public (it is the fee payer on every transaction it sponsors), so
  // it is named even while Solana is off, to fund the relay before switching it on.
  const signer = await relayerSigner();
  const url = heliusRpcUrl();
  let funded = false;
  let priorityMicroLamports: number | null = null;
  if (signer && url) {
    const [bal, fee] = await Promise.all([
      rpc<{ value?: number }>(url, "getBalance", [signer.address, { commitment: "confirmed" }]).catch(() => null),
      SOLANA_RINGS_ENABLED ? recommendedPrice(url) : null,
    ]);
    funded = (bal?.result?.value ?? 0) >= RINGS_RELAY_LOW_LAMPORTS;
    priorityMicroLamports = fee;
  }
  return NextResponse.json(
    {
      ok: true,
      on: Boolean(SOLANA_RINGS_ENABLED && signer && url),
      funded,
      relayer: signer?.address ?? null,
      network: SOLANA_RINGS_NETWORK,
      priorityMicroLamports,
    },
    { headers: NO_STORE }
  );
}

async function rpc<T>(url: string, method: string, params: unknown[], timeoutMs = 15_000): Promise<{ result?: T; error?: { message?: string } }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(timeoutMs),
    cache: "no-store",
  });
  return (await res.json()) as { result?: T; error?: { message?: string } };
}

/** The accounts Helius prices a Rings transaction by: the pool's tree and the two programs. */
const FEE_ACCOUNTS = [RINGS_TREE, SHIELDED_POOL_PROGRAM, USER_REGISTRY_PROGRAM];
const FEE_FRESH_MS = 15_000;
let feeCache: { at: number; price: number | null } | null = null;

/** Helius's recommended priority fee price, micro-lamports per compute unit, read at most every 15 seconds. Null when it can't be read. */
async function recommendedPrice(url: string): Promise<number | null> {
  if (feeCache && Date.now() - feeCache.at < FEE_FRESH_MS) return feeCache.price;
  let price: number | null = null;
  try {
    const r = await rpc<{ priorityFeeEstimate?: unknown }>(url, "getPriorityFeeEstimate", [{ accountKeys: FEE_ACCOUNTS, options: { recommended: true } }], 4_000);
    const v = r.result?.priorityFeeEstimate;
    price = typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.ceil(v) : null;
  } catch {
    price = null;
  }
  feeCache = { at: Date.now(), price };
  return price;
}

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

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
  let signature: string | null;
  try {
    const tx = getTransactionDecoder().decode(wire);
    const signed = getTransactionEncoder().encode((await partiallySignTransaction([signer.keyPair], tx as never)) as never) as Uint8Array;
    signedBase64 = getBase64Decoder().decode(signed);
    signature = signatureOfWire(signed);
  } catch {
    return refuse(400, "bad_request", "That transaction couldn't be signed.");
  }
  if (!signature) return refuse(400, "bad_request", "That transaction couldn't be signed.");

  try {
    const sim = await rpc<{ value?: { err?: unknown; logs?: string[] } }>(
      url,
      "simulateTransaction",
      [signedBase64, { encoding: "base64", sigVerify: true, commitment: "processed" }],
      12_000
    );
    if (sim.error) return refuse(502, "simulate_failed", "Solana didn't accept the check run. Try again.");
    const err = sim.result?.value?.err;
    if (err === "AccountNotFound" || err === "InsufficientFundsForFee" || err === "InsufficientFundsForRent") {
      return refuse(503, "relay_empty", "Gloam's Solana relay is out of SOL for fees. Try again later.");
    }
    if (err) return refuse(422, "would_fail", "This transaction would fail on Solana, so it wasn't sent.");
  } catch {
    return refuse(502, "upstream_unavailable", "Solana is slow to answer. Try again.");
  }

  // Sent, then sent again until Solana has seen it (Helius: retries are ours, not the RPC's).
  const sig = signature;
  const out = await relayBroadcast({
    send: async () => {
      const r = await rpc<string>(url, "sendTransaction", [signedBase64, { encoding: "base64", skipPreflight: true, maxRetries: 0 }], RELAY_CALL_TIMEOUT_MS);
      if (typeof r.result !== "string") throw new Error("not taken");
    },
    status: async () => {
      const r = await rpc<{ value?: unknown[] }>(url, "getSignatureStatuses", [[sig], { searchTransactionHistory: false }], RELAY_CALL_TIMEOUT_MS);
      if (!Array.isArray(r.result?.value)) throw new Error("no answer");
      return sigStatusFrom(r.result.value[0] as never);
    },
    sleep,
    now: () => Date.now(),
  });
  if (!out.accepted) return refuse(502, "send_failed", "Solana didn't take it. Try again.");
  return NextResponse.json({ ok: true, signature: sig, tx: signedBase64 }, { headers: NO_STORE });
}
