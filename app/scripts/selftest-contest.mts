/**
 * Self-test: the video contest (lib/contest, lib/contestEntries,
 * api/contest/submit, api/contest/entries).
 *
 *  - validation: name, X handle (with or without @, lowercased), the post link
 *    (x.com or twitter.com, /<user>/status/<digits>, normalized to
 *    https://x.com/<user>/status/<id>), note and email limits, the network
 *    list and the rules checkbox; the form and the server use the same rules
 *  - one entry per handle: the same handle again replaces it, keeps the first
 *    time, counts the change and keeps the replaced post link
 *  - the route: same-site JSON only, unknown fields refused, oversized
 *    bodies, bad JSON, the bot field, the hourly limit per IP, closed after the
 *    close time
 *  - admin: the list and the CSV need an admin session; a post by another
 *    account is flagged; formula cells are quoted
 *
 * Uses the in-process store (GLOAM_PARTNERS_STORE=memory); nothing reaches any host.
 *
 * Run from app/:  ../mcp/node_modules/.bin/tsx scripts/selftest-contest.mts
 */
import assert from "node:assert/strict";
import Module from "node:module";
import { fileURLToPath } from "node:url";

const stubs: Record<string, string> = {
  "server-only": fileURLToPath(new URL("./server-only-stub.cjs", import.meta.url)),
  "next/headers": fileURLToPath(new URL("./next-headers-stub.cjs", import.meta.url)),
};
const M = Module as unknown as { _resolveFilename: (req: string, ...rest: unknown[]) => string };
const resolveFilename = M._resolveFilename;
M._resolveFilename = function (req: string, ...rest: unknown[]) {
  return stubs[req] ?? resolveFilename.call(this, req, ...rest);
};

process.env.GLOAM_PARTNERS_STORE = "memory";
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;
const env = process.env as Record<string, string | undefined>;
env.NODE_ENV = "test";
env.ADMIN_ACCESS_CODE = "a-long-random-admin-code-for-the-contest-selftest";
env.GLOAM_RATE_LIMIT_KEY = "cd".repeat(32);

const contest = await import("../src/lib/contest");
const entries = await import("../src/lib/contestEntries");
const submit = await import("../src/app/api/contest/submit/route");
const admin = await import("../src/app/api/contest/entries/route");
const { createAdminSession, ADMIN_COOKIE } = await import("../src/lib/adminAuth");

const { parseContestInput, ContestInputError, normalizeXPost, contestClosed, CONTEST } = contest;
const g = globalThis as { __testCookies?: Record<string, string> };
let n = 0;

const GOOD = {
  name: "Ada Lovelace",
  handle: "@Ada_L",
  post: "https://twitter.com/Ada_L/status/1850000000000000001?s=20",
  note: "A private payroll run, start to finish.",
  email: "Ada@Example.com",
  network: "robinhood",
  agree: true,
  hp: "",
};

function fieldOf(body: unknown): string | null {
  try {
    parseContestInput(body);
    return null;
  } catch (e) {
    assert.ok(e instanceof ContestInputError, "a bad field throws ContestInputError");
    return e.field;
  }
}

