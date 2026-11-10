import type { Metadata } from "next";
import Link from "next/link";
import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";
import { FlowField } from "@/components/ui/FlowField";
import { SealedField } from "@/components/ui/SealedField";
import { CodeBlock, CopyButton } from "@/components/ui/CodeBlock";
import { ArrowUpRight } from "@/components/ui/ArrowUpRight";
import { RaetoMark } from "@/components/LivePartners";
import { CASH_OUT_FEE_PERCENT } from "@/lib/cashOutFee";

export const metadata: Metadata = {
  title: "Agents",
  description:
    "Fund an AI agent privately, let it pay and get paid over x402 within limits you set, and keep its balance off the public record. Live on Robinhood Chain.",
  alternates: { canonical: "/agents" },
};

/**
 * /agents: Gloam for the people who run AI agents and the platforms they run
 * on. One idea per screen: what Gloam does for an agent (and exactly what
 * stays public), a ten-minute start from the real MCP server and SDK, the
 * one-link deep link platforms send their users to, and Raeto, live today.
 * Every command and URL here is checked against mcp/README.md,
 * packages/sdk and lib/paymentRequest.
 */

const MCP_URL = "https://www.gloam.trade/mcp";

/** What Gloam does for an agent. `pub` is exactly what a stranger can read on chain. */
const THREE = [
  {
    id: "fund",
    title: "Fund it privately",
    body: "Top up an agent from your private balance. The Gloam relay sends it, so the payment comes from the vault, not from your wallet.",
    pub: "The agent's wallet, the token and the amount it receives. Paying its Gloam address instead keeps those private too.",
  },
  {
    id: "pay",
    title: "Pay and get paid privately",
    body: "Agents pay each other and pay for APIs over x402, from a private balance, inside spending limits the owner sets.",
    pub: "That a payment happened inside the vault. Not who paid, who got paid or how much.",
  },
  {
    id: "hold",
    title: "Trades in public, balance in private",
    body: "Swap from a private balance in the Gloam app on Robinhood Chain. The trade goes through a public DEX; what is held the rest of the time stays private. The SDK and MCP server do not swap yet.",
    pub: "The pair and the amounts of each swap, like any DEX trade. Not the wallet behind it, or the balance left.",
  },
];

const ENV = `# ~/.gloam/agent.env
GLOAM_NETWORK=robinhood-mainnet
# a key holding a little USDG, and ETH for gas
GLOAM_AGENT_PRIVATE_KEY=0x...
# openssl rand -hex 32, kept somewhere safe
GLOAM_NOTE_KEY=...
GLOAM_LIMIT_ASSETS=USDG
GLOAM_LIMIT_NETWORK=robinhood-mainnet
GLOAM_LIMIT_MAX_PER_PAYMENT=5
GLOAM_LIMIT_MAX_PER_DAY=20
GLOAM_LIMIT_RECIPIENTS=any`;

const SDK = `import {
  mainnetNetwork,
  generateReceiveKey,
  buildPaymentRequestLink,
} from "@gloamtrade/sdk";

const net = mainnetNetwork("robinhood")!;
const key = await generateReceiveKey(); // keep key.privateJwk on your server

// A link anyone can pay privately. The note comes back sealed to you.
const link = buildPaymentRequestLink({
  payTo: key.tag,
  network: net,
  asset: "USDG",
  amount: "25",
  note: "agent:42",
});

// Then scanIncomingPayments finds what was paid to key, and
// sweepReceivedNote secures each payment before you credit it.`;

const STEPS = [
  {
    n: "1",
    title: "Connect your agent",
    body: "Paste the URL into Claude, ChatGPT or Cursor as a custom connector. It reads and plans, and never asks for a key.",
    code: MCP_URL,
    file: "Hosted MCP server",
    lang: "text" as const,
    extra: "claude mcp add --transport http gloam-hosted https://www.gloam.trade/mcp",
  },
  {
    n: "2",
    title: "Let it pay, within limits",
    body: "Run the server on your own machine. It signs there, refuses anything over your limits, and keeps keys and balances off the model.",
    code: ENV,
    file: "agent.env",
    lang: "bash" as const,
    extra: "claude mcp add gloam -- npx -y @gloamtrade/mcp",
  },
  {
    n: "3",
    title: "Get paid in your own code",
    body: "Give each agent or account a link to pay it privately, then credit each payment by its note. This is how Raeto takes payments.",
    code: SDK,
    file: "npm i @gloamtrade/sdk",
    lang: "ts" as const,
    extra: null,
  },
];

