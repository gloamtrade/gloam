import { NextResponse } from "next/server";
import { currentSnapshot } from "@/lib/status/current";
import { ongoingIncidents } from "@/lib/status/incidents";
import { worst } from "@/lib/status/model";

/**
 * Gloam's current status, as JSON (the page at status.gloam.trade shows the
 * same checks, with their history). Public, no key.
 *
 * The cron's latest run, at most a few minutes old (lib/status/current). The
 * CDN keeps an answer for 30 seconds, so visitors never drive the checks.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET() {
  const s = await currentSnapshot();
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
    { headers: { "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=0, s-maxage=30, stale-while-revalidate=30" } }
  );
}
