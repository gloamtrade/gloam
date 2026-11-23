import { docsCard } from "@/lib/docsCard";
import { PaperArt } from "@/lib/docsCardArt";

const title = "Updates";
const subtitle = "Every Gloam update we've emailed, to read on the web.";

export const alt = `Gloam updates: ${subtitle}`;
export { size, contentType } from "@/lib/docsCard";

/** The page sets its own openGraph, which drops the site's card: this puts one back. */
export default function OpenGraphImage() {
  return docsCard({ title, subtitle, art: <PaperArt />, section: "Updates" });
}
