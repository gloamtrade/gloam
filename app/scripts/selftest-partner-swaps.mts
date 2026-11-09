/**
 * Self-test: private swaps for partners and on the hosted MCP.
 *
 *  - accounting: a private swap is counted with its input token and amount and no
 *    partner fee, apart from public volume, per day and per network
 *  - the partner relay (lib/partnerRelay): a swap whose note the vault reads as
 *    unspent is counted; one whose note is already spent (the refund path) and an
 *    exit are sent and not counted; the vault is read before the send, and a read
 *    that fails sends nothing; nothing in the request decides what is counted; a
 *    count whose transaction reverted is taken back, and only once
 *  - the v1 routes: swap and swapExit refused on a network with no swaps, before
 *    any chain read; GET /api/v1/swaps; the quote route's input checks
 *  - the server quote (lib/swapQuote) against a fake chain: a clean quote, and each
 *    stop the swap tab applies (refund_wont_fit, vault_closed, over_room, relay_off,
 *    gas_high, swap_small with the relay's floor, floor_unread), the quote errors in
 *    plain words, and bad input refused before any read
 *  - the hosted MCP's gloam_swap_quote: listed, refused off the swap networks and on
 *    bad arguments before any read, and secret screening still runs first
 *
 * The partner store is the in-process one and every chain read is a fake: nothing
 * reaches any host.
 *
 * Run from app/:  ../mcp/node_modules/.bin/tsx scripts/selftest-partner-swaps.mts
 */
import assert from "node:assert/strict";
import { encodeAbiParameters, keccak256, toHex, type Address, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";

process.env.GLOAM_PARTNERS_STORE = "memory";
delete process.env.GLOAM_API_KEY_PEPPER;
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;
const env = process.env as Record<string, string | undefined>;
env.NODE_ENV = "test";

const { resetMemoryKv } = await import("../src/lib/partnersKv");
const { apiKeyPepper, createApiKey } = await import("../src/lib/apiKeys");
const { attributedTo, claimTransaction, commissionFor, describeFee, readPartnerStats, recordActivity, reverseActivity, upsertPartner, ACTIVITY_KINDS } = await import("../src/lib/partners");
const { depositIn } = await import("../src/lib/partnerDeposits");
const { relayForPartner, partnerRelayDeps } = await import("../src/lib/partnerRelay");
const { RelayError } = await import("../src/lib/relay/server");
const { getNetwork, NETWORK_KEYS } = await import("../src/lib/networks");
const { SwapQuoteError, quoteSwapServer, SWAP_PUBLIC_LINE, SWAP_QUOTE_PER_MINUTE } = await import("../src/lib/swapQuote");
const vs = await import("../src/lib/vaultSwap");
const { smallestSwapUsd, swapFloorMessage, swapFloorShown } = await import("../src/lib/relay/swapFloor");
const { POST: relayPost } = await import("../src/app/api/v1/relay/route");
const { GET: swapsGet } = await import("../src/app/api/v1/swaps/route");
const { POST: quotePost } = await import("../src/app/api/v1/swaps/quote/route");
const { callTool, TOOLS } = await import("../src/lib/mcpRemote/tools");

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  await fn();
  passed++;
  console.log(`ok  ${name}`);
}

resetMemoryKv();
const RH = getNetwork("robinhood-mainnet");
const TEMPO = getNetwork("tempo-mainnet");
const RH_TEST = getNetwork("robinhood");
const RH_USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as Address;
const TEMPO_USDCE = "0x20c000000000000000000000b9537d11c60e8b50" as Address;
const TEMPO_PATHUSD = "0x20c0000000000000000000000000000000000000" as Address;
const H = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const wallet = privateKeyToAccount(generatePrivateKey());
const partner = await upsertPartner(wallet.address, { name: "Swap Desk" });

// ---------------------------------------------------------------- accounting

await test("accounting: a swap has no partner fee, and its input is valued when priced", () => {
  const fees = { privatePaymentCents: 5, cashoutBps: 25, depositBps: 10 };
  assert.ok(ACTIVITY_KINDS.includes("private_swap"));
  const priced = commissionFor("private_swap", fees, { amount: 250_000_000n, decimals: 6, priceMicros: 1_000_000n });
  assert.deepEqual(priced, { feeUsdMicros: 0n, feeToken: 0n, volumeUsdMicros: 250_000_000n });
  const unpriced = commissionFor("private_swap", fees, { amount: 10n ** 18n, decimals: 18, priceMicros: null });
  assert.deepEqual(unpriced, { feeUsdMicros: 0n, feeToken: 0n, volumeUsdMicros: null });
  assert.equal(describeFee("private_swap", fees), "No partner fee on private swaps");
});

await test("accounting: swaps are counted apart from public volume, per day and per network", async () => {
  const p = await upsertPartner(privateKeyToAccount(generatePrivateKey()).address, { name: "Counted", fees: { cashoutBps: 25 } });
  const a = await recordActivity({ partner: p, keyId: "key_a", network: RH, kind: "private_swap", txHash: H(101), edge: { asset: RH_USDG, amount: 300_000_000n } });
  assert.ok(a.recorded);
  if (a.recorded) {
    assert.equal(a.record.kind, "private_swap");
    assert.equal(a.record.amount, "300000000");
    assert.equal(a.record.asset?.toLowerCase(), RH_USDG.toLowerCase());
    assert.equal(a.record.feeUsd, 0);
    assert.equal(a.record.volumeUsd, 300);
    assert.equal(a.record.feeBasis, "No partner fee on private swaps");
  }
  await recordActivity({ partner: p, keyId: "key_a", network: RH, kind: "cash_out", txHash: H(102), edge: { asset: RH_USDG, amount: 100_000_000n } });
  const dup = await recordActivity({ partner: p, keyId: "key_a", network: RH, kind: "private_swap", txHash: H(101), edge: { asset: RH_USDG, amount: 1n } });
  assert.equal(dup.recorded, false, "a transaction counts once");
  const stats = await readPartnerStats(p.id, { recent: 5 });
  assert.equal(stats.totals.privateSwaps, 1);
  assert.equal(stats.totals.swapVolumeUsd, 300);
  assert.equal(stats.totals.cashOuts, 1);
  assert.equal(stats.totals.publicVolumeUsd, 100, "public volume stays deposits and cash outs");
  assert.equal(stats.byKind.private_swap.count, 1);
  assert.equal(stats.byKind.private_swap.commissionUsd, 0);
  assert.equal(stats.byNetwork["robinhood-mainnet"]!.private_swap, 1);
  assert.equal(stats.daily.at(-1)!.swaps, 1);
  assert.equal(stats.daily.at(-1)!.volumeUsd, 100, "daily volume stays deposits and cash outs");
  const usdg = stats.byAsset.find((r) => r.asset.toLowerCase() === RH_USDG.toLowerCase());
  assert.equal(usdg?.volume, "100", "per-asset volume stays what deposits and cash outs moved");
  assert.equal(stats.recent[0]!.kind, "cash_out");
});

