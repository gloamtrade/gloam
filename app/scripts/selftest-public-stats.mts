/**
 * Self-test: the public numbers on /stats (lib/publicStats) never inflate and
 * never leak.
 *
 *  - only the mainnets, in the app's network order; the testnets' figures are
 *    in no total
 *  - the totals are exactly the sum of the rows the page lists
 *  - no wallet address reaches the public view (depositors, cash-out
 *    recipients, recent rows), only the vaults' own addresses
 *  - nothing held at zero is listed; an asset with no price is named and left
 *    out of the dollar total, never counted as $0
 *  - the daily rows start at the launch day; an old snapshot without
 *    `sinceLaunch` falls back to its 14 days, cut at launch
 *  - daysSince lists every UTC day from launch to today, once
 *  - counted(): on mainnet, an event from before launch never counts, and one
 *    not dated yet counts only once it is surely after launch
 *  - actions in the totals but in no day yet are reported, not hidden
 *
 * Nothing reaches the network: the snapshot is built here.
 * Run from app/:  ../mcp/node_modules/.bin/tsx scripts/selftest-public-stats.mts
 */
import assert from "node:assert/strict";
import { toPublicStats } from "../src/lib/publicStats";
import { counted, daysSince, type NetworkMetrics, type OnchainMetrics, type CombinedMetrics, type ScanState } from "../src/lib/onchainMetrics";
import { MAINNET_LAUNCH_MS } from "../src/lib/mainnet";
import { getNetwork, type NetworkKey } from "../src/lib/networks";

let checks = 0;
const check = (name: string, fn: () => void) => {
  fn();
  checks++;
  console.log("ok  ", name);
};

const WALLET_A = "0x1111111111111111111111111111111111111111";
const WALLET_B = "0x2222222222222222222222222222222222222222";

function net(key: NetworkKey, over: Partial<NetworkMetrics>): NetworkMetrics {
  const n = getNetwork(key);
  return {
    key,
    label: n.label,
    testnet: n.testnet,
    chainId: n.chainId,
    pool: n.pool ?? "",
    memo: null,
    deployBlock: "1",
    scannedTo: "2",
    latestBlock: "2",
    catchingUp: false,
    deposits: 0,
    transfers: 0,
    cashouts: 0,
    trades: 0,
    memos: 0,
    depositors: 1,
    cashoutWallets: 1,
    activeWallets: 2,
    heldUsd: 0,
    unpriced: [],
    assets: [],
    firstActivity: null,
    lastActivity: null,
    vaultSince: Math.floor(MAINNET_LAUNCH_MS / 1000) - 3600,
    daily: [],
    topDepositors: [{ address: WALLET_A, deposits: 3, lastTs: 1 }],
    recent: [{ network: key, kind: "deposit", tx: "0xabc", block: "1", ts: 1, wallet: WALLET_B, detail: "1 USDC" }],
    blocksRead: "1",
    readMs: 1,
    error: null,
    ...over,
  };
}

const launchDay = new Date(MAINNET_LAUNCH_MS).toISOString().slice(0, 10);
const dayBefore = new Date(MAINNET_LAUNCH_MS - 86_400_000).toISOString().slice(0, 10);
const empty: CombinedMetrics = {
  deposits: 0, transfers: 0, cashouts: 0, trades: 0, memos: 0, depositors: 0, activeWallets: 0,
  heldUsd: 0, unpriced: [], firstActivity: null, lastActivity: null, daily: [],
};

