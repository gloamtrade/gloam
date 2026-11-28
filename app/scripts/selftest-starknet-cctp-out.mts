/**
 * Self-test: cashing out from Starknet to another chain with Circle's CCTP
 * (lib/starknetPrivacy/cctpOut, cctpOutServer, cctpOutClient and
 * /api/starknet/cctp/burn), with every node and Circle faked: no request
 * leaves the process.
 *
 *  - the burn: deposit_for_burn_with_hook's calldata is byte for byte that of a
 *    real forwarded burn from Starknet to Base (tx 0x5788b313...b18df, 4.27 USDC,
 *    which Circle delivered: forwardState COMPLETE, read 2026-11-27); the
 *    forwarding hook is Circle's "cctp-forward" version 0.
 *  - fees: Circle's forwarding fee rows, the max fee (fast fee rounded up plus
 *    the high forwarding estimate), what arrives and what leaves.
 *  - one-time accounts: from the private account's key and an index,
 *    deterministic, one per index, never the account itself, at the address
 *    the relay's deploy gives; the next unused one is the first not deployed.
 *  - the relay's burn rule (checkCctpBurn): the shape it sends and every way it
 *    is refused (calls, amounts, destination, recipient, token, caller, fee,
 *    finality, hook, deploy key, and an apply that adds, pays elsewhere or
 *    withdraws a different amount than it burns).
 *  - the server (cctpBurnSend) against a fake chain: sends [the pool's fee
 *    approve, apply, approve 0, the one-time deploy, its burn] once with the
 *    proof; refuses what the pool's rule refuses, a used one-time account, a
 *    changed pool or minter, a transaction that wouldn't run, a cost over the
 *    cap, the day's counts; the route refuses malformed bodies.
 *  - Circle's answer about a cash out: pending, signed, delivered.
 *
 * Run from app/:  ../mcp/node_modules/.bin/tsx scripts/selftest-starknet-cctp-out.mts
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import Module from "node:module";
import { fileURLToPath } from "node:url";
import { CairoCustomEnum, CairoOption, CairoOptionVariant, CallData, hash, num, type Call } from "starknet";
import type { CctpBurnDecision } from "../src/lib/starknetPrivacy/cctpOut";
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
const RELAY = "0x25a6c9f0c15ef30c139065096b4b8e563e6b86191fd600a4f0616df8f22fb77";
env.GLOAM_STARKNET_RELAYER_ADDRESS = RELAY;
env.GLOAM_STARKNET_RELAYER_SECRET = "0x0" + randomBytes(30).toString("hex");

const cctp = await import("../src/lib/starknetPrivacy/cctp");
const out = await import("../src/lib/starknetPrivacy/cctpOut");
const outServer = await import("../src/lib/starknetPrivacy/cctpOutServer");
const outClient = await import("../src/lib/starknetPrivacy/cctpOutClient");
const config = await import("../src/lib/starknetPrivacy/config");
const account = await import("../src/lib/starknetPrivacy/account");
const { PrivacyPoolABI } = await import("@starkware-libs/starknet-privacy-sdk/abi");

let pass = 0;
const ok = (c: unknown, msg: string) => {
  assert.ok(c, msg);
  pass++;
};
const eq = <T,>(a: T, b: T, msg: string) => {
  assert.deepEqual(a, b, msg);
  pass++;
};

const MAIN = cctp.STARKNET_CCTP.mainnet;
const USDC = MAIN.usdc;
const cfg = config.starknetConfig("mainnet", {});
const POOL = cfg.pool!;
const NOW = 1_800_000_000;

/* ------------------------------------------------------------------ the burn, against a real forwarded one */
{
  eq(cctp.hexToBytes(out.FORWARD_HOOK).length, 32, "the hook is 32 bytes");
  eq(new TextDecoder().decode(cctp.hexToBytes(out.FORWARD_HOOK).subarray(0, 12)), "cctp-forward", "it starts with Circle's magic");
  // Starknet mainnet tx 0x05788b313443a0338c3907a732250742fc6ad878240849e978d7110dd54b18df: its burn call's calldata.
  const real = ["0x4115db", "0x0", "0x6", "0xbf28261a6d5ff846f5a61d13d7de9840", "0x294e6248", USDC, "0x0", "0x0", "0xe671", "0x0", "0x3e8", "0x1", "0x636374702d666f727761726400000000000000000000000000000000000000", "0x0", "0x1"];
  const mine = out.burnWithForwardCall(MAIN, { amount: 0x4115dbn, domain: 6, recipient: "0x294e6248bf28261a6d5ff846f5a61d13d7de9840", maxFee: 0xe671n });
  eq(mine.contractAddress, MAIN.tokenMessengerMinter, "to Circle's minter");
  eq(mine.entrypoint, "deposit_for_burn_with_hook", "with a hook");
  eq((mine.calldata as string[]).map((x) => BigInt(x)), real.map((x) => BigInt(x)), "the same calldata as a real forwarded burn Circle delivered on Base");
  eq(out.CCTP_DESTINATIONS.map((d) => d.domain), [6, 0, 3, 2, 7, 1, 10, 14, 11, 15, 19, 13, 37], "EVM destinations, Base first");
  eq(out.cctpDestinationByDomain(5), null, "Solana is not one yet (it needs a token account)");
  eq(out.cctpDestinationByChain(1)?.name, "Ethereum", "by chain");
}

