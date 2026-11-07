import { swapMainnets, swapV3Live } from "@/lib/vaultSwap";
import type { Metadata } from "next";
import Link from "next/link";
import { AppLink } from "@/components/AppLink";
import { DocsLayout } from "@/components/DocsLayout";
import { FlowDiagram, PoolPicture } from "@/components/docs/FlowDiagram";
import { joinNames, liveMainnetNames, liveMainnetsSinceText, mainnetPool } from "@/lib/mainnet";
import { ELYSIUM, ELYSIUM_TESTNET } from "@/lib/elysium";

/** Base and Ethereum mainnet join the lists once their pools are in (lib/mainnet.ts). */
const BASE_LIVE = mainnetPool(8453) !== null;
const ETHEREUM_LIVE = mainnetPool(1) !== null;
const MAINNET_IDS = [
  "RH 4663",
  "Tempo 4217",
  ...(BASE_LIVE ? ["Base 8453"] : []),
  ...(ETHEREUM_LIVE ? ["Ethereum 1"] : []),
  // Elysium mainnet, only while it is on (lib/elysium.ts)
  ...(ELYSIUM ? [`Elysium ${ELYSIUM.chainId}`] : []),
].join(" · ");
/** The mainnets after Robinhood Chain and Tempo, as words: "Base and Ethereum", and Elysium while it is on. */
const LATER_NAMES = joinNames([...(BASE_LIVE ? ["Base"] : []), ...(ETHEREUM_LIVE ? ["Ethereum"] : []), ...(ELYSIUM ? ["Elysium"] : [])]);

export const metadata: Metadata = {
  title: "Whitepaper",
  alternates: { canonical: "/whitepaper" },
  description:
    `Gloam whitepaper: private stablecoin payments on ${liveMainnetNames()}. Thesis, architecture, cryptography, what is new, how it compares, threat model and roadmap.`,
};

