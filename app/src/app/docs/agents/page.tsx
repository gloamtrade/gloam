import type { Metadata } from "next";
import Link from "next/link";
import { DocsLayout } from "@/components/DocsLayout";
import { swapMainnets } from "@/lib/vaultSwap";
import { liveMainnetNames } from "@/lib/mainnet";
import { ELYSIUM_ENABLED } from "@/lib/elysium";
import { CASH_OUT_FEE_PERCENT } from "@/lib/cashOutFee";

export const metadata: Metadata = {
  title: "Agents",
  description:
    `Give an AI agent private payments on ${liveMainnetNames()}: shield, pay, and disclose end to end via @gloamtrade/sdk and the @gloamtrade/mcp server, under policy.`,
};

export default function DocsAgentsPage() {
  return (
    <DocsLayout
      title="Build a private agent"
      lede={`Give an AI agent private payments on ${liveMainnetNames()}. It holds, pays and gets paid with amounts and payees hidden, proves what it holds when asked, and signs under policy.`}
      glance={[
        { label: "SDK", value: "@gloamtrade/sdk" },
        { label: "Server", value: "@gloamtrade/mcp (MCP)" },
        { label: "Example", value: "examples/agent-shield" },
        { label: "Secrets", value: "server-side only" },
      ]}
      quickLinks={[
        { href: "/docs/sdk", label: "SDK" },
        { href: "/docs/sdk/disclosure", label: "Selective disclosure" },
        { href: "/docs/virtuals", label: "Virtuals agents" },
        { href: "/docs/integrate", label: "Agent kits and marketplaces" },
      ]}
    >
      <h2>Why agents need this most</h2>
      <p>
        An agent paying on a public chain shows every payment: who it paid, how
        much and when, for anyone to read or copy. Agents pay often and in
        patterns, so they are easy to follow. With Gloam an agent holds, pays and
        gets paid with the amounts and payees hidden. Money going in and out of
        the vault stays public. Private swaps in the Gloam app hide who swapped,
        not the tokens or the amounts, and agents can&apos;t swap through the SDK
        or the MCP server yet.
      </p>

      <h2>Two ways in</h2>
      <p>
        Both speak the same intent shape, so a plan an app builds and a plan an
        agent builds are the same object.
      </p>
      <ul>
        <li>
          <strong>Directly via <code>@gloamtrade/sdk</code>.</strong> Your agent
          framework builds an intent and signs it with its own wallet. Best when
          the agent already has an execution loop.
        </li>
        <li>
          <strong>Via the <code>@gloamtrade/mcp</code> server.</strong> An
          MCP-speaking model (Claude, etc.) gets Gloam as tools alongside its
          other capabilities, the same way Robinhood&apos;s own MCP exposes
          public trading. Best for a general assistant that should also act
          privately.
        </li>
      </ul>

      <h2 id="virtuals">For Virtuals agents</h2>
      <p>
        Agents built on GAME get Gloam as one worker:{" "}
        <code>@gloamtrade/game-plugin-gloam</code> gives a Virtuals agent a
        private balance, private payments, cash outs and proofs of funds, under
        per-asset limits its owner sets. A companion provider pays out privately
        on ACP, so the job stays on ACP&apos;s contracts while who got paid, and
        how much, stays private.
      </p>
      <p>
        <Link href="/docs/virtuals">Gloam for Virtuals agents</Link> covers
        setup, every function, the limits, exactly what stays public, and the
        networks.
      </p>

      <h2 id="kits">For agent kits and marketplaces</h2>
      <p>
        Building a kit other people&apos;s agents run on, or an x402 marketplace?{" "}
        <Link href="/docs/integrate">Add Gloam to your agent kit or marketplace</Link>{" "}
        covers a drop-in tool pack that previews every payment before your
        wallet signs it, bundling this MCP server next to yours, and taking
        private x402 payments next to standard ones.
      </p>

      <h2 id="connect-by-url">Connect by URL</h2>
      <p>
        The quickest way to try Gloam from a chat. Gloam runs a hosted MCP
        server, so you add it to your client by URL and install nothing.
      </p>
      <pre>
        <code>https://www.gloam.trade/mcp</code>
      </pre>
      <ul>
        <li>
          <strong>Claude</strong> (claude.ai and Claude Desktop): Settings,
          Connectors, Add custom connector, then paste the URL.
        </li>
        <li>
          <strong>ChatGPT</strong>: Settings, Apps and connectors. Turn on
          developer mode, then create a connector with the URL and no
          authentication.
        </li>
        <li>
          <strong>Claude Code</strong>:{" "}
          <code>claude mcp add --transport http gloam-hosted https://www.gloam.trade/mcp</code>
        </li>
        <li>
          <strong>Cursor, VS Code and other clients</strong>: add it as a remote
          server, for example{" "}
          <code>{`{ "mcpServers": { "gloam-hosted": { "url": "https://www.gloam.trade/mcp" } } }`}</code>
        </li>
      </ul>
      <p>The hosted server reads and plans. It has these tools:</p>
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
                <code>gloam_info</code> / <code>gloam_networks</code>
              </td>
              <td>
                What Gloam is; each network&apos;s vault, assets and explorer, on
                mainnet and testnet, with faucets for the testnets
              </td>
            </tr>
            <tr>
              <td>
                <code>gloam_vault_stats</code>
              </td>
              <td>Public vault totals, as on the transparency page. No wallets</td>
            </tr>
            <tr>
              <td>
                <code>gloam_create_payment_request</code>
              </td>
              <td>A link that asks someone to pay your Gloam address privately</td>
            </tr>
            <tr>
              <td>
                <code>gloam_verify_proof</code>
              </td>
              <td>
                Check a proof of funds, proof of payment, payroll total or balance
                disclosure, with the same checks as <Link href="/verify">/verify</Link>
              </td>
            </tr>
            <tr>
              <td>
                <code>gloam_plan_deposit</code>
              </td>
              <td>The steps and app link for a private deposit, and what is public</td>
            </tr>
            <tr>
              <td>
                <code>gloam_mpp_how_to</code>
              </td>
              <td>
                Pay or charge privately over MPP with{" "}
                <code>@gloamtrade/mppx-gloam</code>, with code
              </td>
            </tr>
            <tr>
              <td>
                <code>gloam_connect_full_agent</code>
              </td>
              <td>Commands to install the local server that signs and pays</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p>
        It never signs, never holds funds, and never needs a private key, a
        recovery phrase or a note secret. A tool call that looks like it carries
        one is refused with a warning not to share it, and nothing is kept. When
        something has to be signed, it sends you to the app, or to the local{" "}
        <a href="#the-mcp-server">MCP server</a>, which keeps keys on your own
        machine.
      </p>

      <h2 id="fund-link">Fund an agent with one link</h2>
      <p>
        A platform can send its users to one link that opens Gloam with the
        agent&apos;s address, the amount, the token and the network filled in.
        Nothing is sent on its own: the user checks it and confirms.
      </p>
      <pre>
        <code>{`https://gloam.trade/app/vault?tab=move&mode=pay#to=<address>&amount=<amount>&asset=<token>&chain=<network>&name=<name>&note=<note>`}</code>
      </pre>
      <ul>
        <li>
          <code>to</code>: a 0x address, an ENS name, or a Gloam address
          (<code>gloamr1.…</code>). A 0x address with mixed case must have a
          valid checksum; the zero address is refused.
        </li>
        <li>
          <code>amount</code>: optional, in whole tokens (<code>25</code>,{" "}
          <code>12.5</code>). It is only filled in when <code>asset</code> names
          a token Gloam knows on that network.
        </li>
        <li>
          <code>asset</code>: the token&apos;s symbol or address on that network,
          for example <code>USDG</code> on Robinhood Chain.
        </li>
        <li>
          <code>chain</code>: <code>robinhood-mainnet</code>,{" "}
          <code>tempo-mainnet</code>, <code>base-mainnet</code> or{" "}
          <code>ethereum-mainnet</code> for mainnet. <code>robinhood</code>,{" "}
          <code>tempo</code>, <code>base</code> and <code>ethereum</code> are
          the testnets.
        </li>
        <li>
          <code>name</code> (up to 40 characters) and <code>note</code> (up to
          80): optional. The note is sealed inside a payment to a Gloam address;
          for a 0x address or ENS name it is only shown to the payer.
        </li>
      </ul>
      <p>
        Keep the fields after the <code>#</code>: browsers never send that part
        to a server. A Gloam address opens Pay and makes a private payment,
        free, with the amount hidden. A 0x address or an ENS name opens Cash out
        to that wallet: the relay sends it from the user&apos;s private balance
        for {CASH_OUT_FEE_PERCENT}, so their wallet does not show, while the receiving wallet,
        the token and the amount are public. An ENS name is looked up on
        Ethereum mainnet and paid on the network the link names. A field that
        does not check out is left blank, with the reason shown to the user.
      </p>

      <h2 id="top-ups">Keep an agent topped up</h2>
      <p>
        An owner can refill an agent&apos;s wallet from their private balance on
        a schedule, with Gloam closed. Open{" "}
        <Link href="/app/vault?tab=topups">Agent top-ups</Link> in the Vault and
        pick the agent&apos;s wallet, a stablecoin, an amount, how often (weekly
        or every 2 weeks) and how many.
      </p>
      <p>
        The whole total is paid for up front. Proofs are made in the browser, so
        nothing can make one later on its own. The app splits the total into one
        private balance per top-up, proves one cash out of each to the
        agent&apos;s wallet, and hands each proof to the Gloam relay with its own
        day. The relay picks a random time inside that UTC day and sends it. A
        proof fixes the amount and the wallet, so the relay can send it as it is
        or not at all, and it holds no spending key. Proofs are kept encrypted, so
        reading the relay&apos;s store alone gives nobody a proof to send.
      </p>
      <ul>
        <li>
          <strong>Up to about 90 days ahead.</strong> That is 12 top-ups weekly,
          or 7 every 2 weeks. Start a new series for longer.
        </li>
        <li>
          <strong>Cancel any top-up before it goes.</strong> The money stays in
          the vault until then. A proof stays valid until its private balance is
          spent, so a cancelled top-up, or one the relay can&apos;t send, first
          moves to a fresh private balance. That ends the old proof, and the
          money shows in your balance once the move lands.
        </li>
        <li>
          <strong>Not from a fresh deposit.</strong> A proof carries the vault
          root it was made against, and a top-up sent with Gloam closed keeps that
          root. So a series can only start 6 hours after the deposit behind it,
          once 3 more deposits or payments from others have reached the vault. The
          screen says when you can start. A payment you received has no deposit of
          yours to point at, so it does not wait.
        </li>
        <li>
          <strong>Setup takes about a minute per top-up,</strong> with the tab
          open. If it stops, nothing is lost: what was scheduled still goes out,
          the rest stays in your private balance, and you can finish the series
          from the same screen.
        </li>
        <li>
          <strong>Each top-up pays the usual {CASH_OUT_FEE_PERCENT} cash-out fee,</strong> taken
          from that top-up when it goes out, at the vault&apos;s rate that day.
          A proof fixes the amount and the agent&apos;s wallet, not the fee, so if
          the fee goes up, the top-ups still ahead pay the agent less. The screen
          shows what each one will pay, and you can cancel any that hasn&apos;t
          gone.
        </li>
        <li>
          <strong>An alert if one fails, if you want one.</strong> Give an https
          address and the relay posts <code>status</code>, <code>series</code>{" "}
          and <code>at</code> to it when a top-up fails or is held. Nothing else
          is sent, but whoever runs that address learns when it happened. The
          address is kept encrypted with the job.
        </li>
        <li>
          <strong>On Robinhood Chain, Tempo{ELYSIUM_ENABLED ? ", Base and Elysium" : " and Base"}.</strong> They aren&apos;t
          offered on Ethereum: each one takes two relay transactions, and gas
          there costs more than the fee brings in.
        </li>
      </ul>
      <p>
        Each top-up is a public cash out: its amount, the agent&apos;s wallet and
        the time show on the explorer, and they all land in one wallet, so anyone
        can add them up. Only where the money came from stays private. The agent
        needs its own gas: top-ups send stablecoins only, so on Robinhood Chain,
        where ETH isn&apos;t held in the vault, and on Base it needs ETH from
        somewhere else{ELYSIUM_ENABLED ? ", and HYPE on Elysium" : ""}.
      </p>
      <p>
        Keep your backup current after setting one up. The proofs wait with the
        relay, but the balances behind them, and the only way to cancel, are in
        your browser.
      </p>

      <h2>Reference agent (the SDK path)</h2>
      <p>
        <code>examples/agent-shield</code> is the smallest complete agent: it
        mints a note, generates the shield proof, and deposits privately via{" "}
        <code>shieldBound</code>. The whole private path is a few lines.
      </p>
      <pre>
        <code>{`import { buildShieldBoundIntent, artifactProver } from "@gloamtrade/sdk";
import { parseEther } from "viem";

// 1) SDK mints the note + generates the shield proof
const intent = await buildShieldBoundIntent({
  amountWei: parseEther("0.001"),
  prover: artifactProver({ wasm: "shield.wasm", zkey: "shield_final.zkey" }),
});

// 2) the agent signs the resolved call with its (server-held) wallet
const hash = await wallet.writeContract({
  address: intent.exec.poolAddress,
  abi: shieldPoolAbi,
  functionName: intent.exec.fn,   // "shieldBound"
  args: intent.exec.args,
  value: intent.exec.valueWei,
});
// persist intent.note.secret in the agent's note store, keyed by commitment`}</code>
      </pre>
      <p>
        That snippet runs on the testnet, the SDK default. For mainnet,
        pass a mainnet network (<code>mainnetNetwork(&quot;tempo&quot;)</code>,{" "}
        <code>&quot;robinhood&quot;</code>, <code>&quot;base&quot;</code> or{" "}
        <code>&quot;ethereum&quot;</code>), its stablecoin as <code>asset</code>,
        and prove with <code>circuitArtifactUrls(&quot;shield&quot;, net.chainId)</code>{" "}
        so the final keys are used. See the <Link href="/docs/quickstart">quickstart</Link>.
      </p>
      <p>
        From there the agent can cash out, pay a receive tag, or prove a balance
        to a counterparty with a <Link href="/docs/sdk/disclosure">disclosure</Link>,
        all with the same core.
      </p>

      <h2>The MCP server</h2>
      <p>
        Run it on your own machine with <code>npx -y @gloamtrade/mcp</code>. It
        signs there, under the spending limits below, and keeps keys and note
        secrets off the model.
      </p>
      <p>
        <code>@gloamtrade/mcp</code> exposes Gloam as tools to any MCP client. It keeps
        two phases separate on purpose: planning tools build an unsigned intent
        and describe, in plain language, what is private and what is not;
        execution tools take a plan, sign it server-side, and broadcast.
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
                <code>gloam_info</code> / <code>gloam_privacy_status</code>
              </td>
              <td>What Gloam is; the honest current privacy posture (read)</td>
            </tr>
            <tr>
              <td>
                <code>gloam_swap_quote</code>
              </td>
              <td>The price of a private swap, and anything that would stop it (read)</td>
            </tr>
            <tr>
              <td>
                <code>gloam_execute_private_swap</code> / <code>gloam_finish_swap</code>
              </td>
              <td>A private swap proved locally and sent through the Gloam relay, under the spending limits (&quot;swap&quot; must be listed); bring back a swap whose money waits at its escrow</td>
            </tr>
            <tr>
              <td>
                <code>gloam_plan_shield</code>
              </td>
              <td>Build an unsigned intent an agent can reason over (plan)</td>
            </tr>
            <tr>
              <td>
                <code>gloam_execute_shield</code>
              </td>
              <td>
                Real private deposit: mint a note, prove, and broadcast{" "}
                <code>shieldBound</code> server-side (execute)
              </td>
            </tr>
            <tr>
              <td>
                <code>gloam_execute_transfer</code>
              </td>
              <td>Sign + broadcast a public testnet transfer for funding (execute)</td>
            </tr>
            <tr>
              <td>
                <code>gloam_payment_requirements</code> /{" "}
                <code>gloam_verify_payment</code>
              </td>
              <td>
                Price a resource in a private x402 payment, and verify a presented
                one (server)
              </td>
            </tr>
            <tr>
              <td>
                <code>gloam_pay_x402</code>
              </td>
              <td>
                Plan the self-custodial private payment that satisfies a 402
                challenge (agent)
              </td>
            </tr>
            <tr>
              <td>
                <code>gloam_execute_private_pay</code>
              </td>
              <td>
                Settle that payment from one of the agent&apos;s notes, by handle,
                sealed to the payee (execute)
              </td>
            </tr>
            <tr>
              <td>
                <code>gloam_fetch_paid</code>
              </td>
              <td>
                Fetch a URL and, on a Gloam 402, pay privately and retry, all inside
                the server (execute)
              </td>
            </tr>
            <tr>
              <td>
                <code>gloam_list_notes</code> / <code>gloam_receive_tag</code>
              </td>
              <td>
                The agent&apos;s balances as handles, never secrets, and the tag
                others pay it at (read)
              </td>
            </tr>
            <tr>
              <td>
                <code>gloam_get_limits</code> /{" "}
                <code>gloam_get_spending_report</code>
              </td>
              <td>
                The agent&apos;s spending limits, and what it spent and has left in the
                last 24 hours (read)
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <h2>Private agent payments (x402)</h2>
      <p>
        Agents pay for tools and data over HTTP 402. The pattern that won
        Colosseum paired x402 with stablecoins, but that settlement is fully
        public: the amount, the payer, and the payee all leak. Gloam&apos;s{" "}
        <code>gloam-private</code> scheme keeps it private and self-custodial. The
        agent settles a shielded transfer to the payee itself, so no operator or
        facilitator ever holds its key or funds, then presents the payment note,
        sealed to the payee&apos;s receive tag, plus the settlement transaction on
        the 402 retry. The payee opens the note and moves it into a fresh note
        only it knows before serving, so the payer cannot spend it back. The
        public sees only shielded transfers.
      </p>
      <p>
        <strong>This is not a Tempo Zone.</strong> A Zone is operator-visible:
        the zone operator sees every transaction inside it. Gloam is private from
        the public and from any operator; only the payer and the payee learn the
        amount. Compliance visibility is opt-in per payment through an
        issuer-scoped disclosure, not a blanket view handed to an operator. See
        the <Link href="/docs/privacy-model">privacy model</Link> for what stays
        hidden and what does not.
      </p>
      <p>
        An economy that posts a merkle root of its records every night can keep
        agent payments private and still checkable: each payment&apos;s receipt
        becomes one leaf in that root. See{" "}
        <Link href="/docs/agents/commitments">private commerce with commitments</Link>.
      </p>

      <h2 id="check-before-paying">Check before paying (Agent Wormhole)</h2>
      <p>
        A 402 is text the payee wrote, and an agent reads it before it pays. The
        MCP server can send each payment request to{" "}
        <a href="https://agentwormhole.com" target="_blank" rel="noreferrer">
          Agent Wormhole
        </a>{" "}
        first, which scans it for hidden instructions and tells whether it
        changed since it was first seen. The payment goes ahead only on an allow.
        A refusal, an abstain, findings, an error or no answer within five
        seconds all mean the agent does not pay, and nothing is spent.
      </p>
      <p>
        It is off until you turn it on. Put your Agent Wormhole key in the
        server&apos;s settings (<code>~/.gloam/agent.env</code>) or its
        environment:
      </p>
      <pre>
        <code>GLOAM_WORMHOLE_KEY=your-agent-wormhole-key</code>
      </pre>
      <p>
        Agent Wormhole sees the payment request and nothing else: never a note,
        a balance, the wallet or a key.
      </p>

      <h2 id="check-budget-before-paying">Check the budget before paying (VEYA)</h2>
      <p>
        A Gloam note is spent with a proof, so wallet rules can&apos;t stop a
        payment. A budget only holds before the payment, on the server that
        keeps the notes. The MCP server can ask{" "}
        <a href="https://veyanet.tech" target="_blank" rel="noreferrer">
          VEYA
        </a>{" "}
        whether the agent&apos;s budget covers each payment, and only an allow
        pays. A refusal, any other answer, an error, a bad setting or no answer
        within five seconds all mean the agent does not pay, and nothing is
        spent. With Agent Wormhole on too, it goes first, and both must allow.
      </p>
      <p>
        It is off until you turn it on. Put these in the server&apos;s settings
        (<code>~/.gloam/agent.env</code>) or its environment. The agent id is
        one you choose, and a wallet address is refused:
      </p>
      <pre>
        <code>{`GLOAM_VEYA_KEY=your-veya-key
GLOAM_VEYA_URL=https://api.veyanet.tech/guard/v1/check
GLOAM_VEYA_AGENT_ID=an-id-you-choose`}</code>
      </pre>
      <p>
        VEYA covers USDG on Robinhood Chain. A payment on another chain or in
        another asset is refused, so with the check on, the server pays only in
        USDG on Robinhood Chain.
      </p>
      <p>
        With this on, VEYA sees the agent id, the chain, the asset, the amount
        and the payee during the check, and nothing else. It gets no resource
        host and no payment request text, so it learns nothing about what was
        bought. It never sees a note, a secret, a balance, a wallet or a key.
        What VEYA keeps after the check is VEYA&apos;s to say. If VEYA ever
        needs more than this to answer, the payment is refused and nothing is
        spent.
      </p>
      <p>
        This server enforces the check, off-chain. The vault does not know about
        it, so it binds the agent only while the notes and the key are held by
        this server and nowhere else. If a payment fails after an allow,
        VEYA&apos;s running budget may sit ahead of what was really paid.
      </p>
      <p>
        VEYA checks payments: <code>gloam_execute_private_pay</code> and{" "}
        <code>gloam_fetch_paid</code>. These go through the spending limits but
        not through VEYA: <code>gloam_execute_transfer</code>, a public send of
        test ETH on Robinhood Chain testnet, and a private swap or a
        swap&apos;s exit to an address, which only run when the owner lists{" "}
        <code>swap</code> in the limits. Leave <code>swap</code> out if every
        private spend must pass VEYA. A price of zero or less is refused before
        any check, with the limits on or off.
      </p>
      <h3>The receipt after a payment</h3>
      <p>
        VEYA&apos;s allow carries a check id. Set{" "}
        <code>GLOAM_VEYA_ANCHOR_URL</code> to{" "}
        <code>https://api.veyanet.tech/guard/v1/anchor</code> as well, on the
        same origin as the check URL since the key goes to both, and the
        server proves each payment once it lands, with that id as the
        receipt&apos;s verifier, and
        hashes the proof into one <code>bytes32</code> leaf. VEYA gets that leaf
        and the agent id, nothing else: never the record, the proof, the amount,
        the payee, a note or the transaction hash. VEYA writes the leaf to{" "}
        <code>storeCommitment</code>, so you need no anchoring wallet.
      </p>
      <p>
        With receipts on, an allow without a usable check id does not pay,
        because a payment can&apos;t be undone and it could never get its
        receipt. The payment&apos;s answer, with its credential, never waits on
        the receipt: it comes back as soon as the payment lands, with the
        receipt <code>pending</code>, and the receipt is built after it, so a
        challenge can&apos;t expire meanwhile and push the agent to pay twice.
        Keep the server running until the receipt is done.{" "}
        <code>gloam_retry_veya_receipts</code> shows where it stands and tries
        again without paying anything, after <code>anchor_failed</code> or{" "}
        <code>receipt_failed</code>. A leaf goes to VEYA only once its record is
        saved, so one payment never gets two leaves.{" "}
        <code>anchored</code> means VEYA named the leaf and the
        transaction that wrote it, given as <code>anchorTx</code>; the server
        does not read the chain to confirm the write. VEYA writes a leaf once,
        so sending the same one again is safe, and it answers with the first
        transaction.
      </p>
      <p>
        The server keeps the full record in its encrypted note store. It shows
        the asset, the minimum amount and the transaction hash, so no tool hands
        it to the agent. See <code>examples/veya-receipt</code>.
      </p>
      <p>
        What a receipt proves: a payment of at least the stated amount, in that
        asset, made by that transaction into the vault, tied to VEYA&apos;s
        check id. It does not prove who received it, since the payee stays
        private, or that anything was delivered for it. The leaf on chain
        proves only that VEYA wrote that leaf; whoever holds the record checks
        the rest with <code>checkPaymentReceipt</code>.
      </p>

      <h2>Spending limits</h2>
      <p>
        An agent that can sign can spend, so the owner sets its limits and every
        tool that moves money (pay, send, shield) checks them before anything is
        proved or signed. A spend that breaks a limit is refused with a plain
        reason the agent can act on, for example &ldquo;that would bring today to
        14 PathUSD, over the limit of 12 a day&rdquo;.
      </p>
      <div className="overflow-x-auto">
        <table>
          <thead>
            <tr>
              <th>Limit</th>
              <th>Meaning</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Assets</td>
              <td>Which stablecoins or tokens the agent may move, matched by contract address</td>
            </tr>
            <tr>
              <td>Per payment</td>
              <td>The most it may send in one payment</td>
            </tr>
            <tr>
              <td>Per day</td>
              <td>The most it may send in any 24 hours</td>
            </tr>
            <tr>
              <td>Recipients</td>
              <td>Anyone, or only the payees you list</td>
            </tr>
            <tr>
              <td>Expiry</td>
              <td>A date after which the agent cannot spend at all</td>
            </tr>
            <tr>
              <td>Tools</td>
              <td>Which of pay, send and shield it may use</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p>
        No limits means no spending: a server with a key but no limits refuses
        every spend until you set them (or turn them off on purpose). Every
        spend is logged before it is signed, under a lock, so two calls at once
        cannot both squeeze under the daily cap. Configuration lives in the{" "}
        <a href="https://github.com/gloamtrade/gloam/tree/main/mcp#spending-limits">
          MCP README
        </a>
        .
      </p>
      <p>
        <strong>Where they are enforced.</strong> These limits are enforced by the
        MCP server you run, off-chain, not by the vault contract. They stop a
        confused or manipulated agent; they do not stop someone who has the raw
        key. For that, use a policy wallet underneath, as below.
      </p>
      <p>
        <strong>The agent never holds the money itself.</strong> A private balance
        is a note, and whoever knows its secret can spend it, so the server keeps
        every note in an encrypted store and gives the agent short handles
        instead. A payment it makes is sealed to the payee&apos;s receive tag, so
        the agent cannot open that either. What limits still cannot stop: an agent
        tricked into spending within its limits to a payee you allowed.
      </p>

      <h2>Policy and key custody</h2>
      <p>
        Signing keys live <strong>server-side only</strong> and never enter a
        model context or a log. Before an agent runs on mainnet,
        swap the test key for a Turnkey server wallet with policy the agent
        cannot override: spend caps, an
        allow-list of contracts and markets, and size privacy always on. An
        out-of-policy action is refused, not quietly clamped.
      </p>

      <h2>Honesty</h2>
      <p>
        No fabricated fills, ever. If a private path is not live, the tool says so
        and returns a plan rather than a fake success.{" "}
        <Link href="/docs/private-swaps">Private swaps</Link> are live on the{" "}
        {swapMainnets()} mainnets, in the Gloam app, the SDK (<code>buildSwapIntent</code>) and the
        MCP server (<code>gloam_execute_private_swap</code>): a swap hides who swapped, not the
        tokens or the amounts. The old sealed trade is retired. Shield, private send, cash out,
        swaps and disclosure are proof-gated. Mainnet uses the final keys from the 13-contributor
        ceremony; testnet runs on dev-ceremony keys. The code was reviewed
        internally before launch, and Kann Audits reviewed the vault contracts
        (<Link href="/security">report, 1 November 2026</Link>) and found no Critical, High or Medium issues. The SDK
        and the MCP server were not part of that review. Start an agent on
        small limits and raise them as you go.
      </p>
    </DocsLayout>
  );
}
