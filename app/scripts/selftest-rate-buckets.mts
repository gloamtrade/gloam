/**
 * Self-test: what one rate-limit count covers (lib/mcpRemote/rateLimit).
 *
 *  - a count split by something besides the IP (a link code) takes it as its own
 *    dimension (`scope`), added after the IP is grouped: an IPv4 address counts
 *    on its own, an IPv6 address by its /64, and neighbours in the same /48 keep
 *    their own counts. Written into the IP ("code:2001:db8::1"), the code was read
 *    as part of an IPv6 address and grouped /48 or wider.
 *  - neither the IP nor the scope is in a key in the clear
 *
 * fetch is stubbed as an Upstash REST pipeline; nothing leaves this process.
 *
 * Run from app/:  ../mcp/node_modules/.bin/tsx scripts/selftest-rate-buckets.mts
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

const env = process.env as Record<string, string | undefined>;
env.NODE_ENV = "test";
env.GLOAM_RATE_LIMIT_KEY = randomBytes(32).toString("hex");
delete env.UPSTASH_REDIS_REST_URL;
delete env.UPSTASH_REDIS_REST_TOKEN;

type Cmd = (string | number)[];
const cmds: Cmd[] = [];
const counts = new Map<string, number>();
globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
  const body = JSON.parse(String(init?.body ?? "[]")) as Cmd[];
  cmds.push(...body);
  return new Response(
    JSON.stringify(
      body.map((c) => {
        if (c[0] !== "INCR") return { result: 1 };
        const n = (counts.get(String(c[1])) ?? 0) + 1;
        counts.set(String(c[1]), n);
        return { result: n };
      }),
    ),
    { status: 200 },
  );
}) as typeof fetch;

const { hitRateLimit, ipBucket } = await import("../src/lib/mcpRemote/rateLimit");

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  await fn();
  passed++;
  console.log(`ok  ${name}`);
}

const LIMIT = 10;
/** Hits `n` times; how many were allowed. */
async function hits(ip: string, scope: string, n: number, bucket = "partner-reg-code", now = Date.now()) {
  let ok = 0;
  for (let i = 0; i < n; i++) if ((await hitRateLimit(ip, bucket, LIMIT, now, 60, { scope })).allowed) ok++;
  return ok;
}

await test("the old key: a code written into an IPv6 address groups a whole /48 and more", () => {
  // what partners/register used to count: `${code}:${ip}`
  assert.equal(ipBucket("abc:2001:db8:1:2::1"), ipBucket("abc:2001:db8:1:3::1"), "two /64s in one /48 shared a count");
  assert.equal(ipBucket("abc:2001:db8:1:2::1"), ipBucket("abc:2001:db8:1:ffff:1::1"), "and every /64 under 2001:db8:1");
  assert.notEqual(ipBucket("2001:db8:1:2::1"), ipBucket("2001:db8:1:3::1"), "on its own, an IPv6 address counts by its /64");
});

await test("IPv4: one address and one code count together; another code or address counts apart", async () => {
  const now = Date.now();
  assert.equal(await hits("203.0.113.5", "code-a", 12, "partner-reg-code", now), LIMIT, "held to its limit");
  assert.equal(await hits("203.0.113.5", "code-b", 1, "partner-reg-code", now), 1, "another code from the same address");
  assert.equal(await hits("203.0.113.6", "code-a", 1, "partner-reg-code", now), 1, "the same code from another address");
  // an IPv4 address mapped into IPv6 is the same address
  assert.equal(await hits("::ffff:203.0.113.5", "code-a", 1, "partner-reg-code", now), 0, "::ffff:203.0.113.5 is 203.0.113.5");
});

await test("IPv6: one /64 and one code count together; a neighbour /64 in the same /48 counts apart", async () => {
  const now = Date.now();
  assert.equal(await hits("2001:db8:1:2::1", "code-a", LIMIT, "partner-reg-code", now), LIMIT);
  assert.equal(await hits("2001:db8:1:2:ffff:ffff:ffff:9", "code-a", 1, "partner-reg-code", now), 0, "another address in the same /64 shares it");
  assert.equal(await hits("2001:0db8:0001:0002:0000:0000:0000:0042", "code-a", 1, "partner-reg-code", now), 0, "written out in full, still the same /64");
  assert.equal(await hits("2001:db8:1:3::1", "code-a", 1, "partner-reg-code", now), 1, "the next /64 in the /48 keeps its own count");
  assert.equal(await hits("2001:db8:2:2::1", "code-a", 1, "partner-reg-code", now), 1, "and another /48");
  assert.equal(await hits("2001:db8:1:2::1", "code-b", 1, "partner-reg-code", now), 1, "another code from the same /64");
});

await test("a scope with colons or bars stays the scope", async () => {
  const now = Date.now();
  assert.equal(await hits("2001:db8:9:9::1", "a:b", LIMIT, "partner-reg-code", now), LIMIT);
  assert.equal(await hits("2001:db8:9:9::1", "a", 1, "partner-reg-code", now), 1, "a:b and a are two scopes");
  assert.equal(await hits("2001:db8:9:9::1", "a|b", 1, "partner-reg-code", now), 1, "a|b is a third");
  assert.equal(await hits("198.51.100.9", "x", LIMIT, "partner-reg-code", now), LIMIT);
  assert.equal(await hits("198.51.100.9", "", 1, "partner-reg-code", now), 1, "no scope is the IP's own count");
});

await test("shared counts: neither the IP nor the scope is in a key in the clear", async () => {
  env.UPSTASH_REDIS_REST_URL = "https://redis.test";
  env.UPSTASH_REDIS_REST_TOKEN = "test-token";
  cmds.length = 0;
  counts.clear();
  const now = Date.now();
  assert.equal(await hits("2001:db8:7:7::1", "zz-code-zz", 12, "partner-reg-code", now), LIMIT, "counted in Redis, held to its limit");
  assert.equal(await hits("2001:db8:7:8::1", "zz-code-zz", 1, "partner-reg-code", now), 1, "the neighbour /64 has its own key");
  assert.equal(await hits("203.0.113.70", "zz-code-zz", 1, "partner-reg-code", now), 1);
  const keys = cmds.filter((c) => c[0] === "INCR").map((c) => String(c[1]));
  assert.equal(keys.length, 14);
  assert.equal(new Set(keys).size, 3, "one key per IP group and code");
  for (const key of keys) {
    assert.ok(key.startsWith("gloam:mcp:rl:partner-reg-code:"), key);
    assert.ok(!/2001|db8|203\.0\.113|zz-code-zz/.test(key), key);
  }
  delete env.UPSTASH_REDIS_REST_URL;
  delete env.UPSTASH_REDIS_REST_TOKEN;
});

console.log(`\nrate buckets: ${passed} passed`);
