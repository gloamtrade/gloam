"use client";

import { useEffect, useState } from "react";
import type { WpSection } from "./WhitepaperParts";

/**
 * The contents rail: every section by number, the one in view marked. Sticky on
 * wide screens; on narrow ones the page reads top to bottom without it.
 */
export function WhitepaperToc({ sections }: { sections: WpSection[] }) {
  const [active, setActive] = useState(sections[0]?.id ?? "");

  useEffect(() => {
    const els = sections.map((s) => document.getElementById(s.id)).filter((e): e is HTMLElement => Boolean(e));
    if (els.length === 0) return;
    const onScroll = () => {
      const line = 160;
      let current = els[0]!.id;
      for (const el of els) {
        if (el.getBoundingClientRect().top - line <= 0) current = el.id;
      }
      setActive(current);
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [sections]);

  return (
    <nav aria-label="Contents" className="sticky top-28 hidden self-start lg:block">
      <p className="text-[13px] text-mute">Contents</p>
      <ol className="mt-5 space-y-1">
        {sections.map((s) => {
          const on = s.id === active;
          return (
            <li key={s.id}>
              <a
                href={`#${s.id}`}
                aria-current={on ? "true" : undefined}
                className={`group flex items-baseline gap-3 rounded-lg py-1.5 text-[14px] leading-snug transition-colors ${
                  on ? "text-foreground" : "text-mute hover:text-foreground"
                }`}
              >
                <span className={`tnum w-5 shrink-0 text-[12px] ${on ? "text-sealed" : "text-faint"}`}>{s.n}</span>
                <span>{s.title}</span>
              </a>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
