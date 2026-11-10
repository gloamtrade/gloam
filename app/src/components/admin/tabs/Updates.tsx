"use client";

import { TickDonut } from "../charts";
import { useAdminResource } from "../data";
import { n } from "../format";
import { CsvLink, Note, Notice, Panel, PanelSkeleton, StatStrip } from "../ui";

type UpdatesData = { backend: string; count: number; bySource: { "sign-in": number; settings: number; site: number } };

/**
 * The "Email me Gloam updates" list: how many, from where, and the CSV. The
 * emails themselves are only in the CSV, which holds email, day and source
 * (and each person's unsubscribe link), nothing about wallets.
 */
export function UpdatesTab() {
  const res = useAdminResource<UpdatesData>("/api/updates", "Updates list");
  if (res.err && !res.data) return <Notice tone="danger">{res.err}</Notice>;
  const data = res.data;
  if (!data) return <PanelSkeleton label="Loading the updates list" />;
  const src = data.bySource;
  return (
    <>
      {res.err && <Notice tone="danger">{res.err}. Showing the last answer.</Notice>}
      <StatStrip
        items={[
          { label: "Subscribed", value: n(data.count), sub: "emails on the list" },
          { label: "From sign-in", value: n(src["sign-in"]), sub: "Gloam wallet sign-in" },
          { label: "From Settings", value: n(src.settings), sub: "in the app" },
          { label: "From the site", value: n(src.site), sub: "footer field" },
        ]}
      />
      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,320px)_minmax(0,1fr)]">
        <Panel title="Where people joined">
          <TickDonut
            label="Email updates list by where people joined"
            centerLabel="Subscribed"
            total={n(data.count)}
            segments={[
              { key: "sign-in", label: "Sign-in", value: src["sign-in"], display: n(src["sign-in"]) },
              { key: "settings", label: "Settings", value: src.settings, display: n(src.settings) },
              { key: "site", label: "Site", value: src.site, display: n(src.site) },
            ].filter((s) => s.value > 0)}
          />
        </Panel>
        <Panel title="Email updates list" action={<CsvLink href="/api/updates?format=csv">Download CSV</CsvLink>}>
          <p className="text-[14px] leading-relaxed text-soft">
            The CSV has each email, the day it joined and where, plus its unsubscribe link for the bottom of an update.
          </p>
          <Note>Emails are kept alone: no wallet, address or IP is stored with them. Store: {data.backend}.</Note>
        </Panel>
      </div>
    </>
  );
}
