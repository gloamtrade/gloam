/**
 * Self-test: a payment or cash out in parts from a partner's link counts to the
 * partner as one payment, the same whether it went from one balance entry, part
 * by part, or in one transaction (lib/partnerAttribution, lib/partnerVerify,
 * lib/partners part records).
 *
 *  - the facts reader: a payment in one go (lib/relay/batch) is one private
 *    payment naming every part; a cash out in one go is one cash out, its parts'
 *    amounts and vault fees added up; two wallets, two assets, a payment beside a
 *    cash out, a part twice, too many parts or a router paid are refused
 *  - the relay's identity of a one-go call: named by its parts, the same for
 *    another proof of them, nothing for any other call
 *  - through the relay in one go: counted once, with the whole amount, the vault
 *    fees added up and one flat fee; a reverted one counts nothing
 *  - part by part, through the relay or registered from the wallet, with the
 *    payment's tag: the first transaction counted is the payment, the rest add
 *    their amounts and fees only; some parts alone and the rest in one go too
 *  - a part counted twice at once is the payment once; a part taken back comes off
 *    exactly; a tag joins one partner's parts only; no tag counts each on its own
 *  - a wallet's own Multicall3 batch never matches a registration
 *  - the on-chain match settles a one-go cash out the relay bound but never
 *    counted, once; the address match still takes plain cash outs only
 *  - the register route takes an optional 32-byte tag, and nothing else new
 *
 * The partner store is the in-process one and every chain read is a fake: nothing
 * reaches any host.
 *
 * Run from app/:  ../mcp/node_modules/.bin/tsx scripts/selftest-partner-across.mts
 */
import assert from "node:assert/strict";
import Module from "node:module";
import { fileURLToPath } from "node:url";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, type Address, type Hex } from "viem";

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

const { resetMemoryKv } = await import("../src/lib/partnersKv");
const P = await import("../src/lib/partners");
const L = await import("../src/lib/partnerLinks");
const A = await import("../src/lib/partnerAttribution");
const B = await import("../src/lib/partnerBackfill");
const AD = await import("../src/lib/partnerAddresses");
const { classifyVaultTx, VAULT_EVENTS } = await import("../src/lib/partnerVerify");
const { linkBindHash, linkNullifierHash, proofBindValue } = await import("../src/lib/partnerCode");
const { relayPoolAbi } = await import("../src/lib/relay/server");
const batch = await import("../src/lib/relay/batch");
const { getNetwork } = await import("../src/lib/networks");
const { swapRoutersOn, EVERY_SWAP_ROUTER } = await import("../src/lib/vaultSwap");
const { ApiError } = await import("../src/lib/partnersApi");
const { POST: registerPost } = await import("../src/app/api/partners/register/route");

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  await fn();
  passed++;
  console.log(`ok  ${name}`);
}

resetMemoryKv();
const RH = getNetwork("robinhood-mainnet");
assert.ok(RH.pool && batch.batchesOn(RH.chainId), "Robinhood Chain mainnet has a vault and sends in one go");
const POOL = RH.pool as Address;
const BOARD = (RH.payMemo?.address ?? null) as Address | null;
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as Address;
const OTHER_ASSET = "0x9f4BA41F91a59A34e17eE8C9EB3A51363B11aBD5" as Address;
/** The partner's request wallet, and someone else's. */
const WALLET = "0x00000000000000000000000000000000000a11c9" as Address;
const ELSEWHERE = "0x00000000000000000000000000000000000b0b01" as Address;
const RELAYER = "0xb1E994586E62994648a0b866BF33F2EDd942512e";
const PAYER = "0x000000000000000000000000000000000000bEEF";
const ROOT = `0x${"11".repeat(32)}` as Hex;
const ctx = { pool: POOL, routers: swapRoutersOn(RH.chainId).map((r) => r.address), anyRouter: EVERY_SWAP_ROUTER };
/** USDG has 6 decimals: whole dollars. */
const usd = (n: number) => BigInt(n) * 1_000_000n;
/** The vault's 0.5% on a cash out. */
const vaultFeeOn = (amount: bigint) => (amount * 50n) / 10_000n;

