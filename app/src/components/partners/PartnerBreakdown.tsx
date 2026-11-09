"use client";

import { HowItWorks } from "@/components/ui/HowItWorks";
import type { ReactNode } from "react";
import { getNetwork, networkName, type NetworkKey } from "@/lib/networks";
import type { ActivityKind, ActivitySource, PartnerStats } from "@/lib/partners";

/**
 * One partner's figures for one tier (mainnet or testnet, never added together),
 * the same in the partner's dashboard and in Admin > Partners: by source (API key,
 * link, matched on chain), by kind, by day and by token, with the vault's own
 * cash-out fee, and the CSV downloads. Only what the partner brought in; private
 * payments never show an amount and are never listed one by one. Testnet activity
 * is counted, never valued in dollars.
 */

export const SOURCE_LABEL: Record<ActivitySource, string> = {
  api: "Via API key",
  link: "Via link",
  chain: "Matched on chain",
};

export const SOURCE_HINT: Record<ActivitySource, string> = {
  api: "Relayed or reported with an API key",
  link: "Opened from a link with a partner code, checked on chain",
  chain: "Past cash outs to the partner's own addresses, found on chain",
};

const KINDS: [ActivityKind, string][] = [
  ["private_payment", "Private payments"],
  ["cash_out", "Cash outs"],
  ["deposit", "Deposits"],
  ["private_swap", "Private swaps"],
];

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
const int = new Intl.NumberFormat("en-US");

function fmtUsd(n: number | null | undefined): string {
  if (n == null) return "Not priced";
  if (n > 0 && n < 0.01) return "<$0.01";
  return usd.format(n);
}

function fmtTokens(v: string): string {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString("en-US", { maximumFractionDigits: 6 }) : v;
}

function fmtDay(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", weekday: "short", timeZone: "UTC" });
}

