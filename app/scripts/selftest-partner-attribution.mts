/**
 * Self-test: partner link codes, link attribution bound before the send, the
 * on-chain match, and partner analytics. Includes the PR 195 review's attacks
 * as regressions (F1 to F8).
 *
 *  - link codes: issue, revoke, live and total caps, revoked records expire; a
 *    forged, malformed, revoked or expired code, or one whose account is gone,
 *    counts for nobody
 *  - names: plain-name rules (no Gloam, no web address), the name in links only
 *    once an admin approved it, locked through a rename
 *  - links: `p=` rides in the pay and swap links' fragment; name and ref never count
 *  - the classifier on real Robinhood Chain mainnet receipts (recipients replaced
 *    with made-up addresses; scripts/fixtures/partner-attribution-rh.json)
 *  - binding: a wallet send counts only when registered before its block; a relay
 *    send is registered by the relay and counted once it lands; the earliest
 *    registration of a spend wins; nobody can claim a transaction afterwards
 *    (the review's steal, scheduled cash out and free-claim attacks); a scheduled
 *    cash out registered when scheduled; flows, chains, failed and old transactions
 *  - routes: register, attribute and lookup need the gloam.trade Origin (none is
 *    refused), take only their fields, and the per-code limit is per IP too
 *  - privacy: no wallet, recipient, IP or nullifier in the store; partners never
 *    see a private payment's hash; a cash out to a proven address goes to its owner
 *  - mainnet and testnet apart; testnet never valued; the daily CSV names networks
 *  - analytics by source, kind, asset and day; a claim reversed exactly; older
 *    activity replayed into the new counters once
 *  - receiving addresses proven by EIP-191 signatures; the on-chain match: dry run
 *    first, per-address results, moves a link's cash out to the address's owner,
 *    leaves an API key's, settles registered cash outs, holds its cursor on an
 *    unread receipt, stops at its budget; deploy blocks match contracts/deployments
 *
 * The partner store is the in-process one and every chain read is a fake: nothing
 * reaches any host.
 *
 * Run from app/:  ../mcp/node_modules/.bin/tsx scripts/selftest-partner-attribution.mts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Module from "node:module";
import { fileURLToPath } from "node:url";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { encodeFunctionData, verifyMessage, type Address, type Hex } from "viem";

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
const env = process.env as Record<string, string | undefined>;
env.NODE_ENV = "test";
env.GLOAM_PARTNER_SESSION_SECRET = "s".repeat(48);
env.ADMIN_ACCESS_CODE = "a-long-random-admin-code-for-this-selftest";

const { resetMemoryKv, kv1, k } = await import("../src/lib/partnersKv");
const P = await import("../src/lib/partners");
const L = await import("../src/lib/partnerLinks");
const { classifyVaultTx, kindFitsFlow } = await import("../src/lib/partnerVerify");
const A = await import("../src/lib/partnerAttribution");
const B = await import("../src/lib/partnerBackfill");
const AD = await import("../src/lib/partnerAddresses");
/** Elysium mainnet, while NEXT_PUBLIC_ELYSIUM_ENABLED is on (as production builds it): one more mainnet to read. */
const { ELYSIUM } = await import("../src/lib/elysium");
const { linkNullifierHash, linkBindHash, proofBindValue } = await import("../src/lib/partnerCode");
const { relayPoolAbi } = await import("../src/lib/relay/server");
const { getNetwork } = await import("../src/lib/networks");
const { swapRoutersOn, EVERY_SWAP_ROUTER, vaultSwapAbi, vaultSwapV3Abi } = await import("../src/lib/vaultSwap");
const { buildPaymentRequestLink, readPaymentRequest, requestParamsFrom, requestAssetsFor } = await import("../src/lib/paymentRequest");
const { buildSwapLink, swapLinkFromHash } = await import("../src/lib/swapLink");
const { ApiError } = await import("../src/lib/partnersApi");
const { createSession, SESSION_COOKIE } = await import("../src/lib/partnersAuth");
const { createAdminSession, ADMIN_COOKIE } = await import("../src/lib/adminAuth");
const { POST: attributePost } = await import("../src/app/api/partners/attribute/route");
const { POST: registerPost } = await import("../src/app/api/partners/register/route");
const { POST: lookupPost } = await import("../src/app/api/partners/link-code/route");
const { GET: statsGet } = await import("../src/app/api/partners/stats/route");
const { GET: exportGet } = await import("../src/app/api/partners/export/route");
const { POST: backfillPost } = await import("../src/app/api/partners/admin/backfill/route");

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  await fn();
  passed++;
  console.log(`ok  ${name}`);
}

async function throwsApi(p: Promise<unknown>, status: number, code: string) {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof ApiError, `expected an ApiError, got ${String(e)}`);
    assert.equal(e.status, status, `status for ${code}: ${e.message}`);
    assert.equal(e.code, code);
    return;
  }
  assert.fail(`expected ${status} ${code}`);
}

resetMemoryKv();
const RH = getNetwork("robinhood-mainnet");
const TEMPO = getNetwork("tempo-mainnet");
const RH_TEST = getNetwork("robinhood");
const HOST = "gloam.trade";

type Rcpt = { status: "success"; blockNumber: string; blockTimestamp: number; logs: { address: string; topics: string[]; data: string }[] };
type Fixture = {
  cashOuts: Hex[];
  privatePayment: Hex;
  swap: Hex;
  receipts: Record<string, Rcpt>;
  unshieldLogs: { txHash: Hex; blockNumber: string; nullifier: Hex; asset: Address; to: Address; amount: string }[];
};
const FX = JSON.parse(readFileSync(new URL("./fixtures/partner-attribution-rh.json", import.meta.url), "utf8")) as Fixture;
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as Address;
const ctxRH = { pool: RH.pool!, routers: swapRoutersOn(RH.chainId).map((r) => r.address), anyRouter: EVERY_SWAP_ROUTER };
const rcpt = (h: Hex) => FX.receipts[h.toLowerCase()] ?? FX.receipts[h]!;
const nullifierOf = (h: Hex): Hex => {
  const f = classifyVaultTx(rcpt(h).logs, ctxRH);
  assert.ok(f.ok);
  return f.nullifier;
};
const wallet = () => privateKeyToAccount(generatePrivateKey()).address;

/** 64 bytes standing in for a cash out's proof (the fixture keeps receipts, not calldata). */
const proofFor = (h: Hex) => `0x${h.slice(2)}${h.slice(2)}` as Hex;
const cashOutSet = new Set(FX.cashOuts.map((h) => h.toLowerCase()));
/** Each fixture cash out's call to the vault, as its wallet would have sent it. */
const inputs = new Map<string, Hex>(
  FX.unshieldLogs
    .filter((l) => cashOutSet.has(l.txHash.toLowerCase()))
    .map((l) => [
      l.txHash.toLowerCase(),
      encodeFunctionData({ abi: relayPoolAbi, functionName: "unshield", args: [proofFor(l.txHash), `0x${"00".repeat(32)}`, l.nullifier, l.asset, l.to, BigInt(l.amount)] }),
    ])
);

/** The relay's signer, and a payer's own wallet: who sent each fixture transaction in a test. */
const RELAYER = "0xb1E994586E62994648a0b866BF33F2EDd942512e";
const PAYER = "0x000000000000000000000000000000000000bEEF";
const relaySent = new Set<string>();
const sentByRelay = (h: Hex, yes = true) => void (yes ? relaySent.add(h.toLowerCase()) : relaySent.delete(h.toLowerCase()));

type Chain = Map<number, Map<string, Rcpt>>;
function fakeChain(chain: Chain, nowSec: number): import("../src/lib/partnerAttribution").AttributionDeps {
  return {
    tx: async (net, hash) =>
      net.chainId === RH.chainId
        ? { from: relaySent.has(hash.toLowerCase()) ? RELAYER : PAYER, to: RH.pool!, input: inputs.get(hash.toLowerCase()) ?? "0x" }
        : null,
    relaySigners: () => [RELAYER.toLowerCase()],
    receipt: async (net, hash) => {
      const r = chain.get(net.chainId)?.get(hash.toLowerCase());
      return r ? { status: r.status, blockNumber: BigInt(r.blockNumber), logs: r.logs } : null;
    },
    blockTime: async (net, block) => {
      for (const r of chain.get(net.chainId)?.values() ?? []) if (BigInt(r.blockNumber) === block) return r.blockTimestamp;
      throw new Error("no such block");
    },
    record: P.recordActivity,
    now: () => nowSec * 1000,
  };
}
const rhChain: Chain = new Map([[RH.chainId, new Map(Object.entries(FX.receipts).map(([h, r]) => [h.toLowerCase(), r]))]]);
const after = (h: Hex, sec = 60) => fakeChain(rhChain, rcpt(h).blockTimestamp + sec);
const before = (h: Hex, sec = 30) => (rcpt(h).blockTimestamp - sec) * 1000;

/** The in-process store, for reading TTLs and clearing keys. */
const g = () => (globalThis as { __gloamPartnersMem?: Map<string, { v: unknown; exp: number | null }> }).__gloamPartnersMem!;

function unclaim(hashes: Hex[]) {
  const g = globalThis as { __gloamPartnersMem?: Map<string, unknown> };
  for (const h of hashes) {
    g.__gloamPartnersMem?.delete(k("tx", RH.chainId, h.toLowerCase()));
    g.__gloamPartnersMem?.delete(k("txrec", RH.chainId, h.toLowerCase()));
  }
}
function unregister(hashes: Hex[]) {
  const g = globalThis as { __gloamPartnersMem?: Map<string, unknown> };
  for (const h of hashes) {
    // a hash made up for a test has no receipt of its own, and no registration
    if (FX.receipts[h.toLowerCase()] ?? FX.receipts[h]) g.__gloamPartnersMem?.delete(k("reg", RH.chainId, linkNullifierHash(nullifierOf(h)).toLowerCase()));
    g.__gloamPartnersMem?.delete(k("relaytx", RH.chainId, h.toLowerCase()));
  }
  // every relay payment binding on the chain
  for (const key of [...(g.__gloamPartnersMem?.keys() ?? [])]) {
    if (key.startsWith(k("relayspend", RH.chainId) + ":") || key.startsWith(k("relayspendnf", RH.chainId) + ":")) g.__gloamPartnersMem?.delete(key);
  }
}
/** A fixture cash out's call to the vault: the one it landed with, or with another proof, recipient, root or amount. */
function unshieldCall(h: Hex, over: { proof?: Hex; to?: Address; root?: Hex; amount?: bigint } = {}): Hex {
  const l = FX.unshieldLogs.find((x) => x.txHash.toLowerCase() === h.toLowerCase())!;
  return encodeFunctionData({
    abi: relayPoolAbi,
    functionName: "unshield",
    args: [over.proof ?? proofFor(h), over.root ?? `0x${"00".repeat(32)}`, l.nullifier, l.asset, over.to ?? l.to, over.amount ?? BigInt(l.amount)],
  });
}
/** What the relay route's beforeBroadcast hook does for a cash out it is about to send: binds the code to that payment. */
const bindPay = (code: string, h: Hex, at: number, data: Hex = unshieldCall(h), net = RH) =>
  A.bindRelaySpend({ net, tx: { to: net.pool!, data }, code, flow: "pay", at });
