/**
 * SDK self-test: Gloam on Starknet (src/starknetInfo.ts, src/starknet.ts). No
 * network: every request goes to a fake Gloam relay and RPC here.
 *
 *  - the facts: the canonical pool, USDC, the chain id, the endpoints, a
 *    network list id that names Starknet, "not open yet" said plainly, and a
 *    privacy line that never says a first payment hides the payee and names
 *    the auditor key and the prover
 *  - the derivation: a wallet signature's seed is HKDF-SHA256 with the app's
 *    salt, an EVM signature in either v or s form opens the same account, a
 *    known seed gives the address the app's devnet e2e pins, and a viem
 *    account opens the same account each time (signed twice)
 *  - claim links: a body reads back, a cut or mistyped one is refused, and a
 *    link's seed is HKDF with the claim salt
 *  - typed errors: Starknet off (relay off, a 404, moves off), busy (rate
 *    limited, the relay's day used, the prover's quota), a fee that changed
 *    or is above maxFee, and the prover's errors mapped through `cause`
 *
 * Parity with the app's own files (byte for byte, every derivation) runs in
 * app/scripts/selftest-starknet-sdk.mts; the moves run against a devnet in
 * app/scripts/e2e-starknet-sdk-devnet.mts.
 *
 * Run after build:  node test/starknet.selftest.mjs
 */
import assert from "node:assert/strict";
import { hkdfSync } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { privateKeyToAccount } from "viem/accounts";

let checks = 0;
const ok = (cond, msg) => {
  assert.ok(cond, msg);
  checks++;
};
const rejects = async (p, test, msg) => {
  await assert.rejects(p, test, msg);
  checks++;
};

// starknet.js keeps the fetch it finds when it loads, so one dispatcher is set before any import.
let handler = async (url) => {
  throw new Error(`starknet selftest: no network calls allowed (${String(url)})`);
};
globalThis.fetch = (url, init) => handler(url, init);

const root = await import("../dist/index.js");
const sn = await import("../dist/starknet.js");

