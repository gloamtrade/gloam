/**
 * Self-test: bringing money in to Starknet from Gloam's networks that Circle's
 * CCTP doesn't serve, through Relay to Base (lib/starknetPrivacy/cctpRelay,
 * cctpRelayServer, the route /api/starknet/cctp/relay and the browser's wait
 * for Relay). No request leaves the process: Relay's answers are fixtures,
 * real quotes for the exact body Gloam sends (fixtures/relay-cctp-quote-*.json,
 * Robinhood Chain USDG and Tempo USDC.e to 20 USDC on Base, 2026-11-27).
 *
 *  - the sources: Robinhood Chain and Tempo always, BNB Chain and Elysium with
 *    their flags; none of them is a CCTP source, and Base is the hop.
 *  - the two calls Relay's router runs on Base: approve TokenMessengerV2, then
 *    depositForBurn to domain 25, the Starknet account, Base USDC, anyone
 *    delivers, Circle's fee with its margin, fast.
 *  - the order's body: exactly that USDC on Base, those calls, refunds to the sender.
 *  - Relay's answer read (readRelayOrder): the real quotes pass; every way an
 *    answer could differ from what was asked is refused.
 *  - the route: what it refuses before asking Relay, and the quote it hands on.
 *  - the browser: the wait for Relay's fill on Base (filled, refunded, failed),
 *    a pending bring-in kept by its order until Relay names the transaction,
 *    and forgotten when Relay sends the money back.
 *
 * Run from app/:  ../mcp/node_modules/.bin/tsx scripts/selftest-starknet-cctp-relay.mts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Module from "node:module";
import { fileURLToPath } from "node:url";
import { decodeFunctionData, getAddress, parseAbi } from "viem";

const stub = fileURLToPath(new URL("./server-only-stub.cjs", import.meta.url));
const M = Module as unknown as { _resolveFilename: (req: string, ...rest: unknown[]) => string };
const resolve = M._resolveFilename;
M._resolveFilename = function (req: string, ...rest: unknown[]) {
  return req === "server-only" ? stub : resolve.call(this, req, ...rest);
};
const env = process.env as Record<string, string | undefined>;
for (const k of Object.keys(env)) if (k.startsWith("NEXT_PUBLIC_STARKNET_") || k.startsWith("STARKNET_") || k.startsWith("GLOAM_STARKNET_")) delete env[k];
delete env.UPSTASH_REDIS_REST_URL;
delete env.UPSTASH_REDIS_REST_TOKEN;
delete env.RELAY_API_KEY;
delete env.BRIDGE_FEE_BPS;
env.NEXT_PUBLIC_STARKNET_ENABLED = "1";
env.NEXT_PUBLIC_STARKNET_NETWORK = "mainnet";

const cctp = await import("../src/lib/starknetPrivacy/cctp");
const relay = await import("../src/lib/starknetPrivacy/cctpRelay");
const server = await import("../src/lib/starknetPrivacy/cctpRelayServer");
const client = await import("../src/lib/starknetPrivacy/cctpClient");
const { BNB } = await import("../src/lib/bnb");
const { ELYSIUM } = await import("../src/lib/elysium");

let pass = 0;
const ok = (c: unknown, msg: string) => {
  assert.ok(c, msg);
  pass++;
};
const eq = <T,>(a: T, b: T, msg: string) => {
  assert.deepEqual(a, b, msg);
  pass++;
};
const rejects = async (p: Promise<unknown>, re: RegExp, msg: string) => {
  await assert.rejects(p, re, msg);
  pass++;
};

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")) as Record<string, unknown>;
const RH_QUOTE = fixture("relay-cctp-quote-rh.json");
const TEMPO_QUOTE = fixture("relay-cctp-quote-tempo.json");
const ACCOUNT = "0x0444444444444444444444444444444444444444444444444444444444444444";
const SENDER = "0x1212121212121212121212121212121212121212";
const BASE_USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const RH = relay.relaySource(4663)!;
const TEMPO = relay.relaySource(4217)!;
const input = (over: Partial<Parameters<typeof server.readRelayOrder>[1]> = {}) => ({ source: RH, token: RH.tokens[0]!, amount: 20_000_000n, account: ACCOUNT, sender: SENDER, bps: 1.3, ...over });
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

/* ------------------------------------------------------------------ the sources and the hop */
{
  eq(relay.RELAY_SOURCES.slice(0, 2).map((s) => [s.chainId, s.name, s.tokens.map((t) => t.symbol)]), [[4663, "Robinhood Chain", ["USDG"]], [4217, "Tempo", ["USDC.e"]]], "Robinhood Chain and Tempo");
  eq(Boolean(relay.relaySource(56)), Boolean(BNB), "BNB Chain while its flag is on");
  eq(Boolean(ELYSIUM && relay.relaySource(ELYSIUM.chainId)), Boolean(ELYSIUM), "Elysium while its flag is on");
  ok(relay.RELAY_SOURCES.every((s) => !cctp.cctpSourceByChain(s.chainId)), "none of them is a CCTP source");
  eq([relay.RELAY_HOP.name, relay.RELAY_HOP.domain, relay.RELAY_HOP.fast], ["Base", 6, true], "the hop is Base, fast");
  const [approve, burn] = relay.relayHopCalls({ account: ACCOUNT, amount: 20_000_000n, bps: 1.3 });
  const abi = parseAbi(["function approve(address,uint256)", "function depositForBurn(uint256,uint32,bytes32,address,bytes32,uint256,uint32)"]);
  eq(approve!.to, BASE_USDC, "approve on Base USDC");
  eq(decodeFunctionData({ abi, data: approve!.data }).args, ["0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d", 20_000_000n], "approve TokenMessengerV2 for exactly the amount");
  eq(burn!.to, cctp.EVM_TOKEN_MESSENGER_V2.toLowerCase(), "the burn goes to TokenMessengerV2");
  eq(
    [...decodeFunctionData({ abi, data: burn!.data }).args] as unknown[],
    [20_000_000n, 25, cctp.starknetToBytes32(ACCOUNT), getAddress(BASE_USDC), cctp.ZERO_BYTES32, cctp.burnMaxFee(20_000_000n, 1.3, true), 1000],
    "depositForBurn: to Starknet, the account, Base USDC, anyone delivers, Circle's fee with margin, fast"
  );
  assert.throws(() => relay.relayHopCalls({ account: ACCOUNT, amount: 0n, bps: 1 }));
  assert.throws(() => relay.relayHopCalls({ account: "0x0", amount: 1n, bps: 1 }));
  pass += 2;
}

