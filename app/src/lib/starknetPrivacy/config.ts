/**
 * Gloam on Starknet, through the Starknet privacy pool (STRK20,
 * starkware-libs/starknet-privacy). Shared by the browser and the server.
 *
 * What it hides, said plainly wherever it shows:
 *  - a payment over a channel that is already open: who paid, who was paid
 *    and how much. The first payment to someone opens a channel to them, and
 *    that shows their private account's address (never who paid or how much).
 *  - adding money shows the private account it went into and the amount.
 *  - a cash out shows where the money went and how much, never which private
 *    account it came from (the account's own channel is opened when it
 *    registers, so its first cash out does not name it either).
 * The pool has an auditor key: what a person registers is sealed to it, so the
 * key's holder can read that person's private activity. The proving service
 * runs each transaction to prove it, so it sees it too. Starknet screens
 * deposits. On mainnet, Starknet's hosted discovery service finds an
 * account's notes with its viewing key, so it can read them too; the request
 * is sealed to that service (OHTTP) and passes through Gloam, so Gloam can't
 * read it and the service doesn't see who asked.
 *
 * Gloam's account layer (lib/starknetPrivacy/account) keeps people's main
 * wallets out of the pool: each person gets a Starknet account derived from
 * their Gloam key, which never holds STRK. Gloam's relay sends every pool
 * transaction (lib/starknetPrivacy/relayPolicy).
 *
 * Off unless NEXT_PUBLIC_STARKNET_ENABLED is "1".
 */

export type StarknetNetwork = "devnet" | "sepolia" | "mainnet";

export const STARKNET_ENABLED = process.env.NEXT_PUBLIC_STARKNET_ENABLED === "1";

function readNetwork(v: string | undefined): StarknetNetwork {
  return v === "sepolia" || v === "devnet" ? v : "mainnet";
}

/**
 * Mainnet unless set: Starknet's canonical pool, hosted discovery and
 * Starkscan's prover are mainnet only. Sepolia stays for later (no prover or
 * pool for it yet); devnet is for local tests.
 */
export const STARKNET_NETWORK: StarknetNetwork = readNetwork(process.env.NEXT_PUBLIC_STARKNET_NETWORK);

/** Gloam's proxy paths (later stages). The node and prover URLs never reach the browser directly. */
export const STARKNET_PROXY_PATHS = {
  rpc: "/api/starknet/rpc",
  prove: "/api/starknet/prove",
  relay: "/api/starknet/relay",
  /** The hosted discovery service (mainnet), relayed for OHTTP: requests sealed to the service pass through. */
  discovery: "/api/starknet/discovery",
} as const;

/**
 * Starknet's canonical privacy pool on mainnet, read 2026-11-26: Starkscan names
 * it "Starknet: Canonical Privacy Pool", and starkware-libs/starknet-privacy's
 * own SDK tests cite a mainnet transaction into it
 * (0x56a224012f76e8451b9d22e7b6812801ec07fcef8ef74b871e3c9f735a215ba). On chain:
 * version 2.1, the same functions and the same apply_actions (with the
 * screening attestation) as PRIVACY-0.14.4-RC.2, auditor and screener keys set,
 * not paused, holding USDC, a pool fee of 4.5 STRK per apply_actions taken
 * from its caller, upgrade delay 0 (its owner can change its code at once).
 */
export const STARKNET_MAINNET_POOL = "0x040337b1af3c663e86e333bab5a4b28da8d4652a15a69beee2b677776ffe812a";
/**
 * Its class hash on 2026-11-26. A local build of PRIVACY-0.14.4-RC.2 hashes to
 * 0x35cb88d951b56f4a26c78039df80b4d6436b3f89406c3d458df5c3eb83239db (another
 * compiler), with the same functions. The relay sends to the pool only while
 * its class is this one: an upgrade pauses Starknet until Gloam checks it.
 */
