/**
 * The treasure hunt: a prize hidden across the site, Glim and the hosted MCP
 * server. Server only (no client component may import this file).
 *
 * The prize is a Gloam claim link the founder makes himself. The part of it
 * after "gloam1=" is split into four pieces, and each of the four steps gives
 * one (HUNT_FRAGMENT_1 to 4) with its clue: the home page source, the hidden
 * page's riddle, Glim's passphrase, the MCP key. Whoever puts the pieces
 * together in order and opens the link first takes the prize; the vault lets a
 * note be spent once, so only one claim ever works.
 *
 * The code here is only the mechanism. Every piece of content (the texts, the
 * hidden page's path, the answer, Glim's passphrase, the MCP key, the pieces of
 * the link) comes from server environment variables, so none of it is in the
 * repository or in any script sent to the browser.
 *
 * Off unless HUNT_ENABLED is "1" or "true". While off, nothing here changes
 * what any page, the bot or the MCP server does, and the hidden page 404s.
 * A step whose own variables are not set stays off too.
 *
 * Progress is counted per step as distinct people, in a HyperLogLog (Redis
 * PFADD): each person goes in as a one-way keyed hash of their network address
 * or Telegram account, and the sketch keeps neither, only an estimate of how
 * many went in.
 */
import { createHash, createHmac, timingSafeEqual } from "crypto";
import { kv, kvBackend } from "@/lib/partnersKv";

/** The steps a person can be counted at, in order. */
export const HUNT_STEPS = ["page", "riddle", "glim", "mcp"] as const;
export type HuntStep = (typeof HUNT_STEPS)[number];

const KEY_PREFIX = "gloam:hunt:v1:";
/** Longest answer, passphrase or key the checks will read. */
export const HUNT_INPUT_MAX = 200;
/** How many pieces the prize link is split into: one per step. */
export const HUNT_PIECES = 4;
/** The network the prize link is on, unless HUNT_PRIZE_NET says otherwise. */
export const HUNT_DEFAULT_PRIZE_NET = "robinhood-mainnet";

function env(name: string): string {
  return process.env[name]?.trim() ?? "";
}

/** A text from the environment, with a written "\n" read as a line break. */
function text(name: string): string {
  return env(name).replace(/\\n/g, "\n");
}

/** A piece of the prize link: letters, digits and "=" only, as a claim link writes them. */
export function huntFragment(n: number): string {
  const f = env(`HUNT_FRAGMENT_${n}`).replace(/\s+/g, "");
  return /^[A-Za-z0-9=]+$/.test(f) ? f : "";
}

/** The line that hands out piece n. */
export function pieceLine(n: number, fragment: string): string {
  return `Piece ${n} of ${HUNT_PIECES}: ${fragment}`;
}

/**
 * A clue with its piece of the link: in place of "{fragment}" when the text has
 * it, else on its own line after the text. With no piece set, the clue alone.
 */
export function withPiece(clue: string, n: number): string {
  const fragment = huntFragment(n);
  if (!fragment) return clue.replace(/\{fragment\}/g, "");
  if (clue.includes("{fragment}")) return clue.replace(/\{fragment\}/g, fragment);
  return clue ? `${clue}\n\n${pieceLine(n, fragment)}` : pieceLine(n, fragment);
}

export function huntEnabled(): boolean {
  const v = env("HUNT_ENABLED").toLowerCase();
  return v === "1" || v === "true";
}

/** Lower case, with every space removed, so "Shielded Pool" and "shieldedpool" match. */
export function normalizeGuess(input: string): string {
  return input.normalize("NFKC").toLowerCase().replace(/\s+/g, "");
}

function sha256(s: string): Buffer {
  return createHash("sha256").update(s, "utf8").digest();
}