/** The value only the spender had when it sent: a payment's new note commitment, a cash out's proof. */
const bindFor = (h: Hex): Hex => {
  const f = classifyVaultTx(rcpt(h).logs, ctxRH);
  assert.ok(f.ok);
  return f.kind === "private_payment" ? linkBindHash(f.paymentCommitment) : linkBindHash(proofBindValue(proofFor(h)));
};
/** A wallet registration of a fixture spend, bound to `bind` (the right value unless given). */
const regApp = (code: string, h: Hex, at: number, bind: Hex = bindFor(h)) =>
  A.registerLink({ chainId: RH.chainId, nullifierHash: linkNullifierHash(nullifierOf(h)), bindHash: bind, code, flow: "pay", at });
const settle = (h: Hex, deps = after(h)) => A.settleLinkTx({ chainId: RH.chainId, txHash: h }, deps);

const motionOwner = wallet();
const motion = await P.upsertPartner(motionOwner, { name: "Motion" });
const mallory = await P.upsertPartner(wallet(), { name: "Mallory" });

// ---------------------------------------------------------------- link codes (F4)

await test("codes: a partner and an admin each issue one; 20 letters and digits, unique, listed newest first", async () => {
  const a = await L.issueLinkCode({ partnerId: motion.id, label: "Fund button", by: "partner", now: 1_000 });
  const b = await L.issueLinkCode({ partnerId: motion.id, label: "  Swap‮page ", by: "admin", now: 2_000 });
  assert.match(a.code, /^[A-Za-z0-9]{20}$/);
  assert.equal(b.label, "Swap page", "a direction override is taken out of a label");
  assert.deepEqual((await L.listLinkCodes(motion.id)).map((c) => c.code), [b.code, a.code]);
  const seen = new Set(Array.from({ length: 2_000 }, () => L.generateLinkCode()));
  assert.equal(seen.size, 2_000);
});

await test("codes: revoke only by the owner (or an admin); revoking twice keeps the first time; a revoked record expires", async () => {
  const c = await L.issueLinkCode({ partnerId: motion.id, by: "partner" });
  assert.equal(await L.revokeLinkCode({ code: c.code, partnerId: mallory.id }), null, "another partner can't");
  const r = await L.revokeLinkCode({ code: c.code, partnerId: motion.id, now: 5_000 });
  assert.equal(r?.revokedAt, 5_000);
  assert.equal((await L.revokeLinkCode({ code: c.code, now: 9_000 }))?.revokedAt, 5_000);
  assert.equal(await L.resolveLinkCode(c.code), null);
  const g = globalThis as { __gloamPartnersMem?: Map<string, { exp: number | null }> };
  const exp = g.__gloamPartnersMem!.get(k("link", c.code))!.exp!;
  assert.ok(exp - Date.now() <= L.REVOKED_TTL_SEC * 1000 && exp - Date.now() > (L.REVOKED_TTL_SEC - 60) * 1000, "kept 30 days, then gone");
  assert.equal(await kv1(["SISMEMBER", k("links-live", motion.id), c.code]), 0, "out of the live set");
  // an expired code leaves the live set once; reading the list again doesn't push its expiry back
  const old = await L.issueLinkCode({ partnerId: motion.id, expiresInDays: 1, by: "partner", now: Date.now() - 3 * 86_400_000 });
  await L.listLinkCodes(motion.id);
  const first = g.__gloamPartnersMem!.get(k("link", old.code))!.exp!;
  await new Promise((r) => setTimeout(r, 20));
  await L.listLinkCodes(motion.id);
  assert.equal(g.__gloamPartnersMem!.get(k("link", old.code))!.exp, first, "the 30 days start once");
});

await test("codes: forged, malformed, expired and orphaned codes resolve to nobody", async () => {
  assert.equal(await L.resolveLinkCode(L.generateLinkCode()), null);
  for (const bad of ["", "short", "x".repeat(21), "abc$efghijklmnopqrst", null, 42]) assert.equal(await L.resolveLinkCode(bad), null);
  const t0 = Date.now();
  const e = await L.issueLinkCode({ partnerId: motion.id, expiresInDays: 1, by: "admin", now: t0 });
  assert.ok(await L.resolveLinkCode(e.code, t0 + 60_000));
  assert.equal(await L.resolveLinkCode(e.code, t0 + 86_400_000 + 1), null);
  for (const d of [0, -1, 1.5, 731, "x"]) await assert.rejects(L.issueLinkCode({ partnerId: motion.id, expiresInDays: d, by: "admin" }), /Expiry/);
  const ghost = await P.upsertPartner(wallet(), { name: "Ghost" });
  const g = await L.issueLinkCode({ partnerId: ghost.id, by: "admin" });
  await kv1(["DEL", k("partner", ghost.id)]);
  assert.equal(await L.resolveLinkCode(g.code), null);
});

await test("codes (F4): at most 20 live and 100 on record; revoked ones go, so the list stays bounded", async () => {
  const p = await P.upsertPartner(wallet(), { name: "Churn" });
  const made = [];
  for (let i = 0; i < L.MAX_LIVE_CODES; i++) made.push(await L.issueLinkCode({ partnerId: p.id, by: "partner" }));
  await assert.rejects(L.issueLinkCode({ partnerId: p.id, by: "partner" }), /Revoke one first/);
  for (const c of made) await L.revokeLinkCode({ code: c.code, partnerId: p.id });
  for (let i = 0; i < L.MAX_CODES - L.MAX_LIVE_CODES; i++) {
    const c = await L.issueLinkCode({ partnerId: p.id, by: "partner" });
    await L.revokeLinkCode({ code: c.code, partnerId: p.id });
  }
  await assert.rejects(L.issueLinkCode({ partnerId: p.id, by: "partner" }), /100 link codes on record/);
  // revoked records expire; the list drops what is gone, and a new code can be made
  const g = globalThis as { __gloamPartnersMem?: Map<string, { exp: number | null }> };
  for (const c of made) g.__gloamPartnersMem!.delete(k("link", c.code));
  assert.equal((await L.listLinkCodes(p.id)).length, L.MAX_CODES - L.MAX_LIVE_CODES);
  assert.ok(await L.issueLinkCode({ partnerId: p.id, by: "partner" }));
});

// ---------------------------------------------------------------- names (F2)

await test("names (F2): plain names only: no Gloam, no web address, 32 characters and 4 words at most", async () => {
  for (const bad of ["Gloam Support", "gloam", "Gloam refunds gloam-help.xyz", "pay.example.com", "a very long name of five words", "<b>Acme</b>", "x".repeat(33)]) {
    assert.ok(P.partnerNameProblem(bad), bad);
    await assert.rejects(P.upsertPartner(wallet(), { name: bad }), /bad_name|Gloam|plain name|characters/, bad);
  }
  for (const ok of ["Motion", "Acme Pay", "Raeto", "Swap Desk 2"]) assert.equal(P.partnerNameProblem(ok), null, ok);
  // look-alike letters: a Cyrillic "о" in "Glоam", accented letters: plain ASCII only
  for (const bad of ["Gl\u043eam Support", "Caf\u00e9", "\u041c\u043e\u0442\u0438\u043e\u043d"]) assert.match(P.partnerNameProblem(bad) ?? "", /plain letters/, bad);
  // an account can't rename itself to Gloam either
  const owner = wallet();
  await P.upsertPartner(owner, { name: "Renamer" });
  await assert.rejects(P.upsertPartner(owner, { name: "Gloam Treasury" }), /Gloam/);
});

const lookup = (code: string, origin: string | null = `https://${HOST}`, ip = "203.0.113.9") =>
  lookupPost(
    new Request(`https://${HOST}/api/partners/link-code`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": ip, ...(origin ? { origin } : {}) },
      body: JSON.stringify({ code }),
    })
  );

await test("names (F2): the name shows only once an admin approves it, and stays locked through a rename", async () => {
  const owner = wallet();
  const p = await P.upsertPartner(owner, { name: "Robin Pay" });
  const c = (await L.issueLinkCode({ partnerId: p.id, by: "partner" })).code;
  const name = async () => ((await (await lookup(c)).json()) as { data: { name: string | null } }).data.name;
  assert.equal(await name(), null, "not approved: no name, no badge");
  await P.setApprovedName(p.id, true);
  assert.equal(await name(), "Robin Pay");
  await P.upsertPartner(owner, { name: "Robinhood" });
  assert.equal(await name(), "Robin Pay", "a rename keeps showing the approved name");
  const view = P.partnerView((await P.getPartner(p.id))!);
  assert.equal(view.nameAwaitingApproval, true);
  await P.setApprovedName(p.id, true);
  assert.equal(await name(), "Robinhood", "until an admin approves the new one");
  await P.setApprovedName(p.id, false);
  assert.equal(await name(), null);
});

await test("lookup route (F8): a POST from gloam.trade only; no Origin, another site and junk are refused", async () => {
  const c = (await L.issueLinkCode({ partnerId: motion.id, by: "partner" })).code;
  assert.equal((await lookup(c)).status, 200);
  assert.equal((await lookup(c, "https://www.gloam.trade")).status, 200);
  assert.equal((await lookup(c, null)).status, 403, "a missing Origin is refused");
  assert.equal((await lookup(c, "https://evil.example")).status, 403);
  assert.equal((await lookup(c, "http://gloam.trade")).status, 403, "not https");
  assert.equal((await lookup(L.generateLinkCode())).status, 404);
  assert.equal((await lookup("Motion")).status, 400);
});

// ---------------------------------------------------------------- links

await test("links: p= rides in the fragment of pay and swap links; name and ref are never a code", async () => {
  const code = L.generateLinkCode();
  const usdg = requestAssetsFor("robinhood-mainnet").find((a) => a.symbol === "USDG")!;
  const pay = buildPaymentRequestLink({ to: "0x00000000000000000000000000000000000A11c1", network: "robinhood-mainnet", asset: usdg, amount: "25", name: "Motion", partnerCode: code });
  const u = new URL(pay);
  assert.equal(u.searchParams.get("p"), null);
  assert.equal(new URLSearchParams(u.hash.slice(1)).get("p"), code);
  assert.equal(readPaymentRequest(requestParamsFrom(u.search, u.hash), "robinhood-mainnet")!.partnerCode, code);
  assert.equal(readPaymentRequest(new URLSearchParams("to=0x00000000000000000000000000000000000A11c1&p=Motion"), "robinhood-mainnet")!.partnerCode, null);
  const s = swapLinkFromHash(new URL(buildSwapLink({ from: "USDG", to: "GLOAM", amount: "100", network: "robinhood-mainnet", ref: "Motion", partnerCode: code })).hash, "robinhood-mainnet")!;
  assert.equal(s.partnerCode, code);
  assert.equal(swapLinkFromHash("#from=USDG&to=GLOAM&ref=Motion", "robinhood-mainnet")!.partnerCode, null);
});

