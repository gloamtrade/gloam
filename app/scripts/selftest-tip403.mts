/**
 * Self-test: TIP-403 issuer transfer policies on Tempo (lib/tip403.ts, the
 * server wiring, /api/screen, /api/screen/policy and the relay check).
 *
 * Offline by default: an in-memory registry stands in for the chain. Nothing is
 * signed or sent; the relay rejects before any RPC call.
 *
 * With --live, also reads the real Tempo Moderato chain (eth_call only) and
 * prints the policies of OUSD and PathUSD and the vault's standing under them.
 *
 * Run from app/:  ../mcp/node_modules/.bin/tsx scripts/selftest-tip403.mts [--live]
 */
import assert from "node:assert/strict";
import type { Address } from "viem";
import { SCREEN_BLOCKED_MESSAGE } from "../src/lib/screening";
import {
  ALWAYS_ALLOW_POLICY_ID,
  TIP403_PAUSED_MESSAGE,
  TIP403_POOL_RECEIVE_MESSAGE,
  TIP403_POOL_SEND_MESSAGE,
  TIP403_RECEIVE_POLICY_MESSAGE,
  TIP403_RECEIVE_UNCHECKED_MESSAGE,
  TIP403_REGISTRY,
  TEMPO_ADDRESS_REGISTRY,
  checkReceivePolicy,
  checkTip403,
  isAuthorizedAs,
  isTip20Address,
  isTip403Chain,
  isVirtualAddress,
  poolNotice,
  policyLabel,
  readAssetStatus,
  readTokenPolicy,
  type Tip403Call,
  type Tip403Reader,
} from "../src/lib/tip403";
import { screenTip403, setTip403ReaderFactory, tip403AssetStatus } from "../src/lib/tip403Server";
import { screenAddresses } from "../src/lib/screeningServer";
import { POST as screenPost } from "../src/app/api/screen/route";
import { GET as policyGet } from "../src/app/api/screen/policy/route";
import { POST as relayPost } from "../src/app/api/relay/route";
import { RelayError, relayUnshield, screenCall } from "../src/lib/relay/server";
import { escrowAddress } from "../src/lib/vaultSwap";
import { getNetwork } from "../src/lib/networks";

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  await fn();
  passed++;
  console.log(`ok  ${name}`);
}

const TEMPO = getNetwork("tempo");
const RH = getNetwork("robinhood");
const POOL = TEMPO.pool! as Address;
const OUSD = "0x20c0000000000000000000006a37da5c996874be" as Address;
const PATHUSD = "0x20c0000000000000000000000000000000000000" as Address;
// Made-up TIP-20 tokens for the fake chain.
const ALLOW_T = "0x20c0000000000000000000000000000000000a01" as Address;
const BLOCK_T = "0x20c0000000000000000000000000000000000a02" as Address;
const COMP_T = "0x20c0000000000000000000000000000000000a03" as Address;
const PAUSE_T = "0x20c0000000000000000000000000000000000a04" as Address;
const REJECT_T = "0x20c0000000000000000000000000000000000a05" as Address;
const POOLBAN_T = "0x20c0000000000000000000000000000000000a06" as Address;

const ALICE = "0x1111111111111111111111111111111111111111" as Address;
const BOB = "0x2222222222222222222222222222222222222222" as Address;
const CAROL = "0x3333333333333333333333333333333333333333" as Address;
// Takes payments from the vault, refuses them from the swap router.
const ERIN = "0x5555555555555555555555555555555555555555" as Address;
// Refuses payments from one swap's escrow, which pays its exit.
const DAVE = "0x6666666666666666666666666666666666666666" as Address;
// A swap router, the sender of an exit.
const ROUTER = "0x75A22213000000000000000000000000000000aa" as Address;
// TIP-1022 virtual address (ten 0xFD bytes at offset 4) whose master is ALICE.
const VIRTUAL = "0xabcdef01fdfdfdfdfdfdfdfdfdfd123456789abc" as Address;
// Lazarus Group (OFAC SDN), already covered by selftest-screening.
const LISTED = "0x098b716b8aaf21512996dc57eb0615e2383e2f96" as Address;

