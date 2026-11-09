import type { Metadata } from "next";
import Link from "next/link";
import { AppLink } from "@/components/AppLink";
import { DocsLayout } from "@/components/DocsLayout";
import { FlowDiagram } from "@/components/docs/FlowDiagram";
import { swapMainnets } from "@/lib/vaultSwap";

export const metadata: Metadata = {
  title: "Sealed trade (retired)",
  description:
    `Gloam's first private trade design, the sealed swap, is retired and stays off on every network. Private swaps replaced it on ${swapMainnets()} mainnet.`,
};

export default function DocsSealedTradePage() {
  return (
    <DocsLayout
      title="Sealed trade (retired)"
      lede={`The sealed swap was Gloam's first design for private trading. It is retired and stays off on every network. Private swaps replaced it: you swap straight from your private balance on ${swapMainnets()} mainnet.`}
      glance={[
        { label: "Sealed trade", value: "Retired, stays off" },
        { label: "Replaced by", value: "Private swaps" },
        { label: "Mainnet vault", value: "No sealed swap code" },
        { label: "Fake fills", value: "Never" },
      ]}
    >
      <h2 id="replaced">What replaced it</h2>
      <p>
        <Link href="/docs/private-swaps">Private swaps</Link>{" "}
        are live on{" "}
        {swapMainnets()} mainnet, under Vault &gt; Swap. One
        transaction takes a note out of the vault, swaps it on a public DEX
        for an exact amount, and puts the output back as a new private note.
      </p>
      <p>
        The trade-off is different. A private swap keeps who swapped private,
        and the tokens and amounts are public, like any DEX trade. The sealed
        swap tried to keep the size private too, and could not stay solvent
        doing it.
      </p>

      <h2 id="why-retired">Why it was retired</h2>
      <p>
        A sealed swap spends an <code>assetIn</code> note and mints an{" "}
        <code>assetOut</code> note with both amounts private, but no tokens
        move, so the pool ends up owing <code>assetOut</code> it does not
        physically hold (audit H1). Rather than ship an insolvent swap or
        reveal your size to fix the accounting, the on-chain verifier on the
        testnet pools is set to zero and the swap stays off.
      </p>
      <p>
        <strong>On mainnet there is nothing to switch on.</strong> The mainnet
        vaults (<code>ShieldPoolPayments</code>) have no sealed swap code at
        all. Private swaps do not change that: their routers are separate
        contracts that use only the vault&apos;s normal calls.
      </p>

      <h2 id="stock-tokens">Stock tokens today</h2>
      <p>
        On Robinhood Chain testnet you can{" "}
        <AppLink href="/app/vault?tab=shield">shield</AppLink> stock tokens (TSLA, AMZN, PLTR,
        NFLX and AMD on testnet), hold them privately, and{" "}
        <AppLink href="/app/vault?tab=move">send them privately</AppLink>. Stock tokens
        are not on mainnet, and private swaps do not cover them.
      </p>

      <h2 id="how-it-worked">How the sealed trade worked</h2>
      <FlowDiagram
        title="Sealed trade (retired)"
        steps={[
          {
            n: "1",
            title: "Pick direction + vault note",
            body: "Buy (ETH → stock) or sell (stock → ETH). Spend a note you already hold in the vault.",
          },
          {
            n: "2",
            title: "Prove the trade",
            body: "Browser builds a sealed-swap proof. Size stays private; the chain only sees a vault proof.",
          },
          {
            n: "3",
            title: "Settle in vault",
            body: "You receive the out asset as a new vault note, plus change. No public DEX hop.",
          },
        ]}
      />
      <p>
        Rates came from <strong>coarsened display marks</strong> (Yahoo and
        CoinGecko), not an on-chain oracle, and it ran on dev ceremony keys
        only. The public <code>amountOutMin</code> was a 1-wei floor, so the
        size did not show, while the rates and the asset pair did.
      </p>

      <h2 id="vault-adapter">Vault trade adapter (testnet)</h2>
      <FlowDiagram
        title="From vault (public swap step)"
        steps={[
          {
            n: "1",
            title: "Cash out",
            body: "Unshield a vault note to your open wallet (public edge).",
          },
          {
            n: "2",
            title: "Swap",
            body: "Public DEX swap. Size and pair are visible on the explorer.",
          },
          {
            n: "3",
            title: "Re-shield",
            body: "Proceeds go back into the vault. Hold is private again.",
          },
        ]}
      />
      <p>
        This path stays on the Robinhood Chain testnet Trade tab. Your wallet
        shows on both public edges. On mainnet, use{" "}
        <Link href="/docs/private-swaps">private swaps</Link> instead: the
        relay sends them and your wallet never shows.
      </p>

      <h2 id="will-not">What we will not do</h2>
      <ul>
        <li>Hide a public swap behind a “private” button without saying what shows</li>
        <li>Claim production readiness on dev proving keys</li>
        <li>Turn the sealed swap back on</li>
      </ul>

      <h2 id="repo">Repo pointers</h2>
      <ul>
        <li>
          Sealed trade design, for history: <code>contracts/SEALED_TRADE.md</code>
        </li>
        <li>
          Private swaps: <code>contracts/src/GloamVaultSwap.sol</code> and{" "}
          <code>app/src/lib/vaultSwap.ts</code>
        </li>
        <li>
          Production keys gate:{" "}
          <Link href="/docs/production">/docs/production</Link>
        </li>
      </ul>
    </DocsLayout>
  );
}
