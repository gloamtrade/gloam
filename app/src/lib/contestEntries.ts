/**
 * Entries to the Gloam Video Contest (gloam.trade/contest). Server only.
 *
 * Stored in the partner program's store (lib/partnersKv: Upstash Redis in
 * production, in-process locally) under their own prefix, like the testers
 * list. One entry per X handle: entering again with the same handle replaces
 * the entry, keeps when it was first sent, and keeps the last few post links
 * it replaced so a changed entry can be traced.
 *
 * An entry holds a name, the X handle, the link to the post on X, an optional
 * link to the full video elsewhere, an optional line on what it shows, an optional email for reaching winners, and the
 * network used. No IP address is kept with it; the rate limit holds a hashed
 * IP for up to two hours.
 */
import { CONTEST_NETWORK_LABEL, type ContestInput } from "./contest";
import { jsonOf, kv } from "./partnersKv";

const PREFIX = "gloam:contest:v1:";
const HANDLES = `${PREFIX}handles`;
const MAX_ENTRIES = 5_000;
const MAX_PREVIOUS = 5;

const entryKey = (handle: string) => `${PREFIX}entry:${handle}`;

export type ContestEntry = ContestInput & {
  submittedAt: number;
  updatedAt: number;
  /** How many times the entry was sent again after the first. */
  revisions: number;
  /** Post links this entry replaced, newest first. */
  previousPosts: string[];
};

/** The entry list is full; nothing was saved. */
export class ContestFullError extends Error {
  constructor() {
    super("The contest can't take more entries right now.");
    this.name = "ContestFullError";
  }
}

async function readEntry(handle: string): Promise<ContestEntry | null> {
  const [raw] = await kv([["GET", entryKey(handle)]]);
  return jsonOf<ContestEntry>(raw);
}

/** Saves an entry. The same handle again replaces it; `updated` says so. */
export async function saveContestEntry(input: ContestInput, now = Date.now()): Promise<{ entry: ContestEntry; updated: boolean }> {
  const earlier = await readEntry(input.handle);
  if (!earlier) {
    const [count] = await kv([["SCARD", HANDLES]]);
    if (Number(count) >= MAX_ENTRIES) throw new ContestFullError();
  }
  const previousPosts = earlier
    ? (earlier.postUrl !== input.postUrl ? [earlier.postUrl, ...(earlier.previousPosts ?? [])] : (earlier.previousPosts ?? [])).slice(0, MAX_PREVIOUS)
    : [];
  const entry: ContestEntry = {
    ...input,
    submittedAt: earlier?.submittedAt ?? now,
    updatedAt: now,
    revisions: earlier ? (earlier.revisions ?? 0) + 1 : 0,
    previousPosts,
  };
  await kv([
    ["SET", entryKey(input.handle), JSON.stringify(entry)],
    ["SADD", HANDLES, input.handle],
  ]);
  return { entry, updated: earlier !== null };
}

/** Every entry, newest first (by when it was last sent). */
export async function listContestEntries(): Promise<ContestEntry[]> {
  const [handles] = await kv([["SMEMBERS", HANDLES]]);
  if (!Array.isArray(handles) || handles.length === 0) return [];
  const raws = await kv(handles.map((h) => ["GET", entryKey(String(h))]));
  return raws
    .map((r) => jsonOf<ContestEntry>(r))
    .filter((e): e is ContestEntry => e !== null)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/** The post's account isn't the handle that entered it. */
export function postUserDiffers(e: Pick<ContestEntry, "handle" | "postUser">): boolean {
  return e.postUser.toLowerCase() !== e.handle.toLowerCase();
}

const utc = (ms: number) => new Date(ms).toISOString().replace("T", " ").slice(0, 16);

/** A spreadsheet of entries. Cells that start like a formula are quoted as text. */
export function contestCsv(entries: ContestEntry[]): string {
  const cell = (v: string | number | null) => {
    let s = v === null ? "" : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return `"${s.replace(/"/g, '""')}"`;
  };
  const header = [
    "Submitted (UTC)",
    "Updated (UTC)",
    "Name",
    "X handle",
    "Video post",
    "Post account differs",
    "Full video link",
    "Network",
    "What it shows",
    "Email",
    "Times updated",
    "Earlier posts",
  ];
  const rows = entries.map((e) =>
    [
      utc(e.submittedAt),
      utc(e.updatedAt),
      e.name,
      e.handle,
      e.postUrl,
      postUserDiffers(e) ? `Yes (@${e.postUser})` : "No",
      e.videoUrl ?? null,
      CONTEST_NETWORK_LABEL[e.network] ?? e.network,
      e.note,
      e.email,
      e.revisions ?? 0,
      (e.previousPosts ?? []).join(" "),
    ].map(cell),
  );
  return [header.map(cell), ...rows].map((r) => r.join(",")).join("\r\n") + "\r\n";
}
