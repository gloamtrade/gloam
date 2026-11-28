/**
 * Gloam on Solana in /admin: the figures the dashboard shows for Solana next to
 * the EVM networks, worked out from what Solana itself shows. Pure, so the
 * server builds them (lib/solanaRings/metricsServer) and the admin page adds
 * them to the mainnet totals (withSolana). Only read while SOLANA_RINGS_ENABLED
 * is on, on mainnet.
 *
 * What counts, and what it is called:
 *  - Accounts opened: registrations Gloam's relay paid for (each one is a new
 *    Gloam private account).
 *  - Deposits: money added from a wallet plus money brought in from another
 *    chain. A deposit the relay paid for is read from its history; one the
 *    wallet paid for itself only from what the app reported
 *    (/api/solana/added, since that shipped: the chain alone can't tell such
 *    an add from any other app's). Either way it is a bring-in when the
 *    depositor is a Gloam private account (one the relay registered), and an
 *    add from a wallet otherwise. Reported and read twice, it counts once.
 *  - Private payments: relayed transacts that pay out nothing. Counted per
 *    transaction, never summed: the amount is hidden.
 *  - Cash-outs: relayed transacts the pool pays out of, with the amount and
 *    the wallet paid, which the chain shows.
 *  - Net in: added and brought in, less cashed out. What Gloam's users hold on
 *    Solana sits inside a pool every Privacy Rings app shares, so it can't be
 *    read; this is the closest true figure, and it is named for what it is.
 *  - Fees: none. Gloam charges no fee on Solana yet.
 */
import { formatUnits, parseUnits } from "viem";
import type { ActivityKind, CombinedMetrics, DayRow, NetworkRevenue, RecentRow, RevenueDay, Windowed } from "@/lib/onchainMetrics";
import { ringsAssets, RINGS_SOL_MINT, SOLANA_NAME, SOLANA_RINGS_ENABLED, SOLANA_RINGS_NETWORK } from "./config";

/** The admin reads Solana only on a mainnet build with Solana on. */
export const SOLANA_ADMIN_ON = SOLANA_RINGS_ENABLED && SOLANA_RINGS_NETWORK === "mainnet";

/**
 * One transaction, as kept between reads (transactions never change):
 *  - open: a registration the relay paid for; `acct` is the new private account.
 *  - bring: a deposit the relay paid for, by `acct`: money that arrived at a
 *    private account made private, or, when `acct` is not a private account
 *    (solanaFigures decides), a wallet's add the relay paid the fee for.
 *  - add: a deposit from the wallet `w` the app reported (lib/solanaRings/client addToPrivate).
 *  - pay: a private payment from `acct`; no amount, ever.
 *  - cashout: `acct` paid `v` of `m` out of the pool to the wallet `w`.
 *  - merge: an internal merge, not a payment.
 *  - other: anything else the relay signed (its own funding); failed: did not land.
 */
export type SolKind = "open" | "bring" | "add" | "pay" | "cashout" | "merge" | "other" | "failed";

export type SolEvent = {
  sig: string;
  k: SolKind;
  /** Unix seconds; 0 when unknown. */
  ts: number;
  slot: number;
  acct?: string;
  w?: string;
  /** The asset's mint; RINGS_SOL_MINT for SOL. */
  m?: string;
  /** Raw amount. */
  v?: string;
  /** The asset's decimals, as the chain gave them. */
  d?: number;
};

export type SolanaAssetRow = {
  mint: string;
  symbol: string;
  stable: boolean;
  decimals: number;
  /** Whole units, full precision; shown cut down to two places. */
  added: string;
  addCount: number;
  broughtIn: string;
  bringCount: number;
  cashedOut: string;
  cashoutCount: number;
};

/** A Solana row in the admin's latest-activity feed. */
export type SolanaFeedRow = Omit<RecentRow, "network" | "kind"> & {
  network: "solana";
  kind: ActivityKind | "opened";
  /** Said plainly: "Brought in", "Added from a wallet", "Account opened". */
  title: string;
};

/** Any row of the admin's latest-activity feed. */
export type FeedRow = RecentRow | SolanaFeedRow;

