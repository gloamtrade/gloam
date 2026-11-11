/**
 * Self-test: the Blocktronics token check (lib/blocktronics, lib/tokenInsight,
 * /api/token-insight, the swap card, Glim's lib/telegramBot/tokenCheck).
 *
 *  - off while BLOCKTRONICS_API_KEY is unset (or BLOCKTRONICS_ENABLED says no):
 *    no call anywhere, the route is a 404, the card asks nothing more, Glim says
 *    the check isn't available yet
 *  - field mapping from the /v1/tools answers (token_overview, token_series,
 *    get_sections): grade (withheld, provisional, out of range), holders
 *    (series columns, rows, summary, the overview's own figure, which saves
 *    the series call), launch bundles (ready, sample, none), another token's
 *    answer, the { tool, ok, charged, data } envelope
 *  - the cache: a miss calls, a hit calls nothing, in memory and in Redis
 *    (another instance), 12 hours for the grade and holders, 24 for the
 *    bundles, 30 minutes for a token that isn't indexed, a day for one
 *    Blocktronics doesn't support, 5 minutes for a failed call; one check at a
 *    time per token
 *  - upstream errors: 5xx, a timeout, bad JSON, a refused key, an empty
 *    balance and a rate limit (the last three pause every call), the daily cap
 *  - what goes out: only the chain and the token address, to
 *    api.blocktronics.xyz, with the key in the Authorization header and nowhere
 *    else; never an IP, a cookie, a wallet or a query parameter the browser
 *    added; the key never in a log line or an answer
 *  - the route: only Gloam's own tokens, only the fields the card shows, the
 *    per-IP limit, CDN headers
 *  - Glim: what counts as a token check, the answer text (never "safe"), the
 *    on-chain check that keeps wallets away from Blocktronics, the copycat,
 *    and whole updates in the group and in a team DM
 *
 * fetch is stubbed (Blocktronics, Upstash, the RPCs, Telegram) with throwaway
 * values made here. Nothing leaves this process.
 *
 * Run from app/:  ../mcp/node_modules/.bin/tsx scripts/selftest-blocktronics.mts
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { encodeAbiParameters } from "viem";

const env = process.env as Record<string, string | undefined>;
env.NODE_ENV = "test";
env.GLOAM_PARTNERS_STORE = "memory";
env.GLOAM_RATE_LIMIT_KEY = "ab".repeat(32);
delete env.UPSTASH_REDIS_REST_URL;
delete env.UPSTASH_REDIS_REST_TOKEN;
delete env.BLOCKTRONICS_API_KEY;
delete env.BLOCKTRONICS_ENABLED;
delete env.BLOCKTRONICS_DAILY_CALLS;
for (const id of [4663, 8453, 1]) delete env[`GLOAM_RPC_URL_${id}`];
env.TELEGRAM_BOT_TOKEN = `1000:${Math.random().toString(36).slice(2)}`;
env.TELEGRAM_BUY_ALERTS = "0";
delete env.ANTHROPIC_API_KEY;
delete env.TELEGRAM_GROUP_ID;
delete env.TELEGRAM_OWNER_IDS;
delete env.TELEGRAM_ADMIN_HANDLES;
delete env.TELEGRAM_ADMIN_IDS;
env.TELEGRAM_OWNER_HANDLES = "dukedotsol";

const KEY = `btak_${Array.from({ length: 32 }, () => "abcdefghijklmnopqrstuvwxyz0123456789"[Math.floor(Math.random() * 36)]).join("")}`;

// ---------------------------------------------------------------- tokens

const GLOAM = "0xdcd885f5c60b3ad49f6d58718696417314e8724d";
const PONS = "0x39dbed3a2bd333467115de45665cc57f813c4571";
const CASHCAT = "0x020bfc650a365f8bb26819deaabf3e21291018b4";
const ORBIO = "0xaa07a0e9209e16ac99708c3ec70159c6ef3128a3";
const AI = "0x2e8c31162b855a2ffa90f6f8634643ad6f111e18";
const VIRTUAL = "0xc6911796042b15d7fa4f6cde69e245ddcd3d9c31";
const GRIFT = "0x9f4ba41f91a59a34e17ee8c9eb3a51363b11abd5";
const BDX = "0x6ad12e761b438bea3ea09f6c6266556bb24c2181";
const USDG_RH = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
const WETH_RH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";
const NVDA_RH = "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec";
const COPYCAT = "0x661041ee2bd13d1d9e5dfab5d2d0ca7d1e9f8629";
const GLOAM_CHECKSUM = "0xDcD885F5c60b3aD49F6D58718696417314e8724d";
/** A token Gloam doesn't list, deployed on Base only. */
const OUTSIDER = "0x1111111111111111111111111111111111111111";
/** A wallet (no code anywhere), and one delegated under EIP-7702 (code 0xef0100...). */
const WALLET = "0x2222222222222222222222222222222222222222";
const DELEGATED = "0x3333333333333333333333333333333333333333";
/** A contract that isn't a token (a Safe, say): code, but no decimals(). */
const NOT_TOKEN = "0x4444444444444444444444444444444444444444";
/** Someone's wallet and IP, which must never reach Blocktronics. */
const VIEWER = "0x5555555555555555555555555555555555555555";
const VIEWER_IP = "203.0.113.77";

// ---------------------------------------------------------------- answers

function overview(grade: Record<string, unknown> | null = { letter: "B", composite: 71.6, coverage_state: "GRADED", gates: [], pillars_present: 6 }, extra: Record<string, unknown> = {}) {
  return { grade, unavailable: {}, ...extra };
}
function series(holders: (number | null)[] = [4052, 4041, null]) {
  return { metrics: ["holders"], days: holders.length, format: "columns", summary: { holders: { last: 4041 } }, unavailable: {}, data: { day: holders.map((_, i) => `2026-11-0${i + 1}`), holders } };
}
function sections(lb: Record<string, unknown> | null = { state: "ready", sample: false, origin: "engine", data: { bundle_count: 13, bundled_supply_pct: 30.7, bundled_held_pct: 1.1, sell_pressure_usd: 48100, severity: "moderate", bundles: [] } }) {
  return { sections: lb ? { launch_bundles: lb } : {}, not_on_the_site_yet: lb ? [] : ["launch_bundles"] };
}
type Tool = "token_overview" | "token_series" | "get_sections";
/** A tool's 200 answer, as the docs show it: { tool, ok, charged, data, text, images }. */
function tool(name: Tool, chain: string, token: string, data: Record<string, unknown>) {
  return {
    tool: name,
    ok: true,
    charged: name === "get_sections" ? 5 : 2,
    data: { token: { symbol: "X", chain, address: token, terminal_url: `https://evil.example/t/${token}` }, ...data },
    text: "This pull used 2 credits.",
    images: [],
  };
}
const DEFAULT_DATA: Record<Tool, () => Record<string, unknown>> = { token_overview: overview, token_series: series, get_sections: sections };

// ---------------------------------------------------------------- fetch stub

type Out = { url: string; tool: string; method: string; headers: Record<string, string>; body: string; input: Record<string, unknown>; redirect?: string };
const outbound: Out[] = [];
const calls = (name?: Tool) => outbound.filter((o) => !name || o.tool === name).length;
/** What Blocktronics answers next: by "<tool>:<token>", then "*:<token>"; the default is a full answer. */
const upstream = new Map<string, () => Response | Promise<Response>>();
let upstreamDefault: (name: Tool, chain: string, token: string) => Response | Promise<Response> = (name, chain, token) =>
  json(tool(name, chain, token, DEFAULT_DATA[name]()));
