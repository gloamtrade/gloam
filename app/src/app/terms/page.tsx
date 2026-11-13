import type { Metadata } from "next";
import { liveMainnetNames } from "@/lib/mainnet";
import Link from "next/link";
import { LegalLayout } from "@/components/LegalLayout";
import { CASH_OUT_FEE_PERCENT } from "@/lib/cashOutFee";

export const metadata: Metadata = { title: "Terms of Use" };

export default function TermsPage() {
  return (
    <LegalLayout title="Terms of Use" updated="November 14, 2026">
      <p>
        These Terms of Use (“Terms”) govern access to and use of the websites,
        applications, documentation, and interfaces operated under gloam.trade
        (collectively, the “Services”) by Gloam (“Gloam,” “we,” “us”). By using
        the Services, you agree to these Terms. Our{" "}
        <a href="/privacy">Privacy Policy</a> and{" "}
        <a href="/cookies">Cookie Policy</a> explain what information we
        handle.
      </p>
      <h2>1. Mainnet and testnet</h2>
      <p>
        Gloam runs on mainnet and on testnets. On mainnet (Robinhood Chain and
        Tempo, from Gloam&apos;s mainnet launch on 21 October 2026) you use
        real assets, and you can lose them. On mainnet, deposits
        have limits, a cash out costs {CASH_OUT_FEE_PERCENT} of its amount, and the contracts
        were reviewed internally before launch. Kann Audits then reviewed the
        vault contracts (<Link href="/security">report, 1 November 2026</Link>)
        and found no Critical, High or Medium issues. That review did not cover
        every part of Gloam and does not remove risk. Only deposit what you can
        afford to lose.
      </p>
      <p>
        On the testnets (Tempo Moderato testnet and Robinhood Chain testnet)
        the tokens you use are test tokens with no monetary value. Do not send
        real assets to a testnet address or contract.
      </p>
      <p>
        We may change, pause, reset or remove any part of the Services at any
        time. On testnet this includes redeploying contracts, which can leave
        earlier test balances unusable, and testnets themselves can also be
        reset or stop working. On mainnet we can lower deposit limits or close
        deposits at any time; cash outs and private payments are not limited,
        and there is no admin withdraw. We do not guarantee that the Services,
        or any test balance, will be available.
      </p>
      <h2>2. Experimental software</h2>
      <p>
        Gloam is early-stage software for interacting with blockchain
        networks, including {liveMainnetNames()}. Features
        such as private balances, private payments, payroll, proofs and
        private swaps may be incomplete, unavailable, or change without notice. Stock tokens
        are issued by third parties, not by Gloam: they track a share&apos;s price, they are
        not shares, and their issuers may limit who can hold them. A private swap trades on a
        public exchange, so its tokens
        and amounts are public. There is no guarantee of uptime, correctness,
        or fitness for any purpose.
      </p>
      <h2>3. No custody</h2>
      <p>
        Gloam is self-custodial. Gloam never holds your keys, your seed phrase,
        your note secrets or your funds. Your notes and their secrets are kept
        in your browser, and proofs are made there. Money in the Gloam vault
        contract leaves only with a valid proof, and there is no admin
        withdraw.
      </p>
      <p>
        You are responsible for your wallets, private keys, seed phrases,
        devices and sign-in methods, for your notes and their backups, and for
        the proofs you make and who you share them with. If you lose your keys
        or your notes without a backup, we cannot recover them. Transactions
        you sign are final when confirmed on-chain.
      </p>
      <h2>4. Tester program</h2>
      <p>
        Taking part in the Gloam testers program is voluntary. Any tester
        rewards are as described in the program&apos;s announcement and are at
        Gloam&apos;s discretion. Once the paid spots are filled, new testers
        join as volunteers. Volunteer testing is unpaid.
      </p>
      <h2>5. Eligibility</h2>
      <p>
        You must be able to form a binding contract under applicable law and
        must not use the Services if you are a person or entity prohibited from
        doing so under the laws of your jurisdiction or under sanctions
        administered by relevant authorities. You are solely responsible for
        compliance with local law.
      </p>
      <h2>6. Not financial advice</h2>
      <p>
        Nothing on the Services is an offer, solicitation, or recommendation to
        buy, sell, or hold any asset, security, or derivative. Tokenized equities
        and other digital assets involve substantial risk of loss. We do not
        provide investment, legal, accounting, or tax advice.
      </p>
      <h2>7. Privacy features</h2>
      <p>
        Privacy-enhancing features do not guarantee anonymity, unlinkability, or
        immunity from investigation. Unshielded activity, bridges, third-party
        services, and implementation bugs may reveal information. You use
        privacy features at your own risk and are responsible for understanding
        their limitations.
      </p>
      <h2>8. Prohibited use</h2>
      <p>
        You may not use the Services to violate law, evade sanctions, commit
        fraud, launder funds, exploit vulnerabilities, attack infrastructure, or
        interfere with other users. We may restrict access where we believe
        misuse is occurring, to the extent we control the interface.
      </p>
      <h2>9. Third-party services</h2>
      <p>
        The Services may link to or depend on third parties (the Tempo and
        Robinhood Chain networks, mainnet and testnet, RPCs, wallets, Tempo&apos;s fee sponsor,
        bridges, indexers, DEXs, analytics, Telegram, and Anthropic, whose API
        writes the answers of Glim, our Telegram helper). We do not control
        those services and are not liable for their acts, failures, or terms.
        Glim&apos;s answers are written by an AI model and can be wrong, so
        check the docs before you act on one.
      </p>
      <h2>10. Intellectual property</h2>
      <p>
        Gloam branding, site design, and original content are owned by us or our
        licensors. You may not copy or reverse engineer the Services except as
        permitted by law. Open-source components are governed by their licenses.
      </p>
      <h2>11. Disclaimers</h2>
      <p>
        THE SERVICES ARE PROVIDED “AS IS” AND “AS AVAILABLE” WITHOUT WARRANTIES
        OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING MERCHANTABILITY, FITNESS FOR A
        PARTICULAR PURPOSE, AND NON-INFRINGEMENT. WE DO NOT WARRANT THAT THE
        SERVICES WILL BE SECURE, ERROR-FREE, OR UNINTERRUPTED.
      </p>
      <h2>12. Limitation of liability</h2>
      <p>
        TO THE MAXIMUM EXTENT PERMITTED BY LAW, GLOAM AND ITS CONTRIBUTORS SHALL
        NOT BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR
        PUNITIVE DAMAGES, OR ANY LOSS OF PROFITS, DATA, OR ASSETS, ARISING FROM
        YOUR USE OF THE SERVICES OR BLOCKCHAIN NETWORKS, EVEN IF ADVISED OF THE
        POSSIBILITY.
      </p>
      <h2>13. Indemnity</h2>
      <p>
        You agree to indemnify and hold harmless Gloam and its contributors from
        claims arising out of your use of the Services, your violation of these
        Terms, or your violation of any rights of another.
      </p>
      <h2>14. Changes</h2>
      <p>
        We may update these Terms by posting a revised version with a new “Last
        updated” date. Continued use after changes constitutes acceptance.
      </p>
      <h2>15. Contact</h2>
      <p>
        Questions: <a href="mailto:hello@gloam.trade">hello@gloam.trade</a> or{" "}
        <a href="https://x.com/gloamtrade">
          @gloamtrade
        </a>
        .
      </p>
    </LegalLayout>
  );
}
