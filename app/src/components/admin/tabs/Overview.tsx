"use client";

import type { ReactNode } from "react";
import { getNetwork } from "@/lib/networks";
import { shortAddress } from "@/lib/chain";
import { HowItWorks } from "@/components/ui/HowItWorks";
import { ArrowUpRight } from "@/components/ui/ArrowUpRight";
import { ActivityFeed, ChainCards, VolumeChart, type VolumeDay } from "../AdminCharts";
import { MetricCard } from "../cards";
import { DayBars, StemChart, TickDonut, topSegments } from "../charts";
import { MAINNET_DAY, adminName, flowPricing, useAdminResource, weekChange, type Env, type Tab } from "../data";
import { fmtDay, fmtUsd, fmtUsdBig, fmtUsdShort, fmtWhen, n } from "../format";
import { countPoints, dayPoints } from "../series";
import { sideRevenueDays, type Side } from "../side";
import { BridgeStream, ProductStream, VaultStream } from "../streams";
import { BarChart, DataTable, Note, Notice, Panel, SectionHead } from "../ui";
import { PeopleOff } from "./Wallets";
import { partnerActivity, partnersUrl, type PartnersPayload } from "./Partners";
import type { TestersData } from "./Testers";
import { contestFlags, type ContestData } from "./Contest";
import type { BugsData } from "./Bugs";

type Go = (t: Tab) => void;

/** The money cards: deposits, cash-outs, fees and what the vaults hold. */
function MoneyCards({ side, go }: { side: Side; go: Go }) {
  const { agg, rev, revenue, nets, nameOf, isMain } = side;
  const loading = !agg || !rev;
  const days = sideRevenueDays(side);
  const window = isMain && days.length < 30 ? "Since launch" : "Last 30 days";
  const since = isMain ? "Since launch" : "All time";
  const held = topSegments(
    nets.map((m) => ({ key: m.key, label: nameOf(m), short: nameOf(m).split(" ")[0], value: m.heldUsd, display: fmtUsd(m.heldUsd) })),
    fmtUsd
  );
  // The headline: everything that moved in and out, added up. Deposits and cash-outs are public on
  // chain, so their dollar amounts can be summed; private payments never are.
  const moved = rev ? rev.depositVolume.all + rev.cashoutVolume.all : null;
  const moved7 = rev ? rev.depositVolume.d7 + rev.cashoutVolume.d7 : null;
  const moved1 = rev ? rev.depositVolume.d1 + rev.cashoutVolume.d1 : null;
  const movedFoot: { label: string; value: number | null }[] = [
    { label: `Total, ${since.toLowerCase()}`, value: moved },
    { label: "In", value: rev ? rev.depositVolume.all : null },
    { label: "Out", value: rev ? rev.cashoutVolume.all : null },
    { label: "Last 7 days", value: moved7 },
  ];
  return (
    <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <MetricCard
        className="sm:col-span-2 xl:col-span-4"
        title="Money moved"
        sub={`In and out, ${window.toLowerCase()}${moved1 != null ? `, ${fmtUsd(moved1)} in the last 24 hours` : ""}`}
        delta={weekChange(days.map((d) => d.depositUsd + d.cashoutUsd))}
        onOpen={() => go("revenue")}
        openLabel="Revenue"
        loading={loading}
        chart={
          <StemChart
            label="Money moved in and out a day, in dollars"
            points={dayPoints(days, (d) => d.depositUsd + d.cashoutUsd, fmtUsdShort)}
            empty="Nothing moved yet"
          />
        }
        foot={
          <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            {movedFoot.map((f, i) => (
              <div key={f.label} className="min-w-0">
                <dt className="truncate text-[10px] font-medium uppercase tracking-[0.09em] text-faint">{f.label}</dt>
                {f.value == null ? (
                  <dd className="gl-skeleton mt-2 h-[26px] w-20" />
                ) : (
                  <dd
                    title={fmtUsd(f.value)}
                    className={`tnum mt-1.5 truncate font-light leading-none tracking-[-0.03em] text-foreground ${i === 0 ? "text-[40px]" : "text-[26px]"}`}
                  >
                    {i === 0 ? fmtUsd(f.value) : fmtUsdBig(f.value)}
                  </dd>
                )}
              </div>
            ))}
          </dl>
        }
      />
      <MetricCard
        title="Deposits"
        sub={window}
        delta={weekChange(days.map((d) => d.depositUsd))}
        onOpen={() => go("revenue")}
        openLabel="Revenue"
        loading={loading}
        chart={<StemChart label="Deposits a day, in dollars" points={dayPoints(days, (d) => d.depositUsd, fmtUsdShort)} empty="No deposits yet" />}
        foot={[
          { label: since, value: rev ? fmtUsdBig(rev.depositVolume.all) : null, title: rev ? fmtUsd(rev.depositVolume.all) : undefined },
          { label: "Deposits", value: agg ? n(agg.deposits) : null },
        ]}
      />
      <MetricCard
        title="Cash-outs"
        sub={window}
        delta={weekChange(days.map((d) => d.cashoutUsd))}
        onOpen={() => go("revenue")}
        openLabel="Revenue"
        loading={loading}
        chart={<StemChart label="Cash-outs a day, in dollars" points={dayPoints(days, (d) => d.cashoutUsd, fmtUsdShort)} empty="No cash-outs yet" />}
        foot={[
          { label: since, value: rev ? fmtUsdBig(rev.cashoutVolume.all) : null, title: rev ? fmtUsd(rev.cashoutVolume.all) : undefined },
          { label: "Cash-outs", value: agg ? n(agg.cashouts) : null },
        ]}
      />
      <MetricCard
        title={isMain ? "Revenue" : "Testnet fees"}
        sub="Cash-out fees"
        delta={weekChange(days.map((d) => d.feesUsd))}
        onOpen={() => go("revenue")}
        openLabel={isMain ? "Revenue" : "Fees"}
        loading={loading}
        chart={<DayBars label="Cash-out fees a day" points={dayPoints(days, (d) => d.feesUsd, fmtUsdShort)} empty="No fees yet" />}
        foot={[
          { label: since, value: revenue ? fmtUsdBig(revenue.total.all) : null, title: revenue ? fmtUsd(revenue.total.all) : undefined },
          { label: "To collect", value: rev ? fmtUsdBig(rev.owedUsd) : null, title: rev ? fmtUsd(rev.owedUsd) : undefined },
        ]}
      />
      <MetricCard
        title="In the vault"
        sub={agg?.unpriced.length ? `By network, ${agg.unpriced.length} unpriced left out` : "By network, now"}
        loading={!agg}
        chart={
          <TickDonut
            label="Held in the vaults by network"
            centerLabel="Held now"
            total={agg ? fmtUsdBig(agg.heldUsd) : ""}
            segments={held}
          />
        }
      />
    </section>
  );
}

