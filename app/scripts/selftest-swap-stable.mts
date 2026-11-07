/**
 * Self-test: stablecoin swaps on Base and Ethereum.
 *
 *  - the switch: nothing is on until a chain's router address is filled in, and only
 *    the pinned address turns it on
 *  - quotes on the two chains stop at a pool too thin for the size (and name a size that
 *    fits) and at a dollar pair far off a dollar for a dollar; Robinhood Chain and Tempo
 *    keep their rules, a price that moved your way passes, and a refused fresh quote
 *    keeps the one the person agreed to
 *  - every dollar stablecoin is 6 decimals on the chain it lists on, so a dollar pair can
 *    be weighed amount against amount; EURC is not a dollar
 *  - the floor: a swap on Ethereum must cover its gas with its vault fee, in numbers, and
 *    the relay refuses one that doesn't before it sends anything, with the price feed
 *    stale too; a refund never faces it, Base has none, and the status says what it is
 *  - a swap with its deadline about to pass is refused before the dry run
 *  - a refund and an exit go only for an escrow the vault paid, by the unshield's receipt
 *  - gas budgets on Ethereum: reverted swaps and refunds counted apart, by gas, held at send
 *    time, and one note or escrow waits alone. A refund or exit at or over the floor always goes
 *  - an hourly spend cap per chain, with the last of it kept for money coming back, and a
 *    lower limit per IP where gas is dear
 *  - an exit takes only a swap's assets, and each kind of send has a most gas
 *
 * fetch is stubbed: the relay talks to an in-process fake chain, and the relay key is a
 * throwaway made here. Nothing reaches any host.
 *
 * Run from app/:  ../mcp/node_modules/.bin/tsx --tsconfig tsconfig.json scripts/selftest-swap-stable.mts
 */
import assert from "node:assert/strict";
import { getAddress, keccak256, pad, parseUnits, toEventSelector, toFunctionSelector, toHex, type Address, type Hex } from "viem";
import { generatePrivateKey } from "viem/accounts";

delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;
delete process.env.CHAINALYSIS_API_KEY;
process.env.GLOAM_RELAYER_PRIVATE_KEY = generatePrivateKey();

const {
  BASE_SWAP_POOLS,
  DOLLARS,
  ETHEREUM_SWAP_POOLS,
  IMPACT_STOP_BPS,
  PEG_STOP_BPS,
  SWAP_DEADLINE_SECONDS,
  SWAP_OFF_PEG,
  SWAP_SEND_MARGIN_SECONDS,
  SWAP_TOO_THIN,
  SwapQuoteRefused,
  UNSHIELDED_EVENT,
  VALUE_STOP_BPS,
  VALUE_WARN_BPS,
  VAULT_SWAP_ROUTERS,
  VAULT_SWAP_V3_ADDRESS,
  VAULT_SWAP_V3_LIVE,
  encodeRoute,
  escrowAddress,
  escrowHolds,
  pegGapBps,
  maxSwapInForRefund,
  planVaultSwap,
  poolId,
  refundAmountFor,
  refundFits,
  replanVaultSwap,
  routesBetween,
  swapBufferBps,
  swapChecked,
  swapDeadlineSeconds,
  swapRouterFor,
  swapV3Live,
  valueGapBps,
  vaultFeeOf,
  vaultSwapRouter,
} = await import("../src/lib/vaultSwap");
const { FEED_MAX_AGE_SEC, SPLIT_GAS_UNITS, hasSwapFloor, smallestSwapUsd, swapFloorGas, swapFloorMessage, swapFloorShown, swapGasUnits } = await import("../src/lib/relay/swapFloor");
const { BACK_SHARE_MESSAGE, NOTE_WAIT_MESSAGE, RECEIPT_WATCH_WITHIN_MS, RelayError, SENDER_SHARE_MESSAGE, SPEND_CAP_MESSAGE, receiptWatchMs, SWAPS_PAUSED_MESSAGE, assertSwapWorthSending, checkChainRateLimit, relayMemo, relayStatus, relayTransfer, relayUnshield, relayVaultSwap, relayVaultSwapExit, resetSwapFloorReads, sendGasMost } = await import("../src/lib/relay/server");
const { hourlySpendWei, ipSendsLimit } = await import("../src/lib/relay/spendCap");
const { resetGasReads } = await import("../src/lib/relay/gasCeiling");
const { getNetwork } = await import("../src/lib/networks");
const { knownTokens } = await import("../src/lib/tokens");

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  await fn();
  passed++;
  console.log(`ok  ${name}`);
}

const NATIVE = "0x0000000000000000000000000000000000000000" as Address;
const E = {
  USDC: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  USDT: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
  USDG: "0xe343167631d89B6Ffc58B88d6b7fB0228795491D",
  EURC: "0x1aBaEA1f7C830bD89Acc67eC4af516284b1bC33c",
} as const;
const B = {
  USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  USDT: "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2",
  EURC: "0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42",
} as const;
const usd = (n: number) => parseUnits(String(n), 6);

function on(chainId: number) {
  VAULT_SWAP_V3_LIVE[chainId] = VAULT_SWAP_V3_ADDRESS[chainId]!;
  VAULT_SWAP_ROUTERS[chainId] = VAULT_SWAP_V3_ADDRESS[chainId]!;
}
function off(chainId: number) {
  VAULT_SWAP_V3_LIVE[chainId] = null;
  VAULT_SWAP_ROUTERS[chainId] = null;
}

/** Quotes as the V4Quoter gives them: `rate(amount, route)` out for one in, null where a route can't fill. */
function quotes(rate: (amount: bigint, hops: number) => number | null) {
  const out = (amount: bigint, hops: number) => {
    const r = rate(amount, hops);
    return r === null ? null : BigInt(Math.floor(Number(amount) * r));
  };
  return {
    multicall: async ({ contracts }: { contracts: { functionName: string; args: [{ exactAmount: bigint; path: unknown[] }] }[] }) => {
      if (contracts[0]?.functionName === "allowedPool") return contracts.map(() => true);
      return contracts.map((c) => {
        const o = out(c.args[0].exactAmount, c.args[0].path.length);
        return o === null ? { status: "failure" } : { status: "success", result: [o, 0n] };
      });
    },
    simulateContract: async ({ args }: { args: [{ exactAmount: bigint; path: unknown[] }] }) => {
      const a = args[0].exactAmount;
      const r = rate(a, args[0].path.length) ?? 1;
      return { result: [BigInt(Math.ceil(Number(a) / r))] };
    },
  } as never;
}

// ---------------------------------------------------------------- the switch

await test("nothing is on until a router address is filled in, and only the pinned one turns a chain on", () => {
  assert.deepEqual({ ...VAULT_SWAP_V3_LIVE }, { 4663: null, 8453: null, 1: null, 4217: null });
  assert.equal(vaultSwapRouter(8453), null);
  assert.equal(vaultSwapRouter(1), null);
  VAULT_SWAP_V3_LIVE[1] = "0x000000000000000000000000000000000000dEaD";
  assert.equal(swapV3Live(1), false, "a typo stays off");
  VAULT_SWAP_V3_LIVE[1] = VAULT_SWAP_V3_ADDRESS[1]!.toLowerCase() as Address;
  assert.equal(swapV3Live(1), true, "the pinned address, in any case");
  VAULT_SWAP_V3_LIVE[1] = null;
});

await test("every dollar stablecoin is 6 decimals, and EURC is not a dollar", () => {
  for (const a of DOLLARS) {
    const t = knownTokens().find((x) => x.address.toLowerCase() === a.toLowerCase());
    assert.equal(t?.decimals, 6, a);
  }
  assert.ok(!DOLLARS.some((d) => d.toLowerCase() === B.EURC.toLowerCase() || d.toLowerCase() === E.EURC.toLowerCase()));
  assert.equal(swapBufferBps(1, E.USDC, E.USDT), 10);
  assert.equal(swapBufferBps(1, E.USDT, E.USDG), 10);
  assert.equal(swapBufferBps(1, E.USDC, E.EURC), 50, "a euro pair moves");
  assert.equal(swapBufferBps(8453, B.USDC, B.USDT), 10);
  assert.equal(swapBufferBps(8453, B.USDT, B.EURC), 50);
});

await test("Ethereum's USDT to USDG goes through USDC as well as its thin direct pool", () => {
  on(1);
  const r = swapRouterFor(1)!;
  const routes = routesBetween(E.USDT, E.USDG, r);
  assert.ok(routes.some((x) => x.length === 1 && poolId(x[0]!) === poolId(ETHEREUM_SWAP_POOLS[10]!)), "direct");
  assert.ok(routes.some((x) => x.length === 2 && poolId(x[0]!) === poolId(ETHEREUM_SWAP_POOLS[4]!) && poolId(x[1]!) === poolId(ETHEREUM_SWAP_POOLS[8]!)), "through USDC");
  off(1);
});