// ---------------------------------------------------------------- partner relay

type Call = string;
function fakeDeps(opts: { spent?: boolean; spentRead?: "ok" | "fail" } = {}) {
  const calls: Call[] = [];
  const recorded: { kind: string; edge: unknown; vaultFee?: bigint | null; source?: string }[] = [];
  const memoFrom: unknown[] = [];
  const claimed: Hex[] = [];
  const senders: (string | readonly string[] | undefined)[] = [];
  const deps = {
    ...partnerRelayDeps,
    relayTransfer: async (_net: unknown, _body: unknown, sender?: string | readonly string[]) => {
      senders.push(sender);
      calls.push("transfer");
      return H(1);
    },
    relayUnshield: async () => {
      calls.push("unshield");
      return H(2);
    },
    relayMemo: async (_net: unknown, _body: unknown, from?: unknown) => {
      calls.push("memo");
      memoFrom.push(from);
      return H(3);
    },
    relayVaultSwap: async (_net: unknown, _body: unknown, sender?: string | readonly string[]) => {
      senders.push(sender);
      calls.push("swap");
      return H(4 + calls.length);
    },
    relayVaultSwapExit: async () => {
      calls.push("swapExit");
      return H(40 + calls.length);
    },
    isSpent: async () => {
      calls.push("isSpent");
      if (opts.spentRead === "fail") throw new Error("rpc down");
      return opts.spent ?? false;
    },
    claim: (async (_p: unknown, _chainId: number, hash: Hex) => (claimed.push(hash), true)) as typeof claimTransaction,
    // the vault's fee setting, never read from a chain here
    vaultFeeBps: async () => 25,
    record: (async (a: Parameters<typeof recordActivity>[0]) => {
      recorded.push({ kind: a.kind, edge: a.edge, vaultFee: a.vaultFee, source: a.source });
      return recordActivity(a);
    }) as typeof recordActivity,
  };
  return { deps, calls, recorded, memoFrom, claimed, senders };
}

const swapBody = (over: Record<string, unknown> = {}) => ({
  chainId: RH.chainId,
  action: "swap",
  spend: { proof: `0x${"22".repeat(256)}`, root: H(7), nullifier: H(8), asset: RH_USDG, amount: "50000000" },
  deposit: { proof: `0x${"22".repeat(256)}`, commitment: H(9), asset: "0x0000000000000000000000000000000000000000", amount: "1000" },
  refund: { proof: `0x${"22".repeat(256)}`, commitment: H(10), asset: RH_USDG, amount: "49000000" },
  route: [],
  ...over,
});

let txn = 200;
await test("partner relay: a payment message goes with the partner account and its approval, not the key", async () => {
  const { deps, memoFrom } = fakeDeps();
  const body = { chainId: RH.chainId, action: "memo", paymentCommitment: H(500), memo: "0x00" };
  await relayForPartner({ net: RH, body, partner: { ...partner, relayApproved: true }, keyId: "key_1" }, deps);
  await relayForPartner({ net: RH, body, partner, keyId: "key_1" }, deps);
  assert.deepEqual(memoFrom, [{ partner: partner.id, approved: true }, { partner: partner.id, approved: false }]);
});

await test("partner relay: a swap of an unspent note is counted, with its input, after the vault read", async () => {
  const { deps, calls, recorded } = fakeDeps({ spent: false });
  const body = swapBody({ spend: { ...swapBody().spend, nullifier: H(++txn) } });
  const r = await relayForPartner({ net: RH, body, partner, keyId: "key_1" }, deps);
  assert.deepEqual(calls, ["isSpent", "swap"], "the vault is read before the send");
  assert.equal(r.action, "swap");
  assert.equal(r.attribution.recorded, true);
  assert.equal(r.attribution.kind, "private_swap");
  // the vault's 0.25% on the swap's input, from its fee setting at the time
  assert.deepEqual(recorded[0], { kind: "private_swap", edge: { asset: RH_USDG, amount: 50_000_000n }, vaultFee: 125_000n, source: "api" });
});

await test("partner relay: a send holds against the partner account's share of the cap, as the relay takes it", async () => {
  const { deps, senders } = fakeDeps({ spent: false });
  await relayForPartner({ net: RH, body: swapBody({ spend: { ...swapBody().spend, nullifier: H(950) } }), partner, keyId: "k", sender: `partner:${partner.id}` }, deps);
  await relayForPartner({ net: RH, body: { chainId: RH.chainId, action: "transfer" }, partner, keyId: "k", sender: `partner:${partner.id}` }, deps);
  assert.deepEqual(senders, [`partner:${partner.id}`, `partner:${partner.id}`]);
});

