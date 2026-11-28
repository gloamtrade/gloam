import type { Metadata } from "next";
import Link from "next/link";
import { AppLink } from "@/components/AppLink";
import { DocsLayout } from "@/components/DocsLayout";
import { FlowDiagram } from "@/components/docs/FlowDiagram";

export const metadata: Metadata = {
  title: "Proofs",
  description:
    "Prove an exact balance, that you hold at least an amount, that you were paid, or what a payroll run paid in total, to one person you choose. What each proof shows, what it hides, and how anyone can check it.",
};

export default function DocsProofsPage() {
  return (
    <DocsLayout
      title="Proofs"
      lede="Your money in Gloam is private by default. A proof lets you show one fact about it to one person you choose: a balance, that you hold at least an amount, that you were paid, or what a payroll run paid in total. They check it themselves, in their browser, against the live vault."
      glance={[
        { label: "Exact balance", value: "one balance, shown" },
        { label: "At least", value: "a minimum, balance hidden" },
        { label: "Payment", value: "the amount, or a minimum" },
        { label: "Payroll total", value: "a run's total, each pay hidden" },
      ]}
      quickLinks={[
        { href: "/app/disclose", label: "Make a proof" },
        { href: "/verify", label: "Check a proof" },
        { href: "/docs/privacy-model", label: "What stays private" },
        { href: "/docs/sdk/disclosure", label: "Selective disclosure (SDK)" },
      ]}
    >
      <h2>Four proofs</h2>
      <p>
        All four are made on your device from records only you hold, and none of
        them can be used to move your money. Open{" "}
        <AppLink href="/app/disclose">Prove</AppLink> in the app and pick one. A payroll
        total is made from a finished run on the{" "}
        <AppLink href="/app/payroll">Payroll</AppLink> page.
      </p>

      <h3>Exact balance</h3>
      <p>
        Shows one of your private balances exactly: the asset and the amount. Use
        it when the number itself is the point, for example a lender asking what
        is in one account. It covers one balance, never your total. Like the
        other proofs it carries a label and an expiry, is made on your device and
        never goes on chain. It shows the balance existed, not that it is still
        unspent; ask for a proof of funds for that. It points at the
        balance&apos;s record in the vault, so a balance that came straight from a
        deposit, whose record names your wallet, has to be sent to your own Gloam
        address before it can be proven this way.
      </p>

      <h3>At least (proof of funds)</h3>
      <p>
        Shows that you hold <strong>at least</strong> an amount you name, such as
        at least 10,000 USDG, without showing how much you really hold. Up to four
        of your balances in the same asset can back it, and the app picks the
        fewest that cover the amount. If it would take more than four, prove a
        smaller amount or combine balances first.
      </p>

      <h3>Payment (proof of payment)</h3>
      <p>
        Shows that a private payment was made. You choose whether it shows the
        exact amount, or only that it was at least a figure you pick. Either side
        of a payment can make this proof: it shows the payment happened, not
        which side of it you were on. It works for
        payments sent to your Gloam address, claim links and payroll payouts, once
        you have claimed them.
      </p>

      <h3 id="payroll-total">Payroll total</h3>
      <p>
        Shows that a payroll run you sent paid <strong>exactly</strong> a total
        across a number of payments, such as 21,500 USDG in 5 payments, without
        showing what any one of them got. It is for your accountant, an auditor or a tax
        office: the figure on the books, backed by the vault. On a finished run,
        or under Past runs, choose Prove the total.
      </p>
      <p>
        The checker confirms that every payment in it is a private payment inside
        the vault that you sent from your own balance. A deposit, a swap, the
        change from a payment, or a payment someone sent you cannot be counted,
        and no payment can be counted twice.
      </p>

      <h2>What each one shows and hides</h2>
      <div className="overflow-x-auto">
        <table>
          <thead>
            <tr>
              <th>Proof</th>
              <th>They see</th>
              <th>They never see</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Exact balance</td>
              <td>The asset, that one amount, and the transaction that made it</td>
              <td>Other balances, history</td>
            </tr>
            <tr>
              <td>At least</td>
              <td>The asset and the minimum you named</td>
              <td>Your real balance, which balances back it, your wallet, history</td>
            </tr>
            <tr>
              <td>Payment</td>
              <td>The asset, the amount or a minimum, and when it landed</td>
              <td>Your balance, your other payments, your wallet</td>
            </tr>
            <tr>
              <td>Payroll total</td>
              <td>The asset, the run&apos;s total, how many people were paid, and when the payments landed</td>
              <td>What each person got, their names and addresses, your balance</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p>
        Proofs of funds, payments and payroll totals also carry two things you
        set: who the proof is for, and when it expires.
      </p>

      <h2>Made for one person</h2>
      <p>
        When you make an at least, payment or payroll total proof, you say who it
        is for, like
        &quot;Acme Bank&quot; or &quot;my landlord&quot;, and how long it is good
        for: 1, 7 or 30 days. Both are sealed into the proof. Anyone can still
        read a forwarded copy, but it will say who it was made for and when it
        ran out, and changing either one breaks it.
      </p>

      <h2>How checking works</h2>
      <FlowDiagram
        title="What the verifier does"
        steps={[
          {
            n: "1",
            title: "Checks the math",
            body: "The zero-knowledge proof is checked in the browser with Gloam's published checking key. Nothing is sent to Gloam.",
          },
          {
            n: "2",
            title: "Checks who it is for",
            body: "The name, expiry, network and vault must match what was sealed into the proof.",
          },
          {
            n: "3",
            title: "Checks the live vault",
            body: "It reads the vault on Robinhood Chain or Tempo directly: the state the proof was made against, for a payment that the payment is there, and for a payroll total that every payment in it is a private payment the sender made.",
          },
          {
            n: "4",
            title: "Checks it is still current",
            body: "For at least, that none of the backing balances has been spent since. For all of them, that the proof has not expired.",
          },
        ]}
      />
      <p>
        Each check is listed on the result with a plain pass, fail or could not
        check. A proof only reads as verified when every check passes. If the
        network cannot be reached, the result says so instead of guessing.
      </p>

      <h2>Limits worth knowing</h2>
      <ul>
        <li>
          <strong>Mainnet and testnet use different keys.</strong> On mainnet,
          proofs use the final keys from the production ceremony, which closed
          on 17 October with 13 contributors, and so do Base Sepolia and
          Ethereum Sepolia. On the Robinhood Chain and Tempo testnets they use
          development keys and test funds. The code was
          reviewed internally before launch, and Kann Audits reviewed the vault
          contracts (<Link href="/security">report, 1 November 2026</Link>) and found no Critical, High or Medium
          issues. The circuits were not part of that review.
          See the <Link href="/docs/production">production gate</Link>.
        </li>
        <li>
          <strong>At least publishes spend markers.</strong> A proof of funds
          carries a marker for each balance behind it, so the verifier can tell
          none were spent. The flip side: if you later spend one of those
          balances, whoever holds the proof can see that it was spent, and when.
          Before a cash out or swap the app moves those balances to a fresh one
          first, so the proof does not lead to where the money went or how
          much. The move and the cash out land close together, so their
          timing can still hint at a link. Proofs made with an older version of
          the app left no mark on their balances: to be safe, send those
          balances to your own Gloam address before you cash them out.
        </li>
        <li>
          <strong>At least means &quot;can open at least this much&quot;.</strong>{" "}
          Strictly, a proof of funds shows the holder knows the keys to unspent
          balances worth at least the amount. A balance someone paid you was
          created by them, so until you move it, the sender knows its key too
          and could count it in a proof of their own. Balances you added
          yourself, or change left over after you pay someone, are yours alone.
        </li>
        <li>
          <strong>A payment proof points at its record.</strong>{" "}
          They can find the transaction that delivered it and when it landed. That transaction
          never shows the amount. It shows the sender&apos;s wallet only if they
          paid without Hide my wallet.
        </li>
        <li>
          <strong>Up to four balances</strong> can back one proof of funds.
        </li>
        <li>
          <strong>A payroll total proves a sum, not a staff list.</strong>{" "}
          It does not show who the people were or that they work for you. It also cannot
          tell whether two payments went to the same person, or whether one of
          them went back to you. It counts payments, each one a real private
          payment you sent.
        </li>
        <li>
          <strong>Up to 32 payments per proof.</strong>{" "}
          A larger run is proven in even parts, sealed together in one proof. Each part shows its own
          subtotal, over 16 to 32 payments, so no part is one person&apos;s pay. A
          run of one payment proves that payment, so the app warns you.
        </li>
        <li>
          <strong>A payroll total points at its payments.</strong>{" "}
          The checker sees the transaction behind each payment and when it landed. Those
          never show amounts or who received them. They show your wallet only if
          you paid without Hide my wallet.
        </li>
        <li>
          <strong>Made in the browser that ran the payroll.</strong>{" "}
          Proving a total needs each payment&apos;s key, which the run keeps encrypted on
          that device. Runs paid before Gloam kept those keys cannot be proven,
          unless every payee was sent a claim link.
        </li>
        <li>
          <strong>Expired is not the same as false.</strong> An expired proof may
          have been true when it was made. Ask for a fresh one.
        </li>
      </ul>

      <h2>How to check a proof</h2>
      <ol>
        <li>
          Open <Link href="/verify">gloam.trade/verify</Link>. No wallet or
          account needed.
        </li>
        <li>
          Paste the proof. It starts with <code>gloamfunds1:</code>,{" "}
          <code>gloampay1:</code>, <code>gloamroll1:</code> or{" "}
          <code>gloambal1:</code>. The older <code>gloamdisc1:</code> format is
          no longer accepted, because anyone can copy one from a public deposit;
          ask for a new proof instead. If you were sent a
          link, opening it fills the proof in for you. The proof travels after the
          # in the link, so it never reaches a server.
        </li>
        <li>
          Read the verdict, who it was made for and when it expires, then the
          list of checks.
        </li>
      </ol>
    </DocsLayout>
  );
}
