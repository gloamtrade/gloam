/**
 * Payment requests: a link that asks someone to pay an address.
 *
 *   https://gloam.trade/app/vault?tab=move&mode=pay#to=gloamr1.…&amount=1250
 *     &asset=0x…&note=Invoice+042&chain=robinhood-mainnet&name=Robin
 *
 * `to` is one of:
 *  - a Gloam address (gloamr1.…): Pay sends a private payment to it, and the
 *    note travels inside the payment, sealed so only the payee can read it
 *    (lib/paymentNote);
 *  - a 0x address or an ENS name: the link opens Cash out to that wallet, the
 *    same path as typing it into Pay and pressing "Pay this wallet"
 *    (lib/payRecipient). The relay sends it from the private balance, so the
 *    payer's wallet does not show; the amount and the receiving wallet are
 *    public, like any transfer. The note is only shown to the payer.
 *
 * `p` is a Gloam partner's link code (lib/partnerLinks), when a partner's app
 * made the link: the payment is counted to that partner once it lands, and the
 * partner's name shows from their Gloam account. A `name` alone counts for
 * nothing and is only ever shown as what the link says.
 *
 * `chain` is a network key (lib/networks): `robinhood-mainnet`,
 * `tempo-mainnet`, ... for mainnet; `robinhood`, `tempo`, `base`, `ethereum`
 * are the testnets. `asset` is the token's address or symbol on that network.
 *
 * The link only pre-fills the form on the payer's side. Nothing about a
 * request is posted on chain. The details sit in the URL fragment (after #),
 * which browsers never send to a server or put in a referrer, so they stay
 * between the two people who share the link. The same fields are also read
 * from the query string, so hand-made `?to=…&amount=…` links work. The payer
 * still checks the details and presses send, and every field is validated
 * before it is used.
 */

import { zeroAddress, type Address } from "viem";
import { NETWORK_KEYS, getNetwork, isNetworkKey, networkName, type NetworkKey } from "./networks";
import { PAYMENT_NOTE_MAX, cleanText } from "./paymentNote";
import { isValidReceiveTag } from "./receiveTag";
import { readAmountText } from "./amountText";
import { classifyPayRecipient } from "./payRecipient";
import { isLinkCodeShape, readLinkCode } from "./partnerCode";
import { isDollarStable, shieldTokensFor, supportsNativeShield, swapDisplayTokensFor } from "./tokens";
import { decodeShortRequest, encodeShortRequest, shortRequestLink } from "@gloamtrade/sdk";

/** Same cap as the private note the payment carries (lib/paymentNote). */
export const REQUEST_NOTE_MAX = PAYMENT_NOTE_MAX;
export const REQUEST_NAME_MAX = 40;

/** A token someone can ask to be paid in, on one network. */
export type RequestAsset = {
  /** Token id from lib/tokens (for TokenLogo), or "native". */
  id: string;
  symbol: string;
  /** ERC-20 address, or the zero address for the chain's native coin. */
  address: Address;
  decimals: number;
  native: boolean;
  /** A dollar stablecoin. EURC is a stablecoin too, but a euro one, so not this. */
  stable: boolean;
  /** Set for a stablecoin pegged to another currency (EURC: the euro). */
  peg?: "EUR";
};

/** Tokens a request can name on a network: stablecoins first, then the rest. */
export function requestAssetsFor(key: NetworkKey): RequestAsset[] {
  const n = getNetwork(key);
  const tokens = shieldTokensFor(n.chainId);
  const toAsset = (t: (typeof tokens)[number]): RequestAsset => ({
    id: t.id,
    symbol: t.symbol,
    address: t.address,
    decimals: t.decimals,
    native: false,
    stable: isDollarStable(t),
    ...(t.peg ? { peg: t.peg } : {}),
  });
  const native: RequestAsset[] = supportsNativeShield(n.chainId)
    ? [
        {
          id: "native",
          symbol: n.primaryAsset.symbol,
          address: zeroAddress,
          decimals: n.primaryAsset.decimals,
          native: true,
          stable: false,
        },
      ]
    : [];
  return [
    ...tokens.filter((t) => t.kind === "stablecoin").map(toAsset),
    ...native,
    ...tokens.filter((t) => t.kind !== "stablecoin").map(toAsset),
  ];
}

