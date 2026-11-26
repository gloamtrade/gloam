/**
 * Self-test: Gloam on Starknet, the core library (lib/starknetPrivacy), with no
 * network and no devnet.
 *
 *  - config: off unless NEXT_PUBLIC_STARKNET_ENABLED is "1"; Sepolia unless the
 *    network is set; pools only from the environment, never guessed; mainnet's
 *    USDC (6 decimals) and its hosted discovery; Sepolia reads the pool directly.
 *  - account: the account message never changes; a wallet signature (65 bytes
 *    EVM, 64 Solana) and a Gloam root each give a seed per index, never the same
 *    seed as a Solana private account from the same bytes; keys from a seed are
 *    deterministic, differ per index, the viewing key is canonical (0 < k < n/2),
 *    and the address matches the devnet spike that sent real transactions
 *    (gloam-night/scratch-starknet/src/gloam-spike, run3.log, 2026-11-25).
 *  - relay policy: the deploy, approve and apply shapes it sends, and every way
 *    each is refused (other class, unique, salt, extra calldata, another caller,
 *    expired or long windows, two calls, unlisted token, other spender, over the
 *    cap, external calls, trailing felts, missing proof, missing or low fee).
 *  - actions on the SDK's in-memory pool (Mocknet): open an account (viewing key
 *    and its own channel in one transaction), add, pay, pay again, cash out, with
 *    exact balances; every apply passes the relay policy; the first payment opens
 *    a channel naming the payee, the second names nobody, and the first cash out
 *    names nobody, because the account's own channel was opened at registration.
 *
 * Run from app/:  ../mcp/node_modules/.bin/tsx scripts/selftest-starknet-core.mts
 */
import assert from "node:assert/strict";
import { CallData, CairoCustomEnum, CairoOption, CairoOptionVariant, ec, hash, num, type Call } from "starknet";

for (const k of Object.keys(process.env)) if (k.startsWith("NEXT_PUBLIC_STARKNET_") || k === "STARKNET_PROVER_URL") delete process.env[k];

const config = await import("../src/lib/starknetPrivacy/config");
const account = await import("../src/lib/starknetPrivacy/account");
const policy = await import("../src/lib/starknetPrivacy/relayPolicy");
const actions = await import("../src/lib/starknetPrivacy/actions");
const solana = await import("../src/lib/solanaRings/account");
const solanaRoot = await import("../src/lib/solanaRings/gloamRoot");
const { Mocknet } = await import("@starkware-libs/starknet-privacy-sdk/testing");
const { PrivacyPoolABI } = await import("@starkware-libs/starknet-privacy-sdk/abi");

let pass = 0;
const ok = (cond: unknown, msg: string) => {
  assert.ok(cond, msg);
  pass++;
};
const eq = <T,>(a: T, b: T, msg: string) => {
  assert.deepEqual(a, b, msg);
  pass++;
};
const rejects = async (p: Promise<unknown>, msg: string) => {
  await assert.rejects(p, msg);
  pass++;
};
const throws = (f: () => unknown, msg: string) => {
  assert.throws(f, msg);
  pass++;
};

const enc = new TextEncoder();
const N: bigint = ec.starkCurve.CURVE.n;
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

