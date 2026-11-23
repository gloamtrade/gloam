import { docsCard } from "@/lib/docsCard";
import { SealArt } from "@/lib/docsCardArt";

const title = "Security";
const subtitle = "Kann Audits reviewed the vault contracts. The report, its scope, and how to report a bug.";

export const alt = `Gloam security: ${subtitle}`;
export { size, contentType } from "@/lib/docsCard";

/** The page sets its own openGraph, which drops the site's card: this puts one back. */
export default function OpenGraphImage() {
  return docsCard({ title, subtitle, art: <SealArt />, section: "Security" });
}
