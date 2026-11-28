import { swapMainnets, swapV3Live } from "@/lib/vaultSwap";
import type { Metadata } from "next";
import Link from "next/link";
import { AppLink } from "@/components/AppLink";
import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";
import { FlowDiagram, PoolPicture } from "@/components/docs/FlowDiagram";
import { Columns, Note, Pull, Section, Sub, Terms, type WpSection } from "@/components/whitepaper/WhitepaperParts";
import { WhitepaperToc } from "@/components/whitepaper/WhitepaperToc";
import { joinNames, liveMainnetNames, liveMainnetsSinceText, mainnetPool } from "@/lib/mainnet";
import { ELYSIUM } from "@/lib/elysium";
import { BNB } from "@/lib/bnb";
import { SOLANA_RINGS_ENABLED } from "@/lib/solanaRings/config";

/** Base and Ethereum mainnet join the lists once their pools are in (lib/mainnet.ts). */
const BASE_LIVE = mainnetPool(8453) !== null;
const ETHEREUM_LIVE = mainnetPool(1) !== null;
/** The mainnets after Robinhood Chain and Tempo, as words: "Base and Ethereum", and Elysium and BNB Chain while they are on. */
const LATER_NAMES = joinNames([...(BASE_LIVE ? ["Base"] : []), ...(ETHEREUM_LIVE ? ["Ethereum"] : []), ...(ELYSIUM ? ["Elysium"] : []), ...(BNB ? ["BNB Chain"] : [])]);
/** "Robinhood Chain 4663, Tempo 4217, Base 8453, …": the mainnets a wallet connects to. */
const MAINNET_CHAINS = [
  "Robinhood Chain 4663",
  "Tempo 4217",
  ...(BASE_LIVE ? ["Base 8453"] : []),
  ...(ETHEREUM_LIVE ? ["Ethereum 1"] : []),
  ...(ELYSIUM ? [`Elysium ${ELYSIUM.chainId}`] : []),
  ...(BNB ? [`BNB Chain ${BNB.chainId}`] : []),
].join(", ");

export const metadata: Metadata = {
  title: "Whitepaper",
  alternates: { canonical: "/whitepaper" },
  description: `Gloam whitepaper: private stablecoin payments on ${liveMainnetNames()}. Thesis, architecture, cryptography, what is new, how it compares, threat model and roadmap.`,
};

const S: Record<string, WpSection> = {
  abstract: { id: "abstract", n: "01", title: "Abstract" },
  problem: { id: "problem", n: "02", title: "The problem" },
  thesis: { id: "thesis", n: "03", title: "Thesis and principles" },
  privacy: { id: "privacy-myth", n: "04", title: "What privacy means here" },
  architecture: { id: "architecture", n: "05", title: "System architecture" },
  cryptography: { id: "cryptography", n: "06", title: "Cryptography" },
  whatsNew: { id: "whats-new", n: "07", title: "What is new" },
  compare: { id: "compare", n: "08", title: "How Gloam compares" },
  threat: { id: "threat", n: "09", title: "Threat model" },
  product: { id: "product", n: "10", title: "Product" },
  roadmap: { id: "roadmap", n: "11", title: "Roadmap" },
  risks: { id: "risks", n: "12", title: "Risks and limits" },
  nonClaims: { id: "non-claims", n: "13", title: "What we do not claim" },
  closing: { id: "closing", n: "14", title: "Closing" },
};
const SECTIONS = Object.values(S);

