"use client";

import { shortAddress } from "@/lib/chain";
import { StreamCard, StreamIcon } from "../cards";
import { MarkKey, TickRow } from "../charts";
import { useAdminResource } from "../data";
import { agoMs, fmtUsd, n } from "../format";
import { countPoints } from "../series";
import { CsvLink, DataTable, Note, Notice, Panel, PanelSkeleton, StatStrip } from "../ui";

export type TesterRow = {
  id: string;
  name: string;
  telegram: string;
  x: string | null;
  address: string;
  network: "both" | "tempo" | "robinhood";
  setup: string | null;
  note: string | null;
  paid?: boolean;
  createdAt: number;
};

export type TestersData = { backend: string; cap: number; applications: TesterRow[] };

export const TESTER_NETWORK: Record<TesterRow["network"], string> = { both: "Any", tempo: "Tempo", robinhood: "Robinhood Chain" };

const link = "underline decoration-line-strong underline-offset-4 hover:decoration-foreground";

export function TestersTab() {
  const res = useAdminResource<TestersData>("/api/testers", "Testers");
  if (res.err && !res.data) return <Notice tone="danger">{res.err}</Notice>;
  const data = res.data;
  if (!data) return <PanelSkeleton label="Loading testers" />;
  const apps = data.applications;
  const now = res.loadedAt;
  const dayAgo = now - 86_400_000;
  const paid = apps.filter((a) => a.paid !== false).length;
  const points = countPoints(
    apps.map((a) => a.createdAt),
    30,
    now,
    ["application", "applications"]
  );
  const newest = apps.reduce((m, a) => Math.max(m, a.createdAt), 0);
  const byNet = (["robinhood", "tempo", "both"] as const).map((k) => [k, apps.filter((a) => a.network === k).sort((a, b) => a.createdAt - b.createdAt)] as const);
  return (
    <>
      {res.err && <Notice tone="danger">{res.err}. Showing the last answer.</Notice>}
      <StatStrip
        items={[
          { label: "Applications", value: n(apps.length), sub: `${n(apps.filter((a) => a.createdAt > dayAgo).length)} in the last 24h` },
          { label: "Paid spots", value: `${n(paid)} / ${n(data.cap)}`, sub: paid >= data.cap ? "Full, new testers are volunteers" : `${n(data.cap - paid)} left` },
          { label: "Volunteers", value: n(apps.length - paid), sub: "joined after paid spots filled" },
          { label: "Rewards owed", value: fmtUsd(paid * 10), sub: "$10 per paid tester" },
        ]}
      />
      <StreamCard
        icon={<StreamIcon kind="person" />}
        title="Applications"
        sub="gloam.trade/testers"
        elapsed={newest ? agoMs(newest, now) : "None yet"}
        tally={[
          { value: paid, word: "paid" },
          { value: apps.length - paid, word: "volunteers" },
        ]}
        chartLabel="Applications a day"
        chartUnit={(v) => `${n(v)} a day`}
        points={points}
        chartFoot={`30 days · ${n(points.reduce((a, p) => a + p.value, 0))} applications`}
        footer={
          <MarkKey
            items={[
              ["ok", "Paid spot"],
              ["pending", "Volunteer"],
            ]}
          />
        }
      >
        {byNet.map(([k, list]) => (
          <TickRow
            key={k}
            label={TESTER_NETWORK[k]}
            marks={list.map((a) => ({ tone: a.paid !== false ? "ok" : "pending", title: `${a.name}, ${a.paid !== false ? "paid" : "volunteer"}, ${agoMs(a.createdAt, now)}` }))}
            right={n(list.length)}
          />
        ))}
      </StreamCard>
      <Panel title="Tester applications" sub="Newest first" action={<CsvLink href="/api/testers?format=csv">Download CSV</CsvLink>}>
        <DataTable
          headers={["Name", "Spot", "Telegram", "X", "EVM address", "Network", "Device and wallet", "Note", "Applied"]}
          rows={apps.map((a) => [
            a.name,
            a.paid !== false ? "Paid" : "Volunteer",
            <a key="t" href={`https://t.me/${a.telegram}`} target="_blank" rel="noreferrer" className={link}>
              @{a.telegram}
            </a>,
            a.x ? (
              <a key="x" href={`https://x.com/${a.x}`} target="_blank" rel="noreferrer" className={link}>
                @{a.x}
              </a>
            ) : (
              "None"
            ),
            <span key="a" title={a.address}>
              {shortAddress(a.address, 4)}
            </span>,
            TESTER_NETWORK[a.network] ?? a.network,
            a.setup ?? "None",
            <span key="note" title={a.note ?? undefined} className="block max-w-[260px] truncate">
              {a.note ?? "None"}
            </span>,
            new Date(a.createdAt).toLocaleString(),
          ])}
          empty={data.backend === "none" ? "Tester storage is not configured (set Upstash Redis)." : "No applications yet"}
          minWidth={1180}
        />
        <Note>Approve Telegram join requests that match an application. The CSV has full addresses for paying rewards. Store: {data.backend}.</Note>
      </Panel>
    </>
  );
}