/* ------------------------------------------------------------------ config */
{
  ok(config.STARKNET_ENABLED === false, "off by default");
  eq(config.STARKNET_NETWORK, "mainnet", "mainnet by default (its pool, discovery and prover are mainnet only)");
  const m = config.starknetConfig("mainnet", {});
  eq(m.pool, config.STARKNET_MAINNET_POOL, "mainnet's canonical pool by default");
  eq(m.poolClassHash, config.STARKNET_MAINNET_POOL_CLASS_HASH, "pinned to the class read on chain");
  eq(config.STARKNET_MAINNET_POOL, "0x040337b1af3c663e86e333bab5a4b28da8d4652a15a69beee2b677776ffe812a", "the canonical pool's address");
  const same = config.starknetConfig("mainnet", { NEXT_PUBLIC_STARKNET_POOL: "0x40337B1AF3C663E86E333BAB5A4B28DA8D4652A15A69BEEE2B677776FFE812A" });
  eq([same.pool, same.poolClassHash], [config.STARKNET_MAINNET_POOL, config.STARKNET_MAINNET_POOL_CLASS_HASH], "the canonical pool set by hand is still pinned");
  const other = config.starknetConfig("mainnet", { NEXT_PUBLIC_STARKNET_POOL: "0xabc" });
  eq([other.pool, other.poolClassHash], ["0xabc", null], "another pool set by hand is used, not pinned");
  eq(config.starknetConfig("sepolia", {}).pool, null, "no Sepolia pool unless set");
  eq(config.starknetConfig("devnet", {}).poolClassHash, null, "devnet's pool isn't pinned");
  eq(m.tokens.map((t) => [t.symbol, t.decimals, t.address]), [["USDC", 6, "0x033068f6539f8e6e6b131e6b2b814e6c34a5224bc66947c47dab9dfee93b35fb"]], "mainnet USDC");
  eq(m.discovery, { kind: "indexer", url: "https://discovery.nodes.starknet.org" }, "mainnet uses the hosted discovery");
  eq(m.proverUrl, null, "no SDK prover unless set");
  ok(m.starkscanProveUrl?.includes("SN_MAIN"), "Starkscan's prover is mainnet only");
  const s = config.starknetConfig("sepolia", {});
  eq(s.tokens, [], "no Sepolia token unless set");
  eq(s.discovery, { kind: "contract" }, "Sepolia reads the pool directly");
  eq(s.starkscanProveUrl, null, "no Starkscan prover on Sepolia");
  const s2 = config.starknetConfig("sepolia", { NEXT_PUBLIC_STARKNET_POOL: "0xABC", NEXT_PUBLIC_STARKNET_USDC: "0x0512feac6339ff7889822cb5aa2a86c848e9d392bb0e3e237c008674feed8343", STARKNET_PROVER_URL: "https://prover.example/" });
  eq(s2.pool, "0xabc", "pool from the environment, lowercased");
  eq(s2.tokens[0]?.decimals, 6, "Sepolia USDC from the environment");
  eq(s2.proverUrl, "https://prover.example", "prover from the environment");
  eq(config.starknetConfig("sepolia", { NEXT_PUBLIC_STARKNET_POOL: "pool", STARKNET_PROVER_URL: "javascript:x" }).pool, null, "a bad pool is ignored");
  eq(config.starknetConfig("sepolia", { STARKNET_PROVER_URL: "javascript:x" }).proverUrl, null, "a bad prover URL is ignored");
  eq(config.starknetConfig("devnet", {}).tokens[0]?.symbol, "TEST", "devnet stands ETH in for USDC");
  eq(config.STARKNET_CHAIN_IDS.mainnet, num.toHex(BigInt("0x" + Buffer.from("SN_MAIN").toString("hex"))), "SN_MAIN");
  eq(config.STARKNET_CHAIN_IDS.sepolia, num.toHex(BigInt("0x" + Buffer.from("SN_SEPOLIA").toString("hex"))), "SN_SEPOLIA");
  eq(config.STARKNET_CHAIN_IDS.devnet, num.toHex(BigInt("0x" + Buffer.from("SN_DEVNET").toString("hex"))), "SN_DEVNET");
  ok(config.sameStarknetAddress("0x0abc", "0xABC"), "addresses compare by value");
  ok(!config.sameStarknetAddress("0x1", "bad"), "a bad address never matches");
}

