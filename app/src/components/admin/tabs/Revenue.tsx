"use client";

import { shortAddress } from "@/lib/chain";
import { getNetwork } from "@/lib/networks";
import type { NetworkMetrics, Windowed } from "@/lib/onchainMetrics";
import { ArrowUpRight } from "@/components/ui/ArrowUpRight";
import { MetricCard } from "../cards";
import { DayBars, StemChart } from "../charts";
import { adminName, flowPricing, notInDollars, weekChange } from "../data";
import { fmtDay, fmtEth, fmtUsd, fmtUsdBig, fmtUsdShort, n } from "../format";
import { dayPoints } from "../series";
import { sideRevenueDays, type Side } from "../side";
import { DataTable, Loading, Note, Panel, StatStrip } from "../ui";

export function RevenueTab({ side, bridgeFeeBps }: { side: Side; bridgeFeeBps: number | null }) {
  const { oc, nets, revenue, rev, creator, isMain } = side;
  if (!oc || !rev || !revenue) {
    return <Loading label={`${isMain ? "Revenue" : "Fees"} appear after the next chain read. Press Refresh.`} />;
  }
  const noPrice = notInDollars(nets, (m) => adminName(getNetwork(m.key)));
  const word = isMain ? "Revenue" : "Fees";
  const kept = isMain ? "fees kept" : "testnet, not revenue";
  const since = isMain ? "Since launch" : "All time";
  const creatorErr = isMain ? (oc.creator && !("earnedEth" in oc.creator) ? oc.creator.error : (creator?.error ?? null)) : null;
  const bpsOf = (m: NetworkMetrics) => m.revenue?.feeBps;
  const feeLine = nets
    .map((m) => `${adminName(getNetwork(m.key))} ${bpsOf(m) == null ? "unknown" : `${((bpsOf(m) ?? 0) / 100).toFixed(2)}%`}`)
    .join(", ");
  const w = (v: Windowed | null | undefined, k: keyof Windowed) => (v ? fmtUsd(v[k]) : "Unknown");
  const days = sideRevenueDays(side);
  const daily = days
    .map((d) => {
      const c = creator?.daily.find((x) => x.day === d.day);
      return { ...d, creatorUsd: c?.usd ?? null, creatorEth: c?.eth ?? 0 };
    })
    .reverse();
  const window = days.length < 30 && isMain ? "Since launch" : "Last 30 days";

  const feesByAsset = (
    <Panel title="Cash-out fees by asset" sub={`Fee now: ${feeLine || "no vault read"}`}>
      <DataTable
        headers={["Network", "Asset", "Earned", "USD", "Cash-outs", "Waiting", "Collected"]}
        rows={nets.flatMap((m) =>
          (m.revenue?.feeRows ?? []).map((r) => [adminName(getNetwork(m.key)), r.symbol, r.earned, fmtUsd(r.earnedUsd), n(r.count), r.owed ?? "Unknown", r.collected])
        )}
        empty="No cash-out fees yet"
        minWidth={560}
      />
      <Note>
        Waiting fees sit in the vault until someone calls collectFees(asset), which sends them to the fee recipient
        {nets[0]?.revenue?.feeRecipient ? ` ${shortAddress(nets[0].revenue.feeRecipient, 4)}` : ""}. Anyone can call it; the destination is fixed.
      </Note>
    </Panel>
  );

  return (
    <>
      <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          title={word}
          sub={window}
          delta={weekChange(days.map((d) => d.feesUsd))}
          chart={<DayBars label={`${word} a day`} points={dayPoints(days, (d) => d.feesUsd, fmtUsdShort)} empty="No fees yet" />}
          foot={[
            { label: since, value: fmtUsdBig(revenue.total.all), title: fmtUsd(revenue.total.all) },
            { label: "To collect", value: fmtUsdBig(rev.owedUsd), title: fmtUsd(rev.owedUsd) },
          ]}
        />
        <MetricCard
          title="Deposit volume"
          sub={window}
          delta={weekChange(days.map((d) => d.depositUsd))}
          chart={<StemChart label="Deposits a day, in dollars" points={dayPoints(days, (d) => d.depositUsd, fmtUsdShort)} empty="No deposits yet" />}
          foot={[
            { label: "30 days", value: fmtUsdBig(rev.depositVolume.d30), title: fmtUsd(rev.depositVolume.d30) },
            { label: since, value: fmtUsdBig(rev.depositVolume.all), title: fmtUsd(rev.depositVolume.all) },
          ]}
        />
        <MetricCard
          title="Cash-out volume"
          sub={window}
          delta={weekChange(days.map((d) => d.cashoutUsd))}
          chart={<StemChart label="Cash-outs a day, in dollars" points={dayPoints(days, (d) => d.cashoutUsd, fmtUsdShort)} empty="No cash-outs yet" />}
          foot={[
            { label: "30 days", value: fmtUsdBig(rev.cashoutVolume.d30), title: fmtUsd(rev.cashoutVolume.d30) },
            { label: since, value: fmtUsdBig(rev.cashoutVolume.all), title: fmtUsd(rev.cashoutVolume.all) },
          ]}
        />
        <MetricCard
          title="Active wallets"
          sub={`${n(rev.users.d1)} in 24 hours`}
          delta={weekChange(days.map((d) => d.wallets))}
          chart={<StemChart label="Active wallets a day" points={dayPoints(days, (d) => d.wallets, n)} empty="No wallets yet" />}
          foot={[
            { label: "30 days", value: n(rev.users.d30) },
            { label: "7 days", value: n(rev.users.d7) },
          ]}
        />
      </section>

      <StatStrip
        items={[
          { label: `${word}, 24 hours`, value: fmtUsd(revenue.total.d1), sub: kept },
          { label: `${word}, 7 days`, value: fmtUsd(revenue.total.d7), sub: kept },
          { label: `${word}, 30 days`, value: fmtUsd(revenue.total.d30), sub: kept },
          {
            label: isMain ? `${word} since launch` : `${word}, all time`,
            value: fmtUsd(revenue.total.all),
            sub: isMain ? "cash-out fees since 21 Oct, 13:00 UTC" : kept,
            tone: "sealed",
          },
        ]}
      />

      <Panel title={isMain ? "Revenue by source" : "Fees by source"}>
        <DataTable
          headers={["Source", "24 hours", "7 days", "30 days", isMain ? "Since launch" : "All time", "How it is counted"]}
          rows={[
            [
              "Cash-out fees",
              fmtUsd(rev.fees.d1),
              fmtUsd(rev.fees.d7),
              fmtUsd(rev.fees.d30),
              fmtUsd(rev.fees.all),
              `Kept by the ${isMain ? "mainnet" : "testnet"} vaults on each cash-out (${feeLine || "no vault read"})`,
            ],
            ...(isMain
              ? [
                  [
                    "Bridge fee",
                    "",
                    "",
                    "",
                    "",
                    bridgeFeeBps
                      ? `On, ${(bridgeFeeBps / 100).toFixed(2)}%. Paid out by Relay, not read here`
                      : "Off. Bridging and swaps charge nothing on top of Relay",
                  ],
                  ["Partner API fees", "", "", "", "", "Not charged yet. Would-be fees are on the Partners tab"],
                  [
                    <span key="t" className="font-medium text-foreground">
                      Total
                    </span>,
                    fmtUsd(revenue.total.d1),
                    fmtUsd(revenue.total.d7),
                    fmtUsd(revenue.total.d30),
                    fmtUsd(revenue.total.all),
                    "",
                  ],
                ]
              : []),
          ]}
          minWidth={820}
          wrap={[5]}
        />
        <Note>
          {isMain
            ? "Mainnet only, counted from the mainnet launch (21 Oct 2026, 13:00 UTC). $GLOAM creator fees are trading fees on the token's launchpad, not Gloam revenue, so they are shown on their own below. "
            : "Testnet fees from testing are not revenue. $GLOAM creator fees exist on mainnet only. "}
          {flowPricing(oc, isMain, rev.atToday)}
          {isMain && oc.prices.flowsAtTime ? ". Fees waiting to collect are at today's prices" : ""}
          {noPrice ? `. Not in dollars: ${noPrice}` : ""}. Windows are the last 24 hours, 7 days and 30 days.
        </Note>
      </Panel>

      {isMain ? (
        <div className="grid grid-cols-1 items-start gap-4 2xl:grid-cols-2">
          {feesByAsset}
          <Panel title="$GLOAM creator fees" sub="Not protocol revenue">
            {creator ? (
              <>
                <DataTable
                  headers={["", "ETH", "USD now"]}
                  rows={[
                    [
                      "Earned since mainnet launch",
                      creator.sinceLaunchEth == null ? "Not read yet" : fmtEth(creator.sinceLaunchEth),
                      creator.sinceLaunchUsd == null ? "" : fmtUsd(creator.sinceLaunchUsd),
                    ],
                    ["Earned since the token launched", fmtEth(creator.earnedEth.all), w(creator.earnedUsd, "all")],
                    ["Claimed", fmtEth(creator.claimedEth), oc.prices.ethUsd ? fmtUsd(creator.claimedEth * oc.prices.ethUsd) : "Unknown"],
                    ["Waiting to claim", fmtEth(creator.unclaimedEth), oc.prices.ethUsd ? fmtUsd(creator.unclaimedEth * oc.prices.ethUsd) : "Unknown"],
                    ["Trades that paid a share", n(creator.trades), ""],
                  ]}
                  minWidth={360}
                />
                <Note>
                  The token&apos;s 1% creator share of trades on Orynth, which goes to the creator wallet. It is real money, but it comes from trading $GLOAM,
                  not from people using Gloam. Read from the Orynth fee vault{" "}
                  <a
                    href={getNetwork("robinhood-mainnet").explorerAddress(creator.vault)}
                    target="_blank"
                    rel="noreferrer"
                    className="text-mute transition-colors hover:text-foreground"
                  >
                    {shortAddress(creator.vault, 4)} <ArrowUpRight />
                  </a>{" "}
                  for the creator wallet {shortAddress(creator.creator, 4)}.
                  {creator.catchingUp ? " Still reading its history; the next refresh continues." : ""}
                  {creatorErr ? ` The last read failed (${creatorErr}); showing what was read before.` : ""}
                </Note>
              </>
            ) : (
              <p className="text-[14px] text-mute">{creatorErr ?? "Not read yet. Creator fees are read once Robinhood Chain mainnet is live."}</p>
            )}
          </Panel>
        </div>
      ) : (
        feesByAsset
      )}

      <Panel title={isMain ? "Daily, since launch" : "Daily, last 30 days"} sub="UTC days, newest first">
        <DataTable
          headers={
            isMain
              ? ["Day", "Revenue", "Deposits", "Cash-outs", "Transactions", "Active wallets", "Creator fees, not revenue"]
              : ["Day", "Cash-out fees", "Deposits", "Cash-outs", "Transactions", "Active wallets"]
          }
          rows={daily.map((d) =>
            isMain
              ? [
                  fmtDay(d.day),
                  fmtUsd(d.feesUsd),
                  fmtUsd(d.depositUsd),
                  fmtUsd(d.cashoutUsd),
                  n(d.txs),
                  n(d.wallets),
                  d.creatorUsd == null ? fmtEth(d.creatorEth) : fmtUsd(d.creatorUsd),
                ]
              : [fmtDay(d.day), fmtUsd(d.feesUsd), fmtUsd(d.depositUsd), fmtUsd(d.cashoutUsd), n(d.txs), n(d.wallets)]
          )}
          empty="No days yet"
          minWidth={isMain ? 820 : 620}
          dense
        />
        <Note>
          {isMain ? "Mainnet only, from the launch at 13:00 UTC on 21 Oct" : "Testnets only"}. Revenue is cash-out fees, a private swap&apos;s included. Deposits
          and cash-outs are dollar volume; transactions count deposits, private transfers, cash-outs and private swaps (one each).
          {isMain
            ? ` Creator fees on launch day include trades from before 13:00, and are placed in days by block${
                oc.prices.flowsAtTime ? "; each day's are priced at that day's average ETH price" : ""
              }.`
            : ""}
        </Note>
      </Panel>
    </>
  );
}
