import { BASE_MAINNET_TOKENS, ELYSIUM_MAINNET_TOKENS, ETHEREUM_MAINNET_TOKENS, RH_MAINNET_SWAP_TOKENS, RH_MAINNET_TOKENS, type OnchainToken } from "./tokens";

/**
 * Tokens the markets feed does not price: on Robinhood Chain mainnet $GLOAM,
 * PONS, CASHCAT, AI, ORBIO and the swap tokens such as cbBTC, and on Base and
 * Ethereum BDX. The list is fixed, never the viewer's holdings, so asking for
 * it says nothing about what a wallet holds. Stocks come from the markets feed,
 * WETH from ETH's price and dollar stablecoins are $1. EURC is a stablecoin
 * here, so it stays off the list and unpriced: a euro is never $1.
 */
const LISTED: readonly (readonly [chainId: number, tokens: readonly OnchainToken[]])[] = [
  [4663, [...RH_MAINNET_TOKENS, ...RH_MAINNET_SWAP_TOKENS]],
  [8453, BASE_MAINNET_TOKENS],
  [1, ETHEREUM_MAINNET_TOKENS],
  [99901, ELYSIUM_MAINNET_TOKENS],
];

const marked = (t: OnchainToken) => Boolean(t.coingecko) && t.kind === "token" && t.id !== "weth";

function uniqueByAddress(tokens: readonly OnchainToken[]): OnchainToken[] {
  const seen = new Set<string>();
  return tokens.filter((t) => {
    const a = t.address.toLowerCase();
    if (seen.has(a)) return false;
    seen.add(a);
    return true;
  });
}

export const COINGECKO_MARKED: OnchainToken[] = uniqueByAddress(LISTED.flatMap(([, tokens]) => tokens.filter(marked)));

/** The same tokens by chain, for a lookup by address: BDX has one address on both Base and Ethereum, and is under each. */
export const MARKED_BY_CHAIN: { chainId: number; tokens: OnchainToken[] }[] = LISTED.map(([chainId, tokens]) => ({
  chainId,
  tokens: uniqueByAddress(tokens.filter(marked)),
}));

/**
 * Robinhood Chain stock tokens. The markets feed prices these; this is only what
 * the swap page and the transparency page fall back on when it has no live mark
 * or the multiplier can't be read. Fixed like the list above.
 */
export const STOCK_FALLBACK_MARKED: OnchainToken[] = uniqueByAddress(
  RH_MAINNET_SWAP_TOKENS.filter((t) => Boolean(t.coingecko) && t.kind === "stock")
);

/** Chains whose listed tokens include one priced here: Robinhood Chain, Base and Ethereum mainnet. */
export function hasCoingeckoMarks(chainId: number): boolean {
  return chainId === 4663 || chainId === 8453 || chainId === 1 || (chainId === 99901 && ELYSIUM_MAINNET_TOKENS.length > 0);
}