/* ------------------------------------------------------------------ fees */
const BASE_FWD = { low: 53_448n, med: 54_072n, high: 55_121n };
{
  eq(out.forwardFeeFrom([{ finalityThreshold: 1000, minimumFee: 12, forwardFee: { low: 53448, med: 54072, high: 55121 } }]), BASE_FWD, "Circle's forwarding fee to Base (2026-11-27)");
  eq(out.forwardFeeFrom([{ finalityThreshold: 1000, minimumFee: 12 }]), null, "no forwarding row");
  eq(out.forwardFeeFrom([{ finalityThreshold: 1000, forwardFee: { low: 5, med: 3, high: 9 } }]), null, "out of order");
  eq(out.outMaxFee(4_265_435n, 12, BASE_FWD), 5_119n + 55_121n, "fast fee rounded up plus the high estimate");
  const c = out.cashOutToChainCosts(5_000_000n, 12, BASE_FWD, 250_000n, 250_000n)!;
  eq([c.maxFee, c.circle, c.gloam, c.spent, c.arrives], [61_121n, 61_121n, 500_000n, 5_500_000n, 4_938_879n], "5 USDC to Base: 4.94 arrives, 5.50 leaves the private balance");
  eq(out.cashOutToChainCosts(50_000n, 12, BASE_FWD, 0n, 0n), null, "less than Circle's fee: nothing");
}

/* ------------------------------------------------------------------ one-time accounts */
const keys = await account.keysFromSeed(new Uint8Array(32).fill(3), 0);
const ot0 = await out.oneTimeKeys(keys.accountKey, 0);
{
  const again = await out.oneTimeKeys(keys.accountKey, 0);
  const ot1 = await out.oneTimeKeys(keys.accountKey, 1);
  const other = await out.oneTimeKeys((await account.keysFromSeed(new Uint8Array(32).fill(4), 0)).accountKey, 0);
  eq(again, ot0, "the same index gives the same one-time account");
  ok(ot1.address !== ot0.address && other.address !== ot0.address, "another index or another account gives another one");
  ok(ot0.address !== keys.address, "never the private account itself");
  eq(ot0.address, account.accountAddress(ot0.publicKey), "at the address the relay's deploy gives");
  // The next unused one is the first one not deployed.
  const deployed = new Set([ot0.address, ot1.address].map((a) => BigInt(a)));
  const fakeSession = {
    keys,
    provider: {
      getClassHashAt: async (a: string) => {
        if (deployed.has(BigInt(a))) return config.STARKNET_ACCOUNT_CLASS_HASH;
        throw Object.assign(new Error("Contract not found"), { code: 20 });
      },
    },
  };
  eq((await outClient.nextOneTime(fakeSession as never)).index, 2, "the first not yet deployed");
  const flaky = { ...fakeSession, provider: { getClassHashAt: async () => Promise.reject(Object.assign(new Error("down"), { code: -32000 })) } };
  await assert.rejects(outClient.nextOneTime(flaky as never), /down/);
  pass++;
}

