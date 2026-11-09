/**
 * Self-test: how shared counts name and expire their keys (lib/mcpRemote/rateLimit).
 *
 *  - with GLOAM_RATE_LIMIT_KEY set, a key names who is counted (an IP, a
 *    wallet, a spend marker) by an HMAC under that secret and the bucket: the
 *    same subject gets the same name on every call in a bucket (the count is
 *    shared), another name in another bucket, another secret gives other
 *    names, and the unkeyed hash of the subject is never the name
 *  - without it (or with one under 32 bytes) names fall back to the plain hash,
 *    every limit still holds, and it is logged once, never with the value
 *  - each key's expiry is two windows plus a random part of up to one more, so
 *    keys written by one request don't share an expiry
 *  - proof checks (bucket "verify") are counted in Redis and refused when
 *    Redis can't keep the count
 *
 * fetch is stubbed as an Upstash REST pipeline; nothing leaves this process.
 *
 * Run from app/:  ../mcp/node_modules/.bin/tsx scripts/selftest-rate-keys.mts
 */
import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes } from "node:crypto";

const env = process.env as Record<string, string | undefined>;
env.UPSTASH_REDIS_REST_URL = "https://redis.test";
env.UPSTASH_REDIS_REST_TOKEN = "test-token";
env.NODE_ENV = "test";
delete env.GLOAM_RATE_LIMIT_KEY;

type Cmd = (string | number)[];
const cmds: Cmd[] = [];
let redisDown = false;
globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
  if (redisDown) return new Response("unavailable", { status: 503 });
  const body = JSON.parse(String(init?.body ?? "[]")) as Cmd[];
  cmds.push(...body);
  return new Response(JSON.stringify(body.map((c) => ({ result: c[0] === "INCR" ? 1 : 1 }))), { status: 200 });
}) as typeof fetch;

const warnings: string[] = [];
const warn = console.warn;
console.warn = (...a: unknown[]) => {
  warnings.push(a.map(String).join(" "));
};

const { hitRateLimit, keyTtl, rateKeysKeyed, RATE_KEY_ENV, SharedCountUnavailable } = await import("../src/lib/mcpRemote/rateLimit");

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  await fn();
  passed++;
  console.log(`ok  ${name}`);
}

const incrKeys = () => cmds.filter((c) => c[0] === "INCR").map((c) => String(c[1]));
const tagOf = (key: string) => key.split(":")[4]!;
const plain = (subject: string) => createHash("sha256").update(`gloam-mcp|${subject}`).digest("hex").slice(0, 32);
const keyed = (secret: Buffer, bucket: string, subject: string) =>
  createHmac("sha256", secret).update(`gloam-rl|${bucket}|${subject}`).digest("hex").slice(0, 32);

const IP = "203.0.113.77";
const WALLET = "0x1111111111111111111111111111111111111111";
const NULLIFIER = `0x${"2a".repeat(32)}`;

await test("the secret's name", () => {
  assert.equal(RATE_KEY_ENV, "GLOAM_RATE_LIMIT_KEY");
});

await test("without the secret: plain names, limits still counted in Redis, logged once without a value", async () => {
  cmds.length = 0;
  warnings.length = 0;
  assert.equal(rateKeysKeyed(), false);
  await hitRateLimit(IP, "relay-station-ip", 12, Date.now(), 3600, { failClosed: true });
  await hitRateLimit(WALLET, "relay-station-wallet", 4, Date.now(), 86_400, { failClosed: true });
  assert.deepEqual(incrKeys().map(tagOf), [plain(IP), plain(WALLET)]);
  assert.equal(warnings.filter((w) => w.includes("gloam_rate_limit_key_unset")).length, 1, "said once");
});

