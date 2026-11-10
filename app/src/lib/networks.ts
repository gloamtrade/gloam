/**
 * Gloam network registry: the runtime source of truth for every chain the
 * product can point at. Four testnets (Robinhood Chain testnet, Tempo
 * Moderato, Base Sepolia and Ethereum Sepolia) and their four mainnets, plus
 * Elysium mainnet and testnet behind their switches (lib/elysium.ts).
 *
 * Everything chain-specific (chain object, shielded pool, deploy block, hash
 * scheme, native + stable assets, explorer links) hangs off one `GloamNetwork`
 * record so the app can switch networks at runtime instead of at build time.
 * Robinhood values are re-exported from the existing single sources
 * (chain.ts / config.ts) so there is no second copy to drift.
 *
 * A mainnet only exists once its pool is filled in (MAINNET_POOLS in
 * lib/mainnet.ts), and so do Base Sepolia and Ethereum Sepolia
 * (BASE_SEPOLIA_POOL and ETHEREUM_SEPOLIA_POOL there). Until
 * then it is left out of NETWORK_KEYS, isNetworkKey, allNetworks and everything
 * built on them (selector, API, relay, MCP, proofs), as if it did not exist.
 *
 * Elysium mainnet (99901) is the fifth mainnet. It is on unless
 * NEXT_PUBLIC_ELYSIUM_ENABLED turns it off, and needs its values (lib/elysium.ts):
 * off, or with a value missing, it is hidden the same way. Its testnet (99801,
 * key "elysium") has its own switch, NEXT_PUBLIC_ELYSIUM_TESTNET_ENABLED, off
 * unless set, and needs its pool in.
 */
import { defineChain, type Address, type Chain } from "viem";
import {
  ELYSIUM_MULTICALL3,
  ELYSIUM_TESTNET as SDK_ELYSIUM_TESTNET,
  ELYSIUM_TESTNET_RPC_FALLBACK,
  ETHEREUM_SEPOLIA_HISTORY_RPC,
  type HistoryRpc,
} from "@gloamtrade/sdk";
import { base, baseSepolia, mainnet as ethereum, sepolia } from "viem/chains";
import { robinhood, robinhoodTestnet } from "./chain";
import type { CeremonyKind } from "./circuitArtifacts";
import {
  TESTNET_POSEIDON_POOL,
  TESTNET_POSEIDON_DEPLOY_BLOCK,
  type HashScheme,
} from "./config";
import { baseSepoliaPool, ethereumSepoliaPayMemo, ethereumSepoliaPool, mainnetPool } from "./mainnet";
import { ELYSIUM, ELYSIUM_CHAIN_ID, ELYSIUM_LOG_RANGE, ELYSIUM_TESTNET } from "./elysium";

export type NetworkKey =
  | "robinhood"
  | "tempo"
  | "base"
  | "ethereum"
  | "robinhood-mainnet"
  | "tempo-mainnet"
  | "base-mainnet"
  | "ethereum-mainnet"
  | "elysium-mainnet"
  | "elysium";

/** The chain a network runs on, testnet or mainnet: wallets, fees and logos follow it. */
export type ChainFamily = "robinhood" | "tempo" | "base" | "ethereum" | "elysium";

/**
 * Elysium's chain id. Not public when it was added, so it is a number from
 * lib/elysium.ts rather than a literal; the brand keeps it in the union below.
 */
export type ElysiumChainId = number & { readonly __chain?: "elysium" };

/**
 * Chain ids of the networks Gloam knows. Typed as the literal union so
 * `network.chainId` is accepted directly by wagmi hook options (`useBalance`,
 * `useSendTransaction`, `useWaitForTransactionReceipt`, `switchChain`), which
 * narrow `chainId` to the configured ids. Mainnet ids are only registered with
 * wagmi once their pool is filled in (lib/wagmi.ts).
 */
export type GloamChainId = 46630 | 42431 | 84532 | 11155111 | 4663 | 4217 | 8453 | 1 | 99801 | ElysiumChainId;

/** Whether a network is deployed and safe for real shield/spend writes. */
export type NetworkStatus = "live" | "planned";

export interface NetworkAsset {
  symbol: string;
  /** ERC-20 address, or null for the chain's native gas asset. */
  address: Address | null;
  decimals: number;
}

/**
 * Encrypted payment-memo board (GloamPayMemo): lets a recipient find a private
 * payment by scanning the chain with their Gloam address, no link needed.
 * `emitsPoster` is true for the first deploy, whose event also indexed the
 * poster's address (fixed in source by audit L-1; relayed memos hide it anyway).
 */
export interface PayMemoBoard {
  address: Address;
  deployBlock: bigint;
  emitsPoster: boolean;
}

