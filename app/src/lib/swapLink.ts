/**
 * Swap links: a link that opens the Swap tab with a private swap filled in,
 * so a trading app can offer "Trade privately with Gloam".
 *
 *   https://gloam.trade/app/vault?tab=swap#from=USDG&to=TSLA&amount=100
 *     &chain=robinhood-mainnet&p=<partner link code>
 *
 * `from` and `to` are a token's symbol or address on that network. Only tokens
 * the swap router lists there are filled in (lib/vaultSwap VAULT_SWAP_ASSETS);
 * any other is left out and the person is told why. `amount` is in whole
 * tokens of `from` (100 is 100 USDG), not base units. `chain` is a network key,
 * the same keys a payment request link takes (lib/paymentRequest). `ref` is a
 * short name for whoever sent the link, shown as what the link says. `p` is a
 * Gloam partner's link code (lib/partnerLinks): with a live one, the name shown
 * is the partner's own from their Gloam account ("From Motion"), and the swap is
 * counted to them once it lands. `ref` alone counts for nothing.
 *
 * Like a payment request link, it only fills in the form, and it stays in the
 * fragment (after #), which browsers never send to a server. Nothing swaps on
 * its own: the person sees the live quote with every check the Swap tab makes,
 * and taps Swap privately. A swap hides who swapped, not the tokens or the
 * amounts, and the Swap tab says so.
 *
 * Unlike a payment request link, it is read from the fragment only. The Vault
 * keeps the rest of the query when it switches tabs, and Pay reads `to` and
 * `amount` from the query too, so query fields would carry a swap into Pay as a
 * payment request. A request link names tab=move, so neither reads the other.
 *
 * Pure (no browser APIs), so scripts/selftest-swap-link.mts can hold it.
 */
import type { Address } from "viem";
import { getNetwork, isNetworkKey, NETWORK_KEYS, networkName, type NetworkKey } from "./networks";
import { REQUEST_NAME_MAX, cleanRequestText, normalizeRequestAmount } from "./paymentRequest";
import { isLinkCodeShape, readLinkCode } from "./partnerCode";
import { NATIVE_ETH_TOKEN, knownTokens } from "./tokens";
import { VAULT_SWAP_ASSETS, swapMainnets, vaultSwapRouter } from "./vaultSwap";

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** The longest `ref` shown, and its most words. A partner's name, not a sentence. */
export const SWAP_REF_MAX = 32;
export const SWAP_REF_WORDS = 4;

/** A token a swap link can name on one network: one the swap router lists there. */
export type SwapLinkToken = {
  /** Token id from lib/tokens (TokenLogo, Add's ?asset=). */
  id: string;
  symbol: string;
  address: Address;
  decimals: number;
};

export type SwapLink = {
  /** The network the link names, or null when it names none, or one Gloam does not run on. */
  network: NetworkKey | null;
  /**
   * Where its tokens were looked up: the network it names, else the one shown
   * when it was opened. null when that network has no private swaps, and then
   * nothing is filled in.
   */
  on: NetworkKey | null;
  /** The token to pay with, or null when the link's one was missing or not swappable there. */
  from: SwapLinkToken | null;
  /** The token to get, likewise. */
  to: SwapLinkToken | null;
  /** In whole tokens of `from`, normalized ("100", "12.5"), or null when absent or invalid. */
  amount: string | null;
  /** Who sent the link ("Motion"), cleaned, or null. What the link says; never counted. */
  ref: string | null;
  /** A partner link code's shape from `p`, or null. Whether it is live is the server's to say. */
  partnerCode: string | null;
  /** Plain-language reasons a field was left out. */
  problems: string[];
};

/** Whether new private swaps run on a network now: a router, and tokens it swaps between. */
export function swapsOn(key: NetworkKey): boolean {
  const chainId = getNetwork(key).chainId;
  return vaultSwapRouter(chainId) !== null && (VAULT_SWAP_ASSETS[chainId]?.length ?? 0) > 0;
}

/** The networks a swap link can open on now, mainnets first. */
export function swapNetworks(): NetworkKey[] {
  return NETWORK_KEYS.filter(swapsOn);
}

/** The tokens a swap link can name on a network, in the router's order. Empty where swaps are off. */
export function swapLinkTokensFor(key: NetworkKey): SwapLinkToken[] {
  if (!swapsOn(key)) return [];
  const chainId = getNetwork(key).chainId;
  const known = knownTokens(chainId);
  return (VAULT_SWAP_ASSETS[chainId] ?? []).flatMap((a): SwapLinkToken[] => {
    const t = same(a, NATIVE_ETH_TOKEN.address) ? NATIVE_ETH_TOKEN : known.find((k) => same(k.address, a));
    return t ? [{ id: t.id, symbol: t.symbol, address: a, decimals: t.decimals }] : [];
  });
}

/**
 * A token by symbol or address (either case, a leading $ allowed: "$GLOAM"),
 * among the ones the router lists on that network. Where the router holds ETH
 * as WETH (Robinhood Chain, until native ETH notes swap), "ETH" is WETH.
 */
