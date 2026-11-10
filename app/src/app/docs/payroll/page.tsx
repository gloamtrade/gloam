import type { Metadata } from "next";
import Link from "next/link";
import { AppLink } from "@/components/AppLink";
import { DocsLayout } from "@/components/DocsLayout";
import { FlowDiagram } from "@/components/docs/FlowDiagram";
import { CASH_OUT_FEE_PERCENT } from "@/lib/cashOutFee";

export const metadata: Metadata = {
  title: "Private payroll",
  description:
    "Pay a whole team privately on Robinhood Chain or Tempo: upload a list, pay everyone at once, and nobody sees who got what. Includes the Gloam relay, which keeps your wallet off the record.",
};

export default function DocsPayrollPage() {
  return (
    <DocsLayout
      title="Private payroll"
      lede="Upload a list, pay everyone at once, and nobody sees who got what. Not even your wallet shows up, because Gloam sends each payment for you."
      glance={[
        { label: "Networks", value: "Robinhood Chain, Tempo" },
        { label: "Pay in", value: "USDG, USDC.e and other stablecoins" },
        { label: "People per run", value: "Up to 200" },
        { label: "Status", value: "Live on mainnet and testnet" },
      ]}
      quickLinks={[
        { href: "/app/payroll", label: "Open payroll" },
        { href: "#csv", label: "List format" },
        { href: "#relay", label: "The Gloam relay" },
      ]}
    >
      <h2>Why payroll needs privacy</h2>
      <p>
        On a public chain, payday is public. Anyone with an explorer can see
        what each person on your team earns, who your contractors are, and how
        much you spend each month. Your team can see each other&apos;s pay too.
        Gloam payroll pays everyone from your private balance, so the chain
        shows private transfers with no names and no amounts.
      </p>

      <FlowDiagram
        title="A payroll run"
        steps={[
          {
            n: "1",
            title: "Add your team",
            body: "Upload a CSV: name, Gloam address, amount. No address means that person gets a claim link.",
          },
          {
            n: "2",
            title: "Check who sees what",
            body: "Flip the list to The public sees: every row becomes a private transfer with no name and no amount.",
          },
          {
            n: "3",
            title: "Pay everyone",
            body: "Gloam pays each person in turn from your private balance and shows each one as it lands.",
          },
          {
            n: "4",
            title: "Share and keep records",
            body: "Download your results. Send claim links to the people who need them.",
          },
        ]}
      />

      <h2>Run your first payroll</h2>
      <ol>
        <li>
          <strong>Fund your wallet.</strong> On mainnet, hold USDG on Robinhood
          Chain, or USDC.e, pathUSD, USDT0 or OUSD on Tempo. To practice first
          on testnet, claim test USDG from the{" "}
          <a href="https://faucet.paxos.com/" target="_blank" rel="noreferrer">
            Paxos faucet
          </a>{" "}
          on Robinhood Chain, or use the faucet button in the app for PathUSD on
          Tempo. See <Link href="/docs/testnet">practice on testnet</Link>.
        </li>
        <li>
          <strong>Add it privately.</strong> In{" "}
          <AppLink href="/app/vault?tab=shield">Vault, Shield</AppLink>, move the
          total you want to pay into your private balance. On testnet, one
          deposit that covers the whole run is simplest. On mainnet, deposit limits
          allow 50,000 per deposit (and 2,500,000 in total for each stablecoin), so
          fund a bigger run with several deposits. Payments themselves are never
          limited.
        </li>
        <li>
          <strong>Upload your list.</strong> In{" "}
          <AppLink href="/app/payroll">Payroll</AppLink>, pick the currency and drop
          in your CSV. Lines with problems are flagged and skipped until you
          fix them.
        </li>
        <li>
          <strong>Keep Hide my wallet on</strong> and press Pay. Keep the tab
          open while it runs, about 8 seconds per person.
        </li>
        <li>
          <strong>Download the results.</strong> They include each claim link
          and a record of every payment for your books.
        </li>
      </ol>

      <h2 id="csv">List format</h2>
      <p>One person per line. A header row is optional.</p>
      <pre>
        <code>{`name,gloam_address,amount
Duke,gloamr1.7fQk...x9Wd,6000
Yomi,,4800
Robin,gloamr1.3mPz...c4Ta,4200`}</code>
      </pre>
      <ul>
        <li>
          <strong>Gloam address</strong> (starts with <code>gloamr1.</code>):
          they are paid directly and the payment shows up in their app.
        </li>
        <li>
          <strong>Blank</strong>: they get a claim link after the run. Anyone
          with the link can claim it, so send each link only to its person.
          Claiming secures it straight away: the money moves into a balance only
          they hold, so the link is worth nothing after that, to anyone.
        </li>
        <li>
          <strong>A public 0x address</strong> is rejected on purpose: paying
          it would show the amount on the explorer.
        </li>
        <li>Amounts are in the currency you pick, up to 6 decimals for stablecoins.</li>
      </ul>

      <h2>Who sees what</h2>
      <ul>
        <li>
          <strong>The public</strong> sees private transfers, sent by Gloam.
          No names, no amounts, and no link to your wallet.
        </li>
        <li>
          <strong>Each person</strong> sees only their own pay.
        </li>
        <li>
          <strong>You</strong> keep the full record in your results file.
        </li>
      </ul>
      <p>
        What is still public: the amount you add to your private balance at the
        start, and any amount a person later cashes out to a public wallet.
        Paying out of a balance you built up over time hides your payroll total
        too. More detail in <Link href="/docs/privacy-model">What stays private</Link>.
      </p>

      <h2 id="schedules">Scheduled payroll</h2>
      <p>
        Pay the same team every month without rebuilding the list. Save a pay
        list as a schedule, from New schedule, Save as a schedule under the Pay
        button, or Repeat this run on a finished run.
      </p>
      <ul>
        <li>
          <strong>When:</strong> monthly on a day you pick, every two weeks,
          weekly on a weekday, or one time on a date. Add an end date if the
          schedule should stop.
        </li>
        <li>
          <strong>Cap per run:</strong> the most one run may pay out. If the list
          grows past it, Pay stays off and says why, so a typo cannot send ten
          times the payroll.
        </li>
        <li>
          <strong>Payroll due:</strong> when payday comes, the Payroll page shows
          a reminder with Run now. It loads the list into the normal run, with
          the same progress, resume and receipt.
        </li>
        <li>
          <strong>Pause, edit or delete</strong> a schedule at any time. Each
          payday is run once, oldest first, so a missed month stays visible.
        </li>
      </ul>
      <p>
        <strong>Why it does not pay on its own.</strong> Gloam never holds your
        keys, so no server can pay for you. The schedule reminds you and runs in
        one click, from your browser. Schedules are stored encrypted in this
        browser, like your runs.
      </p>

      <h2>If something goes wrong</h2>
      <ul>
        <li>
          <strong>Closed the tab mid-run?</strong> Open Payroll again and press
          Resume. Before continuing, Gloam checks the chain for the payment that
          was in flight, so nobody is paid twice and no money is lost.
        </li>
        <li>
          <strong>Not enough private balance?</strong> The run pauses with an
          Add money privately button. Top up, then resume.
        </li>
        <li>
          <strong>Your runs and claim links</strong> are stored encrypted in
          this browser, like your private balance. Back up from Settings before
          clearing browser data.
        </li>
      </ul>

      <h2 id="relay">The Gloam relay</h2>
      <p>
        Normally the wallet that sends a transaction is public. With Hide my
        wallet on, Gloam submits your private sends, cash outs and payment
        notices from its own account, so your wallet never appears next to
        them. It is on by default in Payroll and in Vault. Private payments are
        free; on mainnet a cash out costs {CASH_OUT_FEE_PERCENT}, kept by the vault.
      </p>
      <p>
        <strong>The relay cannot take or redirect money.</strong> Each payment
        is authorized by a proof made in your browser, and for a cash out the
        destination address is locked inside that proof. The relay checks the
        payment against the vault before sending it, then either submits it
        exactly as you made it or refuses. If the relay is ever offline, the app
        falls back to sending from your wallet and tells you first.
      </p>

      <h3>For developers</h3>
      <p>
        Apps and agents can use the same relay through the SDK (from{" "}
        <code>@gloamtrade/sdk</code> 0.0.5):
      </p>
      <pre>
        <code>{`import { relayIntent } from "@gloamtrade/sdk";

// payment = await buildGloamPayment({ ... })
const hash = await relayIntent(payment.intent); // your wallet stays off the record`}</code>
      </pre>
      <p>
        The MCP server settles agent payments through the relay with{" "}
        <code>GLOAM_USE_RELAY=1</code>. See <Link href="/docs/agents">Agents</Link>.
      </p>

      <h2>No middlemen</h2>
      <p>
        The vaults on both networks were redeployed so that nobody, including
        the Gloam team, can move your money or quietly change the rules. There is
        no admin withdraw, and any change to how proofs or prices are checked
        has to be announced on-chain three days before it can take effect. Pool
        addresses are on <Link href="/docs/chain">Networks</Link>.
      </p>
    </DocsLayout>
  );
}