/* ------------------------------------------------------------------ the order's body */
{
  const b = server.relayOrderBody(input(), {}) as Record<string, unknown>;
  eq([b.user, b.recipient, b.refundTo], [SENDER, SENDER, SENDER], "the sender pays and gets any refund");
  eq([b.originChainId, b.destinationChainId, b.originCurrency, b.destinationCurrency, b.amount, b.tradeType, b.useDepositAddress], [4663, 8453, RH.tokens[0]!.address, BASE_USDC, "20000000", "EXACT_OUTPUT", false], "exactly 20 USDC on Base, from USDG, signed from the wallet");
  eq(b.txs, relay.relayHopCalls({ account: ACCOUNT, amount: 20_000_000n, bps: 1.3 }).map((c) => ({ to: c.to, value: "0", data: c.data })), "the two calls on arrival");
  eq(b.appFees, undefined, "no Gloam cut unless BRIDGE_FEE_BPS is set");
  eq(b.referrer, undefined, "no referrer without an API key");
}

/* ------------------------------------------------------------------ Relay's answer */
{
  const rh = server.readRelayOrder(RH_QUOTE, input());
  ok(rh.ok, `the real Robinhood Chain quote passes${rh.ok ? "" : `: ${rh.reason}`}`);
  if (rh.ok) {
    eq(rh.quote.requestId, "0x17957547681a371cbcaff072b3775a209281e6f663aeadc653a155b5d3e2caa4", "its order");
    eq(rh.quote.txs.map((t) => [t.chainId, t.data.slice(0, 10), t.value]), [[4663, "0x095ea7b3", "0"], [4663, "0xe8017952", "0"]], "approve USDG, then Relay's deposit, on Robinhood Chain");
    eq([rh.quote.pay, rh.quote.symbol, rh.quote.amount, rh.quote.relayUsd], ["20.032776", "USDG", "20000000", 0.03], "pays 20.03 USDG for 20 USDC on Base; Relay's fee about $0.03");
  }
  const tempo = server.readRelayOrder(TEMPO_QUOTE, input({ source: TEMPO, token: TEMPO.tokens[0]! }));
  ok(tempo.ok, `the real Tempo quote passes${tempo.ok ? "" : `: ${tempo.reason}`}`);
  const no = (q: unknown, reason: string, msg: string, over: Partial<Parameters<typeof server.readRelayOrder>[1]> = {}) => {
    const r = server.readRelayOrder(q, input(over));
    eq(r.ok ? "ok" : r.reason, reason, msg);
  };
  no(RH_QUOTE, "output", "another amount than asked", { amount: 20_000_001n });
  no(RH_QUOTE, "calls", "another account than asked", { account: "0x0555" });
  no(RH_QUOTE, "calls", "another fee than asked", { bps: 2 });
  no(RH_QUOTE, "steps", "another token than asked (its approve is of USDG)", { token: { ...RH.tokens[0]!, address: "0x" + "9".repeat(40) } });
  no(RH_QUOTE, "steps", "a wallet on another chain", { source: TEMPO, token: TEMPO.tokens[0]! });
  no(RH_QUOTE, "steps", "another sender", { sender: "0x" + "34".repeat(20) });
  type Q = { steps: { requestId?: string; kind?: string; items: { data: Record<string, unknown> }[] }[]; details: { currencyOut: { amount: string; currency: { chainId: number; address: string } }; currencyIn: { amount: string } }; protocol: { v2: { orderData: { output: { calls: string[]; payments: { currency: string; minimumAmount: string }[] } } } } };
  const t = (f: (q: Q) => void) => {
    const q = clone(RH_QUOTE) as unknown as Q;
    f(q);
    return q;
  };
  no(t((q) => q.steps.forEach((s) => delete s.requestId)), "request", "no order id");
  no(t((q) => (q.details.currencyOut.currency.chainId = 1)), "output", "delivered on another chain");
  no(t((q) => (q.details.currencyOut.currency.address = "0x" + "1".repeat(40))), "output", "delivered as another token");
  no(t((q) => q.protocol.v2.orderData.output.calls.reverse()), "calls", "the calls in another order");
  no(t((q) => q.protocol.v2.orderData.output.calls.push("0x00")), "calls", "a third call");
  no(t((q) => (q.protocol.v2.orderData.output.payments[0]!.minimumAmount = "1")), "payments", "a payment of something else");
  no(t((q) => (q.protocol.v2.orderData.output.payments[0]!.currency = "0x" + "1".repeat(40))), "payments", "a payment in another token");
  no(t((q) => (q.steps[1]!.items[0]!.data.value = "1")), "steps", "a deposit that sends coin");
  no(t((q) => (q.steps[0]!.items[0]!.data.to = "0x" + "2".repeat(40))), "steps", "an approve of another token");
  no(t((q) => (q.steps[0]!.kind = "signature")), "steps", "a step that is no transaction");
  no(t((q) => q.steps.push(clone(q.steps[1]!))), "steps", "three transactions");
  no(t((q) => (q.details.currencyIn.amount = "24000001")), "expensive", "over 24 USDG for 20 USDC");
  ok(server.readRelayOrder(t((q) => (q.details.currencyIn.amount = "24000000")), input()).ok, "24 USDG for 20 USDC is within a tenth plus two dollars");
  no(null, "shape", "nothing");
}