const LINK_EXAMPLE =
  "https://gloam.trade/app/vault?tab=move&mode=pay#to=0xYourAgent&amount=25&asset=USDG&chain=robinhood-mainnet";

const PARAMS: [string, string][] = [
  ["to", "The agent's 0x address, an ENS name, or a Gloam address (gloamr1.…)"],
  ["amount", "Optional. Whole tokens, like 25 or 12.5. Leave it out to let the payer choose"],
  ["asset", "The token's symbol or address on that network, like USDG"],
  ["chain", "robinhood-mainnet or tempo-mainnet. robinhood and tempo are the testnets"],
  ["name", "Optional. Shown to the payer, up to 40 characters"],
  ["note", "Optional, up to 80 characters. Sealed inside a payment to a Gloam address; only shown to the payer otherwise"],
];

/** A copyable link that wraps instead of scrolling, so the whole of it reads on a phone. */
function LinkBlock({ title, value, className = "bg-panel" }: { title: string; value: string; className?: string }) {
  return (
    <div className={`overflow-hidden rounded-[16px] border border-line ${className}`}>
      <div className="flex items-center justify-between gap-3 border-b border-line py-1.5 pl-5 pr-2 text-[12.5px] text-mute">
        <span className="min-w-0 truncate">{title}</span>
        <CopyButton text={value} />
      </div>
      <p className="tnum px-5 py-4 text-[13.5px] leading-[1.8] text-soft [overflow-wrap:anywhere]">{value}</p>
    </div>
  );
}

