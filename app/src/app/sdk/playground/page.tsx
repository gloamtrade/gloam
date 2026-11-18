import type { Metadata } from "next";
import Link from "next/link";
import { SDK_VERSION } from "@gloamtrade/sdk";
import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";
import { Playground } from "./Playground";
import { SHOW_TESTNETS } from "@/lib/showTestnets";

export const metadata: Metadata = {
  title: "SDK playground",
  description:
    "A simulation of adding @gloamtrade/sdk to a tip jar, a checkout and an agent paying over x402: see what a block explorer shows about each payment, then add a few lines and watch the sender, the receiver and the amount leave the public record.",
};

export default function SdkPlaygroundPage() {
  return (
    <div className="relative min-h-screen bg-panel text-foreground">
      <Header />

      <main className="mx-auto max-w-[1400px] px-4 pb-20 pt-10 sm:px-7 sm:pb-28 sm:pt-16">
        <div className="max-w-[760px]">
          <h1 className="t-display-l">Add privacy to anything</h1>
          <p className="mt-4 max-w-[54ch] text-[17px] leading-relaxed text-soft">
            Pick an app and see what the chain records about one payment. Then
            add Gloam and run the same payment again.
          </p>
        </div>

        <div className="mt-10 sm:mt-12">
          <Playground sdkVersion={SDK_VERSION} />
        </div>

        <div className="mt-8 grid gap-6 border-t border-line pt-6 md:grid-cols-[1fr_auto] md:items-start md:gap-12">
          <p className="max-w-[66ch] text-[14px] leading-relaxed text-mute">
            Still public with Gloam: adding money to a private balance, and
            cashing out. Both show the wallet, the token and the amount.
          </p>
          <div className="flex flex-wrap gap-x-6 gap-y-3">
            <Link href="/docs/privacy-model" className="gl-arrowlink">
              What stays private <span aria-hidden>→</span>
            </Link>
            {/* the testnet guide only while people see the testnets (lib/showTestnets) */}
            {SHOW_TESTNETS && (
              <Link href="/docs/testnet" className="gl-arrowlink">
                Run it on testnet <span aria-hidden>→</span>
              </Link>
            )}
          </div>
        </div>
      </main>

      <Footer />
    </div>
  );
}
