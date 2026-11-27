/**
 * Self-test: the status page (lib/status, /status, /api/status, the cron).
 *
 *  - the arithmetic: worst state, a day's bar (none, ok, degraded, down by
 *    share), uptime that never reads 100% with a check down, the last 90 UTC
 *    days across a year end, days with no checks left out of the uptime
 *  - the verdicts: a stale or stopped chain, a slow RPC, a vault or verifier
 *    with no answer, a verifier that takes an empty proof; the relay per
 *    network paused, out of gas, low on gas, waiting for gas, at its cap;
 *    Starknet's relay sending no moves (no fee set) as degraded; a
 *    check made per network failing on some or all; Glim's webhook; Turnkey
 *  - the parts: the networks people can see only (no hidden testnet), every
 *    group filled
 *  - the history: hours from the first check while young, days once it spans
 *    3 days, nothing before a part's first check, a period with no run after
 *    it all zeros; the cron refused without its secret
 *  - what is shown: the cron's latest run while under 7 minutes old, else one
 *    check here, kept as the latest and shared
 *  - nothing leaks: with a keyed private RPC and a bot token set and every
 *    request failing with its URL in the error, no URL, key or token is in
 *    the result, every part is down, and the checks end inside their cap
 *
 * Uses the in-process store (GLOAM_PARTNERS_STORE=memory); nothing reaches any host.
 *
 * Run from app/:  ../mcp/node_modules/.bin/tsx scripts/selftest-status.mts
 */
import assert from "node:assert/strict";
import Module from "node:module";
import { fileURLToPath } from "node:url";

const stubs: Record<string, string> = {
  "server-only": fileURLToPath(new URL("./server-only-stub.cjs", import.meta.url)),
};
const M = Module as unknown as { _resolveFilename: (req: string, ...rest: unknown[]) => string };
const resolveFilename = M._resolveFilename;
M._resolveFilename = function (req: string, ...rest: unknown[]) {
  return stubs[req] ?? resolveFilename.call(this, req, ...rest);
};

const SECRET_URL = "https://secret-node.selftest.invalid/v2/KEY-abc123";
process.env.GLOAM_PARTNERS_STORE = "memory";
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;
delete process.env.NEXT_PUBLIC_SHOW_TESTNETS;
process.env.GLOAM_RPC_URL_4663 = SECRET_URL;
process.env.CRON_SECRET = "status-selftest-cron-secret";

// Every request fails, naming the URL it was for (as fetch and viem errors do).
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  throw new TypeError(`fetch failed for ${url}`);
}) as typeof fetch;

const model = await import("../src/lib/status/model");
const checks = await import("../src/lib/status/checks");
const history = await import("../src/lib/status/history");
const current = await import("../src/lib/status/current");
const kvStore = await import("../src/lib/partnersKv");
const incidents = await import("../src/lib/status/incidents");
const cron = await import("../src/app/api/status/cron/route");

let n = 0;
const ok = (name: string) => {
  n++;
  console.log(`ok ${n} ${name}`);
};

// ---------------------------------------------------------------- arithmetic

assert.equal(model.worst([]), "operational");
assert.equal(model.worst(["operational", "degraded"]), "degraded");
assert.equal(model.worst(["degraded", "down", "operational"]), "down");
ok("worst state");

assert.equal(model.dayTone({ ok: 0, degraded: 0, down: 0 }), "none");
assert.equal(model.dayTone({ ok: 288, degraded: 0, down: 0 }), "ok");
assert.equal(model.dayTone({ ok: 287, degraded: 1, down: 0 }), "ok", "one slow check keeps the day ok");
assert.equal(model.dayTone({ ok: 270, degraded: 18, down: 0 }), "degraded", "5% degraded");
assert.equal(model.dayTone({ ok: 287, degraded: 0, down: 1 }), "degraded", "any check down marks the day");
assert.equal(model.dayTone({ ok: 270, degraded: 0, down: 18 }), "down", "5% down");
ok("a day's bar");

