/**
 * Self-test: bringing USDC in to Starknet with Circle's CCTP V2
 * (lib/starknetPrivacy/cctp, cctpServer, cctpClient and /api/starknet/cctp),
 * with every node and Circle faked: no request leaves the process.
 *
 *  - the constants: Starknet is domain 25; each source has one domain, one
 *    chain id, Circle's messenger and native USDC; fast where Circle has it.
 *  - bytes: Starknet and EVM addresses as bytes32; a ByteArray in calldata,
 *    checked against a real receive_message on Starknet mainnet (Arbitrum to
 *    Starknet, 4,995 USDC, tx 0x67508a74...f56a, read 2026-11-27) and the
 *    edges (empty, exactly one word).
 *  - the message: that real message decodes to what Circle's API decoded, and
 *    encodes back to the same bytes; anything short is refused.
 *  - fees: Circle's basis points (with decimals), rounding up, the 20% margin,
 *    none on a standard transfer; what a bring-in leaves.
 *  - Circle's answers: signed, pending (404, "0x", PENDING), to another chain.
 *  - the relay's receive (checkCctpReceive): the one shape it sends, and every
 *    way each part is refused.
 *  - the EVM burn: depositForBurn's selector and arguments (fast and standard).
 *  - the server: settings from the environment (off on mainnet with no fee),
 *    the receive against a fake chain (sends [receive_message, the account's
 *    outside execution] once; refuses a non-Gloam account, a used nonce, an
 *    expired message, Circle's contracts changed, a transaction that wouldn't
 *    run, a cost over the cap, the day's counts), and the routes.
 *  - the browser: waiting for Circle, the receive's request, the pending list
 *    kept on this device, the session's outside execution.
 *
 * Run from app/:  ../mcp/node_modules/.bin/tsx scripts/selftest-starknet-cctp.mts
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import Module from "node:module";
import { fileURLToPath } from "node:url";
import { encodeFunctionData, parseAbi, toFunctionSelector } from "viem";
import { OutsideExecutionVersion, ec, hash, num, outsideExecution, typedData, type Call } from "starknet";
import type { CctpBurnMessage, CctpReceiveContext, CctpReceiveDecision } from "../src/lib/starknetPrivacy/cctp";
import type { CctpChain } from "../src/lib/starknetPrivacy/cctpServer";

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
env.NEXT_PUBLIC_STARKNET_ENABLED = "1";
env.NEXT_PUBLIC_STARKNET_NETWORK = "mainnet";
env.STARKNET_RPC_URL = "https://node.selftest/rpc";
env.STARKNET_RELAY_FEE = "0.25";
env.STARKNET_MAX_APPROVE = "1000";
const RELAY = "0x25a6c9f0c15ef30c139065096b4b8e563e6b86191fd600a4f0616df8f22fb77";
env.GLOAM_STARKNET_RELAYER_ADDRESS = RELAY;
// The relay's key: a throwaway made here, in this process only.
env.GLOAM_STARKNET_RELAYER_SECRET = "0x0" + randomBytes(30).toString("hex");

const cctp = await import("../src/lib/starknetPrivacy/cctp");
const server = await import("../src/lib/starknetPrivacy/cctpServer");
const client = await import("../src/lib/starknetPrivacy/cctpClient");
const config = await import("../src/lib/starknetPrivacy/config");
const account = await import("../src/lib/starknetPrivacy/account");

let pass = 0;
const ok = (c: unknown, msg: string) => {
  assert.ok(c, msg);
  pass++;
};
const eq = <T,>(a: T, b: T, msg: string) => {
  assert.deepEqual(a, b, msg);
  pass++;
};
const rejects = async (p: Promise<unknown>, re: RegExp, msg: string) => {
  await assert.rejects(p, re, msg);
  pass++;
};

const MAIN = cctp.STARKNET_CCTP.mainnet;
const cfg = config.starknetConfig("mainnet", {});
const POOL = cfg.pool!;
const USDC = MAIN.usdc;

/* ------------------------------------------------------------------ a real mint into Starknet (public data) */
// Circle's GET /v2/messages/3?nonce=0xef3f...1c96 and the receive_message that delivered it on mainnet.
const REAL = {
  message:
    "0x000000010000000300000019ef3f8de02b9f871356bfb2cb1901ea62382d485905b7ab0619fefc636fca1c9600000000000000000000000028b5a0e9c621a5badaa536219b3a228c8168cf5d07d421b9ca8aa32df259965cda8acb93f7599f69209a41872ae84638b2a20f2a0000000000000000000000000000000000000000000000000000000000000000000007d0000007d000000001000000000000000000000000af88d065e77c8cc2239327c5edb3a432268e58310355a41576c85e36cfdb0b4c2fad305b55c0d4c4523b21b9ac3f5a13b97d18a70000000000000000000000000000000000000000000000000000000129b9a6c0000000000000000000000000e0406f460eaec92fbaf76e415dcc00f3b019943e000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
  attestation:
    "0x2c9353573f4d5be5bc8fced5ebf2b1a0ff1135252a804ba811a40bd1c50ea28054476f85ddf8f754b950cd70e123e364d4a11c1cdbdce0e0ac8b7a5a68bb574c1b215f19d98e09e1793641fa5de31a8ba6c64565c53d5a1579d1154055ebcd87c00bb00918520561f966e91615d79694bd49475e0cd6173bee9eabfbe245266d6d1b",
  nonce: "0xef3f8de02b9f871356bfb2cb1901ea62382d485905b7ab0619fefc636fca1c96",
  calldata: [
    "0xc", "0x10000000300000019ef3f8de02b9f871356bfb2cb1901ea62382d48", "0x5905b7ab0619fefc636fca1c9600000000000000000000000028b5a0e9c621",
    "0xa5badaa536219b3a228c8168cf5d07d421b9ca8aa32df259965cda8acb93f7", "0x599f69209a41872ae84638b2a20f2a00000000000000000000000000000000",
    "0x7d0000007d000000001000000", "0xaf88d065e77c8cc2239327c5edb3a432268e58310355", "0xa41576c85e36cfdb0b4c2fad305b55c0d4c4523b21b9ac3f5a13b97d18a700",
    "0x129b9a6c0", "0xe0406f460eaec92fbaf76e415dcc00f3b01994", "0x3e000000000000000000000000000000000000000000000000000000000000",
    "0x0", "0x0", "0x0", "0x4", "0x4", "0x2c9353573f4d5be5bc8fced5ebf2b1a0ff1135252a804ba811a40bd1c50ea2",
    "0x8054476f85ddf8f754b950cd70e123e364d4a11c1cdbdce0e0ac8b7a5a68bb", "0x574c1b215f19d98e09e1793641fa5de31a8ba6c64565c53d5a1579d1154055",
    "0xebcd87c00bb00918520561f966e91615d79694bd49475e0cd6173bee9eabfb", "0xe245266d6d1b", "0x6",
  ],
};

