/**
 * Live deposit limits self-test.
 *
 * The vault's limits change through its timelock, so the SDK reads them from
 * the vault: depositLimitsOn(), depositLimit(asset) and deposited(asset). A
 * deposit over the old 500 launch value goes through once the vault says so;
 * one over the vault's live limit or its room left is refused before proving;
 * a vault that can't be read refuses nothing (the vault enforces its own
 * limits). Reads go to an in-memory fake.
 *
 * Run after build:  node test/limits.selftest.mjs
 */
import {
  readDepositLimit,
  readCashOutFeeBps,
  cashOutFee,
  CASH_OUT_FEE_BPS,
  depositLimitProblem,
  assertDepositWithinLiveLimit,
  buildShieldBoundIntent,
  POOL_DEPOSIT_LIMIT_ABI,
  NO_LIMIT_THRESHOLD,
  isNoLimit,
  MAINNET_POOLS,
  RH_MAINNET_USDG,
  NATIVE_ASSET,
} from "../dist/index.js";

let checks = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exit(1);
  }
  checks++;
}
async function rejects(fn, re, msg) {
  try {
    await fn();
  } catch (e) {
    assert(re.test(String(e?.message ?? e)), `${msg}: wrong error "${e?.message}"`);
    return;
  }
  assert(false, `${msg}: did not throw`);
}

const SIX = 10n ** 6n;
const RH = 4663;
const POOL = MAINNET_POOLS[RH].pool;

/** A vault answering depositLimitsOn / depositLimit / deposited from `state`; records what it was asked. */
function fakeVault(state) {
  const asked = [];
  return {
    asked,
    readContract: async ({ address, abi, functionName, args }) => {
      asked.push({ address, functionName, args });
      assert(abi === POOL_DEPOSIT_LIMIT_ABI, "reads use the SDK's ABI");
      if (state.down) throw new Error("HTTP request failed. Status: 503");
      if (functionName === "depositLimitsOn") return state.on;
      const a = String(args[0]).toLowerCase();
      if (functionName === "depositLimit") return state.limits[a] ?? [0n, 0n];
      if (functionName === "deposited") return state.deposited?.[a] ?? 0n;
      throw new Error(`unexpected read ${functionName}`);
    },
  };
}
const usdg = RH_MAINNET_USDG.toLowerCase();
const prover = async () => ({ proofBytes: "0xdeadbeef" });
let proved = 0;
const countingProver = async (i) => {
  proved++;
  return prover(i);
};

// launch values: 500 per deposit, 25,000 in total
const launch = { on: true, limits: { [usdg]: [500n * SIX, 25_000n * SIX] }, deposited: { [usdg]: 1_000n * SIX } };
// after the raise: 100x
const raised = { on: true, limits: { [usdg]: [50_000n * SIX, 2_500_000n * SIX] }, deposited: { [usdg]: 1_000n * SIX } };

// ── reading ──────────────────────────────────────────────────────────────────
{
  const v = fakeVault(raised);
  const lim = await readDepositLimit(v, POOL, RH_MAINNET_USDG);
  assert(lim.on && lim.perDeposit === 50_000n * SIX && lim.total === 2_500_000n * SIX, "reads the vault's own limits");
  assert(lim.deposited === 1_000n * SIX && lim.room === 2_499_000n * SIX, "and what it holds, and the room left");
  assert(v.asked.every((q) => q.address === POOL), "every read goes to the vault");
}

// ── the raise: 501 goes through once the vault says so ───────────────────────
{
  await rejects(
    () => assertDepositWithinLiveLimit(fakeVault(launch), RH, RH_MAINNET_USDG, 501n * SIX),
    /at most 500 USDG per deposit/,
    "before the raise, 501 is over the vault's limit"
  );
  const after = await assertDepositWithinLiveLimit(fakeVault(raised), RH, RH_MAINNET_USDG, 501n * SIX);
  assert(after && after.perDeposit === 50_000n * SIX, "after the raise, 501 is taken");
  const i = await buildShieldBoundIntent({ chainId: RH, asset: RH_MAINNET_USDG, amountWei: 10_000n * SIX, prover, client: fakeVault(raised) });
  assert(i.exec.fn === "shieldBound" && i.exec.args[1] === 10_000n * SIX, "the builder makes a 10,000 deposit after the raise");
}

