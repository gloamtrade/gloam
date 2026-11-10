import type { Metadata } from "next";
import Link from "next/link";
import { DocsLayout } from "@/components/DocsLayout";
import { liveMainnetNames, mainnetPool } from "@/lib/mainnet";
import { swapMainnets } from "@/lib/vaultSwap";
import { ELYSIUM, ELYSIUM_TESTNET } from "@/lib/elysium";
import { CASH_OUT_FEE_BPS, CASH_OUT_FEE_PERCENT } from "@/lib/cashOutFee";

const MAINNETS = liveMainnetNames();

/** Mainnet chain ids as the guardrails list them, Base and Ethereum once their pools are in (lib/mainnet.ts). */
const MAINNET_IDS = [
  "Robinhood Chain 4663",
  "Tempo 4217",
  ...(mainnetPool(8453) ? ["Base 8453"] : []),
  ...(mainnetPool(1) ? ["Ethereum 1"] : []),
  // Elysium, only while it is on (lib/elysium.ts)
  ...(ELYSIUM ? [`Elysium ${ELYSIUM.chainId}`] : []),
].join(", ");
const MAINNET_CHAIN_IDS = [4663, 4217, ...(mainnetPool(8453) ? [8453] : []), ...(mainnetPool(1) ? [1] : []), ...(ELYSIUM ? [ELYSIUM.chainId] : [])].join(" · ");

export const metadata: Metadata = {
  title: "SDK",
  description:
    `@gloamtrade/sdk: add private balances, private payments, and selective disclosure to any app or agent on ${MAINNETS}, on mainnet or testnet. The privacy layer as a package.`,
};

