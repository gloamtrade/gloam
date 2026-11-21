import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { Footer } from "@/components/Footer";
import { Header } from "@/components/Header";
import { AcceptedAssets } from "@/components/compliance/AcceptedAssets";
import { ContractsSection } from "@/components/verify/ContractsSection";
import { OwnershipStatement } from "@/components/verify/OwnershipStatement";
import { COMPLIANCE_EMAIL, LAW_ENFORCEMENT_TERMS } from "@/lib/compliance";
import { BNB_ENABLED } from "@/lib/bnb";
import { ELYSIUM_ENABLED } from "@/lib/elysium";
import { joinNames, liveMainnetNames } from "@/lib/mainnet";
import { SCREEN_LIST_INFO } from "@/lib/screening";
import { chainalysisEnabled } from "@/lib/screeningServer";

const description =
  "For regulators, law enforcement and anyone labelling addresses: how to reach Gloam, how deposits and cash-outs are screened, who can change what, and every address Gloam runs.";

export const metadata: Metadata = {
  title: "Compliance",
  description,
  alternates: { canonical: "/compliance" },
  openGraph: { title: "Gloam compliance", description, url: "/compliance", siteName: "Gloam", type: "website" },
};

const inlineLink =
  "text-foreground underline decoration-line-strong underline-offset-4 transition-colors hover:decoration-foreground";
const rowLink = `inline-flex min-h-10 items-center ${inlineLink}`;

function Section({ id, title, note, children }: { id: string; title: string; note?: ReactNode; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="mx-auto max-w-[1240px] scroll-mt-20 px-6 pt-20 sm:pt-28">
      <div className="grid grid-cols-1 gap-10 border-t border-line pt-14 lg:grid-cols-[1fr_2fr] lg:gap-12">
        <div>
          <h2 id={`${id}-title`} className="t-display-l max-w-[12ch]">
            {title}
          </h2>
          {note ? <p className="mt-5 max-w-[36ch] text-[15px] leading-relaxed text-soft">{note}</p> : null}
        </div>
        <div className="min-w-0">{children}</div>
      </div>
    </section>
  );
}

function Rows({ rows }: { rows: { label: string; body: ReactNode }[] }) {
  return (
    <dl className="divide-y divide-line border-y border-line">
      {rows.map((r) => (
        <div key={r.label} className="grid grid-cols-1 gap-1 py-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] sm:gap-8">
          <dt className="text-[15px] text-foreground">{r.label}</dt>
          <dd className="text-[14px] leading-relaxed text-mute">{r.body}</dd>
        </div>
      ))}
    </dl>
  );
}

const JUMPS = [
  { href: "#contact", label: "Contact" },
  { href: "#screening", label: "Screening" },
  { href: "#controls", label: "Who can change what" },
  { href: "#assets", label: "Accepted assets" },
  { href: "#contracts", label: "Every address" },
  { href: "#statement", label: "Proof of ownership" },
];

/** Where the Gloam Owner Safe runs the vault's guard; Elysium's guard is run by the owner wallet until Safe runs there. */
const SAFE_RUN = joinNames(["Robinhood Chain", "Tempo", "Base", "Ethereum", ...(BNB_ENABLED ? ["BNB Chain"] : [])]);

