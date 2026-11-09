import type { Metadata } from "next";
import Link from "next/link";
import { ArticleLayout } from "@/components/blog/ArticleLayout";
import { ArrowUpRight } from "@/components/ui/ArrowUpRight";
import { mainnetPool } from "@/lib/mainnet";

const title = "Agents should not do business in public";
const description =
  "Agents now hire and pay each other on Virtuals' Agent Commerce Protocol, and every job is recorded on chain by design. What that record gives away about an agent's business, and how Gloam keeps the job public and the money around it private.";

/** Base mainnet sentences switch on the moment its vault is filled in (lib/mainnet.ts). */
const BASE_MAINNET_LIVE = mainnetPool(8453) !== null;

// The card in this folder (opengraph-image.tsx) is the share image.
export const metadata: Metadata = {
  title,
  description,
  alternates: { canonical: "/blog/agents-should-not-do-business-in-public" },
  authors: [{ name: "Duke", url: "https://x.com/dukedotsol" }],
  openGraph: {
    title,
    description,
    url: "/blog/agents-should-not-do-business-in-public",
    siteName: "Gloam",
    type: "article",
    publishedTime: "2026-10-25",
    authors: ["https://x.com/dukedotsol"],
  },
};

/** One private payout job, as a stranger with a block explorer reads it, without and with Gloam. */
const EXPLORER: { what: string; plain: string; gloam: string; sealed?: boolean }[] = [
  { what: "The job: client, provider, evaluator", plain: "Public", gloam: "Public" },
  { what: "The fee in escrow", plain: "Public", gloam: "Public" },
  { what: "The total the client sends", plain: "Public", gloam: "Public" },
  { what: "Who got paid", plain: "Public, address by address", gloam: "Private", sealed: true },
  { what: "How much each one got", plain: "Public", gloam: "Private", sealed: true },
  { what: "What the agent holds", plain: "Public", gloam: "Private", sealed: true },
];

const SOURCES: { label: string; href: string }[] = [
  { label: "Virtuals: What is ACP?", href: "https://os.virtuals.io/acp/overview" },
  { label: "Virtuals: ACP core concepts (jobs, phases, job types, fees)", href: "https://os.virtuals.io/acp/concepts" },
  { label: "Virtuals: Agent identity (live on Base and Robinhood Chain)", href: "https://os.virtuals.io/agent-identity/overview" },
  { label: "Virtuals: Agent wallet and wallet policies", href: "https://os.virtuals.io/agent-identity/wallet/overview" },
  { label: "ERC-8183: Agentic Commerce (draft)", href: "https://eips.ethereum.org/EIPS/eip-8183" },
  { label: "GAME framework, TypeScript (game-node)", href: "https://github.com/game-by-virtuals/game-node" },
  { label: "ACP core contract on Base (jobCounter, read 25 October 2026)", href: "https://basescan.org/address/0x238E541BfefD82238730D00a2208E5497F1832E0" },
  { label: "Gloam docs: Gloam for Virtuals agents", href: "/docs/virtuals" },
  { label: "Gloam docs: what stays private", href: "/docs/privacy-model" },
];

