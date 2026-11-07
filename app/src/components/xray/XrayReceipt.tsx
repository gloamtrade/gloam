"use client";

import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import type { XrayLookup, XrayLookupError } from "@/app/api/xray/route";
import { AppLink } from "@/components/AppLink";
import { TokenLogo } from "@/components/app/TokenLogo";
import { chainLogoSrc } from "@/lib/chainLogo";
import { SealedField } from "@/components/ui/SealedField";
import { formatUsdCompact } from "@/lib/markets";
import type { XrayBalances, XrayHolding } from "@/lib/xray/balances";
import { readWalletHistory, type XrayHistory, type XrayProgress } from "@/lib/xray/historyRead";
import { shortAddress, type XrayQuery } from "@/lib/xray/input";

const SITE = "https://www.gloam.trade";
const ROBINHOOD_CHAIN_ID = 4663;
const TOP_HOLDINGS = 6;
const POST_LINE = "Anyone can read this wallet like a receipt. Yours too.";
/** Times the page asks again when the price feeds were slow, and how long it leaves between. */
const PRICE_RETRIES = 3;
const PRICE_RETRY_MS = 3_000;

/** `pricing`: the balances are in, and the page is still waiting on prices to total them. */
type Lookup = { state: "loading" } | { state: "failed"; error: XrayLookupError } | ({ state: "ok"; pricing: boolean } & XrayLookup);
type History =
  | { state: "reading"; progress: XrayProgress | null }
  | { state: "read"; history: XrayHistory }
  | { state: "fresh" }
  | { state: "too_big" }
  | { state: "failed" };

/* ---------------------------------------------------------------- format */

const usdFmt = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

function usd(n: number): string {
  if (n > 0 && n < 0.01) return "<$0.01";
  return n < 1_000_000 ? usdFmt.format(n) : formatUsdCompact(n);
}

function amount(text: string): string {
  const n = Number(text);
  if (!Number.isFinite(n)) return text;
  if (n > 0 && n < 0.0001) return "<0.0001";
  return n.toLocaleString("en-US", { maximumFractionDigits: n < 1 ? 4 : 2 });
}

function utcDate(ms: number): string {
  return new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

function utcTime(ms: number): string {
  return new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" });
}

function listJoin(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/* ---------------------------------------------------------------- pieces */

/** A receipt line: the label, a dotted leader, the figure, and any detail under it. */
function Line({ label, value, sub }: { label: string; value: ReactNode; sub?: string }) {
  return (
    <div className="py-2">
      <div className="flex items-baseline gap-2">
        <dt className="shrink-0 text-[14px] text-mute">{label}</dt>
        <span aria-hidden className="min-w-3 flex-1 -translate-y-1 border-b border-dotted border-line-strong" />
        <dd className="tnum m-0 shrink-0 text-[15px] text-foreground">{value}</dd>
      </div>
      {sub && <p className="tnum mt-0.5 text-right text-[12.5px] leading-snug text-mute">{sub}</p>}
    </div>
  );
}

function SectionTitle({ children }: { children: ReactNode }) {
  return <h2 className="border-t border-dashed border-line-strong pt-5 text-[15px] text-foreground">{children}</h2>;
}

function HoldingRow({ h }: { h: XrayHolding }) {
  return (
    <li className="flex items-center gap-3 py-2">
      <span className="relative inline-block shrink-0" style={{ width: 28, height: 28 }}>
        <TokenLogo id={h.id} symbol={h.symbol} size={28} />
        <span className="absolute -bottom-1 -right-1 h-4 w-4 overflow-hidden rounded-full border border-surface bg-surface">
          {/* eslint-disable-next-line @next/next/no-img-element -- small local logos */}
          <img src={chainLogoSrc(h.chainId)} alt="" width={14} height={14} className="h-full w-full object-cover dark:hidden" />
          {/* eslint-disable-next-line @next/next/no-img-element -- small local logos */}
          <img src={chainLogoSrc(h.chainId, true)} alt="" width={14} height={14} className="hidden h-full w-full object-cover dark:block" />
        </span>
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[15px] text-foreground">{h.symbol}</span>
        <span className="tnum block truncate text-[12.5px] text-mute">
          {amount(h.amount)} on {h.chain}
        </span>
      </span>
      <span className="tnum shrink-0 text-[15px] text-foreground">{h.usd == null ? "No price" : usd(h.usd)}</span>
    </li>
  );
}

function Skeleton({ className }: { className: string }) {
  return <span aria-hidden className={`gl-skeleton block ${className}`} />;
}

function SkeletonLines({ rows }: { rows: number }) {
  return (
    <div className="mt-4 space-y-5">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center justify-between gap-6">
          <Skeleton className="h-3.5 w-28" />
          <Skeleton className="h-3.5 w-20" />
        </div>
      ))}
    </div>
  );
}

