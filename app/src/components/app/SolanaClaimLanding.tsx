"use client";

/**
 * The claim page (/c, /claim) for a Solana claim link (gloam.trade/c#sol=...):
 * what was sent, one button into the app to claim it, and what to expect, as
 * the page shows an EVM link. It reads the link in the browser only (the
 * fragment never reaches a server) and loads nothing of Solana: the amount is
 * what the link carries, and the app reads what the link really holds before
 * anyone claims.
 */
import { SealedField } from "@/components/ui/SealedField";
import { appClaimPath, type SolanaClaim } from "@/lib/solanaRings/claimLink";
import { SOLANA_RINGS_ENABLED, SOLANA_RINGS_NETWORK } from "@/lib/solanaRings/config";
import { ringsAmount } from "@/lib/solanaRings/amount";
import { TokenLogo } from "./TokenLogo";

export function SolanaClaimLanding({ body, claim }: { body: string; claim: SolanaClaim }) {
  const here = SOLANA_RINGS_ENABLED && claim.network === SOLANA_RINGS_NETWORK;
  const where = claim.network === "devnet" ? "Solana devnet" : "Solana";
  return (
    <>
      <div className="relative overflow-hidden rounded-[24px] bg-panel p-7 shadow-card">
        <SealedField tone="soft" />
        <div className="relative">
          <p className="t-eyebrow inline-flex items-center gap-2">
            <span className="h-1.5 w-1.5 rounded-full bg-sealed" aria-hidden />
            A private payment for you
          </p>
          <div className="mt-4 flex items-center gap-3">
            <TokenLogo id={claim.asset.id} symbol={claim.asset.symbol} size={44} />
            <h1 className="tnum text-[44px] font-light leading-none tracking-[-0.025em]">
              {ringsAmount(claim.amount, claim.asset.decimals)} {claim.asset.symbol}
            </h1>
          </div>
          <p className="mt-4 inline-flex items-center gap-2 rounded-full bg-surface py-1.5 pl-1.5 pr-3.5 text-[14px] text-soft">
            {/* eslint-disable-next-line @next/next/no-img-element -- small local logo */}
            <img src="/brand/networks/solana.svg" alt="" width={22} height={22} className="h-[22px] w-[22px] rounded-full object-cover" />
            On {where}
          </p>
          {here ? (
            <>
              <a href={appClaimPath(body)} className="btn btn-ink btn-lg btn-block mt-7">
                Claim it
              </a>
              <p className="mt-4 text-center text-[13px] leading-relaxed text-mute">Gloam pays the network fee. You need a Solana wallet to open your private account.</p>
            </>
          ) : (
            <p role="status" className="mt-7 rounded-[16px] bg-warn-soft px-4 py-3 text-[14px] leading-relaxed text-warn">
              {!SOLANA_RINGS_ENABLED
                ? "Solana isn't open on this Gloam yet, so this payment can't be claimed here."
                : `This payment is on ${where}, and this Gloam runs on ${SOLANA_RINGS_NETWORK === "devnet" ? "Solana devnet" : "Solana mainnet"}. Open it on the Gloam it came from.`}
            </p>
          )}
        </div>
      </div>
      {here && (
        <ol className="mt-8 grid gap-4 px-1">
          {["Connect a Solana wallet", "Tap Claim", "Only you see your balance"].map((t, i) => (
            <li key={t} className="grid grid-cols-[28px_minmax(0,1fr)] items-center gap-3">
              <span className="tnum grid h-7 w-7 place-items-center rounded-full bg-sealed-soft text-[13px] font-medium text-sealed">{i + 1}</span>
              <span className="text-[15px] text-foreground">{t}</span>
            </li>
          ))}
        </ol>
      )}
    </>
  );
}