assert.equal(model.dayUptime({ ok: 0, degraded: 0, down: 0 }), null);
assert.equal(model.dayUptime({ ok: 1, degraded: 1, down: 0 }), 1, "degraded still answered");
assert.equal(model.formatPercent(1), "100%");
assert.equal(model.formatPercent(287 / 288), "99.65%");
assert.equal(model.formatPercent(0.99999), "99.99%", "rounded down, never up to 100%");
assert.equal(model.formatPercent(0.995), "99.5%");
assert.equal(model.formatPercent(0), "0%");
assert.equal(
  model.rangeUptime([
    { ok: 0, degraded: 0, down: 0 },
    { ok: 9, degraded: 0, down: 1 },
  ]),
  0.9,
  "days with no checks are left out"
);
assert.equal(model.rangeUptime([{ ok: 0, degraded: 0, down: 0 }]), null);
ok("uptime");

const days = model.lastDays(Date.UTC(2027, 0, 2, 23, 59), 90);
assert.equal(days.length, 90);
assert.equal(days[89], "2027-01-02");
assert.equal(days[88], "2027-01-01");
assert.equal(days[87], "2026-12-31");
assert.equal(days[0], "2026-10-05");
assert.equal(model.formatDay("2026-11-09"), "9 Nov 2026");
assert.equal(model.formatUtc(Date.UTC(2026, 10, 19, 4, 5)), "19 Nov 2026, 04:05 UTC");
assert.equal(model.formatLatency(182.4), "182 ms");
assert.equal(model.formatLatency(3_420), "3.4 s");
ok("days and formats");

// ---------------------------------------------------------------- verdicts

const rh = { family: "robinhood" as const, testnet: false };
const eth = { family: "ethereum" as const, testnet: false };
const fine = { vault: true, verifier: "rejects" as const };
const head = (ms: number, blockAgeS: number) => ({ ...fine, head: { ms, blockAgeS } });
assert.equal(checks.judgeNetwork(rh, { ...fine, head: null }).status, "down");
assert.equal(checks.judgeNetwork(rh, head(120, 2)).status, "operational");
assert.equal(checks.judgeNetwork(rh, head(120, 2)).detail, "Latest block 2 s ago · Vault and verifier answer");
assert.equal(checks.judgeNetwork(rh, head(120, -3)).status, "operational", "a clock a little ahead is fine");
assert.equal(checks.judgeNetwork(rh, head(4_500, 1)).status, "degraded");
assert.match(checks.judgeNetwork(rh, head(4_500, 1)).reason!, /Slow to answer \(4\.5 s\)/);
assert.equal(checks.judgeNetwork(rh, head(120, 75)).status, "degraded");
assert.match(checks.judgeNetwork(rh, head(120, 240)).reason!, /4 min old/);
assert.equal(checks.judgeNetwork(rh, head(120, 700)).status, "down");
assert.equal(checks.judgeNetwork(eth, head(120, 75)).status, "operational", "Ethereum slots are 12 s, some missed");
assert.equal(checks.judgeNetwork(eth, head(120, 200)).status, "degraded");
assert.equal(checks.judgeNetwork(rh, { head: { ms: 90, blockAgeS: 1 }, vault: false, verifier: "rejects" }).reason, "The vault did not answer.");
assert.equal(checks.judgeNetwork(rh, { head: { ms: 90, blockAgeS: 1 }, vault: true, verifier: null }).reason, "The proof verifier did not answer.");
assert.equal(checks.judgeNetwork(rh, { head: { ms: 90, blockAgeS: 1 }, vault: false, verifier: null }).status, "degraded");
const accepts = checks.judgeNetwork(rh, { head: { ms: 90, blockAgeS: 1 }, vault: true, verifier: "accepts" });
assert.equal(accepts.status, "down", "a verifier that takes an empty proof is down");
assert.equal(accepts.reason, "The verifier accepted an empty proof.");
ok("networks: stale, stopped, slow, vault and verifier");

