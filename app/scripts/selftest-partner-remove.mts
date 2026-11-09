/**
 * Self-test: an admin removing a partner account (lib/partnerRemove).
 *
 *  - only an admin, from the site, can remove: no admin session is a 401, another
 *    site is a 403, and either leaves the account working
 *  - removing revokes every API key (the v1 relay refuses them as invalid keys),
 *    revokes the live link codes (links stop counting), drops the receiving
 *    addresses and frees the proven ones, takes back both approvals, and takes the
 *    account off the list and out of the program's totals
 *  - the mark alone already shuts the account: a key left active by a removal
 *    that stopped partway is refused by the relay all the same, and a second
 *    removal finishes the job
 *  - past activity stays under the old id and counts nowhere; a transaction it was
 *    counted for can't be counted again for another account
 *  - the owner's wallet sees that the account was removed and can start a new one,
 *    which starts with nothing
 *
 * Uses the in-process store and the development pepper on localhost. Nothing
 * reaches any chain or host.
 *
 * Run from app/:  ../mcp/node_modules/.bin/tsx scripts/selftest-partner-remove.mts
 */
import assert from "node:assert/strict";
import Module from "node:module";
import { fileURLToPath } from "node:url";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Address, Hex } from "viem";

const stubs: Record<string, string> = {
  "server-only": fileURLToPath(new URL("./server-only-stub.cjs", import.meta.url)),
  "next/headers": fileURLToPath(new URL("./next-headers-stub.cjs", import.meta.url)),
};
const M = Module as unknown as { _resolveFilename: (req: string, ...rest: unknown[]) => string };
const resolveFilename = M._resolveFilename;
M._resolveFilename = function (req: string, ...rest: unknown[]) {
  return stubs[req] ?? resolveFilename.call(this, req, ...rest);
};

process.env.GLOAM_PARTNERS_STORE = "memory";
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;
delete process.env.GLOAM_API_KEY_PEPPER;
delete process.env.GLOAM_PARTNER_SESSION_SECRET;
const env = process.env as Record<string, string | undefined>;
env.NODE_ENV = "test";
env.ADMIN_ACCESS_CODE = "a-long-random-admin-code-for-the-remove-selftest";

const { resetMemoryKv, kv1, k } = await import("../src/lib/partnersKv");
const { apiKeyPepper, createApiKey, listApiKeys, lookupApiKey } = await import("../src/lib/apiKeys");
const P = await import("../src/lib/partners");
const L = await import("../src/lib/partnerLinks");
const AD = await import("../src/lib/partnerAddresses");
const { removePartner } = await import("../src/lib/partnerRemove");
const { getNetwork } = await import("../src/lib/networks");
const { createSession, SESSION_COOKIE } = await import("../src/lib/partnersAuth");
const { createAdminSession, ADMIN_COOKIE } = await import("../src/lib/adminAuth");
const { POST: adminPost, GET: adminGet } = await import("../src/app/api/partners/admin/route");
const { POST: relayPost } = await import("../src/app/api/v1/relay/route");
const { GET: sessionGet } = await import("../src/app/api/partners/session/route");
const { PUT: accountPut } = await import("../src/app/api/partners/account/route");
const { GET: keysGet } = await import("../src/app/api/partners/keys/route");

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  await fn();
  passed++;
  console.log(`ok  ${name}`);
}

const HOST = "localhost:3121";
const ORIGIN = `http://${HOST}`;
const RH_TEST = getNetwork("robinhood");
const USDG = "0x7E955252E15c84f5768B83c41a71F9eba181802F" as Address;
const pepper = (() => {
  const p = apiKeyPepper(HOST);
  if (!p.ok) throw new Error("dev pepper should apply on localhost");
  return p.pepper;
})();
const jar = globalThis as { __testCookies?: Record<string, string> };
const asAdmin = () => (jar.__testCookies = { [ADMIN_COOKIE]: createAdminSession()! });
const asNobody = () => (jar.__testCookies = {});
const wallet = () => privateKeyToAccount(generatePrivateKey()).address;