function envAddress(v: string | undefined): Address | null {
  return v && /^0x[0-9a-fA-F]{40}$/.test(v) ? (v as Address) : null;
}

function envBlock(v: string | undefined, fallback: bigint): bigint {
  try {
    return v ? BigInt(v) : fallback;
  } catch {
    return fallback;
  }
}

export interface GloamNetwork {
  key: NetworkKey;
  /** The chain's name, the same for its testnet and its mainnet ("Robinhood Chain", "Tempo", "Ethereum"). */
  label: string;
  family: ChainFamily;
  /** Testnet (true) or mainnet (false). */
  testnet: boolean;
  /**
   * Tokenized stocks: the Markets page, stock holdings and the Trade tab. Only
   * on Robinhood Chain testnet; the mainnet pools take payments only.
   */
  stocks: boolean;
  /**
   * The pool is ShieldPoolPayments, the mainnet contract: it takes only the
   * assets it lists, each with a deposit limit, a cash out pays the fee,
   * and there is no sealed swap code. Every mainnet, and Base Sepolia, which runs
   * the mainnet pool with test funds. The older testnets (Robinhood Chain and
   * Tempo) run ShieldPoolPoseidon: anything can go in, no limits, no fee.
   */
  paymentsPool: boolean;
  /**
   * viem chain used for clients, wallet_addEthereumChain, etc. Its first RPC is
   * at the chain head: receipts, balances, allowances and other fresh reads.
   */
  chain: Chain;
  /**
   * Where reads about old blocks go when the chain's first RPC keeps only
   * recent history (Ethereum Sepolia), or null where it keeps everything.
   * Clients read through lib/readTransport, which sends logs, receipts and
   * state older than `recentBlocks` here and everything else to the first RPC.
   */
  historyRpc: HistoryRpc | null;
  chainId: GloamChainId;
  /** Shielded pool address; null while a network is still `planned`. */
  pool: Address | null;
  /** Block the pool was deployed at, for getLogs / tree rebuild. */
  deployBlock: bigint | null;
  /** Largest eth_getLogs block range the public RPC accepts. */
  logRange: bigint;
  hashScheme: HashScheme;
  /**
   * The trusted-setup keys this network's verifiers hold: the single-party dev
   * keys on the testnets, the ceremony's final keys on mainnet. Proofs for the
   * network are made and checked with the same set (lib/circuitArtifacts).
   */
  ceremony: CeremonyKind;
  /** The chain's native gas coin (ETH on Robinhood Chain, Base and Ethereum, USD on Tempo, HYPE on Elysium). */
  primaryAsset: NetworkAsset;
  /** Stable assets shieldable on this network (empty until registered). */
  stableAssets: NetworkAsset[];
  status: NetworkStatus;
  /** Payment-memo board, null until deployed on this network. */
  payMemo: PayMemoBoard | null;
  /** One-line, honest description of where the network stands. */
  note: string;
  explorerTx: (hash: string) => string;
  explorerAddress: (addr: string) => string;
}

/**
 * Tempo testnet (Moderato). Payments-first EVM L1 (Reth) incubated by Stripe +
 * Paradigm; native currency is USD and gas is paid in stablecoins. Params from
 * the official connection docs (docs.tempo.xyz). USD decimals are unspecified
 * upstream; 18 is the EVM/Reth default and must be confirmed before writes.
 */
export const tempoTestnet = defineChain({
  id: 42431,
  name: "Tempo Testnet (Moderato)",
  nativeCurrency: { name: "US Dollar", symbol: "USD", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://rpc.moderato.tempo.xyz"] },
  },
  blockExplorers: {
    default: {
      name: "Tempo Testnet Explorer",
      url: "https://explore.testnet.tempo.xyz",
    },
  },
  // Multicall3 at its usual address, so batched reads go out as one call
  contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
  testnet: true,
});

/**
 * Tempo mainnet. Same shape as Moderato: no gas coin, fees in USD stablecoins.
 * The native currency keeps 18 decimals like the testnet entry, because wallets
 * refuse wallet_addEthereumChain with anything else and Gloam never moves it.
 * Multicall3 is deployed at its usual address (checked on chain 2026-10-20).
 */
export const tempoMainnet = defineChain({
  id: 4217,
  name: "Tempo",
  nativeCurrency: { name: "US Dollar", symbol: "USD", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://rpc.tempo.xyz"] },
  },
  blockExplorers: {
    default: {
      name: "Tempo Explorer",
      url: "https://explore.tempo.xyz",
    },
  },
  contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
});

/**
 * Base Sepolia, Base's testnet (an OP Stack L2, gas in ETH). The
 * default RPC is publicnode's: sepolia.base.org caps eth_getLogs at 200 blocks,
 * and the vault tree is rebuilt from logs (publicnode takes 50,000). The
 * official RPC stays second, for wallets that add the chain.
 */
