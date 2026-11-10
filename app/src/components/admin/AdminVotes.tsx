"use client";

import { useEffect, useMemo, useState } from "react";
import { formatGloam, percentOf, type Ballot } from "@/lib/vote/core";
import type { VoteSummary } from "@/lib/vote/results";
import type { Feedback } from "@/lib/vote/feedback";
import type { HolderRecord } from "@/lib/vote/holders";
import { StreamCard, StreamIcon } from "./cards";
import { TickRow } from "./charts";
import { agoMs } from "./format";
import { countPoints } from "./series";
import { CsvLink, DataTable, Notice, Panel, PanelSkeleton, StatStrip } from "./ui";

type Data = {
  backend: string;
  kept: { ballots: string; feedback: string };
  /** `live` and `final`: a close-weighted vote's weight now and at the closing block (null when not known). */
  votes: { summary: VoteSummary; ballots: (Ballot & { live?: string | null; final?: string | null })[] }[];
  feedback: Feedback[];
  holders?: (HolderRecord & { voted: string[] })[];
};

type HolderSort = "last" | "first" | "snapshot" | "current" | "voted";

const big = (v: string | null) => (v ? BigInt(v) : -1n);
const cmpBig = (a: bigint, b: bigint) => (a > b ? -1 : a < b ? 1 : 0);

const REFRESH_MS = 60_000;

/** Where a vote's tally comes from, for the Tallies table. */
function basisText(s: VoteSummary): string {
  if (s.basis === "live") return "Live (GLOAM now)";
  if (s.basis === "counting") return "Live, final count pending";
  if (s.basis === "final") return `Final at block ${n(s.closeBlock ?? 0)}`;
  return `Snapshot block ${n(s.snapshotBlock)}`;
}
const n = (v: number) => v.toLocaleString("en-US");

function Chips<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-1.5">
      {options.map(([v, text]) => (
        <button
          key={v}
          type="button"
          role="radio"
          aria-checked={value === v}
          onClick={() => onChange(v)}
          className={`min-h-9 rounded-full border px-3 text-[13px] transition-colors ${
            value === v ? "border-foreground bg-foreground text-panel" : "border-line text-mute hover:text-foreground"
          }`}
        >
          {text}
        </button>
      ))}
    </div>
  );
}