let seq = 0;
const fresh = (): Hex => `0x${(++seq).toString(16).padStart(64, "0")}` as Hex;
const proof = (): Hex => `0x${fresh().slice(2)}${fresh().slice(2)}` as Hex;
const wallet = () => privateKeyToAccount(generatePrivateKey()).address;

// ---------------------------------------------------------------- logs and calls

type Log = { address: string; topics: string[]; data: string };
const [SHIELDED, TRANSFERRED, UNSHIELDED, WITHDRAW_FEE] = VAULT_EVENTS;
void SHIELDED;
const transferredLog = (nullifier: Hex, c: readonly [Hex, Hex]): Log => ({
  address: POOL,
  topics: encodeEventTopics({ abi: [TRANSFERRED], eventName: "Transferred", args: { nullifier } }) as string[],
  data: encodeAbiParameters([{ type: "bytes32[2]" }], [c]),
});
const unshieldedLog = (nullifier: Hex, asset: Address, to: Address, amount: bigint): Log => ({
  address: POOL,
  topics: encodeEventTopics({ abi: [UNSHIELDED], eventName: "Unshielded", args: { nullifier, asset, to } }) as string[],
  data: encodeAbiParameters([{ type: "uint256" }], [amount]),
});
const feeLog = (nullifier: Hex, asset: Address, fee: bigint): Log => ({
  address: POOL,
  topics: encodeEventTopics({ abi: [WITHDRAW_FEE], eventName: "WithdrawFee", args: { nullifier, asset } }) as string[],
  data: encodeAbiParameters([{ type: "uint256" }], [fee]),
});

type CashPart = import("../src/lib/relay/batch").UnshieldBatchPart;
type PayPart = import("../src/lib/relay/batch").BatchPart;
const cashPart = (dollars: number, over: Partial<CashPart> = {}): CashPart => ({
  proof: proof(),
  root: ROOT,
  nullifier: fresh(),
  asset: USDG,
  to: WALLET,
  amount: usd(dollars),
  ...over,
});
const payPart = (memo = false): PayPart => ({ proof: proof(), root: ROOT, nullifier: fresh(), commitments: [fresh(), fresh()], ...(memo ? { memo: `0x${"ab".repeat(40)}` as Hex } : {}) });
/** What the vault logs for these cash outs: each one's payout and its 0.5% fee. */
const cashLogs = (parts: readonly CashPart[]): Log[] =>
  parts.flatMap((p) => [feeLog(p.nullifier, p.asset, vaultFeeOn(p.amount)), unshieldedLog(p.nullifier, p.asset, p.to, p.amount)]);
const payLogs = (parts: readonly PayPart[]): Log[] => parts.map((p) => transferredLog(p.nullifier, p.commitments));
/** One cash out straight to the vault, as the relay or a wallet sends it. */
const unshieldInput = (p: CashPart): Hex =>
  encodeFunctionData({ abi: relayPoolAbi, functionName: "unshield", args: [p.proof, p.root, p.nullifier, p.asset, p.to, p.amount] });
const transferInput = (p: PayPart): Hex =>
  encodeFunctionData({ abi: relayPoolAbi, functionName: "transfer", args: [p.proof, p.root, p.nullifier, [p.commitments[0], p.commitments[1]]] });

// ---------------------------------------------------------------- a fake chain

type Landed = { from: string; to: string; input: Hex; logs: Log[]; status: "success" | "reverted"; block: bigint; ts: number };
const chain = new Map<string, Landed>();
/** Blocks after the vault's deploy, where the on-chain match reads. */
let block = (RH.deployBlock ?? 0n) + 1_000n;
/** Lands a transaction a couple of seconds from now (after any binding made before it). */
function land(t: { from: string; to: string; input: Hex; logs: Log[]; status?: "success" | "reverted" }): Hex {
  const hash = fresh();
  block += 1n;
  chain.set(hash, { ...t, status: t.status ?? "success", block, ts: Math.floor(Date.now() / 1000) + 2 });
  return hash;
}
const deps: import("../src/lib/partnerAttribution").AttributionDeps = {
  receipt: async (_net, h) => {
    const t = chain.get(h.toLowerCase());
    return t ? { status: t.status, blockNumber: t.block, logs: t.logs } : null;
  },
  blockTime: async (_net, b) => {
    for (const t of chain.values()) if (t.block === b) return t.ts;
    throw new Error("no such block");
  },
  tx: async (_net, h) => {
    const t = chain.get(h.toLowerCase());
    return t ? { from: t.from, to: t.to, input: t.input } : null;
  },
  relaySigners: () => [RELAYER.toLowerCase()],
  record: P.recordActivity,
  now: () => Date.now(),
};
const settle = (h: Hex) => A.settleLinkTx({ chainId: RH.chainId, txHash: h }, deps);