const networks: NetworkMetrics[] = [
  // deliberately out of order, with a testnet in between
  net("base-mainnet", {
    deposits: 3, transfers: 39, cashouts: 17, memos: 1, heldUsd: 412.4855,
    vaultSince: Math.floor(MAINNET_LAUNCH_MS / 1000) + 5 * 86_400,
    assets: [
      { asset: "a", symbol: "USDC", stable: true, held: "412.48", heldUsd: 412.4855, deposited: "0", depositCount: 0, cashedOut: "0", cashoutCount: 0 },
      { asset: "b", symbol: "EURC", stable: false, held: "10", heldUsd: null, deposited: "0", depositCount: 0, cashedOut: "0", cashoutCount: 0 },
      { asset: "c", symbol: "USDT", stable: true, held: "0", heldUsd: 0, deposited: "0", depositCount: 0, cashedOut: "0", cashoutCount: 0 },
    ],
    unpriced: ["EURC"],
  }),
  net("robinhood", { deposits: 115, transfers: 67, cashouts: 14, memos: 25, heldUsd: 264313.25 }),
  net("robinhood-mainnet", {
    deposits: 49, transfers: 239, cashouts: 126, memos: 4, heldUsd: 1932.35,
    assets: [
      { asset: "x", symbol: "GLOAM", stable: false, held: "176.96", heldUsd: 306.15, deposited: "0", depositCount: 0, cashedOut: "0", cashoutCount: 0 },
      { asset: "y", symbol: "USDG", stable: true, held: "1625.94", heldUsd: 1625.946, deposited: "0", depositCount: 0, cashedOut: "0", cashoutCount: 0 },
      { asset: "z", symbol: "TSLA", stable: false, held: null, heldUsd: null, deposited: "0", depositCount: 0, cashedOut: "0", cashoutCount: 0 },
    ],
  }),
  net("tempo-mainnet", { deposits: 2, cashouts: 1, heldUsd: 1.93, error: "boom" }),
];

const snapshot: OnchainMetrics = {
  asOf: "2026-10-29T11:48:41.634Z",
  source: "fresh",
  ageSec: 0,
  prices: { ethUsd: 3000, stocks: "live" },
  networks,
  combined: { ...empty, deposits: 999 },
  mainnet: {
    ...empty,
    daily: [
      { day: dayBefore, deposits: 7, transfers: 7, cashouts: 7, trades: 0, activeWallets: 9 },
      { day: launchDay, deposits: 1, transfers: 2, cashouts: 3, trades: 0, activeWallets: 4 },
    ],
    sinceLaunch: [
      { day: launchDay, deposits: 5, transfers: 6, cashouts: 7, trades: 0, activeWallets: 2 },
    ],
  },
  recent: [{ network: "base-mainnet", kind: "cashout", tx: "0xdef", block: "1", ts: 1, wallet: WALLET_A, detail: "1 USDC" }],
};

const pub = toPublicStats(snapshot);

check("only the mainnets, in the app's order", () => {
  const order = ["robinhood-mainnet", "base-mainnet", "tempo-mainnet"];
  assert.deepEqual(pub.networks.map((n) => n.key), order);
});

check("the totals are the sum of the listed rows; no testnet in them", () => {
  assert.equal(pub.total.deposits, 49 + 2 + 3);
  assert.equal(pub.total.transfers, 239 + 0 + 39);
  assert.equal(pub.total.cashouts, 126 + 1 + 17);
  assert.equal(pub.total.memos, 4 + 0 + 1);
  assert.equal(pub.total.heldUsd, Math.round((1932.35 + 1.93 + 412.49) * 100) / 100);
  assert.equal(pub.total.heldUsd, Math.round(pub.networks.reduce((a, n) => a + n.heldUsd, 0) * 100) / 100);
});

check("no wallet address and no people count is public", () => {
  const json = JSON.stringify(pub);
  assert.ok(!json.toLowerCase().includes(WALLET_A.slice(2)), "depositor address leaked");
  assert.ok(!json.toLowerCase().includes(WALLET_B.slice(2)), "recipient address leaked");
  for (const k of ["topDepositors", "recent", "depositors", "activeWallets", "cashoutWallets", "wallet"]) {
    assert.ok(!json.includes(`"${k}"`), `${k} is in the public view`);
  }
  const addrs = json.match(/0x[0-9a-fA-F]{40}/g) ?? [];
  const pools = new Set(pub.networks.map((n) => n.pool.toLowerCase()));
  for (const a of addrs) assert.ok(pools.has(a.toLowerCase()), `unexpected address ${a}`);
});

