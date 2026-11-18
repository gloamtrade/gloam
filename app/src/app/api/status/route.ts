import { NextResponse } from "next/server";
import { runStatusChecks } from "@/lib/status/checks";
import { ongoingIncidents } from "@/lib/status/incidents";
import { worst } from "@/lib/status/model";

/**
 * Gloam's current status, as JSON (the page at status.gloam.trade shows the
 * same checks, with 90 days of history). Public, no key.
 *
 * Static between regenerations: the checks run at most once a minute, never
 * per visitor. Every fetch inside them is no-store, so a regeneration always
 * asks the networks and services afresh.
 */
export const dynamic = "force-static";
export const revalidate = 60;
export const maxDuration = 30;

export async function GET() {
  const s = await runStatusChecks();
  const ongoing = ongoingIncidents();
  const overall = worst([s.overall, ...ongoing.map((i) => i.impact)]);
  return NextResponse.json(
    {
      ok: true,
      data: {
        overall,
        checkedAt: new Date(s.checkedAt).toISOString(),
        parts: s.parts.map((p) => ({
          id: p.id,
          name: p.name,
          group: p.group,
          ...(p.chainId !== undefined ? { chainId: p.chainId } : {}),
          ...(p.note ? { note: p.note } : {}),
          status: p.status,
          latencyMs: p.latencyMs,
          reason: p.reason,
          detail: p.detail,
        })),
        packages: s.packages,
        incidents: ongoing.map((i) => ({
          id: i.id,
          title: i.title,
          impact: i.impact,
          parts: i.parts,
          startedAt: i.startedAt,
          update: i.updates[0] ?? null,
        })),
        page: "https://status.gloam.trade",
      },
    },
    { headers: { "Access-Control-Allow-Origin": "*" } }
  );
}
