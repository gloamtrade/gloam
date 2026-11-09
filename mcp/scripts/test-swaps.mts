/**
 * Private swaps over MCP: gloam_swap_quote, gloam_execute_private_swap,
 * gloam_finish_swap and the swap pass of gloam_list_notes refresh, driven through a
 * real MCP client over an in-memory transport.
 *
 *   pnpm --filter @gloamtrade/mcp test
 *
 * No chain: a fake one answers like the vault, the routers and the quoters, and a
 * fake relay applies a swap, a refund, a refusal or an unclear answer to it. Proofs
 * are stubbed (the fork test in app/scripts proves for real). Covers: quotes and
 * their stops, a network with no swaps, the owner's limits ("swap" must be listed),
 * both new notes kept before the relay is called, how each outcome settles the
 * notes, a refusal that keeps the refund note, the split of a larger note, the
 * refund and the exit (its recipient under the limits), the refresh pass, and the
 * move of a note whose swap reverted to a fresh note (held, and retried, until it lands).
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { keccak256, toHex, type Address, type Hex } from "viem";
import {
  GloamRelayError,
  IncrementalMerkleTreePoseidon,
  VAULT_SWAP_V3_ADDRESS,
  VAULT_SWAP_V3_LIVE,
  encodeRoute,
  escrowAddress,
  fieldToHex,
  hexToField,
  makeBoundNotePoseidon,
  vaultFeeOf,
  type SwapRelayCall,
} from "@gloamtrade/sdk";
import { createGloamServer, type ServerDeps } from "../src/server.js";
import type { Signer } from "../src/signer.js";
import { openNoteStore, type StoredNote } from "../src/noteStore.js";

type Env = Record<string, string | undefined>;
const POOL = "0x39e28cde55cab798874746ac52cb4b5cc99a0194" as Address;
const RH_USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as Address;
const RH_GLOAM = "0xDcD885F5c60b3aD49F6D58718696417314e8724d" as Address;
const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address;
const BASE_USDT = "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2" as Address;
const PROOF = `0x${"ab".repeat(256)}` as Hex;
const lc = (h: string) => h.toLowerCase();
const word = (a: string) => `0x${lc(a).slice(2).padStart(64, "0")}` as Hex;
const UNSHIELDED = keccak256(toHex("Unshielded(bytes32,address,address,uint256)"));

after(() => {
  VAULT_SWAP_V3_LIVE[8453] = null;
});

/** A chain that answers like the vault, the routers and the quoters; the relay below changes it. */
function fakeChain(chainId: number) {
  const tree = new IncrementalMerkleTreePoseidon();
  const index = new Map<string, number>();
  const roots = new Set<string>();
  const spent = new Set<string>();
  const seen = new Set<string>();
  const balances = new Map<string, bigint>();
  const receipts = new Map<string, { status: "success" | "reverted"; logs: unknown[] }>();
  const logs: { args: { nullifier: Hex; asset: Address; to: Address }; transactionHash: Hex }[] = [];
  /** Assets the vault takes none of (a deposit limit of 0 and 0). */
  const closed = new Set<string>();
  /** Assets whose total limit is used up: deposited equals the total. */
  const full = new Set<string>();
  let n = 0;
  const hash = () => `0x${(++n).toString(16).padStart(64, "0")}` as Hex;
  const insert = async (c: Hex) => {
    index.set(lc(c), await tree.insert(hexToField(c)));
    seen.add(lc(c));
    roots.add(lc(fieldToHex(tree.currentRoot)));
  };
  const client = {
    getChainId: async () => chainId,
    getBlock: async () => ({ number: 1000n, timestamp: BigInt(Math.floor(Date.now() / 1000)) }),
    getBlockNumber: async () => 1000n,
    getGasPrice: async () => 1_000_000_000n,
    getBalance: async () => 0n,
    getTransactionReceipt: async ({ hash: h }: { hash: Hex }) => {
      const r = receipts.get(h);
      if (!r) throw new Error("no receipt");
      return r;
    },
    waitForTransactionReceipt: async ({ hash: h }: { hash: Hex }) => receipts.get(h) ?? { status: "reverted", logs: [] },
    getTransaction: async () => ({}),
    getLogs: async ({ args }: { args: { nullifier: Hex; to: Address } }) =>
      logs.filter((l) => lc(l.args.nullifier) === lc(args.nullifier) && lc(l.args.to) === lc(args.to)),
    readContract: async ({ address, functionName, args }: { address: Address; functionName: string; args?: readonly unknown[] }) => {
      switch (functionName) {
        case "withdrawFeeBps":
          return 25;
        case "depositLimitsOn":
          return true;
        case "depositLimit":
          return closed.has(lc(args![0] as string)) ? [0n, 0n] : [50_000_000_000n, 2_500_000_000_000n];
        case "deposited":
          return full.has(lc(args![0] as string)) ? 2_500_000_000_000n : 0n;
        case "isSpent":
          return spent.has(lc(args![0] as string));
        case "isKnownRoot":
          return roots.has(lc(args![0] as string));
        case "commitmentSeen":
          return seen.has(lc(args![0] as string));
        case "balanceOf":
          return balances.get(`${lc(address)}:${lc(args![0] as string)}`) ?? 0n;
        case "escrowFor":
          return escrowAddress(address, args![0] as Address, args![1] as Parameters<typeof escrowAddress>[2]);
        case "decimals":
          return 18;
        case "symbol":
          return "TKN";
        default:
          throw new Error(`unexpected read ${functionName}`);
      }
    },
    multicall: async ({ contracts }: { contracts: { functionName: string; args: [{ exactAmount: bigint }] }[] }) =>
      contracts.map((c) => (c.functionName === "allowedPool" ? true : { status: "success", result: [c.args[0].exactAmount, 0n] })),
    simulateContract: async () => ({ result: [1n, 0n] }),
  };
  /** A note in the vault, as a deposit makes it. */
  async function deposit(amount: bigint, asset: Address) {
    const note = await makeBoundNotePoseidon(amount, asset);
    await insert(note.commitment as Hex);
    return note;
  }
  /** The swapped note's unshield sent alone: the money waits at the escrow. */
  function unshieldAlone(call: SwapRelayCall, held: bigint) {
    const b = call.body as { spend: { nullifier: Hex; asset: Address; amount: bigint } };
    const rec = escrowOf(call);
    spent.add(lc(b.spend.nullifier));
    balances.set(`${lc(b.spend.asset)}:${lc(rec)}`, held);
    const h = hash();
    logs.push({ args: { nullifier: b.spend.nullifier, asset: b.spend.asset, to: rec }, transactionHash: h });
    receipts.set(h, {
      status: "success",
      logs: [{ address: POOL, topics: [UNSHIELDED, b.spend.nullifier, word(b.spend.asset), word(rec)], data: toHex(b.spend.amount, { size: 32 }) }],
    });
    return h;
  }
  return { client, tree, index, roots, spent, seen, balances, receipts, logs, closed, full, hash, insert, deposit, unshieldAlone };
}
type Chain = ReturnType<typeof fakeChain>;

