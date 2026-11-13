import type { Metadata } from "next";
import Link from "next/link";
import { DocsLayout } from "@/components/DocsLayout";
import { FlowDiagram } from "@/components/docs/FlowDiagram";
import { joinNames, mainnetPool } from "@/lib/mainnet";
import { ELYSIUM, ELYSIUM_LIVE_SINCE } from "@/lib/elysium";
import { CASH_OUT_FEE_PERCENT } from "@/lib/cashOutFee";

/** Base and Ethereum mainnet move from "still ahead" to live once their pools are in (lib/mainnet.ts). */
const BASE_LIVE = mainnetPool(8453) !== null;
const ETHEREUM_LIVE = mainnetPool(1) !== null;
const LATER = joinNames([BASE_LIVE ? "Base (8453)" : null, ETHEREUM_LIVE ? "Ethereum (1)" : null, ELYSIUM ? `Elysium (${ELYSIUM.chainId})` : null].filter((n): n is string => n !== null));

export const metadata: Metadata = {
  title: "Production gate",
  description:
    "What was in place before Gloam launched on mainnet, what came after, and what is still ahead: final ceremony keys, deposit limits, timelock, internal review, the Kann Audits vault review, multisig.",
};

export default function DocsProductionPage() {
  return (
    <DocsLayout
      title="Production gate"
      lede="What mainnet cleared before launch, and what is still ahead."
      glance={[
        { label: "Mainnet", value: "Live since 21 Oct, 13:00 UTC" },
        { label: "Keys", value: "Final, 13 contributors" },
        { label: "Review", value: "Internal; Kann on the vault" },
        { label: "Testnet", value: "Test funds" },
      ]}
    >
      <h2>Why this page exists</h2>
      <p>
        Mainnet is live, and we keep a plain list of
        what had to be true before it opened, what is in place now, and what is
        not done yet. The app proves shield, unshield, and private send in the
        browser, and that is real cryptography. On mainnet the proofs use the
        final keys from the production trusted setup (see the{" "}
        <a href="https://github.com/gloamtrade/gloam/releases/tag/ceremony-final">transcript</a>).
        The Robinhood Chain and Tempo testnets keep development keys, which
        are <strong>not</strong> safe for mainnet, so they stay testnet only.
        Base Sepolia and Ethereum Sepolia run the final keys.
      </p>

      <FlowDiagram
        title="Gate order"
        steps={[
          {
            n: "1",
            title: "Production ceremony (done)",
            body: "Done 17 October: the public Hermez Powers of Tau, then 13 contributions to the six mainnet circuits, sealed with drand round 6561386. Transcript public. The mainnet verifiers and the app's mainnet proofs use these keys.",
          },
          {
            n: "2",
            title: "Internal review (done)",
            body: "Contracts and circuits reviewed internally before launch. The review finished on 20 October with no Critical or High findings open.",
          },
          {
            n: "3",
            title: "Limits and timelock (in place)",
            body: "Deposit limits cap what the pools take. Raising a limit, adding an asset or changing a verifier waits a public 3-day timelock. The owner can lower limits or close deposits at once.",
          },
          {
            n: "4",
            title: "Mainnet deploy (done)",
            body: `New ShieldPoolPayments pools on Robinhood Chain and Tempo mainnet (21 October 2026), then Base and Ethereum mainnet (26 October 2026)${ELYSIUM ? `, then Elysium mainnet (${ELYSIUM_LIVE_SINCE}), owned by a VaultOwnerGuard from its deploy` : ""}: payments only, no sealed swap. The app proves with the final keys there.`,
          },
          {
            n: "5",
            title: "Private swap routers (deployed)",
            body: "One router each on Robinhood Chain and Tempo mainnet, with no upgrade. Tempo's has no owner; Robinhood Chain's owner can add a pool with 3 days of public notice and take one off at once, and nothing else. They use only the vault's normal release and deposit calls, so the vault did not change. Reviewed internally before deploy, not externally audited.",
          },
          {
            n: "6",
            title: "Kann Audits vault review (done)",
            body: "After launch, Kann Audits reviewed the vault contracts (report, 1 November 2026) and found no Critical, High or Medium issues. Its findings are acknowledged and not fixed: the vault cannot be upgraded, so changes land in the next vault.",
          },
        ]}
      />

      <p>
        The report, what it covered and how to report a bug are on the{" "}
        <Link href="/security">security page</Link>.
      </p>

      <h2>Ceremony checklist (keys)</h2>
      <ul>
        <li>Done: phase 1 is the public Hermez Powers of Tau (54 contributors)</li>
        <li>
          Done: phase 2, 13 contributions to shield, unshield, transfer,
          solvency, receipt and payroll_total, each round a public release
        </li>
        <li>
          Done: the final keys and their Solidity verifiers, exported byte for byte
          (<code>contracts/src/verifiers/final</code>), same public inputs layout v2
        </li>
        <li>
          Done: their SHA-256 fingerprints are pinned, and each network proves with its own
          set: dev keys on the Robinhood Chain and Tempo testnets, the final
          keys on mainnet, Base Sepolia and Ethereum Sepolia
        </li>
        <li>
          Done: the mainnet deploy refuses to create a pool unless its verifiers accept
          proofs made with the final keys and reject proofs made with the dev keys
        </li>
        <li>Destroy or never re-use toxic waste from the ceremony</li>
      </ul>

      <h2>Mainnet at launch</h2>
      <ul>
        <li>
          <strong>Pools.</strong> <code>ShieldPoolPayments</code> on Robinhood
          Chain (4663) and Tempo (4217).
          {LATER ? ` ${LATER} joined later on the same deploy and keys.` : ""}{" "}
          Addresses and assets are on{" "}
          <Link href="/docs/chain#mainnet">Networks</Link>.
        </li>
        <li>
          <strong>Deposit limits.</strong> Each stablecoin: 50,000 per
          deposit and 2,500,000 in total. $GLOAM: 2,500,000 per deposit and
          25,000,000 in total.
          Cash outs and private payments are never limited.
        </li>
        <li>
          <strong>No admin withdraw.</strong> No function lets the team take
          pooled funds. Notes leave only through an unshield proof.
        </li>
        <li>
          <strong>Fees.</strong> Direct deposits and private payments are free. A
          cash out costs {CASH_OUT_FEE_PERCENT}. Money bridged in from another chain pays the
          bridge&apos;s fees. Gloam currently puts half of its protocol fees toward $GLOAM
          buybacks, a treasury decision that can change; half of what is bought is
          burned and half goes to the treasury.
        </li>
      </ul>

      <h2>What was hardened before mainnet</h2>
      <ul>
        <li>Real on-chain verifiers (no always-true mock on the funded pool)</li>
        <li>Browser prove path with artifact hash checks</li>
        <li>Private send does not keep the payment note on the sender</li>
        <li>Hardened pool: a bound shield proof and 128-bit amount range checks (audit C1/C2)</li>
        <li>Two-step ownership and a one-way shield-verifier set (audit M-4)</li>
        <li>
          Note secrets and receive keys encrypted at rest (AES-GCM under an
          IndexedDB device key, or that key wrapped by a passkey, audit M-1)
        </li>
        <li>
          Claimed payments secured on claim: moved into a fresh note only the
          payee knows, so the payer cannot spend them back
        </li>
      </ul>

      <h2>What is still ahead</h2>
      <ul>
        <li>
          <strong>External review beyond the vault.</strong> The{" "}
          <Link href="/security">Kann Audits report</Link> covers the vault
          contracts only. The swap routers, circuits, app and relay were not
          part of it. Deposit limits cap how much the pools can hold.
        </li>
        <li>
          <strong>Multisig owner.</strong> One wallet is the owner (
          <code>0x76b7E410a227c888aBD2Bdc24Ee32E094B0FD4D8</code>). Cash-out
          fees go to the treasury (
          <code>0xB3900ac9350903218e4c7597bAb0f008F01B30B8</code>) since 24
          October. A multisig is planned.
        </li>
        <li>
          <strong>Owner guard.</strong> Ownership of each mainnet vault moves
          to VaultOwnerGuard, which forwards deposit limit and fee changes
          and the sweep of coin sent by mistake, and nothing else. It applies to a vault from the moment the guard accepts it,
          after outside review: from then on that vault&apos;s proof checkers
          and ownership can never change. Read <code>owner()</code> on the
          vault to see whether it has. What that costs is in the{" "}
          <Link href="/docs/threat-model">threat model</Link>.
        </li>
        <li>
          <strong>Relayer.</strong> The Gloam team runs it at launch. It only
          submits already-proven transactions and pays gas; it cannot move or
          redirect money. If it is down, you can send from your own wallet.
        </li>
        <li>
          <strong>Anonymity set.</strong> The mainnet pools are new, so the
          crowd of notes to hide among is thin at first. It grows with use.
        </li>
        <li>
          <strong>Swap amounts.</strong> A{" "}
          <Link href="/docs/private-swaps">private swap</Link> hides who
          swapped, not the tokens or the amounts. The old sealed trade, which
          tried to hide the size too, is retired and stays off
        </li>
        {!BASE_LIVE && (
          <li>
            <strong>Base mainnet.</strong> Next on the same deploy script and
            final keys. Base Sepolia, its testnet, has run it since 24
            October; Base mainnet follows once that is tested end to end. See{" "}
            <Link href="/docs/chain#base">Networks</Link>.
          </li>
        )}
        {!ETHEREUM_LIVE && (
          <li>
            <strong>Ethereum mainnet.</strong> Next on the same deploy script
            and final keys. Ethereum Sepolia, its testnet, has run it since 25
            October. The relay pays Ethereum gas only under its ceiling, 3 gwei
            by default, and waits above it. See{" "}
            <Link href="/docs/chain#ethereum">Networks</Link>.
          </li>
        )}
        <li>
          <strong>Stronger key custody.</strong> Notes and receive keys are encrypted at rest, but
          the key is device-bound; a wallet-bound or passphrase key is still open
        </li>
      </ul>

      <p>
        Security policy: <Link href="/disclosures">Disclosures</Link> · repo{" "}
        <code>SECURITY.md</code>. Product status:{" "}
        <Link href="/docs/product">What ships when</Link>.
      </p>
    </DocsLayout>
  );
}
