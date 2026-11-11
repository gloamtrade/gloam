"use client";

/**
 * Token check: what Blocktronics reads about the token a swap lands in (its
 * grade, holders and launch bundles), from /api/token-insight. Only the token's
 * chain and contract address are asked about, never the person or their
 * balance. Shows nothing at all while checks are off (no Blocktronics key on
 * the server), for a token Gloam doesn't offer a check for, while loading, and
 * when there is nothing to show.
 */
import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  INSIGHT_CHAINS,
  bundlesText,
  checkableToken,
  gradeText,
  hasInsight,
  holdersText,
  insightLine,
  parseInsight,
  type InsightChain,
  type TokenInsight,
} from "@/lib/tokenInsight";

/** The server said checks are off: no more asking for this page's life. */
let checksOff = false;

async function fetchInsight(chain: InsightChain, token: string): Promise<TokenInsight | null> {
  const res = await fetch(`/api/token-insight?chain=${chain}&token=${token}`, { signal: AbortSignal.timeout(12_000) });
  if (res.status === 404) {
    const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
    if (body?.error === "disabled") checksOff = true;
    return null;
  }
  if (!res.ok) return null;
  const body = (await res.json().catch(() => null)) as { insight?: unknown } | null;
  const insight = parseInsight(body?.insight);
  // an answer about another token is never shown
  return insight && insight.chain === chain && insight.token === token ? insight : null;
}

export function TokenCheckCard({ chainId, asset }: { chainId: number; asset: string | null }) {
  const token = checkableToken(chainId, asset);
  const chain = INSIGHT_CHAINS[chainId];
  const address = token?.address.toLowerCase() ?? null;
  const { data } = useQuery({
    queryKey: ["token-insight", chain ?? null, address],
    queryFn: () => fetchInsight(chain!, address!),
    enabled: Boolean(chain && address) && !checksOff,
    staleTime: 30 * 60_000,
    gcTime: 60 * 60_000,
    retry: false,
    refetchOnWindowFocus: false,
  });
  if (!token || !hasInsight(data)) return null;

  const bundles = bundlesText(data.bundles);
  return (
    <section className="gl-card gl-settle p-5" aria-labelledby="token-check-title">
      <div className="flex items-center justify-between gap-3">
        <h3 id="token-check-title" className="text-[13px] font-normal text-mute">
          Token check
        </h3>
        <span className="truncate text-[13px] font-medium text-foreground">{token.symbol}</span>
      </div>
      <dl className="mt-3 divide-y divide-line text-[14px]">
        {data.grade && <Fact term="Blocktronics grade">{gradeText(data.grade)}</Fact>}
        {data.holders != null && <Fact term="Holders">{holdersText(data.holders)}</Fact>}
        {bundles && <Fact term={data.bundles?.count === 0 ? "Launch bundles" : "Launch bundles still hold"}>{bundles}</Fact>}
      </dl>
      <p className="mt-3 text-[13px] leading-[1.6] text-mute">{insightLine(data)}</p>
      <a
        href={data.url}
        target="_blank"
        rel="noopener noreferrer"
        className="mt-1 inline-flex min-h-10 items-center gap-1.5 text-[13px] font-medium text-foreground underline decoration-line-strong underline-offset-4 transition-colors hover:decoration-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground/15"
      >
        {token.symbol} on Blocktronics
        <OutIcon />
        <span className="sr-only">(opens in a new tab)</span>
      </a>
    </section>
  );
}

function Fact({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="flex h-11 items-center justify-between gap-3">
      <dt className="truncate text-mute">{term}</dt>
      <dd className="tnum shrink-0 text-foreground">{children}</dd>
    </div>
  );
}

function OutIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M7 17 17 7M9 7h8v8" />
    </svg>
  );
}