export const baseTestnet = defineChain({
  ...baseSepolia,
  rpcUrls: {
    default: { http: ["https://base-sepolia-rpc.publicnode.com", "https://sepolia.base.org"] },
  },
});

/**
 * Ethereum Sepolia, Ethereum's testnet (gas in Sepolia ETH). The default RPC is
 * publicnode's, which is at the chain head: a mined approval or deposit shows
 * up there about 3 s after its block. It keeps only about the last 10,000
 * blocks of logs, receipts and state (a day and a half), so the vault tree's
 * older logs come from Tenderly's public gateway (the network's historyRpc),
 * which keeps everything but trails the head: measured 2026-10-25, a new
 * receipt showed up there 25 s after its block at the median and over 2
 * minutes at the 90th percentile. The server reads through
 * GLOAM_RPC_URL_11155111 first once it is set (lib/serverRpc).
 */
export const ethereumTestnet = defineChain({
  ...sepolia,
  name: "Ethereum Sepolia",
  rpcUrls: {
    default: { http: ["https://ethereum-sepolia-rpc.publicnode.com", "https://sepolia.gateway.tenderly.co"] },
  },
});

/**
 * Base mainnet. Same RPC choice as Base Sepolia: mainnet.base.org refuses
 * eth_getLogs from public callers.
 */
export const baseMainnet = defineChain({
  ...base,
  rpcUrls: {
    default: { http: ["https://base-rpc.publicnode.com", "https://mainnet.base.org"] },
  },
});

/**
 * Ethereum mainnet. The default RPC is MEV Blocker's: it keeps old state and
 * answers eth_getLogs over 10,000 blocks (or any range under 10,000 logs), and
 * the vault tree is rebuilt from logs. It is also at the chain head (a new
 * receipt shows up as soon as on publicnode, measured 2026-10-25), so one RPC
 * serves both and there is no historyRpc. publicnode, second, serves only the
 * last 10,000 blocks of logs and 128 blocks of state. The server reads through
 * GLOAM_RPC_URL_1 first once it is set (lib/serverRpc).
 */
export const ethereumMainnet = defineChain({
  ...ethereum,
  rpcUrls: {
    default: { http: ["https://rpc.mevblocker.io", "https://ethereum-rpc.publicnode.com"] },
  },
});

/**
 * Elysium mainnet: Kinetiq's Hyperliquid L2, an Arbitrum Orbit chain that
 * settles to HyperEVM, gas in HYPE. Its id, RPC and explorer come from
 * lib/elysium.ts. Until they are in (and the flag is on) this is a stand-in
 * that is never registered with wagmi or shown: chain id 0, no RPC.
 */
export const elysiumMainnet = defineChain({
  id: (ELYSIUM?.chainId ?? 0) as ElysiumChainId,
  name: "Elysium",
  nativeCurrency: { name: "HYPE", symbol: "HYPE", decimals: 18 },
  rpcUrls: {
    default: { http: ELYSIUM ? [ELYSIUM.rpcUrl] : [] },
  },
  blockExplorers: {
    default: { name: "Elysium Explorer", url: ELYSIUM?.explorerUrl ?? "https://elysium.invalid" },
  },
});

/**
 * Elysium testnet (99801): Kinetiq's published RPCs (theirs, then Conduit's) and
 * explorer, gas in HYPE. Always defined; only a network once its pool is in and
 * NEXT_PUBLIC_ELYSIUM_TESTNET_ENABLED is on (lib/elysium.ts).
 */
export const elysiumTestnet = defineChain({
  id: 99801,
  name: "Elysium Testnet",
  nativeCurrency: { name: "HYPE", symbol: "HYPE", decimals: 18 },
  rpcUrls: {
    default: { http: [ELYSIUM_TESTNET?.rpcUrl ?? SDK_ELYSIUM_TESTNET.rpcUrl!, ELYSIUM_TESTNET_RPC_FALLBACK] },
  },
  blockExplorers: {
    default: { name: "Elysium Testnet Explorer", url: SDK_ELYSIUM_TESTNET.explorerUrl! },
  },
  contracts: { multicall3: { address: ELYSIUM_MULTICALL3 } },
  testnet: true,
});

/**
 * Public RPCs above that trail the chain head: a network's history RPC (Ethereum
 * Sepolia's Tenderly gateway), which keeps every block but showed a new
 * receipt minutes late. It stays in its chain's list as the last head RPC to
 * ask, and reads old blocks through lib/readTransport on its own, but never
 * takes a send or a log read from the list (below).
 */
const TRAILING_RPCS: readonly string[] = [ETHEREUM_SEPOLIA_HISTORY_RPC.url];

