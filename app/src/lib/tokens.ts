import { ELYSIUM, ELYSIUM_TESTNET, isElysiumChainId, isElysiumFamilyChainId, isElysiumTestnetChainId } from "./elysium";

/**
 * Robinhood Chain testnet stock tokens (from public explorer / faucet).
 * Balances are real onchain. USD marks use live equity prices.
 */
export type OnchainToken = {
  id: string;
  symbol: string;
  name: string;
  address: `0x${string}`;
  decimals: number;
  yahoo: string;
  /** A tokenized stock, a dollar stablecoin, or another token ($GLOAM). */
  kind: "stock" | "stablecoin" | "token";
  /** CoinGecko's id, for a live USD price where the markets feed has none. */
  coingecko?: string;
  /** A stablecoin pegged to another currency (EURC: the euro), so never counted as $1. */
  peg?: "EUR";
  /**
   * approve() refuses to change one non-zero allowance into another (Tether's
   * USDT on Ethereum), so a stale allowance goes to 0 before a deposit's approve.
   */
  approveResetFirst?: true;
  /**
   * Listed before the vault takes it: its deposit limit is queued through the
   * vault's 3-day timelock and is 0 until it lands. Add (and every flow that
   * starts from a deposit) offers it only once the pool's live
   * depositLimit(token) is above 0 (hooks/useOpenGatedTokens). Balances, private
   * sends and cash-outs never depend on the limit.
   */
  opensWithLimit?: true;
};

/** Worth one dollar each: a dollar stablecoin. EURC is a stablecoin, but not one of these. */
export function isDollarStable(t: Pick<OnchainToken, "kind" | "peg">): boolean {
  return t.kind === "stablecoin" && !t.peg;
}

export const TESTNET_STOCK_TOKENS: OnchainToken[] = [
  {
    id: "tsla",
    symbol: "TSLA",
    name: "Tesla",
    address: "0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E",
    decimals: 18,
    yahoo: "TSLA",
    kind: "stock",
  },
  {
    id: "amzn",
    symbol: "AMZN",
    name: "Amazon",
    address: "0x5884aD2f920c162CFBbACc88C9C51AA75eC09E02",
    decimals: 18,
    yahoo: "AMZN",
    kind: "stock",
  },
  {
    id: "pltr",
    symbol: "PLTR",
    name: "Palantir",
    address: "0x1FBE1a0e43594b3455993B5dE5Fd0A7A266298d0",
    decimals: 18,
    yahoo: "PLTR",
    kind: "stock",
  },
  {
    id: "nflx",
    symbol: "NFLX",
    name: "Netflix",
    address: "0x3b8262A63d25f0477c4DDE23F83cfe22Cb768C93",
    decimals: 18,
    yahoo: "NFLX",
    kind: "stock",
  },
  {
    id: "amd",
    symbol: "AMD",
    name: "AMD",
    address: "0x71178BAc73cBeb415514eB542a8995b82669778d",
    decimals: 18,
    yahoo: "AMD",
    kind: "stock",
  },
];

/**
 * Tempo Moderato faucet stablecoins (6 decimals), from tempo_fundAddress, OUSD first. These
 * are what Gloam shields on Tempo, since Tempo blocks native msg.value.
 */
export const TEMPO_STABLE_TOKENS: OnchainToken[] = [
  // OpenUSD (Open Standard), Tempo's recommended stablecoin; same address on mainnet and Moderato.
  { id: "ousd", symbol: "OUSD", name: "Open USD", address: "0x20c0000000000000000000006a37da5c996874be", decimals: 6, yahoo: "", kind: "stablecoin" },
  { id: "pathusd", symbol: "PathUSD", name: "Path USD", address: "0x20c0000000000000000000000000000000000000", decimals: 6, yahoo: "", kind: "stablecoin" },
  { id: "alphausd", symbol: "AlphaUSD", name: "Alpha USD", address: "0x20c0000000000000000000000000000000000001", decimals: 6, yahoo: "", kind: "stablecoin" },
  { id: "betausd", symbol: "BetaUSD", name: "Beta USD", address: "0x20c0000000000000000000000000000000000002", decimals: 6, yahoo: "", kind: "stablecoin" },
  { id: "thetausd", symbol: "ThetaUSD", name: "Theta USD", address: "0x20c0000000000000000000000000000000000003", decimals: 6, yahoo: "", kind: "stablecoin" },
];