const wei = (coins: number) => BigInt(Math.round(coins * 1e18));
const api = (network: object | null) => ({ ms: 80, network: network as never });
const on = { chainId: 4663, enabled: true };
const reserve = wei(0.0001);
const gas = (left: number) => ({ left: wei(left), reserve, decimals: 18, symbol: "ETH" });
assert.equal(checks.judgeRelayNet({ api: null, gas: null, spendPct: null }).status, "down");
const healthy = checks.judgeRelayNet({ api: api(on), gas: gas(0.0044), spendPct: 3.4 });
assert.equal(healthy.status, "operational");
assert.equal(healthy.detail, "Gas 0.0044 ETH · 3% of this hour's cap used");
const low = checks.judgeRelayNet({ api: api(on), gas: gas(0.0006), spendPct: 0 });
assert.equal(low.status, "degraded", "under ten times the reserve");
assert.equal(low.reason, "Low on gas: about 12 sends left.");
assert.equal(checks.judgeRelayNet({ api: api(on), gas: gas(0.001), spendPct: 0 }).status, "operational", "ten times the reserve is fine");
const empty = checks.judgeRelayNet({ api: api({ chainId: 4663, enabled: false, lowBalance: true }), gas: gas(0.00005), spendPct: 0 });
assert.equal(empty.status, "down");
assert.equal(empty.reason, "Out of gas: paused until it is topped up.");
assert.equal(checks.judgeRelayNet({ api: api(null), gas: null, spendPct: null }).reason, "Paused.", "a network missing from the answer is paused");
assert.equal(checks.judgeRelayNet({ api: api({ ...on, gasHigh: true }), gas: gas(1), spendPct: 0 }).reason, "Waiting for network gas to come down.");
const capped = checks.judgeRelayNet({ api: api(on), gas: gas(1), spendPct: 85 });
assert.equal(capped.status, "degraded", "new sends stop at 80% of the cap");
assert.equal(capped.reason, "This hour's cap is used up for new sends.");
assert.equal(checks.judgeRelayNet({ api: api(on), gas: gas(1), spendPct: 140 }).detail, "Gas 1 ETH · 100% of this hour's cap used");
assert.equal(checks.judgeRelayNet({ api: api(on), gas: null, spendPct: null }).detail, null);
ok("relay per network: paused, out of gas, low gas, gas high, cap");

const words = { none: "none", some: (names: string) => `some: ${names}`, all: "all" };
assert.equal(checks.judgeEach([], words).status, "down");
assert.equal(checks.judgeEach([{ name: "Base", ms: 50, ok: true }], words).status, "operational");
const someBad = checks.judgeEach([{ name: "Base", ms: 50, ok: false }, { name: "Tempo", ms: null, ok: false }, { name: "Ethereum", ms: 60, ok: true }], words);
assert.equal(someBad.status, "degraded");
assert.equal(someBad.reason, "some: Base and Tempo");
assert.equal(checks.judgeEach([{ name: "Base", ms: null, ok: false }], words).status, "down");
assert.equal(checks.judgeEach([{ name: "Base", ms: 5_000, ok: true }], words).status, "degraded", "slow");
ok("per-network parts: some, all, slow");

const nowS = 1_800_000_000;
assert.equal(checks.judgeGlim(null, nowS, false).reason, "Not set up on this server.");
assert.equal(checks.judgeGlim(null, nowS).status, "down");
assert.equal(checks.judgeGlim({ ms: 90, url: "", pending: 0, lastErrorAt: null }, nowS).reason, "No webhook is set.");
assert.equal(checks.judgeGlim({ ms: 90, url: "set", pending: 0, lastErrorAt: null }, nowS).status, "operational");
assert.equal(checks.judgeGlim({ ms: 90, url: "set", pending: 0, lastErrorAt: nowS - 60 }, nowS).status, "degraded");
assert.equal(checks.judgeGlim({ ms: 90, url: "set", pending: 0, lastErrorAt: nowS - 3_600 }, nowS).status, "operational", "an old error has passed");
assert.equal(checks.judgeGlim({ ms: 90, url: "set", pending: 80, lastErrorAt: null }, nowS).reason, "80 messages waiting.");
ok("Glim's webhook");

const tk = (indicator: string, components: { name: string; status: string }[] = []) => ({ ms: 90, indicator, components });
assert.equal(checks.judgeTurnkey(null).status, "down");
assert.equal(checks.judgeTurnkey(tk("none")).status, "operational");
assert.equal(checks.judgeTurnkey(tk("minor")).status, "degraded", "no named part: the overall word");
assert.equal(checks.judgeTurnkey(tk("major")).status, "down");
const dashOnly = checks.judgeTurnkey(tk("minor", [{ name: "Dashboard", status: "partial_outage" }, { name: "APIs", status: "operational" }, { name: "Email", status: "operational" }]));
assert.equal(dashOnly.status, "operational", "Turnkey's dashboard is not something Gloam's wallets use");
const email = checks.judgeTurnkey(tk("minor", [{ name: "APIs", status: "operational" }, { name: "Email", status: "partial_outage" }]));
assert.equal(email.status, "degraded");
assert.equal(email.reason, "Turnkey reports a problem with Email.");
assert.equal(checks.judgeTurnkey(tk("major", [{ name: "APIs", status: "major_outage" }, { name: "SDKs", status: "degraded_performance" }])).status, "down");
ok("Turnkey");

