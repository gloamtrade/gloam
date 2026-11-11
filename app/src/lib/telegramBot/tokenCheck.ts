/**
 * Glim's token check: "token check 0x...", "/check $PONS", "is $PONS safe?".
 * The answer is Blocktronics' read of the token (lib/blocktronics, the same
 * cached reads as the swap card), never a verdict: no check can call a token
 * safe, and Glim says so. While BLOCKTRONICS_API_KEY is unset it says the check
 * isn't available yet. Server only.
 *
 * Only token contracts go to Blocktronics. An address Glim doesn't know as a
 * Gloam token is first read on chain (Robinhood Chain, Base and Ethereum
 * mainnets): it has to be a contract that answers decimals() like a token, so a
 * wallet someone pastes is never sent anywhere.
 */
import { createPublicClient, erc20Abi, type Address, type PublicClient } from "viem";
import { blocktronicsEnabled, tokenInsight } from "@/lib/blocktronics";
import { getNetwork, type NetworkKey } from "@/lib/networks";
import { serverTransport } from "@/lib/serverRpc";
import {
  INSIGHT_CHAIN_LABEL,
  bundlesText,
  checkableTokens,
  gradeText,
  holdersText,
  insightLine,
  isTokenAddress,
  type InsightChain,
  type TokenInsight,
} from "@/lib/tokenInsight";
import { COPYCAT_GLOAM, GLOAM_TOKEN } from "./knowledge";
import { norm } from "./rules";

export type TokenCheckAsk = {
  /** A contract address as written, or null when the ask names a symbol. */
  address: Address | null;
  /** One of Gloam's own token symbols, upper case, or null. */
  symbol: string | null;
  /** "on Base", "on Ethereum", "on Robinhood Chain", when the ask says. */
  chain: InsightChain | null;
};

const ADDR = String.raw`0x[0-9a-fA-F]{40}`;
const SYM = String.raw`\$?[A-Za-z][A-Za-z0-9]{1,11}`;
const CHAIN = String.raw`robinhood(?:\s+chain)?|rh|base|ethereum|eth`;
const ON = String.raw`(?:\s+(?:on|in)\s+(${CHAIN}))?`;
const END = String.raw`[\s?.!]*$`;
const SAFE = String.raw`(?:safe|legit|a\s+scam|a\s+rug(?:\s*pull)?|a\s+honeypot|safe\s+to\s+(?:buy|hold|swap|ape)|ok\s+to\s+(?:buy|hold))`;

/** "token check X", "check token X", "tokencheck: X", and /check's arguments made into the same. */
const CHECK_RE = new RegExp(String.raw`^(?:token\s*check|check\s+(?:the\s+|this\s+)?token)\s*:?\s+(${ADDR}|${SYM})(\s+token)?${ON}${END}`, "i");
/** "is X safe?", "is the X token legit", "is X on base a rug?" */
const IS_SAFE_RE = new RegExp(String.raw`^(?:is|are)\s+(?:the\s+|this\s+)?(token\s+)?(${ADDR}|${SYM})(\s+token)?${ON}\s+${SAFE}${ON}${END}`, "i");
/** "X safe?" with the question mark. */
const BARE_SAFE_RE = new RegExp(String.raw`^(${ADDR}|${SYM})(\s+token)?${ON}\s+(?:safe|legit)\s*\?${END}`, "i");

function chainOf(word: string | undefined): InsightChain | null {
  const w = word?.toLowerCase().replace(/\s+/g, " ").trim();
  if (!w) return null;
  if (w === "base") return "base";
  if (w === "ethereum" || w === "eth") return "ethereum";
  return "robinhood";
}

/**
 * A symbol counts only when it reads as a ticker: "$PONS", "the PONS token", a
 * token check, or written in capitals with three letters or more. "is ai safe"
 * and "is gloam safe" (the app, most likely) stay questions for the usual answer.
 */
