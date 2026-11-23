"use client";

/**
 * The overview's detail pieces: the daily in/out chart, one card per chain and
 * the activity feed. Only what the chain already shows publicly is counted:
 * deposits and cash-outs carry amounts, private payments are counted, never
 * summed, because their amounts are hidden by design.
 */
import { useEffect, useId, useState } from "react";
import { shortAddress } from "@/lib/chain";
import { getNetwork, isNetworkKey, solanaSlot, type GloamNetwork } from "@/lib/networks";
import { ELYSIUM_LOGO } from "@/lib/chainLogo";
import type { NetworkMetrics } from "@/lib/onchainMetrics";
import { ringsExplorerTx, SOLANA_RINGS_ENABLED } from "@/lib/solanaRings/config";
import { solAccountUrl, solTokensMoved, type FeedRow, type SolanaMetrics } from "@/lib/solanaRings/metrics";
import { fmtAmount, fmtAmountLabel } from "./format";
import { ArrowUpRight } from "@/components/ui/ArrowUpRight";

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
const usdCompact = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 1 });

export function money(v: number | null | undefined): string {
  if (v == null) return "Not priced";
  if (v > 0 && v < 0.01) return "<$0.01";
  return usd.format(v);
}

function count(v: number | undefined): string {
  return (v ?? 0).toLocaleString("en-US");
}

