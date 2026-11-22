import type { ReactNode } from "react";
import { parseMarkdown, type Inline } from "@/lib/updatesMailRender";

function inline(nodes: Inline[], key = "i"): ReactNode[] {
  return nodes.map((n, i) => {
    const k = `${key}-${i}`;
    if (n.t === "text") return n.v;
    if (n.t === "br") return <br key={k} />;
    if (n.t === "strong") return <strong key={k}>{inline(n.c, k)}</strong>;
    if (n.t === "em") return <em key={k}>{inline(n.c, k)}</em>;
    const external = !n.href.startsWith("https://www.gloam.trade/");
    return (
      <a key={k} href={n.href} {...(external && !n.href.startsWith("mailto:") ? { target: "_blank", rel: "noreferrer" } : {})}>
        {inline(n.c, k)}
      </a>
    );
  });
}

/**
 * An update's body on its web page (/updates/<id>): the same blocks the email
 * is drawn from (lib/updatesMailRender), as plain elements inside .article-prose.
 * React escapes every character, and only checked links become links.
 */
export function UpdateBody({ body }: { body: string }) {
  const blocks = parseMarkdown(body);
  return (
    <div className="article-prose">
      {blocks.map((b, i) => {
        if (b.t === "heading") {
          const c = inline(b.c, `h${i}`);
          return b.level === 1 ? <h2 key={i}>{c}</h2> : <h3 key={i}>{c}</h3>;
        }
        if (b.t === "paragraph") return <p key={i}>{inline(b.c, `p${i}`)}</p>;
        const items = b.items.map((it, j) => <li key={j}>{inline(it, `l${i}-${j}`)}</li>);
        return b.ordered ? (
          <ol key={i} start={b.start === 1 ? undefined : b.start}>
            {items}
          </ol>
        ) : (
          <ul key={i}>{items}</ul>
        );
      })}
    </div>
  );
}