// Starknet (shown only while its flag is on): its relay's STRK against the line where it pauses,
// its RPC's latest block, and its prover route reached without a proof.
const STRK = 10n ** 18n;
const snLow = 30n * STRK;
const snOn = { ms: 200, on: true, funded: true };
assert.equal(checks.judgeStarknetRelay({ api: null, strk: null }, snLow).status, "down");
assert.equal(checks.judgeStarknetRelay({ api: { ...snOn, on: false }, strk: 100n * STRK }, snLow).reason, "Paused.");
const snOut = checks.judgeStarknetRelay({ api: { ...snOn, funded: false }, strk: 12n * STRK }, snLow);
assert.equal(snOut.status, "down");
assert.equal(snOut.reason, "Out of STRK for fees: paused until it is topped up.");
assert.equal(snOut.detail, "Gas 12 STRK");
assert.equal(checks.judgeStarknetRelay({ api: snOn, strk: 50n * STRK }, snLow).status, "degraded", "under three times the line: top it up");
assert.equal(checks.judgeStarknetRelay({ api: snOn, strk: 200n * STRK }, snLow).status, "operational");
// On, funded, but refusing every add, payment and cash out (mainnet, no relay fee set): degraded, saying why.
const snNoMoves = checks.judgeStarknetRelay({ api: { ...snOn, moves: "off" }, strk: 200n * STRK }, snLow);
assert.equal(snNoMoves.status, "degraded", "moves off is not operational");
assert.equal(snNoMoves.reason, "Adds, payments and cash outs are off: no relay fee is set.");
assert.equal(snNoMoves.detail, "Gas 200 STRK");
assert.equal(checks.judgeStarknetRelay({ api: { ...snOn, moves: "on" }, strk: 200n * STRK }, snLow).status, "operational");
assert.equal(checks.judgeStarknetRelay({ api: { ...snOn, funded: false, moves: "off" }, strk: 12n * STRK }, snLow).status, "down", "out of STRK still reads down");
assert.equal(checks.judgeStarknetRelay({ api: { ...snOn, on: false, moves: "off" }, strk: 200n * STRK }, snLow).reason, "Paused.");
assert.deepEqual(checks.starknetRelayApi(90, { ok: true, on: true, funded: true, moves: "off" }), { ms: 90, on: true, funded: true, moves: "off" }, "the check reads moves off");
assert.equal(checks.starknetRelayApi(90, { ok: true, on: true, funded: true })?.moves, "on", "a relay that doesn't say (older): on");
assert.equal(checks.starknetRelayApi(90, { ok: false, error: { code: "rate_limited" } }), null, "a refused GET is no answer");
assert.equal(checks.judgeStarknetNetwork(null).status, "down");
assert.equal(checks.judgeStarknetNetwork({ ms: 100, httpStatus: 200, ageSec: 4, block: 18_540_000 }).detail, "Latest block 4 s ago");
assert.equal(checks.judgeStarknetNetwork({ ms: 100, httpStatus: 200, ageSec: 90, block: 1 }).status, "degraded");
assert.equal(checks.judgeStarknetNetwork({ ms: 100, httpStatus: 200, ageSec: 400, block: 1 }).status, "down");
assert.equal(checks.judgeStarknetNetwork({ ms: 100, httpStatus: 404, ageSec: null, block: null }).status, "down");
assert.equal(checks.judgeStarknetProver({ ms: 80, httpStatus: 200, version: "0.10.0" }).status, "operational");
assert.equal(checks.judgeStarknetProver({ ms: 80, httpStatus: 404, version: undefined }).status, "down");
assert.equal(checks.judgeStarknetProver(null).status, "down");
assert.ok(!checks.statusParts().some((p) => p.id.endsWith(":starknet")), "no Starknet rows while its flag is off");
ok("Starknet");

// ---------------------------------------------------------------- parts

