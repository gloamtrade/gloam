/**
 * Self-test: the "Email me Gloam updates" list (lib/updatesList, api/updates,
 * lib/updatesClient, /unsubscribe).
 *
 *  - subscribe: the email is trimmed and lowercased, kept with the UTC day,
 *    the source and an unsubscribe token, and nothing else
 *  - dedupe: the same email again (any case, any source) changes nothing and
 *    gets the same answer
 *  - no wallet data: a body with an address, wallet, sub-org or any other
 *    extra field is refused and nothing is stored; no key or value under the
 *    list's prefix holds an address, an IP or a wallet id
 *  - bad emails, oversized bodies, the bot field, the hourly limit per IP
 *  - unsubscribe by email and by link token; a used or made-up token does nothing
 *  - admin: the count and the CSV need an admin session; the CSV has email,
 *    day, source and the unsubscribe link only
 *  - the browser helper sends the email and source alone, without cookies
 *
 * Uses the in-process store (GLOAM_PARTNERS_STORE=memory); nothing reaches any host.
 *
 * Run from app/:  ../mcp/node_modules/.bin/tsx scripts/selftest-updates-list.mts
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
env.ADMIN_ACCESS_CODE = "a-long-random-admin-code-for-the-updates-selftest";
env.GLOAM_RATE_LIMIT_KEY = "ab".repeat(32);

const route = await import("../src/app/api/updates/route");
const list = await import("../src/lib/updatesList");
const { normalizeEmail } = await import("../src/lib/updatesEmail");
const { resetMemoryKv } = await import("../src/lib/partnersKv");
const { createAdminSession, ADMIN_COOKIE } = await import("../src/lib/adminAuth");

const g = globalThis as { __testCookies?: Record<string, string>; __gloamPartnersMem?: Map<string, { v: unknown }> };
let n = 0;
const PREFIX = "gloam:updates:v1:";
const WALLET = "0x1111111111111111111111111111111111111111";

function req(method: string, body: unknown, ip = "203.0.113.1", raw?: string): Request {
  return new Request("https://gloam.trade/api/updates", {
    method,
    headers: { "Content-Type": "application/json", "x-forwarded-for": ip },
    body: raw ?? JSON.stringify(body),
  });
}
async function call(method: "POST" | "DELETE", body: unknown, ip?: string, raw?: string) {
  const res = await route[method](req(method, body, ip, raw));
  const json = (await res.json()) as { ok: boolean; data?: { subscribed: boolean }; error?: { message: string } };
  return { status: res.status, json };
}

/** Every key and value the list wrote, as text. */
function stored(): { keys: string[]; text: string } {
  const mem = g.__gloamPartnersMem ?? new Map();
  const keys = [...mem.keys()].filter((k) => k.startsWith(PREFIX));
  const text = keys
    .map((k) => {
      const v = mem.get(k)?.v;
      return `${k}=${v instanceof Set ? [...v].join(",") : String(v)}`;
    })
    .join("\n");
  return { keys, text };
}

// ------------------------------------------------------------ email rules
assert.equal(normalizeEmail("  Ada@Example.COM "), "ada@example.com");
assert.equal(normalizeEmail("a.b+tag@mail.example.co.uk"), "a.b+tag@mail.example.co.uk");
for (const bad of ["", "ada", "ada@", "@example.com", "ada@example", "ada@@example.com", "ada @example.com", "a..b@example.com", "ada@-x.com", "ada@example.c0m", `${"a".repeat(65)}@example.com`, 42, null]) {
  assert.equal(normalizeEmail(bad), null, `refused: ${String(bad)}`);
  n++;
}
n += 2;