check("nothing held at zero or unread is listed; unpriced is named, not $0", () => {
  const base = pub.networks.find((n) => n.key === "base-mainnet")!;
  assert.deepEqual(base.holdings.map((h) => h.symbol), ["USDC", "EURC"]);
  assert.equal(base.holdings.find((h) => h.symbol === "EURC")!.heldUsd, null);
  assert.deepEqual(pub.total.unpriced, ["EURC on Base"]);
  const rh = pub.networks.find((n) => n.key === "robinhood-mainnet")!;
  assert.deepEqual(rh.holdings.map((h) => h.symbol), ["USDG", "GLOAM"], "largest first, unread TSLA left out");
});

check("a failed read is flagged; a vault opened after launch counts from its opening", () => {
  assert.equal(pub.networks.find((n) => n.key === "tempo-mainnet")!.readFailed, true);
  const base = pub.networks.find((n) => n.key === "base-mainnet")!;
  assert.equal(base.countsFromMs, base.openedMs);
  assert.equal(pub.networks.find((n) => n.key === "robinhood-mainnet")!.countsFromMs, MAINNET_LAUNCH_MS);
});

check("the daily rows come from sinceLaunch, without wallet counts", () => {
  assert.deepEqual(pub.daily, [{ day: launchDay, deposits: 5, transfers: 6, cashouts: 7 }]);
});

check("an older snapshot falls back to its 14 days, cut at the launch day", () => {
  const old = toPublicStats({ ...snapshot, mainnet: { ...snapshot.mainnet!, sinceLaunch: undefined } });
  assert.deepEqual(old.daily, [{ day: launchDay, deposits: 1, transfers: 2, cashouts: 3 }]);
});

check("daysSince: every UTC day from the launch to today, once, in order", () => {
  const now = MAINNET_LAUNCH_MS + 8 * 86_400_000 + 3_600_000;
  const days = daysSince(MAINNET_LAUNCH_MS, now);
  assert.equal(days[0], launchDay);
  assert.equal(days.length, 9);
  assert.equal(days[days.length - 1], new Date(now).toISOString().slice(0, 10));
  for (let i = 1; i < days.length; i++) {
    assert.equal(Date.parse(`${days[i]}T00:00:00Z`) - Date.parse(`${days[i - 1]}T00:00:00Z`), 86_400_000);
  }
  assert.deepEqual(daysSince(MAINNET_LAUNCH_MS, MAINNET_LAUNCH_MS), [launchDay]);
});

check("counted(): before launch never counts; undated counts only when surely after launch", () => {
  const L = Math.floor(MAINNET_LAUNCH_MS / 1000);
  const state = (events: ScanState["events"]): ScanState => ({ v: 1, pool: "p", scannedTo: 0, memoScannedTo: 0, memos: 0, startTs: 0, events, fee: 1 });
  const ev = (b: number, ts: number) => ({ k: "deposit" as const, b, i: 0, ts, tx: `0x${b}` });
  const s = state([ev(10, 0), ev(20, L - 60), ev(30, 0), ev(40, L + 60), ev(50, 0), ev(60, L + 120)]);
  assert.deepEqual(counted({ testnet: false }, s).events.map((e) => e.b), [40, 50, 60]);
  // nothing dated after launch yet: nothing undated counts
  assert.deepEqual(counted({ testnet: false }, state([ev(10, 0), ev(20, 0)])).events.length, 0);
  // a testnet counts everything from its deploy
  assert.equal(counted({ testnet: true }, s).events.length, 6);
});

check("actions in the totals but in no day yet are counted as undated", () => {
  // totals: 54 deposits + 278 transfers + 144 cash-outs = 476; one day holds 18
  assert.equal(pub.undated, 54 + 278 + 144 - 18);
  const all = toPublicStats({
    ...snapshot,
    networks: [net("tempo-mainnet", { deposits: 2, transfers: 1, cashouts: 1 })],
    mainnet: { ...snapshot.mainnet!, sinceLaunch: [{ day: launchDay, deposits: 2, transfers: 1, cashouts: 1, trades: 0, activeWallets: 1 }] },
  });
  assert.equal(all.undated, 0);
});

console.log(`selftest-public-stats: ${checks} checks passed`);
