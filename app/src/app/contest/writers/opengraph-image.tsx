import { docsCard } from "@/lib/docsCard";
import { PaperArt } from "@/lib/docsCardArt";
import { contestDay } from "@/lib/contest";
import { WRITING_CONTEST } from "@/lib/writingContest";

const title = "Write about private money";
// a no-break space keeps the date on one line
const subtitle = `Threads and articles about Gloam. Entries close ${contestDay(WRITING_CONTEST.closesAt, false).replace(" ", "\u00a0")}.`;

export const alt = `${WRITING_CONTEST.name}: ${title}. ${subtitle}`;
export { size, contentType } from "@/lib/docsCard";

export default function OpenGraphImage() {
  return docsCard({ title, subtitle, art: <PaperArt />, section: "Writing Contest" });
}
