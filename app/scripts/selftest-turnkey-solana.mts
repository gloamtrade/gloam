/**
 * Self-test: a Gloam wallet's Solana account (lib/turnkeySolana).
 *
 *  - which account: the Solana account at m/44'/501'/0'/0' in the same Turnkey
 *    wallet the Ethereum account signs with, made there when it is missing, never
 *    in another wallet; a new wallet is made with both; the account params are
 *    Turnkey's own first Solana and Ethereum accounts (checked against the
 *    installed kit, so an upgrade that moves them fails here first)
 *  - it signs no message, so a private account never opens from a Turnkey
 *    signature: lib/solanaWallet's signSolanaMessage (what opens a browser
 *    wallet's private account) refuses it and nothing reaches Turnkey. Its private
 *    account opens from a passkey or a backup code (scripts/selftest-gloam-solana-root.mts)
 *  - each request to Turnkey: sign_raw_payload over the exact bytes in hex, no
 *    hash, the Solana address as signWith, the session's organization; a Turnkey
 *    that signs with another key, or signs a hash, gets nothing signed
 *  - transactions (legacy and v0) come back with the Gloam account's signature in
 *    its own slot, checking out over the message, and every other byte as it was,
 *    through lib/solanaWallet's signOrSendSolana; one that doesn't ask it to sign
 *    is refused
 *  - it is found the way a wallet extension is (Wallet Standard register-wallet and
 *    app-ready), passes lib/solanaWallet's checks, and leaves every app on sign-out,
 *    where signing stops and listeners hear the account go; one wallet object per
 *    page, so the one the Solana account layer kept while the kit was away signs
 *    again when it is back
 *  - connecting on its own: when, and what a change of wallet says
 *  - Turnkey's answers and failures read in plain words
 *
 * The Turnkey here is a stand-in holding local Ed25519 keys (node:crypto, RFC 8032,
 * deterministic like Turnkey's): no request leaves the process.
 *
 * Run from app/:  ../mcp/node_modules/.bin/tsx scripts/selftest-turnkey-solana.mts
 */
import assert from "node:assert/strict";
import { createHash, createPublicKey, generateKeyPairSync, sign as edSign, verify as edVerify, randomBytes, type KeyObject } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import {
  AccountRole,
  address as asAddress,
  appendTransactionMessageInstructions,
  compileTransaction,
  createNoopSigner,
  createTransactionMessage,
  generateKeyPairSigner,
  getAddressDecoder,
  getAddressEncoder,
  getTransactionDecoder,
  getTransactionEncoder,
  partiallySignTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
  type Blockhash,
} from "@solana/kit";
import {
  DECLINED_KEY,
  GLOAM_ACCOUNT_ICON,
  GLOAM_ACCOUNT_NAME,
  GLOAM_ETHEREUM_ACCOUNT,
  GLOAM_SOLANA_ACCOUNT,
  GLOAM_SOLANA_OFF,
  GLOAM_SOLANA_PATH,
  NEW_WALLET_ACCOUNTS,
  createSolanaErrorText,
  declinedAfter,
  ed25519FromParts,
  endGloamSolanaWallet,
  gloamAccountDeclined,
  gloamSolana,
  gloamSolanaWalletFor,
  isGloamAccount,
  makeGloamSolanaWallet,
  onGloamSolana,
  registerStandardWallet,
  setGloamAccountDeclined,
  setGloamSolana,
  setGloamSolanaSigner,
  shouldAutoConnect,
  signErrorText,
  solanaAccountPlan,
  solanaPublicKey,
  turnkeyEd25519Signer,
  type GloamSolanaWallet,
  type RawPayloadClient,
  type SolanaWalletLike,
} from "../src/lib/turnkeySolana";
import { accountMessage } from "../src/lib/solanaRings/account";
import { canSignMessage, connectSolana, signOrSendSolana, signSolanaMessage, type SolanaWallet } from "../src/lib/solanaWallet";

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  await fn();
  passed++;
  console.log(`ok  ${name}`);
}

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const same = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));

/* ---------------------------------------------------------------- a stand-in Turnkey */

const ORG = "sub-org-of-the-person";