type Policy =
  | { type: 0 | 1; set: Set<string> }
  | { type: 2; sender: bigint; recipient: bigint; mint: bigint };

/** An in-memory TIP-403 registry + TIP-20 tokens, answering readContract like the chain. */
function fakeChain(opts: { preT2?: boolean; down?: boolean; receiveDown?: boolean; resolveDown?: boolean } = {}) {
  const lc = (a: string) => a.toLowerCase();
  const policies = new Map<bigint, Policy>([
    // 2: allowlist with Alice, Bob and the pool.
    [2n, { type: 0, set: new Set([ALICE, BOB, POOL].map(lc)) }],
    // 3: blocklist with Carol.
    [3n, { type: 1, set: new Set([CAROL].map(lc)) }],
    // 4: allowlist with Alice only (not the pool, not Bob).
    [4n, { type: 0, set: new Set([ALICE].map(lc)) }],
    // 5: blocklist with the pool.
    [5n, { type: 1, set: new Set([POOL].map(lc)) }],
    // 6: compound: senders under 5 (pool blocked from sending), recipients under 1 (anyone).
    [6n, { type: 2, sender: 5n, recipient: 1n, mint: 1n }],
  ]);
  const tokens = new Map<string, { policyId: bigint; paused: boolean }>([
    [lc(ALLOW_T), { policyId: 2n, paused: false }],
    [lc(BLOCK_T), { policyId: 3n, paused: false }],
    [lc(COMP_T), { policyId: 6n, paused: false }],
    [lc(PAUSE_T), { policyId: 1n, paused: true }],
    [lc(REJECT_T), { policyId: 0n, paused: false }],
    [lc(POOLBAN_T), { policyId: 5n, paused: false }],
  ]);
  // Bob refuses payments from the pool (TIP-1028 receive policy).
  const refusesPool = new Set([lc(BOB)]);
  const refusesRouter = new Set([lc(ERIN)]);
  /** Other refusals: receiver by sender. */
  const refused = new Map<string, Set<string>>();
  const calls: string[] = [];

  const simple = (id: bigint, user: string): boolean => {
    if (id === 0n) return false;
    if (id === 1n) return true;
    const p = policies.get(id);
    if (!p) throw new Error("PolicyNotFound");
    if (p.type === 2) throw new Error("IncompatiblePolicyType");
    return p.type === 0 ? p.set.has(lc(user)) : !p.set.has(lc(user));
  };
  const directional = (id: bigint, user: string, role: "sender" | "recipient"): boolean => {
    const p = policies.get(id);
    if (p && p.type === 2) return simple(role === "sender" ? p.sender : p.recipient, user);
    return simple(id, user);
  };

  const reader: Tip403Reader = {
    async readContract(call: Tip403Call) {
      calls.push(call.functionName);
      if (opts.down) throw new Error("fetch failed");
      const args = (call.args ?? []) as unknown[];
      if (lc(call.address) === lc(TIP403_REGISTRY)) {
        switch (call.functionName) {
          case "policyData": {
            const p = policies.get(args[0] as bigint);
            if (!p) throw new Error("PolicyNotFound");
            return [p.type, "0x0000000000000000000000000000000000000000"];
          }
          case "isAuthorizedSender":
          case "isAuthorizedRecipient":
            if (opts.preT2) throw new Error("execution reverted");
            return directional(
              args[0] as bigint,
              args[1] as string,
              call.functionName === "isAuthorizedSender" ? "sender" : "recipient"
            );
          case "isAuthorized": {
            const id = args[0] as bigint;
            const p = policies.get(id);
            if (p && p.type === 2) return simple(p.sender, args[1] as string) && simple(p.recipient, args[1] as string);
            return simple(id, args[1] as string);
          }
          case "validateReceivePolicy": {
            if (opts.preT2 || opts.receiveDown) throw new Error("execution reverted");
            const [from, to] = [lc(args[1] as string), lc(args[2] as string)];
            return [!((from === lc(POOL) && refusesPool.has(to)) || (from === lc(ROUTER) && refusesRouter.has(to)) || refused.get(from)?.has(to)), 2];
          }
        }
      }
      if (lc(call.address) === lc(TEMPO_ADDRESS_REGISTRY) && call.functionName === "resolveRecipient") {
        if (opts.resolveDown) throw new Error("fetch failed");
        return lc(args[0] as string) === lc(VIRTUAL) ? ALICE : args[0];
      }
      const t = tokens.get(lc(call.address));
      if (t && call.functionName === "transferPolicyId") return t.policyId;
      if (t && call.functionName === "paused") return t.paused;
      throw new Error(`unexpected call ${call.functionName} on ${call.address}`);
    },
  };
  const refuse = (sender: string, receiver: string) => refused.set(lc(sender), (refused.get(lc(sender)) ?? new Set()).add(lc(receiver)));
  return { reader, calls, refuse };
}

