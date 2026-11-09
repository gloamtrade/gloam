import type { Metadata } from "next";
import Link from "next/link";
import { DocsLayout } from "@/components/DocsLayout";
import { mainnetPool } from "@/lib/mainnet";
import { swapMainnets } from "@/lib/vaultSwap";
import { ELYSIUM } from "@/lib/elysium";

/** Mainnets whose pool is not in yet (lib/mainnet.ts): "Base mainnet and Ethereum" until their deploys. */
const NOT_YET = [mainnetPool(8453) ? null : "Base mainnet", mainnetPool(1) ? null : "Ethereum"].filter(Boolean).join(" and ");

export const metadata: Metadata = {
  title: "API reference",
  description:
    "The complete @gloamtrade/sdk surface: intent builders, mainnet and testnet networks, note and prover primitives, incremental Merkle tree, sealed-rate math, and constants. One barrel import.",
};

export default function DocsSdkReferencePage() {
  return (
    <DocsLayout
      title="API reference"
      lede="The complete @gloamtrade/sdk surface. Everything exports from one barrel; the crypto core is pure and runs anywhere, and proving and storage are injected so the same code serves a browser app and a node agent."
      glance={[
        { label: "Package", value: "@gloamtrade/sdk" },
        { label: "Import", value: "one barrel" },
        { label: "Core", value: "pure, isomorphic" },
        { label: "Injected", value: "prover, storage" },
      ]}
      quickLinks={[
        { href: "/docs/quickstart", label: "Quickstart" },
        { href: "/docs/sdk", label: "SDK overview" },
        { href: "/docs/sdk/disclosure", label: "Selective disclosure" },
        { href: "/docs/agents", label: "Agents" },
      ]}
    >
      <h2>Import</h2>
      <p>
        One entry point. Tree-shake what you do not use. <code>viem</code> types
        (<code>Address</code>, <code>Hex</code>) flow through the surface;{" "}
        <code>snarkjs</code> is a lazy peer, imported only inside{" "}
        <code>proveGroth16</code>.
      </p>
      <pre>
        <code>{`import {
  buildShieldBoundIntent, buildUnshieldIntent, buildPrivateSendIntent,
  makeBoundNotePoseidon, artifactProver,
  syncTree, IncrementalMerkleTreePoseidon,
  mainnetNetwork, gloamNetworks, circuitArtifactUrls, cashOutFee,
  SEALED_VAULT, NATIVE_ASSET,
} from "@gloamtrade/sdk";`}</code>
      </pre>

      {/* ─────────────────────────  networks  ───────────────────────── */}
      <h2 id="networks">Networks and mainnet</h2>
      <p>
        New in 0.1.0, and additive: every testnet export works as before. A{" "}
        <code>GloamNetwork</code> carries <code>key</code>, <code>label</code>,{" "}
        <code>chainId</code>, <code>pool</code> and <code>deployBlock</code>, and
        now also <code>testnet</code>, <code>ceremony</code> (
        <code>&quot;dev&quot; | &quot;production&quot;</code>),{" "}
        <code>rpcUrl</code>, <code>explorerUrl</code>, <code>chain</code> (a viem{" "}
        <code>Chain</code>) and <code>assets</code> (symbol, address, decimals
        and the launch <code>depositLimit</code>).
      </p>
      <div className="overflow-x-auto">
        <table>
          <thead>
            <tr>
              <th>Export</th>
              <th>What it gives you</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <code>mainnetNetwork(chain)</code>
              </td>
              <td>
                <code>chain</code> is <code>&quot;robinhood&quot;</code>,{" "}
                <code>&quot;tempo&quot;</code>, <code>&quot;base&quot;</code>{" "}
                (0.3.0), <code>&quot;ethereum&quot;</code> (0.4.0)
                {ELYSIUM ? <> or <code>&quot;elysium&quot;</code></> : null}. A mainnet{" "}
                <code>GloamNetwork</code>, or <code>null</code> until its pool is
                published{NOT_YET ? ` (${NOT_YET}: not yet)` : ""}
              </td>
            </tr>
            <tr>
              <td>
                <code>testnetNetwork(chain)</code>
              </td>
              <td>
                0.3.0. A chain&apos;s testnet: the Robinhood Chain and Tempo
                testnets, or Base Sepolia, which runs the mainnet pool and keys.
                0.4.0 adds <code>&quot;ethereum&quot;</code>, Ethereum Sepolia, with
                its pool
              </td>
            </tr>
            <tr>
              <td>
                <code>gloamNetworks()</code>
              </td>
              <td>Every network Gloam runs on right now: mainnets with a pool first, then the testnets</td>
            </tr>
            {ELYSIUM && (
              <tr>
                <td>
                  <code>elysiumMainnetConfig()</code>
                </td>
                <td>
                  Elysium mainnet&apos;s values (chain id, RPC, explorer, USDC, pool and deploy block) from{" "}
                  <code>ELYSIUM_MAINNET</code>, checked, or <code>null</code> while any is missing. Gas is HYPE;
                  the pool takes USDC only. <code>elysiumChainId()</code> gives the chain id alone
                </td>
              </tr>
            )}
            <tr>
              <td>
                <code>getGloamNetwork(key)</code>
              </td>
              <td>
                One network by key: <code>&quot;robinhood-mainnet&quot;</code>,{" "}
                <code>&quot;tempo-mainnet&quot;</code>, <code>&quot;base-mainnet&quot;</code>,{" "}
                <code>&quot;ethereum-mainnet&quot;</code>,{" "}
                {ELYSIUM ? <><code>&quot;elysium-mainnet&quot;</code>, </> : null}
                <code>&quot;robinhood&quot;</code>,{" "}
                <code>&quot;tempo&quot;</code>, <code>&quot;base&quot;</code> or{" "}
                <code>&quot;ethereum&quot;</code>; null while its pool is not in
              </td>
            </tr>
            <tr>
              <td>
                <code>GLOAM_NETWORKS</code>
              </td>
              <td>
                <code>.robinhood</code> and <code>.tempo</code> stay the testnets,
                unchanged for older code
              </td>
            </tr>
            <tr>
              <td>
                <code>MAINNET_POOLS</code>
              </td>
              <td>The one place each mainnet pool and deploy block is set; null until published</td>
            </tr>
            <tr>
              <td>
                <code>ceremonyForChainId(chainId)</code>
              </td>
              <td>
                Which keys a chain&apos;s verifiers hold: <code>&quot;production&quot;</code>{" "}
                (the final keys) on mainnet, Base Sepolia and Ethereum Sepolia,{" "}
                <code>&quot;dev&quot;</code> on the Robinhood Chain and Tempo testnets
              </td>
            </tr>
            <tr>
              <td>
                <code>circuitArtifactUrls(circuit, chainId)</code>
              </td>
              <td>
                <code>{"{ wasm, zkey }"}</code> URLs on{" "}
                <code>https://www.gloam.trade/circuits</code> for that chain&apos;s
                keys (mainnet under <code>/circuits/final/</code>). Mainnet proofs
                must use the final keys
              </td>
            </tr>
            <tr>
              <td>
                <code>CASH_OUT_FEE_BPS</code> / <code>cashOutFee(amount)</code>
              </td>
              <td>
                <code>50</code> (0.5%) / what the pool keeps on a mainnet cash out
              </td>
            </tr>
            <tr>
              <td>
                <code>readCashOutFeeBps(client, pool)</code>
              </td>
              <td>
                The rate a vault charges now, from the chain (0.5.0). The pool
                takes it when a cash out lands. Base Sepolia and Ethereum Sepolia
                are still at <code>25</code>; pass the result to{" "}
                <code>cashOutFee(amount, bps)</code>
              </td>
            </tr>
            <tr>
              <td>
                <code>cashOutTargetProblem(to, net)</code>
              </td>
              <td>
                Why a cash out to <code>to</code> would be lost (the vault, the
                memo board, a token contract, a swap router, the zero address),
                or <code>null</code>. <code>buildUnshieldIntent</code> checks it
                before proving
              </td>
            </tr>
            <tr>
              <td>
                <code>RH_MAINNET_CHAIN_ID</code> / <code>TEMPO_MAINNET_CHAIN_ID</code>
              </td>
              <td>
                <code>4663</code> / <code>4217</code>
              </td>
            </tr>
            <tr>
              <td>
                <code>RH_TESTNET_CHAIN_ID</code> / <code>TEMPO_TESTNET_CHAIN_ID</code>
              </td>
              <td>
                <code>46630</code> / <code>42431</code>
              </td>
            </tr>
            <tr>
              <td>
                <code>RH_MAINNET_USDG</code>, <code>GLOAM_TOKEN</code>, <code>RH_MAINNET_PONS</code>,{" "}
                <code>RH_MAINNET_CASHCAT</code>, <code>RH_MAINNET_AI</code>, <code>RH_MAINNET_ORBIO</code>
              </td>
              <td>
                Robinhood Chain mainnet pool assets, with <code>RH_MAINNET_GRIFT</code> and native ETH
                (<code>NATIVE_ASSET</code>). ETH, AI and ORBIO take deposits since 3 November 2026; GRIFT
                once its timelocked limit lands (0.4.5)
              </td>
            </tr>
            <tr>
              <td>
                <code>TEMPO_USDCE</code>, <code>TEMPO_PATHUSD</code>,{" "}
                <code>TEMPO_USDT0</code>, <code>TEMPO_OUSD</code>
              </td>
              <td>Tempo mainnet pool assets, 6 decimals each</td>
            </tr>
            <tr>
              <td>
                <code>BASE_USDC</code>, <code>BASE_EURC</code>,{" "}
                <code>BASE_USDT</code>; <code>BASE_SEPOLIA_USDC</code>,{" "}
                <code>BASE_SEPOLIA_EURC</code>
              </td>
              <td>
                0.3.0. Base mainnet and Base Sepolia pool assets, 6 decimals each;
                native ETH is listed on both{mainnetPool(8453) ? "" : " (Base mainnet is not deployed yet)"}
              </td>
            </tr>
            <tr>
              <td>
                <code>ETHEREUM_USDC</code>, <code>ETHEREUM_USDT</code>,{" "}
                <code>ETHEREUM_USDG</code>, <code>ETHEREUM_PYUSD</code>,{" "}
                <code>ETHEREUM_EURC</code>
              </td>
              <td>
                0.4.0. Ethereum mainnet pool assets, 6 decimals each; native ETH
                is listed too{mainnetPool(1) ? "" : " (not deployed yet)"}
              </td>
            </tr>
            <tr>
              <td>
                <code>approvalSteps(chainId, token, allowance, amount)</code>
              </td>
              <td>
                0.4.0. The exact <code>approve(pool, value)</code> calls a
                deposit needs, in order: none when the allowance covers it,{" "}
                <code>[0, amount]</code> for USDT on Ethereum with an old
                allowance in the way, else <code>[amount]</code>
              </td>
            </tr>
            <tr>
              <td>
                <code>ETHEREUM_SEPOLIA_USDC</code>, <code>ETHEREUM_SEPOLIA_USDG</code>,{" "}
                <code>ETHEREUM_SEPOLIA_PYUSD</code>, <code>ETHEREUM_SEPOLIA_EURC</code>
              </td>
              <td>
                0.4.0. Ethereum Sepolia pool assets, 6 decimals each; native ETH is
                listed too
              </td>
            </tr>
            <tr>
              <td>
                <code>RH_USDG</code>
              </td>
              <td>Test USDG on Robinhood Chain testnet</td>
            </tr>
            <tr>
              <td>
                <code>MAINNET_POSEIDON_T3</code>
              </td>
              <td>The Poseidon library both mainnet pools use</td>
            </tr>
          </tbody>
        </table>
      </div>
      <pre>
        <code>{`const net = mainnetNetwork("robinhood");     // null until the pool is published
if (!net) throw new Error("not published yet");

net.testnet;                                  // false: mainnet
net.ceremony;                                 // "production"
circuitArtifactUrls("unshield", net.chainId); // the final keys
cashOutFee(500_000_000n);                     // what the pool keeps on a 500 USDG cash out`}</code>
      </pre>

      {/* ─────────────────────────  builders  ───────────────────────── */}
      <h2>Intent builders</h2>
      <p>
        The primary surface. Each builder returns an unsigned{" "}
        <code>GloamIntent</code>: a portable <code>plan</code> plus a resolved{" "}
        <code>exec</code> (the on-chain call). You sign and broadcast; the SDK
        never holds a key.
      </p>
      <div className="overflow-x-auto">
        <table>
          <thead>
            <tr>
              <th>Function</th>
              <th>Signature</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <code>buildShieldBoundIntent</code>
              </td>
              <td>
                <code>(p: ShieldBoundIntentParams) =&gt; Promise&lt;ShieldIntent&gt;</code>
                <br />
                Mints a note + shield proof → <code>shieldBound(...)</code>
              </td>
              <td>Live</td>
            </tr>
            <tr>
              <td>
                <code>buildShieldIntent</code>
              </td>
              <td>
                <code>(p: ShieldIntentParams) =&gt; Promise&lt;ShieldIntent&gt;</code>
                <br />
                Plain <code>shield(...)</code>, no proof
              </td>
              <td>Legacy pools only</td>
            </tr>
            <tr>
              <td>
                <code>buildUnshieldIntent</code>
              </td>
              <td>
                <code>(p: UnshieldIntentParams) =&gt; Promise&lt;GloamIntent&lt;&quot;unshield&quot;&gt;&gt;</code>
                <br />
                Witness + proof → <code>unshield(...)</code> (cash out)
              </td>
              <td>Live</td>
            </tr>
            <tr>
              <td>
                <code>buildPrivateSendIntent</code>
              </td>
              <td>
                <code>(p: PrivateSendIntentParams) =&gt; Promise&lt;PrivateSendIntent&gt;</code>
                <br />
                Transfer witness → <code>transfer(...)</code>; returns payment +
                change notes
              </td>
              <td>Live</td>
            </tr>
            <tr>
              <td>
                <code>buildPrivateTradeIntent</code>
              </td>
              <td>
                <code>(p: PrivateTradeIntentParams) =&gt; Promise&lt;PrivateTradeIntent&gt;</code>
                <br />
                Sealed-swap witness → <code>sealedSwap(...)</code>
              </td>
              <td>Retired</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p>
        <code>buildPrivateTradeIntent</code> produces a valid intent for the
        sealed trade, which is retired: the on-chain sealed-swap path stays
        disabled on testnet, and the mainnet pools have no sealed swap at all.{" "}
        <Link href="/docs/private-swaps">Private swaps</Link> replaced it. They
        go through a swap router on {swapMainnets()} mainnet, and from 0.5.0 the SDK
        builds them: <code>buildSwapIntent</code>, with the refund and exit in
        the SDK README.
      </p>

      <h3>Parameters</h3>
      <pre>
        <code>{`interface ShieldIntentParams {
  amountWei: bigint;          // wei (native) or token base units
  asset?: Address;            // default NATIVE_ASSET (zero address, testnet only)
  chainId?: number;           // default RH_TESTNET_CHAIN_ID; pass a mainnet one explicitly
                              // (required when poolAddress is a mainnet vault)
  poolAddress?: Address;      // default: the pool for chainId (refused for a mainnet
                              // chain whose pool is not in the SDK yet)
  agentAddress?: Address | null;
}
interface ShieldBoundIntentParams extends ShieldIntentParams {
  prover: Prover;             // bound to the shield circuit artifacts
}
interface UnshieldIntentParams {
  secretHex: \`0x\${string}\`;  // the note's spend key
  amountWei: bigint;
  to: Address;                // public recipient
  asset?: Address;
  path: PoseidonMerklePath;   // membership path (from the rebuilt tree)
  prove: Prover;
  poolAddress?: Address; chainId?: number; agentAddress?: Address | null;
}
interface PrivateSendIntentParams {
  secretHex: \`0x\${string}\`;
  amountInWei: bigint;        // the source note's amount
  amountPayWei: bigint;       // amount to send (remainder is your change note)
  asset?: Address;
  path: PoseidonMerklePath;
  prove: Prover;
  poolAddress?: Address; chainId?: number; agentAddress?: Address | null;
}`}</code>
      </pre>

      {/* ─────────────────────────  intents  ───────────────────────── */}
      <h2>Intent shape</h2>
      <p>
        Every builder returns this. The <code>plan</code> is safe to log or hand
        to an agent; the <code>exec</code> is the resolved call.
      </p>
      <pre>
        <code>{`interface GloamIntent<K> {
  intent: K;                  // one of the four IntentKind values
  chainId: number;
  agentAddress: Address | null;
  plan: PlanFor<K>;           // portable: symbol, amount, no secrets
  privacy: string;            // plain-language: what is and isn't hidden
  execution: string;          // plain-language: how to sign + broadcast
  exec: IntentExec;
}
interface IntentExec {
  poolAddress: Address;
  fn: PoolFn;                 // e.g. "shieldBound", "unshield", "transfer"
  valueWei: bigint;           // ETH to attach (native shield only)
  args: readonly unknown[];   // ABI-ordered call args
}`}</code>
      </pre>
      <p>
        <code>ShieldIntent</code> adds <code>note: BoundNote</code>;{" "}
        <code>PrivateSendIntent</code> and <code>PrivateTradeIntent</code> add{" "}
        <code>paymentNote</code>/<code>outNote</code> and <code>changeNote</code>{" "}
        (each a <code>NoteExport</code>).
      </p>

      <h3>Pinned public inputs</h3>
      <p>
        <code>PUBLIC_INPUTS</code> pins the exact signal ordering the deployed
        verifiers expect, so an integrator cannot drift out of proof
        compatibility.
      </p>
      <pre>
        <code>{`PUBLIC_INPUTS.unshield   // [root, nullifier, asset, amount, to]
PUBLIC_INPUTS.transfer   // [root, nullifier, newCommitment0, newCommitment1]
PUBLIC_INPUTS.sealedSwap // [root, nullifier, newCOut, newCChange,
                         //  assetIn, assetOut, amountOutMin, rateIn, rateOut]`}</code>
      </pre>

      {/* ─────────────────────────  notes  ───────────────────────── */}
      <h2>Notes</h2>
      <p>
        A private balance is a note:{" "}
        <code>commitment = Poseidon(secret, amount, asset)</code>,{" "}
        <code>nullifier = Poseidon(secret, commitment)</code>. The{" "}
        <code>secret</code> is the sole spend authority.
      </p>
      <pre>
        <code>{`makeBoundNotePoseidon(amount: bigint, asset?: Address): Promise<BoundNote>
noteCommitmentPoseidon(secret: bigint, amount: bigint, asset?: Address): Promise<bigint>
noteNullifierPoseidon(secret: bigint, commitment: bigint): Promise<bigint>
openNotePoseidon(secretHex: Hex, amount: bigint, asset: Address)
  : Promise<{ commitment: Hex; nullifier: Hex }>
randomSecretField(): Promise<bigint>   // uniform, under the field prime

interface BoundNote {
  secret: Hex; commitment: Hex; nullifier: Hex;
  secretField: bigint; commitmentField: bigint; nullifierField: bigint;
}`}</code>
      </pre>

      {/* ─────────────────────────  prover  ───────────────────────── */}
      <h2>Prover</h2>
      <p>
        Proving is environment-bound, so it is injected. A <code>Prover</code>{" "}
        takes a circom input and returns packed proof bytes.{" "}
        <code>artifactProver</code> binds snarkjs to a fixed set of artifacts
        (file paths in node, URLs in the browser).
      </p>
      <pre>
        <code>{`type Prover = (input: Record<string, string | string[]>) => Promise<ProveResult>
type ProveResult = { proofBytes: Hex; publicSignals?: string[] }

interface Groth16Artifacts { wasm: string; zkey: string }

artifactProver(a: Groth16Artifacts): Prover
proveGroth16(input, wasm: string, zkey: string)
  : Promise<{ proofBytes: Hex; publicSignals: string[]; proof: Groth16Proof }>`}</code>
      </pre>
      <p>
        <code>snarkjs</code> is imported dynamically inside{" "}
        <code>proveGroth16</code>; install it as a peer where you prove. A browser
        app and a node signer differ only in whether <code>wasm</code>/
        <code>zkey</code> are URLs or paths.
      </p>

      {/* ─────────────────────────  merkle  ───────────────────────── */}
      <h2>Merkle tree</h2>
      <p>
        A depth-20 (<code>MERKLE_DEPTH</code>) incremental Poseidon tree. Rebuild
        it from the pool&apos;s <code>Shielded</code> events, then produce a
        membership path for a spend proof.
      </p>
      <pre>
        <code>{`class IncrementalMerkleTreePoseidon {
  leaves: bigint[];
  insert(leaf: bigint): Promise<number>          // returns the leaf index
  path(leafIndex: number): Promise<PoseidonMerklePath>
}
type PoseidonMerklePath = {
  leafIndex: number; leaf: bigint;
  pathElements: bigint[]; pathIndices: number[]; root: bigint;
}
pathToCircomInput(path: PoseidonMerklePath)  // -> circom-ready string fields`}</code>
      </pre>

      {/* ─────────────────────────  sync  ───────────────────────── */}
      <h2>Tree sync</h2>
      <p>
        A spend needs a membership path, which needs the current tree.{" "}
        <code>syncTree</code> rebuilds it from chain, replaying{" "}
        <code>Shielded</code>, <code>Transferred</code>, and{" "}
        <code>SealedSwapped</code> leaves in on-chain order, so the root stays
        correct after any transfer or swap. viem&apos;s <code>PublicClient</code>{" "}
        is injected, so the same call works in the browser and in node.
      </p>
      <pre>
        <code>{`syncTree(client: PublicClient, { pool, fromBlock?, chunkSize? }): Promise<SyncedTree>

// true if the rebuilt root equals the pool's on-chain currentRoot()
assertTreeMatchesChain(client, pool, synced): Promise<boolean>

interface SyncedTree {
  tree: IncrementalMerkleTreePoseidon;
  leaves: ChainLeaf[];
  root: Hex; leafCount: number;
  indexByCommitment: Map<string, number>;
  pathForLeaf(i: number): Promise<PoseidonMerklePath | null>;
  pathForCommitment(c: Hex): Promise<PoseidonMerklePath | null>;  // the ergonomic path
}`}</code>
      </pre>
      <p>
        The usual flow: <code>const synced = await syncTree(client, {"{"} pool{" "}
        {"}"})</code>, then hand{" "}
        <code>await synced.pathForCommitment(note.commitment)</code> straight to{" "}
        <code>buildUnshieldIntent</code> or <code>buildPrivateSendIntent</code>.
      </p>

      {/* ─────────────────────────  x402  ───────────────────────── */}
      <h2>x402 payments</h2>
      <p>
        Private agent payments over HTTP 402, settle-then-prove and
        self-custodial. The seller prices a resource, the agent settles a private
        send to the payee itself, then presents the payment note and settlement
        tx. The public sees only a shielded transfer, never the amount or the
        parties. This is not a Tempo Zone: no operator sees the payment, and
        compliance visibility is opt-in per payment through an issuer-scoped
        disclosure.
      </p>
      <pre>
        <code>{`// server, once: a receive key (share the tag, keep privateJwk)
generateReceiveKey(): Promise<ReceiveKey>        // { tag: "gloamr1.…", privateJwk }
isReceiveTag(s) / assertReceiveTag(s)

// server: the 402 challenge (payTo must be a receive tag)
buildGloamPaymentRequirements(p): GloamPaymentRequirements

// agent: build the private send + X-PAYMENT header (does not broadcast)
buildGloamPayment(p): Promise<BuiltPayment>
//   p: { requirements, senderSecretHex, senderNoteAmountWei, path, prove,
//        issuerTag?, disclosureProver?, legacyUnsealed? }
//   the payment note is sealed to requirements.payTo

// server: open + verify + sweep; serve only when grantAccess is true
settleGloamPayment(p): Promise<SettleResult>
//   p: { requirements, payload, receiveKey, prove, chain, submit, beforeSubmit? }
//   SettleResult: { grantAccess, final, status, freshNote, reason }

// lower level
openGloamPaymentNote(paymentNote, receiveKey)    // open the sealed note
verifyGloamPayment({ requirements, payload, note }): VerifyResult   // always final: false
sweepReceivedNote(p)                             // move a received note to a fresh one
verifyPaymentNoteBinding(note): Promise<boolean>

// optional issuer-scoped compliance disclosure over the payment note
buildComplianceDisclosure(p): Promise<GloamComplianceDisclosure>

encodeRequirements / decodeRequirements     // 402 body transport
encodePaymentHeader / decodePaymentHeader   // X-PAYMENT transport
GLOAM_VS_ZONE, GLOAM_X402_SCHEME`}</code>
      </pre>
      <p>
        The agent signs and broadcasts <code>payment.intent.exec</code> itself,
        then sets <code>payload.txHash</code>. The payment note travels sealed to
        the payee&apos;s receive tag, so nobody who sees the header can open it.
        The payer made that note, so it knows the secret too: a payment is only
        final once the payee has swept it into a note only the payee knows.{" "}
        <code>settleGloamPayment</code> opens, checks and sweeps, and returns{" "}
        <code>grantAccess: true</code> only after the sweep confirms. If the payer
        spent the note back first, the sweep fails and access is refused. Worked
        example: <code>examples/pay-x402</code>.
      </p>

      {/* ─────────────────────────  commerce  ───────────────────────── */}
      <h2 id="commerce">Commerce with commitments</h2>
      <p>
        Pay privately, prove the payment with the receipt circuit, and put one{" "}
        <code>bytes32</code> leaf per payment into a merkle root you already
        post. Receipt proofs are checked off chain; no contract verifies them
        today. Guide: <Link href="/docs/agents/commitments">private commerce with commitments</Link>.
      </p>
      <pre>
        <code>{`// payer: private send to a receive tag + the plan for its receipt (does not broadcast)
buildPrivatePaymentWithReceipt(p): Promise<PrivatePaymentWithReceipt>
//   p: { payTo, chainId, poolAddress?, asset, amountWei, from: { secretHex, amountWei, path },
//        prove, note?, receipt: { verifier, expiresAt?, reveal?, minAmountWei? } }
//   returns { intent, paymentNote, changeNote, sealedTicket, memo, receiptPlan }

// payer, once the transfer landed: the receipt proof and its leaf
buildPaymentReceipt({ plan, path, txHash, prove }): Promise<PaymentReceiptRecord>

// keccak256(abi.encode("gloam.receipt-leaf.v1", chainId, pool, txHash, uint256[7] signals))
paymentReceiptLeaf({ chainId, pool, txHash, publicSignals }): Hex
verifyPaymentReceiptLeaf(leaf, fields): boolean

// anyone: leaf, fields, context, vault, snark, chain, root, payment
checkPaymentReceipt(record, { leaf?, verifySnark?, client?, now? }): Promise<ReceiptCheckResult>
verifyGroth16(vkey, publicSignals, proof): Promise<boolean>
paymentProofText(record): string            // gloampay1:… for /verify and the partner API

// every call an agent signs, for a signing allowlist
agentSigningAllowlist({ chainId?, assets? }): AgentSigningEntry[]
GLOAM_VAULT_AGENT_ABI, PAY_MEMO_ABI, RECEIPT_LEAF_DOMAIN, cleanReceiptLabel`}</code>
      </pre>

      {/* ─────────────────────────  witness  ───────────────────────── */}
      <h2>Witness builders</h2>
      <p>
        Pure circom-input builders under the intent builders. Use these directly
        only if you drive proving yourself; otherwise the intent builders call
        them for you.
      </p>
      <pre>
        <code>{`buildPoseidonUnshieldWitness({ secretHex, amount, asset?, to, path })
buildTransferWitness({ secretHex, amountIn, amountPay, asset?, path })
buildSealedSwapWitness({ secretHex, amountIn, amountSwap, assetIn?, assetOut,
                         amountOutMin, rateIn, rateOut, path })
sealedSwapArtifactsReady(): boolean

type NoteExport = { secret: Hex; commitment: Hex; nullifier: Hex;
                    amountWei: string; asset: Address }`}</code>
      </pre>
      <p>
        Each returns the circom input, the derived public inputs, the output
        notes, and a <code>blocker</code> string if the witness is not provable
        (for example a commitment that is not in the tree).
      </p>

      {/* ─────────────────────────  rates  ───────────────────────── */}
      <h2>Sealed-rate math</h2>
      <p>
        Pure integer math for sealed swaps, proven against the circuit equality{" "}
        <code>amountOut · rateOut === amountSwap · rateIn</code>. Rates are USD
        cents (<code>SEALED_RATE_SCALE = 100</code>) to keep the constraint exact.
      </p>
      <pre>
        <code>{`marksToSealedRates(ethUsd, outUsd, source?): SealedRateQuote | null
estimateSealedOut(amountSwap: bigint, rateIn: bigint, rateOut: bigint): bigint
exactSealedAmounts(amountSwapWanted: bigint, rateIn: bigint, rateOut: bigint)
  : { amountSwap: bigint; amountOut: bigint } | null   // exact, no rounding leak
formatSealedAmount(wei: bigint, maxFrac?: number): string
fallbackOneToOneRates(): SealedRateQuote

type SealedRateQuote = { rateIn: bigint; rateOut: bigint; /* … */ }`}</code>
      </pre>

      {/* ─────────────────────────  privacy  ───────────────────────── */}
      <h2>Size-privacy policy</h2>
      <p>
        The public floor an integrator publishes for a spend. The default mode
        keeps the on-chain minimum at <code>SIZE_PRIVACY_OUT_MIN = 1</code> so the
        settled size leaks nothing; a slippage mode trades some privacy for a
        tighter guarantee.
      </p>
      <pre>
        <code>{`type SizePrivacyMode = "max" | "slippage"
publicAmountOutMin(expectedOut: bigint, mode: SizePrivacyMode, bps?: number): bigint
coarsenMarkUsd(usd: number): number          // bucket a mark so quotes don't fingerprint
SEALED_PRIVACY_FACTS                          // plain-language privacy notes`}</code>
      </pre>

      {/* ─────────────────────────  poseidon / proof  ───────────────────────── */}
      <h2>Field math &amp; proof packing</h2>
      <p>Low-level helpers, shared by the note and witness layers.</p>
      <pre>
        <code>{`// poseidon.ts
poseidon2(a: bigint, b: bigint): Promise<bigint>
poseidon3(a: bigint, b: bigint, c: bigint): Promise<bigint>
toField(x: bigint | string | number): bigint   // reduce mod the field prime
fieldToHex(f: bigint): \`0x\${string}\`
hexToField(hex: string): bigint

// proof.ts
packGroth16Proof(proof: Groth16Proof): Hex      // -> the bytes the verifier wants
fieldToBytes32(field: bigint | string): Hex`}</code>
      </pre>

      {/* ─────────────────────────  constants  ───────────────────────── */}
      <h2>Constants</h2>
      <div className="overflow-x-auto">
        <table>
          <thead>
            <tr>
              <th>Constant</th>
              <th>Value / meaning</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <code>SEALED_VAULT</code>
              </td>
              <td>
                The hardened C1/C2/C3 pool on Robinhood Chain testnet, the default
                deposit target when no chain is given
              </td>
            </tr>
            <tr>
              <td>
                <code>SHIELD_VERIFIER</code>
              </td>
              <td>The deployed shield verifier the hardened pool checks against</td>
            </tr>
            <tr>
              <td>
                <code>GLOAM_PAY_MEMO</code>
              </td>
              <td>The encrypted-memo contract for private-pay discovery</td>
            </tr>
            <tr>
              <td>
                <code>NATIVE_ASSET</code>
              </td>
              <td>Zero address, meaning native ETH (a pool asset on every network but Tempo)</td>
            </tr>
            <tr>
              <td>
                <code>RH_TESTNET_CHAIN_ID</code> / <code>RH_MAINNET_CHAIN_ID</code>
              </td>
              <td>
                <code>46630</code> / <code>4663</code>
              </td>
            </tr>
            <tr>
              <td>
                <code>TEMPO_TESTNET_CHAIN_ID</code> / <code>TEMPO_MAINNET_CHAIN_ID</code>
              </td>
              <td>
                <code>42431</code> / <code>4217</code>
              </td>
            </tr>
            <tr>
              <td>
                <code>FIELD_PRIME</code>
              </td>
              <td>The BN254 scalar field modulus</td>
            </tr>
            <tr>
              <td>
                <code>MERKLE_DEPTH</code> / <code>SEALED_RATE_SCALE</code>
              </td>
              <td>
                <code>20</code> / <code>100</code>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p>
        The default <code>SEALED_VAULT</code> is the hardened pool, never the
        retired <code>0x4F38</code> deployment. Pass <code>chainId</code> (and
        optionally <code>poolAddress</code>) to any builder to target another
        network. Mainnet pools come from <code>MAINNET_POOLS</code>; see{" "}
        <a href="#networks">Networks and mainnet</a>.
      </p>

      <h2>Guardrails</h2>
      <p>
        Mainnet (<code>4663</code>, <code>4217</code>
        {mainnetPool(8453) ? <>, <code>8453</code></> : null}
        {mainnetPool(1) ? <>, <code>1</code></> : null}
        {ELYSIUM ? <>, <code>{ELYSIUM.chainId}</code> (Elysium)</> : null}) runs
        on the final ceremony keys, with deposit limits and a
        0.5% cash-out fee. The Robinhood Chain and Tempo testnets (
        <code>46630</code>, <code>42431</code>) run on dev-ceremony keys with
        test funds; Base Sepolia (<code>84532</code>) and Ethereum Sepolia (
        <code>11155111</code>) run the final keys with test funds. Real proofs only, never a mock.
        Note secrets are the sole spend authority: persist and protect them. See
        the <Link href="/docs/quickstart">quickstart</Link> to put this together,
        or <Link href="/docs/production">the production gate</Link> for what is
        done and what is still ahead.
      </p>
    </DocsLayout>
  );
}
