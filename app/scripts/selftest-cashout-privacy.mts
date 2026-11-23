/**
 * Self-test: the cash-out privacy kit (lib/cashOutPrivacy).
 *
 * The round amounts offered per asset (stablecoins 25 to 1,000, ETH and WETH
 * 0.01 to 0.5, none for other tokens), only up to what can be cashed out, in
 * the asset's own decimals. Then the three quiet warnings: the address is the
 * signed-in wallet, the address added money to Gloam from this browser, or
 * the amount is exactly a deposit from the last 7 days. Edge cases: no
 * history, notes of another chain or vault (same vault address, same asset
 * address), address case and spacing, rows read from the chain, payments
 * received, and dates out of range.
 *
 * Run from app/:  ../mcp/node_modules/.bin/tsx scripts/selftest-cashout-privacy.mts
 */
import assert from "node:assert/strict";
import "./browser-shim.mjs";

const kit = await import("../src/lib/cashOutPrivacy");
const {
  DEPOSIT_WALLET_TEXT,
  ETH_PRESETS,
  OWN_WALLET_TEXT,
  PRIVATE_LINE,
  SAME_AMOUNT_LOOKBACK_MS,
  STABLE_PRESETS,
  cashOutPrivacyWarnings,
  cashOutSender,
  depositWallets,
  isDepositNote,
  normAddress,
  presetAmounts,
  presetsFor,
  publicLine,
  sameAmountDeposit,
  sameAmountText,
  sameScope,
} = kit;
const { BASE_MAINNET_TOKENS, ETHEREUM_MAINNET_TOKENS, RH_MAINNET_SWAP_TOKENS, RH_MAINNET_TOKENS, TEMPO_MAINNET_TOKENS, TESTNET_STOCK_TOKENS } =
  await import("../src/lib/tokens");
type PrivacyNote = import("../src/lib/cashOutPrivacy").PrivacyNote;

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`ok  ${name}`);
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 9, 26, 12, 0, 0);

const VAULT = "0x39e28cde55cab798874746ac52cb4b5cc99a0194";
const VAULT_CHECKSUM = "0x39E28cDE55CAB798874746Ac52cB4b5CC99A0194";
const OTHER_VAULT = "0x465EbfcdE1e384C7B1e8388E1aFEA95438c7A0ef";
const BASE = 8453;
const ETHEREUM = 1;
const ETH = "0x0000000000000000000000000000000000000000";
const usdc = (chain: { address: string; symbol: string }[]) => chain.find((t) => t.symbol === "USDC")!.address;
const USDC_BASE = usdc(BASE_MAINNET_TOKENS);
const EURC_BASE = BASE_MAINNET_TOKENS.find((t) => t.symbol === "EURC")!.address;
const USDG_ETH = ETHEREUM_MAINNET_TOKENS.find((t) => t.symbol === "USDG")!.address;
const PYUSD_ETH = ETHEREUM_MAINNET_TOKENS.find((t) => t.symbol === "PYUSD")!.address;
const USDG_RH = RH_MAINNET_TOKENS.find((t) => t.symbol === "USDG")!.address;
const GLOAM_RH = RH_MAINNET_TOKENS.find((t) => t.symbol === "GLOAM")!.address;
const WETH_RH = RH_MAINNET_SWAP_TOKENS.find((t) => t.symbol === "WETH")!.address;
const USDE_RH = RH_MAINNET_SWAP_TOKENS.find((t) => t.symbol === "USDe")!.address;
const NVDA_RH = RH_MAINNET_SWAP_TOKENS.find((t) => t.symbol === "NVDA")!.address;
const OUSD_TEMPO = TEMPO_MAINNET_TOKENS.find((t) => t.symbol === "OUSD")!.address;

const ME = "0x7A3f9C21b8e04d6f5a009D2E8b4F0C3D61e9B5a7";
const ME_LOWER = ME.toLowerCase();
const OLD_WALLET = "0x1111111111111111111111111111111111111111";
const FRESH = "0x2222222222222222222222222222222222222222";
const PAYER = "0x3333333333333333333333333333333333333333";

const units = (n: number, decimals = 6) => BigInt(Math.round(n * 10 ** Math.min(decimals, 6))) * 10n ** BigInt(Math.max(0, decimals - 6));