// ---------------------------------------------------------------- quotes

const ask = (assetIn: Address, assetOut: Address, amountIn: bigint) => ({ assetIn, assetOut, amountIn, feeBps: 25 });

await test("a healthy dollar pair quotes, with its gap to a dollar", async () => {
  on(8453);
  const p = await planVaultSwap(quotes(() => 0.9991), 8453, ask(B.USDT, B.USDC, usd(1_000)));
  assert.equal(p.pegBps, 9);
  assert.equal(p.impactBps, 0);
  assert.equal(p.amountOut, (p.available * 9991n * 9990n) / 100_000_000n);
  assert.ok(p.cost <= p.available);
  off(8453);
});

await test("a price that pays more than a dollar passes", async () => {
  on(1);
  const p = await planVaultSwap(quotes(() => 1.05), 1, ask(E.USDC, E.USDT, usd(1_000)));
  assert.equal(p.pegBps, 0);
  off(1);
});

await test("a dollar pair past the stop is refused, whatever the size", async () => {
  on(1);
  await assert.rejects(
    planVaultSwap(quotes(() => 0.97), 1, ask(E.USDC, E.USDT, usd(100))),
    (e: unknown) => e instanceof SwapQuoteRefused && e.message === SWAP_OFF_PEG && e.fitsIn === null
  );
  assert.equal(pegGapBps(1_000_000n, 980_000n), PEG_STOP_BPS);
  const edge = await planVaultSwap(quotes(() => 0.9801), 1, ask(E.USDC, E.USDT, usd(100)));
  assert.ok(edge.pegBps! <= PEG_STOP_BPS, "at the stop, not past it");
  off(1);
});

await test("Base's EURC pool at $10,000: refused, and the error names a size that fits", async () => {
  on(8453);
  // the shape of the live pool on 2026-11-02: 1.114 small, 0.98 at $1,000, 0.129 at $10,000
  const rate = (a: bigint) => (a < usd(200) ? 1.114 : a < usd(1_000) ? 1.108 : a < usd(5_000) ? 0.98 : 0.129);
  await assert.rejects(planVaultSwap(quotes(rate), 8453, ask(B.EURC, B.USDC, usd(10_000))), (e: unknown) => {
    assert.ok(e instanceof SwapQuoteRefused, String(e));
    assert.equal(e.message, SWAP_TOO_THIN);
    assert.ok(e.fitsIn !== null && e.fitsIn > usd(150) && e.fitsIn < usd(1_000), `fits ${e.fitsIn}`);
    return true;
  });
  assert.ok(IMPACT_STOP_BPS < 300);
  off(8453);
});

await test("a route that can't fill at all is no quote", async () => {
  on(8453);
  await assert.rejects(planVaultSwap(quotes(() => null), 8453, ask(B.USDC, B.USDT, usd(100))), /No pool can fill/);
  off(8453);
});

await test("only Base and Ethereum are held to the stops", async () => {
  assert.ok(swapChecked(8453) && swapChecked(1));
  assert.ok(!swapChecked(4663) && !swapChecked(4217));
  const USDG: Address = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
  const GLOAM: Address = "0xDcD885F5c60b3aD49F6D58718696417314e8724d";
  const p = await planVaultSwap(quotes((a) => (a < usd(50) ? 0.5 : 0.3)), 4663, { ...ask(USDG, GLOAM, usd(1_000)), router: "0xfCa1887e77f738ef9C5751974b3f3873d029F2DC" });
  assert.ok(p.impactBps! > IMPACT_STOP_BPS, "a warning there, not a stop");
});

await test("a fresh quote that is refused keeps the one the person agreed to", async () => {
  on(1);
  const agreed = await planVaultSwap(quotes(() => 0.999), 1, ask(E.USDC, E.USDT, usd(1_000)));
  assert.equal(await replanVaultSwap(quotes(() => 0.9), 1, ask(E.USDC, E.USDT, usd(1_000)), agreed), agreed);
  off(1);
});

await test("a refund on Base and Ethereum is the note less the vault's fee and 0.1%", () => {
  assert.equal(refundAmountFor(usd(1_000)), usd(990), "elsewhere, the highest fee the vault allows");
  assert.equal(refundAmountFor(usd(1_000), 25), usd(1_000) - usd(2.5) - usd(1));
  assert.equal(refundAmountFor(usd(1_000), 50), usd(1_000) - usd(5) - usd(1));
  // never more than arrives, at any size and fee the vault allows
  for (const a of [1_000n, 1_001n, 999_999n, usd(1), usd(50_000), usd(50_000) + 7n]) {
    for (const bps of [0, 1, 25, 50, 100]) assert.ok(refundAmountFor(a, bps) <= a - vaultFeeOf(a, bps), `${a} at ${bps}`);
  }
});

await test("the most one swap may spend still fits its refund, at either margin", () => {
  const room = { perDeposit: usd(50_000), total: usd(2_500_000), deposited: usd(100_000) };
  for (const bps of [undefined, 0, 25, 50, 100]) {
    const most = maxSwapInForRefund(room, bps);
    assert.ok(refundAmountFor(most, bps) <= room.perDeposit, `${bps}`);
    assert.ok(refundAmountFor(most + 1n, bps) > room.perDeposit, `${bps}: the most, not less`);
    assert.ok(refundFits(room, most, bps));
    assert.ok(!refundFits(room, most + 1n, bps));
  }
  assert.ok(maxSwapInForRefund(room, 25) < maxSwapInForRefund(room), "a bigger refund, so a smaller swap");
});

await test("value against market prices, for pairs with no peg", () => {
  assert.equal(valueGapBps(100, 99), 100);
  assert.equal(valueGapBps(100, 101), 0);
  assert.equal(valueGapBps(0, 99), null);
  assert.ok(VALUE_WARN_BPS < VALUE_STOP_BPS);
  // a healthy euro swap at the 0.50% fee and 0.5% buffer stays under the warning
  assert.ok(valueGapBps(100, 98.9)! < VALUE_WARN_BPS);
});

// ---------------------------------------------------------------- the floor, in numbers

await test("the floor: gas against the vault fee", () => {
  assert.equal(swapGasUnits(1), 1_700_000n);
  assert.ok(swapGasUnits(3) > swapGasUnits(2) && swapGasUnits(2) > swapGasUnits(1));
  const gwei = (g: number) => BigInt(Math.round(g * 1e9));
  const at = (g: number, feeBps = 25, hops = 1) => smallestSwapUsd({ gasPriceWei: gwei(g), ethUsd: 2_290, feeBps, hops });
  assert.ok(Math.abs(at(0.037) - 57.6) < 0.2, `${at(0.037)}`);
  assert.ok(Math.abs(at(0.037, 50) - 28.8) < 0.1, "twice the fee, half the floor");
  assert.ok(Math.abs(at(1) - 1557) < 2);
  assert.ok(at(3) > 4_600 && at(3) < 4_700);
  assert.equal(smallestSwapUsd({ gasPriceWei: gwei(1), ethUsd: 2_290, feeBps: 0, hops: 1 }), Number.POSITIVE_INFINITY);
  assert.ok(Math.abs(swapFloorShown(100) - 110) < 1e-9);
  assert.equal(swapFloorGas(1, false), swapGasUnits(1), "the swap alone");
  assert.equal(swapFloorGas(2, true), swapGasUnits(2) + SPLIT_GAS_UNITS, "and the step that sets part of a note aside, which the app counts");
  assert.ok(!swapFloorMessage("Ethereum", 57.6).includes("—"), "no em dash");
  assert.ok(swapFloorMessage("Ethereum", 57.6).includes("$58"));
  assert.ok(hasSwapFloor(1) && !hasSwapFloor(8453) && !hasSwapFloor(4663) && !hasSwapFloor(4217));
});

// ---------------------------------------------------------------- the relay, on a fake chain

