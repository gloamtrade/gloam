import { htmlComment, huntSourceClue, scriptLiteral } from "@/lib/hunt";

/**
 * Server component on the home page. With the treasure hunt on (lib/hunt), it puts
 * an HTML comment in the page source and a line in the browser console, both
 * from server environment variables. With it off it renders nothing at all.
 */
export function HuntSourceClue() {
  const clue = huntSourceClue();
  if (!clue) return null;
  return (
    <>
      {clue.comment && <div hidden aria-hidden dangerouslySetInnerHTML={{ __html: htmlComment(clue.comment) }} />}
      {clue.console && <script dangerouslySetInnerHTML={{ __html: `console.log(${scriptLiteral(clue.console)});` }} />}
    </>
  );
}