/** The paper the receipt is printed on: its torn edge is the page's one piece of drawing. */
function Paper({ children }: { children: ReactNode }) {
  return <div className="xr-paper px-5 pb-11 pt-6 sm:px-8 sm:pt-8">{children}</div>;
}

function ReceiptHead({ who, address, readAt }: { who: string; address?: string; readAt?: number }) {
  return (
    <header>
      <h1 className="text-[15px] leading-snug text-mute">
        Public receipt for <span className="tnum text-foreground">{who}</span>
      </h1>
      <p className="tnum mt-1 min-h-[1.25rem] text-[13px] text-mute">
        {address ? `${address}. ` : ""}
        {readAt ? `Read at ${utcTime(readAt)} UTC on ${utcDate(readAt)}` : ""}
      </p>
    </header>
  );
}

function HistoryLines({ history, sent, priced }: { history: XrayHistory; sent: number | null; priced: boolean }) {
  const h = history;
  return (
    <dl className="mt-2">
      {h.firstSeen != null && <Line label="First seen" value={utcDate(h.firstSeen)} />}
      {h.lastSeen != null && <Line label="Last seen" value={utcDate(h.lastSeen)} />}
      {h.firstFunder && (
        <Line
          label="First token came from"
          value={shortAddress(h.firstFunder.address)}
          sub={`${amount(h.firstFunder.amount)} ${h.firstFunder.symbol}`}
        />
      )}
      {priced && h.biggestIn && (
        <Line
          label="Biggest in"
          value={usd(h.biggestIn.usd)}
          sub={`${amount(h.biggestIn.amount)} ${h.biggestIn.symbol}${h.biggestIn.counterparty ? ` from ${shortAddress(h.biggestIn.counterparty)}` : ""}`}
        />
      )}
      {priced && h.biggestOut && (
        <Line
          label="Biggest out"
          value={usd(h.biggestOut.usd)}
          sub={`${amount(h.biggestOut.amount)} ${h.biggestOut.symbol}${h.biggestOut.counterparty ? ` to ${shortAddress(h.biggestOut.counterparty)}` : ""}`}
        />
      )}
      {h.counterparties > 0 && (
        <Line label="Paid or paid by" value={`${h.counterparties.toLocaleString("en-US")} ${h.counterparties === 1 ? "address" : "addresses"}`} />
      )}
      {h.topCounterparty && (
        <Line
          label="Most often with"
          value={shortAddress(h.topCounterparty.address)}
          sub={`${h.topCounterparty.transfers.toLocaleString("en-US")} ${h.topCounterparty.transfers === 1 ? "transfer" : "transfers"}`}
        />
      )}
      {h.stockTrades > 0 && (
        <Line
          label="Stock trades"
          value={`${h.stockTradesFloor ? "At least " : ""}${h.stockTrades.toLocaleString("en-US")}`}
          sub={h.stocksTraded.slice(0, 4).join(", ") + (h.stocksTraded.length > 4 ? ` and ${h.stocksTraded.length - 4} more` : "")}
        />
      )}
      {sent != null && sent > 0 && <Line label="Transactions sent" value={sent.toLocaleString("en-US")} />}
    </dl>
  );
}

