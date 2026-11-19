import type { Metadata } from "next";
import { Logo } from "@/components/Logo";
import { ThemeToggle } from "@/components/ThemeToggle";
import { statusView } from "@/lib/status/current";
import { INCIDENTS, STATE_LABEL, ongoingIncidents, pastIncidents, type Incident } from "@/lib/status/incidents";
import {
  GROUPS,
  HEALTH_LABEL,
  dayTone,
  dayUptime,
  formatLatency,
  formatPercent,
  formatPeriod,
  formatUtc,
  overallTitle,
  rangeUptime,
  sinceText,
  worst,
  type DayTally,
  type Health,
  type PartCheck,
} from "@/lib/status/model";
import { AutoRefresh } from "./AutoRefresh";
import { CheckedAgo } from "./CheckedAgo";
import { UptimeBars, type BarDay } from "./UptimeBars";
import css from "./status.module.css";

/**
 * status.gloam.trade (next.config rewrites its root here; /status on www).
 * Rendered per request from the cron's latest run and history in the store
 * (lib/status/current), so it is never older than the last run, and the open
 * tab fetches it again every minute. Incidents are kept by hand
 * (lib/status/incidents). Each part is a card in its group's grid, money first
 * and the site last; its bars start at its first check.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const DESCRIPTION =
  "Live status of Gloam: the relay, each network and vault, the bridge and API, integrations and the site, with their history.";

export const metadata: Metadata = {
  title: "Status",
  description: DESCRIPTION,
  alternates: { canonical: "https://status.gloam.trade" },
  openGraph: { title: "Gloam status", description: DESCRIPTION, url: "https://status.gloam.trade", siteName: "Gloam", type: "website" },
};

const SITE = "https://www.gloam.trade";

const TONE_BG: Record<Health, string> = {
  operational: "bg-sealed",
  degraded: "bg-warn",
  down: "bg-danger",
};

function barDays(tallies: DayTally[]): BarDay[] {
  return tallies.map((t) => {
    const up = dayUptime(t);
    return {
      day: t.day,
      label: formatPeriod(t.day),
      tone: dayTone(t),
      uptime: up === null ? null : formatPercent(up),
      down: t.down,
      degraded: t.degraded,
    };
  });
}

function PartCard({ part, tallies }: { part: PartCheck; tallies: DayTally[] }) {
  const uptime = rangeUptime(tallies);
  return (
    <li className={css.card}>
      <div className="flex items-start justify-between gap-3">
        <h3 className="flex min-w-0 items-start gap-2.5 text-[15px] font-medium leading-snug">
          <span className={`mt-[7px] h-2 w-2 shrink-0 rounded-full ${TONE_BG[part.status]}`} aria-hidden />
          <span className="min-w-0">
            {part.name}
            <span className="sr-only">: {HEALTH_LABEL[part.status]}</span>
          </span>
        </h3>
        {part.latencyMs !== null ? (
          <span className="tnum shrink-0 pt-px text-[13px] text-mute">{formatLatency(part.latencyMs)}</span>
        ) : null}
      </div>
      {part.reason ? <p className="mt-1.5 text-[13px] leading-snug text-soft">{part.reason}</p> : null}
      <div className="mt-auto pt-5">
        {tallies.length ? (
          <UptimeBars name={part.name} days={barDays(tallies)} />
        ) : (
          <p className="text-[12px] text-mute">No data yet</p>
        )}
      </div>
      {tallies.length ? (
        <p className="tnum mt-2 flex justify-between gap-3 text-[12px] text-mute">
          <span>{sinceText(tallies[0]!.day)}</span>
          <span>{uptime === null ? "" : formatPercent(uptime)}</span>
        </p>
      ) : null}
    </li>
  );
}

function IncidentCard({ incident, names }: { incident: Incident; names: Map<string, string> }) {
  const affected = incident.parts.map((id) => names.get(id)).filter(Boolean).join(", ");
  const when = incident.resolvedAt
    ? `${formatUtc(Date.parse(incident.startedAt))} to ${formatUtc(Date.parse(incident.resolvedAt))}`
    : `Since ${formatUtc(Date.parse(incident.startedAt))}`;
  return (
    <article className="min-w-0">
      <h3 className="text-[16px] font-medium leading-snug">
        <span className={`mr-2.5 inline-block h-2 w-2 translate-y-[-2px] rounded-full ${TONE_BG[incident.impact]}`} aria-hidden />
        {incident.title}
      </h3>
      <p className="mt-1 text-[13px] text-mute">
        {when}
        {affected ? ` · ${affected}` : ""}
      </p>
      <ol className="mt-3 space-y-2 text-[14px] leading-relaxed text-soft">
        {incident.updates.map((u) => (
          <li key={`${u.at}-${u.state}`}>
            <span className="font-medium text-foreground">{STATE_LABEL[u.state]}.</span> {u.text}{" "}
            <time className="text-mute" dateTime={u.at}>
              {formatUtc(Date.parse(u.at))}
            </time>
          </li>
        ))}
      </ol>
    </article>
  );
}

/** "Base", "Base and Tempo", "Base, Tempo and 3 more". */
function affectedText(names: string[]): string {
  if (names.length <= 3) return names.length === 3 ? `${names[0]}, ${names[1]} and ${names[2]}` : names.join(" and ");
  return `${names[0]}, ${names[1]} and ${names.length - 2} more`;
}

