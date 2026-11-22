/**
 * Gloam on Solana, through Helius Solana Privacy Rings (the permissionless
 * Default Ring). Shared by the browser and the server.
 *
 * What it hides, said plainly wherever it shows: the asset and the amount of a
 * private payment. The two private accounts a payment moves between are public,
 * and adding money shows the wallet it came from. Gloam's account layer
 * (lib/solanaRings/account) keeps people's main wallets out of their payments.
 *
 * Off unless NEXT_PUBLIC_SOLANA_RINGS_ENABLED is "1". The Helius API key never
 * reaches the browser: every call goes through Gloam's proxy (/api/solana/*).
 */

export type RingsNetwork = "mainnet" | "devnet";

export const SOLANA_RINGS_ENABLED = process.env.NEXT_PUBLIC_SOLANA_RINGS_ENABLED === "1";

export const SOLANA_RINGS_NETWORK: RingsNetwork =
  process.env.NEXT_PUBLIC_SOLANA_RINGS_NETWORK === "devnet" ? "devnet" : "mainnet";

/** The Wallet Standard chain a Solana wallet signs for, on this network. */
export function walletChain(network: RingsNetwork = SOLANA_RINGS_NETWORK): string {
  return network === "devnet" ? "solana:devnet" : "solana:mainnet";
}

/** Gloam's proxy paths. Absolute URLs are made from the page's origin (ringsUrls). */
export const RINGS_PROXY_PATHS = { rpc: "/api/solana/rpc", spr: "/api/solana/spr", relay: "/api/solana/relay" } as const;

export function ringsUrls(origin: string): { rpc: string; spr: string; relay: string } {
  const o = origin.replace(/\/+$/, "");
  return { rpc: o + RINGS_PROXY_PATHS.rpc, spr: o + RINGS_PROXY_PATHS.spr, relay: o + RINGS_PROXY_PATHS.relay };
}

export type RingsAsset = {
  id: string;
  symbol: string;
  name: string;
  /** null for SOL itself. */
  mint: string | null;
  decimals: number;
  /** SPL Token unless said otherwise. */
  tokenProgram?: "token" | "token-2022";
};

const SOL: RingsAsset = { id: "sol", symbol: "SOL", name: "Solana", mint: null, decimals: 9 };

/**
 * What Add lists. An SPL token works once its one-time setup account (the
 * pool's SPL interface for that mint) exists on chain; the app reads that and
 * says "not set up yet" until then (client assetsReady). Read on 2026-11-22:
 * USDC and USDT are set up on mainnet, Circle's USDC on devnet. Another token:
 * scripts/solana-rings-setup-asset.mts.
 */
export const RINGS_ASSETS: Record<RingsNetwork, readonly RingsAsset[]> = {
  mainnet: [
    SOL,
    { id: "usdc", symbol: "USDC", name: "USD Coin", mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", decimals: 6 },
    { id: "usdt", symbol: "USDT", name: "Tether USD", mint: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", decimals: 6 },
  ],
  devnet: [
    SOL,
    // Circle's devnet USDC (faucet.circle.com)
    { id: "usdc", symbol: "USDC", name: "USD Coin", mint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", decimals: 6 },
  ],
};

export function ringsAssets(network: RingsNetwork = SOLANA_RINGS_NETWORK): readonly RingsAsset[] {
  return RINGS_ASSETS[network];
}

/**
 * How the Rings SDK names SOL in a private balance: the system program's
 * address (the SDK's SOL_MINT), not the wrapped SOL mint. scripts/
 * selftest-solana-rings.mts checks it against the SDK.
 */
export const RINGS_SOL_MINT = "11111111111111111111111111111111";

/** Each listed asset's private balance, in base units, from the SDK wallet's balances. */
export function ringsBalancesFrom(
  held: readonly { mint: string; amount: bigint }[],
  network: RingsNetwork = SOLANA_RINGS_NETWORK
): Record<string, bigint> {
  const byMint = new Map(held.map((b) => [b.mint, b.amount]));
  const out: Record<string, bigint> = {};
  for (const a of ringsAssets(network)) out[a.id] = byMint.get(a.mint ?? RINGS_SOL_MINT) ?? 0n;
  return out;
}

/** The plain words every Solana screen uses for what stays private. */
export const RINGS_PRIVACY_NOTE =
  "On Solana, a private payment hides the asset and the amount. The two private accounts it moves between are visible, and adding money shows the wallet it came from.";

/** The same, for payroll, where one transaction pays up to 15 people (lib/solanaRings/payroll). */
export const RINGS_PAYROLL_NOTE =
  "On Solana, payroll hides the asset and every amount. Your private account and each person's private account are visible, and up to 15 people paid together share one transaction.";

/** A Solana transaction on an explorer. */
export function ringsExplorerTx(signature: string, network: RingsNetwork = SOLANA_RINGS_NETWORK): string {
  return `https://solscan.io/tx/${encodeURIComponent(signature)}${network === "devnet" ? "?cluster=devnet" : ""}`;
}
