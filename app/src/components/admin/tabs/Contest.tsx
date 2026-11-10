"use client";

import { CONTEST_NETWORK_LABEL, type ContestNetwork } from "@/lib/contest";
import { StreamCard, StreamIcon } from "../cards";
import { MarkKey, TickRow } from "../charts";
import { useAdminResource } from "../data";
import { agoMs, lastDays, n } from "../format";
import { countPoints, markDays } from "../series";
import { CsvLink, DataTable, Note, Notice, Panel, PanelSkeleton, StatStrip } from "../ui";

export type ContestRow = {
  name: string;
  handle: string;
  postUrl: string;
  postUser: string;
  postId: string;
  marketingConsentAt?: number;
  note: string | null;
  email: string | null;
  network: ContestNetwork;
  submittedAt: number;
  updatedAt: number;
  revisions?: number;
  previousPosts?: string[];
};

export type ContestData = { backend: string; entries: ContestRow[] };

/** An entry to look at before judging: its post is by another account, or another entry sent the same post. */
export function contestFlags(entries: ContestRow[]) {
  const postCount = new Map<string, number>();
  for (const e of entries) postCount.set(e.postId, (postCount.get(e.postId) ?? 0) + 1);
  const differs = (e: ContestRow) => e.postUser.toLowerCase() !== e.handle.toLowerCase();
  const shared = (e: ContestRow) => (postCount.get(e.postId) ?? 0) > 1;
  return { differs, shared, flagged: (e: ContestRow) => differs(e) || shared(e) };
}

const link = "underline decoration-line-strong underline-offset-4 hover:decoration-foreground";

/** Video contest entries (gloam.trade/contest), latest change first, and the CSV. Read only. */
export function ContestTab() {
  const res = useAdminResource<ContestData>("/api/contest/entries", "Contest entries");
  if (res.err && !res.data) return <Notice tone="danger">{res.err}</Notice>;
  const data = res.data;
  if (!data) return <PanelSkeleton label="Loading contest entries" />;

  const entries = data.entries;
  const now = res.loadedAt;
  const dayAgo = now - 86_400_000;
  const { differs, shared, flagged } = contestFlags(entries);
  const flaggedCount = entries.filter(flagged).length;
  const points = countPoints(
    entries.map((e) => e.submittedAt),
    30,
    now,
    ["entry", "entries"]
  );
  const marks = markDays(points, lastDays(30, now), entries.filter(flagged).map((e) => e.submittedAt));
  const newest = entries.reduce((m, e) => Math.max(m, e.updatedAt), 0);
  const nets = [...new Set(entries.map((e) => e.network))];
  return (
    <>
      {res.err && <Notice tone="danger">{res.err}. Showing the last answer.</Notice>}
      <StatStrip
        items={[
          { label: "Entries", value: n(entries.length), sub: `${n(entries.filter((e) => e.submittedAt > dayAgo).length)} new in the last 24h` },
          { label: "Updated", value: n(entries.filter((e) => (e.revisions ?? 0) > 0).length), sub: "sent again with the same handle" },
          { label: "Flagged", value: n(flaggedCount), sub: "post account differs, or post reused", tone: flaggedCount ? "danger" : "default" },
          { label: "With email", value: n(entries.filter((e) => e.email).length), sub: "for reaching winners" },
        ]}
      />
      <StreamCard
        icon={<StreamIcon kind="entry" />}
        title="Entries"
        sub="gloam.trade/contest"
        elapsed={newest ? agoMs(newest, now) : "None yet"}
        tally={[
          { value: entries.length - flaggedCount, word: "clean" },
          { value: flaggedCount, word: "flagged", fail: true },
        ]}
        chartLabel="Entries a day"
        chartUnit={(v) => `${n(v)} a day`}
        points={points}
        marks={marks}
        chartFoot="30 days · a red mark is a day with a flagged entry"
        footer={
          <MarkKey
            items={[
              ["ok", "Clean"],
              ["failed", "Flagged"],
            ]}
          />
        }
      >
        {nets.map((net) => {
          const list = entries.filter((e) => e.network === net).sort((a, b) => a.submittedAt - b.submittedAt);
          const bad = list.filter(flagged).length;
          return (
            <TickRow
              key={net}
              label={CONTEST_NETWORK_LABEL[net] ?? net}
              marks={list.map((e) => ({ tone: flagged(e) ? "failed" : "ok", title: `@${e.handle}, ${agoMs(e.submittedAt, now)}${flagged(e) ? ", flagged" : ""}` }))}
              right={bad ? `${n(bad)} flagged` : n(list.length)}
              rightTone={bad ? "danger" : "mute"}
            />
          );
        })}
      </StreamCard>
      <Panel title="Contest entries" sub="Latest change first" action={<CsvLink href="/api/contest/entries?format=csv">Download CSV</CsvLink>}>
        <DataTable
          headers={["Name", "X handle", "Post on X", "Flag", "Network", "What it shows", "Email", "Marketing consent", "Submitted", "Updated"]}
          rows={entries.map((e) => [
            e.name,
            <a key="h" href={`https://x.com/${e.handle}`} target="_blank" rel="noreferrer" className={link}>
              @{e.handle}
            </a>,
            <a
              key="p"
              href={e.postUrl}
              target="_blank"
              rel="noreferrer"
              title={(e.previousPosts ?? []).length ? `Earlier: ${(e.previousPosts ?? []).join(" ")}` : e.postUrl}
              className={link}
            >
              @{e.postUser}/{e.postId.slice(-6)}
            </a>,
            flagged(e) ? (
              <span key="f" className="text-danger">
                {[differs(e) ? "Post is not by this handle" : null, shared(e) ? "Same post as another entry" : null].filter(Boolean).join(". ")}
              </span>
            ) : (
              "None"
            ),
            CONTEST_NETWORK_LABEL[e.network] ?? e.network,
            <span key="note" title={e.note ?? undefined} className="block max-w-[260px] truncate">
              {e.note ?? "None"}
            </span>,
            e.email ?? "None",
            e.marketingConsentAt ? `Yes, ${new Date(e.marketingConsentAt).toLocaleString()}` : "No",
            new Date(e.submittedAt).toLocaleString(),
            (e.revisions ?? 0) > 0 ? `${new Date(e.updatedAt).toLocaleString()} (${e.revisions}x)` : "Not updated",
          ])}
          empty={data.backend === "none" ? "Contest storage is not configured (set Upstash Redis)." : "No entries yet"}
          minWidth={1400}
        />
        <Note>
          One entry per X handle; sending again replaces it. Check each post quotes the announcement and tags @gloamtrade before judging. Hover a post link for
          posts an entry replaced. Store: {data.backend}.
        </Note>
      </Panel>
    </>
  );
}
