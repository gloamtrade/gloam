/**
 * What Glim (the Telegram helper) may say about holder votes: one short
 * block, only while a vote is published. Nothing about how to vote, ever.
 */
import { VOTES, type VoteConfig } from "./config";
import { configProblems, formatUtc, voteStatus, weightingOf } from "./core";

export function voteFacts(all: VoteConfig[] = VOTES, now: number = Date.now()): string | null {
  const live = all.filter((v) => v.published && configProblems(v).length === 0);
  if (live.length === 0) return null;
  const lines = live.map((v) => {
    const status = voteStatus(v, now);
    const when = status === "upcoming" ? `opens ${formatUtc(v.start)}` : status === "open" ? `open until ${formatUtc(v.end)}` : `closed ${formatUtc(v.end)}`;
    const outcome = status === "closed" && v.outcome ? ` Result: ${v.outcome}` : "";
    return `- gloam.trade/vote/${v.id} (${when}): "${v.question}" Options: ${v.options.join("; ")}.${outcome}`;
  });
  return [
    "HOLDER VOTES (gloam.trade/vote; you may share these links)",
    ...lines,
    `- How it works: an open vote. ${
      live.some((v) => weightingOf(v) === "close")
        ? "Any wallet holding $GLOAM can vote. A wallet's weight is its public $GLOAM balance on Robinhood Chain when the vote closes; results before then are live and use what each voter holds now, so GLOAM bought after the vote opened counts too, and GLOAM can't be counted twice."
        : "A wallet's weight is its public $GLOAM balance at the vote's Robinhood Chain snapshot block."
    } Voting is a free signature, no transaction and no gas, and a wallet can change its vote until the end. The vote page connects a browser wallet or, through WalletConnect, a wallet app, so never say WalletConnect is missing. Team wallets, Gloam's contracts and the pools don't count. $GLOAM held privately inside Gloam can't be counted in an open vote; private voting with a proof of your balance is the next step on the roadmap. Every vote and signature is public on the page. Results are advisory and the team commits to act on them. Point people to the page; never tell anyone how to vote or guess a result.`,
  ].join("\n");
}
