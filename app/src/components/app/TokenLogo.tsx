"use client";

import { useState } from "react";

/**
 * Ticker/token logo. Renders a real image from /brand/logos/<id>.png when one is
 * present, and otherwise a quiet monochrome monogram tile. The tile shade is
 * picked deterministically from the symbol (three steps of ink over the panel),
 * so each market keeps a stable identity in light and dark without colour.
 */
const TILE_SHADES = [
  "color-mix(in srgb, var(--ink) 7%, var(--panel))",
  "color-mix(in srgb, var(--ink) 12%, var(--panel))",
  "color-mix(in srgb, var(--ink) 18%, var(--panel))",
];

function tileShade(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return TILE_SHADES[h % TILE_SHADES.length];
}

/**
 * Ids with a real brand mark shipped in /public/brand/logos as `<id>.png`.
 * Anything not in the set (or SPECIAL) falls back to a monogram, so no 404.
 */
const PNG_LOGO_IDS = new Set([
  // onchain-tradeable
  "tsla", "amzn", "pltr", "nflx", "amd",
  // watchlist (Aumo app-icon set + FMP)
  "hood", "aapl", "nvda", "msft", "googl", "meta", "coin",
  "goog", "avgo", "orcl", "crm", "adbe", "intc", "qcom", "mu", "ibm", "csco",
  "dis", "uber", "abnb", "shop", "pypl", "sbux", "nke", "mcd", "ko", "wmt",
  "cost", "jpm", "v", "ma", "mstr", "gme", "rblx", "rddt", "snap", "f",
  "rivn", "baba", "spot",
  // Robinhood Chain swap list that had no file yet (FMP company marks, CoinGecko token marks)
  "spy", "spcx", "crcl", "amc", "hims", "tsm", "gld",
  "usde", "u", "cbbtc", "pons", "cashcat", "virtual",
  // stablecoins
  "usdg", "usdce", "usdt0",
  // networks
  "robinhood",
  // gas coin
  "eth",
]);

/** Round marks (a full disc): shown as a circle with no plate, so no white corners. */
const DISC_LOGO_IDS = new Set(["usdg", "usdce", "usdc", "eurc", "usdt", "pyusd", "eth", "weth", "avgo", "mstr", "sbux", "usde", "u", "cbbtc", "bdx", "bnb"]);

/**
 * White marks on a clear ground. On the usual white plate they vanish and leave
 * an empty tile, so these sit on an ink plate instead.
 */
const INK_PLATE_LOGO_IDS = new Set(["dis", "hims", "ibm", "nke", "rblx", "uber", "v"]);

/**
 * Network marks drawn as full-bleed tiles (lib/networks families). They fill the
 * tile edge to edge, so they get no plate and no border, only a hairline drawn
 * over the image so a dark tile keeps its edge on a dark panel.
 */
const FULL_TILE_LOGO_IDS = new Set(["robinhood", "tempo", "base", "ethereum", "elysium"]);

/**
 * Network tiles by chain family. BNB Chain's family id is also its gas coin's
 * token id ("bnb"), so a network picker asks for the tile with `network`, and
 * the coin keeps its round mark everywhere else.
 */
const NETWORK_TILES: Record<string, string> = {
  robinhood: "/brand/networks/robinhood.png",
  tempo: "/brand/networks/tempo.svg",
  base: "/brand/networks/base.svg",
  ethereum: "/brand/networks/ethereum.svg",
  elysium: "/brand/networks/elysium.png",
  bnb: "/brand/networks/bnb.png",
};

