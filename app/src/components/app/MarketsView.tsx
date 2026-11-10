"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useLiveMarkets } from "@/hooks/useLiveMarkets";
import { useTradingSettings } from "@/hooks/useTradingSettings";
import { formatMark, formatUsd } from "@/lib/markets";
import { useNetwork } from "./NetworkProvider";
import { Sparkline } from "./Sparkline";
import { TokenLogo } from "./TokenLogo";
import { MarketChart } from "./MarketChart";

type Filter = "all" | "onchain" | "private" | "stocks";

const FILTERS: { id: Filter; label: string; hint: string }[] = [
  { id: "private", label: "Private-ready", hint: "Can be held in your private balance" },
  { id: "onchain", label: "Onchain", hint: "Live as a token on Robinhood Chain" },
  { id: "stocks", label: "Stocks", hint: "Tokenized equities" },
  { id: "all", label: "All markets", hint: "Everything on the watchlist" },
];

/**
 * Row grid. Mobile: logo, name, price stack, chart toggle. Desktop: logo,
 * name, trend, price, 24h, actions. The header row shares the desktop track.
 */
const ROW_GRID =
  "grid grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-[12px] sm:grid-cols-[auto_minmax(0,1.5fr)_minmax(0,1fr)_minmax(0,0.9fr)_minmax(0,0.7fr)_auto] sm:gap-5";

function fmtChange(n: number) {
  return `${n > 0 ? "+" : ""}${n.toFixed(2)}%`;
}

function changeTone(n: number) {
  return n > 0
    ? "text-[var(--chart-up)]"
    : n < 0
      ? "text-[var(--chart-down)]"
      : "text-mute";
}