/* ------------------------------------------------------------------ constants */
{
  eq(cctp.CCTP_STARKNET_DOMAIN, 25, "Starknet is CCTP domain 25");
  eq(new Set(cctp.CCTP_SOURCES.map((s) => s.domain)).size, cctp.CCTP_SOURCES.length, "one source per domain");
  eq(new Set(cctp.CCTP_SOURCES.map((s) => s.chainId)).size, cctp.CCTP_SOURCES.length, "one source per chain");
  ok(!cctp.CCTP_SOURCES.some((s) => s.domain === 25 || s.domain === 17), "neither Starknet nor BNB Chain (USYC only) is a source");
  ok(!cctp.CCTP_SOURCES.some((s) => [4663, 4217, 99901, 56].includes(s.chainId)), "Robinhood Chain, Tempo, Elysium and BNB Chain have no CCTP USDC");
  eq(cctp.cctpSourceByDomain(6)?.name, "Base", "domain 6 is Base");
  eq(cctp.cctpSourceByDomain(0)?.name, "Ethereum", "domain 0 is Ethereum");
  eq(cctp.cctpSourceByDomain(5)?.kind, "svm", "domain 5 is Solana");
  eq(cctp.cctpSourceByChain(42161)?.domain, 3, "Arbitrum is domain 3");
  for (const s of cctp.CCTP_SOURCES.filter((x) => x.kind === "evm")) {
    eq(s.messenger, cctp.evmToBytes32(cctp.EVM_TOKEN_MESSENGER_V2), `${s.name}'s messenger is TokenMessengerV2`);
    ok(/^0x[0-9a-f]{40}$/.test(s.usdc), `${s.name}'s USDC is an EVM address`);
  }
  eq(cctp.burnFinality(cctp.cctpSourceByDomain(6)!), 1000, "Base burns fast");
  eq(cctp.burnFinality(cctp.cctpSourceByDomain(7)!), 2000, "Polygon burns standard (already quick, no fee)");
  eq(cctp.starknetCctp("devnet"), null, "no CCTP on a local devnet");
  ok(config.sameStarknetAddress(cctp.starknetCctp("mainnet")!.usdc, cfg.tokens[0]!.address), "the USDC CCTP mints is the USDC the pool lists");
}

/* ------------------------------------------------------------------ bytes */
{
  eq(cctp.starknetToBytes32("0x355a41576c85e36cfdb0b4c2fad305b55c0d4c4523b21b9ac3f5a13b97d18a7"), "0x0355a41576c85e36cfdb0b4c2fad305b55c0d4c4523b21b9ac3f5a13b97d18a7", "a Starknet address padded to 32 bytes");
  assert.throws(() => cctp.starknetToBytes32("0x0"));
  assert.throws(() => cctp.starknetToBytes32(1n << 251n));
  pass += 2;
  eq(cctp.evmToBytes32("0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d"), "0x00000000000000000000000028b5a0e9c621a5badaa536219b3a228c8168cf5d", "an EVM address left padded");
  assert.throws(() => cctp.evmToBytes32("0x1234"));
  pass++;
  eq(cctp.byteArrayCalldata(new Uint8Array(0)), ["0x0", "0x0", "0x0"], "an empty ByteArray");
  eq(cctp.byteArrayCalldata(new Uint8Array(31).fill(1)), ["0x1", "0x" + "01".repeat(31).replace(/^0/, ""), "0x0", "0x0"], "exactly one word, nothing pending");
  eq(cctp.byteArrayCalldata(Uint8Array.from([0, 0, 7])), ["0x0", "0x7", "0x3"], "leading zero bytes are counted in the length");
  const call = cctp.receiveMessageCall(MAIN, REAL.message, REAL.attestation);
  eq(call.contractAddress, MAIN.messageTransmitter, "receive_message goes to the transmitter");
  eq(call.entrypoint, "receive_message", "entrypoint receive_message");
  eq((call.calldata as string[]).map((x) => BigInt(x)), REAL.calldata.map((x) => BigInt(x)), "the same calldata as the real mainnet receive_message");
  eq(cctp.nonceCalldata(REAL.nonce), ["0x382d485905b7ab0619fefc636fca1c96", "0xef3f8de02b9f871356bfb2cb1901ea62"], "the nonce as a u256 (low, high)");
}

/* ------------------------------------------------------------------ the message */
const realMsg = cctp.decodeBurnMessage(REAL.message)!;
{
  ok(realMsg, "the real message decodes");
  eq(
    [realMsg.version, realMsg.sourceDomain, realMsg.destinationDomain, realMsg.nonce, realMsg.minFinalityThreshold, realMsg.finalityThresholdExecuted],
    [1, 3, 25, REAL.nonce, 2000, 2000],
    "header as Circle decoded it"
  );
  ok(cctp.sameBytes32(realMsg.sender, cctp.EVM_TOKEN_MESSENGER_V2), "sender: Arbitrum's TokenMessengerV2");
  ok(cctp.sameBytes32(realMsg.recipient, MAIN.tokenMessengerMinter), "recipient: Starknet's TokenMessengerMinterV2");
  eq(BigInt(realMsg.destinationCaller), 0n, "anyone may deliver it");
  ok(cctp.sameBytes32(realMsg.body.burnToken, "0xaf88d065e77c8cc2239327c5edb3a432268e5831"), "burned Arbitrum USDC");
  ok(cctp.sameBytes32(realMsg.body.mintRecipient, "0x355a41576c85e36cfdb0b4c2fad305b55c0d4c4523b21b9ac3f5a13b97d18a7"), "mint recipient");
  eq([realMsg.body.amount, realMsg.body.maxFee, realMsg.body.feeExecuted, realMsg.body.expirationBlock, realMsg.body.hookData], [4_995_000_000n, 0n, 0n, 0n, "0x"], "body as Circle decoded it");
  eq(cctp.mintedAmount(realMsg), 4_995_000_000n, "a standard transfer mints all of it");
  eq(cctp.encodeBurnMessage(realMsg), REAL.message, "encodes back to the same bytes");
  eq(cctp.decodeBurnMessage(REAL.message.slice(0, -2)), null, "one byte short is not a message");
  eq(cctp.decodeBurnMessage("0x1234"), null, "garbage is not a message");
  eq(cctp.decodeBurnMessage("not hex"), null, "not hex is not a message");
}