const json = (v: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(v), { status, headers: { "Content-Type": "application/json", ...headers } });

/** The stubbed Upstash: GET, SET (EX), INCR, EXPIRE, with a clock the test moves. */
let clock = Date.now();
const redis = new Map<string, { v: string; exp: number | null }>();
const redisCmds: (string | number)[][] = [];
function redisRun(cmd: (string | number)[]): unknown {
  redisCmds.push(cmd);
  const [name, key, ...rest] = cmd.map(String);
  const live = () => {
    const e = redis.get(key!);
    if (e && e.exp !== null && e.exp <= clock) {
      redis.delete(key!);
      return null;
    }
    return e ?? null;
  };
  switch (name!.toUpperCase()) {
    case "GET":
      return live()?.v ?? null;
    case "SET": {
      const ex = rest[1]?.toUpperCase() === "EX" ? Number(rest[2]) : null;
      redis.set(key!, { v: rest[0]!, exp: ex ? clock + ex * 1000 : null });
      return "OK";
    }
    case "INCR": {
      const e = live();
      const n = Number(e?.v ?? 0) + 1;
      redis.set(key!, { v: String(n), exp: e?.exp ?? null });
      return n;
    }
    case "EXPIRE": {
      const e = live();
      if (e && (rest[1] !== "NX" || e.exp === null)) e.exp = clock + Number(rest[0]) * 1000;
      return e ? 1 : 0;
    }
    default:
      return null;
  }
}

/** The stubbed chains: which addresses hold code, and which answer decimals() and symbol(). */
const tokensOn: Record<string, Record<string, string>> = {
  robinhood: { [PONS]: "PONS", [GLOAM]: "GLOAM" },
  base: { [OUTSIDER]: "OUTS", [BDX]: "BDX" },
  ethereum: { [BDX]: "BDX" },
};
const contractsOn: Record<string, Set<string>> = { robinhood: new Set([NOT_TOKEN]), base: new Set(), ethereum: new Set() };
const rpcCalls: { chain: string; method: string; to: string }[] = [];

/** Telegram: what was sent, and what else the bot did. */
const tg: { method: string; body: Record<string, unknown> }[] = [];
let nextId = 1;
const BOT = { id: 1000, is_bot: true, first_name: "Glim", username: "glim_gloam_bot" };

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const bodyText = typeof init?.body === "string" ? init.body : "";
  const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
  if (url.host === "api.blocktronics.xyz") {
    const name = url.pathname.replace("/v1/tools/", "") as Tool;
    const input = JSON.parse(bodyText) as Record<string, unknown>;
    outbound.push({ url: url.href, tool: name, method: init?.method ?? "GET", headers, body: bodyText, input, redirect: init?.redirect });
    const [chain, token] = String(input.token).split(":");
    const next = upstream.get(`${name}:${token}`) ?? upstream.get(`*:${token}`);
    return next ? next() : upstreamDefault(name, chain!, token!);
  }
  if (url.host === "redis.test") {
    const cmds = JSON.parse(bodyText) as (string | number)[][] | (string | number)[];
    if (url.pathname === "/pipeline") return json((cmds as (string | number)[][]).map((c) => ({ result: redisRun(c) })));
    return json({ result: redisRun(cmds as (string | number)[]) });
  }
  if (url.host === "api.telegram.org") {
    const method = url.pathname.split("/").pop()!;
    const body = bodyText ? (JSON.parse(bodyText) as Record<string, unknown>) : {};
    tg.push({ method, body });
    if (method === "getMe") return json({ ok: true, result: BOT });
    if (method === "sendMessage") return json({ ok: true, result: { message_id: 90_000 + nextId++ } });
    if (method === "getChatAdministrators") return json({ ok: true, result: [] });
    return json({ ok: true, result: true });
  }
  // a JSON-RPC read on one of the three mainnets
  const rpc = bodyText ? (JSON.parse(bodyText) as { id: number; method: string; params: unknown[] }) : null;
  if (rpc?.method) {
    const chain = url.host.includes("robinhood") ? "robinhood" : url.host.includes("base") ? "base" : "ethereum";
    const reply = (result: unknown) => json({ jsonrpc: "2.0", id: rpc.id, result });
    if (rpc.method === "eth_chainId") return reply(chain === "robinhood" ? "0x1237" : chain === "base" ? "0x2105" : "0x1");
    if (rpc.method === "eth_getCode") {
      const to = String(rpc.params[0]).toLowerCase();
      rpcCalls.push({ chain, method: "getCode", to });
      if (to === DELEGATED) return reply(`0xef0100${"ab".repeat(20)}`);
      return reply(tokensOn[chain]![to] || contractsOn[chain]!.has(to) ? "0x6080604052" : "0x");
    }
    if (rpc.method === "eth_call") {
      const call = rpc.params[0] as { to: string; data: string };
      const to = call.to.toLowerCase();
      rpcCalls.push({ chain, method: "call", to });
      const symbol = tokensOn[chain]![to];
      if (!symbol) return reply("0x");
      if (call.data.startsWith("0x313ce567")) return reply(encodeAbiParameters([{ type: "uint8" }], [18]));
      if (call.data.startsWith("0x95d89b41")) return reply(encodeAbiParameters([{ type: "string" }], [symbol]));
      return reply("0x");
    }
    return reply(null);
  }
  throw new Error(`selftest-blocktronics: unexpected fetch to ${url.host}`);
}) as typeof fetch;
void realFetch;

/** Every log line, so the key can be looked for in them. */
const logs: string[] = [];
for (const level of ["log", "warn", "error", "info", "debug"] as const) {
  const real = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    logs.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    if (level === "log") real(...args);
  };
}

const bt = await import("../src/lib/blocktronics");
const ti = await import("../src/lib/tokenInsight");
const route = await import("../src/app/api/token-insight/route");
const glim = await import("../src/lib/telegramBot/tokenCheck");
const { handleUpdate } = await import("../src/lib/telegramBot/bot");
const { screen } = await import("../src/lib/telegramBot/moderation");
const { resetMemoryKv } = await import("../src/lib/partnersKv");

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  await fn();
  passed++;
  console.log(`ok  ${name}`);
}

function reset() {
  outbound.length = 0;
  upstream.clear();
  upstreamDefault = (name, chain, token) => json(tool(name, chain, token, DEFAULT_DATA[name]()));
  redis.clear();
  redisCmds.length = 0;
  rpcCalls.length = 0;
  tg.length = 0;
  clock = Date.now();
  bt.resetBlocktronicsMemory();
  resetMemoryKv();
  (globalThis as { __gloamMcpRate?: Map<string, unknown> }).__gloamMcpRate?.clear();
  env.BLOCKTRONICS_API_KEY = KEY;
  delete env.BLOCKTRONICS_ENABLED;
  delete env.BLOCKTRONICS_DAILY_CALLS;
  delete env.UPSTASH_REDIS_REST_URL;
  delete env.UPSTASH_REDIS_REST_TOKEN;
}
function withRedis() {
  env.UPSTASH_REDIS_REST_URL = "https://redis.test";
  env.UPSTASH_REDIS_REST_TOKEN = `t-${Math.random().toString(36).slice(2)}`;
}
const get = (q: string, headers: Record<string, string> = {}) =>
  route.GET(new Request(`https://gloam.trade/api/token-insight?${q}`, { headers: { "x-forwarded-for": VIEWER_IP, ...headers } }));
