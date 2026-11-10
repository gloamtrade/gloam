"use client";

import { TokenLogo } from "@/components/app/TokenLogo";
import { OPTION_ART, OptionIcon } from "@/lib/vote/optionArt";

/** The marks for one answer: a small overlapping cluster, network badges, or a line icon. */
export function OptionArt({ voteId, index, size = 30 }: { voteId: string; index: number; size?: number }) {
  const art = OPTION_ART[voteId]?.[index];
  if (!art) return null;
  if (art.icon) {
    return (
      <span aria-hidden className="grid shrink-0 place-items-center rounded-full bg-surface-2 text-foreground" style={{ width: size + 6, height: size + 6 }}>
        <OptionIcon name={art.icon} />
      </span>
    );
  }
  const marks = art.marks ?? [];
  return (
    <span aria-hidden className="relative flex shrink-0 items-center">
      {marks.map((m, i) => (
        <span key={m.id} className="rounded-full ring-2 ring-panel" style={{ marginLeft: i === 0 ? 0 : -size * 0.32, zIndex: marks.length - i }}>
          <TokenLogo id={m.id} symbol={m.symbol} size={size} logoSrc={m.src} className="rounded-full" />
        </span>
      ))}
      {art.badges && (
        <span className="absolute -bottom-1 -right-2 flex">
          {art.badges.map((b, i) => (
            <span key={b.id} className="overflow-hidden rounded-full ring-2 ring-panel" style={{ marginLeft: i === 0 ? 0 : -5, width: size * 0.5, height: size * 0.5 }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={b.src} alt="" width={size * 0.5} height={size * 0.5} className="h-full w-full object-cover" />
            </span>
          ))}
        </span>
      )}
    </span>
  );
}
