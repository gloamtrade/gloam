/**
 * Self-test: Gloam on Solana (lib/solanaRings).
 *
 *  - the account layer: the same wallet signature always gives the same private
 *    account, another index another one, and the seed is exactly
 *    HKDF-SHA256(signature, "gloam/solana-account/v1", "account/<index>");
 *  - the proxy allowlist (/api/solana/rpc and /api/solana/spr), including the
 *    route itself with Helius faked: refused calls never leave the server and
 *    the key never comes back;
 *  - the relay policy (/api/solana/relay): only Privacy Rings registrations and
 *    transacts the private account signed, the relay as fee payer, the fee
 *    capped; never a deposit, a transfer of the relay's SOL, or another program;
 *  - the relay's key parsing and limits, and the Solana OFAC screen.
 *
 * No network. Run from app/:  ../mcp/node_modules/.bin/tsx scripts/selftest-solana-rings.mts
 */
import assert from "node:assert/strict";
import { createPrivateKey, createPublicKey, generateKeyPairSync, hkdfSync, sign as edSign } from "node:crypto";
import Module from "node:module";
import { fileURLToPath } from "node:url";
import {
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createKeyPairSignerFromBytes,
  createTransactionMessage,
  generateKeyPairSigner,
  getAddressDecoder,
  getBase58Decoder,
  getTransactionEncoder,
  partiallySignTransactionMessageWithSigners,
  pipe,
  setTransactionMessageConfig,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  AccountRole,
  type Address,
  type Instruction,
  type TransactionSigner,
} from "@solana/kit";

const stub = fileURLToPath(new URL("./server-only-stub.cjs", import.meta.url));
const M = Module as unknown as { _resolveFilename: (req: string, ...rest: unknown[]) => string };
const resolve = M._resolveFilename;
M._resolveFilename = function (req: string, ...rest: unknown[]) {
  return req === "server-only" ? stub : resolve.call(this, req, ...rest);
};

const env = process.env as Record<string, string | undefined>;
env.NEXT_PUBLIC_SOLANA_RINGS_ENABLED = "1";
env.NEXT_PUBLIC_SOLANA_RINGS_NETWORK = "mainnet";
const FAKE_KEY = "selftest-helius-key-0000";
env.HELIUS_API_KEY = FAKE_KEY;
delete env.CHAINALYSIS_API_KEY;

const account = await import("../src/lib/solanaRings/account");
const proxy = await import("../src/lib/solanaRings/proxyPolicy");
const relay = await import("../src/lib/solanaRings/relayPolicy");
const server = await import("../src/lib/solanaRings/server");
const screening = await import("../src/lib/screeningServer");
const ofac = (await import("../src/lib/solanaRings/ofacSolana.json", { with: { type: "json" } })).default;
const config = await import("../src/lib/solanaRings/config");
const { SOL_MINT } = await import("@heliuslabs/spr");

let n = 0;
const ok = (cond: unknown, msg: string) => {
  assert.ok(cond, msg);
  n++;
};

// ---------------------------------------------------------------- balances

ok(config.RINGS_SOL_MINT === SOL_MINT, "SOL is looked up under the SDK's own SOL mint");
{
  const usdc = config.ringsAssets("mainnet").find((a) => a.id === "usdc")!.mint!;
  const got = config.ringsBalancesFrom([{ mint: SOL_MINT, amount: 50_000_000n }, { mint: usdc, amount: 7n }], "mainnet");
  ok(got.sol === 50_000_000n && got.usdc === 7n && got.usdt === 0n, "a private SOL and USDC balance read back as held");
}

// ---------------------------------------------------------------- account layer

// a stand-in main wallet: a plain Ed25519 key, signing like Phantom's signMessage
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const walletPub = new Uint8Array(publicKey.export({ format: "der", type: "spki" }).subarray(-32));
const walletSign = (m: Uint8Array) => new Uint8Array(edSign(null, m, privateKey));

const msg0 = account.accountMessage(0);
const msg1 = account.accountMessage(1);
ok(
  new TextDecoder().decode(msg0) ===
    "Gloam private account on Solana\n\nSign to open your private account. This signature is its key: only sign it on gloam.trade.\n\nVersion: 1\nAccount: 0",
  "the account message text has not changed (changing it changes every account)"
);
ok(new TextDecoder().decode(msg1).endsWith("Version: 1\nAccount: 1"), "the message names the index");
assert.throws(() => account.accountMessage(-1));
assert.throws(() => account.accountMessage(1.5));
assert.throws(() => account.accountMessage(1_000_001));
n += 3;

