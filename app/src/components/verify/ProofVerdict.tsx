"use client";

import { useState, type ReactNode } from "react";
import type { AnyProof, CheckState, VerifyResult } from "@/lib/proofs";
import { allNetworks, networkName } from "@/lib/networks";
import { assetDecimals, isNativeAsset } from "@/lib/shield";
import { knownTokens } from "@/lib/tokens";
import { SealedField } from "@/components/ui/SealedField";
import { displayLabel } from "@/lib/proofs/label";
import { formatUnits } from "viem";
import { ArrowUpRight } from "@/components/ui/ArrowUpRight";

/**
 * The result of checking a proof of funds, a proof of payment, an exact
 * balance or a payroll total: one verdict line in plain words, who it was made for and until when,
 * then every check the verifier ran. A proof of payment and a payroll total
 * also say what they do not prove: neither shows who was paid.
 */


function netFor(chainId: number) {
  return allNetworks().find((n) => n.chainId === chainId);
}

/** Symbol for an asset on the proof's own network (not the app's active one). */
export function symbolOf(asset: string, chainId: number): string {
  if (isNativeAsset(asset)) return netFor(chainId)?.primaryAsset.symbol ?? "ETH";
  const t = knownTokens(chainId).find((x) => x.address.toLowerCase() === asset.toLowerCase());
  return t?.symbol ?? `${asset.slice(0, 6)}…${asset.slice(-4)}`;
}

/** The asset's decimals on the proof's own chain when it is known, else on the open network. */
function decimalsOn(asset: string, chainId?: number): number {
  if (chainId === undefined || !Number.isSafeInteger(chainId) || chainId <= 0) return assetDecimals(asset);
  if (isNativeAsset(asset)) return 18;
  return knownTokens(chainId).find((t) => t.address.toLowerCase() === asset.toLowerCase())?.decimals ?? assetDecimals(asset);
}

/**
 * A raw amount in the asset's real decimals (USDG 6, ETH 18), with every unit
 * the proof states: "exactly 0.000000000000000001", never "exactly 0". It is
 * read as text, so a large amount is not rounded the way a Number would be.
 * Pass the proof's `chainId`: the decimals are then that chain's (USDT has 18
 * on BNB Chain, 6 elsewhere), not the network this browser has open.
 */
export function amountOf(raw: string, asset: string, chainId?: number): string {
  let v: bigint;
  try {
    v = BigInt(raw);
  } catch {
    return raw;
  }
  const [whole, frac] = formatUnits(v, decimalsOn(asset, chainId)).split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return frac ? `${grouped}.${frac}` : grouped;
}

