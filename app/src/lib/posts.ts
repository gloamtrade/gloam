/**
 * Every research post, newest first. /research, each post's header, the
 * related posts under a post and the footer all read this list, so a new post
 * is one entry here plus its page under app/blog/<slug>.
 */

import { SOLANA_RINGS_ENABLED } from "./solanaRings/config";

export type PostCoverId = "acp" | "agents" | "build" | "mainnet" | "operator" | "solana" | "tempo";

export type Post = {
  slug: string;
  title: string;
  /** A few words, for the footer's list of posts. */
  short: string;
  /** One line for the cards on /research and under other posts. */
  summary: string;
  /** ISO date, for <time> and the share metadata. */
  date: string;
  dateLabel: string;
  kind: "Research" | "Announcement";
  /** Reading time at about 230 words a minute, counted from the published page. */
  minutes: number;
  cover: PostCoverId;
};

export const AUTHOR = {
  name: "Duke",
  role: "Founder of Gloam",
  href: "https://x.com/dukedotsol",
  avatar: "/brand/people/memoji/duke.png",
} as const;

const SOLANA_POST: Post = {
  slug: "live-on-solana",
  title: "Gloam is live on Solana",
  short: "Live on Solana",
  summary:
    "Private payments on Solana for people, teams and agents, built on Helius Privacy Rings.",
  date: "2026-11-23",
  dateLabel: "November 23, 2026",
  kind: "Announcement",
  minutes: 3,
  cover: "solana",
};

export const POSTS: Post[] = [
  // Shown once Solana is on (NEXT_PUBLIC_SOLANA_RINGS_ENABLED), like the rest of Solana's copy.
  ...(SOLANA_RINGS_ENABLED ? [SOLANA_POST] : []),
  {
    slug: "build-with-gloam-at-the-near-hackathon",
    title: "Come build with Gloam at the NEAR hackathon",
    short: "Build at the NEAR hackathon",
    summary:
      "Add private balances and payments to your app or agent with the Gloam SDK, and skip the circuits.",
    date: "2026-10-31",
    dateLabel: "October 31, 2026",
    kind: "Announcement",
    minutes: 2,
    cover: "build",
  },
  {
    slug: "agents-should-not-do-business-in-public",
    title: "Agents should not do business in public",
    short: "Agents and ACP",
    summary:
      "Every ACP job is on chain by design. What that gives away about an agent's business, and how Gloam keeps the job public and the money private.",
    date: "2026-10-25",
    dateLabel: "October 25, 2026",
    kind: "Research",
    minutes: 6,
    cover: "acp",
  },
  {
    slug: "private-agent-payments",
    title: "Agents that pay privately, and check before they pay",
    short: "Private agent payments",
    summary:
      "How Raeto funds AI agents privately with Gloam, and how Agent Wormhole checks each payment before it moves.",
    date: "2026-10-23",
    dateLabel: "October 23, 2026",
    kind: "Research",
    minutes: 5,
    cover: "agents",
  },
  {
    slug: "live-on-mainnet",
    title: "Private money, live on public chains",
    short: "Live on mainnet",
    summary: "Why money anyone can read fails the people who use it, and what went live on Robinhood Chain and Tempo mainnet.",
    date: "2026-10-21",
    dateLabel: "October 21, 2026",
    kind: "Announcement",
    minutes: 7,
    cover: "mainnet",
  },
  {
    slug: "privacy-without-an-operator",
    title: "Privacy with an operator, and privacy without one",
    short: "Privacy without an operator",
    summary: "Private payments are here to stay. The open question is private from whom: the two models, and where Gloam stands.",
    date: "2026-10-14",
    dateLabel: "October 14, 2026",
    kind: "Research",
    minutes: 7,
    cover: "operator",
  },
  {
    slug: "live-on-tempo",
    title: "Gloam is live on Tempo",
    short: "Live on Tempo",
    summary: "Private balances and payments come to Tempo, the payments-first stablecoin chain, with settlement that stays verifiable.",
    date: "2026-09-17",
    dateLabel: "September 17, 2026",
    kind: "Announcement",
    minutes: 2,
    cover: "tempo",
  },
];

export const postHref = (p: Pick<Post, "slug">) => `/blog/${p.slug}`;

export function getPost(slug: string): Post {
  const post = POSTS.find((p) => p.slug === slug);
  if (!post) throw new Error(`No post with slug "${slug}" in lib/posts.ts`);
  return post;
}

/** The posts to read next: the newest others, so the list never points back at itself. */
export function relatedPosts(slug: string, count = 2): Post[] {
  return POSTS.filter((p) => p.slug !== slug).slice(0, count);
}