/* ------------------------------------------------------------------ the route */
const route = await import("../src/app/api/starknet/cctp/relay/route");
const realFetch = globalThis.fetch;
let relayAnswer: { status: number; body: unknown } = { status: 200, body: RH_QUOTE };
const asked: unknown[] = [];
globalThis.fetch = (async (inp: string | URL | Request, init?: RequestInit) => {
  const url = typeof inp === "string" ? inp : inp instanceof URL ? inp.href : inp.url;
  if (url.startsWith("https://iris-api.circle.com/v2/burn/USDC/fees/")) return Response.json([{ finalityThreshold: 1000, minimumFee: 1.3 }, { finalityThreshold: 2000, minimumFee: 0 }]);
  if (url === "https://api.relay.link/quote") {
    asked.push(JSON.parse(String(init?.body)));
    return Response.json(relayAnswer.body, { status: relayAnswer.status });
  }
  throw new Error(`unexpected fetch ${url}`);
}) as typeof fetch;
try {
  const post = async (body: unknown, ip = "198.51.100.20", headers: Record<string, string> = {}) => {
    const r = await route.POST(new Request("https://www.gloam.trade/api/starknet/cctp/relay", { method: "POST", body: JSON.stringify(body), headers: { "x-forwarded-for": ip, "sec-fetch-site": "same-origin", "content-type": "application/json", ...headers } }));
    return { status: r.status, body: (await r.json()) as { ok?: boolean; quote?: { requestId: string; pay: string }; bps?: number; error?: { message?: string } } };
  };
  const good = { chainId: 4663, symbol: "USDG", amount: "20", account: ACCOUNT, sender: SENDER };
  const r = await post(good);
  eq([r.status, r.body.quote?.requestId, r.body.quote?.pay, r.body.bps], [200, "0x17957547681a371cbcaff072b3775a209281e6f663aeadc653a155b5d3e2caa4", "20.032776", 1.3], "a checked quote");
  eq(asked.at(-1), clone(server.relayOrderBody(input(), {})), "Relay was asked for exactly Gloam's order");
  const n = asked.length;
  eq((await post({ ...good, chainId: 8453 })).status, 400, "Base is a CCTP source, not this route's");
  eq((await post({ ...good, symbol: "ETH" })).status, 400, "only a listed stablecoin");
  eq((await post({ ...good, amount: "0.5" })).status, 400, "at least 1 USDC");
  eq((await post({ ...good, amount: "10000.01" })).status, 400, "at most 10,000 USDC");
  eq((await post({ ...good, amount: "1.0000001" })).status, 400, "six places at most");
  eq((await post({ ...good, account: "0x0" })).status, 400, "an open account");
  eq((await post({ ...good, sender: "0x1234" })).status, 400, "a wallet");
  eq((await post(good, "198.51.100.21", { "sec-fetch-site": "cross-site" })).status, 403, "same site only");
  eq(asked.length, n, "none of those asked Relay");
  relayAnswer = { status: 200, body: { ...clone(RH_QUOTE), details: { ...(RH_QUOTE.details as object), currencyOut: { amount: "1", currency: { chainId: 8453, address: BASE_USDC } } } } };
  const bad = await post(good, "198.51.100.22");
  eq([bad.status, bad.body.error?.message], [502, "The bridge couldn't make a route right now. Try again."], "an answer that differs from the order is refused");
  relayAnswer = { status: 400, body: { message: "Amount is too low" } };
  eq((await post(good, "198.51.100.23")).body.error?.message, "That amount is too small to bridge. Try a little more.", "Relay's own refusal, plainly");
  let last = 0;
  for (let i = 0; i < 13; i++) last = (await post({ ...good, amount: "1" }, "198.51.100.24")).status;
  eq(last, 429, "twelve orders a minute per IP");
} finally {
  globalThis.fetch = realFetch;
}

