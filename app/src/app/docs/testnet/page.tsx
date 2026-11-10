import type { Metadata } from "next";
import Link from "next/link";
import { AppLink } from "@/components/AppLink";
import { DocsLayout } from "@/components/DocsLayout";
import { FlowDiagram } from "@/components/docs/FlowDiagram";
import { FAUCET_BLURB, FAUCET_URL } from "@/lib/faucet";
import { baseSepoliaPool, ethereumSepoliaPool } from "@/lib/mainnet";
import { CIRCLE_FAUCET_URL, PAXOS_FAUCET_URL } from "@/lib/tokens";
import { swapMainnets } from "@/lib/vaultSwap";

/** Base Sepolia shows in the app once its pool is filled in (lib/mainnet.ts). */
const BASE_SEPOLIA_LIVE = baseSepoliaPool() !== null;
const CDP_FAUCET_URL = "https://portal.cdp.coinbase.com/products/faucet";
/** Ethereum Sepolia shows in the app once its pool is filled in (lib/mainnet.ts). */
const ETHEREUM_SEPOLIA_LIVE = ethereumSepoliaPool() !== null;
const GOOGLE_SEPOLIA_FAUCET_URL = "https://cloud.google.com/application/web3/faucet/ethereum/sepolia";
const POW_SEPOLIA_FAUCET_URL = "https://sepolia-faucet.pk910.de/";
import { ArrowUpRight } from "@/components/ui/ArrowUpRight";

export const metadata: Metadata = {
  title: "Practice on testnet",
  description:
    "Practice with Gloam on testnet before you use mainnet: wallet setup, faucet, shield, private pay, cash out, demo video, and troubleshooting on Robinhood Chain testnet, Tempo Moderato, Base Sepolia and Ethereum Sepolia.",
};

