"use client";

import Link from "next/link";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
  type FormEvent,
} from "react";
import { Logo } from "@/components/Logo";
import { SealedField } from "@/components/ui/SealedField";
import { HowItWorks } from "@/components/ui/HowItWorks";
import { BusyLabel } from "@/components/ui/Spinner";
import { shortAddress } from "@/lib/chain";
import { MAINNET_ENABLED, NETWORK_KEYS, getNetwork, isNetworkKey, networkName, type GloamNetwork } from "@/lib/networks";
import type { CreatorFees } from "@/lib/creatorFees";
import type { CombinedRevenue, DayRow, NetworkMetrics, OnchainMetrics, Windowed } from "@/lib/onchainMetrics";
import type { DailyCounters, StoredEvent } from "@/lib/tractionStore";
import type { FunnelDay } from "@/lib/funnelStore";
import type { PeopleSide, PeopleSummary } from "@/lib/peopleStore";
import { relayChainName } from "@/lib/bridge";
import type { RelayVolume } from "@/lib/relayVolume";
import { ArrowUpRight } from "@/components/ui/ArrowUpRight";
import { MAINNET_LAUNCH_ISO } from "@/lib/mainnet";
import { CONTEST_NETWORK_LABEL, type ContestNetwork } from "@/lib/contest";
import { VotesPanel } from "./AdminVotes";
import { AdminBackfill, AdminPartnerDetail } from "./AdminPartnerDetail";
import { ActivityFeed, ChainCards, MovedHero, Stat, VolumeChart, type Moved, type VolumeDay } from "./AdminCharts";

type MetricsPayload = {
  ok: boolean;
  generatedAt?: string;
  launch?: {
    open: boolean;
    forceOpen: boolean;
    opensAt: string;
    opensAtMs: number;
  };
  onchain?: OnchainMetrics | { error: string };
  product?: {
    backend: "redis" | "memory";
    totalEvents: number;
    counters: Record<string, number>;
    dims?: Record<string, number>;
    daily?: DailyCounters[];
    recent: StoredEvent[];
  };
  /** Claim-link totals per UTC day, oldest first (lib/funnel). */
  claimLinks?: FunnelDay[];
  /** Bridges and swaps through Gloam's Relay panel (lib/relayVolume). */
  relay?: RelayVolume | { error: string };
  /** Different wallets using Gloam, counted one way (lib/peopleStore). */
  people?: PeopleSummary;
  /** Revenue switches read from env (bridge app fee). */
  revenueConfig?: { bridgeFeeBps: number | null };
  error?: string;
};

type Tab = "overview" | "revenue" | "relay" | "users" | "events" | "partners" | "testers" | "contest" | "updates" | "bugs" | "votes" | "hunt";

/** The two views: mainnet or the testnets. Never mixed. */
type Env = "mainnet" | "testnet";
const ENV_KEY = "gloam.admin.env";

/** The view to open: ?env= in the address, then the last one picked here, else mainnet. */
function readEnv(): Env {
  if (typeof window === "undefined") return "mainnet";
  const q = new URLSearchParams(window.location.search).get("env");
  if (q === "testnet" || q === "mainnet") return q;
  try {
    return window.localStorage.getItem(ENV_KEY) === "testnet" ? "testnet" : "mainnet";
  } catch {
    return "mainnet";
  }
}

/** Mainnet opened on this UTC day (21 Oct 2026, 13:00 UTC). No mainnet event is older. */
const MAINNET_DAY = "2026-10-21";

function isMainnetNetwork(value: string): boolean {
  return isNetworkKey(value) && !getNetwork(value).testnet;
}

function isMainnetChainId(value: string): boolean {
  return NETWORK_KEYS.some((k) => !getNetwork(k).testnet && String(getNetwork(k).chainId) === value);
}

type ProductSummary = NonNullable<MetricsPayload["product"]>;

type SideProduct = {
  counters: Record<string, number>;
  total: number;
  dims: Record<string, number>;
  daily: DailyCounters[];
  recent: StoredEvent[];
};

/**
 * Product events for one side. Every event has carried its network since
 * mainnet opened, so mainnet's all-time counts come from the network
 * breakdown and the testnets get the rest, older untagged events included.
 * Per-day and per-field counts are kept per side from 21 Oct 2026 evening;
 * mainnet's launch day is its all-time count less the days after it.
 */
function splitProduct(p: ProductSummary | undefined, env: Env): SideProduct {
  const counters = p?.counters ?? {};
  const dims = p?.dims ?? {};
  const main = env === "mainnet";

  const mainAll: Record<string, number> = {};
  for (const [key, v] of Object.entries(dims)) {
    const m = /^([^:|]+)\|network=(.+)$/.exec(key);
    if (m && isMainnetNetwork(m[2]!)) mainAll[m[1]!] = (mainAll[m[1]!] ?? 0) + v;
  }
  const side: Record<string, number> = {};
  for (const t of Object.keys(counters)) {
    if (t === "total" || t.includes(":")) continue;
    const v = main ? (mainAll[t] ?? 0) : Math.max(0, (counters[t] ?? 0) - (mainAll[t] ?? 0));
    if (v > 0) side[t] = v;
  }

  const sideDims: Record<string, number> = {};
  for (const [key, v] of Object.entries(dims)) {
    const sided = /^(mainnet|testnet):(.+)$/.exec(key);
    const body = sided ? sided[2]! : key;
    const [, pair] = body.split("|");
    if (!pair) continue;
    const [field, value = ""] = pair.split("=");
    if (field === "network" || field === "chainId") {
      // The unsided count holds every event; the value itself says which side.
      if (sided) continue;
      const isMain = field === "network" ? isMainnetNetwork(value) : isMainnetChainId(value);
      if (isMain === main) sideDims[body] = (sideDims[body] ?? 0) + v;
    } else if (main) {
      if (sided?.[1] === "mainnet") sideDims[body] = (sideDims[body] ?? 0) + v;
    } else if (!sided) {
      sideDims[body] = (sideDims[body] ?? 0) + v;
    } else if (sided[1] === "mainnet") {
      sideDims[body] = (sideDims[body] ?? 0) - v;
    }
  }
  for (const k of Object.keys(sideDims)) if (!(sideDims[k]! > 0)) delete sideDims[k];

  const days = p?.daily ?? [];
  const later = (t: string) => days.filter((d) => d.day > MAINNET_DAY).reduce((a, d) => a + (d.counters[`mainnet:${t}`] ?? 0), 0);
  const daily = days.map(({ day, counters: c }) => {
    const out: Record<string, number> = {};
    for (const t of Object.keys(c)) {
      if (t === "total" || t.includes(":")) continue;
      const mainDay =
        day < MAINNET_DAY ? 0 : day === MAINNET_DAY ? Math.max(0, (mainAll[t] ?? 0) - later(t)) : (c[`mainnet:${t}`] ?? 0);
      const v = main ? mainDay : Math.max(0, (c[t] ?? 0) - mainDay);
      if (v > 0) out[t] = v;
    }
    return { day, counters: out };
  });

  const recent = (p?.recent ?? []).filter((ev) => {
    const net = typeof ev.meta?.network === "string" ? ev.meta.network : null;
    const isMain = ev.meta?.mainnet === true || (net !== null && isMainnetNetwork(net));
    return isMain === main;
  });

  return { counters: side, total: Object.values(side).reduce((a, b) => a + b, 0), dims: sideDims, daily, recent };
}

/** One day of claim-link counts for a side; a day stored before the split is all testnet. */
function claimSide(r: FunnelDay, env: Env) {
  if (r.mainnet && r.testnet) return r[env];
  const zero = { link_created: 0, link_opened: 0, link_claimed: 0, claimer_sent: 0 };
  return env === "testnet"
    ? { link_created: r.link_created, link_opened: r.link_opened, link_claimed: r.link_claimed, claimer_sent: r.claimer_sent }
    : zero;
}

/** Events added for proofs, the public ledger, requests and notes; shown first in the breakdowns. */
/** How often an open admin tab refreshes. Only while it is on screen: each refresh reads Redis. */
const ADMIN_REFRESH_MS = 60_000;

const NEW_EVENTS = [
  "proof_created",
  "proof_create_failed",
  "verify_page_view",
  "transparency_view",
  "transparency_tab",
  "payment_request_created",
  "payment_request_opened",
  "payment_request_paid",
  "private_note_added",
  "bridge_address_created",
  "bridge_arrived",
  "swap_review",
  "swap_submit",
  "swap_success",
];

/** Payroll events come from the payroll flow; the first name present is the one counted. */
const PAYROLL_KEYS = ["payroll_run_finished", "payroll_run_success", "payroll_run_paid", "payroll_run", "payroll_run_submit", "payroll_paid"];

const usdFmt = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });

function fmtUsd(n: number | null | undefined): string {
  if (n == null) return "Not priced";
  if (n > 0 && n < 0.01) return "<$0.01";
  return usdFmt.format(n);
}