/* ------------------------------------------------------------------ fees */
{
  eq(cctp.feeCentiBps(1.3), 130n, "1.3 bps");
  eq(cctp.circleFee(100_000_000n, 1.3), 13_000n, "1.3 bps of 100 USDC is 0.013");
  eq(cctp.circleFee(1n, 1), 1n, "rounded up");
  eq(cctp.circleFee(100_000_000n, 0), 0n, "no fee");
  eq(cctp.burnMaxFee(100_000_000n, 1.3, true), 15_600n, "20% margin");
  eq(cctp.burnMaxFee(100_000_000n, 1.3, false), 0n, "a standard transfer has no max fee");
  eq(cctp.burnMaxFee(100_000_000n, 0, true), 0n, "no fee, no max fee");
  ok(cctp.burnMaxFee(2n, 99, true) < 2n, "the max fee is always below the amount");
  assert.throws(() => cctp.feeCentiBps(-1));
  assert.throws(() => cctp.feeCentiBps(Number.NaN));
  pass += 2;
  eq(cctp.feeBpsFrom([{ finalityThreshold: 1000, minimumFee: 1.3 }, { finalityThreshold: 2000, minimumFee: 0 }], 1000), 1.3, "Circle's fast fee row");
  eq(cctp.feeBpsFrom([{ finalityThreshold: 2000, minimumFee: 0 }], 1000), null, "no fast row");
  eq(cctp.feeBpsFrom({ error: "x" }, 1000), null, "an error is no fee");
  const c = cctp.bringInCosts(100_000_000n, { fast: true }, 1.3, 250_000n, 250_000n)!;
  eq([c.circle, c.receive, c.add, c.lands], [13_000n, 250_000n, 250_000n, 99_487_000n], "100 USDC from Base lands 99.487 privately");
  eq(cctp.bringInCosts(400_000n, { fast: true }, 1.3, 250_000n, 250_000n), null, "less than the fees leaves nothing");
}

/* ------------------------------------------------------------------ Circle's answers */
const BASE = cctp.cctpSourceByDomain(6)!;
const ACCOUNT = "0x" + "4".padStart(63, "1");
const TMM = MAIN.tokenMessengerMinter;
function burn(over: Partial<Omit<CctpBurnMessage, "body">> & { body?: Partial<CctpBurnMessage["body"]> } = {}): string {
  const m: CctpBurnMessage = {
    version: 1,
    sourceDomain: 6,
    destinationDomain: 25,
    nonce: "0x" + "ab".repeat(32),
    sender: BASE.messenger,
    recipient: cctp.starknetToBytes32(TMM),
    destinationCaller: cctp.ZERO_BYTES32,
    minFinalityThreshold: 1000,
    finalityThresholdExecuted: 1000,
    ...over,
    body: {
      version: 1,
      burnToken: cctp.evmToBytes32(BASE.usdc),
      mintRecipient: cctp.starknetToBytes32(ACCOUNT),
      amount: 100_000_000n,
      messageSender: cctp.evmToBytes32("0x" + "77".repeat(20)),
      maxFee: 15_600n,
      feeExecuted: 13_000n,
      expirationBlock: 20_000_000n,
      hookData: "0x",
      ...over.body,
    },
  };
  return cctp.encodeBurnMessage(m);
}
const ATT = "0x" + "11".repeat(130);
{
  const signed = cctp.irisMessageFrom({ messages: [{ message: REAL.message, attestation: REAL.attestation, status: "complete" }] });
  eq(signed?.status, "complete", "a signed message");
  if (signed?.status === "complete") eq(signed.nonce, REAL.nonce, "its nonce");
  eq(cctp.irisMessageFrom({ messages: [{ message: "0x", attestation: "PENDING", status: "pending_confirmations", decodedMessage: null }] }), { status: "pending" }, "not signed yet");
  eq(cctp.irisMessageFrom({ messages: [{ message: "0x", attestation: "PENDING", status: "pending_confirmations", decodedMessage: { destinationDomain: "25" } }] }), { status: "pending" }, "on its way to Starknet");
  eq(cctp.irisMessageFrom({ messages: [{ message: "0x", attestation: "PENDING", status: "pending_confirmations", decodedMessage: { destinationDomain: "6" } }] }), null, "on its way elsewhere");
  eq(cctp.irisMessageFrom({ messages: [{ message: burn({ destinationDomain: 6 }), attestation: ATT, status: "complete" }] }), null, "signed for another chain");
  eq(cctp.irisMessageFrom({ messages: [{ message: burn({ nonce: cctp.ZERO_BYTES32 }), attestation: ATT, status: "complete" }] }), { status: "pending" }, "a zero nonce isn't signed yet");
  eq(cctp.irisMessageFrom({ messages: [{ message: burn(), attestation: "PENDING", status: "complete" }] }), { status: "pending" }, "no attestation is not signed");
  eq(cctp.irisMessageFrom({ nope: 1 }), null, "not Circle's shape");
  ok(cctp.validAttestation(REAL.attestation), "two signatures");
  ok(!cctp.validAttestation("0x" + "11".repeat(64)), "64 bytes is no signature");
  ok(!cctp.validAttestation("0x" + "11".repeat(65 * 5)), "five signatures is too many");
  ok(!cctp.validAttestation("PENDING"), "PENDING is none");
}

