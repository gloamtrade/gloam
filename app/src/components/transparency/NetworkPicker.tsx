"use client";

import Image from "next/image";
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { NETWORK_KEYS, getNetwork, type ChainFamily, type NetworkKey } from "@/lib/networks";

/**
 * The transparency page's network choice: Mainnets or Testnets, then the chain.
 * Every key in NETWORK_KEYS is one side plus one chain, so ?chain= deep links
 * land on the same pair of controls.
 */

type Side = "mainnet" | "testnet";

const LOGOS: Record<ChainFamily, string> = {
  robinhood: "/brand/chains/4663.png",
  tempo: "/brand/logos/tempo.svg",
  base: "/brand/chains/8453.png",
  ethereum: "/brand/chains/1.png",
  // A plain stand-in until Elysium's own mark is added (DEPLOY-ELYSIUM.md)
  elysium: "/brand/chains/elysium.svg",
};

const sideOf = (k: NetworkKey): Side => (getNetwork(k).testnet ? "testnet" : "mainnet");
const keysOn = (side: Side) => NETWORK_KEYS.filter((k) => sideOf(k) === side);
const SIDES: { side: Side; label: string }[] = (
  [
    { side: "mainnet", label: "Mainnets" },
    { side: "testnet", label: "Testnets" },
  ] as const
).filter((s) => keysOn(s.side).length > 0);

/** The same chain on the other side, else that side's first chain. */
function keyFor(side: Side, family: ChainFamily): NetworkKey {
  const on = keysOn(side);
  return on.find((k) => getNetwork(k).family === family) ?? on[0];
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      aria-hidden
      className={`shrink-0 text-mute transition-transform duration-200 ${open ? "rotate-180" : ""}`}
    >
      <path d="M3.5 5.25 7 8.75l3.5-3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Check() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden className="shrink-0 text-foreground">
      <path d="m3 7.25 2.5 2.5L11 4.25" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function SideSwitch({ value, onChange }: { value: NetworkKey; onChange: (k: NetworkKey) => void }) {
  const refs = useRef<Partial<Record<Side, HTMLButtonElement | null>>>({});
  const current = sideOf(value);
  const family = getNetwork(value).family;
  function onKey(e: KeyboardEvent<HTMLButtonElement>) {
    const i = SIDES.findIndex((s) => s.side === current);
    let j = -1;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") j = (i + 1) % SIDES.length;
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") j = (i - 1 + SIDES.length) % SIDES.length;
    else if (e.key === "Home") j = 0;
    else if (e.key === "End") j = SIDES.length - 1;
    if (j < 0) return;
    e.preventDefault();
    onChange(keyFor(SIDES[j].side, family));
    refs.current[SIDES[j].side]?.focus();
  }
  return (
    <div
      role="radiogroup"
      aria-label="Mainnets or testnets"
      className="flex rounded-full bg-surface-2 p-1 max-sm:w-full dark:bg-panel dark:ring-1 dark:ring-line"
    >
      {SIDES.map(({ side, label }) => {
        const active = side === current;
        return (
          <button
            key={side}
            ref={(el) => {
              refs.current[side] = el;
            }}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(keyFor(side, family))}
            onKeyDown={onKey}
            className={`flex h-11 items-center justify-center whitespace-nowrap rounded-full px-5 text-[14px] transition-colors duration-200 max-sm:flex-1 ${
              active ? "bg-panel font-medium text-foreground shadow-card dark:bg-surface-2" : "text-mute hover:text-foreground"
            }`}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

function ChainMenu({ value, onChange }: { value: NetworkKey; onChange: (k: NetworkKey) => void }) {
  const id = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const options = keysOn(sideOf(value));
  const [cursor, setCursor] = useState(0);
  const current = getNetwork(value);

  // a click or tap anywhere else closes it
  useEffect(() => {
    if (!open) return;
    function away(e: PointerEvent) {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);

  useEffect(() => {
    if (open) listRef.current?.focus();
  }, [open]);

  function show() {
    setCursor(Math.max(0, options.indexOf(value)));
    setOpen(true);
  }
  function close(refocus: boolean) {
    setOpen(false);
    if (refocus) buttonRef.current?.focus();
  }
  function pick(k: NetworkKey) {
    onChange(k);
    close(true);
  }

  function onButtonKey(e: KeyboardEvent<HTMLButtonElement>) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      show();
    }
  }
  function onListKey(e: KeyboardEvent<HTMLUListElement>) {
    if (e.key === "Escape") {
      e.preventDefault();
      close(true);
    } else if (e.key === "Tab") {
      close(false);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setCursor((c) => (c + 1) % options.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor((c) => (c - 1 + options.length) % options.length);
    } else if (e.key === "Home") {
      e.preventDefault();
      setCursor(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setCursor(options.length - 1);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      pick(options[cursor]);
    }
  }

  return (
    <div ref={wrapRef} className="relative max-sm:w-full">
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={`${id}-list`}
        aria-label={`Chain: ${current.label}`}
        onClick={() => (open ? close(false) : show())}
        onKeyDown={onButtonKey}
        className="flex h-[52px] w-full items-center gap-2.5 rounded-full bg-surface-2 pl-2.5 pr-4 text-[14px] font-medium text-foreground transition-colors duration-200 hover:bg-surface dark:bg-panel dark:ring-1 dark:ring-line dark:hover:bg-surface-2 sm:min-w-[208px]"
      >
        <Image src={LOGOS[current.family]} alt="" width={28} height={28} className="h-7 w-7 rounded-lg ring-1 ring-line" />
        <span className="flex-1 whitespace-nowrap text-left">{current.label}</span>
        <Chevron open={open} />
      </button>
      {open && (
        <ul
          ref={listRef}
          id={`${id}-list`}
          role="listbox"
          tabIndex={-1}
          aria-label="Chain"
          aria-activedescendant={`${id}-opt-${options[cursor]}`}
          onKeyDown={onListKey}
          className="absolute right-0 z-20 mt-2 w-full min-w-[208px] rounded-2xl bg-panel p-1.5 shadow-pop ring-1 ring-line focus:outline-none dark:bg-surface-2"
        >
          {options.map((k, i) => {
            const n = getNetwork(k);
            const selected = k === value;
            return (
              <li
                key={k}
                id={`${id}-opt-${k}`}
                role="option"
                aria-selected={selected}
                onClick={() => pick(k)}
                onPointerEnter={() => setCursor(i)}
                className={`flex h-11 cursor-pointer items-center gap-2.5 rounded-xl px-2 text-[14px] transition-colors duration-150 ${
                  i === cursor ? "bg-surface-2 text-foreground dark:bg-surface" : "text-soft"
                }`}
              >
                <Image src={LOGOS[n.family]} alt="" width={24} height={24} className="h-6 w-6 rounded-md ring-1 ring-line" />
                <span className="flex-1 whitespace-nowrap">{n.label}</span>
                {selected && <Check />}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export function NetworkPicker({ value, onChange }: { value: NetworkKey; onChange: (k: NetworkKey) => void }) {
  return (
    <div className="flex items-center gap-2 self-start max-sm:w-full max-sm:flex-col max-sm:items-stretch lg:self-auto">
      {SIDES.length > 1 && <SideSwitch value={value} onChange={onChange} />}
      <ChainMenu value={value} onChange={onChange} />
    </div>
  );
}
