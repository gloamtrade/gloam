"use client";

/**
 * Runtime network selection. Holds the active Gloam network in React state,
 * persisted to localStorage so a reload keeps the choice. A visitor who never
 * picked one starts on defaultNetworkKey(): Robinhood Chain testnet until
 * mainnet is live, a mainnet after.
 *
 * While the testnets are out of view (NEXT_PUBLIC_SHOW_TESTNETS off,
 * lib/showTestnets), a saved testnet opens on that default instead, with no
 * error. A claim or request link on a testnet still moves the page there, but
 * that visit is not saved, so the next one opens on mainnet again.
 *
 * Solana (lib/solanaRings, only while NEXT_PUBLIC_SOLANA_RINGS_ENABLED is on)
 * is picked in the same menu, but it is not an EVM network: picking it sets
 * `solana` and leaves `network` on the last EVM network, so every EVM reader
 * (balances, wallet, relay, payroll) keeps a network it understands. The app's
 * pages read `solana` to show their Solana side. Picking an EVM network clears
 * it. Saved apart from the EVM choice, under its own key.
 *
 * This is the switch the app reads to know which chain to talk to. It does not
 * itself rewire the existing Robinhood write path (that stays the default);
 * consumers opt in by reading `useNetwork()` as they are migrated off the
 * build-time PRODUCT_CHAIN constants.
 */
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  DEFAULT_NETWORK_KEY,
  FIRST_PAINT_NETWORK_KEY,
  getNetwork,
  isShownNetworkKey,
  setShownNetworkKey,
  shownKeyOrDefault,
  type GloamNetwork,
  type NetworkKey,
} from "@/lib/networks";
import { SOLANA_RINGS_ENABLED } from "@/lib/solanaRings/config";

const STORAGE_KEY = "gloam.network";
/** "solana" while Solana is the network picked in this browser. */
const DESTINATION_KEY = "gloam.destination";

interface NetworkContextValue {
  network: GloamNetwork;
  networkKey: NetworkKey;
  setNetworkKey: (key: NetworkKey) => void;
  /**
   * False on the first render, before this browser's choice (or the mainnet
   * default) is read. The server can't know it, so labels that name the network
   * (testnet or mainnet) show a neutral placeholder until then, not a guess.
   */
  settled: boolean;
  /**
   * Solana is the network picked. `network` then stays the last EVM network
   * (never Solana), so code that talks to an EVM chain keeps working; pages
   * show their Solana side instead. Always false while Solana is off.
   */
  solana: boolean;
  /** Pick Solana. Picking an EVM network (setNetworkKey) leaves it. */
  selectSolana: () => void;
}

const NetworkContext = createContext<NetworkContextValue | null>(null);

/** This browser's saved network while people can pick it, else the default (lib/networks shownKeyOrDefault). */
function readStored(): NetworkKey {
  if (typeof window === "undefined") return DEFAULT_NETWORK_KEY;
  let v: string | null = null;
  try {
    v = window.localStorage.getItem(STORAGE_KEY);
  } catch {
    /* private mode / blocked storage */
  }
  return shownKeyOrDefault(v);
}

/** Whether this browser picked Solana last (and Solana is on here). */
function readSolana(): boolean {
  if (!SOLANA_RINGS_ENABLED || typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(DESTINATION_KEY) === "solana";
  } catch {
    return false;
  }
}

function saveSolana(on: boolean) {
  try {
    if (on) window.localStorage.setItem(DESTINATION_KEY, "solana");
    else window.localStorage.removeItem(DESTINATION_KEY);
  } catch {
    /* private mode / blocked storage: the choice holds for this visit */
  }
}

export function NetworkProvider({ children }: { children: ReactNode }) {
  // Start from the default for a stable first render, then hydrate from storage
  // on mount to avoid an SSR/client mismatch.
  const [networkKey, setKey] = useState<NetworkKey>(FIRST_PAINT_NETWORK_KEY);
  const [settled, setSettled] = useState(false);
  const [solana, setSolana] = useState(false);

  useEffect(() => {
    const stored = readStored();
    // lib code (notes, tree, proofs) follows the network shown, even if storage refuses writes
    setShownNetworkKey(stored);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the saved network lives only in the browser; the server renders the default and this reads it once after mount
    if (stored !== networkKey) setKey(stored);
    if (readSolana()) setSolana(true);
    setSettled(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Cross-tab sync.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY && isShownNetworkKey(e.newValue)) {
        setShownNetworkKey(e.newValue);
        setKey(e.newValue);
      }
      if (e.key === DESTINATION_KEY) setSolana(SOLANA_RINGS_ENABLED && e.newValue === "solana");
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const setNetworkKey = (key: NetworkKey) => {
    setShownNetworkKey(key);
    setKey(key);
    // an EVM network picked (by hand or by a link) leaves Solana
    setSolana(false);
    saveSolana(false);
    // a hidden testnet (opened from a claim link) is never saved over this browser's pick
    if (!isShownNetworkKey(key)) return;
    try {
      window.localStorage.setItem(STORAGE_KEY, key);
    } catch {
      /* ignore */
    }
  };

  const selectSolana = () => {
    if (!SOLANA_RINGS_ENABLED) return;
    setSolana(true);
    saveSolana(true);
  };

  const value = useMemo<NetworkContextValue>(
    () => ({ network: getNetwork(networkKey), networkKey, setNetworkKey, settled, solana, selectSolana }),
    [networkKey, settled, solana]
  );

  return (
    <NetworkContext.Provider value={value}>{children}</NetworkContext.Provider>
  );
}

/** Read the active network. Safe outside a provider: falls back to the default. */
export function useNetwork(): NetworkContextValue {
  const ctx = useContext(NetworkContext);
  if (ctx) return ctx;
  return {
    network: getNetwork(DEFAULT_NETWORK_KEY),
    networkKey: DEFAULT_NETWORK_KEY,
    setNetworkKey: () => {},
    settled: true,
    solana: false,
    selectSolana: () => {},
  };
}
