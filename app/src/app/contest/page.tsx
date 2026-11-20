import type { Metadata } from "next";
import Link from "next/link";
import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";
import { FlowField } from "@/components/ui/FlowField";
import {
  CONTEST,
  CONTEST_POOL,
  CONTEST_RESULTS,
  CONTEST_TOTAL,
  contestClosed,
  contestDay,
  contestTime,
  placeLabel,
  type ContestPlace,
} from "@/lib/contest";
import { WRITING_CONTEST } from "@/lib/writingContest";
import { ContestForm } from "./ContestForm";
import { BulletList, CriteriaList, DateCard, Faq, SECTION, SectionHead, Step, TEXT_LINK } from "./parts";

/**
 * /contest: the Gloam Video Contest. One idea per section: the prize, what to
 * make, how to enter, the dates, how it is judged, the rules, the form and a
 * short FAQ. Once CONTEST_RESULTS is set, the winners lead the page, then how
 * we judged; the entry sections and the form go.
 *
 * Prizes and dates live in CONTEST (lib/contest.ts), the one place to change
 * them: the form, the API route, the link preview and Glim read them too.
 */

// Re-rendered every minute, so the form shows closed within a minute of the close time.
// The server decides `closed` and the form only reads it, so server and browser agree.
export const revalidate = 60;

const RESULTS = CONTEST_RESULTS;
const TITLE = RESULTS ? `${CONTEST.name} winners` : CONTEST.name;
const DESCRIPTION = RESULTS
  ? `Four winners and four honourable mentions, $${CONTEST_TOTAL} paid privately with Gloam. Watch the winning films and see how we judged.`
  : `$${CONTEST_POOL} for the best videos about Gloam, private money on public chains. Entries close ${contestDay(CONTEST.closesAt, false)}.`;

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
  ["A real flow in the app", "A private payment or another flow on mainnet. Testnet footage doesn't count.", 10],
];

const RULES = [
  `Videos are ${CONTEST.minMinutes} to ${CONTEST.maxMinutes} minutes long.`,
  "Entries come from X only, with the video uploaded to the post.",
  "Original work only.",
  "No AI-generated videos: no AI footage, AI avatars or AI voices.",
  "One entry per X account.",
  "The video stays public until winners are paid.",
  "No impersonating other projects.",
  "No bought likes, views or followers.",
  "Entries that break a rule are removed.",
  "Gloam may repost, clip and use entries in its marketing, with credit to the creator.",
  `Winners are contacted only from @${CONTEST.account}.`,
];

const FAQ: [string, string][] = [
  ["Do I need to use the app?", "It helps. Videos that show a real private payment or cash out on mainnet score higher. Testnet footage is not accepted."],
  ["How long should my video be?", `Between ${CONTEST.minMinutes} and ${CONTEST.maxMinutes} minutes.`],
  [
    "Can I post it on YouTube instead?",
    "Entries come from X only. Upload the video to your post on X; a link to YouTube or another site doesn’t count.",
  ],
  [
    "Can I use AI?",
    "No AI-generated videos. Footage, avatars, voices and animation made by an AI generator are not accepted, and entries that use them are removed. Normal editing tools are fine.",
  ],
  [
    "Are animation and motion graphics allowed?",
    "Yes, if you made them yourself, in tools like After Effects, Blender, Figma or Rive. Animation made by an AI generator is not.",
  ],
  [
    "Where can I ask questions?",
    "In the Creators topic of our Telegram community, t.me/gloamhq/28002. Share drafts, ask questions and meet other creators there.",
  ],
  [
    "Can I enter more than once?",
    "One entry per X account. To change it, send the form again with the same X handle. The latest one counts.",
  ],
  ["How do I get paid?", `With a private Gloam claim link, sent by DM from @${CONTEST.account}.`],
  ["Which language?", "Any language. Add English subtitles if it isn’t in English."],
];

