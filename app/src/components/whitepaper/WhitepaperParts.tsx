import type { ReactNode } from "react";

/**
 * The whitepaper's building blocks: one reading column, a numbered section
 * head, and a few shapes that replace long run-on bullets (a term list, three
 * columns, a pull line, a quiet note). Styles live in globals.css under .wp.
 */

export type WpSection = { id: string; n: string; title: string };

/** A numbered section: the number small and quiet, the title large and light. */
export function Section({ s, children }: { s: WpSection; children: ReactNode }) {
  return (
    <section id={s.id} aria-labelledby={`${s.id}-title`} className="wp-section">
      <header className="wp-head">
        <span className="wp-num tnum" aria-hidden>
          {s.n}
        </span>
        <h2 id={`${s.id}-title`}>{s.title}</h2>
      </header>
      <div className="wp-body">{children}</div>
    </section>
  );
}

/** A term and what it means, one row each, hairlines between. Replaces "<b>X</b>, long sentence" bullets. */
export function Terms({ items, numbered = false }: { items: { term: ReactNode; body: ReactNode }[]; numbered?: boolean }) {
  return (
    <dl className="wp-terms">
      {items.map((it, i) => (
        <div key={i} className="wp-term">
          <dt>
            {numbered && (
              <span className="wp-term-n tnum" aria-hidden>
                {String(i + 1).padStart(2, "0")}
              </span>
            )}
            {it.term}
          </dt>
          <dd>{it.body}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Up to three short lists side by side: what is visible, what is hidden, what weakens. */
export function Columns({ cols }: { cols: { title: string; tone?: "sealed" | "plain"; items: ReactNode[] }[] }) {
  return (
    <div className="wp-cols">
      {cols.map((c) => (
        <div key={c.title} className={`wp-col ${c.tone === "sealed" ? "is-sealed" : ""}`}>
          <p className="wp-col-title">{c.title}</p>
          <ul>
            {c.items.map((it, i) => (
              <li key={i}>{it}</li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

/** The one line a section turns on, set large. */
export function Pull({ children }: { children: ReactNode }) {
  return <p className="wp-pull">{children}</p>;
}

/** A quiet aside: a disclaimer, an honest limit. */
export function Note({ children }: { children: ReactNode }) {
  return <p className="wp-note">{children}</p>;
}

/** A sub-heading inside a section. */
export function Sub({ children }: { children: ReactNode }) {
  return <h3>{children}</h3>;
}