function fmtWhen(ts: number | null | undefined): string {
  if (!ts) return "None yet";
  return new Date(ts * 1000).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function fmtDay(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function fmtAge(sec: number): string {
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.round(sec / 60)}m ago`;
  return `${Math.round(sec / 3600)}h ago`;
}

function n(v: number | undefined): string {
  return (v ?? 0).toLocaleString("en-US");
}

export function AdminDashboard() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [code, setCode] = useState("");
  const [loginErr, setLoginErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [data, setData] = useState<MetricsPayload | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState<Tab>("overview");
  const [env, setEnvState] = useState<Env>(readEnv);

  /** Mainnet or testnet, kept in the address (?env=testnet) and in this browser. */
  const setEnv = useCallback((next: Env) => {
    setEnvState(next);
    try {
      window.localStorage.setItem(ENV_KEY, next);
    } catch {
      /* private window: the address still keeps it */
    }
    const url = new URL(window.location.href);
    if (next === "testnet") url.searchParams.set("env", "testnet");
    else url.searchParams.delete("env");
    window.history.replaceState(null, "", url.pathname + url.search + url.hash);
  }, []);

  const checkSession = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/session", { credentials: "include" });
      if (res.status === 503) {
        setAuthed(false);
        setLoginErr("ADMIN_ACCESS_CODE is not set on the server.");
        return false;
      }
      if (res.status === 401) {
        setAuthed(false);
        return false;
      }
      if (!res.ok) {
        setAuthed(false);
        setLoginErr("Could not verify session.");
        return false;
      }
      setAuthed(true);
      return true;
    } catch {
      setAuthed(false);
      setLoginErr("Network error checking session.");
      return false;
    }
  }, []);

  const loadMetrics = useCallback(async (fresh = false) => {
    setLoadErr(null);
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/metrics${fresh ? "?fresh=1" : ""}`, { credentials: "include" });
      if (res.status === 401) {
        setAuthed(false);
        setData(null);
        return;
      }
      // Session is valid if we got past 401, don't freeze on metrics failure
      setAuthed(true);
      if (!res.ok) {
        const json = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        setLoadErr(json?.error ?? `Metrics failed (${res.status})`);
        return;
      }
      const json = (await res.json()) as MetricsPayload;
      setData(json);
    } catch (e) {
      // Keep dashboard shell if session was already true
      setLoadErr(e instanceof Error ? e.message : "Network error loading metrics");
      setAuthed((prev) => (prev === null ? false : prev));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void (async () => {
      const ok = await checkSession();
      if (ok) await loadMetrics();
    })();
  }, [checkSession, loadMetrics]);

  useEffect(() => {
    if (!authed) return;
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") void loadMetrics();
    }, ADMIN_REFRESH_MS);
    return () => window.clearInterval(id);
  }, [authed, loadMetrics]);

  async function onLogin(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setLoginErr(null);
    try {
      const res = await fetch("/api/admin/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
        credentials: "include",
      });
      const json = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok) {
        setLoginErr(json.error ?? "Login failed");
        setAuthed(false);
        return;
      }
      setCode("");
      setAuthed(true);
      await loadMetrics();
    } catch {
      setLoginErr("Network error");
      setAuthed(false);
    } finally {
      setBusy(false);
    }
  }

  async function onLogout() {
    await fetch("/api/admin/logout", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    setAuthed(false);
    setData(null);
  }

  // Hooks must run every render (before any early return), React #310
  const oc = data?.onchain && "networks" in data.onchain ? data.onchain : null;
  const ocError = data?.onchain && !("networks" in data.onchain) ? data.onchain.error : null;
  const product = data?.product;
  const relay = data?.relay;
  const isMain = env === "mainnet";
  const prod = useMemo(() => splitProduct(product, env), [product, env]);
  const counters = prod.counters;
  // This side's totals. Snapshots cached before the split have neither and read as not yet.
  const agg = oc ? (isMain ? oc.mainnet : oc.testnet) : undefined;

  const funnel = useMemo(() => {
    const payrollKey = PAYROLL_KEYS.find((k) => counters[k] != null) ?? PAYROLL_KEYS[0];
    const steps = [
      { k: "App views", v: counters.app_view ?? 0, sub: "app_view" },
      { k: "Wallet connects", v: counters.wallet_connect ?? 0, sub: "wallet_connect" },
      {
        k: "First deposits",
        v: agg?.depositors ?? 0,
        sub: "unique depositor wallets, on-chain",
      },
      {
        k: "Private sends and payments",
        v: counters.private_send_submit ?? 0,
        sub: `private_send_submit, ${n(agg?.transfers)} landed on-chain`,
      },
      { k: "Proofs created", v: counters.proof_created ?? 0, sub: "proof_created" },
      { k: "Payroll runs", v: counters[payrollKey] ?? 0, sub: payrollKey },
    ];
    const max = Math.max(1, ...steps.map((s) => s.v));
    return steps.map((s) => ({ ...s, pct: (s.v / max) * 100 }));
  }, [counters, agg]);

  const claim = useMemo(() => {
    const rows = (data?.claimLinks ?? []).map((r) => ({ day: r.day, ...claimSide(r, env) }));
    const t = { link_created: 0, link_opened: 0, link_claimed: 0, claimer_sent: 0 };
    for (const r of rows) {
      t.link_created += r.link_created;
      t.link_opened += r.link_opened;
      t.link_claimed += r.link_claimed;
      t.claimer_sent += r.claimer_sent;
    }
    // Launch day, before counting by network: either network, so shown on its own in both views.
    const mixed = { link_created: 0, link_opened: 0, link_claimed: 0, claimer_sent: 0 };
    const mixedRows: { day: string; c: typeof mixed }[] = [];
    for (const r of data?.claimLinks ?? []) {
      const m = r.mixed;
      if (!m || m.link_created + m.link_opened + m.link_claimed + m.claimer_sent === 0) continue;
      mixedRows.push({ day: r.day, c: m });
      mixed.link_created += m.link_created;
      mixed.link_opened += m.link_opened;
      mixed.link_claimed += m.link_claimed;
      mixed.claimer_sent += m.claimer_sent;
    }
    const steps = [
      { k: "Links made in the app", v: t.link_created, sub: "single and payroll, payment landed" },
      { k: "Opened", v: t.link_opened, sub: "once per link per browser" },
      { k: "Claimed", v: t.link_claimed, sub: "any claim link or code" },
      {
        k: "Claimers who then paid someone",
        v: t.claimer_sent,
        sub: t.link_claimed > 0 ? `${Math.round((t.claimer_sent / t.link_claimed) * 100)}% of claims` : "",
      },
    ];
    const max = Math.max(1, ...steps.map((s) => s.v));
    const tableRows = [...rows].reverse().flatMap((r) => {
      const m = mixedRows.find((x) => x.day === r.day);
      return m ? [{ ...r, label: null as string | null }, { day: r.day, label: "before the split, either network", ...m.c }] : [{ ...r, label: null as string | null }];
    });
    return {
      totals: t,
      mixed: mixedRows.length ? mixed : null,
      steps: steps.map((s) => ({ ...s, pct: (s.v / max) * 100 })),
      rows: tableRows,
    };
  }, [data?.claimLinks, env]);

  const days = useMemo(() => {
    const eventsByDay = new Map(prod.daily.map((d) => [d.day, d.counters]));
    const chain = agg?.daily ?? [];
    const allDays = chain.length ? chain.map((d) => d.day) : prod.daily.map((d) => d.day);
    const byDay = new Map<string, DayRow>(chain.map((d) => [d.day, d]));
    return allDays
      .map((day) => ({ day, chain: byDay.get(day) ?? null, ev: eventsByDay.get(day) ?? {} }))
      .reverse();
  }, [agg, prod.daily]);

  // People per day, once anything has been counted (blank before, not zero).
  const peopleByDay = useMemo(() => {
    const p = data?.people;
    const side = p?.[env];
    const counting = Boolean(p && (p.configured || (side?.all ?? 0) > 0));
    return new Map(counting ? (side?.daily ?? []).map((d) => [d.day, d.people]) : []);
  }, [data?.people, env]);

  const breakdowns = useMemo(() => {
    const groups = new Map<string, { field: string; value: string; v: number }[]>();
    for (const [key, v] of Object.entries(prod.dims)) {
      const [event, pair] = key.split("|");
      if (!event || !pair) continue;
      const [field, value] = pair.split("=");
      const list = groups.get(event) ?? [];
      list.push({ field, value: value ?? "", v });
      groups.set(event, list);
    }
    const rank = (e: string) => {
      const i = NEW_EVENTS.indexOf(e);
      return i === -1 ? NEW_EVENTS.length : i;
    };
    return [...groups.entries()]
      .sort((a, b) => rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0]))
      .map(([event, list]) => ({
        event,
        list: list.sort((a, b) => a.field.localeCompare(b.field) || b.v - a.v),
      }));
  }, [prod.dims]);

  if (authed === null) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-3">
          <span className="livedot h-2 w-2 rounded-full bg-foreground/60" />
          <p className="t-label">Verifying session</p>
        </div>
      </div>
    );
  }

  if (!authed) {
    return (
      <div className="flex min-h-dvh flex-col bg-background p-3 sm:p-4">
        <div className="gl-panel flex flex-1 flex-col">
          <SealedField />
          <header className="flex h-16 items-center justify-between px-5 sm:px-8">
            <Logo />
            <span className="rounded-full bg-panel/70 px-3 py-1 text-[12px] text-mute">
              Restricted
            </span>
          </header>

          <main className="flex flex-1 flex-col items-center justify-center px-2 py-12 sm:px-5">
            <div className="w-full max-w-[420px]">
              <div className="gl-glass p-2 shadow-pop">
                <div className="rounded-[12px] bg-panel p-6 sm:p-7">
                  <p className="t-label">Ops console</p>
                  <h1 className="t-display-m mt-3 text-foreground">Traction</h1>
                  <p className="mt-2 text-[14px] leading-relaxed text-mute">
                    On-chain volume, unique wallets, and product funnel. Access
                    code required. Not public.
                  </p>

                  <form onSubmit={onLogin} className="mt-7 space-y-4">
                    <label className="block">
                      <span className="text-[13px] text-mute">Access code</span>
                      <input
                        type="password"
                        autoComplete="current-password"
                        value={code}
                        onChange={(e) => setCode(e.target.value)}
                        placeholder="••••••••••••"
                        className="gl-input mt-2"
                        required
                      />
                    </label>
                    {loginErr && (
                      <p
                        className="rounded-xl bg-danger-soft px-3.5 py-2.5 text-[13px] text-danger"
                        role="alert"
                      >
                        {loginErr}
                      </p>
                    )}
                    <button
                      type="submit"
                      disabled={busy}
                      className="btn btn-ink btn-lg btn-block"
                    >
                      {busy ? "Checking…" : "Enter console"}
                    </button>
                  </form>
                </div>
              </div>
              <p className="mt-5 text-center text-[12px] text-mute">
                Set{" "}
                <code className="rounded-md bg-panel/70 px-1.5 py-0.5 text-foreground">
                  ADMIN_ACCESS_CODE
                </code>{" "}
                on Vercel
              </p>
            </div>
          </main>
        </div>
      </div>
    );
  }

  const nets = oc?.networks ?? [];
  const isTest = (m: NetworkMetrics) => m.testnet ?? getNetwork(m.key).testnet;
  const nameOf = (m: NetworkMetrics) => adminName(getNetwork(m.key));
  // Only this side's networks, everywhere below.
  const sideNets = nets.filter((m) => isTest(m) !== isMain);
  const rev = agg?.revenue;
  // $GLOAM creator fees exist on Robinhood Chain mainnet only; the testnets have none.
  const creator = isMain && oc?.creator && "earnedEth" in oc.creator ? oc.creator : null;
  const revenue = rev ? revenueTotals(rev) : null;
  const byNetwork = (
    f: (m: NetworkMetrics) => ReactNode,
    total: (c: NonNullable<typeof agg>) => ReactNode
  ): ReactNode[] => [...sideNets.map((m) => f(m)), agg ? total(agg) : ""];
  // This side's own newest rows: the combined list keeps only the newest few
  // across every network, so a busy side would push the other one out of it.
  const recentTx = sideNets
    .flatMap((m) => m.recent)
    .sort((a, b) => b.ts - a.ts || Number(b.block) - Number(a.block))
    .slice(0, 25);
  const money = isMain ? "mainnet" : "testnet";
  // Assets this side moved with no dollar price (EURC): named next to the dollar figures, never priced at $1.
  const noPrice = notInDollars(sideNets, nameOf);
  const heldNoPrice = [...new Set(sideNets.flatMap((m) => (m.unpriced ?? []).map((sym) => `${sym} (${nameOf(m)})`)))].join(", ");
  // Bridge and swaps run on mainnet only.
  const shown: Tab = !isMain && tab === "relay" ? "overview" : tab;
  const sideTabs: [Tab, string][] = [
    ["overview", "Overview"],
    ["revenue", isMain ? "Revenue" : "Fees"],
    ...(isMain ? ([["relay", "Bridge and swaps"]] as [Tab, string][]) : []),
    ["users", "Wallets"],
    ["events", "Product events"],
  ];
  const opsTabs: [Tab, string][] = [
    ["partners", "Partners"],
    ["testers", "Testers"],
    ["contest", "Contest"],
    ["updates", "Email updates"],
    ["bugs", "Bug reports"],
    ["votes", "Votes"],
    ["hunt", "Hunt"],
  ];
  const liveRelay = relay && "enabled" in relay && relay.enabled ? relay : null;
  // The public edges only: deposits and cash-outs carry amounts on chain; private payments never do.
  const moved: Moved | null =
    rev && agg
      ? {
          inUsd: rev.depositVolume.all,
          outUsd: rev.cashoutVolume.all,
          d1: rev.depositVolume.d1 + rev.cashoutVolume.d1,
          d7: rev.depositVolume.d7 + rev.cashoutVolume.d7,
          deposits: agg.deposits,
          cashouts: agg.cashouts,
        }
      : null;
  const volumeDays: VolumeDay[] = (rev?.daily ?? [])
    .filter((d) => !isMain || d.day >= MAINNET_DAY)
    .map((d) => ({ day: d.day, inUsd: d.depositUsd, outUsd: d.cashoutUsd, txs: d.txs }));
  const todayTransfers = agg?.daily.at(-1)?.transfers ?? 0;

  const tabButton = ([id, label]: [Tab, string]) => (
    <button
      key={id}
      type="button"
      role="tab"
      aria-selected={shown === id}
      onClick={() => setTab(id)}
      className={`h-9 shrink-0 whitespace-nowrap rounded-full px-3.5 transition-colors sm:px-4 ${
        shown === id ? "bg-panel font-medium text-foreground shadow-card" : "text-mute hover:text-foreground"
      }`}
    >
      {label}
    </button>
  );

  return (
    <div className="gloam-app min-h-dvh bg-background text-foreground">
      <header className="sticky top-0 z-20 border-b border-line bg-background/85 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-[1200px] items-center justify-between gap-3 px-5 sm:px-8">
          <div className="flex items-center gap-3">
            <Logo />
            <span className="rounded-full border border-line bg-panel px-2.5 py-1 text-[12px] text-mute">
              Admin
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="mr-2 hidden text-[12px] text-mute sm:inline">
              {product?.backend === "redis" ? "Redis" : "Memory"}, refreshes every minute
            </span>
            <button
              type="button"
              onClick={() => void loadMetrics(true)}
              disabled={loading}
              className="btn btn-ghost btn-sm"
            >
              {loading ? "Reading…" : "Refresh"}
            </button>
            <button
              type="button"
              onClick={() => void onLogout()}
              className="btn btn-quiet btn-sm"
            >
              Log out
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1200px] space-y-6 px-5 py-10 sm:px-8 sm:py-12">
        <div className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="t-display-m">{isMain ? "Traction" : "Testnet traction"}</h1>
              <span
                className={`rounded-full px-2.5 py-1 text-[12px] font-medium ${
                  isMain ? "bg-sealed-soft text-sealed" : "bg-warn-soft text-warn"
                }`}
              >
                {isMain ? "Mainnet" : "Testnet"}
              </span>
            </div>
            <p className="mt-2 max-w-[60ch] text-[14px] leading-relaxed text-mute">
              {isMain
                ? `${chainsOn("mainnet")} mainnet: money people really moved, what it earned, and the product funnel.`
                : `${chainsOn("testnet")} testnets: activity from testing. None of it counts toward mainnet.`}
            </p>
          </div>
          <EnvSwitch env={env} onChange={setEnv} />
        </div>

        <div className="-mx-5 overflow-x-auto px-5 sm:mx-0 sm:px-0">
          <div role="tablist" aria-label="Dashboard sections" className="flex w-max items-center gap-0.5 rounded-full bg-surface-2 p-1 text-[13px]">
            {sideTabs.map(tabButton)}
            <span aria-hidden className="mx-1.5 h-5 w-px shrink-0 bg-line-strong" />
            {opsTabs.map(tabButton)}
          </div>
        </div>

        {!isMain && (
          <p className="rounded-xl bg-warn-soft px-4 py-3 text-[14px] leading-relaxed text-warn">
            You are looking at the testnets. Everything here is from testing; switch to Mainnet for the mainnet numbers.
          </p>
        )}

        {loadErr && (
          <p className="rounded-xl bg-danger-soft px-4 py-3 text-[14px] text-danger" role="alert">
            {loadErr}
          </p>
        )}

        {!data && !loadErr && (
          <p className="flex items-center gap-2.5 rounded-xl bg-surface px-4 py-3 text-[14px] text-mute" role="status">
            <span className="livedot h-2 w-2 rounded-full bg-foreground/60" />
            Reading the chains. The first read after a deploy can take half a minute.
          </p>
        )}

        {ocError && (
          <p className="rounded-xl bg-danger-soft px-4 py-3 text-[14px] text-danger">
            On-chain: {ocError}
          </p>
        )}

        {sideNets
          .filter((m) => m.error || m.catchingUp)
          .map((m) => (
            <p
              key={m.key}
              className={`rounded-xl px-4 py-3 text-[14px] ${
                m.error ? "bg-danger-soft text-danger" : "bg-warn-soft text-warn"
              }`}
            >
              {m.error
                ? `${nameOf(m)}: the last read failed (${m.error}). Showing what was read before.`
                : `${nameOf(m)}: still reading its history, up to block ${m.scannedTo} of ${m.latestBlock}. The next refresh continues.`}
            </p>
          ))}

        {shown === "overview" && (
          <>
            <MovedHero
              moved={moved}
              window={isMain ? "since launch" : "all time"}
              testnet={!isMain}
              footer={
                <span className="flex flex-wrap gap-x-6 gap-y-1.5">
                  <span>
                    Last activity <span className="text-soft">{fmtWhen(agg?.lastActivity)}</span>
                  </span>
                  <span>
                    Chain read <span className="text-soft">{oc ? `${fmtAge(oc.ageSec)}, ${oc.source === "fresh" ? "just now" : `cached in ${oc.source}`}` : "not yet"}</span>
                  </span>
                  {isMain && liveRelay && (
                    <span>
                      Bridged and swapped through Gloam, 30 days{" "}
                      <span className="tnum text-soft">
                        {fmtUsd(liveRelay.last30.bridge.inUsd + liveRelay.last30.swap.inUsd)}
                      </span>
                      , not added above: bridged money counts once it is deposited
                    </span>
                  )}
                </span>
              }
            />

            <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Stat
                label="In the vault now"
                value={agg ? fmtUsd(agg.heldUsd) : null}
                sub={agg?.unpriced.length ? `${money}, plus ${agg.unpriced.length} unpriced` : `${money}, across every ${isMain ? "mainnet" : "testnet"}`}
              />
              <Stat
                label="Private payments"
                value={agg ? n(agg.transfers) : null}
                sub={`${n(todayTransfers)} today (UTC). Counted, never summed: amounts stay hidden`}
              />
              <Stat
                label={isMain ? "Fees earned" : "Testnet fees"}
                value={revenue ? fmtUsd(revenue.total.all) : null}
                sub={rev ? `${isMain ? "since launch" : "all time"}, ${fmtUsd(rev.owedUsd)} to collect` : "after the next chain read"}
              />
              <Stat
                label="Wallets"
                value={agg ? n(agg.activeWallets) : null}
                sub={`${n(agg?.depositors)} deposited${rev ? `, ${n(rev.users.d7)} active in 7 days` : ""}`}
              />
            </section>

            <PeoplePanel people={data?.people} env={env} claims={claim.totals.link_claimed} mixedClaims={claim.mixed?.link_claimed ?? 0} />

            <Panel title={isMain ? (volumeDays.length < 30 ? "Money in and out by day, since launch" : "Money in and out by day, last 30 days") : "Money in and out by day, last 30 days"}>
              <VolumeChart
                days={volumeDays}
                caption={`Daily deposits and cash-outs in dollars, ${isMain ? "mainnet" : "testnet"}`}
              />
              <p className="mt-4 text-[13px] leading-relaxed text-mute">
                UTC days, {money}. Deposits rise above the line, cash-outs drop below it. The scale stretches to fit the biggest day, so quiet days stay readable.{" "}
                {oc ? flowPricing(oc, isMain, rev?.atToday) : "Priced once the chains are read"}
                {noPrice ? `. Not in dollars: ${noPrice}` : ""}.
              </p>
            </Panel>

            <ChainCards nets={sideNets} totalMoved={moved ? moved.inUsd + moved.outUsd : 0} name={nameOf} />

            <div className="grid grid-cols-1 gap-3 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
              <Panel title="Latest activity">
                <ActivityFeed rows={recentTx} name={adminName} />
              </Panel>
              <Panel title="Claim links, last 14 days">
                <BarChart rows={claim.steps} />
                <p className="mt-5 text-[13px] leading-relaxed text-mute">
                  {claim.mixed
                    ? `Launch day before counting by network: ${n(claim.mixed.link_created)} made, ${n(claim.mixed.link_claimed)} claimed, either network, not added here.`
                    : "Totals only, counted without cookies or ids."}{" "}
                  The day-by-day table and how each step is counted are below.
                </p>
              </Panel>
            </div>

            <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
              <Panel title="Funnel">
                <BarChart rows={funnel} />
                <p className="mt-5 text-[13px] leading-relaxed text-mute">
                  Event counts, not unique people, except first deposits, which are unique wallets read from the chain.
                  Recording demo sessions are not counted.
                </p>
              </Panel>
              <Panel title="Last 14 days">
                <DataTable
                  headers={["Day", "People", "Active wallets", "Deposits", "Transfers", "Cash-outs", "App views", "Connects", "Proofs"]}
                  rows={days.map((d) => [
                    fmtDay(d.day),
                    peopleByDay.has(d.day) ? n(peopleByDay.get(d.day)) : "",
                    n(d.chain?.activeWallets),
                    n(d.chain?.deposits),
                    n(d.chain?.transfers),
                    n(d.chain?.cashouts),
                    n(d.ev.app_view),
                    n(d.ev.wallet_connect),
                    n(d.ev.proof_created),
                  ])}
                  empty="No days yet"
                  minWidth={680}
                />
                <p className="mt-4 text-[13px] leading-relaxed text-mute">
                  UTC days. People are different wallets that connected, claimed, deposited or used the app that day.
                  Active wallets deposited or received a cash-out that day.
                </p>
              </Panel>
            </div>
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
              <Panel title="How claim links are counted">
                <p className="text-[13px] leading-relaxed text-mute">
                  Totals only, counted without cookies or ids. Claimed can run ahead of made: claims count every claim link
                  or code, while made counts only links made in this app whose payment landed (payroll links since 21 Oct;
                  codes from the SDK, agents or before 13 Oct are not counted). Opened counts each link once per browser, so a
                  link opened in a chat app and again in a wallet counts twice. Counting by network started on launch day at
                  17:43 UTC; launch-day counts from before that could be either network, so they are listed apart and not
                  added to either total. Everything before launch day is Testnet.
                </p>
              </Panel>
              <Panel title="Claim links by day">
                <DataTable
                  headers={["Day", "Made", "Opened", "Claimed", "Claimer paid"]}
                  rows={claim.rows.map((d) => [
                    d.label ? (
                      <span key="d" className="text-mute">
                        {fmtDay(d.day)}, {d.label}
                      </span>
                    ) : (
                      fmtDay(d.day)
                    ),
                    n(d.link_created),
                    n(d.link_opened),
                    n(d.link_claimed),
                    n(d.claimer_sent),
                  ])}
                  empty="No claim links yet"
                  minWidth={420}
                />
              </Panel>
            </div>
            <Panel title="Held by asset">
              <DataTable
                headers={["Network", "Asset", "Held now", "USD", "Deposited", "Cashed out"]}
                rows={sideNets.flatMap((m) =>
                  m.assets.map((a) => [
                    nameOf(m),
                    a.symbol,
                    a.held ?? "Unknown",
                    fmtUsd(a.heldUsd),
                    `${a.deposited} (${a.depositCount})`,
                    `${a.cashedOut} (${a.cashoutCount})`,
                  ])
                )}
                empty="Nothing held or moved yet"
              />
              <p className="mt-4 text-[13px] leading-relaxed text-mute">
                Held now is at today&apos;s prices. Dollar stablecoins count as $1{heldNoPrice ? `; ${heldNoPrice} have no dollar price and are left out of dollar totals` : ""}. ETH {oc?.prices.ethUsd ? `at ${fmtUsd(oc.prices.ethUsd)}` : "is not priced right now"};
                stock tokens at live equity marks{oc?.prices.stocks === "live" ? "" : ", not available right now"}.
                Deposited and cashed out are token amounts, counts in brackets; private swaps are not in them.
              </p>
            </Panel>
            <Panel title="By network, in detail">
              <DataTable
                headers={["", ...sideNets.map(nameOf), "Total"]}
                rows={[
                  ["Deposits", ...byNetwork((m) => n(m.deposits), (c) => n(c.deposits))],
                  ["Private transfers", ...byNetwork((m) => n(m.transfers), (c) => n(c.transfers))],
                  ["Cash-outs", ...byNetwork((m) => n(m.cashouts), (c) => n(c.cashouts))],
                  ["Private swaps and trades", ...byNetwork((m) => n(m.trades), (c) => n(c.trades))],
                  ["Payment messages", ...byNetwork((m) => n(m.memos), (c) => n(c.memos))],
                  ["Depositor wallets", ...byNetwork((m) => n(m.depositors), (c) => n(c.depositors))],
                  ["Active wallets", ...byNetwork((m) => n(m.activeWallets), (c) => n(c.activeWallets))],
                  ["Held (priced)", ...byNetwork((m) => fmtUsd(m.heldUsd), (c) => fmtUsd(c.heldUsd))],
                  [
                    "Deposit volume",
                    ...byNetwork(
                      (m) => (m.revenue ? fmtUsd(m.revenue.depositVolume.all) : ""),
                      (c) => (c.revenue ? fmtUsd(c.revenue.depositVolume.all) : "")
                    ),
                  ],
                  [
                    "Cash-out volume",
                    ...byNetwork(
                      (m) => (m.revenue ? fmtUsd(m.revenue.cashoutVolume.all) : ""),
                      (c) => (c.revenue ? fmtUsd(c.revenue.cashoutVolume.all) : "")
                    ),
                  ],
                  [
                    "Cash-out fees",
                    ...byNetwork(
                      (m) => (m.revenue ? fmtUsd(m.revenue.fees.all) : ""),
                      (c) => (c.revenue ? fmtUsd(c.revenue.fees.all) : "")
                    ),
                  ],
                  ["First activity", ...byNetwork((m) => fmtWhen(m.firstActivity), (c) => fmtWhen(c.firstActivity))],
                  ["Last activity", ...byNetwork((m) => fmtWhen(m.lastActivity), (c) => fmtWhen(c.lastActivity))],
                  ["Vault since", ...byNetwork((m) => fmtWhen(m.vaultSince), () => "")],
                  [
                    "Vault",
                    ...byNetwork(
                      (m) => (
                        <a
                          key="v"
                          href={getNetwork(m.key).explorerAddress(m.pool)}
                          target="_blank"
                          rel="noreferrer"
                          className="text-mute transition-colors hover:text-foreground"
                        >
                          {shortAddress(m.pool, 4)} <ArrowUpRight />
                        </a>
                      ),
                      () => ""
                    ),
                  ],
                  ["Read to block", ...byNetwork((m) => `#${m.scannedTo}`, () => "")],
                ]}
                empty={isMain ? "No mainnet vault read yet" : "No testnet vault read yet"}
              />
              <p className="mt-4 text-[13px] leading-relaxed text-mute">
                Current vaults only, {money}. Active wallets deposited or received a cash-out; transfers and trades carry
                no wallet. The total counts a wallet used on both networks once.
              </p>
            </Panel>
          </>
        )}

        {shown === "users" && (
          <>
          <PeoplePanel people={data?.people} env={env} claims={claim.totals.link_claimed} mixedClaims={claim.mixed?.link_claimed ?? 0} full />
          <Panel title="Depositors (by activity)">
            <p className="mb-4 text-[14px] text-mute">
              Unique wallets that deposited into a current vault, per network. A wallet used on both networks shows twice.
            </p>
            <DataTable
              headers={["#", "Network", "Address", "Deposits", "Last deposit", "Explorer"]}
              rows={sideNets
                .flatMap((m) => m.topDepositors.map((u) => ({ ...u, key: m.key, label: nameOf(m) })))
                .sort((a, b) => b.deposits - a.deposits || b.lastTs - a.lastTs)
                .map((u, i) => [
                  String(i + 1),
                  u.label,
                  <span key="addr" className="text-[13px] text-foreground">
                    {u.address}
                  </span>,
                  n(u.deposits),
                  fmtWhen(u.lastTs),
                  <a
                    key="ex"
                    href={getNetwork(u.key).explorerAddress(u.address)}
                    target="_blank"
                    rel="noreferrer"
                    className="text-foreground underline decoration-line-strong underline-offset-4 transition-colors hover:decoration-foreground"
                  >
                    View
                  </a>,
                ])}
              empty="No depositors yet"
            />
          </Panel>
          </>
        )}

        {shown === "events" && (
          <>
            <p className="text-[13px] leading-relaxed text-mute">
              {isMain
                ? "Events from mainnet only, counted for visitors who accepted analytics. Every event has carried its network since mainnet opened on 21 Oct 2026; per-day and per-field counts are split from that evening."
                : "Events from the testnets, counted for visitors who accepted analytics. Events from before networks were tagged (21 Oct 2026) count here."}
            </p>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              {Object.entries(counters)
                .sort((a, b) => b[1] - a[1])
                .map(([k, v]) => (
                  <Kpi key={k} label={k} value={n(v)} sub={NEW_EVENTS.includes(k) ? "count, new" : "count"} />
                ))}
            </div>
            <Panel title="Breakdowns">
              <p className="mb-4 text-[14px] text-mute">
                Kinds, networks and yes or no fields only. Events never carry amounts, names, addresses, labels, notes or
                proofs.
              </p>
              <DataTable
                headers={["Event", "Field", "Value", "Count"]}
                rows={breakdowns.flatMap((g) =>
                  g.list.map((r) => [
                    <span key="e" className="text-foreground">
                      {g.event}
                    </span>,
                    r.field,
                    dimValue(r.field, r.value),
                    n(r.v),
                  ])
                )}
                empty="No breakdowns yet. They fill in as new events arrive."
              />
            </Panel>
            <Panel title="Event stream">
              <DataTable
                headers={["Event", "Path", "Details", "Time"]}
                rows={prod.recent.map((ev) => [
                  <span key="t" className="text-foreground">
                    {ev.t}
                  </span>,
                  ev.path ?? "None",
                  metaText(ev.meta),
                  new Date(ev.ts).toLocaleString(),
                ])}
                empty={isMain ? "No mainnet events among the latest ones" : "No testnet events among the latest ones"}
              />
            </Panel>
            {product?.backend === "memory" && (
              <p className="text-[14px] text-mute">
                Backend is memory. Set Upstash{" "}
                <code className="rounded-md bg-surface px-1.5 py-0.5 text-foreground">
                  UPSTASH_REDIS_REST_*
                </code>{" "}
                and redeploy for durable counts.
              </p>
            )}
          </>
        )}

        {shown === "revenue" && (
          <RevenuePanel
            env={env}
            oc={oc}
            nets={sideNets}
            revenue={revenue}
            rev={rev}
            creator={creator}
            bridgeFeeBps={data?.revenueConfig?.bridgeFeeBps ?? null}
          />
        )}

        {shown === "relay" && <RelayPanel relay={relay} counters={counters} dims={prod.dims} />}

        {shown === "partners" && <PartnersPanel tier={env} />}
        {shown === "testers" && <TestersPanel />}
        {shown === "contest" && <ContestPanel />}
        {shown === "updates" && <UpdatesPanel />}
        {shown === "bugs" && <BugsPanel />}
        {shown === "votes" && <VotesPanel />}
        {shown === "hunt" && <HuntPanel />}

        <p className="tnum text-[12px] text-mute">
          Generated {data?.generatedAt ?? "not yet"} ·{" "}
          <Link
            href="/app"
            className="text-foreground underline decoration-line-strong underline-offset-4 transition-colors hover:decoration-foreground"
          >
            Open app
          </Link>
        </p>
      </main>
    </div>
  );
}

