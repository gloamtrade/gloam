import type { ReactNode } from "react";

/** Pieces shared by the contest pages (/contest and /contest/writers). */

export const SECTION = "mx-auto max-w-[1240px] scroll-mt-24 px-5 pt-24 sm:px-7 sm:pt-36";

export const TEXT_LINK = "text-foreground underline decoration-line-strong underline-offset-4 hover:decoration-foreground";

export function SectionHead({ id, label, title, children }: { id: string; label: string; title: string; children?: ReactNode }) {
  return (
    <div className="max-w-[720px]">
      <p className="t-label">{label}</p>
      <h2 id={`${id}-title`} className="t-display-l mt-4">
        {title}
      </h2>
      {children && <div className="mt-5 max-w-[56ch] text-[17px] leading-[1.6] text-mute sm:text-[19px]">{children}</div>}
    </div>
  );
}

/** Weighted judging criteria: name, what it means, weight in percent. */
export function CriteriaList({ items }: { items: [string, string, number][] }) {
  return (
    <ul className="mt-12 divide-y divide-line border-y border-line">
      {items.map(([name, line, weight]) => (
        <li key={name} className="grid grid-cols-[1fr_auto] items-baseline gap-x-6 gap-y-1 py-6 sm:grid-cols-[1fr_1.4fr_auto] sm:py-7">
          <p className="text-[19px] tracking-[-0.01em] sm:text-[22px]">{name}</p>
          <p className="col-span-2 row-start-2 text-[15px] leading-relaxed text-mute sm:col-span-1 sm:row-start-1 sm:col-start-2">
            {line}
          </p>
          <p className="tnum col-start-2 row-start-1 text-[19px] text-soft sm:col-start-3 sm:text-[22px]">{weight}%</p>
        </li>
      ))}
    </ul>
  );
}

export function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <li className="grid gap-3 py-8 sm:py-10 lg:grid-cols-[1fr_1.3fr] lg:gap-16">
      <p className="flex items-baseline gap-4 text-[22px] leading-snug tracking-[-0.01em] sm:text-[26px]">
        <span className="tnum text-[15px] text-faint">0{n}</span>
        {title}
      </p>
      <p className="max-w-[52ch] text-[16px] leading-relaxed text-soft sm:text-[17px]">{children}</p>
    </li>
  );
}

export function DateCard({ term, value }: { term: string; value: string }) {
  return (
    <div className="gl-card flex flex-col gap-6 p-5 sm:p-6">
      <dt className="text-[14px] text-mute">{term}</dt>
      <dd className="text-[19px] leading-snug tracking-[-0.01em] sm:text-[21px]">{value}</dd>
    </div>
  );
}

export function BulletList({ items }: { items: string[] }) {
  return (
    <ul className="mt-12 grid max-w-[880px] gap-x-12 sm:grid-cols-2">
      {items.map((r) => (
        <li key={r} className="flex items-start gap-3 border-b border-line py-4 text-[16px] leading-relaxed text-soft">
          <span aria-hidden className="mt-[10px] h-1.5 w-1.5 shrink-0 rounded-full bg-foreground/40" />
          {r}
        </li>
      ))}
    </ul>
  );
}

export function Faq({ items }: { items: [string, string][] }) {
  return (
    <div className="mt-12 max-w-[820px] divide-y divide-line border-y border-line">
      {items.map(([q, a]) => (
        <details key={q} className="group py-1">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-6 py-5 text-[17px] text-foreground sm:text-[19px] [&::-webkit-details-marker]:hidden">
            {q}
            <span aria-hidden className="text-[20px] leading-none text-mute transition-transform group-open:rotate-45">
              +
            </span>
          </summary>
          <p className="max-w-[60ch] pb-6 text-[15.5px] leading-relaxed text-soft">{a}</p>
        </details>
      ))}
    </div>
  );
}