/** Testnet-only markets. No mainnet memes mixed in. */
export function MarketsView() {
  const { network } = useNetwork();
  const router = useRouter();
  // Tokenized stock marks are a Robinhood Chain testnet product; Tempo and the
  // mainnets are payments, with no equities to list or trade. There the Markets
  // page does not exist, so anyone who lands here goes back to the portfolio.
  const isTempo = !network.stocks;
  useEffect(() => {
    if (isTempo) router.replace("/app");
  }, [isTempo, router]);

  const { settings } = useTradingSettings();
  const [q, setQ] = useState("");
  // The saved default filter (Settings), until one is picked here. Read each
  // render, since settings load after the first one.
  const [pickedKind, setKind] = useState<Filter | null>(null);
  const kind: Filter = pickedKind ?? settings.marketFilter;
  const [menuOpen, setMenuOpen] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const { data, isFetching, isError, refetch } = useLiveMarkets();
  // one array per response, so the memos and effects below re-run only when it changes
  const markets = useMemo(() => data?.markets ?? [], [data?.markets]);

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setMenuOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  const rows = useMemo(() => {
    return markets.filter((m) => {
      if (kind === "onchain" && !m.address) return false;
      if (kind === "private" && !m.privateReady) return false;
      if (kind === "stocks" && m.kind !== "stock") return false;
      if (!q.trim()) return true;
      const s = q.toLowerCase();
      return (
        m.symbol.toLowerCase().includes(s) || m.name.toLowerCase().includes(s)
      );
    });
  }, [q, kind, markets]);

  const activeFilter = FILTERS.find((f) => f.id === kind) ?? FILTERS[0];
  const price = (mark: number) =>
    settings.showUsd ? formatUsd(mark) : `$${formatMark(mark)}`;

  if (isTempo) {
    return (
      <div className="gl-card px-5 py-12 text-center text-[14px] text-mute">
        Redirecting…
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* control bar: filter dropdown + search */}
      <div className="flex flex-wrap items-center gap-2">
        <div ref={menuRef} className="relative">
          <button
            type="button"
            onClick={() => setMenuOpen((v) => !v)}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            className={`inline-flex h-11 items-center gap-2 rounded-xl border bg-panel pl-4 pr-3 text-[14px] text-foreground transition-colors hover:border-line-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground/50 ${
              menuOpen ? "border-line-strong" : "border-line"
            }`}
          >
            <span className="text-mute">Show</span>
            <span className="font-medium">{activeFilter.label}</span>
            <ChevronDown
              className={`text-mute transition-transform ${menuOpen ? "rotate-180" : ""}`}
            />
          </button>
          {menuOpen && (
            <div
              role="menu"
              className="absolute left-0 top-full z-30 mt-2 w-[280px] rounded-[18px] border border-line bg-panel p-1.5 shadow-pop"
            >
              {FILTERS.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={f.id === kind}
                  onClick={() => {
                    setKind(f.id);
                    setMenuOpen(false);
                  }}
                  className={`flex w-full items-start gap-3 rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-surface ${
                    f.id === kind ? "bg-surface" : ""
                  }`}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block text-[14px] font-medium text-foreground">
                      {f.label}
                    </span>
                    <span className="mt-0.5 block text-[12px] text-mute">
                      {f.hint}
                    </span>
                  </span>
                  {f.id === kind && <CheckIcon className="mt-1 text-foreground" />}
                </button>
              ))}
            </div>
          )}
        </div>

        <label className="relative min-w-0 flex-1 sm:max-w-xs">
          <span className="sr-only">Search markets</span>
          <SearchIcon className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-faint" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search markets"
            className="gl-input h-11 pl-10 text-[14px]"
          />
        </label>
        {isError && (
          <button
            type="button"
            onClick={() => void refetch()}
            className="btn btn-ghost btn-sm"
          >
            Retry
          </button>
        )}
      </div>

      <div className="gl-card overflow-hidden">
        {/* column header, desktop only */}
        <div
          className={`${ROW_GRID} border-b border-line px-5 py-3 max-sm:hidden`}
          aria-hidden
        >
          <span className="t-label col-span-2">Asset</span>
          <span className="t-label">Trend</span>
          <span className="t-label text-right">Price</span>
          <span className="t-label text-right">24h</span>
          <span className="w-[92px]" />
        </div>

        <ul>
          {rows.map((m) => {
            const open = expanded === m.id;
            const spark =
              m.spark && m.spark.length >= 2
                ? m.spark
                : m.mark > 0
                  ? [m.mark * 0.98, m.mark * 1.01, m.mark]
                  : [];
            const tradeHref = `/app/trade?market=${m.id}`;
            return (
              <li key={m.id} className="border-b border-line last:border-0">
                {/* whole row is the trade action; the chart toggle sits above it */}
                <div className="group relative transition-colors hover:bg-surface/70">
                  <Link
                    href={tradeHref}
                    className="absolute inset-0 z-0 focus-visible:outline-offset-[-2px]"
                    aria-label={`Open ${m.symbol} to trade`}
                  />
                  <div
                    className={`pointer-events-none relative z-[1] min-h-[68px] px-[16px] py-3 sm:px-5 ${ROW_GRID}`}
                  >
                    <TokenLogo id={m.id} symbol={m.symbol} size={36} />
                    <div className="min-w-0">
                      <p className="flex items-center gap-2">
                        <span className="text-[15px] font-medium text-foreground">
                          {m.symbol}
                        </span>
                        {m.privateReady && <PrivateChip />}
                      </p>
                      <p className="mt-0.5 truncate text-[13px] text-mute">
                        {m.name}
                      </p>
                    </div>
                    <div className="max-sm:hidden">
                      <Sparkline
                        points={spark}
                        up={m.change24h >= 0}
                        width={96}
                        height={32}
                      />
                    </div>
                    <p className="tnum text-right text-[15px] text-foreground max-sm:hidden">
                      {price(m.mark)}
                    </p>
                    <p
                      className={`tnum text-right text-[14px] max-sm:hidden ${changeTone(m.change24h)}`}
                    >
                      {fmtChange(m.change24h)}
                    </p>

                    {/* price + 24h stacked, mobile only */}
                    <div className="grid justify-items-end gap-0.5 sm:hidden">
                      <span className="tnum text-[15px] text-foreground">
                        {price(m.mark)}
                      </span>
                      <span className={`tnum text-[12px] ${changeTone(m.change24h)}`}>
                        {fmtChange(m.change24h)}
                      </span>
                    </div>

                    <div className="flex items-center justify-end gap-1 sm:w-[92px]">
                      <button
                        type="button"
                        onClick={() => setExpanded(open ? null : m.id)}
                        className={`pointer-events-auto relative z-10 grid h-10 w-10 place-items-center rounded-full transition-colors ${
                          open
                            ? "bg-ink text-on-ink"
                            : "text-mute hover:bg-surface-2 hover:text-foreground"
                        }`}
                        aria-label={open ? `Hide ${m.symbol} chart` : `Show ${m.symbol} chart`}
                        aria-expanded={open}
                      >
                        <ChartIcon />
                      </button>
                      <ChevronRight className="text-faint transition-transform group-hover:translate-x-0.5 group-hover:text-foreground max-sm:hidden" />
                    </div>
                  </div>
                </div>

                {open && (
                  <div className="border-t border-line bg-surface/50 px-[16px] pb-5 pt-4 sm:px-5">
                    <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-[13px] text-mute">
                          <span className="font-medium text-foreground">
                            {m.symbol}
                          </span>{" "}
                          {m.name}
                        </p>
                        <p className="tnum mt-1 text-[28px] font-light leading-none tracking-[-0.018em] text-foreground">
                          {price(m.mark)}
                          <span
                            className={`ml-2.5 align-middle text-[13px] font-normal tracking-normal ${changeTone(m.change24h)}`}
                          >
                            {fmtChange(m.change24h)}
                          </span>
                        </p>
                      </div>
                      <Link href={tradeHref} className="btn btn-ink btn-sm">
                        Trade {m.symbol}
                      </Link>
                    </div>
                    <MarketChart points={spark} up={m.change24h >= 0} />
                  </div>
                )}
              </li>
            );
          })}
          {rows.length === 0 &&
            (isFetching && markets.length === 0 ? (
              Array.from({ length: 5 }).map((_, i) => (
                <li
                  key={`sk-${i}`}
                  aria-hidden
                  className="flex min-h-[68px] items-center gap-3 border-b border-line px-5 last:border-0"
                >
                  <span className="h-9 w-9 rounded-[22%] bg-surface motion-safe:animate-pulse" />
                  <span className="grid gap-1.5">
                    <span className="h-3 w-14 rounded-full bg-surface motion-safe:animate-pulse" />
                    <span className="h-2.5 w-24 rounded-full bg-surface motion-safe:animate-pulse" />
                  </span>
                </li>
              ))
            ) : (
              <li className="px-5 py-14 text-center">
                <p className="text-[15px] text-foreground">No markets match.</p>
                <p className="mt-1 text-[13px] text-mute">
                  Try another filter or clear the search.
                </p>
              </li>
            ))}
        </ul>
      </div>
    </div>
  );
}

/** Marks a market that can be held in the private balance: the sealed tint. */
function PrivateChip() {
  return (
    <span className="inline-flex h-5 items-center gap-1 rounded-full bg-sealed-soft px-2 text-[11px] font-medium text-sealed">
      <svg width="9" height="9" viewBox="0 0 24 24" fill="none" aria-hidden>
        <rect x="4" y="10.5" width="16" height="10.5" rx="2.5" fill="currentColor" />
        <path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" stroke="currentColor" strokeWidth="2.6" />
      </svg>
      Private
    </span>
  );
}

function ChartIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M4 19V5m0 14h16M8 15l3.5-4 3 2.5L20 8"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ChevronRight({ className = "" }: { className?: string }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden
      className={className}
    >
      <path
        d="M9 6l6 6-6 6"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ChevronDown({ className = "" }: { className?: string }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden
      className={className}
    >
      <path
        d="m7 10 5 5 5-5"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CheckIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden
      className={`shrink-0 ${className}`}
    >
      <path
        d="m5.5 12.5 4 4 9-9"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function SearchIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden
      className={className}
    >
      <circle cx="11" cy="11" r="6.25" stroke="currentColor" strokeWidth="1.7" />
      <path d="m16 16 4 4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}