await test("partner relay: a swap call for a spent note (the refund path) is sent and not counted", async () => {
  const { deps, calls, recorded } = fakeDeps({ spent: true });
  // what the request says about itself is not read
  const body = swapBody({ kind: "private_swap", refund: { ...swapBody().refund }, unshieldTx: H(77), attribution: { recorded: true } });
  const r = await relayForPartner({ net: RH, body, partner, keyId: "key_1" }, deps);
  assert.deepEqual(calls, ["isSpent", "swap"]);
  assert.deepEqual(r.attribution, { recorded: false, kind: null, reason: "not_billable" });
  assert.equal(recorded.length, 0);
});

await test("partner relay: a refund and an exit are claimed for the partner, so neither can be counted later as a deposit or a swap", async () => {
  const refund = fakeDeps({ spent: true });
  const r = await relayForPartner({ net: RH, body: swapBody({ unshieldTx: H(78) }), partner, keyId: "key_1" }, refund.deps);
  assert.deepEqual(refund.claimed, [r.hash], "the refund's transaction is claimed");
  const exit = fakeDeps();
  const e = await relayForPartner({ net: RH, body: { chainId: RH.chainId, action: "swapExit" }, partner, keyId: "key_1" }, exit.deps);
  assert.deepEqual(exit.claimed, [e.hash], "the exit's transaction is claimed");
  const swap = fakeDeps({ spent: false });
  await relayForPartner({ net: RH, body: swapBody({ spend: { ...swapBody().spend, nullifier: H(901) } }), partner, keyId: "key_1" }, swap.deps);
  assert.deepEqual(swap.claimed, [], "a swap is recorded, which claims it already");
  // the real claim, in the store: a second claim of the same transaction, or a deposit claim of it, is refused
  const tx = H(902);
  assert.equal(await claimTransaction(partner, RH.chainId, tx), true);
  assert.equal(await attributedTo(RH.chainId, tx), partner.id);
  const other = await upsertPartner(privateKeyToAccount(generatePrivateKey()).address, { name: "Other Desk" });
  assert.equal(await claimTransaction(other, RH.chainId, tx), false);
  const asDeposit = await recordActivity({ partner: other, keyId: null, network: RH, kind: "deposit", txHash: tx, edge: { asset: RH_USDG, amount: 1n } });
  assert.equal(asDeposit.recorded, false);
  // a claim that can't be stored never fails the send
  const broken = fakeDeps({ spent: true });
  const sent = await relayForPartner({ net: RH, body: swapBody({ unshieldTx: H(79) }), partner, keyId: "key_1" }, { ...broken.deps, claim: async () => { throw new Error("kv down"); } });
  assert.ok(sent.hash);
});

await test("deposits: a swap's or a refund's note, put in through a swap router, is no one's deposit", () => {
  const pool = RH.pool!;
  const word = (a: string) => `0x${a.toLowerCase().slice(2).padStart(64, "0")}` as Hex;
  const topic0 = keccak256(toHex("Shielded(bytes32,address,uint256,uint256,address)"));
  const log = (from: Address, amount: bigint, address: Address = pool) => ({
    address,
    topics: [topic0, H(3001), word(RH_USDG), word(from)] as [Hex, ...Hex[]],
    data: encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [amount, 7n]),
    blockHash: H(1), blockNumber: 1n, logIndex: 0, transactionHash: H(2), transactionIndex: 0, removed: false,
  });
  const depositor = "0x00000000000000000000000000000000de90517e" as Address;
  assert.deepEqual(depositIn([log(depositor, 5_000_000n)] as never, pool), { asset: RH_USDG, amount: 5_000_000n }, "a wallet's deposit counts");
  for (const router of vs.EVERY_SWAP_ROUTER) {
    assert.equal(depositIn([log(router, 5_000_000n)] as never, pool), null, `a note from router ${router} is not a deposit`);
  }
  assert.equal(depositIn([log(depositor, 5n, "0x000000000000000000000000000000000000dEaD")] as never, pool), null, "only Gloam's vault");
});

await test("partner relay: a vault read that fails sends nothing", async () => {
  const { deps, calls } = fakeDeps({ spentRead: "fail" });
  await assert.rejects(relayForPartner({ net: RH, body: swapBody(), partner, keyId: "key_1" }, deps), (e: unknown) => {
    assert.ok(e instanceof RelayError);
    assert.equal(e.code, "check_failed");
    assert.equal(e.status, 503);
    return true;
  });
  assert.deepEqual(calls, ["isSpent"], "no swap was sent");
});

await test("partner relay: a malformed spend or a network with no swaps is refused before any read", async () => {
  const { deps, calls } = fakeDeps();
  await assert.rejects(relayForPartner({ net: RH, body: swapBody({ spend: { ...swapBody().spend, nullifier: "0x12" } }), partner, keyId: "k" }, deps), /Invalid nullifier/);
  await assert.rejects(relayForPartner({ net: RH, body: swapBody({ spend: { ...swapBody().spend, amount: "0" } }), partner, keyId: "k" }, deps), /Invalid amount/);
  await assert.rejects(relayForPartner({ net: RH_TEST, body: swapBody({ chainId: RH_TEST.chainId }), partner, keyId: "k" }, deps), (e: unknown) => {
    assert.ok(e instanceof RelayError && e.code === "no_swap");
    return true;
  });
  assert.deepEqual(calls, []);
});

await test("partner relay: an exit is sent and not counted; payments and cash outs as before", async () => {
  const { deps, calls, recorded } = fakeDeps();
  const exit = await relayForPartner({ net: RH, body: { chainId: RH.chainId, action: "swapExit" }, partner, keyId: "k" }, deps);
  assert.deepEqual(exit.attribution, { recorded: false, kind: null, reason: "not_billable" });
  const pay = await relayForPartner({ net: RH, body: { chainId: RH.chainId, action: "transfer" }, partner, keyId: "k" }, { ...deps, relayTransfer: async () => H(++txn) });
  assert.equal(pay.attribution.kind, "private_payment");
  const out = await relayForPartner(
    { net: RH, body: { chainId: RH.chainId, action: "unshield", asset: RH_USDG, amount: "5000000" }, partner, keyId: "k" },
    { ...deps, relayUnshield: async () => H(++txn) }
  );
  assert.equal(out.attribution.kind, "cash_out");
  assert.deepEqual(recorded.map((r) => r.kind), ["private_payment", "cash_out"]);
  assert.deepEqual(calls, ["swapExit"]);
  await assert.rejects(relayForPartner({ net: RH, body: { action: "shield" }, partner, keyId: "k" }, deps), (e: unknown) => {
    assert.ok(e instanceof RelayError && e.code === "bad_action" && e.status === 400);
    return true;
  });
});

