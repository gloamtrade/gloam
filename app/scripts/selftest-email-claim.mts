/**
 * Self-test: claiming a payment link by signing in with an email (a Gloam
 * wallet, Turnkey) as well as with a wallet, on every mainnet.
 *
 *  - the /claim page's line under Claim it (lib/claimHelp): email sign-in on
 *    every Gloam network while Gloam wallets are on, with a wallet next to it;
 *    with them off it says plainly that email sign-in isn't available and what
 *    gets in instead; the "open it in your wallet app" card only when nothing
 *    else on a phone does
 *  - the claim stays in the fragment: the app path carries it after "#" only,
 *    and reads back the same code
 *  - the hand-off across sign-in (lib/claimLinkStore): the code a link opened is
 *    kept for this tab until it is claimed, so a reload while the person reads
 *    the email code brings it back; it is dropped once claimed, edited or too
 *    old; odd values never come back; blocked storage never throws; it holds
 *    the code and network only, and nothing in it sends or logs anything
 *  - the new-wallet sheet goes back to a waiting claim (claimWaiting, goToClaim)
 *  - the welcome never covers a claim (WelcomeModal's head-start script, run here)
 *  - the claim page names an Elysium amount from Elysium's own tokens
 *  - the wiring in Pay > Receive, the claim page, the welcome and the new-wallet
 *    sheet, read from the source
 *
 * Securing a claim through the Gloam relay with a wallet that holds no gas (the
 * wallet is never asked to send) is covered by selftest-claim-sweep.mts.
 *
 * Run from app/:  ../mcp/node_modules/.bin/tsx scripts/selftest-email-claim.mts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import "./browser-shim.mjs";

const env = process.env as Record<string, string | undefined>;
env.NEXT_PUBLIC_TURNKEY_ENABLED = "true";
env.NEXT_PUBLIC_TURNKEY_ORGANIZATION_ID = "org-test";
env.NEXT_PUBLIC_TURNKEY_AUTH_PROXY_CONFIG_ID = "proxy-test";

const { claimNeedsWalletApp, claimSignInLine, emailClaimOn } = await import("../src/lib/claimHelp");
const store = await import("../src/lib/claimLinkStore");
const { CLAIM_LINK_KEEP_MS, claimWaiting, dropClaimLink, goToClaim, keepClaimLink, keptClaimLink, onClaimWaiting, onGoToClaim, setClaimWaiting } = store;
const { appClaimPath, claimLinkFor, codeFromHash } = await import("../src/lib/claimLink");
const { NETWORK_KEYS, getNetwork, setShownNetworkKey } = await import("../src/lib/networks");
const { assetLabel, formatAssetAmount } = await import("../src/lib/shield");
const { shieldTokensFor } = await import("../src/lib/tokens");

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`ok  ${name}`);
}

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
/** The live mainnets in this build: Elysium unless NEXT_PUBLIC_ELYSIUM_ENABLED turns it off. */
const MAINNETS = (["robinhood-mainnet", "base-mainnet", "ethereum-mainnet", "tempo-mainnet", "elysium-mainnet"] as const).filter((k) =>
  NETWORK_KEYS.includes(k)
);
const elysiumOn = NETWORK_KEYS.includes("elysium-mainnet");
const label = (k: string) => getNetwork(k as (typeof NETWORK_KEYS)[number]).label;
const SHORT = "gloam3.ZdA2MpbegfJCpxPZ6yWS8WI8wxs7tdKXhKwQx7xD8lxd2ny8";
const LONG = "gloam1.eyJ2IjoxLCJzIjoiMHgxMjM0NTY3ODkwYWJjZGVmIiwiYSI6IjEwMDAwMDAifQ";
/** base64url's "-" and "_", which the link writes as "=1" and "=2" so chat apps keep them in the link. */
const ESCAPED = "gloam1.eyJ2-IjoxLCJz_IjoiMHgxMjM0NTY3ODkw";
const ss = () => (globalThis as unknown as { window: { sessionStorage: Storage } }).window.sessionStorage;

/* ---------------------------------------------------------------- the claim page's line */