/** Looks a token up by address or symbol (either case) on one network. */
export function findRequestAsset(key: NetworkKey, raw: string): RequestAsset | null {
  const v = raw.trim().toLowerCase();
  if (!v) return null;
  return (
    requestAssetsFor(key).find(
      (a) => a.address.toLowerCase() === v || a.symbol.toLowerCase() === v
    ) ?? null
  );
}

/**
 * Why a payment code can't be claimed on this network, or null when it can.
 * The mainnet vaults sit at the same address (and Base's and Ethereum's can
 * too), so the vault alone can't tell a Robinhood Chain code from a Tempo one;
 * the asset can. A code claimed on the wrong one would sit in the balance as
 * "not settled". ETH is the zero address on Base Sepolia, Base mainnet,
 * Ethereum and Robinhood Chain alike, so a code now names its chain
 * (NotePackage.chainId) and is refused on any other; an older code without it is
 * matched on vault and asset, and its link's ?net= picks the network. Robinhood
 * Chain listed ETH long after codes began naming their chain, so an ETH code with
 * no chain was never made there.
 */
export function claimNetworkProblem(
  network: { key: NetworkKey; pool: string | null },
  pack: { pool?: string; asset: string; chainId?: number }
): string | null {
  // A code made since 25 Oct 2026 names its chain: the only thing that tells Base from Base
  // Sepolia (and Ethereum) for ETH, where the vault and the asset have the same address.
  const here = getNetwork(network.key);
  if (pack.chainId !== undefined && pack.chainId !== here.chainId) {
    const there = NETWORK_KEYS.map(getNetwork).find((n) => n.chainId === pack.chainId);
    return there
      ? `This payment is on ${networkName(there)}. Switch to it, then claim it again.`
      : "This payment is on a network Gloam does not run on.";
  }
  if (pack.pool && network.pool && pack.pool.toLowerCase() !== network.pool.toLowerCase()) {
    return "This payment is for a different vault or network.";
  }
  const asset = pack.asset.trim().toLowerCase();
  const olderEthCode = pack.chainId === undefined && here.chainId === 4663 && asset === zeroAddress;
  // Also what a private swap lands in (WETH, the stocks): a note in one spends like any other.
  const held = [...requestAssetsFor(network.key), ...swapDisplayTokensFor(here.chainId)];
  if (olderEthCode || !held.some((a) => a.address.toLowerCase() === asset)) {
    return "This payment is on a different network. Switch network, then claim it again.";
  }
  return null;
}

/** A whole Gloam address (gloamr1.<base64url P-256 key>) that decodes, not just its shape. */
export function isValidRequestTag(input: string): boolean {
  return isValidReceiveTag(input);
}

/**
 * Checks a typed amount. Empty is allowed (the payer then chooses). Returns the
 * amount as a plain decimal string ("1250", "12.5") or a message to show.
 */
export function normalizeRequestAmount(
  input: string,
  asset: Pick<RequestAsset, "decimals" | "symbol">
): { value: string } | { error: string } {
  const read = readAmountText(input);
  if (!read.ok) return { error: read.error };
  const s = read.text;
  if (!s) return { value: "" };
  const [rawInt, rawFrac = ""] = s.split(".");
  if (rawFrac.length > asset.decimals) {
    return {
      error: `${asset.symbol} goes to ${asset.decimals} decimal places at most.`,
    };
  }
  const int = rawInt.replace(/^0+(?=\d)/, "") || "0";
  const frac = rawFrac.replace(/0+$/, "");
  if (int.length > 15) return { error: "That amount is too large." };
  if (/^0*$/.test(int) && !frac) {
    return { error: "Enter an amount above zero, or leave it empty." };
  }
  return { value: frac ? `${int}.${frac}` : int };
}

// Lives in lib/amountText, which imports nothing: Portfolio's first-payment card
// shows an amount without loading this module (and the ENS name handling it needs).
export { formatRequestAmount } from "./amountText";

/** Drops control and direction-override characters, squeezes spaces, caps length. */
export function cleanRequestText(raw: string | null | undefined, max: number): string {
  return cleanText(raw, max);
}

