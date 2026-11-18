import type { Metadata } from "next";
import { Logo } from "@/components/Logo";
import { ThemeToggle } from "@/components/ThemeToggle";
import { runStatusChecks, statusParts } from "@/lib/status/checks";
import { readHistory, type History } from "@/lib/status/history";
import { INCIDENTS, STATE_LABEL, ongoingIncidents, pastIncidents, type Incident } from "@/lib/status/incidents";
import {
  GROUPS,
  HEALTH_LABEL,
  dayTone,
  dayUptime,
  formatDay,
  formatLatency,
  formatPercent,
  formatUtc,
  overallTitle,
  rangeUptime,
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
 * The checks run on the server when the page is regenerated, at most once a
 * minute (lib/status/checks); the bars are the cron's 90 days
 * (lib/status/history); incidents are kept by hand (lib/status/incidents).
 * Each part is a card in its group's grid, money first and the site last.
 */
export const dynamic = "force-static";
export const revalidate = 60;
export const maxDuration = 60;

const DESCRIPTION =
  "Live status of Gloam: the site and app, the API, the relay, each network and vault, the bridge and integrations, with 90 days of history.";

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
      label: formatDay(t.day),
      tone: dayTone(t),
      uptime: up === null ? null : formatPercent(up),
      down: t.down,
      degraded: t.degraded,
    };
  });
}

function emptyDays(history: History | null, nowMs: number): DayTally[] {
  if (history) return history.days.map((day) => ({ day, ok: 0, degraded: 0, down: 0 }));
  const today = Date.UTC(new Date(nowMs).getUTCFullYear(), new Date(nowMs).getUTCMonth(), new Date(nowMs).getUTCDate());
  return Array.from({ length: 90 }, (_, i) => ({
    day: new Date(today - (89 - i) * 86_400_000).toISOString().slice(0, 10),
    ok: 0,
    degraded: 0,
    down: 0,
  }));
}

/** "99.98% uptime", or "100% since 19 Nov" while the history is younger than the bars. */
function uptimeText(tallies: DayTally[]): string {
  const uptime = rangeUptime(tallies);
  if (uptime === null) return "No data yet";
  const first = tallies.findIndex((t) => t.ok + t.degraded + t.down > 0);
  if (first <= 0) return `${formatPercent(uptime)} uptime`;
  return `${formatPercent(uptime)} since ${formatDay(tallies[first]!.day).replace(/ \d{4}$/, "")}`;
}

function PartCard({ part, tallies }: { part: PartCheck; tallies: DayTally[] }) {
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
        <UptimeBars name={part.name} days={barDays(tallies)} />
      </div>
      <p className="tnum mt-2 text-right text-[12px] text-mute">{uptimeText(tallies)}</p>
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
  const parts = statusParts();
  const [snap, history] = await Promise.all([runStatusChecks(), readHistory(parts.map((p) => p.id))]);
  const ongoing = ongoingIncidents(INCIDENTS);
  const past = pastIncidents(snap.checkedAt, 90, INCIDENTS);
  const overall = worst([snap.overall, ...ongoing.map((i) => i.impact)]);
  const affected = snap.parts.filter((p) => p.status !== "operational").map((p) => p.name);
  const names = new Map(snap.parts.map((p) => [p.id, p.name]));
  const fallbackDays = emptyDays(history, snap.checkedAt);

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
            Last 90 days
            {history === null ? <span className="text-soft"> · History is not available right now.</span> : null}
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
                  <PartCard key={p.id} part={p} tallies={history?.byPart.get(p.id) ?? fallbackDays} />
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
          <p>Checked every minute. History every 5 minutes. Times in UTC.</p>
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