/* ------------------------------------------------------------------ the relay's burn rule */
const RECIPIENT = "0x" + "ab".repeat(20);
const AMOUNT = 5_000_000n;
const FEE = 250_000n;
const MAXFEE = 61_121n;
const pcd = new CallData(PrivacyPoolABI);
const applyOf = (actions: CairoCustomEnum[]): Call => ({ contractAddress: POOL, entrypoint: "apply_actions", calldata: pcd.compile("apply_actions", { actions, screening: new CairoOption(CairoOptionVariant.None) }) });
const to = (addr: string, amount: bigint, tok = USDC) => new CairoCustomEnum({ TransferTo: { to_addr: addr, token: tok, amount } });
const from = (addr: string, amount: bigint) => new CairoCustomEnum({ TransferFrom: { from_addr: addr, token: USDC, amount } });
const write = () => new CairoCustomEnum({ WriteOnce: { storage_address: "0x77", value: ["0x1", "0x2"] } });
const used = () => new CairoCustomEnum({ EmitNoteUsed: { nullifier: "0x5" } });
const APPLY = applyOf([used(), to(ot0.address, AMOUNT + FEE), to(RELAY, 250_000n), write()]);
function outside(calls: Call[], over: { caller?: string; before?: number; after?: number; sig?: string[]; account?: string; extra?: string[] } = {}): Call {
  const flat = calls.flatMap((c) => [c.contractAddress, hash.getSelectorFromName(c.entrypoint), num.toHex((c.calldata as string[]).length), ...(c.calldata as string[])]);
  const sig = over.sig ?? ["0x1", "0x2"];
  return {
    contractAddress: over.account ?? ot0.address,
    entrypoint: "execute_from_outside_v2",
    calldata: [over.caller ?? RELAY, "0x99", num.toHex(over.after ?? NOW - 60), num.toHex(over.before ?? NOW + 600), num.toHex(calls.length), ...flat, num.toHex(sig.length), ...sig, ...(over.extra ?? [])],
  };
}
const calls = (over: Partial<Parameters<typeof out.oneTimeCalls>[1]> = {}) => out.oneTimeCalls(MAIN, { amount: AMOUNT, domain: 6, recipient: RECIPIENT, maxFee: MAXFEE, relay: RELAY, fee: FEE, ...over });
const bctx = { cctp: MAIN, relay: RELAY, now: NOW, minFee: FEE, accountClassHash: config.STARKNET_ACCOUNT_CLASS_HASH };
const check = (o = outside(calls()), apply = APPLY, deploy: string | null = ot0.publicKey) => out.checkCctpBurn({ apply, deploy, outside: o }, bctx);
const refused = (d: CctpBurnDecision, reason: string, msg: string) => eq(d.ok ? "ok" : d.reason, reason, msg);
{
  const d = check();
  ok(d.ok, "the cash out's burn passes");
  if (d.ok) eq([d.oneTime, d.amount, d.fee, d.withdrawn, d.domain, d.recipient, d.maxFee, d.finality], [num.toHex(BigInt(ot0.address)), AMOUNT, FEE, AMOUNT + FEE, 6, RECIPIENT, MAXFEE, 1000], "what it burns, where, and what it pays");
  ok(check(outside(calls()), APPLY, null).ok, "with the account already deployed (no deploy) the shape still passes; the chain decides");
  ok(check(outside(calls({ finality: 2000 }))).ok, "a standard transfer passes too");
  // the outside execution
  refused(check({ ...outside(calls()), entrypoint: "execute_from_outside" }), "outside_shape", "v1");
  refused(check(outside(calls(), { caller: "0x1234" })), "outside_caller", "another caller");
  refused(check(outside(calls().slice(0, 2))), "outside_three_calls", "no fee call");
  refused(check(outside([...calls(), calls()[2]!])), "outside_three_calls", "four calls");
  refused(check(outside(calls(), { before: NOW })), "outside_expired", "expired");
  refused(check(outside(calls(), { before: NOW + 3_601 })), "outside_window", "too long a window");
  refused(check(outside(calls(), { sig: [] })), "outside_signature", "no signature");
  refused(check(outside(calls(), { extra: ["0x0"] })), "outside_signature", "a trailing felt");
  const [ap, burn, pay] = calls();
  refused(check(outside([{ ...ap!, calldata: [RELAY, num.toHex(AMOUNT), "0x0"] }, burn!, pay!])), "approve_minter_only", "approve to someone but the minter");
  refused(check(outside([{ ...ap!, contractAddress: POOL }, burn!, pay!])), "approve_minter_only", "approve of another token");
  refused(check(outside([ap!, burn!, { ...pay!, calldata: ["0x1234", num.toHex(FEE), "0x0"] }])), "fee_to_relay_only", "the fee to someone else");
  refused(check(outside(calls({ fee: FEE - 1n }))), "fee_too_low", "a fee under the relay's");
  refused(check(outside([ap!, { ...burn!, entrypoint: "deposit_for_burn" }, pay!])), "burn_shape", "a burn with no hook");
  refused(check(outside([{ ...ap!, calldata: [MAIN.tokenMessengerMinter, num.toHex(AMOUNT + 1n), "0x0"] }, burn!, pay!])), "burn_amount", "approve and burn disagree");
  refused(check(outside(calls({ domain: 16 }))), "destination_not_listed", "Sei isn't listed");
  refused(check(outside(calls({ domain: 5 }))), "destination_not_listed", "Solana isn't yet");
  const cd = (c: Call) => [...(c.calldata as string[])];
  const withArg = (i: number, v: string) => {
    const x = cd(burn!);
    x[i] = v;
    return outside([ap!, { ...burn!, calldata: x }, pay!]);
  };
  refused(check(withArg(4, "0x100000000")), "recipient", "a recipient wider than an EVM address");
  refused(check(outside(calls({ recipient: "0x" + "0".repeat(40) }))), "recipient", "no recipient");
  refused(check(withArg(5, POOL)), "not_usdc", "burning another token");
  refused(check(withArg(6, "0x1")), "destination_caller", "only someone may deliver it");
  refused(check(withArg(8, num.toHex(AMOUNT))), "max_fee", "a max fee of all of it");
  refused(check(withArg(8, "0x0")), "max_fee", "no max fee (no delivery)");
  refused(check(withArg(10, "0x1f4")), "finality", "a finality Circle doesn't have");
  refused(check(withArg(12, "0x1234")), "not_forwarding", "another hook");
  // the deploy and the apply
  refused(check(outside(calls()), APPLY, keys.publicKey), "deploy_key", "the deploy of another account");
  refused(check(outside(calls()), applyOf([used(), from("0x99", 1n), to(ot0.address, AMOUNT + FEE), to(RELAY, 250_000n)])), "adds_too", "an apply that also adds");
  refused(check(outside(calls()), applyOf([used(), to(ot0.address, AMOUNT + FEE), to("0x1234", 1n), to(RELAY, 250_000n)])), "apply_elsewhere", "an apply that also pays someone else");
  refused(check(outside(calls()), applyOf([used(), to(ot0.address, AMOUNT + FEE + 1n), to(RELAY, 250_000n)])), "withdrawn_not_burned", "more withdrawn than burned (left on the one-time account)");
  refused(check(outside(calls()), applyOf([used(), to(ot0.address, AMOUNT), to(RELAY, 250_000n)])), "withdrawn_not_burned", "less withdrawn than burned");
  refused(check(outside(calls()), { ...APPLY, entrypoint: "apply" }), "apply_shape", "not apply_actions");
}

