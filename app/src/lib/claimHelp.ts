/**
 * What the /claim page says under Claim it: how the next screen lets this
 * person in. Plain logic with no React and no wallet code, so the claim page
 * keeps its strict CSP (no wallet connectors, no Turnkey) and
 * scripts/selftest-email-claim.mts runs every case.
 *
 * With Gloam wallets on (lib/embeddedWallet), the app offers email sign-in on
 * every network it runs, with a browser wallet next to it. A new email wallet
 * holds no gas and needs none: the Gloam relay pays to secure a claim
 * (lib/claimSweep). With Gloam wallets off in a build, only a wallet gets in,
 * and the line says so.
 */
import { EMBEDDED_WALLETS } from "./embeddedWallet";
import { isNetworkKey } from "./networks";

/** Email sign-in for a claim on this network: Gloam wallets are on, and the Gloam wallet signs on every Gloam network. */
export function emailClaimOn(networkKey: string, walletsOn: boolean = EMBEDDED_WALLETS): boolean {
  return walletsOn && isNetworkKey(networkKey);
}

export type ClaimSignInInput = {
  /** emailClaimOn for the link's network. */
  email: boolean;
  networkKey: string;
  networkLabel: string;
  /** Opened inside a wallet app's own browser. */
  walletBrowser: boolean;
  /** A wallet app on a phone can connect (NEXT_PUBLIC_WC_PROJECT_ID). */
  walletConnect: boolean;
};

/** The line under Claim it. */
export function claimSignInLine(i: ClaimSignInInput): string {
  if (i.email) {
    return i.walletBrowser
      ? "On the next screen, sign in with your email or use this wallet."
      : "On the next screen, sign in with your email or connect a wallet.";
  }
  // Tempo testnet's passkey account, offered while Gloam wallets are off (WalletMenu)
  if (i.networkKey === "tempo") return "No wallet needed: sign in with a passkey on the next screen.";
  if (i.walletBrowser) return "Connect your wallet on the next screen.";
  if (i.walletConnect) return "Email sign-in isn't available here yet. Connect a wallet on the next screen.";
  return `Email sign-in isn't available here yet. You'll need a wallet app such as MetaMask or Rabby to claim on ${i.networkLabel}.`;
}

/** The "On a phone? Open this link in your wallet app's browser" card: only when nothing else on a phone gets in. */
export function claimNeedsWalletApp(i: ClaimSignInInput): boolean {
  return !i.email && i.networkKey !== "tempo" && !i.walletBrowser && !i.walletConnect;
}