const H = 3_600_000;

// ---------------------------------------------------------------- the switch

await test("no key: off everywhere, and nothing is called", async () => {
  reset();
  delete env.BLOCKTRONICS_API_KEY;
  assert.equal(bt.blocktronicsEnabled(), false);
  assert.deepEqual(await bt.tokenInsight("robinhood", PONS), { state: "off" });
  const res = await get(`chain=robinhood&token=${PONS}`);
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: "disabled" });
  assert.equal(res.headers.get("cache-control"), "no-store");
  const said = await glim.answerTokenCheck({ address: null, symbol: "PONS", chain: null }, "Ada");
  assert.equal(said, "Token checks aren't available yet, Ada.");
  assert.ok((await glim.answerTokenCheck({ address: null, symbol: "GLOAM", chain: null }, "Ada")).includes("gloam.trade/token"), "for $GLOAM, where its facts are");
  assert.equal(outbound.length + rpcCalls.length, 0);
});

await test("a key that isn't one line of printable text, or BLOCKTRONICS_ENABLED=0, keeps it off", async () => {
  for (const bad of ["", "   ", "short", `${KEY}\nX-Other: 1`, `btak_ ${"a".repeat(31)}`]) {
    reset();
    env.BLOCKTRONICS_API_KEY = bad;
    assert.equal(bt.blocktronicsEnabled(), false, JSON.stringify(bad));
  }
  for (const off of ["0", "false", "OFF", "no"]) {
    reset();
    env.BLOCKTRONICS_ENABLED = off;
    assert.equal(bt.blocktronicsEnabled(), false, off);
    assert.equal((await get(`chain=robinhood&token=${PONS}`)).status, 404);
  }
  reset();
  env.BLOCKTRONICS_API_KEY = `  ${KEY}  `;
  env.BLOCKTRONICS_ENABLED = "1";
  assert.equal(bt.blocktronicsEnabled(), true, "trimmed, and 1 is on");
  assert.equal(outbound.length, 0);
});

// ---------------------------------------------------------------- mapping

await test("field mapping: a full check (overview, holder series, launch bundles)", async () => {
  reset();
  const r = await bt.tokenInsight("robinhood", PONS);
  assert.deepEqual(r, {
    state: "ok",
    insight: {
      chain: "robinhood",
      token: PONS,
      grade: { letter: "B", score: 72, provisional: false },
      holders: 4041,
      bundles: { count: 13, heldPct: 1.1 },
      url: `https://blocktronics.xyz/t/robinhood/${PONS}`,
    },
  });
  assert.ok(!JSON.stringify(r).includes("evil.example"), "the link is built here, never taken from the answer");
  assert.deepEqual(outbound.map((o) => o.tool), ["token_overview", "token_series", "get_sections"]);
});

await test("field mapping: the overview's own holder count saves the series call", async () => {
  reset();
  upstream.set(`token_overview:${PONS}`, () => json(tool("token_overview", "robinhood", PONS, overview(undefined, { kpis: { holders: { value: 3210, change_pct: 4.2 } } }))));
  const r = await bt.tokenInsight("robinhood", PONS);
  assert.ok(r.state === "ok" && r.insight.holders === 3210);
  assert.deepEqual(outbound.map((o) => o.tool), ["token_overview", "get_sections"]);
});

await test("field mapping: the grade is withheld, provisional, or out of range", () => {
  const grade = (g: Record<string, unknown> | null) => bt.gradeOf(tool("token_overview", "robinhood", PONS, overview(g)));
  assert.equal(grade({ letter: null, composite: 40, coverage_state: "INSUFFICIENT" }), null, "withheld is no grade, not a low one");
  assert.equal(grade({ letter: "C", composite: 50, coverage_state: "INSUFFICIENT" }), null);
  assert.deepEqual(grade({ letter: "b", composite: 64.4, coverage_state: "PROVISIONAL" }), { letter: "B", score: 64, provisional: true });
  assert.equal(grade({ letter: "F", composite: 10 }), null, "only A to E");
  assert.deepEqual(grade({ letter: "A", composite: 140 }), { letter: "A", score: null, provisional: false }, "a composite outside 0 to 100 is left out");
  assert.deepEqual(grade({ letter: "E", composite: "12" }), { letter: "E", score: null, provisional: false });
  assert.equal(grade(null), null);
  assert.deepEqual(bt.gradeOf(overview()), { letter: "B", score: 72, provisional: false }, "bare data reads the same as the envelope");
});

await test("field mapping: holders from the series (a missing day stays missing), its rows, its summary, or the overview's figures", () => {
  assert.equal(bt.seriesHolders(series([100, 120, null])), 120, "the last day with a figure");
  assert.equal(bt.seriesHolders(tool("token_series", "robinhood", PONS, series([7, 8]))), 8, "inside the envelope");
  assert.equal(bt.seriesHolders({ format: "rows", data: [{ day: "a", holders: 7 }, { day: "b", holders: 9 }, { day: "c", holders: null }] }), 9);
  assert.equal(bt.seriesHolders({ summary: { holders: { last: 55 } }, data: { day: [] } }), 55);
  assert.equal(bt.seriesHolders(series([-5])), 4041, "never a negative count: the summary instead");
  assert.equal(bt.seriesHolders({ data: { holders: [null] } }), null);
  assert.equal(bt.overviewHolders(overview(undefined, { holders: 12 })), 12);
  assert.equal(bt.overviewHolders(overview(undefined, { figures: { holders: { last: 40 } } })), 40);
  assert.equal(bt.overviewHolders(overview(undefined, { kpis: { holders_ge_100: 9 } })), null, "only a figure named holders");
});

await test("field mapping: launch bundles only when ready and not sample data; none found reads as 0%", () => {
  const b = (lb: Record<string, unknown> | null) => bt.bundlesOf(tool("get_sections", "robinhood", PONS, sections(lb)));
  assert.deepEqual(b(undefined as never), { count: 13, heldPct: 1.1 });
  assert.equal(b(null), null, "not on the site for this token");
  assert.equal(b({ state: "unavailable", data: { bundle_count: 3, bundled_held_pct: 5 } }), null);
  assert.equal(b({ state: "ready", sample: true, data: { bundle_count: 3, bundled_held_pct: 5 } }), null, "sample data is development data");
  assert.deepEqual(b({ state: "ready", data: { bundle_count: 0, bundled_held_pct: null } }), { count: 0, heldPct: 0 });
  assert.deepEqual(b({ state: "ready", data: { bundle_count: 2, bundled_held_pct: 140 } }), { count: 2, heldPct: null });
  assert.deepEqual(bt.bundlesOf({ launch_bundles: { state: "ready", data: { bundle_count: 1, bundled_held_pct: 9.25 } } }), { count: 1, heldPct: 9.25 }, "a bare sections map");
  assert.equal(ti.bundlesText({ count: 0, heldPct: 0 }), "None found");
  assert.equal(ti.bundlesText({ count: 4, heldPct: 0.04 }), "under 0.1% of supply");
  assert.equal(ti.bundlesText({ count: 4, heldPct: 31.4 }), "31% of supply");
  assert.equal(ti.bundlesText({ count: 4, heldPct: null }), null);
});

