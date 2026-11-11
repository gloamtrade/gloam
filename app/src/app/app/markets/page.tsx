import type { Metadata } from "next";
import { AppShell } from "@/components/app/AppShell";
import { MarketsView } from "@/components/app/MarketsView";

export const metadata: Metadata = {
  title: "Markets",
};

export default function MarketsPage() {
  return (
    <AppShell
      title="Markets"
      subtitle="Live prices for tokenized stocks on Robinhood Chain. Trade in the open, or add them privately to keep your size private."
    >
      <MarketsView />
    </AppShell>
  );
}
