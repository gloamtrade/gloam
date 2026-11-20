/**
 * The Gloam Writing Contest (gloam.trade/contest/writers): prizes, dates and
 * the rules an entry has to pass. No server code here, so the form checks an
 * entry with exactly the rules the server uses (lib/writingEntries,
 * api/contest/writers).
 *
 * Change prizes and dates in WRITING_CONTEST only. The page, the form, the API
 * route, the link preview and Glim all read them from here.
 */
import { CONTEST_LIMITS, HANDLE_RE, bareXHandle, clean, normalizeXPost } from "./contest";
import { normalizeEmail } from "./updatesEmail";

export const WRITING_CONTEST = {
  name: "Gloam Writing Contest",
  path: "/contest/writers",
  /** Prizes in US dollars, by place. The total is their sum. */
  prizes: [150, 100, 100, 100],
  /** Entries open (UTC). */
  opensAt: "2026-11-20T00:00:00Z",
  /** The last moment an entry is taken (UTC). After it the form is closed. */
  closesAt: "2026-11-29T23:00:00Z",
  /** Winners are announced on @gloamtrade by this day (UTC). */
  winnersBy: "2026-12-03T00:00:00Z",
  /** The shortest thread, in posts, and the shortest article, in words. */
  minThreadPosts: 5,
  minArticleWords: 600,
  account: "gloamtrade",
  /** The contest post on X that entries quote. Until it is set, the page points at @gloamtrade. */
  announcementUrl: null as string | null,
  /** The Creators topic in the Telegram community, for questions and drafts. */
  telegramUrl: "https://t.me/gloamhq/28002",
} as const;

/** The prize pool: every place added up. */
export const WRITING_POOL = WRITING_CONTEST.prizes.reduce((a, b) => a + b, 0);

/** Every winner gets the same prize, so places are not ranked by amount. */
export const WRITING_EQUAL_PRIZES = WRITING_CONTEST.prizes.every((usd) => usd === WRITING_CONTEST.prizes[0]);

export function writingClosed(now = Date.now()): boolean {
  return now > Date.parse(WRITING_CONTEST.closesAt);
}

/** How an entry is judged: name, what it means, weight in percent. Quality is 60, engagement 40. */
export const WRITING_JUDGING: [string, string, number][] = [
  ["Accuracy", "Gets Gloam right. No invented features, no price talk.", 25],
  ["Clarity", "A reader who has never heard of Gloam understands what it does and why privacy matters.", 20],
  ["Originality", "Your own angle and your own words, not a rewrite of our docs.", 15],
  ["Engagement", "Replies, reposts and quotes from real accounts, read when entries close. Bought engagement removes the entry.", 40],
];

export const WRITING_KINDS = ["thread", "article"] as const;
export type WritingKind = (typeof WRITING_KINDS)[number];

export const WRITING_KIND_LABEL: Record<WritingKind, string> = {
  thread: "Thread on X",
  article: "Article",
};

export const WRITING_LIMITS = { name: CONTEST_LIMITS.name, title: 140, email: CONTEST_LIMITS.email, post: CONTEST_LIMITS.post } as const;

/** What the form sends. `hp` is the field people never see. */
export const WRITING_FIELDS = ["name", "handle", "post", "kind", "title", "email", "agree", "marketing", "hp"] as const;

export type WritingField = "name" | "handle" | "post" | "kind" | "title" | "email" | "agree" | "marketing";

export type WritingInput = {
  name: string;
  /** Lowercased, without the @. */
  handle: string;
  /** Always https://x.com/<user>/status/<id>. */
  postUrl: string;
  /** The account in the post link, lowercased. It can differ from the handle; admin flags it. */
  postUser: string;
  postId: string;
  kind: WritingKind;
  title: string | null;
  email: string | null;
};

/** A field the entrant needs to fix, with a message they can act on. */
export class WritingInputError extends Error {
  constructor(
    readonly field: WritingField,
    message: string,
  ) {
    super(message);
    this.name = "WritingInputError";
  }
}

/** Checks an entry. The same rules run in the form and on the server. */
export function parseWritingInput(raw: unknown): WritingInput {
  const b = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;

  const name = clean(b.name);
  if (!name) throw new WritingInputError("name", "Add your name.");
  if (name.length > WRITING_LIMITS.name) throw new WritingInputError("name", `Keep your name under ${WRITING_LIMITS.name} characters.`);

  const handle = bareXHandle(b.handle);
  if (!handle) throw new WritingInputError("handle", "Add your X handle, like @yourname.");
  if (!HANDLE_RE.test(handle)) {
    throw new WritingInputError("handle", "That X handle doesn't look right. Use the part after x.com/, up to 15 letters, digits or _.");
  }

  if (!clean(b.post)) throw new WritingInputError("post", "Add the link to your post on X.");
  const post = normalizeXPost(b.post);
  if (!post) {
    throw new WritingInputError("post", "Use the link to your post on X, like x.com/yourname/status/123.");
  }

  if (!WRITING_KINDS.includes(b.kind as WritingKind)) {
    throw new WritingInputError("kind", "Pick a thread or an article.");
  }

  const title = clean(b.title);
  if (title.length > WRITING_LIMITS.title) {
    throw new WritingInputError("title", `Keep it under ${WRITING_LIMITS.title} characters.`);
  }

  const emailRaw = clean(b.email);
  let email: string | null = null;
  if (emailRaw) {
    email = emailRaw.length <= WRITING_LIMITS.email ? normalizeEmail(emailRaw) : null;
    if (!email) throw new WritingInputError("email", "That email doesn't look right. Check it, or leave it empty.");
  }

  if (b.agree !== true) {
    throw new WritingInputError("agree", "Confirm this is your own writing and you agree to the rules.");
  }

  if (b.marketing !== true) {
    throw new WritingInputError("marketing", "Confirm Gloam may share and quote your writing, with credit to you.");
  }

  return {
    name,
    handle: handle.toLowerCase(),
    postUrl: post.url,
    postUser: post.user,
    postId: post.id,
    kind: b.kind as WritingKind,
    title: title || null,
    email,
  };
}
