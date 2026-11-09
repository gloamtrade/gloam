/**
 * Per-network runtime config for the MCP's execution rail. Pool, chain id,
 * deploy block, key set and assets come from the SDK (single source of truth:
 * GLOAM_NETWORKS for the Robinhood Chain and Tempo testnets, testnetNetwork("base")
 * for Base Sepolia, testnetNetwork("ethereum") for Ethereum Sepolia,
 * mainnetNetwork() for the mainnets); the RPC (overridable),
 * explorer, native currency and the default asset are added here because the
 * SDK stays transport-agnostic.
 *
 * Robinhood Chain and Tempo, each on mainnet (the ceremony's final keys,
 * payments only, deposit limits) and testnet (dev keys); Base and
 * Ethereum, each on mainnet and on a testnet (Base Sepolia, Ethereum Sepolia)
 * that runs the mainnet pool and final keys. A network with a pool
 * to publish (every mainnet, Base Sepolia, Ethereum Sepolia) only exists here
 * once the SDK has its pool, so a build without it
 * never offers that network. The chains are separate deployments of the same
 * pool design, so the same execution code serves every network.
 *
 * GLOAM_RPC_URL_<chainId> points a network at another RPC (for example a
 * private one), read when this module loads. Without it, a network whose
 * public RPC keeps only recent history (Ethereum Sepolia) reads old logs and
 * state from the SDK's historyRpc for it (signer.ts, gloamReadTransport).
 */
import type { Address } from "viem";
import {
  GLOAM_NETWORKS,
  NATIVE_ASSET,
  TEMPO_PATHUSD,
  mainnetNetwork,
  testnetNetwork,
  type CeremonyKind,
  type GloamNetwork,
  type HistoryRpc,
} from "@gloamtrade/sdk";

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
export type ChainFamily = "robinhood" | "tempo" | "base" | "ethereum" | "elysium";

export interface McpNetwork {
  key: NetworkKey;
  /** Which chain: Robinhood Chain, Tempo, Base or Ethereum, testnet or mainnet. */
  family: ChainFamily;
  /** Testnet (true) or mainnet (false). */
  testnet: boolean;
  /** The key set the pool's verifiers hold: dev on the older testnets, the ceremony's final keys on mainnet and Base Sepolia. */
  ceremony: CeremonyKind;
  name: string;
  chainId: number;
  pool: Address;
  /** The RPC at the chain head: receipts, fresh state, sends. */
  rpc: string;
  /** Where reads about old blocks go when `rpc` keeps only recent history; null when it keeps everything or GLOAM_RPC_URL_<chainId> is set. */
  historyRpc: HistoryRpc | null;
  explorer: string;
  /** Block the pool was deployed at, for tree scans. */
  deployBlock: bigint;
  nativeCurrency: { name: string; symbol: string; decimals: number };
  /** Whether native-value shields are allowed (Tempo blocks native msg.value; Robinhood Chain, Base and Ethereum list ETH). */
  nativeShield: boolean;
  /** Default asset to shield: native ETH on Robinhood testnet, PathUSD on Tempo testnet, the first listed asset elsewhere (USDG, USDC.e, USDC). */
  defaultAsset: Address;
  defaultAssetSymbol: string;
  defaultAssetDecimals: number;
}

type Env = Record<string, string | undefined>;

const rpcFor = (chainId: number, fallback: string, env: Env = process.env) =>
  env[`GLOAM_RPC_URL_${chainId}`]?.trim() || fallback;

const NATIVE = {
  robinhood: { name: "Ether", symbol: "ETH", decimals: 18 },
  tempo: { name: "US Dollar", symbol: "USD", decimals: 18 },
  base: { name: "Ether", symbol: "ETH", decimals: 18 },
  ethereum: { name: "Ether", symbol: "ETH", decimals: 18 },
  // Elysium, Kinetiq's Hyperliquid L2: gas in HYPE (mainnet and testnet, once the SDK has their values)
  elysium: { name: "HYPE", symbol: "HYPE", decimals: 18 },
} as const;

