import { docsCard } from "@/lib/docsCard";
import { PlayArt } from "@/lib/docsCardArt";
import { CONTEST, CONTEST_POOL, CONTEST_RESULTS, CONTEST_TOTAL, contestDay } from "@/lib/contest";

const title = CONTEST_RESULTS ? "The winners" : `$${CONTEST_POOL} up for grabs`;
// a no-break space keeps the date on one line
const subtitle = CONTEST_RESULTS
  ? `Four winners and four honourable mentions, $${CONTEST_TOTAL} paid privately.`
  : `Make a video about Gloam. Entries close ${contestDay(CONTEST.closesAt, false).replace(" ", " ")}.`;

export const alt = `${CONTEST.name}: ${title}. ${subtitle}`;
export { size, contentType } from "@/lib/docsCard";

export default function OpenGraphImage() {
  return docsCard({ title, subtitle, art: <PlayArt />, section: "Video Contest" });
}
