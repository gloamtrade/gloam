import {
  createPublicClient,
  createWalletClient,
  defineChain,
  getAddress,
  http,
  isAddress,
  isAddressEqual,
  keccak256,
  type Account,
  type Address,
  type Chain,
  type Hex,
  type HttpTransport,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { tempo, tempoModerato } from "viem/chains";
import { Account as TempoAccount } from "viem/tempo";
import { splitReadTransport } from "@gloamtrade/sdk";
import { MCP_NETWORKS, type McpNetwork } from "./networks.js";
import { noteBroadcast } from "./walletSend.js";

type Env = Record<string, string | undefined>;

function chainFor(net: McpNetwork) {
  return defineChain({
    id: net.chainId,
    name: net.name,
    nativeCurrency: net.nativeCurrency,
    rpcUrls: { default: { http: [net.rpc] } },
  });
}

/**
 * Tempo's own chain config (Tempo transactions and keychain signatures, which
 * an access key needs), pointed at this network's RPC. GLOAM_TEMPO_FEE_TOKEN
 * picks the token fees are paid in; unset, the protocol's default applies.
 */
function tempoChainFor(net: McpNetwork, env: Env): Chain {
  const base = [tempo, tempoModerato].find((c) => c.id === net.chainId);
  if (!base) throw new Error(`No Tempo chain config for chain ${net.chainId}.`);
  const feeToken = env.GLOAM_TEMPO_FEE_TOKEN?.trim();
  if (feeToken && !isAddress(feeToken, { strict: false })) throw new Error("GLOAM_TEMPO_FEE_TOKEN is not a token address.");
  return {
    ...base,
    name: net.name,
    rpcUrls: { default: { http: [net.rpc] } },
    ...(feeToken ? { feeToken: getAddress(feeToken) } : {}),
  } as unknown as Chain;
}

/** The agent's key from GLOAM_AGENT_PRIVATE_KEY, or null. Throws (without echoing it) when it is not a 32-byte hex key. */
export function agentPrivateKey(env: Env = process.env): Hex | null {
  const raw = env.GLOAM_AGENT_PRIVATE_KEY?.trim();
  if (!raw) return null;
  const key = (raw.startsWith("0x") ? raw : `0x${raw}`) as Hex;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("GLOAM_AGENT_PRIVATE_KEY is not a 32-byte hex private key.");
  return key;
}

/**
 * The Tempo account the agent key acts for, from GLOAM_TEMPO_ACCOUNT, or null
 * when the key signs as itself. Throws on a malformed value, so a typo can never
 * quietly fall back to a different signer.
 */
export function tempoAccessKeyOwner(env: Env = process.env): Address | null {
  const raw = env.GLOAM_TEMPO_ACCOUNT?.trim();
  if (!raw) return null;
  if (!isAddress(raw, { strict: false })) throw new Error("GLOAM_TEMPO_ACCOUNT is not an address.");
  return getAddress(raw);
}

export type SignerMode = "key" | "access-key";

/** What will sign, without building clients. Throws on a malformed key or account. */
export function signerSetup(env: Env = process.env):
  | { mode: "none" }
  | { mode: "key"; keyAddress: Address }
  | { mode: "access-key"; keyAddress: Address; owner: Address } {
  const key = agentPrivateKey(env);
  const owner = tempoAccessKeyOwner(env);
  if (!key) return { mode: "none" };
  const keyAddress = privateKeyToAccount(key).address;
  if (!owner) return { mode: "key", keyAddress };
  if (isAddressEqual(owner, keyAddress)) {
    throw new Error(
      "GLOAM_TEMPO_ACCOUNT is this key's own address. That makes it the account's root key, with no limits. Use a separate key as the access key, or unset GLOAM_TEMPO_ACCOUNT to sign as the key itself."
    );
  }
  return { mode: "access-key", keyAddress, owner };
}

type AgentWalletClient = WalletClient<HttpTransport, Chain, Account>;

/**
 * The wallet's RPC, noting the hash of each signed transaction before it is
 * sent. A send whose reply never comes back (a timeout, a gateway's 504 after
 * the node took it) throws with no hash, yet the transaction may land. This is
 * how the wallet send it belongs to (walletSend) still knows which one to look
 * for. The hash is keccak256 of the signed bytes, the same hash the node gives a
 * typed transaction. viem's own per-request options (it sends a transaction
 * once, never retried) pass through untouched.
 */
export function broadcastNotingTransport(rpc: string): HttpTransport {
  const inner = http(rpc);
  return ((config: Parameters<HttpTransport>[0]) => {
    const t = inner(config);
    const request = (async (args: { method: string; params?: unknown }, options?: unknown) => {
      if (args.method === "eth_sendRawTransaction" || args.method === "eth_sendRawTransactionSync") {
        const raw = Array.isArray(args.params) ? args.params[0] : undefined;
        if (typeof raw === "string" && /^0x[0-9a-fA-F]+$/.test(raw)) noteBroadcast(keccak256(raw as Hex));
      }
      return (t.request as (a: unknown, o?: unknown) => Promise<unknown>)(args, options);
    }) as typeof t.request;
    return { ...t, request };
  }) as HttpTransport;
}

export interface Signer {
  /**
   * "key": the key signs as its own address (a plain wallet).
   * "access-key": on Tempo, the key signs for the owner's account through the
   * AccountKeychain, so the protocol enforces the owner's limits on it.
   */
  mode: SignerMode;
  /** The account transactions are sent from: the key's own address, or the owner's account in access-key mode. */
  account: Account;
  /** The signing key's address (the access key id in access-key mode). */
  keyAddress: Address;
  network: McpNetwork;
  walletClient: AgentWalletClient;
  publicClient: ReturnType<typeof getPublicClient>;
}

/**
 * The agent's signer for a Gloam network (defaults to Robinhood Chain testnet).
 *
 * GLOAM_AGENT_PRIVATE_KEY is the agent's key. On its own the key signs as its
 * own address, holding its own funds. With GLOAM_TEMPO_ACCOUNT set,
 * the same key is a Tempo access key: on Tempo it signs for that account, and
 * the owner's AccountKeychain authorization (expiry, a periodic spending limit
 * and call scopes) is enforced by the protocol on every transaction, whatever
 * this server does. See `gloam-mcp authorize-access-key`. Robinhood Chain and
 * Base have no keychain, so there the key still signs as itself.
 *
 * Tools return plans instead of executing when no signer is configured.
 */
export function getSigner(net: McpNetwork = MCP_NETWORKS.robinhood, env: Env = process.env): Signer | null {
  const setup = signerSetup(env);
  if (setup.mode === "none") return null;
  const key = agentPrivateKey(env)!;
  const publicClient = getPublicClient(net);

  if (setup.mode === "access-key" && net.family === "tempo") {
    const account = TempoAccount.fromSecp256k1(key, { access: setup.owner });
    const chain = tempoChainFor(net, env);
    return {
      mode: "access-key",
      account: account as Account,
      keyAddress: setup.keyAddress,
      network: net,
      walletClient: createWalletClient({ account, chain, transport: broadcastNotingTransport(net.rpc) }) as unknown as AgentWalletClient,
      publicClient,
    };
  }

  const account = privateKeyToAccount(key);
  const chain = chainFor(net);
  return {
    mode: "key",
    account,
    keyAddress: account.address,
    network: net,
    walletClient: createWalletClient({ account, chain, transport: broadcastNotingTransport(net.rpc) }) as unknown as AgentWalletClient,
    publicClient,
  };
}

/**
 * A read-only client for a network, for chain reads when this server has no
 * signer (e.g. a payee that sweeps through the relay). Reads go to the RPC at
 * the chain head, old logs and state to the network's history RPC where it has one.
 */
export function getPublicClient(net: McpNetwork = MCP_NETWORKS.robinhood) {
  // this package's own http on both sides, so errors stay this viem's classes
  const fresh = http(net.rpc);
  const transport = net.historyRpc
    ? splitReadTransport<HttpTransport>({ fresh, history: http(net.historyRpc.url), recentBlocks: net.historyRpc.recentBlocks })
    : fresh;
  return createPublicClient({ chain: chainFor(net), ccipRead: false, transport });
}
