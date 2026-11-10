"use client";

import { NEW_EVENTS, dimValue, metaText } from "../data";
import { n } from "../format";
import type { Side } from "../side";
import { ProductStream } from "../streams";
import { DataTable, Empty, Note, Panel } from "../ui";

/** Product events: the run of the latest ones, every counter, the breakdowns and the raw stream. */
export function EventsTab({ side }: { side: Side }) {
  const { isMain, prod, breakdowns } = side;
  const counters = Object.entries(prod.counters).sort((a, b) => b[1] - a[1]);
  const max = Math.max(1, ...counters.map(([, v]) => v));
  const backend = side.data?.product?.backend;
  return (
    <>
      <ProductStream side={side} />

      <Panel title="Every event" sub={`${n(counters.length)} kinds, ${n(prod.total)} events, ${isMain ? "mainnet" : "testnets"}`}>
        {counters.length === 0 ? (
          <Empty>No events yet</Empty>
        ) : (
          <ul className="grid grid-cols-1 gap-x-8 sm:grid-cols-2 xl:grid-cols-3">
            {counters.map(([k, v]) => (
              <li key={k} className="border-b border-line py-2.5">
                <div className="flex items-baseline justify-between gap-3 text-[13px]">
                  <span className="min-w-0 truncate text-soft" title={k}>
                    {k}
                    {NEW_EVENTS.includes(k) && <span className="ml-2 text-[11px] text-faint">new</span>}
                  </span>
                  <span className="tnum shrink-0 text-foreground">{n(v)}</span>
                </div>
                <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-surface-2" aria-hidden>
                  <div className={`h-full rounded-full ${/_failed$/.test(k) ? "bg-danger" : "bg-foreground/70"}`} style={{ width: `${Math.max((v / max) * 100, 2)}%` }} />
                </div>
              </li>
            ))}
          </ul>
        )}
        <Note>
          {isMain
            ? "Events from mainnet only, counted for visitors who accepted analytics. Every event has carried its network since mainnet opened on 21 Oct 2026; per-day and per-field counts are split from that evening."
            : "Events from the testnets, counted for visitors who accepted analytics. Events from before networks were tagged (21 Oct 2026) count here."}
        </Note>
      </Panel>

      <Panel title="Breakdowns" sub="Kinds, networks and yes or no fields only. Events never carry amounts, names, addresses, labels, notes or proofs.">
        <DataTable
          headers={["Event", "Field", "Value", "Count"]}
          rows={breakdowns.flatMap((g) => g.list.map((r) => [g.event, r.field, dimValue(r.field, r.value), n(r.v)]))}
          empty="No breakdowns yet. They fill in as new events arrive."
          dense
        />
      </Panel>

      <Panel title="Event stream" sub="The latest events, newest first">
        <DataTable
          headers={["Event", "Path", "Details", "Time"]}
          rows={prod.recent.map((ev) => [ev.t, ev.path ?? "None", metaText(ev.meta), new Date(ev.ts).toLocaleString()])}
          empty={isMain ? "No mainnet events among the latest ones" : "No testnet events among the latest ones"}
          dense
        />
      </Panel>

      {backend === "memory" && (
        <p className="text-[14px] text-mute">
          Backend is memory. Set Upstash <code className="rounded-md bg-surface px-1.5 py-0.5 text-foreground">UPSTASH_REDIS_REST_*</code> and redeploy for durable counts.
        </p>
      )}
    </>
  );
}
