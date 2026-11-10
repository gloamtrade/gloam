"use client";

/**
 * Everything the traction tabs show for one side (mainnet or the testnets),
 * worked out once from the metrics payload. The tabs only lay it out.
 */
import { useMemo } from "react";
import { getNetwork } from "@/lib/networks";
import type { CreatorFees } from "@/lib/creatorFees";
import type { CombinedMetrics, CombinedRevenue, DayRow, NetworkMetrics, OnchainMetrics, RecentRow } from "@/lib/onchainMetrics";
import type { RelayVolume } from "@/lib/relayVolume";
import {
  MAINNET_DAY,
  NEW_EVENTS,
  PAYROLL_KEYS,
  adminName,
  claimSide,
  notInDollars,
  revenueTotals,
  splitProduct,
  type ClaimCounts,
  type Env,
  type MetricsPayload,
  type RevenueTotals,
  type SideProduct,
} from "./data";
import { n } from "./format";

export type LiveRelay = Extract<RelayVolume, { enabled: true }>;

export type FunnelRow = { k: string; v: number; pct: number; sub?: string };

export type Side = {
  env: Env;
  isMain: boolean;
  /** "mainnet" or "testnet", for sentences. */
  money: Env;
  data: MetricsPayload | null;
  oc: OnchainMetrics | null;
  ocError: string | null;
  /** This side's totals; undefined on a snapshot cached before the split. */
  agg: CombinedMetrics | undefined;
  rev: CombinedRevenue | undefined;
  revenue: RevenueTotals | null;
  /** This side's networks only. */
  nets: NetworkMetrics[];
  nameOf: (m: NetworkMetrics) => string;
  prod: SideProduct;
  claim: {
    totals: ClaimCounts;
    mixed: ClaimCounts | null;
    steps: FunnelRow[];
    rows: (ClaimCounts & { day: string; label: string | null })[];
    /** Per day for this side, oldest first. */
    byDay: (ClaimCounts & { day: string })[];
  };
  funnel: FunnelRow[];
  /** The last 14 days, newest first: chain counts and product events. */
  days: { day: string; chain: DayRow | null; ev: Record<string, number> }[];
  peopleByDay: Map<string, number>;
  breakdowns: { event: string; list: { field: string; value: string; v: number }[] }[];
  creator: CreatorFees | null;
  relay: MetricsPayload["relay"];
  liveRelay: LiveRelay | null;
  /** This side's newest vault transactions, newest first. */
  recentTx: RecentRow[];
  /** Assets moved with no dollar price, named next to the dollar figures. */
  noPrice: string;
  heldNoPrice: string;
};

