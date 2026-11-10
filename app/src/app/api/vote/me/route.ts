import { NextResponse } from "next/server";
import { getAddress, isAddress } from "viem";
import { clientIp, hitRateLimit } from "@/lib/mcpRemote/rateLimit";
import { KvUnavailableError } from "@/lib/partnersKv";
import { eligibleNow } from "@/lib/vote/chainReads";
import { eligibleTotal, weightingOf } from "@/lib/vote/core";
import { ensNameOf } from "@/lib/vote/ens";
import { excludedForVote, snapshotFor, visibleVotes } from "@/lib/vote/registry";
import { BalanceUnavailableError, finalFor, voterStanding, type VoterStanding } from "@/lib/vote/results";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const READS_PER_MINUTE = 60;
/** { "address": "0x…" } fits in far less. */
const MAX_BODY = 256;

function fail(status: number, code: string, message: string, headers?: HeadersInit) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status, headers: { "Cache-Control": "no-store", ...headers } });
}

/**
 * The wallet goes in a POST body, never in the URL, where access logs would
 * keep it next to the IP. Nothing outside the app asked this way.
 */
export function GET() {
  return fail(405, "method_not_allowed", "Send { address } in the body of a POST.", { Allow: "POST" });
}

/**
 * POST { address }: one wallet across every vote the site shows: its ENS name
 * (when it has one), and per vote its weight, why it is excluded, its vote so
 * far, and the eligible total its share is worked out against. For a
 * close-weighted vote the weight is the wallet's $GLOAM now (at the closing
 * block once counted), and `eligibleWallets` is 0 until the final count is in.
 */
export async function POST(req: Request) {
  const rate = await hitRateLimit(clientIp(req), "vote-me", READS_PER_MINUTE);
  if (!rate.allowed) return fail(429, "rate_limited", "Too many requests. Wait a minute.", { "Retry-After": String(rate.retryAfterSec) });
  const text = await req.text().catch(() => "");
  if (text.length > MAX_BODY) return fail(413, "too_large", "Send only { address }.");
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return fail(400, "bad_body", "Send { address } as JSON.");
  }
  const raw = body && typeof body === "object" && !Array.isArray(body) ? (body as { address?: unknown }).address : undefined;
  if (typeof raw !== "string" || !isAddress(raw.trim(), { strict: false })) return fail(400, "bad_address", "That wallet address doesn't look right.");
  const address = getAddress(raw.trim());
  try {
    const [name, votes] = await Promise.all([
      ensNameOf(address),
      Promise.all(
        visibleVotes().map(async (v) => {
          const snapshot = snapshotFor(v);
          const excluded = excludedForVote(v);
          if (weightingOf(v) === "close") {
            const [standing, final, live] = await Promise.all([voterStanding(v, snapshot, excluded, address), finalFor(v, snapshot, excluded), eligibleNow(excluded)]);
            const eligibleWeight = final ? final.eligible.weight : (live ?? 0n).toString();
            return [v.id, { ...standing, eligibleWeight, eligibleWallets: final ? final.eligible.wallets : 0 }] as const;
          }
          if (!snapshot) return [v.id, null] as const;
          const standing: VoterStanding = await voterStanding(v, snapshot, excluded, address);
          const eligible = eligibleTotal(snapshot, excluded);
          return [v.id, { ...standing, eligibleWeight: eligible.weight.toString(), eligibleWallets: eligible.wallets }] as const;
        }),
      ),
    ]);
    return NextResponse.json({ ok: true, data: { address, name, votes: Object.fromEntries(votes) } }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    if (e instanceof KvUnavailableError) return fail(503, "storage", "Your votes can't be read for a moment. Try again shortly.");
    if (e instanceof BalanceUnavailableError) return fail(503, "balance", "Your $GLOAM can't be read for a moment. Try again shortly.");
    return fail(500, "error", "Something went wrong reading your votes.");
  }
}
