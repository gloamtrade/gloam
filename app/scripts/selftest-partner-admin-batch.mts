/**
 * Self-test: the admin partner list (GET /api/partners/admin) reads the store
 * in batches.
 *
 *  - it shows what the one-partner reads show: active keys, live link codes,
 *    receiving addresses and the migration note, for every partner
 *  - it costs the same number of store round trips for 3 partners as for 15:
 *    it used to make 4 or 5 per partner
 *  - the batched link-code read still tidies: a code whose record is gone
 *    leaves the partner's sets, and an expired one leaves the live set once
 *
 * The store is the in-process one, reached through a stubbed Upstash REST
 * pipeline so every round trip is counted; nothing leaves this process.
 *
 * Run from app/:  ../mcp/node_modules/.bin/tsx scripts/selftest-partner-admin-batch.mts
 */
import assert from "node:assert/strict";
import Module from "node:module";
import { fileURLToPath } from "node:url";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

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
env.ADMIN_ACCESS_CODE = "a-long-random-admin-code-for-the-partner-admin-batch-test";
env.GLOAM_PARTNERS_STORE = "memory";
env.UPSTASH_REDIS_REST_URL = "https://redis.test";
env.UPSTASH_REDIS_REST_TOKEN = "test-token";

const { kv, kv1, k, resetMemoryKv } = await import("../src/lib/partnersKv");

/** The store as Redis: every pipeline is one round trip, run on the in-process store. */
let roundTrips = 0;
globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
  const url = String(input);
  if (url !== "https://redis.test/pipeline") throw new Error(`selftest-partner-admin-batch: no network calls allowed (${url})`);
  roundTrips++;
  const cmds = JSON.parse(String(init?.body ?? "[]")) as (string | number)[][];
  // kv runs the in-process store synchronously, so the switch covers this call only
  env.GLOAM_PARTNERS_STORE = "memory";
  const p = kv(cmds);
  delete env.GLOAM_PARTNERS_STORE;
  return new Response(JSON.stringify((await p).map((result) => ({ result }))), { status: 200 });
}) as typeof fetch;

const P = await import("../src/lib/partners");
const L = await import("../src/lib/partnerLinks");
const AK = await import("../src/lib/apiKeys");
const AD = await import("../src/lib/partnerAddresses");
const { createAdminSession, ADMIN_COOKIE } = await import("../src/lib/adminAuth");
const { GET: adminGet } = await import("../src/app/api/partners/admin/route");

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  await fn();
  passed++;
  console.log(`ok  ${name}`);
}

resetMemoryKv();
const PEPPER = "a-test-pepper-that-is-at-least-32-characters-long";
const wallet = () => privateKeyToAccount(generatePrivateKey()).address;

type Seeded = { id: string; keys: number; live: number; addresses: number };
/** Partners with some keys (one revoked), codes (one revoked, one expired) and addresses. Seeded on the in-process store. */
async function seed(n: number, from: number): Promise<Seeded[]> {
  env.GLOAM_PARTNERS_STORE = "memory";
  const out: Seeded[] = [];
  try {
    for (let i = from; i < from + n; i++) {
      const p = await P.upsertPartner(wallet(), { name: `Partner ${i}` });
      const keys = i % 3;
      for (let j = 0; j < keys; j++) await AK.createApiKey({ partnerId: p.id, name: `k${j}`, env: j ? "test" : "live", pepper: PEPPER });
      if (i % 2) {
        const extra = await AK.createApiKey({ partnerId: p.id, name: "old", env: "live", pepper: PEPPER });
        await AK.revokeApiKey({ partnerId: p.id, keyId: extra.key.id });
      }
      const live = (i % 4) + 1;
      for (let j = 0; j < live; j++) await L.issueLinkCode({ partnerId: p.id, by: "partner" });
      const gone = await L.issueLinkCode({ partnerId: p.id, by: "partner" });
      await L.revokeLinkCode({ code: gone.code, partnerId: p.id });
      await L.issueLinkCode({ partnerId: p.id, by: "admin", expiresInDays: 1, now: Date.now() - 2 * 86_400_000 });
      const addresses = i % 3;
      if (addresses) await AD.setPartnerAddresses(p.id, Array.from({ length: addresses }, () => ({ chainId: 4663, address: wallet() })), "add");
      out.push({ id: p.id, keys, live, addresses });
    }
  } finally {
    delete env.GLOAM_PARTNERS_STORE;
  }
  return out;
}

