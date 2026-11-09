/**
 * Bring money in from another chain, through Relay (relay.link).
 *
 * Relay gives a one-time deposit address on the source chain. The person sends
 * a stablecoin or the chain's own coin there, from any wallet or exchange, and
 * Relay delivers the matching stablecoin (swapping if needed) to their own
 * wallet on Robinhood Chain or Tempo. From there they add it to their private
 * balance as usual. Nothing here touches the shielded pool: the bridge is a
 * public step, like any deposit.
 *
 * What a bridge costs is Relay's fee, plus Gloam's own cut when BRIDGE_FEE_BPS
 * and BRIDGE_FEE_RECIPIENT are set (bridgeFeeSetting, off by default). Both show
 * as their own lines before anything is sent. A deposit made directly from a
 * wallet on the vault's chain stays free.
 *
 * Relay only delivers to mainnets, so the panel stays hidden while Gloam runs
 * on testnet. NEXT_PUBLIC_BRIDGE_PREVIEW=1 shows it anyway for local review.
 *
 * Every chain and token below was checked with a live Relay deposit-address
 * quote into Robinhood Chain USDG on 2026-10-19 (Solana's route was checked
 * without a deposit address, which needs an API key). Logos are kept in
 * public/brand so a browser never calls a third party to draw them.
 */
import { formatUnits, isAddress } from "viem";
import type { ChainFamily, GloamNetwork } from "./networks";
import { ELYSIUM } from "./elysium";
import { chainLogoSrc } from "./chainLogo";

export type BridgeChainKind = "evm" | "svm" | "tvm" | "bvm";

export interface BridgeToken {
  symbol: string;
  /** Contract, mint or Relay's native-coin id on its own chain. */
  address: string;
  decimals: number;
  logo: string;
  /** A dollar stablecoin, so the amount is in dollars. */
  stable?: boolean;
}

export interface BridgeChain {
  /** Relay's chain id (Solana, Tron and Bitcoin use Relay's own ids). */
  id: number;
  name: string;
  kind: BridgeChainKind;
  /** Relay needs an API key for deposit addresses from this chain. */
  needsKey?: boolean;
  /** The network's own chain: a swap the wallet signs, not a deposit address. */
  swap?: boolean;
  tokens: BridgeToken[];
}