/**
 * Paxos Global Dollar (USDG) on Robinhood Chain testnet, from Paxos's testnet docs
 * (docs.paxos.com/guides/stablecoin/usdg/testnet); test USDG from faucet.paxos.com.
 * The stablecoin Gloam leads with on Robinhood Chain (payroll, private pay).
 */
export const RH_STABLE_TOKENS: OnchainToken[] = [
  { id: "usdg", symbol: "USDG", name: "Global Dollar", address: "0x7E955252E15c84f5768B83c41a71F9eba181802F", decimals: 6, yahoo: "", kind: "stablecoin" },
];

export const PAXOS_FAUCET_URL = "https://faucet.paxos.com/";

/**
 * $PONS and $CASHCAT: launcher ERC-20s the vault has held limits for since they
 * opened as swap assets on 2026-10-27. Listed in Add and still swap tokens, so
 * one record serves both lists.
 */
const PONS: OnchainToken = { id: "pons", symbol: "PONS", name: "Pons", address: "0x39dBED3a2bd333467115dE45665cC57F813C4571", decimals: 18, yahoo: "", kind: "token", coingecko: "pons" };
const CASHCAT: OnchainToken = { id: "cashcat", symbol: "CASHCAT", name: "Cash Cat", address: "0x020bfC650A365f8BB26819deAAbF3E21291018b4", decimals: 18, yahoo: "", kind: "token", coingecko: "cash-cat" };

/**
 * Robinhood Chain mainnet (4663): exactly what the mainnet pool lists. USDG and
 * $GLOAM, PONS, CASHCAT, AI and ORBIO (AI and ORBIO open since 2026-11-03), and
 * San Verano's $GRIFT once its limit lands. Native ETH is listed too
 * (supportsNativeShield) and opened with AI and ORBIO (isNativeAddable). The app reads every limit from the pool
 * (see ShieldView); the values are in RH_MAINNET_ASSETS (packages/sdk).
 */
