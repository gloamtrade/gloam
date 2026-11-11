import Link from "next/link";
import { AppLink } from "@/components/AppLink";
import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";
import { SealedField } from "@/components/ui/SealedField";
import { FlowField } from "@/components/ui/FlowField";
import { liveMainnetNames } from "@/lib/mainnet";
import { CursorReveal } from "@/components/ui/CursorReveal";
import { SealStream } from "@/components/landing/SealStream";
import { PayrollLive } from "@/components/landing/PayrollLive";
import { LiveProduct } from "@/components/landing/LiveProduct";
import { CodeBlock } from "@/components/ui/CodeBlock";
import { ArrowUpRight } from "@/components/ui/ArrowUpRight";
import { LivePartnersStrip } from "@/components/LivePartners";

/**
 * Gloam landing, the "Sealed" system. White ground, light display type, one
 * luminous green field, and live product UI in place of illustration.
 * Signature: the seal stream, payments go in readable and come out sealed.
 */

/* ---------- line icons ---------- */

const icon = "h-6 w-6 text-foreground";
function IconPayroll() {
  return (
    <svg className={icon} viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="9" cy="8" r="3.2" stroke="currentColor" strokeWidth="1.3" />
      <path d="M3.5 19c.6-3 2.8-4.8 5.5-4.8s4.9 1.8 5.5 4.8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <path d="M16 6.5h4.5M16 10h4.5M17.5 13.5h3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}
function IconWallet() {
  return (
    <svg className={icon} viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="3.5" y="6.5" width="17" height="12" rx="3" stroke="currentColor" strokeWidth="1.3" />
      <path d="M3.5 10h17" stroke="currentColor" strokeWidth="1.3" />
      <path d="M15.5 14.25h2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}
function IconInvoice() {
  return (
    <svg className={icon} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M6.5 3.5h8l3 3v14h-11z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <path d="M9 10h6M9 13.5h6M9 17h3.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}
function IconAgent() {
  return (
    <svg className={icon} viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="4.5" y="7" width="15" height="11" rx="3" stroke="currentColor" strokeWidth="1.3" />
      <path d="M12 7V4.5M9.5 12h.01M14.5 12h.01" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M9.5 15h5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}
function IconTreasury() {
  return (
    <svg className={icon} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M4 9.5L12 5l8 4.5" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <path d="M6 10v7M10 10v7M14 10v7M18 10v7M4 19h16" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}
function IconStocks() {
  return (
    <svg className={icon} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M4 17l4.5-5 3.5 3 7-8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M15 7h4v4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const USES = [
  {
    icon: <IconAgent />,
    title: "Agent payments",
    body: "Agents pay per call over x402 and MCP without exposing the wallet behind them.",
    href: "/agents",
  },
  {
    icon: <IconWallet />,
    title: "Your own money",
    body: "Get paid, save and send to friends and family without strangers looking up your balance.",
    href: "/app",
  },
  {
    icon: <IconInvoice />,
    title: "Freelancers and contractors",
    body: "Get paid in stablecoins by every client, without each one seeing what the others pay you.",
    href: "/docs/private-pay",
  },
  {
    icon: <IconPayroll />,
    title: "Payroll",
    body: "Pay your team in USDG or PathUSD. Nobody can look up who earns what.",
    href: "/docs/payroll",
  },
  {
    icon: <IconTreasury />,
    title: "Suppliers and treasury",
    body: "Pay suppliers and move company money without broadcasting your costs or your runway.",
    href: "/docs/private-pay",
  },
  {
    icon: <IconStocks />,
    title: "Swaps and stocks",
    body: "Swap from your private balance on Robinhood Chain, stocks included, and on Tempo. Who swapped stays private; the amounts show.",
    href: "/docs/private-swaps",
  },
];

const TRUST = [
  {
    title: "No admin withdraw",
    body: "There is no function that lets anyone, including the Gloam team, take money out of the vault.",
  },
  {
    title: "Three days of public notice",
    body: "Any change to how payments are checked is announced on-chain three days before it can take effect.",
  },
  {
    title: "Open source, end to end",
    body: "Contracts, circuits, app and SDK are public. Check the deployed code against the repo yourself.",
  },
];

const NEW = [
  {
    title: "Payroll total proof",
    body: "Prove a run of up to 32 payments paid exactly a total, without showing who got what.",
    href: "/docs/proofs#payroll-total",
    cta: "How it works",
  },
  {
    title: "Proofs for one reader",
    body: "Each proof names who it is for and when it expires. Change either and it fails.",
    href: "/docs/proofs#made-for-one-person",
    cta: "How proofs work",
  },
  {
    title: "Private payments for agents",
    body: "Private x402 payments, a private method proposed for MPP, and an MCP server with spending limits.",
    href: "/docs/agents",
    cta: "Agents guide",
  },
];

const DEV_LINKS = [
  { label: "Try it live", href: "/sdk/playground" },
  { label: "SDK on npm", href: "https://www.npmjs.com/package/@gloamtrade/sdk" },
  { label: "MCP server", href: "/docs/agents#the-mcp-server" },
];

const SNIPPET = `import {
  buildGloamPayment,
  encodePaymentHeader,
  relayIntent,
} from "@gloamtrade/sdk";

// Pay a seller's 402 from a note in your vault.
const payment = await buildGloamPayment({
  requirements,
  senderSecretHex: note.secret,
  senderNoteAmountWei: BigInt(note.amountWei),
  path, // from syncTree
  prove, // artifactProver({ wasm, zkey })
});
// Store payment.changeNote: it is the rest of your balance.

// The relay sends it, so your wallet never shows up.
payment.payload.payload.txHash = await relayIntent(payment.intent);
const header = encodePaymentHeader(payment.payload); // X-PAYMENT`;

export function Landing() {
  return (
    <div className="relative min-h-screen bg-panel text-foreground">
      <Header />

      <main>
        {/* hero: owns the first screen, aligned to the nav container */}
        <section className="mx-auto max-w-[1400px] px-4 pt-3 sm:px-7 sm:pt-6">
          <div className="gl-panel flex min-h-[max(520px,calc(100svh-8rem))] flex-col justify-end px-5 pb-8 pt-24 sm:px-10 sm:pb-10 lg:h-[calc(100svh-10rem)] lg:max-h-[980px] lg:min-h-[620px] lg:px-14 lg:pb-14">
            <FlowField />
            <CursorReveal />
            <div className="relative z-10 max-w-[720px]">
              <h1 className="t-display-xl">Private money on public chains</h1>
              <p className="mt-6 max-w-[46ch] text-[18px] leading-[1.55] text-soft sm:text-[18px]">
                For people and teams paid in stablecoins, and the agents that
                work for them. Hold, pay and get paid without putting amounts or
                balances on the public record.
              </p>
              <div className="mt-8 flex flex-wrap gap-2">
                <AppLink href="/app" className="btn btn-ink btn-lg">
                  Open app
                </AppLink>
                <Link href="/docs" className="gl-arrowlink ml-4 self-center">
                  Read the docs <span aria-hidden>→</span>
                </Link>
              </div>
            </div>
          </div>
        </section>

        {/* partners already live on Gloam, right under the hero */}
        <LivePartnersStrip />

        {/* thesis + signature */}
        <section id="how" className="scroll-mt-20 pb-6 pt-24 sm:pt-36">
          <div className="mx-auto max-w-[900px] px-6 text-center">
            <h2 className="t-display-l">
              On a public chain, every payment is a postcard. Gloam seals the envelope.
            </h2>
            <p className="mx-auto mt-6 max-w-[58ch] text-[17px] leading-[1.6] text-mute sm:text-[19px]">
              Public blockchains show every amount, every balance and every
              counterparty to anyone who looks. Fine for a protocol. Not for a
              salary, a supplier or a treasury. Gloam keeps settlement public and
              the details private.
            </p>
          </div>
          <div className="mt-12">
            <SealStream />
          </div>
          <div className="mx-auto mt-6 flex max-w-[900px] justify-between px-6 text-[12px] text-mute sm:px-24">
            <span>What a payment normally reveals</span>
            <span>What Gloam lets the world see</span>
          </div>
        </section>

        {/* live product */}
        <section id="payments" className="mx-auto max-w-[1400px] scroll-mt-20 px-4 pb-10 pt-20 sm:px-7 sm:pb-16 sm:pt-32">
          <div className="gl-panel overflow-clip bg-surface px-5 py-12 sm:px-10 sm:py-16">
            <SealedField tone="soft" />
            <div className="relative mx-auto max-w-[720px] text-center">
              <h2 className="t-display-l">
                Private money, live on mainnet
              </h2>
              <p className="mx-auto mt-4 max-w-[52ch] text-[17px] leading-[1.6] text-mute sm:text-[19px]">
                Add money privately, pay anyone, and prove what you hold without
                showing the number. Live on {liveMainnetNames()} mainnet, and on testnet.
              </p>
            </div>
            <LiveProduct />
          </div>
        </section>

        {/* why gloam: a payment has one owner, so nobody else holds a key */}
        <section aria-labelledby="why-gloam" className="mx-auto max-w-[1400px] px-4 pt-20 sm:px-7 sm:pt-32">
          <div className="max-w-[760px]">
            <h2 id="why-gloam" className="t-display-l">
              A payment has one owner. Nobody else should hold the key.
            </h2>
            <p className="mt-5 max-w-[56ch] text-[17px] leading-[1.6] text-mute sm:text-[19px]">
              Auctions and lending pools compute on many people&apos;s hidden
              data, so someone has to hold a key for all of them. A payment does
              not. You prove it on your own device.
            </p>
          </div>
          <div className="mt-10 grid gap-3 md:grid-cols-2">
            <div className="gl-tile flex flex-col p-6 sm:p-10">
              <p className="text-[13px] font-medium text-soft">Committee model</p>
              <p className="mt-1 text-[14px] text-mute">Zama, Arcium, Tempo Zones</p>
              <p className="mt-8 text-[22px] leading-snug tracking-[-0.01em] sm:text-[24px]">
                A committee or an operator holds the key.
              </p>
              <p className="mt-3 max-w-[44ch] text-[15px] leading-relaxed text-mute">
                If it is breached, everyone who used it can be exposed, past
                payments included.
              </p>
            </div>
            <div className="gl-tile flex flex-col border border-line-strong bg-panel p-6 sm:p-10">
              <p className="text-[13px] font-medium text-sealed">Gloam</p>
              <p className="mt-1 text-[14px] text-mute">Owner-only proofs</p>
              <p className="mt-8 text-[22px] leading-snug tracking-[-0.01em] sm:text-[24px]">
                Your device makes the proof. Nobody else holds a key.
              </p>
              <p className="mt-3 max-w-[44ch] text-[15px] leading-relaxed text-mute">
                If one device is breached, one person is exposed. Not everyone.
              </p>
            </div>
          </div>
          <p className="mt-6 max-w-[72ch] text-[15px] leading-relaxed text-mute">
            Some services, like Helius Privacy, make your proof on their server.
            Gloam makes it on your device.{" "}
            <Link href="/docs/compare" className="text-foreground underline-offset-4 hover:underline">
              How Gloam compares <span aria-hidden>→</span>
            </Link>
          </p>
        </section>

        {/* who it's for */}
        <section className="mx-auto max-w-[1400px] px-4 py-20 sm:px-7 sm:py-32">
          <div className="max-w-[720px]">
            <h2 className="t-display-l">Built for money that should not be public</h2>
            <p className="mt-5 max-w-[56ch] text-[17px] leading-[1.6] text-mute sm:text-[19px]">
              Stablecoins made onchain money fast and cheap. Gloam makes it
              discreet enough for the people who actually move it: you, your
              team, your business and your agents.
            </p>
          </div>
          <div className="-mx-4 mt-10 flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-2 [scrollbar-width:none] sm:mx-0 sm:grid sm:grid-cols-2 sm:overflow-visible sm:px-0 sm:pb-0 lg:grid-cols-3 [&::-webkit-scrollbar]:hidden">
            {USES.map((u) => {
              const To = u.href.startsWith("/app") ? AppLink : Link;
              return (
                <To
                  key={u.title}
                  href={u.href}
                  className="gl-tile group flex min-h-[220px] w-[78%] shrink-0 snap-start flex-col p-6 transition-colors hover:bg-surface-2 sm:w-auto"
                >
                  {u.icon}
                  <div className="mt-auto">
                    <p className="text-[19px] leading-snug tracking-[-0.01em] text-foreground">
                      {u.title}
                    </p>
                    <p className="mt-2 text-[14px] leading-relaxed text-mute">{u.body}</p>
                  </div>
                </To>
              );
            })}
          </div>
        </section>

        {/* payroll spotlight */}
        <section id="payroll" className="mx-auto max-w-[1400px] scroll-mt-20 px-4 sm:px-7">
          <div className="grid gap-3 lg:grid-cols-2">
            <div className="gl-tile flex flex-col justify-between rounded-[24px] p-7 sm:p-10">
              <div>
                <h2 className="t-display-l max-w-[13ch]">Run payroll in one upload</h2>
                <p className="mt-5 max-w-[46ch] text-[17px] leading-[1.6] text-mute sm:text-[18px]">
                  Drop in a list of names and amounts. Gloam pays everyone from
                  your private balance and sends each payment for you, so your
                  wallet never shows up either.
                </p>
              </div>
              <div className="mt-10">
                <ul className="divide-y divide-line border-y border-line text-[15px]">
                  <li className="flex justify-between gap-6 py-4">
                    <span>Upload a CSV</span>
                    <span className="text-mute">Name, Gloam address, amount</span>
                  </li>
                  <li className="flex justify-between gap-6 py-4">
                    <span>Check what the public sees</span>
                    <span className="text-mute">No names, no amounts</span>
                  </li>
                  <li className="flex justify-between gap-6 py-4">
                    <span>Pay everyone</span>
                    <span className="text-mute">About 8 seconds each</span>
                  </li>
                </ul>
                <div className="mt-8 flex flex-wrap gap-2">
                  <AppLink href="/app/payroll" className="btn btn-ink">
                    Run payroll
                  </AppLink>
                  <Link href="/docs/payroll" className="btn btn-quiet">
                    How payroll works
                  </Link>
                </div>
              </div>
            </div>
            <div className="gl-panel flex min-h-[500px] items-center justify-center px-4 py-10 sm:px-10">
              <SealedField drift />
              <PayrollLive />
            </div>
          </div>
        </section>

        {/* developers */}
        <section className="mx-auto max-w-[1400px] px-4 pb-20 pt-20 sm:px-7 sm:pb-32 sm:pt-32">
          <div className="theme-dark gl-panel grid gap-10 border border-transparent bg-[#0b0c0e] px-6 py-12 text-foreground dark:border-line dark:bg-panel sm:px-12 sm:py-16 lg:grid-cols-[1fr_1.1fr] lg:items-center">
            <div className="relative min-w-0">
              <h2 className="t-display-l max-w-[15ch] text-foreground">
                Add private payments to anything
              </h2>
              <p className="mt-5 max-w-[48ch] text-[17px] leading-[1.6] text-mute sm:text-[18px]">
                The SDK gives any app or agent private balances, private
                payments and proofs. The MCP server lets an AI agent pay over
                x402 without showing its treasury.
              </p>
              <div className="mt-8 flex flex-wrap gap-2">
                <Link href="/sdk" className="btn btn-ink">
                  Explore the SDK
                </Link>
                <Link href="/docs/agents" className="btn btn-quiet">
                  Agents guide <span aria-hidden>→</span>
                </Link>
              </div>
            </div>
            <div className="relative min-w-0">
              <CodeBlock code={SNIPPET} lang="ts" title="npm i @gloamtrade/sdk" meta="TypeScript" className="bg-surface" />
              <div className="mt-4 flex flex-wrap gap-x-6 gap-y-2 text-[13.5px]">
                {DEV_LINKS.map((l) =>
                  l.href.startsWith("http") ? (
                    <a
                      key={l.label}
                      href={l.href}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1.5 text-soft transition-colors hover:text-foreground"
                    >
                      {l.label} <ArrowUpRight />
                    </a>
                  ) : (
                    <Link
                      key={l.label}
                      href={l.href}
                      className="text-soft transition-colors hover:text-foreground"
                    >
                      {l.label}
                    </Link>
                  ),
                )}
              </div>
            </div>
          </div>
        </section>

        {/* what's new: the building block, not new cryptography */}
        <section aria-labelledby="whats-new" className="mx-auto max-w-[1400px] px-4 pb-20 sm:px-7 sm:pb-32">
          <div className="grid gap-12 lg:grid-cols-[1fr_2fr]">
            <div>
              <h2 id="whats-new" className="t-display-l max-w-[13ch]">
                Private payments you can prove
              </h2>
              <p className="mt-5 max-w-[38ch] text-[15px] leading-relaxed text-mute">
                Gloam is not new cryptography. It is a new building block for
                finance.
              </p>
            </div>
            <div className="grid gap-10 sm:grid-cols-3">
              {NEW.map((n) => (
                <div key={n.title} className="flex flex-col border-t border-foreground pt-5">
                  <p className="text-[18px] leading-snug tracking-[-0.01em]">{n.title}</p>
                  <p className="mt-3 text-[14px] leading-relaxed text-mute">{n.body}</p>
                  <Link
                    href={n.href}
                    className="gl-arrowlink mt-auto pt-4"
                  >
                    {n.cta} <span aria-hidden>→</span>
                  </Link>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* trust */}
        <section className="mx-auto max-w-[1400px] px-4 pb-8 sm:px-7">
          <div className="grid gap-12 lg:grid-cols-[1fr_2fr]">
            <div>
              <h2 className="t-display-l max-w-[10ch]">No middlemen</h2>
              <Link
                href="/verify#contracts"
                className="gl-arrowlink mt-6"
              >
                Verify the contracts <span aria-hidden>→</span>
              </Link>
            </div>
            <div className="grid gap-10 sm:grid-cols-3">
              {TRUST.map((t) => (
                <div key={t.title} className="border-t border-foreground pt-5">
                  <p className="text-[18px] leading-snug tracking-[-0.01em]">{t.title}</p>
                  <p className="mt-3 text-[14px] leading-relaxed text-mute">{t.body}</p>
                </div>
              ))}
            </div>
          </div>
        </section>
      </main>

      <Footer />
    </div>
  );
}
