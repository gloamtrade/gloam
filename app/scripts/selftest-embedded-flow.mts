/**
 * Self-test: creating a Gloam wallet (lib/embeddedWallet), the logic behind the
 * create sheet (components/app/EmbeddedWalletFlow) and the switch.
 *
 *  - off unless NEXT_PUBLIC_TURNKEY_ENABLED is exactly "true" with both dashboard ids
 *  - the sheet's steps, from signing in to Add funds: someone who already has a
 *    wallet never sees "Create wallet", someone without one sees it once the list
 *    is read, a close is honoured, a failure says so and lets them try again
 *  - the wallet to sign with is the embedded one with an Ethereum account, never
 *    a wallet the kit connected from the browser
 *  - the optional name: empty is fine, too long or with control characters is not
 *  - the passkey's relying party: gloam.trade for the site and its subdomains, the
 *    page's own host anywhere else
 *  - failures read in plain words, never the SDK's own text
 *
 * Run from app/:  ../mcp/node_modules/.bin/tsx scripts/selftest-embedded-flow.mts
 */
import assert from "node:assert/strict";
import {
  DEFAULT_WALLET_NAME,
  WALLET_NAME_MAX,
  createWalletErrorText,
  embeddedFlowStep,
  embeddedRpId,
  embeddedWalletsOn,
  pickEmbeddedWallet,
  walletNameFor,
  walletNameProblem,
  type EmbeddedFlowState,
} from "../src/lib/embeddedWallet";

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`ok  ${name}`);
}

test("off unless the flag says exactly true and both dashboard ids are set", () => {
  const ids = { organizationId: "org", authProxyConfigId: "proxy" };
  assert.equal(embeddedWalletsOn({ enabled: "true", ...ids }), true);
  assert.equal(embeddedWalletsOn({ enabled: " true ", ...ids }), true);
  for (const enabled of [undefined, "", "1", "on", "TRUE", "yes", "false"]) {
    assert.equal(embeddedWalletsOn({ enabled, ...ids }), false, `flag ${JSON.stringify(enabled)}`);
  }
  assert.equal(embeddedWalletsOn({ enabled: "true", organizationId: "org" }), false);
  assert.equal(embeddedWalletsOn({ enabled: "true", authProxyConfigId: "proxy" }), false);
  assert.equal(embeddedWalletsOn({ enabled: "true", organizationId: " ", authProxyConfigId: "proxy" }), false);
  // this run's build env has no flag: merging changes nothing
  assert.equal(embeddedWalletsOn(), process.env.NEXT_PUBLIC_TURNKEY_ENABLED === "true" && Boolean(process.env.NEXT_PUBLIC_TURNKEY_ORGANIZATION_ID) && Boolean(process.env.NEXT_PUBLIC_TURNKEY_AUTH_PROXY_CONFIG_ID));
});

const base: EmbeddedFlowState = {
  signedIn: false,
  list: "unknown",
  hasWallet: false,
  creating: false,
  error: null,
  funding: false,
  backup: false,
  dismissed: false,
};
const step = (patch: Partial<EmbeddedFlowState>) => embeddedFlowStep({ ...base, ...patch });

test("signed out: nothing shows", () => {
  assert.equal(step({}), "hidden");
  assert.equal(step({ list: "read", hasWallet: false }), "hidden");
});

test("a new account: nothing while the wallet list is read, then Create wallet", () => {
  assert.equal(step({ signedIn: true }), "checking");
  assert.equal(step({ signedIn: true, list: "read" }), "create");
});

test("a failed wallet-list read is unknown, never 'no wallet': no Create wallet on it", () => {
  // the kit's own list is empty because its read failed too, and the refresh failed
  assert.equal(step({ signedIn: true, list: "unknown", hasWallet: false }), "checking");
  assert.equal(step({ signedIn: true, list: "failed", hasWallet: false }), "unreadable");
  assert.equal(step({ signedIn: true, list: "failed", hasWallet: false, dismissed: true }), "hidden");
  // an unset or unexpected list state is unknown too, never "no wallet"
  assert.equal(embeddedFlowStep({ ...base, signedIn: true, list: undefined as never }), "checking");
  assert.equal(embeddedFlowStep({ ...base, signedIn: true, list: "weird" as never }), "checking");
});

test("an account that has a wallet never sees Create wallet", () => {
  assert.equal(step({ signedIn: true, hasWallet: true, list: "read" }), "hidden");
  assert.equal(step({ signedIn: true, hasWallet: true, list: "unknown" }), "hidden");
  assert.equal(step({ signedIn: true, hasWallet: true, list: "failed" }), "hidden");
});

test("creating, then Add funds, then closed", () => {
  const s: EmbeddedFlowState = { ...base, signedIn: true, list: "read" };
  assert.equal(embeddedFlowStep({ ...s, creating: true }), "creating");
  const made = { ...s, hasWallet: true, funding: true };
  assert.equal(embeddedFlowStep(made), "funding");
  // the backup offer rides in Add funds, not in a second sheet
  assert.equal(embeddedFlowStep({ ...made, backup: true }), "funding");
  assert.equal(embeddedFlowStep({ ...made, dismissed: true }), "hidden");
});

test("a wallet made before gets the backup offer on its own, once closed it stays closed", () => {
  const s: EmbeddedFlowState = { ...base, signedIn: true, list: "read", hasWallet: true, backup: true };
  assert.equal(embeddedFlowStep(s), "backup");
  assert.equal(embeddedFlowStep({ ...s, dismissed: true }), "hidden");
  assert.equal(embeddedFlowStep({ ...s, backup: false }), "hidden");
});

