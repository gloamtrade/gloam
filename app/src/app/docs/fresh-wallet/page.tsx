import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { AppLink } from "@/components/AppLink";
import { DocsLayout } from "@/components/DocsLayout";
import { FRESH_WALLET_PATH } from "@/lib/gasStation";
import { FRESH_WALLET_ENABLED } from "@/lib/freshWalletFlag";

export const metadata: Metadata = {
  title: "Fund a fresh wallet for Borro",
  description:
    "Fund a new wallet from your private balance, with ETH for gas, and use Borro on Robinhood Chain without the position pointing to your main wallet. What stays private and what doesn't.",
};

export default function DocsFreshWalletPage() {
  // Off for now (lib/freshWalletFlag): the guide answers 404 until the flag is "1".
  if (!FRESH_WALLET_ENABLED) notFound();
  return (
    <DocsLayout
      title="Fund a fresh wallet for Borro"
      lede="Borro is a stock lending market on Robinhood Chain. Fund a new wallet from your private balance and open your short or loan from there. The position is public. It just doesn't point to your main wallet."
      glance={[
        { label: "Network", value: "Robinhood Chain mainnet" },
        { label: "You need", value: "A private USDG balance" },
        { label: "Gas", value: "Borro's gas station" },
        { label: "The position", value: "Public" },
      ]}
    >
      <h2 id="steps">The steps</h2>
      <ol>
        <li>
          Open <AppLink href={FRESH_WALLET_PATH}>Fund a fresh wallet</AppLink> and paste a new address you control, or
          make one there. A key made there stays in your browser and is shown once, so save it before you go on. Use a
          plain wallet: the relay won&apos;t pay gas for a contract.
        </li>
        <li>Choose how much USDG the wallet gets, how much to turn into gas, and when it goes.</li>
        <li>
          Gloam makes two cash outs: gas money to the wallet&apos;s gas station, and your USDG to the wallet. Sent now, the
          gas money lands first. Spread over a window, each lands at its own time, so either can come first. A wallet that
          already has gas can skip the gas money.
        </li>
        <li>
          Press <strong>Turn it into ETH</strong> once the gas money lands. ETH arrives in the fresh wallet.
        </li>
        <li>
          Open <a href="https://borro.markets">Borro</a> with the fresh wallet connected, not your main one, and open
          your position.
        </li>
        <li>When you&apos;re done, send what&apos;s left back into your private balance.</li>
      </ol>
      <p>
        If you leave part way, paste the same address again. The page reads where the wallet stands from the chain and
        goes on from there.
      </p>

      <h2 id="gas">Why gas takes its own step</h2>
      <p>
        A fresh wallet has no ETH, and topping it up from your main wallet would link the two. Borro&apos;s gas station
        solves that. Each wallet has its own station at an address known before it exists. USDG sent there waits until
        the station is made, then it is swapped for ETH and sent to the wallet.
      </p>
      <p>
        A station can only ever pay its one wallet. The swap is meant for gas, so send what you need for gas and no more.
        At today&apos;s gas prices a dollar covers several positions opened and closed. The most one relayed swap takes is
        5 USDG. If the chain&apos;s ETH price feed stops updating, the swap waits. After
        about four days without an update, anyone can send the station&apos;s USDG to its wallet as USDG instead. The
        app doesn&apos;t do that step for you yet.
      </p>
      <p>
        Making the station and swapping cost gas, and the fresh wallet has none, so the Gloam relay pays for those two
        calls. It does nothing else for the wallet, and it only acts once the station holds USDG.
      </p>

      <h2 id="public">What is public and what is private</h2>
      <div className="overflow-x-auto">
        <table>
          <thead>
            <tr>
              <th>Public</th>
              <th>Private</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>The position, its size and everything the fresh wallet does on Borro</td>
              <td>Which deposit the money came from</td>
            </tr>
            <tr>
              <td>The fresh wallet and its gas station</td>
              <td>Your other private balance and payments</td>
            </tr>
            <tr>
              <td>Each cash out&apos;s amount, destination and time</td>
              <td>Who the cash out belongs to, unless something else links it</td>
            </tr>
            <tr>
              <td>That the money came out of the Gloam vault</td>
              <td></td>
            </tr>
          </tbody>
        </table>
      </div>
      <p>
        This doesn&apos;t make the position private. It keeps the position from pointing to your main wallet, and only
        for as long as nothing else links the two.
      </p>

      <h2 id="links">What can still link your wallets</h2>
      <ul>
        <li>
          <strong>Amounts.</strong> A cash out that matches a recent deposit is easy to line up with it. Use a different
          amount, or a round one.
        </li>
        <li>
          <strong>Timing.</strong> Money that leaves right after it came in is easy to line up too. The flow can send each
          cash out at its own random time inside about an hour, 6 hours or a day. Longer is better, with one limit: each
          proof shows roughly when it was made, so the two can be grouped. While Gloam is open and on screen, with your vault
          unlocked, it remakes them, last shortly before each one goes. One that goes out at any other time shows when it was
          last made, so keep Gloam open and on screen, with your vault unlocked, until they have gone if timing matters.
        </li>
        <li>
          <strong>Your own moves.</strong> Sending from the fresh wallet to your main wallet, or to an exchange account in
          your name, links them for good.
        </li>
        <li>
          <strong>Your setup.</strong> A wallet app or RPC provider that sees both addresses from one device can connect
          them. Using the fresh wallet from a separate browser profile helps on Borro, but not on this page: Fund a fresh
          wallet reads the fresh wallet inside your main session, so that link exists for whoever runs the RPC.
        </li>
      </ul>

      <h2 id="costs">What it costs</h2>
      <p>
        Each of the two cash outs pays the normal cash-out fee, and the app shows it before you send. The swap at the
        station pays the pool&apos;s fee and any price difference, and it won&apos;t fill more than 1% under the price
        feed. The relay pays the gas for the station. What you do on Borro has its own costs, set by Borro.
      </p>

      <h2 id="back">Coming back</h2>
      <p>
        Fund a fresh wallet gives you a link that pays your own Gloam address. Open it in Gloam with the fresh wallet
        connected, add the USDG privately, and pay the link. Keep a little ETH in the wallet for this. The deposit is
        public, with its amount and the fresh wallet. The payment to you is private. Waiting before you pay yourself, and
        not paying the exact amount you deposited, keeps the two harder to line up.
      </p>

      <h2 id="borro">About Borro</h2>
      <p>
        Borro is a separate project with its own contracts, and Gloam doesn&apos;t run it. A short or a loan can be
        liquidated past its limit. Read <a href="https://borro.markets/security">Borro&apos;s own security page</a> and
        rules before you put money in.
      </p>

      <h2 id="link">Linking to this flow</h2>
      <p>
        An app can open the flow filled in with a wallet and an amount:{" "}
        <code>gloam.trade{FRESH_WALLET_PATH}#to=0x…&amp;amount=25</code>. Both stay in the fragment, which never reaches a
        server, and nothing moves until the person presses send.
      </p>

      <p>
        More on what shows on chain in <Link href="/docs/privacy-model">What stays private</Link>.
      </p>
    </DocsLayout>
  );
}