// ------------------------------------------------------------ subscribe
resetMemoryKv();
{
  const r = await call("POST", { email: "  Ada@Example.COM ", source: "sign-in" });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { ok: true, data: { subscribed: true } });
  const subs = await list.listUpdatesSubscribers();
  assert.equal(subs.length, 1);
  const s = subs[0]!;
  assert.deepEqual(Object.keys(s).sort(), ["day", "email", "source", "token"], "the email, the day, the source and the token: nothing else");
  assert.equal(s.email, "ada@example.com");
  assert.equal(s.source, "sign-in");
  assert.match(s.day, /^\d{4}-\d{2}-\d{2}$/, "a day, not a time");
  assert.equal(s.day, new Date().toISOString().slice(0, 10));
  assert.match(s.token, list.UNSUBSCRIBE_TOKEN);
  n += 9;
}

// ------------------------------------------------------------ dedupe
{
  const before = (await list.listUpdatesSubscribers())[0]!;
  const r = await call("POST", { email: "ADA@example.com", source: "site" });
  assert.deepEqual(r.json, { ok: true, data: { subscribed: true } }, "a repeat gets the same answer");
  const after = await list.listUpdatesSubscribers();
  assert.equal(after.length, 1, "one entry per email");
  assert.deepEqual(after[0], before, "first source, day and token stay");
  assert.deepEqual(await list.subscribeToUpdates("ada@example.com", "settings"), { added: false });
  await call("POST", { email: "bo@example.org", source: "settings" });
  await call("POST", { email: "cy@example.net" }, "203.0.113.2");
  const all = await list.listUpdatesSubscribers();
  assert.equal(all.length, 3);
  assert.equal(all.find((s) => s.email === "cy@example.net")?.source, "site", "no source reads as the site");
  assert.deepEqual(list.updatesSummary(all), { count: 3, bySource: { "sign-in": 1, settings: 1, site: 1 } });
  n += 7;
}

// ------------------------------------------------------------ no wallet data, ever
{
  const before = stored();
  const attempts: Record<string, unknown>[] = [
    { email: "dee@example.com", address: WALLET },
    { email: "dee@example.com", source: "sign-in", wallet: WALLET },
    { email: "dee@example.com", source: "sign-in", walletAddress: WALLET },
    { email: "dee@example.com", source: "sign-in", subOrgId: "6b3c0b0e-4a39-4c8a-9a63-0d5f2f1b9a11" },
    { email: "dee@example.com", source: "sign-in", organizationId: "org-1" },
    { email: "dee@example.com", source: "sign-in", walletId: "w-1" },
    { email: "dee@example.com", source: "sign-in", userId: "u-1" },
    { email: "dee@example.com", source: "sign-in", ip: "198.51.100.7" },
    { email: "dee@example.com", source: "sign-in", meta: { address: WALLET } },
  ];
  for (const body of attempts) {
    const r = await call("POST", body, "203.0.113.3");
    assert.equal(r.status, 400, `refused: ${Object.keys(body).join(", ")}`);
    assert.equal(r.json.ok, false);
    n += 2;
  }
  assert.equal((await call("DELETE", { email: "ada@example.com", address: WALLET }, "203.0.113.3")).status, 400, "unsubscribe takes no extra field either");
  assert.equal((await call("POST", [{ email: "dee@example.com" }], "203.0.113.3")).status, 400, "an array is not a body");
  assert.equal((await call("POST", null, "203.0.113.3")).status, 400);
  const after = stored();
  assert.deepEqual(after, before, "nothing stored by a refused body");
  assert.equal((await list.listUpdatesSubscribers()).some((s) => s.email === "dee@example.com"), false);
  // the list's own keys and values: emails, days, sources and tokens only
  assert.ok(!/0x[0-9a-f]{40}/i.test(after.text), "no address under the list's prefix");
  assert.ok(!after.text.includes("203.0.113."), "no IP under the list's prefix");
  assert.ok(!after.keys.some((k) => k.includes("@")), "keys hold a hash, not the email");
  n += 8;
}