export const RH_MAINNET_TOKENS: OnchainToken[] = [
  { id: "usdg", symbol: "USDG", name: "Global Dollar", address: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", decimals: 6, yahoo: "", kind: "stablecoin" },
  { id: "gloam", symbol: "GLOAM", name: "Gloam", address: "0xDcD885F5c60b3aD49F6D58718696417314e8724d", decimals: 18, yahoo: "", kind: "token", coingecko: "gloam" },
  // San Verano's $GRIFT: a plain OpenZeppelin ERC-20 (Pons v2 launcher, Sourcify exact match), no
  // transfer fee or rebasing. Its limit goes through the timelock (NoDepositLimits), so Add offers it
  // only once that lands (opensWithLimit).
  { id: "grift", symbol: "GRIFT", name: "grift.world", address: "0x9f4BA41F91a59A34e17eE8C9EB3A51363B11aBD5", decimals: 18, yahoo: "", kind: "token", coingecko: "grift-world", opensWithLimit: true },
  PONS,
  CASHCAT,
  // Artificial Inu: a clone of Doppler's DopplerERC20V1, no mint, no transfer fee, no rebasing. Its
  // limit goes through the timelock (QueueRobinhoodAssets), so Add offers it only once that lands.
  { id: "ai", symbol: "AI", name: "Artificial Inu", address: "0x2E8c31162b855A2ffa90F6F8634643Ad6F111e18", decimals: 18, yahoo: "", kind: "token", coingecko: "artificial-inu-3", opensWithLimit: true },
  // Orbio.so: a plain OpenZeppelin ERC-20 (Pons v2 launcher, Sourcify exact match), no owner. Same as AI.
  { id: "orbio", symbol: "ORBIO", name: "Orbio.so", address: "0xAa07A0e9209e16aC99708C3EC70159c6eF3128A3", decimals: 18, yahoo: "", kind: "token", coingecko: "orbio-so", opensWithLimit: true },
];

/**
 * Robinhood Chain mainnet tokens a private swap can land in past USDG and $GLOAM
 * (lib/vaultSwap RH_SWAP_ASSETS_V2): named here so a note in one shows with its
 * symbol and decimals everywhere. Add lists only PONS and CASHCAT of these. WETH is the chain's canonical
 * wrapped ETH (Arbitrum's aeWETH), the form ETH takes in the vault. The stock
 * tokens are Robinhood's: balances never rebase, but each has a uiMultiplier
 * (splits, dividends) that wallets show balances with, so one raw token is
 * worth the share price times uiMultiplier / 1e18 (lib/stockMultiplier).
 */
export const RH_MAINNET_SWAP_TOKENS: OnchainToken[] = [
  { id: "weth", symbol: "WETH", name: "Wrapped Ether", address: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73", decimals: 18, yahoo: "", kind: "token", coingecko: "ethereum" },
  { id: "usde", symbol: "USDe", name: "USDe", address: "0x5d3a1Ff2b6BAb83b63cd9AD0787074081a52ef34", decimals: 18, yahoo: "", kind: "stablecoin", coingecko: "ethena-usde" },
  { id: "u", symbol: "U", name: "United Stables", address: "0xcE24439F2D9C6a2289F741120FE202248B666666", decimals: 18, yahoo: "", kind: "stablecoin", coingecko: "united-stables" },
  { id: "cbbtc", symbol: "cbBTC", name: "Coinbase Wrapped BTC", address: "0xCEC185eB182c47d1bA1EFc84e6959e18cd620Be4", decimals: 8, yahoo: "", kind: "token", coingecko: "coinbase-wrapped-btc" },
  PONS,
  CASHCAT,
  { id: "virtual", symbol: "VIRTUAL", name: "Virtuals Protocol", address: "0xc6911796042b15d7Fa4F6CDe69e245DdCd3d9c31", decimals: 18, yahoo: "", kind: "token", coingecko: "virtual-protocol" },
  { id: "spy", symbol: "SPY", name: "SPDR S&P 500 ETF Trust", address: "0x117cc2133c37B721F49dE2A7a74833232B3B4C0C", decimals: 18, yahoo: "SPY", kind: "stock", coingecko: "spdr-s-p-500-etf-trust-robinhood-tokenized-stock" },
  { id: "nvda", symbol: "NVDA", name: "NVIDIA", address: "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC", decimals: 18, yahoo: "NVDA", kind: "stock", coingecko: "nvidia-robinhood-tokenized-stock" },
  { id: "tsla", symbol: "TSLA", name: "Tesla", address: "0x322F0929c4625eD5bAd873c95208D54E1c003b2d", decimals: 18, yahoo: "TSLA", kind: "stock", coingecko: "tesla-robinhood-tokenized-stock" },
  { id: "amzn", symbol: "AMZN", name: "Amazon", address: "0x12f190a9F9d7D37a250758b26824B97CE941bF54", decimals: 18, yahoo: "AMZN", kind: "stock", coingecko: "amazon-robinhood-tokenized-stock" },
  { id: "spcx", symbol: "SPCX", name: "Space Exploration Technologies Corp. Class A Common Stock", address: "0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa", decimals: 18, yahoo: "", kind: "stock", coingecko: "spacex-robinhood-tokenized-stock" },
  { id: "crcl", symbol: "CRCL", name: "Circle Internet Group", address: "0xdF0992E440dD0be65BD8439b609d6D4366bf1CB5", decimals: 18, yahoo: "CRCL", kind: "stock", coingecko: "circle-internet-group-robinhood-tokenized-stock" },
  { id: "meta", symbol: "META", name: "Meta Platforms", address: "0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35", decimals: 18, yahoo: "META", kind: "stock", coingecko: "meta-platforms-robinhood-tokenized-stock" },
  { id: "mstr", symbol: "MSTR", name: "Strategy Inc.", address: "0xec262a75e413fAfD0dF80480274532C79D42da09", decimals: 18, yahoo: "MSTR", kind: "stock", coingecko: "strategy-inc-robinhood-tokenized-stock" },
  { id: "googl", symbol: "GOOGL", name: "Alphabet Class A", address: "0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3", decimals: 18, yahoo: "GOOGL", kind: "stock", coingecko: "alphabet-class-a-robinhood-tokenized-stock" },
  { id: "aapl", symbol: "AAPL", name: "Apple", address: "0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9", decimals: 18, yahoo: "AAPL", kind: "stock", coingecko: "apple-robinhood-tokenized-stock" },
  { id: "msft", symbol: "MSFT", name: "Microsoft", address: "0xe93237C50D904957Cf27E7B1133b510C669c2e74", decimals: 18, yahoo: "MSFT", kind: "stock", coingecko: "microsoft-robinhood-tokenized-stock" },
  { id: "pltr", symbol: "PLTR", name: "Palantir Technologies", address: "0x894E1EC2D74FFE5AEF8Dc8A9e84686acCB964F2A", decimals: 18, yahoo: "PLTR", kind: "stock", coingecko: "palantir-technologies-robinhood-tokenized-stock" },
  { id: "amd", symbol: "AMD", name: "AMD", address: "0x86923f96303D656E4aa86D9d42D1e57ad2023fdC", decimals: 18, yahoo: "AMD", kind: "stock", coingecko: "amd-robinhood-tokenized-stock" },
  { id: "coin", symbol: "COIN", name: "Coinbase", address: "0x6330D8C3178a418788dF01a47479c0ce7CCF450b", decimals: 18, yahoo: "COIN", kind: "stock", coingecko: "coinbase-robinhood-tokenized-stock" },
  { id: "amc", symbol: "AMC", name: "AMC Entertainment Holdings, Inc.", address: "0x05a3d1Cd21d0C88145E82600E62e7E496e0F222B", decimals: 18, yahoo: "AMC", kind: "stock", coingecko: "amc-entertainment-holdings-inc-robinhood-token" },
  { id: "hims", symbol: "HIMS", name: "Hims & Hers Health", address: "0xCceE82fE024c36fA15E1005edE3E9e4787e23D09", decimals: 18, yahoo: "HIMS", kind: "stock", coingecko: "hims-hers-health-inc-robinhood-token" },
  { id: "intc", symbol: "INTC", name: "Intel", address: "0xc72b96e0E48ecd4DC75E1e45396e26300BC39681", decimals: 18, yahoo: "INTC", kind: "stock", coingecko: "intel-robinhood-tokenized-stock" },
  { id: "tsm", symbol: "TSM", name: "Taiwan Semiconductor Manufacturing", address: "0x58FfE4a942d3885bAa22D7520691F611EF09e7AA", decimals: 18, yahoo: "TSM", kind: "stock", coingecko: "taiwan-semiconductor-manufacturing-robinhood-tokenized-stock" },
  { id: "gld", symbol: "GLD", name: "SPDR Gold Shares", address: "0xC9a981FEE1F9DEc688bb123ccDeCc63D0deBFC4e", decimals: 18, yahoo: "GLD", kind: "stock", coingecko: "spdr-gold-shares-robinhood-token" },
  { id: "mu", symbol: "MU", name: "Micron Technology", address: "0xfF080c8ce2E5feadaCa0Da81314Ae59D232d4afD", decimals: 18, yahoo: "MU", kind: "stock", coingecko: "micron-technology-robinhood-tokenized-stock" },
];

/**
 * Tempo mainnet (4217): the four TIP-20 stablecoins the mainnet pool lists, 6
 * decimals each. Deposit limits: 50,000 per deposit / 2,500,000 in total for each.
 */
export const TEMPO_MAINNET_TOKENS: OnchainToken[] = [
  { id: "usdce", symbol: "USDC.e", name: "Bridged USDC", address: "0x20c000000000000000000000b9537d11c60e8b50", decimals: 6, yahoo: "", kind: "stablecoin" },
  { id: "pathusd", symbol: "pathUSD", name: "Path USD", address: "0x20c0000000000000000000000000000000000000", decimals: 6, yahoo: "", kind: "stablecoin" },
  { id: "usdt0", symbol: "USDT0", name: "USDT0", address: "0x20c00000000000000000000014f22ca97301eb73", decimals: 6, yahoo: "", kind: "stablecoin" },
  { id: "ousd", symbol: "OUSD", name: "Open USD", address: "0x20c0000000000000000000006a37da5c996874be", decimals: 6, yahoo: "", kind: "stablecoin" },
];

/**
 * Beldex's BDX on Base and Ethereum: one LayerZero OFT at the same address on
 * both, 9 decimals, checked on chain 2026-10-29 (Sourcify exact match,
 * contracts/MyOFT.sol:BELDEX). A plain OpenZeppelin ERC-20: no transfer fee, no
 * rebasing. Beldex's owner (a Safe) can mint, and pause, which stops only mint
 * and burn, never transfers. Its limit (100,000 per deposit / 2,000,000 in
 * total) goes through the vault timelock (contracts/script/QueueBDX.s.sol), so
 * Add offers it only once that lands (opensWithLimit).
 */
const BDX: OnchainToken = {
  id: "bdx",
  symbol: "BDX",
  name: "Beldex",
  address: "0x6ad12E761b438beA3EA09F6C6266556Bb24C2181",
  decimals: 9,
  yahoo: "",
  kind: "token",
  coingecko: "beldex",
  opensWithLimit: true,
};

/**
 * Base mainnet (8453): the stablecoins the mainnet pool lists, 6 decimals each,
 * checked on chain 2026-10-24. USDC and EURC are Circle's own (Circle can
 * blacklist an address); USDT is Tether bridged from Ethereum over Base's
 * standard bridge. Native ETH is listed too (supportsNativeShield). Deposit limits:
 * 50,000 per deposit / 2,500,000 in total for each stablecoin, 20 / 1,000 ETH. Then BDX,
 * taken once its limit lands.
 */
export const BASE_MAINNET_TOKENS: OnchainToken[] = [
  { id: "usdc", symbol: "USDC", name: "USD Coin", address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6, yahoo: "", kind: "stablecoin" },
  { id: "eurc", symbol: "EURC", name: "Euro Coin", address: "0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42", decimals: 6, yahoo: "", kind: "stablecoin", coingecko: "euro-coin", peg: "EUR" },
  { id: "usdt", symbol: "USDT", name: "Tether USD", address: "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2", decimals: 6, yahoo: "", kind: "stablecoin" },
  BDX,
];

/**
 * Base Sepolia (84532): Circle's test USDC and EURC (faucet.circle.com), 6
 * decimals, checked on chain 2026-10-24. Deposit limits: 500 per deposit / 25,000 in
 * total for each, 0.2 / 10 ETH. There is no USDT on Base Sepolia to list.
 */
export const BASE_SEPOLIA_TOKENS: OnchainToken[] = [
  { id: "usdc", symbol: "USDC", name: "USD Coin", address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", decimals: 6, yahoo: "", kind: "stablecoin" },
  { id: "eurc", symbol: "EURC", name: "Euro Coin", address: "0x808456652fdb597867f38412077A9182bf77359F", decimals: 6, yahoo: "", kind: "stablecoin", coingecko: "euro-coin", peg: "EUR" },
];

/**
 * Ethereum mainnet (1): the stablecoins the mainnet pool lists, 6 decimals
 * each, checked on chain 2026-10-25 (symbol, name, decimals). USDC and EURC are
 * Circle's, USDT is Tether's, USDG and PYUSD are Paxos's (PYUSD for PayPal); every
 * issuer can freeze an address. USDT's approve() and transfer() return nothing,
 * and approve() refuses to change one non-zero allowance into another. Native ETH
 * is listed too (supportsNativeShield). Deposit limits: 50,000 per deposit / 2,500,000 in
 * total for each stablecoin, 20 / 1,000 ETH. Then BDX (9 decimals), taken once its
 * limit lands.
 */
export const ETHEREUM_MAINNET_TOKENS: OnchainToken[] = [
  { id: "usdc", symbol: "USDC", name: "USD Coin", address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6, yahoo: "", kind: "stablecoin" },
  { id: "usdt", symbol: "USDT", name: "Tether USD", address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", decimals: 6, yahoo: "", kind: "stablecoin", approveResetFirst: true },
  { id: "usdg", symbol: "USDG", name: "Global Dollar", address: "0xe343167631d89B6Ffc58B88d6b7fB0228795491D", decimals: 6, yahoo: "", kind: "stablecoin" },
  { id: "pyusd", symbol: "PYUSD", name: "PayPal USD", address: "0x6c3ea9036406852006290770BEdFcAbA0e23A0e8", decimals: 6, yahoo: "", kind: "stablecoin" },
  { id: "eurc", symbol: "EURC", name: "Euro Coin", address: "0x1aBaEA1f7C830bD89Acc67eC4af516284b1bC33c", decimals: 6, yahoo: "", kind: "stablecoin", coingecko: "euro-coin", peg: "EUR" },
  BDX,
];

/**
 * The approve(pool, value) calls a deposit of `amount` needs, in order, given
 * the allowance the pool has now: none when it already covers the deposit;
 * [0, amount] for a token that refuses to go from one non-zero allowance to
 * another; otherwise [amount]. Exact amounts only. Same rule as the SDK's
 * approvalSteps.
 */
export function approvalSteps(token: Pick<OnchainToken, "approveResetFirst">, allowance: bigint, amount: bigint): bigint[] {
  if (allowance >= amount) return [];
  if (allowance > BigInt(0) && token.approveResetFirst) return [BigInt(0), amount];
  return [amount];
}

/**
 * approvalSteps when the allowance may not have been read (`undefined`). A
 * standard token is then approved for the exact amount, which approve() sets
 * outright whatever was there. A token that needs the reset gets null: send
 * nothing and read the allowance again, since the reset to 0 is only ever for a
 * non-zero allowance actually read, and approving over one would revert.
 */
export function approvalsBeforeDeposit(
  token: Pick<OnchainToken, "approveResetFirst">,
  allowance: bigint | undefined,
  amount: bigint
): bigint[] | null {
  if (allowance !== undefined) return approvalSteps(token, allowance, amount);
  return token.approveResetFirst ? null : [amount];
}

export const CIRCLE_FAUCET_URL = "https://faucet.circle.com/";

/**
 * Ethereum Sepolia (11155111): Circle's test USDC and EURC (faucet.circle.com)
 * and Paxos's test USDG and PYUSD (faucet.paxos.com, listed in Paxos's testnet
 * docs), 6 decimals each, checked on chain 2026-10-25 (symbol, name, decimals,
 * code). The same limits as Base Sepolia. Tether issues no USDT on Sepolia, so
 * none is listed. Native ETH is listed too (supportsNativeShield).
 */
export const ETHEREUM_SEPOLIA_TOKENS: OnchainToken[] = [
  { id: "usdc", symbol: "USDC", name: "USD Coin", address: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238", decimals: 6, yahoo: "", kind: "stablecoin" },
  { id: "usdg", symbol: "USDG", name: "Global Dollar", address: "0xfBb2A78CceEb415b00300925e464C3E44E6e06b0", decimals: 6, yahoo: "", kind: "stablecoin" },
  { id: "pyusd", symbol: "PYUSD", name: "PayPal USD", address: "0xCaC524BcA292aaade2DF8A05cC58F0a65B1B3bB9", decimals: 6, yahoo: "", kind: "stablecoin" },
  { id: "eurc", symbol: "EURC", name: "Euro Coin", address: "0x08210F9170F89Ab7658F0B5E3fF39b0E03C594D4", decimals: 6, yahoo: "", kind: "stablecoin", coingecko: "euro-coin", peg: "EUR" },
];

/** Native ETH, as a private swap lists it: the vault's address(0), on the chains that hold it. */
export const NATIVE_ETH_TOKEN: OnchainToken = { id: "eth", symbol: "ETH", name: "Ether", address: "0x0000000000000000000000000000000000000000", decimals: 18, yahoo: "", kind: "token", coingecko: "ethereum" };

/**
 * Elysium mainnet, behind NEXT_PUBLIC_ELYSIUM_ENABLED (lib/elysium.ts): USDC from
 * launch (500 per deposit, 25,000 in total; address and decimals from lib/elysium.ts),
 * and KNTQ, Kinetiq's token as bridged through Elysium's canonical gateway
 * (l1Address 0x0000…c2d6 on HyperEVM), open once its queued limit lands
 * (1,400 per deposit, 70,000 in total; queued 9 Nov 2026). HYPE, the gas coin, is not listed yet.
 */
export const ELYSIUM_MAINNET_TOKENS: OnchainToken[] = ELYSIUM
  ? [
      { id: "usdc", symbol: "USDC", name: "USD Coin", address: ELYSIUM.usdc, decimals: ELYSIUM.usdcDecimals, yahoo: "", kind: "stablecoin" },
      { id: "kntq", symbol: "KNTQ", name: "Kinetiq", address: "0xe45a355d9e9cAd2aD85F2d03E3eE3102A036acF0", decimals: 18, yahoo: "", kind: "token", coingecko: "kinetiq", opensWithLimit: true },
    ]
  : [];

/**
 * Elysium testnet (99801): Kinetiq's test USDC only, behind
 * NEXT_PUBLIC_ELYSIUM_TESTNET_ENABLED (lib/elysium.ts). HYPE is not listed.
 */
export const ELYSIUM_TESTNET_TOKENS: OnchainToken[] = ELYSIUM_TESTNET
  ? [{ id: "usdc", symbol: "USDC", name: "USD Coin", address: ELYSIUM_TESTNET.usdc, decimals: ELYSIUM_TESTNET.usdcDecimals, yahoo: "", kind: "stablecoin" }]
  : [];

/** ERC-20 tokens shieldable on a given chain (stablecoins first). */
export function shieldTokensFor(chainId: number): OnchainToken[] {
  if (isElysiumChainId(chainId)) return ELYSIUM_MAINNET_TOKENS;
  if (isElysiumTestnetChainId(chainId)) return ELYSIUM_TESTNET_TOKENS;
  if (chainId === 11155111) return ETHEREUM_SEPOLIA_TOKENS;
  if (chainId === 4663) return RH_MAINNET_TOKENS;
  if (chainId === 4217) return TEMPO_MAINNET_TOKENS;
  if (chainId === 8453) return BASE_MAINNET_TOKENS;
  if (chainId === 84532) return BASE_SEPOLIA_TOKENS;
  if (chainId === 1) return ETHEREUM_MAINNET_TOKENS;
  return chainId === 42431 ? TEMPO_STABLE_TOKENS : [...RH_STABLE_TOKENS, ...TESTNET_STOCK_TOKENS];
}

/**
 * Tokens a wallet can hold on a chain that Add does not list: the ones a private
 * swap can land in (Robinhood Chain mainnet's RH_MAINNET_SWAP_TOKENS: WETH, the
 * stocks and so on). Empty on every other chain.
 */
export function swapDisplayTokensFor(chainId: number): OnchainToken[] {
  return chainId === 4663 ? RH_MAINNET_SWAP_TOKENS : [];
}

/**
 * Every token the Portfolio's wallet card reads and lists on a chain: what Add
 * takes (shieldTokensFor) first, then the swap tokens, deduped by address. A
 * stock cashed out of the vault lands in the wallet and shows here, but only
 * shieldTokensFor tokens can be added privately.
 */
export function walletDisplayTokensFor(chainId: number): OnchainToken[] {
  const seen = new Set<string>();
  return [...shieldTokensFor(chainId), ...swapDisplayTokensFor(chainId)].filter((t) => {
    const a = t.address.toLowerCase();
    if (seen.has(a)) return false;
    seen.add(a);
    return true;
  });
}

/**
 * The opensWithLimit tokens on a chain (BDX on Base and Ethereum): the ones whose
 * live deposit limit decides whether Add offers them.
 */
export function limitGatedTokensFor(chainId: number): OnchainToken[] {
  return shieldTokensFor(chainId).filter((t) => t.opensWithLimit);
}

/** The vault's name for the chain's native coin. */
const NATIVE_ADDRESS = "0x0000000000000000000000000000000000000000";

/**
 * Chains whose vault lists the native coin ahead of its deposit limit, as
 * opensWithLimit does for a token. On Robinhood Chain mainnet ETH's limit is 0
 * until it lands through the timelock (QueueRobinhoodAssets).
 */
const NATIVE_OPENS_WITH_LIMIT: ReadonlySet<number> = new Set([4663]);

/** Everything whose live limit decides what Add offers: limitGatedTokensFor, plus the native coin where it opens the same way. */
export function limitGatedAssetsFor(chainId: number): Pick<OnchainToken, "address">[] {
  const tokens = limitGatedTokensFor(chainId);
  return NATIVE_OPENS_WITH_LIMIT.has(chainId) ? [{ address: NATIVE_ADDRESS }, ...tokens] : tokens;
}

/**
 * Which gated assets (limitGatedAssetsFor) are open, from the pool's live reads: `limitsOn`
 * is depositLimitsOn() and `limits[i]` is depositLimit(gated[i]), each
 * undefined while unread or when the read failed. With limits on, a token is
 * open when its perDeposit and total are both above 0; with limits off (a pool
 * from before them), every one is. Anything unread stays closed, so a deposit
 * the vault would refuse is never offered.
 */
export function openGatedFromReads(
  gated: readonly Pick<OnchainToken, "address">[],
  limitsOn: boolean | undefined,
  limits: readonly (readonly [bigint, bigint] | undefined)[]
): Set<string> {
  const open = new Set<string>();
  if (limitsOn === undefined) return open;
  gated.forEach((t, i) => {
    const lim = limits[i];
    if (!limitsOn || (lim && lim[0] > BigInt(0) && lim[1] > BigInt(0))) open.add(t.address.toLowerCase());
  });
  return open;
}

/**
 * What Add offers on a chain now: shieldTokensFor, less any opensWithLimit token
 * whose live limit is not known to be open. `open` holds the lowercase
 * addresses read as open (useOpenGatedTokens); missing, nothing gated is offered.
 */
export function addableTokensFor(chainId: number, open?: ReadonlySet<string>): OnchainToken[] {
  return shieldTokensFor(chainId).filter((t) => !t.opensWithLimit || Boolean(open?.has(t.address.toLowerCase())));
}

/**
 * Whether Add takes this token on the chain now (addableTokensFor), compared by
 * address. An opensWithLimit token counts only when `open` says its limit is open.
 */
export function isAddableToken(chainId: number, token: Pick<OnchainToken, "address">, open?: ReadonlySet<string>): boolean {
  const a = token.address.toLowerCase();
  return addableTokensFor(chainId, open).some((t) => t.address.toLowerCase() === a);
}

/**
 * A Robinhood stock token whose balance is shown with its uiMultiplier (splits,
 * dividends): one raw token is worth the share price times uiMultiplier / 1e18.
 * The mainnet stock tokens, not the testnet ones.
 */
export function hasUiMultiplier(chainId: number, token: Pick<OnchainToken, "address" | "kind">): boolean {
  if (token.kind !== "stock") return false;
  const a = token.address.toLowerCase();
  return swapDisplayTokensFor(chainId).some((t) => t.address.toLowerCase() === a);
}

/**
 * Every listed token on one chain, or on all of them when no chain is given,
 * for naming an asset by its address. Chain first, because an address can be
 * listed on more than one chain (pathUSD and OUSD sit at the same address on
 * Tempo mainnet and Moderato).
 */
export function knownTokens(chainId?: number): OnchainToken[] {
  const all = [
    ...ETHEREUM_SEPOLIA_TOKENS,
    ...RH_STABLE_TOKENS,
    ...TESTNET_STOCK_TOKENS,
    ...TEMPO_STABLE_TOKENS,
    ...RH_MAINNET_TOKENS,
    ...RH_MAINNET_SWAP_TOKENS,
    ...TEMPO_MAINNET_TOKENS,
    ...BASE_MAINNET_TOKENS,
    ...BASE_SEPOLIA_TOKENS,
    ...ETHEREUM_MAINNET_TOKENS,
  ];
  return chainId === undefined ? all : [...shieldTokensFor(chainId), ...all];
}

/**
 * Whether the vault on a chain lists its native coin, so holds and reports it.
 * Tempo (testnet 42431, mainnet 4217) has no native coin and blocks native
 * msg.value. Robinhood Chain, Base and Ethereum list ETH. Add offers it only when
 * isNativeAddable says so.
 */
export function supportsNativeShield(chainId: number): boolean {
  // Elysium's vaults (mainnet and testnet) do not list HYPE.
  if (isElysiumFamilyChainId(chainId)) return false;
  return chainId !== 42431 && chainId !== 4217;
}

/**
 * Whether Add takes the chain's native coin now. Where it opens with its live
 * limit (Robinhood Chain mainnet), `open` must hold it (useOpenGatedTokens), the
 * rule addableTokensFor applies to a token: missing, it is not offered.
 */
export function isNativeAddable(chainId: number, open?: ReadonlySet<string>): boolean {
  if (!supportsNativeShield(chainId)) return false;
  return !NATIVE_OPENS_WITH_LIMIT.has(chainId) || Boolean(open?.has(NATIVE_ADDRESS));
}

export const erc20BalanceOfAbi = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;