export default function DocsSdkPage() {
  return (
    <DocsLayout
      title="SDK"
      lede={`The privacy layer for ${MAINNETS}, as a package. Give any app or agent shielded balances, private payments, and selective disclosure, without building a proving stack from scratch.`}
      glance={[
        { label: "Package", value: "@gloamtrade/sdk" },
        { label: "Runtime", value: "browser + node" },
        { label: "Chains", value: `Mainnet ${MAINNET_CHAIN_IDS}, testnet 46630 · 42431 · 84532 · 11155111${ELYSIUM_TESTNET ? " · 99801" : ""}` },
        { label: "Proofs", value: "Groth16 + Poseidon" },
      ]}
      quickLinks={[
        { href: "/docs/sdk/disclosure", label: "Selective disclosure" },
        { href: "/docs/agents", label: "Build a private agent" },
        { href: "/docs/encryption", label: "How shield works" },
        { href: "/docs/privacy-model", label: "Privacy model" },
      ]}
    >
      <h2>What Gloam gives your app</h2>
      <p>
        {MAINNETS} are public: every balance, size, and move is
        visible. Gloam is the shielded chamber on top of them, and{" "}
        <code>@gloamtrade/sdk</code> is that chamber as a dependency. The Gloam
        vault app is the reference implementation, not a special case: the same
        core runs in your app.
      </p>
      <ul>
        <li>
          <strong>Shielded balances.</strong> Deposit stablecoins (and $GLOAM on
          Robinhood Chain) into a private balance only the holder can see or
          spend. The testnets also take test ETH and stock tokens.
        </li>
        <li>
          <strong>Private payments.</strong> Send inside the vault to a receive
          tag, with on-chain encrypted discovery.
        </li>
        <li>
          <strong>Selective disclosure.</strong> Let a holder prove one balance
          to a chosen party, such as an auditor or a counterparty, revealing
          nothing else. See <Link href="/docs/sdk/disclosure">the guide</Link>.
        </li>
        <li>
          <strong>Cash out.</strong> Unshield to a public balance with a real
          browser- or node-generated Groth16 proof.
        </li>
      </ul>

      <h2>Install</h2>
      <p>
        The SDK ships TypeScript source, consumed through your bundler (Next{" "}
        <code>transpilePackages</code>, Vite, tsx), the same way the reference
        app uses it. <code>snarkjs</code> is an optional peer, needed only when
        you generate proofs (shield, unshield, disclosure).
      </p>
      <pre>
        <code>{`npm install @gloamtrade/sdk viem
npm install snarkjs   # optional peer, for proving`}</code>
      </pre>

      <h2 id="networks">Mainnet and testnet</h2>
      <p>
        From 0.1.0 the SDK knows the Robinhood Chain and Tempo mainnets and
        testnets; 0.3.0 adds Base and Base Sepolia, and 0.4.0 Ethereum and
        Ethereum Sepolia. The builders still default to Robinhood Chain testnet
        so older code keeps working, so pass a mainnet network explicitly.
      </p>
      <ul>
        <li>
          <code>mainnetNetwork(&quot;robinhood&quot; | &quot;tempo&quot; | &quot;base&quot; | &quot;ethereum&quot;)</code>{" "}
          returns a mainnet <code>GloamNetwork</code>, or <code>null</code> until
          its pool is published. <code>gloamNetworks()</code> lists every network
          Gloam runs on right now, mainnets first. <code>getGloamNetwork(key)</code>{" "}
          takes <code>&quot;robinhood-mainnet&quot;</code>,{" "}
          <code>&quot;tempo-mainnet&quot;</code>, <code>&quot;base-mainnet&quot;</code>,{" "}
          <code>&quot;ethereum-mainnet&quot;</code>, <code>&quot;robinhood&quot;</code>,{" "}
          <code>&quot;tempo&quot;</code>, <code>&quot;base&quot;</code> (Base Sepolia) or{" "}
          <code>&quot;ethereum&quot;</code> (Ethereum Sepolia).
        </li>
        <li>
          <code>GLOAM_NETWORKS.robinhood</code> and <code>.tempo</code> stay the
          testnets, unchanged.
        </li>
        <li>
          Builders resolve the pool from <code>chainId</code> when{" "}
          <code>poolAddress</code> is left out, and refuse a mainnet chain whose
          pool is not in the SDK yet.
        </li>
        <li>
          <strong>Mainnet proofs must use the final keys</strong> from the
          13-contributor ceremony. <code>circuitArtifactUrls(circuit, chainId)</code>{" "}
          picks the right set for the chain; <code>ceremonyForChainId</code> tells
          you which one it is.
        </li>
        <li>
          On Robinhood Chain mainnet the pool takes USDG (
          <code>RH_MAINNET_USDG</code>), $GLOAM (<code>GLOAM_TOKEN</code>), PONS (
          <code>RH_MAINNET_PONS</code>) and CASHCAT (
          <code>RH_MAINNET_CASHCAT</code>), native ETH (
          <code>NATIVE_ASSET</code>), AI (<code>RH_MAINNET_AI</code>) and ORBIO (
          <code>RH_MAINNET_ORBIO</code>). On Tempo mainnet it takes <code>TEMPO_USDCE</code>,{" "}
          <code>TEMPO_PATHUSD</code>, <code>TEMPO_USDT0</code> and{" "}
          <code>TEMPO_OUSD</code>.
        </li>
        <li>
          Deposit limits: 50,000 per deposit and 2,500,000 in total for
          each stablecoin; $GLOAM 2,500,000 per deposit and 25,000,000 in total.
          Each network&apos;s <code>assets</code> carry a snapshot in{" "}
          <code>depositLimit</code>; <code>readDepositLimit</code> reads the
          live limit from the vault.
        </li>
        <li>
          A mainnet cash out costs {CASH_OUT_FEE_PERCENT} (<code>CASH_OUT_FEE_BPS = {CASH_OUT_FEE_BPS}</code>);{" "}
          <code>cashOutFee(amount)</code> is what the pool keeps. The pool takes
          it when the cash out lands, so for a rate that matters read{" "}
          <code>readCashOutFeeBps(client, pool)</code>. Direct deposits and
          private payments are free.
        </li>
      </ul>

      <h2>The model</h2>
      <p>
        Gloam is a shielded pool. A private balance is a <strong>note</strong>:
      </p>
      <pre>
        <code>{`commitment = Poseidon(secret, amount, asset)
nullifier  = Poseidon(secret, commitment)`}</code>
      </pre>
      <p>
        Shielding inserts the <code>commitment</code> as a leaf in a depth-20
        incremental Merkle tree; the <code>secret</code> is the only spend
        authority and never leaves the client. Spending (send, cash out, trade)
        proves in zero knowledge that you know the secret for a commitment in the
        tree, and publishes the <code>nullifier</code> so it cannot be spent
        twice, without revealing which note. The chain verifies a Groth16 proof,
        never your identity or size. Nothing is a mock; if a path cannot be
        private, it waits.
      </p>

      <h2>Quickstart: shield privately</h2>
      <p>
        The hardened pool enforces a proof at deposit (audit C1), so plain{" "}
        <code>shield()</code> reverts. <code>buildShieldBoundIntent</code> mints
        the note <em>and</em> generates the shield proof; you sign the resolved
        call.
      </p>
      <pre>
        <code>{`import {
  mainnetNetwork, buildShieldBoundIntent, artifactProver,
  circuitArtifactUrls, TEMPO_USDCE,
} from "@gloamtrade/sdk";

const net = mainnetNetwork("tempo");          // null until the pool is published
if (!net) throw new Error("Tempo mainnet pool not published yet");

const intent = await buildShieldBoundIntent({
  chainId: net.chainId,
  poolAddress: net.pool,
  asset: TEMPO_USDCE,
  amountWei: 25_000_000n,                    // 25 USDC.e (6 decimals); the limit is 50,000 per deposit
  prover: artifactProver(circuitArtifactUrls("shield", net.chainId)),
});

// approve the pool for the token first (it pulls it with transferFrom), then
// sign intent.exec: a ready shieldBound(asset, amount, commitment, proof) call.
// intent.note.secret is the spend key. PERSIST IT.
await wallet.writeContract({
  address: intent.exec.poolAddress,
  abi: shieldPoolAbi,
  functionName: intent.exec.fn,      // "shieldBound"
  args: intent.exec.args,
});`}</code>
      </pre>
      <p>
        To test it on testnet first, use <code>GLOAM_NETWORKS.tempo</code>{" "}
        (or <code>GLOAM_NETWORKS.robinhood</code>, where you can also shield
        test ETH) as <code>net</code>; the same code proves with the dev keys
        there. A complete runnable agent is in{" "}
        <code>examples/agent-shield</code>. See{" "}
        <Link href="/docs/quickstart">the quickstart</Link> and{" "}
        <Link href="/docs/agents">Build a private agent</Link>.
      </p>

      <h2>Intents: plan and exec</h2>
      <p>
        Every action is an <strong>intent</strong> with two layers. The{" "}
        <strong>plan</strong> is portable and safe to log or hand to an agent
        (symbol, amount, no secrets). The <strong>exec</strong> resolves the
        on-chain call (wei amounts, resolved addresses, proof args). The SDK and
        the <Link href="/docs/agents">agent server</Link> share one intent shape.
      </p>
      <div className="overflow-x-auto">
        <table>
          <thead>
            <tr>
              <th>Builder</th>
              <th>Resolves</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <code>buildShieldBoundIntent</code>
              </td>
              <td>
                Mints a note + shield proof → <code>shieldBound(...)</code> (the
                live deposit path)
              </td>
            </tr>
            <tr>
              <td>
                <code>buildShieldIntent</code>
              </td>
              <td>
                Plain <code>shield(...)</code>, only for pools without a shield
                verifier
              </td>
            </tr>
            <tr>
              <td>
                <code>buildUnshieldIntent</code>
              </td>
              <td>
                Witness + proof → <code>unshield(...)</code> (cash out)
              </td>
            </tr>
            <tr>
              <td>
                <code>buildPrivateSendIntent</code>
              </td>
              <td>
                Transfer witness → <code>transfer(...)</code> to a receive tag
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <h2>API surface</h2>
      <h3>Notes</h3>
      <pre>
        <code>{`import { makeBoundNotePoseidon, noteNullifierPoseidon } from "@gloamtrade/sdk";

const note = await makeBoundNotePoseidon(amountWei, assetAddress);
// { secret, commitment, secretField, commitmentField }
const nullifier = await noteNullifierPoseidon(note.secretField, note.commitmentField);`}</code>
      </pre>
      <h3>Prover (injected)</h3>
      <p>
        Proving is environment-bound, so it is passed in. <code>artifactProver</code>{" "}
        binds snarkjs to your circuit artifacts (paths in node, URLs in the
        browser); <code>proveGroth16</code> is the one-shot form.
      </p>
      <pre>
        <code>{`import { artifactProver, proveGroth16 } from "@gloamtrade/sdk";

const prover = artifactProver({ wasm, zkey });
const { proofBytes, publicSignals } = await prover(circomInput);`}</code>
      </pre>
      <h3>Merkle</h3>
      <p>
        A depth-20 incremental tree and a circom path builder
        (<code>buildPoseidonMerklePath</code>) for spend proofs. Rebuild the tree
        from the pool&apos;s <code>Shielded</code> events, then prove membership.
      </p>
      <h3>Rates &amp; privacy</h3>
      <p>
        Pure sealed-rate math (<code>exactSealedAmounts</code>) and the
        size-privacy floor policy (<code>publicAmountOutMin</code>), proven
        against the circuit equality{" "}
        <code>amountOut·rateOut = amountSwap·rateIn</code>.
      </p>
      <h3>Constants</h3>
      <p>
        <code>SEALED_VAULT</code> (the hardened Robinhood Chain testnet pool),{" "}
        <code>SHIELD_VERIFIER</code>, <code>NATIVE_ASSET</code>, the chain ids,
        and for mainnet <code>MAINNET_POOLS</code>, the asset addresses and{" "}
        <code>MAINNET_POSEIDON_T3</code>. The default <code>SEALED_VAULT</code>{" "}
        is the hardened C1/C2/C3 pool, never the retired <code>0x4F38</code>{" "}
        pool.
      </p>

      <h2>Integration patterns</h2>
      <ul>
        <li>
          <strong>Private balances in your app.</strong> Shield with{" "}
          <code>buildShieldBoundIntent</code>, persist <code>note.secret</code>{" "}
          in your own store keyed by commitment, cash out with the unshield
          builder.
        </li>
        <li>
          <strong>Private payments.</strong> Send to a receive tag; the recipient
          scans the encrypted <code>GloamPayMemo</code> inbox and opens the note
          (on mainnet, until it has a board, the payer hands over the sealed
          code). See <Link href="/docs/private-pay">Private pay</Link> and{" "}
          <a href="#receive">Take payments and read their notes</a>.
        </li>
        <li>
          <strong>Compliance without opacity.</strong> A holder proves one
          balance to an auditor via a <Link href="/docs/sdk/disclosure">disclosure</Link>,
          revealing nothing else.
        </li>
        <li>
          <strong>Autonomous agents.</strong> The same core runs server-side, so
          an AI agent can hold and move value privately under policy. See{" "}
          <Link href="/docs/agents">Agents</Link>.
        </li>
      </ul>

      <h2 id="receive">Take payments and read their notes</h2>
      <p>
        New in 0.2.0. A service can ask to be paid privately, with a note on
        each payment (an invoice number, an agent ID), and credit each payment
        by its note. Only your key reads the note, and nothing on chain ties the
        payer to it.
      </p>
      <ol>
        <li>
          <strong>Hold a receive key.</strong> <code>generateReceiveKey()</code>{" "}
          gives you a Gloam address (<code>gloamr1.…</code>) to share and a
          private key to keep on your server.
        </li>
        <li>
          <strong>Make a request link.</strong>{" "}
          <code>buildPaymentRequestLink</code> builds the same link the Gloam app
          makes: your address, the network, the token, an optional amount, and
          a note of up to 80 characters. A longer note is refused, not cut.
        </li>
        <li>
          <strong>The payer pays it</strong> from their private balance in Gloam.
          The note travels inside the payment, sealed to your address.
        </li>
        <li>
          <strong>Find it.</strong> Where the network has a payment-message
          board, <code>scanIncomingPayments</code> finds every payment sealed to
          your key, with its amount, token and note. It only returns payments
          that are in the vault and not yet spent, read at one block. Resume
          each scan from <code>scannedTo + 1</code>.
        </li>
        <li>
          <strong>Secure it, then credit.</strong> Until you move it, the payer
          could still spend it back. <code>sweepReceivedNote</code> moves it into
          a note only you know, through the Gloam relay, so your server needs no
          gas. Credit the payment only when the sweep returns{" "}
          <code>final: true</code>.
        </li>
      </ol>
      <pre>
        <code>{`import {
  mainnetNetwork, generateReceiveKey, buildPaymentRequestLink,
  scanIncomingPayments, openIncomingPayment, notePackageToExport,
  sweepReceivedNote, sweepChainFromClient, relaySubmitter, findRequestAsset,
} from "@gloamtrade/sdk";

const net = mainnetNetwork("robinhood")!;
const key = await generateReceiveKey();       // keep key.privateJwk secret
const usdg = findRequestAsset(net, "USDG")!;  // the token you credit

const link = buildPaymentRequestLink({
  payTo: key.tag, network: net, asset: "USDG", amount: "25", note: "agent:42",
});

// With a payment-message board: scan for payments to your key.
const { payments, scannedTo } = await scanIncomingPayments({ client, network: net, receiveKey: key });

// Or check a sealed code a payer hands over directly.
const check = await openIncomingPayment({ client, network: net, receiveKey: key, sealedTicket: code });

for (const p of payments) {
  const r = await sweepReceivedNote({
    note: await notePackageToExport(p.notePackage),
    poolAddress: net.pool, chainId: net.chainId, prove,
    chain: sweepChainFromClient(client, { pool: net.pool, fromBlock: net.deployBlock }),
    submit: relaySubmitter(),
    beforeSubmit: (fresh) => saveNote(fresh),  // persist before it is sent
  });
  // Anyone can pay in any token the vault takes: credit only the one you priced in.
  if (r.final && p.asset.toLowerCase() === usdg.address.toLowerCase()) creditAgent(p.note, p.amountWei);
}`}</code>
      </pre>
      <p>
        Every network has a payment-message board, every mainnet included,
        so <code>scanIncomingPayments</code> finds payments to
        your key on its own. A payer can also hand you the sealed code{" "}
        (<code>gloam2t.…</code>) their app shows after paying: check it with{" "}
        <code>openIncomingPayment</code>, which says whether the payment is
        ready, has not landed yet, or was already spent. A complete, runnable
        version is in <code>packages/sdk/examples/receive-and-credit.ts</code>.
      </p>

      <h2>Public inputs are pinned</h2>
      <p>
        The SDK pins the exact public-input ordering the deployed verifiers
        expect, so an integrator cannot drift out of proof compatibility:
      </p>
      <ul>
        <li>
          <strong>shield</strong>, <code>[commitment, amount, asset]</code>
        </li>
        <li>
          <strong>unshield</strong>,{" "}
          <code>[root, nullifier, asset, amount, to]</code>
        </li>
        <li>
          <strong>transfer</strong>,{" "}
          <code>[root, nullifier, newCommitment0, newCommitment1]</code>
        </li>
        <li>
          <strong>sealedSwap</strong>, nine signals ending in{" "}
          <code>amountOutMin, rateIn, rateOut</code>
        </li>
      </ul>

      <h2>Guardrails</h2>
      <p>
        Mainnet ({MAINNET_IDS}) runs on the final ceremony keys, with
        deposit limits, a {CASH_OUT_FEE_PERCENT} cash-out fee. It was reviewed internally before
        launch, and Kann Audits has since reviewed the vault contracts (
        <Link href="/security">report, 1 November 2026</Link>) and found no Critical, High or Medium issues. The SDK was
        not part of that review. The Robinhood Chain and Tempo
        testnets (<code>46630</code>, <code>42431</code>) run on dev-ceremony
        keys with test funds; Base Sepolia (<code>84532</code>) and Ethereum
        Sepolia (<code>11155111</code>) run the final keys with test funds. Real
        privacy only, never a mock success. Note secrets are the sole spend
        authority: persist and protect them. The old sealed trade is retired.{" "}
        <Link href="/docs/private-swaps">Private swaps</Link> run on {swapMainnets()} mainnet,
        and from 0.5.0 the SDK builds them too (<code>quoteSwap</code>, <code>buildSwapIntent</code>,
        and <code>buildSwapRefund</code> / <code>buildSwapExit</code> to get the money back): a swap
        hides who swapped, not the tokens or the amounts. See{" "}
        <Link href="/docs/production">the production gate</Link>.
      </p>
    </DocsLayout>
  );
}