const SPECIAL_LOGOS: Record<string, string> = {
  // Networks: full-bleed tiles in /brand/networks, edge to edge, no plate
  tempo: "/brand/networks/tempo.svg",
  robinhood: "/brand/networks/robinhood.png",
  base: "/brand/networks/base.svg",
  ethereum: "/brand/networks/ethereum.svg",
  elysium: "/brand/networks/elysium.png",
  // HYPE, Elysium's gas coin
  hype: "/brand/tokens/hype.png",
  // BNB, BNB Chain's gas coin (the mark the bridge list already uses)
  bnb: "/brand/tokens/bnb.png",
  kntq: "/brand/tokens/kntq.png",
  // Circle's USDC, Tether's USDT and PayPal's PYUSD, the marks the bridge list uses
  usdc: "/brand/tokens/usdc.png",
  // Circle's EURC, on Base and Ethereum (from the Trust Wallet assets list)
  eurc: "/brand/tokens/eurc.png",
  usdt: "/brand/tokens/usdt.png",
  pyusd: "/brand/tokens/pyusd.png",
  // Beldex's BDX on Base and Ethereum: its round mark, from CoinGecko's listing (coins/images/5111)
  bdx: "/brand/tokens/bdx.png",
  // San Verano's $GRIFT: the logo its token contract points at (logo(), on IPFS)
  grift: "/brand/tokens/grift.png",
  // Artificial Inu: the image its token contract points at (tokenURI(), then image_hash, on IPFS)
  ai: "/brand/tokens/ai.png",
  // Orbio.so: the logo its token contract points at (logo(), on IPFS)
  orbio: "/brand/tokens/orbio.png",
  ousd: "/brand/logos/ousd.svg",
  pathusd: "/brand/logos/pathusd.svg",
  alphausd: "/brand/logos/alphausd.svg",
  betausd: "/brand/logos/betausd.svg",
  thetausd: "/brand/logos/thetausd.svg",
  // $GLOAM: the Gloam mark
  gloam: "/brand/kit/gloam-avatar-ink.png",
  // WETH is ETH in the vault: the same mark
  weth: "/brand/logos/eth.png",
};

/** The logo file for a token id, or undefined when it has none (a monogram shows instead). */
export function tokenLogoPath(id: string): string | undefined {
  return resolveLogo(id);
}

function resolveLogo(id: string): string | undefined {
  const key = id.toLowerCase();
  if (SPECIAL_LOGOS[key]) return SPECIAL_LOGOS[key];
  if (PNG_LOGO_IDS.has(key)) return `/brand/logos/${key}.png`;
  return undefined;
}

export function TokenLogo({
  id,
  symbol,
  size = 34,
  logoSrc,
  className = "",
  network = false,
}: {
  id: string;
  symbol: string;
  size?: number;
  /** Real logo path. When omitted, a monogram tile is shown (no 404 request). */
  logoSrc?: string;
  /** A network (chain family), drawn as its full tile. */
  network?: boolean;
  className?: string;
}) {
  const [broken, setBroken] = useState(false);
  const ticker = symbol.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  const label = ticker.slice(0, 4);
  const bg = tileShade(symbol || id);
  // Scale the ticker to fit the tile: shorter tickers read larger.
  const fontRatio =
    label.length <= 2 ? 0.38 : label.length === 3 ? 0.3 : 0.25;
  const tile = network ? NETWORK_TILES[id.toLowerCase()] : undefined;
  const src = logoSrc ?? tile ?? resolveLogo(id);

  if (src && !broken && !tile && DISC_LOGO_IDS.has(id.toLowerCase())) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={src}
        alt={`${symbol} logo`}
        width={size}
        height={size}
        onError={() => setBroken(true)}
        className={`shrink-0 rounded-full object-cover ${className}`}
        style={{ width: size, height: size }}
      />
    );
  }

  if (src && !broken && (tile || FULL_TILE_LOGO_IDS.has(id.toLowerCase()))) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={src}
        alt={`${symbol} logo`}
        width={size}
        height={size}
        onError={() => setBroken(true)}
        className={`shrink-0 rounded-[22%] object-cover outline outline-1 -outline-offset-1 outline-black/5 dark:outline-white/10 ${className}`}
        style={{ width: size, height: size }}
      />
    );
  }

  if (src && !broken) {
    // Brand marks keep a white plate (some ship transparent with dark ink) or an
    // ink one (INK_PLATE_LOGO_IDS), the one allowed literal colour: it is part of
    // the logo, not the theme.
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={src}
        alt={`${symbol} logo`}
        width={size}
        height={size}
        onError={() => setBroken(true)}
        className={`shrink-0 rounded-[22%] border border-line object-cover ${
          INK_PLATE_LOGO_IDS.has(id.toLowerCase()) ? "bg-[#0b0c0e]" : "bg-white"
        } ${className}`}
        style={{ width: size, height: size }}
      />
    );
  }

  return (
    <span
      aria-hidden
      className={`inline-flex shrink-0 select-none items-center justify-center rounded-[22%] border border-line font-medium text-foreground ${className}`}
      style={{
        width: size,
        height: size,
        background: bg,
        fontSize: Math.round(size * fontRatio),
        letterSpacing: "-0.02em",
      }}
      title={symbol}
    >
      {label}
    </span>
  );
}
