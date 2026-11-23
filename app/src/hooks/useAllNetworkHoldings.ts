"use client";

import { useEffect, useMemo, useState } from "react";
import { DEMO_ADDRESS, useDemoLive } from "@/lib/demo";
import { onNotesSaved, unlockNoteVault } from "@/lib/noteVault";
import { shownNetworks } from "@/lib/networks";
import { holdingsAcrossNetworks, type NetworkHolding } from "@/lib/allNetworkBalances";
import { useNetwork } from "@/components/app/NetworkProvider";
import { useShownAccount } from "@/components/app/AccountScope";

const NONE: NetworkHolding[] = [];

/**
 * The signed-in account's private balance on every network the app shows
 * (lib/allNetworkBalances), read again whenever a note is saved here or in
 * another tab, and once the note store opens. Nothing while signed out.
 */
export function useAllNetworkHoldings(address?: string | null): NetworkHolding[] {
  const { settled, network } = useNetwork();
  // mainnets with mainnets, testnets with testnets: test money never joins a real total
  const testnet = network.testnet;
  const demo = useDemoLive();
  const wallet = demo ? address || DEMO_ADDRESS : address;
  // the store reads nothing before the account binds, so read again once it lands
  const shownAccount = useShownAccount();
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let live = true;
    void unlockNoteVault()
      .catch(() => undefined)
      .then(() => {
        if (live) setTick((t) => t + 1);
      });
    const off = onNotesSaved(() => setTick((t) => t + 1));
    const onStorage = () => setTick((t) => t + 1);
    window.addEventListener("storage", onStorage);
    return () => {
      live = false;
      off();
      window.removeEventListener("storage", onStorage);
    };
  }, [shownAccount]);

  return useMemo(
    () => (settled && wallet ? holdingsAcrossNetworks(wallet, shownNetworks().filter((n) => n.testnet === testnet)) : NONE),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- tick: the store changed
    [settled, wallet, shownAccount, tick, testnet]
  );
}
