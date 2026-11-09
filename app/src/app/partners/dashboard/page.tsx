import type { Metadata } from "next";
import { TurnkeyEmbeddedProvider } from "@/components/app/TurnkeyEmbeddedProvider";
import { PartnerDashboard } from "./PartnerDashboard";

export const metadata: Metadata = {
  title: "Partner portal",
  description: "Your Gloam API keys, fee setting, payout addresses, volume and would-be commissions.",
  robots: { index: false, follow: false },
};

export default function PartnerDashboardPage() {
  // Gloam wallets (email sign-in) only load when NEXT_PUBLIC_TURNKEY_ENABLED is on; otherwise this is a plain wrapper.
  return (
    <TurnkeyEmbeddedProvider>
      <PartnerDashboard />
    </TurnkeyEmbeddedProvider>
  );
}
