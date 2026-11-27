import { displayAmountNumber } from "./amountShort";
import { compareHoldings } from "./vaultHub";

/**
 * A token amount in whole units on screen: two places, cut down ("8.03",
 * "1,204.00", "<0.01"), through lib/amountShort. Zero or less reads "0.00".
 */
export function tidyAmount(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return displayAmountNumber(0);
  return displayAmountNumber(n);
}

/**
 * Dollars where every asset has a price, and the amounts of those that don't
 * next to them ("$100", "+ 1,000.00 GLOAM"): never a silent $0 for an asset with
 * no price, and no "$0" in front when nothing held is priced.
 */
function moneyParts(usd: number, unpriced: readonly string[], formatUsd: (n: number) => string): string[] {
  if (!unpriced.length) return [formatUsd(usd)];
  return [
    ...(usd > 0 ? [formatUsd(usd)] : []),
    ...unpriced.slice(0, 2),
    ...(unpriced.length > 2 ? [`${unpriced.length - 2} more`] : []),
  ];
}

/**
 * The Portfolio's private balance headline, worked out apart from the page so
 * it can be checked. Dollars only ("$95"): an asset with no dollar price is
 * named in the chips under the number and in "Not in the total" below, never
 * tacked onto the big number ("$93 + 7.86 GLOAM + 7.99 PONS" showed while
 * $GLOAM's price loaded, then vanished). Null while a price it needs is still
 * loading, so the page shows a placeholder instead of a figure that jumps.
 * With nothing priced at all: the one amount, or "2 assets", never "$0".
 */
export function privateHeadline(args: {
  showUsd: boolean;
  /** The priced part, in dollars. */
  sealedUsd: number;
  /** "1,000.00 GLOAM" for each asset held with no dollar price, largest first, each through tidyAmount. */
  unpriced: string[];
  /** A held asset's price is still on its way. */
  pending?: boolean;
  /** The vault as amounts ("500.00 USDC", "2 assets"), shown when dollars are off. */
  vaultValue: string;
  formatUsd: (n: number) => string;
}): string | null {
  const { showUsd, sealedUsd, unpriced, pending, vaultValue, formatUsd } = args;
  if (!showUsd) return vaultValue;
  if (pending) return null;
  if (sealedUsd > 0 || unpriced.length === 0) return formatUsd(sealedUsd);
  return unpriced.length === 1 ? unpriced[0] : vaultValue;
}

/** One balance in the Portfolio's wallet card, as the order and the total read it. */
export type WalletHolding = {
  symbol: string;
  /** Whole units: 0.0339 for 0.0339 ETH. */
  amount: number;
  /** Its value in dollars, or null where nothing prices it (EURC, ETH while the feed is down). */
  usd: number | null;
  /** A dollar stablecoin. */
  dollar: boolean;
  /** "20.00 EURC": how the total names it when it has no price. */
  text: string;
  /** Its price is still on its way (ETH or a stock before the first markets read). */
  pending?: boolean;
};

/**
 * The wallet card's order: what is held first, in the Vault's order (dollar
 * stablecoins, then the larger value, lib/vaultHub compareHoldings), then the
 * zero balances, which the card folds away so it leads with money. A holding
 * with no dollar price is sized by its amount.
 */
export function splitWalletRows<T extends WalletHolding>(rows: readonly T[]): { held: T[]; empty: T[] } {
  const key = (r: T) => ({ dollar: r.dollar, amount: r.usd ?? r.amount, symbol: r.symbol });
  const sorted = [...rows].sort((a, b) => compareHoldings(key(a), key(b)));
  return { held: sorted.filter((r) => r.amount > 0), empty: sorted.filter((r) => !(r.amount > 0)) };
}

/**
 * A wallet row's second line: what the balance is worth, $0.00 for none.
 * Never the price of one unit (a zero USDG row read "$1.00" beside "USDC 60,
 * $60"). Nothing with dollars off, or where nothing prices the asset.
 */
export function walletRowValue(
  row: Pick<WalletHolding, "usd">,
  showUsd: boolean,
  formatUsd: (n: number) => string
): string | null {
  return showUsd && row.usd != null ? formatUsd(row.usd) : null;
}

export type WalletTotal =
  /** Dollars are off in Settings: the rows carry the amounts. */
  | { state: "off" }
  /** A balance or a price is still being read, so any figure would be wrong. */
  | { state: "loading" }
  /** "$140", and "+ 20.00 EURC" for what has no dollar price (or null). */
  | { state: "ready"; figure: string; extra: string | null };

/**
 * The wallet card's total: the dollars of what the wallet holds, and what has
 * no dollar price named beside it by amount, never added as $0. Nothing shows
 * while a balance or a price it needs is still loading.
 */
export function walletTotal(args: {
  showUsd: boolean;
  /** A wallet balance is still being read. */
  loading: boolean;
  rows: readonly WalletHolding[];
  formatUsd: (n: number) => string;
}): WalletTotal {
  if (!args.showUsd) return { state: "off" };
  const { held } = splitWalletRows(args.rows);
  if (args.loading || held.some((r) => r.pending)) return { state: "loading" };
  const usd = held.reduce((s, r) => s + (r.usd ?? 0), 0);
  const unpriced = held.filter((r) => r.usd == null).map((r) => r.text);
  const [figure, ...rest] = moneyParts(usd, unpriced, args.formatUsd);
  return { state: "ready", figure, extra: rest.length ? `+ ${rest.join(" + ")}` : null };
}
