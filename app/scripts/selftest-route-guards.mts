/**
 * Self-test: small guards on the app's config and routes.
 *
 *  - a stale NEXT_PUBLIC_POSEIDON_SHIELD_POOL pointing at a superseded vault is
 *    remapped to the current one, the drainable pre-C1 pool 0x4F38…12D8F (audit
 *    H-P1) included, and so is its deploy block (lib/config)
 *  - a JSON body that parses but is no object (null, a number, an array) gets
 *    the route's normal 400, never a 500: bridge/quote, bridge/private,
 *    cashout/cross-chain
 *  - an admin list whose store does not answer gets a clean 503, like its
 *    siblings (admin/bugs, admin/hunt): testers, updates, contest/entries
 *
 * Nothing reaches any host: fetch fails, and the store is a Redis URL that
 * never answers.
 *
 * Run from app/:  ../mcp/node_modules/.bin/tsx scripts/selftest-route-guards.mts
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

const env = process.env as Record<string, string | undefined>;
env.NODE_ENV = "test";
env.GLOAM_RATE_LIMIT_KEY = "cd".repeat(32);
env.ADMIN_ACCESS_CODE = "a-long-random-admin-code-for-the-route-guards-selftest";
// the drainable pool and its deploy block, as a stale env would have them
const DRAINABLE = "0x4F38a4d80e5ca516A2e5549404C7be0E91c12D8F";
env.NEXT_PUBLIC_POSEIDON_SHIELD_POOL = DRAINABLE;
env.NEXT_PUBLIC_SHIELD_DEPLOY_BLOCK = "90436718";
delete env.NEXT_PUBLIC_HASH_SCHEME;
delete env.GLOAM_PARTNERS_STORE;
env.UPSTASH_REDIS_REST_URL = "https://redis.invalid";
env.UPSTASH_REDIS_REST_TOKEN = "never-used";
globalThis.fetch = (async (url: unknown) => {
  throw new Error(`selftest-route-guards: no network calls allowed (${String(url)})`);
}) as typeof fetch;

let n = 0;

// ------------------------------------------------------------ superseded vaults
{
  const cfg = await import("../src/lib/config");
  assert.equal(cfg.POSEIDON_POOL, cfg.TESTNET_POSEIDON_POOL, "the drainable pool is remapped to the current vault");
  assert.equal(cfg.activePoolAddress(), cfg.TESTNET_POSEIDON_POOL);
  assert.equal(cfg.activeShieldDeployBlock(), cfg.TESTNET_POSEIDON_DEPLOY_BLOCK, "and its deploy block too");
  const diag = cfg.vaultEnvDiagnostics();
  assert.equal(diag.remappedFromLegacy, true, "Settings says the env was remapped");
  assert.equal(diag.deployBlockRemapped, true);
  n += 5;
}

// ------------------------------------------------------------ JSON that is not an object
for (const path of ["bridge/quote", "bridge/private", "cashout/cross-chain"]) {
  const route = (await import(`../src/app/api/${path}/route`)) as { POST: (req: Request) => Promise<Response> };
  for (const raw of ["null", "5", '"text"', "[]", "[{}]", "{nope"]) {
    const res = await route.POST(
      new Request(`https://gloam.trade/api/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.20" },
        body: raw,
      }),
    );
    assert.equal(res.status, 400, `${path} ${raw}`);
    const json = (await res.json()) as { ok: boolean; error?: { message?: string } };
    assert.deepEqual(json, { ok: false, error: { message: "Send the details as JSON." } }, `${path} ${raw}`);
    n += 2;
  }
}

// ------------------------------------------------------------ the store does not answer
{
  const { createAdminSession, ADMIN_COOKIE } = await import("../src/lib/adminAuth");
  const g = globalThis as { __testCookies?: Record<string, string> };
  g.__testCookies = { [ADMIN_COOKIE]: createAdminSession()! };
  for (const path of ["testers", "updates", "contest/entries", "admin/bugs"]) {
    const route = (await import(`../src/app/api/${path}/route`)) as { GET: (req: Request) => Promise<Response> };
    for (const q of ["", "?format=csv"]) {
      const res = await route.GET(new Request(`https://gloam.trade/api/${path}${q}`));
      assert.equal(res.status, 503, `${path}${q}`);
      const json = (await res.json()) as { ok: boolean; error?: { message?: string } };
      assert.equal(json.ok, false);
      assert.match(json.error?.message ?? "", /^Could not read /, `${path}${q}`);
      n += 3;
    }
  }
  g.__testCookies = {};
}

console.log(`route guards: ${n} passed`);
