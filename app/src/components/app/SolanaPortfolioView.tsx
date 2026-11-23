"use client";

/**
 * Portfolio on Solana, drawn as the EVM Portfolio is: the private balance as
 * the hero with its four moves, then the private balance by token and what
 * the Solana wallet holds in public, each with its mark and dollar value, and
 * the private account's address beside them. Before the private account is
 * open, the connect and set-up card (SolanaGate).
 */
import { IntentLink } from "@/components/IntentLink";
import { RINGS_PRIVACY_NOTE, ringsAssets } from "@/lib/solanaRings/config";
import { addAssetHref } from "@/lib/vaultHub";
import { useHideAmounts } from "@/lib/hideAmounts";
import { SealedField } from "@/components/ui/SealedField";
import { SealDots } from "@/components/ui/SealDots";
import { AmountToggle } from "@/components/ui/AmountToggle";
import { CopyButton } from "@/components/ui/CodeBlock";
import { AddressChip } from "./AddressChip";
import { TokenLogo } from "./TokenLogo";
import { AddIcon, CashOutIcon, HeroFigure, LockIcon, QuickAction, ReceiveIcon, SendIcon, VaultChips } from "./PortfolioView";
import { formatSolAmount, useSolana } from "./SolanaAccount";
import { SolanaError, SolanaGate, useSolanaUsd, usd } from "./SolanaParts";

type Row = { id: string; symbol: string; name: string; raw: bigint; decimals: number; text: string; value: number | null };

function rowsOf(b: Record<string, bigint> | null, toUsd: (id: string, v: bigint) => number | null): Row[] {
  return ringsAssets().map((a) => {
    const raw = b?.[a.id] ?? 0n;
    return { id: a.id, symbol: a.symbol, name: a.name, raw, decimals: a.decimals, text: formatSolAmount(raw, a.decimals), value: toUsd(a.id, raw) };
  });
}

/** The dollar total of what has a price, and what held has none yet (SOL while its price loads). */
function total(rows: Row[]): { usd: number; unpriced: Row[] } {
  let sum = 0;
  const unpriced: Row[] = [];
  for (const r of rows) {
    if (r.raw === 0n) continue;
    if (r.value == null) unpriced.push(r);
    else sum += r.value;
  }
  return { usd: sum, unpriced };
}

/** "$1,550.00", "$1,550.00 + 4.25 SOL", or "4.25 SOL". */
function figureOf(t: { usd: number; unpriced: Row[] }): string {
  const rest = t.unpriced.map((r) => `${r.text} ${r.symbol}`).join(" + ");
  if (!rest) return usd(t.usd);
  return t.usd > 0 ? `${usd(t.usd)} + ${rest}` : rest;
}

