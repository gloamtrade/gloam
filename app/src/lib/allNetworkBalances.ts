/**
 * One private balance across every network, for the home screen.
 *
 * The app shows one network at a time, so money that landed on another one (a
 * payment to your Gloam address on Ethereum while Robinhood Chain is shown)
 * stayed out of sight until you switched. This adds up the signed-in account's
 * private notes on every live network, by the same rules each network's own
 * view uses: only notes this account holds (loadWalletNotes, nothing while
 * signed out, never another account's), only spendable ones (sumByAsset skips
 * claimed payments the vault hasn't shown, notes whose move or cash out is on
 * its way, and anything spent or recovered), each payment once (mergeNotes, by
 * commitment).
 *
 * It reads only this browser's notes. Prices come from the feeds the app
 * already reads; nothing about the balance leaves the browser. A token with no
 * dollar price is listed by amount and left out of the total, and said so.
 */
import { networkName, type GloamNetwork, type NetworkKey } from "./networks";
import { isNativeAsset, loadWalletNotes, mergeNotes, sumByAsset, type LocalNote } from "./shield";
import { isDollarStable, knownTokens, nativeTokenFor } from "./tokens";

export type NetworkHolding = {
  networkKey: NetworkKey;
  /** The network's name, as the app shows it ("Ethereum"). */
  network: string;
  family: GloamNetwork["family"];
  chainId: number;
  /** The asset as notes name it: the zero address for the gas coin. */
  asset: string;
  symbol: string;
  decimals: number;
  /** The TokenLogo id, when the app knows the token. */
  tokenId: string | null;
  /** Raw units. */
  amount: bigint;
};

/**
 * Every live network's private notes for `wallet`, summed by network and asset.
 * Empty while signed out. Pass mainnets or testnets, never both: test money is
 * never added to real money (useAllNetworkHoldings passes the shown network's kind).
 */
export function holdingsAcrossNetworks(
  wallet: string | null | undefined,
  networks: readonly GloamNetwork[],
  notesOf: (net: GloamNetwork) => LocalNote[] = (net) => loadWalletNotes(wallet, net)
): NetworkHolding[] {
  if (!wallet) return [];
  const out: NetworkHolding[] = [];
  for (const net of networks) {
    if (!net.pool || net.status !== "live") continue;
    const byAsset = sumByAsset(mergeNotes(notesOf(net), []));
    const tokens = knownTokens(net.chainId);
    const rows: NetworkHolding[] = [];
    byAsset.forEach((amount, asset) => {
      if (amount <= 0n) return;
      if (isNativeAsset(asset)) {
        const native = nativeTokenFor(net.chainId);
        rows.push({ ...base(net), asset, symbol: net.primaryAsset.symbol, decimals: 18, tokenId: native.id ?? null, amount });
        return;
      }
      const t = tokens.find((x) => x.address.toLowerCase() === asset.toLowerCase());
      rows.push({
        ...base(net),
        asset,
        symbol: t?.symbol ?? `${asset.slice(0, 6)}…${asset.slice(-4)}`,
        decimals: t?.decimals ?? 18,
        tokenId: t?.id ?? null,
        amount,
      });
    });
    // the gas coin first, then by symbol, as each network's own view lists them
    rows.sort((a, b) => (isNativeAsset(a.asset) ? -1 : isNativeAsset(b.asset) ? 1 : a.symbol.localeCompare(b.symbol)));
    out.push(...rows);
  }
  return out;
}

function base(net: GloamNetwork): Pick<NetworkHolding, "networkKey" | "network" | "family" | "chainId"> {
  return { networkKey: net.key, network: networkName(net), family: net.family, chainId: net.chainId };
}

/** The prices the app already reads (lib/markets, the CoinGecko marks), never anything about a balance. */
export type CrossNetworkPrices = {
  ethUsd: number | null;
  bnbUsd: number | null;
  hypeUsd: number | null;
  /** CoinGecko marks by lowercase token address ($GLOAM, BDX, the swap tokens). */
  marks: ReadonlyMap<string, number>;
};

/**
 * What one unit of a holding is worth in dollars, or null when nothing prices it
 * here: the gas coin by its own feed (ETH, BNB, HYPE), a dollar stablecoin $1,
 * WETH at ETH's price, a CoinGecko-marked token at its mark. A stock token is
 * left unpriced: its price needs its live multiplier, which only its own
 * network's view reads.
 */
export function unitUsdOf(h: Pick<NetworkHolding, "asset" | "family" | "chainId">, p: CrossNetworkPrices): number | null {
  if (isNativeAsset(h.asset)) {
    if (h.family === "tempo") return 1;
    if (h.family === "bnb") return p.bnbUsd;
    if (h.family === "elysium") return p.hypeUsd;
    return p.ethUsd;
  }
  const t = knownTokens(h.chainId).find((x) => x.address.toLowerCase() === h.asset.toLowerCase());
  if (t && isDollarStable(t)) return 1;
  if (t?.id === "weth") return p.ethUsd;
  return p.marks.get(h.asset.toLowerCase()) ?? null;
}

export type PricedHolding = NetworkHolding & { usd: number | null };

/** The holdings with their dollar values, the total of the priced ones, and the ones left out. */
export function priceHoldings(holdings: readonly NetworkHolding[], p: CrossNetworkPrices): {
  rows: PricedHolding[];
  totalUsd: number;
  unpriced: PricedHolding[];
  networks: number;
} {
  const rows = holdings.map((h) => {
    const unit = unitUsdOf(h, p);
    return { ...h, usd: unit == null ? null : (Number(h.amount) / 10 ** h.decimals) * unit };
  });
  return {
    rows,
    totalUsd: rows.reduce((s, r) => s + (r.usd ?? 0), 0),
    unpriced: rows.filter((r) => r.usd == null),
    networks: new Set(rows.map((r) => r.networkKey)).size,
  };
}

/** Whether the card is worth showing: some private money sits on a network other than the one shown. */
export function hasMoneyElsewhere(holdings: readonly NetworkHolding[], shown: NetworkKey): boolean {
  return holdings.some((h) => h.networkKey !== shown);
}
