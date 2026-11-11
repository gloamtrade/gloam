import Image from "next/image";
import Link from "next/link";
import { AppLink } from "./AppLink";
import { FooterUpdates } from "./FooterUpdates";
import { Mark } from "./Logo";
import { ThemeSegmented } from "./ThemeToggle";

const groups: {
  title: string;
  links: { href: string; label: string; external?: boolean }[];
}[] = [
  {
    title: "Product",
    links: [
      { href: "/app", label: "Open app" },
      { href: "/agents", label: "For agents" },
      { href: "/app/payroll", label: "Payroll" },
      { href: "/app/vault", label: "Private balance" },
      { href: "/app/disclose", label: "Prove" },
      { href: "/docs/testnet", label: "Testnet guide" },
      { href: "/testers", label: "Become a tester" },
      { href: "/contest", label: "Video contest" },
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
      { href: "/brand", label: "Brand" },
      { href: "/pitch", label: "Pitch" },
    ],
  },
];

const legal = [
  { href: "/terms", label: "Terms" },
  { href: "/privacy", label: "Privacy" },
  { href: "/cookies", label: "Cookies" },
  { href: "/disclosures", label: "Risk disclosures" },
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
 */
export function Footer() {
  const year = new Date().getFullYear();

  return (
    <footer className="mx-auto w-full max-w-[1400px] px-4 pb-4 pt-24 sm:px-7 sm:pb-7 sm:pt-32">
      <div className="theme-dark gl-panel rounded-[28px] bg-black text-foreground">
        <div className="relative z-10 mx-auto max-w-[1240px] px-6 pt-12 sm:px-12 sm:pt-16">
          <div className="grid gap-12 lg:grid-cols-[1.25fr_2fr]">
            <div>
              <div className="flex items-center gap-2.5">
                <Mark size={26} />
                <span className="text-[19px] font-medium tracking-[-0.015em]">Gloam</span>
              </div>
              <p className="mt-6 max-w-[17ch] text-[26px] font-light leading-[1.15] tracking-[-0.02em] text-soft">
                Private money on public chains.
              </p>
              <a
                href="mailto:hello@gloam.trade"
                className="gl-tap mt-4 inline-block text-[15px] text-mute transition-colors hover:text-foreground"
              >
                hello@gloam.trade
              </a>
              <FooterUpdates />
              <div className="-ml-3 mt-8 flex items-center gap-1">
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
              </div>
            </div>

            <div className="grid grid-cols-2 gap-x-8 gap-y-10 sm:grid-cols-3">
              {groups.map((g) => (
                <div key={g.title}>
                  <p className="text-[13px] font-medium text-foreground">
                    {g.title}
                  </p>
                  <ul className="mt-5 space-y-3">
                    {g.links.map((l) => (
                      <li key={l.href}>
                        {l.external ? (
                          <a
                            href={l.href}
                            target="_blank"
                            rel="noreferrer"
                            className="gl-tap text-[14.5px] text-soft transition-colors hover:text-foreground"
                          >
                            {l.label}
                          </a>
                        ) : l.href.startsWith("/app") ? (
                          <AppLink
                            href={l.href}
                            className="gl-tap text-[14.5px] text-soft transition-colors hover:text-foreground"
                          >
                            {l.label}
                          </AppLink>
                        ) : (
                          <Link
                            href={l.href}
                            className="gl-tap text-[14.5px] text-soft transition-colors hover:text-foreground"
                          >
                            {l.label}
                          </Link>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </div>

          {/* the official contract on every page, so anyone can check an address against the site */}
          <p className="mt-12 text-[12.5px] text-mute">
            $GLOAM contract on Robinhood Chain:{" "}
            <Link href="/token" className="tnum text-soft [overflow-wrap:anywhere] transition-colors hover:text-foreground">
              0xDcD885F5c60b3aD49F6D58718696417314e8724d
            </Link>
          </p>

          <div className="mt-5 flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
            <p className="text-[12.5px] text-mute">
              © {year} Gloam. Live on mainnet. Not investment, legal or tax advice.
            </p>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
              <ThemeSegmented />
              <nav aria-label="Legal" className="flex flex-wrap items-center text-[12.5px] text-mute">
                {legal.map((l, i) => (
                  <span key={l.href} className="flex items-center">
                    {i > 0 && <span aria-hidden className="mx-3 h-3 w-px bg-line-strong" />}
                    <Link href={l.href} className="gl-tap transition-colors hover:text-foreground">
                      {l.label}
                    </Link>
                  </span>
                ))}
              </nav>
            </div>
          </div>
        </div>

        {/* the etching bleeds off the bottom; its black sky is the panel */}
        <div className="relative -mt-6 h-[220px] sm:h-[300px] lg:h-[360px]">
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
