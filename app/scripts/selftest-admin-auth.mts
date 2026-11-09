/**
 * Self-test: the admin code (lib/adminAuth). There is no built-in code: a
 * build without ADMIN_ACCESS_CODE has no admin sign-in, in development too,
 * so a reachable dev server cannot be opened (or a session forged) with a
 * code that is public in the repo.
 *
 * Run from app/:  ../mcp/node_modules/.bin/tsx scripts/selftest-admin-auth.mts
 */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import Module from "node:module";
import { fileURLToPath } from "node:url";

const stub = fileURLToPath(new URL("./server-only-stub.cjs", import.meta.url));
const M = Module as unknown as { _resolveFilename: (req: string, ...rest: unknown[]) => string };
const resolve = M._resolveFilename;
M._resolveFilename = function (req: string, ...rest: unknown[]) {
  return req === "server-only" ? stub : resolve.call(this, req, ...rest);
};

const auth = await import("../src/lib/adminAuth");
const env = process.env as Record<string, string | undefined>;
let n = 0;

for (const mode of ["development", "test", "production"]) {
  env.NODE_ENV = mode;
  delete env.ADMIN_ACCESS_CODE;
  assert.equal(auth.adminCodeConfigured(), false, `${mode}: no code, no admin sign-in`);
  assert.equal(auth.verifyAdminCode("gloam-dev-admin"), false, `${mode}: the old built-in code is refused`);
  assert.equal(auth.createAdminSession(), null, `${mode}: no session without a code`);
  const exp = String(Math.floor(Date.now() / 1000) + 3600);
  const forged = `${exp}.${createHmac("sha256", "gloam-dev-admin").update(exp).digest("base64url")}`;
  assert.equal(auth.verifyAdminSession(forged), false, `${mode}: a session signed with the old built-in code is refused`);
  n += 4;
}

env.ADMIN_ACCESS_CODE = "a-long-random-admin-code-for-this-test";
assert.equal(auth.verifyAdminCode("a-long-random-admin-code-for-this-test"), true);
const session = auth.createAdminSession();
assert.ok(session && auth.verifyAdminSession(session));
assert.equal(auth.verifyAdminCode("gloam-dev-admin"), false);
n += 3;

// The sign-in and sign-out routes: a JSON request from this site only.
env.NODE_ENV = "test";
env.GLOAM_PARTNERS_STORE = "memory";
delete env.UPSTASH_REDIS_REST_URL;
delete env.UPSTASH_REDIS_REST_TOKEN;
const { POST: loginPost } = await import("../src/app/api/admin/login/route");
const { POST: logoutPost } = await import("../src/app/api/admin/logout/route");
const post = (path: string, ip: string, headers: Record<string, string>, body = JSON.stringify({ code: "wrong" })) =>
  new Request(`http://localhost:3000${path}`, { method: "POST", body, headers: { host: "localhost:3000", "x-forwarded-for": ip, ...headers } });
const json = { "content-type": "application/json" };
const evil = { ...json, origin: "https://evil.example" };
// another site: refused before a try is counted, so the admin's own tries are untouched
for (let i = 0; i < 30; i++) assert.equal((await loginPost(post("/api/admin/login", "198.51.100.40", evil))).status, 403);
assert.equal((await loginPost(post("/api/admin/login", "198.51.100.40", { "content-type": "text/plain" }))).status, 403, "a form-style body is refused");
assert.equal((await loginPost(post("/api/admin/login", "198.51.100.40", { ...json, origin: "http://localhost:3000" }))).status, 401, "this site still gets its tries");
const ok = await loginPost(post("/api/admin/login", "198.51.100.40", { ...json, origin: "http://localhost:3000" }, JSON.stringify({ code: "a-long-random-admin-code-for-this-test" })));
assert.equal(ok.status, 200);
assert.match(ok.headers.get("set-cookie") ?? "", /gloam/i);
assert.equal((await logoutPost(post("/api/admin/logout", "198.51.100.41", evil, "{}"))).status, 403, "another site can't sign the admin out");
assert.equal((await logoutPost(post("/api/admin/logout", "198.51.100.41", { "content-type": "text/plain" }, "{}"))).status, 403);
const out = await logoutPost(post("/api/admin/logout", "198.51.100.41", json, "{}"));
assert.equal(out.status, 200);
assert.match(out.headers.get("set-cookie") ?? "", /Max-Age=0/i);
n += 9;

// clientIp: on Vercel the edge's own headers first; elsewhere as before
const { clientIp } = await import("../src/lib/mcpRemote/rateLimit");
const hdr = (h: Record<string, string>) => new Request("http://localhost/", { headers: h });
const spoofed = { "x-forwarded-for": "203.0.113.9, 198.51.100.1", "x-real-ip": "198.51.100.2", "x-vercel-forwarded-for": "198.51.100.3" };
delete env.VERCEL;
assert.equal(clientIp(hdr(spoofed)), "203.0.113.9");
assert.equal(clientIp(hdr({})), "local");
env.VERCEL = "1";
assert.equal(clientIp(hdr(spoofed)), "198.51.100.3", "x-vercel-forwarded-for first");
assert.equal(clientIp(hdr({ "x-forwarded-for": "203.0.113.9", "x-real-ip": "198.51.100.2" })), "198.51.100.2", "then x-real-ip");
assert.equal(clientIp(hdr({ "x-forwarded-for": "203.0.113.9" })), "203.0.113.9");
assert.equal(clientIp(hdr({})), "local");
delete env.VERCEL;
n += 6;

console.log(`admin auth: ${n} passed`);
