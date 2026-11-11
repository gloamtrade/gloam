/**
 * Self-test: the Turnkey kit (Gloam wallets, email and passkey sign-in) loads in
 * the app only when it is needed.
 *
 *  - on load, only for a browser holding a sign-in that may still be good
 *    (lib/embeddedWallet storedTurnkeySession): someone signed in is never left
 *    signed out, an expired session or none at all leaves the kit unloaded
 *  - the storage keys read are the ones the installed kit writes
 *  - a Sign in asks for the kit, waits for the sheet while it loads, and the
 *    button can show that; a kit that failed to load lets the wait go
 *  - signed in or not is published for the header, which never reads the kit;
 *    a stored sign-in shows the wallet opening from the first paint, never Sign in
 *  - the wiring: the app layout no longer wraps its pages in the kit, the gate is
 *    mounted in Web3Provider, the kit and its sheets come in one download, and
 *    the header reads the kit's state without the kit
 *
 * Run from app/:  ../mcp/node_modules/.bin/tsx scripts/selftest-kit-load.mts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import {
  TURNKEY_ACTIVE_SESSION_KEY,
  TURNKEY_DEFAULT_SESSION_KEY,
  TURNKEY_SESSION_LIST_KEY,
  storedTurnkeySession,
} from "../src/lib/embeddedWallet";
import {
  SIGN_IN_PENDING_MS,
  dropSignInWaiting,
  embeddedAuth,
  embeddedKitWanted,
  onEmbeddedAuth,
  onEmbeddedKitWanted,
  onSignInSheetRequest,
  onSignInWaiting,
  openSignInSheet,
  setEmbeddedAuth,
  signInWaiting,
  wantEmbeddedKitIfSignedIn,
} from "../src/lib/turnkeyBridge";

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`ok  ${name}`);
}

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

/** A storage holding what the kit writes after a sign-in (@turnkey/core WebStorageManager.storeSession). */
function storageWith(entries: Record<string, unknown>) {
  const m = new Map(Object.entries(entries).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)]));
  return { getItem: (k: string) => (m.has(k) ? m.get(k)! : null) };
}

const NOW = 1_800_000_000_000;
const session = (expirySeconds: number) => ({
  sessionType: "SESSION_TYPE_READ_WRITE",
  userId: "u",
  organizationId: "o",
  expiry: expirySeconds,
  expirationSeconds: "900",
  publicKey: "02ab",
  token: "a.b.c",
});
const signedIn = (expirySeconds: number, key = TURNKEY_DEFAULT_SESSION_KEY) =>
  storageWith({ [key]: session(expirySeconds), [TURNKEY_SESSION_LIST_KEY]: [key], [TURNKEY_ACTIVE_SESSION_KEY]: key });

test("a stored sign-in that is still good counts; an expired one, or none, does not", () => {
  const later = NOW / 1000 + 600;
  const earlier = NOW / 1000 - 1;
  assert.equal(storedTurnkeySession(signedIn(later), NOW), true);
  assert.equal(storedTurnkeySession(signedIn(earlier), NOW), false, "expired: the kit would clear it, nothing to load it for");
  assert.equal(storedTurnkeySession(storageWith({}), NOW), false, "never signed in");
  assert.equal(storedTurnkeySession(null, NOW), false, "no storage");
  assert.equal(storedTurnkeySession(undefined, NOW), false);
  // the kit's own test is `expiry * 1000 > Date.now()`: the very second it runs out is out
  assert.equal(storedTurnkeySession(signedIn(NOW / 1000), NOW), false);
  // after Sign out the kit clears the session, the list and the active key
  assert.equal(storedTurnkeySession(storageWith({ [TURNKEY_SESSION_LIST_KEY]: [] }), NOW), false);
});

test("a session under another key the kit lists, or the active one, counts too", () => {
  const later = NOW / 1000 + 600;
  assert.equal(storedTurnkeySession(signedIn(later, "custom-key"), NOW), true);
  assert.equal(storedTurnkeySession(storageWith({ other: session(later), [TURNKEY_ACTIVE_SESSION_KEY]: "other" }), NOW), true);
  // a list entry with no session behind it: nothing for the kit to restore
  assert.equal(storedTurnkeySession(storageWith({ [TURNKEY_SESSION_LIST_KEY]: ["gone"] }), NOW), false);
  // one expired, one good: good
  assert.equal(
    storedTurnkeySession(
      storageWith({ a: session(NOW / 1000 - 5), b: session(later), [TURNKEY_SESSION_LIST_KEY]: ["a", "b"] }),
      NOW,
    ),
    true,
  );
});