function req(path: string, init: { method?: string; key?: string; body?: unknown; cookie?: string; origin?: string; ip?: string } = {}) {
  const headers: Record<string, string> = { "x-forwarded-host": HOST, "x-forwarded-for": init.ip ?? "198.51.100.9" };
  if (init.key) headers.authorization = `Bearer ${init.key}`;
  if (init.body !== undefined) headers["content-type"] = "application/json";
  if (init.cookie) headers.cookie = init.cookie;
  if (init.method && init.method !== "GET") headers.origin = init.origin ?? ORIGIN;
  return new Request(`${ORIGIN}${path}`, { method: init.method ?? "GET", headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
}
type Envelope = { ok: boolean; data?: Record<string, unknown>; error?: { code: string; message: string } };
const body = async (res: Response) => (await res.json()) as Envelope;
const remove = (id: string, origin?: string) => adminPost(req("/api/partners/admin", { method: "POST", body: { id, remove: true }, origin }) as never);
/** A v1 relay call its key check lets through is refused next for its action ("bad_action"); a bad key never gets that far. */
const relayCode = async (secret: string) =>
  (await body(await relayPost(req("/api/v1/relay", { method: "POST", key: secret, body: { chainId: RH_TEST.chainId, action: "shield" } })))).error?.code;
const sessionOf = (owner: Address) => `${SESSION_COOKIE}=${encodeURIComponent(createSession(owner, HOST)!)}`;

resetMemoryKv();

// one account with everything an account can hold, and one that stays
const owner = wallet();
const acme = await P.upsertPartner(owner, { name: "Acme Test", website: "https://example.com" });
const keyA = await createApiKey({ partnerId: acme.id, name: "a", env: "test", pepper });
const keyB = await createApiKey({ partnerId: acme.id, name: "b", env: "test", pepper });
const code = await L.issueLinkCode({ partnerId: acme.id, by: "admin" });
await P.setRelayApproved(acme.id, true);
await P.setApprovedName(acme.id, true);
const chain = AD.addressChains()[0]!;
const receive = wallet().toLowerCase();
const waiting = wallet().toLowerCase();
await AD.setPartnerAddresses(acme.id, [{ chainId: chain.chainId, address: receive }, { chainId: chain.chainId, address: waiting }], "replace");
await AD.verifyPartnerAddresses(acme.id, [{ chainId: chain.chainId, address: receive, signature: "0x01" as Hex }], async () => true);
const tx = `0x${"ab".repeat(32)}` as Hex;
await P.recordActivity({ partner: (await P.getPartner(acme.id))!, keyId: keyA.key.id, network: RH_TEST, kind: "deposit", txHash: tx, edge: { asset: USDG, amount: 5_000_000n } });

const stays = await P.upsertPartner(wallet(), { name: "Stays" });
const staysKey = await createApiKey({ partnerId: stays.id, name: "k", env: "test", pepper });
await P.recordActivity({ partner: stays, keyId: staysKey.key.id, network: RH_TEST, kind: "deposit", txHash: `0x${"cd".repeat(32)}` as Hex, edge: { asset: USDG, amount: 1_000_000n } });

await test("before: the account's keys pass the relay's key check, its code and address count", async () => {
  assert.equal(await relayCode(keyA.secret), "bad_action");
  assert.ok(await L.resolveLinkCode(code.code));
  assert.equal(await AD.addressOwner(chain.chainId, receive), acme.id);
  assert.equal((await P.readAllPartnerTotals((await P.listPartners()).map((p) => p.id), "testnet")).program.deposits, 2);
});

await test("only an admin removes: no admin session is a 401, another site a 403, and the account keeps working", async () => {
  asNobody();
  const res = await remove(acme.id);
  assert.equal(res.status, 401);
  assert.equal((await body(res)).error?.code, "unauthorized");
  asAdmin();
  const cross = await remove(acme.id, "https://elsewhere.example");
  assert.equal(cross.status, 403);
  asNobody();
  assert.ok(await P.getPartner(acme.id), "still there");
  assert.equal(await relayCode(keyA.secret), "bad_action", "its key still passes");
  // an admin's other changes need the session too
  assert.equal((await adminPost(req("/api/partners/admin", { method: "POST", body: { id: acme.id, relayApproved: false } }) as never)).status, 401);
});

await test("an admin removes it: keys revoked, codes revoked, addresses dropped, approvals gone", async () => {
  asAdmin();
  const res = await remove(acme.id);
  assert.equal(res.status, 200);
  const r = (await body(res)).data!.removed as Record<string, unknown>;
  assert.equal(r.id, acme.id);
  assert.equal(r.keysRevoked, 2);
  assert.equal(r.codesRevoked, 1);
  assert.equal(r.addressesDropped, 2);
  asNobody();
  assert.equal(await P.getPartner(acme.id), null);
  assert.ok((await listApiKeys(acme.id)).every((key) => key.revokedAt !== null), "every key revoked");
  assert.equal(await lookupApiKey(keyA.secret, pepper), null);
  assert.equal(await lookupApiKey(keyB.secret, pepper), null);
  assert.equal((await L.getLinkCode(code.code))?.revokedAt != null, true);
  assert.equal(await L.resolveLinkCode(code.code), null, "links with its code stop counting");
  assert.equal(await AD.addressOwner(chain.chainId, receive), null, "the proven address is free");
  assert.deepEqual(await AD.getPartnerAddresses(acme.id), {});
  assert.equal(await kv1(["GET", k("relay-approved", acme.id)]), null);
  assert.equal(await kv1(["GET", k("name-ok", acme.id)]), null);
});

await test("the relay's partner-key check refuses the removed account's keys", async () => {
  for (const secret of [keyA.secret, keyB.secret]) assert.equal(await relayCode(secret), "invalid_key");
  assert.equal(await relayCode(staysKey.secret), "bad_action", "another account's key still passes");
});

await test("off the admin list and out of the totals; the other account and its totals stay", async () => {
  const listed = await P.listPartners();
  assert.ok(!listed.some((p) => p.id === acme.id));
  assert.ok(listed.some((p) => p.id === stays.id));
  const t = await P.readAllPartnerTotals(listed.map((p) => p.id), "testnet");
  assert.equal(t.program.deposits, 1);
  assert.equal(t.byPartner[stays.id]?.deposits, 1);
  asAdmin();
  const res = await adminGet(req("/api/partners/admin?tier=testnet") as never);
  const d = (await body(res)).data as { partners: { id: string }[]; totals: { deposits: number } };
  assert.ok(!d.partners.some((p) => p.id === acme.id));
  assert.equal(d.totals.deposits, 1);
  asNobody();
  assert.ok(!(await AD.addressBook()).get(chain.chainId)?.has(receive), "the on-chain match no longer knows the address");
});

await test("past activity stays under the old id, counted nowhere, and its transactions can't be counted again", async () => {
  assert.equal((await P.readPartnerStats(acme.id, { tier: "testnet" })).totals.deposits, 1, "kept on record");
  assert.equal(await P.attributedTo(RH_TEST.chainId, tx), acme.id);
  const again = await P.recordActivity({ partner: stays, keyId: staysKey.key.id, network: RH_TEST, kind: "deposit", txHash: tx, edge: { asset: USDG, amount: 5_000_000n } });
  assert.deepEqual(again, { recorded: false, reason: "duplicate" });
});

await test("the owner's wallet sees the removal and can start a new account, which starts with nothing", async () => {
  const s = await body(await sessionGet(req("/api/partners/session", { cookie: sessionOf(owner) }) as never));
  assert.equal(s.data!.partner, null);
  assert.equal((s.data!.removed as { name: string }).name, "Acme Test");
  // the portal's own routes treat it as no account
  assert.equal((await body(await keysGet(req("/api/partners/keys", { cookie: sessionOf(owner) }) as never))).error?.code, "no_account");
  const made = await accountPut(req("/api/partners/account", { method: "PUT", cookie: sessionOf(owner), body: { name: "Acme Fresh" } }) as never);
  assert.equal(made.status, 200);
  const fresh = (await body(made)).data!.partner as { id: string; relayApproved: boolean; approvedName: string | null };
  assert.notEqual(fresh.id, acme.id);
  assert.equal(fresh.relayApproved, false);
  assert.equal(fresh.approvedName, null);
  assert.deepEqual(await listApiKeys(fresh.id), []);
  assert.deepEqual(await L.listLinkCodes(fresh.id), []);
  assert.equal((await P.readPartnerStats(fresh.id, { tier: "testnet" })).totals.deposits, 0);
  const after = await body(await sessionGet(req("/api/partners/session", { cookie: sessionOf(owner) }) as never));
  assert.equal((after.data!.partner as { id: string }).id, fresh.id);
  assert.equal(after.data!.removed, null);
  assert.equal(await relayCode(keyA.secret), "invalid_key", "the old keys stay dead");
});

await test("the mark alone shuts the account: a key a halfway removal left active is refused; a second removal finishes it", async () => {
  const half = await P.upsertPartner(wallet(), { name: "Halfway" });
  const key = await createApiKey({ partnerId: half.id, name: "k", env: "test", pepper });
  const halfCode = await L.issueLinkCode({ partnerId: half.id, by: "partner" });
  // a removal that stopped right after its first write
  await kv1(["SET", k("removed", half.id), JSON.stringify({ id: half.id, owner: half.owner, name: half.name, createdAt: half.createdAt, removedAt: Date.now() })]);
  assert.ok(await lookupApiKey(key.secret, pepper), "the key itself is not revoked yet");
  assert.equal(await relayCode(key.secret), "invalid_key", "but the relay refuses it");
  assert.equal(await L.resolveLinkCode(halfCode.code), null);
  await assert.rejects(L.issueLinkCode({ partnerId: half.id, by: "partner" }), /No partner/);
  // still listed, so the admin can press Remove again
  assert.ok((await P.listPartners()).some((p) => p.id === half.id));
  asAdmin();
  const res = await remove(half.id);
  assert.equal(res.status, 200);
  assert.equal(((await body(res)).data!.removed as { keysRevoked: number }).keysRevoked, 1);
  asNobody();
  assert.equal(await lookupApiKey(key.secret, pepper), null);
  assert.ok(!(await P.listPartners()).some((p) => p.id === half.id));
  assert.equal(await P.getPartnerByOwner(half.owner), null);
});

await test("removing a removed account changes nothing; an unknown or malformed id is a 404", async () => {
  const again = await removePartner(acme.id);
  assert.ok(again);
  assert.equal(again.keysRevoked + again.codesRevoked + again.addressesDropped, 0);
  assert.ok(await P.getPartnerByOwner(owner), "the wallet's new account is untouched");
  asAdmin();
  assert.equal((await remove("ptr_nobody00")).status, 404);
  assert.equal((await remove("not-an-id")).status, 404);
  const wrong = await adminPost(req("/api/partners/admin", { method: "POST", body: { id: stays.id, remove: "yes" } }) as never);
  assert.equal(wrong.status, 400, "only remove: true removes");
  asNobody();
  assert.ok(await P.getPartner(stays.id));
});

console.log(`\n${passed} partner removal tests passed`);
process.exit(0);