await test("field mapping: another token's answer, a family, and nothing to show", async () => {
  reset();
  upstream.set(`*:${PONS}`, () => json({ tool: "x", ok: true, charged: 2, data: { token: { address: GLOAM }, ...overview(), ...series(), ...sections() } }));
  assert.deepEqual(await bt.tokenInsight("robinhood", PONS), { state: "none", reason: "no_data" }, "never another token's figures");
  reset();
  upstream.set(`token_overview:${PONS}`, () =>
    json({ tool: "token_overview", ok: true, data: { token: { address: "0x9999999999999999999999999999999999999999", chain: "base" }, family: { chains: [{ chain: "robinhood", address: PONS }] }, ...overview() } }),
  );
  assert.equal((await bt.tokenInsight("robinhood", PONS)).state, "ok", "a family that includes this token answers for it");
  reset();
  upstream.set(`token_overview:${PONS}`, () => json(tool("token_overview", "robinhood", PONS, overview(null))));
  upstream.set(`token_series:${PONS}`, () => json(tool("token_series", "robinhood", PONS, { data: { holders: [null] } })));
  upstream.set(`get_sections:${PONS}`, () => json(tool("get_sections", "robinhood", PONS, sections(null))));
  assert.deepEqual(await bt.tokenInsight("robinhood", PONS), { state: "none", reason: "no_data" });
  reset();
  upstream.set(`get_sections:${PONS}`, () => json(tool("get_sections", "robinhood", PONS, sections(null))));
  const r = await bt.tokenInsight("robinhood", PONS);
  assert.ok(r.state === "ok" && r.insight.bundles === null, "no bundles section: the rest still shows");
});

// ---------------------------------------------------------------- what goes out

await test("the requests: the chain and the token, to api.blocktronics.xyz/v1/tools, the key only in Authorization", async () => {
  reset();
  const res = await get(`chain=robinhood&token=${PONS.toUpperCase().replace("0X", "0x")}&wallet=${VIEWER}`, {
    cookie: `gloam_session=abc; wallet=${VIEWER}`,
    "user-agent": "viewer-agent/1.0",
    referer: `https://gloam.trade/app/vault?wallet=${VIEWER}`,
  });
  assert.equal(res.status, 200);
  assert.deepEqual(
    outbound.map((o) => [o.url, o.input]),
    [
      ["https://api.blocktronics.xyz/v1/tools/token_overview", { token: `robinhood:${PONS}` }],
      ["https://api.blocktronics.xyz/v1/tools/token_series", { token: `robinhood:${PONS}`, metrics: ["holders"], days: 7 }],
      ["https://api.blocktronics.xyz/v1/tools/get_sections", { token: `robinhood:${PONS}`, section: "launch_bundles" }],
    ],
  );
  for (const out of outbound) {
    assert.equal(out.method, "POST");
    assert.equal(out.redirect, "error", "a redirect never carries the key elsewhere");
    assert.deepEqual(Object.keys(out.headers).sort(), ["accept", "authorization", "content-type"]);
    assert.equal(out.headers.authorization, `Bearer ${KEY}`);
    assert.equal(out.headers["content-type"], "application/json");
    const everything = JSON.stringify(out).toLowerCase();
    for (const leak of [VIEWER, VIEWER_IP, "gloam_session", "viewer-agent", "referer", "cookie"]) assert.ok(!everything.includes(leak.toLowerCase()), `no ${leak}`);
    assert.ok(!out.url.includes(KEY) && !out.body.includes(KEY), "the key is in no URL and no body");
  }
});

await test("the route answers only the card's fields, with CDN headers", async () => {
  reset();
  const res = await get(`chain=robinhood&token=${PONS}`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("cache-control") ?? "", /^public, s-maxage=3600/);
  const body = (await res.json()) as { insight: Record<string, unknown> };
  assert.deepEqual(Object.keys(body), ["insight"]);
  assert.deepEqual(Object.keys(body.insight).sort(), ["bundles", "chain", "grade", "holders", "token", "url"]);
  assert.ok(!JSON.stringify(body).includes(KEY));
  assert.deepEqual(ti.parseInsight(body.insight), body.insight, "what the card reads back is what was sent");
  upstream.set(`token_overview:${GLOAM}`, () => json({ code: "tool_error", error: "is not in the Blocktronics cache" }, 400));
  const none = await get(`chain=robinhood&token=${GLOAM}`);
  assert.equal(none.status, 200);
  assert.deepEqual(await none.json(), { insight: null, reason: "not_indexed" });
  assert.match(none.headers.get("cache-control") ?? "", /s-maxage=600/);
});

await test("the route: only Gloam's own checkable tokens, on the three chains; bad input is a 400", async () => {
  reset();
  for (const q of ["chain=tempo&token=" + PONS, "chain=robinhood&token=0x123", "chain=robinhood", "token=" + PONS, `chain=robinhood&token=0x${"0".repeat(40)}`]) {
    assert.equal((await get(q)).status, 400, q);
  }
  for (const t of [USDG_RH, WETH_RH, NVDA_RH, OUTSIDER, WALLET]) {
    const res = await get(`chain=robinhood&token=${t}`);
    assert.equal(res.status, 404, t);
    assert.deepEqual(await res.json(), { error: "not_offered" });
  }
  assert.equal((await get(`chain=base&token=${PONS}`)).status, 404, "PONS is a Robinhood Chain token");
  assert.equal(outbound.length, 0, "nothing was asked about any of them");
  assert.equal((await get(`chain=base&token=${BDX}`)).status, 200);
  assert.equal((await get(`chain=ethereum&token=${BDX}`)).status, 200);
});

await test("the route holds each IP to 30 a minute", async () => {
  reset();
  for (let i = 0; i < 30; i++) assert.equal((await get(`chain=robinhood&token=${PONS}`, { "x-forwarded-for": "198.51.100.7" })).status, 200, `read ${i + 1}`);
  const over = await get(`chain=robinhood&token=${PONS}`, { "x-forwarded-for": "198.51.100.7" });
  assert.equal(over.status, 429);
  assert.ok(Number(over.headers.get("retry-after")) > 0);
  assert.equal((await get(`chain=robinhood&token=${PONS}`, { "x-forwarded-for": "198.51.100.8" })).status, 200, "another IP is fine");
  assert.equal(outbound.length, 3, "and Blocktronics heard about it once (three tools)");
});

// ---------------------------------------------------------------- cache

await test("cache: a miss calls, a hit calls nothing; grade and holders after 12 hours, bundles after 24", async () => {
  reset();
  const t0 = Date.now();
  const first = await bt.tokenInsight("robinhood", PONS, t0);
  assert.equal(first.state, "ok");
  assert.equal(calls(), 3);
  assert.deepEqual(await bt.tokenInsight("robinhood", PONS, t0 + 11 * H), first);
  assert.equal(calls(), 3, "a hit");
  await bt.tokenInsight("robinhood", PONS, t0 + 12 * H + 1_000);
  assert.deepEqual(outbound.slice(3).map((o) => o.tool), ["token_overview", "token_series"], "the grade and holders again, the bundles still kept");
  await bt.tokenInsight("robinhood", PONS, t0 + 24 * H + 2_000);
  assert.deepEqual(outbound.slice(5).map((o) => o.tool), ["token_overview", "token_series", "get_sections"]);
  await bt.tokenInsight("robinhood", GLOAM, t0);
  assert.equal(calls(), 11, "keyed by token");
  // so a token costs at most five calls a day
});

