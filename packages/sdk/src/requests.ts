/**
 * Payment request links: a link that asks someone to pay your Gloam address,
 * with an optional amount and a private note (an invoice number, an agent ID).
 *
 *   https://gloam.trade/app/vault?tab=move&mode=pay#to=gloamr1.…&amount=25
 *     &asset=0x…&note=agent-42&chain=robinhood-mainnet
 *
 * The same link the Gloam app builds and reads (app/src/lib/paymentRequest.ts),
 * field for field. It only pre-fills the private send form on the payer's side;
 * nothing about a request is posted on chain. The details sit in the URL
 * fragment (after #), which browsers never send to a server, so they stay
 * between you and the payer. When the payer sends, the note travels inside the
 * payment itself, sealed to your Gloam address so only you can read it.
 */

import type { Address } from "viem";
import { getGloamNetwork, networkForChainId, type GloamAsset, type GloamNetwork, type GloamNetworkKey } from "./constants.js";
import { PAYMENT_NOTE_MAX, cleanText } from "./paymentNote.js";
import { assertReceiveTag } from "./receiveTag.js";
import { decodeShortRequest, encodeShortRequest, shortRequestLink } from "./shortLink.js";

/** Same cap as the private note a payment carries. */
export const REQUEST_NOTE_MAX = PAYMENT_NOTE_MAX;
/** Cap on the display name a request shows the payer. */
export const REQUEST_NAME_MAX = 40;
/** Where request links open by default: the Gloam app. */
export const GLOAM_APP_ORIGIN = "https://gloam.trade";

export interface PaymentRequestParams {
  /** Your Gloam address (receive tag, gloamr1.…). The payment is sealed to it. */
  payTo: string;
  /** The network to be paid on: a GloamNetwork, its key ("robinhood-mainnet", "tempo-mainnet"), or its chain id. */
  network: GloamNetwork | GloamNetworkKey | number;
  /** The token to be paid in, by address or symbol on that network ("USDG", "USDC.e"). */
  asset: string;
  /** Amount in whole units as a decimal ("25", "12.5"). Leave it out to let the payer choose. */
  amount?: string;
  /** Private note the payment carries, like an agent ID. At most 80 characters; only you can read it. */
  note?: string;
  /** Name shown to the payer, at most 40 characters. */
  name?: string;
  /** Site the link opens. Default https://gloam.trade. */
  origin?: string;
}

function resolveNetwork(n: PaymentRequestParams["network"]): GloamNetwork {
  const net = typeof n === "object" ? n : typeof n === "number" ? networkForChainId(n) : getGloamNetwork(n);
  if (!net) throw new Error(`Gloam does not run on ${typeof n === "object" ? n.key : n} in this SDK version.`);
  return net;
}

/** The token a request names, looked up by address or symbol (either case) on one network. */
export function findRequestAsset(network: GloamNetwork, raw: string): GloamAsset | null {
  const v = raw.trim().toLowerCase();
  if (!v) return null;
  return network.assets.find((a) => a.address.toLowerCase() === v || a.symbol.toLowerCase() === v) ?? null;
}

/**
 * Checks an amount the way the app does and returns it as a plain decimal
 * ("1250", "12.5"), or throws a plain-language error. Empty means "payer chooses".
 */
export function normalizeRequestAmount(input: string, asset: Pick<GloamAsset, "decimals" | "symbol">): string {
  const s = input.trim().replace(/,/g, "");
  if (!s) return "";
  if (!/^(\d+\.?\d*|\.\d+)$/.test(s)) throw new Error("Use numbers and one dot for the amount, like 1250 or 12.50.");
  const [rawInt = "", rawFrac = ""] = s.split(".");
  if (rawFrac.length > asset.decimals) throw new Error(`${asset.symbol} goes to ${asset.decimals} decimal places at most.`);
  const int = rawInt.replace(/^0+(?=\d)/, "") || "0";
  const frac = rawFrac.replace(/0+$/, "");
  if (int.length > 15) throw new Error("That amount is too large.");
  if (/^0*$/.test(int) && !frac) throw new Error("Use an amount above zero, or leave it out.");
  return frac ? `${int}.${frac}` : int;
}