function dayLabel(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

function ago(ts: number): string {
  if (!ts) return "";
  const s = Math.max(0, Math.round(Date.now() / 1000 - ts));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86_400) return `${Math.round(s / 3600)}h ago`;
  return new Date(ts * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** Solana's mark: the file the bridge lists it under (Relay's id for Solana), light and dark. */
const SOLANA_MARK_ID = 792703809;

/** A chain's logo file pair, /brand/chains/<id>.png and <id>-dark.png. */
function LogoPair({ id, size, dark }: { id: number; size: number; dark: boolean }) {
  return (
    <span className="relative inline-block shrink-0 overflow-hidden rounded-full" style={{ width: size, height: size }}>
      {/* eslint-disable-next-line @next/next/no-img-element -- small local logos */}
      <img src={`/brand/chains/${id}.png`} alt="" width={size} height={size} className={`h-full w-full object-cover ${dark ? "dark:hidden" : ""}`} />
      {dark && (
        // eslint-disable-next-line @next/next/no-img-element -- small local logos
        <img src={`/brand/chains/${id}-dark.png`} alt="" width={size} height={size} className="hidden h-full w-full object-cover dark:block" />
      )}
    </span>
  );
}

/** The chain's own logo, by family, so a testnet shows its mainnet's mark; "solana" for Solana's. */
function ChainMark({ net, size = 28 }: { net: GloamNetwork | "solana"; size?: number }) {
  if (net === "solana") return <LogoPair id={SOLANA_MARK_ID} size={size} dark />;
  if (net.family === "elysium") {
    return (
      <span className="relative inline-block shrink-0 overflow-hidden rounded-full" style={{ width: size, height: size }}>
        {/* eslint-disable-next-line @next/next/no-img-element -- small local logos */}
        <img src={ELYSIUM_LOGO} alt="" width={size} height={size} className="h-full w-full object-cover" />
      </span>
    );
  }
  const id = { robinhood: 4663, tempo: 4217, base: 8453, ethereum: 1, bnb: 56 }[net.family];
  return <LogoPair id={id} size={size} dark={id !== 4217} />;
}

/** A short key in the series color: identity never rides on text color. */
function Key({ series }: { series: "in" | "out" }) {
  return (
    <span
      aria-hidden
      className="inline-block h-2.5 w-2.5 shrink-0 rounded-[3px]"
      style={{ background: series === "in" ? "var(--chart-in)" : "var(--chart-out)" }}
    />
  );
}

export type VolumeDay = { day: string; inUsd: number; outUsd: number; txs: number };

/** A round top for the axis: 1, 2, 2.5 or 5 times a power of ten. */
function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

/** A bar from the baseline, 4px round at its data end, square where it meets the baseline. */
function barPath(x: number, base: number, h: number, w: number, up: boolean): string {
  const r = Math.min(4, h, w / 2);
  if (up) {
    const t = base - h;
    return `M${x},${base}V${t + r}Q${x},${t} ${x + r},${t}H${x + w - r}Q${x + w},${t} ${x + w},${t + r}V${base}Z`;
  }
  const b = base + h;
  return `M${x},${base}V${b - r}Q${x},${b} ${x + r},${b}H${x + w - r}Q${x + w},${b} ${x + w},${b - r}V${base}Z`;
}

/**
 * Money in above the line, money out below it, one pair of bars a day. The
 * direction carries which is which as much as the color does; the legend, the
 * tooltip and the table carry the values.
 */
export function VolumeChart({ days, caption }: { days: VolumeDay[]; caption: string }) {
  // A callback ref: the plot mounts only once there are days, after the first render.
  const [wrap, setWrap] = useState<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(640);
  const [hover, setHover] = useState<number | null>(null);
  const titleId = useId();
  useEffect(() => {
    if (!wrap) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(260, e!.contentRect.width)));
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [wrap]);

  const H = 320;
  const padL = 56;
  const padR = 8;
  const padT = 10;
  const padB = 30;
  const plotW = width - padL - padR;
  const half = (H - padT - padB) / 2;
  const mid = padT + half;
  const top = niceMax(Math.max(0, ...days.map((d) => Math.max(d.inUsd, d.outUsd))));
  const band = days.length ? plotW / days.length : plotW;
  const bw = Math.max(3, Math.min(24, band * 0.56));
  // Square-root scale: a record day still fits under the top tick, and quiet days stay visible
  // instead of flattening into the baseline. Ticks are labelled with their real values.
  const y = (v: number) => Math.sqrt(Math.max(0, v) / top) * (half - 1);
  const ticks = [top, top / 4, 0, top / 4, top];
  const every = Math.max(1, Math.ceil(days.length / Math.max(1, Math.floor(plotW / 64))));
  const h = hover != null ? days[hover] : null;

  if (!days.length) return <p className="text-[14px] text-mute">No days yet</p>;

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-x-5 gap-y-2 text-[13px] text-mute">
        <span className="inline-flex items-center gap-2">
          <Key series="in" />
          Money in, deposits
        </span>
        <span className="inline-flex items-center gap-2">
          <Key series="out" />
          Money out, cash-outs
        </span>
      </div>
      <div ref={setWrap} className="relative" onPointerLeave={() => setHover(null)}>
        {/* The viewBox lets the plot scale down on a phone narrower than its 260px floor instead of clipping. */}
        <svg
          viewBox={`0 0 ${width} ${H}`}
          width={width}
          height={H}
          role="img"
          aria-labelledby={titleId}
          className="block h-auto max-w-full"
        >
          <title id={titleId}>{caption}</title>
          {ticks.map((t, i) => {
            const yy = i < 2 ? mid - y(t) : i === 2 ? mid : mid + y(t);
            return (
              <g key={i}>
                <line x1={padL} x2={width - padR} y1={yy} y2={yy} stroke={i === 2 ? "var(--line-strong)" : "var(--line)"} strokeWidth={1} />
                <text x={padL - 10} y={yy} dy="0.32em" textAnchor="end" className="tnum" fontSize={11} fill="var(--faint)">
                  {t === 0 ? "$0" : usdCompact.format(t)}
                </text>
              </g>
            );
          })}
          {days.map((d, i) => {
            const cx = padL + band * i + band / 2;
            const x = cx - bw / 2;
            const hi = y(d.inUsd);
            const ho = y(d.outUsd);
            const dim = hover != null && hover !== i;
            return (
              <g key={d.day} opacity={dim ? 0.45 : 1}>
                {hi > 0 && <path d={barPath(x, mid - 1, Math.max(1.5, hi), bw, true)} fill="var(--chart-in)" />}
                {ho > 0 && <path d={barPath(x, mid + 1, Math.max(1.5, ho), bw, false)} fill="var(--chart-out)" />}
                {i % every === 0 && (
                  <text x={cx} y={H - 8} textAnchor="middle" fontSize={11} fill="var(--faint)">
                    {dayLabel(d.day)}
                  </text>
                )}
                <rect
                  x={padL + band * i}
                  y={padT}
                  width={band}
                  height={H - padT - padB}
                  fill="transparent"
                  tabIndex={0}
                  aria-label={`${dayLabel(d.day)}: ${money(d.inUsd)} in, ${money(d.outUsd)} out`}
                  onPointerEnter={() => setHover(i)}
                  onFocus={() => setHover(i)}
                  onBlur={() => setHover(null)}
                  className="outline-none"
                />
              </g>
            );
          })}
        </svg>
        {h && hover != null && (
          <div
            className="pointer-events-none absolute top-1 z-10 min-w-[180px] rounded-xl border border-line bg-panel px-3.5 py-3 text-[12.5px] shadow-pop"
            style={{
              left: Math.min(Math.max(0, padL + band * hover + band / 2 - 90), Math.max(0, width - 190)),
            }}
          >
            <p className="text-mute">{dayLabel(h.day)}</p>
            <p className="mt-2 flex items-center justify-between gap-4">
              <span className="inline-flex items-center gap-2 text-mute">
                <span aria-hidden className="h-0.5 w-3 rounded-full" style={{ background: "var(--chart-in)" }} />
                In
              </span>
              <span className="tnum font-medium text-foreground">{money(h.inUsd)}</span>
            </p>
            <p className="mt-1 flex items-center justify-between gap-4">
              <span className="inline-flex items-center gap-2 text-mute">
                <span aria-hidden className="h-0.5 w-3 rounded-full" style={{ background: "var(--chart-out)" }} />
                Out
              </span>
              <span className="tnum font-medium text-foreground">{money(h.outUsd)}</span>
            </p>
            <p className="mt-2 flex items-center justify-between gap-4 border-t border-line pt-2">
              <span className="text-mute">Moved</span>
              <span className="tnum font-medium text-foreground">{money(h.inUsd + h.outUsd)}</span>
            </p>
            <p className="mt-1 flex items-center justify-between gap-4">
              <span className="text-mute">Transactions</span>
              <span className="tnum text-foreground">{count(h.txs)}</span>
            </p>
          </div>
        )}
      </div>
      <details className="mt-4 text-[13px]">
        <summary className="cursor-pointer text-mute transition-colors hover:text-foreground">Show as a table</summary>
        <div className="mt-3 overflow-x-auto rounded-xl border border-line">
          <table className="tnum w-full min-w-[440px] text-left text-[13.5px]">
            <thead className="border-b border-line bg-surface">
              <tr>
                {["Day", "In", "Out", "Moved", "Transactions"].map((t) => (
                  <th key={t} className="t-label px-4 py-2.5 font-medium">
                    {t}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {[...days].reverse().map((d) => (
                <tr key={d.day} className="border-b border-line last:border-0">
                  <td className="px-4 py-2.5 text-soft">{dayLabel(d.day)}</td>
                  <td className="px-4 py-2.5 text-soft">{money(d.inUsd)}</td>
                  <td className="px-4 py-2.5 text-soft">{money(d.outUsd)}</td>
                  <td className="px-4 py-2.5 text-foreground">{money(d.inUsd + d.outUsd)}</td>
                  <td className="px-4 py-2.5 text-soft">{count(d.txs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}

/**
 * "0.065 ETH, 433.48 GLOAM in; 0.065 ETH out": what moved that is not a
 * dollar stablecoin, in its own units, so a dollar figure priced at the time
 * can be checked against the chain. Null when only stablecoins moved.
 */
function tokensMoved(m: NetworkMetrics): string | null {
  const side = (pick: (a: NetworkMetrics["assets"][number]) => string) =>
    m.assets
      .filter((a) => !a.stable && Number(pick(a)) > 0)
      .map((a) => `${fmtAmount(pick(a))} ${a.symbol}`)
      .join(", ");
  const inS = side((a) => a.deposited);
  const outS = side((a) => a.cashedOut);
  if (!inS && !outS) return null;
  return [inS && `${inS} in`, outS && `${outS} out`].filter(Boolean).join("; ");
}

/** The four small figures at the foot of a chain card. */
function CardFigures({ rows }: { rows: readonly (readonly [string, string, string?])[] }) {
  return (
    <dl className="mt-6 grid grid-cols-2 gap-x-6 gap-y-4 text-[13px] sm:grid-cols-4">
      {rows.map(([k, v, hint]) => (
        <div key={k} className="min-w-0" title={hint}>
          <dt className="text-mute">{k}</dt>
          <dd className="tnum mt-1 truncate text-[15px] text-foreground">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** A chain card's money moved, its share of all, and its bar. */
function MovedFigure({ moved, totalMoved }: { moved: number | null; totalMoved: number }) {
  const share = moved != null && totalMoved > 0 ? (moved / totalMoved) * 100 : 0;
  return (
    <>
      <p className="t-label mt-6">Money moved</p>
      <div className="mt-2 flex items-baseline justify-between gap-3">
        <p className="text-[30px] font-light leading-none tracking-[-0.025em] text-foreground">{money(moved)}</p>
        <p className="tnum text-[13px] text-mute">{totalMoved > 0 ? `${Math.round(share)}% of all` : ""}</p>
      </div>
      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-surface" aria-hidden>
        <div className="h-full rounded-full" style={{ width: `${Math.max(share, moved ? 2 : 0)}%`, background: "var(--chart-in)" }} />
      </div>
    </>
  );
}

function plural(v: number, one: string, many: string): string {
  return `${count(v)} ${v === 1 ? one : many}`;
}

/**
 * Solana's card, shaped like the others. Two figures differ, and say so: what
 * Gloam's users hold sits in a pool every Privacy Rings app shares, so it can't
 * be read (Net in: added and brought in, less cashed out); and Gloam charges no
 * fee there yet ($0.00, shown, not hidden). The link is Gloam's relay, the fee
 * payer on every private account's transaction.
 */
function SolanaCard({ sol, totalMoved }: { sol: SolanaMetrics; totalMoved: number }) {
  if (!SOLANA_RINGS_ENABLED) return null;
  const moved = sol.revenue.depositVolume.all + sol.revenue.cashoutVolume.all;
  const relay = sol.relays[0] ?? "";
  const tokens = solTokensMoved(sol, fmtAmount);
  const opened = plural(sol.accountsOpened, "account opened", "accounts opened");
  const line = [tokens, opened, sol.bringIns ? `${count(sol.bringIns)} brought in from another chain` : null]
    .filter(Boolean)
    .join("; ");
  const since = sol.addsSince ? new Date(sol.addsSince * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }) : null;
  return (
    <section className="gl-card min-w-0 p-5 sm:p-6">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <ChainMark net="solana" />
          <h3 className="truncate text-[16px] tracking-[-0.01em] text-foreground">{sol.label}</h3>
        </div>
        {relay && (
          <a href={solAccountUrl(relay)} target="_blank" rel="noreferrer" className="shrink-0 text-[12.5px] text-mute transition-colors hover:text-foreground">
            Relay {shortAddress(relay, 4)} <ArrowUpRight />
          </a>
        )}
      </div>
      <MovedFigure moved={moved} totalMoved={totalMoved} />
      <p className="mt-2.5 truncate text-[12.5px] text-mute" title={line}>
        {line}
      </p>
      <CardFigures
        rows={[
          ["Net in", money(sol.netInUsd), "Added and brought in, less cashed out. What Gloam's users hold sits in a pool shared with other apps, so it can't be read."],
          ["Private payments", count(sol.transfers)],
          ["Fees earned", money(0), "Gloam charges no fee on Solana yet."],
          ["Depositors", count(sol.depositors)],
        ]}
      />
      <p className="mt-4 text-[12px] text-faint">
        {sol.error ? `${sol.error} ` : ""}
        {since ? `Adds a wallet paid for itself counted since ${since}.` : "Adds a wallet paid for itself count from the day this shipped."}
      </p>
    </section>
  );
}

/** One card per chain: what moved there, its share, and what it holds. Solana's sits right after Base, as in the network menu. */
export function ChainCards({
  nets,
  solana,
  totalMoved,
  name,
}: {
  nets: NetworkMetrics[];
  solana?: SolanaMetrics | null;
  totalMoved: number;
  name: (m: NetworkMetrics) => string;
}) {
  const total = nets.length + (solana ? 1 : 0);
  if (!total) return null;
  const at = solana ? solanaSlot(nets.map((m) => m.key)) : nets.length;
  const cards = [
    ...nets.slice(0, at).map((m) => <EvmCard key={m.key} m={m} totalMoved={totalMoved} name={name} />),
    ...(solana ? [<SolanaCard key="solana" sol={solana} totalMoved={totalMoved} />] : []),
    ...nets.slice(at).map((m) => <EvmCard key={m.key} m={m} totalMoved={totalMoved} name={name} />),
  ];
  return <div className={`grid grid-cols-1 gap-3 ${total > 1 ? "lg:grid-cols-2" : ""}`}>{cards}</div>;
}

function EvmCard({ m, totalMoved, name }: { m: NetworkMetrics; totalMoved: number; name: (m: NetworkMetrics) => string }) {
  const net = getNetwork(m.key);
  const moved = m.revenue ? m.revenue.depositVolume.all + m.revenue.cashoutVolume.all : null;
  const tokens = tokensMoved(m);
  return (
    <section className="gl-card min-w-0 p-5 sm:p-6">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <ChainMark net={net} />
          <h3 className="truncate text-[16px] tracking-[-0.01em] text-foreground">{name(m)}</h3>
        </div>
        <a
          href={net.explorerAddress(m.pool)}
          target="_blank"
          rel="noreferrer"
          className="shrink-0 text-[12.5px] text-mute transition-colors hover:text-foreground"
        >
          Vault {shortAddress(m.pool, 4)} <ArrowUpRight />
        </a>
      </div>
      <MovedFigure moved={moved} totalMoved={totalMoved} />
      {tokens && <p className="mt-2.5 truncate text-[12.5px] text-mute" title={tokens}>{tokens}</p>}
      <CardFigures
        rows={[
          ["In the vault", money(m.heldUsd)],
          ["Private payments", count(m.transfers)],
          ["Fees earned", m.revenue ? money(m.revenue.fees.all) : "Unknown"],
          ["Depositors", count(m.depositors)],
        ]}
      />
    </section>
  );
}

type FeedIconKind = "in" | "out" | "lock" | "new";

const FEED_KIND: Record<FeedRow["kind"], { title: string; icon: FeedIconKind }> = {
  deposit: { title: "Deposit", icon: "in" },
  cashout: { title: "Cash-out", icon: "out" },
  transfer: { title: "Private payment", icon: "lock" },
  trade: { title: "Private trade", icon: "lock" },
  opened: { title: "Account opened", icon: "new" },
};

function FeedIcon({ kind }: { kind: FeedIconKind }) {
  return (
    <span aria-hidden className={`grid h-9 w-6 shrink-0 place-items-center ${kind === "lock" ? "text-sealed" : "text-mute"}`}>
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        {kind === "new" ? (
          <path d="M8 3.5v9M3.5 8h9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        ) : kind === "lock" ? (
          <>
            <rect x="3.5" y="7" width="9" height="6.5" rx="1.6" stroke="currentColor" strokeWidth="1.5" />
            <path d="M5.5 7V5.4a2.5 2.5 0 0 1 5 0V7" stroke="currentColor" strokeWidth="1.5" />
          </>
        ) : (
          <path
            d={kind === "in" ? "M8 3v10M4 9l4 4 4-4" : "M8 13V3M4 7l4-4 4 4"}
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        )}
      </svg>
    </span>
  );
}

/** Where a feed row happened: its network's name and its transaction on an explorer. */
function feedPlace(r: FeedRow, name: (n: GloamNetwork) => string, solanaName: string): { where: string; txUrl: string } {
  if (r.network === "solana") return { where: solanaName, txUrl: ringsExplorerTx(r.tx, "mainnet") };
  const net = getNetwork(isNetworkKey(r.network) ? r.network : "robinhood");
  return { where: name(net), txUrl: net.explorerTx(r.tx) };
}

/** The latest vault activity: public edges with their amount, private payments without one. */
export function ActivityFeed({ rows, name, solanaName = "Solana" }: { rows: FeedRow[]; name: (n: GloamNetwork) => string; solanaName?: string }) {
  if (!rows.length) return <p className="text-[14px] text-mute">No on-chain activity yet</p>;
  return (
    <ul className="-my-1 divide-y divide-line">
      {rows.slice(0, 12).map((r) => {
        const { where, txUrl } = feedPlace(r, name, solanaName);
        const k = FEED_KIND[r.kind];
        const hidden = r.kind === "transfer" || r.kind === "trade";
        const amountless = r.kind === "opened";
        return (
          <li key={`${r.network}-${r.tx}-${r.block}-${r.kind}`} className="flex items-center gap-3 py-3">
            <FeedIcon kind={k.icon} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-[14px] text-foreground">{r.network === "solana" ? r.title : k.title}</p>
              <p className="truncate text-[12.5px] text-mute">
                {where}
                {r.wallet ? ` · ${shortAddress(r.wallet, 4)}` : ""}
                {r.ts ? ` · ${ago(r.ts)}` : ` · ${r.network === "solana" ? "slot" : "block"} ${r.block}`}
              </p>
            </div>
            <div className="shrink-0 text-right">
              <p className={`tnum text-[14px] ${hidden || amountless ? "text-faint" : "text-foreground"}`}>{hidden ? (
                  <>
                    <span className="sm:hidden">Hidden</span>
                    <span className="hidden sm:inline">Amount hidden</span>
                  </>
                ) : amountless ? (
                  "No amount"
                ) : (
                  fmtAmountLabel(r.detail)
                )}
              </p>
              <a
                href={txUrl}
                target="_blank"
                rel="noreferrer"
                className="text-[12px] text-mute transition-colors hover:text-foreground"
              >
                View <ArrowUpRight />
              </a>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