/* ------------------------------------------------------------------ the server */
type Sent = { calls: Call[]; proof?: unknown };
function fakeChain(over: Partial<CctpChain> & { sent?: Sent[] } = {}): CctpChain & { sent: Sent[] } {
  const sent: Sent[] = over.sent ?? [];
  return {
    classHashAt: async (a) =>
      config.sameStarknetAddress(a, POOL) ? config.STARKNET_MAINNET_POOL_CLASS_HASH : config.sameStarknetAddress(a, MAIN.tokenMessengerMinter) ? MAIN.classHashes!.tokenMessengerMinter : null,
    poolFeeAmount: async () => 45n * 10n ** 17n,
    nonceUsed: async () => false,
    blockNumber: async () => 18_600_000,
    estimate: async () => 7n * 10n ** 18n,
    send: async (c, proof) => {
      sent.push({ calls: c, proof });
      return "0xbeef";
    },
    ...over,
    sent,
  };
}
const PROOF = { proofFacts: ["0x1", "0x2"], proof: "AAAA" };
const ENV = { ...env, STARKNET_RELAY_FEE: "0.25", STARKNET_CCTP_FEE: "0.25" };
const send = (chain: CctpChain, over: Partial<Parameters<typeof outServer.cctpBurnSend>[0]> = {}) =>
  outServer.cctpBurnSend({ apply: APPLY, proof: PROOF, deploy: ot0.publicKey, outside: outside(calls()), cfg, cctp: MAIN, relay: RELAY, chain, env: ENV, now: NOW * 1000, rate: async () => "ok", outRate: async () => "ok", lockWaitMs: 200, ...over });
{
  const chain = fakeChain();
  const r = await send(chain);
  ok(r.ok, `the cash out to Base is sent${r.ok ? "" : `: ${r.code} ${r.message}`}`);
  eq(chain.sent.length, 1, "once");
  eq(
    chain.sent[0]!.calls.map((c) => c.entrypoint),
    ["approve", "apply_actions", "approve", "deploy_contract", "execute_from_outside_v2"],
    "one transaction: the pool's STRK fee, the proven cash out, approve 0, the one-time account's deploy, its burn"
  );
  eq(chain.sent[0]!.proof, PROOF, "with the proof");
  eq(chain.sent[0]!.calls[3], account.deployAccountCall(ot0.publicKey), "the deploy is of the one-time account");
  const again = await send(chain);
  eq(again.ok ? "sent" : again.code, "already_sent", "the same proven cash out is not sent twice");
  const code = async (c: CctpChain, over: Partial<Parameters<typeof outServer.cctpBurnSend>[0]> = {}) => {
    const x = await send(c, { apply: applyOf([used(), to(ot0.address, AMOUNT + FEE), to(RELAY, 250_000n), write(), write()]), ...over });
    return x.ok ? "sent" : x.code;
  };
  eq(await code(fakeChain({ classHashAt: async (a) => (config.sameStarknetAddress(a, ot0.address) ? config.STARKNET_ACCOUNT_CLASS_HASH : fakeChain().classHashAt(a)) })), "not_relayable", "a one-time account already used");
  eq(await code(fakeChain({ classHashAt: async (a) => (config.sameStarknetAddress(a, ot0.address) ? null : fakeChain().classHashAt(a)) }), { deploy: null }), "not_relayable", "no deploy for an account that isn't there");
  eq(await code(fakeChain({ classHashAt: async (a) => (config.sameStarknetAddress(a, POOL) ? "0x1234" : fakeChain().classHashAt(a)) })), "pool_changed", "the pool changed: paused");
  eq(await code(fakeChain({ classHashAt: async (a) => (config.sameStarknetAddress(a, MAIN.tokenMessengerMinter) ? "0x1234" : fakeChain().classHashAt(a)) })), "cctp_changed", "Circle's minter changed: paused");
  eq(await code(fakeChain({ poolFeeAmount: async () => 11n * 10n ** 18n })), "pool_fee_high", "the pool's fee over the cap: paused");
  const quiet = fakeChain();
  eq(await code(fakeChain({ ...quiet, estimate: async () => Promise.reject(new Error("invalid signature")) })), "would_fail", "a burn the one-time account didn't sign: not sent");
  eq(quiet.sent.length, 0, "nothing sent");
  eq(await code(fakeChain({ estimate: async () => 21n * 10n ** 18n })), "cost_high", "over the cap: paused");
  eq(await code(fakeChain(), { outRate: async () => "limited" }), "rate_limited", "this IP's cash outs to other chains today");
  eq(await code(fakeChain(), { rate: async () => "day_used" }), "relay_day_used", "the day's moves");
  eq(await code(fakeChain(), { env: { ...ENV, STARKNET_CCTP_FEE: "", STARKNET_RELAY_FEE: "" } }), "fee_unset", "mainnet with no fee");
  eq(await code(fakeChain(), { apply: applyOf([used(), to(ot0.address, AMOUNT + FEE)]) }), "not_relayable", "the pool's rule: no relay fee in the proof");
  eq(await code(fakeChain(), { apply: applyOf([write(), write()]) }), "not_relayable", "an open is not a cash out");
  eq(await code(fakeChain(), { proof: { proofFacts: ["0x1"], proof: "" } }), "not_relayable", "no proof on mainnet");
  eq(await code(fakeChain({ send: async () => Promise.reject(new Error("boom")) })), "send_failed", "a failed send says so");
  eq(await code(fakeChain()), "sent", "and the same one can go again after a failed send");
}

