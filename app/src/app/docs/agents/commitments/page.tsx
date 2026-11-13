import type { Metadata } from "next";
import Link from "next/link";
import { DocsLayout } from "@/components/DocsLayout";

export const metadata: Metadata = {
  title: "Private commerce with commitments",
  description:
    "Agents pay each other privately, and every payment stays checkable against the merkle root your economy already posts on chain. The receipt leaf, the exact encoding, how to check a record, and the calls an agent signs.",
  alternates: { canonical: "/docs/agents/commitments" },
};

const REPO = "https://github.com/gloamtrade/gloam/tree/main";
const EXAMPLE = `${REPO}/examples/san-verano`;

const CHECKS: { id: string; confirms: string; needs: string }[] = [
  { id: "leaf", confirms: "The leaf recomputes from the record.", needs: "Nothing" },
  { id: "fields", confirms: "The asset and amounts written in the record match the proof.", needs: "Nothing" },
  { id: "context", confirms: "The label, expiry, chain and vault are the ones sealed into the proof.", needs: "Nothing" },
  { id: "vault", confirms: "The record names Gloam's vault on that chain, and the chain is a mainnet. A testnet record fails here unless you pass allowTestnet.", needs: "Nothing" },
  { id: "snark", confirms: "The zero-knowledge proof verifies against the receipt checking key.", needs: "verifySnark" },
  { id: "chain", confirms: "The client reads the record's chain.", needs: "client" },
  { id: "root", confirms: "The vault has had the proof's root. The vault keeps every root it ever had.", needs: "client" },
  { id: "payment", confirms: "The transaction succeeded and its Transferred event created this note as the payment, not as change.", needs: "client" },
];

const CALLS: { call: string; selector: string; on: string; does: string }[] = [
  { call: "approve(address,uint256)", selector: "0x095ea7b3", on: "each token", does: "Lets the vault pull the exact deposit. Spender is the vault." },
  { call: "shieldBound(address,uint256,bytes32,bytes)", selector: "0x67e763e0", on: "vault", does: "Deposit into the private balance. The amount is public." },
  { call: "transfer(bytes,bytes32,bytes32,bytes32[2])", selector: "0xd02dddd1", on: "vault", does: "Private send, and a payee's sweep. No amount or payee on chain." },
  { call: "unshield(bytes,bytes32,bytes32,address,address,uint256)", selector: "0x67cca6c5", on: "vault", does: "Cash out to a public address. Amount and recipient are public." },
  { call: "postMemo(bytes32,bytes)", selector: "0x82301844", on: "payment board", does: "Posts the sealed payment so the payee finds it. Optional." },
];

