/**
 * Self-test: the status page (lib/status, /status, /api/status, the cron).
 *
 *  - the arithmetic: worst state, a day's bar (none, ok, degraded, down by
 *    share), uptime that never reads 100% with a check down, the last 90 UTC
 *    days across a year end, days with no checks left out of the uptime
 *  - the verdicts: a stale or stopped chain, a slow RPC, a vault or verifier
 *    with no answer, a verifier that takes an empty proof; the relay per
 *    network paused, out of gas, low on gas, waiting for gas, at its cap; a
 *    check made per network failing on some or all; Glim's webhook; Turnkey
 *  - the parts: the networks people can see only (no hidden testnet), every
 *    group filled
 *  - the history: a run counted into today, 90 days read back, a day with no
 *    run all zeros, the cron refused without its secret
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
  ["web:home", "web:app", "web:docs", "web:verify", "web:transparency", "database", "api", "leaves", "rpc-proxy", "bridge", "mcp", "glim", "turnkey"]
);
assert.equal(new Set(ids).size, ids.length, "ids are unique");
for (const g of model.GROUPS) assert.ok(parts.some((p) => p.group === g.id), `group ${g.id} has parts`);
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
await history.recordRun(run("degraded", now - 86_400_000));
await history.recordRun(run("operational", now));
await history.recordRun(run("operational", now + 300_000));
await history.recordRun(run("down", now + 600_000));
const h = await history.readHistory(ids, now + 700_000);
assert.ok(h);
assert.equal(h.days.length, 90);
assert.equal(h.days[89], "2026-11-19");
const vault = h.byPart.get("relay:4663")!;
assert.deepEqual(vault[89], { day: "2026-11-19", ok: 2, degraded: 0, down: 1 });
assert.deepEqual(vault[88], { day: "2026-11-18", ok: 0, degraded: 1, down: 0 });
assert.deepEqual(vault[10], { day: vault[10]!.day, ok: 0, degraded: 0, down: 0 }, "a day with no run is all zeros");
assert.equal(model.dayTone(vault[10]!), "none", "and shows as no data");
assert.equal(h.lastRun, now + 600_000);
assert.ok(h.byPart.get("unknown") === undefined);
ok("history: counted per day, read back over 90 days");

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
