import type { Metadata } from "next";
import Link from "next/link";
import { AppLink } from "@/components/AppLink";
import { ArticleLayout } from "@/components/blog/ArticleLayout";
import { ArrowUpRight } from "@/components/ui/ArrowUpRight";

const title = "Gloam is live on Solana";
const description =
  "Private payments on Solana for people, teams and agents, built on Helius Privacy Rings. Send SOL, USDC and USDT without putting the token or the amount on the public record.";

export const metadata: Metadata = {
  title,
  description,
  alternates: { canonical: "/blog/live-on-solana" },
  authors: [{ name: "Duke", url: "https://x.com/dukedotsol" }],
  openGraph: {
    title,
    description,
    url: "/blog/live-on-solana",
    siteName: "Gloam",
    type: "article",
    publishedTime: "2026-11-23",
    authors: ["https://x.com/dukedotsol"],
  },
  twitter: {
    card: "summary_large_image",
    title,
    description,
    site: "@gloamtrade",
    creator: "@dukedotsol",
  },
};

const GLANCE = [
  { k: "Network", v: "Solana mainnet" },
  { k: "Assets", v: "SOL, USDC, USDT" },
  { k: "Built on", v: "Helius Privacy Rings" },
  { k: "For", v: "People, teams and agents" },
];

export default function LiveOnSolanaPost() {
  return (
    <ArticleLayout
      slug="live-on-solana"
      lede={
        <p>
          Solana is the fastest place to move money on chain, and until now every payment on it
          showed the world what you sent and how much. Today Gloam is live on Solana: private
          payments for people, teams and agents, built on Helius Privacy Rings.
        </p>
      }
      facts={GLANCE}
      actions={
        <>
          <AppLink href="/app" className="btn btn-ink">
            Open the app
          </AppLink>
          <a href="https://x.com/gloamtrade" target="_blank" rel="noreferrer" className="btn btn-quiet">
            Follow @gloamtrade <ArrowUpRight />
          </a>
        </>
      }
    >
      <h2>What you can do today</h2>
      <p>
        Pick Solana in the network menu and Gloam works the way it does on every other network.
        Add SOL, USDC or USDT to a private balance, or bring money in from another chain. Pay one
        person privately, run payroll for your whole team in batches, receive by sharing your
        private address, and cash out to any wallet when you want it public again.
      </p>
      <p>
        Agents get the same thing. The Gloam SDK and MCP now speak Solana, so an agent can open
        its own private account from its Solana key, pay for tools and services, and cash out,
        under the same spending limits it has on our EVM networks.
      </p>

      <h2>What stays private</h2>
      <p>
        On Solana, a private payment hides the token and the amount. Each payment moves between
        private accounts, never your main wallet, and Gloam pays the network fee, so your wallet
        never shows up as the sender.
      </p>
      <p>
        We say plainly what is visible too. The two private accounts a payment moves between can
        be seen on chain, and adding money from your own wallet shows the wallet it came from.
        When Helius opens anonymous rings, which hide who paid whom as well, Gloam moves to them.
      </p>

      <h2>Built on Helius Privacy Rings</h2>
      <p>
        Privacy Rings is Helius&apos;s shielded payment layer for Solana. Balances live as
        encrypted notes, spends are checked by zero-knowledge proofs, and the programs have been
        reviewed by Certora and zkSecurity. Proofs are made by Helius&apos;s prover, which runs in
        a secure enclave, rather than on your device.
      </p>
      <p>
        Gloam adds the parts that make it usable every day: a private account derived from a
        signature from your own wallet, so there is nothing new to back up; a relay that pays
        every network fee; payroll, receive links and cash out; bringing money in from other
        chains; and the SDK and MCP for agents. It is the same Gloam you use on Robinhood Chain,
        Base, BNB Chain, Ethereum, Tempo and Elysium.
      </p>

      <h2>Self-custodial</h2>
      <p>
        Your private account opens from your own wallet&apos;s signature. Gloam never holds your
        keys or your money, and you can cash out to any wallet at any time.
      </p>

      <p>
        Try it in{" "}
        <AppLink href="/app">the app</AppLink>, read{" "}
        <Link href="/docs/chain">how each network works</Link>, or build with the{" "}
        <Link href="/docs">SDK and MCP</Link>.
      </p>
    </ArticleLayout>
  );
}
