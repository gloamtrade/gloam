"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { Suspense, useEffect, useState } from "react";
import { Logo } from "@/components/Logo";
import { WalletMenu } from "./WalletMenu";
import { AutoSwitchNetwork } from "./AutoSwitchNetwork";
import { WelcomeModal } from "./WelcomeModal";
import { PasskeyGate } from "./PasskeyGate";
import { NetworkSelector } from "./NetworkSelector";
import { useNetwork } from "./NetworkProvider";
import { FeeRiseNotice } from "./FeeRiseNotice";
import { StocksLiveNotice } from "./StocksLiveNotice";
import { TestFundsNotice } from "./TestFundsNotice";
import { VaultNavGroup, VaultNavGroupStatic, navActiveFill } from "./VaultNavGroup";

type NavItem = {
  href: string;
  label: string;
  icon: ReactNode;
  exact?: boolean;
  robinhoodOnly?: boolean;
  /** Vault lists its actions under it (VaultNavGroup). */
  group?: "vault";
};

const ic = "h-[18px] w-[18px] shrink-0";

const nav: NavItem[] = [
  {
    href: "/app",
    label: "Portfolio",
    exact: true,
    icon: (
      <svg className={ic} viewBox="0 0 24 24" fill="none" aria-hidden>
        <rect x="3.75" y="3.75" width="7" height="7" rx="2" stroke="currentColor" strokeWidth="1.5" />
        <rect x="13.25" y="3.75" width="7" height="7" rx="2" stroke="currentColor" strokeWidth="1.5" />
        <rect x="3.75" y="13.25" width="7" height="7" rx="2" stroke="currentColor" strokeWidth="1.5" />
        <rect x="13.25" y="13.25" width="7" height="7" rx="2" stroke="currentColor" strokeWidth="1.5" />
      </svg>
    ),
  },
  {
    href: "/app/vault",
    label: "Vault",
    group: "vault",
    icon: (
      <svg className={ic} viewBox="0 0 24 24" fill="none" aria-hidden>
        <rect x="3.75" y="5.75" width="16.5" height="13.5" rx="3" stroke="currentColor" strokeWidth="1.5" />
        <circle cx="12" cy="12.5" r="2.75" stroke="currentColor" strokeWidth="1.5" />
        <path d="M12 9.75V8M7 19.25v1M17 19.25v1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    href: "/app/payroll",
    label: "Payroll",
    icon: (
      <svg className={ic} viewBox="0 0 24 24" fill="none" aria-hidden>
        <circle cx="9" cy="8.25" r="3.25" stroke="currentColor" strokeWidth="1.5" />
        <path d="M3.5 19.25c.6-3 2.8-4.75 5.5-4.75s4.9 1.75 5.5 4.75" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        <path d="M16 6.5h4.5M16 10h4.5M17.5 13.5h3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    href: "/app/markets",
    label: "Markets",
    robinhoodOnly: true,
    icon: (
      <svg className={ic} viewBox="0 0 24 24" fill="none" aria-hidden>
        <path d="M4 17l4.5-5 3.5 3 7-8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M15 7h4v4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
  {
    href: "/app/disclose",
    label: "Prove",
    icon: (
      <svg className={ic} viewBox="0 0 24 24" fill="none" aria-hidden>
        <path d="M12 3.5l7 3v5.25c0 4.1-2.9 7.6-7 8.75-4.1-1.15-7-4.65-7-8.75V6.5l7-3z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
        <path d="M9 12.25l2.1 2.1L15.25 10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
];

const settingsIcon = (
  <svg className={ic} viewBox="0 0 24 24" fill="none" aria-hidden>
    <circle cx="12" cy="12" r="2.75" stroke="currentColor" strokeWidth="1.5" />
    <path
      d="M12 3.75v2M12 18.25v2M20.25 12h-2M5.75 12h-2M17.83 6.17l-1.41 1.41M7.58 16.42l-1.41 1.41M17.83 17.83l-1.41-1.41M7.58 7.58L6.17 6.17"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
    />
  </svg>
);
const docsIcon = (
  <svg className={ic} viewBox="0 0 24 24" fill="none" aria-hidden>
    <path d="M5.75 4.75h9.5l3 3v11.5a1 1 0 0 1-1 1H5.75a1 1 0 0 1-1-1V5.75a1 1 0 0 1 1-1z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    <path d="M8.5 11h7M8.5 14.5h7M8.5 8h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
);

function isActive(pathname: string, href: string, exact?: boolean) {
  if (exact) return pathname === href;
  const pathOnly = href.split("?")[0] ?? href;
  return pathname === pathOnly || pathname.startsWith(`${pathOnly}/`);
}

function NavLink({
  item,
  active,
  onClick,
  size = "desktop",
}: {
  item: { href: string; label: string; icon: ReactNode };
  active: boolean;
  onClick?: () => void;
  size?: "desktop" | "sheet";
}) {
  return (
    <Link
      href={item.href}
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={`flex h-10 items-center gap-3 rounded-xl px-3 text-[14px] transition-colors ${
        active
          ? `${navActiveFill(size)} font-medium text-foreground`
          : "text-mute hover:bg-surface/70 hover:text-foreground"
      }`}
    >
      {item.icon}
      {item.label}
    </Link>
  );
}

/** The product nav, shared by the sidebar and the phone sheet. */
function ProductNav({
  items,
  pathname,
  size,
  onNavigate,
}: {
  items: NavItem[];
  pathname: string;
  size: "desktop" | "sheet";
  onNavigate?: () => void;
}) {
  return (
    <>
      {items.map((item) =>
        item.group === "vault" ? (
          <Suspense key={item.href} fallback={<VaultNavGroupStatic icon={item.icon} size={size} />}>
            <VaultNavGroup icon={item.icon} size={size} onNavigate={onNavigate} />
          </Suspense>
        ) : (
          <NavLink
            key={item.href}
            item={item}
            active={isActive(pathname, item.href, item.exact)}
            onClick={onNavigate}
            size={size}
          />
        )
      )}
    </>
  );
}

/**
 * Phones and tablets: the top-level places as a tab bar along the bottom, in
 * reach of a thumb and always in view (Apple's guidance for a tab bar: a few
 * top-level places, no More tab). The menu at the top keeps the rest:
 * Vault's actions, Settings, Docs and the network.
 */
function TabBar({ items, pathname }: { items: NavItem[]; pathname: string }) {
  return (
    <nav aria-label="App tabs" className="gl-tabbar fixed inset-x-0 bottom-0 z-30 border-t border-line bg-background/92 backdrop-blur-xl">
      <ul className="mx-auto flex max-w-[640px] items-stretch justify-around px-2">
        {items.map((item) => {
          const active = isActive(pathname, item.href, item.exact);
          return (
            <li key={item.href} className="min-w-0 flex-1">
              <Link
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={`flex h-14 flex-col items-center justify-center gap-1 rounded-xl text-[11px] leading-none transition-colors ${
                  active ? "font-medium text-foreground" : "text-mute hover:text-foreground"
                }`}
              >
                {item.icon}
                <span className="max-w-full truncate">{item.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/**
 * The app frame: a floating sidebar on desktop (the app.zama.org pattern), a
 * slim top bar with a sheet on mobile, and a calm page header.
 */
export function AppShell({
  children,
  title,
  subtitle,
  subtitleTempo,
  actions,
}: {
  children: ReactNode;
  title: string;
  subtitle?: string;
  /** Optional Tempo-specific subtitle, so the payments framing leads there. */
  subtitleTempo?: string;
  /** Optional controls shown at the right of the page header. */
  actions?: ReactNode;
}) {
  const pathname = usePathname();
  const { network, settled: networkSettled } = useNetwork();
  const [open, setOpen] = useState(false);

  // Tokenized-stock Markets only exists on Robinhood Chain testnet. On Tempo
  // and on the mainnets the product is private payments, so it drops out. It
  // waits for this browser's network, so a mainnet visitor never sees it flash.
  const isTempo = network.family === "tempo";
  const navItems = nav.filter((item) => !(item.robinhoodOnly && (!networkSettled || !network.stocks)));
  const shownSubtitle = isTempo && subtitleTempo ? subtitleTempo : subtitle;

  useEffect(() => {
    void import("@/lib/track").then(({ track }) => {
      track("app_view", { title: title.slice(0, 40) });
    });
  }, [pathname, title]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = "";
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="gloam-app relative flex min-h-full flex-col bg-background">
      <WelcomeModal />
      <PasskeyGate />
      <AutoSwitchNetwork />

      {/* desktop sidebar */}
      <aside
        className="gl-sidebar fixed bottom-3 left-3 top-3 z-40 w-[248px] flex-col rounded-[20px] border border-line bg-panel p-3 shadow-card"
        aria-label="App"
      >
        <div className="flex items-center justify-between px-2 pb-5 pt-2">
          <Logo size={24} />
        </div>
        <NetworkSelector />
        <nav className="-mx-1 mt-4 flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-1 pb-3" aria-label="Product">
          <ProductNav items={navItems} pathname={pathname} size="desktop" />
        </nav>
        <div className="flex flex-col gap-0.5">
          <NavLink
            item={{ href: "/app/settings", label: "Settings", icon: settingsIcon }}
            active={isActive(pathname, "/app/settings")}
          />
          <NavLink
            item={{ href: "/docs", label: "Docs", icon: docsIcon }}
            active={false}
          />
          <div className="mt-2 border-t border-line pt-3">
            <WalletMenu />
          </div>
        </div>
      </aside>

      {/* mobile top bar */}
      <header className="gl-mobilebar sticky top-0 z-40 border-b border-line bg-background/90 backdrop-blur-xl">
        <div className="flex h-14 items-center justify-between gap-2 px-4">
          {/* Under 360px wide the mark alone, so the wallet and menu still fit on one line. */}
          <Logo size={22} className="max-[359px]:[&>span]:hidden" />
          <div className="flex items-center gap-1.5">
            <WalletMenu />
            <button
              type="button"
              className="grid h-10 w-10 place-items-center rounded-full text-foreground transition-colors hover:bg-surface"
              aria-label={open ? "Close menu" : "Open menu"}
              aria-expanded={open}
              onClick={() => setOpen((v) => !v)}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
                {open ? (
                  <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                ) : (
                  <path d="M4 8h16M4 16h16" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                )}
              </svg>
            </button>
          </div>
        </div>
        {open && (
          <div className="h-[calc(100dvh-3.5rem)] overflow-y-auto border-t border-line bg-background px-4 pb-8 pt-4">
            <NetworkSelector />
            <nav className="mt-4 flex flex-col gap-0.5" aria-label="Product mobile">
              <ProductNav items={navItems} pathname={pathname} size="sheet" onNavigate={() => setOpen(false)} />
              <NavLink
                item={{ href: "/app/settings", label: "Settings", icon: settingsIcon }}
                active={isActive(pathname, "/app/settings")}
                onClick={() => setOpen(false)}
                size="sheet"
              />
              <NavLink
                item={{ href: "/docs", label: "Docs", icon: docsIcon }}
                active={false}
                onClick={() => setOpen(false)}
              />
            </nav>
            <Link
              href="/"
              onClick={() => setOpen(false)}
              className="mt-5 block text-[14px] text-mute hover:text-foreground"
            >
              Back to gloam.trade
            </Link>
          </div>
        )}
      </header>

      <TabBar items={navItems} pathname={pathname} />

      <div className="gl-tabbar-space flex flex-1 flex-col lg:pl-[272px]">
        <main className="mx-auto w-full max-w-[1120px] flex-1 px-4 pb-16 pt-5 sm:px-8 sm:pt-7">
          <FeeRiseNotice />
          <TestFundsNotice />
          <Suspense fallback={null}>
            <StocksLiveNotice />
          </Suspense>
          {/* no fade on the title: it paints with the page, not after the app's JavaScript frees the phone */}
          <div className="gl-pagehead mb-6 gap-4 sm:mb-8">
            <div>
              <h1 className="t-display-m text-foreground">{title}</h1>
              {shownSubtitle && (
                <p className="mt-2 max-w-[60ch] text-[15px] leading-relaxed text-mute">
                  {shownSubtitle}
                </p>
              )}
            </div>
            {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
          </div>
          <div className="rise rise-1">{children}</div>
        </main>

        <footer className="mx-auto w-full max-w-[1120px] px-4 pb-8 sm:px-8">
          <div className="flex flex-col gap-3 border-t border-line pt-5 text-[12.5px] text-mute sm:flex-row sm:items-center sm:justify-between">
            <p>
              {!networkSettled
                ? "Gloam. Not investment, legal or tax advice."
                : !network.testnet
                ? `Gloam on ${network.label} mainnet. Not investment, legal or tax advice.`
                : isTempo
                  ? "Gloam on Tempo testnet. Private stablecoin payments for people and agents."
                  : `Gloam on ${network.label} testnet. Not investment, legal or tax advice.`}
            </p>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <Link href="/docs/testnet" className="hover:text-foreground">
                Testnet guide
              </Link>
              <Link href="/app/settings#help" className="hover:text-foreground">
                Help
              </Link>
              <Link href="/privacy" className="hover:text-foreground">
                Privacy
              </Link>
              <Link href="/terms" className="hover:text-foreground">
                Terms
              </Link>
              <Link href="/cookies" className="hover:text-foreground">
                Cookies
              </Link>
              <a href="https://t.me/gloamhq" target="_blank" rel="noreferrer" className="hover:text-foreground">
                Telegram
              </a>
              <a href="https://x.com/gloamtrade" target="_blank" rel="noreferrer" className="hover:text-foreground">
                X
              </a>
            </div>
          </div>
        </footer>
      </div>
    </div>
  );
}
