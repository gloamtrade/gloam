"use client";

/**
 * Portfolio: the private balance on every network in one place, so money that
 * landed on another network (a payment to your Gloam address on Ethereum while
 * Robinhood Chain is shown) is in sight without switching. One total in dollars,
 * then each network's amounts; a row switches the app to that network, where
 * its own view, actions and history are. Shown only when some private money
 * sits on a network other than the one shown: otherwise the hero above already
 * says it all.
 *
 * Reads this browser's notes for the signed-in account only
 * (lib/allNetworkBalances); prices come from the feeds the app already reads.
 * The eye hides every amount here too.
 */
import { formatUnits } from "viem";
import { useAllNetworkHoldings } from "@/hooks/useAllNetworkHoldings";
import { useCoingeckoMarks } from "@/hooks/useCoingeckoMarks";
import { useLiveMarkets } from "@/hooks/useLiveMarkets";
import { useTradingSettings } from "@/hooks/useTradingSettings";
import { hasMoneyElsewhere, priceHoldings, type PricedHolding } from "@/lib/allNetworkBalances";
import { useAppAccount } from "@/lib/demo";
import { useHideAmounts } from "@/lib/hideAmounts";
import { formatUsdCompact } from "@/lib/markets";
import type { NetworkKey } from "@/lib/networks";
import { tidyAmount } from "@/lib/portfolioValue";
import { SealDots } from "@/components/ui/SealDots";
import { useNetwork } from "./NetworkProvider";
import { TokenLogo } from "./TokenLogo";

export function AllNetworksCard() {
  const { address } = useAppAccount();
  const { network, setNetworkKey } = useNetwork();
  const holdings = useAllNetworkHoldings(address);
  const elsewhere = hasMoneyElsewhere(holdings, network.key);
  const { data: market } = useLiveMarkets();
  const { marks } = useCoingeckoMarks(elsewhere);
  const { settings } = useTradingSettings();
  const [hidden] = useHideAmounts();
  if (!address || !elsewhere) return null;

  const priced = priceHoldings(holdings, {
    ethUsd: market?.ethUsd ?? null,
    bnbUsd: market?.bnbUsd ?? null,
    hypeUsd: market?.hypeUsd ?? null,
    marks,
  });
  // one group per network, in the app's own order
  const groups: { key: NetworkKey; label: string; rows: PricedHolding[] }[] = [];
  for (const r of priced.rows) {
    const g = groups.find((x) => x.key === r.networkKey);
    if (g) g.rows.push(r);
    else groups.push({ key: r.networkKey, label: r.network, rows: [r] });
  }
  const amountOf = (r: PricedHolding) => `${tidyAmount(Number(formatUnits(r.amount, r.decimals)))} ${r.symbol}`;
  const unpricedCount = priced.unpriced.length;
  const showUsd = settings.showUsd;

  return (
    <section className="gl-card overflow-hidden" aria-labelledby="all-networks-title">
      <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-5 pb-3 pt-5 sm:px-6">
        <h2 id="all-networks-title" className="text-[14px] text-soft">
          Private balance on every network
        </h2>
        <p className="tnum text-[15px] text-foreground">
          {hidden ? (
            <SealDots n={5} label="Hidden" />
          ) : showUsd ? (
            <>
              {formatUsdCompact(priced.totalUsd)}
              {unpricedCount > 0 && (
                <span className="text-mute">
                  , plus {unpricedCount} {unpricedCount === 1 ? "token" : "tokens"} without a price
                </span>
              )}
            </>
          ) : (
            <span className="text-mute">
              {priced.networks} {priced.networks === 1 ? "network" : "networks"}
            </span>
          )}
        </p>
      </header>
      <ul className="border-t border-line">
        {groups.map((g) => {
          const here = g.key === network.key;
          return (
            <li key={g.key} className="border-b border-line last:border-0">
              <button
                type="button"
                onClick={() => {
                  if (!here) setNetworkKey(g.key);
                }}
                aria-current={here ? "true" : undefined}
                className="flex min-h-14 w-full items-center gap-3 px-5 py-2.5 text-left transition-colors hover:bg-surface/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground/20 sm:px-6"
              >
                <span className="w-28 shrink-0 text-[14px] text-foreground sm:w-36">
                  {g.label}
                  {here && <span className="block text-[12px] text-mute">Shown now</span>}
                </span>
                <span className="flex min-w-0 flex-1 flex-wrap items-center justify-end gap-x-4 gap-y-1.5">
                  {g.rows.map((r) => (
                    <span key={r.asset} className="tnum inline-flex items-center gap-2 text-[13.5px]">
                      <TokenLogo id={r.tokenId ?? r.symbol.toLowerCase()} symbol={r.symbol} size={20} />
                      {hidden ? (
                        <SealDots n={4} />
                      ) : (
                        <>
                          <span className="text-foreground">{amountOf(r)}</span>
                          {showUsd && r.usd != null && <span className="text-mute">{formatUsdCompact(r.usd)}</span>}
                        </>
                      )}
                    </span>
                  ))}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