// ---------------------------------------------------------------- classifier

await test("classifier: real Robinhood Chain receipts read as a cash out, a private payment and a vault swap, with their nullifiers", () => {
  const out = classifyVaultTx(rcpt(FX.cashOuts[0]!).logs, ctxRH);
  assert.ok(out.ok && out.kind === "cash_out");
  if (out.ok && out.kind === "cash_out") {
    assert.equal(out.amount, 2_000_000n);
    assert.equal(out.vaultFee, 5_000n);
    assert.equal(out.to?.toLowerCase(), "0x00000000000000000000000000000000000a11c1");
    assert.equal(out.nullifier, FX.unshieldLogs[0]!.nullifier);
  }
  const pp = classifyVaultTx(rcpt(FX.privatePayment).logs, ctxRH);
  assert.ok(pp.ok && pp.kind === "private_payment" && /^0x[0-9a-f]{64}$/.test(pp.nullifier));
  const sw = classifyVaultTx(rcpt(FX.swap).logs, ctxRH);
  assert.ok(sw.ok && sw.kind === "private_swap" && sw.amount === 2_000_000n && sw.vaultFee === 5_000n);
  assert.ok(kindFitsFlow("cash_out", "pay") && kindFitsFlow("private_payment", "pay") && !kindFitsFlow("private_swap", "pay"));
  assert.ok(kindFitsFlow("private_swap", "swap") && !kindFitsFlow("cash_out", "swap"));
});

await test("classifier: a random transaction, a refund, a stranger's VaultSwap event and packed actions are refused", () => {
  const swapLogs = rcpt(FX.swap).logs;
  const VS = "0x203409a826ec460170d80821c1fd8c52d787fe15820120cb738d54b9b3f9163b";
  assert.deepEqual(classifyVaultTx(rcpt(FX.cashOuts[0]!).logs.slice(0, 1), ctxRH), { ok: false, reason: "not_vault" });
  assert.deepEqual(classifyVaultTx(rcpt(FX.cashOuts[0]!).logs, { ...ctxRH, pool: "0x00000000000000000000000000000000000000aa" }), { ok: false, reason: "not_vault" });
  assert.deepEqual(classifyVaultTx(swapLogs.map((l) => (l.topics[0] === VS ? { ...l, address: "0x00000000000000000000000000000000000000bb" } : l)), ctxRH), { ok: false, reason: "unknown_router" });
  const refund = swapLogs.filter((l) => l.topics[0] !== VS && !(l.address.toLowerCase() === RH.pool!.toLowerCase() && l.topics.length === 4 && l.topics[0]!.startsWith("0xb2fce2f2")));
  assert.deepEqual(classifyVaultTx(refund, ctxRH), { ok: false, reason: "refund" });
  assert.deepEqual(classifyVaultTx([...rcpt(FX.cashOuts[0]!).logs, ...rcpt(FX.privatePayment).logs], ctxRH), { ok: false, reason: "mixed" });
});

// ---------------------------------------------------------------- binding (F1, N1, N2, N5)

const motionCode = (await L.issueLinkCode({ partnerId: motion.id, label: "Fund", by: "partner" })).code;
const malloryCode = (await L.issueLinkCode({ partnerId: mallory.id, by: "partner" })).code;
const offramp = await P.upsertPartner(wallet(), { name: "Offramp" });
const offrampCode = (await L.issueLinkCode({ partnerId: offramp.id, by: "admin" })).code;

await test("F1: nobody can claim a transaction that wasn't bound to their link, before or after it lands", async () => {
  const h = FX.cashOuts[0]!;
  await throwsApi(settle(h, after(h, 1)), 404, "not_registered");
  // registering it after it landed, even with the right value, counts for nothing
  await regApp(malloryCode, h, (rcpt(h).blockTimestamp + 1) * 1000);
  await throwsApi(settle(h, after(h, 5)), 404, "not_registered");
  assert.equal(await P.attributedTo(RH.chainId, h), null);
  assert.equal((await P.readPartnerStats(mallory.id)).totals.cashOuts, 0);
  unregister([h]);
});

await test("N1 fixed: a wallet send counts only with the value only it had; knowing its nullifier ahead is not enough", async () => {
  const h = FX.cashOuts[1]!;
  // Mallory paid out the note and so knew its nullifier; she registered long before, but can't know this cash out's proof
  await regApp(malloryCode, h, before(h, 3600), linkBindHash(`0x${"99".repeat(32)}`));
  await regApp(motionCode, h, before(h));
  const r = await settle(h);
  assert.equal(r.kind, "cash_out");
  assert.equal(r.record.linkCode, motionCode);
  assert.equal(r.record.linkBind, "wallet");
  assert.equal(r.record.vaultFee, "75000");
  await throwsApi(settle(h), 409, "already_attributed");
  // the payee's own private payment (a sweep with no link): Mallory's guess of its new note can't match
  const pp = FX.privatePayment;
  await regApp(malloryCode, pp, before(pp, 3600), linkBindHash(`0x${"98".repeat(32)}`));
  await throwsApi(settle(pp), 404, "not_registered");
  unregister([pp]);
});

await test("N1 fixed: two codes registering the same spend with its value count for nobody, now or later", async () => {
  const h = FX.cashOuts[2]!;
  await regApp(motionCode, h, before(h));
  await regApp(malloryCode, h, before(h, 10));
  await throwsApi(settle(h), 409, "conflicting_codes");
  assert.equal(await P.attributedTo(RH.chainId, h), "conflict");
  await throwsApi(settle(h), 409, "already_attributed");
  unclaim([h]);
  unregister([h]);
});

await test("B3 fixed: a wallet registration must come before its block's second; a late one counts for nothing and poisons nothing", async () => {
  const pp = FX.privatePayment;
  const T = rcpt(pp).blockTimestamp;
  // in the block's own second (a watcher who saw it land): refused
  await regApp(malloryCode, pp, T * 1000 + 400);
  await throwsApi(settle(pp, after(pp, 20)), 404, "not_registered");
  // an honest one before the block, plus that late one under another code: the late one plays no part
  await regApp(motionCode, pp, (T - 1) * 1000 + 900);
  const r = await settle(pp, after(pp, 20));
  assert.equal(r.kind, "private_payment");
  assert.equal(r.record.linkCode, motionCode);
  assert.equal(r.record.linkBind, "wallet");
  // Base reads like Ethereum here: pending blocks are public early, so no wallet registration is taken
  const nh = `0x${"12".repeat(32)}` as Hex;
  for (const chainId of [8453, 84532]) {
    assert.equal((await A.registerLink({ chainId, nullifierHash: nh, bindHash: nh, code: motionCode, flow: "pay" })).reason, "public_mempool");
  }
});

await test("N1, N2b fixed: the relay binds the code to the transaction it sent itself; wallet registrations don't touch it", async () => {
  // a swap, through the relay (the only way a swap goes)
  let waited = 0;
  sentByRelay(FX.swap);
  await A.afterRelaySend({ net: RH, hash: FX.swap, code: motionCode, flow: "swap", at: before(FX.swap, 3), wait: async () => void waited++, deps: after(FX.swap) });
  assert.equal(waited, 1);
  assert.equal(await P.attributedTo(RH.chainId, FX.swap), motion.id);
  assert.equal((await P.countedRecord(RH.chainId, FX.swap))?.record.linkBind, "relay");
  // the payer of a note pre-registered its payee's spend, even with the right value; the payee
  // cashes out through Offramp's link via the relay: the relay's own binding decides
  const h = FX.cashOuts[3]!;
  sentByRelay(h);
  await regApp(malloryCode, h, before(h, 3600));
  await A.afterRelaySend({ net: RH, hash: h, code: offrampCode, flow: "pay", at: before(h, 2), wait: async () => {}, deps: after(h) });
  assert.equal(await P.attributedTo(RH.chainId, h), offramp.id);
  unclaim([h]);
  unregister([h]);
  sentByRelay(h, false);
  // a copy of a pending proof sent to the relay: the relay's binding is on its own transaction, which reverted
  const dup = `0x${"dd".repeat(32)}` as Hex;
  const orig = FX.cashOuts[0]!;
  await A.afterRelaySend({ net: RH, hash: dup, code: malloryCode, flow: "pay", at: before(orig, 3), wait: async () => {
    throw new Error("the relay's copy reverted");
  }, deps: after(orig) });
  assert.equal((await A.relayBindingOf(RH.chainId, dup))?.partnerId, mallory.id, "bound to the relay's own hash only");
  await throwsApi(settle(orig), 404, "not_registered");
  // what the relay route reads, for each action
  assert.equal(A.relayFlowOf({ action: "transfer" }), "pay");
  assert.equal(A.relayFlowOf({ action: "unshield" }), "pay");
  assert.equal(A.relayFlowOf({ action: "swap" }), "swap");
  assert.equal(A.relayFlowOf({ action: "swap", unshieldTx: orig }), null, "a refund is not a swap");
  assert.equal(A.relayFlowOf({ action: "memo" }), null);
  // a junk code: nothing happens, nothing throws
  await A.afterRelaySend({ net: RH, hash: FX.cashOuts[2]!, code: "nope", flow: "pay", at: Date.now(), wait: async () => assert.fail("not waited") });
});

await test("B2 fixed: a transaction the relay sent counts from relay bindings only; a wallet registration never gets in first", async () => {
  const h = FX.cashOuts[3]!;
  sentByRelay(h);
  // Mallory read the proof from the pending calldata and registered it with the right value, in time
  await regApp(malloryCode, h, before(h, 5));
  // a count asked for before the relay's binding exists: nobody gets it, and nothing is claimed
  await throwsApi(settle(h), 404, "not_registered");
  assert.equal(await P.attributedTo(RH.chainId, h), null);
  // the relay binds the code to the payment just before the send goes out: it counts at once
  assert.equal((await bindPay(offrampCode, h, before(h, 3)))?.wrote, true);
  const r = await settle(h);
  assert.equal(r.record.linkCode, offrampCode);
  assert.equal(r.record.linkBind, "relay");
  assert.equal(await A.relayBindingOf(RH.chainId, h), null, "before any binding by the transaction's hash");
  unclaim([h]);
  unregister([h]);
  sentByRelay(h, false);
});