/* ------------------------------------------------------------------ the route and Circle's answer */
{
  const route = await import("../src/app/api/starknet/cctp/burn/route");
  const post = async (body: unknown, headers: Record<string, string> = {}) =>
    (await route.POST(new Request("https://www.gloam.trade/api/starknet/cctp/burn", { method: "POST", body: JSON.stringify(body), headers: { "x-forwarded-for": "198.51.100.40", "sec-fetch-site": "same-origin", "content-type": "application/json", ...headers } }))).status;
  const good = { apply: { ...APPLY, calldata: (APPLY.calldata as string[]).map((x) => num.toHex(BigInt(x))) }, proof: PROOF, deploy: ot0.publicKey, outside: outside(calls()) };
  eq(await post({ ...good, apply: { ...good.apply, entrypoint: "transfer" } }), 400, "only apply_actions");
  eq(await post({ ...good, outside: { ...good.outside, entrypoint: "__execute__" } }), 400, "only an outside execution");
  eq(await post({ ...good, proof: { proofFacts: [], proof: "" } }), 400, "a proof");
  eq(await post({ ...good, deploy: "nope" }), 400, "a key or null");
  eq(await post(good, { "sec-fetch-site": "cross-site" }), 403, "same site only");

  eq(out.irisOutboundFrom({ messages: [{ status: "pending_confirmations", decodedMessage: { sourceDomain: "25", destinationDomain: "6" } }] }), { status: "pending" }, "not signed yet");
  eq(
    out.irisOutboundFrom({ messages: [{ status: "complete", forwardState: "PENDING", decodedMessage: { sourceDomain: "25", destinationDomain: "6" } }] }),
    { status: "complete", forwardState: "PENDING", destinationMintTxHash: null, destinationDomain: 6 },
    "signed, Circle delivering"
  );
  eq(
    out.irisOutboundFrom({ messages: [{ status: "complete", forwardState: "COMPLETE", destinationMintTxHash: "0x93cd", decodedMessage: { sourceDomain: "25", destinationDomain: "6" } }] }),
    { status: "complete", forwardState: "COMPLETE", destinationMintTxHash: "0x93cd", destinationDomain: 6 },
    "delivered (the real burn above: forwardState COMPLETE)"
  );
  eq(out.irisOutboundFrom({ messages: [{ status: "complete", decodedMessage: { sourceDomain: "6" } }] }), null, "a burn from somewhere else");
  eq(out.irisOutboundFrom({ messages: [] }), null, "nothing");
}

console.log(`\nselftest-starknet-cctp-out: ${pass} checks passed`);
