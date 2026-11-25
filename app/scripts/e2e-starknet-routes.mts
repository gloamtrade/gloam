/**
 * Local only: the app's Starknet side end to end through Gloam's own routes,
 * with the same code the page runs (lib/starknetPrivacy/session): reads through
 * /api/starknet/rpc, proofs through /api/starknet/prove, every transaction sent
 * by /api/starknet/relay. Two private accounts from fixed seeds: both open (the
 * relay deploys and registers them), Alice gets 1.0 of devnet's test token on
 * her account, adds it, pays Bob 0.3, Bob cashes out 0.1. Balances are checked
 * exactly, and neither account ever holds STRK.
 *
 * Needs a dev server running with Starknet on devnet (scripts/devnet-starknet-up.mts
 * says how) and its devnet. From app/:
 *   APP_URL=http://localhost:3437 STARKNET_DEVNET_URL=http://127.0.0.1:5081 \
 *     ../mcp/node_modules/.bin/tsx scripts/e2e-starknet-routes.mts
 */
import assert from "node:assert/strict";
import { Account, CallData, RpcProvider, num } from "starknet";

const APP = process.env.APP_URL ?? "http://localhost:3437";
const DEVNET = process.env.STARKNET_DEVNET_URL ?? "http://127.0.0.1:5081";
const relayInfo = (await (await fetch(`${APP}/api/starknet/relay`)).json()) as import("../src/lib/starknetPrivacy/session").StarknetRelayInfo;
assert.ok(relayInfo.on && relayInfo.pool, `the relay is on: ${JSON.stringify(relayInfo)}`);
process.env.NEXT_PUBLIC_STARKNET_POOL = relayInfo.pool!;
process.env.NEXT_PUBLIC_STARKNET_DEVNET_RPC = DEVNET;

const { starknetConfig } = await import("../src/lib/starknetPrivacy/config");
const { keysFromSeed } = await import("../src/lib/starknetPrivacy/account");
const { StarknetSession } = await import("../src/lib/starknetPrivacy/session");

const cfg = starknetConfig("devnet");
const token = cfg.tokens[0]!;
const ONE = 10n ** 18n;
let checks = 0;
const eq = <T,>(a: T, b: T, m: string) => {
  assert.deepEqual(a, b, m);
  checks++;
  console.log("  ok", m);
};
const log = (who: string) => (at: number, d?: string) => console.log(`  [${who}] step ${at}${d ? ` (${d})` : ""}`);

const open = async (seed: string) => {
  const keys = await keysFromSeed(new TextEncoder().encode(seed), 0, cfg.accountClassHash);
  const s = new StarknetSession(cfg, keys, relayInfo, APP, 1_000);
  await s.ensureOpen(log(seed));
  return s;
};

console.log("opening two accounts through the routes");
const RUN = process.env.RUN_ID ?? String(Date.now());
const alice = await open(`e2e-starknet-routes-alice-${RUN}`);
const bob = await open(`e2e-starknet-routes-bob-${RUN}`);
eq(await alice.ready(token), true, "alice is open (registered, her own channel)");
eq(await bob.ready(token), true, "bob is open");

// Money lands on Alice's account (a bridge would put it there).
const node = new RpcProvider({ nodeUrl: DEVNET, batch: 0 });
const pre = (await (await fetch(DEVNET, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "devnet_getPredeployedAccounts", params: [] }) })).json()) as { result: { address: string; private_key: string }[] };
const admin = new Account({ provider: node, address: pre.result[0]!.address, signer: pre.result[0]!.private_key, cairoVersion: "1" });
await node.waitForTransaction((await admin.execute({ contractAddress: token.address, entrypoint: "transfer", calldata: CallData.compile([alice.address, num.toHex(ONE), "0x0"]) })).transaction_hash);
eq(await alice.publicBalance(token), ONE, "1.0 sits on alice's account");

console.log("alice adds 1.0");
await alice.add(token, ONE, log("add"));
eq(await alice.privateBalance(token), ONE, "alice holds 1.0 privately");
eq(await alice.publicBalance(token), 0n, "nothing left on her account");

console.log("alice pays bob 0.3");
eq(await alice.canBePaid(bob.address, token), true, "bob can be paid");
await alice.pay(bob.address, token, (3n * ONE) / 10n, log("pay"));

console.log("bob cashes out 0.1");
const OUT = "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abce";
await bob.cashOut(OUT, token, ONE / 10n, log("cashout"));

eq(await alice.privateBalance(token), (7n * ONE) / 10n, "alice keeps 0.7 privately");
eq(await bob.privateBalance(token), (2n * ONE) / 10n, "bob keeps 0.2 privately");
const out = await node.callContract({ contractAddress: token.address, entrypoint: "balance_of", calldata: [OUT] });
eq(BigInt(out[0]!), ONE / 10n, "the cash-out address got 0.1");
const STRK = "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";
for (const [n, s] of [["alice", alice], ["bob", bob]] as const) {
  const r = await node.callContract({ contractAddress: STRK, entrypoint: "balance_of", calldata: [s.address] });
  eq(BigInt(r[0]!), 0n, `${n} never held STRK`);
}
console.log(`[e2e-starknet-routes] PASS, ${checks} checks`);