await test("B2: a proof copied from a landed relay transaction and posted to the relay with another code binds nothing that counts", async () => {
  const h = FX.cashOuts[3]!;
  sentByRelay(h);
  const landed = rcpt(h).blockTimestamp * 1000;
  // the relay sent it with no code; Mallory reads its calldata once it lands and posts it to the relay
  // under her code. The relay refuses the spent note before binding anything (selftest-relay); even a
  // binding written after it landed (a node a block behind let the dry run pass) counts for nothing
  for (const at of [landed + 300, landed + 5_000]) {
    assert.equal((await bindPay(malloryCode, h, at))?.wrote, true);
    await throwsApi(settle(h), 404, "not_registered");
    unregister([h]);
  }
  assert.equal(await P.attributedTo(RH.chainId, h), null);
  // a binding made in the second before the block began still counts
  await bindPay(offrampCode, h, landed - 1);
  assert.equal((await settle(h)).record.linkCode, offrampCode);
  unclaim([h]);
  unregister([h]);
  sentByRelay(h, false);
  // on Ethereum and Base no payment binding is kept at all: only the relay's binding by transaction hash
  for (const key of ["ethereum-mainnet", "ethereum", "base-mainnet", "base"] as const) {
    const net = getNetwork(key);
    assert.equal(await bindPay(offrampCode, h, landed - 60_000, unshieldCall(h), net), null);
    assert.ok(![...g().keys()].some((x) => x.startsWith(k("relayspend", net.chainId) + ":")));
  }
});

await test("V1 fixed: a reverted link payment resent through the relay with another code stays with the first link, even with a re-randomized proof", async () => {
  const h = FX.cashOuts[3]!;
  const reverted = `0x${"e1".repeat(32)}` as Hex; // Motion's link send of this payment: the relay sent it, it reverted
  const resend = `0x${"e2".repeat(32)}` as Hex; // the same payment, sent again by the relay for Mallory
  rhChain.get(RH.chainId)!.set(resend, rcpt(h));
  sentByRelay(resend);
  const rerandomized = unshieldCall(h, { proof: `0x${"ab".repeat(128)}` }); // another valid proof of the same payment
  inputs.set(resend, rerandomized);
  assert.equal(A.spendIdOf(RH, { to: RH.pool!, input: rerandomized })?.id, A.spendIdOf(RH, { to: RH.pool!, input: unshieldCall(h) })?.id);
  await bindPay(motionCode, h, before(h, 120));
  await A.bindRelayTx({ chainId: RH.chainId, txHash: reverted, code: motionCode, flow: "pay", at: before(h, 120) });
  // Mallory copies the reverted call and asks the relay to send it again under her code: with the same
  // proof, or a re-randomized one, it is the same payment, and Motion's binding of it stands
  assert.equal((await bindPay(malloryCode, h, before(h, 10)))?.wrote, false);
  const mine = bindPay(malloryCode, h, before(h, 10), rerandomized);
  assert.equal((await mine)?.wrote, false);
  // the relay's after-send step binds the resend's hash to Mallory's code and counts it
  await A.afterRelaySend({ net: RH, hash: resend, code: malloryCode, flow: "pay", at: before(h, 10), bound: mine, wait: async () => {}, deps: after(h) });
  const c = await P.countedRecord(RH.chainId, resend);
  assert.equal(c?.partnerId, motion.id, "the first binding of the payment, not the resend's hash binding");
  assert.equal(c?.record.linkCode, motionCode);
  assert.equal(c?.record.linkBind, "relay");
  unclaim([resend]);
  unregister([h]);
  // with no binding of the payment, the resend's hash binding counts: it went out with Mallory's code
  await A.afterRelaySend({ net: RH, hash: resend, code: malloryCode, flow: "pay", at: before(h, 10), wait: async () => {}, deps: after(h) });
  assert.equal((await P.countedRecord(RH.chainId, resend))?.partnerId, mallory.id);
  unclaim([resend]);
  unregister([h]);
  // a binding of the payment made after the block plays no part: the hash binding counts
  await bindPay(malloryCode, h, rcpt(h).blockTimestamp * 1000 + 300, rerandomized);
  await A.afterRelaySend({ net: RH, hash: resend, code: offrampCode, flow: "pay", at: before(h, 2), wait: async () => {}, deps: after(h) });
  assert.equal((await P.countedRecord(RH.chainId, resend))?.partnerId, offramp.id);
  unclaim([resend]);
  unregister([h, resend, reverted]);
  sentByRelay(resend, false);
  inputs.delete(resend);
  rhChain.get(RH.chainId)!.delete(resend);
});

await test("payment identity: every proof left out; the same payment matches, any other public input does not (transfers, cash outs, both swap routers)", () => {
  const nf = `0x${"5a".repeat(32)}` as Hex;
  const P1 = `0x${"01".repeat(256)}` as Hex;
  const P2 = `0x${"02".repeat(256)}` as Hex;
  const R = `0x${"0e".repeat(32)}` as Hex;
  const id = (to: string, input: Hex) => A.spendIdOf(RH, { to, input })?.id;
  // a private payment
  const tr = (proof: Hex, c1: Hex) => encodeFunctionData({ abi: relayPoolAbi, functionName: "transfer", args: [proof, R, nf, [`0x${"c0".repeat(32)}`, c1]] });
  assert.equal(id(RH.pool!, tr(P1, `0x${"c1".repeat(32)}`)), id(RH.pool!, tr(P2, `0x${"c1".repeat(32)}`)));
  assert.notEqual(id(RH.pool!, tr(P1, `0x${"c1".repeat(32)}`)), id(RH.pool!, tr(P1, `0x${"c2".repeat(32)}`)));
  assert.equal(A.spendIdOf(RH, { to: RH.pool!, input: tr(P1, `0x${"c1".repeat(32)}`) })?.nullifier, nf);
  // swaps, on each router version
  const note = (proof: Hex, c: string) => ({ proof, commitment: `0x${c.repeat(32)}` as Hex, asset: USDG, amount: 5n });
  const sp = (proof: Hex) => ({ proof, root: R, nullifier: nf, asset: USDG, amount: 10n });
  const router = swapRoutersOn(RH.chainId)[0]!.address;
  const v2 = (p: Hex, c: string) => encodeFunctionData({ abi: vaultSwapAbi, functionName: "swap", args: [sp(p), note(p, c), note(p, "f0"), "0x01"] });
  const v3 = (p: Hex, c: string, deadline: bigint) =>
    encodeFunctionData({ abi: vaultSwapV3Abi, functionName: "swap", args: [sp(p), note(p, c), note(p, "f0"), "0x01", "0x000000000000000000000000000000000000e1e1", deadline] });
  assert.ok(id(router, v2(P1, "d0")));
  assert.equal(id(router, v2(P1, "d0")), id(router, v2(P2, "d0")));
  assert.notEqual(id(router, v2(P1, "d0")), id(router, v2(P1, "d1")));
  assert.equal(id(router, v3(P1, "d0", 9n)), id(router, v3(P2, "d0", 9n)));
  assert.notEqual(id(router, v3(P1, "d0", 9n)), id(router, v3(P1, "d0", 10n)));
  assert.notEqual(id(router, v2(P1, "d0")), id(router, v3(P1, "d0", 0n)));
  // another contract, or a call that isn't a spend: no identity
  assert.equal(id(USDG, tr(P1, `0x${"c1".repeat(32)}`)), undefined);
  assert.equal(id(RH.pool!, "0x12345678"), undefined);
});

await test("J1 fixed: a payer's scheduled cash out of its payee's note never takes the payee's own spends of it", async () => {
  const h = FX.cashOuts[3]!;
  sentByRelay(h);
  // the payer picked the note's secret, so it can prove a spend of it: it schedules a cash out far
  // ahead under its own code (Mallory's); the job passed the relay's checks
  await A.bindScheduledJob({ jobId: "job-payer", code: malloryCode, at: before(h, 2 * 86_400) });
  // the payee cashes out first, without a link (its secure sweep, or a plain cash out): nobody's
  await throwsApi(settle(h), 404, "not_registered");
  assert.equal(await P.attributedTo(RH.chainId, h), null);
  // or through Offramp's link: Offramp's
  const b = bindPay(offrampCode, h, before(h, 4));
  await A.afterRelaySend({ net: RH, hash: h, code: offrampCode, flow: "pay", at: before(h, 4), bound: b, wait: async () => {}, deps: after(h) });
  assert.equal((await P.countedRecord(RH.chainId, h))?.partnerId, offramp.id);
  // the payer's job, when its run comes, fails (the note is spent) and sends nothing to bind
  unclaim([h]);
  unregister([h]);
  // the form already on main: a binding of the note under the old per-note key is never read
  const oldKey = k("relaynf", RH.chainId, linkNullifierHash(nullifierOf(h)).toLowerCase());
  await kv1(["HSETNX", oldKey, "job", JSON.stringify({ partnerId: mallory.id, code: malloryCode, flow: "pay", at: before(h, 86_400) })]);
  await kv1(["HSETNX", oldKey, linkBindHash(proofBindValue(proofFor(h))).toLowerCase(), JSON.stringify({ partnerId: mallory.id, code: malloryCode, flow: "pay", at: before(h, 86_400) })]);
  await throwsApi(settle(h), 404, "not_registered");
  g().delete(oldKey);
  sentByRelay(h, false);
});

await test("J1, X1 fixed: a payer's own relay send of its payee's note binds only that payment, even once it reverts and is kept a week", async () => {
  const h = FX.cashOuts[3]!;
  const payerSend = `0x${"a1".repeat(32)}` as Hex;
  const payer = wallet();
  // the payer gets a relay send of a spend of the note through the hook (a cash out to itself, its own
  // proof and root), which passes the dry run and then reverts on chain
  const theirs = unshieldCall(h, { proof: `0x${"aa".repeat(128)}`, to: payer, root: `0x${"07".repeat(32)}` });
  const b = bindPay(malloryCode, h, before(h, 3600), theirs);
  await A.afterRelaySend({ net: RH, hash: payerSend, code: malloryCode, flow: "pay", at: before(h, 3600), bound: b, wait: async () => {
    throw new Error("reverted");
  } });
  const key = (await b)!.key;
  assert.ok(g().get(key)!.exp! - Date.now() > 6 * 86_400_000, "a send that went out keeps its binding a week, reverted or not");
  // later the payee spends the note its own way, through Offramp's link: Offramp's, not the payer's
  sentByRelay(h);
  const ob = bindPay(offrampCode, h, before(h, 4));
  await A.afterRelaySend({ net: RH, hash: h, code: offrampCode, flow: "pay", at: before(h, 4), bound: ob, wait: async () => {}, deps: after(h) });
  assert.equal((await P.countedRecord(RH.chainId, h))?.partnerId, offramp.id);
  unclaim([h]);
  // nor the same spend of its own sent with no code (no binding of it, no hash binding)
  g().delete(k("relaytx", RH.chainId, h));
  g().delete((await ob)!.key);
  await throwsApi(settle(h), 404, "not_registered");
  // the reverted payment itself, sent again unchanged, is still the payer's: the first code tied to that payment
  const again = `0x${"a2".repeat(32)}` as Hex;
  rhChain.get(RH.chainId)!.set(again, rcpt(h));
  inputs.set(again, theirs);
  sentByRelay(again);
  assert.equal((await settle(again, after(h))).record.linkCode, malloryCode);
  unclaim([again]);
  unregister([h, payerSend, again]);
  sentByRelay(h, false);
  sentByRelay(again, false);
  inputs.delete(again);
  rhChain.get(RH.chainId)!.delete(again);
});

