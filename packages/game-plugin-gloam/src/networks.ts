/**
 * The Gloam networks this plugin can use, straight from @gloamtrade/sdk (the
 * one place pool addresses, deploy blocks, key sets and listed assets live),
 * plus an RPC the agent's owner can override.
 *
 * Virtuals agents live on Base and Robinhood Chain, so those are the networks
 * that matter here: Base Sepolia ("base", a testnet on the mainnet pool and
 * final keys), Base mainnet ("base-mainnet", once its pool is in the SDK) and
 * Robinhood Chain mainnet ("robinhood-mainnet"). Tempo and the Robinhood Chain
 * testnet work too, and Ethereum. Elysium mainnet ("elysium-mainnet": USDC
 * only, gas in HYPE) and its testnet ("elysium", 99801) work once the SDK has
 * their values. A network whose pool
 * this SDK version does not have is refused, never guessed.
 */
import { getGloamNetwork, type GloamAsset, type GloamNetwork, type GloamNetworkKey } from "@gloamtrade/sdk";
import type { Address } from "viem";

export type NetworkKey = GloamNetworkKey;

export const NETWORK_KEYS: readonly NetworkKey[] = [
  "base",
  "base-mainnet",
  "robinhood-mainnet",
  "robinhood",
  "tempo-mainnet",
  "tempo",
  "ethereum-mainnet",
  "ethereum",
  "elysium-mainnet",
  "elysium",
];

export interface PluginNetwork extends GloamNetwork {
  /** The RPC this plugin reads and sends through. */
  rpc: string;
}

export function isNetworkKey(v: unknown): v is NetworkKey {
  return typeof v === "string" && (NETWORK_KEYS as readonly string[]).includes(v);
}

/** "Base testnet", "Robinhood Chain mainnet", for messages. */
export function describeNetwork(n: Pick<GloamNetwork, "label" | "testnet">): string {
  return `${n.label} ${n.testnet ? "testnet" : "mainnet"}`;
}

/**
 * A network by key, with its RPC: `rpc` when given, else GLOAM_RPC_URL_<chainId>
 * from the environment, else the SDK's default. Throws a plain reason for a key
 * that is not a Gloam network, or one whose pool is not in this SDK version.
 */
export function resolveNetwork(key: string, opts: { rpc?: string; env?: Record<string, string | undefined> } = {}): PluginNetwork {
  if (!isNetworkKey(key)) {
    throw new Error(`"${key}" is not a Gloam network. Use one of: ${NETWORK_KEYS.join(", ")}.`);
  }
  const net = getGloamNetwork(key);
  if (!net && (key === "elysium-mainnet" || key === "elysium")) {
    const which = key === "elysium" ? "Elysium testnet" : "Elysium mainnet";
    throw new Error(`${which} is not live in this version of @gloamtrade/sdk yet. Update the package once it is, or pick one of: ${NETWORK_KEYS.filter((k) => getGloamNetwork(k)).join(", ")}.`);
  }
  if (!net) {
    throw new Error(
      `${key} has no Gloam pool in this version of @gloamtrade/sdk yet. Update the package, or pick one of: ${NETWORK_KEYS.filter((k) => getGloamNetwork(k)).join(", ")}.`
    );
  }
  const env = opts.env ?? process.env;
  const rpc = opts.rpc?.trim() || env[`GLOAM_RPC_URL_${net.chainId}`]?.trim() || net.rpcUrl;
  return { ...net, rpc };
}

/** An asset the network's vault takes, by symbol or address (either case), or null. */
export function findAsset(net: GloamNetwork, raw: string | undefined | null): GloamAsset | null {
  const v = (raw ?? "").trim().toLowerCase();
  if (!v) return null;
  return net.assets.find((a) => a.symbol.toLowerCase() === v || a.address.toLowerCase() === v) ?? null;
}

/** The asset an agent most likely means when it names none: the first listed (USDC on Base, USDG on Robinhood Chain). */
export function defaultAsset(net: GloamNetwork): GloamAsset {
  return net.assets[0]!;
}

export function assetLabel(net: GloamNetwork, address: Address): string {
  const a = net.assets.find((x) => x.address.toLowerCase() === address.toLowerCase());
  return a ? a.symbol : `${address.slice(0, 6)}…${address.slice(-4)}`;
}
