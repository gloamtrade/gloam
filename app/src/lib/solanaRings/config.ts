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

/** Where the app reports a wallet add that landed, for /admin's counts (app/api/solana/added). */
export const RINGS_ADDED_PATH = "/api/solana/added";

export function ringsUrls(origin: string): { rpc: string; spr: string; relay: string } {
  const o = origin.replace(/\/+$/, "");
  return { rpc: o + RINGS_PROXY_PATHS.rpc, spr: o + RINGS_PROXY_PATHS.spr, relay: o + RINGS_PROXY_PATHS.relay };
}

/**
 * Below this the relay reports itself unfunded (GET /api/solana/relay answers
 * funded: false and the app pauses Solana payments): enough for a few dozen
 * payments or a handful of registrations. The status page reads it too.
 */
export const RINGS_RELAY_LOW_LAMPORTS = 10_000_000;

/**
 * Solana takes a transaction's fee from its fee payer, then needs that account
 * either empty or still rent-exempt. For a wallet (a system account with no
 * data) rent-exempt is 890,880 lamports.
 */
export const RENT_EXEMPT_WALLET_LAMPORTS = 890_880n;

/**
 * What a wallet's own token add costs it in fees: one signature (5,000
 * lamports) and the deposit's priority fee (client asVersion0: 200,000 units
 * at 20,000 micro-lamports, 4,000 lamports). What the page goes by before the
 * add is built; the client checks the exact fee of what it built.
 */
export const WALLET_ADD_FEE_LAMPORTS = 9_000n;

/** Whether a wallet holding `lamports` can pay `fee` and be left empty or rent-exempt. */
export function walletPaysFee(lamports: bigint, fee: bigint): boolean {
  if (lamports < fee) return false;
  const left = lamports - fee;
  return left === 0n || left >= RENT_EXEMPT_WALLET_LAMPORTS;
}

/**
 * Who pays the network fee when a wallet adds money privately: the wallet
 * whenever it can (always for SOL itself: a wallet with no SOL has none to
 * add), else Gloam's relay for a token, when the relay is on and funded and
 * the wallet can sign without sending (the relay signs last, as fee payer).
 * "needs_sol" when neither can. `walletLamports` null (not read): the wallet.
 */
export function addFeePayer(input: {
  asset: Pick<RingsAsset, "mint">;
  walletLamports: bigint | null;
  fee?: bigint;
  relay: { on: boolean; funded: boolean; relayer: string | null } | null;
  signOnly: boolean;
}): "wallet" | "relay" | "needs_sol" {
  if (!input.asset.mint || input.walletLamports === null) return "wallet";
  if (walletPaysFee(input.walletLamports, input.fee ?? WALLET_ADD_FEE_LAMPORTS)) return "wallet";
  return input.relay?.on && input.relay.funded && input.relay.relayer && input.signOnly ? "relay" : "needs_sol";
}

/**
 * Where a Solana claim link opened in the app waits in this tab while the
 * wallet connects (lib/solanaRings/claimKeep). Here, with nothing else loaded,
 * because WelcomeModal's first-paint script reads it too. Never rename it.
 */
export const SOLANA_CLAIM_KEY = "gloam.solanaClaim";

/** How the site names the network: "Solana", or "Solana devnet" on a devnet build. */
export const SOLANA_NAME = SOLANA_RINGS_NETWORK === "devnet" ? "Solana devnet" : "Solana";

export type RingsAsset = {
  id: string;
  symbol: string;
  name: string;
  /** null for SOL itself. */
  mint: string | null;
  decimals: number;
  /** SPL Token unless said otherwise. */
  tokenProgram?: "token" | "token-2022";
  /** A dollar stablecoin: worth a dollar a unit. Anything else is priced at its coin's market price (ringsUsd). */
  stable?: boolean;
  /**
   * Listed on a screen only once its ring interface is read on chain (client
   * assetsReady says true), never as "not set up yet" (shownAssets). Money
   * already held in it always shows.
   */
  hiddenUntilReady?: boolean;
  /** One plain line on what this token is, where it matters (Add, the docs). */
  note?: string;
};

const SOL: RingsAsset = { id: "sol", symbol: "SOL", name: "Solana", mint: null, decimals: 9 };

/**
 * What bridged ZEC is on Solana, said plainly: the token and the amount stay
 * hidden once it is private here; the bridge and an add from a wallet do not.
 */
