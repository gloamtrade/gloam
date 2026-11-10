"use client";

import { useAdminResource } from "../data";
import { n } from "../format";
import { BarChart, Note, Notice, Panel, PanelSkeleton, StatStrip } from "../ui";

type HuntData = {
  backend: string;
  setup: Record<string, boolean>;
  reached: { page: number; riddle: number; glim: number; mcp: number } | null;
  prize: "claimed" | "unclaimed" | "unknown" | "unchecked";
};

const PRIZE_TEXT: Record<HuntData["prize"], [string, string]> = {
  claimed: ["Claimed", "the prize note is spent on chain"],
  unclaimed: ["Not yet", "the prize note is unspent on chain"],
  unknown: ["Unknown", "the chain didn't answer just now"],
  unchecked: ["Not checked", "set HUNT_PRIZE_NULLIFIER to check"],
};

const SETUP: [string, string][] = [
  ["enabled", "Hunt"],
  ["source", "Page source clue"],
  ["page", "Hidden page"],
  ["glim", "Glim passphrase"],
  ["mcp", "MCP key"],
  ["pieces", "Pieces 1 to 3"],
  ["prizeLink", "Prize link"],
  ["prizeCheck", "Prize check (nullifier)"],
];

/** The treasure hunt: how many people reached each step, and whether the prize is claimed. Counts only; the clues stay in the server's settings. */
export function HuntTab() {
  const res = useAdminResource<HuntData>("/api/admin/hunt", "Hunt");
  if (res.err && !res.data) return <Notice tone="danger">{res.err}</Notice>;
  const data = res.data;
  if (!data) return <PanelSkeleton label="Loading the hunt" />;
  const r = data.reached;
  const solved = r ? [r.riddle, r.glim, r.mcp].filter((v) => v > 0).length : 0;
  const [prize, prizeSub] = PRIZE_TEXT[data.prize] ?? PRIZE_TEXT.unknown;
  const steps = r
    ? [
        { k: "Found the hidden page", v: r.page, sub: "piece 1, from the page source" },
        { k: "Solved the riddle", v: r.riddle, sub: "piece 2, on the hidden page" },
        { k: "Asked Glim", v: r.glim, sub: "piece 3, with the passphrase" },
        { k: "Got the prize link", v: r.mcp, sub: "MCP key with pieces 1 to 3" },
      ]
    : [];
  const max = Math.max(1, ...steps.map((s) => s.v));
  return (
    <>
      {res.err && <Notice tone="danger">{res.err}. Showing the last answer.</Notice>}
      <StatStrip
        cols={5}
        items={[
          { label: "Found the hidden page", value: r ? n(r.page) : "None", sub: "from the page source, piece 1" },
          { label: "Solved the riddle", value: r ? n(r.riddle) : "None", sub: "on the hidden page, piece 2" },
          { label: "Asked Glim", value: r ? n(r.glim) : "None", sub: "with the passphrase, piece 3" },
          { label: "Got the prize link", value: r ? n(r.mcp) : "None", sub: "MCP key with pieces 1 to 3" },
          { label: "Prize", value: prize, sub: prizeSub, tone: data.prize === "claimed" ? "sealed" : "default" },
        ]}
      />
      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
        <Panel title="How far people got" sub={r ? `${n(solved)} of 3 clues solved by someone so far` : "No one has started yet"}>
          {r ? <BarChart rows={steps.map((s) => ({ ...s, pct: (s.v / max) * 100 }))} /> : <p className="text-[14px] text-mute">None yet</p>}
          <Note>Counts are distinct people per step, estimated, from a one-way hash: no addresses or accounts are kept.</Note>
        </Panel>
        <Panel title="Setup" sub={`Store: ${data.backend}`}>
          <ul className="divide-y divide-line rounded-[14px] border border-line">
            {SETUP.map(([k, label]) => {
              const on = Boolean(data.setup[k]);
              return (
                <li key={k} className="flex items-center justify-between gap-3 px-4 py-3 text-[14px]">
                  <span className="text-soft">{label}</span>
                  <span className={`inline-flex items-center gap-2 ${on ? "text-foreground" : "text-mute"}`}>
                    <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${on ? "bg-sealed" : "bg-line-strong"}`} />
                    {k === "enabled" ? (on ? "On" : "Off") : on ? "Set" : "Not set"}
                  </span>
                </li>
              );
            })}
          </ul>
          <Note>The home page clue is fixed at build time, so redeploy after changing it.</Note>
        </Panel>
      </div>
    </>
  );
}