/* ------------------------------------------------------------------ the relay's receive */
const NOW = 1_800_000_000;
function outside(over: { caller?: string; calls?: string[][]; after?: number; before?: number; sig?: string[]; account?: string; entrypoint?: string; extra?: string[] } = {}): Call {
  const calls = over.calls ?? [
    [USDC, hash.getSelectorFromName("transfer"), "0x3", RELAY, num.toHex(250_000n), "0x0"],
    [USDC, hash.getSelectorFromName("approve"), "0x3", POOL, num.toHex(99_737_000n), "0x0"],
  ];
  const sig = over.sig ?? ["0x1", "0x2"];
  return {
    contractAddress: over.account ?? ACCOUNT,
    entrypoint: over.entrypoint ?? "execute_from_outside_v2",
    calldata: [over.caller ?? RELAY, "0x99", num.toHex(over.after ?? NOW - 60), num.toHex(over.before ?? NOW + 600), num.toHex(calls.length), ...calls.flat(), num.toHex(sig.length), ...sig, ...(over.extra ?? [])],
  };
}
const ctx: CctpReceiveContext = { cctp: MAIN, relay: RELAY, pool: POOL, now: NOW, minFee: 250_000n, maxApprove: 1_000_000_000n };
const check = (message = burn(), o = outside(), attestation = ATT, c = ctx) => cctp.checkCctpReceive({ message, attestation, outside: o }, c);
const refused = (d: CctpReceiveDecision, reason: string, msg: string) => eq(d.ok ? "ok" : d.reason, reason, msg);
{
  const d = check();
  ok(d.ok, "the receive shape passes");
  if (d.ok) {
    eq([d.account, d.sourceDomain, d.minted, d.fee, d.approve, d.expirationBlock], [num.toHex(BigInt(ACCOUNT)), 6, 99_987_000n, 250_000n, 99_737_000n, 20_000_000n], "what it delivers and pays");
  }
  ok(check(burn({ destinationCaller: cctp.starknetToBytes32(RELAY) })).ok, "a message only the relay may deliver passes too");
  // the message
  refused(check("0x12"), "bad_message", "not a message");
  refused(check(burn({ version: 0 })), "message_version", "header version");
  refused(check(burn({ body: { version: 2 } })), "message_version", "body version");
  refused(check(burn({ destinationDomain: 6 })), "not_to_starknet", "to another chain");
  refused(check(burn({ recipient: cctp.starknetToBytes32(MAIN.messageTransmitter) })), "not_a_burn", "not for the minter");
  refused(check(burn({ sourceDomain: 16 })), "source_not_listed", "Sei isn't listed");
  refused(check(burn({ sender: cctp.evmToBytes32("0x" + "12".repeat(20)) })), "not_circles_messenger", "another sender");
  refused(check(burn({ body: { burnToken: cctp.evmToBytes32("0x" + "12".repeat(20)) } })), "not_usdc", "another token");
  refused(check(burn({ sourceDomain: 0, sender: BASE.messenger })), "not_usdc", "Base's USDC said to come from Ethereum");
  refused(check(burn({ nonce: cctp.ZERO_BYTES32 })), "not_signed", "a zero nonce");
  refused(check(burn({ destinationCaller: cctp.starknetToBytes32("0x1234") })), "other_caller", "only someone else may deliver it");
  refused(check(burn({ body: { hookData: "0xdead" } })), "hook_data", "hook data");
  refused(check(burn(), outside(), "0x" + "11".repeat(64)), "bad_attestation", "no attestation");
  refused(check(burn({ body: { feeExecuted: 100_000_000n } })), "nothing_minted", "Circle's fee took it all");
  // the account's outside execution
  refused(check(burn(), outside({ entrypoint: "execute_from_outside" })), "outside_shape", "v1 outside execution");
  refused(check(burn(), outside({ account: "0x" + "5".padStart(63, "1") })), "not_the_recipient", "another account signed it");
  refused(check(burn(), outside({ caller: "0x1234" })), "outside_caller", "another caller");
  refused(check(burn(), outside({ calls: [[USDC, hash.getSelectorFromName("transfer"), "0x3", RELAY, num.toHex(250_000n), "0x0"]] })), "outside_shape", "one call");
  refused(
    check(burn(), outside({ calls: [[USDC, hash.getSelectorFromName("transfer"), "0x3", RELAY, num.toHex(250_000n), "0x0"], [USDC, hash.getSelectorFromName("approve"), "0x3", POOL, "0x1", "0x0"], [USDC, hash.getSelectorFromName("approve"), "0x3", POOL, "0x1", "0x0"]] })),
    "outside_two_calls",
    "three calls"
  );
  refused(check(burn(), outside({ before: NOW })), "outside_expired", "expired");
  refused(check(burn(), outside({ before: NOW + 3_601 })), "outside_window", "a window over an hour");
  refused(check(burn(), outside({ after: NOW + 600 })), "outside_window", "after not before before");
  const T = hash.getSelectorFromName("transfer");
  const A = hash.getSelectorFromName("approve");
  const two = (a: string[], b: string[]) => outside({ calls: [a, b] });
  const fee = [USDC, T, "0x3", RELAY, num.toHex(250_000n), "0x0"];
  const app = [USDC, A, "0x3", POOL, num.toHex(99_737_000n), "0x0"];
  refused(check(burn(), two(app, fee)), "fee_transfer_only", "approve first");
  refused(check(burn(), two([POOL, T, "0x3", RELAY, num.toHex(250_000n), "0x0"], app)), "fee_transfer_only", "the fee in another token");
  refused(check(burn(), two([USDC, T, "0x3", "0x1234", num.toHex(250_000n), "0x0"], app)), "fee_to_relay", "the fee to someone else");
  refused(check(burn(), two(fee, [USDC, A, "0x3", RELAY, num.toHex(1n), "0x0"])), "approve_spender", "approve to someone but the pool");
  refused(check(burn(), two(fee, [USDC, T, "0x3", POOL, num.toHex(1n), "0x0"])), "approve_only", "a transfer to the pool");
  refused(check(burn(), two(fee, [USDC, A, "0x4", POOL, num.toHex(1n), "0x0", "0x0"])), "approve_only", "approve with extra calldata");
  refused(check(burn(), two([USDC, T, "0x3", RELAY, num.toHex(250_000n), "0x1"], app)), "amount_shape", "a fee's high word");
  refused(check(burn(), two(fee, [USDC, A, "0x3", POOL, num.toHex(1n), "0x1"])), "amount_shape", "an approve's high word");
  refused(check(burn(), two([USDC, T, "0x3", RELAY, num.toHex(249_999n), "0x0"], app)), "fee_too_low", "a fee under the relay's");
  refused(check(burn(), two(fee, [USDC, A, "0x3", POOL, "0x0", "0x0"])), "approve_amount", "approve nothing");
  refused(check(burn(), two(fee, [USDC, A, "0x3", POOL, num.toHex(1_000_000_001n), "0x0"])), "approve_amount", "approve over the cap");
  refused(check(burn(), two(fee, [USDC, A, "0x3", POOL, num.toHex(99_737_001n), "0x0"])), "more_than_minted", "fee and approve over what lands");
  refused(check(burn(), outside({ sig: [] })), "outside_signature", "no signature");
  refused(check(burn(), outside({ sig: ["0x1", "0x2", "0x3", "0x4", "0x5"] })), "outside_signature", "five signature felts");
  refused(check(burn(), outside({ extra: ["0x0"] })), "outside_shape", "a trailing felt");
  refused(check(burn(), { ...outside(), calldata: ["0x" + "f".repeat(64)] }), "outside_shape", "not a felt");
  ok(check(burn(), outside(), ATT, { ...ctx, minFee: 0n }).ok, "no fee asked still takes a fee that is paid");
  // the calls the browser signs are the ones the relay takes
  const signed = cctp.receiveOutsideCalls({ usdc: USDC, relay: RELAY, pool: POOL, fee: 250_000n, approve: 99_737_000n });
  const o = outside({ calls: signed.map((c) => [c.contractAddress, hash.getSelectorFromName(c.entrypoint), num.toHex((c.calldata as string[]).length), ...(c.calldata as string[])]) });
  ok(check(burn(), o).ok, "receiveOutsideCalls makes the shape the relay takes");
}

