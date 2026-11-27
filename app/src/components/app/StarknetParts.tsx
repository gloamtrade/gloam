"use client";

/**
 * The pieces every Starknet screen shares, drawn like their EVM and Solana
 * twins: the open-your-account card, the wait that names its step (SolanaSteps
 * draws it), the one action button, the big amount field, the address field,
 * and the plain note for a section Starknet doesn't have.
 */
import Link from "next/link";
import { useId, useState, useSyncExternalStore, type ReactNode } from "react";
import { gloamPasskeys, noGloamPasskeys, onGloamPasskeys } from "@/lib/gloamPasskeys";
import { keptStarknetCode, starknetCodeRootFor } from "@/lib/starknetPrivacy/gloamCodes";
import { Spinner } from "@/components/ui/Spinner";
import { displayAmount } from "@/lib/amountShort";
import { STARKNET_NETWORK, type StarknetToken } from "@/lib/starknetPrivacy/config";
import { STARKNET_PRIVACY_NOTE } from "@/lib/starknetPrivacy/vaultActions";
import { CashOutPercentChips } from "./CashOutPrivacy";
import { SolanaSteps } from "./SolanaParts";
import { TokenLogo } from "./TokenLogo";
import { WalletMenu } from "./WalletMenu";
import { GloamRootOpen, type GloamRootCodes } from "./GloamAccountParts";
import { parseStarkAmount, plainStarkAmount, shortStark, useStarknet, type StarknetTask, type StarknetTaskKind } from "./StarknetAccount";

/** "Starknet", "Starknet Sepolia" or "Starknet devnet". */
export const STARKNET_NAME = STARKNET_NETWORK === "mainnet" ? "Starknet" : STARKNET_NETWORK === "sepolia" ? "Starknet Sepolia" : "Starknet devnet";

/** An amount as shown: two places, cut down (lib/amountShort). */
export function starkAmount(v: bigint, token: Pick<StarknetToken, "decimals">): string {
  return displayAmount(v, token.decimals);
}

/** The wait, step by step. */
export function StarknetSteps({ task, className = "" }: { task: StarknetTask | null; className?: string }) {
  // SolanaSteps draws only the steps; Starknet's own kinds (restore) don't matter to it.
  return <SolanaSteps task={task ? { ...task, kind: "setup" } : null} className={className} />;
}

/**
 * The one action's button. While its wait runs it keeps its colour and shows
 * the step it is on, and ignores more taps.
 */