// ------------------------------------------------------------ bad input, bots, limits
{
  assert.equal((await call("POST", { email: "not-an-email", source: "site" }, "203.0.113.4")).status, 400);
  assert.equal((await call("POST", { email: 42 }, "203.0.113.4")).status, 400);
  assert.equal((await call("POST", null, "203.0.113.4", "{nope")).status, 400, "bad JSON");
  assert.equal((await call("POST", null, "203.0.113.4", JSON.stringify({ email: "x".repeat(2000) + "@example.com" }))).status, 413);
  const bot = await call("POST", { email: "bot@example.com", source: "site", hp: "filled" }, "203.0.113.4");
  assert.deepEqual(bot.json, { ok: true, data: { subscribed: true } }, "a bot sees success");
  assert.equal((await list.listUpdatesSubscribers()).some((s) => s.email === "bot@example.com"), false, "and nothing is kept");
  n += 6;

  // ten sign-ups an hour per IP
  for (let i = 0; i < 10; i++) assert.equal((await call("POST", { email: `p${i}@example.com`, source: "site" }, "198.51.100.9")).status, 200);
  const over = await call("POST", { email: "p10@example.com", source: "site" }, "198.51.100.9");
  assert.equal(over.status, 429, "the eleventh in an hour is refused");
  assert.equal((await list.listUpdatesSubscribers()).some((s) => s.email === "p10@example.com"), false);
  assert.equal((await call("POST", { email: "p10@example.com", source: "site" }, "198.51.100.10")).status, 200, "another IP is fine");
  n += 13;
}

// ------------------------------------------------------------ unsubscribe
{
  const ada = (await list.listUpdatesSubscribers()).find((s) => s.email === "ada@example.com")!;
  assert.equal(await list.unsubscribeToken("x".repeat(32)), false, "a made-up token does nothing");
  assert.equal(await list.unsubscribeToken("short"), false);
  assert.equal(await list.unsubscribeToken(ada.token), true, "the link takes the email off");
  assert.equal(await list.unsubscribeToken(ada.token), false, "a used link does nothing");
  assert.equal((await list.listUpdatesSubscribers()).some((s) => s.email === "ada@example.com"), false);
  assert.ok(!stored().keys.some((k) => k.endsWith(ada.token)), "the token is gone too");

  // by token through the route
  const bo = (await list.listUpdatesSubscribers()).find((s) => s.email === "bo@example.org")!;
  assert.deepEqual((await call("DELETE", { token: bo.token }, "203.0.113.5")).json, { ok: true, data: { subscribed: false } });
  assert.equal((await list.listUpdatesSubscribers()).some((s) => s.email === "bo@example.org"), false);

  // by email, and the same answer for an email that was never on the list
  const gone = await call("DELETE", { email: "CY@example.net" }, "203.0.113.5");
  const never = await call("DELETE", { email: "never@example.com" }, "203.0.113.5");
  assert.deepEqual(gone.json, never.json, "no answer says who is on the list");
  assert.equal((await list.listUpdatesSubscribers()).some((s) => s.email === "cy@example.net"), false);
  assert.equal((await call("DELETE", { email: "nope" }, "203.0.113.5")).status, 400);

  // subscribing again after leaving works, with a new token
  await call("POST", { email: "ada@example.com", source: "settings" }, "203.0.113.6");
  const back = (await list.listUpdatesSubscribers()).find((s) => s.email === "ada@example.com")!;
  assert.equal(back.source, "settings");
  assert.notEqual(back.token, ada.token);
  n += 13;
}

// ------------------------------------------------------------ the unsubscribe page
{
  const sub = (await list.listUpdatesSubscribers())[0]!;
  let page: { default: (p: { searchParams: Promise<{ token?: string }> }) => Promise<unknown> } | null = null;
  try {
    page = await import("../src/app/unsubscribe/page");
  } catch {
    page = null; // the page's components need the Next bundler; the lib call above covers it
  }
  if (page) {
    await page.default({ searchParams: Promise.resolve({ token: sub.token }) });
    assert.equal((await list.listUpdatesSubscribers()).some((s) => s.email === sub.email), false, "GET /unsubscribe?token= removes it");
    await page.default({ searchParams: Promise.resolve({}) });
    n += 1;
  } else {
    console.log("  (unsubscribe page not importable under tsx; covered by unsubscribeToken)");
  }
}

