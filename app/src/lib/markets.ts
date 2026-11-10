export type MarketKind = "stock" | "native";

export type MarketSource = "live" | "static";

export type MarketDef = {
  id: string;
  symbol: string;
  name: string;
  kind: MarketKind;
  yahoo?: string;
  /** Only used for ETH USD */
  coingecko?: string;
  /** Robinhood testnet ERC-20 */
  address?: `0x${string}`;
  fallbackMark: number;
  privateReady: boolean;
};

export type LiveQuote = {
  mark: number;
  change24h: number;
  volume: string;
  source: MarketSource;
  updatedAt: number;
  spark?: number[];
};

export type Market = MarketDef & LiveQuote;

/**
 * Robinhood-sensible catalog only:
 * - Faucet stock tokens (onchain testnet)
 * - Equity watchlist (live marks, not other-chain memes)
 * - ETH for gas / USD conversion
 */
export const MARKET_DEFS: MarketDef[] = [
  // Onchain faucet tokens (RH testnet: can be held in the vault)
  {
    id: "tsla",
    symbol: "TSLA",
    name: "Tesla",
    kind: "stock",
    yahoo: "TSLA",
    address: "0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E",
    fallbackMark: 250,
    privateReady: true,
  },
  {
    id: "amzn",
    symbol: "AMZN",
    name: "Amazon",
    kind: "stock",
    yahoo: "AMZN",
    address: "0x5884aD2f920c162CFBbACc88C9C51AA75eC09E02",
    fallbackMark: 190,
    privateReady: true,
  },
  {
    id: "pltr",
    symbol: "PLTR",
    name: "Palantir",
    kind: "stock",
    yahoo: "PLTR",
    address: "0x1FBE1a0e43594b3455993B5dE5Fd0A7A266298d0",
    fallbackMark: 80,
    privateReady: true,
  },
  {
    id: "nflx",
    symbol: "NFLX",
    name: "Netflix",
    kind: "stock",
    yahoo: "NFLX",
    address: "0x3b8262A63d25f0477c4DDE23F83cfe22Cb768C93",
    fallbackMark: 900,
    privateReady: true,
  },
  {
    id: "amd",
    symbol: "AMD",
    name: "AMD",
    kind: "stock",
    yahoo: "AMD",
    address: "0x71178BAc73cBeb415514eB542a8995b82669778d",
    fallbackMark: 120,
    privateReady: true,
  },
  // Equity watchlist (marks only, not on RH testnet yet)
  {
    id: "hood",
    symbol: "HOOD",
    name: "Robinhood",
    kind: "stock",
    yahoo: "HOOD",
    fallbackMark: 100,
    privateReady: false,
  },
  {
    id: "aapl",
    symbol: "AAPL",
    name: "Apple",
    kind: "stock",
    yahoo: "AAPL",
    fallbackMark: 210,
    privateReady: false,
  },
  {
    id: "nvda",
    symbol: "NVDA",
    name: "NVIDIA",
    kind: "stock",
    yahoo: "NVDA",
    fallbackMark: 130,
    privateReady: false,
  },
  {
    id: "coin",
    symbol: "COIN",
    name: "Coinbase",
    kind: "stock",
    yahoo: "COIN",
    fallbackMark: 250,
    privateReady: false,
  },
  {
    id: "msft",
    symbol: "MSFT",
    name: "Microsoft",
    kind: "stock",
    yahoo: "MSFT",
    fallbackMark: 420,
    privateReady: false,
  },
  {
    id: "googl",
    symbol: "GOOGL",
    name: "Alphabet",
    kind: "stock",
    yahoo: "GOOGL",
    fallbackMark: 175,
    privateReady: false,
  },
  {
    id: "meta",
    symbol: "META",
    name: "Meta",
    kind: "stock",
    yahoo: "META",
    fallbackMark: 580,
    privateReady: false,
  },
  // Extended equity watchlist (live marks via Yahoo, view-only for now)
  { id: "goog", symbol: "GOOG", name: "Alphabet", kind: "stock", yahoo: "GOOG", fallbackMark: 175, privateReady: false },
  { id: "avgo", symbol: "AVGO", name: "Broadcom", kind: "stock", yahoo: "AVGO", fallbackMark: 170, privateReady: false },
  { id: "orcl", symbol: "ORCL", name: "Oracle", kind: "stock", yahoo: "ORCL", fallbackMark: 175, privateReady: false },
  { id: "crm", symbol: "CRM", name: "Salesforce", kind: "stock", yahoo: "CRM", fallbackMark: 260, privateReady: false },
  { id: "adbe", symbol: "ADBE", name: "Adobe", kind: "stock", yahoo: "ADBE", fallbackMark: 520, privateReady: false },
  { id: "intc", symbol: "INTC", name: "Intel", kind: "stock", yahoo: "INTC", fallbackMark: 24, privateReady: false },
  { id: "qcom", symbol: "QCOM", name: "Qualcomm", kind: "stock", yahoo: "QCOM", fallbackMark: 170, privateReady: false },
  { id: "mu", symbol: "MU", name: "Micron", kind: "stock", yahoo: "MU", fallbackMark: 110, privateReady: false },
  { id: "ibm", symbol: "IBM", name: "IBM", kind: "stock", yahoo: "IBM", fallbackMark: 230, privateReady: false },
  { id: "csco", symbol: "CSCO", name: "Cisco", kind: "stock", yahoo: "CSCO", fallbackMark: 50, privateReady: false },
  { id: "dis", symbol: "DIS", name: "Disney", kind: "stock", yahoo: "DIS", fallbackMark: 95, privateReady: false },
  { id: "uber", symbol: "UBER", name: "Uber", kind: "stock", yahoo: "UBER", fallbackMark: 75, privateReady: false },
  { id: "abnb", symbol: "ABNB", name: "Airbnb", kind: "stock", yahoo: "ABNB", fallbackMark: 130, privateReady: false },
  { id: "shop", symbol: "SHOP", name: "Shopify", kind: "stock", yahoo: "SHOP", fallbackMark: 90, privateReady: false },
  { id: "pypl", symbol: "PYPL", name: "PayPal", kind: "stock", yahoo: "PYPL", fallbackMark: 75, privateReady: false },
  { id: "sbux", symbol: "SBUX", name: "Starbucks", kind: "stock", yahoo: "SBUX", fallbackMark: 95, privateReady: false },
  { id: "nke", symbol: "NKE", name: "Nike", kind: "stock", yahoo: "NKE", fallbackMark: 75, privateReady: false },
  { id: "mcd", symbol: "MCD", name: "McDonald's", kind: "stock", yahoo: "MCD", fallbackMark: 300, privateReady: false },
  { id: "ko", symbol: "KO", name: "Coca-Cola", kind: "stock", yahoo: "KO", fallbackMark: 70, privateReady: false },
  { id: "wmt", symbol: "WMT", name: "Walmart", kind: "stock", yahoo: "WMT", fallbackMark: 95, privateReady: false },
  { id: "cost", symbol: "COST", name: "Costco", kind: "stock", yahoo: "COST", fallbackMark: 900, privateReady: false },
  { id: "jpm", symbol: "JPM", name: "JPMorgan", kind: "stock", yahoo: "JPM", fallbackMark: 290, privateReady: false },
  { id: "v", symbol: "V", name: "Visa", kind: "stock", yahoo: "V", fallbackMark: 350, privateReady: false },
  { id: "ma", symbol: "MA", name: "Mastercard", kind: "stock", yahoo: "MA", fallbackMark: 560, privateReady: false },
  { id: "mstr", symbol: "MSTR", name: "Strategy", kind: "stock", yahoo: "MSTR", fallbackMark: 350, privateReady: false },
  { id: "gme", symbol: "GME", name: "GameStop", kind: "stock", yahoo: "GME", fallbackMark: 25, privateReady: false },
  { id: "rblx", symbol: "RBLX", name: "Roblox", kind: "stock", yahoo: "RBLX", fallbackMark: 55, privateReady: false },
  { id: "rddt", symbol: "RDDT", name: "Reddit", kind: "stock", yahoo: "RDDT", fallbackMark: 130, privateReady: false },
  { id: "snap", symbol: "SNAP", name: "Snap", kind: "stock", yahoo: "SNAP", fallbackMark: 9, privateReady: false },
  { id: "f", symbol: "F", name: "Ford", kind: "stock", yahoo: "F", fallbackMark: 11, privateReady: false },
  { id: "rivn", symbol: "RIVN", name: "Rivian", kind: "stock", yahoo: "RIVN", fallbackMark: 14, privateReady: false },
  { id: "baba", symbol: "BABA", name: "Alibaba", kind: "stock", yahoo: "BABA", fallbackMark: 120, privateReady: false },
  { id: "spot", symbol: "SPOT", name: "Spotify", kind: "stock", yahoo: "SPOT", fallbackMark: 600, privateReady: false },
  // Native gas
  {
    id: "eth",
    symbol: "ETH",
    name: "Ether",
    kind: "native",
    coingecko: "ethereum",
    fallbackMark: 3500,
    privateReady: false,
  },
];

