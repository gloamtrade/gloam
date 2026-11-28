import type { Metadata } from "next";
import { AppShell } from "@/components/app/AppShell";
import { PortfolioView } from "@/components/app/PortfolioView";
import { PortfolioHelp } from "@/components/app/PortfolioHelp";
import { SolanaOr } from "@/components/app/SolanaOr";
import { SolanaPortfolioView } from "@/components/app/SolanaPortfolioView";
import { StarknetPortfolioView } from "@/components/app/StarknetPortfolioView";

export const metadata: Metadata = {
  title: "Portfolio",
};

export default function AppHomePage() {
  return (
    <AppShell
      title="Portfolio"
      subtitle="Your private balance and your public wallet, side by side."
      subtitleTempo="Private stablecoin payments for people and agents. Your private balance and your public wallet, side by side."
      subtitleSolana="Your private balance and your Solana wallet, side by side."
      subtitleStarknet="Your private balance on Starknet, and what sits on your Starknet account."
      actions={<PortfolioHelp />}
    >
      <SolanaOr solana={<SolanaPortfolioView />} starknet={<StarknetPortfolioView />}>
        <PortfolioView />
      </SolanaOr>
    </AppShell>
  );
}