export default function AgentsPage() {
  return (
    <div className="relative min-h-screen bg-panel text-foreground">
      <Header />

      <main>
        {/* hero */}
        <section className="mx-auto max-w-[1400px] px-4 pt-3 sm:px-7 sm:pt-6">
          <div className="gl-panel flex min-h-[max(520px,calc(100svh-8rem))] flex-col justify-end px-5 pb-8 pt-24 sm:px-10 sm:pb-10 lg:min-h-[620px] lg:px-14 lg:pb-14">
            <FlowField />
            <div className="relative z-10 max-w-[760px]">
              <p className="text-[15px] text-mute">Gloam for agents</p>
              <h1 className="t-display-xl mt-4">Private money for AI agents</h1>
              <p className="mt-6 max-w-[48ch] text-[18px] leading-[1.55] text-soft">
                For people who run agents, and the platforms they run on,
                starting on Robinhood Chain. Fund an agent, let it pay and get
                paid, and keep its balance off the public record.
              </p>
              <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-3">
                <a href="#quickstart" className="btn btn-ink btn-lg">
                  Start in 10 minutes
                </a>
                <a href="#fund-link" className="gl-arrowlink">
                  The link for platforms <span aria-hidden>→</span>
                </a>
              </div>
            </div>
          </div>
        </section>

        {/* the three things, each with exactly what stays public */}
        <section aria-labelledby="what-it-does" className="mx-auto max-w-[1400px] px-4 pt-20 sm:px-7 sm:pt-32">
          <div className="max-w-[720px]">
            <h2 id="what-it-does" className="t-display-l">
              Agents do business in public. Their money does not have to.
            </h2>
            <p className="mt-5 max-w-[56ch] text-[17px] leading-[1.6] text-mute sm:text-[19px]">
              On a public chain, anyone can read what an agent holds, who pays
              it and who it pays. Gloam keeps that private, and says plainly
              what still shows.
            </p>
          </div>
          <ol className="mt-12 divide-y divide-line border-y border-line">
            {THREE.map((t, i) => (
              <li
                key={t.id}
                id={t.id}
                className="grid scroll-mt-24 gap-4 py-8 sm:py-10 lg:grid-cols-[1fr_1.3fr] lg:gap-16"
              >
                <p className="flex items-baseline gap-4 text-[22px] leading-snug tracking-[-0.01em] sm:text-[26px]">
                  <span className="tnum text-[15px] text-faint">0{i + 1}</span>
                  {t.title}
                </p>
                <div className="max-w-[56ch]">
                  <p className="text-[16px] leading-relaxed text-soft sm:text-[17px]">{t.body}</p>
                  <p className="mt-3 text-[14px] leading-relaxed text-mute">
                    <span className="text-foreground">Public:</span> {t.pub}
                  </p>
                </div>
              </li>
            ))}
          </ol>
        </section>

        {/* quickstart */}
        <section id="quickstart" className="mx-auto max-w-[1400px] scroll-mt-20 px-4 pt-20 sm:px-7 sm:pt-32">
          <div className="theme-dark gl-panel border border-transparent bg-[#0b0c0e] px-5 py-12 text-foreground dark:border-line dark:bg-panel sm:px-12 sm:py-16">
            <div className="relative max-w-[640px]">
              <h2 className="t-display-l text-foreground">Start in 10 minutes</h2>
              <p className="mt-5 max-w-[50ch] text-[17px] leading-[1.6] text-mute">
                Three steps, each useful on its own. Start on the testnet with{" "}
                <span className="text-foreground">robinhood</span> in place of{" "}
                <span className="text-foreground">robinhood-mainnet</span>, then
                move to mainnet with small limits.
              </p>
            </div>
            <ol className="relative mt-12 divide-y divide-line border-t border-line">
              {STEPS.map((s) => (
                <li key={s.n} className="grid gap-6 py-10 lg:grid-cols-[0.8fr_1.2fr] lg:gap-16">
                  <div>
                    <p className="flex items-baseline gap-4 text-[20px] leading-snug tracking-[-0.01em] sm:text-[22px]">
                      <span className="tnum text-[15px] text-faint">{s.n}</span>
                      {s.title}
                    </p>
                    <p className="mt-3 max-w-[44ch] text-[15px] leading-relaxed text-mute">{s.body}</p>
                  </div>
                  <div className="min-w-0">
                    {s.lang === "text" ? (
                      <LinkBlock title={s.file} value={s.code} className="bg-surface" />
                    ) : (
                      <CodeBlock code={s.code} lang={s.lang} title={s.file} className="bg-surface" />
                    )}
                    {s.extra && (
                      <p className="mt-3 text-[13.5px] leading-relaxed text-mute">
                        In Claude Code:{" "}
                        <code className="tnum [overflow-wrap:anywhere] text-soft">{s.extra}</code>
                      </p>
                    )}
                  </div>
                </li>
              ))}
            </ol>
            <div className="relative mt-2 flex flex-wrap gap-x-6 gap-y-2 text-[13.5px]">
              <Link href="/docs/agents" className="text-soft transition-colors hover:text-foreground">
                Agents guide
              </Link>
              <Link href="/docs/agents#spending-limits" className="text-soft transition-colors hover:text-foreground">
                Spending limits
              </Link>
              <a
                href="https://github.com/gloamtrade/gloam/tree/main/packages/sdk/examples/receive-and-credit.ts"
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 text-soft transition-colors hover:text-foreground"
              >
                Full receive example <ArrowUpRight />
              </a>
              <a
                href="https://www.npmjs.com/package/@gloamtrade/mcp"
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 text-soft transition-colors hover:text-foreground"
              >
                MCP server on npm <ArrowUpRight />
              </a>
            </div>
          </div>
        </section>

        {/* the deep link platforms send their users to */}
        <section id="fund-link" className="mx-auto max-w-[1400px] scroll-mt-20 px-4 pt-20 sm:px-7 sm:pt-32">
          <div className="grid gap-12 lg:grid-cols-[1fr_1.3fr] lg:gap-16">
            <div>
              <p className="text-[14px] text-mute">For agent platforms</p>
              <h2 className="t-display-l mt-4 max-w-[14ch]">Fund your agent privately, in one link</h2>
              <p className="mt-5 max-w-[46ch] text-[17px] leading-[1.6] text-mute">
                Put this behind a button in your app. Gloam opens with the
                agent&apos;s address, the amount, the token and the network
                filled in. Your user checks it and confirms. Nothing is sent on
                its own.
              </p>
            </div>
            <div className="min-w-0">
              <LinkBlock title="Fund link" value={LINK_EXAMPLE} />
              <ul className="mt-6 divide-y divide-line border-y border-line">
                {PARAMS.map(([k, v]) => (
                  <li key={k} className="grid gap-1 py-3.5 sm:grid-cols-[96px_1fr] sm:gap-6">
                    <code className="tnum text-[14px] text-foreground">{k}</code>
                    <span className="text-[14px] leading-relaxed text-mute">{v}</span>
                  </li>
                ))}
              </ul>
              <p className="mt-6 max-w-[62ch] text-[14px] leading-relaxed text-mute">
                Everything after the # stays in the browser and never reaches a
                server. A 0x address or ENS name is paid through Cash out: the
                relay sends it from the user&apos;s private balance for {CASH_OUT_FEE_PERCENT},
                and the agent&apos;s wallet, the token and the amount are
                public. A Gloam address gets a private payment instead: free,
                with the amount hidden.
              </p>
              <Link href="/docs/agents#fund-link" className="gl-arrowlink mt-5">
                The full format <span aria-hidden>→</span>
              </Link>
            </div>
          </div>
        </section>

        {/* live today */}
        <section aria-labelledby="live" className="mx-auto max-w-[1400px] px-4 pt-20 sm:px-7 sm:pt-32">
          <div className="gl-panel overflow-clip bg-surface px-5 py-12 sm:px-12 sm:py-16">
            <SealedField tone="soft" />
            <div className="relative grid gap-10 lg:grid-cols-[1fr_1.3fr] lg:items-center lg:gap-16">
              <div>
                <a
                  href="https://raeto.cc"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex min-h-11 items-center gap-3 text-foreground transition-opacity hover:opacity-70"
                >
                  <RaetoMark size={40} />
                  <span className="text-[19px] tracking-[-0.01em]">Raeto</span>
                </a>
                <h2 id="live" className="t-display-l mt-6 max-w-[16ch]">
                  Private agent funding, live in production
                </h2>
              </div>
              <div className="max-w-[56ch]">
                <p className="text-[17px] leading-[1.6] text-soft">
                  Raeto sells AI credits on Robinhood Chain and takes Gloam
                  payments in production. Each account gets its own payment
                  link. Raeto&apos;s server finds each payment, secures it
                  through the relay, and credits the account.
                </p>
                <p className="mt-4 text-[15px] leading-relaxed text-mute">
                  The first live payment was credited in under a minute, on 23
                  October 2026.
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* fees and honesty */}
        <section className="mx-auto max-w-[1400px] px-4 pb-20 pt-20 sm:px-7 sm:pb-32 sm:pt-28">
          <div className="grid gap-10 sm:grid-cols-3">
            <div className="border-t border-foreground pt-5">
              <p className="text-[18px] leading-snug tracking-[-0.01em]">Free to pay privately</p>
              <p className="mt-3 text-[14px] leading-relaxed text-mute">
                Direct deposits and private payments cost nothing, and the relay
                pays the gas. Cash outs and swaps cost {CASH_OUT_FEE_PERCENT}.
              </p>
            </div>
            <div className="border-t border-foreground pt-5">
              <p className="text-[18px] leading-snug tracking-[-0.01em]">Live on mainnet</p>
              <p className="mt-3 text-[14px] leading-relaxed text-mute">
                Deposit limits apply. Kann Audits reviewed the vault contracts (
                <Link href="/security" className="text-soft underline decoration-line-strong underline-offset-4 transition-colors hover:text-foreground">
                  report
                </Link>
                ) and found no Critical, High or Medium issues.
              </p>
            </div>
            <div className="border-t border-foreground pt-5">
              <p className="text-[18px] leading-snug tracking-[-0.01em]">What stays public</p>
              <p className="mt-3 text-[14px] leading-relaxed text-mute">
                Deposits and cash outs show on chain, and the crowd of private
                balances is still small.
              </p>
              <Link href="/docs/privacy-model" className="gl-arrowlink mt-4">
                The privacy model <span aria-hidden>→</span>
              </Link>
            </div>
          </div>
        </section>
      </main>

      <Footer />
    </div>
  );
}