/**
 * Public RPCs above that a log read from a chain's list never goes to (lib/rpcList):
 * ones that refuse or cap eth_getLogs (sepolia.base.org takes 200 blocks a read,
 * mainnet.base.org none from public callers), and ones that trail the head,
 * where the newest logs would be missing. They stay in the lists for every
 * other read, and for wallets that add the chain.
 */
export const NO_LOG_RPCS: ReadonlySet<string> = new Set(["https://sepolia.base.org", "https://mainnet.base.org", ...TRAILING_RPCS]);

/**
 * Public RPCs a signed transaction from a chain's list never goes to, even when
 * every other one is resting: ones that trail the head, where a send would be
 * seen late or checked against stale state (lib/rpcList).
 */
export const NO_SEND_RPCS: ReadonlySet<string> = new Set(TRAILING_RPCS);

const RH_MAINNET_POOL = mainnetPool(4663);
const TEMPO_MAINNET_POOL = mainnetPool(4217);
const BASE_MAINNET_POOL = mainnetPool(8453);
const ETHEREUM_MAINNET_POOL = mainnetPool(1);
const ELYSIUM_MEMO = ELYSIUM?.payMemo ?? null;
const BASE_SEPOLIA_POOL = baseSepoliaPool();
const ETHEREUM_SEPOLIA_POOL = ethereumSepoliaPool();
const ETHEREUM_SEPOLIA_MEMO = ethereumSepoliaPayMemo();