const RESULTS_FAQ: [string, string][] = [
  [
    "How are the winners paid?",
    `With a private Gloam claim link, sent by DM from @${CONTEST.account}. Each one is taken in USDG on Robinhood Chain or USDC on Base.`,
  ],
  [
    "Will anyone else contact me about a prize?",
    `Prizes come only from @${CONTEST.account}. Gloam never asks for a seed phrase, a private key or a payment to release one, and the team is not responsible for deals made in DMs.`,
  ],
  [
    "Can I still enter?",
    `No. Entries closed ${contestDay(CONTEST.closesAt)} at ${contestTime(CONTEST.closesAt)}. Thank you to everyone who sent a film.`,
  ],
];


export default function ContestPage() {
  const closed = contestClosed();
  const opens = contestDay(CONTEST.opensAt);
  const closes = `${contestDay(CONTEST.closesAt)} at ${contestTime(CONTEST.closesAt)}`;
  const winners = contestDay(CONTEST.winnersBy);
  const announcement = CONTEST.announcementUrl ?? `https://x.com/${CONTEST.account}`;

  return (
    <div className="relative min-h-screen bg-panel text-foreground">
      <Header />

      <main className="pb-8">
        {/* hero */}
        <section className="mx-auto max-w-[1400px] px-4 pt-3 sm:px-7 sm:pt-6">
          <div className="gl-panel flex min-h-[max(480px,calc(100svh-10rem))] flex-col justify-end px-5 pb-8 pt-24 sm:px-10 sm:pb-10 lg:min-h-[580px] lg:px-14 lg:pb-14">
            <FlowField />
            {RESULTS ? (
              <div className="relative z-10 max-w-[760px]">
                <p className="text-[15px] text-mute">{CONTEST.name}</p>
                <h1 className="t-display-xl mt-4">The winners.</h1>
                <p className="mt-6 max-w-[46ch] text-[18px] leading-[1.55] text-soft">
                  The entries were so good, we had to make more room. Four winners and four honourable mentions,{" "}
                  <span className="text-sealed">${CONTEST_TOTAL} paid privately with Gloam.</span>
                </p>
                <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-3">
                  <a href="#winners" className="btn btn-ink btn-lg">
                    Meet the winners
                  </a>
                  <a href="#judged" className="gl-arrowlink">
                    How we judged <span aria-hidden>→</span>
                  </a>
                  <Link href={WRITING_CONTEST.path} className="gl-arrowlink">
                    Now open: the writing contest <span aria-hidden>→</span>
                  </Link>
                </div>
                <p className="tnum mt-8 text-[13.5px] text-mute">
                  {RESULTS.entries} entries, {contestDay(CONTEST.opensAt, false)} to {contestDay(CONTEST.closesAt)}. Announced{" "}
                  {contestDay(RESULTS.announcedAt)}.
                </p>
              </div>
            ) : (
            <div className="relative z-10 max-w-[760px]">
              <p className="text-[15px] text-mute">{CONTEST.name}</p>
              <h1 className="t-display-xl mt-4">${CONTEST_POOL} up for grabs</h1>
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
                <a href={CONTEST.telegramUrl} target="_blank" rel="noreferrer" className="gl-arrowlink">
                  Join the creators on Telegram <span aria-hidden>→</span>
                </a>
              </div>
              <p className="tnum mt-8 text-[13.5px] text-mute">
                {closed ? `Entries closed ${closes}.` : `Entries close ${closes}.`}
              </p>
            </div>
            )}
          </div>
        </section>

        {RESULTS && (
          <>
            {/* winners */}
            <section id="winners" aria-labelledby="winners-title" className={SECTION}>
              <SectionHead id="winners" label="Winners" title="The top four.">
                Each prize is paid with a private Gloam claim link, sent by DM from @{CONTEST.account}.
              </SectionHead>
              <ol className="mt-12 grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
                {RESULTS.winners.map((w, i) => (
                  <WinnerCard key={w.handle} place={placeLabel(i)} entry={w} />
                ))}
              </ol>

              <div className="mt-16 sm:mt-20">
                <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
                  <h3 className="text-[22px] font-light tracking-[-0.015em] sm:text-[26px]">Honourable mentions</h3>
                  <p className="tnum text-[15px] text-mute">${RESULTS.honourable[0]?.usd ?? 0} each</p>
                </div>
                <ul className="mt-6 grid border-t border-line sm:grid-cols-2 sm:gap-x-10 lg:grid-cols-4">
                  {RESULTS.honourable.map((h) => (
                    <li key={h.handle} className="border-b border-line">
                      <a
                        href={h.postUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="group flex items-center gap-4 py-5"
                        aria-label={`${h.name}, @${h.handle}: watch the film on X`}
                      >
                        <img
                          src={`/contest/winners/${h.handle}.jpg`}
                          alt=""
                          width={56}
                          height={56}
                          loading="lazy"
                          className="h-14 w-14 shrink-0 rounded-full object-cover"
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[17px] tracking-[-0.01em]">{h.name}</span>
                          <span className="block truncate text-[14px] text-mute">@{h.handle}</span>
                        </span>
                        <span
                          aria-hidden
                          className="shrink-0 text-[15px] text-mute transition-transform group-hover:translate-x-0.5 group-hover:text-foreground"
                        >
                          →
                        </span>
                      </a>
                    </li>
                  ))}
                </ul>
              </div>

              <p className="tnum mt-8 text-[14px] text-mute">
                ${CONTEST_TOTAL} in total. The entries were so good, we added the honourable mentions to the ${CONTEST_POOL} pool.{" "}
                <span className="text-sealed">Paid through Gloam, so the payouts stay private too.</span>
              </p>
            </section>

            {/* how we judged */}
            <section id="judged" aria-labelledby="judged-title" className={SECTION}>
              <SectionHead id="judged" label="Judging" title="How we judged.">
                A team of {inWords(RESULTS.judges)} watched every entry over two rounds. Likes and views were not counted.
              </SectionHead>
              <ol className="mt-12 divide-y divide-line border-y border-line">
                <Step n={1} title={`${RESULTS.entries} entries in one week`}>
                  Every entry was a video posted on X between {contestDay(CONTEST.opensAt, false)} and{" "}
                  {contestDay(CONTEST.closesAt)}.
                </Step>
                <Step n={2} title={`Shuffled into ${inWords(RESULTS.judges)} batches`}>
                  A stratified random split gave each judge a batch of about 25, with the same mix of networks in every
                  batch.
                </Step>
                <Step n={3} title="Scored against weighted criteria">
                  Clarity 40, creativity 30, production 20 and app flow 10, plus a rules check: on time, at least one
                  minute long, posted publicly.
                </Step>
                <Step n={4} title="A second round, fresh eyes">
                  Each judge put forward their best picks and honourable mentions. The picks were then regrouped so nobody
                  judged their own batch.
                </Step>
                <Step n={5} title="Decided together">
                  The team debated the shortlist and chose the four winners and four honourable mentions together.
                </Step>
              </ol>
              <h3 className="mt-16 text-[22px] font-light tracking-[-0.015em] sm:mt-20 sm:text-[26px]">The criteria</h3>
              <CriteriaList items={JUDGING} />
            </section>
          </>
        )}

        {!RESULTS && (
        <>
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
          <SectionHead
            id="make"
            label="What to make"
            title={`A ${CONTEST.minMinutes} to ${CONTEST.maxMinutes} minute video about Gloam.`}
          >
            An explainer, a tutorial, a short film, an animation you made yourself, a skit or a meme. No AI-generated videos. Any style is welcome, and a carefully
            made video gets the attention it deserves. It has to show Gloam clearly, the app or the idea, and be posted
            on X.
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
              {CONTEST.minMinutes} to {CONTEST.maxMinutes} minutes long, any style, about Gloam.
            </Step>
            <Step n={2} title="Post it on X">
              Upload the video to the post itself. Quote{" "}
              <a href={announcement} target="_blank" rel="noreferrer" className={TEXT_LINK}>
                the contest announcement
              </a>
              , and tag @{CONTEST.account}. Links to YouTube or other sites don&rsquo;t count.
            </Step>
            <Step n={3} title="Send us the link">
              Put the link to your post in{" "}
              <a href="#enter" className={TEXT_LINK}>
                the form on this page
              </a>
              .
            </Step>
          </ol>
        </section>
        </>
        )}

        {/* dates */}
        <section id="dates" aria-labelledby="dates-title" className={SECTION}>
          <SectionHead id="dates" label="Dates" title="One week to enter." />
          <dl className="tnum mt-12 grid gap-3 sm:grid-cols-3 sm:gap-4">
            <DateCard term="Entries open" value={opens} />
            <DateCard term="Entries close" value={closes} />
            <DateCard
              term="Winners announced"
              value={RESULTS ? `${contestDay(RESULTS.announcedAt)}, on @${CONTEST.account}` : `By ${winners}, on @${CONTEST.account}`}
            />
          </dl>
        </section>

        {/* judging (before the results; after them it sits under "How we judged") */}
        {!RESULTS && (
          <section id="judging" aria-labelledby="judging-title" className={SECTION}>
            <SectionHead id="judging" label="Judging" title="What we look for.">
              Likes and views are not counted, so bought engagement doesn&rsquo;t help. The Gloam team picks the winners,
              and the decision is final.
            </SectionHead>
            <CriteriaList items={JUDGING} />
          </section>
        )}

        {/* rules */}
        <section id="rules" aria-labelledby="rules-title" className={SECTION}>
          <SectionHead id="rules" label="Rules" title="Keep it fair." />
          <BulletList items={RULES} />
        </section>

        {/* the form */}
        {!RESULTS && (
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
                  : `Post your video on X first, quoting the announcement and tagging @${CONTEST.account}. Then add the link here.`}
              </p>
              <p className="mt-6 max-w-[40ch] text-[13.5px] leading-relaxed text-mute">
                Questions or a draft to share? Ask in{" "}
                <a href={CONTEST.telegramUrl} target="_blank" rel="noreferrer" className={TEXT_LINK}>
                  the Creators topic on Telegram
                </a>
                .
              </p>
              <p className="mt-4 max-w-[40ch] text-[13.5px] leading-relaxed text-mute">
                We keep your entry to run the contest and contact winners, and for nothing else. Only the Gloam team can
                read it.
              </p>
            </div>
            <div className="gl-card p-6 sm:p-8">
              <ContestForm closed={closed} />
            </div>
          </div>
        </section>
        )}

        {/* faq */}
        <section id="faq" aria-labelledby="faq-title" className={SECTION}>
          <SectionHead id="faq" label="FAQ" title="Questions." />
          <Faq items={RESULTS ? RESULTS_FAQ : FAQ} />
          <p className="mt-8 text-[14px] text-mute">
            Anything else? Ask{" "}
            <a href={`https://x.com/${CONTEST.account}`} target="_blank" rel="noreferrer" className={TEXT_LINK}>
              @{CONTEST.account}
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

/** Small counts in words ("five"), as the rest of the copy writes them. */
function inWords(n: number): string {
  return ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"][n] ?? String(n);
}

function WinnerCard({ place, entry }: { place: string; entry: ContestPlace }) {
  return (
    <li className="gl-card flex flex-col p-3 sm:p-4">
      <img
        src={`/contest/winners/${entry.handle}.jpg`}
        alt={`${entry.name}'s profile picture`}
        width={400}
        height={400}
        className="aspect-square w-full rounded-[12px] object-cover"
      />
      <div className="flex flex-1 flex-col px-1 pb-1 pt-5 sm:px-2">
        <div className="flex items-baseline justify-between gap-2">
          <span className="whitespace-nowrap text-[13px] text-mute sm:text-[14px]">{place} place</span>
          <span className="tnum text-[22px] font-light leading-none tracking-[-0.03em] sm:text-[30px]">${entry.usd}</span>
        </div>
        <p className="mt-4 truncate text-[18px] tracking-[-0.01em] sm:text-[20px]">{entry.name}</p>
        <p className="truncate text-[14px] text-mute">@{entry.handle}</p>
        <a href={entry.postUrl} target="_blank" rel="noreferrer" className="gl-arrowlink mt-5">
          Watch the film <span aria-hidden>→</span>
        </a>
      </div>
    </li>
  );
}
