import { docsCard } from "@/lib/docsCard";
import { ShieldArt } from "@/lib/docsCardArt";
import { SOLANA_RINGS_ENABLED } from "@/lib/solanaRings/config";

const title = "Gloam is live on Solana";
const subtitle = SOLANA_RINGS_ENABLED
  ? "Private payments for people, teams and agents, built on Helius Privacy Rings."
  : "Private payments for people, teams and agents.";

export const alt = `Gloam: ${title}. ${subtitle}`;
export { size, contentType } from "@/lib/docsCard";

export default function OpenGraphImage() {
  return docsCard({ title, subtitle, art: <ShieldArt />, section: "Announcement" });
}
