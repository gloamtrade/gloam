/**
 * What the status page and /api/status show: the cron's latest run (every 5
 * minutes, lib/status/history), read from the store, never older than
 * STALE_MS. If it is older, missing, or lists other parts than the page does
 * now (a network switched on since), the checks run here once, are kept as
 * the latest, and are shared by every request on this instance for a minute,
 * so visitors never drive the RPCs. Server only.
 *
 * The page used to be a cached (ISR) render that only rebuilt when someone
 * visited, so the first visit after a quiet spell showed hours-old checks.
 * Rendered per request from the store, it is as fresh as the last run.
 */
import "server-only";
import { runStatusChecks, statusParts } from "./checks";
import { readHistory, readLatest, saveLatest, type History } from "./history";
import type { StatusSnapshot } from "./model";

/** The cron runs every 5 minutes; past this its run is too old to show. */
export const STALE_MS = 7 * 60_000;
/** A check made here is shared this long. */
const LIVE_MEMO_MS = 60_000;
/** What the page reads from the store is shared this long per instance. */
const READ_MEMO_MS = 20_000;

let live: { at: number; run: Promise<StatusSnapshot> } | null = null;
let read: { at: number; view: Promise<StatusView> } | null = null;

/** Test hook: forget what this instance holds. */
export function resetStatusMemo(): void {
  live = null;
  read = null;
}

function sameParts(s: StatusSnapshot): boolean {
  const want = statusParts().map((p) => p.id);
  return s.parts.length === want.length && s.parts.every((p, i) => p.id === want[i]);
}

function runHere(now: number): Promise<StatusSnapshot> {
  if (live && now - live.at < LIVE_MEMO_MS) return live.run;
  const run = runStatusChecks().then(async (s) => {
    await saveLatest(s);
    return s;
  });
  live = { at: now, run };
  return run;
}

/** The latest run, at most STALE_MS old. */
export async function currentSnapshot(now = Date.now()): Promise<StatusSnapshot> {
  const latest = await readLatest();
  if (latest && now - latest.checkedAt < STALE_MS && sameParts(latest)) return latest;
  return runHere(now);
}

export interface StatusView {
  snap: StatusSnapshot;
  history: History | null;
}

/** The latest run and the history, read once per READ_MEMO_MS on this instance. */
export function statusView(now = Date.now()): Promise<StatusView> {
  if (read && now - read.at < READ_MEMO_MS) return read.view;
  const view = Promise.all([currentSnapshot(now), readHistory(statusParts().map((p) => p.id), now)]).then(([snap, history]) => ({ snap, history }));
  read = { at: now, view };
  // a failed read is not kept
  view.catch(() => {
    if (read?.view === view) read = null;
  });
  return view;
}
