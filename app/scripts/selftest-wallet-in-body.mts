/**
 * Self-test: a wallet never goes in a URL the app's own API answers.
 *
 * Access logs and the CDN keep URLs next to the IP that asked, so a wallet in a
 * query string ties the two together. /api/activity and /api/vote/me take the
 * wallet in a POST body (as /api/xray does) and answer GET with a 405; the vote
 * totals (GET /api/vote/[id]) refuse ?address= rather than read it. Every caller
 * in the app posts it, and no fetch in app/src puts a wallet in an /api/ URL.
 *
 * fetch is stubbed (the explorer answers from here); nothing leaves this process.
 *
 * Run from app/:  ../mcp/node_modules/.bin/tsx scripts/selftest-wallet-in-body.mts
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import Module from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { NextRequest } from "next/server";

const stub = fileURLToPath(new URL("./server-only-stub.cjs", import.meta.url));
const M = Module as unknown as { _resolveFilename: (req: string, ...rest: unknown[]) => string };
const resolve = M._resolveFilename;
M._resolveFilename = function (req: string, ...rest: unknown[]) {
  return req === "server-only" ? stub : resolve.call(this, req, ...rest);
};

const env = process.env as Record<string, string | undefined>;
env.NODE_ENV = "test";
delete env.UPSTASH_REDIS_REST_URL;
delete env.UPSTASH_REDIS_REST_TOKEN;

const WALLET = "0x1111111111111111111111111111111111111111";
const asked: string[] = [];
globalThis.fetch = (async (url: unknown) => {
  asked.push(String(url));
  if (String(url).startsWith("https://explorer.testnet.chain.robinhood.com/api")) {
    return new Response(JSON.stringify({ result: [{ hash: "0xab", from: WALLET, to: WALLET, value: "5", timeStamp: "1700000000", isError: "0" }] }), { status: 200 });
  }
  throw new Error(`selftest-wallet-in-body: no network calls allowed (${String(url)})`);
}) as typeof fetch;

const activity = await import("../src/app/api/activity/route");
const voteOne = await import("../src/app/api/vote/[id]/route");
const voteMe = await import("../src/app/api/vote/me/route");

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  await fn();
  passed++;
  console.log(`ok  ${name}`);
}

const post = (path: string, body: unknown, ip = "203.0.113.41") =>
  new NextRequest(`https://gloam.trade${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

await test("activity: GET is a 405 that names POST", async () => {
  const res = activity.GET();
  assert.equal(res.status, 405);
  assert.equal(res.headers.get("allow"), "POST");
  assert.equal(res.headers.get("cache-control"), "no-store");
});

await test("activity: POST { address } reads the testnet explorer; nothing is kept by a cache", async () => {
  asked.length = 0;
  const res = await activity.POST(post("/api/activity", { address: WALLET }));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store");
  const j = (await res.json()) as { txs: { hash: string; valueWei: string; ok: boolean }[]; address: string };
  assert.deepEqual(j.txs.map((t) => [t.hash, t.valueWei, t.ok]), [["0xab", "5", true]]);
  assert.equal(asked.length, 1, "one explorer read");
});

await test("activity: a mainnet is read from the chain by the app, so the route answers empty without a read", async () => {
  asked.length = 0;
  for (const chainId of [4663, "4663", 4217]) {
    const res = await activity.POST(post("/api/activity", { address: WALLET, chainId }));
    assert.equal(res.status, 200, String(chainId));
    assert.deepEqual(((await res.json()) as { txs: unknown[] }).txs, []);
  }
  assert.equal(asked.length, 0);
});

await test("activity: a bad body, wallet or chain is a 400; an oversized one a 413", async () => {
  for (const body of ["not json", "null", "[]", "5", JSON.stringify({}), JSON.stringify({ address: "0x12" }), JSON.stringify({ address: WALLET, chainId: 999 }), JSON.stringify({ address: WALLET, chainId: {} })]) {
    const res = await activity.POST(post("/api/activity", body));
    assert.equal(res.status, 400, body);
    assert.equal(res.headers.get("cache-control"), "no-store");
  }
  assert.equal((await activity.POST(post("/api/activity", { address: WALLET, pad: "x".repeat(300) }))).status, 413);
});

await test("vote/me: GET is a 405 that names POST; POST checks its body before anything is read", async () => {
  const res = voteMe.GET();
  assert.equal(res.status, 405);
  assert.equal(res.headers.get("allow"), "POST");
  for (const body of ["not json", "[]", JSON.stringify({}), JSON.stringify({ address: "nope" })]) {
    assert.equal((await voteMe.POST(post("/api/vote/me", body))).status, 400, body);
  }
});

await test("vote totals: ?address= is refused, never read", async () => {
  for (const q of [`?address=${WALLET}`, "?address=", "?address=0x12&x=1"]) {
    const res = await voteOne.GET(new Request(`https://gloam.trade/api/vote/any${q}`, { headers: { "x-forwarded-for": "203.0.113.42" } }), { params: Promise.resolve({ id: "any" }) });
    assert.equal(res.status, 400, q);
    const j = (await res.json()) as { error: { code: string; message: string } };
    assert.equal(j.error.code, "address_in_url");
    assert.match(j.error.message, /POST to \/api\/vote\/me/);
  }
});

const SRC = fileURLToPath(new URL("../src/", import.meta.url));
function* files(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* files(p);
    else if (/\.(ts|tsx)$/.test(name)) yield p;
  }
}

await test("callers: the app posts the wallet, and no /api/ URL in app/src carries one", () => {
  const offenders: string[] = [];
  for (const f of files(SRC)) {
    const text = readFileSync(f, "utf8");
    // a path under /api/ with address=, wallet= or owner= in its query
    for (const m of text.matchAll(/["'`]\/api\/[^"'`\s]*[?&](address|wallet|owner)=/g)) offenders.push(`${f.slice(SRC.length)}: ${m[0]}`);
    for (const m of text.matchAll(/["'`]\/api\/(activity|vote\/me)\?/g)) offenders.push(`${f.slice(SRC.length)}: ${m[0]}`);
  }
  assert.deepEqual(offenders, []);
  const hook = readFileSync(join(SRC, "hooks/useActivity.ts"), "utf8");
  assert.match(hook, /fetch\("\/api\/activity", \{\s*method: "POST"/);
  assert.match(hook, /body: JSON\.stringify\(/);
  const votes = readFileSync(join(SRC, "components/vote/voteHooks.ts"), "utf8");
  assert.match(votes, /fetch\("\/api\/vote\/me", \{ method: "POST"[^}]*\}?[^)]*body: JSON\.stringify\(\{ address \}\)/);
});

console.log(`\nwallet in body: ${passed} passed`);
