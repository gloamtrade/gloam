"use client";

import { StreamCard, StreamIcon } from "../cards";
import { TickRow } from "../charts";
import { useAdminResource } from "../data";
import { agoMs, n } from "../format";
import { countPoints } from "../series";
import { DataTable, Note, Notice, Panel, PanelSkeleton, StatStrip } from "../ui";

export type BugRow = {
  id: string;
  userId: number;
  username: string | null;
  firstName: string;
  thread: string;
  text: string;
  link: string | null;
  createdAt: number;
};

export type BugsData = { backend: string; reports: BugRow[] };

const link = "underline decoration-line-strong underline-offset-4 hover:decoration-foreground";

/** Bug reports the Telegram helper saved from Testers, Feedback and /bug. Read only. */
export function BugsTab() {
  const res = useAdminResource<BugsData>("/api/admin/bugs", "Bug reports");
  if (res.err && !res.data) return <Notice tone="danger">{res.err}</Notice>;
  const data = res.data;
  if (!data) return <PanelSkeleton label="Loading bug reports" />;
  const reports = data.reports;
  const now = res.loadedAt;
  const dayAgo = now - 86_400_000;
  const people = new Set(reports.map((r) => r.userId)).size;
  const points = countPoints(
    reports.map((r) => r.createdAt),
    30,
    now,
    ["report", "reports"]
  );
  const threads = [...new Set(reports.map((r) => r.thread))];
  const newest = reports.reduce((m, r) => Math.max(m, r.createdAt), 0);
  return (
    <>
      {res.err && <Notice tone="danger">{res.err}. Showing the last answer.</Notice>}
      <StatStrip
        cols={2}
        items={[
          { label: "Reports", value: n(reports.length), sub: `${n(reports.filter((r) => r.createdAt > dayAgo).length)} in the last 24h` },
          { label: "Reporters", value: n(people), sub: "people on Telegram" },
        ]}
      />
      <StreamCard
        icon={<StreamIcon kind="bug" />}
        title="Reports"
        sub="Telegram helper · Testers, Feedback and /bug"
        elapsed={newest ? agoMs(newest, now) : "None yet"}
        tally={[
          { value: reports.length, word: "reports" },
          { value: people, word: "people" },
        ]}
        chartLabel="Reports a day"
        chartUnit={(v) => `${n(v)} a day`}
        points={points}
        chartFoot={`30 days · ${n(points.reduce((a, p) => a + p.value, 0))} reports`}
        footer={<p className="text-[12px] text-faint">One mark per report, by where it was sent, newest on the right</p>}
      >
        {threads.map((t) => {
          const list = reports.filter((r) => r.thread === t).sort((a, b) => a.createdAt - b.createdAt);
          return (
            <TickRow
              key={t}
              label={t}
              marks={list.map((r) => ({ tone: "public", title: `${r.firstName || r.username || `User ${r.userId}`}, ${agoMs(r.createdAt, now)}: ${r.text.slice(0, 80)}` }))}
              right={n(list.length)}
            />
          );
        })}
      </StreamCard>
      <Panel title="Bug reports" sub="Newest first">
        <DataTable
          headers={["From", "Where", "Report", "Message", "Reported"]}
          rows={reports.map((r) => [
            r.username ? (
              <a key="u" href={`https://t.me/${r.username}`} target="_blank" rel="noreferrer" className={link}>
                {r.firstName || r.username} (@{r.username})
              </a>
            ) : (
              r.firstName || `User ${r.userId}`
            ),
            r.thread,
            <span key="t" title={r.text} className="block max-w-[420px] truncate">
              {r.text}
            </span>,
            r.link ? (
              <a key="l" href={r.link} target="_blank" rel="noreferrer" className={link}>
                Open
              </a>
            ) : (
              "None"
            ),
            new Date(r.createdAt).toLocaleString(),
          ])}
          empty={data.backend === "none" ? "Bug storage is not configured (set Upstash Redis)." : "No bug reports yet"}
          minWidth={980}
        />
        <Note>Saved by the Telegram helper from Testers, Feedback and /bug. Hover a report for the full text. Store: {data.backend}.</Note>
      </Panel>
    </>
  );
}