let seq = 0;
function deposit(p: Partial<PrivacyNote> & { amount: bigint; daysAgo?: number; hoursAgo?: number }): PrivacyNote {
  const at = NOW - (p.daysAgo ?? 0) * DAY - (p.hoursAgo ?? 0) * HOUR;
  return {
    id: p.id ?? `${at}-0x${(++seq).toString(16).padStart(8, "0")}`,
    chainId: p.chainId ?? BASE,
    pool: (p.pool ?? VAULT) as `0x${string}`,
    asset: (p.asset ?? USDC_BASE) as `0x${string}`,
    amountWei: p.amount.toString(),
    createdAt: p.createdAt ?? at,
    from: (p.from ?? ME) as `0x${string}`,
    source: p.source ?? "local",
  };
}

const base = { chainId: BASE, pool: VAULT, now: NOW };

// ---------------------------------------------------------------- amounts

test("stablecoins get 25 to 1,000, up to the spendable balance", () => {
  const got = presetAmounts({ chainId: BASE, asset: USDC_BASE, spendable: units(300) });
  assert.deepEqual(got.map((x) => x.value), ["25", "50", "100", "250"]);
  assert.deepEqual(got.map((x) => x.wei), [units(25), units(50), units(100), units(250)]);
  assert.deepEqual(got.map((x) => x.label), ["25.00", "50.00", "100.00", "250.00"]);
});

test("a preset equal to the balance is offered; one over it is not", () => {
  assert.deepEqual(presetAmounts({ chainId: BASE, asset: USDC_BASE, spendable: units(250) }).map((x) => x.value), ["25", "50", "100", "250"]);
  assert.deepEqual(presetAmounts({ chainId: BASE, asset: USDC_BASE, spendable: units(249.99) }).map((x) => x.value), ["25", "50", "100"]);
  assert.deepEqual(presetAmounts({ chainId: BASE, asset: USDC_BASE, spendable: units(24.99) }), []);
  assert.deepEqual(presetAmounts({ chainId: BASE, asset: USDC_BASE, spendable: 0n }), []);
});

test("1,000 is labelled 1,000.00, two places with a separator, and the field gets plain digits", () => {
  const got = presetAmounts({ chainId: ETHEREUM, asset: USDG_ETH, spendable: units(5000) });
  assert.deepEqual(got.map((x) => x.value), [...STABLE_PRESETS]);
  const top = got.at(-1)!;
  assert.equal(top.label, "1,000.00");
  assert.equal(top.value, "1000");
  assert.equal(top.wei, 1_000_000_000n);
});

test("every listed stablecoin gets the same sizes: USDG, PYUSD, EURC, OUSD, USDe (18 decimals)", () => {
  for (const [chainId, asset] of [
    [ETHEREUM, USDG_ETH],
    [ETHEREUM, PYUSD_ETH],
    [BASE, EURC_BASE],
    [4663, USDG_RH],
    [4217, OUSD_TEMPO],
  ] as const) {
    assert.deepEqual(presetsFor(chainId, asset).values, STABLE_PRESETS, `${chainId} ${asset}`);
  }
  const usde = presetAmounts({ chainId: 4663, asset: USDE_RH, spendable: 10n ** 21n });
  assert.equal(usde[0]!.wei, 25n * 10n ** 18n);
  assert.equal(usde.length, 6, "a balance of exactly 1,000 USDe offers all six, 1,000 included");
});

test("ETH and WETH get 0.01 to 0.5, in 18 decimals", () => {
  const eth = presetAmounts({ chainId: BASE, asset: ETH, spendable: 2n * 10n ** 17n });
  assert.deepEqual(eth.map((x) => x.value), ["0.01", "0.05", "0.1"]);
  assert.deepEqual(eth.map((x) => x.wei), [10n ** 16n, 5n * 10n ** 16n, 10n ** 17n]);
  assert.deepEqual(eth.map((x) => x.label), ["0.01", "0.05", "0.10"]);
  const weth = presetAmounts({ chainId: 4663, asset: WETH_RH, spendable: 10n ** 18n });
  assert.deepEqual(weth.map((x) => x.value), [...ETH_PRESETS]);
  assert.deepEqual(presetAmounts({ chainId: BASE, asset: ETH, spendable: 10n ** 16n - 1n }), []);
});

