/**
 * $GLOAM holder votes: the configuration. This file is the only place a vote
 * is defined. Pages, the API and Glim all read it.
 *
 * To create and open a vote (the full steps are in scripts/vote-snapshot.mts):
 *  1. Add an entry below with `published: false` and `snapshotBlock: 0`.
 *  2. From app/, run `../mcp/node_modules/.bin/tsx scripts/vote-snapshot.mts <id>`.
 *     It picks a recent Robinhood Chain block, reads every holder's balance at
 *     it, and writes src/lib/vote/snapshots/<id>.json. Put the block it prints
 *     into `snapshotBlock`.
 *  3. Set `start` and `end`, then `published: true`, and ship it.
 *
 * Once a vote is published, never change its id, options (or their order) or
 * snapshot block: every signature names the option it picked and the
 * snapshot block, so a change would void the votes already cast. Fix a typo
 * in the question or the description only.
 *
 * Weighting: a vote without `weighting` (or with "snapshot") counts each
 * wallet's $GLOAM at `snapshotBlock`. With "close", any wallet holding $GLOAM
 * can vote while it is open, the live results use what each voter holds now,
 * and the final count uses what each voter held at the closing block (the
 * first block at or after `end`), worked out from the Transfer logs. GLOAM
 * sits in one wallet at the close, so it can't be counted twice. The snapshot
 * is still signed (its block is part of the message) and kept for reference.
 */

export type VoteConfig = {
  /** The link: gloam.trade/vote/<id>. Lowercase letters, digits and dashes. Never changes once published. */
  id: string;
  /** false keeps the vote off the site and closed to votes. Nothing goes live until this is true. */
  published: boolean;
  /** One plain question. */
  question: string;
  /** One or two short sentences under the question. */
  description: string;
  /** 2 to 5 options, each a few words. The order is fixed once published. */
  options: string[];
  /** One plain line under each option, in the same order. Not signed, so it can be reworded. */
  details?: string[];
  /** The Robinhood Chain mainnet block whose $GLOAM balances set each wallet's weight. 0: not taken yet. */
  snapshotBlock: number;
  /** When voting opens and closes, in UTC, like "2026-11-03T13:00:00Z". */
  start: string;
  end: string;
  /**
   * What sets a wallet's weight. "snapshot" (the default): its $GLOAM at
   * `snapshotBlock`. "close": its $GLOAM when the vote closes, live until then.
   */
  weighting?: "snapshot" | "close";
  /** Extra addresses that never count in this vote, on top of the standing list (lib/vote/excluded.ts). */
  exclude?: { address: string; reason: string }[];
  /** What the team is doing with the result, in a sentence or two. Shown once the final count is in. */
  outcome?: string;
};

/**
 * The first three votes share one window and one snapshot block. They opened
 * weighted by the snapshot and moved to weight at close on 29 October, so
 * holders who bought after the snapshot can vote too. The block stays: the
 * ballots already cast signed it.
 */
const FIRST_START = "2026-10-29T16:30:00Z";
// Sunday 1 November, 11pm UTC (midnight in Lagos)
const FIRST_END = "2026-11-01T23:00:00Z";
const FIRST_BLOCK = 101_022_464;

export const VOTES: VoteConfig[] = [
  {
    id: "private-swaps-next",
    published: true,
    outcome: "Stablecoin swaps on Base and Ethereum are next. They run on the new swap router, which gets an outside review first.",
    question: "What should Gloam add to private swaps next?",
    description:
      "Private swaps hide who traded, while the token and the amount stay public. The winning option goes on the roadmap first: the result is advisory, and the team will act on it.",
    options: ["More Robinhood stock tokens", "Popular Robinhood Chain tokens", "Stablecoin swaps on Base and Ethereum"],
    details: [
      "Swap privately into more of the stock tokens on Robinhood Chain.",
      "Swap privately into the most traded tokens on Robinhood Chain that are not stocks.",
      "Swap between stablecoins like USDC and USDT privately on Base and Ethereum, where the vault already runs.",
    ],
    snapshotBlock: FIRST_BLOCK,
    weighting: "close",
    start: FIRST_START,
    end: FIRST_END,
  },
  {
    id: "next-chain",
    published: true,
    outcome: "Solana won narrowly, just ahead of Arbitrum. It needs its own version of the vault, so it will take longer than an EVM chain, and we'll share the plan before we start.",
    question: "Which chain should Gloam go live on next?",
    description:
      "Gloam runs on Robinhood Chain, Tempo, Base and Ethereum. The EVM chains reuse the same vault; Solana would be its own build, so it would take longer to ship. The result is advisory, and the team will act on it.",
    options: ["Arbitrum", "BNB Chain", "Polygon", "Solana"],
    details: [
      "An Ethereum layer 2 with deep stablecoin and DeFi activity.",
      "A large EVM chain with heavy USDT use.",
      "An EVM chain used widely for payments and stablecoin transfers.",
      "The busiest non-EVM chain for stablecoin payments. Gloam would build a Solana version of the vault.",
    ],
    snapshotBlock: FIRST_BLOCK,
    weighting: "close",
    start: FIRST_START,
    end: FIRST_END,
  },
  {
    id: "first-integration",
    published: true,
    outcome: "Trading apps come first. That's where partner time goes next.",
    question: "Which kind of app should Gloam integrate first?",
    description:
      "Gloam is the privacy layer apps plug into, and this tells us where to spend partner time first. The result is advisory, and the team will act on it.",
    options: ["Trading apps", "AI agent platforms", "Payroll and payout tools", "Shopping and cards"],
    details: [
      "Private balances and private swaps inside the apps where people trade.",
      "Agents that pay and get paid privately, within the limits you set.",
      "Teams paying people without putting salaries on the public record.",
      "Paying merchants and topping up cards without showing your balance.",
    ],
    snapshotBlock: FIRST_BLOCK,
    weighting: "close",
    start: FIRST_START,
    end: FIRST_END,
  },
  {
    // Taken down 5 Nov 2026 before announcing, while the team settles the plan; reopen with new
    // start/end. A yes is not a migration by itself: it goes ahead only on terms that keep
    // supply fixed and lock the new liquidity forever, with holders on fomo and in the vault covered.
    id: "gloam-migration",
    published: false,
    question: "Should $GLOAM move to a new pool?",
    description:
      "$GLOAM trades on its Orynth pool, where every trade pays a 2% fee and the liquidity is locked forever. A migration would swap every $GLOAM one for one into a new token on a new pool. The team will only migrate if holders vote yes.",
    options: ["Stay on Orynth", "Migrate to a new pool"],
    details: [
      "Nothing changes: same token, same contract, same locked pool.",
      "Swap old $GLOAM for new, one for one, in a set window. Only on terms that keep supply fixed and lock the liquidity forever.",
    ],
    snapshotBlock: 106_824_482,
    weighting: "close",
    start: "2026-11-05T19:00:00Z",
    // Sunday 8 November, 11pm UTC (midnight in Lagos)
    end: "2026-11-08T23:00:00Z",
  },
];