/** Mainnet or Testnet: two separate views, never mixed. */
function EnvSwitch({ env, onChange }: { env: Env; onChange: (e: Env) => void }) {
  return (
    <div role="radiogroup" aria-label="Network" className="flex shrink-0 self-start rounded-full bg-surface-2 p-1 text-[13px] sm:self-auto">
      {(
        [
          ["mainnet", "Mainnet", "bg-sealed"],
          ["testnet", "Testnet", "bg-warn"],
        ] as const
      ).map(([id, label, dot]) => (
        <button
          key={id}
          type="button"
          role="radio"
          aria-checked={env === id}
          onClick={() => onChange(id)}
          className={`inline-flex h-9 items-center gap-2 whitespace-nowrap rounded-full px-4 transition-colors ${
            env === id ? "bg-panel font-medium text-foreground shadow-card" : "text-mute hover:text-foreground"
          }`}
        >
          <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${dot}`} />
          {label}
        </button>
      ))}
    </div>
  );
}

/* ---------------------------------------------------------------- people */

const PEOPLE_ROWS: [keyof PeopleSide["byAction"], string][] = [
  ["connect", "Connected a wallet"],
  ["claim", "Claimed a payment"],
  ["deposit", "Deposited"],
  ["send", "Sent privately"],
  ["swap", "Swapped privately"],
  ["cashout", "Cashed out"],
  ["payroll", "Ran payroll"],
  ["request", "Paid a request"],
];

/**
 * Different wallets using Gloam, for one side: everyone, and by what they did.
 * Counted one way (lib/peopleStore): no address is kept, so there is nothing
 * to list, only how many.
 */
function PeoplePanel({
  people,
  env,
  claims,
  mixedClaims,
  full = false,
}: {
  people: PeopleSummary | undefined;
  env: Env;
  /** Claim-link claims on this side in the last 14 days (lib/funnel): claims, not people. */
  claims: number;
  /** Launch-day claims from before counting by network. */
  mixedClaims: number;
  full?: boolean;
}) {
  const isMain = env === "mainnet";
  if (!people) {
    return (
      <Panel title="People using Gloam">
        <p className="text-[14px] text-mute">After the next read.</p>
      </Panel>
    );
  }
  const side = people[env];
  const rows = PEOPLE_ROWS.map(([k, label]) => ({ k: label, v: side.byAction[k] ?? 0 }));
  const max = Math.max(1, ...rows.map((r) => r.v));
  const bars = rows.map((r) => ({ ...r, pct: (r.v / max) * 100 }));
  const since = people.since
    ? new Date(people.since).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC" })
    : null;
  const claimLine =
    claims + mixedClaims > 0
      ? ` Claim-link claims in the last 14 days: ${n(claims)}${mixedClaims ? `, plus ${n(mixedClaims)} on launch day from either network` : ""}. Those count claims, not people, and include claims from before wallets were counted.`
      : "";
  return (
    <Panel title="People using Gloam">
      {!people.configured && (
        <p className="mb-5 rounded-xl bg-warn-soft px-4 py-3 text-[14px] leading-relaxed text-warn">
          Counting is off. Set <code className="text-foreground">GLOAM_RELAY_MEMO_SECRET</code> or{" "}
          <code className="text-foreground">GLOAM_METRICS_SALT</code> on Vercel to a random secret of 32 or more
          characters (<code className="text-foreground">openssl rand -hex 32</code>) and redeploy. Keep it the same
          from then on: a new one counts everyone again.
        </p>
      )}
      {people.error && (
        <p className="mb-5 rounded-xl bg-danger-soft px-4 py-3 text-[14px] text-danger" role="alert">
          {people.error}
        </p>
      )}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label={isMain ? "People, since launch" : "People, all time"} value={n(side.all)} sub="different wallets" />
        <Kpi label="Today" value={n(side.today)} sub="since 00:00 UTC" />
        <Kpi label="7 days" value={n(side.d7)} sub="UTC days, today included" />
        <Kpi label="30 days" value={n(side.d30)} sub="UTC days, today included" />
      </div>
      <div className={`mt-6 grid grid-cols-1 gap-6 ${full ? "lg:grid-cols-2" : ""}`}>
        <div>
          <p className="t-label mb-4">By what they did, all time</p>
          <BarChart rows={bars} />
          <p className="mt-4 text-[13px] leading-relaxed text-mute">
            Wallets that received a cash out: <span className="tnum text-soft">{n(side.byAction.cashout_to)}</span>, read
            from the chain. Not added to people, since one person can cash out to several addresses; with them, people
            would be <span className="tnum text-soft">{n(side.allWithCashoutTo)}</span>.
          </p>
        </div>
        {full && (
          <div>
            <p className="t-label mb-4">People by day</p>
            <DataTable
              headers={["Day", "People"]}
              rows={side.daily
                .filter((d) => !isMain || d.day >= MAINNET_DAY)
                .reverse()
                .map((d) => [fmtDay(d.day), n(d.people)])}
              empty="No days yet"
              minWidth={240}
            />
          </div>
        )}
      </div>
      <p className="mt-5 text-[13px] leading-relaxed text-mute">
        Different wallets, {isMain ? "mainnet only" : "testnets only"}, counted one way: each address becomes a keyed
        hash that goes into a HyperLogLog, so no address is stored and there is no list to show, only how many. Counts
        are estimates, exact or nearly so at this size. The app counts connects and actions
        {since ? ` since ${since} UTC` : " once counting is on"}, a few minutes after they happen and once per wallet a
        day; depositors are also read from the chain{isMain ? " since launch" : ""}. Recording demos are not counted.
        {claimLine}
      </p>
    </Panel>
  );
}

/* ---------------------------------------------------------------- partners */

type AdminPartner = {
  id: string;
  owner: string;
  name: string;
  website: string | null;
  fees: { privatePaymentCents: number; cashoutBps: number; depositBps: number };
  relayApproved: boolean;
  /** The name approved to show in links, or null. */
  approvedName?: string | null;
  nameAwaitingApproval?: boolean;
  createdAt: number;
  activeKeys: number;
  /** Live link codes. */
  liveCodes?: number;
  /** Receiving addresses for the on-chain match: all, and proven by signature. */
  addresses?: { total: number; verified: number };
  /** "partial:<n>" when older activity outran what could be split into mainnet and testnet. */
  migration?: string | null;
  totals: {
    privatePayments: number;
    cashOuts: number;
    deposits: number;
    privateSwaps?: number;
    publicVolumeUsd: number;
    swapVolumeUsd?: number;
    commissionUsd: number;
    vaultFeeUsd?: number;
    unpriced: number;
    lastActivity: number | null;
    bySource?: Record<"api" | "link" | "chain", { counts: Record<string, number>; volumeUsd: number; vaultFeeUsd: number }>;
  } | null;
};

type PartnersPayload = {
  backend: "redis" | "memory" | "none";
  partners: AdminPartner[];
  totals: {
    privatePayments: number;
    cashOuts: number;
    deposits: number;
    privateSwaps?: number;
    publicVolumeUsd: number;
    swapVolumeUsd?: number;
    commissionUsd: number;
    vaultFeeUsd?: number;
  } | null;
};

/** How many a source brought in, every kind. */
function sourceCount(t: AdminPartner["totals"], s: "api" | "link" | "chain"): number {
  const c = t?.bySource?.[s]?.counts;
  return c ? Object.values(c).reduce((a, b) => a + b, 0) : 0;
}

/**
 * The partner program: every partner, their keys, link codes and receiving
 * addresses, and what they brought in by source (API key, link, matched on chain).
 * Details opens one partner's breakdown, codes and addresses.
 */
function PartnersPanel({ tier }: { tier: "mainnet" | "testnet" }) {
  const [data, setData] = useState<PartnersPayload | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  /** Which button of that row is saving, for its spinner. */
  const [savingWhat, setSavingWhat] = useState<"relay" | "name" | "remove" | null>(null);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  /** The account whose Remove was clicked once: a second click removes it. */
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [removedNote, setRemovedNote] = useState<string | null>(null);

  /** Removes an account for good (lib/partnerRemove), after the inline confirm. */
  const remove = async (p: AdminPartner) => {
    setSaving(p.id);
    setSavingWhat("remove");
    setSaveErr(null);
    setRemovedNote(null);
    try {
      const res = await fetch("/api/partners/admin", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: p.id, remove: true }),
      });
      const json = (await res.json().catch(() => null)) as {
        ok?: boolean;
        data?: { removed?: { keysRevoked?: number; codesRevoked?: number; addressesDropped?: number } };
        error?: { message?: string };
      } | null;
      if (!res.ok || !json?.ok) {
        setSaveErr(json?.error?.message ?? `Removing failed (${res.status})`);
        return;
      }
      const r = json.data?.removed ?? {};
      setRemovedNote(
        `Removed ${p.name}: ${n(r.keysRevoked ?? 0)} keys revoked, ${n(r.codesRevoked ?? 0)} link codes revoked, ${n(r.addressesDropped ?? 0)} addresses dropped.`
      );
      setData((d) => (d ? { ...d, partners: d.partners.filter((x) => x.id !== p.id) } : d));
      setOpen((o) => (o === p.id ? null : o));
      // the program's totals no longer count it
      setReload((v) => v + 1);
    } catch {
      setSaveErr("Network error removing the partner");
    } finally {
      setSaving(null);
      setConfirmRemove(null);
    }
  };

  /** Approves an account for the relay's larger message budget, or its name to show in links, or takes either back. */
  const save = async (id: string, change: { relayApproved: boolean } | { approveName: boolean }) => {
    setSaving(id);
    setSavingWhat("relayApproved" in change ? "relay" : "name");
    setSaveErr(null);
    try {
      const res = await fetch("/api/partners/admin", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, ...change }),
      });
      const json = (await res.json().catch(() => null)) as {
        ok?: boolean;
        data?: { partner?: { relayApproved?: boolean; approvedName?: string | null; nameAwaitingApproval?: boolean } };
        error?: { message?: string };
      } | null;
      if (!res.ok || !json?.ok) {
        setSaveErr(json?.error?.message ?? `Saving failed (${res.status})`);
        return;
      }
      const saved = json.data?.partner ?? {};
      setData((d) =>
        d
          ? {
              ...d,
              partners: d.partners.map((p) =>
                p.id === id
                  ? { ...p, relayApproved: saved.relayApproved === true, approvedName: saved.approvedName ?? null, nameAwaitingApproval: saved.nameAwaitingApproval }
                  : p
              ),
            }
          : d
      );
    } catch {
      setSaveErr("Network error saving the partner");
    } finally {
      setSaving(null);
    }
  };

  useEffect(() => {
    let live = true;
    const load = async () => {
      try {
        const res = await fetch(`/api/partners/admin?tier=${tier}`, { credentials: "include", cache: "no-store" });
        const json = (await res.json().catch(() => null)) as { ok?: boolean; data?: PartnersPayload; error?: { message?: string } } | null;
        if (!live) return;
        if (!res.ok || !json?.ok || !json.data) {
          setErr(json?.error?.message ?? `Partners failed (${res.status})`);
          return;
        }
        setErr(null);
        setData(json.data);
      } catch {
        if (live) setErr("Network error loading partners");
      }
    };
    void load();
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, ADMIN_REFRESH_MS);
    return () => {
      live = false;
      window.clearInterval(id);
    };
  }, [reload, tier]);

  if (err) {
    return (
      <p className="rounded-xl bg-danger-soft px-4 py-3 text-[14px] text-danger" role="alert">
        {err}
      </p>
    );
  }
  if (!data) {
    return (
      <PanelSkeleton label="Loading partners" />
    );
  }
  const openPartner = data.partners.find((p) => p.id === open) ?? null;
  const t = data.totals;
  const pct = (bps: number) => `${(bps / 100).toFixed(2)}%`;
  return (
    <>
      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label="Partners" value={n(data.partners.length)} sub={`${n(data.partners.reduce((s, p) => s + p.activeKeys, 0))} active keys`} />
        <Kpi label="Private payments" value={n(t?.privatePayments)} sub={`through partner keys and links, and ${n(t?.privateSwaps ?? 0)} private swaps`} />
        <Kpi
          label="Public volume"
          value={tier === "testnet" ? "Not priced" : fmtUsd(t?.publicVolumeUsd ?? 0)}
          sub={`${n((t?.cashOuts ?? 0) + (t?.deposits ?? 0))} cash outs and deposits${tier === "testnet" ? ", testnet" : ""}`}
        />
        <Kpi
          label="Vault fees"
          value={tier === "testnet" ? "Not priced" : fmtUsd(t?.vaultFeeUsd ?? 0)}
          sub={`Gloam's cash-out fee on partner flows; would-be partner fees ${fmtUsd(t?.commissionUsd ?? 0)}, ${MAINNET_ENABLED ? "not charged" : "testnet"}`}
        />
      </section>
      <Panel
        title="Partners"
        action={
          <span className="flex flex-wrap gap-1">
            <a href={`/api/partners/admin/export?id=all&type=daily&tier=${tier}`} className="btn btn-ghost btn-sm" download>
              Daily CSV
            </a>
            <a href={`/api/partners/admin/export?id=all&type=transactions&tier=${tier}`} className="btn btn-ghost btn-sm" download>
              Transactions CSV
            </a>
          </span>
        }
      >
        <DataTable
          headers={["Partner", "", "Name in links", "Owner", "Keys", "Codes", "Addresses (proven)", "Messages", "Private payments", "Cash outs", "Deposits", "Swaps", "Via API key", "Via link", "Matched on chain", "Public volume", "Vault fees", "Would-be fees", "Fee setting", "Last payment", "Joined"]}
          rows={data.partners.map((p) => [
            <span key="n" className="text-foreground">
              {p.website ? (
                <a href={p.website} target="_blank" rel="noreferrer" className="underline decoration-line-strong underline-offset-4 hover:decoration-foreground">
                  {p.name}
                </a>
              ) : (
                p.name
              )}
            </span>,
            <span key="d" className="inline-flex items-center gap-2 whitespace-nowrap">
              <button
                type="button"
                aria-expanded={open === p.id}
                onClick={() => setOpen((o) => (o === p.id ? null : p.id))}
                className="rounded-full border border-line px-3 py-1 text-[13px] text-foreground transition-colors hover:border-line-strong"
              >
                {open === p.id ? "Close" : "Details"}
              </button>
              {confirmRemove === p.id ? (
                <>
                  <button
                    type="button"
                    disabled={saving === p.id}
                    onClick={() => void remove(p)}
                    className="rounded-full bg-danger px-3 py-1 text-[13px] text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                  >
                    <BusyLabel busy={saving === p.id && savingWhat === "remove"}>Remove for good</BusyLabel>
                  </button>
                  <button
                    type="button"
                    disabled={saving === p.id}
                    onClick={() => setConfirmRemove(null)}
                    className="rounded-full px-2 py-1 text-[13px] text-mute transition-colors hover:text-foreground disabled:opacity-50"
                  >
                    Cancel
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  disabled={saving === p.id}
                  onClick={() => setConfirmRemove(p.id)}
                  className="rounded-full border border-line px-3 py-1 text-[13px] text-mute transition-colors hover:border-danger hover:text-danger disabled:opacity-50"
                  title="Ends the account. Keys and links stop at once."
                >
                  Remove
                </button>
              )}
            </span>,
            <span key="nm" className="inline-flex items-center gap-2">
              <span className={p.approvedName ? "text-foreground" : "text-mute"} title={p.nameAwaitingApproval ? `Account name now: ${p.name}` : undefined}>
                {p.approvedName ?? "Not shown"}
              </span>
              {p.nameAwaitingApproval ? (
                <button
                  type="button"
                  disabled={saving === p.id}
                  onClick={() => void save(p.id, { approveName: true })}
                  className="rounded-full border border-line px-3 py-1 text-[13px] text-foreground transition-colors hover:border-line-strong disabled:opacity-50"
                  title={`Show "${p.name}" in links as a Gloam partner. Check it is the partner's real name, not Gloam or another brand.`}
                >
                  <BusyLabel busy={saving === p.id && savingWhat === "name"}>Approve {p.name}</BusyLabel>
                </button>
              ) : p.approvedName ? (
                <button
                  type="button"
                  disabled={saving === p.id}
                  onClick={() => void save(p.id, { approveName: false })}
                  className="rounded-full border border-line px-3 py-1 text-[13px] text-mute transition-colors hover:border-line-strong disabled:opacity-50"
                  title="Stop showing this name in links. The account and its keys stay."
                >
                  <BusyLabel busy={saving === p.id && savingWhat === "name"}>Hide name</BusyLabel>
                </button>
              ) : null}
            </span>,
            <span key="o" title={p.owner}>
              {shortAddress(p.owner, 4)}
            </span>,
            n(p.activeKeys),
            n(p.liveCodes ?? 0),
            `${n(p.addresses?.total ?? 0)} (${n(p.addresses?.verified ?? 0)})`,
            <button
              key="r"
              type="button"
              disabled={saving === p.id}
              onClick={() => void save(p.id, { relayApproved: !p.relayApproved })}
              className="rounded-full border border-line px-3 py-1 text-[13px] text-foreground transition-colors hover:border-line-strong disabled:opacity-50"
              title={p.relayApproved ? "Their keys use the larger message budget. Click to take it back." : "Their keys share the small message budget. Click to approve."}
            >
              <BusyLabel busy={saving === p.id && savingWhat === "relay"}>{p.relayApproved ? "Approved" : "Approve"}</BusyLabel>
            </button>,
            n(p.totals?.privatePayments),
            n(p.totals?.cashOuts),
            n(p.totals?.deposits),
            n(p.totals?.privateSwaps ?? 0),
            n(sourceCount(p.totals, "api")),
            n(sourceCount(p.totals, "link")),
            n(sourceCount(p.totals, "chain")),
            tier === "testnet" ? "Not priced" : fmtUsd(p.totals?.publicVolumeUsd ?? 0),
            tier === "testnet" ? "Not priced" : fmtUsd(p.totals?.vaultFeeUsd ?? 0),
            tier === "testnet" ? "Not priced" : fmtUsd(p.totals?.commissionUsd ?? 0),
            `$${(p.fees.privatePaymentCents / 100).toFixed(2)} · ${pct(p.fees.cashoutBps)} · ${pct(p.fees.depositBps)}`,
            p.totals?.lastActivity ? new Date(p.totals.lastActivity).toLocaleString() : "None yet",
            new Date(p.createdAt).toLocaleDateString(),
          ])}
          empty={data.backend === "none" ? "Partner storage is not configured (set Upstash Redis)." : "No partners yet"}
          minWidth={1900}
        />
        {saveErr && (
          <p className="mt-3 text-[13px] text-danger" role="alert">
            {saveErr}
          </p>
        )}
        {removedNote && (
          <p className="mt-3 text-[13px] text-foreground" role="status">
            {removedNote}
          </p>
        )}
        <p className="mt-4 text-[13px] text-mute">
          Remove ends the account: keys and links stop, history is kept but not counted. Hide name keeps the account.
        </p>
        {data.partners.some((p) => p.migration) && (
          <p className="mt-1 text-[13px] text-warn">Some older activity could not be split into mainnet and testnet. See the details.</p>
        )}
        <HowItWorks
          items={[
            "Via API key: payments relayed with a partner key, and deposits partners reported. Checked on chain.",
            "Via link: payments, cash outs and swaps opened from a partner's link. Checked on chain.",
            "Matched on chain: past cash outs to the partner's proven addresses.",
            "Name in links: shows only once approved. A rename needs approving again.",
            "Messages: approved keys get the relay's larger message budget.",
            "Fee setting: per private payment, cash out, deposit.",
            tier === "testnet" ? "Testnet: counted, never valued." : "Mainnet only. Testnet is counted apart.",
            "Only public transaction facts are kept. Never a payer's wallet or IP.",
            `Store: ${data.backend}.`,
          ]}
        />
      </Panel>
      {openPartner && (
        <Panel title={openPartner.name} action={<span className="tnum text-[12.5px] text-mute">{openPartner.id}</span>}>
          <AdminPartnerDetail key={`${openPartner.id}-${tier}`} id={openPartner.id} tier={tier} onChanged={() => setReload((v) => v + 1)} />
        </Panel>
      )}
      <Panel title="On-chain match">
        <AdminBackfill onDone={() => setReload((v) => v + 1)} />
      </Panel>
    </>
  );
}

/**
 * How the money figures are priced, for the notes under them. A mainnet
 * snapshot prices each deposit, cash-out and fee at the time it happened;
 * a testnet one (and a snapshot cached before that) at today's prices.
 */
function flowPricing(oc: OnchainMetrics, isMain: boolean, atToday: string[] | undefined): string {
  if (isMain && oc.prices.flowsAtTime) {
    const late = atToday?.length ? `; ${atToday.join(", ")} at today's price until its price at the time is read` : "";
    return `Priced at the time of each transaction (CoinGecko's hourly price); dollar stablecoins at $1${late}`;
  }
  return `Priced at today's prices: dollar stablecoins at $1, ETH ${oc.prices.ethUsd ? `at ${fmtUsd(oc.prices.ethUsd)}` : "not priced right now"}${
    isMain ? ", $GLOAM from DEX Screener" : ""
  }`;
}

/** "EURC (Base)": what these networks moved with no dollar price, or "" when everything was priced. */
function notInDollars(ms: NetworkMetrics[], name: (m: NetworkMetrics) => string): string {
  return [...new Set(ms.flatMap((m) => (m.revenue?.unpriced ?? []).map((s) => `${s} (${name(m)})`)))].join(", ");
}

/**
 * Gloam's own revenue over the windows, in dollars: the vaults' cash-out fees.
 * $GLOAM creator fees are trading fees on the token's launchpad, not protocol
 * revenue, so they are shown on their own and never added in here.
 */
function revenueTotals(rev: CombinedRevenue) {
  const w = (k: keyof Windowed) => rev.fees[k];
  return { total: { d1: w("d1"), d7: w("d7"), d30: w("d30"), all: w("all") } };
}

function fmtEth(v: number | null | undefined): string {
  if (v == null) return "Unknown";
  if (v > 0 && v < 0.0001) return "<0.0001 ETH";
  return `${v.toLocaleString("en-US", { maximumFractionDigits: 4 })} ETH`;
}

function RevenuePanel({
  env,
  oc,
  nets,
  revenue,
  rev,
  creator,
  bridgeFeeBps,
}: {
  env: Env;
  oc: OnchainMetrics | null;
  /** This side's networks only. */
  nets: NetworkMetrics[];
  revenue: ReturnType<typeof revenueTotals> | null;
  rev: CombinedRevenue | undefined;
  creator: CreatorFees | null;
  bridgeFeeBps: number | null;
}) {
  if (!oc || !rev || !revenue) {
    return (
      <p className="flex items-center gap-2.5 rounded-xl bg-surface px-4 py-3 text-[14px] text-mute" role="status">
        <span className="livedot h-2 w-2 rounded-full bg-foreground/60" />
        {env === "mainnet" ? "Revenue" : "Fees"} appear after the next chain read. Press Refresh.
      </p>
    );
  }
  const isMain = env === "mainnet";
  const noPrice = notInDollars(nets, (m) => adminName(getNetwork(m.key)));
  const word = isMain ? "Revenue" : "Fees";
  const kept = isMain ? "fees kept" : "testnet, not revenue";
  const creatorErr = isMain ? (oc.creator && !("earnedEth" in oc.creator) ? oc.creator.error : (creator?.error ?? null)) : null;
  const bpsOf = (m: NetworkMetrics) => m.revenue?.feeBps;
  const feeLine = nets
    .map((m) => `${adminName(getNetwork(m.key))} ${bpsOf(m) == null ? "unknown" : `${((bpsOf(m) ?? 0) / 100).toFixed(2)}%`}`)
    .join(", ");
  const w = (v: Windowed | null | undefined, k: keyof Windowed) => (v ? fmtUsd(v[k]) : "Unknown");
  const daily = rev.daily
    .filter((d) => !isMain || d.day >= MAINNET_LAUNCH_ISO.slice(0, 10))
    .map((d) => {
      const c = creator?.daily.find((x) => x.day === d.day);
      return { ...d, creatorUsd: c?.usd ?? null, creatorEth: c?.eth ?? 0 };
    })
    .reverse();

  const feesByAsset = (
    <Panel title="Cash-out fees by asset">
      <DataTable
        headers={["Network", "Asset", "Earned", "USD", "Cash-outs", "Waiting", "Collected"]}
        rows={nets.flatMap((m) =>
          (m.revenue?.feeRows ?? []).map((r) => [
            adminName(getNetwork(m.key)),
            r.symbol,
            r.earned,
            fmtUsd(r.earnedUsd),
            n(r.count),
            r.owed ?? "Unknown",
            r.collected,
          ])
        )}
        empty="No cash-out fees yet"
        minWidth={560}
      />
      <p className="mt-4 text-[13px] leading-relaxed text-mute">
        Waiting fees sit in the vault until someone calls collectFees(asset), which sends them to the fee recipient
        {nets[0]?.revenue?.feeRecipient ? ` ${shortAddress(nets[0].revenue.feeRecipient, 4)}` : ""}. Anyone can call it;
        the destination is fixed.
      </p>
    </Panel>
  );

  return (
    <>
      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label={`${word}, 24 hours`} value={fmtUsd(revenue.total.d1)} sub={kept} />
        <Kpi label={`${word}, 7 days`} value={fmtUsd(revenue.total.d7)} sub={kept} />
        <Kpi label={`${word}, 30 days`} value={fmtUsd(revenue.total.d30)} sub={kept} />
        <Kpi
          label={isMain ? `${word} since launch` : `${word}, all time`}
          value={fmtUsd(revenue.total.all)}
          sub={isMain ? "cash-out fees since 21 Oct, 13:00 UTC" : kept}
        />
      </section>

      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label="Deposit volume, 30 days" value={fmtUsd(rev.depositVolume.d30)} sub={`${fmtUsd(rev.depositVolume.all)} ${isMain ? "since launch" : "all time"}`} />
        <Kpi label="Cash-out volume, 30 days" value={fmtUsd(rev.cashoutVolume.d30)} sub={`${fmtUsd(rev.cashoutVolume.all)} ${isMain ? "since launch" : "all time"}`} />
        <Kpi label="Fees waiting to collect" value={fmtUsd(rev.owedUsd)} sub="in the vaults, for collectFees" />
        <Kpi label="Active wallets, 30 days" value={n(rev.users.d30)} sub={`${n(rev.users.d7)} in 7 days, ${n(rev.users.d1)} in 24h`} />
      </section>

      <Panel title={isMain ? "Revenue by source" : "Fees by source"}>
        <DataTable
          headers={["Source", "24 hours", "7 days", "30 days", isMain ? "Since launch" : "All time", "How it is counted"]}
          rows={[
            [
              "Cash-out fees",
              fmtUsd(rev.fees.d1),
              fmtUsd(rev.fees.d7),
              fmtUsd(rev.fees.d30),
              fmtUsd(rev.fees.all),
              `Kept by the ${isMain ? "mainnet" : "testnet"} vaults on each cash-out (${feeLine || "no vault read"})`,
            ],
            ...(isMain
              ? [
                  [
                    "Bridge fee",
                    "",
                    "",
                    "",
                    "",
                    bridgeFeeBps
                      ? `On, ${(bridgeFeeBps / 100).toFixed(2)}%. Paid out by Relay, not read here`
                      : "Off. Bridging and swaps charge nothing on top of Relay",
                  ],
                  ["Partner API fees", "", "", "", "", "Not charged yet. Would-be fees are on the Partners tab"],
                  [
                    <span key="t" className="font-medium text-foreground">
                      Total
                    </span>,
                    fmtUsd(revenue.total.d1),
                    fmtUsd(revenue.total.d7),
                    fmtUsd(revenue.total.d30),
                    fmtUsd(revenue.total.all),
                    "",
                  ],
                ]
              : []),
          ]}
          minWidth={820}
        />
        <p className="mt-4 text-[13px] leading-relaxed text-mute">
          {isMain
            ? "Mainnet only, counted from the mainnet launch (21 Oct 2026, 13:00 UTC). $GLOAM creator fees are trading fees on the token's launchpad, not Gloam revenue, so they are shown on their own below. "
            : "Testnet fees from testing are not revenue. $GLOAM creator fees exist on mainnet only. "}
          {flowPricing(oc, isMain, rev.atToday)}
          {isMain && oc.prices.flowsAtTime ? ". Fees waiting to collect are at today's prices" : ""}
          {noPrice ? `. Not in dollars: ${noPrice}` : ""}. Windows are the last 24 hours, 7 days and 30 days.
        </p>
      </Panel>

      {isMain ? (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {feesByAsset}
          <Panel title="$GLOAM creator fees, not protocol revenue">
            {creator ? (
              <>
                <DataTable
                  headers={["", "ETH", "USD now"]}
                  rows={[
                    [
                      "Earned since mainnet launch",
                      creator.sinceLaunchEth == null ? "Not read yet" : fmtEth(creator.sinceLaunchEth),
                      creator.sinceLaunchUsd == null ? "" : fmtUsd(creator.sinceLaunchUsd),
                    ],
                    ["Earned since the token launched", fmtEth(creator.earnedEth.all), w(creator.earnedUsd, "all")],
                    ["Claimed", fmtEth(creator.claimedEth), oc.prices.ethUsd ? fmtUsd(creator.claimedEth * oc.prices.ethUsd) : "Unknown"],
                    ["Waiting to claim", fmtEth(creator.unclaimedEth), oc.prices.ethUsd ? fmtUsd(creator.unclaimedEth * oc.prices.ethUsd) : "Unknown"],
                    ["Trades that paid a share", n(creator.trades), ""],
                  ]}
                  minWidth={360}
                />
                <p className="mt-4 text-[13px] leading-relaxed text-mute">
                  The token&apos;s 1% creator share of trades on Orynth, which goes to the creator wallet. It is real
                  money, but it comes from trading $GLOAM, not from people using Gloam. Read from the Orynth fee vault{" "}
                  <a
                    href={getNetwork("robinhood-mainnet").explorerAddress(creator.vault)}
                    target="_blank"
                    rel="noreferrer"
                    className="text-mute transition-colors hover:text-foreground"
                  >
                    {shortAddress(creator.vault, 4)} <ArrowUpRight />
                  </a>{" "}
                  for the creator wallet {shortAddress(creator.creator, 4)}.
                  {creator.catchingUp ? " Still reading its history; the next refresh continues." : ""}
                  {creatorErr ? ` The last read failed (${creatorErr}); showing what was read before.` : ""}
                </p>
              </>
            ) : (
              <p className="text-[14px] text-mute">{creatorErr ?? "Not read yet. Creator fees are read once Robinhood Chain mainnet is live."}</p>
            )}
          </Panel>
        </div>
      ) : (
        feesByAsset
      )}

      <Panel title={isMain ? "Daily, since launch" : "Daily, last 30 days"}>
        <DataTable
          headers={
            isMain
              ? ["Day", "Revenue", "Deposits", "Cash-outs", "Transactions", "Active wallets", "Creator fees, not revenue"]
              : ["Day", "Cash-out fees", "Deposits", "Cash-outs", "Transactions", "Active wallets"]
          }
          rows={daily.map((d) =>
            isMain
              ? [
                  fmtDay(d.day),
                  fmtUsd(d.feesUsd),
                  fmtUsd(d.depositUsd),
                  fmtUsd(d.cashoutUsd),
                  n(d.txs),
                  n(d.wallets),
                  d.creatorUsd == null ? fmtEth(d.creatorEth) : fmtUsd(d.creatorUsd),
                ]
              : [fmtDay(d.day), fmtUsd(d.feesUsd), fmtUsd(d.depositUsd), fmtUsd(d.cashoutUsd), n(d.txs), n(d.wallets)]
          )}
          empty="No days yet"
          minWidth={isMain ? 820 : 620}
        />
        <p className="mt-4 text-[13px] leading-relaxed text-mute">
          UTC days, newest first, {isMain ? "mainnet only, from the launch at 13:00 UTC on 21 Oct" : "testnets only"}. Revenue is
          cash-out fees, a private swap&apos;s included. Deposits and cash-outs are dollar volume; transactions count
          deposits, private transfers, cash-outs and private swaps (one each).
          {isMain
            ? ` Creator fees on launch day include trades from before 13:00, and are placed in days by block${
                oc.prices.flowsAtTime ? "; each day's are priced at that day's average ETH price" : ""
              }.`
            : ""}
        </p>
      </Panel>
    </>
  );
}

type TesterRow = {
  id: string;
  name: string;
  telegram: string;
  x: string | null;
  address: string;
  network: "both" | "tempo" | "robinhood";
  setup: string | null;
  note: string | null;
  paid?: boolean;
  createdAt: number;
};

const TESTER_NETWORK: Record<TesterRow["network"], string> = { both: "Any", tempo: "Tempo", robinhood: "Robinhood Chain" };

function TestersPanel() {
  const [data, setData] = useState<{ backend: string; cap: number; applications: TesterRow[]; loadedAt: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const load = async () => {
      try {
        const res = await fetch("/api/testers", { credentials: "include", cache: "no-store" });
        const json = (await res.json().catch(() => null)) as
          | { ok?: boolean; data?: { backend: string; cap: number; applications: TesterRow[] }; error?: { message?: string } }
          | null;
        if (!live) return;
        if (!res.ok || !json?.ok || !json.data) {
          setErr(json?.error?.message ?? `Testers failed (${res.status})`);
          return;
        }
        setErr(null);
        setData({ ...json.data, loadedAt: Date.now() });
      } catch {
        if (live) setErr("Network error loading testers");
      }
    };
    void load();
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, ADMIN_REFRESH_MS);
    return () => {
      live = false;
      window.clearInterval(id);
    };
  }, []);

  if (err) {
    return (
      <p className="rounded-xl bg-danger-soft px-4 py-3 text-[14px] text-danger" role="alert">
        {err}
      </p>
    );
  }
  if (!data) {
    return (
      <p className="flex items-center gap-2.5 rounded-xl bg-surface px-4 py-3 text-[14px] text-mute" role="status">
        <span className="livedot h-2 w-2 rounded-full bg-foreground/60" />
        Loading testers
      </p>
    );
  }
  const apps = data.applications;
  const dayAgo = data.loadedAt - 86_400_000;
  const paid = apps.filter((a) => a.paid !== false).length;
  return (
    <>
      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label="Applications" value={n(apps.length)} sub={`${n(apps.filter((a) => a.createdAt > dayAgo).length)} in the last 24h`} />
        <Kpi
          label="Paid spots"
          value={`${n(paid)} / ${n(data.cap)}`}
          sub={paid >= data.cap ? "Full, new testers are volunteers" : `${n(data.cap - paid)} left`}
        />
        <Kpi label="Volunteers" value={n(apps.length - paid)} sub="joined after paid spots filled" />
        <Kpi label="Rewards owed" value={fmtUsd(paid * 10)} sub="$10 per paid tester" />
      </section>
      <Panel
        title="Tester applications"
        action={
          <a href="/api/testers?format=csv" className="btn btn-ghost btn-sm">
            Download CSV
          </a>
        }
      >
        <DataTable
          headers={["Name", "Spot", "Telegram", "X", "EVM address", "Network", "Device and wallet", "Note", "Applied"]}
          rows={apps.map((a) => [
            <span key="n" className="text-foreground">
              {a.name}
            </span>,
            a.paid !== false ? "Paid" : "Volunteer",
            <a key="t" href={`https://t.me/${a.telegram}`} target="_blank" rel="noreferrer" className="underline decoration-line-strong underline-offset-4 hover:decoration-foreground">
              @{a.telegram}
            </a>,
            a.x ? (
              <a key="x" href={`https://x.com/${a.x}`} target="_blank" rel="noreferrer" className="underline decoration-line-strong underline-offset-4 hover:decoration-foreground">
                @{a.x}
              </a>
            ) : (
              "None"
            ),
            <span key="a" title={a.address}>
              {shortAddress(a.address, 4)}
            </span>,
            TESTER_NETWORK[a.network] ?? a.network,
            a.setup ?? "None",
            <span key="note" title={a.note ?? undefined} className="block max-w-[260px] truncate">
              {a.note ?? "None"}
            </span>,
            new Date(a.createdAt).toLocaleString(),
          ])}
          empty={data.backend === "none" ? "Tester storage is not configured (set Upstash Redis)." : "No applications yet"}
          minWidth={1180}
        />
        <p className="mt-4 text-[13px] leading-relaxed text-mute">
          Approve Telegram join requests that match an application. The CSV has full addresses for paying rewards. Store:{" "}
          {data.backend}.
        </p>
      </Panel>
    </>
  );
}

type ContestRow = {
  name: string;
  handle: string;
  postUrl: string;
  postUser: string;
  postId: string;
  videoUrl?: string | null;
  note: string | null;
  email: string | null;
  network: ContestNetwork;
  submittedAt: number;
  updatedAt: number;
  revisions?: number;
  previousPosts?: string[];
};

/** Video contest entries (gloam.trade/contest), newest first, and the CSV. Read only. */
function ContestPanel() {
  const [data, setData] = useState<{ backend: string; entries: ContestRow[]; loadedAt: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const load = async () => {
      try {
        const res = await fetch("/api/contest/entries", { credentials: "include", cache: "no-store" });
        const json = (await res.json().catch(() => null)) as
          | { ok?: boolean; data?: { backend: string; entries: ContestRow[] }; error?: { message?: string } }
          | null;
        if (!live) return;
        if (!res.ok || !json?.ok || !json.data) {
          setErr(json?.error?.message ?? `Contest entries failed (${res.status})`);
          return;
        }
        setErr(null);
        setData({ ...json.data, loadedAt: Date.now() });
      } catch {
        if (live) setErr("Network error loading contest entries");
      }
    };
    void load();
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, ADMIN_REFRESH_MS);
    return () => {
      live = false;
      window.clearInterval(id);
    };
  }, []);

  if (err) {
    return (
      <p className="rounded-xl bg-danger-soft px-4 py-3 text-[14px] text-danger" role="alert">
        {err}
      </p>
    );
  }
  if (!data) return <PanelSkeleton label="Loading contest entries" />;

  const entries = data.entries;
  const dayAgo = data.loadedAt - 86_400_000;
  const differs = (e: ContestRow) => e.postUser.toLowerCase() !== e.handle.toLowerCase();
  // the same post entered under more than one handle
  const postCount = new Map<string, number>();
  for (const e of entries) postCount.set(e.postId, (postCount.get(e.postId) ?? 0) + 1);
  const shared = (e: ContestRow) => (postCount.get(e.postId) ?? 0) > 1;
  const link = "underline decoration-line-strong underline-offset-4 hover:decoration-foreground";
  return (
    <>
      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label="Entries" value={n(entries.length)} sub={`${n(entries.filter((e) => e.submittedAt > dayAgo).length)} new in the last 24h`} />
        <Kpi label="Updated" value={n(entries.filter((e) => (e.revisions ?? 0) > 0).length)} sub="sent again with the same handle" />
        <Kpi label="Flagged" value={n(entries.filter((e) => differs(e) || shared(e)).length)} sub="post account differs, or post reused" />
        <Kpi label="With email" value={n(entries.filter((e) => e.email).length)} sub="for reaching winners" />
      </section>
      <Panel
        title="Contest entries"
        action={
          <a href="/api/contest/entries?format=csv" className="btn btn-ghost btn-sm">
            Download CSV
          </a>
        }
      >
        <DataTable
          headers={["Name", "X handle", "Post on X", "Full video", "Flag", "Network", "What it shows", "Email", "Submitted", "Updated"]}
          rows={entries.map((e) => [
            <span key="n" className="text-foreground">
              {e.name}
            </span>,
            <a key="h" href={`https://x.com/${e.handle}`} target="_blank" rel="noreferrer" className={link}>
              @{e.handle}
            </a>,
            <a
              key="p"
              href={e.postUrl}
              target="_blank"
              rel="noreferrer"
              title={(e.previousPosts ?? []).length ? `Earlier: ${(e.previousPosts ?? []).join(" ")}` : e.postUrl}
              className={link}
            >
              @{e.postUser}/{e.postId.slice(-6)}
            </a>,
            // https only, checked on the server (lib/contest normalizeVideoUrl)
            e.videoUrl?.startsWith("https://") ? (
              <a key="v" href={e.videoUrl} target="_blank" rel="noreferrer noopener" title={e.videoUrl} className={`${link} block max-w-[200px] truncate`}>
                {e.videoUrl.replace(/^https:\/\/(www\.)?/, "")}
              </a>
            ) : (
              "None"
            ),
            differs(e) || shared(e) ? (
              <span key="f" className="text-danger">
                {[differs(e) ? "Post is not by this handle" : null, shared(e) ? "Same post as another entry" : null]
                  .filter(Boolean)
                  .join(". ")}
              </span>
            ) : (
              "None"
            ),
            CONTEST_NETWORK_LABEL[e.network] ?? e.network,
            <span key="note" title={e.note ?? undefined} className="block max-w-[260px] truncate">
              {e.note ?? "None"}
            </span>,
            e.email ?? "None",
            new Date(e.submittedAt).toLocaleString(),
            (e.revisions ?? 0) > 0 ? `${new Date(e.updatedAt).toLocaleString()} (${e.revisions}x)` : "Not updated",
          ])}
          empty={data.backend === "none" ? "Contest storage is not configured (set Upstash Redis)." : "No entries yet"}
          minWidth={1400}
        />
        <p className="mt-4 text-[13px] leading-relaxed text-mute">
          One entry per X handle; sending again replaces it. Check each post quotes the announcement with the hashtag
          before judging. Hover a post link for posts an entry replaced. Store: {data.backend}.
        </p>
      </Panel>
    </>
  );
}