await test("V3 fixed: a payment binding made just before a send lasts an hour, a send that surely didn't go out takes it back, one that went out keeps it a week", async () => {
  const h = FX.cashOuts[3]!;
  assert.equal(A.RELAY_PENDING_TTL_SEC, 3600);
  const b = bindPay(offrampCode, h, Date.now());
  const bound = (await b)!;
  const ttlSec = (key: string) => Math.round((g().get(key)!.exp! - Date.now()) / 1000);
  assert.ok(ttlSec(bound.key) <= 3600 && ttlSec(bound.key) > 3590, `pending: ${ttlSec(bound.key)} s`);
  assert.ok(ttlSec(bound.seen) <= 3600);
  // the send went out: the hash binding is written, and the payment binding is kept as long
  await A.afterRelaySend({ net: RH, hash: h, code: offrampCode, flow: "pay", at: Date.now(), bound: b, wait: async () => {
    throw new Error("not landed yet");
  } });
  assert.ok(ttlSec(bound.key) > 7 * 86_400 - 10, `after the send: ${ttlSec(bound.key)} s`);
  assert.ok(ttlSec(bound.seen) > 7 * 86_400 - 10);
  unregister([h]);
  // the relay was busy, its lock store down or the node refused: the binding is taken back
  const gone = (await bindPay(offrampCode, h, Date.now()))!;
  await A.unbindRelaySpend(gone);
  assert.equal(g().has(gone.key), false);
  // but only a binding this request wrote: an earlier one of the same payment stays
  const first = (await bindPay(motionCode, h, Date.now()))!;
  const second = (await bindPay(offrampCode, h, Date.now()))!;
  assert.equal(second.wrote, false);
  await A.unbindRelaySpend(second);
  assert.equal(g().has(first.key), true);
  unregister([h]);
  // a scheduled job keeps only its code with the job: no binding of any payment
  await A.bindScheduledJob({ jobId: "job-ttl", code: offrampCode, at: Date.now() });
  assert.ok(![...g().keys()].some((x) => x.startsWith(k("relayspend", RH.chainId) + ":")));
  assert.ok(g().get(k("jobcode", "job-ttl"))!.exp! - Date.now() > 99 * 86_400_000);
});

await test("F1, B2, J1 fixed: a cash out scheduled for later counts to its job's code only for the transaction the run sends for that job", async () => {
  const h = FX.cashOuts[2]!;
  sentByRelay(h);
  await A.bindScheduledJob({ jobId: "job-1", code: motionCode, at: before(h, 6 * 3600) });
  // Mallory copies the proof from the run's pending calldata and registers it; she settles first: nothing
  await regApp(malloryCode, h, before(h, 1));
  await throwsApi(settle(h, after(h, 26 * 3600)), 404, "not_registered");
  assert.equal(await P.attributedTo(RH.chainId, h), null);
  // the run binds the job's code to the transaction it sent and counts it
  await A.afterScheduledSend({ net: RH, jobId: "job-1", hash: h, deps: after(h, 26 * 3600) });
  const c = await P.countedRecord(RH.chainId, h);
  assert.equal(c?.partnerId, motion.id);
  assert.equal(c?.record.linkBind, "relay");
  assert.equal(c?.record.ts, rcpt(h).blockTimestamp * 1000, "counted on the day it landed");
  unregister([h]);
  sentByRelay(h, false);
  await A.afterScheduledSend({ net: RH, jobId: "job-none", hash: FX.cashOuts[0]!, deps: after(FX.cashOuts[0]!) });
  assert.equal(await P.attributedTo(RH.chainId, FX.cashOuts[0]!), null, "a job with no code binds nothing");
});

await test("binding: flows fit; other chains, random, failed and too-old transactions count for nothing; Ethereum and swaps take no wallet registration", async () => {
  const h = FX.cashOuts[3]!;
  sentByRelay(h);
  await A.bindRelayTx({ chainId: RH.chainId, txHash: h, code: motionCode, flow: "swap", at: before(h) });
  await throwsApi(settle(h), 422, "wrong_flow");
  unregister([h]);
  sentByRelay(h, false);
  await regApp(motionCode, h, before(h));
  await throwsApi(A.settleLinkTx({ chainId: TEMPO.chainId, txHash: h }, fakeChain(new Map([[TEMPO.chainId, new Map()]]), rcpt(h).blockTimestamp + 60)), 404, "tx_not_found");
  await throwsApi(A.settleLinkTx({ chainId: 999_999, txHash: h }, after(h)), 400, "bad_chain");
  const random = `0x${"ab".repeat(32)}` as Hex;
  const withRandom: Chain = new Map([[RH.chainId, new Map([...rhChain.get(RH.chainId)!, [random, { ...rcpt(h), logs: rcpt(h).logs.slice(0, 1) }]])]]);
  await throwsApi(settle(random, fakeChain(withRandom, rcpt(h).blockTimestamp + 60)), 422, "not_vault_action");
  const failed: Chain = new Map([[RH.chainId, new Map([[h.toLowerCase(), { ...rcpt(h), status: "reverted" as never }]])]]);
  await throwsApi(settle(h, fakeChain(failed, rcpt(h).blockTimestamp + 60)), 422, "tx_failed");
  await throwsApi(settle(h, after(h, A.ATTRIBUTION_WINDOW_SEC + 1)), 422, "too_old");
  // a cash out sent through some other contract (not straight to the vault): its proof can't be read, so no wallet registration matches
  const wrapped: import("../src/lib/partnerAttribution").AttributionDeps = { ...after(h), tx: async () => ({ from: PAYER, to: "0x00000000000000000000000000000000000000cc", input: inputs.get(h.toLowerCase())! }) };
  await throwsApi(settle(h, wrapped), 404, "not_registered");
  unregister([h]);
  const nh = `0x${"11".repeat(32)}` as Hex;
  assert.deepEqual(await A.registerLink({ chainId: 1, nullifierHash: nh, bindHash: nh, code: motionCode, flow: "pay" }), { registered: false, reason: "public_mempool" });
  assert.deepEqual(await A.registerLink({ chainId: RH.chainId, nullifierHash: nh, bindHash: nh, code: motionCode, flow: "swap" }), { registered: false, reason: "relay_only" });
  const gone = await L.issueLinkCode({ partnerId: motion.id, by: "partner" });
  await L.revokeLinkCode({ code: gone.code, partnerId: motion.id });
  assert.deepEqual(await A.registerLink({ chainId: RH.chainId, nullifierHash: nh, bindHash: nh, code: gone.code, flow: "pay" }), { registered: false, reason: "code_not_live" });
});

// ---------------------------------------------------------------- routes (F1, F5)

const routeReq = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`https://${HOST}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: `https://${HOST}`, "x-forwarded-for": "203.0.113.77", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

