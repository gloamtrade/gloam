/**
 * x402 scheme gloam-cashout through the pack, with a fake engine on Robinhood
 * Chain mainnet and a fake gateway: the preview says plainly who is paid, how
 * much, the vault's fee and what stays private; execute cashes out once and
 * retries with the X-PAYMENT header; the quote id never comes back to the model.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GLOAM_CASHOUT_ASSET,
  GLOAM_CASHOUT_VAULT,
  buildGloamPaymentRequirements,
  cashOutFee,
  cashoutGross,
  decodeGloamCashoutHeader,
  encodeGloamCashoutHeader,
  encodeRequirements,
  generateReceiveKey,
  getGloamNetwork,
  type GloamCashoutRequirement,
} from "@gloamtrade/sdk";
import { createGloamToolPack } from "../src/index.ts";
import { fakeEngine, hashOf } from "./helpers.mts";

const RH = getGloamNetwork("robinhood-mainnet")!;
const SPLITTER = "0x5111111111111111111111111111111111111115";
const PRICE = 1_000_000n;
const G = cashoutGross(PRICE, 421, 50);
const QUOTE_ID = "qt_secret_7f3a9c";
const URL_ = "https://gateway.test/v1/tool";

const cashoutEntry = (over: Record<string, unknown> = {}) => ({
  scheme: "gloam-cashout",
  network: "eip155:4663",
  asset: GLOAM_CASHOUT_ASSET,
  payTo: SPLITTER,
  amount: G.toString(),
  quoteId: QUOTE_ID,
  maxTimeoutSeconds: 120,
  ...over,
});
const exactEntry = { scheme: "exact", network: "eip155:4663", amount: PRICE.toString(), asset: GLOAM_CASHOUT_ASSET, payTo: SPLITTER, maxTimeoutSeconds: 60 };

/** A gateway: 402 with PAYMENT-REQUIRED (v2) listing `accepts`, 200 for a gloam-cashout header with its quote id. */
function gateway(accepts: unknown[], opts: { busyRetries?: number } = {}) {
  const seen: { header: string | null }[] = [];
  let busy = opts.busyRetries ?? 0;
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const req = new Request(url, init);
    const header = req.headers.get("x-payment");
    seen.push({ header });
    if (header) {
      if (busy > 0) {
        busy--;
        return new Response("confirming", { status: 503 });
      }
      const p = decodeGloamCashoutHeader(header);
      return p.quoteId === QUOTE_ID ? new Response(JSON.stringify({ result: "served" }), { status: 200 }) : new Response("unknown quote", { status: 402 });
    }
    const pr = { x402Version: 2, resource: { url }, accepts };
    return new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(pr)).toString("base64") } });
  }) as typeof fetch;
  return { fetchImpl, seen };
}

function rhEngine(feeBps = 50) {
  const made = fakeEngine({
    network: { key: RH.key, label: RH.label, testnet: RH.testnet, chainId: RH.chainId, pool: RH.pool, assets: RH.assets, nativeShield: RH.nativeShield },
    feeBps,
  });
  const cashouts: { requirement: GloamCashoutRequirement; maxAmount: string }[] = [];
  made.engine.payX402Cashout = async (args) => {
    cashouts.push(args);
    const hash = hashOf(4663);
    return { status: "done", action: "pay_x402_cashout", hash, paymentHeader: encodeGloamCashoutHeader({ txHash: hash, quoteId: args.requirement.quoteId }) };
  };
  return { ...made, cashouts };
}