export type SolanaMetrics = {
  key: "solana";
  label: string;
  /** Every relay address read; the first is the one in use, linked on the card. */
  relays: string[];
  pool: string;
  accountsOpened: number;
  /** Wallet adds and bring-ins. */
  deposits: number;
  adds: number;
  bringIns: number;
  transfers: number;
  cashouts: number;
  merges: number;
  /** Wallets that added plus private accounts that brought money in. */
  depositors: number;
  cashoutWallets: number;
  activeWallets: number;
  /** Added and brought in, less cashed out, priced at the time. Not what is held. */
  netInUsd: number;
  assets: SolanaAssetRow[];
  firstActivity: number | null;
  lastActivity: number | null;
  /** Aligned with the EVM side's `daily` (14 days). */
  daily: DayRow[];
  /** Aligned with the EVM mainnet side's `sinceLaunch`. */
  sinceLaunch: DayRow[];
  /** Wallets that deposited or received a cash-out, over the windows. */
  users: Windowed;
  /** Volume and transactions; fees are zero, Gloam charges none on Solana yet. */
  revenue: NetworkRevenue;
  recent: SolanaFeedRow[];
  /** Unix seconds wallet adds have been recorded since; null before the first record. */
  addsSince: number | null;
  /** The newest slot read on the relay; null before any. */
  lastSlot: number | null;
  readMs: number;
  /** Set when the last read failed; the figures are then the last ones read. */
  error: string | null;
};

const RECENT_KEEP = 25;
const SOL_LIKE = RINGS_SOL_MINT;

type AssetInfo = { symbol: string; decimals: number; stable: boolean };

/** The listed asset for a mint (SOL as RINGS_SOL_MINT), else a short mint with the decimals the chain gave. */
export function solAsset(mint: string, decimals?: number): AssetInfo {
  const a = ringsAssets("mainnet").find((x) => (x.mint ?? SOL_LIKE) === mint);
  if (a) return { symbol: a.symbol, decimals: a.decimals, stable: Boolean(a.stable) };
  return { symbol: `${mint.slice(0, 4)}…${mint.slice(-4)}`, decimals: decimals ?? 0, stable: false };
}

/** Whole units of `raw`, full precision ("18.002207"). */
export function solUnits(raw: bigint, decimals: number): string {
  return formatUnits(raw, decimals);
}

const day = (tsSec: number) => new Date(tsSec * 1000).toISOString().slice(0, 10);
const zero = (): Windowed => ({ d1: 0, d7: 0, d30: 0, all: 0 });
const big = (v: string | undefined) => {
  try {
    return BigInt(v ?? "0");
  } catch {
    return 0n;
  }
};

/** What a deposit or cash-out is worth in dollars: `usd` per whole unit, or null with no price; `atToday` when it is today's price. */
export type SolUnitPrice = (mint: string, tsSec: number) => { usd: number | null; atToday: boolean };

export type SolanaInput = {
  relays: string[];
  pool: string;
  /** What the relay signed, any order. */
  events: SolEvent[];
  /** Wallet adds recorded by /api/solana/added. */
  adds: SolEvent[];
  price: SolUnitPrice;
  /** The EVM side's day lists, so the rows line up. */
  days: string[];
  revenueDays: string[];
  launchDays: string[];
  addsSince: number | null;
  lastSlot: number | null;
  readMs: number;
  error: string | null;
  nowSec?: number;
};

