import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/app/AppShell";
import { ClientOnly } from "@/components/app/ClientOnly";
import { FreshWalletView } from "@/components/app/FreshWalletView";
import { FRESH_WALLET_ENABLED } from "@/lib/freshWalletFlag";

export const metadata: Metadata = {
  title: "Fund a fresh wallet",
  description: "Fund a new wallet from your private balance on Robinhood Chain, with ETH for gas, ready to use Borro.",
  robots: { index: false, follow: false },
};

export default function FreshWalletPage() {
  // Off for now (lib/freshWalletFlag): the page answers 404 until the flag is "1".
  if (!FRESH_WALLET_ENABLED) notFound();
  return (
    <AppShell title="Fund a fresh wallet" subtitle="From your private balance, ready for Borro on Robinhood Chain.">
      {/* The balance and the network live in this browser. */}
      <ClientOnly>
        <FreshWalletView />
      </ClientOnly>
    </AppShell>
  );
}