const secret = randomBytes(32);
await test("with the secret: keyed names, the same on every call, never the plain hash", async () => {
  env.GLOAM_RATE_LIMIT_KEY = secret.toString("base64");
  assert.equal(rateKeysKeyed(), true);
  cmds.length = 0;
  const now = Date.now();
  await hitRateLimit(IP, "relay-station-ip", 12, now, 3600, { failClosed: true });
  await hitRateLimit(WALLET, "relay-station-wallet", 4, now, 86_400, { failClosed: true });
  await hitRateLimit(IP, "cashout-later", 20, now, 3600);
  await hitRateLimit(NULLIFIER, "cashout-later-nf", 6, now, 3600);
  await hitRateLimit(IP, "cashout-later", 20, now, 3600);
  const tags = incrKeys().map(tagOf);
  assert.deepEqual(tags, [
    keyed(secret, "relay-station-ip", IP),
    keyed(secret, "relay-station-wallet", WALLET),
    keyed(secret, "cashout-later", IP),
    keyed(secret, "cashout-later-nf", NULLIFIER),
    keyed(secret, "cashout-later", IP),
  ]);
  assert.equal(tags[2], tags[4], "the same subject in the same bucket shares its count");
  assert.notEqual(tags[0], tags[2], "one IP is named differently in two buckets");
  for (const s of [IP, WALLET, NULLIFIER]) assert.ok(!tags.includes(plain(s)), "no name is the plain hash of what it counts");
  assert.ok(!incrKeys().some((k) => k.includes(IP) || k.toLowerCase().includes(WALLET.slice(2)) || k.includes(NULLIFIER.slice(2))), "nothing in the clear");
  // hex works as well as base64
  env.GLOAM_RATE_LIMIT_KEY = secret.toString("hex");
  cmds.length = 0;
  await hitRateLimit(IP, "relay-station-ip", 12, now, 3600, { failClosed: true });
  assert.equal(tagOf(incrKeys()[0]!), keyed(secret, "relay-station-ip", IP));
  // another secret, other names
  const other = randomBytes(32);
  env.GLOAM_RATE_LIMIT_KEY = other.toString("base64");
  cmds.length = 0;
  await hitRateLimit(IP, "relay-station-ip", 12, now, 3600, { failClosed: true });
  assert.equal(tagOf(incrKeys()[0]!), keyed(other, "relay-station-ip", IP));
  assert.notEqual(keyed(other, "relay-station-ip", IP), keyed(secret, "relay-station-ip", IP));
});

await test("a secret under 32 bytes is not used", async () => {
  env.GLOAM_RATE_LIMIT_KEY = randomBytes(16).toString("base64");
  assert.equal(rateKeysKeyed(), false);
  cmds.length = 0;
  await hitRateLimit(IP, "relay-station-ip", 12, Date.now(), 3600, { failClosed: true });
  assert.equal(tagOf(incrKeys()[0]!), plain(IP));
  env.GLOAM_RATE_LIMIT_KEY = secret.toString("base64");
});

await test("keys written together expire apart, each within two to three windows", async () => {
  for (const w of [60, 3600, 86_400]) {
    const ttls = Array.from({ length: 200 }, () => keyTtl(w));
    assert.ok(ttls.every((t) => Number.isInteger(t) && t >= 2 * w && t <= 3 * w), `window ${w}`);
    assert.ok(new Set(ttls).size > 20, `window ${w}: the expiries vary`);
  }
  cmds.length = 0;
  const now = Date.now();
  // one gas-station request and one scheduled cash out: an IP's count beside a wallet's, an IP's beside a spend's
  await hitRateLimit(IP, "relay-station-ip", 12, now, 3600, { failClosed: true });
  await hitRateLimit(WALLET, "relay-station-wallet", 4, now, 3600, { failClosed: true });
  await hitRateLimit(`198.51.100.${randomBytes(1)[0]}`, "cashout-later", 20, now, 3600);
  await hitRateLimit(NULLIFIER, "cashout-later-nf", 6, now, 3600);
  const expiries = cmds.filter((c) => c[0] === "EXPIRE").map((c) => Number(c[2]));
  assert.equal(expiries.length, 4);
  assert.ok(expiries.every((t) => t >= 7200 && t <= 10_800));
  // the chance two of four random expiries in 3,601 seconds collide is about 0.2%; draw again before failing
  let distinct = new Set(expiries).size === expiries.length;
  for (let i = 0; i < 5 && !distinct; i++) distinct = new Set([keyTtl(3600), keyTtl(3600), keyTtl(3600), keyTtl(3600)]).size === 4;
  assert.ok(distinct, "expiries of keys written together differ");
});

await test("proof checks are counted in Redis, and refused when the count can't be kept", async () => {
  cmds.length = 0;
  const r = await hitRateLimit(IP, "verify", 20, Date.now(), 60, { failClosed: true });
  assert.ok(r.allowed);
  assert.equal(incrKeys().filter((k) => k.startsWith("gloam:mcp:rl:verify:")).length, 1, "the verify count is shared");
  redisDown = true;
  await assert.rejects(() => hitRateLimit(IP, "verify", 20, Date.now(), 60, { failClosed: true }), SharedCountUnavailable);
  // the hosted MCP tool says so, and checks nothing
  const { callTool } = await import("../src/lib/mcpRemote/tools");
  const r2 = await callTool("gloam_verify_proof", { proof: "gloampay1:not-a-real-proof" }, { origin: "https://www.gloam.trade", ip: IP });
  const said = (r2.content as { text: string }[])[0]!.text;
  assert.ok(r2.isError && /paused/.test(said), said);
  redisDown = false;
  cmds.length = 0;
  const r3 = await callTool("gloam_verify_proof", { proof: "gloampay1:not-a-real-proof" }, { origin: "https://www.gloam.trade", ip: IP });
  assert.ok(incrKeys().some((k) => k.startsWith("gloam:mcp:rl:verify:")), "counted in Redis");
  assert.ok(!/paused/.test((r3.content as { text: string }[])[0]!.text));
});

console.warn = warn;
console.log(`\nrate keys: ${passed} passed`);
