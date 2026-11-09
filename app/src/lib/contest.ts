/**
 * The Gloam Video Contest (gloam.trade/contest): the prizes and dates, and the
 * rules an entry has to pass. No server code here, so the form checks an entry
 * with exactly the rules the server uses (lib/contestEntries, api/contest).
 *
 * Change prizes and dates in CONTEST only. The page, the form, the API route,
 * the link preview and Glim all read them from here. (The page can't hold it:
 * Next.js refuses extra exports from a page file, and the route needs the
 * close time too.)
 */
import { normalizeEmail } from "./updatesEmail";

export const CONTEST = {
  name: "Gloam Video Contest",
  /** Prizes in US dollars, by place. The total is their sum. */
  prizes: [250, 150, 100, 100],
  /** Entries open (UTC). Early entries are taken; this is the date the page gives. */
  opensAt: "2026-11-09T00:00:00Z",
  /** The last moment an entry is taken (UTC). After it the form is closed. */
  closesAt: "2026-11-16T23:59:59Z",
  /** Winners are announced on @gloamtrade by this day (UTC). */
  winnersBy: "2026-11-19T00:00:00Z",
  /** Video length, in minutes. */
  minMinutes: 1,
  maxMinutes: 3,
  account: "gloamtrade",
  /** The contest post on X that entries quote. Until it is set, the page points at @gloamtrade. */
  announcementUrl: "https://x.com/gloamtrade/status/2119693757138317348" as string | null,
  /** The Telegram community, where the Creators topic lives. */
  telegramUrl: "https://t.me/gloamhq",
} as const;

export const CONTEST_TOTAL = CONTEST.prizes.reduce((a, b) => a + b, 0);

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** "16 November 2026", read in UTC so the server and every browser agree. */
export function contestDay(iso: string, withYear = true): string {
  const d = new Date(iso);
  const day = `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
  return withYear ? `${day} ${d.getUTCFullYear()}` : day;
}

/** "23:59 UTC" */
export function contestTime(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")} UTC`;
}

/** "1st", "2nd", "3rd", "4th" */
export function placeLabel(i: number): string {
  const n = i + 1;
  const s = n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] ?? "th";
  return `${n}${s}`;
}

export function contestClosed(now = Date.now()): boolean {
  return now > Date.parse(CONTEST.closesAt);
}

export const CONTEST_NETWORKS = ["robinhood", "tempo", "base", "ethereum", "none"] as const;
export type ContestNetwork = (typeof CONTEST_NETWORKS)[number];

export const CONTEST_NETWORK_LABEL: Record<ContestNetwork, string> = {
  robinhood: "Robinhood Chain",
  tempo: "Tempo",
  base: "Base",
  ethereum: "Ethereum",
  none: "Didn't use the app",
};

export const CONTEST_LIMITS = { name: 80, note: 280, email: 120, post: 300 } as const;

/** What the form sends. `hp` is the field people never see. */
export const CONTEST_FIELDS = ["name", "handle", "post", "note", "email", "network", "agree", "marketing", "hp"] as const;

export type ContestInput = {
  name: string;
  /** Lowercased, without the @. */
  handle: string;
  /** Always https://x.com/<user>/status/<id>. */
  postUrl: string;
  /** The account in the post link, lowercased. It can differ from the handle; admin flags it. */
  postUser: string;
  postId: string;
  note: string | null;
  email: string | null;
  network: ContestNetwork;
};

export type ContestField = "name" | "handle" | "post" | "note" | "email" | "network" | "agree" | "marketing";

/** A field the entrant needs to fix, with a message they can act on. */
export class ContestInputError extends Error {
  constructor(
    readonly field: ContestField,
    message: string,
  ) {
    super(message);
    this.name = "ContestInputError";
  }
}

/** Trimmed single-line text without control characters. */
function clean(v: unknown): string {
  if (typeof v !== "string") return "";
  return v
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/;
const X_HOSTS = new Set(["x.com", "www.x.com", "mobile.x.com", "twitter.com", "www.twitter.com", "mobile.twitter.com"]);
const STATUS_PATH = /^\/([A-Za-z0-9_]{1,15})\/status\/(\d{1,20})(?:\/[A-Za-z0-9_/]*)?$/;

/** An X handle typed as `@name`, `name` or a profile link, reduced to `name`. */
export function bareXHandle(v: unknown): string {
  return clean(v)
    .replace(/^https?:\/\//i, "")
    .replace(/^(www\.|mobile\.)?(x\.com|twitter\.com)\//i, "")
    .replace(/^@/, "")
    .replace(/[/?#].*$/, "");
}

/**
 * A link to a post on X, as https://x.com/<user>/status/<id>. Takes x.com and
 * twitter.com (with www. or mobile.), with or without https://, and drops any
 * query, hash or /video/1 tail. Anything else, http:// included, is null.
 */
export function normalizeXPost(raw: unknown): { url: string; user: string; id: string } | null {
  let s = clean(raw);
  if (!s || s.length > CONTEST_LIMITS.post) return null;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = `https://${s}`;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.username || u.password || u.port) return null;
  if (!X_HOSTS.has(u.hostname.toLowerCase())) return null;
  const m = STATUS_PATH.exec(u.pathname.replace(/\/+$/, ""));
  if (!m) return null;
  const [, user, id] = m;
  return { url: `https://x.com/${user}/status/${id}`, user: user!.toLowerCase(), id: id! };
}

/** Checks an entry. The same rules run in the form and on the server. */
export function parseContestInput(raw: unknown): ContestInput {
  const b = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;

  const name = clean(b.name);
  if (!name) throw new ContestInputError("name", "Add your name.");
  if (name.length > CONTEST_LIMITS.name) throw new ContestInputError("name", `Keep your name under ${CONTEST_LIMITS.name} characters.`);

  const handle = bareXHandle(b.handle);
  if (!handle) throw new ContestInputError("handle", "Add your X handle, like @yourname.");
  if (!HANDLE_RE.test(handle)) {
    throw new ContestInputError("handle", "That X handle doesn't look right. Use the part after x.com/, up to 15 letters, digits or _.");
  }

  if (!clean(b.post)) throw new ContestInputError("post", "Add the link to your video post on X.");
  const post = normalizeXPost(b.post);
  if (!post) {
    throw new ContestInputError("post", "Use the link to your post on X, like x.com/yourname/status/123.");
  }

  const note = clean(b.note);
  if (note.length > CONTEST_LIMITS.note) {
    throw new ContestInputError("note", `Keep it under ${CONTEST_LIMITS.note} characters.`);
  }

  const emailRaw = clean(b.email);
  let email: string | null = null;
  if (emailRaw) {
    email = emailRaw.length <= CONTEST_LIMITS.email ? normalizeEmail(emailRaw) : null;
    if (!email) throw new ContestInputError("email", "That email doesn't look right. Check it, or leave it empty.");
  }

  if (!CONTEST_NETWORKS.includes(b.network as ContestNetwork)) {
    throw new ContestInputError("network", "Pick the network you used, or Didn't use the app.");
  }

  if (b.agree !== true) {
    throw new ContestInputError("agree", "Confirm the video is your own work and you agree to the rules.");
  }

  if (b.marketing !== true) {
    throw new ContestInputError("marketing", "Confirm Gloam may use your video for marketing, with credit to you.");
  }

  return {
    name,
    handle: handle.toLowerCase(),
    postUrl: post.url,
    postUser: post.user,
    postId: post.id,
    note: note || null,
    email,
    network: b.network as ContestNetwork,
  };
}
