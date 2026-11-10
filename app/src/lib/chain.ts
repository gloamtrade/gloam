import { defineChain, type Chain } from "viem";

/** Robinhood Chain mainnet */
export const robinhood = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: {
      http: ["https://rpc.mainnet.chain.robinhood.com"],
    },
  },
  // RobinScan, Etherscan's explorer for Robinhood Chain, which people use and
  // ask for. (The explorer.mainnet host the testnet pattern suggests fails its
  // TLS handshake, so links built on it went nowhere; checked 2026-10-22.)
  blockExplorers: {
    default: {
      name: "RobinScan",
      url: "https://robin.etherscan.io",
    },
  },
  // Multicall3 at its usual address, so batched reads go out as one call
  contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
});

/** Robinhood Chain testnet, product default */
export const robinhoodTestnet = defineChain({
  id: 46630,
  name: "Robinhood Chain Testnet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: {
      http: ["https://rpc.testnet.chain.robinhood.com"],
    },
  },
  blockExplorers: {
    default: {
      name: "Robinhood Testnet Explorer",
      url: "https://explorer.testnet.chain.robinhood.com",
    },
  },
  // Multicall3 at its usual address, so batched reads go out as one call
  contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
  testnet: true,
});

export const PRODUCT_CHAIN = robinhoodTestnet;
export const PRODUCT_CHAIN_ID = robinhoodTestnet.id;

export function shortAddress(addr: string, chars = 4) {
  if (!addr || addr.length < 10) return addr;
  return `${addr.slice(0, 2 + chars)}…${addr.slice(-chars)}`;
}

export function formatEth(wei: bigint, digits = 4) {
  const whole = Number(wei) / 1e18;
  if (!Number.isFinite(whole)) return "0";
  if (whole === 0) return "0";
  if (whole < 0.0001) return "<0.0001";
  // Testnet faucets hand out balances that can run to 1e30+; compact
  // them so a wallet card never wraps. Precise below a million, K/M/B suffixes,
  // and a clean "1T+" cap above a trillion (nothing real reaches it).
  if (whole >= 1_000_000) {
    if (whole >= 1e12) return "1T+";
    const units: [number, string][] = [
      [1e9, "B"],
      [1e6, "M"],
    ];
    for (const [d, suffix] of units) {
      if (whole >= d) {
        const v = whole / d;
        return `${v.toLocaleString(undefined, {
          maximumFractionDigits: v < 10 ? 2 : v < 100 ? 1 : 0,
        })}${suffix}`;
      }
    }
  }
  return whole.toLocaleString(undefined, {
    maximumFractionDigits: digits,
    minimumFractionDigits: 0,
  });
}

/** EIP-3085 params for any viem chain, so a wallet can add + switch to it. */
export function walletParamsForChain(chain: Chain) {
  return {
    chainId: `0x${chain.id.toString(16)}`,
    chainName: chain.name,
    nativeCurrency: chain.nativeCurrency,
    rpcUrls: [...chain.rpcUrls.default.http],
    blockExplorerUrls: chain.blockExplorers
      ? [chain.blockExplorers.default.url]
      : [],
  } as const;
}

/**
 * Ask the injected wallet to add + switch to the given chain. Network-agnostic:
 * pass the active network's chain so the "wrong network" fix lands the user on
 * whichever chain they selected (Robinhood or Tempo), not always Robinhood.
 */
export async function ensureWalletOnChain(chain: Chain): Promise<boolean> {
  const eth = (
    globalThis as unknown as {
      ethereum?: {
        request: (args: {
          method: string;
          params?: unknown[];
        }) => Promise<unknown>;
      };
    }
  ).ethereum;
  if (!eth?.request) return false;
  const params = walletParamsForChain(chain);
  try {
    await eth.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: params.chainId }],
    });
    return true;
  } catch (e) {
    const code = (e as { code?: number })?.code;
    // 4902 = chain not added
    if (code === 4902 || code === -32603) {
      try {
        await eth.request({
          method: "wallet_addEthereumChain",
          params: [params],
        });
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }
}

/**
 * Ask the injected wallet to add + switch to Robinhood testnet.
 * Use when the user is connected on the wrong network for writes.
 */
export async function ensureRhTestnetWallet(): Promise<boolean> {
  return ensureWalletOnChain(robinhoodTestnet);
}
