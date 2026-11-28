"use client";

/**
 * The result of checking a proof of payment on Solana or a payment disclosure
 * on Starknet (lib/proofs/chainProofs): the verdict in plain words, who it was
 * made for, every check, and what it does not show. Laid out as ProofVerdict
 * lays out the EVM proofs.
 */
import type { ReactNode } from "react";
import { formatUnits } from "viem";
import type { ChainProof, ChainProofResult } from "@/lib/proofs/chainProofs";
import type { ChainCheckState } from "@/lib/proofs/solanaPayment";
import { displayLabel } from "@/lib/proofs/label";
import { RINGS_ASSETS, ringsExplorerTx } from "@/lib/solanaRings/config";
import { starknetConfig } from "@/lib/starknetPrivacy/config";
import { SealedField } from "@/components/ui/SealedField";
import { ArrowUpRight } from "@/components/ui/ArrowUpRight";

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

const STATE: Record<ChainCheckState, { icon: ReactNode; tone: string; word: string }> = {
  pass: { icon: <CheckMark size={11} />, tone: "bg-sealed-soft text-sealed", word: "Passed" },
  fail: { icon: <CrossMark size={11} />, tone: "bg-danger-soft text-danger", word: "Failed" },
  unknown: { icon: <QuestionMark size={11} />, tone: "bg-surface-2 text-mute", word: "Could not check" },
};

/** Every unit, grouped: a proof states an exact amount. */
function exact(v: bigint, decimals: number): string {
  const [whole, frac] = formatUnits(v, decimals).split(".");
  const grouped = whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return frac ? `${grouped}.${frac}` : grouped;
}

function solanaAsset(mint: string, network: "mainnet" | "devnet") {
  return RINGS_ASSETS[network]?.find((a) => (a.mint ?? "11111111111111111111111111111111") === mint) ?? null;
}

function starknetAmount(v: bigint, token: string, network: "mainnet" | "sepolia" | "devnet"): string {
  let tokens: { address: string; symbol: string; decimals: number }[] = [];
  try {
    tokens = starknetConfig(network).tokens;
  } catch {
    tokens = [];
  }
  const t = tokens.find((x) => BigInt(x.address) === BigInt(token));
  return t ? `${exact(v, t.decimals)} ${t.symbol}` : `${v.toString()} of ${token.slice(0, 6)}…${token.slice(-4)}`;
}

const NETWORK_NAMES: Record<string, string> = {
  "solana:mainnet": "Solana",
  "solana:devnet": "Solana devnet",
  "starknet:mainnet": "Starknet",
  "starknet:sepolia": "Starknet Sepolia",
  "starknet:devnet": "Starknet devnet",
};

const short = (a: string) => (a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);
const day = (unix: number) => new Date(unix * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
const dateTime = (unix: number) => new Date(unix * 1000).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });

type Verdict = "verified" | "expired" | "failed" | "incomplete";

function verdictOf(r: ChainProofResult): Verdict {
  if (r.ok) return "verified";
  if (r.checks.some((c) => c.state === "fail" && !(r.expired && c.label === "Expired"))) return "failed";
  if (r.expired) return "expired";
  return "incomplete";
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1 px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:gap-6 sm:px-7">
      <dt className="shrink-0 text-mute">{label}</dt>
      <dd className="min-w-0 break-words text-foreground sm:text-right">{children}</dd>
    </div>
  );
}

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

