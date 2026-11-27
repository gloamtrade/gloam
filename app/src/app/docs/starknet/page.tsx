import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { STARKNET_PRIVACY } from "@gloamtrade/sdk";
import { AppLink } from "@/components/AppLink";
import { DocsLayout } from "@/components/DocsLayout";
import { STARKNET_ENABLED, starknetConfig } from "@/lib/starknetPrivacy/config";
import { PAYROLL_MAX_ROWS, PAYROLL_PROOF_MAX } from "@/lib/starknetPrivacy/payroll";
import { STARKNET_DOCS_NAME } from "./starknetDocs";

export const metadata: Metadata = {
  title: "Starknet",
  description:
    "Gloam on Starknet, through Starknet's own privacy pool: how your private account works, exactly what is public and what is hidden, the pool's auditor key, fees, limits, payroll, claim links, payment requests, the SDK and the MCP tools.",
};

export default function DocsStarknetPage() {
  // Behind NEXT_PUBLIC_STARKNET_ENABLED (lib/starknetPrivacy/config): the page answers 404 until it is "1".
  if (!STARKNET_ENABLED) notFound();
  const cfg = starknetConfig();
  const token = cfg.tokens[0] ?? null;
  return (
    <DocsLayout
      title={STARKNET_DOCS_NAME}
      lede="Gloam on Starknet runs on Starknet's own privacy pool, with Gloam's account layer and relay on top. Over a channel that is already open, a payment hides who paid, who was paid and how much. The first payment to someone shows their private account."
      glance={[
        { label: "Network", value: STARKNET_DOCS_NAME },
        { label: "Pool", value: "Starknet's privacy pool" },
        { label: "Asset", value: token ? token.symbol : "None listed" },
        { label: "Proofs", value: "Starkscan's prover" },
      ]}
      quickLinks={[
        { href: "#privacy", label: "What is public" },
        { href: "#fees", label: "What it costs" },
        { href: "#sdk", label: "SDK" },
        { href: "#mcp", label: "MCP tools" },
      ]}
    >
      <h2 id="what">What it is</h2>
      <p>
        Gloam has no vault of its own on Starknet. It uses Starknet&apos;s
        privacy pool (STRK20, from <code>starkware-libs/starknet-privacy</code>),
        which Starknet runs. Gloam adds the rest: a private account that keeps
        your main wallet out of the pool, a relay that pays Starknet&apos;s fees,
        payroll and claim links. Everything else in these docs about the Gloam
        vault does not apply here.
      </p>
      <ul>
        <li>
          <strong>Network</strong>, {STARKNET_DOCS_NAME}
        </li>
        {cfg.pool && (
          <li>
            <strong>Pool</strong>, <code>{cfg.pool}</code>
            {cfg.network === "mainnet" ? ", Starknet's canonical privacy pool" : ""}
          </li>
        )}
        {token && (
          <li>
            <strong>{token.symbol}</strong>, <code>{token.address}</code> ({token.decimals} decimals)
          </li>
        )}
        <li>
          <strong>Who runs the pool</strong>, Starknet. Its owner can change
          its code without a delay. Gloam&apos;s relay sends to it only while
          its code is the version Gloam checked, and pauses Starknet otherwise.
        </li>
      </ul>

      <h2 id="account">Your private account</h2>
      <p>
        Your private account is its own Starknet account, made from your Gloam
        key. A browser wallet signs a fixed text to open it (twice the first
        time, to check it signs the same way each time). A Gloam wallet opens
        it with its passkey or backup code. The same wallet, passkey or code
        opens the same account on any device.
      </p>
      <p>
        Gloam&apos;s relay deploys the account and sends every one of its
        transactions, so it never holds STRK and your main wallet never appears
        in the pool. Opening it registers its viewing key and opens its own
        channel in one transaction. That shows the account&apos;s address, and
        it is why a later cash out never names the account.
      </p>

      <h2 id="privacy">What is public and what is hidden</h2>
      <ul>
        <li>
          <strong>A payment over a channel already open</strong>: hidden.
          Nobody sees who paid, who was paid or how much.
        </li>
        <li>
          <strong>The first payment to someone</strong> opens a channel to
          them, which shows their private account. It never shows who paid or
          how much. A payroll with several first payments shows those accounts
          together.
        </li>
        <li>
          <strong>Adding money</strong> shows your private account and the
          amount.
        </li>
        <li>
          <strong>A cash out</strong> shows where the money went and how much,
          never which private account it came from.
        </li>
        <li>
          <strong>Opening an account</strong> shows its address.
        </li>
        <li>
          Every pool transaction shows that it happened, how many notes it
          made, and Gloam&apos;s relay as its sender.
        </li>
      </ul>
      <h3 id="who-else">Who else can read it</h3>
      <ul>
        <li>
          <strong>The pool&apos;s auditor key.</strong> {STARKNET_PRIVACY.auditor}
        </li>
        <li>
          <strong>The prover.</strong> {STARKNET_PRIVACY.prover} On the
          networks with the Gloam vault, proofs are made on your device.
        </li>
        {cfg.discovery.kind === "indexer" && (
          <li>
            <strong>Finding your notes.</strong> {STARKNET_PRIVACY.discovery}
          </li>
        )}
        <li>
          <strong>Screening.</strong> {STARKNET_PRIVACY.screening}
        </li>
      </ul>
      <p>
        See <Link href="/docs/privacy-model">what stays private</Link> for the
        Gloam vault on the other networks.
      </p>

      <h2 id="fees">What it costs</h2>
      <ul>
        <li>
          Gloam&apos;s relay pays Starknet&apos;s network fees, so you never need
          STRK.
        </li>
        <li>
          On mainnet each add, payment and cash out pays Gloam&apos;s relay fee,
          0.25 USDC, inside its proof. The app reads it from the relay and
          shows it before you confirm. If it changes before your proof is made,
          nothing is sent and the app asks again.
        </li>
        <li>Opening an account is free, with a daily cap.</li>
        <li>
          Bringing USDC in from another network adds Gloam&apos;s fee for
          receiving it on Starknet, shown before you sign. Cashing out to
          another network adds Circle&apos;s fee, shown with the rest as one
          figure.
        </li>
        <li>
          A claim link costs its amount and three fees (paying it, opening its
          one-time account, and the claim), so the person who claims it gets
          the whole amount.
        </li>
      </ul>

      <h2 id="limits">Limits for now</h2>
      <ul>
        <li>
          Proofs come from Starkscan&apos;s prover, through Gloam, and Gloam has
          a few a day for now. When they are used, Starknet says it is busy and
          nothing is sent. Try again later.
        </li>
        <li>
          A proof reads Starknet as it was 10 blocks back, so each move waits
          for about 10 blocks, then for its proof, which can take a few minutes.
        </li>
        <li>An add has a cap per transaction. The app says it when you go over.</li>
      </ul>

      <h2 id="payroll">Payroll, claim links and requests</h2>
      <p>
        <strong>Payroll</strong> pays up to {PAYROLL_MAX_ROWS} people in a run,
        and up to {PAYROLL_PROOF_MAX} in one proof, as many as fit, with
        Gloam&apos;s fee once per proof. A row with no account gets a claim
        link. A row naming an account that was never opened is skipped, and
        says so. A run is saved before each proof goes, so resuming never pays
        anyone twice. See <Link href="/docs/payroll">private payroll</Link>.
      </p>
      <p>
        <strong>Claim links</strong> (<code>gloam.trade/c#sn=...</code>) pay a
        person with no account yet. Each link is a one-time private account
        whose key rides in the link. Paying it shows that one-time account,
        never yours. Claiming it moves the money into the claimer&apos;s own
        private account, which shows that account, as a first payment does.
        A link is claimed once. Until someone claims it, you can take it back
        under Sent links.
      </p>
      <p id="requests">
        <strong>Payment requests</strong> (made under Receive) are links that
        ask to be paid into your private account, with an amount or none, a
        note and your name. Opening one fills in Pay on {STARKNET_DOCS_NAME};
        the payer checks it and pays. Nothing about a request goes on chain. A
        Starknet payment carries no note, so the note is only shown to the
        payer, and the name is only what the link says. The payment is like any
        other: a first payment to you shows your private account.
      </p>

      <h2 id="networks">From and to other networks</h2>
      <p>Add can bring USDC from another network into your private account:</p>
      <ul>
        <li>
          From the networks Circle&apos;s CCTP serves (Base, Ethereum,
          Arbitrum, OP Mainnet, Polygon, Avalanche, Unichain, World Chain,
          Linea, Monad, HyperEVM, Sonic and X Layer), you sign once on that
          network, Circle moves the USDC, and Gloam&apos;s relay receives it on
          Starknet and adds it.
        </li>
        <li>
          From Robinhood Chain, Tempo, BNB Chain and Elysium, one Relay order
          takes the USDC through Base first. You still sign once.
        </li>
        <li>From a Solana wallet.</li>
        <li>
          Or send USDC on Starknet to your private account&apos;s address from
          any wallet or exchange, then Add.
        </li>
      </ul>
      <p>
        Bringing money in is public, like funding the account from any wallet:
        the send on the other network, the arrival on Starknet and the add can
        all be seen. Cash out can send to any of the CCTP networks above. The
        money leaves through a one-time account, so the cash out never names
        your private account, and Circle delivers it on the other network.
      </p>

      <h2 id="not-yet">Not on Starknet</h2>
      <ul>
        <li>
          A proof of funds or of a single payment for{" "}
          <Link href="/verify">/verify</Link>. Instead, Prove can share every
          payment between you and one other account, and that can&apos;t be
          taken back.
        </li>
        <li>Private swaps</li>
      </ul>

      <h2 id="sdk">SDK</h2>
      <p>
        <code>@gloamtrade/sdk</code> from 0.10.0 has Gloam on Starknet at{" "}
        <code>@gloamtrade/sdk/starknet</code>, for servers and agents. It opens
        the same private account the app opens and goes through Gloam&apos;s
        routes. It needs <code>starknet</code> and StarkWare&apos;s privacy SDK
        next to it. StarkWare publishes that on GitHub Packages only, so Gloam
        vendors the build it runs.
      </p>
      <pre>
        <code>{`npm i @gloamtrade/sdk starknet@10.5.0
npm i https://github.com/gloamtrade/gloam/raw/main/app/vendor/starknet-privacy/starknet-privacy-sdk-0.14.4-rc.2-gloam.1.tgz`}</code>
      </pre>
      <pre>
        <code>{`import { privateKeyToAccount } from "viem/accounts";
import {
  openStarknetAccount, starknetViemWallet, registerStarknetAccount, starknetBalances,
  addToStarknetPrivate, payStarknetPrivately, payStarknetMany, cashOutStarknet,
  makeStarknetClaimLink, claimStarknetLink,
} from "@gloamtrade/sdk/starknet";

const account = await openStarknetAccount({ wallet: starknetViemWallet(privateKeyToAccount(key)) });
await registerStarknetAccount(account);          // once: the relay deploys it, one proof opens it
await starknetBalances(account);                  // { usdc: { private, public } } in base units
await addToStarknetPrivate(account, { amount: 5_000_000n });
await payStarknetPrivately(account, { to, amount: 1_000_000n });     // firstPayment says if it showed them
await payStarknetMany(account, { payments });     // up to 28 people, one proof, one fee
await cashOutStarknet(account, { to: "0x...", amount: 1_000_000n });
const link = await makeStarknetClaimLink(account, { amount: 1_000_000n, keep: (l) => save(l.url) });
await claimStarknetLink({ link: link.url, to: claimerAddress });   // their Gloam private account on Starknet`}</code>
      </pre>
      <div className="overflow-x-auto">
        <table>
          <thead>
            <tr>
              <th>Call</th>
              <th>What it does</th>
              <th>Public on chain</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <code>openStarknetAccount</code>
              </td>
              <td>Opens private account <code>index</code> from a wallet&apos;s signature or a 32-byte seed, as the app does</td>
              <td>Nothing</td>
            </tr>
            <tr>
              <td>
                <code>registerStarknetAccount</code>
              </td>
              <td>The relay deploys it, then one proof registers its viewing key and opens its own channel. Free, capped</td>
              <td>The account</td>
            </tr>
            <tr>
              <td>
                <code>addToStarknetPrivate</code>
              </td>
              <td>Makes what sits at the account&apos;s address private, Gloam&apos;s fee inside</td>
              <td>The account and the amount</td>
            </tr>
            <tr>
              <td>
                <code>payStarknetPrivately</code>, <code>payStarknetMany</code>
              </td>
              <td>Pays one or many Gloam private accounts, one proof</td>
              <td>A first payment: the payee&apos;s account</td>
            </tr>
            <tr>
              <td>
                <code>cashOutStarknet</code>
              </td>
              <td>Cash out to any Starknet address</td>
              <td>The destination and the amount</td>
            </tr>
            <tr>
              <td>
                <code>makeStarknetClaimLink</code>, <code>claimStarknetLink</code>
              </td>
              <td>The app&apos;s <code>/c#sn=</code> links: kept first, then paid; claimed once</td>
              <td>The link&apos;s one-time account, then the claimer&apos;s</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p>
        Errors are typed and come before anything is proven or sent:{" "}
        <code>StarknetOffError</code> (Starknet isn&apos;t open on that server,
        or the relay sends no moves), <code>StarknetBusyError</code> (code{" "}
        <code>quota</code> when the day&apos;s proofs are used, or a rate limit
        or pause), <code>StarknetFeeChangedError</code> (the fee changed since
        the account read it, or is above <code>maxFee</code>) and{" "}
        <code>StarknetInsufficientError</code>. On mainnet the SDK proves only
        into Starknet&apos;s canonical pool. More in the{" "}
        <a href="https://github.com/gloamtrade/gloam/tree/main/packages/sdk#starknet-not-open-yet">SDK readme</a>.
      </p>

      <h2 id="mcp">MCP tools</h2>
      <p>
        <code>@gloamtrade/mcp</code> from 0.12.0 has the{" "}
        <code>gloam_starknet_*</code> tools. The agent&apos;s EVM key (
        <code>GLOAM_AGENT_PRIVATE_KEY</code>) opens the same private Starknet
        account the app opens for that wallet. Spending limits name the network{" "}
        <code>starknet-mainnet</code>, and a payment or cash out counts its
        amount and Gloam&apos;s fee.
      </p>
      <div className="overflow-x-auto">
        <table>
          <thead>
            <tr>
              <th>Tool</th>
              <th>Does</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <code>gloam_starknet_info</code> / <code>gloam_starknet_balance</code>
              </td>
              <td>What Starknet hides and shows, the relay and its fee, the agent&apos;s account and balance (read)</td>
            </tr>
            <tr>
              <td>
                <code>gloam_starknet_register</code>
              </td>
              <td>Puts the agent&apos;s account on chain and opens it, once. The relay pays</td>
            </tr>
            <tr>
              <td>
                <code>gloam_starknet_add</code>
              </td>
              <td>Makes USDC at the account&apos;s address private (limits tool <code>shield</code>)</td>
            </tr>
            <tr>
              <td>
                <code>gloam_starknet_pay</code> / <code>gloam_starknet_cash_out</code>
              </td>
              <td>Pays a Gloam private account, or cashes out to any Starknet address (limits tool <code>pay</code>)</td>
            </tr>
            <tr>
              <td>
                <code>gloam_starknet_tx_status</code>
              </td>
              <td>Accepted, reverted or pending (read)</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p>
        See <Link href="/docs/agents">agents</Link> for spending limits.
      </p>

      <h2 id="try">Try it</h2>
      <p>
        In the app, pick {STARKNET_DOCS_NAME} in the network menu, open your
        private account, then add, pay or cash out in the{" "}
        <AppLink href="/app/vault">Vault</AppLink>. See also{" "}
        <Link href="/docs/chain#starknet">networks</Link>.
      </p>
    </DocsLayout>
  );
}