const sig0 = walletSign(msg0);
const sig0again = walletSign(msg0);
const sig1 = walletSign(msg1);
ok(Buffer.from(sig0).equals(Buffer.from(sig0again)), "Ed25519 signatures are deterministic");
ok(await account.isPlainSignature(walletPub, msg0, sig0), "a plain signature over the message verifies");
const tampered = new Uint8Array(sig0);
tampered[0] ^= 1;
ok(!(await account.isPlainSignature(walletPub, msg0, tampered)), "a changed signature does not");
ok(!(await account.isPlainSignature(walletPub, msg1, sig0)), "a signature over another message does not");

const seed0 = await account.accountSeed(sig0, 0);
const expected = new Uint8Array(hkdfSync("sha256", sig0, Buffer.from("gloam/solana-account/v1"), Buffer.from("account/0"), 32));
ok(Buffer.from(seed0).equals(Buffer.from(expected)), "the seed is HKDF-SHA256 with Gloam's salt and info");
ok(Buffer.from(await account.accountSeed(sig0again, 0)).equals(Buffer.from(seed0)), "the same signature gives the same seed");
ok(!Buffer.from(await account.accountSeed(sig1, 1)).equals(Buffer.from(seed0)), "another index gives another seed");
ok(!Buffer.from(await account.accountSeed(sig0, 1)).equals(Buffer.from(seed0)), "the index is bound into the seed itself");
await assert.rejects(account.accountSeed(new Uint8Array(63), 0));
n++;

const a0 = await account.deriveAccount(sig0, 0);
const a0again = await account.deriveAccount(sig0again, 0);
const a1 = await account.deriveAccount(sig1, 1);
const addr0 = a0.toSolanaSigner().address;
ok(addr0 === a0again.toSolanaSigner().address, "the same wallet reopens the same private account");
ok(addr0 !== a1.toSolanaSigner().address, "account 1 is a different private account");
const walletAddr = getAddressDecoder().decode(walletPub);
ok(addr0 !== walletAddr, "the private account is not the main wallet");
// the private account's key is the HKDF seed itself
const pkcs8 = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(seed0)]);
const seedPub = createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
const derivedPub = new Uint8Array(
  createPublicKey(seedPub).export({ format: "der", type: "spki" }).subarray(-32)
);
ok(getAddressDecoder().decode(derivedPub) === addr0, "the private account's address is the Ed25519 key of the seed");
a0again.destroy();
a1.destroy();

// ---------------------------------------------------------------- proxy policy

for (const m of ["getAccountInfo", "getMultipleAccounts", "getLatestBlockhash", "getSignatureStatuses", "sendTransaction", "simulateTransaction"]) {
  ok(proxy.ringsRpcMethodAllowed(m, "mainnet"), `${m} passes`);
}
for (const m of ["getProgramAccounts", "requestAirdrop", "getSignaturesForAddress", "getBlock", "minimumLedgerSlot", "", 7, null]) {
  ok(!proxy.ringsRpcMethodAllowed(m, "mainnet"), `${String(m)} is refused on mainnet`);
}
ok(proxy.ringsRpcMethodAllowed("requestAirdrop", "devnet"), "requestAirdrop on devnet only");

