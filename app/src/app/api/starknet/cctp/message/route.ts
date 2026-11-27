import { NextResponse } from "next/server";
import { readCappedBody } from "@/lib/cspReport";
import { STARKNET_ENABLED } from "@/lib/starknetPrivacy/config";
import { CCTP_STARKNET_DOMAIN, cctpSourceByDomain, mintedAmount, starknetCctp } from "@/lib/starknetPrivacy/cctp";
import { irisOutboundFrom } from "@/lib/starknetPrivacy/cctpOut";
import { cctpLookRate, irisBurn, irisGet, irisReattest } from "@/lib/starknetPrivacy/cctpServer";
import { serverConfig } from "@/lib/starknetPrivacy/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 20;

const NO_STORE = { "Cache-Control": "no-store" };
const refuse = (status: number, code: string, message: string) => NextResponse.json({ ok: false, error: { code, message } }, { status, headers: NO_STORE });

/** A source transaction: an EVM hash, or a Solana signature (base58, 64 bytes). */
const TX = /^(0x[0-9a-fA-F]{64}|[1-9A-HJ-NP-Za-km-z]{64,90})$/;

/**
 * Circle's attestation for a burn to Starknet, through Gloam (the page never
 * calls Circle itself): GET ?domain=<source domain>&tx=<source transaction>.
 * Answers pending until Circle signs, then the message, its attestation and
 * what it mints to whom. Only burns to Starknet from a listed source.
 * GET ?domain=25&tx=<Starknet transaction>: a cash out's burn to another chain,
 * pending or signed, and how Circle's delivery there stands.
 * POST { nonce } asks Circle to sign an expired fast transfer again.
 */
export async function GET(req: Request) {
  if (!STARKNET_ENABLED) return refuse(404, "off", "Starknet is not on here.");
  const cctp = starknetCctp(serverConfig().network);
  if (!cctp) return refuse(503, "cctp_off", "Bringing money in to Starknet isn't on here.");
  const u = new URL(req.url);
  const domain = Number(u.searchParams.get("domain"));
  const tx = u.searchParams.get("tx") ?? "";
  if (domain === CCTP_STARKNET_DOMAIN) {
    if (!/^0x[0-9a-fA-F]{1,64}$/.test(tx)) return refuse(400, "bad_request", "Send ?domain=25&tx=<a Starknet transaction>.");
    if (!(await cctpLookRate(req))) return refuse(429, "rate_limited", "Too many requests. Try again in a little while.");
    let r;
    try {
      r = await irisGet(cctp, `/v2/messages/${CCTP_STARKNET_DOMAIN}?transactionHash=0x${tx.slice(2).padStart(64, "0")}`);
    } catch {
      return refuse(502, "circle_unavailable", "Circle is slow to answer. Trying again.");
    }
    if (r.status === 404) return NextResponse.json({ ok: true, status: "pending" }, { headers: NO_STORE });
    if (r.status !== 200) return refuse(502, "circle_unavailable", "Circle is slow to answer. Trying again.");
    const out = irisOutboundFrom(r.json);
    if (!out) return refuse(404, "not_a_cash_out", "That transaction has no USDC transfer from Starknet.");
    return NextResponse.json({ ok: true, ...out }, { headers: NO_STORE });
  }
  const source = Number.isSafeInteger(domain) ? cctpSourceByDomain(domain) : null;
  if (!source || !TX.test(tx)) return refuse(400, "bad_request", "Send ?domain=<a listed source>&tx=<its transaction>.");
  if (source.kind === "evm" ? !tx.startsWith("0x") : tx.startsWith("0x")) return refuse(400, "bad_request", "That isn't a transaction on that chain.");
  if (!(await cctpLookRate(req))) return refuse(429, "rate_limited", "Too many requests. Try again in a little while.");

  let found;
  try {
    found = await irisBurn(cctp, domain, tx);
  } catch {
    return refuse(502, "circle_unavailable", "Circle is slow to answer. Trying again.");
  }
  if (!found) return refuse(404, "not_to_starknet", "That transaction has no USDC transfer to Starknet.");
  if (found.status === "pending") return NextResponse.json({ ok: true, status: "pending" }, { headers: NO_STORE });
  const d = found.decoded;
  if (d.sourceDomain !== domain) return refuse(404, "not_to_starknet", "That transaction has no USDC transfer to Starknet.");
  return NextResponse.json(
    {
      ok: true,
      status: "complete",
      message: found.message,
      attestation: found.attestation,
      nonce: found.nonce,
      mintRecipient: d.body.mintRecipient,
      amount: d.body.amount.toString(),
      minted: mintedAmount(d).toString(),
      expirationBlock: d.body.expirationBlock.toString(),
    },
    { headers: NO_STORE }
  );
}

export async function POST(req: Request) {
  if (!STARKNET_ENABLED) return refuse(404, "off", "Starknet is not on here.");
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin") return refuse(403, "forbidden", "Forbidden.");
  const cctp = starknetCctp(serverConfig().network);
  if (!cctp) return refuse(503, "cctp_off", "Bringing money in to Starknet isn't on here.");
  let nonce: unknown;
  try {
    const text = await readCappedBody(req, 1024);
    nonce = text === null ? null : (JSON.parse(text) as { nonce?: unknown })?.nonce;
  } catch {
    nonce = null;
  }
  if (typeof nonce !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(nonce)) return refuse(400, "bad_request", "Send { nonce }.");
  if (!(await cctpLookRate(req))) return refuse(429, "rate_limited", "Too many requests. Try again in a little while.");
  const asked = await irisReattest(cctp, nonce).catch(() => false);
  if (!asked) return refuse(502, "circle_unavailable", "Circle didn't take that. Try again in a minute.");
  return NextResponse.json({ ok: true }, { headers: NO_STORE });
}
