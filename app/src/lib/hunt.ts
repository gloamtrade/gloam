/**
 * The treasure hunt: a prize hidden across the site, Glim and the hosted MCP
 * server. Server only (no client component may import this file).
 *
 * The prize is a Gloam claim link the founder makes himself (HUNT_PRIZE_LINK,
 * the short gloam.trade/c#... form or the long #claim= one). The first three
 * steps (the home page source, the hidden page's riddle, Glim's passphrase)
 * each hand out a piece with their clue (HUNT_FRAGMENT_1 to 3). A piece is a
 * short random code, not a part of the link, so pieces say nothing about the
 * prize. The last step, the MCP key, gives the whole link, and only to a call
 * that also brings all three pieces in order. So every step is needed: the
 * pieces without the key get nothing, and the key without the pieces only gets
 * told to bring them. Whoever opens the link first takes the prize; the vault
 * lets a note be spent once, so only one claim ever works.
 *
 * Earlier the link itself was cut into four pieces, one per step. Pieces 1 to 3
 * then already held the whole note secret (the last piece was only the
 * commitment and chain, which anyone can work out again), so the last step
 * could be skipped. Never split the link again.
 *
 * Setting it up (all server environment variables):
 *  1. Make the prize payment in the app and copy its claim link into
 *     HUNT_PRIZE_LINK. Either link form works; it is handed out as it is.
 *  2. Its nullifier, for the admin's "claimed yet?" check:
 *     pbpaste | ../mcp/node_modules/.bin/tsx scripts/hunt-nullifier.mts
 *     into HUNT_PRIZE_NULLIFIER.
 *  3. Three pieces, letters and digits, 8 to 48 characters each, made fresh:
 *     for i in 1 2 3; do openssl rand -hex 8; done
 *     into HUNT_FRAGMENT_1, HUNT_FRAGMENT_2 and HUNT_FRAGMENT_3.
 *  4. The clue that leads to the MCP step (HUNT_CLUE_4) names the key; the key
 *     goes in HUNT_MCP_KEY. A right key without the pieces is told to call again
 *     with them as "pieces" (HUNT_MCP_PIECES_ARG renames it).
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
/** How many pieces the hunt hands out: one for each step before the MCP key. */
export const HUNT_PIECES = 3;
/** A piece's length: long enough not to be guessed, short enough to copy. */
const PIECE_MIN = 8;
const PIECE_MAX = 48;
/** The network the prize note is on, unless HUNT_PRIZE_NET says otherwise. */
export const HUNT_DEFAULT_PRIZE_NET = "robinhood-mainnet";

function env(name: string): string {
  return process.env[name]?.trim() ?? "";
}

/** A text from the environment, with a written "\n" read as a line break. */
function text(name: string): string {
  return env(name).replace(/\\n/g, "\n");
}

/** Piece n (1 to 3): letters, digits and "=" only, 8 to 48 characters. Anything else is no piece. */
export function huntFragment(n: number): string {
  if (!Number.isInteger(n) || n < 1 || n > HUNT_PIECES) return "";
  const f = env(`HUNT_FRAGMENT_${n}`).replace(/\s+/g, "");
  return f.length >= PIECE_MIN && f.length <= PIECE_MAX && /^[A-Za-z0-9=]+$/.test(f) ? f : "";
}

/** All three pieces in order, or null while any is missing. */
function allPieces(): string[] | null {
  const pieces = Array.from({ length: HUNT_PIECES }, (_, i) => huntFragment(i + 1));
  return pieces.every(Boolean) ? pieces : null;
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

/** Curly quotes and apostrophes, as phone keyboards type them, to straight ones. */
function foldQuotes(s: string): string {
  return s.replace(/[\u2018\u2019\u201A\u201B\u2032\u02BC\u0060\u00B4]/g, "'").replace(/[\u201C\u201D\u201E\u201F\u2033]/g, '"');
}

/**
 * What a guess is compared as: NFKC, curly quotes folded to straight, lower
 * case, then only letters (with their accents) and digits kept, from any
 * script. Spaces, punctuation and symbols all go, so "Don’t trust, verify!",
 * "don't trust verify" and "donttrustverify" are the same answer. A
 * "sha256:<hex>" answer is the hash of exactly this string.
 */
export function normalizeGuess(input: string): string {
  return foldQuotes(input.normalize("NFKC")).toLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, "");
}

/**
 * The form hashes were made over before punctuation was dropped (lower case,
 * spaces removed, punctuation kept; quotes now folded), so a "sha256:" answer
 * set then still matches.
 */
function legacyGuess(input: string): string {
  return foldQuotes(input.normalize("NFKC")).toLowerCase().replace(/\s+/g, "");
}

function sha256(s: string): Buffer {
  return createHash("sha256").update(s, "utf8").digest();
}