const POOL = relay.SHIELDED_POOL_PROGRAM;
const sdkScan = {
  method: "getProgramAccounts",
  params: [POOL, { commitment: "confirmed", encoding: "base64", filters: [{ dataSize: 48 }, { memcmp: { offset: 0, encoding: "base64", bytes: "BQ==" } }] }],
};
ok(proxy.ringsRpcCallAllowed(sdkScan, "mainnet"), "the SDK's SPL asset registration scan passes");
ok(!proxy.ringsRpcCallAllowed({ method: "getProgramAccounts", params: [POOL, { encoding: "base64" }] }, "mainnet"), "an unfiltered pool scan is refused");
ok(
  !proxy.ringsRpcCallAllowed(
    { method: "getProgramAccounts", params: [relay.USER_REGISTRY_PROGRAM, sdkScan.params[1]] },
    "mainnet"
  ),
  "a scan of another program is refused"
);
ok(
  !proxy.ringsRpcCallAllowed(
    { method: "getProgramAccounts", params: [POOL, { encoding: "base64", filters: [{ dataSize: 48 }] }] },
    "mainnet"
  ),
  "a scan without the registry tag is refused"
);
ok(
  !proxy.ringsRpcCallAllowed(
    { method: "getProgramAccounts", params: [POOL, { encoding: "base64", filters: [{ dataSize: 48 }, { memcmp: { offset: 0, encoding: "base64", bytes: "AQ==" } }] }] },
    "mainnet"
  ),
  "a scan of other pool accounts is refused"
);

const routes: [string[], "GET" | "POST", string | null][] = [
  [["getEncryptedUtxosByTags"], "POST", "getEncryptedUtxosByTags"],
  [["getMerkleProofs"], "POST", "getMerkleProofs"],
  [["getUserRecords"], "POST", "getUserRecords"],
  [["getEncryptedUtxosByTags"], "GET", null],
  [["attestation"], "GET", "attestation"],
  [["proving-keys"], "GET", "proving-keys"],
  [["health"], "GET", "health"],
  [["prove", "transact_2x2"], "POST", "prove/transact_2x2"],
  [["prove", "transact_2x2", "indexed"], "POST", "prove/transact_2x2/indexed"],
  [["prove", "transact_2x2", "status"], "GET", "prove/transact_2x2/status"],
  [["prove", "transact_2x2", "status"], "POST", null],
  [["prove", ".."], "POST", null],
  [["prove", "a", "b", "c"], "POST", null],
  [["..", "admin"], "GET", null],
  [["getProgramAccounts"], "POST", null],
  [[], "GET", null],
  [["prove", "x/y"], "POST", null],
  [["prove", ""], "POST", null],
];
for (const [segs, method, want] of routes) {
  ok(proxy.sprRoute(segs, method) === want, `spr ${method} /${segs.join("/")} -> ${String(want)}`);
}
ok(proxy.sprQuery("attestation", new URLSearchParams("nonce=00112233aabbccdd"))?.get("nonce") === "00112233aabbccdd", "attestation takes a hex nonce");
ok(proxy.sprQuery("attestation", new URLSearchParams("nonce=xyz")) === null, "a bad nonce is refused");
ok(proxy.sprQuery("getMerkleProofs", new URLSearchParams("api-key=stolen")) === null, "a caller can't set api-key");
ok(proxy.sprQuery("prove/k/status", new URLSearchParams("jobId=abc_123"))?.get("jobId") === "abc_123", "status takes a job id");
ok(proxy.sprQuery("getMerkleProofs", new URLSearchParams(""))?.toString() === "", "no query passes as none");

// the key goes only into upstream URLs, on the server
const rpcUrl = server.heliusRpcUrl("mainnet")!;
ok(rpcUrl === `https://mainnet.helius-rpc.com/?api-key=${FAKE_KEY}`, "the RPC URL carries the key");
const sprUrl = server.heliusSprUrl("prove/transact_2x2/status", new URLSearchParams("jobId=1"), "devnet")!;
ok(sprUrl === `https://devnet.helius-rpc.com/v1/spr/prove/transact_2x2/status?jobId=1&api-key=${FAKE_KEY}`, "the spr URL carries the key, once");

// the RPC route, with Helius faked
const realFetch = globalThis.fetch;
const upstreamBodies: unknown[] = [];
globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
  assert.ok(String(url).startsWith("https://mainnet.helius-rpc.com/"), "the route only calls Helius");
  const calls = JSON.parse(String(init?.body)) as { id: unknown; method: string }[];
  upstreamBodies.push(calls);
  return new Response(JSON.stringify(calls.map((c) => ({ jsonrpc: "2.0", id: c.id, result: `ok:${c.method}` }))), {
    headers: { "content-type": "application/json" },
  });
}) as typeof fetch;
const rpcRoute = await import("../src/app/api/solana/rpc/route");
const post = (body: unknown, headers: Record<string, string> = {}) =>
  rpcRoute.POST(
    new Request("http://localhost/api/solana/rpc", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.7", ...headers },
      body: JSON.stringify(body),
    })
  );