/** A Turnkey wallet's Ed25519 key, and its Solana address. */
function solanaKey(): { key: KeyObject; publicKey: Uint8Array; address: string } {
  const { privateKey } = generateKeyPairSync("ed25519");
  const der = createPublicKey(privateKey).export({ format: "der", type: "spki" });
  const publicKey = new Uint8Array(der.subarray(der.length - 32));
  return { key: privateKey, publicKey, address: getAddressDecoder().decode(publicKey) };
}

type Call = Parameters<RawPayloadClient["signRawPayload"]>[0];

/**
 * One Turnkey session on a wallet holding `keys` (address -> key). `mode` bends it:
 * "plain" signs the bytes (what Turnkey does), "drift" answers a second request for
 * the same bytes differently, "hashed" signs sha256 of them, "broken" sends back a
 * short r, "throws" fails with `error`.
 */
function fakeTurnkey(keys: Map<string, KeyObject>, mode: "plain" | "drift" | "hashed" | "broken" | "throws" = "plain", error = "") {
  const calls: Call[] = [];
  const seen = new Map<string, number>();
  const client: RawPayloadClient = {
    async signRawPayload(input) {
      calls.push(input);
      if (mode === "throws") throw new Error(error);
      assert.equal(input.encoding, "PAYLOAD_ENCODING_HEXADECIMAL");
      assert.equal(input.hashFunction, "HASH_FUNCTION_NOT_APPLICABLE");
      assert.equal(input.organizationId, ORG);
      assert.match(input.payload, /^[0-9a-f]*$/);
      const key = keys.get(input.signWith);
      if (!key) throw new Error("Turnkey error 3: no such wallet account");
      let bytes = Buffer.from(input.payload, "hex");
      if (mode === "hashed") bytes = createHash("sha256").update(bytes).digest();
      let sig = edSign(null, bytes, key);
      const n = (seen.get(input.payload) ?? 0) + 1;
      seen.set(input.payload, n);
      if (mode === "drift" && n % 2 === 0) sig = Buffer.from(randomBytes(64));
      if (mode === "broken") return { r: sig.subarray(0, 31).toString("hex"), s: sig.subarray(32).toString("hex"), v: "00" };
      return { r: sig.subarray(0, 32).toString("hex"), s: sig.subarray(32).toString("hex"), v: "00" };
    },
  };
  return { client, calls };
}

/** What lib/solanaWallet hands the app for a Wallet Standard wallet: its name, icon and the wallet itself. */
const asFound = (w: GloamSolanaWallet): SolanaWallet => ({ name: w.name, icon: w.icon, wallet: w as unknown as SolanaWallet["wallet"] });

/** A Gloam account on one device: a Turnkey session's client, signing through turnkeyEd25519Signer. */
function device(keys: Map<string, KeyObject>, address: string, mode: Parameters<typeof fakeTurnkey>[1] = "plain", error = "") {
  const t = fakeTurnkey(keys, mode, error);
  const wallet = makeGloamSolanaWallet({ address, sign: turnkeyEd25519Signer(() => ({ client: t.client, organizationId: ORG }), address) });
  return { ...t, wallet, found: asFound(wallet) };
}

/* ---------------------------------------------------------------- which account */

const solA = solanaKey();
const ETH_A = { address: "0x1111111111111111111111111111111111111111", addressFormat: "ADDRESS_FORMAT_ETHEREUM", path: "m/44'/60'/0'/0/0" };