/**
 * What the relay route does for a send from a link: binds the code to the call just
 * before it goes out, then (after the reply) binds the hash and counts it once landed.
 */
async function relaySend(code: string, call: { to: string; data: Hex }, logs: Log[], payment?: Hex, opts: { after?: boolean; status?: "success" | "reverted" } = {}): Promise<Hex> {
  const at = Date.now();
  const bound = A.bindRelaySpend({ net: RH, tx: call, code, flow: "pay", at, payment });
  await bound;
  const hash = land({ from: RELAYER, to: call.to, input: call.data, logs, status: opts.status });
  if (opts.after !== false) await A.afterRelaySend({ net: RH, hash, code, flow: "pay", at, bound, payment, wait: async () => {}, deps });
  return hash;
}
const oneGoCash = (parts: readonly CashPart[]) => ({ to: batch.MULTICALL3 as string, data: batch.unshieldBatchCalldata(POOL, parts) });
const oneGoPay = (parts: readonly PayPart[]) => ({ to: batch.MULTICALL3 as string, data: batch.batchCalldata(POOL, BOARD, parts) });
const alone = (p: CashPart) => ({ to: POOL as string, data: unshieldInput(p) });
const aloneTransfer = (p: PayPart) => ({ to: POOL as string, data: transferInput(p) });

/** A partner with a flat 5 cents per private payment and 0.25% of each cash out, and a live code. */
async function partnerWithCode(name: string) {
  const partner = await P.upsertPartner(wallet(), { name, fees: { privatePaymentCents: 5, cashoutBps: 25, depositBps: 0 } });
  const code = (await L.issueLinkCode({ partnerId: partner.id, by: "partner" })).code;
  return { partner, code };
}
const totals = async (id: string) => (await P.readPartnerStats(id)).totals;
const near = (a: number, b: number, what: string) => assert.ok(Math.abs(a - b) < 1e-9, `${what}: ${a} vs ${b}`);

// ---------------------------------------------------------------- the facts reader

await test("facts: a payment in one go is one private payment naming every part", async () => {
  const parts = [payPart(), payPart(), payPart()];
  const f = classifyVaultTx(payLogs(parts), ctx);
  assert.ok(f.ok && f.kind === "private_payment");
  assert.deepEqual(f.nullifiers, parts.map((p) => p.nullifier));
  assert.equal(f.nullifier, parts[0]!.nullifier);
  assert.equal(f.paymentCommitment, parts[0]!.commitments[0]);
  // one alone reads as before
  const one = classifyVaultTx(payLogs([parts[0]!]), ctx);
  assert.ok(one.ok && one.kind === "private_payment" && one.nullifiers.length === 1);
});

await test("facts: a cash out in one go is one cash out to one wallet: the parts' amounts and vault fees added up", async () => {
  const parts = [cashPart(10), cashPart(7), cashPart(3)];
  const f = classifyVaultTx(cashLogs(parts), ctx);
  assert.ok(f.ok && f.kind === "cash_out");
  assert.equal(f.amount, usd(20));
  assert.equal(f.vaultFee, vaultFeeOn(usd(10)) + vaultFeeOn(usd(7)) + vaultFeeOn(usd(3)));
  assert.equal(f.to?.toLowerCase(), WALLET.toLowerCase());
  assert.deepEqual(f.nullifiers, parts.map((p) => p.nullifier));
  const one = classifyVaultTx(cashLogs([parts[0]!]), ctx);
  assert.ok(one.ok && one.kind === "cash_out" && one.amount === usd(10) && one.vaultFee === vaultFeeOn(usd(10)));
});