/* ------------------------------------------------------------------ account */
{
  eq(
    account.starknetAccountMessage(0),
    "Gloam private account on Starknet\n\nSign to open your private account. This signature is its key: only sign it on gloam.trade.\n\nVersion: 1\nAccount: 0",
    "the account message never changes"
  );
  throws(() => account.starknetAccountMessage(-1), "a negative index is refused");
  throws(() => account.starknetAccountMessage(1.5), "a fractional index is refused");

  const evmSig = new Uint8Array(65).map((_, i) => (i * 7 + 3) & 0xff);
  const solSig = evmSig.slice(0, 64);
  const a0 = await account.seedFromWalletSignature(evmSig, 0);
  const a0again = await account.seedFromWalletSignature(evmSig, 0);
  const a1 = await account.seedFromWalletSignature(evmSig, 1);
  eq(a0.length, 32, "a seed is 32 bytes");
  eq(hex(a0), hex(a0again), "the same signature reopens the same seed");
  ok(hex(a0) !== hex(a1), "each index has its own seed");
  ok((await account.seedFromWalletSignature(solSig, 0)).length === 32, "a 64-byte Solana signature works");
  await rejects(account.seedFromWalletSignature(new Uint8Array(32), 0), "a short signature is refused");
  const solanaSeed = await solana.accountSeed(solSig, 0);
  ok(hex(solanaSeed) !== hex(await account.seedFromWalletSignature(solSig, 0)), "never the Solana account's seed for the same signature");

  const root = new Uint8Array(32).map((_, i) => i + 1);
  const rp = await account.seedFromGloamRoot(root, "passkey", 0);
  const rc = await account.seedFromGloamRoot(root, "code", 0);
  ok(hex(rp) !== hex(rc), "a passkey root and a code root give different seeds");
  ok(hex(rp) !== hex(await solanaRoot.accountSeedFromRoot(root, "passkey", 0)), "never the Solana account's seed for the same root");
  await rejects(account.seedFromGloamRoot(new Uint8Array(8), "code", 0), "a short root is refused");

  // The spike's seeds (raw text) and the addresses it deployed and used on devnet.
  const alice = await account.keysFromSeed(enc.encode("fake-gloam-seed-alice"), 0);
  const bob = await account.keysFromSeed(enc.encode("fake-gloam-seed-bob"), 0);
  eq(alice.address, "0x68b843b246348a56c37e5b4f485ae3cc0df3d6f6ab80f8d89406a70780ee656", "alice's address matches the devnet spike");
  eq(bob.address, "0x4fc00ef9f5e86556c07c159a9e5b8f8373739a80fa0bada4febb522e2472de5", "bob's address matches the devnet spike");
  const again = await account.keysFromSeed(enc.encode("fake-gloam-seed-alice"), 0);
  eq([again.accountKey, again.viewingKey, again.address], [alice.accountKey, alice.viewingKey, alice.address], "keys are deterministic");
  const alice1 = await account.keysFromSeed(enc.encode("fake-gloam-seed-alice"), 1);
  ok(alice1.address !== alice.address && alice1.viewingKey !== alice.viewingKey, "each index has its own keys");
  for (const k of [alice, bob, alice1]) {
    ok(k.viewingKey > 0n && k.viewingKey < N / 2n + 1n && k.viewingKey <= N >> 1n, "the viewing key is canonical");
    ok(k.accountKey > 0n && k.accountKey < N, "the account key is a scalar");
    ok(k.accountKey !== k.viewingKey, "the account and viewing keys differ");
    eq(k.publicKey, ec.starkCurve.getStarkKey(num.toHex(k.accountKey)), "the public key is the account key's");
  }
  eq(account.canonicalViewingKey(N - 5n), 5n, "an upper-half key folds down");
  eq(account.canonicalViewingKey(0n), 1n, "zero becomes one");
  const call = account.deployAccountCall(alice.publicKey);
  const viaStarknetJs = hash.calculateContractAddressFromHash(alice.publicKey, config.STARKNET_ACCOUNT_CLASS_HASH, CallData.compile([alice.publicKey]), 0);
  eq(num.toHex(viaStarknetJs), alice.address, "the UDC deploy lands at the account's address");
  eq(call.contractAddress, config.STARKNET_UDC, "deployed through the UDC");
}

