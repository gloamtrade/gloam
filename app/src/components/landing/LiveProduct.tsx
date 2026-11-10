"use client";

import Image from "next/image";
import Link from "next/link";
import { AppLink } from "@/components/AppLink";
import { useState, type ReactNode } from "react";
import { SealDots } from "@/components/ui/SealDots";

/**
 * The three product cards on the landing, as small working demos. Each card has
 * controls to click, the page-wide toggle switches between what you see and what
 * anyone looking at the chain sees, and the main button opens the real screen in
 * the app. Cards grow with their content so nothing overlaps the buttons.
 */

type View = "you" | "public";

const fmt = (n: number) => n.toLocaleString("en-US");

function Token({ src }: { src: string }) {
  return <Image src={src} alt="" width={20} height={20} className="h-5 w-5 shrink-0 rounded-full" />;
}

function Hidden() {
  return (
    <span className="inline-flex items-center gap-1.5 font-medium text-sealed">
      <span className="h-1.5 w-1.5 rounded-full bg-sealed" /> Hidden
    </span>
  );
}

function OnlyYou() {
  return (
    <span className="inline-flex items-center gap-1.5 font-medium text-sealed">
      <span className="h-1.5 w-1.5 rounded-full bg-sealed" /> Only you
    </span>
  );
}

function Chips<T extends string | number>({
  label,
  options,
  value,
  onChange,
  show = (o) => String(o),
}: {
  label: string;
  options: readonly T[];
  value: T;
  onChange: (v: T) => void;
  show?: (o: T) => string;
}) {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap gap-1.5">
      {options.map((o) => (
        <button
          key={String(o)}
          type="button"
          aria-pressed={o === value}
          onClick={() => onChange(o)}
          className={`tnum h-8 rounded-full px-3 text-[12.5px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sealed ${
            o === value ? "bg-foreground text-panel" : "bg-panel text-mute hover:text-foreground"
          }`}
        >
          {show(o)}
        </button>
      ))}
    </div>
  );
}

function Card({ children }: { children: ReactNode }) {
  return <div className="flex flex-1 flex-col rounded-[16px] bg-panel p-4 shadow-card">{children}</div>;
}

const ADD_AMOUNTS: readonly number[] = [100, 1000, 5000];

function AddCard({ view }: { view: View }) {
  const pub = view === "public";
  const [amt, setAmt] = useState<number>(1000);
  return (
    <Card>
      <div className="rounded-[12px] bg-surface p-3.5">
        <div className="flex items-center justify-between text-[12px] text-mute">
          <span>{pub ? "Deposit from 0x7a3…f21" : "You add"}</span>
          <span className="inline-flex items-center gap-1.5 rounded-full bg-panel px-2 py-0.5 text-foreground">
            <Token src="/brand/logos/usdg.png" /> USDG
          </span>
        </div>
        <p className="tnum mt-2 text-[26px] font-light leading-none tracking-[-0.02em]">{fmt(amt)}</p>
        <div className="mt-3">
          <Chips label="Amount to add" options={ADD_AMOUNTS} value={amt} onChange={setAmt} show={fmt} />
        </div>
      </div>
      <div className="relative z-10 -my-2 mx-auto grid h-7 w-7 place-items-center rounded-full border-4 border-panel bg-sealed-soft text-sealed">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden>
          <path d="M12 5v14m0 0l-5-5m5 5l5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>
      <div className="rounded-[12px] bg-surface p-3.5">
        <div className="flex items-center justify-between text-[12px] text-mute">
          <span>Private balance</span>
          {pub ? <Hidden /> : <OnlyYou />}
        </div>
        {pub ? (
          <p className="mt-2 flex h-[26px] items-center text-foreground/60">
            <SealDots n={6} label="Balance hidden" />
          </p>
        ) : (
          <p className="tnum mt-2 text-[26px] font-light leading-none tracking-[-0.02em]">{fmt(amt)}</p>
        )}
      </div>
      <p className="mb-3 mt-3 px-1 text-[12px] leading-relaxed text-mute">
        {pub
          ? "The deposit is public. Where it goes next is not."
          : "Pick an amount, then flip the view to see what the public gets."}
      </p>
      <AppLink href="/app/vault?tab=shield" className="btn btn-ink btn-sm btn-block mt-auto">
        Add privately
      </AppLink>
    </Card>
  );
}

const RECIPIENTS = [
  { name: "Ada", to: "gloamr1.7fQk…x9Wd" },
  { name: "Tunde", to: "gloamr1.3mBv…q2Lc" },
  { name: "Claim link", to: "A link anyone can claim" },
] as const;
const SEND_AMOUNTS: readonly number[] = [50, 250, 1200];