test("only gloam-cashout (next to exact): the preview names the public payee, the gross, the fee and what stays private; execute pays once", async () => {
  const { engine, cashouts, calls } = rhEngine();
  const gw = gateway([exactEntry, cashoutEntry()]);
  const pack = createGloamToolPack({ engine, fetch: gw.fetchImpl });

  const p = await pack.call("gloam_preview_pay_x402", { url: URL_, maxAmount: "1.01" });
  assert.equal(p.status, "preview", JSON.stringify(p));
  assert.equal(p.action, "pay_x402_cashout");
  const d = p.details as Record<string, unknown>;
  assert.equal(d.scheme, "gloam-cashout");
  assert.equal(d.to, SPLITTER);
  assert.match(String(d.toIs), /public payout address/);
  assert.equal(d.amountBaseUnits, G.toString());
  assert.equal(d.amount, `${Number(G) / 1e6} USDG`);
  const fee = cashOutFee(G, 50);
  assert.deepEqual(d.fee, { bps: 50, percent: "0.5%", amount: `${Number(fee) / 1e6} USDG`, note: "Kept by the vault when the cash out lands." });
  assert.equal(d.payeeReceives, `${Number(G - fee) / 1e6} USDG`);
  assert.ok(G - fee >= PRICE, "the splitter gets at least the price");
  assert.match(String(d.staysPrivate), /wallet and its private balance/);
  assert.match(String(p.public), /cash out itself is public/);
  assert.match(String(p.public), new RegExp(SPLITTER));
  assert.deepEqual(d.alsoOffered, ["exact on eip155:4663"]);
  assert.deepEqual(p.walletSigns, [], "the relay sends it: the wallet signs nothing");
  assert.ok(!JSON.stringify(p).includes(QUOTE_ID), "the quote id is not shown to the model");
  assert.equal(gw.seen.length, 1, "the preview made one unpaid request");
  assert.equal(cashouts.length, 0, "the preview paid nothing");

  const r = await pack.call("gloam_execute", { previewId: p.previewId, digest: p.digest });
  assert.equal(r.status, "ok", JSON.stringify(r));
  assert.equal(r.body, JSON.stringify({ result: "served" }));
  assert.equal(cashouts.length, 1);
  assert.equal(cashouts[0]!.requirement.quoteId, QUOTE_ID, "the quote id reaches the engine untouched");
  assert.equal(cashouts[0]!.maxAmount, "1.01");
  const sent = decodeGloamCashoutHeader(gw.seen[1]!.header!);
  assert.deepEqual(sent, { scheme: "gloam-cashout", txHash: hashOf(4663), quoteId: QUOTE_ID });
  assert.ok(!JSON.stringify(r).includes(QUOTE_ID), "nor in the result");
  assert.equal(r.paymentHeader, undefined);

  const again = await pack.call("gloam_execute", { previewId: p.previewId });
  assert.equal(again.repeated, true);
  assert.equal(cashouts.length, 1, "never paid twice");
  assert.ok(!calls.some((c) => c.fn === "payX402"), "the private scheme was not used");
});

test("a paid request the gateway did not serve yet is presented again, never paid again", async () => {
  const { engine, cashouts } = rhEngine();
  const gw = gateway([cashoutEntry()], { busyRetries: 1 });
  const pack = createGloamToolPack({ engine, fetch: gw.fetchImpl });
  const p = await pack.call("gloam_preview_pay_x402", { url: URL_, maxAmount: "2" });
  const first = await pack.call("gloam_execute", { previewId: p.previewId });
  assert.equal(first.status, "paid_not_served", JSON.stringify(first));
  assert.equal(first.paymentHeader, undefined, "the header (with the quote id) stays out of the result");
  const second = await pack.call("gloam_execute", { previewId: p.previewId });
  assert.equal(second.status, "ok", JSON.stringify(second));
  assert.equal(cashouts.length, 1);
  assert.equal(gw.seen.filter((s) => s.header).length, 2, "the same payment, presented twice");
  assert.equal(gw.seen[1]!.header, gw.seen[2]!.header);
});