/** A swap call's escrow, worked out the way the router does it. */
function escrowOf(call: SwapRelayCall): Address {
  const b = call.body as Record<string, any>;
  return escrowAddress(b.router, b.spend.asset, {
    nullifier: b.spend.nullifier,
    amountIn: BigInt(b.spend.amount),
    outCommitment: b.deposit.commitment,
    assetOut: b.deposit.asset,
    amountOut: BigInt(b.deposit.amount),
    refundCommitment: b.refund.commitment,
    refundAmount: BigInt(b.refund.amount),
    routeHash: keccak256(encodeRoute(b.route)),
    ...(b.exitKey ? { exitKey: b.exitKey, deadline: BigInt(b.deadline) } : {}),
  });
}

type RelayMode = "swap" | "refund" | "refuse" | "unclear" | "alone" | "revert";

function makeDeps(
  chain: Chain,
  env: Env,
  opts: { mode?: RelayMode; onRelay?: (call: SwapRelayCall) => void; onTransfer?: () => void; refuseSplit?: boolean } = {}
) {
  const state = {
    mode: opts.mode ?? "swap",
    swaps: [] as SwapRelayCall[],
    transfers: 0,
    proofs: 0,
    splits: [] as { exec?: { args: readonly unknown[] } }[],
    /** A relay code each private send is refused with while set. */
    transferRefusal: null as string | null,
  };
  const prover = async () => {
    state.proofs++;
    return { proofBytes: PROOF };
  };
  const deps: Partial<ServerDeps> = {
    env,
    signer: () => null,
    publicClient: () => chain.client as unknown as Signer["publicClient"],
    shieldProver: async () => prover,
    transferProver: async () => prover,
    unshieldProver: async () => prover,
    syncTree: (async () => ({
      pathForCommitment: async (c: Hex) => (chain.index.has(lc(c)) ? chain.tree.path(chain.index.get(lc(c))!) : null),
    })) as unknown as ServerDeps["syncTree"],
    relayStatus: async () => [{ chainId: 4663, key: "robinhood-mainnet", enabled: true, relayer: null, memo: true, lowBalance: false }],
    // the split's private send, or a held note's move
    relay: async (intent) => {
      opts.onTransfer?.();
      state.transfers++;
      state.splits.push(intent);
      // the relay has the split's proof in hand from here on, whatever it answers
      if (opts.refuseSplit) throw new GloamRelayError("Too many requests from this device. Wait a few minutes.", "rate_limit");
      if (state.transferRefusal) throw new GloamRelayError("This payment is already being sent. Wait a moment and refresh.", state.transferRefusal);
      const [, , nullifier, outs] = intent.exec!.args as [Hex, Hex, Hex, Hex[]];
      chain.spent.add(lc(nullifier));
      for (const c of outs) await chain.insert(c);
      const h = chain.hash();
      chain.receipts.set(h, { status: "success", logs: [] });
      return h;
    },
    relaySwap: async (call) => {
      opts.onRelay?.(call);
      state.swaps.push(call);
      const b = call.body as Record<string, any>;
      if (call.action === "swapExit") {
        const h = chain.hash();
        chain.balances.set(`${lc(b.asset)}:${lc(escrowAddress(b.router, b.asset, b.key))}`, 0n);
        chain.receipts.set(h, { status: "success", logs: [] });
        return h;
      }
      if (b.unshieldTx) {
        // a refund: the money at the escrow goes back as the refund note
        await chain.insert(b.refund.commitment);
        chain.balances.set(`${lc(b.spend.asset)}:${lc(escrowOf(call))}`, 0n);
        const h = chain.hash();
        chain.receipts.set(h, { status: "success", logs: [] });
        return h;
      }
      if (state.mode === "refuse") throw new GloamRelayError("This swap route is not allowed.", "BadRoute");
      if (state.mode === "unclear") throw new GloamRelayError("No answer from the relay.", "maybe_sent");
      const h = chain.hash();
      if (state.mode === "alone") {
        chain.unshieldAlone(call, BigInt(b.spend.amount) - vaultFeeOf(BigInt(b.spend.amount), 25));
        chain.receipts.set(h, { status: "reverted", logs: [] });
        return h;
      }
      if (state.mode === "revert") {
        // it landed and reverted: nothing spent, nothing made, and its proofs are public now
        chain.receipts.set(h, { status: "reverted", logs: [] });
        return h;
      }
      chain.spent.add(lc(b.spend.nullifier));
      await chain.insert(state.mode === "refund" ? b.refund.commitment : b.deposit.commitment);
      chain.receipts.set(h, { status: "success", logs: [] });
      return h;
    },
  };
  return { deps, state };
}

const seen: string[] = [];
async function connect(deps: Partial<ServerDeps>) {
  const server = createGloamServer(deps);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "gloam-swap-test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args });
    const raw = (r.content as { type: string; text: string }[])[0]!.text;
    seen.push(raw);
    return JSON.parse(raw);
  };
}

const tmp = () => mkdtempSync(join(tmpdir(), "gloam-swaps-"));

