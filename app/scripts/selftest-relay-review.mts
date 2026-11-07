/**
 * Self-test: the relay fixes from the 7 November 2026 router review.
 *
 *  - R1: a swap's escrow is kept once its proofs pass the dry run, and from then on a
 *    plain cash out (now, scheduled, or sent later by the scheduled run) or an exit to
 *    that escrow is refused before anything is sent. A cash out of the same note to a
 *    wallet still goes, and a swap that failed its dry run keeps nothing
 *  - R2: a refund note follows the app's rule, not only the note's size: the note less 1%
 *    through v1 and v2, the note less the vault's fee now and 0.1% through v3, refused
 *    before the dry run otherwise. A v3 refund being finished may be up to what reached
 *    its escrow, and a fee that can't be read sends nothing
 *  - R3: one sender's sends that revert stop at its own share of the hourly cap, while
 *    its sends that land are never held back by it and other senders go on; scheduled
 *    cash outs hold as one sender against that share; the share is set by chain
 *  - R4: a spend's lock lives longer on Ethereum, and once it has expired a spend whose
 *    last send may still land is refused: one the node still holds, or something at its
 *    nonce in the node's pool, with or without a hash. One that landed, was dropped or
 *    was replaced is settled, and the spent check does the rest. A failed read sends nothing
 *
 * fetch is stubbed: the relay talks to an in-process fake chain, and the relay key is a
 * throwaway made here. Nothing reaches any host.
 *
 * Run from app/:  ../mcp/node_modules/.bin/tsx --tsconfig tsconfig.json scripts/selftest-relay-review.mts
 */
import assert from "node:assert/strict";
import { keccak256, pad, toEventSelector, toFunctionSelector, toHex, type Address, type Hex } from "viem";
import { generatePrivateKey } from "viem/accounts";

delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;
delete process.env.CHAINALYSIS_API_KEY;
process.env.GLOAM_RELAYER_PRIVATE_KEY = generatePrivateKey();

const {
  VAULT_SWAP_ROUTERS,
  VAULT_SWAP_V3_ADDRESS,
  VAULT_SWAP_V3_LIVE,
  BASE_SWAP_POOLS,
  SWAP_DEADLINE_SECONDS,
  encodeRoute,
  escrowAddress,
  refundAmountFor,
  routesBetween,
  swapRouterFor,
  UNSHIELDED_EVENT,
  vaultFeeOf,
} = await import("../src/lib/vaultSwap");
type PoolKey = import("../src/lib/vaultSwap").PoolKey;
const {
  CASH_OUT_TO_ESCROW_MESSAGE,
  REVERT_SHARE_MESSAGE,
  RelayError,
  checkUnshieldForLater,
  relayUnshield,
  relayVaultSwap,
  relayVaultSwapExit,
  resetSwapFloorReads,
  sendUnshieldNow,
} = await import("../src/lib/relay/server");
const { getNetwork } = await import("../src/lib/networks");
const { DEFAULT_INFLIGHT_TTL_SEC, INFLIGHT_TTL_SEC, inflightKey, inflightTtlSec, readSent } = await import("../src/lib/relay/inflight");
const { DEFAULT_REVERT_SHARE_PCT, SCHEDULED_SENDER, revertSharePct } = await import("../src/lib/relay/spendCap");

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  await fn();
  passed++;
  console.log(`ok  ${name}`);
}

const isCode = (code: string) => (e: unknown) => e instanceof RelayError && e.code === code;
const settled = () => new Promise((r) => setTimeout(r, 60));

// ---------------------------------------------------------------- fake chain

const SEL = {
  spent: toFunctionSelector("spent(bytes32)"),
  isKnownRoot: toFunctionSelector("isKnownRoot(bytes32)"),
  commitmentSeen: toFunctionSelector("commitmentSeen(bytes32)"),
  fee: toFunctionSelector("withdrawFeeBps()"),
  balanceOf: toFunctionSelector("balanceOf(address)"),
};
const word = (v: bigint | number | boolean) => `0x${BigInt(v).toString(16).padStart(64, "0")}`;
const Z32 = `0x${"00".repeat(32)}`;
const BLOCK = {
  number: "0x1", hash: `0x${"12".repeat(32)}`, parentHash: Z32, nonce: "0x0000000000000000", sha3Uncles: Z32, logsBloom: `0x${"00".repeat(256)}`,
  transactionsRoot: Z32, stateRoot: Z32, receiptsRoot: Z32, miner: `0x${"00".repeat(20)}`, difficulty: "0x0", totalDifficulty: "0x0", extraData: "0x",
  size: "0x1", gasLimit: "0x1c9c380", gasUsed: "0x0", timestamp: "0x1", baseFeePerGas: "0x1", transactions: [], uncles: [],
};

