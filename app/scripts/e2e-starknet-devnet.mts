/**
 * End to end on a local starknet-devnet: two Gloam private accounts on the
 * Starknet privacy pool, through lib/starknetPrivacy only, with every
 * transaction sent by a relay that first passes lib/starknetPrivacy/relayPolicy.
 *
 *  1. The relay deploys both accounts (keys from a seed, the same seeds as the
 *     spike that first proved this, so the same addresses). Neither ever holds STRK.
 *  2. Each opens its account: viewing key and its own channel, one transaction.
 *  3. Alice gets 1.0 of the devnet test token (a bridge would land it on her
 *     address), approves the pool (signed by her, sent by the relay), adds it.
 *  4. Alice pays Bob 0.6, then 0.1. Bob cashes out 0.25 with a relay fee of
 *     0.01, then 0.05. Balances are checked exactly, and the relay's fee arrives.
 *  5. What each transaction shows, read from its calldata and events: the first
 *     payment names Bob (the channel it opens), the second names nobody; no cash
 *     out names Bob; Alice is named only when she registers and adds.
 *
 * Local only (not in CI). Needs:
 *  - starknet-devnet 0.10.1 on PATH (or STARKNET_DEVNET_BIN), Starknet 0.14.4 proof facts;
 *  - the pool built from starkware-libs/starknet-privacy at PRIVACY-0.14.4-RC.2
 *    (`scarb build`), its target/dev in STARKNET_POOL_ARTIFACTS.
 * Proofs are the SDK's mock (the pool contract runs for real; devnet runs with
 * --proof-mode none). The pool's screener is the SDK's test screener key.
 *
 * Run from app/:
 *   STARKNET_POOL_ARTIFACTS=<repo>/target/dev ../mcp/node_modules/.bin/tsx scripts/e2e-starknet-devnet.mts
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Account, CallData, OutsideExecutionVersion, ec, hash, num, outsideExecution, type Call } from "starknet";
import { ScreeningCallMockProofProvider } from "@starkware-libs/starknet-privacy-sdk/testing";
import { keysFromSeed, deployAccountCall, type StarknetAccountKeys } from "../src/lib/starknetPrivacy/account";
import { starknetConfig, STARKNET_ACCOUNT_CLASS_HASH } from "../src/lib/starknetPrivacy/config";
import { starknetProvider, discoveryFor, gloamTransfers } from "../src/lib/starknetPrivacy/client";
import { openAccount, add, pay, cashOut, approveCall, privateBalance } from "../src/lib/starknetPrivacy/actions";
import { checkRelayCall, type RelayContext, type RelayProof } from "../src/lib/starknetPrivacy/relayPolicy";

const PORT = Number(process.env.STARKNET_DEVNET_PORT ?? 5071);
const URL = `http://127.0.0.1:${PORT}`;
const ART = process.env.STARKNET_POOL_ARTIFACTS ?? "";
if (!ART) throw new Error("Set STARKNET_POOL_ARTIFACTS to the pool's target/dev folder.");
const TEST_SCREENER_KEY = "0xCAFEBABE"; // the SDK's test screener (ScreeningCallMockProofProvider signs with it)

const log = (...a: unknown[]) => console.log("[e2e-starknet]", ...a);
const rpc = (method: string, params: unknown = []) =>
  fetch(URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }).then((r) => r.json() as Promise<{ result: unknown; error?: unknown }>);
const mine = async (n: number) => {
  for (let i = 0; i < n; i++) await rpc("devnet_createBlock");
};

const devnet = spawn(
  process.env.STARKNET_DEVNET_BIN ?? "starknet-devnet",
  ["--lite-mode", "--seed", "42", "--block-generation-on", "transaction", "--state-archive-capacity", "full", "--chain-id", "SN_DEVNET", "--proof-mode", "none", "--port", String(PORT)],
  { stdio: ["ignore", "ignore", "inherit"] }
);
const stop = () => {
  if (devnet.exitCode === null) devnet.kill("SIGINT");
};
process.on("exit", stop);

async function main() {
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(`${URL}/is_alive`)).ok) break;
    } catch {
      /* not up yet */
    }
    if (i > 100) throw new Error("starknet-devnet did not start.");
    await new Promise((r) => setTimeout(r, 100));
  }
  const node = starknetProvider(URL);
  const pre = (await rpc("devnet_getPredeployedAccounts")).result as { address: string; private_key: string }[];
  const admin = new Account({ provider: node, address: pre[0].address, signer: pre[0].private_key, cairoVersion: "1" });
  const relay = new Account({ provider: node, address: pre[2].address, signer: pre[2].private_key, cairoVersion: "1" });
  eq(num.toHex(BigInt(await node.getClassHashAt(pre[0].address))), num.toHex(BigInt(STARKNET_ACCOUNT_CLASS_HASH)), "devnet's accounts use Gloam's account class");

  // The pool: governance admin, auditor key (a dummy here), screener key, proof validity 450 blocks.
  const contract = JSON.parse(readFileSync(join(ART, "privacy_Privacy.contract_class.json"), "utf8"));
  const casm = JSON.parse(readFileSync(join(ART, "privacy_Privacy.compiled_contract_class.json"), "utf8"));
  const declared = await admin.declare({ contract, casm, compiledClassHash: hash.computeCompiledClassHash(casm) });
  await node.waitForTransaction(declared.transaction_hash);
  const deployed = await admin.deployContract({
    classHash: declared.class_hash,
    constructorCalldata: [admin.address, "0x1", ec.starkCurve.getStarkKey(TEST_SCREENER_KEY), "450"],
    salt: "0x0",
  });
  const pool = num.toHex(BigInt(deployed.contract_address));
  await mine(10);

  const cfg = starknetConfig("devnet", { NEXT_PUBLIC_STARKNET_POOL: pool, NEXT_PUBLIC_STARKNET_DEVNET_RPC: URL });
  const TOKEN = cfg.tokens[0].address;
  const ONE = 10n ** 18n;
  const ctx = (minFee?: Record<string, bigint>): RelayContext => ({
    cfg,
    relay: relay.address,
    now: Math.floor(Date.now() / 1000),
    maxApprove: { [num.toHex(BigInt(TOKEN))]: 10n * ONE },
    ...(minFee ? { minFee } : {}),
  });
  log("pool", pool, "relay", relay.address);

  const seen: Record<string, { calldata: bigint[]; events: bigint[] }> = {};
  /** The relay: policy first, then send, then let 10+ blocks pass (the prover reads state 10 blocks back). */
  async function relaySend(label: string, calls: Call[], proof?: RelayProof, minFee?: Record<string, bigint>) {
    const d = checkRelayCall(calls, ctx(minFee), proof);
    assert.ok(d.ok, `${label}: relay policy refused it: ${JSON.stringify(d, big)} calls ${JSON.stringify(calls, big)}`);
    const r = await relay.execute(calls, proof ? { proofFacts: proof.proofFacts as string[], proof: proof.proof } : {});
    const receipt = await node.waitForTransaction(r.transaction_hash);
    assert.ok(receipt.isSuccess(), `${label}: ${JSON.stringify(receipt)}`);
    const tx = (await node.getTransactionByHash(r.transaction_hash)) as unknown as { calldata: string[]; sender_address: string };
    eq(num.toHex(BigInt(tx.sender_address)), num.toHex(BigInt(relay.address)), `${label}: sent by the relay`);
    const ev = (receipt as unknown as { events: { keys: string[]; data: string[] }[] }).events.flatMap((e) => [...e.keys, ...e.data]);
    seen[label] = { calldata: tx.calldata.map((x) => BigInt(x)), events: ev.map((x) => BigInt(x)) };
    await mine(12);
    return d;
  }

  async function makeAccount(seedText: string) {
    const keys = await keysFromSeed(new TextEncoder().encode(seedText), 0);
    await relaySend(`deploy ${seedText}`, [deployAccountCall(keys.publicKey)]);
    eq(num.toHex(BigInt(await node.getClassHashAt(keys.address))), num.toHex(BigInt(STARKNET_ACCOUNT_CLASS_HASH)), `${seedText}: deployed at its derived address`);
    const signerAccount = new Account({ provider: node, address: keys.address, signer: num.toHex(keys.accountKey), cairoVersion: "1" });
    const prover = new ScreeningCallMockProofProvider(node as never, cfg.chainId as never);
    const t = gloamTransfers({ cfg, keys, prover, discovery: discoveryFor(cfg, node) });
    return { keys, signerAccount, t };
  }

  const alice = await makeAccount("fake-gloam-seed-alice");
  const bob = await makeAccount("fake-gloam-seed-bob");
  eq(alice.keys.address, "0x68b843b246348a56c37e5b4f485ae3cc0df3d6f6ab80f8d89406a70780ee656", "alice's address is the spike's");

  const proofOf = (r: { callAndProof: { proof: { proofFacts: readonly string[]; data: string } } }): RelayProof => ({ proofFacts: r.callAndProof.proof.proofFacts, proof: r.callAndProof.proof.data });
  const sendProven = (label: string, r: Awaited<ReturnType<typeof add>>, minFee?: Record<string, bigint>) => relaySend(label, [r.callAndProof.call], proofOf(r), minFee);

  await sendProven("alice-open", await openAccount(alice.t, { self: alice.keys.address, tokens: [TOKEN] }));
  await sendProven("bob-open", await openAccount(bob.t, { self: bob.keys.address, tokens: [TOKEN] }));

  // Alice's money arrives on her account (a bridge in the app), then the approve she signs, sent by the relay.
  await admin.execute({ contractAddress: TOKEN, entrypoint: "transfer", calldata: CallData.compile([alice.keys.address, num.toHex(ONE), "0x0"]) }).then((r) => node.waitForTransaction(r.transaction_hash));
  await mine(12);
  const now = Math.floor(Date.now() / 1000);
  const outside = await alice.signerAccount.getOutsideTransaction(
    { caller: relay.address, execute_after: now - 60, execute_before: now + 600 },
    [approveCall(TOKEN, pool, ONE)],
    OutsideExecutionVersion.V2
  );
  await relaySend("alice-approve", outsideExecution.buildExecuteFromOutsideCall(outside));

  await sendProven("alice-add", await add(alice.t, { token: TOKEN, self: alice.keys.address, amount: ONE }));
  await sendProven("alice-pays-bob", await pay(alice.t, { token: TOKEN, self: alice.keys.address, to: bob.keys.address, amount: (6n * ONE) / 10n }));
  await sendProven("alice-pays-bob-2", await pay(alice.t, { token: TOKEN, self: alice.keys.address, to: bob.keys.address, amount: ONE / 10n }));

  const OUT = "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcd";
  const relayBefore = await balanceOf(TOKEN, relay.address);
  const fee = { [num.toHex(BigInt(TOKEN))]: ONE / 100n };
  await sendProven("bob-cash-out", await cashOut(bob.t, { token: TOKEN, self: bob.keys.address, to: OUT, amount: ONE / 4n, fee: { recipient: relay.address, amount: ONE / 100n } }), fee);
  await sendProven("bob-cash-out-2", await cashOut(bob.t, { token: TOKEN, self: bob.keys.address, to: OUT, amount: ONE / 20n }));

  eq(await privateBalance(alice.t, TOKEN), (3n * ONE) / 10n, "alice keeps 0.3 privately");
  eq(await privateBalance(bob.t, TOKEN), (39n * ONE) / 100n, "bob keeps 0.39 privately (0.7 - 0.25 - 0.01 fee - 0.05)");
  eq(await balanceOf(TOKEN, OUT), (3n * ONE) / 10n, "the cash-out wallet got 0.3");
  eq((await balanceOf(TOKEN, relay.address)) - relayBefore, ONE / 100n, "the relay got its fee");
  eq(await balanceOf("0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d", alice.keys.address), 0n, "alice never held STRK");
  eq(await balanceOf("0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d", bob.keys.address), 0n, "bob never held STRK");

  // What each transaction put on the public record.
  const named = (label: string, k: StarknetAccountKeys) => {
    const a = BigInt(k.address);
    return seen[label].calldata.includes(a) || seen[label].events.includes(a);
  };
  const table = Object.keys(seen)
    .filter((l) => !l.startsWith("deploy"))
    .map((l) => ({ tx: l, alice: named(l, alice.keys), bob: named(l, bob.keys) }));
  console.table(table);
  ok(named("alice-add", alice.keys), "an add shows the account it went into");
  ok(named("alice-pays-bob", bob.keys) && !named("alice-pays-bob", alice.keys), "the first payment shows the payee (the channel it opens), never the payer");
  ok(!named("alice-pays-bob-2", bob.keys) && !named("alice-pays-bob-2", alice.keys), "a later payment shows neither");
  ok(!named("bob-cash-out", bob.keys) && !named("bob-cash-out-2", bob.keys), "no cash out shows the account it came from");

  log(`PASS, ${checks} checks`);
}

let checks = 0;
function big(_k: string, v: unknown) {
  return typeof v === "bigint" ? num.toHex(v) : v;
}
function eq<T>(a: T, b: T, msg: string) {
  assert.deepEqual(a, b, msg);
  checks++;
}
function ok(c: unknown, msg: string) {
  assert.ok(c, msg);
  checks++;
}
async function balanceOf(token: string, who: string): Promise<bigint> {
  const node = starknetProvider(URL);
  const r = await node.callContract({ contractAddress: token, entrypoint: "balance_of", calldata: [who] });
  return BigInt(r[0]);
}

main()
  .then(() => {
    stop();
    process.exit(0);
  })
  .catch((e) => {
    console.error(e);
    stop();
    process.exit(1);
  });