function swapEnv(over: Env = {}): Env {
  const dir = tmp();
  return {
    GLOAM_AGENT_ID: "swapper",
    GLOAM_NOTE_KEY: "c3".repeat(32),
    GLOAM_NOTE_STORE: join(dir, "notes.json"),
    GLOAM_SPEND_LOG: join(dir, "log.json"),
    GLOAM_LIMIT_ASSETS: "USDG",
    GLOAM_LIMIT_NETWORK: "robinhood-mainnet",
    GLOAM_LIMIT_MAX_PER_PAYMENT: "1000",
    GLOAM_LIMIT_MAX_PER_DAY: "5000",
    GLOAM_LIMIT_RECIPIENTS: "any",
    GLOAM_LIMIT_TOOLS: "pay,swap",
    GLOAM_LIMIT_SWAP_TO: "GLOAM",
    ...over,
  };
}

/** A USDG note in this server's store and in the fake vault. */
async function keepNote(chain: Chain, env: Env, amount: bigint, asset: Address = RH_USDG, network = "robinhood-mainnet", chainId = 4663, symbol = "USDG") {
  const note = await chain.deposit(amount, asset);
  return openNoteStore(env).add({
    network: network as StoredNote["network"],
    chainId,
    pool: POOL,
    asset,
    symbol,
    decimals: 6,
    amountWei: amount.toString(),
    secret: note.secret as Hex,
    commitment: note.commitment as Hex,
    nullifier: note.nullifier as Hex,
    status: "unspent",
    origin: "shield",
    createdTx: null,
  });
}

const byOrigin = (env: Env, origin: StoredNote["origin"]) => openNoteStore(env).list().filter((n) => n.origin === origin);

test("the quote tool prices a swap, with what is public, and the network's stops", async () => {
  const chain = fakeChain(4663);
  const env = swapEnv();
  const call = await connect(makeDeps(chain, env).deps);
  const q = await call("gloam_swap_quote", { network: "robinhood-mainnet", from: "USDG", to: "GLOAM", amount: 100 });
  assert.equal(q.status, "ok", JSON.stringify(q));
  assert.equal(q.pay.amountWei, "100000000");
  assert.equal(q.vaultFee.bps, 25);
  assert.ok(BigInt(q.receive.amountWei) > 0n);
  assert.match(q.public, /hides who swapped/);
  assert.match(q.public, /amounts are public/);
  assert.match(q.spends, /one whole note/);
  // a note's whole value
  const n = await keepNote(chain, env, 250_000_000n);
  const byNote = await call("gloam_swap_quote", { network: "robinhood-mainnet", to: "GLOAM", note: n.handle });
  assert.equal(byNote.pay.amountWei, "250000000");
  // an asset the router doesn't swap
  const bad = await call("gloam_swap_quote", { network: "robinhood-mainnet", from: "USDG", to: "USDG", amount: 1 });
  assert.equal(bad.code, "same_asset");
});

test("a stop comes through the quote, and the same stop refuses the swap before any proof", async () => {
  const chain = fakeChain(4663);
  chain.closed.add(lc(RH_GLOAM));
  const env = swapEnv();
  const { deps, state } = makeDeps(chain, env);
  const call = await connect(deps);
  const q = await call("gloam_swap_quote", { network: "robinhood-mainnet", from: "USDG", to: "GLOAM", amount: 100 });
  assert.equal(q.status, "stopped");
  assert.equal(q.stop.code, "vault_closed");
  const n = await keepNote(chain, env, 100_000_000n);
  const r = await call("gloam_execute_private_swap", { network: "robinhood-mainnet", from: "USDG", to: "GLOAM", note: n.handle });
  assert.equal(r.status, "refused");
  assert.equal(r.stop.code, "vault_closed");
  assert.equal(state.proofs, 0);
  assert.equal(openNoteStore(env).get(n.handle)!.status, "unspent");
  // the relay's own state stops it too
  const off = makeDeps(fakeChain(4663), swapEnv());
  off.deps.relayStatus = async () => [{ chainId: 4663, key: "robinhood-mainnet", enabled: false, relayer: null, memo: true, lowBalance: true }];
  const q2 = await (await connect(off.deps))("gloam_swap_quote", { network: "robinhood-mainnet", from: "USDG", to: "GLOAM", amount: 100 });
  assert.equal(q2.stop.code, "relay_off");
});

test("a network with no swap router answers that swaps aren't live there", async () => {
  const chain = fakeChain(8453);
  const call = await connect(makeDeps(chain, swapEnv()).deps);
  for (const tool of ["gloam_swap_quote", "gloam_execute_private_swap"]) {
    const r = await call(tool, { network: "base-mainnet", from: "USDC", to: "USDT", amount: 5 });
    assert.equal(r.status, "not_live", tool);
    assert.match(r.message, /not live on Base mainnet/);
    assert.match(r.message, /Robinhood Chain mainnet/);
  }
});

test("a swap is refused by the limits unless the owner listed swap, before any proof", async () => {
  const chain = fakeChain(4663);
  const env = swapEnv({ GLOAM_LIMIT_TOOLS: undefined });
  const { deps, state } = makeDeps(chain, env);
  const call = await connect(deps);
  const n = await keepNote(chain, env, 100_000_000n);
  const r = await call("gloam_execute_private_swap", { network: "robinhood-mainnet", from: "USDG", to: "GLOAM", note: n.handle });
  assert.equal(r.status, "refused");
  assert.equal(r.code, "tool_not_allowed");
  assert.match(r.message, /list.*swap/);
  assert.equal(state.proofs, 0);
  assert.equal(state.swaps.length, 0);
  assert.equal(openNoteStore(env).get(n.handle)!.status, "unspent");
  // over the per-payment cap
  const env2 = swapEnv({ GLOAM_LIMIT_MAX_PER_PAYMENT: "50" });
  const two = makeDeps(chain, env2);
  const n2 = await keepNote(chain, env2, 100_000_000n);
  const r2 = await (await connect(two.deps))("gloam_execute_private_swap", { network: "robinhood-mainnet", from: "USDG", to: "GLOAM", note: n2.handle });
  assert.equal(r2.code, "over_per_payment");
  assert.equal(two.state.proofs, 0);
});

