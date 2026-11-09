/**
 * Self-test: cash out to another chain (lib/cashOutCrossChain).
 *
 *  - which assets can leave which chain, and to where (Tempo: none, Relay has
 *    no strict deposit addresses there);
 *  - the net amount matches ShieldPoolCore's fee math, so the deposit address
 *    gets exactly what the order asks for;
 *  - the Relay request is a strict deposit address, exact input, refunds to
 *    the person's wallet, no app fee on top of the vault's;
 *  - readCrossChainQuote takes a real strict quote (fixture captured from
 *    api.relay.link on 2026-11-09) and refuses one whose deposit address,
 *    amount, token, recipient, refund address, deadline or shape differ;
 *  - crossChainProblem refuses a proof call that isn't bound to the quote:
 *    another address, another amount, a moved fee, another chain or asset;
 *  - the copy carries no em dashes.
 *
 * XCHAIN_LIVE=1 also asks Relay for a live strict quote and reads it (no funds move).
 *
 * Run from app/:  ../mcp/node_modules/.bin/tsx scripts/selftest-cashout-cross-chain.mts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const {
  CROSS_CHAIN_DESTINATIONS,
  XCHAIN_DEADLINE_MARGIN_SEC,
  XCHAIN_SLIPPAGE_BPS,
  cashOutNet,
  crossChainAmountProblem,
  crossChainDestination,
  crossChainDestinations,
  crossChainProblem,
  crossChainRelayBody,
  crossChainSource,
  readCrossChainQuote,
  requoteStillFine,
  validCrossChainRecipient,
} = await import("../src/lib/cashOutCrossChain");

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  await fn();
  passed++;
  console.log(`ok  ${name}`);
}

const USDG_RH = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const USDC_TEMPO = "0x20c000000000000000000000b9537d11c60e8b50";
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const RECIPIENT = "0x1111111111111111111111111111111111111111";
const REFUND = "0x2222222222222222222222222222222222222222";
const NOW = Date.UTC(2026, 10, 9, 12, 0, 0);

const fixture = JSON.parse(readFileSync(new URL("./fixtures/relay-xchain-strict-quote.json", import.meta.url), "utf8"));
const DEPOSIT: string = fixture.steps[0].depositAddress;
const base = crossChainDestination("base-usdc")!;
const ask = { sourceChainId: 4663, asset: USDG_RH, amount: 9_950_000n, destination: base, recipient: RECIPIENT, refundTo: REFUND };
const clone = () => JSON.parse(JSON.stringify(fixture));
const padAddr = (a: string) => a.toLowerCase().replace(/^0x/, "").padStart(64, "0");
const transferData = (to: string, amount: bigint) => `0xa9059cbb${padAddr(to)}${amount.toString(16).padStart(64, "0")}`;

// ------------------------------------------------------------- what can go where

await test("Robinhood Chain USDG can land on Base, Ethereum, Arbitrum and Solana", () => {
  const ids = crossChainDestinations(4663, USDG_RH).map((d) => d.id);
  assert.deepEqual(ids, ["base-usdc", "ethereum-usdc", "arbitrum-usdc", "solana-usdc"]);
  // any case of the address
  assert.equal(crossChainDestinations(4663, USDG_RH.toUpperCase().replace("0X", "0x")).length, 4);
});

await test("a destination on the vault's own chain is never offered (that is today's cash out)", () => {
  assert.ok(!crossChainDestinations(8453, USDC_BASE).some((d) => d.chainId === 8453));
  assert.ok(!crossChainDestinations(1, "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48").some((d) => d.chainId === 1));
});

await test("Tempo, testnets, ETH and unknown assets get no cross-chain option", () => {
  assert.deepEqual(crossChainDestinations(4217, USDC_TEMPO), []);
  assert.deepEqual(crossChainDestinations(46630, USDG_RH), []);
  assert.deepEqual(crossChainDestinations(84532, USDC_BASE), []);
  assert.deepEqual(crossChainDestinations(8453, "0x0000000000000000000000000000000000000000"), []);
  assert.deepEqual(crossChainDestinations(4663, "0xDcD80000000000000000000000000000000724d0"), []);
  assert.equal(crossChainSource(4663, USDG_RH)?.symbol, "USDG");
});

await test("every destination is USDC, with an id the API can look up", () => {
  for (const d of CROSS_CHAIN_DESTINATIONS) {
    assert.equal(d.token.symbol, "USDC");
    assert.equal(crossChainDestination(d.id), d);
  }
  assert.equal(crossChainDestination("tempo-usdc"), null);
  assert.equal(crossChainDestination(undefined), null);
});

await test("recipients: a 0x wallet for EVM chains, a Solana address for Solana", () => {
  const sol = crossChainDestination("solana-usdc")!;
  assert.ok(validCrossChainRecipient(base, RECIPIENT));
  assert.ok(!validCrossChainRecipient(base, "0x0000000000000000000000000000000000000000"));
  assert.ok(!validCrossChainRecipient(base, USDC_BASE), "the token contract itself");
  assert.ok(!validCrossChainRecipient(base, "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1"));
  assert.ok(validCrossChainRecipient(sol, "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1"));
  assert.ok(!validCrossChainRecipient(sol, RECIPIENT));
  assert.ok(!validCrossChainRecipient(sol, "0OIl0OIl0OIl0OIl0OIl0OIl0OIl0OIl"));
});

// ------------------------------------------------------------- amounts

await test("cashOutNet is ShieldPoolCore's own fee math, for any amount", () => {
  const contract = (a: bigint, bps: bigint) => a - ((a / 10_000n) * bps + ((a % 10_000n) * bps) / 10_000n);
  for (const a of [1n, 9_999n, 10_000n, 10_000_000n, 12_345_678n, 25_000_000_000n, 2n ** 120n + 7n]) {
    for (const bps of [0, 25, 50, 100]) assert.equal(cashOutNet(a, bps), contract(a, BigInt(bps)), `${a} at ${bps}`);
  }
  assert.equal(cashOutNet(10_000_000n, 50), 9_950_000n);
  assert.equal(cashOutNet(10_000_000n, -5), 10_000_000n);
});

await test("amount bounds: 1 to 25,000 dollars reach Relay", () => {
  assert.equal(crossChainAmountProblem(1_000_000n, 6), null);
  assert.equal(crossChainAmountProblem(25_000_000_000n, 6), null);
  assert.ok(crossChainAmountProblem(999_999n, 6));
  assert.ok(crossChainAmountProblem(25_000_000_001n, 6));
});

// ------------------------------------------------------------- the Relay request

await test("the request is a strict deposit address, exact input, refunded to the wallet, no app fee", () => {
  const body = crossChainRelayBody(ask);
  assert.equal(body.strict, true);
  assert.equal(body.useDepositAddress, true);
  assert.equal(body.tradeType, "EXACT_INPUT");
  assert.equal(body.amount, "9950000");
  assert.equal(body.refundTo, REFUND);
  assert.equal(body.recipient, RECIPIENT);
  assert.equal(body.originChainId, 4663);
  assert.equal(body.destinationChainId, 8453);
  assert.equal(body.slippageTolerance, XCHAIN_SLIPPAGE_BPS);
  assert.equal("appFees" in body, false);
  assert.equal("referrer" in body, false, "Relay refuses a referrer without a key");
  assert.equal(crossChainRelayBody(ask, { apiKey: true }).referrer, "gloam.trade");
});

// ------------------------------------------------------------- reading Relay's answer

await test("a real strict quote is read and bound to what was asked", () => {
  const r = readCrossChainQuote(fixture, ask, NOW);
  assert.ok(r.ok, r.ok ? "" : r.reason);
  const q = r.quote;
  assert.equal(q.depositAddress, DEPOSIT);
  assert.equal(q.amountIn, "9950000");
  assert.equal(q.recipient, RECIPIENT);
  assert.equal(q.refundTo, REFUND);
  assert.equal(q.destination.id, "base-usdc");
  assert.equal(q.sourceChain, "Robinhood Chain");
  assert.equal(q.sourceSymbol, "USDG");
  assert.ok(BigInt(q.receive.minimumRaw) <= BigInt(q.receive.amountRaw));
  assert.ok(BigInt(q.receive.minimumRaw) * 10_000n >= 9_950_000n * 9_800n, "a stablecoin route keeps most of it");
  assert.ok(q.deadline * 1000 > NOW);
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the fixture is Relay JSON, bent field by field
function refused(mutate: (d: any) => void, a = ask, now = NOW): string {
  const d = clone();
  mutate(d);
  const r = readCrossChainQuote(d, a, now);
  assert.equal(r.ok, false, "should be refused");
  return r.ok ? "" : r.reason;
}

await test("refused: another deposit address in the transfer than the step names", () => {
  refused((d) => (d.steps[0].items[0].data.data = transferData(RECIPIENT, 9_950_000n)));
  refused((d) => (d.steps[0].depositAddress = RECIPIENT));
  refused((d) => (d.steps[0].depositAddress = "0x0000000000000000000000000000000000000000"));
  refused((d) => delete d.steps[0].depositAddress);
});

await test("refused: an amount that isn't exactly what the vault will pay", () => {
  // Relay's transfer for one unit more or less
  refused((d) => (d.steps[0].items[0].data.data = transferData(DEPOSIT, 9_950_001n)));
  refused((d) => (d.steps[0].items[0].data.data = transferData(DEPOSIT, 9_949_999n)));
  // the signed order for another amount
  refused((d) => (d.protocol.v2.orderData.inputs[0].payment.amount = "9950001"));
  // the fixture read against another ask (the fee moved, say)
  const r = readCrossChainQuote(fixture, { ...ask, amount: 9_975_000n }, NOW);
  assert.equal(r.ok, false);
});

await test("refused: another token or chain on the paying side", () => {
  refused((d) => (d.steps[0].items[0].data.to = USDC_BASE));
  refused((d) => (d.steps[0].items[0].data.chainId = 8453));
  refused((d) => (d.steps[0].items[0].data.value = "1"));
  refused((d) => (d.protocol.v2.orderData.inputs[0].payment.currency = USDC_BASE));
  refused((d) => (d.steps[0].items[0].data.data = "0x095ea7b3" + d.steps[0].items[0].data.data.slice(10)), ask);
});

await test("refused: another recipient, output token, refund address or extra calls", () => {
  refused((d) => (d.protocol.v2.orderData.output.payments[0].recipient = REFUND));
  refused((d) => (d.protocol.v2.orderData.output.payments[0].currency = "0xaf88d065e77c8cc2239327c5edb3a432268e5831"));
  refused((d) => d.protocol.v2.orderData.output.payments.push(d.protocol.v2.orderData.output.payments[0]));
  refused((d) => (d.protocol.v2.orderData.inputs[0].refunds[0].recipient = RECIPIENT));
  refused((d) => (d.protocol.v2.orderData.inputs[0].refunds = []));
  refused((d) => (d.protocol.v2.orderData.output.calls = [{ to: RECIPIENT, data: "0x" }]));
  // the fixture read for someone else
  assert.equal(readCrossChainQuote(fixture, { ...ask, recipient: REFUND }, NOW).ok, false);
  assert.equal(readCrossChainQuote(fixture, { ...ask, refundTo: RECIPIENT }, NOW).ok, false);
  assert.equal(readCrossChainQuote(fixture, { ...ask, destination: crossChainDestination("arbitrum-usdc")! }, NOW).ok, false);
});

await test("refused: an order that ends too soon, odd shapes and odd amounts out", () => {
  const deadline = fixture.protocol.v2.orderData.output.deadline as number;
  assert.equal(readCrossChainQuote(fixture, ask, deadline * 1000 - XCHAIN_DEADLINE_MARGIN_SEC * 1000 + 1).ok, false);
  assert.equal(readCrossChainQuote(fixture, ask, deadline * 1000 - XCHAIN_DEADLINE_MARGIN_SEC * 1000 - 1000).ok, true);
  refused((d) => d.steps.push(d.steps[0]));
  refused((d) => (d.steps[0].id = "swap"));
  refused((d) => (d.steps[0].requestId = "0x1234"));
  refused((d) => delete d.protocol);
  refused((d) => (d.protocol.v2.orderData.output.payments[0].minimumAmount = "99999999999"));
  refused((d) => (d.protocol.v2.orderData.output.payments[0].minimumAmount = "0"));
  refused((d) => (d.details.currencyOut.amount = "20000000"), ask);
  assert.equal(readCrossChainQuote(null, ask, NOW).ok, false);
  assert.equal(readCrossChainQuote({ message: "no route" }, ask, NOW).ok, false);
});

// ------------------------------------------------------------- binding the proof

const q = (() => {
  const r = readCrossChainQuote(fixture, ask, NOW);
  assert.ok(r.ok);
  return r.quote;
})();
const call = { chainId: 4663, asset: USDG_RH, gross: 10_000_000n, feeBps: 50, to: DEPOSIT, destinationId: "base-usdc", recipient: RECIPIENT, refundTo: REFUND };

await test("a proof call for Relay's address and the exact amount passes", () => {
  assert.equal(crossChainProblem(q, call, NOW), null);
  assert.equal(crossChainProblem(q, { ...call, to: DEPOSIT.toLowerCase(), asset: USDG_RH.toLowerCase() }, NOW), null);
});

await test("a proof call to any other address is refused", () => {
  assert.match(crossChainProblem(q, { ...call, to: RECIPIENT }, NOW) ?? "", /address Relay gave/);
  assert.match(crossChainProblem(q, { ...call, to: REFUND }, NOW) ?? "", /address Relay gave/);
});

await test("a proof call whose amount, after the fee, isn't the order's is refused", () => {
  assert.match(crossChainProblem(q, { ...call, gross: 10_000_001n }, NOW) ?? "", /amount no longer matches/);
  assert.match(crossChainProblem(q, { ...call, gross: 9_950_000n }, NOW) ?? "", /amount no longer matches/);
  // the vault's fee moved between the quote and the proof
  assert.match(crossChainProblem(q, { ...call, feeBps: 25 }, NOW) ?? "", /amount no longer matches/);
  assert.match(crossChainProblem(q, { ...call, feeBps: 0 }, NOW) ?? "", /amount no longer matches/);
});

await test("another chain, asset, destination, recipient, refund or a stale order is refused", () => {
  assert.ok(crossChainProblem(q, { ...call, chainId: 8453 }, NOW));
  assert.ok(crossChainProblem(q, { ...call, asset: USDC_BASE }, NOW));
  assert.ok(crossChainProblem(q, { ...call, destinationId: "arbitrum-usdc" }, NOW));
  assert.ok(crossChainProblem(q, { ...call, recipient: REFUND }, NOW));
  assert.ok(crossChainProblem(q, { ...call, refundTo: RECIPIENT }, NOW));
  assert.ok(crossChainProblem(q, call, q.deadline * 1000));
});

await test("a fresh price within 0.5% of the one shown goes ahead, a worse one is shown again", () => {
  const at = (minimumRaw: string) => ({ receive: { amount: "0", minimum: "0", amountRaw: "0", minimumRaw } });
  assert.ok(requoteStillFine(at("10000000"), at("10000000")));
  assert.ok(requoteStillFine(at("10000000"), at("10100000")));
  assert.ok(requoteStillFine(at("10000000"), at("9950000")));
  assert.ok(!requoteStillFine(at("10000000"), at("9949999")));
});

// ------------------------------------------------------------- copy

await test("no em dashes in the new copy", () => {
  for (const f of [
    "../src/lib/cashOutCrossChain.ts",
    "../src/components/app/CrossChainCashOut.tsx",
    "../src/app/api/cashout/cross-chain/route.ts",
  ]) {
    assert.equal(readFileSync(new URL(f, import.meta.url), "utf8").includes("—"), false, f);
  }
});

// ------------------------------------------------------------- live (opt-in)

if (process.env.XCHAIN_LIVE === "1") {
  for (const [id, chainId, asset] of [
    ["base-usdc", 4663, USDG_RH],
    ["solana-usdc", 4663, USDG_RH],
    ["arbitrum-usdc", 8453, USDC_BASE],
  ] as const) {
    await test(`live: a strict quote ${chainId} to ${id} reads clean`, async () => {
      const destination = crossChainDestination(id)!;
      const recipient = destination.kind === "svm" ? "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1" : RECIPIENT;
      const a = { sourceChainId: chainId, asset, amount: 9_950_000n, destination, recipient, refundTo: REFUND };
      const res = await fetch("https://api.relay.link/quote", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(crossChainRelayBody(a)),
      });
      const r = readCrossChainQuote(await res.json(), a);
      assert.ok(r.ok, r.ok ? "" : r.reason);
      console.log(`    ${r.quote.receive.amount} ${r.quote.destination.symbol} on ${r.quote.destination.chain}, at least ${r.quote.receive.minimum}, deposit ${r.quote.depositAddress}`);
    });
  }
  await test("live: Tempo has no strict deposit addresses (why it is left out)", async () => {
    const res = await fetch("https://api.relay.link/quote", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(crossChainRelayBody({ sourceChainId: 4217, asset: USDC_TEMPO, amount: 9_950_000n, destination: base, recipient: RECIPIENT, refundTo: REFUND })),
    });
    const body = (await res.json()) as { message?: string };
    assert.equal(res.ok, false);
    assert.match(String(body.message), /strict/i);
  });
}

console.log(`\n${passed} passed`);
