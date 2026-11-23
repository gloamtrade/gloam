"use client";

/**
 * The pieces every Solana screen shares, drawn like their EVM twins: the wait
 * that names its step, the connect and set-up card (with what Solana takes and
 * what stays private beside it), the asset dropdown with real token marks,
 * the big amount field, and the plain note for a section Solana doesn't have.
 */
import Link from "next/link";
import type { ReactNode } from "react";
import { RINGS_PRIVACY_NOTE, SOLANA_RINGS_NETWORK, ringsAssets, type RingsAsset } from "@/lib/solanaRings/config";
import { useEthPrice } from "@/hooks/useLiveMarkets";
import { Select } from "@/components/ui/Select";
import { Spinner } from "@/components/ui/Spinner";
import { CashOutPercentChips } from "./CashOutPrivacy";
import { TokenLogo } from "./TokenLogo";
import { shortSol, formatSolAmount, plainSolAmount, useSolana, type SolanaTask, type SolanaTaskKind } from "./SolanaAccount";

/** "Solana mainnet" or "Solana devnet". */
export const SOLANA_NET_LABEL = SOLANA_RINGS_NETWORK === "devnet" ? "devnet" : "mainnet";

/** USD for an amount of a Solana asset: USDC and USDT at a dollar, SOL at its price; null when unknown. */
export function useSolanaUsd(): (assetId: string, amount: bigint) => number | null {
  const { solUsd } = useEthPrice();
  return (assetId, amount) => {
    const a = ringsAssets().find((x) => x.id === assetId);
    if (!a) return null;
    const units = Number(amount) / 10 ** a.decimals;
    if (a.id === "usdc" || a.id === "usdt") return units;
    if (a.id === "sol") return solUsd != null ? units * solUsd : null;
    return null;
  };
}

/** The asset a payment starts on: a stablecoin with a balance first, then SOL, then the first listed. */
export function preferredAsset(balances: Record<string, bigint> | null): RingsAsset {
  const assets = ringsAssets();
  const held = (id: string) => (balances?.[id] ?? 0n) > 0n;
  return assets.find((a) => a.id !== "sol" && held(a.id)) ?? assets.find((a) => held(a.id)) ?? assets[0]!;
}

/** "$1,234.56". */
export function usd(v: number): string {
  return v.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function CheckGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="m5.5 12.5 4 4 9-9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function LockGlyph({ className = "" }: { className?: string }) {
  return (
    <svg className={className} width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="5" y="10.5" width="14" height="10" rx="2.5" stroke="currentColor" strokeWidth="1.8" />
      <path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  );
}

/**
 * A wait, step by step: the steps done get a check, the one under way a
 * spinner, the ones to come a quiet dot. One step shows as one line.
 */
export function SolanaSteps({ task, className = "" }: { task: SolanaTask | null; className?: string }) {
  if (!task) return null;
  const many = task.steps.length > 1;
  return (
    <div role="status" aria-live="polite" className={`rounded-[16px] bg-surface px-4 py-3.5 ${className}`}>
      {many ? (
        <ol className="space-y-2.5">
          {task.steps.map((s, i) => (
            <li
              key={i}
              aria-current={i === task.at ? "step" : undefined}
              className={`flex items-center gap-2.5 text-[13.5px] leading-snug ${
                i < task.at ? "text-mute" : i === task.at ? "text-foreground" : "text-faint"
              }`}
            >
              <span className="grid h-4 w-4 shrink-0 place-items-center">
                {i < task.at ? <CheckGlyph /> : i === task.at ? <Spinner /> : <span className="h-1.5 w-1.5 rounded-full bg-current" />}
              </span>
              {s}
            </li>
          ))}
        </ol>
      ) : (
        <p className="flex items-center gap-2.5 text-[13.5px] leading-snug text-foreground">
          <span className="grid h-4 w-4 shrink-0 place-items-center">
            <Spinner />
          </span>
          {task.steps[0]}
        </p>
      )}
      <p className="mt-2.5 pl-[26px] text-[12px] text-mute">Keep this tab open.</p>
    </div>
  );
}

/**
 * The one action's button. While its wait runs it keeps its colour and shows
 * the step it is on with a spinner, and ignores more taps.
 */
export function SolanaActionButton({
  kind,
  label,
  stop,
  onClick,
  className = "",
}: {
  kind: SolanaTaskKind;
  label: string;
  /** Why it can't go yet, said on the button. */
  stop?: string | null;
  onClick: () => void;
  className?: string;
}) {
  const sol = useSolana();
  const task = sol?.task ?? null;
  const mine = task?.kind === kind;
  const other = Boolean(task) && !mine;
  return (
    <button
      type="button"
      aria-busy={mine || undefined}
      disabled={!mine && (Boolean(stop) || other)}
      onClick={() => {
        if (!task && !stop) onClick();
      }}
      className={`btn btn-ink btn-lg btn-block ${className}`}
    >
      {mine ? (
        <>
          <Spinner />
          <span className="truncate">{task!.steps[task!.at]}</span>
        </>
      ) : (
        (stop ?? label)
      )}
    </button>
  );
}

