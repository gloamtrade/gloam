"use client";

import Link from "next/link";
import { useEffect, useId, useState, useSyncExternalStore, type ReactNode } from "react";
import { SealDots } from "@/components/ui/SealDots";
import { SealedField } from "@/components/ui/SealedField";
import { TokenLogo } from "../TokenLogo";
import { WalletMenu } from "../WalletMenu";
import {
  EXPIRY_OPTIONS,
  VERIFIER_MAX,
  verifyLinkFor,
  type ExpiryId,
  type FriendlyError,
} from "./proofUtils";

/* ---------- icons ---------- */

export function ShieldCheck({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M12 3.5l7 3v5.25c0 4.1-2.9 7.6-7 8.75-4.1-1.15-7-4.65-7-8.75V6.5l7-3z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path d="M9 12.25l2.1 2.1L15.25 10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Spinner() {
  return (
    <span
      aria-hidden
      className="inline-block h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-[1.5px] border-current border-t-transparent opacity-70 motion-reduce:animate-none"
    />
  );
}

export function CheckMark({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M5 12.5l4.2 4.2L19 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function LockIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="5" y="10.5" width="14" height="10" rx="2.5" stroke="currentColor" strokeWidth="1.8" />
      <path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  );
}

function AlertIcon() {
  return (
    <svg className="mt-0.5 h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeWidth="1.6" />
      <path d="M12 7.75v5M12 16.25v.01" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

/* ---------- layout ---------- */

/** The form or list on the left, what it shows on the right (stacked on mobile). */
export function ProveLayout({ children, aside }: { children: ReactNode; aside: ReactNode }) {
  return (
    <div className="grid max-lg:gap-5 lg:grid-cols-[minmax(0,1fr)_340px] lg:gap-6">
      <div className="min-w-0 space-y-5">{children}</div>
      <aside className="space-y-4 lg:sticky lg:top-6 lg:self-start">{aside}</aside>
    </div>
  );
}

/* ---------- assets ---------- */

/** ETH's real mark, the same one Portfolio and every token list show. */
function NativeMark({ size }: { size: number }) {
  return <TokenLogo id="eth" symbol="ETH" size={size} />;
}

export function AssetMark({ id, symbol, size = 28 }: { id: string | null; symbol: string; size?: number }) {
  if (!id) return <NativeMark size={size} />;
  return <TokenLogo id={id} symbol={symbol} size={size} />;
}

/* ---------- messages ---------- */

export function Notice({ tone, children }: { tone: FriendlyError["tone"]; children: ReactNode }) {
  return (
    <p
      role={tone === "danger" ? "alert" : "status"}
      className={`flex items-start gap-2.5 rounded-[14px] px-4 py-3 text-[13.5px] leading-relaxed ${
        tone === "danger" ? "bg-danger-soft text-danger" : "bg-warn-soft text-warn"
      }`}
    >
      <AlertIcon />
      <span className="min-w-0 break-words">{children}</span>
    </p>
  );
}

/** The quiet card used for "connect first" and "nothing here yet". */
export function EmptyCard({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?: ReactNode;
}) {
  return (
    <section className="gl-card relative overflow-hidden">
      <SealedField tone="soft" />
      <div className="relative z-[1] flex flex-col items-start max-sm:p-6 sm:p-8">
        <ShieldCheck className="h-6 w-6 text-foreground" />
        <h2 className="mt-5 text-[22px] font-light tracking-[-0.012em] text-foreground">{title}</h2>
        <p className="mt-2 max-w-[48ch] text-[14px] leading-relaxed text-mute">{body}</p>
        {action && <div className="mt-6">{action}</div>}
      </div>
    </section>
  );
}

export function ConnectCard({ what }: { what: string }) {
  return (
    <EmptyCard
      title={`Connect to prove ${what}`}
      body="Your private balances live in this browser. Connect the wallet you used, and pick what to prove."
      action={<WalletMenu />}
    />
  );
}

export function NoBalanceCard() {
  return (
    <EmptyCard
      title="No private balance yet"
      body="Add money to your vault first. Then come back and prove it to anyone, without showing them anything else."
      action={
        <Link href="/app/vault?tab=shield" className="btn btn-ink">
          Add privately
        </Link>
      }
    />
  );
}

/* ---------- form fields ---------- */

const VERIFIER_EXAMPLES = ["Acme Bank", "My landlord", "Kraken onboarding"];

export function VerifierField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="text-[13px] text-mute">
        Who is this for?
      </label>
      <input
        id={id}
        value={value}
        maxLength={VERIFIER_MAX}
        autoComplete="off"
        onChange={(e) => onChange(e.target.value)}
        placeholder="A name they will recognize"
        aria-describedby={`${id}-hint`}
        className="gl-input mt-2"
      />
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <span className="text-[12.5px] text-mute">For example</span>
        {VERIFIER_EXAMPLES.map((ex) => (
          <button
            key={ex}
            type="button"
            onClick={() => onChange(ex)}
            className="inline-flex h-8 items-center rounded-full bg-surface px-3 text-[12.5px] text-soft transition-colors hover:bg-surface-2 hover:text-foreground"
          >
            {ex}
          </button>
        ))}
      </div>
      <p id={`${id}-hint`} className="mt-2 text-[12.5px] leading-relaxed text-mute">
        Their name goes into the proof. If they pass it on, it still shows who it was made for.
      </p>
    </div>
  );
}

export function ExpiryPicker({ value, onChange }: { value: ExpiryId; onChange: (v: ExpiryId) => void }) {
  const id = useId();
  return (
    <div>
      <p id={id} className="text-[13px] text-mute">
        Good for
      </p>
      <div role="radiogroup" aria-labelledby={id} className="mt-2 flex rounded-full bg-surface p-1">
        {EXPIRY_OPTIONS.map((o) => {
          const active = o.id === value;
          return (
            <button
              key={o.id}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => onChange(o.id)}
              className={`h-10 flex-1 whitespace-nowrap rounded-full px-3 text-[14px] transition-colors duration-200 ${
                active
                  ? "bg-panel font-medium text-foreground shadow-card dark:bg-surface-2"
                  : "text-mute hover:text-foreground"
              }`}
            >
              {o.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ---------- progress ---------- */

const PHASES = {
  // The first proof of funds also fetches a 13 MB proving key.
  funds: {
    steps: ["Getting the proving key ready", "Building your proof"],
    advanceMs: 2500,
    note: "Up to about ten seconds, longer the first time. It runs on this device, and your key never leaves this browser.",
  },
  payment: {
    steps: ["Getting your payment ready", "Building your proof"],
    advanceMs: 600,
    note: "A second or two. It runs on this device, and your key never leaves this browser.",
  },
  balance: {
    steps: ["Getting your balance ready", "Building your proof"],
    advanceMs: 600,
    note: "A second or two. It runs on this device, and your key never leaves this browser.",
  },
} as const;

/**
 * Steps shown while proving. The prover is one call, so the first step moves
 * on after a beat and the last one holds until the proof is back.
 */
export function ProofProgress({ kind }: { kind: keyof typeof PHASES }) {
  const { steps, advanceMs, note } = PHASES[kind];
  const [step, setStep] = useState(0);
  useEffect(() => {
    const t1 = window.setTimeout(() => setStep(1), advanceMs);
    return () => window.clearTimeout(t1);
  }, [advanceMs]);
  return (
    <div className="rounded-[16px] bg-surface p-4" role="status" aria-live="polite">
      <ul className="space-y-2.5">
        {steps.map((label, i) => {
          const done = i < step;
          const now = i === step;
          return (
            <li key={label} className="flex items-center gap-3 text-[14px]">
              <span
                className={`grid h-5 w-5 shrink-0 place-items-center rounded-full ${
                  done ? "bg-sealed-soft text-sealed" : now ? "text-foreground" : "text-faint"
                }`}
              >
                {done ? (
                  <CheckMark size={11} />
                ) : now ? (
                  <Spinner />
                ) : (
                  <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-current" />
                )}
              </span>
              <span className={done ? "text-mute" : now ? "text-foreground" : "text-faint"}>
                {label}
                {now ? "…" : ""}
              </span>
            </li>
          );
        })}
      </ul>
      <p className="mt-3 border-t border-line pt-3 text-[12.5px] leading-relaxed text-mute">{note}</p>
    </div>
  );
}

/* ---------- what the proof shows ---------- */

export type ShowsRow = { label: string; value: ReactNode };

export function ShowsPanel({
  shows,
  never,
  note,
}: {
  shows: ShowsRow[];
  never: string[];
  note?: ReactNode;
}) {
  return (
    <section className="gl-card max-sm:p-5 sm:p-6">
      <div className="flex items-center justify-between gap-3">
        <p className="text-[13px] text-mute">What the proof shows</p>
        <span className="inline-flex items-center gap-1.5 rounded-full bg-sealed-soft px-2.5 py-0.5 text-[12px] font-medium text-sealed">
          <ShieldCheck className="h-3 w-3" />
          Only to them
        </span>
      </div>
      <dl className="mt-3 divide-y divide-line text-[14px]">
        {shows.map((r) => (
          <div key={r.label} className="flex min-h-11 items-center justify-between gap-3 py-2">
            <dt className="shrink-0 text-mute">{r.label}</dt>
            <dd className="tnum min-w-0 truncate text-right text-foreground">{r.value}</dd>
          </div>
        ))}
      </dl>

      <p className="mt-5 text-[13px] text-mute">Never shows</p>
      <ul className="mt-2 divide-y divide-line rounded-[14px] bg-surface px-4 text-[13.5px]">
        {never.map((n) => (
          <li key={n} className="flex min-h-11 items-center justify-between gap-3 py-2">
            <span className="text-soft">{n}</span>
            <SealDots n={5} className="shrink-0 text-foreground/45" label="Hidden" />
          </li>
        ))}
      </ul>

      {note && <div className="mt-4 text-[12.5px] leading-relaxed text-mute">{note}</div>}
    </section>
  );
}

export function SafeToShare() {
  return (
    <section className="rounded-[18px] border border-line max-sm:p-5 sm:p-6">
      <p className="text-[14px] text-foreground">Safe to share</p>
      <p className="mt-1.5 text-[13px] leading-relaxed text-mute">
        A proof is not your key. It can never be used to spend your money. Whoever gets it can
        check it in their browser at{" "}
        <Link
          href="/verify"
          className="text-foreground underline decoration-line-strong underline-offset-2 hover:decoration-foreground"
        >
          gloam.trade/verify
        </Link>
        .
      </p>
    </section>
  );
}

/* ---------- the share card ---------- */

const noSubscribe = () => () => {};
const readOrigin = () => window.location.origin;
const noOrigin = () => "";

export function ProofShareCard({
  token,
  headline,
  rows,
  onEdit,
}: {
  token: string;
  headline: ReactNode;
  rows: ShowsRow[];
  onEdit: () => void;
}) {
  const id = useId();
  const [copied, setCopied] = useState<"proof" | "link" | null>(null);
  const origin = useSyncExternalStore(noSubscribe, readOrigin, noOrigin);
  const link = origin ? verifyLinkFor(token, origin) : null;
  const verifyHref = link ? link.slice(origin.length) : "/verify";

  async function copy(what: "proof" | "link", value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(what);
      window.setTimeout(() => setCopied((c) => (c === what ? null : c)), 1500);
    } catch {
      /* clipboard unavailable */
    }
  }

  return (
    <section className="gl-card overflow-hidden" aria-labelledby={`${id}-title`}>
      <div className="relative overflow-hidden border-b border-line max-sm:p-5 sm:p-7">
        <SealedField tone="soft" />
        <div className="relative">
          <span className="inline-flex h-6 items-center gap-1.5 rounded-full bg-sealed-soft px-2.5 text-[12px] font-medium text-sealed">
            <ShieldCheck className="h-3.5 w-3.5" />
            Proof ready
          </span>
          <p id={`${id}-title`} className="tnum mt-4 text-[26px] font-light leading-tight tracking-[-0.018em] text-foreground sm:text-[30px]">
            {headline}
          </p>
          <dl className="mt-4 grid grid-cols-1 gap-x-8 gap-y-2 text-[13.5px] sm:grid-cols-2">
            {rows.map((r) => (
              <div key={r.label} className="flex min-w-0 items-baseline gap-2">
                <dt className="shrink-0 text-mute">{r.label}</dt>
                <dd className="min-w-0 truncate text-foreground">{r.value}</dd>
              </div>
            ))}
          </dl>
        </div>
      </div>

      <div className="bg-surface/50 max-sm:p-5 sm:p-7">
        <label htmlFor={`${id}-token`} className="text-[13px] text-mute">
          Your proof. Send it to them however you like.
        </label>
        <textarea
          id={`${id}-token`}
          readOnly
          value={token}
          rows={3}
          onFocus={(e) => e.currentTarget.select()}
          className="gl-input tnum mt-2 h-auto resize-none break-all py-3 text-[12px] leading-relaxed text-soft"
        />
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button type="button" onClick={() => void copy("proof", token)} className="btn btn-ink btn-sm h-10">
            {copied === "proof" ? <CheckMark /> : null}
            <span aria-live="polite">{copied === "proof" ? "Copied" : "Copy proof"}</span>
          </button>
          {link && (
            <button type="button" onClick={() => void copy("link", link)} className="btn btn-quiet btn-sm h-10">
              {copied === "link" ? <CheckMark /> : null}
              <span aria-live="polite">{copied === "link" ? "Link copied" : "Copy link"}</span>
            </button>
          )}
          <Link href={verifyHref} className="btn btn-quiet btn-sm h-10">
            Open the verifier
          </Link>
          <button type="button" onClick={onEdit} className="btn btn-quiet btn-sm h-10 text-mute sm:ml-auto">
            Make another
          </button>
        </div>
        <p className="mt-3 text-[12.5px] leading-relaxed text-mute">
          {link
            ? "The link opens the verifier with this proof filled in. It stays in the link, nothing is sent to Gloam."
            : "This proof is too long for a link. Copy it, and they can paste it at gloam.trade/verify."}
        </p>
      </div>
    </section>
  );
}