await test("cache: one check at a time per token", async () => {
  reset();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  upstream.set(`token_overview:${PONS}`, async () => {
    await gate;
    return json(tool("token_overview", "robinhood", PONS, overview()));
  });
  const all = Promise.all([1, 2, 3, 4].map(() => bt.tokenInsight("robinhood", PONS)));
  await new Promise((r) => setTimeout(r, 20));
  release();
  const results = await all;
  assert.ok(results.every((r) => r.state === "ok"));
  assert.equal(calls(), 3);
});

await test("cache: in Redis, keyed by chain and token (12 and 24 hours); another instance reads it without a call", async () => {
  reset();
  withRedis();
  clock = Date.now();
  await bt.tokenInsight("robinhood", PONS, clock);
  assert.equal(calls(), 3);
  const sets = redisCmds.filter((c) => c[0] === "SET" && String(c[1]).startsWith("gloam:blocktronics:v1:"));
  assert.deepEqual(
    sets.map((c) => [c[1], c[3], Number(c[4])]),
    [
      [`gloam:blocktronics:v1:t:robinhood:${PONS}`, "EX", 12 * 3600],
      [`gloam:blocktronics:v1:b:robinhood:${PONS}`, "EX", 24 * 3600],
    ],
  );
  for (const c of sets) assert.ok(!String(c[2]).includes(KEY), "the key is never stored");
  // a new instance: nothing in memory
  bt.resetBlocktronicsMemory();
  const again = await bt.tokenInsight("robinhood", PONS, clock + 2 * H);
  assert.equal(again.state, "ok");
  assert.equal(calls(), 3, "served from Redis");
  // a cached copy is read field by field
  redis.set(`gloam:blocktronics:v1:t:robinhood:${GLOAM}`, {
    v: JSON.stringify({ exp: clock + H, e: { at: clock, core: { grade: { letter: "Z", score: 900 }, holders: 5, url: "https://evil.example" } } }),
    exp: clock + H,
  });
  redis.set(`gloam:blocktronics:v1:b:robinhood:${GLOAM}`, { v: JSON.stringify({ exp: clock + H, e: { at: clock, bundles: { count: 2, heldPct: 500 } } }), exp: clock + H });
  const read = await bt.tokenInsight("robinhood", GLOAM, clock);
  assert.deepEqual(read, {
    state: "ok",
    insight: { chain: "robinhood", token: GLOAM, grade: null, holders: 5, bundles: null, url: `https://blocktronics.xyz/t/robinhood/${GLOAM}` },
  });
  assert.equal(calls(), 3);
});

await test("negative cache: not indexed 30 minutes, unsupported a day, nothing to show 30 minutes", async () => {
  reset();
  withRedis();
  const t0 = (clock = Date.now());
  upstream.set(`token_overview:${PONS}`, () =>
    json({ tool: "token_overview", ok: false, code: "tool_error", error: `"robinhood:${PONS}" is not in the Blocktronics cache. Use search_tokens to find a cached token.`, charged: 0, data: null }, 400),
  );
  assert.deepEqual(await bt.tokenInsight("robinhood", PONS, t0), { state: "none", reason: "not_indexed" });
  assert.deepEqual(await bt.tokenInsight("robinhood", PONS, t0 + 29 * 60_000), { state: "none", reason: "not_indexed" });
  assert.equal(calls(), 1, "one call, and nothing more for a token it doesn't have");
  assert.equal(Number(redisCmds.find((c) => c[0] === "SET" && String(c[1]).endsWith(PONS))?.[4]), 30 * 60);
  upstream.clear();
  assert.equal((await bt.tokenInsight("robinhood", PONS, t0 + 31 * 60_000)).state, "ok", "ingested since: asked again after 30 minutes");
  assert.equal(calls(), 4);

  upstream.set(`token_overview:${GLOAM}`, () => json({ code: "unsupported_token", error: "not supported" }, 422));
  assert.deepEqual(await bt.tokenInsight("robinhood", GLOAM, t0), { state: "none", reason: "unsupported" });
  assert.deepEqual(await bt.tokenInsight("robinhood", GLOAM, t0 + 23 * H), { state: "none", reason: "unsupported" });
  assert.equal(calls(), 5);
  assert.equal(Number(redisCmds.filter((c) => c[0] === "SET" && String(c[1]).endsWith(GLOAM)).pop()?.[4]), 24 * 3600);

  upstream.set(`token_overview:${CASHCAT}`, () => json(tool("token_overview", "robinhood", CASHCAT, overview(null))));
  upstream.set(`token_series:${CASHCAT}`, () => json(tool("token_series", "robinhood", CASHCAT, { data: { holders: [null] } })));
  upstream.set(`get_sections:${CASHCAT}`, () => json(tool("get_sections", "robinhood", CASHCAT, sections(null))));
  assert.deepEqual(await bt.tokenInsight("robinhood", CASHCAT, t0), { state: "none", reason: "no_data" });
  assert.deepEqual(await bt.tokenInsight("robinhood", CASHCAT, t0 + 20 * 60_000), { state: "none", reason: "no_data" });
  assert.equal(calls(), 8);
  assert.equal(Number(redisCmds.find((c) => c[0] === "SET" && String(c[1]) === `gloam:blocktronics:v1:t:robinhood:${CASHCAT}`)?.[4]), 30 * 60);
});

// ---------------------------------------------------------------- upstream errors

await test("upstream errors: 5xx, a timeout, bad JSON or an odd status are 'unavailable', retried after 5 minutes, never stored in Redis", async () => {
  reset();
  withRedis();
  const t0 = (clock = Date.now());
  const failures: [string, () => Response | Promise<Response>][] = [
    [PONS, () => json({ code: "internal", error: "boom" }, 500)],
    [GLOAM, () => Promise.reject(new DOMException("The operation was aborted due to timeout", "TimeoutError"))],
    [CASHCAT, () => new Response("<html>gateway</html>", { status: 200 })],
    [ORBIO, () => json({ code: "unknown_tool", error: "no" }, 404)],
    [AI, () => new Response("x".repeat(1_000_001), { status: 200 })],
  ];
  for (const [token, fail] of failures) {
    upstream.set(`token_overview:${token}`, fail);
    assert.deepEqual(await bt.tokenInsight("robinhood", token, t0), { state: "unavailable" }, token);
    assert.deepEqual(await bt.tokenInsight("robinhood", token, t0 + 4 * 60_000), { state: "unavailable" });
  }
  assert.equal(calls(), failures.length, "each failed once, then waited");
  assert.ok(!redisCmds.some((c) => c[0] === "SET" && /:[tb]:/.test(String(c[1]))), "a failure stays in this instance");
  upstream.clear();
  for (const [token] of failures) assert.equal((await bt.tokenInsight("robinhood", token, t0 + 6 * 60_000)).state, "ok");
  assert.equal(calls(), failures.length * 4);

  // the overview answers and the series fails: the grade shows, the holders come 5 minutes later
  reset();
  upstream.set(`token_series:${PONS}`, () => json({ code: "unavailable" }, 503));
  const part = await bt.tokenInsight("robinhood", PONS, t0);
  assert.ok(part.state === "ok" && part.insight.grade?.letter === "B" && part.insight.holders === null);
  upstream.clear();
  assert.ok((await bt.tokenInsight("robinhood", PONS, t0 + 4 * 60_000)).state === "ok");
  assert.equal(calls(), 3);
  const full = await bt.tokenInsight("robinhood", PONS, t0 + 6 * 60_000);
  assert.ok(full.state === "ok" && full.insight.holders === 4041);
  assert.deepEqual(outbound.slice(3).map((o) => o.tool), ["token_overview", "token_series"]);

  // the bundles fail: the rest shows, and the bundles are asked again 5 minutes later
  reset();
  upstream.set(`get_sections:${PONS}`, () => json({ code: "internal" }, 500));
  const noBundles = await bt.tokenInsight("robinhood", PONS, t0);
  assert.ok(noBundles.state === "ok" && noBundles.insight.bundles === null && noBundles.insight.holders === 4041);
  upstream.clear();
  await bt.tokenInsight("robinhood", PONS, t0 + 6 * 60_000);
  assert.deepEqual(outbound.slice(3).map((o) => o.tool), ["get_sections"]);

  bt.resetBlocktronicsMemory();
  upstream.set(`token_overview:${VIRTUAL}`, () => json({ code: "unavailable" }, 503));
  const route503 = await get(`chain=robinhood&token=${VIRTUAL}`);
  assert.equal(route503.status, 503);
  assert.equal(route503.headers.get("cache-control"), "no-store");
});

