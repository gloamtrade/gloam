import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/app/AppShell";
import { ClientOnly } from "@/components/app/ClientOnly";
import { SolanaRingsView } from "@/components/app/SolanaRingsView";
import { SOLANA_RINGS_ENABLED } from "@/lib/solanaRings/config";

export const metadata: Metadata = {
  title: "Solana",
  description: "A private account on Solana, opened by your wallet's signature.",
  robots: { index: false, follow: false },
};

export default function SolanaPage() {
  // Off unless NEXT_PUBLIC_SOLANA_RINGS_ENABLED is "1": the page answers 404.
  if (!SOLANA_RINGS_ENABLED) notFound();
  return (
    <AppShell title="Solana" subtitle="Private payments on Solana. The asset and the amount stay hidden.">
      {/* The private account's keys live only in this tab. */}
      <ClientOnly>
        <SolanaRingsView />
      </ClientOnly>
    </AppShell>
  );
}