type UpdatesData = { backend: string; count: number; bySource: { "sign-in": number; settings: number; site: number } };

/**
 * The "Email me Gloam updates" list: how many, from where, and the CSV. The
 * emails themselves are only in the CSV, which holds email, day and source
 * (and each person's unsubscribe link), nothing about wallets.
 */
function UpdatesPanel() {
  const [data, setData] = useState<UpdatesData | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const load = async () => {
      try {
        const res = await fetch("/api/updates", { credentials: "include", cache: "no-store" });
        const json = (await res.json().catch(() => null)) as { ok?: boolean; data?: UpdatesData; error?: { message?: string } } | null;
        if (!live) return;
        if (!res.ok || !json?.ok || !json.data) {
          setErr(json?.error?.message ?? `Updates list failed (${res.status})`);
          return;
        }
        setErr(null);
        setData(json.data);
      } catch {
        if (live) setErr("Network error loading the updates list");
      }
    };
    void load();
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, ADMIN_REFRESH_MS);
    return () => {
      live = false;
      window.clearInterval(id);
    };
  }, []);

  if (err) {
    return (
      <p className="rounded-xl bg-danger-soft px-4 py-3 text-[14px] text-danger" role="alert">
        {err}
      </p>
    );
  }
  if (!data) {
    return (
      <PanelSkeleton label="Loading the updates list" />
    );
  }
  return (
    <>
      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label="Subscribed" value={n(data.count)} sub="emails on the list" />
        <Kpi label="From sign-in" value={n(data.bySource["sign-in"])} sub="Gloam wallet sign-in" />
        <Kpi label="From Settings" value={n(data.bySource.settings)} sub="in the app" />
        <Kpi label="From the site" value={n(data.bySource.site)} sub="footer field" />
      </section>
      <Panel
        title="Email updates list"
        action={
          <a href="/api/updates?format=csv" className="btn btn-ghost btn-sm">
            Download CSV
          </a>
        }
      >
        <p className="text-[13px] leading-relaxed text-mute">
          The CSV has each email, the day it joined and where, plus its unsubscribe link for the bottom of an update. Emails
          are kept alone: no wallet, address or IP is stored with them. Store: {data.backend}.
        </p>
      </Panel>
    </>
  );
}