test("a swap keeps both new notes before the relay is called, then settles them as it landed", async () => {
  const chain = fakeChain(4663);
  const env = swapEnv();
  let atRelay: StoredNote[] = [];
  const { deps, state } = makeDeps(chain, env, { onRelay: () => (atRelay = openNoteStore(env).list()) });
  const call = await connect(deps);
  const n = await keepNote(chain, env, 100_000_000n);
  const r = await call("gloam_execute_private_swap", { network: "robinhood-mainnet", from: "USDG", to: "GLOAM", amount: 100 });
  assert.equal(r.status, "swapped", JSON.stringify(r));
  assert.equal(state.swaps.length, 1);
  assert.equal(state.swaps[0]!.action, "swap");
  // at the moment the relay was called
  const refundThen = atRelay.find((x) => x.origin === "swap_refund");
  const outThen = atRelay.find((x) => x.origin === "swap");
  assert.ok(refundThen && outThen, "both new notes were in the store when the relay was called");
  assert.equal(refundThen.status, "pending");
  assert.ok(refundThen.swap?.refund.secret, "the refund note keeps the swap's recovery record");
  assert.equal(outThen.swapPair, refundThen.handle);
  assert.equal(atRelay.find((x) => x.handle === n.handle)!.pending, "spend");
  // after it landed
  const store = openNoteStore(env);
  assert.equal(store.get(n.handle)!.status, "spent");
  assert.equal(store.get(outThen.handle)!.status, "unspent");
  assert.equal(store.get(refundThen.handle)!.status, "dead", "the refund note can't land now; its secret is kept");
  assert.equal(r.notes.newNote.status, "unspent");
  assert.equal(r.submittedBy.startsWith("gloam-relay"), true);
  // the balance counts the new note, not the refund note
  const list = await call("gloam_list_notes");
  const gloam = list.balances.find((b: { symbol: string }) => b.symbol === "GLOAM");
  assert.ok(gloam && gloam.spendable !== "0", JSON.stringify(list.balances));
  assert.ok(!list.balances.some((b: { symbol: string; spendable: string }) => b.symbol === "USDG" && b.spendable !== "0"));
  // the new note spent later: a refresh that looks at the dead refund note again leaves it spent
  store.update(outThen.handle, { status: "spent" });
  store.wakeDead();
  await call("gloam_list_notes", { refresh: true });
  assert.equal(openNoteStore(env).get(outThen.handle)!.status, "spent", "a spent note never comes back as spendable");
  assert.equal(openNoteStore(env).get(refundThen.handle)!.status, "dead");
});

test("a swap whose money came back as the refund note settles to it", async () => {
  const chain = fakeChain(4663);
  const env = swapEnv();
  const call = await connect(makeDeps(chain, env, { mode: "refund" }).deps);
  const n = await keepNote(chain, env, 100_000_000n);
  const r = await call("gloam_execute_private_swap", { network: "robinhood-mainnet", from: "USDG", to: "GLOAM", note: n.handle });
  assert.equal(r.status, "refunded", JSON.stringify(r));
  const [refund] = byOrigin(env, "swap_refund");
  const [out] = byOrigin(env, "swap");
  assert.equal(refund!.status, "unspent");
  assert.equal(out!.status, "dead");
  assert.equal(openNoteStore(env).get(n.handle)!.status, "spent");
});

test("a relay refusal keeps the refund note, and the swapped note is spendable again", async () => {
  const chain = fakeChain(4663);
  const env = swapEnv();
  const call = await connect(makeDeps(chain, env, { mode: "refuse" }).deps);
  const n = await keepNote(chain, env, 100_000_000n);
  const r = await call("gloam_execute_private_swap", { network: "robinhood-mainnet", from: "USDG", to: "GLOAM", note: n.handle });
  assert.equal(r.status, "refused");
  assert.equal(r.code, "BadRoute");
  const store = openNoteStore(env);
  const [refund] = byOrigin(env, "swap_refund");
  assert.ok(refund, "the refund note is never deleted once the relay has seen the proofs");
  assert.equal(refund.status, "dead");
  assert.ok(refund.swap?.refund.secret);
  assert.equal(byOrigin(env, "swap")[0]!.status, "dead");
  assert.equal(store.get(n.handle)!.status, "unspent");
  assert.equal(store.get(n.handle)!.recheck, true);
  // it never went out, so its proof isn't public: nothing is held or moved
  assert.equal(store.get(n.handle)!.moveFirst, undefined);
  assert.equal(r.move, undefined);
});

// ── a swap that reverts: its note moves to a fresh note before it is spendable again ──

const usdgBalance = (list: { balances: { symbol: string; spendable: string; held?: string }[] }) => list.balances.find((b) => b.symbol === "USDG");