/** Admin: every vote's tallies and ballots, and the private feedback, with filters and exports. */
export function VotesPanel() {
  const [data, setData] = useState<(Data & { loadedAt: number }) | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [vote, setVote] = useState<string>("all");
  const [option, setOption] = useState<string>("all");
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string>("all");
  const [holderSort, setHolderSort] = useState<HolderSort>("last");

  useEffect(() => {
    let live = true;
    const load = async () => {
      try {
        const res = await fetch("/api/admin/votes", { credentials: "include", cache: "no-store" });
        const json = (await res.json().catch(() => null)) as { ok?: boolean; data?: Data; error?: { message?: string } } | null;
        if (!live) return;
        if (!res.ok || !json?.ok || !json.data) {
          setErr(json?.error?.message ?? `Votes failed (${res.status})`);
          return;
        }
        setErr(null);
        setData({ ...json.data, loadedAt: Date.now() });
      } catch {
        if (live) setErr("Network error loading votes");
      }
    };
    void load();
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, REFRESH_MS);
    return () => {
      live = false;
      window.clearInterval(id);
    };
  }, []);

  const rows = useMemo(() => {
    if (!data) return [];
    const q = query.trim().toLowerCase();
    return data.votes
      .filter((v) => vote === "all" || v.summary.id === vote)
      .flatMap((v) => v.ballots.map((b) => ({ vote: v.summary, b })))
      .filter(({ b }) => (option === "all" || String(b.option) === option) && (!q || b.voter.toLowerCase().includes(q)))
      .sort((a, b) => b.b.receivedAt - a.b.receivedAt);
  }, [data, vote, option, query]);

  const notes = useMemo(() => {
    if (!data) return [];
    const q = query.trim().toLowerCase();
    return data.feedback.filter((f) => (category === "all" || f.category === category) && (!q || f.author.toLowerCase().includes(q) || f.message.toLowerCase().includes(q)));
  }, [data, category, query]);

  const holders = useMemo(() => {
    const list = [...(data?.holders ?? [])];
    const q = query.trim().toLowerCase();
    const by: Record<HolderSort, (a: (typeof list)[number], b: (typeof list)[number]) => number> = {
      last: (a, b) => b.lastSeen - a.lastSeen,
      first: (a, b) => a.firstSeen - b.firstSeen,
      snapshot: (a, b) => cmpBig(BigInt(a.snapshot), BigInt(b.snapshot)),
      current: (a, b) => cmpBig(big(a.current), big(b.current)),
      voted: (a, b) => b.voted.length - a.voted.length || b.lastSeen - a.lastSeen,
    };
    return list.filter((h) => !q || h.address.toLowerCase().includes(q)).sort(by[holderSort]);
  }, [data, query, holderSort]);

  if (err && !data) return <Notice tone="danger">{err}</Notice>;
  if (!data) return <PanelSkeleton label="Loading votes" />;

  const one = vote === "all" ? null : data.votes.find((v) => v.summary.id === vote) ?? null;
  const wallets = new Set(data.votes.flatMap((v) => v.ballots.map((b) => b.voter.toLowerCase()))).size;
  const dayAgo = data.loadedAt - 86_400_000;

  return (
    <>
      {err && <Notice tone="danger">{err}. Showing the last answer.</Notice>}
      <StatStrip
        items={[
          { label: "Votes", value: n(data.votes.length), sub: `${n(data.votes.filter((v) => v.summary.status === "open").length)} open now` },
          { label: "Wallets that voted", value: n(wallets), sub: "in any vote" },
          {
            label: "Ballots",
            value: n(data.votes.reduce((s, v) => s + v.ballots.length, 0)),
            sub: `${n(data.votes.reduce((s, v) => s + v.ballots.filter((b) => b.receivedAt > dayAgo).length, 0))} in the last 24h`,
          },
          { label: "Feedback notes", value: n(data.feedback.length), sub: `${n(data.feedback.filter((f) => f.receivedAt > dayAgo).length)} in the last 24h` },
        ]}
      />

      {(() => {
        const all = data.votes.flatMap((v) => v.ballots);
        const newest = all.reduce((m, b) => Math.max(m, b.receivedAt), 0);
        const points = countPoints(
          all.map((b) => b.receivedAt),
          30,
          data.loadedAt,
          ["ballot", "ballots"]
        );
        return (
          <StreamCard
            icon={<StreamIcon kind="entry" />}
            title="Ballots"
            sub="Signed by wallets on the vote pages"
            elapsed={newest ? agoMs(newest, data.loadedAt) : "None yet"}
            tally={[
              { value: all.length, word: "ballots" },
              { value: data.votes.filter((v) => v.summary.status === "open").length, word: "open" },
            ]}
            chartLabel="Ballots a day"
            chartUnit={(v) => `${n(v)} a day`}
            points={points}
            chartFoot={`30 days · ${n(points.reduce((a, p) => a + p.value, 0))} ballots`}
            footer={<p className="text-[12px] text-faint">One mark per ballot, by vote, newest on the right</p>}
          >
            {data.votes.map((v) => (
              <TickRow
                key={v.summary.id}
                label={v.summary.question}
                marks={[...v.ballots]
                  .sort((a, b) => a.receivedAt - b.receivedAt)
                  .map((b) => ({ tone: "ok", title: `${b.choice}, ${agoMs(b.receivedAt, data.loadedAt)}` }))}
                right={n(v.ballots.length)}
                dim={v.summary.status !== "open"}
              />
            ))}
          </StreamCard>
        );
      })()}

      <Panel
        title="Holders"
        action={
<CsvLink href="/api/admin/votes?format=csv&kind=holders">CSV</CsvLink>
        }
      >
        {(() => {
          const all = data.holders ?? [];
          const eligible = all.filter((h) => h.eligible).length;
          const votedHolders = all.filter((h) => h.voted.length > 0).length;
          return (
            <div className="mb-5">
              <StatStrip
                items={[
                  { label: "Connected wallets", value: n(all.length), sub: `${n(all.filter((h) => h.lastSeen > dayAgo).length)} seen in the last 24h` },
                  { label: "Eligible", value: n(eligible), sub: `${n(all.filter((h) => h.excluded).length)} team or contract` },
                  { label: "Voted", value: n(votedHolders), sub: "connected wallets with a ballot" },
                  {
                    label: "Conversion",
                    value: `${all.length ? percentOf(BigInt(votedHolders), BigInt(all.length)) : 0}%`,
                    sub: `connected to voted (${eligible ? percentOf(BigInt(all.filter((h) => h.eligible && h.voted.length > 0).length), BigInt(eligible)) : 0}% of eligible)`,
                  },
                ]}
              />
            </div>
          );
        })()}
        <div className="mb-4">
          <Chips
            label="Sort holders"
            value={holderSort}
            onChange={setHolderSort}
            options={[
              ["last", "Last seen"],
              ["first", "First seen"],
              ["snapshot", "Snapshot GLOAM"],
              ["current", "GLOAM now"],
              ["voted", "Votes signed"],
            ]}
          />
        </div>
        <DataTable
          headers={["Wallet", "Snapshot GLOAM", "GLOAM now", "Eligible", "Voted in", "First seen (UTC)", "Last seen (UTC)"]}
          rows={holders.map((h) => [
            <span key="w" className="font-mono text-[12.5px]" title={h.address}>
              {h.address}
            </span>,
            formatGloam(h.snapshot),
            h.current === null ? <span key="c" className="text-mute">not read</span> : formatGloam(h.current),
            h.excluded ? <span key="e" className="text-mute" title={h.excluded}>Excluded</span> : h.eligible ? "Yes" : "No",
            h.voted.length ? h.voted.join(", ") : <span key="v" className="text-mute">none</span>,
            new Date(h.firstSeen).toISOString().replace("T", " ").slice(0, 16),
            new Date(h.lastSeen).toISOString().replace("T", " ").slice(0, 16),
          ])}
          empty={data.backend === "none" ? "Holder storage is not configured (set Upstash Redis)." : "No wallets have connected yet"}
          minWidth={1100}
        />
        <p className="mt-4 text-[13px] leading-relaxed text-mute">
          Every wallet that connected on a vote page and ran the $GLOAM check. Balances are worked out on the server (the snapshot file and a
          Robinhood Chain read), never taken from the browser. In a vote weighted at close, Eligible means the wallet held GLOAM when it
          was last seen. The wallet filter under Every vote applies here too.
        </p>
      </Panel>

      <Panel
        title="Tallies"
        action={
<CsvLink href="/api/admin/votes?download=1">All data (JSON)</CsvLink>
        }
      >
        <DataTable
          headers={["Vote", "Status", "Weights", "Answer", "Share", "GLOAM", "Wallets"]}
          rows={data.votes.flatMap((v) => {
            const total = BigInt(v.summary.totals.weight);
            return v.summary.totals.options.map((o, i) => [
              i === 0 ? <span key="q" className="text-foreground">{v.summary.question}</span> : "",
              i === 0 ? (v.summary.draft ? "Draft" : v.summary.status) : "",
              i === 0 ? basisText(v.summary) : "",
              o.label,
              `${percentOf(BigInt(o.weight), total)}%`,
              formatGloam(o.weight),
              n(o.wallets),
            ]);
          })}
          empty="No votes configured"
          minWidth={980}
        />
      </Panel>

      <Panel
        title="Every vote"
        action={
<CsvLink href={`/api/admin/votes?format=csv&kind=votes${vote === "all" ? "" : `&vote=${encodeURIComponent(vote)}`}`}>CSV</CsvLink>
        }
      >
        <div className="mb-4 flex flex-col gap-3">
          <Chips
            label="Vote"
            value={vote}
            onChange={(v) => {
              setVote(v);
              setOption("all");
            }}
            options={[["all", "All votes"], ...data.votes.map((v) => [v.summary.id, v.summary.question] as [string, string])]}
          />
          {one && (
            <Chips label="Answer" value={option} onChange={setOption} options={[["all", "Any answer"], ...one.summary.options.map((o, i) => [String(i), o] as [string, string])]} />
          )}
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter by wallet (or feedback text)"
            aria-label="Filter by wallet or feedback text"
            className="gl-input max-w-[420px]"
          />
        </div>
        <DataTable
          headers={["Wallet", "Vote", "Answer", "GLOAM at signing", "GLOAM live", "GLOAM final", "Signed (UTC)", "Signature"]}
          rows={rows.map(({ vote: v, b }) => [
            <span key="w" className="font-mono text-[12.5px]" title={b.voter}>
              {b.voter}
            </span>,
            v.id,
            b.choice,
            formatGloam(b.weight),
            v.weighting !== "close" ? <span key="l" className="text-mute">snapshot</span> : b.live == null ? <span key="l" className="text-mute">not read</span> : formatGloam(b.live),
            v.weighting !== "close" ? <span key="f" className="text-mute">snapshot</span> : b.final == null ? <span key="f" className="text-mute">after close</span> : formatGloam(b.final),
            new Date(b.timestamp * 1000).toISOString().replace("T", " ").slice(0, 19),
            <span key="s" className="block max-w-[180px] truncate font-mono text-[12px] text-mute" title={b.signature}>
              {b.signature}
            </span>,
          ])}
          empty={data.backend === "none" ? "Vote storage is not configured (set Upstash Redis)." : "No votes match"}
          minWidth={1300}
        />
      </Panel>

      <Panel
        title="Feedback (private)"
        action={
<CsvLink href="/api/admin/votes?format=csv&kind=feedback">CSV</CsvLink>
        }
      >
        <div className="mb-4">
          <Chips
            label="Kind"
            value={category}
            onChange={setCategory}
            options={[
              ["all", "All"],
              ["Feature", "Feature"],
              ["Bug", "Bug"],
              ["Idea", "Idea"],
              ["Other", "Other"],
            ]}
          />
        </div>
        <DataTable
          headers={["Wallet", "Kind", "Note", "Sent (UTC)"]}
          rows={notes.map((f) => [
            <span key="w" className="font-mono text-[12.5px]" title={f.author}>
              {f.author}
            </span>,
            f.category,
            <span key="m" className="block max-w-[560px] whitespace-pre-wrap text-foreground">
              {f.message}
            </span>,
            new Date(f.receivedAt).toISOString().replace("T", " ").slice(0, 16),
          ])}
          empty={data.backend === "none" ? "Feedback storage is not configured (set Upstash Redis)." : "No feedback yet"}
          minWidth={980}
        />
        <p className="mt-4 text-[13px] leading-relaxed text-mute">
          Notes are signed by a wallet that could vote, private to the team and never shown on the site. Kept in Redis ({data.backend}) with no
          expiry: ballots until deleted, feedback the {data.kept.feedback} notes.
        </p>
      </Panel>
    </>
  );
}