type HuntData = {
  backend: string;
  setup: Record<string, boolean>;
  reached: { page: number; riddle: number; glim: number; mcp: number } | null;
  prize: "claimed" | "unclaimed" | "unknown" | "unchecked";
};

const PRIZE_TEXT: Record<HuntData["prize"], [string, string]> = {
  claimed: ["Claimed", "the prize note is spent on chain"],
  unclaimed: ["Not yet", "the prize note is unspent on chain"],
  unknown: ["Unknown", "the chain didn't answer just now"],
  unchecked: ["Not checked", "set HUNT_PRIZE_NULLIFIER to check"],
};

/** The treasure hunt: how many people reached each step, and whether the prize is claimed. Counts only; the clues stay in the server's settings. */
function HuntPanel() {
  const [data, setData] = useState<HuntData | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const load = async () => {
      try {
        const res = await fetch("/api/admin/hunt", { credentials: "include", cache: "no-store" });
        const json = (await res.json().catch(() => null)) as { ok?: boolean; data?: HuntData; error?: { message?: string } } | null;
        if (!live) return;
        if (!res.ok || !json?.ok || !json.data) {
          setErr(json?.error?.message ?? `Hunt failed (${res.status})`);
          return;
        }
        setErr(null);
        setData(json.data);
      } catch {
        if (live) setErr("Network error loading the hunt");
      }
    };
    void load();
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, ADMIN_REFRESH_MS);
    return () => {
      live = false;
      window.clearInterval(id);
    };
  }, []);

  if (err) {
    return (
      <p className="rounded-xl bg-danger-soft px-4 py-3 text-[14px] text-danger" role="alert">
        {err}
      </p>
    );
  }
  if (!data) {
    return (
      <p className="flex items-center gap-2.5 rounded-xl bg-surface px-4 py-3 text-[14px] text-mute" role="status">
        <span className="livedot h-2 w-2 rounded-full bg-foreground/60" />
        Loading the hunt
      </p>
    );
  }
  const r = data.reached;
  const solved = r ? [r.riddle, r.glim, r.mcp].filter((v) => v > 0).length : 0;
  const on = (v: boolean | undefined) => (v ? "Set" : "Not set");
  const [prize, prizeSub] = PRIZE_TEXT[data.prize] ?? PRIZE_TEXT.unknown;
  return (
    <>
      <section className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Kpi label="Found the hidden page" value={r ? n(r.page) : "None"} sub="from the page source, piece 1" />
        <Kpi label="Solved the riddle" value={r ? n(r.riddle) : "None"} sub="on the hidden page, piece 2" />
        <Kpi label="Asked Glim" value={r ? n(r.glim) : "None"} sub="with the passphrase, piece 3" />
        <Kpi label="Got the prize link" value={r ? n(r.mcp) : "None"} sub="MCP key with pieces 1 to 3" />
        <Kpi label="Prize" value={prize} sub={prizeSub} />
      </section>
      <Panel title="Hunt">
        <DataTable
          headers={["Part", "State"]}
          rows={[
            ["Hunt", data.setup.enabled ? "On" : "Off"],
            ["Page source clue", on(data.setup.source)],
            ["Hidden page", on(data.setup.page)],
            ["Glim passphrase", on(data.setup.glim)],
            ["MCP key", on(data.setup.mcp)],
            ["Pieces 1 to 3", on(data.setup.pieces)],
            ["Prize link", on(data.setup.prizeLink)],
            ["Prize check (nullifier)", on(data.setup.prizeCheck)],
          ]}
          empty="Nothing set"
          minWidth={420}
        />
        <p className="mt-4 text-[13px] leading-relaxed text-mute">
          {r ? `${n(solved)} of 3 clues solved by someone so far. ` : ""}
          Counts are distinct people per step, estimated, from a one-way hash: no addresses or accounts are kept. The home page clue is fixed at build time, so redeploy after changing it. Store: {data.backend}.
        </p>
      </Panel>
    </>
  );
}