function symbolOf(raw: string, tickerShaped: boolean): string | null {
  const dollar = raw.startsWith("$");
  const s = raw.replace(/^\$/, "");
  const caps = s.length >= 3 && s === s.toUpperCase() && /[A-Z]/.test(s);
  if (!dollar && !tickerShaped && !caps) return null;
  const upper = s.toUpperCase();
  return checkableTokens().some((t) => t.token.symbol.toUpperCase() === upper) ? upper : null;
}

/**
 * A token check, asked in so many words, or null. The message is read whole:
 * a tag or the helper's name in front is fine, anything more makes it a
 * question for the usual answer.
 */
export function tokenCheckAsk(text: string, persona = "Glim"): TokenCheckAsk | null {
  const name = persona.replace(/[^\p{L}\p{N}]/gu, "");
  let t = norm(text)
    .replace(/(?<![\w@])@\w+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (name) t = t.replace(new RegExp(String.raw`^(?:(?:hey|hi|yo|gm|ok|okay)[\s,]+)?${name}\b[\s,:]*`, "i"), "");
  t = t.replace(/^(?:(?:hey|hi|yo|gm|pls|please)[\s,]+)+/i, "").replace(/\s+(?:pls|please)(?=[\s?.!]*$)/i, "");
  if (!t || t.length > 120) return null;
  let m = CHECK_RE.exec(t);
  if (m) return build(m[1]!, true, m[3]);
  m = IS_SAFE_RE.exec(t);
  if (m) return build(m[2]!, Boolean(m[1] || m[3]), m[4] ?? m[5]);
  m = BARE_SAFE_RE.exec(t);
  if (m) return build(m[1]!, Boolean(m[2]), m[3]);
  return null;
}

function build(target: string, tickerShaped: boolean, chainWord: string | undefined): TokenCheckAsk | null {
  const chain = chainOf(chainWord);
  if (isTokenAddress(target)) return { address: target as Address, symbol: null, chain };
  if (/^0x/i.test(target)) return null;
  const symbol = symbolOf(target, tickerShaped);
  return symbol ? { address: null, symbol, chain } : null;
}

// ---------------------------------------------------------------- finding the token

const NETWORK_KEY: Record<InsightChain, NetworkKey> = {
  robinhood: "robinhood-mainnet",
  base: "base-mainnet",
  ethereum: "ethereum-mainnet",
};
const ORDER: InsightChain[] = ["robinhood", "base", "ethereum"];

/** A symbol a reply may repeat: letters and digits only, never a link or words someone put in a token's name. */
function safeSymbol(s: unknown): string | null {
  return typeof s === "string" && /^[A-Za-z0-9]{1,12}$/.test(s) ? s : null;
}

/** Whether `address` is a token contract on `chain`: it has code (not a wallet, not a delegated one) and answers decimals(). */
async function tokenOnChain(chain: InsightChain, address: Address): Promise<{ symbol: string | null } | null> {
  const n = getNetwork(NETWORK_KEY[chain]);
  const client = createPublicClient({
    chain: n.chain,
    ccipRead: false,
    transport: serverTransport(n, { timeout: 6_000, retryCount: 0 }),
  }) as PublicClient;
  const [code, decimals, symbol] = await Promise.all([
    client.getCode({ address }).catch(() => null),
    client.readContract({ address, abi: erc20Abi, functionName: "decimals" }).catch(() => null),
    client.readContract({ address, abi: erc20Abi, functionName: "symbol" }).catch(() => null),
  ]);
  if (!code || code === "0x" || code.toLowerCase().startsWith("0xef0100")) return null;
  if (decimals === null) return null;
  return { symbol: safeSymbol(symbol) };
}

type Target = { chain: InsightChain; address: Address; symbol: string | null };

/** Where the asked-about token lives. A Gloam token by its list; any other address by reading the chains. */
async function locate(ask: TokenCheckAsk): Promise<Target | "unknown_symbol" | "not_a_token"> {
  const known = checkableTokens().filter(({ token }) =>
    ask.address ? token.address.toLowerCase() === ask.address.toLowerCase() : token.symbol.toUpperCase() === ask.symbol,
  );
  const pick = known.find((k) => k.chain === ask.chain) ?? (ask.chain ? null : known[0]);
  if (pick) return { chain: pick.chain, address: pick.token.address, symbol: pick.token.symbol };
  if (!ask.address) return "unknown_symbol";
  const chains = ask.chain ? [ask.chain] : ORDER;
  const found = await Promise.all(chains.map((c) => tokenOnChain(c, ask.address!).catch(() => null)));
  const i = found.findIndex(Boolean);
  return i < 0 ? "not_a_token" : { chain: chains[i]!, address: ask.address, symbol: found[i]!.symbol };
}

// ---------------------------------------------------------------- the reply

const NOT_ADVICE = "No check can say a token is safe, so treat this as one input and do your own research.";

/** The check, as Glim posts it: plain text, one fact a line, the link last. */
export function tokenCheckReply(i: TokenInsight, symbol: string | null): string {
  const name = symbol ?? "This token";
  const lines = [`${name} on ${INSIGHT_CHAIN_LABEL[i.chain]}, from Blocktronics:`];
  if (i.grade) lines.push(`Grade ${gradeText(i.grade)}.`);
  if (i.holders != null) lines.push(`Holders: ${holdersText(i.holders)}`);
  const bundles = bundlesText(i.bundles);
  if (bundles) lines.push(i.bundles?.count === 0 ? "Launch bundles: none found" : `Launch bundles still hold ${bundles}`);
  return [lines.join("\n"), insightLine(i), NOT_ADVICE, i.url].join("\n\n");
}

/** The check while Blocktronics isn't switched on. */
export function tokenCheckOff(name: string, ask: TokenCheckAsk | null): string {
  const gloam = ask?.symbol === "GLOAM" || ask?.address?.toLowerCase() === GLOAM_TOKEN.address.toLowerCase();
  return `Token checks aren't available yet, ${name}.${gloam ? ` For $GLOAM itself, the facts are at ${GLOAM_TOKEN.page}.` : ""}`;
}

/** The usage line for a bare /check. */
export const TOKEN_CHECK_USAGE = "Send a token's contract address, like: token check 0x... on Base. Robinhood Chain, Base and Ethereum work.";

/**
 * Glim's whole answer to a token check. Never throws: anything that goes wrong
 * becomes a plain sentence.
 */
export async function answerTokenCheck(ask: TokenCheckAsk, name: string): Promise<string> {
  if (!blocktronicsEnabled()) return tokenCheckOff(name, ask);
  if (ask.address && COPYCAT_GLOAM.some((a) => a.toLowerCase() === ask.address!.toLowerCase())) {
    return `That is the copycat GLOAM token, not Gloam's, and it is flagged as a honeypot. The real $GLOAM is ${GLOAM_TOKEN.address}.`;
  }
  const where = await locate(ask).catch(() => "not_a_token" as const);
  if (where === "unknown_symbol") return TOKEN_CHECK_USAGE;
  if (where === "not_a_token") {
    const on = ask.chain ? INSIGHT_CHAIN_LABEL[ask.chain] : "Robinhood Chain, Base or Ethereum";
    return `I couldn't find a token at that address on ${on}, so there's nothing to check.`;
  }
  const label = where.symbol ?? "That token";
  const r = await tokenInsight(where.chain, where.address);
  const on = INSIGHT_CHAIN_LABEL[where.chain];
  switch (r.state) {
    case "ok":
      return tokenCheckReply(r.insight, where.symbol);
    case "off":
      return tokenCheckOff(name, ask);
    case "unavailable":
      return "I couldn't get the check from Blocktronics just now. Try again in a few minutes.";
    case "none":
      if (r.reason === "not_indexed") return `Blocktronics doesn't cover ${label} on ${on} yet, so there's no check to show.`;
      if (r.reason === "unsupported") return `Blocktronics doesn't grade ${label}: stablecoins, wrapped coins and stock tokens are left out.`;
      return `Blocktronics has no figures for ${label} on ${on} yet.`;
  }
}