/* ------------------------------------------------------------------ the EVM burn */
{
  const abi = parseAbi(cctp.EVM_CCTP_ABI);
  eq(toFunctionSelector("function depositForBurn(uint256,uint32,bytes32,address,bytes32,uint256,uint32)"), "0x8e0250ee", "CCTP V2's depositForBurn");
  const args = cctp.depositForBurnArgs({ source: BASE, account: ACCOUNT, amount: 100_000_000n, bps: 1.3 });
  eq([...args] as unknown[], [100_000_000n, 25, cctp.starknetToBytes32(ACCOUNT), BASE.usdc, cctp.ZERO_BYTES32, 15_600n, 1000], "Base: fast, the margin, anyone delivers");
  const data = encodeFunctionData({ abi, functionName: "depositForBurn", args: args as unknown as readonly [bigint, number, `0x${string}`, `0x${string}`, `0x${string}`, bigint, number] });
  ok(data.startsWith("0x8e0250ee"), "encodes as depositForBurn");
  const poly = cctp.depositForBurnArgs({ source: cctp.cctpSourceByDomain(7)!, account: ACCOUNT, amount: 5_000_000n, bps: 0 });
  eq([poly[5], poly[6]], [0n, 2000], "Polygon: standard, no fee");
  assert.throws(() => cctp.depositForBurnArgs({ source: cctp.cctpSourceByDomain(5)!, account: ACCOUNT, amount: 1n, bps: 1 }));
  assert.throws(() => cctp.depositForBurnArgs({ source: BASE, account: ACCOUNT, amount: 0n, bps: 1 }));
  pass += 2;
}

/* ------------------------------------------------------------------ the server */
{
  const s = server.cctpSettings("mainnet", 6, {});
  eq([s.fee, s.feeUnset, s.perDay, s.perIpPerDay, s.maxStrk], [0n, true, 200, 10, 10n * 10n ** 18n], "mainnet with no fee: off");
  eq(server.cctpSettings("mainnet", 6, { STARKNET_RELAY_FEE: "0.25" }).fee, 250_000n, "the relay's fee by default");
  eq(server.cctpSettings("mainnet", 6, { STARKNET_RELAY_FEE: "0.25", STARKNET_CCTP_FEE: "0.1" }).fee, 100_000n, "its own fee when set");
  eq(server.cctpSettings("mainnet", 6, { STARKNET_CCTP_FEE: "0" }).feeUnset, true, "a zero fee on mainnet is off");
  eq(server.cctpSettings("sepolia", 6, {}).feeUnset, false, "elsewhere no fee is fine");
  eq(server.cctpSettings("mainnet", 6, { STARKNET_CCTP_PER_DAY: "3", STARKNET_CCTP_PER_IP_PER_DAY: "1", STARKNET_CCTP_MAX_STRK: "4" }), { fee: 0n, feeUnset: true, perDay: 3, perIpPerDay: 1, maxStrk: 4n * 10n ** 18n }, "limits from the environment");
}