// ---------------------------------------------------------------- pure helpers

await test("address and chain helpers", () => {
  assert.ok(isTip20Address(OUSD));
  assert.ok(isTip20Address(PATHUSD));
  assert.ok(isTip20Address(PATHUSD.toUpperCase().replace("0X", "0x")));
  assert.equal(isTip20Address("0x0000000000000000000000000000000000000000"), false);
  assert.equal(isTip20Address("0x7E955252E15c84f5768B83c41a71F9eba181802F"), false); // USDG on RH
  assert.equal(isTip20Address("0x20c0"), false);
  assert.equal(isTip20Address(null), false);
  assert.ok(isVirtualAddress(VIRTUAL));
  assert.equal(isVirtualAddress(ALICE), false);
  assert.ok(isTip403Chain(42431));
  assert.equal(isTip403Chain(46630), false);
  assert.equal(isTip403Chain("42431"), false);
});

// ---------------------------------------------------------------- policy reads

await test("policy kinds from the token and registry", async () => {
  const { reader } = fakeChain();
  assert.deepEqual(await readTokenPolicy(reader, ALLOW_T), { policyId: 2n, kind: "allowlist", paused: false });
  assert.deepEqual(await readTokenPolicy(reader, BLOCK_T), { policyId: 3n, kind: "blocklist", paused: false });
  assert.deepEqual(await readTokenPolicy(reader, COMP_T), { policyId: 6n, kind: "compound", paused: false });
  assert.deepEqual(await readTokenPolicy(reader, PAUSE_T), { policyId: 1n, kind: "always-allow", paused: true });
  assert.deepEqual(await readTokenPolicy(reader, REJECT_T), { policyId: 0n, kind: "always-reject", paused: false });
});

await test("built-in policies 0 and 1 need no registry call", async () => {
  const { reader, calls } = fakeChain();
  assert.equal(await isAuthorizedAs(reader, ALWAYS_ALLOW_POLICY_ID, CAROL, "sender"), true);
  assert.equal(await isAuthorizedAs(reader, 0n, ALICE, "recipient"), false);
  assert.equal(calls.length, 0);
});

await test("allowlist, blocklist and compound (directional) authorization", async () => {
  const { reader } = fakeChain();
  assert.equal(await isAuthorizedAs(reader, 2n, ALICE, "sender"), true);
  assert.equal(await isAuthorizedAs(reader, 2n, CAROL, "sender"), false);
  assert.equal(await isAuthorizedAs(reader, 3n, ALICE, "recipient"), true);
  assert.equal(await isAuthorizedAs(reader, 3n, CAROL, "recipient"), false);
  // Compound 6: the pool may receive but not send.
  assert.equal(await isAuthorizedAs(reader, 6n, POOL, "recipient"), true);
  assert.equal(await isAuthorizedAs(reader, 6n, POOL, "sender"), false);
});

