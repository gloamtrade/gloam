import type { Metadata } from "next";
import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";
import { FlowField } from "@/components/ui/FlowField";
import { contestDay, contestTime, placeLabel } from "@/lib/contest";
import {
  WRITING_CONTEST,
  WRITING_ENGAGEMENT_WEIGHT,
  WRITING_EQUAL_PRIZES,
  WRITING_JUDGING,
  WRITING_POOL,
  writingClosed,
} from "@/lib/writingContest";
import { BulletList, CriteriaList, DateCard, Faq, SECTION, SectionHead, Step, TEXT_LINK } from "../parts";
import { WritingForm } from "./WritingForm";

/**
 * /contest/writers: the Gloam Writing Contest. The same shape as the video
 * contest: the prize, what to write, how to enter, the dates, how it is
 * judged, the rules, the form and a short FAQ.
 *
 * Prizes and dates live in WRITING_CONTEST (lib/writingContest.ts).
 */

// Re-rendered every minute, so the form shows closed within a minute of the close time.
export const revalidate = 60;

const C = WRITING_CONTEST;
const TITLE = C.name;
const DESCRIPTION = `$${WRITING_POOL} for the best threads and articles about Gloam, private money on public chains. Entries close ${contestDay(C.closesAt, false)}.`;

export const metadata: Metadata = {
  title: { absolute: TITLE },
  description: DESCRIPTION,
  alternates: { canonical: C.path },
  openGraph: { title: TITLE, description: DESCRIPTION, url: C.path, siteName: "Gloam", type: "website" },
  twitter: { card: "summary_large_image", title: TITLE, description: DESCRIPTION, site: "@gloamtrade" },
};

/** "Four", for the prizes heading. */
const WINNERS_IN_WORDS = ["One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight"][C.prizes.length - 1] ?? String(C.prizes.length);

const IDEAS = [
  "Why your salary shouldn’t be public onchain",
  "A private payment on Gloam, start to finish",
  "Private payroll for a remote team",
  "How AI agents can pay without exposing their owners",
  "Private, but provable: showing one payment and nothing else",
  "What public-by-default money costs ordinary people",
];

const RULES = [
  `Threads have at least ${C.minThreadPosts} posts. Articles have at least ${C.minArticleWords} words.`,
  "Entries are posted on X: a thread, or an article published as an X Article.",
  "Original writing only. No AI-written entries.",
  "Write about the product, not the token price. No price predictions or investment advice.",
  "Get the facts right. Entries with false claims about Gloam are removed.",
  "Screenshots from the app are your own, from mainnet. Never show a seed phrase, private key, backup or an unclaimed claim link.",
  "One entry per X account.",
  "The post stays public until winners are paid.",
  "No bought likes, reposts, views or followers.",
  "No impersonating other projects.",
  "Entries that break a rule are removed.",
  "Gloam may share and quote entries, with credit to the writer.",
  `Winners are contacted only from @${C.account}.`,
];

const FAQ: [string, string][] = [
  ["Thread or article, which is better?", "Either. Pick the format that suits what you want to say. Both are judged the same way."],
  [
    "Can I post my article on Medium or Substack too?",
    "Yes, share it anywhere you like. The entry itself has to be an X Article, and engagement is read on X.",
  ],
  [
    "Can I use AI?",
    "No AI-written entries. Spelling and grammar tools are fine, and so is help translating, but the ideas and the writing have to be yours.",
  ],
  [
    "Do I need to use the app?",
    "It isn’t required, but it scores much higher. A real flow in the app is the biggest single quality score: show a private payment, a cash out, a payroll run or a claim link on mainnet with your own screenshots or a screen recording. Testnet doesn’t count.",
  ],
  [
    "What should I hide in my screenshots?",
    "Anything that gives access to your money: seed phrases, private keys, backups and claim links that haven’t been claimed yet. Amounts and addresses are your call.",
  ],
  [
    "Where do I check my facts?",
    `The docs at gloam.trade/docs, the whitepaper at gloam.trade/whitepaper, and the Creators topic on Telegram (${C.telegramUrl}), where the team answers questions.`,
  ],
  ["Can I enter more than once?", "One entry per X account. To change it, send the form again with the same X handle. The latest one counts."],
  ["How do I get paid?", `With a private Gloam claim link, sent by DM from @${C.account}, in USDG on Robinhood Chain or USDC on Base.`],
  ["Which language?", "English, so every judge can read every entry."],
];

