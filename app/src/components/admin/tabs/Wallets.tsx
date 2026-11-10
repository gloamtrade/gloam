"use client";

import { getNetwork } from "@/lib/networks";
import type { PeopleSide } from "@/lib/peopleStore";
import { StemChart } from "../charts";
import { MAINNET_DAY } from "../data";
import { fmtDay, fmtWhen, n } from "../format";
import { dayPoints } from "../series";
import type { Side } from "../side";
import { BarChart, DataTable, Note, Notice, Panel, StatStrip } from "../ui";

const PEOPLE_ROWS: [keyof PeopleSide["byAction"], string][] = [
  ["connect", "Connected a wallet"],
  ["claim", "Claimed a payment"],
  ["deposit", "Deposited"],
  ["send", "Sent privately"],
  ["swap", "Swapped privately"],
  ["cashout", "Cashed out"],
  ["payroll", "Ran payroll"],
  ["request", "Paid a request"],
];

/** The setup line when people aren't being counted yet. */
export function PeopleOff() {
  return (
    <Notice tone="warn">
      Counting people is off. Set <code className="text-foreground">GLOAM_RELAY_MEMO_SECRET</code> or <code className="text-foreground">GLOAM_METRICS_SALT</code> on
      Vercel to a random secret of 32 or more characters (<code className="text-foreground">openssl rand -hex 32</code>) and redeploy. Keep it the same from then
      on: a new one counts everyone again.
    </Notice>
  );
}

/**
 * Different wallets using Gloam, for one side: everyone, and by what they did.
 * Counted one way (lib/peopleStore): no address is kept, so there is nothing
 * to list, only how many. Then the depositors read from the chain.
 */
export function WalletsTab({ side }: { side: Side }) {
  const people = side.data?.people;
  const { isMain, nets, nameOf, claim } = side;
  const claims = claim.totals.link_claimed;
  const mixedClaims = claim.mixed?.link_claimed ?? 0;
  const s = people?.[side.env];
  const rows = s ? PEOPLE_ROWS.map(([k, label]) => ({ k: label, v: s.byAction[k] ?? 0 })) : [];
  const max = Math.max(1, ...rows.map((r) => r.v));
  const since = people?.since
    ? new Date(people.since).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC" })
    : null;
  const daily = (s?.daily ?? []).filter((d) => !isMain || d.day >= MAINNET_DAY);
  const depositors = nets
    .flatMap((m) => m.topDepositors.map((u) => ({ ...u, key: m.key, label: nameOf(m) })))
    .sort((a, b) => b.deposits - a.deposits || b.lastTs - a.lastTs);

  return (
    <>
      {people && !people.configured && <PeopleOff />}
      {people?.error && <Notice tone="danger">{people.error}</Notice>}
      <StatStrip
        items={[
          { label: isMain ? "People, since launch" : "People, all time", value: s ? n(s.all) : null, sub: "different wallets" },
          { label: "Today", value: s ? n(s.today) : null, sub: "since 00:00 UTC" },
          { label: "7 days", value: s ? n(s.d7) : null, sub: "UTC days, today included" },
          { label: "30 days", value: s ? n(s.d30) : null, sub: "UTC days, today included" },
        ]}
      />
      <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-2">
        <Panel title="By what they did" sub="All time, different wallets">
          {s ? <BarChart rows={rows.map((r) => ({ ...r, pct: (r.v / max) * 100 }))} /> : <div className="gl-skeleton h-[280px]" />}
          {s && (
            <Note>
              Wallets that received a cash out: <span className="tnum text-soft">{n(s.byAction.cashout_to)}</span>, read from the chain. Not added to people, since one
              person can cash out to several addresses; with them, people would be <span className="tnum text-soft">{n(s.allWithCashoutTo)}</span>.
            </Note>
          )}
        </Panel>
        <Panel title="People by day" sub="UTC days">
          <StemChart label="People a day" points={dayPoints(daily, (d) => d.people, (v) => `${n(v)} people`)} empty="No days counted yet" />
          <div className="mt-5">
            <DataTable headers={["Day", "People"]} rows={[...daily].reverse().map((d) => [fmtDay(d.day), n(d.people)])} empty="No days yet" minWidth={240} dense />
          </div>
        </Panel>
      </div>
      <Note>
        Different wallets, {isMain ? "mainnet only" : "testnets only"}, counted one way: each address becomes a keyed hash that goes into a HyperLogLog, so no
        address is stored and there is no list to show, only how many. Counts are estimates, exact or nearly so at this size. The app counts connects and actions
        {since ? ` since ${since} UTC` : " once counting is on"}, a few minutes after they happen and once per wallet a day; depositors are also read from the chain
        {isMain ? " since launch" : ""}. Recording demos are not counted.
        {claims + mixedClaims > 0
          ? ` Claim-link claims in the last 14 days: ${n(claims)}${mixedClaims ? `, plus ${n(mixedClaims)} on launch day from either network` : ""}. Those count claims, not people, and include claims from before wallets were counted.`
          : ""}
      </Note>
      <Panel title="Depositors" sub="By activity. Unique wallets that deposited into a current vault, per network. A wallet used on both networks shows twice.">
        <DataTable
          headers={["#", "Network", "Address", "Deposits", "Last deposit", "Explorer"]}
          rows={depositors.map((u, i) => [
            String(i + 1),
            u.label,
            <span key="addr" className="text-[13px] text-foreground">
              {u.address}
            </span>,
            n(u.deposits),
            fmtWhen(u.lastTs),
            <a
              key="ex"
              href={getNetwork(u.key).explorerAddress(u.address)}
              target="_blank"
              rel="noreferrer"
              className="text-foreground underline decoration-line-strong underline-offset-4 transition-colors hover:decoration-foreground"
            >
              View
            </a>,
          ])}
          empty="No depositors yet"
          dense
        />
      </Panel>
    </>
  );
}
