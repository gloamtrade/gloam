/**
 * Self-test: holder feedback after voting, and the admin Votes tab's API.
 *
 *  - Notes: HTML and control characters stripped; only a wallet with weight
 *    in an open vote can send; signed with EIP-712 by that wallet; the clock,
 *    length and category checked; a note sent twice is kept once; three per
 *    wallet per day; the route limits each IP
 *  - /api/admin/votes: refused without an admin session; with one, every
 *    vote's tallies and ballots, every note and every connected holder (with
 *    the votes it has a ballot in), as JSON and CSV
 *  - Notes are never readable from a public route
 *
 * Uses the in-process store. Nothing is sent to any chain.
 *
 * Run from app/:  ../mcp/node_modules/.bin/tsx scripts/selftest-vote-feedback.mts
 */
import assert from "node:assert/strict";
import Module from "node:module";
import { fileURLToPath } from "node:url";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

process.env.GLOAM_PARTNERS_STORE = "memory";
process.env.GLOAM_VOTE_NO_ENS = "1";
process.env.GLOAM_VOTE_NO_CHAIN = "1";
process.env.ADMIN_ACCESS_CODE = "a-long-random-admin-code-for-the-vote-test";
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;
const stubs: Record<string, string> = {
  "server-only": fileURLToPath(new URL("./server-only-stub.cjs", import.meta.url)),
  "next/headers": fileURLToPath(new URL("./next-headers-stub.cjs", import.meta.url)),
};
const M = Module as unknown as { _resolveFilename: (req: string, ...rest: unknown[]) => string };
const resolve = M._resolveFilename;
M._resolveFilename = function (req: string, ...rest: unknown[]) {
  return stubs[req] ?? resolve.call(this, req, ...rest);
};

const core = await import("../src/lib/vote/core");
const { submitFeedback, listFeedback, FEEDBACK_PER_WALLET_PER_DAY } = await import("../src/lib/vote/feedback");
const { VoteError } = await import("../src/lib/vote/submit");
const { resetMemoryKv } = await import("../src/lib/partnersKv");
const { createAdminSession, ADMIN_COOKIE } = await import("../src/lib/adminAuth");
const { saveBallot } = await import("../src/lib/vote/store");
const { VOTES } = await import("../src/lib/vote/config");

let passed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  resetMemoryKv();
  (globalThis as { __gloamMcpRate?: Map<string, unknown> }).__gloamMcpRate?.clear();
  (globalThis as { __testCookies?: Record<string, string> }).__testCookies = {};
  await fn();
  passed++;
  console.log(`ok  ${name}`);
}
async function rejects(p: Promise<unknown>, code: string) {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof VoteError, `expected ${code}, got ${String(e)}`);
    assert.equal((e as InstanceType<typeof VoteError>).code, code);
    return;
  }
  assert.fail(`expected ${code}, but it went through`);
}

const holder = privateKeyToAccount(generatePrivateKey());
const stranger = privateKeyToAccount(generatePrivateKey());
const NOW = Date.parse("2026-10-30T12:00:00Z");
const nowSec = Math.floor(NOW / 1000);
const weight = (a: string) => (a.toLowerCase() === holder.address.toLowerCase() ? 10n ** 18n : 0n);
const ctx = { now: NOW, weight };

async function note(account: typeof holder, message: string, category = "Idea", timestamp = nowSec) {
  const typed = core.feedbackTypedData({ category, message, author: account.address, timestamp });
  const signature = await account.signTypedData(typed);
  return { author: account.address, category, message, timestamp, signature };
}

await test("notes are cleaned: no tags, no control or direction characters, capped", () => {
  assert.equal(core.cleanFeedback("<b>Hi</b> <script>alert(1)</script> there"), "Hi alert(1) there");
  assert.equal(core.cleanFeedback("a\u0000b‮c​d"), "abcd");
  assert.equal(core.cleanFeedback("  one\n\n\n\ntwo  "), "one\n\ntwo");
  assert.equal(core.cleanFeedback("x".repeat(5000)).length, core.FEEDBACK_MAX);
  assert.equal(core.cleanFeedback("1 < 2 > 0"), "1 2 0", "a comparison is not a tag");
  assert.equal(core.cleanFeedback("<img src=x onerror=alert(1)>hi<!-- c -->"), "hi");
});

await test("a holder's signed note is kept, privately", async () => {
  const sent = await submitFeedback(await note(holder, "Please add Arbitrum.\nAnd a dark mode toggle in the app.", "Feature"), ctx);
  assert.equal(sent.author, holder.address);
  const all = await listFeedback();
  assert.equal(all.length, 1);
  assert.equal(all[0]!.message, "Please add Arbitrum.\nAnd a dark mode toggle in the app.");
  assert.equal(all[0]!.category, "Feature");
});

