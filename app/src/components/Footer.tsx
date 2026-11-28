import Image from "next/image";
import Link from "next/link";
import { AppLink } from "./AppLink";
import { FooterUpdates } from "./FooterUpdates";
import { Mark } from "./Logo";
import { ThemeSegmented } from "./ThemeToggle";
import { SHOW_TESTNETS } from "@/lib/showTestnets";
import { SOLANA_RINGS_ENABLED } from "@/lib/solanaRings/config";

const groups: {
  title: string;
  /** document: a page outside the Next router (a static file or a rewrite to one): a plain link, never prefetched. */
  links: { href: string; label: string; external?: boolean; document?: boolean }[];
}[] = [
  {
    title: "Product",
    links: [
      { href: "/app", label: "Open app" },
      { href: "/agents", label: "For agents" },
      { href: "/app/payroll", label: "Payroll" },
      { href: "/app/vault", label: "Private balance" },
      { href: "/app/disclose", label: "Prove" },
      // only while Gloam on Solana is on (lib/solanaRings/config)
      ...(SOLANA_RINGS_ENABLED ? [{ href: "/app/solana", label: "Solana" }] : []),
      // only while people see the testnets (lib/showTestnets)
      ...(SHOW_TESTNETS ? [{ href: "/docs/testnet", label: "Testnet guide" }] : []),
      { href: "/testers", label: "Become a tester" },
      { href: "/contest/writers", label: "Writing contest" },
    ],
  },
  {
    title: "Developers",
    links: [
      { href: "/sdk", label: "SDK" },
      { href: "/docs", label: "Docs" },
      { href: "/docs/agents", label: "Agents guide" },
      { href: "/partners", label: "Partners" },
      { href: "/token", label: "$GLOAM token" },
      { href: "/whitepaper", label: "Whitepaper" },
      { href: "/verify#contracts", label: "Verify contracts" },
      { href: "/security", label: "Security" },
    ],
  },
  {
    title: "Company",
    links: [
      { href: "/research", label: "Research" },
      { href: "/transparency", label: "Transparency" },
      { href: "/stats", label: "Stats" },
      { href: "https://status.gloam.trade", label: "Status", external: true },
      { href: "/brand", label: "Brand" },
      // public/pitch/index.html through a rewrite: Link's prefetch of it 404'd on every page
      { href: "/pitch", label: "Pitch", document: true },
    ],
  },
];

const legal = [
  { href: "/terms", label: "Terms" },
  { href: "/privacy", label: "Privacy" },
  { href: "/cookies", label: "Cookies" },
  { href: "/disclosures", label: "Risk disclosures" },
  { href: "/compliance", label: "Compliance" },
];

function XIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M17.75 3h3.07l-6.7 7.66L22 21h-6.17l-4.83-6.32L5.47 21H2.4l7.17-8.2L2 3h6.33l4.37 5.77L17.75 3zm-1.08 16.2h1.7L7.4 4.7H5.57l11.1 14.5z" />
    </svg>
  );
}
function TelegramIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M21.94 4.3l-3.33 15.68c-.25 1.1-.9 1.37-1.83.85l-5.06-3.73-2.44 2.35c-.27.27-.5.5-1.02.5l.36-5.14 9.36-8.46c.41-.36-.09-.56-.63-.2L5.77 13.43.79 11.87c-1.08-.34-1.1-1.08.23-1.6L20.5 2.76c.9-.33 1.69.21 1.44 1.54z" />
    </svg>
  );
}
function GitHubIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M12 2a10 10 0 0 0-3.16 19.49c.5.09.68-.22.68-.48v-1.7c-2.78.6-3.37-1.34-3.37-1.34-.45-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.6.07-.6 1 .07 1.53 1.03 1.53 1.03.9 1.52 2.34 1.08 2.91.83.09-.65.35-1.09.63-1.34-2.22-.25-4.55-1.11-4.55-4.94 0-1.09.39-1.98 1.03-2.68-.1-.25-.45-1.27.1-2.64 0 0 .84-.27 2.75 1.02a9.56 9.56 0 0 1 5 0c1.91-1.29 2.75-1.02 2.75-1.02.55 1.37.2 2.39.1 2.64.64.7 1.03 1.59 1.03 2.68 0 3.84-2.34 4.69-4.57 4.93.36.31.68.92.68 1.86v2.76c0 .27.18.58.69.48A10 10 0 0 0 12 2z" />
    </svg>
  );
}

/**
 * Footer: an ink panel with an etched dusk landscape bleeding off the bottom,
 * a lone courier carrying a sealed letter. Always dark, in either theme.
 * Three calm bands: the line and the sign-up, four link columns, then the
 * small print, each with room to breathe.
 */
