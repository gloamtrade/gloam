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
  RelayError,
  checkUnshieldForLater,
  relayUnshield,
  relayVaultSwap,
  relayVaultSwapExit,
  resetSwapFloorReads,
  sendUnshieldNow,
} = await import("../src/lib/relay/server");
const { getNetwork } = await import("../src/lib/networks");

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
      return "0x0";
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
  paidTxs.clear();
  resetSwapFloorReads();
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

console.log(`relay review: ${passed} passed`);
process.exit(0);