export const STARKNET_MAINNET_POOL_CLASS_HASH = "0x06d163f2b27df0f53c5b0d019366261ba8034af1bef949dee920a60fe58bcf83";

/** Chain ids as felts (the short strings SN_MAIN, SN_SEPOLIA, SN_DEVNET). */
export const STARKNET_CHAIN_IDS: Record<StarknetNetwork, string> = {
  mainnet: "0x534e5f4d41494e",
  sepolia: "0x534e5f5345504f4c4941",
  devnet: "0x534e5f4445564e4554",
};

/**
 * The account class every Gloam Starknet account is deployed from:
 * OpenZeppelin's upgradeable account, constructor [public_key]. Read declared
 * on mainnet, Sepolia and starknet-devnet 0.10.1 (its predeployed accounts use
 * it) on 2026-11-25. Part of every account's address: never change it.
 */
export const STARKNET_ACCOUNT_CLASS_HASH = "0x05b4b537eaa2399e3aa99c4e2e0208ebd6c71bc1467938cd52c798c601e43564";

/** The Universal Deployer Contract (v2, entrypoint deploy_contract), same address on every network (read 2026-11-25). */
export const STARKNET_UDC = "0x02ceed65a4bd731034c01113685c831b01c15d7d432f71afb1cf1634b53a2125";
export const STARKNET_UDC_ENTRYPOINT = "deploy_contract";

/** STRK, the fee token (the pool hardcodes it; the same address on every network). */
export const STARKNET_STRK = "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";

export type StarknetToken = {
  symbol: string;
  name: string;
  address: string;
  decimals: number;
};

export type StarknetDiscovery = { kind: "contract" } | { kind: "indexer"; url: string };

export type StarknetNetworkConfig = {
  network: StarknetNetwork;
  chainId: string;
  /** Upstream node (server side; the browser goes through STARKNET_PROXY_PATHS.rpc). */
  rpcUrl: string;
  /** The privacy pool. Null until known: never guessed. */
  pool: string | null;
  /** The pool's class the relay checks before it sends (null: not pinned, a pool set by hand). */
  poolClassHash: string | null;
  accountClassHash: string;
  udc: string;
  tokens: StarknetToken[];
  discovery: StarknetDiscovery;
  /** A proving service that speaks the SDK's protocol (ProvingServiceProofProvider). Null when none. */
  proverUrl: string | null;
  /**
   * Starkscan's prover relay. Mainnet only ("There is no Sepolia prover"), its own
   * job API (POST then poll), prove scope issued by Starkscan after approval. Not
   * the SDK's protocol: needs an adapter (later stage).
   */
  starkscanProveUrl: string | null;
};

type Env = Record<string, string | undefined>;

/**
 * What starknetConfig reads, each named in full: Next puts a NEXT_PUBLIC_ value
 * into the browser's code only where it is written out as
 * process.env.NEXT_PUBLIC_..., never through process.env as a whole (which is
 * empty there). Read at each call, so a server sees the environment as it is.
 * STARKNET_PROVER_URL is server-only: undefined in a browser.
 */
export function starknetEnv(): Env {
  return {
    NEXT_PUBLIC_STARKNET_POOL: process.env.NEXT_PUBLIC_STARKNET_POOL,
    NEXT_PUBLIC_STARKNET_USDC: process.env.NEXT_PUBLIC_STARKNET_USDC,
    NEXT_PUBLIC_STARKNET_DEVNET_RPC: process.env.NEXT_PUBLIC_STARKNET_DEVNET_RPC,
    STARKNET_PROVER_URL: process.env.STARKNET_PROVER_URL,
  };
}

const hexAddress = (v: string | undefined): string | null => {
  const s = (v ?? "").trim();
  return /^0x[0-9a-fA-F]{1,64}$/.test(s) ? s.toLowerCase() : null;
};

const httpUrl = (v: string | undefined): string | null => {
  const s = (v ?? "").trim();
  return /^https?:\/\/[^\s]+$/.test(s) ? s.replace(/\/+$/, "") : null;
};

