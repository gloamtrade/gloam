/**
 * Self-test: HYPE and KNTQ open on Elysium mainnet with their live deposit
 * limits, with no deploy.
 *
 * Both are queued through the vault's guard (12 Nov 2026: HYPE 12 per deposit /
 * 600 in total, executable from 14:19 UTC; KNTQ 1,400 / 70,000 from 15:06 UTC).
 * Until each change runs, depositLimit reads 0/0 and Add must not offer it; once
 * it runs, the app's live read (hooks/useOpenGatedTokens, every minute) must
 * offer it. This walks Thursday through the same functions the hook and Add use
 * (limitGatedAssetsFor, openGatedFromReads, addableTokensFor, isNativeAddable):
 *
 *  - before: only USDC
 *  - HYPE's change runs: USDC and HYPE (native, address(0), as the vault keeps it)
 *  - KNTQ's change runs too: USDC, KNTQ and HYPE
 *  - a failed or unread limit, or one lowered back to 0, closes it again
 *
 * And what a HYPE deposit needs around it: the name, logo and price id are
 * HYPE's (never ETH's), Max keeps enough HYPE for the deposit's own gas at the
 * fixed 1.9M limit, cash-out round amounts are HYPE-sized, claim and request
 * links for HYPE work (written out in full until the SDK gives it a short id).
 *
 * Run from app/:  ../mcp/node_modules/.bin/tsx scripts/selftest-elysium-hype-kntq.mts
 */
import assert from "node:assert/strict";

// The deployed vault, the SDK's values: no NEXT_PUBLIC_ELYSIUM_* set, as production builds it.
for (const k of Object.keys(process.env)) if (k.startsWith("NEXT_PUBLIC_ELYSIUM_")) delete process.env[k];
globalThis.fetch = (async (url: unknown) => {
  throw new Error(`selftest-elysium-hype-kntq: no network calls allowed (${String(url)})`);
}) as typeof fetch;

const { ELYSIUM } = await import("../src/lib/elysium");
const tokens = await import("../src/lib/tokens");
const { nativeGasReserve, NATIVE_GAS_FLOOR, SHIELD_BOUND_GAS_LIMIT, gasFor, NATIVE_ASSET } = await import("../src/lib/shield");
const { presetsFor, HYPE_PRESETS, ETH_PRESETS } = await import("../src/lib/cashOutPrivacy");
const { requestAssetsFor, claimNetworkProblem } = await import("../src/lib/paymentRequest");
const { getNetwork } = await import("../src/lib/networks");

const ZERO = "0x0000000000000000000000000000000000000000";
const KNTQ = "0xe45a355d9e9cAd2aD85F2d03E3eE3102A036acF0";
const E18 = 10n ** 18n;

let n = 0;
function check(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      n++;
    })
    .catch((e) => {
      console.error(`FAIL ${name}`);
      throw e;
    });
}

assert.ok(ELYSIUM, "Elysium is on by default");
const CHAIN = ELYSIUM.chainId;
assert.equal(CHAIN, 99901);

/** What Add offers, by symbol, from the vault's reads: depositLimitsOn() and depositLimit(asset) for each gated asset. */
function offered(reads: Record<string, readonly [bigint, bigint] | undefined>, limitsOn: boolean | "unread" = true): string[] {
  const gated = tokens.limitGatedAssetsFor(CHAIN);
  const open = tokens.openGatedFromReads(
    gated,
    limitsOn === "unread" ? undefined : limitsOn,
    gated.map((a) => reads[a.address.toLowerCase()])
  );
  return [
    ...tokens.addableTokensFor(CHAIN, open).map((t) => t.symbol),
    ...(tokens.isNativeAddable(CHAIN, open) ? [tokens.nativeTokenFor(CHAIN).symbol] : []),
  ];
}
const k = KNTQ.toLowerCase();

await check("the live reads cover HYPE (address(0), how the vault keeps native) and KNTQ", () => {
  const gated = tokens.limitGatedAssetsFor(CHAIN).map((a) => a.address.toLowerCase());
  assert.deepEqual(gated, [ZERO, k]);
  assert.equal(NATIVE_ASSET, ZERO);
  assert.equal(tokens.supportsNativeShield(CHAIN), true, "the vault lists HYPE, so balances and holdings read it");
});

await check("before Thursday (both 0/0): Add offers USDC only", () => {
  assert.deepEqual(offered({ [ZERO]: [0n, 0n], [k]: [0n, 0n] }), ["USDC"]);
  assert.deepEqual(offered({}), ["USDC"], "unread");
  assert.deepEqual(offered({ [ZERO]: [12n * E18, 600n * E18] }, "unread"), ["USDC"], "depositLimitsOn unread");
  assert.equal(tokens.isNativeAddable(CHAIN), false, "no reads at all");
});

await check("HYPE's change runs (12 / 600): HYPE joins with no deploy", () => {
  assert.deepEqual(offered({ [ZERO]: [12n * E18, 600n * E18], [k]: [0n, 0n] }), ["USDC", "HYPE"]);
});