/* ------------------------------------------------------------------ the browser */
{
  const statuses: unknown[] = [];
  globalThis.fetch = (async (inp: string | URL | Request) => {
    const url = typeof inp === "string" ? inp : inp instanceof URL ? inp.href : inp.url;
    if (url.startsWith("https://app.selftest/api/bridge/status")) return Response.json(statuses.shift() ?? { ok: false }, { status: 200 });
    if (url.startsWith("https://app.selftest/api/starknet/cctp/message")) return Response.json({ ok: false, error: { code: "not_to_starknet" } }, { status: 404 });
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
  try {
    const BASE_TX = "0x" + "be".repeat(32);
    statuses.push({ ok: true, data: { stage: "waiting", outTx: null } }, { ok: true, data: { stage: "moving", outTx: null } }, { ok: true, data: { stage: "done", outTx: BASE_TX } });
    eq(await client.waitForRelay("0x" + "17".repeat(32), { origin: "https://app.selftest", pollMs: 1 }), BASE_TX, "waits for Relay's fill and has its Base transaction");
    statuses.push({ ok: true, data: { stage: "refunded", outTx: null } });
    await rejects(client.waitForRelay("0x" + "17".repeat(32), { origin: "https://app.selftest", pollMs: 1 }), /sent your money back/, "a refund says the money went back");
    statuses.push({ ok: true, data: { stage: "failed", outTx: null } });
    await rejects(client.waitForRelay("0x" + "17".repeat(32), { origin: "https://app.selftest", pollMs: 1 }), /couldn't finish/, "a failure says where the money is");
    for (let i = 0; i < 20; i++) statuses.push({ ok: true, data: { stage: "waiting", outTx: null } });
    await rejects(client.waitForRelay("0x" + "17".repeat(32), { origin: "https://app.selftest", pollMs: 2, timeoutMs: 5 }), /still on its way/, "a long wait says it is still coming");
    statuses.length = 0;

    // A pending bring-in through Relay: kept by its order, named once Relay fills, forgotten on a refund.
    const store = new Map<string, string>();
    (globalThis as unknown as { localStorage: Storage }).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    } as Storage;
    const order = "0x" + "17".repeat(32);
    const p = { domain: 6, chainId: 4663, tx: "", relay: order, amount: "20000000", at: 1 };
    client.keepPendingBringIn(ACCOUNT, p);
    eq(client.pendingBringIns(ACCOUNT), [p], "kept by its order before Relay names the Base transaction");
    eq(client.pendingKey(p), order, "its key is the order");
    client.keepPendingBringIn(ACCOUNT, { ...p, tx: BASE_TX });
    eq(client.pendingBringIns(ACCOUNT), [{ ...p, tx: BASE_TX }], "the same entry once Relay names it");
    store.set(`gloam:starknet:cctp:pending:v1:${BigInt(ACCOUNT).toString(16)}`, JSON.stringify([{ ...p, relay: "nope" }, { ...p, relay: undefined }]));
    eq(client.pendingBringIns(ACCOUNT), [], "an entry with neither a transaction nor a good order reads as none");

    const named: unknown[] = [];
    let settled = 0;
    const run = (pending: typeof p) =>
      client.finishBringIn({
        session: {} as never,
        token: { symbol: "USDC", name: "USD Coin", address: cctp.STARKNET_CCTP.mainnet.usdc, decimals: 6 },
        info: { on: true, network: "mainnet", relayer: null, fee: "250000", sources: [] },
        pending,
        source: relay.RELAY_HOP,
        step: () => {},
        onRelayed: (x) => named.push(x),
        onSettled: () => settled++,
        origin: "https://app.selftest",
        pollMs: 1,
      });
    statuses.push({ ok: true, data: { stage: "done", outTx: BASE_TX } });
    await rejects(run(p), /no USDC transfer to Starknet/, "after Relay's fill it asks Circle about the Base transaction");
    eq(named, [{ ...p, tx: BASE_TX }], "and the page keeps the Base transaction it learned");
    eq(settled, 0, "nothing settled yet");
    statuses.push({ ok: true, data: { stage: "refunded", outTx: null } });
    await rejects(run(p), /sent your money back/, "a refunded order stops");
    eq(settled, 1, "and is forgotten: nothing is on its way any more");
  } finally {
    globalThis.fetch = realFetch;
  }
}

console.log(`\nselftest-starknet-cctp-relay: ${pass} checks passed`);