let res = await post([
  { jsonrpc: "2.0", id: 1, method: "getLatestBlockhash", params: [] },
  { jsonrpc: "2.0", id: 2, method: "getProgramAccounts", params: [POOL, {}] },
  { jsonrpc: "2.0", id: 3, method: "requestAirdrop", params: [] },
]);
const text = await res.text();
const replies = JSON.parse(text) as { id: number; result?: string; error?: { code: number } }[];
ok(res.status === 200 && replies.length === 3, "a batch gets one reply per call");
ok(replies[0]!.result === "ok:getLatestBlockhash", "an allowed call is answered by Helius");
ok(replies[1]!.error?.code === -32601 && replies[2]!.error?.code === -32601, "refused calls get method-not-allowed");
ok(
  (upstreamBodies[0] as { method: string }[]).map((c) => c.method).join() === "getLatestBlockhash",
  "refused calls never reach Helius"
);
ok(!text.includes(FAKE_KEY), "the key never comes back");
res = await post({ jsonrpc: "2.0", id: 9, method: "getBalance", params: [] }, { "sec-fetch-site": "cross-site" });
ok(res.status === 403, "another site's page is refused");
res = await post(Array.from({ length: proxy.RINGS_RPC_MAX_BATCH + 1 }, (_, i) => ({ jsonrpc: "2.0", id: i, method: "getSlot" })));
ok(res.status === 400, "an oversized batch is refused");
globalThis.fetch = realFetch;

// ---------------------------------------------------------------- relay policy

const relayer = await generateKeyPairSigner();
const owner = a0.toSolanaSigner();
const stranger = await generateKeyPairSigner();
const lifetime = { blockhash: getBase58Decoder().decode(new Uint8Array(32).fill(7)) as never, lastValidBlockHeight: 1_000n };

function ixFor(program: string, data: number[], signers: TransactionSigner[], extra: Address[] = []): Instruction {
  return {
    programAddress: address(program),
    data: Uint8Array.from(data),
    accounts: [
      ...signers.map((s) => ({ address: s.address, role: AccountRole.WRITABLE_SIGNER, signer: s })),
      ...extra.map((a) => ({ address: a, role: AccountRole.WRITABLE })),
    ],
  } as Instruction;
}