(globalThis as { __testCookies?: Record<string, string> }).__testCookies = { [ADMIN_COOKIE]: createAdminSession()! };
type Row = { id: string; activeKeys: number; liveCodes: number; addresses: { total: number; verified: number }; migration: string | null; totals: unknown };
async function list(): Promise<{ rows: Row[]; trips: number }> {
  roundTrips = 0;
  const res = await adminGet(new Request("https://gloam.trade/api/partners/admin?tier=mainnet") as never);
  assert.equal(res.status, 200);
  const j = (await res.json()) as { data: { backend: string; partners: Row[] } };
  assert.equal(j.data.backend, "redis");
  return { rows: j.data.partners, trips: roundTrips };
}

const seeded = await seed(3, 0);

await test("every partner's keys, live codes and addresses match the one-partner reads", async () => {
  // the first list migrates each new account once; compare on the second
  await list();
  const { rows } = await list();
  assert.equal(rows.length, 3);
  for (const s of seeded) {
    const row = rows.find((r) => r.id === s.id)!;
    assert.equal(row.activeKeys, s.keys, `${s.id}: active keys`);
    assert.equal(row.activeKeys, (await AK.listApiKeys(s.id)).filter((x) => x.revokedAt === null).length);
    assert.equal(row.liveCodes, s.live, `${s.id}: live codes`);
    assert.equal(row.liveCodes, (await L.listLinkCodes(s.id)).filter((c) => L.linkCodeState(c) === "live").length);
    assert.deepEqual(row.addresses, { total: s.addresses, verified: 0 }, `${s.id}: addresses`);
    assert.deepEqual(row.addresses, AD.countAddresses(await AD.getPartnerAddresses(s.id)));
    assert.equal(row.migration, await P.migrationNote(s.id));
  }
});

await test("a migration note shows on the list as it does alone", async () => {
  const id = seeded[0]!.id;
  env.GLOAM_PARTNERS_STORE = "memory";
  await kv1(["SET", k("v2", id), "partial:7"]);
  delete env.GLOAM_PARTNERS_STORE;
  const { rows } = await list();
  assert.equal(rows.find((r) => r.id === id)!.migration, "partial:7");
  assert.deepEqual(await P.migrationNotes([id, seeded[1]!.id]), ["partial:7", null]);
});

await test("the list costs the same round trips for 3 partners as for 15", async () => {
  const three = (await list()).trips;
  await seed(12, 3);
  await list(); // migrates the new accounts once
  const fifteen = await list();
  assert.equal(fifteen.rows.length, 15);
  assert.equal(fifteen.trips, three, `3 partners: ${three} round trips, 15: ${fifteen.trips}`);
  assert.ok(three <= 12, `a fixed handful (${three})`);
  console.log(`    ${three} round trips for 3 partners and for 15`);
});

await test("the batched code read still tidies: a code whose record is gone leaves the sets, an expired one the live set", async () => {
  const id = seeded[1]!.id;
  const [before] = await L.listLinkCodesFor([id]);
  const victim = before!.find((c) => L.linkCodeState(c) === "live")!;
  env.GLOAM_PARTNERS_STORE = "memory";
  await kv1(["DEL", k("link", victim.code)]);
  delete env.GLOAM_PARTNERS_STORE;
  const [after] = await L.listLinkCodesFor([id]);
  assert.equal(after!.length, before!.length - 1);
  env.GLOAM_PARTNERS_STORE = "memory";
  const sets = await kv([
    ["SISMEMBER", k("links", id), victim.code],
    ["SISMEMBER", k("links-live", id), victim.code],
  ]);
  const expired = after!.find((c) => L.linkCodeState(c) === "expired")!;
  const expiredLive = await kv1(["SISMEMBER", k("links-live", id), expired.code]);
  delete env.GLOAM_PARTNERS_STORE;
  assert.deepEqual(sets.map(Number), [0, 0], "dropped from both sets");
  assert.equal(Number(expiredLive), 0, "the expired code left the live set");
  // newest first, per partner, in the order asked
  const both = await L.listLinkCodesFor([seeded[2]!.id, id]);
  assert.equal(both.length, 2);
  assert.ok(both[0]!.every((c) => c.partnerId === seeded[2]!.id) && both[1]!.every((c) => c.partnerId === id));
  for (const codes of both) for (let i = 1; i < codes.length; i++) assert.ok(codes[i - 1]!.createdAt >= codes[i]!.createdAt);
  assert.deepEqual(await L.listLinkCodesFor([]), []);
  assert.deepEqual(await AK.activeKeyCounts([]), {});
  assert.deepEqual(await AD.getPartnerAddressesFor([]), []);
});

console.log(`\npartner admin batch: ${passed} passed`);