const parts = checks.statusParts();
const ids = parts.map((p) => p.id);
for (const hidden of [46630, 42431, 84532, 11155111, 99801]) {
  assert.ok(!ids.includes(`network:${hidden}`), `testnet ${hidden} is hidden`);
  assert.ok(!ids.includes(`relay:${hidden}`), `testnet ${hidden} relay is hidden`);
}
for (const live of [4663, 4217, 8453, 1]) {
  assert.ok(ids.includes(`network:${live}`), `mainnet ${live} is listed`);
  assert.ok(ids.includes(`relay:${live}`), `mainnet ${live} relay is listed`);
}
assert.deepEqual(
  ids.filter((id) => !/^(network|relay):/.test(id)),
  ["bridge", "leaves", "rpc-proxy", "mcp", "api", "glim", "turnkey", "web:home", "web:app", "web:docs", "web:verify", "web:transparency", "database"]
);
assert.equal(new Set(ids).size, ids.length, "ids are unique");
for (const g of model.GROUPS) assert.ok(parts.some((p) => p.group === g.id), `group ${g.id} has parts`);
assert.deepEqual(model.GROUPS.map((g) => g.id), ["payments", "networks", "api", "integrations", "platform"], "money first, the site last");
const firstOf = (g: string) => ids.indexOf(parts.find((p) => p.group === g)!.id);
assert.ok(firstOf("payments") < firstOf("networks") && firstOf("networks") < firstOf("api") && firstOf("api") < firstOf("platform"));
assert.ok(!parts.find((p) => p.id === "rpc-proxy")!.note!.includes("Base"), "the proxy serves the one-RPC mainnets only");
ok("parts: networks people can see, every group filled");

// ---------------------------------------------------------------- nothing leaks, nothing hangs

