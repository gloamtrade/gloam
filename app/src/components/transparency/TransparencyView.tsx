"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { formatUnits, zeroAddress } from "viem";
import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";
import { FlowField } from "@/components/ui/FlowField";
import { SealedField } from "@/components/ui/SealedField";
import { SealDots } from "@/components/ui/SealDots";
import { TokenLogo } from "@/components/app/TokenLogo";
import {
  NETWORK_KEYS,
  defaultNetworkKey,
  getNetwork,
  isNetworkKey,
  networkName,
  type NetworkKey,
} from "@/lib/networks";
import {
  cachedLedger,
  loadLedger,
  type Ledger,
  type PublicEvent,
  type VaultHolding,
} from "./ledger";
import { NetworkPicker } from "./NetworkPicker";
import { ArrowUpRight } from "@/components/ui/ArrowUpRight";
import { swapTokenPrice } from "@/lib/vaultAssets";
import { vaultSwapRouter } from "@/lib/vaultSwap";

/* ---------------------------------------------------------------- data */

type NetState = { ledger: Ledger | null; error: string | null; progress: number; refreshing: boolean; resuming: boolean };
const EMPTY: NetState = { ledger: null, error: null, progress: 0, refreshing: false, resuming: false };
/** After a pass that read only part of the vault, the next ones start this long after (then the person can ask). */
const RESUME_AFTER_MS = [2_000, 5_000, 10_000, 20_000, 30_000];

function friendlyError(key: NetworkKey): string {
  return `Could not reach ${networkName(getNetwork(key))} just now. Public nodes sometimes slow down or limit requests, so try again in a moment.`;
}

/** Reads the ledger for the shown network, then warms the other one. */
function useLedger(key: NetworkKey | null) {
  const [states, setStates] = useState<Record<NetworkKey, NetState>>(
    () => Object.fromEntries(NETWORK_KEYS.map((k) => [k, EMPTY])) as Record<NetworkKey, NetState>
  );
  const [nonce, setNonce] = useState(0);
  const forceNext = useRef(false);
  // Passes in a row that read only part of the vault, per network.
  const resumes = useRef(new Map<NetworkKey, number>());

  useEffect(() => {
    if (!key) return;
    let live = true;
    let resumeTimer: number | undefined;
    const force = forceNext.current;
    forceNext.current = false;
    const patch = (p: Partial<NetState>) => {
      if (live) setStates((s) => ({ ...s, [key]: { ...s[key], ...p } }));
    };
    // Anything read earlier in this tab shows straight away while it refreshes.
    void Promise.resolve().then(() => {
      const hit = cachedLedger(key);
      if (hit) patch({ ledger: hit, refreshing: true });
    });
    loadLedger(key, { force, onProgress: (progress) => patch({ progress }) })
      .then((ledger) => {
        // Part of it read: show that, and pick up where it stopped on its own.
        const tries = ledger.incomplete ? (resumes.current.get(key) ?? 0) : 0;
        resumes.current.set(key, ledger.incomplete ? tries + 1 : 0);
        const again = ledger.incomplete && tries < RESUME_AFTER_MS.length;
        patch({ ledger, error: null, refreshing: false, progress: 1, resuming: Boolean(again) });
        if (again && live) resumeTimer = window.setTimeout(() => setNonce((x) => x + 1), RESUME_AFTER_MS[tries]);
        // the other chain on the same side (testnet or mainnet)
        const other = NETWORK_KEYS.find((k) => k !== key && getNetwork(k).testnet === getNetwork(key).testnet);
        if (other) {
          void loadLedger(other).catch(() => {
            /* read again when opened */
          });
        }
      })
      .catch(() => patch({ error: friendlyError(key), refreshing: false, resuming: false }));
    return () => {
      live = false;
      window.clearTimeout(resumeTimer);
    };
  }, [key, nonce]);

  const state = key ? (states[key] ?? EMPTY) : EMPTY;
  return {
    ...state,
    refresh: () => {
      if (!key) return;
      forceNext.current = true;
      resumes.current.set(key, 0);
      setStates((s) => ({ ...s, [key]: { ...s[key], refreshing: true, error: null, progress: 0 } }));
      setNonce((n) => n + 1);
    },
  };
}