await test("routes: register and attribute need the gloam.trade Origin; a missing one is refused", async () => {
  const reg = { chainId: RH.chainId, nullifierHash: `0x${"22".repeat(32)}`, bindHash: `0x${"23".repeat(32)}`, code: motionCode, flow: "pay" };
  const noOrigin = new Request(`https://${HOST}/api/partners/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(reg) });
  assert.equal((await registerPost(noOrigin as never)).status, 403);
  assert.equal((await registerPost(routeReq("/api/partners/register", reg, { origin: "https://evil.example" }) as never)).status, 403);
  assert.equal((await registerPost(routeReq("/api/partners/register", reg) as never)).status, 201);
  assert.equal((await registerPost(routeReq("/api/partners/register", { ...reg, wallet: "0x1" }) as never)).status, 400, "extra fields refused");
  assert.equal((await registerPost(routeReq("/api/partners/register", { ...reg, code: L.generateLinkCode() }) as never)).status, 404);
  assert.equal((await registerPost(routeReq("/api/partners/register", { ...reg, chainId: 1 }) as never)).status, 422, "Ethereum: relay only");
  const { bindHash: _b, ...noBind } = reg;
  assert.equal((await registerPost(routeReq("/api/partners/register", noBind) as never)).status, 400, "a registration must bind to a value");
  const settleNoOrigin = new Request(`https://${HOST}/api/partners/attribute`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chainId: 4663, txHash: FX.cashOuts[0] }) });
  assert.equal((await attributePost(settleNoOrigin as never)).status, 403);
  assert.equal((await attributePost(routeReq("/api/partners/attribute", { chainId: 4663, txHash: FX.cashOuts[0], code: motionCode }) as never)).status, 400, "the partner never comes from the request");
  // already counted: answered from the store, no chain read
  const dup = await attributePost(routeReq("/api/partners/attribute", { chainId: 4663, txHash: FX.cashOuts[1] }) as never);
  assert.equal(dup.status, 409);
});

await test("routes (F5): one IP spending a code's registrations doesn't block that code for anyone else", async () => {
  const c = (await L.issueLinkCode({ partnerId: motion.id, by: "partner" })).code;
  const send = (ip: string, n: number) =>
    registerPost(
      routeReq("/api/partners/register", { chainId: RH.chainId, nullifierHash: `0x${n.toString(16).padStart(64, "0")}`, bindHash: `0x${"24".repeat(32)}`, code: c, flow: "pay" }, { "x-forwarded-for": ip }) as never
    );
  let limited = 0;
  for (let i = 0; i < 25; i++) if ((await send("198.51.100.1", 1000 + i)).status === 429) limited++;
  assert.ok(limited > 0, "one IP is held to its share");
  assert.equal((await send("198.51.100.2", 5000)).status, 201, "another IP still registers for the same code");
});

await test("N4 fixed: a registration lasts an hour, and one IP (or /64) gets a small allowance", async () => {
  const nh = `0x${"31".repeat(32)}` as Hex;
  await A.registerLink({ chainId: RH.chainId, nullifierHash: nh, bindHash: nh, code: motionCode, flow: "pay" });
  const g = globalThis as { __gloamPartnersMem?: Map<string, { exp: number | null }> };
  const ttl = (g.__gloamPartnersMem!.get(k("reg", RH.chainId, nh))!.exp! - Date.now()) / 1000;
  assert.ok(ttl <= 3600 && ttl > 3500, `kept about an hour (${ttl.toFixed(0)} s)`);
  let ok = 0;
  for (let i = 0; i < 30; i++) {
    const res = await registerPost(
      routeReq("/api/partners/register", { chainId: RH.chainId, nullifierHash: `0x${(7000 + i).toString(16).padStart(64, "0")}`, bindHash: nh, code: [motionCode, malloryCode, offrampCode][i % 3], flow: "pay" }, { "x-forwarded-for": "2001:db8:1:2:aaaa::1" }) as never
    );
    if (res.status === 201) ok++;
  }
  assert.equal(ok, 10, "10 a minute per IP, whatever the code");
  const sameNet = await registerPost(
    routeReq("/api/partners/register", { chainId: RH.chainId, nullifierHash: `0x${"32".repeat(32)}`, bindHash: nh, code: motionCode, flow: "pay" }, { "x-forwarded-for": "2001:db8:1:2:bbbb::9" }) as never
  );
  assert.equal(sameNet.status, 429, "another address in the same /64 shares it");
});

// ---------------------------------------------------------------- privacy (F3)

function storeText(): string {
  const g = globalThis as { __gloamPartnersMem?: Map<string, { v: unknown }> };
  const parts: string[] = [];
  for (const [key, e] of g.__gloamPartnersMem ?? new Map()) {
    parts.push(key);
    const v = e.v;
    if (typeof v === "string") parts.push(v);
    else if (v instanceof Map) for (const [a, b] of v) parts.push(a, b);
    else if (v instanceof Set) parts.push(...v);
    else if (Array.isArray(v)) parts.push(...v);
  }
  return parts.join("\n").toLowerCase();
}

await test("privacy: no payer wallet, cash-out recipient, IP or nullifier anywhere in the partner store", async () => {
  const text = storeText();
  for (const fake of ["0x00000000000000000000000000000000000a11c1", "0x00000000000000000000000000000000000a11c2", "a11c3"]) assert.ok(!text.includes(fake), fake);
  for (const ip of ["203.0.113.77", "198.51.100.1", "203.0.113.9"]) assert.ok(!text.includes(ip), ip);
  for (const h of [...FX.cashOuts, FX.privatePayment]) assert.ok(!text.includes(nullifierOf(h).slice(2)), "only a hash of a spend is kept");
  assert.ok(!text.includes(FX.unshieldLogs.find((l) => l.txHash === FX.swap)!.to.toLowerCase()), "nor a swap's escrow");
});

const HOSTH = { "x-forwarded-host": HOST };
const sessionCookie = (owner: Address) => `${SESSION_COOKIE}=${encodeURIComponent(createSession(owner, HOST)!)}`;

await test("privacy (F3): a partner never sees a private payment's hash or code; cash outs and swaps stay listed", async () => {
  const res = await statsGet(new Request(`https://${HOST}/api/partners/stats`, { headers: { ...HOSTH, cookie: sessionCookie(motionOwner) } }) as never);
  const body = await res.text();
  const j = JSON.parse(body) as { data: { totals: { privatePayments: number }; recent: { kind: string; txHash: string }[] } };
  assert.equal(j.data.totals.privatePayments, 1, "counted");
  assert.ok(!j.data.recent.some((r) => r.kind === "private_payment"), "never listed one by one");
  assert.ok(!body.toLowerCase().includes(FX.privatePayment.toLowerCase()), "its hash is nowhere in the answer");
  assert.ok(j.data.recent.some((r) => r.kind === "cash_out"));
  const csv = await (await exportGet(new Request(`https://${HOST}/api/partners/export?type=transactions`, { headers: { ...HOSTH, cookie: sessionCookie(motionOwner) } }) as never)).text();
  assert.ok(!csv.toLowerCase().includes(FX.privatePayment.toLowerCase()));
  assert.ok(!/Private payment/.test(csv));
  const daily = await (await exportGet(new Request(`https://${HOST}/api/partners/export?type=daily`, { headers: { ...HOSTH, cookie: sessionCookie(motionOwner) } }) as never)).text();
  assert.ok(/Private payment,1,Hidden/.test(daily), "a daily count only");
});

await test("N3 fixed: a private payment never moves lastActivity, and a partner sees today's only once the day has ended", async () => {
  const owner = wallet();
  const p = await P.upsertPartner(owner, { name: "Invoicer" });
  const T = (n: number) => `0x${(n + 4400).toString(16).padStart(64, "0")}` as Hex;
  const landed = Date.now() - 5_000;
  await P.recordActivity({ partner: p, keyId: null, source: "link", linkBind: "wallet", network: RH, kind: "private_payment", txHash: T(1), now: landed });
  const view = async () => {
    const res = await statsGet(new Request(`https://${HOST}/api/partners/stats`, { headers: { ...HOSTH, cookie: sessionCookie(owner) } }) as never);
    const text = await res.text();
    return { text, d: (JSON.parse(text) as { data: { lastActivity: number | null; totals: { privatePayments: number; commissionUsd: number }; daily: { day: string; privatePayments: number }[] } }).data };
  };
  const first = await view();
  const text = first.text;
  let d = first.d;
  assert.equal(d.lastActivity, null, "no time to look for on chain");
  assert.equal(d.totals.privatePayments, 0, "today's is not counted yet");
  assert.equal(d.daily.at(-1)!.privatePayments, 0);
  assert.ok(!text.includes(String(landed)) && !text.includes(String(Math.floor(landed / 1000))));
  // Gloam's own view counts it at once
  assert.equal((await P.readPartnerStats(p.id)).totals.privatePayments, 1);
  // one on a day that has ended counts for the partner too
  await P.recordActivity({ partner: p, keyId: null, source: "link", linkBind: "wallet", network: RH, kind: "private_payment", txHash: T(2), now: Date.now() - 2 * 86_400_000 });
  ({ d } = await view());
  assert.equal(d.totals.privatePayments, 1);
  assert.equal(d.lastActivity, null);
  // B1: the partner's daily CSV doesn't show today's either
  const daily = await (await exportGet(new Request(`https://${HOST}/api/partners/export?type=daily`, { headers: { ...HOSTH, cookie: sessionCookie(owner) } }) as never)).text();
  const today = P.utcDay(Date.now());
  assert.ok(!daily.split("\r\n").some((l) => l.startsWith(today) && /Private payment/.test(l)), "no row for today's private payment");
  assert.ok(daily.split("\r\n").some((l) => /Private payment,1,Hidden/.test(l)), "the ended day's is there");
  // a cash out, public on chain, does move it
  await P.recordActivity({ partner: p, keyId: null, source: "link", linkBind: "relay", network: RH, kind: "cash_out", txHash: T(3), edge: { asset: USDG, amount: 1_000_000n }, vaultFee: 2_500n });
  ({ d } = await view());
  assert.ok(d.lastActivity && d.lastActivity > landed - 60_000);
});

await test("privacy: a cash out to a partner's proven address goes to that partner, whichever link it came from", async () => {
  const owner = privateKeyToAccount(generatePrivateKey());
  const shop = await P.upsertPartner(owner.address, { name: "Shop" });
  // the shop proves its receiving address (a fresh key standing in for it)
  const recv = privateKeyToAccount(generatePrivateKey());
  await AD.setPartnerAddresses(shop.id, [{ chainId: RH.chainId, address: recv.address }], "add");
  const list = await AD.getPartnerAddresses(shop.id);
  const msg = list[String(RH.chainId)]![recv.address.toLowerCase()]!.message;
  await AD.verifyPartnerAddresses(shop.id, [{ chainId: RH.chainId, address: recv.address, signature: await recv.signMessage({ message: msg }) }], async (_n, a, m, s) => verifyMessage({ address: a, message: m, signature: s }));
  // a cash out from Mallory's link that pays the shop's address (the fixture's recipient, swapped for the shop's)
  const h = FX.cashOuts[3]!;
  const word = (a: string) => `0x${a.toLowerCase().slice(2).padStart(64, "0")}`;
  const paysShop: Rcpt = { ...rcpt(h), logs: rcpt(h).logs.map((l) => ({ ...l, topics: l.topics.map((t) => (t === word("0x00000000000000000000000000000000000a11c2") ? word(recv.address) : t)) })) };
  const chain: Chain = new Map([[RH.chainId, new Map([[h.toLowerCase(), paysShop]])]]);
  await regApp(malloryCode, h, before(h));
  const r = await A.settleLinkTx({ chainId: RH.chainId, txHash: h }, fakeChain(chain, rcpt(h).blockTimestamp + 60));
  assert.equal(r.record.source, "chain");
  assert.equal(await P.attributedTo(RH.chainId, h), shop.id);
  unclaim([h]);
  unregister([h]);
  await AD.setPartnerAddresses(shop.id, [], "replace");
});

// ---------------------------------------------------------------- tiers (F6)

await test("F6 fixed: testnet is counted apart and never valued; the daily CSV names each network", async () => {
  const p = await P.upsertPartner(wallet(), { name: "Wash" });
  const usd = requestAssetsFor("robinhood").find((a) => a.stable)!;
  const t = await P.recordActivity({ partner: p, keyId: null, source: "link", network: RH_TEST, kind: "cash_out", txHash: `0x${"cd".repeat(32)}`, edge: { asset: usd.address, amount: 1_000_000n * 10n ** BigInt(usd.decimals) }, vaultFee: 2_500n * 10n ** BigInt(usd.decimals) });
  assert.ok(t.recorded && t.record.volumeUsd === null && t.record.vaultFeeUsd === null);
  const main = await P.readPartnerStats(p.id, { days: 2 });
  assert.equal(main.totals.cashOuts, 0);
  assert.equal(main.totals.publicVolumeUsd, 0);
  const test = await P.readPartnerStats(p.id, { days: 2, tier: "testnet" });
  assert.equal(test.totals.cashOuts, 1);
  assert.equal(test.totals.publicVolumeUsd, 0);
  assert.equal(test.totals.vaultFeeUsd, 0);
  assert.equal(test.totals.unpriced, 1);
  const csv = P.dailyCsv([{ id: p.id, name: p.name, daily: test.daily }]).trim().split("\r\n");
  assert.equal(csv[0], "Date (UTC),Network,Partner id,Partner,Source,Kind,Count,Volume (USD),Vault fee (USD)");
  assert.ok(csv[1]!.includes(",Robinhood Chain testnet,") && csv[1]!.endsWith(",Not priced,Not priced"), csv[1]);
  assert.equal(P.dailyCsv([{ id: p.id, name: p.name, daily: main.daily }]).trim().split("\r\n").length, 1, "no testnet row in the mainnet file");
});

// ---------------------------------------------------------------- analytics

await test("analytics: totals by source, kind, asset and day, with the vault's fee", async () => {
  const p = await P.upsertPartner(wallet(), { name: "Sums" });
  const T = (n: number) => `0x${(n + 9000).toString(16).padStart(64, "0")}` as Hex;
  const day = Date.UTC(2026, 9, 30, 12);
  await P.recordActivity({ partner: p, keyId: "key_1", network: RH, kind: "cash_out", txHash: T(1), edge: { asset: USDG, amount: 100_000_000n }, vaultFee: 250_000n });
  await P.recordActivity({ partner: p, keyId: "key_1", network: RH, kind: "private_payment", txHash: T(2) });
  await P.recordActivity({ partner: p, keyId: "key_1", network: RH, kind: "private_swap", txHash: T(3), edge: { asset: USDG, amount: 40_000_000n }, vaultFee: 100_000n });
  await P.recordActivity({ partner: p, keyId: null, source: "link", linkCode: motionCode, network: RH, kind: "cash_out", txHash: T(4), edge: { asset: USDG, amount: 20_000_000n }, vaultFee: 50_000n });
  await P.recordActivity({ partner: p, keyId: "ignored", source: "link", network: RH, kind: "private_payment", txHash: T(5) });
  await P.recordActivity({ partner: p, keyId: null, source: "chain", network: RH, kind: "cash_out", txHash: T(6), edge: { asset: USDG, amount: 30_000_000n }, vaultFee: 75_000n, now: day });
  await P.recordActivity({ partner: p, keyId: "key_1", network: RH, kind: "deposit", txHash: T(7), edge: { asset: USDG, amount: 10_000_000n }, vaultFee: 999n });
  const s = await P.readPartnerStats(p.id, { recent: 20, days: 30 });
  assert.equal(s.totals.cashOuts, 3);
  assert.equal(s.totals.privatePayments, 2);
  assert.equal(s.totals.publicVolumeUsd, 160);
  assert.equal(s.totals.swapVolumeUsd, 40);
  assert.ok(Math.abs(s.totals.vaultFeeUsd - 0.475) < 1e-9);
  assert.deepEqual(s.bySource.api.counts, { private_payment: 1, cash_out: 1, deposit: 1, private_swap: 1 });
  assert.deepEqual(s.bySource.link.counts, { private_payment: 1, cash_out: 1, deposit: 0, private_swap: 0 });
  assert.deepEqual(s.bySource.chain.counts, { private_payment: 0, cash_out: 1, deposit: 0, private_swap: 0 });
  assert.equal(s.bySource.api.volumeUsd, 150);
  assert.ok(Math.abs(s.bySource.link.vaultFeeUsd - 0.05) < 1e-9);
  const usdg = s.byAsset.find((a) => a.symbol === "USDG")!;
  assert.deepEqual([usdg.volume, usdg.swapVolume, usdg.vaultFee], ["160", "40", "0.475"]);
  const back = s.daily.find((d) => d.day === "2026-10-30");
  if (back) assert.equal(back.bySource.chain.counts.cash_out, 1, "a past match is counted on its own day");
  assert.ok(s.lastActivity! > day, "a past match never moves last back");
  assert.ok(s.recent.every((r, i) => i === 0 || s.recent[i - 1]!.ts >= r.ts));
  const rows = s.daily.find((d) => d.day === P.utcDay(Date.now()))!.rows;
  assert.ok(rows.some((r) => r.network === "robinhood-mainnet" && r.source === "link" && r.kind === "cash_out" && r.count === 1 && r.volumeUsd === 20));
});

await test("analytics: a claim is taken back exactly, and older activity is replayed into the new counters once", async () => {
  const p = await P.upsertPartner(wallet(), { name: "Undo" });
  const h = `0x${"ef".repeat(32)}` as Hex;
  const before0 = await kv1(["HGETALL", k("stats2", p.id)]);
  await P.recordActivity({ partner: p, keyId: null, source: "link", linkCode: motionCode, network: RH, kind: "cash_out", txHash: h, edge: { asset: USDG, amount: 7_000_000n }, vaultFee: 17_500n });
  const back = await P.reverseActivity(RH.chainId, h);
  assert.equal(back?.partnerId, p.id);
  const s = await P.readPartnerStats(p.id, { recent: 5 });
  assert.equal(s.totals.cashOuts, 0);
  assert.equal(s.totals.publicVolumeUsd, 0);
  assert.equal(s.recent.length, 0);
  assert.equal(await P.attributedTo(RH.chainId, h), null, "the claim is free again");
  assert.deepEqual(before0, []);

  // an account counted the old way: its list of records (no v) and v1 counters
  const old = await P.upsertPartner(wallet(), { name: "Legacy" });
  const rec = (n: number, network: string, kind: string, amount: string | null) =>
    JSON.stringify({ id: `act_${n}`, kind, network, chainId: getNetwork(network as never).chainId, txHash: `0x${n.toString(16).padStart(64, "0")}`, ts: Date.now() - n * 1000, keyId: "k", asset: amount ? USDG : null, symbol: amount ? "USDG" : null, decimals: amount ? 6 : null, amount, volumeUsd: amount ? Number(amount) / 1e6 : null, feeUsd: 0, feeToken: amount ? "0" : null, feeBasis: "" });
  await kv1(["LPUSH", k("events", old.id), rec(1, "robinhood-mainnet", "cash_out", "5000000"), rec(2, "robinhood", "cash_out", "9000000"), rec(3, "tempo-mainnet", "private_payment", null)]);
  await kv1(["HSET", k("stats", old.id), "n:cash_out", "3", "n:private_payment", "1"]);
  const m = await P.readPartnerStats(old.id);
  assert.equal(m.totals.cashOuts, 1);
  assert.equal(m.totals.privatePayments, 1);
  assert.equal(m.totals.publicVolumeUsd, 5);
  assert.equal(m.bySource.api.counts.cash_out, 1, "older activity came in with a key");
  assert.equal((await P.readPartnerStats(old.id, { tier: "testnet" })).totals.cashOuts, 1);
  assert.equal(await P.migrationNote(old.id), "partial:1", "one older cash out fell out of the list");
  assert.equal((await P.readPartnerStats(old.id)).totals.cashOuts, 1, "replayed once only");
});

await test("CSV: one row per transaction, formula cells defused", async () => {
  const p = await P.upsertPartner(wallet(), { name: "Sheet" });
  await P.recordActivity({ partner: p, keyId: null, source: "link", network: RH, kind: "cash_out", txHash: `0x${"a1".repeat(32)}`, edge: { asset: USDG, amount: 12_500_000n }, vaultFee: 31_250n });
  const s = await P.readPartnerStats(p.id, { recent: 10, days: 1 });
  const tx = P.activityCsv([{ id: p.id, name: "=HYPERLINK(1)", recent: s.recent }]).trim().split("\r\n");
  assert.equal(tx[0], "Time (UTC),Partner id,Partner,Source,Network,Chain id,Kind,Transaction,Token,Token address,Amount,Volume (USD),Vault fee,Vault fee (USD),Link bound by");
  const out = tx[1]!.split(",");
  assert.equal(out[2], "'=HYPERLINK(1)");
  assert.deepEqual([out[3], out[4], out[8], out[10], out[12]], ["Via link", "Robinhood Chain", "USDG", "12.5", "0.03125"]);
  assert.equal(P.csvCell('a"b,c'), '"a""b,c"');
});

// ---------------------------------------------------------------- receiving addresses (F7)

await test("addresses: pasted lines and CSVs with optional signatures; testnets refused", () => {
  const sig = `0x${"ab".repeat(65)}`;
  const r = AD.parseAddressList(
    ["chain,address", "robinhood-mainnet,0x00000000000000000000000000000000000A11c2", `Tempo; 0x00000000000000000000000000000000000a11c9, ${sig}`, "robinhood,0x00000000000000000000000000000000000a11cc", "0x52908400098527886e0F7030069857D2E4169ee7", "not an address"].join("\n"),
    4663
  );
  assert.deepEqual(
    r.entries.map((e) => `${e.chainId}:${e.address}:${e.signature ? "sig" : ""}`),
    ["4663:0x00000000000000000000000000000000000a11c2:", "4217:0x00000000000000000000000000000000000a11c9:sig"]
  );
  assert.ok(r.rejected.some((x) => /not a mainnet/.test(x.reason)));
  assert.ok(r.rejected.some((x) => /checksum/.test(x.reason)));
});

await test("F7 fixed: an address counts only once it signs its message; nobody else can take it", async () => {
  const shop = await P.upsertPartner(wallet(), { name: "Proven" });
  const rival = await P.upsertPartner(wallet(), { name: "Rival" });
  const recv = privateKeyToAccount(generatePrivateKey());
  const check: import("../src/lib/partnerAddresses").SignatureCheck = async (_n, a, m, s) => verifyMessage({ address: a, message: m, signature: s });
  await AD.setPartnerAddresses(shop.id, [{ chainId: RH.chainId, address: recv.address }], "add");
  await AD.setPartnerAddresses(rival.id, [{ chainId: RH.chainId, address: recv.address }], "add");
  assert.equal((await AD.addressBook()).get(RH.chainId)?.get(recv.address.toLowerCase()), undefined, "waiting: matches nothing");
  const msg = (await AD.getPartnerAddresses(shop.id))[String(RH.chainId)]![recv.address.toLowerCase()]!.message;
  assert.match(msg, /Partner: Proven \(ptr_/);
  assert.match(msg, /Chain: Robinhood Chain \(4663\)/);
  assert.match(msg, new RegExp(`Date: ${P.utcDay(Date.now())}`));
  // a signature from another key, or of another message, is refused
  const stranger = privateKeyToAccount(generatePrivateKey());
  const bad = await AD.verifyPartnerAddresses(shop.id, [{ chainId: RH.chainId, address: recv.address, signature: await stranger.signMessage({ message: msg }) }], check);
  assert.equal(bad.results[0]!.ok, false);
  const wrongMsg = await AD.verifyPartnerAddresses(shop.id, [{ chainId: RH.chainId, address: recv.address, signature: await recv.signMessage({ message: "something else" }) }], check);
  assert.equal(wrongMsg.results[0]!.ok, false);
  const good = await AD.verifyPartnerAddresses(shop.id, [{ chainId: RH.chainId, address: recv.address, signature: await recv.signMessage({ message: msg }) }], check);
  assert.equal(good.results[0]!.ok, true);
  assert.equal((await AD.addressBook()).get(RH.chainId)?.get(recv.address.toLowerCase()), shop.id);
  // the rival, even with a valid signature of its own message, can't take a proven address
  const rivalMsg = (await AD.getPartnerAddresses(rival.id))[String(RH.chainId)]![recv.address.toLowerCase()]!.message;
  const taken = await AD.verifyPartnerAddresses(rival.id, [{ chainId: RH.chainId, address: recv.address, signature: await recv.signMessage({ message: rivalMsg }) }], check);
  assert.match(taken.results[0]!.reason ?? "", /Another partner already proved/);
  // dropped from the list: stops counting at once
  await AD.setPartnerAddresses(shop.id, [], "replace");
  assert.equal(await AD.addressOwner(RH.chainId, recv.address), null);
  await AD.setPartnerAddresses(rival.id, [], "replace");
});

// ---------------------------------------------------------------- the on-chain match

await test("match: deploy blocks are the ones in contracts/deployments", () => {
  const root = new URL("../../contracts/deployments/", import.meta.url);
  const main = JSON.parse(readFileSync(new URL("mainnet.json", root), "utf8")) as { chains: Record<string, { deployBlock: number }> };
  const base = JSON.parse(readFileSync(new URL("base-mainnet.json", root), "utf8")) as { contracts: { deployBlock: number } };
  const eth = JSON.parse(readFileSync(new URL("ethereum-mainnet.json", root), "utf8")) as { contracts: { deployBlock: number } };
  // Elysium is in addressChains only while NEXT_PUBLIC_ELYSIUM_ENABLED is on (as production builds it)
  const ely = JSON.parse(readFileSync(new URL("elysium-mainnet.json", root), "utf8")) as { chainId: number; contracts: { deployBlock: number } };
  const want: Record<number, number> = { 4663: main.chains["4663"]!.deployBlock, 4217: main.chains["4217"]!.deployBlock, 8453: base.contracts.deployBlock, 1: eth.contracts.deployBlock, [ely.chainId]: ely.contracts.deployBlock };
  for (const n of AD.addressChains()) assert.equal(n.deployBlock, BigInt(want[n.chainId]!), n.label);
  assert.equal(B.spanFor(RH), 5_000_000n);
});

function fakeBackfill(opts: { head?: bigint; clock?: { t: number; step: number }; receipt?: (h: Hex) => Rcpt | null | undefined } = {}) {
  const cursors = new Map<number, bigint>();
  const queries: { chainId: number; from: bigint; to: bigint }[] = [];
  const clock = opts.clock ?? { t: 1_000_000, step: 0 };
  const live = fakeChain(rhChain, Math.max(...Object.values(FX.receipts).map((r) => r.blockTimestamp)) + 600);
  const deps: import("../src/lib/partnerBackfill").BackfillDeps = {
    ...B.backfillDeps,
    head: async (net) => (net.chainId === RH.chainId ? (opts.head ?? 105_000_000n) : net.deployBlock! + 10n),
    unshielded: async (net, from, to) => {
      queries.push({ chainId: net.chainId, from, to });
      if (net.chainId !== RH.chainId) return [];
      return FX.unshieldLogs
        .filter((l) => BigInt(l.blockNumber) >= from && BigInt(l.blockNumber) <= to)
        .map((l) => ({ ...l, blockNumber: BigInt(l.blockNumber), amount: BigInt(l.amount) }));
    },
    receipt: async (net, h) => {
      if (opts.receipt) {
        const r = opts.receipt(h);
        if (r === null) return null;
      }
      return live.receipt(net, h);
    },
    blockTime: (net, b) => live.blockTime(net, b),
    settle: async (net, h) => void (await A.settleLinkTx({ chainId: net.chainId, txHash: h }, live)),
    readCursor: async (c) => cursors.get(c) ?? null,
    writeCursor: async (c, b) => void cursors.set(c, b),
    now: () => (clock.t += clock.step),
  };
  return { deps, cursors, queries };
}

async function proveAddress(partnerId: string, address: string) {
  // the fixture's recipients have no keys: prove them with a signature check that accepts this test's marker
  await AD.setPartnerAddresses(partnerId, [{ chainId: RH.chainId, address }], "add");
  await AD.verifyPartnerAddresses(partnerId, [{ chainId: RH.chainId, address, signature: `0x${"aa".repeat(65)}` }], async () => true);
}

await test("match (F7): a dry run reads every mainnet from its deploy block, writes nothing, and shows what it found per address", async () => {
  unclaim([...FX.cashOuts, FX.swap, FX.privatePayment]);
  const shop = await P.upsertPartner(wallet(), { name: "Backfilled" });
  await proveAddress(shop.id, "0x00000000000000000000000000000000000a11c2");
  await proveAddress(shop.id, "0x00000000000000000000000000000000000a11c3");
  const book = await AD.addressBook();
  const { deps, cursors, queries } = fakeBackfill();
  const r = await B.runBackfill({ dryRun: true, from: "deploy", book, budgetMs: 60_000 }, deps);
  assert.deepEqual(r.chains.map((c) => c.chainId).sort(), [1, 4217, 4663, 8453, ...(ELYSIUM ? [ELYSIUM.chainId] : [])].sort());
  assert.equal(r.chains.find((c) => c.chainId === RH.chainId)!.from, RH.deployBlock!.toString());
  for (const q of queries) assert.ok(q.to - q.from + 1n <= (q.chainId === RH.chainId ? 5_000_000n : AD.addressChains().find((n) => n.chainId === q.chainId)!.logRange));
  const mine = r.byAddress.filter((a) => a.partnerId === shop.id);
  assert.deepEqual(mine.map((a) => `${a.address.slice(-5)}:${a.matches}:${a.counted}:${a.byToken.USDG}`).sort(), ["a11c2:2:2:60", "a11c3:1:1:20"]);
  assert.equal(cursors.size, 0);
  assert.equal((await P.readPartnerStats(shop.id)).totals.cashOuts, 0);
  assert.ok(r.matches.every((m) => m.result.startsWith("would_")));
});

await test("match (F7): the admin route refuses a real pass until a dry run of the same addresses ran", async () => {
  const jar = globalThis as { __testCookies?: Record<string, string> };
  jar.__testCookies = { [ADMIN_COOKIE]: createAdminSession()! };
  const res = await backfillPost(
    new Request(`https://${HOST}/api/partners/admin/backfill`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: `https://${HOST}`, "x-forwarded-host": HOST },
      body: JSON.stringify({ dryRun: false, from: "deploy" }),
    }) as never
  );
  assert.equal(res.status, 409);
  assert.equal(((await res.json()) as { error: { code: string } }).error.code, "dry_run_first");
  jar.__testCookies = {};
});

