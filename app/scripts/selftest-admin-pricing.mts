/**
 * Self-test: /admin's money figures are priced at the time of each flow, and a
 * private swap is one trade, not a deposit plus a cash-out.
 *
 *  - priceAt: the nearest point, never one too far away; provisional while the
 *    flow is new or the series has nothing after it
 *  - priceFlows: a mainnet ETH or token flow gets its price at the time; a dollar
 *    stablecoin, a euro coin, a testnet and a flow from before launch do not; a
 *    provisional price is looked up again, a settled one never
 *  - figures(): deposits, cash-outs and fees use the price at the time, so a
 *    move in today's price changes nothing; a flow with no price yet falls back
 *    to today's and is named in atToday; held now stays at today's price
 *  - swapsAsTrades / counted(): a swap's legs leave deposits, cash-outs and
 *    their volume, count as one trade, and its fee is still revenue
 *  - dailyMeans: one price per UTC day
 *
 * Nothing reaches the network: the series are built here.
 * Run from app/:  ../mcp/node_modules/.bin/tsx scripts/selftest-admin-pricing.mts
 */
import assert from "node:assert/strict";
import { getNetwork } from "../src/lib/networks";
import { shieldTokensFor } from "../src/lib/tokens";
import { MAINNET_LAUNCH_MS } from "../src/lib/mainnet";
import { dailyMeans, priceAt, type Point } from "../src/lib/priceHistory";
import { counted, figures, priceFlows, swapsAsTrades, type ChainEvent, type Prices, type ScanState } from "../src/lib/onchainMetrics";

let checks = 0;
const check = async (name: string, fn: () => void | Promise<void>) => {
  await fn();
  checks++;
  console.log("ok  ", name);
};

const H = 3_600;
const L = Math.floor(MAINNET_LAUNCH_MS / 1000);
const rh = getNetwork("robinhood-mainnet");
const base = getNetwork("base-mainnet");
const rhTest = getNetwork("robinhood");
const lc = (a: string) => a.toLowerCase();
const tok = (chain: number, sym: string) => lc(shieldTokensFor(chain).find((t) => t.symbol === sym)!.address);
const USDG = tok(4663, "USDG");
const GLOAM = tok(4663, "GLOAM");
const EURC = tok(8453, "EURC");
const ETH = 10n ** 18n;

/** An hourly series from `from` for `hours`, priced by `f(hour index)`. */
const hourly = (from: number, hours: number, f: (i: number) => number): Point[] =>
  [...Array(hours).keys()].map((i) => [(from + i * H) * 1000, f(i)]);

const prices = (ethUsd: number | null, marks: [string, number][] = []): Prices => ({ at: Date.now(), ethUsd, marks: new Map(marks), stocks: "live" });
const state = (events: ChainEvent[]): ScanState => ({ v: 1, pool: "0x", scannedTo: 0, memoScannedTo: 0, memos: 0, startTs: 0, events, fee: 1, sw: 1 });
const extra = { blocksRead: 0n, latest: null, readMs: 0, error: null };
let block = 100;
const ev = (e: Partial<ChainEvent> & Pick<ChainEvent, "k" | "ts">): ChainEvent => ({ b: block++, i: 0, tx: `0x${block}`, ...e });

await check("priceAt: nearest point within tolerance, provisional while new", () => {
  const t0 = L + 10 * H;
  const pts = hourly(t0, 5, (i) => 100 + i); // t0..t0+4h
  const now = t0 + 100 * H;
  assert.deepEqual(priceAt(pts, t0 + 20 * 60, now), { usd: 100, settled: true }, "20 minutes past: the hour before");
  assert.deepEqual(priceAt(pts, t0 + 40 * 60, now), { usd: 101, settled: true }, "40 minutes past: the hour after");
  assert.equal(priceAt(pts, t0 - 3 * H, now), null, "three hours before the first point: too far");
  assert.equal(priceAt(pts, 0, now), null, "undated flow: no price");
  // after the last point: priced, but provisional (nothing after it yet)
  assert.deepEqual(priceAt(pts, t0 + 4 * H + 600, now), { usd: 104, settled: false });
  // a new flow is provisional even with a point after it
  assert.equal(priceAt(pts, t0 + H, t0 + H + 600)?.settled, false);
  // a daily series takes a day and a half of slack
  const daily: Point[] = [0, 1, 2].map((d) => [(L + d * 86_400) * 1000, 10 + d]);
  assert.equal(priceAt(daily, L + 86_400 + 20 * H, L + 30 * 86_400)?.usd, 12);
});

await check("dailyMeans: one mean per UTC day", () => {
  const day0 = Date.parse("2026-11-01T00:00:00Z") / 1000;
  const m = dailyMeans(hourly(day0, 48, (i) => (i < 24 ? 2 : 4)));
  assert.equal(m.get("2026-11-01"), 2);
  assert.equal(m.get("2026-11-02"), 4);
  assert.equal(m.size, 2);
});