export function SolanaError({ kind, className = "" }: { kind: SolanaTaskKind | SolanaTaskKind[]; className?: string }) {
  const sol = useSolana();
  const kinds = Array.isArray(kind) ? kind : [kind];
  if (!sol?.error || !kinds.includes(sol.error.kind)) return null;
  return (
    <p role="alert" className={`break-words rounded-xl bg-danger-soft px-4 py-3 text-[13.5px] leading-relaxed text-danger ${className}`}>
      {sol.error.message}
    </p>
  );
}

/** The asset dropdown: each with its real mark and name. */
export function SolanaAssetSelect({
  value,
  onChange,
  label,
  disabled,
}: {
  value: string;
  onChange: (id: string) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <Select
      variant="pill"
      align="end"
      className="shrink-0"
      label={label}
      value={value}
      disabled={disabled}
      onChange={onChange}
      options={ringsAssets().map((a) => ({
        value: a.id,
        label: a.symbol,
        description: a.name,
        icon: <TokenLogo id={a.id} symbol={a.symbol} size={30} />,
      }))}
    />
  );
}

/**
 * The big amount field, as Add privately draws it on EVM: what it is, the
 * balance it spends from on the right, the amount, the asset, its dollar
 * value, and quick shares of the balance.
 */
export function SolanaAmountCard({
  id,
  label,
  balanceLabel,
  balance,
  spendable,
  asset,
  onAsset,
  amount,
  onAmount,
  problem,
  disabled,
}: {
  id: string;
  label: string;
  /** "In wallet" or "Private balance". */
  balanceLabel: string;
  balance: bigint | null;
  /** What the quick shares and Max spend, when less than `balance` (SOL keeps its network fee back). */
  spendable?: bigint | null;
  asset: RingsAsset;
  onAsset: (id: string) => void;
  amount: string;
  onAmount: (v: string) => void;
  problem: string | null;
  disabled?: boolean;
}) {
  const toUsd = useSolanaUsd();
  const typed = parseLoose(amount, asset.decimals);
  const value = typed !== null && typed > 0n ? toUsd(asset.id, typed) : null;
  const spend = spendable === undefined ? balance : spendable;
  return (
    <div className="gl-inputcard p-5 sm:p-6" data-invalid={Boolean(problem) || undefined}>
      <div className="flex items-center justify-between gap-3 text-[13px]">
        <label htmlFor={id} className="text-mute">
          {label}
        </label>
        <span className="tnum min-w-0 truncate text-mute">
          {balanceLabel} {balance === null ? "..." : formatSolAmount(balance, asset.decimals)} {asset.symbol}
        </span>
      </div>
      <div className="mt-2 flex items-center gap-3">
        <input
          id={id}
          inputMode="decimal"
          autoComplete="off"
          placeholder="0"
          value={amount}
          disabled={disabled}
          onChange={(e) => onAmount(e.target.value)}
          className="tnum min-w-0 flex-1 bg-transparent text-[40px] font-light leading-[1.15] tracking-[-0.02em] text-foreground outline-none! placeholder:text-faint sm:text-[46px]"
        />
        <SolanaAssetSelect value={asset.id} onChange={onAsset} label={`Asset, ${label.toLowerCase()}`} disabled={disabled} />
      </div>
      <p className={`tnum mt-1 min-h-5 text-[13px] ${problem ? "text-danger" : "text-mute"}`} role={problem ? "alert" : undefined}>
        {problem ?? (value != null ? `≈ ${usd(value)}` : " ")}
      </p>
      {spend !== null && spend > 0n && (
        <CashOutPercentChips
          balance={spend}
          decimals={asset.decimals}
          current={typed}
          maxActive={typed !== null && typed === spend}
          onPick={onAmount}
          onMax={() => onAmount(plainSolAmount(spend, asset.decimals))}
          onCustom={() => {
            const el = document.getElementById(id) as HTMLInputElement | null;
            el?.focus();
            requestAnimationFrame(() => el?.select());
          }}
          disabled={disabled}
        />
      )}
    </div>
  );
}

/** The typed amount in base units (zero allowed), or null when it isn't a number. */
function parseLoose(text: string, decimals: number): bigint | null {
  const t = text.trim();
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  const [whole, frac = ""] = t.split(".");
  if (frac.length > decimals) return null;
  return BigInt(whole!) * 10n ** BigInt(decimals) + BigInt((frac + "0".repeat(decimals)).slice(0, decimals) || "0");
}

