import Image from "next/image";
import Link from "next/link";

/**
 * Partners already live on Gloam: a plain logo row on the landing page and /partners.
 * Raeto, Agent Wormhole, Motion, Killfloor, Autonomo and Blocktronics are drawn inline so they follow the theme:
 * Raeto's ring takes the text colour, the others keep their own grounds.
 * Zedkr's mark and VEYA's wordmark are rendered files, so each ships as a light and a
 * dark PNG and the theme picks one. Oak's medallion is one round PNG that holds on both. Static copies of the first five live in public/brand/partners.
 */

/** Raeto's mark: an open ring, a centre dot and the green dot in the gap. */
export function RaetoMark({ size = 40 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="240 240 540 540" aria-hidden>
      <path
        d="M700 497A200 200 0 1 1 643.9 358.1"
        fill="none"
        stroke="currentColor"
        strokeWidth="76"
        strokeLinecap="round"
      />
      <circle cx="500" cy="497" r="61" fill="currentColor" />
      <circle cx="709" cy="367" r="57" fill="#2E6B47" />
    </svg>
  );
}

/** Agent Wormhole's mark: white rings drawn off-axis on a dark disc, edged in the text colour so it holds on dark grounds. */
export function AgentWormholeMark({ size = 40 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden>
      <defs>
        <radialGradient id="aw-disc" cx="38%" cy="32%" r="75%">
          <stop offset="0" stopColor="#2A2E37" />
          <stop offset="1" stopColor="#0D0F14" />
        </radialGradient>
      </defs>
      <circle cx="32" cy="32" r="32" fill="url(#aw-disc)" />
      <circle cx="32" cy="32" r="31.2" fill="none" stroke="currentColor" strokeOpacity="0.4" strokeWidth="1.6" />
      <g fill="none" stroke="#FFFFFF" strokeWidth="2.1">
        <circle cx="31.2" cy="31.2" r="22.5" />
        <circle cx="32.9" cy="32.9" r="17.6" />
        <circle cx="34.5" cy="34.5" r="13" />
        <circle cx="36" cy="36" r="8.8" />
        <circle cx="37.3" cy="37.3" r="5" />
      </g>
      <circle cx="38.4" cy="38.4" r="2" fill="#FFFFFF" />
    </svg>
  );
}

/** Motion's mark: their two forward triangles on a dark tile, edged in the text colour so it holds on dark grounds. */
export function MotionMark({ size = 40 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden>
      <rect width="64" height="64" rx="14" fill="#000000" />
      <rect x="0.8" y="0.8" width="62.4" height="62.4" rx="13.2" fill="none" stroke="currentColor" strokeOpacity="0.4" strokeWidth="1.6" />
      <path d="M10.88 14.72 L32 32 L10.88 49.28 Z M35.21 14.72 L56.33 32 L35.21 49.28 Z" fill="#F2F4FF" />
    </svg>
  );
}

/** Zedkr's mark: their own files from zedkr.finance, black on light and white on dark. */
export function ZedkrMark({ size = 40 }: { size?: number }) {
  const width = Math.round((size * 230) / 256);
  return (
    <>
      <Image src="/brand/partners/zedkr-mark.png" alt="" width={width} height={size} className="block dark:hidden" />
      <Image src="/brand/partners/zedkr-mark-white.png" alt="" width={width} height={size} className="hidden dark:block" />
    </>
  );
}

/** VEYA's wordmark: their own file from veyanet.tech, with its dark letters turned white for dark grounds. It carries the name, so no name is set beside it. */
export function VeyaWordmark({ size = 40 }: { size?: number }) {
  const height = Math.round(size * 0.55);
  const width = Math.round((height * 391) / 69);
  return (
    <>
      <Image src="/brand/partners/veya-wordmark.png" alt="" width={width} height={height} className="block dark:hidden" />
      <Image src="/brand/partners/veya-wordmark-white.png" alt="" width={width} height={height} className="hidden dark:block" />
    </>
  );
}

/** Killfloor's mark: their white pulse line with the red floor, on their dark disc, edged in the text colour so it holds on dark grounds. */
export function KillfloorMark({ size = 40 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden>
      <circle cx="32" cy="32" r="32" fill="#141414" />
      <circle cx="32" cy="32" r="31.2" fill="none" stroke="currentColor" strokeOpacity="0.4" strokeWidth="1.6" />
      <polyline points="13,36 21,36 26,17 33,45" fill="none" stroke="#F4F1EA" strokeWidth="3.6" strokeLinejoin="miter" strokeLinecap="square" />
      <rect x="32.5" y="42.6" width="17" height="4.4" fill="#C0392B" />
    </svg>
  );
}