export default function WhitepaperPage() {
  return (
    <DocsLayout
      title="Whitepaper"
      lede={`Private money on public chains. The technical and product thesis for Gloam: private stablecoin payments for people, teams and AI agents, private by default and provable on demand, on ${liveMainnetNames()}.`}
      glance={[
        { label: "Version", value: "0.5" },
        { label: "Status", value: "Public draft" },
        { label: "Networks", value: `Mainnet ${MAINNET_IDS}; testnet 46630 · 42431 · 84532 · 11155111${ELYSIUM_TESTNET ? " · 99801" : ""}` },
        { label: "Live", value: "Shield · pay · payroll · proofs · swaps" },
        { label: "Private swaps", value: "Mainnet; amounts public" },
        { label: "Mainnet", value: "Live since 21 Oct 2026" },
      ]}
      quickLinks={[
        { href: "/docs", label: "Documentation" },
        { href: "/app", label: "Open the app" },
        { href: "https://x.com/gloamtrade", label: "@gloamtrade" },
      ]}
    >
      <div className="rounded-[14px] bg-surface px-5 py-4 text-[14px] leading-relaxed text-mute">
        This document is a living public draft. It describes design targets,
        shipped capability on mainnet and testnet, and intentional non-claims.
        It is not an offer of securities, a guarantee of future timelines, a
        promise of absolute anonymity, or a solicitation to purchase anything.
      </div>

      <h2 id="abstract">1. Abstract</h2>
      <p>
        Public blockchains made settlement programmable and verifiable. They also
        made financial activity permanently legible. Wallet graphs, size, and
        timing form a continuous record of intent, legible to bots, competitors,
        counterparties, and anyone with an explorer.
      </p>
      <p>
        Stablecoins are becoming how businesses and AI agents pay each other,
        and every one of those payments is public. Gloam makes them private,
        and lets the payer prove exactly what someone needs to see. It is a
        self-custodial vault on {liveMainnetNames()} in
        which stablecoins, and on Robinhood Chain stock tokens, can be held,
        paid and proven with
        reduced public visibility. The thesis is one line:{" "}
        <strong>private by default, provable on demand.</strong>
      </p>
      <p>
        Gloam is not new cryptography. A payment has one owner, so the owner
        proves it on their own device with zero-knowledge proofs from the Zcash
        lineage, and nobody else ever holds a key. What is new is the building
        block on top: private payments you can prove (section 7).
      </p>
      <p>
        Privacy on a transparent chain is not the absence of transactions from
        explorers. It is the separation of <em>settlement visibility</em> from{" "}
        <em>strategy visibility</em>. Shield and unshield remain deliberate public
        edges. While assets remain inside the shielded set, amounts and internal
        transfer relationships are designed not to appear as a simple public
        balance sheet for a single address.
      </p>

      <h2 id="problem">2. Problem</h2>
      <h3>2.1 Transparent finance as confession</h3>
      <p>
        Open ledgers encode intent. A salary paid onchain is readable by every
        coworker. A supplier payment shows your margins. A treasury balance
        shows your runway. A large swap signals urgency. Address clustering
        tools turn a wallet into a public narrative. For teams, funds and
        agents this is not a feature. It is a cost priced into every
        interaction.
      </p>
      <h3>2.2 Stablecoin payments are public by default</h3>
      <p>
        Real stablecoin payments came to about $390B in 2025, double 2024, and
        58% of that ($226B) was business to business. Every one of those
        payments, and the balance behind it, can be read by anyone with an
        explorer. AI agents that pay for tools over HTTP add a new payer with
        the same exposure: an agent&apos;s wallet shows what it buys and how
        it works.
      </p>
      <h3>2.3 Tokenized equities inherit the same exposure</h3>
      <p>
        Robinhood Chain positions itself as infrastructure for financial
        services and real-world assets, and tokenized stocks already trade
        there. Without application-layer privacy, a stock position is as
        public as a payment.
      </p>
      <h3>2.4 Why now</h3>
      <ul>
        <li>
          New payment chains launched in 2026: Tempo mainnet on 18 March,
          Robinhood Chain on 1 July and Arc on 16 September. All are public by
          default.
        </li>
        <li>
          Stablecoins held privately in Railgun on Ethereum grew from $2.1M in
          January 2024 to $51M in October 2026. That is still under 0.1% of a
          $311B supply.
        </li>
        <li>
          FinCEN withdrew its proposed mixer rule on 5 October 2026. The GENIUS
          Act requires stablecoin issuers to be able to freeze, and
          Gloam&apos;s design never stops them.
        </li>
      </ul>

      <h2 id="thesis">3. Thesis and principles</h2>
      <p>
        Gloam asserts that private holding, private payment and selective proof
        are first-class requirements for onchain money, not optional skins on a
        public wallet.
      </p>
      <ul>
        <li>
          <strong>One owner, no key holder.</strong> A payment has one owner,
          so the owner proves it on their own device. No committee, operator or
          server holds a key or sees the secret inputs.
        </li>
        <li>
          <strong>Honesty over theater.</strong> No mock private success. Claims
          expand only as contracts, circuits, and audits support them.
        </li>
        <li>
          <strong>Battle-tested patterns.</strong> Commitments, nullifiers,
          Merkle membership, and zero-knowledge proofs, not novel cryptography
          invented for a launch tweet.
        </li>
        <li>
          <strong>Edges are real.</strong> Entering and leaving the vault is
          visible. Privacy tools reduce public visibility; they do not erase the
          physical world, legal process, or operator error.
        </li>
        <li>
          <strong>Mainnet only when ready.</strong> Production capital
          requires production ceremonies, reviews, and operational maturity.
          Mainnet opened on the final ceremony keys, after an internal review,
          with deposit limits.
        </li>
      </ul>

      <h2 id="privacy-myth">4. What “privacy” means here</h2>
      <p>
        A common misconception is that private transactions leave no footprint
        on a block explorer. That is not how application-layer privacy on a
        public chain works.
      </p>
      <ul>
        <li>
          <strong>Visible by design:</strong> that the vault contract was used;
          shield (deposit) and unshield (withdrawal) events; proof verification
          transactions and the account that submits them (the Gloam relay can
          submit in the user&apos;s place).
        </li>
        <li>
          <strong>Hidden by design (goal):</strong> amounts while shielded;
          the internal transfer graph between notes; who made a private swap;
          trade intent during private execution (roadmap).
        </li>
        <li>
          <strong>Degraded when the set is small:</strong> timing and size
          correlation; thin anonymity sets.
        </li>
      </ul>
      <p>
        Private send does not mean “nothing on the explorer.” It means the
        public record does not present a simple Alice→Bob amount story for value
        that stays inside the vault.
      </p>

      <PoolPicture title="Figure 1, Wallet, vault, and exit" />

      <h2 id="architecture">5. System architecture</h2>
      <h3>5.1 Placement</h3>
      <p>
        Gloam is an application-layer privacy system on a transparent L2
        (Robinhood Chain), with the same contracts deployed on Tempo, a
        payments-first L1, and on {LATER_NAMES}. Settlement finality remains with the chain. Privacy
        is constructed above it via a self-custodial shielded pool, a Merkle
        tree of note commitments, nullifiers to prevent double-spends, and
        on-chain verifiers for zero-knowledge proofs. The pool holds deposits,
        but only a valid proof from the note holder moves them: there is no
        admin withdraw, and rule changes are timelocked (5.5).
      </p>
      <h3>5.2 Core components</h3>
      <ul>
        <li>
          <strong>Client application</strong>, wallet connection, note
          material generation, Merkle path reconstruction from on-chain events,
          browser-side proof generation, notes encrypted at rest, and product
          UX.
        </li>
        <li>
          <strong>ShieldPool (Poseidon)</strong>, holds deposited assets,
          maintains the tree, accepts proof-bound shield deposits, and
          processes transfer and unshield with proof verification. It has no
          admin withdraw.
        </li>
        <li>
          <strong>Hash and tree</strong>, Poseidon-based commitments and a
          depth-20 Merkle structure aligned with circuit constraints.
        </li>
        <li>
          <strong>Circuits</strong>, shield (binds a deposit to its note),
          transfer (private send / split) and unshield (exit), with
          public-input layouts bound to the vault. A sealed-swap circuit from
          the first private trade design is retired and stays off. Three more
          circuits back the proofs in 6.1.
        </li>
        <li>
          <strong>Verifiers</strong>, Groth16 verifiers for each on-chain
          circuit. A dual verifier routes transfer and unshield by public-input
          count; deposits use a separate shield verifier.
        </li>
        <li>
          <strong>Memo board</strong>, an encrypted payment-message contract
          that lets a recipient find payments sent to them. It holds no funds.
        </li>
        <li>
          <strong>Swap routers</strong>, one per mainnet (Uniswap v4 on
          Robinhood Chain, Tempo&apos;s stablecoin exchange on Tempo). A router
          takes one note out of the vault to a one-time escrow, buys an exact
          amount on its fixed venue, and deposits the output back as a new
          note, in one transaction. It uses only the vault&apos;s unshield and
          proof-bound deposit, and has no upgrade. Tempo&apos;s has no owner;
          Robinhood Chain&apos;s can add a pool with 3 days of public notice and
          take one off at once, and nothing else.
        </li>
      </ul>

      <FlowDiagram
        title="Figure 2, Component sketch"
        steps={[
          {
            n: "01",
            title: "Client",
            body: "Wallet UI, local note secrets, proof generation in the browser.",
          },
          {
            n: "02",
            title: "Pool",
            body: "Holds deposits, Merkle root history, nullifier set, proof-gated payout. No admin withdraw.",
          },
          {
            n: "03",
            title: "Verifier",
            body: "On-chain check of proofs against fixed public inputs.",
          },
          {
            n: "04",
            title: "Circuits",
            body: "Shield, transfer and unshield constraints (Poseidon notes + membership).",
          },
        ]}
      />

      <h3>5.3 Note scheme</h3>
      <p>
        A shielded note binds a secret, amount, and asset into a commitment.
        Nullifiers are derived so that spending a note can be recorded without
        reusing it. Exact field hashes and layouts are implemented in circuit
        source and client libraries and must stay aligned across releases.
      </p>
      <h3>5.4 Actions</h3>
      <ul>
        <li>
          <strong>Shield</strong>, public assets enter the vault with a proof
          that the new commitment encodes exactly the amount and asset
          deposited; the commitment is inserted into the tree.
        </li>
        <li>
          <strong>Transfer (private send)</strong>, spend one note, insert two
          new commitments (payment and change), conserve value for a single
          asset. The payment note is encrypted to the recipient&apos;s Gloam
          address (receive tag) and posted to the memo board, where the
          recipient&apos;s app finds it by scanning. A payment link covers
          people without a Gloam address.
        </li>
        <li>
          <strong>Unshield</strong>, prove ownership of a note and withdraw to
          a public address bound in the proof. Exit is a visible edge.
        </li>
        <li>
          <strong>Swap</strong>, unshield one note to an escrow address derived
          from the whole swap (the note spent, the new note, a refund note and
          the route), trade it on a public DEX, and shield the exact output as
          a new note. The Gloam relay submits it. Who swapped stays private; the
          tokens and amounts are public. If someone sends the unshield alone,
          the same call returns 99% of the note as the refund note.
        </li>
        <li>
          <strong>Prove</strong>, show a named party a balance, a payment
          received, or a payroll total without opening the wallet (6.1).
        </li>
      </ul>
      <h3>5.5 Custody and rule changes</h3>
      <p>
        The pool is self-custodial. No function lets the owner, the team, or
        anyone else withdraw note-backed funds; value leaves only through an
        unshield proof, to the recipient bound in that proof. The owner&apos;s
        one transfer function returns native currency sent to the contract by
        mistake, above what notes back, and cannot reach note-backed funds.
      </p>
      <p>
        The owner wallet can still change rules: swap verifiers, set rates, and
        set oracle feeds. Setup has ended on both live pools, so every such
        change must be queued on-chain and can only run after a public 3-day
        delay. Users see a pending change before it takes effect and can cash
        out first. On mainnet the same delay applies to raising deposit limits
        or adding an asset, while the owner can lower limits or close deposits
        at once. At launch the owner is a single wallet on mainnet as on
        testnet; a multisig is planned. Each mainnet vault&apos;s ownership
        moves to the owner guard, a contract that forwards only limit and fee
        changes and the sweep of coin sent by mistake: on a vault it holds, nobody can swap a verifier, and the
        trade-off is set out in the threat model.
      </p>

      <FlowDiagram
        title="Figure 3, User loop"
        subtitle="Real contracts. No simulated private fills."
        steps={[
          {
            n: "1",
            title: "Connect",
            body: `Wallet on a mainnet (Robinhood Chain 4663, Tempo 4217${BASE_LIVE ? ", Base 8453" : ""}${ETHEREUM_LIVE ? ", Ethereum 1" : ""}${ELYSIUM ? `, Elysium ${ELYSIUM.chainId}` : ""}), or on a testnet (46630, 42431, 84532, 11155111${ELYSIUM_TESTNET ? ", 99801" : ""}) to practice.`,
          },
          {
            n: "2",
            title: "Shield",
            body: "Deposit USDG or $GLOAM (Robinhood Chain); USDC.e, pathUSD, USDT0 or OUSD (Tempo); USDC, EURC, USDT or ETH (Base); or USDC, USDT, USDG, PYUSD, EURC or ETH (Ethereum), into the vault, under deposit limits. The Robinhood Chain testnet also takes ETH and faucet stocks.",
          },
          {
            n: "3",
            title: "Send or hold",
            body: "Private send splits a note; the payment is sealed to the recipient's Gloam address.",
          },
          {
            n: "4",
            title: "Unshield",
            body: "Prove and cash out to a normal wallet when ready.",
          },
        ]}
      />

      <h2 id="cryptography">6. Cryptography and verification</h2>
      <p>
        Circuits are written in Circom 2.1.6, with Poseidon for
        circuit-friendly hashing and Merkle membership. Proofs are Groth16 on
        BN254, generated in the browser with snarkjs 0.7.5 and checked by
        on-chain verifiers. The trusted setup used on testnet is a
        single-contributor dev ceremony: its keys must not be treated as a
        production setup. The multi-party ceremony for mainnet closed on 17
        October 2026 with 13 contributors, sealed with drand round 6561386, and
        mainnet uses its keys.
      </p>
      <p>
        Public-input layouts are versioned. Shield binds commitment, amount,
        and asset. Unshield binds root, nullifier, asset, amount, and
        recipient. Transfer binds root, nullifier, and two new commitments.
        The dual verifier routes transfer and unshield by public-input count.
      </p>
      <p>
        Sealed swap (the first private trade design) binds root, nullifier,
        two new commitments, assets, a public min-out floor, and rate
        numerators. It is retired: neither testnet pool has a sealed-swap
        verifier set, so every sealed swap call reverts, and the mainnet pools
        have no sealed swap at all. Its design could leave the pool owing an
        asset it does not hold (audit H1). Private swaps replaced it. They add
        no circuit: a swap is an unshield and a proof-bound shield, joined by
        the router in one transaction.
      </p>
      <p>
        Earlier pools on both chains, including a keccak-based Robinhood Chain
        pool, remain on-chain for history only and are superseded. The product
        path on testnet is the Poseidon vault redeployed on 2026-09-29 with
        shield, transfer, and unshield verifiers enabled (dev keys). Mainnet
        runs new payments-only pools (ShieldPoolPayments) on the final keys.
      </p>
      <h3>6.1 Proofs shared with others</h3>
      <p>
        Three more circuits back proofs a holder hands to someone else: proof
        of funds (at least an amount across up to four unspent notes, balance
        hidden), proof of payment (a payment received, with the amount shown
        or only a minimum), and a payroll total (a run paid exactly a total in
        a given number of payments). These are verified off-chain, in the
        browser at gloam.trade/verify, against the live vault state. Each one
        (<code>gloamfunds1</code>, <code>gloampay1</code>,{" "}
        <code>gloamroll1</code>) carries a label naming who it is for and an
        expiry, both bound into the proof. The older{" "}
        <code>gloamdisc1</code> balance disclosure reused the shield circuit
        and carried no recipient label or expiry. Every deposit publishes a
        valid proof of that statement on chain, so anyone could make one for
        any deposit. It is no longer made, and checkers never pass one; an
        exact balance is now a <code>gloambal1</code> proof.
      </p>

      <h2 id="whats-new">7. What is new in Gloam</h2>
      <p>
        Gloam is not new cryptography. It is a new building block for finance:
        private payments you can prove. This section draws the line exactly.
      </p>
      <h3>7.1 Not new</h3>
      <ul>
        <li>
          The private pool design: notes, nullifiers and a Merkle tree, from
          the Zcash lineage starting in 2016, and used by Tornado, Railgun and
          Cloak.
        </li>
        <li>
          Selective disclosure as an idea: Zcash and Railgun viewing keys,
          Privacy Pools, and Zama decryption rights.
        </li>
      </ul>
      <h3>7.2 New, as far as our research found</h3>
      <ol>
        <li>
          <strong>Payroll total proof.</strong> The <code>payroll_total</code>{" "}
          circuit proves that a run of up to 32 payments adds up to exactly a
          total, all funded by the prover, without
          showing who got what. Its public inputs are{" "}
          <code>[asset, total, count, paymentsHash, context]</code>. Each slot
          opens both the payment note and the note it spent, so a payment the
          prover only received cannot be counted as one they made. We found
          nothing like it.
        </li>
        <li>
          <strong>Proofs scoped to one reader.</strong> Who the proof is for (a
          label), its expiry, the chain and the pool are hashed into one public{" "}
          <code>context</code> input:{" "}
          <code>keccak256(abi.encode(&quot;gloam.proof.v1&quot;, kind, chainId, pool, expiresAt, label)) mod p</code>.
          The <code>solvency</code>, <code>receipt</code> and{" "}
          <code>payroll_total</code> circuits bind it into the proof, so
          changing the label breaks it. Anyone can check a proof in a browser
          with no wallet at <Link href="/verify">/verify</Link>. Viewing keys,
          by contrast, show a holder&apos;s whole history and cannot be taken
          back.
        </li>
        <li>
          <strong>Private payments for AI agents.</strong> A private payment
          method proposed for the Machine Payments Protocol from Tempo and
          Stripe (tempoxyz/mpp-specs#376; MPP had no private method), private
          x402 payments, and an MCP server that gives agents handles instead of
          secrets, with spending limits.
        </li>
      </ol>
      <p>
        One honest limit: a reader can still forward a proof. It will say who
        it was made for and when it expires, but nothing stops the forwarding.
        A designated-verifier mode is next.
      </p>

      <h2 id="compare">8. How Gloam compares</h2>
      <p>
        Privacy splits into two jobs. Shared secrets, such as sealed auctions,
        order books and lending pools, need someone to compute on many
        people&apos;s hidden data, so FHE and MPC networks (Zama, Arcium) use a
        committee that holds keys. A payment has one owner, so the owner proves
        it on their own device and nobody else ever holds a key.
      </p>
      <p>
        The difference shows up in a breach. If a committee or an operator is
        breached, everyone who used it can be exposed, including past
        payments. If one owner&apos;s device is breached, one person is
        exposed. Gloam builds the payments product on proven zero-knowledge
        maths, the way Stripe built on card networks.
      </p>
      <div className="overflow-x-auto">
        <table className="min-w-[640px]">
          <thead>
            <tr>
              <th>Product</th>
              <th>Who can see payments</th>
              <th>Where they win</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <strong>Gloam</strong>
              </td>
              <td>Only the owner, and whoever they prove one fact to</td>
              <td>Owner-only privacy, proofs for one reader, payroll and agent rails on {liveMainnetNames()}</td>
            </tr>
            <tr>
              <td>Zama (FHE)</td>
              <td>A 13-node committee shares one global key</td>
              <td>Computing on shared data, like auctions and lending</td>
            </tr>
            <tr>
              <td>Arcium (MPC, Solana)</td>
              <td>A node cluster, private while one node stays honest</td>
              <td>Private shared state on Solana</td>
            </tr>
            <tr>
              <td>Tempo Zones</td>
              <td>The zone operator sees everything in the zone</td>
              <td>Enterprises that want an operator in the loop</td>
            </tr>
            <tr>
              <td>Helius Privacy</td>
              <td>Helius&apos;s server receives the full secret inputs, amounts included</td>
              <td>Speed on weak phones, and Solana reach</td>
            </tr>
            <tr>
              <td>Railgun</td>
              <td>Only the owner; viewing keys show the whole history</td>
              <td>Years live, a far bigger crowd of notes, more external audits</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p>
        We found no other product on Tempo or Robinhood Chain that combines
        owner-only privacy, proofs for one reader, and payroll and agent rails.
        The full comparison, with what a breach exposes and where each one
        wins, is at <Link href="/docs/compare">/docs/compare</Link>.
      </p>

      <h2 id="threat">9. Threat model</h2>
      <h3>9.1 In scope (design goals)</h3>
      <ul>
        <li>Observer reading a single address balance while assets are shielded</li>
        <li>
          Simple public reconstruction of internal note-to-note payment graphs
          (as anonymity set grows)
        </li>
        <li>Double-spend of the same note (nullifiers)</li>
      </ul>
      <h3>9.2 Edges and residual leakage</h3>
      <ul>
        <li>Shield and unshield amounts and timing on the public chain</li>
        <li>RPC and network metadata if clients are careless</li>
        <li>
          The submitting wallet, when a user sends without the relay. On
          Robinhood Chain the deployed memo board also records who posted each
          memo, so the sender stays off that record only when the relay posts
          it; Tempo&apos;s board does not record the poster.
        </li>
        <li>
          Correlation attacks when few users participate or amounts are unique
        </li>
        <li>
          Private swap tokens and amounts, which are public like any DEX trade;
          a swap sized like a recent deposit, or a cash out sized like a
          swap&apos;s output, can be matched
        </li>
      </ul>
      <h3>9.3 Out of scope as “solved by crypto alone”</h3>
      <ul>
        <li>Device malware, phishing, and coerced key disclosure</li>
        <li>Legal process and off-chain identity linkage</li>
        <li>User deletion of local note material without backup</li>
        <li>Absolute anonymity against nation-state adversaries</li>
      </ul>

      <h2 id="product">10. Product surface</h2>
      <p>
        The application at{" "}
        <AppLink href="/app">gloam.trade/app</AppLink> provides:
      </p>
      <ul>
        <li>
          Wallet connection to {liveMainnetNames()} mainnet, and to Robinhood
          Chain testnet, Tempo Moderato, Base Sepolia and Ethereum Sepolia for
          practice
        </li>
        <li>Portfolio with wallet balances, shielded balances, and faucet stocks on testnet</li>
        <li>
          Stock tokens on Robinhood Chain testnet held and sent privately, like
          any other asset in the vault
        </li>
        <li>Public send and stock token transfer paths</li>
        <li>Shield deposits into the privacy vault</li>
        <li>
          Private send (transfer) and cash-out (unshield) with browser proofs,
          optionally submitted by the Gloam relay so the user&apos;s wallet does
          not appear
        </li>
        <li>
          Receiving by Gloam address (encrypted memos) or payment link, plus
          note import
        </li>
        <li>Private payroll, scheduled payroll, and payment requests</li>
        <li>Proofs of funds, payment, and payroll totals, checked at /verify</li>
        <li>
          Private swaps on {swapMainnets()} mainnet: USDG, $GLOAM,
          PONS, CASHCAT, WETH, stock tokens and more on Robinhood Chain, the four
          vault stablecoins on Tempo{swapV3Live(8453) || swapV3Live(1) ? ", stablecoins and ETH on Uniswap v4 on the others" : ""}, sent by the
          Gloam relay, with who swapped kept private and the amounts public
        </li>
        <li>
          The first private trade design (sealedSwap) is retired. On the
          Robinhood Chain testnet a via-market path (cash out, public swap,
          re-shield) remains where a public pool exists, with the swap size
          public on that edge
        </li>
      </ul>
      <p>
        Documentation and this whitepaper live on the same
        origin (
        <Link href="/docs">/docs</Link>,{" "}
        <Link href="/whitepaper">/whitepaper</Link>
        ). Marketing site and product share one brand: ink, paper, and a single green tint that marks what is private.
      </p>

      <h2 id="roadmap">11. Roadmap</h2>
      <ol>
        <li>
          <strong>Live on mainnet:</strong> {liveMainnetsSinceText()}, all
          on the same vault and the final ceremony keys: proof-bound
          shield, unshield, private send, the Gloam relay, payroll, proofs of
          funds, payment, and payroll totals, private agent payments,
          deposit limits, and pools with no admin withdraw and timelocked rule
          changes. Private swaps from the private balance run on Robinhood
          Chain and Tempo, through a router per chain, and on Robinhood Chain
          they include stock tokens. A swap hides who swapped, not the tokens or
          the amounts. Encrypted payment memos run on every network, and
          the Robinhood Chain testnet adds stock tokens held and sent
          privately, with test funds.
        </li>
        <li>
          <strong>Retired:</strong> the first sealed-swap path (circuit,
          verifier, oracle-bound rates). It stays off, and private swaps
          replaced it.
        </li>
        <li>
          <strong>Near term:</strong> a designated-verifier mode for proofs;
          anonymity set growth; operational monitoring.
        </li>
        <li>
          <strong>Mid term:</strong> issuer-scoped disclosure for regulated
          stablecoins on Tempo.
        </li>
        <li>
          <strong>Production gate:</strong> done before mainnet, the multi-party
          trusted setup (13 contributors) and an internal review (no Critical or
          High findings open on 20 October 2026). Done since: Kann Audits
          reviewed the vault contracts (<Link href="/security">report, 1 November 2026</Link>) and found no Critical,
          High or Medium issues. The swap routers, circuits, app and relay were
          not part of it. Still ahead: a multisig owner and the incident process.
        </li>
      </ol>

      <h2 id="risks">12. Risks and limitations</h2>
      <ul>
        <li>
          On mainnet, deposit limits cap
          what the pools take
        </li>
        <li>
          Smart contract and circuit bugs: Kann Audits reviewed the vault
          contracts and found no Critical, High or Medium issues, but no review
          rules out bugs, and the routers, circuits, app and relay were not part
          of it
        </li>
        <li>The Robinhood Chain and Tempo testnets run on development proving keys from a single-contributor dev ceremony (mainnet, Base Sepolia and Ethereum Sepolia use the 13-contributor keys)</li>
        <li>
          Rule changes, including verifier swaps, by a single owner wallet,
          limited by a public 3-day delay, until the owner guard holds that
          vault
        </li>
        <li>Browser-local note storage and user operational error</li>
        <li>
          A payer can reclaim a direct payment until the payee claims it,
          because the payer created the note and knows its key; claiming moves
          it into a new note only the payee knows
        </li>
        <li>The relayer is run by the Gloam team at launch; it can refuse or go down, never redirect</li>
        <li>
          Private swaps show their tokens and amounts, trade on outside venues,
          and only go through the relay; a swap someone breaks on purpose
          refunds 99% of the note
        </li>
        <li>
          A stablecoin issuer can freeze the vault contract; the answer is to
          screen deposits so flagged funds never enter
        </li>
        <li>A reader can forward a proof meant for them</li>
        <li>Regulatory and compliance uncertainty around privacy tools</li>
        <li>Thin anonymity sets in early usage, on the new mainnet pools especially</li>
        <li>L2 and bridge operational risk of the underlying chain</li>
      </ul>

      <h2 id="non-claims">13. Explicit non-claims</h2>
      <p>
        Gloam is live on mainnet. It does not claim a full
        external audit (the Kann Audits review covers the vault contracts only),
        insurance of funds, legal immunity, or invisibility
        from investigation. Nothing in
        this paper is investment advice.
      </p>

      <h2 id="closing">14. Closing</h2>
      <p>
        Settlement will remain public. Salaries, suppliers and strategies need
        not. Gloam builds the sealed chamber beside the open book on{" "}
        {liveMainnetNames()}, so people, teams and agents can hold, pay and prove
        exactly what is needed, without printing every private calculation to
        the street.
      </p>
      <div className="t-label pt-4">gloam.trade · live on mainnet · hello@gloam.trade · @gloamtrade</div>
    </DocsLayout>
  );
}