type BugRow = {
  id: string;
  userId: number;
  username: string | null;
  firstName: string;
  thread: string;
  text: string;
  link: string | null;
  createdAt: number;
};

/** Bug reports the Telegram helper saved from Testers, Feedback and /bug. Read only. */
function BugsPanel() {
  const [data, setData] = useState<{ backend: string; reports: BugRow[]; loadedAt: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const load = async () => {
      try {
        const res = await fetch("/api/admin/bugs", { credentials: "include", cache: "no-store" });
        const json = (await res.json().catch(() => null)) as
          | { ok?: boolean; data?: { backend: string; reports: BugRow[] }; error?: { message?: string } }
          | null;
        if (!live) return;
        if (!res.ok || !json?.ok || !json.data) {
          setErr(json?.error?.message ?? `Bug reports failed (${res.status})`);
          return;
        }
        setErr(null);
        setData({ ...json.data, loadedAt: Date.now() });
      } catch {
        if (live) setErr("Network error loading bug reports");
      }
    };
    void load();
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, ADMIN_REFRESH_MS);
    return () => {
      live = false;
      window.clearInterval(id);
    };
  }, []);

  if (err) {
    return (
      <p className="rounded-xl bg-danger-soft px-4 py-3 text-[14px] text-danger" role="alert">
        {err}
      </p>
    );
  }
  if (!data) {
    return (
      <p className="flex items-center gap-2.5 rounded-xl bg-surface px-4 py-3 text-[14px] text-mute" role="status">
        <span className="livedot h-2 w-2 rounded-full bg-foreground/60" />
        Loading bug reports
      </p>
    );
  }
  const reports = data.reports;
  const dayAgo = data.loadedAt - 86_400_000;
  const people = new Set(reports.map((r) => r.userId)).size;
  return (
    <>
      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label="Reports" value={n(reports.length)} sub={`${n(reports.filter((r) => r.createdAt > dayAgo).length)} in the last 24h`} />
        <Kpi label="Reporters" value={n(people)} sub="people on Telegram" />
      </section>
      <Panel title="Bug reports">
        <DataTable
          headers={["From", "Where", "Report", "Message", "Reported"]}
          rows={reports.map((r) => [
            r.username ? (
              <a key="u" href={`https://t.me/${r.username}`} target="_blank" rel="noreferrer" className="underline decoration-line-strong underline-offset-4 hover:decoration-foreground">
                {r.firstName || r.username} (@{r.username})
              </a>
            ) : (
              <span key="u" className="text-foreground">
                {r.firstName || `User ${r.userId}`}
              </span>
            ),
            r.thread,
            <span key="t" title={r.text} className="block max-w-[420px] truncate">
              {r.text}
            </span>,
            r.link ? (
              <a key="l" href={r.link} target="_blank" rel="noreferrer" className="underline decoration-line-strong underline-offset-4 hover:decoration-foreground">
                Open
              </a>
            ) : (
              "None"
            ),
            new Date(r.createdAt).toLocaleString(),
          ])}
          empty={data.backend === "none" ? "Bug storage is not configured (set Upstash Redis)." : "No bug reports yet"}
          minWidth={980}
        />
        <p className="mt-4 text-[13px] leading-relaxed text-mute">
          Saved by the Telegram helper from Testers, Feedback and /bug. Hover a report for the full text. Store: {data.backend}.
        </p>
      </Panel>
    </>
  );
}

