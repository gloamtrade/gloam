"use client";

import { ChainNotConfiguredError, createConnector } from "wagmi";
import { SwitchChainError, getAddress, http, type Address } from "viem";
import { EMBEDDED_CONNECTOR_ID } from "./embeddedWallet";
import { SPONSOR_CHAINS } from "./embeddedGas";
import { makeEmbeddedProvider, type EmbeddedProvider } from "./embeddedProvider";
import { allNetworks } from "./networks";
import { shieldTokensFor } from "./tokens";
import { getActiveTurnkeySigner, onTurnkeyAccountChange } from "./turnkeyBridge";

/**
 * wagmi connector for a Gloam wallet (Turnkey embedded wallet, lib/embeddedWallet).
 * It works on every chain the wagmi config registers and switches without a
 * prompt; lib/embeddedProvider does the signing, the reads and the gas choice.
 */
export function turnkeyConnector({ sponsorChains = SPONSOR_CHAINS }: { sponsorChains?: ReadonlySet<number> } = {}) {
  return createConnector<EmbeddedProvider>((config) => {
    let provider: EmbeddedProvider | undefined;
    let unsubscribe: (() => void) | undefined;
    let lastAddress: Address | null = null;

    function getProvider(): EmbeddedProvider {
      provider ??= makeEmbeddedProvider({
        chains: config.chains,
        transportFor: (chainId) => config.transports?.[chainId] ?? http(),
        signer: getActiveTurnkeySigner,
        sponsorChains,
        // each chain's vault and the tokens Add lists there: the only calls a sponsored send may make
        sponsorTargetsFor: (chainId) => {
          const vault = allNetworks().find((n) => n.chainId === chainId)?.pool;
          return vault ? { vault, tokens: shieldTokensFor(chainId).map((t) => t.address as Address) } : null;
        },
        onChainChanged: (chainId) => config.emitter.emit("change", { chainId }),
      });
      return provider;
    }

    return {
      id: EMBEDDED_CONNECTOR_ID,
      name: "Gloam wallet",
      type: "turnkey" as const,

      async connect({ chainId } = {}) {
        const signer = getActiveTurnkeySigner();
        if (!signer) throw new Error("Sign in to your Gloam wallet first.");
        const p = getProvider();
        if (chainId !== undefined && config.chains.some((c) => c.id === chainId)) p.setChainId(chainId);
        lastAddress = signer.account.address;
        // A different account signing in (or signing out) reaches wagmi as an accounts change.
        unsubscribe?.();
        unsubscribe = onTurnkeyAccountChange(() => {
          const next = getActiveTurnkeySigner()?.account.address ?? null;
          if (next === lastAddress) return;
          lastAddress = next;
          if (next) config.emitter.emit("change", { accounts: [getAddress(next)] });
          else config.emitter.emit("disconnect");
        });
        // wagmi's connect() takes an optional generic; the shape it returns is fixed by the connector.
        return { accounts: [signer.account.address] as readonly Address[], chainId: p.chainId() } as never;
      },
      async disconnect() {
        unsubscribe?.();
        unsubscribe = undefined;
        lastAddress = null;
      },
      async getAccounts() {
        const signer = getActiveTurnkeySigner();
        return (signer ? [signer.account.address] : []) as readonly Address[];
      },
      async getChainId() {
        return getProvider().chainId();
      },
      async getProvider() {
        return getProvider();
      },
      async isAuthorized() {
        return Boolean(getActiveTurnkeySigner());
      },
      async switchChain({ chainId }) {
        const chain = config.chains.find((c) => c.id === chainId);
        if (!chain) throw new SwitchChainError(new ChainNotConfiguredError());
        getProvider().setChainId(chainId);
        return chain;
      },
      onAccountsChanged(accounts) {
        if (accounts.length === 0) config.emitter.emit("disconnect");
        else config.emitter.emit("change", { accounts: accounts.map((a) => getAddress(a)) });
      },
      onChainChanged(chain) {
        config.emitter.emit("change", { chainId: Number(chain) });
      },
      onDisconnect() {
        config.emitter.emit("disconnect");
      },
    };
  });
}