export const MARKETS: Market[] = MARKET_DEFS.map((d) => ({
  ...d,
  mark: d.fallbackMark,
  change24h: 0,
  volume: ", ",
  source: "static" as const,
  updatedAt: 0,
  spark: [],
}));

export function formatMark(mark: number) {
  if (mark < 0.01) {
    return mark.toLocaleString(undefined, {
      maximumSignificantDigits: 4,
    });
  }
  if (mark < 1) {
    return mark.toLocaleString(undefined, {
      minimumFractionDigits: 4,
      maximumFractionDigits: 6,
    });
  }
  return mark.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function formatUsd(n: number) {
  if (!Number.isFinite(n)) return ", ";
  if (n < 0.01 && n > 0) return "<$0.01";
  return n.toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: n < 10 ? 2 : 0,
  });
}

export function formatTokenAmount(raw: bigint, decimals = 18, maxDigits = 4) {
  const n = Number(raw) / 10 ** decimals;
  if (!Number.isFinite(n) || n === 0) return "0";
  if (n < 0.0001) return "<0.0001";
  if (n >= 1_000_000) return compactAmount(n);
  return n.toLocaleString(undefined, { maximumFractionDigits: maxDigits });
}

/**
 * Compact a large magnitude so it never overflows a card. Precise commas below a
 * million, then K/M/B suffixes, and a clean "1T+" cap above a trillion. Nothing
 * real reaches a trillion, so the cap only ever catches testnet faucet balances
 * (which come back absurdly large) — we show those as "1T+" rather than an ugly
 * scientific string. Always short.
 */