type Market = { id: string; source: string; mark: number; address?: string };
type Prices = {
  ethUsd: number | null;
  /** Live marks by token address (the markets feed); for a stock this is a share price, not a token price. */
  byAddress: Map<string, number>;
  markets: Market[];
  /**
   * The server's USD by token address (/api/token-marks): $GLOAM, the tokens a
   * private swap lands in on Robinhood Chain (cbBTC and the rest; a stock falls
   * back to it when its live mark or multiplier is missing), and BDX on Base and
   * Ethereum (stablecoins there are $1, and EURC stays unpriced).
   */
  tokenMarks: Map<string, number>;
};

/**
 * USD marks the app already uses (/api/markets), plus the server's prices for
 * the tokens above, so the browser asks no price API; stablecoins count as $1.
 * `waiting` stays true for a few seconds only, so a slow quote feed never holds
 * the page: the total then shows what is priced and says what is not.
 */
function usePrices(): { prices: Prices | null; waiting: boolean } {
  const [prices, setPrices] = useState<Prices | null>(null);
  const [waiting, setWaiting] = useState(true);
  useEffect(() => {
    const t = window.setTimeout(() => setWaiting(false), 6000);
    return () => window.clearTimeout(t);
  }, []);
  useEffect(() => {
    let live = true;
    const markets = fetch("/api/markets", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null) as Promise<{ ethUsd?: number | null; markets?: Partial<Market>[] } | null>;
    // display only: a slow price read never holds the other prices back
    const tokenPrices = fetch("/api/token-marks", { signal: AbortSignal.timeout(5_000) })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null) as Promise<{ marks?: Record<string, unknown> } | null>;
    void Promise.all([markets, tokenPrices]).then(([d, t]) => {
      if (!live) return;
      const byAddress = new Map<string, number>();
      const list: Market[] = [];
      for (const m of d?.markets ?? []) {
        if (typeof m.mark !== "number" || !(m.mark > 0)) continue;
        if (m.address) byAddress.set(m.address.toLowerCase(), m.mark);
        if (typeof m.id === "string" && typeof m.source === "string") {
          list.push({ id: m.id, source: m.source, mark: m.mark, ...(m.address ? { address: m.address } : {}) });
        }
      }
      const tokenMarks = new Map<string, number>();
      for (const [address, usd] of Object.entries(t?.marks ?? {})) {
        if (typeof usd === "number" && usd > 0) tokenMarks.set(address.toLowerCase(), usd);
      }
      setPrices({ ethUsd: typeof d?.ethUsd === "number" ? d.ethUsd : null, byAddress, markets: list, tokenMarks });
    });
    return () => {
      live = false;
    };
  }, []);
  return { prices, waiting: waiting && prices == null };
}

/* ---------------------------------------------------------------- format */

function units(raw: string, decimals: number): number {
  try {
    return Number(formatUnits(BigInt(raw), decimals));
  } catch {
    return 0;
  }
}

function fmtAmount(n: number, stable: boolean): string {
  if (n === 0) return "0";
  if (n > 0 && n < 0.0001) return "<0.0001";
  return n.toLocaleString("en-US", { maximumFractionDigits: stable ? 2 : 4 });
}

const usdFmt = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });

function fmtUsd(n: number): string {
  if (n > 0 && n < 0.01) return "<$0.01";
  return usdFmt.format(n);
}

/**
 * A holding's dollar value, priced as the server's figures price it
 * (lib/onchainMetrics usdOf): stablecoins $1, ETH and WETH at ETH's price, a
 * Robinhood Chain stock at its share price times uiMultiplier / 1e18 (never the
 * share price alone), anything else at its live mark or the server's price. Null
 * means no price: left out of the total and named, never counted as $0.
 */
function usdFor(h: VaultHolding, chainId: number, prices: Prices | null): number | null {
  const amount = units(h.raw, h.decimals);
  if (h.stable) return amount;
  if (!prices) return null;
  if (!h.address || h.id === "weth") return prices.ethUsd != null ? amount * prices.ethUsd : null;
  if (chainId === 4663 && h.kind === "stock") {
    const mult = h.uiMultiplier ? BigInt(h.uiMultiplier) : null;
    const p = swapTokenPrice(chainId, { id: h.id, kind: h.kind }, prices.markets, mult, prices.tokenMarks.get(h.address.toLowerCase()));
    return p != null ? amount * p : null;
  }
  const mark = prices.byAddress.get(h.address.toLowerCase()) ?? prices.tokenMarks.get(h.address.toLowerCase());
  return mark != null ? amount * mark : null;
}

