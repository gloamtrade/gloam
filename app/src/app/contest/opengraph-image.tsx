import { docsCard } from "@/lib/docsCard";
import { PlayArt } from "@/lib/docsCardArt";
import { CONTEST, CONTEST_TOTAL, contestDay } from "@/lib/contest";

const title = `$${CONTEST_TOTAL} up for grabs`;
// a no-break space keeps the date on one line
const subtitle = `Make a short video about Gloam. Entries close ${contestDay(CONTEST.closesAt, false).replace(" ", "\u00a0")}.`;

export const alt = `${CONTEST.name}: ${title}. ${subtitle}`;
export { size, contentType } from "@/lib/docsCard";

export default function OpenGraphImage() {
  return docsCard({ title, subtitle, art: <PlayArt />, section: "Video Contest" });
}
