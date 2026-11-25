/**
 * Self-test: ZEC from a Zcash wallet into a private balance on Solana, through
 * NEAR Intents' 1Click API (lib/solanaRings/zcashIn, lib/zcashAddress,
 * /api/bridge/solana-zcash, and the bring-in flow it reuses).
 *
 *  - addresses: a refund goes to a mainnet transparent address (t1 or t3) with
 *    its checksum right; shielded, unified, TEX, testnet and broken ones are
 *    refused, each with words that say why;
 *  - what is asked of 1Click: ZEC on Zcash in, ZEC on Solana (the mint Gloam
 *    lists) out to the private account's own address, exact input, refunds on
 *    Zcash, a two-hour deadline;
 *  - the recorded answers (scripts/fixtures/oneclick-zec-to-solana-2026-11-25.json,
 *    taken live with no key and no funds, the deposit address made up): the
 *    real quote and the dry one read into what the panel shows, and every way
 *    an answer is refused (another route, another amount, another recipient or
 *    refund, a deposit address that isn't transparent, a memo, more out than
 *    in, too little to make private, outside the dollar limits);
 *  - 1Click's refusals in plain words, and its status words, the recorded
 *    pending one and the rest made from it;
 *  - the flow: a NEAR Intents transfer kept and read back, less than asked
 *    said and cleared, who returns a refund named, the send-by hour;
 *  - the route with 1Click faked: what it sends (the key only when set), a
 *    price with a stand-in refund address and no deposit address, both ends
 *    screened, every refusal; the status check;
 *  - the copy: what is public said plainly, nothing claimed hidden on Solana
 *    beyond the token and amount.
 *
 * No network. Run from app/:  ../mcp/node_modules/.bin/tsx scripts/selftest-solana-zcash-in.mts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Module from "node:module";
import { fileURLToPath } from "node:url";

const stub = fileURLToPath(new URL("./server-only-stub.cjs", import.meta.url));
const M = Module as unknown as { _resolveFilename: (req: string, ...rest: unknown[]) => string };
const resolve = M._resolveFilename;
M._resolveFilename = function (req: string, ...rest: unknown[]) {
  return req === "server-only" ? stub : resolve.call(this, req, ...rest);
};

const env = process.env as Record<string, string | undefined>;
env.NEXT_PUBLIC_SOLANA_RINGS_ENABLED = "1";
env.NEXT_PUBLIC_SOLANA_RINGS_NETWORK = "mainnet";
env.NEXT_PUBLIC_SOLANA_BRIDGE_IN = "1";
env.NEXT_PUBLIC_SOLANA_ZCASH_IN = "1";
delete env.CHAINALYSIS_API_KEY;
delete env.NEAR_INTENTS_API_KEY;

const addr = await import("../src/lib/zcashAddress");
const zc = await import("../src/lib/solanaRings/zcashIn");
const bridgeIn = await import("../src/lib/solanaRings/bridgeIn");
const config = await import("../src/lib/solanaRings/config");
const { ringsAmountText } = await import("../src/lib/solanaRings/amount");
const ofac = (await import("../src/lib/solanaRings/ofacSolana.json", { with: { type: "json" } })).default;
type Fixture = {
  quote: Record<string, unknown> & { quote: Record<string, unknown>; quoteRequest: Record<string, unknown> };
  dryQuote: Record<string, unknown> & { quote: Record<string, unknown>; quoteRequest: Record<string, unknown> };
  statusPending: Record<string, unknown> & { swapDetails: Record<string, unknown> };
  refusals: Record<"tooLow" | "refundSapling" | "refundUnified", { status: number; body: { message: string } }>;
};
const fx = JSON.parse(readFileSync(new URL("./fixtures/oneclick-zec-to-solana-2026-11-25.json", import.meta.url), "utf8")) as Fixture;

let n = 0;
const ok = (cond: unknown, msg: string) => {
  assert.ok(cond, msg);
  n++;
};
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

// Made-up addresses with right checksums (scripts/fixtures note): nobody's.
const DEPOSIT = "t1S7M4S3woybcUVs6wvsXid2FmbsUZrwNUK";
const REFUND = "t1Lz5sUzNoMBWmq8qk1zS4q5A54RgF5e4Ua";
const T3 = "t3PELj6mSGGCMT6NkGQkBTTvD8HLBsnvXZ4";
const RECIPIENT = String(fx.quote.quoteRequest.recipient);

// ---------------------------------------------------------------- addresses

{
  const { validZcashTransparent: v, zcashRefundProblem: why } = addr;
  ok(v(zc.ZCASH_PREVIEW_REFUND) && v(DEPOSIT) && v(REFUND) && v(T3), "t1 and t3 mainnet addresses with right checksums are taken");
  ok(!v(REFUND.slice(0, -1) + (REFUND.endsWith("a") ? "b" : "a")), "one character changed: the checksum fails");
  ok(!v("tmCpqCKUnC1h1v5LHQkJAvVjug3WVePS7t7") && /testnet/.test(why("tmCpqCKUnC1h1v5LHQkJAvVjug3WVePS7t7") ?? ""), "a testnet address is refused, said as testnet");
  const sapling = "zs1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqpq6d8g";
  ok(!v(sapling) && /shielded or unified/.test(why(sapling) ?? ""), "a shielded (zs) address is refused, and why");
  ok(!v("u1abcdefghij") && /shielded or unified/.test(why("u1abcdefghij") ?? ""), "a unified (u1) address is refused, and why");
  ok(!v("tex1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq3xvlx7") && /TEX/.test(why("tex1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq3xvlx7") ?? ""), "a TEX address is left out");
  ok(!v("1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa") && !v(RECIPIENT) && !v("") && !v("t1 Lz5sUzNoMBWmq8qk1zS4q5A54RgF5e4Ua"), "Bitcoin, Solana, empty and spaced strings aren't Zcash addresses");
  ok(why("") === null && why(` ${REFUND} `) === null && /t1 or t3/.test(why("t1nope") ?? ""), "nothing typed or a good one: no problem; anything else: check it");
}

// ---------------------------------------------------------------- what is asked of 1Click

const NOW = Date.UTC(2026, 10, 25, 13, 35, 0);
{
  const r = zc.zcashQuoteRequest({ amount: 10_000_000n, recipient: RECIPIENT, refundTo: REFUND, dry: false, now: NOW });
  ok(r.originAsset === "nep141:zec.omft.near" && r.destinationAsset === `1cs_v1:sol:spl:${config.ZEC_SOLANA_MINT}`, "ZEC on Zcash in, ZEC on Solana out (the Omni Bridge mint Gloam lists)");
  ok(r.destinationAsset === fx.quote.quoteRequest.destinationAsset && r.originAsset === fx.quote.quoteRequest.originAsset, "the same asset ids 1Click quoted live");
  ok(r.swapType === "EXACT_INPUT" && r.depositType === "ORIGIN_CHAIN" && r.recipientType === "DESTINATION_CHAIN" && r.refundType === "ORIGIN_CHAIN", "exact input, a deposit on Zcash, delivered on Solana, refunds on Zcash");
  ok(r.recipient === RECIPIENT && r.refundTo === REFUND && r.amount === "10000000" && !r.dry && r.depositMode === "SIMPLE", "to the private account, refunds to the address given, the amount in base units");
  ok(Date.parse(r.deadline) - NOW === 2 * 60 * 60 * 1000 && r.slippageTolerance === 100, "a two-hour deadline, 1% room");
}

// ---------------------------------------------------------------- the recorded answers

const askedReal: import("../src/lib/solanaRings/zcashIn").ZcashQuoteRequest = {
  ...zc.zcashQuoteRequest({ amount: 10_000_000n, recipient: RECIPIENT, refundTo: String(fx.quote.quoteRequest.refundTo), dry: false, now: Date.parse(String(fx.quote.quoteRequest.deadline)) - zc.ZCASH_DEADLINE_MS }),
};
const askedDry = { ...askedReal, dry: true, refundTo: String(fx.dryQuote.quoteRequest.refundTo), recipient: String(fx.dryQuote.quoteRequest.recipient) };
{
  const r = zc.parseZcashQuote(fx.quote, askedReal);
  ok(r.ok, "the recorded real quote reads");
  const q = r.ok ? r.quote : null!;
  ok(q.via === "near" && q.depositAddress === DEPOSIT && q.evmTxs === null, "a NEAR Intents transfer to a transparent deposit address, nothing to sign");
  ok(q.send.amount === "0.1" && q.send.symbol === "ZEC" && q.send.chain === "Zcash" && q.send.usd === 69.98, "send exactly 0.1 ZEC on Zcash, about $69.98");
  ok(q.receive.amount === "0.09974272" && q.receive.minimum === "0.09874529" && q.receive.assetId === "zec" && q.receive.decimals === 8, "about 0.09974272 ZEC lands, at least 0.09874529");
  ok(q.feeUsd === 0.18 && q.appFee === null && q.timeSec === 452, "the fee as 1Click prices it (in less out), Gloam takes none, the time it gave");
  ok(q.requestId === fx.quote.correlationId && q.refundTo === askedReal.refundTo, "its correlation id kept for support, the refund address said back");
  ok(q.near?.signature === fx.quote.signature && q.near?.addressUntil === "2026-11-28T16:35:04.000Z" && q.near?.refundFee === "0.00032", "1Click's signature, the address's end and its refund fee kept with the quote");
  ok(q.near!.sendBy === Date.parse(String(fx.quote.quoteRequest.deadline)) - 60 * 60 * 1000, "sent by an hour before the deadline, leaving an hour for Zcash to confirm");
  ok(ringsAmountText(q.receive.amount, 8) === "0.0997" && ringsAmountText("19.842157", 6) === "19.84", "ZEC shows four places, everything else two");

  const d = zc.parseZcashQuote(fx.dryQuote, askedDry);
  ok(d.ok && d.quote.depositAddress === "" && d.quote.refundTo === "" && d.quote.near === undefined && d.quote.receive.amount === "0.09974272", "the dry quote: a price, no deposit address, no refund address said back");

  const bad = (what: string, edit: (f: Fixture["quote"]) => void, status = 502, asked = askedReal) => {
    const f = clone(fx.quote);
    edit(f);
    const res = zc.parseZcashQuote(f, asked);
    ok(!res.ok && res.status === status, `refused: ${what}`);
    return res;
  };
  bad("another destination asset", (f) => void (f.quoteRequest.destinationAsset = "nep141:zec.omft.near"));
  bad("another origin asset", (f) => void (f.quoteRequest.originAsset = "nep141:btc.omft.near"));
  bad("another recipient", (f) => void (f.quoteRequest.recipient = "11111111111111111111111111111111"));
  bad("another refund address", (f) => void (f.quoteRequest.refundTo = REFUND));
  bad("a dry answer to a real ask", (f) => void (f.quoteRequest.dry = true));
  bad("another amount in", (f) => void (f.quote.amountIn = "10000001"));
  bad("more out than in", (f) => void (f.quote.amountOut = "10000001"));
  bad("a minimum over the amount", (f) => void (f.quote.minAmountOut = "9974273"));
  bad("a deposit address that isn't transparent", (f) => void (f.quote.depositAddress = RECIPIENT));
  bad("no deposit address", (f) => void delete f.quote.depositAddress);
  bad("a deposit memo", (f) => void (f.quote.depositMemo = "123"));
  bad("no signature", (f) => void delete f.signature);
  bad("a bad correlation id", (f) => void (f.correlationId = "<script>"));
  bad("an amount that isn't base units", (f) => void (f.quote.amountOut = "0.0997"));
  const tiny = bad("under what the relay makes private", (f) => {
    f.quote.amountOut = "99999";
    f.quote.minAmountOut = "99000";
  }, 400);
  ok(!tiny.ok && /under 0\.001 ZEC/.test(tiny.message), "too little to make private: says the floor");
  const cheap = bad("under a dollar", (f) => void (f.quote.amountInUsd = "0.50"), 400);
  ok(!cheap.ok && /\$0\.50, under the \$1 minimum/.test(cheap.message), "under a dollar: says how much and the minimum");
  const big = bad("over the limit", (f) => void (f.quote.amountInUsd = "25000.01"), 400);
  ok(!big.ok && /at most \$25,000/.test(big.message), "over $25,000: says the most");
  ok(!zc.parseZcashQuote(null, askedReal).ok && !zc.parseZcashQuote({ quote: {} }, askedReal).ok && !zc.parseZcashQuote([], askedReal).ok, "nothing, half an answer or a list: refused");
}

// ---------------------------------------------------------------- refusals and status words

{
  ok(zc.zcashRefusal(fx.refusals.tooLow.body.message) === "That's under NEAR Intents' minimum from Zcash. Send at least 0.00132 ZEC.", "under 1Click's minimum: says the exact least, never rounded down");
  ok(/transparent one, starting with t1 or t3/.test(zc.zcashRefusal(fx.refusals.refundSapling.body.message) ?? "") && zc.zcashRefusal(fx.refusals.refundUnified.body.message) === zc.zcashRefusal(fx.refusals.refundSapling.body.message), "a refund address 1Click won't take: asks for a transparent one");
  ok(/minimum of \$1,000/.test(zc.zcashRefusal("Temporary swap limits: minimum swap amount is $1,000") ?? "") && /no route/.test(zc.zcashRefusal("No quotes found") ?? ""), "its other limits and no route, in words");
  ok(zc.zcashRefusal("Internal server error") === null, "no reason worth naming: the caller says try again");

  const st = zc.parseZcashStatus(fx.statusPending, DEPOSIT);
  ok(st?.stage === "waiting" && st.outTx === null && st.short === null, "the recorded pending status: waiting, nothing out yet");
  ok(zc.parseZcashStatus(fx.statusPending, REFUND) === null, "a status about another deposit address is no answer");
  const as = (status: string, edit: (f: Fixture["statusPending"]) => void = () => {}) => {
    const f = clone(fx.statusPending);
    f.status = status;
    edit(f);
    return zc.parseZcashStatus(f, DEPOSIT);
  };
  ok(as("KNOWN_DEPOSIT_TX")?.stage === "moving" && as("PROCESSING")?.stage === "moving", "seen on Zcash, or being processed: on its way");
  const sig = "5".repeat(87);
  ok(as("SUCCESS", (f) => void (f.swapDetails.destinationChainTxHashes = [{ hash: sig, explorerUrl: "" }]))?.outTx === sig && as("SUCCESS")?.stage === "done", "delivered: done, with the Solana signature");
  ok(as("REFUNDED")?.stage === "refunded" && as("FAILED")?.stage === "failed", "refunded and failed");
  const short = as("INCOMPLETE_DEPOSIT", (f) => void (f.swapDetails.depositedAmount = "5000000"));
  ok(short?.stage === "waiting" && short.short === "0.05", "less than asked arrived: still waiting, with how much");
  ok(as("SOMETHING_NEW") === null && zc.zcashStage("") === null, "an unknown word is no answer");
  ok(as("SUCCESS", (f) => void ((f.quoteResponse as { quoteRequest: Record<string, unknown> }).quoteRequest.destinationAsset = "nep141:wrap.near")) === null, "a status for another destination is no answer");
}

// ---------------------------------------------------------------- the flow

{
  const parsed = zc.parseZcashQuote(fx.quote, askedReal);
  const quote = parsed.ok ? parsed.quote : null!;
  const t = bridgeIn.trackedFrom(quote, "address", NOW, { baseline: 7n });
  ok(t.via === "near" && t.near?.signature === quote.near?.signature && t.depositAddress === DEPOSIT && t.baseline === "7", "the transfer is kept with who carries it and its terms");
  const relayT = bridgeIn.trackedFrom({ ...quote, via: undefined, near: undefined, requestId: `0x${"ab".repeat(32)}`, depositAddress: "0x4f7c92be9f4d36b71f35b602664e2a86785ce0ec" }, "address", NOW);
  ok(!("via" in relayT) && !("near" in relayT), "a Relay transfer is kept as before");

  const mem = new Map<string, string>();
  const store = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) };
  const key = bridgeIn.trackedKey("mainnet", RECIPIENT);
  bridgeIn.saveTracked(store, key, t);
  const back = bridgeIn.loadTracked(store, key);
  ok(back?.via === "near" && back.requestId === quote.requestId && back.near?.sendBy === quote.near?.sendBy, "read back after a reload, with its correlation id");
  ok(!mem.get(key)!.includes(RECIPIENT), "the private account's address isn't kept");
  store.setItem(key, JSON.stringify({ ...t, depositAddress: RECIPIENT }));
  ok(bridgeIn.loadTracked(store, key) === null, "a NEAR Intents transfer whose address isn't transparent is no transfer");
  store.setItem(key, JSON.stringify({ ...t, mode: "wallet" }));
  ok(bridgeIn.loadTracked(store, key) === null, "nor one paid by a wallet (there is no such thing)");
  store.setItem(key, JSON.stringify({ ...t, via: "other" }));
  ok(bridgeIn.loadTracked(store, key) === null, "an unknown carrier is no transfer");
  store.setItem(key, JSON.stringify({ ...t, via: undefined }));
  ok(bridgeIn.loadTracked(store, key) === null, "without its mark, a correlation id isn't Relay's id: no transfer");

  ok(bridgeIn.providerName(t) === "NEAR Intents" && bridgeIn.providerName(relayT) === "Relay", "who returns a refund is named");
  ok(bridgeIn.refundPlace(t) === "your Zcash address", "and where it goes back to");

  const R = bridgeIn.flowReducer;
  type F = import("../src/lib/solanaRings/bridgeIn").Flow;
  const run = (s: F, ...events: Parameters<typeof R>[1][]) => events.reduce(R, s);
  let s = run(bridgeIn.FORM, { type: "quoting" }, { type: "track", t });
  ok(s.kind === "track" && bridgeIn.watchingRelay(s) && bridgeIn.watchingArrivals(s) && !s.short, "an address shown: following NEAR Intents and the account");
  s = run(s, { type: "status", stage: "waiting", short: "0.05" });
  ok(s.kind === "track" && s.short === "0.05" && bridgeIn.trackPhase(s) === "waiting", "less than asked: still waiting, how much arrived kept");
  s = run(s, { type: "status", stage: "waiting", short: null });
  ok(s.kind === "track" && !s.short, "the rest arrived: no longer short");
  s = run(s, { type: "status", stage: "waiting", short: "0.05" }, { type: "status", stage: "moving", short: "0.05" });
  ok(s.kind === "track" && s.relay === "moving" && !s.short, "on its way: short no longer said");
  s = run(s, { type: "status", stage: "done" }, { type: "arrived", amount: 9_974_272n });
  ok(s.kind === "track" && s.shield.kind === "arrived" && s.shield.amount === 9_974_272n, "delivered and at the account: made private the same way as any arrival");
  s = run(s, { type: "shielding" }, { type: "shielded", amount: 9_974_272n, signature: "sig" });
  ok(s.kind === "landed" && s.t.via === "near", "private: done");
  s = run(bridgeIn.FORM, { type: "track", t }, { type: "arrived", amount: 7n });
  ok(s.kind === "track" && s.shield.kind === "idle", "what was waiting before it isn't taken for it");
}

// ---------------------------------------------------------------- the form's rules, the code, remembered refunds

{
  const b = (o: Partial<Parameters<typeof zc.zcashButton>[0]>) => zc.zcashButton({ busy: false, onMainnet: true, zecReady: true, amount: "0.1", refund: REFUND, ...o });
  ok(b({}).ready && b({}).label === "Get a deposit address", "an amount and a transparent address: get a deposit address");
  ok(b({ busy: true }).label === "Getting an address…" && !b({ onMainnet: false }).ready && /mainnet only/.test(b({ onMainnet: false }).label), "busy, and not on mainnet: said");
  ok(b({ zecReady: false }).label === "ZEC isn't set up on Gloam yet", "ZEC not set up: said");
  ok(b({ amount: "" }).label === "Enter an amount" && b({ amount: "0" }).label === "Enter an amount" && b({ amount: "1,5" }).label === "Check the amount", "no amount, zero, or not a plain number");
  ok(b({ amount: "0.123456789" }).label === "Check the amount", "more than 8 places: check the amount");
  ok(b({ refund: "" }).label === "Enter your Zcash address" && b({ refund: "zs1abc" }).label === "Check your Zcash address" && b({ refund: T3 }).ready, "no refund address, a shielded one, or a t3 one");

  const t = { depositAddress: DEPOSIT, send: { amount: "0.1" } } as Parameters<typeof zc.zcashPaymentUri>[0];
  ok(zc.zcashPaymentUri(t) === `zcash:${DEPOSIT}?amount=0.1`, "the code is a ZIP 321 request: the address and the exact amount");

  const mem = new Map<string, string>();
  const store = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
  const key = zc.zcashRefundKey("mainnet", RECIPIENT);
  zc.saveZcashRefund(store, key, "zs1nope");
  ok(zc.loadZcashRefund(store, key) === "", "an address that won't do isn't remembered");
  zc.saveZcashRefund(store, key, REFUND);
  ok(zc.loadZcashRefund(store, key) === REFUND && zc.loadZcashRefund(store, zc.zcashRefundKey("mainnet", "other")) === "", "the refund address is remembered per private account");
  mem.set(key, "t1broken");
  ok(zc.loadZcashRefund(store, key) === "" && zc.loadZcashRefund({ getItem: () => { throw new Error("blocked"); }, setItem() {} }, key) === "", "a damaged or blocked entry reads as none");
  ok(zc.zcashArrives(452) === "About 8 min after Zcash confirms it" && zc.zcashArrives(10) === "About 1 min after Zcash confirms it", "when it lands, from 1Click's estimate");
  ok(/\d{2}.\d{2}/.test(zc.sendByText(Date.UTC(2026, 10, 25, 14, 35))), "the send-by hour, in the person's time");
}

// ---------------------------------------------------------------- the route, 1Click faked

const realFetch = globalThis.fetch;
{
  const calls: { url: string; headers: Record<string, string>; body: Record<string, unknown> | null }[] = [];
  let reply: (url: string, body: Record<string, unknown> | null) => { status: number; body: unknown } = () => ({ status: 500, body: {} });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith(zc.ONECLICK_API)) return realFetch(input, init);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    calls.push({ url, headers: Object.fromEntries(new Headers(init?.headers).entries()), body });
    const r = reply(url, body);
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  // 1Click as recorded, answering whatever was asked (its request echoed back, as it does).
  const recorded = (url: string, body: Record<string, unknown> | null) => {
    if (url.includes("/v0/status")) return { status: 200, body: fx.statusPending };
    const f = clone(body?.dry ? fx.dryQuote : fx.quote);
    f.quoteRequest = { ...f.quoteRequest, ...body };
    return { status: 200, body: f };
  };
  reply = recorded;

  const route = await import("../src/app/api/bridge/solana-zcash/route");
  let ip = 10;
  const post = (body: Record<string, unknown>) =>
    route.POST(new Request("http://localhost/api/bridge/solana-zcash", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": `198.51.100.${ip++}` }, body: JSON.stringify(body) }));
  const get = (q: string) => route.GET(new Request(`http://localhost/api/bridge/solana-zcash?${q}`, { headers: { "x-forwarded-for": `198.51.100.${ip++}` } }));
  type J = { ok: boolean; data?: import("../src/lib/solanaRings/bridgeIn").SolanaBridgeQuote & { stage?: string; short?: string | null }; error?: { message: string } };

  const base = { amount: "0.1", recipient: RECIPIENT, refundTo: REFUND };
  let res: Response = await post(base);
  let json = (await res.json()) as J;
  const asked = calls.at(-1)!;
  ok(res.status === 200 && json.ok && json.data?.via === "near" && json.data.depositAddress === DEPOSIT && json.data.receive.amount === "0.09974272", "a deposit address on Zcash, with what lands on Solana");
  ok(
    asked.url === `${zc.ONECLICK_API}/v0/quote` && asked.body?.dry === false && asked.body.recipient === RECIPIENT && asked.body.refundTo === REFUND && asked.body.amount === "10000000" && asked.body.destinationAsset === zc.ZEC_SOLANA_ASSET,
    "it asks 1Click for exactly that: 0.1 ZEC to the private account, refunds to the address given"
  );
  ok(!("x-api-key" in asked.headers) && !("authorization" in asked.headers), "no key set: none sent");

  env.NEAR_INTENTS_API_KEY = "selftest-partner-jwt";
  await post(base);
  ok(calls.at(-1)!.headers["x-api-key"] === "selftest-partner-jwt", "a partner key, when set, goes as X-API-Key (server side only)");
  delete env.NEAR_INTENTS_API_KEY;

  res = await post({ amount: "0.1", recipient: RECIPIENT, preview: true });
  json = (await res.json()) as J;
  ok(res.status === 200 && json.data?.depositAddress === "" && json.data.refundTo === "" && calls.at(-1)!.body?.dry === true && calls.at(-1)!.body?.refundTo === zc.ZCASH_PREVIEW_REFUND, "a price: dry, the stand-in refund address, no deposit address back");
  res = await post({ ...base, preview: true });
  ok(res.status === 200 && calls.at(-1)!.body?.refundTo === REFUND, "a price with a typed refund address uses it");

  // 1Click answers another route: refused, never shown.
  reply = (url, body) => {
    const r = recorded(url, body);
    (r.body as Fixture["quote"]).quoteRequest.destinationAsset = "nep141:zec.omft.near";
    return r;
  };
  res = await post(base);
  ok(res.status === 502, "an answer for another route is refused");
  reply = recorded;

  // 1Click says no: in words, logged without addresses or the amount.
  {
    const warned: unknown[][] = [];
    const warn = console.warn;
    console.warn = (...args: unknown[]) => void warned.push(args);
    reply = () => fx.refusals.tooLow;
    res = await post({ ...base, amount: "0.0001" });
    json = (await res.json()) as J;
    ok(res.status === 400 && /at least 0\.00132 ZEC/.test(json.error?.message ?? ""), "under 1Click's minimum: says the least");
    reply = () => ({ status: 400, body: { message: `refundTo ${REFUND} is not valid` } });
    res = await post(base);
    json = (await res.json()) as J;
    const logged = JSON.stringify(warned);
    ok(res.status === 400 && /transparent one/.test(json.error?.message ?? "") && !logged.includes(REFUND) && !logged.includes(RECIPIENT) && /\[address\]/.test(logged), "a refused refund address: said; the log names no address");
    reply = () => ({ status: 500, body: { message: "Internal server error" } });
    res = await post(base);
    json = (await res.json()) as J;
    ok(res.status === 502 && /couldn't make a route right now/.test(json.error?.message ?? ""), "no reason given: try again");
    console.warn = warn;
    reply = recorded;
  }

  for (const [what, body, status, words] of [
    ["a recipient that isn't a Solana address", { ...base, recipient: REFUND }, 400, /private account on Solana/],
    ["a shielded refund address", { ...base, refundTo: "zs1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqpq6d8g" }, 400, /shielded or unified/],
    ["a testnet refund address", { ...base, refundTo: "tmCpqCKUnC1h1v5LHQkJAvVjug3WVePS7t7" }, 400, /testnet/],
    ["no refund address for a real one", { ...base, refundTo: "" }, 400, /t1 or t3/],
    ["more than 8 places", { ...base, amount: "0.123456789" }, 400, /8/],
    ["no amount", { ...base, amount: "0" }, 400, /Enter an amount/],
    ["not a number", { ...base, amount: "1e3" }, 400, /Enter an amount/],
    ["an OFAC-listed private account", { ...base, recipient: ofac.addresses[0] }, 403, /./],
  ] as [string, Record<string, unknown>, number, RegExp][]) {
    const before = calls.length;
    res = await post(body);
    json = (await res.json()) as J;
    ok(res.status === status && words.test(json.error?.message ?? "") && calls.length === before, `refused before asking 1Click: ${what} (${res.status})`);
  }

  // The status check.
  res = await get(`depositAddress=${DEPOSIT}`);
  json = (await res.json()) as J;
  ok(res.status === 200 && json.data?.stage === "waiting" && calls.at(-1)!.url === `${zc.ONECLICK_API}/v0/status?depositAddress=${DEPOSIT}`, "the status of a deposit address, from 1Click's status endpoint");
  res = await get(`depositAddress=${REFUND}`);
  ok(res.status === 502, "an answer about another address is refused");
  res = await get("depositAddress=0xabc");
  ok(res.status === 400, "an address that isn't a Zcash one isn't asked about");
  reply = () => ({ status: 404, body: { message: "Deposit address not found" } });
  res = await get(`depositAddress=${DEPOSIT}`);
  ok(res.status === 404, "not known yet: said, and the panel keeps waiting");
  reply = recorded;
  globalThis.fetch = realFetch;
}

// ---------------------------------------------------------------- the copy and the sheet

{
  const note = zc.ZCASH_IN_PRIVACY_NOTE;
  ok(/public/.test(note) && /transparent Zcash addresses/.test(note) && /token and amount stay hidden/.test(note) && /private account itself stays visible/.test(note), "what is public is said: the Zcash deposit and refund, the delivery, the private account");
  ok(!/(sender|recipient|who).{0,30}(hidden|private)/i.test(note) && !/anonymous|untraceable/i.test(note), "nothing claims who is hidden on Solana");
  const sheet = readFileSync(new URL("../src/components/app/SolanaBridgeIn.tsx", import.meta.url), "utf8");
  const lib = readFileSync(new URL("../src/lib/solanaRings/zcashIn.ts", import.meta.url), "utf8");
  const form = sheet.slice(sheet.indexOf("function ZcashForm("), sheet.indexOf("function Tracking("));
  ok(form.length > 1000 && !/\bbridged\b/i.test(form) && !/\bbridged\b/i.test(note), "\"bridged\" is no label in the Zcash form or its note");
  for (const [name, text] of [["sheet", sheet], ["zcashIn", lib]] as const) {
    ok(!/—/.test(text) && !/happy to/i.test(text), `no em dash and no stock phrases (${name})`);
  }
  ok(/zcashInVisible\(session\.network\) && ready\.zec === true/.test(sheet), "the sheet offers Zcash only with its flag on and ZEC set up");
  ok(/\/api\/bridge\/solana-zcash\?depositAddress=/.test(sheet) && /t\.via === "near"/.test(sheet), "a NEAR Intents transfer is followed through its own status route");
  ok(/zcashPaymentUri\(t\)/.test(sheet) && /qrText\(needsQr\)/.test(sheet), "the code holds the payment request, after a reload too");
  ok(/Send it by/.test(sheet) && /This deposit address has expired/.test(sheet), "the send-by hour, and an expired address is never shown to pay");
}

console.log(`selftest-solana-zcash-in: ${n} checks passed`);