await test("pre-TIP-1015 chains fall back to isAuthorized", async () => {
  const { reader, calls } = fakeChain({ preT2: true });
  assert.equal(await isAuthorizedAs(reader, 3n, CAROL, "sender"), false);
  assert.equal(await isAuthorizedAs(reader, 3n, ALICE, "sender"), true);
  assert.ok(calls.includes("isAuthorizedSender") && calls.includes("isAuthorized"));
});

await test("vault standing and the issuer-freeze warning", async () => {
  const { reader } = fakeChain();
  const open = await readAssetStatus(reader, 42431, ALLOW_T, POOL);
  assert.equal(open.poolCanReceive && open.poolCanSend, true);
  assert.equal(poolNotice(open), null);
  assert.equal(policyLabel(open), "Allowlist");

  const banned = await readAssetStatus(reader, 42431, POOLBAN_T, POOL);
  assert.equal(banned.poolCanReceive || banned.poolCanSend, false);
  assert.equal(poolNotice(banned, "deposit"), TIP403_POOL_RECEIVE_MESSAGE);
  assert.equal(poolNotice(banned, "cashout"), TIP403_POOL_SEND_MESSAGE);

  // Compound: deposits still work, cash outs are frozen.
  const comp = await readAssetStatus(reader, 42431, COMP_T, POOL);
  assert.equal(poolNotice(comp, "deposit"), null);
  assert.equal(poolNotice(comp, "cashout"), TIP403_POOL_SEND_MESSAGE);
  assert.equal(poolNotice(comp), TIP403_POOL_SEND_MESSAGE);

  const paused = await readAssetStatus(reader, 42431, PAUSE_T, POOL);
  assert.equal(poolNotice(paused, "deposit"), TIP403_PAUSED_MESSAGE);
  assert.equal(policyLabel(paused), "Paused by issuer");

  const rejectAll = await readAssetStatus(reader, 42431, REJECT_T, POOL);
  assert.equal(poolNotice(rejectAll, "deposit"), TIP403_POOL_RECEIVE_MESSAGE);
});

await test("wallet checks per flow, neutral when the wallet is blocked", async () => {
  const { reader } = fakeChain();
  const allow = await readAssetStatus(reader, 42431, ALLOW_T, POOL);
  assert.deepEqual(await checkTip403({ reader, status: allow, addresses: [ALICE], flow: "deposit" }), { allowed: true });
  assert.deepEqual(await checkTip403({ reader, status: allow, addresses: [CAROL], flow: "deposit" }), {
    allowed: false,
    reason: "wallet",
    message: SCREEN_BLOCKED_MESSAGE,
  });
  const block = await readAssetStatus(reader, 42431, BLOCK_T, POOL);
  const carolOut = await checkTip403({ reader, status: block, addresses: [CAROL], flow: "cashout" });
  assert.equal(carolOut.allowed, false);
  assert.equal(!carolOut.allowed && carolOut.message, SCREEN_BLOCKED_MESSAGE);
  // A vault block wins over the wallet, and says so plainly.
  const banned = await readAssetStatus(reader, 42431, POOLBAN_T, POOL);
  const r = await checkTip403({ reader, status: banned, addresses: [ALICE], flow: "cashout" });
  assert.deepEqual(r, { allowed: false, reason: "pool", message: TIP403_POOL_SEND_MESSAGE });
});

