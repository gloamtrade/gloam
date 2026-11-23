/**
 * SDK self-test: Gloam on Solana (src/solanaInfo.ts, src/solana.ts). No network:
 * every request goes to a fake Solana RPC and a fake relay here.
 *
 *  - derivation parity with the Gloam app (app/src/lib/solanaRings/account.ts):
 *    the same message bytes, the same wallet signature gives the same seed and
 *    the same private address, another index another one
 *  - a keypair main wallet signs plain Ed25519, as an account needs
 *  - secret keys parse from a CLI keypair array, base58 or bytes, and a bad
 *    one throws without echoing it
 *  - the registration payload: version 1, the relay as fee payer with its
 *    signature slot empty, the private account signed, and the app's relay
 *    policy accepts it as a registration; the relay request is { tx: base64 }
 *  - a sent transaction's status: landed, failed, dropped only once its
 *    blockhash expired unseen, and every wait ends by its deadline
 *  - the network facts never call the sender or the recipient hidden
 *
 * Run after build:  node test/solana.selftest.mjs
 */
import assert from "node:assert/strict";
import { hkdfSync, webcrypto } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

let checks = 0;
const ok = (cond, msg) => {
  assert.ok(cond, msg);
  checks++;
};

globalThis.fetch = async (url) => {
  throw new Error(`solana selftest: no network calls allowed (${String(url)})`);
};

const root = await import("../dist/index.js");
const sol = await import("../dist/solana.js");