export default function WritingContestPage() {
  const closed = writingClosed();
  const closes = `${contestDay(C.closesAt)} at ${contestTime(C.closesAt)}`;
  const winners = contestDay(C.winnersBy);
  const announcement = C.announcementUrl ?? `https://x.com/${C.account}`;

  return (
    <div className="relative min-h-screen bg-panel text-foreground">
      <Header />

      <main className="pb-8">
        {/* hero */}
        <section className="mx-auto max-w-[1400px] px-4 pt-3 sm:px-7 sm:pt-6">
          <div className="gl-panel flex min-h-[max(480px,calc(100svh-10rem))] flex-col justify-end px-5 pb-8 pt-24 sm:px-10 sm:pb-10 lg:min-h-[580px] lg:px-14 lg:pb-14">
            <FlowField />
            <div className="relative z-10 max-w-[760px]">
              <p className="text-[15px] text-mute">{C.name}</p>
              <h1 className="t-display-xl mt-4">${WRITING_POOL} up for grabs</h1>
              <p className="mt-6 max-w-[44ch] text-[18px] leading-[1.55] text-soft">
                Write a thread or an article about Gloam, private money on public chains.
              </p>
              <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-3">
                <a href="#enter" className="btn btn-ink btn-lg">
                  {closed ? "Entries are closed" : "Enter the contest"}
                </a>
                <a href="#rules" className="gl-arrowlink">
                  Read the rules <span aria-hidden>→</span>
                </a>
                <a href={C.telegramUrl} target="_blank" rel="noreferrer" className="gl-arrowlink">
                  Join the creators on Telegram <span aria-hidden>→</span>
                </a>
              </div>
              <p className="tnum mt-8 text-[13.5px] text-mute">{closed ? `Entries closed ${closes}.` : `Entries close ${closes}.`}</p>
            </div>
          </div>
        </section>

        {/* prizes */}
        <section id="prizes" aria-labelledby="prizes-title" className={SECTION}>
          <SectionHead id="prizes" label="Prizes" title={WRITING_EQUAL_PRIZES ? `${WINNERS_IN_WORDS} winners, $${C.prizes[0]} each.` : `${WINNERS_IN_WORDS} winners, paid privately.`}>
            Each winner gets a Gloam claim link. Take it in USDG on Robinhood Chain or USDC on Base, your choice.
          </SectionHead>
          <ol className={`mt-12 grid grid-cols-2 gap-3 sm:gap-4 ${C.prizes.length % 3 === 0 ? "lg:grid-cols-3" : "lg:grid-cols-4"}`}>
            {C.prizes.map((usd, i) => (
              <li key={i} className="gl-card flex flex-col justify-between gap-10 p-5 sm:p-6">
                <span className="text-[14px] text-mute">{WRITING_EQUAL_PRIZES ? "Winner" : `${placeLabel(i)} place`}</span>
                <span className="tnum text-[36px] font-light leading-none tracking-[-0.03em] sm:text-[44px]">${usd}</span>
              </li>
            ))}
          </ol>
          <p className="tnum mt-5 text-[14px] text-mute">
            ${WRITING_POOL} in total. <span className="text-sealed">Paid through Gloam, so the payouts stay private too.</span>
          </p>
        </section>

        {/* what to write */}
        <section id="write" aria-labelledby="write-title" className={SECTION}>
          <SectionHead id="write" label="What to write" title="A thread or an article about Gloam.">
            Explain it, teach it or make the case for it. A thread of at least {C.minThreadPosts} posts or an article of at
            least {C.minArticleWords} words. It has to get Gloam right and give the reader something worth their time.
            Writing that shows a real flow in the app, with your own screenshots or a screen recording from mainnet,
            scores much higher.
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
            <Step n={1} title="Write it">
              A thread of {C.minThreadPosts} posts or more, or an X Article of {C.minArticleWords} words or more. You can
              share the article on other platforms too, but the entry is the one on X.
            </Step>
            <Step n={2} title="Post it on X">
              Quote{" "}
              <a href={announcement} target="_blank" rel="noreferrer" className={TEXT_LINK}>
                the contest announcement
              </a>{" "}
              and tag @{C.account}. For a thread, that is the first post. For an X Article, share it in a post that quotes the
              announcement.
            </Step>
            <Step n={3} title="Send us the link">
              Put the link to that post in{" "}
              <a href="#enter" className={TEXT_LINK}>
                the form on this page
              </a>
              .
            </Step>
          </ol>
        </section>

        {/* dates */}
        <section id="dates" aria-labelledby="dates-title" className={SECTION}>
          <SectionHead id="dates" label="Dates" title="One week to enter." />
          <dl className="tnum mt-12 grid gap-3 sm:grid-cols-3 sm:gap-4">
            <DateCard term="Entries open" value={contestDay(C.opensAt)} />
            <DateCard term="Entries close" value={closes} />
            <DateCard term="Winners announced" value={`By ${winners}, on @${C.account}`} />
          </dl>
        </section>

        {/* judging */}
        <section id="judging" aria-labelledby="judging-title" className={SECTION}>
          <SectionHead id="judging" label="Judging" title="Quality first, then reach.">
            Quality counts for {100 - WRITING_ENGAGEMENT_WEIGHT}% and engagement for {WRITING_ENGAGEMENT_WEIGHT}%. Showing
            a real flow in the app is the biggest single quality score. Engagement means real replies, reposts and quotes,
            read when entries close. Bought engagement, engagement pods and raid groups remove the entry. The Gloam team
            picks the winners, and the decision is final.
          </SectionHead>
          <CriteriaList items={WRITING_JUDGING} />
        </section>

        {/* rules */}
        <section id="rules" aria-labelledby="rules-title" className={SECTION}>
          <SectionHead id="rules" label="Rules" title="Keep it fair." />
          <BulletList items={RULES} />
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
                  ? `Thanks to everyone who entered. Winners are announced by ${winners} on @${C.account}.`
                  : `Post your thread or article on X first, quoting the announcement and tagging @${C.account}. Then add the link here.`}
              </p>
              <p className="mt-6 max-w-[40ch] text-[13.5px] leading-relaxed text-mute">
                Questions or a draft to share? Ask in{" "}
                <a href={C.telegramUrl} target="_blank" rel="noreferrer" className={TEXT_LINK}>
                  the Creators topic on Telegram
                </a>
                .
              </p>
              <p className="mt-4 max-w-[40ch] text-[13.5px] leading-relaxed text-mute">
                We keep your entry to run the contest and contact winners, and for nothing else. Only the Gloam team can read
                it.
              </p>
            </div>
            <div className="gl-card p-6 sm:p-8">
              <WritingForm closed={closed} />
            </div>
          </div>
        </section>

        {/* faq */}
        <section id="faq" aria-labelledby="faq-title" className={SECTION}>
          <SectionHead id="faq" label="FAQ" title="Questions." />
          <Faq items={FAQ} />
          <p className="mt-8 text-[14px] text-mute">
            Anything else? Ask{" "}
            <a href={`https://x.com/${C.account}`} target="_blank" rel="noreferrer" className={TEXT_LINK}>
              @{C.account}
            </a>{" "}
            on X or email{" "}
            <a href="mailto:hello@gloam.trade" className={TEXT_LINK}>
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