test("a failure says so and lets them try again; trying again clears it", () => {
  const s: EmbeddedFlowState = { ...base, signedIn: true, list: "read", error: "The wallet wasn't made. Try again." };
  assert.equal(embeddedFlowStep(s), "failed");
  assert.equal(embeddedFlowStep({ ...s, creating: true }), "creating");
  assert.equal(embeddedFlowStep({ ...s, error: null }), "create");
});

test("closing the create sheet hides it; the header's Create wallet opens it again", () => {
  const s: EmbeddedFlowState = { ...base, signedIn: true, list: "read", dismissed: true };
  assert.equal(embeddedFlowStep(s), "hidden");
  assert.equal(embeddedFlowStep({ ...s, dismissed: false }), "create");
});

test("Add funds from the wallet menu opens on a wallet made before", () => {
  assert.equal(step({ signedIn: true, list: "read", hasWallet: true, funding: true }), "funding");
});

test("the wallet to sign with: the embedded one with an Ethereum account", () => {
  const eth = (address: string) => ({ address, addressFormat: "ADDRESS_FORMAT_ETHEREUM" });
  const sol = { address: "So1ana", addressFormat: "ADDRESS_FORMAT_SOLANA" };
  assert.equal(pickEmbeddedWallet(undefined), null);
  assert.equal(pickEmbeddedWallet([]), null);
  // the kit can list a browser wallet it connected: never that one
  assert.equal(pickEmbeddedWallet([{ source: "connected", walletId: "mm", accounts: [eth("0xMetaMask")] }]), null);
  assert.equal(pickEmbeddedWallet([{ source: "embedded", walletId: "s", accounts: [sol] }]), null);
  assert.deepEqual(
    pickEmbeddedWallet([
      { source: "connected", walletId: "mm", accounts: [eth("0xMetaMask")] },
      { source: "embedded", walletId: "w1", walletName: "Savings", accounts: [sol, eth("0xGloam")] },
    ]),
    { walletId: "w1", walletName: "Savings", address: "0xGloam" },
  );
});

test("with two wallets, the oldest signs, whatever order the list comes back in", () => {
  const eth = (address: string) => [{ address, addressFormat: "ADDRESS_FORMAT_ETHEREUM" }];
  const original = { source: "embedded", walletId: "w-old", accounts: eth("0xA1"), createdAt: { seconds: "1", nanos: "500" } };
  const second = { source: "embedded", walletId: "w-new", accounts: eth("0xB2"), createdAt: { seconds: "2", nanos: "0" } };
  const sameSecond = { source: "embedded", walletId: "w-same", accounts: eth("0xC3"), createdAt: { seconds: "1", nanos: "900" } };
  const noTime = { source: "embedded", walletId: "w-x", accounts: eth("0xD4") };
  assert.equal(pickEmbeddedWallet([original, second])?.address, "0xA1");
  assert.equal(pickEmbeddedWallet([second, original])?.address, "0xA1");
  assert.equal(pickEmbeddedWallet([sameSecond, second, original])?.address, "0xA1", "nanoseconds break a tie");
  assert.equal(pickEmbeddedWallet([noTime, second])?.address, "0xB2", "a wallet with no timestamp comes after");
  assert.equal(pickEmbeddedWallet([noTime])?.address, "0xD4");
});

test("the wallet name is optional, tidied, and kept short", () => {
  assert.equal(walletNameProblem(""), null);
  assert.equal(walletNameProblem("   "), null);
  assert.equal(walletNameFor(""), DEFAULT_WALLET_NAME);
  assert.equal(walletNameFor("  Rent   money "), "Rent money");
  assert.equal(walletNameProblem("x".repeat(WALLET_NAME_MAX)), null);
  assert.match(walletNameProblem("x".repeat(WALLET_NAME_MAX + 1))!, /40 characters/);
  assert.ok(walletNameProblem("bad\u0000name"));
  assert.ok(walletNameProblem("tab\tname"));
  assert.equal(walletNameProblem("Café wallet 2"), null);
});

test("passkeys belong to gloam.trade on the site, to the page's host elsewhere", () => {
  assert.equal(embeddedRpId("www.gloam.trade"), "gloam.trade");
  assert.equal(embeddedRpId("gloam.trade"), "gloam.trade");
  assert.equal(embeddedRpId("WWW.Gloam.Trade"), "gloam.trade");
  assert.equal(embeddedRpId("testnet.gloam.trade"), "gloam.trade");
  assert.equal(embeddedRpId("localhost"), "localhost");
  assert.equal(embeddedRpId("gloam-git-x.vercel.app"), "gloam-git-x.vercel.app");
  // a look-alike is not a subdomain
  assert.equal(embeddedRpId("evilgloam.trade"), "evilgloam.trade");
});

test("a wallet that wasn't made is explained in plain words", () => {
  assert.equal(createWalletErrorText(new Error("wallet list")), "Couldn't check your wallets, so nothing was made. Try again.");
  assert.equal(createWalletErrorText(new Error("NotAllowedError: The operation either timed out or was not allowed")), "Nothing was made. Try again when you're ready.");
  assert.match(createWalletErrorText(new Error("session expired")), /sign-in ran out/);
  assert.match(createWalletErrorText(new TypeError("Failed to fetch")), /Couldn't reach the wallet service/);
  assert.equal(createWalletErrorText(new Error("Turnkey error 3: internal ACTIVITY_STATUS_FAILED")), "The wallet wasn't made. Try again.");
  for (const t of [createWalletErrorText(null), createWalletErrorText("x")]) assert.ok(!/—|Turnkey error/.test(t));
});

console.log(`selftest-embedded-flow: ${passed} passed`);
