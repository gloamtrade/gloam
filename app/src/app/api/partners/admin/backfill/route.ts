import type { NextRequest } from "next/server";
import { isAdminAuthenticated } from "@/lib/adminAuth";
import { ApiError, jsonBody, portal } from "@/lib/partnersApi";
import { sameSiteJson } from "@/lib/partnersAuth";
import { addressBook } from "@/lib/partnerAddresses";
import { bookFingerprint, runBackfill } from "@/lib/partnerBackfill";
import { k, kv, kv1 } from "@/lib/partnersKv";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** A pass stops starting new spans after this; the next one picks up where it stopped. */
const BUDGET_MS = 40_000;
/** A real pass needs a dry run of the same proven addresses within this long. */
const DRY_RUN_GOOD_SEC = 24 * 3600;

/**
 * Admin only, POST { dryRun, from: "deploy" | "cursor" }: one pass of the
 * on-chain match (lib/partnerBackfill) over every mainnet, for every partner's
 * proven receiving addresses. Read-only on chain. A dry run counts nothing, moves
 * no cursor, and shows what it found per address; a real pass is refused until a
 * dry run of the same addresses ran in the last day. One pass at a time.
 */
export async function POST(req: NextRequest) {
  return portal(async () => {
    if (!sameSiteJson(req)) throw new ApiError(403, "bad_origin", "Run this from the Gloam site.");
    if (!(await isAdminAuthenticated())) throw new ApiError(401, "unauthorized", "Admin session required.");
    const body = await jsonBody(req, 256);
    if (typeof body.dryRun !== "boolean") throw new ApiError(400, "bad_request", "Send { dryRun: true | false, from }.");
    const from = body.from === "deploy" ? "deploy" : body.from === "cursor" ? "cursor" : null;
    if (!from) throw new ApiError(400, "bad_request", 'from must be "deploy" or "cursor".');
    const book = await addressBook();
    const print = bookFingerprint(book);
    if (!body.dryRun && !(await kv1(["GET", k("backfill", "dry", print)]))) {
      throw new ApiError(409, "dry_run_first", "Run a dry run of these addresses first, and check what it found per address.");
    }
    const lockKey = k("backfill", "running");
    const [got] = await kv([["SET", lockKey, String(Date.now()), "NX", "EX", 90]]);
    if (got !== "OK") throw new ApiError(409, "busy", "A pass is already running. Wait for it to finish.");
    try {
      const result = await runBackfill({ dryRun: body.dryRun, from, book, budgetMs: BUDGET_MS });
      if (body.dryRun) await kv1(["SET", k("backfill", "dry", print), String(Date.now()), "EX", DRY_RUN_GOOD_SEC]);
      return { data: result };
    } finally {
      await kv1(["DEL", lockKey]).catch(() => undefined);
    }
  });
}