export const RINGS_ZEC_NOTE =
  "ZEC on Solana is Zcash brought over by NEAR's Omni Bridge, a public token there. Once it is private here, the token and the amount stay hidden. The bridge itself and adding from your wallet are public.";

/**
 * Zcash on Solana: NEAR Omni Bridge's wrapped ZEC (zec.omft.near on NEAR),
 * the mint Jupiter verifies and Kamino's ZEC market lends. SPL Token (no
 * Token-2022 extensions), 8 decimals, no freeze authority; the mint authority
 * is the Omni Bridge program's authority PDA. Read on 2026-11-23: the NEAR
 * bridge contract (omni.bridge.near get_bridged_token) maps zec.omft.near to
 * this mint, and its ring interface is set up on mainnet (registry
 * 4tB2qXKcRtDdkprU6NeovJCfLbTefeyEbnhfqh2HwpXr, made 2026-11-10).
 */
export const ZEC_SOLANA_MINT = "A7bdiYdS5GjqGFtxf17ppRHtDKPkkRqbKtR27dxvQXaS";
/** ZEC's decimals on Solana, and the places it shows to (screens: SolanaAccount formatSolAmount). */
export const ZEC_DECIMALS = 8;
export const ZEC_PLACES = 4;
const ZEC: RingsAsset = {
  id: "zec",
  symbol: "ZEC",
  name: "Zcash",
  mint: ZEC_SOLANA_MINT,
  decimals: ZEC_DECIMALS,
  hiddenUntilReady: true,
  note: RINGS_ZEC_NOTE,
};

/**
 * What Add lists. An SPL token works once its one-time setup account (the
 * pool's SPL interface for that mint) exists on chain; the app reads that and
 * says "not set up yet" until then (client assetsReady), or, for a token marked
 * hiddenUntilReady, leaves it off the screen until then. Read on 2026-11-23:
 * USDC, USDT and ZEC are set up on mainnet, Circle's USDC on devnet. Another
 * token: scripts/solana-rings-setup-asset.mts.
 */
export const RINGS_ASSETS: Record<RingsNetwork, readonly RingsAsset[]> = {
  mainnet: [
    SOL,
    { id: "usdc", symbol: "USDC", name: "USD Coin", mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", decimals: 6, stable: true },
    { id: "usdt", symbol: "USDT", name: "Tether USD", mint: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", decimals: 6, stable: true },
    ZEC,
  ],
  devnet: [
    SOL,
    // Circle's devnet USDC (faucet.circle.com)
    { id: "usdc", symbol: "USDC", name: "USD Coin", mint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", decimals: 6, stable: true },
  ],
};

/** Every listed asset, set up or not: for reading balances, lookups and the relay's rules. Screens list shownAssets. */
export function ringsAssets(network: RingsNetwork = SOLANA_RINGS_NETWORK): readonly RingsAsset[] {
  return RINGS_ASSETS[network];
}

/**
 * The listed assets a screen shows, given what client assetsReady read: all of
 * them, but one marked hiddenUntilReady only once it is read as set up, or
 * when `held` (a balance by asset id) has some of it. Before the read comes
 * back (`ready` empty) such a token stays off the screen.
 */
export function shownAssets(
  ready: Readonly<Record<string, boolean>>,
  network: RingsNetwork = SOLANA_RINGS_NETWORK,
  held?: Readonly<Record<string, bigint>> | null
): readonly RingsAsset[] {
  return ringsAssets(network).filter((a) => !a.hiddenUntilReady || ready[a.id] === true || (held?.[a.id] ?? 0n) > 0n);
}

/** The coin prices a Solana asset's dollar value needs (lib/live-quotes, through /api/markets). */
export type RingsPrices = { solUsd: number | null; zecUsd: number | null };

/**
 * The dollar value of `amount` (base units) of `asset`: a stablecoin at a
 * dollar, SOL and ZEC at their market price (bridged ZEC at Zcash's); null
 * when the price is unknown or the asset has none.
 */
export function ringsUsd(asset: Pick<RingsAsset, "id" | "decimals" | "stable">, amount: bigint, prices: RingsPrices): number | null {
  const units = Number(amount) / 10 ** asset.decimals;
  if (asset.stable) return units;
  const price = asset.id === "sol" ? prices.solUsd : asset.id === "zec" ? prices.zecUsd : null;
  return price != null && Number.isFinite(price) && price > 0 ? units * price : null;
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
