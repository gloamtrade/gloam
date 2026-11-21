"use client";

import { getNetwork } from "@/lib/networks";
import { GLOAM_NAMES_ADDRESS, NAME_GRACE_SECONDS } from "@/lib/gloamNames";
import type { ClaimedName, NamesSnapshot } from "@/lib/nameStats";
import { useAdminResource } from "../data";
import { fmtWhen, n } from "../format";
import { DataTable, Note, Notice, Panel, PanelSkeleton, StatStrip } from "../ui";

type Row = ClaimedName & { team: boolean };
type NamesData = Omit<NamesSnapshot, "names"> & { names: Row[]; /** Unix seconds the server read the registry. */ readAt: number };

const rh = getNetwork("robinhood-mainnet");
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const gloam = (v: number) => `${v.toLocaleString("en-US", { maximumFractionDigits: 2 })} GLOAM`;
const day = (s: number) => new Date(s * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

/** Every Gloam name claimed so far, newest first, read from the registry on Robinhood Chain. */
export function NamesTab() {
  const res = useAdminResource<NamesData>("/api/admin/names", "Names");
  if (res.err && !res.data) return <Notice tone="danger">{res.err}</Notice>;
  const data = res.data;
  if (!data) return <PanelSkeleton label="Reading the names registry" />;

  const now = data.readAt;
  const live = data.names.filter((x) => x.expires + NAME_GRACE_SECONDS > now);
  const people = live.filter((x) => !x.team && !x.blocked);
  const holders = new Set(people.map((x) => x.holder)).size;
  const newest = [...data.names].sort((a, b) => b.claimedAt - a.claimedAt);
  const last = newest[0];

  return (
    <>
      {res.err && <Notice tone="danger">{res.err}. Showing the last answer.</Notice>}
      <StatStrip
        cols={4}
        items={[
          { label: "Names claimed", value: n(people.length), sub: live.length > people.length ? `plus ${live.length - people.length} team or blocked` : "live names, not the team's" },
          { label: "Holders", value: n(holders), sub: "different wallets holding them" },
          { label: "$GLOAM to the treasury", value: gloam(data.collectedGloam), sub: `${n(data.registrations)} registrations, with renewals`, tone: "sealed" },
          { label: "Newest", value: last ? `@${last.name}` : "None yet", sub: last ? fmtWhen(last.claimedAt) : "no names yet" },
        ]}
      />
      <Panel title="Every name" sub={`Newest first. Read from the registry at block ${n(data.latestBlock)}. Names and holders are public on chain.`}>
        <DataTable
          headers={["Name", "Holder", "Claimed", "Paid until", "Paid", "Note"]}
          minWidth={760}
          empty="No names claimed yet"
          rows={newest.map((x) => [
            <a key="n" href={rh.explorerTx(x.claimTx)} target="_blank" rel="noreferrer" className="underline decoration-line-strong underline-offset-4 hover:decoration-foreground">
              @{x.name}
            </a>,
            <a key="h" href={rh.explorerAddress(x.holder)} target="_blank" rel="noreferrer" className="hover:text-foreground">
              {short(x.holder)}
            </a>,
            fmtWhen(x.claimedAt),
            x.expires + NAME_GRACE_SECONDS < now ? "Lapsed" : day(x.expires),
            gloam(x.paidGloam),
            [x.team && "Team", x.blocked && "Blocked in the app", x.renewals > 0 && `Renewed ${x.renewals}x`].filter(Boolean).join(" · ") || "",
          ])}
        />
        <Note>
          Registry {GLOAM_NAMES_ADDRESS ? short(GLOAM_NAMES_ADDRESS) : "not set"} on Robinhood Chain. A blocked name was written to the
          registry directly; the app never pays it. Team rows are wallets on the vote exclusion list, the deployer and the Safe.
        </Note>
      </Panel>
    </>
  );
}
