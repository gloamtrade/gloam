import { isElysiumFamilyChainId } from "./elysium";

/** Elysium's mark (its official avatar, circle-cropped). One file serves light and dark. */
export const ELYSIUM_LOGO = "/brand/chains/elysium.png";

/**
 * A chain's logo by chain id: /brand/chains/<id>.png, or <id>-dark.png for the
 * dark theme. Elysium's id is not a literal (lib/elysium.ts), so its mark has
 * its own file, the same in both themes (mainnet and testnet), while it is on.
 */
/**
 * Testnets have no logo file of their own: each shows its mainnet's mark
 * (Robinhood Chain, Tempo, Base and Ethereum testnets).
 */
const TESTNET_MARK: Record<number, number> = { 46630: 4663, 42431: 4217, 84532: 8453, 11155111: 1 };

export function chainLogoSrc(chainId: number, dark = false): string {
  if (isElysiumFamilyChainId(chainId)) return ELYSIUM_LOGO;
  const id = TESTNET_MARK[chainId] ?? chainId;
  return `/brand/chains/${id}${dark ? "-dark" : ""}.png`;
}
