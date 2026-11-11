/**
 * What the /claim page says under Claim it: how the next screen lets this
 * person in. Plain logic with no React and no wallet code, so the claim page
 * keeps its strict CSP (no wallet connectors, no Turnkey) and
 * scripts/selftest-email-claim.mts runs every case.
 *
 * With Gloam wallets on (lib/embeddedWallet), the app offers email sign-in on
 * every network it runs, with a browser wallet next to it. A new email wallet
 * holds no gas, so email first is offered only while the claim is free: the
 * Gloam relay is up on the link's network and this browser hasn't turned it off
 * (lib/relay/client relayPreferred). Then the relay pays to secure the claim
 * (lib/claimSweep). Otherwise the claim needs a wallet that can pay the network
 * fee, and the line says so as it did before. With Gloam wallets off in a
 * build, only a wallet gets in, and the line says that too.
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
  /** The Gloam relay is up on the link's network and this browser leaves it on, so claiming needs no gas. */
  relayUp: boolean;
  networkKey: string;
  networkLabel: string;
  /** Opened inside a wallet app's own browser. */
  walletBrowser: boolean;
  /** A wallet app on a phone can connect (NEXT_PUBLIC_WC_PROJECT_ID). */
  walletConnect: boolean;
};

/** Email first: a new email wallet can claim here, because the relay pays. */
function emailFirst(i: ClaimSignInInput): boolean {
  return i.email && i.relayUp;
}

/** The line under Claim it. */
export function claimSignInLine(i: ClaimSignInInput): string {
  if (emailFirst(i)) {
    return i.walletBrowser
      ? "On the next screen, sign in with your email or use this wallet."
      : "On the next screen, sign in with your email or connect a wallet.";
  }
  // Tempo testnet's passkey account, offered while Gloam wallets are off (WalletMenu)
  if (!i.email && i.networkKey === "tempo") return "No wallet needed: sign in with a passkey on the next screen.";
  if (i.walletBrowser) return "Connect your wallet on the next screen.";
  // With the relay off a wallet pays the fee, so the wallet lines stand as they were.
  const off = i.email ? "" : "Email sign-in isn't available here yet. ";
  if (i.walletConnect) return `${off}Connect a wallet on the next screen.`;
  return `${off}You'll need a wallet app such as MetaMask or Rabby to claim on ${i.networkLabel}.`;
}

/** The "On a phone? Open this link in your wallet app's browser" card: only when nothing else on a phone gets in. */
export function claimNeedsWalletApp(i: ClaimSignInInput): boolean {
  if (emailFirst(i)) return false;
  if (!i.email && i.networkKey === "tempo") return false;
  return !i.walletBrowser && !i.walletConnect;
}

/**
 * After a new Gloam wallet is made: go back to the payment waiting in the claim
 * box instead of Add funds. Only while that claim is free (the relay is up and
 * on), and not when Add funds was asked for from the wallet menu.
 */
export function claimFirstAfterWallet(i: { waiting: boolean; relayUp: boolean; fundingAsked: boolean }): boolean {
  return i.waiting && i.relayUp && !i.fundingAsked;
}