test("a swap that reverts moves its note whole to a fresh note right away, kept before the move is sent", async () => {
  const chain = fakeChain(4663);
  const env = swapEnv();
  let atMove: StoredNote[] = [];
  const { deps, state } = makeDeps(chain, env, { mode: "revert", onTransfer: () => (atMove = openNoteStore(env).list()) });
  const call = await connect(deps);
  const n = await keepNote(chain, env, 100_000_000n);
  const r = await call("gloam_execute_private_swap", { network: "robinhood-mainnet", from: "USDG", to: "GLOAM", note: n.handle });
  assert.equal(r.status, "reverted", JSON.stringify(r));
  assert.match(r.outcome, /held and moves whole to a fresh note/);
  assert.equal(r.move.status, "moved", JSON.stringify(r.move));
  assert.equal(state.transfers, 1, "one private send moved the note");
  // the move spends the swapped note, whole, into one fresh note of this server's
  const [, , nullifier, outs] = state.splits[0]!.exec!.args as [Hex, Hex, Hex, Hex[]];
  assert.equal(lc(nullifier), lc(n.nullifier));
  const store = openNoteStore(env);
  const fresh = store.get(r.move.newNote.handle)!;
  assert.equal(fresh.amountWei, "100000000");
  assert.equal(lc(outs[0]!), lc(fresh.commitment));
  assert.equal(byOrigin(env, "change").length, 1, "no change note: the whole value moved");
  // the fresh note's secret was in the store before the move went out, and the note was taken for it
  const then = atMove.find((x) => x.handle === fresh.handle);
  assert.ok(then && then.status === "pending" && then.secret === fresh.secret, "the fresh note was kept before the move was sent");
  assert.equal(atMove.find((x) => x.handle === n.handle)!.pending, "spend");
  // the note is spent now, so the reverted swap's proof can't be used; the fresh note is spendable
  assert.ok(chain.spent.has(lc(n.nullifier)));
  assert.equal(store.get(n.handle)!.status, "spent");
  assert.equal(fresh.status, "unspent");
  const [refund] = byOrigin(env, "swap_refund");
  assert.equal(refund!.status, "dead");
  assert.ok(refund!.swap?.refund.secret, "the refund note is still kept");
  assert.equal(byOrigin(env, "swap")[0]!.status, "dead");
  const usdg = usdgBalance(await call("gloam_list_notes"));
  assert.equal(usdg?.spendable, "100");
  assert.equal(usdg?.held, undefined);
});

test("a failed move leaves the note held, never offered for a new swap, and a refresh tries it again", async () => {
  const chain = fakeChain(4663);
  const env = swapEnv();
  const { deps, state } = makeDeps(chain, env, { mode: "revert" });
  // the relay still holds the note for the swap that reverted
  state.transferRefusal = "in_flight";
  const call = await connect(deps);
  const n = await keepNote(chain, env, 100_000_000n);
  const r = await call("gloam_execute_private_swap", { network: "robinhood-mainnet", from: "USDG", to: "GLOAM", note: n.handle });
  assert.equal(r.status, "reverted", JSON.stringify(r));
  assert.equal(r.move.status, "held", JSON.stringify(r.move));
  assert.match(r.move.message, /do not use it in a new swap/);
  assert.match(r.move.message, /gloam_list_notes with refresh/);
  assert.equal(state.transfers, 1);
  let store = openNoteStore(env);
  assert.equal(store.get(n.handle)!.status, "unspent");
  assert.ok(store.get(n.handle)!.moveFirst, "held until it moves");
  assert.ok(!chain.spent.has(lc(n.nullifier)));
  // the relay has seen the move's proof: its fresh note stays kept (dead), secret and all
  const tried = byOrigin(env, "change");
  assert.equal(tried.length, 1);
  assert.equal(tried[0]!.status, "dead");
  assert.ok(tried[0]!.secret);

  // the agent sees it held, outside the spendable balance
  const list = await call("gloam_list_notes");
  const view = list.notes.find((x: { handle: string }) => x.handle === n.handle);
  assert.equal(view.status, "held");
  assert.match(view.held, /moves whole to a fresh note/);
  assert.equal(usdgBalance(list)?.spendable, "0");
  assert.equal(usdgBalance(list)?.held, "100");

  // never picked for a new swap, named or not, and nothing but its move takes it
  state.mode = "swap";
  const named = await call("gloam_execute_private_swap", { network: "robinhood-mainnet", from: "USDG", to: "GLOAM", note: n.handle });
  assert.equal(named.status, "error");
  assert.match(named.error, /is held/);
  const picked = await call("gloam_execute_private_swap", { network: "robinhood-mainnet", from: "USDG", to: "GLOAM", amount: 100 });
  assert.equal(picked.status, "error");
  assert.match(picked.error, /No single private note/);
  assert.equal(state.swaps.length, 1, "no second swap went out");
  assert.throws(() => openNoteStore(env).reserveForSpend(n.handle), /is held/);

  // a refresh right away waits: the next try is due a minute after the last
  state.transferRefusal = null;
  let refreshed = await call("gloam_list_notes", { refresh: true });
  assert.ok(refreshed.refreshed.some((s: string) => s.startsWith(n.handle) && /held until it moves/.test(s)), JSON.stringify(refreshed.refreshed));
  assert.equal(state.transfers, 1);
  assert.equal(openNoteStore(env).get(n.handle)!.status, "unspent");

  // a minute on, the refresh moves it
  const realNow = Date.now;
  Date.now = () => realNow() + 61_000;
  try {
    refreshed = await call("gloam_list_notes", { refresh: true });
  } finally {
    Date.now = realNow;
  }
  assert.equal(state.transfers, 2);
  assert.ok(refreshed.refreshed.some((s: string) => s.startsWith(n.handle) && /moved whole to a fresh note/.test(s)), JSON.stringify(refreshed.refreshed));
  store = openNoteStore(env);
  assert.equal(store.get(n.handle)!.status, "spent");
  assert.ok(chain.spent.has(lc(n.nullifier)));
  const moved = byOrigin(env, "change").filter((x) => x.status === "unspent");
  assert.equal(moved.length, 1);
  assert.equal(moved[0]!.amountWei, "100000000");
  assert.equal(usdgBalance(refreshed)?.spendable, "100");
  assert.equal(usdgBalance(refreshed)?.held, undefined);
});

test("a swap that lands, comes back as its refund note, or waits at its escrow moves nothing", async () => {
  for (const [mode, status] of [
    ["swap", "swapped"],
    ["refund", "refunded"],
    ["alone", "refund_ready"],
  ] as const) {
    const chain = fakeChain(4663);
    const env = swapEnv();
    const { deps, state } = makeDeps(chain, env, { mode });
    const call = await connect(deps);
    const n = await keepNote(chain, env, 100_000_000n);
    const r = await call("gloam_execute_private_swap", { network: "robinhood-mainnet", from: "USDG", to: "GLOAM", note: n.handle });
    assert.equal(r.status, status, JSON.stringify(r));
    assert.equal(r.move, undefined, mode);
    await call("gloam_list_notes", { refresh: true });
    assert.equal(state.transfers, 0, `${mode}: no private send`);
    assert.ok(!openNoteStore(env).list().some((x) => x.moveFirst), `${mode}: nothing held`);
    assert.deepEqual(byOrigin(env, "change"), [], mode);
    assert.equal(openNoteStore(env).get(n.handle)!.status, "spent", mode);
  }
});