/** Constant-time over equal-length digests, so the time taken says nothing about how close a guess was. */
function sameDigest(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Checks a guess against a server value, ignoring case, spaces, punctuation and
 * curly quotes (normalizeGuess). The value may list several accepted answers
 * split by "|", and each may be written plain or as "sha256:<hex>", the hash
 * of normalizeGuess(answer), so the plain answer need not sit in the
 * environment at all. To make one (curly quotes are punctuation, so they go too):
 *   node -e 'const s=process.argv[1].normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu,"");console.log("sha256:"+require("crypto").createHash("sha256").update(s).digest("hex"))' "Don't trust, verify"
 * A hash made before punctuation was dropped (lower case, spaces removed) still matches.
 */
export function matchesSecret(guess: unknown, configured: string): boolean {
  if (typeof guess !== "string" || !configured) return false;
  if (guess.length > HUNT_INPUT_MAX) return false;
  const g = normalizeGuess(guess);
  if (!g) return false;
  const digest = sha256(g);
  const legacy = sha256(legacyGuess(guess));
  let hit = false;
  for (const raw of configured.split("|")) {
    const want = raw.trim();
    if (!want) continue;
    const hashed = /^sha256:([0-9a-f]{64})$/i.exec(want);
    if (hashed) {
      const target = Buffer.from(hashed[1]!, "hex");
      // both forms are compared every time, so the time taken says nothing about which one matched
      const now = sameDigest(digest, target);
      const before = sameDigest(legacy, target);
      if (now || before) hit = true;
      continue;
    }
    const w = normalizeGuess(want);
    // an answer of only punctuation would match nothing sensible; it never matches
    if (w && sameDigest(digest, sha256(w))) hit = true;
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

/**
 * Glim's reply (the next clue and the third piece) when someone sends the
 * passphrase in a private chat, or null (also when the hunt is off). The group
 * is never checked, so it can't tell a right guess from a wrong one.
 */
export function glimHuntReply(message: string): string | null {
  if (!huntEnabled()) return null;
  const phrase = env("HUNT_GLIM_PASSPHRASE");
  const reply = text("HUNT_CLUE_4");
  if (!phrase || !reply) return null;
  return matchesSecret(message, phrase) ? withPiece(reply, 3) : null;
}


// ---------------------------------------------------------------- step 4: the hosted MCP server

/** The gloam_info argument that carries the key. */
export function huntMcpArg(): string {
  const name = env("HUNT_MCP_ARG");
  return /^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(name) ? name : "code";
}

/** The network key the prize note is on, for the "claimed yet?" check (HUNT_PRIZE_NET, a plain key, else Robinhood Chain mainnet). */
export function huntPrizeNet(): string {
  const net = env("HUNT_PRIZE_NET");
  return /^[a-z0-9-]{2,40}$/.test(net) ? net : HUNT_DEFAULT_PRIZE_NET;
}

/** The gloam_info argument that carries the three pieces. */
export function huntMcpPiecesArg(): string {
  const name = env("HUNT_MCP_PIECES_ARG");
  return /^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(name) && name !== huntMcpArg() ? name : "pieces";
}

/**
 * The prize claim link (HUNT_PRIZE_LINK), or null when unset or not a claim
 * link: an https link with a short body (/c#<letters and digits>) or a
 * "#claim=" code.
 */
export function huntPrizeLink(): string | null {
  const link = env("HUNT_PRIZE_LINK");
  if (!/^https:\/\/[^\s#]+$/.test(link.split("#")[0] ?? "") || /\s/.test(link)) return null;
  if (/\/c#[0-9A-Za-z]{20,}$/.test(link)) return link;
  if (/#claim=gloam[0-9a-z]*[.=-][A-Za-z0-9_\-.=%]{20,}$/.test(link)) return link;
  return null;
}

/**
 * True when the text holds the three pieces in order (1, then 2, then 3), with
 * anything between them: spaces, commas, "piece 1:" labels. An array of texts
 * is read as one text. A text too long, or pieces out of order, never match.
 */
export function bringsPieces(value: unknown, pieces: string[]): boolean {
  const parts = Array.isArray(value) ? value : [value];
  if (!parts.length || parts.length > HUNT_PIECES * 2 || !parts.every((p) => typeof p === "string")) return false;
  const s = (parts as string[]).join(" ");
  if (!s.trim() || s.length > HUNT_INPUT_MAX) return false;
  let from = 0;
  for (const piece of pieces) {
    const at = s.indexOf(piece, from);
    if (at < 0) return false;
    from = at + piece.length;
  }
  return true;
}

/** What a right key gets without all three pieces, in order. Says nothing about which piece is missing or wrong. */
export function piecesNeededMessage(): string {
  return [
    "That is the right key.",
    `The prize link only comes with the ${HUNT_PIECES} pieces you found on the way.`,
    `Call gloam_info again with the same key and "${huntMcpPiecesArg()}": piece 1, piece 2 and piece 3, in that order, separated by spaces.`,
  ].join("\n");
}

/** What comes with the prize link, when HUNT_FINAL_INSTRUCTIONS doesn't say it in its own words. Works for both link forms: the link is handed out whole. */
export function defaultFinalInstructions(): string {
  return [
    "That is every step. The prize link is below, whole: open it as it is and claim.",
    "Claiming needs no gas. Only the first claim works, so be quick.",
  ].join("\n");
}

export type HuntFinal = { message: string; link: string | null };

/**
 * The last step. A wrong key, or a step not set up (key, prize link or any
 * piece missing): null, so the caller answers as usual. The right key without
 * the three pieces in order: how to bring them, no link. The right key with
 * them: the prize link, whole.
 */
export function mcpHuntFinal(value: unknown, pieces: unknown): HuntFinal | null {
  if (!huntEnabled()) return null;
  const key = env("HUNT_MCP_KEY");
  const link = huntPrizeLink();
  const want = allPieces();
  if (!key || !link || !want) return null;
  if (!matchesSecret(value, key)) return null;
  if (!bringsPieces(pieces, want)) return { message: piecesNeededMessage(), link: null };
  return { message: text("HUNT_FINAL_INSTRUCTIONS") || defaultFinalInstructions(), link };
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
    pieces: Boolean(allPieces()),
    prizeLink: Boolean(huntPrizeLink()),
    prizeCheck: Boolean(prizeNullifier()),
  };
}