/** Solana's figures from what was read. */
export function solanaFigures(input: SolanaInput): SolanaMetrics {
  const now = input.nowSec ?? Math.floor(Date.now() / 1000);
  const cut = { d1: now - 86_400, d7: now - 7 * 86_400, d30: now - 30 * 86_400 };
  const add = (w: Windowed, ts: number, v: number) => {
    w.all += v;
    if (!ts) return;
    if (ts >= cut.d30) w.d30 += v;
    if (ts >= cut.d7) w.d7 += v;
    if (ts >= cut.d1) w.d1 += v;
  };

  // One of each transaction: a wallet add the relay also signed is the relay's (never twice).
  const seen = new Set<string>();
  const all: SolEvent[] = [];
  for (const e of [...input.events, ...input.adds]) {
    if (seen.has(e.sig)) continue;
    seen.add(e.sig);
    all.push(e);
  }
  all.sort((a, b) => a.ts - b.ts || a.slot - b.slot);
  // A deposit is a bring-in when its depositor is a Gloam private account (each
  // one the relay registered), and an add from a wallet otherwise, whoever paid the fee.
  const privateAccounts = new Set(all.filter((e) => e.k === "open" && e.acct).map((e) => e.acct!));
  const counted = all.filter((e) => e.k !== "other" && e.k !== "failed").map((e) => depositKind(e, privateAccounts));

  const counts = { open: 0, bring: 0, add: 0, pay: 0, cashout: 0, merge: 0 };
  const depositors = new Set<string>();
  const cashoutWallets = new Set<string>();
  const assets = new Map<string, { info: AssetInfo; add: bigint; addN: number; bring: bigint; bringN: number; out: bigint; outN: number }>();
  const unpriced = new Set<string>();
  const atToday = new Set<string>();
  const deposits = zero();
  const cashouts = zero();
  const txs = zero();
  const users = { d1: new Set<string>(), d7: new Set<string>(), d30: new Set<string>(), all: new Set<string>() };
  const mkDay = (d: string) => ({ day: d, deposits: 0, transfers: 0, cashouts: 0, trades: 0, wallets: new Set<string>() });
  const daily = new Map(input.days.map((d) => [d, mkDay(d)]));
  const launch = new Map(input.launchDays.map((d) => [d, mkDay(d)]));
  const revDaily = new Map(input.revenueDays.map((d) => [d, { day: d, feesUsd: 0, depositUsd: 0, cashoutUsd: 0, txs: 0, wallets: new Set<string>() }]));
  let first: number | null = null;
  let last: number | null = null;
  let netIn = 0;

  for (const e of counted) {
    if (e.k === "open" || e.k === "merge") {
      counts[e.k]++;
      continue;
    }
    counts[e.k as "bring" | "add" | "pay" | "cashout"]++;
    if (e.ts) {
      first = first == null ? e.ts : Math.min(first, e.ts);
      last = last == null ? e.ts : Math.max(last, e.ts);
    }
    // The wallet a figure is about: who added, the private account that brought money in, who was paid out.
    const who = e.k === "add" || e.k === "cashout" ? e.w : e.k === "bring" ? e.acct : undefined;
    if (who && (e.k === "add" || e.k === "bring")) depositors.add(who);
    if (who && e.k === "cashout") cashoutWallets.add(who);

    add(txs, e.ts, 1);
    const d = e.ts ? day(e.ts) : null;
    for (const rows of [daily, launch]) {
      const r = d ? rows.get(d) : undefined;
      if (!r) continue;
      if (e.k === "pay") r.transfers++;
      else if (e.k === "cashout") r.cashouts++;
      else r.deposits++;
      if (who) r.wallets.add(who);
    }
    const rd = d ? revDaily.get(d) : undefined;
    if (rd) {
      rd.txs++;
      if (who) rd.wallets.add(who);
    }
    if (who) {
      users.all.add(who);
      if (e.ts >= cut.d30) users.d30.add(who);
      if (e.ts >= cut.d7) users.d7.add(who);
      if (e.ts >= cut.d1) users.d1.add(who);
    }

    if (e.k === "pay" || !e.m) continue;
    const info = solAsset(e.m, e.d);
    const raw = big(e.v);
    const row = assets.get(e.m) ?? { info, add: 0n, addN: 0, bring: 0n, bringN: 0, out: 0n, outN: 0 };
    if (e.k === "add") {
      row.add += raw;
      row.addN++;
    } else if (e.k === "bring") {
      row.bring += raw;
      row.bringN++;
    } else {
      row.out += raw;
      row.outN++;
    }
    assets.set(e.m, row);

    const units = Number(formatUnits(raw, info.decimals));
    let usd: number | null = units;
    if (!info.stable) {
      const p = input.price(e.m, e.ts);
      usd = p.usd == null ? null : units * p.usd;
      if (usd == null) {
        if (raw > 0n) unpriced.add(info.symbol);
      } else if (p.atToday && raw > 0n) atToday.add(info.symbol);
    }
    if (usd == null) continue;
    if (e.k === "cashout") {
      add(cashouts, e.ts, usd);
      netIn -= usd;
      if (rd) rd.cashoutUsd += usd;
    } else {
      add(deposits, e.ts, usd);
      netIn += usd;
      if (rd) rd.depositUsd += usd;
    }
  }

  const dayRows = (rows: Map<string, ReturnType<typeof mkDay>>, list: string[]): DayRow[] =>
    list.map((d) => {
      const { wallets, ...rest } = rows.get(d)!;
      return { ...rest, activeWallets: wallets.size };
    });

  const listed = ringsAssets("mainnet").map((a) => a.mint ?? SOL_LIKE);
  const assetRows = [...assets.entries()]
    .sort((a, b) => (listed.indexOf(a[0]) + 1 || 99) - (listed.indexOf(b[0]) + 1 || 99))
    .map(([mint, r]) => ({
      mint,
      symbol: r.info.symbol,
      stable: r.info.stable,
      decimals: r.info.decimals,
      added: solUnits(r.add, r.info.decimals),
      addCount: r.addN,
      broughtIn: solUnits(r.bring, r.info.decimals),
      bringCount: r.bringN,
      cashedOut: solUnits(r.out, r.info.decimals),
      cashoutCount: r.outN,
    }));

  const revenue: NetworkRevenue = {
    feeBps: 0,
    feeRecipient: null,
    fees: zero(),
    feeRows: [],
    owedUsd: 0,
    depositVolume: deposits,
    cashoutVolume: cashouts,
    txs,
    daily: input.revenueDays.map((d) => {
      const { wallets, ...rest } = revDaily.get(d)!;
      return { ...rest, wallets: wallets.size } satisfies RevenueDay;
    }),
    unpriced: [...unpriced],
    atToday: [...atToday],
  };

  return {
    key: "solana",
    label: SOLANA_NAME,
    relays: input.relays,
    pool: input.pool,
    accountsOpened: counts.open,
    deposits: counts.add + counts.bring,
    adds: counts.add,
    bringIns: counts.bring,
    transfers: counts.pay,
    cashouts: counts.cashout,
    merges: counts.merge,
    depositors: depositors.size,
    cashoutWallets: cashoutWallets.size,
    activeWallets: new Set([...depositors, ...cashoutWallets]).size,
    netInUsd: netIn,
    assets: assetRows,
    firstActivity: first,
    lastActivity: last,
    daily: dayRows(daily, input.days),
    sinceLaunch: dayRows(launch, input.launchDays),
    users: { d1: users.d1.size, d7: users.d7.size, d30: users.d30.size, all: users.all.size },
    revenue,
    recent: feedRows(counted),
    addsSince: input.addsSince,
    lastSlot: input.lastSlot,
    readMs: input.readMs,
    error: input.error,
  };
}

