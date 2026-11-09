/**
 * x402 on the buyer side: find a Gloam private price in a 402 answer.
 *
 * A seller can offer Gloam next to standard x402 in three places, read in this
 * order (the Gloam MCP server reads the first and the last too):
 *
 *   1. an X-Payment-Required header holding the encoded requirements
 *      (gloamx402req1:…). It works next to any standard x402 answer, v1 or v2.
 *   2. a v2 PAYMENT-REQUIRED header (base64 JSON) whose `accepts` has an entry
 *      with scheme gloam-private, its requirements encoded in extra.gloam.
 *   3. the body: the encoded requirements, or JSON with an `accepts` entry,
 *      `requirements` or `gloam` carrying them.
 *
 * What the seller lists for standard clients (scheme exact) is reported back,
 * never paid here.
 *
 * A gateway that pays out to a public address can offer scheme gloam-cashout
 * in `accepts` (PAYMENT-REQUIRED or the body): the agent cashes out of its
 * private balance to that address. findGloamOffer picks between the two
 * (chooseGloamX402Scheme): gloam-private when both are offered unless the
 * caller prefers gloam-cashout, and gloam-cashout when it is the only Gloam one.
 */
import {
  GLOAM_CASHOUT_SCHEME,
  GLOAM_X402_SCHEME,
  chooseGloamX402Scheme,
  decodeRequirements,
  findGloamCashoutRequirement,
  type GloamCashoutRequirement,
  type GloamPaymentRequirements,
  type GloamX402SchemeName,
} from "@gloamtrade/sdk";

const REQ_PREFIX = "gloamx402req1:";

export type FoundPrice = { ok: true; requirements: GloamPaymentRequirements; offered: string[] } | { ok: false; reason: string; offered: string[] };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function fromEntry(e: unknown): GloamPaymentRequirements | null {
  if (!isObj(e) || e.scheme !== GLOAM_X402_SCHEME) return null;
  const extra = isObj(e.extra) ? e.extra : {};
  if (typeof extra.gloam === "string" && extra.gloam.startsWith(REQ_PREFIX)) return decodeRequirements(extra.gloam);
  if (typeof e.maxAmountRequired === "string" && typeof e.poolAddress === "string" && typeof e.network === "number") return e as unknown as GloamPaymentRequirements;
  return null;
}

function schemesOf(accepts: unknown): string[] {
  return Array.isArray(accepts) ? accepts.map((a) => (isObj(a) ? `${a.scheme ?? "?"}${a.network !== undefined ? ` on ${String(a.network)}` : ""}` : "?")) : [];
}

/** Read a 402 answer's headers and body for a Gloam price, and what it offers standard clients. */
export function findGloamPrice(headers: Headers, body: string): FoundPrice {
  const t = body.trim();
  let v2: Record<string, unknown> | null = null;
  const v2raw = headers.get("payment-required")?.trim();
  if (v2raw && !v2raw.startsWith(REQ_PREFIX)) {
    try {
      const pr = JSON.parse(Buffer.from(v2raw, "base64").toString("utf8")) as unknown;
      if (isObj(pr)) v2 = pr;
    } catch {
      /* not base64 JSON */
    }
  }
  let json: Record<string, unknown> | null = null;
  try {
    const j = JSON.parse(t) as unknown;
    if (isObj(j)) json = j;
  } catch {
    /* not JSON */
  }
  const offered = [...schemesOf(v2?.accepts), ...schemesOf(json?.accepts)].filter((o) => !o.startsWith(`${GLOAM_X402_SCHEME} `) && o !== GLOAM_X402_SCHEME);
  const found = (requirements: GloamPaymentRequirements): FoundPrice => ({ ok: true, requirements, offered });
  try {
    for (const name of ["x-payment-required", "payment-required"]) {
      const h = headers.get(name)?.trim();
      if (h?.startsWith(REQ_PREFIX)) return found(decodeRequirements(h));
    }
    for (const e of Array.isArray(v2?.accepts) ? v2.accepts : []) {
      const r = fromEntry(e);
      if (r) return found(r);
    }
    if (t.startsWith(REQ_PREFIX)) return found(decodeRequirements(t));
    if (json) {
      for (const c of [json.encoded, json.gloam]) if (typeof c === "string" && c.startsWith(REQ_PREFIX)) return found(decodeRequirements(c));
      for (const c of [json, json.requirements, json.gloam, ...(Array.isArray(json.accepts) ? json.accepts : [])]) {
        const r = fromEntry(c);
        if (r) return found(r);
      }
    }
  } catch {
    return { ok: false, reason: "The 402 answer carries Gloam requirements that do not decode.", offered };
  }
  return {
    ok: false,
    reason: offered.length
      ? `The resource does not offer a Gloam private price. It offers ${offered.join(", ")}: pay that with a standard x402 client.`
      : "The 402 answer carries no payment requirements this pack can read.",
    offered,
  };
}

export type FoundOffer =
  | { ok: true; scheme: typeof GLOAM_X402_SCHEME; requirements: GloamPaymentRequirements; offered: string[] }
  | { ok: true; scheme: typeof GLOAM_CASHOUT_SCHEME; cashout: GloamCashoutRequirement; offered: string[] }
  | { ok: false; reason: string; offered: string[] };

/** The Gloam price to pay in a 402 answer, of either scheme, and what it offers standard clients. */
export function findGloamOffer(headers: Headers, body: string, prefer?: GloamX402SchemeName): FoundOffer {
  const priv = findGloamPrice(headers, body);
  const cashout = findGloamCashoutRequirement(headers, body);
  const choice = chooseGloamX402Scheme({ gloamPrivate: priv.ok, gloamCashout: cashout !== null }, prefer);
  if (choice === GLOAM_CASHOUT_SCHEME && cashout) {
    const offered = priv.offered.filter((o) => !o.startsWith(`${GLOAM_CASHOUT_SCHEME} `) && o !== GLOAM_CASHOUT_SCHEME);
    return { ok: true, scheme: GLOAM_CASHOUT_SCHEME, cashout, offered };
  }
  if (priv.ok) return { ok: true, scheme: GLOAM_X402_SCHEME, requirements: priv.requirements, offered: priv.offered };
  return priv;
}

const BODY_LIMIT = 20_000;

/** A response body for a tool result: text, cut at 20,000 characters. */
export async function readBody(res: Response): Promise<{ httpStatus: number; contentType: string | null; body: string }> {
  const raw = await res.text().catch(() => "");
  return {
    httpStatus: res.status,
    contentType: res.headers.get("content-type"),
    body: raw.length > BODY_LIMIT ? `${raw.slice(0, BODY_LIMIT)}… (${raw.length - BODY_LIMIT} more characters)` : raw,
  };
}

/** Why the pack will not request `raw`, or null. https only unless allowHttp; never credentials in the URL. */
export function urlProblem(raw: string, allowHttp: boolean): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "That is not a URL.";
  }
  if (u.protocol !== "https:" && !(allowHttp && u.protocol === "http:")) return allowHttp ? "Only http and https URLs." : "Only https URLs (set allowHttp for http).";
  if (u.username || u.password) return "A URL with a user name or password in it is refused.";
  return null;
}
