import type { Metadata } from "next";
import Link from "next/link";
import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";
import { AuthorLine, PostCard, PostMeta } from "@/components/blog/PostCard";
import { PostCover } from "@/components/blog/PostCover";
import { POSTS, postHref } from "@/lib/posts";
import { liveMainnetNames } from "@/lib/mainnet";

const title = "Research";
const description =
  "Writing by Duke, founder of Gloam, on private money: why payments on public chains need privacy, the models for it, and what we ship.";

export const metadata: Metadata = {
  title,
  description,
  authors: [{ name: "Duke", url: "https://x.com/dukedotsol" }],
  alternates: { canonical: "/research" },
  openGraph: { title: "Gloam research", description, url: "/research", siteName: "Gloam", type: "website" },
};

/** The long reads on the site that explain Gloam itself. */
const EXPLAINED: { href: string; label: string; line: string }[] = [
  { href: "/mainnet", label: "Mainnet launch", line: `Gloam live on ${liveMainnetNames()} mainnet` },
  { href: "/token", label: "The $GLOAM token", line: "What it does, how buybacks work, and what comes next" },
  { href: "/docs/compare", label: "How Gloam compares", line: "Against Zama, Arcium, Tempo Zones, Helius Privacy and Railgun" },
  { href: "/whitepaper", label: "Whitepaper", line: "Thesis, architecture, cryptography and roadmap" },
  { href: "/docs/privacy-model", label: "What stays private", line: "What an explorer still shows, and what stays hidden" },
  { href: "/docs/threat-model", label: "Threat model", line: "Who can do what, including us, and the gaps we know about" },
];

export default function ResearchPage() {
  const [latest, ...rest] = POSTS;

  return (
    <>
      <Header />
      <main className="mx-auto max-w-[1400px] px-4 sm:px-7">
        <header className="max-w-[760px] px-2 pt-12 sm:pt-20">
          <h1 className="t-display-xl">Research</h1>
          <p className="mt-5 max-w-[54ch] text-[18px] leading-relaxed text-soft sm:text-[19px]">
            Why money on public chains needs privacy, the ways to get it, and what we ship. Written by{" "}
            <a
              href="https://x.com/dukedotsol"
              className="text-foreground underline decoration-line-strong underline-offset-4 transition-colors hover:decoration-foreground"
            >
              Duke
            </a>
            , founder of Gloam.
          </p>
        </header>

        {latest && (
          <section aria-label="Latest post" className="mt-12 sm:mt-16">
            <Link
              href={postHref(latest)}
              className="post-card group grid items-center gap-x-12 gap-y-7 rounded-[26px] outline-offset-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]"
            >
              <PostCover id={latest.cover} size="feature" />
              <PostCover id={latest.cover} size="thumb" className="post-feature-small" />
              <div className="px-2 lg:px-0 lg:pr-6">
                <PostMeta post={latest} />
                <h2 className="t-display-m mt-3 group-hover:underline group-hover:decoration-line-strong group-hover:decoration-1 group-hover:underline-offset-[6px]">
                  {latest.title}
                </h2>
                <p className="mt-4 max-w-[46ch] text-[17px] leading-relaxed text-soft">{latest.summary}</p>
                <div className="mt-7">
                  <AuthorLine small />
                </div>
              </div>
            </Link>
          </section>
        )}

        {rest.length > 0 && (
          <section aria-labelledby="more-posts" className="mt-20 sm:mt-28">
            <h2 id="more-posts" className="t-title px-2 text-foreground">
              More posts
            </h2>
            <ul className="mt-6 grid grid-cols-1 gap-x-6 gap-y-14 sm:grid-cols-2 lg:grid-cols-3">
              {rest.map((p) => (
                <li key={p.slug}>
                  <PostCard post={p} />
                </li>
              ))}
            </ul>
          </section>
        )}

        <section aria-labelledby="explained" className="mt-24 px-2 sm:mt-32">
          <h2 id="explained" className="t-display-m">
            Gloam, explained
          </h2>
          <p className="mt-3 max-w-[60ch] text-pretty text-[16px] leading-relaxed text-mute">
            The longer pages that say what Gloam is, what it hides and what it does not.
          </p>
          <ul className="mt-10 grid grid-cols-1 gap-x-8 sm:grid-cols-2 lg:grid-cols-3">
            {EXPLAINED.map((d) => (
              <li key={d.href} className="border-t border-line">
                <Link href={d.href} className="group flex items-start justify-between gap-4 py-5">
                  <span>
                    <span className="block text-[16px] text-foreground">{d.label}</span>
                    <span className="mt-1 block text-[14px] leading-relaxed text-mute">{d.line}</span>
                  </span>
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 16 16"
                    fill="none"
                    aria-hidden
                    className="mt-1 shrink-0 text-faint transition-[color,transform] duration-200 group-hover:translate-x-0.5 group-hover:text-foreground"
                  >
                    <path d="M6 3.5L10.5 8 6 12.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      </main>
      <Footer />
    </>
  );
}