export type PaymentRequestDraft = {
  to: string;
  network: NetworkKey;
  asset: RequestAsset;
  /** Normalized decimal, or "" to let the payer choose. */
  amount: string;
  note?: string;
  name?: string;
  /** A partner's link code (lib/partnerLinks), so the payment counts to that partner. */
  partnerCode?: string;
};

/**
 * The shareable link. `origin` is the site the link opens (gloam.trade in
 * production). Only the tab and mode go in the query; the request rides in the
 * fragment so no server sees it.
 */
export function buildPaymentRequestLink(
  draft: PaymentRequestDraft,
  origin = "https://gloam.trade"
): string {
  const p = new URLSearchParams();
  p.set("to", draft.to.trim());
  if (draft.amount) p.set("amount", draft.amount);
  p.set("asset", draft.asset.address);
  const note = cleanRequestText(draft.note, REQUEST_NOTE_MAX);
  if (note) p.set("note", note);
  p.set("chain", draft.network);
  const name = cleanRequestText(draft.name, REQUEST_NAME_MAX);
  if (name) p.set("name", name);
  if (isLinkCodeShape(draft.partnerCode)) p.set("p", draft.partnerCode);
  return `${origin.replace(/\/+$/, "")}/app/vault?tab=move&mode=pay#${p.toString()}`;
}

/**
 * The same request as a short link: gloam.trade/r#<letters and digits> (SDK
 * shortLink). The /r page turns it back into the long link above, in the
 * browser, so the request still never reaches a server. Falls back to the long
 * link for a request the short form can't carry exactly.
 */
export function buildShortPaymentRequestLink(
  draft: PaymentRequestDraft,
  origin = "https://gloam.trade"
): string {
  const note = cleanRequestText(draft.note, REQUEST_NOTE_MAX);
  const name = cleanRequestText(draft.name, REQUEST_NAME_MAX);
  const body = encodeShortRequest({
    to: draft.to.trim(),
    chainId: getNetwork(draft.network).chainId,
    asset: draft.asset.address,
    decimals: draft.asset.decimals,
    ...(draft.amount ? { amount: draft.amount } : {}),
    ...(note ? { note } : {}),
    ...(name ? { name } : {}),
    ...(isLinkCodeShape(draft.partnerCode) ? { partnerCode: draft.partnerCode } : {}),
  });
  return body ? shortRequestLink(body, origin) : buildPaymentRequestLink(draft, origin);
}

/**
 * The long request link a short one stands for (what the /r page opens), or
 * null when the short link is cut off or damaged. A network Gloam doesn't run
 * on is left out, so the payer's own network and its checks apply.
 */
export function requestLinkFromShort(body: string, origin: string): string | null {
  const keyOf = (chainId: number) => NETWORK_KEYS.find((k) => getNetwork(k).chainId === chainId) ?? null;
  let r: ReturnType<typeof decodeShortRequest>;
  try {
    r = decodeShortRequest(body, (chainId, asset) => {
      const key = keyOf(chainId);
      return key ? findRequestAsset(key, asset)?.decimals ?? null : null;
    });
  } catch {
    return null;
  }
  const p = new URLSearchParams();
  p.set("to", r.to);
  if (r.amount) p.set("amount", r.amount);
  p.set("asset", r.asset);
  if (r.note) p.set("note", r.note);
  const key = keyOf(r.chainId);
  if (key) p.set("chain", key);
  if (r.name) p.set("name", r.name);
  if (r.partnerCode) p.set("p", r.partnerCode);
  return `${origin.replace(/\/+$/, "")}/app/vault?tab=move&mode=pay#${p.toString()}`;
}

/** Request fields from a URL: the fragment first, then the query string. */
export function requestParamsFrom(search: string, hash: string): URLSearchParams {
  const out = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const frag = hash.startsWith("#") ? hash.slice(1) : hash;
  // Claim links also use the fragment (#claim=…); those are not requests.
  if (frag && !frag.startsWith("claim=")) {
    for (const [k, v] of new URLSearchParams(frag)) out.set(k, v);
  }
  return out;
}

/** A request read back from a link. Bad fields are dropped and explained in `problems`. */
/** What a request's `to` is: a Gloam address (a private payment) or a wallet (Cash out to it). */
export type RequestRecipientKind = "gloam" | "address" | "ens";

