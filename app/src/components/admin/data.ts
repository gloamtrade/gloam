"use client";

/**
 * The admin's data: the metrics payload, the mainnet/testnet split of product
 * events and claim links, and the small pure helpers the tabs share. Nothing
 * here fetches except `useAdminResource`, which every tab with its own
 * endpoint uses so loading, refresh and errors behave the same everywhere.
 */
import { useEffect, useState } from "react";
import { MAINNET_ENABLED, NETWORK_KEYS, getNetwork, isNetworkKey, networkName, type GloamNetwork } from "@/lib/networks";
import type { CombinedRevenue, NetworkMetrics, OnchainMetrics, Windowed } from "@/lib/onchainMetrics";
import type { DailyCounters, StoredEvent } from "@/lib/tractionStore";
import type { FunnelDay } from "@/lib/funnelStore";
import type { PeopleSummary } from "@/lib/peopleStore";
import type { RelayVolume } from "@/lib/relayVolume";
import { fmtUsd } from "./format";

export type MetricsPayload = {
  ok: boolean;
  generatedAt?: string;
  launch?: {
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

export type Tab =
  | "overview"
  | "revenue"
  | "relay"
  | "users"
  | "events"
  | "partners"
  | "testers"
  | "contest"
  | "updates"
  | "bugs"
  | "votes"
  | "hunt";

/** The two views: mainnet or the testnets. Never mixed. */
export type Env = "mainnet" | "testnet";

/** How often an open admin tab refreshes. Only while it is on screen: each refresh reads Redis. */
export const ADMIN_REFRESH_MS = 60_000;

/** Mainnet opened on this UTC day (21 Oct 2026, 13:00 UTC). No mainnet event is older. */
export const MAINNET_DAY = "2026-10-21";

/** Events added for proofs, the public ledger, requests and notes; shown first in the breakdowns. */
export const NEW_EVENTS = [
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
export const PAYROLL_KEYS = ["payroll_run_finished", "payroll_run_success", "payroll_run_paid", "payroll_run", "payroll_run_submit", "payroll_paid"];

export function isMainnetNetwork(value: string): boolean {
  return isNetworkKey(value) && !getNetwork(value).testnet;
}

function isMainnetChainId(value: string): boolean {
  return NETWORK_KEYS.some((k) => !getNetwork(k).testnet && String(getNetwork(k).chainId) === value);
}

type ProductSummary = NonNullable<MetricsPayload["product"]>;

export type SideProduct = {
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
export function splitProduct(p: ProductSummary | undefined, env: Env): SideProduct {
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

export type ClaimCounts = { link_created: number; link_opened: number; link_claimed: number; claimer_sent: number };

/** One day of claim-link counts for a side; a day stored before the split is all testnet. */
export function claimSide(r: FunnelDay, env: Env): ClaimCounts {
  if (r.mainnet && r.testnet) return r[env];
  const zero = { link_created: 0, link_opened: 0, link_claimed: 0, claimer_sent: 0 };
  return env === "testnet"
    ? { link_created: r.link_created, link_opened: r.link_opened, link_claimed: r.link_claimed, claimer_sent: r.claimer_sent }
    : zero;
}

/** A network's name as the admin shows it. */
export function adminName(net: GloamNetwork): string {
  return MAINNET_ENABLED ? networkName(net) : net.label;
}

/** The chains Gloam runs on, one side, as words: "Robinhood Chain, Tempo, Base and Ethereum" on mainnet. */
export function chainsOn(side: Env): string {
  const labels = [...new Set(NETWORK_KEYS.map(getNetwork).filter((x) => x.testnet === (side === "testnet")).map((x) => x.label))];
  if (!labels.length) return "Robinhood Chain and Tempo";
  return labels.length > 1 ? `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}` : labels[0]!;
}

/** Chain ids read as network names in the breakdowns. */
export function dimValue(field: string, value: string): string {
  if (field === "chainId") {
    const net = NETWORK_KEYS.map(getNetwork).find((x) => String(x.chainId) === value);
    return net ? `${adminName(net)} (${value})` : value;
  }
  if (field === "network" && isNetworkKey(value)) return adminName(getNetwork(value));
  return value;
}

export function metaText(meta: Record<string, unknown> | null): string {
  if (!meta) return "None";
  const parts = Object.entries(meta)
    .filter(([, v]) => v !== null && v !== undefined)
    .map(([k, v]) => `${k} ${String(v)}`);
  return parts.length ? parts.join(", ").slice(0, 80) : "None";
}

/**
 * How the money figures are priced, for the notes under them. A mainnet
 * snapshot prices each deposit, cash-out and fee at the time it happened;
 * a testnet one (and a snapshot cached before that) at today's prices.
 */
export function flowPricing(oc: OnchainMetrics, isMain: boolean, atToday: string[] | undefined): string {
  if (isMain && oc.prices.flowsAtTime) {
    const late = atToday?.length ? `; ${atToday.join(", ")} at today's price until its price at the time is read` : "";
    return `Priced at the time of each transaction (CoinGecko's hourly price); dollar stablecoins at $1${late}`;
  }
  return `Priced at today's prices: dollar stablecoins at $1, ETH ${oc.prices.ethUsd ? `at ${fmtUsd(oc.prices.ethUsd)}` : "not priced right now"}${
    isMain ? ", $GLOAM from DEX Screener" : ""
  }`;
}

/** "EURC (Base)": what these networks moved with no dollar price, or "" when everything was priced. */
export function notInDollars(ms: NetworkMetrics[], name: (m: NetworkMetrics) => string): string {
  return [...new Set(ms.flatMap((m) => (m.revenue?.unpriced ?? []).map((s) => `${s} (${name(m)})`)))].join(", ");
}

/**
 * Gloam's own revenue over the windows, in dollars: the vaults' cash-out fees.
 * $GLOAM creator fees are trading fees on the token's launchpad, not protocol
 * revenue, so they are shown on their own and never added in here.
 */
export function revenueTotals(rev: CombinedRevenue) {
  const w = (k: keyof Windowed) => rev.fees[k];
  return { total: { d1: w("d1"), d7: w("d7"), d30: w("d30"), all: w("all") } };
}

export type RevenueTotals = ReturnType<typeof revenueTotals>;

/**
 * Last 7 full UTC days against the 7 before them, from a daily series ending
 * today (oldest first). Today is left out: half a day against a whole one
 * would always read as a drop. Null when the series doesn't cover both
 * weeks or the earlier week is zero, so no change is ever made up.
 */
export function weekChange(values: number[]): number | null {
  if (values.length < 15) return null;
  const full = values.slice(0, -1);
  const last = full.slice(-7).reduce((a, b) => a + b, 0);
  const prev = full.slice(-14, -7).reduce((a, b) => a + b, 0);
  if (!(prev > 0)) return null;
  return ((last - prev) / prev) * 100;
}

type Envelope<T> = { ok?: boolean; data?: T; error?: { message?: string } };

/** What each admin endpoint last answered, so switching tabs shows it at once while a fresh read runs. */
const cache = new Map<string, { data: unknown; at: number }>();

/**
 * One admin endpoint ({ ok, data } envelope): read on mount, then every
 * minute while the page is on screen. `reload` reads it again now.
 */
export function useAdminResource<T>(url: string, label: string) {
  const [state, setState] = useState<{ url: string; data: T | null; err: string | null; at: number }>(() => {
    const hit = cache.get(url);
    return { url, data: (hit?.data as T) ?? null, err: null, at: hit?.at ?? 0 };
  });
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let live = true;
    const load = async () => {
      try {
        const res = await fetch(url, { credentials: "include", cache: "no-store" });
        const json = (await res.json().catch(() => null)) as Envelope<T> | null;
        if (!live) return;
        if (!res.ok || !json?.ok || !json.data) {
          setState((s) => ({ ...s, url, err: json?.error?.message ?? `${label} failed (${res.status})` }));
          return;
        }
        const at = Date.now();
        cache.set(url, { data: json.data, at });
        setState({ url, data: json.data, err: null, at });
      } catch {
        if (live) setState((s) => ({ ...s, url, err: `Network error loading ${label.toLowerCase()}` }));
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
  }, [url, label, tick]);

  // A new url (the tier changed) shows its own cached answer, never the old url's.
  const fresh = state.url === url ? state : { url, data: (cache.get(url)?.data as T) ?? null, err: null, at: cache.get(url)?.at ?? 0 };
  return {
    data: fresh.data,
    err: fresh.err,
    loadedAt: fresh.at,
    reload: () => setTick((v) => v + 1),
    /** Changes the shown answer in place after a save, until the next read. */
    mutate: (f: (d: T) => T) =>
      setState((s) => {
        if (s.url !== url || s.data == null) return s;
        const data = f(s.data);
        cache.set(url, { data, at: s.at });
        return { ...s, data };
      }),
  };
}