const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

function ago(ts: number): string {
  const s = Math.round(ts - Date.now() / 1000);
  const abs = Math.abs(s);
  if (abs < 60) return "just now";
  if (abs < 3600) return rtf.format(Math.round(s / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(s / 3600), "hour");
  if (abs < 86400 * 30) return rtf.format(Math.round(s / 86400), "day");
  return new Date(ts * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function fullDate(ts: number): string {
  return new Date(ts * 1000).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

const intFmt = new Intl.NumberFormat("en-US");

/* ---------------------------------------------------------------- icons */

function CheckMark({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M5 12.5l4.2 4.2L19 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function LockIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="4.5" y="10.5" width="15" height="10" rx="2.5" stroke="currentColor" strokeWidth="1.9" />
      <path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
    </svg>
  );
}

function EyeIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M2.5 12s3.5-6.5 9.5-6.5S21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
      <circle cx="12" cy="12" r="2.75" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  );
}

function KindIcon({ kind }: { kind: PublicEvent["kind"] }) {
  const path =
    kind === "deposit"
      ? "M12 4v11m0 0l-4.5-4.5M12 15l4.5-4.5M5 19.5h14"
      : kind === "cashout"
        ? "M12 15V4m0 0L7.5 8.5M12 4l4.5 4.5M5 19.5h14"
        : kind === "trade"
          ? "M7 7h11m0 0l-3.5-3.5M18 7l-3.5 3.5M17 17H6m0 0l3.5-3.5M6 17l3.5 3.5"
          : null;
  const sealed = kind === "transfer" || kind === "trade";
  return (
    <span
      aria-hidden
      className={`grid h-9 w-9 shrink-0 place-items-center rounded-full ${
        sealed ? "bg-sealed-soft text-sealed" : "bg-surface text-soft"
      }`}
    >
      {path ? (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
          <path d={path} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : (
        <LockIcon size={14} />
      )}
    </span>
  );
}

function EthGlyph({ size }: { size: number }) {
  return (
    <span
      aria-hidden
      className="inline-grid shrink-0 place-items-center rounded-[30%] bg-ink text-on-ink"
      style={{ width: size, height: size }}
    >
      <svg width={size * 0.5} height={size * 0.5} viewBox="0 0 24 24" fill="none">
        <path d="M12 2.5l6 9.75-6 3.5-6-3.5 6-9.75z" fill="currentColor" />
        <path d="M6 13.6l6 3.5 6-3.5-6 8.4-6-8.4z" fill="currentColor" opacity="0.7" />
      </svg>
    </span>
  );
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        } catch {
          /* clipboard unavailable */
        }
      }}
      aria-label={copied ? `${label} copied` : `Copy ${label}`}
      className="inline-flex h-10 shrink-0 items-center gap-1.5 rounded-full px-3 text-[12.5px] font-medium text-mute transition-colors hover:bg-surface hover:text-foreground"
    >
      {copied ? (
        <CheckMark />
      ) : (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
          <rect x="8.5" y="8.5" width="11" height="11" rx="2.5" stroke="currentColor" strokeWidth="1.5" />
          <path d="M15.5 8.5V6.5a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      )}
      <span aria-live="polite">{copied ? "Copied" : "Copy"}</span>
    </button>
  );
}

/* ---------------------------------------------------------------- pieces */

function HoldingsCard({ ledger, prices, waiting }: { ledger: Ledger; prices: Prices | null; waiting: boolean }) {
  const n = getNetwork(ledger.network);
  const rows = ledger.holdings.map((h) => ({ h, amount: units(h.raw, h.decimals), usd: usdFor(h, n.chainId, prices) }));
  const held = rows
    .filter((r) => r.amount > 0)
    .sort((a, b) => (b.usd ?? -1) - (a.usd ?? -1) || b.amount - a.amount);
  // Only what Add lists counts as "also accepted"; a token only a swap lands in shows while held.
  const empty = rows.filter((r) => r.amount === 0 && r.h.listed !== false);
  const total = held.reduce((s, r) => s + (r.usd ?? 0), 0);
  const unpriced = held.filter((r) => r.usd == null);
  const pricesLoading = waiting && unpriced.length > 0;

  return (
    <div className="gl-card relative overflow-hidden p-5 sm:p-6">
      <SealedField tone="soft" />
      <div className="relative">
        <div className="flex items-center justify-between gap-3">
          <p className="text-[13px] text-mute">Held in the vault</p>
          <span className="inline-flex items-center gap-1.5 text-[12.5px] text-mute">
            <EyeIcon size={12} />
            Public
          </span>
        </div>
        <p className="t-display-m tnum mt-3">
          {pricesLoading ? (
            <span className="inline-block h-9 w-40 rounded-lg bg-surface-2 align-middle motion-safe:animate-pulse" aria-label="Loading prices" />
          ) : unpriced.length === held.length && held.length > 0 && !prices ? (
            <span className="text-faint">Prices loading</span>
          ) : (
            fmtUsd(total)
          )}
        </p>
        <p className="mt-1.5 text-[13px] leading-relaxed text-mute">
          Everyone&apos;s private balances on {networkName(n)}, added together. Nobody can
          split it back into one person&apos;s share.
        </p>

        {held.length > 0 ? (
          <ul className="mt-5 divide-y divide-line border-y border-line">
            {held.map(({ h, amount, usd }) => (
              <li key={h.id} className="flex min-h-[56px] items-center gap-3 py-2">
                {h.address ? <TokenLogo id={h.id} symbol={h.symbol} size={30} /> : <EthGlyph size={30} />}
                <span className="min-w-0 flex-1">
                  <span className="tnum block truncate text-[15px] text-foreground">
                    {fmtAmount(amount, h.stable)} <span className="text-mute">{h.symbol}</span>
                  </span>
                </span>
                <span className="tnum shrink-0 text-right text-[14px] text-soft">
                  {usd != null ? (
                    fmtUsd(usd)
                  ) : pricesLoading ? (
                    <span className="inline-block h-4 w-14 rounded bg-surface-2 align-middle motion-safe:animate-pulse" aria-label="Loading price" />
                  ) : (
                    <span className="text-faint">{prices ? "No price" : "Price loading"}</span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-5 rounded-xl bg-surface px-4 py-3 text-[13.5px] text-mute">
            The vault on {networkName(n)} is empty right now.
          </p>
        )}
        {empty.length > 0 && (
          <p className="mt-3 text-[12.5px] leading-relaxed text-mute">
            Also accepted, none held right now: {empty.map((r) => r.h.symbol).join(", ")}.
          </p>
        )}
        {unpriced.length > 0 && !pricesLoading && (
          <p className="mt-1 text-[12.5px] leading-relaxed text-mute">
            {prices
              ? `Not in the total: ${unpriced.map((r) => r.h.symbol).join(", ")}, no dollar price.`
              : `Not in the total yet: ${unpriced.map((r) => r.h.symbol).join(", ")}, prices are still loading.`}
          </p>
        )}
      </div>
    </div>
  );
}

const COUNTS: {
  key: keyof Ledger["counts"];
  label: string;
  caption: string;
  sealed: boolean;
}[] = [
  { key: "deposits", label: "Private deposits", caption: "Wallet, token and amount are public", sealed: false },
  { key: "transfers", label: "Private transfers", caption: "Sender, recipient and amount stay sealed", sealed: true },
  { key: "cashouts", label: "Cash-outs", caption: "Wallet, token and amount are public", sealed: false },
  { key: "memos", label: "Payment messages", caption: "Encrypted, only the recipient can read one", sealed: true },
];

function CountTiles({ ledger }: { ledger: Ledger }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:gap-4">
      {COUNTS.map((c) => (
        <div key={c.key} className="gl-card flex flex-col p-4 sm:p-5">
          <div className="flex items-center justify-between gap-2">
            <p className="text-[13px] text-mute">{c.label}</p>
            {c.sealed && (
              <span className="text-sealed" role="img" aria-label="Sealed">
                <LockIcon size={13} />
              </span>
            )}
          </div>
          <p className="t-display-m tnum mt-3">{intFmt.format(ledger.counts[c.key])}</p>
          <p className="mt-auto pt-2 text-[12.5px] leading-relaxed text-mute">{c.caption}</p>
        </div>
      ))}
    </div>
  );
}

function eventAsset(ledger: Ledger, e: PublicEvent): { symbol: string; decimals: number; stable: boolean } {
  const a = (e.asset ?? zeroAddress).toLowerCase();
  const h = ledger.holdings.find((x) => (x.address ?? zeroAddress).toLowerCase() === a);
  if (h) return { symbol: h.symbol, decimals: h.decimals, stable: h.stable };
  if (a === zeroAddress) {
    const p = getNetwork(ledger.network).primaryAsset;
    return { symbol: p.symbol, decimals: p.decimals, stable: false };
  }
  return { symbol: `${a.slice(0, 6)}…${a.slice(-4)}`, decimals: 18, stable: false };
}

const KIND_LABEL: Record<PublicEvent["kind"], string> = {
  deposit: "Private deposit",
  transfer: "Private transfer",
  cashout: "Cash-out",
  trade: "Private trade",
};

function ActivityCard({ ledger }: { ledger: Ledger }) {
  const n = getNetwork(ledger.network);
  return (
    <div className="gl-card overflow-hidden">
      <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-4 sm:px-6">
        <h3 className="text-[15px] font-medium text-foreground">Recent activity</h3>
        <p className="text-[12.5px] text-mute">Newest first</p>
      </div>
      {ledger.recent.length === 0 ? (
        <p className="px-5 py-10 text-center text-[14px] text-mute sm:px-6">
          Nothing has happened in the vault on {networkName(n)} yet.
        </p>
      ) : (
        <ul className="divide-y divide-line">
          {ledger.recent.map((e) => {
            const pub = e.kind === "deposit" || e.kind === "cashout";
            const a = pub ? eventAsset(ledger, e) : null;
            return (
              <li key={`${e.tx}-${e.logIndex}`} className="flex min-h-[64px] items-center gap-3 px-5 py-2.5 sm:px-6">
                <KindIcon kind={e.kind} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14.5px] text-foreground">{KIND_LABEL[e.kind]}</span>
                  <span className="block truncate text-[12.5px] text-mute">
                    {e.ts ? (
                      <time dateTime={new Date(e.ts * 1000).toISOString()} title={fullDate(e.ts)}>
                        {ago(e.ts)}
                      </time>
                    ) : (
                      <span className="tnum">Block {intFmt.format(Number(e.block))}</span>
                    )}
                  </span>
                </span>
                <span className="tnum shrink-0 text-right text-[14px]">
                  {a && e.amount != null ? (
                    <span className="text-foreground">
                      {fmtAmount(units(e.amount, a.decimals), a.stable)} <span className="text-mute">{a.symbol}</span>
                    </span>
                  ) : (
                    <span className="inline-flex flex-col items-end gap-1">
                      <SealDots n={5} className="text-sealed" label="Amount hidden" />
                      <span className="text-[11.5px] text-mute">No amount</span>
                    </span>
                  )}
                </span>
                {e.tx && (
                  <a
                    href={n.explorerTx(e.tx)}
                    target="_blank"
                    rel="noreferrer"
                    aria-label={`View this ${KIND_LABEL[e.kind].toLowerCase()} on the explorer`}
                    className="-mr-2 grid h-10 w-10 shrink-0 place-items-center rounded-full text-mute transition-colors hover:bg-surface hover:text-foreground"
                  >
                    <ArrowUpRight />
                  </a>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <p className="border-t border-line px-5 py-3 text-[12.5px] leading-relaxed text-mute sm:px-6">
        Deposits and cash-outs show an amount because money crosses between a
        public wallet and the vault. Transfers never do.
      </p>
    </div>
  );
}

function ContractsCard({ ledger }: { ledger: Ledger }) {
  const n = getNetwork(ledger.network);
  const router = vaultSwapRouter(n.chainId);
  const rows = [
    { name: "Vault", what: "Holds every private balance", address: ledger.pool },
    ...(ledger.memo ? [{ name: "Payment messages", what: "Encrypted heads-ups for recipients", address: ledger.memo }] : []),
    ...(router
      ? [{ name: "Swap router", what: "Private swaps. Each one counts here as a cash-out and a deposit", address: router }]
      : []),
  ];
  return (
    <div className="gl-card overflow-hidden">
      <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-4 sm:px-6">
        <h3 className="text-[15px] font-medium text-foreground">Contracts</h3>
        <Link href="/verify#contracts" className="text-[12.5px] text-mute underline-offset-4 transition-colors hover:text-foreground hover:underline">
          Verify them
        </Link>
      </div>
      <ul className="divide-y divide-line">
        {rows.map((r) => (
          <li key={r.name} className="px-5 py-4 sm:px-6">
            <p className="text-[14.5px] text-foreground">{r.name}</p>
            <p className="mt-0.5 text-[12.5px] text-mute">{r.what}</p>
            <div className="mt-2.5 flex min-w-0 items-center rounded-xl bg-surface py-1 pl-3.5 pr-1">
              <span className="tnum min-w-0 flex-1 truncate text-[13px] text-foreground" title={r.address}>
                {r.address}
              </span>
              <CopyButton value={r.address} label={`${networkName(n)} ${r.name.toLowerCase()} address`} />
              <a
                href={n.explorerAddress(r.address)}
                target="_blank"
                rel="noreferrer"
                aria-label={`${networkName(n)} ${r.name.toLowerCase()} on the explorer`}
                className="inline-flex h-10 shrink-0 items-center gap-1.5 rounded-full px-3 text-[12.5px] font-medium text-mute transition-colors hover:bg-surface-2 hover:text-foreground"
              >
                Explorer <ArrowUpRight />
              </a>
            </div>
          </li>
        ))}
      </ul>
      <p className="border-t border-line px-5 py-3 text-[12.5px] leading-relaxed text-mute sm:px-6">
        Counted from block {intFmt.format(Number(ledger.fromBlock))}, when this vault went live.
      </p>
    </div>
  );
}

function LedgerSkeleton({ label, progress }: { label: string; progress: number }) {
  const pct = Math.round(progress * 100);
  return (
    <div aria-busy="true">
      <p role="status" className="text-[13px] text-mute">
        Reading {label} from public nodes{pct > 0 ? `, ${pct}%` : "…"}
      </p>
      <div className="mt-3 h-1 w-full max-w-[280px] overflow-hidden rounded-full bg-surface-2">
        <div className="h-full rounded-full bg-foreground/60 transition-[width] duration-300" style={{ width: `${Math.max(4, pct)}%` }} />
      </div>
      <div className="mt-6 grid gap-4 lg:grid-cols-[1.1fr_0.9fr]">
        <div className="gl-card h-[320px] motion-safe:animate-pulse" />
        <div className="grid grid-cols-2 gap-3 sm:gap-4">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="gl-card h-[148px] motion-safe:animate-pulse" />
          ))}
        </div>
      </div>
      <div className="mt-4 gl-card h-[360px] motion-safe:animate-pulse" />
    </div>
  );
}

/* ---------------------------------------------------------------- page */

const PRIVATE_FACTS = [
  {
    title: "Who paid whom",
    body: "A private transfer adds one to the count. The sender, the recipient and the amount stay sealed.",
  },
  {
    title: "What one person holds",
    body: "The vault shows one total for everyone together. Nobody can read a single balance out of it.",
  },
  {
    title: "What a payment message says",
    body: "When someone pays your Gloam address, the heads-up is encrypted to you. Anyone can count them. Only you can open yours.",
  },
  {
    title: "Payment requests",
    body: "A request link never touches the chain. It stays between you and the person you send it to.",
  },
  {
    title: "Which deposit paid for what",
    body: "Nothing on chain ties a payment back to the deposit it came from. Matching amounts in and out can still hint, so vary them.",
  },
  {
    title: "Who pressed send",
    body: "With Hide my wallet on, the Gloam relay submits your private sends, so your wallet does not show up as the sender.",
  },
];

export function TransparencyView() {
  const [active, setActive] = useState<NetworkKey | null>(null);
  const shown: NetworkKey = active ?? "robinhood";
  const net = getNetwork(shown);
  const { ledger, error, progress, refreshing, resuming, refresh } = useLedger(active);
  const { prices, waiting } = usePrices();

  // ?chain=tempo opens on Tempo; read after mount so server and client match.
  // With no ?chain it opens where the app does: Robinhood Chain testnet until
  // mainnet is live, a mainnet after.
  useEffect(() => {
    const t = window.setTimeout(() => {
      const q = new URLSearchParams(window.location.search).get("chain");
      const first = isNetworkKey(q) ? q : defaultNetworkKey();
      setActive(first);
      // A public page view: counted only with analytics consent, like pageviews.
      void import("@/lib/track").then(({ track }) => {
        track("transparency_view", { network: first }, { requireConsent: true });
      });
    }, 0);
    return () => window.clearTimeout(t);
  }, []);

  function choose(k: NetworkKey) {
    if (k !== active) {
      void import("@/lib/track").then(({ track }) => {
        track("transparency_tab", { network: k }, { requireConsent: true });
      });
    }
    setActive(k);
    try {
      const url = new URL(window.location.href);
      if (k === defaultNetworkKey()) url.searchParams.delete("chain");
      else url.searchParams.set("chain", k);
      window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
    } catch {
      /* ignore */
    }
  }

  const since = ledger?.startTs
    ? new Date(ledger.startTs * 1000).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })
    : null;

  return (
    <div className="relative min-h-screen bg-panel text-foreground">
      <Header />

      <main>
        {/* hero */}
        <section className="mx-auto max-w-[1400px] px-4 pt-3 sm:px-7 sm:pt-6">
          {/* The ledger carries this hero: the title and its actions on one line,
              then what the chain shows as one wide strip across the field. */}
          <div className="gl-panel flex min-h-[520px] flex-col justify-end gap-12 px-6 pb-8 pt-24 sm:px-12 sm:pb-12 lg:min-h-[580px]">
            <FlowField />
            <div className="relative flex flex-col gap-8 lg:flex-row lg:items-end lg:justify-between lg:gap-14">
              <div className="max-w-[720px]">
                <h1 className="t-display-xl">What anyone can see</h1>
                <p className="mt-6 max-w-[52ch] text-[16px] leading-relaxed text-soft sm:text-[17px]">
                  Gloam keeps who paid whom, and how much, private. The vault
                  that holds the money is public. This page reads it live from the
                  chain, in your browser, so you can see exactly what is out in
                  the open.
                </p>
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-x-6 gap-y-3 lg:pb-1">
                <a href="#ledger" className="btn btn-ink btn-lg">
                  See the vault
                </a>
                <a href="#private" className="gl-arrowlink">
                  What stays private <span aria-hidden>→</span>
                </a>
                <Link href="/stats" className="gl-arrowlink">
                  Totals for every mainnet <span aria-hidden>→</span>
                </Link>
              </div>
            </div>

            <div className="gl-glass relative w-full p-2">
              <div className="rounded-[12px] bg-panel">
                <p className="px-5 pt-4 text-[13px] text-mute sm:px-6">What the chain shows</p>
                <ul className="grid grid-cols-1 divide-y divide-line px-5 sm:px-6 lg:grid-cols-4 lg:divide-x lg:divide-y-0 lg:px-0 lg:pb-2">
                  {(
                    [
                      ["Vault balances", "Public", false],
                      ["Deposits, cash-outs", "Public, with amounts", false],
                      ["Private transfers", "Count only", true],
                      ["Payment messages", "Count only", true],
                    ] as const
                  ).map(([k, v, sealed]) => (
                    <li key={k} className="flex min-h-[52px] items-center justify-between gap-4 py-2 text-[14px] lg:block lg:min-h-0 lg:px-6 lg:py-3">
                      <span className="text-mute lg:block">{k}</span>
                      <span className="inline-flex items-center gap-2 text-right text-foreground lg:mt-1.5 lg:text-left lg:text-[17px]">
                        <span aria-hidden className={`shrink-0 max-lg:order-2 ${sealed ? "text-sealed" : "text-mute"}`}>
                          {sealed ? <LockIcon size={13} /> : <EyeIcon size={14} />}
                        </span>
                        {v}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        </section>

        {/* the vault, live */}
        <section id="ledger" className="mx-auto max-w-[1240px] scroll-mt-20 px-4 py-20 sm:px-6 sm:py-28">
          <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-[640px]">
              <h2 className="t-display-l">The vault, live</h2>
              <p className="mt-5 max-w-[54ch] text-[16px] leading-relaxed text-mute">
                Read straight from public nodes
                {since ? `, from ${since} when this vault went live` : ""}. No
                Gloam server sits in between, and you do not need a wallet.
              </p>
            </div>
            <NetworkPicker value={shown} onChange={choose} />
          </div>

          <div id="ledger-panel" role="region" aria-label={`The vault on ${networkName(net)}`} className="mt-10 min-w-0">
            {!ledger && error ? (
              <div role="alert" className="gl-card flex flex-col items-start gap-4 p-6 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="text-[15px] text-foreground">Could not read {networkName(net)}</p>
                  <p className="mt-1 max-w-[60ch] text-[13.5px] leading-relaxed text-mute">{error}</p>
                </div>
                <button type="button" onClick={refresh} className="btn btn-ink shrink-0">
                  Try again
                </button>
              </div>
            ) : !ledger ? (
              <LedgerSkeleton label={networkName(net)} progress={progress} />
            ) : (
              <>
                <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                  <p className="tnum text-[13px] text-mute" aria-live="polite">
                    {refreshing
                      ? `Checking for anything new on ${networkName(net)}…`
                      : `Up to block ${intFmt.format(Number(ledger.scannedTo))}, checked ${new Date(ledger.checkedAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })} in ${(ledger.tookMs / 1000).toFixed(1)}s`}
                  </p>
                  <button type="button" onClick={refresh} disabled={refreshing} className="btn btn-ghost btn-sm">
                    {refreshing ? "Refreshing…" : "Refresh"}
                  </button>
                </div>
                {error && (
                  <p role="alert" className="mb-4 flex flex-wrap items-center gap-x-2 rounded-xl bg-warn-soft px-4 py-3 text-[13px] leading-relaxed text-warn">
                    Could not refresh, so this is what was read earlier.
                    <button type="button" onClick={refresh} className="font-medium underline underline-offset-4">
                      Try again
                    </button>
                  </p>
                )}
                {!error && ledger.incomplete && (
                  <p aria-live="polite" className="mb-4 flex flex-wrap items-center gap-x-2 rounded-xl bg-surface px-4 py-3 text-[13px] leading-relaxed text-soft">
                    {ledger.incomplete.logsFrom
                      ? `Read up to block ${intFmt.format(Number(ledger.scannedTo))} so far. Public nodes are slow right now, so the counts below are what's read yet.`
                      : "The vault's balances didn't load this time, so these are the last ones read."}{" "}
                    {resuming || refreshing ? (
                      "Reading the rest…"
                    ) : (
                      <button type="button" onClick={refresh} className="font-medium text-foreground underline underline-offset-4">
                        Keep reading
                      </button>
                    )}
                  </p>
                )}
                <div className="grid items-start gap-4 lg:grid-cols-[1.1fr_0.9fr]">
                  <HoldingsCard ledger={ledger} prices={prices} waiting={waiting} />
                  <CountTiles ledger={ledger} />
                </div>
                <div className="mt-4 grid items-start gap-4 lg:grid-cols-[1.1fr_0.9fr]">
                  <ActivityCard ledger={ledger} />
                  <ContractsCard ledger={ledger} />
                </div>
              </>
            )}
          </div>
        </section>

        {/* what stays private */}
        <section id="private" className="mx-auto max-w-[1400px] scroll-mt-20 px-4 sm:px-7">
          <div className="gl-panel bg-surface px-5 py-14 sm:px-12 sm:py-20">
            <SealedField tone="soft" />
            <div className="relative mx-auto grid max-w-[1120px] grid-cols-1 gap-12 lg:grid-cols-[1fr_2fr]">
              <div>
                <h2 className="t-display-l max-w-[10ch]">What stays private</h2>
                <p className="mt-5 max-w-[36ch] text-[15px] leading-relaxed text-mute">
                  Deposits and cash-outs are public by design, because money
                  moves between a public wallet and the vault. Everything that
                  happens inside the vault stays sealed.
                </p>
                <Link
                  href="/verify"
                  className="gl-arrowlink mt-8"
                >
                  Check the contracts yourself <span aria-hidden>→</span>
                </Link>
              </div>
              <div className="grid grid-cols-1 gap-10 sm:grid-cols-2">
                {PRIVATE_FACTS.map((f) => (
                  <div key={f.title} className="border-t border-foreground pt-5">
                    <p className="text-[18px] leading-snug tracking-[-0.01em]">{f.title}</p>
                    <p className="mt-3 text-[14px] leading-relaxed text-mute">{f.body}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>
      </main>

      <Footer />
    </div>
  );
}
