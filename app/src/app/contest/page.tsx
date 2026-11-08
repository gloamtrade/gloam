import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";
import { FlowField } from "@/components/ui/FlowField";
import { CONTEST, CONTEST_TOTAL, contestClosed, contestDay, contestTime, placeLabel } from "@/lib/contest";
import { ContestForm } from "./ContestForm";

/**
 * /contest: the Gloam Video Contest. One idea per section: the prize, what to
 * make, how to enter, the dates, how it is judged, the rules, the form and a
 * short FAQ.
 *
 * Prizes and dates live in CONTEST (lib/contest.ts), the one place to change
 * them: the form, the API route, the link preview and Glim read them too.
 */

// Re-rendered every minute, so the form shows closed within a minute of the close time.
// The server decides `closed` and the form only reads it, so server and browser agree.
export const revalidate = 60;

const TITLE = CONTEST.name;
const DESCRIPTION = `$${CONTEST_TOTAL} for the best videos about Gloam, private money on public chains. Entries close ${contestDay(CONTEST.closesAt, false)}.`;

export const metadata: Metadata = {
  title: { absolute: TITLE },
  description: DESCRIPTION,
  alternates: { canonical: "/contest" },
  openGraph: { title: TITLE, description: DESCRIPTION, url: "/contest", siteName: "Gloam", type: "website" },
  twitter: { card: "summary_large_image", title: TITLE, description: DESCRIPTION, site: "@gloamtrade" },
};

const IDEAS = [
  "A private payment, start to finish",
  "Cashing out",
  "A payroll run",
  "Paying an AI agent privately",
  "Why privacy matters on public chains",
  "How Gloam keeps a payment private, explained",
];

const JUDGING: [string, string, number][] = [
  ["Clarity", "Does a viewer understand what Gloam does?", 40],
  ["Creativity", "Something we haven’t seen before.", 30],
  ["Production quality", "Sound, pacing and picture.", 20],
  ["A real flow in the app", "A private payment or another flow, on mainnet or testnet.", 10],
];

const RULES = [
  "Original work only.",
  "One entry per X account.",
  "The video stays public until winners are paid.",
  "No impersonating other projects.",
  "No bought likes, views or followers.",
  "Entries that break a rule are removed.",
  "We may share winning videos on Gloam’s channels, with credit.",
];

const FAQ: [string, string][] = [
  ["Do I need to use real money?", "No. The testnet is fine, and so is a video about the idea without the app."],
  [
    "Can my video be long?",
    "Yes. Any length works. Host a longer video on YouTube or elsewhere, link to it in your post on X, and add the link in the form.",
  ],
  [
    "Can I enter more than once?",
    "One entry per X account. To change it, send the form again with the same X handle. The latest one counts.",
  ],
  ["How do I get paid?", `With a private Gloam claim link, sent by DM from @${CONTEST.account}.`],
  ["Which language?", "Any language. Add English subtitles if it isn’t in English."],
];

