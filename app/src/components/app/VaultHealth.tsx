"use client";

import { useMemo } from "react";
import { shortAddress } from "@/lib/chain";
import { useNetwork } from "./NetworkProvider";
import { vaultEnvDiagnostics } from "@/lib/config";
import { HASH_SCHEME, isShieldDeployed } from "@/lib/shield";
import { vaultSwapRouter } from "@/lib/vaultSwap";
import { useShieldTree } from "@/hooks/useShieldTree";
import { StatusPill } from "./StatusPill";

export function RefreshIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 4.5v4h-4"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * Always-on vault status, dedicated RH RPC, no wallet required.
 */
export function VaultHealth({ compact = false }: { compact?: boolean }) {
  const { network } = useNetwork();
  const { leafCount, loading: treeLoading, refresh, error: treeError } =
    useShieldTree();
  const env = useMemo(() => vaultEnvDiagnostics(), []);
  // A payments vault: every mainnet, and Base Sepolia.
  const paymentsOnly = network.paymentsPool;

  if (!isShieldDeployed()) return null;

  const recheck = () => {
    void refresh();
  };

  const syncText = treeLoading
    ? "Syncing…"
    : treeError
      ? "Could not sync"
      : `${leafCount.toLocaleString()} private ${leafCount === 1 ? "balance" : "balances"}`;

  if (compact) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-2 text-[12.5px] text-mute">
        <span className="tnum">
          Private vault
          {network.pool ? ` ${shortAddress(network.pool, 4)}` : ""}
          <span className="text-faint"> · </span>
          {syncText}
        </span>
        <span className="flex items-center gap-1">
          <StatusPill tone="lime" dot>
            {paymentsOnly ? "Payments" : "Vault"}
          </StatusPill>
          <button
            type="button"
            onClick={recheck}
            className="inline-flex h-10 items-center gap-1.5 rounded-full px-3 text-[12.5px] text-mute transition-colors hover:bg-surface hover:text-foreground"
          >
            <RefreshIcon />
            Refresh
          </button>
        </span>
      </div>
    );
  }

  return (
    <div className="rounded-[14px] bg-surface p-4 text-[14px]">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[14px] text-foreground">Private vault</p>
          <p className="tnum mt-1 text-[13px] text-mute">
            {network.pool ? shortAddress(network.pool, 6) : "Not set up"}
            {HASH_SCHEME !== "poseidon" ? ` · ${HASH_SCHEME}` : ""}
            <span className="text-faint"> · </span>
            {syncText}
          </p>
        </div>
        <div className="flex items-center gap-1">
          <StatusPill tone="lime" dot>
            Ready
          </StatusPill>
          <button
            type="button"
            onClick={recheck}
            className="inline-flex h-10 items-center gap-1.5 rounded-full px-3 text-[12.5px] text-mute transition-colors hover:bg-surface-2 hover:text-foreground"
          >
            <RefreshIcon />
            Refresh
          </button>
        </div>
      </div>
      <p className="mt-3 max-w-[64ch] text-[13px] leading-relaxed text-mute">
        {/* What shows, as /docs/privacy-model has it: deposits and cash outs are public, a swap shows its amounts. */}
        Your balance and private payments stay hidden. Adding money and cashing
        out are public transfers that show the amount and the wallet.
        {vaultSwapRouter(network.chainId) !== null ? " A swap hides who swapped, not the amounts." : null}
        {network.stocks ? " Trades show their size and pair." : null}
      </p>
      {network.pool && (
        <p className="tnum mt-3 break-all border-t border-line pt-3 text-[12px] leading-relaxed text-faint">
          {network.pool}
          {" · block "}
          {/* the env block is Robinhood Chain testnet's; a payments vault carries its own */}
          {(paymentsOnly && network.deployBlock !== null ? network.deployBlock : env.deployBlock).toString()}
          {env.remappedFromLegacy || env.deployBlockRemapped
            ? " · remapped from legacy env"
            : ""}
          {" · "}
          <a
            href={network.explorerAddress(network.pool)}
            target="_blank"
            rel="noreferrer"
            className="text-mute underline decoration-line-strong underline-offset-2 transition-colors hover:text-foreground"
          >
            Explorer
          </a>
        </p>
      )}
      {(env.remappedFromLegacy || env.deployBlockRemapped) && (
        <p className="mt-2 rounded-[10px] bg-warn-soft px-3 py-2 text-[12px] leading-relaxed text-warn">
          Vercel still has older env values. The app remaps to the current vault{" "}
          {shortAddress(env.productPool, 4)}. Clean{" "}
          <span className="font-medium">NEXT_PUBLIC_POSEIDON_SHIELD_POOL</span>{" "}
          and the deploy block in Vercel when you can.
        </p>
      )}
    </div>
  );
}