/** What's wrong with a typed amount against what it spends from, said once. */
export function amountProblem(text: string, asset: RingsAsset, balance: bigint | null): string | null {
  if (!text.trim()) return null;
  const v = parseLoose(text, asset.decimals);
  if (v === null) return "Enter a valid amount";
  if (balance !== null && v > balance) return `More than you have: ${formatSolAmount(balance, asset.decimals)} ${asset.symbol}`;
  return null;
}

/** The three steps of Gloam on Solana, the one you are at marked. */
function HowItWorks({ at }: { at: number }) {
  const steps = ["Connect a Solana wallet", "Add privately", "Pay or cash out"];
  return (
    <ol className="grid gap-2 sm:grid-cols-3" aria-label="How it works">
      {steps.map((s, i) => (
        <li key={s} className={`flex items-center gap-2.5 text-[13.5px] ${i === at ? "text-foreground" : "text-mute"}`}>
          <span
            className={`tnum grid h-6 w-6 shrink-0 place-items-center rounded-full border text-[12px] ${
              i === at ? "border-foreground text-foreground" : i < at ? "border-line text-mute" : "border-line text-faint"
            }`}
            aria-hidden
          >
            {i < at ? <CheckGlyph /> : i + 1}
          </span>
          {s}
        </li>
      ))}
    </ol>
  );
}

/** What Solana takes, with each mark, and the plain note of what stays private. */
export function SolanaAssetsCard({ className = "" }: { className?: string }) {
  const sol = useSolana();
  return (
    <aside className={`gl-card p-5 sm:p-6 ${className}`} aria-labelledby="sol-assets-title">
      <h2 id="sol-assets-title" className="text-[15px] text-foreground">
        On Solana
      </h2>
      <ul className="mt-4 space-y-3">
        {ringsAssets().map((a) => (
          <li key={a.id} className="flex items-center gap-3">
            <TokenLogo id={a.id} symbol={a.symbol} size={32} />
            <span className="min-w-0 flex-1">
              <span className="block text-[14px] font-medium leading-tight text-foreground">{a.symbol}</span>
              <span className="mt-0.5 block text-[12.5px] leading-tight text-mute">{a.name}</span>
            </span>
            {sol?.ready[a.id] === false && <span className="shrink-0 text-[12px] text-mute">Not set up yet</span>}
          </li>
        ))}
      </ul>
      <p className="mt-5 border-t border-line pt-4 text-[12.5px] leading-relaxed text-mute">{RINGS_PRIVACY_NOTE}</p>
    </aside>
  );
}

/** The detected wallets, two to a row from a tablet up, each with its own icon. */
function WalletGrid() {
  const sol = useSolana()!;
  const connecting = sol.task?.kind === "connect";
  if (sol.wallets.length === 0) {
    return (
      <p className="mt-5 rounded-[16px] bg-surface px-4 py-3.5 text-[13.5px] leading-relaxed text-soft">
        No Solana wallet in this browser. Install Phantom, Solflare or Backpack, then reload this page.
      </p>
    );
  }
  return (
    <div className="mt-5 grid gap-2 sm:grid-cols-2">
      {sol.wallets.map((w) => (
        <button
          key={w.name}
          type="button"
          disabled={Boolean(sol.task)}
          onClick={() => void sol.connect(w)}
          className="flex h-[56px] items-center gap-3 rounded-2xl border border-line pl-3 pr-4 text-left text-[15px] text-foreground transition-colors hover:bg-surface disabled:cursor-not-allowed disabled:opacity-60"
        >
          <span className="grid h-8 w-8 shrink-0 place-items-center overflow-hidden rounded-[9px] bg-white ring-1 ring-line">
            {/* eslint-disable-next-line @next/next/no-img-element -- the wallet's own data-URL icon */}
            {w.icon && <img src={w.icon} alt="" width={32} height={32} className="h-8 w-8 object-cover" />}
          </span>
          <span className="min-w-0 flex-1 truncate">{w.name}</span>
          {connecting && <Spinner />}
        </button>
      ))}
    </div>
  );
}

/**
 * Until the private account is open: connect a Solana wallet, then sign once
 * to set it up. The same card on every Solana screen, with what Solana takes
 * beside it.
 */
