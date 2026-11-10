/**
 * Self-test: the admin's view helpers (components/admin). The week's change
 * is only shown when both weeks are really there, daily counts land on the
 * right UTC day, big figures keep their sign and size, a donut never shows
 * more than four slices, and the mainnet/testnet split of product events
 * gives each side only its own events.
 *
 * Run from app/:  ../mcp/node_modules/.bin/tsx scripts/selftest-admin-view.mts
 */
import assert from "node:assert/strict";
import { claimSide, splitProduct, weekChange } from "../src/components/admin/data";
import { fmtUsdBig, fmtUsdShort, lastDays, pctText, utcDay } from "../src/components/admin/format";
import { countPoints, dayPoints, markDays } from "../src/components/admin/series";
import { topSegments } from "../src/components/admin/charts";

let checks = 0;
const ok = (cond: unknown, msg: string) => {
  assert.ok(cond, msg);
  checks++;
};

// weekChange: last 7 full days against the 7 before, today left out
ok(weekChange([]) === null, "no days, no change");
ok(weekChange(Array(14).fill(1)) === null, "14 days is one short: today is left out, so two full weeks need 15");
const flat = Array(15).fill(2);
ok(weekChange(flat) === 0, "the same every day is no change");
const doubled = [...Array(7).fill(1), ...Array(7).fill(2), 100];
ok(weekChange(doubled) === 100, "a week twice the one before is +100%, whatever today holds");
ok(weekChange([...Array(7).fill(0), ...Array(7).fill(5), 0]) === null, "an empty earlier week has no percentage");
ok(weekChange([...Array(7).fill(4), ...Array(7).fill(1), 0]) === -75, "a drop reads negative");
ok(weekChange([9, 9, 9, ...Array(7).fill(1), ...Array(7).fill(1), 0]) === 0, "only the last 15 days count");

// countPoints: one bucket per UTC day, oldest first, ending today
const now = Date.UTC(2026, 10, 10, 15, 0, 0);
const pts = countPoints(
  [now, now - 3_600_000, now - 86_400_000, Date.UTC(2026, 10, 9, 23, 59), Date.UTC(2026, 9, 1)],
  7,
  now,
  ["report", "reports"]
);
ok(pts.length === 7, "seven days");
ok(pts.at(-1)!.value === 2 && pts.at(-1)!.display === "2 reports", "two today");
ok(pts.at(-2)!.value === 2, "two yesterday, the one at 23:59 UTC included");
ok(pts.reduce((a, p) => a + p.value, 0) === 4, "a time outside the window is not counted");
ok(pts[0]!.axis === "4" && pts.at(-1)!.axis === "10", "axis shows the day of the month");
ok(countPoints([now], 3, now, ["entry", "entries"]).at(-1)!.display === "1 entry", "one is singular");
ok(lastDays(3, now).join() === "2026-11-08,2026-11-09,2026-11-10", "lastDays ends today");
ok(utcDay(Date.UTC(2026, 10, 10, 23, 59, 59)) === "2026-11-10", "utcDay is UTC");

// markDays: the days a failure fell on
const days = lastDays(7, now);
ok(markDays(pts, days, [Date.UTC(2026, 10, 8, 3)]).join() === "4", "a failure two days ago marks index 4");
ok(markDays(pts, days, [Date.UTC(2026, 9, 1)]).length === 0, "a failure outside the window marks nothing");

// dayPoints keeps the values as given
const dp = dayPoints([{ day: "2026-11-09", v: 3.5 }], (r) => r.v, fmtUsdShort);
ok(dp[0]!.value === 3.5 && dp[0]!.display === "$3.50" && dp[0]!.label === "Nov 9", "dayPoints carries the value, its words and the day");

// money words
ok(fmtUsdBig(1234.5) === "$1,234.50", "cents under $10k");
ok(fmtUsdBig(71734.12) === "$71,734", "whole dollars to $1M");
ok(fmtUsdBig(2_400_000) === "$2.4M", "compact from $1M");
ok(fmtUsdBig(null) === "Not priced", "no price is said");
ok(fmtUsdBig(0.004) === "<$0.01", "a sliver is not $0.00");
ok(fmtUsdShort(8400) === "$8.4K" && fmtUsdShort(840) === "$840", "short pill dollars");
ok(pctText(1, 300) === "<1%" && pctText(0, 5) === "0%" && pctText(1, 3) === "33%", "shares");

// topSegments: biggest three and the rest as Other, zeros dropped
const segs = topSegments(
  [
    { key: "a", label: "A", value: 5, display: "5" },
    { key: "b", label: "B", value: 0, display: "0" },
    { key: "c", label: "C", value: 9, display: "9" },
    { key: "d", label: "D", value: 1, display: "1" },
    { key: "e", label: "E", value: 2, display: "2" },
    { key: "f", label: "F", value: 3, display: "3" },
  ],
  (v) => String(v)
);
ok(segs.map((s) => s.key).join() === "c,a,f,other", "three biggest, then Other");
ok(segs[3]!.value === 3 && segs[3]!.display === "3", "Other holds the rest");
ok(topSegments([{ key: "x", label: "X", value: 0, display: "0" }], String).length === 0, "nothing to show when all are zero");

// splitProduct: mainnet counts come from the network breakdown, the testnets get the rest
const product = {
  backend: "memory" as const,
  totalEvents: 10,
  counters: { total: 10, app_view: 10 },
  dims: { "app_view|network=robinhood-mainnet": 6, "app_view|network=robinhood": 4 },
  daily: [{ day: "2026-11-09", counters: { app_view: 10, "mainnet:app_view": 6 } }],
  recent: [
    { t: "app_view", path: "/app", ref: null, meta: { network: "robinhood-mainnet" }, ts: 1, ua: null },
    { t: "app_view", path: "/app", ref: null, meta: { network: "robinhood" }, ts: 2, ua: null },
  ],
};
const main = splitProduct(product, "mainnet");
const test = splitProduct(product, "testnet");
ok(main.counters.app_view === 6 && test.counters.app_view === 4, "all-time counts split by network");
ok(main.daily[0]!.counters.app_view === 6 && test.daily[0]!.counters.app_view === 4, "a day after launch splits too");
ok(main.recent.length === 1 && test.recent.length === 1 && main.recent[0]!.ts === 1, "each side's recent events are its own");
ok(main.dims["app_view|network=robinhood-mainnet"] === 6 && !main.dims["app_view|network=robinhood"], "mainnet breakdowns hold mainnet networks only");

// claimSide: a day stored before the split is all testnet
const before = { day: "2026-10-10", link_created: 3, link_opened: 4, link_claimed: 2, claimer_sent: 1 } as never;
ok(claimSide(before, "mainnet").link_created === 0 && claimSide(before, "testnet").link_created === 3, "old days are testnet");

console.log(`selftest-admin-view: ${checks} checks passed`);
