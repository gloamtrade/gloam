import { docsCard } from "@/lib/docsCard";
import { ShieldArt } from "@/lib/docsCardArt";

const title = "Compliance";
const subtitle = "How to reach Gloam, how deposits and cash-outs are screened, and who can change what.";

export const alt = `Gloam compliance: ${subtitle}`;
export { size, contentType } from "@/lib/docsCard";

/** The page sets its own openGraph, which drops the site's card: this puts one back. */
export default function OpenGraphImage() {
  return docsCard({ title, subtitle, art: <ShieldArt />, section: "Compliance" });
}
