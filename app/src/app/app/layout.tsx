import type { Metadata } from "next";
import { Web3Provider } from "@/components/app/Web3Provider";
import { TurnkeyEmbeddedProvider } from "@/components/app/TurnkeyEmbeddedProvider";
import { AppThemeScope } from "@/components/app/AppThemeScope";
import { liveMainnetNames } from "@/lib/mainnet";

export const metadata: Metadata = {
  title: {
    default: "App",
    template: "%s · Gloam",
  },
  description: `The Gloam app: a private balance, private payments, payroll and proofs on ${liveMainnetNames()} mainnet, and on the testnets.`,
};

export default function ProductLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <TurnkeyEmbeddedProvider>
      <AppThemeScope />
      <Web3Provider>{children}</Web3Provider>
    </TurnkeyEmbeddedProvider>
  );
}