/* ------------------------------------------------------------------ relay policy */
const RELAY = "0x25a6c9f0c15ef30c139065096b4b8e563e6b86191fd600a4f0616df8f22fb77";
const USDC = "0x033068f6539f8e6e6b131e6b2b814e6c34a5224bc66947c47dab9dfee93b35fb";
const POOL = "0x707b48deabbccebce6e3e0af4d9d232fb860e95bffe7efa66ac250b9e28acff";
const NOW = 1_800_000_000;
const ctxBase = {
  cfg: { network: "mainnet" as const, pool: POOL, tokens: [{ symbol: "USDC", name: "USD Coin", address: USDC, decimals: 6 }], udc: config.STARKNET_UDC, accountClassHash: config.STARKNET_ACCOUNT_CLASS_HASH },
  relay: RELAY,
  now: NOW,
  maxApprove: { [num.toHex(BigInt(USDC))]: 10_000_000_000n },
};
{
  const pub = ec.starkCurve.getStarkKey("0x1234");
  const d = policy.checkRelayCall([account.deployAccountCall(pub)], ctxBase);
  eq(d, { ok: true, kind: "deploy", publicKey: num.toHex(BigInt(pub)) }, "the account deploy is sent");
  const bad = (cd: (string | number)[], reason: string, msg: string) =>
    eq(policy.checkRelayCall([{ contractAddress: config.STARKNET_UDC, entrypoint: "deploy_contract", calldata: cd.map(String) }], ctxBase), { ok: false, reason }, msg);
  bad(["0x123", pub, "0x0", "0x1", pub], "deploy_class", "another class is refused");
  bad([config.STARKNET_ACCOUNT_CLASS_HASH, pub, "0x1", "0x1", pub], "deploy_unique", "a unique deploy is refused");
  bad([config.STARKNET_ACCOUNT_CLASS_HASH, "0x99", "0x0", "0x1", pub], "deploy_salt", "a salt other than the key is refused");
  bad([config.STARKNET_ACCOUNT_CLASS_HASH, pub, "0x0", "0x2", pub, "0x5"], "deploy_shape", "extra constructor data is refused");
  eq(policy.checkRelayCall([account.deployAccountCall(pub), account.deployAccountCall(pub)], ctxBase), { ok: false, reason: "one_call_only" }, "two calls are refused");
  eq(policy.checkRelayCall([account.deployAccountCall(pub)], ctxBase, { proofFacts: ["0x1"], proof: "0x1" }), { ok: false, reason: "deploy_takes_no_proof" }, "a deploy carries no proof");
  eq(policy.checkRelayCall([{ contractAddress: config.STARKNET_UDC, entrypoint: "deployContract", calldata: [] }], ctxBase), { ok: false, reason: "not_allowed" }, "another UDC entrypoint is refused");
  eq(policy.checkRelayCall([{ contractAddress: "0x5", entrypoint: "transfer", calldata: ["0x1"] }], ctxBase), { ok: false, reason: "not_allowed" }, "any other call is refused");
}
{
  const ACC = "0x68b843b246348a56c37e5b4f485ae3cc0df3d6f6ab80f8d89406a70780ee656";
  const approve = (o: Partial<{ caller: string; after: number; before: number; token: string; selector: string; spender: string; low: bigint; high: bigint; sig: string[]; calls: number; extra: string[] }> = {}): Call => {
    const c = { caller: RELAY, after: NOW - 60, before: NOW + 600, token: USDC, selector: policy.APPROVE_SELECTOR, spender: POOL, low: 1_000_000n, high: 0n, sig: ["0x1", "0x2"], calls: 1, extra: [], ...o };
    return {
      contractAddress: ACC,
      entrypoint: policy.OUTSIDE_V2_ENTRYPOINT,
      calldata: [c.caller, "0x7", num.toHex(c.after), num.toHex(c.before), num.toHex(c.calls), c.token, c.selector, "0x3", c.spender, num.toHex(c.low), num.toHex(c.high), num.toHex(c.sig.length), ...c.sig, ...c.extra],
    };
  };
  eq(policy.checkRelayCall([approve()], ctxBase), { ok: true, kind: "approve", account: num.toHex(BigInt(ACC)), token: num.toHex(BigInt(USDC)), amount: 1_000_000n }, "an approve of USDC to the pool is sent");
  const no = (c: Call, reason: string, msg: string) => eq(policy.checkRelayCall([c], ctxBase), { ok: false, reason }, msg);
  no(approve({ caller: "0x414e595f43414c4c4552" }), "outside_caller", "ANY_CALLER is refused: only the relay may run it");
  no(approve({ before: NOW - 1 }), "outside_expired", "an expired outside execution is refused");
  no(approve({ before: NOW + 7_200 }), "outside_window", "a window over an hour is refused");
  no(approve({ calls: 2 }), "outside_one_call", "two inner calls are refused");
  no(approve({ token: "0x123" }), "token_not_listed", "an unlisted token is refused");
  no(approve({ selector: hash.getSelectorFromName("transfer") }), "approve_only", "a transfer is refused");
  no(approve({ spender: RELAY }), "approve_spender", "approving anyone but the pool is refused");
  no(approve({ low: 0n }), "approve_amount", "a zero approve is refused");
  no(approve({ low: 20_000_000_000n }), "approve_amount", "an approve over the cap is refused");
  no(approve({ high: 1n }), "approve_amount", "a high word is refused");
  no(approve({ sig: [] }), "outside_signature", "no signature is refused");
  no(approve({ extra: ["0x9"] }), "outside_shape", "trailing felts are refused");
  eq(policy.checkRelayCall([approve()], ctxBase, { proofFacts: ["0x1"], proof: "0x1" }), { ok: false, reason: "approve_takes_no_proof" }, "an approve carries no proof");
  eq(policy.checkRelayCall([approve()], { ...ctxBase, maxApprove: {} }), { ok: false, reason: "approve_amount" }, "a token with no cap can't be approved");
}