// ------------------------------------------------------------ validation
{
  const ok = parseContestInput(GOOD);
  assert.equal(ok.handle, "ada_l", "handle lowercased, no @");
  assert.equal(ok.postUrl, "https://x.com/Ada_L/status/1850000000000000001", "post normalized to x.com, query dropped");
  assert.equal(ok.postUser, "ada_l");
  assert.equal(ok.postId, "1850000000000000001");
  assert.equal(ok.email, "ada@example.com");
  assert.equal(ok.network, "robinhood");
  n += 6;

  // handle forms
  assert.equal(parseContestInput({ ...GOOD, handle: "ada_l" }).handle, "ada_l");
  assert.equal(parseContestInput({ ...GOOD, handle: "https://x.com/Ada_L" }).handle, "ada_l");
  assert.equal(fieldOf({ ...GOOD, handle: "" }), "handle");
  assert.equal(fieldOf({ ...GOOD, handle: "@this_is_sixteen1" }), "handle", "16 characters is too long");
  assert.equal(fieldOf({ ...GOOD, handle: "bad-handle" }), "handle");
  n += 5;

  // post links
  const post = (p: string) => normalizeXPost(p)?.url ?? null;
  assert.equal(post("x.com/a/status/1"), "https://x.com/a/status/1", "no scheme is fine");
  assert.equal(post("https://www.x.com/a/status/12/video/1"), "https://x.com/a/status/12");
  assert.equal(post("https://mobile.twitter.com/a/status/12/"), "https://x.com/a/status/12");
  assert.equal(post("https://x.com/a/status/12#frag"), "https://x.com/a/status/12");
  assert.equal(post("http://x.com/a/status/12"), null, "http is refused");
  assert.equal(post("https://x.com.evil.example/a/status/12"), null, "lookalike host");
  assert.equal(post("https://evil.example/x.com/a/status/12"), null);
  assert.equal(post("https://x.com/a/status/abc"), null, "id must be digits");
  assert.equal(post("https://x.com/a"), null, "a profile is not a post");
  assert.equal(post("https://x.com:8443/a/status/12"), null, "no port");
  assert.equal(post("https://user:pw@x.com/a/status/12"), null, "no credentials");
  assert.equal(post("javascript:alert(1)//x.com/a/status/1"), null);
  assert.equal(fieldOf({ ...GOOD, post: "" }), "post");
  assert.equal(fieldOf({ ...GOOD, post: "https://youtube.com/watch?v=1" }), "post");
  n += 14;

  // other fields
  assert.equal(fieldOf({ ...GOOD, name: "   " }), "name");
  assert.equal(fieldOf({ ...GOOD, name: "x".repeat(81) }), "name");
  assert.equal(parseContestInput({ ...GOOD, name: "x".repeat(80) }).name.length, 80);
  assert.equal(fieldOf({ ...GOOD, note: "y".repeat(281) }), "note");
  assert.equal(parseContestInput({ ...GOOD, note: "" }).note, null, "note optional");
  assert.equal(parseContestInput({ ...GOOD, email: "" }).email, null, "email optional");
  assert.equal(fieldOf({ ...GOOD, email: "not-an-email" }), "email");
  assert.equal(fieldOf({ ...GOOD, email: `${"a".repeat(110)}@example.com` }), "email", "over 120 characters");
  assert.equal(fieldOf({ ...GOOD, network: "solana" }), "network");
  assert.equal(fieldOf({ ...GOOD, network: "" }), "network");
  for (const k of contest.CONTEST_NETWORKS) assert.equal(parseContestInput({ ...GOOD, network: k }).network, k);
  assert.equal(fieldOf({ ...GOOD, agree: false }), "agree");
  assert.equal(fieldOf({ ...GOOD, agree: "on" }), "agree", "only a real true counts");
  n += 12 + contest.CONTEST_NETWORKS.length;

  // the config
  assert.equal(contest.CONTEST_TOTAL, 500, "prizes add up to $500");
  assert.equal(contest.contestDay(CONTEST.closesAt), "16 November 2026");
  assert.equal(contest.contestTime(CONTEST.closesAt), "23:59 UTC");
  assert.equal(contestClosed(Date.parse("2026-11-16T23:59:30Z")), false, "open through the last minute");
  assert.equal(contestClosed(Date.parse("2026-11-17T00:00:00Z")), true);
  assert.deepEqual([0, 1, 2, 3].map(contest.placeLabel), ["1st", "2nd", "3rd", "4th"]);
  n += 6;
}

// ------------------------------------------------------------ the route
function req(body: unknown, opts: { ip?: string; origin?: string | null; type?: string; raw?: string } = {}): Request {
  const headers: Record<string, string> = {
    "Content-Type": opts.type ?? "application/json",
    "x-forwarded-for": opts.ip ?? "203.0.113.1",
    host: "gloam.trade",
  };
  if (opts.origin !== null) headers.origin = opts.origin ?? "https://gloam.trade";
  return new Request("https://gloam.trade/api/contest/submit", { method: "POST", headers, body: opts.raw ?? JSON.stringify(body) });
}
async function send(body: unknown, opts?: Parameters<typeof req>[1]) {
  const res = await submit.POST(req(body, opts));
  const json = (await res.json()) as { ok: boolean; data?: { updated: boolean }; error?: { field: string | null; message: string } };
  return { status: res.status, json };
}

