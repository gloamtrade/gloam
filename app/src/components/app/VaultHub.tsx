"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import { StocksLiveNote } from "@/components/StocksLiveNote";
import { VaultActionIcon, VaultHome } from "./VaultHome";
import { useNetwork } from "./NetworkProvider";
import { swapOpenTo, vaultSwapRouter } from "@/lib/vaultSwap";
import { swapLinkNetwork, swapsElsewhereNote } from "@/lib/swapLink";
import { SwapsElsewhere } from "./SwapLinkBanner";
import { useAppAccount } from "@/lib/demo";
import { tabKeyTarget } from "@/lib/tabKeys";
import {
  vaultActionFromUrl,
  vaultActionSearch,
  vaultHashAfterQuery,
  vaultActionsFor,
  type VaultActionId,
  type VaultActionInfo,
} from "@/lib/vaultHub";

/**
 * The Vault: one place for every private money move. With no action in the
 * URL it opens on the overview (VaultHome), which shows the private balance
 * next to the public wallet and names every action with one line. An action
 * opens under a row that switches between them: Add privately, Pay
 * privately, Receive, Swap and Cash out, then Agent top-ups, and Trade and
 * Public send where the network has them. The URL (?tab=, and ?mode= for Pay's parts) says which,
 * so links and the old /app/shield, /app/move and /app/send redirects keep
 * working (lib/vaultHub).
 */

const noopSubscribe = () => () => {};

function PanelSkeleton() {
  return (
    <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_340px]" aria-busy="true">
      <div className="gl-card h-[420px] motion-safe:animate-pulse" />
      <div className="gl-card h-[220px] motion-safe:animate-pulse" />
    </div>
  );
}

function HomeSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading the vault">
      <div className="gl-card h-[260px] motion-safe:animate-pulse" />
      <div className="gl-card h-[380px] motion-safe:animate-pulse xl:h-[190px]" />
    </div>
  );
}

// Each action is its own chunk, fetched when its tab opens. The views only
// render in the browser (see `hydrated` below), so nothing is lost on the
// server, and opening the vault no longer downloads every action's code.
const ShieldView = dynamic(() => import("./ShieldView").then((m) => m.ShieldView), {
  ssr: false,
  loading: PanelSkeleton,
});
const MoveView = dynamic(() => import("./MoveView").then((m) => m.MoveView), {
  ssr: false,
  loading: PanelSkeleton,
});
const TradeView = dynamic(() => import("./TradeView").then((m) => m.TradeView), {
  ssr: false,
  loading: PanelSkeleton,
});
const VaultSwapView = dynamic(() => import("./VaultSwapView").then((m) => m.VaultSwapView), {
  ssr: false,
  loading: PanelSkeleton,
});
const SendView = dynamic(() => import("./SendView").then((m) => m.SendView), {
  ssr: false,
  loading: PanelSkeleton,
});
const AgentTopUpsView = dynamic(() => import("./AgentTopUpsView").then((m) => m.AgentTopUpsView), {
  ssr: false,
  loading: PanelSkeleton,
});