export function StarknetActionButton({
  kind,
  label,
  stop,
  onClick,
  className = "",
}: {
  kind: StarknetTaskKind;
  label: string;
  stop?: string | null;
  onClick: () => void;
  className?: string;
}) {
  const sn = useStarknet();
  const task = sn?.task ?? null;
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

export function StarknetError({ kind, className = "" }: { kind: StarknetTaskKind | StarknetTaskKind[]; className?: string }) {
  const sn = useStarknet();
  const kinds = Array.isArray(kind) ? kind : [kind];
  if (!sn?.error || !kinds.includes(sn.error.kind)) return null;
  return (
    <p role="alert" className={`break-words rounded-xl bg-danger-soft px-4 py-3 text-[13.5px] leading-relaxed text-danger ${className}`}>
      {sn.error.message}
    </p>
  );
}

/** What Starknet shows, said once, quietly. */
export function StarknetPrivacyNote({ className = "" }: { className?: string }) {
  return <p className={`text-[12.5px] leading-relaxed text-mute ${className}`}>{STARKNET_PRIVACY_NOTE}</p>;
}

const STARKNET_CODES: GloamRootCodes = { kept: keptStarknetCode, rootFor: starknetCodeRootFor };

/** A Gloam wallet's account seed from its root, salted for Starknet (loaded with the account code, not before). */
const starknetSeedFromRoot = (root: Uint8Array, kind: "passkey" | "code", index: number) =>
  import("@/lib/starknetPrivacy/account").then((a) => a.seedFromGloamRoot(root, kind, index));

/**
 * Until the private account is open: connect a wallet, then open it: a browser
 * wallet signs once, a Gloam wallet uses its passkey or a backup code (the
 * first time also sets it up on Starknet; Gloam pays for that). A device that
 * opened it before reopens it with no prompt. The same card on every Starknet screen.
 */
export function StarknetGate({ lead }: { lead?: ReactNode }) {
  const sn = useStarknet();
  const passkeys = useSyncExternalStore(onGloamPasskeys, gloamPasskeys, noGloamPasskeys);
  if (!sn) return null;
  const { relay, wallet } = sn;
  const paused = relay && !relay.funded;
  const pausedNote = paused ? (
    <p className="mt-4 rounded-[16px] bg-warn-soft px-4 py-3 text-[13px] leading-relaxed text-warn">
      Private payments on {STARKNET_NAME} are paused for a moment. Try again later.
    </p>
  ) : null;

  let body: ReactNode;
  if (!relay) {
    body = (
      <div aria-busy="true" aria-label="Loading" className="space-y-4">
        <span className="gl-skeleton block h-6 w-56" />
        <span className="gl-skeleton block h-4 w-80 max-w-full" />
        <span className="gl-skeleton block h-[52px]" />
      </div>
    );
  } else if (!relay.on) {
    body = (
      <>
        <h2 className="t-title text-foreground">Not open yet</h2>
        <p className="mt-2 text-[14px] leading-relaxed text-mute">Private accounts on {STARKNET_NAME} open here soon.</p>
      </>
    );
  } else if (!wallet) {
    body = (
      <>
        <h2 className="t-title text-foreground">Connect a wallet</h2>
        <p className="mt-1.5 max-w-[56ch] text-[14px] leading-relaxed text-mute">
          Your wallet opens your private account on {STARKNET_NAME}. You don&apos;t need a Starknet wallet or any STRK.
        </p>
        <div className="mt-5">
          <WalletMenu />
        </div>
      </>
    );
  } else if (sn.restoring) {
    body = (
      <p role="status" aria-live="polite" className="flex items-center gap-2.5 text-[14px] text-foreground">
        <Spinner />
        Opening your private account
      </p>
    );
  } else if (wallet.gloam) {
    body = (
      <>
        <h2 className="t-title text-foreground">Open your private account</h2>
        <GloamRootOpen
          owner={wallet.address}
          passkeys={passkeys}
          task={sn.task}
          returning={false}
          codes={STARKNET_CODES}
          seedFromRoot={starknetSeedFromRoot}
          open={(opener) => void sn.setUp(opener)}
          action={(label, onClick, stop) => (
            <>
              {pausedNote}
              <StarknetActionButton kind="setup" label={label} stop={paused ? "Paused for a moment" : (stop ?? null)} onClick={onClick} className="mt-5" />
            </>
          )}
        />
        <StarknetSteps task={sn.task?.kind === "setup" ? sn.task : null} className="mt-4" />
        <StarknetError kind={["setup", "restore"]} className="mt-4" />
      </>
    );
  } else {
    body = (
      <>
        <h2 className="t-title text-foreground">Open your private account</h2>
        <p className="mt-1.5 max-w-[56ch] text-[14px] leading-relaxed text-mute">
          Your wallet signs one message, twice the first time. It opens the same private account on any device, so there is nothing to back up.
        </p>
        <div className="mt-5 flex items-center gap-3 rounded-[16px] border border-line py-2.5 pl-3 pr-3">
          <TokenLogo id="starknet" symbol="Starknet" size={32} network />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[14px] text-foreground">{STARKNET_NAME}</span>
            <span className="tnum block truncate text-[12.5px] text-mute">Opened by {shortStark(wallet.address)}</span>
          </span>
        </div>
        {pausedNote}
        <StarknetActionButton kind="setup" label="Sign to open" stop={paused ? "Paused for a moment" : null} onClick={() => void sn.setUp()} className="mt-5" />
        <StarknetSteps task={sn.task?.kind === "setup" ? sn.task : null} className="mt-4" />
        <StarknetError kind={["setup", "restore"]} className="mt-4" />
      </>
    );
  }

  return (
    <div className="min-w-0 space-y-6">
      {lead}
      <section className="gl-card p-5 sm:p-7">
        {body}
        <div className="mt-6 border-t border-line pt-5">
          <StarknetPrivacyNote />
        </div>
      </section>
    </div>
  );
}

/**
 * The big amount field, as Add privately draws it on EVM: what it is, the
 * balance it spends from, the amount, the token, and quick shares.
 */
export function StarknetAmountCard({
  id,
  label,
  balanceLabel,
  balance,
  token,
  amount,
  onAmount,
  problem,
  disabled,
}: {
  id: string;
  label: string;
  balanceLabel: string;
  balance: bigint | null;
  token: StarknetToken;
  amount: string;
  onAmount: (v: string) => void;
  problem: string | null;
  disabled?: boolean;
}) {
  const typed = parseStarkAmount(amount, token.decimals);
  return (
    <div className="gl-inputcard p-5 sm:p-6" data-invalid={Boolean(problem) || undefined}>
      <div className="flex items-center justify-between gap-3 text-[13px]">
        <label htmlFor={id} className="text-mute">
          {label}
        </label>
        <span className="tnum min-w-0 truncate text-mute">
          {balanceLabel} {balance === null ? "..." : starkAmount(balance, token)} {token.symbol}
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
        <span className="flex h-11 shrink-0 items-center gap-2 rounded-full bg-surface pl-1.5 pr-4 text-[15px] text-foreground">
          <TokenLogo id="usdc" symbol={token.symbol} size={30} />
          {token.symbol}
        </span>
      </div>
      <p className={`tnum mt-1 min-h-5 text-[13px] ${problem ? "text-danger" : "text-mute"}`} role={problem ? "alert" : undefined}>
        {problem ?? " "}
      </p>
      {balance !== null && balance > 0n && (
        <CashOutPercentChips
          balance={balance}
          decimals={token.decimals}
          current={typed}
          maxActive={typed !== null && typed === balance}
          onPick={onAmount}
          onMax={() => onAmount(plainStarkAmount(balance, token.decimals))}
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

/** What's wrong with a typed amount against what it spends from (and the relay's fee), said once. */
export function starkAmountProblem(text: string, token: StarknetToken, balance: bigint | null, fee = 0n): string | null {
  if (!text.trim()) return null;
  const t = text.trim();
  if (!/^\d+(\.\d+)?$/.test(t) || (t.split(".")[1]?.length ?? 0) > token.decimals) return "Enter a valid amount";
  const v = parseStarkAmount(t, token.decimals);
  if (v === null) return "Enter a valid amount";
  if (balance !== null && v + fee > balance) {
    return fee > 0n ? `More than you have with Gloam's fee: ${starkAmount(balance, token)} ${token.symbol}` : `More than you have: ${starkAmount(balance, token)} ${token.symbol}`;
  }
  return null;
}

/** A Starknet address field (0x and up to 64 hex digits). */
export function StarknetAddressField({ label, value, onChange, placeholder, disabled }: { label: string; value: string; onChange: (v: string) => void; placeholder: string; disabled?: boolean }) {
  const id = useId();
  const bad = value.trim() !== "" && !isStarkAddress(value);
  return (
    <div className="gl-inputcard p-5 sm:p-6" data-invalid={bad || undefined}>
      <label htmlFor={id} className="text-[13px] text-mute">
        {label}
      </label>
      <input
        id={id}
        value={value}
        disabled={disabled}
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => onChange(e.target.value.trim())}
        placeholder={placeholder}
        className="tnum mt-2 w-full min-w-0 bg-transparent text-[16px] text-foreground outline-none! placeholder:text-faint"
      />
      <p className={`mt-1 min-h-5 text-[13px] ${bad ? "text-danger" : "text-mute"}`} role={bad ? "alert" : undefined}>
        {bad ? "That isn't a Starknet address" : " "}
      </p>
    </div>
  );
}

export function isStarkAddress(v: string): boolean {
  const t = v.trim();
  if (!/^0x[0-9a-fA-F]{1,64}$/.test(t)) return false;
  try {
    const n = BigInt(t);
    return n > 0n && n < 1n << 251n;
  } catch {
    return false;
  }
}

/** An address with its copy button. */
export function StarknetAddressCopy({ address, label }: { address: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="rounded-[16px] border border-line px-4 py-3.5">
      <p className="text-[13px] text-mute">{label}</p>
      <div className="mt-1.5 flex items-center gap-3">
        <span className="tnum min-w-0 flex-1 break-all text-[14px] leading-relaxed text-foreground">{address}</span>
        <button
          type="button"
          className="btn btn-quiet btn-sm h-10 shrink-0"
          onClick={() => {
            void navigator.clipboard
              ?.writeText(address)
              .then(() => {
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1600);
              })
              .catch(() => {});
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}

/** A part of the app Starknet doesn't have yet, said plainly, with the way back. */
export function StarknetNotHere({ what, back = { href: "/app/vault", label: "Open the Vault" } }: { what: string; back?: { href: string; label: string } }) {
  return (
    <div className="gl-card max-w-[620px] p-6 sm:p-8">
      <p className="t-title text-foreground">{what} is not on Starknet yet</p>
      <p className="mt-2 max-w-[52ch] text-[14px] leading-relaxed text-mute">
        On Starknet, Gloam adds, pays privately and cashes out. Pick another network from the menu for the rest.
      </p>
      <Link href={back.href} className="btn btn-ghost mt-5">
        {back.label}
      </Link>
    </div>
  );
}

/** The empty private balance, as Pay and Cash out say it elsewhere. */
export function StarknetEmptyBalance({ onReceive }: { onReceive?: () => void }) {
  return (
    <div className="mt-6 rounded-[16px] bg-surface px-5 py-9 text-center">
      <p className="text-[15px] text-foreground">Nothing in your private balance yet</p>
      <p className="mx-auto mt-1.5 max-w-[40ch] text-[13.5px] leading-relaxed text-mute">Add money first, or share your private account to get paid.</p>
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