await test("the Solana account sits in the wallet the Ethereum account signs with, made there when it is missing", () => {
  assert.deepEqual(solanaAccountPlan(undefined), { kind: "none" });
  assert.deepEqual(solanaAccountPlan([]), { kind: "none" });
  const ethOnly: SolanaWalletLike = { source: "embedded", walletId: "w1", accounts: [ETH_A], createdAt: { seconds: "100" } };
  assert.deepEqual(solanaAccountPlan([ethOnly]), { kind: "create", walletId: "w1" });
  const both: SolanaWalletLike = {
    ...ethOnly,
    accounts: [ETH_A, { address: solA.address, addressFormat: "ADDRESS_FORMAT_SOLANA", path: GLOAM_SOLANA_PATH }],
  };
  assert.deepEqual(solanaAccountPlan([both]), { kind: "ready", walletId: "w1", address: solA.address });
  // only the account at m/44'/501'/0'/0' counts
  const otherPath: SolanaWalletLike = {
    ...ethOnly,
    accounts: [ETH_A, { address: solA.address, addressFormat: "ADDRESS_FORMAT_SOLANA", path: "m/44'/501'/1'/0'" }],
  };
  assert.deepEqual(solanaAccountPlan([otherPath]), { kind: "create", walletId: "w1" });
  // a newer wallet with a Solana account never stands in for the one Ethereum signs with
  const newer: SolanaWalletLike = { ...both, walletId: "w2", createdAt: { seconds: "200" } };
  assert.deepEqual(solanaAccountPlan([newer, ethOnly]), { kind: "create", walletId: "w1" });
  assert.deepEqual(solanaAccountPlan([newer, both]), { kind: "ready", walletId: "w1", address: solA.address });
  // a browser wallet the kit connected is not a Gloam wallet
  const connected: SolanaWalletLike = { ...both, source: "connected", walletId: "c1", createdAt: { seconds: "1" } };
  assert.deepEqual(solanaAccountPlan([connected]), { kind: "none" });
  assert.deepEqual(solanaAccountPlan([connected, ethOnly]), { kind: "create", walletId: "w1" });
  // an address that isn't one is no account
  const garbled: SolanaWalletLike = {
    ...ethOnly,
    accounts: [ETH_A, { address: "not-an-address", addressFormat: "ADDRESS_FORMAT_SOLANA", path: GLOAM_SOLANA_PATH }],
  };
  assert.deepEqual(solanaAccountPlan([garbled]), { kind: "create", walletId: "w1" });
});

await test("the accounts are Turnkey's own first Solana and Ethereum accounts, and a new wallet gets both", () => {
  const require = createRequire(import.meta.url);
  const kit = require.resolve("@turnkey/react-wallet-kit");
  const core = createRequire(kit).resolve("@turnkey/core");
  const helpers = require(path.join(path.dirname(core), "turnkey-helpers.js")) as {
    DEFAULT_SOLANA_ACCOUNTS: unknown[];
    DEFAULT_ETHEREUM_ACCOUNTS: unknown[];
  };
  assert.deepEqual({ ...GLOAM_SOLANA_ACCOUNT }, helpers.DEFAULT_SOLANA_ACCOUNTS[0]);
  assert.deepEqual({ ...GLOAM_ETHEREUM_ACCOUNT }, helpers.DEFAULT_ETHEREUM_ACCOUNTS[0]);
  assert.equal(GLOAM_SOLANA_ACCOUNT.path, "m/44'/501'/0'/0'");
  assert.equal(GLOAM_SOLANA_ACCOUNT.curve, "CURVE_ED25519");
  // the Ethereum account first, as every Gloam wallet has had it: its address never moves
  assert.deepEqual(NEW_WALLET_ACCOUNTS, [GLOAM_ETHEREUM_ACCOUNT, GLOAM_SOLANA_ACCOUNT]);
});

/* ---------------------------------------------------------------- no message, ever */