export function ChainProofVerdict({ proof: p, result: r, checkedAt }: { proof: ChainProof; result: ChainProofResult; checkedAt: number }) {
  const verdict = verdictOf(r);
  const firstFail = r.checks.find((c) => c.state === "fail" && c.label !== "Expired");
  const firstUnknown = r.checks.find((c) => c.state === "unknown");
  const net = NETWORK_NAMES[`${p.kind === "solana-payment" ? "solana" : "starknet"}:${p.network}`] ?? p.network;

  let claim: string;
  let verified: string;
  let limits: string[];
  if (p.kind === "solana-payment") {
    const a = solanaAsset(p.asset, p.network);
    claim = `A private payment of ${a ? `${exact(BigInt(p.amount), a.decimals)} ${a.symbol}` : `${p.amount} of ${short(p.asset)}`}${r.paidAt ? ` on ${day(r.paidAt)}` : ""}`;
    verified = `Paid on ${net} into the private account that signed this proof.${r.from ? " The payer's private account is public there, and shows below." : ""}`;
    limits = ["That the money is still there.", "Who is behind either private account.", "Anything about their other payments or their balance."];
  } else {
    const pays = r.payments ?? [];
    const by = new Map<string, bigint>();
    for (const x of pays) by.set(x.token, (by.get(x.token) ?? 0n) + x.amount);
    const total = [...by].map(([t, v]) => starknetAmount(v, t, p.network)).join(", ") || "nothing";
    claim = pays.length === 1 ? `One payment of ${total}` : `${pays.length} payments adding up to ${total}`;
    verified = `Every payment from one private account to another on ${net}, read from its privacy pool. It also opens any payment made between them after it was shared.`;
    limits = [
      "Payments either account made to or got from anyone else.",
      "That the money is still there.",
      "Who is behind either private account.",
    ];
  }

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
      ? verified
      : verdict === "expired"
        ? firstUnknown
          ? `This expired on ${day(p.expiresAt)}, and not every check could run. Ask them for a fresh one.`
          : `This checked out, but it expired on ${day(p.expiresAt)}. Ask them for a fresh one.`
        : verdict === "incomplete"
          ? (firstUnknown?.detail ?? "Some checks could not finish. Try again in a moment.")
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
              <p className="t-display-m mt-4">{verdict === "failed" ? "This did not check out" : "This can't be confirmed"}</p>
              {p.kind === "solana-payment" && <p className="tnum mt-2 text-[14px] text-mute">It claims: {claim.charAt(0).toLowerCase() + claim.slice(1)}</p>}
            </>
          ) : (
            <p className="t-display-m tnum mt-4">{claim}</p>
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
        <Row label="For">{displayLabel(p.verifier)}</Row>
        <Row label={r.expired ? "Expired" : "Expires"}>
          <span className={r.expired ? "text-warn" : undefined}>
            {dateTime(p.expiresAt)}
            {!r.expired && p.expiresAt - checkedAt < 86_400 ? " (within a day)" : ""}
          </span>
        </Row>
        <Row label="Network">{net}</Row>
        {p.kind === "solana-payment" ? (
          <>
            <Row label="Paid to">
              <span className="tnum">{p.account}</span>
            </Row>
            {r.from && (
              <Row label="Paid from">
                <span className="tnum">{r.from}</span>
              </Row>
            )}
            <Row label="Transaction">
              <a
                href={ringsExplorerTx(p.tx, p.network)}
                target="_blank"
                rel="noreferrer"
                className="tnum inline-flex min-h-10 items-center gap-1.5 text-foreground underline decoration-line-strong underline-offset-2 hover:decoration-foreground"
              >
                {short(p.tx)} <ArrowUpRight />
              </a>
            </Row>
          </>
        ) : (
          <>
            <Row label="From">
              <span className="tnum">{p.sender}</span>
            </Row>
            <Row label="To">
              <span className="tnum">{p.recipient}</span>
            </Row>
            <Row label="Made by">{p.by === "recipient" ? "The account paid" : "The account that paid"}</Row>
          </>
        )}
      </dl>

      {p.kind === "starknet-channel" && (r.payments?.length ?? 0) > 0 && (
        <div className="border-t border-line px-5 py-5 sm:px-7">
          <p className="text-[13px] text-mute">Every payment in the channel</p>
          <ul className="mt-3 divide-y divide-line rounded-[14px] bg-surface px-4 text-[14px]">
            {r.payments!.map((x) => (
              <li key={x.noteId} className="tnum flex min-h-11 items-center justify-between gap-3 py-2">
                <span className="text-mute">{x.at ? dateTime(x.at) : "Date not read"}</span>
                <span className="text-foreground">{starknetAmount(x.amount, x.token, p.network)}</span>
              </li>
            ))}
          </ul>
          {(r.outside ?? 0) > 0 && (
            <p className="mt-2 text-[12.5px] leading-relaxed text-mute">
              {r.outside} more came in from outside the pool, through a bridge or a swap, and are not counted.
            </p>
          )}
        </div>
      )}

      {verdict !== "failed" && <Limits lines={limits} />}

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
                  {c.detail && <span className="mt-0.5 block break-words text-[12.5px] leading-relaxed text-mute">{c.detail}</span>}
                </span>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