export function Footer() {
  const year = new Date().getFullYear();
  const linkCls = "gl-tap text-[15px] text-soft transition-colors hover:text-foreground";
  const columns = [...groups, { title: "Legal", links: legal }];

  return (
    <footer className="mx-auto w-full max-w-[1400px] px-4 pb-4 pt-24 sm:px-7 sm:pb-7 sm:pt-32">
      <div className="theme-dark gl-panel rounded-[28px] bg-black text-foreground">
        <div className="relative z-10 mx-auto max-w-[1240px] px-7 pt-16 sm:px-12 sm:pt-24 lg:px-16">
          {/* the line, and how to keep in touch */}
          <div className="grid gap-12 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)] lg:items-end lg:gap-20">
            <div>
              <div className="flex items-center gap-2.5">
                <Mark size={26} />
                <span className="text-[19px] font-medium tracking-[-0.015em]">Gloam</span>
              </div>
              <p className="mt-10 max-w-[14ch] text-balance text-[40px] font-light leading-[1.05] tracking-[-0.03em] text-foreground sm:text-[56px]">
                Private money on public chains.
              </p>
            </div>
            <div className="lg:pb-2">
              <FooterUpdates />
              <div className="-ml-2.5 mt-6 flex items-center gap-1">
                <a
                  href="https://x.com/gloamtrade"
                  target="_blank"
                  rel="noreferrer"
                  aria-label="Gloam on X"
                  className="grid h-10 w-10 place-items-center rounded-full text-soft transition-colors hover:bg-white/10 hover:text-foreground"
                >
                  <XIcon />
                </a>
                <a
                  href="https://t.me/gloamhq"
                  target="_blank"
                  rel="noreferrer"
                  aria-label="Gloam on Telegram"
                  className="grid h-10 w-10 place-items-center rounded-full text-soft transition-colors hover:bg-white/10 hover:text-foreground"
                >
                  <TelegramIcon />
                </a>
                <a
                  href="https://github.com/gloamtrade/gloam"
                  target="_blank"
                  rel="noreferrer"
                  aria-label="Gloam on GitHub"
                  className="grid h-10 w-10 place-items-center rounded-full text-soft transition-colors hover:bg-white/10 hover:text-foreground"
                >
                  <GitHubIcon />
                </a>
                <a href="mailto:hello@gloam.trade" className="gl-tap ml-3 text-[15px] text-soft transition-colors hover:text-foreground">
                  hello@gloam.trade
                </a>
              </div>
            </div>
          </div>

          {/* four columns, evenly spaced */}
          <div className="mt-16 grid grid-cols-2 gap-x-8 gap-y-12 border-t border-white/10 pt-12 sm:mt-20 sm:grid-cols-4 sm:pt-14">
            {columns.map((g) => (
              <div key={g.title}>
                <p className="text-[13px] text-mute">{g.title}</p>
                <ul className="mt-6 space-y-4">
                  {g.links.map((l) => (
                    <li key={l.href}>
                      {"external" in l && l.external ? (
                        <a href={l.href} target="_blank" rel="noreferrer" className={linkCls}>
                          {l.label}
                        </a>
                      ) : "document" in l && l.document ? (
                        <a href={l.href} className={linkCls}>
                          {l.label}
                        </a>
                      ) : l.href.startsWith("/app") ? (
                        <AppLink href={l.href} className={linkCls}>
                          {l.label}
                        </AppLink>
                      ) : (
                        <Link href={l.href} className={linkCls}>
                          {l.label}
                        </Link>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>

          {/* the small print: who, the official contract (so anyone can check an address against the site), the theme */}
          <div className="mt-16 flex flex-col gap-6 border-t border-white/10 py-8 sm:mt-20 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex flex-col gap-2 text-[13px] text-mute sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-8">
              <span>© {year} Gloam. Not investment, legal or tax advice.</span>
              <span>
                $GLOAM on Robinhood Chain{" "}
                <Link href="/token" className="tnum text-soft [overflow-wrap:anywhere] transition-colors hover:text-foreground">
                  0xDcD885F5c60b3aD49F6D58718696417314e8724d
                </Link>
              </span>
            </div>
            <ThemeSegmented />
          </div>
        </div>

        {/* the etching bleeds off the bottom; its black sky is the panel */}
        <div className="relative -mt-4 h-[220px] sm:h-[300px] lg:h-[360px]">
          <Image
            src="/brand/art/courier-etching.jpg"
            alt="An engraved desert at dusk with a lone courier on horseback carrying a sealed letter"
            fill
            sizes="100vw"
            className="object-cover object-[50%_80%]"
          />
        </div>
      </div>
    </footer>
  );
}
