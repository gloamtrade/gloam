import type { Metadata } from "next";
import Link from "next/link";
import { AppShell } from "@/components/app/AppShell";
import { PayrollView } from "@/components/app/PayrollView";
import { ClientOnly } from "@/components/app/ClientOnly";
import { SolanaOr } from "@/components/app/SolanaOr";
import { SolanaPayrollPage } from "@/components/app/SolanaPayrollView";
import { StarknetPayrollPage } from "@/components/app/StarknetPayrollView";

export const metadata: Metadata = {
  title: "Payroll",
};

export default function PayrollPage() {
  return (
    <AppShell
      title="Payroll"
      subtitle="Pay your whole team at once. Everyone gets paid, and nobody can look up who got what."
      subtitleSolana="Pay your whole team at once from your private balance. On Solana the token and every amount stay hidden."
      subtitleStarknet="Pay your whole team at once from your private balance. On Starknet one proof pays many people, and nobody can see who got what."
      actions={
        <Link href="/docs/payroll" className="btn btn-ghost btn-sm">
          How payroll works
        </Link>
      }
    >
      {/* Balances, runs and the network all live in this browser. */}
      <ClientOnly>
        <SolanaOr solana={<SolanaPayrollPage />} starknet={<StarknetPayrollPage />}>
          <PayrollView />
        </SolanaOr>
      </ClientOnly>
    </AppShell>
  );
}