async function wire(opts: {
  feePayer?: Address;
  version?: 0 | 1;
  instructions: Instruction[];
  priorityFee?: bigint;
  units?: number;
  relayerSigns?: boolean;
  ownerSigns?: boolean;
}): Promise<Uint8Array> {
  const version = opts.version ?? 1;
  const base = pipe(
    createTransactionMessage({ version }),
    (m) => setTransactionMessageFeePayer(opts.feePayer ?? relayer.address, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(lifetime, m)
  );
  const withConfig =
    version === 1
      ? setTransactionMessageConfig({ computeUnitLimit: opts.units ?? 450_000, priorityFeeLamports: opts.priorityFee ?? 10_000n }, base as never)
      : base;
  const message = appendTransactionMessageInstructions(opts.instructions, withConfig as never);
  let tx =
    opts.ownerSigns === false
      ? compileTransaction(message as never)
      : await partiallySignTransactionMessageWithSigners(message as never);
  if (opts.relayerSigns) {
    const [sigs] = await relayer.signTransactions([tx as never]);
    tx = { ...tx, signatures: { ...tx.signatures, ...sigs } } as never;
  }
  return new Uint8Array(getTransactionEncoder().encode(tx as never));
}

const spr = await import("@heliuslabs/spr");
const { SPL_TOKEN_PROGRAM_ID } = await import("@heliuslabs/spr/interface");
const sprIx = await import("@heliuslabs/spr/instructions");
const shielded = a0.shieldedAddress();
const register = await sprIx.getRegisterInstructionAsync({
  owner,
  payer: relayer.address,
  nullifierPublicKey: shielded.nullifierPublicKey,
  viewingPublicKey: shielded.viewingPublicKey.toBytes(),
});
const mergeEnc = await sprIx.getSetMergeEncryptionInstructionAsync({ owner, scheme: spr.MergeEncryptionScheme.PoseidonCtrV1 });
const transact = ixFor(POOL, [16, 1, 2, 3], [owner], [address("9QyffJUe2wCAwQbkm6MjCEivB9kaQZnvJCedFWnw9mRA")]);
const merge = ixFor(POOL, [17, 0], [owner]);
const deposit = ixFor(POOL, [15, 0], [owner]);
const cashOutTo = address("EZrTwr4q3Q2xvKGtZ6trFJJbPah73gBk43vME4d7p3vU");
const ata = (funder: Address): Instruction =>
  ({
    programAddress: address(relay.ATA_PROGRAM),
    data: Uint8Array.of(1),
    accounts: [
      { address: funder, role: AccountRole.WRITABLE_SIGNER },
      { address: address("4VxubgvasVNWnhQ4nMfm2pxAVZKamXYB9dZwfNrS6rRW"), role: AccountRole.WRITABLE },
      { address: cashOutTo, role: AccountRole.READONLY },
      { address: address("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"), role: AccountRole.READONLY },
      { address: address("11111111111111111111111111111111"), role: AccountRole.READONLY },
      { address: address(SPL_TOKEN_PROGRAM_ID), role: AccountRole.READONLY },
    ],
  }) as Instruction;

const check = (w: Uint8Array) => relay.checkSponsoredTransaction(w, relayer.address);

let v = check(await wire({ instructions: [register, mergeEnc] }));
ok(v.ok && v.kind === "register", "a registration the private account signed passes, as rent");
ok(v.ok && v.accounts.includes(owner.address) && !v.accounts.includes(relayer.address), "it screens the private account, not the relay");
ok(v.ok && !v.accounts.some((a) => a === POOL || a === relay.USER_REGISTRY_PROGRAM || a === "11111111111111111111111111111111"), "programs are not screened");

v = check(await wire({ instructions: [transact] }));
ok(v.ok && v.kind === "transact" && v.ataAccounts.length === 0, "a private payment passes");
v = check(await wire({ instructions: [merge] }));
ok(v.ok && v.kind === "transact", "a merge passes");
v = check(await wire({ instructions: [ata(relayer.address), transact] }));
ok(v.ok && v.ataAccounts.length === 1 && v.accounts.includes(cashOutTo), "a token cash out passes, its new token account named and its recipient screened");

const refuse = async (what: string, w: Uint8Array | Promise<Uint8Array>, reason?: RegExp) => {
  const r = check(await w);
  ok(!r.ok && (!reason || reason.test(r.reason)), `refused: ${what}${r.ok ? "" : ` (${r.reason})`}`);
};
await refuse("a deposit (the relay's SOL into a private balance)", wire({ instructions: [deposit] }), /pool instruction/);
await refuse(
  "a System transfer",
  wire({ instructions: [ixFor("11111111111111111111111111111111", [2, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0], [owner], [stranger.address])] }),
  /program not allowed/
);
await refuse("another program", wire({ instructions: [ixFor("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr", [1], [owner])] }), /program not allowed/);
await refuse("a registry key update (tag 2)", wire({ instructions: [ixFor(relay.USER_REGISTRY_PROGRAM, [2], [owner])] }), /registry instruction/);
await refuse("a pool admin instruction (createSplInterface)", wire({ instructions: [ixFor(POOL, [7], [owner])] }), /pool instruction/);
await refuse("another fee payer", wire({ feePayer: stranger.address, instructions: [transact] }), /fee payer/);
await refuse("a version 0 transaction", wire({ version: 0, instructions: [transact] }), /version 1/);
await refuse("without the private account's signature", wire({ instructions: [transact], ownerSigns: false }), /signature is missing/);
await refuse("already signed by the relay", wire({ instructions: [transact], relayerSigns: true }), /signs last/);
await refuse("only the relay signing", wire({ instructions: [ixFor(POOL, [16], [])] }), /must sign too/);
await refuse("a priority fee over the cap", wire({ instructions: [transact], priorityFee: relay.RELAY_LIMITS.maxPriorityFeeLamports + 1n }), /priority fee/);
{
  const r = relay.checkSponsoredTransaction(await wire({ instructions: [transact], units: 600_000 }), relayer.address, {
    ...relay.RELAY_LIMITS,
    maxComputeUnits: 500_000,
  });
  ok(!r.ok && /compute limit/.test(r.reason), "refused: a compute limit over the cap");
}
await refuse("a token account without a cash out", wire({ instructions: [ata(relayer.address), mergeEnc] }), /only with a cash out/);
await refuse("a token account funded by someone else", wire({ instructions: [ata(owner.address), transact] }), /token account/);
await refuse("registration and payment together", wire({ instructions: [register, transact] }), /separate/);
await refuse("too many instructions", wire({ instructions: [transact, merge, transact, merge, transact] }), /number of instructions/);
await refuse("not a transaction", Promise.resolve(new Uint8Array([1, 2, 3])), /not a Solana transaction/);

// ---------------------------------------------------------------- relay key and limits

ok(server.relayerSecretBytes(undefined) === null && server.relayerSecretBytes("") === null, "no secret, relay off");
ok(server.relayerSecretBytes("[1,2,3]") === null, "a short array is refused");
ok(server.relayerSecretBytes("not base58 0OIl") === null, "garbage is refused");
const testSecret = new Uint8Array(64).map((_, i) => (i * 7 + 3) & 0xff);
ok(Buffer.from(server.relayerSecretBytes(JSON.stringify([...testSecret]))!).equals(Buffer.from(testSecret)), "a Solana CLI keypair array parses");
ok(Buffer.from(server.relayerSecretBytes(getBase58Decoder().decode(testSecret))!).equals(Buffer.from(testSecret)), "a base58 secret parses");
// a real key pair round-trips into a signer
const generated = generateKeyPairSync("ed25519");
const seed = generated.privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32);
const pub = generated.publicKey.export({ format: "der", type: "spki" }).subarray(-32);
const signer = await createKeyPairSignerFromBytes(new Uint8Array([...seed, ...pub]));
ok(signer.address === getAddressDecoder().decode(new Uint8Array(pub)), "a 64-byte secret gives the relay's signer");

