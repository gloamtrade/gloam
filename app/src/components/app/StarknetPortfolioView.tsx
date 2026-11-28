"use client";

/**
 * Portfolio on Starknet, drawn as the other networks' Portfolio is: the
 * private balance as the hero with its four moves, what sits on the Starknet
 * account in public (not private yet), and the private account's address to
 * share. Before the private account is open, the open-your-account card
 * (StarknetGate).
 */
import { IntentLink } from "@/components/IntentLink";
import { useHideAmounts } from "@/lib/hideAmounts";
import { SealedField } from "@/components/ui/SealedField";
import { SealDots } from "@/components/ui/SealDots";
import { AmountToggle } from "@/components/ui/AmountToggle";
import { CopyButton } from "@/components/ui/CodeBlock";
import { TokenLogo } from "./TokenLogo";
import { AddIcon, CashOutIcon, HeroFigure, LockIcon, QuickAction, ReceiveIcon, SendIcon } from "./PortfolioView";
import { useStarknet } from "./StarknetAccount";
import { STARKNET_NAME, StarknetError, StarknetGate, StarknetPrivacyNote, starkAmount } from "./StarknetParts";

export function StarknetPortfolioView() {
  const sn = useStarknet();
  const [hidden] = useHideAmounts();
  if (!sn) return null;
  if (!sn.address || !sn.token) return <StarknetGate />;
  const { token } = sn;
  const loading = sn.privateBalance === null;
  const hasPrivate = (sn.privateBalance ?? 0n) > 0n;
  const refreshing = sn.task?.kind === "refresh";
  const dollars = token.symbol === "USDC";
  const heroText = (v: bigint) => (dollars ? `$${starkAmount(v, token)}` : `${starkAmount(v, token)} ${token.symbol}`);

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
                onClick={() => !sn.task && void sn.refresh()}
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
              <HeroFigure text={heroText(sn.privateBalance ?? 0n)} />
            )}
          </p>
          <p className="mt-4 max-w-[64ch] text-[15px] leading-relaxed text-mute">
            {hidden && hasPrivate
              ? "Amounts hidden on this screen. Tap the eye to show them."
              : refreshing
                ? `Reading your private balance on ${STARKNET_NAME}...`
                : hasPrivate
                  ? "Read and decrypted on this device."
                  : "Nothing here yet. Add money privately and only you will see this number."}
          </p>
          <StarknetError kind="refresh" className="mt-4" />

          <div className="mt-8 flex flex-wrap items-center gap-x-1 gap-y-2 max-sm:grid max-sm:grid-cols-3 lg:mt-10">
            <QuickAction href="/app/vault?tab=shield" label="Add privately" icon={<AddIcon />} primary className="btn-lg mr-3 max-sm:col-span-3 max-sm:mr-0" />
            <QuickAction href="/app/vault?tab=move" label="Pay privately" short="Pay" icon={<SendIcon />} className="max-sm:px-2" />
            <QuickAction href="/app/vault?tab=move&mode=receive" label="Receive" icon={<ReceiveIcon />} className="max-sm:px-2" />
            <QuickAction href="/app/vault?tab=move&mode=cashout" label="Cash out" icon={<CashOutIcon />} className="max-sm:px-2" />
          </div>
        </div>
      </section>

      <div className="grid gap-5 lg:grid-cols-12">
        <div className="min-w-0 space-y-5 lg:col-span-8">
          <section className="gl-card overflow-hidden">
            <header className="pb-3 pt-5 max-sm:px-5 sm:px-6">
              <h2 className="text-[17px] text-foreground">On your Starknet account</h2>
              <p className="mt-0.5 text-[13px] text-mute">Not private yet: anyone can see this on the explorer</p>
            </header>
            <ul className="divide-y divide-line border-t border-line">
              <li className="flex min-h-[64px] flex-wrap items-center gap-x-3 gap-y-2.5 py-3 max-sm:px-5 sm:px-6">
                <div className="flex min-w-0 flex-1 items-center gap-3">
                  <TokenLogo id="usdc" symbol={token.symbol} size={34} />
                  <div className="min-w-0">
                    <p className="truncate text-[14px] font-medium text-foreground">{token.symbol}</p>
                    <p className="truncate text-[12.5px] text-mute">{token.name}</p>
                  </div>
                </div>
                <p className="tnum w-28 text-right text-[14px] text-foreground">
                  {sn.publicBalance === null ? "..." : hidden ? <SealDots n={4} className="text-foreground/60" /> : starkAmount(sn.publicBalance, token)}
                </p>
                <IntentLink href="/app/vault?tab=shield" className="btn btn-ghost btn-sm h-10">
                  Add privately
                </IntentLink>
              </li>
            </ul>
          </section>
        </div>

        <div className="min-w-0 space-y-4 lg:col-span-4">
          <section className="gl-card overflow-hidden">
            <header className="px-5 pb-3 pt-5 sm:px-6">
              <h2 className="text-[17px] text-foreground">Your private account</h2>
              <p className="mt-0.5 text-[13px] text-mute">Share it to get paid on {STARKNET_NAME}</p>
            </header>
            <div className="border-t border-line px-5 py-4 sm:px-6">
              <div className="flex items-start gap-2">
                <span className="tnum min-w-0 flex-1 break-all text-[13px] leading-relaxed text-foreground">{sn.address}</span>
                <CopyButton text={sn.address} />
              </div>
              <StarknetPrivacyNote className="mt-4" />
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