export default function CompliancePage() {
  const list = SCREEN_LIST_INFO;
  const chainalysis = chainalysisEnabled();

  const screening = [
    {
      label: "Adding money",
      body: (
        <>
          Before the Gloam app asks a wallet to sign a deposit, it checks that wallet against the {list.name} ({list.count}{" "}
          addresses, snapshot of {list.snapshotDate}){chainalysis ? ", and our server also checks it with Chainalysis's sanctions screening" : ""}. A listed
          wallet is refused and sees only &ldquo;This wallet can&apos;t use Gloam.&rdquo; Nothing is sent, so nothing reaches the
          vault.
        </>
      ),
    },
    {
      label: "Cashing out",
      body: "The app checks the address a cash out pays before it asks the wallet to sign. Every cash out the Gloam relay sends is screened again on our server before it goes out, and a listed address is refused.",
    },
    {
      label: "On Tempo",
      body: "The stablecoin issuer's own transfer policy (TIP-403) is checked as well, both ways, and the token enforces it on chain whatever our software does.",
    },
    {
      label: "What we screen",
      body: "Public addresses only: the wallet that adds money and the address a cash out pays. Never a balance, an amount, a note or anything else private.",
    },
    {
      label: "What it doesn't cover",
      body: "Screening runs in the Gloam app, the relay and our API. The vault contracts don't screen, so a transaction sent straight to a contract, outside Gloam's software, isn't checked by Gloam.",
    },
    {
      label: "The list",
      body: (
        <>
          A snapshot of OFAC&apos;s SDN digital currency addresses, kept in our open-source code and refreshed from{" "}
          <a href={list.source} target="_blank" rel="noreferrer" className={inlineLink}>
            this source
          </a>
          .
        </>
      ),
    },
  ];

  const controls = [
    {
      label: "Who owns the vaults",
      body: `On ${SAFE_RUN}, each vault is owned by an owner guard contract (VaultOwnerGuard) run by the Gloam Owner Safe, which needs 2 of 3 signatures for every action.${
        ELYSIUM_ENABLED ? " On Elysium the guard is run by the owner wallet until Safe is available there." : ""
      }`,
    },
    {
      label: "At once",
      body: "The guard can lower a deposit limit or close deposits, lower the cash-out fee, and sweep native coin sent to a vault by mistake that backs no balance.",
    },
    {
      label: "After 3 days of public notice",
      body: "It can raise a deposit limit or list a new asset, raise the cash-out fee up to the vault's 1% cap, and name a new fee recipient. Each change waits on chain, where anyone can see it, before it can run.",
    },
    {
      label: "Never",
      body: "Replace the proof checkers, hand a vault to anyone else, take money that backs a balance, or stop a cash out. The guard has no code for any of these, and the vaults have no admin withdraw, no upgrade and no pause on cash outs.",
    },
    {
      label: "The relay",
      body: "Run by the Gloam team. It sends transactions that are already proven and pays their gas. It can refuse to send one, but it can't change where money goes.",
    },
    {
      label: "Gloam names",
      body: "The names registry on Robinhood Chain is owned by the same Safe. It maps names to Gloam addresses and holds no balances.",
    },
  ];

  const more = [
    { href: "/transparency", label: "Transparency", body: "What each vault holds, read live from the chain." },
    { href: "/verify#contracts", label: "Verify", body: "Check a proof, and every contract against what it reads on chain." },
    { href: "/security", label: "Security review", body: "The audit of the vault contracts, and how to report a bug." },
    { href: "/disclosures", label: "Risk disclosures", body: "What can go wrong, in plain words." },
    { href: "/docs/threat-model", label: "Threat model", body: "Who Gloam defends against, and the gaps we know about." },
    { href: "/docs/bridge", label: "Deposits from other chains", body: "These route through Relay, an outside service." },
  ];

  return (
    <div className="relative min-h-screen bg-panel text-foreground">
      <Header />

      <main>
        <section className="mx-auto max-w-[1240px] px-6 pt-12 sm:pt-20">
          <h1 className="t-display-xl">Compliance</h1>
          <p className="mt-6 max-w-[56ch] text-pretty text-[18px] leading-relaxed text-soft sm:text-[20px]">
            Gloam is a self-custodial private payments protocol on {liveMainnetNames()}. This page is for regulators, law
            enforcement and anyone labelling addresses.
          </p>
          <nav aria-label="On this page" className="mt-9 flex flex-wrap gap-x-7 gap-y-3">
            {JUMPS.map((j) => (
              <a key={j.href} href={j.href} className="gl-arrowlink min-h-10">
                {j.label} <span aria-hidden>→</span>
              </a>
            ))}
          </nav>
        </section>

        <Section id="contact" title="Contact" note="For law enforcement agencies and regulators.">
          <ul className="divide-y divide-line border-y border-line text-[15px]">
            <li className="flex flex-wrap items-center justify-between gap-x-6 gap-y-1 py-3">
              <span className="text-mute">Email</span>
              <a href={`mailto:${COMPLIANCE_EMAIL}?subject=Compliance`} className={rowLink}>
                {COMPLIANCE_EMAIL}, with Compliance in the subject
              </a>
            </li>
          </ul>
          <ul className="mt-6 space-y-3 text-[15px] leading-relaxed text-soft">
            {LAW_ENFORCEMENT_TERMS.map((t) => (
              <li key={t} className="flex gap-3">
                <span aria-hidden className="mt-[0.6em] h-1 w-1 shrink-0 rounded-full bg-mute" />
                <span>{t}</span>
              </li>
            ))}
          </ul>
          <p className="mt-8 max-w-[60ch] text-[14px] leading-relaxed text-mute">
            Gloam can&apos;t see or hand over a private balance. The keys that open one are made and kept on each person&apos;s
            device, and we never receive them. What our servers do hold is listed on{" "}
            <Link href="/verify#keys" className={inlineLink}>
              Verify
            </Link>
            .
          </p>
        </Section>

        <Section id="screening" title="Screening" note="How deposits and cash-outs are checked against sanctions lists.">
          <Rows rows={screening} />
        </Section>

        <Section
          id="controls"
          title="Who can change what"
          note="Only a valid proof from the person who holds a balance can move it."
        >
          <Rows rows={controls} />
        </Section>

        <Section id="assets" title="Accepted assets" note="What each vault takes, with its deposit limits read from the vault as you look.">
          <AcceptedAssets />
        </Section>

        <div className="pt-20 sm:pt-28">
          <ContractsSection />
        </div>

        <Section
          id="statement"
          title="Proof of ownership"
          note="A statement from the owner wallet naming these addresses, checked in your browser."
        >
          <OwnershipStatement />
        </Section>

        <Section id="more" title="More">
          <ul className="divide-y divide-line border-y border-line">
            {more.map((m) => (
              <li key={m.href} className="grid grid-cols-1 gap-1 py-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] sm:gap-8">
                <Link href={m.href} className={`${rowLink} text-[15px]`}>
                  {m.label}
                </Link>
                <span className="text-[14px] leading-relaxed text-mute">{m.body}</span>
              </li>
            ))}
          </ul>
        </Section>
      </main>

      <Footer />
    </div>
  );
}