const net = getNetwork("ethereum-mainnet");
const base = getNetwork("base-mainnet");
const POOL = net.pool!;
const SEL = {
  spent: toFunctionSelector("spent(bytes32)"),
  isKnownRoot: toFunctionSelector("isKnownRoot(bytes32)"),
  commitmentSeen: toFunctionSelector("commitmentSeen(bytes32)"),
  fee: toFunctionSelector("withdrawFeeBps()"),
  round: toFunctionSelector("latestRoundData()"),
  balanceOf: toFunctionSelector("balanceOf(address)"),
};
const UNSHIELDED_TOPIC = toEventSelector(UNSHIELDED_EVENT);
const word = (v: bigint | number | boolean) => `0x${BigInt(v).toString(16).padStart(64, "0")}`;
const DRY_RUN_GAS = 1_700_000n;
const chain = {
  spent: false,
  gasPrice: 37_000_000n, // 0.037 gwei
  ethUsd: 2_290n * 10n ** 8n,
  feedAt: () => Math.floor(Date.now() / 1000) - 300,
  held: 0n,
  receipt: "success" as "success" | "reverted" | "none",
  gasUsed: 1_000_000n,
  dryRun: "ok" as "ok" | "revert",
  dryRunGas: DRY_RUN_GAS,
  seen: false,
  /** Base's fee for posting to Ethereum, in its receipts. */
  l1Fee: 0n,
};
/** The vault's payments to escrows the fake chain has seen, by transaction hash. */
const paidTxs = new Map<string, { status: string; logs: { address: string; topics: string[]; data: string }[] }>();
const sends: string[] = [];
const reads: string[] = [];
const Z32 = `0x${"00".repeat(32)}`;
const BLOCK = {
  number: "0x1", hash: `0x${"12".repeat(32)}`, parentHash: Z32, nonce: "0x0000000000000000", sha3Uncles: Z32, logsBloom: `0x${"00".repeat(256)}`,
  transactionsRoot: Z32, stateRoot: Z32, receiptsRoot: Z32, miner: `0x${"00".repeat(20)}`, difficulty: "0x0", totalDifficulty: "0x0", extraData: "0x",
  size: "0x1", gasLimit: "0x1c9c380", gasUsed: "0x0", timestamp: "0x1", baseFeePerGas: "0x1", transactions: [], uncles: [],
};
type RpcReq = { id: number; method: string; params?: ({ data?: string; input?: string; to?: string } | string)[] };
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
      const hash = keccak256(toHex(`send-${sends.length}`));
      sends.push(hash);
      return hash;
    }
    case "eth_getTransactionReceipt": {
      const hash = String(r.params?.[0]);
      const paid = paidTxs.get(hash);
      if (!paid && chain.receipt === "none") return null;
      const logs = (paid?.logs ?? []).map((l, i) => ({ ...l, blockHash: BLOCK.hash, blockNumber: "0x1", logIndex: toHex(i), removed: false, transactionHash: hash, transactionIndex: "0x0" }));
      return {
        transactionHash: hash, transactionIndex: "0x0", blockHash: BLOCK.hash, blockNumber: "0x1", from: `0x${"00".repeat(20)}`, to: POOL,
        cumulativeGasUsed: toHex(chain.gasUsed), gasUsed: toHex(chain.gasUsed), effectiveGasPrice: toHex(chain.gasPrice), contractAddress: null, logs, logsBloom: BLOCK.logsBloom,
        status: paid ? paid.status : chain.receipt === "success" ? "0x1" : "0x0", type: "0x2",
        ...(chainId === 8453 ? { l1Fee: toHex(chain.l1Fee) } : {}),
      };
    }
    case "eth_call": {
      const call = r.params?.[0] as { data?: string; input?: string };
      const data = (call?.data ?? call?.input ?? "") as string;
      const sel = data.slice(0, 10);
      reads.push(sel);
      if (sel === SEL.spent) return word(chain.spent);
      if (sel === SEL.isKnownRoot) return word(true);
      if (sel === SEL.commitmentSeen) return word(chain.seen);
      if (sel === SEL.fee) return word(25);
      if (sel === SEL.balanceOf) return word(chain.held);
      if (sel === SEL.round) return `0x${[1, chain.ethUsd, chain.feedAt(), chain.feedAt(), 1].map((v) => word(BigInt(v)).slice(2)).join("")}`;
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

let nul = 1;
const proof = `0x${"11".repeat(256)}`;
const deadline = () => BigInt(Math.floor(Date.now() / 1000) + SWAP_DEADLINE_SECONDS);
function swapBody(asset: Address, out: Address, amount: bigint, route: readonly unknown[], over: Record<string, unknown> = {}) {
  nul++;
  return {
    router: VAULT_SWAP_V3_ADDRESS[1],
    spend: { proof, root: `0x${"22".repeat(32)}`, nullifier: `0x${nul.toString(16).padStart(64, "0")}`, asset, amount: amount.toString() },
    deposit: { proof, commitment: `0x${(nul + 1000).toString(16).padStart(64, "0")}`, asset: out, amount: ((amount * 99n) / 100n || 1n).toString() },
    refund: { proof, commitment: `0x${(nul + 2000).toString(16).padStart(64, "0")}`, asset, amount: (amount - amount / 100n).toString() },
    route,
    exitKey: "0x00000000000000000000000000000000000e417e",
    deadline: deadline().toString(),
    ...over,
  };
}
const direct = [ETHEREUM_SWAP_POOLS[4]!];

/** What a swap body's escrow is, as the relay works it out. */
function escrowOf(b: ReturnType<typeof swapBody>, router: Address = VAULT_SWAP_V3_ADDRESS[1]!, route: readonly unknown[] = direct): Address {
  return escrowAddress(router, b.spend.asset as Address, {
    nullifier: b.spend.nullifier as Hex, amountIn: BigInt(b.spend.amount), outCommitment: b.deposit.commitment as Hex, assetOut: b.deposit.asset as Address,
    amountOut: BigInt(b.deposit.amount), refundCommitment: b.refund.commitment as Hex, refundAmount: BigInt(b.refund.amount),
    routeHash: keccak256(encodeRoute(route as typeof direct)), exitKey: b.exitKey as Address, deadline: BigInt(b.deadline as string),
  });
}

/** An Unshielded the fake chain will show in a receipt, for a transaction it now knows. */
function vaultPaid(nullifier: string, asset: string, to: string, amount: bigint, opts: { vault?: string; status?: string } = {}): Hex {
  const hash = keccak256(toHex(`unshield-${paidTxs.size}`));
  const topics = [UNSHIELDED_TOPIC, nullifier, pad(asset as Hex, { size: 32 }), pad(to as Hex, { size: 32 })];
  paidTxs.set(hash, { status: opts.status ?? "0x1", logs: [{ address: opts.vault ?? POOL, topics, data: word(amount) }] });
  return hash;
}

/** A refund the relay would send: the note spent, the money at its escrow, and the vault's payment on record. */
function refundBody(amount: bigint) {
  const b = swapBody(E.USDC, E.USDT, amount, direct);
  return { ...b, unshieldTx: vaultPaid(b.spend.nullifier, b.spend.asset, escrowOf(b), amount) };
}

const settled = () => new Promise((r) => setTimeout(r, 40));
const isCode = (code: string) => (e: unknown) => e instanceof RelayError && e.code === code;
function fresh() {
  sends.length = 0;
  reads.length = 0;
  chain.spent = false;
  chain.gasPrice = 37_000_000n;
  chain.held = 0n;
  chain.feedAt = () => Math.floor(Date.now() / 1000) - 300;
  chain.receipt = "success";
  chain.gasUsed = 1_000_000n;
  chain.dryRun = "ok";
  chain.dryRunGas = DRY_RUN_GAS;
  chain.seen = false;
  chain.l1Fee = 0n;
  paidTxs.clear();
  (globalThis as { __gloamMcpRate?: Map<string, unknown> }).__gloamMcpRate?.clear();
  delete process.env.GLOAM_RELAY_HOURLY_SPEND_1;
  delete process.env.GLOAM_RELAY_HOURLY_SPEND_8453;
  delete process.env.GLOAM_RELAY_IP_SENDS_1;
  delete process.env.GLOAM_RELAY_SENDER_SHARE_1;
  resetSwapFloorReads();
  resetGasReads();
}

on(1);
on(8453);

await test("a $100 swap at 0.037 gwei goes out; $20 is refused before anything is sent", async () => {
  fresh();
  const hash = await relayVaultSwap(net, swapBody(E.USDC, E.USDT, usd(100), direct));
  assert.ok(hash.startsWith("0x"));
  assert.equal(sends.length, 1);
  sends.length = 0;
  await assert.rejects(relayVaultSwap(net, swapBody(E.USDC, E.USDT, usd(20), direct)), isCode("swap_small"));
  assert.equal(sends.length, 0, "nothing sent");
});

await test("the floor moves with gas: at 1 gwei $100 waits and $2,000 goes", async () => {
  fresh();
  chain.gasPrice = 1_000_000_000n;
  await assert.rejects(relayVaultSwap(net, swapBody(E.USDC, E.USDT, usd(100), direct)), isCode("swap_small"));
  assert.equal(sends.length, 0);
  await relayVaultSwap(net, swapBody(E.USDC, E.USDT, usd(2_000), direct));
  assert.equal(sends.length, 1);
});

await test("each hop costs more: a size that clears one hop can miss on three", async () => {
  fresh();
  const hops = (h: number) => smallestSwapUsd({ gasPriceWei: chain.gasPrice, ethUsd: 2_290, feeBps: 25, hops: h });
  const size = usd(Math.ceil(hops(1)) + 1);
  assert.ok(Number(size) / 1e6 < hops(3));
  await assert.doesNotReject(assertSwapWorthSending(net, { asset: E.USDC, amount: size }, 1));
  await assert.rejects(assertSwapWorthSending(net, { asset: E.USDC, amount: size }, 3), isCode("swap_small"));
});

await test("an ETH note is weighed at the feed's price, EURC at face value", async () => {
  fresh();
  await assert.doesNotReject(assertSwapWorthSending(net, { asset: NATIVE, amount: parseUnits("0.05", 18) }, 1));
  await assert.rejects(assertSwapWorthSending(net, { asset: NATIVE, amount: parseUnits("0.01", 18) }, 1), isCode("swap_small"));
  await assert.doesNotReject(assertSwapWorthSending(net, { asset: E.EURC, amount: usd(60) }, 1));
  await assert.rejects(assertSwapWorthSending(net, { asset: E.EURC, amount: usd(50) }, 1), isCode("swap_small"));
});

await test("a stale or broken price feed refuses the swap rather than paying blind", async () => {
  fresh();
  chain.feedAt = () => Math.floor(Date.now() / 1000) - FEED_MAX_AGE_SEC - 60;
  await assert.rejects(assertSwapWorthSending(net, { asset: E.USDC, amount: usd(50_000) }, 1), isCode("check_failed"));
  fresh();
  const was = chain.ethUsd;
  chain.ethUsd = 0n;
  await assert.rejects(assertSwapWorthSending(net, { asset: E.USDC, amount: usd(50_000) }, 1), isCode("check_failed"));
  chain.ethUsd = was;
});

await test("a refund under the floor still goes, while its budget lasts", async () => {
  fresh();
  chain.spent = true;
  chain.held = usd(10);
  await relayVaultSwap(net, refundBody(usd(10)));
  assert.equal(sends.length, 1);
});

await test("a swap with its deadline about to pass is refused before the dry run", async () => {
  fresh();
  const soon = BigInt(Math.floor(Date.now() / 1000) + SWAP_SEND_MARGIN_SECONDS - 5);
  await assert.rejects(relayVaultSwap(net, swapBody(E.USDC, E.USDT, usd(100), direct, { deadline: soon.toString() })), isCode("SwapExpired"));
  assert.equal(sends.length, 0);
  const late = BigInt(Math.floor(Date.now() / 1000) + SWAP_SEND_MARGIN_SECONDS + 30);
  await relayVaultSwap(net, swapBody(E.USDC, E.USDT, usd(100), direct, { deadline: late.toString() }));
  assert.equal(sends.length, 1);
  // a refund never has a deadline
  fresh();
  chain.spent = true;
  chain.held = usd(100);
  const old = swapBody(E.USDC, E.USDT, usd(100), direct, { deadline: "1" });
  await relayVaultSwap(net, { ...old, unshieldTx: vaultPaid(old.spend.nullifier, old.spend.asset, escrowOf(old), usd(100)) });
  assert.equal(sends.length, 1, "a refund of a swap long past its deadline");
});

await test("Base has no floor: a $1 swap goes out and the feed is never read", async () => {
  fresh();
  const hash = await relayVaultSwap(base, { ...swapBody(B.USDC, B.USDT, usd(1), [BASE_SWAP_POOLS[2]!]), router: VAULT_SWAP_V3_ADDRESS[8453] });
  assert.ok(hash.startsWith("0x"));
  assert.ok(!reads.includes(SEL.round));
  // the vault's fee is read once, for the refund note's rule (selftest-relay-review), never for a floor
  assert.equal(reads.filter((r) => r === SEL.fee).length, 1);
});

await test("the relay's status names the floor on Ethereum and nowhere else", async () => {
  fresh();
  const all = await relayStatus();
  const eth = all.find((n) => n.chainId === 1)!;
  assert.ok(eth.swapFloorUsd != null && Math.abs(eth.swapFloorUsd - 57.6) < 0.5, `${eth.swapFloorUsd}`);
  assert.equal(all.find((n) => n.chainId === 8453)!.swapFloorUsd, null);
  off(1);
  fresh();
  const offNow = await relayStatus();
  assert.equal(offNow.find((n) => n.chainId === 1)!.swapFloorUsd, null, "no router, no floor, no reads");
  assert.ok(!reads.includes(SEL.round));
  on(1);
});

await test("a refund or an exit goes only for an escrow the vault paid", async () => {
  fresh();
  chain.spent = true;
  chain.held = usd(100);
  const code = "unshield_tx";
  const asked = swapBody(E.USDC, E.USDT, usd(100), direct);
  const escrow = escrowOf(asked);
  const { nullifier, asset } = asked.spend;
  const wrong: [string, Hex][] = [
    ["another escrow", vaultPaid(nullifier, asset, "0x00000000000000000000000000000000000e5c20", usd(100))],
    ["another amount", vaultPaid(nullifier, asset, escrow, usd(99))],
    ["another note", vaultPaid(`0x${"99".repeat(32)}`, asset, escrow, usd(100))],
    ["another asset", vaultPaid(nullifier, E.USDT, escrow, usd(100))],
    ["another contract's log", vaultPaid(nullifier, asset, escrow, usd(100), { vault: "0x00000000000000000000000000000000000bad00" })],
    ["a reverted transaction", vaultPaid(nullifier, asset, escrow, usd(100), { status: "0x0" })],
    ["a hash the chain doesn't have", `0x${"77".repeat(32)}`],
  ];
  await assert.rejects(relayVaultSwap(net, asked), isCode(code), "none named: a tab from before this");
  for (const [what, unshieldTx] of wrong) await assert.rejects(relayVaultSwap(net, { ...asked, unshieldTx }), isCode(code), what);
  assert.equal(sends.length, 0);
  await relayVaultSwap(net, { ...asked, unshieldTx: vaultPaid(nullifier, asset, escrow, usd(100)) });
  assert.equal(sends.length, 1);
});

await test("reverted swaps count by gas, apart from refunds, and past the budget new swaps pause, on Ethereum only", async () => {
  fresh();
  chain.receipt = "reverted";
  chain.gasUsed = 5_500_000n;
  for (let i = 0; i < 4; i++) {
    await relayVaultSwap(net, swapBody(E.USDC, E.USDT, usd(1_000), direct));
    await settled();
  }
  await assert.rejects(relayVaultSwap(net, swapBody(E.USDC, E.USDT, usd(1_000), direct)), (e: unknown) => isCode("swaps_paused")(e) && (e as Error).message === SWAPS_PAUSED_MESSAGE);
  assert.equal(sends.length, 4);
  // refunds have their own count: these were swaps, so money waiting still goes
  chain.spent = true;
  chain.held = usd(10);
  await relayVaultSwap(net, refundBody(usd(10)));
  assert.equal(sends.length, 5);
  chain.spent = false;
  await relayVaultSwap(base, { ...swapBody(B.USDC, B.USDT, usd(1), [BASE_SWAP_POOLS[2]!]), router: VAULT_SWAP_V3_ADDRESS[8453] });
  assert.equal(sends.length, 6, "Base has no such budget");
});

await test("a swap that lands gives its gas back, and one nobody saw land stays held", async () => {
  fresh();
  chain.receipt = "success";
  for (let i = 0; i < 20; i++) {
    await relayVaultSwap(net, swapBody(E.USDC, E.USDT, usd(1_000), direct));
    await settled();
  }
  assert.equal(sends.length, 20, "far past the budget's size, as every one gave its hold back");
  fresh();
  chain.receipt = "none"; // sent, no receipt: 2.21M gas each, held
  let sent = 0;
  for (let i = 0; i < 12; i++) {
    const r = await relayVaultSwap(net, swapBody(E.USDC, E.USDT, usd(1_000), direct)).catch((e) => e);
    if (typeof r === "string") sent++;
    else assert.ok(isCode("swaps_paused")(r), String(r));
  }
  assert.equal(sent, 9, "held at send time: a burst stops at the budget, with no receipt read");
});

await test("one note reverting again waits by itself, and doesn't stop anyone else", async () => {
  fresh();
  chain.receipt = "reverted";
  const once = swapBody(E.USDC, E.USDT, usd(1_000), direct);
  const again = (i: number) => ({ ...swapBody(E.USDC, E.USDT, usd(1_000), direct), spend: once.spend, _: i });
  for (let i = 0; i < 2; i++) {
    await relayVaultSwap(net, again(i));
    await settled();
  }
  await assert.rejects(relayVaultSwap(net, again(3)), (e: unknown) => isCode("note_wait")(e) && (e as Error).message === NOTE_WAIT_MESSAGE);
  assert.equal(sends.length, 2);
  await relayVaultSwap(net, swapBody(E.USDC, E.USDT, usd(1_000), direct));
  assert.equal(sends.length, 3, "another note goes");
});

await test("a refund under the floor spends from a budget of its own; one that fails its dry run costs none, and one over the floor always goes", async () => {
  fresh();
  chain.spent = true;
  chain.held = usd(10);
  chain.dryRun = "revert";
  for (let i = 0; i < 40; i++) await assert.rejects(relayVaultSwap(net, refundBody(usd(10))), RelayError);
  chain.dryRun = "ok";
  assert.equal(sends.length, 0, "and none of that was counted");
  chain.gasUsed = 2_000_000n;
  let refused = 0;
  for (let i = 0; i < 20; i++) {
    await relayVaultSwap(net, refundBody(usd(10))).catch((e) => {
      assert.ok(isCode("swaps_paused")(e), String(e));
      refused++;
    });
    await settled();
  }
  assert.ok(refused > 0 && sends.length === 20 - refused, "the budget held");
  const went = sends.length;
  chain.held = usd(1_000);
  await relayVaultSwap(net, refundBody(usd(1_000)));
  assert.equal(sends.length, went + 1, "at or over the floor it goes regardless");
});

await test("a refund locks on its escrow", async () => {
  fresh();
  chain.spent = true;
  chain.held = usd(1_000);
  const mine = refundBody(usd(1_000));
  // the same nullifier under another escrow
  const other = swapBody(E.USDC, E.USDT, usd(1_000), direct, { spend: mine.spend });
  const theirs = { ...other, unshieldTx: vaultPaid(mine.spend.nullifier, mine.spend.asset, escrowOf(other), usd(1_000)) };
  chain.receipt = "none"; // both still out, so both locks stay held
  await relayVaultSwap(net, theirs);
  await relayVaultSwap(net, mine);
  assert.equal(sends.length, 2, "two escrows, two locks");
  await assert.rejects(relayVaultSwap(net, mine), isCode("in_flight"));
});

await test("the hourly spend cap: new sends stop short of it, money coming back gets the rest, a hold is given back", async () => {
  fresh();
  // about 0.0444 gwei offered on a 2.21M gas limit: 0.000098 held a send, of which 0.000037 stays once it lands
  process.env.GLOAM_RELAY_HOURLY_SPEND_1 = "0.0003";
  chain.receipt = "none";
  let sent = 0;
  for (let i = 0; i < 6; i++) {
    const r = await relayVaultSwap(net, swapBody(E.USDC, E.USDT, usd(1_000), direct)).catch((e) => e);
    if (typeof r === "string") sent++;
    else assert.ok(isCode("spend_cap")(r) && (r as Error).message === SPEND_CAP_MESSAGE, String(r));
  }
  assert.equal(sent, 2, "new sends stop at 80% of the cap: 0.00024 here, and a third would pass it");
  const n = sends.length;
  chain.spent = true;
  chain.held = usd(1_000);
  await relayVaultSwap(net, refundBody(usd(1_000)));
  assert.equal(sends.length, n + 1, "a refund uses what is kept for it");
  await assert.rejects(relayVaultSwap(net, refundBody(usd(1_000))), isCode("spend_cap"), "and that has an end too");
  // any kind of send, and the status stays up
  chain.spent = false;
  await assert.rejects(relayTransfer(net, { proof, root: `0x${"22".repeat(32)}`, nullifier: `0x${"ee".repeat(32)}`, commitments: [`0x${"e1".repeat(32)}`, `0x${"e2".repeat(32)}`] }), isCode("spend_cap"));
  fresh();
  process.env.GLOAM_RELAY_HOURLY_SPEND_1 = "0.0005";
  chain.receipt = "success";
  chain.gasUsed = 1_000_000n;
  sent = 0;
  for (let i = 0; i < 6; i++) {
    await relayVaultSwap(net, swapBody(E.USDC, E.USDT, usd(1_000), direct)).then(() => sent++, () => {});
    await settled();
  }
  assert.equal(sent, 6, "what a send didn't use comes back: 0.000037 each, not 0.000098");
});

await test("amounts held in the shared store add, come back, and fail closed", async () => {
  const { SharedCountUnavailable, addRateCount, readRateLimit } = await import("../src/lib/mcpRemote/rateLimit");
  const store = new Map<string, number>();
  let up = true;
  const real = globalThis.fetch;
  globalThis.fetch = (async (_u: string | URL | Request, init?: RequestInit) => {
    if (!up) throw new Error("connection dropped");
    const cmds = JSON.parse(String(init?.body)) as (string | number)[][];
    return new Response(
      JSON.stringify(
        cmds.map(([name, key, by]) => {
          if (name === "INCRBY") store.set(String(key), (store.get(String(key)) ?? 0) + Number(by));
          return { result: name === "EXPIRE" ? 1 : (store.get(String(key)) ?? null) };
        })
      ),
      { status: 200 }
    );
  }) as typeof fetch;
  process.env.UPSTASH_REDIS_REST_URL = "https://redis.selftest.invalid";
  process.env.UPSTASH_REDIS_REST_TOKEN = "selftest";
  try {
    const t = 1_800_000_000_000;
    const opts = { failClosed: true };
    assert.equal(await addRateCount("chain:1", "relay-spend", 700, t, 3600, opts), 700);
    assert.equal(await addRateCount("chain:1", "relay-spend", 300, t, 3600, opts), 1000);
    assert.equal(await addRateCount("chain:1", "relay-spend", -650, t, 3600, opts), 350);
    assert.equal(await readRateLimit("chain:1", "relay-spend", t, 3600, opts), 350);
    assert.equal(await addRateCount("chain:1", "relay-spend", 5, t + 3_600_000, 3600, opts), 5, "the next hour starts over");
    up = false;
    await assert.rejects(addRateCount("chain:1", "relay-spend", 1, t, 3600, opts), SharedCountUnavailable);
  } finally {
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    globalThis.fetch = real;
  }
});

await test("the cap and the limit per IP are set by chain", async () => {
  assert.equal(hourlySpendWei(1, {}), 50_000_000_000_000_000n);
  assert.equal(hourlySpendWei(8453, {}), 10_000_000_000_000_000n);
  assert.equal(hourlySpendWei(4663, {}), 20_000_000_000_000_000n);
  assert.equal(hourlySpendWei(4217, {}), 10n ** 18n);
  assert.equal(hourlySpendWei(84532, {}), null, "a testnet has none");
  assert.equal(hourlySpendWei(1, { GLOAM_RELAY_HOURLY_SPEND_1: "0.5" }), 5n * 10n ** 17n);
  assert.equal(hourlySpendWei(1, { GLOAM_RELAY_HOURLY_SPEND_1: "off" }), null);
  assert.equal(hourlySpendWei(1, { GLOAM_RELAY_HOURLY_SPEND_1: "lots" }), 50_000_000_000_000_000n, "not a number keeps the default");
  assert.equal(hourlySpendWei(1, { GLOAM_RELAY_HOURLY_SPEND_1: "0" }), 50_000_000_000_000_000n);
  assert.equal(ipSendsLimit(1, {}), 120);
  assert.equal(ipSendsLimit(8453, {}), null);
  assert.equal(ipSendsLimit(1, { GLOAM_RELAY_IP_SENDS_1: "5" }), 5);
  assert.equal(ipSendsLimit(1, { GLOAM_RELAY_IP_SENDS_1: "off" }), null);
  fresh();
  process.env.GLOAM_RELAY_IP_SENDS_1 = "3";
  for (let i = 0; i < 3; i++) await checkChainRateLimit(net, "203.0.113.9");
  await assert.rejects(checkChainRateLimit(net, "203.0.113.9"), isCode("rate_limit"));
  await checkChainRateLimit(net, "203.0.113.10");
  await checkChainRateLimit(base, "203.0.113.9");
});

await test("an exit takes only a swap's assets, and each kind of send has a most gas", async () => {
  fresh();
  on(1);
  chain.spent = true;
  chain.held = usd(1_000);
  const exit = (asset: Address) => {
    const key = {
      nullifier: `0x${(++nul).toString(16).padStart(64, "0")}`, amountIn: "1000000000", outCommitment: `0x${"55".repeat(32)}`, assetOut: E.USDT, amountOut: "1",
      refundCommitment: `0x${"77".repeat(32)}`, refundAmount: "1", routeHash: `0x${"88".repeat(32)}`, exitKey: "0x00000000000000000000000000000000000e417e", deadline: "1",
    };
    const escrow = escrowAddress(VAULT_SWAP_V3_ADDRESS[1]!, asset, {
      ...key, nullifier: key.nullifier as Hex, amountIn: 1_000_000_000n, outCommitment: key.outCommitment as Hex, assetOut: key.assetOut as Address, amountOut: 1n,
      refundCommitment: key.refundCommitment as Hex, refundAmount: 1n, routeHash: key.routeHash as Hex, exitKey: key.exitKey as Address, deadline: 1n,
    });
    return { router: VAULT_SWAP_V3_ADDRESS[1], asset, to: "0x00000000000000000000000000000000000e4170", signature: `0x${"aa".repeat(65)}`, key, unshieldTx: vaultPaid(key.nullifier, asset, escrow, 1_000_000_000n) };
  };
  await assert.rejects(relayVaultSwapExit(net, exit("0x0000000000000000000000000000000000000bad")), isCode("swap_asset"));
  assert.equal(sends.length, 0);
  chain.dryRunGas = 150_000n;
  const { unshieldTx: _none, ...noProof } = exit(E.USDC);
  await assert.rejects(relayVaultSwapExit(net, noProof), isCode("unshield_tx"), "an exit shows the vault's payment too");
  assert.equal(sends.length, 0);
  await relayVaultSwapExit(net, exit(E.USDC));
  assert.equal(sends.length, 1);
  chain.dryRunGas = 20_000_000n;
  await assert.rejects(relayVaultSwapExit(net, exit(E.USDC)), isCode("gas_most"));
  await assert.rejects(relayVaultSwap(net, refundBody(usd(1_000))), isCode("gas_most"));
  assert.equal(sends.length, 1, "nothing more went out");
  chain.dryRunGas = DRY_RUN_GAS;
  assert.equal(sendGasMost(1, "unshield"), 1_200_000n);
  assert.equal(sendGasMost(8453, "swapExit"), 400_000n);
  assert.ok(sendGasMost(4663, "unshield")! > sendGasMost(1, "unshield")!, "a parent-chain cost moves Robinhood Chain's estimates");
  assert.equal(sendGasMost(4217, "unshield"), null, "Tempo prices storage its own way");
  assert.equal(sendGasMost(1, "transfer"), null, "a private send has no such limit");
});

await test("Base USDC to USDT past its depth says thin, with a size, not off its peg", async () => {
  on(8453);
  const rate = (a: bigint) => (a < usd(20_000) ? 1.0008 : 0.83);
  await assert.rejects(planVaultSwap(quotes(rate), 8453, ask(B.USDC, B.USDT, usd(50_000))), (e: unknown) => {
    assert.ok(e instanceof SwapQuoteRefused);
    assert.equal(e.message, SWAP_TOO_THIN);
    assert.ok(e.fitsIn !== null && e.fitsIn > usd(10_000) && e.fitsIn < usd(20_000), `${e.fitsIn}`);
    return true;
  });
  off(8453);
});

await test("a swap's deadline is 10 minutes on Base and Ethereum, 30 elsewhere", () => {
  assert.equal(swapDeadlineSeconds(1), 600);
  assert.equal(swapDeadlineSeconds(8453), 600);
  assert.equal(swapDeadlineSeconds(4663), SWAP_DEADLINE_SECONDS);
  assert.equal(swapDeadlineSeconds(4217), SWAP_DEADLINE_SECONDS);
  assert.ok(swapDeadlineSeconds(1) > 2 * SWAP_SEND_MARGIN_SECONDS);
});

await test("a refund note short of what arrived after a fee rise reads short, and a stray transfer doesn't", async () => {
  const info = {
    router: VAULT_SWAP_V3_ADDRESS[1]!, assetIn: E.USDC as Address, amountIn: usd(10_000).toString(),
    out: { commitment: `0x${"55".repeat(32)}` as Hex, asset: E.USDT as Address, amount: "1" }, route: direct,
    exitKey: "0x00000000000000000000000000000000000e417e" as Address, deadline: "1",
  };
  const refund = refundAmountFor(usd(10_000), 25);
  const client = (held: bigint) => ({ readContract: async () => held }) as never;
  const read = (held: bigint) => escrowHolds(client(held), info, `0x${"33".repeat(32)}`, `0x${"77".repeat(32)}`, refund);
  assert.equal(await read(refund), true);
  assert.equal(await read(usd(10_000) - usd(50)), "short", "the note's money after a 0.50% fee");
  assert.equal(await read(usd(9_900)), "short", "the vault's highest fee");
  assert.equal(await read(usd(9_899)), false, "less than any fee leaves");
  assert.equal(await read(1n), false);
  assert.equal(await read(0n), false);
});

off(1);
off(8453);

const WALLET = "0x00000000000000000000000000000000000c0ffe";
let cashOutN = 1;
function cashOut(amount: bigint) {
  cashOutN++;
  return { proof, root: `0x${"22".repeat(32)}`, nullifier: `0x${(0xc0000 + cashOutN).toString(16).padStart(64, "0")}`, asset: E.USDC, to: WALLET, amount: amount.toString() };
}
const memoFor = (n: number) => ({ paymentCommitment: `0x${(0x5000 + n).toString(16).padStart(64, "0")}`, memo: `0x${"ab".repeat(64)}` });

await test("the hourly spend cap counts cash outs like any send, a one-unit one as much as a large one", async () => {
  fresh();
  chain.receipt = "none";
  chain.dryRunGas = 300_000n;
  // 390k gas held at about 0.0444 gwei: 0.0000173 a cash out. Money coming back may use all of
  // the cap, so five fit under 0.0001
  process.env.GLOAM_RELAY_HOURLY_SPEND_1 = "0.0001";
  const outcomes: string[] = [];
  for (let i = 0; i < 12; i++) {
    const r = await relayUnshield(net, cashOut(i % 2 === 0 ? 1n : usd(40_000))).catch((e) => e);
    outcomes.push(typeof r === "string" ? "sent" : isCode("spend_cap")(r) ? "cap" : String(r));
  }
  assert.deepEqual(outcomes, [...Array(5).fill("sent"), ...Array(7).fill("cap")]);
  assert.equal(sends.length, 5);
});

const transferBody = () => {
  cashOutN++;
  const h = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
  return { proof, root: `0x${"22".repeat(32)}`, nullifier: h(0xe0000 + cashOutN), commitments: [h(0xe1000 + cashOutN), h(0xe2000 + cashOutN)] };
};
const slotsUsed = async () => {
  const { readRateLimit } = await import("../src/lib/mcpRemote/rateLimit");
  return readRateLimit(`chain:${net.chainId}`, "relay-net", Date.now(), 3600);
};

// the two that follow send a refund
on(1);

await test("a send the cap turns away takes none of the network's slots, so a refund still goes", async () => {
  fresh();
  chain.receipt = "none";
  // 0.000098 held a send: two fit under 80% of 0.0003
  process.env.GLOAM_RELAY_HOURLY_SPEND_1 = "0.0003";
  for (let i = 0; i < 2; i++) assert.equal(typeof (await relayTransfer(net, transferBody())), "string");
  assert.equal(await slotsUsed(), 2);
  // the network's slots nearly gone
  const { addRateCount } = await import("../src/lib/mcpRemote/rateLimit");
  await addRateCount(`chain:${net.chainId}`, "relay-net", 4_997, Date.now(), 3600);
  const same = transferBody();
  for (let i = 0; i < 50; i++) await assert.rejects(relayTransfer(net, same), (e: unknown) => isCode("spend_cap")(e) && (e as Error).message === SPEND_CAP_MESSAGE);
  assert.equal(await slotsUsed(), 4_999, "fifty turned away, none counted");
  chain.spent = true;
  chain.held = usd(1_000);
  await relayVaultSwap(net, refundBody(usd(1_000)));
  assert.equal(sends.length, 3, "the refund went, in the last slot but one");
});

/** Sends until one is refused, or `most` went. */
async function until(send: () => Promise<unknown>, most: number, settle = false) {
  let sent = 0;
  for (; sent < most; sent++) {
    const r = await send().catch((e: unknown) => e);
    if (typeof r !== "string") return { sent, refused: (r as Error).message };
    if (settle) await new Promise((res) => setTimeout(res, 12));
  }
  return { sent, refused: null as string | null };
}
const spentOnChain = async (chainId: number) => {
  const { readRateLimit } = await import("../src/lib/mcpRemote/rateLimit");
  return readRateLimit(`chain:${chainId}`, "relay-spend", Date.now(), 3600);
};

await test("one sender holds at most its share; the last of the cap is for refunds and exits", async () => {
  fresh();
  chain.receipt = "none";
  // 0.000098 held a send at 0.037 gwei. Cap 0.03: 40% is 0.012, 200 sends' dry-run gas at
  // that price 0.0126, so the share is 0.0126; new sends stop at 0.024, cash outs at 0.0276
  process.env.GLOAM_RELAY_HOURLY_SPEND_1 = "0.03";
  const A = "198.51.100.21";
  const a = await until(() => relayTransfer(net, transferBody(), A), 300);
  assert.ok(a.refused === SENDER_SHARE_MESSAGE && a.sent > 100 && a.sent < 200, JSON.stringify(a));
  // a cash out from the same sender counts toward its share too
  chain.dryRunGas = 300_000n;
  await assert.rejects(relayUnshield(net, cashOut(usd(10)), A), (e: unknown) => (e as Error).message === SENDER_SHARE_MESSAGE);
  chain.dryRunGas = DRY_RUN_GAS;
  // another sender takes the rest of the new-send share, and then new sends stop for everyone
  const B = await until(() => relayTransfer(net, transferBody(), "198.51.100.22"), 300);
  assert.ok(B.sent > 30 && B.refused === SPEND_CAP_MESSAGE, JSON.stringify(B));
  // a third sender's small cash outs fill what cash outs may use, and stop short of the cap
  chain.dryRunGas = 300_000n;
  const C = await until(() => relayUnshield(net, cashOut(1n), "198.51.100.23"), 400);
  assert.ok(C.sent > 100 && C.refused === SPEND_CAP_MESSAGE, JSON.stringify(C));
  await assert.rejects(relayUnshield(net, cashOut(usd(10)), "198.51.100.24"), (e: unknown) => (e as Error).message === SPEND_CAP_MESSAGE);
  chain.dryRunGas = DRY_RUN_GAS;
  // money on its way back from a swap still goes, from what is kept for it, whatever A sent
  const before = sends.length;
  chain.spent = true;
  chain.held = usd(1_000);
  await relayVaultSwap(net, refundBody(usd(1_000)), A);
  assert.equal(sends.length, before + 1);
});

await test("no sender's share passes 60% of the cap, however dear gas is", async () => {
  fresh();
  chain.receipt = "none";
  // 0.247 gwei: 200 sends would be 0.084, over the whole cap (0.05)
  chain.gasPrice = 247_000_000n;
  const a = await until(() => relayTransfer(net, transferBody(), "198.51.100.25"), 300);
  assert.equal(a.refused, SENDER_SHARE_MESSAGE);
  const used = await spentOnChain(1);
  assert.ok(used <= 30_000_000 && used > 29_000_000, `one sender held ${used} of 50,000,000`);
  // and another sender still sends
  assert.equal(typeof (await relayTransfer(net, transferBody(), "198.51.100.26")), "string");
});

let payrollIp = 100;
for (const [label, n, gwei, fits] of [
  ["Ethereum at today's gas", "ethereum", 40_000_000n, true],
  ["Ethereum up to 0.084 gwei", "ethereum", 84_000_000n, true],
  ["Ethereum past it, at 0.1 gwei", "ethereum", 100_000_000n, false],
  ["Base at today's gas", "base", 6_000_000n, true],
  ["Base up to 0.016 gwei", "base", 16_000_000n, true],
  ["Robinhood Chain at today's gas", "robinhood", 20_000_000n, true],
  ["Robinhood Chain up to 0.034 gwei", "robinhood", 34_000_000n, true],
] as const) {
  await test(`a 200-payment payroll from one browser: ${label}, ${fits ? "fits" : "meets the 60% ceiling"}`, async () => {
    fresh();
    chain.receipt = "success";
    chain.dryRunGas = 1_800_000n; // what a relayed transfer's dry run shows
    chain.gasUsed = 1_742_548n; // and what one burns (Robinhood Chain, 2 November)
    chain.gasPrice = gwei;
    const on = n === "ethereum" ? net : n === "base" ? base : getNetwork("robinhood-mainnet");
    // a browser of its own each time, so nothing from an earlier case is counted against it
    const ip = `198.51.100.${payrollIp++}`;
    const r = await until(() => relayTransfer(on, transferBody(), ip), 200, true);
    if (fits) assert.deepEqual(r, { sent: 200, refused: null });
    else assert.ok(r.sent < 200 && r.refused === SENDER_SHARE_MESSAGE, JSON.stringify(r));
    await settled();
  });
}

await test("accounts sharing one IP share that IP's share; an approved account holds only its own", async () => {
  fresh();
  chain.receipt = "none";
  process.env.GLOAM_RELAY_HOURLY_SPEND_1 = "0.03";
  // what one IP alone gets here
  const alone = (await until(() => relayTransfer(net, transferBody(), "198.51.100.50"), 300)).sent;
  fresh();
  chain.receipt = "none";
  process.env.GLOAM_RELAY_HOURLY_SPEND_1 = "0.03";
  const IP = "198.51.100.51";
  for (let i = 0; i < 60; i++) await relayTransfer(net, transferBody(), ["partner:ptr_one111", IP]);
  const second = await until(() => relayTransfer(net, transferBody(), ["partner:ptr_two222", IP]), 300);
  assert.equal(second.refused, SENDER_SHARE_MESSAGE);
  assert.equal(60 + second.sent, alone, "the IP's share, between both accounts");
  await assert.rejects(relayTransfer(net, transferBody(), IP), (e: unknown) => (e as Error).message === SENDER_SHARE_MESSAGE);
  assert.equal(typeof (await relayTransfer(net, transferBody(), ["partner:ptr_ok3333"])), "string");
});

/** A refund on Base: the note spent alone, the money at its escrow, the vault's payment on record. */
const baseRoute = [BASE_SWAP_POOLS[2]!];
function baseRefundBody(amount: bigint) {
  const b = { ...swapBody(B.USDC, B.USDT, amount, baseRoute), router: VAULT_SWAP_V3_ADDRESS[8453] };
  const escrow = escrowOf(b, VAULT_SWAP_V3_ADDRESS[8453]!, baseRoute);
  return { ...b, unshieldTx: vaultPaid(b.spend.nullifier, b.spend.asset, escrow, amount) };
}

await test("where there's no swap floor, an IP's refunds hold against a budget of their own, never against its sends", async () => {
  on(8453);
  fresh();
  chain.receipt = "none";
  chain.spent = true;
  chain.held = usd(10);
  // Base, cap 0.01: 2% is 0.0002, five refunds' dry-run gas at 0.037 gwei 0.000315; each holds 0.000123
  const X = "198.51.100.71";
  const x = await until(() => relayVaultSwap(base, baseRefundBody(usd(10)), X), 10);
  assert.deepEqual(x, { sent: 2, refused: BACK_SHARE_MESSAGE });
  // another IP's refund still goes
  assert.equal(typeof (await relayVaultSwap(base, baseRefundBody(usd(10)), "198.51.100.72")), "string");
  // an IP that used its whole share on sends still gets its refunds back
  chain.spent = false;
  const Y = "198.51.100.73";
  const y = await until(() => relayTransfer(base, transferBody(), Y), 100);
  assert.equal(y.refused, SENDER_SHARE_MESSAGE);
  chain.spent = true;
  assert.equal(typeof (await relayVaultSwap(base, baseRefundBody(usd(10)), Y)), "string");
  off(8453);
});

await test("on Ethereum a refund holds no IP budget: the floor's budgets apply there", async () => {
  fresh();
  chain.receipt = "none";
  chain.spent = true;
  chain.held = usd(1_000);
  let sent = 0;
  for (let i = 0; i < 6; i++) {
    await relayVaultSwap(net, refundBody(usd(1_000)), "198.51.100.74");
    sent++;
  }
  assert.equal(sent, 6);
});

await test("a shared store that fails between two holds gets the first one back", async () => {
  fresh();
  chain.receipt = "none";
  process.env.GLOAM_RELAY_HOURLY_SPEND_1 = "0.1";
  const store = new Map<string, string>();
  let failNext: ((cmd: (string | number)[]) => boolean) | null = null;
  const run = (cmd: (string | number)[]): { result?: unknown; error?: string } => {
    if (failNext?.(cmd)) {
      failNext = null;
      throw new Error("selftest: dropped");
    }
    const [name, key, ...rest] = cmd.map(String);
    switch (name.toUpperCase()) {
      case "SET":
        if (rest.includes("NX") && store.has(key!)) return { result: null };
        store.set(key!, rest[0]!);
        return { result: "OK" };
      case "GET":
        return { result: store.get(key!) ?? null };
      case "DEL":
        return { result: store.delete(key!) ? 1 : 0 };
      case "EVAL": {
        // the lock's release: delete if it still holds the token
        const [lockKey, token] = [String(cmd[3]), String(cmd[4])];
        if (store.get(lockKey) === token) store.delete(lockKey);
        return { result: 1 };
      }
      case "INCR":
      case "INCRBY": {
        const n = Number(store.get(key!) ?? 0) + (name.toUpperCase() === "INCR" ? 1 : Number(rest[0]));
        store.set(key!, String(n));
        return { result: n };
      }
      case "EXPIRE":
        return { result: 1 };
      default:
        return { error: `selftest: ${name}` };
    }
  };
  const rpc = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith("https://redis.selftest.invalid")) return rpc(input, init);
    const body = JSON.parse(String(init?.body)) as (string | number)[] | (string | number)[][];
    try {
      const out = url.endsWith("/pipeline") ? (body as (string | number)[][]).map(run) : run(body as (string | number)[]);
      return new Response(JSON.stringify(out), { status: 200 });
    } catch {
      return new Response("down", { status: 503 });
    }
  }) as typeof fetch;
  process.env.UPSTASH_REDIS_REST_URL = "https://redis.selftest.invalid";
  process.env.UPSTASH_REDIS_REST_TOKEN = "selftest";
  const held = (bucket: string) => [...store.entries()].filter(([k]) => k.includes(`:${bucket}:`)).reduce((a, [, v]) => a + Number(v), 0);
  try {
    // the sender's share is held, then the chain's cap fails to answer once
    failNext = (cmd) => String(cmd[0]) === "INCRBY" && String(cmd[1]).includes(":relay-spend:") && Number(cmd[2]) > 0;
    await assert.rejects(relayTransfer(net, transferBody(), "198.51.100.61"), isCode("relay_off"));
    assert.equal(held("relay-spend-sender-1"), 0, "the sender's hold came back");
    assert.equal(held("relay-spend"), 0);
    assert.equal(held("relay-net"), 0, "no slot was taken");
    // and with the store answering again, the same send goes
    assert.equal(typeof (await relayTransfer(net, transferBody(), "198.51.100.61")), "string");
    assert.ok(held("relay-spend-sender-1") > 0 && held("relay-net") === 1);
  } finally {
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    globalThis.fetch = rpc;
  }
});

