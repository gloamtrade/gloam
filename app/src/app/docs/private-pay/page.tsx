import type { Metadata } from "next";
import Link from "next/link";
import { AppLink } from "@/components/AppLink";
import { DocsLayout } from "@/components/DocsLayout";
import { FlowDiagram } from "@/components/docs/FlowDiagram";

export const metadata: Metadata = {
  title: "Private pay on RH",
  description:
    "How Gloam private pay compares to Solana private send and Zcash, and what is live on Robinhood Chain mainnet and testnet.",
};

export default function DocsPrivatePayPage() {
  return (
    <DocsLayout
      title="Private pay on Robinhood Chain"
      lede="Yes, Solana-style “pay like public send” is possible on RH. Gloam does it with vault proofs and receive tags, live on mainnet and testnet."
      glance={[
        { label: "Chain", value: "RH EVM" },
        { label: "Direct", value: "Receive tag" },
        { label: "Discovery", value: "Memo + scan" },
        { label: "Swaps", value: "Mainnet, amounts public" },
      ]}
    >
      <h2>Why Solana private send “feels” like public send</h2>
      <p>
        Wallets like Solflare hide the hard parts. You still pick a recipient
        and an amount, under the hood they use a shielded program, encryption,
        and discovery so you are not pasting raw note secrets. The <em>UI</em>{" "}
        matches public send; the <em>settlement</em> is private.
      </p>
      <p>
        Robinhood Chain is <strong>EVM</strong>, not Solana. There is no
        built-in Elusiv/Light-style stack. That does <strong>not</strong> mean
        the pattern is impossible, it means the app + contracts must implement
        it (which is what Gloam is).
      </p>

      <FlowDiagram
        title="Gloam private pay (current)"
        steps={[
          {
            n: "1",
            title: "Receive tag",
            body: "Recipient publishes gloamr1… (shielded identity, not a public 0x transfer target).",
          },
          {
            n: "2",
            title: "Vault transfer proof",
            body: "Sender spends a vault note → payment + change. Chain does not see Alice→Bob amount.",
          },
          {
            n: "3",
            title: "Encrypted package",
            body: "Ticket sealed to their tag (gloam2t). Optional, where the network has a memo board: post as on-chain memo for Scan inbox.",
          },
          {
            n: "4",
            title: "Claim",
            body: "Recipient opens it with their tag key (or the claim link) and saves the note in their browser.",
          },
          {
            n: "5",
            title: "Secure",
            body: "The app moves it straight away into a fresh note only the recipient knows. From then on the sender cannot take it back.",
          },
        ]}
      />

      <h2>Claim links you send</h2>
      <p>
        No Gloam address? Pick <strong>Claim link</strong> under To and you
        get a link that holds the payment instead. Or paste a 0x address or an
        ENS name, and Gloam pays that wallet from your private balance (the
        amount is public there).
        Every one you send is kept under <strong>Sent links</strong>, below
        the Send privately form, encrypted in that browser like your balance.
        Each shows whether its money has moved yet. Copy a code again, or take
        back one nobody used into your own private balance. Taking back is a
        claim that is then secured (below), so once that move lands the link
        stops working. Until it lands, whoever has the link can still claim it
        first.
      </p>

      <h2>Why a claim is secured</h2>
      <p>
        A Gloam payment is a note in the vault, and whoever knows its secret can
        spend it. The sender made that secret, so until the recipient moves the
        money the sender could still spend it back. Claiming in the app does two
        things: it saves the payment, then moves the whole amount into a fresh
        note whose secret only the recipient&apos;s browser knows (a private
        transfer with a zero change note). Once that lands, the payment is final.
      </p>
      <ul>
        <li>
          <strong>One step.</strong> Claim and secure happen together. With the
          relay on there is no wallet prompt and no gas; with it off, the wallet
          signs and shows as the sender of that one private transfer.
        </li>
        <li>
          <strong>If it cannot finish</strong> (a closed wallet prompt, a dropped
          connection), the payment stays in the balance marked not secured yet,
          and Move offers to secure it. Nothing is lost: the new note is saved
          before anything is sent.
        </li>
        <li>
          <strong>If it was claimed somewhere else first</strong> (on another
          device, or by the sender taking it back), the move cannot land and the
          claim is dropped. Check with the person who sent it.
        </li>
        <li>
          Agents get the same guarantee from the SDK&apos;s sweep: a payee calls{" "}
          <code>settleGloamPayment</code> and serves only once it is final.
        </li>
      </ul>

      <h2>Is RH “not able” to do Solana-style private send?</h2>
      <p>
        <strong>No.</strong> EVM supports the same ingredients: Merkle notes,
        ZK proofs, encrypted memos, client scan. Solana’s edge today is{" "}
        <em>product integration in wallets</em>, not magic of the SVM.
      </p>

      <h2>Replicating Zcash on Robinhood with Gloam?</h2>
      <p>
        <strong>Directionally yes; literally cloning Zcash no.</strong>
      </p>
      <ul>
        <li>
          <strong>Zcash</strong> = private <em>ZEC</em> (its own asset + full
          shielded protocol).
        </li>
        <li>
          <strong>Gloam</strong> = private rails for{" "}
          <em>stablecoins, $GLOAM and other listed tokens on Robinhood Chain mainnet</em> (and
          stock tokens on testnet): hold and pay privately next to open settlement
          on the same chain. On mainnet you can also swap them from the
          private balance. A private swap keeps who swapped private; its
          amounts are public.
        </li>
      </ul>
      <p>What still gates a full Zcash-class experience:</p>
      <ul>
        <li>A bigger anonymity set: the mainnet pools are new</li>
        <li>Swaps that keep the amounts private too</li>
        <li>
          External review beyond the vault contracts: the{" "}
          <Link href="/security">Kann Audits report</Link> did not cover the
          routers, circuits or app
        </li>
      </ul>

      <h2>Try it</h2>
      <p>
        <AppLink href="/app/vault?tab=move">Move</AppLink>, private pay ·{" "}
        <Link href="/docs/private-swaps">Private swaps</Link> ·{" "}
        <Link href="/docs/privacy-model">Privacy model</Link>.
      </p>
    </DocsLayout>
  );
}
