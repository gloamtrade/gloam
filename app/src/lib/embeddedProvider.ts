/**
 * The EIP-1193 provider behind a Gloam wallet (lib/turnkeyConnector). Signing
 * goes to the Turnkey account (lib/turnkeyBridge); reads go to each chain's RPC.
 *
 * It follows the app across every chain the wagmi config registers: Gloam's
 * networks (Robinhood Chain, Tempo, Base and Ethereum, mainnet and testnet) and
 * the chains a bridge order can be paid from. Switching chain needs no prompt:
 * the same key signs on all of them.
 *
 * A send picks who pays the network fee first (lib/embeddedGas): the wallet
 * itself, Turnkey's gas station, or nobody, in which case nothing is sent and
 * the error says so.
 *
 * Plain viem, with no React or wagmi, so scripts/selftest-turnkey-connector.mts runs it.
 */
import {
  SwitchChainError,
  UnauthorizedProviderError,
  UnsupportedProviderMethodError,
  createPublicClient,
  createWalletClient,
  getAddress,
  isAddress,
  isAddressEqual,
  isHex,
  numberToHex,
  type Address,
  type Chain,
  type EIP1193Provider,
  type Hex,
  type PublicClient,
  type Transport,
} from "viem";
import { TEMPO_FEE_CHAIN_IDS, gasBudget, noGasText, pickGasRoute, sponsorableCall, type SponsorTargets } from "./embeddedGas";
import { EmbeddedNotSentError } from "./embeddedErrors";
import type { EmbeddedSigner } from "./turnkeyBridge";

// A send that surely never went out (lib/embeddedErrors); lib/walletErrors counts it
// as "failed before send", so the app may drop what it saved ahead of the send.
export { EmbeddedMaybeSentError, EmbeddedNotSentError } from "./embeddedErrors";

type TxParams = {
  from?: string;
  to?: string | null;
  data?: string;
  input?: string;
  value?: string;
  gas?: string;
  chainId?: string | number;
};

export type EmbeddedProviderDeps = {
  chains: readonly Chain[];
  /** The transport reads (and this wallet's own sends) go out on, per chain. */
  transportFor: (chainId: number) => Transport;
  signer: () => EmbeddedSigner | null;
  /** Chains whose sends Turnkey may sponsor (lib/embeddedGas SPONSOR_CHAINS). */
  sponsorChains?: ReadonlySet<number>;
  /** A chain's Gloam vault and the tokens Add lists there: the only calls a sponsored send may make. */
  sponsorTargetsFor?: (chainId: number) => SponsorTargets | null;
  initialChainId?: number;
  /** Called after the provider moves to another chain. */
  onChainChanged?: (chainId: number) => void;
};

export type EmbeddedProvider = EIP1193Provider & {
  chainId(): number;
  /** Moves to `chainId` (a registered chain), telling onChainChanged. */
  setChainId(chainId: number): void;
};