await check("KNTQ's change runs too (1,400 / 70,000): USDC, KNTQ and HYPE", () => {
  assert.deepEqual(offered({ [ZERO]: [12n * E18, 600n * E18], [k]: [1_400n * E18, 70_000n * E18] }), ["USDC", "KNTQ", "HYPE"]);
  assert.deepEqual(offered({ [ZERO]: [0n, 0n], [k]: [1_400n * E18, 70_000n * E18] }), ["USDC", "KNTQ"], "KNTQ alone");
});

await check("a failed read, a half-open limit or one lowered back to 0 closes it again", () => {
  assert.deepEqual(offered({ [ZERO]: undefined, [k]: [1_400n * E18, 70_000n * E18] }), ["USDC", "KNTQ"]);
  assert.deepEqual(offered({ [ZERO]: [12n * E18, 0n], [k]: [0n, 1n] }), ["USDC"]);
  assert.deepEqual(offered({ [ZERO]: [0n, 0n], [k]: [0n, 0n] }), ["USDC"], "lowerDepositLimit to 0/0 in an incident");
});

await check("HYPE is named, drawn and priced as HYPE, never ETH", () => {
  const hype = tokens.nativeTokenFor(CHAIN);
  assert.equal(hype.symbol, "HYPE");
  assert.equal(hype.id, "hype", "TokenLogo's id");
  assert.equal(hype.name, "Hyperliquid");
  assert.equal(hype.coingecko, "hyperliquid");
  assert.equal(hype.address, ZERO);
  assert.equal(getNetwork("elysium-mainnet").primaryAsset.symbol, "HYPE");
  for (const id of [4663, 8453, 1]) assert.equal(tokens.nativeTokenFor(id).symbol, "ETH", `${id}`);
});

await check("Max keeps enough HYPE for the deposit's gas at the fixed 1.9M limit", () => {
  assert.equal(gasFor(CHAIN, SHIELD_BOUND_GAS_LIMIT), 1_900_000n);
  // 0.5 gwei, Elysium's base fee: a wallet holds back 1.9M x its max fee (0.75 gwei on the 10 Nov deposit)
  const r = nativeGasReserve(CHAIN, 500_000_000n);
  assert.equal(r, 2_850_000_000_000_000n, "0.00285 HYPE");
  assert.ok(r >= 1_900_000n * 752_025_000n, "covers the max fee the 10 Nov deposit was sent with");
  assert.equal(nativeGasReserve(CHAIN), r, "unread: Elysium's 0.5 gwei");
  assert.equal(nativeGasReserve(CHAIN, null), r);
  assert.equal(nativeGasReserve(CHAIN, 2_000_000_000n), 11_400_000_000_000_000n, "follows the price up");
  assert.ok(r < E18 / 100n, "and stays a small slice of one HYPE");
});

await check("other chains keep the old 0.00005 floor unless their gas needs more", () => {
  assert.equal(NATIVE_GAS_FLOOR, 50_000_000_000_000n);
  for (const id of [4663, 8453, 1, 84532, 11155111]) assert.equal(nativeGasReserve(id), NATIVE_GAS_FLOOR, `${id} unread`);
  assert.equal(nativeGasReserve(8453, 6_000_000n), NATIVE_GAS_FLOOR, "Base at 0.006 gwei");
  // Robinhood Chain read 0.02 gwei on 11 Nov: a wallet there holds back about 1.9M x 0.03 gwei, more than the old floor
  assert.equal(nativeGasReserve(4663, 20_000_000n), 114_000_000_000_000n, "Robinhood Chain at 0.02 gwei");
  assert.equal(nativeGasReserve(1, 1_000_000_000n), 5_700_000_000_000_000n, "Ethereum at 1 gwei: what a wallet holds back");
});

await check("cash-out round amounts for HYPE are HYPE-sized", () => {
  assert.deepEqual(presetsFor(CHAIN, ZERO).values, HYPE_PRESETS);
  assert.ok(HYPE_PRESETS.every((v) => Number(v) <= 12), "each fits one deposit");
  assert.deepEqual(presetsFor(4663, ZERO).values, ETH_PRESETS);
  assert.deepEqual(presetsFor(CHAIN, KNTQ).values, [], "KNTQ has none, like other tokens");
});

await check("HYPE can be asked for, and a HYPE claim link is good on Elysium", () => {
  const net = getNetwork("elysium-mainnet");
  const assets = requestAssetsFor("elysium-mainnet");
  assert.deepEqual(assets.map((a) => a.symbol), ["USDC", "HYPE", "KNTQ"]);
  const hype = assets.find((a) => a.native)!;
  assert.equal(hype.address, ZERO);
  assert.equal(hype.decimals, 18);
  assert.equal(claimNetworkProblem({ key: "elysium-mainnet", pool: net.pool }, { pool: net.pool!, asset: ZERO, chainId: CHAIN }), null);
  assert.equal(claimNetworkProblem({ key: "elysium-mainnet", pool: net.pool }, { pool: net.pool!, asset: KNTQ, chainId: CHAIN }), null);
});

await check("Elysium testnet reads no HYPE limit (selftest-elysium-everywhere checks it never lists HYPE)", () => {
  assert.ok(!tokens.limitGatedAssetsFor(99801).some((a) => a.address === ZERO));
});

console.log(`selftest-elysium-hype-kntq: ${n} checks passed`);