export default function DocsCommitmentsPage() {
  return (
    <DocsLayout
      title="Private commerce with commitments"
      lede="Many agent economies already post a merkle root of their records on chain every night, and that root is how anyone checks them. Gloam payments fit into it: the payment is private, its receipt becomes one leaf in your root, and anyone holding the record can check it later without the amount or the payee ever going public."
      glance={[
        { label: "Payment", value: "a real vault transfer" },
        { label: "In your root", value: "one bytes32 leaf" },
        { label: "Checked", value: "off chain, any time" },
        { label: "Burns", value: "stay public" },
      ]}
      quickLinks={[
        { href: EXAMPLE, label: "Reference integration" },
        { href: "/docs/proofs", label: "Proofs" },
        { href: "/docs/agents", label: "Agents" },
        { href: "/verify", label: "Check a proof" },
      ]}
    >
      <h2 id="why">Why this matters</h2>
      <p>
        A game city, a marketplace or an agent network can keep its books off
        chain and still be checkable: it commits a root of its records each
        night, and anyone can prove a record is in it. Payments are the part that
        usually stays fully public, because they settle in public stablecoin
        transfers. That shows every agent&apos;s suppliers, prices and balance.
      </p>
      <p>
        The question is how private payments stay compatible with the
        commitments you already post. The answer is that each private payment
        leaves a proof you can commit to, exactly like any other record.
      </p>

      <h2 id="how">How it fits</h2>
      <ol>
        <li>
          <strong>Pay privately.</strong> The paying agent sends a private
          payment from its private balance to the payee&apos;s Gloam address. It
          is a real vault transaction the agent signs itself. On chain it shows
          a nullifier and two commitments, no amount and no payee.
        </li>
        <li>
          <strong>The payee secures it.</strong> The payee opens the payment and
          moves it into a note only it knows. Until then the payer could still
          spend it back, so the payment is final only after this sweep.
        </li>
        <li>
          <strong>Prove it.</strong> The payer proves the payment with the receipt
          circuit: a private payment of this asset, at least this much (or
          exactly this much, if you choose), is in the vault. The proof is bound
          to a label you pick, such as a record id, and an expiry.
        </li>
        <li>
          <strong>Commit it.</strong> You hash that proof into one{" "}
          <code>bytes32</code> leaf and put it in your nightly root with your
          other records.
        </li>
        <li>
          <strong>Check it, any time.</strong> Anyone holding the record checks
          the leaf is in the root, the proof is valid, the vault had that state,
          and the named transaction made the payment.
        </li>
      </ol>
      <p>
        Public transfers you rely on stay public. If your economy burns tokens
        on each sale and reads that trail, keep sending the burn as a normal
        token transfer next to the private payment.
      </p>

      <h2 id="pay">Pay and plan the receipt</h2>
      <p>
        <code>buildPrivatePaymentWithReceipt</code> builds the private send to a
        receive tag, seals the payment so only the payee opens it, and returns
        the plan for the receipt. It signs and sends nothing.
      </p>
      <pre>
        <code>{`import {
  mainnetNetwork, buildPrivatePaymentWithReceipt, buildPaymentReceipt,
  POOL_TRANSFER_ABI, transferCallArgs, syncTree, artifactProver, proveGroth16,
} from "@gloamtrade/sdk";

const net = mainnetNetwork("robinhood")!;

const pay = await buildPrivatePaymentWithReceipt({
  payTo: supplierTag,                      // the payee's gloamr1.… address
  chainId: net.chainId,
  asset: usdg.address,
  amountWei: parseUnits("25", 6),
  from: { secretHex: note.secret, amountWei: note.amount, path },  // the payer's private note
  prove: transferProver,                   // artifactProver over transfer.wasm + final/transfer_final.zkey
  note: "order 8812",                      // only the payee reads it
  receipt: { verifier: "nightly-root:sale:8812" },  // sealed into the proof
});

// The agent signs the private send, then posts the sealed payment for the payee.
const txHash = await wallet.writeContract({
  address: net.pool, abi: POOL_TRANSFER_ABI, functionName: "transfer", args: transferCallArgs(pay.intent),
});
if (pay.memo) await wallet.writeContract(pay.memo);
// Keep pay.changeNote: it is the rest of the agent's balance.`}</code>
      </pre>

      <h2 id="prove">Prove it and make the leaf</h2>
      <p>
        Once the transfer has landed, sync the tree and prove. This works after
        the payee has swept the payment too.
      </p>
      <pre>
        <code>{`const synced = await syncTree(client, { pool: net.pool, fromBlock: net.deployBlock });
const record = await buildPaymentReceipt({
  plan: pay.receiptPlan,
  path: (await synced.pathForCommitment(pay.paymentNote.commitment))!,
  txHash,
  prove: (input) => proveGroth16(input, "receipt.wasm", "final/receipt_final.zkey"),
});

record.leaf   // the bytes32 to put in tonight's root
// Store the record next to it, off chain. It holds no secret.`}</code>
      </pre>

      <h2 id="leaf">The leaf, exactly</h2>
      <pre>
        <code>{`keccak256(abi.encode(
  string  "gloam.receipt-leaf.v1",
  uint256 chainId,
  address pool,           // the vault
  bytes32 txHash,         // the vault transfer that made the payment
  uint256[7] signals      // the receipt's public signals, in circuit order:
                          // [root, commitment, asset, minAmount, reveal, shownAmount, context]
))`}</code>
      </pre>
      <p>
        <code>abi.encode</code>, not <code>encodePacked</code>. In Solidity it is
        one line, and a contract can recompute it from the record:
      </p>
      <pre>
        <code>{`bytes32 leaf = keccak256(abi.encode("gloam.receipt-leaf.v1", chainId, pool, txHash, signals)); // uint256[7]`}</code>
      </pre>
      <p>
        In TypeScript it is <code>paymentReceiptLeaf(record)</code>, and{" "}
        <code>verifyPaymentReceiptLeaf(leaf, record)</code> recomputes and
        compares. The SDK&apos;s tests pin a vector that Solidity and{" "}
        <code>cast</code> both reproduce. A new encoding would get a new domain
        tag, never a silent change.
      </p>
      <p>
        The <code>context</code> signal is{" "}
        <code>proofContext(&#123; kind: &quot;payment&quot;, chainId, pool, verifier, expiresAt &#125;)</code>,
        so the leaf also commits to the label and expiry. Treat the leaf as one
        more value in your tree: if your tree hashes leaves again, hash this one
        the same way.
      </p>

      <h2 id="check">Checking a record</h2>
      <p>
        <code>checkPaymentReceipt(record, &#123; verifySnark, client &#125;)</code>{" "}
        runs every check and reports each one. <code>ok</code> is true only when
        all eight ran and passed. Check the leaf against your root with your own
        merkle proof, as for any record.
      </p>
      <p>
        A record from a Gloam testnet is never <code>ok</code> by default. Test value
        is free, and Base Sepolia and Ethereum Sepolia share the mainnet vault address,
        so a testnet receipt can look like a real one. The result names the record&apos;s{" "}
        <code>network</code> and says whether it is a <code>testnet</code>; pass{" "}
        <code>allowTestnet: true</code> only while you test. Build your chain client from
        the chains you accept, not from the record&apos;s chain id.
      </p>
      <table>
        <thead>
          <tr>
            <th>Check</th>
            <th>What it confirms</th>
            <th>Needs</th>
          </tr>
        </thead>
        <tbody>
          {CHECKS.map((c) => (
            <tr key={c.id}>
              <td>
                <code>{c.id}</code>
              </td>
              <td>{c.confirms}</td>
              <td>{c.needs}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <pre>
        <code>{`import { checkPaymentReceipt, verifyGroth16 } from "@gloamtrade/sdk";
import receiptVkey from "./receipt_vkey.json";   // gloam.trade/circuits/final/receipt_vkey.json on mainnet

// The chains you accept, mainnets only. Never build the client from record.chainId alone.
const ACCEPT = { 8453: baseClient, 4663: robinhoodClient };
const client = ACCEPT[record.chainId];
if (!client) throw new Error("We don't take payments on that chain.");

const result = await checkPaymentReceipt(record, {
  leaf: leafFromYourRoot,
  verifySnark: (signals, proof) => verifyGroth16(receiptVkey, signals, proof),
  client,                                          // a viem PublicClient on the record's chain
});
// result.ok is false for a testnet record unless you pass allowTestnet: true.
// result.network and result.testnet say which chain it came from.`}</code>
      </pre>
      <p>
        A record is also a Gloam proof of payment:{" "}
        <code>paymentProofText(record)</code> gives <code>gloampay1:…</code>,
        which anyone can paste into <Link href="/verify">/verify</Link> or check
        through the <Link href="/docs/partners">partner API</Link>. The record
        has an expiry (30 days by default). Your root does not expire, so{" "}
        <code>checkPaymentReceipt</code> reports <code>expired</code> apart from{" "}
        <code>ok</code>; /verify fails a proof past its expiry.
      </p>

      <h2 id="allowlist">What an agent signs</h2>
      <p>
        If your agents sign only from an allowlist,{" "}
        <code>agentSigningAllowlist(&#123; chainId, assets &#125;)</code> returns
        every call they sign to use Gloam on a chain, with the contract, the
        signature, the selector and the rules to enforce. Native value is 0 on
        every one.
      </p>
      <table>
        <thead>
          <tr>
            <th>Call</th>
            <th>Selector</th>
            <th>On</th>
            <th>What it does</th>
          </tr>
        </thead>
        <tbody>
          {CALLS.map((c) => (
            <tr key={c.selector}>
              <td>
                <code>{c.call}</code>
              </td>
              <td>
                <code>{c.selector}</code>
              </td>
              <td>{c.on}</td>
              <td>{c.does}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p>
        A payment needs only <code>transfer</code> and <code>postMemo</code>, and{" "}
        <code>postMemo</code> is optional: an economy that already passes
        messages between agents can hand the payee the sealed payment directly.
        The vault checks a proof on <code>shieldBound</code>,{" "}
        <code>transfer</code> and <code>unshield</code> that binds every
        argument, so an edited call reverts instead of sending money elsewhere.
      </p>

      <h2 id="public">What is public and what is not</h2>
      <ul>
        <li>
          <strong>Public:</strong> deposits (amount and asset), cash outs
          (amount, asset, recipient), public transfers such as burns, your
          nightly root, and that an agent&apos;s wallet sent a vault transaction
          at a given time.
        </li>
        <li>
          <strong>Private:</strong> how much each payment was, who received it,
          and each agent&apos;s private balance.
        </li>
        <li>
          <strong>The signer shows.</strong> An agent that signs its own vault
          transfer is that transaction&apos;s sender: the amount and the payee
          stay hidden, the fact that it paid someone privately does not. The
          Gloam relay (<code>relayIntent</code>, <code>relayMemo</code>) sends it
          instead, and can only submit or refuse, never redirect money.
        </li>
        <li>
          <strong>Records show what is in them.</strong> Whoever sees a record
          sees its asset, its minimum (or amount, if revealed) and its
          transaction hash. Publish only the root to keep records private.
        </li>
        <li>
          <strong>A receipt does not show who got paid.</strong> The payer picks
          the payment note&apos;s key, so both sides can make the same proof. Who
          the payment was for comes from your record and its label.
        </li>
      </ul>

      <h2 id="limits">Limits worth knowing</h2>
      <ul>
        <li>
          <strong>No on-chain receipt verifier.</strong> The vault verifies the
          deposit, transfer and cash-out proofs it takes. Receipt proofs are
          checked off chain, with snarkjs and the published checking key. A
          contract can recompute the leaf and check your merkle path today;
          checking the receipt proof itself on chain would need a receipt
          verifier contract, which does not exist yet.
        </li>
        <li>
          <strong>Mainnet.</strong> Mainnet runs on the final keys of the
          13-contributor trusted setup, with deposit limits. It had an
          internal review on 20 October 2026, and Kann Audits reviewed the vault
          contracts (<Link href="/security">report, 1 November 2026</Link>) and found no Critical, High or Medium issues.
          The circuits and the SDK were not part of that review.
        </li>
      </ul>

      <h2 id="example">Reference integration</h2>
      <p>
        A runnable{" "}
        <a href={EXAMPLE} target="_blank" rel="noreferrer">
          reference integration
        </a>{" "}
        does the whole flow: a business agent pays a supplier privately, the
        supplier sweeps, the agent proves the payment, the leaf goes into a
        nightly root, and a public burn sits next to it. By default it is a dry
        run with no keys and no network; it also runs on Robinhood Chain
        testnet. See also <Link href="/docs/proofs">Proofs</Link> and{" "}
        <Link href="/docs/agents">Agents</Link>.
      </p>
    </DocsLayout>
  );
}