await test("only a wallet with weight in an open vote can send, and only its own signature counts", async () => {
  await rejects(submitFeedback(await note(stranger, "hello there"), ctx), "not_holder");
  // the stranger signs, but claims the holder wrote it
  const forged = await note(stranger, "hello there");
  await rejects(submitFeedback({ ...forged, author: holder.address }, ctx), "bad_signature");
  // the holder signs one text, the request carries another
  const real = await note(holder, "original words");
  await rejects(submitFeedback({ ...real, message: "changed words" }, ctx), "bad_signature");
  await rejects(submitFeedback({ ...real, category: "Bug" }, ctx), "bad_signature");
  // with the real registry: no vote of the real config is open at a time long after they close
  await rejects(submitFeedback(await note(holder, "late note", "Idea", Math.floor(Date.parse("2030-01-01T00:00:00Z") / 1000)), { now: Date.parse("2030-01-01T00:00:00Z") }), "not_holder");
  assert.equal((await listFeedback()).length, 0);
});

await test("a wallet that adds its chain to the signed domain can send a note, as it can vote", async () => {
  const message = "from a wallet that signs with its chain id";
  const typed = core.feedbackTypedData({ category: "Idea", message, author: holder.address, timestamp: nowSec });
  const signature = await holder.signTypedData({ ...typed, domain: { ...typed.domain, chainId: 56 } });
  const sent = await submitFeedback({ author: holder.address, category: "Idea", message, timestamp: nowSec, signature }, ctx);
  assert.equal(sent.author, holder.address);
});

await test("bad input is refused", async () => {
  const ok = await note(holder, "fine note");
  await rejects(submitFeedback({ ...ok, author: "0x12" }, ctx), "bad_author");
  await rejects(submitFeedback({ ...ok, category: "Spam" }, ctx), "bad_category");
  await rejects(submitFeedback(await note(holder, "<b>bold</b>"), ctx), "unclean");
  await rejects(submitFeedback(await note(holder, "ok"), ctx), "too_short");
  await rejects(submitFeedback({ ...ok, message: "x".repeat(3000) }, ctx), "bad_message");
  await rejects(submitFeedback(await note(holder, "old note", "Idea", nowSec - 3600), ctx), "stale");
  await rejects(submitFeedback({ ...ok, signature: "0x1234" }, ctx), "bad_signature");
});

await test("a note sent twice is kept once, and a wallet sends at most three a day", async () => {
  const one = await note(holder, "first note");
  await submitFeedback(one, ctx);
  await rejects(submitFeedback(one, ctx), "duplicate");
  for (let i = 2; i <= FEEDBACK_PER_WALLET_PER_DAY; i++) await submitFeedback(await note(holder, `note number ${i}`), ctx);
  await rejects(submitFeedback(await note(holder, "one too many"), ctx), "wallet_limit");
  assert.equal((await listFeedback()).length, FEEDBACK_PER_WALLET_PER_DAY);
  // the next day the wallet can write again
  const tomorrow = NOW + 86_400_000;
  await submitFeedback(await note(holder, "a new day", "Idea", Math.floor(tomorrow / 1000)), { now: tomorrow, weight });
});

const feedbackRoute = await import("../src/app/api/vote/feedback/route");
const adminRoute = await import("../src/app/api/admin/votes/route");

await test("the feedback route limits each IP and has no public read", async () => {
  let last = 0;
  for (let i = 0; i < 7; i++) {
    last = (await feedbackRoute.POST(new Request("http://localhost/api/vote/feedback", { method: "POST", body: "{}", headers: { "x-forwarded-for": "198.51.100.4" } }))).status;
  }
  assert.equal(last, 429);
  assert.equal("GET" in feedbackRoute, false, "notes are never served from a public route");
  // a non-holder through the real route (no open vote holds this random wallet)
  const r = await feedbackRoute.POST(new Request("http://localhost/api/vote/feedback", { method: "POST", body: JSON.stringify(await note(stranger, "hello there", "Idea", Math.floor(Date.now() / 1000))), headers: { "x-forwarded-for": "198.51.100.5" } }));
  assert.equal(r.status, 403);
});

await test("the admin votes API needs an admin session", async () => {
  const res = await adminRoute.GET(new Request("http://localhost/api/admin/votes"));
  assert.equal(res.status, 401);
  (globalThis as { __testCookies?: Record<string, string> }).__testCookies = { [ADMIN_COOKIE]: "123.forged" };
  assert.equal((await adminRoute.GET(new Request("http://localhost/api/admin/votes"))).status, 401);
  for (const q of ["?format=csv&kind=votes", "?format=csv&kind=feedback", "?format=csv&kind=holders", "?download=1"]) {
    (globalThis as { __testCookies?: Record<string, string> }).__testCookies = {};
    assert.equal((await adminRoute.GET(new Request(`http://localhost/api/admin/votes${q}`))).status, 401);
  }
});