export function VaultHub() {
  const router = useRouter();
  const sp = useSearchParams();
  const { network, networkKey, setNetworkKey, settled } = useNetwork();
  const { address } = useAppAccount();
  // The views read the saved network and wallet, which only exist in the
  // browser: render them once hydrated (this suspends apart from the network
  // provider, which can settle first) so server and client HTML always match.
  const hydrated = useSyncExternalStore(noopSubscribe, () => true, () => false);

  // Tokenized stocks only trade on Robinhood Chain testnet and swaps only where a
  // vault swap router is deployed, so those actions drop out elsewhere.
  const actions = vaultActionsFor({
    swap: vaultSwapRouter(network.chainId) !== null && swapOpenTo(address),
    stocks: Boolean(network.stocks),
  });

  // A claim link's fragment (#claim=…) opens Receive; Pay reads and clears it.
  const [hash, setHash] = useState("");
  useEffect(() => {
    const read = () => setHash(window.location.hash);
    read();
    window.addEventListener("hashchange", read);
    return () => window.removeEventListener("hashchange", read);
  }, []);

  const tab = sp.get("tab");
  const mode = sp.get("mode");
  // Pay clears that fragment without a hashchange, so once the URL names
  // another action (the nav's Pay privately or Cash out after a claim) it is
  // read again, and a claim already taken no longer marks Receive.
  const query = sp.toString();
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the address bar changed under Next's router: read its fragment again
    setHash((kept) => vaultHashAfterQuery(kept, window.location.hash, tab, mode));
  }, [query, tab, mode]);
  // Pay follows ?mode= and writes its own changes back (a claim opening
  // Receive, say), so the row always marks what is on screen.
  const action = vaultActionFromUrl(tab, mode, hash, actions);
  const current = actions.find((a) => a.id === action) ?? null;

  // A swap link (lib/swapLink) names its network: move there once, as a
  // payment request does, so Swap opens even from a network without swaps.
  // Once per link, so switching back by hand afterwards sticks.
  const swapLinkTo = tab === "swap" ? swapLinkNetwork(hash) : null;
  const [switchedFor, setSwitchedFor] = useState<string | null>(null);
  useEffect(() => {
    if (!settled || !swapLinkTo || switchedFor === hash) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the fragment is read after mount; this marks the link as moved for
    setSwitchedFor(hash);
    if (swapLinkTo !== networkKey) setNetworkKey(swapLinkTo);
  }, [settled, swapLinkTo, switchedFor, hash, networkKey, setNetworkKey]);
  const switching = Boolean(swapLinkTo && swapLinkTo !== networkKey && switchedFor !== hash);

  function select(id: VaultActionId) {
    if (id === action || !actions.some((a) => a.id === id)) return;
    setHash("");
    router.replace(`/app/vault${vaultActionSearch(id, window.location.search)}`, { scroll: false });
  }

  // The network and wallet only exist in the browser; until they are read,
  // a calm placeholder the shape of what comes.
  if (!hydrated || !settled) {
    return tab ? (
      <div className="space-y-6">
        <div className="h-[68px] w-full rounded-[20px] bg-surface-2 motion-safe:animate-pulse sm:h-12 sm:max-w-[560px] sm:rounded-full" />
        <PanelSkeleton />
      </div>
    ) : (
      <HomeSkeleton />
    );
  }

  if (!current) {
    // A swap link on its way to its network: the Swap tab opens once there.
    if (switching) {
      return (
        <div className="space-y-6">
          <PanelSkeleton />
        </div>
      );
    }
    // Swap asked for on a network without it: say where it runs, not just the overview.
    const swapNote = tab === "swap" ? swapsElsewhereNote(networkKey, hash) : null;
    return (
      <div className="space-y-6">
        <StocksLiveNote chainId={network.chainId} where="vault" />
        {swapNote && <SwapsElsewhere note={swapNote} onSwitch={setNetworkKey} />}
        <VaultHome actions={actions} />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <StocksLiveNote chainId={network.chainId} where="vault" alone={current.id === "swap"} />
      <ActionRow actions={actions} current={current.id} onSelect={select} />

      <div id="vault-panel" role="tabpanel" aria-labelledby={`vault-tab-${current.id}`} className="min-w-0">
        <Suspense fallback={<PanelSkeleton />}>
          {current.id === "shield" && <ShieldView />}
          {current.id === "trade" && <TradeView />}
          {current.id === "swap" && <VaultSwapView />}
          {current.id === "send" && <SendView />}
          {current.id === "topups" && <AgentTopUpsView />}
          {current.tab === "move" && <MoveView />}
        </Suspense>
      </div>
    </div>
  );
}

/**
 * The row of actions on every action page. On a phone the five main ones sit
 * side by side, each a mark and a short name; from a tablet up it is one
 * track of names, with Agent top-ups, Trade and Public send after them.
 * One tab stop for the row (the open action); the arrows, Home and End move
 * along it, and Enter or Space opens one.
 */