type Sent = Call[];
function fakeChain(over: Partial<CctpChain> & { sent?: Sent[] } = {}): CctpChain & { sent: Sent[] } {
  const sent: Sent[] = over.sent ?? [];
  return {
    classHashAt: async (a) =>
      config.sameStarknetAddress(a, MAIN.messageTransmitter)
        ? MAIN.classHashes!.messageTransmitter
        : config.sameStarknetAddress(a, MAIN.tokenMessengerMinter)
          ? MAIN.classHashes!.tokenMessengerMinter
          : config.STARKNET_ACCOUNT_CLASS_HASH,
    nonceUsed: async () => false,
    poolFeeAmount: async () => 45n * 10n ** 17n,
    blockNumber: async () => 18_600_000,
    estimate: async () => 3n * 10n ** 18n,
    send: async (calls) => {
      sent.push(calls);
      return "0xbeef";
    },
    ...over,
    sent,
  };
}
const send = (chain: CctpChain, over: Partial<Parameters<typeof server.cctpReceiveSend>[0]> = {}) =>
  server.cctpReceiveSend({ message: burn(), attestation: ATT, outside: outside(), cfg, cctp: MAIN, relay: RELAY, chain, now: NOW * 1000, rate: async () => "ok", lockWaitMs: 200, ...over });
{
  const chain = fakeChain();
  const r = await send(chain);
  ok(r.ok, "the receive is sent");
  eq(chain.sent.length, 1, "once");
  eq(chain.sent[0]!.map((c) => c.entrypoint), ["receive_message", "execute_from_outside_v2"], "receive first, then the account's fee and approve, in one transaction");
  eq((chain.sent[0]![0]!.calldata as string[]).map(BigInt), (cctp.receiveMessageCall(MAIN, burn(), ATT).calldata as string[]).map(BigInt), "Circle's message and attestation as sent");
  const again = await send(chain);
  eq(again.ok ? "sent" : again.code, "already_sent", "the same nonce is not sent twice");
  eq(chain.sent.length, 1, "still once");
  const n2 = burn({ nonce: "0x" + "cd".repeat(32) });
  const code = async (c: CctpChain, over: Partial<Parameters<typeof server.cctpReceiveSend>[0]> = {}) => {
    const x = await send(c, { message: n2, ...over });
    return x.ok ? "sent" : x.code;
  };
  eq(await code(fakeChain({ classHashAt: async (a) => (config.sameStarknetAddress(a, ACCOUNT) ? "0x1234" : (await fakeChain().classHashAt(a))) })), "not_relayable", "only into a Gloam account");
  eq(await code(fakeChain({ classHashAt: async (a) => (config.sameStarknetAddress(a, ACCOUNT) ? null : (await fakeChain().classHashAt(a))) })), "not_relayable", "only into a deployed account");
  eq(await code(fakeChain({ classHashAt: async (a) => (config.sameStarknetAddress(a, MAIN.messageTransmitter) ? "0x1234" : (await fakeChain().classHashAt(a))) })), "cctp_changed", "Circle's transmitter changed: paused");
  eq(await code(fakeChain({ classHashAt: async (a) => (config.sameStarknetAddress(a, MAIN.tokenMessengerMinter) ? "0x1234" : (await fakeChain().classHashAt(a))) })), "cctp_changed", "Circle's minter changed: paused");
  eq(await code(fakeChain({ nonceUsed: async () => true })), "already_received", "someone already delivered it");
  eq(await code(fakeChain({ blockNumber: async () => 19_999_990 })), "cctp_expired", "about to expire");
  eq(await code(fakeChain({ nonceUsed: async () => Promise.reject(new Error("down")) })), "upstream_unavailable", "the node is down");
  const noSend = fakeChain();
  eq(await code(fakeChain({ ...noSend, estimate: async () => Promise.reject(new Error("Nonce already used")) })), "would_fail", "a transaction that wouldn't run is not sent");
  eq(noSend.sent.length, 0, "nothing sent");
  eq(await code(fakeChain({ estimate: async () => 11n * 10n ** 18n })), "cost_high", "over the STRK cap pauses");
  eq(await code(fakeChain(), { rate: async () => "limited" }), "rate_limited", "per IP");
  eq(await code(fakeChain(), { rate: async () => "day_used" }), "relay_day_used", "the day's count");
  eq(await code(fakeChain(), { rate: async () => "unavailable" }), "relay_unavailable", "no shared count on mainnet");
  eq(await code(fakeChain(), { env: { ...env, STARKNET_RELAY_FEE: "", STARKNET_CCTP_FEE: "" } }), "fee_unset", "mainnet with no fee");
  eq(await code(fakeChain(), { env: { ...env, STARKNET_RELAY_FEE: "", STARKNET_CCTP_FEE: "0.25" } }), "fee_unset", "a receive fee but no add (the relay's moves are off): nothing brought in to wait");
  eq(await code(fakeChain(), { outside: outside({ caller: "0x1234" }) }), "not_relayable", "the policy first");
  eq(await code(fakeChain({ send: async () => Promise.reject(new Error("boom")) })), "send_failed", "a failed send says so");
  eq(await code(fakeChain()), "sent", "and once it failed, the same message can go again");
  // a mint with no expiration (a standard transfer) never expires
  eq(await code(fakeChain({ blockNumber: async () => 99_000_000 }), { message: burn({ nonce: "0x" + "ce".repeat(32), body: { expirationBlock: 0n } }) }), "sent", "no expiration");
}

/* ------------------------------------------------------------------ the routes */
const route = await import("../src/app/api/starknet/cctp/route");
const messageRoute = await import("../src/app/api/starknet/cctp/message/route");
const realFetch = globalThis.fetch;
const iris: { status: number; body: unknown }[] = [];
const irisSeen: string[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith("https://iris-api.circle.com")) {
    irisSeen.push(`${init?.method ?? "GET"} ${url.slice("https://iris-api.circle.com".length)}`);
    if (url.includes("/v2/burn/USDC/fees/")) return Response.json([{ finalityThreshold: 1000, minimumFee: 1.3 }, { finalityThreshold: 2000, minimumFee: 0 }]);
    const a = iris.shift() ?? { status: 500, body: {} };
    return Response.json(a.body, { status: a.status });
  }
  throw new Error(`unexpected fetch ${url}`);
}) as typeof fetch;
const req = (path: string, init: RequestInit & { ip?: string } = {}) =>
  new Request(`https://www.gloam.trade${path}`, { ...init, headers: { "x-forwarded-for": init.ip ?? "198.51.100.7", "sec-fetch-site": "same-origin", "content-type": "application/json", ...(init.headers ?? {}) } });