/** Autonomo's mark: their own icon from autonomo.fun (black peak and bar on their yellow tile), edged in the text colour so it holds on dark grounds. */
export function AutonomoMark({ size = 40 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden>
      <rect width="64" height="64" rx="10" fill="#FFCE00" />
      <rect x="0.8" y="0.8" width="62.4" height="62.4" rx="9.2" fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="1.6" />
      <g fill="#111111">
        <path d="M32 9 49 41h-10L32 27.5 25 41H15Z" />
        <rect x="27.5" y="33" width="9" height="8" rx="1.5" />
        <rect x="11" y="46" width="42" height="7" rx="1.5" />
      </g>
    </svg>
  );
}

/** Oak's mark: their own tree medallion from oakagentkit.org, round with clear corners, so one file holds on both grounds. */
export function OakMark({ size = 40 }: { size?: number }) {
  return <Image src="/brand/partners/oak-mark.png" alt="" width={size} height={size} className="block rounded-full" />;
}

/** Blocktronics' mark: their four blocks (blue, pink, green and the black dot) on a white tile, as on their own avatar, edged in the text colour so the tile holds on light grounds. */
export function BlocktronicsMark({ size = 40 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden>
      <rect width="64" height="64" rx="14" fill="#FFFFFF" />
      <rect x="0.8" y="0.8" width="62.4" height="62.4" rx="13.2" fill="none" stroke="currentColor" strokeOpacity="0.18" strokeWidth="1.6" />
      <g transform="translate(14 14) scale(1.6364)">
        <rect width="10" height="10" rx="3" fill="#5151FC" />
        <rect x="12" width="10" height="10" rx="3" fill="#FFC0FF" />
        <rect y="12" width="10" height="10" rx="3" fill="#ABFF5A" />
        <rect x="12" y="12" width="10" height="10" rx="5" fill="#000000" />
      </g>
    </svg>
  );
}

type Partner = {
  name: string;
  href: string;
  /** What they do with Gloam, in one short line. */
  line: string;
  /** The kind of team, as a small tag on /partners. */
  kind: string;
  Mark: (p: { size?: number }) => React.JSX.Element;
  /** The mark is a wordmark that already spells the name, so the name is only read out beside it, not shown. */
  wordmark?: boolean;
};

export const LIVE_PARTNERS: Partner[] = [
  { name: "Raeto", href: "https://raeto.cc", line: "Private agent funding", kind: "Agents", Mark: RaetoMark },
  { name: "Agent Wormhole", href: "https://agentwormhole.com", line: "Agent payments checked before they go", kind: "Agents", Mark: AgentWormholeMark },
  { name: "Zedkr", href: "https://zedkr.finance", line: "Shop Amazon and eBay from a private balance", kind: "Shopping", Mark: ZedkrMark },
  { name: "Motion", href: "https://motion.gift", line: "Fund a trading wallet privately", kind: "Trading", Mark: MotionMark },
  { name: "VEYA", href: "https://www.veyanet.tech", line: "Budget checks before an agent pays", kind: "Agents", Mark: VeyaWordmark, wordmark: true },
  { name: "Killfloor", href: "https://killfloor.org", line: "AI agents pay each other privately", kind: "Agents", Mark: KillfloorMark },
  { name: "Autonomo", href: "https://autonomo.fun", line: "Agents pay for APIs privately", kind: "Agents", Mark: AutonomoMark },
  { name: "Oak", href: "https://oakagentkit.org", line: "Private payments from your AI assistant", kind: "Assistants", Mark: OakMark },
  { name: "Blocktronics", href: "https://blocktronics.xyz", line: "Token checks before a private swap", kind: "Token data", Mark: BlocktronicsMark },
];

/** "raeto.cc" from "https://raeto.cc": the address as people would type it. */
function hostOf(href: string): string {
  return new URL(href).hostname.replace(/^www\./, "");
}

/**
 * One cell of the landing grid: the mark over the name. With a mouse, the line
 * waits under them and rises in on hover or keyboard focus. Touch screens keep
 * the grid to marks and names; the lines are on /partners.
 */
