import type { Metadata } from "next";
import { ELYSIUM_ENABLED } from "@/lib/elysium";
import Link from "next/link";
import { AppLink } from "@/components/AppLink";
import { DocsLayout } from "@/components/DocsLayout";
import { BRIDGE_MAX_USD, BRIDGE_MIN_USD, EXPENSIVE_ROUTE_MIN_USD, EXPENSIVE_ROUTE_SHARE } from "@/lib/bridge";

export const metadata: Metadata = {
  title: "Deposit from another chain",
  description:
    "Pay into Gloam from Bitcoin, Solana, Tron or 22 EVM chains through Relay. From a Solana or EVM wallet it lands straight in your private balance; from Bitcoin or an exchange it lands in your wallet first.",
};

const usd = (n: number) => `$${n.toLocaleString("en-US")}`;

export default function DocsBridgePage() {
  return (
    <DocsLayout
      title="Deposit from another chain"
      lede={`Pay in from the chain your money is already on. Gloam's bridge runs on Relay and lands your money as the vault's stablecoin: USDG on Robinhood Chain, USDC on Tempo, Base and Ethereum.${ELYSIUM_ENABLED ? " It does not bring money into Elysium yet." : ""}`}
      glance={[
        { label: "From", value: "Bitcoin, Solana, Tron, 22 EVM" },
        { label: "Lands as", value: "USDG or USDC" },
        { label: "Per bridge", value: `${usd(BRIDGE_MIN_USD)} to ${usd(BRIDGE_MAX_USD)}` },
        { label: "Run by", value: "Relay" },
      ]}
    >
      <h2 id="one-step">Straight into your private balance</h2>
      <p>
        From a Solana wallet, or an EVM wallet on Ethereum, Base, Arbitrum, BNB
        Chain and 18 more, it takes one step. Leave{" "}
        <strong>Land in private balance</strong> on, confirm in your wallet, and
        Relay makes the private deposit for you when the money arrives. If that
        can&apos;t happen, Relay sends it to your wallet on the destination chain
        instead, and you add it privately from there.
      </p>

      <h2 id="deposit-address">Bitcoin, Tron and exchanges</h2>
      <p>
        A deposit address can&apos;t make the private deposit itself, so these
        take two steps. You get a one-time address, send to it from any wallet
        or exchange, and the money arrives in your wallet on Robinhood Chain,
        Tempo, Base or Ethereum. Bitcoin waits for its own confirmations first, usually 10 to 30
        minutes. Then you add it privately with one more tap.
      </p>
      <p>
        Paying to a deposit address from Bitcoin, Solana or Tron, you give a
        refund address up front. If the transfer fails, the money goes back
        there.
      </p>

      <h2 id="costs">What it costs</h2>
      <p>
        A deposit made directly from a wallet on the vault&apos;s own chain is
        free. Bringing money over from another chain isn&apos;t: Relay charges
        for the route, and Gloam can add a fee of its own, up to 1%, which shows
        on its own line when it does.
      </p>
      <p>
        Gloam doesn&apos;t route anything itself. Relay&apos;s solvers compete
        for each order, and before you send anything you see what you pay, what
        arrives, the least that will arrive, and every fee. If a fill would land
        under that minimum, it doesn&apos;t go through and you get refunded.
      </p>
      <p>
        Some routes cost more than others, often because of a small amount or a
        thin market on the chain you pay from. When a route would cost over{" "}
        {Math.round(EXPENSIVE_ROUTE_SHARE * 100)}% of what you pay (and at least{" "}
        {usd(EXPENSIVE_ROUTE_MIN_USD)}), the app says so before you send. A
        larger amount spreads the fixed fees, and another chain or token, or the
        stablecoin sent straight to your wallet, may cost less.
      </p>

      <h2 id="privacy">What is public</h2>
      <p>
        A bridge is public, like any deposit. The chain you pay from shows your
        wallet and the amount, and the vault shows the deposit. What you do with
        the money after it lands stays private. See{" "}
        <Link href="/docs/privacy-model">what stays private</Link>.
      </p>

      <h2 id="try">Try it</h2>
      <p>
        In the app, open <AppLink href="/app/vault?tab=shield">Add</AppLink> on a
        mainnet and pick the chain you&apos;re paying from. See also{" "}
        <Link href="/docs/private-swaps">private swaps</Link> and{" "}
        <Link href="/docs/chain#mainnet">networks</Link>.
      </p>
    </DocsLayout>
  );
}
