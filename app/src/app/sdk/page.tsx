import type { Metadata } from "next";
import Link from "next/link";
import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";
import { SealedField } from "@/components/ui/SealedField";
import { FlowField } from "@/components/ui/FlowField";
import { SealDots } from "@/components/ui/SealDots";
import { CopyCommand } from "@/components/CopyCommand";
import { CodeTabs, type CodeTab } from "./SdkClient";
import { CodeBlock } from "@/components/ui/CodeBlock";
import { ArrowUpRight } from "@/components/ui/ArrowUpRight";
import { liveMainnetNames } from "@/lib/mainnet";

export const metadata: Metadata = {
  title: "SDK",
  description:
    `@gloamtrade/sdk: private balances, private payments and proofs for any app or agent on ${liveMainnetNames()}. Plus an MCP server so AI agents can pay over x402 without showing their treasury.`,
};

const GITHUB = "https://github.com/gloamtrade/gloam";


/* ---------- line icons (same hand as the landing) ---------- */

const icon = "h-6 w-6 text-foreground";
function IconBalance() {
  return (
    <svg className={icon} viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="3.5" y="6" width="17" height="12.5" rx="3" stroke="currentColor" strokeWidth="1.3" />
      <path d="M3.5 10h17" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="16.5" cy="14.5" r="1.1" fill="currentColor" />
    </svg>
  );
}
function IconSend() {
  return (
    <svg className={icon} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M4.5 12h13M13 7l5 5-5 5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function IconCashOut() {
  return (
    <svg className={icon} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M12 15V4.5M8 8.5l4-4 4 4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M5 13.5v4A2.5 2.5 0 0 0 7.5 20h9a2.5 2.5 0 0 0 2.5-2.5v-4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}
function IconProve() {
  return (
    <svg className={icon} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M12 3.5l7 2.8v5.2c0 4.3-2.9 7.6-7 9-4.1-1.4-7-4.7-7-9V6.3l7-2.8z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <path d="M9 12.2l2.2 2.2L15.2 10" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function IconRelay() {
  return (
    <svg className={icon} viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="5.5" cy="12" r="2" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="18.5" cy="12" r="2" stroke="currentColor" strokeWidth="1.3" />
      <path d="M7.5 12h3M13.5 12h3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <rect x="10.5" y="9.5" width="3" height="5" rx="1" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}
function IconChains() {
  return (
    <svg className={icon} viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="3.5" y="5" width="9" height="9" rx="2.5" stroke="currentColor" strokeWidth="1.3" />
      <rect x="11.5" y="10" width="9" height="9" rx="2.5" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}

const SURFACE = [
  {
    icon: <IconBalance />,
    title: "Private balances",
    body: "Move stablecoins into a balance only the holder can see or spend.",
    fn: "buildShieldBoundIntent",
  },
  {
    icon: <IconSend />,
    title: "Private payments",
    body: "Pay inside the vault to a Gloam address. No public transfer, no visible amount.",
    fn: "buildPrivateSendIntent",
  },
  {
    icon: <IconCashOut />,
    title: "Cash out",
    body: "Move money back to any public wallet, whenever the holder wants it public.",
    fn: "buildUnshieldIntent",
  },
  {
    icon: <IconRelay />,
    title: "Relay",
    body: "Sends and cash outs go out through the relay, so the sender's wallet never shows up. It can submit or refuse, never redirect.",
    fn: "relayIntent",
  },
  {
    icon: <IconProve />,
    title: "Prove",
    body: "Share one fact with one party, a payment with its issuer or a balance with an auditor, and nothing else.",
    fn: "buildComplianceDisclosure",
  },
  {
    icon: <IconChains />,
    title: "One core on each chain",
    body: `The same circuits and the same calls on ${liveMainnetNames()}, mainnet and testnet. Pick a network, keep the code.`,
    fn: "gloamNetworks",
  },
];

const PAY_SNIPPET = `import {
  mainnetNetwork,
  buildShieldBoundIntent,
  buildPrivateSendIntent,
  relayIntent,
  artifactProver,
  circuitArtifactUrls,
  syncTree,
  TEMPO_USDCE,
} from "@gloamtrade/sdk";

// Tempo mainnet. GLOAM_NETWORKS.tempo is the testnet.
const net = mainnetNetwork("tempo");
if (!net) throw new Error("Tempo mainnet pool not published yet");
const target = { chainId: net.chainId, poolAddress: net.pool, asset: TEMPO_USDCE };

// 1. Add money privately. Sign deposit.exec from your own wallet.
// Keep deposit.note.secret: it is the only key to this balance.
const deposit = await buildShieldBoundIntent({
  ...target,
  amountWei: parseUnits("10", 6),
  prover: artifactProver(circuitArtifactUrls("shield", net.chainId)),
});

// 2. Pay privately from that balance. The rest comes back as change.
const tree = await syncTree(publicClient, { pool: net.pool, fromBlock: net.deployBlock });
const send = await buildPrivateSendIntent({
  ...target,
  secretHex: deposit.note.secret,
  amountInWei: parseUnits("10", 6),
  amountPayWei: parseUnits("4", 6),
  path: await tree.pathForCommitment(deposit.note.commitment),
  prove: artifactProver(circuitArtifactUrls("transfer", net.chainId)),
});

// 3. Send it through the relay. Your wallet never shows up.
const hash = await relayIntent(send);`;

const X402_SNIPPET = `import {
  generateReceiveKey,
  buildGloamPaymentRequirements,
  buildGloamPayment,
  settleGloamPayment,
  decodePaymentHeader,
  sweepChainFromClient,
  relaySubmitter,
  artifactProver,
} from "@gloamtrade/sdk";

// Server, once: a receive key. Share the tag, keep the key.
const seller = await generateReceiveKey();

// Server: price a tool. This is the 402 challenge.
const requirements = buildGloamPaymentRequirements({
  amountWei: parseUnits("0.25", 6),
  assetSymbol: "USD",
  payTo: seller.tag, // the payment is sealed to this
  resource: "mcp://tool/summarize",
});

// Agent: pay privately from its own balance, then retry with the header.
const pay = await buildGloamPayment({
  requirements,
  senderSecretHex: note.secret,
  senderNoteAmountWei: note.amountWei,
  path,
  prove: artifactProver({ wasm, zkey }),
});

// Server: open, check and sweep the payment into a note only it knows.
const result = await settleGloamPayment({
  requirements,
  payload: decodePaymentHeader(xPaymentHeader),
  receiveKey: seller,
  prove: artifactProver({ wasm, zkey }),
  chain: sweepChainFromClient(publicClient, { pool, fromBlock }),
  submit: relaySubmitter(),
});
if (result.grantAccess) serve();`;

const CASHOUT_SNIPPET = `import {
  buildUnshieldIntent,
  relayIntent,
  artifactProver,
  circuitArtifactUrls,
  cashOutFee,
  syncTree,
} from "@gloamtrade/sdk";

const tree = await syncTree(publicClient, { pool: net.pool, fromBlock: net.deployBlock });

// Cash out to any public wallet. The recipient is fixed inside the proof.
const exit = await buildUnshieldIntent({
  chainId: net.chainId,
  poolAddress: net.pool,
  asset: TEMPO_USDCE,
  secretHex: note.secret,
  amountWei: parseUnits("6", 6),
  to: "0xYourPublicWallet",
  path: await tree.pathForCommitment(note.commitment),
  prove: artifactProver(circuitArtifactUrls("unshield", net.chainId)),
});

// On mainnet the pool keeps cashOutFee(amount), 0.5%, and pays the rest.
const fee = cashOutFee(parseUnits("6", 6));

// The relay can submit it or refuse it. It cannot send it anywhere else.
const hash = await relayIntent(exit);`;

const TABS: CodeTab[] = [
  { id: "pay", label: "Payment", file: "pay.ts", code: PAY_SNIPPET },
  { id: "x402", label: "Agent x402", file: "x402.ts", code: X402_SNIPPET },
  { id: "cashout", label: "Cash out", file: "cash-out.ts", code: CASHOUT_SNIPPET },
];

const MCP_TOOLS = [
  { name: "gloam_execute_shield", body: "Add money to the agent's private balance" },
  { name: "gloam_fetch_paid", body: "Fetch a URL and pay its 402 privately, in one call" },
  { name: "gloam_payment_requirements", body: "Price a tool or a dataset with a 402" },
  { name: "gloam_verify_payment", body: "Check a payment and sweep it before serving" },
  { name: "gloam_list_notes", body: "The agent's balances, as handles, never secrets" },
  { name: "gloam_get_spending_report", body: "What it spent today and what is left" },
];

const MCP_CONFIG = `{
  "mcpServers": {
    "gloam": {
      "command": "npx",
      "args": ["-y", "@gloamtrade/mcp"]
    }
  }
}`;

const EXAMPLES = [
  { name: "agent-shield", env: "Node", body: "The smallest agent: add money to a private balance." },
  { name: "pay-bot", env: "Node", body: "A private payment end to end: add, sync, send." },
  { name: "pay-x402", env: "Node", body: "An agent paying over x402: price, pay, verify." },
  { name: "web-shield", env: "Browser", body: "Add privately in the browser, read the balance back." },
];

/* ---------- live mini product: one x402 exchange ---------- */

function X402Exchange() {
  const rows = [
    { k: "Agent asks", v: "mcp://tool/summarize", note: "GET" },
    { k: "Tool answers", v: "Payment required", note: "402" },
  ];
  return (
    <div className="rounded-[14px] bg-panel p-4 sm:p-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-[13px] text-mute">Research agent</p>
          <p className="mt-0.5 text-[15px] text-foreground">Pays per call, privately</p>
        </div>
        <span className="rounded-full bg-surface px-2.5 py-1 text-[12px] text-mute">x402</span>
      </div>

      <ul className="mt-4 divide-y divide-line">
        {rows.map((r) => (
          <li key={r.k} className="flex min-h-[52px] items-center gap-3">
            <span className="tnum grid h-8 w-11 shrink-0 place-items-center rounded-full bg-surface text-[12px] text-foreground">
              {r.note}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[14px] text-foreground">{r.v}</p>
              <p className="text-[12px] text-mute">{r.k}</p>
            </div>
          </li>
        ))}
        <li className="flex min-h-[52px] items-center gap-3">
          <span className="grid h-8 w-11 shrink-0 place-items-center rounded-full bg-sealed-soft text-sealed">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden>
              <rect x="5" y="10.5" width="14" height="9.5" rx="2.5" stroke="currentColor" strokeWidth="2" />
              <path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" stroke="currentColor" strokeWidth="2" />
            </svg>
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[14px] text-foreground">Paid privately</p>
            <p className="text-[12px] text-mute">From the agent&apos;s own balance</p>
          </div>
          <span className="tnum text-[14px] text-foreground">0.25 USD</span>
        </li>
        <li className="flex min-h-[52px] items-center gap-3">
          <span className="tnum grid h-8 w-11 shrink-0 place-items-center rounded-full bg-surface text-[12px] text-foreground">
            200
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[14px] text-foreground">Summary delivered</p>
            <p className="text-[12px] text-mute">Payment checked first</p>
          </div>
        </li>
      </ul>

      <div className="mt-3 flex items-center justify-between gap-3 rounded-[10px] bg-surface px-3.5 py-2.5 text-[13px]">
        <span className="text-mute">
          <span className="max-sm:hidden">The explorer shows</span>
          <span className="sm:hidden">Explorer</span>
        </span>
        <span className="inline-flex items-center gap-2 whitespace-nowrap text-foreground">
          Private transfer <SealDots n={4} className="text-foreground/60" />
        </span>
      </div>
    </div>
  );
}

export default function SdkPage() {
  return (
    <div className="relative min-h-screen bg-panel text-foreground">
      <Header />

      <main>
        {/* hero */}
        <section className="mx-auto max-w-[1400px] px-4 pt-3 sm:px-7 sm:pt-6">
          <div className="gl-panel flex min-h-[max(520px,calc(100svh-8rem))] flex-col justify-end px-5 pb-8 pt-24 sm:px-10 sm:pb-10 lg:h-[calc(100svh-10rem)] lg:max-h-[980px] lg:min-h-[620px] lg:px-14 lg:pb-14">
            <FlowField />
            <div className="grid grid-cols-1 items-end gap-10 lg:grid-cols-[1.15fr_0.85fr] lg:gap-14">
              <div className="max-w-[720px]">
                <p className="t-label">Gloam SDK</p>
                <h1 className="t-display-xl mt-5">Private payments, as a package</h1>
                <p className="mt-6 max-w-[50ch] text-[16px] leading-relaxed text-soft sm:text-[17px]">
                  One import gives your app or agent private balances, private
                  payments and proofs on {liveMainnetNames()}. Real proofs,
                  checked on-chain, with no proving stack to build.
                </p>
                <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-3">
                  <Link href="/docs/quickstart" className="btn btn-ink btn-lg">
                    Read the quickstart
                  </Link>
                  <Link href="/docs/sdk/reference" className="gl-arrowlink">
                    API reference <span aria-hidden>→</span>
                  </Link>
                </div>
              </div>

              <div className="gl-glass w-full p-2 lg:max-w-[460px] lg:justify-self-end">
                <div className="rounded-[12px] bg-panel p-4 sm:p-5">
                  <p className="text-[13px] text-mute">Install the SDK</p>
                  <div className="mt-2.5">
                    <CopyCommand command="npm install @gloamtrade/sdk viem" />
                  </div>
                  <p className="mt-5 text-[13px] text-mute">Or start from a working app</p>
                  <div className="mt-2.5">
                    <CopyCommand command="npm create gloam-app@latest" />
                  </div>
                  <div className="mt-5 flex flex-wrap gap-1.5 text-[12px] text-mute">
                    {["TypeScript", "Node and browser", "Open source, MIT"].map((t) => (
                      <span key={t} className="rounded-full bg-surface px-2.5 py-1">
                        {t}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* quickstart: the ink panel */}
        <section id="quickstart" className="mx-auto max-w-[1400px] scroll-mt-20 px-4 py-14 sm:px-7 sm:py-20">
          <div className="theme-dark gl-panel grid grid-cols-1 gap-12 border border-line bg-background px-5 py-14 text-foreground sm:px-12 sm:py-20 lg:grid-cols-[0.8fr_1.2fr] lg:gap-16">
            <SealedField tone="soft" />
            <div className="relative">
              <p className="t-label">Quickstart</p>
              <h2 className="t-display-l mt-4 max-w-[14ch]">Three calls to a private payment</h2>
              <p className="mt-5 max-w-[46ch] text-[16px] leading-relaxed text-mute">
                Add money privately, pay from that balance, then hand the payment
                to the relay. You sign everything yourself. The SDK never holds a
                key.
              </p>
              <ul className="mt-10 divide-y divide-line border-y border-line text-[15px]">
                <li className="flex flex-wrap items-center justify-between gap-x-6 gap-y-1 py-4">
                  <span>Add money privately</span>
                  <span className="text-[13.5px] text-mute">buildShieldBoundIntent</span>
                </li>
                <li className="flex flex-wrap items-center justify-between gap-x-6 gap-y-1 py-4">
                  <span>Pay privately</span>
                  <span className="text-[13.5px] text-mute">buildPrivateSendIntent</span>
                </li>
                <li className="flex flex-wrap items-center justify-between gap-x-6 gap-y-1 py-4">
                  <span>Send through the relay</span>
                  <span className="text-[13.5px] text-mute">relayIntent</span>
                </li>
              </ul>
              <div className="mt-8 flex flex-wrap gap-x-6 gap-y-3">
                <Link
                  href="/docs/quickstart"
                  className="gl-arrowlink"
                >
                  Full walkthrough <span aria-hidden>→</span>
                </Link>
                <Link
                  href="/docs/sdk"
                  className="gl-arrowlink"
                >
                  SDK docs <span aria-hidden>→</span>
                </Link>
                <Link href="/sdk/playground" className="gl-arrowlink">
                  Try it live <span aria-hidden>→</span>
                </Link>
              </div>
            </div>
            <div className="relative min-w-0">
              <CodeTabs tabs={TABS} />
            </div>
          </div>
        </section>

        {/* the surface */}
        <section className="mx-auto max-w-[1240px] px-6 pb-20 sm:pb-28">
          <div className="max-w-[720px]">
            <h2 className="t-display-l">Everything a private app needs, in one import</h2>
            <p className="mt-5 max-w-[56ch] text-[16px] leading-relaxed text-mute">
              The same core that runs the Gloam app. Pure TypeScript that works in
              the browser and on a server, with the prover passed in so you
              choose where proofs are made.
            </p>
          </div>
          <div className="mt-14 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {SURFACE.map((s) => (
              <div key={s.title} className="gl-tile flex min-h-[208px] flex-col p-6 sm:min-h-[248px]">
                <div className="flex items-start justify-between gap-4">
                  {s.icon}
                  <span className="max-w-full truncate rounded-full bg-panel px-2.5 py-1 text-[12px] text-mute">
                    {s.fn}
                  </span>
                </div>
                <div className="mt-auto pt-8 sm:pt-10">
                  <p className="text-[19px] leading-snug tracking-[-0.01em] text-foreground">
                    {s.title}
                  </p>
                  <p className="mt-2 text-[14px] leading-relaxed text-mute">{s.body}</p>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* agents */}
        <section id="agents" className="mx-auto max-w-[1400px] scroll-mt-20 px-4 sm:px-7">
          <div className="gl-panel grid grid-cols-1 gap-12 bg-surface px-5 py-14 sm:px-12 sm:py-20 lg:grid-cols-2 lg:items-center lg:gap-16">
            <SealedField tone="soft" />
            <div className="relative">
              <p className="t-label">For agents</p>
              <h2 className="t-display-l mt-4 max-w-[14ch]">Agents pay without showing their treasury</h2>
              <p className="mt-5 max-w-[48ch] text-[16px] leading-relaxed text-mute">
                Agents pay for tools and data over HTTP 402. With Gloam the agent
                settles each payment privately from its own balance, then shows
                the payment as proof. Only the payer and the payee learn the
                amount, and no operator ever holds the agent&apos;s key or money.
              </p>
              <ul className="mt-10 divide-y divide-line border-y border-line">
                {MCP_TOOLS.map((t) => (
                  <li
                    key={t.name}
                    className="flex flex-col gap-1 py-3.5 sm:flex-row sm:items-center sm:justify-between sm:gap-6"
                  >
                    <span className="text-[14.5px] text-foreground">{t.body}</span>
                    <span className="truncate text-[13px] text-mute">{t.name}</span>
                  </li>
                ))}
              </ul>
              <div className="mt-8 flex flex-wrap gap-2">
                <Link href="/docs/agents" className="btn btn-ink">
                  Build a private agent
                </Link>
                <a
                  href={`${GITHUB}/tree/main/mcp`}
                  target="_blank"
                  rel="noreferrer"
                  className="btn btn-quiet"
                >
                  MCP server on GitHub <ArrowUpRight />
                </a>
              </div>
            </div>

            <div className="relative min-w-0">
              <div className="gl-glass p-2 shadow-pop">
                <X402Exchange />
              </div>
              <div className="theme-dark mt-3 text-foreground">
                <CodeBlock code={MCP_CONFIG} lang="json" title="Connect any MCP client" meta="mcp.json" className="bg-background" />
              </div>
            </div>
          </div>
        </section>

        {/* start from a reference */}
        <section className="mx-auto max-w-[1240px] px-6 py-20 sm:py-28">
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_1.35fr]">
            <div className="gl-card flex flex-col justify-between p-7 sm:p-9">
              <div>
                <p className="t-label">create-gloam-app</p>
                <h2 className="t-display-m mt-4 max-w-[14ch]">One command to a working app</h2>
                <p className="mt-4 max-w-[44ch] text-[15px] leading-relaxed text-mute">
                  Scaffolds a Next.js app already wired to the SDK, with private
                  balances and payments working on testnet from the
                  first run.
                </p>
              </div>
              <div className="mt-10">
                <CopyCommand command="npm create gloam-app@latest my-private-app" />
              </div>
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              {EXAMPLES.map((ex) => (
                <a
                  key={ex.name}
                  href={`${GITHUB}/tree/main/examples/${ex.name}`}
                  target="_blank"
                  rel="noreferrer"
                  className="gl-tile group flex min-h-[176px] flex-col p-6 transition-colors hover:bg-surface-2"
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="rounded-full bg-panel px-2.5 py-1 text-[12px] text-mute">{ex.env}</span>
                    <ArrowUpRight className="text-mute transition-transform duration-200 group-hover:-translate-y-0.5 group-hover:translate-x-0.5 group-hover:text-foreground" />
                  </div>
                  <div className="mt-auto pt-8">
                    <p className="text-[18px] leading-snug tracking-[-0.01em] text-foreground">{ex.name}</p>
                    <p className="mt-1.5 text-[14px] leading-relaxed text-mute">{ex.body}</p>
                  </div>
                </a>
              ))}
            </div>
          </div>
        </section>

        {/* honest status */}
        <section className="mx-auto max-w-[1240px] px-6 pb-8">
          <div className="grid grid-cols-1 gap-12 lg:grid-cols-[1fr_2fr]">
            <div>
              <h2 className="t-display-l max-w-[11ch]">Honest about where it is</h2>
              <div className="mt-6 flex flex-wrap gap-x-6 gap-y-3">
                <a
                  href={GITHUB}
                  target="_blank"
                  rel="noreferrer"
                  className="gl-arrowlink"
                >
                  Source on GitHub <ArrowUpRight />
                </a>
                <a
                  href="https://www.npmjs.com/package/@gloamtrade/sdk"
                  target="_blank"
                  rel="noreferrer"
                  className="gl-arrowlink"
                >
                  npm <ArrowUpRight />
                </a>
              </div>
            </div>
            <div className="grid grid-cols-1 gap-10 sm:grid-cols-3">
              {[
                {
                  title: "Live on mainnet",
                  body: `Live on ${liveMainnetNames()} mainnet, under deposit limits. The testnets stay open.`,
                },
                {
                  title: "Keys",
                  body: "Mainnet, Base Sepolia and Ethereum Sepolia proofs use the final keys from the 13-contributor ceremony; the Robinhood Chain and Tempo testnets use development keys. Reviewed internally before launch; Kann Audits has since reviewed the vault contracts and found no Critical, High or Medium issues.",
                },
                {
                  title: "Nothing faked",
                  body: "If a path cannot be private yet, the SDK returns a plan instead of a pretend result.",
                },
              ].map((t) => (
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
