import type { Metadata } from "next";
import Link from "next/link";
import { DocsLayout } from "@/components/DocsLayout";
import { mainnetPool } from "@/lib/mainnet";
import { CASH_OUT_FEE_PERCENT } from "@/lib/cashOutFee";

export const metadata: Metadata = {
  title: "Virtuals agents",
  description:
    "Private balances and private payments for Virtuals agents, built on GAME, and a provider that pays out privately on ACP. What each function does, the limits, what stays public, and the networks.",
  alternates: { canonical: "/docs/virtuals" },
};

const REPO = "https://github.com/gloamtrade/gloam/tree/main";
const PLUGIN = `${REPO}/packages/game-plugin-gloam`;
const PROVIDER = `${REPO}/examples/virtuals-acp-provider`;

/** Base mainnet turns on here the moment its vault is filled in (lib/mainnet.ts). */
const BASE_MAINNET_LIVE = mainnetPool(8453) !== null;

const ext = { target: "_blank", rel: "noreferrer" } as const;

const FUNCTIONS: { name: string; args: string; does: string; chain: string }[] = [
  {
    name: "gloam_private_balance",
    args: "refresh?",
    does: "The private balance per asset, what the wallet holds publicly, the agent's Gloam address, open claim links, and what its limits leave for today. largestPayment is the most one payment can be right now.",
    chain: "Nothing",
  },
  {
    name: "gloam_add_privately",
    args: "amount, asset?",
    does: "Moves money from the agent's wallet into its private balance (approve, then a deposit into the vault).",
    chain: "The deposit: wallet, asset and amount",
  },
  {
    name: "gloam_pay_privately",
    args: "to, amount?, asset?, note?, seal_to?",
    does: "Pays a Gloam address (gloamr1.…), a payment request link, or \"claim link\" for someone with no Gloam address. The note is a private line only the payee can read.",
    chain: "A private transfer: no amount, no parties",
  },
  {
    name: "gloam_receive",
    args: "mode, amount?, asset?, note?, claim_link?",
    does: "address: the Gloam address to share. request: a payment request link. check: pick up payments sent to the agent and secure them. claim: claim a claim link.",
    chain: "A private transfer, when it secures a payment",
  },
  {
    name: "gloam_cash_out",
    args: "amount, to, asset?",
    does: `From the private balance to a public 0x address. The pool keeps ${CASH_OUT_FEE_PERCENT}.`,
    chain: "The cash out: asset, amount and recipient",
  },
  {
    name: "gloam_prove_funds",
    args: "at_least, for, asset?, expires_in_hours?",
    does: "A gloamfunds1: proof that the agent holds at least an amount, made for one named reader, with an expiry. It shows neither the balance nor which notes back it.",
    chain: "Nothing",
  },
  {
    name: "gloam_verify_proof",
    args: "proof",
    does: "Checks a gloamfunds1: or gloampay1: proof against the chain, with the same checks as gloam.trade/verify. ok is true only when every check passes.",
    chain: "Nothing",
  },
];

const REFUSALS: { code: string; when: string }[] = [
  { code: "limits_unset", when: "No limits were given. Nothing moves until they are." },
  { code: "action_not_allowed", when: "The action (add, pay or cash_out) is not in actions." },
  { code: "asset_not_allowed", when: "The asset has no caps of its own." },
  { code: "over_per_payment", when: "One payment or cash out above maxPerPayment." },
  { code: "over_daily", when: "It would take the last 24 hours above maxPerDay." },
  { code: "recipient_not_allowed", when: "The payee is not on the recipients list." },
  { code: "expired", when: "The limits are past expiresAt." },
];

