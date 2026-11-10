import type { NetworkKey } from "./networks";

/** Official Robinhood Chain testnet faucet */
export const FAUCET_URL = "https://faucet.testnet.chain.robinhood.com/";

export const FAUCET_BLURB =
  "Get testnet ETH and sample stock tokens. Claim once every 24 hours.";

export interface FaucetInfo {
  /** Card heading, names the asset you get. */
  title: string;
  /** One-line how-to. */
  blurb: string;
  /** Where the "open faucet" action points. */
  url: string;
  /** Link label. */
  cta: string;
  /** Sample assets the faucet hands out. */
  assets: string;
}

/** Test funds exist on the testnets only; a mainnet has no faucet. */
const FAUCETS: Partial<Record<NetworkKey, FaucetInfo>> = {
  robinhood: {
    title: "Testnet ETH",
    blurb: FAUCET_BLURB,
    url: FAUCET_URL,
    cta: "Open faucet →",
    assets: "TSLA · AMZN · PLTR · NFLX · AMD",
  },
  tempo: {
    title: "Free test stablecoins",
    blurb:
      "Fund your address with test stablecoins (PathUSD and friends) from the Tempo faucet. Gas is paid in stablecoins here, no separate gas token.",
    url: "/docs/testnet",
    cta: "Faucet guide →",
    assets: "OUSD · PathUSD · AlphaUSD · BetaUSD · ThetaUSD",
  },
  base: {
    title: "Free test USDC, EURC and ETH",
    blurb:
      "Test USDC and EURC from Circle's faucet (pick Base Sepolia), and test ETH for gas from a Base Sepolia faucet.",
    url: "/docs/testnet#base",
    cta: "Faucet guide →",
    assets: "USDC · EURC · ETH",
  },
  ethereum: {
    title: "Free test USDC, USDG, PYUSD, EURC and ETH",
    blurb:
      "Test USDC and EURC from Circle's faucet and test PYUSD and USDG from Paxos's (pick Ethereum Sepolia), and Sepolia ETH for gas from a Sepolia faucet.",
    url: "/docs/testnet#ethereum",
    cta: "Faucet guide →",
    assets: "USDC · USDG · PYUSD · EURC · ETH",
  },
};

export function faucetFor(key: NetworkKey): FaucetInfo | null {
  return FAUCETS[key] ?? null;
}