/** A deposit as a bring-in (by a private account) or an add (by a wallet); anything else as it is. */
function depositKind(e: SolEvent, privateAccounts: ReadonlySet<string>): SolEvent {
  if (e.k !== "add" && e.k !== "bring") return e;
  const who = e.k === "add" ? e.w : e.acct;
  if (!who) return e;
  const { acct: _a, w: _w, ...rest } = e;
  return privateAccounts.has(who) ? { ...rest, k: "bring", acct: who } : { ...rest, k: "add", w: who };
}

const FEED: Partial<Record<SolKind, { kind: SolanaFeedRow["kind"]; title: string }>> = {
  open: { kind: "opened", title: "Account opened" },
  bring: { kind: "deposit", title: "Brought in" },
  add: { kind: "deposit", title: "Added from a wallet" },
  pay: { kind: "transfer", title: "Private payment" },
  cashout: { kind: "cashout", title: "Cash-out" },
};

/** The newest rows for the latest-activity feed: amounts on adds, bring-ins and cash-outs only. */
function feedRows(events: SolEvent[]): SolanaFeedRow[] {
  return events
    .filter((e) => FEED[e.k])
    .slice(-RECENT_KEEP)
    .reverse()
    .map((e) => {
      const f = FEED[e.k]!;
      const info = e.m ? solAsset(e.m, e.d) : null;
      const detail = info && e.k !== "pay" && e.k !== "open" ? `${solUnits(big(e.v), info.decimals)} ${info.symbol}` : f.title;
      const wallet = e.k === "add" || e.k === "cashout" ? (e.w ?? null) : e.k === "bring" || e.k === "open" ? (e.acct ?? null) : null;
      return { network: "solana", kind: f.kind, title: f.title, tx: e.sig, block: String(e.slot), ts: e.ts, wallet, detail };
    });
}

/**
 * The mainnet totals with Solana in: counts, wallets, money in and out, and
 * every day row. Solana's wallets are Solana addresses and the EVM side's are
 * 0x addresses, so the two sets never overlap and add up exactly. What the
 * vaults hold is left as it was: Gloam's share of Solana's shared pool can't
 * be read (Solana's card shows its net in instead).
 */