const ipReq = (ip: string) => new Request("http://localhost/api/solana/relay", { headers: { "x-forwarded-for": ip } });
const now = Date.UTC(2026, 10, 22, 12, 0, 0);
let allowed = 0;
for (let i = 0; i < 8; i++) if ((await server.ringsRelayRate(ipReq("198.51.100.1"), "rent", now)) === "ok") allowed++;
ok(allowed === server.RINGS_RELAY_LIMITS.rent.perIpPerDay, `rent: ${server.RINGS_RELAY_LIMITS.rent.perIpPerDay} a day per IP`);
allowed = 0;
for (let i = 0; i < 15; i++) if ((await server.ringsRelayRate(ipReq("198.51.100.2"), "transact", now)) === "ok") allowed++;
ok(allowed === server.RINGS_RELAY_LIMITS.transact.perIpPerMin, `payments: ${server.RINGS_RELAY_LIMITS.transact.perIpPerMin} a minute per IP`);
ok((await server.ringsRelayRate(ipReq("198.51.100.3"), "transact", now)) === "ok", "another IP still pays");
{
  // a deployment with no shared count (a preview without Redis)
  const nodeEnv = env.NODE_ENV;
  env.NODE_ENV = "production";
  ok((await server.ringsRelayRate(ipReq("198.51.100.4"), "rent", now, "mainnet")) === "unavailable", "mainnet without Redis: the relay pays no rent and says it is unavailable, not too many");
  ok((await server.ringsRelayRate(ipReq("198.51.100.4"), "transact", now, "mainnet")) === "unavailable", "mainnet without Redis: no payments either");
  ok((await server.ringsRelayRate(ipReq("198.51.100.5"), "rent", now, "devnet")) === "ok", "devnet without Redis: counts on this instance, so a preview can be tested");
  env.NODE_ENV = nodeEnv;
}

// ---------------------------------------------------------------- screening

ok(ofac.addresses.length >= 1 && ofac.addresses.every((a: string) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a)), "the OFAC Solana list is Solana addresses");
ok(!(await screening.screenOtherChainAddresses([cashOutTo, ofac.addresses[0]!])), "an OFAC-listed Solana address is refused");
ok(await screening.screenOtherChainAddresses([cashOutTo, owner.address]), "other addresses pass");

a0.destroy();
console.log(`selftest-solana-rings: ${n} checks passed`);
process.exit(0);