/** A network's name; "testnet" is added once a mainnet sits beside it. */
/** The chains Gloam runs on, one side, as words: "Robinhood Chain, Tempo, Base and Ethereum" on mainnet. */
function chainsOn(side: "mainnet" | "testnet"): string {
  const labels = [...new Set(NETWORK_KEYS.map(getNetwork).filter((n) => n.testnet === (side === "testnet")).map((n) => n.label))];
  if (!labels.length) return "Robinhood Chain and Tempo";
  return labels.length > 1 ? `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}` : labels[0]!;
}

function adminName(n: GloamNetwork): string {
  return MAINNET_ENABLED ? networkName(n) : n.label;
}

/** Chain ids read as network names in the breakdowns. */
function dimValue(field: string, value: string): string {
  if (field === "chainId") {
    const net = NETWORK_KEYS.map(getNetwork).find((x) => String(x.chainId) === value);
    return net ? `${adminName(net)} (${value})` : value;
  }
  if (field === "network" && isNetworkKey(value)) return adminName(getNetwork(value));
  return value;
}

function metaText(meta: Record<string, unknown> | null): string {
  if (!meta) return "None";
  const parts = Object.entries(meta)
    .filter(([, v]) => v !== null && v !== undefined)
    .map(([k, v]) => `${k} ${String(v)}`);
  return parts.length ? parts.join(", ").slice(0, 80) : "None";
}

