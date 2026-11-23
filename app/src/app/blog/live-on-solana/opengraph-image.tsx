import { docsCard } from "@/lib/docsCard";
import { ShieldArt } from "@/lib/docsCardArt";

const title = "Gloam is live on Solana";
const subtitle = "Private payments for people, teams and agents, built on Helius Privacy Rings.";

export const alt = `Gloam: ${title}. ${subtitle}`;
export { size, contentType } from "@/lib/docsCard";

export default function OpenGraphImage() {
  return docsCard({ title, subtitle, art: <ShieldArt />, section: "Announcement" });
}