function ActionRow({
  actions,
  current,
  onSelect,
}: {
  actions: readonly VaultActionInfo[];
  current: VaultActionId;
  onSelect: (id: VaultActionId) => void;
}) {
  const row = useRef<HTMLDivElement>(null);
  const core = actions.filter((a) => !a.extra).length;
  // On a phone only the main actions fit, so Agent top-ups, Trade and Public
  // send are left out, except the one that is open: it takes a slot, so the row always
  // marks where you are and keeps its tab stop.
  const extraOpen = actions.some((a) => a.extra && a.id === current);
  const phoneCols = core + (extraOpen ? 1 : 0);
  const colsClass = phoneCols >= 6 ? "grid-cols-6" : phoneCols === 5 ? "grid-cols-5" : "grid-cols-4";

  function onKey(e: KeyboardEvent<HTMLButtonElement>) {
    const tabs = Array.from(row.current?.querySelectorAll<HTMLElement>('[role="tab"]') ?? []).filter(
      (el) => el.offsetParent !== null
    );
    const i = tabs.indexOf(e.currentTarget);
    const next = i < 0 ? null : tabKeyTarget(e.key, i, tabs.length);
    if (next === null) return;
    e.preventDefault();
    tabs[next]?.focus();
  }

  // Desktop lists these same actions in the sidebar, so the row is for phones and tablets
  // (globals.css .vault-tabstrip).
  return (
    <div className="vault-tabstrip items-center gap-2">
      <Link
        href="/app/vault"
        aria-label="Vault overview"
        title="Vault overview"
        className="hidden h-12 w-12 shrink-0 place-items-center rounded-full bg-surface-2 text-mute transition-colors hover:text-foreground sm:grid dark:bg-panel dark:ring-1 dark:ring-line"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
          <rect x="4" y="4" width="6.5" height="6.5" rx="1.8" stroke="currentColor" strokeWidth="1.6" />
          <rect x="13.5" y="4" width="6.5" height="6.5" rx="1.8" stroke="currentColor" strokeWidth="1.6" />
          <rect x="4" y="13.5" width="6.5" height="6.5" rx="1.8" stroke="currentColor" strokeWidth="1.6" />
          <rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.8" stroke="currentColor" strokeWidth="1.6" />
        </svg>
      </Link>
      <div
        ref={row}
        role="tablist"
        aria-label="Vault actions"
        className={`grid w-full gap-1 rounded-[20px] bg-surface-2 p-1 sm:inline-flex sm:w-auto sm:max-w-full sm:rounded-full dark:bg-panel dark:ring-1 dark:ring-line ${colsClass}`}
      >
        {actions.map((a, i) => {
          const active = a.id === current;
          const extraStart = a.extra && !actions[i - 1]?.extra;
          return (
            <button
              key={a.id}
              id={`vault-tab-${a.id}`}
              type="button"
              role="tab"
              aria-selected={active}
              aria-controls="vault-panel"
              tabIndex={active ? 0 : -1}
              title={a.line}
              onClick={() => onSelect(a.id)}
              onKeyDown={onKey}
              className={`flex min-w-0 flex-col items-center justify-center gap-1 rounded-[16px] px-1 text-[12px] leading-tight transition-colors duration-200 max-sm:h-[60px] max-sm:px-0 sm:h-10 sm:flex-row sm:whitespace-nowrap sm:rounded-full sm:px-4 sm:text-[14px] ${
                a.extra && !active ? "max-sm:hidden" : ""
              } ${extraStart ? "sm:ml-2" : ""} ${
                active
                  ? "bg-panel font-medium text-foreground shadow-card dark:bg-surface-2"
                  : "text-mute hover:text-foreground"
              }`}
            >
              <span className="sm:hidden">
                <VaultActionIcon id={a.id} size={18} />
              </span>
              <span className="max-w-full text-center md:hidden">{a.short}</span>
              <span className="hidden md:inline">{a.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