// ---------------------------------------------------------------- facts
ok(typeof root.solanaAccountMessage === "function" && typeof root.solanaNetworkInfo === "function", "the root export carries the Solana facts");
ok(root.solanaAccountSeed === sol.solanaAccountSeed, "the subpath re-exports the same derivation");
const info = sol.solanaNetworkInfo();
ok(info.key === "solana-mainnet" && info.chainId === 792703809 && info.name === "Solana", "mainnet info");
ok(info.assets.map((a) => a.symbol).join(",") === "SOL,USDC,USDT", "SOL, USDC and USDT on mainnet");
ok(info.endpoints.relay === "https://www.gloam.trade/api/solana/relay" && info.endpoints.spr === "https://www.gloam.trade/api/solana/spr", "Gloam's public endpoints");
ok(sol.solanaEndpoints("https://example.test/").rpc === "https://example.test/api/solana/rpc", "a configurable base URL");
assert.throws(() => sol.solanaEndpoints("ftp://x"));
const allText = JSON.stringify([sol.SOLANA_PRIVACY, sol.SOLANA_PRIVACY_NOTE, info]);
ok(/two private accounts/.test(sol.SOLANA_PRIVACY_NOTE) && /asset and the amount/.test(sol.SOLANA_PRIVACY_NOTE), "the privacy line says what is hidden and what is visible");
ok(/Helius's prover/.test(sol.SOLANA_PRIVACY_NOTE), "the privacy line names the prover");
ok(!/(sender|recipient)s? (is|are) hidden|hides? (the )?(sender|recipient|who)/i.test(allText), "nothing claims the sender or recipient is hidden");
ok(!/—|happy to/i.test(allText), "no em dashes or banned phrases in the copy");
ok(sol.solanaAsset("USDC")?.mint === "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" && sol.solanaAsset("sol")?.mint === null, "assets by symbol");
ok(sol.solanaAsset("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB")?.id === "usdt" && sol.solanaAsset("usdt", "devnet") === null, "assets by mint, per network");

// ---------------------------------------------------------------- base58 and addresses
for (const n of [0, 1, 31, 32, 64]) {
  const b = webcrypto.getRandomValues(new Uint8Array(n));
  if (n > 2) b[0] = 0;
  ok(Buffer.from(sol.base58Decode(sol.base58Encode(b))).equals(Buffer.from(b)), `base58 round trip (${n} bytes)`);
}
ok(sol.isSolanaAddress("11111111111111111111111111111111") && sol.isSolanaAddress("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"), "addresses by shape");
ok(!sol.isSolanaAddress("0x0000000000000000000000000000000000000000") && !sol.isSolanaAddress("I1111111111111111111111111111111") && !sol.isSolanaAddress(42), "not addresses");

// ---------------------------------------------------------------- keys
const seedA = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const walletA = await sol.solanaKeypairWallet(seedA);
const pub = sol.base58Decode(walletA.address);
const kp64 = new Uint8Array([...seedA, ...pub]);
ok((await sol.solanaKeypairWallet(JSON.stringify([...kp64]))).address === walletA.address, "a CLI keypair file's array opens the same wallet");
ok((await sol.solanaKeypairWallet(sol.base58Encode(kp64))).address === walletA.address, "its base58 text too");
ok((await sol.solanaKeypairWallet(kp64)).address === walletA.address, "and its 64 bytes");
for (const bad of ["not a key", "[1,2,3]", new Uint8Array(10), "[300]"]) {
  try {
    sol.solanaSecretKeyBytes(bad);
    ok(false, "a bad key throws");
  } catch (e) {
    ok(!String(e.message).includes(String(bad)), "a bad key throws without echoing it");
  }
}

// ---------------------------------------------------------------- the account layer, against the app's
const msg0 = sol.solanaAccountMessage(0);
ok(
  new TextDecoder().decode(msg0) ===
    "Gloam private account on Solana\n\nSign to open your private account. This signature is its key: only sign it on gloam.trade.\n\nVersion: 1\nAccount: 0",
  "the account message has not changed (changing it changes every account)"
);
assert.throws(() => sol.solanaAccountMessage(-1));
assert.throws(() => sol.solanaAccountMessage(1.5));
assert.throws(() => sol.solanaAccountMessage(1_000_001));
const sig0 = await walletA.signMessage(msg0);
ok(sig0.length === 64 && (await sol.isPlainSolanaSignature(pub, msg0, sig0)), "a keypair wallet signs plain Ed25519");
ok(Buffer.from(await walletA.signMessage(msg0)).equals(Buffer.from(sig0)), "and deterministically");
const seed0 = await sol.solanaAccountSeed(sig0, 0);
ok(Buffer.from(seed0).equals(Buffer.from(hkdfSync("sha256", sig0, Buffer.from("gloam/solana-account/v1"), Buffer.from("account/0"), 32))), "seed = HKDF-SHA256(signature, salt, account/<index>)");
const sig1 = await walletA.signMessage(sol.solanaAccountMessage(1));
const addr0 = await sol.solanaAccountAddress(sig0, 0);
const addr1 = await sol.solanaAccountAddress(sig1, 1);
ok(sol.isSolanaAddress(addr0) && addr0 !== addr1 && addr0 !== walletA.address, "account 0 and 1 differ, and neither is the main wallet");

const appFile = join(dirname(fileURLToPath(import.meta.url)), "../../../app/src/lib/solanaRings/account.ts");
const [major, minor] = process.versions.node.split(".").map(Number);
const canStrip = major > 22 || (major === 22 && minor >= 18);
let appChecked = false;
if (existsSync(appFile)) {
  let app = null;
  try {
    process.removeAllListeners("warning");
    app = await import(pathToFileURL(appFile).href);
  } catch (e) {
    if (canStrip) throw e;
  }
  if (app) {
    ok(Buffer.from(app.accountMessage(7)).equals(Buffer.from(sol.solanaAccountMessage(7))), "the app's message bytes are the SDK's");
    ok(Buffer.from(await app.accountSeed(sig0, 0)).equals(Buffer.from(seed0)), "the app's seed for a signature is the SDK's");
    const appKp = await app.deriveAccount(sig0, 0);
    ok(appKp.toSolanaSigner().address === addr0, "the app opens the same private address from the same signature");
    appKp.destroy();
    const appKp1 = await app.deriveAccount(sig1, 1);
    ok(appKp1.toSolanaSigner().address === addr1, "and the same for account 1");
    appKp1.destroy();
    ok((await app.isPlainSignature(pub, msg0, sig0)) === true, "the app accepts the keypair wallet's signature");
    appChecked = true;
  }
}
if (canStrip) ok(appChecked, "derivation parity with the app was checked");

// ---------------------------------------------------------------- a fake Solana RPC and relay
const RELAYER_SEED = Uint8Array.from({ length: 32 }, (_, i) => 200 - i);
const RELAYER = (await sol.solanaKeypairWallet(RELAYER_SEED)).address;
const BLOCKHASH = sol.base58Encode(Uint8Array.from({ length: 32 }, (_, i) => i * 3 + 7));
const chain = { statuses: new Map(), validBlockhash: true, relayed: [] };
const reply = (id, result) => new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), { headers: { "content-type": "application/json" } });
const fakeFetch = async (url, init = {}) => {
  const u = String(url);
  if (u.endsWith("/api/solana/relay")) {
    if ((init.method ?? "GET") === "GET") return new Response(JSON.stringify({ ok: true, on: true, funded: true, relayer: RELAYER, network: "mainnet" }));
    chain.relayed.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ ok: false, error: { code: "not_sponsorable", message: "no" } }), { status: 422 });
  }
  if (!u.endsWith("/api/solana/rpc")) throw new Error(`unexpected request ${u}`);
  const body = JSON.parse(typeof init.body === "string" ? init.body : new TextDecoder().decode(init.body));
  const one = (c) => {
    switch (c.method) {
      case "getAccountInfo":
        return { context: { slot: 1 }, value: null };
      case "getMultipleAccounts":
        return { context: { slot: 1 }, value: c.params[0].map(() => null) };
      case "getLatestBlockhash":
        return { context: { slot: 1 }, value: { blockhash: BLOCKHASH, lastValidBlockHeight: 1000 } };
      case "getSignatureStatuses":
        return { context: { slot: 1 }, value: c.params[0].map((s) => chain.statuses.get(s) ?? null) };
      case "isBlockhashValid":
        return { context: { slot: 1 }, value: chain.validBlockhash };
      default:
        throw new Error(`fake rpc: ${c.method}`);
    }
  };
  if (Array.isArray(body)) return new Response(JSON.stringify(body.map((c) => ({ jsonrpc: "2.0", id: c.id, result: one(c) }))));
  return reply(body.id, one(body));
};
const opts = { fetch: fakeFetch };