const CHAIN_NAMES: Record<ChainFamily, string> = { robinhood: "Robinhood Chain", tempo: "Tempo", base: "Base", ethereum: "Ethereum", elysium: "Elysium" };

/** A testnet's name: "Base Sepolia Testnet", "Ethereum Sepolia Testnet", "Tempo Testnet". */
function testnetName(family: ChainFamily): string {
  return family === "base" || family === "ethereum" ? `${CHAIN_NAMES[family]} Sepolia Testnet` : `${CHAIN_NAMES[family]} Testnet`;
}

export const MCP_NETWORKS: Record<"robinhood" | "tempo", McpNetwork> = {
  robinhood: {
    key: "robinhood",
    family: "robinhood",
    testnet: true,
    ceremony: "dev",
    name: "Robinhood Chain Testnet",
    chainId: GLOAM_NETWORKS.robinhood.chainId,
    pool: GLOAM_NETWORKS.robinhood.pool,
    rpc: rpcFor(GLOAM_NETWORKS.robinhood.chainId, "https://rpc.testnet.chain.robinhood.com"),
    historyRpc: null,
    explorer: "https://explorer.testnet.chain.robinhood.com",
    deployBlock: GLOAM_NETWORKS.robinhood.deployBlock,
    nativeCurrency: NATIVE.robinhood,
    nativeShield: true,
    defaultAsset: NATIVE_ASSET,
    defaultAssetSymbol: "ETH",
    defaultAssetDecimals: 18,
  },
  tempo: {
    key: "tempo",
    family: "tempo",
    testnet: true,
    ceremony: "dev",
    name: "Tempo Moderato Testnet",
    chainId: GLOAM_NETWORKS.tempo.chainId,
    pool: GLOAM_NETWORKS.tempo.pool,
    rpc: rpcFor(GLOAM_NETWORKS.tempo.chainId, "https://rpc.moderato.tempo.xyz"),
    historyRpc: null,
    explorer: "https://explore.testnet.tempo.xyz",
    deployBlock: GLOAM_NETWORKS.tempo.deployBlock,
    nativeCurrency: NATIVE.tempo,
    nativeShield: false,
    defaultAsset: TEMPO_PATHUSD,
    defaultAssetSymbol: "PathUSD",
    defaultAssetDecimals: 6,
  },
};

/** An SDK network with a published pool (a mainnet, or Base Sepolia), or null while it has none. */
function fromSdk(n: GloamNetwork | null): McpNetwork | null {
  if (!n) return null;
  // The first listed asset is the default: USDG on Robinhood Chain, USDC.e on Tempo, USDC on Base and Ethereum.
  const first = n.assets[0]!;
  return {
    key: n.key,
    family: n.family,
    testnet: n.testnet,
    ceremony: n.ceremony,
    name: n.testnet ? testnetName(n.family) : `${CHAIN_NAMES[n.family]} Mainnet`,
    chainId: n.chainId,
    pool: n.pool,
    rpc: rpcFor(n.chainId, n.rpcUrl),
    // an RPC set by hand serves everything itself, as before
    historyRpc: process.env[`GLOAM_RPC_URL_${n.chainId}`]?.trim() ? null : n.historyRpc,
    explorer: n.explorerUrl,
    deployBlock: n.deployBlock,
    nativeCurrency: NATIVE[n.family],
    nativeShield: n.nativeShield,
    defaultAsset: first.address,
    defaultAssetSymbol: first.symbol,
    defaultAssetDecimals: first.decimals,
  };
}

/** The mainnets this build has a pool for, Robinhood Chain first. Empty before deploy day. */
export const MCP_MAINNETS: McpNetwork[] = [
  fromSdk(mainnetNetwork("robinhood")),
  fromSdk(mainnetNetwork("tempo")),
  fromSdk(mainnetNetwork("base")),
  fromSdk(mainnetNetwork("ethereum")),
  // Elysium: once every value in the SDK's src/elysium.ts is in (chain id, RPC, USDC, pool)
  fromSdk(mainnetNetwork("elysium")),
].filter((n): n is McpNetwork => n !== null);

