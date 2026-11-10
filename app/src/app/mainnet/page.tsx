import type { Metadata } from "next";
import Link from "next/link";
import { AppLink } from "@/components/AppLink";
import { Footer } from "@/components/Footer";
import { Header } from "@/components/Header";
import { FlowField } from "@/components/ui/FlowField";
import { MAINNET_LAUNCH_LABEL, liveMainnetNames } from "@/lib/mainnet";
import { swapMainnets } from "@/lib/vaultSwap";
import { CASH_OUT_FEE_PERCENT } from "@/lib/cashOutFee";

/** The mainnets with a pool in, as words: Base and Ethereum join once theirs are (lib/mainnet.ts). */
const MAINNETS = liveMainnetNames();

export const metadata: Metadata = {
  title: "Mainnet",
  description: `Gloam is live on ${MAINNETS} mainnet: private stablecoin payments for people and AI agents.`,
  alternates: { canonical: "/mainnet" },
  openGraph: {
    title: "Gloam is live on mainnet",
    description: `Private payments are live on ${MAINNETS} mainnet.`,
  },
};

const LIVE = [
  { title: MAINNETS, body: "Private payments on each mainnet, for people, teams and agents." },
  { title: "Free to pay", body: `Direct deposits and private payments are free. Cash-outs carry a ${CASH_OUT_FEE_PERCENT} fee.` },
  { title: "$GLOAM, held privately", body: "Shield $GLOAM next to USDG in the Robinhood Chain pool." },
  { title: "Private swaps", body: `Swap from your private balance on ${swapMainnets()}. Who swapped stays private; the amounts are public.` },
];

export default function MainnetPage() {
  return (
    <div className="relative min-h-screen bg-panel text-foreground">
      <Header />

      <main>
        <section className="mx-auto max-w-[1400px] px-4 pt-3 sm:px-7 sm:pt-6">
          <div className="gl-panel flex min-h-[max(560px,calc(100svh-8rem))] flex-col justify-center px-5 pb-10 pt-24 sm:px-10 lg:max-h-[980px] lg:px-14">
            <FlowField />
            <div className="relative z-10 mx-auto w-full max-w-[1040px]">
              <p className="t-label">Mainnet</p>
              <h1 className="t-display-xl mt-5 max-w-[16ch]">Gloam is live on mainnet</h1>

              <div className="mt-10 flex flex-col gap-3 sm:mt-12">
                <p className="t-display-l max-w-[22ch]">Private payments, on mainnet.</p>
                <p className="max-w-[46ch] text-[16px] leading-relaxed text-soft">Live on {MAINNETS}.</p>
              </div>

              <p className="mt-8 text-[18px] tracking-[-0.01em]">{MAINNET_LAUNCH_LABEL}</p>

              <div className="mt-6 flex flex-wrap gap-2">
                <AppLink href="/app" className="btn btn-ink btn-lg">
                  Open the app
                </AppLink>
                <a href="https://x.com/gloamtrade" target="_blank" rel="noopener noreferrer" className="btn btn-quiet btn-lg">
                  Follow on X <span aria-hidden>→</span>
                </a>
              </div>
            </div>
          </div>
        </section>

        <section className="mx-auto max-w-[1240px] px-6 py-20 sm:py-28">
          <div className="grid grid-cols-1 gap-12 lg:grid-cols-[1fr_2fr]">
            <div>
              <h2 className="t-display-l max-w-[12ch]">What is live</h2>
              <p className="mt-5 max-w-[34ch] text-[15px] leading-relaxed text-mute">
                The same Gloam you can try today, on mainnet.
              </p>
            </div>
            <div className="grid grid-cols-1 gap-10 sm:grid-cols-2">
              {LIVE.map((l) => (
                <div key={l.title} className="border-t border-foreground pt-5">
                  <p className="text-[19px] leading-tight tracking-[-0.015em]">{l.title}</p>
                  <p className="mt-3 text-[14px] leading-relaxed text-mute">{l.body}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="mx-auto max-w-[1240px] px-6 pb-8">
          <div className="flex flex-col items-start gap-4 border-t border-line pt-10 sm:flex-row sm:items-center sm:justify-between">
            <p className="max-w-[46ch] text-[15px] leading-relaxed text-soft">
              The testnet stays open for trying things first.
            </p>
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
              <AppLink href="/app" className="gl-arrowlink">
                {/* /app opens on mainnet; the testnet is one pick away in its network menu */}
                Open the app <span aria-hidden>→</span>
              </AppLink>
              <Link href="/docs/testnet" className="gl-arrowlink">
                Testnet guide <span aria-hidden>→</span>
              </Link>
            </div>
          </div>
        </section>
      </main>

      <Footer />
    </div>
  );
}