function PartnerCell({ p }: { p: Partner }) {
  return (
    <a
      href={p.href}
      target="_blank"
      rel="noopener noreferrer"
      className="group relative flex h-full min-h-[112px] flex-col items-center justify-center gap-2 px-4 py-6 text-center text-foreground transition-colors duration-200 hover:bg-surface focus-visible:bg-surface focus-visible:outline-none sm:min-h-[152px]"
    >
      <span
        className="flex flex-col items-center gap-2.5 motion-safe:transition-transform motion-safe:duration-300 motion-safe:ease-out pointer-fine:group-hover:-translate-y-3.5 pointer-fine:group-focus-visible:-translate-y-3.5"
      >
        <span className="flex h-9 items-center">
          <p.Mark size={36} />
        </span>
        {p.wordmark ? (
          <span className="sr-only">{p.name}</span>
        ) : (
          <span className="text-[16px] leading-tight tracking-[-0.01em]">{p.name}</span>
        )}
      </span>
      <span
        className="hidden max-w-[26ch] text-[12.5px] leading-snug text-mute pointer-fine:pointer-events-none pointer-fine:block pointer-fine:absolute pointer-fine:inset-x-4 pointer-fine:bottom-4 pointer-fine:mx-auto pointer-fine:translate-y-1 pointer-fine:opacity-0 motion-safe:transition-[opacity,transform] motion-safe:duration-300 pointer-fine:group-hover:translate-y-0 pointer-fine:group-hover:opacity-100 pointer-fine:group-focus-visible:translate-y-0 pointer-fine:group-focus-visible:opacity-100"
      >
        {p.line}
      </span>
      <span className="sr-only">(opens in a new tab)</span>
    </a>
  );
}

/**
 * Landing page, right under the hero: who already runs on Gloam, as a ruled
 * grid of equal cells (the hairlines are the grid's own gaps). The last cell
 * keeps a seat open for the next team, so the grid always fills: 2 across on
 * phones, 5 across from tablets up.
 */
export function LivePartnersStrip() {
  return (
    <section aria-labelledby="partners" className="mx-auto max-w-[1240px] px-4 pt-16 sm:px-7 sm:pt-24">
      <h2 id="partners" className="text-center text-[14px] text-mute">
        Live with Gloam
      </h2>
      <ul className="mt-6 grid grid-cols-2 gap-px overflow-hidden rounded-[22px] border border-line bg-line sm:mt-8 sm:grid-cols-5">
        {LIVE_PARTNERS.map((p) => (
          <li key={p.name} className="bg-background">
            <PartnerCell p={p} />
          </li>
        ))}
        <li className="bg-background">
          <Link
            href="/partners"
            className="group flex h-full min-h-[112px] flex-col items-center justify-center gap-2.5 px-4 py-6 text-center text-mute transition-colors duration-200 hover:bg-surface hover:text-foreground focus-visible:bg-surface focus-visible:text-foreground focus-visible:outline-none sm:min-h-[152px]"
          >
            <span aria-hidden className="grid h-9 w-9 place-items-center rounded-[10px] border border-dashed border-line-strong text-[18px] leading-none transition-colors group-hover:border-foreground">
              +
            </span>
            <span className="text-[16px] leading-tight tracking-[-0.01em]">
              Your app here <span aria-hidden>→</span>
            </span>
          </Link>
        </li>
      </ul>
    </section>
  );
}

/** /partners: a card for each team, with what kind of team it is, what it does with Gloam and where to find it. */
export function LivePartnersSection() {
  return (
    <section aria-labelledby="already-live" className="mx-auto max-w-[1240px] px-6 pt-20 sm:pt-28">
      <h2 id="already-live" className="t-display-m">
        Already live with Gloam
      </h2>
      <ul className="mt-8 grid grid-cols-1 gap-3 sm:mt-10 sm:grid-cols-3">
        {LIVE_PARTNERS.map((p) => (
          <li key={p.name}>
            <a
              href={p.href}
              target="_blank"
              rel="noopener noreferrer"
              className="group flex h-full flex-col rounded-[22px] border border-line p-5 text-foreground transition-colors duration-200 hover:border-line-strong hover:bg-surface focus-visible:outline-2 focus-visible:outline-offset-2 sm:p-6"
            >
              <span className="flex items-start justify-between gap-4">
                <span className="flex h-10 items-center">
                  <p.Mark size={40} />
                </span>
                <span className="rounded-full border border-line px-2.5 py-1 text-[12px] leading-none text-mute">{p.kind}</span>
              </span>
              <span className="mt-4 text-[18px] leading-tight sm:mt-6 tracking-[-0.01em]">{p.name}</span>
              <span className="mt-1.5 text-[14px] leading-relaxed text-mute">{p.line}</span>
              <span className="mt-auto inline-flex items-center gap-1.5 pt-4 text-[13px] sm:pt-6 text-mute transition-colors group-hover:text-foreground">
                {hostOf(p.href)}
                <span aria-hidden>↗</span>
                <span className="sr-only">(opens in a new tab)</span>
              </span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}
