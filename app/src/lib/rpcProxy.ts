/**
 * gloam.trade's own JSON-RPC proxy (app/api/rpc/[chainId]): the browser's last
 * resort for reads on a mainnet that has one public RPC.
 *
 * On Robinhood Chain, Tempo and Elysium the browser reads balances and wallet
 * history from one public RPC host. When that host is blocked on someone's
 * network, or refuses their IP, every read failed and the app showed an empty
 * wallet. The browser's read transports (lib/wagmi, the wallet history in
 * lib/walletActivity) now list this proxy after the public RPC: it is asked
 * only when the public RPC fails (lib/rpcList rests a node that fails), and
 * the server passes the read on to its own RPC for the chain (lib/serverRpc).
 *
 * The proxy is never in a chain's rpcUrls: wallets read those for
 * wallet_addEthereumChain. It takes only the read methods below, never a send,
 * and the list never asks it for anything else.
 */
import { NETWORK_KEYS, getNetwork, type NetworkKey } from "./networks";

export const RPC_PROXY_PATH = "/api/rpc";

/** The mainnets whose browser reads have one public RPC behind them. */
const PROXIED_KEYS: readonly NetworkKey[] = ["robinhood-mainnet", "tempo-mainnet", "elysium-mainnet"];

/** Chain ids the proxy serves: the mainnets above that are live in this build. */
export function rpcProxyChainIds(): number[] {
  return PROXIED_KEYS.filter((k) => NETWORK_KEYS.includes(k)).map((k) => getNetwork(k).chainId);
}

/** The read calls the proxy passes on. Nothing that sends, signs or opens a filter. */
export const RPC_PROXY_METHODS: ReadonlySet<string> = new Set([
  "eth_chainId",
  "eth_blockNumber",
  "eth_call",
  "eth_getBalance",
  "eth_getLogs",
  "eth_getCode",
  "eth_getTransactionReceipt",
  "eth_getTransactionByHash",
  "eth_getBlockByNumber",
  "eth_getTransactionCount",
  "eth_estimateGas",
  "eth_gasPrice",
  "eth_maxPriorityFeePerGas",
  "eth_feeHistory",
]);

/** Calls in one JSON-RPC batch. The browser's transport splits bigger batches. */
export const RPC_PROXY_MAX_BATCH = 20;

/** Bytes in one request body. A batch of reads with a proof's calldata fits well inside. */
export const RPC_PROXY_MAX_BODY = 64 * 1024;

/**
 * The proxy's absolute URL for a chain, built from the page's own origin, or
 * null on the server (SSR, API routes, the relay), in a worker, and for a chain
 * it does not serve. Never relative: viem's http transport wants a full URL.
 */
export function rpcProxyUrl(chainId: number): string | null {
  if (typeof window === "undefined") return null;
  const origin = window.location?.origin;
  if (!origin || !/^https?:\/\//.test(origin)) return null;
  if (!rpcProxyChainIds().includes(chainId)) return null;
  return `${origin}${RPC_PROXY_PATH}/${chainId}`;
}