export function makeEmbeddedProvider(deps: EmbeddedProviderDeps): EmbeddedProvider {
  if (deps.chains.length === 0) throw new Error("No chains to follow.");
  const sponsorChains = deps.sponsorChains ?? new Set<number>();
  const chainOf = (id: number) => deps.chains.find((c) => c.id === id);
  let current = deps.initialChainId !== undefined && chainOf(deps.initialChainId) ? deps.initialChainId : deps.chains[0]!.id;

  const publics = new Map<number, PublicClient>();
  function publicFor(id: number): PublicClient {
    const hit = publics.get(id);
    if (hit) return hit;
    const chain = chainOf(id);
    if (!chain) throw new SwitchChainError(new Error(`Chain ${id} is not one this app uses.`));
    const client = createPublicClient({ chain, transport: deps.transportFor(id) }) as PublicClient;
    publics.set(id, client);
    return client;
  }

  function setChainId(id: number) {
    if (!chainOf(id)) throw new SwitchChainError(new Error(`Chain ${id} is not one this app uses.`));
    if (id === current) return;
    current = id;
    deps.onChainChanged?.(id);
  }

  function signer(): EmbeddedSigner {
    const s = deps.signer();
    if (!s) throw new UnauthorizedProviderError(new Error("Sign in to your Gloam wallet first."));
    return s;
  }

  async function send(tx: TxParams): Promise<Hex> {
    const s = signer();
    const chainId = tx.chainId !== undefined && tx.chainId !== null ? Number(tx.chainId) : current;
    const chain = chainOf(chainId);
    if (!chain) throw new EmbeddedNotSentError(`This wallet can't send on chain ${chainId}.`);
    if (tx.from && (!isAddress(tx.from) || !isAddressEqual(tx.from, s.account.address))) {
      throw new EmbeddedNotSentError("That send names another wallet, so nothing was sent.");
    }
    if (!tx.to || !isAddress(tx.to)) throw new EmbeddedNotSentError("This wallet only sends to an address, so nothing was sent.");
    const to = getAddress(tx.to);
    const raw = tx.data ?? tx.input;
    const data = raw && isHex(raw) && raw !== "0x" ? (raw as Hex) : undefined;
    const value = tx.value ? BigInt(tx.value) : 0n;
    const gas = tx.gas ? BigInt(tx.gas) : undefined;
    const client = publicFor(chainId);

    let balance: bigint | null = null;
    let cost: bigint | null = null;
    if (!TEMPO_FEE_CHAIN_IDS.has(chainId)) {
      const [bal, est, fee] = await Promise.all([
        client.getBalance({ address: s.account.address }).catch(() => null),
        // Always estimated, even with a gas limit given: a call that would revert is never sponsored.
        client.estimateGas({ account: s.account.address, to, data, value }).catch(() => null),
        client
          .estimateFeesPerGas()
          .then((f) => f.maxFeePerGas ?? f.gasPrice ?? null)
          .catch(() => client.getGasPrice().catch(() => null)),
      ]);
      balance = bal;
      const units = est !== null && gas !== undefined && gas > est ? gas : est;
      cost = units !== null && fee !== null ? gasBudget(chainId, units, fee) : null;
    }

    const sponsorable = sponsorableCall({ to, data, value, targets: deps.sponsorTargetsFor?.(chainId) ?? null });
    const route = pickGasRoute({ chainId, balance, value, cost, sponsorable, sponsorChains: s.sponsoredSend ? sponsorChains : new Set() });
    if (route.kind === "none") throw new EmbeddedNotSentError(noGasText(route.why, chain.name, chain.nativeCurrency.symbol));
    if (route.kind === "sponsored") {
      return s.sponsoredSend!({
        chainId,
        from: s.account.address,
        to,
        data,
        value: value > 0n ? value : undefined,
        coin: chain.nativeCurrency.symbol,
      });
    }
    const wallet = createWalletClient({ account: s.account, chain, transport: deps.transportFor(chainId) });
    return wallet.sendTransaction({ account: s.account, chain, to, data, value, gas });
  }

  /** personal_sign takes [message, address]; some callers send [address, message]. */
  function messageParam(params: unknown[], address: Address): string {
    const [a, b] = params as [string, string];
    if (typeof a === "string" && isAddress(a) && isAddressEqual(a, address) && typeof b === "string") return b;
    return a;
  }

  async function request({ method, params }: { method: string; params?: unknown }): Promise<unknown> {
    const list = Array.isArray(params) ? params : [];
    switch (method) {
      case "eth_accounts":
      case "eth_requestAccounts": {
        const s = deps.signer();
        return s ? [s.account.address] : [];
      }
      case "eth_chainId":
        return numberToHex(current);
      case "net_version":
        return String(current);
      case "wallet_switchEthereumChain": {
        const id = Number((list[0] as { chainId?: string } | undefined)?.chainId);
        setChainId(id);
        return null;
      }
      case "wallet_addEthereumChain": {
        const id = Number((list[0] as { chainId?: string } | undefined)?.chainId);
        if (!chainOf(id)) throw new SwitchChainError(new Error(`Chain ${id} is not one this app uses.`));
        return null;
      }
      case "personal_sign": {
        const s = signer();
        const message = messageParam(list, s.account.address);
        // viem sends the message as hex: sign those bytes, the same as signMessage({ message }) on the text.
        return s.account.signMessage({ message: isHex(message) ? { raw: message } : message });
      }
      case "eth_signTypedData_v4": {
        const s = signer();
        const raw = list[1];
        const typed = typeof raw === "string" ? JSON.parse(raw) : raw;
        return s.account.signTypedData(typed);
      }
      case "eth_sendTransaction":
        return send((list[0] ?? {}) as TxParams);
      case "eth_sign":
      case "eth_signTransaction":
      case "wallet_sendCalls":
      case "wallet_getCallsStatus":
      case "wallet_showCallsStatus":
      case "wallet_grantPermissions":
      case "wallet_watchAsset":
        throw new UnsupportedProviderMethodError(new Error(`${method} isn't supported by this wallet.`));
      default:
        // Reads (eth_call, eth_getBalance, eth_estimateGas, receipts, logs...) go to the chain.
        return publicFor(current).request({ method: method as never, params: params as never });
    }
  }

  return {
    request: request as EIP1193Provider["request"],
    on: () => {},
    removeListener: () => {},
    chainId: () => current,
    setChainId,
  } as unknown as EmbeddedProvider;
}
