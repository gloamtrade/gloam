"use client";

/**
 * Where a Starknet claim link lands (gloam.trade/c#sn=<body>): what was sent,
 * one button into the app to claim it, and what to expect. The link stays in
 * the fragment, which never reaches a server; this page only reads it. The
 * claim itself happens in the app (Vault, Receive), where the claimer opens
 * their private account on Starknet first.
 */
import Link from "next/link";
import { useEffect, useState } from "react";
import { SealedField } from "@/components/ui/SealedField";
import { TokenLogo } from "@/components/app/TokenLogo";
import { appClaimPathFor, claimBody, claimFromHash, type StarknetClaim } from "@/lib/starknetPrivacy/claimLink";
import { STARKNET_ENABLED, STARKNET_NETWORK, starknetConfig } from "@/lib/starknetPrivacy/config";
import { displayAmount } from "@/lib/amountShort";

const NAMES = { mainnet: "Starknet", sepolia: "Starknet Sepolia", devnet: "Starknet devnet" } as const;

export function StarknetClaimLanding() {
  const [claim, setClaim] = useState<StarknetClaim | null | undefined>(undefined);
  useEffect(() => {
    const read = () => setClaim(claimFromHash(window.location.hash));
    read();
    window.addEventListener("hashchange", read);
    return () => window.removeEventListener("hashchange", read);
  }, []);

  const token = claim ? (starknetConfig(claim.network).tokens[claim.token] ?? null) : null;
  const here = Boolean(claim && STARKNET_ENABLED && claim.network === STARKNET_NETWORK);

  return (
    <div className="relative flex min-h-[100svh] flex-col bg-surface text-foreground">
      <header className="mx-auto flex w-full max-w-[560px] items-center justify-between px-5 pt-6">
        <Link href="/" className="inline-flex items-center gap-2.5 text-[18px] font-medium tracking-[-0.01em]">
          <svg width="24" height="24" viewBox="0 0 32 32" aria-hidden>
            <rect width="32" height="32" rx="9" className="fill-foreground" />
            <rect x="15" y="4" width="12" height="12" rx="3.5" className="fill-surface" />
          </svg>
          Gloam
        </Link>
        {claim && <span className="text-[12.5px] text-mute">{claim.network === "mainnet" ? "Mainnet" : "Testnet"}</span>}
      </header>

      <main className="mx-auto flex w-full max-w-[560px] flex-1 flex-col px-5 pb-10 pt-8">
        {claim === undefined && (
          <div className="rounded-[24px] bg-panel p-7 shadow-card" aria-busy="true" aria-label="Loading">
            <div className="h-4 w-40 animate-pulse rounded bg-surface" />
            <div className="mt-5 h-12 w-56 animate-pulse rounded bg-surface" />
            <div className="mt-8 h-12 w-full animate-pulse rounded-full bg-surface" />
          </div>
        )}

        {claim === null && (
          <div className="rounded-[24px] bg-panel p-7 shadow-card">
            <p className="t-eyebrow">Claim link</p>
            <h1 className="mt-3 text-[30px] font-light leading-[1.1] tracking-[-0.02em]">This link is cut short or mistyped</h1>
            <p className="mt-4 text-[15px] leading-relaxed text-soft">Copy the whole link from the message you got, or ask the sender to send it again.</p>
            <Link href="/app/vault?tab=move&mode=receive" className="btn btn-ghost btn-sm mt-5">
              Open Gloam
            </Link>
          </div>
        )}

        {claim && (
          <>
            <div className="relative overflow-hidden rounded-[24px] bg-panel p-7 shadow-card">
              <SealedField tone="soft" />
              <div className="relative">
                <p className="t-eyebrow inline-flex items-center gap-2">
                  <span className="h-1.5 w-1.5 rounded-full bg-sealed" aria-hidden />
                  A private payment for you
                </p>
                <div className="mt-4 flex items-center gap-3">
                  {token && <TokenLogo id="usdc" symbol={token.symbol} size={44} />}
                  <h1 className="tnum text-[44px] font-light leading-none tracking-[-0.025em]">
                    {token ? `${displayAmount(claim.amount, token.decimals)} ${token.symbol}` : "A payment"}
                  </h1>
                </div>
                <p className="mt-4 inline-flex items-center gap-2 rounded-full bg-surface py-1.5 pl-1.5 pr-3.5 text-[14px] text-soft">
                  <TokenLogo id="starknet" symbol="Starknet" size={22} network />
                  On {NAMES[claim.network]}
                </p>
                {here ? (
                  <a href={appClaimPathFor(claimBody(claim))} className="btn btn-ink btn-lg btn-block mt-7">
                    Claim it
                  </a>
                ) : (
                  <p className="mt-6 rounded-xl bg-surface px-4 py-3 text-[14px] leading-relaxed text-soft">
                    {STARKNET_ENABLED ? `This link is for ${NAMES[claim.network]}, which this app doesn't run.` : "Claiming on Starknet isn't open in Gloam yet. Keep the link: it stays good."}
                  </p>
                )}
                {here && <p className="mt-3 text-center text-[13px] text-mute">You need no Starknet wallet and no STRK. Gloam&apos;s fee for the claim is already paid.</p>}
              </div>
            </div>

            <ol className="mt-8 grid gap-4 px-1">
              {["Sign in or connect a wallet", "Open your private account on Starknet", "Tap Claim"].map((t, i) => (
                <li key={t} className="flex items-center gap-3 text-[14px] text-soft">
                  <span className="tnum grid h-7 w-7 shrink-0 place-items-center rounded-full bg-panel text-[12.5px] text-foreground shadow-card">{i + 1}</span>
                  {t}
                </li>
              ))}
            </ol>
            <p className="mt-6 px-1 text-[12.5px] leading-relaxed text-mute">
              The link holds the payment until someone claims it, so keep it to yourself. Claiming shows your private account on Starknet, never this link or the amount.
            </p>
          </>
        )}
      </main>
    </div>
  );
}