test("every live mainnet offers email sign-in while Gloam wallets are on, none while they're off", () => {
  assert.ok(MAINNETS.length >= 4, "Robinhood Chain, Base, Ethereum and Tempo at least");
  for (const k of MAINNETS) {
    assert.equal(emailClaimOn(k, true), true, k);
    assert.equal(emailClaimOn(k, false), false, k);
  }
  for (const k of NETWORK_KEYS) assert.equal(emailClaimOn(k, true), true, `${k}: the Gloam wallet signs on every Gloam network`);
  assert.equal(emailClaimOn("solana", true), false);
  assert.equal(emailClaimOn("", true), false);
  // the default reads the build's switch, which this test turned on
  assert.equal(emailClaimOn("base-mainnet"), true);
});

test("with email on, the line offers email first and a wallet beside it, on every mainnet", () => {
  for (const k of MAINNETS) {
    for (const walletConnect of [true, false]) {
      const i = { email: true, networkKey: k, networkLabel: label(k), walletBrowser: false, walletConnect };
      assert.equal(claimSignInLine(i), "On the next screen, sign in with your email or connect a wallet.");
      assert.equal(claimNeedsWalletApp(i), false, `${k}: no "open it in your wallet app" card when email gets in`);
      const wb = { ...i, walletBrowser: true };
      assert.equal(claimSignInLine(wb), "On the next screen, sign in with your email or use this wallet.");
      assert.equal(claimNeedsWalletApp(wb), false);
    }
  }
});

test("with email off, the line says so plainly and names what gets in instead", () => {
  for (const k of MAINNETS) {
    const off = { email: false, networkKey: k, networkLabel: label(k), walletBrowser: false, walletConnect: false };
    assert.equal(
      claimSignInLine(off),
      `Email sign-in isn't available here yet. You'll need a wallet app such as MetaMask or Rabby to claim on ${label(k)}.`
    );
    assert.equal(claimNeedsWalletApp(off), true, `${k}: the phone card shows when only a wallet app gets in`);
    const wc = { ...off, walletConnect: true };
    assert.equal(claimSignInLine(wc), "Email sign-in isn't available here yet. Connect a wallet on the next screen.");
    assert.equal(claimNeedsWalletApp(wc), false);
    const wb = { ...off, walletBrowser: true };
    assert.equal(claimSignInLine(wb), "Connect your wallet on the next screen.");
    assert.equal(claimNeedsWalletApp(wb), false);
  }
  // Tempo testnet's passkey account, which the app offers while Gloam wallets are off
  const tempo = { email: false, networkKey: "tempo", networkLabel: "Tempo", walletBrowser: false, walletConnect: false };
  assert.equal(claimSignInLine(tempo), "No wallet needed: sign in with a passkey on the next screen.");
  assert.equal(claimNeedsWalletApp(tempo), false);
});

test("the claim page's lines keep the copy rules", () => {
  const lines: string[] = [];
  for (const k of [...MAINNETS, "tempo"])
    for (const email of [true, false])
      for (const walletBrowser of [true, false])
        for (const walletConnect of [true, false])
          lines.push(claimSignInLine({ email, networkKey: k, networkLabel: label(k), walletBrowser, walletConnect }));
  for (const l of new Set(lines)) {
    assert.ok(!/—|–/.test(l), `no dashes: ${l}`);
    assert.ok(!/happy to|real money|test money|seamless/i.test(l), l);
    assert.match(l, /^[A-Z]/, `sentence case: ${l}`);
    assert.ok(l.endsWith("."), l);
  }
});

/* ---------------------------------------------------------------- the fragment */

test("the claim rides in the fragment only, and the app reads back the same code", () => {
  for (const k of MAINNETS) {
    for (const code of [SHORT, LONG, ESCAPED]) {
      const path = appClaimPath(code, k);
      const [before, frag] = path.split("#");
      assert.ok(frag && frag.startsWith("claim="), path);
      assert.ok(!before.includes("gloam1") && !before.includes("gloam3") && !before.includes(code.slice(7, 20)), `no code before #: ${before}`);
      assert.deepEqual(
        [...new URLSearchParams(before.split("?")[1]).keys()].sort(),
        ["mode", "net", "tab"],
        "the query names the screen and the network, nothing else"
      );
      assert.equal(codeFromHash(`#${frag}`), code, `${k}: read back as sent`);
      // and what the app reads back is what the tab keeps
      keepClaimLink(codeFromHash(`#${frag}`)!, k);
      assert.equal(keptClaimLink()?.code, code);
      dropClaimLink();
    }
  }
  // the long link from a payer keeps it after the "#" too
  const link = claimLinkFor(LONG, "base-mainnet");
  assert.ok(link.split("#")[0].indexOf("gloam1") === -1, link);
});