function HistorySection({
  history,
  sent,
  priced,
  onRetry,
}: {
  history: History;
  sent: number | null;
  /** Without prices a transfer can not be ranked, so no row says which was biggest. */
  priced: boolean;
  onRetry: () => void;
}) {
  return (
    <section className="mt-7">
      <SectionTitle>On Robinhood Chain</SectionTitle>
      {history.state === "reading" && (
        <>
          <p role="status" className="tnum mt-2 text-[13.5px] leading-relaxed text-mute">
            {history.progress ? `Still reading, ${history.progress.tokens} of ${history.progress.of} tokens.` : "Reading the chain."}
            {history.progress?.history ? " These figures can still change." : ""}
          </p>
          {history.progress?.history ? <HistoryLines history={history.progress.history} sent={sent} priced={priced} /> : <SkeletonLines rows={5} />}
        </>
      )}
      {history.state === "read" &&
        (history.history.transfers > 0 || (sent ?? 0) > 0 ? (
          <HistoryLines history={history.history} sent={sent} priced={priced} />
        ) : (
          <p className="mt-2 text-[14px] leading-relaxed text-mute">No token transfers here.</p>
        ))}
      {history.state === "fresh" && (
        <p className="mt-2 text-[14px] leading-relaxed text-mute">No transactions sent from this address, and none of these tokens held.</p>
      )}
      {history.state === "too_big" && (
        <>
          <p className="mt-2 text-[14px] leading-relaxed text-mute">Too much history to read here, so only the balances are shown.</p>
          {sent != null && sent > 0 && (
            <dl className="mt-2">
              <Line label="Transactions sent" value={sent.toLocaleString("en-US")} />
            </dl>
          )}
        </>
      )}
      {history.state === "failed" && (
        <div role="alert" className="mt-2">
          <p className="text-[14px] leading-relaxed text-mute">The history could not be read just now.</p>
          <button type="button" onClick={onRetry} className="btn btn-quiet btn-sm -ml-3 mt-1">
            Try again
          </button>
        </div>
      )}
    </section>
  );
}

function ReceiptBody({ balances, pricing, children }: { balances: XrayBalances; pricing: boolean; children: ReactNode }) {
  const top = balances.holdings.slice(0, TOP_HOLDINGS);
  const more = balances.holdings.length - top.length;
  const unpricedHeld = balances.priced && balances.holdings.some((h) => h.usd == null);
  return (
    <>
      <p className="mt-8 text-[14px] text-mute">Public value</p>
      {pricing ? <Skeleton className="mt-3 h-12 w-56" /> : <p className="t-display-xl tnum mt-1">{usd(balances.totalUsd)}</p>}
      {!pricing && !balances.priced && (
        <p role="status" className="mt-3 rounded-xl bg-warn-soft px-4 py-2.5 text-[13px] leading-relaxed text-warn">
          Prices did not load in time, so this counts dollar stablecoins only.
        </p>
      )}
      {balances.missed.length > 0 && (
        <p role="status" className="mt-3 rounded-xl bg-warn-soft px-4 py-2.5 text-[13px] leading-relaxed text-warn">
          {listJoin(balances.missed)} did not answer, so {balances.missed.length === 1 ? "it is" : "they are"} not in this total.
        </p>
      )}

      <section className="mt-7">
        <SectionTitle>Top holdings</SectionTitle>
        {top.length ? (
          <>
            <ul className="mt-2">
              {top.map((h) => (
                <HoldingRow key={`${h.chainId}-${h.symbol}`} h={h} />
              ))}
            </ul>
            {more > 0 && (
              <p className="mt-1 text-[13px] text-mute">
                {more} more in the total{unpricedHeld ? ", apart from any with no price" : ""}.
              </p>
            )}
            {!more && unpricedHeld && <p className="mt-1 text-[13px] text-mute">Anything with no price is not in the total.</p>}
          </>
        ) : (
          <p className="mt-2 text-[14px] leading-relaxed text-mute">No balances in the tokens read here.</p>
        )}
      </section>

      {children}

      <p className="mt-7 border-t border-dashed border-line-strong pt-4 text-[12.5px] leading-relaxed text-mute">
        Read from public nodes: ETH and the tokens Gloam lists on {listJoin(balances.chains)}. History covers token transfers on Robinhood
        Chain only, since plain ETH transfers leave no log. Amounts use today&apos;s prices.
      </p>
    </>
  );
}