/* ------------------------------------------------------------------ the apply rule on real encodings */
{
  const pool = POOL;
  const OUT = "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcd";
  const ctx = ctxBase;
  const proof = { proofFacts: ["0x1"], proof: "0x1" };
  const cd = new CallData(PrivacyPoolABI);
  const none = () => new CairoOption(CairoOptionVariant.None);
  const apply = (actionsList: CairoCustomEnum[], extra: string[] = []): Call => ({
    contractAddress: pool,
    entrypoint: "apply_actions",
    calldata: [...cd.compile("apply_actions", { actions: actionsList, screening: none() }), ...extra],
  });
  const to = (addr: string, amount: number, tok = USDC) => new CairoCustomEnum({ TransferTo: { to_addr: addr, token: tok, amount } });
  const from = (addr: string, amount: number, tok = USDC) => new CairoCustomEnum({ TransferFrom: { from_addr: addr, token: tok, amount } });
  const write = () => new CairoCustomEnum({ WriteOnce: { storage_address: "0x77", value: ["0x1", "0x2"] } });
  const fee = { [num.toHex(BigInt(USDC))]: 5_000n };

  eq(policy.checkRelayCall([apply([write(), to(OUT, 250_000), to(RELAY, 5_000)])], { ...ctx, minFee: fee }, proof), { ok: true, kind: "apply", fee: { token: num.toHex(BigInt(USDC)), amount: 5_000n }, deposits: 0, withdrawals: 2, attestedAt: null }, "a cash out with the relay's fee is sent");
  eq(policy.checkRelayCall([apply([from("0x99", 1_000_000), write()])], ctx, proof), { ok: true, kind: "apply", fee: null, deposits: 1, withdrawals: 0, attestedAt: null }, "an add with no fee asked is sent");
  // A deposit's screening attestation (Some = 0, issued_at, r, s) is read, not judged, here.
  const attested = (actionsList: CairoCustomEnum[], at: number): Call => {
    const c = apply(actionsList);
    const felts = (c.calldata as string[]).slice(0, -1);
    return { ...c, calldata: [...felts, "0x0", num.toHex(at), "0x123", "0x456"] };
  };
  const withAtt = policy.checkRelayCall([attested([from("0x99", 1_000_000), write()], 1_795_000_000)], ctx, proof);
  ok(withAtt.ok && withAtt.kind === "apply" && withAtt.attestedAt === 1_795_000_000, "an add's screening attestation time is read");
  eq(policy.decodeApply((apply([write()]).calldata as string[]).map((x) => BigInt(x)))?.attestedAt, null, "no attestation reads as none");
  eq(policy.checkRelayCall([apply([write(), to(OUT, 250_000)])], { ...ctx, minFee: fee }, proof), { ok: false, reason: "fee_missing" }, "no fee when one is asked is refused");
  eq(policy.checkRelayCall([apply([to(RELAY, 4_999)])], { ...ctx, minFee: fee }, proof), { ok: false, reason: "fee_too_low" }, "a fee under the minimum is refused");
  eq(policy.checkRelayCall([apply([to(OUT, 1, "0x123")])], ctx, proof), { ok: false, reason: "token_not_listed" }, "moving an unlisted token is refused");
  eq(policy.checkRelayCall([apply([new CairoCustomEnum({ Invoke: { contract_address: "0x5", calldata: [] } })])], ctx, proof), { ok: false, reason: "no_external_calls" }, "an external call through the pool is refused");
  eq(policy.checkRelayCall([apply([new CairoCustomEnum({ InvokeWithComputation: { contract_address: "0x5", calldata: [] } })])], ctx, proof), { ok: false, reason: "no_external_calls" }, "a computed external call is refused");
  eq(policy.checkRelayCall([apply(Array.from({ length: policy.MAX_ACTIONS + 1 }, () => write()))], ctx, proof), { ok: false, reason: "too_many_actions" }, "too many actions are refused");
  eq(policy.checkRelayCall([apply([])], ctx, proof), { ok: false, reason: "no_actions" }, "an empty apply is refused");
  eq(policy.checkRelayCall([apply([write()], ["0x1"])], ctx, proof), { ok: false, reason: "actions_decode" }, "trailing felts are refused");
  eq(policy.checkRelayCall([{ ...apply([write()]), entrypoint: "set_fee_amount" }], ctx, proof), { ok: false, reason: "pool_apply_only" }, "any other pool entrypoint is refused");
  eq(policy.checkRelayCall([apply([write()])], ctx), { ok: false, reason: "no_proof_facts" }, "an apply with no proof facts is refused");
  eq(policy.checkRelayCall([apply([write()])], ctx, { proofFacts: ["0x1"], proof: "" }), { ok: false, reason: "no_proof" }, "an apply with an empty proof is refused");
  eq(policy.checkRelayCall([apply([write()])], { ...ctx, cfg: { ...ctx.cfg, network: "sepolia" } }, { proofFacts: ["0x1"], proof: "" }), { ok: false, reason: "no_proof" }, "Sepolia needs a proof too");
  ok(policy.checkRelayCall([apply([write()])], { ...ctx, cfg: { ...ctx.cfg, network: "devnet" } }, { proofFacts: ["0x1"], proof: "" }).ok, "only devnet (mock prover) takes an empty proof");
  eq(policy.checkRelayCall([apply([write()])], { ...ctx, cfg: { ...ctx.cfg, pool: null } }, proof), { ok: false, reason: "not_allowed" }, "with no pool set, nothing reaches a pool");
}