const realNow = Date.now;
// run the route inside the entry window
Date.now = () => Date.parse("2026-11-10T12:00:00Z");
try {
  // same site only
  assert.equal((await send(GOOD, { origin: "https://evil.example" })).status, 403, "another origin");
  assert.equal((await send(GOOD, { type: "text/plain" })).status, 403, "not JSON");
  assert.equal((await entries.listContestEntries()).length, 0, "nothing saved by refused calls");
  n += 3;

  const first = await send(GOOD);
  assert.equal(first.status, 200);
  assert.deepEqual(first.json, { ok: true, data: { updated: false } });
  const [saved] = await entries.listContestEntries();
  assert.equal(saved!.handle, "ada_l");
  assert.equal(saved!.revisions, 0);
  n += 4;

  // same handle again (any case): replaces, keeps the first time, keeps the old post
  Date.now = () => Date.parse("2026-11-11T12:00:00Z");
  const again = await send({ ...GOOD, handle: "ADA_L", post: "https://x.com/someone_else/status/99", note: "" });
  assert.deepEqual(again.json, { ok: true, data: { updated: true } }, "the answer says it was updated");
  const list1 = await entries.listContestEntries();
  assert.equal(list1.length, 1, "still one entry per handle");
  assert.equal(list1[0]!.submittedAt, Date.parse("2026-11-10T12:00:00Z"), "first time kept");
  assert.equal(list1[0]!.updatedAt, Date.parse("2026-11-11T12:00:00Z"));
  assert.equal(list1[0]!.revisions, 1);
  assert.deepEqual(list1[0]!.previousPosts, ["https://x.com/Ada_L/status/1850000000000000001"]);
  assert.equal(list1[0]!.note, null);
  assert.equal(entries.postUserDiffers(list1[0]!), true, "a post by another account is flagged");
  n += 8;

  // a second handle comes first in the list (newest first)
  Date.now = () => Date.parse("2026-11-12T12:00:00Z");
  await send({ ...GOOD, name: "=HYPERLINK(\"x\")", handle: "bob", post: "x.com/bob/status/7", email: "" }, { ip: "203.0.113.2" });
  const list2 = await entries.listContestEntries();
  assert.deepEqual(list2.map((e) => e.handle), ["bob", "ada_l"]);
  assert.equal(entries.postUserDiffers(list2[0]!), false);
  n += 2;

  // bad input comes back by field
  const bad = await send({ ...GOOD, post: "https://x.com/a" });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error?.field, "post");
  assert.equal((await send({ ...GOOD, extra: "0x1111111111111111111111111111111111111111" })).status, 400, "unknown fields refused");
  assert.equal((await send([GOOD])).status, 400, "an array is refused");
  assert.equal((await send(null, { raw: "{nope" })).status, 400, "bad JSON");
  assert.equal((await send(null, { raw: JSON.stringify({ ...GOOD, note: "z".repeat(4000) }) })).status, 413);
  n += 6;

  // the bot field: success, nothing kept
  const bot = await send({ ...GOOD, handle: "botty", hp: "filled" });
  assert.deepEqual(bot.json, { ok: true, data: { updated: false } }, "a bot sees success");
  assert.equal((await entries.listContestEntries()).some((e) => e.handle === "botty"), false, "and nothing is kept");
  n += 2;

  // ten saved entries an hour per IP
  for (let i = 0; i < 10; i++) {
    assert.equal((await send({ ...GOOD, handle: `p${i}`, post: `x.com/p${i}/status/${i + 1}` }, { ip: "198.51.100.9" })).status, 200);
  }
  const over = await send({ ...GOOD, handle: "p10", post: "x.com/p10/status/11" }, { ip: "198.51.100.9" });
  assert.equal(over.status, 429, "the eleventh in an hour is refused");
  assert.equal((await entries.listContestEntries()).some((e) => e.handle === "p10"), false);
  assert.equal((await send({ ...GOOD, handle: "p10", post: "x.com/p10/status/11" }, { ip: "198.51.100.10" })).status, 200, "another IP is fine");
  n += 13;

  // after the close time
  Date.now = () => Date.parse("2026-11-17T00:00:01Z");
  const late = await send({ ...GOOD, handle: "late" }, { ip: "203.0.113.50" });
  assert.equal(late.status, 403, "closed after the close time");
  assert.match(late.json.error!.message, /closed on 16 November 2026 at 23:59 UTC/);
  assert.equal((await entries.listContestEntries()).some((e) => e.handle === "late"), false);
  n += 3;
} finally {
  Date.now = realNow;
}

// ------------------------------------------------------------ admin
{
  const get = (csv = false) => admin.GET(new Request(`https://gloam.trade/api/contest/entries${csv ? "?format=csv" : ""}`));
  g.__testCookies = {};
  assert.equal((await get()).status, 401, "no session");
  assert.equal((await get(true)).status, 401, "no session, no CSV");
  g.__testCookies = { [ADMIN_COOKIE]: `${Math.floor(Date.now() / 1000) + 3600}.forged` };
  assert.equal((await get()).status, 401, "a forged session");
  g.__testCookies = { [ADMIN_COOKIE]: createAdminSession()! };
  const res = await get();
  assert.equal(res.status, 200);
  const json = (await res.json()) as { data: { backend: string; entries: { handle: string }[] } };
  assert.equal(json.data.backend, "memory");
  assert.equal(json.data.entries.length, 13);
  const csv = await (await get(true)).text();
  assert.ok(csv.startsWith('"Submitted (UTC)","Updated (UTC)","Name","X handle","Video post"'), "CSV header");
  assert.ok(csv.includes(`"'=HYPERLINK(""x"")"`), "formula cells quoted as text");
  assert.ok(csv.includes('"Yes (@someone_else)"'), "the flag is in the CSV");
  assert.ok(csv.includes('"https://x.com/Ada_L/status/1850000000000000001"'), "earlier posts in the CSV");
  g.__testCookies = {};
  n += 10;
}

console.log(`video contest: ${n} passed`);