test("refusals: no maxAmount, over maxAmount, wrong network, wrong asset, no quote id, wrong vault, payTo the vault", async () => {
  const cases: [Record<string, unknown>, Record<string, unknown>, string][] = [
    [{}, {}, "no_max_amount"],
    [{}, { maxAmount: "1.004" }, "over_max_amount"],
    [{ network: "eip155:8453" }, { maxAmount: "2" }, "wrong_network"],
    [{ asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" }, { maxAmount: "2" }, "wrong_asset"],
    [{ quoteId: undefined }, { maxAmount: "2" }, "no_quote_id"],
    [{ vault: "0x00000000000000000000000000000000000000f1" }, { maxAmount: "2" }, "wrong_vault"],
    [{ payTo: GLOAM_CASHOUT_VAULT }, { maxAmount: "2" }, "bad_payee"],
    [{ amount: "0" }, { maxAmount: "2" }, "bad_amount"],
  ];
  for (const [over, input, code] of cases) {
    const { engine, cashouts } = rhEngine();
    const gw = gateway([cashoutEntry(over)]);
    const pack = createGloamToolPack({ engine, fetch: gw.fetchImpl });
    const r = await pack.call("gloam_preview_pay_x402", { url: URL_, ...input });
    assert.equal(r.code, code, `${code}: ${JSON.stringify(r)}`);
    assert.equal(r.status, "refused");
    assert.equal(cashouts.length, 0);
  }
  // An agent on another network does not pay a Robinhood Chain cash out.
  const base = fakeEngine();
  const pack = createGloamToolPack({ engine: base.engine, fetch: gateway([cashoutEntry()]).fetchImpl });
  assert.equal((await pack.call("gloam_preview_pay_x402", { url: URL_, maxAmount: "2" })).code, "wrong_network");
});

test("both schemes offered: gloam-private by default, gloam-cashout when the caller prefers it", async () => {
  const tag = (await generateReceiveKey()).tag;
  const priv = buildGloamPaymentRequirements({ amountWei: PRICE, asset: GLOAM_CASHOUT_ASSET, assetSymbol: "USDG", payTo: tag, resource: URL_, network: 4663, poolAddress: RH.pool });
  const privEntry = { scheme: "gloam-private", network: "eip155:4663", extra: { gloam: encodeRequirements(priv) } };
  const accepts = [exactEntry, privEntry, cashoutEntry()];

  const a = rhEngine();
  const packA = createGloamToolPack({ engine: a.engine, fetch: gateway(accepts).fetchImpl });
  const pa = await packA.call("gloam_preview_pay_x402", { url: URL_, maxAmount: "2" });
  assert.equal(pa.action, "pay_x402", JSON.stringify(pa));
  assert.equal((pa.details as Record<string, unknown>).to, tag);

  const b = rhEngine();
  const packB = createGloamToolPack({ engine: b.engine, fetch: gateway(accepts).fetchImpl });
  const pb = await packB.call("gloam_preview_pay_x402", { url: URL_, maxAmount: "2", prefer: "gloam-cashout" });
  assert.equal(pb.action, "pay_x402_cashout", JSON.stringify(pb));
  assert.equal((pb.details as Record<string, unknown>).to, SPLITTER);
  assert.equal((await packB.call("gloam_preview_pay_x402", { url: URL_, prefer: "bitcoin" })).code, "bad_input");
});

test("a fee change or an expired quote between preview and execute is refused, and nothing is paid", async () => {
  const { engine, cashouts, state } = rhEngine();
  const pack = createGloamToolPack({ engine, fetch: gateway([cashoutEntry()]).fetchImpl });
  const p = await pack.call("gloam_preview_pay_x402", { url: URL_, maxAmount: "2" });
  state.feeBps = 60;
  const r = await pack.call("gloam_execute", { previewId: p.previewId });
  assert.equal(r.code, "changed", JSON.stringify(r));
  assert.equal(cashouts.length, 0);

  const later = rhEngine();
  const soon = Math.floor(Date.now() / 1000) + 1;
  const pack2 = createGloamToolPack({ engine: later.engine, fetch: gateway([cashoutEntry({ expiresAt: soon })]).fetchImpl });
  const p2 = await pack2.call("gloam_preview_pay_x402", { url: URL_, maxAmount: "2" });
  assert.equal(p2.status, "preview", JSON.stringify(p2));
  await new Promise((r) => setTimeout(r, 1100));
  const r2 = await pack2.call("gloam_execute", { previewId: p2.previewId });
  assert.equal(r2.code, "changed");
  assert.match(String(r2.message), /expired/);
  assert.equal(later.cashouts.length, 0);
});
