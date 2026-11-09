import Image from "next/image";

/**
 * Partners already live on Gloam: a plain logo row on the landing page and /partners.
 * Raeto, Agent Wormhole, Motion, Killfloor and Autonomo are drawn inline so they follow the theme: Raeto's
 * ring takes the text colour, the others keep their own dark grounds.
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

type Partner = {
  name: string;
  href: string;
  /** One short line, shown on /partners only. */
  line: string;
  Mark: (p: { size?: number }) => React.JSX.Element;
  /** The mark is a wordmark that already spells the name, so the name is only read out, not shown. */
  wordmark?: boolean;
};

export const LIVE_PARTNERS: Partner[] = [
  { name: "Raeto", href: "https://raeto.cc", line: "Private agent funding", Mark: RaetoMark },
  { name: "Agent Wormhole", href: "https://agentwormhole.com", line: "Agent payments checked before they go", Mark: AgentWormholeMark },
  { name: "Zedkr", href: "https://zedkr.finance", line: "Shop Amazon and eBay from a private balance", Mark: ZedkrMark },
  { name: "Motion", href: "https://motion.gift", line: "Fund a trading wallet privately", Mark: MotionMark },
  { name: "VEYA", href: "https://www.veyanet.tech", line: "Budget checks before an agent pays", Mark: VeyaWordmark, wordmark: true },
  { name: "Killfloor", href: "https://killfloor.org", line: "AI agents pay each other privately", Mark: KillfloorMark },
  { name: "Autonomo", href: "https://autonomo.fun", line: "Agents pay for APIs privately", Mark: AutonomoMark },
  { name: "Oak", href: "https://oakagentkit.org", line: "Private payments from your AI assistant", Mark: OakMark },
];

function PartnerLink({ p, withLine = false, size = 32 }: { p: Partner; withLine?: boolean; size?: number }) {
  return (
    <a
      href={p.href}
      target="_blank"
      rel="noopener noreferrer"
      className="flex min-h-11 items-center gap-3 rounded-lg text-foreground transition-opacity hover:opacity-70 focus-visible:outline-2 focus-visible:outline-offset-4"
    >
      {p.wordmark && !withLine ? (
        <>
          <p.Mark size={size} />
          <span className="sr-only">{p.name}</span>
        </>
      ) : (
        <>
          {!p.wordmark && <p.Mark size={size} />}
          <span>
            {p.wordmark ? (
              <span className="block py-0.5">
                <p.Mark size={size} />
                <span className="sr-only">{p.name}</span>
              </span>
            ) : (
              <span className={`block leading-tight tracking-[-0.01em] ${size > 32 ? "text-[19px]" : "text-[17px]"}`}>{p.name}</span>
            )}
            {withLine && <span className="mt-0.5 block text-[13px] text-mute">{p.line}</span>}
          </span>
        </>
      )}
    </a>
  );
}

/**
 * Landing page, right under the hero: who already runs on Gloam. A quiet line
 * and the real marks, centred on the page, so a short list sits balanced and a
 * longer one wraps into centred rows the same way.
 */
export function LivePartnersStrip() {
  return (
    <section aria-labelledby="partners" className="mx-auto max-w-[1400px] px-4 pt-16 sm:px-7 sm:pt-24">
      <h2 id="partners" className="text-center text-[14px] text-mute">
        Live with Gloam
      </h2>
      <ul className="mx-auto mt-6 flex max-w-[960px] flex-wrap items-center justify-center gap-x-12 gap-y-6 sm:mt-8 sm:gap-x-20">
        {LIVE_PARTNERS.map((p) => (
          <li key={p.name}>
            <PartnerLink p={p} size={40} />
          </li>
        ))}
      </ul>
    </section>
  );
}

/** /partners: the same row, with one short line under each name. */
export function LivePartnersSection() {
  return (
    <section aria-labelledby="already-live" className="mx-auto max-w-[1240px] px-6 pt-20 sm:pt-28">
      <h2 id="already-live" className="text-[14px] text-mute">
        Already live with Gloam
      </h2>
      <ul className="mt-5 flex flex-wrap items-center gap-x-12 gap-y-5">
        {LIVE_PARTNERS.map((p) => (
          <li key={p.name}>
            <PartnerLink p={p} withLine />
          </li>
        ))}
      </ul>
    </section>
  );
}