export function findSwapToken(key: NetworkKey, raw: string): SwapLinkToken | null {
  const v = raw.trim().toLowerCase().replace(/^\$/, "");
  if (!v) return null;
  const list = swapLinkTokensFor(key);
  const hit = list.find((t) => t.address.toLowerCase() === v || t.symbol.toLowerCase() === v);
  if (hit) return hit;
  return v === "eth" ? (list.find((t) => t.id === "weth") ?? null) : null;
}

/** A plain name: letters and digits in any script, spaces and . & ' _ - inside it. */
const PLAIN_NAME = /^[\p{L}\p{N}](?:[\p{L}\p{N} .&'_-]*[\p{L}\p{N}.])?$/u;

/**
 * `ref` as shown, or null with the reason. Cleaned like a request's name
 * (control and direction-override characters out, spaces squeezed), then held
 * to a plain name of at most SWAP_REF_MAX characters and SWAP_REF_WORDS words:
 * letters, digits and a little punctuation, so no web addresses, no markup and
 * no messages. A link from another app can't say it comes from Gloam.
 */
export function readSwapRef(raw: string | null | undefined): { ref: string | null; problem: string | null } {
  const cleaned = cleanRequestText(raw, REQUEST_NAME_MAX * 4);
  if (!cleaned) return { ref: null, problem: null };
  const cut = Array.from(cleaned).slice(0, SWAP_REF_MAX).join("").trim();
  // a web address reads as somewhere to go ("wallet-check.app"), and many words as a message, not a name
  if (!PLAIN_NAME.test(cut) || /\.\p{L}/u.test(cut) || cut.split(" ").length > SWAP_REF_WORDS) {
    return { ref: null, problem: "The sender's name in this link is not a plain name, so it was left out." };
  }
  if (/gloam/i.test(cut)) {
    return { ref: null, problem: "A link can't say it comes from Gloam, so the sender's name was left out." };
  }
  return { ref: cut, problem: null };
}

/** The swap link's fields from a URL fragment. A claim link's fragment (#claim=…) is not one. */
export function swapLinkParams(hash: string): URLSearchParams {
  const frag = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!frag || frag.startsWith("claim=")) return new URLSearchParams();
  return new URLSearchParams(frag);
}

type Params = URLSearchParams | { get(name: string): string | null };

const isSwapLink = (p: Params) => p.get("from") !== null || p.get("to") !== null || p.get("amount") !== null;

/**
 * Reads a swap link. Returns null when the fields carry none (no from, to or
 * amount). `fallback` is the network shown, used when the link names none.
 * A network that is unknown, or has no private swaps, fills in nothing: a
 * token named for one chain is never guessed on another.
 */
export function readSwapLink(params: Params, fallback: NetworkKey): SwapLink | null {
  if (!isSwapLink(params)) return null;
  const problems: string[] = [];
  const { ref, problem: refProblem } = readSwapRef(params.get("ref"));

  const rawChain = params.get("chain");
  let network: NetworkKey | null = null;
  let on: NetworkKey | null = null;
  if (rawChain?.trim()) {
    if (!isNetworkKey(rawChain)) {
      problems.push("This link names a network Gloam does not run on, so nothing was filled in.");
    } else {
      network = rawChain;
      if (swapsOn(rawChain)) on = rawChain;
      else problems.push(`Private swaps are not open on ${networkName(getNetwork(rawChain))}, so nothing was filled in.`);
    }
  } else if (swapsOn(fallback)) {
    on = fallback;
  } else {
    problems.push(`This link names no network, and private swaps run on ${swapMainnets()}. Switch to one of them.`);
  }

  let from: SwapLinkToken | null = null;
  let to: SwapLinkToken | null = null;
  let amount: string | null = null;
  const rawFrom = params.get("from")?.trim() ?? "";
  const rawTo = params.get("to")?.trim() ?? "";
  const rawAmount = params.get("amount")?.trim() ?? "";
  if (on) {
    const where = networkName(getNetwork(on));
    if (rawFrom) {
      from = findSwapToken(on, rawFrom);
      if (!from) problems.push(`The token to pay with is not one Gloam can swap on ${where}, so it was left out.`);
    }
    if (rawTo) {
      to = findSwapToken(on, rawTo);
      if (!to) problems.push(`The token to get is not one Gloam can swap on ${where}, so it was left out.`);
    }
    if (from && to && same(from.address, to.address)) {
      to = null;
      problems.push("This link swaps a token for itself, so the token to get was left out.");
    }
    // An amount means nothing without its token: "100" could be 100 USDG or 100 ETH.
    if (rawAmount && !from) {
      if (!rawFrom) problems.push("This link has an amount but no token to pay with, so the amount was left blank.");
    } else if (rawAmount && from) {
      const r = normalizeRequestAmount(rawAmount, from);
      if ("value" in r && r.value) amount = r.value;
      else problems.push("The amount in this link is not a valid number, so it was left blank.");
    }
  }
  if (refProblem) problems.push(refProblem);

  return { network, on, from, to, amount, ref, partnerCode: readLinkCode(params), problems };
}

/** The swap link in a fragment, or null (lib/swapLink readSwapLink). */
export function swapLinkFromHash(hash: string, fallback: NetworkKey): SwapLink | null {
  return readSwapLink(swapLinkParams(hash), fallback);
}

/**
 * The network a swap link in this fragment opens on, when it names one with
 * private swaps: the Vault moves there once, so the Swap tab opens even from a
 * network without swaps. null otherwise.
 */
export function swapLinkNetwork(hash: string): NetworkKey | null {
  const p = swapLinkParams(hash);
  if (!isSwapLink(p)) return null;
  const c = p.get("chain");
  return isNetworkKey(c) && swapsOn(c) ? c : null;
}

/**
 * What the Vault says when ?tab=swap opens on a network without private swaps,
 * or null when this one has them. A swap link's own network, if it has swaps,
 * is moved to instead (swapLinkNetwork), so it gets no note.
 */
export function swapsElsewhereNote(key: NetworkKey, hash: string): string | null {
  if (swapsOn(key)) return null;
  const p = swapLinkParams(hash);
  const c = p.get("chain");
  if (isSwapLink(p) && c) {
    if (!isNetworkKey(c)) return "This swap link names a network Gloam does not run on. Check it with whoever sent it.";
    if (!swapsOn(c)) return `This swap link is for ${networkName(getNetwork(c))}, where private swaps are not open. They run on ${swapMainnets()}.`;
  }
  return `Private swaps run on ${swapMainnets()}. Switch to one of them to swap.`;
}

/** "Swap 100 USDG for TSLA", "Swap USDG for TSLA", "Get TSLA", "Swap 100 USDG", or "Swap" when nothing was filled in. */
export function swapLinkSummary(link: Pick<SwapLink, "from" | "to" | "amount">): string {
  const pay = link.from ? `${link.amount ? `${groupAmount(link.amount)} ` : ""}${link.from.symbol}` : null;
  if (pay && link.to) return `Swap ${pay} for ${link.to.symbol}`;
  if (pay) return `Swap ${pay}`;
  if (link.to) return `Get ${link.to.symbol}`;
  return "Swap";
}

function groupAmount(amount: string): string {
  const [int, frac] = amount.split(".");
  const grouped = int!.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return frac ? `${grouped}.${frac}` : grouped;
}

/** The link that opens the Swap tab with this swap filled in. Fields ride in the fragment. */
export function buildSwapLink(
  d: { from: string; to: string; amount?: string; network: NetworkKey; ref?: string; partnerCode?: string },
  origin = "https://gloam.trade"
): string {
  const p = new URLSearchParams();
  p.set("from", d.from.trim());
  p.set("to", d.to.trim());
  if (d.amount?.trim()) p.set("amount", d.amount.trim());
  p.set("chain", d.network);
  const { ref } = readSwapRef(d.ref);
  if (ref) p.set("ref", ref);
  if (isLinkCodeShape(d.partnerCode)) p.set("p", d.partnerCode);
  return `${origin.replace(/\/+$/, "")}/app/vault?tab=swap#${p.toString()}`;
}

/** What the person does next, before the swap can go. */
export type SwapLinkStep =
  | { kind: "signin"; text: string }
  | { kind: "add"; text: string; token: SwapLinkToken; addable: boolean; bridge: boolean };

/**
 * The next step a swap link shows: sign in, or add the token to pay with when
 * the private balance in it is none or too little. null when the swap can go
 * ahead (the Swap tab's own checks still apply), while the balance is still
 * being read, or when the link is for another network (the banner offers the
 * switch first). `held` is the private balance in `from` here, in base units;
 * `need` is the link's amount in base units, or null for any amount. `addable`:
 * Add takes the token on this network. `bridge`: Bring money over lands it here.
 */
export function swapLinkStep(
  link: Pick<SwapLink, "from" | "on">,
  s: {
    signedIn: boolean;
    network: NetworkKey;
    known: boolean;
    held: bigint;
    need: bigint | null;
    addable: boolean;
    bridge: boolean;
    heldLabel?: string;
  }
): SwapLinkStep | null {
  if (!s.signedIn) {
    return { kind: "signin", text: "Sign in with the wallet you use with Gloam to swap. This swap stays filled in." };
  }
  const t = link.from;
  if (!t || link.on !== s.network) return null;
  const enough = s.need === null ? s.held > BigInt(0) : s.held >= s.need;
  if (enough || !s.known) return null;
  const where = networkName(getNetwork(s.network));
  const how = s.addable
    ? s.bridge
      ? `Add ${t.symbol} privately, or bring money over from another chain.`
      : `Add ${t.symbol} privately first.`
    : `Swap into ${t.symbol} from something you hold first.`;
  const have =
    s.held > BigInt(0)
      ? `Your private ${t.symbol} on ${where} is ${s.heldLabel ?? "less than this swap needs"}.`
      : `You have no private ${t.symbol} on ${where} yet.`;
  return { kind: "add", text: `${have} ${how} This swap stays ready.`, token: t, addable: s.addable, bridge: s.bridge };
}
