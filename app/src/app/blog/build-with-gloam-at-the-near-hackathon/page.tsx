import type { Metadata } from "next";
import Link from "next/link";
import { ArticleLayout } from "@/components/blog/ArticleLayout";
import { ArrowUpRight } from "@/components/ui/ArrowUpRight";
import { CodeBlock } from "@/components/ui/CodeBlock";

const title = "Come build with Gloam at the NEAR hackathon";
const description =
  "Building for the NEAR hackathon? The Gloam SDK adds private balances and payments to your app or agent, and you won't write a single circuit.";

// The card in this folder (opengraph-image.tsx) is the share image.
export const metadata: Metadata = {
  title,
  description,
  alternates: { canonical: "/blog/build-with-gloam-at-the-near-hackathon" },
  authors: [{ name: "Duke", url: "https://x.com/dukedotsol" }],
  openGraph: {
    title,
    description,
    url: "/blog/build-with-gloam-at-the-near-hackathon",
    siteName: "Gloam",
    type: "article",
    publishedTime: "2026-10-31",
    authors: ["https://x.com/dukedotsol"],
  },
};

const GLANCE = [
  { k: "Hackathon", v: "NEAR, Nov 1 to 14" },
  { k: "Install", v: "@gloamtrade/sdk" },
  { k: "Live on", v: "4 mainnets" },
  { k: "Circuits to write", v: "None" },
];

const SEND_CODE = `import { buildPrivateSendIntent, artifactProver, circuitArtifactUrls, syncTree } from "@gloamtrade/sdk";

const synced = await syncTree(publicClient, { pool: net.pool, fromBlock: net.deployBlock });
const path = await synced.pathForCommitment(note.commitment);

const send = await buildPrivateSendIntent({
  chainId: net.chainId,
  poolAddress: net.pool,
  secretHex: note.secret,
  amountInWei: note.amountWei,       // the note you're spending
  amountPayWei: parseUnits("10", 6), // what you send; the rest is your change
  asset: note.asset,
  path,
  prove: artifactProver(circuitArtifactUrls("transfer", net.chainId)),
});

// Hand send.paymentNote to the recipient; keep send.changeNote.`;

const BUILDERS_CHAT = "https://t.me/gloamhq/23447";

const READING: { label: string; href: string }[] = [
  { label: "The NEAR hackathon", href: "https://nearhackathon.com" },
  { label: "Gloam builders chat on Telegram", href: BUILDERS_CHAT },
  { label: "Gloam docs: the SDK", href: "/docs/sdk" },
  { label: "Gloam docs: agents", href: "/docs/agents" },
  { label: "Gloam docs: testnet guide", href: "/docs/testnet" },
  { label: "Gloam docs: what stays private", href: "/docs/privacy-model" },
];

export default function BuildWithGloamAtTheNearHackathonPost() {
  return (
    <ArticleLayout
      slug="build-with-gloam-at-the-near-hackathon"
      lede={
        <p>
          The NEAR hackathon opens on November 1, and privacy has its own track.
          If your idea needs privacy, come build it with Gloam.
        </p>
      }
      facts={GLANCE}
      sources={{ title: "Further reading", items: READING }}
      actions={
        <>
          <Link href="/docs/sdk" className="btn btn-ink">
            Read the SDK docs
          </Link>
          <a href={BUILDERS_CHAT} target="_blank" rel="noreferrer" className="btn btn-quiet">
            Join the builders chat <ArrowUpRight />
          </a>
        </>
      }
    >
      <p>
        <strong>Update, 10 November 2026.</strong> Elysium went live on 9
        November 2026, so Gloam now runs on five mainnets: Robinhood Chain,
        Tempo, Base, Ethereum and Elysium.
      </p>
      <p>
        Most of what ships onchain still puts everything on display. Every
        balance, every salary, everything an agent paid for, open to anyone with
        an explorer. Privacy usually gets dropped because circuits are hard and
        two weeks goes fast.
      </p>
      <p>
        You don&apos;t have to write them. We&apos;ve already built this part,
        so use it.
      </p>

      <h2>What you get</h2>
      <p>
        The Gloam SDK is one package, and it&apos;s the same core that runs the
        Gloam app.
      </p>
      <ul>
        <li>
          <strong>Private balances.</strong> Deposit into a balance only the
          holder can see.
        </li>
        <li>
          <strong>Private payments.</strong> Send inside the vault to a receive
          tag, with no public transfer and no visible amount.
        </li>
        <li>
          <strong>Payment receipts.</strong> Prove that a payment of at least a
          given amount happened, and show nothing else.
        </li>
        <li>
          <strong>Paid API calls.</strong> Agents pay for tools and data over
          HTTP 402 and settle privately.
        </li>
        <li>
          <strong>Agent tools.</strong> An MCP server with spending limits, so
          an agent can do all of this too.
        </li>
      </ul>

      <h2>What it looks like</h2>
      <p>
        Here&apos;s a private payment. You don&apos;t write a circuit or run a
        trusted setup, because the proving keys come from our 13-person
        ceremony.
      </p>
      <CodeBlock code={SEND_CODE} lang="ts" title="A private payment" className="not-prose" />

      <h2>Where NEAR fits</h2>
      <p>
        Gloam runs on Robinhood Chain, Tempo, Base and Ethereum, and it isn&apos;t
        on NEAR itself today. NEAR Intents already reaches Base and Robinhood
        Chain, so funds can move over from a NEAR account, then go into a
        private balance.
      </p>
      <p>A few practical things before you start:</p>
      <ul>
        <li>
          The hackathon is about what you build on NEAR, so that part is still
          yours. Gloam is the private money next to it.
        </li>
        <li>
          List the SDK in your README as an existing library. The rules ask for
          that.
        </li>
        <li>
          Private payments are free. Cash outs carry a 0.5% fee on mainnet, and
          deposit limits apply.
        </li>
        <li>
          You can try everything first on <Link href="/docs/testnet">testnet</Link>.
        </li>
      </ul>

      <h2>What this is</h2>
      <p>
        This isn&apos;t a partnership or a sponsorship. We&apos;re builders who
        want more private apps to exist, and this is the fastest way we know to
        help.
      </p>
      <p>
        If we can, we&apos;ll also do something small to appreciate the builders
        who take part. Nothing is decided yet.
      </p>
      <p>
        No form, no waitlist. Read the docs, start building, and if you get
        stuck, come to the{" "}
        <a href={BUILDERS_CHAT} target="_blank" rel="noreferrer">
          builders chat on Telegram
        </a>
        . We mean it, send us the ugly error at 3am and we&apos;ll help you work
        through it.
      </p>
    </ArticleLayout>
  );
}
