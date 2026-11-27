/**
 * End to end on local forks only (nothing is broadcast anywhere): cashing out
 * from a Gloam private account on Starknet to an address on Base with Circle's
 * CCTP V2 and its forwarding hook, through Gloam's own code
 * (lib/starknetPrivacy/cctpOut, cctpOutServer), then Circle's mint on Base.
 *
 *  1. A fork of Starknet mainnet, with Circle's real contracts. The privacy pool
 *     is the one built from starkware-libs/starknet-privacy (the canonical
 *     pool's screener is Starknet's, so a fork can't add to it); it is deployed
 *     here with the SDK's test screener, and proofs are the SDK's mock (devnet
 *     runs with --proof-mode none). USDC is Circle's real mainnet USDC.
 *  2. Alice's Gloam account is deployed and opened. USDC reaches it the way a
 *     bring-in does: Circle's receive_message, with two throwaway attesters
 *     enabled through the transmitter's impersonated attester manager.
 *  3. She adds it privately (approve signed by her, sent by the relay; the add
 *     proven), as in the app.
 *  4. She cashes out 5 USDC to an address on Base: one transaction from the
 *     relay withdraws 5 USDC and the burn fee to her one-time account, deploys
 *     it, and the one-time account burns 5 USDC with Circle's forwarding hook
 *     and pays the relay. The burn's event and Circle's message carry what
 *     Circle needs (Starknet to Base, the Base address, the hook, the max fee),
 *     the one-time account is left empty, and her own address appears nowhere
 *     in that transaction.
 *  5. Refusals that send nothing: a burn to an unlisted chain, a withdrawal
 *     bigger than the burn, a one-time account signed for by another key.
 *  6. On an anvil fork of Base mainnet, Circle's part stood in for (two
 *     throwaway attesters enabled through Base's impersonated attester
 *     manager; Circle's forwarder would send the same receiveMessage): Base's
 *     MessageTransmitterV2 takes the message and mints 5 USDC less the max fee
 *     to the address.
 *
 * Needs starknet-devnet 0.10.1 (STARKNET_DEVNET_BIN), anvil (~/.foundry/bin),
 * and the pool built at PRIVACY-0.14.4-RC.2 (STARKNET_POOL_ARTIFACTS=<repo>/target/dev).
 * Run from app/:  ../mcp/node_modules/.bin/tsx scripts/e2e-starknet-cctp-out-fork.mts
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import Module from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, encodeFunctionData, http, keccak256, parseAbi, toHex, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount, sign } from "viem/accounts";
import { Account, OutsideExecutionVersion, RpcProvider, ec, hash, num, outsideExecution, stark, type Call } from "starknet";
import { ScreeningCallMockProofProvider } from "@starkware-libs/starknet-privacy-sdk/testing";

const stub = fileURLToPath(new URL("./server-only-stub.cjs", import.meta.url));
const M = Module as unknown as { _resolveFilename: (req: string, ...rest: unknown[]) => string };
const resolve = M._resolveFilename;
M._resolveFilename = function (req: string, ...rest: unknown[]) {
  return req === "server-only" ? stub : resolve.call(this, req, ...rest);
};
const env = process.env as Record<string, string | undefined>;
const ART = env.STARKNET_POOL_ARTIFACTS ?? "";
for (const k of Object.keys(env)) if (k.startsWith("NEXT_PUBLIC_STARKNET_") || k.startsWith("STARKNET_") || k.startsWith("GLOAM_STARKNET_")) delete env[k];
delete env.UPSTASH_REDIS_REST_URL;
delete env.UPSTASH_REDIS_REST_TOKEN;
if (!ART) throw new Error("Set STARKNET_POOL_ARTIFACTS to the pool's target/dev folder.");

const cctp = await import("../src/lib/starknetPrivacy/cctp");
const out = await import("../src/lib/starknetPrivacy/cctpOut");
const outServer = await import("../src/lib/starknetPrivacy/cctpOutServer");
const cctpServer = await import("../src/lib/starknetPrivacy/cctpServer");
const server = await import("../src/lib/starknetPrivacy/server");
const config = await import("../src/lib/starknetPrivacy/config");
const account = await import("../src/lib/starknetPrivacy/account");
const actions = await import("../src/lib/starknetPrivacy/actions");
const client = await import("../src/lib/starknetPrivacy/client");

const SN_PORT = Number(env.CCTP_FORK_STARKNET_PORT ?? 5141);
const EVM_PORT = Number(env.CCTP_FORK_BASE_PORT ?? 8645);
const SN = `http://127.0.0.1:${SN_PORT}`;
const EVM = `http://127.0.0.1:${EVM_PORT}`;
const FORK_BLOCK = 18_600_087;
const TEST_SCREENER_KEY = "0xCAFEBABE";

let pass = 0;
const ok = (c: unknown, msg: string) => {
  assert.ok(c, msg);
  pass++;
  console.log(`  ok  ${msg}`);
};
const eq = <T,>(a: T, b: T, msg: string) => {
  assert.deepEqual(a, b, msg);
  pass++;
  console.log(`  ok  ${msg}`);
};

const MAIN = cctp.STARKNET_CCTP.mainnet;
const USDC = MAIN.usdc;
const BASE = cctp.cctpSourceByDomain(6)!;
const RECIPIENT = privateKeyToAccount(generatePrivateKey()).address; // an address on Base, nothing more

const devnet = spawn(
  env.STARKNET_DEVNET_BIN ?? `${homedir()}/Desktop/Projects/workspace/gloam-night/scratch-starknet/tools/devnet/starknet-devnet`,
  ["--seed", "42", "--port", String(SN_PORT), "--accounts", "3", "--initial-balance", "1000000000000000000000", "--proof-mode", "none", "--state-archive-capacity", "full", "--fork-network", env.CCTP_FORK_STARKNET_RPC ?? "https://mainnet.nodes.starknet.org/rpc/v0_10", "--fork-block", String(FORK_BLOCK)],
  { stdio: ["ignore", "ignore", "inherit"] }
);
const anvil = spawn(`${homedir()}/.foundry/bin/anvil`, ["--fork-url", env.CCTP_FORK_BASE_RPC ?? "https://mainnet.base.org", "--port", String(EVM_PORT), "--silent"], { stdio: "ignore" });
const stop = () => {
  if (devnet.exitCode === null) devnet.kill("SIGINT");
  if (anvil.exitCode === null) anvil.kill("SIGTERM");
};
process.on("exit", stop);

const snRpc = (method: string, params: unknown = []) =>
  fetch(SN, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }).then((r) => r.json() as Promise<{ result?: unknown }>);
const evm = createPublicClient({ transport: http(EVM, { timeout: 120_000 }) });
const evmRaw = (method: string, params: unknown[] = []) => evm.request({ method: method as never, params: params as never }) as Promise<unknown>;
const waitUp = async (f: () => Promise<unknown>, what: string) => {
  for (let i = 0; ; i++) {
    try {
      await f();
      return;
    } catch (e) {
      if (i > 180) throw new Error(`${what} did not start: ${e instanceof Error ? e.message : e}`);
      await new Promise((r) => setTimeout(r, 500));
    }
  }
};

try {
  await waitUp(async () => {
    if (!(await snRpc("starknet_chainId")).result) throw new Error("no chain id");
  }, "starknet-devnet");
  await waitUp(() => evm.getChainId(), "anvil");
  const node = new RpcProvider({ nodeUrl: SN, batch: 0 });
  const mine = async (n: number) => {
    for (let i = 0; i < n; i++) await snRpc("devnet_createBlock");
  };
  const pre = (await snRpc("devnet_getPredeployedAccounts")).result as { address: string; private_key: string }[];
  // devnet's own throwaway accounts (seed 42): an admin and the relay.
  const admin = new Account({ provider: node, address: pre[0]!.address, signer: pre[0]!.private_key, cairoVersion: "1" });
  const relayKeys = { address: num.toHex(BigInt(pre[1]!.address)), secret: pre[1]!.private_key };
  const usdcOf = async (a: string) => BigInt((await node.callContract({ contractAddress: USDC, entrypoint: "balance_of", calldata: [a] }))[0]!);

  /* ------------------------------------------------------------------ 1. the pool on the fork */
  console.log("1. a privacy pool on a fork of Starknet mainnet, Circle's USDC");
  const contract = JSON.parse(readFileSync(join(ART, "privacy_Privacy.contract_class.json"), "utf8"));
  const casm = JSON.parse(readFileSync(join(ART, "privacy_Privacy.compiled_contract_class.json"), "utf8"));
  const declared = await admin.declare({ contract, casm, compiledClassHash: hash.computeCompiledClassHash(casm) });
  await node.waitForTransaction(declared.transaction_hash);
  const dep = await admin.deployContract({ classHash: declared.class_hash, constructorCalldata: [admin.address, "0x1", ec.starkCurve.getStarkKey(TEST_SCREENER_KEY), "450"], salt: "0x0" });
  await node.waitForTransaction(dep.transaction_hash);
  const pool = num.toHex(BigInt(dep.contract_address));
  // A devnet (empty proofs pass the relay's policy) whose chain is the fork's, SN_MAIN, with Circle's USDC.
  const cfg = {
    ...config.starknetConfig("devnet", { NEXT_PUBLIC_STARKNET_POOL: pool, NEXT_PUBLIC_STARKNET_DEVNET_RPC: SN }),
    chainId: config.STARKNET_CHAIN_IDS.mainnet,
    tokens: [{ symbol: "USDC", name: "USD Coin", address: USDC, decimals: 6 }],
  };
  const ENV = { STARKNET_RELAY_FEE: "0.25", STARKNET_CCTP_FEE: "0.25", STARKNET_MAX_APPROVE: "10000" };
  const RELAY_FEE = 250_000n;
  const BURN_FEE = 250_000n;
  await mine(11);
  ok(pool, `pool ${pool}`);

  const relaySend = async (label: string, calls: Call[], proof?: { proofFacts: readonly string[]; proof: string }) => {
    const r = await server.relaySend({ calls, proof, cfg, relay: relayKeys.address, chain: server.relayChain(SN, relayKeys), env: ENV, rate: async () => "ok" });
    if (!r.ok) throw new Error(`${label}: ${r.code} ${r.message}`);
    const rc = (await node.waitForTransaction(r.txHash)) as unknown as { execution_status?: string };
    assert.equal(rc.execution_status, "SUCCEEDED", label);
    await mine(12);
  };

  /* ------------------------------------------------------------------ 2. alice, opened and funded with Circle's USDC */
  console.log("2. alice's Gloam account, opened, with USDC minted to it by Circle's receive_message");
  const keys = await account.keysFromSeed(new TextEncoder().encode(`gloam-cctp-out-e2e-${Date.now()}`), 0);
  await relaySend("deploy", [account.deployAccountCall(keys.publicKey)]);
  const prover = new ScreeningCallMockProofProvider(node as never, cfg.chainId as never);
  const t = client.gloamTransfers({ cfg, keys, prover, discovery: client.discoveryFor(cfg, node) });
  const proofOf = (r: { callAndProof: { proof: { proofFacts: readonly string[]; data: string } } }) => ({ proofFacts: r.callAndProof.proof.proofFacts, proof: r.callAndProof.proof.data });
  const opened = await actions.openAccount(t, { self: keys.address, tokens: [USDC] });
  await relaySend("open", [opened.callAndProof.call], proofOf(opened));

  const attesters = [generatePrivateKey(), generatePrivateKey()].map((k) => ({ k, a: privateKeyToAccount(k).address.toLowerCase() })).sort((x, y) => (BigInt(x.a) < BigInt(y.a) ? -1 : 1));
  const attest = async (message: string) => ("0x" + (await Promise.all(attesters.map((x) => sign({ hash: keccak256(message as Hex), privateKey: x.k, to: "hex" })))).map((s) => s.slice(2)).join("")) as Hex;
  const manager = (await node.callContract({ contractAddress: MAIN.messageTransmitter, entrypoint: "attester_manager", calldata: [] }))[0]!;
  await snRpc("devnet_impersonateAccount", { account_address: manager });
  const mgr = new Account({ provider: node, address: manager, signer: "0x1", cairoVersion: "1" });
  for (const x of attesters) await node.waitForTransaction((await mgr.execute([{ contractAddress: MAIN.messageTransmitter, entrypoint: "enable_attester", calldata: [x.a] }])).transaction_hash);
  await snRpc("devnet_stopImpersonateAccount", { account_address: manager });
  const fund = cctp.encodeBurnMessage({
    version: 1,
    sourceDomain: 6,
    destinationDomain: 25,
    nonce: keccak256(toHex(`gloam-out-fund-${Date.now()}`)),
    sender: BASE.messenger,
    recipient: cctp.starknetToBytes32(MAIN.tokenMessengerMinter),
    destinationCaller: cctp.ZERO_BYTES32,
    minFinalityThreshold: 2000,
    finalityThresholdExecuted: 2000,
    body: { version: 1, burnToken: cctp.evmToBytes32(BASE.usdc), mintRecipient: cctp.starknetToBytes32(keys.address), amount: 20_000_000n, messageSender: cctp.evmToBytes32(RECIPIENT), maxFee: 0n, feeExecuted: 0n, expirationBlock: 0n, hookData: "0x" },
  });
  await node.waitForTransaction((await admin.execute([cctp.receiveMessageCall(MAIN, fund, await attest(fund))])).transaction_hash);
  eq(await usdcOf(keys.address), 20_000_000n, "alice's account holds 20 USDC from Circle's mint");
  await mine(12);

  /* ------------------------------------------------------------------ 3. add privately */
  console.log("3. alice adds 15 USDC privately");
  const signer = new Account({ provider: node, address: keys.address, signer: num.toHex(keys.accountKey), cairoVersion: "1" });
  const now0 = Math.floor(Date.now() / 1000);
  const approveOut = await signer.getOutsideTransaction({ caller: relayKeys.address, execute_after: now0 - 60, execute_before: now0 + 600 }, [actions.approveCall(USDC, pool, 15_000_000n)], OutsideExecutionVersion.V2);
  await relaySend("approve", outsideExecution.buildExecuteFromOutsideCall(approveOut));
  const added = await actions.add(t, { token: USDC, self: keys.address, amount: 15_000_000n, fee: { recipient: relayKeys.address, amount: RELAY_FEE } });
  await relaySend("add", [added.callAndProof.call], proofOf(added));
  eq(await actions.privateBalance(t, USDC), 15_000_000n - RELAY_FEE, "14.75 USDC private");

  /* ------------------------------------------------------------------ 4. cash out to Base */
  console.log("4. alice cashes out 5 USDC to an address on Base, in one transaction");
  const oneTime = await out.oneTimeKeys(keys.accountKey, 0);
  ok(!config.sameStarknetAddress(oneTime.address, keys.address), "her one-time account is not her account");
  const amount = 5_000_000n;
  const forward = { low: 53_448n, med: 54_072n, high: 55_121n }; // Circle's forwarding fee to Base, 2026-11-27
  const costs = out.cashOutToChainCosts(amount, 12, forward, RELAY_FEE, BURN_FEE)!;
  const proven = await actions.cashOut(t, { token: USDC, self: keys.address, to: oneTime.address, amount: amount + BURN_FEE, fee: { recipient: relayKeys.address, amount: RELAY_FEE } });
  const otSigner = new Account({ provider: node, address: oneTime.address, signer: num.toHex(oneTime.key), cairoVersion: "1" });
  const signOut = async (by: Account, calls: Call[]) => {
    const now = Math.floor(Date.now() / 1000);
    const o = await by.getOutsideTransaction({ caller: relayKeys.address, execute_after: now - 60, execute_before: now + 600 }, calls, OutsideExecutionVersion.V2, stark.randomAddress());
    return outsideExecution.buildExecuteFromOutsideCall(o)[0]!;
  };
  const calls = out.oneTimeCalls(MAIN, { amount, domain: 6, recipient: RECIPIENT, maxFee: costs.maxFee, relay: relayKeys.address, fee: BURN_FEE });
  const chain = cctpServer.cctpChain(SN, relayKeys);
  const send = (over: Partial<Parameters<typeof outServer.cctpBurnSend>[0]> = {}) =>
    outServer.cctpBurnSend({ apply: proven.callAndProof.call, proof: proofOf(proven), deploy: oneTime.publicKey, outside: over.outside ?? ({} as Call), cfg, cctp: MAIN, relay: relayKeys.address, chain, env: ENV, rate: async () => "ok", outRate: async () => "ok", ...over });

  // 5 first: what the relay refuses sends nothing.
  console.log("5. refusals that send nothing");
  const relayNonce = async () => BigInt(await node.getNonceForAddress(relayKeys.address, "latest"));
  const n0 = await relayNonce();
  const toSei = await send({ outside: await signOut(otSigner, out.oneTimeCalls(MAIN, { amount, domain: 16, recipient: RECIPIENT, maxFee: costs.maxFee, relay: relayKeys.address, fee: BURN_FEE })) });
  eq(toSei.ok ? "sent" : toSei.code, "not_relayable", "a burn to a chain Gloam doesn't list");
  const smaller = await send({ outside: await signOut(otSigner, out.oneTimeCalls(MAIN, { amount: amount - 1n, domain: 6, recipient: RECIPIENT, maxFee: costs.maxFee, relay: relayKeys.address, fee: BURN_FEE })) });
  eq(smaller.ok ? "sent" : smaller.code, "not_relayable", "a withdrawal bigger than the burn (money left on the one-time account)");
  const stranger = new Account({ provider: node, address: oneTime.address, signer: num.toHex(987654321n), cairoVersion: "1" });
  const forged = await send({ outside: await signOut(stranger, calls) });
  eq(forged.ok ? "sent" : forged.code, "would_fail", "the one-time account signed for by another key: Starknet won't run it");
  eq(await relayNonce(), n0, "the relay sent nothing for any of them");

  const relayUsdc0 = await usdcOf(relayKeys.address);
  const poolUsdc0 = await usdcOf(pool);
  const r = await send({ outside: await signOut(otSigner, calls) });
  ok(r.ok, `the relay sent it${r.ok ? "" : `: ${r.code} ${r.message}`}`);
  if (!r.ok) throw new Error("cash out failed");
  const rc = (await node.waitForTransaction(r.txHash)) as unknown as { execution_status?: string; events: { from_address: string; keys: string[]; data: string[] }[]; actual_fee?: { amount: string } };
  eq(rc.execution_status, "SUCCEEDED", "one transaction: the proven cash out, the one-time account's deploy, its burn");
  console.log(`      it cost the relay ${(Number(BigInt(rc.actual_fee?.amount ?? 0)) / 1e18).toFixed(3)} STRK on devnet's prices`);
  eq(num.toHex(BigInt(await node.getClassHashAt(oneTime.address))), num.toHex(BigInt(config.STARKNET_ACCOUNT_CLASS_HASH)), "the one-time account is deployed with Gloam's class");
  eq(await usdcOf(oneTime.address), 0n, "and left empty");
  eq(poolUsdc0 - (await usdcOf(pool)), amount + BURN_FEE + RELAY_FEE, "the pool paid out the amount and both fees");
  eq((await usdcOf(relayKeys.address)) - relayUsdc0, RELAY_FEE + BURN_FEE, "the relay got its fee on the cash out and on the burn");
  eq(await actions.privateBalance(t, USDC), 15_000_000n - RELAY_FEE - amount - BURN_FEE - RELAY_FEE, "alice keeps the rest privately");
  const burnEv = rc.events.find((e) => config.sameStarknetAddress(e.from_address, MAIN.tokenMessengerMinter) && BigInt(e.keys[0]!) === BigInt(hash.getSelectorFromName("DepositForBurn")));
  ok(burnEv, "Circle's minter took the burn");
  // DepositForBurn: keys burn_token, depositor, min_finality; data amount, mint_recipient, domain, messenger, caller, max_fee, hook.
  ok(config.sameStarknetAddress(burnEv!.keys[2]!, oneTime.address), "its depositor is the one-time account");
  eq(BigInt(burnEv!.data[0]!), amount, "5 USDC burned");
  eq(BigInt(burnEv!.data[4]!), 6n, "to Base");
  const sentEv = rc.events.find((e) => config.sameStarknetAddress(e.from_address, MAIN.messageTransmitter) && BigInt(e.keys[0]!) === BigInt(hash.getSelectorFromName("MessageSent")));
  // MessageSent(message: ByteArray): full words, pending word, pending length.
  const words = sentEv!.data.map((x) => BigInt(x));
  const full = Number(words[0]);
  const bytes: number[] = [];
  for (let i = 0; i < full; i++) bytes.push(...Array.from(cctp.hexToBytes("0x" + words[1 + i]!.toString(16).padStart(62, "0"))));
  const pendLen = Number(words[2 + full]);
  if (pendLen) bytes.push(...Array.from(cctp.hexToBytes("0x" + words[1 + full]!.toString(16).padStart(pendLen * 2, "0"))));
  const msg = cctp.decodeBurnMessage(Uint8Array.from(bytes))!;
  eq([msg.sourceDomain, msg.destinationDomain, msg.minFinalityThreshold, BigInt(msg.destinationCaller)], [25, 6, 1000, 0n], "Circle's message: Starknet to Base, fast, anyone delivers");
  ok(cctp.sameBytes32(msg.recipient, cctp.EVM_TOKEN_MESSENGER_V2) && cctp.sameBytes32(msg.body.burnToken, USDC), "for Base's TokenMessengerV2, burning Starknet's USDC");
  ok(cctp.sameBytes32(msg.body.mintRecipient, RECIPIENT) && msg.body.amount === amount && msg.body.maxFee === costs.maxFee, "to the Base address, 5 USDC, the max fee shown");
  eq(msg.body.hookData, out.FORWARD_HOOK, "with Circle's forwarding hook");
  ok(cctp.sameBytes32(msg.body.messageSender, oneTime.address), "sent by the one-time account");
  const tx = (await node.getTransactionByHash(r.txHash)) as unknown as { calldata: string[] };
  const seen = new Set([...tx.calldata, ...rc.events.flatMap((e) => [...e.keys, ...e.data])].map((x) => BigInt(x)));
  ok(!seen.has(BigInt(keys.address)), "alice's own address appears nowhere in the cash out's transaction");
  const again = await send({ outside: await signOut(otSigner, calls) });
  eq(again.ok ? "sent" : again.code, "not_relayable", "the same cash out again is refused: its one-time account is used");

  /* ------------------------------------------------------------------ 6. Circle's mint on Base */
  console.log("6. on a fork of Base: Base's MessageTransmitterV2 takes the message and mints to the address");
  const mtAbi = parseAbi(["function attesterManager() view returns (address)", "function enableAttester(address)", "function receiveMessage(bytes message, bytes attestation) returns (bool)"]);
  const erc = parseAbi(["function balanceOf(address) view returns (uint256)"]);
  const baseMt = cctp.EVM_MESSAGE_TRANSMITTER_V2 as Address;
  const baseMgr = (await evm.readContract({ address: baseMt, abi: mtAbi, functionName: "attesterManager" })) as Address;
  const evmSend = async (from: Address, to: Address, data: Hex) => {
    const h = (await evmRaw("eth_sendTransaction", [{ from, to, data, gas: toHex(1_500_000n) }])) as Hex;
    const rr = await evm.waitForTransactionReceipt({ hash: h });
    assert.equal(rr.status, "success", `tx to ${to}`);
  };
  for (const a of [baseMgr, RECIPIENT]) {
    await evmRaw("anvil_impersonateAccount", [a]);
    await evmRaw("anvil_setBalance", [a, toHex(10n ** 18n)]);
  }
  for (const x of attesters) await evmSend(baseMgr, baseMt, encodeFunctionData({ abi: mtAbi, functionName: "enableAttester", args: [x.a as Address] }));
  const baseHead = await evm.getBlockNumber();
  const signedOut = cctp.encodeBurnMessage({ ...msg, nonce: keccak256(toHex(`gloam-out-${Date.now()}`)), finalityThresholdExecuted: 1000, body: { ...msg.body, feeExecuted: costs.maxFee, expirationBlock: baseHead + 1_000n } });
  const before = (await evm.readContract({ address: BASE.usdc as Address, abi: erc, functionName: "balanceOf", args: [RECIPIENT] })) as bigint;
  await evmSend(RECIPIENT, baseMt, encodeFunctionData({ abi: mtAbi, functionName: "receiveMessage", args: [signedOut as Hex, await attest(signedOut)] }));
  const after = (await evm.readContract({ address: BASE.usdc as Address, abi: erc, functionName: "balanceOf", args: [RECIPIENT] })) as bigint;
  eq(after - before, costs.arrives, `the address on Base got ${Number(costs.arrives) / 1e6} USDC (5 less Circle's fee and delivery, ${Number(costs.maxFee) / 1e6})`);
} finally {
  stop();
}

console.log(`\ne2e-starknet-cctp-out-fork: ${pass} checks passed`);
process.exit(0);
