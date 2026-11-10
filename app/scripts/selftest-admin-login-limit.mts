/**
 * Self-test: admin sign-in fails closed when its try count can't be kept.
 *
 * The code tries are counted in Redis, shared by every instance. When Redis
 * does not answer, answers an error, or a production build has none, a try is
 * refused with a 503 and the code is never checked, the right code included: a
 * count in one instance's memory would let a guesser spread tries across
 * instances. With Redis answering, tries are held to 5 a minute per IP.
 *
 * fetch is stubbed as an Upstash REST pipeline; nothing leaves this process.
 *
 * Run from app/:  ../mcp/node_modules/.bin/tsx scripts/selftest-admin-login-limit.mts
 */
import assert from "node:assert/strict";
import Module from "node:module";
import { fileURLToPath } from "node:url";

const stub = fileURLToPath(new URL("./server-only-stub.cjs", import.meta.url));
const M = Module as unknown as { _resolveFilename: (req: string, ...rest: unknown[]) => string };
const resolve = M._resolveFilename;
M._resolveFilename = function (req: string, ...rest: unknown[]) {
  return req === "server-only" ? stub : resolve.call(this, req, ...rest);
};

const env = process.env as Record<string, string | undefined>;
env.NODE_ENV = "test";
env.GLOAM_RATE_LIMIT_KEY = "ab".repeat(32);
env.ADMIN_ACCESS_CODE = "a-long-random-admin-code-for-the-login-limit-test";
const CODE = env.ADMIN_ACCESS_CODE;

type Redis = "up" | "down" | "throws" | "error";
let redis: Redis = "up";
const counts = new Map<string, number>();
let redisCalls = 0;
globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
  const url = String(input);
  if (!url.startsWith("https://redis.test/")) throw new Error(`selftest-admin-login-limit: no network calls allowed (${url})`);
  redisCalls++;
  if (redis === "down") return new Response("unavailable", { status: 503 });
  if (redis === "throws") throw new TypeError("fetch failed");
  const cmds = JSON.parse(String(init?.body ?? "[]")) as (string | number)[][];
  if (redis === "error") return new Response(JSON.stringify(cmds.map(() => ({ error: "ERR max daily request limit exceeded" }))), { status: 200 });
  return new Response(
    JSON.stringify(
      cmds.map((c) => {
        if (c[0] !== "INCR") return { result: 1 };
        const n = (counts.get(String(c[1])) ?? 0) + 1;
        counts.set(String(c[1]), n);
        return { result: n };
      }),
    ),
    { status: 200 },
  );
}) as typeof fetch;

const warn = console.warn;
const warnings: string[] = [];
console.warn = (...a: unknown[]) => void warnings.push(a.map(String).join(" "));

const { POST: login } = await import("../src/app/api/admin/login/route");
const { ADMIN_COOKIE } = await import("../src/lib/adminAuth");

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  await fn();
  passed++;
  console.log(`ok  ${name}`);
}

const tryCode = (code: string, ip: string) =>
  login(
    new Request("http://localhost:3000/api/admin/login", {
      method: "POST",
      body: JSON.stringify({ code }),
      headers: { host: "localhost:3000", origin: "http://localhost:3000", "content-type": "application/json", "x-forwarded-for": ip },
    }),
  );
const cookieSet = (res: Response) => (res.headers.get("set-cookie") ?? "").includes(`${ADMIN_COOKIE}=`);

function useRedis(on: boolean) {
  if (on) {
    env.UPSTASH_REDIS_REST_URL = "https://redis.test";
    env.UPSTASH_REDIS_REST_TOKEN = "test-token";
  } else {
    delete env.UPSTASH_REDIS_REST_URL;
    delete env.UPSTASH_REDIS_REST_TOKEN;
  }
}

await test("Redis answering: the count is shared, five tries a minute per IP, the right code signs in", async () => {
  useRedis(true);
  redis = "up";
  redisCalls = 0;
  for (let i = 0; i < 5; i++) assert.equal((await tryCode("wrong", "198.51.100.60")).status, 401, `try ${i + 1}`);
  const sixth = await tryCode(CODE, "198.51.100.60");
  assert.equal(sixth.status, 429, "the sixth try is refused, the right code too");
  assert.ok(Number(sixth.headers.get("retry-after")) > 0);
  assert.ok(!cookieSet(sixth));
  assert.ok(redisCalls >= 6, "counted in Redis");
  const ok = await tryCode(CODE, "198.51.100.61");
  assert.equal(ok.status, 200, "another IP signs in");
  assert.ok(cookieSet(ok));
});

for (const mode of ["down", "throws", "error"] as const) {
  await test(`Redis ${mode === "down" ? "answering 503" : mode === "throws" ? "not answering" : "refusing the command"}: 503, the code is never checked`, async () => {
    useRedis(true);
    redis = mode;
    warnings.length = 0;
    for (let i = 0; i < 12; i++) {
      const res = await tryCode(i % 2 ? CODE : "wrong", `198.51.100.${70 + (mode === "down" ? 0 : mode === "throws" ? 1 : 2)}`);
      assert.equal(res.status, 503, `try ${i + 1}`);
      assert.ok(!cookieSet(res), "no session");
      assert.equal(res.headers.get("retry-after"), "30");
      const j = (await res.json()) as { ok: boolean; error: string };
      assert.equal(j.ok, false);
      assert.match(j.error, /paused/);
    }
    assert.ok(warnings.some((w) => w.includes("gloam_admin_login_unavailable")), "said why");
    assert.ok(!warnings.some((w) => w.includes(CODE) || w.includes("test-token")), "never the code or the token");
  });
}

await test("Redis back: tries count again from where Redis left them", async () => {
  redis = "up";
  const res = await tryCode(CODE, "198.51.100.62");
  assert.equal(res.status, 200);
});

await test("a production build with no Redis: 503, never a count in memory", async () => {
  useRedis(false);
  env.NODE_ENV = "production";
  try {
    for (let i = 0; i < 8; i++) {
      const res = await tryCode(CODE, "198.51.100.80");
      assert.equal(res.status, 503, `try ${i + 1}`);
      assert.ok(!cookieSet(res));
    }
  } finally {
    env.NODE_ENV = "test";
  }
});

await test("local development with no Redis: counted in memory, still five a minute", async () => {
  useRedis(false);
  for (let i = 0; i < 5; i++) assert.equal((await tryCode("wrong", "198.51.100.90")).status, 401);
  assert.equal((await tryCode(CODE, "198.51.100.90")).status, 429);
  assert.equal((await tryCode(CODE, "198.51.100.91")).status, 200);
});

console.warn = warn;
console.log(`\nadmin login limit: ${passed} passed`);
