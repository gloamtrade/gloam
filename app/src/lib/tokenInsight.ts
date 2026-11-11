/**
 * A token check: what Blocktronics (blocktronics.xyz) reads about a public
 * token, as the swap card and Glim show it. Shared by the browser and the
 * server: no key, no fetch and nothing about the person here. The server side
 * (the key, the calls, the cache) is lib/blocktronics.ts, behind
 * /api/token-insight.
 *
 * Blocktronics covers Base, Ethereum and Robinhood Chain mainnets. Only token
 * contracts are ever checked, never a wallet, a balance or anything about who
 * is asking.
 */
import { walletDisplayTokensFor, type OnchainToken } from "./tokens";

export type InsightChain = "robinhood" | "base" | "ethereum";

/** Blocktronics' chain names, by chain id. Mainnets only: it has no testnets. */
export const INSIGHT_CHAINS: Readonly<Record<number, InsightChain>> = { 4663: "robinhood", 8453: "base", 1: "ethereum" };

export const INSIGHT_CHAIN_IDS: Readonly<Record<InsightChain, number>> = { robinhood: 4663, base: 8453, ethereum: 1 };

export const INSIGHT_CHAIN_LABEL: Readonly<Record<InsightChain, string>> = {
  robinhood: "Robinhood Chain",
  base: "Base",
  ethereum: "Ethereum",
};

export function isInsightChain(v: unknown): v is InsightChain {
  return v === "robinhood" || v === "base" || v === "ethereum";
}

export type GradeLetter = "A" | "B" | "C" | "D" | "E";

/** Only the fields Gloam shows. */
export type TokenInsight = {
  chain: InsightChain;
  /** The token contract, lowercase. */
  token: `0x${string}`;
  /**
   * Blocktronics' structure grade: a letter, A to E, and the composite of its
   * six pillars, 0 to 100 (50 is typical). Null when the token isn't graded yet.
   */
  grade: { letter: GradeLetter; score: number | null; provisional: boolean } | null;
  /** Wallets holding $5 or more of it, at the last settled day. */
  holders: number | null;
  /** Launch bundles: how many, and the share of supply they still hold. */
  bundles: { count: number | null; heldPct: number | null } | null;
  /** The token's page on Blocktronics. */
  url: string;
};

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export function isTokenAddress(v: unknown): v is `0x${string}` {
  return typeof v === "string" && ADDRESS_RE.test(v) && !/^0x0{40}$/.test(v);
}

/** The token's page on Blocktronics: blocktronics.xyz/t/<chain>/<address>. */
export function blocktronicsTokenUrl(chain: InsightChain, token: string): string {
  return `https://blocktronics.xyz/t/${chain}/${token.toLowerCase()}`;
}

/**
 * Left out of holder analytics by Blocktronics (wrapped natives, wrapped BTC),
 * so never asked about: the answer would only be "unsupported".
 */
const WRAPPED = new Set(["weth", "wbtc", "cbbtc", "wsteth", "steth"]);

function checkable(t: OnchainToken): boolean {
  return t.kind === "token" && !WRAPPED.has(t.symbol.toLowerCase()) && !/\bwrapped\b/i.test(t.name) && isTokenAddress(t.address);
}

/**
 * The token a check is offered for: one of Gloam's own tokens on a chain
 * Blocktronics covers, that is a token (not a stablecoin, a stock token or a
 * wrapped native). Null for anything else, so no call is made for it.
 */
export function checkableToken(chainId: number, address: string | null | undefined): OnchainToken | null {
  if (!address || !INSIGHT_CHAINS[chainId]) return null;
  const a = address.toLowerCase();
  return walletDisplayTokensFor(chainId).find((t) => t.address.toLowerCase() === a && checkable(t)) ?? null;
}

/** Every checkable Gloam token, Robinhood Chain first, then Base, then Ethereum. */
export function checkableTokens(): { chain: InsightChain; token: OnchainToken }[] {
  return [4663, 8453, 1].flatMap((id) =>
    walletDisplayTokensFor(id)
      .filter(checkable)
      .map((token) => ({ chain: INSIGHT_CHAINS[id]!, token })),
  );
}