export function SolanaPortfolioView() {
  const sol = useSolana();
  const toUsd = useSolanaUsd();
  const [hidden] = useHideAmounts();
  if (!sol) return null;
  if (!sol.address) return <SolanaGate />;

  const privateRows = rowsOf(sol.balances, toUsd);
  const walletRows = rowsOf(sol.walletBalances, toUsd);
  const held = privateRows.filter((r) => r.raw > 0n);
  const privateSum = total(privateRows);
  const walletSum = total(walletRows);
  // Dollar totals only once every held amount has a price.
  const privateTotal = sol.balances && !privateSum.unpriced.length ? privateSum.usd : null;
  const walletTotal = sol.walletBalances && !walletSum.unpriced.length ? walletSum.usd : null;
  const hasPrivate = held.length > 0;
  const refreshing = sol.task?.kind === "refresh";
  const loading = !sol.balances;
  // The hero reads in dollars once priced; a lone token without a price reads as that token.
  const figure = figureOf(privateSum);
  const pct =
    privateTotal != null && walletTotal != null && privateTotal + walletTotal > 0
      ? Math.round((privateTotal / (privateTotal + walletTotal)) * 100)
      : null;
  const firstInWallet = walletRows.find((r) => r.raw > 0n);

  return (
    <div className="space-y-5">
      <section className="gl-card relative overflow-hidden">
        <SealedField tone="soft" />
        <div className="relative z-[1] max-sm:p-6 sm:p-8 lg:p-10">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2.5">
              <span className="text-[14px] text-soft">Private balance</span>
              <span className="inline-flex h-6 items-center gap-1.5 rounded-full bg-sealed-soft px-2.5 text-[12px] font-medium text-sealed">
                <LockIcon />
                Only you
              </span>
            </div>
            <div className="-mr-2 flex items-center gap-0.5">
              <AmountToggle />
              <button
                type="button"
                onClick={() => !sol.task && void sol.refresh()}
                aria-busy={refreshing || undefined}
                aria-label="Refresh balances"
                title="Refresh balances"
                className="grid h-10 w-10 place-items-center rounded-full text-mute transition-colors hover:bg-surface hover:text-foreground"
              >
                <svg aria-hidden width="15" height="15" viewBox="0 0 24 24" fill="none" className={refreshing ? "animate-spin motion-reduce:animate-none" : undefined}>
                  <path d="M20 12a8 8 0 1 1-2.34-5.66M20 4v4.5h-4.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            </div>
          </div>

          <p className="tnum mt-8 truncate font-light leading-none tracking-[-0.03em] text-foreground max-sm:text-[52px] sm:text-[72px] lg:mt-10">
            {loading ? (
              <span className="gl-skeleton inline-block h-[0.85em] w-[min(14rem,60%)] align-baseline" aria-label="Loading your private balance" />
            ) : hidden ? (
              <SealDots n={7} dot={14} label="Private balance hidden" className="h-[1em]" />
            ) : (
              <HeroFigure text={hasPrivate ? figure : "$0.00"} />
            )}
          </p>
          {hasPrivate && !hidden && (
            <VaultChips rows={held.map((r) => ({ key: r.id, id: r.id, symbol: r.symbol, amount: r.text }))} />
          )}
          <p className="mt-4 max-w-[64ch] text-[15px] leading-relaxed text-mute">
            {hidden && hasPrivate
              ? "Amounts hidden on this screen. Tap the eye to show them."
              : refreshing
                ? "Reading your private balance on Solana..."
                : hasPrivate
                  ? "Read and decrypted on this device. On Solana the token and the amount stay hidden."
                  : "Nothing here yet. Add money privately and only you will see this number."}
          </p>
          <SolanaError kind="refresh" className="mt-4" />

          <div className="mt-8 flex flex-wrap items-center gap-x-1 gap-y-2 max-sm:grid max-sm:grid-cols-3 lg:mt-10">
            <QuickAction
              href={firstInWallet ? addAssetHref(firstInWallet.id) : "/app/vault?tab=shield"}
              label="Add privately"
              icon={<AddIcon />}
              primary
              className="btn-lg mr-3 max-sm:col-span-3 max-sm:mr-0"
            />
            <QuickAction href="/app/vault?tab=move" label="Pay privately" short="Pay" icon={<SendIcon />} className="max-sm:px-2" />
            <QuickAction href="/app/vault?tab=move&mode=receive" label="Receive" icon={<ReceiveIcon />} className="max-sm:px-2" />
            <QuickAction href="/app/vault?tab=move&mode=cashout" label="Cash out" icon={<CashOutIcon />} className="max-sm:px-2" />
          </div>
        </div>

        {sol.main && (
          <div className="relative z-[1] flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-t border-line py-3 max-sm:px-6 sm:px-8 lg:px-10">
            {hasPrivate && walletTotal != null && privateTotal != null ? (
              <dl className="tnum flex min-w-0 flex-wrap items-baseline gap-x-6 gap-y-1 text-[13px]">
                <div className="flex items-baseline gap-2">
                  <dt className="text-mute">In your wallet</dt>
                  <dd className="text-foreground">{hidden ? <SealDots n={5} /> : usd(walletTotal)}</dd>
                </div>
                <div className="flex items-baseline gap-2">
                  <dt className="text-mute">Total</dt>
                  <dd className="text-foreground">
                    {hidden ? (
                      <SealDots n={5} />
                    ) : (
                      <>
                        {usd(privateTotal + walletTotal)}
                        {pct != null && <span className="text-mute">, {pct}% private</span>}
                      </>
                    )}
                  </dd>
                </div>
              </dl>
            ) : (
              <span className="text-[12.5px] text-mute">{sol.main.wallet.name}</span>
            )}
            <AddressChip address={sol.main.account.address} className="min-h-10 text-[12.5px]" />
          </div>
        )}
      </section>

      <div className="grid gap-5 lg:grid-cols-12">
        <div className="min-w-0 space-y-5 lg:col-span-8">
          {hasPrivate && (
            <section className="gl-card overflow-hidden">
              <header className="flex items-center justify-between gap-3 pb-3 pt-5 max-sm:px-5 sm:px-6">
                <div>
                  <h2 className="text-[17px] text-foreground">Private balance</h2>
                  <p className="mt-0.5 text-[13px] text-mute">Only you can see these amounts</p>
                </div>
              </header>
              <ul className="divide-y divide-line border-t border-line">
                {held.map((r) => (
                  <li key={r.id} className="flex min-h-[64px] items-center justify-between gap-3 py-3 transition-colors hover:bg-surface/60 max-sm:px-5 sm:px-6">
                    <div className="flex min-w-0 items-center gap-3">
                      <TokenLogo id={r.id} symbol={r.symbol} size={34} />
                      <div className="min-w-0">
                        <p className="tnum truncate text-[15px] text-foreground">
                          {hidden ? <SealDots n={5} className="text-foreground/60" /> : r.text} <span className="text-mute">{r.symbol}</span>
                        </p>
                        <p className="mt-0.5 truncate text-[12.5px] text-mute">{r.value != null && !hidden ? usd(r.value) : "Ready to use"}</p>
                      </div>
                    </div>
                    <IntentLink href="/app/vault?tab=move" className="btn btn-ghost btn-sm h-10 shrink-0">
                      Pay
                    </IntentLink>
                  </li>
                ))}
              </ul>
              <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-line py-3 max-sm:px-5 sm:px-6">
                <p className="text-[13px] text-mute">Pay from it privately, or cash out to any Solana address.</p>
                <div className="flex gap-1">
                  <IntentLink href="/app/vault?tab=move" className="btn btn-quiet btn-sm h-10">
                    Pay privately
                  </IntentLink>
                  <IntentLink href="/app/vault?tab=move&mode=cashout" className="btn btn-quiet btn-sm h-10">
                    Cash out
                  </IntentLink>
                </div>
              </div>
            </section>
          )}

          <section className="gl-card @container overflow-hidden">
            <header className="flex items-start justify-between gap-4 pb-3 pt-5 max-sm:px-5 sm:px-6">
              <div className="min-w-0">
                <h2 className="text-[17px] text-foreground">In your wallet</h2>
                <p className="mt-0.5 text-[13px] text-mute">Public: anyone can see these on the explorer</p>
              </div>
              {sol.walletBalances ? (
                <p className="tnum shrink-0 text-right text-[17px] text-foreground">
                  <span className="sr-only">Total in your wallet: </span>
                  {hidden ? <SealDots n={5} /> : figureOf(walletSum)}
                </p>
              ) : (
                <span role="status" aria-label="Loading the total" className="mt-1 inline-block h-5 w-16 shrink-0 rounded-md bg-surface-2 motion-safe:animate-pulse" />
              )}
            </header>
            <div className="flex items-center gap-x-3 border-t border-line py-2.5 max-sm:px-5 sm:px-6">
              <span className="t-label flex-1">Asset</span>
              <span className="t-label w-28 text-right">Balance</span>
              <span className="hidden w-[200px] @xl:block" aria-hidden />
            </div>
            <ul className="divide-y divide-line border-t border-line">
              {walletRows.map((r) => (
                <li key={r.id} className="flex min-h-[64px] flex-wrap items-center gap-x-3 gap-y-2.5 py-3 transition-colors hover:bg-surface/60 max-sm:px-5 sm:px-6 @xl:flex-nowrap">
                  <div className="flex min-w-0 flex-1 items-center gap-3">
                    <TokenLogo id={r.id} symbol={r.symbol} size={34} />
                    <div className="min-w-0">
                      <p className="truncate text-[14px] font-medium text-foreground">{r.symbol}</p>
                      <p className="truncate text-[12.5px] text-mute">{r.name}</p>
                    </div>
                  </div>
                  <div className="w-28 text-right">
                    <p className="tnum text-[14px] text-foreground">
                      {!sol.walletBalances ? "..." : hidden ? <SealDots n={4} className="text-foreground/60" /> : r.text}
                    </p>
                    {r.value != null && sol.walletBalances && !hidden && <p className="tnum text-[12.5px] text-mute">{usd(r.value)}</p>}
                  </div>
                  <div className="flex gap-1 @max-xl:w-full @max-xl:justify-start @max-xl:pl-[46px] @xl:w-[200px] @xl:justify-end">
                    {sol.ready[r.id] === false ? (
                      <span className="inline-flex h-10 items-center text-[12.5px] text-mute">Not set up yet</span>
                    ) : (
                      <IntentLink href={addAssetHref(r.id)} className="btn btn-ghost btn-sm h-10">
                        Add privately
                      </IntentLink>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        </div>

        <div className="min-w-0 space-y-4 lg:col-span-4">
          <section className="gl-card overflow-hidden">
            <header className="px-5 pb-3 pt-5 sm:px-6">
              <h2 className="text-[17px] text-foreground">Your private account</h2>
              <p className="mt-0.5 text-[13px] text-mute">Share it to get paid on Solana</p>
            </header>
            <div className="border-t border-line px-5 py-4 sm:px-6">
              <div className="flex items-start gap-2">
                <code className="min-w-0 flex-1 break-all font-mono text-[12.5px] leading-relaxed text-foreground">{sol.address}</code>
                <CopyButton text={sol.address} />
              </div>
              <p className="mt-4 text-[12.5px] leading-relaxed text-mute">{RINGS_PRIVACY_NOTE}</p>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
