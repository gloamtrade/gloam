import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import { DocsLayout } from "@/components/DocsLayout";
import { FlowDiagram } from "@/components/docs/FlowDiagram";
import { liveMainnetNames } from "@/lib/mainnet";

/** The mainnets with a pool in, as words: Base and Ethereum join once theirs are (lib/mainnet.ts). */
const MAINNETS = liveMainnetNames();

/** Nullmask's own pages and audit report, checked on 25 and 26 October 2026. */
const NM = {
  privacyPolicy: "https://app.nullmask.io/privacy",
  terms: "https://app.nullmask.io/terms",
  docsPrivacy: "https://nullmask.io/docs/privacy",
  docsSecurity: "https://nullmask.io/docs/security",
  docsStart: "https://nullmask.io/docs/getting-started",
  docsNetworks: "https://nullmask.io/docs/networks",
  docsFees: "https://nullmask.io/docs/fees",
  docsGas: "https://nullmask.io/docs/gas",
  docsChecks: "https://nullmask.io/docs/deposit-checks",
  docsSend: "https://nullmask.io/docs/send",
  audits: "https://github.com/nullmask-io/contract-audits",
};

function Src({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  );
}

export const metadata: Metadata = {
  title: "How Gloam compares",
  alternates: { canonical: "/docs/compare" },
  description:
    "Why a payment needs no key holder, and how Gloam compares with Zama, Arcium, Tempo Zones, Helius Privacy, Railgun and Nullmask: who can see your payments, what a breach exposes, and where each one wins.",
};