export function withSolana(agg: CombinedMetrics, sol: SolanaMetrics): CombinedMetrics {
  const addDays = (rows: DayRow[], extra: DayRow[]): DayRow[] => {
    const by = new Map(extra.map((d) => [d.day, d]));
    return rows.map((r) => {
      const s = by.get(r.day);
      return s
        ? {
            ...r,
            deposits: r.deposits + s.deposits,
            transfers: r.transfers + s.transfers,
            cashouts: r.cashouts + s.cashouts,
            activeWallets: r.activeWallets + s.activeWallets,
          }
        : r;
    });
  };
  const sumW = (a: Windowed, b: Windowed): Windowed => ({ d1: a.d1 + b.d1, d7: a.d7 + b.d7, d30: a.d30 + b.d30, all: a.all + b.all });
  const rev = agg.revenue;
  const sr = sol.revenue;
  const firsts = [agg.firstActivity, sol.firstActivity].filter((x): x is number => x != null);
  const lasts = [agg.lastActivity, sol.lastActivity].filter((x): x is number => x != null);
  return {
    ...agg,
    deposits: agg.deposits + sol.deposits,
    transfers: agg.transfers + sol.transfers,
    cashouts: agg.cashouts + sol.cashouts,
    depositors: agg.depositors + sol.depositors,
    activeWallets: agg.activeWallets + sol.activeWallets,
    firstActivity: firsts.length ? Math.min(...firsts) : null,
    lastActivity: lasts.length ? Math.max(...lasts) : null,
    daily: addDays(agg.daily, sol.daily),
    ...(agg.sinceLaunch ? { sinceLaunch: addDays(agg.sinceLaunch, sol.sinceLaunch) } : {}),
    revenue: rev
      ? {
          ...rev,
          depositVolume: sumW(rev.depositVolume, sr.depositVolume),
          cashoutVolume: sumW(rev.cashoutVolume, sr.cashoutVolume),
          txs: sumW(rev.txs, sr.txs),
          users: sumW(rev.users, sol.users),
          unpriced: [...new Set([...(rev.unpriced ?? []), ...(sr.unpriced ?? [])])],
          atToday: [...new Set([...(rev.atToday ?? []), ...(sr.atToday ?? [])])],
          daily: rev.daily.map((r) => {
            const s = sr.daily.find((x) => x.day === r.day);
            return s
              ? { ...r, depositUsd: r.depositUsd + s.depositUsd, cashoutUsd: r.cashoutUsd + s.cashoutUsd, txs: r.txs + s.txs, wallets: r.wallets + s.wallets }
              : r;
          }),
        }
      : rev,
  };
}

/** "0.5 SOL, 2 ZEC in; 0.1 SOL out": what moved that is not a dollar stablecoin, in its own units. Null when only stablecoins moved. */
export function solTokensMoved(sol: Pick<SolanaMetrics, "assets">, show: (units: string) => string): string | null {
  const raw = (a: SolanaAssetRow, v: string) => {
    try {
      return parseUnits(v, a.decimals);
    } catch {
      return 0n;
    }
  };
  const side = (pick: (a: SolanaAssetRow) => bigint) =>
    sol.assets
      .filter((a) => !a.stable && pick(a) > 0n)
      .map((a) => `${show(solUnits(pick(a), a.decimals))} ${a.symbol}`)
      .join(", ");
  const inS = side((a) => raw(a, a.added) + raw(a, a.broughtIn));
  const outS = side((a) => raw(a, a.cashedOut));
  if (!inS && !outS) return null;
  return [inS && `${inS} in`, outS && `${outS} out`].filter(Boolean).join("; ");
}

/** Everything that came in of one asset, added and brought in together, in whole units. */
export function solDeposited(a: SolanaAssetRow): string {
  try {
    return solUnits(parseUnits(a.added, a.decimals) + parseUnits(a.broughtIn, a.decimals), a.decimals);
  } catch {
    return a.broughtIn;
  }
}

/** A Solana account on an explorer. */
export function solAccountUrl(address: string): string {
  return `https://solscan.io/account/${encodeURIComponent(address)}${SOLANA_RINGS_NETWORK === "devnet" ? "?cluster=devnet" : ""}`;
}