/**
 * The shareable request link, exactly as the Gloam app builds it. Throws when
 * payTo is not a Gloam address, the token is not one the network's vault takes,
 * the amount is not a valid number, or the note is longer than 80 characters
 * (an agent ID must never arrive cut short, so it is refused, not trimmed).
 */
export function buildPaymentRequestLink(params: PaymentRequestParams): string {
  const { net, asset, amount, note, name } = checkedRequest(params);

  // Same fields, in the same order, as the app's buildPaymentRequestLink.
  const p = new URLSearchParams();
  p.set("to", params.payTo.trim());
  if (amount) p.set("amount", amount);
  p.set("asset", asset.address);
  if (note) p.set("note", note);
  p.set("chain", net.key);
  if (name) p.set("name", name);
  const origin = (params.origin ?? GLOAM_APP_ORIGIN).replace(/\/+$/, "");
  return `${origin}/app/vault?tab=move&mode=pay#${p.toString()}`;
}

/**
 * The same request as a short link (https://gloam.trade/r#<letters and digits>),
 * exactly as the Gloam app builds it, with the same checks as
 * buildPaymentRequestLink. parsePaymentRequestLink reads both.
 */
export function buildShortPaymentRequestLink(params: PaymentRequestParams): string {
  const { net, asset, amount, note, name } = checkedRequest(params);
  const body = encodeShortRequest({
    to: params.payTo.trim(),
    chainId: net.chainId,
    asset: asset.address,
    decimals: asset.decimals,
    ...(amount ? { amount } : {}),
    ...(note ? { note } : {}),
    ...(name ? { name } : {}),
  });
  if (!body) return buildPaymentRequestLink(params);
  return shortRequestLink(body, params.origin ?? GLOAM_APP_ORIGIN);
}

function checkedRequest(params: PaymentRequestParams) {
  assertReceiveTag(params.payTo, "payTo");
  const net = resolveNetwork(params.network);
  const asset = findRequestAsset(net, params.asset);
  if (!asset) {
    const listed = net.assets.map((a) => a.symbol).join(", ");
    throw new Error(`The ${net.label} vault does not take "${params.asset}". It takes: ${listed}.`);
  }
  const amount = params.amount === undefined ? "" : normalizeRequestAmount(params.amount, asset);
  const note = cleanText(params.note, Number.MAX_SAFE_INTEGER);
  if (Array.from(note).length > REQUEST_NOTE_MAX) {
    throw new Error(`The note is ${Array.from(note).length} characters. A payment note holds at most ${REQUEST_NOTE_MAX}.`);
  }
  const name = cleanText(params.name, REQUEST_NAME_MAX);
  return { net, asset, amount, note, name };
}

/** A request read back from a link the SDK or the app built. */
export interface ParsedPaymentRequest {
  payTo: string | null;
  networkKey: string | null;
  asset: Address | null;
  amount: string | null;
  note: string | null;
  name: string | null;
}

/** Reads a request link's fields (fragment first, then the query string), without checking them. */
export function parsePaymentRequestLink(link: string): ParsedPaymentRequest {
  const url = new URL(link);
  if (/\/r\/?$/.test(url.pathname) && /^#[0-9A-Za-z]+$/.test(url.hash)) {
    const r = decodeShortRequest(url.hash.slice(1), (chainId, asset) => {
      const n = networkForChainId(chainId);
      return n ? findRequestAsset(n, asset)?.decimals ?? null : null;
    });
    return {
      payTo: r.to,
      networkKey: networkForChainId(r.chainId)?.key ?? null,
      asset: r.asset,
      amount: r.amount ?? null,
      note: r.note ?? null,
      name: r.name ?? null,
    };
  }
  const out = new URLSearchParams(url.search);
  const frag = url.hash.startsWith("#") ? url.hash.slice(1) : url.hash;
  if (frag && !frag.startsWith("claim=")) for (const [k, v] of new URLSearchParams(frag)) out.set(k, v);
  const note = cleanText(out.get("note"), REQUEST_NOTE_MAX);
  const name = cleanText(out.get("name"), REQUEST_NAME_MAX);
  return {
    payTo: out.get("to")?.trim() || null,
    networkKey: out.get("chain") || null,
    asset: (out.get("asset") as Address | null) || null,
    amount: out.get("amount") || null,
    note: note || null,
    name: name || null,
  };
}
