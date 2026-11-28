import { docsCard } from "@/lib/docsCard";
import { StatusArt } from "@/lib/docsCardArt";

const title = "Status";
const subtitle = "The relay, each network and vault, the bridge and API, checked every five minutes.";

export const alt = `Gloam status: ${subtitle}`;
export { size, contentType } from "@/lib/docsCard";

/** The page sets its own openGraph, which drops the site's card: this puts one back. */
export default function OpenGraphImage() {
  return docsCard({ title, subtitle, art: <StatusArt />, section: "Status" });
}