await test("cash out: recipient receive policy (TIP-1028) and virtual addresses", async () => {
  const { reader } = fakeChain();
  const allow = await readAssetStatus(reader, 42431, ALLOW_T, POOL);
  // Bob is on the allowlist but refuses payments from the vault.
  assert.deepEqual(await checkTip403({ reader, status: allow, addresses: [BOB], flow: "cashout" }), {
    allowed: false,
    reason: "receive",
    message: TIP403_RECEIVE_POLICY_MESSAGE,
  });
  // A deposit from Bob is fine: receive policies only guard what Bob receives.
  assert.deepEqual(await checkTip403({ reader, status: allow, addresses: [BOB], flow: "deposit" }), { allowed: true });
  // A virtual address is judged as its master (Alice, allowlisted).
  assert.deepEqual(await checkTip403({ reader, status: allow, addresses: [VIRTUAL], flow: "cashout" }), { allowed: true });
  // A receive policy that doesn't answer is never taken as yes: a payment it refuses is held, not reverted.
  const old = fakeChain({ preT2: true });
  const oldStatus = await readAssetStatus(old.reader, 42431, ALLOW_T, POOL);
  await assert.rejects(checkTip403({ reader: old.reader, status: oldStatus, addresses: [ALICE], flow: "cashout" }));
  // the issuer's checks alone still answer
  assert.deepEqual(await checkTip403({ reader: old.reader, status: oldStatus, addresses: [ALICE], flow: "cashout", receive: false }), { allowed: true });
  // nor is a virtual address whose wallet can't be looked up
  const lost = fakeChain({ resolveDown: true });
  await assert.rejects(checkReceivePolicy(lost.reader, ALLOW_T, POOL, [VIRTUAL]));
  assert.deepEqual(await checkReceivePolicy(lost.reader, ALLOW_T, POOL, [ALICE]), { allowed: true });
});

await test("cash out: the receive policy is checked against whoever pays, the vault or a swap router", async () => {
  const { reader } = fakeChain();
  const allow = await readAssetStatus(reader, 42431, BLOCK_T, POOL);
  const refused = { allowed: false, reason: "receive", message: TIP403_RECEIVE_POLICY_MESSAGE };
  // Erin takes payments from the vault, not from the router; Bob the other way round.
  assert.deepEqual(await checkTip403({ reader, status: allow, addresses: [ERIN], flow: "cashout" }), { allowed: true });
  assert.deepEqual(await checkTip403({ reader, status: allow, addresses: [ERIN], flow: "cashout", sender: ROUTER }), refused);
  assert.deepEqual(await checkTip403({ reader, status: allow, addresses: [BOB], flow: "cashout", sender: ROUTER }), { allowed: true });
  assert.deepEqual(await checkReceivePolicy(reader, BLOCK_T, ROUTER, [ERIN]), refused);
  assert.deepEqual(await checkReceivePolicy(reader, BLOCK_T, POOL, [BOB]), refused);
});

// ---------------------------------------------------------------- server wiring

const fake = fakeChain();
setTip403ReaderFactory((chainId) => (chainId === TEMPO.chainId ? fake.reader : null));

await test("server screen: TIP-403 runs on Tempo with a TIP-20 asset only", async () => {
  const tempo = { chainId: TEMPO.chainId, asset: ALLOW_T };
  assert.deepEqual(await screenAddresses([ALICE], { ...tempo, flow: "deposit" }), { allowed: true });
  assert.deepEqual(await screenAddresses([CAROL], { ...tempo, flow: "deposit" }), {
    allowed: false,
    message: SCREEN_BLOCKED_MESSAGE,
    scope: "asset",
  });
  assert.deepEqual(await screenAddresses([ALICE], { chainId: TEMPO.chainId, asset: POOLBAN_T, flow: "cashout" }), {
    allowed: false,
    message: TIP403_POOL_SEND_MESSAGE,
    scope: "asset",
  });
  // Robinhood Chain, no asset, or a non-TIP-20 asset: sanctions only, as before.
  assert.deepEqual(await screenAddresses([CAROL], { chainId: RH.chainId, asset: ALLOW_T, flow: "deposit" }), { allowed: true });
  assert.deepEqual(await screenAddresses([CAROL]), { allowed: true });
  assert.deepEqual(
    await screenAddresses([CAROL], { chainId: TEMPO.chainId, asset: "0x0000000000000000000000000000000000000000" }),
    { allowed: true }
  );
  // Sanctions still come first, in the same shape.
  assert.deepEqual(await screenAddresses([LISTED], { ...tempo, flow: "deposit" }), { allowed: false });
});