await test("partner relay: a count whose transaction reverted is taken back, whether its receipt comes before or after the count", async () => {
  type End = (status: "success" | "reverted") => Promise<void>;
  const p = await upsertPartner(privateKeyToAccount(generatePrivateKey()).address, { name: "Revert Desk", fees: { cashoutBps: 25 } });
  const ends: End[] = [];
  const { deps } = fakeDeps({ spent: false });
  const hooked = (h: Hex, now?: "reverted" | "success") => async (_n: unknown, _b: unknown, _s: unknown, hooks?: { onEnd?: End }) => {
    if (now) await hooks!.onEnd!(now); // the receipt before the count
    else ends.push(hooks!.onEnd!);
    return h;
  };
  const cashOut = (h: Hex, now?: "reverted" | "success") =>
    relayForPartner(
      { net: RH, body: { chainId: RH.chainId, action: "unshield", asset: RH_USDG, amount: "5000000" }, partner: p, keyId: "k" },
      { ...deps, relayUnshield: hooked(h, now) as typeof deps.relayUnshield }
    );
  // landed: stays counted
  const ok = await cashOut(H(7001));
  await ends.pop()!("success");
  assert.equal(ok.attribution.recorded, true);
  // reverted after the count: taken back
  const late = await cashOut(H(7002));
  assert.equal(late.attribution.recorded, true);
  await ends.pop()!("reverted");
  // reverted before the count: never left counted
  await cashOut(H(7003), "reverted");
  // a payment and a swap the same way
  await relayForPartner({ net: RH, body: { chainId: RH.chainId, action: "transfer" }, partner: p, keyId: "k" }, { ...deps, relayTransfer: hooked(H(7004)) as typeof deps.relayTransfer });
  await ends.pop()!("reverted");
  await relayForPartner(
    { net: RH, body: swapBody({ spend: { ...swapBody().spend, nullifier: H(7005) } }), partner: p, keyId: "k" },
    { ...deps, relayVaultSwap: hooked(H(7006)) as typeof deps.relayVaultSwap }
  );
  await ends.pop()!("reverted");
  const stats = await readPartnerStats(p.id, { recent: 10 });
  assert.equal(stats.totals.cashOuts, 1, "only the cash out that landed");
  assert.equal(stats.totals.privatePayments, 0);
  assert.equal(stats.totals.privateSwaps, 0);
  assert.deepEqual(stats.recent.map((r) => r.txHash), [H(7001)]);
  for (const h of [H(7002), H(7003), H(7004), H(7006)]) assert.equal(await attributedTo(RH.chainId, h), null, `${h} is no one's`);
  assert.equal(await attributedTo(RH.chainId, H(7001)), p.id);
});

await test("partner store: two reversals of one transaction at once take its counts back once", async () => {
  const p = await upsertPartner(privateKeyToAccount(generatePrivateKey()).address, { name: "Twice Desk", fees: { cashoutBps: 25 } });
  await recordActivity({ partner: p, keyId: "k", network: RH, kind: "cash_out", txHash: H(7101), edge: { asset: RH_USDG, amount: 1_000_000n } });
  await recordActivity({ partner: p, keyId: "k", network: RH, kind: "cash_out", txHash: H(7102), edge: { asset: RH_USDG, amount: 2_000_000n } });
  const [a, b] = await Promise.all([reverseActivity(RH.chainId, H(7101)), reverseActivity(RH.chainId, H(7101))]);
  assert.equal([a, b].filter(Boolean).length, 1, "one of them finds it");
  const stats = await readPartnerStats(p.id, { recent: 5 });
  assert.equal(stats.totals.cashOuts, 1, "the other cash out is still counted");
  assert.equal(stats.totals.publicVolumeUsd, 2);
});

// ---------------------------------------------------------------- v1 routes