await check("priceFlows: mainnet ETH and token flows get their price at the time; stables, euros, testnets and pre-launch do not", async () => {
  const t = L + 20 * H;
  const old = Math.floor(Date.now() / 1000) - 5 * 86_400;
  const asked: string[] = [];
  const series = async (id: string, from: number) => {
    asked.push(id);
    const start = Math.min(from, old - 6 * H);
    return hourly(start, Math.ceil((Date.now() / 1000 - start) / H) + 1, () => (id === "ethereum" ? 2500 : 3.5));
  };
  const eth = ev({ k: "deposit", ts: t, a: "native", v: String(ETH / 10n) });
  const gloam = ev({ k: "cashout", ts: old, a: GLOAM, v: String(100n * ETH) });
  const usdg = ev({ k: "deposit", ts: t, a: USDG, v: "5000000" });
  const before = ev({ k: "deposit", ts: L - 60, a: "native", v: String(ETH) });
  const transfer = ev({ k: "transfer", ts: t });
  await priceFlows(rh, [eth, gloam, usdg, before, transfer], series);
  assert.equal(eth.p, 2500);
  assert.equal(eth.pq, undefined, "an old flow is settled");
  assert.equal(gloam.p, 3.5);
  assert.equal(usdg.p, undefined, "a dollar stablecoin is $1, not looked up");
  assert.equal(before.p, undefined, "before launch: not counted, not priced");
  assert.deepEqual(asked.sort(), ["ethereum", "gloam"]);

  const eurc = ev({ k: "deposit", ts: t, a: EURC, v: "1000000" });
  await priceFlows(base, [eurc], series);
  assert.equal(eurc.p, undefined, "a euro coin stays out of dollar figures");

  const test = ev({ k: "deposit", ts: t, a: "native", v: String(ETH) });
  await priceFlows(rhTest, [test], series);
  assert.equal(test.p, undefined, "testnets are priced at today's prices");

  // a settled price is never looked up again; a provisional one is
  asked.length = 0;
  const fresh = ev({ k: "deposit", ts: Math.floor(Date.now() / 1000) - 600, a: "native", v: String(ETH) });
  await priceFlows(rh, [eth, fresh], series);
  assert.deepEqual(asked, ["ethereum"]);
  assert.equal(fresh.pq, 1, "ten minutes old: provisional");
  asked.length = 0;
  await priceFlows(rh, [eth], series);
  assert.deepEqual(asked, [], "nothing left to price: no read");

  // CoinGecko down: nothing priced, nothing thrown, tried next time
  const later = ev({ k: "deposit", ts: t, a: "native", v: String(ETH) });
  await priceFlows(rh, [later], async () => null);
  assert.equal(later.p, undefined);
  await priceFlows(rh, [later], async () => {
    throw new Error("429");
  });
  assert.equal(later.p, undefined);
});

await check("figures(): flows at their price at the time, held at today's, today's price moves nothing", () => {
  const t = L + 30 * H;
  const events = [
    ev({ k: "deposit", ts: t, a: "native", v: String(ETH / 2n), w: "0xa", p: 2000 }), // 0.5 ETH at $2,000
    ev({ k: "cashout", ts: t + H, a: "native", v: String(ETH / 4n), w: "0xb", f: String(ETH / 400n), p: 2100 }), // 0.25 ETH at $2,100
    ev({ k: "deposit", ts: t, a: USDG, v: "10000000", w: "0xa" }), // 10 USDG
    ev({ k: "deposit", ts: t, a: GLOAM, v: String(100n * ETH), w: "0xc", p: 3 }), // 100 GLOAM at $3
  ];
  const holdings = [{ asset: "native", raw: ETH / 4n }];
  const run = (ethNow: number, gloamNow: number) =>
    figures(rh, counted(rh, state(events.map((e) => ({ ...e })))), holdings, prices(ethNow, [[GLOAM, gloamNow]]), [], extra, { settings: null, days: [] });
  const a = run(2229.16, 0.38);
  const b = run(4000, 9);
  const r = a.revenue!;
  assert.equal(r.depositVolume.all, 0.5 * 2000 + 10 + 100 * 3);
  assert.equal(r.cashoutVolume.all, 0.25 * 2100);
  assert.equal(r.fees.all, 0.0025 * 2100);
  assert.deepEqual(r.atToday, []);
  assert.equal(b.revenue!.depositVolume.all, r.depositVolume.all, "ETH and GLOAM moving today changes no flow");
  assert.equal(b.revenue!.fees.all, r.fees.all);
  assert.equal(r.feeRows.find((x) => x.symbol === "ETH")?.earnedUsd, 0.0025 * 2100);
  // held now is a balance: valued at today's price
  assert.equal(a.heldUsd, 0.25 * 2229.16);
  assert.equal(b.heldUsd, 0.25 * 4000);
});