export function SolanaGate({ lead }: { lead?: ReactNode }) {
  const sol = useSolana();
  if (!sol) return null;
  const { relay, main } = sol;

  let body: ReactNode;
  if (!relay) {
    body = (
      <div aria-busy="true" aria-label="Loading" className="space-y-4">
        <span className="gl-skeleton block h-6 w-56" />
        <span className="gl-skeleton block h-4 w-80 max-w-full" />
        <div className="grid gap-2 sm:grid-cols-2">
          <span className="gl-skeleton block h-[56px]" />
          <span className="gl-skeleton block h-[56px]" />
        </div>
      </div>
    );
  } else if (!relay.on) {
    body = (
      <>
        <h2 className="t-title text-foreground">Not open yet</h2>
        <p className="mt-2 text-[14px] leading-relaxed text-mute">Private accounts on Solana open here soon.</p>
      </>
    );
  } else if (!main) {
    body = (
      <>
        <h2 className="t-title text-foreground">Connect a Solana wallet</h2>
        <p className="mt-1.5 max-w-[56ch] text-[14px] leading-relaxed text-mute">
          Your wallet opens your private account. It never holds your private balance.
        </p>
        <WalletGrid />
        <SolanaSteps task={sol.task?.kind === "connect" ? sol.task : null} className="mt-4" />
        <SolanaError kind="connect" className="mt-4" />
      </>
    );
  } else {
    body = (
      <>
        <h2 className="t-title text-foreground">Set up your private account</h2>
        <p className="mt-1.5 max-w-[56ch] text-[14px] leading-relaxed text-mute">
          {main.wallet.name} signs one message. That signature opens the same private account on any device, so there is nothing to back up.
        </p>
        <div className="mt-5 flex items-center gap-3 rounded-[16px] border border-line py-2.5 pl-3 pr-2">
          <span className="grid h-8 w-8 shrink-0 place-items-center overflow-hidden rounded-[9px] bg-white ring-1 ring-line">
            {/* eslint-disable-next-line @next/next/no-img-element -- the wallet's own data-URL icon */}
            {main.wallet.icon && <img src={main.wallet.icon} alt="" width={32} height={32} className="h-8 w-8 object-cover" />}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[14px] text-foreground">{main.wallet.name}</span>
            <span className="tnum block truncate text-[12.5px] text-mute">{shortSol(main.account.address)}</span>
          </span>
          <button type="button" className="btn btn-quiet btn-sm h-10 text-mute" disabled={Boolean(sol.task)} onClick={sol.disconnect}>
            Disconnect
          </button>
        </div>
        {!relay.funded && (
          <p className="mt-4 rounded-[16px] bg-warn-soft px-4 py-3 text-[13px] leading-relaxed text-warn">
            Private payments on Solana are paused for a moment. Try again later.
          </p>
        )}
        <SolanaActionButton
          kind="setup"
          label="Sign and set up"
          stop={relay.funded ? null : "Paused for a moment"}
          onClick={() => void sol.setUp()}
          className="mt-5"
        />
        <SolanaSteps task={sol.task?.kind === "setup" ? sol.task : null} className="mt-4" />
        <SolanaError kind="setup" className="mt-4" />
      </>
    );
  }

  return (
    <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
      <div className="min-w-0 space-y-6">
        {lead}
        <section className="gl-card p-5 sm:p-7">
          {body}
          <div className="mt-7 border-t border-line pt-5">
            <HowItWorks at={main ? 1 : 0} />
          </div>
        </section>
      </div>
      <SolanaAssetsCard />
    </div>
  );
}

/** A part of the app Solana doesn't have yet, said plainly, with the way back. */
export function SolanaNotHere({ what, back = { href: "/app/vault", label: "Open the Vault" } }: { what: string; back?: { href: string; label: string } }) {
  return (
    <div className="gl-card max-w-[620px] p-6 sm:p-8">
      <p className="t-title text-foreground">{what} is not on Solana yet</p>
      <p className="mt-2 max-w-[52ch] text-[14px] leading-relaxed text-mute">
        On Solana, Gloam adds, pays privately, runs payroll and cashes out. Pick another network from the menu for the rest.
      </p>
      <Link href={back.href} className="btn btn-ghost mt-5">
        {back.label}
      </Link>
    </div>
  );
}

/** The empty private balance, as Pay and Cash out say it on EVM. */
export function SolanaEmptyBalance({ onReceive }: { onReceive?: () => void }) {
  return (
    <div className="mt-6 rounded-[16px] bg-surface px-5 py-9 text-center">
      <span className="mx-auto grid h-11 w-11 place-items-center rounded-full bg-panel text-mute shadow-card">
        <LockGlyph />
      </span>
      <p className="mt-4 text-[15px] text-foreground">Nothing in your private balance yet</p>
      <p className="mx-auto mt-1.5 max-w-[40ch] text-[13.5px] leading-relaxed text-mute">
        Add money first, or share your private address to get paid.
      </p>
      <div className="mt-5 flex flex-wrap justify-center gap-2">
        <Link href="/app/vault?tab=shield" className="btn btn-ink">
          Add money
        </Link>
        {onReceive ? (
          <button type="button" onClick={onReceive} className="btn btn-ghost">
            Receive
          </button>
        ) : (
          <Link href="/app/vault?tab=move&mode=receive" className="btn btn-ghost">
            Receive
          </Link>
        )}
      </div>
    </div>
  );
}
