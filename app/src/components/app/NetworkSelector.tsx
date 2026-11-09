"use client";

/**
 * Sidebar network switch. Lists every Gloam network and lets the user pick the
 * active one. Live networks are selectable; `planned` ones render disabled with
 * a "Soon" badge, so the multichain roadmap is visible and honest without
 * offering a chain that cannot take writes yet. It auto-enables a network the
 * moment `networks.ts` marks it live. Full width of its container: the sidebar
 * on desktop (where the list flies out to the right so the notes have room),
 * the sheet on mobile (where it drops down).
 */
import { useEffect, useRef, useState } from "react";
import { MAINNET_ENABLED, allNetworks, isNetworkWritable } from "@/lib/networks";
import { useNetwork } from "./NetworkProvider";
import { TokenLogo } from "./TokenLogo";
import type { GloamNetwork } from "@/lib/networks";

/** One short line per network: what it holds. Same length and shape for every row. */
function assetLine(n: GloamNetwork): string {
  if (n.key === "robinhood-mainnet") return "USDG, $GLOAM, PONS and more";
  if (n.key === "tempo-mainnet") return "USDC.e, pathUSD, USDT0 and OUSD";
  if (n.key === "base-mainnet") return "USDC, EURC, USDT and ETH";
  if (n.key === "ethereum-mainnet") return "USDC, USDT, USDG, PYUSD, EURC and ETH";
  if (n.key === "elysium-mainnet") return "USDC";
  if (n.key === "elysium") return "Test USDC";
  if (n.key === "robinhood") return "Test ETH, stablecoins and stocks";
  if (n.key === "base") return "Test USDC, EURC and ETH";
  if (n.key === "ethereum") return "Test USDC, USDG, PYUSD, EURC and ETH";
  return "Test stablecoins";
}

export function NetworkSelector() {
  const { network, setNetworkKey, settled } = useNetwork();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const nets = allNetworks();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Only the network list closes: the phone menu around it (AppShell,
      // listening on window) stays open, as one Escape closes one layer.
      e.stopPropagation();
      setOpen(false);
      // The focused row is about to go: hand focus back so the keyboard keeps its place.
      trigger.current?.focus();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative w-full">
      <button
        ref={trigger}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={settled ? `Network: ${network.label}. Change network` : "Change network"}
        className={`flex h-[52px] w-full items-center gap-3 rounded-full pl-2 pr-4 text-left text-foreground transition-colors hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground/50 ${
          open ? "bg-surface-2" : "bg-surface"
        }`}
      >
        {settled ? (
          <TokenLogo id={network.family} symbol={network.label} size={34} />
        ) : (
          <span className="h-[34px] w-[34px] shrink-0 rounded-full bg-surface-2" aria-hidden />
        )}
        {/* Until this browser's network is read, a neutral line: never a testnet label that flips to mainnet. */}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[14px] font-medium leading-tight">
            {settled ? network.label : "Network"}
          </span>
          <span className="mt-0.5 block truncate text-[12px] leading-tight text-mute">
            {!settled
              ? "\u00a0"
              : network.testnet
                ? "Testnet"
                : "Mainnet"}
          </span>
        </span>
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          aria-hidden
          className={`shrink-0 text-mute transition-transform ${open ? "rotate-180" : ""}`}
        >
          <path
            d="m7 10 5 5 5-5"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Select network"
          className="absolute left-0 right-0 top-full z-50 mt-2 rounded-[18px] border border-line bg-panel p-1.5 shadow-pop [.gl-sidebar_&]:left-full [.gl-sidebar_&]:right-auto [.gl-sidebar_&]:top-0 [.gl-sidebar_&]:ml-5 [.gl-sidebar_&]:mt-0 [.gl-sidebar_&]:w-[300px]"
        >
          {(MAINNET_ENABLED
            ? [
                { title: "Mainnet", hint: "", list: nets.filter((n) => !n.testnet) },
                { title: "Testnet", hint: "", list: nets.filter((n) => n.testnet) },
              ]
            : [{ title: "Network", hint: "", list: nets }]
          ).map((group, gi) => (
            <div key={group.title} className={gi > 0 ? "mt-1 border-t border-line pt-1" : ""}>
              <p className="flex items-baseline justify-between px-2.5 pb-1 pt-2">
                <span className="t-eyebrow">{group.title}</span>
                {group.hint && <span className="text-[11.5px] text-mute">{group.hint}</span>}
              </p>
              {group.list.map((n) => {
                const active = n.key === network.key;
                const writable = isNetworkWritable(n);
                return (
                  <button
                    key={n.key}
                    type="button"
                    role="menuitemradio"
                    aria-checked={active}
                    aria-label={`${n.label} ${n.testnet ? "testnet" : "mainnet"}`}
                    disabled={!writable}
                    onClick={() => {
                      if (!writable) return;
                      setNetworkKey(n.key);
                      setOpen(false);
                    }}
                    className={`flex h-[52px] w-full items-center gap-3 rounded-xl px-2.5 text-left transition-colors ${
                      writable ? "hover:bg-surface" : "cursor-not-allowed opacity-60"
                    } ${active ? "bg-surface" : ""}`}
                  >
                    <TokenLogo id={n.family} symbol={n.label} size={30} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[14px] font-medium leading-tight text-foreground">
                        {n.label}
                        {n.status === "planned" && <span className="ml-2 text-[11px] font-medium text-mute">Soon</span>}
                      </span>
                      <span className="mt-0.5 block truncate text-[12px] leading-tight text-mute">{assetLine(n)}</span>
                    </span>
                    {active && (
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden className="shrink-0 text-foreground">
                        <path d="m5.5 12.5 4 4 9-9" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    )}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
