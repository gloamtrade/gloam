/**
 * A payment, claim link or cash out tried again after its first attempt's answer
 * was lost (no chain, no prover: the send itself is stubbed). The retry spends
 * the same note as that attempt, so at most one of them can land; it is checked
 * against the owner's limits like a new spend, and the earlier attempt's entry
 * in the spending log is marked replaced, so the money is counted once.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { BASE_SEPOLIA_USDC, generateReceiveKey, makeBoundNotePoseidon } from "@gloamtrade/sdk";
import type { Address, Hex, PublicClient } from "viem";
import { GloamAgent } from "../src/index.ts";
import type { SpendEntry } from "../src/spendLog.ts";

const usdc = BASE_SEPOLIA_USDC as Address;
const client = {
  chain: { id: 84532 },
  getChainId: async () => 84532,
  getBlockNumber: async () => 1_000n,
  readContract: async ({ functionName }: { functionName: string }) => {
    if (functionName === "commitmentSeen" || functionName === "isSpent") return false;
    throw new Error(`no ${functionName}`);
  },
  getTransactionReceipt: async () => {
    throw new Error("receipt not found");
  },
} as unknown as PublicClient;

const yesterday = new Date(Date.now() - 24 * 3600_000).toISOString().slice(0, 10);
const LIMITS = (maxPerDay = "100", expiresAt?: string) => ({
  ...(expiresAt ? { expiresAt } : {}),
  recipients: "any" as const,
  assets: { USDC: { maxPerPayment: "12", maxPerDay } },
});

type Internals = {
  requestKeyOf: (payTo: string, asset: { address: Address }, amountWei: bigint, label?: string) => string;
  privateSend: unknown;
  spendLog: { reserve: (...a: unknown[]) => unknown; settle: (id: string, status: string) => void; read: () => SpendEntry[] };
};

/** One store and log shared by agents with different limits, as the owner changing them would be. */
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "gloam-retry-limits-"));
  const env = { GLOAM_AGENT_PRIVATE_KEY: `0x${randomBytes(32).toString("hex")}`, GLOAM_NOTE_STORE: join(dir, "notes.json") };
  const sends: { amountPay: bigint; input: string }[] = [];
  const make = (limits: ReturnType<typeof LIMITS>) => {
    const agent = new GloamAgent({
      network: "base",
      rpc: "http://127.0.0.1:1",
      submit: "wallet",
      agentId: "retry",
      dataDir: dir,
      env,
      limits,
      publicClient: client,
      sender: { address: "0x00000000000000000000000000000000000000a1", sendCalls: async () => "0x" as Hex },
    });
    (agent as unknown as Internals).privateSend = async (a: { amountPay: bigint; input: { handle: string } }) => {
      sends.push({ amountPay: a.amountPay, input: a.input.handle });
      return { ok: false, maybeSent: true, hash: null, error: "stub: the answer was lost", payment: null, change: null };
    };
    return agent;
  };
  const logPath = join(dir, "game-spend-log.retry.json");
  const log = (): SpendEntry[] => (existsSync(logPath) ? JSON.parse(readFileSync(logPath, "utf8")).entries : []);
  return { make, sends, log };
}

/** A 20 USDC note, and a payment of 10 from it whose answer was lost over an hour ago (its note is free again). */
async function staleSpend(agent: GloamAgent, opts: { origin: "payment" | "claim"; payTo: string; logged?: "id" | "fields" | "none" }) {
  const internals = agent as unknown as Internals;
  const inN = await makeBoundNotePoseidon(20_000_000n, usdc);
  const input = agent.store.add({
    network: "base", chainId: 84532, pool: agent.network.pool, asset: usdc, symbol: "USDC", decimals: 6,
    amountWei: "20000000", secret: inN.secret, commitment: inN.commitment, nullifier: inN.nullifier,
    status: "unspent", origin: "shield", createdTx: null,
  } as never);
  let spendId: string | undefined;
  if (opts.logged && opts.logged !== "none") {
    spendId = `sp-earlier-${randomBytes(3).toString("hex")}`;
    internals.spendLog.reserve(
      { id: spendId, agent: "retry", action: "pay", network: "base", chainId: 84532, asset: usdc, symbol: "USDC", amountWei: "10000000", amount: "10", recipient: opts.payTo.length > 40 ? `${opts.payTo.slice(0, 18)}…${opts.payTo.slice(-6)}` : opts.payTo, at: new Date(Date.now() - 3 * 3600_000).toISOString() },
      () => null
    );
    internals.spendLog.settle(spendId, "unconfirmed");
  }
  const key = opts.origin === "claim" ? internals.requestKeyOf(`claim:${opts.payTo}`, { address: usdc }, 10_000_000n) : internals.requestKeyOf(opts.payTo, { address: usdc }, 10_000_000n);
  const payN = await makeBoundNotePoseidon(10_000_000n, usdc);
  const prior = agent.store.add({
    network: "base", chainId: 84532, pool: agent.network.pool, asset: usdc, symbol: "USDC", decimals: 6,
    amountWei: "10000000", secret: payN.secret, commitment: payN.commitment, nullifier: payN.nullifier,
    status: "pending", pending: "create", origin: opts.origin, createdTx: null,
    requestKey: key, spends: inN.nullifier, spendsHandle: input.handle, stale: true, label: "payment",
    ...(opts.logged === "id" ? { spendId } : {}),
  } as never);
  return { input, prior, spendId };
}