await test("server screen: the issuer policy fails open when the chain does not answer, a cash out's receive policy fails closed", async () => {
  const unchecked = { allowed: false, reason: "unchecked", message: TIP403_RECEIVE_UNCHECKED_MESSAGE };
  const down = fakeChain({ down: true });
  setTip403ReaderFactory(() => down.reader);
  assert.deepEqual(await screenTip403([CAROL], { chainId: TEMPO.chainId, asset: ALLOW_T, flow: "deposit" }), { allowed: true });
  assert.deepEqual(await screenAddresses([CAROL], { chainId: TEMPO.chainId, asset: ALLOW_T, flow: "deposit" }), { allowed: true });
  await assert.rejects(tip403AssetStatus(TEMPO.chainId, ALLOW_T));
  assert.deepEqual(await screenTip403([ALICE], { chainId: TEMPO.chainId, asset: ALLOW_T, flow: "cashout" }), unchecked);
  assert.deepEqual(await screenAddresses([ALICE], { chainId: TEMPO.chainId, asset: ALLOW_T, flow: "cashout" }), {
    allowed: false,
    message: TIP403_RECEIVE_UNCHECKED_MESSAGE,
    scope: "asset",
  });
  // only the receive policy down: still refused
  const receiveDown = fakeChain({ receiveDown: true });
  setTip403ReaderFactory(() => receiveDown.reader);
  assert.deepEqual(await screenTip403([ALICE], { chainId: TEMPO.chainId, asset: ALLOW_T, flow: "cashout" }), unchecked);
  assert.deepEqual(await screenTip403([ALICE], { chainId: TEMPO.chainId, asset: ALLOW_T, flow: "deposit" }), { allowed: true });
  // and a wallet the issuer blocks still gets the neutral line first
  assert.deepEqual(await screenTip403([CAROL], { chainId: TEMPO.chainId, asset: BLOCK_T, flow: "cashout" }), {
    allowed: false,
    reason: "wallet",
    message: SCREEN_BLOCKED_MESSAGE,
  });
  setTip403ReaderFactory((chainId) => (chainId === TEMPO.chainId ? fake.reader : null));
  assert.deepEqual(await screenTip403([ERIN], { chainId: TEMPO.chainId, asset: BLOCK_T, flow: "cashout", sender: ROUTER }), {
    allowed: false,
    reason: "receive",
    message: TIP403_RECEIVE_POLICY_MESSAGE,
  });
  assert.deepEqual(await screenTip403([ERIN], { chainId: TEMPO.chainId, asset: BLOCK_T, flow: "cashout" }), { allowed: true });
});

function req(url: string, body: unknown, ip = "198.51.100.9") {
  return new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify(body),
  });
}

await test("/api/screen: asset context, neutral wallet block, plain vault notice", async () => {
  const url = "http://localhost/api/screen";
  const ok = await screenPost(req(url, { addresses: [ALICE], chainId: TEMPO.chainId, asset: ALLOW_T, flow: "deposit" }));
  assert.deepEqual(await ok.json(), { ok: true, allowed: true });
  const wallet = await screenPost(req(url, { addresses: [CAROL], chainId: TEMPO.chainId, asset: ALLOW_T, flow: "deposit" }));
  const wj = await wallet.json();
  assert.deepEqual(wj, { ok: true, allowed: false, message: SCREEN_BLOCKED_MESSAGE, scope: "asset" });
  assert.equal(JSON.stringify(wj).toLowerCase().includes(CAROL.slice(2)), false);
  const pool = await screenPost(req(url, { addresses: [ALICE], chainId: TEMPO.chainId, asset: COMP_T, flow: "cashout" }));
  assert.deepEqual(await pool.json(), { ok: true, allowed: false, message: TIP403_POOL_SEND_MESSAGE, scope: "asset" });
  // Old clients (no context) get the old answer.
  const plain = await screenPost(req(url, { addresses: [CAROL] }));
  assert.deepEqual(await plain.json(), { ok: true, allowed: true });
  // Malformed context is refused.
  for (const bad of [
    { addresses: [ALICE], chainId: "42431", asset: ALLOW_T },
    { addresses: [ALICE], chainId: TEMPO.chainId, asset: "nope" },
    { addresses: [ALICE], chainId: TEMPO.chainId, asset: ALLOW_T, flow: "swap" },
  ]) {
    assert.equal((await screenPost(req(url, bad))).status, 400);
  }
});