const NETWORKS: Record<NetworkKey, GloamNetwork> = {
  robinhood: {
    key: "robinhood",
    label: "Robinhood Chain",
    family: "robinhood",
    testnet: true,
    stocks: true,
    paymentsPool: false,
    chain: robinhoodTestnet,
    chainId: robinhoodTestnet.id,
    historyRpc: null,
    pool: TESTNET_POSEIDON_POOL,
    deployBlock: TESTNET_POSEIDON_DEPLOY_BLOCK,
    ceremony: "dev",
    // Robinhood's RPC rejects topic-filtered eth_getLogs over 100k blocks.
    logRange: 100_000n,
    hashScheme: "poseidon",
    primaryAsset: { symbol: "ETH", address: null, decimals: 18 },
    stableAssets: [],
    status: "live",
    payMemo: {
      address:
        envAddress(process.env.NEXT_PUBLIC_PAY_MEMO) ??
        "0x689ebd9d30E0235c73fd8f10236F850CDB3c5DCE",
      deployBlock: envBlock(process.env.NEXT_PUBLIC_PAY_MEMO_DEPLOY_BLOCK, 90_421_567n),
      emitsPoster: !envAddress(process.env.NEXT_PUBLIC_PAY_MEMO),
    },
    note: "Live on testnet: shield, private send, cash out, selective disclosure.",
    explorerTx: (hash) =>
      `${robinhoodTestnet.blockExplorers.default.url}/tx/${hash}`,
    explorerAddress: (addr) =>
      `${robinhoodTestnet.blockExplorers.default.url}/address/${addr}`,
  },
  tempo: {
    key: "tempo",
    label: "Tempo",
    family: "tempo",
    testnet: true,
    stocks: false,
    paymentsPool: false,
    chain: tempoTestnet,
    chainId: tempoTestnet.id,
    historyRpc: null,
    // No-middlemen pool redeployed on Tempo Moderato 2026-09-29: no
    // emergencyWithdraw, setup ended, admin changes behind a public 3-day
    // timelock. Reuses the existing verifiers + Poseidon2. Superseded:
    // 0xeD0b…2276 (block 35_578_268), 0x3eeE…D30b (block 34_556_677).
    pool: "0x841DC046Ea3CC842BA3A855731472c6Eb0F2d5eb",
    deployBlock: 37_411_195n,
    ceremony: "dev",
    // Tempo RPC: "query exceeds max block range 100000"
    logRange: 100_000n,
    hashScheme: "poseidon",
    primaryAsset: { symbol: "USD", address: null, decimals: 18 },
    stableAssets: [],
    status: "live",
    // Deployed 2026-09-29 from the fixed source (no poster in the event).
    payMemo: {
      address:
        envAddress(process.env.NEXT_PUBLIC_PAY_MEMO_TEMPO) ??
        "0x3ca88712e9219b5EE4c82D31cAfEaB64C9E9b4E3",
      deployBlock: envBlock(process.env.NEXT_PUBLIC_PAY_MEMO_TEMPO_DEPLOY_BLOCK, 37_410_900n),
      emitsPoster: false,
    },
    note: "Live on Tempo Moderato: private stablecoin payments (shield PathUSD, send, cash out).",
    explorerTx: (hash) =>
      `${tempoTestnet.blockExplorers.default.url}/tx/${hash}`,
    explorerAddress: (addr) =>
      `${tempoTestnet.blockExplorers.default.url}/address/${addr}`,
  },
  // Base Sepolia: the testnet for Base, with test funds but the
  // mainnet pool (ShieldPoolPayments on the ceremony's final keys, payments
  // only, the same assets as Base mainnet, its own deposit limits, the
  // cash-out fee), so Base mainnet ships on code proven here. Pool from BASE_SEPOLIA_POOL
  // (lib/mainnet.ts), deployed 2026-10-24.
  base: {
    key: "base",
    label: "Base",
    family: "base",
    testnet: true,
    stocks: false,
    paymentsPool: true,
    chain: baseTestnet,
    chainId: baseTestnet.id,
    historyRpc: null,
    pool: BASE_SEPOLIA_POOL?.pool ?? null,
    deployBlock: BASE_SEPOLIA_POOL?.deployBlock ?? null,
    ceremony: "production",
    // publicnode: "exceed maximum block range: 50000"
    logRange: 50_000n,
    hashScheme: "poseidon",
    primaryAsset: { symbol: "ETH", address: null, decimals: 18 },
    stableAssets: [],
    status: "live",
    // GloamPayMemo, deployed 2026-10-24 after the vault (no owner, holds nothing, never logs the poster)
    payMemo: { address: "0x01B3172d9900Cb26d57E986429b9b23854c74598", deployBlock: 49_804_175n, emitsPoster: false },
    note: "Testnet on Base Sepolia: private USDC, EURC and ETH payments on the mainnet vault.",
    explorerTx: (hash) => `${baseTestnet.blockExplorers.default.url}/tx/${hash}`,
    explorerAddress: (addr) => `${baseTestnet.blockExplorers.default.url}/address/${addr}`,
  },
  // Ethereum Sepolia: Ethereum's testnet, run like Base Sepolia on the mainnet
  // pool (ShieldPoolPayments on the ceremony's final keys, payments only,
  // deposit limits, the cash-out fee). Hidden until
  // ETHEREUM_SEPOLIA_POOL (lib/mainnet.ts) is filled in after its deploy.
  ethereum: {
    key: "ethereum",
    label: "Ethereum",
    family: "ethereum",
    testnet: true,
    stocks: false,
    paymentsPool: true,
    chain: ethereumTestnet,
    chainId: ethereumTestnet.id,
    historyRpc: ETHEREUM_SEPOLIA_HISTORY_RPC,
    pool: ETHEREUM_SEPOLIA_POOL?.pool ?? null,
    deployBlock: ETHEREUM_SEPOLIA_POOL?.deployBlock ?? null,
    ceremony: "production",
    // publicnode (the head) and Tenderly (history) both take it: "exceed maximum block range: 50000"
    logRange: 50_000n,
    hashScheme: "poseidon",
    primaryAsset: { symbol: "ETH", address: null, decimals: 18 },
    stableAssets: [],
    status: "live",
    // GloamPayMemo, deployed right after the vault (no owner, holds nothing, never logs the poster)
    payMemo: ETHEREUM_SEPOLIA_MEMO
      ? { address: ETHEREUM_SEPOLIA_MEMO.pool, deployBlock: ETHEREUM_SEPOLIA_MEMO.deployBlock, emitsPoster: false }
      : null,
    note: "Ethereum Sepolia testnet: private USDC, USDG, PYUSD, EURC and ETH payments on the mainnet vault.",
    explorerTx: (hash) => `${ethereumTestnet.blockExplorers.default.url}/tx/${hash}`,
    explorerAddress: (addr) => `${ethereumTestnet.blockExplorers.default.url}/address/${addr}`,
  },
  // Mainnet: ShieldPoolPayments with the ceremony's final keys, payments only
  // (no sealed swap), deposit limits on, and a payment-memo board (payMemo).
  "robinhood-mainnet": {
    key: "robinhood-mainnet",
    label: "Robinhood Chain",
    family: "robinhood",
    testnet: false,
    stocks: false,
    paymentsPool: true,
    chain: robinhood,
    chainId: robinhood.id,
    historyRpc: null,
    pool: RH_MAINNET_POOL?.pool ?? null,
    deployBlock: RH_MAINNET_POOL?.deployBlock ?? null,
    ceremony: "production",
    logRange: 100_000n,
    hashScheme: "poseidon",
    primaryAsset: { symbol: "ETH", address: null, decimals: 18 },
    stableAssets: [],
    status: "live",
    // GloamPayMemo, deployed 2026-10-23 (no owner, holds nothing, never logs the poster)
    payMemo: { address: "0x01B3172d9900Cb26d57E986429b9b23854c74598", deployBlock: 95_494_392n, emitsPoster: false },
    note: "Mainnet: private USDG and ETH payments, and $GLOAM, other tokens and stock tokens held privately.",
    explorerTx: (hash) => `${robinhood.blockExplorers.default.url}/tx/${hash}`,
    explorerAddress: (addr) => `${robinhood.blockExplorers.default.url}/address/${addr}`,
  },
  "tempo-mainnet": {
    key: "tempo-mainnet",
    label: "Tempo",
    family: "tempo",
    testnet: false,
    stocks: false,
    paymentsPool: true,
    chain: tempoMainnet,
    chainId: tempoMainnet.id,
    historyRpc: null,
    pool: TEMPO_MAINNET_POOL?.pool ?? null,
    deployBlock: TEMPO_MAINNET_POOL?.deployBlock ?? null,
    ceremony: "production",
    logRange: 100_000n,
    hashScheme: "poseidon",
    primaryAsset: { symbol: "USD", address: null, decimals: 18 },
    stableAssets: [],
    status: "live",
    // GloamPayMemo, deployed 2026-10-23 (no owner, holds nothing, never logs the poster)
    payMemo: { address: "0x342E3745967FDB4223902E196Ceb792c15d8C1c4", deployBlock: 45_417_629n, emitsPoster: false },
    note: "Mainnet: private stablecoin payments (USDC.e, pathUSD, USDT0, OUSD).",
    explorerTx: (hash) => `${tempoMainnet.blockExplorers.default.url}/tx/${hash}`,
    explorerAddress: (addr) => `${tempoMainnet.blockExplorers.default.url}/address/${addr}`,
  },
  // Live since 26 Oct 2026 (DEPLOY-BASE.md); the pool is MAINNET_POOLS[8453].
  "base-mainnet": {
    key: "base-mainnet",
    label: "Base",
    family: "base",
    testnet: false,
    stocks: false,
    paymentsPool: true,
    chain: baseMainnet,
    chainId: baseMainnet.id,
    historyRpc: null,
    pool: BASE_MAINNET_POOL?.pool ?? null,
    deployBlock: BASE_MAINNET_POOL?.deployBlock ?? null,
    ceremony: "production",
    logRange: 50_000n,
    hashScheme: "poseidon",
    primaryAsset: { symbol: "ETH", address: null, decimals: 18 },
    stableAssets: [],
    status: "live",
    // GloamPayMemo, deployed 26 Oct 2026 after the vault (no owner, holds nothing, never logs the poster)
    payMemo: { address: "0xfCa1887e77f738ef9C5751974b3f3873d029F2DC", deployBlock: 53109729n, emitsPoster: false },
    note: "Mainnet: private USDC, EURC, USDT and ETH payments.",
    explorerTx: (hash) => `${baseMainnet.blockExplorers.default.url}/tx/${hash}`,
    explorerAddress: (addr) => `${baseMainnet.blockExplorers.default.url}/address/${addr}`,
  },
  // Live since 26 Oct 2026 (DEPLOY-ETHEREUM.md); the pool is MAINNET_POOLS[1].
  // Its testnet is Ethereum Sepolia (the "ethereum" entry). Gas is
  // expensive here, so the relay stops while it is over its ceiling (lib/relay/gasCeiling).
  "ethereum-mainnet": {
    key: "ethereum-mainnet",
    label: "Ethereum",
    family: "ethereum",
    testnet: false,
    stocks: false,
    paymentsPool: true,
    chain: ethereumMainnet,
    chainId: ethereumMainnet.id,
    historyRpc: null,
    pool: ETHEREUM_MAINNET_POOL?.pool ?? null,
    deployBlock: ETHEREUM_MAINNET_POOL?.deployBlock ?? null,
    ceremony: "production",
    // MEV Blocker: "up to a 10,000 block range and no limit on the response size"
    logRange: 10_000n,
    hashScheme: "poseidon",
    primaryAsset: { symbol: "ETH", address: null, decimals: 18 },
    stableAssets: [],
    status: "live",
    // GloamPayMemo, deployed 26 Oct 2026 after the vault (no owner, holds nothing, never logs the poster)
    payMemo: { address: "0x8699D015087dE6D25d55d5ceB63b34b9d773f135", deployBlock: 26276234n, emitsPoster: false },
    note: "Mainnet: private USDC, USDT, USDG, PYUSD, EURC and ETH payments.",
    explorerTx: (hash) => `${ethereumMainnet.blockExplorers.default.url}/tx/${hash}`,
    explorerAddress: (addr) => `${ethereumMainnet.blockExplorers.default.url}/address/${addr}`,
  },
  // Live since 9 November 2026 (DEPLOY-ELYSIUM.md): shown unless NEXT_PUBLIC_ELYSIUM_ENABLED
  // turns it off, while every value in lib/elysium.ts is in. Payments only, USDC alone at the launch
  // limits, gas in HYPE (not listed). Its vault is owned by a VaultOwnerGuard from the
  // deploy, so its proof checkers can never be replaced. No testnet entry.
  "elysium-mainnet": {
    key: "elysium-mainnet",
    label: "Elysium",
    family: "elysium",
    testnet: false,
    stocks: false,
    paymentsPool: true,
    chain: elysiumMainnet,
    chainId: elysiumMainnet.id,
    historyRpc: null,
    pool: ELYSIUM?.pool ?? null,
    deployBlock: ELYSIUM?.deployBlock ?? null,
    ceremony: "production",
    logRange: ELYSIUM_LOG_RANGE,
    hashScheme: "poseidon",
    primaryAsset: { symbol: "HYPE", address: null, decimals: 18 },
    stableAssets: [],
    status: "live",
    payMemo: ELYSIUM_MEMO ? { address: ELYSIUM_MEMO.address, deployBlock: ELYSIUM_MEMO.deployBlock, emitsPoster: false } : null,
    note: "Mainnet: private USDC payments.",
    explorerTx: (hash) => `${elysiumMainnet.blockExplorers.default.url}/tx/${hash}`,
    explorerAddress: (addr) => `${elysiumMainnet.blockExplorers.default.url}/address/${addr}`,
  },
  // Elysium testnet (99801), run like Base Sepolia: the mainnet vault, born guarded,
  // on the ceremony's final keys, test USDC only, gas in HYPE (not listed). Hidden
  // until NEXT_PUBLIC_ELYSIUM_TESTNET_ENABLED is on and its pool is in (lib/elysium.ts).
  elysium: {
    key: "elysium",
    label: "Elysium",
    family: "elysium",
    testnet: true,
    stocks: false,
    paymentsPool: true,
    chain: elysiumTestnet,
    chainId: elysiumTestnet.id,
    historyRpc: null,
    pool: ELYSIUM_TESTNET?.pool ?? null,
    deployBlock: ELYSIUM_TESTNET?.deployBlock ?? null,
    ceremony: "production",
    // Blocks every ~100 ms; its RPCs cap a call at 10,000 logs, not at a range (checked 7 Nov 2026)
    logRange: ELYSIUM_LOG_RANGE,
    hashScheme: "poseidon",
    primaryAsset: { symbol: "HYPE", address: null, decimals: 18 },
    stableAssets: [],
    status: "live",
    payMemo: ELYSIUM_TESTNET?.payMemo
      ? { address: ELYSIUM_TESTNET.payMemo.address, deployBlock: ELYSIUM_TESTNET.payMemo.deployBlock, emitsPoster: false }
      : null,
    note: "Elysium testnet: private USDC payments on the mainnet vault.",
    explorerTx: (hash) => `${elysiumTestnet.blockExplorers.default.url}/tx/${hash}`,
    explorerAddress: (addr) => `${elysiumTestnet.blockExplorers.default.url}/address/${addr}`,
  },
};

