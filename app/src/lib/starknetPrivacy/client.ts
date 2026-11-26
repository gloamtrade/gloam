/**
 * The SDK wired for one Gloam private account on Starknet.
 *
 * Proving runs on the service the config names; discovery reads the pool
 * directly (ContractDiscoveryProvider, devnet and Sepolia) or the hosted
 * discovery service (mainnet). The viewing key stays in this process: the
 * contract reader never sends it anywhere, the indexer gets it over OHTTP.
 *
 * Nothing here sends a transaction. execute() gives a call and its proof
 * (lib/starknetPrivacy/actions), and Gloam's relay sends it
 * (lib/starknetPrivacy/relayPolicy says what it will send).
 */
import {
  createPrivateTransfers,
  IndexerDiscoveryProvider,
  ProvingServiceProofProvider,
  type DiscoveryProviderInterface,
  type PrivateTransfersInterface,
  type ProofProviderInterface,
} from "@starkware-libs/starknet-privacy-sdk";
import { PrivacyPoolABI } from "@starkware-libs/starknet-privacy-sdk/abi";
import { ContractDiscoveryProvider } from "@starkware-libs/starknet-privacy-sdk/contract-discovery";
import { Contract, RpcProvider, Signer, num, type constants, type SignerInterface } from "starknet";
import type { StarknetAccountKeys } from "./account";
import type { StarknetNetworkConfig } from "./config";

/** A node for this network (in the browser, pass Gloam's proxy URL; scripts pass the node itself). */
export function starknetProvider(nodeUrl: string): RpcProvider {
  return new RpcProvider({ nodeUrl, batch: 0 });
}

/** The pool contract, typed against the SDK's ABI. */
export function poolContract(provider: RpcProvider, pool: string) {
  return new Contract({ abi: PrivacyPoolABI, address: pool, providerOrAccount: provider }).typedv2(PrivacyPoolABI);
}

/**
 * Where this network's notes and channels are read from. `serviceUrl` replaces
 * the hosted discovery service's own URL: the page passes Gloam's relay
 * (STARKNET_PROXY_PATHS.discovery), so requests sealed to the service pass
 * through Gloam and the service never sees who asked.
 */
export function discoveryFor(cfg: StarknetNetworkConfig, provider: RpcProvider, serviceUrl?: string): DiscoveryProviderInterface {
  if (!cfg.pool) throw new Error(`No Starknet privacy pool is set for ${cfg.network}.`);
  if (cfg.discovery.kind === "indexer") {
    return new IndexerDiscoveryProvider(serviceUrl ?? cfg.discovery.url, cfg.pool, { ohttp: true });
  }
  return new ContractDiscoveryProvider(poolContract(provider, cfg.pool) as never);
}

/** The SDK-protocol prover this network names, or null (Sepolia and devnet have none yet). */
export function proverFor(cfg: StarknetNetworkConfig, proverUrl = cfg.proverUrl): ProofProviderInterface | null {
  if (!proverUrl || !cfg.pool) return null;
  return new ProvingServiceProofProvider(proverUrl, cfg.chainId as constants.StarknetChainId, {
    nodeUrl: cfg.rpcUrl,
    poolAddress: cfg.pool,
  });
}

/** The signer for the account's own key (it signs each proof invocation, never a transaction the relay sends). */
export function accountSigner(keys: Pick<StarknetAccountKeys, "accountKey">): SignerInterface {
  return new Signer(num.toHex(keys.accountKey));
}

/**
 * The SDK for one private account. `prover` is injected: the network's
 * (proverFor) in the app, a mock on devnet (scripts/e2e-starknet-devnet).
 */
export function gloamTransfers(input: {
  cfg: StarknetNetworkConfig;
  keys: Pick<StarknetAccountKeys, "accountKey" | "viewingKey" | "address">;
  prover: ProofProviderInterface;
  discovery: DiscoveryProviderInterface;
  signer?: SignerInterface;
}): PrivateTransfersInterface {
  const { cfg, keys } = input;
  if (!cfg.pool) throw new Error(`No Starknet privacy pool is set for ${cfg.network}.`);
  const viewingKey = keys.viewingKey;
  return createPrivateTransfers({
    account: { address: keys.address, signer: input.signer ?? accountSigner(keys) },
    viewingKeyProvider: { getViewingKey: async () => viewingKey },
    provingProvider: input.prover,
    discoveryProvider: input.discovery,
    poolContractAddress: cfg.pool,
  });
}