try {
  // GET info
  const info = (await (await route.GET()).json()) as { on: boolean; fee: string; relayer: string; sources: { domain: number; fastBps: number | null }[] };
  eq([info.on, info.fee, info.relayer], [true, "250000", num.toHex(BigInt(RELAY))], "on, the relay's fee, its address");
  eq(info.sources.find((x) => x.domain === 6)?.fastBps, 1.3, "Base's fast fee from Circle");
  eq(info.sources.find((x) => x.domain === 7)?.fastBps, 0, "Polygon burns standard: no fee");
  env.STARKNET_RELAY_FEE = "";
  env.STARKNET_CCTP_FEE = "0.25";
  eq(((await (await route.GET()).json()) as { on: boolean }).on, false, "off while the relay sends no add");
  env.STARKNET_RELAY_FEE = "0.25";
  delete env.STARKNET_CCTP_FEE;

  // GET message
  const tx = "0x" + "aa".repeat(32);
  const look = async (q: string) => {
    const r = await messageRoute.GET(req(`/api/starknet/cctp/message?${q}`));
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  };
  eq((await look(`domain=6&tx=0x1234`)).status, 400, "not a transaction");
  eq((await look(`domain=16&tx=${tx}`)).status, 400, "not a listed source");
  eq((await look(`domain=6&tx=5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW`)).status, 400, "a Solana signature for Base");
  iris.push({ status: 404, body: { error: "Message not found" } });
  eq((await look(`domain=6&tx=${tx}`)).body.status, "pending", "Circle hasn't seen it yet");
  eq(irisSeen.at(-1), `GET /v2/messages/6?transactionHash=${tx}`, "asked Circle by transaction");
  iris.push({ status: 200, body: { messages: [{ message: "0x", attestation: "PENDING", status: "pending_confirmations" }] } });
  eq((await look(`domain=6&tx=${tx}`)).body.status, "pending", "not signed yet");
  iris.push({ status: 200, body: { messages: [{ message: burn(), attestation: ATT, status: "complete" }] } });
  const done = await look(`domain=6&tx=${tx}`);
  eq([done.body.status, done.body.minted, done.body.nonce], ["complete", "99987000", "0x" + "ab".repeat(32)], "signed: the message and what it mints");
  iris.push({ status: 200, body: { messages: [{ message: burn({ destinationDomain: 6 }), attestation: ATT, status: "complete" }] } });
  eq((await look(`domain=6&tx=${tx}`)).status, 404, "a burn to somewhere else");
  iris.push({ status: 200, body: { messages: [{ message: burn({ sourceDomain: 0, sender: BASE.messenger }), attestation: ATT, status: "complete" }] } });
  eq((await look(`domain=6&tx=${tx}`)).status, 404, "a message from another source than asked");
  iris.push({ status: 503, body: {} });
  eq((await look(`domain=6&tx=${tx}`)).status, 502, "Circle down");
  // reattest
  iris.push({ status: 200, body: {} });
  const re = await messageRoute.POST(req("/api/starknet/cctp/message", { method: "POST", body: JSON.stringify({ nonce: "0x" + "ab".repeat(32) }) }));
  eq(re.status, 200, "ask Circle to sign again");
  eq(irisSeen.at(-1), `POST /v2/reattest/0x${"ab".repeat(32)}`, "by nonce");
  eq((await messageRoute.POST(req("/api/starknet/cctp/message", { method: "POST", body: JSON.stringify({ nonce: "0x12" }) }))).status, 400, "only a nonce");
  eq((await messageRoute.POST(req("/api/starknet/cctp/message", { method: "POST", body: "{}", headers: { "sec-fetch-site": "cross-site" } }))).status, 403, "same site only");

  // POST receive
  const chain = fakeChain();
  const make = server.starknetCctpChains.make;
  server.starknetCctpChains.make = () => chain;
  const o = outside({ before: Math.floor(Date.now() / 1000) + 600, after: Math.floor(Date.now() / 1000) - 60 });
  const body = { message: burn({ nonce: "0x" + "de".repeat(32) }), attestation: ATT, outside: { ...o, calldata: (o.calldata as string[]).map((x) => num.toHex(BigInt(x))) } };
  const post = (b: unknown, ip = "198.51.100.8", headers: Record<string, string> = {}) => route.POST(req("/api/starknet/cctp", { method: "POST", body: JSON.stringify(b), ip, headers }));
  const r1 = await post(body);
  const j1 = (await r1.json()) as { ok: boolean; txHash: string; minted: string; fee: string; approved: string };
  eq([r1.status, j1.txHash, j1.minted, j1.fee, j1.approved], [200, "0xbeef", "99987000", "250000", "99737000"], "the receive is sent");
  eq(chain.sent.length, 1, "one transaction");
  eq((await post({ ...body, outside: { ...body.outside, entrypoint: "execute" } })).status, 400, "only an outside execution");
  eq((await post({ ...body, attestation: "PENDING" })).status, 400, "only a signed message");
  eq((await post({ ...body, message: "hello" })).status, 400, "only hex");
  eq((await post(body, "198.51.100.8", { "sec-fetch-site": "cross-site" })).status, 403, "same site only");
  eq((await post({ ...body, message: burn({ nonce: "0x" + "df".repeat(32), destinationDomain: 6 }) })).status, 422, "the policy refuses");
  // the day's count per IP (10 on mainnet)
  let last = 0;
  for (let i = 0; i < 11; i++) last = (await post({ ...body, message: burn({ nonce: "0x" + (0x1000 + i).toString(16).padStart(64, "0") }) }, "198.51.100.9")).status;
  eq(last, 429, "the eleventh receive from one IP in a day waits");
  server.starknetCctpChains.make = make;

  /* ------------------------------------------------------------------ the browser */
  const fetchBefore = globalThis.fetch;
  const answers: { status: number; body: unknown }[] = [];
  const posted: unknown[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith("https://app.selftest/api/starknet/cctp")) {
      if (init?.method === "POST") posted.push(JSON.parse(String(init.body)));
      const a = answers.shift() ?? { status: 500, body: {} };
      return Response.json(a.body, { status: a.status });
    }
    if (url.startsWith("https://app.selftest/api/starknet/rpc")) {
      const call = JSON.parse(String(init?.body)) as { id: unknown; method: string };
      const result = call.method === "starknet_chainId" ? "0x534e5f4d41494e" : call.method === "starknet_call" ? ["0x1"] : null;
      return Response.json({ jsonrpc: "2.0", id: call.id, result });
    }
    return fetchBefore(input, init);
  }) as typeof fetch;
  try {
    answers.push({ status: 200, body: { ok: true, status: "pending" } }, { status: 502, body: { ok: false } }, { status: 200, body: { ok: true, status: "complete", message: burn(), attestation: ATT, nonce: "0x" + "ab".repeat(32), minted: "99987000", expirationBlock: "20000000" } });
    const waits: number[] = [];
    const a = await client.waitForCircle({ domain: 6, tx }, { origin: "https://app.selftest", timeoutMs: 5_000, pollMs: 1, onWait: (s) => waits.push(s) });
    eq([a.minted, a.expirationBlock, waits.length], [99_987_000n, 20_000_000n, 3], "waits through pending and a slow answer, then has the message");
    answers.push({ status: 404, body: { ok: false, error: { code: "not_to_starknet" } } });
    await rejects(client.waitForCircle({ domain: 6, tx }, { origin: "https://app.selftest", timeoutMs: 5_000, pollMs: 1 }), /no USDC transfer to Starknet/, "a burn to somewhere else stops the wait");
    for (let i = 0; i < 50; i++) answers.push({ status: 200, body: { ok: true, status: "pending" } });
    await rejects(client.waitForCircle({ domain: 6, tx }, { origin: "https://app.selftest", timeoutMs: 5, pollMs: 2 }), /still on its way/, "a long wait says the transfer is still coming");
    answers.length = 0;
    eq(client.attestWaitMs({ fast: true, attestSeconds: 8 }), 10 * 60_000, "at least ten minutes");

    // the session signs the fee and the approve as one outside execution for the relay
    const sessionLib = await import("../src/lib/starknetPrivacy/session");
    const keys = await account.keysFromSeed(new Uint8Array(32).fill(9), 0);
    const relayInfo = { on: true, funded: true, relayer: RELAY, network: "mainnet", pool: POOL, fee: { [num.toHex(BigInt(USDC))]: "250000" }, maxApprove: { [num.toHex(BigInt(USDC))]: "1000000000" } };
    const session = new sessionLib.StarknetSession(cfg, keys, relayInfo, "https://app.selftest", 1);
    // The account's node reads (the chain id, and whether a random SNIP-9 nonce is unused), answered here.
    const signer = (session as unknown as { signer: { provider: { getChainId(): Promise<string>; callContract(): Promise<string[]> } } }).signer;
    signer.provider.getChainId = async () => "0x534e5f4d41494e";
    signer.provider.callContract = async () => ["0x1"];
    const attested = { message: burn({ body: { mintRecipient: cctp.starknetToBytes32(keys.address) } }), attestation: ATT, nonce: "0x" + "ab".repeat(32), minted: 99_987_000n, expirationBlock: 0n };
    answers.push({ status: 200, body: { ok: true, txHash: "0xfeed", minted: "99987000", fee: "250000", approved: "99737000" } });
    const got = await client.receiveIntoAccount(session, cfg.tokens[0]!, { fee: "250000" }, attested, "https://app.selftest");
    eq([got.txHash, got.approved], ["0xfeed", 99_737_000n], "the relay's answer and what the add may take");
    const sentBody = posted.at(-1) as { message: string; attestation: string; outside: Call };
    eq([sentBody.message, sentBody.attestation], [attested.message, ATT], "Circle's message and attestation as they came");
    const d = cctp.checkCctpReceive({ message: sentBody.message, attestation: sentBody.attestation, outside: sentBody.outside }, { ...ctx, now: Math.floor(Date.now() / 1000) });
    ok(d.ok, "what the browser signs passes the relay's policy");
    if (d.ok) eq([d.account, d.fee, d.approve], [num.toHex(BigInt(keys.address)), 250_000n, 99_737_000n], "into this account, the fee, the rest approved");
    // the signature is the account's own key over SNIP-9's typed data
    const cd = (sentBody.outside.calldata as string[]).map(BigInt);
    const td = outsideExecution.getTypedData(
      "0x534e5f4d41494e",
      { caller: num.toHex(cd[0]!), execute_after: Number(cd[2]), execute_before: Number(cd[3]) },
      num.toHex(cd[1]!),
      cctp.receiveOutsideCalls({ usdc: USDC, relay: RELAY, pool: POOL, fee: 250_000n, approve: 99_737_000n }),
      OutsideExecutionVersion.V2
    );
    const digest = typedData.getMessageHash(td, keys.address);
    const [r, sg] = cd.slice(-2);
    ok(ec.starkCurve.verify(new ec.starkCurve.Signature(r!, sg!), digest, ec.starkCurve.getPublicKey(num.toHex(keys.accountKey))), "signed by the account's own key over SNIP-9's typed data");
    answers.push({ status: 409, body: { ok: false, error: { code: "already_received", message: "That transfer already arrived on Starknet." } } });
    await rejects(client.receiveIntoAccount(session, cfg.tokens[0]!, { fee: "250000" }, attested, "https://app.selftest"), /already arrived/, "the relay's refusal comes back as it said it");
    await rejects(client.receiveIntoAccount(session, cfg.tokens[0]!, { fee: "99987000" }, attested, "https://app.selftest"), /smaller than Gloam's fee/, "a transfer the fee eats is refused before signing");

    // kept on this device
    const store = new Map<string, string>();
    (globalThis as unknown as { localStorage: Storage }).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    } as Storage;
    const p = { domain: 6, chainId: 8453, tx, amount: "100000000", at: 1 };
    client.keepPendingBringIn(keys.address, p);
    client.keepPendingBringIn(keys.address, p);
    eq(client.pendingBringIns(keys.address), [p], "kept once");
    eq(client.pendingBringIns("0x1234"), [], "per account");
    client.dropPendingBringIn(keys.address, tx);
    eq(client.pendingBringIns(keys.address), [], "dropped once it arrived");
    store.set(`gloam:starknet:cctp:pending:v1:${BigInt(keys.address).toString(16)}`, "not json");
    eq(client.pendingBringIns(keys.address), [], "a broken record reads as none");
  } finally {
    globalThis.fetch = fetchBefore;
  }
} finally {
  globalThis.fetch = realFetch;
}

console.log(`\nselftest-starknet-cctp: ${pass} checks passed`);