/** The use cards: private payments, people, what they do, claim links. */
function UseCards({ side, go }: { side: Side; go: Go }) {
  const { agg, isMain, claim, data } = side;
  const chainDays = (isMain && agg?.sinceLaunch?.length ? agg.sinceLaunch : (agg?.daily ?? [])).filter((d) => !isMain || d.day >= MAINNET_DAY).slice(-30);
  const today = agg?.daily.at(-1)?.transfers ?? 0;
  const people = data?.people?.[side.env];
  const peopleDays = (people?.daily ?? []).filter((d) => !isMain || d.day >= MAINNET_DAY);
  const kinds = agg
    ? [
        { key: "transfers", label: "Private payments", short: "Payments", value: agg.transfers, display: n(agg.transfers), tone: "sealed" as const },
        { key: "deposits", label: "Deposits", value: agg.deposits, display: n(agg.deposits) },
        { key: "cashouts", label: "Cash-outs", value: agg.cashouts, display: n(agg.cashouts) },
        { key: "trades", label: "Private swaps", short: "Swaps", value: agg.trades, display: n(agg.trades) },
      ].filter((s) => s.value > 0)
    : [];
  const txTotal = agg ? agg.transfers + agg.deposits + agg.cashouts + agg.trades : 0;
  return (
    <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <MetricCard
        title="Private payments"
        sub="Counted, never summed"
        delta={weekChange(chainDays.map((d) => d.transfers))}
        loading={!agg}
        chart={
          <StemChart
            label="Private payments a day"
            tone="sealed"
            points={dayPoints(chainDays, (d) => d.transfers, (v) => `${n(v)} sent`)}
            empty="No private payments yet"
          />
        }
        foot={[
          { label: isMain ? "Since launch" : "All time", value: agg ? n(agg.transfers) : null },
          { label: "Today, UTC", value: agg ? n(today) : null },
        ]}
      />
      <MetricCard
        title="People"
        sub="Different wallets"
        onOpen={() => go("users")}
        openLabel="Wallets"
        loading={!people}
        chart={<StemChart label="People a day" points={dayPoints(peopleDays, (d) => d.people, (v) => `${n(v)} people`)} empty="No people counted yet" />}
        foot={[
          { label: isMain ? "Since launch" : "All time", value: people ? n(people.all) : null },
          { label: "Last 7 days", value: people ? n(people.d7) : null },
        ]}
      />
      <MetricCard
        title="Transactions"
        sub="By kind, on chain"
        loading={!agg}
        chart={<TickDonut label="Vault transactions by kind" centerLabel="Landed" total={n(txTotal)} segments={kinds} />}
      />
      <MetricCard
        title="Claim links"
        sub="Last 14 days"
        delta={weekChange(claim.byDay.map((d) => d.link_claimed))}
        loading={!data}
        chart={<DayBars label="Claim links claimed a day" points={dayPoints(claim.byDay, (d) => d.link_claimed, (v) => `${n(v)} claimed`)} empty="No claims yet" />}
        foot={[
          { label: "Made", value: n(claim.totals.link_created) },
          { label: "Claimed", value: n(claim.totals.link_claimed) },
        ]}
      />
    </section>
  );
}