test("a swap whose send got no clear answer and that shows nothing for an hour is held and moved", async () => {
  const chain = fakeChain(4663);
  const env = swapEnv();
  const { deps, state } = makeDeps(chain, env, { mode: "unclear" });
  const call = await connect(deps);
  const n = await keepNote(chain, env, 100_000_000n);
  const r = await call("gloam_execute_private_swap", { network: "robinhood-mainnet", from: "USDG", to: "GLOAM", note: n.handle });
  assert.equal(r.status, "error", JSON.stringify(r));
  // within the hour it may still land: nothing moves
  let list = await call("gloam_list_notes", { refresh: true });
  assert.ok(list.refreshed.some((s: string) => /still open/.test(s)), JSON.stringify(list.refreshed));
  assert.equal(state.transfers, 0);
  const realNow = Date.now;
  Date.now = () => realNow() + 61 * 60_000;
  try {
    list = await call("gloam_list_notes", { refresh: true });
  } finally {
    Date.now = realNow;
  }
  assert.ok(list.refreshed.some((s: string) => /showed nothing for an hour/.test(s)), JSON.stringify(list.refreshed));
  assert.ok(list.refreshed.some((s: string) => s.startsWith(n.handle) && /moved whole to a fresh note/.test(s)), JSON.stringify(list.refreshed));
  assert.equal(state.transfers, 1);
  assert.equal(openNoteStore(env).get(n.handle)!.status, "spent");
  assert.equal(byOrigin(env, "swap_refund")[0]!.status, "dead", "kept, in case the swap shows up after all");
});

test("an unclear relay answer keeps everything pending, and a refresh settles it from the chain", async () => {
  const chain = fakeChain(4663);
  const env = swapEnv();
  const { deps } = makeDeps(chain, env, { mode: "unclear" });
  const call = await connect(deps);
  const n = await keepNote(chain, env, 100_000_000n);
  const r = await call("gloam_execute_private_swap", { network: "robinhood-mainnet", from: "USDG", to: "GLOAM", note: n.handle });
  assert.equal(r.status, "error");
  assert.match(r.check, /refresh/);
  const [refund] = byOrigin(env, "swap_refund");
  const [out] = byOrigin(env, "swap");
  assert.equal(refund!.status, "pending");
  assert.equal(out!.status, "pending");
  assert.equal(openNoteStore(env).get(n.handle)!.pending, "spend");
  // still open on chain
  let list = await call("gloam_list_notes", { refresh: true });
  assert.ok(list.refreshed.some((s: string) => s.includes(refund!.handle) && /still open/.test(s)), JSON.stringify(list.refreshed));
  // it landed after all
  chain.spent.add(lc(n.nullifier));
  await chain.insert(out!.commitment);
  list = await call("gloam_list_notes", { refresh: true });
  assert.ok(list.refreshed.some((s: string) => /swapped/.test(s)), JSON.stringify(list.refreshed));
  const store = openNoteStore(env);
  assert.equal(store.get(out!.handle)!.status, "unspent");
  assert.equal(store.get(n.handle)!.status, "spent");
});

test("a larger note is split first, both halves kept before the send, then the exact note is swapped", async () => {
  const chain = fakeChain(4663);
  const env = swapEnv();
  const { deps, state } = makeDeps(chain, env);
  const call = await connect(deps);
  const n = await keepNote(chain, env, 500_000_000n);
  const r = await call("gloam_execute_private_swap", { network: "robinhood-mainnet", from: "USDG", to: "GLOAM", amount: 100 });
  assert.equal(r.status, "swapped", JSON.stringify(r));
  assert.equal(state.transfers, 1, "one private send set the amount aside");
  assert.equal((state.swaps[0]!.body as { spend: { amount: bigint } }).spend.amount, 100_000_000n, "the swap spends exactly the amount");
  assert.equal(r.notes.splitFrom, n.handle);
  const store = openNoteStore(env);
  assert.equal(store.get(n.handle)!.status, "spent");
  const change = store.list().find((x) => x.origin === "change" && x.amountWei === "400000000");
  assert.ok(change && change.status === "unspent", "the change is this server's, spendable");
  // the spend log counts the swap's value once
  const report = await call("gloam_get_spending_report");
  const usdg = report.today.find((t: { symbol: string }) => t.symbol === "USDG");
  assert.equal(usdg.spentToday, "100");
});

test("money waiting at a swap's escrow: refresh says so, and finish brings it back as the refund note", async () => {
  const chain = fakeChain(4663);
  const env = swapEnv();
  const call = await connect(makeDeps(chain, env, { mode: "alone" }).deps);
  const n = await keepNote(chain, env, 100_000_000n);
  const r = await call("gloam_execute_private_swap", { network: "robinhood-mainnet", from: "USDG", to: "GLOAM", note: n.handle });
  assert.equal(r.status, "refund_ready", JSON.stringify(r));
  assert.match(r.outcome, /gloam_finish_swap/);
  const [refund] = byOrigin(env, "swap_refund");
  const list = await call("gloam_list_notes", { refresh: true });
  assert.ok(list.refreshed.some((s: string) => s.includes(refund!.handle) && /gloam_finish_swap/.test(s)), JSON.stringify(list.refreshed));
  const done = await call("gloam_finish_swap", { note: refund!.handle });
  assert.equal(done.status, "refunded", JSON.stringify(done));
  assert.equal(openNoteStore(env).get(refund!.handle)!.status, "unspent");
  assert.equal(openNoteStore(env).get(n.handle)!.status, "spent");
});