test("other tokens get no presets (Max only): $GLOAM, stock tokens, an unknown address", () => {
  assert.deepEqual(presetAmounts({ chainId: 4663, asset: GLOAM_RH, spendable: 10n ** 24n }), []);
  assert.deepEqual(presetAmounts({ chainId: 4663, asset: NVDA_RH, spendable: 10n ** 24n }), []);
  assert.deepEqual(presetAmounts({ chainId: 46630, asset: TESTNET_STOCK_TOKENS[0]!.address, spendable: 10n ** 24n }), []);
  assert.deepEqual(presetAmounts({ chainId: BASE, asset: "0x4444444444444444444444444444444444444444", spendable: 10n ** 24n }), []);
});

test("an asset address in any case finds its token", () => {
  assert.deepEqual(presetsFor(BASE, USDC_BASE.toLowerCase()).values, STABLE_PRESETS);
  assert.deepEqual(presetsFor(BASE, USDC_BASE.toUpperCase().replace("0X", "0x")).values, STABLE_PRESETS);
});

// ---------------------------------------------------------------- addresses

test("addresses compare in any case and with stray spaces; anything else is not an address", () => {
  assert.equal(normAddress(` ${ME} `), ME_LOWER);
  assert.equal(normAddress(ME.toUpperCase().replace("0X", "0x")), ME_LOWER);
  assert.equal(normAddress("0x123"), null);
  assert.equal(normAddress(""), null);
  assert.equal(normAddress(null), null);
  assert.equal(normAddress(`${ME}00`), null);
});

test("a note is in scope only on the same chain and the same vault (vault in any case)", () => {
  assert.equal(sameScope({ chainId: BASE, pool: VAULT_CHECKSUM as `0x${string}` }, { chainId: BASE, pool: VAULT }), true);
  assert.equal(sameScope({ chainId: ETHEREUM, pool: VAULT as `0x${string}` }, { chainId: BASE, pool: VAULT }), false);
  assert.equal(sameScope({ chainId: BASE, pool: OTHER_VAULT as `0x${string}` }, { chainId: BASE, pool: VAULT }), false);
  assert.equal(sameScope({ chainId: BASE, pool: VAULT as `0x${string}` }, { chainId: BASE, pool: null }), false);
});

test("deposits are deposit notes and rows read from the chain; claims, change and splits are not", () => {
  assert.equal(isDepositNote({ id: `${NOW}-0xabcdef12`, source: "local" }), true);
  assert.equal(isDepositNote({ id: "vt-1", source: "local" }), true, "a reshield after a public swap");
  assert.equal(isDepositNote({ id: "chain-0xaa-3", source: "chain" }), true);
  assert.equal(isDepositNote({ id: "imp-abc", source: "local" }), false, "a payment claimed here");
  assert.equal(isDepositNote({ id: "chg-1", source: "local" }), false);
  assert.equal(isDepositNote({ id: "co-1", source: "local" }), false);
});

// ---------------------------------------------------------------- the warnings

test("no history: only the signed-in wallet is flagged", () => {
  assert.deepEqual(cashOutPrivacyWarnings({ ...base, to: FRESH, connected: ME, amountWei: units(100), asset: USDC_BASE, notes: [] }), []);
  const own = cashOutPrivacyWarnings({ ...base, to: ME, connected: ME, amountWei: units(100), asset: USDC_BASE, notes: [] });
  assert.deepEqual(own.map((w) => w.kind), ["own-wallet"]);
  assert.equal(own[0]!.text, OWN_WALLET_TEXT);
  assert.equal(own[0]!.aboutAddress, true);
});

test("the signed-in wallet matches whatever the case of either address", () => {
  const w = cashOutPrivacyWarnings({ ...base, to: ME_LOWER, connected: ME, amountWei: null, asset: USDC_BASE, notes: [] });
  assert.deepEqual(w.map((x) => x.kind), ["own-wallet"]);
  const w2 = cashOutPrivacyWarnings({ ...base, to: ME, connected: ME_LOWER, amountWei: null, asset: USDC_BASE, notes: [] });
  assert.deepEqual(w2.map((x) => x.kind), ["own-wallet"]);
  assert.equal(w[0]!.key, w2[0]!.key, "one key whatever the case");
});