const HOST = "localhost:3121";
const pepper = (() => {
  const p = apiKeyPepper(HOST);
  if (!p.ok) throw new Error("dev pepper should apply on localhost");
  return p.pepper;
})();
const testKey = (await createApiKey({ partnerId: partner.id, name: "Swaps", env: "test", pepper })).secret;
const liveKey = (await createApiKey({ partnerId: partner.id, name: "Swaps live", env: "live", pepper })).secret;
function req(path: string, init: { method?: string; key?: string; body?: unknown; ip?: string } = {}) {
  const headers: Record<string, string> = { "x-forwarded-host": HOST, "x-forwarded-for": init.ip ?? "203.0.113.1" };
  if (init.key) headers.authorization = `Bearer ${init.key}`;
  if (init.body !== undefined) headers["content-type"] = "application/json";
  return new Request(`http://${HOST}${path}`, { method: init.method ?? "GET", headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
}
type Envelope = { v: number; ok: boolean; data?: Record<string, unknown>; error?: { code: string; message: string } };
const json = async (r: Response) => (await r.json()) as Envelope;

await test("v1 relay: swap and swapExit on a network with no swaps are refused before any read", async () => {
  const swap = await json(await relayPost(req("/api/v1/relay", { method: "POST", key: testKey, body: swapBody({ chainId: RH_TEST.chainId }) })));
  assert.equal(swap.ok, false);
  assert.equal(swap.error!.code, "no_swap");
  const exit = await json(await relayPost(req("/api/v1/relay", { method: "POST", key: testKey, body: { chainId: RH_TEST.chainId, action: "swapExit" } })));
  assert.equal(exit.error!.code, "no_swap");
  const bad = await json(await relayPost(req("/api/v1/relay", { method: "POST", key: testKey, body: { chainId: RH_TEST.chainId, action: "trade" } })));
  assert.equal(bad.error!.code, "bad_action");
  assert.match(bad.error!.message, /swapExit/);
});

await test("v1 swaps: every network, live ones with their router and named assets", async () => {
  const r = await json(await swapsGet(req("/api/v1/swaps", { key: testKey })));
  assert.equal(r.ok, true);
  const nets = r.data!.networks as import("../src/lib/swapQuote").SwapNetworkView[];
  assert.equal(nets.length, NETWORK_KEYS.length);
  const rh = nets.find((n) => n.network === "robinhood-mainnet")!;
  assert.equal(rh.live, true);
  assert.equal(rh.router, vs.vaultSwapRouter(4663));
  assert.ok(rh.assets.some((a) => a.symbol === "USDG" && a.decimals === 6));
  assert.ok(rh.earlierRouters.length >= 1, "an earlier router stays for refunds");
  const tempo = nets.find((n) => n.network === "tempo-mainnet")!;
  assert.equal(tempo.live, true);
  assert.equal(tempo.venue, "tempo");
  for (const n of nets.filter((x) => x.testnet)) assert.equal(n.live, false, `${n.network} has no swaps`);
  for (const id of [8453, 1]) {
    const n = nets.find((x) => x.chainId === id);
    if (n) assert.equal(n.live, vs.swapV3Live(id), `chain ${id} follows its switch`);
  }
  assert.equal(r.data!.public, SWAP_PUBLIC_LINE);
});

await test("v1 swaps/quote: bad input is refused before any read", async () => {
  const cases: [Record<string, unknown>, string][] = [
    [{ network: "nowhere", assetIn: RH_USDG, assetOut: RH_USDG, amountIn: "1" }, "network"],
    [{ network: "robinhood-mainnet", chainId: 4217, assetIn: RH_USDG, assetOut: RH_USDG, amountIn: "1" }, "network"],
    [{ network: "robinhood", assetIn: RH_USDG, assetOut: RH_USDG, amountIn: "1" }, "no_swap"],
    [{ network: "robinhood-mainnet", assetIn: "usdg", assetOut: RH_USDG, amountIn: "1" }, "bad_request"],
    [{ network: "robinhood-mainnet", assetIn: RH_USDG, assetOut: RH_USDG, amountIn: "1" }, "same_asset"],
    [{ network: "robinhood-mainnet", assetIn: RH_USDG, assetOut: TEMPO_USDCE, amountIn: "1" }, "swap_asset"],
    [{ network: "robinhood-mainnet", assetIn: RH_USDG, assetOut: "0x0000000000000000000000000000000000000000", amountIn: "1.5" }, "bad_request"],
  ];
  for (const [body, code] of cases) {
    // a testnet with a test key, a mainnet with a live key
    const key = body.network === "robinhood" ? testKey : liveKey;
    const r = await json(await quotePost(req("/api/v1/swaps/quote", { method: "POST", key, body, ip: "203.0.113.2" })));
    assert.equal(r.ok, false, JSON.stringify(body));
    assert.equal(r.error!.code, code, JSON.stringify(body));
  }
});

await test("v1 swaps/quote: a test key can't quote a mainnet", async () => {
  const r = await json(await quotePost(req("/api/v1/swaps/quote", { method: "POST", key: testKey, body: { network: "robinhood-mainnet", assetIn: RH_USDG, assetOut: RH_USDG, amountIn: "1" }, ip: "203.0.113.3" })));
  assert.equal(r.ok, false);
  assert.equal(r.error!.code, "key_env_mismatch");
});

await test("v1 swaps/quote: limited per partner account, all its keys together, and per IP", async () => {
  // its own account and keys, so other tests' quotes don't count here
  const desk = await upsertPartner(privateKeyToAccount(generatePrivateKey()).address, { name: "Quote Desk" });
  const k1 = (await createApiKey({ partnerId: desk.id, name: "a", env: "live", pepper })).secret;
  const k2 = (await createApiKey({ partnerId: desk.id, name: "b", env: "live", pepper })).secret;
  // bad input answers without any chain read, so only the limit is under test
  const body = { network: "robinhood-mainnet", assetIn: RH_USDG, assetOut: RH_USDG, amountIn: "1" };
  const codes: string[] = [];
  for (let i = 0; i < SWAP_QUOTE_PER_MINUTE + 1; i++) {
    const r = await json(await quotePost(req("/api/v1/swaps/quote", { method: "POST", key: i % 2 ? k1 : k2, body, ip: `198.51.100.${i}` })));
    codes.push(r.error!.code);
  }
  assert.deepEqual(codes.slice(0, SWAP_QUOTE_PER_MINUTE), Array(SWAP_QUOTE_PER_MINUTE).fill("same_asset"));
  assert.equal(codes.at(-1), "rate_limited", "the account's keys share one limit");
  // one IP, many accounts
  const ipCodes: string[] = [];
  for (let i = 0; i < SWAP_QUOTE_PER_MINUTE + 1; i++) {
    const other = await upsertPartner(privateKeyToAccount(generatePrivateKey()).address, { name: `Desk ${i}` });
    const k = (await createApiKey({ partnerId: other.id, name: "k", env: "live", pepper })).secret;
    ipCodes.push((await json(await quotePost(req("/api/v1/swaps/quote", { method: "POST", key: k, body, ip: "192.0.2.77" })))).error!.code);
  }
  assert.equal(ipCodes.at(-1), "rate_limited", "one IP is limited across accounts");
});

// ---------------------------------------------------------------- server quote

type Limits = Record<string, [bigint, bigint, bigint]>; // asset -> perDeposit, total, deposited
const BIG = 10n ** 30n;
function fakeClient(o: {
  limits?: Limits;
  fee?: number | "fail";
  dex?: "ok" | "fail";
  rate?: bigint; // out per 10_000 in
  /** A v4 pool's output by size, in place of `rate` (price impact). */
  outOf?: (amount: bigint) => bigint;
  gasPriceWei?: bigint;
  feed?: { answer: bigint; updatedAt: number } | "fail";
}): PublicClient {
  const limits = o.limits ?? {};
  const rate = o.rate ?? 9_999n;
  const limitOf = (a: string) => limits[a.toLowerCase()] ?? [BIG, BIG, 0n];
  const c = {
    async readContract(p: { functionName: string; args?: readonly unknown[] }) {
      switch (p.functionName) {
        case "withdrawFeeBps":
          if (o.fee === "fail") throw new Error("unread");
          return o.fee ?? 25;
        case "depositLimit": {
          const l = limitOf(String(p.args![0]));
          return [l[0], l[1]];
        }
        case "deposited":
          return limitOf(String(p.args![0]))[2];
        case "quoteSwapExactAmountIn":
          if (o.dex === "fail") throw new Error("HTTP request failed. URL: https://secret-rpc.example/key");
          return ((p.args![2] as bigint) * rate) / 10_000n;
        case "quoteSwapExactAmountOut":
          return ((p.args![2] as bigint) * 10_000n) / rate;
        case "latestRoundData": {
          if (o.feed === "fail" || !o.feed) throw new Error("no feed");
          return [1n, o.feed.answer, 0n, BigInt(o.feed.updatedAt), 1n];
        }
        default:
          throw new Error(`unexpected read ${p.functionName}`);
      }
    },
    async multicall(p: { allowFailure?: boolean; contracts: { functionName: string; args: readonly unknown[] }[] }) {
      const results = p.contracts.map((k) => {
        if (k.functionName === "allowedPool") return true;
        if (k.functionName === "quoteExactInput") {
          const amount = (k.args[0] as { exactAmount: bigint }).exactAmount;
          return [o.outOf ? o.outOf(amount) : (amount * rate) / 10_000n, 0n] as const;
        }
        throw new Error(`unexpected multicall ${k.functionName}`);
      });
      return p.allowFailure === false ? results : results.map((result) => ({ status: "success", result }));
    },
    async simulateContract(p: { functionName: string; args: readonly unknown[] }) {
      if (p.functionName !== "quoteExactOutput") throw new Error("unexpected simulate");
      const amount = (p.args[0] as { exactAmount: bigint }).exactAmount;
      return { result: [(amount * 10_000n) / rate + 1n, 0n] };
    },
    async getGasPrice() {
      return o.gasPriceWei ?? 1_000_000_000n;
    },
  };
  return c as unknown as PublicClient;
}
const relayOn = async () => ({ enabled: true, gasHigh: false });
const NOW = 1_800_000_000_000;

await test("quote: a clean quote on Tempo, JSON-safe, with no stop", async () => {
  const q = await quoteSwapServer(TEMPO, { assetIn: TEMPO_USDCE, assetOut: TEMPO_PATHUSD, amountIn: "100000000" }, { client: fakeClient({}), relay: relayOn, now: () => NOW });
  assert.equal(q.stop, null);
  assert.equal(q.feeBps, 25);
  assert.equal(q.available, "99750000");
  assert.equal(q.amountOut, ((((99_750_000n * 9_999n) / 10_000n) * 9_990n) / 10_000n).toString());
  assert.equal(q.routerVersion, vs.swapRouterFor(4217)!.version);
  assert.equal(q.valueChecked, false);
  assert.equal(q.public, SWAP_PUBLIC_LINE);
  assert.equal(q.quotedAt, NOW);
  assert.ok(BigInt(q.limits.maxIn!) > 0n);
  JSON.stringify(q); // no bigint anywhere
});

await test("quote: price impact past 2% stops a swap on Robinhood Chain too, as the SDK's quoteSwap does, unless asked otherwise", async () => {
  const thin = fakeClient({ outOf: (a) => (a > 10_000_000n ? a / 100n : a) });
  const ask = { assetIn: RH_USDG, assetOut: "0xDcD885F5c60b3aD49F6D58718696417314e8724d", amountIn: "1000000000" };
  const q = await quoteSwapServer(RH, ask, { client: thin, relay: relayOn, now: () => NOW });
  assert.equal(q.stop?.code, "too_thin", JSON.stringify(q.stop));
  assert.ok(q.amountOut !== null && q.impactBps! >= 9_800, "the price still shows");
  assert.deepEqual(q.stops, { maxImpactBps: 200, maxPegGapBps: 200 });
  const loose = await quoteSwapServer(RH, { ...ask, maxImpactBps: 10_000 }, { client: thin, relay: relayOn, now: () => NOW });
  assert.equal(loose.stop, null, "the swap tab's own behavior there, when asked for");
  await assert.rejects(quoteSwapServer(RH, { ...ask, maxImpactBps: 20_000 }, { client: thin }), (e: unknown) => e instanceof SwapQuoteError && e.code === "bad_request");
});

await test("quote: Tempo's dollar pairs are held to the peg", async () => {
  const q = await quoteSwapServer(TEMPO, { assetIn: TEMPO_USDCE, assetOut: TEMPO_PATHUSD, amountIn: "100000000" }, { client: fakeClient({ rate: 9_500n }), relay: relayOn, now: () => NOW });
  assert.equal(q.stop?.code, "off_peg");
});

await test("quote: a refund note the vault could not take back stops the swap, with the most one swap can spend", async () => {
  const limits: Limits = { [TEMPO_USDCE.toLowerCase()]: [50_000_000n, BIG, 0n] };
  const q = await quoteSwapServer(TEMPO, { assetIn: TEMPO_USDCE, assetOut: TEMPO_PATHUSD, amountIn: "100000000" }, { client: fakeClient({ limits }), relay: relayOn });
  assert.equal(q.stop?.code, "refund_wont_fit");
  const maxIn = BigInt(q.stop!.maxIn!);
  assert.ok(maxIn > 50_000_000n && maxIn < 51_000_000n, `maxIn ${maxIn}`);
  assert.ok(q.amountOut !== null, "the price still shows");
  const closed = await quoteSwapServer(
    TEMPO,
    { assetIn: TEMPO_USDCE, assetOut: TEMPO_PATHUSD, amountIn: "100000000" },
    { client: fakeClient({ limits: { [TEMPO_USDCE.toLowerCase()]: [0n, 0n, 0n] } }), relay: relayOn }
  );
  assert.equal(closed.stop?.code, "refund_wont_fit");
  assert.equal(closed.stop?.maxIn, "0");
});

await test("quote: an output the vault doesn't take, or has no room for, stops the swap", async () => {
  const closed = await quoteSwapServer(
    TEMPO,
    { assetIn: TEMPO_USDCE, assetOut: TEMPO_PATHUSD, amountIn: "100000000" },
    { client: fakeClient({ limits: { [TEMPO_PATHUSD.toLowerCase()]: [0n, 0n, 0n] } }), relay: relayOn }
  );
  assert.equal(closed.stop?.code, "vault_closed");
  const full = await quoteSwapServer(
    TEMPO,
    { assetIn: TEMPO_USDCE, assetOut: TEMPO_PATHUSD, amountIn: "100000000" },
    { client: fakeClient({ limits: { [TEMPO_PATHUSD.toLowerCase()]: [10_000_000n, BIG, 0n] } }), relay: relayOn }
  );
  assert.equal(full.stop?.code, "over_room");
  const fits = BigInt(full.stop!.fitsIn!);
  assert.ok(fits > 9_000_000n && fits < 10_000_000n, `fitsIn ${fits}`);
  assert.equal(full.limits.outRoom, "10000000");
});

await test("quote: the relay off or over its gas ceiling stops a relayed swap, not one sent from a wallet", async () => {
  const ask = { assetIn: TEMPO_USDCE, assetOut: TEMPO_PATHUSD, amountIn: "100000000" };
  const off = await quoteSwapServer(TEMPO, ask, { client: fakeClient({}), relay: async () => ({ enabled: false, gasHigh: false }) });
  assert.equal(off.stop?.code, "relay_off");
  const high = await quoteSwapServer(TEMPO, ask, { client: fakeClient({}), relay: async () => ({ enabled: true, gasHigh: true }) });
  assert.equal(high.stop?.code, "gas_high");
  const own = await quoteSwapServer(TEMPO, { ...ask, via: "wallet" }, { client: fakeClient({}), relay: async () => ({ enabled: false, gasHigh: true }) });
  assert.equal(own.stop, null);
  assert.equal(own.relay, null);
  const unread = await quoteSwapServer(TEMPO, ask, { client: fakeClient({}), relay: async () => null });
  assert.equal(unread.stop, null, "an unread relay status stops nothing; the relay decides");
});

await test("quote: planning failures come back as stops in plain words, never an RPC's", async () => {
  const ask = { assetIn: TEMPO_USDCE, assetOut: TEMPO_PATHUSD, amountIn: "100000000" };
  const failed = await quoteSwapServer(TEMPO, ask, { client: fakeClient({ dex: "fail" }), relay: relayOn });
  assert.equal(failed.stop?.code, "quote_failed");
  assert.ok(!failed.stop!.message.includes("secret-rpc"));
  assert.equal(failed.amountOut, null);
  const tiny = await quoteSwapServer(TEMPO, { ...ask, amountIn: "1" }, { client: fakeClient({}), relay: relayOn });
  assert.equal(tiny.stop?.code, "too_small");
  await assert.rejects(quoteSwapServer(TEMPO, ask, { client: fakeClient({ fee: "fail" }), relay: relayOn }), (e: unknown) => {
    assert.ok(e instanceof SwapQuoteError && e.code === "check_failed" && e.status === 503);
    return true;
  });
});

await test("quote: bad input and a network with no swaps are refused before any read", async () => {
  const noReads = {
    readContract: async () => assert.fail("no read"),
    multicall: async () => assert.fail("no read"),
    simulateContract: async () => assert.fail("no read"),
    getGasPrice: async () => assert.fail("no read"),
  } as unknown as PublicClient;
  const bad: [typeof RH, Record<string, unknown>, string][] = [
    [RH_TEST, { assetIn: RH_USDG, assetOut: TEMPO_USDCE, amountIn: "1" }, "no_swap"],
    [TEMPO, { assetIn: "0x12", assetOut: TEMPO_PATHUSD, amountIn: "1" }, "bad_request"],
    [TEMPO, { assetIn: TEMPO_USDCE, assetOut: TEMPO_PATHUSD, amountIn: "abc" }, "bad_request"],
    [TEMPO, { assetIn: TEMPO_USDCE, assetOut: TEMPO_PATHUSD, amountIn: "0" }, "bad_request"],
    [TEMPO, { assetIn: TEMPO_USDCE, assetOut: TEMPO_PATHUSD, amountIn: (1n << 128n).toString() }, "bad_request"],
    [TEMPO, { assetIn: TEMPO_USDCE, assetOut: TEMPO_PATHUSD, amountIn: -5 }, "bad_request"],
    [TEMPO, { assetIn: TEMPO_USDCE, assetOut: TEMPO_USDCE.toLowerCase(), amountIn: "1" }, "same_asset"],
    [TEMPO, { assetIn: TEMPO_USDCE, assetOut: RH_USDG, amountIn: "1" }, "swap_asset"],
    [TEMPO, { assetIn: TEMPO_USDCE, assetOut: TEMPO_PATHUSD, amountIn: "1", via: "teleport" }, "bad_request"],
  ];
  for (const [net, ask, code] of bad) {
    await assert.rejects(quoteSwapServer(net, ask as never, { client: noReads, relay: relayOn }), (e: unknown) => {
      assert.ok(e instanceof SwapQuoteError, String(e));
      assert.equal(e.code, code, JSON.stringify(ask));
      return true;
    });
  }
});

await test("quote: where gas is dear, a swap under the relay's floor stops, and an unread floor stops too", async () => {
  const ETH = getNetwork(NETWORK_KEYS.includes("ethereum-mainnet") ? "ethereum-mainnet" : "ethereum");
  const wasLive = vs.VAULT_SWAP_V3_LIVE[1];
  const wasRouter = vs.VAULT_SWAP_ROUTERS[1];
  // Ethereum's router as if its switch were on, for this test only.
  vs.VAULT_SWAP_V3_LIVE[1] = vs.VAULT_SWAP_V3_ADDRESS[1]!;
  vs.VAULT_SWAP_ROUTERS[1] = vs.VAULT_SWAP_V3_ADDRESS[1]!;
  try {
    const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as Address;
    const USDT = "0xdAC17F958D2ee523a2206206994597C13D831ec7" as Address;
    const feed = { answer: 3_000n * 10n ** 8n, updatedAt: Math.floor(NOW / 1000) - 60 };
    const ask = { assetIn: USDC, assetOut: USDT, amountIn: "100000000" };
    // 1 gwei, ETH at $3,000, a 0.25% fee: the relay's one-hop floor is $2,040, shown 10% above
    const small = await quoteSwapServer(ETH, ask, { client: fakeClient({ feed, gasPriceWei: 1_000_000_000n }), relay: relayOn, now: () => NOW });
    assert.equal(small.stop?.code, "swap_small");
    const floor = swapFloorShown(smallestSwapUsd({ gasPriceWei: 1_000_000_000n, ethUsd: 3_000, feeBps: 25, hops: 1 }));
    assert.ok(Math.abs(floor - 2_244) < 0.01, `floor ${floor}`);
    assert.equal(small.stop!.floorUsd, floor);
    assert.equal(small.stop!.message, swapFloorMessage(ETH.label, floor));
    assert.equal(small.deadlineSeconds, 600);
    const big = await quoteSwapServer(ETH, { ...ask, amountIn: "5000000000" }, { client: fakeClient({ feed, gasPriceWei: 1_000_000_000n }), relay: relayOn, now: () => NOW });
    assert.equal(big.stop, null, JSON.stringify(big.stop));
    assert.ok(big.floorUsd! > 2_000);
    const stale = await quoteSwapServer(ETH, { ...ask, amountIn: "5000000000" }, {
      client: fakeClient({ feed: { ...feed, updatedAt: Math.floor(NOW / 1000) - 3 * 3600 } }),
      relay: relayOn,
      now: () => NOW,
    });
    assert.equal(stale.stop?.code, "floor_unread");
    const own = await quoteSwapServer(ETH, { ...ask, via: "wallet" }, { client: fakeClient({ feed: "fail" }), relay: relayOn, now: () => NOW });
    assert.equal(own.stop, null, "a swap sent from a wallet has no relay floor");
  } finally {
    vs.VAULT_SWAP_V3_LIVE[1] = wasLive ?? null;
    vs.VAULT_SWAP_ROUTERS[1] = wasRouter ?? null;
  }
});

// ---------------------------------------------------------------- hosted MCP

const ctx = { origin: "https://www.gloam.trade", ip: "203.0.113.9" };
async function tool(name: string, args: Record<string, unknown>) {
  const r = await callTool(name, args, ctx);
  return { isError: Boolean(r.isError), text: (r.content[0] as { text: string }).text };
}

await test("hosted MCP: gloam_swap_quote is listed, read only, and named in gloam_info", async () => {
  const t = TOOLS.find((x) => x.name === "gloam_swap_quote");
  assert.ok(t);
  assert.deepEqual((t!.inputSchema as { required?: string[] }).required, ["from", "to", "amount"]);
  assert.equal(t!.annotations?.readOnlyHint, true);
  assert.match(t!.description ?? "", /never builds or sends a swap/);
  assert.match(t!.description ?? "", /tokens and amounts are public/);
  const info = await tool("gloam_info", {});
  assert.match(info.text, /gloam_swap_quote/);
  assert.doesNotMatch(info.text, /this server does not swap/);
  assert.doesNotMatch(info.text.toLowerCase(), /anonymous|untraceable|fully audited/);
});

await test("hosted MCP: off the swap networks and on bad arguments, refused before any read", async () => {
  const off = await tool("gloam_swap_quote", { network: "robinhood", from: "USDG", to: "ETH", amount: "10" });
  assert.equal(off.isError, true);
  assert.match(off.text, /not live on/);
  const unknown = await tool("gloam_swap_quote", { network: "robinhood-mainnet", from: "DOGE", to: "USDG", amount: "10" });
  assert.equal(unknown.isError, true);
  assert.match(unknown.text, /goes between: .*USDG/);
  const same = await tool("gloam_swap_quote", { network: "robinhood-mainnet", from: "usdg", to: RH_USDG, amount: "10" });
  assert.match(same.text, /two different assets/);
  const amount = await tool("gloam_swap_quote", { network: "robinhood-mainnet", from: "USDG", to: "GLOAM", amount: "ten" });
  assert.match(amount.text, /plain number of USDG/);
  const places = await tool("gloam_swap_quote", { network: "robinhood-mainnet", from: "USDG", to: "GLOAM", amount: "1.0000001" });
  assert.match(places.text, /6 decimal places/);
  const missing = await tool("gloam_swap_quote", { network: "robinhood-mainnet", from: "USDG" });
  assert.match(missing.text, /from, to and amount/);
});

await test("hosted MCP: secret screening runs before the swap quote", async () => {
  const r = await tool("gloam_swap_quote", { network: "robinhood-mainnet", from: "USDG", to: "ETH", amount: "10", note: `0x${"ab".repeat(32)}` });
  assert.equal(r.isError, true);
  assert.match(r.text, /^Stopped\. What you sent looks like a private key/);
});

console.log(`\n${passed} passed`);
process.exit(0);