type Ending = "success" | "reverted" | "none";
const chain = {
  /** Nullifiers the vault has seen spent. */
  spent: new Set<string>(),
  gasPrice: 20_000_000n,
  dryRun: "ok" as "ok" | "revert",
  dryRunGas: 1_500_000n,
  gasUsed: 1_000_000n,
  /** How a new send ends: its receipt, or none yet. */
  next: "success" as Ending,
  /** What the vault's fee reads, in basis points. */
  feeBps: 50,
  /** What an escrow holds of the swap's asset. */
  held: 0n,
  /** The vault's fee can't be read. */
  feeDown: false,
  /** The relay account's mined and pending nonces. */
  mined: 0,
  pooled: 0,
  /** The node still holds a send that has no receipt. */
  nodeHas: true,
  /** eth_getTransactionByHash fails. */
  txReadFails: false,
  /** The next raw send gets "already known": the node may hold it, and no hash comes back. */
  sendMaybe: false,
};
/** The vault's payments to escrows the fake chain knows, by transaction hash. */
const paidTxs = new Map<string, { address: string; topics: string[]; data: string }[]>();
/** Each send's hash and how it ended. */
const sends: { hash: Hex; ending: Ending }[] = [];
/** The calldata of each eth_call, for asserting what was read. */
const reads: string[] = [];