test("no address yet, or no wallet signed in: no address warning", () => {
  assert.deepEqual(cashOutPrivacyWarnings({ ...base, to: null, connected: ME, amountWei: null, asset: USDC_BASE, notes: [] }), []);
  assert.deepEqual(cashOutPrivacyWarnings({ ...base, to: "0xnot-an-address", connected: ME, amountWei: null, asset: USDC_BASE, notes: [] }), []);
  assert.deepEqual(cashOutPrivacyWarnings({ ...base, to: FRESH, connected: null, amountWei: null, asset: USDC_BASE, notes: [] }), []);
});

test("a wallet this browser added money from is flagged, spent or not, in any case", () => {
  const notes = [deposit({ amount: units(40), from: OLD_WALLET, daysAgo: 60 })];
  const w = cashOutPrivacyWarnings({ ...base, to: OLD_WALLET.toUpperCase().replace("0X", "0x"), connected: ME, amountWei: units(10), asset: USDC_BASE, notes });
  assert.deepEqual(w.map((x) => x.kind), ["deposit-wallet"]);
  assert.equal(w[0]!.text, DEPOSIT_WALLET_TEXT);
  assert.equal(w[0]!.key, `deposit-wallet:${OLD_WALLET}`);
  assert.deepEqual([...depositWallets(notes, base)], [OLD_WALLET]);
});

test("a deposit read from the chain flags its wallet too", () => {
  const notes = [deposit({ id: "chain-0xab-7", source: "chain", amount: units(40), from: OLD_WALLET })];
  assert.deepEqual(cashOutPrivacyWarnings({ ...base, to: OLD_WALLET, connected: ME, amountWei: null, asset: USDC_BASE, notes }).map((x) => x.kind), ["deposit-wallet"]);
});

test("a deposit on another chain, or another vault on this chain, does not flag the wallet", () => {
  const otherChain = [deposit({ amount: units(40), from: OLD_WALLET, chainId: ETHEREUM })];
  assert.deepEqual(cashOutPrivacyWarnings({ ...base, to: OLD_WALLET, connected: ME, amountWei: null, asset: USDC_BASE, notes: otherChain }), []);
  const otherVault = [deposit({ amount: units(40), from: OLD_WALLET, pool: OTHER_VAULT })];
  assert.deepEqual(cashOutPrivacyWarnings({ ...base, to: OLD_WALLET, connected: ME, amountWei: null, asset: USDC_BASE, notes: otherVault }), []);
  const checksummedVault = [deposit({ amount: units(40), from: OLD_WALLET, pool: VAULT_CHECKSUM })];
  assert.deepEqual(cashOutPrivacyWarnings({ ...base, to: OLD_WALLET, connected: ME, amountWei: null, asset: USDC_BASE, notes: checksummedVault }).map((x) => x.kind), ["deposit-wallet"]);
});

test("a wallet that only claimed a payment here is not a depositing wallet", () => {
  const notes = [deposit({ id: "imp-claim-1", amount: units(40), from: OLD_WALLET })];
  assert.deepEqual(cashOutPrivacyWarnings({ ...base, to: OLD_WALLET, connected: ME, amountWei: null, asset: USDC_BASE, notes }), []);
});

test("the signed-in wallet that also deposited gets one line, the signed-in one", () => {
  const notes = [deposit({ amount: units(40), from: ME })];
  const w = cashOutPrivacyWarnings({ ...base, to: ME, connected: ME, amountWei: null, asset: USDC_BASE, notes });
  assert.deepEqual(w.map((x) => x.kind), ["own-wallet"]);
});

test("the exact amount of a deposit from the last 7 days is flagged, with when", () => {
  const notes = [deposit({ amount: units(123.45), daysAgo: 2 })];
  const w = cashOutPrivacyWarnings({ ...base, to: FRESH, connected: ME, amountWei: units(123.45), asset: USDC_BASE, notes });
  assert.deepEqual(w.map((x) => x.kind), ["same-amount"]);
  assert.equal(w[0]!.aboutAddress, false);
  assert.equal(w[0]!.text, sameAmountText(NOW - 2 * DAY, NOW));
  assert.match(w[0]!.text, /^You added this exact amount on Oct 24\. A different or rounder amount is harder to match\.$/);
  const recent = cashOutPrivacyWarnings({
    ...base,
    to: FRESH,
    connected: ME,
    amountWei: units(50),
    asset: USDC_BASE,
    notes: [deposit({ amount: units(50), hoursAgo: 2 })],
  });
  assert.match(recent[0]!.text, /^You added this exact amount about 2 hours ago\./);
});