/* ---------------------------------------------------------------- the hand-off across sign-in */

test("a link's code is kept for the tab and comes back after a reload, with its network", () => {
  ss().clear();
  const t0 = 1_800_000_000_000;
  keepClaimLink(SHORT, "tempo-mainnet", t0);
  // a reload: the page's memory is gone, the tab's storage is not
  assert.deepEqual(keptClaimLink(t0 + 60_000), { code: SHORT, on: "tempo-mainnet" });
  // what is stored: the code, its network and when, nothing about the person
  assert.deepEqual(Object.keys(JSON.parse(ss().getItem("gloam.claimLink")!)).sort(), ["at", "code", "on"]);
  assert.equal(ss().length, 1);
  keepClaimLink(LONG, null, t0);
  assert.deepEqual(keptClaimLink(t0), { code: LONG, on: null }, "a link with no network keeps none");
  keepClaimLink(SHORT, "nowhere" as never, t0);
  assert.deepEqual(keptClaimLink(t0), { code: SHORT, on: null }, "an unknown network is not kept");
});

test("claimed, edited or too old: the tab stops keeping it", () => {
  ss().clear();
  const t0 = 1_800_000_000_000;
  keepClaimLink(SHORT, "base-mainnet", t0);
  dropClaimLink();
  assert.equal(keptClaimLink(t0), null, "dropped once claimed");
  assert.equal(ss().getItem("gloam.claimLink"), null);
  keepClaimLink(SHORT, "base-mainnet", t0);
  assert.equal(keptClaimLink(t0 + CLAIM_LINK_KEEP_MS), null, "too old");
  assert.equal(ss().getItem("gloam.claimLink"), null, "and removed, not just ignored");
  keepClaimLink(SHORT, "base-mainnet", t0);
  assert.equal(keptClaimLink(t0 - 1), null, "a time from the future reads as damaged");
  assert.equal(CLAIM_LINK_KEEP_MS, 30 * 60_000);
});

test("only payment codes are kept, and nothing odd ever comes back", () => {
  ss().clear();
  const t0 = 1_800_000_000_000;
  for (const bad of ["", "gloam9.abcdefghijklmnopqrst", "https://gloam.trade/c#ZdA2Mpbeg", "gloam3.short", `gloam3.${"a".repeat(9000)}`, "gloam3.abc<script>defghijklmnop"]) {
    keepClaimLink(bad, "base-mainnet", t0);
    assert.equal(ss().getItem("gloam.claimLink"), null, `not kept: ${bad.slice(0, 30)}`);
  }
  for (const good of [SHORT, LONG, "gloam1e.abcdefghijklmnopqrstuv", "gloam2t.abcdefghijklmnopqrstuv", "gloam1e.a1b2c3d4e5f6.g7h8i9j0k1l2"]) {
    keepClaimLink(good, "base-mainnet", t0);
    assert.equal(keptClaimLink(t0)?.code, good);
  }
  for (const raw of ["{not json", JSON.stringify({ code: "x", on: null, at: t0 }), JSON.stringify({ code: SHORT, on: "nowhere", at: t0 }), JSON.stringify({ code: SHORT, on: null }), "null", "7"]) {
    ss().setItem("gloam.claimLink", raw);
    assert.equal(keptClaimLink(t0), null, raw);
    assert.equal(ss().getItem("gloam.claimLink"), null, `dropped: ${raw}`);
  }
});

test("storage that refuses never throws: the payment just stays in the page", () => {
  const w = (globalThis as unknown as { window: { sessionStorage: unknown } }).window;
  const real = w.sessionStorage;
  w.sessionStorage = {
    getItem() {
      throw new Error("SecurityError");
    },
    setItem() {
      throw new Error("QuotaExceededError");
    },
    removeItem() {
      throw new Error("SecurityError");
    },
  };
  try {
    keepClaimLink(SHORT, "base-mainnet");
    assert.equal(keptClaimLink(), null);
    dropClaimLink();
  } finally {
    w.sessionStorage = real;
  }
});

