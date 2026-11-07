"use client";

import { http, createConfig, createStorage, cookieStorage } from "wagmi";
import { injected } from "wagmi/connectors";
import { robinhood, robinhoodTestnet } from "./chain";
import { NETWORK_KEYS, baseMainnet, baseTestnet, elysiumMainnet, ethereumMainnet, ethereumTestnet, getNetwork, tempoMainnet, tempoTestnet } from "./networks";
import { BLOCK_POLL_MS, readTransport } from "./readTransport";
import { ORIGIN_CHAINS } from "./originChains";
import { turnkeyConnector } from "./turnkeyConnector";
import { tempoFeeAware } from "./feeSponsor";
import { tempoWalletConnector } from "./tempoWallet";
import { lazyWalletConnect } from "./walletConnect";
import { rpcListTransport } from "./rpcList";

const walletConnectFn = lazyWalletConnect();

/**
 * Both older testnets Gloam targets are registered so the app can switch
 * between them at runtime. A mainnet is registered only once its pool is
 * filled in (MAINNET_POOLS in lib/mainnet.ts), and Base Sepolia and Ethereum
 * Sepolia once BASE_SEPOLIA_POOL and ETHEREUM_SEPOLIA_POOL are, after the
 * first two testnets so the first chain a connector starts on stays Robinhood
 * Chain testnet.
 *
 * Connectors:
 * - injected: browser wallets on every network. On Tempo (testnet and mainnet)
 *   it sets a fee token first when the account has none and no pathUSD
 *   (lib/feeSponsor.ts).
 * - Gloam wallet (Turnkey, email or passkey): every chain here, behind
 *   NEXT_PUBLIC_TURNKEY_ENABLED (lib/embeddedWallet). On Tempo it sets a fee
 *   token first like a browser wallet; elsewhere lib/embeddedGas picks who pays gas.
 * - Tempo Wallet: passkey sign-in on Tempo testnet, fees sponsored (lib/tempoWallet.ts).
 * - WalletConnect: a wallet app on a phone (or scanned from desktop) when the
 *   browser has no wallet, behind NEXT_PUBLIC_WC_PROJECT_ID (lib/walletConnect.ts).
 */
const mainnetChains = [
  ...(NETWORK_KEYS.includes("robinhood-mainnet") ? [robinhood] : []),
  ...(NETWORK_KEYS.includes("tempo-mainnet") ? [tempoMainnet] : []),
  ...(NETWORK_KEYS.includes("base-mainnet") ? [baseMainnet] : []),
  ...(NETWORK_KEYS.includes("ethereum-mainnet") ? [ethereumMainnet] : []),
  // Behind NEXT_PUBLIC_ELYSIUM_ENABLED and its values (lib/elysium.ts): only then is it a network.
  ...(NETWORK_KEYS.includes("elysium-mainnet") ? [elysiumMainnet] : []),
];
const baseTestnetChains = NETWORK_KEYS.includes("base") ? [baseTestnet] : [];
const ethereumTestnetChains = NETWORK_KEYS.includes("ethereum") ? [ethereumTestnet] : [];

// The chains a wallet can pay a private bridge order from (lib/originChains),
// only alongside a mainnet: the wallet switches to one to sign there. Base and
// Ethereum are among them, so once either is a Gloam network it is registered
// once, as that network (its RPC answers the vault's log reads).
const originChains = mainnetChains.length
  ? ORIGIN_CHAINS.filter((c) => !mainnetChains.some((m) => m.id === c.id))
  : [];

// wagmi narrows hook `chainId` options to the registered ids. The type names
// all nine (GloamChainId); at runtime only the testnets and mainnets with a pool
// are there, plus the bridge's origin chains.
const chains = [
  robinhoodTestnet,
  tempoTestnet,
  ...baseTestnetChains,
  ...ethereumTestnetChains,
  ...mainnetChains,
  ...originChains,
] as unknown as readonly [
  typeof robinhoodTestnet,
  typeof tempoTestnet,
  typeof baseTestnet,
  typeof ethereumTestnet,
  typeof robinhood,
  typeof tempoMainnet,
  typeof baseMainnet,
  typeof ethereumMainnet,
  typeof elysiumMainnet,
];

// Ethereum's 12 s blocks: receipt waits look for a new one every 2 s. Keyed by
// chain id, and only for chains registered here: wagmi hands a map with none of
// a client's chain ids to that client whole. Other chains keep viem's default.
const pollingInterval: { [id: number]: number } = Object.fromEntries(
  chains.flatMap((c) => (BLOCK_POLL_MS[c.id] ? [[c.id, BLOCK_POLL_MS[c.id]!]] : []))
);

export const wagmiConfig = createConfig({
  chains,
  connectors: [
    tempoFeeAware(injected({ shimDisconnect: true })),
    tempoFeeAware(turnkeyConnector()),
    tempoWalletConnector(),
    ...(walletConnectFn ? [tempoFeeAware(walletConnectFn)] : []),
  ],
  // Each chain's public RPCs in order (lib/rpcList): one that is down is passed
  // over for a while instead of failing every read.
  transports: {
    // Robinhood Chain's public RPC answers JSON-RPC batches: the reads after a wallet
    // connects (balances, allowances, vault state) go out together instead of one by one.
    [robinhoodTestnet.id]: rpcListTransport(robinhoodTestnet.rpcUrls.default.http, { batch: { wait: 16 } }),
    [tempoTestnet.id]: rpcListTransport(tempoTestnet.rpcUrls.default.http),
    [robinhood.id]: rpcListTransport(robinhood.rpcUrls.default.http, { batch: { wait: 16 } }),
    [tempoMainnet.id]: rpcListTransport(tempoMainnet.rpcUrls.default.http),
    [baseTestnet.id]: rpcListTransport(baseTestnet.rpcUrls.default.http, { batch: { wait: 16 }, retryCount: 2 }),
    [baseMainnet.id]: rpcListTransport(baseMainnet.rpcUrls.default.http, { batch: { wait: 16 }, retryCount: 2 }),
    // Until Ethereum is a Gloam network, the origin-chain entry below replaces this one.
    [ethereumMainnet.id]: rpcListTransport(ethereumMainnet.rpcUrls.default.http, { batch: { wait: 16 }, retryCount: 2 }),
    // Ethereum Sepolia: the list for the head, old logs and state from its history RPC (lib/readTransport)
    [ethereumTestnet.id]: readTransport(getNetwork("ethereum"), { batch: { wait: 16 }, retryCount: 2 }),
    // Elysium, once it is a network: its one RPC from lib/elysium.ts.
    ...(NETWORK_KEYS.includes("elysium-mainnet") ? { [elysiumMainnet.id]: rpcListTransport(elysiumMainnet.rpcUrls.default.http, { batch: { wait: 16 }, retryCount: 2 }) } : {}),
    ...Object.fromEntries(originChains.map((c) => [c.id, http()])),
  },
  ...(Object.keys(pollingInterval).length ? { pollingInterval } : {}),
  ssr: true,
  storage: createStorage({
    storage: cookieStorage,
  }),
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