await test("match: a real pass counts each matched cash out once, moves a link's claim to the address's owner, leaves an API key's", async () => {
  const shop = (await P.listPartners()).find((p) => p.name === "Backfilled")!;
  // [1] paid a11c2 and Motion's link counted it before the shop proved that address (a count made
  // now would already go to the shop: see "privacy: a cash out to a partner's proven address");
  // [3] paid a11c2 and was relayed with Mallory's API key
  assert.equal(await P.attributedTo(RH.chainId, FX.cashOuts[1]!), null);
  await P.recordActivity({ partner: motion, keyId: null, source: "link", linkCode: motionCode, network: RH, kind: "cash_out", txHash: FX.cashOuts[1]!, edge: { asset: USDG, amount: 30_000_000n }, vaultFee: 75_000n, now: rcpt(FX.cashOuts[1]!).blockTimestamp * 1000 });
  await P.recordActivity({ partner: mallory, keyId: "key_m", network: RH, kind: "cash_out", txHash: FX.cashOuts[3]!, edge: { asset: USDG, amount: 30_000_000n }, vaultFee: 75_000n });
  const motionBefore = (await P.readPartnerStats(motion.id)).bySource.link.counts.cash_out;
  const { deps, cursors } = fakeBackfill();
  const r = await B.runBackfill({ dryRun: false, from: "deploy", book: await AD.addressBook(), budgetMs: 60_000 }, deps);
  const by = (h: Hex) => r.matches.find((m) => m.txHash === h.toLowerCase())!;
  assert.equal(by(FX.cashOuts[1]!).result, "moved");
  assert.equal(by(FX.cashOuts[1]!).from, motion.id);
  assert.equal(by(FX.cashOuts[2]!).result, "recorded");
  assert.equal(by(FX.cashOuts[3]!).result, "already_counted", "an API key's stays");
  assert.equal(await P.attributedTo(RH.chainId, FX.cashOuts[1]!), shop.id);
  assert.equal((await P.readPartnerStats(motion.id)).bySource.link.counts.cash_out, motionBefore - 1, "taken back from the link's partner exactly");
  const s = await P.readPartnerStats(shop.id, { recent: 10 });
  assert.equal(s.bySource.chain.counts.cash_out, 2);
  assert.ok(Math.abs(s.totals.vaultFeeUsd - 0.125) < 1e-9, "0.075 + 0.05 from the WithdrawFee logs");
  assert.equal(cursors.get(RH.chainId), 105_000_000n);
  // again: nothing new
  const again = await B.runBackfill({ dryRun: false, from: "deploy", book: await AD.addressBook(), budgetMs: 60_000 }, fakeBackfill().deps);
  assert.ok(again.matches.every((m) => m.result === "already_counted" || m.via === "link"));
});

