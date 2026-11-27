/**
 * End to end on local forks only (nothing is broadcast anywhere): bringing
 * USDC in from Base to a Gloam private account on Starknet with Circle's CCTP
 * V2, through Gloam's own relay code (lib/starknetPrivacy/cctpServer).
 *
 *  A. A real mint, replayed: Circle's real message and attestation for 4,995
 *     USDC from Arbitrum (nonce 0xef3f...1c96), on a fork of Starknet mainnet
 *     one block before it landed (18600087). receive_message from Gloam's
 *     encoder mints exactly that to its recipient, and a second copy is refused
 *     (the nonce is used). This is the encoding against Circle's real contracts
 *     and real attesters.
 *  B. The whole flow with Gloam's code at both ends:
 *     1. on an anvil fork of Base mainnet, a wallet approves Base's
 *        TokenMessengerV2 and calls depositForBurn(100 USDC, 25, the Gloam
 *        account, USDC, 0, maxFee, 1000) with depositForBurnArgs, exactly as
 *        the page does; the MessageSent event carries the message.
 *     2. Circle's part, stood in for: Iris fills in what it fills when it signs
 *        (the nonce, the finality, Circle's fast fee, the expiration) and two
 *        throwaway attesters made here sign it; on the Starknet fork those two
 *        are enabled through the transmitter's attester manager (impersonated:
 *        devnet only). Everything else is Circle's deployed code.
 *     3. Gloam's relay (a devnet account) deploys the Gloam account (UDC, its
 *        class, salt = its key), the account signs [USDC.transfer(relay, fee),
 *        USDC.approve(pool, rest)] as an outside execution, and cctpReceiveSend
 *        checks it all and sends receive_message and that outside execution as
 *        one transaction. The account holds minted - fee, the relay got its
 *        fee, and the canonical pool may take the rest.
 *     4. Refusals on the fork, none of which sends anything (the relay's nonce
 *        and STRK don't move): the same message again (already received); a
 *        message for an account a stranger signs for (Starknet won't run it); a
 *        message to an account that isn't deployed.
 * The private add after that is the existing devnet e2e (e2e-starknet-devnet,
 * which runs the add with its approve already done, the way a bring-in leaves it).
 *
 * Needs starknet-devnet 0.10.1 (STARKNET_DEVNET_BIN) and anvil (~/.foundry/bin).
 * Run from app/:  ../mcp/node_modules/.bin/tsx scripts/e2e-starknet-cctp-fork.mts
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import Module from "node:module";
import { fileURLToPath } from "node:url";
import { createPublicClient, decodeEventLog, encodeFunctionData, http, keccak256, parseAbi, parseAbiItem, toHex, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount, sign } from "viem/accounts";
import { Account, OutsideExecutionVersion, RpcProvider, num, outsideExecution, type Call } from "starknet";

const stub = fileURLToPath(new URL("./server-only-stub.cjs", import.meta.url));
const M = Module as unknown as { _resolveFilename: (req: string, ...rest: unknown[]) => string };
const resolve = M._resolveFilename;
M._resolveFilename = function (req: string, ...rest: unknown[]) {
  return req === "server-only" ? stub : resolve.call(this, req, ...rest);
};
const env = process.env as Record<string, string | undefined>;
for (const k of Object.keys(env)) if (k.startsWith("NEXT_PUBLIC_STARKNET_") || k.startsWith("STARKNET_") || k.startsWith("GLOAM_STARKNET_")) delete env[k];
delete env.UPSTASH_REDIS_REST_URL;
delete env.UPSTASH_REDIS_REST_TOKEN;

const cctp = await import("../src/lib/starknetPrivacy/cctp");
const server = await import("../src/lib/starknetPrivacy/cctpServer");
const config = await import("../src/lib/starknetPrivacy/config");
const account = await import("../src/lib/starknetPrivacy/account");

const SN_PORT = Number(env.CCTP_FORK_STARKNET_PORT ?? 5141);
const EVM_PORT = Number(env.CCTP_FORK_BASE_PORT ?? 8645);
const SN = `http://127.0.0.1:${SN_PORT}`;
const EVM = `http://127.0.0.1:${EVM_PORT}`;
const FORK_BLOCK = 18_600_087;

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
const cfg = config.starknetConfig("mainnet", {});
const USDC = MAIN.usdc;
const BASE = cctp.cctpSourceByDomain(6)!;

const devnet = spawn(
  env.STARKNET_DEVNET_BIN ?? `${homedir()}/Desktop/Projects/workspace/gloam-night/scratch-starknet/tools/devnet/starknet-devnet`,
  ["--seed", "42", "--port", String(SN_PORT), "--accounts", "3", "--initial-balance", "1000000000000000000000", "--fork-network", "https://mainnet.nodes.starknet.org/rpc/v0_10", "--fork-block", String(FORK_BLOCK)],
  { stdio: ["ignore", "ignore", "inherit"] }
);
const anvil = spawn(`${homedir()}/.foundry/bin/anvil`, ["--fork-url", env.CCTP_FORK_BASE_RPC ?? "https://mainnet.base.org", "--port", String(EVM_PORT), "--silent"], { stdio: "ignore" });
const stop = () => {
  if (devnet.exitCode === null) devnet.kill("SIGINT");
  if (anvil.exitCode === null) anvil.kill("SIGTERM");
};
process.on("exit", stop);

const snRpc = (method: string, params: unknown = []) =>
  fetch(SN, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }).then((r) => r.json() as Promise<{ result?: unknown; error?: unknown }>);
const evm = createPublicClient({ transport: http(EVM, { timeout: 120_000 }) });
const evmRaw = (method: string, params: unknown[] = []) => evm.request({ method: method as never, params: params as never }) as Promise<unknown>;

async function waitUp(f: () => Promise<unknown>, what: string) {
  for (let i = 0; ; i++) {
    try {
      await f();
      return;
    } catch (e) {
      if (i > 180) throw new Error(`${what} did not start: ${e instanceof Error ? e.message : e}`);
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

try {
  await waitUp(async () => {
    const r = await snRpc("starknet_chainId");
    if (!r.result) throw new Error("no chain id");
  }, "starknet-devnet");
  await waitUp(() => evm.getChainId(), "anvil");
  const node = new RpcProvider({ nodeUrl: SN, batch: 0 });
  eq(await node.getChainId(), "0x534e5f4d41494e", "Starknet mainnet, forked");
  eq(await evm.getChainId(), 8453, "Base mainnet, forked");
  const pre = (await snRpc("devnet_getPredeployedAccounts")).result as { address: string; private_key: string }[];
  // devnet's own throwaway accounts (seed 42): the relay and a payer of Part A.
  const relayKeys = { address: num.toHex(BigInt(pre[0]!.address)), secret: pre[0]!.private_key };
  const relayAcct = new Account({ provider: node, address: relayKeys.address, signer: relayKeys.secret, cairoVersion: "1" });
  const other = new Account({ provider: node, address: pre[1]!.address, signer: pre[1]!.private_key, cairoVersion: "1" });
  const usdcOf = async (a: string) => BigInt((await node.callContract({ contractAddress: USDC, entrypoint: "balance_of", calldata: [a] }))[0]!);

  /* ------------------------------------------------------------------ A. a real mint, replayed */
  console.log("A. Circle's real message and attestation (Arbitrum to Starknet, 4,995 USDC)");
  const real = JSON.parse(readFileSync(new URL("./fixtures/cctp-real-mint.json", import.meta.url), "utf8")) as { message: string; attestation: string; nonce: string; recipient: string };
  const recipient = real.recipient;
  const before = await usdcOf(recipient);
  eq(await server.cctpChain(SN, relayKeys).nonceUsed(MAIN.messageTransmitter, real.nonce), false, "its nonce is unused at the fork block");
  const tx = await other.execute([cctp.receiveMessageCall(MAIN, real.message, real.attestation)]);
  const rc = (await node.waitForTransaction(tx.transaction_hash)) as unknown as { execution_status?: string };
  eq(rc.execution_status, "SUCCEEDED", "receive_message with Gloam's encoding runs against Circle's contracts");
  eq((await usdcOf(recipient)) - before, 4_995_000_000n, "it minted exactly 4,995 USDC to the recipient");
  eq(await server.cctpChain(SN, relayKeys).nonceUsed(MAIN.messageTransmitter, real.nonce), true, "and used its nonce");
  await assert.rejects(other.estimateInvokeFee([cctp.receiveMessageCall(MAIN, real.message, real.attestation)]), /Nonce already used/);
  pass++;
  console.log("  ok  a second copy is refused: Nonce already used");

  /* ------------------------------------------------------------------ B1. the burn on Base */
  console.log("B1. the burn on Base, the way the page sends it");
  const seed = new Uint8Array(32).fill(7);
  const keys = await account.keysFromSeed(seed, 0);
  const wallet = privateKeyToAccount(generatePrivateKey()).address; // an address only, impersonated on the fork
  const usdcAbi = parseAbi(["function masterMinter() view returns (address)", "function configureMinter(address,uint256) returns (bool)", "function mint(address,uint256) returns (bool)", ...cctp.EVM_CCTP_ABI]);
  const send = async (from: Address, to: Address, data: Hex) => {
    const hash = (await evmRaw("eth_sendTransaction", [{ from, to, data, gas: toHex(1_500_000n) }])) as Hex;
    const r = await evm.waitForTransactionReceipt({ hash });
    assert.equal(r.status, "success", `tx to ${to}`);
    return r;
  };
  const baseUsdc = BASE.usdc as Address;
  const minter = (await evm.readContract({ address: baseUsdc, abi: usdcAbi, functionName: "masterMinter" })) as Address;
  for (const a of [minter, wallet]) {
    await evmRaw("anvil_impersonateAccount", [a]);
    await evmRaw("anvil_setBalance", [a, toHex(10n ** 18n)]);
  }
  await send(minter, baseUsdc, encodeFunctionData({ abi: usdcAbi, functionName: "configureMinter", args: [wallet, 1_000_000_000n] }));
  await send(wallet, baseUsdc, encodeFunctionData({ abi: usdcAbi, functionName: "mint", args: [wallet, 1_000_000_000n] }));
  const amount = 100_000_000n;
  const bps = 1.3;
  await send(wallet, baseUsdc, encodeFunctionData({ abi: usdcAbi, functionName: "approve", args: [cctp.EVM_TOKEN_MESSENGER_V2 as Address, amount] }));
  const args = cctp.depositForBurnArgs({ source: BASE, account: keys.address, amount, bps });
  const burnRc = await send(wallet, cctp.EVM_TOKEN_MESSENGER_V2 as Address, encodeFunctionData({ abi: usdcAbi, functionName: "depositForBurn", args: args as never }));
  const sentEvent = parseAbiItem("event MessageSent(bytes message)");
  const log = burnRc.logs.find((l) => l.address.toLowerCase() === cctp.EVM_MESSAGE_TRANSMITTER_V2.toLowerCase());
  ok(log, "Base's MessageTransmitterV2 emitted MessageSent");
  const emitted = decodeEventLog({ abi: [sentEvent], data: log!.data, topics: log!.topics }).args.message as Hex;
  const m = cctp.decodeBurnMessage(emitted)!;
  eq([m.sourceDomain, m.destinationDomain, m.minFinalityThreshold, BigInt(m.nonce)], [6, 25, 1000, 0n], "from Base to Starknet, fast, nonce left for Circle");
  ok(cctp.sameBytes32(m.recipient, MAIN.tokenMessengerMinter), "for Starknet's minter (Base knows Starknet's messenger)");
  ok(cctp.sameBytes32(m.body.mintRecipient, keys.address), "minted to the Gloam account");
  ok(cctp.sameBytes32(m.body.burnToken, BASE.usdc) && m.body.amount === amount && BigInt(m.destinationCaller) === 0n, "100 USDC of Base's USDC, anyone delivers");
  eq(m.body.maxFee, cctp.burnMaxFee(amount, bps, true), "the max fee the page set");

  /* ------------------------------------------------------------------ B2. Circle's part, stood in for */
  console.log("B2. Circle's signature, stood in for by two throwaway attesters");
  const head = await node.getBlockNumber();
  const fee = cctp.circleFee(amount, bps);
  const signedMsg = cctp.encodeBurnMessage({
    ...m,
    nonce: keccak256(toHex(`gloam-e2e-${Date.now()}`)),
    finalityThresholdExecuted: 1000,
    body: { ...m.body, feeExecuted: fee, expirationBlock: BigInt(head + 7_200) },
  });
  const attesters = [generatePrivateKey(), generatePrivateKey()].map((k) => ({ k, a: privateKeyToAccount(k).address.toLowerCase() })).sort((x, y) => (BigInt(x.a) < BigInt(y.a) ? -1 : 1));
  const manager = (await node.callContract({ contractAddress: MAIN.messageTransmitter, entrypoint: "attester_manager", calldata: [] }))[0]!;
  await snRpc("devnet_impersonateAccount", { account_address: manager });
  const mgr = new Account({ provider: node, address: manager, signer: "0x1", cairoVersion: "1" });
  for (const t of attesters) {
    const r = await mgr.execute([{ contractAddress: MAIN.messageTransmitter, entrypoint: "enable_attester", calldata: [t.a] }], { skipValidate: true } as never);
    await node.waitForTransaction(r.transaction_hash);
  }
  await snRpc("devnet_stopImpersonateAccount", { account_address: manager });
  const digest = keccak256(signedMsg as Hex);
  const sigs = await Promise.all(attesters.map((t) => sign({ hash: digest, privateKey: t.k, to: "hex" })));
  const attestation = ("0x" + sigs.map((s) => s.slice(2)).join("")) as Hex;
  ok(cctp.validAttestation(attestation), "two signatures, sorted by attester");

  /* ------------------------------------------------------------------ B3. Gloam's relay brings it in */
  console.log("B3. Gloam's relay: deploy the account, then receive and pay itself in one transaction");
  const dep = await relayAcct.execute([account.deployAccountCall(keys.publicKey)]);
  await node.waitForTransaction(dep.transaction_hash);
  eq(num.toHex(BigInt(await node.getClassHashAt(keys.address))), num.toHex(BigInt(config.STARKNET_ACCOUNT_CLASS_HASH)), "the Gloam account is deployed with Gloam's class");
  const relayFee = 250_000n;
  const minted = amount - fee;
  const approve = minted - relayFee;
  const userAcct = new Account({ provider: node, address: keys.address, signer: num.toHex(keys.accountKey), cairoVersion: "1" });
  const sign1 = async (by: Account, calls: Call[]) => {
    const now = Math.floor(Date.now() / 1000);
    const o = await by.getOutsideTransaction({ caller: relayKeys.address, execute_after: now - 60, execute_before: now + 600 }, calls, OutsideExecutionVersion.V2);
    return outsideExecution.buildExecuteFromOutsideCall(o)[0]!;
  };
  const calls = cctp.receiveOutsideCalls({ usdc: USDC, relay: relayKeys.address, pool: cfg.pool!, fee: relayFee, approve });
  const out = await sign1(userAcct, calls);
  const relayUsdc0 = await usdcOf(relayKeys.address);
  const chain = server.cctpChain(SN, relayKeys);
  const envFee = { ...env, STARKNET_CCTP_FEE: "0.25" };
  const r = await server.cctpReceiveSend({ message: signedMsg, attestation, outside: out, cfg, cctp: MAIN, relay: relayKeys.address, chain, env: envFee, rate: async () => "ok" });
  ok(r.ok, `the relay sent it${r.ok ? "" : `: ${r.code} ${r.message}`}`);
  if (!r.ok) throw new Error("receive failed");
  const rr = (await node.waitForTransaction(r.txHash)) as unknown as { execution_status?: string; actual_fee?: { amount: string } };
  eq(rr.execution_status, "SUCCEEDED", "one transaction: receive_message, then the account's fee and approve");
  console.log(`      it cost the relay ${(Number(BigInt(rr.actual_fee?.amount ?? 0)) / 1e18).toFixed(3)} STRK on devnet's prices`);
  eq(await usdcOf(keys.address), approve, "the account holds what it minted less the relay's fee");
  eq((await usdcOf(relayKeys.address)) - relayUsdc0, relayFee, "the relay got its fee from it");
  const allowance = await node.callContract({ contractAddress: USDC, entrypoint: "allowance", calldata: [keys.address, cfg.pool!] });
  eq(BigInt(allowance[0]!), approve, "the pool may take the rest for the private add");
  eq(await chain.nonceUsed(MAIN.messageTransmitter, cctp.decodeBurnMessage(signedMsg)!.nonce), true, "the message is used");

  /* ------------------------------------------------------------------ B4. refusals: nothing sent */
  console.log("B4. what the relay refuses on the fork, sending nothing");
  const relayNonce = async () => BigInt(await node.getNonceForAddress(relayKeys.address, "latest"));
  const strkOf = async (a: string) => BigInt((await node.callContract({ contractAddress: config.STARKNET_STRK, entrypoint: "balance_of", calldata: [a] }))[0]!);
  const n0 = await relayNonce();
  const s0 = await strkOf(relayKeys.address);
  const again = await server.cctpReceiveSend({ message: signedMsg, attestation, outside: await sign1(userAcct, calls), cfg, cctp: MAIN, relay: relayKeys.address, chain, env: envFee, rate: async () => "ok" });
  eq(again.ok ? "sent" : again.code, "already_received", "the same message again");

  // A second burn's message, minted to the account, but signed for by a stranger's key.
  const msg2 = cctp.encodeBurnMessage({ ...cctp.decodeBurnMessage(signedMsg)!, nonce: keccak256(toHex(`gloam-e2e-2-${Date.now()}`)) });
  const att2 = ("0x" + (await Promise.all(attesters.map((t) => sign({ hash: keccak256(msg2 as Hex), privateKey: t.k, to: "hex" })))).map((s) => s.slice(2)).join("")) as Hex;
  const stranger = new Account({ provider: node, address: keys.address, signer: num.toHex(123456789n), cairoVersion: "1" });
  const forged = await sign1(stranger, calls);
  const f = await server.cctpReceiveSend({ message: msg2, attestation: att2, outside: forged, cfg, cctp: MAIN, relay: relayKeys.address, chain, env: envFee, rate: async () => "ok" });
  eq(f.ok ? "sent" : f.code, "would_fail", "a stranger's signature for the account: Starknet won't run it");

  // A message to an account no one deployed.
  const ghost = await account.keysFromSeed(new Uint8Array(32).fill(8), 0);
  const msg3 = cctp.encodeBurnMessage({ ...cctp.decodeBurnMessage(msg2)!, nonce: keccak256(toHex(`gloam-e2e-3-${Date.now()}`)), body: { ...cctp.decodeBurnMessage(msg2)!.body, mintRecipient: cctp.starknetToBytes32(ghost.address) } });
  const att3 = ("0x" + (await Promise.all(attesters.map((t) => sign({ hash: keccak256(msg3 as Hex), privateKey: t.k, to: "hex" })))).map((s) => s.slice(2)).join("")) as Hex;
  const ghostOut = { ...forged, contractAddress: ghost.address };
  const g = await server.cctpReceiveSend({ message: msg3, attestation: att3, outside: ghostOut, cfg, cctp: MAIN, relay: relayKeys.address, chain, env: envFee, rate: async () => "ok" });
  eq(g.ok ? "sent" : g.code, "not_relayable", "an account that isn't deployed");
  eq(await relayNonce(), n0, "the relay sent nothing for any of them");
  eq(await strkOf(relayKeys.address), s0, "and paid no STRK");

  // The stranger's message is still good: the account itself can take it, with its own signature.
  const own = await server.cctpReceiveSend({ message: msg2, attestation: att2, outside: await sign1(userAcct, calls), cfg, cctp: MAIN, relay: relayKeys.address, chain, env: envFee, rate: async () => "ok" });
  ok(own.ok, "the same message with the account's own signature goes through");
  if (own.ok) await node.waitForTransaction(own.txHash);
  eq(await usdcOf(keys.address), approve * 2n, "and the account has both");
} finally {
  stop();
}

console.log(`\ne2e-starknet-cctp-fork: ${pass} checks passed`);
process.exit(0);
