/**
 * Self-test: the "Private stocks are live" notice is decided before the first
 * paint, so it never pushes the page down when the app's JavaScript arrives.
 *
 *  - the script after the notice (lib/stocksNotice) shows it exactly when the app
 *    would once React runs: NetworkProvider's reading of the network (the one
 *    picked here, else the first mainnet), not closed here, not a testnet, not
 *    already on the Swap it points to; blocked storage keeps it hidden
 *  - the wiring: the notice is in the server's HTML (no Suspense around it, the
 *    search params read apart), sent hidden, with the script right after it
 *
 * Run from app/:  ../mcp/node_modules/.bin/tsx scripts/selftest-stocks-notice.mts
 */
import "./browser-shim.mts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { NETWORK_KEYS, defaultNetworkKey, getNetwork, isNetworkKey } from "../src/lib/networks";
import {
  NETWORK_STORAGE_KEY,
  STOCKS_NOTICE_ID,
  STOCKS_NOTICE_KEY,
  STOCKS_NOTICE_MAINNET,
  stocksNoticeRevealScript,
} from "../src/lib/stocksNotice";

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`ok  ${name}`);
}

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

/** Runs the script in a page with this storage and address; says whether the notice is shown. */
function firstPaint(stored: Record<string, string>, path = "/app", search = "", storageThrows = false): boolean {
  const el = { hidden: true };
  const ctx = {
    localStorage: {
      getItem(k: string) {
        if (storageThrows) throw new Error("SecurityError");
        return k in stored ? stored[k]! : null;
      },
    },
    location: { pathname: path, search },
    document: { getElementById: (id: string) => (id === STOCKS_NOTICE_ID ? el : null) },
    URLSearchParams,
  };
  vm.runInNewContext(stocksNoticeRevealScript(), ctx);
  return !el.hidden;
}

/** What StocksLiveNotice shows once React runs (NetworkProvider readStored, then the notice's rules). */
function afterReact(stored: Record<string, string>, path = "/app", search = ""): boolean {
  if (stored[STOCKS_NOTICE_KEY] === "1") return false;
  const v = stored[NETWORK_STORAGE_KEY];
  const key = isNetworkKey(v) ? v : defaultNetworkKey();
  if (getNetwork(key).testnet) return false;
  const tab = new URLSearchParams(search).get("tab");
  return !(key === STOCKS_NOTICE_MAINNET && path === "/app/vault" && tab === "swap");
}

const live = isNetworkKey(STOCKS_NOTICE_MAINNET);

test("the first paint shows the notice exactly when the app would", () => {
  const nets = [undefined, "bogus", ...NETWORK_KEYS];
  const pages: [string, string][] = [
    ["/app", ""],
    ["/app/vault", "?tab=swap"],
    ["/app/vault", "?tab=move&mode=pay"],
    ["/app/payroll", "?tab=swap"],
  ];
  let cases = 0;
  for (const net of nets)
    for (const closed of [false, true])
      for (const [path, search] of pages) {
        const stored: Record<string, string> = {};
        if (net !== undefined) stored[NETWORK_STORAGE_KEY] = net;
        if (closed) stored[STOCKS_NOTICE_KEY] = "1";
        assert.equal(firstPaint(stored, path, search), afterReact(stored, path, search), `${net} closed=${closed} ${path}${search}`);
        cases++;
      }
  assert.ok(cases >= 40, `${cases} cases`);
});

test("the cases people hit", () => {
  if (!live) return;
  assert.equal(firstPaint({}), true, "a new visitor lands on the first mainnet and sees it in the first paint");
  assert.equal(firstPaint({ [STOCKS_NOTICE_KEY]: "1" }), false, "closed here: never painted");
  assert.equal(firstPaint({ [NETWORK_STORAGE_KEY]: "robinhood" }), false, "on a testnet: never painted");
  assert.equal(firstPaint({ [NETWORK_STORAGE_KEY]: STOCKS_NOTICE_MAINNET }, "/app/vault", "?tab=swap"), false, "already on the Swap");
  assert.equal(firstPaint({}, "/app", "", true), false, "storage that can't be read: hidden, React decides");
});

test("the notice is in the server's HTML, sent hidden, with the script right after it", () => {
  const shell = read("../src/components/app/AppShell.tsx");
  assert.doesNotMatch(shell, /<Suspense fallback=\{null\}>\s*<StocksLiveNotice \/>/, "a Suspense around it kept it out of the HTML");
  assert.match(shell, /<StocksLiveNotice \/>/);
  const notice = read("../src/components/app/StocksLiveNotice.tsx");
  assert.match(notice, /id=\{STOCKS_NOTICE_ID\}\s*\n\s*hidden\s*\n\s*suppressHydrationWarning/);
  assert.match(notice, /<\/div>\s*\n\s*<script dangerouslySetInnerHTML=\{\{ __html: REVEAL_SCRIPT \}\} \/>/);
  // the search params are read apart, in their own Suspense
  assert.equal(notice.match(/useSearchParams\(\)/g)?.length, 1);
  assert.match(notice, /function TabProbe[\s\S]*?useSearchParams\(\)/);
  assert.match(notice, /<Suspense fallback=\{null\}>\s*\n\s*<TabProbe onTab=\{setTab\} \/>/);
  // React takes over only once the network, the tab and the closed flag are all read
  assert.match(notice, /const known = hydrated && settled && tab !== null;/);
  assert.match(notice, /if \(known && box\.current\) box\.current\.hidden = !show;/);
});

console.log(`selftest-stocks-notice: ${passed} passed`);