export const BRIDGE_CHAINS: BridgeChain[] = [
  { id: 1, name: "Ethereum", kind: "evm", tokens: [{ symbol: "USDC", address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", decimals: 6, logo: "/brand/tokens/usdc.png", stable: true }, { symbol: "USDT", address: "0xdac17f958d2ee523a2206206994597c13d831ec7", decimals: 6, logo: "/brand/tokens/usdt.png", stable: true }, { symbol: "USDG", address: "0xe343167631d89b6ffc58b88d6b7fb0228795491d", decimals: 6, logo: "/brand/tokens/usdg.png", stable: true }, { symbol: "PYUSD", address: "0x6c3ea9036406852006290770bedfcaba0e23a0e8", decimals: 6, logo: "/brand/tokens/pyusd.png", stable: true }, { symbol: "ETH", address: "0x0000000000000000000000000000000000000000", decimals: 18, logo: "/brand/tokens/eth.png" }] },
  { id: 8453, name: "Base", kind: "evm", tokens: [{ symbol: "USDC", address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", decimals: 6, logo: "/brand/tokens/usdc.png", stable: true }, { symbol: "USDT", address: "0xfde4c96c8593536e31f229ea8f37b2ada2699bb2", decimals: 6, logo: "/brand/tokens/usdt.png", stable: true }, { symbol: "ETH", address: "0x0000000000000000000000000000000000000000", decimals: 18, logo: "/brand/tokens/eth.png" }] },
  // Gloam's own mainnets, so money moves between them: Robinhood Chain into Base, Tempo into Ethereum
  { id: 4663, name: "Robinhood Chain", kind: "evm", tokens: [{ symbol: "USDG", address: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", decimals: 6, logo: "/brand/tokens/usdg.png", stable: true }, { symbol: "ETH", address: "0x0000000000000000000000000000000000000000", decimals: 18, logo: "/brand/tokens/eth.png" }] },
  { id: 4217, name: "Tempo", kind: "evm", tokens: [{ symbol: "USDC.e", address: "0x20c000000000000000000000b9537d11c60e8b50", decimals: 6, logo: "/brand/tokens/usdc.png", stable: true }] },
  { id: 792703809, name: "Solana", kind: "svm", needsKey: true, tokens: [{ symbol: "USDC", address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", decimals: 6, logo: "/brand/tokens/usdc.png", stable: true }, { symbol: "USDT", address: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", decimals: 6, logo: "/brand/tokens/usdt.png", stable: true }, { symbol: "USDG", address: "2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH", decimals: 6, logo: "/brand/tokens/usdg.png", stable: true }, { symbol: "PYUSD", address: "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo", decimals: 6, logo: "/brand/tokens/pyusd.png", stable: true }, { symbol: "SOL", address: "11111111111111111111111111111111", decimals: 9, logo: "/brand/tokens/sol.png" }] },
  { id: 56, name: "BNB Chain", kind: "evm", tokens: [{ symbol: "USDC", address: "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d", decimals: 18, logo: "/brand/tokens/usdc.png", stable: true }, { symbol: "USDT", address: "0x55d398326f99059ff775485246999027b3197955", decimals: 18, logo: "/brand/tokens/usdt.png", stable: true }, { symbol: "BNB", address: "0x0000000000000000000000000000000000000000", decimals: 18, logo: "/brand/tokens/bnb.png" }] },
  { id: 8253038, name: "Bitcoin", kind: "bvm", tokens: [{ symbol: "BTC", address: "bc1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqmql8k8", decimals: 8, logo: "/brand/tokens/btc.png" }] },
  { id: 42161, name: "Arbitrum", kind: "evm", tokens: [{ symbol: "USDC", address: "0xaf88d065e77c8cc2239327c5edb3a432268e5831", decimals: 6, logo: "/brand/tokens/usdc.png", stable: true }, { symbol: "USDT", address: "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9", decimals: 6, logo: "/brand/tokens/usdt.png", stable: true }, { symbol: "ETH", address: "0x0000000000000000000000000000000000000000", decimals: 18, logo: "/brand/tokens/eth.png" }] },
  { id: 728126428, name: "Tron", kind: "tvm", tokens: [{ symbol: "USDT", address: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t", decimals: 6, logo: "/brand/tokens/usdt.png", stable: true }, { symbol: "TRX", address: "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb", decimals: 6, logo: "/brand/tokens/trx.png" }] },
  { id: 137, name: "Polygon", kind: "evm", tokens: [{ symbol: "USDC", address: "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359", decimals: 6, logo: "/brand/tokens/usdc.png", stable: true }, { symbol: "USDT", address: "0xc2132d05d31c914a87c6611c10748aeb04b58e8f", decimals: 6, logo: "/brand/tokens/usdt.png", stable: true }, { symbol: "USDC.e", address: "0x2791bca1f2de4661ed88a30c99a7a9449aa84174", decimals: 6, logo: "/brand/tokens/usdc.e.png", stable: true }] },
  { id: 10, name: "Optimism", kind: "evm", tokens: [{ symbol: "USDC", address: "0x0b2c639c533813f4aa9d7837caf62653d097ff85", decimals: 6, logo: "/brand/tokens/usdc.png", stable: true }, { symbol: "USDT", address: "0x94b008aa00579c1307b0ef2c499ad98a8ce58e58", decimals: 6, logo: "/brand/tokens/usdt.png", stable: true }, { symbol: "ETH", address: "0x0000000000000000000000000000000000000000", decimals: 18, logo: "/brand/tokens/eth.png" }] },
  { id: 43114, name: "Avalanche", kind: "evm", tokens: [{ symbol: "USDC", address: "0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e", decimals: 6, logo: "/brand/tokens/usdc.png", stable: true }] },
  { id: 59144, name: "Linea", kind: "evm", tokens: [{ symbol: "USDC", address: "0x176211869ca2b568f2a7d4ee941e073a821ee1ff", decimals: 6, logo: "/brand/tokens/usdc.png", stable: true }, { symbol: "ETH", address: "0x0000000000000000000000000000000000000000", decimals: 18, logo: "/brand/tokens/eth.png" }] },
  { id: 324, name: "zkSync Era", kind: "evm", tokens: [{ symbol: "ETH", address: "0x0000000000000000000000000000000000000000", decimals: 18, logo: "/brand/tokens/eth.png" }] },
  { id: 130, name: "Unichain", kind: "evm", tokens: [{ symbol: "USDC", address: "0x078d782b760474a361dda0af3839290b0ef57ad6", decimals: 6, logo: "/brand/tokens/usdc.png", stable: true }, { symbol: "ETH", address: "0x0000000000000000000000000000000000000000", decimals: 18, logo: "/brand/tokens/eth.png" }] },
  { id: 480, name: "World Chain", kind: "evm", tokens: [{ symbol: "USDC", address: "0x79a02482a880bce3f13e09da970dc34db4cd24d1", decimals: 6, logo: "/brand/tokens/usdc.png", stable: true }, { symbol: "ETH", address: "0x0000000000000000000000000000000000000000", decimals: 18, logo: "/brand/tokens/eth.png" }] },
  { id: 143, name: "Monad", kind: "evm", tokens: [{ symbol: "USDC", address: "0x754704bc059f8c67012fed69bc8a327a5aafb603", decimals: 6, logo: "/brand/tokens/usdc.png", stable: true }, { symbol: "USDT0", address: "0xe7cd86e13ac4309349f30b3435a9d337750fc82d", decimals: 6, logo: "/brand/tokens/usdt0.png", stable: true }, { symbol: "MON", address: "0x0000000000000000000000000000000000000000", decimals: 18, logo: "/brand/tokens/mon.png" }] },
  { id: 999, name: "HyperEVM", kind: "evm", tokens: [{ symbol: "USDC", address: "0xb88339cb7199b77e23db6e890353e22632ba630f", decimals: 6, logo: "/brand/tokens/usdc.png", stable: true }, { symbol: "HYPE", address: "0x0000000000000000000000000000000000000000", decimals: 18, logo: "/brand/tokens/hype.png" }] },
  { id: 146, name: "Sonic", kind: "evm", tokens: [{ symbol: "USDC", address: "0x29219dd400f2bf60e5a23d13be72b486d4038894", decimals: 6, logo: "/brand/tokens/usdc.png", stable: true }] },
  { id: 5000, name: "Mantle", kind: "evm", tokens: [{ symbol: "USDC", address: "0x09bc4e0d864854c6afb6eb9a9cdf58ac190d0df9", decimals: 6, logo: "/brand/tokens/usdc.png", stable: true }, { symbol: "USDT0", address: "0x779ded0c9e1022225f8e0630b35a9b54be713736", decimals: 6, logo: "/brand/tokens/usdt0.png", stable: true }] },
  { id: 196, name: "X Layer", kind: "evm", tokens: [{ symbol: "USDC", address: "0xb6ceceab302e2e4948951ee7843fc24e92933061", decimals: 6, logo: "/brand/tokens/usdc.png", stable: true }, { symbol: "USDG", address: "0x4ae46a509f6b1d9056937ba4500cb143933d2dc8", decimals: 6, logo: "/brand/tokens/usdg.png", stable: true }] },
  { id: 42220, name: "Celo", kind: "evm", tokens: [{ symbol: "USDC", address: "0xceba9300f2b948710d2653dd7b07f33a8b32118c", decimals: 6, logo: "/brand/tokens/usdc.png", stable: true }] },
  { id: 100, name: "Gnosis", kind: "evm", tokens: [{ symbol: "USDC", address: "0x2a22f9c3b484c3629090feed35f17ff8f88f76f0", decimals: 6, logo: "/brand/tokens/usdc.png", stable: true }] },
  { id: 534352, name: "Scroll", kind: "evm", tokens: [{ symbol: "ETH", address: "0x0000000000000000000000000000000000000000", decimals: 18, logo: "/brand/tokens/eth.png" }] },
  { id: 57073, name: "Ink", kind: "evm", tokens: [{ symbol: "ETH", address: "0x0000000000000000000000000000000000000000", decimals: 18, logo: "/brand/tokens/eth.png" }] },
  { id: 80094, name: "Berachain", kind: "evm", tokens: [{ symbol: "USDC", address: "0x549943e04f40284185054145c6e4e9568c1d3241", decimals: 6, logo: "/brand/tokens/usdc.png", stable: true }] },
  { id: 81457, name: "Blast", kind: "evm", tokens: [{ symbol: "ETH", address: "0x0000000000000000000000000000000000000000", decimals: 18, logo: "/brand/tokens/eth.png" }] },
];

export interface BridgeDestination {
  chainId: number;
  chain: string;
  token: { symbol: string; address: string; decimals: number; logo: string };
}

/**
 * Where money lands on each chain: the mainnet stablecoin its pool takes. A
 * chain with no entry has no bridge in yet, so the app shows no bridge panel
 * there and the bridge routes refuse it.
 */
export const BRIDGE_DESTINATIONS: Partial<Record<ChainFamily, BridgeDestination>> = {
  robinhood: {
    chainId: 4663,
    chain: "Robinhood Chain",
    token: { symbol: "USDG", address: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", decimals: 6, logo: "/brand/tokens/usdg.png" },
  },
  tempo: {
    chainId: 4217,
    chain: "Tempo",
    token: { symbol: "USDC", address: "0x20c000000000000000000000b9537d11c60e8b50", decimals: 6, logo: "/brand/tokens/usdc.png" },
  },
  base: {
    chainId: 8453,
    chain: "Base",
    token: { symbol: "USDC", address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6, logo: "/brand/tokens/usdc.png" },
  },
  ethereum: {
    chainId: 1,
    chain: "Ethereum",
    token: { symbol: "USDC", address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6, logo: "/brand/tokens/usdc.png" },
  },
  // Elysium, with the flag on: Relay lists chain 99901 and its USDC. Live quotes on
  // 2026-11-09: 20 USDC from Base or Arbitrum landed 19.975 USDC in about 10 s.
  ...(ELYSIUM
    ? {
        elysium: {
          chainId: ELYSIUM.chainId,
          chain: "Elysium",
          token: { symbol: "USDC", address: ELYSIUM.usdc, decimals: ELYSIUM.usdcDecimals, logo: "/brand/tokens/usdc.png" },
        },
      }
    : {}),
};

/** The chains money can come from into `destChainId`: every listed chain but that one. */
export function bridgeSources<T extends { id: number }>(chains: readonly T[], destChainId: number): T[] {
  return chains.filter((c) => c.id !== destChainId);
}

/**
 * The gas coin on a network's own chain, swapped by Relay into the pool's
 * stablecoin in the same wallet. Same chain, so the wallet signs one swap
 * instead of sending to a deposit address, which costs far less: a live quote
 * on 2026-10-21 gave 2.490 USDG for 0.001 ETH this way, 2.441 through an address.
 */
export const SWAP_SOURCES: Partial<Record<ChainFamily, BridgeChain>> = {
  robinhood: {
    id: 4663,
    name: "Robinhood Chain",
    kind: "evm",
    swap: true,
    tokens: [{ symbol: "ETH", address: "0x0000000000000000000000000000000000000000", decimals: 18, logo: "/brand/tokens/eth.png" }],
  },
  // ETH to USDC on the same chain (live quotes 2026-10-26: 0.002 ETH gave about 4.64 USDC on both)
  base: {
    id: 8453,
    name: "Base",
    kind: "evm",
    swap: true,
    tokens: [{ symbol: "ETH", address: "0x0000000000000000000000000000000000000000", decimals: 18, logo: "/brand/tokens/eth.png" }],
  },
  ethereum: {
    id: 1,
    name: "Ethereum",
    kind: "evm",
    swap: true,
    tokens: [{ symbol: "ETH", address: "0x0000000000000000000000000000000000000000", decimals: 18, logo: "/brand/tokens/eth.png" }],
  },
  // HYPE to USDC on Elysium (live quote 2026-11-09: 0.1 HYPE gave about 7.05 USDC)
  ...(ELYSIUM
    ? {
        elysium: {
          id: ELYSIUM.chainId,
          name: "Elysium",
          kind: "evm" as const,
          swap: true,
          tokens: [{ symbol: "HYPE", address: "0x0000000000000000000000000000000000000000", decimals: 18, logo: "/brand/tokens/hype.png" }],
        },
      }
    : {}),
};

/** The swap on this network's own chain, when it has one: mainnet only, since Relay only swaps on mainnets. */
export function swapSource(network: Pick<GloamNetwork, "family" | "chainId">): BridgeChain | null {
  const s = SWAP_SOURCES[network.family];
  return s && s.id === network.chainId ? s : null;
}

/**
 * A wallet's balance of a bridge token, rounded down so it never claims more
 * than is there: two decimals for a stablecoin, up to six significant digits
 * for a chain's own coin ("727.49", "0.0123456").
 */
export function formatBridgeBalance(value: bigint, decimals: number, stable = false): string {
  // Cut as text, so no float rounding ever shows a cent that isn't there.
  const [whole = "0", frac = ""] = formatUnits(value < BigInt(0) ? BigInt(0) : value, decimals).split(".");
  const grouped = BigInt(whole).toLocaleString("en-US");
  if (stable) return `${grouped}.${frac.padEnd(2, "0").slice(0, 2)}`;
  const keep = whole !== "0" ? Math.max(0, 6 - whole.length) : (frac.match(/^0*/)?.[0].length ?? 0) + 6;
  const f = frac.slice(0, keep).replace(/0+$/, "");
  return f ? `${grouped}.${f}` : grouped;
}

/** ETH kept back by Max, so the swap itself can still pay its network fee. */
export const SWAP_GAS_RESERVE_WEI = BigInt(200_000_000_000_000);

/**
 * Gloam's tag on Relay quotes, so /admin can read back what went through the
 * panel (lib/relayVolume). Relay takes it only with an API key.
 */
export const RELAY_REFERRER = "gloam.trade";

/** Dollar limits for one bridge, checked against Relay's own dollar value of the deposit. */
export const BRIDGE_MIN_USD = 1;
export const BRIDGE_MAX_USD = 25_000;

const CHAIN_NAMES = new Map<number, string>([
  ...BRIDGE_CHAINS.map((c) => [c.id, c.name] as [number, string]),
  ...Object.values(BRIDGE_DESTINATIONS).map((d) => [d!.chainId, d!.chain] as [number, string]),
]);

/** A chain's name by Relay id, or "Chain <id>" when Gloam doesn't list it. */
export function relayChainName(id: number | null): string {
  if (id == null) return "Unknown";
  return CHAIN_NAMES.get(id) ?? `Chain ${id}`;
}

export function bridgeChain(id: number): BridgeChain | null {
  return BRIDGE_CHAINS.find((c) => c.id === id) ?? null;
}

export function bridgeToken(chain: BridgeChain, symbol: string): BridgeToken | null {
  return chain.tokens.find((t) => t.symbol === symbol) ?? null;
}

/** Elysium's id is not a literal, so its mark comes from lib/chainLogo (no /brand/chains/99901.png). */
export function chainLogo(id: number, dark = false): string {
  return chainLogoSrc(id, dark);
}

/** Shown on mainnets, or anywhere when the preview flag is on. */
export function bridgeVisible(network: GloamNetwork): boolean {
  if (!BRIDGE_DESTINATIONS[network.family]) return false;
  return process.env.NEXT_PUBLIC_BRIDGE_PREVIEW === "1" || !network.chain.testnet;
}

/** A refund address on a non-EVM source chain, roughly checked. */
export function validRefundAddress(kind: BridgeChainKind, v: string): boolean {
  if (kind === "svm") return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v);
  if (kind === "tvm") return /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(v);
  if (kind === "bvm") return /^(bc1[02-9ac-hj-np-z]{11,71}|[13][1-9A-HJ-NP-Za-km-z]{25,34})$/.test(v);
  return /^0x[0-9a-fA-F]{40}$/.test(v);
}

/** Gloam's cut of a quote, when it takes one: the rate, and what Relay priced it at in dollars. */
export type BridgeAppFee = { bps: number; usd: number };

/** Gloam's optional cut of a bridge, from the server's env: on only with a whole rate of 1 to 100 bps and a valid recipient. */
export function bridgeFeeSetting(env: Record<string, string | undefined>): { bps: number; recipient: string } | null {
  const bps = Number(env.BRIDGE_FEE_BPS ?? "");
  const recipient = env.BRIDGE_FEE_RECIPIENT ?? "";
  return Number.isInteger(bps) && bps > 0 && bps <= 100 && isAddress(recipient) ? { bps, recipient } : null;
}

/** The appFees Relay takes: left out when Gloam takes no cut. */
export function relayAppFees(setting: { bps: number; recipient: string } | null): { recipient: string; fee: string }[] | undefined {
  return setting ? [{ recipient: setting.recipient, fee: String(setting.bps) }] : undefined;
}

/**
 * Gloam's cut as a quote should show it. It is what Relay says it charged; when
 * Relay leaves it out, the rate on what is paid, so a cut that is on always has
 * a line. Null with no cut.
 */
export function quotedAppFee(setting: { bps: number } | null, relayUsd: unknown, paidUsd: number): BridgeAppFee | null {
  if (!setting) return null;
  const said = Number(relayUsd ?? NaN);
  const usd = Number.isFinite(said) && said > 0 ? said : Number.isFinite(paidUsd) ? (paidUsd * setting.bps) / 10_000 : 0;
  return { bps: setting.bps, usd: Math.round(usd * 100) / 100 };
}

/** The fee lines of a quote: Relay's, then Gloam's when it takes one. `feeUsd` holds both. */
export function bridgeFeeLines(q: { feeUsd: number; appFee: BridgeAppFee | null }): { relayUsd: number; app: BridgeAppFee | null } {
  return { relayUsd: Math.max(Math.round((q.feeUsd - (q.appFee?.usd ?? 0)) * 100) / 100, 0), app: q.appFee };
}

export type BridgeQuote = {
  requestId: string;
  /** Empty for a swap, which the wallet signs as `tx` instead, and for a bridge the wallet signs (`evmTxs`). */
  depositAddress: string;
  tx: { to: string; data: string; value: string; chainId: number } | null;
  /**
   * A bridge paid from the connected EVM wallet to itself on the destination
   * chain: the transactions it signs in order (an approve, then the deposit; or
   * the deposit alone). Checked by walletBridgeTxs before it is handed out.
   */
  evmTxs?: { to: string; data: string; value: string; chainId: number }[];
  send: { amount: string; symbol: string; chain: string; chainId: number; logo: string; usd: number | null };
  receive: { amount: string; minimum: string; symbol: string; chain: string; logo: string };
  /** Everything taken in fees: Relay's, and Gloam's own when it takes one (appFee). */
  feeUsd: number;
  appFee: BridgeAppFee | null;
  /** Relay's estimate in seconds; Bitcoin also waits for its own confirmations. */
  timeSec: number;
  bitcoin: boolean;
};

const APPROVE_SELECTOR = "0x095ea7b3";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const HEX = /^0x[0-9a-fA-F]*$/;

/**
 * The transactions a connected EVM wallet signs to bridge `amount` of `token`
 * to itself, read from Relay's /quote answer (`data`), or null when they are
 * anything but the plain shape. Nothing else is handed to a wallet:
 *  - every step a "transaction" with one item, on `chain.id`, to an address,
 *    with hex data (and from `from`, when Relay names a sender);
 *  - [approve, deposit] for a token, or [deposit] alone;
 *  - the approve is `token`'s own approve(spender, n), spender the deposit's
 *    contract, n at least `amount`, no value;
 *  - the deposit sends no value for a token, and exactly `amount` for the
 *    chain's own coin (which never needs an approve).
 */
export function walletBridgeTxs(
  data: unknown,
  chain: { id: number },
  token: { address: string },
  amount: bigint,
  from?: string,
): { to: string; data: string; value: string; chainId: number }[] | null {
  const steps = (data as { steps?: unknown } | null)?.steps;
  if (!Array.isArray(steps) || steps.length < 1 || steps.length > 2) return null;
  const txs: { to: string; data: string; value: string; chainId: number }[] = [];
  for (const s of steps as { kind?: unknown; items?: unknown }[]) {
    if (s?.kind !== "transaction" || !Array.isArray(s.items) || s.items.length !== 1) return null;
    const x = (s.items[0] as { data?: Record<string, unknown> } | null)?.data;
    if (!x || Number(x.chainId) !== chain.id) return null;
    if (typeof x.to !== "string" || !isAddress(x.to) || typeof x.data !== "string" || !HEX.test(x.data)) return null;
    if (x.from !== undefined && (typeof from !== "string" || String(x.from).toLowerCase() !== from.toLowerCase())) return null;
    let value: bigint;
    try {
      value = BigInt((x.value as string | number | undefined) ?? 0);
    } catch {
      return null;
    }
    if (value < BigInt(0)) return null;
    txs.push({ to: x.to, data: x.data, value: value.toString(), chainId: chain.id });
  }
  const native = token.address.toLowerCase() === ZERO_ADDRESS;
  const deposit = txs[txs.length - 1]!;
  if (deposit.data.slice(0, 10).toLowerCase() === APPROVE_SELECTOR) return null;
  if (native) {
    if (txs.length !== 1 || BigInt(deposit.value) !== amount) return null;
    return txs;
  }
  if (BigInt(deposit.value) !== BigInt(0)) return null;
  if (txs.length === 2) {
    const approve = txs[0]!;
    // approve(address,uint256): selector, then two 32-byte words
    const d = approve.data.toLowerCase();
    if (d.length !== 10 + 64 * 2 || d.slice(0, 10) !== APPROVE_SELECTOR) return null;
    if (approve.to.toLowerCase() !== token.address.toLowerCase() || BigInt(approve.value) !== BigInt(0)) return null;
    if (d.slice(10, 34) !== "0".repeat(24)) return null;
    const spender = `0x${d.slice(34, 74)}`;
    if (spender !== deposit.to.toLowerCase()) return null;
    if (BigInt(`0x${d.slice(74, 138)}`) < amount) return null;
  }
  return txs;
}

/**
 * Chains a connected wallet can pay from straight into the private balance:
 * the wallet signs and Relay makes the deposit when the money arrives (an
 * approve and shieldBound run by Relay's router on Robinhood Chain or Tempo).
 * That covers a Solana wallet, an EVM wallet on any listed chain, and the swap
 * on the network's own chain. A deposit address can't carry that call, so
 * sending from an exchange still lands in the wallet first.
 */
export function privateBridgeable(chain: BridgeChain): boolean {
  return chain.kind === "svm" || chain.kind === "evm";
}

/** One transaction an EVM wallet signs for a private bridge order. */
export type PrivateBridgeTx = { to: string; data: string; value: string; chainId: number };

/** A Relay order that pays into the private balance, ready for the source wallet to sign. */
export type PrivateBridgeQuote = {
  requestId: string;
  /** The unsigned Solana transaction, base64, when a Solana wallet pays. */
  solanaTx: string | null;
  /** The transactions an EVM wallet signs in order (an approve, then the deposit; or one swap). */
  evmTxs: PrivateBridgeTx[] | null;
  /** The swap on this chain: the deposit happens in the same transaction. */
  sameChain: boolean;
  send: { amount: string; symbol: string; chain: string; chainId: number; logo: string; usd: number | null };
  receive: { amount: string; symbol: string; chain: string; logo: string };
  /** What's left of the swap after the deposit, back to the wallet as the stablecoin (swapLeftover). */
  extra: string | null;
  /** Everything taken in fees: Relay's, and Gloam's own when it takes one (appFee). */
  feeUsd: number;
  appFee: BridgeAppFee | null;
  /** The paying chain's own network fee, when Relay prices it. */
  gasUsd: number | null;
  timeSec: number;
};

/**
 * The slippage asked of Relay on a same-chain swap into the private balance,
 * in basis points. Its default is 100. Over 54 live quotes in the real order
 * shape on 2026-11-02, 30 paid in a median 0.59% over the amount against 1.51%,
 * and every size still got a route. A swap that misses reverts whole, for the
 * network fee only.
 */
export const SWAP_SLIPPAGE_BPS = "30";

/**
 * The most of what's paid a buffer takes, as far as a leftover is estimated.
 * The widest in those quotes when Relay named no leftover was 1.22%. Past
 * this share the gap is treated as the route's cost, not as money coming back.
 */
export const SWAP_BUFFER_MAX_SHARE = 0.015;

/**
 * What comes back to the wallet from a same-chain swap, as the stablecoin:
 * the swap sells all the ETH sent, the deposit takes `amount` and the rest is
 * returned. Relay answers two ways. Some routes state the swap's output above
 * the amount, and that is the answer. Others (0x) state exactly the amount
 * while the input is just as padded, so the leftover is what's paid in dollars
 * less the amount and Relay's fee.
 *
 * An estimate stops at SWAP_BUFFER_MAX_SHARE, because routeCost counts this as
 * money coming out: uncapped it would cancel the very gap a bad route shows up
 * as, and leaving it out would count an ordinary buffer as a cost. Null when
 * nothing comes back or it can't be told.
 */
export function swapLeftover(q: { out: bigint; amount: bigint; decimals: number; paidUsd: number | null; feeUsd: number }): string | null {
  if (q.out > q.amount) return formatUnits(q.out - q.amount, q.decimals);
  if (q.paidUsd === null || !Number.isFinite(q.paidUsd) || !Number.isFinite(q.feeUsd)) return null;
  const gap = q.paidUsd - Number(formatUnits(q.amount, q.decimals)) - q.feeUsd;
  const left = Math.min(gap, q.paidUsd * SWAP_BUFFER_MAX_SHARE).toFixed(q.decimals);
  return Number(left) > 0 ? left : null;
}

/** "about 11 USDG", or null under a cent. Whole above ten: the figure moves with the price until the swap lands. */
export function leftoverLabel(q: { extra: string | null; receive: { symbol: string } }): string | null {
  const n = Number(q.extra ?? 0);
  if (!(n >= 0.01)) return null;
  const shown = n < 10 ? n.toFixed(2) : Math.round(n).toLocaleString("en-US");
  return `about ${shown} ${q.receive.symbol}`;
}

/**
 * What the wallet's confirm screen will show for a same-chain swap, said before
 * it opens. The wallet sees the ETH go out and the leftover come back, and can
 * never see the deposit. Without a figure, it still may show some.
 */
export function swapWalletNote(q: { extra: string | null; receive: { amount: string; symbol: string } }): string {
  const n = Number(q.receive.amount);
  const amount = n.toLocaleString("en-US", { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 });
  const back = leftoverLabel(q);
  return `Your wallet ${back ? `will show ${back}` : `may show a little ${q.receive.symbol}`} coming back. That's the leftover from the swap. The ${amount} ${q.receive.symbol} goes straight into your private balance, so your wallet won't list it.`;
}

export type BridgeStage = "waiting" | "moving" | "done" | "failed" | "refunded";

export type BridgeStatus = { stage: BridgeStage; outTx: string | null };

/**
 * A route worth a second look before sending: it costs more than 3% of what
 * you pay and at least $1, so a few cents on a small test stays quiet.
 */
export const EXPENSIVE_ROUTE_SHARE = 0.03;
export const EXPENSIVE_ROUTE_MIN_USD = 1;

/** The parts of a quote that say what it costs (BridgeQuote and PrivateBridgeQuote both fit). */
export type CostedQuote = {
  send: { usd: number | null };
  receive: { amount: string };
  feeUsd: number;
  extra?: string | null;
  gasUsd?: number | null;
};

/**
 * What a route costs in dollars: what you pay less the stablecoin that comes
 * out (the price buffer sent back to the wallet counts as coming out), and
 * never less than Relay's own fee, plus the paying chain's network fee when
 * Relay prices it. `share` is that cost over what you pay, or null when Relay
 * doesn't price what you pay; then the cost is Relay's fee alone.
 */
export function routeCost(q: CostedQuote): { usd: number; share: number | null } | null {
  const gas = q.gasUsd ?? 0;
  const paid = q.send.usd;
  const out = Number(q.receive.amount) + (q.extra ? Number(q.extra) : 0);
  if (paid !== null && paid > 0 && Number.isFinite(out)) {
    const usd = Math.max(paid - out, q.feeUsd, 0) + gas;
    return { usd, share: usd / paid };
  }
  const usd = q.feeUsd + gas;
  return Number.isFinite(usd) ? { usd, share: null } : null;
}

/** The cost to warn about before anything is sent, or null when the route is priced fine (or can't be told). */
export function expensiveRoute(q: CostedQuote): { usd: number; share: number } | null {
  const c = routeCost(q);
  if (!c || c.share === null) return null;
  return c.share > EXPENSIVE_ROUTE_SHARE && c.usd >= EXPENSIVE_ROUTE_MIN_USD ? { usd: c.usd, share: c.share } : null;
}
