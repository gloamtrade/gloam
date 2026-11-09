import { isElysiumFamilyChainId } from "./elysium";

/** Elysium's mark (its official avatar, circle-cropped). One file serves light and dark. */
export const ELYSIUM_LOGO = "/brand/chains/elysium.png";

/**
 * A chain's logo by chain id: /brand/chains/<id>.png, or <id>-dark.png for the
 * dark theme. Elysium's id is not a literal (lib/elysium.ts), so its mark has
 * its own file, the same in both themes (mainnet and testnet), while it is on.
 */
export function chainLogoSrc(chainId: number, dark = false): string {
  if (isElysiumFamilyChainId(chainId)) return ELYSIUM_LOGO;
  return `/brand/chains/${chainId}${dark ? "-dark" : ""}.png`;
}