/** The programs: partners, testers, contest, bug reports. Each reads its own list once, then with the page. */
function ProgramCards({ env, go }: { env: Env; go: Go }) {
  const partners = useAdminResource<PartnersPayload>(partnersUrl(env), "Partners");
  const testers = useAdminResource<TestersData>("/api/testers", "Testers");
  const contest = useAdminResource<ContestData>("/api/contest/entries", "Contest entries");
  const bugs = useAdminResource<BugsData>("/api/admin/bugs", "Bug reports");

  const p = partners.data;
  const byVolume = env === "mainnet" && (p?.totals?.publicVolumeUsd ?? 0) > 0;
  const partnerSegs = topSegments(
    (p?.partners ?? []).map((x) =>
      byVolume
        ? { key: x.id, label: x.name, value: x.totals?.publicVolumeUsd ?? 0, display: fmtUsd(x.totals?.publicVolumeUsd ?? 0) }
        : { key: x.id, label: x.name, value: partnerActivity(x.totals), display: n(partnerActivity(x.totals)) }
    ),
    byVolume ? fmtUsd : n
  );
  const partnerTotal = byVolume ? fmtUsdBig(p?.totals?.publicVolumeUsd ?? 0) : n((p?.partners ?? []).reduce((a, x) => a + partnerActivity(x.totals), 0));

  const tNow = testers.loadedAt;
  const apps = testers.data?.applications ?? [];
  const paid = apps.filter((a) => a.paid !== false).length;

  const cNow = contest.loadedAt;
  const entries = contest.data?.entries ?? [];
  const flagged = entries.filter(contestFlags(entries).flagged).length;

  const bNow = bugs.loadedAt;
  const reports = bugs.data?.reports ?? [];

  const failed = (err: string | null, has: boolean) => (err && !has ? err : null);
  const errChart = (msg: string) => <div className="grid h-[132px] place-items-center rounded-[12px] bg-danger-soft px-4 text-center text-[13px] text-danger">{msg}</div>;

  return (
    <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <MetricCard
        title="Partners"
        sub={byVolume ? "Public volume they brought" : "What they brought in"}
        onOpen={() => go("partners")}
        loading={!p && !partners.err}
        chart={
          failed(partners.err, !!p) ? (
            errChart(partners.err!)
          ) : (
            <TickDonut label="Partner activity by partner" centerLabel={byVolume ? "Volume" : "Brought in"} total={partnerTotal} segments={partnerSegs} />
          )
        }
      />
      <MetricCard
        title="Testers"
        sub="Applications a day"
        onOpen={() => go("testers")}
        loading={!testers.data && !testers.err}
        chart={
          failed(testers.err, !!testers.data) ? (
            errChart(testers.err!)
          ) : (
            <StemChart label="Tester applications a day" points={countPoints(apps.map((a) => a.createdAt), 30, tNow, ["application", "applications"])} empty="No applications in 30 days" />
          )
        }
        foot={[
          { label: "Applications", value: testers.data ? n(apps.length) : testers.err ? "Unknown" : null },
          { label: "Paid spots", value: testers.data ? `${n(paid)}/${n(testers.data.cap)}` : testers.err ? "Unknown" : null },
        ]}
      />
      <MetricCard
        title="Contest"
        sub="Entries a day"
        onOpen={() => go("contest")}
        loading={!contest.data && !contest.err}
        chart={
          failed(contest.err, !!contest.data) ? (
            errChart(contest.err!)
          ) : (
            <StemChart label="Contest entries a day" points={countPoints(entries.map((e) => e.submittedAt), 30, cNow, ["entry", "entries"])} empty="No entries in 30 days" />
          )
        }
        foot={[
          { label: "Entries", value: contest.data ? n(entries.length) : contest.err ? "Unknown" : null },
          { label: "Flagged", value: contest.data ? n(flagged) : contest.err ? "Unknown" : null },
        ]}
      />
      <MetricCard
        title="Bug reports"
        sub="Reports a day"
        onOpen={() => go("bugs")}
        loading={!bugs.data && !bugs.err}
        chart={
          failed(bugs.err, !!bugs.data) ? (
            errChart(bugs.err!)
          ) : (
            <DayBars label="Bug reports a day" points={countPoints(reports.map((r) => r.createdAt), 30, bNow, ["report", "reports"])} empty="No reports in 30 days" />
          )
        }
        foot={[
          { label: "Reports", value: bugs.data ? n(reports.length) : bugs.err ? "Unknown" : null },
          { label: "Last 24h", value: bugs.data ? n(reports.filter((r) => r.createdAt > bNow - 86_400_000).length) : bugs.err ? "Unknown" : null },
        ]}
      />
    </section>
  );
}

