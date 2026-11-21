/**
 * Self-test: $GLOAM holder rebates (lib/holderRebates).
 *
 * A holder's cash-out at 0.5% gets 0.3% back, so it ends at 0.2%. Nobody gets
 * back more than the vault kept, no cash-out is rebated twice, and Gloam's own
 * wallets, non-holders and cash-outs before the start get nothing.
 *
 * Run from app/:  pnpm dlx tsx scripts/selftest-holder-rebates.mts
 */
import assert from "node:assert/strict";
import { cashOutKey, planRebates, rebateFor, type CashOut } from "../src/lib/holderRebates";

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`ok  ${name}`);
}

const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const HOLDER = "0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";
const TREASURY = "0xb3900ac9350903218e4c7597bab0f008f01b30b8";
const START = 1_763_683_200; // 2025-11-21, any fixed time works here

let n = 0;
function cashOut(p: Partial<CashOut> & { amount: bigint }): CashOut {
  n++;
  return {
    chainId: 8453,
    network: "Base",
    txHash: `0x${n.toString(16).padStart(64, "0")}`,
    nullifier: `0x${(1000 + n).toString(16).padStart(64, "0")}`,
    asset: USDC,
    to: HOLDER,
    fee: (p.amount * 50n) / 10_000n,
    block: BigInt(100 + n),
    time: START + n,
    ...p,
  };
}

const base = {
  isHolder: (to: string) => to === HOLDER,
  alreadyPaid: new Set<string>(),
  excluded: new Set([TREASURY]),
  startTime: START,
};

test("0.5% fee, holder pays 0.2%: 0.3% comes back", () => {
  // $1,000 in 6 decimals: fee $5, holder fee $2, rebate $3
  assert.equal(rebateFor(1_000_000_000n, 5_000_000n), 3_000_000n);
  // ETH-sized amounts, 18 decimals
  assert.equal(rebateFor(10n ** 18n, 5n * 10n ** 15n), 3n * 10n ** 15n);
});

test("never more than the vault kept, never negative", () => {
  assert.equal(rebateFor(1_000_000n, 0n), 0n);
  assert.equal(rebateFor(0n, 5n), 0n);
  // an old 0.25% cash-out: 0.05% back
  assert.equal(rebateFor(1_000_000_000n, 2_500_000n), 500_000n);
  // a fee already at or below 0.2%: nothing back
  assert.equal(rebateFor(1_000_000_000n, 2_000_000n), 0n);
  assert.equal(rebateFor(1_000_000_000n, 1_000_000n), 0n);
  // rounding favours the treasury: tiny amounts give nothing extra
  assert.equal(rebateFor(99n, 0n), 0n);
  for (const amount of [1n, 7n, 199n, 10_001n, 123_456_789n, 10n ** 24n]) {
    const fee = (amount / 10_000n) * 50n + ((amount % 10_000n) * 50n) / 10_000n;
    const back = rebateFor(amount, fee);
    assert.ok(back <= fee, `rebate ${back} over fee ${fee} for ${amount}`);
    assert.ok(fee - back >= (amount * 20n) / 10_000n);
  }
});

test("holders are paid, summed per wallet, chain and coin", () => {
  const plan = planRebates(
    [cashOut({ amount: 1_000_000_000n }), cashOut({ amount: 500_000_000n }), cashOut({ amount: 1_000_000_000n, to: OTHER })],
    base
  );
  assert.equal(plan.payouts.length, 1);
  assert.equal(plan.payouts[0]!.to, HOLDER);
  assert.equal(plan.payouts[0]!.amount, 3_000_000n + 1_500_000n);
  assert.equal(plan.payouts[0]!.cashOuts.length, 2);
  assert.equal(plan.skipped["not a holder"], 1);
});

test("separate payouts per chain and per coin", () => {
  const plan = planRebates(
    [
      cashOut({ amount: 1_000_000_000n }),
      cashOut({ amount: 1_000_000_000n, asset: "native" }),
      cashOut({ amount: 1_000_000_000n, chainId: 4663, network: "Robinhood Chain" }),
    ],
    base
  );
  assert.equal(plan.payouts.length, 3);
});

test("never twice: paid before, or the same cash-out read twice", () => {
  const a = cashOut({ amount: 1_000_000_000n });
  const plan = planRebates([a, a], { ...base, alreadyPaid: new Set() });
  assert.equal(plan.rebated.length, 1);
  const again = planRebates([a], { ...base, alreadyPaid: new Set([cashOutKey(a)]) });
  assert.equal(again.payouts.length, 0);
  assert.equal(again.skipped["paid before"], 1);
  // the key ignores hex case
  assert.equal(cashOutKey({ chainId: 1, nullifier: "0xABC" }), cashOutKey({ chainId: 1, nullifier: "0xabc" }));
});

test("Gloam's own wallets and cash-outs before the start get nothing", () => {
  const plan = planRebates(
    [cashOut({ amount: 1_000_000_000n, to: TREASURY }), cashOut({ amount: 1_000_000_000n, time: START - 1 })],
    { ...base, isHolder: () => true }
  );
  assert.equal(plan.payouts.length, 0);
  assert.equal(plan.skipped["gloam wallet"], 1);
  assert.equal(plan.skipped["before start"], 1);
});

test("a cash-out with no fee is not rebated", () => {
  const plan = planRebates([cashOut({ amount: 1_000_000_000n, fee: 0n })], base);
  assert.equal(plan.payouts.length, 0);
  assert.equal(plan.skipped["no fee"], 1);
});

console.log(`\n${passed} passed`);