/** Base Sepolia, once the SDK has its pool; null before. */
export const MCP_BASE_TESTNET: McpNetwork | null = fromSdk(testnetNetwork("base"));

/** Ethereum Sepolia, once the SDK has its pool; null before. */
export const MCP_ETHEREUM_TESTNET: McpNetwork | null = fromSdk(testnetNetwork("ethereum"));

/** Elysium testnet (99801, gas in HYPE, test USDC), once the SDK has its pool; null before. */
export const MCP_ELYSIUM_TESTNET: McpNetwork | null = fromSdk(testnetNetwork("elysium"));

/** Every network this build can use: mainnets first, then the testnets. */
export function allNetworks(): McpNetwork[] {
  return [
    ...MCP_MAINNETS,
    MCP_NETWORKS.robinhood,
    MCP_NETWORKS.tempo,
    ...(MCP_BASE_TESTNET ? [MCP_BASE_TESTNET] : []),
    ...(MCP_ETHEREUM_TESTNET ? [MCP_ETHEREUM_TESTNET] : []),
    ...(MCP_ELYSIUM_TESTNET ? [MCP_ELYSIUM_TESTNET] : []),
  ];
}

/** Every key a Gloam network can have, whether or not this build has its pool. */
export const ALL_NETWORK_KEYS: readonly NetworkKey[] = [
  "robinhood-mainnet",
  "tempo-mainnet",
  "base-mainnet",
  "ethereum-mainnet",
  "elysium-mainnet",
  "robinhood",
  "tempo",
  "base",
  "ethereum",
  "elysium",
];

/** The network keys this build offers, for tool schemas (mainnets first). */
export const NETWORK_KEYS = allNetworks().map((n) => n.key) as [NetworkKey, ...NetworkKey[]];

export function isNetworkKey(v: unknown): v is NetworkKey {
  return typeof v === "string" && (NETWORK_KEYS as string[]).includes(v);
}

export function networkByKey(key: NetworkKey): McpNetwork {
  const n = allNetworks().find((x) => x.key === key);
  if (!n) throw new Error(`${key} is not available in this version of @gloamtrade/mcp: its pool is not published in the SDK it ships with. Update the package.`);
  return n;
}

export function networkByChainId(chainId: number): McpNetwork | undefined {
  return allNetworks().find((n) => n.chainId === chainId);
}

/** "Robinhood Chain mainnet" / "Tempo testnet" / "Ethereum Sepolia", for messages. */
export function describeNetwork(n: McpNetwork): string {
  const chain = CHAIN_NAMES[n.family];
  if (n.testnet && n.family === "ethereum") return "Ethereum Sepolia";
  return n.testnet ? `${chain} testnet` : `${chain} mainnet`;
}

/**
 * The network tools use when the agent does not name one: GLOAM_NETWORK when it
 * names a network this build has, else Robinhood Chain testnet as in earlier
 * versions. A GLOAM_NETWORK this build does not have fails loudly instead of
 * quietly using another network.
 */
export function defaultNetworkKey(env: Env = process.env): NetworkKey {
  const raw = env.GLOAM_NETWORK?.trim();
  if (!raw) return "robinhood";
  if (isNetworkKey(raw)) return raw;
  throw new Error(
    (ALL_NETWORK_KEYS as readonly string[]).includes(raw)
      ? `GLOAM_NETWORK=${raw}, but this version of @gloamtrade/mcp has no ${raw} pool yet. Update the package, or pick one of: ${NETWORK_KEYS.join(", ")}.`
      : `GLOAM_NETWORK=${raw} is not a Gloam network. Use one of: ${NETWORK_KEYS.join(", ")}.`
  );
}

/**
 * The Tempo network a Tempo access key lives on: Tempo mainnet when
 * GLOAM_NETWORK names a mainnet, otherwise Tempo testnet. An access key is
 * authorized per chain, so one made on testnet does nothing on mainnet.
 */
export function tempoAccessNetwork(env: Env = process.env): McpNetwork {
  return networkByKey(defaultNetworkKey(env)).testnet ? MCP_NETWORKS.tempo : networkByKey("tempo-mainnet");
}