export function OverviewTab({ side, go }: { side: Side; go: Go }) {
  const { agg, rev, oc, nets, nameOf, isMain, money, claim, funnel, days, peopleByDay, noPrice, heldNoPrice, data, liveRelay } = side;
  const volumeDays: VolumeDay[] = sideRevenueDays(side).map((d) => ({ day: d.day, inUsd: d.depositUsd, outUsd: d.cashoutUsd, txs: d.txs }));
  const movedIn = rev?.depositVolume.all ?? 0;
  const movedOut = rev?.cashoutVolume.all ?? 0;
  const byNetwork = (f: (m: (typeof nets)[number]) => ReactNode, total: (c: NonNullable<typeof agg>) => ReactNode): ReactNode[] => [
    ...nets.map((m) => f(m)),
    agg ? total(agg) : "",
  ];

  return (
    <>
      {data?.people && !data.people.configured && <PeopleOff />}
      {data?.people?.error && <Notice tone="danger">{data.people.error}</Notice>}

      <MoneyCards side={side} go={go} />
      <UseCards side={side} go={go} />

      <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-2 xl:[&>*:last-child:nth-child(odd)]:col-span-2">
        <VaultStream side={side} />
        {isMain && <BridgeStream side={side} />}
        <ProductStream side={side} />
      </div>

      <SectionHead title="Programs" sub="Partners, testers, the contest and bug reports" />
      <ProgramCards env={side.env} go={go} />

      <SectionHead title="Money in and out" sub={money === "mainnet" ? "Mainnet, by day" : "Testnets, by day"} />
      <Panel
        title={isMain ? (volumeDays.length < 30 ? "Money in and out by day, since launch" : "Money in and out by day, last 30 days") : "Money in and out by day, last 30 days"}
        sub={
          rev ? (
            <span className="tnum">
              Moved {fmtUsd(movedIn + movedOut)} {isMain ? "since launch" : "all time"}: {fmtUsd(movedIn)} in, {fmtUsd(movedOut)} out. Last 24 hours{" "}
              {fmtUsd(rev.depositVolume.d1 + rev.cashoutVolume.d1)}, last 7 days {fmtUsd(rev.depositVolume.d7 + rev.cashoutVolume.d7)}.
            </span>
          ) : (
            "After the next chain read"
          )
        }
      >
        <VolumeChart days={volumeDays} caption={`Daily deposits and cash-outs in dollars, ${money}`} />
        <Note>
          UTC days, {money}. Deposits rise above the line, cash-outs drop below it. The scale stretches to fit the biggest day, so quiet days stay readable.{" "}
          {oc ? flowPricing(oc, isMain, rev?.atToday) : "Priced once the chains are read"}
          {noPrice ? `. Not in dollars: ${noPrice}` : ""}. Deposits and cash-outs are public on chain, so their amounts are added up; private payment amounts stay
          hidden and a private swap stays inside the vault, so neither is in these figures.
          {isMain && liveRelay
            ? ` Bridged and swapped through Gloam in 30 days: ${fmtUsd(liveRelay.last30.bridge.inUsd + liveRelay.last30.swap.inUsd)}, not added here: bridged money counts once it is deposited.`
            : ""}
        </Note>
      </Panel>

      <ChainCards nets={nets} totalMoved={movedIn + movedOut} name={nameOf} />

      <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
        <Panel title="Latest activity" sub="Deposits and cash-outs show their amount; private payments never do">
          <ActivityFeed rows={side.recentTx} name={adminName} />
        </Panel>
        <Panel title="Claim links, last 14 days" sub={claim.mixed ? "Launch day before counting by network is listed apart" : "Totals only, counted without cookies or ids"}>
          <BarChart rows={claim.steps} />
          <Note>
            {claim.mixed
              ? `Launch day before counting by network: ${n(claim.mixed.link_created)} made, ${n(claim.mixed.link_claimed)} claimed, either network, not added here.`
              : ""}
          </Note>
          <HowItWorks
            title="How claim links are counted"
            items={[
              "Totals only, counted without cookies or ids.",
              "Claimed can run ahead of made: claims count every claim link or code, while made counts only links made in this app whose payment landed (payroll links since 21 Oct; codes from the SDK, agents or before 13 Oct are not counted).",
              "Opened counts each link once per browser, so a link opened in a chat app and again in a wallet counts twice.",
              "Counting by network started on launch day at 17:43 UTC; launch-day counts from before that could be either network, so they are listed apart and not added to either total.",
              "Everything before launch day is Testnet.",
            ]}
          />
        </Panel>
      </div>

      <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-2">
        <Panel title="Funnel" sub="Event counts, not unique people, except first deposits">
          <BarChart rows={funnel} />
          <Note>First deposits are unique wallets read from the chain. Recording demo sessions are not counted.</Note>
        </Panel>
        <Panel title="Claim links by day" sub="UTC days, newest first">
          <DataTable
            headers={["Day", "Made", "Opened", "Claimed", "Claimer paid"]}
            rows={claim.rows.map((d) => [
              d.label ? (
                <span key="d" className="text-mute">
                  {fmtDay(d.day)}, {d.label}
                </span>
              ) : (
                fmtDay(d.day)
              ),
              n(d.link_created),
              n(d.link_opened),
              n(d.link_claimed),
              n(d.claimer_sent),
            ])}
            empty="No claim links yet"
            minWidth={420}
            dense
          />
        </Panel>
      </div>

      <SectionHead title="Details" sub={`Every figure behind the cards, ${money}`} />
      <Panel title="Last 14 days" sub="UTC days, newest first">
        <DataTable
          headers={["Day", "People", "Active wallets", "Deposits", "Transfers", "Cash-outs", "App views", "Connects", "Proofs"]}
          rows={days.map((d) => [
            fmtDay(d.day),
            peopleByDay.has(d.day) ? n(peopleByDay.get(d.day)) : "",
            n(d.chain?.activeWallets),
            n(d.chain?.deposits),
            n(d.chain?.transfers),
            n(d.chain?.cashouts),
            n(d.ev.app_view),
            n(d.ev.wallet_connect),
            n(d.ev.proof_created),
          ])}
          empty="No days yet"
          minWidth={680}
          dense
        />
        <Note>
          People are different wallets that connected, claimed, deposited or used the app that day. Active wallets deposited or received a cash-out that day.
        </Note>
      </Panel>

      <Panel title="Held by asset" sub="What each vault holds now, and what moved through it">
        <DataTable
          headers={["Network", "Asset", "Held now", "USD", "Deposited", "Cashed out"]}
          rows={nets.flatMap((m) =>
            m.assets.map((a) => [nameOf(m), a.symbol, a.held ?? "Unknown", fmtUsd(a.heldUsd), `${a.deposited} (${a.depositCount})`, `${a.cashedOut} (${a.cashoutCount})`])
          )}
          empty="Nothing held or moved yet"
          dense
        />
        <Note>
          Held now is at today&apos;s prices. Dollar stablecoins count as $1
          {heldNoPrice ? `; ${heldNoPrice} have no dollar price and are left out of dollar totals` : ""}. ETH{" "}
          {oc?.prices.ethUsd ? `at ${fmtUsd(oc.prices.ethUsd)}` : "is not priced right now"}; stock tokens at live equity marks
          {oc?.prices.stocks === "live" ? "" : ", not available right now"}. Deposited and cashed out are token amounts, counts in brackets; private swaps are not
          in them.
        </Note>
      </Panel>

      <Panel title="By network, in detail" sub="Current vaults only">
        <DataTable
          headers={["", ...nets.map(nameOf), "Total"]}
          rows={[
            ["Deposits", ...byNetwork((m) => n(m.deposits), (c) => n(c.deposits))],
            ["Private transfers", ...byNetwork((m) => n(m.transfers), (c) => n(c.transfers))],
            ["Cash-outs", ...byNetwork((m) => n(m.cashouts), (c) => n(c.cashouts))],
            ["Private swaps and trades", ...byNetwork((m) => n(m.trades), (c) => n(c.trades))],
            ["Payment messages", ...byNetwork((m) => n(m.memos), (c) => n(c.memos))],
            ["Depositor wallets", ...byNetwork((m) => n(m.depositors), (c) => n(c.depositors))],
            ["Active wallets", ...byNetwork((m) => n(m.activeWallets), (c) => n(c.activeWallets))],
            ["Held (priced)", ...byNetwork((m) => fmtUsd(m.heldUsd), (c) => fmtUsd(c.heldUsd))],
            [
              "Deposit volume",
              ...byNetwork(
                (m) => (m.revenue ? fmtUsd(m.revenue.depositVolume.all) : ""),
                (c) => (c.revenue ? fmtUsd(c.revenue.depositVolume.all) : "")
              ),
            ],
            [
              "Cash-out volume",
              ...byNetwork(
                (m) => (m.revenue ? fmtUsd(m.revenue.cashoutVolume.all) : ""),
                (c) => (c.revenue ? fmtUsd(c.revenue.cashoutVolume.all) : "")
              ),
            ],
            [
              "Cash-out fees",
              ...byNetwork(
                (m) => (m.revenue ? fmtUsd(m.revenue.fees.all) : ""),
                (c) => (c.revenue ? fmtUsd(c.revenue.fees.all) : "")
              ),
            ],
            ["First activity", ...byNetwork((m) => fmtWhen(m.firstActivity), (c) => fmtWhen(c.firstActivity))],
            ["Last activity", ...byNetwork((m) => fmtWhen(m.lastActivity), (c) => fmtWhen(c.lastActivity))],
            ["Vault since", ...byNetwork((m) => fmtWhen(m.vaultSince), () => "")],
            [
              "Vault",
              ...byNetwork(
                (m) => (
                  <a
                    key="v"
                    href={getNetwork(m.key).explorerAddress(m.pool)}
                    target="_blank"
                    rel="noreferrer"
                    className="text-mute transition-colors hover:text-foreground"
                  >
                    {shortAddress(m.pool, 4)} <ArrowUpRight />
                  </a>
                ),
                () => ""
              ),
            ],
            ["Read to block", ...byNetwork((m) => `#${m.scannedTo}`, () => "")],
          ]}
          empty={isMain ? "No mainnet vault read yet" : "No testnet vault read yet"}
          dense
        />
        <Note>
          Current vaults only, {money}. Active wallets deposited or received a cash-out; transfers and trades carry no wallet. The total counts a wallet used on both
          networks once.
        </Note>
      </Panel>
    </>
  );
}
