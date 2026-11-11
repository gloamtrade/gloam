/**
 * Self-test: claiming a payment link by signing in with an email (a Gloam
 * wallet, Turnkey) as well as with a wallet, on every mainnet.
 *
 *  - the /claim page's line under Claim it (lib/claimHelp): email sign-in on
 *    every Gloam network while Gloam wallets are on and claiming is free (the
 *    relay is up and this browser leaves it on), with a wallet next to it; with
 *    the relay off the wallet lines and the wallet-app card stand as before;
 *    with Gloam wallets off it says plainly that email sign-in isn't available
 *    and what gets in instead
 *  - the claim stays in the fragment: the app path carries it after "#" only,
 *    and reads back the same code
 *  - the hand-off across sign-in (lib/claimLinkStore): the code a link opened is
 *    kept for this tab until it is claimed, so a reload while the person reads
 *    the email code brings it back; it lasts 15 minutes and an old one is
 *    scrubbed when a page loads the store and on every keep; it is dropped once
 *    claimed, dead (claimed already, no value, not what the vault holds),
 *    edited, or on an explicit Sign out or Disconnect, which also empties the
 *    claim box; odd values never come back; blocked storage never throws; it
 *    holds the code and network only, and nothing in it sends or logs anything
 *  - the new-wallet sheet goes back to a waiting claim (claimWaiting, goToClaim)
 *    only while claiming is free, and not after Add funds from the menu
 *  - the welcome never covers a claim (WelcomeModal's head-start script, run here)
 *  - the claim page names an Elysium amount from Elysium's own tokens, and the
 *    chain's own coin by the link's chain (HYPE on Elysium), never by the
 *    network the browser saved
 *  - the wiring in Pay > Receive, the claim page, the welcome, the wallet menu,
 *    Settings and the new-wallet sheet, read from the source; the claim page's
 *    help pulls in no wallet code (its whole import graph is walked)
 *  - Glim's facts: with Gloam wallets on, a claim link is claimed by signing in
 *    with an email on every mainnet, not "Robinhood Chain needs a wallet app"
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

// An old kept link already in the tab when a page loads the store: it is scrubbed on load.
const winAtLoad = (globalThis as unknown as { window: { sessionStorage: Storage } }).window;
winAtLoad.sessionStorage.setItem(
  "gloam.claimLink",
  JSON.stringify({ code: "gloam3.ZdA2MpbegfJCpxPZ6yWS8WI8wxs7tdKXhKwQx7xD8lxd2ny8", on: "base-mainnet", at: Date.now() - 16 * 60_000 })
);

const { claimFirstAfterWallet, claimNativeSymbol, claimNeedsWalletApp, claimSignInLine, emailClaimOn } = await import("../src/lib/claimHelp");
const scrubbedOnLoad = winAtLoad.sessionStorage.getItem("gloam.claimLink") === null;
const store = await import("../src/lib/claimLinkStore");
const {
  CLAIM_LINK_KEEP_MS,
  claimWaiting,
  dropClaimLink,
  forgetClaim,
  goToClaim,
  keepClaimLink,
  keptClaimLink,
  onClaimWaiting,
  onForgetClaim,
  onGoToClaim,
  scrubClaimLink,
  setClaimWaiting,
} = store;
const scrubbedByStore = winAtLoad.sessionStorage.getItem("gloam.claimLink") === null;
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

test("with email on and the relay up, the line offers email first and a wallet beside it, on every mainnet", () => {
  for (const k of MAINNETS) {
    for (const walletConnect of [true, false]) {
      const i = { email: true, relayUp: true, networkKey: k, networkLabel: label(k), walletBrowser: false, walletConnect };
      assert.equal(claimSignInLine(i), "On the next screen, sign in with your email or connect a wallet.");
      assert.equal(claimNeedsWalletApp(i), false, `${k}: no "open it in your wallet app" card when email gets in`);
      const wb = { ...i, walletBrowser: true };
      assert.equal(claimSignInLine(wb), "On the next screen, sign in with your email or use this wallet.");
      assert.equal(claimNeedsWalletApp(wb), false);
    }
  }
});

test("with the relay off (down here, or turned off in this browser), the wallet lines and the card stand as before", () => {
  // a new email wallet holds no gas, so email first would lead to a claim that can't be secured
  for (const k of [...MAINNETS, "tempo"]) {
    const i = { email: true, relayUp: false, networkKey: k, networkLabel: label(k), walletBrowser: false, walletConnect: false };
    assert.equal(claimSignInLine(i), `You'll need a wallet app such as MetaMask or Rabby to claim on ${label(k)}.`, k);
    assert.equal(claimNeedsWalletApp(i), true, `${k}: the wallet-app card is back`);
    assert.equal(claimSignInLine({ ...i, walletConnect: true }), "Connect a wallet on the next screen.");
    assert.equal(claimNeedsWalletApp({ ...i, walletConnect: true }), false);
    assert.equal(claimSignInLine({ ...i, walletBrowser: true }), "Connect your wallet on the next screen.");
    assert.equal(claimNeedsWalletApp({ ...i, walletBrowser: true }), false);
  }
  const page = read("../src/app/claim/page.tsx");
  // the network's relay and this browser's own setting, as Pay > Receive reads them
  assert.match(page, /setRelayUp\(Boolean\(r\?\.enabled\) && relayPreferred\(\)\)/);
  assert.match(page, /view\.kind === "ready" && relayUp !== null/, "said once the relay answered, never changed under the reader");
  assert.match(page, /email: emailClaimOn\(view\.net\),\s*\n\s*relayUp,/);
});

test("after a new wallet, back to the payment only while the claim is free and Add funds wasn't asked for", () => {
  for (const waiting of [true, false])
    for (const relayUp of [true, false])
      for (const fundingAsked of [true, false])
        assert.equal(claimFirstAfterWallet({ waiting, relayUp, fundingAsked }), waiting && relayUp && !fundingAsked, JSON.stringify({ waiting, relayUp, fundingAsked }));
});

test("with email off, the line says so plainly and names what gets in instead", () => {
  for (const k of MAINNETS) {
    for (const relayUp of [true, false]) {
    const off = { email: false, relayUp, networkKey: k, networkLabel: label(k), walletBrowser: false, walletConnect: false };
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
  }
  // Tempo testnet's passkey account, which the app offers while Gloam wallets are off
  const tempo = { email: false, relayUp: true, networkKey: "tempo", networkLabel: "Tempo", walletBrowser: false, walletConnect: false };
  assert.equal(claimSignInLine(tempo), "No wallet needed: sign in with a passkey on the next screen.");
  assert.equal(claimNeedsWalletApp(tempo), false);
});

test("the claim page's lines keep the copy rules", () => {
  const lines: string[] = [];
  for (const k of [...MAINNETS, "tempo"])
    for (const email of [true, false])
      for (const relayUp of [true, false])
        for (const walletBrowser of [true, false])
          for (const walletConnect of [true, false])
            lines.push(claimSignInLine({ email, relayUp, networkKey: k, networkLabel: label(k), walletBrowser, walletConnect }));
  for (const l of new Set(lines)) {
    assert.ok(!/\u2014|\u2013/.test(l), `no dashes: ${l}`);
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
  assert.equal(CLAIM_LINK_KEEP_MS, 15 * 60_000, "15 minutes");
});

test("an old kept link is scrubbed when a page loads the store and on every keep, not only when the app reads it", () => {
  assert.ok(scrubbedByStore, "loading the store removed one 16 minutes old");
  assert.equal(scrubbedOnLoad, false, "the claim page's help loads no store, so the scrub is the store's own");
  ss().clear();
  const t0 = 1_800_000_000_000;
  keepClaimLink(SHORT, "base-mainnet", t0);
  scrubClaimLink(t0 + CLAIM_LINK_KEEP_MS - 1);
  assert.equal(keptClaimLink(t0 + CLAIM_LINK_KEEP_MS - 1)?.code, SHORT, "a fresh one stays");
  scrubClaimLink(t0 + CLAIM_LINK_KEEP_MS);
  assert.equal(ss().getItem("gloam.claimLink"), null, "an old one goes");
  // a keep that keeps nothing (not a payment code) still scrubs the old one
  keepClaimLink(SHORT, "base-mainnet", t0);
  keepClaimLink("not a code", "base-mainnet", t0 + CLAIM_LINK_KEEP_MS + 1);
  assert.equal(ss().getItem("gloam.claimLink"), null);
  ss().setItem("gloam.claimLink", "{damaged");
  keepClaimLink("", null);
  assert.equal(ss().getItem("gloam.claimLink"), null, "damaged goes too");
  const src = read("../src/lib/claimLinkStore.ts");
  assert.match(src, /if \(typeof window !== "undefined"\) scrubClaimLink\(\);/, "on load");
  assert.match(src, /export function keepClaimLink\(code: string, on: NetworkKey \| null, now = Date\.now\(\)\): void \{\s*\n\s*scrubClaimLink\(now\);\s*\n\s*if \(!looksLikeCode\(code\)\) return;/, "first thing on every keep");
});

test("an explicit Sign out or Disconnect forgets the kept link and empties the claim box", () => {
  ss().clear();
  keepClaimLink(SHORT, "base-mainnet");
  let emptied = 0;
  const off = onForgetClaim(() => emptied++);
  forgetClaim();
  assert.equal(keptClaimLink(), null, "the tab no longer keeps it");
  assert.equal(emptied, 1, "the claim box is told to empty");
  off();
  forgetClaim();
  assert.equal(emptied, 1, "unsubscribed");
  const menu = read("../src/components/app/WalletMenu.tsx");
  assert.match(menu, /const leave = \(\) => \{\s*\n\s*forgetClaim\(\);\s*\n\s*disconnect\(\);/);
  assert.match(menu, /setOpen\(false\);\s*\n\s*leave\(\);/, "the menu's Sign out and Disconnect");
  assert.match(menu, /setSwitchFailed\(false\);\s*\n\s*disconnect\(\);/, "a reconnect after a failed switch keeps the claim");
  assert.match(read("../src/components/app/TurnkeyHeaderSignIn.tsx"), /forgetClaim\(\);\s*\n\s*try \{\s*\n\s*await signOutEmbedded\(\);/);
  assert.match(read("../src/components/app/SettingsView.tsx"), /const disconnect = \(\) => \{\s*\n\s*forgetClaim\(\);/);
  const view = read("../src/components/app/MoveView.tsx");
  assert.match(view, /onForgetClaim\(\(\) => \{\s*\n\s*setImportText\(""\);\s*\n\s*setImportPassphrase\(""\);\s*\n\s*setClaimPreview\(null\);\s*\n\s*setImportOk\(null\);/);
});

test("a dead code (claimed already, no value, not what the vault holds) stops filling the box", () => {
  const view = read("../src/components/app/MoveView.tsx");
  assert.match(view, /class DeadCodeError extends Error \{\}/);
  assert.match(view, /throw new DeadCodeError\("This payment has no readable amount\."\)/);
  assert.match(view, /throw new DeadCodeError\("This payment carries no value\."\)/);
  assert.match(view, /throw new DeadCodeError\(\s*\n\s*"The amount in this payment does not match what it holds in the vault, so it was not claimed\."/);
  assert.equal(view.match(/throw new DeadCodeError\(moved\)/g)?.length, 2, "both ways of finding it claimed already");
  assert.doesNotMatch(view, /throw new Error\(moved\)/);
  assert.match(view, /if \(e instanceof DeadCodeError\) dropClaimLink\(\);\s*\n\s*setError\(walletErrorForPeople\(e, "Couldn't open this payment/);
  // a code that may still work (wrong network, wrong phrase, a read that failed) stays kept
  assert.match(view, /if \(wrongNetwork\) throw new Error\(wrongNetwork\);/);
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

test("a link in the chain's own coin is named by the link's chain: HYPE on Elysium, ETH elsewhere", () => {
  const ZERO = "0x0000000000000000000000000000000000000000";
  setShownNetworkKey("base-mainnet");
  assert.equal(assetLabel(ZERO), "ETH", "read by the saved network, a HYPE link said ETH (the bug)");
  // Elysium links exist only while Elysium is a network in this build
  if (elysiumOn) {
    assert.equal(claimNativeSymbol(ZERO, getNetwork("elysium-mainnet").chainId), "HYPE", "Elysium");
    assert.equal(claimNativeSymbol("", getNetwork("elysium-mainnet").chainId), "HYPE");
  }
  for (const id of [4663, 8453, 1, 46630, 84532, 11155111]) assert.equal(claimNativeSymbol(ZERO, id), "ETH", String(id));
  assert.equal(claimNativeSymbol("0x20c000000000000000000000b9537d11c60e8b50", 4217), null, "a token is named by the token list");
  assert.equal(claimNativeSymbol("0x0000000000000000000000000000000000000001", 99901), null);
  const page = read("../src/app/claim/page.tsx");
  assert.match(page, /symbol = claimNativeSymbol\(pack\.asset, getNetwork\(net\)\.chainId\) \?\? assetLabel\(pack\.asset\);/);
  assert.ok(page.indexOf("if (own) net = own;") < page.indexOf("symbol = claimNativeSymbol("), "after the code's own chain is known");
});

/* ---------------------------------------------------------------- the wiring */