await test("facts: two wallets, two assets, a payment beside a cash out, a part twice, seven parts or a router paid are refused", async () => {
  const mixed = (logs: Log[]) => {
    const f = classifyVaultTx(logs, ctx);
    assert.ok(!f.ok && f.reason === "mixed", JSON.stringify(f, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
  };
  mixed(cashLogs([cashPart(1), cashPart(1, { to: ELSEWHERE })]));
  mixed(cashLogs([cashPart(1), cashPart(1, { asset: OTHER_ASSET })]));
  mixed([...cashLogs([cashPart(1)]), ...payLogs([payPart()])]);
  const twice = cashPart(1);
  mixed(cashLogs([twice, { ...twice }]));
  const p = payPart();
  mixed(payLogs([p, p]));
  mixed(cashLogs(Array.from({ length: batch.BATCH_MAX_PARTS + 1 }, () => cashPart(1))));
  mixed(payLogs(Array.from({ length: batch.BATCH_MAX_PARTS + 1 }, () => payPart())));
  const router = swapRoutersOn(RH.chainId)[0]?.address as Address | undefined;
  if (router) mixed(cashLogs([cashPart(1, { to: router }), cashPart(1, { to: router })]));
});

// ---------------------------------------------------------------- the relay's identity of a one-go call

await test("identity: a one-go call is named by its parts; another proof of them names it too; any other call names nothing", async () => {
  const parts = [cashPart(4), cashPart(5)];
  const id = A.spendIdOf(RH, { to: batch.MULTICALL3, input: oneGoCash(parts).data });
  assert.ok(id);
  assert.deepEqual(id.nullifiers, parts.map((p) => p.nullifier));
  const reproven = parts.map((p) => ({ ...p, proof: proof() }));
  assert.equal(A.spendIdOf(RH, { to: batch.MULTICALL3, input: oneGoCash(reproven).data })?.id, id.id, "the proofs are no part of it");
  assert.notEqual(A.spendIdOf(RH, { to: batch.MULTICALL3, input: oneGoCash([parts[0]!, cashPart(5)]).data })?.id, id.id);
  // never the same as one of its parts sent alone
  assert.notEqual(A.spendIdOf(RH, { to: POOL, input: unshieldInput(parts[0]!) })?.id, id.id);
  // a payment in one go, its messages no part of what was paid
  const pays = [payPart(true), payPart(false), payPart(true)];
  const pid = A.spendIdOf(RH, { to: batch.MULTICALL3, input: oneGoPay(pays).data });
  assert.ok(pid);
  assert.deepEqual(pid.nullifiers, pays.map((p) => p.nullifier));
  assert.equal(A.spendIdOf(RH, { to: batch.MULTICALL3, input: oneGoPay(pays.map((p) => ({ ...p, memo: undefined }))).data })?.id, pid.id);

  const agg = (calls: { target: Address; allowFailure: boolean; callData: Hex }[]) =>
    A.spendIdOf(RH, { to: batch.MULTICALL3, input: encodeFunctionData({ abi: batch.multicall3Abi, functionName: "aggregate3", args: [calls] }) });
  const calls = batch.unshieldBatchCalls(POOL, parts);
  assert.ok(agg(calls));
  assert.equal(agg(calls.map((c) => ({ ...c, allowFailure: true }))), null, "a part allowed to fail");
  assert.equal(agg([calls[0]!]), null, "one part is not a one-go call");
  assert.equal(agg([...calls, { target: USDG, allowFailure: false, callData: "0x" }]), null, "another target");
  assert.equal(agg([calls[0]!, batch.batchCalls(POOL, BOARD, [payPart()])[0]!]), null, "a payment beside a cash out");
  if (BOARD) assert.equal(agg([...calls, batch.batchCalls(POOL, BOARD, [payPart(true)])[1]!]), null, "a message beside cash outs");
  // a network the relay doesn't send in one go on
  assert.equal(A.spendIdOf({ ...RH, chainId: 31337 }, { to: batch.MULTICALL3, input: oneGoCash(parts).data }), null);
});

// ---------------------------------------------------------------- through the relay, in one go

await test("relay, in one go: a cash out to the request's wallet counts once, the whole amount, every part's vault fee", async () => {
  const { partner, code } = await partnerWithCode("One Go Cash");
  const parts = [cashPart(10), cashPart(7), cashPart(3)];
  const hash = await relaySend(code, oneGoCash(parts), cashLogs(parts), fresh());
  const c = await P.countedRecord(RH.chainId, hash);
  assert.ok(c && c.partnerId === partner.id);
  assert.equal(c.record.kind, "cash_out");
  assert.equal(c.record.amount, usd(20).toString());
  assert.equal(c.record.vaultFee, (vaultFeeOn(usd(10)) + vaultFeeOn(usd(7)) + vaultFeeOn(usd(3))).toString());
  assert.equal(c.record.part, undefined);
  assert.equal(c.record.linkBind, "relay");
  const t = await totals(partner.id);
  assert.equal(t.cashOuts, 1);
  near(t.publicVolumeUsd, 20, "volume");
  near(t.vaultFeeUsd, 0.1, "vault fee");
  near(t.commissionUsd, 0.05, "0.25% of 20");
});

await test("relay, in one go: a payment in parts is one private payment and one flat fee", async () => {
  const { partner, code } = await partnerWithCode("One Go Pay");
  const parts = [payPart(true), payPart(true)];
  const hash = await relaySend(code, oneGoPay(parts), payLogs(parts), fresh());
  assert.equal((await P.countedRecord(RH.chainId, hash))?.record.kind, "private_payment");
  const t = await totals(partner.id);
  assert.equal(t.privatePayments, 1);
  near(t.commissionUsd, 0.05, "one flat fee");
});

await test("relay, in one go: counted from the binding made before the send alone, when the after-send step never ran", async () => {
  const { partner, code } = await partnerWithCode("Bound Only");
  const parts = [cashPart(2), cashPart(2)];
  const hash = await relaySend(code, oneGoCash(parts), cashLogs(parts), undefined, { after: false });
  assert.equal((await settle(hash)).record.amount, usd(4).toString());
  assert.equal((await totals(partner.id)).cashOuts, 1);
  // its binding names the call that went out: one spending other notes is no one's
  const other = [cashPart(2), cashPart(2)];
  const stray = land({ from: RELAYER, to: batch.MULTICALL3, input: oneGoCash(other).data, logs: cashLogs(other) });
  await assert.rejects(settle(stray), (e) => e instanceof ApiError && e.code === "not_registered");
});

await test("relay, in one go: a batch that reverted counts nothing; its parts sent again one by one count as the one payment", async () => {
  const { partner, code } = await partnerWithCode("Reverted Then Parts");
  const tag = fresh();
  const parts = [cashPart(6), cashPart(4)];
  const reverted = await relaySend(code, oneGoCash(parts), [], tag, { status: "reverted" });
  await assert.rejects(settle(reverted), (e) => e instanceof ApiError && e.code === "tx_failed");
  const again = parts.map((p) => ({ ...p, proof: proof() }));
  const hashes: Hex[] = [];
  for (const p of again) hashes.push(await relaySend(code, alone(p), cashLogs([p]), tag));
  const records = await Promise.all(hashes.map((h) => P.countedRecord(RH.chainId, h)));
  assert.deepEqual(records.map((r) => r?.record.part ?? null), [null, true]);
  const t = await totals(partner.id);
  assert.equal(t.cashOuts, 1);
  near(t.publicVolumeUsd, 10, "both parts' amount");
});

// ---------------------------------------------------------------- part by part

await test("relay, part by part: three cash outs with one tag are one cash out of the whole amount; vault fees and the share fee add up", async () => {
  const { partner, code } = await partnerWithCode("Parts Cash");
  const tag = fresh();
  const parts = [cashPart(10), cashPart(7), cashPart(3)];
  const hashes: Hex[] = [];
  for (const p of parts) hashes.push(await relaySend(code, alone(p), cashLogs([p]), tag));
  const records = (await Promise.all(hashes.map((h) => P.countedRecord(RH.chainId, h)))).map((r) => r!.record);
  assert.deepEqual(records.map((r) => r.part ?? null), [null, true, true], "the first counted is the cash out, the rest its parts");
  assert.deepEqual(records.map((r) => r.amount), parts.map((p) => p.amount.toString()), "each its own amount, as on chain");
  const t = await totals(partner.id);
  assert.equal(t.cashOuts, 1);
  near(t.publicVolumeUsd, 20, "volume");
  near(t.vaultFeeUsd, 0.1, "vault fee");
  near(t.commissionUsd, 0.05, "0.25% of each part");
  assert.equal(t.unpriced, 0);
  // the same as one cash out of $20 from one balance entry
  const single = await partnerWithCode("Single Cash");
  const p = cashPart(20);
  await relaySend(single.code, alone(p), cashLogs([p]));
  const s = await totals(single.partner.id);
  assert.deepEqual([s.cashOuts, s.publicVolumeUsd, s.vaultFeeUsd, s.commissionUsd], [t.cashOuts, t.publicVolumeUsd, t.vaultFeeUsd, t.commissionUsd]);
});

await test("relay, part by part: three private payments with one tag are one payment and one flat fee", async () => {
  const { partner, code } = await partnerWithCode("Parts Pay");
  const tag = fresh();
  const hashes: Hex[] = [];
  for (const p of [payPart(), payPart(), payPart()]) hashes.push(await relaySend(code, aloneTransfer(p), payLogs([p]), tag));
  const records = (await Promise.all(hashes.map((h) => P.countedRecord(RH.chainId, h)))).map((r) => r!.record);
  assert.deepEqual(records.map((r) => r.part ?? null), [null, true, true]);
  assert.deepEqual(records.map((r) => r.feeUsd), [0.05, 0, 0]);
  const t = await totals(partner.id);
  assert.equal(t.privatePayments, 1);
  near(t.commissionUsd, 0.05, "one flat fee");
});

await test("some parts alone and the rest in one go: still one cash out of the whole amount", async () => {
  const { partner, code } = await partnerWithCode("Mixed Parts");
  const tag = fresh();
  const first = cashPart(5);
  await relaySend(code, alone(first), cashLogs([first]), tag);
  const rest = [cashPart(3), cashPart(2)];
  const together = await relaySend(code, oneGoCash(rest), cashLogs(rest), tag);
  assert.equal((await P.countedRecord(RH.chainId, together))?.record.part, true);
  const t = await totals(partner.id);
  assert.equal(t.cashOuts, 1);
  near(t.publicVolumeUsd, 10, "volume");
  near(t.vaultFeeUsd, 0.05, "vault fee");
});

await test("wallet, part by part: each part registered with the tag before its wallet sends: one cash out, every part's amount", async () => {
  const { partner, code } = await partnerWithCode("Wallet Parts");
  const tag = fresh();
  const parts = [cashPart(8), cashPart(2)];
  const hashes: Hex[] = [];
  for (const p of parts) {
    const reg = await A.registerLink({
      chainId: RH.chainId,
      nullifierHash: linkNullifierHash(p.nullifier),
      bindHash: linkBindHash(proofBindValue(p.proof)),
      code,
      flow: "pay",
      at: Date.now(),
      payment: tag,
    });
    assert.equal(reg.registered, true);
    hashes.push(land({ from: PAYER, to: POOL, input: unshieldInput(p), logs: cashLogs([p]) }));
  }
  const settled = [];
  for (const h of hashes) settled.push((await settle(h)).record);
  assert.deepEqual(settled.map((r) => [r.linkBind, r.part ?? null]), [["wallet", null], ["wallet", true]]);
  const t = await totals(partner.id);
  assert.equal(t.cashOuts, 1);
  near(t.publicVolumeUsd, 10, "volume");
  assert.equal((await P.readPartnerStats(partner.id)).bySource.link.walletBound.cash_out, 1, "one wallet-registered cash out");
});

await test("a part counted twice at once is the payment, counted once", async () => {
  const { partner, code } = await partnerWithCode("Twice At Once");
  const tag = fresh();
  const p = cashPart(9);
  const hash = await relaySend(code, alone(p), cashLogs([p]), tag, { after: false });
  const both = await Promise.allSettled([settle(hash), settle(hash)]);
  assert.equal(both.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal((await P.countedRecord(RH.chainId, hash))?.record.part, undefined);
  const q = cashPart(1);
  assert.equal((await P.countedRecord(RH.chainId, await relaySend(code, alone(q), cashLogs([q]), tag)))?.record.part, true);
  assert.equal((await totals(partner.id)).cashOuts, 1);
});

await test("a later part taken back comes off exactly; counted again, it is a part again", async () => {
  const { partner, code } = await partnerWithCode("Taken Back");
  const tag = fresh();
  const a = cashPart(6);
  const b = cashPart(4);
  await relaySend(code, alone(a), cashLogs([a]), tag);
  const before = await totals(partner.id);
  const hb = await relaySend(code, alone(b), cashLogs([b]), tag);
  assert.ok(await P.reverseActivity(RH.chainId, hb));
  const after = await totals(partner.id);
  assert.deepEqual(after, before);
  assert.equal((await settle(hb)).record.part, true);
  const t = await totals(partner.id);
  assert.equal(t.cashOuts, 1);
  near(t.publicVolumeUsd, 10, "volume");
});

await test("a tag joins one partner's parts only; without one (an app from before) each part counts on its own", async () => {
  const one = await partnerWithCode("Tag One");
  const two = await partnerWithCode("Tag Two");
  const tag = fresh();
  const a = cashPart(1);
  const b = cashPart(1);
  await relaySend(one.code, alone(a), cashLogs([a]), tag);
  await relaySend(two.code, alone(b), cashLogs([b]), tag);
  assert.equal((await totals(one.partner.id)).cashOuts, 1);
  assert.equal((await totals(two.partner.id)).cashOuts, 1, "another partner's payment is its own");
  const untagged = await partnerWithCode("No Tag");
  for (const p of [cashPart(1), cashPart(1)]) await relaySend(untagged.code, alone(p), cashLogs([p]));
  assert.equal((await totals(untagged.partner.id)).cashOuts, 2);
  // a tag that isn't 32 bytes is no tag
  const junk = await partnerWithCode("Junk Tag");
  for (const p of [cashPart(1), cashPart(1)]) await relaySend(junk.code, alone(p), cashLogs([p]), "0x1234" as Hex);
  assert.equal((await totals(junk.partner.id)).cashOuts, 2);
});

await test("a wallet's own Multicall3 batch never matches a registration: one names one spend", async () => {
  const { code } = await partnerWithCode("Wallet Batch");
  const parts = [cashPart(1), cashPart(1)];
  for (const p of parts) {
    await A.registerLink({ chainId: RH.chainId, nullifierHash: linkNullifierHash(p.nullifier), bindHash: linkBindHash(proofBindValue(p.proof)), code, flow: "pay", at: Date.now() });
  }
  const h = land({ from: PAYER, to: batch.MULTICALL3, input: oneGoCash(parts).data, logs: cashLogs(parts) });
  await assert.rejects(settle(h), (e) => e instanceof ApiError && e.code === "not_registered");
});

await test("relay: transferBatch and unshieldBatch are payments and cash outs to a link", () => {
  assert.equal(A.relayFlowOf({ action: "transferBatch" }), "pay");
  assert.equal(A.relayFlowOf({ action: "unshieldBatch" }), "pay");
  assert.equal(A.relayFlowOf({ action: "memo" }), null);
});

// ---------------------------------------------------------------- the on-chain match

await test("match: a one-go cash out the relay bound but never counted is settled once; the address match still takes plain cash outs only", async () => {
  const { partner, code } = await partnerWithCode("Matched Later");
  const parts = [cashPart(5), cashPart(5)];
  const hash = await relaySend(code, oneGoCash(parts), cashLogs(parts), undefined, { after: false });
  const landed = chain.get(hash)!;
  const logs = parts.map((p) => ({ txHash: hash, blockNumber: landed.block, nullifier: p.nullifier, asset: p.asset, to: p.to, amount: p.amount }));
  const run = (book: Map<number, Map<string, string>>) =>
    B.runBackfill(
      { dryRun: false, from: "deploy", book, budgetMs: 60_000, chains: [RH.chainId] },
      {
        ...B.backfillDeps,
        head: async () => landed.block,
        unshielded: async (_net, from, to) => (landed.block >= from && landed.block <= to ? logs : []),
        receipt: deps.receipt,
        blockTime: deps.blockTime,
        settle: async (net, h) => void (await A.settleLinkTx({ chainId: net.chainId, txHash: h }, deps)),
        readCursor: async () => null,
        writeCursor: async () => {},
        now: () => Date.now(),
      }
    );
  const r = await run(new Map());
  assert.deepEqual(r.matches.map((m) => m.result), ["settled", "already_counted"]);
  const t = await totals(partner.id);
  assert.equal(t.cashOuts, 1);
  near(t.publicVolumeUsd, 10, "volume");

  // a one-go cash out to a partner's own proven address, from no link: not a plain cash out, as before
  const shop = await P.upsertPartner(wallet(), { name: "Proven Shop" });
  const shopTo = "0x00000000000000000000000000000000000a11d1" as Address;
  await AD.setPartnerAddresses(shop.id, [{ chainId: RH.chainId, address: shopTo }], "add");
  await AD.verifyPartnerAddresses(shop.id, [{ chainId: RH.chainId, address: shopTo, signature: `0x${"aa".repeat(65)}` }], async () => true);
  const toShop = [cashPart(1, { to: shopTo }), cashPart(1, { to: shopTo })];
  const h2 = land({ from: RELAYER, to: batch.MULTICALL3, input: oneGoCash(toShop).data, logs: cashLogs(toShop) });
  const l2 = chain.get(h2)!;
  logs.splice(0, logs.length, ...toShop.map((p) => ({ txHash: h2, blockNumber: l2.block, nullifier: p.nullifier, asset: p.asset, to: p.to, amount: p.amount })));
  const r2 = await B.runBackfill(
    { dryRun: false, from: "deploy", book: new Map([[RH.chainId, new Map([[shopTo.toLowerCase(), shop.id]])]]), budgetMs: 60_000, chains: [RH.chainId] },
    {
      ...B.backfillDeps,
      head: async () => l2.block,
      unshielded: async (_net, from, to) => (l2.block >= from && l2.block <= to ? logs : []),
      receipt: deps.receipt,
      blockTime: deps.blockTime,
      readCursor: async () => null,
      writeCursor: async () => {},
      now: () => Date.now(),
    }
  );
  assert.deepEqual(r2.matches.map((m) => m.reason), ["Not a plain cash out.", "Not a plain cash out."]);
  assert.equal((await totals(shop.id)).cashOuts, 0);
});

// ---------------------------------------------------------------- the register route

await test("register route: takes an optional 32-byte payment tag, refuses a bad one and anything else new", async () => {
  const { code } = await partnerWithCode("Route Tag");
  const req = (body: unknown, ip: string) =>
    registerPost(
      new Request("https://gloam.trade/api/partners/register", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://gloam.trade", "x-forwarded-for": ip },
        body: JSON.stringify(body),
      }) as never
    );
  const base = { chainId: RH.chainId, nullifierHash: fresh(), bindHash: fresh(), code, flow: "pay" };
  assert.equal((await req({ ...base, payment: fresh() }, "203.0.113.31")).status, 201);
  assert.equal((await req({ ...base, nullifierHash: fresh() }, "203.0.113.32")).status, 201, "no tag, as before");
  assert.equal((await req({ ...base, nullifierHash: fresh(), payment: "0x12" }, "203.0.113.33")).status, 400);
  assert.equal((await req({ ...base, nullifierHash: fresh(), payment: fresh(), wallet: PAYER }, "203.0.113.34")).status, 400);
  assert.equal(A.readRegisterInput({ ...base, payment: `0x${"AB".repeat(32)}` }).payment, `0x${"ab".repeat(32)}`, "kept lowercase");
  assert.equal("payment" in A.readRegisterInput(base), false);
});

console.log(`\n${passed} partner payment-in-parts checks passed`);