await test("a refused key, an empty balance or a rate limit pauses every call", async () => {
  for (const [status, code] of [
    [401, "bad_key"],
    [403, "key_scope"],
    [402, "insufficient"],
    [200, "insufficient"],
  ] as const) {
    reset();
    withRedis();
    const t0 = (clock = Date.now());
    upstreamDefault = () => json({ tool: "token_overview", ok: false, code, error: "refused", charged: 0, data: null }, status);
    assert.deepEqual(await bt.tokenInsight("robinhood", PONS, t0), { state: "unavailable" });
    assert.deepEqual(await bt.tokenInsight("robinhood", GLOAM, t0 + 60_000), { state: "unavailable" }, "another token waits too");
    assert.equal(calls(), 1, `${status} ${code}: one call, then the pause`);
    bt.resetBlocktronicsMemory();
    assert.deepEqual(await bt.tokenInsight("robinhood", CASHCAT, t0 + 60_000), { state: "unavailable" }, "every instance, through Redis");
    assert.equal(calls(), 1);
    upstreamDefault = (name, chain, token) => json(tool(name, chain, token, DEFAULT_DATA[name]()));
    clock = t0 + 31 * 60_000;
    assert.equal((await bt.tokenInsight("robinhood", PONS, clock)).state, "ok", `${status} ${code}: back after 30 minutes`);
  }
  reset();
  const t0 = Date.now();
  upstreamDefault = () => json({ code: "rate_limited", error: "slow down" }, 429, { "Retry-After": "120" });
  assert.deepEqual(await bt.tokenInsight("robinhood", PONS, t0), { state: "unavailable" });
  assert.deepEqual(await bt.tokenInsight("robinhood", GLOAM, t0 + 90_000), { state: "unavailable" });
  assert.equal(calls(), 1);
  upstreamDefault = (name, chain, token) => json(tool(name, chain, token, DEFAULT_DATA[name]()));
  assert.equal((await bt.tokenInsight("robinhood", GLOAM, t0 + 121_000)).state, "ok", "after Retry-After");
  reset();
  const t1 = Date.now();
  upstreamDefault = () => json({ code: "credential_cap_reached", limit_period: "day", resets_at: new Date(t1 + 5 * H).toISOString() }, 429);
  await bt.tokenInsight("robinhood", PONS, t1);
  upstreamDefault = (name, chain, token) => json(tool(name, chain, token, DEFAULT_DATA[name]()));
  assert.deepEqual(await bt.tokenInsight("robinhood", GLOAM, t1 + 4 * H), { state: "unavailable" }, "until the key's cap resets");
  assert.equal((await bt.tokenInsight("robinhood", GLOAM, t1 + 5 * H + 60_000)).state, "ok");
});

await test("BLOCKTRONICS_DAILY_CALLS caps the calls a day", async () => {
  reset();
  env.BLOCKTRONICS_DAILY_CALLS = "4";
  const t0 = Date.UTC(2026, 10, 11, 10);
  assert.equal((await bt.tokenInsight("robinhood", PONS, t0)).state, "ok");
  const capped = await bt.tokenInsight("robinhood", GLOAM, t0);
  assert.ok(capped.state === "ok" && capped.insight.grade && capped.insight.holders === null, "the fourth call is the overview; then the cap");
  assert.deepEqual(await bt.tokenInsight("robinhood", CASHCAT, t0), { state: "unavailable" });
  assert.equal(calls(), 4);
  assert.equal((await bt.tokenInsight("robinhood", PONS, t0)).state, "ok", "cached tokens still answer");
  assert.equal((await bt.tokenInsight("robinhood", CASHCAT, t0 + 24 * H)).state, "ok", "the next day");
});

await test("the key is never in a log line", () => {
  assert.ok(logs.length > 0, "there were log lines to look at");
  for (const line of logs) assert.ok(!line.includes(KEY) && !line.includes(KEY.slice(5)), line.slice(0, 120));
});

// ---------------------------------------------------------------- the card's side

await test("which tokens get a check: Gloam's own tokens on Robinhood Chain, Base and Ethereum, never stablecoins, stocks or wrapped ETH", () => {
  for (const t of [GLOAM, PONS, CASHCAT, ORBIO, AI, VIRTUAL, GRIFT]) assert.ok(ti.checkableToken(4663, t), t);
  assert.ok(ti.checkableToken(4663, GLOAM.toUpperCase().replace("0X", "0x")), "any case");
  for (const t of [USDG_RH, WETH_RH, NVDA_RH, "0x0000000000000000000000000000000000000000", OUTSIDER, null, undefined]) assert.equal(ti.checkableToken(4663, t), null, String(t));
  assert.ok(ti.checkableToken(8453, BDX) && ti.checkableToken(1, BDX));
  for (const id of [4217, 46630, 84532, 11155111, 99901]) assert.equal(ti.checkableToken(id, GLOAM), null, `chain ${id}`);
  assert.equal(ti.blocktronicsTokenUrl("base", BDX.toUpperCase().replace("0X", "0x")), `https://blocktronics.xyz/t/base/${BDX}`);
});

