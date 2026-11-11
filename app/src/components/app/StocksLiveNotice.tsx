"use client";

/**
 * Tells people already in the app that private stocks are live on Robinhood
 * Chain mainnet, with one way to the private Swap there. It shows on mainnet
 * views only, never on the Swap it points to, and stays away once closed
 * (kept in this browser; blocked storage keeps it closed for the page's life).
 */
import { IntentLink } from "@/components/IntentLink";
import { usePathname, useSearchParams } from "next/navigation";
import { useSyncExternalStore } from "react";
import { isNetworkKey } from "@/lib/networks";
import { vaultActionSearch } from "@/lib/vaultHub";
import { useNetwork } from "./NetworkProvider";

const STORAGE_KEY = "gloam.notice.stocks-live.v1";
const MAINNET = "robinhood-mainnet";

let closedHere = false;
const listeners = new Set<() => void>();

function subscribe(onChange: () => void) {
  listeners.add(onChange);
  window.addEventListener("storage", onChange);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", onChange);
  };
}

function isClosed(): boolean {
  if (closedHere) return true;
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function close() {
  closedHere = true;
  try {
    window.localStorage.setItem(STORAGE_KEY, "1");
  } catch {
    /* private mode / blocked storage: closed for this page load */
  }
  listeners.forEach((l) => l());
}

/**
 * Whether this browser closed the notice. The vault's stocks line waits for it,
 * so one screen never says private stocks are live twice.
 */
export function useStocksNoticeClosed(): boolean {
  return useSyncExternalStore(subscribe, isClosed, () => true);
}

export function StocksLiveNotice() {
  const { network, networkKey, setNetworkKey, settled } = useNetwork();
  const pathname = usePathname();
  const tab = useSearchParams().get("tab");
  // The server and the first client render say closed, so nobody who closed it sees it flash.
  const closed = useStocksNoticeClosed();

  if (closed || !settled || network.testnet || !isNetworkKey(MAINNET)) return null;
  // Already on the Swap this points to.
  if (networkKey === MAINNET && pathname === "/app/vault" && tab === "swap") return null;

  return (
    <div className="relative mb-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-[14px] bg-surface py-2.5 pl-4 pr-12 text-[13.5px] leading-relaxed text-soft">
      <p className="min-w-0">
        <span className="block font-medium text-foreground">Private stocks are live</span>
        Buy and sell tokenized stocks on Robinhood Chain from your private balance.
      </p>
      <IntentLink
        href={`/app/vault${vaultActionSearch("swap", "")}`}
        onClick={() => {
          if (networkKey !== MAINNET) setNetworkKey(MAINNET);
          close();
        }}
        className="btn btn-ghost btn-sm h-10 shrink-0"
      >
        Swap privately
      </IntentLink>
      <button
        type="button"
        onClick={close}
        aria-label="Dismiss"
        className="absolute right-1 top-1/2 grid h-10 w-10 -translate-y-1/2 place-items-center rounded-full text-mute transition-colors hover:bg-panel hover:text-foreground"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
          <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
}