export default function DocsTestnetPage() {
  return (
    <DocsLayout
      title="Practice on testnet"
      lede="Testnet runs the same app and the same steps as mainnet. Try a deposit, a private payment and a cash out here first."
      glance={[
        { label: "App", value: "/app" },
        { label: "Chain ID", value: "46630" },
        { label: "Network", value: "Robinhood Chain testnet" },
        { label: "Vault", value: "Live, dev keys" },
        { label: "Keys", value: "Dev ceremony" },
        { label: "Value", value: "Test funds only" },
      ]}
      quickLinks={[
        { href: "/app", label: "Open the app" },
        { href: "/docs/chain", label: "Mainnet networks" },
        { href: "/docs/payroll", label: "Private payroll" },
        { href: "/docs/privacy-model", label: "Privacy model" },
        { href: "https://x.com/gloamtrade", label: "@gloamtrade" },
        { href: "mailto:hello@gloam.trade", label: "hello@gloam.trade" },
      ]}
    >
      <div className="rounded-[14px] bg-surface px-5 py-4 text-[14px] leading-relaxed text-mute">
        Robinhood Chain and Tempo testnet proofs use development keys; Base
        Sepolia and Ethereum Sepolia use the final keys, like mainnet. For
        mainnet, pick a network marked Mainnet in the app&apos;s network
        selector; mainnet uses the final keys from the 13-contributor ceremony. Test funds never move to
        mainnet. Network details:{" "}
        <Link href="/docs/chain">Networks</Link>.
      </div>

      <h2 id="demo">Demo video</h2>
      <p>
        X does not offer a site embed for posts, so the walkthrough opens in a
        new tab on X. Watch the demo, then follow the steps below on testnet.
      </p>
      <figure className="my-8 flex flex-wrap items-center justify-between gap-x-6 gap-y-4 rounded-[22px] border border-line p-5 sm:p-6">
        <span className="block min-w-0 max-w-[40ch]">
          <span className="t-label block">Demo on X</span>
          <span className="mt-2 block text-[16px] leading-snug tracking-[-0.01em] text-foreground">
            Shield, private pay and cash out, start to finish.
          </span>
          <span className="mt-1 block text-[13.5px] text-mute">
            Posted by the team. Opens in a new tab.
          </span>
        </span>
        <a
          href="https://x.com/dukedotsol/status/2077117792520634789"
          target="_blank"
          rel="noreferrer"
          className="btn btn-ghost btn-sm shrink-0 !border-line-strong hover:!border-foreground"
        >
          Watch the demo <ArrowUpRight />
        </a>
      </figure>
      <p>
        Also follow{" "}
        <a
          href="https://x.com/gloamtrade"
          target="_blank"
          rel="noreferrer"
        >
          @gloamtrade
        </a>{" "}
        for updates.
      </p>

      <h2 id="what-you-get">What you can do on testnet</h2>
      <FlowDiagram
        title="Core loop"
        steps={[
          {
            n: "1",
            title: "Connect",
            body: "Wallet on Robinhood Chain testnet (chain ID 46630).",
          },
          {
            n: "2",
            title: "Faucet",
            body: "Claim testnet ETH + sample stock tokens from the official faucet.",
          },
          {
            n: "3",
            title: "Shield",
            body: "Deposit into the Gloam vault. Commitment goes on-chain; amount is not a public balance on your address.",
          },
          {
            n: "4",
            title: "Private rails",
            body: "Private send (Move). Cash out only when you want a public exit.",
          },
          {
            n: "5",
            title: "Trade paths",
            body: "Private swaps are mainnet only. Via market needs a pool. Wallet path is fully public.",
          },
        ]}
      />

      <h2 id="before-you-start">Before you start</h2>
      <ul>
        <li>
          A browser wallet (MetaMask, Rabby, or similar) that can add custom
          EVM networks.
        </li>
        <li>
          Desktop or laptop recommended for first proofs (browser proving can
          take tens of seconds).
        </li>
        <li>
          Optional: second wallet or a friend to receive a private payment.
        </li>
        <li>
          Follow{" "}
          <a
            href="https://x.com/gloamtrade"
            target="_blank"
            rel="noreferrer"
          >
            @gloamtrade
          </a>{" "}
          for incidents and demo clips.
        </li>
      </ul>

      <h2 id="network">1. Add Robinhood Chain testnet</h2>
      <p>
        Open{" "}
        <AppLink href="/app">
          <strong>/app</strong>
        </AppLink>
       , pick <strong>Robinhood Chain testnet</strong> in the network
        selector, click <strong>Connect wallet</strong>, then use{" "}
        <strong>Switch to Robinhood Chain</strong> if the wallet is on the wrong
        chain. A wallet set to &quot;Robinhood Chain&quot; is often on mainnet
        (4663). The testnet is:
      </p>
      <ul>
        <li>
          <strong>Chain ID</strong>, <code>46630</code>
        </li>
        <li>
          <strong>Name</strong>, Robinhood Chain Testnet
        </li>
        <li>
          <strong>RPC</strong>, {" "}
          <code>https://rpc.testnet.chain.robinhood.com</code>
        </li>
        <li>
          <strong>Explorer</strong>, {" "}
          <a
            href="https://explorer.testnet.chain.robinhood.com"
            target="_blank"
            rel="noreferrer"
          >
            explorer.testnet.chain.robinhood.com
          </a>
        </li>
        <li>
          <strong>Native currency</strong>, test ETH
        </li>
      </ul>
      <p>
        Official chain docs:{" "}
        <a
          href="https://docs.robinhood.com/chain/"
          target="_blank"
          rel="noreferrer"
        >
          docs.robinhood.com/chain
        </a>
        . More network context:{" "}
        <Link href="/docs/chain">all networks in the Gloam docs</Link>.
      </p>

      <p>
        Gloam also runs on <strong>Tempo Moderato testnet</strong> (chain ID{" "}
        <code>42431</code>), where the shieldable asset is a stablecoin (PathUSD,
        6 decimals) instead of equities and gas is paid in a stablecoin rather
        than ETH. Switch chains with the network selector in the app header; the
        shield, private pay, cash out, and disclosure steps below are the same.
        Tempo params and integration notes live in the{" "}
        <Link href="/docs/chain">Networks doc</Link>.
      </p>

      <h3 id="base">Base Sepolia</h3>
      <p>
        {BASE_SEPOLIA_LIVE
          ? "Gloam also runs on Base Sepolia (chain ID 84532)."
          : "Base Sepolia (chain ID 84532) is next. It is not in the app yet; this is how it will work."}{" "}
        It is the testnet for Base, and it runs the mainnet vault: the
        final keys, its own deposit limits (500 USDC or EURC
        per deposit and 25,000 in total, 0.2 ETH per deposit and 10 in total)
        and a 0.25% cash-out fee (Base mainnet&apos;s is 0.5%), all on test funds. It takes test USDC, EURC
        and ETH; there is no USDT on Base Sepolia.
      </p>
      <ul>
        <li>
          <strong>RPC</strong>, <code>https://sepolia.base.org</code>
        </li>
        <li>
          <strong>Explorer</strong>,{" "}
          <a href="https://sepolia.basescan.org" target="_blank" rel="noreferrer">
            sepolia.basescan.org
          </a>
        </li>
        <li>
          <strong>Test USDC and EURC</strong>, from{" "}
          <a href={CIRCLE_FAUCET_URL} target="_blank" rel="noreferrer">
            Circle&apos;s faucet
          </a>
          : pick Base Sepolia and paste the address you use in Gloam.
        </li>
        <li>
          <strong>Test ETH for gas</strong>, from a Base Sepolia faucet such as{" "}
          <a href={CDP_FAUCET_URL} target="_blank" rel="noreferrer">
            Coinbase&apos;s
          </a>
          . A little is enough: Base gas costs a fraction of a cent.
        </li>
      </ul>

      <h3 id="ethereum">Ethereum Sepolia</h3>
      <p>
        {ETHEREUM_SEPOLIA_LIVE
          ? "Gloam also runs on Ethereum Sepolia (chain ID 11155111), Ethereum's testnet."
          : "Ethereum Sepolia (chain ID 11155111), Ethereum's testnet, is next. It is not in the app yet; this is how it will work."}{" "}
        Like Base Sepolia it runs the mainnet vault: the final keys, its
        own deposit limits (500 of each stablecoin per deposit and 25,000
        in total, 0.2 ETH per deposit and 10 in total) and a 0.25% cash-out
        fee (mainnet&apos;s is 0.5%). It takes test USDC, USDG, PYUSD, EURC and ETH; Tether issues no
        USDT on Sepolia.
      </p>
      <ul>
        <li>
          <strong>RPC</strong>, <code>https://ethereum-sepolia-rpc.publicnode.com</code>{" "}
          (most wallets list Sepolia already)
        </li>
        <li>
          <strong>Explorer</strong>,{" "}
          <a href="https://sepolia.etherscan.io" target="_blank" rel="noreferrer">
            sepolia.etherscan.io
          </a>
        </li>
        <li>
          <strong>Sepolia ETH for gas</strong>, from{" "}
          <a href={GOOGLE_SEPOLIA_FAUCET_URL} target="_blank" rel="noreferrer">
            Google Cloud&apos;s Web3 faucet
          </a>{" "}
          (sign in with a Google account) or the{" "}
          <a href={POW_SEPOLIA_FAUCET_URL} target="_blank" rel="noreferrer">
            Sepolia PoW faucet
          </a>{" "}
          (your browser mines for a few minutes, no account). Neither asks you
          to hold ETH on Ethereum mainnet first. Gas on Sepolia costs a tiny
          fraction of a cent, so a little lasts a long time.
        </li>
        <li>
          <strong>Test USDC and EURC</strong>, from{" "}
          <a href={CIRCLE_FAUCET_URL} target="_blank" rel="noreferrer">
            Circle&apos;s faucet
          </a>
          : pick Ethereum Sepolia and paste the address you use in Gloam.
        </li>
        <li>
          <strong>Test PYUSD and USDG</strong>, from{" "}
          <a href={PAXOS_FAUCET_URL} target="_blank" rel="noreferrer">
            Paxos&apos;s faucet
          </a>
          , on Ethereum Sepolia.
        </li>
      </ul>

      <h2 id="faucet">2. Get testnet funds (faucet)</h2>
      <p>{FAUCET_BLURB}</p>
      <ul>
        <li>
          Faucet:{" "}
          <a href={FAUCET_URL} target="_blank" rel="noreferrer">
            {FAUCET_URL}
          </a>
        </li>
        <li>Connect the same address you use in Gloam.</li>
        <li>
          Claim testnet ETH for gas and sample stock tokens (e.g. TSLA, AMZN
          test assets) when offered.
        </li>
        <li>Typical limit: once per 24 hours, plan your demo flow.</li>
        <li>
          For stablecoin payments and payroll, claim test USDG (Paxos Global
          Dollar) on Robinhood Chain testnet from{" "}
          <a href={PAXOS_FAUCET_URL} target="_blank" rel="noreferrer">
            the Paxos faucet
          </a>
          .
        </li>
      </ul>
      <p>
        After claiming, open <AppLink href="/app">Portfolio</AppLink> and confirm ETH
        + stock balances appear.
      </p>

      <h2 id="portfolio">3. Portfolio at a glance</h2>
      <p>
        <AppLink href="/app">/app</AppLink> shows:
      </p>
      <ul>
        <li>
          <strong>Open wallet</strong>, public balances on Robinhood Chain testnet.
        </li>
        <li>
          <strong>Vault (private)</strong>, notes you control locally after
          shield / private receive. Back up notes in Settings if prompted.
        </li>
        <li>
          <strong>Stocks / markets</strong>, discovery; not all pairs have deep
          DEX liquidity on testnet.
        </li>
      </ul>
      <p>
        Local notes live in the browser. Clearing site data can lose notes
        unless you exported a backup.
      </p>

      <h2 id="shield">4. Shield (deposit into the vault)</h2>
      <ol>
        <li>
          Go to <AppLink href="/app/vault?tab=shield">Shield</AppLink>.
        </li>
        <li>Pick ETH or a faucet stock token and a small amount.</li>
        <li>
          Confirm the wallet transaction. A <strong>Shielded</strong> event is
          written on-chain with a commitment (not your full private state).
        </li>
        <li>
          Wait for success. Portfolio vault balance updates; open wallet
          balance decreases.
        </li>
      </ol>
      <p>
        Details: <Link href="/docs/encryption">How shield works</Link> and{" "}
        <Link href="/docs/privacy-model">what stays private</Link>.
      </p>

      <h2 id="private-pay">5. Private pay (send inside the vault)</h2>
      <ol>
        <li>
          Open <AppLink href="/app/vault?tab=move">Move</AppLink> → private send.
        </li>
        <li>
          Choose a vault note and amount. Prefer leaving a small change note
          when the UI offers it.
        </li>
        <li>
          Generate or paste a receive tag / contact if the UI asks for a
          recipient package path.
        </li>
        <li>
          Browser builds a ZK proof (can take a while, keep the tab open).
        </li>
        <li>Confirm the on-chain transfer transaction.</li>
        <li>
          Share the <strong>payment ticket / package</strong> with the recipient
          off-app (or via the share UI). Optional passphrase lock if offered.
        </li>
        <li>
          Recipient: import the package in Move / receive flow so their vault
          shows the note.
        </li>
      </ol>
      <p>
        Deeper docs: <Link href="/docs/private-pay">Private pay</Link>.
      </p>

      <h2 id="cash-out">6. Cash out (unshield)</h2>
      <ol>
        <li>
          <AppLink href="/app/vault?tab=move">Move</AppLink> → cash out / unshield.
        </li>
        <li>Select a note and confirm.</li>
        <li>Wait for the browser proof, then confirm the wallet tx.</li>
        <li>
          Funds return to your open wallet on Robinhood Chain testnet. That edge is{" "}
          <strong>public</strong> (amount and destination appear on explorers).
        </li>
      </ol>

      <h2 id="trade">7. Trade paths</h2>
      <ul>
        <li>
          <strong>Private swaps</strong>, mainnet only. The testnets have no
          swap router, so there is no Swap tab here. Stock tokens can be held
          and sent privately. The old{" "}
          <Link href="/docs/sealed-trade">sealed trade</Link> is retired.
        </li>
        <li>
          <strong>Wallet</strong>, public swaps / transfers from the open
          wallet when a pool exists.
        </li>
        <li>
          <strong>Via market</strong>, cash out → public swap → re-shield. Size
          is public on the swap edge. Many faucet pairs have empty pools.
        </li>
      </ul>

      <h2 id="private-swaps">7b. Private swaps (mainnet)</h2>
      <p>
        Swapping from a private balance runs on {swapMainnets()}{" "}
        mainnet, under Vault &gt; Swap. Who swapped stays
        private; the tokens and amounts are public. How it works, what it costs
        and what shows: <Link href="/docs/private-swaps">private swaps</Link>.
      </p>

      <h2 id="settings">8. Settings & backups</h2>
      <ul>
        <li>
          <AppLink href="/app/settings">Settings</AppLink>, note backup (optional
          lock), trading prefs, diagnostics.
        </li>
        <li>
          Export / import before clearing cache or switching browsers.
        </li>
        <li>
          Robinhood Chain and Tempo testnet proofs use the dev keys, so they
          never check out on mainnet. Mainnet, Base Sepolia and Ethereum
          Sepolia proofs use the final keys from the 13-contributor ceremony. See the{" "}
          <Link href="/docs/production">production gate</Link>.
        </li>
      </ul>

      <h2 id="checklist">Practice checklist</h2>
      <ol>
        <li>Wallet on chain ID 46630</li>
        <li>Faucet ETH (+ stocks if needed)</li>
        <li>Shield a small amount of ETH</li>
        <li>Private send to yourself or a friend + import package</li>
        <li>Optional: cash out dust once (public amount, intentional)</li>
        <li>Export note backup (Settings)</li>
        <li>
          Ready for mainnet? Pick one in the network selector and start
          small. Deposit limits cap each deposit (see{" "}
          <Link href="/docs/chain#mainnet">Networks</Link>).
        </li>
        <li>
          Report bugs to <a href="mailto:hello@gloam.trade">hello@gloam.trade</a> or{" "}
          <a
            href="https://x.com/gloamtrade"
            target="_blank"
            rel="noreferrer"
          >
            @gloamtrade
          </a>{" "}
          (include explorer tx hash, not seed phrases)
        </li>
      </ol>

      <h2 id="troubleshooting">Troubleshooting</h2>
      <ul>
        <li>
          <strong>Wrong network</strong>, pick Robinhood Chain testnet in the
          network selector and use Switch to Robinhood Chain; chain ID must be
          46630 (4663 is mainnet).
        </li>
        <li>
          <strong>Proof stuck / failed</strong>, reload, try a smaller note,
          use a stronger machine, ensure only one tab is proving.
        </li>
        <li>
          <strong>Root / tree mismatch</strong>, wait a few seconds and retry;
          another user may have inserted leaves. Refresh the app.
        </li>
        <li>
          <strong>No vault balance after shield</strong>, confirm tx success on
          explorer; hard-refresh; check you did not clear site data mid-flow.
        </li>
        <li>
          <strong>Payment not showing for recipient</strong>, they must import
          the package; sender still has spent nullifier so resending the same
          note fails.
        </li>
        <li>
          <strong>No DEX pool for stock</strong>, testnet liquidity is thin;
          use ETH pairs.
        </li>
        <li>
          <strong>RPC rate limits</strong>, wait and retry; public RH RPC is
          shared.
        </li>
      </ul>

      <h2 id="safety">Safety & non-claims</h2>
      <ul>
        <li>No investment advice.</li>
        <li>
          Privacy tools reduce public visibility; they do not make you invisible
          to law enforcement or fix bad OPSEC.
        </li>
        <li>
          Shield / unshield edges are visible on explorers. Internal transfers
          depend on anonymity set size.
        </li>
      </ul>

      <h2 id="next">Read next</h2>
      <ul>
        <li>
          <AppLink href="/app">Open the app</AppLink>
        </li>
        <li>
          <Link href="/docs/chain">Networks: mainnet and testnet</Link>
        </li>
        <li>
          <Link href="/docs/encryption">How shield works</Link>
        </li>
        <li>
          <Link href="/docs/private-pay">Private pay</Link>
        </li>
        <li>
          <Link href="/docs/privacy-model">What stays private</Link>
        </li>
        <li>
          <Link href="/docs/product">What ships when</Link>
        </li>
        <li>
          <Link href="/whitepaper">Whitepaper</Link>
        </li>
      </ul>
    </DocsLayout>
  );
}
