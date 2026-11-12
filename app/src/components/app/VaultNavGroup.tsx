"use client";

import { IntentLink } from "@/components/IntentLink";
import { usePathname, useSearchParams } from "next/navigation";
import type { ReactNode } from "react";
import { useNetwork } from "./NetworkProvider";
import { useAppAccount } from "@/lib/demo";
import { FRESH_WALLET_PATH, GAS_STATION_CHAIN_ID } from "@/lib/gasStation";
import { swapOpenTo, vaultSwapRouter } from "@/lib/vaultSwap";
import { vaultActionFromParams, vaultActionsFor, type VaultActionId } from "@/lib/vaultNav";

/**
 * The fill that marks the current page. The sidebar is a panel, so a surface
 * shows on it; the phone sheet sits on the app ground, where only a panel does.
 */
export function navActiveFill(size: "desktop" | "sheet") {
  return size === "sheet" ? "bg-panel" : "bg-surface";
}

/**
 * Vault in the app nav, with its actions listed under it: Add privately, Pay
 * privately, Receive, Swap and Cash out (plus Trade and Public send where the
 * network has them). Each is a link to that part of the Vault, and the one on
 * screen is marked, so every money move is one look away. On Robinhood Chain
 * mainnet, Fresh wallet (its own page, not a Vault tab) follows Agent top-ups.
 */
export function VaultNavGroup({
  icon,
  onNavigate,
  size = "desktop",
}: {
  icon: ReactNode;
  onNavigate?: () => void;
  size?: "desktop" | "sheet";
}) {
  const pathname = usePathname();
  const sp = useSearchParams();
  return <VaultNavList icon={icon} onNavigate={onNavigate} size={size} pathname={pathname} tab={sp.get("tab")} mode={sp.get("mode")} />;
}

/** The same list before the URL's query is known (server render): nothing marked yet. */
export function VaultNavGroupStatic(props: { icon: ReactNode; size?: "desktop" | "sheet" }) {
  return <VaultNavList {...props} pathname={null} tab={null} mode={null} />;
}

function VaultNavList({
  icon,
  onNavigate,
  size = "desktop",
  pathname,
  tab,
  mode,
}: {
  icon: ReactNode;
  onNavigate?: () => void;
  size?: "desktop" | "sheet";
  pathname: string | null;
  tab: string | null;
  mode: string | null;
}) {
  const { network, settled } = useNetwork();
  const { address } = useAppAccount();
  // Until this browser's network is known, only the actions every network has,
  // so a Swap or Trade entry never flashes in and out.
  const actions = vaultActionsFor({
    swap: settled && vaultSwapRouter(network.chainId) !== null && swapOpenTo(address),
    stocks: settled && Boolean(network.stocks),
  });
  const rows: { id: VaultActionId | "fresh-wallet"; label: string; href: string }[] = [...actions];
  // Same wait for the network, so Fresh wallet never flashes in and out either.
  if (settled && network.chainId === GAS_STATION_CHAIN_ID) {
    rows.splice(rows.findIndex((a) => a.id === "topups") + 1, 0, { id: "fresh-wallet", label: "Fresh wallet", href: FRESH_WALLET_PATH });
  }
  const inVault = pathname === "/app/vault";
  const current: VaultActionId | "fresh-wallet" | null = inVault
    ? vaultActionFromParams(tab, mode, actions)
    : pathname === FRESH_WALLET_PATH
      ? "fresh-wallet"
      : null;
  // The Vault's overview (no action in the URL) is the Vault row itself.
  const onOverview = inVault && current === null;
  const rowH = size === "sheet" ? "h-10" : "h-9";

  return (
    <div role="group" aria-labelledby={`nav-vault-${size}`}>
      <IntentLink
        id={`nav-vault-${size}`}
        href="/app/vault"
        onClick={onNavigate}
        aria-current={onOverview ? "page" : undefined}
        className={`flex h-10 items-center gap-3 rounded-xl px-3 text-[14px] transition-colors ${
          onOverview
            ? `${navActiveFill(size)} font-medium text-foreground`
            : current !== null
              ? "font-medium text-foreground"
              : "text-mute hover:bg-surface/70 hover:text-foreground"
        }`}
      >
        {icon}
        Vault
      </IntentLink>
      <ul className="mt-0.5 flex flex-col gap-0.5">
        {rows.map((a) => {
          const active = current === a.id;
          return (
            <li key={a.id}>
              <IntentLink
                href={a.href}
                onClick={onNavigate}
                aria-current={active ? "page" : undefined}
                className={`flex ${rowH} items-center rounded-xl pl-[42px] pr-3 text-[13.5px] transition-colors ${
                  active ? `${navActiveFill(size)} font-medium text-foreground` : "text-mute hover:bg-surface/70 hover:text-foreground"
                }`}
              >
                {a.label}
              </IntentLink>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
