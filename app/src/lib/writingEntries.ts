/**
 * Entries to the Gloam Writing Contest (gloam.trade/contest/writers). Server only.
 *
 * Stored like the video contest (lib/contestEntries) under their own prefix.
 * One entry per X handle: entering again with the same handle replaces the
 * entry, keeps when it was first sent, and keeps the last few post links it
 * replaced. No IP address is kept with it; the rate limit holds a hashed IP
 * for up to two hours.
 */
import { WRITING_KIND_LABEL, type WritingInput } from "./writingContest";
import { jsonOf, kv } from "./partnersKv";

const PREFIX = "gloam:writing:v1:";
const HANDLES = `${PREFIX}handles`;
const MAX_ENTRIES = 5_000;
const MAX_PREVIOUS = 5;

const entryKey = (handle: string) => `${PREFIX}entry:${handle}`;

export type WritingEntry = WritingInput & {
  submittedAt: number;
  updatedAt: number;
  /** How many times the entry was sent again after the first. */
  revisions: number;
  /** Post links this entry replaced, newest first. */
  previousPosts: string[];
  /** When the entrant last agreed Gloam may share and quote the writing, with credit. */
  marketingConsentAt: number;
};

/** The entry list is full; nothing was saved. */
export class WritingFullError extends Error {
  constructor() {
    super("The contest can't take more entries right now.");
    this.name = "WritingFullError";
  }
}

/** Saves an entry. The same handle again replaces it; `updated` says so. */
export async function saveWritingEntry(input: WritingInput, now = Date.now()): Promise<{ entry: WritingEntry; updated: boolean }> {
  const [raw] = await kv([["GET", entryKey(input.handle)]]);
  const earlier = jsonOf<WritingEntry>(raw);
  if (!earlier) {
    const [count] = await kv([["SCARD", HANDLES]]);
    if (Number(count) >= MAX_ENTRIES) throw new WritingFullError();
  }
  const previous = earlier?.previousPosts ?? [];
  const entry: WritingEntry = {
    ...input,
    submittedAt: earlier?.submittedAt ?? now,
    updatedAt: now,
    revisions: earlier ? (earlier.revisions ?? 0) + 1 : 0,
    previousPosts: (earlier && earlier.postUrl !== input.postUrl ? [earlier.postUrl, ...previous] : previous).slice(0, MAX_PREVIOUS),
    marketingConsentAt: now,
  };
  await kv([
    ["SET", entryKey(input.handle), JSON.stringify(entry)],
    ["SADD", HANDLES, input.handle],
  ]);
  return { entry, updated: earlier !== null };
}

/** Every entry, newest first (by when it was last sent). */
export async function listWritingEntries(): Promise<WritingEntry[]> {
  const [handles] = await kv([["SMEMBERS", HANDLES]]);
  if (!Array.isArray(handles) || handles.length === 0) return [];
  const raws = await kv(handles.map((h) => ["GET", entryKey(String(h))]));
  return raws
    .map((r) => jsonOf<WritingEntry>(r))
    .filter((e): e is WritingEntry => e !== null)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

const utc = (ms: number) => new Date(ms).toISOString().replace("T", " ").slice(0, 16);

/** A spreadsheet of entries. Cells that start like a formula are quoted as text. */
export function writingCsv(entries: WritingEntry[]): string {
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
    "Kind",
    "Title",
    "Post on X",
    "Post account differs",
    "Email",
    "Marketing consent (UTC)",
    "Times updated",
    "Earlier posts",
  ];
  const rows = entries.map((e) =>
    [
      utc(e.submittedAt),
      utc(e.updatedAt),
      e.name,
      e.handle,
      WRITING_KIND_LABEL[e.kind] ?? e.kind,
      e.title,
      e.postUrl,
      e.postUser.toLowerCase() !== e.handle.toLowerCase() ? `Yes (@${e.postUser})` : "No",
      e.email,
      e.marketingConsentAt ? utc(e.marketingConsentAt) : null,
      e.revisions ?? 0,
      (e.previousPosts ?? []).join(" "),
    ].map(cell),
  );
  return [header.map(cell), ...rows].map((r) => r.join(",")).join("\r\n") + "\r\n";
}