// ---------------------------------------------------------------- facts
ok(typeof root.starknetAccountMessage === "function" && typeof root.starknetNetworkInfo === "function", "the root export carries the Starknet facts");
ok(root.starknetSeedFromWalletSignature === sn.starknetSeedFromWalletSignature && root.starknetClaimBody === sn.starknetClaimBody, "the subpath re-exports the same derivation and link format");
const info = sn.starknetNetworkInfo();
ok(info.key === "starknet-mainnet" && info.name === "Starknet" && info.chainId === "0x534e5f4d41494e", "mainnet info: SN_MAIN");
ok(info.pool === "0x040337b1af3c663e86e333bab5a4b28da8d4652a15a69beee2b677776ffe812a" && info.pool === sn.STARKNET_MAINNET_POOL, "Starknet's canonical privacy pool");
ok(info.assets.length === 1 && info.assets[0].symbol === "USDC" && info.assets[0].decimals === 6 && info.assets[0].address === "0x033068f6539f8e6e6b131e6b2b814e6c34a5224bc66947c47dab9dfee93b35fb", "USDC only, Circle's, 6 decimals");
ok(info.listId === 0x5354524b && root.networkName(root.STARKNET_MAINNET_LIST_ID) === "Starknet", "the list id names Starknet");
ok(root.networkName(root.STARKNET_MAINNET_LIST_ID) !== root.networkName(root.SOLANA_MAINNET_CHAIN_ID), "and is not Solana's");
ok(info.endpoints.relay === "https://www.gloam.trade/api/starknet/relay" && info.endpoints.discovery === "https://www.gloam.trade/api/starknet/discovery", "Gloam's routes");
ok(sn.starknetEndpoints("http://127.0.0.1:5151/").prove === "http://127.0.0.1:5151/api/starknet/prove", "a configurable base URL");
assert.throws(() => sn.starknetEndpoints("ftp://x"));
ok(/Not open yet/.test(info.status) && /StarknetOffError/.test(info.status), "the info says Starknet is not open yet");
ok(sn.starknetExplorerTx("0xabc") === "https://voyager.online/tx/0xabc" && sn.starknetExplorerTx("0xabc", "devnet") === null, "Voyager on mainnet, none on a devnet");
ok(sn.starknetAsset("usdc")?.id === "usdc" && sn.starknetAsset("0x33068f6539f8e6e6b131e6b2b814e6c34a5224bc66947c47dab9dfee93b35fb")?.symbol === "USDC" && sn.starknetAsset("USDT") === null, "assets by id, symbol or address (any padding)");
ok(sn.isStarknetAddress("0x1") && !sn.isStarknetAddress("0x0") && !sn.isStarknetAddress("0x" + "f".repeat(64)) && !sn.isStarknetAddress("1234"), "a Starknet address is a non-zero felt below 2^251");
{
  const all = JSON.stringify([sn.STARKNET_PRIVACY, sn.STARKNET_PRIVACY_NOTE, sn.STARKNET_FEES, info]);
  ok(/first payment to someone shows their private account/.test(sn.STARKNET_PRIVACY_NOTE), "the line says the first payment shows the payee's account");
  ok(/channel that is already open/.test(sn.STARKNET_PRIVACY_NOTE), "and that both sides are hidden only over an open channel");
  ok(/auditor key/.test(sn.STARKNET_PRIVACY_NOTE) && /cannot spend/.test(sn.STARKNET_PRIVACY.auditor) && /encrypted to that key/.test(sn.STARKNET_PRIVACY.auditor), "the auditor key is named, what it reads and that it cannot spend");
  ok(/Starkscan's prover/.test(sn.STARKNET_PRIVACY_NOTE) && /sees what the transaction does/.test(sn.STARKNET_PRIVACY.prover), "the prover is named and what it sees");
  ok(/destination address and the amount/.test(JSON.stringify(sn.STARKNET_PRIVACY.visible)) && /private account it went into and the amount/.test(JSON.stringify(sn.STARKNET_PRIVACY.visible)), "adds and cash outs say what is public");
  ok(/0\.25 USDC/.test(sn.STARKNET_FEES) && /read it live/.test(sn.STARKNET_FEES), "the fee is named, and read live");
  ok(!/—|happy to|anonymous|untraceable/i.test(all), "no em dashes, banned phrases or overclaims in the copy");
  ok(!/(always|fully) (hides?|private)/i.test(all), "nothing claims a payment is always hidden");
}

// ---------------------------------------------------------------- derivation
ok(sn.starknetAccountMessage(3).startsWith("Gloam private account on Starknet\n\nSign to open your private account.") && sn.starknetAccountMessage(3).endsWith("Version: 1\nAccount: 3"), "the message names the account index");
assert.throws(() => sn.starknetAccountMessage(-1));
assert.throws(() => sn.starknetAccountMessage(1_000_001));
const sig = Uint8Array.from({ length: 65 }, (_, i) => (i * 7 + 3) & 0xff);
sig[64] = 27;
const seed = await sn.starknetSeedFromWalletSignature(sig, 0);
ok(Buffer.from(seed).equals(Buffer.from(hkdfSync("sha256", sig, Buffer.from("gloam/starknet-account/v1"), Buffer.from("account/0"), 32))), "seed = HKDF-SHA256(signature, gloam/starknet-account/v1, account/<index>)");
ok(!Buffer.from(await sn.starknetSeedFromWalletSignature(sig, 1)).equals(Buffer.from(seed)), "another index, another seed");
ok(Buffer.from(await sn.starknetSeedFromGloamRoot(new Uint8Array(32).fill(9), "passkey", 0)).equals(Buffer.from(hkdfSync("sha256", new Uint8Array(32).fill(9), Buffer.from("gloam/starknet-account/root/v1"), Buffer.from("passkey/account/0"), 32))), "a Gloam wallet's root: its own salt, per kind");
{
  // v as 0/1 and the high-s twin open the same account as v 27/28 with low s.
  const hex = (b) => "0x" + Buffer.from(b).toString("hex");
  const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
  const low = Uint8Array.from(sig);
  low[32] = 0x10; // s well below n/2
  const one = Uint8Array.from(low);
  one[64] = 0;
  const s = BigInt("0x" + Buffer.from(low.subarray(32, 64)).toString("hex"));
  const high = Uint8Array.from(low);
  high.set(Buffer.from((N - s).toString(16).padStart(64, "0"), "hex"), 32);
  high[64] = 28;
  const a = sn.starknetEvmSignatureBytes(hex(low));
  ok(Buffer.from(a).equals(Buffer.from(low)), "a signature already in form comes back unchanged");
  ok(Buffer.from(sn.starknetEvmSignatureBytes(hex(one))).equals(Buffer.from(low)), "v 0 reads as 27");
  ok(Buffer.from(sn.starknetEvmSignatureBytes(hex(high))).equals(Buffer.from(low)), "the high-s twin reads as the low-s signature");
  assert.throws(() => sn.starknetEvmSignatureBytes("0xzz"));
}
const alice = await sn.starknetAccountKeys(new TextEncoder().encode("fake-gloam-seed-alice"), 0);
ok(alice.address === "0x68b843b246348a56c37e5b4f485ae3cc0df3d6f6ab80f8d89406a70780ee656", "a known seed gives the address the app's devnet e2e pins");
ok(alice.viewingKey > 0n && alice.viewingKey < sn.canonicalStarknetViewingKey(alice.viewingKey) + 1n, "the viewing key is canonical");
ok(sn.starknetAccountAddress(alice.publicKey) === alice.address, "the address is the deploy's for its public key");
{
  const d = sn.starknetDeployAccountCall(alice.publicKey);
  ok(d.entrypoint === "deploy_contract" && d.contractAddress === sn.STARKNET_UDC && d.calldata.join() === [sn.STARKNET_ACCOUNT_CLASS_HASH, alice.publicKey, "0x0", "0x1", alice.publicKey].join(), "the deploy call: class, salt = public key, not unique, [public key]");
  const ap = sn.starknetApproveCall(sn.STARKNET_USDC, sn.STARKNET_MAINNET_POOL, 5n);
  ok(ap.entrypoint === "approve" && ap.calldata.join() === [sn.STARKNET_MAINNET_POOL, "0x5", "0x0"].join(), "the approve: pool, amount, high word 0");
}
// A made-up key for an offline signature here (0x11 repeated); nothing is ever sent with it.
const viem = privateKeyToAccount(`0x${"11".repeat(32)}`);
let signs = 0;
const wallet = sn.starknetViemWallet({ signMessage: (a) => (signs++, viem.signMessage(a)) });
const acct = await sn.openStarknetAccount({ wallet });
ok(signs === 2, "a wallet signs twice, so one that signs differently each time is caught");
ok((await sn.openStarknetAccount({ wallet })).address === acct.address, "the same wallet opens the same account");
ok((await sn.openStarknetAccount({ wallet, index: 1 })).address !== acct.address, "index 1 is another account");
{
  const viaSig = await sn.starknetSeedFromWalletSignature(sn.starknetEvmSignatureBytes(await viem.signMessage({ message: sn.starknetAccountMessage(0) })), 0);
  ok((await sn.openStarknetAccount({ seed: viaSig })).address === acct.address, "opening by the seed gives the wallet's account");
}
let flip = 0;
await rejects(
  sn.openStarknetAccount({ wallet: { signMessage: async (m) => viem.signMessage({ message: m + String(flip++) }) } }),
  (e) => e instanceof sn.StarknetError && e.code === "unsteady_wallet",
  "a wallet that signs differently each time is refused"
);
await rejects(sn.openStarknetAccount({ seed: new Uint8Array(32), network: "sepolia" }), sn.StarknetOffError, "no Sepolia pool or prover yet");

// ---------------------------------------------------------------- claim links
{
  const secret = Uint8Array.from({ length: 16 }, (_, i) => i + 1);
  const c = { network: "mainnet", token: 0, amount: 1_250_000n, secret };
  const body = sn.starknetClaimBody(c);
  ok(/^[1-9A-HJ-NP-Za-km-z]+$/.test(body), "a link body is base58: letters and digits only");
  const back = sn.readStarknetClaimBody(body);
  ok(back && back.network === "mainnet" && back.token === 0 && back.amount === 1_250_000n && Buffer.from(back.secret).equals(Buffer.from(secret)), "a body reads back");
  const url = sn.starknetClaimLinkUrl(c);
  ok(url === `https://www.gloam.trade/c#sn=${body}` && sn.isStarknetClaimHash(`#sn=${body}`), "the link is gloam.trade/c#sn=<body>");
  ok(sn.starknetClaimFromLink(url)?.amount === 1_250_000n && sn.starknetClaimFromLink(body)?.amount === 1_250_000n, "a link or a bare body reads");
  ok(sn.readStarknetClaimBody(body.slice(0, -2)) === null, "a cut link is refused");
  const typo = body.slice(0, 10) + (body[10] === "2" ? "3" : "2") + body.slice(11);
  ok(sn.readStarknetClaimBody(typo) === null, "a mistyped link is refused");
  ok(sn.readStarknetClaimBody("0OIl") === null, "not base58");
  ok(sn.readStarknetClaimBody(sn.starknetClaimBody({ ...c, network: "devnet" }))?.network === "devnet", "the network rides in the link");
  const ls = await sn.starknetClaimSeed(secret);
  ok(Buffer.from(ls).equals(Buffer.from(hkdfSync("sha256", secret, Buffer.from("gloam/starknet-claim/v1"), Buffer.from("account"), 32))), "a link's seed: HKDF with the claim salt");
  ok(sn.newStarknetClaimSecret().length === 16, "a fresh secret is 16 bytes");
  assert.throws(() => sn.starknetClaimBody({ ...c, secret: new Uint8Array(15) }));
}

// ---------------------------------------------------------------- the relay and typed errors
const RELAYER = "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcd";
const USDC = "0x33068f6539f8e6e6b131e6b2b814e6c34a5224bc66947c47dab9dfee93b35fb";
const fake = {
  get: { status: 200, body: { ok: true, on: false, funded: false, moves: "off", relayer: null, network: "mainnet", pool: null, fee: {}, maxApprove: {} } },
  post: { status: 404, body: { ok: false, error: { code: "off", message: "Starknet is not on here." } } },
  posts: 0,
  rpc: [],
};
handler = async (url, init = {}) => {
  const u = String(url);
  if (u.endsWith("/api/starknet/relay")) {
    if ((init.method ?? "GET") === "GET") return new Response(JSON.stringify(fake.get.body), { status: fake.get.status });
    fake.posts++;
    return new Response(JSON.stringify(fake.post.body), { status: fake.post.status });
  }
  if (u.endsWith("/api/starknet/rpc")) {
    const body = JSON.parse(init.body);
    const one = (c) => {
      fake.rpc.push(c.method);
      if (c.method === "starknet_getClassHashAt") return { jsonrpc: "2.0", id: c.id, error: { code: 20, message: "Contract not found" } };
      if (c.method === "starknet_blockNumber") return { jsonrpc: "2.0", id: c.id, result: 1000 };
      if (c.method === "starknet_specVersion") return { jsonrpc: "2.0", id: c.id, result: "0.10.0" };
      return { jsonrpc: "2.0", id: c.id, error: { code: -32601, message: `fake rpc: ${c.method}` } };
    };
    return new Response(JSON.stringify(Array.isArray(body) ? body.map(one) : one(body)), { headers: { "content-type": "application/json" } });
  }
  throw new Error(`unexpected request ${u}`);
};

const status = await sn.starknetRelayStatus();
ok(status.reachable && !status.on && status.moves === "off", "the relay says Starknet is off");
fake.get = { status: 500, body: null };
ok((await sn.starknetRelayStatus()).reachable === false, "a relay that doesn't answer reads as unreachable, never throws");

const fresh = () => sn.openStarknetAccount({ seed: new TextEncoder().encode("selftest-seed-0123456789") });
fake.get = { status: 200, body: { ok: true, on: false, funded: false, moves: "off", relayer: RELAYER, network: "mainnet", pool: sn.STARKNET_MAINNET_POOL, fee: {}, maxApprove: {} } };
await rejects(sn.registerStarknetAccount(await fresh()), (e) => e instanceof sn.StarknetOffError && e.code === "off", "register while Starknet is off: StarknetOffError");
await rejects(sn.cashOutStarknet(await fresh(), { to: RELAYER, amount: 1n }), sn.StarknetOffError, "a cash out while it is off");
ok(fake.rpc.length === 0, "and nothing read the chain");
fake.get = { status: 404, body: { error: "not_found" } };
await rejects(sn.addToStarknetPrivate(await fresh(), { amount: 1n }), (e) => e instanceof sn.StarknetOffError, "a server without Starknet's routes: off");
const on = (extra = {}) => ({ status: 200, body: { ok: true, on: true, funded: true, moves: "on", relayer: RELAYER, network: "mainnet", pool: sn.STARKNET_MAINNET_POOL, fee: { [USDC]: "250000" }, maxApprove: { [USDC]: "10000000000" }, ...extra } });
fake.get = on({ moves: "off" });
await rejects(sn.payStarknetPrivately(await fresh(), { to: RELAYER, amount: 1n }), (e) => e instanceof sn.StarknetOffError && e.code === "moves_off", "the relay sends no moves yet: off, moves_off");
fake.get = on({ funded: false });
await rejects(sn.cashOutStarknet(await fresh(), { to: RELAYER, amount: 1n }), (e) => e instanceof sn.StarknetBusyError && e.code === "paused", "an unfunded relay: busy, paused");
fake.get = { status: 429, body: { ok: false } };
await rejects(sn.cashOutStarknet(await fresh(), { to: RELAYER, amount: 1n }), (e) => e instanceof sn.StarknetBusyError && e.code === "rate_limited", "the relay's rate limit: busy");
fake.get = on();
await rejects(
  sn.cashOutStarknet(await fresh(), { to: RELAYER, amount: 1n, maxFee: 100_000n }),
  (e) => e instanceof sn.StarknetFeeChangedError && e.fee === 250_000n && e.was === 100_000n,
  "a fee above maxFee: StarknetFeeChangedError, before any proof"
);
{
  const a = await fresh();
  await rejects(sn.cashOutStarknet(a, { to: RELAYER, amount: 1n }), (e) => e instanceof sn.StarknetError && e.code === "not_open", "an account not on chain yet says so");
  fake.get = on({ fee: { [USDC]: "300000" } });
  await rejects(
    sn.cashOutStarknet(a, { to: RELAYER, amount: 1n }),
    (e) => e instanceof sn.StarknetFeeChangedError && e.fee === 300_000n && e.was === 250_000n,
    "the fee changed since this account read it: StarknetFeeChangedError"
  );
  await rejects(sn.cashOutStarknet(a, { to: RELAYER, amount: 1n }), (e) => e.code === "not_open", "called again, it goes on at the new fee");
}
fake.get = on({ pool: "0x1234" });
await rejects(sn.registerStarknetAccount(await fresh()), (e) => e.code === "pool_mismatch", "on mainnet a server naming another pool is refused");
fake.get = on({ network: "devnet" });
await rejects(sn.registerStarknetAccount(await fresh()), (e) => e.code === "network_mismatch", "a server on another network is refused");

// Relay POST refusals, through a register (not deployed, so it asks the relay to deploy).
fake.get = on();
for (const [status, code, kind] of [
  [404, "off", sn.StarknetOffError],
  [503, "relay_off", sn.StarknetOffError],
  [503, "relay_day_used", sn.StarknetBusyError],
  [429, "rate_limited", sn.StarknetBusyError],
  [503, "relay_unavailable", sn.StarknetBusyError],
  [503, "pool_changed", sn.StarknetBusyError],
]) {
  fake.post = { status, body: { ok: false, error: { code, message: `refused: ${code}` } } };
  await rejects(sn.registerStarknetAccount(await fresh()), (e) => e instanceof kind && e.code === code && e.maybeSent === false, `relay ${code}: ${kind.name}`);
}
fake.post = { status: 422, body: { ok: false, error: { code: "not_relayable", message: "Gloam's relay doesn't send this: fee_too_low." } } };
await rejects(sn.registerStarknetAccount(await fresh()), sn.StarknetFeeChangedError, "a fee below the relay's: StarknetFeeChangedError");
fake.post = { status: 409, body: { ok: false, error: { code: "already_sent", message: "That was already sent." } } };
await rejects(sn.registerStarknetAccount(await fresh()), (e) => e.code === "already_sent" && e.maybeSent === true, "already sent: maybe sent");
fake.post = { status: 504, body: null };
await rejects(sn.registerStarknetAccount(await fresh()), (e) => e.code === "relay_failed" && e.maybeSent === true, "a gateway timeout: maybe sent");

// The prover's errors, as the privacy SDK throws them (wrapped in `cause`).
const wrap = (inner) => Object.assign(new Error("execute failed"), { cause: inner });
const named = (name, props) => Object.assign(new Error(props.message ?? name), { name, ...props });
ok(sn.asStarknetError(wrap(named("ProvingServiceError", { code: -32603, message: "Starknet is busy. Try again later." }))) instanceof sn.StarknetBusyError, "the prover's quota: busy");
ok(sn.asStarknetError(wrap(named("ProvingServiceError", { code: -32603, message: "Starknet is busy. Try again later." }))).code === "quota", "named quota");
ok(sn.asStarknetError(named("ProvingServiceHttpError", { status: 429 })).code === "limited", "this caller's proofs used: busy, limited");
ok(sn.asStarknetError(named("ProvingServiceHttpError", { status: 404 })) instanceof sn.StarknetOffError, "the prove route off: off");
ok(sn.asStarknetError(named("ProvingServiceError", { code: 10000, message: "rejected" })).code === "screening_refused", "screening refused a deposit");
ok(sn.asStarknetError(named("ProvingServiceError", { code: -32603, message: "Proving on Starknet isn't set up yet." })) instanceof sn.StarknetOffError, "no prover set up: off");
ok(sn.asStarknetError(new Error("Insufficient notes for transfer")) instanceof sn.StarknetInsufficientError, "the privacy SDK's insufficient notes: insufficient");
ok(sn.asStarknetError(new Error("something else")).code === "failed", "anything else: failed");
ok(new sn.StarknetInsufficientError("x", 1n, 2n) instanceof sn.StarknetError && new sn.StarknetBusyError("quota", "x").name === "StarknetBusyError", "every typed error is a StarknetError with its own name");

// The words the SDK reads from the app's prover stay the app's words.
const prover = new URL("../../../app/src/lib/starknetPrivacy/starkscanProver.ts", import.meta.url);
if (existsSync(prover)) {
  const text = readFileSync(prover, "utf8");
  ok(/new StarkscanProveError\("quota", "Starknet is busy\. Try again later\."\)/.test(text), "the app's prover still says the quota as the SDK reads it");
}
const route = new URL("../../../app/src/app/api/starknet/relay/route.ts", import.meta.url);
if (existsSync(route)) ok(/refuse\(404, "off"/.test(readFileSync(route, "utf8")), "the app's relay still refuses with 404 off while Starknet is off");

console.log(`starknet.selftest: ok (${checks} checks)`);