const GRADE_LINE: Record<GradeLetter, string> = {
  A: "Well above typical on Blocktronics' structure checks: liquidity, holders, flows and launch.",
  B: "Above typical on Blocktronics' structure checks: liquidity, holders, flows and launch.",
  C: "About typical for the tokens Blocktronics tracks.",
  D: "Below typical on Blocktronics' structure checks, so exits can be harder.",
  E: "Well below typical on Blocktronics' structure checks, so exits can be hard.",
};

/** Bundles holding at least this share of supply get a word in the summary. */
const BUNDLE_NOTE_PCT = 5;

function pct(n: number): string {
  if (n > 0 && n < 0.1) return "under 0.1%";
  return `${n >= 10 ? Math.round(n) : Math.round(n * 10) / 10}%`;
}

/** Launch bundles as a figure: "1.1% of supply", "None found". Null when there is nothing to say. */
export function bundlesText(b: TokenInsight["bundles"]): string | null {
  if (!b) return null;
  if (b.count === 0) return "None found";
  if (b.heldPct == null) return null;
  return `${pct(b.heldPct)} of supply`;
}

/** The grade as a figure: "B, 72 of 100". */
export function gradeText(g: NonNullable<TokenInsight["grade"]>): string {
  return g.score == null ? g.letter : `${g.letter}, ${Math.round(g.score)} of 100`;
}

export function holdersText(n: number): string {
  return new Intl.NumberFormat("en-US").format(n);
}

/**
 * One plain sentence or two about what the numbers mean. Never calls a token
 * safe: a grade is about how a position can be held and exited, not a promise.
 */
export function insightLine(i: TokenInsight): string {
  const parts: string[] = [];
  if (i.grade) {
    parts.push(GRADE_LINE[i.grade.letter]);
    if (i.grade.provisional) parts.push("The grade is early and can change.");
  } else {
    parts.push("Blocktronics hasn't graded this token yet.");
  }
  const held = i.bundles?.heldPct;
  if (held != null && held >= BUNDLE_NOTE_PCT) parts.push(`Wallets that bought together at launch still hold ${pct(held)} of the supply.`);
  return parts.join(" ");
}

/** Something worth a card: a grade, a holder count or the bundles. */
export function hasInsight(i: TokenInsight | null | undefined): i is TokenInsight {
  return Boolean(i && (i.grade || i.holders != null || bundlesText(i.bundles)));
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const share = (v: unknown): number | null => (finite(v) && v >= 0 && v <= 100 ? v : null);

/**
 * A TokenInsight read back from JSON (the route's answer in the browser, a
 * cached copy on the server), field by field: anything off is dropped, and a
 * link only ever points at Blocktronics' own page for that token.
 */
export function parseInsight(raw: unknown): TokenInsight | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (!isInsightChain(r.chain) || !isTokenAddress(r.token)) return null;
  const chain = r.chain;
  const token = r.token.toLowerCase() as `0x${string}`;
  let grade: TokenInsight["grade"] = null;
  const g = r.grade as Record<string, unknown> | null | undefined;
  if (g && typeof g === "object" && typeof g.letter === "string" && /^[A-E]$/.test(g.letter)) {
    grade = { letter: g.letter as GradeLetter, score: share(g.score), provisional: g.provisional === true };
  }
  const holders = finite(r.holders) && r.holders >= 0 ? Math.round(r.holders) : null;
  let bundles: TokenInsight["bundles"] = null;
  const b = r.bundles as Record<string, unknown> | null | undefined;
  if (b && typeof b === "object") {
    const count = finite(b.count) && b.count >= 0 ? Math.round(b.count) : null;
    const heldPct = share(b.heldPct);
    if (count != null || heldPct != null) bundles = { count, heldPct };
  }
  const insight: TokenInsight = { chain, token, grade, holders, bundles, url: blocktronicsTokenUrl(chain, token) };
  return hasInsight(insight) ? insight : null;
}