const counted = (entries: SpendEntry[]) =>
  entries.filter((e) => ["pending", "sent", "unconfirmed"].includes(e.status)).reduce((s, e) => s + BigInt(e.amountWei), 0n);

test("a retried payment is checked against the limits: refused once the owner's permission has ended, and its note is freed", async () => {
  const { make, sends, log } = setup();
  const live = make(LIMITS());
  const payee = (await generateReceiveKey()).tag;
  const { input, prior } = await staleSpend(live, { origin: "payment", payTo: payee, logged: "id" });
  const revoked = make(LIMITS("100", yesterday));
  const r = await revoked.pay({ to: payee, amount: "10" });
  assert.equal(r.status, "refused", JSON.stringify(r));
  assert.equal(r.code, "expired");
  assert.equal(sends.length, 0, "nothing sent");
  assert.equal(revoked.store.get(input.handle)?.status, "unspent", "the note it would have spent is free again");
  assert.equal(revoked.store.get(prior.handle)?.status, "pending", "the earlier attempt is still watched");
  assert.ok(log().some((e) => e.status === "refused" && /ended/.test(e.reason ?? "")), "the refusal is in the log");
});

test("a retried payment under the limits spends the same note, and its money is counted once", async () => {
  const { make, sends, log } = setup();
  const agent = make(LIMITS("15"));
  const payee = (await generateReceiveKey()).tag;
  const { input, spendId } = await staleSpend(agent, { origin: "payment", payTo: payee, logged: "id" });
  assert.equal(counted(log()), 10_000_000n);
  const r = await agent.pay({ to: payee, amount: "10" });
  assert.equal(r.status, "unconfirmed", JSON.stringify(r));
  assert.deepEqual(sends, [{ amountPay: 10_000_000n, input: input.handle }], "from the same note, so only one can land");
  const entries = log();
  assert.equal(entries.find((e) => e.id === spendId)?.status, "replaced", "the earlier attempt no longer counts");
  assert.equal(counted(entries), 10_000_000n, "10 counted once, so a 15 a day cap still lets the retry through");
  // and a second, different payment of 10 is over the 15 a day cap
  const other = (await generateReceiveKey()).tag;
  const r2 = await agent.pay({ to: other, amount: "10" });
  assert.equal(r2.code, "over_daily", JSON.stringify(r2));
});

test("an earlier attempt kept before its log id was recorded is matched by what it paid", async () => {
  const { make, log } = setup();
  const agent = make(LIMITS("15"));
  const payee = (await generateReceiveKey()).tag;
  await staleSpend(agent, { origin: "payment", payTo: payee, logged: "fields" });
  const r = await agent.pay({ to: payee, amount: "10" });
  assert.equal(r.status, "unconfirmed", JSON.stringify(r));
  assert.equal(log().filter((e) => e.status === "replaced").length, 1);
  assert.equal(counted(log()), 10_000_000n);
});

test("a retried claim link sealed to an address is checked the same way", async () => {
  const { make, sends } = setup();
  const live = make(LIMITS());
  const to = (await generateReceiveKey()).tag;
  const { input } = await staleSpend(live, { origin: "claim", payTo: to, logged: "id" });
  const revoked = make(LIMITS("100", yesterday));
  const r = await revoked.payByClaimLink({ amount: "10", sealTo: to });
  assert.equal(r.code, "expired", JSON.stringify(r));
  assert.equal(sends.length, 0);
  assert.equal(revoked.store.get(input.handle)?.status, "unspent");
});

test("a retried cash out is checked too; a note kept for it stays kept for it", async () => {
  const { make } = setup();
  const live = make(LIMITS());
  const to = "0x00000000000000000000000000000000000000b2";
  const key = (live as unknown as Internals).requestKeyOf(`cash_out:${to}`, { address: usdc }, 10_000_000n);
  const n = await makeBoundNotePoseidon(10_000_000n, usdc);
  const ready = live.store.add({
    network: "base", chainId: 84532, pool: live.network.pool, asset: usdc, symbol: "USDC", decimals: 6,
    amountWei: "10000000", secret: n.secret, commitment: n.commitment, nullifier: n.nullifier,
    status: "unspent", origin: "change", createdTx: null, requestKey: key,
  } as never);
  const revoked = make(LIMITS("100", yesterday));
  const r = await revoked.cashOut({ amount: "10", to });
  assert.equal(r.code, "expired", JSON.stringify(r));
  const after = revoked.store.get(ready.handle);
  assert.equal(after?.status, "unspent", "not spent");
  assert.equal(after?.requestKey, key, "still kept for this cash out");
});
