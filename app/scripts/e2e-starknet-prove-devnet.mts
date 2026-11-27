/**
 * End to end on a local starknet-devnet: showing the payments in one channel
 * (lib/proofs/starknetChannel), against the real privacy pool contract.
 *
 *  1. The pool (PRIVACY-0.14.4-RC.2) and two Gloam private accounts, set up and
 *     funded as scripts/e2e-starknet-devnet.mts does, every transaction through
 *     Gloam's relay code. Alice pays Bob 0.6, then 0.1.
 *  2. Bob lists his channels from the pool (his incoming key decrypted with his
 *     viewing key), makes a disclosure of Alice's payments, signed by his
 *     deployed account; Alice makes one of what she paid Bob.
 *  3. Both verify over JSON-RPC: the account's own is_valid_signature on
 *     chain, the channel marker, each note opened from the pool's storage, the
 *     date of each from its EncNoteCreated event.
 *  4. Tampered fails (amount-bearing key, addresses, who made it, label), and
 *     a devnet disclosure is refused by a mainnet reader.
 *
 * Local only (not in CI). Needs starknet-devnet 0.10.1 (STARKNET_DEVNET_BIN)
 * and the pool's target/dev in STARKNET_POOL_ARTIFACTS. Proofs are the SDK's
 * mock (devnet runs --proof-mode none); the pool contract runs for real.
 *
 * Run from app/:
 *   STARKNET_DEVNET_PORT=5161 STARKNET_POOL_ARTIFACTS=<repo>/target/dev ../mcp/node_modules/.bin/tsx scripts/e2e-starknet-prove-devnet.mts
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import Module from "node:module";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Account, CallData, OutsideExecutionVersion, ec, hash, num, outsideExecution, type Call } from "starknet";
import { ScreeningCallMockProofProvider } from "@starkware-libs/starknet-privacy-sdk/testing";
import type { RelayContext, RelayProof } from "../src/lib/starknetPrivacy/relayPolicy";

const stub = fileURLToPath(new globalThis.URL("./server-only-stub.cjs", import.meta.url));
const M = Module as unknown as { _resolveFilename: (req: string, ...rest: unknown[]) => string };
const resolveFilename = M._resolveFilename;
M._resolveFilename = function (req: string, ...rest: unknown[]) {
  return req === "server-only" ? stub : resolveFilename.call(this, req, ...rest);
};
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;

const PORT = Number(process.env.STARKNET_DEVNET_PORT ?? 5161);
const URL = `http://127.0.0.1:${PORT}`;
process.env.NEXT_PUBLIC_STARKNET_ENABLED = "1";
process.env.NEXT_PUBLIC_STARKNET_NETWORK = "devnet";
process.env.NEXT_PUBLIC_STARKNET_DEVNET_RPC = URL;
for (const k of ["STARKNET_RPC_URL", "STARKNET_PROVER_URL", "STARKSCAN_API_KEY", "VERCEL"]) delete process.env[k];
const { keysFromSeed, deployAccountCall } = await import("../src/lib/starknetPrivacy/account");
const { starknetConfig } = await import("../src/lib/starknetPrivacy/config");
const { starknetProvider, discoveryFor, gloamTransfers } = await import("../src/lib/starknetPrivacy/client");
const { openAccount, add, pay, approveCall } = await import("../src/lib/starknetPrivacy/actions");
const { checkRelayCall } = await import("../src/lib/starknetPrivacy/relayPolicy");
const sc = await import("../src/lib/proofs/starknetChannel");
const rd = await import("../src/lib/proofs/starknetChannelRead");
const ART = process.env.STARKNET_POOL_ARTIFACTS ?? "";
if (!ART) throw new Error("Set STARKNET_POOL_ARTIFACTS to the pool's target/dev folder.");
const TEST_SCREENER_KEY = "0xCAFEBABE";

const log = (...a: unknown[]) => console.log("[e2e-starknet-prove]", ...a);
const rpc = (method: string, params: unknown = []) =>
  fetch(URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }).then((r) => r.json() as Promise<{ result: unknown }>);
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

let checks = 0;
const eq = <T,>(a: T, b: T, msg: string) => {
  assert.deepEqual(a, b, msg);
  checks++;
};
const ok = (c: unknown, msg: string) => {
  assert.ok(c, msg);
  checks++;
};
const big = (_k: string, v: unknown) => (typeof v === "bigint" ? num.toHex(v) : v);

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
  const server = await import("../src/lib/starknetPrivacy/server");
  const pre = (await rpc("devnet_getPredeployedAccounts")).result as { address: string; private_key: string }[];
  const relayKeys = { address: num.toHex(BigInt(pre[2]!.address)), secret: pre[2]!.private_key };
  const admin = new Account({ provider: node, address: pre[0]!.address, signer: pre[0]!.private_key, cairoVersion: "1" });
  const relay = new Account({ provider: node, address: pre[2]!.address, signer: pre[2]!.private_key, cairoVersion: "1" });

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
  const TOKEN = cfg.tokens[0]!.address;
  const ONE = 10n ** 18n;
  const ctx = (): RelayContext => ({ cfg, relay: relay.address, now: Math.floor(Date.now() / 1000), maxApprove: { [num.toHex(BigInt(TOKEN))]: 10n * ONE } });
  log("pool", pool);

  async function relaySend(label: string, calls: Call[], proof?: RelayProof) {
    const d = checkRelayCall(calls, ctx(), proof);
    assert.ok(d.ok, `${label}: relay policy refused it: ${JSON.stringify(d, big)}`);
    const out = await server.relaySend({ calls, proof, cfg, relay: relayKeys.address, chain: server.relayChain(URL, relayKeys), env: { STARKNET_MAX_APPROVE: "10" }, rate: async () => "ok" });
    assert.ok(out.ok, `${label}: the relay refused it: ${JSON.stringify(out, big)}`);
    const receipt = await node.waitForTransaction(out.txHash);
    assert.ok(receipt.isSuccess(), `${label}: ${JSON.stringify(receipt)}`);
    await mine(12);
  }
  async function makeAccount(seedText: string) {
    const keys = await keysFromSeed(new TextEncoder().encode(seedText), 0);
    await relaySend(`deploy ${seedText}`, [deployAccountCall(keys.publicKey)]);
    const signerAccount = new Account({ provider: node, address: keys.address, signer: num.toHex(keys.accountKey), cairoVersion: "1" });
    const prover = new ScreeningCallMockProofProvider(node as never, cfg.chainId as never);
    const t = gloamTransfers({ cfg, keys, prover, discovery: discoveryFor(cfg, node) });
    return { keys, signerAccount, t };
  }
  const proofOf = (r: { callAndProof: { proof: { proofFacts: readonly string[]; data: string } } }): RelayProof => ({ proofFacts: r.callAndProof.proof.proofFacts, proof: r.callAndProof.proof.data });
  const sendProven = (label: string, r: Awaited<ReturnType<typeof add>>) => relaySend(label, [r.callAndProof.call], proofOf(r));

  const alice = await makeAccount("fake-gloam-seed-alice");
  const bob = await makeAccount("fake-gloam-seed-bob");
  await sendProven("alice-open", await openAccount(alice.t, { self: alice.keys.address, tokens: [TOKEN] }));
  await sendProven("bob-open", await openAccount(bob.t, { self: bob.keys.address, tokens: [TOKEN] }));
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
  log("Alice paid Bob 0.6 and 0.1");

  /* ---------------- the disclosures ---------------- */
  const maker = (k: typeof alice.keys) => ({ address: k.address, viewingKey: k.viewingKey, accountKey: k.accountKey, network: "devnet" as const, provider: node, pool, chainId: cfg.chainId, fromBlock: 0 });
  const deps = rd.channelDeps({ network: "devnet", provider: node, pool, chainId: cfg.chainId, fromBlock: 0 });
  const failed = (r: Awaited<ReturnType<typeof sc.verifyStarknetChannel>>, label: string) => !r.ok && r.checks.some((c) => c.state === "fail" && c.label.startsWith(label));

  const bobs = await rd.listChannels(maker(bob.keys));
  eq(bobs.map((c) => [c.side, c.sender]), [["received", alice.keys.address]], "Bob, on the real pool, has one channel: from Alice");
  const preview = await rd.previewChannel(maker(bob.keys), bobs[0]!);
  eq(preview.payments.map((p) => p.amount), [(6n * ONE) / 10n, ONE / 10n], "the pool's notes open to Alice's two payments");

  const expires = Math.floor(Date.now() / 1000) + 7 * 86_400;
  const received = await rd.makeChannelProof(maker(bob.keys), bobs[0]!, "Acme Bank", expires);
  const r = await sc.verifyStarknetChannel(received, deps);
  ok(r.ok, `Bob's disclosure verifies on devnet: ${r.checks.map((c) => `${c.state}:${c.label}`).join(" | ")}`);
  ok(r.payments.length === 2 && r.payments.every((p) => typeof p.at === "number" && typeof p.tx === "string"), "each payment is dated from its EncNoteCreated event");
  for (const p of r.payments) {
    const receipt = (await node.getTransactionReceipt(p.tx!)) as unknown as { events: { from_address: string; keys: string[] }[] };
    ok(receipt.events.some((e) => BigInt(e.from_address) === BigInt(pool) && e.keys.map((k) => BigInt(k)).includes(BigInt(p.noteId))), `payment ${p.index}: its transaction created that note`);
  }
  log("Bob's disclosure:", r.payments.map((p) => `${p.amount} at ${p.at}`).join(", "));

  const alices = await rd.listChannels(maker(alice.keys));
  const toBob = alices.find((c) => c.side === "sent")!;
  ok(toBob && toBob.channelKey === bobs[0]!.channelKey, "Alice derives the same channel key from her side");
  const sent = await rd.makeChannelProof(maker(alice.keys), toBob, "Tax office", expires);
  ok((await sc.verifyStarknetChannel(sent, deps)).ok, "Alice's disclosure of what she paid verifies, signed by her account");

  ok(failed(await sc.verifyStarknetChannel({ ...received, channelKey: num.toHex(BigInt(received.channelKey) + 1n) }, deps), "Made for"), "an edited key breaks Bob's account signature on chain");
  ok(failed(await sc.verifyStarknetChannel({ ...received, by: "sender" }, deps), "Made for"), "Alice's account did not sign Bob's disclosure");
  ok(failed(await sc.verifyStarknetChannel({ ...received, verifier: "Someone Else" }, deps), "Made for"), "an edited label fails");
  ok(failed(await sc.verifyStarknetChannel({ ...received, signature: sent.signature }, deps), "Made for"), "Alice's signature on Bob's disclosure fails");
  const forged = await rd.makeChannelProof(maker(bob.keys), { ...bobs[0]!, channelKey: bobs[0]!.channelKey + 1n }, "Acme Bank", expires).catch((e: Error) => e);
  ok(forged instanceof Error && /no such channel/.test(forged.message), "a key the pool never opened is refused");
  const mainnetDeps = rd.channelDeps({ network: "mainnet", provider: node, pool, chainId: "0x534e5f4d41494e", fromBlock: 0 });
  ok(failed(await sc.verifyStarknetChannel(received, mainnetDeps), "Made on Starknet devnet"), "a mainnet reader refuses a devnet disclosure");
  log(`${checks} checks passed`);
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