function Table({ headers, rows, empty, minWidth = 560 }: { headers: string[]; rows: ReactNode[][]; empty: string; minWidth?: number }) {
  if (rows.length === 0) return <p className="px-5 py-6 text-[13.5px] text-mute sm:px-6">{empty}</p>;
  return (
    <div className="overflow-x-auto">
      <table className="tnum w-full text-left text-[14px]" style={{ minWidth }}>
        <thead className="border-b border-line bg-surface">
          <tr>
            {headers.map((h, i) => (
              <th key={`${h}-${i}`} className="whitespace-nowrap px-4 py-3 text-[12.5px] font-medium text-mute first:pl-5 sm:first:pl-6">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="border-b border-line last:border-0">
              {row.map((cell, j) => (
                <td key={j} className={`h-[50px] whitespace-nowrap px-4 py-2 first:pl-5 sm:first:pl-6 ${j === 0 ? "text-foreground" : "text-soft"}`}>
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Section({ title, action, foot, children }: { title: string; action?: ReactNode; foot?: ReactNode; children: ReactNode }) {
  return (
    <section className="gl-card min-w-0 overflow-hidden">
      <div className="flex min-h-[60px] flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-3 sm:px-6">
        <h2 className="text-[15px] font-medium text-foreground">{title}</h2>
        {action}
      </div>
      {children}
      {foot && <div className="border-t border-line px-5 py-3 text-[12.5px] leading-relaxed text-mute sm:px-6">{foot}</div>}
    </section>
  );
}

export type BreakdownStats = Pick<PartnerStats, "tier" | "totals" | "byKind" | "bySource" | "byAsset" | "daily">;

export function PartnerBreakdown({
  stats,
  csv,
  notMatched,
  days,
}: {
  stats: BreakdownStats;
  /** Download links for this partner's CSV files. */
  csv: { daily: string; transactions: string };
  /** Why past private payments and swaps can't be matched on chain, from the server. */
  notMatched?: { privatePayments: string; swaps: string };
  days: number;
}) {
  const t = stats.totals;
  const testnet = stats.tier === "testnet";
  // test tokens have no price: testnet money columns say so instead of showing $0
  const money = (n: number) => (testnet ? "Not priced" : fmtUsd(n));
  const sources: ActivitySource[] = ["api", "link", "chain"];
  const active = stats.daily.filter((d) => d.privatePayments + d.cashOuts + d.deposits + d.swaps > 0).reverse();

  return (
    <div className="space-y-4">
      <Section
        title="Where it came from"
        action={
          <span className="flex flex-wrap gap-1">
            <a href={csv.daily} className="btn btn-ghost btn-sm" download>
              Daily CSV
            </a>
            <a href={csv.transactions} className="btn btn-ghost btn-sm" download>
              Transactions CSV
            </a>
          </span>
        }
        foot={
          <>
            {testnet ? "Testnet: counted, never valued." : "Nothing is charged to partners."} Private payments show only as counts.
            <HowItWorks
              items={[
                testnet ? "Test tokens have no price." : "Volume: the dollar value of deposits, cash outs and each swap's input.",
                ...(testnet ? [] : ["Vault fee: Gloam's own cash-out fee on those, read from each transaction."]),
                "Private payments: never an amount, never one by one. The partner sees only days that have ended (UTC).",
                "Fee-split grade: API key, relay-bound links and matched on chain.",
                "In brackets: link counts the payer's wallet registered, attribution grade.",
                ...(notMatched ? [notMatched.privatePayments, notMatched.swaps] : []),
              ]}
            />
          </>
        }
      >
        <Table
          headers={["Source", ...KINDS.map(([, label]) => label), "Volume", "Vault fee"]}
          rows={sources.map((s) => {
            const r = stats.bySource[s];
            return [
              <span key="s" title={SOURCE_HINT[s]}>
                {SOURCE_LABEL[s]}
                {s === "link" && KINDS.some(([kind]) => r.walletBound[kind] > 0)
                  ? ` (${int.format(KINDS.reduce((n, [kind]) => n + r.walletBound[kind], 0))} by wallet)`
                  : ""}
              </span>,
              ...KINDS.map(([kind]) => int.format(r.counts[kind])),
              money(r.volumeUsd),
              money(r.vaultFeeUsd),
            ];
          })}
          empty="Nothing yet."
          minWidth={760}
        />
      </Section>

      <Section title="By kind" foot={t.vaultFeeUnpriced ? `${int.format(t.vaultFeeUnpriced)} vault fees have no dollar price (a stock token, say); they are in the token CSV.` : undefined}>
        <Table
          headers={["Kind", "Count", "Volume", "Vault fee", "Not priced"]}
          rows={KINDS.map(([kind, label]) => {
            const k = stats.byKind[kind];
            return [label, int.format(k.count), kind === "private_payment" ? "Hidden" : money(k.volumeUsd), money(k.vaultFeeUsd), int.format(k.unpriced)];
          })}
          empty="Nothing yet."
        />
      </Section>

      <Section
        title={`By day, last ${days} days (UTC)`}
        foot="Days with no activity are left out. API, link and chain are counts by source. A partner's own view counts private payments only once their day has ended."
      >
        <Table
          headers={["Day", "Payments", "Cash outs", "Deposits", "Swaps", "Volume", "Swap volume", "Vault fee", "API · link · chain"]}
          rows={active.map((d) => {
            const by = (s: ActivitySource) => KINDS.reduce((n, [kind]) => n + d.bySource[s].counts[kind], 0);
            return [
              fmtDay(d.day),
              int.format(d.privatePayments),
              int.format(d.cashOuts),
              int.format(d.deposits),
              int.format(d.swaps),
              money(d.volumeUsd),
              money(d.swapVolumeUsd),
              money(d.vaultFeeUsd),
              `${by("api")} · ${by("link")} · ${by("chain")}`,
            ];
          })}
          empty={`No activity in the last ${days} days.`}
          minWidth={900}
        />
      </Section>

      <Section title="By token" foot="Whole tokens. Private payments never show a token or an amount.">
        <Table
          headers={["Token", "Network", "Cash outs", "Deposits", "Swap inputs", "Vault fee"]}
          rows={stats.byAsset.map((a) => [
            a.symbol,
            networkName(getNetwork(a.network as NetworkKey)),
            fmtTokens(a.byKind.cash_out),
            fmtTokens(a.byKind.deposit),
            fmtTokens(a.byKind.private_swap),
            fmtTokens(a.vaultFee),
          ])}
          empty="No cash outs, deposits or swaps yet."
          minWidth={640}
        />
      </Section>
    </div>
  );
}