function SectionHead({ id, label, title, children }: { id: string; label: string; title: string; children?: ReactNode }) {
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

const SECTION = "mx-auto max-w-[1240px] scroll-mt-24 px-5 pt-24 sm:px-7 sm:pt-36";

export default function ContestPage() {
  const closed = contestClosed();
  const opens = contestDay(CONTEST.opensAt);
  const closes = `${contestDay(CONTEST.closesAt)} at ${contestTime(CONTEST.closesAt)}`;
  const winners = contestDay(CONTEST.winnersBy);
  const announcement = CONTEST.announcementUrl ?? `https://x.com/${CONTEST.account}`;
  const xLink = "text-foreground underline decoration-line-strong underline-offset-4 hover:decoration-foreground";

  return (
    <div className="relative min-h-screen bg-panel text-foreground">
      <Header />

      <main className="pb-8">
        {/* hero */}
        <section className="mx-auto max-w-[1400px] px-4 pt-3 sm:px-7 sm:pt-6">
          <div className="gl-panel flex min-h-[max(480px,calc(100svh-10rem))] flex-col justify-end px-5 pb-8 pt-24 sm:px-10 sm:pb-10 lg:min-h-[580px] lg:px-14 lg:pb-14">
            <FlowField />
            <div className="relative z-10 max-w-[760px]">
              <p className="text-[15px] text-mute">{CONTEST.name}</p>
              <h1 className="t-display-xl mt-4">${CONTEST_TOTAL} up for grabs</h1>
              <p className="mt-6 max-w-[44ch] text-[18px] leading-[1.55] text-soft">
                Make a video about Gloam, private money on public chains.
              </p>
              <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-3">
                <a href="#enter" className="btn btn-ink btn-lg">
                  {closed ? "Entries are closed" : "Enter the contest"}
                </a>
                <a href="#rules" className="gl-arrowlink">
                  Read the rules <span aria-hidden>→</span>
                </a>
              </div>
              <p className="tnum mt-8 text-[13.5px] text-mute">
                {closed ? `Entries closed ${closes}.` : `Entries close ${closes}.`}
              </p>
            </div>
          </div>
        </section>

        {/* prizes */}
        <section id="prizes" aria-labelledby="prizes-title" className={SECTION}>
          <SectionHead id="prizes" label="Prizes" title="Four winners, paid privately.">
            Each winner gets a Gloam claim link. Take it in USDG on Robinhood Chain or USDC on Base, your choice.
          </SectionHead>
          <ol className="mt-12 grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
            {CONTEST.prizes.map((usd, i) => (
              <li key={i} className="gl-card flex flex-col justify-between gap-10 p-5 sm:p-6">
                <span className="text-[14px] text-mute">{placeLabel(i)} place</span>
                <span className="tnum text-[36px] font-light leading-none tracking-[-0.03em] sm:text-[44px]">${usd}</span>
              </li>
            ))}
          </ol>
          <p className="tnum mt-5 text-[14px] text-mute">
            ${CONTEST_TOTAL} in total. <span className="text-sealed">Paid through Gloam, so the payouts stay private too.</span>
          </p>
        </section>

        {/* what to make */}
        <section id="make" aria-labelledby="make-title" className={SECTION}>
          <SectionHead id="make" label="What to make" title="Any video about Gloam.">
            An explainer, a tutorial, a short film, an animation, a skit or a meme. Long or short, all are welcome, and a
            carefully made video gets the attention it deserves. It has to show Gloam clearly, the app or the idea.
          </SectionHead>
          <div className="mt-12 max-w-[720px]">
            <p className="text-[14px] text-mute">Some ideas</p>
            <ul className="mt-4 divide-y divide-line border-y border-line">
              {IDEAS.map((idea) => (
                <li key={idea} className="flex items-center gap-4 py-4 text-[17px] text-soft sm:text-[18px]">
                  <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-sealed" />
                  {idea}
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* how to enter */}
        <section id="how" aria-labelledby="how-title" className={SECTION}>
          <SectionHead id="how" label="How to enter" title="Three steps.">
            You need both the post on X and the form. One without the other doesn&rsquo;t count.
          </SectionHead>
          <ol className="mt-12 divide-y divide-line border-y border-line">
            <Step n={1} title="Make the video">
              Any length, any style, about Gloam.
            </Step>
            <Step n={2} title="Post it on X">
              Quote{" "}
              <a href={announcement} target="_blank" rel="noreferrer" className={xLink}>
                the contest announcement
              </a>
              , tag @{CONTEST.account} and add {CONTEST.hashtag}. Put the video in the post, or link to it if it lives on
              YouTube or somewhere else.
            </Step>
            <Step n={3} title="Send us the link">
              Put the link to your post in{" "}
              <a href="#enter" className={xLink}>
                the form on this page
              </a>
              , and the full video link if it is hosted elsewhere.
            </Step>
          </ol>
        </section>

        {/* dates */}
        <section id="dates" aria-labelledby="dates-title" className={SECTION}>
          <SectionHead id="dates" label="Dates" title="One week to enter." />
          <dl className="tnum mt-12 grid gap-3 sm:grid-cols-3 sm:gap-4">
            <DateCard term="Entries open" value={opens} />
            <DateCard term="Entries close" value={closes} />
            <DateCard term="Winners announced" value={`By ${winners}, on @${CONTEST.account}`} />
          </dl>
        </section>

        {/* judging */}
        <section id="judging" aria-labelledby="judging-title" className={SECTION}>
          <SectionHead id="judging" label="Judging" title="What we look for.">
            Likes and views are not counted, so bought engagement doesn&rsquo;t help. The Gloam team picks the winners, and
            the decision is final.
          </SectionHead>
          <ul className="mt-12 divide-y divide-line border-y border-line">
            {JUDGING.map(([name, line, weight]) => (
              <li key={name} className="grid grid-cols-[1fr_auto] items-baseline gap-x-6 gap-y-1 py-6 sm:grid-cols-[1fr_1.4fr_auto] sm:py-7">
                <p className="text-[19px] tracking-[-0.01em] sm:text-[22px]">{name}</p>
                <p className="col-span-2 row-start-2 text-[15px] leading-relaxed text-mute sm:col-span-1 sm:row-start-1 sm:col-start-2">
                  {line}
                </p>
                <p className="tnum col-start-2 row-start-1 text-[19px] text-soft sm:col-start-3 sm:text-[22px]">{weight}%</p>
              </li>
            ))}
          </ul>
        </section>

        {/* rules */}
        <section id="rules" aria-labelledby="rules-title" className={SECTION}>
          <SectionHead id="rules" label="Rules" title="Keep it fair." />
          <ul className="mt-12 grid max-w-[880px] gap-x-12 sm:grid-cols-2">
            {RULES.map((r) => (
              <li key={r} className="flex items-start gap-3 border-b border-line py-4 text-[16px] leading-relaxed text-soft">
                <span aria-hidden className="mt-[10px] h-1.5 w-1.5 shrink-0 rounded-full bg-foreground/40" />
                {r}
              </li>
            ))}
          </ul>
          <div className="mt-10 max-w-[720px] rounded-2xl bg-sealed-soft px-5 py-5 sm:px-6">
            <p className="text-[15px] font-medium text-foreground">You never need to deposit money.</p>
            <p className="mt-2 text-[14.5px] leading-relaxed text-soft">
              The testnet is fine. We never ask for a private key, a seed phrase or a wallet connection to enter. Gloam
              never DMs first asking for keys or funds, and winners are contacted only from @{CONTEST.account}.
            </p>
          </div>
        </section>

        {/* the form */}
        <section id="enter" aria-labelledby="enter-title" className={SECTION}>
          <div className="grid grid-cols-1 items-start gap-12 lg:grid-cols-[1fr_minmax(0,560px)] lg:gap-20">
            <div className="lg:sticky lg:top-28">
              <p className="t-label">Enter</p>
              <h2 id="enter-title" className="t-display-l mt-4 max-w-[12ch]">
                {closed ? "Entries are closed." : "Send us your post."}
              </h2>
              <p className="mt-6 max-w-[40ch] text-[16px] leading-relaxed text-soft sm:text-[17px]">
                {closed
                  ? `Thanks to everyone who entered. Winners are announced by ${winners} on @${CONTEST.account}.`
                  : `Post your video on X first, with ${CONTEST.hashtag} and @${CONTEST.account}. Then add the link here.`}
              </p>
              <p className="mt-6 max-w-[40ch] text-[13.5px] leading-relaxed text-mute">
                We keep your entry to run the contest and contact winners, and for nothing else. Only the Gloam team can
                read it.
              </p>
            </div>
            <div className="gl-card p-6 sm:p-8">
              <ContestForm closed={closed} />
            </div>
          </div>
        </section>

        {/* faq */}
        <section id="faq" aria-labelledby="faq-title" className={SECTION}>
          <SectionHead id="faq" label="FAQ" title="Questions." />
          <div className="mt-12 max-w-[820px] divide-y divide-line border-y border-line">
            {FAQ.map(([q, a]) => (
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
          <p className="mt-8 text-[14px] text-mute">
            Anything else? Ask{" "}
            <a href={`https://x.com/${CONTEST.account}`} target="_blank" rel="noreferrer" className={xLink}>
              @{CONTEST.account}
            </a>{" "}
            on X or email{" "}
            <a href="mailto:hello@gloam.trade" className={xLink}>
              hello@gloam.trade
            </a>
            .
          </p>
        </section>
      </main>

      <Footer />
    </div>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
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

function DateCard({ term, value }: { term: string; value: string }) {
  return (
    <div className="gl-card flex flex-col gap-6 p-5 sm:p-6">
      <dt className="text-[14px] text-mute">{term}</dt>
      <dd className="text-[19px] leading-snug tracking-[-0.01em] sm:text-[21px]">{value}</dd>
    </div>
  );
}