function compactMagnitude(n: number): string {
  const abs = Math.abs(n);
  if (abs < 1_000_000) {
    return n.toLocaleString(undefined, {
      maximumFractionDigits: abs < 1 ? 4 : abs < 100 ? 2 : 0,
    });
  }
  if (abs >= 1e12) return `${n < 0 ? "-" : ""}1T+`;
  const units: [number, string][] = [
    [1e9, "B"],
    [1e6, "M"],
  ];
  for (const [d, suffix] of units) {
    if (abs >= d) {
      const v = n / d;
      const frac = Math.abs(v) < 10 ? 2 : Math.abs(v) < 100 ? 1 : 0;
      return `${v.toLocaleString(undefined, { maximumFractionDigits: frac })}${suffix}`;
    }
  }
  return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

/** Compact bare amount (no currency), e.g. 4.24e30 or 1.2M. */
export function compactAmount(n: number): string {
  if (!Number.isFinite(n)) return "0";
  if (n > 0 && n < 0.0001) return "<0.0001";
  return compactMagnitude(n);
}

/** Compact USD that never overflows: precise under $1M, then $1.2M / $1.06e34. */
export function formatUsdCompact(n: number): string {
  if (!Number.isFinite(n)) return "$0";
  if (n > 0 && n < 0.01) return "<$0.01";
  if (Math.abs(n) < 1_000_000) return formatUsd(n);
  return `$${compactMagnitude(n)}`;
}