off(1);

await test("a sender's share is set by chain, and can be turned off", async () => {
  const { senderSharePct, DEFAULT_SENDER_SHARE_PCT } = await import("../src/lib/relay/spendCap");
  assert.equal(DEFAULT_SENDER_SHARE_PCT, 40);
  assert.equal(senderSharePct(1, {}), 40);
  assert.equal(senderSharePct(1, { GLOAM_RELAY_SENDER_SHARE_1: "25" }), 25);
  assert.equal(senderSharePct(1, { GLOAM_RELAY_SENDER_SHARE_1: "off" }), null);
  for (const bad of ["0", "101", "1.5", "x"]) assert.equal(senderSharePct(1, { GLOAM_RELAY_SENDER_SHARE_1: bad }), 40, bad);
  fresh();
  chain.receipt = "none";
  process.env.GLOAM_RELAY_HOURLY_SPEND_1 = "0.001";
  process.env.GLOAM_RELAY_SENDER_SHARE_1 = "off";
  for (let i = 0; i < 6; i++) assert.equal(typeof (await relayTransfer(net, transferBody(), "198.51.100.31")), "string");
});

await test("on Base a send holds a margin for posting to Ethereum, and settles at what its receipt shows", async () => {
  fresh();
  const { readRateLimit } = await import("../src/lib/mcpRemote/rateLimit");
  const spent = () => readRateLimit(`chain:${base.chainId}`, "relay-spend", Date.now(), 3600);
  process.env.GLOAM_RELAY_HOURLY_SPEND_8453 = "0.01";
  chain.receipt = "none";
  await relayTransfer(base, transferBody());
  // 2.21M gas at 0.037 gwei, half again
  assert.equal(await spent(), Number((2_210_000n * 37_000_000n * 150n) / 100n / 1_000_000_000n) + 1);
  fresh();
  process.env.GLOAM_RELAY_HOURLY_SPEND_8453 = "0.01";
  chain.l1Fee = 10_000_000_000_000n; // 10,000 gwei
  await relayTransfer(base, transferBody());
  await settled();
  assert.equal(await spent(), Number((1_000_000n * 37_000_000n + 10_000_000_000_000n) / 1_000_000_000n) + 1, "the gas it burned and the fee to Ethereum");
});

