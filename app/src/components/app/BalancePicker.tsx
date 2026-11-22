"use client";

/**
 * One dropdown for picking which private balance to spend (Pay from, Cash out
 * from): the chosen one in the button, the rest in a menu. Keeps the form
 * short however many balances there are.
 */
import { useEffect, useId, useRef, useState, type ReactNode } from "react";

export type BalanceOption = {
  id: string;
  mark: ReactNode;
  title: ReactNode;
  /** The network the balance is on ("BNB Chain"), first on the line under the amount. */
  network?: string;
  sub: string;
  /** Draw the sub part as a warning (a claim not secured yet). The network stays muted. */
  warn?: boolean;
  extra?: ReactNode;
};

export function BalancePicker({
  label,
  options,
  value,
  onChange,
  disabled,
}: {
  label: string;
  options: BalanceOption[];
  value: string | null;
  onChange: (id: string) => void;
  disabled?: boolean;
}) {
  const current = options.find((o) => o.id === value) ?? options[0];
  const [open, setOpen] = useState(false);
  const [focus, setFocus] = useState(0);
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const idBase = `bp${useId().replace(/[^a-zA-Z0-9]/g, "")}`;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  useEffect(() => {
    if (open) list.current?.focus();
  }, [open]);

  if (!current) return null;
  const single = options.length === 1;
  const pick = (i: number) => {
    onChange(options[i].id);
    setOpen(false);
    button.current?.focus();
  };
  const openAt = () => {
    setFocus(Math.max(0, options.indexOf(current)));
    setOpen(true);
  };

  const row = (o: BalanceOption) => (
    <>
      {o.mark}
      <span className="min-w-0 flex-1">
        <span className="tnum block truncate text-[16px] text-foreground">{o.title}</span>
        <span className="block truncate text-[12px] text-mute">
          {o.network}
          {o.network && o.sub ? " · " : null}
          {o.sub && <span className={o.warn ? "text-warn" : undefined}>{o.sub}</span>}
        </span>
        {o.extra}
      </span>
    </>
  );

  return (
    <div ref={wrap} className="relative">
      <p id={`${idBase}-label`} className="text-[13px] text-mute">{label}</p>
      <button
        ref={button}
        type="button"
        disabled={disabled || single}
        aria-haspopup={single ? undefined : "listbox"}
        aria-expanded={single ? undefined : open}
        aria-labelledby={`${idBase}-label`}
        onClick={() => (open ? setOpen(false) : openAt())}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            openAt();
          }
        }}
        className="mt-2 flex min-h-[60px] w-full items-center gap-3 rounded-[14px] border border-line bg-panel px-4 py-2.5 text-left transition-colors hover:border-line-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground/50 disabled:cursor-default disabled:hover:border-line"
      >
        {row(current)}
        {!single && (
          <span className="flex shrink-0 items-center gap-2 text-mute">
            <span className="text-[12.5px]">{options.length} balances</span>
            <svg aria-hidden width="16" height="16" viewBox="0 0 24 24" fill="none" className={`transition-transform ${open ? "rotate-180" : ""}`}>
              <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
        )}
      </button>
      {open && (
        <ul
          ref={list}
          role="listbox"
          tabIndex={-1}
          aria-labelledby={`${idBase}-label`}
          aria-activedescendant={`${idBase}-${focus}`}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              setOpen(false);
              button.current?.focus();
            } else if (e.key === "ArrowDown") {
              e.preventDefault();
              setFocus((i) => Math.min(options.length - 1, i + 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setFocus((i) => Math.max(0, i - 1));
            } else if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              pick(focus);
            } else if (e.key === "Tab") {
              setOpen(false);
            }
          }}
          className="absolute left-0 right-0 top-full z-40 mt-2 max-h-[340px] overflow-auto rounded-[16px] border border-line bg-panel p-1.5 shadow-pop outline-none"
        >
          {options.map((o, i) => {
            const active = o.id === current.id;
            return (
              <li
                key={o.id}
                id={`${idBase}-${i}`}
                role="option"
                aria-selected={active}
                onPointerEnter={() => setFocus(i)}
                onClick={() => pick(i)}
                className={`flex min-h-[56px] cursor-pointer items-center gap-3 rounded-[12px] px-2.5 py-2 ${focus === i ? "bg-surface" : ""}`}
              >
                {row(o)}
                {active && (
                  <svg aria-hidden width="16" height="16" viewBox="0 0 24 24" fill="none" className="shrink-0 text-foreground">
                    <path d="M5 12.5l4.5 4.5L19 7.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