/**
 * Everything one network needs. Addresses read on chain are written here;
 * anything not yet known (every pool, Sepolia's USDC for the pool, a Sepolia
 * prover) comes from the environment or stays null.
 *
 *  - NEXT_PUBLIC_STARKNET_POOL: the privacy pool on the chosen network
 *    (mainnet: STARKNET_MAINNET_POOL unless set).
 *  - NEXT_PUBLIC_STARKNET_USDC: USDC on Sepolia (two USDC tokens answer there;
 *    the one the pool lists is the one to use).
 *  - NEXT_PUBLIC_STARKNET_DEVNET_RPC: a local starknet-devnet (default 127.0.0.1:5050).
 *  - STARKNET_PROVER_URL: a proving service for the SDK's protocol (server side).
 */
export function starknetConfig(network: StarknetNetwork = STARKNET_NETWORK, env: Env = starknetEnv()): StarknetNetworkConfig {
  const set = hexAddress(env.NEXT_PUBLIC_STARKNET_POOL);
  // Mainnet's canonical pool unless another is set; a pool set by hand isn't pinned to a class.
  const canonical = network === "mainnet" && (!set || sameStarknetAddress(set, STARKNET_MAINNET_POOL));
  const pool = canonical ? STARKNET_MAINNET_POOL : set;
  const poolClassHash = canonical ? STARKNET_MAINNET_POOL_CLASS_HASH : null;
  const proverUrl = httpUrl(env.STARKNET_PROVER_URL);
  const base = { network, chainId: STARKNET_CHAIN_IDS[network], pool, poolClassHash, accountClassHash: STARKNET_ACCOUNT_CLASS_HASH, udc: STARKNET_UDC, proverUrl };
  if (network === "mainnet") {
    return {
      ...base,
      rpcUrl: "https://mainnet.nodes.starknet.org/rpc/v0_10",
      // Circle's USDC on Starknet: symbol USDC, 6 decimals (read 2026-11-25).
      tokens: [{ symbol: "USDC", name: "USD Coin", address: "0x033068f6539f8e6e6b131e6b2b814e6c34a5224bc66947c47dab9dfee93b35fb", decimals: 6 }],
      discovery: { kind: "indexer", url: "https://discovery.nodes.starknet.org" },
      starkscanProveUrl: "https://api.starkscan.co/v1/SN_MAIN/prove",
    };
  }
  if (network === "sepolia") {
    const usdc = hexAddress(env.NEXT_PUBLIC_STARKNET_USDC);
    return {
      ...base,
      rpcUrl: "https://sepolia.nodes.starknet.org/rpc/v0_10",
      tokens: usdc ? [{ symbol: "USDC", name: "USD Coin", address: usdc, decimals: 6 }] : [],
      // The hosted discovery service is mainnet only: read the pool over RPC.
      discovery: { kind: "contract" },
      starkscanProveUrl: null,
    };
  }
  return {
    ...base,
    rpcUrl: httpUrl(env.NEXT_PUBLIC_STARKNET_DEVNET_RPC) ?? "http://127.0.0.1:5050",
    // devnet has no USDC: its predeployed ETH stands in (18 decimals).
    tokens: [{ symbol: "TEST", name: "Devnet test token (ETH)", address: "0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7", decimals: 18 }],
    discovery: { kind: "contract" },
    starkscanProveUrl: null,
  };
}

/** Same address, any case or zero padding. */
export function sameStarknetAddress(a: string | bigint, b: string | bigint): boolean {
  try {
    return BigInt(a) === BigInt(b);
  } catch {
    return false;
  }
}

/** The listed token at `address` on this network, or null. */
export function listedToken(cfg: Pick<StarknetNetworkConfig, "tokens">, address: string | bigint): StarknetToken | null {
  return cfg.tokens.find((t) => sameStarknetAddress(t.address, address)) ?? null;
}
