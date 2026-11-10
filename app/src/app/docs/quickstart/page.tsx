import type { Metadata } from "next";
import Link from "next/link";
import { DocsLayout } from "@/components/DocsLayout";

export const metadata: Metadata = {
  title: "Quickstart",
  description:
    "Shield your first private balance on Robinhood Chain or Tempo in about ten minutes with @gloamtrade/sdk: install, prove, deposit, cash out. On mainnet, or on testnet.",
};

export default function DocsQuickstartPage() {
  return (
    <DocsLayout
      title="Quickstart"
      lede="Go from an empty project to a real private balance in about ten minutes, on mainnet or on testnet. Every step below runs: no mocks, real Groth16 proofs."
      glance={[
        { label: "Time", value: "~10 minutes" },
        { label: "Runtime", value: "browser or node" },
        { label: "Chain", value: "Robinhood Chain 4663, or testnet 46630" },
        { label: "You end with", value: "a spendable private note" },
      ]}
      quickLinks={[
        { href: "/docs/sdk/reference", label: "API reference" },
        { href: "/docs/sdk", label: "SDK overview" },
        { href: "/docs/chain", label: "Networks" },
        { href: "/docs/testnet", label: "Practice on testnet" },
        { href: "/docs/agents", label: "Build a private agent" },
      ]}
    >
      <h2>Fastest start</h2>
      <p>Scaffold a working private app in one command:</p>
      <pre>
        <code>{`npm create gloam-app@latest my-private-app
cd my-private-app && npm install && npm run dev`}</code>
      </pre>
      <p>
        That gives you the browser shield flow, wired and running on{" "}
        <code>localhost:3000</code>. The rest of this page builds the same thing
        by hand so you understand each piece.
      </p>

      <h2>What you need</h2>
      <ul>
        <li>
          Node 18+ (or a browser app with a bundler, such as Next or Vite). The SDK ships
          TypeScript source, transpiled by your bundler.
        </li>
        <li>
          <strong>For mainnet:</strong> USDG on Robinhood Chain
          (chain id <code>4663</code>) plus a little ETH for gas, or USDC.e,
          pathUSD, USDT0 or OUSD on Tempo (<code>4217</code>), where gas is paid
          in stablecoins. Deposit limits cap each stablecoin deposit at 50,000. See{" "}
          <Link href="/docs/chain#mainnet">Networks</Link>.
        </li>
        <li>
          <strong>To practice first:</strong> a wallet on Robinhood Chain
          testnet (<code>46630</code>) with test ETH. See{" "}
          <Link href="/docs/testnet">practice on testnet</Link>.
        </li>
        <li>
          The circuit artifacts for your chain (step 2).
        </li>
      </ul>

      <h2>1. Install</h2>
      <p>
        <code>viem</code> handles signing and RPC; <code>snarkjs</code> is the
        proving peer, loaded only when you generate a proof.
      </p>
      <pre>
        <code>{`npm install @gloamtrade/sdk viem
npm install snarkjs   # peer, for proving`}</code>
      </pre>

      <h2>2. Get the circuit artifacts</h2>
      <p>
        Every deposit and spend needs a proof, so you need each circuit&apos;s{" "}
        <code>wasm</code> and <code>zkey</code>. The keys depend on the
        network: mainnet uses the final keys from the 13-contributor ceremony,
        the testnets use development keys, and a proof made with the wrong set
        does not verify. <code>circuitArtifactUrls(circuit, chainId)</code>{" "}
        returns the right <code>{"{ wasm, zkey }"}</code> for a chain, served
        from <code>https://www.gloam.trade/circuits</code> (mainnet keys live
        under <code>/circuits/final/</code>).
      </p>
      <pre>
        <code>{`import { circuitArtifactUrls } from "@gloamtrade/sdk";

circuitArtifactUrls("shield", 4663);   // final keys, Robinhood Chain mainnet
circuitArtifactUrls("shield", 46630);  // dev keys, Robinhood Chain testnet`}</code>
      </pre>
      <p>
        Base Sepolia (<code>84532</code>) is the exception among the testnets:
        it runs the mainnet vault, so its proofs use the final keys too.
        SDK 0.3.0 knows this, and has Base Sepolia&apos;s pool.
      </p>
      <p>
        You can also host the files yourself and pass them to{" "}
        <code>artifactProver({"{ wasm, zkey }"})</code>: file paths in{" "}
        <strong>node</strong>, URLs in the <strong>browser</strong>. Just keep
        mainnet on the final keys.
      </p>

      <h2>3. Shield your first note</h2>
      <p>
        <code>buildShieldBoundIntent</code> does the private half: it mints a note
        (a Poseidon commitment binding your secret to the amount and asset) and
        generates the shield proof. You sign the resolved call. The{" "}
        <code>note.secret</code> it returns is your only spend authority, so persist
        it. On mainnet, tokens such as USDG on Robinhood Chain need an approval
        first, so you approve the token before the deposit.
      </p>
      <pre>
        <code>{`import {
  mainnetNetwork, buildShieldBoundIntent, artifactProver,
  circuitArtifactUrls, RH_MAINNET_USDG, gloamReadTransport,
} from "@gloamtrade/sdk";
import { createWalletClient, createPublicClient, http, parseUnits, erc20Abi } from "viem";
import { privateKeyToAccount } from "viem/accounts";

// Robinhood Chain mainnet. null until the pool is published.
const net = mainnetNetwork("robinhood");
if (!net) throw new Error("Robinhood Chain mainnet pool not published yet");

const account = privateKeyToAccount(process.env.PRIVATE_KEY as \`0x\${string}\`);
const wallet = createWalletClient({ account, chain: net.chain, transport: http(net.rpcUrl) });
// reads at the chain head, old logs from the network's full-history RPC where it names one
const publicClient = createPublicClient({ chain: net.chain, transport: gloamReadTransport(net) });

const amount = parseUnits("25", 6);   // 25 USDG (6 decimals); the limit is 50,000 per deposit

// mint the note + generate the shield proof with this chain's keys
const intent = await buildShieldBoundIntent({
  chainId: net.chainId,
  poolAddress: net.pool,
  asset: RH_MAINNET_USDG,
  amountWei: amount,
  prover: artifactProver(circuitArtifactUrls("shield", net.chainId)),
});

// the pool pulls USDG with transferFrom, so approve it first
const approval = await wallet.writeContract({
  address: RH_MAINNET_USDG, abi: erc20Abi, functionName: "approve", args: [net.pool, amount],
});
await publicClient.waitForTransactionReceipt({ hash: approval });

// sign + broadcast shieldBound(asset, amount, commitment, proof)
const hash = await wallet.writeContract({
  address: intent.exec.poolAddress,
  abi: SHIELD_BOUND_ABI,
  functionName: intent.exec.fn,   // "shieldBound"
  args: intent.exec.args,
  value: intent.exec.valueWei,    // 0n for tokens
});

// PERSIST THIS. Losing it loses the funds.
saveSecret(intent.note.commitment, intent.note.secret);`}</code>
      </pre>
      <p>The minimal ABI fragment for the one call you make:</p>
      <pre>
        <code>{`const SHIELD_BOUND_ABI = [{
  type: "function",
  name: "shieldBound",
  stateMutability: "payable",
  inputs: [
    { name: "asset", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "commitment", type: "bytes32" },
    { name: "proof", type: "bytes" },
  ],
  outputs: [],
}] as const;`}</code>
      </pre>
      <p>
        <strong>Practice on testnet with the same code.</strong> Use{" "}
        <code>GLOAM_NETWORKS.robinhood</code> (Robinhood Chain testnet,{" "}
        <code>46630</code>) as <code>net</code>, and either shield test ETH
        (leave out <code>asset</code>, skip the approve, and the deposit goes
        in <code>valueWei</code>) or test USDG (<code>RH_USDG</code>).{" "}
        <code>circuitArtifactUrls</code> hands you the dev keys there. On Tempo,
        use <code>mainnetNetwork(&quot;tempo&quot;)</code> with{" "}
        <code>TEMPO_USDCE</code>, or <code>GLOAM_NETWORKS.tempo</code> to
        practice. On Base Sepolia, use <code>testnetNetwork(&quot;base&quot;)</code>{" "}
        (SDK 0.3.0) with <code>BASE_SEPOLIA_USDC</code>; it runs the mainnet
        vault and keys with test funds. <code>mainnetNetwork(&quot;base&quot;)</code>{" "}
        returns null until Base mainnet&apos;s pool is published, then the same
        code runs there with <code>BASE_USDC</code>. Ethereum is next the same
        way: <code>mainnetNetwork(&quot;ethereum&quot;)</code> (SDK 0.4.0)
        returns null until its pool is published, then runs with{" "}
        <code>ETHEREUM_USDC</code>. For USDT on Ethereum, send the approvals{" "}
        <code>approvalSteps</code> gives you: Tether&apos;s token clears an
        old approval to zero first.
      </p>

      <h2>4. Confirm it landed</h2>
      <p>
        The deposit inserts your commitment as a leaf in the pool&apos;s Merkle
        tree. Check membership directly, with no index and no backend:
      </p>
      <pre>
        <code>{`const seen = await publicClient.readContract({
  address: intent.exec.poolAddress,
  abi: [{ type: "function", name: "commitmentSeen", stateMutability: "view",
    inputs: [{ name: "c", type: "bytes32" }], outputs: [{ type: "bool" }] }],
  functionName: "commitmentSeen",
  args: [intent.note.commitment],
});
// seen === true  ->  you hold a private balance`}</code>
      </pre>
      <p>
        That is a real shielded balance. Nobody can tell it is yours or spend it
        without <code>note.secret</code>.
      </p>

      <h2>5. Cash out</h2>
      <p>
        To exit, rebuild the tree from chain, prove membership, and unshield.{" "}
        <code>syncTree</code> replays every leaf-inserting event in order (so the
        root matches even after transfers); <code>buildUnshieldIntent</code>{" "}
        builds the witness and proof. The amount, asset, and recipient become
        public on exit; the source note stays unlinkable via the nullifier. On
        mainnet a cash out costs 0.5%: <code>cashOutFee(amount)</code> is what
        the pool keeps.
      </p>
      <pre>
        <code>{`import {
  buildUnshieldIntent, artifactProver, circuitArtifactUrls, syncTree, cashOutFee,
} from "@gloamtrade/sdk";

// rebuild the pool tree, then get this note's membership path by commitment
const synced = await syncTree(publicClient, { pool: net.pool, fromBlock: net.deployBlock });
const path = await synced.pathForCommitment(intent.note.commitment);
if (!path) throw new Error("note not found in the tree yet");

const exit = await buildUnshieldIntent({
  chainId: net.chainId,
  poolAddress: net.pool,
  asset: RH_MAINNET_USDG,
  secretHex: intent.note.secret,
  amountWei: amount,
  to: account.address,
  path,
  prove: artifactProver(circuitArtifactUrls("unshield", net.chainId)),
});

// mainnet: the pool keeps cashOutFee(amount), 0.5%, and pays the rest to "to"
console.log("fee", cashOutFee(amount));

await wallet.writeContract({
  address: exit.exec.poolAddress,
  abi: unshieldAbi,
  functionName: exit.exec.fn,     // "unshield"
  args: exit.exec.args,
});`}</code>
      </pre>

      <h2>Where to go next</h2>
      <ul>
        <li>
          <Link href="/docs/sdk/reference">API reference</Link>: every builder,
          the network helpers, the note and prover primitives, merkle, rates,
          and constants.
        </li>
        <li>
          <Link href="/docs/private-pay">Private pay</Link>: send inside the
          vault to a receive tag with <code>buildPrivateSendIntent</code>.
        </li>
        <li>
          <Link href="/docs/sdk/disclosure">Selective disclosure</Link>: prove
          one balance to a chosen party, revealing nothing else.
        </li>
        <li>
          <Link href="/docs/agents">Build a private agent</Link>: the same core,
          server-side, under policy.
        </li>
      </ul>

      <h2>Honesty</h2>
      <p>
        Mainnet runs on the final keys
        from the 13-contributor ceremony, under deposit limits, after an
        internal review. Kann Audits has since reviewed the vault contracts (
        <Link href="/security">report, 1 November 2026</Link>) and found no Critical, High or Medium issues. The testnets run on
        dev-ceremony keys with test funds. Everything here is real: real proofs,
        real on-chain state, no mocks. Private swaps run in the app and the
        SDK (<Link href="/docs/private-swaps">private swaps</Link>), and hide who
        swapped, not the tokens or the amounts. The old sealed trade is retired. See{" "}
        <Link href="/docs/production">the production gate</Link>.
      </p>
    </DocsLayout>
  );
}