test("the new-wallet sheet hears a waiting claim, and its button goes back to it", () => {
  let heard = 0;
  const off = onClaimWaiting(() => heard++);
  setClaimWaiting(false);
  assert.equal(heard, 0, "no change, no call");
  setClaimWaiting(true);
  setClaimWaiting(true);
  assert.equal(claimWaiting(), true);
  assert.equal(heard, 1);
  setClaimWaiting(false);
  assert.equal(heard, 2);
  off();
  setClaimWaiting(true);
  assert.equal(heard, 2, "unsubscribed");
  setClaimWaiting(false);
  let went = 0;
  const stop = onGoToClaim(() => went++);
  goToClaim();
  assert.equal(went, 1);
  stop();
  goToClaim();
  assert.equal(went, 1);
});

test("the store never sends, logs or tracks anything", () => {
  const src = read("../src/lib/claimLinkStore.ts");
  assert.doesNotMatch(src, /fetch\(|sendBeacon|console\.|track\(|localStorage|@\/lib\/track|XMLHttpRequest/);
  assert.match(src, /window\.sessionStorage/);
});

/* ---------------------------------------------------------------- the welcome */

test("the welcome's head-start script stays shut over a claim link and a kept claim", () => {
  const src = read("../src/components/app/WelcomeModal.tsx");
  const m = src.match(/const REVEAL_SCRIPT = `([^`]+)`/);
  assert.ok(m, "the head-start script");
  const script = m[1]!.replace("${SHOWN_KEY}", "gloam_mainnet_welcome_v1");
  const run = (hash: string, kept: string | null, shown: string | null = null) => {
    const el = { hidden: true };
    const local = new Map<string, string>(shown ? [["gloam_mainnet_welcome_v1", shown]] : []);
    const session = new Map<string, string>(kept ? [["gloam.claimLink", kept]] : []);
    new Function("localStorage", "sessionStorage", "location", "document", script)(
      { getItem: (k: string) => local.get(k) ?? null },
      { getItem: (k: string) => session.get(k) ?? null },
      { hash, search: "?tab=move&mode=receive&net=base-mainnet" },
      { getElementById: (id: string) => (id === "gl-welcome" ? el : null) }
    );
    return el.hidden;
  };
  assert.equal(run("", null), false, "a first visit sees the welcome");
  assert.equal(run("", null, "1"), true, "once dismissed, never again");
  assert.equal(run("#claim=gloam3=ZdA2MpbegfJCpxPZ6yWS8WI8wxs7tdKXhKwQx7xD8lxd2ny8", null), true, "not over a claim link");
  assert.equal(run("", JSON.stringify({ code: SHORT, on: "base-mainnet", at: 1 })), true, "not over a claim this tab keeps (after a reload)");
  assert.equal(run("#from=USDG", null), false, "other fragments still see it");
  assert.match(src, /readDemo\(\) \|\| openingClaim\(\)/, "React's own check matches the script");
  assert.match(read("../src/lib/claimLinkStore.ts"), /const KEY = "gloam\.claimLink";/, "the script reads the store's key");
});

/* ---------------------------------------------------------------- the claim page's amount */

test("an Elysium link's amount reads from Elysium's tokens, whatever network the browser saved", () => {
  if (!elysiumOn) return;
  const usdc = shieldTokensFor(getNetwork("elysium-mainnet").chainId).find((t) => t.symbol === "USDC");
  assert.ok(usdc, "Elysium lists USDC");
  setShownNetworkKey("robinhood-mainnet");
  assert.notEqual(assetLabel(usdc.address), "USDC", "read from another network, it has no name (the bug)");
  setShownNetworkKey("elysium-mainnet");
  assert.equal(assetLabel(usdc.address), "USDC");
  assert.equal(formatAssetAmount((10n ** BigInt(usdc.decimals)).toString(), usdc.address), "1");
  const page = read("../src/app/claim/page.tsx");
  const at = page.indexOf("setShownNetworkKey(net);");
  assert.ok(at > 0 && at < page.indexOf("amount = formatAssetAmount(pack.amountWei, pack.asset);"), "set before the amount is read");
  assert.ok(page.indexOf("if (own) net = own;") < at, "after the code's own chain is known");
});

/* ---------------------------------------------------------------- the wiring */

test("the claim page says how the next screen lets people in, from lib/claimHelp", () => {
  const page = read("../src/app/claim/page.tsx");
  assert.match(page, /email: emailClaimOn\(view\.net\)/);
  assert.match(page, /\{claimSignInLine\(signIn\)\}/);
  assert.match(page, /signIn && claimNeedsWalletApp\(signIn\) &&/);
  assert.doesNotMatch(page, /You'll need a wallet app such as MetaMask/, "the old line lives in lib/claimHelp now");
  // the claim page's strict CSP leaves out wallet code: lib/claimHelp pulls none in
  const help = read("../src/lib/claimHelp.ts");
  assert.doesNotMatch(help, /wagmi|@turnkey|turnkeyBridge|walletConnect"|from "react"/);
});

test("Pay > Receive keeps the link it reads, brings it back once, and drops it once claimed", () => {
  const view = read("../src/components/app/MoveView.tsx");
  // read from the address bar: cleared there, kept for the tab
  assert.match(view, /window\.history\.replaceState\(window\.history\.state, "", window\.location\.pathname \+ window\.location\.search\);[\s\S]{0,200}keepClaimLink\(code, isNetworkKey\(net\) \? net : null\);/);
  // after a reload: once, on Receive only, never over a link in the bar or text in the box
  const restore = view.slice(view.indexOf("const restoredClaim = useRef(false);"), view.indexOf("const claimInBox ="));
  assert.match(restore, /if \(codeFromHash\(window\.location\.hash\)\) return;/);
  assert.match(restore, /!== "receive"\) return;/);
  assert.match(restore, /setImportText\(\(now\) => \(now\.trim\(\) \? now : kept\.code\)\)/);
  assert.match(restore, /restoredClaim\.current = true;/);
  // claimed: dropped before anything else can fail
  assert.match(view, /const r = await claimCode\(importText, importPassphrase\);\s*\n\s*if \(r\.isNew\) countLinkClaimed\(importText\);\s*\n\s*\/\/[^\n]*\n\s*dropClaimLink\(\);/);
  // an edit, or another payment picked from the list
  assert.match(view, /setImportText\(e\.target\.value\);\s*\n\s*dropClaimLink\(\);/);
  assert.match(view, /setImportText\(row\.ticket\);\s*\n\s*dropClaimLink\(\);/);
  // the way back from the new-wallet sheet, and the waiting flag
  assert.match(view, /id="claim-submit"/);
  assert.match(view, /setClaimWaiting\(claimInBox\);/);
  assert.match(view, /useEffect\(\(\) => \(\) => setClaimWaiting\(false\), \[\]\);/);
  // the scroll to the claim is its own effect: the link's network switch no longer cancels it
  assert.doesNotMatch(view, /window\.clearTimeout\(scroll\)/);
  assert.match(view, /setClaimScroll\(\(n\) => n \+ 1\);/);
  // the prompt names email sign-in while the kit can run
  assert.match(view, /`Sign in with your email or connect a wallet to \$\{action\}\.`/);
  assert.match(view, /const signInOffered = EMBEDDED_WALLETS && embeddedState !== "unavailable";/);
});

test("the new-wallet sheet goes back to a waiting claim, unless Add funds was asked for", () => {
  const flow = read("../src/components/app/EmbeddedWalletFlow.tsx");
  assert.match(flow, /const claimNext = useSyncExternalStore\(onClaimWaiting, claimWaiting, \(\) => false\);/);
  assert.match(flow, /claimNext=\{claimNext && !fundingAsked\}/);
  assert.match(flow, /if \(req === "funding"\) \{\s*\n\s*setFunding\(true\);\s*\n\s*setFundingAsked\(true\);/);
  assert.match(flow, /onLeave\(\);\s*\n\s*goToClaim\(\);/);
  assert.match(flow, />\s*Back to your payment\s*</);
  assert.match(flow, /\? "Your wallet is ready"/);
});

console.log(`\n${passed} email-claim checks passed`);