const hasPool = (k: NetworkKey) => NETWORKS[k].pool !== null && NETWORKS[k].deployBlock !== null;

/** Mainnets whose pool is filled in, Robinhood Chain first. Empty before deploy day. */
const MAINNET_KEYS: NetworkKey[] = (["robinhood-mainnet", "tempo-mainnet", "base-mainnet", "ethereum-mainnet", "elysium-mainnet"] as const).filter(hasPool);

/** The testnets: Robinhood Chain and Tempo, then Base Sepolia, Ethereum Sepolia and Elysium testnet once each pool is filled in (Elysium's behind its switch too). */
const TESTNET_KEYS: NetworkKey[] = ["robinhood", "tempo", ...(["base", "ethereum", "elysium"] as const).filter(hasPool)];

/** True once at least one mainnet pool is filled in: the app then labels mainnet and testnet. */
export const MAINNET_ENABLED = MAINNET_KEYS.length > 0;

/** The network the server starts on, and a visitor too if no mainnet had a pool. */
export const DEFAULT_NETWORK_KEY: NetworkKey = "robinhood";

let sessionDefault: NetworkKey | null = null;

/**
 * The network a visitor lands on when they never picked one: the first mainnet
 * with a pool (Robinhood Chain's). Worked out once per page load, so the
 * selector and lib code never disagree. On the server it is always
 * DEFAULT_NETWORK_KEY.
 */