await test("it signs no message, so no private account ever opens from a Turnkey signature", async () => {
  const keys = new Map([[solA.address, solA.key]]);
  const d = device(keys, solA.address);
  assert.equal("solana:signMessage" in d.wallet.features, false, "no message signing at all");
  assert.deepEqual(d.wallet.accounts[0]!.features, ["solana:signTransaction"]);
  assert.equal(canSignMessage(d.found), false);
  const account = await connectSolana(d.found);
  // what opens a browser wallet's private account (lib/solanaRings/client openRingsAccount) refuses it
  await assert.rejects(signSolanaMessage(d.found, account, accountMessage(0)), /can't sign a message here/);
  assert.equal(d.calls.length, 0, "nothing reached Turnkey");
});

/* ---------------------------------------------------------------- transactions */

const BLOCKHASH = { blockhash: "EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq1k" as Blockhash, lastValidBlockHeight: 100n };

async function wireFor(version: "legacy" | 0, feePayer: string, otherSigner?: Awaited<ReturnType<typeof generateKeyPairSigner>>) {
  const payer = createNoopSigner(asAddress(feePayer));
  const program = asAddress("11111111111111111111111111111111");
  const accounts = [{ address: asAddress(feePayer), role: AccountRole.WRITABLE_SIGNER }];
  if (otherSigner) accounts.push({ address: otherSigner.address, role: AccountRole.READONLY_SIGNER });
  const message = pipe(
    createTransactionMessage({ version }),
    (m) => setTransactionMessageFeePayerSigner(payer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(BLOCKHASH, m),
    (m) => appendTransactionMessageInstructions([{ programAddress: program, accounts, data: new Uint8Array([2, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0]) }], m),
  );
  let tx = compileTransaction(message);
  if (otherSigner) tx = await partiallySignTransaction([otherSigner.keyPair], tx);
  return new Uint8Array(getTransactionEncoder().encode(tx));
}

await test("a transaction comes back with the Gloam account's signature in its slot, and nothing else changed", async () => {
  const keys = new Map([[solA.address, solA.key]]);
  const d = device(keys, solA.address);
  const account = await connectSolana(d.found);
  for (const version of ["legacy", 0] as const) {
    const cosigner = await generateKeyPairSigner();
    const wire = await wireFor(version, solA.address, cosigner);
    const before = getTransactionDecoder().decode(wire);
    assert.equal(before.signatures[solA.address as Address], null, "unsigned to start");
    const out = await signOrSendSolana(d.found, account, wire, "solana:devnet");
    assert.ok("signed" in out, "it signs and hands back; the app sends it");
    const after = getTransactionDecoder().decode((out as { signed: Uint8Array }).signed);
    assert.ok(same(new Uint8Array(after.messageBytes), new Uint8Array(before.messageBytes)), `${version}: the message is untouched`);
    assert.deepEqual(Object.keys(after.signatures), Object.keys(before.signatures), `${version}: the signers in their order`);
    const sig = after.signatures[solA.address as Address]!;
    const spki = createPublicKey(solA.key);
    assert.ok(edVerify(null, Buffer.from(after.messageBytes), spki, Buffer.from(sig)), `${version}: the signature checks out over the message`);
    assert.ok(same(new Uint8Array(after.signatures[cosigner.address]!), new Uint8Array(before.signatures[cosigner.address]!)), `${version}: the other signature is kept`);
    // and the bytes on the wire are the same apart from the one slot
    const signedWire = (out as { signed: Uint8Array }).signed;
    assert.equal(signedWire.length, wire.length);
    const diff = [...wire].map((b, i) => (b === signedWire[i] ? -1 : i)).filter((i) => i >= 0);
    assert.ok(diff.length > 0 && diff.every((i) => i >= 1 && i < 65), `${version}: only the first slot changed`);
  }
  // one Turnkey request per transaction, over the message bytes
  const wire = await wireFor(0, solA.address);
  const calls = d.calls.length;
  await signOrSendSolana(d.found, account, wire, "solana:mainnet");
  assert.equal(d.calls.length, calls + 1);
  assert.equal(d.calls.at(-1)!.payload, hex(new Uint8Array(getTransactionDecoder().decode(wire).messageBytes)));
});

await test("a Turnkey that signs with another key, signs a hash or answers badly gets nothing signed", async () => {
  const wire = await wireFor(0, solA.address);
  const stranger = solanaKey();
  const cases: [Map<string, KeyObject>, Parameters<typeof fakeTurnkey>[1], RegExp][] = [
    [new Map([[solA.address, stranger.key]]), "plain", /didn't check out/],
    [new Map([[solA.address, solA.key]]), "hashed", /didn't check out/],
    [new Map([[solA.address, solA.key]]), "broken", /couldn't sign that/],
  ];
  for (const [keys, mode, want] of cases) {
    const d = device(keys, solA.address, mode);
    await assert.rejects(signOrSendSolana(d.found, await connectSolana(d.found), wire, "solana:mainnet"), want);
  }
});

await test("Turnkey's failures read in plain words, never its own text", async () => {
  const keys = new Map([[solA.address, solA.key]]);
  const wire = await wireFor(0, solA.address);
  const cases: [string, RegExp][] = [
    ["Turnkey error 16: session expired, sign in again", /sign-in ran out/],
    ["Failed to fetch", /Couldn't reach the wallet service/],
    ["NotAllowedError: The operation either timed out or was not allowed", /cancelled/],
    ["Turnkey error 7: internal (activity 0x1234)", /couldn't sign that/],
  ];
  for (const [error, want] of cases) {
    const d = device(keys, solA.address, "throws", error);
    await assert.rejects(signOrSendSolana(d.found, await connectSolana(d.found), wire, "solana:mainnet"), (e: Error) => want.test(e.message) && !e.message.includes("Turnkey"));
  }
  // no session client: sign in first, and nothing reaches Turnkey
  const none = makeGloamSolanaWallet({ address: solA.address, sign: turnkeyEd25519Signer(() => ({ client: null, organizationId: null }), solA.address) });
  await assert.rejects(signOrSendSolana(asFound(none), await connectSolana(asFound(none)), wire, "solana:mainnet"), /Sign in to your Gloam wallet/);
  assert.equal(signErrorText(new Error("user rejected")), "You cancelled it.");
  assert.equal(createSolanaErrorText(new Error("Turnkey error 16: unauthorized")), "Your sign-in ran out. Sign in again to use your Gloam account on Solana.");
  assert.equal(createSolanaErrorText(new Error("Turnkey error 3: something internal")), "Your Gloam account couldn't open on Solana. Try again.");
});

await test("a transaction that doesn't ask the Gloam account to sign is refused, and so is another account's", async () => {
  const keys = new Map([[solA.address, solA.key]]);
  const d = device(keys, solA.address);
  const account = await connectSolana(d.found);
  const someoneElse = solanaKey();
  const wire = await wireFor(0, someoneElse.address);
  const calls = d.calls.length;
  await assert.rejects(signOrSendSolana(d.found, account, wire, "solana:mainnet"), /doesn't ask your Gloam account/);
  assert.equal(d.calls.length, calls, "nothing reached Turnkey");
  const other = { address: someoneElse.address, account: { address: someoneElse.address, chains: ["solana:mainnet"] } };
  await assert.rejects(signOrSendSolana(d.found, other, wire, "solana:mainnet"), /isn't your Gloam account/);
});

/* ---------------------------------------------------------------- found like any Solana wallet */

await test("it is found the way a wallet extension is, passes lib/solanaWallet's checks, and leaves on sign-out", async () => {
  const keys = new Map([[solA.address, solA.key]]);
  const d = device(keys, solA.address);
  const w = d.wallet;
  // lib/solanaWallet's own test for a usable wallet (SolanaAccount lists a Gloam account by isGloamAccount, as it signs no message)
  assert.ok(w.chains.includes("solana:mainnet") && w.features["standard:connect"] && w.features["solana:signTransaction"]);
  assert.equal(w.name, GLOAM_ACCOUNT_NAME);
  assert.match(w.icon, /^data:image\/svg\+xml;base64,/);
  assert.ok(isGloamAccount(d.found));
  assert.ok(!isGloamAccount({ name: GLOAM_ACCOUNT_NAME, wallet: { features: {} } }), "a wallet that only takes the name is not one");
  assert.ok(!isGloamAccount(null));
  assert.deepEqual((await connectSolana(d.found)).address, solA.address);
  assert.deepEqual((await w.features["standard:connect"].connect({ silent: true })).accounts.map((a) => a.address), [solA.address]);
  assert.ok(same(w.accounts[0]!.publicKey, solA.publicKey));

  // the page: an app listening already, and one that starts after it
  const page = new EventTarget();
  type Api = { register(...ws: object[]): () => void };
  function app() {
    const list = new Set<object>();
    const api: Api = {
      register(...ws) {
        for (const x of ws) list.add(x);
        return () => ws.forEach((x) => list.delete(x));
      },
    };
    return { list, api };
  }
  const early = app();
  page.addEventListener("wallet-standard:register-wallet", (e) => ((e as CustomEvent).detail as (a: Api) => void)(early.api));
  const undo = registerStandardWallet(w, page);
  assert.ok(early.list.has(w), "an app already listening finds it");
  const late = app();
  page.dispatchEvent(new CustomEvent("wallet-standard:app-ready", { detail: late.api }));
  assert.ok(late.list.has(w), "an app that starts later finds it");

  const heard: (readonly unknown[] | undefined)[] = [];
  w.features["standard:events"].on("change", (p) => heard.push(p.accounts));
  // sign-out: gone from every app, nothing signs, listeners hear it
  w.end();
  undo();
  assert.ok(!early.list.has(w) && !late.list.has(w));
  const later = app();
  page.dispatchEvent(new CustomEvent("wallet-standard:app-ready", { detail: later.api }));
  assert.equal(later.list.size, 0, "an app that starts after sign-out never sees it");
  assert.deepEqual(heard, [[]]);
  assert.deepEqual(w.accounts, []);
  const calls = d.calls.length;
  const after = { address: solA.address, account: { address: solA.address, chains: [] } };
  await assert.rejects(signOrSendSolana(d.found, after, await wireFor(0, solA.address), "solana:mainnet"), /Sign in to your Gloam wallet/);
  assert.equal(d.calls.length, calls, "nothing reached Turnkey after sign-out");
  await assert.rejects(connectSolana(d.found), /didn't share an account/);
});

await test("one Gloam account per page: the account layer's wallet signs again when the kit comes back; another person or a sign-out ends it", async () => {
  const solB = solanaKey();
  const keys = new Map([
    [solA.address, solA.key],
    [solB.address, solB.key],
  ]);
  const wireA = await wireFor(0, solA.address);
  const kept = gloamSolanaWalletFor(solA.address);
  const keptFound = asFound(kept);
  const account = await connectSolana(keptFound);
  // the kit not running (the person is on another page of the site): nothing signs
  setGloamSolanaSigner(null);
  await assert.rejects(signOrSendSolana(keptFound, account, wireA, "solana:mainnet"), /Sign in to your Gloam wallet/);
  // the kit back, with a new client: the same wallet object, signing again
  const first = fakeTurnkey(keys);
  setGloamSolanaSigner({ client: first.client, organizationId: ORG });
  assert.equal(gloamSolanaWalletFor(solA.address), kept, "the same wallet object for the same account");
  await signOrSendSolana(keptFound, account, wireA, "solana:mainnet");
  const second = fakeTurnkey(keys);
  setGloamSolanaSigner({ client: second.client, organizationId: ORG });
  await signOrSendSolana(keptFound, account, wireA, "solana:mainnet");
  assert.equal(second.calls.length, 1, "signed with the client the kit runs with now");
  // someone else signs in: the old account ends, the new one signs
  const other = gloamSolanaWalletFor(solB.address);
  assert.notEqual(other, kept);
  assert.deepEqual(kept.accounts, []);
  await assert.rejects(signOrSendSolana(keptFound, account, wireA, "solana:mainnet"), /Sign in to your Gloam wallet/);
  const otherFound = asFound(other);
  await signOrSendSolana(otherFound, await connectSolana(otherFound), await wireFor(0, solB.address), "solana:mainnet");
  // a sign-out ends it, and drops the client
  endGloamSolanaWallet();
  assert.deepEqual(other.accounts, []);
  const fresh = gloamSolanaWalletFor(solB.address);
  assert.notEqual(fresh, other, "signing in again makes a new one");
  await assert.rejects(
    signOrSendSolana(asFound(fresh), { address: solB.address, account: { address: solB.address, chains: [] } }, await wireFor(0, solB.address), "solana:mainnet"),
    /Sign in to your Gloam wallet/,
  );
  endGloamSolanaWallet();
});

/* ---------------------------------------------------------------- bytes */

await test("Solana addresses read back to their keys, leading zeros too; anything else is no address", () => {
  const enc = getAddressEncoder();
  const dec = getAddressDecoder();
  for (let i = 0; i < 300; i++) {
    const key = new Uint8Array(randomBytes(32));
    if (i % 3 === 0) key[0] = 0;
    if (i % 9 === 0) key[1] = 0;
    const a = dec.decode(key);
    assert.ok(same(solanaPublicKey(a)!, key), a);
    assert.ok(same(solanaPublicKey(a)!, new Uint8Array(enc.encode(a))));
  }
  assert.ok(same(solanaPublicKey("11111111111111111111111111111111")!, new Uint8Array(32)));
  for (const bad of ["", "0x1234", "O0Il" + "1".repeat(40), "1".repeat(45), "abc", solA.address + "1"]) assert.equal(solanaPublicKey(bad), null, bad);
  assert.throws(() => makeGloamSolanaWallet({ address: "nope", sign: async () => new Uint8Array(64) }));
});

await test("Turnkey's r and s make the 64-byte signature; anything else is refused", () => {
  const r = "ab".repeat(32);
  const s = "cd".repeat(32);
  assert.equal(hex(ed25519FromParts(r, s)!), r + s);
  assert.equal(hex(ed25519FromParts("0x" + r, "0X" + s)!), r + s);
  assert.equal(ed25519FromParts(r.slice(2), s + "00"), null, "R must be 32 bytes by itself");
  assert.equal(ed25519FromParts(r, s.slice(2)), null);
  assert.equal(ed25519FromParts(r, undefined), null);
  assert.equal(ed25519FromParts("zz".repeat(32), s), null);
});

/* ---------------------------------------------------------------- connecting on its own */

await test("it connects by itself only on Solana, with nothing else connected, once, unless the person left it", () => {
  const go = { on: true, demo: false, connected: false, busy: false, restoring: false, ready: true, declined: false, triedAlready: false };
  assert.equal(shouldAutoConnect(go), true);
  for (const k of ["on", "ready"] as const) assert.equal(shouldAutoConnect({ ...go, [k]: false }), false, k);
  for (const k of ["demo", "connected", "busy", "restoring", "declined", "triedAlready"] as const) assert.equal(shouldAutoConnect({ ...go, [k]: true }), false, k);

  const gloam = { gloam: true };
  const other = { gloam: false };
  assert.equal(declinedAfter(null, gloam, false), false, "using it clears a past choice");
  assert.equal(declinedAfter(gloam, other, false), true, "picking another wallet is leaving it");
  assert.equal(declinedAfter(null, other, false), true);
  assert.equal(declinedAfter(gloam, null, false), true, "Disconnect is leaving it");
  assert.equal(declinedAfter(gloam, null, true), null, "a sign-out of the Gloam wallet is not a choice against it");
  assert.equal(declinedAfter(other, null, false), null, "leaving another wallet says nothing about the Gloam account");
  assert.equal(declinedAfter(null, null, false), null);
});

await test("the choice is kept in this browser per account, and storage that fails costs nothing", () => {
  const mem = new Map<string, string>();
  const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) };
  const other = solanaKey().address;
  assert.equal(gloamAccountDeclined(storage, solA.address), false);
  setGloamAccountDeclined(storage, solA.address, true);
  assert.equal(mem.get(DECLINED_KEY), solA.address);
  assert.equal(gloamAccountDeclined(storage, solA.address), true);
  assert.equal(gloamAccountDeclined(storage, other), false, "another Gloam account signing in here is asked afresh");
  setGloamAccountDeclined(storage, other, false);
  assert.equal(gloamAccountDeclined(storage, solA.address), true, "clearing another account's choice leaves this one's");
  setGloamAccountDeclined(storage, solA.address, false);
  assert.equal(gloamAccountDeclined(storage, solA.address), false);
  const broken = {
    getItem: () => {
      throw new Error("denied");
    },
    setItem: () => {
      throw new Error("denied");
    },
    removeItem: () => {
      throw new Error("denied");
    },
  };
  assert.equal(gloamAccountDeclined(broken, solA.address), false);
  setGloamAccountDeclined(broken, solA.address, true);
  assert.equal(gloamAccountDeclined(null, solA.address), false);
});

await test("the rest of the app hears where the Solana account is, and only on a change", () => {
  let heard = 0;
  const off = onGloamSolana(() => heard++);
  assert.equal(gloamSolana(), GLOAM_SOLANA_OFF);
  setGloamSolana({ status: "making", address: null, error: null, passkeys: [] });
  setGloamSolana({ status: "making", address: null, error: null, passkeys: [] });
  assert.equal(heard, 1);
  setGloamSolana({ status: "ready", address: solA.address, error: null, passkeys: ["cred-1"] });
  assert.deepEqual(gloamSolana(), { status: "ready", address: solA.address, error: null, passkeys: ["cred-1"] });
  setGloamSolana({ status: "off", address: null, error: null, passkeys: [] });
  assert.equal(gloamSolana(), GLOAM_SOLANA_OFF);
  assert.equal(heard, 3);
  off();
  assert.ok(GLOAM_ACCOUNT_ICON.length < 600, "the icon is small");
});

console.log(`selftest-turnkey-solana: ${passed} passed`);