/** Constant-time over equal-length digests, so the time taken says nothing about how close a guess was. */
function sameDigest(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Checks a guess against a server value, ignoring case and spaces. The value may
 * list several accepted answers split by "|", and each may be written plain or as
 * "sha256:<hex>" (the hash of the answer already lowered and with spaces removed),
 * so the plain answer need not sit in the environment at all.
 */
export function matchesSecret(guess: unknown, configured: string): boolean {
  if (typeof guess !== "string" || !configured) return false;
  if (guess.length > HUNT_INPUT_MAX) return false;
  const g = normalizeGuess(guess);
  if (!g) return false;
  const digest = sha256(g);
  let hit = false;
  for (const raw of configured.split("|")) {
    const want = raw.trim();
    if (!want) continue;
    const hashed = /^sha256:([0-9a-f]{64})$/i.exec(want);
    const target = hashed ? Buffer.from(hashed[1]!, "hex") : sha256(normalizeGuess(want));
    // every alternative is checked, so a match early in the list takes no less time
    if (sameDigest(digest, target)) hit = true;
  }
  return hit;
}

// ---------------------------------------------------------------- step 1: the home page source

/**
 * The HTML comment and console line on the home page, when the hunt is on. The
 * first piece goes where either text says "{fragment}", else after the comment
 * (or after the console line when there is no comment).
 */
export function huntSourceClue(): { comment: string; console: string } | null {
  if (!huntEnabled()) return null;
  let comment = text("HUNT_SOURCE_COMMENT");
  let consoleLine = text("HUNT_CONSOLE_MESSAGE");
  if (!comment && !consoleLine) return null;
  if (consoleLine.includes("{fragment}") && !comment.includes("{fragment}")) consoleLine = withPiece(consoleLine, 1);
  else if (comment) comment = withPiece(comment, 1);
  else consoleLine = withPiece(consoleLine, 1);
  return { comment, console: consoleLine.replace(/\{fragment\}/g, "") };
}

/** The whole HTML comment, with any "--" in the text spaced out so it can't end the comment early. */
export function htmlComment(s: string): string {
  return `<!-- ${s.replace(/-{2,}/g, (m) => m.split("").join(" "))} -->`;
}

/** A string as a JavaScript literal that is safe inside a <script> element. */
export function scriptLiteral(s: string): string {
  return JSON.stringify(s).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

// ---------------------------------------------------------------- step 2: the hidden page

/** The hidden page's path segment (the page is /hunt/<segment>), when the hunt is on and the page is set up. */
export function huntPagePath(): string | null {
  if (!huntEnabled()) return null;
  const slug = env("HUNT_PATH_2").replace(/^\/+|\/+$/g, "");
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{2,63}$/.test(slug)) return null;
  if (!env("HUNT_RIDDLE") || !env("HUNT_ANSWER_2") || !env("HUNT_CLUE_3")) return null;
  return slug;
}

/** What the hidden page shows before the answer. */
export function huntRiddle(): { title: string; riddle: string } | null {
  if (!huntPagePath()) return null;
  return { title: text("HUNT_PAGE_TITLE"), riddle: text("HUNT_RIDDLE") };
}

/** The next clue and the second piece for a right answer, or null. */
export function checkRiddleAnswer(guess: unknown): string | null {
  if (!huntPagePath()) return null;
  return matchesSecret(guess, env("HUNT_ANSWER_2")) ? withPiece(text("HUNT_CLUE_3"), 2) : null;
}

// ---------------------------------------------------------------- step 3: Glim

/** Glim's reply (the next clue and the third piece) when someone sends the passphrase, or null (also when the hunt is off). */
export function glimHuntReply(message: string): string | null {
  if (!huntEnabled()) return null;
  const phrase = env("HUNT_GLIM_PASSPHRASE");
  const reply = text("HUNT_CLUE_4");
  if (!phrase || !reply) return null;
  return matchesSecret(message, phrase) ? withPiece(reply, 3) : null;
}

/** What Glim says in the group to the passphrase, so the next clue is never posted there. */
export function glimHuntGroupReply(): string {
  return text("HUNT_GLIM_GROUP_REPLY") || "Send me that in a private message.";
}

// ---------------------------------------------------------------- step 4: the hosted MCP server

/** The gloam_info argument that carries the key. */
export function huntMcpArg(): string {
  const name = env("HUNT_MCP_ARG");
  return /^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(name) ? name : "code";
}

/** The network key the prize link is on (HUNT_PRIZE_NET, a plain key, else Robinhood Chain mainnet). */
export function huntPrizeNet(): string {
  const net = env("HUNT_PRIZE_NET");
  return /^[a-z0-9-]{2,40}$/.test(net) ? net : HUNT_DEFAULT_PRIZE_NET;
}

/** How to put the link together, when HUNT_FINAL_INSTRUCTIONS doesn't say it in its own words. */
export function defaultFinalInstructions(net = huntPrizeNet()): string {
  return [
    `That is the last of the ${HUNT_PIECES} pieces.`,
    `Put them together in order, 1 then 2 then 3 then 4, with nothing between them, and add the result to the end of this link:`,
    `https://www.gloam.trade/claim?net=${net}#claim=gloam1=`,
    "Open the whole link and claim. Claiming needs no gas. Only the first claim works, so be quick.",
  ].join("\n");
}

export type HuntFinal = { message: string; piece: { number: number; of: number; text: string } | null };

/** The last step for the right MCP key: how to assemble the link, and the fourth piece. Null otherwise. */
export function mcpHuntFinal(value: unknown): HuntFinal | null {
  if (!huntEnabled()) return null;
  const key = env("HUNT_MCP_KEY");
  if (!key) return null;
  if (!matchesSecret(value, key)) return null;
  const fragment = huntFragment(4);
  return {
    message: text("HUNT_FINAL_INSTRUCTIONS") || defaultFinalInstructions(),
    piece: fragment ? { number: 4, of: HUNT_PIECES, text: fragment } : null,
  };
}

// ---------------------------------------------------------------- progress

/** A one-way name for a person, never stored: only fed to the HyperLogLog. */
export function huntSubject(kind: "ip" | "tg", id: string | number): string {
  const secret = env("GLOAM_RATE_LIMIT_KEY");
  return createHmac("sha256", `gloam-hunt|${secret}`).update(`${kind}|${id}`).digest("hex").slice(0, 32);
}

/** Counts a person as having reached a step. Never throws; a store that is down just misses the count. */
export async function countHuntStep(step: HuntStep, subject: string): Promise<void> {
  if (!huntEnabled() || kvBackend() === "none") return;
  try {
    await kv([["PFADD", `${KEY_PREFIX}reached:${step}`, subject]]);
  } catch {
    /* a missed count is fine */
  }
}

/** How many distinct people reached each step (estimates), or null when there is no store. */
export async function readHuntProgress(): Promise<Record<HuntStep, number> | null> {
  if (kvBackend() === "none") return null;
  const r = await kv(HUNT_STEPS.map((s) => ["PFCOUNT", `${KEY_PREFIX}reached:${s}`]));
  return Object.fromEntries(HUNT_STEPS.map((s, i) => [s, Number(r[i]) || 0])) as Record<HuntStep, number>;
}

/** The prize note's nullifier (HUNT_PRIZE_NULLIFIER), for the admin's "claimed yet?" check. Null when unset or malformed. */
export function prizeNullifier(): `0x${string}` | null {
  const v = env("HUNT_PRIZE_NULLIFIER");
  return /^0x[0-9a-fA-F]{64}$/.test(v) ? (v.toLowerCase() as `0x${string}`) : null;
}

/** Which parts are set up, for the admin panel. Says nothing about what they hold. */
export function huntSetup(): Record<string, boolean> {
  return {
    enabled: huntEnabled(),
    source: Boolean(env("HUNT_SOURCE_COMMENT") || env("HUNT_CONSOLE_MESSAGE")),
    page: Boolean(huntEnabled() && huntPagePath()),
    glim: Boolean(env("HUNT_GLIM_PASSPHRASE") && env("HUNT_CLUE_4")),
    mcp: Boolean(env("HUNT_MCP_KEY")),
    pieces: [1, 2, 3, 4].every((n) => Boolean(huntFragment(n))),
    prizeCheck: Boolean(prizeNullifier()),
  };
}