const FAILURES: Record<XrayLookupError, { title: string; body: string; retry: boolean }> = {
  bad_request: { title: "That did not work.", body: "Try the address again.", retry: true },
  invalid: { title: "That is not a wallet address.", body: "Paste a 0x address or an .eth name.", retry: false },
  no_such_name: { title: "That name does not point to a wallet.", body: "Check the spelling, or paste the 0x address.", retry: false },
  rate_limited: { title: "That is a lot of lookups in a row.", body: "Wait a minute and try again.", retry: true },
  busy: { title: "A lot of people are looking right now.", body: "Wait a minute and try again.", retry: true },
  read_failed: { title: "The chain did not answer.", body: "Public nodes sometimes slow down. Try again in a moment.", retry: true },
};

function Failure({ error, onRetry }: { error: XrayLookupError; onRetry: () => void }) {
  const f = FAILURES[error];
  return (
    <div role="alert" className="mt-8">
      <p className="text-[20px] leading-snug tracking-[-0.01em] text-foreground">{f.title}</p>
      <p className="mt-2 text-[14.5px] leading-relaxed text-mute">{f.body}</p>
      {f.retry ? (
        <button type="button" onClick={onRetry} className="btn btn-ink mt-6">
          Try again
        </button>
      ) : (
        <Link href="/xray" className="gl-arrowlink mt-6">
          Check another wallet <span aria-hidden>→</span>
        </Link>
      )}
    </div>
  );
}

function Share({ slug }: { slug: string }) {
  const [copied, setCopied] = useState(false);
  const link = `${SITE}/xray/${slug}`;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      /* no clipboard here: the link is in the address bar */
    }
  };
  const post = `https://x.com/intent/post?text=${encodeURIComponent(POST_LINE)}&url=${encodeURIComponent(link)}`;
  return (
    <div className="mt-5 flex flex-wrap items-center gap-x-7 gap-y-1">
      <button type="button" onClick={copy} className="gl-arrowlink min-h-[40px]">
        <span aria-live="polite">{copied ? "Copied" : "Copy link"}</span>
      </button>
      <a href={post} target="_blank" rel="noopener noreferrer" className="gl-arrowlink min-h-[40px]">
        Post on X
      </a>
      <Link href="/xray" className="gl-arrowlink min-h-[40px]">
        Check another wallet
      </Link>
    </div>
  );
}

/** The turn: everything to the left is public; this is the one thing that is not. */
function Turn() {
  return (
    <section className="gl-panel flex flex-col justify-end px-6 py-10 sm:px-10 sm:py-12 lg:min-h-[520px]">
      <SealedField tone="soft" />
      <div className="relative">
        <h2 className="t-display-l max-w-[18ch]">
          Anyone can see all of this. <span className="text-sealed">Nobody can see a Gloam balance.</span>
        </h2>
        <p className="mt-5 max-w-[46ch] text-[15px] leading-relaxed text-soft">
          Gloam keeps new balances and payments private from here on. What is already on chain stays there, and deposits into the vault are public.
        </p>
        <AppLink href="/app" className="btn btn-ink btn-lg mt-8">
          Open the app
        </AppLink>
      </div>
    </section>
  );
}

/* ---------------------------------------------------------------- receipt */