test("an amount one cent off, or a deposit older than 7 days, is not flagged", () => {
  const notes = [deposit({ amount: units(100), daysAgo: 1 })];
  assert.deepEqual(cashOutPrivacyWarnings({ ...base, to: FRESH, connected: ME, amountWei: units(100) - 10_000n, asset: USDC_BASE, notes }), []);
  assert.deepEqual(cashOutPrivacyWarnings({ ...base, to: FRESH, connected: ME, amountWei: units(100) + 1n, asset: USDC_BASE, notes }), []);
  const old = [deposit({ amount: units(100), createdAt: NOW - SAME_AMOUNT_LOOKBACK_MS - 1 })];
  assert.deepEqual(cashOutPrivacyWarnings({ ...base, to: FRESH, connected: ME, amountWei: units(100), asset: USDC_BASE, notes: old }), []);
  const edge = [deposit({ amount: units(100), createdAt: NOW - SAME_AMOUNT_LOOKBACK_MS })];
  assert.deepEqual(cashOutPrivacyWarnings({ ...base, to: FRESH, connected: ME, amountWei: units(100), asset: USDC_BASE, notes: edge }).map((x) => x.kind), ["same-amount"]);
});

test("the same amount of another asset, chain or vault is not flagged; the asset compares in any case", () => {
  const amount = units(100);
  const eurc = [deposit({ amount, asset: EURC_BASE })];
  assert.deepEqual(cashOutPrivacyWarnings({ ...base, to: FRESH, connected: ME, amountWei: amount, asset: USDC_BASE, notes: eurc }), []);
  // ETH sits at the zero address on Base and on Ethereum, behind the same vault address
  const ethOnEthereum = [deposit({ amount: 10n ** 17n, asset: ETH, chainId: ETHEREUM })];
  assert.deepEqual(cashOutPrivacyWarnings({ ...base, to: FRESH, connected: ME, amountWei: 10n ** 17n, asset: ETH, notes: ethOnEthereum }), []);
  const ethOnBase = [deposit({ amount: 10n ** 17n, asset: ETH })];
  assert.deepEqual(cashOutPrivacyWarnings({ ...base, to: FRESH, connected: ME, amountWei: 10n ** 17n, asset: ETH, notes: ethOnBase }).map((x) => x.kind), ["same-amount"]);
  const otherVault = [deposit({ amount, pool: OTHER_VAULT })];
  assert.deepEqual(cashOutPrivacyWarnings({ ...base, to: FRESH, connected: ME, amountWei: amount, asset: USDC_BASE, notes: otherVault }), []);
  const lower = [deposit({ amount, asset: USDC_BASE.toLowerCase() as `0x${string}` })];
  assert.deepEqual(cashOutPrivacyWarnings({ ...base, to: FRESH, connected: ME, amountWei: amount, asset: USDC_BASE, notes: lower }).map((x) => x.kind), ["same-amount"]);
});

test("rows read from the chain (no real date), payments received and change are not deposits to match", () => {
  const amount = units(100);
  const notes = [
    deposit({ id: "chain-0xcd-1", source: "chain", amount }),
    deposit({ id: "imp-payment-1", amount }),
    deposit({ id: "chg-1", amount }),
  ];
  assert.equal(sameAmountDeposit(notes, { ...base, asset: USDC_BASE, amountWei: amount }), null);
  assert.deepEqual(cashOutPrivacyWarnings({ ...base, to: FRESH, connected: ME, amountWei: amount, asset: USDC_BASE, notes }), []);
});

test("a deposit dated in the future, a bad amount or a bad date is skipped", () => {
  const amount = units(100);
  const notes = [
    deposit({ amount, createdAt: NOW + HOUR }),
    { ...deposit({ amount }), amountWei: "not-a-number" },
    { ...deposit({ amount }), createdAt: Number.NaN },
  ];
  assert.equal(sameAmountDeposit(notes, { ...base, asset: USDC_BASE, amountWei: amount }), null);
});