await test("a receipt watch ends inside the request's time", () => {
  const now = 1_000_000;
  assert.equal(receiptWatchMs(1, now + RECEIPT_WATCH_WITHIN_MS, now), 45_000);
  assert.equal(receiptWatchMs(1, now + 120_000, now), 50_000, "Ethereum's own watch is the most");
  assert.equal(receiptWatchMs(8453, now + 120_000, now), 30_000);
  assert.equal(receiptWatchMs(1, now + 5_000, now), 5_000, "a slow request watches what is left");
  assert.equal(receiptWatchMs(1, now - 1, now), 0, "none left: one read, then the holds stay");
});

await test("on Ethereum a key from an account no admin approved shares 60 messages an hour with every such account, as strangers do", async () => {
  fresh();
  chain.seen = true;
  chain.dryRunGas = 100_000n;
  chain.gasUsed = 90_000n;
  let accepted = 0;
  let refused = 0;
  for (let p = 0; p < 40 && refused === 0; p++) {
    for (let a = 0; a < 3 && refused === 0; a++) {
      try {
        await relayMemo(net, memoFor(p), { partner: `ptr_free${a}x${p}`, approved: false });
        accepted++;
      } catch (e) {
        assert.ok(isCode("memo_busy")(e), String(e));
        refused++;
      }
    }
  }
  assert.equal(accepted, 60);
  // strangers have their own 60, and an approved account's key goes from the paid budget
  assert.equal(typeof (await relayMemo(net, memoFor(900))), "string");
  assert.equal(typeof (await relayMemo(net, memoFor(901), { partner: "ptr_approved1", approved: true })), "string");
  await settled();
});