await check("figures(): a flow with no price at the time yet uses today's and is named", () => {
  const t = L + 40 * H;
  const s = state([ev({ k: "deposit", ts: t, a: "native", v: String(ETH), w: "0xa" })]);
  const m = figures(rh, counted(rh, s), [], prices(2229.16), [], extra, { settings: null, days: [] });
  assert.equal(m.revenue!.depositVolume.all, 2229.16);
  assert.deepEqual(m.revenue!.atToday, ["ETH"]);
  // with no price at all it is unpriced, never $0 without saying so
  const none = figures(rh, counted(rh, s), [], prices(null), [], extra, { settings: null, days: [] });
  assert.equal(none.revenue!.depositVolume.all, 0);
  assert.deepEqual(none.revenue!.unpriced, ["ETH"]);
  assert.deepEqual(none.revenue!.atToday, []);
  // a testnet flow at today's price is not "at today" (that is how testnets are priced)
  const tm = figures(rhTest, counted(rhTest, s), [], prices(2229.16), [], extra, { settings: null, days: [] });
  assert.deepEqual(tm.revenue!.atToday, []);
});

await check("swaps: legs leave deposits and cash-outs, count as one trade, keep their fee", () => {
  const t = L + 50 * H;
  const swapTx = "0xswap";
  const legOut = { k: "cashout" as const, b: 500, i: 1, ts: t, tx: swapTx, a: USDG, v: "100000000", f: "250000", r: 1 as const };
  const legIn = { k: "deposit" as const, b: 500, i: 3, ts: t, tx: swapTx, a: GLOAM, v: String(30n * ETH), r: 1 as const, p: 3.3 };
  const lone = { k: "deposit" as const, b: 600, i: 0, ts: t + H, tx: "0xrefund", a: USDG, v: "1000000", r: 1 as const };
  const real = [
    { k: "deposit" as const, b: 400, i: 0, ts: t - H, tx: "0xd", a: USDG, v: "200000000", w: "0xa" },
    { k: "cashout" as const, b: 700, i: 0, ts: t + 2 * H, tx: "0xc", a: USDG, v: "50000000", w: "0xb", f: "125000" },
  ];
  const all: ChainEvent[] = [real[0]!, legOut, legIn, lone, real[1]!];
  const view = swapsAsTrades(all);
  assert.deepEqual(
    view.map((e) => `${e.k}:${e.tx}`),
    ["deposit:0xd", "trade:0xswap", "trade:0xrefund", "cashout:0xc"],
    "one trade per swap, a lone router deposit is a trade of its own"
  );
  assert.equal(swapsAsTrades(real), real, "no swap: the same list back");

  const m = figures(rh, counted(rh, state(all)), [], prices(2229.16), [], extra, { settings: null, days: [] });
  assert.equal(m.deposits, 1);
  assert.equal(m.cashouts, 1);
  assert.equal(m.trades, 2);
  assert.equal(m.depositors, 1);
  assert.equal(m.revenue!.depositVolume.all, 200, "the swap's $100 in is not money in");
  assert.equal(m.revenue!.cashoutVolume.all, 50, "nor its $100 out");
  assert.equal(m.revenue!.fees.all, 0.25 + 0.125, "the vault kept a fee on the swap: revenue");
  assert.equal(m.revenue!.txs.all, 4, "a swap is one transaction");
  const usdg = m.assets.find((a) => a.symbol === "USDG")!;
  assert.equal(usdg.deposited, "200");
  assert.equal(usdg.cashedOut, "50");
  assert.equal(m.assets.find((a) => a.symbol === "GLOAM"), undefined, "a swap's token is not deposited");
  // the same on a testnet
  const tm = figures(rhTest, counted(rhTest, state(all)), [], prices(2229.16), [], extra, { settings: null, days: [] });
  assert.equal(tm.deposits, 1);
  assert.equal(tm.trades, 2);
});

await check("counted(): a mainnet swap from before launch stays out", () => {
  const legOut = { k: "cashout" as const, b: 10, i: 0, ts: L - 600, tx: "0x1", a: USDG, v: "1", r: 1 as const };
  const legIn = { k: "deposit" as const, b: 10, i: 1, ts: L - 600, tx: "0x1", a: GLOAM, v: "1", r: 1 as const, w: undefined };
  const after = { k: "deposit" as const, b: 20, i: 0, ts: L + 60, tx: "0x2", a: USDG, v: "1", w: "0xa" };
  assert.deepEqual(counted(rh, state([legOut, legIn, after])).events.map((e) => e.tx), ["0x2"]);
});

console.log(`selftest-admin-pricing: ${checks} checks passed`);