process.env.TELEGRAM_BOT_TOKEN = "123456:TOKEN-selftest-secret";
const t0 = Date.now();
const snap = await checks.runStatusChecks();
const took = Date.now() - t0;
const json = JSON.stringify(snap);
assert.ok(!json.includes("secret-node"), "no RPC host in the result");
assert.ok(!json.includes("KEY-abc123"), "no key in the result");
assert.ok(!json.includes("TOKEN-selftest"), "no bot token in the result");
assert.ok(!json.includes("selftest.invalid"), "no URL in the result");
assert.ok(!/https?:\/\//.test(json), "no URL at all in the result");
assert.equal(snap.overall, "down");
for (const p of snap.parts) assert.equal(p.status, "down", `${p.id} is down when nothing answers`);
assert.equal(snap.parts.find((p) => p.id === "database")!.reason, "Not set up on this server.");
assert.deepEqual(snap.packages, [{ name: "@gloamtrade/sdk", version: null }, { name: "@gloamtrade/mcp", version: null }]);
assert.ok(took < 12_000, `the checks end inside their cap (${took} ms)`);
ok(`no URL, key or token leaks; every part down; done in ${took} ms`);

// ---------------------------------------------------------------- history

const now = Date.UTC(2026, 10, 19, 12, 0);
const run = (status: "operational" | "degraded" | "down", at: number) => ({
  checkedAt: at,
  overall: status,
  parts: parts.map((p) => ({ ...p, status, latencyMs: 10, reason: null, detail: null })),
  packages: [],
});
const ids2 = [...ids, "never-checked"];

// young: hours since the first check, nothing before it
kvStore.resetMemoryKv();
await history.recordRun(run("degraded", now - 2 * 3_600_000));
await history.recordRun(run("operational", now));
await history.recordRun(run("operational", now + 300_000));
await history.recordRun(run("down", now + 600_000));
const h = await history.readHistory(ids2, now + 660_000);
assert.ok(h);
assert.equal(h.unit, "hour");
assert.equal(h.since, "2026-11-19T10");
const relay = h.byPart.get("relay:4663")!;
assert.deepEqual(relay, [
  { day: "2026-11-19T10", ok: 0, degraded: 1, down: 0 },
  { day: "2026-11-19T11", ok: 0, degraded: 0, down: 0 },
  { day: "2026-11-19T12", ok: 2, degraded: 0, down: 1 },
], "from the first check to now, an hour with no run in between is all zeros");
assert.equal(model.dayTone(relay[1]!), "none", "and shows as no data");
assert.deepEqual(h.byPart.get("never-checked"), [], "a part never checked has no bars at all");
assert.equal(h.lastRun, now + 600_000);
ok("history: hours from the first check while young");

// older: days, from the first day on record
kvStore.resetMemoryKv();
await history.recordRun(run("operational", now - 10 * 86_400_000));
await history.recordRun(run("down", now));
const d = await history.readHistory(ids, now + 60_000);
assert.ok(d);
assert.equal(d.unit, "day");
assert.equal(d.since, "2026-11-09");
const days10 = d.byPart.get("relay:4663")!;
assert.equal(days10.length, 11);
assert.deepEqual(days10[0], { day: "2026-11-09", ok: 1, degraded: 0, down: 0 });
assert.deepEqual(days10[10], { day: "2026-11-19", ok: 0, degraded: 0, down: 1 });
ok("history: days from the first day once it spans 3 days or more");

// days recorded before hours were kept: days until an hour is on record
kvStore.resetMemoryKv();
await kvStore.kv([["HINCRBY", history.dayKey("2026-11-18"), "relay:4663|ok", 5]]);
const old = await history.readHistory(ids, now);
assert.equal(old!.unit, "day");
assert.deepEqual(old!.byPart.get("relay:4663")!.map((t) => t.day), ["2026-11-18", "2026-11-19"]);
ok("history: days when no hour is on record yet");

assert.equal(model.sinceText("2026-11-18"), "Since 18 Nov");
assert.equal(model.sinceText("2026-11-19T01"), "Since 19 Nov, 01:00");
assert.equal(model.formatPeriod("2026-11-19"), "19 Nov 2026");
assert.equal(model.formatPeriod("2026-11-19T23"), "19 Nov, 23:00 to 00:00 UTC");
ok("since and period labels");

// the page and the JSON show the cron's latest run, or check once themselves when it is too old
kvStore.resetMemoryKv();
current.resetStatusMemo();
await history.recordRun(run("operational", now));
const fresh = await current.currentSnapshot(now + 4 * 60_000);
assert.equal(fresh.checkedAt, now, "a run under 7 minutes old is shown as is");
assert.equal(fresh.overall, "operational");
current.resetStatusMemo();
const stale = await current.currentSnapshot(now + 8 * 60_000);
assert.notEqual(stale.checkedAt, now, "an older run is not shown: the checks run here");
assert.equal(stale.overall, "down", "(every request fails in this test)");
const kept = await history.readLatest();
assert.equal(kept!.checkedAt, stale.checkedAt, "and that run is kept as the latest");
const again = await current.currentSnapshot(now + 8 * 60_000 + 5_000);
assert.equal(again.checkedAt, stale.checkedAt);
ok("current: the cron's run while fresh, one shared check when stale");

const refused = await cron.GET(new Request("http://localhost/api/status/cron"));
assert.equal(refused.status, 401);
const wrong = await cron.GET(new Request("http://localhost/api/status/cron", { headers: { authorization: "Bearer nope" } }));
assert.equal(wrong.status, 401);
ok("cron refused without its secret");

const okCron = await cron.GET(new Request("http://localhost/api/status/cron", { headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } }));
assert.equal(okCron.status, 200);
ok("cron with its secret runs and records");

// ---------------------------------------------------------------- incidents

assert.equal(incidents.ongoingIncidents([]).length, 0);
const list = [
  { id: "a", title: "A", impact: "down" as const, parts: ["relay"], startedAt: "2026-11-18T10:00:00Z", resolvedAt: "2026-11-18T11:00:00Z", updates: [] },
  { id: "b", title: "B", impact: "degraded" as const, parts: ["bridge"], startedAt: "2026-11-19T10:00:00Z", resolvedAt: null, updates: [] },
  { id: "c", title: "C", impact: "down" as const, parts: ["api"], startedAt: "2026-07-01T10:00:00Z", resolvedAt: "2026-07-01T11:00:00Z", updates: [] },
];
assert.deepEqual(incidents.ongoingIncidents(list).map((i) => i.id), ["b"]);
assert.deepEqual(incidents.pastIncidents(now, 90, list).map((i) => i.id), ["a"], "older than 90 days drops off");
ok("incidents");

globalThis.fetch = realFetch;
console.log(`\n${n} passed`);