function SendCard({ view }: { view: View }) {
  const pub = view === "public";
  const [who, setWho] = useState<string>(RECIPIENTS[0].name);
  const [amt, setAmt] = useState<number>(250);
  const to = RECIPIENTS.find((r) => r.name === who)!;
  return (
    <Card>
      <div className="rounded-[12px] bg-surface p-3.5">
        <div className="flex items-center justify-between text-[12px] text-mute">
          <span>Send to</span>
          {pub && <Hidden />}
        </div>
        {pub ? (
          <p className="mt-1.5 flex h-[22px] items-center text-foreground/60">
            <SealDots n={8} label="Recipient hidden" />
          </p>
        ) : (
          <p className="mt-1.5 truncate text-[15px] text-foreground">{to.to}</p>
        )}
        <div className="mt-3">
          <Chips label="Recipient" options={RECIPIENTS.map((r): string => r.name)} value={who} onChange={setWho} />
        </div>
      </div>
      <div className="mt-2 rounded-[12px] bg-surface p-3.5">
        <div className="flex items-center justify-between text-[12px] text-mute">
          <span>Amount</span>
          {pub ? (
            <Hidden />
          ) : (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-panel px-2 py-0.5 text-foreground">
              <Token src="/brand/logos/pathusd.svg" /> PathUSD
            </span>
          )}
        </div>
        {pub ? (
          <p className="mt-2 flex h-[26px] items-center text-foreground/60">
            <SealDots n={6} label="Amount hidden" />
          </p>
        ) : (
          <p className="tnum mt-2 text-[26px] font-light leading-none tracking-[-0.02em]">{fmt(amt)}</p>
        )}
        <div className="mt-3">
          <Chips label="Amount to send" options={SEND_AMOUNTS} value={amt} onChange={setAmt} show={fmt} />
        </div>
      </div>
      <div className="mt-2 flex items-center justify-between px-1 py-2 text-[12px]">
        <span className="text-mute">The explorer shows</span>
        <span className="text-foreground">
          Private transfer <SealDots n={4} className="ml-1 text-foreground/60" />
        </span>
      </div>
      <AppLink href="/app/vault?tab=move" className="btn btn-ink btn-sm btn-block mt-auto">
        Send privately
      </AppLink>
    </Card>
  );
}

const BALANCE = 12480;
const LEVELS: readonly number[] = [1000, 10000, 50000];

function ProveCard({ view }: { view: View }) {
  const pub = view === "public";
  const [level, setLevel] = useState<number>(10000);
  const ok = BALANCE >= level;
  return (
    <Card>
      <div className="flex flex-1 flex-col items-center justify-center rounded-[12px] bg-surface px-4 py-5 text-center">
        <span
          className={`grid h-9 w-9 place-items-center rounded-full ${ok ? "bg-sealed-soft text-sealed" : "bg-panel text-mute"}`}
        >
          {ok ? (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
              <path d="M5 12.5l4.2 4.2L19 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          ) : (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
              <path d="M7 7l10 10M17 7L7 17" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          )}
        </span>
        <p className="tnum mt-3 text-[16px] text-foreground">Holds at least ${fmt(level)}</p>
        {pub ? (
          ok ? (
            <>
              <p className="mt-1 text-[12px] text-mute">Verified. Exact balance not shared.</p>
              <p className="mt-3 text-foreground/60">
                <SealDots n={8} label="Exact balance hidden" />
              </p>
            </>
          ) : (
            <p className="mt-1 max-w-[26ch] text-[12px] text-mute">No proof. A proof cannot claim more than you hold.</p>
          )
        ) : (
          <>
            <p className="mt-1 text-[12px] text-mute">{ok ? "Your balance behind it" : "Too high to prove from"}</p>
            <p className="tnum mt-2 text-[20px] font-light leading-none tracking-[-0.02em]">{fmt(BALANCE)} USDG</p>
          </>
        )}
        <div className="mt-4">
          <Chips
            label="Prove at least"
            options={LEVELS}
            value={level}
            onChange={setLevel}
            show={(n) => `$${fmt(n)}`}
          />
        </div>
      </div>
      <AppLink href="/app/disclose" className="btn btn-ink btn-sm btn-block mt-3">
        Share proof
      </AppLink>
    </Card>
  );
}

const CARDS = [
  {
    Card: AddCard,
    label: "Private balance",
    body: "Move USDG, PathUSD, ETH or Robinhood Chain stock tokens into a balance only you can see.",
    href: "/docs/product",
  },
  {
    Card: SendCard,
    label: "Private pay",
    body: "Send to a Gloam address or a claim link. The explorer never sees how much.",
    href: "/docs/private-pay",
  },
  {
    Card: ProveCard,
    label: "Prove",
    body: "Show a lender, an auditor or a counterparty exactly what they need. Nothing more.",
    href: "/docs/sdk/disclosure",
  },
];

const VIEWS: { key: View; label: string }[] = [
  { key: "you", label: "What you see" },
  { key: "public", label: "What the public sees" },
];

/** What goes into a private balance: the mainnet pools' assets (stocks come in through a private swap). */
const MAINNET_BALANCE_BODY = "Move USDG, USDC.e, pathUSD, USDT0 or $GLOAM into a balance only you can see.";

export function LiveProduct() {
  const [view, setView] = useState<View>("you");
  return (
    <>
      <div className="relative mt-8 flex justify-center">
        <div role="group" aria-label="Switch the view" className="inline-flex rounded-full bg-panel p-1 shadow-card">
          {VIEWS.map((v) => (
            <button
              key={v.key}
              type="button"
              aria-pressed={view === v.key}
              onClick={() => setView(v.key)}
              className={`h-10 rounded-full px-4 text-[14px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sealed ${
                view === v.key ? "bg-foreground text-panel" : "text-mute hover:text-foreground"
              }`}
            >
              {v.label}
            </button>
          ))}
        </div>
      </div>
      <p className="relative mt-3 text-center text-[13px] text-mute">
        Try the controls. The buttons open the real app.
      </p>
      <div className="relative mx-auto mt-8 grid max-w-[1080px] gap-4 md:grid-cols-3">
        {CARDS.map(({ Card: Demo, label, body, href }) => (
          <div key={label} className="flex flex-col">
            <div className="gl-glass flex flex-1 flex-col p-2">
              <Demo view={view} />
            </div>
            <Link
              href={href}
              className="gl-arrowlink mt-5"
            >
              {label} <span aria-hidden>→</span>
            </Link>
            <p className="mt-2 text-[14px] leading-relaxed text-mute">
              {Demo === AddCard ? MAINNET_BALANCE_BODY : body}
            </p>
          </div>
        ))}
      </div>
    </>
  );
}