export default function AgentsShouldNotDoBusinessInPublicPost() {
  return (
    <ArticleLayout
      slug="agents-should-not-do-business-in-public"
      lede={
        <p>
          Agents now hire each other. They take jobs, pay for work in
          stablecoins and get paid, often with no person in the loop. On
          Virtuals&apos; Agent Commerce Protocol every one of those jobs is
          recorded on chain, by design. The job should be. The business around
          it should not.
        </p>
      }
      caption="One ACP job on an explorer. The job stays public. With Gloam, the payouts and the balance do not."
      facts={[
        { k: "ACP jobs on Base", v: "Over 82,000" },
        { k: "On Robinhood Chain", v: "116" },
        { k: "Standard", v: "ERC-8183, a draft" },
        { k: "Gloam for it", v: "A GAME plugin and an ACP provider" },
      ]}
      sources={{ title: "Sources", items: SOURCES }}
      actions={
        <>
          <Link href="/docs/virtuals" className="btn btn-ink">
            Read the docs
          </Link>
          <a
            href="https://github.com/gloamtrade/gloam/tree/main/packages/game-plugin-gloam"
            target="_blank"
            rel="noreferrer"
            className="btn btn-quiet"
          >
            Plugin source <ArrowUpRight />
          </a>
          <a href="https://x.com/gloamtrade" target="_blank" rel="noreferrer" className="btn btn-quiet">
            Follow @gloamtrade <ArrowUpRight />
          </a>
        </>
      }
    >
      <h2>A job is a public record</h2>
      <p>
        ACP is Virtuals&apos; protocol for agents doing business with each
        other. A client agent opens a job with a provider. The provider sets a
        price, the client funds it into escrow, the provider submits the work,
        and an evaluator, often the client itself, completes or rejects it.
        Completing releases the escrow to the provider, minus the
        protocol&apos;s and the evaluator&apos;s cut. ACP&apos;s docs list
        transparency as a property of every job: all operations are recorded on
        chain.
      </p>
      <p>
        ACP is the reference implementation of ERC-8183, a draft Ethereum
        standard for agent commerce that Virtuals proposed, and it runs on Base
        and Robinhood Chain. We read its contract on 25 October 2026: over 82,000
        jobs on Base, and 116 on Robinhood Chain. Requirements and deliverables
        travel as messages through Virtuals&apos; servers, with a hash of the
        deliverable on chain, while the job itself and every movement of money
        are on chain for anyone to read.
      </p>
      <p>
        That is the right call for the job. An escrow everyone can check is what
        lets two agents that have never met trust each other with money. The
        trouble starts when the same record is also the agent&apos;s bank
        statement.
      </p>

      <h2>What the record gives away</h2>
      <p>
        Picture an agent that runs a real business. It sells research to other
        agents, and pays a few suppliers of its own for data and compute. On a
        public chain, anyone with an explorer can read off:
      </p>
      <ul>
        <li>its customers, and how often each one comes back;</li>
        <li>its prices, job by job, and so its margins;</li>
        <li>its suppliers, and exactly what it pays each of them;</li>
        <li>its balance, and so how long it can run and how much risk it can take.</li>
      </ul>
      <p>
        No company would publish that. A competitor that reads it can undercut
        the agent on price, go straight to its suppliers, or copy its whole
        routine. Agents make this worse than it is for people: they repeat the
        same steps on the same schedule, so their patterns are easy to learn,
        and the readers are often agents too, built to watch the chain and act
        on what they see. Fund-transfer jobs, where a provider manages a
        client&apos;s own money, put the client&apos;s principal on the record
        as well.
      </p>
      <p>
        We think private money is the default every business will expect. Agents
        are about to run a lot of businesses. They should not have to publish
        their books to do it.
      </p>

      <h2>Keep the job public. Make the money private.</h2>
      <p>
        So we built Gloam for Virtuals agents. Two pieces, both open source:
      </p>
      <ul>
        <li>
          <strong>A GAME plugin.</strong> <code>@gloamtrade/game-plugin-gloam</code>{" "}
          gives an agent built on GAME, Virtuals&apos; agent framework, a
          private balance in Gloam&apos;s shielded vault. Seven functions: check
          the private balance, add to it, pay privately, receive, cash out,
          prove funds to one named reader, and verify a proof someone sends.
          Every payment fits limits the owner sets for each asset, and no key,
          note or claim link ever reaches GAME&apos;s planner.
        </li>
        <li>
          <strong>A private payout provider for ACP.</strong> A provider agent
          with one service. A client hires it with a list of who to pay and how
          much. The provider pays each one privately from its Gloam balance and
          delivers a proof of each payment, sealed so only the client can read
          it.
        </li>
      </ul>
      <p>
        We kept ACP&apos;s contracts exactly as they are. The provider uses a
        fund-transfer job: the client&apos;s payout total goes to the provider
        when the job is funded, and only the provider&apos;s fee sits in
        escrow. The provider then pays out inside the vault. On the explorer,
        each payout is a private transfer: a spent marker and two new
        commitments, with no recipient and no amount, submitted by the Gloam
        relay so the provider&apos;s wallet does not appear either.
      </p>

      <div className="not-prose overflow-x-auto rounded-[18px] border border-line">
        <table className="w-full min-w-[560px] text-left text-[14px] leading-relaxed">
          <thead>
            <tr className="border-b border-line bg-surface/60 text-mute">
              <th className="w-[40%] px-4 py-3 font-normal">One payout job</th>
              <th className="w-[30%] px-4 py-3 font-normal">Paid in public</th>
              <th className="px-4 py-3 font-normal">Paid with Gloam</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {EXPLORER.map((r) => (
              <tr key={r.what} className="align-top">
                <td className="px-4 py-3 text-foreground">{r.what}</td>
                <td className="px-4 py-3 text-mute">{r.plain}</td>
                <td className={`px-4 py-3 ${r.sealed ? "text-sealed" : "text-mute"}`}>{r.gloam}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p>
        We ran the whole thing end to end on local forks of Base Sepolia and
        Robinhood Chain mainnet, against ACP&apos;s own contracts and
        Gloam&apos;s vaults, with fresh keys and nothing sent to a live network.
        A job completed, with two private payouts, one to a Gloam address and
        one by claim link, both proven to the client before it signed off. A
        plain escrow job from an unknown client was refused. A client that
        rejected right after funding got its fee and its payout total back.
      </p>

      <h2>What stays public</h2>
      <p>
        Being exact about this matters more than sounding good. With Gloam, the
        job is still public: who the client, provider and evaluator are, the
        offering, the fee in escrow, the payout total moving from client to
        provider, and the hash of the deliverable. Virtuals&apos; servers still
        carry the job&apos;s messages, though the client can seal the payout
        list and the provider seals the result, so those servers store only
        ciphertext. When the provider later adds its earnings to its private
        balance, the deposits are public, so it adds them in round batches that
        do not line up with any one job. And a recipient who cashes out the
        exact amount right after being paid is easy to match, so cash out a
        different amount, or later.
      </p>
      <p>
        What goes private is the part a competitor wants: who got paid, how
        much, and what the agent holds. The{" "}
        <Link href="/docs/virtuals#public">docs</Link> list every field.
      </p>

      <h2>What we learned reading ACP</h2>
      <p>
        <strong>The escrow pays in one token, in public.</strong> Each ACP
        contract has one payment token: USDC on Base, USDG on Robinhood Chain.
        Settling a job any other way needs a hook contract that Virtuals has
        approved. So rather than change ACP, we made the legs around it private.
        {BASE_MAINNET_LIVE
          ? " Gloam's vault takes both: USDG on Robinhood Chain and USDC on Base."
          : " Gloam's vault takes USDG on Robinhood Chain today, and USDC on Base once its Base mainnet vault is live."}
      </p>
      <p>
        <strong>Private payouts cannot depend on the escrow.</strong> ERC-8183
        lets an evaluator reject a funded job before the work is submitted, and
        when the client is its own evaluator, that sends the escrow back to the
        client. A provider that paid out privately first could not take those
        payments back. That is why the payout total moves outside the escrow at
        funding, and the provider takes plain escrow jobs only from clients its
        owner trusts.
      </p>
      <p>
        <strong>Wallet policies decide where an agent&apos;s wallet can
        go.</strong> An ACP agent&apos;s wallet signs under a policy checked on
        every transaction. The default, Virtuals Only, allows only
        Virtuals-approved destinations, and Gloam&apos;s vault is not one of
        them. Today an agent on the default cannot move what it earns into a
        private balance without its owner setting a custom policy, or running
        the plugin with a key of its own.
      </p>
      <p>
        <strong>It is TypeScript for now.</strong> ACP&apos;s current SDK,{" "}
        <code>@virtuals-protocol/acp-node-v2</code>, is TypeScript, so the
        plugin and the provider are too.
      </p>

      <h2>What would make it better</h2>
      <p>
        Three things, in order. Gloam&apos;s vault, which has the same address
        on Base and Robinhood Chain, on the list of destinations the default
        policy allows, so any ACP agent can hold what it earns privately without
        opening its wallet up. A listing for the private payout provider where
        ACP agents look for services. And later, a hook for fund-transfer jobs
        that sends the payout total straight into the vault, so even that leg
        stops being public.
      </p>
      <p>
        The last one is not code. Privacy in a shielded vault grows with the
        crowd: every agent that keeps its balance there makes every other one
        harder to pick out. Agent commerce is early, and the books it keeps
        today are permanent. The best time for agents to stop doing business in
        public is before most of them start.
      </p>

      <h2>Try it</h2>
      <p>
        The <Link href="/docs/virtuals">docs for Virtuals agents</Link> cover
        setup, every function, the limits and the networks.{" "}
        {BASE_MAINNET_LIVE
          ? "The plugin works on Robinhood Chain and Base mainnet, with deposit limits, and on Base Sepolia, a testnet, by default."
          : "The plugin works on Robinhood Chain mainnet today, with deposit limits, and on Base Sepolia, a testnet, by default. Base mainnet follows on the same vault address."}{" "}
        Both pieces run their whole flows on a local fork with one command each,
        so you can watch the explorer for yourself.
      </p>
    </ArticleLayout>
  );
}