export default async function StatusPage() {
  const { snap, history } = await statusView();
  const ongoing = ongoingIncidents(INCIDENTS);
  const past = pastIncidents(snap.checkedAt, 90, INCIDENTS);
  const overall = worst([snap.overall, ...ongoing.map((i) => i.impact)]);
  const affected = snap.parts.filter((p) => p.status !== "operational").map((p) => p.name);
  const names = new Map(snap.parts.map((p) => [p.id, p.name]));

  return (
    <div className="min-h-screen bg-background text-foreground">
      <AutoRefresh />
      {/* status.gloam.trade shows this page at "/", where the site's announcement would show too */}
      <style>{"[data-announcement]{display:none}"}</style>
      <header className="mx-auto flex max-w-[1400px] items-center justify-between gap-4 px-4 py-5 sm:px-7">
        <div className="flex items-center gap-3">
          <Logo href={SITE} />
          <span className="text-[19px] leading-none text-mute">Status</span>
        </div>
        <div className="flex items-center gap-2">
          <ThemeToggle className="h-10 w-10" />
          <a href={SITE} className="gl-arrowlink min-h-10 text-[14px]">
            Open Gloam <span aria-hidden>→</span>
          </a>
        </div>
      </header>

      <main className="mx-auto max-w-[1400px] px-4 pb-20 sm:px-7">
        <section aria-labelledby="overall" className="pt-6 sm:pt-12">
          <div className="rounded-[18px] border border-line bg-panel px-5 py-6 shadow-card sm:px-8 sm:py-8">
            <h1 id="overall" className="t-display-m flex items-start gap-4">
              {/* centred on the title's first line, whatever its size */}
              <span className={`mt-[calc(0.55em-6px)] h-3 w-3 shrink-0 rounded-full ${TONE_BG[overall]}`} aria-hidden />
              <span className="min-w-0">{overallTitle(overall)}</span>
            </h1>
            <p className="mt-2 pl-7 text-[14px] text-mute">
              <CheckedAgo at={snap.checkedAt} />
              {affected.length ? <span className="text-soft"> · {affectedText(affected)}</span> : null}
            </p>
          </div>
        </section>

        {ongoing.length ? (
          <section aria-labelledby="ongoing" className="mt-6 rounded-[18px] border border-line-strong px-5 py-6 sm:px-8">
            <h2 id="ongoing" className="sr-only">
              Ongoing incidents
            </h2>
            <div className="space-y-8">
              {ongoing.map((i) => (
                <IncidentCard key={i.id} incident={i} names={names} />
              ))}
            </div>
          </section>
        ) : null}

        <div className="mt-12 flex flex-wrap items-center justify-between gap-x-6 gap-y-3 text-[13px] text-mute sm:mt-16">
          <p>
            {history === null ? "History is not available right now." : history.since ? sinceText(history.since) : "No history yet"}
          </p>
          <ul className="flex flex-wrap items-center gap-x-4 gap-y-2" aria-label="Legend">
            {(
              [
                ["ok", "Operational"],
                ["degraded", "Degraded"],
                ["down", "Down"],
                ["none", "No data"],
              ] as const
            ).map(([tone, label]) => (
              <li key={tone} className="flex items-center gap-2">
                <span className={css.swatch} data-tone={tone} aria-hidden />
                {label}
              </li>
            ))}
          </ul>
        </div>

        {GROUPS.map((g) => {
          const cards = snap.parts.filter((p) => p.group === g.id);
          if (!cards.length) return null;
          return (
            <section key={g.id} aria-labelledby={`group-${g.id}`} className="mt-10 sm:mt-12">
              <h2 id={`group-${g.id}`} className="t-title">
                {g.name}
              </h2>
              <ul className={`mt-4 ${css.grid}`}>
                {cards.map((p) => (
                  <PartCard key={p.id} part={p} tallies={history?.byPart.get(p.id) ?? []} />
                ))}
              </ul>
              {g.id === "integrations" ? (
                <p className="mt-4 text-[13px] text-mute">
                  On npm:{" "}
                  {snap.packages.map((pkg, i) => (
                    <span key={pkg.name}>
                      {i ? " · " : ""}
                      <span className="text-soft">{pkg.name}</span> <span className="tnum">{pkg.version ?? "not read"}</span>
                    </span>
                  ))}
                </p>
              ) : null}
            </section>
          );
        })}

        <section aria-labelledby="incidents" className="mt-14 border-t border-line pt-8 sm:mt-16">
          <h2 id="incidents" className="t-title">
            Incidents
          </h2>
          {past.length ? (
            <div className="mt-4 min-w-0 space-y-10">
              {past.map((i) => (
                <IncidentCard key={i.id} incident={i} names={names} />
              ))}
            </div>
          ) : (
            <p className="mt-4 text-[15px] text-mute">No incidents reported in the last 90 days.</p>
          )}
        </section>

        <footer className="mt-16 flex flex-wrap items-center justify-between gap-x-6 gap-y-3 border-t border-line pt-6 text-[13px] text-mute">
          <p>Checked every 5 minutes. Times in UTC.</p>
          <div className="flex items-center gap-5">
            <a href="/api/status" className="inline-flex min-h-10 items-center underline decoration-line-strong underline-offset-4 hover:text-foreground">
              JSON
            </a>
            <a href={SITE} className="inline-flex min-h-10 items-center underline decoration-line-strong underline-offset-4 hover:text-foreground">
              gloam.trade
            </a>
          </div>
        </footer>
      </main>
    </div>
  );
}
