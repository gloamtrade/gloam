"use client";

import { useMemo, useState } from "react";
import { shortAddress } from "@/lib/chain";
import { displayAmount } from "@/lib/amountShort";
import { useAppAccount } from "@/lib/demo";
import { useNetwork } from "./NetworkProvider";
import { useActivity } from "@/hooks/useActivity";
import { activityView } from "@/lib/walletActivity";

const PAGE_SIZE = 5;

function DirIcon({ kind }: { kind: "out" | "in" | "vault" }) {
  return (
    <span
      aria-hidden
      className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-surface text-foreground"
    >
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
        {kind === "vault" ? (
          <>
            <rect x="4.5" y="6" width="15" height="12.5" rx="2.75" stroke="currentColor" strokeWidth="1.6" />
            <circle cx="12" cy="12.25" r="2.4" stroke="currentColor" strokeWidth="1.6" />
          </>
        ) : kind === "out" ? (
          <path d="M7 17L17 7M9 7h8v8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        ) : (
          <path d="M17 7L7 17M15 17H7V9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        )}
      </svg>
    </span>
  );
}

function Chevron({ dir }: { dir: "left" | "right" }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d={dir === "left" ? "M14.5 6l-6 6 6 6" : "M9.5 6l6 6-6 6"}
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function Header() {
  return (
    <div className="flex shrink-0 items-start justify-between gap-3 max-sm:px-5 sm:px-6 pb-3 pt-5">
      <div>
        <h2 className="text-[17px] text-foreground">Public activity</h2>
        <p className="mt-0.5 text-[13px] text-mute">What the explorer shows about you</p>
      </div>
    </div>
  );
}

export function ActivityFeed() {
  const { address, isConnected } = useAppAccount();
  const { network } = useNetwork();
  // The payments pools (mainnet, Base Sepolia) read the wallet's transfers from the chain.
  const activity = useActivity(address, network.paymentsPool ? network.chainId : undefined);
  const { data, isFetching, refetch: retry, showOlder } = activity;
  const view = activityView(activity);
  const scope = data?.scope;
  const pct = scope && scope.progress > 0 && scope.progress < 1 ? ` ${Math.floor(scope.progress * 100)}%` : "";
  const days = scope?.days ?? 7;
  const lastDays = days === 1 ? "the last day" : `the last ${days} days`;
  const txs = useMemo(() => data?.txs ?? [], [data]);
  const pageCount = Math.max(1, Math.ceil(txs.length / PAGE_SIZE));

  // The page belongs to one address: it resets when the address changes and is
  // clamped when the list shrinks (derived, so no effect has to correct it).
  const [pageState, setPageState] = useState({ address, page: 0 });
  const page =
    pageState.address === address ? Math.min(pageState.page, pageCount - 1) : 0;
  const setPage = (next: (p: number) => number) =>
    setPageState({ address, page: next(page) });

  const pageTxs = useMemo(() => {
    const start = page * PAGE_SIZE;
    return txs.slice(start, start + PAGE_SIZE);
  }, [txs, page]);

  if (!isConnected || !address) {
    return (
      <div className="gl-card overflow-hidden">
        <Header />
        <p className="border-t border-line max-sm:px-5 sm:px-6 py-6 text-[13.5px] leading-relaxed text-mute">
          Connect a wallet to see what the public can see. Private payments never show up here.
        </p>
      </div>
    );
  }

  return (
    <div className="gl-card flex max-h-[min(30rem,72vh)] flex-col overflow-hidden lg:sticky lg:top-6">
      <Header />

      {view === "reading" && (
        <div className="border-t border-line">
          <p role="status" aria-live="polite" className="tnum max-sm:px-5 sm:px-6 pt-3 text-[12.5px] text-mute">
            Reading {network.label}...{pct}
          </p>
          <ul aria-hidden>
            {[0, 1, 2].map((i) => (
              <li key={i} className="flex min-h-[60px] items-center gap-3 max-sm:px-5 sm:px-6">
                <span className="h-9 w-9 shrink-0 animate-pulse rounded-full bg-surface" />
                <span className="flex-1 space-y-2">
                  <span className="block h-3 w-32 animate-pulse rounded-full bg-surface" />
                  <span className="block h-2.5 w-20 animate-pulse rounded-full bg-surface" />
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {view === "error" && (
        <div className="border-t border-line max-sm:px-5 sm:px-6 py-6">
          <p className="text-[13.5px] text-mute">
            Could not read your history{scope || network.paymentsPool ? ` from ${network.label}` : ""}. Try again in a moment.
          </p>
          {retry && (
            <button type="button" onClick={retry} disabled={isFetching} className="btn btn-ghost btn-sm mt-3">
              {isFetching ? "Trying again..." : "Try again"}
            </button>
          )}
        </div>
      )}
      {(view === "empty" || view === "empty-window") && (
        <div className="border-t border-line max-sm:px-5 sm:px-6 py-6">
          <p className="text-[14px] text-foreground">
            {view === "empty-window" ? `No public transfers in ${lastDays}` : "Nothing public yet"}
          </p>
          <p className="mt-1 text-[13.5px] leading-relaxed text-mute">
            Private adds, sends and proofs stay off this list by design.
          </p>
          {view === "empty-window" && showOlder && (
            <button type="button" onClick={showOlder} disabled={isFetching} className="btn btn-ghost btn-sm mt-3">
              Show older
            </button>
          )}
        </div>
      )}

      {view === "list" && (
        <>
          <ul className="min-h-0 flex-1 divide-y divide-line overflow-y-auto border-t border-line">
            {pageTxs.map((tx) => {
              const out = tx.from.toLowerCase() === address.toLowerCase();
              let raw = BigInt(0);
              try {
                raw = BigInt(tx.valueWei);
              } catch {
                /* not a number: the row reads as no amount */
              }
              // two places, cut down, like every amount (lib/amountShort)
              const eth = displayAmount(raw, tx.token ? tx.token.decimals : 18);
              const zero = raw === BigInt(0);
              const sym = tx.token?.symbol ?? network.primaryAsset.symbol;
              const counterparty = out ? tx.to : tx.from;
              const isVault =
                network.pool != null &&
                counterparty?.toLowerCase() === network.pool.toLowerCase();
              // Human-readable label, not raw call metadata.
              const title = !zero
                ? tx.token && isVault
                  ? `${out ? "Added" : "Cashed out"} ${eth} ${sym}`
                  : `${out ? "Sent" : "Received"} ${eth} ${sym}`
                : isVault
                  ? "Vault transaction"
                  : out
                    ? "Payment"
                    : "Received";
              const who = isVault
                ? "Gloam vault"
                : shortAddress(counterparty, 4);
              return (
                <li key={tx.id ?? tx.hash}>
                  <a
                    href={network.explorerTx(tx.hash)}
                    target="_blank"
                    rel="noreferrer"
                    className="group flex min-h-[60px] items-center gap-3 max-sm:px-5 sm:px-6 py-2.5 transition-colors hover:bg-surface/60"
                  >
                    <DirIcon kind={isVault ? "vault" : out ? "out" : "in"} />
                    <div className="min-w-0 flex-1">
                      <p className="tnum truncate text-[14px] text-foreground">{title}</p>
                      <p className="tnum truncate text-[12.5px] text-mute">
                        {out ? "To" : "From"} {who}
                      </p>
                    </div>
                    <span className="shrink-0 text-[12.5px] text-faint transition-colors group-hover:text-foreground">
                      View
                    </span>
                  </a>
                </li>
              );
            })}
          </ul>

          {scope && (scope.reading || scope.stalled || !scope.complete) && (
            <div className="flex min-h-[48px] shrink-0 items-center justify-between gap-3 border-t border-line max-sm:px-5 sm:px-6 py-1.5">
              <p role="status" aria-live="polite" className="tnum text-[12.5px] text-mute">
                {scope.stalled
                  ? "Some blocks could not be read"
                  : scope.reading
                    ? `Reading older blocks...${pct}`
                    : `Showing ${lastDays}`}
              </p>
              {scope.stalled && retry ? (
                <button type="button" onClick={retry} disabled={isFetching} className="btn btn-ghost btn-sm">
                  Try again
                </button>
              ) : !scope.reading && showOlder ? (
                <button type="button" onClick={showOlder} disabled={isFetching} className="btn btn-ghost btn-sm">
                  Show older
                </button>
              ) : null}
            </div>
          )}

          <div className="flex shrink-0 items-center justify-between gap-2 border-t border-line px-3 py-2">
            <button
              type="button"
              disabled={page <= 0}
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              className="grid h-10 w-10 place-items-center rounded-full text-foreground transition-colors hover:bg-surface disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:bg-transparent"
              aria-label="Previous page"
            >
              <Chevron dir="left" />
            </button>
            <p className="tnum text-[12.5px] text-mute">
              {page + 1} of {pageCount}
              <span className="text-faint">
                {" "}
                · {txs.length} {txs.length === 1 ? "transaction" : "transactions"}
              </span>
            </p>
            <button
              type="button"
              disabled={page >= pageCount - 1}
              onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
              className="grid h-10 w-10 place-items-center rounded-full text-foreground transition-colors hover:bg-surface disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:bg-transparent"
              aria-label="Next page"
            >
              <Chevron dir="right" />
            </button>
          </div>
        </>
      )}
    </div>
  );
}
