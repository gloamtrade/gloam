import { docsCard } from "@/lib/docsCard";
import { GuardArt } from "@/lib/docsCardArt";

const title = "Add Gloam to your agent kit or marketplace";
const subtitle = "Private payments for your agents, previewed before they sign.";

export const alt = `Gloam docs: ${title}. ${subtitle}`;
export { size, contentType } from "@/lib/docsCard";

export default function OpenGraphImage() {
  return docsCard({ title, subtitle, art: <GuardArt /> });
}