await test("match: a cash out bound to a link that nobody counted yet is settled to its link", async () => {
  // [0] paid a11c1, no partner's address; the relay bound it to Motion's link when it sent it
  unclaim([FX.cashOuts[0]!]);
  unregister([FX.cashOuts[0]!]);
  sentByRelay(FX.cashOuts[0]!);
  await A.bindRelayTx({ chainId: RH.chainId, txHash: FX.cashOuts[0]!, code: motionCode, flow: "pay", at: before(FX.cashOuts[0]!) });
  const r = await B.runBackfill({ dryRun: false, from: "deploy", book: await AD.addressBook(), budgetMs: 60_000, chains: [RH.chainId] }, fakeBackfill().deps);
  const m = r.matches.find((x) => x.txHash === FX.cashOuts[0]!.toLowerCase())!;
  assert.equal(m.via, "link");
  assert.equal(m.result, "settled");
  assert.equal(await P.attributedTo(RH.chainId, FX.cashOuts[0]!), motion.id);
});

await test("match (F8): a receipt that can't be read holds the cursor before its span", async () => {
  unclaim([FX.cashOuts[2]!]);
  const f = fakeBackfill({ receipt: (h) => (h.toLowerCase() === FX.cashOuts[2]!.toLowerCase() ? null : undefined) });
  const r = await B.runBackfill({ dryRun: false, from: "deploy", book: await AD.addressBook(), budgetMs: 60_000, chains: [RH.chainId] }, f.deps);
  const rh = r.chains[0]!;
  assert.equal(rh.done, false);
  assert.match(rh.error ?? "", /receipt could not be read/);
  const held = f.cursors.get(RH.chainId) ?? RH.deployBlock! - 1n;
  assert.ok(held < BigInt(rcpt(FX.cashOuts[2]!).blockNumber), "the cursor stays before the unread receipt");
  // the next pass, from the cursor, reads it
  const r2 = await B.runBackfill({ dryRun: false, from: "cursor", book: await AD.addressBook(), budgetMs: 60_000, chains: [RH.chainId] }, { ...fakeBackfill().deps, readCursor: f.deps.readCursor, writeCursor: f.deps.writeCursor });
  assert.equal(r2.chains[0]!.done, true);
  assert.equal(r2.matches.find((x) => x.txHash === FX.cashOuts[2]!.toLowerCase())!.result, "recorded");
});

await test("match: a pass stops at its time budget and the next one picks up at the cursor", async () => {
  const clock = { t: 0, step: 1_000 };
  const f = fakeBackfill({ clock });
  const r1 = await B.runBackfill({ dryRun: false, from: "deploy", book: await AD.addressBook(), budgetMs: 2_500, chains: [RH.chainId] }, f.deps);
  assert.equal(r1.chains[0]!.done, false);
  clock.step = 0;
  const r2 = await B.runBackfill({ dryRun: false, from: "cursor", book: await AD.addressBook(), budgetMs: 60_000, chains: [RH.chainId] }, f.deps);
  assert.equal(r2.chains[0]!.from, (f.cursors.get(RH.chainId)! >= 0n ? BigInt(r1.chains[0]!.scannedTo) + 1n : 0n).toString());
  assert.equal(r2.chains[0]!.done, true);
});

console.log(`\n${passed} partner attribution tests passed`);