test("the newest matching deposit names the time", () => {
  const amount = units(25);
  const notes = [deposit({ amount, daysAgo: 5 }), deposit({ amount, daysAgo: 1 }), deposit({ amount, daysAgo: 3 })];
  const got = sameAmountDeposit(notes, { ...base, asset: USDC_BASE, amountWei: amount });
  assert.equal(got!.createdAt, NOW - DAY);
});

test("no amount yet, or zero: no amount warning", () => {
  const notes = [deposit({ amount: 0n })];
  assert.deepEqual(cashOutPrivacyWarnings({ ...base, to: FRESH, connected: ME, amountWei: null, asset: USDC_BASE, notes }), []);
  assert.deepEqual(cashOutPrivacyWarnings({ ...base, to: FRESH, connected: ME, amountWei: 0n, asset: USDC_BASE, notes }), []);
  assert.deepEqual(cashOutPrivacyWarnings({ ...base, to: FRESH, connected: ME, amountWei: units(1), asset: null, notes }), []);
});

test("address and amount together: the address line first, then the amount; keys are distinct", () => {
  const amount = units(500);
  const notes = [deposit({ amount, from: OLD_WALLET, daysAgo: 1 })];
  const w = cashOutPrivacyWarnings({ ...base, to: OLD_WALLET, connected: ME, amountWei: amount, asset: USDC_BASE, notes });
  assert.deepEqual(w.map((x) => x.kind), ["deposit-wallet", "same-amount"]);
  assert.equal(new Set(w.map((x) => x.key)).size, 2);
  const other = cashOutPrivacyWarnings({ ...base, to: PAYER, connected: PAYER, amountWei: amount, asset: USDC_BASE, notes });
  assert.deepEqual(other.map((x) => x.kind), ["own-wallet", "same-amount"]);
  assert.notEqual(other[0]!.key, w[0]!.key, "another address is another warning, even if one was dismissed");
});

// ---------------------------------------------------------------- what goes public

test("who sends it: the relay, the wallet, or the wallet for the first step of a part cashed out later", () => {
  // Hide my wallet on: the relay sends every step, now or later
  assert.equal(cashOutSender({ relayOn: true, pieces: false, later: false, partial: true }), "relay");
  assert.equal(cashOutSender({ relayOn: true, pieces: false, later: true, partial: true }), "relay");
  // pieces always go through the relay
  assert.equal(cashOutSender({ relayOn: false, pieces: true, later: false, partial: true }), "relay");
  // off, now: the wallet sends it (and the split before it)
  assert.equal(cashOutSender({ relayOn: false, pieces: false, later: false, partial: false }), "wallet");
  assert.equal(cashOutSender({ relayOn: false, pieces: false, later: false, partial: true }), "wallet");
  // off, later: the whole balance waits with the relay; a part is split off from the wallet right away
  assert.equal(cashOutSender({ relayOn: false, pieces: false, later: true, partial: false }), "relay");
  assert.equal(cashOutSender({ relayOn: false, pieces: false, later: true, partial: true }), "wallet-first-step");
});

test("the public line names the asset, the amount, the address and the time, and the wallet when it sends", () => {
  assert.equal(publicLine({ sender: "relay" }), "Which asset, the amount, where it goes and when.");
  assert.equal(publicLine({ sender: "wallet" }), "Which asset, the amount, where it goes and when, and your wallet, which sends it.");
  assert.equal(
    publicLine({ sender: "wallet-first-step" }),
    "Which asset, the amount, where it goes and when. The first step, setting the amount aside, leaves from your wallet now."
  );
  assert.equal(publicLine({ sender: "relay", pieces: true }), "Which asset, each piece's amount, where it goes and when.");
  assert.equal(PRIVATE_LINE, "Which deposit it came from, and your other balance and payments.");
});

test("the copy stays plain: no em dashes, no promises the chain can't keep", () => {
  const lines = [
    OWN_WALLET_TEXT,
    DEPOSIT_WALLET_TEXT,
    sameAmountText(NOW - DAY, NOW),
    PRIVATE_LINE,
    ...(["relay", "wallet", "wallet-first-step"] as const).flatMap((sender) => [publicLine({ sender }), publicLine({ sender, pieces: true })]),
  ];
  for (const l of lines) {
    assert.doesNotMatch(l, /\u2014/);
    assert.doesNotMatch(l, /anonymous|untraceable|hides how much/i);
  }
});

console.log(`\n${passed} passed`);
