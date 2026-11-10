"use client";

import { relayChainName } from "@/lib/bridge";
import { ArrowUpRight } from "@/components/ui/ArrowUpRight";
import { MetricCard } from "../cards";
import { DayBars, StemChart } from "../charts";
import { weekChange } from "../data";
import { fmtDay, fmtUsd, fmtUsdBig, fmtUsdShort, fmtWhen, n } from "../format";
import { dayPoints } from "../series";
import type { Side } from "../side";
import { BridgeStream } from "../streams";
import { BarChart, DataTable, Note, Notice, Panel, StatStrip } from "../ui";

const RELAY_FUNNEL: [string, string][] = [
  ["bridge_address_created", "Deposit addresses made"],
  ["bridge_arrived", "Bridges that arrived"],
  ["swap_review", "Swaps reviewed"],
  ["swap_submit", "Swaps sent from a wallet"],
  ["swap_success", "Swaps that landed"],
];

/** Bridges in through Relay deposit addresses, and same-chain swaps of the gas coin. */
export function RelayTab({ side }: { side: Side }) {
  const counters = side.prod.counters;
  const dims = side.prod.dims;
  const relay = side.relay;
  const funnelMax = Math.max(1, ...RELAY_FUNNEL.map(([k]) => counters[k] ?? 0));
  const funnel = RELAY_FUNNEL.map(([k, label]) => ({ k: label, v: counters[k] ?? 0, sub: k, pct: ((counters[k] ?? 0) / funnelMax) * 100 }));
  const bySourceEvents = Object.entries(dims)
    .map(([key, v]) => {
      const m = /^(bridge_address_created|bridge_arrived)\|source=(.+)$/.exec(key);
      return m ? { event: m[1]!, source: m[2]!, v } : null;
    })
    .filter((x): x is { event: string; source: string; v: number } => x !== null);
  const sources = [...new Set(bySourceEvents.map((x) => x.source))];
  const eventRows = sources
    .map((src) => {
      const made = bySourceEvents.find((x) => x.source === src && x.event === "bridge_address_created")?.v ?? 0;
      const arrived = bySourceEvents.find((x) => x.source === src && x.event === "bridge_arrived")?.v ?? 0;
      return { src, made, arrived };
    })
    .sort((a, b) => b.arrived - a.arrived || b.made - a.made);

  const live = side.liveRelay;
  const off = relay && "enabled" in relay && !relay.enabled ? relay.reason : null;
  const failed = relay && "error" in relay ? relay.error : null;

  return (
    <>
      {live ? (
        <StatStrip
          items={[
            { label: "Bridged in, 30 days", value: fmtUsd(live.last30.bridge.inUsd), sub: `${n(live.last30.bridge.count)} bridges, ${fmtUsd(live.all.bridge.inUsd)} all time` },
            { label: "Swapped, 30 days", value: fmtUsd(live.last30.swap.inUsd), sub: `${n(live.last30.swap.count)} swaps, ${fmtUsd(live.all.swap.inUsd)} all time` },
            {
              label: "Finished, all time",
              value: n(live.all.bridge.count + live.all.swap.count),
              sub: `${n(live.refunded)} refunded, ${n(live.failed)} failed, ${n(live.pending)} in flight`,
            },
            {
              label: "Fees paid to Relay",
              value: fmtUsd(live.all.bridge.feeUsd + live.all.swap.feeUsd),
              sub: `${fmtUsd(live.last30.bridge.feeUsd + live.last30.swap.feeUsd)} in 30 days, paid by users`,
            },
          ]}
        />
      ) : (
        <Notice tone={failed ? "danger" : "info"}>
          {failed
            ? `Relay: ${failed}`
            : `Volume from Relay is off. ${off ?? ""} Add RELAY_API_KEY on Vercel to tag new quotes as gloam.trade and read them back here. Until then, the counts below come from product events and carry no amounts.`}
        </Notice>
      )}

      {live?.historyError ? (
        <Notice tone="danger">
          Relay&apos;s history didn&apos;t answer ({live.historyError}). These figures are what Gloam has on record so far, so the newest swaps may be missing.
        </Notice>
      ) : live?.history === "v2" ? (
        <Notice tone="warn">
          Add RELAY_API_KEY_ID on Vercel before 24 November 2026. Relay retires the history read this page uses on that day, and new swaps stop counting here
          without it.
        </Notice>
      ) : null}

      {live && <BridgeStream side={side} />}

      {live && (
        <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          <MetricCard
            title="Bridged in"
            sub="Last 30 days"
            delta={weekChange(live.daily.map((d) => d.bridgeUsd))}
            chart={<StemChart label="Bridged in a day, in dollars" points={dayPoints(live.daily, (d) => d.bridgeUsd, fmtUsdShort)} empty="No bridges in 30 days" />}
            foot={[
              { label: "30 days", value: fmtUsdBig(live.last30.bridge.inUsd), title: fmtUsd(live.last30.bridge.inUsd) },
              { label: "Bridges", value: n(live.last30.bridge.count) },
            ]}
          />
          <MetricCard
            title="Swapped"
            sub="Last 30 days"
            delta={weekChange(live.daily.map((d) => d.swapUsd))}
            chart={<StemChart label="Swapped a day, in dollars" points={dayPoints(live.daily, (d) => d.swapUsd, fmtUsdShort)} empty="No swaps in 30 days" />}
            foot={[
              { label: "30 days", value: fmtUsdBig(live.last30.swap.inUsd), title: fmtUsd(live.last30.swap.inUsd) },
              { label: "Swaps", value: n(live.last30.swap.count) },
            ]}
          />
          <MetricCard
            title="Fees paid to Relay"
            sub="By users, not Gloam revenue"
            chart={<DayBars label="Relay fees a day" points={dayPoints(live.daily, (d) => d.feeUsd, fmtUsdShort)} empty="No fees in 30 days" />}
            foot={[
              { label: "30 days", value: fmtUsdBig(live.last30.bridge.feeUsd + live.last30.swap.feeUsd) },
              { label: "All time", value: fmtUsdBig(live.all.bridge.feeUsd + live.all.swap.feeUsd) },
            ]}
          />
        </section>
      )}

      <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-2">
        <Panel title="Funnel" sub="Product events">
          <BarChart rows={funnel} />
          <Note>
            Product events, counted only for visitors who accepted analytics. They carry the chain and token, never an amount, wallet or transaction.
          </Note>
        </Panel>
        <Panel title="By source chain">
          {live ? (
            <DataTable
              headers={["Source", "Kind", "Finished", "Volume", "Relay fees"]}
              rows={live.bySource.map((r) => [relayChainName(r.chainId), r.kind === "swap" ? "Swap" : "Bridge", n(r.count), fmtUsd(r.inUsd), fmtUsd(r.feeUsd)])}
              empty="Nothing counted yet"
              minWidth={460}
            />
          ) : (
            <DataTable
              headers={["Source", "Addresses made", "Arrived"]}
              rows={eventRows.map((r) => [r.src, n(r.made), n(r.arrived)])}
              empty="No bridge events yet"
              minWidth={360}
            />
          )}
        </Panel>
      </div>

      {live && (
        <>
          <Panel title="Last 30 days" sub="Days with a finished bridge or swap, newest first">
            <DataTable
              headers={["Day", "Bridges", "Bridged", "Swaps", "Swapped", "Relay fees"]}
              rows={[...live.daily]
                .reverse()
                .filter((d) => d.bridges + d.swaps > 0)
                .map((d) => [fmtDay(d.day), n(d.bridges), fmtUsd(d.bridgeUsd), n(d.swaps), fmtUsd(d.swapUsd), fmtUsd(d.feeUsd)])}
              empty="No finished bridges or swaps in the last 30 days"
              minWidth={560}
              dense
            />
            <Note>
              UTC days, finished requests only, valued in dollars by Relay when each one was made.
              {live.since ? ` Counted since ${fmtWhen(live.since)}.` : " Nothing counted yet."}
              {" Older bridges were never tagged at Relay, so they can't be recovered."}
              {live.truncated ? " More requests exist than one refresh reads, so totals are a floor." : ""}
            </Note>
          </Panel>
          <Panel title="Recent" sub="Wallets are left out on purpose. Relay holds the full record.">
            <DataTable
              headers={["Kind", "From", "Sent", "Received", "Status", "Tx", "When"]}
              rows={live.recent.map((r) => [
                r.kind === "swap" ? "Swap" : "Bridge",
                relayChainName(r.fromChainId),
                `${r.inAmount ? Number(r.inAmount).toLocaleString("en-US", { maximumFractionDigits: 6 }) : ""} ${r.inSymbol}`.trim(),
                `${r.outAmount ? Number(r.outAmount).toLocaleString("en-US", { maximumFractionDigits: 2 }) : ""} ${r.outSymbol}`.trim(),
                <span key="s" className={r.stage === "failed" || r.stage === "refunded" ? "text-danger" : r.stage === "done" ? "text-foreground" : "text-mute"}>
                  {r.stage === "done" ? "Done" : r.stage === "refunded" ? "Refunded" : r.stage === "failed" ? "Failed" : "In flight"}
                </span>,
                r.tx ? (
                  <a key="t" href={`https://relay.link/transaction/${r.tx}`} target="_blank" rel="noreferrer" className="text-mute transition-colors hover:text-foreground">
                    {r.tx.slice(0, 10)}… <ArrowUpRight />
                  </a>
                ) : (
                  ""
                ),
                fmtWhen(r.ts),
              ])}
              empty="No requests yet"
              minWidth={720}
              dense
            />
          </Panel>
        </>
      )}
    </>
  );
}
