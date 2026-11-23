"use client";

/**
 * The wallet control while Solana is the network picked, in WalletMenu's
 * places and shapes: the foot of the sidebar (`sidebar`) and the phone's top
 * bar (`compact`). Not connected, it lists the Solana wallets in this browser;
 * connected, the wallet and its address, with Portfolio, Pay privately,
 * Settings and Sign out (which ends staying signed in on this device:
 * lib/solanaRings/keep).
 */
import { useEffect, useRef, useState } from "react";
import { IntentLink } from "@/components/IntentLink";
import { Spinner } from "@/components/ui/Spinner";
import { SOLANA_NET_LABEL } from "./SolanaParts";
import { shortSol, useSolana } from "./SolanaAccount";
import { ExitGlyph, GearGlyph, GridGlyph, SendGlyph } from "./MenuGlyphs";

const glyph = { width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", "aria-hidden": true } as const;

function WalletIcon({ src, size }: { src: string; size: number }) {
  return (
    <span className="grid shrink-0 place-items-center overflow-hidden rounded-[10px] bg-white ring-1 ring-line" style={{ width: size, height: size }}>
      {/* eslint-disable-next-line @next/next/no-img-element -- the wallet's own data-URL icon */}
      {src && <img src={src} alt="" width={size} height={size} className="h-full w-full object-cover" />}
    </span>
  );
}

export function SolanaWalletMenu({ variant }: { variant?: "sidebar" | "compact" | "inline" }) {
  const sol = useSolana();
  const root = useRef<HTMLDivElement>(null);
  const [auto, setAuto] = useState<"sidebar" | "compact" | "inline" | null>(null);
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const el = root.current;
    setAuto(!el ? "inline" : el.closest(".gl-sidebar") ? "sidebar" : el.closest(".gl-mobilebar") ? "compact" : "inline");
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const shape = variant ?? auto;
  const sidebar = shape === "sidebar";
  const compact = shape === "compact";
  if (!sol || !shape) {
    return (
      <div ref={root} className={compact ? "inline-flex" : undefined}>
        <span aria-hidden className="block h-11 w-full rounded-full bg-surface [.gl-mobilebar_&]:h-9 [.gl-mobilebar_&]:w-[92px]" />
      </div>
    );
  }

  const menuPlace = sidebar ? "bottom-0 left-full ml-5 w-[288px]" : "right-0 top-full mt-2 w-[288px] max-w-[calc(100vw-32px)]";
  const connecting = sol.task?.kind === "connect";

  if (!sol.main) {
    return (
      <div ref={root} className={`relative ${sidebar ? "w-full" : "inline-flex"}`}>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-haspopup="menu"
          className={compact ? "btn btn-ink btn-sm" : sidebar ? "btn btn-ink btn-block" : "btn btn-ink btn-lg btn-block"}
        >
          {connecting && <Spinner />}
          {compact ? "Connect" : "Connect Solana wallet"}
        </button>
        {open && (
          <div role="menu" aria-label="Solana wallets" className={`absolute z-50 rounded-[18px] border border-line bg-panel p-1.5 shadow-pop ${menuPlace}`}>
            <p className="px-2.5 pb-1 pt-2 text-[12.5px] text-mute">Solana wallets in this browser</p>
            {sol.wallets.length === 0 ? (
              <p className="px-2.5 pb-2.5 pt-1 text-[13px] leading-relaxed text-soft">No Solana wallet here. Install Phantom, Solflare or Backpack, then reload.</p>
            ) : (
              sol.wallets.map((w) => (
                <button
                  key={w.name}
                  type="button"
                  role="menuitem"
                  disabled={Boolean(sol.task)}
                  onClick={() => {
                    setOpen(false);
                    void sol.connect(w);
                  }}
                  className="flex h-12 w-full items-center gap-3 rounded-xl px-2.5 text-left text-[14px] text-foreground transition-colors hover:bg-surface disabled:opacity-60"
                >
                  <WalletIcon src={w.icon} size={28} />
                  <span className="min-w-0 flex-1 truncate">{w.name}</span>
                </button>
              ))
            )}
          </div>
        )}
      </div>
    );
  }

  const { wallet, account } = sol.main;
  return (
    <div ref={root} className={`relative ${sidebar ? "w-full" : "inline-flex"}`}>
      {sidebar ? (
        <button
          type="button"
          onClick={() => setOpen((x) => !x)}
          aria-expanded={open}
          aria-haspopup="menu"
          className={`flex min-h-[52px] w-full items-center gap-3 rounded-[14px] px-2 py-2 text-left transition-colors hover:bg-surface ${open ? "bg-surface" : ""}`}
        >
          <WalletIcon src={wallet.icon} size={34} />
          <span className="min-w-0 flex-1">
            <span className="tnum block truncate text-[14px] font-medium leading-tight text-foreground">{shortSol(account.address)}</span>
            <span className="mt-0.5 block truncate text-[12px] leading-tight text-mute">Solana</span>
          </span>
          <svg {...glyph} className="shrink-0 text-faint">
            <path d="M8.5 9.5 12 6l3.5 3.5M8.5 14.5 12 18l3.5-3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      ) : (
        <button
          type="button"
          onClick={() => setOpen((x) => !x)}
          aria-expanded={open}
          aria-haspopup="menu"
          className={`inline-flex h-10 items-center gap-2 rounded-full border bg-panel pl-1 pr-3 text-foreground transition-colors hover:border-line-strong ${open ? "border-line-strong" : "border-line"}`}
        >
          <WalletIcon src={wallet.icon} size={30} />
          <span className="tnum whitespace-nowrap text-[13px] font-medium">{shortSol(account.address)}</span>
        </button>
      )}

      {open && (
        <div role="menu" aria-label="Wallet" className={`absolute z-50 rounded-[18px] border border-line bg-panel p-1.5 shadow-pop ${menuPlace}`}>
          <div className="flex items-center gap-3 px-2.5 pb-3 pt-2.5">
            <WalletIcon src={wallet.icon} size={38} />
            <div className="min-w-0 flex-1">
              <p className="tnum truncate text-[14px] font-medium text-foreground">{shortSol(account.address)}</p>
              <p className="mt-0.5 truncate text-[12px] text-mute">
                {wallet.name}, Solana {SOLANA_NET_LABEL}
              </p>
            </div>
            <button
              type="button"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(account.address);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1400);
                } catch {
                  /* ignore */
                }
              }}
              className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-mute transition-colors hover:bg-surface hover:text-foreground"
              aria-label={copied ? "Address copied" : "Copy address"}
              title={copied ? "Copied" : "Copy address"}
            >
              {copied ? (
                <svg {...glyph}>
                  <path d="m5.5 12.5 4 4 9-9" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              ) : (
                <svg {...glyph}>
                  <rect x="8.5" y="8.5" width="11" height="11" rx="2.5" stroke="currentColor" strokeWidth="1.6" />
                  <path d="M15.5 8.5V6.5a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2" stroke="currentColor" strokeWidth="1.6" />
                </svg>
              )}
            </button>
          </div>
          <div className="mx-1 h-px bg-line" />
          <div className="py-1">
            {[
              { href: "/app", label: "Portfolio", icon: <GridGlyph /> },
              { href: "/app/vault?tab=move", label: "Pay privately", icon: <SendGlyph /> },
              { href: "/app/settings", label: "Settings", icon: <GearGlyph /> },
            ].map((l) => (
              <IntentLink
                key={l.href}
                href={l.href}
                role="menuitem"
                onClick={() => setOpen(false)}
                className="flex h-10 items-center gap-3 rounded-xl px-2.5 text-[14px] text-foreground transition-colors hover:bg-surface"
              >
                <span className="text-mute">{l.icon}</span>
                {l.label}
              </IntentLink>
            ))}
          </div>
          <div className="mx-1 h-px bg-line" />
          <div className="pt-1">
            <button
              type="button"
              role="menuitem"
              disabled={Boolean(sol.task)}
              onClick={() => {
                setOpen(false);
                sol.disconnect();
              }}
              className="flex h-10 w-full items-center gap-3 rounded-xl px-2.5 text-[14px] text-mute transition-colors hover:bg-surface hover:text-foreground"
            >
              <ExitGlyph />
              Sign out
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