await test("the plain line: by grade, early grades, heavy bundles; never 'safe', no em dashes", () => {
  const base: import("../src/lib/tokenInsight").TokenInsight = { chain: "robinhood", token: PONS, grade: null, holders: 10, bundles: null, url: "" };
  for (const letter of ["A", "B", "C", "D", "E"] as const) {
    const line = ti.insightLine({ ...base, grade: { letter, score: 50, provisional: false } });
    assert.ok(line.length > 20 && !/\bsafe\b/i.test(line) && !/[\u2014\u2013]/.test(line), line);
  }
  assert.match(ti.insightLine({ ...base, grade: { letter: "C", score: 50, provisional: false } }), /typical/);
  assert.match(ti.insightLine({ ...base, grade: { letter: "B", score: 64, provisional: true } }), /early and can change/);
  assert.match(ti.insightLine(base), /hasn't graded/);
  assert.match(ti.insightLine({ ...base, bundles: { count: 3, heldPct: 12.5 } }), /still hold 13% of the supply/);
  assert.doesNotMatch(ti.insightLine({ ...base, bundles: { count: 3, heldPct: 1.1 } }), /launch/i, "small bundles don't need a word");
  assert.equal(ti.gradeText({ letter: "B", score: 72, provisional: false }), "B, 72 of 100");
  assert.equal(ti.holdersText(5629), "5,629");
  assert.equal(ti.hasInsight({ ...base, holders: null }), false);
});

await test("the card and the browser never see the key or the server client", () => {
  const card = readFileSync(new URL("../src/components/app/TokenCheckCard.tsx", import.meta.url), "utf8");
  assert.ok(card.startsWith('"use client"'));
  assert.ok(!card.includes("lib/blocktronics") && !card.includes("BLOCKTRONICS"), "the card imports only lib/tokenInsight");
  assert.ok(card.includes("fetch(`/api/token-insight?chain=${chain}&token=${token}`"), "and sends only the chain and the token");
  assert.ok(card.includes('error === "disabled"') && card.includes("checksOff"), "and stops asking once checks are off");
  const swap = readFileSync(new URL("../src/components/app/VaultSwapView.tsx", import.meta.url), "utf8");
  assert.ok(swap.includes("<TokenCheckCard chainId={network.chainId} asset={toAsset} />"), "the swap card checks the token you receive");
  const shared = readFileSync(new URL("../src/lib/tokenInsight.ts", import.meta.url), "utf8");
  assert.ok(!/process\.env|fetch\(/.test(shared), "the shared module reads no env and calls nothing");
  // nothing a browser loads imports the server client, and no NEXT_PUBLIC_ name carries the key
  const src = new URL("../src/", import.meta.url).pathname;
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      return statSync(p).isDirectory() ? walk(p) : /\.(tsx?|mjs)$/.test(f) ? [p] : [];
    });
  for (const file of walk(src)) {
    const text = readFileSync(file, "utf8");
    assert.ok(!/NEXT_PUBLIC_BLOCKTRONICS/.test(text), `${file}: no public Blocktronics env`);
    if (text.startsWith('"use client"')) assert.ok(!/lib\/blocktronics["']/.test(text), `${file}: a client file imports the server client`);
  }
  const csp = readFileSync(new URL("../csp.config.mjs", import.meta.url), "utf8");
  assert.ok(!csp.includes("blocktronics"), "the CSP is unchanged: the browser never calls Blocktronics");
});

// ---------------------------------------------------------------- Glim

await test("Glim: what counts as a token check", () => {
  const ask = glim.tokenCheckAsk;
  const addr = (a: string) => ({ address: a, symbol: null, chain: null });
  assert.deepEqual(ask(`token check ${PONS}`), addr(PONS));
  assert.deepEqual(ask(`Token check: ${PONS} on Base?`), { address: PONS, symbol: null, chain: "base" });
  assert.deepEqual(ask(`check token ${OUTSIDER} on eth`), { address: OUTSIDER, symbol: null, chain: "ethereum" });
  assert.deepEqual(ask(`@glim_gloam_bot token check ${PONS}`), addr(PONS));
  assert.deepEqual(ask(`Glim, is ${PONS} safe?`), addr(PONS));
  assert.deepEqual(ask(`is ${GLOAM} on robinhood chain a rug?`), { address: GLOAM, symbol: null, chain: "robinhood" });
  assert.deepEqual(ask(`${PONS} safe?`), addr(PONS));
  assert.deepEqual(ask("is $PONS safe?"), { address: null, symbol: "PONS", chain: null });
  assert.deepEqual(ask("is PONS safe"), { address: null, symbol: "PONS", chain: null }, "a ticker in capitals");
  assert.deepEqual(ask("is the cashcat token legit?"), { address: null, symbol: "CASHCAT", chain: null });
  assert.deepEqual(ask("token check orbio"), { address: null, symbol: "ORBIO", chain: null });
  assert.deepEqual(ask("is $BDX on base safe to buy?"), { address: null, symbol: "BDX", chain: "base" });
  for (const no of [
    "is gloam safe?", // the app, most likely
    "is ai safe?",
    "is pons safe?",
    "is this safe?",
    "is it safe to use gloam?",
    "is $PEPE safe?", // not one of Gloam's tokens: no ask, so moderation's view stands
    `send it to ${PONS}`,
    `${PONS}`,
    "token check",
    `token check ${PONS} and also tell me the price`,
    "is the bridge safe?",
  ]) {
    assert.equal(ask(no), null, no);
  }
});

await test("Glim: a token check is never read as a shill by the group's screen", () => {
  for (const text of [`token check ${OUTSIDER}`, `is ${OUTSIDER} safe?`, "is $PONS safe?", `Token check: ${OUTSIDER} on Base?`]) {
    const s = screen({ text, name: { first_name: "Ada" }, okHandles: [], entities: [], links: [], forwardedFrom: null } as unknown as Parameters<typeof screen>[0]);
    assert.equal(s.verdict, null, text);
    assert.equal(s.quiet, false, text);
  }
});

await test("Glim: the answer for a Gloam token, from the same cache as the card", async () => {
  reset();
  const said = await glim.answerTokenCheck({ address: null, symbol: "PONS", chain: null }, "Ada");
  assert.equal(outbound.length, 3);
  assert.deepEqual(outbound[0]!.input, { token: `robinhood:${PONS}` });
  assert.ok(said.startsWith("PONS on Robinhood Chain, from Blocktronics:\nGrade B, 72 of 100.\nHolders: 4,041\nLaunch bundles still hold 1.1% of supply"), said);
  assert.ok(said.includes("No check can say a token is safe"));
  assert.ok(said.endsWith(`https://blocktronics.xyz/t/robinhood/${PONS}`));
  assert.ok(!/[\u2014\p{Extended_Pictographic}]/u.test(said));
  // the card's route now answers from the cache
  assert.equal((await get(`chain=robinhood&token=${PONS}`)).status, 200);
  assert.equal(outbound.length, 3);
  assert.equal(rpcCalls.length, 0, "a Gloam token needs no chain read");
});

await test("Glim: any other address is read on chain first; a wallet or a non-token never reaches Blocktronics", async () => {
  reset();
  const said = await glim.answerTokenCheck({ address: OUTSIDER as `0x${string}`, symbol: null, chain: null }, "Ada");
  assert.ok(said.startsWith("OUTS on Base, from Blocktronics:"), said);
  assert.deepEqual(outbound[0]!.input, { token: `base:${OUTSIDER}` });
  for (const who of [WALLET, DELEGATED, NOT_TOKEN]) {
    outbound.length = 0;
    const r = await glim.answerTokenCheck({ address: who as `0x${string}`, symbol: null, chain: null }, "Ada");
    assert.equal(r, "I couldn't find a token at that address on Robinhood Chain, Base or Ethereum, so there's nothing to check.", who);
    assert.equal(outbound.length, 0, `${who} never reaches Blocktronics`);
  }
  outbound.length = 0;
  assert.ok((await glim.answerTokenCheck({ address: OUTSIDER as `0x${string}`, symbol: null, chain: "ethereum" }, "Ada")).includes("on Ethereum, so"), "only the chain asked about");
  assert.equal(outbound.length, 0);
  const copy = await glim.answerTokenCheck({ address: COPYCAT as `0x${string}`, symbol: null, chain: null }, "Ada");
  assert.ok(copy.startsWith("That is the copycat GLOAM token") && copy.includes(GLOAM_CHECKSUM));
  assert.equal(outbound.length, 0);
  // a symbol from chain that isn't a plain ticker is never repeated
  tokensOn.base![OUTSIDER] = "visit-scam.xyz";
  bt.resetBlocktronicsMemory();
  const odd = await glim.answerTokenCheck({ address: OUTSIDER as `0x${string}`, symbol: null, chain: null }, "Ada");
  assert.ok(odd.startsWith("This token on Base") && !odd.includes("scam.xyz"), odd);
  tokensOn.base![OUTSIDER] = "OUTS";
});

await test("Glim: not indexed, unsupported, unavailable and a bare /check, in plain words", async () => {
  reset();
  upstream.set(`*:${PONS}`, () => json({ code: "tool_error", error: "is not in the Blocktronics cache" }, 400));
  assert.equal(await glim.answerTokenCheck({ address: null, symbol: "PONS", chain: null }, "Ada"), "Blocktronics doesn't cover PONS on Robinhood Chain yet, so there's no check to show.");
  upstream.set(`*:${GLOAM}`, () => json({ code: "unsupported_token" }, 422));
  assert.match(await glim.answerTokenCheck({ address: GLOAM as `0x${string}`, symbol: null, chain: null }, "Ada"), /^Blocktronics doesn't grade GLOAM/);
  upstream.set(`*:${CASHCAT}`, () => json({ code: "internal" }, 500));
  assert.equal(await glim.answerTokenCheck({ address: null, symbol: "CASHCAT", chain: null }, "Ada"), "I couldn't get the check from Blocktronics just now. Try again in a few minutes.");
  assert.equal(await glim.answerTokenCheck({ address: null, symbol: "PONS", chain: "base" }, "Ada"), glim.TOKEN_CHECK_USAGE, "PONS isn't on Base");
});

const GROUP = -1004464028206;
const chat = { id: GROUP, type: "supergroup" as const, username: "gloamhq", is_forum: true };
const HELP_TOPIC = 4;
const member = { id: 4242, is_bot: false, first_name: "Ada", username: "ada_x" };
const groupMsg = (text: string, from = member) => ({
  update_id: nextId++,
  message: {
    message_id: nextId++,
    chat,
    from,
    date: 0,
    text,
    message_thread_id: HELP_TOPIC,
    is_topic_message: true,
    reply_to_message: { message_id: HELP_TOPIC, chat, date: 0, forum_topic_created: {} },
  },
});
const sentTexts = () => tg.filter((c) => c.method === "sendMessage").map((c) => String(c.body.text));
const actedOn = () => tg.filter((c) => ["deleteMessage", "banChatMember", "restrictChatMember"].includes(c.method));

await test("Glim in the group: a member's token check gets the read as a reply in the same topic, and nobody is acted on", async () => {
  reset();
  await handleUpdate(groupMsg(`token check ${OUTSIDER} on base`) as never);
  const sends = tg.filter((c) => c.method === "sendMessage");
  assert.equal(sends.length, 1, JSON.stringify(tg.map((c) => c.method)));
  assert.equal(sends[0]!.body.chat_id, GROUP);
  assert.equal(sends[0]!.body.message_thread_id, HELP_TOPIC);
  assert.ok(sends[0]!.body.reply_parameters);
  assert.ok(String(sends[0]!.body.text).startsWith("OUTS on Base, from Blocktronics:"));
  assert.equal(actedOn().length, 0);
  assert.equal(outbound.length, 3);
  // /check works too
  tg.length = 0;
  await handleUpdate(groupMsg("/check $PONS") as never);
  assert.ok(sentTexts()[0]?.startsWith("PONS on Robinhood Chain"));
  tg.length = 0;
  await handleUpdate(groupMsg("/check") as never);
  assert.equal(sentTexts()[0], glim.TOKEN_CHECK_USAGE);
});

await test("Glim in the group: six checks an hour per person, then quiet", async () => {
  reset();
  const asker = { id: 5151, is_bot: false, first_name: "Bo", username: "bo_x" };
  for (let i = 0; i < 6; i++) {
    tg.length = 0;
    await handleUpdate(groupMsg("is $PONS safe?", asker) as never);
    assert.equal(sentTexts().length, 1, `check ${i + 1}`);
    (globalThis as { __gloamMcpRate?: Map<string, { n: number }> }).__gloamMcpRate?.forEach((v, k) => {
      // the per-minute answer limits are not what this test is about
      if (k.includes(":tg-user:") || k.includes(":tg-global:")) v.n = 0;
    });
  }
  tg.length = 0;
  await handleUpdate(groupMsg("is $PONS safe?", asker) as never);
  assert.equal(sentTexts().length, 0);
});

await test("Glim with no key: the check isn't available yet, in the group and in a team DM", async () => {
  reset();
  delete env.BLOCKTRONICS_API_KEY;
  await handleUpdate(groupMsg(`token check ${PONS}`) as never);
  assert.deepEqual(sentTexts(), ["Token checks aren't available yet, Ada."]);
  tg.length = 0;
  const owner = { id: 500, is_bot: false, first_name: "Duke", username: "dukedotsol" };
  await handleUpdate({ update_id: nextId++, message: { message_id: nextId++, chat: { id: 500, type: "private" }, from: owner, date: 0, text: "is $GLOAM safe?" } } as never);
  assert.equal(sentTexts().length, 1);
  assert.ok(sentTexts()[0]!.startsWith("Token checks aren't available yet, Boss Duke.") && sentTexts()[0]!.includes("gloam.trade/token"));
  assert.equal(outbound.length + rpcCalls.length, 0);
  // and the group guide only offers it once a key is set
  tg.length = 0;
  await handleUpdate(groupMsg("/help") as never);
  assert.ok(!sentTexts()[0]!.includes("token check"));
  env.BLOCKTRONICS_API_KEY = KEY;
  tg.length = 0;
  await handleUpdate(groupMsg("/help") as never);
  assert.ok(sentTexts()[0]!.includes("type token check and its contract address"));
});

await test("Glim in a team DM: /check and plain asks answer there", async () => {
  reset();
  const owner = { id: 500, is_bot: false, first_name: "Duke", username: "dukedotsol" };
  await handleUpdate({ update_id: nextId++, message: { message_id: nextId++, chat: { id: 500, type: "private" }, from: owner, date: 0, text: `/check ${BDX} on ethereum` } } as never);
  assert.ok(sentTexts()[0]?.startsWith("BDX on Ethereum, from Blocktronics:"), sentTexts()[0]);
  assert.deepEqual(outbound[0]!.input, { token: `ethereum:${BDX}` });
  // a stranger's DM still gets nothing
  tg.length = 0;
  const stranger = { id: 777, is_bot: false, first_name: "Zed" };
  await handleUpdate({ update_id: nextId++, message: { message_id: nextId++, chat: { id: 777, type: "private" }, from: stranger, date: 0, text: "is $PONS safe?" } } as never);
  assert.equal(sentTexts().length, 0);
});

await test("the key is still in no log line, after everything", () => {
  for (const line of logs) assert.ok(!line.includes(KEY), line.slice(0, 120));
});

console.log(`\nblocktronics: ${passed} passed`);
