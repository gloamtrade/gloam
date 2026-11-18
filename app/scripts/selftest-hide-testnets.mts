/**
 * Self-test: the testnets out of view (lib/showTestnets), one switch to bring
 * them back.
 *
 * Two runs of this file (the second as a child process of the first):
 *
 *  - hidden (NEXT_PUBLIC_SHOW_TESTNETS unset, as production builds it): the
 *    app's network menu and the transparency picker offer the mainnets alone, a
 *    testnet saved in this browser (or named by ?chain= on /transparency) opens
 *    on the default mainnet with no error, /verify lists no testnet, and no
 *    current page links to the testnet guide. The testnets are still networks:
 *    the API, the relay and a claim link on one keep working, and lib code
 *    follows a page a claim link moved onto a testnet.
 *  - shown (NEXT_PUBLIC_SHOW_TESTNETS=1): everything is back as before, testnets
 *    in the menu and picker, a saved testnet kept, /verify listing them.
 *
 * The flag's words are checked too: only "1", "true", "on" or "yes" turn it on.
 *
 * Run from app/:  ../mcp/node_modules/.bin/tsx scripts/selftest-hide-testnets.mts
 */
import "./browser-shim.mts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const MODE = process.env.GLOAM_SELFTEST_TESTNETS ?? "hidden";
if (MODE === "hidden") delete process.env.NEXT_PUBLIC_SHOW_TESTNETS;
else process.env.NEXT_PUBLIC_SHOW_TESTNETS = "1";
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;
globalThis.fetch = (async (url: unknown) => {
  throw new Error(`selftest-hide-testnets: no network calls allowed (${String(url)})`);
}) as typeof fetch;

const { SHOW_TESTNETS, showTestnetsFrom } = await import("../src/lib/showTestnets");
const nets = await import("../src/lib/networks");
const { contractDirectory } = await import("../src/lib/contractDirectory");

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`ok  ${name}`);
}

const SRC = fileURLToPath(new URL("../src/", import.meta.url));
const read = (p: string) => readFileSync(join(SRC, p), "utf8");
const TESTNETS = ["robinhood", "tempo", "base", "ethereum"] as const;
const STORAGE_KEY = "gloam.network";

/** What NetworkProvider opens on for this browser's saved choice (its readStored). */
function opensOn(saved: string | null): string {
  if (saved === null) window.localStorage.removeItem(STORAGE_KEY);
  else window.localStorage.setItem(STORAGE_KEY, saved);
  return nets.shownKeyOrDefault(window.localStorage.getItem(STORAGE_KEY));
}

/** The transparency picker's sides, worked out the way NetworkPicker does from SHOWN_NETWORK_KEYS. */
function pickerSides(): string[] {
  const sideOf = (k: string) => (nets.getNetwork(k as never).testnet ? "testnet" : "mainnet");
  return (["mainnet", "testnet"] as const).filter((s) => nets.SHOWN_NETWORK_KEYS.some((k) => sideOf(k) === s));
}

test("the flag: only 1, true, on or yes (any case, spaces trimmed) show the testnets", () => {
  for (const on of ["1", "true", "TRUE", " on ", "yes", "Yes"]) assert.equal(showTestnetsFrom(on), true, on);
  for (const off of [undefined, "", " ", "0", "false", "off", "no", "show", "2"]) assert.equal(showTestnetsFrom(off), false, String(off));
  assert.equal(SHOW_TESTNETS, MODE === "shown");
});

test("the testnets stay networks either way: API names, claim links, proofs and the relay still know them", () => {
  for (const k of TESTNETS) {
    assert.ok(nets.isNetworkKey(k), k);
    assert.ok(nets.NETWORK_KEYS.includes(k), k);
    assert.equal(nets.getNetwork(k).testnet, true, k);
  }
  assert.match(nets.networkKeyChoices(), /"robinhood"/, "API errors still name the testnets");
  assert.equal(nets.DEFAULT_NETWORK_KEY, "robinhood", "the server's default is unchanged");
  assert.equal(nets.ceremonyForChain(46630), "dev");
});

