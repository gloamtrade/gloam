import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/app/AppShell";
import { SolanaOpen } from "@/components/app/SolanaOpen";
import { SOLANA_RINGS_ENABLED } from "@/lib/solanaRings/config";

export const metadata: Metadata = {
  title: "Solana",
  description: "A private account on Solana, opened by your wallet's signature.",
  robots: { index: false, follow: false },
};

/**
 * Solana is a network in the app's network menu now, with the same Portfolio,
 * Vault and Payroll as the others. This address stays for the links that name
 * it: it picks Solana and opens the Vault.
 */
export default function SolanaPage() {
  // Off unless NEXT_PUBLIC_SOLANA_RINGS_ENABLED is "1": the page answers 404.
  if (!SOLANA_RINGS_ENABLED) notFound();
  return (
    <AppShell title="Vault" subtitle="Add money privately, pay from your private balance, and cash out to any wallet.">
      <SolanaOpen />
    </AppShell>
  );
}