function day(unix: number): string {
  return new Date(unix * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function dateTime(unix: number): string {
  return new Date(unix * 1000).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
}

/* ---------- icons ---------- */

function CheckMark({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M5 12.5l4.2 4.2L19 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CrossMark({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M7 7l10 10M17 7L7 17" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function QuestionMark({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M7 12h10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

const STATE: Record<CheckState, { icon: ReactNode; tone: string; word: string }> = {
  pass: { icon: <CheckMark size={11} />, tone: "bg-sealed-soft text-sealed", word: "Passed" },
  fail: { icon: <CrossMark size={11} />, tone: "bg-danger-soft text-danger", word: "Failed" },
  unknown: { icon: <QuestionMark size={11} />, tone: "bg-surface-2 text-mute", word: "Could not check" },
};

/* ---------- copy button ---------- */

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        } catch {
          /* clipboard unavailable */
        }
      }}
      aria-label={copied ? `${label} copied` : `Copy ${label}`}
      className="inline-flex h-10 shrink-0 items-center gap-1.5 rounded-full px-3 text-[12.5px] font-medium text-mute transition-colors hover:bg-surface hover:text-foreground"
    >
      {copied ? <CheckMark /> : null}
      <span aria-live="polite">{copied ? "Copied" : "Copy"}</span>
    </button>
  );
}

/* ---------- verdict ---------- */

type Verdict = "verified" | "expired" | "failed" | "incomplete";

function verdictOf(r: VerifyResult): Verdict {
  if (r.ok) return "verified";
  const fails = r.checks.filter((c) => c.state === "fail" && !(r.expired && c.label === "Expired"));
  if (fails.length > 0) return "failed";
  if (r.expired) return "expired";
  return "incomplete";
}

/**
 * "Holds at least 10,000 USDG" / "A private payment of 1,250 USDG on Oct 3" /
 * "A private payment of at least 1,000 USDG" / "5 payments adding up to
 * 21,500 USDG". Payments, never people: nothing in a proof shows who was paid.
 */
function claimOf(p: AnyProof, r: VerifyResult): { lead: string; amount: string; sym: string; tail?: string } {
  const sym = symbolOf(p.asset, p.chainId);
  if (p.kind === "funds") return { lead: "Holds at least", amount: amountOf(p.threshold, p.asset, p.chainId), sym };
  if (p.kind === "balance") return { lead: "A private balance of exactly", amount: amountOf(p.amount, p.asset, p.chainId), sym };
  if (p.kind === "payroll") {
    const lead = p.count === 1 ? "One payment of" : `${p.count.toLocaleString("en-US")} payments adding up to`;
    return { lead, amount: amountOf(p.total, p.asset, p.chainId), sym };
  }
  const tail = r.paidAt ? `on ${day(r.paidAt)}` : undefined;
  if (p.amount != null) return { lead: "A private payment of", amount: amountOf(p.amount, p.asset, p.chainId), sym, tail };
  return { lead: "A private payment of at least", amount: amountOf(p.minAmount, p.asset, p.chainId), sym, tail };
}

/** What a verified proof means, in one or two plain sentences under the claim. */
function verifiedLine(p: AnyProof, where: string): string {
  switch (p.kind) {
    case "funds":
      return `in Gloam's vault on ${where}. Their balance, wallet and history stay hidden.`;
    case "balance":
      return `In Gloam's vault on ${where}, held by whoever made this proof. Their wallet, other balances and history stay hidden.`;
    case "payroll":
      return `Funded by whoever made this proof, paid privately through Gloam's vault on ${where}. Each amount stays hidden, and so does who was paid.`;
    case "payment":
      return `Made through Gloam's vault on ${where}. Whoever made this proof holds the key to the note it paid into, and so does the payer.${
        p.amount == null ? " The exact amount stays hidden." : ""
      }`;
  }
}

export function ProofVerdict({
  proof: p,
  result: r,
  checkedAt,
}: {
  proof: AnyProof;
  result: VerifyResult;
  /** Unix seconds when the check ran, for the "expires soon" hint. */
  checkedAt: number;
}) {
  const verdict = verdictOf(r);
  const claim = claimOf(p, r);
  const net = netFor(p.chainId);
  const firstFail = r.checks.find((c) => c.state === "fail" && c.label !== "Expired");
  const firstUnknown = r.checks.find((c) => c.state === "unknown");

  const badge =
    verdict === "verified"
      ? { cls: "bg-sealed-soft text-sealed", icon: <CheckMark size={12} />, text: "Verified" }
      : verdict === "expired"
        ? { cls: "bg-warn-soft text-warn", icon: <QuestionMark size={12} />, text: "Expired" }
        : verdict === "incomplete"
          ? { cls: "bg-warn-soft text-warn", icon: <QuestionMark size={12} />, text: "Can't confirm" }
          : { cls: "bg-danger-soft text-danger", icon: <CrossMark size={12} />, text: "Not verified" };

  const explain =
    verdict === "verified"
      ? verifiedLine(p, net?.label ?? "this network")
      : verdict === "expired"
        ? firstUnknown
          ? // a check that could not run (the network, say) has not checked out
            `This proof expired on ${day(p.expiresAt)}, and not every check could run. Ask them for a fresh one.`
          : `This proof checked out, but it expired on ${day(p.expiresAt)}. Ask them for a fresh one.`
        : verdict === "incomplete"
          ? firstUnknown?.detail ?? "Some checks could not finish. Try again in a moment."
          : `Do not rely on it. ${firstFail?.detail ?? firstFail?.label ?? "One of the checks failed."}`;

  return (
    <div className="gl-card relative mt-4 overflow-hidden" role="region" aria-label="Proof result">
      <div className="relative overflow-hidden border-b border-line px-5 py-6 sm:px-7">
        {verdict === "verified" && <SealedField tone="soft" />}
        <div className="relative">
          <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-medium ${badge.cls}`}>
            {badge.icon} {badge.text}
          </span>
          {verdict === "failed" || verdict === "incomplete" ? (
            <>
              <p className="t-display-m mt-4">
                {verdict === "failed" ? "This proof did not check out" : "This proof can't be confirmed"}
              </p>
              <p className="tnum mt-2 text-[14px] text-mute">
                It claims: {claim.lead.toLowerCase()} {claim.amount} {claim.sym}
              </p>
            </>
          ) : (
            <p className="t-display-m tnum mt-4">
              {claim.lead} {claim.amount} <span className="text-mute">{claim.sym}</span>
              {claim.tail ? <span className="text-mute"> {claim.tail}</span> : null}
            </p>
          )}
          <p
            className={`mt-2 max-w-[52ch] text-[14px] leading-relaxed ${
              verdict === "failed" ? "text-danger" : verdict === "verified" ? "text-mute" : "text-warn"
            }`}
          >
            {explain}
          </p>
        </div>
      </div>

      <dl className="divide-y divide-line text-[14px]">
        <div className="flex flex-col gap-1 px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:gap-6 sm:px-7">
          <dt className="shrink-0 text-mute">For</dt>
          <dd className="min-w-0 break-words text-foreground sm:text-right">{displayLabel(p.verifier)}</dd>
        </div>
        <div className="flex flex-col gap-1 px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:gap-6 sm:px-7">
          <dt className="shrink-0 text-mute">{r.expired ? "Expired" : "Expires"}</dt>
          <dd className={`sm:text-right ${r.expired ? "text-warn" : "text-foreground"}`}>
            {dateTime(p.expiresAt)}
            {!r.expired && p.expiresAt - checkedAt < 86_400 ? " (within a day)" : ""}
          </dd>
        </div>
        <div className="flex flex-col gap-1 px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:gap-6 sm:px-7">
          <dt className="shrink-0 text-mute">Network</dt>
          <dd className="text-foreground sm:text-right">{net ? networkName(net) : `Chain ${p.chainId}`}</dd>
        </div>
        <div className="flex flex-col gap-1 px-5 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-6 sm:px-7">
          <dt className="shrink-0 text-mute">Vault</dt>
          <dd className="flex min-w-0 items-center gap-1">
            <span className="tnum min-w-0 truncate text-foreground" title={p.pool}>
              {p.pool}
            </span>
            <CopyButton value={p.pool} label="vault address" />
          </dd>
        </div>
        {p.kind === "payroll" && r.paidBetween && (
          <div className="flex flex-col gap-1 px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:gap-6 sm:px-7">
            <dt className="shrink-0 text-mute">Paid</dt>
            <dd className="text-foreground sm:text-right">
              {r.paidBetween[1] - r.paidBetween[0] < 60
                ? dateTime(r.paidBetween[0])
                : `${dateTime(r.paidBetween[0])} to ${dateTime(r.paidBetween[1])}`}
            </dd>
          </div>
        )}
        {p.kind === "payment" && p.txHash && net && (
          <div className="flex flex-col gap-1 px-5 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-6 sm:px-7">
            <dt className="shrink-0 text-mute">Transaction</dt>
            <dd className="flex min-w-0 items-center gap-1">
              <span className="tnum min-w-0 truncate text-foreground" title={p.txHash}>
                {p.txHash}
              </span>
              <a
                href={net.explorerTx(p.txHash)}
                target="_blank"
                rel="noreferrer"
                className="inline-flex h-10 shrink-0 items-center gap-1.5 rounded-full px-3 text-[12.5px] font-medium text-mute transition-colors hover:bg-surface hover:text-foreground"
              >
                Explorer <ArrowUpRight />
              </a>
            </dd>
          </div>
        )}
      </dl>

      {p.kind === "payroll" && verdict !== "failed" && <PayrollLimits count={p.count} />}
      {p.kind === "payment" && verdict !== "failed" && <PaymentLimits />}
      {p.kind === "balance" && verdict !== "failed" && (
        <Limits lines={["That it is still there. It may have moved since; a proof of funds shows that.", "Where the money came from."]} />
      )}

      <div className="border-t border-line bg-surface/50 px-5 py-5 sm:px-7">
        <p className="text-[13px] text-mute">What was checked, in your browser</p>
        <ul className="mt-3 space-y-3">
          {r.checks.map((c, i) => {
            const s = STATE[c.state];
            return (
              <li key={`${c.label}-${i}`} className="flex items-start gap-3">
                <span className={`mt-px grid h-5 w-5 shrink-0 place-items-center rounded-full ${s.tone}`}>
                  {s.icon}
                  <span className="sr-only">{s.word}:</span>
                </span>
                <span className="min-w-0">
                  <span className="block text-[14px] leading-snug text-foreground">{c.label}</span>
                  {c.detail && (
                    <span className="mt-0.5 block text-[12.5px] leading-relaxed text-mute">{c.detail}</span>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

/** What a proof does not show, said plainly every time. */
function Limits({ lines }: { lines: string[] }) {
  return (
    <div className="border-t border-line px-5 py-5 sm:px-7">
      <p className="text-[13px] text-mute">What this does not prove</p>
      <ul className="mt-3 space-y-2">
        {lines.map((l) => (
          <li key={l} className="flex items-start gap-3 text-[14px] leading-snug text-soft">
            <span aria-hidden className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-current" />
            <span className="min-w-0">{l}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A payroll total proves a sum of payments, not a staff list. */
function PayrollLimits({ count }: { count: number }) {
  return (
    <Limits
      lines={[
        "Who was paid, or that they work for the sender.",
        count === 1
          ? "That the payment did not go back to the sender."
          : `That these went to ${count.toLocaleString("en-US")} different people, or that none went back to the sender.`,
        "Anything about other runs, or the sender's balance.",
      ]}
    />
  );
}

/** A proof of payment shows a payment was made, not who made it or got it. */
function PaymentLimits() {
  return (
    <Limits
      lines={[
        "Who paid, or who was paid. The payer can make this same proof.",
        "That it was not a payment to themselves.",
        "That the money is still there. Ask for a proof of funds for that.",
      ]}
    />
  );
}