test("the claim page says how the next screen lets people in, from lib/claimHelp", () => {
  const page = read("../src/app/claim/page.tsx");
  assert.match(page, /email: emailClaimOn\(view\.net\)/);
  assert.match(page, /\{claimSignInLine\(signIn\)\}/);
  assert.match(page, /signIn && claimNeedsWalletApp\(signIn\) &&/);
  assert.doesNotMatch(page, /You'll need a wallet app such as MetaMask/, "the old line lives in lib/claimHelp now");
  // the claim page's strict CSP leaves out wallet code: nothing lib/claimHelp loads, all the way down, pulls any in
  const seen = new Set<string>();
  const packages = new Set<string>();
  const walk = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/(?:^|\n)\s*(?:import|export)\s+(type\s+)?(?:[^;]*?\sfrom\s+)?["']([^"']+)["']/g)) {
      if (m[1]) continue; // types only: nothing reaches the bundle
      const spec = m[2]!;
      const local = spec.startsWith("@/") ? new URL(`../src/${spec.slice(2)}`, import.meta.url) : spec.startsWith(".") ? new URL(spec, `file://${file}`) : null;
      if (!local) {
        packages.add(spec);
        continue;
      }
      const base = local.pathname;
      const hit = [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`].find((f) => {
        try {
          return readFileSync(f) && !f.endsWith("/");
        } catch {
          return false;
        }
      });
      assert.ok(hit, `resolves ${spec} from ${file}`);
      walk(hit);
    }
  };
  walk(new URL("../src/lib/claimHelp.ts", import.meta.url).pathname);
  const files = [...seen].map((f) => f.slice(f.indexOf("/src/") + 1));
  for (const f of files) assert.doesNotMatch(f, /turnkey|wagmi|walletConnect|embeddedProvider|embeddedGas|tempoWallet|solanaWallet/i, `no wallet code: ${f}`);
  for (const pkg of packages) assert.doesNotMatch(pkg, /^(wagmi|@wagmi|@turnkey|@walletconnect|@reown|react|react-dom|next)(\/|$)/, `no wallet or UI package: ${pkg} (${files.join(", ")})`);
  assert.ok(files.includes("src/lib/embeddedWallet.ts"), "the switch is read from lib/embeddedWallet");
  assert.ok(files.includes("src/lib/networks.ts") && files.includes("src/lib/tokens.ts") && files.length > 4, `the whole graph was walked: ${files.join(", ")}`);
  assert.equal(read("../src/lib/embeddedWallet.ts").match(/(?:^|\n)\s*import\s/g), null, "lib/embeddedWallet imports nothing");
});

test("Pay > Receive keeps the link it reads, brings it back once, and drops it once claimed", () => {
  const view = read("../src/components/app/MoveView.tsx");
  // read from the address bar: cleared there, kept for the tab
  assert.match(view, /window\.history\.replaceState\(window\.history\.state, "", window\.location\.pathname \+ window\.location\.search\);[\s\S]{0,200}keepClaimLink\(code, isNetworkKey\(net\) \? net : null\);/);
  // after a reload: once, on Receive only, never over a link in the bar or text in the box
  const restore = view.slice(view.indexOf("const restoredClaim = useRef(false);"), view.indexOf("const claimInBox ="));
  assert.match(restore, /if \(claimFromLink\.current \|\| codeFromHash\(window\.location\.hash\)\) return;/);
  assert.match(restore, /!== "receive"\) return;/);
  assert.match(restore, /restoredClaim\.current = true;/);
  // the network moves only when the restore fills the box
  const empty = restore.indexOf("if (importTextNow.current.trim()) return;");
  const kept = restore.indexOf("const kept = keptClaimLink();");
  const move = restore.indexOf("if (kept.on && kept.on !== networkKey) setNetworkKey(kept.on);");
  const fill = restore.indexOf("setImportText(kept.code);");
  assert.ok(empty > 0 && empty < kept && kept < move && move < fill, "empty box, then the kept link, then the network, then the box");
  assert.match(view, /claimFromLink\.current = true;\s*\n\s*window\.history\.replaceState/);
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

test("the new-wallet sheet goes back to a waiting claim while it is free, unless Add funds was asked for", () => {
  const flow = read("../src/components/app/EmbeddedWalletFlow.tsx");
  assert.match(flow, /const claimWaitingNow = useSyncExternalStore\(onClaimWaiting, claimWaiting, \(\) => false\);/);
  assert.match(flow, /claimNext=\{claimFirstAfterWallet\(\{ waiting: claimWaitingNow, relayUp, fundingAsked \}\)\}/);
  assert.match(flow, /const relayUp = relayStatus\?\.chainId === network\.chainId && relayStatus\.up && relayPreferred\(\);/);
  // Add funds from the menu lasts until the sheet closes
  assert.match(flow, /setShowAddress\(false\);\s*\n\s*\/\/[^\n]*\n\s*setFundingAsked\(false\);\s*\n\s*\};/);
  assert.match(flow, /if \(req === "funding"\) \{\s*\n\s*setFunding\(true\);\s*\n\s*setFundingAsked\(true\);/);
  assert.match(flow, /onLeave\(\);\s*\n\s*goToClaim\(\);/);
  assert.match(flow, />\s*Back to your payment\s*</);
  assert.match(flow, /\? "Your wallet is ready"/);
});

/* ---------------------------------------------------------------- Glim */

const { knowledgeBlock } = await import("../src/lib/telegramBot/knowledge");

test("Glim says a claim link is claimed with an email sign-in on every mainnet, not with a wallet app only", () => {
  const k = knowledgeBlock();
  assert.match(k, /On every mainnet \([^)]+\) you can claim by signing in with your email/);
  for (const k2 of MAINNETS) assert.ok(k.includes(label(k2)), `names ${label(k2)}`);
  assert.match(k, /While the Gloam relay is on \(the default\) claiming needs no gas/);
  assert.match(k, /A wallet works too: /);
  assert.doesNotMatch(k, /On Robinhood Chain you need a wallet app/);
  assert.doesNotMatch(k, /Robinhood Chain needs (a wallet|a browser wallet)/);
  assert.match(k, /A Gloam wallet \(email or passkey sign-in\) works on every network/);
  assert.ok(!/\u2014|\u2013/.test(k.slice(k.indexOf("A claim link looks like"), k.indexOf("A payment request link"))), "no dashes");
});

console.log(`\n${passed} email-claim checks passed`);