await test("with a session, the admin sees every ballot and note, and exports them", async () => {
  const v = VOTES[0]!;
  await saveBallot(v.id, { voter: holder.address, option: 1, choice: v.options[1]!, weight: (10n ** 18n).toString(), timestamp: nowSec, signature: `0x${"ab".repeat(65)}`, receivedAt: NOW });
  await submitFeedback(await note(holder, "Payroll in EURC, please.", "Feature"), ctx);
  (globalThis as { __testCookies?: Record<string, string> }).__testCookies = { [ADMIN_COOKIE]: createAdminSession()! };

  const res = await adminRoute.GET(new Request("http://localhost/api/admin/votes"));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store");
  const j = (await res.json()) as { data: { votes: { summary: { id: string; totals: { wallets: number } }; ballots: { voter: string }[] }[]; feedback: { message: string }[] } };
  const row = j.data.votes.find((x) => x.summary.id === v.id)!;
  assert.equal(row.ballots.length, 1);
  assert.equal(row.ballots[0]!.voter, holder.address);
  assert.equal(row.summary.totals.wallets, 1);
  assert.equal(j.data.feedback[0]!.message, "Payroll in EURC, please.");

  const votesCsv = await (await adminRoute.GET(new Request(`http://localhost/api/admin/votes?format=csv&kind=votes&vote=${v.id}`))).text();
  assert.ok(votesCsv.includes(holder.address) && votesCsv.includes(`0x${"ab".repeat(65)}`));
  const oneRes = await adminRoute.GET(new Request(`http://localhost/api/admin/votes?format=csv&kind=votes&vote=${v.id}`));
  assert.match(oneRes.headers.get("content-disposition") ?? "", new RegExp(`filename="gloam-votes-${v.id}-\\d{4}-\\d{2}-\\d{2}\\.csv"$`));
  // the file name comes from the vote config, never from the query as typed
  const odd = await adminRoute.GET(new Request(`http://localhost/api/admin/votes?format=csv&kind=votes&vote=${encodeURIComponent('x"; filename*=UTF-8\'\'evil.html')}`));
  assert.equal(odd.status, 200);
  assert.match(odd.headers.get("content-disposition") ?? "", /^attachment; filename="gloam-votes-all-\d{4}-\d{2}-\d{2}\.csv"$/);
  const allCsv = await (await adminRoute.GET(new Request("http://localhost/api/admin/votes?format=csv&kind=votes"))).text();
  assert.ok(allCsv.startsWith('"vote","voter"') && allCsv.includes(v.id));
  const fbRes = await adminRoute.GET(new Request("http://localhost/api/admin/votes?format=csv&kind=feedback"));
  assert.match(fbRes.headers.get("content-type") ?? "", /text\/csv/);
  assert.ok((await fbRes.text()).includes("Payroll in EURC, please."));
  const dl = await adminRoute.GET(new Request("http://localhost/api/admin/votes?download=1"));
  assert.match(dl.headers.get("content-disposition") ?? "", /attachment/);
});

await test("with a session, the admin sees every connected holder and who of them voted", async () => {
  const holders = await import("../src/lib/vote/holders");
  const v = VOTES[0]!;
  // the holder connects, then votes: the admin row shows the vote though the record predates it
  await holders.recordHolder({ address: holder.address, snapshot: (10n ** 18n).toString(), eligible: true, excluded: null, signed: [] }, null, NOW - 1000);
  await holders.recordHolder({ address: stranger.address, snapshot: "0", eligible: false, excluded: null, signed: [] }, 5n, NOW);
  await saveBallot(v.id, { voter: holder.address, option: 0, choice: v.options[0]!, weight: (10n ** 18n).toString(), timestamp: nowSec, signature: `0x${"ef".repeat(65)}`, receivedAt: NOW });

  (globalThis as { __testCookies?: Record<string, string> }).__testCookies = {};
  const denied = await adminRoute.GET(new Request("http://localhost/api/admin/votes"));
  assert.equal(denied.status, 401);
  assert.equal(JSON.stringify(await denied.json()).includes(holder.address), false);

  (globalThis as { __testCookies?: Record<string, string> }).__testCookies = { [ADMIN_COOKIE]: createAdminSession()! };
  const j = (await (await adminRoute.GET(new Request("http://localhost/api/admin/votes"))).json()) as {
    data: { holders: { address: string; eligible: boolean; voted: string[]; current: string | null }[] };
  };
  assert.equal(j.data.holders.length, 2);
  const h = j.data.holders.find((x) => x.address === holder.address)!;
  assert.deepEqual(h.voted, [v.id]);
  const s = j.data.holders.find((x) => x.address === stranger.address)!;
  assert.deepEqual(s.voted, []);
  assert.equal(s.current, "5");
  const csvRes = await adminRoute.GET(new Request("http://localhost/api/admin/votes?format=csv&kind=holders"));
  assert.match(csvRes.headers.get("content-type") ?? "", /text\/csv/);
  assert.match(csvRes.headers.get("content-disposition") ?? "", /gloam-vote-holders-/);
  const csv = await csvRes.text();
  assert.ok(csv.includes(holder.address) && csv.includes(stranger.address) && csv.includes(v.id));
});

console.log(`\n${passed} passed`);
