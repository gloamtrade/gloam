import type { Metadata } from "next";
import { ELYSIUM_ENABLED } from "@/lib/elysium";
import Link from "next/link";
import type { ReactNode } from "react";
import { Footer } from "@/components/Footer";
import { Header } from "@/components/Header";

const description =
  "Kann Audits reviewed Gloam's vault contracts and found no Critical, High or Medium issues. The report, what it covered, what it did not, and how to report a bug.";

export const metadata: Metadata = {
  title: "Security",
  description,
  alternates: { canonical: "/security" },
  openGraph: { title: "Gloam security", description, url: "/security", siteName: "Gloam", type: "website" },
};

/** Every link to the report points here. A reissued report replaces this file and no code changes. */
const REPORT_PDF = "/audits/gloam-kann-security-review-2026-11-01.pdf";
/** Set true once the final PDF is in app/public/audits. */
const REPORT_LIVE = true;

const COMMIT = "aac9e185bbeaa6b74311236c1cc57077d928f407";
const REPO = "https://github.com/gloamtrade/gloam";

/**
 * The findings, as the report counts them. This is the only place the counts
 * live: all other copy says "no Critical, High or Medium" and gives no total.
 */
const FINDINGS = [
  { severity: "Critical", count: 0 },
  { severity: "High", count: 0 },
  { severity: "Medium", count: 0 },
  { severity: "Low", count: 3 },
  { severity: "Informational", count: 8 },
];

const REVIEWED = [
  "ShieldPoolCore",
  "ShieldPoolPayments",
  "ChangeTimelock",
  "IncrementalMerkleTreePoseidon",
  "NoteLibPoseidon",
  "DualProofVerifier",
  "4 interfaces",
];

const NOT_REVIEWED = [
  "Swap routers: GloamVaultSwap, GloamVaultSwap2, GloamVaultSwapV4, V4b and V4c, GloamVaultSwapTempo and GloamVaultSwapTempo2, with SwapEscrow and SwapEscrow2. These have had internal review only, most recently on 7 November 2026. An outside review of them is being sourced",
  "VaultOwnerGuard",
  "GloamPayMemo",
  "Generated verifiers",
  "Circuits",
  "The app and the relay",
  "The MCP server and the SDK",
];

const inlineLink =
  "text-foreground underline decoration-line-strong underline-offset-4 transition-colors hover:decoration-foreground";

const rowLink = `inline-flex min-h-10 items-center ${inlineLink}`;

const REVIEW: { label: string; value: ReactNode }[] = [
  {
    label: "Reviewer",
    value: (
      <a href="https://kannaudits.com" target="_blank" rel="noreferrer" className={inlineLink}>
        Kann Audits
      </a>
    ),
  },
  { label: "Report date", value: "1 November 2026" },
  { label: "Review period", value: "26 to 30 October 2026" },
  { label: "Team", value: "5 researchers" },
  { label: "Method", value: "Manual review plus Kann's AI model" },
  {
    label: "Commit",
    value: (
      <a href={`${REPO}/tree/${COMMIT}`} target="_blank" rel="noreferrer" className={`tnum ${inlineLink}`}>
        {COMMIT.slice(0, 7)}
      </a>
    ),
  },
  { label: "Size", value: "668 nSLOC across 10 files" },
];