// ── no limit: type(uint128).max reads as none, never as a number ───────────
{
  const MAX = (1n << 128n) - 1n;
  assert(NO_LIMIT_THRESHOLD === 1n << 127n, "the no-limit line is 2^127");
  assert(isNoLimit(MAX) && isNoLimit(1n << 127n) && !isNoLimit((1n << 127n) - 1n) && !isNoLimit(2_500_000n * SIX), "isNoLimit");
  const lifted = { on: true, limits: { [usdg]: [MAX, MAX] }, deposited: { [usdg]: 2_400_000n * SIX } };
  const lim = await readDepositLimit(fakeVault(lifted), POOL, RH_MAINNET_USDG);
  assert(lim.unlimited && lim.on && lim.perDeposit === MAX, "both sides at max: unlimited");
  assert(lim.room === MAX - 2_400_000n * SIX, "room stays a plain bigint, no overflow");
  const big = 10n ** 30n;
  const ok = await assertDepositWithinLiveLimit(fakeVault(lifted), RH, RH_MAINNET_USDG, big);
  assert(ok && ok.unlimited, "a deposit far over the old limits is taken");
  assert(depositLimitProblem(lim, MAX + 1n, "Robinhood Chain", "USDG", 6) === null, "even an absurd amount never prints the max as a limit");
  const raisedLim = await readDepositLimit(fakeVault(raised), POOL, RH_MAINNET_USDG);
  assert(!raisedLim.unlimited, "a finite limit is not unlimited");
  const off = await readDepositLimit(fakeVault({ on: false, limits: {} }), POOL, RH_MAINNET_USDG);
  assert(off.unlimited, "limits off: unlimited");
  // mixed: only the finite side is a limit
  const perOnly = { on: true, limits: { [usdg]: [50_000n * SIX, MAX] }, deposited: { [usdg]: 0n } };
  await rejects(
    () => assertDepositWithinLiveLimit(fakeVault(perOnly), RH, RH_MAINNET_USDG, 50_001n * SIX),
    /at most 50,000 USDG per deposit/,
    "finite perDeposit under a max total still applies"
  );
  const perOnlyLim = await readDepositLimit(fakeVault(perOnly), POOL, RH_MAINNET_USDG);
  assert(!perOnlyLim.unlimited, "one finite side: not unlimited");
  const totalOnly = { on: true, limits: { [usdg]: [MAX, 2_500_000n * SIX] }, deposited: { [usdg]: 2_499_990n * SIX } };
  await rejects(
    () => assertDepositWithinLiveLimit(fakeVault(totalOnly), RH, RH_MAINNET_USDG, 11n * SIX),
    /room for 10 more USDG/,
    "finite total under a max perDeposit still applies"
  );
  const one = await assertDepositWithinLiveLimit(fakeVault(totalOnly), RH, RH_MAINNET_USDG, 10n * SIX);
  assert(one !== null, "and what fits goes through");
  const closed = { on: true, limits: { [usdg]: [0n, MAX] }, deposited: {} };
  await rejects(
    () => assertDepositWithinLiveLimit(fakeVault(closed), RH, RH_MAINNET_USDG, 1n),
    /takes no USDG deposits/,
    "perDeposit 0 is still closed"
  );
}

// ── refused before any proof is made ────────────────────────────────────────
{
  proved = 0;
  await rejects(
    () => buildShieldBoundIntent({ chainId: RH, asset: RH_MAINNET_USDG, amountWei: 50_001n * SIX, prover: countingProver, client: fakeVault(raised) }),
    /at most 50,000 USDG per deposit/,
    "over the live per-deposit limit"
  );
  const full = { ...raised, deposited: { [usdg]: 2_499_990n * SIX } };
  await rejects(
    () => buildShieldBoundIntent({ chainId: RH, asset: RH_MAINNET_USDG, amountWei: 11n * SIX, prover: countingProver, client: fakeVault(full) }),
    /room for 10 more USDG/,
    "over the room left under the total"
  );
  const atCap = { ...raised, deposited: { [usdg]: 2_500_000n * SIX } };
  await rejects(
    () => assertDepositWithinLiveLimit(fakeVault(atCap), RH, RH_MAINNET_USDG, 1n),
    /full for USDG/,
    "a full vault"
  );
  assert(proved === 0, "nothing was proved for a refused deposit");
}

// ── limits off, an unlisted asset, a vault that can't be read ────────────────
{
  const off = await assertDepositWithinLiveLimit(fakeVault({ on: false, limits: {} }), RH, RH_MAINNET_USDG, 10n ** 30n);
  assert(off && !off.on, "limits off: any amount");
  await rejects(
    () => assertDepositWithinLiveLimit(fakeVault(raised), RH, NATIVE_ASSET, 1n),
    /takes no ETH deposits/,
    "an asset with no limit is one the vault takes none of"
  );
  const down = await assertDepositWithinLiveLimit(fakeVault({ down: true }), RH, RH_MAINNET_USDG, 10n ** 30n);
  assert(down === null, "a vault that can't be read refuses nothing here");
  // and the builder still makes the deposit (the vault enforces its own limits), with the listing still checked
  const i = await buildShieldBoundIntent({ chainId: RH, asset: RH_MAINNET_USDG, amountWei: 600n * SIX, prover, client: fakeVault({ down: true }) });
  assert(i.exec.args[1] === 600n * SIX, "a deposit over the launch value is not blocked when the read fails");
  await rejects(
    () => buildShieldBoundIntent({ chainId: RH, asset: "0x00000000000000000000000000000000000000bb", amountWei: 1n, prover, client: fakeVault({ down: true }) }),
    /does not list/,
    "with no live answer, an unlisted asset is still refused"
  );
  // without a client the amount is not checked here at all
  const j = await buildShieldBoundIntent({ chainId: RH, asset: RH_MAINNET_USDG, amountWei: 5_000n * SIX, prover });
  assert(j.exec.args[1] === 5_000n * SIX, "no client: the launch value no longer refuses");
  assert(depositLimitProblem({ on: true, perDeposit: 5n, total: 10n, deposited: 0n, room: 10n }, 5n, "X", "T", 0) === null, "exactly the limit is fine");
}

// ── the cash-out fee, read live ──────────────────────────────────────────────
{
  const feeVault = (bps) => ({
    readContract: async ({ address, functionName }) => {
      assert(address === POOL && functionName === "withdrawFeeBps", "reads the vault's own fee");
      if (bps === null) throw new Error("execution reverted");
      return bps;
    },
  });
  assert((await readCashOutFeeBps(feeVault(CASH_OUT_FEE_BPS), POOL)) === 50, "a mainnet vault at 0.5%");
  const old = await readCashOutFeeBps(feeVault(25), POOL);
  assert(old === 25 && cashOutFee(100n * SIX, old) === 250_000n, "a vault still at 0.25% is priced at 0.25%, not the constant");
  await rejects(() => readCashOutFeeBps(feeVault(null), POOL), /reverted/, "a pool with no fee to read throws, so nobody prices it at the constant");
}

console.log(`limits.selftest: ok (${checks} assertions)`);
process.exit(0);