test("an exit sends the waiting money only to an address the owner's limits allow", async () => {
  VAULT_SWAP_V3_LIVE[8453] = VAULT_SWAP_V3_ADDRESS[8453]!;
  try {
    const chain = fakeChain(8453);
    const ok = "0x00000000000000000000000000000000000000aa";
    const env = swapEnv({ GLOAM_LIMIT_ASSETS: "USDC", GLOAM_LIMIT_NETWORK: "base-mainnet", GLOAM_LIMIT_RECIPIENTS: ok, GLOAM_LIMIT_SWAP_TO: "USDT" });
    const { deps, state } = makeDeps(chain, env, { mode: "alone" });
    const call = await connect(deps);
    const n = await keepNote(chain, env, 100_000_000n, BASE_USDC, "base-mainnet", 8453, "USDC");
    const r = await call("gloam_execute_private_swap", { network: "base-mainnet", from: "USDC", to: "USDT", note: n.handle });
    assert.equal(r.status, "refund_ready", JSON.stringify(r));
    // the vault's fee rose to its highest before the unshield went alone: short of the refund note
    const call0 = state.swaps[0]!;
    const escrow = escrowOf(call0);
    chain.balances.set(`${lc(BASE_USDC)}:${lc(escrow)}`, 100_000_000n - 1_000_000n);
    const [refund] = byOrigin(env, "swap_refund");
    const need = await call("gloam_finish_swap", { note: refund!.handle });
    assert.equal(need.status, "needs_to");
    const blocked = await call("gloam_finish_swap", { note: refund!.handle, to: "0x00000000000000000000000000000000000000bb" });
    assert.equal(blocked.status, "refused");
    assert.equal(blocked.code, "recipient_not_allowed");
    assert.equal(state.swaps.length, 1, "nothing sent for a recipient the limits don't allow");
    const exit = await call("gloam_finish_swap", { note: refund!.handle, to: ok });
    assert.equal(exit.status, "exited", JSON.stringify(exit));
    assert.equal(state.swaps[1]!.action, "swapExit");
    assert.equal(openNoteStore(env).get(refund!.handle)!.status, "spent");
    void BASE_USDT;
  } finally {
    VAULT_SWAP_V3_LIVE[8453] = null;
  }
});

test("no tool result carries a note secret", () => {
  const all = seen.join("\n");
  for (const m of all.matchAll(/"secret"/g)) assert.fail(`a result named a secret field at ${m.index}`);
});

// ── what the owner allows a swap to buy, and the price impact it may take ──

test("a swap into an asset the owner didn't allow is refused before any proof", async () => {
  const chain = fakeChain(4663);
  // the agent's assets are USDG only, and no swapTo: a swap may only buy USDG
  const env = swapEnv({ GLOAM_LIMIT_SWAP_TO: undefined });
  const { deps, state } = makeDeps(chain, env);
  const call = await connect(deps);
  const n = await keepNote(chain, env, 100_000_000n);
  const r = await call("gloam_execute_private_swap", { network: "robinhood-mainnet", from: "USDG", to: "GLOAM", note: n.handle });
  assert.equal(r.status, "refused", JSON.stringify(r));
  assert.equal(r.code, "swap_to_not_allowed");
  assert.equal(state.proofs, 0, "nothing proved");
  assert.equal(state.swaps.length, 0, "nothing sent");
  assert.equal(openNoteStore(env).get(n.handle)!.status, "unspent");
  // an asset on the agent's list may be bought without swapTo (a limits file, as each asset has its own caps)
  const dir = tmp();
  const file = join(dir, "limits.json");
  const caps = { maxPerPayment: "1000", maxPerDay: "5000", network: "robinhood-mainnet" };
  writeFileSync(file, JSON.stringify({ agents: { swapper: { recipients: "any", tools: ["pay", "swap"], assets: { USDG: caps, GLOAM: caps } } } }));
  const env2: Env = { GLOAM_AGENT_ID: "swapper", GLOAM_NOTE_KEY: "c3".repeat(32), GLOAM_NOTE_STORE: join(dir, "notes.json"), GLOAM_SPEND_LOG: join(dir, "log.json"), GLOAM_LIMITS_FILE: file };
  const call2 = await connect(makeDeps(chain, env2).deps);
  const n2 = await keepNote(chain, env2, 100_000_000n);
  const ok = await call2("gloam_execute_private_swap", { network: "robinhood-mainnet", from: "USDG", to: "GLOAM", note: n2.handle });
  assert.equal(ok.status, "swapped", JSON.stringify(ok));
  // the limits report names what a swap may buy
  const limits = await call("gloam_get_limits");
  assert.equal(limits.swapTo, "the assets below");
  const limits2 = await (await connect(makeDeps(chain, swapEnv()).deps))("gloam_get_limits");
  assert.deepEqual(limits2.swapTo.map((a: { symbol: string }) => a.symbol), ["GLOAM"]);
});

/** A pool that pays a fair rate on a hundredth of the size and 1% of it at the full size. */
function thinPool(chain: Chain) {
  chain.client.multicall = (async ({ contracts }: { contracts: { functionName: string; args: [{ exactAmount: bigint }] }[] }) =>
    contracts.map((x) => {
      if (x.functionName === "allowedPool") return true;
      const a = x.args[0].exactAmount;
      return { status: "success", result: [a > 10_000_000n ? a / 100n : a, 0n] };
    })) as typeof chain.client.multicall;
}