export default function DocsVirtualsPage() {
  return (
    <DocsLayout
      title="Gloam for Virtuals agents"
      lede="A private balance and private payments for agents built on GAME, and a provider that pays out privately on ACP. Your agent keeps doing business on chain. Its customers, suppliers, prices and balance stop being public."
      glance={[
        { label: "Package", value: "@gloamtrade/game-plugin-gloam" },
        { label: "Built on", value: "GAME" },
        { label: "ACP", value: "Private payout provider" },
        { label: "Networks", value: "Robinhood Chain and Base" },
      ]}
      quickLinks={[
        { href: PLUGIN, label: "Plugin source" },
        { href: PROVIDER, label: "ACP provider source" },
        { href: "/docs/agents", label: "Agents" },
        { href: "/blog/agents-should-not-do-business-in-public", label: "Why we built it" },
      ]}
    >
      <h2 id="why">Why agent commerce needs privacy</h2>
      <p>
        Agents now hire each other. On Virtuals&apos; Agent Commerce Protocol
        (ACP) a client agent opens a job, a provider sets a price, the money
        sits in escrow and is released when the work is approved.{" "}
        <a href="https://os.virtuals.io/acp/overview" {...ext}>
          ACP&apos;s docs
        </a>{" "}
        say every transaction is &ldquo;immutably recorded on-chain for
        auditability and trust&rdquo;. That is what makes a job trustworthy. It
        also means anyone can read the business around it.
      </p>
      <p>A public job tells a competitor, or a bot built to copy you:</p>
      <ul>
        <li>who your customers are, and how often they come back;</li>
        <li>what you charge, and what you pay your own suppliers;</li>
        <li>who you pay, how much, and when;</li>
        <li>how much you hold, and so how much risk you can take.</li>
      </ul>
      <p>
        No human business would publish that. An agent that runs a real
        business should not have to either. Gloam keeps ACP&apos;s escrow
        working as it is and makes the money around it private: a private
        balance in a shielded vault, private payouts, and proofs the agent hands
        to one named reader when a counterparty needs to check something.
      </p>

      <h2 id="install">Install and set up</h2>
      <pre>
        <code>pnpm add @gloamtrade/game-plugin-gloam @virtuals-protocol/game</code>
      </pre>
      <p>
        Give your GAME agent the Gloam worker. The limits are the owner&apos;s:
        each asset has its own caps, and without limits nothing moves.
      </p>
      <pre>
        <code>{`import { GameAgent } from "@virtuals-protocol/game";
import GloamPlugin from "@gloamtrade/game-plugin-gloam";

const gloam = new GloamPlugin({
  limits: {
    recipients: "any",
    assets: { USDC: { maxPerPayment: "5", maxPerDay: "20" } },
  },
  // Claim links are the money itself: they come to your code, never to the planner.
  onClaimLink: (c) => deliverSomehow(c.link),
});

const agent = new GameAgent(process.env.GAME_API_KEY!, {
  name: "Private Treasurer",
  goal: "Pay suppliers privately and prove funds when asked.",
  description: "Pays and gets paid with Gloam.",
  workers: [gloam.getWorker()],
});
await agent.init();
await agent.run(10, { verbose: true });`}</code>
      </pre>
      <p>
        The agent&apos;s own environment holds the key and the settings. None of
        it passes through the planner.
      </p>
      <pre>
        <code className="language-bash">{`# Base Sepolia (testnet) is the default. robinhood-mainnet for mainnet.
GLOAM_NETWORK=base
# The wallet that holds public funds and signs deposits.
GLOAM_AGENT_PRIVATE_KEY=0x...
# Or pass limits in code.
GLOAM_LIMITS_FILE=./limits.json
# Optional: the note store key. Derived from the agent key when unset.
# GLOAM_NOTE_KEY=...
# Optional: send private payments from the wallet, not the Gloam relay.
# GLOAM_SUBMIT=wallet`}</code>
      </pre>
      <p>
        An ACP agent&apos;s Privy smart wallet can sign instead of a local key:{" "}
        <code>{`new GloamPlugin({ sender: await acpCallSender(evmProvider, chainId) })`}</code>
        . Read <a href="#wallet-policies">wallet policies</a> first: the default
        policy does not let that wallet reach the vault yet.
      </p>

      <h2 id="functions">Functions</h2>
      <p>
        Seven GAME functions on one worker. Arguments arrive as strings, and
        amounts are plain numbers in the asset&apos;s units (25 means 25 USDC).
      </p>
      <div className="overflow-x-auto">
        <table className="min-w-[680px]">
          <thead>
            <tr>
              <th>Function</th>
              <th>What it does</th>
              <th>Public on chain</th>
            </tr>
          </thead>
          <tbody>
            {FUNCTIONS.map((f) => (
              <tr key={f.name}>
                <td>
                  <code>{f.name}</code>
                  <br />
                  <span className="text-[13px] text-mute">{f.args}</span>
                </td>
                <td>{f.does}</td>
                <td>{f.chain}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul>
        <li>
          <strong>One payment spends one note.</strong> The most one payment can
          be is the largest note, shown as <code>largestPayment</code>.
        </li>
        <li>
          <strong>A received payment counts once it is secured.</strong>{" "}
          <code>check</code> moves each payment into a fresh note only this agent
          knows, so the payer cannot spend it back.
        </li>
        <li>
          <strong>The relay submits private sends by default.</strong> The
          agent&apos;s wallet does not appear next to its payments. Set{" "}
          <code>GLOAM_SUBMIT=wallet</code> to send from the wallet instead.
        </li>
      </ul>
      <p>
        The engine underneath is <code>GloamAgent</code>{" "}
        (<code>plugin.agent</code>), usable without GAME: <code>add</code>, <code>pay</code>,{" "}
        <code>payByClaimLink</code>, <code>requestPayment</code>,{" "}
        <code>checkIncoming</code>, <code>claim</code>, <code>cashOut</code>,{" "}
        <code>proveFunds</code>, <code>provePayment</code> and{" "}
        <code>verifyProof</code>. The ACP provider below uses it directly, and
        the <Link href="/docs/integrate">tool pack for agent kits</Link> is
        built on it.
      </p>

      <h2 id="limits">Limits</h2>
      <pre>
        <code>{`{
  "recipients": "any",
  "actions": ["add", "pay", "cash_out"],
  "expiresAt": "2026-12-31",
  "assets": {
    "USDC": { "maxPerPayment": "5", "maxPerDay": "20" },
    "ETH": { "maxPerPayment": "0.002", "maxPerDay": "0.01" }
  }
}`}</code>
      </pre>
      <ul>
        <li>
          <strong>Every asset has its own caps</strong>, in its own units. One
          number for all assets is refused, because &ldquo;50&rdquo; would mean
          50 USDC and 50 ETH.
        </li>
        <li>
          <strong>Caps cover money leaving the agent</strong>: payments and cash
          outs, over a rolling 24 hours. Adding to its own private balance is
          allowed or not, never capped, so a provider adding its earnings does
          not use up its payout budget.
        </li>
        <li>
          <strong>Recipients</strong> is <code>&quot;any&quot;</code> or a list of
          Gloam addresses, 0x addresses for cash outs, and{" "}
          <code>&quot;claim-link&quot;</code>.
        </li>
        <li>
          <strong>Assets are matched by chain and contract address</strong>,
          never by a symbol someone else wrote.
        </li>
        <li>
          <strong>Every spend is logged before it is signed</strong>, under a
          lock, so two calls at once cannot both squeeze under the daily cap.
        </li>
      </ul>
      <p>A refusal comes back with a code and a plain reason the agent can act on:</p>
      <div className="overflow-x-auto">
        <table>
          <thead>
            <tr>
              <th>Code</th>
              <th>When</th>
            </tr>
          </thead>
          <tbody>
            {REFUSALS.map((r) => (
              <tr key={r.code}>
                <td>
                  <code>{r.code}</code>
                </td>
                <td>{r.when}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p>
        <strong>Where they hold.</strong> The plugin enforces the limits before
        it signs. The vault contract does not know them, so they bind the agent,
        not whoever holds its key outside the plugin. The MCP server&apos;s
        limits file works too, as long as each asset has its own caps.
      </p>

      <h2 id="planner">What the planner sees</h2>
      <p>
        GAME&apos;s planner is a hosted model. It reads each function&apos;s
        description, what the function returns, and the worker&apos;s
        environment, every step. So the plugin keeps the money out of reach:
      </p>
      <ul>
        <li>No function takes a key, a note or a secret as an argument.</li>
        <li>
          Notes live in an encrypted file on the agent&apos;s machine
          (AES-256-GCM), named to the planner only by handle.
        </li>
        <li>
          Claim links go to your <code>onClaimLink</code>, or sealed to a Gloam
          address. Never to the planner.
        </li>
        <li>
          Every result and every log line is checked for secrets the process has
          handled, and anything shaped like a claim code, before it leaves.
        </li>
      </ul>
      <p>
        The planner does see amounts, handles, hashes, Gloam addresses and
        proofs. Pass <code>shareBalances: false</code> to keep balances out of
        the environment it reads.
      </p>

      <h2 id="acp">Private payouts on ACP</h2>
      <p>
        <a href={PROVIDER} {...ext}>
          <code>examples/virtuals-acp-provider</code>
        </a>{" "}
        is a provider agent with one service, <strong>private payout</strong>. A
        client agent hires it with a list of who to pay and how much. The
        provider pays each recipient privately from its Gloam balance and
        delivers a proof of each payment, sealed to the client.
      </p>
      <ol>
        <li>
          The client opens a fund-transfer job, using ACP&apos;s
          FundTransferHook, and evaluates it itself.
        </li>
        <li>
          The provider sets its fee. When the client funds, the fee goes into
          escrow and the payout total goes from the client to the provider in
          the same transaction.
        </li>
        <li>
          The provider pays each recipient privately and makes a{" "}
          <code>gloampay1:</code> proof of each payment.
        </li>
        <li>
          It submits the deliverable sealed to the client&apos;s Gloam address.
          The client checks the proofs and completes the job, and the escrow
          pays the fee.
        </li>
        <li>
          Later, the provider adds what it received to its private balance in
          round batches, so its deposits do not line up with any one job.
        </li>
      </ol>
      <p>The requirement the client sends with the job:</p>
      <pre>
        <code className="language-json">{`{
  "payouts": [
    { "to": "gloamr1.…", "amount": "7", "note": "march" },
    { "to": "claim-link", "amount": "3" }
  ],
  "replyTo": "gloamr1.…"
}`}</code>
      </pre>
      <p>
        Or the same list sealed to the provider&apos;s Gloam address, so
        Virtuals&apos; ACP backend, which stores the requirement, cannot read
        it:
      </p>
      <pre>
        <code className="language-json">{`{ "sealedPayouts": "gloam2t.…", "replyTo": "gloamr1.…" }`}</code>
      </pre>
      <p>Rules the provider keeps:</p>
      <ul>
        <li>
          <strong>Payouts never depend on the escrow.</strong> A private payout
          cannot be undone, and a self-evaluating client may reject a funded
          job and take the escrow back, as{" "}
          <a href="https://eips.ethereum.org/EIPS/eip-8183" {...ext}>
            ERC-8183
          </a>{" "}
          allows. That is why the payout total travels outside the escrow. A
          client that rejects gets its fee back from the escrow and any unpaid
          principal back from the provider.
        </li>
        <li>It quotes only when one private note covers the whole job.</li>
        <li>
          Its fee is 0.5%, at least 0.05, grossed up for ACP&apos;s cut, which
          it reads from the contract.
        </li>
        <li>
          It never submits a job it could not pay in full. It writes down each
          payout and refund before sending it, with no secrets in the record, and
          a refund whose answer is lost waits for the owner instead of going out
          again.
        </li>
        <li>Plain escrow jobs only from clients the owner trusts.</li>
      </ul>
      <p>
        <strong>Status.</strong> The provider is open-source example code. It
        ran end to end on local forks of Base Sepolia and Robinhood Chain
        mainnet, against ACP&apos;s own contracts and Gloam&apos;s vaults, with
        fresh keys and nothing sent to a live network. It is not registered on
        ACP yet, and it runs on testnet only for now. <code>scripts/live.mts</code> wires the same provider into{" "}
        <code>@virtuals-protocol/acp-node-v2</code>.
      </p>

      <h2 id="public">What stays public</h2>
      <p>
        ACP&apos;s contracts are public, and Gloam does not change that. Exactly
        what anyone can read for one private payout job:
      </p>
      <p>
        <strong>On chain, from ACP:</strong>
      </p>
      <ul>
        <li>
          the job: client, provider, evaluator, expiry, and the offering name{" "}
          <code>gloam_private_payout</code>;
        </li>
        <li>the fee in escrow, and the escrow paying it and ACP&apos;s cut;</li>
        <li>the payout total moving from the client to the provider at funding;</li>
        <li>the hash of the deliverable.</li>
      </ul>
      <p>
        <strong>On Virtuals&apos; ACP backend:</strong> the requirement and
        deliverable messages. With <code>sealedPayouts</code> and{" "}
        <code>replyTo</code> both are sealed, so it stores ciphertext only.
      </p>
      <p>
        <strong>From Gloam:</strong> the provider&apos;s deposits of what it
        earned, batched and rounded, and any cash out (asset, amount and
        recipient).
      </p>
      <p>
        <strong>Private:</strong> who was paid and how much each. A payout is a
        private transfer: the chain shows a spent marker and two new commitments,
        not the recipient, not the amount, and not that this provider sent it,
        since the Gloam relay submits it. The agent&apos;s private balance is
        private too.
      </p>
      <p>
        One habit gives that back: a recipient who cashes out the exact amount
        right after being paid is easy to match by amount and time. Cash out a
        different amount, or later.
      </p>

      <h2 id="wallet-policies">Wallet policies</h2>
      <p>
        Every ACP agent wallet signer runs under a{" "}
        <a href="https://os.virtuals.io/agent-identity/wallet/overview" {...ext}>
          wallet policy
        </a>
        , checked on every transaction. The default, Virtuals Only{" "}
        (<code>ACP_ONLY</code>), allows only Virtuals-approved destinations. The
        Gloam vault is not one of them yet, so an ACP wallet on that policy
        cannot add to a private balance.
      </p>
      <p>Until it is, either:</p>
      <ul>
        <li>
          give the signer a custom policy that allows the Gloam vault{" "}
          <code>0x39e28cde55cab798874746ac52cb4b5cc99a0194</code> and the
          token&apos;s approve to it (the owner approves the change in
          Virtuals&apos; dashboard); or
        </li>
        <li>
          run the plugin with its own key (<code>GLOAM_AGENT_PRIVATE_KEY</code>)
          and send ACP earnings to that wallet.
        </li>
      </ul>

      <h2 id="networks">Networks</h2>
      <p>
        One vault address on every chain:{" "}
        <code>0x39e28cde55cab798874746ac52cb4b5cc99a0194</code>. Virtuals agents
        live on Base and Robinhood Chain, so those come first.
      </p>
      <div className="overflow-x-auto">
        <table className="min-w-[600px]">
          <thead>
            <tr>
              <th>
                <code>GLOAM_NETWORK</code>
              </th>
              <th>Network</th>
              <th>Status</th>
              <th>Assets</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <code>robinhood-mainnet</code>
              </td>
              <td>Robinhood Chain mainnet</td>
              <td>Live, deposit limits</td>
              <td>USDG, GLOAM, PONS, CASHCAT, ETH, AI and ORBIO</td>
            </tr>
            <tr>
              <td>
                <code>base-mainnet</code>
              </td>
              <td>Base mainnet</td>
              <td>{BASE_MAINNET_LIVE ? "Live, deposit limits" : "Next. Refused until its vault is live"}</td>
              <td>USDC, EURC, USDT, ETH</td>
            </tr>
            <tr>
              <td>
                <code>base</code> (default)
              </td>
              <td>Base Sepolia testnet</td>
              <td>Live</td>
              <td>USDC, EURC, ETH</td>
            </tr>
            <tr>
              <td>
                <code>tempo-mainnet</code>
              </td>
              <td>Tempo mainnet</td>
              <td>Live, deposit limits</td>
              <td>USDC.e, pathUSD, USDT0, OUSD</td>
            </tr>
          </tbody>
        </table>
      </div>
      <ul>
        <li>
          <strong>Deposit limits on mainnet:</strong> 50,000 of a stablecoin per
          deposit and 2,500,000 in total per stablecoin.
        </li>
        <li>
          <strong>ACP and the vault take the same money.</strong> ACP pays in
          USDG on Robinhood Chain and in USDC on Base, both assets the Gloam
          vault takes there.
        </li>
        <li>
          <strong>On Base Sepolia</strong> ACP&apos;s escrow takes its fee in
          Virtuals&apos; own test token, which the vault does not list, so only
          the payout total can go in privately there.
        </li>
      </ul>
      <p>
        Chain IDs, RPCs and explorers are on{" "}
        <Link href="/docs/chain">Networks</Link>.
      </p>

      <h2 id="faq">FAQ</h2>
      <h3>Is this made by Virtuals?</h3>
      <p>
        No. Gloam built it for Virtuals agents, on the GAME framework and
        against ACP&apos;s public contracts. It is Gloam&apos;s own open-source
        plugin, not a Virtuals product.
      </p>
      <h3>Does Gloam hold my agent&apos;s money?</h3>
      <p>
        No. The money sits in the vault contract, which has no admin withdraw,
        and only the agent holds the secrets to its notes. The relay can submit
        a payment or refuse it. It cannot move or redirect money.
      </p>
      <h3>Does it hide the ACP job?</h3>
      <p>
        No. The job, the escrowed fee and the payout total stay public, as{" "}
        <a href="#public">above</a>. The payouts and the balance are what go
        private.
      </p>
      <h3>Do I need GAME?</h3>
      <p>
        No. <code>GloamAgent</code> works on its own, which is how the ACP
        provider uses it. Agents on other frameworks can also use{" "}
        <Link href="/docs/agents">the MCP server or the SDK</Link>.
      </p>
      <h3>Is there a Python version?</h3>
      <p>
        Not yet. ACP&apos;s current SDK is TypeScript{" "}
        (<code>@virtuals-protocol/acp-node-v2</code>), so the plugin is too.
      </p>
      <h3>What does it cost?</h3>
      <p>
        Adding money directly and paying privately are free. A cash out costs {CASH_OUT_FEE_PERCENT}. The
        payout provider charges 0.5%, at least 0.05, and ACP takes its own fees
        on what is escrowed.
      </p>
      <h3>Can I try it without mainnet funds?</h3>
      <p>
        Yes. <code>GLOAM_NETWORK=base</code> is Base Sepolia, a testnet, and the
        default. The plugin and the provider also run whole flows on a local
        fork with one command each; see their READMEs.
      </p>
      <h3>Is mainnet ready for my agent?</h3>
      <p>
        Mainnet is live with deposit limits. The code was reviewed
        internally before launch, and Kann Audits reviewed the vault contracts (<Link href="/security">report, 1 November 2026</Link>) and
        found no Critical, High or Medium issues. The plugin, SDK and relay were not part of that
        review. Start an agent on small limits and raise them
        as you go.
      </p>
    </DocsLayout>
  );
}
