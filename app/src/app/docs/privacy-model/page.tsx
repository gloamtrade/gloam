import type { Metadata } from "next";
import Link from "next/link";
import { AppLink } from "@/components/AppLink";
import { DocsLayout } from "@/components/DocsLayout";
import { FlowDiagram } from "@/components/docs/FlowDiagram";
import { liveMainnetNames } from "@/lib/mainnet";
import { SCREEN_LIST_INFO } from "@/lib/screening";
import { swapMainnets } from "@/lib/vaultSwap";

export const metadata: Metadata = {
  title: "What stays private",
  description:
    "The honest privacy model for Gloam: what an explorer still shows, what stays hidden, how strong the anonymity set is, and what we will not promise.",
};

export default function DocsPrivacyPage() {
  return (
    <DocsLayout
      title="What stays private"
      lede={`${liveMainnetNames()} are public ledgers. Gloam adds a shielded pool on top. Privacy here means unlinkability and hidden holdings, not that transactions vanish from the explorer. Here is exactly what that does and does not hide.`}
      glance={[
        { label: "Hidden", value: "the link, the bag" },
        { label: "Public", value: "deposits + exits" },
        { label: "Anon set", value: "more users = stronger" },
        { label: "Private swaps", value: "who is hidden, amounts public" },
      ]}
    >
      <FlowDiagram
        title="At a glance"
        steps={[
          {
            n: "✓",
            title: "In the vault",
            body: "While value sits in a note, your public wallet no longer shows it. Your holdings inside the pool are hidden.",
          },
          {
            n: "✓",
            title: "Private send (live)",
            body: "Pay inside the vault. The chain sees a transfer proof and two new commitments, not who paid whom or how much.",
          },
          {
            n: "✓",
            title: "Selective disclosure (live)",
            body: "Prove one balance to one party you choose, revealing nothing else.",
          },
          {
            n: "!",
            title: "Enter and exit are public",
            body: "Shield (deposit) and cash out (unshield) are ordinary public transactions. The amount and address are visible.",
          },
          {
            n: "!",
            title: "Private swaps (mainnet)",
            body: `Swap from your private balance on ${swapMainnets()} mainnet. Who swapped stays private. The tokens and amounts show, like any DEX trade.`,
          },
          {
            n: "!",
            title: "Anonymity set",
            body: "Unlinkability is only as strong as the crowd of notes to hide among. The mainnet pools are new, and on a near-empty pool an exit is traceable to your deposit.",
          },
        ]}
      />

      <h2>What an explorer actually shows</h2>
      <p>
        This is the part people get wrong, so it is worth stating plainly. Put
        your own address into the block explorer and you will find your shield
        deposit: a public transaction from your wallet, into the pool, for the
        exact amount, and its <code>Shielded</code> event carries your address,
        the amount, and the note commitment together. Nothing about the deposit
        is hidden.
      </p>
      <p>
        The <strong>commitment</strong> is a Poseidon hash (a 32-byte value). If
        you paste it into the explorer search you get nothing back, because it is
        not a transaction or an address, just a leaf in the pool&apos;s Merkle
        tree. Querying the contract returns only{" "}
        <code>commitmentSeen(commitment) == true</code>. The hash reveals no
        amount, no secret, and no owner on its own.
      </p>
      <p>
        The privacy is on the <strong>spend</strong>. When you later send or cash
        out, the zero-knowledge proof shows that you own <em>some</em> note in the
        tree and publishes a nullifier, without revealing <em>which</em> note. So
        a withdrawal to a fresh address, or a private send, cannot be linked back
        to your deposit. That unlinkability is the product.
      </p>

      <h2>What stays hidden</h2>
      <ul>
        <li>The link between your deposit and any later spend or exit</li>
        <li>How much you hold while it is in the vault</li>
        <li>Who paid whom, and how much, on a private send (live on mainnet and testnet)</li>
        <li>
          Who made a private swap, which balance it came from, and where the
          output goes next (mainnet)
        </li>
      </ul>

      <h2>What the public still sees</h2>
      <ul>
        <li>Each shield deposit: your address, the asset, and the amount</li>
        <li>Each cash out: the asset, the amount, and the destination address</li>
        <li>
          Each private swap: the two tokens and the two amounts. A swap the
          same size as a recent deposit, or a cash out the same size as a
          swap&apos;s output, is easy to match. See{" "}
          <Link href="/docs/private-swaps#tips">private swaps</Link>
        </li>
        <li>That the pool was used, the caller of each transaction, and timing</li>
        <li>Every commitment and nullifier as opaque hashes, plus the pool total</li>
      </ul>

      <h2>The anonymity set is the whole game</h2>
      <p>
        A shielded pool hides you in a crowd. If you are the only note of your
        size, an exit of that size is trivially yours. The mainnet pools are
        brand new, so their crowd is thin at first, and the testnet pools are
        small too. Treat unlinkability as weak until they fill up. This is true
        of every shielded pool, Gloam included. We would rather say it than let you
        assume more privacy than you have.
      </p>

      <h2>Making a cash out harder to link</h2>
      <p>
        A cash out is public, so the easiest way to link one to you is its
        size, its timing and where it goes. The cash out screen lets you change
        all three:
      </p>
      <ul>
        <li>
          <strong>A different amount.</strong> Cash out part of a balance, not
          the exact sum that came in. The app first sets that part aside in its
          own private note, then cashes it out. It says so when the amount sits
          within 1% of money you added or were paid in the last 30 days, or when
          you added money in the last few hours. It only reads this
          browser&apos;s own history.
        </li>
        <li>
          <strong>Later.</strong> Within an hour, 6 hours or a day, at a random
          time inside the window. The proof is made in your browser at once and
          the relay sends it then. The proof binds the amount and the recipient,
          so the relay can only send it as it is or not at all. The vault
          accepts the proof however long it waits, and takes its fee when it
          lands, at the rate that day. If the relay can&apos;t send it, nothing
          moves and the money shows in your balance again. Once it
          starts going out it can&apos;t be cancelled, and it shows as on its
          way until the network settles it.
        </li>
        <li>
          <strong>In pieces.</strong> A cash out arrives at once by default.
          For a stablecoin above 5 you can switch on Privately: 2 to 4 pieces
          of ordinary sizes, none matching money you added or were paid
          recently, each sent later at its own random time. The app suggests
          it when an amount matches money you added. Pieces that all land at
          one address can still be added up there, so a busy address (an
          exchange deposit address, say) or a different address for each
          piece hides more.
        </li>
        <li>
          <strong>Another address.</strong> A fresh wallet that never deposited
          is best. The app warns when the address is the connected wallet or
          one that deposited.
        </li>
      </ul>
      <p>
        <strong>What a waiting proof shows.</strong> Sending later hides when
        you asked for the cash out, but not entirely. Every proof is made
        against the vault&apos;s root at that moment, and the vault keeps every
        root, so anyone who rebuilds the tree can tell roughly when a proof was
        made. Cash outs proven together, like the pieces of one cash out, can
        be grouped that way, and one proven right after a deposit points back
        at it. While the app is open, Gloam makes a fresh proof of each waiting
        cash out and swaps it in on the relay, with the same recipient, amount
        and send time. It does this now and then, and once more shortly before
        each one goes out. A cash out that goes out while the app is closed
        keeps the root from when its proof was last made, so leaving the app
        open until it goes hides the most.
      </p>

      <h2>What we will not promise</h2>
      <ul>
        <li>Invisibility from law, courts, or a subpoena</li>
        <li>Privacy once you cash out to a public address</li>
        <li>Safety if your device or browser is compromised</li>
        <li>Strong anonymity while the pool has few users</li>
        <li>Recovery if you lose a note secret</li>
      </ul>

      <h2>Private from the public, not from an operator</h2>
      <p>
        Some chains offer privacy through operator-run environments, for example
        Tempo Zones, where a designated operator sees every transaction inside
        the zone and only the wider public is kept out. Gloam is a different
        model. It is a self-custodial shielded pool with no operator in the
        middle: only you hold the note secret, and only a party you choose sees a
        balance, through selective disclosure. When Gloam settles a private agent
        payment over x402, the payer and the payee learn the amount and no one
        else does. Where a regulated asset needs oversight, compliance visibility
        is opt-in per payment through an issuer-scoped disclosure, never a
        standing view handed to an operator. For how this compares with Zama,
        Arcium, Tempo Zones and others, see{" "}
        <Link href="/docs/compare">how Gloam compares</Link>.
      </p>

      <h2 id="counting-people">How we count people</h2>
      <p>
        To see how many people use Gloam, the app sends our server your
        connected address and which kinds of thing you did, such as claiming a
        payment or sending privately. Those go a few minutes after they happen,
        together, so the request never lines up with a payment. The server
        turns the address into a one-way code with a secret key (HMAC-SHA256)
        and adds the code to a HyperLogLog: a counter that keeps registers, not
        the codes it was given. It can say about how many different wallets it
        has seen, and no list of them exists. No address is stored, and no
        count is tied to a payment, an amount or a claim code.
      </p>
      <p>
        Two honest limits. Our server sees the address while it makes the code,
        as it does when it screens a deposit or a cash out. And someone holding
        both the secret key and the counters could check whether a wallet they
        already know is probably in them, in all, for one kind of action or on
        one day. The key lives only on our server, and a day is the finest
        grain kept.
      </p>

      <h2 id="whats-new">What is new and what is not</h2>
      <p>
        Gloam is not new cryptography. It is a new building block for finance:
        private payments you can prove. Here is exactly where the line sits.
      </p>
      <h3>Not new</h3>
      <ul>
        <li>
          <strong>The private pool design.</strong> Notes, nullifiers and a
          Merkle tree come from the Zcash lineage, starting in 2016. Tornado,
          Railgun and Cloak use the same pattern.
        </li>
        <li>
          <strong>Selective disclosure as an idea.</strong> Zcash and Railgun
          viewing keys, Privacy Pools, and Zama decryption rights all let a
          holder show something to someone.
        </li>
      </ul>
      <h3>New, as far as our research found</h3>
      <ol>
        <li>
          <strong>Payroll total proof.</strong> It proves a run of up to 32
          payments adds up to exactly a total, all funded by the prover, without showing who got what. We found nothing
          like it. See <Link href="/docs/proofs#payroll-total">payroll total</Link>.
        </li>
        <li>
          <strong>Proofs scoped to one reader.</strong> Who the proof is for (a
          label), when it expires, the chain and the pool are hashed into one
          public <code>context</code> input that is bound into the proof, in the{" "}
          <code>solvency</code>, <code>receipt</code> and{" "}
          <code>payroll_total</code> circuits. Change the label and the proof
          fails. Anyone can check it in a browser, with no wallet, at{" "}
          <Link href="/verify">/verify</Link>. Viewing keys, the usual
          alternative, show your whole history and cannot be taken back.
        </li>
        <li>
          <strong>Private payments for AI agents.</strong> A private payment
          method proposed for the Machine Payments Protocol from Tempo and
          Stripe (
          <a href="https://github.com/tempoxyz/mpp-specs/pull/376" target="_blank" rel="noreferrer">
            tempoxyz/mpp-specs#376
          </a>
          ; MPP had no private method), private x402 payments, and an MCP server
          that gives agents handles instead of secrets, with spending limits.
          See <Link href="/docs/agents">agents</Link>.
        </li>
      </ol>
      <p>
        <strong>Honest limit.</strong> A reader can still forward a proof. It
        will say who it was made for and when it expires, but nothing stops the
        forwarding itself. A designated-verifier mode, where only the named
        reader can be convinced, is next.
      </p>

      <h2 id="security">Security and compliance</h2>
      <h3>Passkey lock (optional)</h3>
      <p>
        Your notes, and the key that opens payments to your Gloam address, are
        encrypted at rest in this browser under a device key. In{" "}
        <AppLink href="/app/settings">Settings</AppLink> you can protect that key with
        a passkey: Face ID, Touch ID or a security key. Gloam asks
        the passkey for a secret only it can produce (the WebAuthn PRF
        extension), uses it to wrap the key, and stores only the wrapped copy.
        Each time you open the app, the passkey unlocks it. There is no server
        or account behind this, and removing the passkey asks for it first.
      </p>
      <p>
        Backups are separate. A backup holds your balances themselves, so
        restoring one needs only the backup, plus its passphrase if you set one,
        on any browser. It never needs the passkey. If you lose the passkey, a
        backup is the only way back. Browsers or passkeys without PRF support
        keep the device key, unchanged.
      </p>
      <h3>Sanctions screening</h3>
      <p>
        Before a deposit, and before the relay submits a cash out, Gloam checks
        the public addresses involved against the OFAC list of sanctioned digital
        currency addresses: the wallet that deposits, and the address a cash out
        pays. Nothing private is screened. Notes, receive tags, amounts and
        private sends are never looked at.
      </p>
      <ul>
        <li>
          <strong>Against what:</strong> a snapshot of the EVM addresses in the{" "}
          <a href={SCREEN_LIST_INFO.source} target="_blank" rel="noreferrer">
            0xB10C OFAC list
          </a>
          , built from the OFAC SDN list. It ships with the app with its source
          commit and date (snapshot of {SCREEN_LIST_INFO.snapshotDate},{" "}
          {SCREEN_LIST_INFO.count} addresses) and is refreshed by a script, so it
          can lag the official list until the next refresh.
        </li>
        <li>
          <strong>When:</strong> in the app before your wallet signs a deposit,
          on the server at <code>/api/screen</code>, and inside the relay before
          it checks or sends anything.
        </li>
        <li>
          <strong>What you see:</strong> a blocked wallet gets one neutral
          message, &quot;This wallet can&apos;t use Gloam.&quot;, and nothing
          more.
        </li>
        <li>
          <strong>Optional:</strong> an operator can add the Chainalysis free
          sanctions API by setting <code>CHAINALYSIS_API_KEY</code> on the server.
        </li>
      </ul>
      <p>
        Screening lives in the app and the relay, not in the vault contract, which
        stays permissionless.
      </p>
      <h3>Stablecoin issuer policies on Tempo (TIP-403)</h3>
      <p>
        Every stablecoin on Tempo points at a transfer policy in Tempo&apos;s
        TIP-403 registry: open to all, closed to all, the issuer&apos;s allowlist
        or blocklist, or separate lists for senders and recipients. The token
        checks it on every transfer. Gloam respects it at the two places value
        meets a public wallet: a deposit is a transfer from your wallet into the
        vault, and a cash out is a transfer from the vault to a public address.
      </p>
      <ul>
        <li>
          <strong>Deposit:</strong> your wallet must be allowed to send the
          stablecoin, and the vault must be allowed to receive it.
        </li>
        <li>
          <strong>Cash out:</strong> the vault must be allowed to send it, and
          the destination must be allowed to receive it. If the destination&apos;s
          own Tempo receive policy would refuse the payment, Gloam says so instead
          of letting it be held. If that policy can&apos;t be read, the relay sends
          nothing and asks you to try again.
        </li>
        <li>
          <strong>When:</strong> next to sanctions screening, in the app before
          your wallet signs, at <code>/api/screen</code>, and inside the relay.
          These are read-only calls to the chain. A wallet the issuer does not
          allow sees the same neutral message.
        </li>
        <li>
          <strong>Private sends</strong> move no tokens, so the policy never
          sees them, and nothing private is read.
        </li>
        <li>
          <strong>Private swaps</strong>{" "}
          do move tokens: from the vault to the
          swap&apos;s escrow and router, through Tempo&apos;s stablecoin
          exchange, and back into the vault. The token checks its policy on
          each of those transfers, and if one is refused the whole swap
          reverts.
        </li>
      </ul>
      <p>
        The token enforces its policy on-chain whatever Gloam does. That makes
        this compliant privacy with no operator: the issuer keeps its controls
        at the public edges, nobody sees inside the vault, and there is no
        Gloam operator in between. As of October 2026 on Tempo Moderato, OUSD
        and PathUSD both use policy 1, open to all.
      </p>
      <p>
        <strong>Issuer freeze risk.</strong> An issuer can also pause its
        stablecoin, or set a policy that stops the vault itself from sending it.
        Then no balance in that stablecoin can be cashed out until the issuer
        lifts it, and nobody, the Gloam team included, can move it out another
        way. The app reads the vault&apos;s standing for each stablecoin, shows
        it as &quot;Issuer policy&quot; in the &quot;What the explorer
        shows&quot; card, and warns before you deposit or cash out if the vault
        is blocked.
      </p>
      <h3>No admin withdraw</h3>
      <p>
        Nobody, including the Gloam team, can move pooled funds. The vault has no
        withdraw function for its owner: money leaves only through a cash out
        that carries a valid proof.
      </p>
      <h3>Timelock on rule changes</h3>
      <p>
        After setup, every change to how proofs, rates or prices are checked is
        queued on-chain and can only take effect three days later, in public.
      </p>
      <h3>Relay limits</h3>
      <p>
        The relay submits only the vault&apos;s private send and cash out,
        private swaps through the swap routers, and the payment message board.
        It dry-runs every call first, cannot change a cash out&apos;s recipient
        or amount (both are bound in the proof), cannot change what a swap
        delivers or where (the escrow address binds it), and rate limits each
        device and each network. A cash out scheduled for
        later is kept as the proof and its public inputs, never a secret, and
        is dropped once it is sent, cancelled or can no longer go out. While it
        waits, the app can swap its proof for a fresher one of the same cash
        out: the relay takes it only for the same balance, recipient, amount
        and asset, more than a minute before the send time, after the same dry
        run, and nothing else about the cash out changes.
      </p>

      <h2>Before you use mainnet</h2>
      <p>
        These are the honest gaps to know about first:
      </p>
      <ul>
        <li>
          <strong>Final keys on mainnet, dev keys on testnet.</strong> The
          multi-party trusted setup closed on 17 October with 13 contributors,
          and mainnet uses its final keys, as do Base Sepolia and Ethereum
          Sepolia. The Robinhood Chain and Tempo testnet setup had a single
          contributor, so testnet is for practice only.
        </li>
        <li>
          <strong>External review covers the vault only.</strong> Kann Audits reviewed the vault
          contracts (<Link href="/security">report, 1 November 2026</Link>) and found no Critical, High or Medium issues.
          The swap routers, circuits, app and relay were not part of it. Before
          that came several internal rounds, with fixes deployed, and a review
          before launch that finished on 20 October with no Critical or High
          findings open. Deposit limits cap how much each pool can hold: 50,000 per
          deposit and 2,500,000 in total for each stablecoin, and 2,500,000 per
          deposit and 25,000,000 in total for $GLOAM.
        </li>
        <li>
          <strong>A payer can take back a payment until it is claimed.</strong>{" "}
          The payer creates the payment, so they know its key too. Claiming moves
          it into a new note only the payee knows, and after that the payer can no
          longer touch it.
        </li>
        <li>
          <strong>Thin anonymity set.</strong> The mainnet pools are new, so
          there are few notes to hide among at first, and unlinkability is weak
          for now.
        </li>
        <li>
          <strong>Issuer freeze.</strong> A stablecoin issuer can freeze the
          vault contract. Our answer is to screen deposits so flagged funds
          never enter.
        </li>
        <li>
          <strong>Private swaps show their amounts.</strong> Who swapped stays
          private, but the tokens and amounts are public. If someone breaks a
          swap on purpose, 99% of the note comes back as a refund. The old
          sealed trade is retired.
        </li>
      </ul>
      <p>
        See <Link href="/docs/production">the production gate</Link> for the full
        list, and the <Link href="/docs/threat-model">threat model</Link> for who can
        do what. More detail: <Link href="/docs/encryption">How shield works</Link>{" "}
        and the <Link href="/whitepaper">whitepaper</Link>.
      </p>
    </DocsLayout>
  );
}