const relay = await sol.solanaRelayStatus(opts);
ok(relay.on && relay.funded && relay.relayer === RELAYER && relay.network === "mainnet", "relay status read");
ok((await sol.solanaRelayStatus({ fetch: async () => { throw new Error("down"); } })).on === false, "a relay that doesn't answer is off");

const account = await sol.openSolanaAccount({ wallet: walletA, ...opts });
ok(account.address === addr0 && account.mainAddress === walletA.address && account.index === 0, "openSolanaAccount opens the derived account");
const other = await sol.openSolanaAccount({ wallet: walletA, index: 1, ...opts });
ok(other.address === addr1, "index 1 opens account 1");
const nonPlain = { address: walletA.address, signMessage: async (m) => walletA.signMessage(new Uint8Array([1, ...m])), signTransaction: walletA.signTransaction };
await assert.rejects(() => sol.openSolanaAccount({ wallet: nonPlain, ...opts }), /can't open a Gloam private account/);
checks++;

const wire = await sol.buildSolanaRegistration(account, RELAYER);
ok(wire instanceof Uint8Array, "a registration is built for an account with no record");
ok(sol.solanaTxBlockhash(wire) === BLOCKHASH, "its blockhash is the latest one");
const { getTransactionDecoder, getCompiledTransactionMessageDecoder } = await import("@solana/kit");
const tx = getTransactionDecoder().decode(wire);
const compiled = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
ok(compiled.version === 1 && compiled.staticAccounts[0] === RELAYER, "version 1, the relay pays the fee");
ok(tx.signatures[RELAYER] === null || tx.signatures[RELAYER].every((b) => b === 0), "the relay's signature slot is empty");
ok(tx.signatures[account.address] && tx.signatures[account.address].some((b) => b !== 0), "the private account signed it");
ok(!compiled.staticAccounts.includes(walletA.address), "the main wallet is nowhere in it");
const body = sol.solanaRelayRequest(wire);
ok(Object.keys(body).join() === "tx" && Buffer.from(body.tx, "base64").equals(Buffer.from(wire)), "the relay request is { tx: base64 of the wire bytes }");

const policyFile = join(dirname(fileURLToPath(import.meta.url)), "../../../app/src/lib/solanaRings/relayPolicy.ts");
let policyChecked = false;
if (existsSync(policyFile)) {
  let policy = null;
  try {
    // The app's own source imports its siblings without an extension (its bundler
    // resolves them); let Node find "./config" as "./config.ts" for this check.
    const { register } = await import("node:module");
    register(
      "data:text/javascript,export async function resolve(s,c,n){try{return await n(s,c)}catch(e){if(s.startsWith('.')&&!/\\.[a-z]+$/.test(s)){return n(s+'.ts',c)}throw e}}"
    );
    policy = await import(pathToFileURL(policyFile).href);
  } catch (e) {
    if (canStrip) throw e;
  }
  if (policy) {
    const v = policy.checkSponsoredTransaction(wire, RELAYER);
    ok(v.ok === true && v.kind === "register", `the app's relay policy accepts the registration (${v.reason ?? "ok"})`);
    ok(policy.checkSponsoredTransaction(wire, walletA.address).ok === false, "and refuses it for another fee payer");
    policyChecked = true;
  }
}
if (canStrip) ok(policyChecked, "the relay policy was checked");

// A relay refusal from before the send says nothing was sent.
await assert.rejects(
  () => sol.registerSolanaAccount(account),
  (e) => e instanceof sol.SolanaRelayError && e.code === "not_sponsorable" && e.status === 422 && e.maybeSent === false
);
checks++;
ok(chain.relayed.length === 1 && typeof chain.relayed[0].tx === "string", "the registration went to the relay as { tx }");

// ---------------------------------------------------------------- status with a deadline
let clock = 0;
const fast = { ...opts, sleep: async (ms) => void (clock += ms), now: () => clock };
const sigOf = (n) => sol.base58Encode(Uint8Array.from({ length: 64 }, () => n));
chain.statuses.set(sigOf(1), { slot: 42, err: null, confirmationStatus: "confirmed" });
chain.statuses.set(sigOf(2), { slot: 43, err: { InstructionError: [0, "Custom"] }, confirmationStatus: "confirmed" });
chain.statuses.set(sigOf(3), { slot: 44, err: null, confirmationStatus: "processed" });
let st = await sol.solanaTxStatus({ signature: sigOf(1), blockhash: BLOCKHASH }, opts);
ok(st.state === "landed" && st.slot === 42n, "confirmed reads landed, with its slot");
st = await sol.solanaTxStatus({ signature: sigOf(2), blockhash: BLOCKHASH }, opts);
ok(st.state === "failed", "an error on chain reads failed");
st = await sol.solanaTxStatus({ signature: sigOf(3), blockhash: BLOCKHASH }, opts);
ok(st.state === "pending", "processed is not landed yet");
chain.validBlockhash = true;
st = await sol.solanaTxStatus({ signature: sigOf(4), blockhash: BLOCKHASH }, opts);
ok(st.state === "pending", "unseen with a live blockhash: still pending");
chain.validBlockhash = false;
st = await sol.solanaTxStatus({ signature: sigOf(4), blockhash: BLOCKHASH }, opts);
ok(st.state === "dropped", "unseen with an expired blockhash: dropped, safe to send again");
st = await sol.solanaTxStatus({ signature: sigOf(4) }, opts);
ok(st.state === "pending", "without a blockhash it can't be called dropped");
chain.validBlockhash = true;
clock = 0;
st = await sol.waitForSolanaTx({ signature: sigOf(4), blockhash: BLOCKHASH, timeoutMs: 30_000 }, fast);
ok(st.state === "pending" && clock <= 30_000, "a wait ends at its deadline, pending");
clock = 0;
let polls = 0;
const flipping = { ...fast, fetch: async (u, i) => (++polls === 6 ? ((chain.validBlockhash = false), fakeFetch(u, i)) : fakeFetch(u, i)) };
st = await sol.waitForSolanaTx({ signature: sigOf(5), blockhash: BLOCKHASH, timeoutMs: 120_000 }, flipping);
ok(st.state === "dropped" && clock < 120_000, "a wait ends as soon as the blockhash expires unseen");
clock = 0;
st = await sol.waitForSolanaTx({ signature: sigOf(6), blockhash: BLOCKHASH, timeoutMs: 10_000 }, { ...fast, fetch: async () => { throw new Error("rpc down"); } });
ok(st.state === "pending" && clock <= 10_000, "an RPC that never answers still ends the wait by the deadline");

// ---------------------------------------------------------------- input checks
await assert.rejects(() => sol.paySolanaPrivately(account, { to: "0xabc", asset: "usdc", amount: 1n }), /not a Solana address/);
await assert.rejects(() => sol.paySolanaPrivately(account, { to: account.address, asset: "usdc", amount: 1n }), /itself/);
await assert.rejects(() => sol.paySolanaPrivately(account, { to: addr1, asset: "BONK", amount: 1n }), /lists SOL, USDC, USDT/);
await assert.rejects(() => sol.cashOutSolana(account, { to: walletA.address, asset: "usdc", amount: 0n }), /positive bigint/);
checks += 4;
ok(/too low/.test(sol.solanaErrorMessage({ code: "WALLET_BUILD_TRANSFER", cause: { code: "WALLET_INSUFFICIENT_BALANCE" } })), "SDK error codes in plain words, through causes");

// ---------------------------------------------------------------- an add's own send: a lost answer is followed on chain
{
  const kit = await import("@solana/kit");
  let sendAnswer = () => reply(1, "unused");
  let sends = 0;
  const routed = async (u, i = {}) => {
    if (String(u).endsWith("/api/solana/rpc") && typeof i.body === "string" && JSON.parse(i.body).method === "sendTransaction") {
      sends++;
      return sendAnswer();
    }
    return fakeFetch(u, i);
  };
  const acct = await sol.openSolanaAccount({ wallet: walletA, fetch: routed });
  let n = 0;
  const signedAdd = async () => {
    const msg = kit.pipe(
      kit.createTransactionMessage({ version: 0 }),
      (m) => kit.setTransactionMessageFeePayer(walletA.address, m),
      (m) => kit.setTransactionMessageLifetimeUsingBlockhash({ blockhash: BLOCKHASH, lastValidBlockHeight: 1000n }, m),
      (m) => kit.appendTransactionMessageInstructions([{ programAddress: "ComputeBudget111111111111111111111111111111", data: Uint8Array.of(2, ++n, 0, 0, 0) }], m)
    );
    const wire = new Uint8Array(kit.getTransactionEncoder().encode(kit.compileTransaction(msg)));
    const signed = await walletA.signTransaction(wire);
    return { signed, signature: sol.base58Encode(kit.getTransactionDecoder().decode(signed).signatures[walletA.address]) };
  };
  // Gloam's RPC proxy lost its upstream call after passing it on (-32603, HTTP 502): Solana has it, so its
  // signature decides (here it reached Solana and failed there; landed reads the same way, then syncs)
  let t = await signedAdd();
  sendAnswer = () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32603, message: "Upstream RPC unavailable" } }), { status: 502 });
  chain.statuses.set(t.signature, { slot: 77, err: { InstructionError: [1, "Custom"] }, confirmationStatus: "confirmed" });
  await assert.rejects(() => sol.sendWalletSignedSolanaTx(acct, t.signed, 10_000), (e) => e instanceof sol.SolanaTxError && e.state === "failed" && e.signature === t.signature);
  checks++;
  // the connection dropped and Solana never saw it: dropped once its blockhash expires, so it is safe to add again
  t = await signedAdd();
  sendAnswer = () => {
    throw new TypeError("fetch failed");
  };
  chain.validBlockhash = false;
  await assert.rejects(() => sol.sendWalletSignedSolanaTx(acct, t.signed, 10_000), (e) => e instanceof sol.SolanaTxError && e.state === "dropped" && e.signature === t.signature);
  checks++;
  chain.validBlockhash = true;
  // the node refused it (failed preflight): not sent, said at once
  t = await signedAdd();
  sendAnswer = () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32002, message: "Transaction simulation failed" } }));
  await assert.rejects(() => sol.sendWalletSignedSolanaTx(acct, t.signed, 10_000), (e) => e instanceof sol.SolanaRpcError && e.code === -32002 && /simulation failed/.test(e.message));
  checks++;
  ok(sends === 3, "each add was sent once");
  sol.closeSolanaAccount(acct);
}

sol.closeSolanaAccount(account);
sol.closeSolanaAccount(other);
console.log(`solana.selftest: ok (${checks} assertions${appChecked ? ", app derivation parity and relay policy checked" : ", app checks skipped on this Node"})`);
process.exit(0);