type RpcReq = { id: number; method: string; params?: unknown[] };
function answer(r: RpcReq, chainId: number): unknown {
  switch (r.method) {
    case "eth_chainId":
      return toHex(chainId);
    case "eth_blockNumber":
      return "0x1";
    case "eth_getBlockByNumber":
      return { ...BLOCK, baseFeePerGas: toHex(chain.gasPrice) };
    case "eth_getTransactionCount":
      return toHex(r.params?.[1] === "latest" ? chain.mined : r.params?.[1] === "pending" ? chain.pooled : 0);
    case "eth_getTransactionByHash": {
      if (chain.txReadFails) throw new Error("fake chain: transaction read failed");
      const hash = String(r.params?.[0]);
      const s = sends.find((x) => x.hash === hash);
      if (!s || s.ending !== "none" || !chain.nodeHas) return null;
      return {
        hash, nonce: "0x0", blockHash: null, blockNumber: null, transactionIndex: null, from: `0x${"00".repeat(20)}`, to: `0x${"00".repeat(20)}`,
        value: "0x0", gas: "0x1", maxFeePerGas: "0x1", maxPriorityFeePerGas: "0x1", input: "0x", type: "0x2", chainId: toHex(chainId), accessList: [],
        v: "0x0", r: `0x${"01".repeat(32)}`, s: `0x${"01".repeat(32)}`, yParity: "0x0",
      };
    }
    case "eth_maxPriorityFeePerGas":
      return "0x1";
    case "eth_gasPrice":
      return toHex(chain.gasPrice);
    case "eth_getBalance":
      return toHex(10n ** 18n);
    case "eth_estimateGas":
      if (chain.dryRun === "revert") throw new Error("execution reverted");
      return toHex(chain.dryRunGas);
    case "eth_sendRawTransaction": {
      if (chain.sendMaybe) {
        chain.sendMaybe = false;
        sends.push({ hash: `0x${"ee".repeat(32)}`, ending: "none" });
        throw new Error("already known");
      }
      const hash = keccak256(toHex(`send-${sends.length}-${Date.now()}`));
      sends.push({ hash, ending: chain.next });
      return hash;
    }
    case "eth_getTransactionReceipt": {
      const hash = String(r.params?.[0]);
      const paid = paidTxs.get(hash);
      if (paid) {
        return {
          transactionHash: hash, transactionIndex: "0x0", blockHash: BLOCK.hash, blockNumber: "0x1", from: `0x${"00".repeat(20)}`, to: `0x${"00".repeat(20)}`,
          cumulativeGasUsed: "0x1", gasUsed: "0x1", effectiveGasPrice: "0x1", contractAddress: null, logsBloom: BLOCK.logsBloom, status: "0x1", type: "0x2",
          logs: paid.map((l, i) => ({ ...l, blockHash: BLOCK.hash, blockNumber: "0x1", logIndex: toHex(i), removed: false, transactionHash: hash, transactionIndex: "0x0" })),
        };
      }
      const s = sends.find((x) => x.hash === hash);
      if (!s || s.ending === "none") return null;
      return {
        transactionHash: hash, transactionIndex: "0x0", blockHash: BLOCK.hash, blockNumber: "0x1", from: `0x${"00".repeat(20)}`, to: `0x${"00".repeat(20)}`,
        cumulativeGasUsed: toHex(chain.gasUsed), gasUsed: toHex(chain.gasUsed), effectiveGasPrice: toHex(chain.gasPrice), contractAddress: null, logs: [],
        logsBloom: BLOCK.logsBloom, status: s.ending === "success" ? "0x1" : "0x0", type: "0x2",
      };
    }
    case "eth_call": {
      const call = r.params?.[0] as { data?: string; input?: string };
      const data = (call?.data ?? call?.input ?? "") as string;
      const sel = data.slice(0, 10);
      reads.push(data);
      if (sel === SEL.spent) return word(chain.spent.has(`0x${data.slice(10, 74)}`.toLowerCase()));
      if (sel === SEL.isKnownRoot) return word(true);
      if (sel === SEL.commitmentSeen) return word(false);
      if (sel === SEL.fee) {
        if (chain.feeDown) throw new Error("fake chain: fee read failed");
        return word(chain.feeBps);
      }
      if (sel === SEL.balanceOf) return word(chain.held);
      throw new Error(`fake chain: eth_call ${sel}`);
    }
    default:
      throw new Error(`fake chain: ${r.method}`);
  }
}
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  const chainId = url.includes("base") ? 8453 : url.includes("robinhood") ? 4663 : 1;
  const body = JSON.parse(String(init?.body));
  const one = (r: RpcReq) => {
    try {
      return { jsonrpc: "2.0", id: r.id, result: answer(r, chainId) };
    } catch (e) {
      return { jsonrpc: "2.0", id: r.id, error: { code: -32000, message: (e as Error).message } };
    }
  };
  return new Response(JSON.stringify(Array.isArray(body) ? body.map(one) : one(body)), { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;

function fresh() {
  sends.length = 0;
  reads.length = 0;
  chain.spent.clear();
  chain.gasPrice = 20_000_000n;
  chain.dryRun = "ok";
  chain.dryRunGas = 1_500_000n;
  chain.gasUsed = 1_000_000n;
  chain.next = "success";
  chain.feeBps = 50;
  chain.held = 0n;
  chain.feeDown = false;
  chain.mined = 0;
  chain.pooled = 0;
  chain.nodeHas = true;
  chain.txReadFails = false;
  chain.sendMaybe = false;
  paidTxs.clear();
  resetSwapFloorReads();
  for (const k of Object.keys(process.env)) if (k.startsWith("GLOAM_RELAY_")) delete process.env[k];
  (globalThis as { __gloamMcpRate?: Map<string, unknown> }).__gloamMcpRate?.clear();
}

// ---------------------------------------------------------------- bodies

const rh = getNetwork("robinhood-mainnet");
const base = getNetwork("base-mainnet");
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as Address;
const GLOAM = "0xDcD885F5c60b3aD49F6D58718696417314e8724d" as Address;
const B_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address;
const B_USDT = "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2" as Address;
const WALLET = "0x00000000000000000000000000000000000a11ce" as Address;
const proof = `0x${"11".repeat(256)}` as Hex;
const root = `0x${"22".repeat(32)}` as Hex;

const rhRouter = swapRouterFor(4663)!;
assert.ok(rhRouter && rhRouter.version !== 3, "Robinhood Chain swaps through v1 or v2 today");
const rhRoute = routesBetween(USDG, GLOAM, rhRouter, () => true)[0]!;
assert.ok(rhRoute, "a route from USDG to GLOAM");
const baseRoute = [BASE_SWAP_POOLS[2]!];

let nul = 0x100;
const h32 = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;

/** A swap on Robinhood Chain (v1 or v2: no exit key), as the app sends it. */
function rhSwap(amount = 20_000_000n, over: { refund?: bigint } = {}) {
  nul++;
  return {
    spend: { proof, root, nullifier: h32(nul), asset: USDG, amount: amount.toString() },
    deposit: { proof, commitment: h32(nul + 0x10000), asset: GLOAM, amount: "7000000000000000000" },
    refund: { proof, commitment: h32(nul + 0x20000), asset: USDG, amount: (over.refund ?? refundAmountFor(amount)).toString() },
    route: rhRoute,
  };
}

/** A swap on Base through v3 (exit key and deadline), as the app sends it. */
function baseSwap(amount = 100_000_000n, over: { refund?: bigint } = {}) {
  nul++;
  return {
    router: VAULT_SWAP_V3_ADDRESS[8453],
    spend: { proof, root, nullifier: h32(nul), asset: B_USDC, amount: amount.toString() },
    deposit: { proof, commitment: h32(nul + 0x10000), asset: B_USDT, amount: ((amount * 99n) / 100n).toString() },
    refund: { proof, commitment: h32(nul + 0x20000), asset: B_USDC, amount: (over.refund ?? refundAmountFor(amount, chain.feeBps)).toString() },
    route: baseRoute,
    exitKey: "0x00000000000000000000000000000000000e417e",
    deadline: String(Math.floor(Date.now() / 1000) + SWAP_DEADLINE_SECONDS),
  };
}

type AnySwap = ReturnType<typeof rhSwap> | ReturnType<typeof baseSwap>;
/** The escrow the relay works out for a swap body. */
function escrowOf(b: AnySwap, router: Address, route: readonly PoolKey[]): Address {
  const v3 = "exitKey" in b;
  return escrowAddress(router, b.spend.asset, {
    nullifier: b.spend.nullifier, amountIn: BigInt(b.spend.amount), outCommitment: b.deposit.commitment, assetOut: b.deposit.asset,
    amountOut: BigInt(b.deposit.amount), refundCommitment: b.refund.commitment, refundAmount: BigInt(b.refund.amount),
    routeHash: keccak256(encodeRoute(route)),
    ...(v3 ? { exitKey: (b as ReturnType<typeof baseSwap>).exitKey as Address, deadline: BigInt((b as ReturnType<typeof baseSwap>).deadline) } : {}),
  });
}

/** The swap's own unshield, handed to the relay alone as a cash out. */
function unshieldTo(b: AnySwap, to: Address) {
  return { proof, root, nullifier: b.spend.nullifier, asset: b.spend.asset, to, amount: b.spend.amount };
}

let cashN = 0;
function cashOut(to: Address = WALLET) {
  cashN++;
  return { proof, root, nullifier: h32(0xc0000 + cashN), asset: USDG, to, amount: "1000000" };
}

/** A receipt the fake chain will show: the vault paying this note out to `escrow`. */
function vaultPaid(nullifier: Hex, asset: Address, escrow: Address, amount: bigint, vault: string): Hex {
  const hash = keccak256(toHex(`unshield-${paidTxs.size}`));
  paidTxs.set(hash, [{ address: vault, topics: [toEventSelector(UNSHIELDED_EVENT), nullifier, pad(asset, { size: 32 }), pad(escrow, { size: 32 })], data: word(amount) }]);
  return hash;
}

// v3 on Base, for exits and v3 refund rules
VAULT_SWAP_V3_LIVE[8453] = VAULT_SWAP_V3_ADDRESS[8453]!;
VAULT_SWAP_ROUTERS[8453] = VAULT_SWAP_V3_ADDRESS[8453]!;

// ---------------------------------------------------------------- R1

await test("R1: once a swap went out, its unshield sent alone to its escrow is refused, now, scheduled and at send time", async () => {
  fresh();
  const swap = rhSwap();
  const escrow = escrowOf(swap, rhRouter.address, rhRoute);
  // before the swap, the escrow is just an address
  chain.next = "reverted";
  await relayVaultSwap(rh, swap);
  assert.equal(sends.length, 1);
  await settled();
  // the swap reverted, so its note is unspent and its lock is gone; its proofs are on chain now
  const refused = (e: unknown) => isCode("vault_recipient")(e) && (e as Error).message === CASH_OUT_TO_ESCROW_MESSAGE;
  await assert.rejects(relayUnshield(rh, unshieldTo(swap, escrow)), refused);
  await assert.rejects(checkUnshieldForLater(rh, unshieldTo(swap, escrow)), refused, "scheduling it is refused too");
  await assert.rejects(sendUnshieldNow(rh, unshieldTo(swap, escrow)), refused, "and a job that was scheduled before is refused when it comes due");
  await assert.rejects(relayUnshield(rh, unshieldTo(swap, escrow.toUpperCase().replace("0X", "0x") as Address)), refused, "whatever the case of the address");
  assert.equal(sends.length, 1, "nothing more went out");
  // the same note cashed out to a wallet still goes
  chain.next = "success";
  assert.equal(typeof (await relayUnshield(rh, unshieldTo(swap, WALLET))), "string");
  assert.equal(sends.length, 2);
});

await test("R1: a swap that fails its dry run keeps nothing, and cash outs to wallets are untouched", async () => {
  fresh();
  const swap = rhSwap();
  const escrow = escrowOf(swap, rhRouter.address, rhRoute);
  chain.dryRun = "revert";
  await assert.rejects(relayVaultSwap(rh, swap), isCode("check_failed"));
  chain.dryRun = "ok";
  assert.equal(sends.length, 0);
  // its proofs never left the relay: an address no swap went to is not refused
  assert.equal(typeof (await relayUnshield(rh, cashOut(escrow))), "string");
  for (let i = 0; i < 3; i++) assert.equal(typeof (await relayUnshield(rh, cashOut())), "string");
  assert.equal(sends.length, 4);
});

await test("R1: an exit to another swap's escrow is refused before it is checked", async () => {
  fresh();
  const other = baseSwap();
  const escrow = escrowOf(other, VAULT_SWAP_V3_ADDRESS[8453]!, baseRoute);
  await relayVaultSwap(base, other);
  assert.equal(sends.length, 1);
  const key = {
    nullifier: h32(++nul), amountIn: "100000000", outCommitment: h32(0x55), assetOut: B_USDT, amountOut: "1",
    refundCommitment: h32(0x77), refundAmount: "1", routeHash: h32(0x88), exitKey: "0x00000000000000000000000000000000000e417e", deadline: "1",
  };
  const exit = { router: VAULT_SWAP_V3_ADDRESS[8453], asset: B_USDC, to: escrow, signature: `0x${"aa".repeat(65)}`, key, unshieldTx: h32(0x99) };
  const before = reads.length;
  await assert.rejects(relayVaultSwapExit(base, exit), isCode("vault_recipient"));
  assert.equal(reads.length, before, "refused before anything was read");
  assert.equal(sends.length, 1);
});

// ---------------------------------------------------------------- R2

await test("R2: through v1 and v2 a refund note is at most the note less 1%", async () => {
  fresh();
  const amount = 20_000_000n;
  await assert.rejects(relayVaultSwap(rh, rhSwap(amount, { refund: refundAmountFor(amount) + 1n })), (e: unknown) => isCode("bad_request")(e) && (e as Error).message === "Invalid refund note.");
  await assert.rejects(relayVaultSwap(rh, rhSwap(amount, { refund: amount })), isCode("bad_request"), "the whole note, which the router alone would take");
  assert.equal(sends.length, 0, "refused before the dry run");
  assert.equal(typeof (await relayVaultSwap(rh, rhSwap(amount))), "string", "the app's own refund note goes");
  assert.equal(typeof (await relayVaultSwap(rh, rhSwap(amount, { refund: refundAmountFor(amount) - 5n }))), "string", "and a smaller one");
  assert.equal(sends.length, 2);
  assert.ok(!reads.some((d) => d.startsWith(SEL.fee)), "v1 and v2 never read the vault's fee");
});

await test("R2: through v3 a new swap's refund note is at most the note less the vault's fee now and 0.1%", async () => {
  fresh();
  const amount = 100_000_000n;
  chain.feeBps = 50;
  const most = refundAmountFor(amount, 50);
  assert.equal(most, amount - vaultFeeOf(amount, 50) - amount / 1_000n);
  await assert.rejects(relayVaultSwap(base, baseSwap(amount, { refund: most + 1n })), isCode("bad_request"));
  await assert.rejects(relayVaultSwap(base, baseSwap(amount, { refund: amount - vaultFeeOf(amount, 50) })), isCode("bad_request"), "without the 0.1%");
  assert.equal(sends.length, 0);
  assert.equal(typeof (await relayVaultSwap(base, baseSwap(amount, { refund: most }))), "string");
  // the fee came down: the rule follows it
  resetSwapFloorReads();
  chain.feeBps = 25;
  assert.equal(typeof (await relayVaultSwap(base, baseSwap(amount, { refund: refundAmountFor(amount, 25) }))), "string");
  assert.equal(sends.length, 2);
});

await test("R2: a v3 refund being finished may be up to what reached its escrow, never more", async () => {
  fresh();
  const amount = 100_000_000n;
  const vault = base.pool!;
  // made at a 25 bps fee, which has since gone up to 30: still within what reached the escrow
  const swap = baseSwap(amount, { refund: refundAmountFor(amount, 25) });
  chain.feeBps = 30;
  const escrow = escrowOf(swap, VAULT_SWAP_V3_ADDRESS[8453]!, baseRoute);
  chain.spent.add(swap.spend.nullifier.toLowerCase());
  chain.held = amount - vaultFeeOf(amount, 30);
  const unshieldTx = vaultPaid(swap.spend.nullifier, B_USDC, escrow, amount, vault);
  assert.equal(typeof (await relayVaultSwap(base, { ...swap, unshieldTx })), "string");
  // one past what reached the escrow is refused
  const over = baseSwap(amount, { refund: amount - vaultFeeOf(amount, 30) + 1n });
  chain.spent.add(over.spend.nullifier.toLowerCase());
  const overTx = vaultPaid(over.spend.nullifier, B_USDC, escrowOf(over, VAULT_SWAP_V3_ADDRESS[8453]!, baseRoute), amount, vault);
  await assert.rejects(relayVaultSwap(base, { ...over, unshieldTx: overTx }), isCode("bad_request"));
  assert.equal(sends.length, 1);
});

await test("R2: a vault fee that can't be read sends nothing", async () => {
  fresh();
  chain.feeDown = true;
  await assert.rejects(relayVaultSwap(base, baseSwap()), isCode("check_failed"));
  assert.equal(sends.length, 0);
});

// ---------------------------------------------------------------- R3

/** Sends until one is refused or `most` went, letting each receipt settle its holds. */
async function until(send: () => Promise<unknown>, most: number) {
  let sent = 0;
  for (; sent < most; sent++) {
    const r = await send().catch((e: unknown) => e);
    if (typeof r !== "string") return { sent, refused: (r as Error).message };
    await settled();
  }
  return { sent, refused: null as string | null };
}

/**
 * Robinhood Chain at 0.02 gwei with a 0.002 cap: a send holds 1.95M gas (39,000 gwei), and one
 * that reverts keeps the 1.5M it burned (30,000). 10% of the cap is 200,000 gwei, under 20 sends'
 * dry-run gas (600,000), so a sender's reverts stop after 19.
 */
function revertSetup() {
  fresh();
  process.env.GLOAM_RELAY_HOURLY_SPEND_4663 = "0.002";
  chain.gasUsed = 1_500_000n;
}

await test("R3: one sender's reverted sends stop at its own share; another sender still goes", async () => {
  revertSetup();
  chain.next = "reverted";
  const A = "198.51.100.31";
  const a = await until(() => relayUnshield(rh, cashOut(), A), 60);
  assert.deepEqual(a, { sent: 19, refused: REVERT_SHARE_MESSAGE });
  // the cap and the sender share are far from used up: the revert share stopped it
  assert.equal(typeof (await relayUnshield(rh, cashOut(), "198.51.100.32")), "string", "another IP still sends");
  // a partner account no admin approved shares its IP's share
  await assert.rejects(relayUnshield(rh, cashOut(), ["partner:ptr_new0001", A]), (e: unknown) => (e as Error).message === REVERT_SHARE_MESSAGE);
});

await test("R3: sends that land give their hold back, so a sender whose sends land is never stopped by it", async () => {
  revertSetup();
  chain.next = "success";
  const r = await until(() => relayUnshield(rh, cashOut(), "198.51.100.33"), 30);
  assert.deepEqual(r, { sent: 30, refused: null }, "half again what its reverts could use");
});

await test("R3: a send nobody saw land stays counted, as one that reverted", async () => {
  revertSetup();
  chain.next = "none";
  // each holds 39,001 gwei until a receipt shows: 15 fit under 600,000
  const r = await until(() => relayUnshield(rh, cashOut(), "198.51.100.36"), 30);
  assert.deepEqual(r, { sent: 15, refused: REVERT_SHARE_MESSAGE });
});

await test("R3: scheduled cash outs hold as one sender, so reverting jobs can't burn the cap", async () => {
  revertSetup();
  chain.next = "reverted";
  const jobs = await until(() => sendUnshieldNow(rh, cashOut()), 60);
  assert.deepEqual(jobs, { sent: 19, refused: REVERT_SHARE_MESSAGE });
  // the refusal is a spend_cap, which a scheduled job treats as "try again later"
  await assert.rejects(sendUnshieldNow(rh, cashOut()), isCode("spend_cap"));
  assert.equal(typeof (await relayUnshield(rh, cashOut(), "198.51.100.34")), "string", "a cash out sent now still goes");
  assert.equal(SCHEDULED_SENDER.includes(":"), false, "no colon: rate limit keys read one as IPv6");
});

await test("R3: the share is set by chain, or off", async () => {
  assert.equal(revertSharePct(4663, {}), DEFAULT_REVERT_SHARE_PCT);
  assert.equal(revertSharePct(4663, { GLOAM_RELAY_REVERT_SHARE_4663: "5" }), 5);
  assert.equal(revertSharePct(4663, { GLOAM_RELAY_REVERT_SHARE_4663: "off" }), null);
  assert.equal(revertSharePct(4663, { GLOAM_RELAY_REVERT_SHARE_4663: "lots" }), DEFAULT_REVERT_SHARE_PCT, "a value that isn't a number keeps the default");
  assert.equal(revertSharePct(4663, { GLOAM_RELAY_REVERT_SHARE_4663: "101" }), DEFAULT_REVERT_SHARE_PCT);
  // off: reverts are held only by the sender share and the cap
  revertSetup();
  process.env.GLOAM_RELAY_REVERT_SHARE_4663 = "off";
  chain.next = "reverted";
  const r = await until(() => relayUnshield(rh, cashOut(), "198.51.100.35"), 25);
  assert.deepEqual(r, { sent: 25, refused: null });
});

// ---------------------------------------------------------------- R4

const eth = getNetwork("ethereum-mainnet");
const E_USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as Address;
let ethN = 0;
function ethCashOut() {
  ethN++;
  return { proof, root, nullifier: h32(0xe0000 + ethN), asset: E_USDC, to: WALLET, amount: "1000000" };
}
/** fresh(), with a cash out's dry run as Ethereum sees one (its most is 1.2M). */
function ethFresh() {
  fresh();
  chain.dryRunGas = 300_000n;
}
/** The nonce a spend's last send carried, from the relay's record of it. */
async function nonceOf(chainId: number, nullifier: Hex): Promise<number> {
  const rec = await readSent(inflightKey(chainId, nullifier));
  assert.ok(rec, "the send is on record");
  return rec.nonce;
}
/** Every spend lock on a chain runs out, as if its time had passed. */
function expireLocks(chainId: number) {
  const m = (globalThis as { __gloamRelayInflight?: Map<string, unknown> }).__gloamRelayInflight;
  for (const k of [...(m?.keys() ?? [])]) if (k.startsWith(`gloam:relay:inflight:${chainId}:`)) m!.delete(k);
}

await test("R4: a spend's lock lives 15 minutes on Ethereum and 3 elsewhere, and is set by chain", () => {
  assert.equal(inflightTtlSec(1, {}), 900);
  assert.equal(DEFAULT_INFLIGHT_TTL_SEC[1], 900);
  assert.equal(inflightTtlSec(4663, {}), INFLIGHT_TTL_SEC);
  assert.equal(inflightTtlSec(8453, {}), 180);
  assert.equal(inflightTtlSec(1, { GLOAM_RELAY_INFLIGHT_TTL_1: "3600" }), 3600);
  assert.equal(inflightTtlSec(1, { GLOAM_RELAY_INFLIGHT_TTL_1: "5" }), 900, "too short keeps the default");
  assert.equal(inflightTtlSec(1, { GLOAM_RELAY_INFLIGHT_TTL_1: "soon" }), 900);
});

await test("R4: a send stuck in the node's pool is never sent again after its lock expires; once it lands, the spent check refuses the copy", async () => {
  ethFresh();
  chain.next = "none";
  const body = ethCashOut();
  await relayUnshield(eth, body);
  assert.equal(sends.length, 1);
  await assert.rejects(relayUnshield(eth, body), isCode("in_flight"), "the lock holds it");
  expireLocks(1);
  chain.pooled = (await nonceOf(1, body.nullifier)) + 1;
  await assert.rejects(relayUnshield(eth, body), isCode("in_flight"), "the node still has it: no second send");
  assert.equal(sends.length, 1);
  // it lands: the note is spent, and the copy is refused by the spent check
  sends[0]!.ending = "success";
  chain.spent.add(body.nullifier.toLowerCase());
  chain.mined = chain.pooled;
  expireLocks(1);
  await assert.rejects(relayUnshield(eth, body), isCode("AlreadySpent"));
  assert.equal(sends.length, 1);
});

await test("R4: a send that was dropped or replaced for good lets the spend go again", async () => {
  ethFresh();
  chain.next = "none";
  const dropped = ethCashOut();
  await relayUnshield(eth, dropped);
  expireLocks(1);
  // the node no longer has it, and nothing waits at its nonce
  chain.nodeHas = false;
  chain.next = "success";
  assert.equal(typeof (await relayUnshield(eth, dropped)), "string");
  assert.equal(sends.length, 2);

  chain.next = "none";
  chain.nodeHas = true;
  const replaced = ethCashOut();
  await relayUnshield(eth, replaced);
  expireLocks(1);
  chain.nodeHas = false;
  // something else waits at its nonce: refused
  const n = await nonceOf(1, replaced.nullifier);
  chain.pooled = n + 1;
  await assert.rejects(relayUnshield(eth, replaced), isCode("in_flight"));
  // that nonce was mined by another send: this one can never land
  chain.mined = n + 1;
  chain.next = "success";
  assert.equal(typeof (await relayUnshield(eth, replaced)), "string");
  assert.equal(sends.length, 4);
});

await test("R4: a send that may have gone out with no hash is checked by its nonce", async () => {
  ethFresh();
  const body = ethCashOut();
  chain.sendMaybe = true;
  await assert.rejects(relayUnshield(eth, body), isCode("maybe_sent"));
  expireLocks(1);
  const n = await nonceOf(1, body.nullifier);
  assert.equal((await readSent(inflightKey(1, body.nullifier)))?.hash, undefined, "no hash came back");
  chain.pooled = n + 1;
  await assert.rejects(relayUnshield(eth, body), isCode("in_flight"), "something waits at its nonce");
  chain.pooled = n;
  assert.equal(typeof (await relayUnshield(eth, body)), "string", "nothing at its nonce: the node never took it");
  assert.equal(sends.length, 2);
});

await test("R4: a reverted send leaves the spend free, and a failed read sends nothing", async () => {
  ethFresh();
  chain.next = "reverted";
  const body = ethCashOut();
  await relayUnshield(eth, body);
  await settled();
  chain.next = "success";
  assert.equal(typeof (await relayUnshield(eth, body)), "string", "the receipt shows the revert");
  assert.equal(sends.length, 2);

  chain.next = "none";
  const other = ethCashOut();
  await relayUnshield(eth, other);
  expireLocks(1);
  chain.txReadFails = true;
  await assert.rejects(relayUnshield(eth, other), isCode("check_failed"));
  assert.equal(sends.length, 3);
});

await test("R4: on a chain with no ceiling the same record holds a swap that is still pending", async () => {
  fresh();
  chain.next = "none";
  const swap = rhSwap();
  await relayVaultSwap(rh, swap);
  expireLocks(4663);
  chain.pooled = (await nonceOf(4663, swap.spend.nullifier)) + 1;
  await assert.rejects(relayVaultSwap(rh, swap), isCode("in_flight"));
  assert.equal(sends.length, 1);
});

console.log(`relay review: ${passed} passed`);
process.exit(0);
