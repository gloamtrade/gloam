/**
 * Incidents on the status page (status.gloam.trade). A plain list, kept by
 * hand: add one when something breaks, add an update as it moves, and set
 * `resolvedAt` when it is over. Newest first. Times are UTC, ISO 8601
 * ("2026-11-19T14:05:00Z").
 *
 * `parts` names the part ids the page lists (lib/status/checks statusParts):
 * "network:<chain id>", "vaults", "relay", "bridge", "api", "mcp", "database".
 * An incident with no `resolvedAt` shows at the top and sets the banner, with
 * its impact, if the live checks say less.
 *
 * Say what people notice and what to do, plainly. Never guess a cause, never
 * promise a time, and never post an incident that did not happen.
 */
import type { Health } from "./model";

export type IncidentState = "investigating" | "identified" | "monitoring" | "resolved";

export interface IncidentUpdate {
  at: string;
  state: IncidentState;
  text: string;
}

export interface Incident {
  id: string;
  title: string;
  impact: Exclude<Health, "operational">;
  parts: string[];
  startedAt: string;
  resolvedAt: string | null;
  /** Newest first. */
  updates: IncidentUpdate[];
}

export const INCIDENTS: Incident[] = [];

export const STATE_LABEL: Record<IncidentState, string> = {
  investigating: "Investigating",
  identified: "Identified",
  monitoring: "Monitoring",
  resolved: "Resolved",
};

/** Incidents still open. */
export function ongoingIncidents(list: Incident[] = INCIDENTS): Incident[] {
  return list.filter((i) => !i.resolvedAt);
}

/** Resolved incidents that started in the last `days` days, newest first. */
export function pastIncidents(nowMs: number, days = 90, list: Incident[] = INCIDENTS): Incident[] {
  const since = nowMs - days * 86_400_000;
  return list
    .filter((i) => i.resolvedAt && Date.parse(i.startedAt) >= since)
    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
}
