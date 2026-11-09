"use client";

import { useEffect, useRef } from "react";
import { useAccount, useConnect, useSwitchChain } from "wagmi";
import { EMBEDDED_CONNECTOR_ID } from "@/lib/embeddedWallet";
import { getActiveTurnkeyAccount, onTurnkeyAccountChange } from "@/lib/turnkeyBridge";
import { useNetwork } from "./NetworkProvider";

/**
 * Lives inside WagmiProvider and NetworkProvider. When the Gloam wallet's signer
 * is ready and no other wallet is connected, it connects the wagmi connector on
 * the app's network, so the app's wagmi hooks transact through the Gloam wallet.
 * Signing out reaches wagmi from the connector itself. Renders nothing.
 *
 * It follows the app when the network is changed in the menu: the same key signs
 * on every chain, so there is nothing to ask. It does not pull the wallet back
 * when something else moved it (a bridge order paid on another chain).
 */
export function TurnkeyAutoConnect() {
  const { connect, connectors } = useConnect();
  const { connector: current, chainId, status } = useAccount();
  const { switchChain } = useSwitchChain();
  const { network } = useNetwork();
  const target = network.chainId;

  useEffect(() => {
    const sync = () => {
      const turnkey = connectors.find((c) => c.id === EMBEDDED_CONNECTOR_ID);
      // A browser wallet the person connected stays connected.
      if (!turnkey || !getActiveTurnkeyAccount() || status !== "disconnected") return;
      connect({ connector: turnkey, chainId: target });
    };
    sync();
    return onTurnkeyAccountChange(sync);
  }, [connect, connectors, status, target]);

  const followed = useRef<number | null>(null);
  useEffect(() => {
    if (current?.id !== EMBEDDED_CONNECTOR_ID) {
      followed.current = null;
      return;
    }
    if (followed.current === target) return;
    followed.current = target;
    if (chainId !== target) switchChain({ chainId: target });
  }, [current, chainId, target, switchChain]);

  return null;
}