// ------------------------------------------------------------ admin
{
  const adminGet = (q = "") => route.GET(new Request(`https://gloam.trade/api/updates${q}`));
  g.__testCookies = {};
  assert.equal((await adminGet()).status, 401, "no session, no list");
  assert.equal((await adminGet("?format=csv")).status, 401, "no session, no CSV");
  g.__testCookies = { [ADMIN_COOKIE]: `${Math.floor(Date.now() / 1000) + 3600}.forged` };
  assert.equal((await adminGet("?format=csv")).status, 401, "a forged session is refused");
  g.__testCookies = { [ADMIN_COOKIE]: "" };
  assert.equal((await adminGet()).status, 401);

  g.__testCookies = { [ADMIN_COOKIE]: createAdminSession()! };
  const summary = (await (await adminGet()).json()) as { ok: boolean; data: { count: number; bySource: Record<string, number>; backend: string } };
  const subs = await list.listUpdatesSubscribers();
  assert.equal(summary.ok, true);
  assert.equal(summary.data.count, subs.length);
  assert.ok(!JSON.stringify(summary).includes("@"), "the summary is counts only");
  const csvRes = await adminGet("?format=csv");
  assert.equal(csvRes.status, 200);
  assert.match(csvRes.headers.get("Content-Type") ?? "", /text\/csv/);
  const csv = await csvRes.text();
  const lines = csv.trim().split("\r\n");
  assert.equal(lines[0], '"Email","Signed up (UTC day)","Source","Unsubscribe link"');
  assert.equal(lines.length, subs.length + 1);
  for (const line of lines.slice(1)) {
    const cells = line.split('","');
    assert.equal(cells.length, 4);
    assert.match(cells[3]!, /^https:\/\/gloam\.trade\/unsubscribe\?token=[A-Za-z0-9_-]{32}"$/);
  }
  assert.ok(!/0x[0-9a-f]{40}/i.test(csv), "no address in the CSV");
  assert.equal(list.updatesCsv([{ email: "=cmd@example.com", day: "2026-11-05", source: "site", token: "t".repeat(32) }]).split("\r\n")[1]?.startsWith(`"'=cmd`), true, "a formula-looking cell is quoted as text");
  g.__testCookies = {};
  n += 14;
}

// ------------------------------------------------------------ the browser helper
{
  const client = await import("../src/lib/updatesClient");
  const sent: { url: string; init: RequestInit }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    sent.push({ url, init });
    return new Response(JSON.stringify({ ok: true, data: { subscribed: true } }), { status: 200 });
  }) as typeof fetch;
  try {
    assert.deepEqual(await client.subscribeToUpdates(" Eve@Example.com ", "sign-in"), { ok: true });
    assert.deepEqual(await client.unsubscribeFromUpdates("eve@example.com"), { ok: true });
    assert.equal((await client.subscribeToUpdates("nope", "site")).ok, false);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(sent.length, 2, "a bad email is never sent");
  assert.equal(sent[0]!.url, "/api/updates");
  assert.equal(sent[0]!.init.method, "POST");
  assert.deepEqual(JSON.parse(String(sent[0]!.init.body)), { email: "eve@example.com", source: "sign-in" }, "the email and source alone");
  assert.equal(sent[0]!.init.credentials, "omit", "no cookies go with it");
  assert.equal(sent[1]!.init.method, "DELETE");
  assert.deepEqual(JSON.parse(String(sent[1]!.init.body)), { email: "eve@example.com" });
  n += 10;
}

console.log(`updates list: ${n} passed`);