test("price impact over 2% stops a swap on Robinhood Chain too; an agent can lower the cap, only the owner can raise it", async () => {
  const chain = fakeChain(4663);
  thinPool(chain);
  const env = swapEnv();
  const { deps, state } = makeDeps(chain, env);
  const call = await connect(deps);
  const n = await keepNote(chain, env, 1_000_000_000n);
  const q = await call("gloam_swap_quote", { network: "robinhood-mainnet", from: "USDG", to: "GLOAM", amount: 1000 });
  assert.equal(q.status, "stopped", JSON.stringify(q));
  assert.equal(q.stop.code, "too_thin");
  const r = await call("gloam_execute_private_swap", { network: "robinhood-mainnet", from: "USDG", to: "GLOAM", note: n.handle });
  assert.equal(r.status, "refused", JSON.stringify(r));
  assert.equal(r.stop.code, "too_thin");
  // the agent asking for more changes nothing
  const asked = await call("gloam_execute_private_swap", { network: "robinhood-mainnet", from: "USDG", to: "GLOAM", note: n.handle, maxImpactBps: 10_000 });
  assert.equal(asked.status, "refused", JSON.stringify(asked));
  assert.equal(state.proofs, 0);
  assert.equal(state.swaps.length, 0);
  assert.equal(openNoteStore(env).get(n.handle)!.status, "unspent");
  // the owner can raise it
  const ownerEnv = { ...env, GLOAM_SWAP_MAX_IMPACT_BPS: "10000" };
  const owner = await connect(makeDeps(chain, ownerEnv).deps);
  const done = await owner("gloam_execute_private_swap", { network: "robinhood-mainnet", from: "USDG", to: "GLOAM", note: n.handle });
  assert.equal(done.status, "swapped", JSON.stringify(done));
  // and a broken setting never loosens anything
  const broken = await (await connect(makeDeps(chain, { ...env, GLOAM_SWAP_MAX_IMPACT_BPS: "lots" }).deps))("gloam_swap_quote", {
    network: "robinhood-mainnet",
    from: "USDG",
    to: "GLOAM",
    amount: 1,
  });
  assert.equal(broken.status, "error");
  assert.match(broken.error, /GLOAM_SWAP_MAX_IMPACT_BPS/);
});

test("an agent's lower impact cap holds where the owner's would let a swap through", async () => {
  const chain = fakeChain(4663);
  // 1.5% impact: under the default 2%, over an asked 1%
  chain.client.multicall = (async ({ contracts }: { contracts: { functionName: string; args: [{ exactAmount: bigint }] }[] }) =>
    contracts.map((x) => {
      if (x.functionName === "allowedPool") return true;
      const a = x.args[0].exactAmount;
      return { status: "success", result: [a > 10_000_000n ? (a * 985n) / 1000n : a, 0n] };
    })) as typeof chain.client.multicall;
  const env = swapEnv();
  const call = await connect(makeDeps(chain, env).deps);
  const q = await call("gloam_swap_quote", { network: "robinhood-mainnet", from: "USDG", to: "GLOAM", amount: 1000 });
  assert.equal(q.status, "ok", JSON.stringify(q));
  const tight = await call("gloam_swap_quote", { network: "robinhood-mainnet", from: "USDG", to: "GLOAM", amount: 1000, maxImpactBps: 100 });
  assert.equal(tight.stop?.code, "too_thin");
});

// ── a swap whose refund can't land, and the spending log ──

test("with the vault full, finish takes the money out by the exit, counted once against the limits", async () => {
  VAULT_SWAP_V3_LIVE[8453] = VAULT_SWAP_V3_ADDRESS[8453]!;
  try {
    const chain = fakeChain(8453);
    const to = "0x00000000000000000000000000000000000000aa";
    const env = swapEnv({ GLOAM_LIMIT_ASSETS: "USDC", GLOAM_LIMIT_NETWORK: "base-mainnet", GLOAM_LIMIT_RECIPIENTS: to, GLOAM_LIMIT_SWAP_TO: "USDT" });
    const { deps, state } = makeDeps(chain, env, { mode: "alone" });
    const call = await connect(deps);
    const n = await keepNote(chain, env, 100_000_000n, BASE_USDC, "base-mainnet", 8453, "USDC");
    const r = await call("gloam_execute_private_swap", { network: "base-mainnet", from: "USDC", to: "USDT", note: n.handle });
    assert.equal(r.status, "refund_ready", JSON.stringify(r));
    // the vault's USDC total fills up while the money waits: the refund note can't land
    chain.full.add(lc(BASE_USDC));
    const [refund] = byOrigin(env, "swap_refund");
    const need = await call("gloam_finish_swap", { note: refund!.handle });
    assert.equal(need.status, "needs_to", JSON.stringify(need));
    assert.match(need.message, /no room/);
    const exit = await call("gloam_finish_swap", { note: refund!.handle, to });
    assert.equal(exit.status, "exited", JSON.stringify(exit));
    assert.equal(state.swaps.at(-1)!.action, "swapExit");
    // the swap counted 100 USDC; the exit pays out that same money and is not counted again
    const report = await call("gloam_get_spending_report", {});
    const usdc = report.today.find((t: { symbol: string }) => t.symbol === "USDC");
    assert.equal(usdc.spentToday, "100", JSON.stringify(report.today));
    assert.ok(report.recentPayments.some((e: { countedAgainstLimits?: boolean; recipient: string }) => e.countedAgainstLimits === false && e.recipient === to));
  } finally {
    VAULT_SWAP_V3_LIVE[8453] = null;
  }
});

test("a refused split keeps both new notes (dead) and the note is checked again, so a late landing is never lost", async () => {
  const chain = fakeChain(4663);
  const env = swapEnv();
  const { deps, state } = makeDeps(chain, env, { refuseSplit: true });
  const call = await connect(deps);
  const n = await keepNote(chain, env, 500_000_000n);
  const r = await call("gloam_execute_private_swap", { network: "robinhood-mainnet", from: "USDG", to: "GLOAM", amount: 100 });
  assert.equal(r.status, "error", JSON.stringify(r));
  assert.equal(state.splits.length, 1, "the relay was handed the split's proof");
  const made = byOrigin(env, "change");
  assert.deepEqual(made.map((x) => x.status).sort(), ["dead", "dead"], "both notes the split would make are kept, dead");
  assert.equal(openNoteStore(env).get(n.handle)!.status, "unspent");
  assert.equal(openNoteStore(env).get(n.handle)!.recheck, true);
  // the proof the relay was handed lands later after all
  const [, , nullifier, outs] = state.splits[0]!.exec!.args as [Hex, Hex, Hex, Hex[]];
  chain.spent.add(lc(nullifier));
  for (const c of outs) await chain.insert(c);
  await call("gloam_list_notes", { refresh: true });
  const after = openNoteStore(env);
  assert.equal(after.get(n.handle)!.status, "spent");
  assert.deepEqual(byOrigin(env, "change").map((x) => after.get(x.handle)!.status).sort(), ["unspent", "unspent"], "both notes it made are spendable");
});