if (MODE === "hidden") {
  const mainnets = nets.NETWORK_KEYS.filter((k) => !nets.getNetwork(k).testnet);

  test("hidden: the network menu (NetworkSelector) lists the mainnets alone, with no Testnet group", () => {
    assert.ok(mainnets.length > 0);
    assert.deepEqual(nets.SHOWN_NETWORK_KEYS, mainnets);
    const listed = nets.shownNetworks();
    assert.deepEqual(listed.map((n) => n.key), mainnets);
    assert.ok(listed.every((n) => !n.testnet));
    for (const k of TESTNETS) assert.equal(nets.isShownNetworkKey(k), false, k);
    const selector = read("components/app/NetworkSelector.tsx");
    assert.match(selector, /const nets = shownNetworks\(\);/);
    assert.doesNotMatch(selector, /allNetworks\(\)/, "the menu never reads the full list");
    assert.match(selector, /\.filter\(\(group\) => group\.list\.length > 0\)/, "an empty Testnet group is dropped");
  });

  test("hidden: the transparency picker offers the mainnets alone, with no Mainnets or Testnets switch", () => {
    assert.deepEqual(pickerSides(), ["mainnet"]);
    const picker = read("components/transparency/NetworkPicker.tsx");
    assert.match(picker, /const keysOn = \(side: Side\) => SHOWN_NETWORK_KEYS\.filter/);
    assert.doesNotMatch(picker, /\bNETWORK_KEYS\b/);
    assert.match(picker, /\{SIDES\.length > 1 && <SideSwitch/);
  });

  test("hidden: a saved testnet opens on the default mainnet, quietly; a saved mainnet stays", () => {
    const fallback = nets.defaultNetworkKey();
    assert.equal(nets.getNetwork(fallback).testnet, false, "the default is a mainnet");
    assert.equal(fallback, mainnets[0]);
    for (const k of TESTNETS) assert.equal(opensOn(k), fallback, k);
    for (const k of ["elysium", "bogus", "", null]) assert.equal(opensOn(k), fallback, String(k));
    for (const k of mainnets) assert.equal(opensOn(k), k, k);
    // lib code (notes, tree, proofs) reads the same before NetworkProvider mounts
    window.localStorage.setItem(STORAGE_KEY, "robinhood");
    assert.equal(nets.getActiveNetwork().key, fallback, "getActiveNetwork never resolves a hidden saved testnet");
    window.localStorage.removeItem(STORAGE_KEY);
    // the first paint, server and client alike, never says testnet
    assert.equal(nets.getNetwork(nets.FIRST_PAINT_NETWORK_KEY).testnet, false);
  });

  test("hidden: NetworkProvider reads, syncs and saves only networks people can pick", () => {
    const provider = read("components/app/NetworkProvider.tsx");
    assert.match(provider, /return shownKeyOrDefault\(v\);/, "a saved testnet falls back");
    assert.match(provider, /useState<NetworkKey>\(FIRST_PAINT_NETWORK_KEY\)/);
    assert.match(provider, /e\.key === STORAGE_KEY && isShownNetworkKey\(e\.newValue\)/, "another tab's testnet claim does not move this one");
    assert.match(provider, /if \(!isShownNetworkKey\(key\)\) return;\s*\n\s*try \{\s*\n\s*window\.localStorage\.setItem\(STORAGE_KEY, key\)/, "a testnet visit is not saved");
    assert.doesNotMatch(provider, /isNetworkKey\(/);
  });

  test("hidden: a claim link on a testnet still moves the page there, and lib code follows it", () => {
    // MoveView switches with any network key a claim link names (?net=), and /claim keeps its own list
    assert.match(read("components/app/MoveView.tsx"), /if \(isNetworkKey\(net\) && net !== networkKey\) setNetworkKey\(net\);/);
    assert.match(read("app/claim/page.tsx"), /This link is on a testnet\./);
    // TestFundsNotice still says Testnet on that page, with a switch to the chain's mainnet
    assert.match(read("components/app/TestFundsNotice.tsx"), /!network\.testnet\) return null;/);
    nets.setShownNetworkKey("robinhood");
    assert.equal(nets.getActiveNetwork().key, "robinhood");
    nets.setShownNetworkKey(mainnets[0]!);
  });

  test("hidden: /transparency?chain=<testnet> opens on the default mainnet", () => {
    const view = read("components/transparency/TransparencyView.tsx");
    assert.match(view, /const first = shownKeyOrDefault\(q\);/);
    assert.match(view, /const shown: NetworkKey = active \?\? FIRST_PAINT_NETWORK_KEY;/);
    for (const k of TESTNETS) assert.equal(nets.shownKeyOrDefault(k), nets.defaultNetworkKey(), k);
    assert.equal(nets.shownKeyOrDefault("tempo-mainnet"), "tempo-mainnet");
  });

  test("hidden: /verify's contracts list and CSV hold no testnet", () => {
    const dir = contractDirectory();
    assert.ok(dir.length > 0);
    assert.ok(dir.every((e) => e.kind === "mainnet"), dir.map((e) => e.key).join());
    const section = read("components/verify/ContractsSection.tsx");
    assert.match(section, /\{SIDES\.length > 1 && <SideSwitch/);
    assert.match(section, /\.filter\(\(s\) => ENTRIES\.some\(\(e\) => e\.kind === s\.side\)\)/);
  });

  test("hidden: a wallet connecting starts on a mainnet; the testnets stay registered after them", () => {
    const wagmi = read("lib/wagmi.ts");
    assert.match(
      wagmi,
      /SHOW_TESTNETS \|\| !mainnetChains\.length \? \[\.\.\.testnetChains, \.\.\.mainnetChains\] : \[\.\.\.mainnetChains, \.\.\.testnetChains\]/
    );
    assert.match(wagmi, /\[robinhoodTestnet\.id\]: rpcListTransport/, "testnet transports stay, for claim links");
  });

  test("hidden: no current page links to the testnet guide unless the flag is on", () => {
    // Pages that may name it outright: the guide itself, dated blog posts, the faucet
    // info shown only while the page is on a testnet, the network and SDK references
    // for developers, and the docs search's description of the page (searched only
    // through the docs nav, which leaves it out).
    const allowed = new Set([
      "lib/faucet.ts",
      "app/docs/chain/page.tsx",
      "app/docs/quickstart/page.tsx",
      "components/docs/DocsSearch.tsx",
    ]);
    const files: string[] = [];
    const walk = (d: string) => {
      for (const f of readdirSync(d)) {
        const p = join(d, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.tsx?$/.test(f)) files.push(relative(SRC, p));
      }
    };
    walk(SRC);
    const linking = files.filter(
      (f) =>
        !f.startsWith("app/blog/") &&
        !f.startsWith("app/docs/testnet/") &&
        !f.startsWith("app/api/") &&
        !f.startsWith("lib/telegramBot/") &&
        /["'`]\/docs\/testnet/.test(read(f))
    );
    assert.ok(linking.length >= 10, `${linking.length} files`);
    for (const f of linking) {
      if (allowed.has(f)) continue;
      assert.match(read(f), /SHOW_TESTNETS/, `${f} links the testnet guide without the flag`);
    }
    const nav = read("components/docs/DocsNav.tsx");
    assert.match(nav, /\.\.\.\(SHOW_TESTNETS \? \[\{ href: "\/docs\/testnet", label: "Practice on testnet" \}\] : \[\]\)/);
    const footer = read("components/Footer.tsx");
    assert.match(footer, /\.\.\.\(SHOW_TESTNETS \? \[\{ href: "\/docs\/testnet", label: "Testnet guide" \}\] : \[\]\)/);
    assert.match(read("app/docs/testnet/page.tsx"), /SHOW_TESTNETS \? \{\} : \{ robots: \{ index: false \} \}/, "the guide is out of search");
  });

  // ------------------------------------------------------------- shown, in a child process
  const child = spawnSync(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url)], {
    env: { ...process.env, GLOAM_SELFTEST_TESTNETS: "shown" },
    encoding: "utf8",
  });
  process.stdout.write(child.stdout);
  process.stderr.write(child.stderr);
  assert.equal(child.status, 0, "the run with NEXT_PUBLIC_SHOW_TESTNETS=1 failed");
  console.log(`selftest-hide-testnets (hidden): ${passed} passed`);
} else {
  test("shown: the menu and the picker list every network, testnets after the mainnets", () => {
    assert.deepEqual(nets.SHOWN_NETWORK_KEYS, nets.NETWORK_KEYS);
    assert.deepEqual(nets.shownNetworks().map((n) => n.key), nets.allNetworks().map((n) => n.key));
    for (const k of TESTNETS) assert.ok(nets.isShownNetworkKey(k), k);
    assert.deepEqual(pickerSides(), ["mainnet", "testnet"]);
  });

  test("shown: a saved testnet is kept, and the first paint is the server's default as before", () => {
    for (const k of TESTNETS) assert.equal(opensOn(k), k, k);
    assert.equal(opensOn("bogus"), nets.defaultNetworkKey());
    assert.equal(nets.FIRST_PAINT_NETWORK_KEY, nets.DEFAULT_NETWORK_KEY);
    window.localStorage.setItem(STORAGE_KEY, "tempo");
    assert.equal(nets.getActiveNetwork().key, "tempo");
    window.localStorage.removeItem(STORAGE_KEY);
  });

  test("shown: /verify lists the testnets after the mainnets", () => {
    const kinds = contractDirectory().map((e) => e.kind);
    assert.ok(kinds.includes("testnet"));
    assert.equal(kinds.indexOf("testnet"), kinds.lastIndexOf("mainnet") + 1);
  });

  console.log(`selftest-hide-testnets (shown): ${passed} passed`);
}