export function useSide(data: MetricsPayload | null, env: Env): Side {
  const product = data?.product;
  const prod = useMemo(() => splitProduct(product, env), [product, env]);
  const oc = data?.onchain && "networks" in data.onchain ? data.onchain : null;
  const ocError = data?.onchain && !("networks" in data.onchain) ? data.onchain.error : null;
  const isMain = env === "mainnet";
  const agg = oc ? (isMain ? oc.mainnet : oc.testnet) : undefined;
  const counters = prod.counters;

  const funnel = useMemo(() => {
    const payrollKey = PAYROLL_KEYS.find((k) => counters[k] != null) ?? PAYROLL_KEYS[0]!;
    const steps = [
      { k: "App views", v: counters.app_view ?? 0, sub: "app_view" },
      { k: "Wallet connects", v: counters.wallet_connect ?? 0, sub: "wallet_connect" },
      { k: "First deposits", v: agg?.depositors ?? 0, sub: "unique depositor wallets, on-chain" },
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

  const claimLinks = data?.claimLinks;
  const claim = useMemo(() => {
    const byDay = (claimLinks ?? []).map((r) => ({ day: r.day, ...claimSide(r, env) }));
    const t = { link_created: 0, link_opened: 0, link_claimed: 0, claimer_sent: 0 };
    for (const r of byDay) {
      t.link_created += r.link_created;
      t.link_opened += r.link_opened;
      t.link_claimed += r.link_claimed;
      t.claimer_sent += r.claimer_sent;
    }
    // Launch day, before counting by network: either network, so shown on its own in both views.
    const mixed = { link_created: 0, link_opened: 0, link_claimed: 0, claimer_sent: 0 };
    const mixedRows: { day: string; c: ClaimCounts }[] = [];
    for (const r of claimLinks ?? []) {
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
    const rows = [...byDay].reverse().flatMap((r) => {
      const m = mixedRows.find((x) => x.day === r.day);
      return m
        ? [{ ...r, label: null as string | null }, { day: r.day, label: "before the split, either network", ...m.c }]
        : [{ ...r, label: null as string | null }];
    });
    return {
      totals: t,
      mixed: mixedRows.length ? mixed : null,
      steps: steps.map((s) => ({ ...s, pct: (s.v / max) * 100 })),
      rows,
      byDay,
    };
  }, [claimLinks, env]);

  const days = useMemo(() => {
    const eventsByDay = new Map(prod.daily.map((d) => [d.day, d.counters]));
    const chain = agg?.daily ?? [];
    const allDays = chain.length ? chain.map((d) => d.day) : prod.daily.map((d) => d.day);
    const byDay = new Map<string, DayRow>(chain.map((d) => [d.day, d]));
    return allDays.map((day) => ({ day, chain: byDay.get(day) ?? null, ev: eventsByDay.get(day) ?? {} })).reverse();
  }, [agg, prod.daily]);

  // People per day, once anything has been counted (blank before, not zero).
  const people = data?.people;
  const peopleByDay = useMemo(() => {
    const sidePeople = people?.[env];
    const counting = Boolean(people && (people.configured || (sidePeople?.all ?? 0) > 0));
    return new Map(counting ? (sidePeople?.daily ?? []).map((d) => [d.day, d.people]) : []);
  }, [people, env]);

  const breakdowns = useMemo(() => {
    const groups = new Map<string, { field: string; value: string; v: number }[]>();
    for (const [key, v] of Object.entries(prod.dims)) {
      const [event, pair] = key.split("|");
      if (!event || !pair) continue;
      const [field, value] = pair.split("=");
      const list = groups.get(event) ?? [];
      list.push({ field: field!, value: value ?? "", v });
      groups.set(event, list);
    }
    const rank = (e: string) => {
      const i = NEW_EVENTS.indexOf(e);
      return i === -1 ? NEW_EVENTS.length : i;
    };
    return [...groups.entries()]
      .sort((a, b) => rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0]))
      .map(([event, list]) => ({ event, list: list.sort((a, b) => a.field.localeCompare(b.field) || b.v - a.v) }));
  }, [prod.dims]);

  const nets = (oc?.networks ?? []).filter((m) => (m.testnet ?? getNetwork(m.key).testnet) !== isMain);
  const nameOf = (m: NetworkMetrics) => adminName(getNetwork(m.key));
  const rev = agg?.revenue;
  const relay = data?.relay;
  const liveRelay = relay && "enabled" in relay && relay.enabled ? relay : null;
  // This side's own newest rows: the combined list keeps only the newest few
  // across every network, so a busy side would push the other one out of it.
  const recentTx = nets
    .flatMap((m) => m.recent)
    .sort((a, b) => b.ts - a.ts || Number(b.block) - Number(a.block))
    .slice(0, 25);

  return {
    env,
    isMain,
    money: env,
    data,
    oc,
    ocError,
    agg,
    rev,
    revenue: rev ? revenueTotals(rev) : null,
    nets,
    nameOf,
    prod,
    claim,
    funnel,
    days,
    peopleByDay,
    breakdowns,
    // $GLOAM creator fees exist on Robinhood Chain mainnet only; the testnets have none.
    creator: isMain && oc?.creator && "earnedEth" in oc.creator ? oc.creator : null,
    relay,
    liveRelay,
    recentTx,
    noPrice: notInDollars(nets, nameOf),
    heldNoPrice: [...new Set(nets.flatMap((m) => (m.unpriced ?? []).map((sym) => `${sym} (${nameOf(m)})`)))].join(", "),
  };
}

/** Days shown on the money charts: mainnet from its launch day, the testnets as read. */
export function sideRevenueDays(side: Side) {
  return (side.rev?.daily ?? []).filter((d) => !side.isMain || d.day >= MAINNET_DAY);
}