test("cautious: a session in a shape it doesn't know loads the kit, which decides; storage that throws loads nothing", () => {
  assert.equal(storedTurnkeySession(storageWith({ [TURNKEY_DEFAULT_SESSION_KEY]: "not json {" }), NOW), true);
  assert.equal(storedTurnkeySession(storageWith({ [TURNKEY_DEFAULT_SESSION_KEY]: { token: "a.b.c" } }), NOW), true, "no expiry");
  assert.equal(storedTurnkeySession(storageWith({ [TURNKEY_DEFAULT_SESSION_KEY]: { expiry: "soon" } }), NOW), true, "odd expiry");
  assert.equal(storedTurnkeySession(storageWith({ [TURNKEY_DEFAULT_SESSION_KEY]: { expiry: String(NOW / 1000 + 60) } }), NOW), true);
  assert.equal(storedTurnkeySession(storageWith({ [TURNKEY_DEFAULT_SESSION_KEY]: { expiry: String(NOW / 1000 - 60) } }), NOW), false);
  const blocked = {
    getItem() {
      throw new Error("SecurityError");
    },
  };
  assert.equal(storedTurnkeySession(blocked, NOW), false);
});

test("the keys read are the ones the installed kit writes, and its validity test is the one mirrored", () => {
  const appRequire = createRequire(new URL("../package.json", import.meta.url));
  const kitRequire = createRequire(appRequire.resolve("@turnkey/react-wallet-kit"));
  const coreEntry = kitRequire.resolve("@turnkey/core");
  const coreDist = coreEntry.slice(0, coreEntry.lastIndexOf("/dist/") + "/dist/".length);
  const storage = readFileSync(`${coreDist}__storage__/web/storage.mjs`, "utf8");
  assert.match(storage, new RegExp(`ALL_SESSION_KEYS = "${TURNKEY_SESSION_LIST_KEY}"`));
  assert.match(storage, new RegExp(`ACTIVE_SESSION_KEY = "${TURNKEY_ACTIVE_SESSION_KEY}"`));
  assert.match(storage, /WindowWrapper\.localStorage/, "kept in localStorage");
  const enums = readFileSync(`${coreDist}__types__/enums.mjs`, "utf8");
  assert.match(enums, new RegExp(`\\["DefaultSessionkey"\\] = "${TURNKEY_DEFAULT_SESSION_KEY}"`));
  const kitEntry = appRequire.resolve("@turnkey/react-wallet-kit");
  const kitDist = kitEntry.slice(0, kitEntry.lastIndexOf("/dist/") + "/dist/".length);
  const utils = readFileSync(`${kitDist}utils/utils.mjs`, "utf8");
  assert.match(utils, /isValidSession = function isValidSession\(session\) \{\s*return \(session === null[^;]*\.expiry\) !== undefined && session\.expiry \* 1000 > Date\.now\(\);/);
});

test("on load the kit is wanted only with Gloam wallets on and a stored sign-in", () => {
  const later = NOW / 1000 + 600;
  assert.equal(embeddedKitWanted(), false, "nothing asked for it yet");
  assert.equal(wantEmbeddedKitIfSignedIn(storageWith({}), true, NOW), false);
  assert.equal(wantEmbeddedKitIfSignedIn(signedIn(NOW / 1000 - 1), true, NOW), false);
  assert.equal(wantEmbeddedKitIfSignedIn(signedIn(later), false, NOW), false, "switched off: never");
  assert.equal(embeddedKitWanted(), false);
  assert.equal(embeddedAuth(), "signed-out", "nothing stored: Sign in, as before");
  let told = 0;
  const off = onEmbeddedKitWanted(() => told++);
  assert.equal(wantEmbeddedKitIfSignedIn(signedIn(later), true, NOW), true);
  assert.equal(embeddedKitWanted(), true, "a returning person's kit starts on load");
  assert.equal(embeddedAuth(), "restoring", "and the header says the wallet is opening, never Sign in");
  assert.equal(told, 1);
  // wanted once is wanted for the page's life: nothing fires twice
  wantEmbeddedKitIfSignedIn(signedIn(later), true, NOW);
  openSignInSheet({}, NOW);
  assert.equal(told, 1);
  off();
  dropSignInWaiting();
});

test("signed in or not reaches the header without the kit, and only changes notify", () => {
  setEmbeddedAuth("signed-out");
  let n = 0;
  const off = onEmbeddedAuth(() => n++);
  setEmbeddedAuth("signed-in");
  setEmbeddedAuth("signed-in");
  assert.equal(embeddedAuth(), "signed-in");
  assert.equal(n, 1);
  setEmbeddedAuth("signed-out");
  assert.equal(n, 2);
  off();
});

test("a Sign in tapped while the kit loads waits for the sheet, and the button can say so", () => {
  let n = 0;
  const off = onSignInWaiting(() => n++);
  assert.equal(signInWaiting(1_000), false);
  assert.equal(openSignInSheet({ walletLabel: "early" }, 1_000), false, "no sheet yet: the kit is still loading");
  assert.equal(signInWaiting(1_000), true);
  assert.equal(signInWaiting(1_000 + SIGN_IN_PENDING_MS + 1), false, "a wait that ran out is not shown");
  assert.equal(n, 1);
  // the sheet mounts with the kit and takes it: the wait is over
  const seen: string[] = [];
  const offSheet = onSignInSheetRequest((o) => seen.push(o.walletLabel ?? ""), 1_200);
  assert.deepEqual(seen, ["early"]);
  assert.equal(signInWaiting(1_200), false);
  assert.equal(n, 2);
  offSheet();
  // a kit that could not load lets the wait go, so the button stops spinning
  openSignInSheet({}, 5_000);
  assert.equal(signInWaiting(5_000), true);
  dropSignInWaiting();
  assert.equal(signInWaiting(5_000), false);
  assert.equal(n, 4);
  off();
});

test("the app no longer wraps its pages in the kit; the gate starts it beside them", () => {
  const layout = read("../src/app/app/layout.tsx");
  assert.doesNotMatch(layout, /<Turnkey|import[^\n]*Turnkey/, "the pages never wait for the kit");
  assert.match(layout, /<Web3Provider>\{children\}<\/Web3Provider>/);

  const web3 = read("../src/components/app/Web3Provider.tsx");
  assert.match(web3, /\{EMBEDDED_WALLETS && \(\s*<>\s*<TurnkeyAutoConnect \/>\s*<TurnkeyKitGate \/>\s*<\/>\s*\)\}/);
  assert.doesNotMatch(web3, /EmbeddedWalletFlow/, "the create-a-wallet sheet comes with the kit");

  const gate = read("../src/components/app/TurnkeyKitGate.tsx");
  // on load, as the scripts run, and again when the gate mounts
  assert.match(gate, /if \(typeof window !== "undefined" && wantEmbeddedKitIfSignedIn\(localStore\(\)\)\) \{\s*\n\s*void loadTurnkeyAppKit\(\)\.catch\(\(\) => \{\}\);/);
  assert.match(gate, /useEffect\(\(\) => \{\s*\n\s*wantEmbeddedKitIfSignedIn\(localStore\(\)\);\s*\n\s*\}, \[\]\);/);
  assert.match(gate, /const wanted = useSyncExternalStore\(onEmbeddedKitWanted, embeddedKitWanted, \(\) => false\);/);
  assert.match(gate, /dynamic\(\(\) => import\("\.\/TurnkeyAppKit"\), \{ ssr: false \}\)/);
  assert.match(gate, /export const loadTurnkeyAppKit = \(\) => import\("\.\/TurnkeyAppKit"\);/);
  // a failed download marks sign-in unavailable and lets a waiting tap go
  assert.match(gate, /setEmbeddedAvailability\("unavailable"\);\s*\n\s*setEmbeddedAuth\("signed-out"\);\s*\n\s*dropSignInWaiting\(\);/);

  const appKit = read("../src/components/app/TurnkeyAppKit.tsx");
  assert.match(appKit, /<TurnkeyKitProvider>\s*<EmbeddedWalletFlow \/>\s*<\/TurnkeyKitProvider>/);
  const kit = read("../src/components/app/TurnkeyKit.tsx");
  assert.match(kit, /<TurnkeyWagmiSync \/>\s*<GloamSignInSheet \/>/, "the sheet and the sync come with the kit");
  const sync = read("../src/components/app/TurnkeyWagmiSync.tsx");
  // signed out only once the kit has looked: a stored sign-in stays "restoring" while it starts
  assert.match(sync, /const looked = clientState === ClientState\.Error \|\| \(clientState === ClientState\.Ready && !session\);/);
  assert.match(sync, /if \(signedIn\) setEmbeddedAuth\("signed-in"\);\s*\n\s*else if \(looked\) setEmbeddedAuth\("signed-out"\);/);
});

test("nothing outside the kit's own download imports the kit", () => {
  // the header's Sign in and the wallet menu read lib/turnkeyBridge
  for (const f of ["TurnkeyHeaderSignIn", "WalletMenu", "Web3Provider", "TurnkeyKitGate", "TurnkeyAutoConnect", "MoveView"]) {
    assert.doesNotMatch(read(`../src/components/app/${f}.tsx`), /@turnkey\/react-wallet-kit/, f);
  }
  const header = read("../src/components/app/TurnkeyHeaderSignIn.tsx");
  assert.match(header, /const auth = useSyncExternalStore\(onEmbeddedAuth, embeddedAuth, \(\) => "signed-out" as const\);/);
  assert.match(header, /if \(availability === "unavailable"\) return <>\{fallback\}<\/>;/);
  // restoring: the wallet is opening, with nothing to tap (no Sign in, no Sign out the kit can't do yet)
  assert.match(header, /if \(auth === "restoring"\) \{\s*\n\s*return \(\s*\n\s*<button type="button" disabled aria-busy="true" className=\{className\}>\s*\n\s*<Spinner \/>\s*\n\s*Opening your wallet…/);
  // a touch starts the download; the tap opens the sheet (which asks for the kit)
  assert.match(header, /onTouchStart=\{prefetch\}/);
  assert.match(header, /openSignInSheet\(\{ onUseWallet, walletLabel \}\);/);
  // the bridge asks for the kit on every Sign in
  const bridge = read("../src/lib/turnkeyBridge.ts");
  assert.match(bridge, /export function openSignInSheet\(.*\): boolean \{\s*\n\s*wantEmbeddedKit\(\);/);
});

console.log(`selftest-kit-load: ${passed} passed`);
