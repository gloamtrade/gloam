import { NextResponse } from "next/server";
import { clientIp, hitRateLimit } from "@/lib/mcpRemote/rateLimit";
import { KvUnavailableError } from "@/lib/partnersKv";
import { NEWER_KEY, VERSION1_SAVES_UNTIL } from "@/lib/recoveryEnd";
import {
  BACKUP_GONE,
  RecoveryError,
  VERSION1_ENDED,
  backupExists,
  backupInputProblem,
  deleteBackup,
  isHex64,
  readBackup,
  recoveryNow,
  writeBackup,
} from "@/lib/recoveryStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Reads and deletes per IP per minute. */
const RATE_LIMIT = 60;
/**
 * Saves to one backup that already exists, per minute. Saving to your own
 * backup is never held to a per-connection or daily limit (a backup that
 * stops saving can cost someone their money); this only stops one id being
 * rewritten in a loop.
 */
const SAVES_PER_BACKUP_PER_MIN = 60;
/**
 * New backups per connection (an IPv4 address, or an IPv6 /48) per UTC day.
 * A person makes one per sign-in method. Backups never expire, so this and
 * the daily budget below are what keep the store from being filled. IPv6
 * counts by /48 here, not the usual /64: /64s come cheap and in bulk, and
 * each one would otherwise get its own share of the budget everyone relies on.
 */
const NEW_BACKUPS_PER_DAY = 5;
const NEW_BACKUPS_V6_BITS = 48;
/** New backups a UTC day across everyone, unless GLOAM_RECOVERY_NEW_PER_DAY says otherwise. */
const NEW_BACKUPS_ALL_PER_DAY = 300;
const MAX_BODY = 600_000;

const BUDGET_FULL = "New backups are paused for today. Try again later. A backup you already have keeps saving.";

function newBackupsBudget(): number {
  const v = Number(process.env.GLOAM_RECOVERY_NEW_PER_DAY?.trim());
  return Number.isSafeInteger(v) && v > 0 ? v : NEW_BACKUPS_ALL_PER_DAY;
}

/** The UTC day the budget was last logged as spent, so it is logged once a day (per instance). */
let budgetLoggedFor: string | null = null;

function fail(status: number, message: string, headers?: HeadersInit) {
  return NextResponse.json({ ok: false, error: { message } }, { status, headers: { "Cache-Control": "no-store", ...headers } });
}

function ok(data: unknown) {
  return NextResponse.json({ ok: true, data }, { headers: { "Cache-Control": "no-store" } });
}

async function limited(req: Request) {
  const rate = await hitRateLimit(clientIp(req), "recovery", RATE_LIMIT);
  return rate.allowed ? null : fail(429, "Too many tries. Wait a minute.", { "Retry-After": String(rate.retryAfterSec) });
}

function handle(e: unknown) {
  if (e instanceof RecoveryError) return fail(e.status, e.message);
  if (e instanceof KvUnavailableError) return fail(503, "Backups are paused for a moment. Try again shortly.");
  return fail(500, "The backup service failed. Try again.");
}

async function readBody(req: Request): Promise<Record<string, unknown> | null> {
  const raw = await req.text();
  if (raw.length > MAX_BODY) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Fetch an encrypted backup by its id. The ciphertext is useless without the key. */
export async function GET(req: Request) {
  const blocked = await limited(req);
  if (blocked) return blocked;
  const id = new URL(req.url).searchParams.get("id");
  if (!isHex64(id)) return fail(400, "Bad backup id.");
  try {
    const backup = await readBackup(id);
    if (!backup) return fail(404, "No backup found.");
    return ok(backup);
  } catch (e) {
    return handle(e);
  }
}

/**
 * Save or replace an encrypted backup. A save to one that exists always goes
 * through (its write token is checked by the store). A new one counts against
 * its connection and the day's budget, and only once it is a valid backup.
 * `mustExist` means this save must not make a new one: with nothing there it is
 * a 410, nothing is written, and neither count is touched.
 *
 * A save with no `v: 2` counts as version 1, or a tab on an earlier build. It is
 * held to `mustExist` always, and from VERSION1_SAVES_UNTIL on the server's clock
 * it is a 410 before the store is touched, so nothing is read, written or counted.
 * This goes by the request and never the record: backups saved before the marker
 * have none, and a save with `v: 2` works on them at any date. The marker is only
 * what the browser says about its key.
 */
export async function PUT(req: Request) {
  const body = await readBody(req);
  if (!body) return fail(400, "Bad request.");
  const { id, write, c, n, mustExist, v } = body;
  if (!isHex64(id) || !isHex64(write)) return fail(400, "Bad backup id.");
  const problem = backupInputProblem({ c, n });
  if (problem) return fail(400, problem);
  const newerKey = v === NEWER_KEY;
  const now = recoveryNow();
  if (!newerKey && now >= VERSION1_SAVES_UNTIL) return fail(410, VERSION1_ENDED);
  const existingOnly = mustExist === true || !newerKey;
  try {
    if (await backupExists(id)) {
      const saves = await hitRateLimit(id, "recovery-save", SAVES_PER_BACKUP_PER_MIN, now);
      if (!saves.allowed) return fail(429, "Too many saves in a minute. Wait a moment.", { "Retry-After": String(saves.retryAfterSec) });
    } else if (existingOnly) {
      return (await limited(req)) ?? fail(410, BACKUP_GONE);
    } else {
      const mine = await hitRateLimit(clientIp(req), "recovery-new", NEW_BACKUPS_PER_DAY, now, 86_400, { v6Bits: NEW_BACKUPS_V6_BITS });
      if (!mine.allowed) {
        return fail(429, "Too many new backups from this connection today. Try again tomorrow.", {
          "Retry-After": String(mine.retryAfterSec),
        });
      }
      const budget = newBackupsBudget();
      const all = await hitRateLimit("all", "recovery-new-all", budget, now, 86_400);
      if (!all.allowed) {
        const day = new Date(now).toISOString().slice(0, 10);
        if (budgetLoggedFor !== day) {
          budgetLoggedFor = day;
          console.warn("gloam_recovery_new_budget_full", JSON.stringify({ day, budget }));
        }
        return fail(429, BUDGET_FULL, { "Retry-After": String(all.retryAfterSec) });
      }
    }
    return ok(await writeBackup({ id, write, c: c as string, n: Number(n), mustExist: existingOnly, ...(newerKey ? { v: NEWER_KEY } : {}) }));
  } catch (e) {
    return handle(e);
  }
}

/** Delete an encrypted backup. */
export async function DELETE(req: Request) {
  const blocked = await limited(req);
  if (blocked) return blocked;
  const body = await readBody(req);
  if (!body) return fail(400, "Bad request.");
  const { id, write } = body;
  if (!isHex64(id) || !isHex64(write)) return fail(400, "Bad backup id.");
  try {
    await deleteBackup(id, write);
    return ok({ deleted: true });
  } catch (e) {
    return handle(e);
  }
}