export function XrayReceipt({ query }: { query: Exclude<XrayQuery, { kind: "invalid" }> }) {
  const slug = query.kind === "address" ? query.address : query.name;
  const who = query.kind === "address" ? shortAddress(query.address) : query.name;

  const [attempt, setAttempt] = useState(0);
  const [lookup, setLookup] = useState<{ key: string; value: Lookup } | null>(null);
  const [historyAttempt, setHistoryAttempt] = useState(0);
  const [history, setHistory] = useState<{ key: string; value: History } | null>(null);

  const lookupKey = `${slug}:${attempt}`;
  const current: Lookup = lookup?.key === lookupKey ? lookup.value : { state: "loading" };

  useEffect(() => {
    const ctrl = new AbortController();
    const done = (value: Lookup) => {
      if (!ctrl.signal.aborted) setLookup({ key: lookupKey, value });
    };
    const ask = async (retries: number): Promise<void> => {
      const res = await fetch("/api/xray", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: slug }),
        signal: ctrl.signal,
      });
      const body = (await res.json().catch(() => null)) as (XrayLookup & { error?: XrayLookupError }) | null;
      if (!res.ok || !body?.balances) return done({ state: "failed", error: body?.error ?? "read_failed" });
      const pricing = !body.balances.priced && retries > 0;
      done({ state: "ok", address: body.address, balances: body.balances, pricing });
      if (!pricing) return;
      await new Promise((r) => setTimeout(r, PRICE_RETRY_MS));
      if (!ctrl.signal.aborted) await ask(retries - 1);
    };
    ask(PRICE_RETRIES).catch(() => done({ state: "failed", error: "read_failed" }));
    return () => ctrl.abort();
  }, [lookupKey, slug]);

  const wallet = current.state === "ok" ? current.address : null;
  const balances = current.state === "ok" ? current.balances : null;
  const pricing = current.state === "ok" && current.pricing;
  const historyKey = `${lookupKey}:${historyAttempt}`;
  const shownHistory: History = history?.key === historyKey ? history.value : { state: "reading", progress: null };

  useEffect(() => {
    // transfers are valued with the prices, so the read waits for them
    if (!wallet || !balances || pricing) return;
    const ctrl = new AbortController();
    const set = (value: History) => {
      if (!ctrl.signal.aborted) setHistory({ key: historyKey, value });
    };
    // An address that has sent nothing and holds nothing here has no history worth a few hundred queries.
    if (balances.sent === 0 && !balances.holdings.some((h) => h.chainId === ROBINHOOD_CHAIN_ID)) {
      queueMicrotask(() => set({ state: "fresh" }));
      return () => ctrl.abort();
    }
    const heldIds = balances.holdings.filter((h) => h.chainId === ROBINHOOD_CHAIN_ID && h.id !== "eth").map((h) => h.id);
    readWalletHistory(wallet, balances.marks, heldIds, (progress) => set({ state: "reading", progress }), ctrl.signal)
      .then((r) => set(r.status === "read" ? { state: "read", history: r.history } : { state: "too_big" }))
      .catch(() => set({ state: "failed" }));
    return () => ctrl.abort();
  }, [wallet, balances, pricing, historyKey]);

  return (
    <div className="grid items-start gap-8 lg:grid-cols-[minmax(0,560px)_minmax(0,1fr)] lg:gap-14">
      <div className="min-w-0">
        <Paper>
          <ReceiptHead
            who={who}
            address={query.kind === "ens" && wallet ? shortAddress(wallet) : undefined}
            readAt={balances?.readAt}
          />
          {current.state === "loading" && (
            <div role="status" aria-label="Reading this wallet">
              <p className="mt-8 text-[14px] text-mute">Public value</p>
              <Skeleton className="mt-3 h-12 w-56" />
              <div className="mt-8 border-t border-dashed border-line-strong pt-5">
                <SkeletonLines rows={4} />
              </div>
            </div>
          )}
          {current.state === "failed" && <Failure error={current.error} onRetry={() => setAttempt((a) => a + 1)} />}
          {balances && (
            <ReceiptBody balances={balances} pricing={pricing}>
              <HistorySection
                history={shownHistory}
                sent={balances.sent}
                priced={balances.priced}
                onRetry={() => setHistoryAttempt((a) => a + 1)}
              />
            </ReceiptBody>
          )}
        </Paper>
        {balances && <Share slug={slug} />}
      </div>
      {current.state !== "failed" && (
        <div className="lg:sticky lg:top-24">
          <Turn />
        </div>
      )}
    </div>
  );
}