const RELAY_FUNNEL: [string, string][] = [
  ["bridge_address_created", "Deposit addresses made"],
  ["bridge_arrived", "Bridges that arrived"],
  ["swap_review", "Swaps reviewed"],
  ["swap_submit", "Swaps sent from a wallet"],
  ["swap_success", "Swaps that landed"],
];

/** Bridges in through Relay deposit addresses, and same-chain swaps of the gas coin. */
function RelayPanel({
  relay,
  counters,
  dims,
}: {
  relay: RelayVolume | { error: string } | undefined;
  counters: Record<string, number>;
  dims: Record<string, number>;
}) {
  const funnelMax = Math.max(1, ...RELAY_FUNNEL.map(([k]) => counters[k] ?? 0));
  const funnel = RELAY_FUNNEL.map(([k, label]) => ({ k: label, v: counters[k] ?? 0, sub: k, pct: ((counters[k] ?? 0) / funnelMax) * 100 }));
  const bySourceEvents = Object.entries(dims)
    .map(([key, v]) => {
      const m = /^(bridge_address_created|bridge_arrived)\|source=(.+)$/.exec(key);
      return m ? { event: m[1]!, source: m[2]!, v } : null;
    })
    .filter((x): x is { event: string; source: string; v: number } => x !== null);
  const sources = [...new Set(bySourceEvents.map((x) => x.source))];
  const eventRows = sources
    .map((src) => {
      const made = bySourceEvents.find((x) => x.source === src && x.event === "bridge_address_created")?.v ?? 0;
      const arrived = bySourceEvents.find((x) => x.source === src && x.event === "bridge_arrived")?.v ?? 0;
      return { src, made, arrived };
    })
    .sort((a, b) => b.arrived - a.arrived || b.made - a.made);

  const live = relay && "enabled" in relay && relay.enabled ? relay : null;
  const off = relay && "enabled" in relay && !relay.enabled ? relay.reason : null;
  const failed = relay && "error" in relay ? relay.error : null;

  return (
    <>
      {live ? (
        <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Kpi label="Bridged in, 30 days" value={fmtUsd(live.last30.bridge.inUsd)} sub={`${n(live.last30.bridge.count)} bridges, ${fmtUsd(live.all.bridge.inUsd)} all time`} />
          <Kpi label="Swapped, 30 days" value={fmtUsd(live.last30.swap.inUsd)} sub={`${n(live.last30.swap.count)} swaps, ${fmtUsd(live.all.swap.inUsd)} all time`} />
          <Kpi
            label="Finished, all time"
            value={n(live.all.bridge.count + live.all.swap.count)}
            sub={`${n(live.refunded)} refunded, ${n(live.failed)} failed, ${n(live.pending)} in flight`}
          />
          <Kpi label="Fees paid to Relay" value={fmtUsd(live.all.bridge.feeUsd + live.all.swap.feeUsd)} sub={`${fmtUsd(live.last30.bridge.feeUsd + live.last30.swap.feeUsd)} in 30 days, paid by users`} />
        </section>
      ) : (
        <p className={`rounded-xl px-4 py-3 text-[14px] leading-relaxed ${failed ? "bg-danger-soft text-danger" : "bg-surface text-soft"}`}>
          {failed
            ? `Relay: ${failed}`
            : `Volume from Relay is off. ${off ?? ""} Add RELAY_API_KEY on Vercel to tag new quotes as gloam.trade and read them back here. Until then, the counts below come from product events and carry no amounts.`}
        </p>
      )}

      {live?.historyError ? (
        <p className="rounded-xl bg-danger-soft px-4 py-3 text-[14px] leading-relaxed text-danger">
          Relay&apos;s history didn&apos;t answer ({live.historyError}). These figures are what Gloam has on record so far, so the newest swaps may be missing.
        </p>
      ) : live?.history === "v2" ? (
        <p className="rounded-xl bg-surface px-4 py-3 text-[14px] leading-relaxed text-soft">
          Add RELAY_API_KEY_ID on Vercel before 24 November 2026. Relay retires the history read this page uses on that day, and new swaps stop counting here without it.
        </p>
      ) : null}

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <Panel title="Funnel">
          <BarChart rows={funnel} />
          <p className="mt-5 text-[13px] leading-relaxed text-mute">
            Product events, counted only for visitors who accepted analytics. They carry the chain and token, never an
            amount, wallet or transaction.
          </p>
        </Panel>
        <Panel title="By source chain">
          {live ? (
            <DataTable
              headers={["Source", "Kind", "Finished", "Volume", "Relay fees"]}
              rows={live.bySource.map((r) => [relayChainName(r.chainId), r.kind === "swap" ? "Swap" : "Bridge", n(r.count), fmtUsd(r.inUsd), fmtUsd(r.feeUsd)])}
              empty="Nothing counted yet"
              minWidth={460}
            />
          ) : (
            <DataTable
              headers={["Source", "Addresses made", "Arrived"]}
              rows={eventRows.map((r) => [r.src, n(r.made), n(r.arrived)])}
              empty="No bridge events yet"
              minWidth={360}
            />
          )}
        </Panel>
      </div>

      {live && (
        <>
          <Panel title="Last 30 days">
            <DataTable
              headers={["Day", "Bridges", "Bridged", "Swaps", "Swapped", "Relay fees"]}
              rows={[...live.daily]
                .reverse()
                .filter((d) => d.bridges + d.swaps > 0)
                .map((d) => [fmtDay(d.day), n(d.bridges), fmtUsd(d.bridgeUsd), n(d.swaps), fmtUsd(d.swapUsd), fmtUsd(d.feeUsd)])}
              empty="No finished bridges or swaps in the last 30 days"
              minWidth={560}
            />
            <p className="mt-4 text-[13px] leading-relaxed text-mute">
              UTC days, finished requests only, valued in dollars by Relay when each one was made.
              {live.since ? ` Counted since ${fmtWhen(live.since)}.` : " Nothing counted yet."}
              {" Older bridges were never tagged at Relay, so they can't be recovered."}
              {live.truncated ? " More requests exist than one refresh reads, so totals are a floor." : ""}
            </p>
          </Panel>
          <Panel title="Recent">
            <DataTable
              headers={["Kind", "From", "Sent", "Received", "Status", "Tx", "When"]}
              rows={live.recent.map((r) => [
                r.kind === "swap" ? "Swap" : "Bridge",
                relayChainName(r.fromChainId),
                `${r.inAmount ? Number(r.inAmount).toLocaleString("en-US", { maximumFractionDigits: 6 }) : ""} ${r.inSymbol}`.trim(),
                `${r.outAmount ? Number(r.outAmount).toLocaleString("en-US", { maximumFractionDigits: 2 }) : ""} ${r.outSymbol}`.trim(),
                r.stage === "done" ? "Done" : r.stage === "refunded" ? "Refunded" : r.stage === "failed" ? "Failed" : "In flight",
                r.tx ? (
                  <a
                    key="t"
                    href={`https://relay.link/transaction/${r.tx}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-mute transition-colors hover:text-foreground"
                  >
                    {r.tx.slice(0, 10)}… <ArrowUpRight />
                  </a>
                ) : (
                  ""
                ),
                fmtWhen(r.ts),
              ])}
              empty="No requests yet"
              minWidth={720}
            />
            <p className="mt-4 text-[13px] leading-relaxed text-mute">
              Wallets are left out on purpose. Relay holds the full record.
            </p>
          </Panel>
        </>
      )}
    </>
  );
}

/** Four figures and a panel, held in place while a tab's data loads. */
function PanelSkeleton({ label }: { label: string }) {
  return (
    <div role="status" aria-busy="true" className="space-y-3">
      <span className="sr-only">{label}</span>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="gl-skeleton h-[104px] rounded-[16px] sm:h-[120px]" aria-hidden />
        ))}
      </div>
      <div className="gl-skeleton h-[220px] rounded-[16px]" aria-hidden />
    </div>
  );
}

export function Kpi({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="gl-card min-w-0 px-4 py-4 sm:px-5 sm:py-5">
      <p className="t-label text-balance">{label}</p>
      <p className="tnum mt-3 truncate text-[22px] font-light leading-none tracking-[-0.02em] text-foreground sm:text-[30px]">
        {value}
      </p>
      {sub && <p className="mt-2 line-clamp-2 text-[12px] leading-snug text-mute">{sub}</p>}
    </div>
  );
}

export function Panel({
  title,
  children,
  action,
}: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <section className="gl-card min-w-0 p-5 sm:p-6">
      <div className="mb-5 flex items-center justify-between gap-2">
        <h2 className="text-[17px] tracking-[-0.01em] text-foreground">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function BarChart({
  rows,
}: {
  rows: { k: string; v: number; pct: number; sub?: string }[];
}) {
  if (rows.length === 0) {
    return <p className="text-[14px] text-mute">No data</p>;
  }
  return (
    <ul className="space-y-4">
      {rows.map((r) => (
        <li key={r.k}>
          <div className="mb-1.5 flex items-baseline justify-between gap-2 text-[13px]">
            <span className="min-w-0 truncate text-mute">
              {r.k}
              {r.sub && <span className="ml-2 text-[12px] text-faint">{r.sub}</span>}
            </span>
            <span className="tnum shrink-0 text-foreground">{r.v.toLocaleString("en-US")}</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-surface">
            <div
              className="h-full rounded-full bg-foreground transition-[width] duration-500"
              style={{ width: `${Math.max(r.pct, r.v > 0 ? 4 : 0)}%` }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}

export function DataTable({
  headers,
  rows,
  empty,
  minWidth = 480,
}: {
  headers: string[];
  rows: ReactNode[][];
  empty?: string;
  minWidth?: number;
}) {
  if (rows.length === 0) {
    return <p className="text-[14px] text-mute">{empty ?? "No rows"}</p>;
  }
  return (
    <div className="overflow-x-auto rounded-xl border border-line">
      <table className="tnum w-full text-left text-[14px]" style={{ minWidth }}>
        <thead className="border-b border-line bg-surface">
          <tr>
            {headers.map((h, i) => (
              <th key={`${h}-${i}`} className="t-label px-4 py-3 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr
              key={i}
              className="border-b border-line transition-colors last:border-0 hover:bg-surface"
            >
              {row.map((cell, j) => (
                <td key={j} className="h-[52px] whitespace-nowrap px-4 py-2 text-soft">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