export default function WhitepaperPage() {
  return (
    <div className="relative min-h-screen bg-panel text-foreground">
      <Header />

      <main className="mx-auto max-w-[1240px] px-6">
        {/* Cover: the title, one line of what this is, three facts. */}
        <section className="pb-20 pt-14 sm:pb-28 sm:pt-24">
          <p className="text-[14px] text-mute">Whitepaper · Version 0.6 · November 2026</p>
          <h1 className="t-display-xl mt-6 max-w-[16ch] text-balance">Private money on public chains.</h1>
          <p className="mt-7 max-w-[48ch] text-pretty text-[19px] leading-relaxed text-soft sm:text-[21px]">
            The technical and product thesis for Gloam: private stablecoin payments for people, teams and AI agents.
          </p>
          <div className="mt-10 flex flex-wrap items-center gap-x-7 gap-y-4">
            <AppLink href="/app" className="btn btn-ink">
              Open the app
            </AppLink>
            <Link href="/docs" className="gl-arrowlink">
              Read the docs <span aria-hidden>→</span>
            </Link>
          </div>

          <dl className="mt-16 grid gap-x-10 gap-y-8 sm:mt-20 sm:grid-cols-3">
            {[
              { k: "Live on mainnet", v: "Since 21 October 2026" },
              { k: "Networks", v: liveMainnetNames() },
              { k: "Status", v: "Public draft, updated as we ship" },
            ].map((f) => (
              <div key={f.k} className="border-t border-foreground pt-5">
                <dt className="text-[13px] text-mute">{f.k}</dt>
                <dd className="mt-2 text-pretty text-[17px] leading-snug text-foreground">{f.v}</dd>
              </div>
            ))}
          </dl>
        </section>

        <div className="border-t border-line pt-16 sm:pt-24 lg:grid lg:grid-cols-[220px_minmax(0,1fr)] lg:gap-x-20">
          <WhitepaperToc sections={SECTIONS} />

          <article className="wp min-w-0 max-w-[720px]">
            <Note>
              A living public draft. It describes what is live on mainnet, what is designed, and what we deliberately do
              not claim. It is not an offer of securities, a promise of timelines or absolute anonymity, or a solicitation
              to buy anything.
            </Note>

            <Section s={S.abstract}>
              <p>
                Public blockchains made settlement programmable and verifiable. They also made financial activity
                permanently readable: wallet graphs, sizes and timing form a running record of intent, open to bots,
                competitors and anyone with an explorer.
              </p>
              <p>
                Stablecoins are becoming how businesses and AI agents pay each other, and every one of those payments is
                public. Gloam makes them private and lets the payer prove exactly what someone needs to see. It is a
                self-custodial vault on {liveMainnetNames()}, where stablecoins, and stock tokens on Robinhood Chain, are
                held, paid and proven without a public balance sheet.
              </p>
              <Pull>Private by default, provable on demand.</Pull>
              <p>
                Gloam is not new cryptography. A payment has one owner, so the owner proves it on their own device with
                zero-knowledge proofs from the Zcash lineage, and nobody else ever holds a key. What is new is the building
                block on top: private payments you can prove (section 07).
              </p>
              <p>
                Privacy on a transparent chain is not the absence of transactions from explorers. It separates{" "}
                <em>settlement visibility</em> from <em>strategy visibility</em>. Adding and cashing out stay deliberate
                public edges. Inside the vault, amounts and who paid whom do not read as a balance sheet for one address.
              </p>
            </Section>

            <Section s={S.problem}>
              <Terms
                items={[
                  {
                    term: "Transparent finance is a confession",
                    body: "A salary paid onchain is readable by every coworker. A supplier payment shows your margins, a treasury balance your runway, a large swap your urgency. Clustering tools turn a wallet into a public story.",
                  },
                  {
                    term: "Stablecoin payments are public by default",
                    body: "Real stablecoin payments came to about $390B in 2025, double 2024, and 58% of it ($226B) was business to business. Every payment, and the balance behind it, is open to anyone with an explorer. Agents paying for tools over HTTP carry the same exposure.",
                  },
                  {
                    term: "Tokenized stocks inherit it",
                    body: "Tokenized stocks already trade on Robinhood Chain. Without privacy at the application layer, a stock position is as public as a payment.",
                  },
                ]}
              />
              <Sub>Why now</Sub>
              <ul>
                <li>Tempo (18 March), Robinhood Chain (1 July) and Arc (16 September) launched in 2026. All are public by default.</li>
                <li>
                  Stablecoins held privately in Railgun grew from $2.1M in January 2024 to $51M in October 2026: still
                  under 0.1% of a $311B supply.
                </li>
                <li>
                  FinCEN withdrew its proposed mixer rule on 5 October 2026. The GENIUS Act requires issuers to be able to
                  freeze, and Gloam&apos;s design never stops them.
                </li>
              </ul>
            </Section>

            <Section s={S.thesis}>
              <p>
                Private holding, private payment and selective proof are first-class requirements for money onchain, not a
                skin on a public wallet.
              </p>
              <Terms
                items={[
                  {
                    term: "One owner, no key holder",
                    body: "The owner proves a payment on their own device. No committee, operator or server holds a key or sees the secret inputs.",
                  },
                  {
                    term: "Honesty over theatre",
                    body: "No mock private success. Claims grow only as contracts, circuits and reviews support them.",
                  },
                  {
                    term: "Proven patterns",
                    body: "Commitments, nullifiers, Merkle membership and zero-knowledge proofs. No cryptography invented for a launch.",
                  },
                  {
                    term: "The edges are real",
                    body: "Entering and leaving the vault is visible. Privacy reduces what the public sees; it does not erase legal process or operator error.",
                  },
                  {
                    term: "Mainnet when ready",
                    body: "Mainnet opened on the final ceremony keys, after an internal review, with deposit limits.",
                  },
                ]}
              />
            </Section>

            <Section s={S.privacy}>
              <p>
                A private payment does not mean nothing on the explorer. It means the public record shows no simple
                &ldquo;Alice paid Bob this much&rdquo; story for money that stays inside the vault.
              </p>
              <Columns
                cols={[
                  {
                    title: "Visible by design",
                    items: [
                      "That the vault was used",
                      "Adding money and cashing out",
                      "Proof transactions and who submits them (the Gloam relay can submit for you)",
                    ],
                  },
                  {
                    title: "Hidden by design",
                    tone: "sealed",
                    items: ["Amounts while inside the vault", "Who paid whom inside the vault", "Who made a private swap"],
                  },
                  {
                    title: "Weaker while the set is small",
                    items: ["Timing that lines up", "Amounts that stand out", "Few people using the vault"],
                  },
                ]}
              />
              <PoolPicture title="Figure 1. Wallet, vault and exit" />
            </Section>

            <Section s={S.architecture}>
              <Sub>Placement</Sub>
              <p>
                Gloam is application-layer privacy on Robinhood Chain, a transparent L2, with the same contracts on Tempo, a
                payments-first L1{LATER_NAMES ? `, and on ${LATER_NAMES}` : ""}. Finality stays with the chain. Privacy is
                built above it: a self-custodial pool, a Merkle tree of note commitments, nullifiers against double-spends,
                and onchain verifiers for zero-knowledge proofs. Only a valid proof from the note&apos;s owner moves money:
                there is no admin withdraw, and rule changes are timelocked.
              </p>
              <Sub>Components</Sub>
              <Terms
                items={[
                  { term: "App", body: "Wallet connection, note secrets, Merkle paths from onchain events, proofs made in the browser, notes encrypted at rest." },
                  { term: "Vault (ShieldPool)", body: "Holds deposits, keeps the tree, takes proof-bound deposits, and pays out only against a verified proof. No admin withdraw." },
                  { term: "Hash and tree", body: "Poseidon commitments in a depth-20 Merkle tree, matched to the circuits." },
                  { term: "Circuits", body: "Shield (binds a deposit to its note), transfer (private send and split) and unshield (cash out), plus three proof circuits (06)." },
                  { term: "Verifiers", body: "Groth16 verifiers per circuit. A dual verifier routes transfer and unshield; deposits use their own." },
                  { term: "Memo board", body: "An encrypted message contract that lets a recipient find payments sent to them. It holds no funds." },
                  {
                    term: "Swap routers",
                    body: "One per mainnet. A router takes one note to a one-time escrow, buys an exact amount on a fixed venue and deposits the output as a new note, in one transaction. No upgrade; Robinhood Chain's can add a pool with 3 days' public notice.",
                  },
                ]}
              />
              <FlowDiagram
                title="Figure 2. Components"
                steps={[
                  { n: "01", title: "App", body: "Local note secrets and proofs made in the browser." },
                  { n: "02", title: "Vault", body: "Deposits, root history, nullifiers, proof-gated payout. No admin withdraw." },
                  { n: "03", title: "Verifier", body: "Checks each proof onchain against fixed public inputs." },
                  { n: "04", title: "Circuits", body: "Shield, transfer and unshield constraints." },
                ]}
              />
              <Sub>Notes</Sub>
              <p>
                A note binds a secret, an amount and an asset into a commitment. Spending it records a nullifier, so the
                same note can never be spent twice. Field layouts live in the circuit source and client libraries and stay
                aligned across releases.
              </p>
              <Sub>Actions</Sub>
              <Terms
                items={[
                  { term: "Add (shield)", body: "Money enters the vault with a proof that the new note holds exactly what was deposited." },
                  {
                    term: "Pay (transfer)",
                    body: "Spend one note and make two: the payment and the change. The payment is sealed to the recipient's Gloam address and posted to the memo board, where their app finds it. A claim link covers people without an address.",
                  },
                  { term: "Cash out (unshield)", body: "Prove ownership and withdraw to the address bound in the proof. A visible edge." },
                  {
                    term: "Swap",
                    body: "Cash one note out to an escrow derived from the whole swap, trade it on a public venue, and add the exact output back as a new note. Who swapped stays private; the tokens and amounts are public.",
                  },
                  { term: "Prove", body: "Show one named party a balance, a payment received or a payroll total, without opening the wallet." },
                ]}
              />
              <Sub>Custody and rule changes</Sub>
              <p>
                The vault is self-custodial. No function lets the owner, the team or anyone else withdraw note-backed money;
                value leaves only through a cash-out proof, to the address bound in it. The owner can only return coin sent
                to the contract by mistake, above what notes back.
              </p>
              <p>
                The owner can still change rules (verifiers, rates, oracle feeds), but every change is queued onchain and
                runs only after a public 3-day delay, so people can cash out first. On mainnet the same delay covers raising
                limits or adding an asset; lowering limits or closing deposits is immediate. Each mainnet vault moves to an
                owner guard that forwards only limit and fee changes and the sweep of mistaken coin, so nobody can swap a
                verifier there.
              </p>
              {SOLANA_RINGS_ENABLED && (
                <>
                  <Sub>Solana</Sub>
                  <p>
                    On Solana, Gloam runs on Helius Privacy Rings rather than its own vault. A private payment there hides
                    the asset and the amount; the two private accounts it moves between are public, and adding money shows
                    the wallet it came from. Gloam&apos;s account layer keeps people&apos;s main wallets out of their
                    payments.
                  </p>
                </>
              )}
              <FlowDiagram
                title="Figure 3. How someone uses it"
                subtitle="Real contracts. No simulated private fills."
                steps={[
                  { n: "1", title: "Connect", body: `A wallet on a mainnet: ${MAINNET_CHAINS}.` },
                  { n: "2", title: "Add", body: "Stablecoins (and stock tokens on Robinhood Chain) go into the vault, under deposit limits." },
                  { n: "3", title: "Pay or hold", body: "A private payment splits a note and seals it to the recipient's Gloam address." },
                  { n: "4", title: "Cash out", body: "Prove and withdraw to any wallet when ready." },
                ]}
              />
            </Section>

            <Section s={S.cryptography}>
              <p>
                Circuits are written in Circom 2.1.6 with Poseidon hashing. Proofs are Groth16 on BN254, made in the browser
                with snarkjs 0.7.5 and checked by onchain verifiers. Mainnet uses the keys from a multi-party ceremony that
                closed on 17 October 2026 with 13 contributors, sealed with drand round 6561386.
              </p>
              <p>
                Public inputs are versioned. Shield binds the commitment, amount and asset. Cash out binds the root,
                nullifier, asset, amount and recipient. Transfer binds the root, nullifier and two new commitments.
              </p>
              <p>
                The first private trade design (sealed swap) is retired: no live vault has it, and its design could leave the
                pool owing an asset it does not hold. Private swaps replaced it with no new circuit, joining a cash out and a
                proof-bound deposit in one transaction.
              </p>
              <Sub>Proofs you hand to someone</Sub>
              <Terms
                items={[
                  { term: "Proof of funds", body: <>At least an amount across up to four notes, balance hidden (<code>gloamfunds1</code>).</> },
                  { term: "Proof of payment", body: <>A payment received, amount shown or only a minimum (<code>gloampay1</code>).</> },
                  { term: "Payroll total", body: <>A run paid exactly a total across a number of payments (<code>gloamroll1</code>).</> },
                ]}
              />
              <p>
                Each one names who it is for and when it expires, both bound into the proof, and anyone can check it in a
                browser at <Link href="/verify">/verify</Link> against the live vault.
              </p>
            </Section>

            <Section s={S.whatsNew}>
              <p>Gloam is not new cryptography. It is a new building block for finance: private payments you can prove.</p>
              <Sub>Not new</Sub>
              <ul>
                <li>The private pool design (notes, nullifiers, a Merkle tree), from Zcash in 2016, used by Tornado, Railgun and Cloak.</li>
                <li>Selective disclosure as an idea: Zcash and Railgun viewing keys, Privacy Pools, Zama decryption rights.</li>
              </ul>
              <Sub>New, as far as our research found</Sub>
              <Terms
                numbered
                items={[
                  {
                    term: "Payroll total proof",
                    body: (
                      <>
                        The <code>payroll_total</code> circuit proves that up to 32 payments add up to exactly a total, all
                        funded by the prover, without showing who got what. Each slot opens the payment and the note it spent,
                        so money the prover only received can&apos;t count. We found nothing like it.
                      </>
                    ),
                  },
                  {
                    term: "Proofs for one reader",
                    body: (
                      <>
                        Who it is for, its expiry, the chain and the pool are hashed into one public <code>context</code>{" "}
                        input, so changing the label breaks the proof. Viewing keys, by contrast, show a whole history and
                        can&apos;t be taken back.
                      </>
                    ),
                  },
                  {
                    term: "Private payments for AI agents",
                    body: "A private payment method proposed for the Machine Payments Protocol from Tempo and Stripe (tempoxyz/mpp-specs#376), private x402 payments, and an MCP server that gives agents handles instead of secrets, with spending limits.",
                  },
                ]}
              />
              <Note>One honest limit: a reader can still forward a proof. It says who it was for and when it expires, but nothing stops the forwarding. A designated-verifier mode is next.</Note>
            </Section>

            <Section s={S.compare}>
              <p>
                Privacy splits into two jobs. Shared secrets, like sealed auctions or lending pools, need someone to compute
                on many people&apos;s hidden data, so FHE and MPC networks use a committee that holds keys. A payment has one
                owner, so the owner proves it on their own device.
              </p>
              <p>
                The difference shows in a breach. Breach a committee and everyone who used it can be exposed, past payments
                included. Breach one owner&apos;s device and one person is exposed.
              </p>
              <div className="wp-table overflow-x-auto">
                <table className="min-w-[600px]">
                  <thead>
                    <tr>
                      <th>Product</th>
                      <th>Who can see payments</th>
                      <th>Where it wins</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr className="is-us">
                      <td>Gloam</td>
                      <td>Only the owner, and whoever they prove one fact to</td>
                      <td>Owner-only privacy, proofs for one reader, payroll and agent rails</td>
                    </tr>
                    <tr>
                      <td>Zama (FHE)</td>
                      <td>A 13-node committee shares one global key</td>
                      <td>Computing on shared data, like auctions and lending</td>
                    </tr>
                    <tr>
                      <td>Arcium (MPC)</td>
                      <td>A node cluster, private while one node stays honest</td>
                      <td>Private shared state on Solana</td>
                    </tr>
                    <tr>
                      <td>Tempo Zones</td>
                      <td>The zone operator sees everything in the zone</td>
                      <td>Enterprises that want an operator in the loop</td>
                    </tr>
                    <tr>
                      <td>Railgun</td>
                      <td>Only the owner; viewing keys show the whole history</td>
                      <td>Years live, more users, more external audits</td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <p>
                The full comparison, with what a breach exposes and where each one wins, is at{" "}
                <Link href="/docs/compare">/docs/compare</Link>.
              </p>
            </Section>

            <Section s={S.threat}>
              <Columns
                cols={[
                  {
                    title: "What it protects against",
                    tone: "sealed",
                    items: ["Reading one address's balance while money is in the vault", "Rebuilding who paid whom inside the vault", "Spending the same note twice"],
                  },
                  {
                    title: "What still shows",
                    items: [
                      "Amounts and timing when adding and cashing out",
                      "The sending wallet, if someone sends without the relay",
                      "Matches when few people use the vault or amounts are unique",
                      "Swap tokens and amounts",
                    ],
                  },
                  {
                    title: "Beyond cryptography",
                    items: ["Malware, phishing and coercion", "Legal process and offchain identity", "Lost notes without a backup", "Nation-state adversaries"],
                  },
                ]}
              />
            </Section>

            <Section s={S.product}>
              <p>
                The app at <AppLink href="/app">gloam.trade/app</AppLink> runs on {liveMainnetNames()}.
              </p>
              <Terms
                items={[
                  { term: "Private balance", body: "Add stablecoins, hold them privately, see public and private side by side." },
                  { term: "Pay", body: "Private payments to a Gloam address or @name, claim links, and payment requests. The relay can submit so your wallet never appears." },
                  { term: "Payroll", body: "Private payroll runs, paid in one go or on a schedule." },
                  { term: "Prove", body: "Proofs of funds, payment and payroll totals, checked at /verify." },
                  {
                    term: "Swap",
                    body: `Private swaps on ${swapMainnets()}${swapV3Live(8453) || swapV3Live(1) ? ", including Uniswap v4 on Base and Ethereum" : ""}: who swapped stays private, the amounts are public.`,
                  },
                  { term: "Cash out", body: "To any wallet, or across chains." },
                ]}
              />
            </Section>

            <Section s={S.roadmap}>
              <div className="wp-road">
                {[
                  {
                    k: "Live",
                    on: true,
                    v: `${liveMainnetsSinceText()}, on the same vault and the final ceremony keys: private add, pay and cash out, the relay, payroll, proofs, private agent payments, private swaps, deposit limits, no admin withdraw and timelocked rules.`,
                  },
                  { k: "Done", v: "Multi-party trusted setup (13 contributors), internal review, and Kann Audits on the vault contracts (no Critical, High or Medium findings, 1 November 2026)." },
                  { k: "Next", v: "A designated-verifier mode for proofs, a larger anonymity set, and monitoring." },
                  { k: "Later", v: "Issuer-scoped disclosure for regulated stablecoins, and a public incident process." },
                  { k: "Retired", v: "The first sealed-swap path. Private swaps replaced it." },
                ].map((r) => (
                  <div key={r.k} className="wp-road-row">
                    <span className={`wp-road-k ${r.on ? "is-on" : ""}`}>{r.k}</span>
                    <p>{r.v}</p>
                  </div>
                ))}
              </div>
            </Section>

            <Section s={S.risks}>
              <ul className="wp-risks">
                <li>Deposit limits cap what the vaults take on mainnet.</li>
                <li>Kann Audits reviewed the vault contracts only; the routers, circuits, app and relay were not part of it, and no review rules out bugs.</li>
                <li>A single owner wallet can change rules after a public 3-day delay, until the owner guard holds that vault.</li>
                <li>Notes live in the browser; a lost device without a backup loses them.</li>
                <li>A payer can reclaim a direct payment until the payee claims it.</li>
                <li>The Gloam team runs the relay; it can refuse or go down, never redirect.</li>
                <li>Swaps show their tokens and amounts and trade on outside venues.</li>
                <li>An issuer can freeze the vault contract; deposits are screened so flagged funds never enter.</li>
                <li>A reader can forward a proof meant for them.</li>
                <li>Regulation around privacy tools is uncertain, and anonymity sets are thin early on.</li>
              </ul>
            </Section>

            <Section s={S.nonClaims}>
              <p>
                Gloam is live on mainnet. It does not claim a full external audit (Kann Audits covered the vault contracts
                only), insurance of funds, legal immunity, or invisibility from investigation. Nothing here is investment
                advice.
              </p>
            </Section>

            <Section s={S.closing}>
              <Pull>Settlement stays public. Salaries, suppliers and strategies need not.</Pull>
              <p>
                Gloam builds the sealed room beside the open book, so people, teams and agents can hold, pay and prove exactly
                what is needed, without printing every private calculation to the street.
              </p>
              <p className="wp-sign">
                gloam.trade · <a href="mailto:hello@gloam.trade">hello@gloam.trade</a> ·{" "}
                <a href="https://x.com/gloamtrade" target="_blank" rel="noreferrer">
                  @gloamtrade
                </a>
              </p>
            </Section>
          </article>
        </div>
      </main>

      <Footer />
    </div>
  );
}