export type PaymentRequest = {
  /**
   * Who to pay, or null when the link's one was missing or broken: a whole
   * Gloam address, a checksum-valid 0x address, or a normalized ENS name.
   */
  to: string | null;
  /** What `to` is, or null with `to`. A wallet ("address", "ens") is paid through Cash out. */
  toKind: RequestRecipientKind | null;
  /** Network the link names, or null when it names none (or an unknown one). */
  network: NetworkKey | null;
  asset: RequestAsset | null;
  /** Normalized decimal, or null when absent or invalid. */
  amount: string | null;
  note: string | null;
  name: string | null;
  /** A partner link code's shape from `p`, or null. Whether it is live is the server's to say. */
  partnerCode: string | null;
  /** Plain-language reasons a field was left out. */
  problems: string[];
};

/**
 * Reads a request from the vault URL's search params. Returns null when the
 * URL carries no request. `fallback` is the network to resolve the token on
 * when the link names none.
 */
export function readPaymentRequest(
  params: URLSearchParams | { get(name: string): string | null },
  fallback: NetworkKey
): PaymentRequest | null {
  const rawTo = params.get("to");
  const rawAmount = params.get("amount");
  if (rawTo === null && rawAmount === null) return null;

  const problems: string[] = [];

  const rawChain = params.get("chain");
  let network: NetworkKey | null = null;
  if (rawChain) {
    if (isNetworkKey(rawChain)) network = rawChain;
    else problems.push("This link names a network Gloam does not run on, so check it with the person who sent it.");
  }
  const onNet = network ?? fallback;

  let to: string | null = null;
  let toKind: RequestRecipientKind | null = null;
  const recipient = classifyPayRecipient(rawTo ?? "");
  if (recipient.kind === "empty") {
    problems.push("This link has no address to pay in it. Ask them to send it again.");
  } else if (recipient.kind === "gloam") {
    if (isValidRequestTag(rawTo ?? "")) {
      to = (rawTo ?? "").trim();
      toKind = "gloam";
    } else {
      problems.push("The Gloam address in this link is not complete, so it was left out. Ask them to send the link again.");
    }
  } else if (recipient.kind === "address") {
    // Money sent to the zero address is gone for good.
    if (recipient.address.toLowerCase() === zeroAddress) {
      problems.push("This link asks to pay the zero address, which nobody can spend from, so it was left out.");
    } else {
      to = recipient.address;
      toKind = "address";
    }
  } else if (recipient.kind === "ens") {
    to = recipient.name;
    toKind = "ens";
  } else if (recipient.kind === "badAddress") {
    problems.push("The 0x address in this link looks mistyped, so it was left out. Ask them to send the link again.");
  } else {
    problems.push("The address in this link is not a Gloam address, a 0x address or an ENS name, so it was left out.");
  }

  let asset: RequestAsset | null = null;
  const rawAsset = params.get("asset");
  if (rawAsset?.trim()) {
    asset = findRequestAsset(onNet, rawAsset);
    if (!asset) {
      problems.push(`This link asks for a token Gloam does not support on ${networkName(getNetwork(onNet))}.`);
    }
  }

  // An amount means nothing without its token: "5" could be 5 USDG or 5 ETH,
  // so it is only filled in when the link names a token Gloam knows.
  let amount: string | null = null;
  if (rawAmount?.trim() && !asset) {
    if (!rawAsset?.trim()) problems.push("This link has an amount but no token, so the amount was left blank.");
  } else if (rawAmount?.trim() && asset) {
    const r = normalizeRequestAmount(rawAmount, asset);
    if ("value" in r && r.value) amount = r.value;
    else problems.push("The amount in this link is not a valid number, so it was left blank.");
  }

  return {
    to,
    toKind,
    network,
    asset,
    amount,
    note: cleanRequestText(params.get("note"), REQUEST_NOTE_MAX) || null,
    name: cleanRequestText(params.get("name"), REQUEST_NAME_MAX) || null,
    partnerCode: readLinkCode(params),
    problems,
  };
}

/** A request that pays a wallet (0x address or ENS name) through Cash out, not a Gloam address. */
export function isWalletRequest(r: Pick<PaymentRequest, "toKind"> | null | undefined): boolean {
  return r?.toKind === "address" || r?.toKind === "ens";
}