export function defaultNetworkKey(): NetworkKey {
  if (typeof window === "undefined") return DEFAULT_NETWORK_KEY;
  sessionDefault ??= MAINNET_KEYS[0] ?? DEFAULT_NETWORK_KEY;
  return sessionDefault;
}

/** localStorage key the network selector persists to (mirror of NetworkProvider). */
const ACTIVE_NETWORK_STORAGE_KEY = "gloam.network";

/** The network NetworkProvider shows, once it has read this browser's choice. */
let shownKey: NetworkKey | null = null;

/**
 * Called by NetworkProvider whenever the network it shows changes, so lib code
 * (notes, the tree, proofs, the relay client) follows the page even where
 * storage refuses the write. Several vaults share one address (Robinhood Chain,
 * Tempo and Base Sepolia mainnet-pool deploys), so lib code on a different
 * chain than the page would read another chain's notes under this one's name.
 */
export function setShownNetworkKey(key: NetworkKey): void {
  shownKey = key;
}

/**
 * The active network for non-React code (lib functions that cannot use the
 * useNetwork hook): the one NetworkProvider shows, else the localStorage key
 * the selector writes, else defaultNetworkKey(). SSR and blocked-storage safe.
 * React components should prefer useNetwork().
 */
export function getActiveNetwork(): GloamNetwork {
  if (typeof window === "undefined") return NETWORKS[DEFAULT_NETWORK_KEY];
  if (shownKey && isNetworkKey(shownKey) && isNetworkWritable(NETWORKS[shownKey])) return NETWORKS[shownKey];
  try {
    const v = window.localStorage.getItem(ACTIVE_NETWORK_STORAGE_KEY);
    if (isNetworkKey(v)) {
      const n = NETWORKS[v];
      // Never resolve to a non-writable network for lib/write code.
      if (isNetworkWritable(n)) return n;
    }
  } catch {
    /* private mode / blocked storage */
  }
  return NETWORKS[defaultNetworkKey()];
}