await test("/api/screen/policy: public status and per-flow notices", async () => {
  const get = (q: string) => policyGet(new Request(`http://localhost/api/screen/policy?${q}`));
  assert.deepEqual(await (await get(`chainId=${RH.chainId}&asset=${ALLOW_T}`)).json(), { ok: true, applies: false });
  assert.deepEqual(await (await get(`chainId=${TEMPO.chainId}&asset=0x0000000000000000000000000000000000000000`)).json(), {
    ok: true,
    applies: false,
  });
  const j = await (await get(`chainId=${TEMPO.chainId}&asset=${COMP_T}`)).json();
  assert.equal(j.applies, true);
  assert.equal(j.status.kind, "compound");
  assert.equal(j.status.policyId, "6");
  assert.equal(j.status.poolCanReceive, true);
  assert.equal(j.status.poolCanSend, false);
  assert.deepEqual(j.notices, { deposit: null, cashout: TIP403_POOL_SEND_MESSAGE });
});

const H32 = "0x" + "11".repeat(32);
const PROOF = "0x" + "22".repeat(256);

await test("relay: cash-out recipient and vault checked against the issuer policy", async () => {
  const unshield = (asset: Address, to: Address) =>
    ({ kind: "unshield", args: [PROOF, H32, H32, asset, to, 1n] }) as never;
  await screenCall(unshield(ALLOW_T, ALICE), TEMPO);
  await assert.rejects(
    screenCall(unshield(BLOCK_T, CAROL), TEMPO),
    (e: RelayError) => e.message === SCREEN_BLOCKED_MESSAGE && e.code === "screened" && e.status === 403
  );
  await assert.rejects(
    screenCall(unshield(POOLBAN_T, ALICE), TEMPO),
    (e: RelayError) => e.message === TIP403_POOL_SEND_MESSAGE && e.code === "asset_policy" && e.status === 403
  );
  // Without the network (older callers), sanctions only.
  await screenCall(unshield(BLOCK_T, CAROL));
  // Robinhood Chain is untouched by TIP-403.
  await screenCall(unshield(BLOCK_T, CAROL), RH);
});

await test("relay: a cash out pays from the vault, an exit from its escrow, and an unread receive policy sends nothing", async () => {
  const h32 = H32 as `0x${string}`;
  const KEY = {
    nullifier: h32, amountIn: 1n, outCommitment: h32, assetOut: ALLOW_T, amountOut: 1n,
    refundCommitment: h32, refundAmount: 1n, routeHash: h32, exitKey: ALICE, deadline: 1n,
  };
  const unshield = (asset: Address, to: Address) =>
    ({ kind: "unshield", args: [PROOF, H32, H32, asset, to, 1n] }) as never;
  const exit = (asset: Address, to: Address) =>
    ({ kind: "swapExit", router: ROUTER, args: [asset, KEY, to, "0x"] }) as never;
  const held = (e: RelayError) => e.message === TIP403_RECEIVE_POLICY_MESSAGE && e.code === "asset_policy" && e.status === 403;
  fake.refuse(escrowAddress(ROUTER, BLOCK_T, KEY), DAVE);
  // Dave refuses this swap's escrow, Bob the vault, Erin the router alone, which pays neither
  await screenCall(unshield(BLOCK_T, DAVE), TEMPO);
  await assert.rejects(screenCall(exit(BLOCK_T, DAVE), TEMPO), held);
  await assert.rejects(screenCall(unshield(BLOCK_T, BOB), TEMPO), held);
  await screenCall(exit(BLOCK_T, BOB), TEMPO);
  await screenCall(exit(BLOCK_T, ERIN), TEMPO);
  // the receive policy doesn't answer: nothing goes, and it can be tried again
  for (const opts of [{ receiveDown: true }, { down: true }]) {
    const quiet = fakeChain(opts);
    setTip403ReaderFactory(() => quiet.reader);
    for (const call of [unshield(ALLOW_T, ALICE), exit(ALLOW_T, ALICE)]) {
      await assert.rejects(
        screenCall(call, TEMPO),
        (e: RelayError) => e.message === TIP403_RECEIVE_UNCHECKED_MESSAGE && e.code === "check_failed" && e.status === 503
      );
    }
  }
  setTip403ReaderFactory((chainId) => (chainId === TEMPO.chainId ? fake.reader : null));
  // Robinhood Chain has no receive policies to read
  await screenCall(exit(BLOCK_T, ERIN), RH);
});

