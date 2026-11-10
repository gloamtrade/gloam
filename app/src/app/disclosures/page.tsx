import type { Metadata } from "next";
import { ELYSIUM, ELYSIUM_LIVE_SINCE } from "@/lib/elysium";
import Link from "next/link";
import { LegalLayout } from "@/components/LegalLayout";
import { CASH_OUT_FEE_PERCENT } from "@/lib/cashOutFee";

export const metadata: Metadata = { title: "Disclosures" };

export default function DisclosuresPage() {
  return (
    <LegalLayout title="Disclosures" updated="November 1, 2026">
      <p>
        Please read these disclosures carefully before using Gloam or any related
        interface.
      </p>
      <h2>Risk of loss</h2>
      <p>
        Digital assets, including cryptocurrencies and tokenized real-world
        assets such as stock tokens, can lose value rapidly and in full. Past
        performance is not indicative of future results. You may lose some or
        all of the assets you use with the protocol or related smart contracts.
      </p>
      <h2>Smart contract & protocol risk</h2>
      <p>
        Smart contracts may contain bugs, economic design flaws, or be exploited.
        Upgrades, admin keys, oracles, bridges, and sequencers introduce
        additional risk. Audits do not eliminate risk.
      </p>
      <h2>Mainnet</h2>
      <p>
        Since Gloam&apos;s mainnet launch on 21 October 2026, the mainnet pools
        on Robinhood Chain and Tempo have been live, and since 26 October 2026
        the pools on Base and Ethereum
        {ELYSIUM ? `, and since ${ELYSIUM_LIVE_SINCE} the pool on Elysium, a new chain with one sequencer at launch` : ""}.
        The contracts were reviewed internally before launch. Kann Audits then
        reviewed the vault contracts (<Link href="/security">report, 1 November
        2026</Link>) and found no Critical, High or Medium issues. Its findings
        are acknowledged and not fixed; changes land in the next vault. The
        swap routers, circuits, app and relay were not part of that review.
      </p>
      <p>
        Deposits have limits: 50,000 per deposit and 2,500,000
        in total for each stablecoin, 20 per deposit and 1,000 in total for ETH
        on Base and Ethereum, and 2,500,000 per deposit and 25,000,000 in total
        for $GLOAM{ELYSIUM ? ", and 500 per deposit and 25,000 in total for USDC on Elysium" : ""}. Cash outs and
        private payments are never limited.
        Direct deposits and private payments are free; a cash out costs {CASH_OUT_FEE_PERCENT} of
        its amount. Money bridged in from another chain pays the bridge&apos;s
        fees, shown before you send.
      </p>
      <p>
        The owner is a single wallet (a multisig is planned), cash-out fees go
        to a separate treasury wallet since 24 October 2026, and the Gloam team
        runs the relay. The relay only submits
        transactions that are already proven and pays their network fee; it
        cannot move or redirect money. No function lets the team take pooled
        funds. Raising limits, adding assets or changing verifiers waits a
        public three-day timelock; the owner can lower limits or close
        deposits at once.
        {ELYSIUM &&
          " Elysium's vault is owned by a guard contract from its deploy: its verifiers can never be changed, and its limits and fee change only through the same three-day timelock."}
      </p>
      <p>
        The Robinhood Chain and Tempo testnets use test tokens and
        single-party development keys. Base Sepolia and Ethereum Sepolia use
        test tokens and the final keys.
        Mainnet uses the final keys from the 13-contributor trusted setup.
      </p>
      <h2>Privacy is not absolute</h2>
      <p>
        Shielded balances and private transactions reduce public visibility;
        they do not make activity invisible to all parties in all conditions.
        Timing analysis, amount correlation at the edge of a privacy set, user
        error, malware, and legal process may still expose information.
      </p>
      <h2>Regulatory uncertainty</h2>
      <p>
        Tokenized equities and privacy technologies sit in evolving regulatory
        environments. Availability of assets and features may depend on
        jurisdiction. You are responsible for determining whether use is lawful
        for you.
      </p>
      <h2>No custody</h2>
      <p>
        Gloam interfaces do not custody user funds. You interact with networks
        and contracts through your own wallet. Support cannot recover lost keys
        or reverse confirmed transactions.
      </p>
      <h2>Third-party & chain risk</h2>
      <p>
        Robinhood Chain, Tempo, Ethereum, bridges, RPCs, and other infrastructure may
        halt, reorg, censor, or fail. We do not control those systems.
      </p>
      <h2>Interface only</h2>
      <p>
        Website and app UIs may be one of several ways to interact with
        underlying contracts. The interface can go offline while contracts
        remain reachable by other means.
      </p>
      <h2>Forward-looking statements</h2>
      <p>
        Roadmaps, “coming soon” features, and testnet plans are aspirational.
        Nothing obligates us to ship any feature on any timeline.
      </p>
      <h2>Related documents</h2>
      <p>
        <a href="/terms">
          Terms of Use
        </a>
        {" · "}
        <a href="/privacy">
          Privacy Policy
        </a>
        {" · "}
        <a href="/cookies">
          Cookie Policy
        </a>
      </p>
    </LegalLayout>
  );
}