/** The networks Gloam runs on right now: mainnets with a pool first, then the testnets. */
export const NETWORK_KEYS: NetworkKey[] = [...MAINNET_KEYS, ...TESTNET_KEYS];

/**
 * The key set a proof made for `chainId` was made with; the dev keys for a
 * chain Gloam doesn't run on. Mainnet chain ids, Base Sepolia and Ethereum
 * Sepolia always answer "production", pool or not, so their proofs are never
 * checked against the dev keys.
 */
export function ceremonyForChain(chainId: unknown): CeremonyKind {
  const id = Number(chainId);
  // Elysium's id, once the flag is on and the id is in, even before its pool is.
  if (ELYSIUM_CHAIN_ID !== null && id === ELYSIUM_CHAIN_ID) return "production";
  if (id === 0) return "dev";
  return Object.values(NETWORKS).find((n) => n.chainId === id)?.ceremony ?? "dev";
}

export function getNetwork(key: NetworkKey): GloamNetwork {
  return NETWORKS[key];
}

/** All networks Gloam runs on, live first, for rendering a selector. */
export function allNetworks(): GloamNetwork[] {
  return NETWORK_KEYS.map(getNetwork).sort((a, b) =>
    a.status === b.status ? 0 : a.status === "live" ? -1 : 1
  );
}

/** A key of a network Gloam runs on right now (a mainnet without a pool is not one). */
export function isNetworkKey(v: string | null | undefined): v is NetworkKey {
  return typeof v === "string" && (NETWORK_KEYS as string[]).includes(v);
}

/** A network can take real shield/spend writes only when live with a pool. */
export function isNetworkWritable(n: GloamNetwork): boolean {
  return n.status === "live" && n.pool !== null;
}

/** The network names an API takes, for its errors: '"robinhood" or "tempo"' until a mainnet pool is in. */
export function networkKeyChoices(): string {
  const q = [...TESTNET_KEYS, ...MAINNET_KEYS].map((k) => `"${k}"`);
  return `${q.slice(0, -1).join(", ")} or ${q[q.length - 1]}`;
}

/**
 * "Robinhood Chain testnet", "Base testnet", "Ethereum Sepolia", or the plain
 * chain name ("Tempo") on mainnet. Ethereum has more than one testnet, so its
 * is named.
 */
export function networkName(n: Pick<GloamNetwork, "label" | "testnet" | "family">): string {
  if (n.testnet && n.family === "ethereum") return "Ethereum Sepolia";
  return n.testnet ? `${n.label} testnet` : n.label;
}

/**
 * A testnet's own chain's mainnet, once its pool is in; null when that chain
 * has no mainnet on yet. Never another chain's: Base Sepolia's has to be Base.
 */
export function mainnetOf(n: Pick<GloamNetwork, "family">): GloamNetwork | null {
  const key = NETWORK_KEYS.find((k) => !NETWORKS[k].testnet && NETWORKS[k].family === n.family);
  return key ? NETWORKS[key] : null;
}