/* ------------------------------------------------------------------ actions on Mocknet */
{
  const mocknet = new Mocknet({ validateBalances: true });
  const env = mocknet.initialize();
  const token = env.ace;
  const alice = await account.keysFromSeed(enc.encode("fake-gloam-seed-alice"), 0);
  const bob = await account.keysFromSeed(enc.encode("fake-gloam-seed-bob"), 0);
  const ta = mocknet.createPrivateTransfers(BigInt(alice.address), alice.viewingKey);
  const tb = mocknet.createPrivateTransfers(BigInt(bob.address), bob.viewingKey);
  mocknet.fundUser(BigInt(alice.address), token, 1_000n);
  // Mocknet's call names the client actions it carries (the pool's own encoding is checked above and on devnet).
  const names = (r: { callAndProof: { call: Call } }) => (r.callAndProof.call.calldata as unknown[]).filter((x): x is string => typeof x === "string" && !x.startsWith("0x"));
  const count = (r: { callAndProof: { call: Call } }, n: string) => names(r).filter((x) => x === n).length;
  const send = (r: unknown) => mocknet.executeOutside(r as never);

  const openA = await actions.openAccount(ta, { self: alice.address, tokens: [token] });
  eq(names(openA), ["SetViewingKey", "OpenChannel", "OpenSubchannel"], "opening registers and opens the account's own channel in one transaction");
  send(openA);
  send(await actions.openAccount(tb, { self: bob.address, tokens: [token] }));

  const added = await actions.add(ta, { token, self: alice.address, amount: 1_000n });
  eq(count(added, "Deposit"), 1, "an add is one deposit");
  eq(count(added, "OpenChannel"), 0, "an add opens no channel");
  send(added);
  eq(await actions.privateBalance(ta, token), 1_000n, "alice holds 1000 privately");

  const pay1 = await actions.pay(ta, { token, self: alice.address, to: bob.address, amount: 600n });
  eq(count(pay1, "OpenChannel"), 1, "the first payment to someone opens a channel to them");
  send(pay1);
  const pay2 = await actions.pay(ta, { token, self: alice.address, to: bob.address, amount: 100n });
  eq(count(pay2, "OpenChannel") + count(pay2, "OpenSubchannel"), 0, "a later payment opens nothing");
  send(pay2);
  eq(await actions.privateBalance(tb, token), 700n, "bob holds 700 privately");

  const OUT = "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcd";
  const out1 = await actions.cashOut(tb, { token, self: bob.address, to: OUT, amount: 250n, fee: { recipient: RELAY, amount: 5n } });
  eq(count(out1, "OpenChannel") + count(out1, "OpenSubchannel"), 0, "the first cash out opens nothing: the account's own channel was opened at registration");
  eq(count(out1, "Withdraw"), 2, "a cash out with a relay fee is two withdrawals");
  send(out1);
  eq(await actions.privateBalance(tb, token), 445n, "bob keeps 445 after cashing out 250 and a fee of 5");
  eq(await actions.privateBalance(ta, token), 300n, "alice keeps 300");

  await rejects(actions.pay(ta, { token, self: alice.address, to: alice.address, amount: 1n }), "paying yourself is refused");
  await rejects(actions.cashOut(ta, { token, self: alice.address, to: OUT, amount: 0n }), "a zero amount is refused");
  await rejects(actions.cashOut(ta, { token, self: alice.address, to: "bob", amount: 1n }), "a bad address is refused");
  await rejects(actions.add(ta, { token, self: alice.address, amount: 5n, fee: { recipient: RELAY, amount: 5n } }), "a fee as large as the add is refused");
  await rejects(actions.openAccount(ta, { self: alice.address, tokens: [] }), "opening with no token is refused");
}

console.log(`\nselftest-starknet-core: ${pass} checks passed`);