function Section({
  id,
  title,
  note,
  children,
}: {
  id: string;
  title: string;
  note?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      id={id}
      aria-labelledby={`${id}-title`}
      className="mx-auto max-w-[1240px] scroll-mt-20 px-6 pt-20 sm:pt-28"
    >
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

function ScopeList({ title, items }: { title: string; items: string[] }) {
  return (
    <div className="min-w-0">
      <h3 className="t-title">{title}</h3>
      <ul className="mt-4 divide-y divide-line border-y border-line text-[15px] leading-snug text-soft">
        {items.map((item) => (
          <li key={item} className="py-3 [overflow-wrap:anywhere]">
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function SecurityPage() {
  return (
    <div className="relative min-h-screen bg-panel text-foreground">
      <Header />

      <main>
        <section className="mx-auto max-w-[1240px] px-6 pt-12 sm:pt-20">
          <h1 className="t-display-xl">Security</h1>
          <p className="mt-6 max-w-[52ch] text-pretty text-[18px] leading-relaxed text-soft sm:text-[20px]">
            Kann Audits reviewed the vault contracts (report, 1 November 2026) and found no Critical, High or Medium
            issues. The review covered the vault contracts only.
          </p>
          <div className="mt-9 flex flex-wrap items-center gap-x-7 gap-y-4">
            {REPORT_LIVE ? (
            <a href={REPORT_PDF} target="_blank" rel="noreferrer" className="btn btn-ink">
              Open the report
            </a>
            ) : (
              <span className="btn btn-ink" aria-disabled="true">Full report coming shortly</span>
            )}
            <a href="#report" className="gl-arrowlink">
              Report a bug <span aria-hidden>→</span>
            </a>
          </div>
        </section>

        <Section
          id="findings"
          title="Findings"
          note={`Kann labels L-01 and L-02 Fixed because fixes are planned, and the rest Acknowledged. None of these changes are live yet. The vault cannot be upgraded, so changes land in the next vault.`}
        >
          <dl className="grid grid-cols-3 gap-x-6 gap-y-10 sm:grid-cols-5">
            {FINDINGS.map((f) => (
              <div key={f.severity} className="flex flex-col-reverse justify-end border-t border-foreground pt-5">
                <dt className="mt-2 text-[14px] text-mute">{f.severity}</dt>
                <dd className="t-display-l tnum">{f.count}</dd>
              </div>
            ))}
          </dl>
        </Section>

        <Section id="review" title="The review">
          <dl className="divide-y divide-line border-y border-line text-[15px]">
            {REVIEW.map((r) => (
              <div key={r.label} className="flex flex-wrap items-center justify-between gap-x-6 gap-y-1 py-3.5">
                <dt className="text-mute">{r.label}</dt>
                <dd className="text-foreground">{r.value}</dd>
              </div>
            ))}
          </dl>
        </Section>

        <Section id="scope" title="What it covered" note="These files at that commit, and nothing else.">
          <div className="grid grid-cols-1 gap-12 sm:grid-cols-2 sm:gap-8">
            <ScopeList title="Reviewed" items={REVIEWED} />
            <ScopeList title="Not reviewed" items={NOT_REVIEWED} />
          </div>
          <p className="mt-10 max-w-[60ch] text-[15px] leading-relaxed text-mute">
            The 10 reviewed files have not changed on main since that commit. The deployed vault has identical bytecode
            on Robinhood Chain, Tempo, Base and Ethereum.
            {ELYSIUM_ENABLED &&
              " Elysium's vault went live after the review. It is built from the same reviewed files, and its owner is a VaultOwnerGuard from the deploy, which the review did not cover."}
          </p>
          <Link href="/verify#contracts" className="gl-arrowlink mt-5">
            Check the contracts <span aria-hidden>→</span>
          </Link>
        </Section>

        <Section id="limits" title="What it does not change">
          <div className="grid grid-cols-1 gap-10 sm:grid-cols-2">
            <div className="border-t border-foreground pt-5">
              <p className="text-[18px] leading-snug tracking-[-0.01em]">Deposit limits</p>
              <p className="mt-3 text-[14px] leading-relaxed text-mute">
                Mainnet has deposit limits. A review lowers risk. It does not remove it.
              </p>
            </div>
            <div className="border-t border-foreground pt-5">
              <p className="text-[18px] leading-snug tracking-[-0.01em]">The owner&apos;s power</p>
              <p className="mt-3 text-[14px] leading-relaxed text-mute">
                The owner can swap the proof verifier after a public 3-day timelock (finding I-02). One wallet is the
                owner today, and a multisig is planned.
              </p>
            </div>
          </div>
          <Link href="/docs/threat-model" className="gl-arrowlink mt-8">
            Read the threat model <span aria-hidden>→</span>
          </Link>
        </Section>

        <Section
          id="report"
          title="Report a bug"
          note="Tell us privately, and please don't post details until a fix ships."
        >
          <ul className="divide-y divide-line border-y border-line text-[15px]">
            <li className="flex flex-wrap items-center justify-between gap-x-6 gap-y-1 py-3">
              <span className="text-mute">Email</span>
              <a href="mailto:hello@gloam.trade?subject=Security" className={rowLink}>
                hello@gloam.trade, with Security in the subject
              </a>
            </li>
            <li className="flex flex-wrap items-center justify-between gap-x-6 gap-y-1 py-3">
              <span className="text-mute">Direct message</span>
              <a href="https://x.com/gloamtrade" target="_blank" rel="noreferrer" className={rowLink}>
                @gloamtrade on X
              </a>
            </li>
            <li className="flex flex-wrap items-center justify-between gap-x-6 gap-y-1 py-3">
              <span className="text-mute">Policy</span>
              <a
                href={`${REPO}/blob/main/SECURITY.md#reporting-a-vulnerability`}
                target="_blank"
                rel="noreferrer"
                className={rowLink}
              >
                SECURITY.md
              </a>
            </li>
          </ul>
          <p className="mt-6 max-w-[60ch] text-[14px] leading-relaxed text-mute">
            Test on a fork, a local chain or the testnet, never against the mainnet pools. Gloam does not run a paid bug
            bounty yet.
          </p>
        </Section>
      </main>

      <Footer />
    </div>
  );
}
