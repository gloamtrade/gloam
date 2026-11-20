/**
 * Whether the "fund a fresh wallet for Borro" flow is shown: /app/fresh-wallet,
 * its guide /docs/fresh-wallet, the Vault nav row, the docs nav and search
 * entry, and the sitemap line. Off unless NEXT_PUBLIC_FRESH_WALLET_ENABLED is
 * exactly "1".
 *
 * Off only takes the flow out of view: both pages answer 404, and nothing links
 * to them. lib/freshWallet, the view and the relay's gas-station code stay in
 * place (the relay part has its own switch, GLOAM_RELAY_GAS_STATION), so setting
 * the variable to "1" and rebuilding brings the whole flow back as it was.
 *
 * No imports, so the docs nav and the sitemap can read it cheaply.
 */
export function freshWalletEnabledFrom(raw: string | undefined): boolean {
  return (raw ?? "").trim() === "1";
}

export const FRESH_WALLET_ENABLED: boolean = freshWalletEnabledFrom(process.env.NEXT_PUBLIC_FRESH_WALLET_ENABLED);