export default function DocsComparePage() {
  return (
    <DocsLayout
      title="How Gloam compares"
      lede="Privacy onchain splits into two jobs. Some apps share secrets between many people. A payment has one owner. Gloam does the second job, and that choice decides who can see your money."
      glance={[
        { label: "Who holds a key", value: "only you" },
        { label: "Proofs made", value: "on your device" },
        { label: "Networks", value: `${MAINNETS} (mainnet)` },
        { label: "New cryptography", value: "none, by design" },
      ]}
      quickLinks={[
        { href: "/docs/privacy-model", label: "What stays private" },
        { href: "/docs/proofs", label: "Proofs" },
        { href: "/docs/production", label: "Production gate" },
        { href: "/whitepaper", label: "Whitepaper" },
      ]}
    >
      <h2 id="two-jobs">Two jobs, two kinds of privacy</h2>
      <p>
        A sealed auction, a private order book or a lending pool has to work on
        many people&apos;s hidden data at once. Somebody has to do that work.
        So FHE networks like Zama and MPC networks like Arcium use a committee
        of nodes that hold the keys together.
      </p>
      <p>
        A payment is different. It has one owner. The owner can prove the
        payment is valid on their own device with a zero-knowledge proof, and
        nobody else ever holds a key. That is the job Gloam does.
      </p>

      <FlowDiagram
        title="Who holds the key"
        steps={[
          {
            n: "A",
            title: "Committee model",
            body: "Zama, Arcium, Tempo Zones. A committee or an operator holds the key, or sees inside.",
          },
          {
            n: "B",
            title: "Owner model",
            body: "Gloam. Your device makes the proof. Nobody else holds a key, including us.",
          },
        ]}
      />

      <h2 id="breach">What a breach exposes</h2>
      <p>
        If a committee or an operator is breached, everyone who used it can be
        exposed, past payments included. If one owner&apos;s device is
        breached, one person is exposed. That is the whole argument for doing
        payments the owner way.
      </p>
      <p>
        It also means Gloam never needs your secrets on a server. Proofs are
        made on your device, never on our servers.
      </p>

      <h2 id="not-new-cryptography">Not new cryptography</h2>
      <p>
        Gloam does not invent new maths. It uses the zero-knowledge proofs of
        the Zcash lineage: notes, nullifiers, a Merkle tree and Groth16 proofs.
        Then it builds the payments product on top, the way Stripe built on
        card networks. What is new is the product layer. See{" "}
        <Link href="/docs/privacy-model#whats-new">what is new and what is not</Link>.
      </p>

      <h2 id="table">Side by side</h2>
      <p>
        &quot;Not found&quot; means we did not find it in their public docs as
        of October 2026. It does not mean it cannot be built.
      </p>
      <div className="overflow-x-auto">
        <table className="min-w-[920px] [&_th]:whitespace-normal">
          <thead>
            <tr>
              <th>Product</th>
              <th>Who can see your payments</th>
              <th>If they are hacked</th>
              <th>Live on Tempo or Robinhood Chain</th>
              <th>Prove one fact to one person</th>
              <th>Private payroll</th>
              <th>Agent payments</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <strong>Gloam</strong>
              </td>
              <td>Only you</td>
              <td>One person is exposed</td>
              <td>Yes, mainnet on both</td>
              <td>Yes, a proof for one reader that expires</td>
              <td>Yes, with a payroll total proof</td>
              <td>Yes: x402, an MPP method, MCP</td>
            </tr>
            <tr>
              <td>Zama</td>
              <td>A 13-node committee shares one global key</td>
              <td>Everyone, past data included</td>
              <td>Not found</td>
              <td>Decryption rights for a value</td>
              <td>Not found</td>
              <td>Not found</td>
            </tr>
            <tr>
              <td>Arcium</td>
              <td>A node cluster, private while one node stays honest</td>
              <td>Everyone on that cluster, if every node falls</td>
              <td>Not found (Solana)</td>
              <td>Not found</td>
              <td>Not found</td>
              <td>Not found</td>
            </tr>
            <tr>
              <td>Tempo Zones</td>
              <td>The zone operator sees everything in the zone</td>
              <td>Everyone in the zone</td>
              <td>Tempo, limited preview</td>
              <td>Not found</td>
              <td>Not found</td>
              <td>Not found</td>
            </tr>
            <tr>
              <td>Helius Privacy</td>
              <td>Helius&apos;s server receives the full secret inputs, amounts included</td>
              <td>Whatever reached the server</td>
              <td>Not found (Solana devnet)</td>
              <td>Not found</td>
              <td>Not found</td>
              <td>Not found</td>
            </tr>
            <tr>
              <td>Railgun</td>
              <td>Only you</td>
              <td>One person is exposed</td>
              <td>Not found (Ethereum and L2s)</td>
              <td>Viewing keys that show your whole history</td>
              <td>Not found</td>
              <td>Not found</td>
            </tr>
            <tr>
              <td>Nullmask</td>
              <td>
                You and Nullmask: its servers hold the account keys that read balances and history (
                <Src href={NM.docsPrivacy}>docs</Src>)
              </td>
              <td>
                Every account&apos;s balance and history; the keys it holds cannot spend (
                <Src href={NM.docsSecurity}>docs</Src>)
              </td>
              <td>
                Robinhood Chain, named in its audit report (<Src href={NM.audits}>October 2026</Src>)
              </td>
              <td>Not found</td>
              <td>Not found</td>
              <td>Not found</td>
            </tr>
          </tbody>
        </table>
      </div>

      <h2 id="each">Gloam and each of them</h2>

      <h3>Zama</h3>
      <p>
        Zama uses fully homomorphic encryption. Tokens stay encrypted and a
        coprocessor network computes on them. A 13-node key management
        committee shares one global key. Zama has raised over $170M, including
        a token sale.
      </p>
      <p>
        <strong>Where they win:</strong> computing on shared data, like sealed
        auctions and lending. <strong>Where Gloam differs:</strong> a payment
        has one owner, so there is no committee and no global key.
      </p>

      <h3>Arcium</h3>
      <p>
        Arcium uses multi-party computation on Solana. Clusters of nodes compute
        on secret shares, and data stays private while at least one node in the
        cluster stays honest. Clusters are admitted by an authority.
      </p>
      <p>
        <strong>Where they win:</strong> private shared state on Solana.{" "}
        <strong>Where Gloam differs:</strong> no cluster to trust, and it runs on{" "}
        {MAINNETS}.
      </p>

      <h3>Tempo Zones</h3>
      <p>
        Zones are operator-run private chains on Tempo. The operator sees
        everything inside its zone, and deposits and withdrawals are public.
        Zones are in a limited preview.
      </p>
      <p>
        <strong>Where they win:</strong> enterprises that want an operator in
        the loop. <strong>Where Gloam differs:</strong> self-custody with no
        operator, open to anyone a Zone does not serve.
      </p>

      <h3>Helius Privacy</h3>
      <p>
        Helius Privacy is on Solana devnet. Helius&apos;s server generates the
        proofs, so it receives the full secret inputs, amounts included.
      </p>
      <p>
        <strong>Where they win:</strong> speed on weak phones, and reach on
        Solana. <strong>Where Gloam differs:</strong> proofs are made on your
        device, never on our servers.
      </p>

      <h3>Railgun</h3>
      <p>
        Railgun is the closest to Gloam in design: client-side zero-knowledge
        proofs, on Ethereum and L2s. It holds about $113M and charges 0.25% in
        and out. Its viewing keys show your whole history to whoever holds
        them.
      </p>
      <p>
        <strong>Where they win:</strong> years live, a far bigger crowd of
        notes, and more external audits. <strong>Where Gloam differs:</strong>{" "}
        proofs for one reader that expire, payroll total proofs, agent payments,
        and {MAINNETS}.
      </p>

      <h3 id="nullmask">Nullmask</h3>
      <p>
        Nullmask keeps a private balance in a pool contract. Its docs list
        Ethereum and Base (<Src href={NM.docsNetworks}>networks</Src>), and its
        October 2026 audit report also names BNB Chain and Robinhood Chain. Its
        servers create and keep each user&apos;s viewing and receiving keys and
        prepare the proofs (<Src href={NM.privacyPolicy}>privacy policy</Src>).
        Its docs say it protects activity &quot;from outside observers, not
        from the operator&quot; (<Src href={NM.docsPrivacy}>what stays private</Src>).
      </p>
      <p>
        <strong>Where they win:</strong> signing one message restores the
        account on any device (<Src href={NM.docsStart}>getting started</Src>),
        and the user docs are
        short and plain. <strong>Where Gloam differs:</strong> the keys and the
        proofs stay on your device, so there is no operator that can read a
        balance, the vault cannot be upgraded, and nobody can pause withdrawals.
      </p>
      <p>Checked on 25 and 26 October 2026, from Nullmask&apos;s own pages and its audit report.</p>
      <div className="overflow-x-auto">
        <table className="md:min-w-[720px] [&_th]:whitespace-normal">
          <thead>
            <tr>
              <th />
              <th>Nullmask</th>
              <th>Gloam today</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Keys and proofs</td>
              <td>
                Viewing and receiving keys made and kept on its servers, which also prepare the
                proofs (<Src href={NM.privacyPolicy}>privacy policy</Src>)
              </td>
              <td>
                Keys made and kept on your device, and proofs made there too (
                <Link href="/verify#keys">what Gloam can&apos;t see</Link>)
              </td>
            </tr>
            <tr>
              <td>Upgrades and pausing</td>
              <td>
                Upgradeable by a 2-of-3 Safe (<Src href={NM.audits}>audit</Src>). Its terms allow
                upgrades at once and without notice, and pausing withdrawals with no maximum length
                (<Src href={NM.terms}>terms 8.3 to 8.4</Src>)
              </td>
              <td>
                No proxy and no upgrade. No pause. A rule change waits 3 days in public (
                <Link href="/verify#contracts">contracts</Link>)
              </td>
            </tr>
            <tr>
              <td>Reviews and circuits</td>
              <td>
                External audit of the contracts (4irelabs, October 2026). It says the Noir circuits
                were not provided and were out of scope. The circuits are not published (
                <Src href={NM.audits}>audits</Src>)
              </td>
              <td>
                External review of the vault contracts (Kann Audits,{" "}
                <Link href="/security">report, 1 November 2026</Link>), with no Critical, High or Medium
                issues found. The swap routers and circuits were not part of it. The circuits are public in
                the repo
              </td>
            </tr>
            <tr>
              <td>Fees</td>
              <td>
                0.5% to deposit, 0.5% to withdraw, private transfers free, plus a network fee (
                <Src href={NM.docsFees}>fees</Src>)
              </td>
              <td>Direct deposits and private payments free; 0.5% to cash out</td>
            </tr>
            <tr>
              <td>Gas</td>
              <td>
                Paid in ETH from a separate gas balance, then from private ETH (
                <Src href={NM.docsGas}>gas</Src>)
              </td>
              <td>Your wallet pays to deposit. The Gloam relay pays for the sends and cash outs it submits</td>
            </tr>
            <tr>
              <td>Deposits</td>
              <td>
                Screened before they are credited. Most take minutes, some up to 24 hours, a few
                longer (<Src href={NM.docsChecks}>deposit checks</Src>)
              </td>
              <td>The depositing wallet is checked against the OFAC list before you sign. Credited when it lands</td>
            </tr>
            <tr>
              <td>Paying someone new</td>
              <td>
                Becomes a withdrawal: the address, asset and amount are public (
                <Src href={NM.docsSend}>send</Src>)
              </td>
              <td>A claim link: the money stays in the vault until they claim it into a note of their own</td>
            </tr>
            <tr>
              <td>A new device</td>
              <td>
                One signature restores the account (<Src href={NM.docsStart}>getting started</Src>)
              </td>
              <td>
                Turn on recovery: an encrypted backup your wallet signature or passkey opens. Keys
                from one signature are planned
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <h3>Others worth knowing</h3>
      <ul>
        <li>
          <strong>Payy</strong> ($6M seed) runs a private stablecoin wallet and
          a Visa card on its own ZK chain. Where they win: consumer users and a
          card today.
        </li>
        <li>
          <strong>Cloak</strong> is a client-side ZK pool with payroll, on
          Solana.
        </li>
      </ul>

      <h2 id="swaps">What about trading?</h2>
      <p>
        A trade mixes many people&apos;s orders, which is the committee job
        above. Gloam keeps the owner model for swaps too. A{" "}
        <Link href="/docs/private-swaps">private swap</Link> spends one note
        with one proof made on your device, trades on a public DEX, and puts
        the output back as a new note. Who swapped stays private. The tokens
        and the amounts are public, like any DEX trade.
      </p>

      <h2 id="short-version">The short version</h2>
      <p>
        We found no other product on Tempo or Robinhood Chain that combines
        owner-only privacy, proofs for one reader, and payroll and agent rails.
      </p>

      <h2 id="behind">Where Gloam is behind</h2>
      <ul>
        <li>
          <strong>New on mainnet.</strong> Gloam went live on mainnet on 21
          October 2026, on the final keys from a 13-contributor ceremony, with
          deposit limits on what the pools take.
        </li>
        <li>
          <strong>External review covers the vault only.</strong> Kann Audits reviewed the vault
          contracts (<Link href="/security">report, 1 November 2026</Link>) and found no Critical, High or Medium issues.
          The swap routers, circuits, app and relay were not part of it. Before
          that came several internal rounds, with fixes deployed, and a review
          before launch that finished on 20 October with no Critical or High
          findings open.
        </li>
        <li>
          <strong>Small crowd.</strong> The mainnet pools are new, so the
          anonymity set is thin at first. Treat unlinkability as weak for now.
        </li>
        <li>
          <strong>Forwarded proofs.</strong> A reader can still pass a proof on.
          It will say who it was for and when it expired. A designated-verifier
          mode is next.
        </li>
        <li>
          <strong>Rule changes.</strong> There is no admin withdraw, and rule
          changes are timelocked: the owner can swap verifiers only after a
          3-day public delay, and not at all on a vault the owner guard holds.
        </li>
      </ul>
      <p>
        The full list is on the <Link href="/docs/production">production gate</Link>{" "}
        and in <Link href="/docs/privacy-model">what stays private</Link>.
      </p>
    </DocsLayout>
  );
}