await test("relay: a Tempo cash out reads the receive policy once", async () => {
  const counted = fakeChain();
  setTip403ReaderFactory(() => counted.reader);
  // the node answers the relay's two reads before a send, then nothing: the cash out stops there
  const real = globalThis.fetch;
  const answer = (r: { id: number; method: string; params?: { data?: string; input?: string }[] }) => {
    const data = String(r.params?.[0]?.data ?? r.params?.[0]?.input ?? "");
    const ok = (result: string) => ({ jsonrpc: "2.0", id: r.id, result });
    if (r.method === "eth_chainId") return ok(`0x${TEMPO.chainId.toString(16)}`);
    if (r.method === "eth_call" && data.startsWith("0xae20bed3")) return ok(`0x${"00".repeat(32)}`); // spent: no
    if (r.method === "eth_call") return ok(`0x${"00".repeat(31)}01`); // isKnownRoot: yes
    return { jsonrpc: "2.0", id: r.id, error: { code: -32000, message: "selftest: no more" } };
  };
  globalThis.fetch = (async (_u: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    return new Response(JSON.stringify(Array.isArray(body) ? body.map(answer) : answer(body)), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    await assert.rejects(
      relayUnshield(TEMPO, { proof: PROOF, root: H32, nullifier: "0x" + "33".repeat(32), asset: ALLOW_T, to: ALICE, amount: "1" })
    );
  } finally {
    globalThis.fetch = real;
    setTip403ReaderFactory((chainId) => (chainId === TEMPO.chainId ? fake.reader : null));
  }
  assert.ok(counted.calls.includes("isKnownRoot") === false, "the fake reader is the policy registry only");
  assert.equal(counted.calls.filter((c) => c === "validateReceivePolicy").length, 1);
});

await test("relay route on Tempo rejects a blocked recipient before any RPC call or signing", async () => {
  const res = await relayPost(
    req("http://localhost/api/relay", {
      chainId: TEMPO.chainId,
      action: "unshield",
      proof: PROOF,
      root: H32,
      nullifier: H32,
      asset: BLOCK_T,
      to: CAROL,
      amount: "1",
    })
  );
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { ok: false, error: SCREEN_BLOCKED_MESSAGE, code: "screened" });
});

setTip403ReaderFactory(null);
console.log(`\ntip403: ${passed} passed`);

// ---------------------------------------------------------------- live (read-only)

if (process.argv.includes("--live")) {
  console.log(`\nLive: Tempo Moderato (${TEMPO.chainId}), vault ${POOL}`);
  for (const [name, token] of [
    ["OUSD", OUSD],
    ["PathUSD", PATHUSD],
  ] as const) {
    const s = await tip403AssetStatus(TEMPO.chainId, token);
    assert.ok(s, `${name}: no status`);
    console.log(
      `${name.padEnd(8)} policy ${s.policyId} (${s.kind}, "${policyLabel(s)}"), paused ${s.paused}, ` +
        `vault can receive ${s.poolCanReceive}, vault can send ${s.poolCanSend}, ` +
        `deposit notice ${poolNotice(s, "deposit") ?? "none"}, cash-out notice ${poolNotice(s, "cashout") ?? "none"}`
    );
    const v = await screenTip403([ALICE], { chainId: TEMPO.chainId, asset: token, flow: "cashout" });
    console.log(`${"".padEnd(8)} cash out to ${ALICE}: ${v.allowed ? "allowed" : `blocked (${v.reason})`}`);
  }
}