await test("messages outside the paid budget hold at most a fifth of the spend cap, and sends keep the rest", async () => {
  fresh();
  chain.seen = true;
  chain.receipt = "none";
  chain.dryRunGas = 100_000n;
  // 130k gas held at about 0.0444 gwei: 0.0000058 a message; a fifth of 0.00005 is 0.00001
  process.env.GLOAM_RELAY_HOURLY_SPEND_1 = "0.00005";
  assert.equal(typeof (await relayMemo(net, memoFor(1))), "string");
  await assert.rejects(relayMemo(net, memoFor(2)), isCode("memo_busy"));
  await assert.rejects(relayMemo(net, memoFor(3), { partner: "ptr_free1", approved: false }), isCode("memo_busy"), "a key from an account no admin approved shares that fifth");
  assert.equal(typeof (await relayMemo(net, memoFor(4), { partner: "ptr_approved1", approved: true })), "string", "the paid budget is outside it");
  chain.dryRunGas = 300_000n;
  assert.equal(typeof (await relayUnshield(net, cashOut(usd(100)))), "string", "a cash out still goes");
  assert.equal(sends.length, 3);
});

await test("escrow and route bytes stay what they were", () => {
  const key = {
    nullifier: `0x${"33".repeat(32)}` as Hex, amountIn: 1n, outCommitment: `0x${"55".repeat(32)}` as Hex, assetOut: getAddress(E.USDT), amountOut: 1n,
    refundCommitment: `0x${"77".repeat(32)}` as Hex, refundAmount: 1n, routeHash: keccak256(encodeRoute(direct)), exitKey: getAddress("0x00000000000000000000000000000000000e417e"), deadline: 1n,
  };
  assert.notEqual(escrowAddress(VAULT_SWAP_V3_ADDRESS[1]!, E.USDC, key), escrowAddress(VAULT_SWAP_V3_ADDRESS[8453]!, E.USDC, key), "a router's escrow is its own on each chain");
});

console.log(`swap stable: ${passed} passed`);
process.exit(0);
